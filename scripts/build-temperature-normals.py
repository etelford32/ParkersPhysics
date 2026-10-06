"""
scripts/build-temperature-normals.py — the Planetary Temperature Lab's 1991–2020 normals
═══════════════════════════════════════════════════════════════════════════════════════════
PLANETARY_TEMPERATURE_LAB_PLAN.md Phase 1 (§3.1, §4.2). Offline, never deployed. It runs
wherever WeatherBench2's public ERA5 mirror is reachable (plain HTTPS, no credentials).

Usage:
    python scripts/build-temperature-normals.py [--cache DIR] [--out assets/temperature]
                                                [--fixture tests/fixtures/temperature/normals-check.json]

`--cache` uses the same layout as scripts/temperature_lab_spike/fetch.py (hourly/YYYY.npy +
static.npz), so a spike data dir is reused as is. Missing years are fetched (~8 s each).

WHAT IT BUILDS (one container format, `PTLN`, for all four files; js/temperature-normals.js
is the ONE reader and its header documents the byte layout):

  normals-1991-2020.bin    per cell × {tmax, tmin, tmean}: mean = N=4 annual harmonics,
                           variance = N=2 harmonics of the squared residual; plus land %
                           and elevation at the cell centre (0.25° ERA5 statics)
  quantiles-1991-2020.bin  per cell × var × {p01 p05 p10 p33 p50 p67 p90 p95 p99}: N=3
                           harmonics fitted to the ±7-day × 30-year windowed quantiles
  records-1991-2020.bin    per cell × var × pentad: the max and min of the ±9-day pool, a
                           SUPERSET of every member date's ±7-day pool, so "beyond the
                           record" can only ever be under-claimed, never over-claimed
  hourly-1991-2020.bin     per cell: annual N=3 × diurnal K=2 tensor harmonics of hourly T2m
                           on continuous local SOLAR time (EarthView's anomaly-at-any-hour)

Every choice of harmonic order is the one MEASURED in the Phase-0 spike (plan §2.1–2.2):
N=4 is the split-half CV optimum for the daily mean (N=5 overfits), and K=2 captures the
diurnal cycle (0.584 K vs 0.567 at K=3, for 14 more coefficients).

THE CONVENTIONS, each mirrored exactly by js/temperature-normals.js:
  • cells     the 72×36 grid of api/cron/refresh-weather-grid.js — index j*72+i, j from the
              SOUTH (lat −87.5 + 5j), i from lon −177.5 + 5i
  • phase     φ(t) = 2π·frac((t/86400 s − 10957) / 365.2425) at UTC instant t (10957 =
              days 1970→2000-01-01). A day normal is evaluated at the window's MIDPOINT
  • days      local solar day = whole UTC hours shifted by off = floor(lon/15 + 0.5); the day's
              midpoint is the instant the fit's phase is taken at
  • doy       the local solar day's calendar day-of-year (1..366), circular on 366, which
              is the convention js/temp-outlook.js climatologyByDoy already uses
  • hours     solar hour h = (UTC hour + lon/15) mod 24, CONTINUOUS (not the day's integer
              offset) — the cell centre is fixed, so the continuous form is the exact one
  • storage   temperatures as int16 centi-°C (a0 converted from K; the harmonic terms are
              differences and carry over), variances as int16 K²×20. The fixture and the
              report are computed from the QUANTISED coefficients, so the JS reader is
              gated against what actually ships

NOT IN PHASE 1 (stated in the header of every file and in assets/temperature/SOURCES.md):
the representativeness offset (plan §4.2 step 3 / Phase 1b). These are 1.5° conservative
BOX means sampled at the cell centre, while the live grid is a POINT sample. The spike
measured 0.88 K mean |offset| on land (p95 3.1 K, 66 % static); it lands as a correction
term in a v2 asset.

Licence: ERA5, "Contains modified Copernicus Climate Change Service information [1991–2020]".
"""
import argparse, json, os, struct, sys, time, zlib, math
import numpy as np

t0 = time.time()
def log(*a): print(f"[{time.time() - t0:7.1f}s]", *a, flush=True)

ap = argparse.ArgumentParser()
# Outside the repo by default: the cache is ~1.4 GB of int16 hourly series.
ap.add_argument("--cache", default=os.path.expanduser("~/.cache/parkersphysics/era5-cells"))
ap.add_argument("--out", default="assets/temperature")
ap.add_argument("--fixture", default="tests/fixtures/temperature/normals-check.json")
ap.add_argument("--report", default=None, help="default: <out>/build-report.json")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
os.makedirs(os.path.dirname(args.fixture), exist_ok=True)
REPORT_PATH = args.report or os.path.join(args.out, "build-report.json")

PERIOD = (1991, 2020)
NX, NY = 72, 36
CELL_LAT = -87.5 + 5.0 * np.arange(NY)
CELL_LON = -177.5 + 5.0 * np.arange(NX)
VARS = ["tmax", "tmin", "tmean"]
# N_Q = 3 is MEASURED here (build-report.json quantile_order_splithalf_cv_rms_K): it beats N=2
# at every level and the raw ±7-day window by 0.03–0.18 K; N=4 gains < 0.01 K in the middle
# and loses at p01/p99.
N_MEAN, N_VAR, N_Q, N_H_ANNUAL, K_DIURNAL = 4, 2, 3, 3, 2
Q_LEVELS = [0.01, 0.05, 0.10, 0.33, 0.50, 0.67, 0.90, 0.95, 0.99]
N_PENTAD = 73
DOY_HALF = 7          # windowed quantiles: the spike's (and temp-outlook's) ±7 days
REC_HALF = 9          # records: ±7 widened by the pentad's own ±2 → a superset
T_SCALE = 100.0       # centi-°C
V_SCALE = 20.0        # K² × 20
K0 = 273.15
DAY0_2000 = 10957     # days 1970-01-01 → 2000-01-01
YEAR_DAYS = 365.2425
B = "https://storage.googleapis.com/weatherbench2/datasets"
H15 = f"{B}/era5/1959-2022-1h-240x121_equiangular_with_poles_conservative.zarr"
Q025 = f"{B}/era5/1959-2023_01_10-wb13-6h-1440x721_with_derived_variables.zarr"

# ── 1. data (the spike's cache layout; fetch what is missing) ────────────────
def ensure_cache():
    hourly = os.path.join(args.cache, "hourly")
    os.makedirs(hourly, exist_ok=True)
    need = [y for y in range(PERIOD[0], PERIOD[1] + 1) if not os.path.exists(os.path.join(hourly, f"{y}.npy"))]
    static = os.path.join(args.cache, "static.npz")
    if not need and os.path.exists(static):
        return
    import xarray as xr, zarr
    zarr.config.set({"async.concurrency": 64})
    h = xr.open_zarr(H15)["2m_temperature"]
    lat15, lon15 = h.latitude.values, h.longitude.values
    iy = np.array([int(np.argmin(np.abs(lat15 - la))) for la in CELL_LAT])
    ix = np.array([int(np.argmin(np.abs(((lon15 - (lo % 360.0)) + 180.0) % 360.0 - 180.0))) for lo in CELL_LON])
    for y in need:
        da = h.sel(time=slice(f"{y}-01-01", f"{y}-12-31T23:00")).isel(latitude=iy, longitude=ix)
        arr = da.transpose("time", "latitude", "longitude").values
        f = os.path.join(hourly, f"{y}.npy")
        np.save(f + ".tmp.npy", np.round((arr.astype(np.float64) - 200.0) * 100.0).astype(np.int16))
        os.replace(f + ".tmp.npy", f)
        np.save(os.path.join(hourly, f"{y}_time.npy"), da.time.values.astype("datetime64[h]").astype(np.int64))
        log("fetched hourly", y)
    if not os.path.exists(static):
        s15, s25 = xr.open_zarr(H15), xr.open_zarr(Q025)
        np.savez(static,
                 lsm15=s15["land_sea_mask"].transpose("latitude", "longitude").values,
                 z15=s15["geopotential_at_surface"].transpose("latitude", "longitude").values,
                 lsm025=s25["land_sea_mask"].transpose("latitude", "longitude").values,
                 z025=s25["geopotential_at_surface"].transpose("latitude", "longitude").values)
        np.save(os.path.join(args.cache, "snap_lat025.npy"), s25.latitude.values)
        np.save(os.path.join(args.cache, "snap_lon025.npy"), s25.longitude.values)
        log("fetched statics")

ensure_cache()
years = list(range(PERIOD[0], PERIOD[1] + 1))
H = np.concatenate([np.load(os.path.join(args.cache, "hourly", f"{y}.npy")) for y in years]).astype(np.float32) / 100 + 200
TH = np.concatenate([np.load(os.path.join(args.cache, "hourly", f"{y}_time.npy")) for y in years])
assert np.all(np.diff(TH) == 1), "hourly series has gaps"
log("hourly", H.shape, "K, hours", TH[0], "..", TH[-1])

def phase_days(days):
    """φ for a time expressed in days since 1970-01-01 (float)."""
    return 2 * np.pi * (((days - DAY0_2000) % YEAR_DAYS) / YEAR_DAYS)

def harm_X(phase, n):
    cols = [np.ones_like(phase)]
    for k in range(1, n + 1):
        cols += [np.cos(k * phase), np.sin(k * phase)]
    return np.stack(cols, -1)

# ── 2. local-solar-day dailies, per longitude column ─────────────────────────
# Each column keeps its own day axis and its own midpoint phases; the windowed
# statistics use the local date's day-of-year.
# floor(x + 0.5), NOT np.round: numpy rounds half to EVEN, JavaScript's Math.round
# rounds half UP, and the 72×36 centres hit exact halves (lon 7.5° → 0.5 h,
# −22.5° → −1.5 h), so the two would disagree on whole local days.
OFF = np.floor(CELL_LON / 15 + 0.5).astype(int)
cols = []
for j in range(NX):
    off = int(OFF[j])
    s0 = (-(TH[0] + off)) % 24
    n = (len(TH) - s0) // 24
    blk = H[s0:s0 + n * 24, :, j].reshape(n, 24, NY)
    D = (TH[s0] + off) // 24 + np.arange(n)                    # local solar day index
    keep = (D >= np.datetime64(f"{PERIOD[0]}-01-01", "D").astype(int)) & (D <= np.datetime64(f"{PERIOD[1]}-12-31", "D").astype(int))
    D = D[keep]
    dates = D.astype("datetime64[D]")
    doy = (dates - dates.astype("datetime64[Y]")).astype(int) + 1
    mid = D + 0.5 - off / 24.0                                 # UTC midpoint, days since epoch
    year = dates.astype("datetime64[Y]").astype(int) + 1970
    cols.append({"D": D, "doy": doy, "year": year, "phase": phase_days(mid),
                 "tmax": blk.max(1)[keep], "tmin": blk.min(1)[keep], "tmean": blk.mean(1)[keep]})
log("dailies", [len(c["D"]) for c in cols[:3]], "days per column")

# ── 3. fits ──────────────────────────────────────────────────────────────────
P_MEAN, P_VAR, P_Q, P_H = 2 * N_MEAN + 1, 2 * N_VAR + 1, 2 * N_Q + 1, (2 * N_H_ANNUAL + 1) * (2 * K_DIURNAL + 1)
coef_mean = np.zeros((NY, NX, 3, P_MEAN))
coef_var = np.zeros((NY, NX, 3, P_VAR))
coef_q = np.zeros((NY, NX, 3, len(Q_LEVELS), P_Q))
rec = np.zeros((NY, NX, 3, N_PENTAD, 2))                     # [max, min] in K
win_q_store = np.zeros((NY, NX, 3, len(Q_LEVELS), 365), np.float32)   # for the fit report
TGT = 2 * np.pi * ((np.arange(1, 366) - 0.5) / YEAR_DAYS)    # doy k's midpoint phase
X_TGT_Q = harm_X(TGT, N_Q)
PENT_C = 5 * np.arange(1, N_PENTAD + 1) - 2                  # pentad centre doy
# Split-half CV of the QUANTILE curves' harmonic order (the mean's order was
# chosen the same way in the Phase-0 spike): fit on odd years' windowed
# quantiles, score against even years' (and the reverse), area-weighted.
CV_ORDERS, CV_LEVELS = (2, 3, 4), (0.01, 0.10, 0.50, 0.90, 0.99)
cv_acc = np.zeros((len(CV_ORDERS), len(CV_LEVELS))); cv_raw = np.zeros(len(CV_LEVELS)); cv_w = 0.0
WROW = np.cos(np.deg2rad(CELL_LAT))

for j, c in enumerate(cols):
    Xm, Xv = harm_X(c["phase"], N_MEAN), harm_X(c["phase"], N_VAR)
    dist_cache = {}
    def dist_to(k):
        if k not in dist_cache:
            d = np.abs(c["doy"] - k)
            dist_cache[k] = np.minimum(d, 366 - d)
        return dist_cache[k]
    for v, name in enumerate(VARS):
        Y = c[name].astype(np.float64)                          # (days, NY)
        cm, *_ = np.linalg.lstsq(Xm, Y, rcond=None)
        res = Y - Xm @ cm
        cv, *_ = np.linalg.lstsq(Xv, res ** 2, rcond=None)
        coef_mean[:, j, v] = cm.T
        coef_var[:, j, v] = cv.T
        wq = np.empty((len(Q_LEVELS), 365, NY))
        for k in range(1, 366):
            wq[:, k - 1] = np.quantile(Y[dist_to(k) <= DOY_HALF], Q_LEVELS, axis=0)
        win_q_store[:, j, v] = np.transpose(wq, (2, 0, 1))
        for qi in range(len(Q_LEVELS)):
            cq, *_ = np.linalg.lstsq(X_TGT_Q, wq[qi], rcond=None)
            coef_q[:, j, v, qi] = cq.T
        halves = []
        for hm in (c["year"] % 2 == 1, c["year"] % 2 == 0):
            hq = np.empty((len(CV_LEVELS), 365, NY))
            for k in range(1, 366):
                hq[:, k - 1] = np.quantile(Y[hm & (dist_to(k) <= DOY_HALF)], CV_LEVELS, axis=0)
            halves.append(hq)
        for oi, nq in enumerate(CV_ORDERS):
            Xn = harm_X(TGT, nq)
            for fit_h, ref_h in ((halves[0], halves[1]), (halves[1], halves[0])):
                for li in range(len(CV_LEVELS)):
                    cfit, *_ = np.linalg.lstsq(Xn, fit_h[li], rcond=None)
                    err = (Xn @ cfit - ref_h[li]) ** 2               # (365, NY)
                    cv_acc[oi, li] += (err.mean(0) * WROW).sum()
        for li in range(len(CV_LEVELS)):      # the unsmoothed ±7-day window, the method the curves replace
            cv_raw[li] += 2 * (((halves[0][li] - halves[1][li]) ** 2).mean(0) * WROW).sum()
        cv_w += 2 * WROW.sum()
        for p, cc in enumerate(PENT_C):
            pool = Y[dist_to(int(cc)) <= REC_HALF]
            rec[:, j, v, p, 0] = pool.max(0)
            rec[:, j, v, p, 1] = pool.min(0)
    if j % 12 == 0: log("daily fits, column", j)

# hourly tensor normal on continuous solar time
coef_h = np.zeros((NY, NX, P_H))
hph = phase_days(TH / 24.0)
annual = harm_X(hph, N_H_ANNUAL)
for j in range(NX):
    sh = (TH % 24 + CELL_LON[j] / 15.0) % 24.0
    cols_h = [annual]
    for k in range(1, K_DIURNAL + 1):
        cols_h += [annual * np.cos(2 * np.pi * k * sh / 24)[:, None], annual * np.sin(2 * np.pi * k * sh / 24)[:, None]]
    X = np.concatenate(cols_h, 1)
    ch, *_ = np.linalg.lstsq(X, H[:, :, j].astype(np.float64), rcond=None)
    coef_h[:, j] = ch.T
log("hourly fits done")

# ── 4. quantise (°C for a0; harmonic terms are differences) ──────────────────
def to_c(coefs):
    out = coefs.copy()
    out[..., 0] -= K0
    return out
def q16(x, scale, what):
    v = np.round(x * scale)
    assert np.all(np.abs(v) <= 32767), f"{what} overflows int16 at scale {scale}: max |{np.abs(x).max():.1f}|"
    return v.astype(np.int16)
I_mean, I_var = q16(to_c(coef_mean), T_SCALE, "mean"), q16(coef_var, V_SCALE, "variance")
I_q, I_rec, I_h = q16(to_c(coef_q), T_SCALE, "quantiles"), q16(rec - K0, T_SCALE, "records"), q16(to_c(coef_h), T_SCALE, "hourly")

st = np.load(os.path.join(args.cache, "static.npz"))
lat25 = np.load(os.path.join(args.cache, "snap_lat025.npy")); lon25 = np.load(os.path.join(args.cache, "snap_lon025.npy"))
iy25 = np.array([int(np.argmin(np.abs(lat25 - la))) for la in CELL_LAT])
ix25 = np.array([int(np.argmin(np.abs(((lon25 - (lo % 360)) + 180) % 360 - 180))) for lo in CELL_LON])
land_pct = np.round(st["lsm025"][np.ix_(iy25, ix25)] * 100).astype(np.int16)
elev_m = np.round(st["z025"][np.ix_(iy25, ix25)] / 9.80665).astype(np.int16)

# ── 5. write (PTLN container: magic, u32 header length, JSON, pad, int16 LE) ─
COMMON = {
    "format": "PTLN", "version": 1, "period": list(PERIOD),
    "grid": {"w": NX, "h": NY, "lat0": -87.5, "lon0": -177.5, "deg": 5.0, "order": "j*w+i, j from the south"},
    "vars": VARS,
    "phase": "2*pi*frac((t_utc_days - 10957) / 365.2425)",
    "source": "ERA5 hourly 2 m temperature, WeatherBench2 1.5 deg conservative grid sampled at the cell centres",
    "representativeness": "none — 1.5 deg BOX means at a point; offset lands in a v2 asset (plan Phase 1b)",
    "licence": "Contains modified Copernicus Climate Change Service information [1991-2020]",
    "built": time.strftime("%Y-%m-%d"),
    "builder": "scripts/build-temperature-normals.py",
}
def write_ptln(path, header, body_int16):
    hj = json.dumps({**COMMON, **header}, separators=(",", ":")).encode()
    pad = (-(8 + len(hj))) % 2
    with open(path, "wb") as f:
        f.write(b"PTLN"); f.write(struct.pack("<I", len(hj) + pad)); f.write(hj + b" " * pad)
        f.write(np.ascontiguousarray(body_int16, dtype="<i2").tobytes())
    raw = open(path, "rb").read()
    return {"bytes": len(raw), "deflate": len(zlib.compress(raw, 9))}

cells = NY * NX
sizes = {}
sizes["normals"] = write_ptln(os.path.join(args.out, "normals-1991-2020.bin"), {
    "kind": "daily", "harmonics": {"mean": N_MEAN, "variance": N_VAR},
    "layout": "per cell: per var [mean 9, variance 5]; then land_pct[cells], elev_m[cells]",
    "scale": {"temperature": 1 / T_SCALE, "variance": 1 / V_SCALE, "units": "degC, K^2"},
    "day": "local solar day (offset floor(lon/15 + 0.5) h); evaluate at its UTC midpoint",
}, np.concatenate([np.concatenate([I_mean, I_var], -1).reshape(-1), land_pct.reshape(-1), elev_m.reshape(-1)]))
sizes["quantiles"] = write_ptln(os.path.join(args.out, "quantiles-1991-2020.bin"), {
    "kind": "quantiles", "harmonics": N_Q, "levels": Q_LEVELS, "window_days": DOY_HALF,
    "layout": f"per cell: per var: per level [{2 * N_Q + 1}]",
    "scale": {"temperature": 1 / T_SCALE, "units": "degC"},
    "fit_phase": "doy k fitted at 2*pi*(k-0.5)/365.2425",
}, I_q.reshape(-1))
sizes["records"] = write_ptln(os.path.join(args.out, "records-1991-2020.bin"), {
    "kind": "records", "pentads": N_PENTAD, "pool_half_days": REC_HALF,
    "layout": "per cell: per var: per pentad [max, min]",
    "pentad": "p = min(73, floor((doy-1)/5)+1) of the local solar day; pool = circular doy distance <= 9 of 5p-2 (366-day circle)",
    "scale": {"temperature": 1 / T_SCALE, "units": "degC"},
}, I_rec.reshape(-1))
sizes["hourly"] = write_ptln(os.path.join(args.out, "hourly-1991-2020.bin"), {
    "kind": "hourly", "harmonics": {"annual": N_H_ANNUAL, "diurnal": K_DIURNAL},
    "layout": "per cell [35]: annual row a (7) then a*cos(h), a*sin(h), a*cos(2h), a*sin(2h)",
    "solar_hour": "(utc_hour + lon/15) mod 24, continuous",
    "scale": {"temperature": 1 / T_SCALE, "units": "degC"},
}, I_h.reshape(-1))
log("written", sizes)

# ── 6. evaluate FROM THE QUANTISED INTEGERS (what ships) ─────────────────────
Fm, Fv = I_mean.astype(np.float64) / T_SCALE, I_var.astype(np.float64) / V_SCALE
Fq, Frec, Fh = I_q.astype(np.float64) / T_SCALE, I_rec.astype(np.float64) / T_SCALE, I_h.astype(np.float64) / T_SCALE
Z01, Z05 = -2.3263478740408408, -1.6448536269514729
def Phi(z): return 0.5 * math.erfc(-z / math.sqrt(2))   # erfc: no cancellation in the far lower tail
def ev(coefs, phase, n):
    return float(harm_X(np.array([phase]), n)[0] @ coefs)
def daily(j, i, phase):
    out = {}
    for v, name in enumerate(VARS):
        mean = ev(Fm[j, i, v], phase, N_MEAN)
        var = ev(Fv[j, i, v], phase, N_VAR)
        out[name] = {"mean": mean, "sd": math.sqrt(max(var, 0.04))}
    return out
def qcurve(j, i, v, phase):
    vals = [ev(Fq[j, i, v, k], phase, N_Q) for k in range(len(Q_LEVELS))]
    for k in range(1, len(vals)):                              # enforce non-decreasing
        vals[k] = max(vals[k], vals[k - 1])
    return vals
def percentile(vals, x):
    L = Q_LEVELS
    if x < vals[0]:
        s = max((vals[1] - vals[0]) / (Z05 - Z01), 0.05)
        return 100 * Phi(Z01 + (x - vals[0]) / s)
    if x > vals[-1]:
        s = max((vals[-1] - vals[-2]) / (-Z01 - -Z05), 0.05)
        return 100 * Phi(-Z01 + (x - vals[-1]) / s)
    for k in range(len(vals) - 1):
        if vals[k] <= x <= vals[k + 1]:
            if vals[k + 1] - vals[k] < 1e-9:
                return 100 * (L[k] + L[k + 1]) / 2
            return 100 * (L[k] + (L[k + 1] - L[k]) * (x - vals[k]) / (vals[k + 1] - vals[k]))
    return 100 * L[-1]
def cls(p):
    return "much-below" if p < 10 else "below" if p < 100 / 3 else "near" if p <= 200 / 3 else "above" if p <= 90 else "much-above"
def pentad(doy): return min(N_PENTAD, (doy - 1) // 5 + 1)
def hourly(j, i, t_ms):
    hours = t_ms / 3.6e6
    ph = float(phase_days(hours / 24.0))
    sh = (hours % 24 + CELL_LON[i] / 15.0) % 24.0
    a = harm_X(np.array([ph]), N_H_ANNUAL)[0]
    row = [a]
    for k in range(1, K_DIURNAL + 1):
        row += [a * math.cos(2 * math.pi * k * sh / 24), a * math.sin(2 * math.pi * k * sh / 24)]
    return float(np.concatenate(row) @ Fh[j, i])

# ── 7. report: the measurements behind the plan's Phase-1 gates ──────────────
rep = {"sizes": sizes}
W = np.repeat(np.cos(np.deg2rad(CELL_LAT))[:, None], NX, 1); W /= W.sum()
rep["harness"] = {"global_mean_tmean_normal_C": round(float((Fm[:, :, 2, 0] * W).sum()), 3),
                  "reference_C3S_1991_2020_C": 14.38}
# quantile curves vs the windowed empirical quantiles they were fitted to
fitted = np.einsum("tp,yxvqp->yxvqt", X_TGT_Q, Fq) + 0.0
emp = win_q_store.astype(np.float64) - K0
rep["quantile_fit_rms_K"] = {f"p{int(round(L * 100)):02d}": round(float(np.sqrt(np.mean((fitted[:, :, :, k] - emp[:, :, :, k]) ** 2))), 3)
                             for k, L in enumerate(Q_LEVELS)}
raw = np.einsum("tp,yxvqp->yxvqt", X_TGT_Q, Fq)
rep["quantile_order_splithalf_cv_rms_K"] = {f"N{nq}": {f"p{int(round(L * 100)):02d}": round(float(np.sqrt(cv_acc[oi, li] / cv_w)), 3)
                                                     for li, L in enumerate(CV_LEVELS)} for oi, nq in enumerate(CV_ORDERS)}
rep["quantile_order_splithalf_cv_rms_K"]["windowed_pm7"] = {f"p{int(round(L * 100)):02d}": round(float(np.sqrt(cv_raw[li] / cv_w)), 3)
                                                            for li, L in enumerate(CV_LEVELS)}
rep["quantile_crossings_frac"] = round(float(np.mean(np.diff(raw, axis=3) < 0)), 5)
# record envelope vs the p99 / p01 curves at the pentad centres
pc_phase = 2 * np.pi * ((PENT_C - 0.5) / YEAR_DAYS)
Xp = harm_X(pc_phase, N_Q)
p99 = np.einsum("tp,yxvp->yxvt", Xp, Fq[:, :, :, -1]); p01 = np.einsum("tp,yxvp->yxvt", Xp, Fq[:, :, :, 0])
rep["record_below_p99_frac"] = round(float(np.mean(Frec[..., 0] < p99)), 5)
rep["record_above_p01_frac"] = round(float(np.mean(Frec[..., 1] > p01)), 5)
# quantisation: worst error of the int16 mean normal over a phase sweep
sweep = np.linspace(0, 2 * np.pi, 73, endpoint=False)
Xs = harm_X(sweep, N_MEAN)
qerr = np.abs(np.einsum("tp,yxvp->yxvt", Xs, Fm) - np.einsum("tp,yxvp->yxvt", Xs, to_c(coef_mean)))
rep["quantisation_max_abs_K"] = round(float(qerr.max()), 4)
rep["land_cells"] = int((land_pct >= 50).sum())
log("report", rep)
with open(REPORT_PATH, "w") as f: json.dump(rep, f, indent=1)

# ── 8. fixture: 200 seeded evaluations from the quantised coefficients ───────
rng = np.random.default_rng(20261006)
T_LO = int(np.datetime64("2026-01-01T00:00", "ms").astype(np.int64))
T_HI = int(np.datetime64("2028-12-31T23:59", "ms").astype(np.int64))
stamps = [int(x) for x in rng.integers(T_LO, T_HI, 192)]
for s in ("2026-12-31T23:59:59", "2027-01-01T00:00:00", "2028-02-29T12:00:00", "2028-12-31T12:00:00",
          "2026-06-21T00:00:00", "2026-03-20T06:00:00", "2027-09-23T18:30:00", "2026-10-06T00:00:00"):
    stamps.append(int(np.datetime64(s, "ms").astype(np.int64)))
cases = []
for n, t_ms in enumerate(stamps):
    j, i = int(rng.integers(0, NY)), int(rng.integers(0, NX))
    phase = float(phase_days(t_ms / 864e5))
    off = int(OFF[i])
    local_day = math.floor((t_ms / 3.6e6 + off) / 24)
    d = np.datetime64(local_day, "D")
    doy = int((d - d.astype("datetime64[Y]")).astype(int)) + 1
    dn = daily(j, i, phase)
    case = {"cell": j * NX + i, "t_ms": t_ms, "phase": phase, "doy": doy, "pentad": pentad(doy), "daily": dn,
            "hourly_C": hourly(j, i, t_ms), "vars": {}}
    for v, name in enumerate(VARS):
        qs = qcurve(j, i, v, phase)
        p = pentad(doy)
        rmax = max(float(Frec[j, i, v, p - 1, 0]), qs[-1]); rmin = min(float(Frec[j, i, v, p - 1, 1]), qs[0])
        probes = []
        for k in (-3.2, -1.7, -0.4, 0.0, 0.9, 2.1, 3.6):
            x = dn[name]["mean"] + k * dn[name]["sd"]
            pc = percentile(qs, x)
            probes.append({"x": x, "percentile": pc, "cls": cls(pc),
                           "beyondRecord": "high" if x > rmax else "low" if x < rmin else None})
        case["vars"][name] = {"quantiles": qs, "record": {"max": rmax, "min": rmin}, "probes": probes}
    cases.append(case)
def round_floats(o):
    # 1e-7 (K or percentile points): four orders below the 1e-3 K tolerance, a third of the bytes.
    if isinstance(o, float): return round(o, 7)
    if isinstance(o, dict): return {k: round_floats(v) for k, v in o.items()}
    if isinstance(o, list): return [round_floats(v) for v in o]
    return o
with open(args.fixture, "w") as f:
    json.dump(round_floats({"generated": time.strftime("%Y-%m-%d"), "builder": COMMON["builder"],
                            "q_levels": Q_LEVELS, "tolerance_K": 1e-3, "cases": cases}), f, separators=(",", ":"))
log("fixture", len(cases), "cases →", args.fixture)
