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
const cmd = process.argv[2] || (readJson('remote.json')?.mqtt?.refresh ? 'check' : 'setup');      // not fully set up yet → setup
const parisDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });        // YYYY-MM-DD
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------
async function psa(path, { method = 'GET', body = null, extra = {}, locale = true } = {}) {
  const c = await appConfig();
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${path}${sep}client_id=${c.id}${locale ? '&locale=' + c.locale : ''}`, { method,
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
    r = await psa(url, { method: 'POST', locale: false, body: { grant_type: 'refresh_token', refresh_token: m.refresh } });
    if (!r.j?.access_token) log('mqtt refresh refused:', r.status, r.txt.slice(0, 300));
  }
  if (!r?.j?.access_token) {
    const day = parsedDay(rem);
    if (day.n >= 5) throw new Error('trop de codes de sécurité demandés aujourd\'hui (limite Peugeot : 6 par jour)');
    const o = py({ cmd: 'otp' }).find((x) => 'otp' in x || x.error);
    if (!o?.otp) throw new Error('code de sécurité impossible : ' + (o?.error || '?') + ' — relancer  node car/charge.mjs setup');
    day.n++; rem.otpDay = day;
    r = await psa(url, { method: 'POST', locale: false, body: { grant_type: 'password', password: o.otp } });
    if (!r.j?.access_token) {
      writeJson('remote.json', rem);
      log('mqtt token refused:', r.status, r.txt.slice(0, 500));
      throw new Error(`jeton de commande refusé (${r.status}) : ${r.txt.slice(0, 500)}`);
    }
  }
  rem.mqtt = { access: r.j.access_token, exp: Date.now() + (+r.j.expires_in || 900) * 1000,
    refresh: r.j.refresh_token || m.refresh, refreshExp: r.j.refresh_token ? Date.now() + 3 * 86400e3 - 3600e3 : m.refreshExp };
  writeJson('remote.json', rem);
  return rem.mqtt.access;
}
function parsedDay(rem) { const d = parisDate(); return rem.otpDay?.date === d ? rem.otpDay : { date: d, n: 0 }; }

// one command; a "400" answer (token refused) → new token and one more try.
// Replies: 900 = taken by Peugeot, 901 = sent to the car, 903 = car awake and working on it, 0/1 = done.
// A sleeping car (night, garage) can take 2–3 minutes to answer: wait up to `wait` s.
async function command(service, params, wait = 180) {
  const rem = readJson('remote.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await mqttToken(attempt > 0);
    const out = py({ cmd: 'send', token: tok, customer_id: rem.customerId, vin: rem.vin, service, params, wait }, wait * 1000 + 60e3);
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
  const ac = (raw.preconditionning || raw.preconditioning)?.airConditioning || {};
  return { ...digest(raw), program: { hour: +(m[1] || 0), minute: +(m[2] || 0) }, mode: ch.chargingMode, ac };
}
// wake the car up first (asks it for its charging state): a sleeping car missed the 6:00 stop on 2026-11-12
const wakeUp = () => command('/VehCharge/state', { action: 'state' }, 150).catch((e) => ({ ok: false, codes: [], err: e.message }));
// state after a command: only a report sent by the car after `since` counts (the server keeps the last one it got)
async function stateSince(since) {
  for (let i = 0; i < 4; i++) {
    const c = await carNow().catch(() => null);
    if (c && Date.parse(c.carAt) >= since - 30e3) return c;
    await sleep(30e3);
  }
  return null;
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
  const prev = readJson('remote.json');
  if (prev?.customerId && existsSync(join(DIR, 'otp.pickle'))) {
    console.log('Activation déjà faite (pas besoin de nouveau SMS) : on reprend à l\'étape suivante.');
  } else {
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
  }
  const { customerId, vin } = readJson('remote.json');
  try { await mqttToken(true); } catch (e) { console.log('❌ ' + e.message + '\nCopiez ce message à Claude.'); process.exit(1); }
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

// one command at a time (the morning job, a test in the terminal and the app buttons could otherwise overlap)
function lock() {
  const l = readJson('charge.lock', null);
  if (l && Date.now() - l.at < 15 * 60e3) return false;
  writeJson('charge.lock', { at: Date.now(), cmd });
  process.on('exit', () => writeJson('charge.lock', { at: 0 }));
  return true;
}

// stop / start now: from the terminal, or from the app buttons ("--app": relayed by poll.mjs, result sent to the phone)
if (cmd === 'stop' || cmd === 'start') {
  const app = process.argv.includes('--app'), word = cmd === 'stop' ? 'Arrêt' : 'Démarrage';
  const done = (ok, msg) => { const c = readJson('charge.json', {}); c.manual = { at: Date.now(), action: cmd, ok, msg }; writeJson('charge.json', c); };
  if (!lock()) {
    console.log('Une autre commande est déjà en cours : réessayez dans quelques minutes.');
    if (app) { done(false, 'une autre commande était déjà en cours'); await alert(`⚠️ ${word} de la charge pas envoyé`, ['Une autre commande était déjà en cours : réessayez dans quelques minutes.'], 3); }
    process.exit(1);
  }
  let car;
  try { car = await carNow(); } catch (e) {
    if (app) { done(false, 'voiture injoignable'); await alert(`⚠️ ${word} de la charge impossible`, ['Peugeot ne répond pas : ' + e.message], 4, ['warning']); }
    throw e;
  }
  console.log(`Voiture : ${car.level} %, charge ${car.charging}, branchée ${car.plugged ? 'oui' : 'non'}, départ programmé ${hm(car.program)}. Réveil de la voiture puis envoi de la commande (jusqu'à 6 min)…`);
  log(`manual ${cmd}${app ? ' (app)' : ''}: car ${car.level} %, ${car.charging}, plugged ${car.plugged}`);
  if (app && !car.plugged) {
    done(false, 'voiture pas branchée');
    await alert(`🔌 ${word} de la charge : rien envoyé`, [`La voiture n'est pas branchée (${car.level} %).`], 3);
    process.exit(1);
  }
  const w = await wakeUp();
  log(`wake-up: ${w.ok ? 'awake' : 'no confirmation ' + (w.codes?.join(',') || w.err || '')}`);
  let r;
  try { r = await (cmd === 'stop' ? stopCharge(car) : startCharge(car)); } catch (e) { r = { ok: false, codes: [], error: e.message }; }
  console.log(r.ok ? '✅ Commande acceptée par la voiture.' : `❌ Pas de confirmation (codes ${r.codes.join(',') || 'aucun'}) ${r.error || (r.reply ? JSON.stringify(r.reply) : '')}`);
  await sleep(60e3);
  let after = null;
  try { after = await carNow(); } catch { /* keep going */ }
  const now = after ? `${after.charging === 'InProgress' ? 'en charge' : 'pas en charge'} (${after.level} %)` : 'état inconnu';
  console.log(`1 min après : charge ${after?.charging ?? '?'} (${after?.level ?? '?'} %)`);
  log(`manual ${cmd}: ${r.ok ? 'accepted' : 'no confirmation ' + (r.codes.join(',') || r.error || '')}, after: ${after?.charging}`);
  const worked = cmd === 'stop' ? after?.charging !== 'InProgress' : after?.charging === 'InProgress';
  if (app) {
    done(r.ok && worked, now);
    if (r.ok && worked) await alert(`✅ ${word} de la charge fait`, [`Voiture : ${now}.`], 3);
    else await alert(`⚠️ ${word} de la charge pas confirmé`, [`Voiture : ${now}.`, r.ok ? 'La voiture a accepté la commande mais son état n\'a pas encore changé.' : 'La voiture n\'a pas confirmé la commande.'], 4, ['warning']);
  }
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'morning') {
  for (let i = 0; i < 15 && !lock(); i++) await sleep(60e3);       // wait for a command from the app to finish
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
  // up to 4 tries over ~30 min: wake the car, send the stop, check with a fresh report; a pause between tries so two
  // requests never overlap (the third quick try of 2026-11-12 got a 502)
  for (let i = 0; i < 4; i++) {
    writeJson('charge.lock', { at: Date.now(), cmd });
    if (i > 0) await sleep(120e3);
    const w = await wakeUp();
    log(`wake-up ${i + 1}: ${w.ok ? 'awake' : 'no confirmation ' + (w.codes?.join(',') || w.err || '')}`);
    const t0 = Date.now();
    const r = await stopCharge(car).catch((e) => ({ ok: false, codes: [], err: e.message }));
    await sleep(30e3);
    const after = await stateSince(t0);
    if ((after && !/progress/i.test(after.charging || '')) || (r.ok && !after)) {
      const lvl = after?.level ?? car.level;
      remember({ date, action: 'arrêtée', color, level: lvl });
      await alert(`🔌 Charge arrêtée à ${lvl} %`, [`Jour ${COLOR[color]}${skip && red ? ' : arrêt obligatoire malgré votre demande' : ''}. Reprise automatique à ${hm(car.program)}.`], 2);
      process.exit(0);
    }
    log('still charging after attempt', i + 1, JSON.stringify(r?.codes || r?.err), after ? 'fresh state ' + after.charging : 'no fresh state');
    car = after || car;
  }
  remember({ date, action: 'échec', color, level: car.level });
  await alert('⚠️ La charge n\'a pas pu être arrêtée', [`Jour ${COLOR[color]} : arrêtez-la dans l'appli MyPeugeot.`], red ? 5 : 4, ['warning']);
  process.exit(1);
}
// pre-heating now (from the app button): /ThermalPrecond {asap: activate}, sending back the car's own pre-heating
// programs unchanged (same message as psa_car_controller). The car heats (or cools) the cabin for about 30 min.
if (cmd === 'preheat') {
  const app = process.argv.includes('--app');
  const done = async (ok, msg, title) => {
    const c = readJson('charge.json', {}); c.manual = { at: Date.now(), action: 'preheat', ok, msg }; writeJson('charge.json', c);
    console.log(title, msg);
    if (app) await alert(title, [msg], ok ? 3 : 4, ok ? ['fire'] : ['warning']);
  };
  for (let i = 0; i < 15 && !lock(); i++) await sleep(60e3);
  let car;
  try { car = await carNow(); } catch (e) { await done(false, 'Peugeot ne répond pas : ' + e.message, '⚠️ Préchauffage impossible'); process.exit(1); }
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], programs = {};
  for (let k = 1; k <= 4; k++) programs['program' + k] = { day: [0, 0, 0, 0, 0, 0, 0], hour: 34, minute: 7, on: 0 };   // empty slot
  for (const p of car.ac.programs || []) {
    const t = String(p.start || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/) || [];
    if (p.slot >= 1 && p.slot <= 4) programs['program' + p.slot] = { day: DAYS.map((d) => +(p.occurence?.day || []).includes(d)),
      hour: +(t[1] || 0), minute: +(t[2] || 0), on: p.enabled ? 1 : 0 };
  }
  log(`preheat${app ? ' (app)' : ''}: car ${car.level} %, plugged ${car.plugged}, ac ${car.ac.status}`);
  const w = await wakeUp();
  log(`wake-up: ${w.ok ? 'awake' : 'no confirmation ' + (w.codes?.join(',') || w.err || '')}`);
  const r = await command('/ThermalPrecond', { asap: 'activate', programs }).catch((e) => ({ ok: false, codes: [], err: e.message }));
  await sleep(30e3);
  const after = await carNow().catch(() => null);
  const st = after?.ac?.status, on = /enabled|progress|running|on/i.test(st || '') && !/disabled/i.test(st || '');
  log(`preheat: ${r.ok ? 'accepted' : 'no confirmation ' + (r.codes.join(',') || r.err || '')}, after: ${st}`);
  if (r.ok || on) await done(true, `La voiture chauffe l'habitacle (environ 30 min${car.tempC != null ? `, ${car.tempC} °C dehors` : ''}).`, '🔥 Préchauffage lancé');
  else await done(false, `La voiture n'a pas confirmé (codes ${r.codes.join(',') || 'aucun'}).${!car.plugged && car.level < 50 ? ' Débranchée, elle refuse souvent sous 50 %.' : ''}`, '⚠️ Préchauffage pas confirmé');
  process.exit(r.ok || on ? 0 : 1);
}
console.log('Commandes : setup | check | stop | start | preheat | morning');
