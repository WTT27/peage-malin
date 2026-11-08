"""Export a compact toll data file for the phone app (app/data/tolls.json)."""
import json

idx = json.load(open('data/tolls/index.json'))
duplex = json.load(open('data/tolls/duplex_a86.json'))
keys = [k for k, s in idx['stations'].items() if s['points']]
pos = {k: i for i, k in enumerate(keys)}
stations = [[idx['stations'][k]['op'], idx['stations'][k]['name'],
             [[round(a, 5), round(b, 5)] for a, b in idx['stations'][k]['points']]] for k in keys]
prices = {}
for op, tab in idx['prices'].items():
    out = {}
    for pair, p in tab.items():
        a, b = pair.split('|')
        ka, kb = f'{op}|{a}', f'{op}|{b}'
        if ka in pos and kb in pos:
            out[f'{pos[ka]}|{pos[kb]}'] = p
    prices[op] = out
fixed = [[f['op'], f['name'], f['price'], f['points']] for f in idx.get('fixed', {}).values() if f['points']]
data = {'version': '2026-11-08', 'note': 'Class 1 prices: SAPN/Sanef/APRR/AREA/Cofiroute 1 Feb 2026, Vinci 1 Jun 2026',
        'stations': stations, 'prices': prices, 'fixed': fixed, 'duplex': duplex}
json.dump(data, open('app/data/tolls.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(stations), 'stations', sum(len(v) for v in prices.values()), 'prices')
