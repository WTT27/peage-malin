// e-208 "En route" check (D-037): while driving a planned trip, the battery read from the car is compared with the
// road still ahead. Used by the phone (display) and by the home computer (car/poll.mjs → alerts on the phone).
// No position is used: progress along the planned route = odometer now − odometer at departure.
//
// Rule asked by Thomas: never claim plenty of margin because the last km were cheap country roads when the motorway is
// ahead. So consumption is tracked separately for motorway and other roads (the planned route says which km are
// motorway). Good news only counts for the same kind of road; bad news (cold, wind, speed) is applied to both.
import { cumulative } from './geo.js';

const SAFE_EXTRA = 5;          // % above the reserve for "marge OK"
const MW_MIN_KM = 25;          // motorway km driven before the measured motorway figure is used
const OTHER_MIN_KM = 15;
const WINDOW_KM = 60;          // measurement over the most recent km of each kind of road
const dec1 = (x) => x.toFixed(1).replace('.', ',');

// ---------- profile of a planned trip (built on the phone when "Suivre ma batterie" is pressed) ----------
// line: [[lat, lon]] (~1 point per km), mw: true per point on a motorway, routeKm: route length, plan: charging plan
// (stops with posKm), stations: [{posKm, name, kw}] fast chargers along the route, P: {batt, reserve, target, kM, kO}
export function buildProfile({ line, mw, routeKm, plan, stations, P, label }) {
  const cum = cumulative(line), scale = routeKm / (cum[cum.length - 1] || routeKm);
  const segs = [];
  for (let i = 1; i < line.length; i++) {
    const a = +(cum[i - 1] * scale).toFixed(1), b = +(cum[i] * scale).toFixed(1), m = mw && mw[i] && mw[i - 1] ? 1 : 0;
    if (b <= a) continue;
    const last = segs[segs.length - 1];
    if (last && last[2] === m) last[1] = b; else segs.push([a, b, m]);
  }
  // runs shorter than 1 km (interchanges) are merged into the previous one: keeps the profile small
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && (s[1] - s[0] < 1 || last[2] === s[2])) last[1] = s[1]; else merged.push([...s]);
  }
  const short = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 32);
  const stops = (plan?.ok ? plan.stops : []).map((s) => [+s.posKm.toFixed(1), short(`${s.brand} ${s.name || ''}`), s.arrivePct, s.leavePct]);
  // stations: at most one per 8 km (the most powerful, then the closest to the road), keeps the message small
  const st = [];
  for (const s of [...stations].sort((x, y) => x.posKm - y.posKm)) {
    const last = st[st.length - 1];
    if (last && s.posKm - last.pos < 8) { if (s.kw > last.kw) Object.assign(last, { name: s.name, kw: s.kw }); continue; }
    st.push({ pos: s.posKm, name: s.name, kw: s.kw });
  }
  return {
    v: 1, label: short(label), total: +routeKm.toFixed(1), segs: merged, stops,
    st: st.map((s) => [+s.pos.toFixed(1), short(s.name), Math.round(s.kw)]),
    batt: P.batt, reserve: Math.round(P.reserve * 100), target: Math.round(P.target * 100),
    kM: +P.kM.toFixed(1), kO: +P.kO.toFixed(1),
  };
}

// km of motorway between a and b (km from departure)
function mwKm(p, a, b) {
  let m = 0;
  for (const [x, y, w] of p.segs) if (w) m += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return m;
}
// kWh needed from a to b with motorway / other rates (kWh/100 km); beyond the end of the route: motorway rate
function energy(p, a, b, rM, rO) {
  if (b <= a) return 0;
  const end = Math.min(b, p.total), m = a < end ? mwKm(p, a, end) : 0, o = Math.max(0, end - a) - m;
  return (m * rM + o * rO + Math.max(0, b - Math.max(a, p.total)) * rM) / 100;
}
// km that can be driven from a with e kWh
function reach(p, a, e, rM, rO) {
  let x = a, left = e;
  for (const [s0, s1, w] of p.segs) {
    if (s1 <= x) continue;
    const from = Math.max(x, s0), r = (w ? rM : rO) / 100, need = (s1 - from) * r;
    if (need >= left) return from + left / r - a;
    left -= need; x = s1;
  }
  return x + left / (rM / 100) - a;
}

// ---------- measurement on the trip itself ----------
// pts: car readings since departure [{km (odometer), level (%), at}], oldest first. Each stretch between two readings
// (no charge in between) is shared between motorway and other roads by the planned route; the most recent WINDOW_KM
// of each are kept.
function measure(p, startKm, pts, windowKm = WINDOW_KM) {
  const out = { mw: { km: 0, kwh: 0 }, other: { km: 0, kwh: 0 } };
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    if (b.level > a.level) continue;                      // charged in between
    const da = a.km - startKm, db = b.km - startKm, len = db - da;
    if (len < 0.3) continue;
    const kwh = (a.level - b.level) / 100 * p.batt;
    const m = mwKm(p, Math.max(0, da), Math.min(p.total, db)), o = Math.max(0, len - m);
    const eM = m * p.kM, eO = o * p.kO, tot = eM + eO || 1;    // energy shared out as the plan expects it
    if (out.mw.km < windowKm && m > 0) { out.mw.km += m; out.mw.kwh += kwh * eM / tot; }
    if (out.other.km < windowKm && o > 0) { out.other.km += o; out.other.kwh += kwh * eO / tot; }
    if (out.mw.km >= windowKm && out.other.km >= windowKm) break;
  }
  return out;
}
// whole trip, at the end: real consumption on motorway and on other roads (from battery % drops), kept for future plans
export function tripTotals(trip, pts) {
  const m = measure(trip.profile, trip.startKm, pts, Infinity);
  const r = (g) => (g.km >= 5 ? +(g.kwh / g.km * 100).toFixed(1) : null);
  return { mwKm: Math.round(m.mw.km), mwKwh100: r(m.mw), otherKm: Math.round(m.other.km), otherKwh100: r(m.other) };
}
// rates used for the road ahead: measured on the same kind of road when enough km were driven; a measured figure lower
// than planned counts at most −10 % (a 1 % battery step is ~0.5 kWh); higher than planned counts in full, and is also
// applied to the other kind of road while that one is not measured yet.
function rates(p, meas) {
  const mM = meas.mw.km >= MW_MIN_KM ? meas.mw.kwh / meas.mw.km * 100 : null;
  const mO = meas.other.km >= OTHER_MIN_KM ? meas.other.kwh / meas.other.km * 100 : null;
  const use = (plan, m, kmDone) => {
    if (m == null) return plan;
    if (m >= plan) return m;
    const w = Math.min(1, kmDone / WINDOW_KM);
    return Math.max(0.9 * plan, plan + w * (m - plan));
  };
  let rM = use(p.kM, mM, meas.mw.km), rO = use(p.kO, mO, meas.other.km);
  if (mM == null && mO != null && mO > p.kO) rM = p.kM * mO / p.kO;
  if (mO == null && mM != null && mM > p.kM) rO = p.kO * mM / p.kM;
  return { rM, rO, mM, mO };
}

// ---------- the check ----------
// trip: {profile, startKm, startLevel, startAt}; pts: readings since departure (the first one may be the departure)
export function evaluate(trip, pts) {
  const p = trip.profile, cur = pts[pts.length - 1];
  if (!cur || cur.level == null || cur.km == null) return null;
  const all = [{ km: trip.startKm, level: trip.startLevel, at: trip.startAt }, ...pts.filter((x) => x.km != null && x.level != null)];
  const d = Math.min(p.total, Math.max(0, cur.km - trip.startKm));
  const meas = measure(p, trip.startKm, all);
  const { rM, rO, mM, mO } = rates(p, meas);
  const B = p.batt, now = cur.level / 100 * B, resKwh = p.reserve / 100 * B;
  const pctAt = (pos) => (now - energy(p, d, pos, rM, rO)) / B * 100;
  const left = p.total - d;
  const rangeKm = Math.max(0, reach(p, d, now - resKwh, rM, rO));

  const nextStop = p.stops.find((s) => s[0] > d + 0.5);
  const goal = nextStop ? { pos: nextStop[0], name: nextStop[1], planPct: nextStop[2], stop: true }
    : { pos: p.total, name: 'l\'arrivée', planPct: null, stop: false };
  const arr = pctAt(goal.pos);
  const safe = Math.max(p.reserve + SAFE_EXTRA, goal.stop ? 0 : p.target);
  // a plan that deliberately arrives at a charger with 10–12 % is fine while the car does at least as well as planned
  const onPlan = goal.planPct != null && arr >= goal.planPct - 2 && arr >= p.reserve + 1;
  const level = arr >= safe || onPlan ? 'ok' : arr >= p.reserve ? 'juste' : 'non';
  const stations = p.st.filter((s) => s[0] > d + 1).map((s) => ({ pos: s[0], name: s[1], kw: s[2], pct: pctAt(s[0]) }));
  let rec = null;
  if (level === 'non') rec = stations.filter((s) => s.pos < goal.pos && s.pct >= p.reserve).pop() || null;
  if (level === 'juste') rec = stations.filter((s) => s.pos < goal.pos - 5 && s.pct >= p.reserve + SAFE_EXTRA).pop() || null;

  // ahead of plan: the next planned stop may no longer be needed
  let skip = null;
  if (level === 'ok' && goal.stop) {
    const after = p.stops.find((s) => s[0] > goal.pos + 0.5);
    const g2 = after ? { pos: after[0], name: after[1], safe: p.reserve + SAFE_EXTRA } : { pos: p.total, name: 'l\'arrivée', safe: Math.max(p.reserve + SAFE_EXTRA, p.target) };
    const a2 = pctAt(g2.pos);
    if (a2 >= g2.safe) skip = { name: g2.name, pct: a2 };
  }
  // slowing down: −10 % consumption per 10 km/h less on the motorway (rough)
  let slow = '';
  if (level !== 'ok') {
    const needE = energy(p, d, goal.pos, rM, rO) + (safe - p.reserve) / 100 * B * (level === 'juste' ? 1 : 0), have = now - resKwh;
    const f = have / (needE || 1), mwAhead = mwKm(p, d, goal.pos) / Math.max(1, goal.pos - d);
    if (mwAhead > 0.5 && f >= 0.88 && f < 1) slow = 'En roulant à 100 km/h au lieu de 110 sur l\'autoroute, ça devrait passer (estimation).';
    else if (mwAhead > 0.5 && f >= 0.78 && f < 1) slow = 'En roulant à 90 km/h sur l\'autoroute, ça pourrait passer (estimation).';
  }

  const r0 = (x) => Math.round(x);
  const where = (pos) => `dans ${r0(pos - d)} km`;
  const title = level === 'ok' ? '✅ Marge suffisante' : level === 'juste' ? '⚠️ Marge juste' : '🛑 Batterie insuffisante';
  const lines = [];
  const arrTxt = arr >= 1 ? `arrivée ≈ ${r0(arr)} %` : `vous n'y arriverez pas (batterie vide ≈ ${r0(Math.max(0, goal.pos - d - reach(p, d, now, rM, rO)))} km avant)`;
  lines.push(goal.stop
    ? `Prochaine recharge : ${goal.name}, ${where(goal.pos)} → ${arrTxt}${goal.planPct != null ? ` (prévu ${goal.planPct} %)` : ''}`
    : `Arrivée ${where(goal.pos)} → ${arrTxt}${p.target > p.reserve && arr >= 1 ? ` (souhaité ${p.target} %)` : ''}`);
  if (rec) lines.push(`👉 ${level === 'non' ? 'Rechargez' : 'Plus sûr : rechargez'} à ${rec.name} (${rec.kw} kW), ${where(rec.pos)} → arrivée ≈ ${r0(rec.pct)} %`);
  else if (level === 'non') lines.push('👉 Aucune borne rapide atteignable sur la route prévue avant la réserve : ralentissez et cherchez une borne proche.');
  if (slow) lines.push(slow);
  if (skip) lines.push(`Vous êtes en avance : la recharge à ${goal.name} n'est plus nécessaire pour atteindre ${skip.name} (≈ ${r0(skip.pct)} %).`);
  lines.push(`Autonomie sur la route à venir : ${r0(rangeKm)} km jusqu'à ${p.reserve} %${rangeKm > left + 1 ? ` (il reste ${r0(left)} km)` : ''}`);
  lines.push(`Conso autoroute : ${dec1(rM)} kWh/100 km ${mM != null ? `(mesurée sur ${r0(meas.mw.km)} km)` : rM > p.kM + 0.05 ? '(prévue, relevée car plus forte ailleurs)' : '(prévue, pas encore mesurée sur autoroute)'}`
    + ` · autres routes ${dec1(rO)} ${mO != null ? `(mesurée sur ${r0(meas.other.km)} km)` : '(prévue)'}`);
  lines.push(`🔋 ${cur.level} % · ${r0(d)} km faits sur ${r0(p.total)}`);
  return { level, title, lines, rec: rec?.name || null, arr: r0(arr), goal: goal.name, rangeKm: r0(rangeKm), d: r0(d), left: r0(left),
    rM: +rM.toFixed(1), rO: +rO.toFixed(1), mwMeasured: mM != null, done: left < 1.5 };
}

