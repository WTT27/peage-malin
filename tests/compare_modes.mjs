// Compare the two calculation methods (complete TomTom vs economical Valhalla) on one trip.
// usage: node tests/compare_modes.mjs bordeaux|brive|demangevelle [diesel|ev] [YYYY-MM-DDTHH:MM]
import { execFileSync } from 'node:child_process';
const [, , dest, veh = 'diesel', when = '2026-11-13T08:00'] = process.argv;
for (const mode of ['tomtom', 'valhalla']) {
  const out = execFileSync('node', [new URL('./engine_test.mjs', import.meta.url).pathname, dest, veh, when],
    { env: { ...process.env, MODE: mode }, encoding: 'utf8', timeout: 600000 });
  console.log(`===== ${mode === 'tomtom' ? 'COMPLÈTE (TomTom)' : 'ÉCONOME (Valhalla + vérif. TomTom)'}`);
  console.log(out.split('\n').filter((l) => !l.includes('GoogleMaps')).join('\n'));
}
