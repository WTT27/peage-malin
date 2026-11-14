// Consumption vs outside temperature (D-040), shared by the phone (route plans) and the home computer (fit on real data).
//   kWh/100 km at T = ref × (1 + s × max(0, 18 − T))
// ref = consumption when no heating is needed (18 °C and above), s = extra share per degree below 18 °C.
// The car gives the outside temperature at every reading; each trip gets the average of its readings.
export const TREF = 18;
// motorway: 18 → 20 kWh/100 km at 5 °C (Thomas's settings); town: heating costs more per km at low speed
export const DEFAULT_S = { autoroute: 0.0085, autres: 0.015, ville: 0.025 };
const MIN_KM = { autoroute: 100, autres: 150, ville: 100 };                   // measured km before the measured ref replaces the settings

export const factor = (T, s) => 1 + s * Math.max(0, TREF - T);
export const kwhAt = (m, T) => m.ref * factor(T, m.s);

// points: [{T, k (kWh/100 km), km}] → {ref, s, km, n, fitted, tmin, tmax} or null
export function fitModel(points, kind) {
  const pts = points.filter((p) => p.T != null && p.k > 3 && p.k < 60 && p.km > 0);
  const km = pts.reduce((a, p) => a + p.km, 0);
  if (!pts.length) return null;
  const refFor = (s) => pts.reduce((a, p) => a + p.km * p.k / factor(p.T, s), 0) / km;
  const err = (s) => { const r = refFor(s); return pts.reduce((a, p) => a + p.km * (p.k - r * factor(p.T, s)) ** 2, 0); };
  const tmin = Math.min(...pts.map((p) => p.T)), tmax = Math.max(...pts.map((p) => p.T));
  // the slope is learnt only with enough spread of temperatures below 18 °C and enough km; otherwise the default
  let s = DEFAULT_S[kind], fitted = false;
  if (Math.min(tmax, TREF) - tmin >= 8 && km >= 2 * MIN_KM[kind] && pts.length >= 5) {
    let best = Infinity;
    for (let x = 0; x <= 0.04 + 1e-9; x += 0.0005) { const e = err(x); if (e < best) { best = e; s = x; } }
    fitted = true;
  }
  return { ref: +refFor(s).toFixed(2), s: +s.toFixed(4), km: Math.round(km), n: pts.length, fitted, enough: km >= MIN_KM[kind],
    tmin: Math.round(tmin), tmax: Math.round(tmax) };
}

// usual temperature (°C, daytime) by month in northern France, when no forecast is available
const CLIMATE = [5, 6, 9, 12, 16, 19, 22, 22, 18, 14, 9, 6];
export const usualTemp = (date) => CLIMATE[date.getMonth()];

// forecast for the trip (Open-Meteo, free, no key): mean of departure and arrival at the departure hour.
// Positions rounded to 0.1° (~10 km). Up to 15 days ahead; otherwise the month's usual temperature.
export async function tripTemp(o, d, depart) {
  const days = (depart - Date.now()) / 86400e3;
  if (days > -1 && days < 15) {
    try {
      const r1 = (x) => Math.round(x * 10) / 10;
      const day = depart.toLocaleDateString('sv-SE');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${r1(o[0])},${r1(d[0])}&longitude=${r1(o[1])},${r1(d[1])}`
        + `&hourly=temperature_2m&timezone=Europe%2FParis&start_date=${day}&end_date=${day}`;
      const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
      const h = depart.getHours(), list = Array.isArray(j) ? j : [j];
      const ts = list.map((x) => x?.hourly?.temperature_2m?.[h]).filter((x) => typeof x === 'number');
      if (ts.length) return { T: Math.round(ts.reduce((a, b) => a + b, 0) / ts.length), src: 'prévision' };
    } catch { /* offline: usual temperature */ }
  }
  return { T: usualTemp(depart), src: 'moyenne du mois' };
}

// consumption used by a route plan at temperature T: the measured law when enough km, else the settings
// (motorway setting = summer value at 18 °C and above; other roads setting = average figure, taken at 12 °C)
export function planRates(v, T, model) {
  const sM = v.kwhMotorwayWinter > v.kwhMotorway ? (v.kwhMotorwayWinter / v.kwhMotorway - 1) / (TREF - 5) : DEFAULT_S.autoroute;
  const mw = model?.autoroute?.enough ? { ...model.autoroute, src: 'mesurée' } : { ref: v.kwhMotorway, s: sM, src: 'réglages' };
  const ot = model?.autres?.enough ? { ...model.autres, src: 'mesurée' }
    : { ref: v.kwhOther / factor(12, DEFAULT_S.autres), s: DEFAULT_S.autres, src: 'réglages' };
  return { kM: +kwhAt(mw, T).toFixed(1), kO: +kwhAt(ot, T).toFixed(1), srcM: mw.src, srcO: ot.src };
}
