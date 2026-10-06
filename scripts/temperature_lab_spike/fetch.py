"""
Planetary Temperature Lab Phase-0 spike — data pull.  See PLANETARY_TEMPERATURE_LAB_PLAN.md §2.

Everything comes from WeatherBench2's public ERA5 mirror (gs://weatherbench2, served over
plain HTTPS, no credentials). 2 m temperature only. Three pulls:

  hourly/YYYY.npy   ERA5 HOURLY on the 1.5 deg (240x121) conservative grid, sampled at the
                    72x36 cell centres EarthView's weather_grid_cache uses (-87.5..87.5 lat,
                    -177.5..177.5 lon, 5 deg), 1991-2021. int16 centi-K above 200 K.
                    (~30 GB streamed, ~1.4 GB kept; the 1.5 deg set ends 2021-12-31.)
  coarse6h.npy      ERA5 6-hourly on the 64x32 (5.625 deg) grid, 1961-2021, int16 as above.
                    Only used for the baseline-shift question (1961-1990 vs 1991-2020).
  snap/*.npy        2021 snapshots at 0.25 deg (1440x721) AND 1.5 deg at the same instants:
                    the 1st and 15th of every month at 00/06/12/18 UTC, plus 2021-06-30T00
                    (the Pacific Northwest heat dome; Lytton BC set Canada's record the
                    afternoon before). Hot-spot dilution + grid representativeness.
  static.npz        land-sea mask + surface geopotential at 1.5 deg and 0.25 deg.

Usage:  python fetch.py [outdir]      (resumable: finished years/slices are skipped)
Licence: ERA5 = Copernicus licence (attribution: "Contains modified Copernicus Climate
Change Service information"). Nothing fitted here ships without that line.
"""
import os, sys, time
import numpy as np, xarray as xr, zarr

zarr.config.set({"async.concurrency": 64})
B = "https://storage.googleapis.com/weatherbench2/datasets"
out = sys.argv[1] if len(sys.argv) > 1 else "data"
for d in ("", "hourly", "snap"):
    os.makedirs(os.path.join(out, d), exist_ok=True)
t0 = time.time()
def log(*a): print(f"[{time.time() - t0:7.1f}s]", *a, flush=True)

# The live grid's cell centres (api/cron/refresh-weather-grid.js LAT_ORIGIN/LON_ORIGIN).
CELL_LAT = -87.5 + 5.0 * np.arange(36)
CELL_LON = -177.5 + 5.0 * np.arange(72)
np.save(os.path.join(out, "cell_lat.npy"), CELL_LAT)
np.save(os.path.join(out, "cell_lon.npy"), CELL_LON)

def to_i16(k):
    """Kelvin -> int16 centi-K above 200 K (0.01 K precision, 527 K ceiling)."""
    return np.round((np.asarray(k, dtype=np.float64) - 200.0) * 100.0).astype(np.int16)

# ── 1. hourly 1.5 deg, sampled at the 72x36 cell centres ─────────────────────
h = xr.open_zarr(f"{B}/era5/1959-2022-1h-240x121_equiangular_with_poles_conservative.zarr")["2m_temperature"]
lat15 = h.latitude.values            # -90 .. 90 ascending
lon15 = h.longitude.values           # 0 .. 358.5
iy = np.array([int(np.argmin(np.abs(lat15 - la))) for la in CELL_LAT])
ix = np.array([int(np.argmin(np.abs(((lon15 - (lo % 360.0)) + 180.0) % 360.0 - 180.0))) for lo in CELL_LON])
np.save(os.path.join(out, "hourly_src_lat.npy"), lat15[iy])
np.save(os.path.join(out, "hourly_src_lon.npy"), lon15[ix])
for year in range(1991, 2022):
    f = os.path.join(out, "hourly", f"{year}.npy")
    if os.path.exists(f):
        continue
    da = h.sel(time=slice(f"{year}-01-01", f"{year}-12-31T23:00")).isel(latitude=iy, longitude=ix)
    arr = da.transpose("time", "latitude", "longitude").values          # (T, 36, 72)
    np.save(f + ".tmp.npy", to_i16(arr)); os.replace(f + ".tmp.npy", f)
    np.save(os.path.join(out, "hourly", f"{year}_time.npy"), da.time.values.astype("datetime64[h]").astype(np.int64))
    log(f"hourly {year} {arr.shape}")

# ── 2. 6-hourly 5.625 deg, 1961-2021 (baseline shift) ────────────────────────
f = os.path.join(out, "coarse6h.npy")
if not os.path.exists(f):
    c = xr.open_zarr(f"{B}/era5/1959-2023_01_10-6h-64x32_equiangular_conservative.zarr")["2m_temperature"]
    c = c.sel(time=slice("1961-01-01", "2021-12-31T18:00")).transpose("time", "latitude", "longitude")
    np.save(os.path.join(out, "coarse6h_time.npy"), c.time.values.astype("datetime64[h]").astype(np.int64))
    np.save(os.path.join(out, "coarse6h_lat.npy"), c.latitude.values)
    np.save(f, to_i16(c.values))
    log(f"coarse6h {c.shape}")

# ── 3. 2021 snapshots at 0.25 deg and 1.5 deg ────────────────────────────────
q = xr.open_zarr(f"{B}/era5/1959-2023_01_10-wb13-6h-1440x721_with_derived_variables.zarr")["2m_temperature"]
np.save(os.path.join(out, "snap_lat025.npy"), q.latitude.values)      # 90 .. -90 DESCENDING
np.save(os.path.join(out, "snap_lon025.npy"), q.longitude.values)
np.save(os.path.join(out, "snap_lat15.npy"), lat15)
np.save(os.path.join(out, "snap_lon15.npy"), lon15)
stamps = [f"2021-{m:02d}-{d:02d}T{hh:02d}:00" for m in range(1, 13) for d in (1, 15) for hh in (0, 6, 12, 18)]
stamps.append("2021-06-30T00:00")
for s in stamps:
    tag = s.replace(":", "").replace("-", "")
    f25, f15 = (os.path.join(out, "snap", f"{tag}_{r}.npy") for r in ("025", "15"))
    if os.path.exists(f25) and os.path.exists(f15):
        continue
    np.save(f25, to_i16(q.sel(time=s).transpose("latitude", "longitude").values))
    np.save(f15, to_i16(h.sel(time=s).transpose("latitude", "longitude").values))
    log(f"snap {s}")

# ── 4. statics: land-sea mask + surface geopotential at both resolutions ─────
f = os.path.join(out, "static.npz")
if not os.path.exists(f):
    s15 = xr.open_zarr(f"{B}/era5/1959-2022-1h-240x121_equiangular_with_poles_conservative.zarr")
    s25 = xr.open_zarr(f"{B}/era5/1959-2023_01_10-wb13-6h-1440x721_with_derived_variables.zarr")
    np.savez(f,
             lsm15=s15["land_sea_mask"].transpose("latitude", "longitude").values,
             z15=s15["geopotential_at_surface"].transpose("latitude", "longitude").values,
             lsm025=s25["land_sea_mask"].transpose("latitude", "longitude").values,
             z025=s25["geopotential_at_surface"].transpose("latitude", "longitude").values)
    log("static")
log("done")
