// e-208 charging: real fast chargers along a route (data.gouv.fr IRVE file, CCS >= 50 kW), battery simulated along the
// line, stops placed at real stations, charging time from the e-208 charging curve (Thomas, D-033).
import { km, cumulative } from './geo.js';

let DATA = null, GRID = null;
const CELL = 0.1;                                  // degrees
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;

export async function loadChargers() {
  if (DATA) return DATA;
  const r = await fetch('data/chargers.json');
  if (!r.ok) throw new Error('chargers');
  DATA = await r.json();
  GRID = new Map();
  DATA.s.forEach((s, i) => { const k = cellKey(s[0], s[1]); if (!GRID.has(k)) GRID.set(k, []); GRID.get(k).push(i); });
  return DATA;
}
export const chargerData = () => DATA;

// Price without subscription, paid by card (estimates, Nov 2026) when the operator publishes no clear €/kWh price.
// Anything not listed: the "Recharge rapide" price of the settings.
const NET_PRICE = { Tesla: 0.55, Ionity: 0.69, TotalEnergies: 0.59, Electra: 0.49, Fastned: 0.59, Izivia: 0.55,
  'Engie Vianeo': 0.55, 'Power Dot': 0.49, Lidl: 0.39, Carrefour: 0.49, 'E.Leclerc': 0.45, Allego: 0.59, Driveco: 0.51,
  Atlante: 0.49, Intermarché: 0.49, Auchan: 0.49, 'Super U': 0.49, Zunder: 0.55, 'bp pulse': 0.59 };

// battery power accepted by the e-208 (2022, 100 kW peak) vs state of charge, mild weather (fraction → kW)
const CURVE = [[0.2, 95], [0.45, 75], [0.6, 55], [0.75, 40], [0.85, 25], [1.01, 12]];
const curveKw = (f) => CURVE.find(([lim]) => f < lim)[1];

// minutes to charge from fraction a to fraction b of the battery
export function chargeMinutes(a, b, batteryKwh, stationKw = 100, winter = false) {
  let min = 0;
  for (let f = a; f < b - 1e-9; f += 0.01) {
    const step = Math.min(0.01, b - f);
    const kw = Math.min(curveKw(f) * (winter ? 0.8 : 1), stationKw * 0.92);
    min += step * batteryKwh / kw * 60;
  }
  return min;
}

export const isWinter = (date) => { const m = date.getMonth() + 1; return m >= 11 || m <= 3; };

// battery & charging parameters for a trip
export function evParams(v, depart, sec) {
  const batt = v.batteryKwh, winter = v.season === 'hiver' || (v.season !== 'été' && isWinter(depart));
  const reserve = (v.reservePct ?? 8) / 100;
  const target = Math.max(reserve, (v.arrivePct || 0) / 100);
  const start = Math.min(1, (v.startPct ?? 90) / 100);
  // lunch window 11:30 → 14:00
  let lunch = false;
  if (v.lunch) {
    const t0 = depart.getHours() + depart.getMinutes() / 60, t1 = t0 + sec / 3600;
    lunch = t1 > 11.5 && t0 < 14;
  }
  return { batt, winter, reserve, target, start, lunch, lunchMin: v.lunchMin ?? 45,
    kM: winter ? (v.kwhMotorwayWinter ?? 20) : v.kwhMotorway, kO: v.kwhOther };
}

// quick estimate used while searching (no charger locations): same curve, stops from the reserve level
export function quickCharge(kwh, sec, v, depart) {
  const P = evParams(v, depart, sec);
  if (v.noCharge) return { energy: kwh * v.homeEurKwh, chargeMin: 0 };
  const extra = Math.max(0, kwh - (P.start - P.target) * P.batt);
  if (extra <= 0) return { energy: kwh * v.homeEurKwh, chargeMin: 0 };
  const per = 0.8 - P.reserve, stops = Math.ceil(extra / (per * P.batt) - 1e-9);
  const each = extra / stops / P.batt;
  let min = stops * (chargeMinutes(P.reserve, P.reserve + each, P.batt, 100, P.winter) + v.stopOverheadMin + 2);
  if (P.lunch) min = Math.max(0, min - P.lunchMin);
  return { energy: (kwh - extra) * v.homeEurKwh + extra * v.fastEurKwh, chargeMin: min };
}

// fast stations within maxKm of the line, with their position along it (km, scaled to the route length)
// on a motorway only chargers right beside the road (service areas) count; elsewhere up to maxKm away
function stationsAlong(line, cum, scale, mw, maxKm = 2.5) {
  const best = new Map();
  for (let j = 0; j < line.length; j++) {
    if (j && cum[j] - cum[j - 1] < 0.2 && j % 3) continue;
    const [lat, lon] = line[j], lim = mw && mw[j] ? 0.35 : maxKm;
    // distance to the road between the previous point and this one (points can be 1–3 km apart: a service area
    // between two points must not be missed)
    const a = j ? line[j - 1] : line[j], kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
    const vx = (lon - a[1]) * kx, vy = (lat - a[0]) * ky, vv = vx * vx + vy * vy;
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
      for (const i of GRID.get(`${Math.floor(lat / CELL) + da},${Math.floor(lon / CELL) + db}`) || []) {
        const s = DATA.s[i];
        const wx = (s[1] - a[1]) * kx, wy = (s[0] - a[0]) * ky, t = vv > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv)) : 1;
        const d = Math.hypot(wx - t * vx, wy - t * vy);
        if (d > lim) continue;
        const cur = best.get(i), pos = (j ? cum[j - 1] + t * (cum[j] - cum[j - 1]) : 0) * scale;
        if (!cur || d < cur.d) best.set(i, { i, d, pos, j });
      }
    }
  }
  return [...best.values()].sort((x, y) => x.pos - y.pos);
}

// fast chargers along a route for the "En route" check: [{posKm, name, kw}] (only those right beside the road on a
// motorway, up to 2.5 km away elsewhere)
export function routeStations(line, routeKm, mw = null) {
  if (!DATA || !line || line.length < 2) return [];
  const cum = cumulative(line), scale = routeKm / (cum[cum.length - 1] || routeKm);
  return stationsAlong(line, cum, scale, mw).map((s) => { const st = DATA.s[s.i];
    return { posKm: s.pos, name: `${DATA.brands[st[4]] || ''} ${st[6] || ''}`.trim(), kw: st[2] }; });
}

// detour to reach a station that is not right on the road (both ways), minutes
const detourMin = (d) => (d <= 0.3 ? 1 : 3 + 2 * d * 1.3 / 40 * 60);

// Charging plan along a route. line: [[lat, lon]], c: {km, sec, kwh}. Returns null if the chargers file is missing.
// Small search: at each stop up to BRANCH candidate stations are tried (3 levels deep, then the best guess is kept);
// the plan with the least "charging minutes + € × MIN_PER_EUR" wins.
const BRANCH = 8, DEPTH = 3, MIN_PER_EUR = 3;
export function planCharging(line, c, v, depart, lineMw = null, X = null) {
  if (!DATA || !line || line.length < 2) return null;
  const P = evParams(v, depart, c.sec);
  const home = v.homeEurKwh;
  if (v.noCharge) return { stops: [], energy: c.kwh * home, chargeMin: 0, arrivePct: null, ok: true };
  const cum = cumulative(line), L = c.km, scale = L / (cum[cum.length - 1] || L);
  const rate = c.kwh / L, spk = c.sec / L;                 // kWh per km (average), seconds per km
  // energy used from the start to each point: motorway km at the motorway rate, other km at the other rate (D-037),
  // scaled so that the whole route uses c.kwh; E(a, b) = kWh from km a to km b
  const ek = [0];
  for (let j = 1; j < line.length; j++) ek.push(ek[j - 1] + (cum[j] - cum[j - 1]) * scale * (lineMw && lineMw[j] && lineMw[j - 1] ? P.kM : P.kO) / 100);
  const norm = c.kwh / (ek[ek.length - 1] || c.kwh);
  const eAt = (pos) => {
    const x = pos / scale;
    let lo = 0, hi = cum.length - 1;
    if (x >= cum[hi]) return ek[hi] * norm + (pos - cum[hi] * scale) * rate;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= x) lo = mid; else hi = mid; }
    const t = cum[hi] > cum[lo] ? (x - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return (ek[lo] + t * (ek[hi] - ek[lo])) * norm;
  };
  // X: elevation + wind on top (kWh from km 0, D-041); a stretch can then cost less than the flat rate, never below 0
  const E = X ? (a, b) => Math.max(0, eAt(b) - eAt(a) + X(Math.min(b, L)) - X(Math.min(a, L))) : (a, b) => Math.max(0, eAt(b) - eAt(a));
  const offRate = P.kO / 100;                              // detour to a station off the road
  const B = P.batt, t0 = depart.getHours() + depart.getMinutes() / 60;
  const priceOf = (st) => st[5] ?? NET_PRICE[DATA.brands[st[4]]] ?? v.fastEurKwh;
  let cands = null;

  // one stop at station s, arriving with the state {soc, pos, clock, lunchDone}
  // high: charge above 80–85 % (slow, but can save a whole stop: Thomas did home → Demangevelle with one long stop)
  function stopAt(s, st, high = false) {
    const arrive = st.soc - E(st.pos, s.pos) - s.d * 2 * offRate;
    const eta = t0 + (st.clock + (s.pos - st.pos) * spk) / 3600;
    const atLunch = !st.lunchDone && eta >= 11.75 && eta <= 13.75;
    const needRest = E(s.pos, L) + P.target * B + 0.02 * B + s.d * 2 * offRate;   // small margin
    const cap = (high ? 1 : atLunch ? 0.9 : needRest <= 0.85 * B ? 0.85 : 0.8) * B;
    const leave = Math.max(arrive, Math.min(needRest, cap));
    const kw = s.st[2], cmin = chargeMinutes(arrive / B, leave / B, B, kw, P.winter), dmin = detourMin(s.d);
    const full = cmin + v.stopOverheadMin + dmin;
    const counted = atLunch ? Math.max(dmin, full - P.lunchMin) : full;
    const kwh = leave - arrive, price = priceOf(s.st);
    return { stop: { name: s.st[6], brand: DATA.brands[s.st[4]], kw, points: s.st[3], p: [s.st[0], s.st[1]], posKm: s.pos,
      eta, arrivePct: Math.round(arrive / B * 100), leavePct: Math.round(leave / B * 100), kwh, price, priceKnown: s.st[5] != null,
      eur: kwh * price, min: Math.round(full), lunch: atLunch, off: s.d },
    counted, next: { soc: leave, pos: s.pos, clock: st.clock + (s.pos - st.pos) * spk + full * 60, lunchDone: st.lunchDone || atLunch } };
  }

  function solve(st, depth, n) {
    if (st.soc >= E(st.pos, L) + P.target * B - 1e-6) return { stops: [], counted: 0, eur: 0, kwh: 0, end: st, score: 0 };
    if (n >= 8) return null;
    cands = cands || stationsAlong(line, cum, scale, lineMw);
    let reach = cands.filter((s) => s.pos > st.pos + 1 && st.soc - E(st.pos, s.pos) - s.d * 2 * offRate >= P.reserve * B - 1e-6)
      .map((s) => ({ ...s, st: DATA.s[s.i] }));
    if (!reach.length) return null;
    {                                               // limited opening hours: only Mon–Sat 8:00–19:00
      const day = depart.getDay();
      reach = reach.filter((s) => {
        if (s.st[7] !== 0) return true;
        const eta = t0 + (st.clock + (s.pos - st.pos) * spk) / 3600;
        return day !== 0 && eta >= 8 && eta <= 19;
      });
      if (!reach.length) return null;
    }
    if (!st.lunchDone) {                            // lunch wanted: stop in the lunch window if one is reachable
      const lw = reach.filter((s) => { const eta = t0 + (st.clock + (s.pos - st.pos) * spk) / 3600; return eta >= 11.75 && eta <= 13.75; });
      if (lw.length) reach = lw;
    }
    // first guess (no look-ahead): far along, full-speed for the e-208, cheap, close to the road
    const far = Math.max(...reach.map((s) => s.pos));
    const guess = (s) => (far - s.pos) * 0.3 + (100 - Math.min(s.st[2], 100)) * 0.15 + priceOf(s.st) * 15 + detourMin(s.d);
    const tries = reach.sort((a, b) => guess(a) - guess(b)).slice(0, depth > 0 ? BRANCH : 1);
    let best = null;
    for (const s of tries) for (const high of [false, true]) {
      const one = stopAt(s, st, high);
      if (high && one.stop.leavePct <= 85) continue;                 // nothing more than the normal stop
      const rest = solve(one.next, depth - 1, n + 1);
      if (!rest) continue;
      const tot = { stops: [one.stop, ...rest.stops], counted: one.counted + rest.counted, eur: one.stop.eur + rest.eur,
        kwh: one.stop.kwh + rest.kwh, end: rest.end };
      tot.score = tot.counted + tot.eur * MIN_PER_EUR;
      if (!best || tot.score < best.score) best = tot;
    }
    return best;
  }

  const plan = solve({ soc: P.start * B, pos: 0, clock: 0, lunchDone: !P.lunch }, DEPTH, 0);
  if (!plan) return { stops: [], ok: false, energy: null, chargeMin: null };
  const arriveKwh = plan.end.soc - E(plan.end.pos, L);
  const homeKwh = Math.max(0, c.kwh + (X ? X(L) : 0) - plan.kwh);
  return { stops: plan.stops, ok: true, energy: homeKwh * home + plan.eur, chargeMin: plan.counted,
    arrivePct: Math.round(arriveKwh / B * 100), winter: P.winter, lunchWanted: P.lunch, extraKwh: X ? +X(L).toFixed(2) : null };
}

// add the charging stops to the Google Maps waypoints (in route order, max 9 in all; charging stops are kept first)
export function mergeStops(line, via, stopPts) {
  if (!stopPts.length) return via;
  const idx = (p) => { let bj = 0, bd = Infinity; line.forEach((q, j) => { const d = km(q, p); if (d < bd) { bd = d; bj = j; } }); return bj; };
  let all = [...via.map((p) => ({ p, j: idx(p), keep: false })), ...stopPts.map((p) => ({ p, j: idx(p), keep: true }))]
    .sort((a, b) => a.j - b.j);
  while (all.length > 9) {
    let bi = -1, bg = Infinity;
    all.forEach((x, i) => { if (x.keep) return; const g = Math.min(i ? x.j - all[i - 1].j : 1e9, i < all.length - 1 ? all[i + 1].j - x.j : 1e9); if (g < bg) { bg = g; bi = i; } });
    if (bi < 0) break;
    all.splice(bi, 1);
  }
  return all.map((x) => x.p);
}
