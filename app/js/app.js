import { loadTolls, tollData } from './tolls.js';
import { analyse, ladder, googleMapsUrl, DEFAULT_VEHICLES, checkTrip, prettyName, refineVia, refineLegs } from './optimizer.js';
import { geocode, getKey, setKey, dieselPrice, stats } from './services.js';
import { hm, eur } from './geo.js';
import { mergeStops, routeStations, evParams } from './charging.js';
import { tripTemp, planRates, kwhAt } from './temp.js';
import { fetchWinds, buildTerrain } from './terrain.js';
import { buildProfile, evaluate } from './enroute.js';

const $ = (id) => document.getElementById(id);
const state = { from: null, to: null, veh: 'diesel', result: null, selected: null };

// ---------- settings ----------
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('vehicles') || '{}'); } catch { /* ignore */ }
  const ev = { ...DEFAULT_VEHICLES.ev, ...(s.ev || {}) };
  if (!ev.model2) {          // one-time update to the charging model of Nov 2026 (Tempo blue/white average, 90 % start)
    if (ev.homeEurKwh === 0.14) ev.homeEurKwh = DEFAULT_VEHICLES.ev.homeEurKwh;
    delete ev.chargeKw; ev.model2 = true;
  }
  if (ev.usualPct == null) ev.usualPct = 100;  // usual departure battery once charged (Thomas leaves at 100 %, 2026-11-11)
  return { diesel: { ...DEFAULT_VEHICLES.diesel, ...(s.diesel || {}) }, ev };
}
let V = loadSettings();
const saveSettings = () => { try { localStorage.setItem('vehicles', JSON.stringify(V)); } catch { /* ignore */ } };

// key passed once in the URL fragment: …/#key=XXXX  (never sent to any server)
const m = location.hash.match(/key=([A-Za-z0-9]+)/);
if (m) setKey(m[1]);
// channel of Thomas's e-208 (posted by the program on his home computer): …/#car=pm-xxxx
const mc = location.hash.match(/car=(pm-[a-f0-9]+)/);
if (mc) { try { localStorage.setItem('carTopic', mc[1]); } catch { /* ignore */ } }
if (m || mc) history.replaceState(null, '', location.pathname + location.search);

$('btnSettings').onclick = () => {
  $('sKey').value = getKey();
  $('sLper100').value = V.diesel.lPer100; $('sDiesel').value = (Math.round(V.diesel.eurPerL * 100) / 100).toFixed(2);
  $('sKwhM').value = V.ev.kwhMotorway; $('sKwhMW').value = V.ev.kwhMotorwayWinter; $('sLunch').value = V.ev.lunchMin;
  $('sReserve').value = V.ev.reservePct; $('sKwhO').value = V.ev.kwhOther; $('sBatt').value = V.ev.batteryKwh;
  $('sUsual').value = V.ev.usualPct;
  $('sHome').value = V.ev.homeEurKwh; $('sFast').value = V.ev.fastEurKwh;
  $('sCar').value = carTopic();
  renderPlaceList();
  const dv = tollData(); $('dataVersion').textContent = dv ? dv.note : '';
  $('settings').showModal();
};
// car channel: saved as soon as it is typed (even if the settings are closed with the back button);
// accepts the code alone or the whole link, any case, stray spaces
const carCode = () => { const raw = $('sCar').value.toLowerCase().replace(/\s+/g, ''), m2 = raw.match(/pm-[a-f0-9]+/); return m2 ? m2[0] : raw; };
$('sCar').addEventListener('input', () => { try { localStorage.setItem('carTopic', carCode()); } catch { /* ignore */ } });
$('sCar').addEventListener('change', () => { $('sCar').value = carCode(); fetchCar(); });
$('settings').addEventListener('close', () => {
  fetchCar();
  if ($('settings').returnValue !== 'ok') return;
  setKey($('sKey').value);
  const num = (id, def) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x > 0 ? x : def; };
  V.diesel.lPer100 = num('sLper100', V.diesel.lPer100);
  const dp = num('sDiesel', V.diesel.eurPerL);              // a typed price stops the automatic daily price
  if (Math.abs(dp - Math.round(V.diesel.eurPerL * 100) / 100) > 0.001) { V.diesel.eurPerL = dp; V.diesel.priceSetByUser = true; }
  V.ev.kwhMotorway = num('sKwhM', V.ev.kwhMotorway); V.ev.kwhOther = num('sKwhO', V.ev.kwhOther);
  V.ev.kwhMotorwayWinter = num('sKwhMW', V.ev.kwhMotorwayWinter); V.ev.lunchMin = num('sLunch', V.ev.lunchMin);
  V.ev.reservePct = num('sReserve', V.ev.reservePct);
  V.ev.usualPct = Math.min(100, Math.max(20, num('sUsual', V.ev.usualPct)));
  try { localStorage.removeItem('engineMode'); } catch { /* ignore */ }
  V.ev.batteryKwh = num('sBatt', V.ev.batteryKwh); V.ev.homeEurKwh = num('sHome', V.ev.homeEurKwh); V.ev.fastEurKwh = num('sFast', V.ev.fastEurKwh);
  saveSettings();
});

// ---------- e-208 options on the main form (remembered on the phone) ----------
function fillEvBox() {
  $('evStart').value = V.ev.usualPct; $('evArrive').value = V.ev.arrivePct ?? '';
  $('evLunch').checked = !!V.ev.lunch; $('evNoCharge').checked = !!V.ev.noCharge;
  $('evLunch').disabled = $('evNoCharge').checked;
}
function readEvBox() {
  const st = parseFloat($('evStart').value), ar = parseFloat($('evArrive').value);
  V.ev.startPct = Number.isFinite(st) ? Math.min(100, Math.max(1, st)) : V.ev.usualPct;    // this search only
  V.ev.arrivePct = Number.isFinite(ar) && ar > 0 ? Math.min(90, ar) : null;
  V.ev.lunch = $('evLunch').checked; V.ev.noCharge = $('evNoCharge').checked;
  saveSettings();
}
fillEvBox();

// ---------- two tabs: route planner / my e-208 (remembered; opens on the e-208 while a trip is followed) ----------
function showTab(name, first = false) {
  for (const b of document.querySelectorAll('.tabs button')) { b.classList.toggle('on', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name); }
  $('tabRoute').classList.toggle('hidden', name !== 'route');
  $('tabCar').classList.toggle('hidden', name !== 'car');
  try { localStorage.setItem('tab', name); } catch { /* ignore */ }
  if (first) return;
  window.scrollTo({ top: 0 });
  if (name === 'car' && carTopic()) fetchCar();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);

// ---------- my e-208, read from the car (MyPeugeot → home computer → ntfy channel) ----------
const carTopic = () => { try { return localStorage.getItem('carTopic') || ''; } catch { return ''; } };
let car = (() => { try { return JSON.parse(localStorage.getItem('carLast') || 'null'); } catch { return null; } })(), startTouched = false;
$('evStart').addEventListener('input', () => { startTouched = true; });
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `il y a ${m} min` : m < 48 * 60 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
const dec = (x) => String(x).replace('.', ',');
// consumption law vs temperature learnt on the car's trips (D-040), as one readable line per road kind
function lawText(m, name) {
  if (!m) return '';
  const at = (T) => dec(kwhAt(m, T).toFixed(1));
  return `<p>${name} : <b>${at(15)}</b> à 15 °C · <b>${at(5)}</b> à 5 °C · <b>${at(0)}</b> à 0 °C <span class="old">(${m.km} km mesurés${m.enough ? '' : ', pas encore assez : réglages utilisés'}${m.fitted ? ', effet du froid appris' : ''})</span></p>`;
}
function renderCar() {
  const box = $('carLive'), mini = $('carMini');
  if (!carTopic()) {
    box.innerHTML = '<p>Pour suivre votre e-208 (batterie, conso réelle, arrêt de la charge), indiquez le canal de la voiture dans les Réglages ⚙︎.</p>';
    mini.classList.add('hidden'); return;
  }
  if (!car) { box.innerHTML = '<p class="old">Pas encore de données de la voiture…</p>'; mini.classList.add('hidden'); return; }
  const carT = Date.parse(car.carAt) || car.at, fresh = Date.now() - carT < 12 * 3600e3;
  const tm = car.tmodel || {}, law = lawText(tm.autoroute, 'Autoroute') + lawText(tm.autres, 'Autres routes');
  box.innerHTML = `
    <p class="big">🔋 <b>${car.level ?? '?'} %</b>${car.kwh != null ? ` (${dec(car.kwh.toFixed(1))} kWh)` : ''}${car.charging && /progress/i.test(car.charging) ? ' · ⚡ en charge' : ''}
      · reste <b>≈ ${car.remainingKm ?? '?'} km</b> <span class="old">(à ${dec(car.rateUsed)} kWh/100 km, jusqu'à 8 %)</span></p>
    ${car.live ? `<p>Conso réelle sur les ${car.live.km} derniers km : <b>${dec(car.live.kwh100)} kWh/100 km</b></p>` : ''}
    ${car.lastDrive ? `<p>Dernier trajet mesuré (fini ${ago(car.lastDrive.endAt || car.lastDrive.at)}) : ${dec(car.lastDrive.km.toFixed(0))} km, <b>${dec(car.lastDrive.kwh100)} kWh/100 km</b>${car.lastDrive.temp != null ? ` à ${dec(Math.round(car.lastDrive.temp))} °C` : ''}
      <span class="old">(${car.lastDrive.mwKm ? `autoroute ${car.lastDrive.mwKm} km à ${dec(car.lastDrive.mwKwh100)}` : 'sans autoroute'}${car.lastDrive.mwKm && car.lastDrive.otherKm ? ` · autres routes ${car.lastDrive.otherKm} km à ${dec(car.lastDrive.otherKwh100)}` : ''})</span></p>` : ''}
    ${car.carRange != null ? `<p class="old">La voiture annonce ${car.carRange} km${car.tempC != null ? ` · 🌡️ ${dec(car.tempC)} °C dehors` : ''}</p>` : ''}
    ${law ? `<h3>Conso selon la température (kWh/100 km)</h3>${law}
      <label class="tick"><input id="evMeasured" type="checkbox" ${V.ev.useMeasured === false ? '' : 'checked'}> Utiliser ma conso mesurée pour les calculs</label>` : ''}
    <p class="old">Lu sur la voiture ${ago(carT)}${fresh ? '' : ' — ancien, la voiture n\'a rien envoyé depuis'}</p>
    ${car.charging && /progress/i.test(car.charging) && Date.now() - carT > 30 * 60e3 ? '<p class="old">Pendant la charge, la voiture dort et n\'envoie presque rien : le % réel est sans doute plus haut.</p>' : ''}`;
  const cb = $('evMeasured');
  if (cb) cb.onchange = () => { V.ev.useMeasured = cb.checked; saveSettings(); };
  // battery at departure: the real level for a departure within the hour; later, the usual level once charged if the
  // car is plugged in (or the departure is more than 12 h away), else the real level
  let src = '';
  if (car.level != null && !startTouched) {
    const dep = $('when').value ? new Date($('when').value) : new Date(), ahead = dep - Date.now();
    const usual = V.ev.usualPct ?? 100;
    if (fresh && ahead <= 3600e3) { $('evStart').value = car.level; src = 'lu sur la voiture'; }
    else if (car.plugged || ahead > 12 * 3600e3) { $('evStart').value = Math.max(fresh ? car.level : 0, usual); src = car.plugged ? 'voiture branchée : chargée d\'ici le départ' : 'batterie habituelle au départ'; }
    else if (fresh) { $('evStart').value = car.level; src = 'lu sur la voiture, pas branchée'; }
  }
  mini.textContent = `🔋 ${car.level ?? '?'} % lus sur la voiture ${ago(carT)}${car.plugged ? ' (branchée)' : ''}${src ? ` · départ compté à ${$('evStart').value} % (${src})` : ''}`;
  mini.classList.remove('hidden');
}
async function fetchCar() {
  const t = carTopic();
  if (!t) { renderCar(); return; }
  try {
    const txt = await (await fetch(`https://ntfy.sh/${t}/json?poll=1&since=48h`)).text();
    const msgs = txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === 'message');
    if (msgs.length) { const c = JSON.parse(msgs[msgs.length - 1].message); if (!car || c.at >= car.at) { car = c; try { localStorage.setItem('carLast', JSON.stringify(car)); } catch { /* ignore */ } } }
  } catch { /* offline: keep the last values */ }
  renderCar();
  renderEnroute();
  renderCharge();
}

// ---------- charge stopped at 6:00 by the home computer (D-038): always on Tempo red days, else unless asked ----------
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function renderCharge() {
  const box = $('chargeCard'), ch = car?.charge;
  if (!ch || !carTopic()) { box.classList.add('hidden'); return; }
  const now = new Date(), mDate = new Date(now.getTime() + (now.getHours() >= 6 ? 86400e3 : 0)), md = isoDay(mDate);
  const when = now.getHours() >= 6 ? 'Demain matin' : 'Ce matin';
  const dayTxt = mDate.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
  const code = ch.tempo?.[md] || 0, red = code === 3, colour = ['', 'Bleu', 'Blanc', 'ROUGE'][code] || '';
  const season = [11, 12, 1, 2, 3].includes(mDate.getMonth() + 1);
  const skip = ch.skip === md;
  let html = '';
  if (!ch.active) html = '<p>🔌 Arrêt de la charge à 6 h : pas encore activé sur l\'ordinateur.</p>';
  else if (red) html = `<p>🔴 <b>${when} (${dayTxt}) jour ROUGE</b> : la charge sera arrêtée à 6 h (obligatoire).</p>`;
  else if (skip) html = `<p>🔌 ${when} (${dayTxt}${colour ? `, jour ${colour}` : ''}) : <b>la charge continuera</b> (demandé).</p>
    <button type="button" data-a="unskip">Annuler : arrêter la charge à 6 h</button>`;
  else html = `<p>🔌 ${when} (${dayTxt}${colour ? `, jour ${colour}` : ''}) : la charge sera <b>arrêtée à 6 h</b>.</p>
    ${!code && season ? '<p class="old">Couleur Tempo pas encore connue (publiée vers 11 h) : si le jour est rouge, l\'arrêt reste obligatoire.</p>' : ''}
    <button type="button" data-a="skip">Ne pas arrêter la charge ${when.toLowerCase()}</button>`;
  const L = ch.last;
  if (L && L.date === isoDay(now)) {
    const t = { 'arrêtée': `charge arrêtée à ${L.level} %`, 'laissée': `charge laissée en cours (${L.level} %)`, 'rien': 'pas de charge en cours à 5 h 50', 'échec': '⚠️ la charge n\'a pas pu être arrêtée' }[L.action];
    if (t) html += `<p class="old">Ce matin : ${t}.</p>`;
  }
  // start / stop now: relayed by the home computer within ~2 min, result in the ntfy app
  if (ch.active) {
    let pend = null; try { pend = JSON.parse(localStorage.getItem('chargePending') || 'null'); } catch { /* ignore */ }
    const P = pend && Date.now() - pend.at < 12 * 60e3 ? pend : null;
    const M = ch.manual && Date.now() - ch.manual.at < 3 * 3600e3 && (!P || ch.manual.at > P.at) ? ch.manual : null;
    const hhmm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    html += '<div class="nowbtns"><button type="button" data-a="start">▶️ Démarrer la charge</button><button type="button" data-a="stop">⏹️ Arrêter la charge</button></div>'
      + '<div class="nowbtns"><button type="button" data-a="preheat">🔥 Lancer le préchauffage</button></div>';
    const WORD = { stop: 'Arrêt', start: 'Démarrage', preheat: 'Préchauffage' };
    if (P && !M) html += `<p class="old">⏳ ${WORD[P.action]} demandé à ${hhmm(P.at)} : l'ordinateur réveille la voiture et lui envoie (2 à 8 min), réponse en notification.</p>`;
    else if (M) html += `<p class="old">${M.ok ? '✅' : '⚠️'} ${WORD[M.action] || M.action} de ${hhmm(M.at)} : ${M.ok ? 'fait' : 'pas confirmé'} — ${M.msg}.</p>`;
    else if (car.plugged === false) html += '<p class="old">La voiture n\'est pas branchée (dernière info).</p>';
  }
  // notifications (results, red days, trip alerts) arrive through the free ntfy app: explain once
  let ntfyDone = false; try { ntfyDone = JSON.parse(localStorage.getItem('ntfyOk') || 'false'); } catch { /* ignore */ }
  if (ch.active && !ntfyDone) {
    const at = `${carTopic()}-alerte`;
    html += `<div class="ntfy">📲 <b>Pour recevoir les notifications</b> (résultat des commandes, jours rouges, alertes en route) :
      installez l'appli gratuite <b>ntfy</b> (Play Store), puis touchez <a href="https://ntfy.sh/${at}" target="_blank" rel="noopener">ce lien</a>
      et choisissez « S'abonner ». Ou dans ntfy : « + » et le nom <code>${at}</code>.
      <button type="button" data-a="ntfyok">C'est fait</button></div>`;
  }
  box.className = `card chargecard${red ? ' red' : ''}`;
  box.innerHTML = html;
  const nok = box.querySelector('[data-a=ntfyok]');
  if (nok) nok.onclick = () => { try { localStorage.setItem('ntfyOk', 'true'); } catch { /* ignore */ } renderCharge(); renderEnroute(); };
  const send = async (type) => {
    try {
      const r = await fetch(`https://ntfy.sh/${carTopic()}-commande`, { method: 'POST', body: JSON.stringify({ type, date: md }) });
      if (!r.ok) throw new Error();
      ch.skip = type === 'skip' ? md : null;
      try { localStorage.setItem('carLast', JSON.stringify(car)); } catch { /* ignore */ }
      renderCharge();
    } catch { alert('Pas de réseau : réessayez.'); }
  };
  const b1 = box.querySelector('[data-a=skip]'), b2 = box.querySelector('[data-a=unskip]');
  if (b1) b1.onclick = () => send('skip');
  if (b2) b2.onclick = () => send('unskip');
  const now2 = async (action) => {
    if (!confirm({ stop: 'Arrêter la charge maintenant ?', start: 'Démarrer la charge maintenant ?', preheat: 'Lancer le préchauffage de la voiture maintenant (environ 30 min) ?' }[action])) return;
    try {
      const r = await fetch(`https://ntfy.sh/${carTopic()}-commande`, { method: 'POST', body: JSON.stringify({ type: 'charge', action }) });
      if (!r.ok) throw new Error();
      try { localStorage.setItem('chargePending', JSON.stringify({ action, at: Date.now() })); } catch { /* ignore */ }
      renderCharge();
    } catch { alert('Pas de réseau : réessayez.'); }
  };
  for (const a of ['start', 'stop', 'preheat']) { const b = box.querySelector(`[data-a=${a}]`); if (b) b.onclick = () => now2(a); }
}

// ---------- "En route": battery vs the road still ahead while driving a planned trip (D-037) ----------
// The trip (road profile: which km are motorway, planned charging stops, fast chargers along the way) is sent to the
// home computer, which checks it at every car reading and sends alerts to the ntfy app; the phone shows the same check.
const tripNow = () => load('enroute', null);
async function postTrip(msg) {
  const r = await fetch(`https://ntfy.sh/${carTopic()}-trajet`, { method: 'POST', body: JSON.stringify(msg) });
  if (!r.ok) throw new Error('ntfy ' + r.status);
}
// the option's own elevation (the search measured only the fastest route), before following or saving it
async function ownTerrain(e) {
  if (e.terrainOwn || !e.line || state.result?.v?.type !== 'ev') return;
  const t = await buildTerrain(e.line, e.km, e.lineMw);
  if (!t) return;
  e.terrain = t; e.terrainOwn = true;
  const w = await fetchWinds(t.wp, state.result.depart, e.km / Math.max(0.1, e.sec / 3600));
  if (w.length) e.winds = w;
}
// profile of an option (the e-208 settings used for its calculation), small enough for one ntfy message (< 4 kB)
function profileOf(e) {
  const r = state.result, P = evParams(r.v, r.depart, e.sec);
  const stations = routeStations(e.line, e.km, e.lineMw);
  let prof = null;
  for (const [keep, tPts] of [[1, 100], [2, 100], [2, 60], [3, 60], [4, 40], [4, 25]]) {
    prof = buildProfile({ line: e.line, mw: e.lineMw, routeKm: e.km, plan: e.charge, stations: stations.filter((_, i) => i % keep === 0), P,
      label: `${r.fromLabel} → ${r.toLabel}`, terrain: e.terrain, winds: e.winds, tPts });
    if (JSON.stringify(prof).length < 3300) break;
  }
  return prof;
}
async function startTrip(profile) {
  if (!carTopic()) { alert('Reliez d\'abord la voiture (Réglages ⚙︎).'); return; }
  if (!car || car.odometer == null) { alert('Pas encore de données de la voiture : réessayez dans quelques minutes.'); return; }
  const old = tripNow();
  if (old && !confirm('Un suivi est déjà en cours. Le remplacer par ce trajet ?')) return;
  const trip = { id: Date.now(), profile, startKm: car.odometer, startLevel: car.level, startAt: Date.now() };
  if (profile.tr) {                                // wind now (the plan may have been made the day before)
    const w = await fetchWinds(profile.tr.wp, new Date(), 90);
    if (w.length) { trip.wind = w; trip.windAt = Date.now(); }
  }
  store('enroute', trip);
  try { await postTrip({ type: 'start', trip }); trip.sent = true; } catch { trip.sent = false; }
  store('enroute', trip);
  renderEnroute();
  showTab('car');
}
async function endTrip(silent) {
  const t = tripNow();
  if (!t) return;
  if (!silent && !confirm('Arrêter le suivi de la batterie ?')) return;
  store('enroute', null);
  try { await postTrip({ type: 'end', id: t.id }); } catch { /* the home computer stops by itself after 36 h */ }
  renderEnroute();
}
let enrouteTimer = null;
function renderEnroute() {
  const box = $('enroute'), t = tripNow();
  clearInterval(enrouteTimer); enrouteTimer = null;
  const dot = $('tabDot');
  dot.className = 'dot hidden';
  if (!t || !car) { box.classList.add('hidden'); return; }
  // the home computer's check (uses every reading since departure); else the same check from the phone's last reading
  const home = car.enroute && car.enroute.id === t.id ? car.enroute : null;
  const res = home || evaluate(t, [{ km: car.odometer, level: car.level, at: car.at }]);
  if (!res) { box.classList.add('hidden'); return; }
  const carT = Date.parse(car.carAt) || car.at, stale = Date.now() - carT > 20 * 60e3 && carT > t.startAt - 60e3;
  const before = carT < t.startAt - 60e3;
  const alertTopic = `${carTopic()}-alerte`;
  box.className = `card enroute ${res.level}`;
  dot.className = `dot ${res.level}`;
  box.innerHTML = `<h2>${res.title}</h2>
    ${res.lines.map((l, i) => `<p class="${i ? '' : 'first'}">${escapeHtml(l)}</p>`).join('')}
    <p class="old">${escapeHtml(t.profile.label || '')} · lu sur la voiture ${ago(carT)}${before ? ' (avant le départ)' : ''}${stale ? ' — la voiture n\'envoie rien en roulant ? Le calcul reprendra à sa prochaine donnée.' : ''}${home ? '' : ' · calcul provisoire du téléphone'}</p>
    ${t.sent === false ? '<p class="old">⚠️ Trajet pas encore transmis à l\'ordinateur (pas de réseau ?) : nouvel essai à la prochaine actualisation.</p>' : ''}
    ${load('ntfyOk', false) ? '' : `<div class="ntfy">📲 Pour être prévenu par-dessus Google Maps : installez l'appli gratuite <b>ntfy</b>, touchez « + » et abonnez-vous à <code>${alertTopic}</code> (serveur ntfy.sh par défaut).
      <div class="actions"><button type="button" data-a="ntfyok">C'est fait</button></div></div>`}
    <div class="actions"><button type="button" data-a="refresh">Actualiser</button><button type="button" data-a="end">Terminer le suivi</button></div>`;
  box.classList.remove('hidden');
  box.querySelector('[data-a=refresh]').onclick = () => fetchCar();
  box.querySelector('[data-a=end]').onclick = () => endTrip(false);
  const ok = box.querySelector('[data-a=ntfyok]');
  if (ok) ok.onclick = () => { store('ntfyOk', true); renderEnroute(); renderCharge(); };
  if (t.sent === false) postTrip({ type: 'start', trip: t }).then(() => { t.sent = true; store('enroute', t); }).catch(() => {});
  if (res.done && home) { endTrip(true); return; }
  enrouteTimer = setInterval(() => { if (!document.hidden) fetchCar(); }, 60e3);
}
fetchCar();
document.addEventListener('visibilitychange', () => { if (!document.hidden && carTopic()) fetchCar(); });
$('evNoCharge').onchange = () => { $('evLunch').disabled = $('evNoCharge').checked; };

// ---------- private storage on this phone (localStorage) ----------
const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? def; } catch { return def; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const sgn = (v) => (v >= 0 ? '−' : '+') + eur(Math.abs(v));      // a saving shows as "−x €", an extra cost as "+x €"
const energyWord = (veh) => (veh === 'ev' ? 'électricité' : 'gazole');
// tolls actually paid on a route, readable: "Chaufour → Poissy 3,00 € · Barrière de Montesson 10,80 €"
const tollsText = (details) => !details || !details.length ? 'aucun' : details.map((x) =>
  /duplex/i.test(x.from) ? `Duplex A86 ${eur(x.price)}`
    : !x.to || x.to === '(barrière)' ? `Barrière de ${prettyName(x.from)} ${eur(x.price)}`
      : `${prettyName(x.from)} → ${prettyName(x.to)} ${eur(x.price)}`).join(' · ');
const splitText = (e, veh) => `dont péages ${sgn(e.saveToll)} · ${energyWord(veh)} ${sgn(e.saveEnergy)}`;

// places: [{name, pt}]
function renderChips() {
  const places = load('places', []);
  for (const [box, input, key, list] of [['fromChips', 'from', 'from', 'fromSuggest'], ['toChips', 'to', 'to', 'toSuggest']]) {
    $(box).innerHTML = '';
    for (const pl of places) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = pl.name;
      b.onclick = (ev) => { ev.preventDefault(); $(input).value = pl.name; state[key] = pl.pt; $(list).innerHTML = ''; };
      $(box).appendChild(b);
    }
  }
}
async function savePlace(key, input) {
  try {
    if (!$(input).value.trim()) { showError('Tapez d\'abord une adresse.'); return; }
    const pt = await resolve(key, input);
    const name = (prompt('Nom de ce lieu (ex. Maison, Travail) :', $(input).value.split(',')[0]) || '').trim();
    if (!name) return;
    const places = load('places', []).filter((p) => p.name !== name);
    places.push({ name, pt });
    store('places', places);
    $(input).value = name;
    renderChips();
  } catch (e) { showError(e.message || String(e)); }
}
$('btnSaveFrom').onclick = () => savePlace('from', 'from');
$('btnSaveTo').onclick = () => savePlace('to', 'to');
function renderPlaceList() {
  const places = load('places', []);
  $('placeList').innerHTML = places.length ? '' : '<p class="hint">Aucun lieu. Utilisez ☆ à côté du départ ou de l\'arrivée.</p>';
  places.forEach((pl) => {
    const row = document.createElement('div');
    row.className = 'place';
    row.innerHTML = `<span>${escapeHtml(pl.name)}</span><button type="button" class="del">Supprimer</button>`;
    row.querySelector('button').onclick = () => { store('places', load('places', []).filter((p) => p.name !== pl.name)); renderPlaceList(); renderChips(); };
    $('placeList').appendChild(row);
  });
}

// trips: [{id, name, o, d, veh, label, via, saved, savedAt, depart}]
function saveTrip(e) {
  const r = state.result;
  const def = `${r.fromLabel} → ${r.toLabel}${e.isBase ?? e.isRef ? ' (le plus rapide)' : ''}`;
  const name = (prompt('Nom de ce trajet :', def) || '').trim();
  if (!name) return;
  const trips = load('trips', []);
  trips.push({ id: Date.now(), name, o: r.o, d: r.d, veh: r.vehKey, label: e.label, via: viaOf(e), legs: legsOf(r.o, r.d, e)?.map(({ line, ...L }) => L) || null, legName: e.split?.name, freeFirst: e.split?.freeFirst, prof: r.v.type === 'ev' && e.line ? profileOf(e) : null, savedAt: new Date().toISOString(), depart: r.departLabel,
    saved: { min: e.min, km: e.km, toll: e.toll, energy: e.energy, cost: e.cost, dMin: e.dMin, save: e.save, saveToll: e.saveToll, saveEnergy: e.saveEnergy } });
  store('trips', trips);
  renderTrips();
  $('trips').scrollIntoView({ behavior: 'smooth' });
}
function renderTrips() {
  const trips = load('trips', []);
  $('trips').classList.toggle('hidden', !trips.length);
  $('tripList').innerHTML = '';
  for (const t of trips) {
    const s = t.saved, div = document.createElement('div');
    div.className = 'trip';
    const gain = s.save > 0.05 ? `−${eur(s.save)} pour +${Math.round(s.dMin)} min (${splitText(s, t.veh)})` : 'itinéraire le plus rapide';
    div.innerHTML = `<div class="name">${escapeHtml(t.name)}</div>
      <div class="split">${escapeHtml(t.label)}</div>
      ${t.legs ? legsHint(t.legName || '', t.freeFirst) : ''}
      <div class="split">${t.veh === 'ev' ? 'e-208' : '5008'} · ${hm(s.min)} · ${gain}${t.depart ? ` · calculé pour un départ le ${escapeHtml(t.depart)}` : ''}</div>
      <div class="actions">
        <button type="button" class="primary-act" data-a="check">Vérifier</button>
        ${t.legs ? t.legs.map((L, i) => `<a target="_blank" rel="noopener" href="${googleMapsUrl(i ? null : L.from, L.to, L.via)}">${i ? '② Google Maps' : '① Google Maps'}</a>`).join('')
          : `<a target="_blank" rel="noopener" href="${googleMapsUrl(t.o, t.d, t.via || [])}">Google Maps</a>`}
        ${t.prof && carTopic() ? '<button type="button" data-a="follow" class="follow">🔋 Suivre ma batterie</button>' : ''}
        <button type="button" data-a="rerun">Relancer l'analyse</button>
        <button type="button" data-a="del" class="del">Supprimer</button>
      </div>
      <div class="check hidden"></div>`;
    const out = div.querySelector('.check');
    div.querySelector('[data-a=check]').onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (!getKey()) { showError('Entrez d\'abord votre clé TomTom dans les Réglages (⚙︎).'); return; }
      btn.disabled = true; btn.textContent = 'Vérification…';
      out.className = 'check'; out.innerHTML = 'Trafic en temps réel…';
      try {
        if (!tollData()) await loadTolls();
        const c = await checkTrip(t, { ...V[t.veh] });
        out.className = `check ${c.level}`;
        out.innerHTML = `<b>${c.title}</b>${c.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}`;
      } catch (e) { out.className = 'check bad'; out.textContent = e.message || String(e); }
      btn.disabled = false; btn.textContent = 'Vérifier';
    };
    const fb = div.querySelector('[data-a=follow]');
    if (fb) fb.onclick = () => startTrip({ ...t.prof, label: t.name.slice(0, 32) });
    div.querySelector('[data-a=rerun]').onclick = () => {
      state.from = t.o; state.to = t.d;
      $('from').value = t.name.split(' → ')[0] || 'Départ'; $('to').value = (t.name.split(' → ')[1] || 'Arrivée').replace(/\s*\(.*\)$/, '');
      document.querySelector(`#vehSeg button[data-v="${t.veh}"]`).click();
      setNow();
      $('form').requestSubmit();
    };
    div.querySelector('[data-a=del]').onclick = () => {
      if (!confirm(`Supprimer « ${t.name} » ?`)) return;
      store('trips', load('trips', []).filter((x) => x.id !== t.id));
      renderTrips();
    };
    $('tripList').appendChild(div);
  }
}

// ---------- form ----------
function setNow() {
  const d = new Date(); d.setSeconds(0, 0);
  const p = (x) => String(x).padStart(2, '0');
  $('when').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
setNow();
$('btnNow').onclick = () => { setNow(); renderCar(); };
$('when').addEventListener('change', () => renderCar());     // departure later → expected battery (car plugged in)

document.querySelectorAll('#vehSeg button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#vehSeg button').forEach((x) => x.classList.toggle('on', x === b));
  state.veh = b.dataset.v;
  $('evBox').classList.toggle('hidden', state.veh !== 'ev');
  if (state.veh === 'ev') fetchCar();
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
    if (state.veh === 'ev') readEvBox();
    const v = { ...V[state.veh] };
    // e-208: consumption at the trip's outside temperature (forecast), from the measured law or the settings (D-040)
    const depart = $('when').value ? new Date($('when').value) : new Date();
    if (v.type === 'ev') {
      const tt = await tripTemp(o, d, depart);
      const rr = planRates(v, tt.T, v.useMeasured !== false ? car?.tmodel : null);
      v.kwhMotorway = v.kwhMotorwayWinter = rr.kM; v.kwhOther = rr.kO;
      v.tempInfo = { ...tt, ...rr };
    }
    if (v.type === 'diesel' && !V.diesel.priceSetByUser) {
      const p = await dieselPrice();
      if (p) { const r = Math.round(p * 100) / 100; v.eurPerL = r; V.diesel.eurPerL = r; saveSettings(); }
    }
    const t0 = Date.now();
    stats.api = 0; stats.cached = 0;
    const res = await analyse(o, d, v, depart, (f, txt) => {
      $('barFill').style.width = `${Math.round(f * 100)}%`;
      $('progressText').textContent = txt;
    });
    const departLabel = depart.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    state.result = { ...res, o, d, v, vehKey: state.veh, fromLabel: $('from').value.split(',')[0], toLabel: $('to').value.split(',')[0],
      departLabel, depart, secs: Math.round((Date.now() - t0) / 1000) };
    render();
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    $('btnGo').disabled = false;
    $('progress').classList.add('hidden');
  }
});

// ---------- results ----------
const viaOf = (e) => (e.charge && e.charge.ok && e.charge.stops.length ? mergeStops(e.line || [], e.via || [], e.charge.stops.map((x) => x.p)) : e.via || []);
// Google Maps link(s) of an option: one link; two only for "motorway to X, then free roads" (and the reverse) when the
// check before opening finds that 9 stops cannot hold Google on the free stretch (e.twoLinks, D-035/D-036)
const legsOf = (o, d, e) => (e.twoLinks && !e.isRef ? e.legs : null);
function gmLinks(o, d, e) {
  const legs = legsOf(o, d, e);
  if (!legs) return [{ href: googleMapsUrl(o, d, viaOf(e)), text: 'Ouvrir dans Google Maps' }];
  const nm = e.split.name;
  return legs.map((L, i) => ({ href: googleMapsUrl(i ? null : L.from, L.to, L.via), avoid: L.avoidTolls,
    text: i ? `② De ${nm} à l'arrivée` : `① Jusqu'à ${nm}` }));
}
const legsHint = (nm, freeFirst) => `<div class="split legs">👉 Pour ce trajet, Google Maps ne suit pas l'itinéraire en un seul lien : il s'ouvre en 2 parties. Partie ${freeFirst ? '①' : '②'} (routes gratuites) : activez « Éviter les péages » (Options). Ouvrez la partie ② en arrivant à ${escapeHtml(nm)}.</div>`;
const hhmm = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60) % 24} h ${String(m % 60).padStart(2, '0')}`; };
function chargeHtml(e) {
  const c = e.charge;
  if (!c) return '';
  if (!c.ok) return '<div class="charge"><p class="warn">⚠️ Aucune borne rapide trouvée assez près de cette route quand la batterie sera basse : prévoyez un détour (20 min ajoutées par prudence).</p></div>';
  const rows = c.stops.map((s, i) => `<p>🔌 <b>${i + 1}. ${escapeHtml(s.brand)}</b> – ${escapeHtml(s.name || '')} (${s.kw} kW${s.off > 0.3 ? `, à ${s.off.toFixed(1).replace('.', ',')} km de la route` : ''})<br>
      vers ${hhmm(s.eta)} · ${s.arrivePct} % → ${s.leavePct} % · ${s.kwh.toFixed(0)} kWh · ${eur(s.eur)}${s.priceKnown ? '' : ' (prix estimé)'} · ${s.min} min${s.lunch ? ' 🍽️ pendant le déjeuner' : ''}</p>`).join('');
  return `<div class="charge">${rows || '<p>🔋 Pas de recharge nécessaire.</p>'}<p>Arrivée avec environ <b>${c.arrivePct} %</b>${c.winter ? ' · consommation d\'hiver' : ''}</p></div>`;
}

function routeCard(e, { compact = false } = {}) {
  const { o, d } = state.result;
  const div = document.createElement('div');
  div.className = 'route' + (state.selected === e ? ' sel' : '');
  const badges = (e.best ? '<span class="badge best">⭐ Meilleur compromis</span> ' : '') +
    (e.freeWin ? '<span class="badge free">🟢 Gain gratuit</span> ' : '');
  const dm = Math.round(e.dMin);
  const lost = dm === 0 ? 'même durée' : dm < 0 ? `${dm} min` : `+${dm} min`;
  div.innerHTML = `
    <div class="head"><span class="save">${e.isBase ?? e.isRef ? 'Le plus rapide' : e.save >= 0 ? '−' + eur(e.save) : '+' + eur(-e.save)}</span><span class="lost">${lost}</span></div>
    ${badges ? `<div>${badges}</div>` : ''}
    <div class="label">${escapeHtml(e.label)}</div>
    ${e.isBase ?? e.isRef ? '' : `<div class="split">${splitText(e, state.result.vehKey)}</div>`}
    <div class="split">Péages payés : ${escapeHtml(tollsText(e.details))}</div>
    ${!e.isRef && e.toll < 0.05 ? '<div class="split">👉 Dans Google Maps, activez aussi « Éviter les péages » (Options) pour être sûr de rester sur cet itinéraire.</div>' : ''}
    ${chargeHtml(e)}
    <div class="meta">${hm(e.min)} · ${Math.round(e.km)} km · péages ${eur(e.toll)} · ${state.result.v.type === 'ev' ? 'électricité' : 'gazole'} ${eur(e.energy)}${e.chargeMin ? ` · dont recharge ${Math.round(e.chargeMin)} min` : ''}</div>
    <div class="hint2"></div>
    <div class="actions"><span class="gms"></span>
      <button type="button" class="fav">☆ Enregistrer</button>
      ${state.result.v.type === 'ev' && e.line && carTopic() ? '<button type="button" class="follow">🔋 Suivre ma batterie</button>' : ''}
    </div>`;
  const showLinks = () => {
    const two = !!legsOf(o, d, e);
    div.querySelector('.hint2').innerHTML = two ? legsHint(e.split.name, e.split.freeFirst) : '';
    div.querySelector('.actions').classList.toggle('two', two);
    div.querySelector('.gms').outerHTML = `<span class="gms">${gmLinks(o, d, e).map((l, i) => `<a class="gm" data-i="${i}" target="_blank" rel="noopener" href="${l.href}">${escapeHtml(l.text)}</a>`).join('')}</span>`;
    for (const gm of div.querySelectorAll('.gm')) {
      gm.onclick = async (ev) => {
        if (e.refined || e.isRef) return;          // already checked: normal link
        ev.preventDefault();
        gm.textContent = 'Préparation de l\'itinéraire…';
        await prepare();
        showLinks();
        if (e.twoLinks) return;                    // two parts: the user reads the hint and opens ① then ②
        location.href = div.querySelector('.gm').href;
      };
    }
  };
  // Google Maps: stops checked (and completed if needed) just before opening; two links only if one cannot work
  const prepare = async () => {
    if (e.refined || e.isRef) return;
    try {
      const fixed = e.charge?.ok ? e.charge.stops.map((x) => x.p) : [];       // e-208 charging stops
      const r2 = await refineVia(o, d, e, state.result.v, state.result.depart, 9, fixed);
      e.via = r2.via;
      if (!r2.ok && e.split) { e.legs = await refineLegs(o, d, e, state.result.v, state.result.depart, fixed); e.twoLinks = !!e.legs; }
      e.refined = true;
    } catch { /* keep the stops */ }
  };
  showLinks();
  div.querySelector('.fav').onclick = async () => { await prepare(); showLinks(); await ownTerrain(e); saveTrip(e); };
  const fol = div.querySelector('.follow');
  if (fol) fol.onclick = async () => { fol.disabled = true; await ownTerrain(e); fol.disabled = false; startTrip(profileOf(e)); };
  if (compact) div.querySelector('.label').style.fontWeight = '600';
  return div;
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render() {
  const { eff, count, secs } = state.result;
  const f0 = eff.find((e) => e.isBase ?? e.isRef) || eff[0];
  const cheapest = eff.reduce((a, b) => (b.cost < a.cost ? b : a));
  const best = eff.find((e) => e.best);
  const wins = eff.filter((e) => e.freeWin);
  $('summary').innerHTML = `
    <h2>Le plus rapide${state.result.v.type === 'ev' ? ' (recharges comprises)' : ''} : ${hm(f0.min)} · ${eur(f0.cost)}</h2>
    ${state.result.motorway ? `<p class="hint">${f0.isRef ? '' : `C'est « ${escapeHtml(f0.label)} ». `}Le tout-autoroute roule plus vite mais met ${hm(state.result.motorway.min)}${state.result.motorway.stops ? ` avec ${state.result.motorway.stops} recharges` : ''} : les bornes y sont moins bien placées.</p>` : ''}
    <p class="hint" style="margin-top:0">dont péages ${eur(f0.toll)}, ${state.result.v.type === 'ev' ? 'électricité' : 'gazole'} ${eur(f0.energy)}</p>
    ${state.result.v.tempInfo ? (() => { const ti = state.result.v.tempInfo, c = (x) => String(x).replace('.', ',');
      return `<p class="hint">🌡️ ${ti.T} °C (${ti.src}) → conso autoroute ${c(ti.kM)} kWh/100 km (${ti.srcM}), autres routes ${c(ti.kO)} (${ti.srcO})</p>`; })() : ''}
    <p>Économie maximale possible : <b>${eur(f0.cost - cheapest.cost)}</b> pour <b>+${Math.round(cheapest.min - f0.min)} min</b> (${escapeHtml(cheapest.label)}).</p>
    ${wins.length ? `<p>🟢 <b>Gain gratuit :</b> ${escapeHtml(wins[0].label)} — <b>−${eur(wins[0].save)}</b> pour ${Math.round(wins[0].dMin) <= 0 ? 'la même durée' : '+' + Math.round(wins[0].dMin) + ' min'}.</p>` : ''}
    ${best ? `<p>⭐ <b>Meilleur compromis :</b> ${escapeHtml(best.label)} — <b>−${eur(best.save)}</b> pour <b>+${Math.round(best.dMin)} min</b> (${Math.round(best.pSave * 100)} % de l'économie possible pour ${Math.round(best.pTime * 100)} % du temps en plus), ${splitText(best, state.result.vehKey)}.</p>` : ''}`;
  const maxD = Math.max(10, Math.ceil(Math.max(...eff.map((e) => e.dMin)) / 5) * 5);
  $('budget').max = String(maxD);
  if (+$('budget').value > maxD) $('budget').value = String(Math.min(30, maxD));
  renderBudget();
  renderChart();
  renderList();
  $('footStats').textContent =
    `${count} itinéraires évalués, ${eff.length} retenus · ${stats.api} requêtes TomTom` +
    `${stats.cached ? ` (+${stats.cached} déjà en mémoire)` : ''} · ${secs} s`;
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

renderChips();
renderTrips();
loadTolls().catch(() => showError('Impossible de charger les tarifs des péages'));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// first tab: the e-208 while a trip is followed, else the last one used
{
  let t = 'route'; try { t = localStorage.getItem('tab') || 'route'; } catch { /* ignore */ }
  showTab(tripNow() ? 'car' : t, true);
}
