"""
scripts/build-glacier-catalog-annual.py — YEAR-BY-YEAR ITS_LIVE speed for every RESOLVED glacier
═════════════════════════════════════════════════════════════════════════════════════════════════
GLACIER_WATCH_PLAN.md §0 "A speed history for the glacier you click". Offline, never deployed. Writes
data/glaciers/catalog/rgi7-annual-NN.bin.gz (one per RGI first-order region) + rgi7-annual-meta.json,
read by js/glacier-catalog.js `loadAnnual` when a record card opens.

WHY A BAKE AND NOT A SERVER ROUTE. The source is the SAME NASA ITS_LIVE v2 annual composites the speed
table summarises (composites/annual/v2-updated-september2025): one f4 `v` slab per CALENDAR YEAR per
100 km tile (time = YYYY-01-01; 1982–2025 where Landsat 4/5 reach, ~2013/2015 → 2025 elsewhere), each
year's mean of a sinusoidal fit, so the seasonal cycle is already out of it. A live route would have to
fetch and blosc-decode ~2.2 MB per YEAR (a 42-year tile is ~90 MB) and hold the glacier's outline,
which the site does not ship — for a product NASA republishes about once a year. Baked, the whole
history of all 4 434 resolved glaciers is a few hundred KB of static files on the CDN, and a click
costs one ~30 KB fetch. Re-run it when ITS_LIVE publishes a new composite release (and after the
speed bake, whose verdict selects the glaciers).

WHAT IT MEASURES. For each glacier the speed table calls `moving` or `partly` (resolved: above twice
the region's typical pair error — the tracked tier's rule; `below` glaciers get NO series because a
year-by-year line of a speed the satellites cannot resolve is noise drawn as a record), over the SAME
pixels as the speed table (centres inside the real RGI 7.0 outline; the nearest pixel for a sub-pixel
glacier), for every year of its tile:

  median v    the glacier's typical speed that year
  p98 v       its fastest ice that year (what the map colours)
  error       median v_error over the same pixels (ITS_LIVE's own error-weighted error, m/yr)
  coverage    valid pixels that year ÷ pixels with a valid v0 — a year below COVER_MIN is still
              stored but the page draws it as a gap, never as a value: a half-imaged glacier's
              median is the median of whichever half was imaged (the early-Landsat years especially)

The last year is PARTIAL (the release was built in September 2025) and the meta says so. Nothing is
interpolated, smoothed or extrapolated.

Usage: python scripts/build-glacier-catalog-annual.py --parquet <mirror> [--workers 8] [--limit-tiles N] [--check]
"""
import argparse, concurrent.futures as cf, gzip, hashlib, json, math, os, sys, threading, time

import numpy as np
import pyarrow.parquet as pq
import shapely
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
import importlib.util as _ilu
def _load(name, file):
    s = _ilu.spec_from_file_location(name, os.path.join(HERE, file)); m = _ilu.module_from_spec(s); s.loader.exec_module(m); return m
GV = _load('gv', 'build-glacier-velocity.py')
GC = _load('gc', 'build-glacier-catalog.py')
SP = _load('sp', 'build-glacier-catalog-speed.py')

BASE = 'https://its-live-data.s3.amazonaws.com/composites/annual/'
CAT_DIR = os.path.join(HERE, '..', 'data', 'glaciers', 'catalog')
YEAR0 = 1980               # year axis origin in the files (u8 offsets)
COVER_MIN = 50             # % of the glacier's v0 pixels a year needs before the page draws it
PARTIAL_YEAR = 2025        # composites v2-updated-september2025: the last year is incomplete
YEAR_WORKERS = 6           # parallel year slabs per tile


def unshuffle(buf, off, n, size, dtype):
    planes = np.frombuffer(buf, 'u1', n * size, off).reshape(size, n)
    return np.ascontiguousarray(planes.T).view(dtype).reshape(n)


def read_speed_table():
    """The committed speed table → (tile, med, p98, flags) columns, dequantised exactly like decodeSpeed (f32)."""
    raw = gzip.decompress(open(os.path.join(CAT_DIR, 'rgi7-speed.bin.gz'), 'rb').read())
    assert raw[:8] == b'RGI7SPD\x02', 'not a v2 speed table'
    n = int(np.frombuffer(raw, '<u4', 1, 8)[0]); off = 16
    cols = []
    for dt in ('<u2', '<u2', '<u2', '<u2', '<u2', '<i2', '<u2'):
        cols.append(unshuffle(raw, off, n, 2, dt)); off += 2 * n
    off += n                                                     # coverage
    flags = np.frombuffer(raw, 'u1', n, off)
    deq = lambda q: np.where(q == 0, np.nan, (10.0 ** (q / 8000.0 - 2.5) - 0.01)).astype(np.float32).astype(np.float64)
    return dict(n=n, tile=cols[0], med=deq(cols[1].astype(float)), p98=deq(cols[3].astype(float)), flags=flags)


def resolved_rows(spd, smeta, cmeta):
    """speedOf()'s verdict, row by row: moving (median > 2σ) or partly (only p98 > 2σ). The node gate
    checks this set equals the kernel's."""
    starts = sorted((s_, o1) for o1, s_ in cmeta['starts'].items())
    o1 = np.empty(spd['n'], dtype=object)
    bounds = [s_ for s_, _ in starts] + [spd['n']]
    for k, (s_, r) in enumerate(starts): o1[s_:bounds[k + 1]] = r
    pe = smeta['pair_error']
    thr = np.array([2 * (pe['by_o1'][r] if pe['by_o1'].get(r) is not None else pe['global_']) for r in o1])
    ok = (spd['tile'] != 65535) & ((spd['flags'] & 2) == 0) & np.isfinite(spd['p98'])
    moving = ok & (spd['med'] > thr)
    partly = ok & ~moving & (spd['p98'] > thr)
    return np.where(moving | partly)[0], o1


def pixel_sets(z, epsg, geoms, cen):
    """The speed table's pixel rule, verbatim: centres inside the outline; else the nearest pixel, flagged."""
    x, y = z.read('x'), z.read('y')
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    polys = shapely.transform(shapely.from_wkb(geoms), lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
    cx, cy = tr.transform(cen[0], cen[1])
    dx = x[1] - x[0]; dy = y[1] - y[0]
    out = []
    for k, P in enumerate(polys):
        x0, y0, x1, y1 = P.bounds
        j0 = max(0, int(math.floor((x0 - x[0]) / dx))); j1 = min(len(x) - 1, int(math.ceil((x1 - x[0]) / dx)))
        i0 = max(0, int(math.floor((y1 - y[0]) / dy))); i1 = min(len(y) - 1, int(math.ceil((y0 - y[0]) / dy)))
        ii = jj = np.array([], int)
        if j1 >= j0 and i1 >= i0:
            XX, YY = np.meshgrid(x[j0:j1 + 1], y[i0:i1 + 1])
            ii, jj = np.nonzero(shapely.contains_xy(P, XX, YY)); ii = ii + i0; jj = jj + j0
        if ii.size == 0:
            jn = int(round((cx[k] - x[0]) / dx)); inn = int(round((cy[k] - y[0]) / dy))
            if 0 <= jn < len(x) and 0 <= inn < len(y): ii = np.array([inn]); jj = np.array([jn])
        out.append((ii, jj))
    return out


def tile_series(url, epsg, rows, geoms, cen):
    z = GV.Zarr(BASE + url)
    t = z.read('time')
    years = [int(str(np.datetime64('1970-01-01') + np.timedelta64(int(d), 'D'))[:4]) for d in t]
    if any(b - a != 1 for a, b in zip(years, years[1:])): raise ValueError(f'{url}: non-consecutive years {years}')
    px = pixel_sets(z, epsg, geoms, cen)
    v0 = z.read('v0').astype(np.float64); v0[(v0 <= -32766) | ~np.isfinite(v0)] = np.nan
    base = [max(1, int(np.isfinite(v0[ii, jj]).sum())) if ii.size else 1 for ii, jj in px]
    ny = len(years)
    med = np.full((len(rows), ny), np.nan); p98 = np.full((len(rows), ny), np.nan)
    err = np.full((len(rows), ny), np.nan); cov = np.zeros((len(rows), ny), 'u1')

    def year(k):
        v = z.read('v', [slice(k, k + 1), slice(0, 10**9), slice(0, 10**9)])[0].astype(np.float64)
        v[(v <= -32766) | ~np.isfinite(v) | (v < 0)] = np.nan
        e = z.read('v_error', [slice(k, k + 1), slice(0, 10**9), slice(0, 10**9)])[0].astype(np.float64)
        e[e >= 32767] = np.nan
        for g, (ii, jj) in enumerate(px):
            if not ii.size: continue
            vals = v[ii, jj]; ok = np.isfinite(vals)
            if not ok.any(): continue
            vv = vals[ok]; ee = e[ii, jj][ok]; ee = ee[np.isfinite(ee)]
            med[g, k] = np.median(vv); p98[g, k] = np.percentile(vv, 98)
            err[g, k] = np.median(ee) if ee.size else np.nan
            cov[g, k] = min(100, int(round(100 * ok.sum() / base[g])))
    with cf.ThreadPoolExecutor(YEAR_WORKERS) as ex:
        list(ex.map(lambda k: SP.GV_retry(year, k), range(ny)))
    return years, med, p98, err, cov


def build(parquet, workers=8, limit_tiles=None, log=print):
    h = hashlib.sha256()
    with open(parquet, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    if h.hexdigest() != GC.MIRROR['sha256']: sys.exit('mirror sha256 ≠ the catalogue pin — rebuild the catalogue first')
    cmeta = json.load(open(os.path.join(CAT_DIR, 'rgi7-meta.json')))
    smeta_raw = open(os.path.join(CAT_DIR, 'rgi7-speed-meta.json'), 'rb').read(); smeta = json.loads(smeta_raw)
    speed_raw = open(os.path.join(CAT_DIR, 'rgi7-speed.bin.gz'), 'rb').read()
    if hashlib.sha256(speed_raw).hexdigest() != smeta['files']['rgi7-speed.bin.gz']['sha256']: sys.exit('speed table ≠ its meta — re-run the speed bake')
    spd = read_speed_table()
    rows, o1 = resolved_rows(spd, smeta, cmeta)
    t = pq.read_table(parquet, columns=['cenlon', 'cenlat']).to_pydict()
    lon = np.array(t['cenlon']); lat = np.array(t['cenlat'])
    geomcol = pq.read_table(parquet, columns=['geometry']).column('geometry')
    by_tile = {}
    for i in rows: by_tile.setdefault(int(spd['tile'][i]), []).append(int(i))
    tiles = sorted(by_tile)
    if limit_tiles: tiles = tiles[:limit_tiles]
    log(f'{len(rows)} resolved glaciers under {len(by_tile)} tiles · {smeta["source"]["product"]}')
    series = {}; lock = threading.Lock(); done = [0]; t0 = time.time()

    def work(k):
        r = by_tile[k]; T = smeta['tiles'][k]
        out = tile_series(T['url'], T['epsg'], r, [geomcol[i].as_py() for i in r], (lon[r], lat[r]))
        with lock:
            done[0] += 1
            if done[0] % 25 == 0: log(f'  {done[0]}/{len(tiles)} tiles  {time.time() - t0:.0f} s')
        return k, out

    with cf.ThreadPoolExecutor(workers) as ex:
        for k, (years, med, p98, err, cov) in ex.map(lambda k: SP.GV_retry(work, k), tiles):
            for g, i in enumerate(by_tile[k]):
                series[i] = (years, med[g], p98[g], err[g], cov[g])

    # ── one file per RGI o1 region: columns (index, first year, n years) + the concatenated year rows
    files, shards = {}, {}
    for r in sorted(set(o1[i] for i in series)):
        idx = sorted(i for i in series if o1[i] == r)
        I = np.array(idx, '<u4'); Y0 = np.array([series[i][0][0] - YEAR0 for i in idx], 'u1'); NY = np.array([len(series[i][0]) for i in idx], 'u1')
        QM = np.concatenate([[SP.qspeed(v) for v in series[i][1]] for i in idx]).astype('<u2')
        QX = np.concatenate([[SP.qspeed(v) for v in series[i][2]] for i in idx]).astype('<u2')
        QE = np.concatenate([[SP.qspeed(v) for v in series[i][3]] for i in idx]).astype('<u2')
        CV = np.concatenate([series[i][4] for i in idx]).astype('u1')
        m = len(CV)
        header = b'RGI7ANN\x01' + np.array([len(idx), m, YEAR0, 0], '<u4').tobytes()
        blob = GC.gz(header + GC.shuffle(I) + Y0.tobytes() + NY.tobytes() + GC.shuffle(QM) + GC.shuffle(QX) + GC.shuffle(QE) + CV.tobytes())
        name = f'rgi7-annual-{r}.bin.gz'
        files[name] = blob
        shards[r] = dict(file=name, series=len(idx), year_rows=m, bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest())
    ys = [y for s in series.values() for y in s[0]]
    meta = dict(
        format='glacier-catalog-annual-v1',
        source=dict(product=smeta['source']['product'], doi=smeta['source']['doi'], composite_catalog_sha256=smeta['source']['catalog_sha256'],
                    speed_table_sha256=smeta['files']['rgi7-speed.bin.gz']['sha256'], mirror_sha256=GC.MIRROR['sha256']),
        selection="the speed table's resolved glaciers (moving + partly); below-detection glaciers get no series",
        statistics='per calendar year, over the speed table\'s pixels (centres inside the RGI 7.0 outline): median and p98 of v, median v_error, coverage = valid pixels that year ÷ pixels with a valid v0',
        quantisation='q = round((log10(v + 0.01) + 2.5)·8000), 0 = none; v = 10^(q/8000 − 2.5) − 0.01 m/yr (the speed table\'s)',
        layout=f'magic RGI7ANN\\x01, u32 [nSeries, nYearRows, YEAR0, 0]; shuffled u32 index; u8 firstYear−YEAR0; u8 nYears; shuffled u16 qMed, qP98, qErr (nYearRows); u8 coverage%',
        cover_min=COVER_MIN, partial_year=PARTIAL_YEAR, year0=YEAR0,
        years=[int(min(ys)), int(max(ys))] if ys else None,
        summary=dict(series=len(series), resolved=int(len(rows))),
        shards=shards)
    files['rgi7-annual-meta.json'] = json.dumps(meta, separators=(',', ':'), sort_keys=True).encode() + b'\n'
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parquet', required=True); ap.add_argument('--out', default=CAT_DIR)
    ap.add_argument('--workers', type=int, default=8); ap.add_argument('--limit-tiles', type=int, default=0)
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    files = build(a.parquet, a.workers, a.limit_tiles or None)
    if a.check:
        bad = [k for k, v in files.items() if not os.path.exists(os.path.join(a.out, k)) or open(os.path.join(a.out, k), 'rb').read() != v]
        if bad: sys.exit('annual speed files drifted: ' + ', '.join(bad))
        print('annual speed files match'); return
    for k, v in files.items(): open(os.path.join(a.out, k), 'wb').write(v)
    print({k: f'{len(v) / 1024:.0f} KB' for k, v in files.items()})


if __name__ == '__main__':
    main()
