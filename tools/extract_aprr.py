"""Extract APRR / AREA class-1 prices from the official list-style PDFs (voyage.aprr.fr)."""
import json, re, subprocess, sys

ROW = re.compile(r'^\s*(?:\d{3,5}\s{2,})?(\S.*?)\s{2,}(?:\d{3,5}\s{2,})?(\S.*?)\s{2,}(\d[\d ]*,\d+)\s+(\d[\d ]*,\d+)\s*€')


def parse(path, operator, valid_from):
    txt = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout
    prices, bad = {}, 0
    for line in txt.splitlines():
        m = ROW.match(line)
        if not m:
            if '€' in line:
                bad += 1
            continue
        a, b, km, c1 = m.group(1).strip(), m.group(2).strip(), m.group(3), m.group(4)
        prices[f'{a}|{b}'] = [float(km.replace(' ', '').replace(',', '.')), float(c1.replace(' ', '').replace(',', '.'))]
    stations = sorted({k.split('|')[0] for k in prices} | {k.split('|')[1] for k in prices})
    return {'operator': operator, 'valid_from': valid_from, 'class': 1, 'source': path.split('/')[-1],
            'stations': stations, 'pairs': prices, 'unparsed_lines': bad}


if __name__ == '__main__':
    path, op, vf, dest = sys.argv[1:5]
    d = parse(path, op, vf)
    json.dump(d, open(dest, 'w'), ensure_ascii=False, indent=0)
    print(f"{op}: {len(d['stations'])} stations, {len(d['pairs'])} pairs, {d['unparsed_lines']} unparsed lines with €")
