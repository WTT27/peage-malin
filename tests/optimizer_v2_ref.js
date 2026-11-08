// Optimizer v2 (port of tools/optimizer.py): find the good in-between routes.
import { km, cumulative, routePoints } from '../app/js/geo.js';
import { priceRoute, priceSection, stationsNear, nearestLocal } from '../app/js/tolls.js';
import { route, localPoints } from '../app/js/services.js';

const TRANSITION_SEC = 60;
const MAX_NODES = 12;

export const DEFAULT_VEHICLES = {
  diesel: { label: '5008 diesel', type: 'diesel', lPer100: 6.0, eurPerL: 2.21, maxSpeed: null },
  ev: { label: 'e-208', type: 'ev', kwhMotorway: 18, kwhOther: 15, batteryKwh: 46, homeEurKwh: 0.14, fastEurKwh: 0.54,
    chargeKw: 45, stopOverheadMin: 10, maxSpeed: 110 },
};

function motorwayKm(r) {
  const pts = routePoints(r);
  let tot = 0;
  for (const s of r.sections || []) {
    if (s.sectionType !== 'MOTORWAY') continue;
    for (let i = s.startPointIndex + 1; i <= s.endPointIndex; i++) tot += km(pts[i - 1], pts[i]);
  }
  return tot;
}

function legMetrics(r) {
  return { km: r.summary.lengthInMeters / 1000, sec: r.summary.travelTimeInSeconds, mkm: motorwayKm(r) };
}

export function energy(c, v) {
  if (v.type === 'diesel') return { energy: c.km * v.lPer100 / 100 * v.eurPerL, chargeMin: 0, kwh: 0 };
  const kwh = c.mkm * v.kwhMotorway / 100 + (c.km - c.mkm) * v.kwhOther / 100;
  const home = Math.min(kwh, v.batteryKwh * 0.9);
  const extra = kwh - home;
  const stops = extra > 0 ? Math.ceil(extra / (v.batteryKwh * 0.7)) : 0;
  return { energy: home * v.homeEurKwh + extra * v.fastEurKwh, chargeMin: extra / v.chargeKw * 60 + stops * v.stopOverheadMin, kwh };
}

function evaluateLegs(legs, depart) {
  let t = depart.getTime();
  const res = { km: 0, sec: 0, mkm: 0, toll: 0, unpriced: 0, details: [] };
  for (const r of legs) {
    const p = priceRoute(r, new Date(t));
    res.km += r.summary.lengthInMeters / 1000; res.sec += r.summary.travelTimeInSeconds;
    res.mkm += motorwayKm(r); res.toll += p.toll; res.unpriced += p.unpriced; res.details.push(...p.details);
    t += 1000 * r.summary.travelTimeInSeconds;
  }
  return res;
}

const cleanName = (n) => n.replace(/^\d+(\.\d+)?[a-z]?(?=[A-ZÉ])/, '').trim();

function frontier(items, tkey, ckey) {
  const out = [];
  for (const it of [...items].sort((a, b) => a[tkey] - b[tkey] || a[ckey] - b[ckey])) {
    if (!out.length || it[ckey] < out[out.length - 1][ckey] - 0.05) out.push(it);
  }
  return out;
}

function stretchNodes(pts, cum, i0, i1) {
  const found = stationsNear(pts, cum, i0, i1);
  let nodes = [{ idx: i0, name: 'début du tronçon' }];
  for (const f of found) {
    if (f.pos - cum[nodes[nodes.length - 1].idx] > 3 && cum[i1] - f.pos > 3) nodes.push({ idx: f.idx, name: f.name, local: f.local });
  }
  if (nodes.length - 1 > MAX_NODES) {
    const inner = nodes.slice(1), step = inner.length / MAX_NODES;
    nodes = [nodes[0], ...Array.from({ length: MAX_NODES }, (_, k) => inner[Math.floor(k * step)])];
  }
  nodes.push({ idx: i1, name: 'fin du tronçon' });
  nodes.startName = found.length ? cleanName(found[0].name) : 'début du péage';
  nodes.endName = found.length ? cleanName(found[found.length - 1].name) : 'fin du péage';
  return nodes;
}

// ordinary-road points near motorway points: precomputed data first, online lookup only for the rest
async function resolveLocals(points, preset = []) {
  const out = points.map((p, i) => preset[i] || nearestLocal(p));
  const missing = out.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const found = await localPoints(missing.map((i) => points[i]));
    missing.forEach((i, j) => { out[i] = found[j]; });
  }
  return out;
}

function priceRun(legs, when) {
  const pts = legs.flatMap(routePoints);
  if (pts.length < 2) return 0;
  const cum = cumulative(pts);
  return priceSection(pts, cum, 0, pts.length - 1, when).price;
}

async function optimiseStretch(pts, cum, nodes, localsPromise, opt, when, progress) {
  const P = nodes.map((n) => pts[n.idx]);
  const n = nodes.length;
  const idx = [...Array(n - 1).keys()];
  const [tollRaw, Lraw] = await Promise.all([
    Promise.all(idx.map((j) => route(P[j], P[j + 1], opt).then((r) => { progress(); return r[0] || null; }))),
    localsPromise]);
  const tollLegs = tollRaw;
  // a free-road piece needs real off-motorway points at both ends; otherwise it is not offered
  const freeLegs = await Promise.all(idx.map((j) => (Lraw[j] && Lraw[j + 1])
    ? route(Lraw[j], Lraw[j + 1], { ...opt, avoidTolls: true }).then((r) => { progress(); return r[0] || null; })
    : Promise.resolve(null)));
  if (tollLegs.some((x) => !x)) return null;
  const tm = tollLegs.map(legMetrics);
  const fm = freeLegs.map((r) => {
    if (!r) return { km: 0, sec: 0, mkm: 0, toll: null };
    const m = legMetrics(r), p = priceRoute(r, when);
    // a "free" piece that still pays a toll means TomTom could not avoid the motorway: not offered
    m.toll = p.unpriced || p.toll > 0.5 ? null : p.toll;
    return m;
  });
  const runCache = new Map();
  const runPrice = (a, b) => {
    const k = a + '|' + b;
    if (!runCache.has(k)) runCache.set(k, priceRun(tollLegs.slice(a, b), when));
    return runCache.get(k);
  };
  const options = [];
  const total = 1 << (n - 1);
  for (let mask = 0; mask < total; mask++) {
    // bit j set = piece j on free roads
    let kmv = 0, sec = 0, mkm = 0, toll = 0, ok = true;
    const free = [];
    let j = 0;
    while (j < n - 1 && ok) {
      const isFree = (mask >> j) & 1;
      let k = j;
      while (k < n - 1 && ((mask >> k) & 1) === isFree) k++;
      if (!isFree) {
        const p = runPrice(j, k);
        if (p === null) { ok = false; break; }
        toll += p;
        for (let x = j; x < k; x++) { kmv += tm[x].km; sec += tm[x].sec; mkm += tm[x].mkm; }
      } else {
        for (let x = j; x < k; x++) {
          kmv += fm[x].km; sec += fm[x].sec; mkm += fm[x].mkm;
          if (fm[x].toll === null) ok = false; else toll += fm[x].toll;
        }
        free.push([j, k]);
      }
      j = k;
    }
    if (!ok) continue;
    let transitions = 0;
    for (let x = 0; x < n - 2; x++) if (((mask >> x) & 1) !== ((mask >> (x + 1)) & 1)) transitions++;
    sec += transitions * TRANSITION_SEC;
    const nm = (i) => (i === 0 ? nodes.startName : i === n - 1 ? nodes.endName : cleanName(nodes[i].name));
    const label = !free.length ? 'autoroute'
      : free.length === 1 && free[0][0] === 0 && free[0][1] === n - 1 ? `sans le péage ${nodes.startName} → ${nodes.endName}`
        : free.map(([a, b]) => `routes gratuites ${nm(a)} → ${nm(b)}`).join(', ');
    // waypoints to force this path in Google Maps: a point in the middle of each free piece
    const via = free.map(([a, b]) => { const mid = freeLegs[Math.floor((a + b - 1) / 2)]; const mp = mid ? routePoints(mid) : []; return mp[Math.floor(mp.length / 2)]; });
    options.push({ km: kmv, sec, mkm, toll, label, mask, via });
  }
  return { nodes, options };
}

// Main entry. onProgress(fraction, text)
export async function analyse(o, d, v, depart, onProgress = () => {}) {
  const opt = { maxSpeed: v.maxSpeed, depart: isoLocal(depart) };
  onProgress(0.02, 'Itinéraire le plus rapide…');
  const routes = await route(o, d, { ...opt, alternatives: 2 });
  if (!routes.length) throw new Error('Aucun itinéraire trouvé');
  const fastest = routes[0];
  const pts = routePoints(fastest), cum = cumulative(pts);
  const base = evaluateLegs([fastest], depart);
  const tt = fastest.summary.travelTimeInSeconds;
  const stretches = (fastest.sections || []).filter((s) => s.sectionType === 'TOLL_ROAD' && cum[s.endPointIndex] - cum[s.startPointIndex] > 1.5);

  // rough progress budget
  let done = 0; const budget = Math.max(1, stretches.length * 30 + 10);
  const tick = (txt) => { done++; onProgress(Math.min(0.97, 0.05 + 0.9 * done / budget), txt); };

  const perStretch = [];
  const allNodes = stretches.map((s) => stretchNodes(pts, cum, s.startPointIndex, s.endPointIndex));
  const allLocals = resolveLocals(allNodes.flat().map((nd) => pts[nd.idx]), allNodes.flat().map((nd) => nd.local));
  let offset = 0;
  const stretchRes = await Promise.all(stretches.map((s, k) => {
    const when = new Date(depart.getTime() + 1000 * tt * s.startPointIndex / pts.length);
    const a = offset; offset += allNodes[k].length;
    const mine = allLocals.then((L) => L.slice(a, a + allNodes[k].length));
    return optimiseStretch(pts, cum, allNodes[k], mine, opt, when, () => tick('Analyse des tronçons à péage…'));
  }));
  for (let k = 0; k < stretches.length; k++) {
    const res = stretchRes[k];
    if (!res) continue;
    const mw = res.options.find((x) => x.mask === 0);
    if (!mw) continue;
    const deltas = frontier(res.options.map((x) => ({ dkm: x.km - mw.km, dsec: x.sec - mw.sec, dmkm: x.mkm - mw.mkm,
      dtoll: x.toll - mw.toll, label: x.label, via: x.via, stretch: k })), 'dsec', 'dtoll');
    perStretch.push({ k, nodes: res.nodes, deltas });
  }

  const cands = [];
  const add = (label, m, kind, via = [], legs = null) => cands.push({ label, km: m.km, sec: m.sec, mkm: m.mkm, toll: m.toll, kind, via, legs });

  // combine stretch options (cartesian product of efficient options)
  let combos = [[]];
  for (const ps of perStretch) {
    const next = [];
    for (const c of combos) for (const dlt of ps.deltas) next.push([...c, dlt]);
    combos = next.length > 20000 ? next.slice(0, 20000) : next;
  }
  for (const combo of combos) {
    const lab = combo.filter((c) => c.label !== 'autoroute').map((c) => c.label);
    const txt = lab.join(' + ');
    add(txt ? txt.charAt(0).toUpperCase() + txt.slice(1) : 'Le plus rapide (autoroute)', {
      km: base.km + combo.reduce((a, c) => a + c.dkm, 0), sec: base.sec + combo.reduce((a, c) => a + c.dsec, 0),
      mkm: base.mkm + combo.reduce((a, c) => a + c.dmkm, 0), toll: base.toll + combo.reduce((a, c) => a + c.dtoll, 0),
    }, 'corridor', combo.flatMap((c) => c.via));
  }

  // escape routes: motorway to X then free roads (or the reverse) -> national roads (e.g. N10)
  const jobs = [];
  for (const ps of perStretch) {
    const inner = ps.nodes.slice(1, -1);
    const Xs = await resolveLocals(inner.map((nd) => pts[nd.idx]), inner.map((nd) => nd.local));
    for (let i = 0; i < inner.length; i++) {
      const X = Xs[i];
      if (!X) continue;
      const nm = cleanName(inner[i].name);
      for (const kind of ['sortie', 'entrée']) {
        jobs.push(Promise.all([
          route(o, X, { ...opt, avoidTolls: kind === 'entrée' }).then((r) => { tick('Sorties et routes nationales…'); return r; }),
          route(X, d, { ...opt, avoidTolls: kind === 'sortie' }).then((r) => { tick('Sorties et routes nationales…'); return r; }),
        ]).then(([a, b]) => {
          if (!a.length || !b.length) return;
          const e = evaluateLegs([a[0], b[0]], depart);
          if (e.unpriced) return;
          e.sec += TRANSITION_SEC;
          const label = kind === 'sortie' ? `Autoroute jusqu'à ${nm}, puis routes gratuites` : `Routes gratuites jusqu'à ${nm}, puis autoroute`;
          const fp = routePoints(kind === 'sortie' ? b[0] : a[0]);
          add(label, e, 'escape', [X, fp[Math.floor(fp.length / 2)]]);
        }));
      }
    }
  }
  const freeJob = route(o, d, { ...opt, avoidTolls: true });
  await Promise.all(jobs);
  routes.slice(1).forEach((r, i) => {
    const e = evaluateLegs([r], depart);
    const rp = routePoints(r);
    if (!e.unpriced) add(`Alternative TomTom ${i + 1}`, e, 'tomtom', [rp[Math.floor(rp.length / 3)], rp[Math.floor(2 * rp.length / 3)]]);
  });
  onProgress(0.97, 'Itinéraire sans péage…');
  const free = await freeJob;
  if (free.length) {
    const fp = routePoints(free[0]);
    add('Sans péage', evaluateLegs([free[0]], depart), 'free', [fp[Math.floor(fp.length / 3)], fp[Math.floor(2 * fp.length / 3)]]);
  }

  for (const c of cands) {
    Object.assign(c, energy(c, v));
    c.cost = c.toll + c.energy;
    c.min = c.sec / 60 + c.chargeMin;
  }
  let ref = cands.find((c) => c.label === 'Le plus rapide (autoroute)');
  if (!ref) {                       // tolls of the fastest route could not all be split: use it as is
    ref = { label: 'Le plus rapide (autoroute)', km: base.km, sec: base.sec, mkm: base.mkm, toll: base.toll, kind: 'corridor', via: [] };
    Object.assign(ref, energy(ref, v)); ref.cost = ref.toll + ref.energy; ref.min = ref.sec / 60 + ref.chargeMin;
    cands.push(ref);
  }
  ref.isRef = true;
  // efficient routes, keeping the fastest route as reference (only cheaper routes are worth showing)
  let eff = frontier(cands.filter((c) => c === ref || c.cost < ref.cost - 0.05), 'min', 'cost');
  if (!eff.includes(ref)) eff = [ref, ...eff].sort((a, b) => a.min - b.min);
  rate(eff, ref);
  onProgress(1, 'Terminé');
  return { eff, count: cands.length, fastest, base };
}

// best compromise, free wins, ladder
function rate(eff, f0) {
  const cheapest = eff.reduce((a, b) => (b.cost < a.cost ? b : a));
  const S = f0.cost - cheapest.cost, T = Math.max(...eff.map((e) => e.min)) - f0.min;
  let best = null, bs = -9;
  for (const e of eff) {
    e.dMin = e.min - f0.min; e.save = f0.cost - e.cost;
    e.pSave = S > 0 ? e.save / S : 0; e.pTime = T > 0 ? e.dMin / T : 0;
    e.score = e.pSave - e.pTime;
    e.freeWin = e !== f0 && e.dMin <= 3 && e.save >= 1;
    if (e.score > bs && e.pSave > 0 && e.pSave < 1) { bs = e.score; best = e; }
  }
  if (best) best.best = true;
}

export function ladder(eff, budgets = [5, 10, 15, 20, 30, 45, 60, 90]) {
  return budgets.map((b) => {
    const ok = eff.filter((e) => e.dMin <= b);
    const e = ok.reduce((a, x) => (x.cost < a.cost ? x : a));
    return { budget: b, route: e };
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
