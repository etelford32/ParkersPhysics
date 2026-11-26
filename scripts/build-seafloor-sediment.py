#!/usr/bin/env python3
"""
build-seafloor-sediment.py — bakes data/seafloor/{sediment-index.json, <id>.sed.bin.gz} for the trench sites.

    python3 scripts/build-seafloor-sediment.py            # bake (downloads the pinned grid once, ~11 MB)
    python3 scripts/build-seafloor-sediment.py --check    # rebuild in memory, fail if any byte differs

SOURCE: GlobSed, the global total-sediment-thickness grid of Straume, E. O., Gaina, C., Medvedev, S., et al.
(2019), "GlobSed: Updated total sediment thickness in the world's oceans", G-cubed, doi:10.1029/2018GC008115,
distributed by NOAA NCEI as `GlobSed-v3.nc` (5 arc-minutes, metres). NOAA's hosts are egress-blocked at build
time, so the file is read from a COPY committed (Git LFS) to the public GitHub repository
AAC-Open-Source-Pool/Ocean-Floor-Mapping — an UNOFFICIAL copy, which is why it is SHA-256 pinned (the pin equals
the LFS pointer's own oid) and why its contents are checked against an INDEPENDENT dataset before use: under the
trench windows the sediment must thin toward young crust in Seton et al.'s 2020 age grid (tests/seafloor-kernels.mjs,
with the windows read upside down as the control). The file's own `history` attribute names "GlobSed_v2" while it
is distributed as v3; which release it is cannot be checked here, and SOURCES.md says so.

WHY: both published trench studies remove the sediment's isostatic load before fitting the bending plate (Zhang
et al. 2018, eq. 1, with ρs = 2000 kg/m³ from their Table 1; Garcia et al. 2019). Sediment ponded in a trench and
thickening toward a margin otherwise reads as plate bending.

OUTPUT
  <id>.sed.bin.gz      int16 little-endian, total sediment thickness in whole METRES, NO_DATA (-32768) where the
                       grid has none (land). Row 0 = NORTH, col 0 = WEST, the source's own 1/12 deg gridline nodes
                       (nothing interpolated here). gzip mtime 0 so a re-bake is byte-stable.
  sediment-index.json  per site: the window geometry, plus the source, its sha256, the copy it came from, the citation.
"""
import argparse, gzip, hashlib, io, json, math, os, re
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'seafloor')
CACHE = os.path.join(ROOT, 'scripts', '.cache', 'seafloor-sediment')
URL = 'https://media.githubusercontent.com/media/AAC-Open-Source-Pool/Ocean-Floor-Mapping/main/ocean-floor-mapping/data/geophysical/GlobSed-v3.nc'
SHA256 = '86f61493dc41c47e6fcb0089058150e0963bd6f0379943fd80d1d09a66d77ca4'
STEP = 1 / 12                # the source's own 5' spacing
HALF_LAT_DEG = 6.0           # the same reach as the age windows (one degree past the 5 deg bathymetry windows)
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
    if h != SHA256: raise SystemExit(f'sediment grid sha256 {h} is not the pinned {SHA256}: refusing to bake')
    return path

def gz(raw):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g: g.write(raw)
    return buf.getvalue()

def bake(nc_path):
    import h5py
    f = h5py.File(nc_path, 'r')
    lat, lon, z = f['lat'][:], f['lon'][:], f['z'][:]          # lat ascending (south first), lon -180..180, z (lat, lon) metres
    h = f.attrs.get('history', b''); hist = h.decode() if isinstance(h, bytes) else str(h)   # copied from the file, never typed
    if not (abs(lat[0] + 90) < 1e-9 and abs(lat[1] - lat[0] - STEP) < 1e-9 and abs(lon[0] + 180) < 1e-9 and abs(lon[1] - lon[0] - STEP) < 1e-9):
        raise SystemExit('unexpected grid geometry')
    nlon = len(lon) - 1                                          # +180 duplicates -180 (gridline-registered)
    files, sites = {}, []
    for s in load_trench_sites():
        half_lon = min(HALF_LAT_DEG / max(math.cos(math.radians(s['lat'])), 0.2), HALF_LON_CAP_DEG)
        # nodes on the source's own lattice (k / 12 deg), so nothing is resampled
        jn, js = math.ceil((s['lat'] + HALF_LAT_DEG + 90) / STEP), math.floor((s['lat'] - HALF_LAT_DEG + 90) / STEP)
        iw, ie = math.floor((s['lon'] - half_lon + 180) / STEP), math.ceil((s['lon'] + half_lon + 180) / STEP)
        rows = np.arange(jn, js - 1, -1); cols = np.arange(iw, ie + 1) % nlon
        a = z[np.ix_(rows, cols)].astype(np.float64)
        q = np.where(np.isfinite(a), np.clip(np.rint(a), 0, 32767), NO_DATA).astype('<i2')
        name = s['id'] + '.sed.bin.gz'; files[name] = gz(q.tobytes())
        ok = np.isfinite(a)
        sites.append(dict(id=s['id'], file=name, north=round(jn * STEP - 90, 9), west=round(iw * STEP - 180, 9), step_deg=round(STEP, 12),
                          nx=len(cols), ny=len(rows), bytes=len(files[name]), ocean_fraction=round(float(ok.mean()), 4),
                          sed_median_m=round(float(np.nanmedian(a)), 0) if ok.any() else None, sed_max_m=round(float(np.nanmax(a)), 0) if ok.any() else None))
    index = dict(source=dict(name='GlobSed', url=URL, sha256=SHA256, copy='AAC-Open-Source-Pool/Ocean-Floor-Mapping (Git LFS), unofficial',
                             original='NOAA NCEI, GlobSed-v3.nc (egress-blocked at build time)',
                             citation='Straume et al. (2019), G-cubed, doi:10.1029/2018GC008115',
                             history_attr=hist),
                 encoding='int16le gzip, metres, row 0 north, col 0 west, gridline nodes', no_data=NO_DATA, sites=sites)
    files['sediment-index.json'] = (json.dumps(index, indent=1) + '\n').encode()
    return files

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--check', action='store_true'); ap.add_argument('--grid', default=os.path.join(CACHE, 'GlobSed-v3.nc'))
    a = ap.parse_args()
    files = bake(fetch(a.grid))
    if a.check:
        bad = [n for n, b in files.items() if not os.path.exists(os.path.join(OUT, n)) or open(os.path.join(OUT, n), 'rb').read() != b]
        if bad: raise SystemExit('stale: ' + ', '.join(bad))
        print(f'sediment grids up to date ({len(files) - 1} sites)'); return
    for n, b in files.items(): open(os.path.join(OUT, n), 'wb').write(b)
    print(f'wrote {len(files) - 1} sediment windows + sediment-index.json')

if __name__ == '__main__':
    main()
