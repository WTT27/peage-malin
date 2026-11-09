// Compare the two calculation methods on all test trips: "Complète" (every candidate checked with TomTom) and
// "Économe" (free Valhalla estimate, TomTom only for the best ones).
// For each trip: TomTom requests used by each method, the starred best compromise of each, and whether the économe
// options are as good as the complète ones (same scoring as the app: each économe option is compared with the best
// complète option at the same or shorter time).
// Usage: node tests/compare_all.mjs [diesel|ev] [trip names…]
import { HOME, TRIPS, WHEN, hm } from './lib.mjs';

import { execFileSync } from 'node:child_process';

// one method on one trip, in its own process (the app keeps answers in memory: sharing would hide requests)
if (process.argv[2] === '--one') {
  const [, , , name, mode, vk] = process.argv;
  const { loadTolls } = await import('../app/js/tolls.js');
  const { analyse, DEFAULT_VEHICLES } = await import('../app/js/optimizer.js');
  const { stats } = await import('../app/js/services.js');
  await loadTolls();
  const t0 = Date.now();
  const r = await analyse(HOME, TRIPS[name], DEFAULT_VEHICLES[vk], new Date(WHEN), () => {}, { estimator: mode });
  console.log(JSON.stringify({ req: stats.api, valhalla: stats.valhalla, s: Math.round((Date.now() - t0) / 1000), notice: r.notice || '', mode: r.mode,
    eff: r.eff.map((e) => ({ min: e.min, cost: e.cost, label: e.label, best: !!e.best, isRef: !!e.isRef })) }));
  process.exit(0);
}
const one = (name, mode, vk) => JSON.parse(execFileSync(process.execPath, [new URL(import.meta.url).pathname, '--one', name, mode, vk],
  { encoding: 'utf8', timeout: 900000, maxBuffer: 1e7 }).trim().split('\n').pop());

const args = process.argv.slice(2);
const veh = ['diesel', 'ev'].includes(args[0]) ? args.shift() : 'diesel';
const names = args.length ? args : Object.keys(TRIPS);
const fmt = (e, ref) => (e ? `+${Math.round(e.min - ref.min)} min −${(ref.cost - e.cost).toFixed(2)} €` : '—');
const rows = [];

for (const name of names) {
  const out = { tomtom: one(name, 'tomtom', veh), valhalla: one(name, 'valhalla', veh) };
  for (const k in out) out[k].r = out[k];
  const C = out.tomtom.r, E = out.valhalla.r;
  const ref = C.eff.find((e) => e.isRef);
  const bc = C.eff.find((e) => e.best), be = E.eff.find((e) => e.best);
  // how much worse is each économe option than the complète frontier at the same time? (€, positive = worse)
  let worst = 0;
  for (const e of E.eff) {
    if (e.isRef) continue;
    const c = C.eff.filter((x) => x.min <= e.min + 2).sort((a, b) => a.cost - b.cost)[0];
    if (c) worst = Math.max(worst, e.cost - c.cost);
  }
  // and is any complète option missing from économe? (complète option better by ≥ 1 € than économe at same time)
  let missed = 0;
  for (const c of C.eff) {
    if (c.isRef) continue;
    const e = E.eff.filter((x) => x.min <= c.min + 2).sort((a, b) => a.cost - b.cost)[0];
    missed = Math.max(missed, e ? e.cost - c.cost : ref.cost - c.cost);
  }
  rows.push({ name, reqC: out.tomtom.req, reqE: out.valhalla.req, mode: E.mode, worst, missed, bc, be, ref });
  console.log(`== ${name}: complète ${out.tomtom.req} req (${out.tomtom.s} s) | économe ${out.valhalla.req} req + ${out.valhalla.valhalla} Valhalla (${out.valhalla.s} s)${E.notice ? ' [' + E.notice.slice(0, 60) + ']' : ''}`);
  console.log(`   ⭐ complète: ${fmt(bc, ref)} ${bc ? bc.label.slice(0, 60) : ''}`);
  console.log(`   ⭐ économe : ${fmt(be, ref)} ${be ? be.label.slice(0, 60) : ''}`);
  console.log(`   économe options up to ${worst.toFixed(2)} € worse at same time; complète options missing in économe: up to ${missed.toFixed(2)} €`);
  for (const [k, x] of [['C', C], ['E', E]]) for (const e of x.eff) console.log(`     ${k} ${e.best ? '⭐' : '  '} ${fmt(e, ref).padEnd(20)} ${hm(e.min)} ${e.label.slice(0, 70)}`);
}
const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
console.log(`\nSummary (${veh}, ${rows.length} trips): TomTom requests complète ${sum((r) => r.reqC)} vs économe ${sum((r) => r.reqE)}.`);
console.log(`Same starred option: ${rows.filter((r) => r.bc && r.be && Math.abs(r.bc.min - r.be.min) < 2 && Math.abs(r.bc.cost - r.be.cost) < 0.5).length}/${rows.length}.`);
console.log(`Économe misses a complète option by ≥ 1 €: ${rows.filter((r) => r.missed >= 1).map((r) => `${r.name} (${r.missed.toFixed(2)} €)`).join(', ') || 'never'}.`);
