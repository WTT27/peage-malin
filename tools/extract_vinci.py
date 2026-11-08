"""Extract class-1 triangular toll grids from the Vinci Autoroutes PDF.

Layout: each network is a staircase triangle. Row r (0-based) holds the prices between
station r+1 and stations 0..r. Station labels are written at 45 degrees along the diagonal:
label k starts just right of cell (row k-1, col k-1).
Cells contain a price ("12,9"), "0" (free) or "." (no price / not possible).
Rectangular cross-network tables are detected and skipped for now.

Output JSON: {"operator","valid_from","class","source","sections":[{"page","stations",
"pairs":[[i,j,price],...]}], "skipped":[...]}
"""
import json, re, sys, statistics
from collections import defaultdict
import pdfplumber

CELL = re.compile(r'^(\d{1,3}(,\d{1,2})?|\.)$')


def cell_words(page):
    chars = [c for c in page.chars if c['matrix'][1] == 0 and 'Univers' in c['fontname']
             and 4.5 <= c['size'] <= 5.5]
    rows = defaultdict(list)
    for c in chars:
        rows[round(c['top'] * 2) / 2].append(c)
    words = []
    for top, cs in rows.items():
        cs.sort(key=lambda c: c['x0'])
        cur = []
        for c in cs:
            if cur and c['x0'] - cur[-1]['x1'] > 0.6:
                words.append(cur); cur = []
            cur.append(c)
        if cur:
            words.append(cur)
    out = []
    for w in words:
        t = ''.join(c['text'] for c in w).strip()
        if not t:
            continue
        out.append({'text': t, 'x': (w[0]['x0'] + w[-1]['x1']) / 2,
                    'y': (min(c['top'] for c in w) + max(c['bottom'] for c in w)) / 2})
    return out


def components(cells, link):
    parent = list(range(len(cells)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    grid = defaultdict(list)
    for i, c in enumerate(cells):
        grid[(int(c['x'] // link), int(c['y'] // link))].append(i)
    for i, c in enumerate(cells):
        gx, gy = int(c['x'] // link), int(c['y'] // link)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid[(gx + dx, gy + dy)]:
                    if j > i and abs(cells[j]['x'] - c['x']) < link and abs(cells[j]['y'] - c['y']) < link:
                        parent[find(i)] = find(j)
    comps = defaultdict(list)
    for i in range(len(cells)):
        comps[find(i)].append(cells[i])
    return list(comps.values())


def label_lines(page):
    rot = [c for c in page.chars if abs(c['matrix'][1]) > 0.5 and c['fontname'].split('+')[-1].startswith('FuturaStd')
           and 0 <= c['x0'] and c['x1'] <= page.width and 0 <= c['top'] and c['bottom'] <= page.height]
    H = page.height
    pts = []
    for c in rot:
        x, y = c['matrix'][4], H - c['matrix'][5]
        pts.append((x + y, x, y, c['text']))
    pts.sort()
    bands = []
    for s, x, y, t in pts:
        if bands and s - bands[-1]['s_last'] <= 1.5:
            bands[-1]['chars'].append((x, y, t)); bands[-1]['s_last'] = s
        else:
            bands.append({'s_last': s, 'chars': [(x, y, t)]})
    lines = []
    for b in bands:   # split a diagonal band into separate labels where chars are far apart
        cur = None
        for x, y, t in sorted(b['chars']):
            if cur and x - cur['chars'][-1][0] < 8:
                cur['chars'].append((x, y, t))
            else:
                cur = {'chars': [(x, y, t)]}; lines.append(cur)
    for l in lines:
        l['chars'].sort()
        l['x'], l['y'] = l['chars'][0][0], l['chars'][0][1]
        l['text'] = ''.join(t for _, _, t in l['chars']).strip()
        l['s'] = l['x'] + l['y']
    return lines


def parse_triangle(comp, lines, page_no):
    ys = sorted({round(c['y'], 0) for c in comp})
    rows = []
    for c in sorted(comp, key=lambda c: c['y']):
        if rows and abs(rows[-1][0] - c['y']) < 2:
            rows[-1][1].append(c)
        else:
            rows.append([c['y'], [c]])
    rows = [(y, sorted(cs, key=lambda c: c['x'])) for y, cs in rows]
    lens = [len(cs) for _, cs in rows]
    if lens != list(range(1, len(rows) + 1)):
        return None, f'page {page_no}: not a triangle (row lengths {lens[:8]}...)'
    p = statistics.median([b[0] - a[0] for a, b in zip(rows, rows[1:])])
    xa = statistics.median([cs[0]['x'] for _, cs in rows])
    ya = rows[0][0]
    n = len(rows) + 1
    # calibrate label offset: label k starts at (xa + k*p + dx, ya + (k-1)*p + dy)
    cands = [l for l in lines if xa - 3 * p < l['x'] < xa + (n + 2) * p and ya - 4 * p < l['y'] < ya + n * p]
    tol = 0.6 * p

    def match(l, dx, dy):
        k = round((l['x'] - xa - dx) / p)
        if 0 <= k < n and abs(l['x'] - (xa + k * p + dx)) < tol and abs(l['y'] - (ya + (k - 1) * p + dy)) < tol:
            return k
        return None
    best = None
    steps = [i * p / 10 for i in range(-10, 11)]
    for dx in steps:
        for dy in steps:
            hits = {}
            for l in cands:
                k = match(l, dx, dy)
                if k is not None:
                    hits.setdefault(k, 0); hits[k] += 1
            score = len(hits)
            if best is None or score > best[0]:
                best = (score, dx, dy)
    _, dx, dy = best
    names = defaultdict(list)
    for l in cands:
        k = match(l, dx, dy)
        if k is not None:
            names[k].append(l)
    stations = []
    for k in range(n):
        ls = sorted(names.get(k, []), key=lambda l: l['s'])
        stations.append(' '.join(l['text'] for l in ls) if ls else f'?{k}')
    pairs = []
    for r, (_, cs) in enumerate(rows):
        for c, cell in enumerate(cs):
            if cell['text'] == '.':
                continue
            pairs.append([c, r + 1, float(cell['text'].replace(',', '.'))])
    return {'page': page_no, 'stations': stations, 'pairs': pairs, 'pitch': round(p, 2)}, None


def parse(path, valid_from):
    sections, skipped = [], []
    with pdfplumber.open(path) as pdf:
        for pn, page in enumerate(pdf.pages, 1):
            cells = [w for w in cell_words(page) if CELL.match(w['text'])]
            lines = label_lines(page)
            for comp in components(cells, 14):
                if len(comp) < 3:
                    continue
                sec, err = parse_triangle(comp, lines, pn)
                if sec:
                    sections.append(sec)
                else:
                    skipped.append(err + f' ({len(comp)} cells)')
    return {'operator': 'VINCI', 'valid_from': valid_from, 'class': 1,
            'source': path.split('/')[-1], 'sections': sections, 'skipped': skipped}


if __name__ == '__main__':
    path, valid_from, dest = sys.argv[1:4]
    d = parse(path, valid_from)
    json.dump(d, open(dest, 'w'), ensure_ascii=False, indent=1)
    for s in d['sections']:
        unk = sum(1 for x in s['stations'] if x.startswith('?'))
        print(f"page {s['page']}: {len(s['stations'])} stations ({unk} unnamed), {len(s['pairs'])} prices: "
              f"{s['stations'][0][:30]} ... {s['stations'][-1][:30]}")
    for k in d['skipped']:
        print('skipped:', k)
