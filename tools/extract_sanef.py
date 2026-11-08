"""Extract class-1 triangular toll grids from Sanef / SAPN PDFs (page 2 = class 1).

Output JSON: {"operator", "valid_from", "source", "sections": [{"title", "stations": [...],
"pairs": [[i, j, price], ...]}], "fixed": [{"station", "price", "note"}]}
"""
import json, re, sys, statistics
import pdfplumber

NUM = re.compile(r'^\d{1,3},\d{1,2}$')


def lines_of(page):
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    rows = []
    for w in sorted(words, key=lambda w: (round(w['top']), w['x0'])):
        if rows and abs(rows[-1][0] - w['top']) < 3:
            rows[-1][1].append(w)
        else:
            rows.append([w['top'], [w]])
    return [(top, sorted(ws, key=lambda w: w['x0'])) for top, ws in rows]


def split_label(words):
    """Split non-numeric words into groups separated by large gaps."""
    groups = []
    for w in words:
        if groups and w['x0'] - groups[-1][-1]['x1'] < 12:
            groups[-1].append(w)
        else:
            groups.append([w])
    return [(' '.join(x['text'] for x in g), g[0]['x0']) for g in groups]


def parse(path, operator, valid_from):
    with pdfplumber.open(path) as pdf:
        page = pdf.pages[1]
        lines = lines_of(page)
    sections, fixed, cur = [], [], None
    for top, ws in lines:
        if top < 90:
            continue
        hdr = [k for k, w in enumerate(ws) if re.match(r'^AUTOROUTES?$', w['text']) and k > 0]
        if hdr:
            title = ' '.join(w['text'] for w in ws[hdr[0]:])
            ws = ws[:hdr[0]]
            cur = {'title': title, 'stations': [], 'rows': []}
            sections.append(cur)
        nums = [w for w in ws if NUM.match(w['text'])]
        texts = [w for w in ws if not NUM.match(w['text'])]
        joined = ' '.join(w['text'] for w in ws)
        if re.match(r'^AUTOROUTES? ', joined) or 'CCI SEINE' in joined:
            cur = {'title': joined, 'stations': [], 'rows': []}
            sections.append(cur)
            continue
        if cur is None or not texts:
            continue
        labels = split_label(texts)
        # fixed-price lines: "NAME price  NAME price ..." (name before number)
        if nums and texts and texts[0]['x0'] < nums[0]['x0']:
            k = 0
            for lab, x in labels:
                after = [n for n in nums if n['x0'] > x]
                if after and not lab.startswith('TARIF') and not lab.startswith('Le tarif'):
                    fixed.append({'station': lab, 'price': float(after[0]['text'].replace(',', '.')),
                                  'section': cur['title']})
            continue
        if cur['title'].startswith('AUTOROUTE A14') or 'CCI' in cur['title']:
            continue
        name, nx = labels[0]
        if name.startswith('(') and cur['stations'] and not nums:
            cur['stations'][-1] += ' ' + name   # continuation line
            continue
        if re.match(r'^A\d+[A-Z]*( (NORD|SUD))?$', name):
            continue
        cur['stations'].append(name)
        cur['rows'].append([(n['x0'], float(n['text'].replace(',', '.'))) for n in nums])
    out = []
    for s in sections:
        xs = sorted({round(x, 0) for r in s['rows'] for x, _ in r})
        if not xs:
            continue
        diffs = [round(b[0] - a[0], 1) for r in s['rows'] for a, b in zip(r, r[1:])]
        pitch = statistics.mode(diffs) if diffs else 20
        x0 = xs[0]
        pairs = []
        for i, r in enumerate(s['rows']):
            for x, price in r:
                j = round((x - x0) / pitch)
                if not 0 <= j < i:
                    raise ValueError(f"{s['title']}: row {i} {s['stations'][i]} bad column {j} (x={x}, pitch={pitch})")
                pairs.append([j, i, price])
        out.append({'title': s['title'], 'stations': s['stations'], 'pairs': pairs, 'pitch': round(pitch, 2)})
    return {'operator': operator, 'valid_from': valid_from, 'class': 1, 'source': path.split('/')[-1],
            'sections': out, 'fixed': fixed}


if __name__ == '__main__':
    path, operator, valid_from, dest = sys.argv[1:5]
    d = parse(path, operator, valid_from)
    json.dump(d, open(dest, 'w'), ensure_ascii=False, indent=1)
    for s in d['sections']:
        print(f"{s['title']}: {len(s['stations'])} stations, {len(s['pairs'])} prices, pitch {s['pitch']}")
    for f in d['fixed']:
        print('fixed:', f['station'], f['price'])
