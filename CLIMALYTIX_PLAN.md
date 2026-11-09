# Climalytix — location-first multi-dataset climate & weather analytics

Status: **P0 BUILT** (2026-11-08) — `climalytix.html` under Research → Analysis, the SiteSeries store, the Explore timeline over four public datasets, `/api/climalytix/archive`; see §13 for what P0 shipped and what comes next. **P-1 FIRST SLICE BUILT** (2026-11-08, §17.6): the GFS 0.25° ingest worker on GitHub Actions → R2 point tiles → `/api/climalytix/nwp`; it publishes once the four R2 secrets are set for Actions. Everything else here is planned. This is the design brief for
`climalytix.html`, the flagship analysis workspace. It sits ON TOP of the
weather / climate machinery the site already ships and must not fork any of it
(§3 lists what it reuses, by file).

## 0. Decisions (author, 2026-11-08)

| # | Decision | Consequence in this plan |
|---|---|---|
| D1 | **Commercial viability first** | The workspace, the account gate, server-delivered event alerts and the API move forward. They are the paid surface, so they ship in P0–P2 rather than P6 (§13) |
| D2 | **Our own data engine and our own models, on public data only** (revised 2026-11-08; supersedes "self-host Open-Meteo") | We ingest the public sources Open-Meteo itself redistributes (NOAA, ECMWF open data, DWD, Copernicus, station networks), build our own point archive, and compete on **post-processing and verification**, not on running a global NWP model (§17, §18). Phase P-1 becomes the data engine. Open-Meteo's public API is a bootstrap source and a benchmark only |
| D3 | **Lives under Research** | A new "Analysis" group in the Research section (`js/site-sections.js`). Research is "show your working", and the scored ledger is exactly that (§10) |
| D4 | **User-generated = private and team authoring** (scoped 2026-11-08) | Users author instruments, events, workspaces and studies and share them inside their team. **No public gallery.** **No user uploads for now** ("public data only"); a team's data is its own objects built on the public catalogue (§16) |
| D5 | **Built from the Home Station** | The Climate Lab's Home, instrument bench, watches, units and prefs patterns become Climalytix's foundation. They are generalised, not copied, and the dashboard card set keeps working on the same modules (§15) |
| D6 | **Paid event delivery = email + webhook** | Resend (already wired) plus signed webhooks in P2. SMS and Slack later |
| D7 | **The dashboard Home Station stays free, for now** | It is the funnel; revisit once Climalytix has paying users |
| D8 | **The ingest worker runs on GitHub Actions, for now** (2026-11-08) | Scheduled workflows write to R2 (the `trojans-refresh.yml` precedent: a data job that never pushes to main). The one-off ERA5 backfill is chunked across runs to fit the per-job time limit; a VM is the escape hatch if the realtime NWP cadence outgrows Actions (§17.3) |
| D9 | **Zero GPU** (2026-11-08) | §18 M4 is ingest-only: ECMWF's published AIFS output as another public source. No open-weight model is run by us until there is budget and the cheaper rungs are exhausted |

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

**Decided (D1): commercial viability first.** The first paying customers are the
first five rows: one site that matters to a business, events that cost money
when they happen, and a track record they can show a manager. Consumers get the
free tier (their Home, templates, 7 days), which is also the funnel.

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
excluded for CC BY-NC). Open-Meteo's *hosted free tier* is non-commercial, so it is
a **bootstrap source and a benchmark only**: no paid answer may be built on it.
**Decided (D2): public data only, ingested ourselves** (§17). The licence then follows
the *underlying data*:
- NOAA GFS / GEFS: US public domain.
- ECMWF open data (IFS / ENS): CC BY 4.0.
- DWD ICON: open, with attribution.
- Copernicus ERA5 / CMIP6 / GloFAS: commercial use allowed with attribution.
- CAMS: Copernicus licence.
- NOAA GHCN-Daily / ISD stations, CPC indices, NASA IMERG: US public domain.
- **AI model weights are licensed separately from their output.** GraphCast/GenCast weights are CC BY-NC-SA (excluded from paid use); ECMWF AIFS output is published as open data. Check every model's weight licence before it becomes a member (§18).

Every source's attribution string goes into `provenance` and into the report
appendix. Sources with a non-commercial licence are allowed only on the free
tier and are flagged in the catalogue (`commercial: false`).

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

Navigation (D3): **Research → a new third group `analysis` ("Analysis", note:
"Your site, every dataset, every prediction scored")**. It holds `climalytix.html`
and, once §18's scorecard exists, `climalytix-skill.html` (our models vs raw NWP and
the benchmark, the Research section's natural home). Research currently has 2 groups
and 4 catalogue entries, so a third header and two links
stay inside the ≤3-header / ≤10-link cap. Because the menu, the catalogue and the
hub are all derived from `js/site-sections.js`, the change is one group entry plus
`js/simulations-catalog.js` rows plus re-running `scripts/build-section-pages.mjs`
(never hand-edit `research.html`). The section's intro sentence gains the clause
"…and your own site, scored the same way". The dashboard's Home Station card gets
an "Analyse in Climalytix ›" link. The page must pass `scripts/lint-nav.mjs`,
`tests/importmap-order.mjs`, `tests/site-sections.mjs` and `tests/nav-responsive.spec.js`.

---

## 11. Commercial layer

> Superseded in detail by §16.5 (tiers with user-generated objects) and §13 (commercial-first order). The table below is the original capability sketch.

| Capability | Free | Basic | Advanced | Institution / Enterprise |
|---|---|---|---|---|
| Sites | 1 (Home) | saved-location quota | quota | quota + API batch |
| History depth | 10 yr | full 1940 → | full | full |
| Datasets | core 6 | + drivers, AQ, ocean | everything | everything (uploads deferred, D4) |
| Event builder | templates | custom | custom + compound | custom + shared team library |
| Horizons | to 7 d | to 6 wk | + seasonal, scenarios, generator | + 2050 projections |
| Ledger / Verify | view | issue + score | auto-issue nightly | + exportable audit trail |
| Export | — | CSV | CSV + PDF report | + API, white-label reports |

- Gating goes through `js/tier-config.js` only (add `climalytix*` capability flags
  there and in the SQL, in the same commit). Workspaces sync through the existing
  `public.dashboards` table (page `'climalytix'`) with `dashboard-sync.js`, local-first.
- **Bring-your-own data**: DEFERRED (D2/D4, public data only for now). Uploads were the strongest commercial hook in the first draft, so revisit them first once the public-data product has paying users.
- **Enterprise API** `/api/climalytix/v1/{site,events,predict,scores}`: the same
  kernels server-side, keyed, rate-limited, and auditable. Multi-site is the API's
  job, so the UI stays one site at a time.
- **Reproducibility**: every report and API answer carries the event version, the
  member versions and the dataset provenance hashes, so it can be re-run bit for bit.

---

## 12. Risks and blockers

1. **Our own data engine (D2): phase P-1.** Specified in §17. The risks are cost
   and operations, not licensing: GRIB decoding and a terabyte-scale archive need a
   worker outside Vercel, and the ingest must be monitored like any other pipeline.
   Until it serves, every paid answer is blocked (the Open-Meteo free tier is
   non-commercial), but P0 and P1 can be built on the bootstrap source.
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

Re-ordered for D1 (commercial first). P-1 runs in parallel with P0; P0 and P1
can be built against the public Open-Meteo endpoint, but nothing paid ships until
P-1 is live.

| Phase | Ships | Gate |
|---|---|---|
| **P-1 Data engine (D2, §17)** | the ingest worker (public NWP GRIB2 by byte-range, ERA5 history, stations, indices) → R2 point archive → `/api/climalytix/*` serving `SiteSeries`; a source switch so Climalytix reads our archive first and the bootstrap source second, flagged stale; registry entries with an ingest-lag probe per source | a point read reproduces the source's own value at a grid point to its packing precision (GRIB decode gate against a stored real message); archive round-trip is lossless at the stated quantisation; lag visible on status.html |
| **P0 Foundation — BUILT 2026-11-08** | `climalytix.html` (Research → Analysis); `js/climalytix/series.js` (SiteSeries + agg-aware resampler), `catalog.js` (4 datasets: ERA5 daily via the new `/api/climalytix/archive`, the Home Station feed, AO/NAO, Ap observed + 45-day), `timeline-model.js` (small multiples, past solid / future dashed, aggregation never thinning, one bucket per summed panel, "too short for this zoom"), `loaders.js`, `page.js`; site = the one location store (Home by default, a search is a visit); workspace local-first + `dashboards` sync (page `climalytix`) | `node tests/climalytix-{series,catalog,timeline,archive}.mjs` (35 checks) + `tests/climate-lab.mjs` UNCHANGED; `npx playwright test tests/climalytix-smoke.spec.js` (7, incl. the all-feeds-down negative control) + `tests/dashboard-climate-lab.spec.js` UNCHANGED + `tests/nav-responsive.spec.js`; CI `climalytix-kernels.yml` |
| **P0 remainder** | air quality (CAMS) and NWS alerts loaders; ONI/MJO driver chips; the climatology overlay is P1 | — |
| **P1 Climate context** | 85-yr climatology, percentiles, trend, change-point, spells, EVA, Extremes tab, Overview briefing. The dashboard's Climate Context card gains an "85-year baseline" mode from the same kernel (§15.3) | kernel gates with the published fixtures in §6 |
| **P2 Events, the paid hook** | event DSL; lab watches migrated as one-condition events (§15.4); **server-side event evaluation + delivery (email, webhook)**, the thing the lab console currently has to tell users it cannot do; short-range EMOS calibration; Predict + Verify tabs; ledger v1; tier gating of all of it | calibration recovers a planted bias/spread; a watch round-trips to an event and evaluates identically (`assert.deepEqual` on `evaluateWatch` vs the event evaluator over the lab fixture); delivery cron idempotent (one send per event-window) |
| **P3 Team authoring v1 (D4)** | user instruments (formula DSL), save / share-to-team / fork; reports (PDF). Uploads deferred (public data only) | formula DSL fuzz gate (no `eval`, no prototype access, bounded cost); team RLS tests (a non-member reads nothing) |
| **P4 Drivers & S2S** | Relationships tab (lag/composites/FDR), analog member, S2S + seasonal rungs, extra indices | red-noise false-positive gate; analog skill ≥ climatology on hindcast |
| **P5 Physics column** | ET₀, soil water, snow, FWI, WBGT, GDD; Physics tab; hydrology loaders (the lab's Soil probe and Degree days instruments re-point to it) | FAO-56 + Van Wagner fixtures; column vs ERA5-Land soil moisture residual reported |
| **P6 Our models, scored (§18) + API** | the model ladder M1–M4 as ledger members; the public scorecard against raw NWP and the Open-Meteo benchmark; Enterprise API; auto-issue ledger in R2 | each member beats its parent on the held-out years or is not shipped; API contract tests |
| **P7 Generator + scenarios + climate** | weather generator, Scenario studio, CMIP6 projections with QDM, 2050 rung | generator reproduces observed GEV / spells inside CIs; gamma-only negative control fails |
| **P8 Performance + members** | `rust-climalytix` WASM (EVA MLE, generator, column) with JS as oracle + smoke pin; ML members logged & scored like any other | WASM ↔ JS equality gate |

Suggested first PR: **P0**. It is the lift of the lab's contracts into shared
modules (the dashboard must not change a pixel) plus the page shell.
**P-1 is a separate track that runs alongside it** and needs a worker host (§14).

---

## 14. Questions for the author

Answered 2026-11-08: commercial first (D1); our own data engine and models on public
data, not a self-hosted Open-Meteo (D2); Research (D3); private + team authoring
only, no uploads for now (D4); built from the Home Station (D5); email + webhook
delivery (D6); Home Station free for now (D7). Open:

None open. Decided 2026-11-08: GitHub Actions for the ingest worker (D8), zero GPU (D9).

---

## 15. The Home Station is the foundation (D5)

The dashboard's Climate Lab (`js/climate-lab/*`, 16 modules, ~4.4k lines, node-
and browser-gated) already solved half of Climalytix for **one place, 48 hours, 13
fixed instruments**. Climalytix is the same object with the limits removed:
**any place, 1940 → 2050, any number of user-defined instruments and events.** So
we lift its contracts into shared modules rather than writing parallel ones, and
the dashboard keeps rendering from the same code.

Screenshots of today's Home Station (demo mode, synthetic fixture) were sent with
this revision. They are not committed (binary bloat). Re-capture with the recipe in
§15.6.

### 15.1 What exists, and what each piece becomes

| Lab piece (file) | What it does today | In Climalytix |
|---|---|---|
| **Home** (`lab-home.js` `resolveHome`, `anchorAtHome`) | one home per account (`user_profiles.location_*`); a search is a *visit*; one location store (`ppx_user_location`) | the **default site**. Climalytix opens at Home, any other site is a visit through the SAME store and event. Paid tiers add a site library (the existing `user_locations` quota), but there is still one *current* site |
| **Feed** (`lab-feed.js`, `/api/weather/forecast?type=lab`) | one SI request, gaps stay null, station-day from `utc_offset_seconds` | becomes the first **loader** emitting `SiteSeries` (§4.1). Its rules (gap ≠ 0, epoch ms, station calendar) are exactly the store's rules |
| **Instrument bench** (`lab-readings.js`, `INSTRUMENTS` in `lab-prefs.js`) | 13 instruments, each returning ONE shape `{primary, rows, status, spark, meter, visual, method}`; hide/reorder | becomes the **Instrument contract**. The 13 built-ins become the first entries in a catalogue that also holds **user instruments** (§16.1). The `method` line (provenance and formula) is mandatory for user instruments too |
| **Physics** (`lab-physics.js` + `composite-indices.js`) | wet-bulb, VPD, density altitude, cloud base, Beaufort, degree days, percentile; validity *reported* | becomes the function library the formula DSL may call (§16.1), so users compose OUR validated physics, not their own copy of it. Its "validity is reported, not hidden" rule extends to every user formula |
| **Units** (`lab-units.js` `fmt`, `tempDelta`) | SI inside, convert once at display; presets including aviation and custom | used unchanged across Climalytix. User datasets declare a unit on import and are converted to SI once at the door |
| **Meteogram** (`lab-charts.js`) | small multiples on one time axis, probe reads every series at one hour, past solid / forecast dashed | the **Explore timeline's** primitive, extended to: many years, `kind`-shaded segments (observed / forecast / outlook / scenario), and user-chosen panels |
| **Climate context** (`lab-climate.js`) | today vs a **3-year** ERA5 window (±7 d, ~45 samples), and it says so | the P1 kernel gives it the **85-year** baseline; the card gains a "1991–2020 normal" mode and keeps printing its sample size |
| **Lab watches** (`lab-watches.js`, 8 `WATCH_KINDS`, ≤12, horizons 6–48 h) | in-browser threshold checks, explicitly *not* emailed because no server sender exists | the simplest **event template**: a watch = one condition, absolute threshold, `max` over a 6–48 h window. Migrated losslessly (§15.4). Climalytix adds the server sender, which is the paid hook |
| **Alert console** (`lab-alerts.js`, `lab-account.js` whitelist) | account `notify_*` alerts vs lab watches, never blurred; writes only whitelisted columns | keeps the same two-column honesty. A third column, **"Delivered events"** (paid), shows events whose delivery is server-side, with a delivery log |
| **Prefs + sync** (`lab-prefs.js` `normalizePrefs`, `lab-sync.js`) | one versioned doc, local-first, `public.dashboards` (page `climate-lab`), `tierAllowsSync`, `pickNewer` | the **workspace doc** uses the identical pattern (page `climalytix`, one row per workspace name), so no new sync code. Multiple named workspaces per site are a paid capability |
| **Satellites** (`lab-satellites.js`) | passes over Home on the one SGP4 path | stays on the dashboard. For the ground-station segment, a pass becomes a time series (elevation, visible) that events can condition on: "pass above 30° AND rain rate < 2 mm/h" (rain fade) |

### 15.2 The lift (P0), with one rule: the dashboard must not notice

- **As built (P0): IMPORT IN PLACE, do not move.** Climalytix imports
  `js/climate-lab/lab-units.js`, `lab-feed.js` (`fetchLabStation`, `normalizeLabResponse`)
  and `lab-home.js` (`homeState`, `visit`) directly — ONE copy, and the dashboard
  is byte-identical. Moving files into a shared folder was churn with zero behaviour
  change (the CLAUDE.md §5 reversion risk); a module moves only when a second
  consumer needs its CONTRACT to change, and then with the gates below. The
  instrument catalogue and `WATCH_KINDS` are next (P2, when watches become events).
- **The gate is the existing gate.** `node tests/climate-lab.mjs` and
  `tests/dashboard-climate-lab.spec.js` pass UNCHANGED, with no fixture or assertion
  edits. If one has to change, the lift was not a lift.
- `pp_climate_lab_v1` stays the dashboard's key and version. Climalytix gets its own doc
  (`pp_climalytix_v1`), so neither can corrupt the other. Shared content (watches,
  units) is *imported* into Climalytix on first open, never synced both ways.

### 15.3 What flows back to the dashboard

The integration should make the free product better too, because that is the funnel:
- **Climate Context** gets the 85-year baseline (P1).
- **Lab watches** gain "promote to delivered event" (paid) beside the existing
  in-browser toggle.
- Every dashboard card gets an **"Analyse in Climalytix ›"** deep link that opens the
  same site with that card's quantities pre-selected (`climalytix.html?site=home&series=…`).

### 15.4 Watch → event migration (lossless, gated)

```
watch { kind, threshold (SI), horizonH, on }
  ⇒ event { when: { series: WATCH_KINDS[kind].metric-source, op: cmp,
                    threshold: { kind:'absolute', value: threshold, units: SI },
                    window: { reduce: metricReduce(kind), span: `PT${horizonH}H` } },
            delivery: on ? 'in-browser' : 'off', origin: { from:'lab-watch', id } }
```

The gate evaluates both representations over the lab's closed-form fixture and asserts
identical state / value / firstAt for all 8 kinds × 4 horizons. A watch the user later
edits in Climalytix becomes a full event and stops being mirrored. The dashboard
shows it as "managed in Climalytix", never two diverging copies.

### 15.5 Deep customisation, the knobs a user gets

Everything below is a field in the workspace doc (versioned, normalised on read, synced
by tier) or a user-authored object (§16). Nothing is a code path special-cased per
user.

- **Bench and panels:** which instruments (built-in or user-made), their order, and which
  series appear as timeline panels, at what resample (`agg`-aware) and in what units.
- **Baselines:** base period per workspace (1991–2020 default, or any ≥ 10-year span),
  the percentile window (±7 d default), and calendar-local vs station-local day.
- **Events:** the user's own library (§7), with thresholds absolute, percentile or
  return-period; compound conditions; per-event delivery (in-browser / email /
  webhook) and quiet hours.
- **Horizons:** which ladder rungs to show, and an "only show verified" switch that hides
  any probability without n ≥ 30 scored cases here.
- **Data:** which datasets are on and the nearest-station choice (uploads deferred, D4).
- **Presets:** saved as named workspaces, for example "Frost season", "Fire season",
  "Launch window".

### 15.6 Re-capturing the Home Station screenshots

The dashboard runs in demo mode with the gate's own mocks. Install
`installLabMocks` from `tests/fixtures/climate-lab-mocks.mjs`, set `pp_demo_mode`,
`ppx_tour_completed`, a `ppx_user_location`, open `/dashboard.html`, wait for
`#location-card .cl-hero-value`, and remove `.pp-consent-banner` and `.tour-*`
before screenshotting `#location-card`, `#cl-bench-card`, `#cl-meteogram-card`,
`#cl-climate-card`, `#cl-sat-card` and `#alert-console-card`.

---

## 16. User-generated analysis (D4)

### 16.1 What users author

| Object | What it is | Safety rule |
|---|---|---|
| **Instrument** | a formula over `SiteSeries` + the physics library, e.g. `chillHours = count(hours(t2m between 0 and 7.2))` or `sprayWindow = wind10 < 4.5 and rainProb < 20 and deltaT between 2 and 8`, returning the standard reading shape | a small **expression language** (parsed to an AST, whitelisted functions and operators, no `eval` / `Function`, no property access, cost-bounded by evaluated nodes). Units are type-checked (adding °C to mm is a parse error); validity ranges propagate from the library |
| **Event** | §7's DSL | same evaluator; thresholds clamped to physical ranges per quantity |
| **Dataset** (DEFERRED, D2/D4: public data only for now) | later: an upload that becomes `SiteSeries` with `kind:'observed'`, `provenance.source:'user'` | when it lands: declared units and time zone, gaps stay gaps, size caps per tier, stored per owner/org in R2, never shared outside the team |
| **Workspace** | a saved arrangement (§15.5) | the `normalizePrefs` pattern: unknown fields dropped, future versions degrade field by field |
| **Study** | a frozen bundle shared inside the team: site + datasets + instruments + events + the ledger slice, with text | a snapshot with provenance hashes; re-runnable bit for bit |

### 16.2 Sharing (D4: private and team only)

`private` → `team/org` (Institution/Enterprise seats, the existing classroom/org seat
model). **Fork** copies any object the user can see into their own space with an
`origin` pointer, so lineage is visible inside the team. **There is no public
visibility level**, so there is no moderation queue and no anonymous read policy.

### 16.3 A team's objects carry their own track record

A team **event** can be auto-issued nightly for its site, and the ledger scores it
(§8.6). The team sees its Brier skill vs climatology, n, and the reliability diagram.
**An event with fewer than 30 scored cases is labelled "unverified"** (the TIGA rule:
no widening the bars to look calibrated). This is what a team shows its manager.

### 16.4 Storage and schema (written as a migration, applied only on the author's go)

- `climalytix_items` (id, owner, org, kind ∈ instrument|event|workspace|study,
  visibility ∈ private|team, version, doc jsonb ≤ 64 KB, origin_id, created/updated):
  owner-RLS for private, org membership for team, **no anon policy**.
- `climalytix_predictions` / `climalytix_scores`: the ledger. Auto-issue volume goes to
  **R2 with a Postgres index** (`SUPABASE_OFFLOAD_PLAN.md` pattern), never bulk rows.
- All user text is plain text (no HTML), rendered through `textContent`.

### 16.5 Tiers (`js/tier-config.js` flags, added in the same commit as the SQL)

- **Free:** Home only, templates, 1 private user instrument.
- **Basic:** saved sites, unlimited private instruments and events, in-browser delivery, fork.
- **Advanced:** email/webhook delivery, scenarios / generator, PDF reports.
- **Institution / Enterprise:** team spaces, org libraries, API, white-label reports,
  audit export.

---

## 17. The data engine (D2): public data, ingested ourselves

### 17.1 What we already have (measured on production, 2026-11-08)

"We should have a lot of data already" is true for space weather and **not yet true
for ground weather**. This is the inventory, read from project `aijsboodkivnhzfstvdq`:

| Data | Span | Resolution | Usable for training? |
|---|---|---|---|
| Solar wind + Kp/ap/Dst/e⁻ flux (`sw_geomag_dataset` + R2 sealed days) | 2026-07-12 → now (~4 months) | 1 minute, ~167 k rows in R2 + 21 k in Postgres | **Yes**, for space weather: our differentiator, already on one clock |
| `geomag_indices` (Kp, Dst, >2 MeV electrons) | 2026-08-10 → now | native cadence | Yes (space weather) |
| Forecast ledger (`forecast_log` + R2 `forecast_archive_pointer`) | 2026-07-11 → now, ~9.1 k archived rows | per issue | Yes, as a **scoring** record (aurora members) |
| Global weather grid (`weather_grid_cache` + R2 `weather_grid_archive`) | 2026-10-05 → now (~5 weeks) | **every frame is the MET Norway 10° fallback** (`met-norway:72x36`, upsampled) | **No.** Too short and too coarse. Today's cause is Open-Meteo **HTTP 429** (per-minute limit): the heartbeat's last reason is "open-meteo chunk 1600 HTTP 429 … Minutely API request limit exceeded". A stopgap fix is filed separately |
| 1991–2020 temperature normals (`assets/temperature/*.bin`) | climatology | 1.5° box means | Yes, as a baseline |

So the ground-weather training set has to come from the **public archives**. That is
where "a lot of data" really is (85 years of ERA5 alone), and it is exactly what D2
asks for. Our own five weeks become a validation slice, and the ledger is the teacher
(the `PRESSURE_OUTLOOK_ENGINE_PLAN.md` finding: history-only ML was 3.89 hPa at
day 1 against NWP's 0.53, so **our history scores models, it does not replace NWP
input**).

### 17.2 Sources (all public; every host is UNVERIFIED from the sandbox, so use candidate lists)

| Role | Source | Licence | How we read it |
|---|---|---|---|
| History (training, climatology, extremes) | **ERA5** + ERA5-Land reanalysis (1940 →) | Copernicus, commercial with attribution | the analysis-ready Zarr mirrors on the public clouds, or CDS requests for the backfill; rechunked into our point tiles once |
| Real-time global NWP | **NOAA GFS** 0.25° + **GEFS** (31 members) | US public domain | GRIB2 on NOAA's open-data buckets, **byte-range reads via the `.idx` sidecar**, so we fetch only the fields and levels we use, never whole files |
| Real-time global NWP | **ECMWF open data** (IFS HRES + ENS, plus the **AIFS** data-driven model's output) | CC BY 4.0 | same `.index` byte-range pattern |
| Real-time regional | DWD **ICON** (global + EU), NOAA **HRRR** (US, 3 km) | open / public domain | GRIB2 byte-range |
| Calibration training | **GEFSv12 reforecast** (2000–2019) | public domain | one-off backfill of the fields we calibrate |
| Ground truth | **GHCN-Daily**, **ISD** hourly stations; METAR | public domain | nightly delta |
| Drivers | CPC ONI / RMM / AO / NAO / PDO, NASA **IMERG** precip | public domain | already partly wired |
| Air / hydro / climate | CAMS, GloFAS, CMIP6 | Copernicus | existing routes or the CDS |

Every source gets a `js/pipeline-registry.js` entry with an **ingest-lag** probe (the
newest run we hold vs the newest the source has published), and a missed run is
`freshness:'stale'`, never a silent gap.

### 17.3 Shape

```
ingest worker (Python: cfgrib/xarray → our tiles)      NOT Vercel, NOT the workstation
  ├─ realtime: per NWP cycle, byte-range the needed GRIB messages, decode,
  │            write  r2://clx/nwp/{model}/{run}/{tile}.bin   (+ index row)
  ├─ history:  ERA5 backfill once, then a nightly tail
  │            write  r2://clx/era5/{var}/{tile}.bin          (time-major)
  └─ stations: nightly GHCN/ISD delta → r2://clx/obs/{station}.bin
                     │
api/climalytix/* (Vercel) ── reads ONE tile, slices ONE point ──► SiteSeries (§4.1)
```

- **Time-major point tiles** are the key design choice. One site at a time over 85
  years is a *time series at a point*. Global time-slices (how the sources publish)
  would mean reading 31 000 files for one answer; tiles chunked by **space** with the
  **whole time axis** inside make it one read. A tile is ~2°×2° of 0.25° cells
  (64 cells) for all time.
- **Size, as arithmetic to verify on a trial backfill, not a quote:** daily ERA5
  aggregates (Tmax, Tmin, mean T, precip sum, max gust, …): 31 340 days × 1.04 M
  cells × 4 B ≈ 130 GB per variable, ~65 GB at int16 with a per-variable
  scale/offset. Ten daily variables ≈ 0.65–1.3 TB. Hourly ERA5 for every cell is
  ~25× that, so **hourly history is fetched per site on first use and cached**, not
  bulk-mirrored. R2 has no egress fees, which is why it is the store (the
  `SUPABASE_OFFLOAD_PLAN.md` precedent).
- **Where it runs:** a small always-on VM, or scheduled GitHub Actions (the repo
  already runs data jobs that way, e.g. `trojans-refresh.yml`, which opens a PR rather
  than pushing). That choice is §14 Q1. The ERA5 backfill is a one-off batch either way.
- **Global grid side benefit:** the same realtime ingest can produce the hourly global
  grid that EarthView, the Temperature Lab and the extremes table read today from the
  rate-limited public API, at full 0.25° instead of the 10° fallback. Moving those
  consumers is a separate PR each, with their own gates.

### 17.4 Gates for the engine

- **Decode truth:** a stored real GRIB2 message (GFS and ECMWF, one each, committed as
  fixtures and never hand-edited) decodes to the published values at the published
  packing precision. A negative control flips the scan-mode flag and must fail
  (a mirrored grid is the classic silent GRIB bug).
- **Tile round-trip:** encode → decode is exact at the stated int16 quantisation, and
  NaN gaps survive as gaps.
- **Point extraction:** the value served at a grid-point site equals the source's own
  value there. Interpolation between points is bilinear in lat/lon with the
  antimeridian handled (the EarthView seam lesson).

---

### 17.6 First slice — BUILT 2026-11-08 (GFS → R2 → one site)

What exists, and the files that are its one copy:

- **Worker** `scripts/climalytix_ingest/` (Python, eccodes): `idx.py` (PURE `.idx`
  parser + range planner + precipitation de-accumulation plan), `grid.py`
  (canonical north→south / east-going orientation from the scan-mode flags),
  `tiles.py` (the point-tile FORMAT's normative description + the GFS variable
  table), `store.py` (R2 or a local dry run; tiles → manifest → `latest` →
  prune), `gfs.py` (the CLI). Schedule: `.github/workflows/climalytix-ingest.yml`,
  daily 05:23 UTC for the 00z run, 0–240 h 3-hourly, keeps 2 runs. It never
  commits and never touches Supabase.
- **Format** (`climalytix.point-tiles.v1`): int16 little-endian, per-variable
  scale/offset (stated precision scale/2, 0.005 in every unit today), NODATA
  −32768 is a gap, clipped values COUNTED in the manifest; 20×20-cell tiles +
  a one-cell halo whose columns WRAP, laid out cell-major with the time series
  innermost, so a site is TWO byte-range reads on ONE tile, at the grid seam
  too. The run manifest (gzip JSON) carries the grid, vars, times and every
  missing var-lead; the `latest` pointer is written after it.
- **Reader + route** `js/climalytix/point-tile.js` (PURE) and
  `/api/climalytix/nwp?lat&lon` — bilinear between the four nodes (disclosed;
  M1 downscaling replaces it), wind speed/direction from the interpolated
  u/v (never interpolated speed), precipitation as 3 h amounts stamped at the
  interval START. Registry row `climalytix-nwp` is the ingest-lag probe
  (`age_seconds` = now − run time; stale > 30 h, expired > 54 h).

Measured on the real 2026-11-07 00z run: 17 leads fetch + decode + tile in
19 s at 861 MB RSS; a full run is ~1.65 GB of tiles (~2 runs ≈ 3.3 GB of R2).

Two traps found on the REAL files and pinned by `tests/climalytix_ingest_test.py`:
(1) a field can appear twice with different meanings (TCDC instantaneous vs
bucket average; APCP "6-9 h" beside "0-9 h") — select by the full time
descriptor; (2) APCP resets in 6 h buckets (3 h files past f120 still carry
6 h buckets, f240 adds "0-10 day") — the 3 h amount is the window with the
latest start, minus the previous file's when the start is earlier. Scan-mode
orientation is checked against eccodes' OWN per-point coordinates on the real
message and on clones re-stored south-first / west-going / column-major, with
the flag-ignoring reader as the negative control (GFS is north-first, so a
reader that ignores the flags passes every GFS-only test).

**On the page (2026-11-08):** `gfs` is the FIRST dataset in the catalogue,
badged "Our archive"; ERA5 and the Home Station feed are badged "Bootstrap" and
the indices "Reference" (`ROLES` in catalog.js). The bootstrap NWP stays on as
the BENCHMARK, never as a stand-in: when our archive is down or unpublished its
chip is red, its note says why ("not published yet" while the R2 secrets are
unset) and nothing is substituted. GFS temperature, 3-hourly precipitation,
wind and MSL pressure are on by default; RH and cloud are in the table but off;
dew point and gusts are archived but not listed (the temp and wind panels are
at the five validated colours). A workspace saved before the archive existed
(v1, no `known` list) gets the new defaults switched on ONCE; an uncheck after
that is respected (`normalizeWorkspace`, gated). The renderer clamped colour
slots to 0–3 — a fifth series silently wore the fourth's colour — and
`SLOT_COUNT` is now one number shared by the clamp and the catalog gate.

**The location map (2026-11-08):** the top of the page is a map centred on
the site — NASA GIBS Blue Marble (archival composite, browser-direct; tile
grid = js/earth-detail-inset.js) with reference overlays where they load —
with a LAYER RAIL on its left whose first toggle is Temperature: the 2 m
field at the GFS grid nodes in a ±3° window, read from our own archive by
`/api/climalytix/nwp-field` (one R2 range per row segment, `fieldPlan` /
`readField` in point-tile.js, gated against the Python-written fixture), drawn
through the site-wide temperature LUT (js/temp-ramp.js, the same bytes as
EarthView's key) with the window's extent dashed. It follows the timeline's
crosshair and holds no frame past the run's end. Archive down ⇒ no heat and
the rail says why; nothing stands in for it. Controls: zoom ± and a D-pad
with recentre in the map's lower-right corner, drag, wheel/trackpad zoom AT
THE CURSOR (exact, `zoomAt`), pinch, double-click, keyboard. Geometry is the
PURE `js/climalytix/map-view.js` (equirectangular, true scale at the view
centre); gates `tests/climalytix-map-view.mjs` + `tests/climalytix-map.spec.js`.

**The Temperature layer, EarthView-grade (2026-11-08):** the map draws
temperature the way the globe does (js/earth-skin.js `weatherOverlay`):
the VALUE is interpolated between grid nodes, then coloured by the one LUT,
then the freezing seam is added — `heatImage` in map-view.js, per 2×2 px
block, cached per view + time. The first version let the canvas smooth a
node-per-pixel image, which blends COLOURS (a −5 °C blue and a +5 °C yellow
averaged to a grey-green the ramp never contains, right where the freezing
line belongs); the gate keeps that as its negative control. The seam's
constants live once in js/temp-ramp.js `FREEZE_SEAM` and are pinned to the
shader's literals by source text. Under the toggle: labelled ISOTHERMS
(js/climalytix/contours.js, marching squares on the window's nodes — not
EarthView's isobar module, which is 360×180-only and SHA-pinned), levels
round in the reader's unit and re-chosen on a unit switch, the freezing line
its own emphasised level whenever the window spans 0 °C; ▲ ▼ the window's
warmest and coldest nodes. The data box is the NODE extent (nothing is drawn
past the outer nodes).

**Base map + terrain + labels (2026-11-08, `js/climalytix/basemap.js`, PURE,
`tests/climalytix-basemap.mjs`):** the ground is three stacked, independently
optional sources. (1) EarthView's SELF-HOSTED Blue Marble (`assets/earth/
day-{1k,2k,4k}.webp`, the hero's files) as an underlay: same-origin, so it
paints at once and survives GIBS being down — the browser gate blocks GIBS
and reads Colorado's ground, and its negative control blocks the underlay
too and reads the bare ocean fill. Tier = the smallest with ≥ 1 texel per
device px; the largest loaded tier draws until the wanted one arrives.
(2) GIBS 500 m tiles over it where they load (unchanged). (3) TERRAIN: a
hillshade of `assets/earth/relief-2k.webp` computed once in the page
(~250 ms on SwiftShader), Sobel on a 2-texel baseline (EarthView's
`topoGradient` rule — the gate's negative control is the one-texel forward
difference, which draws the 8-bit staircase as ridges), cos φ east–west
spacing, NEUTRAL 128 on flat ground and composited 'overlay', so sea and
plains are untouched. Light from the north-west at 45° (cartographic
convention, not today's Sun) and ×10 vertical — both printed in the rail,
the exaggeration pinned to the rail's text by the node gate. The relief is
~20 km/texel; nothing finer is shaded, and the rail says so (×20 drew the
Front Range as black blobs at the default zoom — measured on screenshots).
PLACE LABELS replace the unverified GIBS `Reference_*` overlays: EarthView's
city list (js/data/major-cities.js), biggest metro first, each label tried
right/left/below/above its dot and placed only where it clears every placed
label, the site ring and the DOM drawn over the canvas (controls, scale,
attribution — measured: Kansas City sat under the zoom buttons). Next step
for terrain detail at close zoom: GIBS `ASTER_GDEM_Greyscale_Shaded_Relief`
(31 m, already in earth-detail-inset) — it is a rendered shade, not
elevation, so its flat level must be neutralised before it can be overlaid.
Queued layers, one at a time: day/night + city lights, satellite imagery by
date, pressure + wind from our archive.

**Air-quality layer programme (2026-11-09, owner-approved order):** (1)
airflow particles + the pollution rose — BUILT, below; (2) AQI field + AirNow
monitors with model-minus-monitor residuals (CAMS: bootstrap via the existing
route, badged, OR our own CAMS ingest first — the owner's call, open); (3)
smoke source back-trajectory + forward fire cones (`windAt` already takes a
fractional time index for integrating THROUGH the run); (4) the "smog cooker"
— trapped (low mixing height × light wind) × sunlit (clear, warm), a
conditions diagnostic, not a concentration forecast — needs GFS `HPBL` (and
ideally 850 hPa wind) added to `GFS_VARS`; (5) cloud cover + rain washout +
satellite AOD blind spots under cloud.

**Airflow (2026-11-09, `js/climalytix/airflow.js`, PURE,
`tests/climalytix-airflow.mjs` + `tests/climalytix-airflow.spec.js`):** our
GFS 10 m u/v from `/api/climalytix/nwp-field?vars=uMs,vMs&half=4` (the route
now takes `vars` from `FIELD_VARS`; every variable rides in the same byte
ranges, so a second one costs no R2 read — the route gate proves it on the
Python fixture's identity variables), at the SAME time index as the heat.
Seeded particles on a second canvas (`#cx-map-flow`, `mix-blend-mode:
screen`, because the ONE wind palette is built to add as light — a dark casing
was tried and left grey smudges, measured on screenshots), moving u·Δt / v·Δt
in METRES with the particle's own cos φ, spawned only in the visible part of
the data box (constant density at any zoom). Time compression FOLLOWS THE ZOOM
from a fixed list (10 m/s ≈ 45 px/s; `compressionFor`) and the rail prints the
one in use — at a fixed 1 h a 10 m/s wind moved 0.3 px a frame and read as
dots. It is the FROZEN field at one instant (streaklines, not trajectories),
and the rail says so. Reduced motion draws static streamlines (midpoint rule)
instead. The animation runs only while on, covered and on screen. The WIND
ROSE counts the site's GFS hours by FROM direction (u > 0 is a westerly —
pinned) and its per-sector mean of a co-located series is the POLLUTION ROSE,
waiting for step 2's PM2.5. Browser gate: particle motion checked against the
mock's CLOSED-FORM wind (cos > 0.99) with the u↔v-swapped field as the
negative control; off ⇒ canvas clear and frames stop; off-screen ⇒ frames
stop; the hover tip's direction/speed match the closed form at the coordinates
it prints. Known limit: the window is ±4°, so at the default zoom the flow is
a band around the site with its dashed edge drawn — a wider window needs a
strided field read (next).

**Air quality (2026-11-09, step 2; `js/climalytix/aq-field.js` PURE +
`/api/climalytix/aq-field`, `tests/climalytix-aq-field.mjs` +
`tests/climalytix-aq.spec.js`):** surface PM2.5 / O₃ / NO₂ / dust / AOD from
Copernicus CAMS global through Open-Meteo's FREE air-quality API — role
`bootstrap`, badged on the page; the owner had not chosen between this and our
own CAMS ingest, and this is the reversible path (the layer's contract does
not change when our ingest replaces it). A 0.5° window (±4°, 289 locations,
one request through the ONE chunker `js/open-meteo-request.js`), one day back
and five ahead, on 3-hourly UTC instants (the GFS run's, so wind and PM2.5
join BY INSTANT); hours matched per location by instant, gaps null, a short or
failed fan-out is 200 + expired with no field. Drawn like temperature —
interpolate the concentration, then colour by its EPA category
(`js/aqi-scale.js`, the one palette) — with canvas smoothing OFF because
category colours are flat bands. Colouring one model hour by the 24-hour AQI
is an "AQI-equivalent" and the rail says so. Temperature and Air quality are
one-at-a-time (two full fields read as neither). MONITORS are EPA AirNow via
the site's existing `/api/air-quality/stations`, read at the latest hour no
later than now (at "now" the nearest 3-hourly instant can be 90 min AHEAD —
the first version asked for the future and got nothing), compared with the
field at a field instant ≤ 1.5 h away: the rail prints n, bias and mean miss
(model − measured); the hover names the monitor and both values. The
POLLUTION ROSE (`pollutionRose`, airflow.js) joins the site's sampled PM2.5
to the GFS wind by instant and names the dirtiest and cleanest FROM
directions holding ≥ 2 hours. The route is registered
(`climalytix-aq-field`). Rail explanations now fold into "About this layer".

Next in P-1: GEFS members; ECMWF open data
(IFS/AIFS, needs its own `.index` JSON sidecar planner); the ERA5 history
backfill into the same format (time axis = decades, chunked across runs).

## 18. Our models: how we "rival Open-Meteo"

**Be precise about the target.** Open-Meteo does not run a weather model; it
redistributes the national models (GFS, ECMWF, ICON, …) with downscaling, and so
does nearly every weather API. Nobody small rivals ECMWF at running global physics.
**Where we can be better, and prove it, is everything after the model run.**
Every rung below is a ledger member (§8.6), scored per site, per lead and per variable
against stations and ERA5. **A rung ships only if it beats the rung beneath it on
held-out years**, and the scorecard is public on the Research section (D3). Open-Meteo's
public answer is logged alongside as the **benchmark to beat**, for internal scoring
only (its free tier is non-commercial; we never serve it on a paid path).

| Rung | What | Why it can win | Status of the pieces |
|---|---|---|---|
| **M0 Raw public NWP** | GFS / GEFS / ECMWF IFS+ENS / ICON / HRRR at the nearest points | parity with what Open-Meteo serves; the floor | P-1 ingest |
| **M1 Physical downscaling** | lapse-rate height correction to the site's real elevation, land/sea mask, coastal blending, solar geometry from our exact ephemeris | mountain and coastal sites are where raw 25 km grids miss most; physics, not fitting | uses `js/sun-altitude.js` and the DEM we already ship |
| **M2 Statistical post-processing** | per-site EMOS / NGR and quantile mapping, trained on the **GEFSv12 reforecast** + ERA5/stations, rolling-window updated | calibration is where operational centres gain most; a calibrated ensemble beats a raw one on CRPS almost everywhere | §8.2 already planned; `js/forecast-verification.js` scores it |
| **M3 Skill-weighted blender** | generalises `rust-forecast`'s 5-member blender: members weighted by THIS site's recent CRPS at THIS lead | the best model varies by place and season; a fixed choice cannot follow it | `rust-forecast/` exists (24 h); extend the horizon and membership |
| **M4 Data-driven members** | (a) ECMWF's published **AIFS** output, which needs no GPU; (b) open-weight models with a **commercial-compatible** weight licence run on rented GPU (licence checked per model; GraphCast/GenCast weights are non-commercial and excluded); (c) our own small site models trained on ERA5 for targets NWP handles badly (fog, frost, convective initiation) | AI members are now competitive at medium range; as **logged, scored members** they fit the physics-first rule (CLAUDE.md §7: never a black-box headline) | (a) is just another ingest source; (b)/(c) are §14 Q2 |
| **Beyond 10 days** | §8.3–8.5 unchanged: S2S terciles, ENSO-conditioned seasonal, CMIP6 scenarios | | |

**Where we start:** M0 + M1 + M3 at P-1/P0 (cheap and immediately comparable), M2
at P2 once the reforecast backfill lands, M4(a) whenever the ECMWF ingest exists, and
M4(b)/(c) only after the scorecard says the cheaper rungs have been exhausted.

**The differentiator we already own:** space weather on the same clock. The minute
archive (§17.1) and the scored aurora members are real data today, and no weather
API combines a site's weather with geomagnetic risk, satellite passes and launch
conditions. That is the operator wedge (§2's last row) and it needs no new model.

## 19. Terrain and convection layers (owner request 2026-11-09; built one at a time)

The air near the ground is shaped by the ground. These layers model it in the
order the physics stacks up — each one reuses the one before, and each ships
only with its own node kernel gate (closed forms + a negative control) and a
browser gate on closed-form mock data. Every layer is a DIAGNOSTIC of
conditions from public data, never a claim that a bird or a glider will find
lift at a given spot, and the rail says so.

| Step | Layer | Physics (the closed form the gate pins) | Data | Status |
|---|---|---|---|---|
| **T1** | **Elevation levels + sun exposure** | Terrarium decode `h = R·256 + G + B/256 − 32768`; Web-Mercator tile maths (round trip exact); slope/aspect by Sobel on a 2-node baseline in METRES with cos φ spacing (a tilted plane comes back exact at 0° and 60°; the aspect sign trap is the negative control); incidence `cos θ = cos s·sin α + sin s·cos α·cos(A☉ − aspect)` (flat ground = sin α exactly; a face square to the Sun = 1); the day's direct-beam ratio slope/flat (flat = 1 exactly; an equator-facing slope in winter > 1, pole-facing < 1). Self-shading only — no cast shadows, disclosed. | AWS Terrain Tiles (Terrarium PNG, public, attribution) through `/api/climalytix/dem` (SSRF-safe: z/x/y only, the upstream URL is rebuilt from a frozen candidate list; the no-coordinate form is a capability probe); the Sun is `js/sun-altitude.js` `solarPosition` (the site's one Sun) | **BUILT 2026-11-09** (below) |
| **T2** | **Orographic updraft** | The exact kinematic lower boundary condition `w = u·∂h/∂x + v·∂h/∂y` (flow forced up a slope); windward/leeward from the same dot product. Gate: a uniform wind over a tilted plane gives the closed-form w; wind along the contours gives 0; reversing the wind flips the sign. | T1's DEM + our GFS 10 m u/v (airflow's field) | **BUILT 2026-11-09** (below) |
| **T3** | **Anabatic / katabatic slope winds** | Prandtl (1942): θ′ = Δθ·e^(−n/λ)cos(n/λ), u = Δθ·μ·e^(−n/λ)sin(n/λ), λ = (4K·K_h/(N²sin²α))^¼, **μ = g/(θ₀·N·√Pr)** (corrected 2026-11-09: the first draft's √(gK/(θ₀N²Pr)) is not a speed and is now the gate's negative control); peak u = 0.3224·μ·Δθ at n = πλ/4, independent of the slope angle. Forcing Δθ = Q/h from each slope's OWN budget (Meinel beam × T1 incidence × Kasten–Czeplak cloud − net longwave). Gate: both ODEs by finite differences, the peak, sign follows Δθ, flat ground has none, gentle slopes left blank. | T1 + GFS total cloud + 2 m T (`nwp-field?vars=cloudPct,tempC`) | **BUILT 2026-11-09** (below) |
| **T4** | **Thermals** | Deardorff convective velocity `w* = (g/θ_v · H/(ρ·c_p) · z_i)^⅓`; thermal tops at the boundary-layer depth z_i; cumulus base at the EXACT LCL (Romps 2017, Lambert W; Espy's 125 m/K is only the cross-check) — "blue" thermals when the LCL sits above z_i. Gate: the LCL's defining saturation identity, w* scales as H^⅓ and z_i^⅓ exactly, H ≤ floor gives none, the flux window convention. | Our GFS archive + SHTFL (3 h mean), HPBL, PRES surface — ingested from 2026-11-09 (DSWRF not needed) | **BUILT 2026-11-09** (below) |
| **T5** | **Updraft (general)** | The vertical air motion available, LISTED never summed: orographic (T2, surface) · the slope jet's vertical part u·sin α (T3) · thermal w* (T4, a SCALE, not a mean) · GFS w at 850/700/500 hPa (a 25 km GRID MEAN). GFS publishes DZDT (geometric w, m/s) beside VVEL, so the ω → w = −ω/(ρg) conversion first proposed here is unnecessary. Gate: level heights (hypsometric, standard-lapse mean T) reproduce the ICAO atmosphere to < 0.2 % (an isothermal column is the negative control); a level within 25 hPa of the surface pressure is BELOW THE GROUND and masked; the list carries no total. | T2–T4 + GFS DZDT 850/700/500 (ingest) | **BUILT 2026-11-09** (below) |
| **T6** | **Convection** | Parcel theory on the GFS column: CAPE, CIN, lifted index (ingested, not recomputed — GFS's own), the convective temperature, and a "convection outlook" timeline panel (CAPE, CIN, LCL, z_i, w*) in Explore. Gate: a dry-adiabatic sounding has CAPE 0; the LI sign convention (negative = unstable) pinned both ways. | GFS CAPE/CIN/LFTX (ingest) | planned |

**T1 as built (2026-11-09).** `js/climalytix/terrain.js` (PURE,
`tests/climalytix-terrain.mjs`) + `/api/climalytix/dem` + the map's "Elevation"
and "Sun exposure" toggles (`tests/climalytix-terrain.spec.js`). The DEM is
sampled onto a lat/lon grid matched to the view (the map is equirectangular,
the tiles are Mercator — sampling through the exact inverse, never stretching
a tile image), at a tile zoom chosen so a DEM pixel is about one screen pixel
(z ≤ 12). Elevation levels are contour lines at a round interval in the
READER's unit (feet or metres, `contours.js`, the isotherm machinery), every
fifth one labelled. Sun exposure is a fill — "now" (the incidence at the
timeline's instant; night is BLANK, never painted as shade) or "today" (the
slope's direct-beam total over one Sun track at the map centre ÷ flat
ground's; the track is disclosed in the rail) — and is one-at-a-time with
Temperature and Air quality. A tile that will not load leaves a hole;
nothing is invented under it. Two measured adjustments: (1) the colour
saturates at HALF A STOP (0.71× / 1.41×, `EXPOSURE_FULL_LOG2`) — at one stop a
10° slope at 40° N painted ~20 % opaque and the layer read as empty; (2) the
rail quotes the slope RESOLUTION as the coarser of the DEM pixel and the
grid node (the default 7.5° view samples every ~8 km and honestly smooths a
22 km ridge to 3° — the browser gate zooms in before checking slopes). The
browser gate's DEM is a closed-form east–west ridge served as real Terrarium
tiles (`MOCK_RIDGE` in the mocks), so height, slope, aspect and the exposure
sign are checked against numbers, and "over today" against the kernel's own
`dailyRatio`; DEM down is the negative control. Unverified against the live
AWS bucket (egress-blocked here): one production `GET /api/climalytix/dem`
settles which host answers.

**T2 as built (2026-11-09).** `js/climalytix/orographic.js` (PURE,
`tests/climalytix-orographic.mjs`) + the map's "Orographic lift" toggle
(`tests/climalytix-orographic.spec.js`). w = u·∂h/∂x + v·∂h/∂y on T1's own
grid (`slopeAspect`'s dzdx/dzdy, metres with cos φ) under the SAME GFS 10 m
wind frame the airflow layer draws (its time index — not a second one);
`slopeWind` is the same quantity in slope/aspect form and the gate pins the
two equal. Red = forced ascent, blue = forced descent, √ ramp to full at
2 m/s; the hover gives m/s (and ft/min for a feet reader) and names the
windward / lee side; the rail names the strongest ascent and descent in view
and the wind frame's local time. It joins the one-at-a-time fills. One
measured adjustment: the paint FLOOR is 0.1 m/s and the ramp starts there —
at 0.02 m/s from zero, 50 m of roughness under a 9 m/s wind striped every
plain at ~30 % opacity, and real terrain is rough everywhere. Disclosed in
the rail's notes: it is the SURFACE value (it decays aloft over about the
hill's width; lee waves are not modelled), the wind is GFS's on GFS's own
~25 km terrain, and w is only as fine as the slope grid. Browser gate: the
closed-form ridge under a UNIFORM mocked wind (`windFn`) — a south wind gives
±8·tan s on the flanks and 0 on flat ground, reversing flips the sign, a west
wind along the contours gives none (negative control), and no wind field
draws nothing; swapping u and v in the kernel fails 3 of the 4 browser tests
and the node gate (checked).

**T3 as built (2026-11-09).** `js/climalytix/slope-wind.js` (PURE,
`tests/climalytix-slope-wind.mjs`) + the map's "Slope winds" overlay
(`tests/climalytix-slope-wind.spec.js`). Prandtl's steady jet on every slope
with u > 0 upslope, drawn as ARROWS along the fall line (amber up, blue down)
— an overlay, so it can sit on Sun exposure. The forcing is each slope's own
energy budget at the timeline's instant: (1 − albedo 0.2) × Meinel clear-sky
beam × the slope's incidence × Kasten–Czeplak cloud damping, minus an 80 W/m²
clear-sky net longwave loss damped 90 % under overcast; Δθ = Q/h with
h = 150 (day) / 20 (night) W m⁻² K⁻¹, N = 0.010 / 0.020 s⁻¹, K = 5 / 0.5 m²/s,
Pr = 1 — fixed typical constants, chosen so typical cases land in Whiteman's
observed ranges (gated as RANGES: a sunlit 15° slope 1–6 m/s, a clear night
1–4 m/s; measured 3.8 and 2.2 m/s). Direction, timing (an east face turns
upslope first) and relative strength are the claims; speed is an order of
magnitude, and the rail and notes say so. Slopes whose spin-up period
2π/(N·sin α) exceeds 3 h are BLANK (below 3.3° by day, 1.7° at night) — the
flow cannot reach the steady state the model draws. The cloud + 2 m T field
is fetched on FIRST enable only; no cloud field ⇒ clear sky, labelled as an
UPPER bound. The browser gate puts the map at local solar noon and midnight
on the closed-form ridge and RECOMPUTES every reported value with the kernel
and an independent Sun; sabotaging the map to ignore the cloud field fails
the overcast test, and to ignore the timeline (wall clock) fails the noon
test (both checked). Not modelled, and said: cast shadows, the valley and
synoptic wind on top, and afternoon convective turbulence. One bug found by
the gate: with the DEM down the rail sat on "Loading…" — the rail is now told
on every draw.

**T4 as built (2026-11-09).** THE INGEST GREW (append-only, so existing
archives keep their var indices): `shflxWm2` (SHTFL, a bucket MEAN), `hpblM`
(HPBL) and `psfcHpa` (PRES surface, offset 750 so the Tibetan plateau does
not clip). Averages are de-windowed through their INTEGRAL — the 3 h mean
over (3, 6] is (6·avg₀₋₆ − 3·avg₀₋₃)/3, never the plain difference (idx.py
`step_value`, the difference is the gate's negative control) — and the worker
now keeps a plan and a previous window PER windowed var (its single slot was
right only while precipitation was the only one). `tests/climalytix_ingest_test.py`
runs `run_ingest` END TO END over the real f000–f012 .idx files with HTTP and
GRIB decoding stubbed to closed forms, and fails if the per-var bookkeeping is
shared (checked). The tile fixture is unchanged (it is its own 3-var cube).
`FIELD_VARS` gains dewC + the three; a run ingested before them answers "no
variable … in this run" and the rail says the fields arrive with the next run.
The kernel is `js/climalytix/thermals.js` (PURE, `tests/climalytix-thermals.mjs`):
Deardorff w*, ρ = p/(R_d·T_v), Romps' exact LCL (its saturation identity holds
to 1e-16; the truncated exponent misses by 14–23 % and puts cloud base ~300 m
low; Espy agrees within 2–10 %), top = min(z_i, LCL), cu vs blue, strength
words = the RASP convention. THE FLUX CONVENTION: a GFS mean ENDS at its
stamp, so the instant uses the window ending at the NEXT stamp and the
instantaneous fields are interpolated across it (`windowAt`); the browser
gate (`tests/climalytix-thermals.spec.js`, closed-form mocks linear in
lat/lon) recomputes every number and fails 3 of 4 tests if the map reads the
previous window (checked). It is a fill in the one-at-a-time group on GFS's
own 25 km grid (disclosed: triggers are not resolved; w* is not a climb
rate), with the dashed window outline, a site summary and the day's
w* ≥ 1 m/s span in the rail. One measured adjustment: full paint at 3.5 m/s
with alpha ≤ 0.65 — at 2.5 / 0.8 an ordinary midday field was an opaque slab.
NOTE: nothing appears in production until the ingest workflow has run once
with the new GFS_VARS.

**T5 as built (2026-11-09).** The ingest gained `wMs850`, `wMs700`, `wMs500`
(GFS DZDT, instantaneous, scale 0.001 m/s — append-only). THE WIRE BUG IT
FOUND: `fieldBody` rounded every value to 0.1, which turned every w (cm/s)
into 0 or ±0.1 — it now keeps each variable's own precision (`ceil(−log10
scale)` decimals below 0.01, 0.1 otherwise; the point-tile gate's negative
control is the old rounding). The kernel is `js/climalytix/updraft.js` (PURE,
`tests/climalytix-updraft.mjs`): `levelHeightAgl` (hypsometric, standard-lapse
mean T), `levelUsable` (THE MASK: a pressure level is used only where the
surface pressure exceeds it by 25 hPa — at Boulder 850 hPa is underground and
is a hole, never extrapolated fiction), `bracket` (instantaneous fields
interpolated between stamps, the analysis included — unlike a flux window),
and `verticalMotion`, a LIST sorted by height with kinds surface / slope /
scale / mean and no total anywhere. The map's "Updraft" fill (one-at-a-time,
level picker 850/700/500, red up / blue down on T2's palette) and the rail's
"not added" table; the browser gate (`tests/climalytix-updraft.spec.js`) uses a
mock surface pressure under 850 hPa everywhere, so a page without the mask
WOULD draw ordinary 850 hPa numbers — removing the mask fails 2 of 4 tests
(checked). An archive ingested before DZDT says so and draws nothing.

**VISUALS ARE DELIBERATELY PLAIN UNTIL T6 (owner, 2026-11-09).** T1–T5 were
built for correctness on closed-form mocks; the screenshots look basic because
the mocks are smooth planes and no styling pass has been done. A VISUAL POLISH
PASS across all six layers (palettes, legends, rail typography, the budget
table, how fills and overlays stack) is scheduled AFTER T6, gated by the same
browser specs — the polish must not move a single gated number.
