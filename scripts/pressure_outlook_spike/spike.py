"""
Pressure-outlook engine -- Phase-0 spike.  Numbers quoted in PRESSURE_OUTLOOK_ENGINE_PLAN.md §2.

MSLP on WeatherBench2's 64x32 (5.625 deg) grid; truth = ERA5; test year = 2020, 00/12Z inits.
That is the WB2 evaluation protocol ON PURPOSE: the climatology / persistence / IFS-HRES-raw /
IFS-ENS-mean-raw rows must reproduce WB2's published benchmark_results to ~0.01 hPa, and did
(2026-09-24). If they stop matching, the harness is broken — fix that before reading any other row.

  python fetch.py data/ && python spike.py data/        (~4 min on 4 cores, ~6 GB RAM)

Writes spike_results.json next to the data. Two things below are load-bearing and were each a bug
while writing this: the per-EOF slope is BOUNDED to [0, 1.1] (fitted from a handful of samples,
the smallest scales have ~zero forecast variance and the unbounded slope exploded — a 2.6x RMSE
blow-up in the cold-start run), and inits with ANY NaN are dropped (IFS ENS 2019-10-17).
"""
import json, os, sys, time, numpy as np, xarray as xr, pandas as pd
T0 = time.time()
DATA = sys.argv[1] if len(sys.argv) > 1 else "."
os.chdir(DATA)
era  = xr.open_dataarray("era5.nc").transpose("time", "latitude", "longitude")
clim = xr.open_dataarray("clim.nc").transpose("hour", "dayofyear", "latitude", "longitude")
lat, lon = era.latitude.values, era.longitude.values
nlat, nlon = len(lat), len(lon)
w = np.cos(np.deg2rad(lat)); w = w / w.mean()
W2 = np.broadcast_to(w[:, None], (nlat, nlon)).copy()
sw = np.sqrt(W2).ravel()
times = pd.DatetimeIndex(era.time.values)
tpos = {t: i for i, t in enumerate(times)}
X = era.values.astype(np.float64) / 100.0
C = clim.values.astype(np.float64) / 100.0
HIDX = {0: 0, 6: 1, 12: 2, 18: 3}
def clim_at(ts):
    ts = pd.DatetimeIndex(ts); return C[[HIDX[h] for h in ts.hour], ts.dayofyear.values - 1]
A = X - clim_at(times)

REGIONS = {
  "global": np.ones((nlat, nlon), bool),
  "NH-extratropics": np.broadcast_to((lat >= 20)[:, None], (nlat, nlon)),
  "tropics": np.broadcast_to((np.abs(lat) < 20)[:, None], (nlat, nlon)),
  "SH-extratropics": np.broadcast_to((lat <= -20)[:, None], (nlat, nlon)),
  "north-america": ((lat >= 25) & (lat <= 60))[:, None] & ((lon >= 240) & (lon <= 285))[None, :],
  "europe": ((lat >= 35) & (lat <= 75))[:, None] & ((lon >= 347.5) | (lon <= 42.5))[None, :],
}
def wrmse(err, region="global"):
    m = REGIONS[region]; ww = W2 * m
    return float(np.sqrt((err**2 * ww).sum() / (ww.sum() * err.shape[0])))

res = {}
def put(tab, name, L, v): res.setdefault(tab, {}).setdefault(name, {})[str(L)] = round(float(v), 3)

test_inits = np.array([tpos[t] for t in times if t.year == 2020 and t.hour in (0, 12)])
LEADS = list(range(1, 16))

# ---------------------------------------------------------------- EOF basis (1990-2015 ERA5 anomalies)
tr_hist = np.array([i for i, t in enumerate(times) if 1990 <= t.year <= 2015 and t.hour in (0, 12)])
_, _, Vt = np.linalg.svd((A[tr_hist].reshape(len(tr_hist), -1) * sw)[::2], full_matrices=False)
def to_pc(a, E=Vt):  return (a.reshape(a.shape[0], -1) * sw) @ E.T
def from_pc(p, E=Vt): return ((p @ E) / sw).reshape(-1, nlat, nlon)

# ---------------------------------------------------------------- E0/E1/E2: no NWP input
K, LAG = 80, 4
def hist_feats(idx): return np.hstack([to_pc(A[idx], Vt[:K]), to_pc(A[idx - LAG], Vt[:K]), np.ones((len(idx), 1))])
F_tr = hist_feats(tr_hist[tr_hist > LAG]); tr_ok = tr_hist[tr_hist > LAG]
HIST_B = {}
for L in LEADS:
    s = 4 * L
    put("global", "climatology", L, wrmse(A[test_inits + s]))
    put("global", "persistence", L, wrmse(X[test_inits] - X[test_inits + s]))
    a0, a1 = A[tr_hist], A[tr_hist + s]
    r = (a0 * a1).sum((0, 2)) / (a0 * a0).sum((0, 2))
    put("global", "damped anomaly persistence", L, wrmse(A[test_inits + s] - r[None, :, None] * A[test_inits]))
    Y = to_pc(A[tr_ok + s], Vt[:K]); lam = 1e-2 * np.trace(F_tr.T @ F_tr) / F_tr.shape[1]
    HIST_B[L] = np.linalg.solve(F_tr.T @ F_tr + lam * np.eye(F_tr.shape[1]), F_tr.T @ Y)
    put("global", "history-only ML (EOF ridge)", L, wrmse(A[test_inits + s] - from_pc(hist_feats(test_inits) @ HIST_B[L], Vt[:K])))
def hist_model(idx, L): return from_pc(hist_feats(idx) @ HIST_B[L], Vt[:K])

# ---------------------------------------------------------------- NWP loaders
def load_nwp(path):
    da = xr.open_dataarray(path).transpose("time", "prediction_timedelta", "latitude", "longitude")
    pt = da.prediction_timedelta.values
    leads = (pt // 24 if np.issubdtype(pt.dtype, np.integer) else (pt / np.timedelta64(1, "h")).astype(int) // 24).astype(int)
    ts = pd.DatetimeIndex(da.time.values)
    vals = da.values
    ok = np.array([t in tpos for t in ts]) & ~np.isnan(vals).any(axis=(1, 2, 3))
    return ts[ok], vals[ok].astype(np.float64) / 100.0, list(leads)

def fit_row_mos(xa, ya, n0=0.0):
    """per-latitude-row  y = a + b x,  ridge prior (a=0, b=1) worth n0 pseudo-fields."""
    n = xa.shape[0] * nlon
    Sx, Sy = xa.sum((0, 2)), ya.sum((0, 2)); Sxx = (xa * xa).sum((0, 2)); Sxy = (xa * ya).sum((0, 2))
    v = Sxx / max(n, 1); pn = n0 * nlon
    mx, my = Sx / (n + pn), Sy / (n + pn)
    b = np.clip((Sxy - n * mx * my + pn * v * 1.0) / (Sxx - n * mx * mx + pn * v + 1e-12), 0.0, 1.1)
    a = my - b * mx
    return a, b
def apply_row(a, b, xa): return a[None, :, None] + b[None, :, None] * xa

B_MIN, B_MAX = 0.0, 1.1          # MOS may damp a scale, never amplify it by more than 10 %
def fit_eof_mos(xa, ya, n0=0.0, wts=None):
    """bias field + per-EOF slope (scale-selective damping), prior b=1 worth n0 fields."""
    wts = np.ones(xa.shape[0]) if wts is None else wts
    n = wts.sum()
    bias = ((xa - ya) * wts[:, None, None]).sum(0) / (n + n0)
    pf, pt = to_pc(xa - bias), to_pc(ya)
    Sff = (wts[:, None] * pf * pf).sum(0); Sft = (wts[:, None] * pf * pt).sum(0)
    v = Sff / max(n, 1e-9)
    bk = (Sft + n0 * v) / (Sff + n0 * v + 1e-12)
    return bias, np.clip(bk, B_MIN, B_MAX)
def apply_eof(bias, bk, xa): return from_pc(to_pc(xa - bias) * bk)

def gauss_crps(mu, sig, y):
    from scipy.stats import norm
    z = (y - mu) / sig
    return sig * (z * (2 * norm.cdf(z) - 1) + 2 * norm.pdf(z) - 1 / np.sqrt(np.pi))

def nwp_block(tag, path, train_years, extra_hist=False):
    ts, F, leads = load_nwp(path)
    pos = np.array([tpos[t] for t in ts])
    tr = np.isin(ts.year, train_years); te = ts.year == 2020
    out = {}
    for j, L in enumerate(leads):
        s = 4 * L
        if (pos + s).max() >= len(times): continue
        Fa = F[:, j] - clim_at(times[pos + s]); Ta = A[pos + s]
        raw = Fa[te]; truth = Ta[te]
        a, b = fit_row_mos(Fa[tr], Ta[tr]); rowf = apply_row(a, b, raw)
        bias, bk = fit_eof_mos(Fa[tr], Ta[tr]); eoff = apply_eof(bias, bk, raw)
        for reg in REGIONS:
            put(reg, f"{tag} raw", L, wrmse(raw - truth, reg))
            put(reg, f"{tag} + EOF-scale MOS", L, wrmse(eoff - truth, reg))
        put("global", f"{tag} + row MOS", L, wrmse(rowf - truth))
        res.setdefault("slopes", {}).setdefault(tag, {})[str(L)] = round(float(np.average(b, weights=w)), 3)
        if extra_hist:
            hm = hist_model(pos, L)
            ph_tr, ph_te = to_pc(hm[tr]), to_pc(hm[te])
            pf_tr, pf_te, pt_tr = to_pc(Fa[tr] - bias), to_pc(raw - bias), to_pc(Ta[tr])
            c = np.zeros((2, pf_tr.shape[1]))
            for k in range(pf_tr.shape[1]):
                Z = np.stack([pf_tr[:, k], ph_tr[:, k]], 1)
                c[:, k] = np.linalg.solve(Z.T @ Z + 1e-6 * np.trace(Z.T @ Z) * np.eye(2), Z.T @ pt_tr[:, k])
            put("global", f"{tag} + EOF MOS + history-only ML", L, wrmse(from_pc(pf_te * c[0] + ph_te * c[1]) - truth))
        # calibration: Gaussian around EOF-MOS mean, sigma(L, lat) from training residuals
        rtr = apply_eof(bias, bk, Fa[tr]) - Ta[tr]
        sig = np.sqrt((rtr**2).mean((0, 2)))[None, :, None]
        lo, hi = eoff - 1.2816 * sig, eoff + 1.2816 * sig
        cover = float((((truth >= lo) & (truth <= hi)) * W2).sum() / (W2.sum() * truth.shape[0]))
        crps_m = float((gauss_crps(eoff, sig, truth) * W2).sum() / (W2.sum() * truth.shape[0]))
        sc = np.sqrt((A[pos[tr] + s]**2).mean((0, 2)))[None, :, None]
        crps_c = float((gauss_crps(np.zeros_like(truth), sc, truth) * W2).sum() / (W2.sum() * truth.shape[0]))
        res.setdefault("calibration", {}).setdefault(tag, {})[str(L)] = dict(cover80=round(cover, 3), crps=round(crps_m, 3), crps_clim=round(crps_c, 3), crpss=round(1 - crps_m / crps_c, 3))
        out[L] = (ts, pos, Fa, Ta)
    return out

hres = nwp_block("IFS HRES", "hres.nc", [2016, 2017, 2018, 2019], extra_hist=True)
ens  = nwp_block("IFS ENS mean", "ensmean.nc", [2018, 2019])
print("blocks done %.0fs" % (time.time() - T0), flush=True)

# ---------------------------------------------------------------- learning curve: static fits on N trailing days
def static_curve(block, tag, L, days_list, n0):
    ts, pos, Fa, Ta = block[L]; te = ts.year == 2020
    for N in days_list:
        tr = (ts >= pd.Timestamp("2020-01-01") - pd.Timedelta(days=N)) & (ts < pd.Timestamp("2020-01-01") - pd.Timedelta(days=L))
        bias, bk = fit_eof_mos(Fa[tr], Ta[tr], n0=n0)
        res.setdefault("learning_curve", {}).setdefault(f"{tag} d{L}", {})[str(N)] = round(wrmse(apply_eof(bias, bk, Fa[te]) - Ta[te]), 3)
    res["learning_curve"][f"{tag} d{L}"]["raw"] = round(wrmse(Fa[te] - Ta[te]), 3)
for L in (7, 10): static_curve(hres, "HRES", L, [30, 90, 180, 365, 730, 1460], n0=20)
for L in (10, 14): static_curve(ens, "ENS", L, [30, 90, 180, 365, 730], n0=20)

# ---------------------------------------------------------------- online cold start: the deployed learning loop
def online(block, tag, L, n0=20, halflife=None):
    """Start 2020-01-01 with NO history (prior = trust the NWP). Before each issue, refit on every forecast
    already verified (init + L <= issue). Reports RMSE per 2-month block relative to raw."""
    ts, pos, Fa, Ta = block[L]
    te = np.where(ts.year == 2020)[0]
    t_ns = ts.values.astype("datetime64[h]").astype(np.int64)
    err_on, err_raw, month = [], [], []
    pf_all = None
    for i in te:
        ver = np.where((ts >= pd.Timestamp("2020-01-01")) & (t_ns + 24 * L <= t_ns[i]))[0]
        if len(ver) == 0:
            fc = Fa[i:i+1]
        else:
            wts = None
            if halflife:
                age = (t_ns[i] - t_ns[ver]) / 24.0
                wts = 0.5 ** (age / halflife)
            bias, bk = fit_eof_mos(Fa[ver], Ta[ver], n0=n0, wts=wts)
            fc = apply_eof(bias, bk, Fa[i:i+1])
        err_on.append((fc - Ta[i:i+1])[0]); err_raw.append((Fa[i] - Ta[i])); month.append(ts[i].month)
    err_on, err_raw, month = np.array(err_on), np.array(err_raw), np.array(month)
    row = {}
    for m0 in (1, 3, 5, 7, 9, 11):
        sel = (month >= m0) & (month < m0 + 2)
        row[f"{m0:02d}-{m0+1:02d}"] = round(wrmse(err_on[sel]) / wrmse(err_raw[sel]), 3)
    row["year"] = round(wrmse(err_on) / wrmse(err_raw), 3)
    res.setdefault("online", {})[f"{tag} d{L}" + (f" (half-life {halflife} d)" if halflife else " (expanding)")] = row
for L in (7, 10): online(hres, "HRES", L)
online(hres, "HRES", 10, halflife=60)
for L in (10, 14): online(ens, "ENS", L)

json.dump(res, open("spike_results.json", "w"), indent=1)

# ---------------------------------------------------------------- print
def table(tab, leads=(1, 2, 3, 5, 7, 10, 12, 14, 15)):
    print(f"\n[{tab}] MSLP RMSE hPa, 2020")
    print("model".ljust(40) + "".join(f"{'d'+str(L):>7}" for L in leads))
    for n, row in res[tab].items():
        print(n.ljust(40) + "".join(f"{row[str(L)]:7.2f}" if str(L) in row else "      -" for L in leads))
table("global")
for reg in ("NH-extratropics", "north-america", "europe", "tropics", "SH-extratropics"): table(reg, (3, 5, 7, 10, 12, 14))
print("\nmean row-MOS slope b:", res["slopes"])
print("\ncalibration (Gaussian 80% interval coverage, CRPS, CRPSS vs Gaussian climatology):")
for tag, d in res["calibration"].items():
    for L in ("3", "7", "10", "12", "14"):
        if L in d: print(f"  {tag:14s} d{L:>2}: {d[L]}")
print("\nlearning curve (static EOF-MOS on N trailing days, prior n0=20 fields; RMSE hPa on 2020):")
for k, d in res["learning_curve"].items(): print(" ", k, d)
print("\nonline cold start from 2020-01-01 (RMSE ratio online/raw by 2-month block; <1 = learned model beats raw NWP):")
for k, d in res["online"].items(): print(" ", k, d)
print("\n%.0fs" % (time.time() - T0))
