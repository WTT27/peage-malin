// Automatic stop of the e-208 charge at 6:00 (D-038). The MyPeugeot app can program the START of the charge (22:00,
// off-peak) but not its end; on Tempo red days the day hours (6:00–22:00) cost about 5× the night price.
// Every morning at 05:50 (cron): if the car is charging, the charge is stopped — always on a red day; on other days
// unless Thomas asked from Péage Malin ("Ne pas arrêter demain matin"). "Stop" = back to the programmed (delayed)
// charge, so the car starts again by itself at its programmed hour the next night. Result sent to the ntfy app.
//
//   node car/charge.mjs setup     one-time: SMS code + MyPeugeot PIN (typed by Thomas, hidden), daily job installed
//   node car/charge.mjs check     connection test (no command sent to the car)
//   node car/charge.mjs stop      stop the charge now          node car/charge.mjs start   start it now
//   node car/charge.mjs morning   the daily 05:50 job
//
// Remote commands go through car/remote.py (Python environment ~/.config/peage-malin-car/venv). Secrets stay in
// ~/.config/peage-malin-car/ (remote.json, otp.pickle, mode 600).
import { spawnSync, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIR, appConfig, token, vehicles, status, digest, readJson, writeJson, log } from './peugeot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(DIR, 'venv', 'bin', 'python');
const API = 'https://api.groupe-psa.com';
const conf = readJson('car.json');
if (!conf?.vehicleId) { console.log('Lancer d\'abord : node car/setup.mjs'); process.exit(1); }
const cmd = process.argv[2] || 'check';
const parisDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });        // YYYY-MM-DD
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------
async function psa(path, { method = 'GET', body = null, extra = {} } = {}) {
  const c = await appConfig();
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${path}${sep}client_id=${c.id}&locale=${c.locale}`, { method,
    headers: { Authorization: 'Bearer ' + await token(), 'User-Agent': 'okhttp/4.8.0', Accept: 'application/hal+json',
      'x-introspect-realm': c.realm, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, j, txt };
}
function py(input, timeoutMs = 150e3) {
  if (!existsSync(PY)) throw new Error('environnement Python absent : relancer  node car/charge.mjs setup');
  const r = spawnSync(PY, [join(HERE, 'remote.py')], { input: JSON.stringify(input), encoding: 'utf8', timeout: timeoutMs });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  if (r.status !== 0 && !lines.length) throw new Error('remote.py : ' + (r.stderr || '').trim().split('\n').pop());
  return lines;
}
async function alert(title, lines, priority = 3, tags = ['electric_plug']) {
  try {
    await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: `${conf.topic}-alerte`, title, message: lines.join('\n'), priority, tags }) });
  } catch (e) { log('alert error:', e.message); }
}
// Tempo colour of a day: 1 blue, 2 white, 3 red, 0 unknown (free public service, cached by poll.mjs in state.json)
async function tempo(date) {
  try {
    const j = await (await fetch(`https://www.api-couleur-tempo.fr/api/jourTempo/${date}`, { signal: AbortSignal.timeout(15000) })).json();
    if (j?.codeJour) return j.codeJour;
  } catch { /* use the cache */ }
  return readJson('state.json', {})?.tempo?.[date] ?? 0;
}
const COLOR = ['inconnue', 'Bleu', 'Blanc', 'ROUGE'];

// MQTT token for remote commands: refresh token (valid 3 days, renewed at each use) or a new OTP code (≤ 6 a day)
async function mqttToken(force = false) {
  const rem = readJson('remote.json');
  if (!rem) throw new Error('commandes à distance pas activées : lancer  node car/charge.mjs setup');
  const m = rem.mqtt || {};
  if (!force && m.access && m.exp - Date.now() > 60e3) return m.access;
  const url = '/connectedcar/v4/virtualkey/remoteaccess/token';
  let r = null;
  if (m.refresh && m.refreshExp > Date.now()) {
    r = await psa(url, { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: m.refresh } });
    if (!r.j?.access_token) log('mqtt refresh refused:', r.status);
  }
  if (!r?.j?.access_token) {
    const day = parsedDay(rem);
    if (day.n >= 5) throw new Error('trop de codes de sécurité demandés aujourd\'hui (limite Peugeot : 6 par jour)');
    const o = py({ cmd: 'otp' }).find((x) => 'otp' in x || x.error);
    if (!o?.otp) throw new Error('code de sécurité impossible : ' + (o?.error || '?') + ' — relancer  node car/charge.mjs setup');
    day.n++; rem.otpDay = day;
    r = await psa(url, { method: 'POST', body: { grant_type: 'password', password: o.otp } });
    if (!r.j?.access_token) { writeJson('remote.json', rem); throw new Error(`jeton de commande refusé (${r.status})`); }
  }
  rem.mqtt = { access: r.j.access_token, exp: Date.now() + (+r.j.expires_in || 900) * 1000,
    refresh: r.j.refresh_token || m.refresh, refreshExp: r.j.refresh_token ? Date.now() + 3 * 86400e3 - 3600e3 : m.refreshExp };
  writeJson('remote.json', rem);
  return rem.mqtt.access;
}
function parsedDay(rem) { const d = parisDate(); return rem.otpDay?.date === d ? rem.otpDay : { date: d, n: 0 }; }

// one command; a "400" answer (token refused) → new token and one more try
async function command(service, params) {
  const rem = readJson('remote.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await mqttToken(attempt > 0);
    const out = py({ cmd: 'send', token: tok, customer_id: rem.customerId, vin: rem.vin, service, params, wait: 90 });
    const end = out.find((x) => x.event === 'end') || {}, codes = end.codes || [];
    const err = out.find((x) => x.event === 'connect_error' || x.event === 'connect_refused' || x.error);
    log(service, JSON.stringify(params), '→', codes.join(',') || 'no reply', err ? JSON.stringify(err) : '');
    if (codes.includes('400') && attempt === 0) continue;
    const reply = out.filter((x) => x.event === 'reply').pop();
    return { ok: codes.some((c) => c === '0' || c === '1'), codes, reply, err };
  }
}
async function carNow() {
  const raw = await status(conf.vehicleId);
  const el = (raw.energies || []).find((e) => e.type === 'Electric') || {};
  const ch = el.extension?.electric?.charging || {};
  const m = String(ch.nextDelayedTime || 'PT22H').match(/PT(?:(\d+)H)?(?:(\d+)M)?/) || [];
  return { ...digest(raw), program: { hour: +(m[1] || 0), minute: +(m[2] || 0) }, mode: ch.chargingMode };
}
const stopCharge = (car) => command('/VehCharge', { program: car.program, type: 'delayed' });
const startCharge = (car) => command('/VehCharge', { program: car.program, type: 'immediate' });
const hm = (p) => `${p.hour} h ${String(p.minute).padStart(2, '0')}`;
function remember(last) { const c = readJson('charge.json', {}); c.last = { at: Date.now(), ...last }; writeJson('charge.json', c); }

// ---------- commands ----------
function ask(q, hidden = false) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); else if (!/[\r\n]/.test(s)) process.stdout.write('*'); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); });
  });
}

if (cmd === 'setup') {
  if (!existsSync(PY)) {
    console.log('Installation de l\'environnement Python (une fois)…');
    execSync(`python3 -m venv "${join(DIR, 'venv')}" && "${PY}" -m pip install -q pycryptodome "paho-mqtt>=2" requests`, { stdio: 'inherit' });
  }
  const assoc = await psa('/applications/cvs/v4/mauv/car-associations', { extra: { 'x-transaction-id': '1234' } });
  const customerId = Array.isArray(assoc.j) && assoc.j[0]?.customer;
  if (!customerId) { console.log('❌ Compte client introuvable (' + assoc.status + ').'); process.exit(1); }
  const vin = (await vehicles()).find((v) => v.id === conf.vehicleId)?.vin;
  if (!vin) { console.log('❌ Véhicule introuvable.'); process.exit(1); }
  const sms = await psa('/applications/cvs/v4/mobile/smsCode', { method: 'POST' });
  if (!sms.ok) { console.log(`❌ Peugeot refuse d'envoyer le SMS (${sms.status}) : ${sms.txt.slice(0, 200)}`); process.exit(1); }
  console.log('📱 Peugeot vient de vous envoyer un SMS avec un code.');
  const code = await ask('Code reçu par SMS : ');
  const pin = await ask('Code PIN de l\'appli MyPeugeot (4 chiffres) : ', true);
  const dev = (await token()).slice(0, 16);
  const act = py({ cmd: 'activate', sms: code, pin, device_id: dev }).find((x) => 'ok' in x);
  if (!act?.ok) { console.log('❌ Activation refusée : ' + (act?.error || '?') + '\nVérifiez le code SMS et le PIN, puis relancez.'); process.exit(1); }
  writeJson('remote.json', { customerId, vin, mqtt: {} });
  await mqttToken(true);
  const t = py({ cmd: 'send', token: readJson('remote.json').mqtt.access, customer_id: customerId, vin, wait: 30 });
  if (!t.some((x) => x.event === 'connected')) { console.log('❌ Connexion au serveur de commandes impossible : ' + JSON.stringify(t)); process.exit(1); }
  console.log('✅ Commandes à distance activées.');
  // daily job at 05:50 (replaces an older line)
  const line = `50 5 * * * cd ${dirname(HERE)} && ${process.execPath} --experimental-websocket car/charge.mjs morning >> ${join(DIR, 'charge.log')} 2>&1`;
  let tab = ''; try { tab = execSync('crontab -l', { encoding: 'utf8' }); } catch { /* empty */ }
  tab = tab.split('\n').filter((l) => l.trim() && !l.includes('car/charge.mjs')).join('\n') + '\n' + line + '\n';
  execSync('crontab -', { input: tab });
  console.log('✅ Arrêt automatique installé : chaque matin à 5 h 50 (toujours les jours rouges).');
  await alert('🔌 Arrêt de charge activé', ['La charge sera arrêtée chaque matin vers 6 h (toujours les jours Tempo rouges).'], 3);
  console.log('\nPour tester à côté de la voiture branchée :  node car/charge.mjs stop   puis   node car/charge.mjs start');
  process.exit(0);
}

if (cmd === 'check') {
  const rem = readJson('remote.json');
  if (!rem) { console.log('Pas encore activé : node car/charge.mjs setup'); process.exit(1); }
  const t = py({ cmd: 'send', token: await mqttToken(), customer_id: rem.customerId, vin: rem.vin, wait: 30 });
  const car = await carNow();
  console.log(t.some((x) => x.event === 'connected') ? '✅ Serveur de commandes joignable.' : '❌ ' + JSON.stringify(t));
  console.log(`Voiture : ${car.level} %, charge ${car.charging}, branchée ${car.plugged ? 'oui' : 'non'}, départ programmé ${hm(car.program)}`);
  process.exit(0);
}

if (cmd === 'stop' || cmd === 'start') {
  const car = await carNow();
  console.log(`Voiture : ${car.level} %, charge ${car.charging}, départ programmé ${hm(car.program)}. Envoi de la commande (jusqu'à 90 s)…`);
  const r = await (cmd === 'stop' ? stopCharge(car) : startCharge(car));
  console.log(r.ok ? '✅ Commande acceptée par la voiture.' : `❌ Pas de confirmation (codes ${r.codes.join(',') || 'aucun'}) ${r.reply ? JSON.stringify(r.reply) : ''}`);
  await sleep(60e3);
  const after = await carNow();
  console.log(`1 min après : charge ${after.charging} (${after.level} %)`);
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'morning') {
  const date = parisDate(), color = await tempo(date);
  const st = readJson('state.json', {});
  const skip = st.chargeSkip === date;
  const m = new Date().getMonth() + 1, wd = new Date().getDay();
  const maybeRed = color === 0 && (m >= 11 || m <= 3) && wd !== 0;           // colour unknown in the red season: be safe
  const red = color === 3 || maybeRed;
  // keep the remote-command token alive every day (refresh token valid 3 days), even with nothing to stop
  try { await mqttToken(); } catch (e) { log('token:', e.message); }
  let car;
  try { car = await carNow(); } catch (e) {
    log('status error', e.message);
    if (red) await alert('⚠️ Arrêt de charge : voiture injoignable', [`Jour ${COLOR[color]} : vérifiez la charge dans l'appli MyPeugeot.`], 5, ['warning']);
    process.exit(1);
  }
  log(`morning ${date} tempo ${COLOR[color]} skip ${skip} car ${car.level}% ${car.charging}`);
  const charging = /progress/i.test(car.charging || '') || (red && car.plugged && !/finished|stopped/i.test(car.charging || ''));
  if (!charging) { remember({ date, action: 'rien', color, level: car.level, detail: car.charging }); process.exit(0); }
  if (skip && !red) {
    remember({ date, action: 'laissée', color, level: car.level });
    await alert('🔌 Charge laissée en cours', [`Comme demandé : la charge continue ce matin (jour ${COLOR[color]}, batterie ${car.level} %).`], 2);
    process.exit(0);
  }
  for (let i = 0; i < 3; i++) {
    const r = await stopCharge(car).catch((e) => ({ ok: false, codes: [], err: e.message }));
    await sleep(45e3);
    const after = await carNow().catch(() => null);
    if (after && !/progress/i.test(after.charging || '')) {
      remember({ date, action: 'arrêtée', color, level: after.level });
      await alert(`🔌 Charge arrêtée à ${after.level} %`, [`Jour ${COLOR[color]}${skip && red ? ' : arrêt obligatoire malgré votre demande' : ''}. Reprise automatique à ${hm(car.program)}.`], 2);
      process.exit(0);
    }
    log('still charging after attempt', i + 1, JSON.stringify(r?.codes || r?.err));
    car = after || car;
  }
  remember({ date, action: 'échec', color, level: car.level });
  await alert('⚠️ La charge n\'a pas pu être arrêtée', [`Jour ${COLOR[color]} : arrêtez-la dans l'appli MyPeugeot.`], red ? 5 : 4, ['warning']);
  process.exit(1);
}
console.log('Commandes : setup | check | stop | start | morning');
