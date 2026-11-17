// e-208 "En route" check (D-037): while driving a planned trip, the battery read from the car is compared with the
// road still ahead. Used by the phone (display) and by the home computer (car/poll.mjs → alerts on the phone).
// No position is used: progress along the planned route = odometer now − odometer at departure.
//
// Rule asked by Thomas: never claim plenty of margin because the last km were cheap country roads when the motorway is
// ahead. So consumption is tracked separately for motorway and other roads (the planned route says which km are
// motorway). Good news only counts for the same kind of road; bad news (cold, wind, speed) is applied to both.
import { cumulative } from './geo.js';
import { coarsen, extraFn } from './terrain.js';
import { kwh100, speedFor } from './law.js';

const SAFE_EXTRA = 5;          // % above the reserve for "marge OK"
const MW_MIN_KM = 25;          // motorway km driven before the measured motorway figure is used
const OTHER_MIN_KM = 15;
const WINDOW_KM = 60;          // measurement over the most recent km of each kind of road
const dec1 = (x) => x.toFixed(1).replace('.', ',');

// ---------- profile of a planned trip (built on the phone when "Suivre ma batterie" is pressed) ----------
// line: [[lat, lon]] (~1 point per km), mw: true per point on a motorway, routeKm: route length, plan: charging plan
// (stops with posKm), stations: [{posKm, name, kw}] fast chargers along the route, P: {batt, reserve, target, kM, kO}
export function buildProfile({ line, mw, routeKm, plan, stations, P, label, terrain = null, winds = null, tPts = 100 }) {
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
    ...(terrain ? { tr: coarsen(terrain, tPts), w: winds || [] } : {}),     // elevation, headings, wind (D-041)
  };
}

// km of motorway between a and b (km from departure)
function mwKm(p, a, b) {
  let m = 0;
  for (const [x, y, w] of p.segs) if (w) m += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return m;
}
// kWh needed from a to b with motorway / other rates (kWh/100 km); beyond the end of the route: motorway rate
// X: extra energy for elevation + wind (kWh from km 0, D-041), or null
function energy(p, a, b, rM, rO, X = null) {
  if (b <= a) return 0;
  const end = Math.min(b, p.total), m = a < end ? mwKm(p, a, end) : 0, o = Math.max(0, end - a) - m;
  return (m * rM + o * rO + Math.max(0, b - Math.max(a, p.total)) * rM) / 100 + (X && a < end ? X(end) - X(a) : 0);
}
// km that can be driven from a with e kWh
function reach(p, a, e, rM, rO, X = null) {
  if (X) {                                                  // step by 0.5 km: climbs and descents change the rate
    let x = a, left = e;
    for (let k = 0; k < 4000; k++) {
      const de = energy(p, x, x + 0.5, rM, rO, X);
      if (de > 0 && de >= left) return x + 0.5 * left / de - a;
      left -= de; x += 0.5;
    }
    return x - a;
  }
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
function measure(p, startKm, pts, windowKm = WINDOW_KM, X = null) {
  const out = { mw: { km: 0, kwh: 0 }, other: { km: 0, kwh: 0 } };
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    if (b.level > a.level) continue;                      // charged in between
    const da = a.km - startKm, db = b.km - startKm, len = db - da;
    if (len < 0.3) continue;
    // battery used, minus what the climbs / wind of this stretch cost (→ flat, calm-air consumption)
    const kwh = (a.level - b.level) / 100 * p.batt - (X ? X(Math.min(p.total, Math.max(0, db))) - X(Math.min(p.total, Math.max(0, da))) : 0);
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
  if (trip.profile.free) return freeTotals(trip, pts);
  const m = measure(trip.profile, trip.startKm, pts, Infinity, extraOf(trip));
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

// elevation + wind of a trip (wind refreshed by the phone at departure and by the home computer every hour)
export function extraOf(trip) {
  const p = trip.profile;
  return p.tr ? extraFn(p.tr, trip.wind || p.w || []) : null;
}

// ---------- the check ----------
// trip: {profile, startKm, startLevel, startAt}; pts: readings since departure (the first one may be the departure)
export function evaluate(trip, pts) {
  if (trip.profile.free) return evaluateFree(trip, pts);
  const p = trip.profile, cur = pts[pts.length - 1];
  if (!cur || cur.level == null || cur.km == null) return null;
  const all = [{ km: trip.startKm, level: trip.startLevel, at: trip.startAt }, ...pts.filter((x) => x.km != null && x.level != null)];
  const d = Math.min(p.total, Math.max(0, cur.km - trip.startKm));
  const X = extraOf(trip);
  const meas = measure(p, trip.startKm, all, WINDOW_KM, X);
  const { rM, rO, mM, mO } = rates(p, meas);
  const B = p.batt, now = cur.level / 100 * B, resKwh = p.reserve / 100 * B;
  const pctAt = (pos) => (now - energy(p, d, pos, rM, rO, X)) / B * 100;
  const left = p.total - d;
  const rangeKm = Math.max(0, reach(p, d, now - resKwh, rM, rO, X));

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
  // slowing down on the motorway (D-050): highest steady speed at which the motorway km ahead still let the car reach
  // the goal with the safe margin, from the speed + temperature law scaled to what this trip measures on the motorway.
  // Older profiles without the law: rough −10 % per 10 km/h.
  let slow = '';
  if (level !== 'ok') {
    // aim: the safe margin when it is only "juste", the reserve + 2 % when the battery would not make it
    const aim = level === 'juste' ? Math.max(safe, p.reserve) : p.reserve + 2;
    const mwA = mwKm(p, d, goal.pos), have = now - aim / 100 * B;
    if (p.law && mwA > 5) {
      const vM = p.vM || 107, f = rM / kwh100(p.law, vM, p.T ?? 10);       // this trip vs the law at the usual speed
      const rest = energy(p, d, goal.pos, 0, rO, X);                         // other roads + climbs / wind
      const v = speedFor(p.law, p.T ?? 10, mwA, have, rest, f, vM);
      if (v != null && v < vM) slow = `👉 En roulant à ${v} km/h au lieu de ${vM} sur les ${Math.round(mwA)} km d'autoroute restants, vous arrivez avec ≈ ${Math.round(aim)} % (≈ +${Math.max(1, Math.round(mwA * (60 / v - 60 / vM)))} min).`;
      else if (v == null && level === 'non') slow = 'Même à 70 km/h sur l\'autoroute, la marge ne suffit pas : rechargez.';
    } else if (!p.law) {
      const needE = energy(p, d, goal.pos, rM, rO, X) + (safe - p.reserve) / 100 * B * (level === 'juste' ? 1 : 0), have0 = now - resKwh;
      const f = have0 / (needE || 1), mwAhead = mwA / Math.max(1, goal.pos - d);
      if (mwAhead > 0.5 && f >= 0.88 && f < 1) slow = 'En roulant à 100 km/h au lieu de 110 sur l\'autoroute, ça devrait passer (estimation).';
      else if (mwAhead > 0.5 && f >= 0.78 && f < 1) slow = 'En roulant à 90 km/h sur l\'autoroute, ça pourrait passer (estimation).';
    }
  }

  const r0 = (x) => Math.round(x);
  const where = (pos) => `dans ${r0(pos - d)} km`;
  const title = level === 'ok' ? '✅ Marge suffisante' : level === 'juste' ? '⚠️ Marge juste' : '🛑 Batterie insuffisante';
  const lines = [];
  const arrTxt = arr >= 1 ? `arrivée ≈ ${r0(arr)} %` : `vous n'y arriverez pas (batterie vide ≈ ${r0(Math.max(0, goal.pos - d - reach(p, d, now, rM, rO, X)))} km avant)`;
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
  if (X) {
    const ex = X(goal.pos) - X(d);
    if (Math.abs(ex) >= 0.4) lines.push(`Relief et vent jusqu'à ${goal.stop ? 'la recharge' : 'l\'arrivée'} : ${ex > 0 ? '+' : '−'}${dec1(Math.abs(ex))} kWh (≈ ${ex > 0 ? '+' : '−'}${r0(Math.abs(ex) / B * 100)} % de batterie)`);
  }
  lines.push(`🔋 ${cur.level} % · ${r0(d)} km faits sur ${r0(p.total)}`);
  return { level, title, lines, rec: rec?.name || null, arr: r0(arr), goal: goal.name, rangeKm: r0(rangeKm), d: r0(d), left: r0(left),
    rM: +rM.toFixed(1), rO: +rO.toFixed(1), mwMeasured: mM != null, done: left < 1.5 };
}


// ---------- free follow-up: no route chosen (Thomas, 2026-11-17) ----------
// One button, no destination: the road ahead is unknown, so there is no "will I make it" — only the battery, the
// consumption measured since departure, the average speed, and how far the battery goes at that pace.
// Each stretch between two car readings (~2 min) is classed by its own average speed like the automatic drive
// measurement (car/drives.mjs, D-047): > 95 km/h motorway, 45–95 road, < 45 town. Energy = the battery % drops,
// shared between the stretches by the car's finer "residual energy" figure when every reading has it.
// profile: {free: true, label, batt, reserve, target, kM, kO, kC} (kWh/100 km expected at today's temperature)
const OFF = 6 * 60e3, MW_KMH = 95, CITY_KMH = 45, FREE_MIN_KM = 20;
const tOf = (p) => Date.parse(p.kmAt || p.carAt) || p.at;
function freeMeasure(trip, pts) {
  const p = trip.profile;
  let all = pts.filter((x) => x.km != null && x.level != null && x.km >= trip.startKm - 0.05);
  // the car's first reading can come a few km after pressing the button: from the odometer at the press (speed unknown)
  if (!all.length || all[0].km - trip.startKm > 0.3) all = [{ km: trip.startKm, level: trip.startLevel, at: trip.startAt, syn: true }, ...all];
  const S = { mw: { km: 0, w: 0, h: 0 }, ot: { km: 0, w: 0, h: 0 }, city: { km: 0, w: 0, h: 0 } };
  let pct = 0, km = 0, h = 0, mkm = 0, pred = 0, lastMove = trip.startAt;
  // Wh per battery % seen on this trip, for the stretches where a reading lacks the residual figure (the start point)
  let rs = 0, ls = 0;
  for (let i = 1; i < all.length; i++) if (all[i].residualWh != null && all[i - 1].residualWh != null && all[i - 1].level >= all[i].level) { rs += all[i - 1].residualWh - all[i].residualWh; ls += all[i - 1].level - all[i].level; }
  const whPct = ls >= 2 && rs > 0 ? rs / ls : null;
  const wOf = (a, b, dl) => (whPct == null ? dl : a.residualWh != null && b.residualWh != null ? a.residualWh - b.residualWh : dl * whPct);
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i], dkm = b.km - a.km, dl = a.level - b.level;
    if (dkm > 0.1) lastMove = tOf(b);
    if (dl < 0 || dkm < 0) continue;                          // charged in between
    if (dkm < 0.05) { pct += dl; continue; }                  // parked (heating, pre-heating): energy counted, no km
    const dh = (tOf(b) - tOf(a)) / 3600e3;
    const known = !a.syn && b.at - a.at <= OFF;                // across a switch-off or from the press: speed unknown → road
    const v = known && dh > 0 ? dkm / Math.max(dh, 1 / 60) : 60;
    const s = S[v > MW_KMH ? 'mw' : v < CITY_KMH ? 'city' : 'ot'];
    s.km += dkm; s.w += Math.max(0, wOf(a, b, dl));
    if (known) { s.h += dh; h += dh; mkm += dkm; }
    if (p.law) pred += dkm * kwh100(p.law, v, b.tempC ?? p.T ?? 10) / 100;          // what the law expects for this stretch
    pct += dl; km += dkm;
  }
  const kwh = pct / 100 * p.batt, totW = S.mw.w + S.ot.w + S.city.w;
  for (const s of Object.values(S)) s.kwh = totW > 0 ? kwh * s.w / totW : km > 0 ? kwh * s.km / km : 0;
  return { S, km, kwh, h, pred, lastMove, avgKmh: h > 0.02 ? mkm / h : null };
}
function freeTotals(trip, pts) {
  const m = freeMeasure(trip, pts), r = (s) => (s.km >= 5 ? +(s.kwh / s.km * 100).toFixed(1) : null);
  return { free: true, km: Math.round(m.km), kwh100: m.km >= 5 ? +(m.kwh / m.km * 100).toFixed(1) : null,
    avgKmh: m.avgKmh && Math.round(m.avgKmh), mwKm: Math.round(m.S.mw.km), mwKwh100: r(m.S.mw),
    otherKm: Math.round(m.S.ot.km), otherKwh100: r(m.S.ot), cityKm: Math.round(m.S.city.km), cityKwh100: r(m.S.city) };
}
function evaluateFree(trip, pts) {
  const p = trip.profile, cur = pts[pts.length - 1];
  if (!cur || cur.level == null || cur.km == null) return null;
  const m = freeMeasure(trip, pts), B = p.batt, r0 = Math.round;
  const kC = p.kC ?? p.kO;
  // measured vs what the expected rates give for the same km of each kind: worse counts in full, better at most −10 %
  // (a 1 % battery step is ~0.5 kWh); applied to every kind of road, since the road ahead is unknown
  const expect = p.law ? m.pred : (m.S.mw.km * p.kM + m.S.ot.km * p.kO + m.S.city.km * kC) / 100;
  const ratio = m.km >= FREE_MIN_KM && expect > 0 ? m.kwh / expect : 1;
  const f = ratio >= 1 ? ratio : Math.max(0.9, 1 + Math.min(1, m.km / 60) * (ratio - 1));
  const left = cur.level / 100 * B - p.reserve / 100 * B;
  const range = (k) => Math.max(0, r0(left / (k * f) * 100));
  const here = m.km >= FREE_MIN_KM ? m.kwh / m.km * 100 : null;          // this trip's own figure, mix of roads included
  const level = cur.level <= p.reserve + 3 ? 'non' : cur.level <= p.reserve + 12 ? 'juste' : 'ok';
  const title = level === 'ok' ? `✅ Batterie ${cur.level} %` : level === 'juste' ? `⚠️ Batterie basse : ${cur.level} %` : `🛑 Batterie presque vide : ${cur.level} %`;
  const lines = [];
  lines.push(here != null ? `Autonomie jusqu'à ${p.reserve} % : ≈ ${range(here / f)} km au rythme de ce trajet` : `Autonomie jusqu'à ${p.reserve} % : ≈ ${range(p.kO)} km sur route`);
  // range at a steady speed (D-050): the law at today's temperature, scaled to this trip
  const T = cur.tempC ?? p.T ?? 10;
  if (p.law) lines.push('Autonomie selon la vitesse : ' + [130, 110, 90, 70].map((v) => `${v} km/h → ${range(kwh100(p.law, v, T))} km`).join(' · ') + ` · ville → ${range(kwh100(p.law, 30, T))} km`);
  else lines.push(`Selon la route : autoroute ≈ ${range(p.kM)} km · route ≈ ${range(p.kO)} km · ville ≈ ${range(kC)} km`);
  if (level !== 'ok') lines.push('👉 Pensez à une borne' + (p.law ? ` : à 90 km/h au lieu de 110, ≈ ${range(kwh100(p.law, 90, T)) - range(kwh100(p.law, 110, T))} km de plus.` : (m.S.mw.km > 5 ? ' : sur autoroute, rouler à 110 au lieu de 130 consomme environ 20 % de moins.' : ' : trouvez-en une proche de votre route.')));
  const kinds = [['autoroute', m.S.mw], ['route', m.S.ot], ['ville', m.S.city]].filter(([, s]) => s.km >= 1);
  lines.push(`${r0(m.km)} km depuis le départ${m.avgKmh ? ` · moyenne ${r0(m.avgKmh)} km/h en roulant` : ''}`
    + (m.km >= 10 ? ` · ${m.km < FREE_MIN_KM ? '≈ ' : ''}${dec1(m.kwh / m.km * 100)} kWh/100 km` : ''));
  if (kinds.length) lines.push(kinds.map(([n, s]) => `${n} ${r0(s.km)} km${s.km >= 5 && m.km >= FREE_MIN_KM ? ` à ${dec1(s.kwh / s.km * 100)}` : ''}`).join(' · '));
  if (m.km < FREE_MIN_KM) lines.push(`Conso du trajet fiable après ${FREE_MIN_KM} km (la batterie avance par pas de 1 %) : en attendant, conso prévue à ${dec1(p.kO)} sur route, ${dec1(p.kM)} sur autoroute.`);
  return { level, title, lines, free: true, rec: null, d: r0(m.km), avgKmh: m.avgKmh && r0(m.avgKmh), lastMove: m.lastMove,
    rangeKm: here != null ? range(here / f) : range(p.kO), mwMeasured: false, done: false };
}
