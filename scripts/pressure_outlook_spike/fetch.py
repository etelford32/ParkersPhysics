"""
Pressure-outlook Phase-0 spike — data pull.  See PRESSURE_OUTLOOK_ENGINE_PLAN.md §2.

Pulls mean-sea-level pressure on WeatherBench2's 64x32 (5.625 deg) grid from the
public WB2 bucket (gs://weatherbench2, served over plain HTTPS — no credentials):

  era5.nc      ERA5 6-hourly, 1990-01-01 .. 2021-01-15          (~370 MB)
  clim.nc      ERA5 1990-2019 climatology, 4 hours x 366 days    (~12 MB)
  hres.nc      IFS HRES 00/12Z, 2016-2020, leads 1..10 d daily   (~100 MB)
  ensmean.nc   IFS ENS mean 00/12Z, 2018-2020, leads 1..15 d     (~115 MB)

~45 s total on a fast link. Usage:  python fetch.py [outdir]
Licences: ERA5 = Copernicus licence; IFS HRES/ENS = ECMWF terms (attribution
required) — see plan §8 D5 before shipping anything FITTED on the IFS archives.
"""
import os, sys, time
import numpy as np, xarray as xr, zarr

zarr.config.set({"async.concurrency": 64})
B = "https://storage.googleapis.com/weatherbench2/datasets"
out = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(out, exist_ok=True)
t0 = time.time()
def done(name, da): da.to_netcdf(os.path.join(out, name)); print(f"{name:12s} {da.shape}  {time.time() - t0:5.1f}s", flush=True)

clim = xr.open_zarr(f"{B}/era5-hourly-climatology/1990-2019_6h_64x32_equiangular_conservative.zarr")["mean_sea_level_pressure"]
done("clim.nc", clim.load())

era = xr.open_zarr(f"{B}/era5/1959-2023_01_10-6h-64x32_equiangular_conservative.zarr")["mean_sea_level_pressure"]
done("era5.nc", era.sel(time=slice("1990-01-01", "2021-01-15")).load())

# prediction_timedelta is 6-hourly from 0 h, so index 4k = day k.
hres = xr.open_zarr(f"{B}/hres/2016-2022-0012-64x32_equiangular_conservative.zarr")["mean_sea_level_pressure"]
done("hres.nc", hres.sel(time=slice("2016-01-01", "2020-12-31")).isel(prediction_timedelta=list(range(4, 41, 4))).load())

ens = xr.open_zarr(f"{B}/ifs_ens/2018-2022-64x32_equiangular_conservative_mean.zarr")["mean_sea_level_pressure"]
done("ensmean.nc", ens.sel(time=slice("2018-01-01", "2020-12-31")).isel(prediction_timedelta=list(range(4, 61, 4))).load())
