"""tiles.py — the point-tile archive format (CLIMALYTIX_PLAN.md §17).

A run of a gridded source becomes TIME-MAJOR POINT TILES: the globe is cut
into square tiles of N×N cells, and inside a tile every cell's whole time
series (all variables) is contiguous. One site's forecast is then ONE HTTP
Range request per grid row it needs — two for bilinear — instead of a fetch
per lead time. The reader is js/climalytix/point-tile.js; both sides are
pinned to the same bytes by tests/fixtures/climalytix/tile/ (written by THIS
module, decoded by the JS gate).

LAYOUT (little-endian int16, no header — the run manifest describes it):

    tile (tr, tc) holds canonical rows  tr·N … min(tr·N + N, nj − 1)
                        and columns     tc·N … tc·N + N   (mod ni — WRAPS)
    byte offset of (local row lr, local col lc, var k, time t) =
        2 · (((lr · cols + lc) · nVar + k) · nTime + t)

THE ONE-CELL HALO (N + 1 rows/cols, sharing an edge with the next tile) makes
every 2×2 bilinear stencil live inside ONE tile, and because columns wrap
modulo ni, the stencil across the antimeridian (lon 359.75 → 0.00) is just
the last tile's halo. Row tiles stop where the last stencil starts (row
nj − 2), so the pole row lives in the halo of the tile above it.

QUANTISATION is per variable: stored = round((value − offset) / scale),
NODATA = −32768 is a GAP (never 0), values outside ±32767 steps are CLIPPED
and COUNTED (the manifest reports the count; the gate fails on a silent one).
The stated precision is scale / 2.
"""

from __future__ import annotations

import json

import numpy as np

NODATA = -32768
QMAX = 32767
SCHEMA = 'climalytix.point-tiles.v1'

# The ONE table of what the GFS worker stores. `quantity` is a lab-units key,
# `agg` the SiteSeries aggregation, scale/offset the int16 quantisation in the
# STORED (SI-display) unit. Order is the on-disk var index — append only.
GFS_VARS = [
    {'id': 'tempC',    'grib': ('TMP', '2 m above ground'),     'kind': 'inst', 'unit': 'degC', 'quantity': 'temp',     'agg': 'mean', 'scale': 0.01, 'offset': 0.0,    'convert': 'K_to_C'},
    {'id': 'dewC',     'grib': ('DPT', '2 m above ground'),     'kind': 'inst', 'unit': 'degC', 'quantity': 'temp',     'agg': 'mean', 'scale': 0.01, 'offset': 0.0,    'convert': 'K_to_C'},
    {'id': 'rhPct',    'grib': ('RH', '2 m above ground'),      'kind': 'inst', 'unit': '%',    'quantity': 'pct',      'agg': 'mean', 'scale': 0.01, 'offset': 0.0,    'convert': None},
    {'id': 'uMs',      'grib': ('UGRD', '10 m above ground'),   'kind': 'inst', 'unit': 'm/s',  'quantity': 'wind',     'agg': 'mean', 'scale': 0.01, 'offset': 0.0,    'convert': None},
    {'id': 'vMs',      'grib': ('VGRD', '10 m above ground'),   'kind': 'inst', 'unit': 'm/s',  'quantity': 'wind',     'agg': 'mean', 'scale': 0.01, 'offset': 0.0,    'convert': None},
    {'id': 'gustMs',   'grib': ('GUST', 'surface'),             'kind': 'inst', 'unit': 'm/s',  'quantity': 'wind',     'agg': 'max',  'scale': 0.01, 'offset': 0.0,    'convert': None},
    {'id': 'mslHpa',   'grib': ('PRMSL', 'mean sea level'),     'kind': 'inst', 'unit': 'hPa',  'quantity': 'pressure', 'agg': 'mean', 'scale': 0.01, 'offset': 1000.0, 'convert': 'Pa_to_hPa'},
    {'id': 'precipMm', 'grib': ('APCP', 'surface'),             'kind': 'acc',  'unit': 'mm',   'quantity': 'precip',   'agg': 'sum',  'scale': 0.01, 'offset': 0.0,    'convert': None},
    {'id': 'cloudPct', 'grib': ('TCDC', 'entire atmosphere'),   'kind': 'inst', 'unit': '%',    'quantity': 'pct',      'agg': 'mean', 'scale': 0.01, 'offset': 0.0,    'convert': None},
]


def convert(field, how):
    if how is None:
        return field
    if how == 'K_to_C':
        return field - 273.15
    if how == 'Pa_to_hPa':
        return field / 100.0
    raise ValueError(f'unknown conversion {how!r}')


def quantise(field, scale, offset):
    """float → int16 with NaN → NODATA. Returns (q, clipped_count)."""
    f = np.asarray(field, dtype=np.float64)
    q = np.round((f - offset) / scale)
    finite = np.isfinite(q)
    clipped = int(np.count_nonzero(finite & (np.abs(q) > QMAX)))
    q = np.where(finite, np.clip(q, -QMAX, QMAX), NODATA)
    return q.astype('<i2'), clipped


def dequantise(q, scale, offset):
    q = np.asarray(q)
    return np.where(q == NODATA, np.nan, q.astype(np.float64) * scale + offset)


def tile_grid(nj, ni, n):
    """(tile rows, tile cols). Columns wrap, so ni must divide by n."""
    if ni % n:
        raise ValueError(f'ni={ni} is not a multiple of tile size {n}')
    return -(-(nj - 1) // n), ni // n


def tile_rows_cols(tr, tc, nj, ni, n):
    """Canonical row and column indices held by tile (tr, tc), halo included."""
    r0 = tr * n
    rows = np.arange(r0, min(r0 + n, nj - 1) + 1)
    cols = (tc * n + np.arange(n + 1)) % ni
    return rows, cols


def tile_bytes(cube, tr, tc, n):
    """Bytes of one tile from cube[nj, ni, nVar, nTime] (int16)."""
    nj, ni = cube.shape[:2]
    rows, cols = tile_rows_cols(tr, tc, nj, ni, n)
    return np.ascontiguousarray(cube[rows][:, cols]).astype('<i2', copy=False).tobytes()


def tile_key(prefix, tr, tc):
    return f'{prefix}/t/r{tr:02d}-c{tc:02d}.i16'


def manifest(*, source, grid_id, run_iso, run_ms, meta, n, vars_, times_ms, leads_h,
             prefix, missing, clipped, generator, created_iso, notes=None):
    tr, tc = tile_grid(meta['nj'], meta['ni'], n)
    return {
        'schema': SCHEMA, 'source': source, 'grid': grid_id,
        'run': run_iso, 'runMs': run_ms, 'createdAt': created_iso, 'generator': generator,
        'lat0': meta['lat0'], 'dlat': meta['dlat'], 'lon0': meta['lon0'], 'dlon': meta['dlon'],
        'ni': meta['ni'], 'nj': meta['nj'],
        'tileN': n, 'tileRows': tr, 'tileCols': tc,
        'dtype': '<i2', 'nodata': NODATA, 'layout': 'row,col,var,time',
        'prefix': prefix, 'keyPattern': f'{prefix}/t/r{{tr:02d}}-c{{tc:02d}}.i16',
        'vars': [{k: v[k] for k in ('id', 'unit', 'quantity', 'agg', 'scale', 'offset', 'kind')}
                 | {'grib': ':'.join(v['grib'])} for v in vars_],
        'times': [int(t) for t in times_ms], 'leadsH': [int(h) for h in leads_h],
        'missing': missing, 'clipped': clipped, 'notes': notes or [],
    }


def bilinear(field, meta, lat, lon):
    """Reference bilinear read of a canonical float field — the JS reader's
    oracle in the cross-language fixture. Any NaN corner → NaN (a gap is not
    averaged away)."""
    y = (meta['lat0'] - lat) / meta['dlat']
    x = ((lon - meta['lon0']) % 360.0) / meta['dlon']
    r = min(max(int(np.floor(y)), 0), meta['nj'] - 2)
    c = int(np.floor(x)) % meta['ni']
    fy, fx = y - r, x - np.floor(x)
    c1 = (c + 1) % meta['ni']
    a, b = field[r, c], field[r, c1]
    d, e = field[r + 1, c], field[r + 1, c1]
    return float((1 - fy) * ((1 - fx) * a + fx * b) + fy * ((1 - fx) * d + fx * e))


def dumps(obj):
    return json.dumps(obj, separators=(',', ':'), sort_keys=True)
