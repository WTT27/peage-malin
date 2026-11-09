// Background job (cron, every 2 minutes): reads the e-208 status from MyPeugeot, keeps a local history, computes the
// real consumption and the real remaining range, and posts a small summary to a secret ntfy.sh channel that
// Péage Malin reads on the phone. No position is ever stored or sent.
//   node --experimental-websocket car/poll.mjs            (normal run)
//   node --experimental-websocket car/poll.mjs --show     (print the summary, post nothing)
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, api, status, digest, readJson, writeJson, log } from './peugeot.mjs';

const SHOW = process.argv.includes('--show');
const BATTERY_KWH = 46;          // usable capacity used when the car gives no residual energy
const RESERVE = 0.08;            // remaining range is counted down to 8 %
const WINDOW_KM = 30;            // live consumption over the last ~30 km driven
const conf = readJson('car.json');
if (!conf?.vehicleId) { console.log('Lancer d\'abord : node car/setup.mjs'); process.exit(1); }
const state = readJson('state.json', { lastCall: 0, lastChange: 0, lastPost: 0, lastTrips: 0, posted: null });
const now = Date.now();

// ---- 1. car status (every 2 min while something moves, every 10 min when the car is idle) ----
const idle = now - state.lastChange > 30 * 60e3;
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
    const known = new Set(trips.map((t) => t.id));
    const since = trips.length ? new Date(Math.max(...trips.map((t) => Date.parse(t.start))) - 86400e3) : new Date(now - 400 * 86400e3);
    let url = `/vehicles/${conf.vehicleId}/trips?distance=0.1-&timestamps=${since.toISOString().slice(0, 19)}Z/`;
    for (let page = 0; page < 40 && url; page++) {
      const j = await api(url);
      for (const t of j._embedded?.trips || []) {
        if (known.has(t.id)) continue;
        const ec = (t.energyConsumptions || []).find((e) => e.type === 'Electric') || {};
        trips.push({ id: t.id, start: t.startedAt || t.createdAt, km: +t.distance || 0, sec: +t.duration || 0,
          avgKmh: t.kinetic?.avgSpeed ? +t.kinetic.avgSpeed * 3.6 : null, wh: ec.consumption != null ? +ec.consumption : null,
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
const kwhOf = (p) => (p.residualWh ? p.residualWh / 1000 : p.level != null ? p.level / 100 * BATTERY_KWH : null);
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
const groups = {};
for (const t of trips) {
  if (!t.wh || t.km < 5) continue;
  const m = new Date(t.start).getMonth() + 1, season = m >= 11 || m <= 3 ? 'hiver' : 'ete';
  const kind = (t.avgKmh ?? 0) >= 75 ? 'autoroute' : 'autres';
  const g = groups[`${season}_${kind}`] ||= { km: 0, kwh: 0, n: 0 };
  g.km += t.km; g.kwh += t.wh / 1000; g.n++;
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
  exactKwh: !!cur.residualWh, odometer: cur.km, carRange: cur.autonomy, charging: cur.charging, plugged: cur.plugged,
  live, remainingKm, rateUsed: live?.kwh100 || avg || 16, avg, stats, trips: trips.length,
};

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
