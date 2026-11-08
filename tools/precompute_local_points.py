"""For every located toll station, find a point on an ordinary road (trunk/primary/secondary/tertiary, not toll,
not motorway) 250 m – 2.5 km away, so that toll-free legs can start there. Result cached in
data/tolls/local_points.json and embedded in the app data (no Overpass call needed on the phone)."""
import json, math, time, urllib.request, urllib.parse, os

OUT = 'data/tolls/local_points.json'
MIRRORS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter',
           'https://overpass.kumi.systems/api/interpreter']


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def main():
    idx = json.load(open('data/tolls/index.json'))
    done = json.load(open(OUT)) if os.path.exists(OUT) else {}
    pts = {}
    for k, s in idx['stations'].items():
        if s['points']:
            # one representative point per station cluster (stations can have points far apart: keep each cluster)
            for p in s['points']:
                key = f'{p[0]:.4f},{p[1]:.4f}'
                pts.setdefault(key, p)
    todo = [k for k in pts if k not in done]
    print(len(pts), 'points,', len(todo), 'to do')
    for i in range(0, len(todo), 30):
        batch = todo[i:i + 30]
        q = '[out:json][timeout:120];(' + ''.join(
            f'way(around:2500,{pts[k][0]},{pts[k][1]})[highway~"^(trunk|primary|secondary|tertiary)$"][toll!=yes][motorroad!=yes];'
            for k in batch) + ');out geom;'
        data = None
        for a in range(6):
            try:
                req = urllib.request.Request(MIRRORS[a % len(MIRRORS)], data=urllib.parse.urlencode({'data': q}).encode(),
                                             headers={'User-Agent': 'peage-malin/0.1 (personal project)'})
                data = json.load(urllib.request.urlopen(req, timeout=150))
                break
            except Exception as e:
                time.sleep(5 * (a + 1))
        if data is None:
            print('batch failed', i); continue
        nodes = [(g['lat'], g['lon']) for w in data['elements'] for g in w.get('geometry', [])]
        for k in batch:
            p = pts[k]
            best = min(((km(p, n), n) for n in nodes if km(p, n) > 0.25), default=None)
            done[k] = [round(best[1][0], 5), round(best[1][1], 5)] if best and best[0] < 2.5 else None
        json.dump(done, open(OUT, 'w'))
        print(f'{min(i + 30, len(todo))}/{len(todo)}', flush=True)
        time.sleep(2)
    ok = sum(1 for v in done.values() if v)
    print('done:', ok, '/', len(done), 'with a local road point')


if __name__ == '__main__':
    main()
