// MyPeugeot connection for Thomas's e-208 (unofficial: the same login and API as the MyPeugeot phone app).
// Everything personal (password, tokens, history, channel name) lives in ~/.config/peage-malin-car/ (mode 600),
// never in this public repository. The app's public client id/secret are downloaded from the community project
// homeassistant-stellantis-vehicles (kept up to date there when Stellantis changes them).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DIR = join(homedir(), '.config', 'peage-malin-car');
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const CONFIGS_URL = 'https://raw.githubusercontent.com/andreadegiovine/homeassistant-stellantis-vehicles/main/custom_components/stellantis_vehicles/configs.json';
const API = 'https://api.groupe-psa.com';

export function readJson(name, def = null) {
  try { return JSON.parse(readFileSync(join(DIR, name), 'utf8')); } catch { return def; }
}
export function writeJson(name, data) {
  const p = join(DIR, name);
  writeFileSync(p, JSON.stringify(data, null, 1), { mode: 0o600 });
  chmodSync(p, 0o600);
}
export const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// app settings (client id/secret…) — refreshed from the community file at most once a day
export async function appConfig(force = false) {
  let c = readJson('app.json');
  if (!c || force || Date.now() - c.at > 86400e3) {
    try {
      const all = await (await fetch(CONFIGS_URL)).json();
      const p = all.MyPeugeot, fr = p.configs.FR;
      c = { at: Date.now(), oauth: p.oauth_url, realm: p.realm, scheme: p.scheme, locale: fr.locale, id: fr.client_id, secret: fr.client_secret };
      writeJson('app.json', c);
    } catch (e) { if (!c) throw new Error('Impossible de télécharger les réglages MyPeugeot : ' + e.message); }
  }
  return c;
}

const redirect = (c) => `${c.scheme}://oauth2redirect/fr`;
export const authorizeUrl = (c) => `${c.oauth}/am/oauth2/authorize?client_id=${c.id}&response_type=code&redirect_uri=${encodeURIComponent(redirect(c))}&scope=openid%20profile%20email&locale=${c.locale}`;

// Log in on Peugeot's own login page with a hidden Chromium; returns the one-time code of the app redirect.
export async function browserLogin(email, password, { debug = false } = {}) {
  const c = await appConfig();
  const port = 9900 + Math.floor(Math.random() * 400), prof = join(DIR, 'chrome-' + port);
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
    '--window-size=1280,800', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let ws;
    for (let i = 0; i < 60 && !ws; i++) {
      try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { /* not ready */ }
      if (!ws) await sleep(250);
    }
    if (!ws) throw new Error('Chromium ne démarre pas');
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0, code = null;
    const pending = new Map();
    const grab = (url) => { if (url && url.startsWith(c.scheme + ':')) { const m = url.match(/[?&]code=([^&]+)/); if (m) code = decodeURIComponent(m[1]); } };
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      if (d.method === 'Network.requestWillBeSent') grab(d.params.request.url);
      if (d.method === 'Page.frameRequestedNavigation') grab(d.params.url);
      if (d.method === 'Network.loadingFailed' || d.method === 'Page.navigatedWithinDocument') grab(d.params.url);
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const waitFor = async (sel, ms = 45000) => {
      for (let t = 0; t < ms; t += 400) { if (code) return false; if (await js(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(400); }
      throw new Error('élément introuvable sur la page de connexion : ' + sel);
    };
    const type = async (sel, text) => {
      await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ''; })()`);
      for (const ch of text) { await send('Input.insertText', { text: ch }); await sleep(30); }
    };
    await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');
    await send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
    await send('Page.navigate', { url: authorizeUrl(c) });
    const F = '#gigya-login-form';
    if (await waitFor(`${F} input[name="username"]`)) {
      await type(`${F} input[name="username"]`, email);
      await type(`${F} input[name="password"]`, password);
      await js(`document.querySelector('${F} input[type="submit"]').click()`);
      if (debug) log('login form sent');
      // consent page ("autoriser l'application"), then redirect to mymap://…?code=
      for (let t = 0; t < 60000 && !code; t += 500) {
        const err = await js(`(() => { const e = document.querySelector('.gigya-error-msg-active, .gigya-form-error-msg.gigya-error-msg-active'); return e ? e.textContent.trim() : ''; })()`);
        if (err) throw new Error('Peugeot refuse la connexion : ' + err);
        if (await js(`!!document.querySelector('#cvs_from input[type="submit"]')`)) {
          await js(`document.querySelector('#cvs_from input[type="submit"]').click()`);
          if (debug) log('consent sent');
          for (let u = 0; u < 20000 && !code; u += 300) await sleep(300);
          break;
        }
        await sleep(500);
      }
    }
    if (!code) {
      if (debug) log('page:', await js('location.href'), (await js('document.body.innerText'))?.slice(0, 500));
      throw new Error('code de connexion non reçu');
    }
    return code;
  } finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function tokenRequest(params) {
  const c = await appConfig();
  const url = `${c.oauth}/am/oauth2/access_token?${new URLSearchParams(params)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64') } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`jeton refusé (${r.status} ${j.error || ''} ${j.error_description || ''})`);
  const tok = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
  writeJson('tokens.json', tok);
  return tok;
}
export async function codeToTokens(code) {
  const c = await appConfig();
  return tokenRequest({ redirect_uri: redirect(c), grant_type: 'authorization_code', code });
}

// valid access token: refresh it when needed; if the refresh fails, log in again with the saved credentials
export async function token() {
  let t = readJson('tokens.json');
  if (t && t.exp - Date.now() > 120e3) return t.access;
  if (t?.refresh) {
    try { return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })).access; } catch (e) { log('refresh failed:', e.message); }
  }
  const cred = readJson('credentials.json');
  if (!cred) throw new Error('pas d\'identifiants : lancer d\'abord  node car/setup.mjs');
  log('new login with the saved credentials');
  return (await codeToTokens(await browserLogin(cred.email, cred.password))).access;
}

export async function api(path) {
  const c = await appConfig();
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}/connectedcar/v4/user${path}${sep}client_id=${c.id}&locale=${c.locale}`, {
    headers: { Authorization: 'Bearer ' + await token(), 'x-introspect-realm': c.realm, Accept: 'application/hal+json' } });
  if (r.status === 401) { const t = readJson('tokens.json'); if (t) { t.exp = 0; writeJson('tokens.json', t); } }
  if (!r.ok) throw new Error(`API ${r.status} ${path}`);
  return r.json();
}

export async function vehicles() {
  const j = await api('/vehicles');
  return (j._embedded?.vehicles || []).map((v) => ({ id: v.id, vin: v.vin, type: v.motorization, brand: v.brand }));
}

// the useful part of the car's status (no position is kept)
export function digest(s) {
  const el = (s.energies || s.energy || []).find((e) => e.type === 'Electric') || {};
  const bat = el.extension?.electric?.battery || {};
  const ch = el.extension?.electric?.charging || {};
  return {
    at: Date.now(),
    carAt: el.updatedAt || el.createdAt || s.lastPosition?.properties?.updatedAt || null,
    km: s.odometer?.mileage ?? null, kmAt: s.odometer?.createdAt ?? null,
    level: el.level ?? null,                                 // %
    autonomy: el.autonomy ?? null,                           // km (the car's own estimate)
    residualWh: bat.load?.residual ?? null, capacityWh: bat.load?.capacity ?? null,
    soh: bat.health?.capacity ?? null,
    charging: ch.status ?? null, plugged: ch.plugged ?? null,
    chargeKmH: ch.chargingRate ?? null, chargeLeft: ch.remainingTime ?? null, chargeMode: ch.chargingMode ?? null,   // km/h, ISO duration, Slow/Quick
    moving: s.kinetic?.moving ?? null, ignition: s.ignition?.type ?? null,
    tempC: s.environment?.air?.temp ?? null,                 // outside temperature (°C)
  };
}
export async function status(vid) { return api(`/vehicles/${vid}/status`); }
export { existsSync };
