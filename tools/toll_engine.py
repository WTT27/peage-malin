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
STATIONS, PRICES, FIXED = IDX['stations'], IDX['prices'], IDX.get('fixed', {})
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


def fixed_price(f, when):
    if 'MONTESSON' in f['name'].upper() and when.weekday() < 5 and when.date().isoformat() not in DUPLEX['holidays_2026']:
        h = when.hour + when.minute / 60
        if 10 <= h < 16 or h >= 21 or h < 6:
            return 6.6          # reduced rate (SAPN grid note)
    return f['price']


def locate(pts, cum, lo, hi, maxd=0.8):
    """Stations close to route points pts[lo:hi]; returns {key: (dist_km, position_km)}."""
    seg = pts[lo:hi]
    if not seg:
        return {}
    la = [p[0] for p in seg]; lo_ = [p[1] for p in seg]
    box = (min(la) - 0.02, max(la) + 0.02, min(lo_) - 0.03, max(lo_) + 0.03)
    out = {}
    for key, s in list(STATIONS.items()) + list(FIXED.items()):
        for p in s['points']:
            if not (box[0] <= p[0] <= box[1] and box[2] <= p[1] <= box[3]):
                continue
            best = min(((km(p, seg[i]), i) for i in range(0, len(seg), 2)))
            if best[0] <= maxd and (key not in out or best[0] < out[key][0]):
                out[key] = (best[0], cum[lo + best[1]])
    return out


def price_section(pts, cum, i0, i1, when=None):
    when = when or DEPART
    poly = pts[i0:i1 + 1]
    dp = duplex_price(poly, when)
    if dp and dp[0] != 'missing':
        return dp[0], [('COFIROUTE', dp[1], '', dp[0])]
    s0, s1 = cum[i0], cum[i1]
    lo = next((i for i in range(i0, -1, -1) if cum[i] < s0 - 6), 0)
    hi = next((i for i in range(i1, len(pts)) if cum[i] > s1 + 6), len(pts) - 1)
    near_ = locate(pts, cum, lo, hi + 1)
    ins = [(k, d, pos) for k, (d, pos) in near_.items() if k in STATIONS and s0 - 6 <= pos <= min(s1, s0 + 15)]
    outs = [(k, d, pos) for k, (d, pos) in near_.items() if k in STATIONS and max(s0, s1 - 15) <= pos <= s1 + 6]
    # route starting/ending right on the motorway (planner legs): accept the station nearest to that end
    if i0 == 0:
        ins += [(k, d, s0) for d, k in near(pts[0], R_END) if not any(k == x[0] for x in ins)]
    if i1 >= len(pts) - 1:
        outs += [(k, d, s1) for d, k in near(pts[-1], R_END) if not any(k == x[0] for x in outs)]
    best = None
    for ki, di, pi in ins:
        si = STATIONS[ki]
        for ko, do, po in outs:
            so = STATIONS[ko]
            if si['op'] != so['op'] or ki == ko or po <= pi:
                continue
            p = price(si['op'], si['name'], so['name'])
            if p is None:
                continue
            score = abs(pi - s0) + abs(po - s1) + 3 * (di + do)
            if best is None or score < best[0]:
                best = (score, p, [(si['op'], si['name'], so['name'], p)])
    if best:
        return best[1], best[2]
    # operator boundary split: entry(op1) -> X(op1) | Y(op2) -> exit(op2)
    inner = [(k, d, pos) for k, (d, pos) in near_.items() if k in STATIONS and s0 <= pos <= s1 and d < 0.6]
    for ki, di, pi in ins:
        si = STATIONS[ki]
        for ko, do, po in outs:
            so = STATIONS[ko]
            if si['op'] == so['op']:
                continue
            for kx, dx, px in inner:
                sx = STATIONS[kx]
                if sx['op'] != si['op'] or px <= pi:
                    continue
                p1 = price(si['op'], si['name'], sx['name'])
                if p1 is None:
                    continue
                for ky, dy, py in inner:
                    sy = STATIONS[ky]
                    if sy['op'] != so['op'] or abs(py - px) > 3 or py >= po:
                        continue
                    p2 = price(so['op'], sy['name'], so['name'])
                    if p2 is None:
                        continue
                    score = abs(pi - s0) + abs(po - s1) + 3 * (di + do) + abs(py - px)
                    if best is None or score < best[0]:
                        best = (score, p1 + p2, [(si['op'], si['name'], sx['name'], p1),
                                                 (so['op'], sy['name'], so['name'], p2)])
    if best:
        return best[1], best[2]
    # open-system barriers on the stretch
    bars = [(pos, k) for k, (d, pos) in near_.items() if k in FIXED and s0 - 1 <= pos <= s1 + 1 and d < 0.3]
    if bars:
        det = [(FIXED[k]['op'], FIXED[k]['name'], '(barrière)', fixed_price(FIXED[k], when)) for _, k in sorted(bars)]
        return sum(x[3] for x in det), det
    return None, {'entry_candidates': sorted((round(d, 2), k) for k, d, _ in ins)[:5],
                  'exit_candidates': sorted((round(d, 2), k) for k, d, _ in outs)[:5]}


def tomtom_route(orig, dest, key, extra=''):
    url = (f'https://api.tomtom.com/routing/1/calculateRoute/{orig[0]},{orig[1]}:{dest[0]},{dest[1]}/json'
           f'?key={key}&traffic=true&sectionType=tollRoad{extra}')
    return json.load(urllib.request.urlopen(url, timeout=60))['routes'][0]


def price_route(route, depart=None):
    pts = [(p['latitude'], p['longitude']) for leg in route['legs'] for p in leg['points']]
    total, details, unpriced = 0.0, [], []
    tt = route['summary']['travelTimeInSeconds']
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + km(a, b))
    for s in route.get('sections', []):
        if s['sectionType'] != 'TOLL_ROAD':
            continue
        poly = pts[s['startPointIndex']:s['endPointIndex'] + 1]
        i0, i1 = s['startPointIndex'], s['endPointIndex']
        if cum[i1] - cum[i0] < 1.5 and (i0 == 0 or i1 >= len(pts) - 1):
            continue   # snapping artefact: leg starts/ends on the motorway next to the interchange
        when = (depart or DEPART) + datetime.timedelta(seconds=tt * s['startPointIndex'] / max(1, len(pts) - 1))
        p, info = price_section(pts, cum, s['startPointIndex'], s['endPointIndex'], when)
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
