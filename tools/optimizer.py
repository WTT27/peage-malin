"""Optimizer v2: find the good in-between routes.

Search space, built around the fastest route:
  * Corridor model, per toll stretch: the stretch is cut at every priced interchange; each piece between two
    consecutive interchanges is driven either on the motorway or on free roads (TomTom, avoid tolls).
    All combinations are enumerated -> covers "skip the middle", "leave early", "join late", several skips...
    Each maximal motorway run is priced as ONE ticket (closed systems) by the toll engine.
  * Escape routes: leave the motorway at interchange X and take free roads to the destination
    (or free roads from the origin to X, then motorway). This is where national roads like the N10 appear.
  * Plus: fastest, TomTom alternatives, fully toll-free.
Stretches are combined assuming their effects add up; the final shortlist is re-built from real legs.

Output: efficient routes (nobody faster AND cheaper), free wins, best compromise, savings ladder.
"""
import json, math, sys, os, datetime, itertools, argparse, hashlib, urllib.request
sys.path.insert(0, 'tools')
import toll_engine as te
import planner as pl

CACHE_FILE = 'data/cache/tomtom_cache.json'
os.makedirs('data/cache', exist_ok=True)
_cache = json.load(open(CACHE_FILE)) if os.path.exists(CACHE_FILE) else {}
CALLS = {'api': 0, 'cached': 0}
TRANSITION_SEC = 60        # slowing down / toll lane when leaving or joining the motorway
MAX_NODES = 12             # interchanges kept per stretch (well spread)


def route(o, d, avoid=False, ms=None, dep=None, alts=0):
    k = hashlib.md5(json.dumps([o, d, avoid, ms, dep, alts]).encode()).hexdigest()
    if k in _cache:
        CALLS['cached'] += 1
        return _cache[k]
    import time, urllib.error
    for attempt in range(6):
        time.sleep(0.25)                       # TomTom free tier: max ~5 requests / second
        try:
            CALLS['api'] += 1
            r = pl.route.__wrapped__(tuple(o), tuple(d), avoid, ms, dep, alts)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 ** attempt)
                continue
            if e.code == 400:                  # e.g. no route between two points
                r = []
                break
            raise
    else:
        save_cache()
        raise RuntimeError('TomTom rate limit')
    _cache[k] = r
    if CALLS['api'] % 20 == 0:
        save_cache()
    return r


def save_cache():
    json.dump(_cache, open(CACHE_FILE, 'w'))


LOCAL_FILE = 'data/cache/local_points.json'
_local = json.load(open(LOCAL_FILE)) if os.path.exists(LOCAL_FILE) else {}
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter']


def local_points(points):
    """For motorway points, find a nearby point on an ordinary (non-toll, non-motorway) road, so that a
    'toll-free' leg really starts off the motorway. Batched Overpass query, cached on disk."""
    import urllib.parse, time
    todo = [p for p in points if f'{p[0]:.5f},{p[1]:.5f}' not in _local]
    for i in range(0, len(todo), 25):
        batch = todo[i:i + 25]
        q = '[out:json][timeout:120];(' + ''.join(
            f'way(around:1500,{p[0]},{p[1]})[highway~"^(trunk|primary|secondary|tertiary)$"][toll!=yes];'
            for p in batch) + ');out geom;'
        data = None
        for attempt in range(6):
            url = OVERPASS[attempt % len(OVERPASS)]
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(),
                                             headers={'User-Agent': 'peage-malin/0.1'})
                data = json.load(urllib.request.urlopen(req, timeout=180))
                break
            except Exception:
                time.sleep(5 * (attempt + 1))
        if data is None:
            raise RuntimeError('Overpass unavailable')
        nodes = [(g['lat'], g['lon']) for w in data['elements'] for g in w.get('geometry', [])]
        for p in batch:
            # nearest ordinary-road point that is at least 250 m away from the motorway point
            best = min(((te.km(p, q), q) for q in nodes if te.km(p, q) > 0.25), default=None)
            _local[f'{p[0]:.5f},{p[1]:.5f}'] = list(best[1]) if best and best[0] < 2.5 else None
        json.dump(_local, open(LOCAL_FILE, 'w'))
    return [(_local.get(f'{p[0]:.5f},{p[1]:.5f}') and tuple(_local[f'{p[0]:.5f},{p[1]:.5f}'])) for p in points]


def leg_metrics(r):
    s = r['summary']
    return {'km': s['lengthInMeters'] / 1000, 'sec': s['travelTimeInSeconds'], 'mkm': pl.motorway_km(r)}


def polyline(r):
    return [(p['latitude'], p['longitude']) for leg in r['legs'] for p in leg['points']]


def stretch_nodes(pts, cum, i0, i1):
    """Interchanges along a toll stretch: [(index_in_pts, label)], including stretch start and end."""
    seg = pts[i0:i1 + 1]
    found = []
    for key, s in te.STATIONS.items():
        for p in s['points']:
            if not (min(q[0] for q in seg[::20]) - 0.05 <= p[0] <= max(q[0] for q in seg[::20]) + 0.05):
                continue
            d, j = min((te.km(p, seg[k]), k) for k in range(0, len(seg), 2))
            if d < 0.4:
                found.append((cum[i0 + j], i0 + j, s['name']))
                break
    found.sort()
    nodes = [(i0, 'début du tronçon')]
    for pos, idx, name in found:
        if pos - cum[nodes[-1][0]] > 3 and cum[i1] - pos > 3:      # ignore duplicates / too close to ends
            nodes.append((idx, name))
    if len(nodes) - 1 > MAX_NODES:
        inner = nodes[1:]
        step = len(inner) / MAX_NODES
        nodes = [nodes[0]] + [inner[int(k * step)] for k in range(MAX_NODES)]
    nodes.append((i1, 'fin du tronçon'))
    return nodes


def clean_name(n):
    import re
    return re.sub(r'^\d+(\.\d+)?[a-z]?(?=[A-ZÉ])', '', n).strip()


def run_price(legs, when):
    """Price one continuous motorway run made of consecutive legs, as a single ticket."""
    pts = [p for r in legs for p in polyline(r)]
    if len(pts) < 2:
        return 0.0, []
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + te.km(a, b))
    p, info = te.price_section(pts, cum, 0, len(pts) - 1, when)
    if p is None:
        return None, info
    return p, info


def optimise_stretch(pts, cum, i0, i1, ms, dep, when):
    nodes = stretch_nodes(pts, cum, i0, i1)
    P = [pts[i] for i, _ in nodes]
    n = len(nodes)
    toll_legs = [route(P[j], P[j + 1], False, ms, dep)[0] for j in range(n - 1)]
    L = local_points(P)
    L = [L[j] or P[j] for j in range(n)]
    L[0], L[-1] = (L[0] if nodes[0][1] != 'début du tronçon' else L[0]), L[-1]
    free_legs = []
    for j in range(n - 1):
        r = route(L[j], L[j + 1], True, ms, dep)
        free_legs.append(r[0] if r else toll_legs[j])
    tm = [leg_metrics(r) for r in toll_legs]
    fm = [leg_metrics(r) for r in free_legs]
    for r, m in zip(free_legs, fm):                 # 'avoid tolls' is only a preference for TomTom
        t, _, unp = te.price_route(r, when)
        m['toll'] = t if not unp else None
    price_cache = {}

    def price_run(a, b):
        if (a, b) not in price_cache:
            price_cache[(a, b)] = run_price(toll_legs[a:b], when)
        return price_cache[(a, b)]

    options = []
    for combo in itertools.product((1, 0), repeat=n - 1):       # 1 = motorway, 0 = free road
        km_ = sec = mkm = 0.0
        toll, ok, desc = 0.0, True, []
        j = 0
        while j < n - 1:
            if combo[j]:
                k = j
                while k < n - 1 and combo[k]:
                    k += 1
                p, info = price_run(j, k)
                if p is None:
                    ok = False
                    break
                toll += p
                for x in range(j, k):
                    km_ += tm[x]['km']; sec += tm[x]['sec']; mkm += tm[x]['mkm']
                j = k
            else:
                k = j
                while k < n - 1 and not combo[k]:
                    k += 1
                for x in range(j, k):
                    km_ += fm[x]['km']; sec += fm[x]['sec']; mkm += fm[x]['mkm']
                    if fm[x]['toll'] is None:
                        ok = False
                    else:
                        toll += fm[x]['toll']
                desc.append((j, k))
                j = k
        if not ok:
            continue
        transitions = sum(1 for a, b in zip(combo, combo[1:]) if a != b)
        sec += transitions * TRANSITION_SEC
        if desc:
            parts = []
            for a, b in desc:
                fa = 'début' if a == 0 else clean_name(nodes[a][1])
                fb = 'fin' if b == n - 1 else clean_name(nodes[b][1])
                parts.append(f'gratuit {fa} → {fb}')
            label = ', '.join(parts)
        else:
            label = 'autoroute'
        options.append({'km': km_, 'sec': sec, 'mkm': mkm, 'toll': toll, 'label': label, 'combo': combo})
    base = next(o for o in options if all(options[0]['combo'])) if options and all(options[0]['combo']) else None
    return nodes, options, base


def frontier(items, tkey, ckey):
    out = []
    for it in sorted(items, key=lambda x: (x[tkey], x[ckey])):
        if not out or it[ckey] < out[-1][ckey] - 0.05:
            out.append(it)
    return out


def analyse(o, d, veh, depart, verbose=True):
    v = pl.VEHICLES[veh]
    ms = v['max_speed']
    dep = depart.strftime('%Y-%m-%dT%H:%M:%S')
    routes = route(o, d, False, ms, dep, 2)
    fastest = routes[0]
    pts = polyline(fastest)
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + te.km(a, b))
    base = pl.evaluate([fastest], veh, depart)
    stretches = [(s['startPointIndex'], s['endPointIndex']) for s in fastest['sections'] if s['sectionType'] == 'TOLL_ROAD'
                 if cum[s['endPointIndex']] - cum[s['startPointIndex']] > 1.5]
    tt = fastest['summary']['travelTimeInSeconds']

    # --- corridor options per stretch (as deltas vs. motorway) ---
    per_stretch = []
    for k, (i0, i1) in enumerate(stretches):
        when = depart + datetime.timedelta(seconds=tt * i0 / len(pts))
        nodes, opts, _ = optimise_stretch(pts, cum, i0, i1, ms, dep, when)
        mw = next((x for x in opts if all(x['combo'])), None)
        if mw is None:
            if verbose:
                print(f'  ! tronçon {k + 1}: prix autoroute introuvable, tronçon ignoré')
            continue
        deltas = [{'dkm': x['km'] - mw['km'], 'dsec': x['sec'] - mw['sec'], 'dmkm': x['mkm'] - mw['mkm'],
                   'dtoll': x['toll'] - mw['toll'], 'label': x['label'], 'stretch': k} for x in opts]
        deltas = frontier(deltas, 'dsec', 'dtoll')
        per_stretch.append((k, nodes, deltas))
        if verbose:
            print(f'  tronçon {k + 1}: {len(nodes) - 2} échangeurs, {len(opts)} combinaisons, {len(deltas)} efficaces')

    cands = []

    def add(label, km_, sec, mkm, toll, kind):
        e = {'label': label, 'km': km_, 'sec': sec, 'mkm': mkm, 'toll': toll, 'kind': kind}
        cands.append(e)

    # combine stretch options
    choice_lists = [ds for _, _, ds in per_stretch]
    for combo in itertools.product(*choice_lists):
        lab = [f'T{c["stretch"] + 1}: {c["label"]}' for c in combo if c['label'] != 'autoroute']
        add(' + '.join(lab) or 'Le plus rapide (autoroute)',
            base['km'] + sum(c['dkm'] for c in combo), base['sec'] + sum(c['dsec'] for c in combo),
            base['mkm'] + sum(c['dmkm'] for c in combo), base['toll'] + sum(c['dtoll'] for c in combo), 'corridor')

    # escape routes: leave at X then free to destination / free from origin to X then motorway
    for k, nodes, _ in per_stretch:
        for idx, name in nodes[1:-1]:
            X = local_points([pts[idx]])[0]
            if X is None:
                continue
            nm = clean_name(name)
            for kind, ab in (('sortie', ((o, X, False), (X, d, True))), ('entrée', ((o, X, True), (X, d, False)))):
                rs = [route(a_, b_, av, ms, dep) for a_, b_, av in ab]
                if not all(rs):
                    continue
                legs = [r_[0] for r_ in rs]
                e = pl.evaluate(legs, veh, depart)
                if e['unpriced']:
                    continue
                label = (f'Autoroute jusqu\'à {nm}, puis routes gratuites' if kind == 'sortie'
                         else f'Routes gratuites jusqu\'à {nm}, puis autoroute')
                add(label, e['km'], e['sec'] + TRANSITION_SEC, e['mkm'], e['toll'], 'escape')

    for i, r in enumerate(routes[1:], 1):
        e = pl.evaluate([r], veh, depart)
        if not e['unpriced']:
            add(f'Alternative TomTom {i}', e['km'], e['sec'], e['mkm'], e['toll'], 'tomtom')
    free = route(o, d, True, ms, dep)[0]
    e = pl.evaluate([free], veh, depart)
    add('Sans péage', e['km'], e['sec'], e['mkm'], e['toll'], 'free')
    save_cache()

    # energy + totals
    for c in cands:
        en = energy(c, veh)
        c.update(en)
        c['cost'] = c['toll'] + c['energy']
        c['min'] = c['sec'] / 60 + c['charge_min']
    eff = frontier(cands, 'min', 'cost')
    return base, eff, cands


def energy(c, veh):
    v = pl.VEHICLES[veh]
    if veh == 'diesel':
        return {'energy': c['km'] * v['l_per_100'] / 100 * v['eur_per_l'], 'charge_min': 0}
    kwh = c['mkm'] * v['kwh_motorway'] / 100 + (c['km'] - c['mkm']) * v['kwh_other'] / 100
    home = min(kwh, v['battery_kwh'] * 0.9)
    extra = kwh - home
    stops = math.ceil(extra / (v['battery_kwh'] * 0.7)) if extra > 0 else 0
    return {'energy': home * v['home_eur_kwh'] + extra * v['fast_eur_kwh'],
            'charge_min': extra / v['charge_kw'] * 60 + stops * v['stop_overhead_min']}


def hm(m):
    m = round(m)
    return f'{m // 60} h {m % 60:02d}'


def report(eff, veh):
    f0, f1 = eff[0], eff[-1]
    S, T = f0['cost'] - f1['cost'], f1['min'] - f0['min']
    best, bscore = None, -9
    print(f"\n  {'':3}{'+temps':>7} {'économie':>9} {'% écon.':>7} {'% temps':>7}  {'durée':>7} {'coût':>7}  itinéraire")
    for e in eff:
        dt, ds = e['min'] - f0['min'], f0['cost'] - e['cost']
        ps, pt = (ds / S if S > 0 else 0), (dt / T if T > 0 else 0)
        e['score'] = ps - pt
        if e['score'] > bscore and 0 < ps < 1:
            best, bscore = e, e['score']
    free_win = [e for e in eff if e['min'] - f0['min'] <= 3 and f0['cost'] - e['cost'] >= 1]
    for e in eff:
        dt, ds = e['min'] - f0['min'], f0['cost'] - e['cost']
        mark = '⭐' if e is best else ('🟢' if e in free_win else '  ')
        print(f"  {mark} {dt:+6.0f}' {ds:8.2f}€ {100 * ds / S if S else 0:6.0f}% {100 * dt / T if T else 0:6.0f}%  "
              f"{hm(e['min']):>7} {e['cost']:6.2f}€  {e['label'][:110]}")
    print('\n  Échelle des économies (meilleur itinéraire avec au plus +N min):')
    for budget in (5, 10, 15, 20, 30, 45, 60, 90):
        ok = [e for e in eff if e['min'] - f0['min'] <= budget]
        b = min(ok, key=lambda e: e['cost'])
        print(f"    +{budget:>2} min → économie {f0['cost'] - b['cost']:6.2f} €  ({b['label'][:90]})")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('origin'); ap.add_argument('dest')
    ap.add_argument('--vehicle', default='diesel', choices=pl.VEHICLES)
    ap.add_argument('--depart', default=None)
    a = ap.parse_args()
    o = tuple(map(float, a.origin.split(','))); d = tuple(map(float, a.dest.split(',')))
    dep = datetime.datetime.fromisoformat(a.depart) if a.depart else datetime.datetime.now().replace(second=0, microsecond=0)
    base, eff, cands = analyse(o, d, a.vehicle, dep)
    print(f'  {len(cands)} itinéraires évalués, {len(eff)} efficaces')
    report(eff, a.vehicle)
    print(f"  (TomTom: {CALLS['api']} requêtes, {CALLS['cached']} en cache)")
