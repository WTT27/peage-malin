// Optimizer v3: find the good in-between routes with few TomTom requests.
//
//  1. TomTom: fastest route (with instructions -> time at every point) + toll-free route.        (2 requests)
//  2. Every option is described as pieces: "motorway from point i to j of the fastest route" (time read from
//     the fastest route, toll priced exactly) or "free roads from A to B" (estimated with Valhalla, free).
//     Options: per toll stretch, every combination of motorway / free pieces between interchanges;
//     "motorway to exit X then free roads" and "free roads to X then motorway" (national roads such as the N10).
//  3. Pruning: a free piece is only considered if it avoids at least MIN_SKIP € of toll.
//  4. Valhalla times are calibrated on TomTom (toll-free route), the efficient options are shortlisted and
//     only their free pieces are confirmed with TomTom (live traffic). Two rounds, re-calibrating in between.
//  5. All requests are cached on the phone (TomTom 3 h, Valhalla 7 days).
import { km, cumulative, routePoints } from './geo.js';
import { priceRoute, priceSection, stationsNear, nearestLocal } from './tolls.js';
import { route, localPoints, freeEstimate, freeMatrix } from './services.js';

const TRANSITION_SEC = 60;   // leaving / joining the motorway
const MAX_NODES = 12;        // interchanges kept per toll stretch
const MIN_SKIP = 0.5;        // € — a free piece must avoid at least this toll
const SHORTLIST_1 = 9, SHORTLIST_2 = 6;
const MAX_DETOURS = 24;
const MAX_CHAIN = 12;        // follow-up detours: block the tolls of a detour too, step by step towards toll-free      // TomTom "avoid this spot" requests per trip (complete method)
const APPROACH_KM = +(globalThis.PM_APPROACH ?? 5);       // free bypasses may also start this far before a toll stretch / end this far after it
                             // (e.g. A13 → A12 → N12 instead of the A86 Duplex: the bypass leaves at Rocquencourt)

export const DEFAULT_VEHICLES = {
  diesel: { label: '5008 diesel', type: 'diesel', lPer100: 6.0, eurPerL: 2.21, maxSpeed: null },
  ev: { label: 'e-208', type: 'ev', kwhMotorway: 18, kwhOther: 15, batteryKwh: 46, homeEurKwh: 0.14, fastEurKwh: 0.54,
    chargeKw: 45, stopOverheadMin: 10, maxSpeed: 110 },
};

export function energy(c, v) {
  if (v.type === 'diesel') return { energy: c.km * v.lPer100 / 100 * v.eurPerL, chargeMin: 0, kwh: 0 };
  const kwh = c.mkm * v.kwhMotorway / 100 + (c.km - c.mkm) * v.kwhOther / 100;
  const home = Math.min(kwh, v.batteryKwh * 0.9);
  const extra = kwh - home;
  const stops = extra > 0 ? Math.ceil(extra / (v.batteryKwh * 0.7)) : 0;
  return { energy: home * v.homeEurKwh + extra * v.fastEurKwh, chargeMin: extra / v.chargeKw * 60 + stops * v.stopOverheadMin, kwh };
}

const cleanName = (n) => n.replace(/^\d+(\.\d+)?[a-z]?(?=[A-ZÉ])/, '').trim();
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

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
// options.estimator: 'tomtom' (complete, default) or 'valhalla' (economical: free estimates + TomTom checks)
export async function analyse(o, d, v, depart, onProgress = () => {}, { estimator = 'tomtom' } = {}) {
  const opt = { maxSpeed: v.maxSpeed, depart: isoLocal(depart) };
  onProgress(0.03, 'Itinéraire le plus rapide…');
  const [routes, freeRoutes] = await Promise.all([
    route(o, d, { ...opt, alternatives: 5, instructions: true }),
    route(o, d, { ...opt, avoidTolls: true, alternatives: 3 })]);
  if (!routes.length) throw new Error('Aucun itinéraire trouvé');
  const fastest = routes[0];
  const pts = routePoints(fastest), cum = cumulative(pts), N = pts.length - 1;
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
  allNodes.forEach((nodes, k) => {      // stretches without stations (e.g. the A86 Duplex tunnel): use the price label
    if (nodes.length === 2 && nodes.startName === 'début du péage') {
      const det = tollBetween(tolls[k][0], tolls[k][1]).details[0];
      if (det) nodes.title = det.to ? `${cleanName(det.from)} → ${cleanName(det.to)}` : det.from.replace(/\s*\(.*\)$/, '');
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

  // ---- Valhalla estimates of free pieces (free service, no TomTom quota) ----
  const est = new Map();             // "A|B" -> {sec, km}
  const ek = (A, B) => `${A[0].toFixed(5)},${A[1].toFixed(5)}|${B[0].toFixed(5)},${B[1].toFixed(5)}`;
  const real = new Map();            // free pieces checked with TomTom: key -> {sec, km, mkm, mid, vsec} | null (invalid)
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
      mid: rp[Math.floor(rp.length / 2)], late: rp[Math.floor(rp.length * 0.8)], vsec: est.get(key)?.sec, roads: mainRoads(r[0]) });
  }
  let mode = estimator, notice = null;
  const vJobs = [];
  if (mode === 'valhalla') for (const nodes of allNodes) {
    // matrices over windows of interchanges less than ~120 km apart (server limit 150 km)
    const ok = nodes.filter((nd) => nd.L);
    for (let s = 0; s < ok.length - 1;) {
      let e = s + 1;
      while (e + 1 < ok.length && km(ok[s].L, ok[e + 1].L) < 120) e++;
      const win = ok.slice(s, e + 1).map((nd) => nd.L);
      vJobs.push(freeMatrix(win, win, v.maxSpeed).then((m) => {
        if (m) win.forEach((A, i) => win.forEach((B, j) => { if (i < j && m[i][j]) est.set(ek(A, B), m[i][j]); }));
      }));
      if (e === ok.length - 1) break;
      s = Math.max(s + 1, Math.floor((s + e) / 2));
    }
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
  let factor = 0.85;
  if (mode === 'valhalla') {
    for (const e of escapes) vJobs.push(freeEstimate(e.A, e.B, v.maxSpeed).then((r) => { if (r) est.set(ek(e.A, e.B), r); }));
    let vDone = 0;
    vJobs.forEach((j) => j.then(() => onProgress(0.12 + 0.45 * (++vDone / vJobs.length), 'Estimation des routes gratuites…')));
    const vFree = freeEstimate(o, d, v.maxSpeed);
    await Promise.all(vJobs);
    // calibration: Valhalla is usually slower than TomTom on free roads
    const vf = await vFree;
    if (freeRoutes.length && vf) factor = Math.min(1.15, Math.max(0.55, freeRoutes[0].summary.travelTimeInSeconds / vf.sec));
    if (!est.size && (escapes.length || allNodes.some((ns) => ns.length > 2))) {
      mode = 'tomtom';
      notice = 'Service d\'estimation gratuit indisponible : calcul complet avec TomTom.';
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
          if (mode === 'tomtom') {          // complete mode: chain of checked pieces between consecutive interchanges
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
          } else pieces.push({ type: 'free', A: nodes[j].L, B: nodes[e].L });
          free.push([j, e]);
        } else pieces.push(mw(nodes[j].idx, nodes[e].idx));
        j = e;
      }
      if (!ok) continue;
      const f0 = nodes.hasPre ? 1 : 0, f1 = nodes.hasPost ? n - 2 : n - 1;      // first / last toll node
      const nm = (i) => (i <= f0 ? nodes.startName : i >= f1 ? nodes.endName : cleanName(nodes[i].name));
      const label = free.length === 1 && free[0][0] <= f0 && free[0][1] >= f1
        ? (nodes.title ? `sans le péage ${nodes.title}` : `sans le péage ${nodes.startName} → ${nodes.endName}`)
        : free.map(([a, b]) => `routes gratuites ${nm(a)} → ${nm(b)}`).join(', ');
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
      const whole = nodes.title || `${nodes.startName} → ${nodes.endName}`;
      const pick = spots.length > 10 ? Array.from({ length: 10 }, (_, k) => spots[Math.floor(k * spots.length / 10)]) : spots;
      reqs.push({ boxes: pick.map((sp) => cover(sp.i, 0.5)), retry: pick.map((sp) => cover(sp.j, 1)), t: spots.reduce((a, sp) => a + sp.t, 0), name: `évite le péage ${whole}` });
      if (spots.length > 1 && mode === 'tomtom') for (const sp of spots) reqs.push({ boxes: chain(sp.i), retry: [cover(sp.j, 1)], t: sp.t, name: `évite ${sp.name}` });
    });
    reqs.sort((a, b) => b.t - a.t);
    const todo = reqs.slice(0, mode === 'tomtom' ? MAX_DETOURS : 4);
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
      if (tb === null || ta === null) { wholeDetours.push({ r, label: `Détour TomTom : ${q.name}` }); return; }   // kept as a whole route
      const Td = timeline(r, rp, rc);
      let mk = 0;
      for (const sct of r.sections || []) if (sct.sectionType === 'MOTORWAY')
        for (let i = Math.max(sct.startPointIndex + 1, ja + 1); i <= Math.min(sct.endPointIndex, jb); i++) mk += km(rp[i - 1], rp[i]);
      const at = (f) => rp[Math.floor(ja + (jb - ja) * f)];
      const roads = mainRoads(r, ja, jb);
      detours.push({ a, b, label: q.name, piece: { type: 'seg', a, b, sec: Td[jb] - Td[ja], km: rc[jb] - rc[ja], mkm: mk,
        toll: Math.max(0, pr.toll - tb - ta), details: pr.details, roads, via: [at(0.05), at(0.5), at(0.8)] } });
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
    let budget = mode === 'tomtom' ? MAX_CHAIN : 3;
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
        wholeDetours.push({ r, label: `Itinéraire TomTom moins cher${rd.length ? ` (par ${rd.join(', ')})` : ''}`, named: true });
        if (globalThis.PM_DEBUG) console.error('chain', g.name, '→', Math.round(r.summary.travelTimeInSeconds / 60), 'min', pr.toll.toFixed(2), '€', rd);
        return { r, boxes, toll: pr.toll, name: g.name + ' +' };
      }));
      gen = res.filter((x) => x && x.toll > 0.5).sort((a, b) => b.toll - a.toll);
    }
  }


  const detourJob = runDetours();
  if (mode === 'tomtom') {
    // complete mode: every free piece used by an option and every escape checked with TomTom
    const jobs = new Map();
    for (const ps of perStretch) for (const op of ps.opts) for (const p of op.pieces) if (p.type === 'free') jobs.set(ek(p.A, p.B), [p.A, p.B]);
    for (const e of escapes) jobs.set(ek(e.A, e.B), [e.A, e.B]);
    let n = 0;
    await Promise.all([...jobs.values()].map(([A, B]) => confirmPiece(A, B).then(() =>
      onProgress(0.12 + 0.8 * (++n / jobs.size), 'Routes gratuites et sorties (TomTom)…'))));
  }

  await detourJob;

  // ---- evaluation of a list of pieces (estimated or confirmed) ----
  function evalPieces(pieces) {
    let sec = 0, kmv = 0, mkm = 0, toll = 0, estimated = false, transitions = 0, prev = null;
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
        const key = ek(p.A, p.B);
        if (real.has(key)) {
          const r = real.get(key);
          if (!r) return null;
          sec += r.sec; kmv += r.km; mkm += r.mkm;
        } else {
          const e = est.get(key);
          if (!e) return null;
          sec += e.sec * factor; kmv += e.km; estimated = true;
        }
      }
    }
    sec += transitions * TRANSITION_SEC;
    const c = { sec, km: kmv, mkm, toll, estimated, details };
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
        out.push({ label: 'Détour TomTom : ' + lab, pieces, kind: 'detour' });
      }
    }
    for (const e of escapes) {
      const nm = cleanName(e.nd.name);
      out.push(e.kind === 'sortie'
        ? { label: `Autoroute jusqu'à ${nm}, puis routes gratuites`, pieces: [mw(0, e.nd.idx), { type: 'free', A: e.A, B: e.B }], kind: 'escape' }
        : { label: `Routes gratuites jusqu'à ${nm}, puis autoroute`, pieces: [{ type: 'free', A: e.A, B: e.B }, mw(e.nd.idx, N)], kind: 'escape' });
    }
    const list = [];
    for (const c of out) { const e = evalPieces(c.pieces); if (e) list.push({ ...c, ...e }); }
    return { ref, list };
  }

  // ---- shortlist + TomTom confirmation (2 rounds) ----
  async function confirm(cs, p0, p1) {
    const todo = new Map();
    for (const c of cs) for (const p of c.pieces) if (p.type === 'free' && !real.has(ek(p.A, p.B))) todo.set(ek(p.A, p.B), p);
    let n = 0;
    await Promise.all([...todo.values()].map((p) => confirmPiece(p.A, p.B).then(() =>
      onProgress(p0 + (p1 - p0) * (++n / todo.size), 'Vérification avec le trafic en temps réel…'))));
  }
  function shortlist(list, ref, size) {
    const eff = frontier(list.filter((c) => c.cost < ref.cost - 0.3), 'min', 'cost').filter((c) => c.estimated);
    if (!eff.length) return [];
    const S = Math.max(...eff.map((c) => ref.cost - c.cost), 1), Tm = Math.max(...eff.map((c) => c.min - ref.min), 1);
    return eff.map((c) => ({ c, s: (ref.cost - c.cost) / S - (c.min - ref.min) / Tm })).sort((a, b) => b.s - a.s).slice(0, size).map((x) => x.c);
  }
  if (globalThis.PM_DEBUG) console.error('DEBUG nodes', allNodes.map((ns) => (ns.title || ns.startName) + ':' + ns.map((n) => (n.L ? 'L' : '-')).join('')),
    'opts', perStretch.map((p) => p.opts.length), 'duplexPiece', allNodes.map((ns) => ns.length === 2 && ns[0].L && ns[1].L ? JSON.stringify(real.get(ek(ns[0].L, ns[1].L))?.sec) : '-'));
  let { ref, list } = buildAll();
  if (!ref) throw new Error('Prix des péages introuvable pour cet itinéraire');
  await confirm(shortlist(list, ref, SHORTLIST_1), 0.6, 0.8);
  const ratios = [...real.values()].filter((r) => r && r.vsec).map((r) => r.sec / r.vsec);
  if (ratios.length >= 2) factor = median(ratios);
  ({ ref, list } = buildAll());
  await confirm(shortlist(list, ref, SHORTLIST_2), 0.8, 0.95);
  ({ ref, list } = buildAll());

  // ---- final list: only confirmed options (+ TomTom fastest / alternatives / toll-free) ----
  const viaOf = (pieces) => pieces.filter((p) => p.type !== 'mw').flatMap((p) => {
    if (p.type === 'seg') return p.via;
    const r = real.get(ek(p.A, p.B));
    // start, middle and 80 % of the free part: Google must not rejoin the toll road (e.g. stay on the N12)
    return [p.A === o ? null : p.A, r?.mid, p.B === d ? null : r?.late].filter(Boolean);
  });
  const refC = { ...ref, label: 'Le plus rapide (autoroute)', kind: 'ref', via: [], isRef: true };
  const finals = [refC];
  const roadsOf = (pieces) => [...new Set(pieces.filter((p) => p.type !== 'mw').flatMap((p) => (p.type === 'seg' ? p.roads : real.get(ek(p.A, p.B))?.roads || [])))];
  for (const c of list) if (!c.estimated) {
    const rd = roadsOf(c.pieces);
    finals.push({ ...c, label: rd.length ? `${c.label} (par ${rd.join(', ')})` : c.label, via: viaOf(c.pieces) });
  }
  const extra = (r, label, kind) => {
    const c = evaluateRoute(r, v, depart);
    if (!c) return;
    const rp = routePoints(r);
    finals.push({ ...c, label, kind, via: [rp[Math.floor(rp.length / 3)], rp[Math.floor(2 * rp.length / 3)]] });
  };
  routes.slice(1).forEach((r, i) => extra(r, `Alternative TomTom ${i + 1}`, 'tomtom'));
  freeRoutes.forEach((r, i) => extra(r, i ? `Sans péage (variante ${i})` : 'Sans péage', 'free'));
  for (const w of wholeDetours) {
    if (w.named) { extra(w.r, w.label, 'detour'); continue; }
    const rd = mainRoads(w.r);
    extra(w.r, rd.length ? `${w.label} (par ${rd.join(', ')})` : w.label, 'detour');
  }

  // near-identical routes (same time and cost): keep the first one found (corridor options before detours)
  for (let i = finals.length - 1; i > 0; i--) if (finals.slice(0, i).some((f) => Math.abs(f.min - finals[i].min) < 0.6 && Math.abs(f.cost - finals[i].cost) < 0.25)) finals.splice(i, 1);
  let eff = frontier(finals.filter((c) => c === refC || c.cost < refC.cost - 0.05), 'min', 'cost');
  if (!eff.includes(refC)) eff = [refC, ...eff].sort((a, b) => a.min - b.min);
  rate(eff, refC);
  onProgress(1, 'Terminé');
  return { eff, mode, notice, count: list.length + 1, confirmed: [...real.values()].filter(Boolean).length, factor, fastest };
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

export function isoLocal(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// Google Maps directions link with waypoints that force the chosen path (max 9 waypoints)
export function googleMapsUrl(o, d, via) {
  let w = via.filter(Boolean);
  if (w.length > 9) { const step = w.length / 9; w = Array.from({ length: 9 }, (_, i) => w[Math.floor(i * step)]); }
  const f = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  let url = `https://www.google.com/maps/dir/?api=1&origin=${f(o)}&destination=${f(d)}&travelmode=driving`;
  if (w.length) url += `&waypoints=${encodeURIComponent(w.map(f).join('|'))}`;
  return url;
}
