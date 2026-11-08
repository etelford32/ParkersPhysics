"""
scripts/build-glacier-catalog-speed.py — ITS_LIVE surface speed for EVERY glacier in RGI 7.0
═════════════════════════════════════════════════════════════════════════════════════════════
GLACIER_WATCH_PLAN.md §0 "Speed for every glacier". Offline, never deployed. Writes
data/glaciers/catalog/rgi7-speed.bin.gz + rgi7-speed-meta.json, read by js/glacier-catalog.js.

WHAT IT MEASURES. NASA ITS_LIVE v2's annual COMPOSITES (composites/annual/v2-updated-september2025,
the same product the tracked tier's flowlines are traced in) carry `v0`, the fitted MEAN surface
speed over the composite period (2014–2024 where the tile has it), its fit error `v0_error`, and the
trend `dv_dt`, on a 120 m grid in 100 km tiles. For every glacier this bake reads the ONE tile under
its centroid and summarises v0 over the pixels whose CENTRES lie inside the glacier's REAL RGI 7.0
outline (point-in-polygon in the tile's projection) — not at the centroid, which can sit off a
curved glacier or on its slow upper basin:

  median v0   the typical surface speed of the glacier
  p90 v0      its fastest tenth
  p98 v0      its fastest ice — the trunk / tongue / icefall, what the map colours and what decides
              "partly resolved" (p90 missed Pasterze's tongue, Taku's terminus and Khumbu's icefall,
              each < 10 % of the outline: 7 of 41 tracked glaciers disagreed with the tracked tier on
              p90, measured; a decade-mean composite on ice is smooth enough that p98 is not noise)
  error       median v0_error over the same pixels
  trend       median dv_dt (m/yr per year) over the composite period
  coverage    pixels found ÷ pixels the outline's area implies (an outline that runs off the tile,
              or a sliver narrower than a pixel, reads low — printed, never hidden)

DETECTION USES THE TRACKED TIER'S RULE, NOT THE ICE-FREE-GROUND FLOOR. A first version judged each
glacier against v0 over its tile's ICE-FREE ground. Measured, that floor is worthless both ways:
0.4–0.6 m/yr almost everywhere (ITS_LIVE corrects its offsets ON stable ground, so it reads ~0 by
construction) — which called Storglaciären "moving" at 1.8 m/yr where field surveys measure
tens of m/yr, i.e. a 120 m composite UNDER-READS a glacier that small rather than measuring it — and
24–149 m/yr where sea ice and icebergs pass for ground (Svalbard, the Antarctic Peninsula). The
composite's own v0_error is stored in whole m/yr and is 0 for the median glacier. So the verdict is
the tracked tier's (js/glacier-engine.js `detectable`): a speed is RESOLVED only above twice the
typical single-pair error, and that error is MEASURED from the tracked archive — the median of the
tracked glaciers' own pair errors per RGI first-order region, the global median where a region has
none (`pair_error` in the meta, with its source date). The two tiers therefore agree: Storglaciären,
South Cascade and Gulkana are below detection in both. The ice-free-ground statistics stay in the
meta as information (`tiles[].p50/p90`), never as the verdict.

A glacier smaller than a pixel (no pixel centre inside) gets the nearest pixel to its centroid and
the `subpixel` flag. A glacier whose centroid is in no ITS_LIVE tile (333, mostly tiny islands) has
no speed. Nothing is interpolated or invented.

Usage: python scripts/build-glacier-catalog-speed.py --parquet <mirror> [--workers 16] [--limit-tiles N]
       [--check]   (rebuild in memory, compare bytes)
"""
import argparse, base64, concurrent.futures as cf, gzip, hashlib, io, json, math, os, sys, threading, time

import numpy as np
import pyarrow.parquet as pq
import shapely
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location('gv', os.path.join(HERE, 'build-glacier-velocity.py'))
GV = _ilu.module_from_spec(_spec); _spec.loader.exec_module(GV)
_spec2 = _ilu.spec_from_file_location('gc', os.path.join(HERE, 'build-glacier-catalog.py'))
GC = _ilu.module_from_spec(_spec2); _spec2.loader.exec_module(GC)

COMPOSITE_RELEASE = 'v2-updated-september2025'
MIN_STABLE = 2000          # ice-free valid pixels needed for a tile noise floor (≈ 29 km²)
RES_M = 120.0
NONE16 = 0                 # quantised-speed "no data"

def qspeed(v):
    """m/yr → uint16 on a log scale: (log10(v + 0.01) + 2.5)·8000; 0 = no data. 0 m/yr → 4000, 20 km/yr → 54 400."""
    if v is None or not np.isfinite(v): return NONE16
    return int(round((math.log10(max(0.0, float(v)) + 0.01) + 2.5) * 8000))


def tile_stats(feat, rows, geoms, area, cen, log):
    """One tile: read the chunks, measure the floor, summarise every glacier assigned to it."""
    p = feat['properties']
    z = GV.Zarr(p['composite_zarr_url'])
    x, y = z.read('x'), z.read('y')
    v0 = z.read('v0').astype(np.float64); v0[(v0 <= -32766) | ~np.isfinite(v0)] = np.nan
    er = z.read('v0_error').astype(np.float64); er[er >= 32767] = np.nan
    dv = z.read('dv_dt').astype(np.float64); dv[(dv <= -32766) | ~np.isfinite(dv)] = np.nan
    ice = z.read('landice').astype(bool) | z.read('floatingice').astype(bool)
    stable = v0[~ice & np.isfinite(v0)]
    floor = (dict(n=int(stable.size), p50=round(float(np.median(stable)), 2), p90=round(float(np.percentile(stable, 90)), 2))
             if stable.size >= MIN_STABLE else dict(n=int(stable.size), p50=None, p90=None))
    epsg = int(p['epsg'])
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    polys = shapely.transform(shapely.from_wkb(geoms), lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
    cx, cy = tr.transform(cen[0], cen[1])
    dx = x[1] - x[0]; dy = y[1] - y[0]          # dy < 0 (north-up)
    out = []
    for k, i in enumerate(rows):
        P = polys[k]
        x0, y0, x1, y1 = P.bounds
        j0 = max(0, int(math.floor((x0 - x[0]) / dx))); j1 = min(len(x) - 1, int(math.ceil((x1 - x[0]) / dx)))
        i0 = max(0, int(math.floor((y1 - y[0]) / dy))); i1 = min(len(y) - 1, int(math.ceil((y0 - y[0]) / dy)))
        sub = False
        if j1 >= j0 and i1 >= i0:
            XX, YY = np.meshgrid(x[j0:j1 + 1], y[i0:i1 + 1])
            m = shapely.contains_xy(P, XX, YY)
            ii, jj = np.nonzero(m); ii = ii + i0; jj = jj + j0
        else:
            ii = jj = np.array([], int)
        if ii.size == 0:        # smaller than a pixel: the nearest pixel to the centroid, flagged
            jn = int(round((cx[k] - x[0]) / dx)); inn = int(round((cy[k] - y[0]) / dy))
            if 0 <= jn < len(x) and 0 <= inn < len(y): ii = np.array([inn]); jj = np.array([jn]); sub = True
        vals = v0[ii, jj] if ii.size else np.array([])
        ok = np.isfinite(vals)
        expected = area[k] * 1e6 / (RES_M * RES_M)
        cov = None if expected < 1 else min(100, int(round(100 * ii.size / expected)))
        if ok.sum() == 0:
            out.append(dict(i=int(i), med=None, p90=None, p98=None, err=None, dvdt=None, npix=int(ii.size), cov=cov, sub=sub)); continue
        e = er[ii, jj][ok]; d = dv[ii, jj][ok]
        out.append(dict(i=int(i), med=float(np.median(vals[ok])), p90=float(np.percentile(vals[ok], 90)), p98=float(np.percentile(vals[ok], 98)),
                        err=float(np.median(e[np.isfinite(e)])) if np.isfinite(e).any() else None,
                        dvdt=float(np.median(d[np.isfinite(d)])) if np.isfinite(d).any() else None,
                        npix=int(ok.sum()), cov=cov, sub=sub))
    return floor, epsg, out


def build(parquet, workers=16, limit_tiles=None, log=print):
    # the same pinned mirror the catalogue was built from (its sha and row order are checked there)
    h = hashlib.sha256()
    with open(parquet, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    if h.hexdigest() != GC.MIRROR['sha256']: sys.exit('mirror sha256 ≠ the catalogue pin — rebuild the catalogue first')
    t = pq.read_table(parquet, columns=['cenlon', 'cenlat', 'area_km2']).to_pydict()
    lon = np.array(t['cenlon']); lat = np.array(t['cenlat']); area = np.array(t['area_km2'])
    n = len(lon)
    geomcol = pq.read_table(parquet, columns=['geometry']).column('geometry').to_pylist()
    raw = GV.http(GV.CATALOG)
    cat = json.loads(raw)
    feats = [f for f in cat['features'] if f['properties'].get('composite_zarr_url') and COMPOSITE_RELEASE in f['properties']['composite_zarr_url']]
    tile = np.full(n, -1)
    for k, f in enumerate(feats):          # each glacier → the tile under its centroid (first match; tiles do not overlap)
        poly = shapely.Polygon(f['geometry']['coordinates'][0]); x0, y0, x1, y1 = poly.bounds
        m = (tile < 0) & (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1)
        if not m.any(): continue
        ii = np.where(m)[0]; tile[ii[shapely.contains_xy(poly, lon[ii], lat[ii])]] = k
    used = sorted(set(int(v) for v in tile[tile >= 0]))
    if limit_tiles: used = used[:limit_tiles]
    log(f'{n} glaciers · {int((tile >= 0).sum())} under {len(used)} tiles · composites {COMPOSITE_RELEASE}')
    results, floors, tile_index = {}, [], {}
    lock = threading.Lock(); done = [0]; t0 = time.time()
    def work(k):
        rows = np.where(tile == k)[0]
        fl, epsg, out = tile_stats(feats[k], rows, [geomcol[i] for i in rows], area[rows], (lon[rows], lat[rows]), log)
        with lock:
            done[0] += 1
            if done[0] % 50 == 0: log(f'  {done[0]}/{len(used)} tiles  {time.time() - t0:.0f} s')
        return k, fl, epsg, out
    with cf.ThreadPoolExecutor(workers) as ex:
        for k, fl, epsg, out in ex.map(lambda k: GV_retry(work, k), used):
            tile_index[k] = len(floors)
            floors.append(dict(epsg=epsg, url=feats[k]['properties']['composite_zarr_url'].split('/annual/')[1], **fl))
            for r in out: results[r['i']] = (tile_index[k], r)
    # columns (row order = the catalogue's rows)
    T = np.full(n, 65535, '<u2'); QM = np.zeros(n, '<u2'); QP = np.zeros(n, '<u2'); QX = np.zeros(n, '<u2'); QE = np.zeros(n, '<u2')
    DV = np.full(n, -32768, '<i2'); NP = np.zeros(n, '<u2'); CV = np.full(n, 255, 'u1'); FL = np.zeros(n, 'u1')
    for i, (ti, r) in results.items():
        T[i] = ti
        QM[i] = qspeed(r['med']); QP[i] = qspeed(r['p90']); QX[i] = qspeed(r['p98']); QE[i] = qspeed(r['err'])
        if r['dvdt'] is not None: DV[i] = max(-32767, min(32767, int(round(r['dvdt'] * 10))))
        NP[i] = min(65535, r['npix']); CV[i] = 255 if r['cov'] is None else r['cov']
        FL[i] = (1 if r['sub'] else 0) | (2 if r['med'] is None else 0)
    header = b'RGI7SPD\x02' + np.array([n, 9], '<u4').tobytes()
    body = b''.join(GC.shuffle(a) for a in (T, QM, QP, QX, QE, DV, NP)) + CV.tobytes() + FL.tobytes()
    blob = GC.gz(header + body)
    meas = QM > 0
    pair_error = tracked_pair_errors(n)
    meta = dict(
        format='glacier-catalog-speed-v1',
        source=dict(product=f'NASA ITS_LIVE v2 annual composites ({COMPOSITE_RELEASE})', doi='10.5067/JQ6337239C96',
                    catalog_sha256=hashlib.sha256(raw).hexdigest(), mirror_sha256=GC.MIRROR['sha256']),
        n=n, columns=['tile:u16 (65535 none)', 'v_med:u16q', 'v_p90:u16q', 'v_p98:u16q', 'v0_error_med:u16q (whole m/yr upstream — informational)', 'dv_dt_med_x10:i16 (-32768 none)',
                      'npix:u16', 'coverage_pct:u8 (255 n/a)', 'flags:u8 (bit0 sub-pixel nearest, bit1 no valid v0)'],
        quantisation='q = round((log10(v + 0.01) + 2.5)·8000), 0 = none; v = 10^(q/8000 − 2.5) − 0.01 m/yr',
        detection='resolved when v0 exceeds TWICE the typical single-pair error of its RGI region (pair_error) — the tracked tier\'s detectable() rule; moving = median resolved, partly = only the fastest ice (p98)',
        pair_error=pair_error,
        min_stable_pixels=MIN_STABLE, resolution_m=RES_M, tiles=floors,
        summary=dict(glaciers_with_speed=int(meas.sum()), no_tile=int((T == 65535).sum()), subpixel=int((FL & 1).sum())),
        files={'rgi7-speed.bin.gz': dict(bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest())})
    return {'rgi7-speed.bin.gz': blob, 'rgi7-speed-meta.json': json.dumps(meta, separators=(',', ':'), sort_keys=True).encode() + b'\n'}


def tracked_pair_errors(n_rows, index_path=os.path.join(HERE, '..', 'data', 'glaciers', 'glaciers.json'),
                        cat_meta=os.path.join(HERE, '..', 'data', 'glaciers', 'catalog', 'rgi7-meta.json')):
    """The typical single-pair error, MEASURED: the median of each tracked glacier's own median pair error
    along its flowline, grouped by the RGI first-order region of its outline; the global median elsewhere."""
    idx = json.load(open(index_path)); cm = json.load(open(cat_meta))
    nod = idx.get('nodata', -32768)
    starts = sorted((s_, o1) for o1, s_ in cm['starts'].items())
    def o1_of(i):
        best = None
        for s_, o1 in starts:
            if s_ <= i: best = o1
        return best
    by, every = {}, []
    for g in idx['glaciers']:
        L = cm['watch_links'].get(g['id'])
        if not L or L.get('index') is None: continue
        a = np.frombuffer(base64.b64decode(g['climatology']['pair_err']), '<i2').astype(float)
        a = a[a != nod]
        if not a.size: continue
        m = float(np.median(a)); every.append(m)
        by.setdefault(o1_of(L['index']), []).append(m)
    return dict(by_o1={k: round(float(np.median(v)), 1) for k, v in sorted(by.items())},
                n_by_o1={k: len(v) for k, v in sorted(by.items())},
                global_=round(float(np.median(every)), 1), n=len(every),
                source=f"data/glaciers/glaciers.json (tracked archive baked {idx['glaciers'][0]['baked']}), median pair error along each flowline")


def GV_retry(fn, k, tries=3):
    for a in range(tries):
        try: return fn(k)
        except Exception:
            if a == tries - 1: raise
            time.sleep(2 * (a + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parquet', required=True); ap.add_argument('--out', default='data/glaciers/catalog')
    ap.add_argument('--workers', type=int, default=16); ap.add_argument('--limit-tiles', type=int, default=0)
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    files = build(a.parquet, a.workers, a.limit_tiles or None)
    if a.check:
        bad = [k for k, v in files.items() if not os.path.exists(os.path.join(a.out, k)) or open(os.path.join(a.out, k), 'rb').read() != v]
        if bad: sys.exit('speed table drifted: ' + ', '.join(bad))
        print('speed table matches'); return
    for k, v in files.items(): open(os.path.join(a.out, k), 'wb').write(v)
    print({k: f'{len(v) / 1024:.0f} KB' for k, v in files.items()})


if __name__ == '__main__':
    main()
