// Background job (cron, every 2 minutes): reads the e-208 status from MyPeugeot, keeps a local history, computes the
// real consumption and the real remaining range, and posts a small summary to a secret ntfy.sh channel that
// Péage Malin reads on the phone. No position is ever stored or sent.
//   node --experimental-websocket car/poll.mjs            (normal run)
//   node --experimental-websocket car/poll.mjs --show     (print the summary, post nothing)
import { appendFileSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DIR, api, status, digest, readJson, writeJson, log } from './peugeot.mjs';
import { evaluate, tripTotals } from '../app/js/enroute.js';

const SHOW = process.argv.includes('--show');
const BATTERY_KWH = 46;          // usable capacity used when the car gives no residual energy
const RESERVE = 0.08;            // remaining range is counted down to 8 %
const WINDOW_KM = 30;            // live consumption over the last ~30 km driven
const conf = readJson('car.json');
if (!conf?.vehicleId) { console.log('Lancer d\'abord : node car/setup.mjs'); process.exit(1); }
const state = readJson('state.json', { lastCall: 0, lastChange: 0, lastPost: 0, lastTrips: 0, posted: null });
const now = Date.now();

// ---- 0. "En route" trip sent by the phone (D-037): {type:'start', trip} or {type:'end', id} on <channel>-trajet ----
let trip = readJson('trip.json', null);
try {
  const txt = await (await fetch(`https://ntfy.sh/${conf.topic}-trajet/json?poll=1&since=${state.tripMsg || '12h'}`)).text();
  for (const l of txt.trim().split('\n').filter(Boolean)) {
    const m = JSON.parse(l);
    if (m.event !== 'message') continue;
    state.tripMsg = m.id;
    const x = JSON.parse(m.message);
    if (x.type === 'start' && x.trip?.profile) { trip = { ...x.trip, active: true }; state.alert = null; log('trip started', trip.id); }
    if (x.type === 'end' && trip && trip.id === x.id) { trip.active = false; trip.endAt = now; log('trip ended by the phone', trip.id); }
  }
} catch (e) { log('trip channel error:', e.message); }
if (trip?.active && now - trip.startAt > 36 * 3600e3) { trip.active = false; trip.endAt = now; }      // forgotten trip

// ---- 0b. charge stop at 6:00 (D-038): "don't stop tomorrow morning" from the phone, on <channel>-commande ----
try {
  const txt = await (await fetch(`https://ntfy.sh/${conf.topic}-commande/json?poll=1&since=${state.cmdMsg || '12h'}`)).text();
  for (const l of txt.trim().split('\n').filter(Boolean)) {
    const m = JSON.parse(l);
    if (m.event !== 'message') continue;
    state.cmdMsg = m.id;
    const x = JSON.parse(m.message);
    if (x.type === 'skip' && /^\d{4}-\d\d-\d\d$/.test(x.date)) { state.chargeSkip = x.date; log('charge stop skipped for', x.date); }
    if (x.type === 'unskip') { state.chargeSkip = null; log('charge stop skip cancelled'); }
    // "start / stop the charge now" buttons: only recent requests (a request older than 10 min is dropped)
    if (x.type === 'charge' && ['start', 'stop'].includes(x.action) && now - (m.time * 1000) < 10 * 60e3 && !SHOW) {
      log('charge', x.action, 'asked from the app');
      const out = openSync(join(DIR, 'charge.log'), 'a');
      spawn(process.execPath, [...process.execArgv, join(dirname(fileURLToPath(import.meta.url)), 'charge.mjs'), x.action, '--app'],
        { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), detached: true, stdio: ['ignore', out, out] }).unref();
    }
  }
} catch (e) { log('command channel error:', e.message); }
// Tempo colours of today and tomorrow (1 blue, 2 white, 3 red), every hour (tomorrow's is published around 11:00)
if (SHOW || now - (state.lastTempo || 0) > 3600e3) {
  const day = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  state.tempo = state.tempo || {};
  for (const [w, d] of [['today', day(new Date(now))], ['tomorrow', day(new Date(now + 86400e3))]]) {
    try {
      const j = await (await fetch(`https://www.api-couleur-tempo.fr/api/jourTempo/${w}`, { signal: AbortSignal.timeout(15000) })).json();
      if (j?.dateJour === d && j.codeJour) state.tempo[d] = j.codeJour;
    } catch (e) { log('tempo error:', e.message); }
  }
  for (const k of Object.keys(state.tempo).sort().slice(0, -6)) delete state.tempo[k];
  state.lastTempo = now;
}
const onTrip = !!trip?.active;

// ---- 1. car status (every 2 min while something moves or a trip is followed, every 10 min when the car is idle) ----
const idle = now - state.lastChange > 30 * 60e3 && !onTrip;
let cur = state.last || null;
if (SHOW || !idle || now - state.lastCall > 10 * 60e3) {
  try {
    cur = digest(await status(conf.vehicleId));
    state.lastCall = now;
    const prev = state.last;
    const changed = !prev || cur.km !== prev.km || cur.level !== prev.level || cur.residualWh !== prev.residualWh || cur.charging !== prev.charging;
    if (changed) {
      state.lastChange = now;
      appendFileSync(join(DIR, 'history.jsonl'), JSON.stringify(cur) + '\n', { mode: 0o600 });
    }
    state.last = cur;
  } catch (e) { log('status error:', e.message); }
}

// ---- 2. Peugeot trip history (every hour): distance, duration, average speed, energy of each trip ----
if (SHOW || now - state.lastTrips > 3600e3) {
  try {
    const trips = readJson('trips.json', []);
    for (const t of trips) if (t.sec > 0) t.avgKmh = t.km / t.sec * 3600;     // (first version stored a wrong unit)
    const known = new Set(trips.map((t) => t.id));
    const since = trips.length ? new Date(Math.max(...trips.map((t) => Date.parse(t.start))) - 86400e3) : new Date(now - 400 * 86400e3);
    let url = `/vehicles/${conf.vehicleId}/trips?distance=0.1-&timestamps=${since.toISOString().slice(0, 19)}Z/`;
    for (let page = 0; page < 40 && url; page++) {
      const j = await api(url);
      for (const t of j._embedded?.trips || []) {
        if (known.has(t.id)) continue;
        const ec = (t.energyConsumptions || []).find((e) => e.type === 'Electric') || {};
        trips.push({ id: t.id, start: t.startedAt || t.createdAt, km: +t.distance || 0, sec: +t.duration || 0,
          avgKmh: +t.duration > 0 ? +t.distance / +t.duration * 3600 : null, wh: ec.consumption != null ? +ec.consumption : null,
          startKm: t.startMileage ?? null });
        known.add(t.id);
      }
      const next = j._links?.next?.href;
      url = next ? next.replace(/^.*\/connectedcar\/v4\/user/, '').replace(/[?&]client_id=[^&]*/, '').replace(/[?&]locale=[^&]*/, '') : null;
    }
    trips.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    writeJson('trips.json', trips);
    state.lastTrips = now;
  } catch (e) { log('trips error:', e.message); }
}

// ---- 3. computations ----
// the e-208's own "residual Wh" does not match its % (26.7 of 33.2 kWh shown at 93 %), so only the % is used
const kwhOf = (p) => (p.level != null ? p.level / 100 * BATTERY_KWH : null);
const history = (() => {
  try { return readFileSync(join(DIR, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
})();
// live consumption: walk back from the latest point while driving, stop at a charge (energy going up) or a long stop
let live = null;
if (cur && cur.km != null) {
  const pts = history.filter((p) => p.km != null && kwhOf(p) != null);
  let i = pts.length - 1;
  while (i > 0) {
    const a = pts[i - 1], b = pts[i];
    if (kwhOf(a) < kwhOf(b) - 0.3) break;                         // charged in between
    if (b.at - a.at > 6 * 3600e3) break;                          // different day / long stop
    i--;
    if (cur.km - pts[i].km >= WINDOW_KM) break;
  }
  const a = pts[i], km = a ? cur.km - a.km : 0, used = a ? kwhOf(a) - kwhOf(cur) : 0;
  if (km >= 8 && used > 0) live = { km: Math.round(km), kwh100: +(used / km * 100).toFixed(1), since: a.at };
}
// long-term figures from the trip history: winter (Nov–Mar) / summer, motorway (average ≥ 75 km/h) / other roads
const trips = readJson('trips.json', []);
// Peugeot's trip energy reads low on the e-208: calibrate it against the real battery drops seen in the history
// (stretches without charging). Until 100 km have been measured, use Thomas's own figure: 15 kWh/100 km over his
// last 8,000 km of mixed driving.
let calib = null;
{
  const pts = history.filter((p) => p.km != null && p.level != null);
  let mKm = 0, mKwh = 0, rKwh = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.level > a.level || b.at - a.at > 6 * 3600e3 || b.km - a.km < 0.5) continue;
    const ts = trips.filter((t) => t.wh && t.startKm != null && t.startKm >= a.km - 0.5 && t.startKm + t.km <= b.km + 0.5);
    const tkm = ts.reduce((x, t) => x + t.km, 0);
    if (tkm < 0.8 * (b.km - a.km)) continue;                        // trips not yet synced for this stretch
    mKm += b.km - a.km; mKwh += (a.level - b.level) / 100 * BATTERY_KWH; rKwh += ts.reduce((x, t) => x + t.wh / 1000, 0);
  }
  if (mKm >= 100 && rKwh > 0) calib = { factor: +(mKwh / rKwh).toFixed(3), km: Math.round(mKm), source: 'mesure' };
}
const recent = trips.filter((t) => t.wh && t.km >= 1).slice(-400);
const rawAvg = recent.reduce((x, t) => x + t.wh, 0) / 1000 / (recent.reduce((x, t) => x + t.km, 0) || 1) * 100;
if (!calib) calib = { factor: rawAvg > 0 ? +(15 / rawAvg).toFixed(3) : 1, km: 0, source: '15 kWh/100 km' };
const groups = {};
for (const t of trips) {
  if (!t.wh || t.km < 5) continue;
  const m = new Date(t.start).getMonth() + 1, season = m >= 11 || m <= 3 ? 'hiver' : 'ete';
  const kind = (t.avgKmh ?? 0) >= 75 ? 'autoroute' : 'autres';
  const g = groups[`${season}_${kind}`] ||= { km: 0, kwh: 0, n: 0 };
  g.km += t.km; g.kwh += t.wh / 1000 * calib.factor; g.n++;
}
const stats = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { kwh100: +(g.kwh / g.km * 100).toFixed(1), km: Math.round(g.km), n: g.n }]));
const all = Object.values(groups).reduce((s, g) => ({ km: s.km + g.km, kwh: s.kwh + g.kwh }), { km: 0, kwh: 0 });
const avg = all.km > 50 ? +(all.kwh / all.km * 100).toFixed(1) : null;

let remainingKm = null;
if (cur) {
  const kwh = kwhOf(cur), rate = live?.kwh100 || avg || 16;
  if (kwh != null) remainingKm = Math.max(0, Math.round((kwh - RESERVE * BATTERY_KWH) / rate * 100));
}
const summary = cur && {
  v: 1, at: now, carAt: cur.carAt, level: cur.level, kwh: kwhOf(cur) != null ? +kwhOf(cur).toFixed(2) : null,
  exactKwh: false, odometer: cur.km, carRange: cur.autonomy, charging: cur.charging, plugged: cur.plugged,
  live, remainingKm, rateUsed: live?.kwh100 || avg || 16, avg, stats, trips: trips.length, calib,
};

if (summary) {
  // real consumption measured on followed trips (battery % drops), by season and kind of road
  const g = {};
  for (const r of readJson('roads.json', [])) {
    for (const [k, km, v] of [['autoroute', r.mwKm, r.mwKwh100], ['autres', r.otherKm, r.otherKwh100]]) {
      if (v == null || !km) continue;
      const key = (r.winter ? 'hiver_' : 'ete_') + k; g[key] = g[key] || { km: 0, kwh: 0, n: 0 };
      g[key].km += km; g[key].kwh += v * km / 100; g[key].n++;
    }
  }
  summary.roads = Object.fromEntries(Object.entries(g).map(([k, x]) => [k, { kwh100: +(x.kwh / x.km * 100).toFixed(1), km: Math.round(x.km), n: x.n }]));
}
if (summary) {
  const rem = readJson('remote.json'), ch = readJson('charge.json', {});
  summary.charge = { active: !!rem, tempo: state.tempo || {}, skip: state.chargeSkip || null, last: ch.last || null, manual: ch.manual || null };
}

// ---- "En route": battery vs the road still ahead, alerts on <channel>-alerte (ntfy app on the phone) ----
let er = null;
if (summary && onTrip) {
  const pts = history.filter((p) => p.at >= trip.startAt - 60e3 && p.km != null && p.level != null);
  if (!pts.length || pts[pts.length - 1].at !== cur.at) pts.push(cur);
  er = evaluate(trip, pts);
  if (er) summary.enroute = { id: trip.id, carAt: cur.carAt, ...er };
}
async function alert(title, lines, priority, tags) {
  if (SHOW) { console.log('ALERT', priority, title, lines); return; }
  try {
    const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: `${conf.topic}-alerte`, title, message: lines.join('\n'), priority, tags }) });
    if (!r.ok) throw new Error('ntfy ' + r.status);
  } catch (e) { log('alert error:', e.message); }
}
if (er && !SHOW) {
  const a = state.alert || {};
  const why = !a.id ? 'start' : a.level !== er.level || a.rec !== er.rec ? 'change' : !a.mw && er.mwMeasured ? 'mw'
    : er.done ? 'done' : er.d - (a.d ?? 0) >= 1 && now - a.at > 30 * 60e3 ? 'periodic' : null;
  if (why === 'done') {
    trip.active = false; trip.endAt = now;
    const tt = tripTotals(trip, history.filter((p) => p.at >= trip.startAt - 60e3 && p.km != null && p.level != null).concat(cur));
    const kw = (x) => String(x).replace('.', ',');
    await alert('🏁 Arrivé', [`Batterie ${cur.level} %. Suivi terminé.`,
      tt.mwKwh100 != null ? `Conso réelle sur autoroute : ${kw(tt.mwKwh100)} kWh/100 km (${tt.mwKm} km).` : '',
      tt.otherKwh100 != null ? `Autres routes : ${kw(tt.otherKwh100)} kWh/100 km (${tt.otherKm} km).` : ''].filter(Boolean), 2, ['checkered_flag']);
  } else if (why) {
    const head = why === 'start' ? 'Suivi batterie démarré — ' : why === 'mw' ? 'Conso autoroute mesurée — ' : '';
    const prio = er.level === 'non' ? 5 : er.level === 'juste' ? 4 : why === 'change' || why === 'mw' ? 3 : 2;
    await alert(head + er.title, er.lines, prio, [er.level === 'ok' ? 'battery' : er.level === 'juste' ? 'warning' : 'rotating_light']);
  }
  if (why) state.alert = { id: trip.id, level: er.level, rec: er.rec, mw: er.mwMeasured, d: er.d, at: now };
}
// finished trip: keep its real motorway / other-road consumption (used by future route plans, D-039)
if (trip && !trip.active && !trip.saved && !SHOW) {
  const end = trip.endAt || now;
  const pts = history.filter((p) => p.at >= trip.startAt - 60e3 && p.at <= end + 60e3 && p.km != null && p.level != null);
  const tt = tripTotals(trip, pts);
  const log2 = readJson('roads.json', []);
  const m = new Date(trip.startAt).getMonth() + 1;
  log2.push({ at: trip.startAt, winter: m >= 11 || m <= 3, ...tt });
  writeJson('roads.json', log2.slice(-40));
  trip.saved = true;
  log('trip measured:', JSON.stringify(tt));
}
if (trip && !SHOW) writeJson('trip.json', trip);

if (SHOW) { console.log(JSON.stringify(summary, null, 1)); writeJson('state.json', state); process.exit(0); }

// ---- 4. post to the phone when something changed (and at least every 6 h) ----
const sig = summary && JSON.stringify({ ...summary, at: 0 });
if (summary && (sig !== state.posted || now - state.lastPost > 6 * 3600e3)) {
  try {
    const r = await fetch(`https://ntfy.sh/${conf.topic}`, { method: 'POST', body: JSON.stringify(summary),
      headers: { Title: 'e-208', Priority: '1', Cache: 'yes' } });
    if (!r.ok) throw new Error('ntfy ' + r.status);
    state.posted = sig; state.lastPost = now;
  } catch (e) { log('post error:', e.message); }
}
// keep 60 days of history
if (history.length > 20000) writeFileSync(join(DIR, 'history.jsonl'), history.filter((p) => now - p.at < 60 * 86400e3).map((p) => JSON.stringify(p)).join('\n') + '\n', { mode: 0o600 });
writeJson('state.json', state);
