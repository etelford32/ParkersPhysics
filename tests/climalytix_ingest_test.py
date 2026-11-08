#!/usr/bin/env python3
"""climalytix_ingest_test.py — gate for scripts/climalytix_ingest/ (P-1).

    python3 tests/climalytix_ingest_test.py            # run the gate
    python3 tests/climalytix_ingest_test.py --write    # (re)write the tile fixture

Every fixture under tests/fixtures/climalytix/gfs/ is a REAL NOAA file (GFS
2026-11-07 00z, fetched 2026-11-08 from noaa-gfs-bdp-pds): seven .idx
sidecars and one 1.00° TMP 2 m message. Never hand-edit them. The tile
fixture under tests/fixtures/climalytix/tile/ is WRITTEN by tiles.py from that
message and DECODED by tests/climalytix-point-tile.mjs — the two languages are
pinned to the same bytes. Each check that guards a silent failure carries its
negative control.
"""

import gzip
import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts' / 'climalytix_ingest'))

import grid as G      # noqa: E402
import idx as I       # noqa: E402
import tiles as T     # noqa: E402

FIX = ROOT / 'tests' / 'fixtures' / 'climalytix'
GFS = FIX / 'gfs'
TILE = FIX / 'tile'
MSG = GFS / 'gfs.20261107.t00z.1p00.f006.TMP-2m.grib2'

passed = 0


def ok(name):
    def wrap(fn):
        global passed
        fn()
        passed += 1
        print(f'  ✓ {name}')
        return fn
    return wrap


def idx_text(lead, grid='0p25'):
    return gzip.decompress((GFS / f'gfs.t00z.pgrb2.{grid}.f{lead:03d}.idx.gz').read_bytes()).decode()


print('climalytix ingest (python)')


@ok('idx: the real offsets, and a range is exactly one stored message')
def _():
    e25 = I.parse_idx(idx_text(6))
    tmp = I.find_instant(e25, 'TMP', '2 m above ground', 6)
    assert tmp['offset'] == 411290056, tmp
    assert tmp['end'] == next(e['offset'] for e in e25 if e['n'] == '582'), 'end = next message offset'
    e1 = I.parse_idx(idx_text(6, '1p00'))
    tmp1 = I.find_instant(e1, 'TMP', '2 m above ground', 6)
    assert tmp1['offset'] == 34479317, tmp1
    assert tmp1['end'] - tmp1['offset'] == MSG.stat().st_size, 'the range is exactly the stored message'
    # Negative control: reading one byte past the next offset is NOT the message.
    assert tmp1['end'] + 1 - tmp1['offset'] != MSG.stat().st_size
    assert e25[-1]['end'] is None and I.range_header(10, None) == 'bytes=10-'
    assert I.range_header(10, 20) == 'bytes=10-19'


@ok('idx: instantaneous vs bucket-average fields are told apart; f000 is the analysis')
def _():
    e = I.parse_idx(idx_text(6))
    tc = I.find_instant(e, 'TCDC', 'entire atmosphere', 6)
    assert tc['fcst'] == '6 hour fcst', tc
    first = next(x for x in e if x['var'] == 'TCDC' and x['level'] == 'entire atmosphere')
    assert first is tc, 'on THIS file the instant happens to come first…'
    later = [x for x in e if x['var'] == 'TCDC' and x['level'] == 'entire atmosphere'][1]
    assert later['fcst'] == '0-6 hour ave fcst', '…and the average is the other one'
    assert I.find_instant(I.parse_idx(idx_text(0)), 'TMP', '2 m above ground', 0)['fcst'] == 'anl'
    assert I.find_instant(I.parse_idx(idx_text(0)), 'APCP', 'surface', 0) is None


@ok('idx: precipitation de-accumulation plan across the real reset buckets')
def _():
    def plan(L):
        p = I.plan_accumulation(I.parse_idx(idx_text(L)), 'APCP', 'surface', L, 3)
        return p and (p['take'], p['minus'])
    assert plan(0) is None
    assert plan(3) == ((0, 3), None)
    assert plan(6) == ((0, 6), (0, 3))
    assert plan(9) == ((6, 9), None), 'f009 carries 6-9 AND 0-9: the latest start wins'
    assert plan(12) == ((6, 12), (6, 9))
    assert plan(237) == ((234, 237), None)
    assert plan(240) == ((234, 240), (234, 237)), 'the 0-10 day window is ignored'
    # Negative control: first APCP match at f012 is a 6-hour window, not 3.
    first = next(x for x in I.parse_idx(idx_text(12)) if x['var'] == 'APCP')
    assert I.describe(first['fcst'])[1:] == (6, 12)
    assert I.describe('0-10 day acc fcst') == ('acc', 0, 240)


@ok('idx: touching messages merge into one range request')
def _():
    e = I.parse_idx(idx_text(6))
    dpt = I.find_instant(e, 'DPT', '2 m above ground', 6)
    rh = I.find_instant(e, 'RH', '2 m above ground', 6)
    tmp = I.find_instant(e, 'TMP', '2 m above ground', 6)
    r = I.merge_ranges([rh, tmp, dpt])
    assert [(s, len(m)) for s, _, m in r] == [(tmp['offset'], 1), (dpt['offset'], 2)]
    assert r[1][1] == rh['end']


def load_message():
    import eccodes as ec
    h = ec.codes_new_from_message(MSG.read_bytes())
    return ec, h


@ok('decode: every value sits on the message’s own packing lattice')
def _():
    ec, h = load_message()
    vals = ec.codes_get_values(h)
    res = G.packing_residual(vals, reference=ec.codes_get(h, 'referenceValue'),
                             binary_scale=ec.codes_get(h, 'binaryScaleFactor'),
                             decimal_scale=ec.codes_get(h, 'decimalScaleFactor'))
    assert res < 1e-6, res
    # Negative control: a value nudged by a quarter step leaves the lattice.
    bad = G.packing_residual(vals + 0.0025, reference=ec.codes_get(h, 'referenceValue'),
                             binary_scale=ec.codes_get(h, 'binaryScaleFactor'),
                             decimal_scale=ec.codes_get(h, 'decimalScaleFactor'))
    assert bad > 0.2, bad
    assert 200 < vals.min() and vals.max() < 330, 'a real 2 m temperature field in K'


def eccodes_truth(ec, h):
    """{(lat, lon) → value} from eccodes' OWN coordinate arrays."""
    lats = np.round(ec.codes_get_array(h, 'latitudes'), 6)
    lons = np.round(ec.codes_get_array(h, 'longitudes') % 360.0, 6)
    vals = ec.codes_get_values(h)
    return {(la, lo): v for la, lo, v in zip(lats, lons, vals)}


def check_orientation(ec, h, ignore_flags=False):
    field, meta = G.orient(ec.codes_get_values(h), **G.handle_keys(h, ec), ignore_flags=ignore_flags)
    truth = eccodes_truth(ec, h)
    lat, lon = G.cell_coords(meta)
    bad = 0
    for r in range(0, meta['nj'], 7):
        for c in range(0, meta['ni'], 11):
            v = truth.get((round(lat[r], 6), round(lon[c], 6)))   # no such point = misplaced
            if v is None or abs(v - field[r, c]) > 1e-3:
                bad += 1
    return bad, field, meta


def reshaped(ec, h, *, south_first=False, west_going=False, column_major=False):
    """A clone of the real message whose STORAGE order differs but whose
    physical field (value at each lat/lon) is the same."""
    field, meta = G.orient(ec.codes_get_values(h), **G.handle_keys(h, ec))
    g = field
    if south_first:
        g = g[::-1, :]
    if west_going:
        g = g[:, ::-1]
    flat = g.T.ravel() if column_major else g.ravel()
    c = ec.codes_clone(h)
    ec.codes_set(c, 'packingType', 'grid_simple')
    lat_n, lat_s = meta['lat0'], meta['lat0'] - meta['dlat'] * (meta['nj'] - 1)
    lon_w, lon_e = meta['lon0'], meta['lon0'] + meta['dlon'] * (meta['ni'] - 1)
    ec.codes_set(c, 'jScansPositively', int(south_first))
    ec.codes_set(c, 'iScansNegatively', int(west_going))
    ec.codes_set(c, 'jPointsAreConsecutive', int(column_major))
    ec.codes_set(c, 'latitudeOfFirstGridPointInDegrees', lat_s if south_first else lat_n)
    ec.codes_set(c, 'latitudeOfLastGridPointInDegrees', lat_n if south_first else lat_s)
    ec.codes_set(c, 'longitudeOfFirstGridPointInDegrees', lon_e if west_going else lon_w)
    ec.codes_set(c, 'longitudeOfLastGridPointInDegrees', lon_w if west_going else lon_e)
    ec.codes_set_values(c, flat.astype(np.float64))
    return c, field


@ok('orientation: canonical cells match eccodes’ own coordinates under every scan mode')
def _():
    ec, h = load_message()
    bad, field0, _ = check_orientation(ec, h)
    assert bad == 0, bad
    for mode in ({'south_first': True}, {'west_going': True}, {'column_major': True},
                 {'south_first': True, 'west_going': True, 'column_major': True}):
        c, ref = reshaped(ec, h, **mode)
        bad, field, meta = check_orientation(ec, c)
        assert bad == 0, (mode, bad)
        assert meta['lat0'] == 90.0 and meta['lon0'] == 0.0, (mode, meta)
        assert np.max(np.abs(field - ref)) < 0.01, f'{mode}: same physical field, same canonical grid'
        # Negative control: ignoring the scan flags misplaces the field.
        bad_ctl, _, _ = check_orientation(ec, c, ignore_flags=True)
        assert bad_ctl > 100, (mode, 'the flag-ignoring reader must fail', bad_ctl)


@ok('tiles: quantised round trip is exact to scale/2; gaps stay gaps; clipping is counted')
def _():
    rng = np.random.default_rng(7)
    f = rng.normal(10, 15, (9, 12))
    f[3, 4] = np.nan
    q, clipped = T.quantise(f, 0.01, 0.0)
    back = T.dequantise(q, 0.01, 0.0)
    fin = np.isfinite(f)
    assert np.max(np.abs(back[fin] - f[fin])) <= 0.005 + 1e-12
    assert np.isnan(back[3, 4]) and q[3, 4] == T.NODATA and clipped == 0
    _, c2 = T.quantise(np.array([400.0, -400.0, 1.0]), 0.01, 0.0)
    assert c2 == 2, 'out-of-range values are counted, never silently wrapped'
    q0, _ = T.quantise(np.array([0.0]), 0.01, 0.0)
    assert q0[0] == 0 and q0[0] != T.NODATA, 'zero is a value, not a gap'


def tile_cube(field_c):
    """The cross-language fixture cube: 3 vars × 4 times on the real 1° grid.
    var0 = real 2 m temperature (°C) + t, var1 = row index + t/4, var2 = column
    index — so a layout error in the reader shows up as a wrong ROW or COLUMN,
    not as a plausible temperature."""
    nj, ni = field_c.shape
    rows = np.broadcast_to(np.arange(nj)[:, None], (nj, ni)).astype(float)
    cols = np.broadcast_to(np.arange(ni)[None, :], (nj, ni)).astype(float)
    spec = [('tempC', 0.01, 0.0), ('row', 0.25, 0.0), ('col', 1.0, 0.0)]
    cube = np.empty((nj, ni, 3, 4), dtype='<i2')
    deq = np.empty((nj, ni, 3, 4))
    for t in range(4):
        for k, (vid, s, o) in enumerate(spec):
            src = field_c + t if k == 0 else rows + t / 4 if k == 1 else cols
            if k == 0 and t == 3:
                src = src.copy()
                src[60, 100] = np.nan      # one planted gap
            q, _ = T.quantise(src, s, o)
            cube[:, :, k, t] = q
            deq[:, :, k, t] = T.dequantise(q, s, o)
    return spec, cube, deq


POINTS = [
    {'name': 'Boulder', 'lat': 40.015, 'lon': -105.27},
    # The grid runs 0..359°E, so its SEAM is Greenwich (359 → 0), not the
    # dateline — the dateline is mid-grid and the pair there must just agree.
    {'name': 'dateline west side', 'lat': -17.7, 'lon': 179.6},
    {'name': 'dateline east side', 'lat': -17.7, 'lon': -179.6},
    {'name': 'seam west side (Greenwich −0.4°)', 'lat': 51.48, 'lon': -0.4},
    {'name': 'seam east side (Greenwich +0.4°)', 'lat': 51.48, 'lon': 0.4},
    {'name': 'exact node', 'lat': 10.0, 'lon': 20.0},
    {'name': 'South Pole', 'lat': -90.0, 'lon': 0.0},
    {'name': 'North Pole', 'lat': 90.0, 'lon': 123.0},
    {'name': 'next to the planted gap', 'lat': 29.5, 'lon': 100.5},
]


def build_tile_fixture():
    import eccodes as ec
    _, h = load_message()
    field, meta = G.from_handle(h, ec)
    spec, cube, deq = tile_cube(field - 273.15)
    n = 20
    files = {}
    expected = []
    for p in POINTS:
        lon = p['lon'] % 360.0
        y = (meta['lat0'] - p['lat']) / meta['dlat']
        x = ((lon - meta['lon0']) % 360.0) / meta['dlon']
        r = min(max(int(np.floor(y)), 0), meta['nj'] - 2)
        c = int(np.floor(x)) % meta['ni']
        tr, tc = r // n, c // n
        files.setdefault((tr, tc), T.tile_bytes(cube, tr, tc, n))
        vals = [[T.bilinear(deq[:, :, k, t], meta, p['lat'], lon) for t in range(4)] for k in range(3)]
        expected.append(p | {'tile': [tr, tc],
                             'values': [[None if np.isnan(v) else round(v, 9) for v in row] for row in vals]})
    man = T.manifest(source='gfs-fixture', grid_id='1p00', run_iso='2026-11-07T00:00Z',
                     run_ms=1_794_009_600_000, meta=meta, n=n,
                     vars_=[{'id': vid, 'unit': '-', 'quantity': 'index', 'agg': 'mean', 'scale': s,
                             'offset': o, 'kind': 'inst', 'grib': ('-', '-')} for vid, s, o in spec],
                     times_ms=[1_794_009_600_000 + 3_600_000 * 3 * t for t in range(4)],
                     leads_h=[0, 3, 6, 9], prefix='fixture', missing=[], clipped={},
                     generator='tests/climalytix_ingest_test.py', created_iso='2026-11-08T00:00:00Z')
    node = (90 - 10) * 1 // 1, 20
    truth_k = float(eccodes_truth(ec, h)[(10.0, 20.0)]) - 273.15
    return man, files, expected, {'nodeTempC': round(truth_k, 6), 'nodeRowCol': list(node)}


@ok('tile fixture: the committed bytes are exactly what tiles.py writes today')
def _():
    man, files, expected, extra = build_tile_fixture()
    if '--write' in sys.argv:
        TILE.mkdir(parents=True, exist_ok=True)
        for old in TILE.glob('*.i16'):
            old.unlink()
        for (tr, tc), b in files.items():
            (TILE / f'r{tr:02d}-c{tc:02d}.i16').write_bytes(b)
        (TILE / 'manifest.json').write_text(json.dumps(man, indent=1, sort_keys=True) + '\n')
        (TILE / 'expected.json').write_text(json.dumps({'points': expected, **extra}, indent=1) + '\n')
        print('    (fixture written)')
    for (tr, tc), b in files.items():
        assert (TILE / f'r{tr:02d}-c{tc:02d}.i16').read_bytes() == b, f'tile r{tr}-c{tc} drifted'
    assert json.loads((TILE / 'manifest.json').read_text()) == json.loads(json.dumps(man))
    got = json.loads((TILE / 'expected.json').read_text())
    assert got['points'] == json.loads(json.dumps(expected))
    # The node value through the tiles is eccodes' value to the stated precision.
    p = next(e for e in expected if e['name'] == 'exact node')
    assert abs(p['values'][0][0] - extra['nodeTempC']) <= 0.005 + 1e-9, (p['values'][0][0], extra)
    # The two sides of the grid's seam are read from DIFFERENT tiles (the west
    # one through the wrapped halo) and still form one continuous field.
    def by(n):
        return next(e for e in expected if e['name'].startswith(n))
    w, e_ = by('seam west'), by('seam east')
    assert w['tile'] == [1, 17] and e_['tile'] == [1, 0], (w['tile'], e_['tile'])
    for k in (0, 1):
        assert abs(w['values'][k][0] - e_['values'][k][0]) < 3, (k, 'neighbours 0.8° apart')
    assert abs(by('dateline west')['values'][0][0] - by('dateline east')['values'][0][0]) < 3
    gap = next(e for e in expected if e['name'] == 'next to the planted gap')
    assert gap['values'][0][3] is None and gap['values'][0][2] is not None, 'a gap corner is a gap'


@ok('tiles: every halo stencil — including the seam column — lives in one tile')
def _():
    nj, ni, n = 181, 360, 20
    trs, tcs = T.tile_grid(nj, ni, n)
    assert (trs, tcs) == (9, 18)
    rows, cols = T.tile_rows_cols(trs - 1, tcs - 1, nj, ni, n)
    assert rows[-1] == nj - 1 and cols[-1] == 0, 'last tile row reaches the pole; last column wraps to 0'
    for r in (0, 19, 20, nj - 2):
        for c in (0, 19, 20, ni - 1):
            rr, cc = T.tile_rows_cols(r // n, c // n, nj, ni, n)
            assert r + 1 in rr and (c + 1) % ni in cc, (r, c)
    try:
        T.tile_grid(721, 1441, 20)
        raise AssertionError('a non-dividing tile size must be refused')
    except ValueError:
        pass


print(f'\n{passed} passed')
