// e-208 consumption as a function of speed and outside temperature (D-050), shared by the phone (route plans, live
// follow-up) and the home computer (fit on the car's readings).
//
//   kWh/100 km at speed v (km/h) and outside temperature T (°C):
//     k(v, T) = a  +  b × ρ(T) × v²  +  (p0 + h × max(0, 18 − T)) × 100 / v
//   a      : cost of each km whatever the speed (rolling, drivetrain, accelerations and braking), kWh/100 km
//   b × v² : air drag, grows with the square of the speed; ρ(T) = air density relative to 18 °C (cold air is denser)
//   p0 + h × (18 − T) : power drawn all the time, in kW (electronics, then heating below 18 °C). Per km it costs more
//            the slower you go (a 2 kW heater costs 6.7 kWh/100 km at 30 km/h, 1.8 at 110).
// b comes from the car's specs (½ ρ CdA / efficiency, CdA 0.64 m², 90 %): it is the best-known part, and the drives
// measured so far are mostly 20–110 km/h with only a few km at each speed, too little to learn it. a, p0 and h are
// learnt from the car's readings (each ~2-minute stretch: its speed, the outside temperature and the energy used),
// starting from the user's settings and moving to the measurements as km add up.
export const TREF = 18;
export const PHYS_B = 0.000914;                 // kWh/100 km per (km/h)² at 18 °C
export const rho = (T) => 291 / (273 + T);
const VMIN = 15;

export function kwh100(L, v, T) {
  const s = Math.max(VMIN, v);
  return L.a + L.b * rho(T) * s * s + (L.p0 + L.h * Math.max(0, TREF - T)) * 100 / s;
}

// settings → starting law: motorway kWh/100 km in mild weather and at 5 °C, at the usual motorway speed (vehicle
// maxSpeed, 110), other roads at 12 °C and 70 km/h; a and h fitted to those three figures, p0 = 0.4 kW
export function priorLaw(v) {
  const vM = v.maxSpeed || 110, b = PHYS_B, p0 = 0.4;
  const eq = [   // [a coef, h coef, value without a and h]
    [1, 0, (v.kwhMotorway ?? 18) - b * vM * vM - p0 * 100 / vM],
    [1, 13 * 100 / vM, (v.kwhMotorwayWinter ?? 20) - b * rho(5) * vM * vM - p0 * 100 / vM],
    [1, 6 * 100 / 70, (v.kwhOther ?? 15) - b * rho(12) * 4900 - p0 * 100 / 70],
  ];
  const [a, h] = solve(eq.map(([x, y]) => [x, y]), eq.map((e) => e[2]), [1, 1], [0, 0]);
  return clampLaw({ a, b, p0, h, src: 'réglages', km: 0 });
}
const clampLaw = (L) => ({ ...L, a: Math.min(25, Math.max(3, L.a)), p0: Math.min(2, Math.max(0.1, L.p0)), h: Math.min(0.4, Math.max(0, L.h)) });

// least squares with a pull towards a starting value per unknown: rows X (n × m), values y, weights w (per row),
// lam (pull strength per unknown), x0 (starting values). Small m: Gaussian elimination.
function solve(X, y, w, x0, lam = null) {
  const m = X[0].length, A = Array.from({ length: m }, () => new Array(m).fill(0)), r = new Array(m).fill(0);
  X.forEach((row, i) => { for (let j = 0; j < m; j++) { r[j] += (w[i] ?? 1) * row[j] * y[i]; for (let k = 0; k < m; k++) A[j][k] += (w[i] ?? 1) * row[j] * row[k]; } });
  if (lam) for (let j = 0; j < m; j++) { A[j][j] += lam[j]; r[j] += lam[j] * x0[j]; }
  for (let c = 0; c < m; c++) {
    let p = c; for (let i = c + 1; i < m; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    [A[c], A[p]] = [A[p], A[c]]; [r[c], r[p]] = [r[p], r[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let i = 0; i < m; i++) if (i !== c) { const f = A[i][c] / A[c][c]; for (let k = c; k < m; k++) A[i][k] -= f * A[c][k]; r[i] -= f * r[c]; }
  }
  return r.map((x, j) => (Math.abs(A[j][j]) < 1e-12 ? x0[j] : x / A[j][j]));
}

// measured points [{v, T, km, kwh}] (stretches grouped by speed and temperature) → law, or the starting law.
// The pull towards the starting law weighs like PRIOR_KM km of driving: with 100 km measured the result is halfway,
// with 1,000 km it is mostly the measurement. h (effect of cold) needs a spread of temperatures to be learnt: its pull
// is stronger (a few km at one temperature cannot tell heating from the rest).
const PRIOR_KM = 100;
export function fitLaw(points, prior) {
  const pts = points.filter((p) => p.km > 0 && p.v >= 10 && p.T != null && p.kwh >= 0);
  const km = pts.reduce((s, p) => s + p.km, 0);
  if (km < 30) return { ...prior, km: Math.round(km) };
  const X = [], y = [], w = [];
  for (const p of pts) {
    const s = Math.max(VMIN, p.v), k = p.kwh / p.km * 100;
    X.push([1, 100 / s, Math.max(0, TREF - p.T) * 100 / s]);
    y.push(k - prior.b * rho(p.T) * s * s);
    w.push(p.km);
  }
  // pull strengths in "km": a is in kWh/100 km; p0 and h scaled at 60 km/h and 10 °C below 18
  const lam = [PRIOR_KM, PRIOR_KM * (100 / 60) ** 2, 3 * PRIOR_KM * (1000 / 60) ** 2];
  const [a, p0, h] = solve(X, y, w, [prior.a, prior.p0, prior.h], lam);
  const temps = pts.map((p) => p.T), fast = pts.filter((p) => p.v > 95).reduce((s, p) => s + p.km, 0);
  return clampLaw({ a: +a.toFixed(2), b: prior.b, p0: +p0.toFixed(3), h: +h.toFixed(4), src: 'mesurée', km: Math.round(km),
    kmFast: Math.round(fast), tmin: Math.round(Math.min(...temps)), tmax: Math.round(Math.max(...temps)) });
}

// stretches [{v, T, km, wh}] → points grouped by 10 km/h of speed and 3 °C of temperature (speed: km / hours)
export function groupStretches(st) {
  const g = new Map();
  for (const s of st) {
    if (s.T == null || s.v < 10) continue;
    const key = `${Math.min(13, Math.floor(s.v / 10))}|${Math.round(s.T / 3)}`;
    const x = g.get(key) || { km: 0, h: 0, wh: 0, Tkm: 0 };
    x.km += s.km; x.h += s.km / s.v; x.wh += s.wh; x.Tkm += s.T * s.km;
    g.set(key, x);
  }
  return [...g.values()].map((x) => ({ v: x.km / x.h, T: x.Tkm / x.km, km: x.km, kwh: x.wh / 1000 }));
}

// highest speed (70 … vMax, km/h) at which `kmFast` km (driven at that speed) plus the rest still fit in `kwh`:
// need(v) = kmFast × k(v) × f / 100 + rest. Returns null when even 70 km/h is not enough.
export function speedFor(L, T, kmFast, kwh, rest, f = 1, vMax = 130) {
  const need = (v) => kmFast * kwh100(L, v, T) * f / 100 + rest;
  if (need(vMax) <= kwh) return vMax;
  if (need(70) > kwh) return null;
  let lo = 70, hi = vMax;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (need(m) <= kwh) lo = m; else hi = m; }
  return Math.floor(lo / 5) * 5;
}

// ---------- use by the phone ----------
// the law measured by the home computer once LAW_MIN_KM are measured (and "use my measured consumption" is ticked),
// else the starting law from the settings
export const LAW_MIN_KM = 150;
export function lawFor(v, carLaw) {
  if (carLaw && carLaw.a != null && carLaw.km >= LAW_MIN_KM && v.useMeasured !== false) return { ...carLaw, src: 'mesurée' };
  return priorLaw(v);
}
// usual speeds: motorway = measured when close to the speed limit set for route plans (maxSpeed), else that limit − 3;
// other roads = measured, else 70 km/h
export function usualSpeeds(v, carLaw) {
  const lim = v.maxSpeed || 110, m = carLaw?.vM;
  return { vM: m && Math.abs(m - lim) <= 10 ? m : lim - 3, vO: carLaw?.vO || 70 };
}
// motorway / other-road rates for a route plan at temperature T
export function planRates(v, T, carLaw) {
  const L = lawFor(v, carLaw), { vM, vO } = usualSpeeds(v, carLaw);
  return { kM: +kwh100(L, vM, T).toFixed(1), kO: +kwh100(L, vO, T).toFixed(1), vM, vO, src: L.src,
    law: { a: L.a, b: L.b, p0: +L.p0.toFixed(3), h: +L.h.toFixed(4) } };
}
