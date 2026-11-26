#!/usr/bin/env python3
"""
build-seafloor-age.py — bakes data/seafloor/{age-index.json, <id>.age.bin.gz} for the trench sites.

    python3 scripts/build-seafloor-age.py            # bake (downloads the pinned grid once, ~8 MB)
    python3 scripts/build-seafloor-age.py --check    # rebuild in memory, fail if any byte differs

SOURCE: Seton, M., Müller, R. D., et al. (2020), "A global dataset of present-day oceanic crustal age and
seafloor spreading parameters", G-cubed, doi:10.1029/2020GC009214 — version 2020.1, the 6 arc-minute grid
on the GTS2012 timescale, CC BY 4.0, from EarthByte's public server (reachable since 2026-11-23). The file
is SHA-256 pinned: a different file is refused, never silently baked.

WHY: both published trench studies this page is checked against remove THERMAL SUBSIDENCE computed from
this kind of grid before fitting the bending plate (Garcia et al. 2019 with Parsons & Sclater 1977; Zhang
et al. 2018 with a half-space model). Without it the fit carries a free straight regional slope, and a very
stiff outer plate can trade against that slope (measured at Middle America, js/seafloor/broken-plate.js).
The ages are an INPUT to a subsidence reference; nothing here is a model.

OUTPUT
  <id>.age.bin.gz   int16 little-endian, age in units of 0.1 Myr, NO_DATA (-32768) where the grid has no
                    oceanic crust (continents, unmapped crust). Row 0 = NORTH, col 0 = WEST, 0.1 deg
                    gridline-registered nodes (the source's own nodes — nothing is interpolated here).
                    gzip mtime 0 so a re-bake is byte-stable.
  age-index.json    per site: the window geometry, plus the source, its sha256, the licence and citation.
"""
import argparse, gzip, hashlib, io, json, math, os, re, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'seafloor')
CACHE = os.path.join(ROOT, 'scripts', '.cache', 'seafloor-age')
URL = 'https://www.earthbyte.org/webdav/ftp/earthbyte/agegrid/2020/Grids/age.2020.1.GTS2012.6m.nc'
SHA256 = '3abeed4f6e9bfe9332ac6b5dff4c4f19c8a6374528a185f87e677db8152ba39e'
STEP = 0.1              # the source's own 6' spacing
HALF_LAT_DEG = 6.0      # one degree beyond the 5 deg wide bathymetry window, so a stacked section never runs off the edge
HALF_LON_CAP_DEG = 14.0
NO_DATA = -32768

def load_trench_sites():
    src = open(os.path.join(ROOT, 'js', 'seafloor', 'sites.js'), encoding='utf-8').read()
    out = []
    for m in re.finditer(r"\{ id: '([^']+)',\s*name: '([^']+)'.*?kind: '([^']+)',\s*lat: ([-\d.]+),\s*lon: ([-\d.]+)", src):
        if m.group(3) == 'trench': out.append(dict(id=m.group(1), lat=float(m.group(4)), lon=float(m.group(5))))
    return out

def fetch(path):
    if not os.path.exists(path):
        import requests
        os.makedirs(os.path.dirname(path), exist_ok=True)
        r = requests.get(URL, timeout=300); r.raise_for_status()
        open(path + '.part', 'wb').write(r.content); os.replace(path + '.part', path)
    h = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if h != SHA256: raise SystemExit(f'age grid sha256 {h} is not the pinned {SHA256}: refusing to bake')
    return path

def gz(raw):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g: g.write(raw)
    return buf.getvalue()

def bake(nc_path):
    import h5py
    f = h5py.File(nc_path, 'r')
    lat, lon, z = f['lat'][:], f['lon'][:], f['z'][:]          # lat ascending (south first), lon -180..180, z (lat, lon)
    if not (abs(lat[0] + 90) < 1e-9 and abs(lat[1] - lat[0] - STEP) < 1e-9 and abs(lon[0] + 180) < 1e-9 and abs(lon[1] - lon[0] - STEP) < 1e-9):
        raise SystemExit('unexpected grid geometry')
    nlon = len(lon) - 1                                          # +180 duplicates -180 (gridline-registered)
    files, sites = {}, []
    for s in load_trench_sites():
        half_lon = min(HALF_LAT_DEG / max(math.cos(math.radians(s['lat'])), 0.2), HALF_LON_CAP_DEG)
        north = round(math.ceil((s['lat'] + HALF_LAT_DEG) / STEP) * STEP, 6); south = round(math.floor((s['lat'] - HALF_LAT_DEG) / STEP) * STEP, 6)
        west = round(math.floor((s['lon'] - half_lon) / STEP) * STEP, 6); east = round(math.ceil((s['lon'] + half_lon) / STEP) * STEP, 6)
        ny, nx = int(round((north - south) / STEP)) + 1, int(round((east - west) / STEP)) + 1
        rows = np.array([int(round((north - j * STEP + 90) / STEP)) for j in range(ny)])
        cols = np.array([int(round((west + i * STEP + 180) / STEP)) % nlon for i in range(nx)])
        a = z[np.ix_(rows, cols)].astype(np.float64)
        q = np.where(np.isfinite(a), np.rint(a * 10), NO_DATA).astype('<i2')
        name = s['id'] + '.age.bin.gz'; files[name] = gz(q.tobytes())
        ocean = np.isfinite(a)
        sites.append(dict(id=s['id'], file=name, north=north, west=west, step_deg=STEP, nx=nx, ny=ny, bytes=len(files[name]),
                          ocean_fraction=round(float(ocean.mean()), 4), age_min_ma=round(float(np.nanmin(a)), 1), age_max_ma=round(float(np.nanmax(a)), 1)))
    index = dict(source=dict(url=URL, sha256=SHA256, version='2020.1 GTS2012 6m',
                             citation='Seton et al. (2020), G-cubed, doi:10.1029/2020GC009214', licence='CC BY 4.0'),
                 encoding='int16le gzip, 0.1 Myr units, row 0 north, col 0 west, gridline nodes', no_data=NO_DATA, sites=sites)
    files['age-index.json'] = (json.dumps(index, indent=1) + '\n').encode()
    return files

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--check', action='store_true'); ap.add_argument('--grid', default=os.path.join(CACHE, 'age.2020.1.GTS2012.6m.nc'))
    a = ap.parse_args()
    files = bake(fetch(a.grid))
    if a.check:
        bad = [n for n, b in files.items() if not os.path.exists(os.path.join(OUT, n)) or open(os.path.join(OUT, n), 'rb').read() != b]
        if bad: raise SystemExit('stale: ' + ', '.join(bad))
        print(f'age grids up to date ({len(files) - 1} sites)'); return
    for n, b in files.items(): open(os.path.join(OUT, n), 'wb').write(b)
    print(f'wrote {len(files) - 1} age windows + age-index.json')

if __name__ == '__main__':
    main()
