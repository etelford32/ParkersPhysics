# assets/temperature — the Planetary Temperature Lab's 1991–2020 normals

Built by `scripts/build-temperature-normals.py` (offline, never deployed) from
ERA5. `js/temperature-normals.js` is the **one** reader, and its header
documents the byte layout. Plan: `PLANETARY_TEMPERATURE_LAB_PLAN.md` §3.1, §4.2,
Phase 1.

| File | Size (raw / deflated) | Content |
|------|------|---------|
| `normals-1991-2020.bin` | 229 / 145 KB | Per cell × {Tmax, Tmin, Tmean}: mean as N=4 annual harmonics, variance as N=2 harmonics of the squared residual. Plus land % and elevation at the cell centre |
| `quantiles-1991-2020.bin` | 981 / 692 KB | Per cell × variable × {p01 p05 p10 p33 p50 p67 p90 p95 p99}: N=3 harmonics fitted to the ±7-day × 30-year windowed quantiles |
| `records-1991-2020.bin` | 2.27 / 1.22 MB | Per cell × variable × pentad: max and min of the ±9-day pool, a superset of every member date's ±7-day pool |
| `hourly-1991-2020.bin` | 182 / 82 KB | Per cell: annual N=3 × diurnal K=2 tensor harmonics of hourly T2m on continuous local solar time. Used by EarthView's anomaly-at-any-hour layer |
| `build-report.json` | — | The measurements below, regenerated with every build |

## Upstream

- **Data:** ERA5 hourly 2 m temperature, 1991-01-01 → 2020-12-31.
  - Taken from WeatherBench2's public mirror (`gs://weatherbench2`, plain
    HTTPS), the 1.5° conservative grid.
  - Sampled at the 2592 cell centres `api/cron/refresh-weather-grid.js` uses:
    72×36 at 5°, from −87.5 / −177.5.
- **Statics:** land fraction and surface geopotential come from WB2's 0.25° ERA5
  statics, nearest to each centre.
- **Licence and attribution:** "Contains modified Copernicus Climate Change
  Service information [1991–2020]." The same line is in every file's header.
  Neither Copernicus nor ECMWF is responsible for any use of it.
- **Period:** 1991–2020, the WMO standard climatological normal. A
  1961–1990 build (the plan's Intro baseline lens) is a later phase.

## What these are — and are not

- **They are a model normal, not an observation.** ERA5 is a reanalysis. Its
  0.25° cell nearest Lytton, BC read **36.8 °C** on the afternoon the station
  read **49.6 °C** (plan §2.7). Nothing built on these files may say "hottest
  place on Earth" or "all-time record".
  - `beyondRecord` means "beyond 1991–2020 in ERA5 for the date at this grid
    point".
  - It is computed against a pool that is a superset of the date's own, so it
    can under-claim a record but never over-claim one.
- **They are 1.5° box means sampled at a point.** The live grid samples a model
  at a point, so the two differ by a representativeness offset.
  - The Phase-0 spike measured that offset: mean |offset| 0.88 K on land (p95
    3.1 K), 0.23 K at sea, 66 % of it static.
  - It is **not** in these files. Every header says so in its
    `representativeness` field, and the correction lands as a v2 asset (plan
    Phase 1b).
- **They are a period mean, not today's expected value.** The climate warmed
  through 1991–2020 and after it. In 2021, 14.8 % of land cell-days (daily Tmean) exceeded the
  1991–2020 p90 (10 % expected, plan §2.3). A busier warm card than cold card
  is the signal, not a bug.

## Measured (build-report.json, 2026-10-06 build)

| Check | Value | Reference |
|---|---|---|
| Area-weighted global mean Tmean normal | **14.387 °C** | C3S 1991–2020: 14.38 °C |
| Quantile curve order, split-half CV RMS at p10 / p50 / p90 (K) | N=2 0.698 / 0.605 / 0.634 · **N=3 0.661 / 0.569 / 0.610** · N=4 0.650 / 0.562 / 0.610 | unsmoothed ±7-day window 0.739 / 0.633 / 0.701 |
| …at the tails, p01 / p99 (K) | N=2 0.970 / 0.826 · **N=3 0.954 / 0.824** · N=4 0.956 / 0.831 | window 1.134 / 0.973 |
| Quantile curves crossing before enforcement | 0.12 % of (cell, var, doy, level) | forced non-decreasing by the reader |
| Record envelope below the p99 curve | 1.2 % of (cell, var, pentad) | widened to the curve by the reader |
| Worst int16 quantisation error of the mean normal | 0.024 K | — |
| Land cells (≥ 50 % at the centre) | 895 of 2592 | — |

How the orders were chosen:
- **Daily mean (N=4) and diurnal cycle (K=2):** chosen in the Phase-0 spike
  (plan §2.1–2.2).
- **Quantile curves (N=3):** chosen by this build's own cross-validation (rows
  above). N=4 gains under 0.01 K in the middle and loses at p01/p99.

## Rebuild

```bash
python -m venv .venv && .venv/bin/pip install -r scripts/temperature_lab_spike/requirements.txt
.venv/bin/python scripts/build-temperature-normals.py --cache <dir>   # ~30 GB streamed once, ~4 min to build
node tests/temperature-normals.mjs
```

- A `scripts/temperature_lab_spike/` data dir is a valid `--cache`.
- The build rewrites the four files, `build-report.json`, and the gate's fixture
  (`tests/fixtures/temperature/normals-check.json`). The fixture is computed from
  the same quantised integers, so commit them together.
