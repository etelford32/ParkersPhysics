# Temperature Outlook Engine — 30-day daily hi/lo per location

Status: **scoped, not built.** The seam it plugs into shipped 2026-09-21
(`js/temp-outlook.js` `projectDays`, drawn by the homepage sky console's
Temperature tab as the 30-day calendar). This document is the brief for
the engine that replaces the v0 formula behind that seam.

---

## 1. What exists today (the seam)

The homepage Temperature tab (`js/home-sky-console.js` → `renderTemp`)
draws a 30-day calendar from `buildTempModel()` in `js/home-conditions.js`,
which calls the PURE kernel `js/temp-outlook.js`:

| Piece | What it does now | Test |
|---|---|---|
| `buildWeekCandles` | 7-day hourly line + one candle per local day (open = midnight, close = 23:00, wick = day's high/low) | `tests/temp-outlook.mjs` |
| `climatologyByDoy` | per-date normals (hi / lo / mean) from the 3-year Open-Meteo archive the tab already fetches, circularly smoothed ±7 d (~45 samples per date) | same |
| `anomalyPersistence` | **the one thing v0 fits from history**: lag-1 autocorrelation of the daily-mean anomaly → e-folding time τ = −1/ln r₁, plus the anomaly σ | same — a synthetic AR(1) with known τ must be recovered |
| `projectDays` | **the v0 formula**, one row per day 0…30: leads 0–15 are Open-Meteo's deterministic NWP; leads 16–30 are `clim(doy) + A_tail · e^(−Δ/τ)` where A_tail is the mean NWP anomaly over leads 13–15, with expected miss `σ·√(1−ρ²)` | same |
| `buildMonthCalendar` | the grid: 1st of the month → today + 30, past days from the archive | same |

Every row carries `{ hiF, loF, meanF, source, tier, anomF, sigmaF }`. The
calendar, the cell colour (anomaly vs normal) and the tips read ONLY that
shape. **An engine that produces the same rows changes nothing downstream.**

Browser gate: `tests/home-temp-outlook.spec.js` (Open-Meteo mocked).

### What v0 gets right, and what it cannot do

- Right: the NWP horizon is drawn as NWP and nothing else; the tail relaxes
  toward the normal on a τ measured HERE (the AR(1) e-folding of surface
  temperature anomalies is 3–7 days in most mid-latitude places, and the
  fit reproduces that); the expected miss saturates at the climatological
  σ, which is the honest answer at week 4.
- Cannot: use any information past day 16 (no extended-range guidance),
  fit hi and lo separately (one τ for both), condition on the slow
  drivers (ENSO / MJO / AO-NAO — `js/s2s-outlook.js` already knows their
  tilts), or say anything about its own skill (no verification).

---

## 2. The engine — what "a formula for our various locations using historical data" means

Deterministic day-to-day skill is gone by ~10 days (Lorenz; the S2S module
header says this well). Past that, a 30-day daily number is **a conditional
climatology**: the normal for the date, tilted by whatever slowly-varying
state still carries information (the current anomaly and its persistence,
the extended-range ensemble mean, the teleconnection regime), with a
spread that says how little we know. The engine is therefore three layers,
each fitted per location from history, each verifiable:

### 2.1 Layer A — per-location statistical model (the "formula")

For each day-ahead lead L (1…30) and each target (Tmax, Tmin) a small
regression on features available at issue time:

```
anom(L) = a₀ + a₁·anom(0)·φ₁(L) + a₂·anom_ens(L) + a₃·ENSO·s(doy) + a₄·AO·s(doy) + a₅·MJO_phase_composite(doy) + ε
```

- `anom(0)`: today's departure from normal (observed).
- `φ₁(L)`: the persistence kernel — v0's `e^(−L/τ)` is the AR(1) special
  case; fitting it per lead lets a location with a two-timescale response
  (coastal vs continental) express it.
- `anom_ens(L)`: the ensemble-mean departure at lead L (Layer B).
- ENSO / AO / MJO terms: seasonally-weighted, signs from the composites
  already encoded in `js/s2s-outlook.js` (`computeOutlook`) — reuse them
  as priors, let the per-location fit scale them.
- Fit by ridge regression (the solver already exists in
  `js/temp-forecast.js` `ridgeFit`) on 10–20 years of dailies; residual σ
  by lead gives the calibrated spread. Hindcast-verified against the same
  archive (leave-one-year-out), so every location ships with a measured
  skill-by-lead curve, not a claimed one.

Where a location has too little history (or none — a new geocode), fall
back to v0 unchanged; the calendar prints "placeholder formula" as it does
today.

### 2.2 Layer B — extended-range ensemble guidance (the biggest single upgrade)

Open-Meteo's **Ensemble API** serves GEFS at 0.25° to **35 days**
(`https://ensemble-api.open-meteo.com/v1/ensemble?models=gfs025&daily=temperature_2m_max,temperature_2m_min&forecast_days=35`,
31 members, ~0.25 MB per location as daily aggregates). ECMWF IFS
ensemble runs 15 days, ICON EPS 7 days. **UNVERIFIED at build time** —
Open-Meteo is reachable from the browser in production but the exact
member count and `forecast_days` ceiling for `gfs025` must be confirmed
with one production request; record the answer next to the route.

What it gives: P10 / P50 / P90 of Tmax and Tmin per lead straight from a
dynamical model, for the whole 30 days, with spread that grows for real
reasons. Layer A's `anom_ens(L)` is its member mean; the calendar's cell
range (not yet drawn — see §4) is its P10–P90. Past ~day 20 the GEFS mean
converges on its own climatology; the per-location bias correction in
Layer A is what makes it OUR number rather than NCEP's.

### 2.3 Layer C — the slow drivers

Already served: `/api/weather/enso-mjo` (ONI + MJO RMM phase/amplitude)
and `/api/weather/teleconnections` (AO / NAO). `js/s2s-outlook.js`
converts them into tercile tilts by region and season. The engine reads
the SAME feeds and the SAME composites; it adds nothing here except a
per-location scale fitted in Layer A. (If the fit says the driver term is
insignificant for a location, it is zero there — "we only claim the
skill we can defend".)

---

## 3. What we need to build (the backlog)

### 3.1 Data

| Need | Source | Notes |
|---|---|---|
| **10–20 years of daily Tmax/Tmin/Tmean per location** | Open-Meteo archive (ERA5 / ERA5-Land, keyless) | The proxy `api/weather/forecast.js?type=archive` clamps at 365 days. Either raise the clamp for a server-side caller or add `type=climatology` that pages year by year (the archive API answers a full year per call). ~7 300 rows × 3 fields per location; fetch ONCE per location and cache server-side. |
| **35-day GEFS ensemble per location** | Open-Meteo Ensemble API | New route `api/weather/ensemble-extended.js` (typed proxy like `forecast.js`, 6 h cache TTL — GEFS runs 4×/day). Register in `js/pipeline-registry.js` (`category: 'weather'`, `prewarm: 'cold'`, `freshness` on a miss) or it is never monitored — CLAUDE.md §8. |
| **Driver indices** | existing `/api/weather/enso-mjo`, `/api/weather/teleconnections` | no change |
| **Historical driver indices** (for the fit) | NOAA CPC ONI table, CPC AO/NAO daily tables, BoM RMM | one-time ingest into a small `driver_history` table; the S2S module's composites need the historical phase to fit against. Egress-blocked at build time; fetch on a networked machine via a `scripts/fetch-driver-history.mjs`. |

### 3.2 Storage (Supabase — service-role-only, zero-policy RLS like `forecast_log`)

- `temp_climatology` — key `(lat2, lon2)` (2 dp, ~1.1 km, the
  `refresh-saved-locations` quantization), columns `doy`, `tmax_mean`,
  `tmin_mean`, `tmax_sd`, `tmin_sd`, `n_years`, `computed_at`. ~366 rows
  per location.
- `temp_model_params` — key `(lat2, lon2, target, lead)`, the fitted
  coefficients + residual σ + hindcast skill vs climatology and vs
  persistence. 60 rows per location.
- `temp_outlook_log` — one row per (location, issue_date, target_date,
  target): the issued P10/P50/P90 and, once the date passes, the archive
  truth. This IS the verification ledger; it follows the `forecast_log` /
  `cme_*` pattern (CME_FORECAST_VALIDATION_PLAN.md) and the
  `js/forecast-verification.js` scoring shape (MAE / RMSE / CRPS by lead,
  skill = 1 − MAE/MAE_ref).

### 3.3 Compute

- **`api/cron/temp-outlook-fit.js`** (weekly, `0 5 * * 1` — add to
  `vercel.json` `crons` or it never runs, CLAUDE.md §4.3): for every
  location in scope with a stale `computed_at`, fetch the climatology
  window, fit Layers A, write `temp_climatology` + `temp_model_params`.
  Vercel edge crons cap at 60 s — the fit is small (ridge on ~7 000 × 8),
  but the archive paging is I/O; budget like `refresh-saved-locations`
  (6 workers, 50 s wall, resume next run).
- **`api/cron/temp-outlook-issue.js`** (daily, after the 06z GEFS,
  `0 9 * * *`): for every location in scope, pull the ensemble, evaluate
  Layer A with today's anomaly + drivers, write the 30 rows to
  `temp_outlook_log`, and score every past row whose target date has
  now passed against the archive.
- **`api/weather/temp-outlook.js`** (GET `?lat&lon`): returns the latest
  issued 30 rows in the `projectDays` shape (+ `p10`/`p90`, + the
  location's skill-by-lead) with `freshness`; falls back to running v0
  server-side for an unknown location so the response shape never
  changes. The browser kernel keeps v0 as the offline path.
- The **PURE engine** lives in `js/temp-outlook-engine.js` (fit + evaluate,
  no I/O) so the cron, the route and `node tests/` all run one copy; the
  cron imports it from `js/` the way `api/cron/aurora-alerts.js` imports
  `js/flux-rope-forecast.js`.

### 3.4 "Our various locations" — what the scope set is

Three location populations exist today and the engine must say which it
serves:

1. **Saved locations of signed-in users** — `user_profiles.lat/lon`
   (what `api/cron/refresh-saved-locations.js` already enumerates; ~600
   distinct 2-dp coords). Precompute for all of them.
2. **The tz-guessed defaults** — the 60 cities in `TZ_CITIES`
   (`js/home-conditions.js`). Precompute; this is what a first-time
   visitor sees.
3. **The device-local watch list** — `ppx_user_locations` in localStorage
   (AurOracle), never on the server. On-demand only (the route's v0
   fallback, then a fit queued for the next weekly run once a location
   has been requested N times — a `temp_outlook_requests` counter).

Sizing at ~700 precomputed locations: 700 archive pages/week + 700
ensemble pulls/day, inside Open-Meteo's 10k/day free tier by a wide
margin; `temp_outlook_log` grows 700 × 30 rows/day ≈ 21k rows/day —
prune issued rows older than 120 days once scored (keep the scores).

### 3.5 UI (homepage calendar, then earth.html / the dashboard)

- Cell shows P50 hi/lo as today; the tip adds the P10–P90 range and the
  location's measured skill at that lead ("beats climatology by 18 % at
  day 20"); a `sigmaF`-scaled hairline under the numbers can draw the
  range without a second chart.
- Legend tiers become: model (1–10) · ensemble (11–30) · normal (fallback).
- Everything the engine claims about skill is a MEASURED number from
  `temp_outlook_log`; until a location has 30 scored issues, the tip says
  "verification accruing", exactly as the Month-Ahead panel does.

---

## 4. Order of work

1. `js/temp-outlook-engine.js` + `tests/temp-outlook-engine.mjs`: the
   Layer A fit/evaluate on the archive shape v0 already normalizes;
   hindcast harness (leave-one-year-out) that prints skill by lead for a
   CSV of locations. **No server work until this shows skill over v0 on
   held-out years** — if it does not, the engine is Layer B + C only.
2. The ensemble route + registry entry + one production probe to pin the
   GEFS horizon. Draw P10–P90 on the calendar tips.
3. Supabase migration (`supabase-temp-outlook-migration.sql`, three
   tables, zero-policy RLS, documented in CLAUDE.md §4.2 as intentional).
4. The two crons + the route; `status.html` picks the route up from the
   registry.
5. Switch the homepage tab to the route with v0 as its offline fallback;
   the browser gate keeps mocking Open-Meteo and gains a mocked route.

## 5. Open questions for the author

- Does the engine serve population 3 (device-only watch lists) at all, or
  only what the server knows? (Affects whether the browser ever runs the
  fit itself — it could: the ridge solver is 60 lines and the archive
  fetch is already in the tab.)
- Fahrenheit is baked into every shape here (`hiF` / `loF`); the
  dashboard's Month-Ahead panel is unit-free (terciles). A Celsius toggle
  is a rendering concern, but the ledger should store °C or K to match
  the archive and convert at the edge.
- The weekly fit's location set: everyone in `user_profiles`, or only
  rows with `daily_digest_enabled` like the warm-cache cron? The latter
  is the tighter, cheaper scope; the former is what the B2G pitch wants
  ("every operator site gets a fitted local model").
