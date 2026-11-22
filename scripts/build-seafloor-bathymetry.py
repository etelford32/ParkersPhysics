#!/usr/bin/env python3
"""
build-seafloor-bathymetry.py — bakes data/seafloor/{index.json, <id>.bin.gz, world.bin.gz}

    python3 scripts/build-seafloor-bathymetry.py            # bake (needs network: AWS Terrain Tiles)
    python3 scripts/build-seafloor-bathymetry.py --only mariana,tonga

SOURCE: the public AWS Terrain Tiles bucket (s3.amazonaws.com/elevation-tiles-prod, Terrarium
PNG encoding, Mapzen/Tilezen "Joerd"). Its OCEAN is NOAA ETOPO1 (1 arc-minute) with GEBCO 2014
where finer — a ~1.8 km grid of mostly SATELLITE-ALTIMETRY-PREDICTED depth, NOT a multibeam
survey. That is why a trench's deepest baked cell differs from the published sounding by tens to
hundreds of metres, and the page prints both. gebco.net and ncei.noaa.gov are egress-blocked at
build time; this bucket is the one bathymetry host reachable.

Tiles are Web-Mercator and are SAMPLED (bilinear on decoded metres) onto each site's own
lat/lon grid through the exact inverse — never a stretched tile image (the Climalytix T1 rule).

OUTPUT
  <id>.bin.gz   int16 little-endian metres (elevation, negative below sea level), row-major,
                row 0 = NORTH, col 0 = WEST. gzip mtime 0 so a re-bake is byte-stable.
  <id>.wide.bin.gz  (kind 'trench' only) the same encoding on a +-5 deg window at 2 arc-minutes, read only by
                js/seafloor/trench-model.js for the sea floor far seaward of the trench. Its geometry is
                the site's `wide` entry in index.json.
  world.bin.gz  the whole planet at 0.25 deg for the globe (720 x 1440 cell centres, lat 90..-90), in
                10 m steps, row-delta coded and byte-shuffled (js/seafloor/bathy.js decodeWorld).
  index.json    per site: grid geometry + the deepest cell FOUND in the grid.
"""
import argparse, gzip, io, json, math, os, re, sys, time
import numpy as np, requests
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'seafloor')
CACHE = os.path.join(ROOT, 'scripts', '.cache', 'seafloor-tiles')
TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
ZOOM = 7                 # 0.0028 deg/px at the equator in x; finer than the 1' target everywhere used
WORLD_ZOOM = 4
WIDE_HALF_DEG = 5.0     # trench sites also get a WIDE window: the bending plate's far field lies 300-500 km seaward
WIDE_ARCMIN = 2.0       # 3.7 km: an outer rise is 50-150 km across, so this resolves it; the trench itself stays on the 1' window
WIDE_ZOOM = 6
WORLD_STEP = 0.25
WORLD_QUANT_M = 10      # the globe's relief is stored in 10 m steps (the grid itself is good to ~100 m)

def load_sites():
    """Read js/seafloor/sites.js — the ONE site list. Rows are pure literals on one line each."""
    src = open(os.path.join(ROOT, 'js', 'seafloor', 'sites.js'), encoding='utf-8').read()
    half = float(re.search(r'WINDOW_HALF_DEG\s*=\s*([\d.]+)', src).group(1))
    arcmin = float(re.search(r'GRID_ARCMIN\s*=\s*([\d.]+)', src).group(1))
    sites = []
    for m in re.finditer(r"\{ id: '([^']+)',\s*name: '([^']+)'.*?kind: '([^']+)',\s*lat: ([-\d.]+),\s*lon: ([-\d.]+)", src):
        sites.append(dict(id=m.group(1), name=m.group(2), kind=m.group(3), lat=float(m.group(4)), lon=float(m.group(5))))
    return sites, half, arcmin

_tiles = {}
def tile(z, x, y):
    n = 2 ** z
    x %= n
    key = (z, x, y)
    if key in _tiles: return _tiles[key]
    if y < 0 or y >= n:
        arr = np.full((256, 256), np.nan, dtype=np.float32)
    else:
        p = os.path.join(CACHE, f'{z}_{x}_{y}.png')
        if not os.path.exists(p):
            os.makedirs(CACHE, exist_ok=True)
            for attempt in range(4):
                try:
                    r = requests.get(TILE_URL.format(z=z, x=x, y=y), timeout=30)
                    r.raise_for_status()
                    if r.content[:8] != b'\x89PNG\r\n\x1a\n': raise RuntimeError('not a PNG')
                    open(p, 'wb').write(r.content); break
                except Exception as e:
                    if attempt == 3: raise
                    time.sleep(2 ** attempt)
        im = np.asarray(Image.open(p).convert('RGB'), dtype=np.float32)
        arr = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
    _tiles[key] = arr
    return arr

def sample(lat, lon, z):
    """Bilinear elevation (m) at arrays lat, lon (deg). Pixel centres at integer + 0.5."""
    n = 2 ** z
    gx = (lon + 180) / 360 * n * 256 - 0.5
    gy = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n * 256 - 0.5
    x0 = np.floor(gx).astype(np.int64); y0 = np.floor(gy).astype(np.int64)
    fx = gx - x0; fy = gy - y0
    out = np.zeros(lat.shape, dtype=np.float64)
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            px = x0 + dx; py = y0 + dy
            tx = px // 256; ty = py // 256
            v = np.empty(lat.shape, dtype=np.float64)
            for key in set(zip(tx.ravel().tolist(), ty.ravel().tolist())):
                msk = (tx == key[0]) & (ty == key[1])
                t = tile(z, key[0], key[1])
                v[msk] = t[(py[msk] % 256), (px[msk] % 256)]
            out += v * wy * wx
    return out

def write_bin(path, arr):
    raw = np.clip(np.rint(arr), -32768, 32767).astype('<i2').tobytes()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g: g.write(raw)
    open(path, 'wb').write(buf.getvalue())
    return len(buf.getvalue())

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only', default='')
    a = ap.parse_args()
    sites, half, arcmin = load_sites()
    only = set(filter(None, a.only.split(',')))
    os.makedirs(OUT, exist_ok=True)
    idx_path = os.path.join(OUT, 'index.json')
    prev = {s['id']: s for s in json.load(open(idx_path))['sites']} if os.path.exists(idx_path) else {}
    step = arcmin / 60
    rows = []
    for s in sites:
        if only and s['id'] not in only:
            if s['id'] in prev: rows.append(prev[s['id']])
            continue
        half_lon = min(half / max(math.cos(math.radians(s['lat'])), 0.2), 6.0)
        half_lon = round(half_lon / step) * step
        ny = int(round(2 * half / step)) + 1
        nx = int(round(2 * half_lon / step)) + 1
        north = s['lat'] + half; west = s['lon'] - half_lon
        lat = north - np.arange(ny) * step
        lon = west + np.arange(nx) * step
        LON, LAT = np.meshgrid(lon, lat)
        z = sample(LAT, LON, ZOOM)
        if not np.isfinite(z).all(): raise SystemExit(f"{s['id']}: window leaves the tile pyramid")
        zi = np.rint(z).astype(np.int32)
        j, i = np.unravel_index(np.argmin(zi), zi.shape)
        size = write_bin(os.path.join(OUT, s['id'] + '.bin.gz'), z)
        wide = None
        if s['kind'] == 'trench':
            wstep = WIDE_ARCMIN / 60
            whl = round(min(WIDE_HALF_DEG / max(math.cos(math.radians(s['lat'])), 0.2), 12.0) / wstep) * wstep
            wny = int(round(2 * WIDE_HALF_DEG / wstep)) + 1; wnx = int(round(2 * whl / wstep)) + 1
            wnorth = s['lat'] + WIDE_HALF_DEG; wwest = s['lon'] - whl
            WLON, WLAT = np.meshgrid(wwest + np.arange(wnx) * wstep, wnorth - np.arange(wny) * wstep)
            wz = sample(WLAT, WLON, WIDE_ZOOM)
            if not np.isfinite(wz).all(): raise SystemExit(f"{s['id']}: wide window leaves the tile pyramid")
            wsz = write_bin(os.path.join(OUT, s['id'] + '.wide.bin.gz'), wz)
            wide = dict(file=s['id'] + '.wide.bin.gz', north=round(float(wnorth), 6), west=round(float(wwest), 6), step_deg=round(wstep, 8), nx=wnx, ny=wny, tile_zoom=WIDE_ZOOM, bytes=wsz)
            size_w = wsz
        rows.append(dict(
            id=s['id'], north=round(float(north), 6), west=round(float(west), 6), step_deg=round(step, 8), nx=nx, ny=ny,
            deepest=dict(lat=round(float(lat[j]), 5), lon=round(float(((lon[i] + 180) % 360) - 180), 5), depth_m=int(-zi[j, i])),
            median_depth_m=int(-np.median(zi[zi < 0])) if (zi < 0).any() else None,
            ocean_fraction=round(float((zi < 0).mean()), 4), bytes=size, **({'wide': wide} if wide else {})))
        print(f"{s['id']:16s} {nx}x{ny}  deepest {-zi[j, i]:6d} m at {lat[j]:.3f}, {lon[i]:.3f}  ({size/1024:.0f} KB)")
    # overview: 0.25 deg, 10 m steps, row-delta coded then byte-shuffled (the glacier catalogue's trick):
    # value[j][i] = q[j][i] - q[j][i-1], first column = difference from the row above; low bytes then high bytes.
    wlat = 90 - WORLD_STEP / 2 - np.arange(int(round(180 / WORLD_STEP))) * WORLD_STEP
    wlon = -180 + WORLD_STEP / 2 + np.arange(int(round(360 / WORLD_STEP))) * WORLD_STEP
    LON, LAT = np.meshgrid(wlon, np.clip(wlat, -85.0, 85.0))   # Mercator ends at 85.05: the caps repeat the last row (disclosed)
    q = np.rint(sample(LAT, LON, WORLD_ZOOM) / WORLD_QUANT_M).astype(np.int32)
    d = q.copy(); d[:, 1:] = q[:, 1:] - q[:, :-1]; d[1:, 0] = q[1:, 0] - q[:-1, 0]
    if np.abs(d).max() > 32767: raise SystemExit('world delta overflows int16')
    b2 = np.frombuffer(d.astype('<i2').tobytes(), dtype=np.uint8).reshape(-1, 2)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g: g.write(np.concatenate([b2[:, 0], b2[:, 1]]).tobytes())
    open(os.path.join(OUT, 'world.bin.gz'), 'wb').write(buf.getvalue()); wsize = len(buf.getvalue())
    index = dict(
        format='seafloor-bathy-v1', baked=time.strftime('%Y-%m-%d', time.gmtime()),
        source='AWS Terrain Tiles (Terrarium) - ocean: NOAA ETOPO1 1 arc-minute + GEBCO 2014',
        source_url='https://registry.opendata.aws/terrain-tiles/',
        note='Mostly satellite-altimetry-predicted depth on a ~1.8 km grid, not a multibeam survey. Elevation in metres, negative below sea level.',
        tile_zoom=ZOOM, encoding='int16le gzip, row 0 north, col 0 west',
        world=dict(file='world.bin.gz', encoding='q-delta-rows-shuffled', quant_m=WORLD_QUANT_M, step_deg=WORLD_STEP, nx=len(wlon), ny=len(wlat), north=90, west=-180, cell='centre', polar_cap_deg=85, tile_zoom=WORLD_ZOOM, bytes=wsize),
        sites=rows)
    json.dump(index, open(idx_path, 'w'), indent=1); open(idx_path, 'a').write('\n')
    print('wrote', os.path.relpath(idx_path, ROOT), f'world {wsize/1024:.0f} KB')

if __name__ == '__main__':
    main()
