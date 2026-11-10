# Handoff — restart point for the next conversation (updated 2026-11-10)

Read this first, then `docs/DECISIONS.md` (D-001…D-032) and `docs/PROGRESS.md`. Thomas does not read the docs:
everything must be reported to him in the terminal, in plain words (he is not a coder).

## 1. What exists

- **Péage Malin**: phone-only web app (French UI), public repo `WTT27/peage-malin`, live at
  https://wtt27.github.io/peage-malin/ (GitHub Pages, `gh-pages` branch = `app/` folder).
- Deploy: commit on `main`, `git push origin main` (HTTPS; the server's SSH key is someone else's), then
  `./publish.sh` (subtree split of app/ pushed to gh-pages).
  Bump the cache name in `app/sw.js` (currently `peage-malin-v10`) at each release. No GitHub Actions (token lacks `workflow`).
- TomTom key: only in `/home/thomas/projets/WTT/GPS/.env` (gitignored) and on Thomas's phone (localStorage, entered via
  `…/#key=…` once). Never commit or publish it. Free quota 2,500 requests/day; a full search uses 35–105.
- Local test server: `python3 -m http.server 8765` in `app/` (may need restarting).

## 2. Engine (app/js/optimizer.js) — how the in-between routes are found

1. TomTom fastest route (with instructions → time line) + 5 alternatives + 3 toll-free variants.
2. Corridor: each toll section cut at its priced interchanges (max 12) + approach points 5 km before/after; every
   motorway / free-roads combination; free pieces checked with TomTom (économe method removed, D-036)
3. Escapes: "motorway to X then free roads" / "free roads to X then motorway" — now combined with the options of the
   other toll sections (D-032).
4. TomTom detours: blocked spots (avoidAreas, chains of small boxes / 1–2 km boxes) on each priced piece and whole toll
   section; TomTom picks where to leave/rejoin; decomposed to combine with other stretches. Detour chains: block the
   tolls of a detour too, step by step towards toll-free (D-025).
5. Display rules: efficient routes only; within 2 min keep the cheapest; an option must save ≥ 1 € more AND ≥ 1 € per
   10 extra minutes than the previous one shown (D-030, D-031). Best compromise = max(% saving − % time).
6. Google Maps hand-off: ≤ 9 stops next to avoided tolls, checked with TomTom before opening (refineVia, 1–3 requests);
   toll-free option tells the user to switch on "Éviter les péages" (D-031).
7. Toll pricing (app/js/tolls.js): pair prices from official grids, chains of tickets + open barriers, main-line
   barrier wins near-ties, one road per exit number (D-016, D-026, D-027).

## 3. App features (app/js/app.js)

Saving split (tolls / fuel), tolls paid listed per option, saved places (chips), saved trips with "Vérifier"
(live traffic, closures, compromise still valid), "Relancer l'analyse". Everything personal is stored on the phone only.

## 4. Quality tools

- `node tests/engine_test.mjs <trip> [diesel|ev] [YYYY-MM-DDTHH:MM]` (trips: bordeaux, brive, demangevelle, lyon, nantes, lille).
- `node tests/audit.mjs [trips…]` — independent heavy search; reports "gaps" (routes beating the app). ~100 TomTom
  requests per trip, disk-cached in `data/cache/audit/`. Last full run: 8/12 trips without gap (before D-028…D-032).
- `node --experimental-websocket tests/screenshot.mjs URL out.png [selector] [timeout]` (+ env PM_PRE / PM_ACT).
- Google-follow check: scripts in the session scratchpad (`gtest*.mjs`) — route through the option's stops with
  tolls allowed and compare tolls; worth turning into `tests/google_follow.mjs`.
- Thomas's reference example: home → Demangevelle, 18 Dec 2026 09:00, 5008 and e-208 (exact addresses are kept in
  Claude's private memory, not in this public repo).

## 5. Open items / next steps

1. **Thomas's phone test** of the latest version (labels, Google Maps following the stops, Vérifier, places).
2. DONE 2026-11-09: auditor re-run (10/15 without gap; Nantes +6 min −2.27 €, Clermont borderline), économe vs complète
   (économe not recommended, D-035), Google-follow check permanent (`tests/google_follow.mjs`, 111/116 diesel options,
   30/31 e-208 on 3 trips). Left: the 5 Toulouse/Clermont misses, Nantes gap.
5. Backlog: comfort penalty (postponed by Thomas), Escota/Arcos tolls, Duplex reverse direction, unnamed Vinci page-4
   stations, 4 unlocated APRR/AREA barriers (Dordives, Cruseilles ×2, Copponex), Capbreton, Western Europe,
   yearly toll refresh (1 February), traffic at predicted time for later legs.

## 7b. Two tabs (app v19, 2026-11-10)

« 🗺️ Itinéraire » (saved trips, form, results) and « 🔋 Mon e-208 » (En route check, car status card #carLive, charge card).
Last tab remembered (localStorage 'tab'); opens on the e-208 tab while a trip is followed; the tab shows a coloured dot
(ok/juste/non) during a trip; the EV form keeps a one-line battery reminder (#carMini).

## 8. Charge stop at 6:00 — built 2026-11-10 (D-038), setup done the same day

Setup done (OTP activation, MQTT token, cron 05:50). Lessons: pycryptodome 4.4 removed py3compat (stellotp/oaep.py
defines `bord`); the remote token request must not carry `&locale=` (HTTP 400). App v18 adds "Démarrer / Arrêter la
charge" buttons: {type:'charge', action} on `<topic>-commande` → poll.mjs (≤ 2 min, requests > 10 min old dropped)
spawns `charge.mjs start|stop --app` detached → result in charge.json `manual` (shown on the card) + ntfy alert.
charge.lock (6 min) keeps commands from overlapping; the morning job waits for it. Real stop/start test still pending.

Thomas must run in his own terminal: `node car/charge.mjs setup` (SMS + PIN), then next to the plugged car
`node car/charge.mjs stop` / `start`. Log: ~/.config/peage-malin-car/charge.log. Claude may not run car/remote.py
(auto-mode "code from external" block) — check the logs instead.

## 7. "En route" battery check — built 2026-11-10 (D-037)

`app/js/enroute.js` + `car/poll.mjs`. Button "🔋 Suivre ma batterie" (e-208 options and saved trips, car linked).
Alerts in the ntfy app, channel `<car channel>-alerte`. To check after Thomas's drive: does `history.jsonl` get readings
while driving (several lines with increasing km during the trip) or only at the end? If only at the end, the check
updates only at stops. Test files are in the session scratchpad (synthetic scenarios + Lyon options offline).

## 6. e-208 charging — DONE 2026-11-09 (D-033)

Real charging stops at real chargers (IRVE file), per-trip battery at start / wanted at arrival, lunch option,
"ignore charging" option, winter consumption. To do: Thomas's feedback on stop choices and on the per-network price
estimates (he can check real prices in Chargemap); refresh `app/data/chargers.json` now and then
(download the IRVE CSV to `data/raw/irve/irve.csv`, run `python3 tools/build_chargers.py`). Not done: round trip
optimised together, real Tempo colour, live charger availability.
