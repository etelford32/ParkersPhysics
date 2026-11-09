"""
scripts/build-glacier-catalog.py — the GLOBAL glacier catalogue: every glacier in RGI 7.0
═══════════════════════════════════════════════════════════════════════════════════════════
GLACIER_WATCH_PLAN.md §0 "Global catalogue". Offline, never deployed; the outputs are committed
under data/glaciers/catalog/ and read by js/glacier-catalog.js (PURE).

SOURCE. RGI 7.0 (RGI 7.0 Consortium 2023, doi:10.5067/F6JMOVY5NAVZ) is distributed by NSIDC,
which is egress-blocked from the build sandbox. We read the UNOFFICIAL cloud-native mirror
(github.com/lqgentner/rgi-catalog, GeoParquet on Source Cooperative's public S3 bucket, revision
7.0-r2), whose footer records the sha256 of the NSIDC zips it was converted from. Because it is
unofficial, NOTHING IS WRITTEN unless the mirror reproduces the RGI Consortium's OWN published
summary tables EXACTLY — count and rounded area for all 19 first-order and 90 second-order regions
(rgi_user_guide v7.0 appendix CSVs, commit- and sha256-pinned below). Measured 2026-11-08:
274 531 glaciers, 706 744 km², zero mismatches.

WHAT IS WRITTEN (data/glaciers/catalog/):
  rgi7-points.bin.gz   every glacier, ~1.7 MB: centroid (1e-4°, delta-coded), area as
                       (log10 a + 4)·8000 in uint16, median elevation, flags (marine / surge class / same-as-RGI6 /
                       named), second-order region. Columns are DELTA-coded and BYTE-SHUFFLED,
                       which is what gets 274 531 rows under 2 MB (int32 columns alone gzip to
                       2.5 MB). Row i IS RGI2000-v7.0-G-<o1>-<seq>: ids follow row order (checked).
  rgi7-detail-<o1>.json.gz  per first-order region, loaded only when a glacier there is opened:
                       zmin/zmax/zmean (as offsets from the points file's zmed), slope, aspect,
                       max length, terminus point (offset from the centroid, 1e-4°), source year,
                       DEM, hypsometry (50 m bands, ‰, first band as an offset from zmin), the
                       largest-overlap RGI 6.0 id. js/glacier-catalog.js `detailFor` undoes the offsets.
  rgi7-names.json.gz   [index, display_name] for the 9 457 glaciers with a usable name. RGI's own
                       glac_name mostly holds inventory codes ('CN5X046D0034') or 'S/N'; the mirror's
                       cleaned display_name is used and the page says so.
  rgi7-meta.json       provenance (every hash), the official region tables beside the derived
                       statistics, the size-class histogram, file hashes, and the WATCH LINKS:
                       each Glacier Watch glacier joined to the RGI outline that CONTAINS its
                       mid-glacier gauge point (point-in-polygon on the real geometry). Ice-sheet
                       outlets get null with the reason — RGI inventories glaciers OUTSIDE the
                       Greenland and Antarctic ice sheets (region 20 has zero glaciers).

Deterministic: gzip mtime 0, sorted keys. `--check` rebuilds in memory and compares bytes.

Usage: python scripts/build-glacier-catalog.py --parquet PATH [--out data/glaciers/catalog] [--check]
Dependencies: numpy, pyarrow, shapely.
"""
import argparse, base64, collections, gzip, hashlib, io, json, math, os, sys, urllib.request

import numpy as np
import pyarrow.parquet as pq

MIRROR = dict(
    url='https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/lqgentner/rgi/v7.0/glaciers/rgi7.0-glaciers.parquet',
    sha256='f16a6c2d08c87d41dc315540ead570e0bab11b2fd4a70b42a4980d290ca0d016',
    revision='7.0-r2', repo='https://github.com/lqgentner/rgi-catalog')
OFFICIAL_BASE = 'https://raw.githubusercontent.com/GLIMS-RGI/rgi_user_guide/be067b1c1112999fd043045a8f82495ef75f1551/v7.0/docs/appendix/'
OFFICIAL = {
    'o1region': ('RGI2000-v7.0-G-o1region-summary.csv', 'e97cc36d9e930de2dc00ce54e636bff1cae417543af4c47cd19d4b7abc4362d7'),
    'o2region': ('RGI2000-v7.0-G-o2region-summary.csv', 'f4d0f832712aa835b12df4ebf0dc162a31b6f219e442a7b3c5f2ad7177ebe968'),
}
CITATION = ('RGI 7.0 Consortium (2023). Randolph Glacier Inventory: A dataset of global glacier outlines, '
            'Version 7.0. NSIDC: National Snow and Ice Data Center. doi:10.5067/F6JMOVY5NAVZ')
COLS = ['rgi_id', 'o1region', 'o2region', 'cenlon', 'cenlat', 'area_km2', 'surge_type', 'term_type', 'is_rgi6',
        'termlon', 'termlat', 'zmin_m', 'zmax_m', 'zmed_m', 'zmean_m', 'slope_deg', 'aspect_deg', 'lmax_m',
        'display_name', 'src_date', 'dem_source', 'hypso_z0_m', 'hypso_permille', 'rgi6_links', 'bbox']
SIZE_EDGES = [0.01, 0.1, 1, 10, 100, 1000, 10000]      # km²: the size classes the page charts


def sha256(b): return hashlib.sha256(b).hexdigest()


def gz(b):
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode='wb', compresslevel=9, mtime=0) as f: f.write(b)
    return out.getvalue()


def jdump(o): return json.dumps(o, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode()


def http(url):
    with urllib.request.urlopen(url, timeout=120) as r: return r.read()


def shuffle(a):
    """Byte-plane shuffle: all first bytes, then all second bytes … (gzip sees runs of small deltas)."""
    v = np.ascontiguousarray(a).view('u1').reshape(-1, a.dtype.itemsize)
    return b''.join(v[:, i].tobytes() for i in range(a.dtype.itemsize))


def official_tables():
    out = {}
    for key, (name, pin) in OFFICIAL.items():
        raw = http(OFFICIAL_BASE + name)
        if sha256(raw) != pin: sys.exit(f'{name}: sha256 changed — review before re-pinning')
        import csv
        rows = list(csv.DictReader(io.StringIO(raw.decode())))
        out[key] = {r[key]: dict(name=r['full_name'], count=int(r['count']), area_km2=int(r['area_km2'])) for r in rows}
    return out


def validate(t, official):
    """The mirror must reproduce the Consortium's own tables EXACTLY, or nothing is written."""
    problems = []
    for key in ('o1region', 'o2region'):
        c, a = collections.Counter(), collections.defaultdict(float)
        for k, ar in zip(t[key], t['area_km2']): c[k] += 1; a[k] += ar
        for k, ref in official[key].items():
            if k == 'Global':
                if len(t['area_km2']) != ref['count'] or round(sum(t['area_km2'])) != ref['area_km2']:
                    problems.append(f'Global: {len(t["area_km2"])} / {round(sum(t["area_km2"]))} vs {ref}')
                continue
            if c[k] != ref['count'] or round(a[k]) != ref['area_km2']:
                problems.append(f'{key} {k}: {c[k]} / {round(a[k])} vs {ref["count"]} / {ref["area_km2"]}')
        extra = set(c) - set(official[key])
        if extra: problems.append(f'{key}: regions not in the official table {sorted(extra)}')
    return problems


def watch_links(pf, t, index_path):
    """Each Glacier Watch glacier → the RGI 7.0 outline CONTAINING its mid-glacier gauge point."""
    from shapely import wkb
    from shapely.geometry import Point
    idx = json.load(open(index_path))['glaciers']
    summ = {g['id']: g for g in json.load(open(os.path.join(os.path.dirname(index_path), 'summary.json')))['glaciers']}
    bb = t['bbox']
    xmin = np.array([b['xmin'] for b in bb]); xmax = np.array([b['xmax'] for b in bb])
    ymin = np.array([b['ymin'] for b in bb]); ymax = np.array([b['ymax'] for b in bb])
    geom = None
    out = {}
    for g in idx:
        lat, lon = summ[g['id']]['lat'], summ[g['id']]['lon']
        cand = np.where((xmin <= lon) & (xmax >= lon) & (ymin <= lat) & (ymax >= lat))[0]
        hit = None
        if len(cand):
            if geom is None: geom = pq.read_table(pf, columns=['geometry']).column('geometry')
            p = Point(lon, lat)
            for i in cand:
                if wkb.loads(geom[int(i)].as_py()).contains(p): hit = int(i); break
        if hit is not None:
            out[g['id']] = dict(index=hit, rgi_id=t['rgi_id'][hit], area_km2=round(t['area_km2'][hit], 3),
                                at=[round(lat, 5), round(lon, 5)])
        else:
            why = ('part of an ice sheet: RGI 7.0 inventories glaciers outside the Greenland and Antarctic ice sheets'
                   if g['kind'] == 'ice-sheet outlet' else 'no RGI 7.0 outline contains the mid-glacier gauge point')
            out[g['id']] = dict(index=None, rgi_id=None, reason=why, at=[round(lat, 5), round(lon, 5)])
    return out


def build(parquet_path, index_path):
    raw_sha = hashlib.sha256()
    with open(parquet_path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): raw_sha.update(chunk)
    if raw_sha.hexdigest() != MIRROR['sha256']: sys.exit(f'mirror sha256 {raw_sha.hexdigest()} ≠ pinned — review before re-pinning')
    pf = pq.ParquetFile(parquet_path)
    meta = {k.decode(): v.decode() for k, v in (pf.schema_arrow.metadata or {}).items() if k.startswith(b'rgi:')}
    t = pf.read(columns=COLS).to_pydict()
    n = len(t['rgi_id'])
    official = official_tables()
    problems = validate(t, official)
    if problems: sys.exit('mirror does NOT reproduce the official RGI 7.0 tables:\n  ' + '\n  '.join(problems[:20]))
    seq = collections.Counter()
    for i, (r, o1) in enumerate(zip(t['rgi_id'], t['o1region'])):
        seq[o1] += 1
        if r != f'RGI2000-v7.0-G-{o1}-{seq[o1]:05d}': sys.exit(f'row {i}: id {r} does not follow row order')
    o1_codes = sorted(official['o1region'].keys() - {'Global'})
    o2_codes = sorted(official['o2region'].keys() - {'Global'})
    o2_of = {c: i for i, c in enumerate(o2_codes)}

    lon = np.array(t['cenlon']); lat = np.array(t['cenlat']); area = np.array(t['area_km2'])
    lonq = np.round(lon * 1e4).astype('<i4'); latq = np.round(lat * 1e4).astype('<i4')
    # log10 area as uint16 with an offset: (log10 a + 4)·8000 spans 1e-4 … 15 500 km² at 0.0144 % per step.
    # (A signed 1e-4-decade int16 OVERFLOWS above 10^3.28 ≈ 1 900 km² — the largest RGI glacier is
    # 5 261 km² — and silently wrapped 64 000 km² of ice into tiny glaciers: the node gate caught it.)
    loga = np.round((np.log10(area) + 4) * 8000).astype('<u2')
    if loga.min() < 1 or (np.log10(area) + 4).max() * 8000 > 65535: sys.exit('area outside the uint16 log range')
    zmed = np.round(np.array(t['zmed_m'])).astype('<i2')
    named = np.array([1 if d else 0 for d in t['display_name']], 'u1')
    flags = ((np.array(t['term_type']) == 1).astype('u1')
             | (np.array(t['surge_type'], 'u1') << 1)
             | (np.array(t['is_rgi6'], 'u1') << 3)
             | (named << 4)).astype('u1')
    o2 = np.array([o2_of[c] for c in t['o2region']], 'u1')
    d = lambda x: np.diff(x, prepend=np.int32(0)).astype('<i4')
    header = b'RGI7PTS\x02' + np.array([n], '<u4').tobytes() + np.array([6], '<u4').tobytes()
    body = shuffle(d(lonq)) + shuffle(d(latq)) + shuffle(loga) + shuffle(zmed) + flags.tobytes() + o2.tobytes()
    points = gz(header + body)

    # per-o1 detail shards
    shards = {}
    starts = {}
    for o1 in o1_codes:
        ii = [i for i, c in enumerate(t['o1region']) if c == o1]
        if not ii: continue
        starts[o1] = ii[0]
        assert ii == list(range(ii[0], ii[0] + len(ii))), o1
        r = lambda col, f=lambda v: v: [f(t[col][i]) for i in ii]
        rnd = lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else int(round(v))
        def rgi6(i):
            links = t['rgi6_links'][i] or []
            if not links: return None
            return max(links, key=lambda L: L['overlap_area_km2'] or 0)['rgi6_id']
        # elevations and the terminus are stored RELATIVE to what the points file already carries
        # (zmed, centroid at 1e-4°) — small numbers, ~25 % smaller shards, exact on reconstruction
        zm = [int(zmed[i]) for i in ii]
        zmin_ = r('zmin_m', rnd)
        shard = dict(o1=o1, start=ii[0], n=len(ii),
                     dzmin=[m - v for m, v in zip(zm, zmin_)], dzmax=[v - m for m, v in zip(zm, r('zmax_m', rnd))],
                     dzmean=[v - m for m, v in zip(zm, r('zmean_m', rnd))],
                     slope10=r('slope_deg', lambda v: rnd(v * 10)), aspect=r('aspect_deg', rnd), lmax=r('lmax_m', rnd),
                     dterm=[[rnd(t['termlon'][i] * 1e4) - int(lonq[i]), rnd(t['termlat'][i] * 1e4) - int(latq[i])] for i in ii],
                     year=[t['src_date'][i].year if t['src_date'][i] else None for i in ii],
                     dem=r('dem_source'), dz0=[h - v for h, v in zip(r('hypso_z0_m'), zmin_)], hyp=[list(t['hypso_permille'][i] or []) for i in ii],
                     rgi6=[rgi6(i) for i in ii])
        shards[o1] = gz(jdump(shard))

    names = gz(jdump([[i, d_] for i, d_ in enumerate(t['display_name']) if d_]))

    # derived statistics (the page's region table) beside the OFFICIAL ones
    def stats(key, codes):
        out = {}
        for c in codes:
            ii = np.array([i for i, k in enumerate(t[key]) if k == c], int)
            if not len(ii): out[c] = dict(n=0); continue
            big = int(ii[np.argmax(area[ii])])
            out[c] = dict(n=int(len(ii)), area_km2=round(float(area[ii].sum()), 1),
                          largest=dict(index=big, rgi_id=t['rgi_id'][big], name=t['display_name'][big], area_km2=round(float(area[big]), 2)),
                          marine=int((np.array(t['term_type'])[ii] == 1).sum()),
                          surge=[int((np.array(t['surge_type'])[ii] == s).sum()) for s in range(4)],
                          named=int(named[ii].sum()),
                          zmed_median=int(np.median(zmed[ii])))
        return out
    edges = [0] + SIZE_EDGES + [1e9]
    hist = [dict(lo=edges[k], hi=edges[k + 1] if edges[k + 1] < 1e9 else None,
                 n=int(((area >= edges[k]) & (area < edges[k + 1])).sum()),
                 area_km2=round(float(area[(area >= edges[k]) & (area < edges[k + 1])].sum()), 1)) for k in range(len(edges) - 1)]
    links = watch_links(parquet_path, t, index_path)
    files = {'rgi7-points.bin.gz': points, 'rgi7-names.json.gz': names, **{f'rgi7-detail-{o1}.json.gz': b for o1, b in shards.items()}}
    meta_out = dict(
        format='glacier-catalog-rgi7-v1', citation=CITATION,
        source=dict(mirror=MIRROR, mirror_footer=meta, official_tables={k: OFFICIAL_BASE + v[0] for k, v in OFFICIAL.items()},
                    validated='count and rounded area reproduce the RGI Consortium tables for every o1 and o2 region',
                    names='display_name as cleaned by the mirror from RGI glac_name (which holds inventory codes and "S/N")'),
        n=n, area_km2=round(float(area.sum()), 1),
        points=dict(file='rgi7-points.bin.gz', columns=['lon_e4_delta:i32', 'lat_e4_delta:i32', 'log10area_plus4_x8000:u16', 'zmed_m:i16', 'flags:u8', 'o2:u8'],
                    flags='bit0 marine-terminating · bits1-2 surge evidence 0-3 · bit3 same outline as RGI 6.0 · bit4 has a name',
                    quantisation='centroid 1e-4° (≤ 11 m), area (log10 a + 4)·8000 (0.0144 %), zmed 1 m'),
        o1=o1_codes, o2=o2_codes, starts=starts,
        official=official, derived=dict(o1=stats('o1region', o1_codes), o2=stats('o2region', o2_codes)),
        size_classes=hist, watch_links=links,
        files={k: dict(bytes=len(v), sha256=sha256(v)) for k, v in sorted(files.items())},
        hypsometry_band_m=50, aspect_note='degrees clockwise from north', slope_note='slope10 = slope in tenths of a degree',
        term_type_note='RGI 7.0 assigns only the marine-terminating class; every other glacier is "not assigned", not land-terminating',
        surge_classes=['no evidence', 'possible', 'probable', 'observed'])
    files['rgi7-meta.json'] = json.dumps(meta_out, ensure_ascii=False, indent=1, sort_keys=True).encode() + b'\n'
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parquet', required=True, help='local copy of the mirror (download MIRROR["url"])')
    ap.add_argument('--out', default='data/glaciers/catalog'); ap.add_argument('--index', default='data/glaciers/glaciers.json')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    files = build(a.parquet, a.index)
    if a.check:
        bad = [k for k, v in files.items() if not os.path.exists(os.path.join(a.out, k)) or open(os.path.join(a.out, k), 'rb').read() != v]
        if bad: sys.exit('catalog drifted from the mirror: ' + ', '.join(bad))
        print('catalog matches the mirror'); return
    os.makedirs(a.out, exist_ok=True)
    for k, v in files.items(): open(os.path.join(a.out, k), 'wb').write(v)
    total = sum(len(v) for v in files.values())
    for k, v in sorted(files.items()): print(f'{k:28s} {len(v) / 1024:9.1f} KB')
    print(f'total {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
