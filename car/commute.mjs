// Morning commute: at a known roundabout, "straight on" (usual road) or "left" (longer road that avoids a daily jam)?
// (D-053) Both routes are asked from TomTom with live traffic, each forced through its own waypoints, and compared.
// The routes are private (home / work): they live in ~/.config/peage-malin-car/commute.json, never in the repo:
//   { "name": "Rond-point de Lattre", "point": [lat, lon],            // the roundabout where the choice is made
//     "dest": [lat, lon], "join": [lat, lon], "joinName": "…",   // join: where both roads meet again (compared up to it)
//     "days": [1,2,3,4,5], "from": "07:00", "to": "10:00", "radiusKm": 8, "gainMin": 2,
//     "routes": [ { "id": "usual", "label": "Tout droit", "road": "av. de Lattre", "via": [[lat, lon]] },
//                 { "id": "alt",   "label": "À gauche",   "road": "D64e",         "via": [[lat, lon], [lat, lon]] } ] }
// The car's position is only used in memory to know when it nears the roundabout; it is never stored or sent.
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIR, readJson } from './peugeot.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const commuteConf = () => readJson('commute.json', null);
function key() {
  try { return readFileSync(join(ROOT, '.env'), 'utf8').match(/TOMTOM_KEY=(\S+)/)[1]; } catch { return null; }
}
export function distKm(a, b) {
  const R = 6371, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// inside the commute window (local time, given days)?
export function inWindow(c, t = new Date()) {
  const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const m = t.getHours() * 60 + t.getMinutes();
  return (c.days || [1, 2, 3, 4, 5]).includes(t.getDay()) && m >= hm(c.from || '07:00') && m <= hm(c.to || '10:00');
}

// asks TomTom for both routes (2 requests) and decides
export async function checkCommute(c) {
  const k = key();
  if (!k) throw new Error('clé TomTom absente (.env)');
  const res = [];
  for (const r of c.routes) {
    const pts = [c.point, ...r.via, c.join || c.dest].map((p) => p.join(',')).join(':');
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${pts}/json?key=${encodeURIComponent(k)}` +
      '&traffic=true&routeType=fastest&computeTravelTimeFor=all';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`TomTom ${resp.status}`);
    const s = (await resp.json()).routes?.[0]?.summary;
    if (!s) throw new Error('TomTom: pas de route');
    res.push({ id: r.id, label: r.label, road: r.road, km: +(s.lengthInMeters / 1000).toFixed(1),
      min: Math.round(s.travelTimeInSeconds / 60), freeMin: Math.round(s.noTrafficTravelTimeInSeconds / 60),
      delayMin: Math.round((s.trafficDelayInSeconds || 0) / 60) });
  }
  const [u, a] = res;
  const gain = u.min - a.min;
  const best = gain >= (c.gainMin ?? 2) ? a.id : u.id;
  const out = { at: Date.now(), best, gain, routes: res };
  try { appendFileSync(join(DIR, 'commute.jsonl'), JSON.stringify(out) + '\n', { mode: 0o600 }); } catch { /* ignore */ }
  return out;
}

// the notification text
export function commuteText(c, r) {
  const b = r.routes.find((x) => x.id === r.best), o = r.routes.find((x) => x.id !== r.best);
  const line = (x) => `${x.label} (${x.road}) : ${x.min} min${x.delayMin >= 1 ? `, bouchons +${x.delayMin} min` : ''}`;
  const title = `🚦 ${c.name || 'Rond-point'} : ${b.label.toUpperCase()}`;
  const upTo = c.joinName ? ` jusqu'au ${c.joinName}` : '';
  const why = b.id === c.routes[0].id
    ? (r.gain > 0 ? `L'autre route ne ferait gagner que ${r.gain} min : pas la peine.` : 'La route habituelle reste la plus rapide.')
    : `${r.gain} min gagnées en évitant ${o.road}.`;
  return { title, lines: [why, ...(upTo ? [`Temps${upTo} (la suite est la même route) :`] : []), line(b), line(o)] };
}
