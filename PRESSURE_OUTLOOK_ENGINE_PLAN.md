# Barometric Outlook Engine — a learned, verified MSLP forecast for the EarthView scrubber (0 → +14 d)

Status: **planned, not built.** Phase 0 (a measured feasibility spike) was run on
2026-09-24, and every number below comes from it. You can regenerate them with
`scripts/pressure_outlook_spike/` (§9). The decisions that are the author's to make are
listed in §8.

---

## 0. TL;DR

The EarthView time bar already runs from −7 d to +14 d. Past the first day, though,
nothing *forecasts* pressure:

- The bar replays a raw deterministic Open-Meteo frame.
- Past the loaded depth it freezes the last frame.
- It contours `surface_pressure`, not sea-level pressure.

Measured on WeatherBench2 at our resolution, **a raw deterministic MSLP forecast at
day 14 has a squared error 65 % larger than drawing the calendar normal (88 % over
North America).** The bar currently draws exactly that.

The spike asked what a model that "learns from historical data" should be. The answer
has six parts:

1. **Our pressure history is the TEACHER, not the INPUT.** A model trained on 28 years of
   ERA5 pressure fields alone is 7× worse than NWP at day 1 (3.89 vs 0.53 hPa). By day 7
   it is no better than climatology. Adding it to an NWP model buys 0.3 %.
2. **Physics sets the ceiling.** Past day 5, the raw ensemble mean beats every
   corrected deterministic run.
3. **The ML layer's job is to learn how much physics to believe, per lead, per region
   and per spatial scale, and to fill the rest with climatology.** On a deterministic
   run this is worth 15 % at day 10 globally and 18 % over North America. On an ensemble
   mean it is worth ~0 % globally and 3–8 % in the tropics, so the layer must be allowed
   to learn "do nothing".
4. **It learns fast.** 30 days of verified forecasts capture ~73 % of the attainable
   gain and 90 days capture ~93 %. A cold-started online learner beats raw NWP in its
   first two months. What keeps paying off after that is *richer* models (seasonal,
   per-cell, multi-centre, nonlinear), which is why the archive has to start now.
5. **Honest uncertainty is cheap.** A Gaussian σ(lead, latitude) around the corrected
   mean gets within 2–4 % of the CRPS of a 50-member ensemble, and its 80 % band covers
   81–85 % of outcomes.
6. **The ceiling at day 14 is low, and the bar must say so.** The best input has MSE
   skill 0.16 over the normal globally and 0.09 over North America.

The engine is therefore a **learned post-processor over physics ensembles plus a
harmonic climatology, with a verification ledger and a champion/challenger gate.**
Ingest, issue, verify and fit run in scheduled GitHub Actions (Python, GRIB). The
archive lives on R2, one Vercel route serves the output, and a pure JS kernel paints
the result and serves as the offline fallback.

The first thing to ship does not need ML at all. It is Phase 0 plus Phase 1:

- fix MSLP end to end
- replace the frozen and raw far-future frames with damped-toward-climatology frames
  using published coefficients

Based on the ACC figures, that should take day-14 RMSE from about 9.1 hPa to about
7.0 hPa before any server work.

---

## 1. What exists today (the seam)

### 1.1 What paints pressure at each point on the bar

| Scrub position | What paints channel P | Where |
|---|---|---|
| −7 d … now | Observation ring (IDB, 24 hourly frames) plus 72 h server backfill | `js/weather-history.js`, `api/weather/grid.js` |
| now … +20 h | In-browser RK2 advection. P is carried as a **passive tracer**: no tendency, no deepening or filling, no balance with the wind | `js/weather-flow.js:840-951`, `ForecastPaintProvider` pinned at `maxHorizonH: 24` (`earth.html:9983`) |
| +20 … +24 h | 4 h crossfade from RK2 to the forecast ring | `js/weather-frame-resolver.js` |
| +24 h … loaded depth | Open-Meteo **default model** (no `models=`), hourly `surface_pressure`, lerped. Eager to +7 d, lazy to +14 d | `js/weather-forecast-feed.js:83,131`, prefetch `earth.html:9648-9680` |
| past the loaded depth | **The deepest loaded frame, frozen** | `WeatherHistory.bracket` → `{before: newest, after: null}` |

The slider's range is `−10080 … +20160` min (`earth.html:4021`), and the time bus
matches it (`js/operations/time-bus.js:29-30`: `PAST_MS` 7 d, `FUTURE_MS` 14 d).

### 1.2 Problems

- **P1. Channel P is `surface_pressure`, not MSLP.** This comes from the cron
  (`api/cron/refresh-weather-grid.js:129`), `api/weather/grid.js:148`,
  `js/weather-feed.js:472` and `js/weather-forecast-feed.js:83`. The one exception is
  the MET Norway fallback, which writes MSLP into the same slot and tags it
  `__pressure_kind` (`refresh-weather-grid.js:394,438`), so P changes meaning depending
  on which upstream answered.
  - `js/weather-decode.js:137` clamps `(P−850)/210` to [0, 1].
  - `js/isobar-engine.js:130` decodes it back.
  - As a result, every surface below 850 hPa (Tibet, the Andes, Antarctica, Greenland)
    reads 850. The isobar layer and its H/L finder are contouring terrain, not weather.
    This is inferred from the code and not yet seen in a browser; Phase 0 screenshots it.
  - By convention, an isobar map is MSLP.
- **P2. Past about day 8, the bar paints a forecast worse than the normal.** A single
  IFS ensemble member (a deterministic run at ENS resolution, WB2 2020) has MSE skill
  against climatology of:

  | Lead | Global | North America |
  |---|---|---|
  | d10 | −0.22 | −0.47 |
  | d14 | −0.65 | −0.88 |

  The flatter statement is that its squared error is 65–88 % larger than drawing the
  normal. Open-Meteo's default model beyond the ECMWF/ICON horizons is GFS, which is not
  measured here (WB2 has no GFS). Nothing suggests it does better. Past the loaded depth
  the bar freezes a single frame, which behaves like persistence, and persistence is
  28–38 % worse than climatology in RMSE from day 4 on (§2).
- **P3. Nothing scores P beyond 24 h.**
  - `FORECAST_HORIZONS_H = [1,3,6,12,24]` (`js/weather-forecast.js:56`).
  - P is scored, but it is not in the skill grid, which shows T/U/V/RH only
    (`earth.html:10130`).
  - Found by reading the code, not by running it: pending records are capped at 256
    (`js/weather-forecast-validation.js:56`) and trimmed oldest-issued first. Each model
    keeps Σh = 46 records pending in steady state, and about a dozen models are
    registered. So the 12 h and 24 h rows are probably trimmed before they verify.
  - A +14 d forecast cannot be verified inside a browser session anyway. That part has
    to live on the server (Phase 3).
- **P4. The H/L finder works per frame** (`js/isobar-engine.js:337-389`). There is no
  tracking, no tendency and no notion of confidence.

### 1.3 What we reuse

- **The Forecaster interface and registry** (`js/weather-forecast.js`: `{static id,
  forecast(), forecastDense()}`) and the ForecastPaintProvider/resolver seam.
- **`forecast_log`** already accepts `valid_at` up to +14 d, rounded to 0.5°
  (`supabase-forecast-accumulator-migration.sql:276`).
- **`api/_lib/r2-client.js`**, a dependency-free SigV4 client already used by five
  routes, including `archive-forecasts`.
- **`js/forecast-verification.js`**: `crpsFromQuantiles`, `pitHistogram` and
  `reliabilityBins`, all node-tested.
- **`js/pipeline-registry.js`**: registering there is the step that gets a route onto
  `status.html` (CLAUDE.md §8).
- **The Python-trains → JSON-weights → JS-loads pattern** from `scripts/train_weather_lstm/`.

What we do **not** reuse:

- **`rust-forecast/`**: single point, 24 h cap, and never imported by any JS module,
  despite what `js/models-panel.js:9-12` says.
- **`weather_grid_cache` as a training store.** The 2026-09-18 HTTP 402 incident
  (`supabase-storage-reclaim-migration.sql`) settled that: training depth goes off
  Postgres.

---

## 2. What the data say (Phase-0 spike, measured 2026-09-24)

### Setup

- **Data:** WeatherBench2's public archive (`gs://weatherbench2`, plain HTTPS). MSLP on
  the **64×32 (5.625°)** grid, which is the closest standard grid to our 72×36 (5°).
- **Truth:** ERA5.
- **Test year:** 2020, 00/12Z inits.
- **Training data:**

  | Model | Training years |
  |---|---|
  | History-only models | 1990–2015 |
  | IFS HRES correction | 2016–2019 |
  | IFS ENS-mean correction | 2018–2019 |

- **Harness check:** the climatology, persistence, IFS-HRES-raw and IFS-ENS-mean-raw
  rows reproduce WB2's published `benchmark_results` to 0.01 hPa. The spike validated
  itself against someone else's numbers before any of its own were read.

### 2.1 Global MSLP RMSE (hPa)

| Model | d1 | d3 | d5 | d7 | d10 | d12 | d14 |
|---|---|---|---|---|---|---|---|
| climatology (1990–2019, per 6 h × day-of-year) | 7.05 | 7.06 | 7.07 | 7.08 | 7.08 | 7.07 | 7.07 |
| persistence (≈ what a frozen frame does) | 5.71 | 8.59 | 9.23 | 9.48 | 9.71 | 9.70 | 9.74 |
| damped anomaly persistence | 5.20 | 6.78 | 6.97 | 7.02 | 7.05 | 7.05 | 7.05 |
| **history-only ML** (EOF ridge on 28 y ERA5, t & t−24 h) | 3.89 | 6.14 | 6.69 | 6.89 | 7.03 | 7.08 | 7.10 |
| single IFS ENS member, raw (WB2 published) | 0.77 | 1.95 | 3.77 | 5.70 | 7.82 | 8.61 | 9.08 |
| IFS HRES raw | 0.53 | 1.34 | 2.88 | 4.82 | 7.22 | – | – |
| IFS HRES + learned correction (EOF-scale MOS) | 0.52 | 1.31 | 2.78 | **4.45** | **6.13** | – | – |
|   … plus history-only ML as a second predictor | 0.52 | 1.31 | 2.78 | 4.44 | 6.11 | – | – |
| IFS ENS mean raw | 0.55 | 1.33 | 2.64 | 4.06 | 5.58 | 6.14 | 6.48 |
| IFS ENS mean + learned correction | 0.54 | 1.31 | 2.63 | 4.06 | 5.57 | 6.14 | 6.47 |
| *GenCast ensemble mean (WB2 published, reference ceiling)* | *0.41* | *1.18* | *2.48* | *3.88* | *5.45* | *6.03* | *6.39* |

### 2.2 By region (d7 / d10 / d14)

| Region | Climatology | HRES raw | HRES + MOS | ENS raw | ENS + MOS |
|---|---|---|---|---|---|
| North America | 6.57 / 6.56 / 6.59 | 5.05 / 7.29 / – | 4.55 / 6.00 / – | 4.19 / 5.60 / 6.29 | 4.18 / 5.62 / 6.32 |
| Europe | 9.43 / 9.41 / 9.39 | 6.03 / 9.42 / – | 5.59 / 7.96 / – | 5.14 / 7.25 / 8.34 | 5.12 / 7.22 / 8.26 |
| NH extratropics | 8.32 / 8.31 / 8.28 | 5.53 / 8.29 / – | 5.11 / 7.08 / – | 4.69 / 6.45 / 7.50 | 4.69 / 6.45 / 7.51 |
| Tropics | 1.67 / 1.67 / 1.67 | 1.00 / 1.41 / – | **1.05** / 1.41 / – | 0.92 / 1.19 / 1.46 | **0.86 / 1.15 / 1.40** |
| SH extratropics | 9.48 / 9.47 / 9.47 | 6.60 / 9.88 / – | 6.06 / 8.32 / – | 5.51 / 7.57 / 8.79 | 5.51 / 7.57 / 8.78 |

What the learning is doing shows up in the learned slope, i.e. how much of the forecast
anomaly to keep:

| Lead | d1 | d5 | d7 | d10 | d14 | d15 |
|---|---|---|---|---|---|---|
| HRES slope | 0.99 | 0.91 | 0.79 | 0.53 | – | – |
| ENS-mean slope | 0.99 | 0.98 | 0.97 | 0.94 | 0.87 | 0.84 |

For a raw deterministic run, the published ACC at d14 is 0.18 globally and 0.09 over
North America. For equal-variance anomalies, the MSE-optimal slope *is* the ACC. That
implies damped RMSE ≈ σ_clim·√(1−ACC²):

| Region | Raw single member, d14 | Damped (estimate) |
|---|---|---|
| Global | 9.08 | ~6.95 |
| North America | 9.05 | ~6.57 |
| Europe | 11.72 | ~9.16 |

These are estimates from published ACC, **not fits**. Phase 1 turns them into fits.

### 2.3 How fast it learns (the "improves over time" question)

**Static fits on the N days before 2020, scored on 2020 (RMSE, hPa):**

| Input · lead | raw | 30 d | 90 d | 180 d | 1 y | 2 y | 4 y |
|---|---|---|---|---|---|---|---|
| HRES d7 | 4.82 | 4.58 | 4.49 | 4.47 | 4.45 | 4.45 | 4.45 |
| HRES d10 | 7.22 | 6.42 | 6.21 | 6.16 | 6.14 | 6.13 | 6.13 |
| ENS mean d10 | 5.58 | **5.70** | 5.63 | 5.60 | 5.58 | 5.57 | – |
| ENS mean d14 | 6.48 | **6.65** | 6.56 | 6.50 | 6.50 | 6.47 | – |

**Online cold start.** The learner begins 2020-01-01 with no data. Before each issue it
refits on every forecast that has already verified (init + lead ≤ issue time). The
figures are its RMSE ÷ raw RMSE; <1 means the learned model wins.

| Input · lead | Jan–Feb | Mar–Apr | May–Jun | Jul–Aug | Sep–Oct | Nov–Dec | Year |
|---|---|---|---|---|---|---|---|
| HRES d7 | 0.958 | 0.926 | 0.926 | 0.927 | 0.921 | 0.933 | 0.932 |
| HRES d10 | 0.916 | 0.853 | 0.851 | 0.858 | 0.841 | 0.869 | 0.864 |
| HRES d10, 60-day half-life | 0.917 | 0.857 | 0.853 | 0.857 | 0.847 | 0.868 | 0.866 |
| ENS mean d10 | 1.022 | 1.003 | 1.009 | 1.014 | 1.005 | 1.001 | **1.009** |
| ENS mean d14 | 1.016 | 1.015 | 1.012 | 1.017 | 1.002 | 1.008 | **1.011** |

### 2.4 Uncertainty (a Gaussian around the corrected ENS mean, σ from training residuals per lead × latitude row)

| Lead | 80 % band covers | CRPS (hPa) | 50-member ENS CRPS (WB2) | CRPSS vs Gaussian climatology |
|---|---|---|---|---|
| d3 | 84.1 % | 0.62 | 0.60 | 0.81 |
| d7 | 83.2 % | 1.77 | 1.71 | 0.45 |
| d10 | 82.1 % | 2.45 | 2.39 | 0.23 |
| d12 | 81.5 % | 2.72 | 2.66 | 0.15 |
| d14 | 80.9 % | 2.89 | 2.83 | 0.10 |

### 2.5 Findings, and the design rule each one sets

- **F1 — History is the teacher, not the input.** A single surface field cannot carry the
  3-D state that makes tomorrow's weather: the steering is at 500 hPa. So our archive's
  role is to supply training targets and verification. It is not a predictor.
  *Rule: no model may ship whose only input is our own pressure history (research
  leaderboard only).*
- **F2 — The input dominates the correction.** ENS-mean raw beats HRES + MOS from d5 on
  (d10: 5.58 vs 6.13). The same holds for the published GenCast row: an ML model that
  *is* an ensemble beats an ML correction of a deterministic run.
  *Rule: the engine's primary input is an ensemble mean, with deterministic runs as
  fallback and challenger members.*
- **F3 — The value of learning depends on what it corrects.** On a deterministic run the
  correction is worth 15–18 % at d10. On an ENS mean the global gain is nil: an
  ungated online learner is about 1 % *worse* all year, and fits on <1 year are worse
  than raw. The tropics are the exception (−3–8 %, a bias). A global EOF basis is
  extratropics-dominated and *hurts* the tropics at d7 (1.00 → 1.05).
  *Rule: the raw input is always a contender in the gate, and the correction is gated
  per lead × region. The tropics get their own basis or a per-row fit.*
- **F4 — It learns in weeks and saturates in months.** The linear layer's asymptote
  arrives at around 90 days. What more data buys is more parameters: season-specific
  slopes (≥1 year per season), per-cell rather than per-EOF slopes, weights across
  several centres, and nonlinear challengers.
  *Rule: start archiving inputs and outputs on day one; the archive is the asset.*
- **F5 — Calibrated spread does not need 50 members.** σ(lead, latitude) recovers 96–98 %
  of the full ensemble's CRPS. Members add flow dependence for the last few percent.
  *Rule: v1 ships P10/P50/P90 from mean + σ, and member spread enters as an EMOS term
  (σ² = c + d·s²) only if the gate says it helps.*
- **F6 — The day-14 ceiling is low.** Best-input MSE skill at d14 is 0.16 globally, 0.09
  over North America, 0.21 over Europe and 0.30 in the tropics after correction.
  *Rule: the bar discloses skill by lead from the ledger. Where the ledger says the
  engine is not measurably better than the normal, the map says "≈ normal for the date"
  and does not pretend otherwise.*

Two cautions came out of writing the spike:

- **The per-EOF slope is bounded to [0, 1.1].** Fitted from a handful of samples, the
  smallest scales have near-zero forecast variance, and the unbounded slope blew one
  cold-start run up 2.6×. The rule is that a correction may damp a scale but never
  amplify it by more than 10 %.
- **Inits with any NaN are dropped.** IFS ENS 2019-10-17 has holes.

Limits of the spike:

- It is 5.625°, not 5°.
- Its truth is ERA5, whereas the live engine verifies against the operational analysis.
  This is WB2's `hres_t0` question and is not measured here.
- The IFS archives are 2016–2020. Today's IFS is better, so pretrained slopes will
  under-trust it slightly until the online loop corrects them.
- There is one test year.
- GFS and GEFS are not measured. WB2 has neither, and our own ledger measures them in
  Phase 2 before a default input is chosen.

---

## 3. The engine

### 3.1 What it is, in one sentence

A learned, continuously verified post-processor that decides, per lead, region,
spatial scale and season, how much of each physics ensemble to believe; fills the rest
with climatology; and states how uncertain the result is. Everything it claims about
its own skill is read from its own ledger.

### 3.2 Architecture

```
            ┌──────────────────────── GitHub Actions (Python, 2×/day after 00Z/12Z ENS) ───────────────────────┐
 ECMWF ENS  │  ingest ──► regrid to 72×36 ──► L2 champion apply ──► issue P10/P50/P90 + skill meta              │
 (open data,│   (byte-range msl                                                  │                                 │
  AWS S3)   │    from .index)          L0 climatology (harmonic, ONE copy)       ▼                                 │
 GEFS mean/ │                                                      R2: pressure-outlook/issues/…  ◄── archive      │
 spread     │  verify: each new run's step-0 analysis scores every issue whose valid time it covers                │
 (NOAA S3)  │  fit:   nightly — update sufficient stats → refit L2 → weekly L3 challengers → GATE → publish model │
            └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                   │                                           │
                          /api/weather/pressure-outlook  (Vercel, s-maxage)    │  Supabase: pressure_skill_daily (aggregates only)
                                   ▼                                           ▼
   earth.html ── js/pressure-outlook.js (PURE: decode, clim eval, v0 damping, quantiles) ── ForecastPaintProvider/resolver
                  channel P for t > +24 h; isobars = P50; σ → confidence; skill strip from ledger
```

### 3.3 The layers

**L0 — Climatology.** One harmonic fit per cell of ERA5 1991–2020 MSLP, for both the
mean and σ: a constant plus annual, semiannual, 24 h and 12 h terms, with seasonal
modulation of the daily terms where the fit supports it. The 12 h term is the
semidiurnal atmospheric tide, about 1 hPa in the tropics, and it has to be in the normal
or every tropical forecast looks biased twice a day. That is 9–15 coefficients per
cell for each of mean and σ, ≈ 0.2–0.3 MB of float32, built once by a script. It is ONE copy: Python writes it, JS
reads it, and the Phase 1 test pins both evaluations to the same numbers. The spike's
climatology rows are the reference it must reproduce.

**L1 — Inputs (members).**

| Member | Source | Licence | Measured cost | Notes |
|---|---|---|---|---|
| ECMWF ENS (mean + σ over 51 members) | ECMWF open data AWS mirror `ecmwf-forecasts` (`…/ifs/0p25/enfo/*-enfo-ef.{index,grib2}`), 2023-01-18 → current | CC-BY-4.0 | msl is ~515 KB/member/step; 26 MB/step for all members; ~1.1 GB/run at 6-hourly to 144 h + 12-hourly to 360 h | best-verified input (F2); pretraining (WB2 IFS ENS) is consistent with it |
| GEFS (mean + spread, published as-is) | NOAA `noaa-gefs-pds` `geavg`/`gespr` `.pgrb2a.0p50`, current | public domain | PRMSL 174 KB + 146 KB per step; ~21 MB/run to 384 h | light; pretraining option: GEFSv12 reforecast 2000–2019 (`noaa-gefs-retrospective`, reachable) |
| Deterministic runs | Open-Meteo, already on the page (browser-direct) | CC-BY-4.0 | 0 new server calls | Phase 1 input and permanent offline fallback |
| AIFS-ENS (ECMWF's ML ensemble) | same AWS mirror, `aifs-ens/` | CC-BY-4.0 | not measured | a challenger member; "an ML model that is an ensemble" is F2's lesson |
| Current analysis anomaly | our observation ring (MSLP after Phase 0) | — | 0 | seam continuity at +24 h, not a predictor (F1) |

**L2 — The champion (v1, linear, interpretable, online).**

- Per member, a shrunk bias field plus scale-selective damping: one slope per EOF mode
  per lead per season, bounded to [0, 1.1].
- The tropics (|φ|<20°) use a per-latitude-row fit or their own basis (F3).
- Members are combined with non-negative weights, and whatever weight is left over goes
  to climatology.
- σ(lead, latitude, season) comes from verified residuals, plus an optional EMOS spread
  term.
- It updates from **sufficient statistics**: Σff, Σft and bias sums per lead × mode ×
  season, which are a few MB total. A nightly refit is milliseconds of arithmetic, and
  "improves over time" is literally new rows added to these sums.
- Pretraining is the prior: WB2 IFS ENS 2018–2022 and/or GEFSv12 (D5). A cold start
  with the prior b = 1 was measured to work (§2.3).

**L3 — Challengers (research until promoted).**

- **(a) Multi-centre weights** (ECMWF + GEFS + AIFS-ENS).
- **(b) A residual CNN/U-Net on the 72×36 grid.** Inputs: member anomalies, spreads,
  climatological σ, lead and day of year. Loss: CRPS. It would be pretrained on GEFSv12
  (20 years) and WB2 IFS ENS, then fine-tuned on our archive. The honest prior is that
  (b) may never beat L2 for MSLP at this resolution (F3); promoting it only through the
  gate is the whole point.
- **(c) History/analog models**, which stay on the leaderboard per F1.

**The gate.**

- Champion vs challenger, decided on CRPS over the trailing 60 days of *our* verified
  issues, per lead × region.
- A challenger takes over a cell of that table only when a paired bootstrap says the
  win is not noise.
- **The raw input is a permanent contender** (F3).
- The published model carries a versioned `model_id` (`pressure-mos-v1@YYYY-MM-DD`), so
  every archived issue says which model made it.

### 3.4 The learning loop (what "improves over time" is, mechanically)

1. **Issue** (2×/day): ingest, apply the champion, write P10/P50/P90 and the inputs to R2.
2. **Verify** (every run): each new run's step-0 analysis scores every archived issue
   whose valid time it covers, per lead × region, and appends to the ledger.
3. **Learn** (nightly): add the new (input, truth) pairs to the sufficient statistics,
   refit L2, and re-estimate σ.
4. **Compete** (weekly): retrain the L3 challengers on the archive plus reforecasts, run
   the gate, and publish the winner per lead × region.
5. **Say so:** the bar's skill strip and tooltips read the ledger. Until a lead has ≥30
   verified issues it says "verification accruing", following the Month-Ahead / Temp
   Outlook precedent.

The data-flywheel fact that makes this urgent: **the only lead-8-to-14-day training
pairs for our exact live inputs are the ones we archive ourselves.** Open-Meteo's
Previous Runs API is limited to leads of a few days (UNVERIFIED, since it is
egress-blocked at build time). The AWS ECMWF mirror could be back-filled to 2023, but
at ~1.1 GB per run (D6).

### 3.5 Output contract

`GET /api/weather/pressure-outlook` returns one issue:

```
{ v: 1, model_id, issued_ms, members: [{ id, run_ms }], grid: { w: 72, h: 36, lat0: -87.5, dlat: 5, lon0: -177.5, dlon: 5 },
  leads_h: [6, 12, …, 336],                       // 56 leads
  p50:   base64 Int16 (hPa − 1000) × 10,  lead-major, row-major S→N (the coarse-grid convention)
  sigma: base64 Uint16 hPa × 100,
  skill: { "<lead_h>": { crpss, rmse, n, by_region: { … } } },  // FROM THE LEDGER, absent until n ≥ 30
  freshness: 'fresh' | 'stale' }                  // stale when the issue is > 18 h old (CLAUDE.md §8)
```

That is ~580 KB raw per issue (gzip not measured). P10/P90 are derived client-side as
P50 ∓ 1.2816σ. The grid is ours (72×36), not WB2's. The Python regrid is conservative
(area-averaged from 0.25°/0.5°), the same operator WB2 used.

---

## 4. Where each piece runs

| Piece | Where | Why |
|---|---|---|
| Ingest, regrid, issue, verify, fit, gate | **Scheduled GitHub Actions**, Python + the `eccodes` wheel. `.github/workflows/pressure-outlook.yml`, code in `pipelines/pressure/` | GRIB2 decoding and ~1 GB of byte-range reads per run do not fit a 60 s Vercel function; scheduled Actions already work here (`dashboard-probe.yml`, `e2e-auth.yml`). Needs the R2 credentials as repo secrets |
| Archive (issues, inputs, verifications, model versions) | **R2**, `pressure-outlook/{issues,inputs,verify,models}/yyyy/mm/dd/HHz.*` | off-Postgres by decision (the 402 incident); R2 is already wired |
| Ledger for the UI | Supabase `pressure_skill_daily` (date, model_id, lead_h, region, n, sse, sse_clim, crps_sum), aggregates only, zero-policy RLS, service-role writes (the CLAUDE.md §4.2 pattern) | ~15 leads × 6 regions × ≤4 models ≈ 360 rows/day ≈ 130k rows/yr ≈ 15 MB; roll to weekly after 90 d. Not per-cell, and not per-issue |
| Serving | `api/weather/pressure-outlook.js`: reads the latest pointer from R2, returns the issue with `s-maxage`. Registered in `js/pipeline-registry.js` (`category: 'weather'`, `prewarm: 'cold'`) | one small cached response per session, instead of the browser walking Open-Meteo for P |
| Paint + offline fallback | `js/pressure-outlook.js` (PURE, node-tested: decode, climatology evaluation, v0 damping, quantiles, seam weights), wired through the existing ForecastPaintProvider/resolver | the fit lives in Python; the *apply* is mirrored in JS for the v0/offline path and pinned by a Python-written fixture (the WASM↔JS oracle pattern) |

**Budgets.**

| Item | Figure | Status |
|---|---|---|
| ECMWF ENS ingest | ~1.1 GB/run | measured per step |
| GEFS ingest | ~21 MB/run | measured |
| Actions time | ~5–10 min/run → 300–600 min/month | against 2000 free on a private repo; not measured |
| R2 growth | ~1–1.5 GB/yr (issues ~0.6 MB raw, inputs similar) | against the 10 GB free tier |
| Supabase | ~15 MB/yr | — |
| Open-Meteo | **zero new server-side calls** | — |

---

## 5. The bar (UI)

- **−7 d … now:** unchanged, but MSLP after Phase 0.
- **now … +24 h:** RK2 advection, unchanged, followed by the existing +20–24 h crossfade
  into the engine instead of into the raw ring.
- **+24 h … +14 d:** isobars are drawn from **P50**.
  - Confidence shows as isobar opacity keyed to the ledger's CRPSS at that lead. The
    alternative is a σ shading layer; see D1.
  - H/L labels appear only where the centre is deeper than about 1.5σ, which fixes P4's
    "every wiggle is a low" at long lead.
  - A provenance chip reads, for example: "Outlook · ECMWF ENS + learned correction ·
    issued 12Z · model v1@…".
  - The hover readout (`rd-pressure`) shows "1008 hPa (P10–P90 1001–1015)".
- **Where the ledger says CRPSS < 0.05**, the chip says **"≈ normal for the date"**.
  At day 14 over North America this will be common, and that is the finding (F6), not
  a bug.
- **A pressure skill strip** sits beside the existing wind strip (`#tc-skill-strip`),
  with leads 1/3/5/7/10/14 d read from the ledger.
- **Past any horizon we hold, relax to climatology; never freeze a frame** (P2).
- **Other channels (T, wind, cloud, precip) are untouched.** The kernel is
  channel-agnostic, so they can follow later (Phase 5).

---

## 6. Order of work (each phase ships on its own)

**Phase 0 — MSLP end to end (a bug fix; no ML).**

- Change `surface_pressure` → `pressure_msl` in the cron, `api/weather/grid.js`
  (`RANGE_KEEP_FIELDS`), `js/weather-feed.js` `_extractCoarse` and
  `js/weather-forecast-feed.js` `HOURLY_VARS`, and in the MET Norway mapping (which
  already *is* MSLP).
- Add a `pressure_kind` tag on every frame.
- Bump the IDB ring version so surface and MSL frames never lerp into each other at
  the seam.
- Add a node test for the P path (none exists today).
- Screenshot the isobar layer over the Tibetan Plateau before and after (P1 is inferred
  until then).

The payload shape does not change. `compute_weather_extremes` reads
`weather_grid_cache.payload` but does not reference pressure (grep, 2026-09-24), so the
rename is safe for it. Re-check before merging.

**Phase 1 — v0 "damped NWP" in the browser (no server).**

- `scripts/build-pressure-climatology.py` builds the L0 table from WB2 ERA5.
- The slopes b(lead, latitude) are fitted from a deterministic run through d15 against
  ERA5, using this spike's harness. The ACC-implied estimate in §2.2 is the sanity
  check.
  - Per D5 the default source is the **GEFSv12 reforecast control member** (NOAA,
    public domain), which has `pres_msl` per member and init: days 1–10 at 0.25°
    (~0.9 MB/step, `.idx` byte ranges) and days 10–16 in a second file. Daily leads
    cost ~16 MB per init, so every 5th day of 2000–2019 is ~23 GB of range reads, a
    one-off.
  - WB2's IFS single members are the alternative if D5 allows (the chunking forces
    reading all 50 members, several GB).
- `js/pressure-outlook.js` applies `clim + b·(f − clim)` to the Open-Meteo frames past
  +24 h, and past the loaded depth it relaxes to climatology.
- Disclosure chip: "correction fitted on reforecasts, not yet verified on this feed".

This fixes P2 on the day it ships.

**Phase 2 — The issue pipeline.**

- An Actions workflow ingests ECMWF ENS + GEFS, regrids, applies the WB2-pretrained L2,
  and writes to R2.
- The route plus its registry entry.
- The client switches P's far-future source to the route, with v0 as the offline
  fallback.
- **Archiving starts here (F4).**

**Phase 3 — Ledger, online learning and the gate.**

- Verification against the analysis.
- `pressure_skill_daily` plus its migration (documented in CLAUDE.md §4.2 as intentional
  zero-policy).
- Nightly refit, the gate, and the skill strip and chips reading measured numbers.

**Phase 4 — Challengers.** Multi-centre weights, the residual CNN (pretrained on
GEFSv12 + WB2, fine-tuned on the archive), and AIFS-ENS as a member. Each is promoted
only through the gate.

**Phase 5 (optional).** Generalise the kernel to T2m and wind; add cyclone-centre
tracking in the outlook with track uncertainty from σ, which pairs with the Storm Watch
panel.

**Invariants to add to CLAUDE.md when each lands:**

- F1 (history is the teacher).
- F3 (the raw input is always a contender; per-region gating).
- The [0, 1.1] slope bound.
- "Relax to climatology, never freeze".
- Skill claims come from the ledger only.
- MSLP wherever a contour is drawn.
- L0 is one copy.

---

## 7. What this plan deliberately does NOT do

- **Train a weather model from scratch.** WB2 shows what that costs and buys: GraphCast
  and GenCast are trained on 40 years of full 3-D ERA5 on accelerators. F1 shows what a
  surface-only model from our own history buys: nothing.
- **Put a neural net on the paint path before it beats the linear champion on our own
  ledger.** CLAUDE.md §7: physics-first, not ML black boxes. The ML here is the part
  that knows how far to trust the physics.
- **Store per-cell verification in Postgres.**
- **Change what the bar shows for channels other than P.**

---

## 8. Decisions for the author

- **D1 — What the far future *looks* like.** The honest P50 at day 14 is smooth: mostly
  the climatological Aleutian and Icelandic lows and the subtropical highs. It is the
  best estimate, but it looks "boring" next to a raw GFS day-14 storm.
  - *Recommendation:* P50 by default, plus an explicit **"one plausible scenario"**
    toggle that draws a single ensemble member, labelled as one member with its odds,
    never as "the forecast".
  - Also decide between confidence-as-opacity and a σ shading layer. Recommendation:
    opacity (less ink).
- **D2 — Primary input.**
  - *Recommendation:* **ECMWF ENS as primary** (best-verified, consistent with the
    pretraining, CC-BY-4.0) with **GEFS as the second member and fallback** (about 50×
    cheaper to ingest).
  - Let the Phase 2/3 ledger decide the weights, rather than choosing on reputation.
- **D3 — Where compute runs.**
  - *Recommendation:* GitHub Actions for ingest, issue and fit.
  - The alternative is a Vercel cron with a JS GRIB decoder. It would only work for
    GEFS, and would put the heavy fit inside the 60 s cap.
- **D4 — Scope.**
  - *Recommendation:* pressure only for now, with the kernel written channel-agnostic.
  - Pressure is the right first field: it is smooth, well observed, and the isobar
    layer already exists to show it.
- **D5 — Pretraining licence.**
  - ERA5 is under the Copernicus licence (commercial use with attribution).
  - WB2's IFS HRES/ENS archives are under ECMWF's general terms (attribution; read them
    for commercial *training* use).
  - GEFSv12 reforecasts are NOAA public domain.
  - *Recommendation:* anything *shipped* is pretrained on ERA5 + GEFSv12, or cold-started
    (§2.3 shows a cold start works). WB2 IFS stays a research yardstick unless you are
    comfortable with ECMWF's terms. This is the same kind of decision as TIGA's
    INTERMAGNET call.
- **D6 — Back-fill the archive?**
  - The AWS ECMWF mirror holds ENS runs from 2023-01-18. Back-filling the ENS-mean msl
    at 5° would cost ~1.1 GB of reads per run (roughly 2.7k runs ≈ 3 TB of range
    requests, spread over nights).
  - It would hand L3 about 3.7 years of *exactly* the live input on day one.
  - *Recommendation:* not for v1. F4 says the linear champion learns in 90 days.
    Revisit when a challenger needs depth.

---

## 9. Reproducing Phase 0

```
python3 -m venv .venv && .venv/bin/pip install -r scripts/pressure_outlook_spike/requirements.txt
.venv/bin/python scripts/pressure_outlook_spike/fetch.py /tmp/pspike     # ~45 s, ~600 MB
.venv/bin/python scripts/pressure_outlook_spike/spike.py /tmp/pspike     # ~4 min, 4 cores, ~6 GB RAM
```

- The results committed from the 2026-09-24 run are in
  `scripts/pressure_outlook_spike/results-2026-09-24.json`.
- The WB2 published rows (single member, GenCast) come from
  `gs://weatherbench2/benchmark_results/*_vs_era5_64x32_2020.nc`.

**Egress from the build sandbox (2026-09-24).**

| Reachable | Blocked |
|---|---|
| `storage.googleapis.com/weatherbench2` ✓ | Open-Meteo (all hosts, proxy 403) ✗ |
| `ecmwf-forecasts` (AWS) ✓ | `nomads.ncep.noaa.gov` ✗ |
| `noaa-gefs-pds` ✓ | `data.ecmwf.int` ✗ |
| `noaa-gefs-retrospective` ✓ | |
| `nsf-ncar-era5` ✓ | |

Everything the engine needs at run time is on the reachable side. The Open-Meteo facts
in this document are read from our own code, not probed.
