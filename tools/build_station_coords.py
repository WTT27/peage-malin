"""Convert the official toll-station dataset (Lambert93) to WGS84 JSON, one entry per station name."""
import csv, json, sys
from pyproj import Transformer

t = Transformer.from_crs('EPSG:2154', 'EPSG:4326', always_xy=True)
out = {}
for r in csv.DictReader(open(sys.argv[1], encoding='utf-8'), delimiter=';'):
    lon, lat = t.transform(float(r['x'].replace(',', '.')), float(r['y'].replace(',', '.')))
    road = r['route']
    import re
    m = re.match(r'^\d\w(A)9(\d{3})', road) or re.match(r'^(A)0*(\d+\w*)', road)
    road = 'A' + m.group(2).lstrip('0') if m else road
    e = out.setdefault(r['nomGare'], {'name': r['nomGare'], 'type': r['typeGare'], 'road': road, 'points': []})
    e['points'].append([round(lat, 6), round(lon, 6)])
for e in out.values():
    e['lat'] = round(sum(p[0] for p in e['points']) / len(e['points']), 6)
    e['lon'] = round(sum(p[1] for p in e['points']) / len(e['points']), 6)
json.dump(sorted(out.values(), key=lambda e: e['name']), open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
print(len(out), 'stations')
