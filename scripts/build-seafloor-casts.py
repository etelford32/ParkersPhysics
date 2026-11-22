#!/usr/bin/env python3
"""
build-seafloor-casts.py — bakes data/seafloor/casts.json.gz: the DEEPEST REAL temperature casts
near each sea-floor site, from NOAA's World Ocean Database.

    pip install h5py fsspec aiohttp requests numpy
    python3 scripts/build-seafloor-casts.py [--from 1900] [--to 2024] [--only mariana,tonga]

SOURCE: s3://noaa-wod-pds (public, NOAA NCEI World Ocean Database, one netCDF per year per
instrument family). Read here: `ctd` (CTD rosettes), `osd` (bottle / low-resolution casts — where
the historical hadal casts live) and, from 2014, `pfl` (profiling floats, incl. Deep Argo to 6 km).
ncei.noaa.gov itself is egress-blocked at build time; this bucket is the reachable copy.

HOW IT READS: the per-year files are 0.1-3.5 GB, but every variable is stored CONTIGUOUS and
uncompressed. h5py (over fsspec) is used ONLY to read each variable's byte offset; the data are
then fetched with plain HTTP Range requests from ONE thread (never range-read through h5py from
threads - the glacier baker's scar). A year costs ~1 MB of transfer, not the file.

WHAT IS KEPT, per site: the 8 deepest casts whose position is within RADIUS_KM of the site's
target (the deepest baked cell; the window centre for an abyssal plain) and that reach MIN_DEPTH_M.
Levels flagged by WOD's own quality control (depth or temperature flag != 0) are DROPPED, never
repaired; salinity is kept only where its flag is 0. Profiles are THINNED (every level above
500 m at >= 10 m spacing, >= 25 m to 2 km, >= 50 m below; the last level always kept) -
subsampled, never averaged. Temperatures are as archived (in situ, deg C; IPTS-68 vs ITS-90
differs by millikelvin at these temperatures and is not converted).
"""
import argparse, gzip, heapq, io, json, math, os, re, sys, time
import numpy as np, requests, h5py, fsspec

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'seafloor')
BUCKET = 'https://noaa-wod-pds.s3.amazonaws.com'
RADIUS_KM = 150
MIN_DEPTH_M = 2000
KEEP = 8
CANDIDATES = 24
PFL_FROM = 2014

S = requests.Session()
def rng(url, start, nbytes):
    for attempt in range(5):
        try:
            r = S.get(url, headers={'Range': f'bytes={start}-{start + nbytes - 1}'}, timeout=60)
            if r.status_code != 206 or len(r.content) != nbytes: raise RuntimeError(f'HTTP {r.status_code}, {len(r.content)} of {nbytes} bytes')
            return r.content
        except Exception:
            if attempt == 4: raise
            time.sleep(1.5 ** attempt)

class Wod:
    def __init__(self, url):
        self.url = url
        fs = fsspec.filesystem('https')
        self.h = h = h5py.File(fs.open(url, block_size=1 << 20, cache_type='blockcache'), 'r')
        if True:
            self.meta = {}
            for k in ('lat', 'lon', 'date', 'wod_unique_cast', 'z_row_size', 'Temperature_row_size', 'Salinity_row_size',
                      'z', 'z_WODflag', 'Temperature', 'Temperature_WODflag', 'Salinity', 'Salinity_WODflag',
                      'Bottom_Depth', 'Platform', 'country', 'originators_cruise_identifier', 'Temperature_WODprofileflag'):
                if k not in h: continue
                d = h[k]
                off = d.id.get_offset()
                # a few old files store some variables chunked: those are read through h5py (one thread)
                self.meta[k] = (off, d.shape, d.dtype)
    def has(self, k): return k in self.meta
    def read(self, k, start=0, count=None):
        off, shape, dt = self.meta[k]
        width = int(np.prod(shape[1:])) if len(shape) > 1 else 1
        if count is None: count = shape[0] - start
        if count <= 0: return np.zeros((0,), dtype=dt)
        if off is None: return np.asarray(self.h[k][start:start + count])
        raw = rng(self.url, off + start * width * dt.itemsize, count * width * dt.itemsize)
        a = np.frombuffer(raw, dtype=dt)
        return a.reshape((count,) + tuple(shape[1:])) if len(shape) > 1 else a
    def text(self, k, i):
        if not self.has(k): return None
        s = b''.join(self.read(k, i, 1)[0].tolist()).decode('latin-1').strip()
        return s or None

def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 6371.0088 * 2 * np.arcsin(np.sqrt(a))

def targets():
    src = open(os.path.join(ROOT, 'js', 'seafloor', 'sites.js'), encoding='utf-8').read()
    kinds = {m.group(1): (m.group(2), float(m.group(3)), float(m.group(4)))
             for m in re.finditer(r"\{ id: '([^']+)'.*?kind: '([^']+)',\s*lat: ([-\d.]+),\s*lon: ([-\d.]+)", src)}
    idx = json.load(open(os.path.join(OUT, 'index.json')))
    out = []
    for s in idx['sites']:
        kind, clat, clon = kinds[s['id']]
        lat, lon = (clat, clon) if kind == 'plain' else (s['deepest']['lat'], s['deepest']['lon'])
        out.append(dict(id=s['id'], lat=lat, lon=lon))
    return out

def thin(z):
    keep, last = [], -1e9
    for i, d in enumerate(z):
        step = 10 if d < 500 else 25 if d < 2000 else 50
        if d - last >= step or i == len(z) - 1: keep.append(i); last = d
    return keep

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='y0', type=int, default=1900); ap.add_argument('--to', dest='y1', type=int, default=2024)
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    tg = targets()
    only = set(filter(None, a.only.split(',')))
    if only: tg = [t for t in tg if t['id'] in only]
    heaps = {t['id']: [] for t in tg}          # (maxdepth, tiebreak, record)
    files = []
    for y in range(a.y0, a.y1 + 1):
        for fam in ('ctd', 'osd') + (('pfl',) if y >= PFL_FROM else ()):
            files.append((y, fam))
    scanned, tie = [], 0
    t0 = time.time()
    for y, fam in files:
        url = f'{BUCKET}/{y}/wod_{fam}_{y}.nc'
        if S.head(url, timeout=30).status_code != 200: continue
        try:
            w = Wod(url)
            if not (w.has('Temperature') and w.has('z')): continue
            lat, lon = w.read('lat'), w.read('lon')
            zr = w.read('z_row_size').astype(np.int64); tr = w.read('Temperature_row_size').astype(np.int64)
            zoff = np.concatenate(([0], np.cumsum(zr)[:-1])); toff = np.concatenate(([0], np.cumsum(tr)[:-1]))
            ok = (tr == zr) & (zr > 1)
            n_file = 0
            # a busy year off Japan has thousands of candidates: past 200, read the last-level depths in
            # merged byte ranges (one request per ~2 MB of the z array) instead of one request each
            near = np.zeros(len(lat), dtype=bool)
            for t in tg: near |= ok & (haversine_km(t['lat'], t['lon'], lat, lon) <= RADIUS_KM)
            zlast_all = {}
            idx_near = np.nonzero(near)[0]
            if len(idx_near) > 200:
                pos = zoff[idx_near] + zr[idx_near] - 1
                order = np.argsort(pos); a0 = 0
                while a0 < len(order):
                    b0 = a0
                    while b0 + 1 < len(order) and pos[order[b0 + 1]] - pos[order[a0]] < 500_000: b0 += 1
                    start = int(pos[order[a0]]); block = w.read('z', start, int(pos[order[b0]]) - start + 1)
                    for q in order[a0:b0 + 1]: zlast_all[int(idx_near[q])] = float(block[int(pos[q]) - start])
                    a0 = b0 + 1
            for t in tg:
                km = haversine_km(t['lat'], t['lon'], lat, lon)
                cand = np.nonzero(ok & (km <= RADIUS_KM))[0]
                if not len(cand): continue
                h = heaps[t['id']]
                for i in cand:
                    floor = h[0][0] if len(h) >= CANDIDATES else MIN_DEPTH_M
                    zlast = zlast_all[int(i)] if int(i) in zlast_all else float(w.read('z', int(zoff[i] + zr[i] - 1), 1)[0])
                    if not (zlast >= floor): continue
                    tie += 1; n_file += 1
                    rec = dict(url=url, fam=fam, i=int(i), zoff=int(zoff[i]), toff=int(toff[i]), n=int(zr[i]), km=float(km[i]))
                    (heapq.heappush if len(h) < CANDIDATES else heapq.heappushpop)(h, (zlast, tie, rec))
            w.h.close(); scanned.append(f'{y}/{fam}')
            print(f'{y} {fam}: {len(lat):7d} casts, {n_file:3d} candidates  [{time.time() - t0:5.0f} s]', flush=True)
        except Exception as e:
            print(f'{y} {fam}: FAILED {type(e).__name__}: {e}', flush=True)
            raise
    # ── second pass: read the surviving candidates in full ─────────────────────
    wods, out = {}, {}
    for t in tg:
        casts = []
        for zlast, _, r in sorted(heaps[t['id']], reverse=True):
            w = wods.get(r['url']) or wods.setdefault(r['url'], Wod(r['url']))
            i, n = r['i'], r['n']
            z = w.read('z', r['zoff'], n).astype(np.float64); T = w.read('Temperature', r['toff'], n).astype(np.float64)
            zf = w.read('z_WODflag', r['zoff'], n); tf = w.read('Temperature_WODflag', r['toff'], n)
            good = (zf == 0) & (tf == 0) & np.isfinite(z) & np.isfinite(T) & (T > -3) & (T < 40) & (z >= 0)
            Sal = None
            if w.has('Salinity'):
                sr = w.read('Salinity_row_size').astype(np.int64)
                if sr[i] == n:
                    so = int(np.sum(sr[:i]))
                    Sal = w.read('Salinity', so, n).astype(np.float64); sf = w.read('Salinity_WODflag', so, n)
                    Sal = np.where((sf == 0) & (Sal > 2) & (Sal < 42), Sal, np.nan)
            z, T = z[good], T[good]
            if Sal is not None: Sal = Sal[good]
            order = np.argsort(z, kind='stable'); z, T = z[order], T[order]
            if Sal is not None: Sal = Sal[order]
            mono = np.concatenate(([True], np.diff(z) > 0))
            z, T = z[mono], T[mono]
            if Sal is not None: Sal = Sal[mono]
            if len(z) < 5 or z[-1] < MIN_DEPTH_M: continue
            k = thin(z)
            bd = float(w.read('Bottom_Depth', i, 1)[0]) if w.has('Bottom_Depth') else float('nan')
            date = int(w.read('date', i, 1)[0])
            casts.append(dict(
                wod_cast=int(w.read('wod_unique_cast', i, 1)[0]), dataset=r['fam'], date=f'{date // 10000:04d}-{date // 100 % 100:02d}-{date % 100:02d}',
                lat=round(float(w.read('lat', i, 1)[0]), 4), lon=round(float(w.read('lon', i, 1)[0]), 4), km=round(r['km'], 1),
                platform=w.text('Platform', i), country=w.text('country', i), cruise=w.text('originators_cruise_identifier', i),
                bottom_depth_m=round(bd) if math.isfinite(bd) and bd > 0 else None,
                profile_flag=int(w.read('Temperature_WODprofileflag', i, 1)[0]) if w.has('Temperature_WODprofileflag') else None,
                levels=int(len(z)), max_depth_m=round(float(z[-1]), 1),
                z=[round(float(v), 1) for v in z[k]], t=[round(float(v), 4) for v in T[k]],
                s=None if Sal is None or not np.isfinite(Sal).any() else [None if not math.isfinite(v) else round(float(v), 4) for v in Sal[k]]))
            if len(casts) == KEEP: break
        out[t['id']] = dict(target=dict(lat=t['lat'], lon=t['lon']), casts=casts)
        print(f"{t['id']:16s} {len(casts)} casts, deepest {casts[0]['max_depth_m'] if casts else '-'} m", flush=True)
    path = os.path.join(OUT, 'casts.json.gz')
    if only and os.path.exists(path):
        prev = json.loads(gzip.decompress(open(path, 'rb').read()))
        prev['sites'].update(out); out = prev['sites']; scanned = prev.get('scanned', scanned)
    doc = dict(format='seafloor-casts-v1', source='NOAA NCEI World Ocean Database (noaa-wod-pds, public S3)',
               source_url='https://registry.opendata.aws/noaa-wod/', families=['ctd', 'osd', 'pfl'],
               years=[a.y0, a.y1], radius_km=RADIUS_KM, min_depth_m=MIN_DEPTH_M, keep=KEEP,
               note='In-situ temperature (deg C) and practical salinity as archived; WOD-flagged levels dropped; profiles thinned, never averaged.',
               scanned_files=len(scanned), sites=out)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g: g.write(json.dumps(doc, separators=(',', ':')).encode())
    open(path, 'wb').write(buf.getvalue())
    print('wrote', os.path.relpath(path, ROOT), f'{len(buf.getvalue()) / 1024:.0f} KB')

if __name__ == '__main__':
    main()
