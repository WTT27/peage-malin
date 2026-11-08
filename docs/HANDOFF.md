# Handoff — restart point for the next conversation (2026-11-08, end of day)

Read this first, then `docs/DECISIONS.md` (D-001…D-032) and `docs/PROGRESS.md`. Thomas does not read the docs:
everything must be reported to him in the terminal, in plain words (he is not a coder).

## 1. What exists

- **Péage Malin**: phone-only web app (French UI), public repo `WTT27/peage-malin`, live at
  https://wtt27.github.io/peage-malin/ (GitHub Pages, `gh-pages` branch = `app/` folder).
- Deploy: commit on `main`, `git push origin main` (HTTPS; the server's SSH key is someone else's), then
  `git subtree split --prefix app -b gh-pages-build && git push -f origin gh-pages-build:gh-pages && git branch -D gh-pages-build`.
  Bump the cache name in `app/sw.js` (currently `peage-malin-v9`) at each release. No GitHub Actions (token lacks `workflow`).
- TomTom key: only in `/home/thomas/projets/WTT/GPS/.env` (gitignored) and on Thomas's phone (localStorage, entered via
  `…/#key=…` once). Never commit or publish it. Free quota 2,500 requests/day; a full search uses 35–105.
- Local test server: `python3 -m http.server 8765` in `app/` (may need restarting).

## 2. Engine (app/js/optimizer.js) — how the in-between routes are found

1. TomTom fastest route (with instructions → time line) + 5 alternatives + 3 toll-free variants.
2. Corridor: each toll section cut at its priced interchanges (max 12) + approach points 5 km before/after; every
   motorway / free-roads combination; free pieces checked with TomTom (complete method) or estimated with Valhalla
   (economical method, option in Réglages).
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
2. Re-run the auditor on all trips after D-028…D-032; add trips from other origins; fix the Nantes gap (+6 min −2.27 €).
3. Compare économe (Valhalla) vs complète on all trips (Valhalla answers this server again) — `tests/compare_modes.mjs`.
4. Turn the Google-follow check into a permanent test.
5. Backlog: comfort penalty (postponed by Thomas), Escota/Arcos tolls, Duplex reverse direction, unnamed Vinci page-4
   stations, 4 unlocated APRR/AREA barriers (Dordives, Cruseilles ×2, Copponex), Capbreton, Western Europe,
   yearly toll refresh (1 February), traffic at predicted time for later legs.

## 6. TO DISCUSS WITH THOMAS: e-208 charging (he asked for this point specifically)

Current model (D-010, D-013, D-032): leaves at 100 % (home, Tempo off-peak ≈ 0.14 €/kWh), 46 kWh usable,
18 kWh/100 km motorway at 110 km/h, 15 elsewhere; everything beyond 90 % of the battery is bought at 0.54 €/kWh;
charging at 45 kW average, 10 min overhead per stop, one stop up to 80 % of the battery, slower above 70 %.
**No charger location is used yet** — it is a cost/time model only. Questions and factors to settle with Thomas:

- **Where chargers are**: the model assumes a charger exactly when needed. Free-road routes may have no fast charger
  where the battery runs low, while motorway service areas do → partly free routes could need a detour to charge.
  Use real charger locations (free open data: data.gouv.fr IRVE national file, Open Charge Map) and plan the stops.
- **Charging price by network**: 0.54 €/kWh is a motorway assumption. Supermarket / city fast chargers are often
  cheaper (0.30–0.45 €/kWh), Ionity/Fastned/Total/Electra/Tesla differ, with or without subscription (Thomas: no
  subscription). Which networks/cards does Thomas use? Price per minute vs per kWh?
- **Real e-208 charging curve**: peak ~100 kW only at low charge, falls fast; ~45 kW average 10→80 % is a rough value;
  much slower when the battery is cold (winter) — precondition? Real stop length (parking, payment, queue)?
- **Battery margins**: arrival state of charge wanted (10 %? more?), minimum at any time, departure really at 100 %?
  Charging possible at the destination (Demangevelle) → then arriving low is fine and the return trip starts full?
- **Consumption factors**: winter (+15–30 %), heating, wind, rain, elevation (Langres plateau), speed actually driven
  on free roads; is 18/15 kWh/100 km right in Thomas's experience? Use the e-208 trip computer to calibrate.
- **Home electricity**: real Tempo colour of the night before (blue/white/red have different prices; red days are
  expensive) — public data available.
- **Breaks**: combine charging with lunch/toilet breaks (Thomas's earlier idea): a 30-min lunch stop makes charging
  time "free"; the app could suggest where to stop (service area vs town) and count only the extra time.
- **Round trip**: optimise there-and-back together (charge at destination or not).
- **What to show**: number and place of charging stops, kWh and € per stop, battery % on arrival, time spent charging
  vs driving — and whether the best compromise should differ for the e-208 (slower roads can save a whole stop).
