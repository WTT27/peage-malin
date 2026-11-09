"""Build app/data/chargers.json: public fast chargers usable by the e-208 (CCS, >= 50 kW, open access).

Source: data.gouv.fr "Base nationale des IRVE" (consolidated static CSV, schema v2.3.1), downloaded to
data/raw/irve/irve.csv (not committed, ~120 MB). Refresh: download the latest CSV and rerun this script.

Output (compact): {"note": ..., "brands": [...], "s": [[lat, lon, kW, points, brandIndex, price|null, name(, 0 = limited opening hours)], ...]}
price = €/kWh read from the operator's own "tarification" text when it is a plain per-kWh price, else null
(the app then uses its per-network estimate, or the user's default fast-charge price).
"""
import csv, json, re, sys
from collections import defaultdict

SRC = sys.argv[1] if len(sys.argv) > 1 else 'data/raw/irve/irve.csv'
OUT = 'app/data/chargers.json'


def power(v):
    try:
        p = float(v or 0)
    except ValueError:
        return 0
    return p / 1000 if p > 2000 else p          # a few rows are in W


def price_of(t):
    t = (t or '').strip()
    m = re.search(r'"energyPrice"\s*:\s*([0-9.]+)', t)
    if m:
        x = float(m.group(1))
    else:
        m = re.search(r'(\d+[.,]\d+)\s*€?\s*/?\s*kwh', t, re.I) or re.search(r'(\d+[.,]\d+)\s*€\s*/\s*kwh', t, re.I)
        c = re.search(r'(\d{2})\s*cts?\s*/?\s*kwh', t, re.I)
        if m:
            x = float(m.group(1).replace(',', '.'))
        elif c:
            x = int(c.group(1)) / 100
        else:
            return None
    return round(x, 2) if 0.15 <= x <= 1.2 else None


BRAND_FIX = [  # readable network names
    (r'tesla', 'Tesla'), (r'ionity', 'Ionity'), (r'totalenergies|total energies', 'TotalEnergies'), (r'electra', 'Electra'),
    (r'fastned', 'Fastned'), (r'izivia', 'Izivia'), (r'vianeo|engie', 'Engie Vianeo'), (r'power ?dot', 'Power Dot'),
    (r'^lidl', 'Lidl'), (r'carrefour', 'Carrefour'), (r'leclerc', 'E.Leclerc'), (r'intermarch', 'Intermarché'),
    (r'auchan', 'Auchan'), (r'allego', 'Allego'), (r'driveco', 'Driveco'), (r'e-totem', 'e-Totem'), (r'evzen', 'EVzen'),
    (r'atlante', 'Atlante'), (r'easy ?charge', 'Easy Charge'), (r'bp ?pulse', 'bp pulse'), (r'zunder', 'Zunder'),
    (r'freshmile', 'Freshmile'), (r'eborn', 'eborn'), (r'super ?u|syst[eè]me u|magasins u', 'Super U'),
]


def brand_of(row):
    raw = (row['nom_enseigne'] or row['nom_operateur'] or '').strip()
    for pat, name in BRAND_FIX:
        if re.search(pat, raw, re.I) or re.search(pat, row['nom_operateur'] or '', re.I):
            return name
    return raw[:30] or 'Autre'


sites = {}
for row in csv.DictReader(open(SRC, newline='', encoding='utf-8')):
    p = power(row['puissance_nominale'])
    if row['prise_type_combo_ccs'].lower() != 'true' or p < 50:
        continue
    if 'réservé' in (row['condition_acces'] or '').lower() or row['station_deux_roues'].lower() == 'true':
        continue
    try:
        lat, lon = float(row['consolidated_latitude']), float(row['consolidated_longitude'])
    except ValueError:
        continue
    if not (41 < lat < 51.5 and -5.5 < lon < 10):
        continue
    key = row['id_station_itinerance'] or f'{lat:.4f},{lon:.4f}'
    s = sites.get(key)
    if not s:
        s = sites[key] = {'lat': lat, 'lon': lon, 'kw': 0, 'pdc': set(), 'brand': brand_of(row), 'prices': [],
                          'name': (row['nom_station'] or '').strip()[:40], 'h247': True}
    h = (row['horaires'] or '').strip()
    if h and h not in ('24/7', 'Mo-Su 00:00-23:57', 'Mo-Su 00:00-00:00', 'Mo-Su 00:00-23:59'):
        s['h247'] = False
    s['kw'] = max(s['kw'], p)
    s['pdc'].add(row['id_pdc_itinerance'] or row['id_pdc_local'] or str(len(s['pdc'])))
    pr = price_of(row['tarification'])
    if pr:
        s['prices'].append(pr)

# merge sites of the same network closer than ~150 m (several station ids on one car park)
cells = defaultdict(list)
out = []
for s in sites.values():
    ck = (round(s['lat'] / 0.002), round(s['lon'] / 0.003))
    dup = next((t for t in cells[ck] if t['brand'] == s['brand']), None)
    if dup:
        dup['kw'] = max(dup['kw'], s['kw']); dup['pdc'] |= s['pdc']; dup['prices'] += s['prices']; dup['h247'] = dup['h247'] and s['h247']
        continue
    cells[ck].append(s)
    out.append(s)

brands = sorted({s['brand'] for s in out})
bi = {b: i for i, b in enumerate(brands)}
rows = []
for s in out:
    pr = min(s['prices']) if s['prices'] else None
    rows.append([round(s['lat'], 5), round(s['lon'], 5), int(min(s['kw'], 400)), len(s['pdc']), bi[s['brand']], pr, s['name']] + ([] if s['h247'] else [0]))
rows.sort()
date = re.search(r'(\d{8})', open(SRC, encoding='utf-8').name) or None
json.dump({'note': f'Bornes rapides IRVE data.gouv.fr ({len(rows)} sites CCS ≥ 50 kW)', 'brands': brands, 's': rows},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(rows), 'sites,', sum(1 for r in rows if r[5]), 'with a price;', len(brands), 'networks')
