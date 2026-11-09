// Permanent check: does Google Maps follow the route the app chose?
// For every option the app shows (except the plain fastest one), it builds the Google Maps stops exactly as the app does
// when "Ouvrir dans Google Maps" is tapped (refineVia, plus the charging stops for the e-208), then asks TomTom for the
// fastest route through those stops WITH tolls allowed (stand-in for Google, which takes the fastest roads).
// The option passes if that route pays no more tolls than the option (+0.50 €) and stays on the option's roads
// (≥ 90 % of its length within 1.5 km of the option's line).
// Usage: node tests/google_follow.mjs [diesel|ev] [trip names…]      exit code 1 if an option fails
import { HOME, TRIPS, WHEN, net, hm } from './lib.mjs';

const { loadTolls, priceRoute } = await import('../app/js/tolls.js');
const { analyse, DEFAULT_VEHICLES, refineVia, isoLocal, refineLegs } = await import('../app/js/optimizer.js');
const { mergeStops } = await import('../app/js/charging.js');
const { route } = await import('../app/js/services.js');
const { routePoints, km } = await import('../app/js/geo.js');
await loadTolls();

const args = process.argv.slice(2);
const veh = ['diesel', 'ev'].includes(args[0]) ? args.shift() : 'diesel';
const names = args.length ? args : Object.keys(TRIPS);
const v = DEFAULT_VEHICLES[veh], depart = new Date(WHEN);
let pass = 0, fail = 0, nTwo = 0;
const nStops = [];
const failures = [];

for (const name of names) {
  const d = TRIPS[name];
  const res = await analyse(HOME, d, v, depart, () => {});
  const lines = [];
  for (const e of res.eff) {
    if (e.isRef) continue;
    const fixed = e.charge?.ok ? e.charge.stops.map((s) => s.p) : [];          // charging stops, as in the app
    const r2 = await refineVia(HOME, d, e, v, depart, +(process.env.MAXSTOPS || 9), fixed);
    const via = mergeStops(e.line || [], r2.via, fixed);
    // toll-free option: the app tells the user to switch on "Éviter les péages" in Google Maps → same here
    const free = e.toll < 0.05;
    // two-link options: each part checked on its own (the free part with "avoid tolls", as the app tells the user)
    // (as in the app: two links only when one link fails the check)
    const legs = (!free && !r2.ok && await refineLegs(HOME, d, { ...e, via: r2.via }, v, depart, fixed)) || [{ from: HOME, to: d, via, avoidTolls: free }];
    nStops.push(via.length); if (legs.length > 1) nTwo++;
    const rs = [];
    for (const L of legs) {
      const x = await route(L.from, L.to, { via: L.via, depart: isoLocal(depart), maxSpeed: v.maxSpeed, avoidTolls: L.avoidTolls });
      if (!x.length) { rs.length = 0; break; }
      rs.push(x[0]);
    }
    if (!rs.length) { fail++; failures.push(`${name}: ${e.label} — no route through the stops`); lines.push(`   ❌ no route  ${e.label.slice(0, 70)}`); continue; }
    // the parts joined into one route for the checks below
    const prs = rs.map((x) => priceRoute(x, depart));
    const pr = { toll: prs.reduce((t, x) => t + x.toll, 0), unpriced: prs.some((x) => x.unpriced) };
    const rp = [], sections = [];
    for (const x of rs) { const p0 = rp.length, q = routePoints(x); rp.push(...q); for (const sc of x.sections || []) sections.push({ ...sc, startPointIndex: sc.startPointIndex + p0, endPointIndex: sc.endPointIndex + p0 }); }
    const r = { sections, summary: { travelTimeInSeconds: rs.reduce((t, x) => t + x.summary.travelTimeInSeconds, 0) } };
    // share of the test route's length that stays within 1.5 km of the option's line
    let near = 0, tot = 0;
    for (let i = 1; i < rp.length; i += 1) {
      const seg = km(rp[i - 1], rp[i]); tot += seg;
      if (i % 4 && seg < 0.5) { near += seg; continue; }        // speed: test every 4th point (short segments)
      let dmin = Infinity; for (const q of e.line) { const dd = km(rp[i], q); if (dd < dmin) dmin = dd; if (dmin < 1.5) break; }
      if (dmin < 1.5) near += seg;
    }
    // toll km driven away from the option's line (used when the test route has a toll stretch we cannot price)
    let offToll = 0;
    for (const sct of r.sections || []) {
      if (sct.sectionType !== 'TOLL_ROAD') continue;
      for (let i = sct.startPointIndex + 1; i <= sct.endPointIndex; i++) {
        let dmin = Infinity; for (const q of e.line) { const dd = km(rp[i], q); if (dd < dmin) dmin = dd; if (dmin < 1.5) break; }
        if (dmin >= 1.5) offToll += km(rp[i - 1], rp[i]);
      }
    }
    const share = tot ? near / tot : 0, toll = pr.unpriced ? null : pr.toll;
    const okToll = toll != null ? toll <= e.toll + 0.5 : offToll < 2, okRoad = share >= 0.9;
    const ok = okToll && okRoad;
    ok ? pass++ : fail++;
    const msg = `${ok ? '✅' : '❌'} péages ${toll == null ? `? (${offToll.toFixed(0)} km hors option)` : toll.toFixed(2)} € (option ${e.toll.toFixed(2)} €) · ${Math.round(share * 100)} % sur ses routes · ${hm(r.summary.travelTimeInSeconds / 60)} (option ${hm(e.sec / 60)}) · ${legs.length > 1 ? `2 liens (${legs.map((L) => L.via.length + (L.avoidTolls ? ' étapes, éviter péages' : ' étapes')).join(' + ')})` : `${via.length} étapes`}${free ? ' (éviter péages)' : ''}  ${e.label.slice(0, 60)}`;
    lines.push('   ' + msg);
    if (!ok) failures.push(`${name}: ${msg}`);
  }
  console.log(`== ${name} (${veh}): ${res.eff.filter((e) => !e.isRef).length} options`);
  for (const l of lines) console.log(l);
}
console.log(`\nGoogle follow (${veh}): ${pass} options OK, ${fail} not followed. Two links: ${nTwo}. Stops per option: average ${(nStops.reduce((a, b) => a + b, 0) / (nStops.length || 1)).toFixed(1)}, ${nStops.filter((n) => n <= 3).length} with 3 or fewer. TomTom: ${net.tomtomNew} new requests, ${net.tomtomDisk} from disk cache.`);
if (failures.length) { console.log('Failures:'); for (const f of failures) console.log('  ' + f); }
process.exit(fail ? 1 : 0);
