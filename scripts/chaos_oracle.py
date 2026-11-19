#!/usr/bin/env python3
"""chaos_oracle.py — write tests/fixtures/geomag/chaos-oracle.json from ChaosMagPy.

The INDEPENDENT oracle for js/geomag/chaos.js + igrf.js (INNER_EARTH_PLAN.md §5).
ChaosMagPy (DTU's own package) least-squares-fits the order-6 B-spline to the
SHC samples; our kernel uses per-interval Lagrange. Agreement is the gate.

    pip install chaosmagpy==0.16
    python3 -I scripts/chaos_oracle.py <dir holding the three CHAOS-8.1 .shc files>

Never hand-edit the fixture; re-run this script.
"""
import json, sys, os
import numpy as np
import chaosmagpy as cp
from chaosmagpy import coordinate_utils as cu

src = sys.argv[1]
core = cp.CHAOS.from_shc(os.path.join(src, 'CHAOS-8.1_core.shc'))
stat = cp.CHAOS.from_shc(os.path.join(src, 'CHAOS-8.1_static.shc'))
mjd = lambda y: (y - 2000.0) * 365.25   # ChaosMagPy time is MJD2000 (days since 2000-01-01), NOT MJD

# Epochs: on samples, between samples, on/next to breaks, near both ends, and past the data.
years = [1997.15, 1999.30, 2003.137, 2008.55, 2010.0, 2014.3021, 2018.77, 2020.0,
         2023.501, 2024.95, 2025.05, 2025.6, 2026.89]
coef = []
for y in years:
    c = core.synth_coeffs_tdep(mjd(y), nmax=20, extrapolate='linear')
    s = core.synth_coeffs_tdep(mjd(y), nmax=20, deriv=1, extrapolate='linear')  # already nT/yr
    coef.append({'year': y, 'gh': c.tolist(), 'sv': s.tolist()})

rng = np.random.default_rng(81)
pts = [{'theta': float(t), 'phi': float(p)} for t, p in zip(rng.uniform(2, 178, 14), rng.uniform(-180, 180, 14))]
pts += [{'theta': 90.0, 'phi': 0.0}, {'theta': 116.0, 'phi': -50.0}]
field = []
for y in [2001.4, 2015.0, 2026.89]:
    for r in [6371.2, 6371.2 + 500.0, 3480.0]:
        th = np.array([p['theta'] for p in pts]); ph = np.array([p['phi'] for p in pts])
        br, bt, bp = core.synth_values_tdep(mjd(y), r, th, ph, nmax=20, extrapolate='linear')
        dbr, dbt, dbp = core.synth_values_tdep(mjd(y), r, th, ph, nmax=20, deriv=1, extrapolate='linear')
        field.append({'year': y, 'r': r, 'B': np.stack([br, bt, bp], 1).tolist(),
                      'dB': np.stack([dbr, dbt, dbp], 1).tolist()})

# Lithosphere at baked grid nodes: geodetic (lat, lon, h = 0) → geocentric → ChaosMagPy → geodetic Z.
nodes = [(lat, lon) for lat, lon in zip(rng.integers(-89, 90, 30), rng.integers(-180, 181, 30))]
nodes += [(51, 37), (52, 36), (6, 18), (-23, 18), (0, 0), (89, 0), (-89, 120)]
lat = np.array([n[0] for n in nodes], float); lon = np.array([n[1] for n in nodes], float)
radius, theta = cu.gg_to_geo(np.zeros_like(lat), 90.0 - lat)
br, bt, bp = stat.synth_values_static(radius, theta, lon, nmax=185)
_, _, X, Z = cu.geo_to_gg(radius, theta, br, bt)
litho = [{'lat': float(a), 'lon': float(b), 'Z': float(z)} for a, b, z in zip(lat, lon, Z)]

json.dump({'oracle': f'chaosmagpy {cp.__version__}', 'model': 'CHAOS-8.1', 'mjd2000': 'year → (y − 2000)·365.25',
           'order': 'gh: g10,g11,h11,g20,g21,h21,… (ChaosMagPy order); sv nT/yr',
           'coefficients': coef, 'points': pts, 'field': field, 'lithosphere': litho},
          open('tests/fixtures/geomag/chaos-oracle.json', 'w'), separators=(',', ':'))
print('wrote tests/fixtures/geomag/chaos-oracle.json')
