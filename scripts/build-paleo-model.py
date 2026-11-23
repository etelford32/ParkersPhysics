#!/usr/bin/env python3
"""
build-paleo-model.py — bake the Müller et al. (2019) plate model for the browser.

    python3 scripts/build-paleo-model.py [--zip PATH] [--check]

Source: Müller, R. D., et al. (2019), A global plate model including
lithospheric deformation along major rifts and orogens since the Triassic,
Tectonics 38, doi:10.1029/2018TC005462 — plate model v2.0 "Updated" (v2.02),
from EarthByte's own server (URL + sha256 pinned below). Licence: CC BY-SA 4.0
(stated in the archive's _README.txt) — so the baked files in data/paleo/ are
CC BY-SA 4.0 too, and data/paleo/SOURCES.md says so.

What is written (stdlib only, deterministic; --check rebuilds and compares):
  data/paleo/muller2019-rotations.json
      every rotation sequence of Global_250-0Ma_Rotations_2019_v2.rot as
      [moving, fixed, [[age, poleLat, poleLon, angle], ...]], in file order
      (plate 999 rows are the file's metadata comments and are dropped).
      Values are copied as written — no rounding.
  data/paleo/muller2019-sites.json
      the plate each named site sits on, from the model's own present-day
      static plate polygons (point-in-polygon on the polygon's lon/lat
      rings). Where polygons overlap (they do, in the Caribbean) every hit is
      kept and the chosen one is the SMALLEST polygon (the more specific
      terrane), and the file says so.
  data/paleo/muller2019-coastlines.json
      present-day coastlines cut by the static polygons, each with its plate
      id and appearance age, simplified to COAST_TOL_DEG (Douglas–Peucker on
      lon/lat) and quantised to 0.01°. These are TODAY's shorelines carried
      back in time — NOT the shoreline of the age they are drawn at.
"""
import argparse, hashlib, io, json, math, os, struct, sys, urllib.request, zipfile

URL = ('https://www.earthbyte.org/webdav/ftp/Data_Collections/Muller_etal_2019_Tectonics/'
       'Muller_etal_2019_PlateMotionModel/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics_Updated.zip')
SHA256 = '8976f140f3be194d2e3e1286eedcc7bed0a718663d8e2580af97674b77972483'
P = 'Muller_etal_2019_PlateMotionModel_v2.0_Tectonics_Updated/'
ROT = P + 'Global_250-0Ma_Rotations_2019_v2.rot'
STATIC = P + 'StaticGeometries/StaticPolygons/Global_EarthByte_GPlates_PresentDay_StaticPlatePolygons_2019_v1'
COAST = P + 'StaticGeometries/Coastlines/Global_coastlines_2019_v1_low_res'
COAST_TOL_DEG = 0.15
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'paleo')

# Sites the Chicxulub reconstruction needs (present coordinates, deg; same
# numbers as js/chicxulub/observations.js — the gate cross-checks them).
SITES = {
    'chicxulub':  (21 + 20 / 60, -(89 + 30 / 60)),   # N 21°20′ W 89°30′, as the evidence table
    'el-mimbral': (23.2, -98.7),
    'raton':      (37.0, -104.5),
    'beloc':      (18.4, -72.6),
    'tanis':      (46.0, -103.4),
}


def fetch(path):
    if path:
        data = open(path, 'rb').read()
    else:
        with urllib.request.urlopen(URL, timeout=300) as r:
            data = r.read()
    got = hashlib.sha256(data).hexdigest()
    if got != SHA256:
        sys.exit(f'sha256 mismatch: {got} (pinned {SHA256}) — the archive changed; review before re-pinning')
    return zipfile.ZipFile(io.BytesIO(data))


def read_dbf(b):
    n, hl, rl = struct.unpack('<xxxxIHH', b[:12])
    fields, o = [], 32
    while b[o] != 0x0D:
        fields.append((b[o:o + 11].split(b'\0')[0].decode(), b[o + 16]))
        o += 32
    out = []
    for i in range(n):
        rec, d, p = b[hl + i * rl + 1: hl + (i + 1) * rl], {}, 0
        for name, ln in fields:
            d[name] = rec[p:p + ln].decode('latin-1').strip()
            p += ln
        out.append(d)
    return out


def read_shp(b):
    """Polygon (5) / PolyLine (3) records → list of rings/parts [(lon, lat), ...]."""
    o, out = 100, []
    while o < len(b):
        _, clen = struct.unpack('>ii', b[o:o + 8])
        rec = b[o + 8:o + 8 + clen * 2]
        o += 8 + clen * 2
        if struct.unpack('<i', rec[:4])[0] == 0:
            out.append([])
            continue
        nparts, npts = struct.unpack('<ii', rec[36:44])
        parts = struct.unpack('<%di' % nparts, rec[44:44 + 4 * nparts])
        xy = struct.unpack('<%dd' % (2 * npts), rec[44 + 4 * nparts:44 + 4 * nparts + 16 * npts])
        pts = [(xy[2 * k], xy[2 * k + 1]) for k in range(npts)]
        out.append([pts[parts[k]:(parts[k + 1] if k + 1 < nparts else npts)] for k in range(nparts)])
    return out


def inside(lon, lat, ring):
    c = False
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            c = not c
    return c


def ring_area(ring):
    return abs(sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1]
                   for i in range(len(ring)))) / 2


def num(s, default=None):
    try:
        return float(s)
    except ValueError:
        return default


def rotations(z):
    seqs, index = [], {}
    for line in z.read(ROT).decode('latin-1').splitlines():
        s = line.split('!')[0].split()
        if len(s) < 6:
            continue
        moving, age, lat, lon, ang, fixed = int(s[0]), float(s[1]), float(s[2]), float(s[3]), float(s[4]), int(s[5])
        if moving == 999:
            continue
        # a sequence is a run of consecutive rows with the same moving + fixed plate
        if seqs and seqs[-1][0] == moving and seqs[-1][1] == fixed:
            seqs[-1][2].append([age, lat, lon, ang])
        else:
            seqs.append([moving, fixed, [[age, lat, lon, ang]]])
    return seqs


def sites(z):
    recs, geo = read_dbf(z.read(STATIC + '.dbf')), read_shp(z.read(STATIC + '.shp'))
    out = {}
    for key, (lat, lon) in SITES.items():
        hits = []
        for i, rings in enumerate(geo):
            if sum(inside(lon, lat, r) for r in rings) % 2 == 1:
                r = recs[i]
                hits.append({'plate': int(float(r['PLATEID1'])), 'name': r['NAME'],
                             'fromAge': num(r['FROMAGE']), 'toAge': num(r['TOAGE']),
                             'areaDeg2': round(sum(ring_area(x) for x in rings), 3)})
        if not hits:
            sys.exit(f'site {key} is in no static polygon')
        hits.sort(key=lambda h: h['areaDeg2'])
        out[key] = {'lat': lat, 'lon': lon, 'plate': hits[0]['plate'], 'name': hits[0]['name'],
                    'rule': 'smallest polygon' if len(hits) > 1 else 'only polygon', 'hits': hits}
    return out


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            x, y = pts[i]
            d = abs(dy * (x - x1) - dx * (y - y1)) / L if L > 0 else math.hypot(x - x1, y - y1)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def coastlines(z):
    recs, geo = read_dbf(z.read(COAST + '.dbf')), read_shp(z.read(COAST + '.shp'))
    out, vin, vout = [], 0, 0
    for r, parts in zip(recs, geo):
        plate = int(float(r['PLATEID1']))
        from_age = num(r.get('FROMAGE', ''), 600.0)
        for part in parts:
            vin += len(part)
            s = simplify(part, COAST_TOL_DEG)
            if len(s) < 2:
                continue
            q = [[round(x, 2), round(y, 2)] for x, y in s]
            vout += len(q)
            out.append([plate, from_age, q])
    return out, vin, vout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    z = fetch(a.zip)
    rot = rotations(z)
    coast, vin, vout = coastlines(z)
    meta = {'model': 'Müller et al. 2019 v2.0 (Tectonics 38, doi:10.1029/2018TC005462), archive v2.02',
            'licence': 'CC BY-SA 4.0', 'url': URL, 'sha256': SHA256}
    files = {
        'muller2019-rotations.json': {'meta': {**meta, 'file': ROT.split('/')[-1], 'sequences': len(rot),
                                               'convention': '[moving, fixed, [[age Ma, pole lat, pole lon, angle deg]]]; total reconstruction poles, anchor plate 0'},
                                      'sequences': rot},
        'muller2019-sites.json': {'meta': {**meta, 'file': STATIC.split('/')[-1] + '.shp'}, 'sites': sites(z)},
        'muller2019-coastlines.json': {'meta': {**meta, 'file': COAST.split('/')[-1] + '.shp',
                                                'toleranceDeg': COAST_TOL_DEG, 'verticesIn': vin, 'verticesOut': vout,
                                                'note': 'present-day coastlines cut by the static polygons; NOT palaeo-shorelines'},
                                       'lines': coast},
    }
    os.makedirs(OUT, exist_ok=True)
    bad = []
    for name, obj in files.items():
        text = json.dumps(obj, separators=(',', ':'), ensure_ascii=False) + '\n'
        path = os.path.join(OUT, name)
        if a.check:
            if not os.path.exists(path) or open(path, encoding='utf-8').read() != text:
                bad.append(name)
        else:
            open(path, 'w', encoding='utf-8').write(text)
            print(f'{name}: {len(text) / 1024:.0f} KB')
    if a.check:
        if bad:
            sys.exit('stale: ' + ', '.join(bad))
        print('paleo bake: up to date')


if __name__ == '__main__':
    main()
