// Optimizer v3: find the good in-between routes with few TomTom requests.
//
//  1. TomTom: fastest route (with instructions -> time at every point) + toll-free route.        (2 requests)
//  2. Every option is described as pieces: "motorway from point i to j of the fastest route" (time read from
//     the fastest route, toll priced exactly) or "free roads from A to B" (checked with TomTom, live traffic).
//     Options: per toll stretch, every combination of motorway / free pieces between interchanges;
//     "motorway to exit X then free roads" and "free roads to X then motorway" (national roads such as the N10);
//     detours found by TomTom itself (small spots on the motorway blocked).
//  3. Pruning: a free piece is only considered if it avoids at least MIN_SKIP € of toll.
//  4. All requests are cached on the phone (TomTom 3 h).
import { km, cumulative, routePoints } from './geo.js';
import { priceRoute, priceSection, stationsNear, nearestLocal } from './tolls.js';
import { route, localPoints } from './services.js';
import { loadChargers, planCharging, quickCharge, evParams, mergeStops } from './charging.js';
import { buildTerrain, fetchWinds, extraFn, retarget } from './terrain.js';

const TRANSITION_SEC = 60;   // leaving / joining the motorway
const MAX_NODES = 12;        // interchanges kept per toll stretch
const MIN_SKIP = 0.5;        // € — a free piece must avoid at least this toll
const MAX_DETOURS = 24;
const MAX_CHAIN = 12;        // follow-up detours: block the tolls of a detour too, step by step towards toll-free      // TomTom "avoid this spot" requests per trip (complete method)
const APPROACH_KM = +(globalThis.PM_APPROACH ?? 5);       // free bypasses may also start this far before a toll stretch / end this far after it
                             // (e.g. A13 → A12 → N12 instead of the A86 Duplex: the bypass leaves at Rocquencourt)

export const DEFAULT_VEHICLES = {
  diesel: { label: '5008 diesel', type: 'diesel', lPer100: 6.0, eurPerL: 2.21, maxSpeed: null },
  // e-208 (Thomas, D-033): 15 kWh/100 km mixed roads, 18 on the motorway at 110 in summer, 20 in winter (Nov–Mar);
  // home = average of Tempo blue/white off-peak (Aug 2026 grid: 0.1356 / 0.1536); leaves at 90 % (aged battery)
  ev: { label: 'e-208', type: 'ev', kwhMotorway: 18, kwhMotorwayWinter: 20, kwhOther: 15, batteryKwh: 46, homeEurKwh: 0.145,
    fastEurKwh: 0.54, stopOverheadMin: 10, maxSpeed: 110, startPct: 90, arrivePct: null, reservePct: 8,
    lunch: false, lunchMin: 45, noCharge: false, season: 'auto' },
};

export function energy(c, v) {
  if (v.type === 'diesel') return { energy: c.km * v.lPer100 / 100 * v.eurPerL, chargeMin: 0, kwh: 0 };
  const depart = v.depart || new Date();
  const P = evParams(v, depart, c.sec);
  const kwh = c.mkm * P.kM / 100 + (c.km - c.mkm) * P.kO / 100;
  return { ...quickCharge(kwh, c.sec, v, depart), kwh };
}

// real charging stops at real chargers (finals only: needs the route's line)
function applyCharging(f, v, depart) {
  if (v.type !== 'ev' || !f.line) return;
  const X = f.terrain ? extraFn(f.terrain, f.winds, v.maxSpeed || 110) : null;
  const plan = planCharging(f.line, f, v, depart, f.lineMw, X);
  if (!plan) return;
  if (plan.ok) { f.energy = plan.energy; f.chargeMin = plan.chargeMin; }
  else f.chargeMin += 20;                         // no reachable fast charger found near this route: penalty, warned in the app
  f.charge = plan;
  f.cost = f.toll + f.energy; f.min = f.sec / 60 + f.chargeMin;
}

// readable station name: "CHAUFOUR N°15 à GAILLON N°17" → "Chaufour", "LILLE / DOURGES (péage de Fresnes)" → "Lille / Dourges",
// "18Alençon nord" → "Alençon nord", "ST-GERMAIN-LAXIS" → "St-Germain-Laxis"
const SMALL = new Set(['sur', 'sous', 'de', 'du', 'des', 'la', 'le', 'les', 'en', 'aux', 'et', 'lès', 'les']);
export function prettyName(n) {
  let x = String(n).replace(/^\d+(\.\d+)?[a-z]?(?=[A-ZÉ])/, '').replace(/\s+à\s+.*$/, '').replace(/N°\s*[\d.]+[A-Za-z]?/g, '')
    .replace(/\(.*?\)/g, '').replace(/^p[ée]age d[e']\s*/i, '').replace(/\s+/g, ' ').trim();
  if (x === x.toUpperCase()) {
    let first = true;
    x = x.toLowerCase().replace(/[a-zà-ÿ]+/g, (w) => { const r = !first && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1); first = false; return r; });
  }
  return x.replace(/\b([an])(\d+)\b/gi, (m, a, d) => a.toUpperCase() + d) || String(n);
}
const cleanName = prettyName;

function frontier(items, tkey, ckey) {
  const out = [];
  for (const it of [...items].sort((a, b) => a[tkey] - b[tkey] || a[ckey] - b[ckey])) {
    if (!out.length || it[ckey] < out[out.length - 1][ckey] - 0.05) out.push(it);
  }
  return out;
}

function motorwayKmOf(r, rp) {
  let mk = 0;
  for (const s of r.sections || []) if (s.sectionType === 'MOTORWAY') for (let i = s.startPointIndex + 1; i <= s.endPointIndex; i++) mk += km(rp[i - 1], rp[i]);
  return mk;
}

// ---------- the fastest route as a time line ----------
function mainRoads(r, j0 = 0, j1 = Infinity) {
  // main A/N roads (≥ 3 km) of a route, or of its part between point indexes j0..j1
  const ins = r.guidance?.instructions || [], len = new Map(), first = new Map();
  for (let i = 0; i < ins.length - 1; i++) {
    if (ins[i + 1].pointIndex <= j0 || ins[i].pointIndex >= j1) continue;
    const rn = (ins[i].roadNumbers || [])[0];
    if (!rn || !/^[AN]\d/.test(rn)) continue;
    const m = (ins[i + 1].routeOffsetInMeters - ins[i].routeOffsetInMeters) / 1000;
    len.set(rn, (len.get(rn) || 0) + m);
    if (!first.has(rn)) first.set(rn, i);
  }
  return [...len].filter(([, m]) => m >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([rn]) => rn).sort((a, b) => first.get(a) - first.get(b));
}

// polyline thinned to about one point per km; with flags (true = motorway), out.mw gives the flag of each kept point
function sample(rp, flags) {
  const out = [rp[0]], mw = [flags ? !!flags[0] : false];
  let acc = 0;
  for (let i = 1; i < rp.length; i++) { acc += km(rp[i - 1], rp[i]); if (acc >= 1) { out.push(rp[i]); mw.push(flags ? !!flags[i] : false); acc = 0; } }
  if (out[out.length - 1] !== rp[rp.length - 1]) { out.push(rp[rp.length - 1]); mw.push(flags ? !!flags[rp.length - 1] : false); }
  out.mw = mw;
  return out;
}
// true for every point of a TomTom route that is on a motorway (chargers must then be on a service area)
function mwFlags(r, rp) {
  const f = new Array(rp.length).fill(false);
  for (const s of r.sections || []) if (s.sectionType === 'MOTORWAY') for (let i = s.startPointIndex; i <= s.endPointIndex && i < f.length; i++) f[i] = true;
  return f;
}

function timeline(route, pts, cum) {
  // seconds from departure at every point: anchors at instructions, linear by distance in between
  const T = new Array(pts.length).fill(0);
  const anchors = (route.guidance?.instructions || []).map((i) => [i.pointIndex, i.travelTimeInSeconds])
    .filter(([i]) => i >= 0 && i < pts.length).sort((a, b) => a[0] - b[0]);
  if (!anchors.length || anchors[0][0] !== 0) anchors.unshift([0, 0]);
  const last = pts.length - 1;
  if (anchors[anchors.length - 1][0] !== last) anchors.push([last, route.summary.travelTimeInSeconds]);
  for (let a = 0; a < anchors.length - 1; a++) {
    const [i0, t0] = anchors[a], [i1, t1] = anchors[a + 1];
    const d = cum[i1] - cum[i0];
    for (let i = i0; i <= i1; i++) T[i] = d > 0 ? t0 + (t1 - t0) * (cum[i] - cum[i0]) / d : t0;
  }
  return T;
}

function stretchNodes(pts, cum, i0, i1) {
  const found = stationsNear(pts, cum, i0, i1);
  let nodes = [{ idx: i0, name: 'début du péage' }];
  for (const f of found) {
    if (f.pos - cum[nodes[nodes.length - 1].idx] > 3 && cum[i1] - f.pos > 3) nodes.push({ idx: f.idx, name: f.name, local: f.local });
  }
  if (nodes.length - 1 > MAX_NODES) {
    const inner = nodes.slice(1), step = inner.length / MAX_NODES;
    nodes = [nodes[0], ...Array.from({ length: MAX_NODES }, (_, k) => inner[Math.floor(k * step)])];
  }
  nodes.push({ idx: i1, name: 'fin du péage' });
  nodes.startName = found.length ? cleanName(found[0].name) : 'début du péage';
  nodes.endName = found.length ? cleanName(found[found.length - 1].name) : 'fin du péage';
  return nodes;
}

async function resolveLocals(points, preset = []) {
  const out = points.map((p, i) => preset[i] || nearestLocal(p));
  const missing = out.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const found = await localPoints(missing.map((i) => points[i]));
    missing.forEach((i, j) => { out[i] = found[j]; });
  }
  return out;
}

// Main entry. onProgress(fraction, text)
export async function analyse(o, d, v, depart, onProgress = () => {}) {
  v = { ...v, depart };
  if (v.type === 'ev' && !v.noCharge) await loadChargers().catch(() => null);
  const opt = { maxSpeed: v.maxSpeed, depart: isoLocal(depart) };
  onProgress(0.03, 'Itinéraire le plus rapide…');
  const [routes, freeRoutes] = await Promise.all([
    route(o, d, { ...opt, alternatives: 5, instructions: true }),
    route(o, d, { ...opt, avoidTolls: true, alternatives: 3 })]);
  if (!routes.length) throw new Error('Aucun itinéraire trouvé');
  const fastest = routes[0];
  const pts = routePoints(fastest), cum = cumulative(pts), N = pts.length - 1, ptsMw = mwFlags(fastest, pts);
  const T = timeline(fastest, pts, cum);
  const mflag = new Uint8Array(pts.length);
  for (const s of fastest.sections || []) if (s.sectionType === 'MOTORWAY') for (let i = s.startPointIndex; i <= s.endPointIndex; i++) mflag[i] = 1;
  const mkmPrefix = [0];
  for (let i = 1; i <= N; i++) mkmPrefix.push(mkmPrefix[i - 1] + (mflag[i] && mflag[i - 1] ? km(pts[i - 1], pts[i]) : 0));
  const tolls = (fastest.sections || []).filter((s) => s.sectionType === 'TOLL_ROAD' && cum[s.endPointIndex] - cum[s.startPointIndex] > 1.5)
    .map((s) => [s.startPointIndex, s.endPointIndex]);

  // exact toll of driving the fastest route from point a to point b (one ticket per toll stretch portion)
  const priceCache = new Map();
  function tollBetween(a, b) {
    let sum = 0;
    const details = [];
    for (const [s0, s1] of tolls) {
      const x = Math.max(a, s0), y = Math.min(b, s1);
      if (y <= x || cum[y] - cum[x] < 1.5) continue;
      const k = x + '|' + y;
      if (!priceCache.has(k)) priceCache.set(k, priceSection(pts, cum, x, y, new Date(depart.getTime() + 1000 * T[x])));
      const r = priceCache.get(k);
      if (r.price === null) return { toll: null, details };
      sum += r.price; details.push(...r.details);
    }
    return { toll: sum, details };
  }
  const mw = (a, b) => ({ type: 'mw', a, b });

  // ---- interchanges and their off-motorway points ----
  onProgress(0.1, 'Échangeurs et routes nationales…');
  const allNodes = tolls.map(([s0, s1]) => stretchNodes(pts, cum, s0, s1));
  // motorway number at a point of the fastest route (from TomTom instructions)
  const roadAt = (i) => {
    let rn = '';
    for (const x of fastest.guidance?.instructions || []) {
      if (x.pointIndex > i) break;
      const r0 = (x.roadNumbers || []).find((z) => /^A\d/.test(z));
      if (r0) rn = r0;
    }
    return rn;
  };
  allNodes.forEach((nodes, k) => { nodes.road = roadAt(Math.floor((tolls[k][0] + tolls[k][1]) / 2)); });
  allNodes.forEach((nodes, k) => {      // stretches without stations (e.g. the A86 Duplex tunnel): use the price label
    if (nodes.length === 2 && nodes.startName === 'début du péage') {
      const det = tollBetween(tolls[k][0], tolls[k][1]).details[0];
      if (det) nodes.title = /duplex/i.test(det.from) ? 'le Duplex A86'
        : det.to && det.to !== '(barrière)' ? `${cleanName(det.from)} → ${cleanName(det.to)}` : `la barrière de ${cleanName(det.from)}`;
    }
  });
  // approach points on the fastest route itself (a free road), a few km before / after each stretch
  allNodes.forEach((nodes, k) => {
    const lo = k ? tolls[k - 1][1] : 0, hi = k < tolls.length - 1 ? tolls[k + 1][0] : N;
    const s0 = tolls[k][0], s1 = tolls[k][1];
    let i = s0; while (i > lo && cum[s0] - cum[i] < APPROACH_KM) i--;
    if (cum[s0] - cum[i] >= 2 && cum[i] - cum[lo] >= 1) { nodes.unshift({ idx: i, name: 'avant le péage', L: pts[i] }); nodes.hasPre = true; }
    let j = s1; while (j < hi && cum[j] - cum[s1] < APPROACH_KM) j++;
    if (cum[j] - cum[s1] >= 2 && cum[hi] - cum[j] >= 1) { nodes.push({ idx: j, name: 'après le péage', L: pts[j] }); nodes.hasPost = true; }
  });
  const flat = allNodes.flat();
  const locals = await resolveLocals(flat.map((nd) => pts[nd.idx]), flat.map((nd) => nd.L || nd.local));
  flat.forEach((nd, i) => { nd.L = locals[i]; });
  // The off-motorway point of the toll start/end can lie on the wrong side (after the Les Eprunes barrier on the A5:
  // "leave and come straight back" looked free but is not; Montigny-le-Roi: on the town side of the exit, U-turn).
  // When the stretch has an approach point on the route itself, free runs start/end there instead.
  for (const nodes of allNodes) {
    if (nodes.hasPre) nodes[1].L = null;
    if (nodes.hasPost) nodes[nodes.length - 2].L = null;
  }

  // ---- free pieces checked with TomTom ----
  const ek = (A, B) => `${A[0].toFixed(5)},${A[1].toFixed(5)}|${B[0].toFixed(5)},${B[1].toFixed(5)}`;
  const real = new Map();            // free pieces checked with TomTom: key -> {sec, km, mkm, mid} | null (invalid)
  async function confirmPiece(A, B) {
    const key = ek(A, B);
    if (real.has(key)) return;
    const r = await route(A, B, { ...opt, avoidTolls: true, instructions: true });
    if (!r.length) { real.set(key, null); return; }
    const pr = priceRoute(r[0], depart);
    if (pr.unpriced || pr.toll > 0.5) {                               // TomTom could not avoid the motorway
      if (globalThis.PM_DEBUG) console.error('free piece rejected', key, pr.toll, pr.unpriced, pr.details.map((x) => x.from));
      real.set(key, null); return;
    }
    const rp = routePoints(r[0]);
    real.set(key, { sec: r[0].summary.travelTimeInSeconds, km: r[0].summary.lengthInMeters / 1000, mkm: motorwayKmOf(r[0], rp),
      mid: rp[Math.floor(rp.length / 2)], late: rp[Math.floor(rp.length * 0.8)], geo: sample(rp, mwFlags(r[0], rp)), roads: mainRoads(r[0]) });
  }
  // escapes: free roads from X to destination / from origin to X (only when at least 1 € of toll is at stake)
  const escapes = [];
  for (let k = 0; k < tolls.length; k++) {
    const ns = allNodes[k];
    for (const nd of ns.slice((ns.hasPre ? 1 : 0) + 1, ns.length - (ns.hasPost ? 1 : 0) - 1)) {
      if (!nd.L) continue;
      const after = tollBetween(nd.idx, N).toll, before = tollBetween(0, nd.idx).toll;
      if (after !== null && after >= 1) escapes.push({ kind: 'sortie', nd, A: nd.L, B: d });
      if (before !== null && before >= 1) escapes.push({ kind: 'entrée', nd, A: o, B: nd.L });
    }
  }
  // ---- options per toll stretch ----
  const perStretch = allNodes.map((nodes) => {
    const n = nodes.length;
    const opts = [];
    for (let mask = 1; mask < (1 << (n - 1)); mask++) {
      const pieces = [], free = [];
      let j = 0, ok = true;
      while (j < n - 1) {
        const isFree = (mask >> j) & 1;
        let e = j;
        while (e < n - 1 && ((mask >> e) & 1) === isFree) e++;
        if (isFree) {
          if (!nodes[j].L || !nodes[e].L) { ok = false; break; }
          const skipped = tollBetween(nodes[j].idx, nodes[e].idx).toll;
          if (skipped === null || skipped < MIN_SKIP) { ok = false; break; }     // not worth leaving the motorway
          {                                 // chain of checked pieces between consecutive interchanges
            // a run starting at the approach point goes straight to the 2nd interchange (and symmetrically at the end)
            const ids = [];
            for (let x = j; x <= e; x++) {
              if (x === 1 && nodes.hasPre && j === 0 && e > 1) continue;
              if (x === n - 2 && nodes.hasPost && e === n - 1 && j < n - 2) continue;
              ids.push(x);
            }
            for (let q = 0; q < ids.length - 1; q++) {
              if (!nodes[ids[q]].L || !nodes[ids[q + 1]].L) { ok = false; break; }
              pieces.push({ type: 'free', A: nodes[ids[q]].L, B: nodes[ids[q + 1]].L });
            }
            if (!ok) break;
          }
          free.push([j, e]);
        } else pieces.push(mw(nodes[j].idx, nodes[e].idx));
        j = e;
      }
      if (!ok) continue;
      const f0 = nodes.hasPre ? 1 : 0, f1 = nodes.hasPost ? n - 2 : n - 1;      // first / last toll node
      const nm = (i) => (i <= f0 ? nodes.startName : i >= f1 ? nodes.endName : cleanName(nodes[i].name));
      const rd = nodes.road ? nodes.road + ' ' : '';
      const label = free.length === 1 && free[0][0] <= f0 && free[0][1] >= f1
        ? (nodes.title ? `évite ${nodes.title}` : `évite ${rd}${nodes.startName} → ${nodes.endName}`)
        : `${rd ? nodes.road + ' : ' : ''}routes gratuites ${free.map(([a, b]) => `${nm(a)} → ${nm(b)}`).join(', puis ')}`;
      opts.push({ pieces, label });
    }
    return { s0: nodes[0].idx, s1: nodes[n - 1].idx, opts };
  });

  // ---- detours found by TomTom itself: block a small spot on the motorway, TomTom picks where to leave and rejoin ----
  // One spot in the middle of every priced piece between interchanges (complete method) and, per toll stretch, spots on
  // all its pieces (TomTom finds the best way around the whole stretch, possibly another motorway).
  const detours = [], wholeDetours = [];
  async function runDetours() {
    // TomTom ignores a single small spot at some places (tested on the A10 south of Poitiers), but respects a chain
    // of small spots or a box covering ~1-2 km of the road. If still ignored: 2nd try elsewhere on the piece.
    const kmIdx = (x) => { let i = 0; while (i < N && cum[i] < x) i++; return i; };
    const tiny = (i) => { const [la, lo] = pts[i]; return [la - 0.0004, lo - 0.0006, la + 0.0004, lo + 0.0006]; };
    const chain = (i) => [-0.3, 0, 0.3].map((dx) => tiny(kmIdx(cum[i] + dx)));
    const cover = (i, half) => {
      const ps = []; for (let x = cum[i] - half; x <= cum[i] + half; x += 0.1) ps.push(pts[kmIdx(x)]);
      const la = ps.map((p) => p[0]), lo = ps.map((p) => p[1]);
      return [Math.min(...la) - 0.0002, Math.min(...lo) - 0.0003, Math.max(...la) + 0.0002, Math.max(...lo) + 0.0003];
    };
    const idxAt = (a, b, f) => { let i = a; while (i < b && cum[i] - cum[a] < (cum[b] - cum[a]) * f) i++; return i; };
    const reqs = [];
    allNodes.forEach((nodes) => {
      const f0 = nodes.hasPre ? 1 : 0, f1 = nodes.hasPost ? nodes.length - 2 : nodes.length - 1;
      const spots = [];
      for (let x = f0; x < f1; x++) {
        const a = nodes[x].idx, b = nodes[x + 1].idx, t = tollBetween(a, b).toll;
        if (t === null || t < MIN_SKIP || cum[b] - cum[a] < 1) continue;
        spots.push({ i: idxAt(a, b, 0.5), j: idxAt(a, b, 0.25), t,
          name: `${x === f0 ? nodes.startName : cleanName(nodes[x].name)} → ${x + 1 === f1 ? nodes.endName : cleanName(nodes[x + 1].name)}` });
      }
      if (!spots.length) return;
      const whole = nodes.title || `${nodes.road ? nodes.road + ' ' : ''}${nodes.startName} → ${nodes.endName}`;
      const pick = spots.length > 10 ? Array.from({ length: 10 }, (_, k) => spots[Math.floor(k * spots.length / 10)]) : spots;
      reqs.push({ boxes: pick.map((sp) => cover(sp.i, 0.5)), retry: pick.map((sp) => cover(sp.j, 1)), t: spots.reduce((a, sp) => a + sp.t, 0), name: `évite ${whole}` });
      if (spots.length > 1) for (const sp of spots) reqs.push({ boxes: chain(sp.i), retry: [cover(sp.j, 1)], t: sp.t, name: `évite ${nodes.road ? nodes.road + ' ' : ''}${sp.name}` });
    });
    reqs.sort((a, b) => b.t - a.t);
    const todo = reqs.slice(0, MAX_DETOURS);
    const level1 = [];

    // where does a route leave / rejoin the fastest one? (distance to the fastest route's segments, < 30 m)
    const cosL = Math.cos(pts[0][0] * Math.PI / 180);
    const segD = (p, A, B) => {
      const ax = (A[1] - p[1]) * cosL, ay = A[0] - p[0], bx = (B[1] - p[1]) * cosL, by = B[0] - p[0];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      return Math.hypot(ax + t * dx, ay + t * dy) * 111.2;
    };
    const split = (rp) => {
      let a = 0, ja = 0;
      for (let j = 1; j < rp.length; j++) {
        let f = -1;
        for (let i = a; i < Math.min(N, a + 600); i++) if (segD(rp[j], pts[i], pts[i + 1]) < 0.03) { f = i; break; }
        if (f < 0) break;
        a = f; ja = j;
      }
      let b = N, jb = rp.length - 1;
      for (let j = rp.length - 2; j > ja; j--) {
        let f = -1;
        for (let i = b; i > Math.max(0, b - 600); i--) if (segD(rp[j], pts[i - 1], pts[i]) < 0.03) { f = i; break; }
        if (f < 0) break;
        b = f; jb = j;
      }
      return { a, b, ja, jb };
    };
    const ignored = (r) => Math.abs(r.summary.travelTimeInSeconds - fastest.summary.travelTimeInSeconds) < 3 &&
      Math.abs(r.summary.lengthInMeters - fastest.summary.lengthInMeters) < 50;

    await Promise.all(todo.map(async (q) => {
      let r = (await route(o, d, { ...opt, instructions: true, avoidBoxes: q.boxes }))[0];
      const firstTry = r;
      if (r && ignored(r)) r = (await route(o, d, { ...opt, instructions: true, avoidBoxes: q.retry }))[0];
      if (!r || ignored(r)) { if (globalThis.PM_DEBUG) console.error('detour ignored', q.name); return; }
      level1.push({ r, boxes: r === firstTry ? q.boxes : q.retry, name: q.name });
      const rp = routePoints(r), rc = cumulative(rp);
      const { a, b, ja, jb } = split(rp);
      if (b <= a || jb <= ja) { if (globalThis.PM_DEBUG) console.error('detour same', q.name, a, b, ja, jb); return; }
      const pr = priceRoute(r, depart);
      const tb = tollBetween(0, a).toll, ta = tollBetween(b, N).toll;
      if (pr.unpriced) { if (globalThis.PM_DEBUG) console.error('detour unpriced', q.name); return; }
      if (tb === null || ta === null) { wholeDetours.push({ r, label: q.name.charAt(0).toUpperCase() + q.name.slice(1) }); return; }   // kept as a whole route
      const Td = timeline(r, rp, rc);
      let mk = 0;
      for (const sct of r.sections || []) if (sct.sectionType === 'MOTORWAY')
        for (let i = Math.max(sct.startPointIndex + 1, ja + 1); i <= Math.min(sct.endPointIndex, jb); i++) mk += km(rp[i - 1], rp[i]);
      const at = (f) => rp[Math.floor(ja + (jb - ja) * f)];
      const roads = mainRoads(r, ja, jb);
      detours.push({ a, b, label: q.name, piece: { type: 'seg', a, b, sec: Td[jb] - Td[ja], km: rc[jb] - rc[ja], mkm: mk,
        toll: Math.max(0, pr.toll - tb - ta), details: pr.details, roads, via: [at(0.05), at(0.5), at(0.8)], geo: sample(rp.slice(ja, jb + 1), mwFlags(r, rp).slice(ja, jb + 1)) } });
      if (globalThis.PM_DEBUG) console.error('detour', q.name, 'km', cum[a].toFixed(1), '→', cum[b].toFixed(1), 'sec', Math.round(Td[jb] - Td[ja]),
        'vs', Math.round(T[b] - T[a]), 'toll', (pr.toll - tb - ta).toFixed(2), 'vs', tollBetween(a, b).toll, roads);
    }));

    // ---- chains: TomTom's detour is the FASTEST way around a toll, not always the cheapest (Lille: avoiding the A14
    // gives Rouen + A29; the Francilienne + A1 is slower but much cheaper). Block the tolls of the detour as well and ask
    // again, step by step towards toll-free: each step is a cheaper, slower whole route between fastest and toll-free.
    const sig = (r) => `${Math.round(r.summary.travelTimeInSeconds / 30)}|${Math.round(r.summary.lengthInMeters / 500)}`;
    const seen = new Set([sig(fastest), ...level1.map((x) => sig(x.r))]);
    const tollBoxes = (r) => {
      const rp = routePoints(r), rc = cumulative(rp), out = [];
      for (const sct of r.sections || []) {
        if (sct.sectionType !== 'TOLL_ROAD' || rc[sct.endPointIndex] - rc[sct.startPointIndex] < 2) continue;
        const mid = (rc[sct.startPointIndex] + rc[sct.endPointIndex]) / 2, ps = [];
        for (let i = sct.startPointIndex; i <= sct.endPointIndex; i++) if (Math.abs(rc[i] - mid) <= 0.5) ps.push(rp[i]);
        if (!ps.length) ps.push(rp[Math.floor((sct.startPointIndex + sct.endPointIndex) / 2)]);
        const la = ps.map((p) => p[0]), lo = ps.map((p) => p[1]);
        out.push([Math.min(...la) - 0.0002, Math.min(...lo) - 0.0003, Math.max(...la) + 0.0002, Math.max(...lo) + 0.0003]);
      }
      return out;
    };
    let budget = MAX_CHAIN;
    const uniq = new Map();
    for (const x of level1) if (!uniq.has(sig(x.r))) uniq.set(sig(x.r), { ...x, toll: priceRoute(x.r, depart).toll });
    let gen = [...uniq.values()].filter((x) => x.toll > 0.5).sort((a, b) => b.toll - a.toll);
    while (gen.length && budget > 0) {
      // children: the parent's blocked spots + ONE more toll section of the parent route (each section is a branch)
      const kids = [];
      for (const g of gen) for (const bx of tollBoxes(g.r)) if (g.boxes.length < 10) kids.push({ g, boxes: g.boxes.concat([bx]) });
      const next = kids.slice(0, budget);
      budget -= next.length;
      const res = await Promise.all(next.map(async ({ g, boxes }) => {
        const r = (await route(o, d, { ...opt, instructions: true, avoidBoxes: boxes }))[0];
        if (!r || seen.has(sig(r))) return null;
        seen.add(sig(r));
        const pr = priceRoute(r, depart);
        if (pr.unpriced || pr.toll >= g.toll - 0.3) return null;           // must be cheaper than its parent
        const rd = mainRoads(r);
        wholeDetours.push({ r, label: `Autre itinéraire moins cher${rd.length ? ` (par ${rd.join(', ')})` : ''}`, named: true });
        if (globalThis.PM_DEBUG) console.error('chain', g.name, '→', Math.round(r.summary.travelTimeInSeconds / 60), 'min', pr.toll.toFixed(2), '€', rd);
        return { r, boxes, toll: pr.toll, name: g.name + ' +' };
      }));
      gen = res.filter((x) => x && x.toll > 0.5).sort((a, b) => b.toll - a.toll);
    }
  }


  const detourJob = runDetours();
  {
    // every free piece used by an option and every escape checked with TomTom
    const jobs = new Map();
    for (const ps of perStretch) for (const op of ps.opts) for (const p of op.pieces) if (p.type === 'free') jobs.set(ek(p.A, p.B), [p.A, p.B]);
    for (const e of escapes) jobs.set(ek(e.A, e.B), [e.A, e.B]);
    let n = 0;
    await Promise.all([...jobs.values()].map(([A, B]) => confirmPiece(A, B).then(() =>
      onProgress(0.12 + 0.8 * (++n / jobs.size), 'Routes gratuites et sorties (TomTom)…'))));
  }

  await detourJob;

  // ---- evaluation of a list of pieces ----
  function evalPieces(pieces) {
    let sec = 0, kmv = 0, mkm = 0, toll = 0, transitions = 0, prev = null;
    const details = [];
    for (const p of pieces) {
      if (p.type === 'mw' && p.b <= p.a) continue;
      if (prev && prev !== p.type) transitions++;
      prev = p.type;
      if (p.type === 'seg') {
        sec += p.sec; kmv += p.km; mkm += p.mkm; toll += p.toll;
      } else if (p.type === 'mw') {
        sec += T[p.b] - T[p.a]; kmv += cum[p.b] - cum[p.a]; mkm += mkmPrefix[p.b] - mkmPrefix[p.a];
        const t = tollBetween(p.a, p.b);
        if (t.toll === null) return null;
        toll += t.toll; details.push(...t.details);
      } else {
        const r = real.get(ek(p.A, p.B));
        if (!r) return null;
        sec += r.sec; kmv += r.km; mkm += r.mkm;
      }
    }
    sec += transitions * TRANSITION_SEC;
    const c = { sec, km: kmv, mkm, toll, details };
    Object.assign(c, energy(c, v));
    c.cost = c.toll + c.energy; c.min = c.sec / 60 + c.chargeMin;
    return c;
  }

  function buildAll() {
    const ref = evalPieces([mw(0, N)]);
    const lists = perStretch.map((ps) => {
      const base = evalPieces([mw(ps.s0, ps.s1)]);
      const ds = [{ label: null, pieces: [mw(ps.s0, ps.s1)], dmin: 0, dcost: 0 }];
      for (const op of ps.opts) {
        const c = evalPieces(op.pieces);
        if (c && base) ds.push({ label: op.label, pieces: op.pieces, dmin: c.min - base.min, dcost: c.cost - base.cost });
      }
      return frontier(ds, 'dmin', 'dcost').slice(0, 25);
    });
    let combos = [[]];
    for (const l of lists) {
      const next = [];
      for (const c of combos) for (const x of l) next.push([...c, x]);
      combos = next.slice(0, 5000);
    }
    const out = [];
    for (const combo of combos) {
      if (combo.every((x) => !x.label)) continue;
      const pieces = [];
      let cur = 0;
      combo.forEach((x, k) => { pieces.push(mw(cur, perStretch[k].s0), ...x.pieces); cur = perStretch[k].s1; });
      pieces.push(mw(cur, N));
      const lab = combo.filter((x) => x.label).map((x) => x.label).join(' + ');
      out.push({ label: lab.charAt(0).toUpperCase() + lab.slice(1), pieces, kind: 'corridor' });
    }
    for (const dt of detours) {
      let cs = [[]];
      perStretch.forEach((ps, k) => {
        if (ps.s1 > dt.a && ps.s0 < dt.b) return;           // stretch replaced by the detour
        const next = [];
        for (const c of cs) for (const x of lists[k]) next.push([...c, { k, x }]);
        cs = next.slice(0, 2000);
      });
      for (const c of cs) {
        const items = [...c.map(({ k, x }) => ({ s0: perStretch[k].s0, s1: perStretch[k].s1, pieces: x.pieces, label: x.label })),
          { s0: dt.a, s1: dt.b, pieces: [dt.piece], label: dt.label }].sort((u, w) => u.s0 - w.s0);
        const pieces = [];
        let cur = 0;
        for (const it of items) { pieces.push(mw(cur, it.s0), ...it.pieces); cur = it.s1; }
        pieces.push(mw(cur, N));
        const lab = items.filter((x) => x.label).map((x) => x.label).join(' + ');
        out.push({ label: lab.charAt(0).toUpperCase() + lab.slice(1), pieces, kind: 'detour' });
      }
    }
    // "motorway to X, then free roads" / "free roads to X, then motorway": combined with the options of the toll
    // stretches they do not touch (Thomas: avoid the Duplex AND leave the A5 at exit 24 → both savings together)
    for (const e of escapes) {
      const nm = cleanName(e.nd.name), X = e.nd.idx, isOut = e.kind === 'sortie';
      const escLabel = isOut ? `autoroute jusqu'à ${nm}, puis routes gratuites` : `routes gratuites jusqu'à ${nm}, puis autoroute`;
      const free = { type: 'free', A: e.A, B: e.B };
      let cs = [[]];
      perStretch.forEach((ps, k) => {
        if (isOut ? ps.s1 > X : ps.s0 < X) return;           // only stretches entirely before (resp. after) X
        const next = [];
        for (const c of cs) for (const x of lists[k]) next.push([...c, { k, x }]);
        cs = next.slice(0, 2000);
      });
      for (const c of cs) {
        const pieces = [];
        let cur = isOut ? 0 : X;
        if (!isOut) pieces.push(free);
        for (const { k, x } of c) { pieces.push(mw(cur, perStretch[k].s0), ...x.pieces); cur = perStretch[k].s1; }
        if (isOut) pieces.push(mw(cur, X), free); else pieces.push(mw(cur, N));
        const labs = c.filter(({ x }) => x.label).map(({ x }) => x.label);
        const lab = (isOut ? [...labs, escLabel] : [escLabel, ...labs]).join(' + ');
        // Google Maps cannot be held on a long free stretch with 9 stops: these options open as two links split at X,
        // the free half with "Éviter les péages" (D-035)
        out.push({ label: lab.charAt(0).toUpperCase() + lab.slice(1), pieces, kind: 'escape', split: { at: e.nd.L, name: nm, freeFirst: !isOut } });
      }
    }
    const list = [];
    for (const c of out) { const e = evalPieces(c.pieces); if (e) list.push({ ...c, ...e }); }
    return { ref, list };
  }

  if (globalThis.PM_DEBUG) console.error('DEBUG nodes', allNodes.map((ns) => (ns.title || ns.startName) + ':' + ns.map((n) => (n.L ? 'L' : '-')).join('')),
    'opts', perStretch.map((p) => p.opts.length), 'duplexPiece', allNodes.map((ns) => ns.length === 2 && ns[0].L && ns[1].L ? JSON.stringify(real.get(ek(ns[0].L, ns[1].L))?.sec) : '-'));
  const { ref, list } = buildAll();
  if (!ref) throw new Error('Prix des péages introuvable pour cet itinéraire');

  // ---- final list: only confirmed options (+ TomTom fastest / alternatives / toll-free) ----
  // Google Maps waypoints: inside each free part, at places at least 1 km away from the fastest route's motorway
  // (never at an exit: Google would turn there, or take the motorway between two points close to it)
  const mwGrid = new Map(), cell = (p) => `${Math.floor(p[0] / 0.02)},${Math.floor(p[1] / 0.02)}`;
  pts.forEach((p, i) => { if (mflag[i] && i % 3 === 0) { const c = cell(p); if (!mwGrid.has(c)) mwGrid.set(c, []); mwGrid.get(c).push(p); } });
  const offMw = (p) => {
    const [a, b] = cell(p).split(',').map(Number);
    let best = 9;
    for (let x = a - 1; x <= a + 1; x++) for (let y = b - 1; y <= b + 1; y++) for (const q of mwGrid.get(`${x},${y}`) || []) best = Math.min(best, km(p, q));
    return best;
  };
  const pickVia = (geo) => {
    if (!geo || geo.length < 3) return [];
    const out = [];
    for (const [f0, f1] of [[0.1, 0.4], [0.4, 0.7], [0.7, 0.92]]) {
      let best = null, bo = 1.0;
      for (let i = Math.floor(geo.length * f0); i < Math.floor(geo.length * f1); i++) { const o2 = offMw(geo[i]); if (o2 > bo) { bo = o2; best = geo[i]; } }
      if (best) out.push(best);
    }
    return out.length ? out : [geo[Math.floor(geo.length / 2)]];
  };
  const viaOf = (pieces) => pieces.filter((p) => p.type !== 'mw').flatMap((p) => {
    if (p.type === 'seg') return pickVia(p.geo);
    const g = real.get(ek(p.A, p.B))?.geo;
    if (g) return pickVia(g);
    const r = real.get(ek(p.A, p.B));
    // start, middle and 80 % of the free part: Google must not rejoin the toll road (e.g. stay on the N12)
    return [p.A === o ? null : p.A, r?.mid, p.B === d ? null : r?.late].filter(Boolean);
  });
  // Google waypoints that keep Google off the tolls this option avoids (Thomas: the toll-free option opened in Google
  // Maps with the A13 and the A5). The option's whole line is rebuilt; along every toll section of the fastest route
  // that the option does NOT drive, stops are put on the option's own roads next to it — first where the avoided part
  // begins and ends (Google would leave late / rejoin early there), then in between. At most 9 stops, in route order.
  const tollSamples = [];
  tolls.forEach(([s0, s1], k) => { for (let i = s0, last = -1e9; i <= s1; i++) if (cum[i] - last >= 4 || i === s1) { tollSamples.push({ i, k }); last = cum[i]; } });
  const guards = (geo, driven) => {
    // geo: [{p, own}] line of the option (own = not on the fastest route's motorway pieces); driven: [[a, b]] index ranges
    const avoided = tollSamples.filter((t) => !driven.some(([a, b]) => t.i >= a && t.i <= b));
    const runs = [];
    for (const t of avoided) {
      let bj = -1, bd = Infinity;
      geo.forEach((g, j) => { if (g.own) { const dd = km(g.p, pts[t.i]); if (dd < bd) { bd = dd; bj = j; } } });
      if (bj < 0 || bd < 0.8) continue;
      const last = runs[runs.length - 1];
      if (last && last.k === t.k && last.items[last.items.length - 1].i < t.i && t.i - last.items[last.items.length - 1].i < 400) last.items.push({ i: t.i, j: bj });
      else runs.push({ k: t.k, items: [{ i: t.i, j: bj }] });
    }
    // few stops (Thomas: many stops for a short route): each avoided part gets its two ends, then one per ~40 km
    // (samples are 4 km apart). More are added only where the check before opening Google Maps finds a leak (refineVia).
    const order = [];
    for (const r of runs) {
      const q = Math.min(r.items.length, r.items.length > 1 ? 2 + Math.floor(r.items.length / 10) : 1);
      for (let k = 0; k < q; k++) order.push(r.items[q === 1 ? 0 : Math.round(k * (r.items.length - 1) / (q - 1))]);
    }
    let js = [...new Set(order.map((x) => x.j))];
    if (js.length > 9) js = Array.from({ length: 9 }, (_, k) => js[Math.round(k * (js.length - 1) / 8)]);
    return js;
  };
  const lineOf = (pieces) => {
    const geo = [], driven = [];
    for (const p of pieces) {
      if (p.type === 'mw') { if (p.b > p.a) { driven.push([p.a, p.b]); for (let i = p.a; i <= p.b; i += 15) geo.push({ p: pts[i], own: false, mw: ptsMw[i] }); } }
      else { const g = p.type === 'seg' ? p.geo : real.get(ek(p.A, p.B))?.geo; (g || []).forEach((q, k) => geo.push({ p: q, own: true, mw: !!g.mw?.[k] })); }
    }
    return { geo, driven };
  };
  const viaFor = (pieces, extraPts = []) => {
    const { geo, driven } = lineOf(pieces);
    const js = guards(geo, driven);
    for (const q of extraPts) {                       // nothing to guard (rare): the "away from motorway" points
      if (js.length >= 3) break;
      let bj = 0, bd = Infinity; geo.forEach((g, j) => { const dd = km(g.p, q); if (dd < bd) { bd = dd; bj = j; } });
      if (!js.includes(bj)) js.push(bj);
    }
    return js.sort((a, b) => a - b).map((j) => geo[j].p);
  };
  const guardVia = (r) => viaFor([{ type: 'seg', geo: sample(routePoints(r)) }]);
  const refC = { ...ref, label: 'Le plus rapide (autoroute)', kind: 'ref', via: [], isRef: true, line: sample(pts, ptsMw) };
  refC.lineMw = refC.line.mw;
  const finals = [refC];
  const roadsOf = (pieces) => [...new Set(pieces.filter((p) => p.type !== 'mw').flatMap((p) => (p.type === 'seg' ? p.roads : real.get(ek(p.A, p.B))?.roads || [])))];
  for (const c of list) {
    const rd = roadsOf(c.pieces);
    finals.push({ ...c, label: rd.length ? `${c.label} (par ${rd.join(', ')})` : c.label, via: viaFor(c.pieces, viaOf(c.pieces)),
      ...(() => { const g = lineOf(c.pieces).geo; return { line: g.map((x) => x.p), lineMw: g.map((x) => x.mw) }; })() });
  }
  const extra = (r, label, kind) => {
    const c = evaluateRoute(r, v, depart);
    if (!c) return;
    const rp = routePoints(r), ln = sample(rp, mwFlags(r, rp));
    finals.push({ ...c, label, kind, via: guardVia(r), line: ln, lineMw: ln.mw });
  };
  routes.slice(1).forEach((r, i) => { const rd = mainRoads(r); extra(r, `Autre itinéraire${rd.length ? ` (par ${rd.join(', ')})` : ` ${i + 1}`}`, 'tomtom'); });
  freeRoutes.forEach((r, i) => {
    const t = priceRoute(r, depart).toll;     // TomTom's "avoid tolls" is only a preference
    extra(r, (t > 0.05 ? 'Le moins de péages possible' : 'Sans aucun péage') + (i ? ` (variante ${i})` : ''), 'free');
  });
  for (const w of wholeDetours) {
    if (w.named) { extra(w.r, w.label, 'detour'); continue; }
    const rd = mainRoads(w.r);
    extra(w.r, rd.length ? `${w.label} (par ${rd.join(', ')})` : w.label, 'detour');
  }

  // e-208: elevation and wind (free Open-Meteo, skipped when offline), D-041. Measured on the fastest route only, and
  // scaled to the others (same places: similar climbs and wind); the followed route gets its own when "Suivre" is pressed
  if (v.type === 'ev' && !v.noCharge) {
    const ref = finals.find((f) => f.isRef && f.line) || finals.find((f) => f.line);
    if (ref) {
      onProgress(0.97, 'Relief et vent…');
      const T = await buildTerrain(ref.line, ref.km, ref.lineMw);
      const W = T ? await fetchWinds(T.wp, depart, ref.km / Math.max(0.1, ref.sec / 3600)) : [];
      for (const f of finals) {
        if (!T || !f.line) continue;
        f.terrain = f === ref ? T : retarget(T, f.line, f.km, f.lineMw);
        f.winds = W.map(([pos, a, b]) => [Math.round(pos * f.km / ref.km), a, b]);
        f.terrainOwn = f === ref;
      }
    }
  }
  for (const f of finals) applyCharging(f, v, depart);
  // near-identical routes (same time and cost): keep the first one found (corridor options before detours)
  for (let i = finals.length - 1; i > 0; i--) if (finals.slice(0, i).some((f) => Math.abs(f.min - finals[i].min) < 0.6 && Math.abs(f.cost - finals[i].cost) < 0.25)) finals.splice(i, 1);
  // e-208: once charging is counted, another option can beat the all-motorway route (chargers badly placed on the
  // motorway): the truly fastest becomes the reference for times and savings; the motorway route then stays only if it
  // is cheaper than that one (2026-11-11, Demangevelle: motorway 6 h 42 with 3 stops, A105 option 6 h 35 with 2)
  let base = refC;
  if (v.type === 'ev') {
    const fast = finals.reduce((a, b) => (b.min < a.min - 0.5 || (Math.abs(b.min - a.min) <= 0.5 && b.cost < a.cost) ? b : a));
    if (fast !== refC && fast.min < refC.min - 1) base = fast;
  }
  for (const f of finals) f.isBase = f === base;
  let eff = frontier(finals.filter((c) => c === base || c.cost < base.cost - 0.05), 'min', 'cost');
  if (!eff.includes(base)) eff = [base, ...eff].sort((a, b) => a.min - b.min);
  // Thomas's rule: options within 2 minutes of each other → keep only the cheapest (the fastest route is always kept)
  eff = eff.filter((e) => e === base || !eff.some((f) => f !== e && f.min >= e.min - 1e-6 && f.min - e.min <= 2 && f.cost < e.cost - 0.01));
  eff = eff.filter((e) => e === base || !eff.some((f) => f !== e && f !== base && f.min < e.min && e.min - f.min <= 2 && f.cost < e.cost - 0.01));
  // Thomas: hide options that save almost nothing more than the previous one shown: walking from the fastest to the
  // slowest, an option must save at least 1 € more AND at least 1 € per 10 extra minutes than the last one kept.
  {
    const kept = [];
    for (const e of [...eff].sort((a, b) => a.min - b.min)) {
      const prev = kept[kept.length - 1];
      if (!prev || e === base) { kept.push(e); continue; }
      const dS = prev.cost - e.cost, dT = e.min - prev.min;
      if (dS >= Math.max(1, dT / 10)) kept.push(e);
    }
    eff = kept;
  }
  rate(eff, base);
  onProgress(1, 'Terminé');
  const motorway = base !== refC ? { min: refC.min, cost: refC.cost, stops: refC.charge?.ok ? refC.charge.stops.length : null, shown: eff.includes(refC) } : null;
  return { eff, count: list.length + 1, confirmed: [...real.values()].filter(Boolean).length, fastest, motorway };
}

// best compromise, free wins
function rate(eff, f0) {
  const cheapest = eff.reduce((a, b) => (b.cost < a.cost ? b : a));
  const S = f0.cost - cheapest.cost, Tm = Math.max(...eff.map((e) => e.min)) - f0.min;
  let best = null, bs = -9;
  for (const e of eff) {
    e.dMin = e.min - f0.min; e.save = f0.cost - e.cost;
    e.saveToll = f0.toll - e.toll; e.saveEnergy = f0.energy - e.energy;      // split of the saving
    e.pSave = S > 0 ? e.save / S : 0; e.pTime = Tm > 0 ? e.dMin / Tm : 0;
    e.score = e.pSave - e.pTime;
    e.freeWin = e !== f0 && e.dMin <= 3 && e.save >= 1;
    if (e.score > bs && e.pSave > 0 && e.pSave < 1) { bs = e.score; best = e; }
  }
  if (best) best.best = true;
}

export function ladder(eff, budgets = [5, 10, 15, 20, 30, 45, 60, 90]) {
  return budgets.map((b) => {
    const ok = eff.filter((e) => e.dMin <= b);
    return { budget: b, route: ok.reduce((a, x) => (x.cost < a.cost ? x : a)) };
  });
}

// cost of one complete TomTom route (null if a toll cannot be priced)
export function evaluateRoute(r, v, depart) {
  const p = priceRoute(r, depart);
  if (p.unpriced) return null;
  const rp = routePoints(r);
  const c = { sec: r.summary.travelTimeInSeconds, km: r.summary.lengthInMeters / 1000, mkm: motorwayKmOf(r, rp), toll: p.toll, details: p.details };
  Object.assign(c, energy(c, v));
  c.cost = c.toll + c.energy; c.min = c.sec / 60 + c.chargeMin;
  return c;
}

// Live check of a saved trip (2 TomTom requests, traffic now): the saved route through its waypoints, and the fastest
// route now. Returns the verdict and the reasons, in French, for the app.
export async function checkTrip(fav, v) {
  const now = new Date();
  const opt = { maxSpeed: v.maxSpeed, depart: isoLocal(now), fresh: true };
  const via = (fav.via || []).slice(0, 9);
  const [mine, fast] = await Promise.all([
    route(fav.o, fav.d, { ...opt, via, trafficInfo: true }), route(fav.o, fav.d, opt)]);
  if (!mine.length) return { level: 'bad', title: 'Itinéraire impossible', lines: ['TomTom ne trouve plus de route par ce chemin (route fermée ?).'] };
  const r = mine[0], cur = evaluateRoute(r, v, now), f = fast.length ? evaluateRoute(fast[0], v, now) : null;
  const lines = [];
  let level = 'ok';
  const worse = (l) => { if (l === 'bad' || level === 'ok') level = l; };
  const s = fav.saved;
  const hmm = (m) => `${Math.floor(Math.round(m) / 60)} h ${String(Math.round(m) % 60).padStart(2, '0')}`;
  if (cur) lines.push(`Maintenant : ${hmm(cur.min)} (enregistré : ${hmm(s.min)}), péages ${cur.toll.toFixed(2).replace('.', ',')} €.`);
  // incidents on the saved route
  const cats = { ROAD_CLOSURE: 'Route fermée', ROAD_WORKS: 'Travaux', ACCIDENT: 'Accident', JAM: 'Bouchon', DANGEROUS_CONDITIONS: 'Danger',
    LANE_CLOSURE: 'Voie fermée', WEATHER: 'Météo', BROKEN_DOWN_VEHICLE: 'Véhicule en panne', OTHER: 'Incident' };
  const rp = routePoints(r), cum = cumulative(rp);
  for (const sct of (r.sections || []).filter((x) => x.sectionType === 'TRAFFIC')) {
    const delay = Math.round((sct.delayInSeconds || 0) / 60), kind = cats[sct.simpleCategory] || 'Incident';
    if (sct.simpleCategory === 'ROAD_CLOSURE') { lines.push(`⛔ ${kind} à ${Math.round(cum[sct.startPointIndex])} km du départ.`); worse('bad'); }
    else if (delay >= 5) { lines.push(`🚗 ${kind} à ${Math.round(cum[sct.startPointIndex])} km du départ : +${delay} min.`); worse('warn'); }
  }
  const delayAll = Math.round((r.summary.trafficDelayInSeconds || 0) / 60);
  if (delayAll >= 10) { lines.push(`Retard total dû au trafic : +${delayAll} min.`); worse('warn'); }
  if (!cur) { lines.push('Un péage de ce trajet n\'est pas reconnu : l\'itinéraire a changé.'); worse('bad'); }
  else {
    if (Math.abs(cur.km - s.km) > Math.max(5, 0.05 * s.km)) { lines.push(`L'itinéraire a changé (${Math.round(cur.km)} km au lieu de ${Math.round(s.km)} km) : déviation ou route fermée ?`); worse('bad'); }
    if (cur.toll > s.toll + 1) { lines.push(`Plus de péages que prévu (${cur.toll.toFixed(2)} € au lieu de ${s.toll.toFixed(2)} €).`); worse('bad'); }
    if (cur.min > s.min + Math.max(15, 0.15 * s.min)) { lines.push('Nettement plus long que prévu.'); worse('warn'); }
  }
  if (cur && f) {
    const gap = cur.min - f.min, save = f.cost - cur.cost;
    lines.push(`Le plus rapide maintenant : ${hmm(f.min)}. Ce trajet : ${gap >= 0 ? '+' : ''}${Math.round(gap)} min pour ${save >= 0 ? '−' : '+'}${Math.abs(save).toFixed(2).replace('.', ',')} € (prévu : +${Math.round(s.dMin)} min, −${s.save.toFixed(2).replace('.', ',')} €).`);
    if (gap > s.dMin + 15 && save < s.save + 5) { lines.push('Le compromis est moins bon qu\'à l\'enregistrement.'); worse('bad'); }
  }
  const title = { ok: '✅ Itinéraire OK', warn: '⚠️ À surveiller', bad: '❌ Relancer l\'analyse conseillé' }[level];
  return { level, title, lines, at: now.toISOString() };
}

// Before opening Google Maps: check the stops with TomTom ("would a router that takes the fastest roads, going through
// these stops, pay tolls this option avoids, or leave its roads?"). If yes, add stops on the option's own road where it
// goes wrong and check again (up to 4 rounds). Toll-free options are checked with "avoid tolls", as the app tells the
// user to switch it on. fixed: charging stops of the e-208, always kept (they use some of Google's 9 stops).
// 1-4 TomTom requests. Returns {via, ok} (via without the fixed stops).
export async function refineVia(o, d, e, v, depart = new Date(), maxStops = 9, fixed = []) {
  if (!e.line || !e.line.length) return { via: e.via || [], ok: true };
  maxStops = Math.max(1, maxStops - fixed.length);
  const free = e.toll < 0.05;
  const nearestJ = (p) => { let bj = 0, bd = Infinity; e.line.forEach((q, j) => { const dd = km(q, p); if (dd < bd) { bd = dd; bj = j; } }); return [bj, bd]; };
  let js = [...new Set((e.via || []).map((p) => nearestJ(p)[0]))].sort((a, b) => a - b);
  let best = null;                                  // stops giving the fewest problems so far
  for (let round = 0; round < 4; round++) {
    const via = js.map((j) => e.line[j]);
    const rs = await route(o, d, { via: mergeStops(e.line, via, fixed), depart: isoLocal(depart), maxSpeed: v.maxSpeed, avoidTolls: free });
    if (!rs.length) break;
    const r = rs[0], pr = priceRoute(r, depart), rp = routePoints(r);
    // parts of the option's line the test route does not pass near (> 1.5 km): Google would take other roads there
    const away = [];
    { let run = null;
      for (let j = 0; j < e.line.length; j++) {
        let dmin = Infinity; for (let i = 0; i < rp.length; i += 2) { const dd = km(rp[i], e.line[j]); if (dd < dmin) dmin = dd; if (dmin < 1.5) break; }
        if (dmin >= 1.5) { if (!run) away.push(run = { a: j, b: j }); else run.b = j; } else run = null;
      } }
    const awayLen = away.reduce((t, ru) => t + (ru.b - ru.a + 1), 0) / e.line.length;
    const tollOk = !pr.unpriced && pr.toll <= e.toll + 0.5;
    if (tollOk && awayLen <= 0.1) return { via, ok: true };
    const bad = (pr.unpriced ? 1e6 : Math.max(0, pr.toll - e.toll)) + awayLen * 20;
    if (!best || bad < best.bad) best = { via, bad };
    const adds = [];
    for (const sct of r.sections || []) {
      if (sct.sectionType !== 'TOLL_ROAD') continue;
      // toll stretch of the test route that the option does not take (all of it): find where the option is level with its
      // start and its end; in between, put a stop in the middle of each place where the option leaves that toll road
      // (the longest two), so Google is made to leave it exactly where the option does
      const [j0] = nearestJ(rp[sct.startPointIndex]), [j1] = nearestJ(rp[sct.endPointIndex]);
      const lo = Math.min(j0, j1), hi = Math.max(j0, j1);
      const runs = [];
      let run = null;
      for (let j = lo; j <= hi; j++) {
        let dmin = Infinity;
        for (let i = sct.startPointIndex; i <= sct.endPointIndex; i++) { const dd = km(rp[i], e.line[j]); if (dd < dmin) dmin = dd; if (dmin <= 0.15) break; }
        if (dmin > 0.15) { if (!run) runs.push(run = { a: j, b: j }); else run.b = j; } else run = null;
      }
      runs.sort((x, y) => (y.b - y.a) - (x.b - x.a));
      for (const ru of runs.slice(0, 2)) adds.push(Math.round((ru.a + ru.b) / 2));
      // plus stops spread along it (1 per ~40 points) where the option is clearly away from that toll road
      const n = Math.max(1, Math.round((hi - lo) / 40));
      for (let k = 1; k <= n; k++) {
        const j = Math.round(lo + (hi - lo) * k / (n + 1));
        let dmin = Infinity;
        for (let i = sct.startPointIndex; i <= sct.endPointIndex; i += 3) dmin = Math.min(dmin, km(rp[i], e.line[j]));
        if (dmin > 0.5) adds.push(j);
      }
    }
    // a stop in the middle of each long part where the test route left the option's roads (the longest two)
    if (awayLen > 0.1) for (const ru of [...away].sort((x, y) => (y.b - y.a) - (x.b - x.a)).slice(0, 2)) if (ru.b - ru.a >= 2) adds.push(Math.round((ru.a + ru.b) / 2));
    if (!adds.length) break;
    const keep = new Set(adds);
    let all = [...new Set([...js, ...adds])].sort((a, b) => a - b);
    while (all.length > maxStops) {                 // drop the older stop closest to its neighbour
      let bi = -1, bg = Infinity;
      all.forEach((j, i) => { if (keep.has(j)) return; const g = Math.min(i ? j - all[i - 1] : 1e9, i < all.length - 1 ? all[i + 1] - j : 1e9); if (g < bg) { bg = g; bi = i; } });
      if (bi < 0) { all = all.slice(0, maxStops); break; }
      all.splice(bi, 1);
    }
    if (all.join() === js.join()) break;            // nothing new to try
    js = all;
  }
  return { via: best ? best.via : js.map((j) => e.line[j]), ok: false };
}

export function isoLocal(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// Two-part trip for options "motorway to X, then free roads" (or the reverse): the stops are shared out between the
// two parts by their place along the option. Returns [{ from, to, via, avoidTolls }] or null for a one-link option.
export function splitTrip(o, d, e, via) {
  if (!e.split || !e.line?.length) return null;
  const idx = (p) => { let bj = 0, bd = Infinity; e.line.forEach((q, j) => { const dd = km(q, p); if (dd < bd) { bd = dd; bj = j; } }); return bj; };
  const X = e.split.at, jx = idx(X);
  const near = (p) => km(p, X) < 1;
  const a = via.filter((p) => idx(p) < jx && !near(p)), b = via.filter((p) => idx(p) > jx && !near(p));
  return [{ from: o, to: X, via: a, avoidTolls: e.split.freeFirst, line: e.line.slice(0, jx + 1) },
    { from: X, to: d, via: b, avoidTolls: !e.split.freeFirst, line: e.line.slice(jx) }];
}

// Two-part trip with the stops of each part checked on its own (refineVia on that part of the option's line: the free
// part with "avoid tolls", the motorway part allowed the option's toll). Returns the legs, or null for a one-link option.
export async function refineLegs(o, d, e, v, depart = new Date(), fixed = []) {
  const legs = splitTrip(o, d, e, e.via || []);
  if (!legs) return null;
  const parts = fixed.length ? splitTrip(o, d, e, fixed).map((L) => L.via) : [[], []];
  for (const [k, L] of legs.entries()) {
    const r = await refineVia(L.from, L.to, { line: L.line, via: L.via, toll: L.avoidTolls ? 0 : e.toll }, v, depart, 9, parts[k]);
    L.via = mergeStops(L.line, r.via, parts[k]);
  }
  return legs;
}

// Google Maps directions link with waypoints that force the chosen path (max 9 waypoints)
export function googleMapsUrl(o, d, via) {
  let w = via.filter(Boolean);
  if (w.length > 9) { const step = w.length / 9; w = Array.from({ length: 9 }, (_, i) => w[Math.floor(i * step)]); }
  const f = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  // no origin → Google starts from the phone's position (2nd part of a two-link trip, opened on the way)
  let url = `https://www.google.com/maps/dir/?api=1${o ? `&origin=${f(o)}` : ''}&destination=${f(d)}&travelmode=driving`;
  if (w.length) url += `&waypoints=${encodeURIComponent(w.map(f).join('|'))}`;
  return url;
}
