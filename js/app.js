import { loadTolls, tollData } from './tolls.js';
import { analyse, ladder, googleMapsUrl, DEFAULT_VEHICLES } from './optimizer.js';
import { geocode, getKey, setKey, dieselPrice, stats } from './services.js';
import { hm, eur } from './geo.js';

const $ = (id) => document.getElementById(id);
const state = { from: null, to: null, veh: 'diesel', result: null, selected: null };

// ---------- settings ----------
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('vehicles') || '{}'); } catch { /* ignore */ }
  return { diesel: { ...DEFAULT_VEHICLES.diesel, ...(s.diesel || {}) }, ev: { ...DEFAULT_VEHICLES.ev, ...(s.ev || {}) } };
}
let V = loadSettings();
const engineMode = () => { try { return localStorage.getItem('engineMode') || 'tomtom'; } catch { return 'tomtom'; } };
const saveSettings = () => { try { localStorage.setItem('vehicles', JSON.stringify(V)); } catch { /* ignore */ } };

// key passed once in the URL fragment: …/#key=XXXX  (never sent to any server)
const m = location.hash.match(/key=([A-Za-z0-9]+)/);
if (m) { setKey(m[1]); history.replaceState(null, '', location.pathname + location.search); }

$('btnSettings').onclick = () => {
  $('sKey').value = getKey();
  $('sLper100').value = V.diesel.lPer100; $('sDiesel').value = V.diesel.eurPerL;
  $('sKwhM').value = V.ev.kwhMotorway; $('sKwhO').value = V.ev.kwhOther; $('sBatt').value = V.ev.batteryKwh;
  $('sHome').value = V.ev.homeEurKwh; $('sFast').value = V.ev.fastEurKwh;
  $('sMode').value = engineMode();
  const dv = tollData(); $('dataVersion').textContent = dv ? dv.note : '';
  $('settings').showModal();
};
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'ok') return;
  setKey($('sKey').value);
  const num = (id, def) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x > 0 ? x : def; };
  V.diesel.lPer100 = num('sLper100', V.diesel.lPer100); V.diesel.eurPerL = num('sDiesel', V.diesel.eurPerL);
  V.diesel.priceSetByUser = true;
  V.ev.kwhMotorway = num('sKwhM', V.ev.kwhMotorway); V.ev.kwhOther = num('sKwhO', V.ev.kwhOther);
  try { localStorage.setItem('engineMode', $('sMode').value); } catch { /* ignore */ }
  V.ev.batteryKwh = num('sBatt', V.ev.batteryKwh); V.ev.homeEurKwh = num('sHome', V.ev.homeEurKwh); V.ev.fastEurKwh = num('sFast', V.ev.fastEurKwh);
  saveSettings();
});

// ---------- form ----------
function setNow() {
  const d = new Date(); d.setSeconds(0, 0);
  const p = (x) => String(x).padStart(2, '0');
  $('when').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
setNow();
$('btnNow').onclick = setNow;

document.querySelectorAll('#vehSeg button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#vehSeg button').forEach((x) => x.classList.toggle('on', x === b));
  state.veh = b.dataset.v;
});

try {
  const last = JSON.parse(localStorage.getItem('lastTrip') || 'null');
  if (last) { $('from').value = last.from.label; state.from = last.from.pt; $('to').value = last.to.label; state.to = last.to.pt; }
} catch { /* ignore */ }

function suggest(inputId, listId, key) {
  let timer = null;
  $(inputId).addEventListener('input', () => {
    state[key] = null;
    clearTimeout(timer);
    const q = $(inputId).value;
    if (q.length < 3) { $(listId).innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const res = await geocode(q);
        $(listId).innerHTML = '';
        for (const r of res) {
          const li = document.createElement('li');
          li.textContent = r.label;
          li.onclick = () => { $(inputId).value = r.label.split(',').slice(0, 2).join(','); state[key] = r.pt; $(listId).innerHTML = ''; };
          $(listId).appendChild(li);
        }
      } catch { /* ignore */ }
    }, 450);
  });
}
suggest('from', 'fromSuggest', 'from');
suggest('to', 'toSuggest', 'to');

$('btnHere').onclick = () => {
  if (!navigator.geolocation) return;
  $('from').value = 'Recherche de la position…';
  navigator.geolocation.getCurrentPosition(
    (p) => { state.from = [p.coords.latitude, p.coords.longitude]; $('from').value = 'Ma position'; },
    () => { $('from').value = ''; showError('Position indisponible'); }, { enableHighAccuracy: true, timeout: 15000 });
};

function showError(msg) { $('error').textContent = msg; $('error').classList.remove('hidden'); }

async function resolve(key, inputId) {
  if (state[key]) return state[key];
  const res = await geocode($(inputId).value);
  if (!res.length) throw new Error(`Adresse introuvable : ${$(inputId).value}`);
  state[key] = res[0].pt;
  return res[0].pt;
}

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('error').classList.add('hidden');
  $('results').classList.add('hidden');
  if (!getKey()) { showError('Entrez d\'abord votre clé TomTom dans les Réglages (⚙︎).'); return; }
  $('btnGo').disabled = true;
  $('progress').classList.remove('hidden');
  try {
    const o = await resolve('from', 'from');
    const d = await resolve('to', 'to');
    try { localStorage.setItem('lastTrip', JSON.stringify({ from: { label: $('from').value, pt: o }, to: { label: $('to').value, pt: d } })); } catch { /* ignore */ }
    if (!tollData()) await loadTolls();
    const v = { ...V[state.veh] };
    if (v.type === 'diesel' && !V.diesel.priceSetByUser) {
      const p = await dieselPrice();
      if (p) { v.eurPerL = p; V.diesel.eurPerL = p; saveSettings(); }
    }
    const depart = $('when').value ? new Date($('when').value) : new Date();
    const t0 = Date.now();
    stats.api = 0; stats.cached = 0; stats.valhalla = 0;
    const res = await analyse(o, d, v, depart, (f, txt) => {
      $('barFill').style.width = `${Math.round(f * 100)}%`;
      $('progressText').textContent = txt;
    }, { estimator: engineMode() });
    state.result = { ...res, o, d, v, secs: Math.round((Date.now() - t0) / 1000) };
    render();
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    $('btnGo').disabled = false;
    $('progress').classList.add('hidden');
  }
});

// ---------- results ----------
function routeCard(e, { compact = false } = {}) {
  const { o, d } = state.result;
  const div = document.createElement('div');
  div.className = 'route' + (state.selected === e ? ' sel' : '');
  const badges = (e.best ? '<span class="badge best">⭐ Meilleur compromis</span> ' : '') +
    (e.freeWin ? '<span class="badge free">🟢 Gain gratuit</span> ' : '');
  const dm = Math.round(e.dMin);
  const lost = dm === 0 ? 'même durée' : dm < 0 ? `${dm} min` : `+${dm} min`;
  div.innerHTML = `
    <div class="head"><span class="save">${e.isRef ? 'Le plus rapide' : '−' + eur(e.save)}</span><span class="lost">${lost}</span></div>
    ${badges ? `<div>${badges}</div>` : ''}
    <div class="label">${escapeHtml(e.label)}</div>
    <div class="meta">${hm(e.min)} · ${Math.round(e.km)} km · péages ${eur(e.toll)} · ${state.result.v.type === 'ev' ? 'électricité' : 'gazole'} ${eur(e.energy)}${e.chargeMin ? ` · recharge ≈ ${Math.round(e.chargeMin)} min` : ''}</div>
    <div class="actions">
      <a class="gm" target="_blank" rel="noopener" href="${googleMapsUrl(o, d, e.via)}">Ouvrir dans Google Maps</a>
    </div>`;
  if (compact) div.querySelector('.label').style.fontWeight = '600';
  return div;
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render() {
  const { eff, count, secs } = state.result;
  const f0 = eff.find((e) => e.isRef) || eff[0];
  const cheapest = eff.reduce((a, b) => (b.cost < a.cost ? b : a));
  const best = eff.find((e) => e.best);
  const wins = eff.filter((e) => e.freeWin);
  $('summary').innerHTML = `
    <h2>Le plus rapide : ${hm(f0.min)} · ${eur(f0.cost)}</h2>
    <p class="hint" style="margin-top:0">dont péages ${eur(f0.toll)}, ${state.result.v.type === 'ev' ? 'électricité' : 'gazole'} ${eur(f0.energy)}</p>
    <p>Économie maximale possible : <b>${eur(f0.cost - cheapest.cost)}</b> pour <b>+${Math.round(cheapest.min - f0.min)} min</b> (${escapeHtml(cheapest.label)}).</p>
    ${wins.length ? `<p>🟢 <b>Gain gratuit :</b> ${escapeHtml(wins[0].label)} — <b>−${eur(wins[0].save)}</b> pour ${Math.round(wins[0].dMin) <= 0 ? 'la même durée' : '+' + Math.round(wins[0].dMin) + ' min'}.</p>` : ''}
    ${best ? `<p>⭐ <b>Meilleur compromis :</b> ${escapeHtml(best.label)} — <b>−${eur(best.save)}</b> pour <b>+${Math.round(best.dMin)} min</b> (${Math.round(best.pSave * 100)} % de l'économie possible pour ${Math.round(best.pTime * 100)} % du temps en plus).</p>` : ''}`;
  const maxD = Math.max(10, Math.ceil(Math.max(...eff.map((e) => e.dMin)) / 5) * 5);
  $('budget').max = String(maxD);
  if (+$('budget').value > maxD) $('budget').value = String(Math.min(30, maxD));
  renderBudget();
  renderChart();
  renderList();
  const { mode, notice } = state.result;
  $('footStats').textContent = `${notice ? notice + ' · ' : ''}Méthode ${mode === 'valhalla' ? 'économe' : 'complète'} · ` +
    `${count} itinéraires évalués, ${eff.length} retenus · ${stats.api} requêtes TomTom` +
    `${stats.cached ? ` (+${stats.cached} déjà en mémoire)` : ''}${stats.valhalla ? ` · ${stats.valhalla} estimations gratuites` : ''} · ${secs} s`;
  $('results').classList.remove('hidden');
  $('results').scrollIntoView({ behavior: 'smooth' });
}

function renderBudget() {
  const b = +$('budget').value;
  const { eff } = state.result;
  const ok = eff.filter((e) => e.dMin <= b);
  const e = ok.reduce((a, x) => (x.cost < a.cost ? x : a));
  $('budgetText').textContent = `Jusqu'à +${b} min → économie ${eur(e.save)}`;
  $('budgetRoute').innerHTML = '';
  $('budgetRoute').appendChild(routeCard(e, { compact: true }));
}
$('budget').addEventListener('input', renderBudget);

function renderList() {
  $('list').innerHTML = '';
  for (const e of state.result.eff) $('list').appendChild(routeCard(e));
}

function renderChart() {
  const { eff } = state.result;
  const W = 640, H = 340, L = 70, B = 46, Rm = 16, T = 16;
  const maxX = Math.max(10, ...eff.map((e) => e.dMin)), maxY = Math.max(1, ...eff.map((e) => e.save));
  const x = (v) => L + (W - L - Rm) * Math.max(0, v) / maxX;
  const y = (v) => H - B - (H - B - T) * Math.max(0, v) / maxY;
  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Économie en euros selon les minutes perdues">`;
  const ticks = (max, n) => { const step = Math.max(1, Math.ceil(max / n / 5) * 5); const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(v); return out; };
  for (const v of ticks(maxX, 6)) s += `<line x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}" stroke="${c('--line')}"/><text x="${x(v)}" y="${H - B + 28}" fill="${c('--muted')}" font-size="20" text-anchor="middle">+${v}′</text>`;
  const ystep = maxY > 40 ? 10 : 5;
  for (let v = 0; v <= maxY + 1e-9; v += ystep) s += `<line x1="${L}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}" stroke="${c('--line')}"/><text x="${L - 6}" y="${y(v) + 4}" fill="${c('--muted')}" font-size="20" text-anchor="end">${v} €</text>`;
  s += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(maxX)}" y2="${y(maxY)}" stroke="${c('--muted')}" stroke-dasharray="4 4" opacity=".6"/>`;
  const pts = eff.filter((e) => e.save >= 0).sort((a, b) => a.dMin - b.dMin);
  s += `<polyline fill="none" stroke="${c('--accent')}" stroke-width="2" points="${pts.map((e) => `${x(e.dMin)},${y(e.save)}`).join(' ')}"/>`;
  pts.forEach((e) => {
    const col = e.best ? c('--best') : e.freeWin ? c('--good') : c('--accent');
    const r = state.selected === e ? 12 : 8;
    s += `<circle class="pt" data-i="${eff.indexOf(e)}" cx="${x(e.dMin)}" cy="${y(e.save)}" r="${r}" fill="${col}" stroke="${c('--card')}" stroke-width="2"/>`;
  });
  s += `<text x="${W - Rm}" y="${H - 4}" fill="${c('--muted')}" font-size="20" text-anchor="end">minutes en plus</text></svg>`;
  $('chart').innerHTML = s;
  $('chart').querySelectorAll('.pt').forEach((el) => el.addEventListener('click', () => {
    state.selected = eff[+el.dataset.i];
    renderChart(); renderList();
    const idx = state.result.eff.indexOf(state.selected);
    $('list').children[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

// Pre-filled trips from the URL: ?de=Maison&from=49.003,1.3155&a=Bordeaux&to=44.84,-0.58&veh=ev&go=1
(() => {
  const q = new URLSearchParams(location.search);
  const pt = (s) => { const m2 = (s || '').match(/^(-?[\d.]+),(-?[\d.]+)$/); return m2 ? [+m2[1], +m2[2]] : null; };
  if (pt(q.get('from'))) { state.from = pt(q.get('from')); $('from').value = q.get('de') || q.get('from'); }
  if (pt(q.get('to'))) { state.to = pt(q.get('to')); $('to').value = q.get('a') || q.get('to'); }
  if (q.get('veh') === 'ev' || q.get('veh') === 'diesel') document.querySelector(`#vehSeg button[data-v="${q.get('veh')}"]`).click();
  if (q.get('quand')) $('when').value = q.get('quand');
  if (q.get('go') === '1') loadTolls().then(() => $('form').requestSubmit());
})();

loadTolls().catch(() => showError('Impossible de charger les tarifs des péages'));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
