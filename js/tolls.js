// Toll engine (port of tools/toll_engine.py)
import { km, cumulative, routePoints, bbox, inBox } from './geo.js';

let D = null; // data
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const R_END = 3.0;

export async function loadTolls(url = 'data/tolls.json') {
  D = await (await fetch(url)).json();
  D.st = D.stations.map(([op, name, points, locals], i) => ({ id: i, op, name, points, locals: locals || [] }));
  D.fx = D.fixed.map(([op, name, price, points], i) => ({ id: 'F' + i, op, name, price, points, fixed: true }));
  return D;
}
export const tollData = () => D;

function price(op, a, b) {
  const t = D.prices[op];
  if (!t) return null;
  const v = t[`${a}|${b}`] ?? t[`${b}|${a}`];
  return v === undefined ? null : v;
}

function near(pt, radius) {
  const out = [];
  for (const s of D.st) {
    let d = Infinity;
    for (const p of s.points) d = Math.min(d, km(pt, p));
    if (d <= radius) out.push([d, s]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

// ---- Duplex A86 (time-dependent) ----
function duplexPrice(poly, when) {
  const dx = D.duplex, portals = dx.portals;
  const closest = (pt) => Object.keys(portals).reduce((b, k) => (km(pt, portals[k]) < km(pt, portals[b]) ? k : b));
  const a = closest(poly[0]), b = closest(poly[poly.length - 1]);
  if (km(poly[0], portals[a]) > 2 || km(poly[poly.length - 1], portals[b]) > 2 || a === b) return null;
  const t = dx.tables[`${a}|${b}`];
  if (!t) return { missing: true, label: `Duplex A86 ${a}→${b} (sens non encodé)` };
  const iso = localDay;
  const day = iso(when), tomorrow = iso(new Date(when.getTime() + 86400000));
  const wd = (when.getDay() + 6) % 7; // 0 = Monday
  let row;
  if (dx.holidays_2026.includes(day) || wd === 6) row = 'sun';
  else if (when.getMonth() === 7) row = 'august';
  else if (wd === 5) row = 'sat';
  else if (wd === 4 || dx.holidays_2026.includes(tomorrow)) row = 'fri';
  else row = 'mon_thu';
  let h = when.getHours() + when.getMinutes() / 60;
  if (h < 6) h += 24;
  let i = 0;
  while (i + 1 < t.slots.length && t.slots[i + 1] <= h) i++;
  return { price: t[row][i], label: `Duplex A86 ${a}→${b}` };
}

function fixedPrice(f, when) {
  if (/MONTESSON/i.test(f.name)) {
    const wd = (when.getDay() + 6) % 7;
    const h = when.getHours() + when.getMinutes() / 60;
    if (wd < 5 && !D.duplex.holidays_2026.includes(localDay(when)) && ((h >= 10 && h < 16) || h >= 21 || h < 6)) return 6.6;
  }
  return f.price;
}

// stations close to pts[lo..hi]: Map(station -> {d, pos})
function locate(pts, cum, lo, hi, maxd = 0.8) {
  const seg = pts.slice(lo, hi);
  const out = new Map();
  if (!seg.length) return out;
  const bx = bbox(seg);
  for (const s of D.st.concat(D.fx)) {
    for (const p of s.points) {
      if (!inBox(p, bx)) continue;
      let best = Infinity, bi = 0;
      for (let i = 0; i < seg.length; i += 2) {
        const d = km(p, seg[i]);
        if (d < best) { best = d; bi = i; }
      }
      if (best <= maxd && (!out.has(s) || best < out.get(s).d)) out.set(s, { d: best, pos: cum[lo + bi] });
    }
  }
  return out;
}

export function priceSection(pts, cum, i0, i1, when) {
  const poly = pts.slice(i0, i1 + 1);
  const dp = duplexPrice(poly, when);
  if (dp && !dp.missing) return { price: dp.price, details: [{ op: 'COFIROUTE', from: dp.label, to: '', price: dp.price }] };
  const s0 = cum[i0], s1 = cum[i1];
  let lo = i0; while (lo > 0 && cum[lo] >= s0 - 6) lo--;
  let hi = i1; while (hi < pts.length - 1 && cum[hi] <= s1 + 6) hi++;
  const nearM = locate(pts, cum, lo, hi + 1);
  const ins = [], outs = [], inner = [];
  for (const [s, { d, pos }] of nearM) {
    if (s.fixed) continue;
    if (pos >= s0 - 6 && pos <= Math.min(s1, s0 + 15)) ins.push([s, d, pos]);
    if (pos >= Math.max(s0, s1 - 15) && pos <= s1 + 6) outs.push([s, d, pos]);
    if (pos >= s0 && pos <= s1 && d < 0.6) inner.push([s, d, pos]);
  }
  if (i0 === 0) for (const [d, s] of near(pts[0], R_END)) if (!ins.some((x) => x[0] === s)) ins.push([s, d, s0]);
  if (i1 >= pts.length - 1) for (const [d, s] of near(pts[pts.length - 1], R_END)) if (!outs.some((x) => x[0] === s)) outs.push([s, d, s1]);

  let best = null;
  for (const [si, di, pi] of ins) for (const [so, dO, po] of outs) {
    if (si.op !== so.op || si === so || po <= pi) continue;
    const p = price(si.op, si.id, so.id);
    if (p === null) continue;
    const score = Math.abs(pi - s0) + Math.abs(po - s1) + 3 * (di + dO);
    if (!best || score < best.score) best = { score, price: p, details: [{ op: si.op, from: si.name, to: so.name, price: p }] };
  }
  if (best) return best;
  // operator boundary
  for (const [si, di, pi] of ins) for (const [so, dO, po] of outs) {
    if (si.op === so.op) continue;
    for (const [sx, , px] of inner) {
      if (sx.op !== si.op || px <= pi) continue;
      const p1 = price(si.op, si.id, sx.id);
      if (p1 === null) continue;
      for (const [sy, , py] of inner) {
        if (sy.op !== so.op || Math.abs(py - px) > 3 || py >= po) continue;
        const p2 = price(so.op, sy.id, so.id);
        if (p2 === null) continue;
        const score = Math.abs(pi - s0) + Math.abs(po - s1) + 3 * (di + dO) + Math.abs(py - px);
        if (!best || score < best.score) best = { score, price: p1 + p2, details: [
          { op: si.op, from: si.name, to: sx.name, price: p1 }, { op: so.op, from: sy.name, to: so.name, price: p2 }] };
      }
    }
  }
  if (best) return best;
  const bars = [...nearM].filter(([s, v]) => s.fixed && v.pos >= s0 - 1 && v.pos <= s1 + 1 && v.d < 0.3).sort((a, b) => a[1].pos - b[1].pos);
  if (bars.length) {
    const details = bars.map(([s]) => ({ op: s.op, from: s.name, to: '(barrière)', price: fixedPrice(s, when) }));
    return { price: details.reduce((a, x) => a + x.price, 0), details };
  }
  return { price: null, details: [] };
}

// Price a TomTom route object. Returns {toll, details, unpriced}
export function priceRoute(route, depart) {
  const pts = routePoints(route), cum = cumulative(pts);
  const tt = route.summary.travelTimeInSeconds;
  let toll = 0, unpriced = 0;
  const details = [];
  for (const s of route.sections || []) {
    if (s.sectionType !== 'TOLL_ROAD') continue;
    const i0 = s.startPointIndex, i1 = s.endPointIndex;
    if (cum[i1] - cum[i0] < 1.5 && (i0 === 0 || i1 >= pts.length - 1)) continue; // snapping artefact
    const when = new Date(depart.getTime() + 1000 * tt * i0 / Math.max(1, pts.length - 1));
    const r = priceSection(pts, cum, i0, i1, when);
    if (r.price === null) unpriced++;
    else { toll += r.price; details.push(...r.details); }
  }
  return { toll, details, unpriced };
}

export function stationsNear(pts, cum, i0, i1) {
  // priced stations lying on pts[i0..i1] (for the optimizer): [{pos, idx, name}]
  const seg = pts.slice(i0, i1 + 1);
  const bx = bbox(seg.filter((_, i) => i % 20 === 0), 0.05, 0.05);
  const found = [];
  for (const s of D.st) {
    for (const p of s.points) {
      if (!inBox(p, bx)) continue;
      let best = Infinity, bi = 0;
      for (let k = 0; k < seg.length; k += 2) {
        const d = km(p, seg[k]);
        if (d < best) { best = d; bi = k; }
      }
      if (best < 0.4) { found.push({ pos: cum[i0 + bi], idx: i0 + bi, name: s.name, local: s.locals[s.points.indexOf(p)] || null }); break; }
    }
  }
  return found.sort((a, b) => a.pos - b.pos);
}

// precomputed ordinary-road point of the closest station (within maxKm), or null
export function nearestLocal(pt, maxKm = 3) {
  let best = null, bd = maxKm;
  for (const s of D.st) s.points.forEach((p, i) => {
    const l = s.locals[i];
    if (!l) return;
    const d = km(pt, p);
    if (d < bd) { bd = d; best = l; }
  });
  return best;
}

// Built-in ordinary-road point near a motorway point (precomputed from OpenStreetMap), or null
export function builtinLocal(pt, maxKm = 4) {
  let best = null, bd = Infinity;
  for (const s of D.st) {
    for (let i = 0; i < s.points.length; i++) {
      const l = s.local[i];
      if (!l) continue;
      const d = km(pt, s.points[i]);
      if (d < bd) { bd = d; best = l; }
    }
  }
  return bd <= maxKm ? best : null;
}
