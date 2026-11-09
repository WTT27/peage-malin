// One-time setup: asks for the MyPeugeot email and password (typed by Thomas, hidden), stores them in
// ~/.config/peage-malin-car/credentials.json (readable only by this user), logs in and shows the car's battery.
// Usage (in a terminal):  node car/setup.mjs
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { browserLogin, codeToTokens, vehicles, status, digest, readJson, writeJson, DIR } from './peugeot.mjs';

function ask(q, hidden = false) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); else if (!/[\r\n]/.test(s)) process.stdout.write('*'); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); });
  });
}

if (!globalThis.WebSocket) {          // Node 20: WebSocket needs a flag → restart with it
  const r = spawnSync(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
let cred = readJson('credentials.json');
if (!cred || process.argv.includes('--new')) {
  console.log('Identifiants MyPeugeot (ils restent sur cet ordinateur, dans ' + DIR + ').');
  const email = await ask('E-mail MyPeugeot : ');
  const password = await ask('Mot de passe MyPeugeot : ', true);
  cred = { email, password };
  writeJson('credentials.json', cred);
}
console.log('Connexion à MyPeugeot (30 s environ)…');
try {
  const code = await browserLogin(cred.email, cred.password, { debug: process.argv.includes('--debug') });
  await codeToTokens(code);
  console.log('✅ Connecté.');
} catch (e) {
  console.log('❌ ' + e.message);
  console.log('Si le mot de passe est faux, relancez :  node car/setup.mjs --new');
  process.exit(1);
}
const vs = await vehicles();
const ev = vs.find((v) => /elec/i.test(v.type || '')) || vs[0];
if (!ev) { console.log('Aucun véhicule sur ce compte.'); process.exit(1); }
const conf = readJson('car.json', {});
conf.vehicleId = ev.id;
conf.topic = conf.topic || 'pm-' + randomBytes(12).toString('hex');      // secret channel name for the phone
writeJson('car.json', conf);
const raw = await status(ev.id);
writeJson('status-raw.json', raw);                                         // for checking field names (stays local)
const d = digest(raw);
console.log(`Véhicule : ${ev.brand || ''} ${ev.type || ''}`);
console.log(`Batterie : ${d.level ?? '?'} %${d.residualWh ? ` (${(d.residualWh / 1000).toFixed(2)} kWh restants)` : ''} · autonomie annoncée ${d.autonomy ?? '?'} km · compteur ${d.km ?? '?'} km`);
console.log(`Données de la voiture datées du ${d.carAt || '?'}`);
console.log('\nSur le téléphone, ouvrez une fois ce lien (il relie Péage Malin à votre voiture, gardez-le pour vous) :');
console.log(`  https://wtt27.github.io/peage-malin/#car=${conf.topic}`);
