"""For every located toll station point, find the nearest point on an ordinary road (tertiary..trunk, not toll,
not a slip road) within 2.5 km, so that toll-free legs can start there. Uses the Valhalla /locate service
(OpenStreetMap data, free, many points per request). Result: data/tolls/local_points.json, embedded in the app."""
import json, math, time, urllib.request, os

OUT = 'data/tolls/local_points.json'
URL = 'https://valhalla1.openstreetmap.de/locate'
FILTER = {'min_road_class': 'tertiary', 'max_road_class': 'trunk', 'exclude_ramp': True, 'exclude_toll': True}


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def main():
    idx = json.load(open('data/tolls/index.json'))
    done = {k: v for k, v in (json.load(open(OUT)).items() if os.path.exists(OUT) else []) if v}   # retry failures
    pts = {}
    for s in idx['stations'].values():
        for p in s['points']:
            pts.setdefault(f'{p[0]:.4f},{p[1]:.4f}', p)
    todo = [k for k in pts if k not in done]
    print(len(pts), 'points,', len(todo), 'to do', flush=True)
    for i in range(0, len(todo), 40):
        batch = todo[i:i + 40]
        q = {'locations': [{'lat': pts[k][0], 'lon': pts[k][1], 'radius': 2500, 'search_filter': FILTER} for k in batch],
             'costing': 'auto', 'verbose': False}
        res = None
        for a in range(5):
            try:
                req = urllib.request.Request(URL, data=json.dumps(q).encode(),
                                             headers={'Content-Type': 'application/json', 'User-Agent': 'peage-malin/0.1 (personal project)'})
                res = json.load(urllib.request.urlopen(req, timeout=90))
                break
            except Exception as e:
                print('  retry', a, e, flush=True)
                time.sleep(3 * (a + 1))
        if res is None:
            print('batch failed', i, flush=True)
            continue
        for k, x in zip(batch, res):
            e = (x.get('edges') or [None])[0] if x else None
            if e:
                c = (round(e['correlated_lat'], 5), round(e['correlated_lon'], 5))
                done[k] = list(c) if km(pts[k], c) < 2.5 else None
            else:
                done[k] = None
        json.dump(done, open(OUT, 'w'))
        print(f'{min(i + 40, len(todo))}/{len(todo)}', flush=True)
        time.sleep(1)
    print('done:', sum(1 for v in done.values() if v), '/', len(pts), 'with an ordinary-road point', flush=True)


if __name__ == '__main__':
    main()
