# Climalytix — location-first multi-dataset climate & weather analytics

Status: **PLANNED, nothing built** (2026-11-08). This is the design brief for
`climalytix.html`, the flagship analysis workspace. It sits ON TOP of the
weather / climate machinery the site already ships and must not fork any of it
(§3 lists what it reuses, by file).

---

## 1. The product in one paragraph

A user picks **one site** (a farm, a substation, a launch pad, a city, a
reservoir). Climalytix pulls every dataset the platform can reach for that
point — 85 years of reanalysis, live observations, multi-model and ensemble
forecasts, the slow climate drivers (ENSO / MJO / AO / NAO / polar vortex),
air quality, ocean, river, fire, space weather — puts them on **one time axis**,
and lets the user (a) explore and relate them, (b) define the **events** that
matter to them ("3+ days above the 95th percentile", "frost after 200 GDD",
"river discharge above the 10-year level", "fire weather FWI > 30 and AQI >
150"), and (c) get a **calibrated probability** for each event over any future
window, from the next hour to 2050, with the evidence, the driver attribution,
and a **measured track record** at that site beside every number.

What makes it commercial grade is not the chart count. It is three
guarantees no consumer weather app makes:

1. **Every number has provenance** — which dataset, which version, observed vs
   modelled vs scenario, and how fresh.
2. **Every probability is scored** — issued predictions are locked, then scored
   against what happened, and the site's own reliability is shown.
3. **The horizon decides what we're willing to say** — a deterministic value only
   inside the deterministic horizon, probabilities beyond it, scenarios (never
   "forecasts") for decades out.

Positioning (CLAUDE.md §7): physics-first and verified, never "AI-powered".
Any statistical or ML component is a *logged, scored member* (the
`EARTH_ML_FIRST_PRINCIPLES.md` rule), not a special oracle.

---

## 2. Who pays and what they decide with it

| Segment | Site | Events they buy | Horizon |
|---|---|---|---|
| Agriculture / ag-lenders | farm, county | frost after green-up, GDD, drought (SPEI), heat stress on crops | 1 d – season |
| Energy & utilities | substation, wind/solar plant | heat-driven load, wind/solar ramps, icing, wildfire PSPS weather | 1 h – season |
| Insurance / reinsurance | portfolio point | return levels (100-yr rain/wind/heat), trend-shifted risk, compound events | climatology – 2050 |
| Municipal / emergency mgmt | city | heatwaves, flood, AQ exceedance, cold outbreaks | 1 d – 6 wk |
| Construction / events / logistics | job site, venue | workable days, lightning, wind, WBGT | 1 h – 6 wk |
| Space & ground segment (our core B2G) | launch pad, ground station | launch-weather + space weather on the same clock, rain fade, Kp | 1 h – 2 wk |

The last row is our wedge. Nobody else puts tropospheric weather and space
weather on one verified clock for a single site.

**Open decision for the author (CLAUDE.md §7):** do we build it for B2G and
operators first (API + reports + audit trail up front) or for consumers and
prosumers first (the UI and tiers)? The phasing below assumes **operator-first
UI with consumer-friendly defaults**. It is the one product decision this plan
can't make by itself.

---

## 3. What already exists, and is reused rather than rebuilt

| Need | Existing code (the ONE copy) |
|---|---|
| Location store + `user-location-changed` | `js/user-location.js`, saved places `js/saved-locations.js`, Home = `user_profiles.location_*` (`js/climate-lab/lab-home.js`) |
| Per-site ERA5 archive, normals by DOY, AR(1) τ | `js/home-conditions.js` `fetchClimate`, `js/temp-outlook.js` (`climatologyByDoy`, `anomalyPersistence`, `projectDays`) |
| Gridded 1991–2020 normals + rarity percentiles | `js/temperature-normals.js` + `assets/temperature/*.bin` |
| Short-range multi-model point forecast + quantiles | `rust-forecast/` (5-member blender, P10/50/90), `/api/weather/forecast` (typed proxy) |
| 4-model exceedance probability | `/api/weather/probability` |
| S2S tercile engine + drivers | `js/s2s-outlook.js`, `js/month-outlook.js`, `/api/weather/enso-mjo`, `/api/weather/teleconnections`, `/api/weather/polar-vortex`, `/api/weather/surface-outlook` |
| Derived indices | `js/composite-indices.js` (heat index, wind chill, frost…), `js/climate-lab/lab-physics.js` (air density, density altitude) |
| Renewables | `/api/weather/renewables` |
| Air quality (CAMS, hindcast + forecast) | `/api/air-quality/*`, `js/air-quality-feed.js`, `js/aqi-scale.js` |
| Ocean / tides / buoys | `/api/ocean/*` |
| Hazards | `/api/wildfires/events`, `/api/lightning/strikes`, `/api/volcanoes/activity`, `/api/nws/*` |
| Space weather | SWPC feeds, `js/verdict-engine.js` (`auroraVerdict`), Kp forecasts |
| Time-series reader with provenance | `js/weather-cube.js` (new variables join as SOURCES — the rule this plan follows) |
| Scoring | `js/forecast-verification.js` (CRPS, Brier, reliability, PIT), `js/forecast-validation.js` (MAE / skill) |
| Ridge regression | `js/temp-forecast.js` `ridgeFit` |
| Feed monitoring / prewarm | `js/pipeline-registry.js` (every new route MUST register) |
| Tier gating + cloud-synced workspaces | `js/tier-config.js`, `js/dashboard-sync.js` + `public.dashboards` |
| Charts palette discipline | the meteogram's small-multiples rule (`js/climate-lab/lab-charts.js`) |

The 30-day temperature engine scoped in `TEMP_OUTLOOK_ENGINE_PLAN.md` and the
pressure work in `PRESSURE_OUTLOOK_ENGINE_PLAN.md` become **members** of
Climalytix's prediction ladder. They are not re-planned here.

---

## 4. Architecture

```
climalytix.html  (vanilla HTML + ES modules, no bundler/framework — CLAUDE.md §1)
 │
 ├─ js/climalytix/site.js            site selection, URL state (?lat&lon&ws=), one site at a time
 ├─ js/climalytix/catalog.js         PURE: dataset registry (§5) — ids, variables, units, kinds, horizons
 ├─ js/climalytix/site-store.js      PURE: aligned multi-series store (§4.1)
 ├─ js/climalytix/loaders/*.js       one adapter per dataset → SiteSeries (thin; calls existing routes)
 ├─ js/climalytix/worker.js          ALL analysis runs here (Web Worker) — the main thread only draws
 ├─ js/climalytix/kernels/*.js       PURE, node-gated analysis kernels (§6)
 ├─ js/climalytix/events.js          PURE: event DSL → evaluator (§7)
 ├─ js/climalytix/predict/*.js       PURE: prediction ladder members + combiner (§8)
 ├─ js/climalytix/ui/*.js            panels: timeline, catalog, event board, relationships, extremes, verify, report
 │
 ├─ api/climalytix/archive.js        site archive bundle (ERA5 daily+hourly, cached to R2 by rounded site)
 ├─ api/climalytix/ensemble.js       GEFS / ECMWF-ENS members for a point (NEW upstream, §5)
 ├─ api/climalytix/hindcasts.js      past NWP runs for calibration (NEW upstream, §5)
 ├─ api/climalytix/projections.js    CMIP6 downscaled daily (NEW upstream, §5)
 ├─ api/climalytix/hydro.js          river discharge (GloFAS) + USGS streamflow (NEW)
 └─ api/climalytix/v1/*              Enterprise API (Phase 6) — same kernels, server-side
```

### 4.1 The `SiteSeries` contract (the one schema every dataset speaks)

```
{
  id: 'era5.t2m.daily.max',          // stable dataset-variable id
  variable: 'tmax', units: 'degC',   // SI internally; converted ONCE at display (lab-units rule)
  kind: 'observed' | 'reanalysis' | 'nowcast' | 'forecast' | 'ensemble'
        | 'outlook' | 'index' | 'derived' | 'scenario',
  cadence: 'PT1H' | 'P1D' | 'P1M',
  agg: 'mean' | 'sum' | 'max' | 'min' | 'instant',   // decides resampling semantics
  t: Float64Array (epoch ms, UTC),  v: Float32Array, // gaps are NaN in storage, null at the API — NEVER 0
  members?: Float32Array[]           // ensemble kinds
  issuedAt?: ms                      // forecasts: the run time (needed for honest verification)
  provenance: { source, url_id, version, fetchedAt, freshness: 'live'|'stale'|'expired', note? },
  spatial: { kind: 'point'|'cell', resKm, distanceKm }   // a 25 km reanalysis cell ≠ a station; say so
}
```

Rules, each one inherited from a scar elsewhere in the repo:

- **Align by instant, never by array index** (the pollution time-machine rule).
- **Resample by `agg`**: precip SUMS, temperature max uses MAX, wind is a VECTOR mean
  (the MET Norway upsampler scar). A wrong aggregation is a silent failure, so the
  store refuses to resample a series without an `agg`.
- **Gaps are not zeros** end to end (`Number(null)` is 0 — the guard is load-bearing).
- **Local day = the site's solar/civil day**, chosen once per site and printed. A UTC
  day boundary splits a Pacific afternoon in half.
- **Forecast series keep `issuedAt`**. Verification compares a lock to later truth and
  never to a re-fetched forecast.

### 4.2 Compute budget

One site is small. 85 years × 365 days × ~30 variables is about 1 M floats daily,
plus 2 years hourly (~0.5 M). Every kernel in §6 runs in the browser worker in
well under a second, apart from the weather-generator Monte Carlo (§9), which
runs incrementally with a progress bar. There is **no per-request server compute**
except the Enterprise API. Server routes are proxies with edge caching keyed on
the site rounded to 0.05° (~5 km, inside reanalysis cell size), so popular
places collapse to one upstream hit. Heavy archive bundles go to R2 (the
`SUPABASE_OFFLOAD_PLAN.md` pattern), **never** into Postgres.

---

## 5. The dataset catalogue

Tier: E = existing route, N = new route. ⚠ = upstream schema unverified (egress-blocked
at build time) → resolve via a CANDIDATE LIST, self-report `field_map`, answer
`freshness:'stale'` on a miss, and one production request settles it (the
noaa-regions / mars-tiles pattern).

| Group | Dataset | Kind | Span | Tier |
|---|---|---|---|---|
| Reanalysis | ERA5 / ERA5-Land via Open-Meteo archive (T, Td, P, wind, gust, SW rad, soil moisture/temp, snow depth, ET₀) | reanalysis | 1940 → T-5 d | E (extend fields) |
| Normals | 1991–2020 site normals + percentiles (computed from the bundle) | derived | — | N (kernel) |
| Observations | NWS station obs (US) | observed | recent | E |
|  | NOAA GHCN-Daily nearest stations ⚠ | observed | 1800s → | N |
|  | NOAA buoys / tides | observed | recent | E |
| Short-range NWP | GFS, ECMWF IFS, ICON, GEM, (+ HRRR/NAM US) | forecast | 0–16 d | E |
| Ensembles | GEFS 31, ECMWF-ENS 51 via Open-Meteo ensemble API ⚠ | ensemble | 0–35 d | N |
| Hindcasts | Open-Meteo historical-forecast / previous-runs API ⚠ (needed for calibration) | forecast | ~2 yr back | N |
| Our blender | `rust-forecast` P10/50/90 | forecast | 0–24 h | E |
| S2S | tercile engine (ENSO/MJO/AO/NAO) + polar-vortex regime | outlook | wk 2–6 | E |
| Seasonal | ENSO-conditioned climatology (kernel §8.4) | outlook | 1–6 mo | N (kernel) |
| Climate | CMIP6 HighResMIP downscaled via Open-Meteo climate API ⚠ (multiple models) | scenario | → 2050 | N |
| Drivers | ONI, RMM, AO, NAO, U10@60N | index | daily/monthly | E |
|  | PDO, AMO, IOD, QBO (NOAA PSL ascii) ⚠ | index | monthly | N |
| Hydrology | GloFAS river discharge via Open-Meteo flood API ⚠ | reanalysis + forecast | 1984 → +7 mo | N |
|  | USGS NWIS streamflow (US) ⚠ | observed | 1900s → | N |
| Air | CAMS PM2.5 / O₃ / dust hindcast + forecast | forecast | −5 → +5 d | E |
| Ocean | SST / waves (marine API) | forecast | ±7 d | E (extend) |
| Hazards | EONET wildfires, lightning, volcanoes, NWS alerts | observed | live | E |
| Space weather | Kp observed + 3-day forecast, aurora verdict, GOES X-ray | observed/forecast | live | E |
| Solar resource | NASA POWER ⚠ (SW, PAR, clear-sky index) | reanalysis | 1981 → | N |

Every new route registers in `js/pipeline-registry.js` in the same commit, or it
is unmonitored (the `/api/mars/weather` scar).

**Licensing check per source before it ships** (the TIGA rule: INTERMAGNET was
excluded for CC BY-NC). Open-Meteo's free tier is non-commercial. **A commercial
Climalytix needs an Open-Meteo commercial API key (or a self-hosted
Open-Meteo instance on our own Copernicus/NOAA download).** This is a hard
blocker for a paid launch and is called out again in §12.

---

## 6. Analysis kernels (PURE, node-gated, closed-form fixtures)

Each kernel lives in `js/climalytix/kernels/`. It is imported by the worker and
by the Enterprise API, and tested with `node tests/climalytix-<name>.mjs` against
published worked examples, never against its own earlier output.

| Kernel | What | Gate fixture |
|---|---|---|
| `climatology` | per-DOY smoothed mean/σ/quantiles over a chosen base period (default 1991–2020), circular window | reuse `temp-outlook` fixture + synthetic sinusoid |
| `anomaly` | anomaly, standardized anomaly, **empirical percentile (rarity)** — not Gaussian z (PLANETARY_TEMPERATURE_LAB §2: z miscalibrates 1 % tails up to 3×) | uniform-rank identity |
| `trend` | Mann–Kendall + Sen slope with Hamed–Rao autocorrelation correction; seasonal MK | Hirsch 1982 worked example |
| `changepoint` | PELT on mean/variance, BIC penalty | planted step |
| `eva` | GEV (block maxima) and GPD (peaks over threshold, declustered) via L-moments + MLE; return levels with profile-likelihood CIs; **non-stationary** GEV with a covariate (year, ENSO, global T) | Hosking & Wallis L-moment tables; Coles 2001 Port Pirie example |
| `relate` | lagged correlation with effective-N (Bretherton 1999), partial correlation, mutual information; driver-phase **composites** with bootstrap significance | AR(1) red-noise null: false-positive rate ≤ α |
| `spells` | run-length analysis (heatwaves, dry spells, freeze runs), onset/end dates, the season's statistics | hand-counted series |
| `indices` | SPI / SPEI (gamma / log-logistic), GDD/CHU, heating/cooling degree days, WBGT (Liljegren), Canadian FWI system, chill hours | Van Wagner 1987 FWI test table; FAO-56 examples; McKee SPI |
| `physics-column` | §9.1 — site water and energy column | FAO-56 Ex. 17/18 (ET₀) |
| `resample` | the `agg`-aware resampler (§4.1) | vector-mean wind, precip sum |

`tests/climalytix-*.mjs` go into a CI workflow `climalytix-kernels.yml` from day one.

---

## 7. Events — the heart of the UX

An **event** is a user-defined, versioned, serialisable rule over one or more
datasets at the site:

```
{ id, name, version,
  when: AND/OR tree of conditions,
  condition: { series: 'tmax', op: '>', threshold: { kind: 'percentile', p: 95, base: '1991-2020', doy: true }
               | { kind: 'absolute', value: 35, units: 'degC' }
               | { kind: 'return-period', years: 10 },
               window: { reduce: 'max'|'sum'|'mean', span: 'P3D' }, persist: 'P3D' },
  across: [ … other conditions, optionally on other datasets, with lags ('tmax > p90 AND spei_3 < -1 within 14 d') ] }
```

- A **template library** ships first: heatwave (WMO and local percentile definitions),
  cold outbreak, hard freeze after green-up, heavy-rain return period, dry spell,
  flash-drought onset (SPEI fall rate), compound hot-dry-windy (fire weather), river
  flood level, AQ exceedance (EPA PM2.5 sub-index), icing, workable-day, launch-weather,
  geomagnetic storm (Kp ≥ 7) during a ground-station pass.
- The **same evaluator** runs on (a) history, giving a base rate and an event catalogue
  with dates, (b) every forecast member, giving a probability, and (c) every weather-
  generator realisation, giving rare-event odds and scenarios. One definition gives three
  consistent answers. That is the integration the user asked for.
- Thresholds in percentiles are **seasonal by default** ("hot for the date"), with
  absolute available. The card says which.

---

## 8. The prediction ladder — what we're willing to say at each horizon

Every prediction is `P(event in window)` with an uncertainty band, a reliability
grade measured at THIS site, and the members that produced it. The ladder hands off
by lead time. Each rung is a scored member, and the combiner only weights members by
measured skill.

| Rung | Lead | Members | Output |
|---|---|---|---|
| 8.1 Nowcast | 0–6 h | latest obs + `rust-forecast` blender + radar-free persistence | values + P10/50/90 |
| 8.2 Short range | 6 h – 10 d | multi-model NWP + GEFS/ENS members, **calibrated per site** with EMOS / NGR (Gneiting 2005) fitted on the hindcast archive vs ERA5/obs (bias + spread), rolling 60-day training window | calibrated ensemble → event probability |
| 8.3 Sub-seasonal | wk 2–6 | ENS extended + `s2s-outlook` driver tilt + analog days (driver-state nearest neighbours in the 85-yr record) + `TEMP_OUTLOOK_ENGINE_PLAN` ridge | **probabilities only**, never a single number |
| 8.4 Seasonal | 1–6 mo | driver-conditioned climatology (ONI forecast phase × site composite), linear trend term, GloFAS seasonal for rivers | tercile + event base-rate shift |
| 8.5 Climate | 2030–2050 | CMIP6 ensemble deltas applied to the site's observed distribution (quantile delta mapping) | **scenario**: "under SSP2-4.5 the 1-in-20 heat day becomes 1-in-N" — never labelled a forecast |

Combiner: logarithmic opinion pool / stacking weighted by each member's
rolling CRPS at this site and lead, falling back to equal weights below n = 30
scored cases (and saying so). The ceiling discipline from `s2s-outlook.js` carries
over: past ~10 days a probability tilt is capped at what published S2S skill
supports, unless this site's own verification earns more.

### 8.6 The prediction ledger

Issued predictions (by a user, or by the nightly auto-issue for saved sites and
events) are **locked**: event version, member versions, dataset `provenance`
hashes, issuedAt. They're scored when truth arrives (Brier, CRPS, reliability,
ROC/AUC, and skill vs climatology and vs persistence). The Verify tab shows the
site's reliability diagram per rung. The scoring rule copies the flux-rope ledger's
`selectScorableLock`: only locks issued before the event window opens count.

Storage: `climalytix_predictions` (owner-RLS, user data) + `climalytix_scores`.
Auto-issue at scale is bulk data, so it goes to R2 with a Postgres index (the
`weather_grid_archive` pattern), per `SUPABASE_OFFLOAD_PLAN.md`.

---

## 9. The "deeper climate modelling" layer

This is what turns Climalytix from a dashboard into a simulation, and it is
physics-first.

### 9.1 Site physics column (`kernels/physics-column.js`, JS oracle → `rust-climalytix` later)

A daily, forced, single-site land-surface column driven by ERA5 history or by
any forecast or generated weather:

- **Reference ET** — FAO-56 Penman–Monteith (gated against FAO-56's own worked examples).
- **Soil water** — two-layer bucket (Manabe-style) with crop coefficient Kc
  curves, giving a soil-moisture deficit and **agricultural drought** that responds to
  forecast rain instead of only reading past indices. Calibrated against ERA5-Land
  soil moisture at the site, and the residual is shown.
- **Snowpack** — degree-day melt plus rain/snow partition (wet-bulb based), giving SWE,
  melt-driven runoff timing.
- **Fuel moisture & fire danger** — the Canadian FWI system (FFMC/DMC/DC/ISI/BUI/FWI)
  carried continuously, so a forecast inherits the right starting state (FWI codes have
  memory; a cold start is wrong for weeks, the `SPIN_UP_YEARS` lesson from volcanoes).
- **Heat stress** — WBGT and UTCI-lite from forecast T/Td/wind/radiation.
- **Crop thermal time** — GDD with base/cap by crop, phenology stage estimate,
  frost-after-stage risk.

Because the column is forced, it is also a **what-if engine**. Run it through the
ensemble and you get probabilistic soil-moisture/FWI forecasts. Run it through the
generator (9.2) and you get climate risk.

### 9.2 Stochastic weather generator (`kernels/weathergen.js`)

A site-calibrated, multisite-free Richardson/WGEN-class generator, upgraded:

- precipitation occurrence as a 2nd-order Markov chain per month; amounts as a
  gamma body + GPD tail (so it actually reproduces the 100-year day, which a gamma
  alone under-predicts);
- Tmax/Tmin/radiation as a trivariate AR(1) conditioned on wet/dry state, with
  seasonally varying parameters;
- **driver conditioning**: parameters shifted by ENSO phase (fitted from the site's
  composites), so "1,000 synthetic La Niña winters at this farm" is one click;
- **climate conditioning**: parameters perturbed by CMIP6 change factors (§8.5).

Validation gate: generated decades must reproduce the observed monthly means and
variances, wet-spell length distributions, and GEV return levels inside their CIs.
A **negative control** (a plain gamma without the GPD tail) must fail the tail test.

Uses: rare-event probabilities beyond the 85-year record, compound-event odds
(hot AND dry AND windy) with the observed dependence intact, and the scenario
tab's "what if this were an El Niño year / a +1.5 °C world".

### 9.3 Scenario studio

The user perturbs drivers (ENSO state, AO, warming level, irrigation, crop type)
and sees every event probability, the physics column and the return levels move.
Every scenario output is labelled SCENARIO in the UI chrome, in exports and over
the API.

---

## 10. UI — `climalytix.html`

Desktop-first, operator density, responsive to 768 px (DESIGN_TOKENS.md).

```
┌ site bar: [search / pin / saved sites ▾]  Boulder, CO · 40.01 N 105.27 W · 1655 m · cell 9 km · local day = MST  [⧉ workspace ▾] [Report] ┐
├ catalogue (left) ──────┬ main (tabs) ─────────────────────────────────────────────────┬ events & predictions (right) ─┤
│ ▸ Reanalysis      ● live│ Overview | Explore | Relationships | Extremes | Predict |     │ ▸ Heatwave (local p95, 3 d)   │
│   ☑ Tmax  ☑ Precip      │ Physics | Scenarios | Verify                                  │   next 7 d   23 %  ▮▮▱  B+    │
│ ▸ Forecasts       ● live│                                                               │   wk 3–4     41 % (↑ ENSO)    │
│   ☑ ECMWF-ENS (51)      │  ONE time axis: history ─ │ now │ ─ forecast ─ outlook ─ scen.│   2050 SSP2  1-in-3 yr (scen.)│
│ ▸ Drivers         ● live│  small multiples, shared crosshair, shaded by `kind`          │ ▸ Hard freeze after 200 GDD   │
│ ▸ Hydrology       ◐ stale│  (observed solid · forecast fan · outlook terciles · scen.) │ ▸ + New event (templates)     │
│ ▸ Air / Ocean / Hazards │                                                               │ Ledger: 142 scored · BSS .21  │
│ ▸ Space weather         │                                                               │                               │
└─────────────────────────┴───────────────────────────────────────────────────────────────┴───────────────────────────────┘
```

- **Overview**: a one-screen briefing: today vs normal (percentile), the active
  drivers, the next three notable events with probabilities, and data health.
- **Explore**: the aligned timeline. Zoom runs 1940 → 2050 continuously, with
  per-series resample, anomaly/percentile toggles, and seasonal-cycle overlays
  ("this year vs normal vs record").
- **Relationships**: lag-correlation matrix across the selected series and drivers,
  composites ("July Tmax in El Niño vs La Niña years here"), significance shown
  honestly (effective N).
- **Extremes**: return-level plots with CIs, stationary vs non-stationary, and the
  record table.
- **Predict**: the event board, a fan per event across rungs, member breakdown,
  driver attribution.
- **Physics**: soil water, SWE, FWI, WBGT and GDD curves (history + forecast fan).
- **Scenarios**: §9.3.
- **Verify**: the site's reliability diagrams, skill by lead, ledger table, and
  data-coverage audit.
- **Report**: a PDF/CSV/JSON export with provenance appendix and methodology text
  generated from the actual members used (B2G deliverable).

Charts follow the repo's rules: small multiples on one shared axis, never a dual
axis; magnitude palette ≠ identity palette; series colour bound to the
quantity, never its position. Status uses icon + label chips. Probabilities print
with their reliability grade, and a probability without a scored history says
"unverified here".

Navigation: Earth & Orbit → Earth systems (check the ≤10-link cap in
`js/site-sections.js` first, since overflow goes to the hub page), plus a
hero card on `earth-orbit.html` via the builder. The page must pass
`scripts/lint-nav.mjs` and `tests/importmap-order.mjs`.

---

## 11. Commercial layer

| Capability | Free | Basic | Advanced | Institution / Enterprise |
|---|---|---|---|---|
| Sites | 1 (Home) | saved-location quota | quota | quota + API batch |
| History depth | 10 yr | full 1940 → | full | full |
| Datasets | core 6 | + drivers, AQ, ocean | everything | everything + custom upload (CSV / their station) |
| Event builder | templates | custom | custom + compound | custom + shared team library |
| Horizons | to 7 d | to 6 wk | + seasonal, scenarios, generator | + 2050 projections |
| Ledger / Verify | view | issue + score | auto-issue nightly | + exportable audit trail |
| Export | — | CSV | CSV + PDF report | + API, white-label reports |

- Gating goes through `js/tier-config.js` only (add `climalytix*` capability flags
  there and in the SQL, in the same commit). Workspaces sync through the existing
  `public.dashboards` table (page `'climalytix'`) with `dashboard-sync.js`, local-first.
- **Bring-your-own data** (Enterprise): upload a station CSV and it becomes a
  `SiteSeries` (`kind:'observed'`, `provenance.source:'user'`). It can then
  calibrate the forecasts, which is the single strongest commercial hook. Stored
  per-org in R2, never shared.
- **Enterprise API** `/api/climalytix/v1/{site,events,predict,scores}`: the same
  kernels server-side, keyed, rate-limited, and auditable. Multi-site is the API's
  job, so the UI stays one site at a time.
- **Reproducibility**: every report and API answer carries the event version, the
  member versions and the dataset provenance hashes, so it can be re-run bit for bit.

---

## 12. Risks and blockers

1. **Licensing (hard blocker for paid tiers):** Open-Meteo free tier is non-commercial.
   We need a commercial key or a self-hosted instance. CMIP6 / GloFAS / ERA5 are
   Copernicus-licensed (commercial use allowed with attribution). Check each new
   source before shipping it behind a paywall.
2. **Reanalysis ≠ station.** ERA5 is a ~25 km (ERA5-Land ~9 km) cell. Mountain and
   coastal sites are biased. Mitigations: show `spatial.distanceKm/resKm`, offer
   the nearest GHCN station, and let users bias-correct against uploaded obs.
3. **Overclaiming at long leads.** The ladder caps and the ledger exist so that the
   site's own record, not our copy, sets confidence.
4. **Multiple-testing in Relationships.** A 30×30 lag matrix will find "significant"
   noise. Use effective-N, FDR (Benjamini–Hochberg) across the matrix, and label
   exploratory results as such.
5. **Supabase load.** Ledger auto-issue and archive bundles go to R2, with Postgres
   holding only indexes and user rows.
6. **Scope creep.** Each phase below ships standalone and is useful on its own.

---

## 13. Phasing

| Phase | Ships | Gate |
|---|---|---|
| **P0 Foundation** | page shell + site bar + `SiteSeries` store + resampler + 6 existing loaders (ERA5 archive, NWP multi-model, drivers, AQ, NWS alerts, Kp) + aligned Explore timeline + data-health chips | `climalytix-site-store.mjs`, `climalytix-resample.mjs`, `tests/climalytix-smoke.spec.js` (all feeds mocked; negative control: every feed 503 ⇒ page says feeds down, never a quiet chart) |
| **P1 Climate context** | climatology, percentiles, trend, change-point, spells, EVA, Extremes tab, Overview briefing | kernel gates with the published fixtures in §6 |
| **P2 Events + short range** | event DSL + templates, `/api/climalytix/ensemble` + `hindcasts`, per-site EMOS calibration, Predict tab, ledger v1 (issue + score), Verify tab | calibration recovers a planted bias/spread; reliability of a calibrated synthetic ensemble ±0.05 |
| **P3 Drivers & S2S** | Relationships tab (lag/composites/FDR), analog member, S2S + seasonal rungs, extra indices (PDO/AMO/IOD/QBO) | red-noise false-positive gate; analog skill ≥ climatology on hindcast |
| **P4 Physics column** | ET₀, soil water, snow, FWI, WBGT, GDD; Physics tab; hydrology loaders | FAO-56 + Van Wagner fixtures; column vs ERA5-Land soil moisture residual reported |
| **P5 Generator + scenarios + climate** | weather generator, Scenario studio, CMIP6 projections with QDM, 2050 rung | generator reproduces observed GEV / spells inside CIs; gamma-only negative control fails |
| **P6 Commercial** | tier flags, workspaces sync, reports (PDF), BYO data, Enterprise API, auto-issue ledger in R2 | `tests/climalytix-tiers.mjs`; API contract tests |
| **P7 Performance + members** | `rust-climalytix` WASM (EVA MLE, generator, column) with JS as oracle + smoke pin; ML members logged & scored like any other | WASM ↔ JS equality gate |

Suggested first PR: **P0 only**. It is useful on its own (the 1940→+16 d aligned
multi-dataset view of one site already exists nowhere else on the site) and it
fixes the contract every later phase depends on.

---

## 14. Questions for the author before P0

1. **B2G/operator-first or consumer-first** (§2)? This decides whether P6 pulls forward.
2. **Open-Meteo commercial key vs self-hosting** (§12.1). This must be settled before
   any paid tier ships, though P0–P1 can be built on the free endpoint.
3. **Name and placement**: `climalytix.html` under Earth & Orbit → Earth systems, or its
   own top-level section? A sixth section changes the nav width budget (CLAUDE.md §4.5).
4. **Relationship to the Climate Lab (dashboard.html)**: the lab stays the account's
   "my home station" card set. Climalytix is the deep workspace, and the lab gets an
   "Analyse in Climalytix ›" link. Is that the boundary you want?
