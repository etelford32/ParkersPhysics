#!/usr/bin/env python3
"""
build-paleo-merdith.py — bake the SECOND plate model, Merdith et al. (2021),
for the browser, in the same shapes as the Müller et al. (2019) bake.

    python3 scripts/build-paleo-merdith.py [--zip PATH] [--check]

Source: Merdith, A. S., et al. (2021), Extending full-plate tectonic models
into deep time: linking the Neoproterozoic and the Phanerozoic, Earth-Science
Reviews 214, doi:10.1016/j.earscirev.2020.103477 — supplementary model SM2,
v1.2.4 (Dec 2023 corrections), from EarthByte's own server (URL + sha256
pinned below). Licence: Creative Commons Attribution 4.0 — the License.txt at
the root of EarthByte's Data_Collections directory, which holds this archive
(its sha256 is pinned too). So the baked merdith2021-* files are CC BY 4.0.

WHY A SECOND MODEL (DEEP_TIME_EARTH_PLAN.md rules 2 and 3): one model is one
answer. Merdith 2021 is set in a PALAEOMAGNETIC reference frame (Africa on a
global apparent-polar-wander path after Tetley 2018; the archive's APWP.txt),
where Müller 2019 is in an optimised MANTLE frame — so the two differ by the
frame (true polar wander) as well as by their relative motions. They are NOT
independent: for 250–0 Ma Merdith compiles Young et al. 2019, which descends
from the same EarthByte lineage as Müller 2019. Their disagreement is a LOWER
bound on the uncertainty, never an error bar.

Palaeomagnetism does not fix LONGITUDE: a palaeomagnetic frame's longitudes
are a convention of the model. Consumers must compare LATITUDE first.

What is written (stdlib only, deterministic; --check rebuilds and compares):
  data/paleo/merdith2021-rotations.json   rotation sequences, rows to 250 Ma
                                          (+ the first row past it), as written
  data/paleo/merdith2021-plates.json      static polygons + continent outlines,
                                          the muller2019-plates.json format
  data/paleo/merdith2021-coastlines.json  today's coastlines (the model's own),
                                          the muller2019-coastlines.json format
GPML positions are LAT LON order; no ring in this archive crosses the
antimeridian (checked at bake time — the baker refuses one that does, since
the browser's lon/lat ray cast and triangulation would break on it).
"""
import argparse, gzip, hashlib, importlib.util, io, json, os, re, sys, urllib.request, zipfile

URL = ('https://www.earthbyte.org/webdav/ftp/Data_Collections/Merdith_etal_2021_ESR/'
       'SM2-Merdith_et_al_1_Ga_reconstruction_v1.2.4.zip')
SHA256 = 'ea247ec5f8975fb7e6034c8ec48704b11805fc6f520ee7526c5757b830386982'
LICENCE_URL = 'https://www.earthbyte.org/webdav/ftp/Data_Collections/License.txt'
P = 'SM2-Merdith_et_al_1_Ga_reconstruction_v1.2.4/'
ROT = P + '1000_0_rotfile_Merdith_et_al.rot'
STATIC = P + 'shapes_static_polygons_Merdith_et_al.gpml'
CONT = P + 'shapes_continents.gpml'
COAST = P + 'shapes_coastlines_Merdith_et_al_v2.gpmlz'
AGE_CAP = 250.0                          # the page's range; the same as Müller 2019's
DISTANT_PAST = 4600.0                    # 'http://gplates.org/times/distantPast'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'paleo')

_spec = importlib.util.spec_from_file_location('m19', os.path.join(ROOT, 'scripts', 'build-paleo-model.py'))
M19 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M19)


def fetch(path):
    data = open(path, 'rb').read() if path else urllib.request.urlopen(URL, timeout=300).read()
    got = hashlib.sha256(data).hexdigest()
    if got != SHA256:
        sys.exit(f'sha256 mismatch: {got} (pinned {SHA256}) — the archive changed; review before re-pinning')
    return zipfile.ZipFile(io.BytesIO(data))


def time_value(s):
    s = s.strip()
    if s.endswith('distantPast'):
        return DISTANT_PAST
    if s.endswith('distantFuture'):
        return -999.0
    return float(s)


def features(text):
    """Each GPML feature → (plate, begin, end, name, [rings as [(lon, lat)]])."""
    out = []
    for f in text.split('<gml:featureMember>')[1:]:
        m = re.search(r'<gpml:reconstructionPlateId>.*?<gpml:value>\s*(-?\d+)\s*</gpml:value>', f, re.S)
        if not m:
            continue
        times = re.search(r'<gml:validTime>.*?<gml:begin>.*?<gml:timePosition[^>]*>([^<]*)<.*?<gml:end>.*?<gml:timePosition[^>]*>([^<]*)<', f, re.S)
        begin, end = (time_value(times.group(1)), time_value(times.group(2))) if times else (DISTANT_PAST, -999.0)
        nm = re.search(r'<gml:name>([^<]*)</gml:name>', f)
        rings = []
        for pl in re.findall(r'<gml:posList[^>]*>([^<]*)</gml:posList>', f):
            v = [float(x) for x in pl.split()]
            ring = [(v[i + 1], v[i]) for i in range(0, len(v) - 1, 2)]          # GPML is lat lon
            if any(abs(ring[i][0] - ring[i - 1][0]) > 180 for i in range(1, len(ring))):
                sys.exit(f'a ring of plate {m.group(1)} crosses the antimeridian — the browser cannot draw it unsplit')
            rings.append(ring)
        out.append((int(m.group(1)), begin, end, (nm.group(1) if nm else '').strip(), rings))
    return out


def polygon_block(feats, tol):
    names, index, polys, vin, vout = [], {}, [], 0, 0
    for plate, begin, end, nm, rings in feats:
        if nm not in index:
            index[nm] = len(names)
            names.append(nm)
        rs = []
        for ring in rings:
            if ring and ring[0] != ring[-1]:
                ring = ring + [ring[0]]                                       # the shapefile convention: closed
            vin += len(ring)
            d = M19.delta_ring(ring, tol)
            if len(d) >= 8:
                rs.append(d)
                vout += len(d) // 2
        if rs:
            polys.append([plate, begin, end, index[nm], rs])
    return {'names': names, 'polygons': polys, 'verticesIn': vin, 'verticesOut': vout}


def coast_lines(feats, tol):
    out = []
    for plate, begin, end, nm, rings in feats:
        for ring in rings:
            s = M19.simplify(ring, tol)
            if len(s) >= 2:
                out.append([plate, begin, [[round(x, 2), round(y, 2)] for x, y in s]])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    z = fetch(a.zip)
    rot = M19.parse_rotations(z.read(ROT).decode('latin-1'), max_age=AGE_CAP)
    static = features(z.read(STATIC).decode('utf-8'))
    cont = features(z.read(CONT).decode('utf-8'))
    coast = features(gzip.decompress(z.read(COAST)).decode('utf-8'))
    meta = {'model': 'Merdith et al. 2021 (Earth-Science Reviews 214, doi:10.1016/j.earscirev.2020.103477), SM2 v1.2.4',
            'licence': 'CC BY 4.0', 'licenceStatement': LICENCE_URL, 'url': URL, 'sha256': SHA256,
            'frame': 'palaeomagnetic (Africa on a global APWP after Tetley 2018); longitude is a model convention',
            'lineage': '250-0 Ma compiled from Young et al. 2019 (EarthByte lineage, shared with Muller 2019): not independent'}
    files = {
        'merdith2021-rotations.json': {'meta': {**meta, 'file': ROT.split('/')[-1], 'sequences': len(rot), 'ageCapMa': AGE_CAP,
                                                'convention': '[moving, fixed, [[age Ma, pole lat, pole lon, angle deg]]]; total reconstruction poles, anchor plate 0'},
                                       'sequences': rot},
        'merdith2021-plates.json': {'meta': {**meta, 'files': [STATIC.split('/')[-1], CONT.split('/')[-1]], 'toleranceDeg': M19.POLY_TOL_DEG,
                                             'convention': 'as muller2019-plates.json',
                                             'note': 'present-day geometry; continents are continental CRUST outlines, not palaeo-shorelines'},
                                    'static': polygon_block(static, M19.POLY_TOL_DEG), 'continents': polygon_block(cont, M19.POLY_TOL_DEG)},
        'merdith2021-coastlines.json': {'meta': {**meta, 'file': COAST.split('/')[-1], 'toleranceDeg': M19.COAST_TOL_DEG,
                                                 'note': 'present-day coastlines with plate ids; NOT palaeo-shorelines'},
                                        'lines': coast_lines(coast, M19.COAST_TOL_DEG)},
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
        print('merdith bake: up to date')


if __name__ == '__main__':
    main()
