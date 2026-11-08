// Drive headless Chromium in real time (Chrome DevTools Protocol), wait for results, take a full-page screenshot.
// usage: node --experimental-websocket tests/screenshot.mjs URL out.png [waitSelector] [timeoutSec] [width]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [url, out, sel = '#results:not(.hidden), #error:not(.hidden)', tmo = '240', width = '412'] = process.argv.slice(2);
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--window-size=${width},900`, '--user-data-dir=/tmp/claude-1000/pm-chrome-' + port, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch { }
  await sleep(200);
}
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: +width, height: 900, deviceScaleFactor: 1, mobile: true });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url });
// optional: PM_PRE = JS run once the page is loaded, then the page is reloaded (e.g. fill localStorage);
//           PM_ACT = JS run after that reload (e.g. click a button)
if (process.env.PM_PRE || process.env.PM_ACT) {
  await sleep(2500);
  if (process.env.PM_PRE) { await send('Runtime.evaluate', { expression: process.env.PM_PRE }); await send('Page.reload', {}); await sleep(2500); }
  if (process.env.PM_ACT) await send('Runtime.evaluate', { expression: process.env.PM_ACT });
}
const t0 = Date.now();
let found = false;
while (Date.now() - t0 < +tmo * 1000) {
  const r = await send('Runtime.evaluate', { expression: `!!document.querySelector(${JSON.stringify(sel)})`, returnByValue: true });
  if (r?.result?.value) { found = true; break; }
  await sleep(1000);
}
await sleep(1500);
const m = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true });
const h = Math.min(6000, m.result.value);
await send('Emulation.setDeviceMetricsOverride', { width: +width, height: h, deviceScaleFactor: 1, mobile: true });
await sleep(800);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
const txt = await send('Runtime.evaluate', { expression: `(document.querySelector('#error:not(.hidden)')||{}).textContent||''`, returnByValue: true });
console.log(found ? `ok after ${Math.round((Date.now() - t0) / 1000)} s, height ${h}` : 'TIMEOUT', txt.result.value);
ws.close(); chrome.kill();
