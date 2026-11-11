// Elevation and wind along a route (D-041), shared by the phone (route plans, "Suivre ma batterie") and the home computer
// (wind refreshed during a followed trip). Free services, no key: Open-Meteo elevation (90 m terrain model) and forecast.
//
// Energy on top of the flat, calm-air consumption (kWh), e-208:
//   climbing:   m·g·Δh / 0.9          descending: − m·g·|Δh| × 0.75 (regeneration and less motor work)
//   wind:       ½·ρ·CdA·((v + h)² − v²) × distance / 0.9, h = headwind at car height (0.7 × the 10 m wind)
// First check (2026-11-11, same 79 km route both ways at 14 °C): 103 m of climb and 13 km/h of west wind give
// ≈ 3.9 kWh/100 km of difference between the two directions; measured 3.7.
import { cumulative } from './geo.js';

const M = 1540, G = 9.81, CDA = 0.64, RHO = 1.2, ETA = 0.9, REGEN = 0.75, HGT = 0.7;
const J2KWH = 1 / 3.6e6;
const rad = (x) => x * Math.PI / 180;
const r1 = (x) => Math.round(x * 10) / 10;

function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// points every `step` km along the line (positions in route km), with the motorway flag of the line there
function resample(line, routeKm, lineMw, step) {
  const cum = cumulative(line), scale = routeKm / (cum[cum.length - 1] || routeKm), out = [];
  let j = 1;
  for (let pos = 0; pos <= routeKm + 1e-6; pos += step) {
    const x = pos / scale;
    while (j < cum.length - 1 && cum[j] < x) j++;
    const t = cum[j] > cum[j - 1] ? Math.min(1, Math.max(0, (x - cum[j - 1]) / (cum[j] - cum[j - 1]))) : 0;
    const a = line[j - 1], b = line[j];
    out.push({ pos, p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], mw: !!(lineMw && lineMw[j] && lineMw[j - 1]) });
  }
  if (out[out.length - 1].pos < routeKm - 0.05) out.push({ pos: routeKm, p: line[line.length - 1], mw: out[out.length - 1].mw });
  return out;
}

async function elevations(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 100) {
    const part = pts.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${part.map((q) => q.p[0].toFixed(4)).join(',')}`
      + `&longitude=${part.map((q) => q.p[1].toFixed(4)).join(',')}`;
    const j = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
    if (!Array.isArray(j.elevation) || j.elevation.length !== part.length) throw new Error('elevation');
    out.push(...j.elevation);
  }
  return out;
}

// Terrain of a route: {step, el: cumulative climb/descent energy (kWh) at each step, hd: heading of each step (°),
// mw: '0'/'1' per step, wp: wind sample points [[pos, lat, lon]] (≤ 10, rounded to 0.1°)}. null if offline.
export async function buildTerrain(line, routeKm, lineMw) {
  try {
    const step = routeKm > 400 ? 2 : 1;
    const pts = resample(line, routeKm, lineMw, step);
    const h = await elevations(pts);
    const hs = h.map((x, i) => [h[i - 1] ?? x, x, h[i + 1] ?? x].sort((a, b) => a - b)[1]);   // median of 3: bridges, cuttings
    const el = [0], hd = [], mw = [];
    for (let i = 1; i < pts.length; i++) {
      const dh = hs[i] - hs[i - 1];
      el.push(el[i - 1] + (dh > 0 ? M * G * dh / ETA : -M * G * -dh * REGEN) * J2KWH);
      hd.push(Math.round(bearing(pts[i - 1].p, pts[i].p)));
      mw.push(pts[i].mw ? '1' : '0');
    }
    const n = Math.min(10, Math.max(2, Math.round(routeKm / 40) + 1)), wp = [];
    for (let k = 0; k < n; k++) { const q = pts[Math.round(k * (pts.length - 1) / (n - 1))]; wp.push([Math.round(q.pos), r1(q.p[0]), r1(q.p[1])]); }
    return { step, total: +routeKm.toFixed(1), el: el.map((x) => +x.toFixed(3)), hd, mw: mw.join(''), wp };
  } catch { return null; }
}

// coarser copy for the trip profile sent to the home computer (message ≤ 4 kB)
export function coarsen(t, maxPts = 100) {
  if (!t) return null;
  const k = Math.max(1, Math.ceil(t.hd.length / maxPts)), el = [], hd = [], mw = [];
  for (let i = 0; i < t.hd.length; i += k) {
    let sx = 0, sy = 0, m = 0, n = 0;
    for (let j = i; j < Math.min(t.hd.length, i + k); j++) { sx += Math.cos(rad(t.hd[j])); sy += Math.sin(rad(t.hd[j])); m += +t.mw[j]; n++; }
    el.push(+t.el[i].toFixed(2)); hd.push(Math.round(((Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360) / 5) * 5); mw.push(m * 2 >= n ? '1' : '0');
  }
  el.push(+t.el[t.el.length - 1].toFixed(2));
  return { step: t.step * k, total: t.total, el, hd, mw: mw.join(''), wp: t.wp };
}

// wind forecast at the sample points at the time the car passes there: [[pos, speed m/s, from °]]
// depart: Date, kmh: average speed for the timing. Up to 15 days ahead; [] when unknown.
export async function fetchWinds(wp, depart, kmh = 90, fromPos = 0) {
  if (!wp?.length) return [];
  const days = (depart - Date.now()) / 86400e3;
  if (days < -0.5 || days > 15) return [];
  try {
    const t0 = depart.getTime(), passAt = wp.map(([pos]) => t0 + Math.max(0, pos - fromPos) / kmh * 3600e3);
    const d0 = new Date(Math.min(...passAt)).toISOString().slice(0, 10), d1 = new Date(Math.max(...passAt)).toISOString().slice(0, 10);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${wp.map((w) => w[1]).join(',')}&longitude=${wp.map((w) => w[2]).join(',')}`
      + `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC&start_date=${d0}&end_date=${d1}`;
    const j = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
    const list = Array.isArray(j) ? j : [j];
    return wp.map(([pos], k) => {
      const hr = list[k]?.hourly; if (!hr) return null;
      const times = hr.time.map((s) => Date.parse(s + ':00Z'));
      let i = times.findIndex((t) => t > passAt[k]) - 1; if (i < 0) i = times.length - 1;
      return [pos, +(+hr.wind_speed_10m[i]).toFixed(1), Math.round(hr.wind_direction_10m[i])];
    }).filter((w) => w && Number.isFinite(w[1]) && Number.isFinite(w[2]));
  } catch { return []; }
}

// X(pos): extra energy (kWh) from km 0 to pos for elevation + wind; null when no terrain
export function extraFn(t, winds, maxKmh = 110) {
  if (!t) return null;
  const n = t.hd.length, wc = [0];
  for (let i = 0; i < n; i++) {
    let e = 0;
    if (winds?.length) {
      const mid = (i + 0.5) * t.step;
      const w = winds.reduce((a, b) => (Math.abs(b[0] - mid) < Math.abs(a[0] - mid) ? b : a));
      const v = (t.mw[i] === '1' ? Math.min(maxKmh, 110) : 80) / 3.6;
      const h = HGT * w[1] * Math.cos(rad(w[2] - t.hd[i]));                  // > 0: headwind
      const len = Math.min(t.step, Math.max(0, t.total - i * t.step)) * 1000;
      e = 0.5 * RHO * CDA * (Math.max(0, v + h) ** 2 - v * v) * len / ETA * J2KWH;
    }
    wc.push(wc[i] + e);
  }
  return (pos) => {
    const x = Math.max(0, Math.min(t.total, pos)) / t.step, i = Math.min(n, Math.floor(x)), f = Math.min(1, x - i);
    const at = (arr, k) => arr[Math.min(arr.length - 1, k)];
    return at(t.el, i) + f * (at(t.el, i + 1) - at(t.el, i)) + at(wc, i) + f * (at(wc, i + 1) - at(wc, i));
  };
}
