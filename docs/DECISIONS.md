# Decision log

Each important decision, with its reason. Newest at the bottom.

## D-001 — Standalone web app + hand-off to Google Maps (2026-11-08)
- **Decision:** build our own free web app; navigation is delegated to Google Maps via a link.
- **Rejected:** browser extension on google.com/maps (desktop only, breaks when Google
  changes its page); Google Routes API toll info (requires a billing account / credit card).
- **Why:** free, works on phone and PC, robust.

## D-002 — France first, then Western Europe (2026-11-08)
- **Why:** toll data must be collected per country/operator; France is the user's main use.

## D-003 — Normal car only, two vehicle profiles: e-208 (electric), 5008 (diesel) (2026-11-08)

## D-004 — Value-of-time rule: "1 hour is worth X €" (2026-11-08) — superseded as main criterion by D-018
- Generalized cost = tolls + energy + duration × X. Lowest wins.

## D-005 — UI in French, project documents in English (2026-11-08)
- **Why:** app is for French use; docs follow the language of our working conversation.
  Can be switched to French on request.

## D-006 — Starting value X = 10 €/h; consumptions e-208 15 kWh/100 km, 5008 6 L/100 km; max 110 km/h (2026-11-08)
- Sensitivity check on X planned later.

## D-007 — Live traffic via free TomTom developer account (2026-11-08, revised same day)
- First recorded as option (b) by mistake; Thomas corrected to **option (a)**.
- Free tier: 2,500 non-tile requests/day (routing included). Card-free sign-up to be confirmed
  at account creation; if a card is required → fall back to (b).
- The TomTom key is personal: it will not be stored in any public place.

## D-008 — Valhalla public server as routing source for the prototype (2026-11-08)
- **Why:** free, no key, supports toll avoidance and alternatives. OSRM demo cannot avoid tolls.
  OpenRouteService kept as backup. See FEASIBILITY.md.

## D-009 — 110 km/h cap applies to the e-208 only (2026-11-08)

## D-010 — e-208 energy cost: home charge (Tempo off-peak ≈ 0,14 €/kWh) then 0,54 €/kWh on motorway (2026-11-08)
- Assumes departure at 100 %. Tempo prices from the 1 Aug 2026 grid (to recheck against EDF yearly).
- Possible later improvement: use the actual Tempo colour of the night before departure (public data).

## D-011 — TomTom becomes the main routing source; Valhalla is the backup (2026-11-08)
- TomTom key works (stored in local `.env`, excluded from git). It gives live traffic, toll
  avoidance (`avoid=tollRoads`), alternatives, and a speed cap (`vehicleMaxSpeed=110` for the e-208).
- Its durations look more realistic than Valhalla's (Bordeaux: 5 h 45 vs 6 h 51 with tolls).

## D-012 — Diesel price fetched live from government open data (2026-11-08)
- National average on 2026-11-08: **2,21 €/L** (9,023 stations). Earlier 1,65 €/L figure was wrong.

## D-013 — e-208 consumption by road type (2026-11-08)
- 2022 model, ~46 kWh usable. Motorway at 110 km/h: **18 kWh/100 km**; other roads: 15 kWh/100 km.
- Source: Automobile Propre supertest e-208 2022 measured 17,1 kWh/100 km at steady 110 km/h
  (mild weather); Izi by EDF reports 19,5 at 120 km/h average. 18 is a realistic middle; Thomas
  estimated ~20. Adjustable.

## D-014 — Communication rule (2026-11-08)
- Thomas does not read the docs; they are kept for traceability only. All results, questions and
  decisions are reported in the terminal conversation.

## D-015 — Toll price sources (2026-11-08)
- Toll station locations: official ministry dataset (data.gouv.fr).
- APRR/AREA: ready-made CSV on data.gouv.fr (2026 prices).
- Sanef/SAPN and Vinci (ASF, Cofiroute, Escota): their websites block automated download
  (anti-bot page / JavaScript-only links) → Thomas downloads the class 1 PDFs manually once a year,
  Claude extracts them.

## D-016 — Toll engine method (2026-11-08)
- TomTom marks toll stretches; the engine finds priced stations close to the route (official dataset
  + OpenStreetMap exits by number and name) near the start/end of each stretch and looks up the pair price.
  Operator boundaries are handled by splitting; open barriers by fixed prices; Duplex A86 by time table.
  A stretch that cannot be priced is always flagged, never counted as free.

## D-017 — Alternatives = toll-free, TomTom alternatives, and per-stretch skip / leave early / join late (2026-11-08)
- Built from 3 TomTom legs (normal / toll-free / normal). ~20–30 TomTom requests per trip (free quota 2,500/day).

## D-018 — Find in-between routes instead of ranking by €/hour (2026-11-08)
- Thomas's goal: save as much as possible with little time lost; fixed €/h tends to pick extremes.
- Analysis: keep only efficient routes (no other route faster AND cheaper); for each, % of the maximum
  saving vs % of the maximum extra time; best compromise = largest gap; "free wins" (≥1 € for ≤3 min);
  savings ladder by time budget (+5 … +90 min). €/h kept only as a detail.
- Comfort penalty for small roads: postponed on purpose (Thomas: "keep it in mind").

## D-019 — Optimizer v2 search (2026-11-08)
- Corridor model per toll stretch: cut at every priced interchange (max 12), each piece on motorway or
  on free roads, all combinations (skip middle, leave early, join late, several skips). Each motorway run is
  priced as one ticket. Stretches combined additively.
- Escape routes: motorway to exit X then free roads to destination (and the reverse) → finds national
  roads such as the N10 (verified on Bordeaux: Poitiers → Ruffec → Angoulême → Barbezieux).
- Free-road legs start/end on an ordinary road near the exit (OpenStreetMap, Overpass) because TomTom
  stays on the motorway when a leg starts on it. Toll on "free" legs is still priced (avoid is only a preference).
- TomTom calls cached on disk (data/cache, not in git); ~110 calls per trip and vehicle.

## D-020 — Phone-only app: everything runs in the phone's browser (2026-11-08)
- Thomas wants a solution that does not depend on his server. The engine (toll engine + optimizer v2) is
  ported to JavaScript (app/js), toll data exported to one compact file (app/data/tolls.json, ~170 kB gzipped).
- Static site, to be hosted free on GitHub Pages (account WTT27), installable on the home screen.
- The TomTom key is NOT in the code: entered once in the app settings (or via a link …/#key=…, the part after
  # is never sent to any server) and stored on the phone only.
- Services called from the phone: TomTom (routes), Overpass/OpenStreetMap (local roads near exits — replaced
  by built-in precomputed points, see D-021),
  Nominatim/OpenStreetMap (addresses), data.economie.gouv.fr (diesel price). All free, no account except TomTom.
- Google Maps hand-off: directions link with up to 9 waypoints placed on the free-road parts, so Google follows
  the chosen in-between route.

## D-021 — Fewer TomTom requests: optimizer v3 (2026-11-08)
- Motorway times are read from the fastest route (TomTom instructions give the time at each manoeuvre),
  not requested again; "exit at X" options cost 1 request instead of 2.
- Pruning: a free piece is only considered if it avoids ≥ 0.50 € of toll; escapes only if ≥ 1 € is at stake.
- Cache on the phone (IndexedDB): TomTom 3 h, Valhalla 7 days.
- Off-motorway points for all 1,157 toll-station points precomputed once (Valhalla /locate: nearest
  tertiary..trunk road, not toll, not a slip road) and embedded in the app data: no Overpass call on the phone.
  (Overpass servers proved unreliable / refused this server.)
- Result (complete mode, Fri 13 Nov 08:00): Bordeaux 62 requests / 19 s (was 140 / 2 min), Brive 25 / 7 s,
  Demangevelle 36 / 15–30 s, with results as good as v2.

## D-022 — Two calculation methods; "complete" is the default (2026-11-08)
- Complète (default): every free piece and escape checked with TomTom.
- Économe (option): Valhalla (free) estimates every piece, calibrated on TomTom's toll-free route; only the best
  9 + 6 options are checked with TomTom (~15 requests). Automatic fallback to the complete method if Valhalla
  does not answer (it refused this server after heavy use on 2026-11-08).
- Thomas's decision: keep Valhalla as an option and compare it later with complete runs
  (tool: tests/compare_modes.mjs).

## D-023 — One Claude session at a time (2026-11-08)
- After disconnections two sessions edited the project in parallel; Thomas kept one and stopped the other.

## D-024 — Free bypasses may start before / end after a toll stretch (2026-11-08)
- Found by Thomas: to avoid the A86 Duplex he takes A13 → A12 → N12 → A86 (leaving the A13 at Rocquencourt,
  ~4 km before the toll starts). The engine only started bypasses at the toll start (Rueil), so it missed it.
- Fix: each toll stretch gets an approach point on the fastest route 5 km before its start and one 5 km after its
  end (on free road). Bypasses are also tried from/to these points. Cost: ~2–8 extra TomTom requests per trip.
- Result (Fri 13 Nov 08:00, 5008): Duplex avoided via A12/N12 for +5 min, −9.71 € (was +15 min via Rueil);
  combined with a short free stretch near the A5 it becomes the best compromise: +10 min, −13.12 €.
- Labels now show the main roads of the free part ("par N10", "par A12"). TomTom names a road only where there is
  a manoeuvre, so the N12 continuing straight from the A12 appears as "A12".
- Google Maps link: a 3rd waypoint at 80 % of each free part so Google cannot rejoin the toll road.

## D-025 — The engine must find in-between routes by itself: TomTom detours + an auditor (2026-11-08)
- Thomas: "I want the app to find the best compromise itself, not wait for me to give it."
- **Detours found by TomTom:** for every priced piece between interchanges (and for every toll stretch as a whole),
  TomTom computes the trip with that piece blocked (`avoidAreas`). TomTom itself picks where to leave and rejoin, with
  live traffic, possibly using another motorway or national road. The detour is cut into "leave at point a, rejoin at b"
  so it can be combined with options on the other stretches; if its toll cannot be split, it is kept as a whole route.
  Up to 24 detours per trip (complete method), 4 in the economical method.
- TomTom ignores a single small blocked spot at some places (e.g. A10 south of Poitiers, km 396–418); a chain of 3 small
  spots 300 m apart, or a box covering 1–2 km of road, is respected. A second try is made if the first one is ignored.
- **Auditor** (`tests/audit.mjs`, run by Claude, not in the app): independent, heavier search (TomTom alternatives with
  and without tolls, 24 forced via-points on both sides of the corridor, blocked spots every 15 km). Any audit route not
  dominated by the app's efficient routes is a "gap" to fix in the engine. TomTom answers cached on disk.
- First audit findings, fixed: Bordeaux N10 route timed +16 min by the app vs +11 min as a whole route (now found as a
  detour: +12 min, −22.55 €); Lyon route crashed (see D-026); only 2 TomTom alternatives requested (now 5, same request).

## D-026 — Toll pricing: chains of tickets and APRR/AREA open barriers (2026-11-08)
- Lyon trip: A6 toll section marked by TomTom up to 16 km after the Villefranche-Limas barrier → no exit found in the
  15 km window → whole trip failed. New fallback: cover a toll section with the best chain of tickets and open barriers
  found along the route (dynamic programming on positions; penalties for gaps and distance to the section ends).
- APRR/AREA open-system barriers (20, 2026 class 1 prices) transcribed from the image PDF into
  `data/tolls/aprr_area_open.json`; 16 located (Dordives, Cruseilles ×2, Copponex not located yet).
- The old "open barriers only" fallback is limited to toll sections shorter than 30 km (it priced 400 km of A6 as 2.80 €).
- **Detour chains:** TomTom's detour is the fastest way around a toll, not always the cheapest (Lille: avoiding the
  A14 gives Rouen + A29). Each distinct detour is followed by detours that also block ONE of its own toll sections
  (one branch per section), giving cheaper, slower whole routes towards toll-free. Up to 12 per trip (3 economical).
- TomTom alternatives: 5 instead of 2 (same request, no extra cost). Near-identical final routes are merged.

## D-027 — Toll station locations: one road per exit number; scattered names resolved (2026-11-08)
- Found by the auditor on Lille: "ARRAS NORD (A26) N°7" was placed at exit 7 of the A1 (near Roissy), A26 and A29,
  because Sanef/SAPN grids cover several motorways and exit numbers repeat. Result: the A1 Paris→Lille was priced
  1.60 € instead of 18.90 €. 50 stations were affected (whole A26, A1 north, A29, A28…).
- Fix (tools/build_index.py): pick ONE road per station — the road written in the name "(A26)", else the road whose
  exit matches the official station name, else the road closest to the neighbouring station of the grid. Stations whose
  points are still > 60 km apart keep the group closest to the stations they share prices with. Left: 1 (Capbreton).
- Near-ties between a main-line barrier and an exit next to it (Chamant vs Senlis N°8): the barrier wins, because
  through traffic pays it.

## D-028 — Saving split, saved places, saved trips with a live check; all private on the phone (2026-11-08)
- Every option shows its saving split: "dont péages −x €, gazole/électricité ±y €" (vs the fastest route).
- **Places** ("Maison", recurring destinations): ☆ next to Départ/Arrivée saves the current address under a name; chips
  fill the field in one tap; deletion in Réglages.
- **Saved trips**: "☆ Enregistrer" on any route stores origin, destination, vehicle, label, Google Maps waypoints and the
  figures at saving time. "Vérifier" = 2 live TomTom requests (traffic now): the saved route through its waypoints (with
  TomTom traffic sections: closures, accidents, jams with delay) and the fastest route now. Verdict OK / à surveiller /
  relancer, based on: closure, length change > 5 % (detour), extra toll > 1 €, much longer than saved, gap to the fastest
  route grown by > 15 min without extra saving. "Relancer l'analyse" re-runs the full search for that trip.
- **Privacy (Thomas's question):** the code is public on GitHub, but contains no personal data. Key, settings, places
  and trips live only in the phone's browser storage (localStorage); there is no server of ours. Leaving the phone:
  trip coordinates to TomTom (routing, with Thomas's key), typed addresses to OpenStreetMap Nominatim, diesel price
  request to data.economie.gouv.fr. Limits: lost if browser data is cleared; not synced between devices.

## D-029 — Free parts must start/end on the right side; Google waypoints away from motorways (2026-11-08)
- Thomas (Demangevelle): a "free gain" told him to leave the A5 and come straight back on; and after the A31 Google
  turned left into Montigny-le-Roi then made a U-turn towards Bourbonne.
- Cause: the off-motorway point of a toll section's start/end station can be on the wrong side — after the Les Eprunes
  barrier (so "free roads Les Eprunes → St-Germain-Laxis" really meant: take a ticket, exit 15, re-enter; modelled
  −3.41 €, real ≈ −1.30 €), or on the town side of the Montigny exit. Those points were also sent to Google as stops.
- Fix: when a toll section has an approach point on the route (5 km before / after), free parts start/end there, not
  at the station's off-motorway point. Google Maps stops are now picked inside each free part, at places ≥ 1 km from
  the fastest route's motorway (up to 3 per part), never at exits.

## D-030 — Readable labels, tolls paid on every option, "2-minute" rule (2026-11-08)
- Thomas: "sans le péage Duplex…" read as "without tolls" while the A13 (Mantes/Buchelay, 3 €) was still paid — it was
  counted, the label was misleading. Labels now: "Évite le Duplex A86 (par A12)", "A5 : routes gratuites X → Y",
  "Autre itinéraire (par …)"; "Sans aucun péage" only if the toll is really 0 (else "Le moins de péages possible").
  Station names made readable (no exit numbers / zone ranges / capitals). Each option lists the tolls actually paid.
- Thomas's rule: when options are within 2 minutes of each other, only the cheapest is shown (the fastest route is
  always kept). Example 18 Dec 09:00: +13 min −8.79 € removed in favour of +13 min −10.56 €.
- Answer to "hard-coded or general?": all fixes are general (toll section ends, Google waypoints, pricing); no code is
  specific to a route or a place.

## D-031 — Hide options that add almost nothing; Google Maps stops checked before opening (2026-11-08)
- Thomas: "+13 min −10.56 € is far more interesting than +24 min −11.04 € (0.48 € for 11 more minutes)". Rule: from the
  fastest to the slowest, an option is shown only if it saves at least 1 € more AND at least 1 € per 10 extra minutes
  than the last option kept (a filter against "almost nothing more", not a value-of-time ranking).
- Thomas: the toll-free option opened in Google Maps with the A13 and A5 (5 h 10 instead of 5 h 59). Cause: only 2
  stops → Google chose its own (toll) roads in between. Fix, general:
  1. Stops are placed next to every toll section of the fastest route that the option avoids (ends of the avoided
     part first, then in between), on the option's own roads; max 9 (Google limit).
  2. When "Ouvrir dans Google Maps" or "Enregistrer" is tapped, the stops are checked with TomTom (fastest route through
     the stops, tolls allowed = proxy of Google). If extra tolls appear, a stop is added on the option level with that
     toll stretch, up to 3 rounds (1–3 requests).
  3. Toll-free option: a note asks to switch on "Éviter les péages" in Google Maps (no documented URL parameter).
- Test (proxy): Demangevelle 18 Dec 09:00 — 8/8 options followed with the expected tolls; Lille 8/8 (one +0.50 €);
  Bordeaux 9/11 (toll-free on 640 km cannot be held by 9 stops → note; Auvours +1 €).

## D-032 — Escapes combined with other stretches; smoother e-208 charging model (2026-11-08)
- Thomas (e-208, Demangevelle): "+2 min −4.52 € (leave the A5 at exit 24) and +5 min −8.01 € (A12 instead of the
  Duplex) are independent — why no combination?" Cause: "motorway to X then free roads" / "free roads to X then
  motorway" options were standalone. Now each is combined with the options of the toll stretches it does not touch.
- The combination first came out at +17 min: the charging model counted one extra 10-minute stop when the fast-charge
  need went from 31.9 to 32.8 kWh (threshold 70 % of the battery per stop). That threshold also made the "+2 min" of the
  exit-24 option artificial (it saved a whole stop). New model: one stop can bring up to 80 % of the battery; the part
  above 70 % is charged at half speed. Result: Duplex by A12 + A5 to Chaumont then free roads = +16 min −12.52 €.

## D-033 — e-208: real charging stops at real chargers, Thomas's battery rules (2026-11-09)
Thomas's answers: fast chargers (100 kW max for the car), card payment or Chargemap pass (any network); leaves at
**90 %** (aged battery) — adjustable per trip; arriving under 10 % is fine, optional wanted arrival level per trip;
charging at destination possible; consumption **15 kWh/100 km** mixed roads (his last 8,000 km), **18** motorway at 110 in
summer, **20** in winter; lunch during a charge = option (off by default); home price = average Tempo blue/white
off-peak (Aug 2026 grid 0.1356 / 0.1536 → **0.145 €/kWh**); option "ignore charging" (unlimited range: kWh × home price,
no stops). He asked whether the app can read the battery level from MyPeugeot: no — Stellantis has no public API; the
unofficial ones need his account credentials on a server, which a phone-only static app cannot do safely. Manual field.
- Chargers: data.gouv.fr IRVE consolidated file (2026-11-09), CCS ≥ 50 kW, open access → `app/data/chargers.json`
  (8,391 sites, `tools/build_chargers.py`). Price: operator's own €/kWh text when clear (1,892 sites, e.g. Lidl 0.39,
  Ionity 0.69), else a per-network estimate (`NET_PRICE` in `app/js/charging.js`), else the settings price (0.54).
  480 sites with limited opening hours are only used Mon–Sat 8:00–19:00.
- e-208 charging curve (kW vs battery %): 95 below 20 %, 75 to 45 %, 55 to 60 %, 40 to 75 %, 25 to 85 %, 12 above;
  ×0.8 in winter; capped by the station power. 10 min per stop (parking, payment) + detour (both ways) to stations off
  the road. On motorway parts only chargers within 350 m count (service areas); elsewhere up to 2.5 km.
- Planner: battery simulated along each final route's line; reserve 8 % while driving (setting); a small search
  (8 candidates × 3 levels) keeps the plan with least "charging minutes + 3 min per €". One stop charges to 80 %
  (85 % if that finishes the trip, 90 % at lunch). Lunch window 11:45–13:45: the lunch duration (45 min, setting) is not
  counted as lost time. Winter = November to March (departure date).
- The search itself still uses a quick estimate (same curve, no locations); real stops are planned on the final routes.
- Each option shows its stops (network, place, time, % before/after, kWh, €, minutes, lunch) and the arrival %;
  the charging stops are added to the Google Maps waypoints. No reachable charger → warning + 20 min penalty.

## D-034 — Real battery level and consumption read from the car (MyPeugeot) (2026-11-09)
Thomas: the e-208 shows no battery %, only an inaccurate range; he measures consumption by reading the % in the
MyPeugeot app, driving 10 km and reading again. He wants it automatic and offered his credentials.
- Unofficial access, same as the MyPeugeot app (no public Stellantis API for owners). Login on Peugeot's own page by a
  hidden Chromium on Thomas's always-on Linux computer (`car/peugeot.mjs`); app client id/secret downloaded from the
  community project homeassistant-stellantis-vehicles (updated there when Stellantis changes them). Password, tokens,
  history and channel name live only in `~/.config/peage-malin-car/` (mode 600), never in the public repo; the password
  is typed by Thomas in his own terminal (`node car/setup.mjs`), never in the chat.
- `car/poll.mjs` (cron, every 2 min; API call every 2 min while the car changes, every 10 min when idle): battery %,
  residual energy (Wh, more precise than the %), odometer; Peugeot trip history hourly (distance, duration, average
  speed, energy). Live consumption over the last ~30 km; long-term consumption by season (Nov–Mar) and road type
  (trip average ≥ 75 km/h = motorway); remaining km down to 8 %. No position is stored or sent.
- Transport to the phone: secret ntfy.sh channel (free, no account, HTTPS, messages kept 12 h); Péage Malin reads it
  (no port opened on the home computer). Link once: `…/#car=pm-…`. Panel "🔋" in the e-208 options; battery at departure
  pre-filled with the real level; measured consumptions (≥ 150 km per group) used for the planning (can be switched off).
- To verify on real data: trip energy values (some cars need a ×1.343 correction per the community project) against
  battery-level drops.

### D-034 follow-up — first real data (2026-11-09)
- The car's "residual Wh" does not match its % (26.7 of 33.2 kWh at 93 %): only the % is used (× 46 kWh).
- Trip `avgSpeed` is not in m/s: the average speed is computed as distance / duration.
- Peugeot's trip energy reads low (12.2 kWh/100 km raw). It is calibrated against real battery drops in the history
  (stretches without charging, ≥ 100 km); until then it is scaled to Thomas's own 15 kWh/100 km (factor 1.23).
- Measured motorway figures replace the settings (18/20) only once the calibration comes from real measurement.
- Settings: diesel price shown with 2 decimals (the automatic price had 3 and blocked the form); price fields accept
  any decimals; saving the settings no longer freezes the automatic diesel price unless the price was changed.

## D-035 — Google Maps follow check made permanent; two-link trips for long free stretches (2026-11-09)
- `tests/google_follow.mjs`: for every option shown, the Google stops are built as the app does on "Ouvrir dans Google
  Maps" (refineVia + charging stops), then TomTom's fastest route through them (tolls allowed = stand-in for Google) must
  pay no more than the option's tolls + 0.50 € and stay ≥ 90 % on its roads. Toll-free options are tested with "avoid
  tolls", as the app tells the user to switch it on. First run: 89/116 options followed.
- Cause of most misses: 9 stops (Google's limit) cannot hold Google on 200–300 km of free roads; and extra stops were
  spread evenly, missing the short stretch where the option leaves the motorway (Bordeaux: stayed on the A10 from
  Poitiers Nord to Poitiers Sud). Two stops per leak; 18 stops in one link were tried and barely helped.
- Fixes: refineVia puts a stop in the middle of each place where the option leaves the leaking toll road (plus the
  spread ones), tries 4 rounds and keeps the best set. Options "motorway to X, then free roads" (and the reverse) open
  as two Google Maps links split at X; the free part is driven with "Éviter les péages"; the 2nd link has no origin so
  Google starts from the phone's position. Result: 111/116 followed; the 5 left cost 2–5 € more (mostly Toulouse).
- Audit (tests/audit.mjs, 15 trips): 10/15 without gap, app best compromise kept on 13/15. Known gaps: Nantes
  (+6 min −2.27 €), Clermont borderline (+4 min −9.79 € vs app +6 min −13.08 €), slow toll-free variants (+74…199 min).
- Économe vs complète (`tests/compare_all.mjs`, each method in its own process): the public Valhalla server answers the
  first trip, then refuses connections (each économe search sends it 100–160 requests); the app then falls back to the
  complete method (notice shown). On the one real comparison (Bordeaux) économe used 21 TomTom requests instead of 103
  but missed a 16 € saving (best compromise +20 min −13.54 € instead of +12 min −22.55 €). Decision: complète stays the
  default; économe is not recommended.

## D-036 — Économe method removed; one Google Maps link by default, fewer stops (2026-11-09)
- Thomas: "remove the économe, it is useless" (D-035 results). Removed from the app (settings choice, Valhalla calls,
  estimate/shortlist code) and from the tests (`compare_all.mjs`, `compare_modes.mjs` deleted). Valhalla stays only
  for the one-time off-motorway points precomputation (data files).
- Thomas: switching between two Google links while driving is not practical, and short routes had many stops.
  - Options start with few stops: both ends of each avoided toll part, then one per ~40 km (before: always filled up
    to 9). `refineVia` (run on "Ouvrir dans Google Maps") adds stops only where its TomTom check finds Google would
    pay a toll the option avoids **or leave the option's roads** (new: parts of the line > 1.5 km from the test
    route); toll-free options are checked with "avoid tolls"; the e-208 charging stops are part of the check.
  - One link by default. Two links only when that check fails on a "motorway to X, then free roads" option; each part
    is then checked on its own (`refineLegs`). The card shows one button; the two buttons and the explanation appear
    after the tap only when needed.
- Results (`tests/google_follow.mjs`): diesel 113/116 followed (was 111), two links on 17 options (was every
  "then free roads" option), average 6.6 stops (was ~9), 20 options with ≤ 3 stops; e-208 30/31 (unchanged).
  Remaining: Clermont "Autre itinéraire (par N154, A10, A71)", two Toulouse options (2–4.50 € more).

## D-037 — "En route": battery checked against the road ahead while driving (2026-11-10)
Thomas: real-time remaining km on long motorway trips; never "plenty of margin" because the last km were country roads
with 200 km of motorway ahead.
- `app/js/enroute.js` (shared by the phone and `car/poll.mjs`). Button "🔋 Suivre ma batterie" on e-208 options and
  saved trips sends a small trip profile (km ranges motorway / other roads, planned stops with planned arrival %, one
  fast charger per 8 km with its km along the route, rates and reserve; no positions, < 4 kB) to the ntfy channel
  `<car channel>-trajet`. Progress = odometer now − odometer at departure.
- Consumption measured on the trip itself, per kind of road (each stretch between two car readings is split by the
  planned route; last 60 km of each). Motorway figure used after 25 km of motorway, other roads after 15 km. Lower than
  planned counts at most −10 %; higher counts in full and is also applied to the other kind of road while that one is
  unmeasured. Country-road good news never lowers the motorway figure.
- Verdict for the next planned charger (or the arrival): OK ≥ reserve + 5 % (or at least as good as the plan − 2 %),
  "juste" above the reserve, "insuffisant" below → names the last charger reachable above the reserve (or a safer
  earlier one when "juste"), slow-down hint (−10 % per 10 km/h, rough), "stop no longer needed" when ahead of plan,
  range on the road ahead down to the reserve.
- Home computer: reads the trip channel each run, calls the car every 2 min during a followed trip, adds the check to
  the summary (the phone shows it; without it the phone computes a provisional one from the last reading) and sends
  alerts to `<car channel>-alerte` (ntfy app on the phone, shown over Google Maps): start, verdict / advice change,
  first motorway measurement, every 30 min while driving, arrival. Trip ends on arrival, "Terminer le suivi" or 36 h.
- Charging planner: energy per km by road type (motorway / other rates, scaled to the route total) instead of an even
  average, so plans and the en-route check agree; chargers matched to the road line between points, not only to the
  points (a service area between two points 1–3 km apart was missed: Paris→Lyon "Évite le Duplex" found no plan,
  182 km without a charger). Lyon e-208 test: 14/14 options with a plan (11 before), motorway plans 6–12 min shorter.
- Unknown until a real drive: whether the e-208 sends readings while moving or only when stopped.
- Not handled: which side of the motorway a charger is on (the charger file's coordinates and names are not reliable
  enough).

## D-038 — Charge stopped automatically at 6:00, always on Tempo red days (2026-11-10)
Thomas: the MyPeugeot app programs the start of the charge (22:00) but not its end; on red days he gets up early to
stop it. Wanted: stop at 6:00 every day unless asked otherwise (button), always on red days.
- `car/charge.mjs` (cron 05:50): Tempo colour of the day (api-couleur-tempo.fr, free; cached hourly by poll.mjs); if the
  car is charging (or, on a red day, plugged with an unclear status) → `/VehCharge {type: delayed, program: the car's
  programmed hour}` = back to the programmed charge, so it restarts by itself at 22:00. Checked 45 s later, up to 3 tries,
  result to the ntfy app; failure on a red day = urgent alert. Colour unknown from November to March (not Sunday) →
  treated as red.
- Skip: Péage Malin card "🔌" at the top → `<car channel>-commande` {type: skip|unskip, date of the morning}; poll.mjs
  stores it (state.chargeSkip); ignored on red days. The card shows tomorrow's colour and this morning's result.
- Remote commands like the MyPeugeot app: one-time OTP activation (SMS code + MyPeugeot PIN typed by Thomas:
  `node car/charge.mjs setup`), then MQTT (mwa.mpsa.com:8885) with a token renewed by refresh token (3 days, renewed by
  the daily job) or a new OTP code (Peugeot limit 6 a day; we stop at 5). `car/remote.py` in a private Python venv
  (pycryptodome, paho-mqtt, requests); OTP code = reviewed copy of the community project's MIT module (`car/stellotp/`,
  network only to otp.mpsa.com). Claude Code's safety check does not let Claude run that code: Thomas runs the setup and
  the first tests himself.
- Test commands: `node car/charge.mjs check | stop | start`.

Addition (2026-11-10, app v18): start / stop now buttons on the charge card, relayed by the home computer within
~2 min (the phone cannot talk to the car itself without exposing the account); the answer comes as a notification.
