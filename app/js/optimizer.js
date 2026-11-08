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
  const opt = { maxSpeed: v.maxSpeed, depart: isoLocal(depart) };
  onProgress(0.03, 'Itinéraire le plus rapide…');
  const [routes, freeRoutes] = await Promise.all([
    route(o, d, { ...opt, alternatives: 2, instructions: true }),
    route(o, d, { ...opt, avoidTolls: true })]);
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
  const flat = allNodes.flat();
  const locals = await resolveLocals(flat.map((nd) => pts[nd.idx]), flat.map((nd) => nd.local));
  flat.forEach((nd, i) => { nd.L = locals[i]; });

  // ---- Valhalla estimates of free pieces (free service, no TomTom quota) ----
  const est = new Map();             // "A|B" -> {sec, km}
  const ek = (A, B) => `${A[0].toFixed(5)},${A[1].toFixed(5)}|${B[0].toFixed(5)},${B[1].toFixed(5)}`;
  const vJobs = [];
  for (const nodes of allNodes) {
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
    for (const nd of allNodes[k].slice(1, -1)) {
      if (!nd.L) continue;
      const after = tollBetween(nd.idx, N).toll, before = tollBetween(0, nd.idx).toll;
      if (after !== null && after >= 1) escapes.push({ kind: 'sortie', nd, A: nd.L, B: d });
      if (before !== null && before >= 1) escapes.push({ kind: 'entrée', nd, A: o, B: nd.L });
    }
  }
  for (const e of escapes) vJobs.push(freeEstimate(e.A, e.B, v.maxSpeed).then((r) => { if (r) est.set(ek(e.A, e.B), r); }));
  let vDone = 0;
  vJobs.forEach((j) => j.then(() => onProgress(0.12 + 0.45 * (++vDone / vJobs.length), 'Estimation des routes gratuites…')));
  const vFree = freeEstimate(o, d, v.maxSpeed);
  await Promise.all(vJobs);

  // ---- calibration: Valhalla is usually slower than TomTom on free roads ----
  let factor = 0.85;
  const vf = await vFree;
  if (freeRoutes.length && vf) factor = Math.min(1.15, Math.max(0.55, freeRoutes[0].summary.travelTimeInSeconds / vf.sec));

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
          pieces.push({ type: 'free', A: nodes[j].L, B: nodes[e].L });
          free.push([j, e]);
        } else pieces.push(mw(nodes[j].idx, nodes[e].idx));
        j = e;
      }
      if (!ok) continue;
      const nm = (i) => (i === 0 ? nodes.startName : i === n - 1 ? nodes.endName : cleanName(nodes[i].name));
      const label = free.length === 1 && free[0][0] === 0 && free[0][1] === n - 1 ? `sans le péage ${nodes.startName} → ${nodes.endName}`
        : free.map(([a, b]) => `routes gratuites ${nm(a)} → ${nm(b)}`).join(', ');
      opts.push({ pieces, label });
    }
    return { s0: nodes[0].idx, s1: nodes[n - 1].idx, opts };
  });

  // ---- evaluation of a list of pieces (estimated or confirmed) ----
  const real = new Map();            // confirmed free pieces: key -> {sec, km, mkm, mid, vsec} | null (invalid)
  function evalPieces(pieces) {
    let sec = 0, kmv = 0, mkm = 0, toll = 0, estimated = false, transitions = 0, prev = null;
    const details = [];
    for (const p of pieces) {
      if (p.type === 'mw' && p.b <= p.a) continue;
      if (prev && prev !== p.type) transitions++;
      prev = p.type;
      if (p.type === 'mw') {
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
    await Promise.all([...todo.values()].map(async (p) => {
      const r = await route(p.A, p.B, { ...opt, avoidTolls: true });
      onProgress(p0 + (p1 - p0) * (++n / todo.size), 'Vérification avec le trafic en temps réel…');
      const key = ek(p.A, p.B);
      if (!r.length) { real.set(key, null); return; }
      const pr = priceRoute(r[0], depart);
      if (pr.unpriced || pr.toll > 0.5) { real.set(key, null); return; }   // TomTom could not avoid the motorway
      const rp = routePoints(r[0]);
      real.set(key, { sec: r[0].summary.travelTimeInSeconds, km: r[0].summary.lengthInMeters / 1000, mkm: motorwayKmOf(r[0], rp),
        mid: rp[Math.floor(rp.length / 2)], vsec: est.get(key)?.sec });
    }));
  }
  function shortlist(list, ref, size) {
    const eff = frontier(list.filter((c) => c.cost < ref.cost - 0.3), 'min', 'cost').filter((c) => c.estimated);
    if (!eff.length) return [];
    const S = Math.max(...eff.map((c) => ref.cost - c.cost), 1), Tm = Math.max(...eff.map((c) => c.min - ref.min), 1);
    return eff.map((c) => ({ c, s: (ref.cost - c.cost) / S - (c.min - ref.min) / Tm })).sort((a, b) => b.s - a.s).slice(0, size).map((x) => x.c);
  }
  let { ref, list } = buildAll();
  if (!ref) throw new Error('Prix des péages introuvable pour cet itinéraire');
  await confirm(shortlist(list, ref, SHORTLIST_1), 0.6, 0.8);
  const ratios = [...real.values()].filter((r) => r && r.vsec).map((r) => r.sec / r.vsec);
  if (ratios.length >= 2) factor = median(ratios);
  ({ ref, list } = buildAll());
  await confirm(shortlist(list, ref, SHORTLIST_2), 0.8, 0.95);
  ({ ref, list } = buildAll());

  // ---- final list: only confirmed options (+ TomTom fastest / alternatives / toll-free) ----
  const viaOf = (pieces) => pieces.filter((p) => p.type === 'free').flatMap((p) => {
    const r = real.get(ek(p.A, p.B));
    return [p.A === o ? null : p.A, r?.mid].filter(Boolean);
  });
  const refC = { ...ref, label: 'Le plus rapide (autoroute)', kind: 'ref', via: [], isRef: true };
  const finals = [refC];
  for (const c of list) if (!c.estimated) finals.push({ ...c, via: viaOf(c.pieces) });
  const extra = (r, label, kind) => {
    const p = priceRoute(r, depart);
    if (p.unpriced) return;
    const rp = routePoints(r);
    const c = { label, kind, sec: r.summary.travelTimeInSeconds, km: r.summary.lengthInMeters / 1000, mkm: motorwayKmOf(r, rp),
      toll: p.toll, details: p.details, via: [rp[Math.floor(rp.length / 3)], rp[Math.floor(2 * rp.length / 3)]] };
    Object.assign(c, energy(c, v));
    c.cost = c.toll + c.energy; c.min = c.sec / 60 + c.chargeMin;
    finals.push(c);
  };
  routes.slice(1).forEach((r, i) => extra(r, `Alternative TomTom ${i + 1}`, 'tomtom'));
  if (freeRoutes.length) extra(freeRoutes[0], 'Sans péage', 'free');

  let eff = frontier(finals.filter((c) => c === refC || c.cost < refC.cost - 0.05), 'min', 'cost');
  if (!eff.includes(refC)) eff = [refC, ...eff].sort((a, b) => a.min - b.min);
  rate(eff, refC);
  onProgress(1, 'Terminé');
  return { eff, count: list.length + 1, confirmed: [...real.values()].filter(Boolean).length, factor, fastest };
}

// best compromise, free wins
function rate(eff, f0) {
  const cheapest = eff.reduce((a, b) => (b.cost < a.cost ? b : a));
  const S = f0.cost - cheapest.cost, Tm = Math.max(...eff.map((e) => e.min)) - f0.min;
  let best = null, bs = -9;
  for (const e of eff) {
    e.dMin = e.min - f0.min; e.save = f0.cost - e.cost;
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
