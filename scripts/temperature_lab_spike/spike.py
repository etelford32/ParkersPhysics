"""
Planetary Temperature Lab Phase-0 spike — analysis.  See PLANETARY_TEMPERATURE_LAB_PLAN.md §2.

Run fetch.py first. Usage:  python spike.py [datadir] [results.json]

Every question here exists because a design decision in the plan depends on its answer:

  A  harness       does a 5-deg point sample of ERA5 reproduce C3S's published global numbers?
  B  normals       how many annual harmonics does a daily normal need (split-half CV), and
                   how big is the asset that ships it?
  C  diurnal       how many diurnal harmonics does an hour-of-day normal need (for anomaly at
                   an arbitrary scrubbed hour on EarthView)?
  D  calibration   is mean +/- k*sd a fair rarity measure, or must quantiles be stored?
                   And what does the held-out year (2021) look like against 1991-2020?
  E  ranking       rank "most unusual" by raw degrees or by standardised anomaly?
  F  window        how does the EXISTING Storm Watch method (current hour vs the last 30
                   days of hourly frames, compute_weather_extremes) compare with a
                   climatological baseline?
  G  baselines     1961-1990 vs 1991-2020: how far did the normal move?
  H  dilution      how much does a 5-deg grid miss the true hottest / coldest place by, and
                   is the 1.5-deg -> point representativeness error static enough to correct?
  I  census        where do the 0.25-deg extremes actually occur (seeds the site network)?
"""
import os, sys, json, time, zlib
import numpy as np

D = sys.argv[1] if len(sys.argv) > 1 else "data"
OUT = sys.argv[2] if len(sys.argv) > 2 else "results.json"
t0 = time.time()
def log(*a): print(f"[{time.time() - t0:7.1f}s]", *a, flush=True)
R = {}
def put(path, val):
    node = R
    *head, last = path.split(".")
    for k in head: node = node.setdefault(k, {})
    node[last] = val
def rnd(x, n=3): return None if x is None or not np.isfinite(x) else round(float(x), n)

K0 = 273.15
LAT = np.load(f"{D}/cell_lat.npy"); LON = np.load(f"{D}/cell_lon.npy")
NY, NX = len(LAT), len(LON)
WROW = np.cos(np.deg2rad(LAT))
W = np.repeat(WROW[:, None], NX, 1); W = W / W.sum()                 # (36, 72) area weights
st = np.load(f"{D}/static.npz")
lat15 = np.load(f"{D}/snap_lat15.npy"); lon15 = np.load(f"{D}/snap_lon15.npy")
iy15 = np.array([int(np.argmin(np.abs(lat15 - la))) for la in LAT])
ix15 = np.array([int(np.argmin(np.abs(((lon15 - (lo % 360)) + 180) % 360 - 180))) for lo in LON])
LAND = st["lsm15"][np.ix_(iy15, ix15)] > 0.5                          # (36, 72)
BAND = np.repeat(np.where(np.abs(LAT) < 23.5, 0, np.where(np.abs(LAT) < 50, 1, 2))[:, None], NX, 1)
BANDS = {"tropics": BAND == 0, "midlat": BAND == 1, "highlat": BAND == 2}
def wmean(x, mask=None):
    """Area-weighted mean over the (36,72) grid; x may carry leading axes."""
    w = W if mask is None else W * mask
    return float(np.nansum(x * w) / np.nansum(w * np.isfinite(x)))
def frac(cond, mask=None):
    """Area-weighted fraction of a boolean (…,36,72) field."""
    w = W if mask is None else W * mask
    c = cond.reshape(-1, NY, NX).astype(float)
    return float((c * w).sum() / (w.sum() * c.shape[0]))

# ── load hourly 1991-2021 at the 72x36 cell centres ──────────────────────────
years = list(range(1991, 2022))
H = np.concatenate([np.load(f"{D}/hourly/{y}.npy") for y in years]).astype(np.float32) / 100 + 200
TH = np.concatenate([np.load(f"{D}/hourly/{y}_time.npy") for y in years])
assert np.all(np.diff(TH) == 1), "hourly series has gaps"
log("hourly", H.shape)

# ── daily Tmax / Tmin / Tmean on LOCAL SOLAR days (round(lon/15) h offset) ───
# Every column is cut to whole local days, then all columns share the common range.
day_lo, day_hi = None, None
cols = []
for j, lo in enumerate(LON):
    off = int(round(lo / 15))
    s0 = (-(TH[0] + off)) % 24
    n = (len(TH) - s0) // 24
    blk = H[s0:s0 + n * 24, :, j].reshape(n, 24, NY)
    d0 = (TH[s0] + off) // 24
    cols.append((d0, blk.max(1), blk.min(1), blk.mean(1)))
    day_lo = d0 if day_lo is None else max(day_lo, d0)
    day_hi = d0 + n - 1 if day_hi is None else min(day_hi, d0 + n - 1)
DAYS = np.arange(day_lo, day_hi + 1)                                   # days since epoch
ND = len(DAYS)
DX = np.empty((ND, NY, NX), np.float32); DN = np.empty_like(DX); DM = np.empty_like(DX)
for j, (d0, mx, mn, me) in enumerate(cols):
    a = day_lo - d0
    DX[:, :, j], DN[:, :, j], DM[:, :, j] = mx[a:a + ND], mn[a:a + ND], me[a:a + ND]
del cols
dates = DAYS.astype("datetime64[D]")
YEAR = dates.astype("datetime64[Y]").astype(int) + 1970
DOY = (dates - dates.astype("datetime64[Y]")).astype(int) + 1               # 1..366
PHASE = 2 * np.pi * ((DAYS - 10957) % 365.2425) / 365.2425                 # continuous year phase
TRAIN = (YEAR >= 1991) & (YEAR <= 2020); TEST = YEAR == 2021
log("daily", ND, "days", str(dates[0]), "..", str(dates[-1]))
VARS = {"tmax": DX, "tmin": DN, "tmean": DM}

# ── A. harness against C3S ───────────────────────────────────────────────────
gm = np.array([wmean(DM[i]) for i in range(ND)]) - K0
clim_abs = gm[TRAIN].mean(); a2021 = gm[TEST].mean() - clim_abs
put("A.global_mean_1991_2020_C", rnd(clim_abs, 2))
put("A.reference_C3S_1991_2020_C", 14.38)   # C3S 2023: 14.98 C = +0.60 over 1991-2020
put("A.anomaly_2021_vs_1991_2020_C", rnd(a2021, 2))
put("A.reference_C3S_2021_anomaly_C", 0.3)
log("A", R["A"])

# ── B. daily normals: windowed (temp-outlook.js method) vs annual harmonics ──
def harm_X(phase, n):
    cols = [np.ones_like(phase)]
    for k in range(1, n + 1):
        cols += [np.cos(k * phase), np.sin(k * phase)]
    return np.stack(cols, 1)
def fit_harm(y, phase, n):
    X = harm_X(phase, n)
    c, *_ = np.linalg.lstsq(X, y.reshape(len(y), -1), rcond=None)
    return c                                                            # (2n+1, cells)
def eval_harm(c, phase, n): return (harm_X(phase, n) @ c).reshape(len(phase), NY, NX)
def windowed(y, doy, half=7, fn="mean"):
    """temp-outlook.js climatologyByDoy: circular +-half days on day-of-year, per target doy 1..365."""
    out = np.empty((365, NY, NX), np.float32)
    for k in range(1, 366):
        dist = np.minimum(np.abs(doy - k), 366 - np.abs(doy - k))
        sel = y[dist <= half]
        out[k - 1] = sel.mean(0) if fn == "mean" else sel.std(0)
    return out
TGT = 2 * np.pi * ((np.arange(1, 366) - 1) / 365.2425)                     # target phases for doy 1..365
odd = TRAIN & (YEAR % 2 == 1); even = TRAIN & (YEAR % 2 == 0)
def wrms(a, mask=None):
    return float(np.sqrt(wmean(np.nanmean(a ** 2, 0), mask)))
for name, Y in VARS.items():
    # noise floor of a 30-year windowed mean, measured by split-half
    wo, we = windowed(Y[odd], DOY[odd]), windowed(Y[even], DOY[even])
    put(f"B.{name}.windowed_noise_floor_K", rnd(wrms(wo - we) / 2))
    # split-half CV: fit on odd years, score against the even years' windowed mean (and vice versa)
    cv = {"windowed_pm7": (wrms(wo - we) + wrms(we - wo)) / 2}
    for n in range(1, 6):
        e1 = eval_harm(fit_harm(Y[odd], PHASE[odd], n), TGT, n) - we
        e2 = eval_harm(fit_harm(Y[even], PHASE[even], n), TGT, n) - wo
        cv[f"harmonic_N{n}"] = (wrms(e1) + wrms(e2)) / 2
    put(f"B.{name}.splithalf_cv_rms_K", {k: rnd(v) for k, v in cv.items()})
    log("B", name, R["B"][name])

# SD normal: harmonics of the squared residual about the N=3 mean, vs windowed SD
NH = 3
COEF = {}
for name, Y in VARS.items():
    cm = fit_harm(Y[TRAIN], PHASE[TRAIN], NH)
    res = Y[TRAIN] - eval_harm(cm, PHASE[TRAIN], NH)
    cv2 = fit_harm(res ** 2, PHASE[TRAIN], 2)
    sd_h = np.sqrt(np.maximum(eval_harm(cv2, TGT, 2), 0.04))
    sd_w = windowed(res, DOY[TRAIN], fn="std")
    put(f"B.{name}.sd_harmonic_N2_vs_windowed_rms_K", rnd(wrms(sd_h - sd_w)))
    COEF[name] = (cm, cv2)
# asset size: N=3 mean (7) + N=2 variance (5) per variable per cell
blob = np.concatenate([np.concatenate([c[0], c[1]]) for c in COEF.values()])
i16 = np.round(blob * 50).astype(np.int16)            # 0.02-K / 0.02-K^2 quanta — illustrative only
put("B.asset_coeffs_per_cell", int(blob.shape[0]))
put("B.asset_bytes_int16", int(i16.nbytes))
put("B.asset_bytes_int16_deflate", len(zlib.compress(i16.tobytes(), 9)))
put("B.asset_bytes_float32_deflate", len(zlib.compress(blob.astype(np.float32).tobytes(), 9)))
log("B sizes", {k: R["B"][k] for k in R["B"] if k.startswith("asset")})

def normal(name, phase):
    cm, cv2 = COEF[name]
    return eval_harm(cm, phase, NH), np.sqrt(np.maximum(eval_harm(cv2, phase, 2), 0.04))

# ── C. diurnal: annual N=3 x diurnal K tensor harmonics on hourly data ───────
# Score: split-half CV against the even/odd years' empirical (doy-window x hour) mean,
# on a 1-in-4 cell subsample (memory). K=0 is "daily mean only".
HTRAIN = (TH >= np.datetime64("1991-01-01T00", "h").astype(int)) & (TH < np.datetime64("2021-01-01T00", "h").astype(int))
hrs = TH[HTRAIN]; hph = 2 * np.pi * ((hrs / 24 - 10957) % 365.2425) / 365.2425
hyr = hrs.astype("datetime64[h]").astype("datetime64[Y]").astype(int) + 1970
Hs = H[:, ::2, ::2][HTRAIN]                                           # (T, 18, 36) — 1-in-4 cells
NYs, NXs = Hs.shape[1:]
loc_hour = ((hrs[:, None] + np.round(LON[::2] / 15).astype(int)[None, :]) % 24)   # (T, 36) local solar hour
hmon = hrs.astype("datetime64[h]").astype("datetime64[M]").astype(int) % 12
def emp_mean(Hr, lh, mon):
    """empirical mean by (calendar month, local solar hour) — the independent reference"""
    out = np.empty((12, 24, NYs, NXs))
    for j in range(NXs):
        idx = mon * 24 + lh[:, j]
        cnt = np.bincount(idx, minlength=288)
        for i in range(NYs):
            out[:, :, i, j] = (np.bincount(idx, weights=Hr[:, i, j], minlength=288) / cnt).reshape(12, 24)
    return out
def design(ann, lh, K):
    """annual harmonic rows (..., 7) x diurnal harmonics at local hour lh -> (..., 7(2K+1))"""
    cols = [ann]
    for k in range(1, K + 1):
        cols += [ann * np.cos(2 * np.pi * k * lh / 24)[..., None], ann * np.sin(2 * np.pi * k * lh / 24)[..., None]]
    return np.concatenate(cols, -1)
splits = []
for fit_m, ref_m in ((hyr % 2 == 1, hyr % 2 == 0), (hyr % 2 == 0, hyr % 2 == 1)):
    ref = emp_mean(Hs[ref_m], loc_hour[ref_m], hmon[ref_m])
    # the reference is a MONTH mean, so the prediction is averaged over the same month's phases
    abar = np.stack([harm_X(hph[ref_m][hmon[ref_m] == m], 3).mean(0) for m in range(12)])   # (12, 7)
    splits.append((Hs[fit_m], loc_hour[fit_m], harm_X(hph[fit_m], 3), ref, abar))
lhs = np.arange(24)
cvd = {}
for K in range(0, 4):
    errs = []
    for Hf, lh_f, ann_f, ref, abar in splits:
        rows = design(np.repeat(abar[:, None, :], 24, 1), np.repeat(lhs[None, :], 12, 0), K)   # (12, 24, P)
        pred = np.empty_like(ref)
        for j in range(NXs):
            c, *_ = np.linalg.lstsq(design(ann_f, lh_f[:, j], K), Hf[:, :, j], rcond=None)
            pred[:, :, :, j] = rows @ c
        errs.append(np.sqrt(np.mean((pred - ref) ** 2)))
    cvd[f"K{K}"] = float(np.mean(errs))
    log("C", K, cvd[f"K{K}"])
put("C.splithalf_cv_rms_vs_month_hour_mean_K", {k: rnd(v) for k, v in cvd.items()})
put("C.coeffs_per_cell", {f"K{K}": 7 * (2 * K + 1) for K in range(4)})
del Hs

# ── D. calibration of mean +/- k*sd, and the held-out year ────────────────────
def pool_quantiles(Y, doy_tr, qs, targets):
    """empirical quantiles of the +-7-day x 30-year pool, per target doy"""
    out = np.empty((len(qs), len(targets), NY, NX), np.float32)
    for i, k in enumerate(targets):
        dist = np.minimum(np.abs(doy_tr - k), 366 - np.abs(doy_tr - k))
        out[:, i] = np.quantile(Y[dist <= 7], qs, axis=0)
    return out
for name, Y in VARS.items():
    mu, sd = normal(name, PHASE[TRAIN])
    z = (Y[TRAIN] - mu) / sd
    cal = {}
    for bn, bm in BANDS.items():
        for surf, sm in (("land", LAND), ("sea", ~LAND)):
            m = bm & sm
            cal[f"{bn}_{surf}"] = {"z_gt_1.645": rnd(frac(z > 1.645, m), 4), "z_lt_-1.645": rnd(frac(z < -1.645, m), 4),
                                   "z_gt_2.326": rnd(frac(z > 2.326, m), 4), "z_lt_-2.326": rnd(frac(z < -2.326, m), 4)}
    put(f"D.{name}.in_sample_gaussian_tail_rates", cal)   # expect 0.05 at 1.645, 0.01 at 2.326
    # held-out 2021 against EMPIRICAL pool quantiles + window records (1991-2020)
    qs = [0.05, 0.10, 0.90, 0.95, 0.0, 1.0]
    tdoy = np.minimum(DOY[TEST], 365)
    Q = pool_quantiles(Y[TRAIN], DOY[TRAIN], qs, np.unique(tdoy))
    qi = np.searchsorted(np.unique(tdoy), tdoy)
    y21 = Y[TEST]
    ho = {}
    for surf, sm in (("all", None), ("land", LAND)):
        ho[surf] = {
            "gt_p90": rnd(frac(y21 > Q[2, qi], sm), 4), "gt_p95": rnd(frac(y21 > Q[3, qi], sm), 4),
            "gt_record_max": rnd(frac(y21 > Q[5, qi], sm), 4),
            "lt_p10": rnd(frac(y21 < Q[1, qi], sm), 4), "lt_p05": rnd(frac(y21 < Q[0, qi], sm), 4),
            "lt_record_min": rnd(frac(y21 < Q[4, qi], sm), 4)}
    put(f"D.{name}.heldout_2021_exceedance_rates", ho)
    log("D", name, ho)

# ── E. ranking: raw degrees vs standardised anomaly (2021 daily Tmean) ───────
mu, sd = normal("tmean", PHASE[TEST])
A = DM[TEST] - mu; Z = A / sd
LATG = np.repeat(LAT[:, None], NX, 1); LONG = np.repeat(LON[None, :], NY, 0)
def gc_km(la1, lo1, la2, lo2):
    p1, p2 = np.deg2rad(la1), np.deg2rad(la2); dl = np.deg2rad(lo2 - lo1)
    return 6371 * np.arccos(np.clip(np.sin(p1) * np.sin(p2) + np.cos(p1) * np.cos(p2) * np.cos(dl), -1, 1))
def top_sep(score, k=10, sep_km=1500, mask=None):
    s = np.where(mask, score, -np.inf) if mask is not None else score
    order = np.argsort(s, axis=None)[::-1]
    picked = []
    for o in order:
        if not np.isfinite(s.flat[o]): break
        la, lo = LATG.flat[o], LONG.flat[o]
        if all(gc_km(la, lo, LATG.flat[p], LONG.flat[p]) >= sep_km for p in picked):
            picked.append(o)
            if len(picked) == k: break
    return picked
rank = {}
for side, sgn in (("warm", 1), ("cold", -1)):
    for surf, sm in (("all", None), ("land", LAND)):
        stats = {"raw": [], "z": [], "overlap": []}
        for i in range(A.shape[0]):
            pr = top_sep(sgn * A[i], mask=sm); pz = top_sep(sgn * Z[i], mask=sm)
            for key, p in (("raw", pr), ("z", pz)):
                la = np.abs(LATG.flat[p])
                stats[key].append((np.median(la), np.mean(la > 50), np.mean(sgn * A[i].flat[p]), np.mean(sgn * Z[i].flat[p])))
            stats["overlap"].append(len(set(pr) & set(pz)) / 10)
        out = {}
        for key in ("raw", "z"):
            s = np.array(stats[key])
            out[f"by_{key}"] = {"median_abs_lat": rnd(np.mean(s[:, 0]), 1), "frac_poleward_50": rnd(np.mean(s[:, 1]), 3),
                                "mean_dT_K": rnd(np.mean(s[:, 2]), 2), "mean_z": rnd(np.mean(s[:, 3]), 2)}
        out["overlap_of_top10"] = rnd(np.mean(stats["overlap"]), 3)
        rank[f"{side}_{surf}"] = out
put("E.top10_daily_2021", rank)
log("E", rank)

# ── F. the existing Storm Watch method vs a climatological baseline ──────────
# compute_weather_extremes: history = every 3rd hourly frame of the previous 30 days
# (excluding the newest), current = newest frame; heat if >= p95 & >= 25 C, cold if
# <= p05 & <= 0 C. Climatology: same (doy +-7, UTC hour) across 1991-2020 -> p90 / p95.
hdt = TH.astype("datetime64[h]")
hdoy = (hdt.astype("datetime64[D]") - hdt.astype("datetime64[Y]")).astype(int) + 1
hhr = TH % 24
idx2021 = np.where((hdt >= np.datetime64("2021-01-01T00")) & (hdt <= np.datetime64("2021-12-31T18")) & (hhr % 6 == 0))[0]
trainH = np.where(HTRAIN)[0]
F = {"heat": {"window": 0, "both": 0, "clim": 0, "window_below_clim_p90": 0, "window_below_clim_median": 0},
     "cold": {"window": 0, "both": 0, "clim": 0, "window_above_clim_p10": 0, "window_above_clim_median": 0}}
by_month = np.zeros((12, 4))                                          # heat window, heat clim, cold window, cold clim (NH extratropical land)
nhx = LAND & (LAT[:, None] > 23.5)
lst_hist = {"window_heat": np.zeros(24), "clim_heat": np.zeros(24)}
LSTOFF = np.round(LON / 15).astype(int)
for ii, t in enumerate(idx2021):
    win = H[t - 720:t][::-1][2::3]                                    # rn % 3 == 0, newest excluded
    cur = H[t]
    p05, p95 = np.quantile(win, [0.05, 0.95], axis=0)
    dist = np.minimum(np.abs(hdoy[trainH] - hdoy[t]), 366 - np.abs(hdoy[trainH] - hdoy[t]))
    pool = H[trainH[(dist <= 7) & (hhr[trainH] == hhr[t])]]
    c10, c50, c90, c95, c05 = np.quantile(pool, [0.10, 0.50, 0.90, 0.95, 0.05], axis=0)
    wh = (cur >= p95) & (cur >= K0 + 25); ch = (cur >= c95) & (cur >= K0 + 25)
    wc = (cur <= p05) & (cur <= K0);      cc = (cur <= c05) & (cur <= K0)
    F["heat"]["window"] += int(wh.sum()); F["heat"]["clim"] += int(ch.sum()); F["heat"]["both"] += int((wh & ch).sum())
    F["heat"]["window_below_clim_p90"] += int((wh & (cur < c90)).sum()); F["heat"]["window_below_clim_median"] += int((wh & (cur < c50)).sum())
    F["cold"]["window"] += int(wc.sum()); F["cold"]["clim"] += int(cc.sum()); F["cold"]["both"] += int((wc & cc).sum())
    F["cold"]["window_above_clim_p10"] += int((wc & (cur > c10)).sum()); F["cold"]["window_above_clim_median"] += int((wc & (cur > c50)).sum())
    m = int(str(hdt[t])[5:7]) - 1
    by_month[m] += [(wh & nhx).sum(), (ch & nhx).sum(), (wc & nhx).sum(), (cc & nhx).sum()]
    lst = (hhr[t] + LSTOFF) % 24
    for key, fl in (("window_heat", wh), ("clim_heat", ch)):
        np.add.at(lst_hist[key], np.repeat(lst[None, :], NY, 0)[fl], 1)
    if ii % 200 == 0: log("F", ii, "/", len(idx2021))
for side in ("heat", "cold"):
    f = F[side]
    f["precision_window_is_clim_flag"] = rnd(f["both"] / max(f["window"], 1), 3)
    f["recall_clim_flags_caught_by_window"] = rnd(f["both"] / max(f["clim"], 1), 3)
for key in ("window_below_clim_p90", "window_below_clim_median"):
    F["heat"][key + "_frac"] = rnd(F["heat"][key] / max(F["heat"]["window"], 1), 3)
for key in ("window_above_clim_p10", "window_above_clim_median"):
    F["cold"][key + "_frac"] = rnd(F["cold"][key] / max(F["cold"]["window"], 1), 3)
F["nh_extratropical_land_by_month"] = {
    "columns": ["heat_window", "heat_clim", "cold_window", "cold_clim"],
    "rows": by_month.astype(int).tolist()}
for key in lst_hist:
    h_ = lst_hist[key]
    F[f"{key}_frac_local_12_17h"] = rnd(h_[12:18].sum() / max(h_.sum(), 1), 3)
put("F", F)
log("F", {k: v for k, v in F.items() if k in ("heat", "cold")})

# ── G. baseline shift 1961-1990 vs 1991-2020 (64x32, 6-hourly) ───────────────
C = np.load(f"{D}/coarse6h.npy").astype(np.float32) / 100 + 200
CT = np.load(f"{D}/coarse6h_time.npy"); clat = np.load(f"{D}/coarse6h_lat.npy")
cw = np.cos(np.deg2rad(clat)); cw = cw / (cw.sum() * C.shape[2])
nd = C.shape[0] // 4
Cd = C[:nd * 4].reshape(nd, 4, *C.shape[1:]).mean(1)
cdays = CT[:nd * 4:4] // 24
cdt = cdays.astype("datetime64[D]"); cyr = cdt.astype("datetime64[Y]").astype(int) + 1970
cph = 2 * np.pi * ((cdays - 10957) % 365.2425) / 365.2425
def cmean(x): return float((x * cw[None, :, None] if x.ndim == 3 else x * cw[:, None]).sum() / (x.shape[0] if x.ndim == 3 else 1))
G = {}
fits = {}
for lbl, (a, b) in (("1961_1990", (1961, 1990)), ("1991_2020", (1991, 2020))):
    m = (cyr >= a) & (cyr <= b)
    X = harm_X(cph[m], 3)
    c, *_ = np.linalg.lstsq(X, Cd[m].reshape(m.sum(), -1), rcond=None)
    fits[lbl] = c
    G[f"global_mean_{lbl}_C"] = rnd(cmean(Cd[m]) - K0, 2)
m21 = cyr == 2021
for lbl, c in fits.items():
    nrm = (harm_X(cph[m21], 3) @ c).reshape(m21.sum(), *Cd.shape[1:])
    G[f"anomaly_2021_vs_{lbl}_C"] = rnd(cmean(Cd[m21] - nrm), 2)
    G[f"frac_2021_days_above_{lbl}_normal"] = rnd(float(((Cd[m21] > nrm) * cw[None, :, None]).sum() / m21.sum()), 3)
G["shift_C"] = rnd(G["global_mean_1991_2020_C"] - G["global_mean_1961_1990_C"], 2)
put("G", G)
log("G", G)
del C, Cd

# ── H + I. snapshots: dilution, representativeness, census ───────────────────
lat25 = np.load(f"{D}/snap_lat025.npy"); lon25 = np.load(f"{D}/snap_lon025.npy")
iy25 = np.array([int(np.argmin(np.abs(lat25 - la))) for la in LAT])
ix25 = np.array([int(np.argmin(np.abs(((lon25 - (lo % 360)) + 180) % 360 - 180))) for lo in LON])
lsm25 = st["lsm025"] > 0.5
L25 = np.repeat(lat25[:, None], len(lon25), 1); O25 = np.repeat(lon25[None, :], len(lat25), 0)
files = sorted(f for f in os.listdir(f"{D}/snap") if f.endswith("_025.npy"))
gaps = {"hot_grid_point_vs_025_K": [], "cold_grid_point_vs_025_K": [], "hot_15_vs_025_K": [], "cold_15_vs_025_K": [],
        "hot_metno10_upsampled_vs_025_K": [], "cold_metno10_upsampled_vs_025_K": []}
FLAT = -85.0 + 10.0 * np.arange(18); FLON = -175.0 + 10.0 * np.arange(36)
fy25 = np.array([int(np.argmin(np.abs(lat25 - la))) for la in FLAT])
fx25 = np.array([int(np.argmin(np.abs(((lon25 - (lo % 360)) + 180) % 360 - 180))) for lo in FLON])
def upsample_like_cron(c):
    """mirror of upsampleToGrid: cell-centre alignment, indices CLAMPED (no lon wrap)"""
    out = np.empty((NY, NX))
    for J in range(NY):
        js = (J + 0.5) * 0.5 - 0.5; j0 = min(max(int(np.floor(js)), 0), 17); j1 = min(j0 + 1, 17); fj = min(max(js - j0, 0), 1)
        for I in range(NX):
            is_ = (I + 0.5) * 0.5 - 0.5; i0 = min(max(int(np.floor(is_)), 0), 35); i1 = min(i0 + 1, 35); fi = min(max(is_ - i0, 0), 1)
            out[J, I] = (c[j0, i0] * (1 - fi) * (1 - fj) + c[j0, i1] * fi * (1 - fj) + c[j1, i0] * (1 - fi) * fj + c[j1, i1] * fi * fj)
    return out
met_rms = []
rep = []
census = {"hot": [], "cold": []}
for fn in files:
    t25 = np.load(f"{D}/snap/{fn}").astype(np.float32) / 100 + 200
    t15 = np.load(f"{D}/snap/{fn.replace('_025', '_15')}").astype(np.float32) / 100 + 200
    land25 = np.where(lsm25, t25, np.nan)
    pt25 = t25[np.ix_(iy25, ix25)]; pt15 = t15[np.ix_(iy15, ix15)]
    gaps["hot_grid_point_vs_025_K"].append(np.nanmax(land25) - pt25[LAND].max())
    gaps["cold_grid_point_vs_025_K"].append(pt25[LAND].min() - np.nanmin(land25))
    gaps["hot_15_vs_025_K"].append(np.nanmax(land25) - t15[st["lsm15"] > 0.5].max())
    gaps["cold_15_vs_025_K"].append(t15[st["lsm15"] > 0.5].min() - np.nanmin(land25))
    rep.append(pt25 - pt15)
    up = upsample_like_cron(t25[np.ix_(fy25, fx25)])
    gaps["hot_metno10_upsampled_vs_025_K"].append(np.nanmax(land25) - up[LAND].max())
    gaps["cold_metno10_upsampled_vs_025_K"].append(up[LAND].min() - np.nanmin(land25))
    met_rms.append(np.sqrt(np.mean((up - pt25)[LAND] ** 2)))
    for side, sgn in (("hot", 1), ("cold", -1)):
        s = np.where(lsm25, sgn * t25, -np.inf)
        order = np.argsort(s, axis=None)[::-1][:4000]
        picked = []
        for o in order:
            la, lo = L25.flat[o], O25.flat[o]
            if all(gc_km(la, lo, a, b) >= 800 for a, b, _ in picked):
                picked.append((la, lo, float(t25.flat[o] - K0)))
                if len(picked) == 8: break
        census[side].append((fn[:13], picked))
    if fn.startswith("20210630T0000"):
        lyt = (int(np.argmin(np.abs(lat25 - 50.23))), int(np.argmin(np.abs(lon25 - (360 - 121.58)))))
        jy, jx = int(np.argmin(np.abs(LAT - 50.23))), int(np.argmin(np.abs(((LON - (-121.58)) + 180) % 360 - 180)))
        put("H.pnw_2021_06_30T00", {"era5_025_at_lytton_C": rnd(t25[lyt] - K0, 1),
                                    "era5_025_cell_elevation_m": rnd(float(st["z025"][lyt]) / 9.80665, 0),
                                    "nearest_grid_cell": [float(LAT[jy]), float(LON[jx])],
                                    "grid_cell_value_025_C": rnd(pt25[jy, jx] - K0, 1),
                                    "grid_cell_value_15_C": rnd(pt15[jy, jx] - K0, 1),
                                    "note": "observed Lytton max 49.6 C on 2021-06-29 (ECCC)"})
for k, v in gaps.items():
    v = np.array(v); put(f"H.{k}", {"median": rnd(np.median(v), 1), "p90": rnd(np.quantile(v, 0.9), 1), "max": rnd(v.max(), 1)})
put("H.metno10_vs_5deg_point_rms_K_land", {"median": rnd(np.median(met_rms), 2), "p90": rnd(np.quantile(met_rms, 0.9), 2)})
rep = np.array(rep)                                                   # (S, 36, 72)
mean_d, sd_d = rep.mean(0), rep.std(0)
put("H.representativeness_025_point_minus_15_box", {
    "mean_abs_K_land": rnd(float(np.mean(np.abs(mean_d[LAND]))), 2),
    "mean_abs_K_sea": rnd(float(np.mean(np.abs(mean_d[~LAND]))), 2),
    "p95_abs_mean_K_land": rnd(float(np.quantile(np.abs(mean_d[LAND]), 0.95)), 2),
    "time_sd_K_land_median": rnd(float(np.median(sd_d[LAND])), 2),
    "static_share_of_msd_land": rnd(float(np.sum(mean_d[LAND] ** 2) / np.sum(mean_d[LAND] ** 2 + sd_d[LAND] ** 2)), 3)})
# census -> recurrent 10-deg boxes
for side in ("hot", "cold"):
    boxes = {}
    for stamp, picked in census[side]:
        for la, lo, tc in picked:
            key = (int(np.floor(la / 10) * 10), int(np.floor(((lo + 180) % 360 - 180) / 10) * 10))
            b = boxes.setdefault(key, {"n": 0, "ext": None, "lat": la, "lon": (lo + 180) % 360 - 180})
            b["n"] += 1
            if b["ext"] is None or (tc > b["ext"] if side == "hot" else tc < b["ext"]):
                b.update(ext=tc, lat=la, lon=(lo + 180) % 360 - 180)
    top = sorted(boxes.items(), key=lambda kv: -kv[1]["n"])[:20]
    put(f"I.{side}_recurrent_boxes", [{"box_lat": k[0], "box_lon": k[1], "count": v["n"], "extreme_C": rnd(v["ext"], 1),
                                       "at": [rnd(v["lat"], 2), rnd(v["lon"], 2)]} for k, v in top])
put("I.slices", len(files))
log("H", R["H"])

R["_meta"] = {"generated": time.strftime("%Y-%m-%d"), "runtime_s": round(time.time() - t0, 1),
              "data": "WeatherBench2 ERA5 (hourly 1.5 deg at 72x36 cell centres 1991-2021; 6-hourly 5.625 deg 1961-2021; 0.25 deg 2021 snapshots)"}
with open(OUT, "w") as fh: json.dump(R, fh, indent=1)
log("wrote", OUT)
