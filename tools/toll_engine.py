"""Prototype toll engine: price a TomTom route.

For each TomTom TOLL_ROAD section:
  1. entry point = section start, exit point = section end;
  2. candidate stations near each point (any operator);
  3. same-operator pair with a known price, closest to both points -> price;
  4. otherwise try a split at an operator boundary (a station of op1 and a station of op2 that are
     close to each other and to the route) -> sum of both prices;
  5. otherwise the section is reported as UNPRICED (never silently zero).
"""
import json, math, sys, urllib.request, urllib.parse, datetime, bisect

IDX = json.load(open('data/tolls/index.json'))
STATIONS, PRICES = IDX['stations'], IDX['prices']
DUPLEX = json.load(open('data/tolls/duplex_a86.json'))
DEPART = datetime.datetime.now()
R_END = 3.0      # km: max distance between a section end and its station
R_ROUTE = 0.6    # km: max distance between a boundary station and the route


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def near(pt, radius):
    out = []
    for key, s in STATIONS.items():
        if s['points']:
            d = min(km(pt, p) for p in s['points'])
            if d <= radius:
                out.append((d, key))
    return sorted(out)


def price(op, a, b):
    return PRICES.get(op, {}).get(f'{a}|{b}')


def route_dist(poly, pt):
    return min(km(pt, p) for p in poly[::3])


def duplex_price(poly, when):
    portals = DUPLEX['portals']
    a = min(portals, key=lambda k: km(poly[0], portals[k]))
    b = min(portals, key=lambda k: km(poly[-1], portals[k]))
    if km(poly[0], portals[a]) > 2 or km(poly[-1], portals[b]) > 2 or a == b:
        return None
    t = DUPLEX['tables'].get(f'{a}|{b}')
    if t is None:
        return 'missing', f'Duplex A86 {a}->{b} (direction not encoded yet)'
    d = when.date().isoformat()
    tomorrow = (when + datetime.timedelta(days=1)).date().isoformat()
    wd = when.weekday()
    if d in DUPLEX['holidays_2026'] or wd == 6:
        row = 'sun'
    elif when.month == 8:
        row = 'august'
    elif wd == 5:
        row = 'sat'
    elif wd == 4 or tomorrow in DUPLEX['holidays_2026']:
        row = 'fri'
    else:
        row = 'mon_thu'
    h = when.hour + when.minute / 60
    if h < 6:
        h += 24
    i = max(0, bisect.bisect_right(t['slots'], h) - 1)
    return t[row][i], f'Duplex A86 {a}->{b} ({row}, {when:%H:%M})'


def price_section(poly, when=None):
    p_in, p_out = poly[0], poly[-1]
    dp = duplex_price(poly, when or DEPART)
    if dp and dp[0] != 'missing':
        return dp[0], [('COFIROUTE', dp[1], '', dp[0])]
    ins, outs = near(p_in, R_END), near(p_out, R_END)
    best = None
    for di, ki in ins:
        for do, ko in outs:
            si, so = STATIONS[ki], STATIONS[ko]
            if si['op'] != so['op'] or ki == ko:
                continue
            p = price(si['op'], si['name'], so['name'])
            if p is not None and (best is None or di + do < best[0]):
                best = (di + do, p, [(si['op'], si['name'], so['name'], p)])
    if best:
        return best[1], best[2]
    # operator boundary split
    along = []
    for key, s in STATIONS.items():
        if s['points'] and any(route_dist(poly, pt) <= R_ROUTE for pt in s['points'][:4]):
            along.append(key)
    for di, ki in ins:
        si = STATIONS[ki]
        for do, ko in outs:
            so = STATIONS[ko]
            if si['op'] == so['op']:
                continue
            for kx in along:
                sx = STATIONS[kx]
                if sx['op'] != si['op']:
                    continue
                p1 = price(si['op'], si['name'], sx['name'])
                if p1 is None:
                    continue
                for ky in along:
                    sy = STATIONS[ky]
                    if sy['op'] != so['op']:
                        continue
                    if min(km(a, b) for a in sx['points'] for b in sy['points']) > 2:
                        continue
                    p2 = price(so['op'], sy['name'], so['name'])
                    if p2 is not None:
                        cand = (di + do, p1 + p2, [(si['op'], si['name'], sx['name'], p1),
                                                   (so['op'], sy['name'], so['name'], p2)])
                        if best is None or cand[0] < best[0]:
                            best = cand
    if best:
        return best[1], best[2]
    return None, {'entry_candidates': ins[:5], 'exit_candidates': outs[:5]}


def tomtom_route(orig, dest, key, extra=''):
    url = (f'https://api.tomtom.com/routing/1/calculateRoute/{orig[0]},{orig[1]}:{dest[0]},{dest[1]}/json'
           f'?key={key}&traffic=true&sectionType=tollRoad{extra}')
    return json.load(urllib.request.urlopen(url, timeout=60))['routes'][0]


def price_route(route):
    pts = [(p['latitude'], p['longitude']) for leg in route['legs'] for p in leg['points']]
    total, details, unpriced = 0.0, [], []
    for s in route.get('sections', []):
        if s['sectionType'] != 'TOLL_ROAD':
            continue
        poly = pts[s['startPointIndex']:s['endPointIndex'] + 1]
        p, info = price_section(poly)
        if p is None:
            unpriced.append({'from': poly[0], 'to': poly[-1], 'info': info})
        else:
            total += p
            details += info
    return total, details, unpriced


if __name__ == '__main__':
    key = open('.env').read().split('TOMTOM_KEY=')[1].split()[0]
    o = tuple(map(float, sys.argv[1].split(',')))
    d = tuple(map(float, sys.argv[2].split(',')))
    r = tomtom_route(o, d, key, ''.join(f'&{a}' for a in sys.argv[3:]))
    total, det, unp = price_route(r)
    s = r['summary']
    print(f"{s['lengthInMeters'] / 1000:.0f} km, {s['travelTimeInSeconds'] // 3600} h {s['travelTimeInSeconds'] % 3600 // 60:02d}")
    for op, a, b, p in det:
        print(f'  {op}: {a} -> {b}: {p:.2f} €')
    for u in unp:
        print('  UNPRICED section', [round(x, 4) for x in u['from']], '->', [round(x, 4) for x in u['to']])
        print('     entry candidates:', [(round(dd, 2), k) for dd, k in u['info']['entry_candidates']])
        print('     exit candidates :', [(round(dd, 2), k) for dd, k in u['info']['exit_candidates']])
    print(f'  TOTAL known tolls: {total:.2f} €' + (f'  (+ {len(unp)} unpriced section(s))' if unp else ''))
