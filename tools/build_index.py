"""Build the unified toll index: every priced station (per operator) with GPS points, plus price pairs.

Coordinates come from (1) the official toll-station dataset, (2) OpenStreetMap motorway exits,
matched by normalised name. Output: data/tolls/index.json
"""
import json, re, unicodedata
from collections import defaultdict

ROOT = 'data/tolls/'


def norm(s):
    s = re.sub(r"N°\s*[\d.]+[A-Za-z]?", ' ', s)
    s = re.sub(r"\s+à\s+", ' / ', s)
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().upper()
    s = s.replace('’', "'").replace('ST-', 'SAINT-').replace('STE-', 'SAINTE-')
    s = re.sub(r'\bST\b', 'SAINT', s)
    s = re.sub(r'\bSTE\b', 'SAINTE', s)
    s = re.sub(r"N°\s*[\d.]+[A-Z]?", ' ', s)
    s = re.sub(r'\b(BPV|BARRIERE|PEAGE|DE|DU|DES|LA|LE|LES|D|L|SENS|PRINCIPALE|ECHANGEUR|DEMI|GARE|SYSTEME|OUVERT)\b', ' ', s)
    s = re.sub(r'\bSENS\s*\d\b', ' ', s)
    s = re.sub(r"[^A-Z0-9]+", ' ', s)
    s = re.sub(r'\b\d\b', ' ', s)   # lone digits (sens 1/2)
    return ' '.join(s.split())


def variants(name):
    """Alternative names hidden in a price-list label."""
    n = re.sub(r'^\d+(\.\d+)?[a-z]?(?=[A-ZÉ])', '', name.strip())      # Vinci leading exit number
    out = {n}
    for m in re.findall(r'\(([^)]*)\)?', n):
        out.add(re.sub(r'(?i)p[ée]age d[e’\']\s*', '', m))
    base = re.sub(r'\(.*', '', n)
    out.add(base)
    for part in re.split(r'\s+à\s+|\s*/\s*', base):
        out.add(part)
    res = {norm(v) for v in out}
    return {v for v in res if len(v) >= 3}


def load_geo():
    geo = defaultdict(list)   # normalised name -> [(lat, lon, source)]
    for e in json.load(open(ROOT + 'stations_geo.json')):
        for v in variants(e['name']):
            geo[v].append((e['lat'], e['lon'], 'gare:' + e['name']))
    for e in json.load(open('data/raw/osm_motorway_junctions_fr.json'))['elements']:
        name = e.get('tags', {}).get('name')
        if name:
            for v in variants(name):
                geo[v].append((e['lat'], e['lon'], 'osm:' + name))
    return geo


def load_exits():
    """(road, exit ref) -> [(lat, lon)] from OSM motorway junctions + motorway ways."""
    ways = json.load(open('data/raw/osm_motorway_ways_fr.json'))['elements']
    node_roads = defaultdict(set)
    for w in ways:
        for r in re.split(r'[;,]', w.get('tags', {}).get('ref', '')):
            r = r.replace(' ', '').upper()
            if r.startswith('A'):
                for n in w.get('nodes', []):
                    node_roads[n].add(r)
    exits = defaultdict(list)
    for e in json.load(open('data/raw/osm_motorway_junctions_fr.json'))['elements']:
        ref = e.get('tags', {}).get('ref')
        if not ref:
            continue
        for road in node_roads.get(e['id'], ()):
            for r in re.split(r'[;/]', ref):
                exits[(road, r.strip().upper())].append((e['lat'], e['lon'], f'osm-exit:{road}/{r.strip()}'))
    return exits


def exit_refs(name):
    """Exit numbers in a label; 'X N°15 à Y N°17' means the zone of exits 15..17."""
    nums = re.findall(r'N°\s*(\d+(?:\.\d+)?[A-Za-z]?)', name)
    if len(nums) == 2 and ' à ' in name and all(re.match(r'^\d+$', n) for n in nums):
        a, b = sorted(map(int, nums))
        return [str(i) for i in range(a, b + 1)]
    return nums


def operators():
    """Yield (operator, [station names], {(a, b): price})."""
    for op, f in [('SAPN', 'sapn.json'), ('SANEF', 'sanef.json')]:
        d = json.load(open(ROOT + f))
        for s in d['sections']:
            st = s['stations']
            roads = re.findall(r'A\d+', s['title'])
            yield op, [(n, roads, exit_refs(n)) for n in st], {(st[i], st[j]): p for i, j, p in s['pairs']}
    d = json.load(open(ROOT + 'vinci.json'))
    for s in d['sections']:
        st = s['stations']
        yield 'VINCI', [(n, [], []) for n in st], {(st[i], st[j]): p for i, j, p in s['pairs']}
    for op, f in [('APRR', 'aprr.json'), ('AREA', 'area.json')]:
        d = json.load(open(ROOT + f))
        pairs = {tuple(k.split('|')): v[1] for k, v in d['pairs'].items()}
        yield op, [(n, [], []) for n in d['stations']], pairs
    d = json.load(open(ROOT + 'cofiroute.json'))
    yield 'COFIROUTE', [(n, [v['road']], [v['exit']] if v['exit'] != '-' else []) for n, v in d['stations'].items()], {tuple(k.split('|')): v for k, v in d['pairs'].items()}


def main():
    geo = load_geo()
    exits = load_exits()
    stations, prices, missing = {}, {}, []
    for op, names, pairs in operators():
        for n, roads, refs in names:
            key = f'{op}|{n}'
            pts = []
            for road in roads:
                for r in refs:
                    pts += exits.get((road, r.upper()), [])
            for v in (variants(n) if not pts else []):
                pts += geo.get(v, [])
            if not pts:   # fallback: all tokens of a variant contained in a geo name
                for v in variants(n):
                    toks = set(v.split())
                    if len(toks) >= 2:
                        for g, p in geo.items():
                            if toks <= set(g.split()):
                                pts += p
            pts = sorted(set(pts))
            stations[key] = {'op': op, 'name': n, 'points': [[a, b] for a, b, _ in pts],
                             'sources': sorted({s for _, _, s in pts})[:6]}
            if not pts:
                missing.append(key)
        tab = prices.setdefault(op, {})
        for (a, b), p in pairs.items():
            tab[f'{a}|{b}'] = p
            tab.setdefault(f'{b}|{a}', p)
    fixed = {}
    for op, f in [('SAPN', 'sapn.json'), ('SANEF', 'sanef.json')]:
        for x in json.load(open(ROOT + f)).get('fixed', []):
            pts = []
            for v in variants(x['station']):
                pts += geo.get(v, [])
            fixed[f"{op}|FIXED|{x['station']}"] = {'op': op, 'name': x['station'], 'price': x['price'],
                                                  'points': sorted({(a, b) for a, b, _ in pts})}
            if not pts:
                missing.append(f"{op}|FIXED|{x['station']}")
    json.dump({'stations': stations, 'prices': prices, 'fixed': fixed}, open(ROOT + 'index.json', 'w'), ensure_ascii=False)
    by_op = defaultdict(lambda: [0, 0])
    for k, s in stations.items():
        by_op[s['op']][0] += 1
        by_op[s['op']][1] += bool(s['points'])
    for op, (n, ok) in by_op.items():
        print(f'{op}: {ok}/{n} stations located')
    json.dump(sorted(missing), open(ROOT + 'unlocated.json', 'w'), ensure_ascii=False, indent=0)


if __name__ == '__main__':
    main()
