"""Prototype planner: generate route alternatives, cost them, recommend one.

Generalised cost = tolls + energy (+ charging time for the e-208) + duration x value of time.

Alternatives:
  * TomTom fastest + up to 2 TomTom alternatives
  * toll-free route
  * for each toll stretch of the fastest route: skip it entirely, leave it earlier, or join it later
    (built as 3 legs: normal / toll-free / normal).
"""
import json, math, sys, datetime, urllib.request, functools, argparse
sys.path.insert(0, 'tools')
import toll_engine as te

KEY = open('.env').read().split('TOMTOM_KEY=')[1].split()[0]

VEHICLES = {
    'diesel': {'label': '5008 diesel', 'l_per_100': 6.0, 'eur_per_l': 2.21, 'max_speed': None},
    'ev': {'label': 'e-208', 'kwh_motorway': 18.0, 'kwh_other': 15.0, 'battery_kwh': 46.0,
           'home_eur_kwh': 0.14, 'fast_eur_kwh': 0.54, 'charge_kw': 45.0, 'stop_overhead_min': 10,
           'max_speed': 110},
}
CALLS = {'n': 0}


@functools.lru_cache(maxsize=None)
def route(o, d, avoid_tolls=False, max_speed=None, depart=None, alternatives=0):
    CALLS['n'] += 1
    url = (f'https://api.tomtom.com/routing/1/calculateRoute/{o[0]},{o[1]}:{d[0]},{d[1]}/json?key={KEY}'
           f'&traffic=true&sectionType=tollRoad&sectionType=motorway&maxAlternatives={alternatives}')
    if avoid_tolls:
        url += '&avoid=tollRoads'
    if max_speed:
        url += f'&vehicleMaxSpeed={max_speed}'
    if depart:
        url += f'&departAt={depart}'
    return json.load(urllib.request.urlopen(url, timeout=60))['routes']


def motorway_km(r):
    pts = [(p['latitude'], p['longitude']) for leg in r['legs'] for p in leg['points']]
    tot = 0.0
    for s in r.get('sections', []):
        if s['sectionType'] == 'MOTORWAY':
            seg = pts[s['startPointIndex']:s['endPointIndex'] + 1]
            tot += sum(te.km(a, b) for a, b in zip(seg, seg[1:]))
    return tot


def evaluate(legs, veh, depart):
    """legs: list of TomTom route objects driven one after the other."""
    t = depart
    res = {'km': 0.0, 'sec': 0, 'toll': 0.0, 'mkm': 0.0, 'details': [], 'unpriced': 0, 'polys': []}
    for r in legs:
        s = r['summary']
        toll, det, unp = te.price_route(r, t)
        res['km'] += s['lengthInMeters'] / 1000
        res['sec'] += s['travelTimeInSeconds']
        res['toll'] += toll
        res['details'] += det
        res['unpriced'] += len(unp)
        res['mkm'] += motorway_km(r)
        t += datetime.timedelta(seconds=s['travelTimeInSeconds'])
    v = VEHICLES[veh]
    if veh == 'diesel':
        res['energy'] = res['km'] * v['l_per_100'] / 100 * v['eur_per_l']
        res['charge_min'] = 0
    else:
        kwh = res['mkm'] * v['kwh_motorway'] / 100 + (res['km'] - res['mkm']) * v['kwh_other'] / 100
        home = min(kwh, v['battery_kwh'] * 0.9)          # keep ~10 % margin on arrival / before charging
        extra = kwh - home
        res['energy'] = home * v['home_eur_kwh'] + extra * v['fast_eur_kwh']
        stops = math.ceil(extra / (v['battery_kwh'] * 0.7)) if extra > 0 else 0   # 10 -> 80 % per stop
        res['charge_min'] = extra / v['charge_kw'] * 60 + stops * v['stop_overhead_min']
        res['kwh'] = kwh
    res['total_min'] = res['sec'] / 60 + res['charge_min']
    return res


def toll_stretches(r):
    pts = [(p['latitude'], p['longitude']) for leg in r['legs'] for p in leg['points']]
    out = []
    for s in r.get('sections', []):
        if s['sectionType'] == 'TOLL_ROAD':
            out.append(pts[s['startPointIndex']:s['endPointIndex'] + 1])
    return out, pts


def interior_stations(poly, max_n=3):
    """Priced stations located on a toll stretch (candidate places to leave / join)."""
    found = []
    L = len(poly)
    for key, s in te.STATIONS.items():
        for p in s['points']:
            dists = [(te.km(p, q), i) for i, q in enumerate(poly[::4])]
            d, i = min(dists)
            i *= 4
            if d < 0.4 and 0.1 * L < i < 0.9 * L:
                found.append((i, key, tuple(poly[i])))
                break
    found.sort()
    # keep well-spread candidates
    if len(found) > max_n:
        step = len(found) / max_n
        found = [found[int(k * step + step / 2)] for k in range(max_n)]
    return found


def plan(o, d, veh, vot, depart):
    v = VEHICLES[veh]
    ms = v['max_speed']
    dep = depart.strftime('%Y-%m-%dT%H:%M:%S')
    cands = []
    base = route(o, d, False, ms, dep, 2)
    for k, r in enumerate(base):
        cands.append(('Le plus rapide' if k == 0 else f'Alternative TomTom {k}', [r]))
    cands.append(('Sans péage', route(o, d, True, ms, dep)[:1]))
    fastest = base[0]
    stretches, _ = toll_stretches(fastest)
    for si, poly in enumerate(stretches):
        a, b = tuple(poly[0]), tuple(poly[-1])
        inner = interior_stations(poly)
        options = [('éviter le tronçon', a, b)]
        for _, key, p in inner:
            name = te.STATIONS[key]['name']
            options.append((f'sortir à {name}', p, b))
            options.append((f'entrer à {name}', a, p))
        for label, x, y in options:
            try:
                legs = [route(o, x, False, ms, dep)[0], route(x, y, True, ms)[0], route(y, d, False, ms)[0]]
            except Exception as e:
                continue
            cands.append((f'Tronçon {si + 1}: {label}', legs))
    rows = []
    for label, legs in cands:
        e = evaluate(legs, veh, depart)
        e['label'] = label
        e['gen'] = e['toll'] + e['energy'] + e['total_min'] / 60 * vot
        rows.append(e)
    # de-duplicate near-identical results
    uniq = []
    for r in sorted(rows, key=lambda r: r['gen']):
        if not any(abs(r['total_min'] - u['total_min']) < 2 and abs(r['toll'] - u['toll']) < 0.3 for u in uniq):
            uniq.append(r)
    for r in uniq:
        r['pareto'] = not any(u['total_min'] <= r['total_min'] and u['toll'] + u['energy'] <= r['toll'] + r['energy']
                              and u is not r and (u['total_min'] < r['total_min'] or u['toll'] + u['energy'] < r['toll'] + r['energy'])
                              for u in uniq)
    return uniq


def hm(m):
    m = round(m)
    return f'{m // 60} h {m % 60:02d}'


def show(rows, veh, vot):
    ref = min(rows, key=lambda r: r['total_min'])
    best = min(rows, key=lambda r: r['gen'])
    print(f"{'':2}{'Itinéraire':52} {'km':>5} {'durée':>8} {'péage':>7} {'énergie':>8} {'total €':>8} {'coût géné.':>10}")
    for r in sorted(rows, key=lambda r: r['total_min']):
        mark = '★' if r is best else ('·' if r['pareto'] else ' ')
        flag = ' (!)' if r['unpriced'] else ''
        print(f"{mark:2}{r['label'][:52]:52} {r['km']:5.0f} {hm(r['total_min']):>8} {r['toll']:7.2f} {r['energy']:8.2f} "
              f"{r['toll'] + r['energy']:8.2f} {r['gen']:10.2f}{flag}")
    dm = best['total_min'] - ref['total_min']
    de = (ref['toll'] + ref['energy']) - (best['toll'] + best['energy'])
    print(f"\n★ Recommandé ({VEHICLES[veh]['label']}, {vot:.0f} €/h): {best['label']} — "
          f"{'+' if dm >= 0 else ''}{dm:.0f} min, économie {de:.2f} € vs le plus rapide")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('origin'); ap.add_argument('dest')
    ap.add_argument('--vehicle', default='diesel', choices=VEHICLES)
    ap.add_argument('--vot', type=float, default=10.0)
    ap.add_argument('--depart', default=None, help='YYYY-MM-DDTHH:MM')
    a = ap.parse_args()
    o = tuple(map(float, a.origin.split(','))); d = tuple(map(float, a.dest.split(',')))
    dep = datetime.datetime.fromisoformat(a.depart) if a.depart else datetime.datetime.now().replace(second=0, microsecond=0)
    rows = plan(o, d, a.vehicle, a.vot, dep)
    show(rows, a.vehicle, a.vot)
    print('Sensibilité (valeur de l\'heure -> choix):')
    for v in (5, 10, 15, 20, 30, 50):
        b = min(rows, key=lambda r: r['toll'] + r['energy'] + r['total_min'] / 60 * v)
        print(f"   {v:>3} €/h: {b['label']} ({hm(b['total_min'])}, {b['toll'] + b['energy']:.2f} €)")
    print(f'({CALLS["n"]} TomTom requests)')
