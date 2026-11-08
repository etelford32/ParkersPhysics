"""grid.py — put a decoded GRIB2 lat/lon field into the ONE canonical layout.

CANONICAL: rows run NORTH → SOUTH from `lat0`, columns run EAST from `lon0`
(degrees in [0, 360)), row-major, float32. Everything downstream — tiles, the
JS reader (js/climalytix/point-tile.js), bilinear extraction — assumes it.

The scan-mode flags are the trap. A GRIB2 message may store its points
south-first (jScansPositively = 1), west-going (iScansNegatively = 1) or
column-major (jPointsAreConsecutive = 1). GFS happens to be north-first,
east-going, row-major, so code that ignores the flags passes every GFS test
and then mirrors the first ECMWF/DWD/ERA5 grid that differs — a hemisphere
swap with plausible numbers. The gate therefore checks orientation against
ECCODES' OWN per-point coordinates (an independent implementation), on the
real message AND on a clone with the flag flipped, with the flag-ignoring
version as the negative control.

PURE except for the `eccodes` handle accessors in `from_handle`.
"""

from __future__ import annotations

import numpy as np

REGULAR = 'regular_ll'


def orient(values, *, ni, nj, lat_first, lat_last, lon_first, lon_last,
           i_neg, j_pos, j_consec, ignore_flags=False):
    """Return (field[nj, ni] canonical, meta) from the flat GRIB value array.

    `ignore_flags=True` exists ONLY as the gate's negative control.
    """
    v = np.asarray(values, dtype=np.float64)
    if v.size != ni * nj:
        raise ValueError(f'value count {v.size} != ni*nj {ni * nj}')
    # The negative control models the plausible bug: header coordinates read
    # correctly, scan flags ignored (data assumed north-first, east-going,
    # row-major — which is what GFS happens to be).
    if ignore_flags:
        i_neg = j_pos = j_consec = 0
    grid = v.reshape(ni, nj).T if j_consec else v.reshape(nj, ni)
    if j_pos:
        grid = grid[::-1, :]
    if i_neg:
        grid = grid[:, ::-1]
    lat0 = max(lat_first, lat_last)
    west = lon_last if i_neg else lon_first
    dlat = abs(lat_first - lat_last) / (nj - 1) if nj > 1 else 0.0
    span = (lon_last - lon_first) % 360.0 if not i_neg else (lon_first - lon_last) % 360.0
    dlon = span / (ni - 1) if ni > 1 else 0.0
    meta = {'ni': ni, 'nj': nj, 'lat0': float(lat0), 'dlat': float(dlat),
            'lon0': float(west % 360.0), 'dlon': float(dlon)}
    return np.ascontiguousarray(grid, dtype=np.float32), meta


def cell_coords(meta):
    """(lat[nj], lon[ni]) of the canonical rows/columns."""
    lat = meta['lat0'] - meta['dlat'] * np.arange(meta['nj'])
    lon = (meta['lon0'] + meta['dlon'] * np.arange(meta['ni'])) % 360.0
    return lat, lon


def handle_keys(h, ec):
    """The header keys `orient` needs, read from an eccodes handle."""
    g = lambda k: ec.codes_get(h, k)
    grid_type = g('gridType')
    if grid_type != REGULAR:
        raise ValueError(f'unsupported gridType {grid_type!r} (only {REGULAR})')
    return {
        'ni': int(g('Ni')), 'nj': int(g('Nj')),
        'lat_first': float(g('latitudeOfFirstGridPointInDegrees')),
        'lat_last': float(g('latitudeOfLastGridPointInDegrees')),
        'lon_first': float(g('longitudeOfFirstGridPointInDegrees')),
        'lon_last': float(g('longitudeOfLastGridPointInDegrees')),
        'i_neg': int(g('iScansNegatively')),
        'j_pos': int(g('jScansPositively')),
        'j_consec': int(g('jPointsAreConsecutive')),
    }


def from_handle(h, ec):
    """Decode an eccodes handle to (canonical field, meta). Missing points
    (bitmap) become NaN — never 0."""
    keys = handle_keys(h, ec)
    vals = np.asarray(ec.codes_get_values(h), dtype=np.float64)
    if int(ec.codes_get(h, 'bitmapPresent')):
        missing = float(ec.codes_get(h, 'missingValue'))
        vals = np.where(vals == missing, np.nan, vals)
    return orient(vals, **keys)


def packing_residual(values, *, reference, binary_scale, decimal_scale):
    """Max distance of decoded values from the simple/complex-packing lattice
    Y = (R + X·2^E)·10^(−D), in units of one packing step (should be ~0).

    This is how "decode reproduces the source to packing precision" is
    checked without a second GRIB decoder: every value eccodes hands back must
    sit on the integer lattice the message's own header defines.
    """
    v = np.asarray(values, dtype=np.float64)
    v = v[np.isfinite(v)]
    x = (v * 10.0 ** decimal_scale - reference) / 2.0 ** binary_scale
    return float(np.max(np.abs(x - np.round(x)))) if v.size else 0.0
