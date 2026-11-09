// Permanent check: does Google Maps follow the route the app chose?
// For every option the app shows (except the plain fastest one), it builds the Google Maps stops exactly as the app does
// when "Ouvrir dans Google Maps" is tapped (refineVia, plus the charging stops for the e-208), then asks TomTom for the
// fastest route through those stops WITH tolls allowed (stand-in for Google, which takes the fastest roads).
// The option passes if that route pays no more tolls than the option (+0.50 €) and stays on the option's roads
// (≥ 90 % of its length within 1.5 km of the option's line).
// Usage: node tests/google_follow.mjs [diesel|ev] [trip names…]      exit code 1 if an option fails
import { HOME, TRIPS, WHEN, net, hm } from './lib.mjs';

const { loadTolls, priceRoute } = await import('../app/js/tolls.js');
const { analyse, DEFAULT_VEHICLES, refineVia, isoLocal } = await import('../app/js/optimizer.js');
const { mergeStops } = await import('../app/js/charging.js');
const { route } = await import('../app/js/services.js');
const { routePoints, km } = await import('../app/js/geo.js');
await loadTolls();

const args = process.argv.slice(2);
const veh = ['diesel', 'ev'].includes(args[0]) ? args.shift() : 'diesel';
const names = args.length ? args : Object.keys(TRIPS);
const v = DEFAULT_VEHICLES[veh], depart = new Date(WHEN);
let pass = 0, fail = 0;
const failures = [];

for (const name of names) {
  const d = TRIPS[name];
  const res = await analyse(HOME, d, v, depart, () => {}, { estimator: 'tomtom' });
  const lines = [];
  for (const e of res.eff) {
    if (e.isRef) continue;
    const r2 = await refineVia(HOME, d, e, v, depart);
    let via = r2.via;
    if (e.charge?.ok && e.charge.stops.length) via = mergeStops(e.line || [], via, e.charge.stops.map((s) => s.p));
    const rs = await route(HOME, d, { via, depart: isoLocal(depart), maxSpeed: v.maxSpeed });
    if (!rs.length) { fail++; failures.push(`${name}: ${e.label} — no route through the stops`); lines.push(`   ❌ no route  ${e.label.slice(0, 70)}`); continue; }
    const r = rs[0], pr = priceRoute(r, depart), rp = routePoints(r);
    // share of the test route's length that stays within 1.5 km of the option's line
    let near = 0, tot = 0;
    for (let i = 1; i < rp.length; i += 1) {
      const seg = km(rp[i - 1], rp[i]); tot += seg;
      if (i % 4 && seg < 0.5) { near += seg; continue; }        // speed: test every 4th point (short segments)
      let dmin = Infinity; for (const q of e.line) { const dd = km(rp[i], q); if (dd < dmin) dmin = dd; if (dmin < 1.5) break; }
      if (dmin < 1.5) near += seg;
    }
    const share = tot ? near / tot : 0, toll = pr.unpriced ? null : pr.toll;
    const okToll = toll != null && toll <= e.toll + 0.5, okRoad = share >= 0.9;
    const ok = okToll && okRoad;
    ok ? pass++ : fail++;
    const msg = `${ok ? '✅' : '❌'} péages ${toll == null ? '?' : toll.toFixed(2)} € (option ${e.toll.toFixed(2)} €) · ${Math.round(share * 100)} % sur ses routes · ${hm(r.summary.travelTimeInSeconds / 60)} (option ${hm(e.sec / 60)}) · ${via.length} étapes  ${e.label.slice(0, 60)}`;
    lines.push('   ' + msg);
    if (!ok) failures.push(`${name}: ${msg}`);
  }
  console.log(`== ${name} (${veh}): ${res.eff.filter((e) => !e.isRef).length} options`);
  for (const l of lines) console.log(l);
}
console.log(`\nGoogle follow (${veh}): ${pass} options OK, ${fail} not followed. TomTom: ${net.tomtomNew} new requests, ${net.tomtomDisk} from disk cache.`);
if (failures.length) { console.log('Failures:'); for (const f of failures) console.log('  ' + f); }
process.exit(fail ? 1 : 0);
