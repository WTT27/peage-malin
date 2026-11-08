"""Extract class-1 prices from Vinci 'Guide tarifaire' list PDFs (Cofiroute, Escota, Arcos...).
Line format: ENTRY_ROAD  N°  ENTRY_NAME  EXIT_ROAD  N°  EXIT_NAME  C1 €  C2 € ...
"""
import json, re, subprocess, sys

ROW = re.compile(r'^\s*(A\d+[A-Z]?)\s+(\S+)\s+(\S.*?)\s{2,}(A\d+[A-Z]?)\s+(\S+)\s+(\S.*?)\s{2,}(\d[\d ]*,\d\d)\s*€')


def parse(path, operator, valid_from):
    txt = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout
    pairs, stations, bad = {}, {}, []
    for line in txt.splitlines():
        m = ROW.match(line)
        if not m:
            if '€' in line and re.search(r'\d,\d\d\s*€', line) and re.match(r'^\s*A\d', line):
                bad.append(line.strip())
            continue
        r1, n1, g1, r2, n2, g2, c1 = m.groups()
        stations[g1.strip()] = {'road': r1, 'exit': n1}
        stations[g2.strip()] = {'road': r2, 'exit': n2}
        pairs[f'{g1.strip()}|{g2.strip()}'] = float(c1.replace(' ', '').replace(',', '.'))
    return {'operator': operator, 'valid_from': valid_from, 'class': 1, 'source': path.split('/')[-1],
            'stations': stations, 'pairs': pairs, 'unparsed': bad}


if __name__ == '__main__':
    path, op, vf, dest = sys.argv[1:5]
    d = parse(path, op, vf)
    json.dump(d, open(dest, 'w'), ensure_ascii=False, indent=0)
    print(f"{op}: {len(d['stations'])} stations, {len(d['pairs'])} pairs, {len(d['unparsed'])} unparsed")
    for l in d['unparsed'][:5]:
        print('  ?', l[:150])
