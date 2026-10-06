# Planetary Temperature Lab — where Earth is hottest, coldest, and most unusual

Status: **PLAN, not built.** The Phase-0 spike in §2 was measured on 2026-10-05 and can be
reproduced with `scripts/temperature_lab_spike/` (§13). The plan covers two surfaces:

- a standalone page, `temperature-lab.html`;
- a **modal panel inside EarthView** (`earth.html`), which reads the same data through the
  same kernel.

Read `CLAUDE.md` §4.4 and §4.6 before touching the EarthView half, and `HOME_GATING_PLAN.md`
before touching the upsell gates.

---

## 0. TL;DR

- **What the lab answers.** Where on Earth is it hottest and coldest right now? Where is it
  most out of character for the date (warm side and cold side)? How does today compare with
  the climate normal for the planet as a whole?
  - It answers with five scorecards: Hottest, Coldest, Most above normal, Most below normal,
    and Biggest 24-hour swings.
  - It adds a planet strip of headline numbers, a global anomaly map, and a "your place"
    card.
- **"Do we already have the 30-day prediction?" Yes.**
  - `js/temp-outlook.js` `projectDays` is the 30-day daily high/low projection.
  - It is drawn today as the homepage Temperature tab's calendar.
  - The lab REUSES it through the same seam and does not fork it (§8).
  - `TEMP_OUTLOOK_ENGINE_PLAN.md` already scopes the engine that will replace its v0
    formula. When that lands, it upgrades the homepage and the lab together.
- **The missing piece is a real climatological normal for the global grid.** Today there are
  only two:
  - the Storm Watch "Global extremes" section, which compares the current hour against the
    last **30 days**;
  - the homepage and Climate Lab, which use a **3-year** per-location archive.
  - §2 measures the 30-day method against a 1991–2020 baseline. **51 % of its heat flags are
    below the climatological 90th percentile for that date and hour, and 64 % of its cold
    flags are above the 10th.**
  - The lab's backbone is therefore a 1991–2020 ERA5 normal on EarthView's 72×36 grid. It is
    built offline and shipped as a compact asset: about 115 KB compressed for the daily
    normals.
- **Production blocker found during the spike.** Every frame of `weather_grid_cache` for the
  last 30 days (270 of 270) came from the **MET Norway fallback**.
  - That fallback is 648 points at 10° spacing, bilinear-upsampled to 5°.
  - The pipeline heartbeat reports it as healthy.
  - Measured against ERA5 at 0.25°, that field misses the hottest land point by a **median
    6.3 K** and the coldest by **8.3 K**.
  - The lab cannot rank extremes on it. Phase 0b restores the primary source (§9) and is a
    prerequisite, not polish.
- **Access ladder.** It reuses AurOracle's pattern: anonymous teaser → free account → Intro
  (plan id `basic`, $9.99).
  - Free gets the live lab.
  - Intro gets the prediction and analysis depth: 30-day outlook, forecast-anomaly map,
    heat-wave and cold-wave watch, the old-normal baseline lens, the cities heat-stress
    board, and anomaly alerts.
  - Upsell teasers are the existing `js/gate-modal.js` (one new variant per reach point).
    They fire only when the user reaches for a locked feature, never on load (§7).
- **New upstream calls for the global field: zero.** The live aggregate reads the existing
  `weather_grid_cache` inside Postgres, the way `compute_weather_extremes` already does. Only
  the extreme-site network and the Intro forecast grid add batched calls (§4.4–4.5).

---

## 1. What exists today — reuse map (do not rebuild)

| Concern | What's there | File(s) | How the lab uses it |
|---|---|---|---|
| Live global temperature | 72×36 (5°) hourly grid of `current.temperature_2m` (+8 channels); hourly for 72 h, 3-hourly back to 30 d | `api/cron/refresh-weather-grid.js` → `weather_grid_cache` → `/api/weather/grid` → `js/weather-feed.js` | The lab's live field. Aggregated in Postgres (§4.3); never re-fetched |
| Forecast frames on the globe | Browser-direct Open-Meteo hourly on the same grid, progressive to +14 d (a full +14 d pull is 30–40 MB) | `js/weather-forecast-feed.js` | EarthView's anomaly layer reads these frames. The lab page does **not** — it gets a server-side daily grid (§4.5) |
| "Extremes" today | Per-cell percentile of the current hour against the last 30 days, computed in Postgres hourly; severity p95 / p99 / 30-day max | `supabase-weather-extremes-migration.sql`, `api/weather/extremes.js`, `js/extremes-watch.js` (Storm Watch section) | Kept. Its baseline is measured in §2 F and re-labelled or upgraded per decision D10. Its `REGIONS` + `clusterCells` move to a shared `js/` kernel (§4.6) |
| 30-day outlook per location | `projectDays` v0: leads 0–15 are Open-Meteo NWP; leads 16–30 are normal + anomaly × e^(−Δ/τ), with τ fitted from the place's own 3-year archive; `buildMonthCalendar` | `js/temp-outlook.js`, `js/home-conditions.js` `buildTempModel`, `js/home-sky-console.js` (renderer) | Reused unchanged as the Intro 30-day card (§8) |
| "Is today normal here?" | 3-year ERA5 percentile card, explicitly *not* a WMO normal | `js/climate-lab/lab-climate.js`, `lab-physics.js` `climatePosition` | The lab reuses `climatePosition`'s class names (`much-below` … `much-above`, `beyondRecord`) so the two products speak one vocabulary |
| Human-impact indices | NWS heat index (Rothfusz), NWS wind chill, Stull wet-bulb, apparent temperature | `js/composite-indices.js`, `js/climate-lab/lab-physics.js` | Secondary columns on the Hottest/Coldest cards and on the cities board — imported, never re-derived |
| Temperature colour | Diverging ramp pivoting at 0 °C over an encoded −60…+50 °C | `js/temp-ramp.js`, `js/weather-decode.js` | Absolute map. **The encode CLAMPS at −60 °C**, so a scorecard must never read the decoded texture (§3.6) |
| Conversion gates | `openGate(key, opts)`, `GATE_VARIANTS` (free vs paid); dims the sim and never destroys it; fails open; suppressed in preview frames; telemetry built in | `js/gate-modal.js`, `HOME_GATING_PLAN.md` | Every upsell teaser (§7) |
| Three-tier access ladder | `computeAccess()` → teaser / week / full; body classes blur locked blocks; re-evaluates on `auth-changed` | `js/auroracle.js` 595–683 | Copied as the lab's access module (§7.1) |
| Tier math | `tierLevel(plan, role)` ≥ 2 = Basic ("Intro"); `intro` is a legacy alias for `basic` | `js/tier-config.js` | The Intro gate |
| Panels on EarthView | `makePanelDraggable` (`raiseOnGrab` z 76–89), panel header conventions, delegated minimise/close, mobile toolbar + `.panel-open` bottom sheets | `js/draggable-panel.js`, `earth.html` 1669–1712, 2259–2348, 15454–15506 | The modal panel (§6) |
| Map-lab page pattern | 72×36 equirectangular canvas, IDW, `rowAreaWeight`, scrubber `TimelineStrip`, scorecards | `pollution.html`, `js/pollution-model.js`, `js/pollution-timeline.js` | Page architecture (§5) |
| City list | 318 cities with population, including polar/Pacific coverage cities | `js/data/major-cities.js` | Nearest-city labels + the Intro cities board |
| Feed registry | `PIPELINES` → status page + prewarm tiers + node gate | `js/pipeline-registry.js` | Every new route registers (§4.5) |

### 1.1 What is missing (why this is not a re-skin)

1. **No climatological normal for the grid** (§0). Channel 0 has no climatology anywhere in
   EarthView. `AtmosphereClimatology` covers only cloud and wind.
2. **The live field is degraded in production** (§0, §2 H). Nothing currently says so: the
   heartbeat is green and the frames are tagged `met-norway:72x36`.
3. **The grid's values are model output, not thermometer readings.** "Current" temperatures
   are an NWP nowcast at a grid point. ERA5 at 0.25° put **36.8 °C** at Lytton on the
   afternoon the station read **49.6 °C** (§2 H). The lab may say "hottest model grid point
   we sample". It may never say "hottest place on Earth" or "record".
4. **Region labels are server-only.** `REGIONS` lives in `api/weather/extremes.js`, and
   `api/` is not served statically (the `hek-filaments` scar).
5. **There is no server-side forecast grid.** EarthView's forecast frames are browser-direct
   and heavy.

---

## 2. What the data say (Phase-0 spike, measured 2026-10-05)

### Setup

- **Data:** WeatherBench2's public ERA5 mirror (`gs://weatherbench2`, plain HTTPS). Three
  pulls:
  1. ERA5 **hourly** at 1.5°, sampled at the 2592 cell centres `refresh-weather-grid.js`
     uses, 1991–2021 (271 752 hours).
  2. ERA5 6-hourly at 5.625°, 1961–2021, used only for the baseline-shift question.
  3. 97 ERA5 **0.25°** snapshots through 2021, plus the Pacific Northwest heat-dome hour.
- **Definitions:**
  - Daily Tmax / Tmin / Tmean are on **local solar days** (offset `round(lon/15)` h), the
    convention the production build will use.
  - Train is 1991–2020; held-out is 2021.
- **Harness check:** the spike reproduces published numbers before any of its own are read.

| Quantity | Spike | Published (Copernicus C3S) |
|---|---|---|
| Global mean 2 m temperature, 1991–2020 | **14.39 °C** | 14.38 °C (2023 = 14.98 °C = +0.60 over 1991–2020) |
| 2021 anomaly vs 1991–2020 | **+0.28 K** | +0.3 K |

The 72×36 point sample of ERA5 is therefore a faithful planet-scale instrument. That is what
licenses the planet strip (§3.5).

### 2.1 B — How smooth should the daily normal be? (split-half cross-validation, K RMS)

Each method is fitted on odd years and scored against the even years' windowed mean, then the
reverse. The reference's own noise is in every row equally, so only the differences between
rows matter.

| Normal | Tmax | Tmin | Tmean |
|---|---|---|---|
| ±7-day window (the `climatologyByDoy` method the homepage uses) | 0.557 | 0.537 | 0.534 |
| Annual harmonics N = 1 | 0.965 | 0.911 | 0.921 |
| N = 2 | 0.540 | 0.529 | 0.518 |
| N = 3 | 0.510 | 0.493 | 0.489 |
| **N = 4** | **0.504** | **0.485** | **0.482** |
| N = 5 | 0.508 | 0.489 | 0.487 |

- The SD normal is fitted as N = 2 harmonics of the squared residual about the mean normal.
  It sits 0.20–0.21 K RMS from the windowed SD.
- Shipping 3 variables × (mean + variance) costs 36–42 coefficients per cell. That is
  **187 KB as int16 and 114 KB deflated** for the whole grid at N = 3; N = 4 adds about 17 %.

### 2.2 C — Hour-of-day normal (for an anomaly at any scrubbed hour on EarthView)

The fit is annual N = 3 × diurnal K harmonics (tensor), scored by split-half against the
empirical (month × local-hour) mean, on a 1-in-4 cell subsample.

| Diurnal harmonics | K = 0 (daily mean only) | K = 1 | **K = 2** | K = 3 |
|---|---|---|---|---|
| CV RMS (K) | 1.595 | 0.655 | **0.584** | 0.567 |
| Coefficients / cell | 7 | 21 | **35** | 49 |

### 2.3 D — Is mean ± k·σ a fair rarity measure?

**In-sample** (1991–2020) tail rates of the Gaussian thresholds, by band and surface. Expected
values are 5 % at |z| = 1.645 and 1 % at |z| = 2.326.

The table gives the range across the 18 band × surface × variable combinations
(tropics / mid-latitudes / high latitudes × land / sea × Tmax / Tmin / Tmean).

| Tail | Expected | Measured range | Extremes |
|---|---|---|---|
| z > +1.645 | 5 % | 3.5–5.4 % | low: tropical land Tmax |
| z < −1.645 | 5 % | 4.5–7.2 % | high: high-latitude sea (all three variables) |
| z > +2.326 | 1 % | **0.42–1.83 %** | low: tropical land Tmax; high: high-latitude sea Tmin |
| z < −2.326 | 1 % | **0.82–3.02 %** | high: high-latitude sea Tmax (3.0 %), tropical land Tmax (1.8 %) |

**Held-out 2021** against the *empirical* 1991–2020 pool (±7 days × 30 years):

| Daily Tmean, 2021 | All cells | Land | Expected if climate were stationary |
|---|---|---|---|
| > p90 | **14.0 %** | **14.8 %** | 10 % |
| > p95 | 7.9 % | 8.2 % | 5 % |
| < p10 | 6.7 % | 7.6 % | 10 % |
| < p05 | 3.2 % | 3.8 % | 5 % |
| > 1991–2020 max for the date (±7 d) | 0.75 % | 0.71 % | ≥ 0.22 % (1/451 if the 450 pooled days were independent; day-to-day autocorrelation raises it, so no multiplier is claimed) |

### 2.4 E — Rank "most unusual" by degrees or by standardised anomaly?

These are 2021 daily top-10 lists with a minimum separation of 1500 km, averaged over 365
days.

| Top-10 list | Ranked by | Median \|lat\| | Poleward of 50° | Mean ΔT | Mean z | Overlap of the two lists |
|---|---|---|---|---|---|---|
| Warm, all cells | raw ΔT | 61.8° | **71 %** | 9.7 K | 1.94 | **11 %** |
| | z | 36.2° | 36 % | 4.2 K | 3.51 | |
| Warm, land | raw ΔT | 59.3° | 66 % | 9.3 K | 1.91 | 28 % |
| | z | 33.8° | 33 % | 6.4 K | 2.52 | |
| Cold, all cells | raw ΔT | 63.0° | **75 %** | 9.2 K | 1.80 | 13 % |
| | z | 39.9° | 40 % | 4.4 K | 3.21 | |
| Cold, land | raw ΔT | 60.6° | 68 % | 8.6 K | 1.73 | 33 % |
| | z | 38.7° | 38 % | 6.5 K | 2.20 | |

### 2.5 F — The existing Storm Watch method vs a climatological baseline (2021, every 6 h)

The existing method replicates `compute_weather_extremes` exactly:

- history is every 3rd hourly frame of the previous 30 days, newest excluded;
- heat means ≥ p95 and ≥ 25 °C;
- cold means ≤ p05 and ≤ 0 °C.

The climatological reference uses the same thresholds against the (date ± 7 d, same UTC hour)
1991–2020 pool.

| | Heat | Cold |
|---|---|---|
| Flags raised by the 30-day method | 89 126 | 161 455 |
| …that are also climatological flags (precision) | **33 %** | **21 %** |
| …that are not even beyond the climatological p90 / p10 | **51 %** | **64 %** |
| …that are on the *wrong side of normal* (below / above the median) | 5.6 % | 7.6 % |
| Climatological flags the 30-day method catches (recall) | 36 % | 57 % |
| Flags falling at local 12–17 h (30-day vs climatology) | **60 %** vs 29 % | — |

On NH extratropical land the seasonal drift is plain to see. The window method raises
autumn cold flags at 6–12× the climatological count:

- Sep: 3829 vs 605
- Oct: 6969 vs 567
- Nov: 9017 vs 1444

Autumn heat flags are suppressed:

- Sep: 326 vs 890
- Oct: 108 vs 387

### 2.6 G — How far did the normal move? (5.625°, 6-hourly)

| | 1961–1990 | 1991–2020 |
|---|---|---|
| Global mean | 13.85 °C | 14.37 °C (**shift +0.52 K**) |
| 2021 anomaly against it | **+0.80 K** | +0.28 K |
| 2021 cell-days above that normal | **71.8 %** | 57.6 % |

### 2.7 H — Hot-spot dilution and representativeness (97 snapshots, 0.25° truth)

| How far each field's extreme falls short of the 0.25° extreme on land | Median | p90 | Max |
|---|---|---|---|
| 5° grid points (0.25° sampled at the 2592 centres), hot | 2.1 K | 5.0 K | 8.8 K |
| 5° grid points, cold | 2.3 K | 5.8 K | 7.6 K |
| 1.5° boxes, hot / cold | 1.2 / 1.6 K | 3.0 / 3.3 K | 5.0 / 5.1 K |
| **The production fallback** (10° points bilinear to 72×36, mirroring `upsampleToGrid`), hot | **6.3 K** | 9.3 K | 13.6 K |
| **The production fallback**, cold | **8.3 K** | 12.2 K | 13.9 K |

- **The fallback's per-cell error.** The fallback field sits **5.4 K RMS** (land, median
  snapshot) from a proper 5° point sample.
- **Representativeness, 0.25° point minus 1.5° box at the cell centres.** Mean absolute
  offset is 0.88 K on land (p95 3.1 K) and 0.23 K at sea. The time-varying part has a median
  SD of 0.84 K. **66 % of the land mean-square is static**, so a per-cell offset removes
  about two-thirds of it.
- **Lytton, 2021-06-30 00 UTC.**
  - ERA5 0.25° read **36.8 °C** in a cell whose orography sits at **1333 m**.
  - The station recorded **49.6 °C** that afternoon.
  - The nearest 5° cell (52.5° N, 122.5° W) read 39.9 °C.

### 2.8 I — Where the extremes actually are (0.25° land census of 2021)

Each snapshot contributes its top-8 hottest and coldest land points, at least 800 km apart.
They are binned into 10° boxes.

- **Hot, recurring:**
  - central Sahara (to 47.5 °C)
  - Sahel/Mali
  - Niger
  - Rub' al Khali / Oman (50.5 °C)
  - Khuzestan–Kuwait (**51.4 °C**)
  - eastern Saudi Arabia
  - Lut / Kerman (49.7 °C)
  - Sudan
  - Pilbara and the NT (45.9 °C)
  - Sonoran desert near Phoenix (45.2 °C)
  - Gran Chaco
  - northern Colombia
- **Cold, recurring:**
  - East Antarctic plateau, the Dome Fuji–Dome A–Vostok arc (to **−79.2 °C**)
  - South Pole region
  - Yakutia / Verkhoyansk range (−55.8 °C)
  - Evenkia
  - Taymyr
  - Kolyma

The full list is in `results-2026-10-05.json` under `I`.

### 2.9 Findings, and the design rule each one sets

| # | Finding | Rule |
|---|---|---|
| R1 | Harness reproduces C3S to 0.01 K (absolute) and 0.02 K (2021 anomaly) | The planet strip's global anomaly is a **real** number, not decoration. Gate it in node tests with the same reference values |
| R2 | Harmonics beat the ±7-day window; N = 4 is the CV optimum and N = 5 overfits | Normal = **N = 4 mean + N = 2 variance**, per variable per cell. One function, `js/temperature-normals.js` |
| R3 | Diurnal K = 2 captures nearly all of it (0.584 vs 0.567 at K = 3) | Hour-of-day normal = annual N = 3 × diurnal K = 2 (35 coef/cell), lazy-loaded by EarthView only |
| R4 | Gaussian tails miscalibrate up to **3×** at 1 % (high-latitude sea, tropical land) | **Rarity labels use empirical quantile curves** (stored per cell, harmonic-smoothed), never `Φ(z)`. z is kept for colour scales only |
| R5 | Raw-ΔT rankings are 66–75 % poleward of 50° and share 11–33 % of entries with rarity rankings | "Most above/below normal" **ranks by rarity** (empirical percentile) and prints ΔT beside it. A raw-ΔT sort is an explicit secondary option, never the default |
| R6 | The 30-day-window method is half seasonal drift and half the diurnal cycle | Nothing on the lab says "unusual" off a 30-day window. Storm Watch's section is re-labelled "vs the last 30 days" or moved to the normal (D10) |
| R7 | 2021 hit the warm tails 1.4–1.6× as often as 1991–2020, and the cold tails 0.6–0.8× | **Expected asymmetry**, and the page says so in one line. A warm card busier than the cold card is the climate signal, not a bug |
| R8 | The baseline choice moves the 2021 anomaly from +0.28 to +0.80 K | Every anomaly carries its baseline label. 1991–2020 (WMO) is the default; 1961–1990 is the Intro lens "how far from the old normal" |
| R9 | 5° points miss the hottest place by a median 2.1 K; the fallback misses by 6.3 K | Absolute cards rank a **site network** (§4.4) ∪ the grid, never the grid alone. **Phase 0b (restore the primary grid source) blocks launch** |
| R10 | Even 0.25° reanalysis is 13 K short of a canyon station on a record day | Absolute values are "model analysis at a sampled point". Records and "hottest on Earth" are station claims this lab does not make (§3.7) |
| R11 | 66 % of the 1.5° → point representativeness error is static | Normals are built from 1.5° hourly (cheap, proper Tmax/Tmin) **plus a per-cell seasonal offset** fitted against the live source (§4.2 step 3) |
| R12 | The census finds the extremes in a short, stable list of regions | The site network is **seeded from a multi-year 0.25° census**, not typed from memory, and each entry records why it is there |

---

## 3. Definitions — the one copy of what the lab claims

All of this lives in `js/temperature-lab-model.js` (PURE). The route, the page, the EarthView
panel and the node tests import that one file.

### 3.1 The normal

- **Period:** 1991–2020 (the WMO standard normal), from ERA5.
- **Variables:** daily Tmax, Tmin and Tmean on the cell's local solar day.
- **Form:** per cell, per variable:
  - the mean is N = 4 annual harmonics;
  - the variance is N = 2 harmonics;
  - quantile curves (p01, p05, p10, p25, p50, p75, p90, p95, p99) are N = 2 harmonics fitted
    to the windowed empirical quantiles;
  - a **record envelope** (the ±7-day, 30-year max/min) is stored per pentad, because records
    are not smooth and a harmonic would understate them.
- **Hour-of-day normal (EarthView only):** annual N = 3 × diurnal K = 2 on hourly T2m.
- **Representativeness correction:** a per-cell seasonal offset (N = 1) aligning the 1.5°
  normal with the live source's point values (§4.2).

### 3.2 Today's numbers

The window is the **trailing 24 hours** ending at the newest grid frame. Every cell's window
then holds exactly one diurnal cycle, wherever it is on Earth.

- `t24max`, `t24min` and `t24mean` are compared with the daily normals at the window
  midpoint's day of year.
- `tNow` is the newest frame.
- A cell with fewer than 18 of 24 frames is **null**, never zero. That is the gaps-are-not-
  zeros rule from the Pollution Lab.

### 3.3 Anomaly and rarity

- **ΔT** = value − normal mean, in kelvin. It is converted to °F only at display.
- **Rarity** = the empirical percentile from the cell's quantile curves.
  - Linear between stored quantiles.
  - Beyond p01/p99, a Gaussian extrapolation on the tail spacing, labelled "beyond the 1 %
    tail".
- **Categories:** these reuse `climatePosition`'s class names so the Climate Lab and the lab
  agree.

| Class | Percentile |
|---|---|
| `much-below` | < p10 |
| `below` | p10–p33 |
| `near` | p33–p67 |
| `above` | p67–p90 |
| `much-above` | > p90 |
| `beyondRecord` | beyond the 1991–2020 record envelope for the pentad |

### 3.4 The five scorecards

| Card | Ranked by | Universe | Printed per row |
|---|---|---|---|
| 🔥 **Hottest now** | `t24max` (air temperature; WMO convention) | site network ∪ grid, land | place, value, normal for the date, ΔT, heat index or wet-bulb (secondary) |
| 🧊 **Coldest now** | `t24min` | site network ∪ grid, land | place, value, normal, ΔT, wind chill (secondary) |
| 📈 **Most above normal** | rarity of `t24mean` (R5) | grid, land default (ocean toggle) | place, ΔT, "warmer than N % of <date>s 1991–2020", category |
| 📉 **Most below normal** | rarity of `t24mean`, cold side | grid, land default | as above |
| ⚡ **Biggest 24-h swings** | \|`t24mean` − previous `t24mean`\| | grid, land | place, Δ day-over-day, sign |

Rows are de-duplicated with a minimum separation of 1500 km (the spike's rule). They are
labelled with the shared `REGIONS` name plus the nearest `MAJOR_CITIES` entry within 300 km.

### 3.5 The planet strip

- **Global mean anomaly today:** area-weighted, harness-validated (R1).
- **Land share in the top decile:** "x % (normal: 10 %)". It is the clearest single "deviant
  from previous patterns" number (R7).
- **Land share in the bottom decile.**
- **Hottest and coldest point right now.**
- **Cells in record territory.**

Each carries its baseline label.

### 3.6 Load-bearing data rules (scar prevention)

- **Never read temperature back from a decoded texture.** `weather-decode.js` encodes
  −60…+50 °C and clamps. The Antarctic plateau sits at −70 to −79 °C in winter (§2 I) and
  would read −60. Scorecards read raw °C from the route only.
- **Gaps stay `null`** end to end (`Number(null)` is 0 and finite).
- **Units are SI in every payload**, converted once at display. The temp-outlook rows are in
  °F by legacy and are converted at the seam (§8).
- **Every number carries its source and baseline:**
  - the normal (`ERA5 1991–2020`);
  - the live field (`model analysis · <source tag>`);
  - fallback disclosure: if any frame in the window is `met-norway:*`, the card says
    "coarse fallback field — extremes understated", because they are, by 6–8 K (§2 H).

### 3.7 Wording rules (R10)

| Never say | Say instead |
|---|---|
| "Hottest place on Earth" | "Hottest of the N places we sample" |
| "Record" | "Above anything in the 1991–2020 reference for the date (ERA5)" |
| "Observed" | "Model analysis" |

Observed station records are a separate, future lens (§11).

---

## 4. Architecture

### 4.1 Data flow

```
            OFFLINE (networked machine, once per normal)            LIVE (hourly)
 WB2 ERA5 hourly 1.5° ─┐                                   Open-Meteo / fallback
 WB2 ERA5 0.25° (bias) ┼─ scripts/build-temperature-normals.py      │ refresh-weather-grid (exists)
 Open-Meteo ERA5 pts ──┘   │                                         ▼
                           ▼                                  weather_grid_cache (exists)
 assets/temperature/normals-*.bin + SOURCES.md                       │ pg_cron :25
 tests/fixtures/temperature/normals-check.json                       ▼
                           │                 compute_temperature_lab() → temperature_lab_cache
                           │                 rollup 13:30 UTC          → temperature_daily_cells
                           │                                         │
 site network (js/temperature-sites.js) ── cron :10 ── Open-Meteo ─▶ temperature_sites_cache
                           │                                         │
                           └────────────┐        ┌───────────────────┘
                                        ▼        ▼
                     /api/temperature/snapshot  (Edge; imports js/temperature-lab-model.js)
                                        │   s-maxage 900, freshness on degrade
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
            temperature-lab.html                 earth.html modal panel (lazy import)
            (2D map + cards)                     + anomaly mode of "Weather (temp)" layer
                                                   (hour-of-day normal × WeatherHistory frames)
```

### 4.2 The normals asset

**Build:** `scripts/build-temperature-normals.py` (offline, never deployed). It runs on a
networked machine, because Open-Meteo and ERA5 mirrors are egress-blocked in the build
sandbox. WB2 happens to be reachable here, which is how §2 ran.

1. Stream WB2 ERA5 hourly 1.5° for 1991–2020 at the 2592 cell centres (§2 shows about 8 s per
   year), and derive local-solar-day Tmax/Tmin/Tmean.
2. Fit the §3.1 forms.
3. **Representativeness offset (R11).**
   - Fit against the 0.25° point first, using WB2 6-hourly 0.25° samples over 2 years.
     That is ~2 900 slices and ~12 GB streamed; at the ~1 s per slice measured here it takes
     ~50 min.
   - Then fit against the **live source**: Open-Meteo's ERA5 at the same points over four
     14-day windows, one per season.
     - That is about 4 × 2592 calls, so spread it over 4 days of free quota.
     - Or run it once on a paid key.
   - Store the residual mean as a per-cell N = 1 harmonic, and report what is left.
4. Write the following, each with a JSON header (version, period, grid, harmonic orders,
   quantisation, source hashes) and int16 bodies:

| File | Contents | Size | Consumed by |
|---|---|---|---|
| `normals-1991-2020.bin` | daily normals | ~115–140 KB deflated | Edge route + browser |
| `quantiles-1991-2020.bin` | quantile curves | ~0.4 MB | Edge route only |
| `records-1991-2020.bin` | pentad record envelope | ~2 MB | Edge route only |
| `hourly-1991-2020.bin` | hour-of-day normal | ~180 KB | EarthView only, lazy |

5. Emit `tests/fixtures/temperature/normals-check.json`: 200 random (cell, doy, hour)
   evaluations computed in Python. The JS kernel must reproduce them to 1e-3 K. This is the
   Vallado pattern from the SGP4 row: the source and the shipped binary are gated against
   each other, not against themselves.
6. Write `assets/temperature/SOURCES.md` with:
   - the ERA5 licence line ("Contains modified Copernicus Climate Change Service
     information");
   - Open-Meteo attribution (CC BY 4.0);
   - a "what is modelled vs observed" section.

The Intro lens adds `normals-1961-1990.bin`: the same build over 1961–1990, plus the same
representativeness offset.

### 4.3 The live aggregate (Postgres, next to `compute_weather_extremes`)

Migration `supabase-temperature-lab-migration.sql`:

- **`temperature_lab_cache`** — derived, public analysis. Anon `SELECT`, the
  `weather_extremes_public_read` precedent.
  - Written hourly at **:25** by pg_cron `temperature-lab-hourly` → `compute_temperature_lab()`.
  - Payload: per-cell arrays `t24max/t24min/t24mean/tNow/prev24mean/coverage`, the newest
    frame time, and the `source` mix of the window.
  - Pure SQL over the last 24 frames. That is cheap next to the 30-day extremes job.
  - Keeps 48 rows.
- **`temperature_daily_cells`** — service-role only, zero policies. This is the `forecast_log`
  pattern; add it to CLAUDE.md §4.2 as an intentional advisor flag.
  - One row per UTC date with the per-cell local-solar-day max/min/mean, computed at **13:30
    UTC** (when every longitude's local day for that date has ended).
  - **This is our own consistent-source daily archive.** It starts accumulating on day one,
    outlives the grid cache's 30-day retention, and is what later verifies everything:
    - the representativeness offset;
    - the Intro forecast-anomaly skill;
    - the monthly harness check against C3S.
  - Keep 800 days; about 31 KB per day.
- **`temperature_sites_cache`** — derived, anon `SELECT`. Holds the latest site-network
  readings (§4.4).

### 4.4 The extreme-site network

`js/temperature-sites.js` holds data plus a node gate (`tests/temperature-sites.mjs`).

- **About 60–80 points** where the planet's extremes actually occur.
  - Seeded from the production build's **multi-year** 0.25° census (R12; §2 I is the
    one-year preview).
  - Curated with the canonical named stations that sit inside those regions: Death Valley,
    Mitribah, Jacobabad, Ahvaz, Turpan, Dallol, Oodnadatta, Verkhoyansk, Oymyakon, Vostok,
    Dome A / Kunlun, Amundsen–Scott, Summit Camp, Eureka (Nunavut), Snag.
- **Each entry carries** `why: 'census' | 'station'` plus the census statistic, so nothing is
  in the list because someone remembered it.
- **The gate checks:**
  - unique coordinates;
  - land per the static mask;
  - every census region represented;
  - every entry labelled by the shared `REGIONS`.
- **Refresh:** cron `api/cron/refresh-temperature-sites.js` runs at **:10** with ONE batched
  Open-Meteo request (`current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m`,
  `daily=temperature_2m_max,temperature_2m_min`, `past_days=1&forecast_days=1`).
  - Cadence: 3-hourly to start (see the budget table).
  - On upstream failure it emits `freshness:'stale'`, never a 5xx.
- **The cities board (Intro)** reuses the same cron with the 318 `MAJOR_CITIES` as a second
  batch, at a 3-hourly cadence.

**Open-Meteo budget.** This is unverified: Open-Meteo is egress-blocked at build time, and the
repo itself carries two readings. `refresh-weather-grid.js` counts calls per request (72/day).
`TEMP_OUTLOOK_ENGINE_PLAN.md` counts per location. The 100 % fallback in §0 is consistent with
per-location counting: a single 864-location request may by itself exceed a per-minute cap.

| Added load | Per request | Per location (conservative) |
|---|---|---|
| Sites, 80 × 8/day | 8 | 640 |
| Cities, 318 × 8/day (Intro) | 8 | 2 544 |
| Forecast grid, 2592 × 2/day (Intro, 16-day daily) | 6 | ~5 900 |

**Phase 0b settles which reading is true** before any of the Intro load is switched on.

### 4.5 Routes and registry

| Route | Runtime | Reads | Cache | Registry |
|---|---|---|---|---|
| `/api/temperature/snapshot` | Edge | `temperature_lab_cache` + `temperature_sites_cache` + normals/quantiles/records assets (fetched from own origin, module-scoped) → runs the kernel | `s-maxage=900, swr=600` | `category:'weather'`, `prewarm:'medium'`, `cadence_s:3600` |
| `/api/temperature/outlook-grid` (Intro) | Edge | `temperature_outlook_grid`, written 2×/day by `api/cron/refresh-temperature-outlook-grid.js` (16-day daily tmax/tmin/tmean at the 2592 points, 3 chunks) | `s-maxage=3600` | `prewarm:'cold'` |

- **Degradation is never a 5xx.**
  - The fallback source → `freshness:'stale'` + `note:'coarse-fallback-field'`.
  - Missing normals → `freshness:'expired'` with the absolute cards only.
- **Registration:** both routes go into `js/pipeline-registry.js`, which is what puts them on
  `status.html` and into prewarm (CLAUDE.md §8). The new crons go into `vercel.json` `crons`
  (CLAUDE.md §4.3).
- The snapshot payload carries the top 25 of each card. Tier slicing happens in the client
  (§7.4).

### 4.6 Modules

| File | Kind | Job |
|---|---|---|
| `js/temperature-normals.js` | PURE | Decode the assets; `dailyNormal(cell, doy)`, `hourlyNormal(cell, doy, solarHour)`, `percentile(cell, var, doy, value)`, `recordEnvelope(cell, var, doy)`. Also exports the **fit** functions, so the temp-outlook engine's per-location climatology can use the same R2 method (§8) |
| `js/temperature-lab-model.js` | PURE | §3 end to end: anomalies, rarity, scorecards (separation, labels), planet strip, area weights |
| `js/geo-regions.js` | PURE | `REGIONS` + `clusterCells` + `regionName`, **moved** from `api/weather/extremes.js`, which then imports it. One copy, browser-importable |
| `js/temperature-sites.js` | data | The site network (§4.4) |
| `js/temp-anomaly-ramp.js` | PURE | Diverging anomaly colour (one byte source for shader LUT + legend, the `temp-ramp.js` pattern; CVD-validated) |
| `js/temp-calendar-view.js` | PURE | `monthCalendarHtml` / `calendarCellTip` / `anomalyStyle` **extracted** from `js/home-sky-console.js` so the homepage and the lab draw one calendar |
| `js/temperature-lab-access.js` | small | `computeAccess()` → `teaser`/`free`/`intro`; body classes; `auth-changed` re-evaluation (the AurOracle shape) |
| `js/temperature-lab-feed.js` | I/O | Fetches the snapshot (+ outlook grid when Intro) and dispatches `temperature-lab-update` |
| `js/temperature-lab-panel.js` | DOM | Cards, planet strip, your-place card, CSS namespaced `.tl-*`, `variant: 'page' \| 'earthview'` |
| `temperature-lab.html` | page | §5 |

---

## 5. The standalone page — `temperature-lab.html`

The page is 2D-first, on purpose (D5): EarthView is the 3D surface, and the page should load
fast, work on a phone, and be indexable.

**Layout, top to bottom:**

1. **Planet strip** (§3.5): five tiles, each with its baseline label.
2. **Map:** an equirectangular canvas (the Pollution Lab pattern) over the 72×36 field with
   modes:
   - Temperature
   - **Anomaly** (default)
   - Rarity
   - *(Intro)* vs 1961–1990
   - *(Intro)* Forecast anomaly, +1…+14 d slider

   Site-network dots sit on top. Hover gives value / normal / ΔT / percentile. Clicking a
   scorecard row pulses its place.
3. **Scorecard grid** (§3.4): five cards with a land/ocean toggle and region filter (free
   account), and an "Open in EarthView 3D" link (`earth.html?panel=temperature-lab`).
4. **Your place:** the location from `ppx_user_location` / `user-location-changed` (never a
   second store).
   - Today vs normal, using the grid cell's 1991–2020 normal so it matches the map.
   - A 7-day outlook vs normal from `projectDays` leads 0–7.
   - The **30-day calendar** (Intro, §8).
5. **Methods & honesty:**
   - definitions (§3);
   - the R7 asymmetry line;
   - what is model and what is observation;
   - fallback disclosure;
   - attributions;
   - a link to this plan's numbers.

**Wiring:**

- Nav: `earth-orbit` → *Earth systems* in `js/nav.js`. This spends the **last** Earth & Orbit
  slot (9 → 10 links; the cap is 10 — D6).
- Catalog entry in `js/simulations-catalog.js`.
- Regenerate the hub with `scripts/build-section-pages.mjs` (never hand-edit
  `earth-orbit.html`).
- New `thermometer` glyph in `js/glyphs.js`, gated by `node tests/glyphs.mjs`.
- Head copied from a sibling page with the import map **above** every modulepreload
  (`node tests/importmap-order.mjs`).
- `node scripts/lint-nav.mjs` must pass.

---

## 6. The EarthView modal panel

**Semantics (D7).**

- The lab panel is a **non-blocking modal panel**:
  - large;
  - focus moves into it on open;
  - Esc and ✕ close it;
  - draggable with `raiseOnGrab` like its neighbours;
  - **no scrim**.
- A scrim would hide the globe at the exact moment a scorecard row flies the camera to the
  place it names.
- The **upsell teasers** inside it are true modals: `gate-modal.js` dims the sim, which is its
  documented contract.

**Entry points:**

1. A **"🌡 Temperature Lab ›"** row at the top of the layer panel's Weather section, next to
   `lyr-weather`.
2. A **"Temps"** button in `#mobile-toolbar`. That makes six visible items while
   `ev-verdict-solo` hides Location, which fits at ≥ 46 px each on a 360 px screen.
3. A one-line "vs normal" chip in the verdict card body that opens the panel.
   - It sits in the re-rendered body, never in the stable header (§4.4).
   - It is additive: the card stays the location owner.
4. The deep link `earth.html?panel=temperature-lab`.

**Behaviour:**

- **First open** does `await import('./js/temperature-lab-panel.js')`. EarthView is 16 k lines
  and the lab must cost nothing until asked for (the corridor-tab rule).
- **On open:**
  - switch `lyr-weather` to **Anomaly** mode (a mode of the existing layer, not a new layer);
  - record the prior layer state and **restore it exactly on close** (the hero
    `_parkNearEarth` lesson).
- **Scorecard rows** call the existing `flyToLatLon` hook that Storm Watch cards use, and
  pulse a marker at the site.
- **Anomaly layer:**
  - per frame, compute the 2592-cell anomaly against `hourlyNormal(cell, doy, solarHour)` for
    the **scrubbed** frame from `WeatherHistory`, so it works across the bar's whole −7 d…+14 d
    range;
  - write a 72×36 texture, bilinear in the shader, coloured by `temp-anomaly-ramp.js`;
  - the legend paints the same bytes.
- **Scrub mismatch.** Cards are "now" (the snapshot). When the bar is scrubbed away from now,
  the panel says "Cards: <frame time> · Globe: <scrub time>". (Intro: cards follow the scrub
  within the forecast grid's range.)

**Invariants:**

- The panel's home clears `--ev-timebar-h`. If it mounts on `<body>` it uses
  `--ev-timebar-bottom` and the `body #…` specificity lift, per §4.6.
- Mobile bottom-sheet rules are injected by the module (the storm-watch pattern).
- The id is added to the minimise-restore and draggable lists.
- It does **not** resurrect `#hud` / `#loc-panel` alongside the verdict card.
- Gates: `tests/earth-time-controls-position.spec.js` (add the panel to its neighbour list)
  and a new `tests/earth-temperature-lab.spec.js`, which checks:
  - lazy import;
  - layer restore;
  - fly-to;
  - mobile sheet;
  - gate suppressed under `?preview=1`.

---

## 7. Access — Free vs Intro, and the upsell teasers

### 7.1 The ladder (D1)

| Capability | Anonymous | Free account | **Intro** ($9.99, `basic`, `tierLevel ≥ 2`) |
|---|---|---|---|
| Planet strip, anomaly + temperature map (now), EarthView panel | ✓ | ✓ | ✓ |
| Scorecards | top 3 each | top 10 + land/ocean/region filters | top 25 + **record watch** (`beyondRecord`) |
| Your place: today vs normal | ✓ (unsaved) | ✓ saved | ✓ every saved place |
| Outlook vs normal | 3 days | 7 days | 7 days + **30-day calendar** |
| Map time travel | — | last 7 days | last 30 days + **forecast anomaly +1…+14 d** |
| **Heat-wave / cold-wave watch** (≥ 3 consecutive forecast days beyond p90 Tmax / p10 Tmin, ETCCDI-style) | — | — | ✓ |
| **Baseline lens** 1961–1990 ("how far from the old normal") | — | — | ✓ |
| **Cities heat-stress board** (318 cities: heat index, wet-bulb, wind chill, anomaly) | — | top 5 | ✓ |
| Anomaly alerts for your places (a lab watch: "my place enters `much-above`") | — | — | ✓ |

This is "Intro-only analysis and prediction on a free lab", as asked:

- Everything that **observes** the present is free.
- Everything that **predicts** or **analyses** at depth is Intro.

### 7.2 Gate variants (new `GATE_VARIANTS` entries — data, not code)

| Key | Type | Fires when | Headline (draft) |
|---|---|---|---|
| `temp-lab-scorecards` | free | anonymous clicks "Show all 10" or a filter | "See the full top ten." |
| `temp-lab-outlook-30day` | paid · `basic` | clicks the blurred 30-day calendar or its tab | "You've got the week. Want the month?" (the AurOracle line, reused on purpose) |
| `temp-lab-forecast-map` | paid · `basic` | drags the map slider past now | "See where it turns unusual next week." |
| `temp-lab-heatwave` | paid · `basic` | opens the heat/cold-wave watch | "Know before the heat wave sets in." |
| `temp-lab-baseline` | paid · `basic` | taps the 1961–1990 chip | "How far has your normal moved?" |

### 7.3 Teaser rules

- **Fire on reach, never on load.** The `HOME_GATING_PLAN.md` rule.
- **Locked items are visible.** They show a 🔒 chip and blurred content, with the AurOracle
  `au-locked` pattern renamed `tl-locked`.
- **At most one paid gate is auto-shown per session.** After that, the 🔒 chips still open it
  on click.
- **Exits:** quiet exit (✕ / Esc / backdrop / "Already have an account?") is the component's
  own contract.
- **Preview frames:** gates are suppressed under `html[data-preview]`.
- **Naming (D11):**
  - The plan id is `basic` and is load-bearing.
  - The marketing word is inconsistent today: AurOracle says "intro access", while
    `gate-modal.js` and `pricing.html` say "Basic".
  - Pick one before shipping copy.

### 7.4 Enforcement (D8)

Gating is **client-side**, like AurOracle:

- the gated data is public forecast and climatology;
- the snapshot already carries the top 25;
- the Intro routes are cached aggressively, so a bypass costs no upstream budget.

Server-side checks on `/api/temperature/outlook-grid` stay available if abuse appears. They
are deliberately not in v1.

### 7.5 Telemetry and experiment

- `telemetry.recordFeature('temp_lab', action, meta)` with the actions `open`, `card_expand`,
  `fly_to`, `mode`, `baseline`, `scrub` and `place`. The `feature` kind is already migrated;
  no new migration.
- Gate telemetry is automatic (`<variant>_gate`).
- After four weeks of baseline data, `experiments.assign('temp_lab_teaser')` can test
  anonymous top-3 vs top-5. Conclude it from the admin A/B panel.

---

## 8. The 30-day outlook — reuse, don't fork

**Yes, it exists.**

- `buildTempModel` (`js/home-conditions.js`) fetches Open-Meteo 16-day + `past_days=2`
  forecasts and a 3-year archive directly from the browser.
- It fits the anomaly persistence τ for the place.
- It emits 31 `projectDays` rows `{hiF, loF, meanF, source, tier, anomF, sigmaF, rho}` and a
  calendar.

The lab's Intro card calls the same function for the selected place. Three things make that
clean:

1. **One calendar renderer.** Extract `monthCalendarHtml` + `calendarCellTip` +
   `anomalyStyle` from `js/home-sky-console.js` into `js/temp-calendar-view.js`. The
   homepage gate `tests/home-temp-outlook.spec.js` must stay green through the extraction;
   that is the regression test.
2. **Two normals on one page must not contradict.** The calendar's anomaly is against a
   3-year ±7-day point normal. The map's is against 1991–2020 ERA5. The rules:
   - today's chip on the place card uses the **map's** normal;
   - the calendar keeps its own label ("vs the 2023–2025 normal", already in its tips).
   - Recommend that `TEMP_OUTLOOK_ENGINE_PLAN.md` Layer A's `temp_climatology` adopt the
     **R2 method** (N = 4 harmonic mean, N = 2 variance) through
     `js/temperature-normals.js`'s fit functions. When the engine lands, the place normal and
     the map normal then share a method, and the engine gets a measured smoothing choice for
     free (the ±7-day window it would otherwise inherit scored worse in §2 B).
3. **Units:** the rows are °F by legacy. The lab converts at the seam and stores nothing in
   °F.

**When the engine lands:**

- The calendar gains P10–P90 and per-lead skill, with no lab change; that is the seam's
  promise.
- The Intro forecast-anomaly map and the heat-wave watch get verified against
  `temperature_daily_cells` the same way (`js/forecast-verification.js` scoring shape).

---

## 9. Order of work — each phase ships on its own

| Phase | Scope | Exit gate |
|---|---|---|
| **0 (this doc)** | Spike + plan | §2 numbers reproducible (§13) |
| **0b — restore the primary grid source** *(blocks launch)* | **Step 1 shipped 2026-10-06 (honesty + diagnosis).** The premise above was wrong: the cron surfaced Open-Meteo's reason only when *every* attempt failed, and threw it away when MET Norway won, so no log line or heartbeat field held it. Now a fallback win (i) `console.warn`s every earlier attempt's reason, (ii) writes it to `pipeline_heartbeat` via `record_pipeline_failure` *before* `record_pipeline_success` (streak still ends at 0, so the watchdog email stays reserved for "nothing written"), and (iii) returns `degraded` + `attempt_failures`. `status.html` / `admin.html` score a fallback source amber ("degraded · fallback source") through `js/pipeline-registry.js` `isFallbackSource`, and `/api/weather/grid` serves the frame with `freshness:'stale'`. Rate limits that arrive as a 429 now short-circuit the same-IP gfs retry, like the 200 envelope always did. `OPEN_METEO_API_KEY` (optional) moves both Open-Meteo attempts to `customer-api` with `&apikey=`; the key is scrubbed from every reason. Gate: `node tests/weather-grid-pipeline.mjs` (fails on the pre-fix code). **Step 2:** after deploy, read `pipeline_heartbeat.last_failure_reason` for `weather_grid` (or one Vercel log line), which names the cause. **Step 3:** fix it — (a) set `OPEN_METEO_API_KEY` (D12), (b) re-pace chunks under the per-minute cap, or (c) a different primary | Step 1: done. Exit: 24 h of `open-meteo*` frames in `weather_grid_cache`; heartbeat amber on fallback |
| **1 — normals** | `scripts/build-temperature-normals.py`, the assets + `SOURCES.md`, `js/temperature-normals.js`, `tests/temperature-normals.mjs` | Python↔JS fixture to 1e-3 K; harness (R1) re-run on the built asset; quantile curves within 0.3 K of the windowed empirical quantiles (to be measured) |
| **1b — representativeness** | Offset against Open-Meteo ERA5 points (§4.2 step 3) | Residual live-minus-normal mean over the first 30 days of `temperature_daily_cells` reported per region |
| **2 — live aggregate** | Migration (3 tables, `compute_temperature_lab`, the 13:30 rollup), `js/geo-regions.js` move (+ `api/weather/extremes.js` imports it), `/api/temperature/snapshot`, registry entry, CLAUDE.md §4.2 note | `node tests/geo-regions.mjs tests/temperature-lab-model.mjs`; route self-reports `freshness`; `node tests/pipeline-registry.mjs` |
| **3 — site network** | Census in the build script, `js/temperature-sites.js`, the cron, `vercel.json` | `node tests/temperature-sites.mjs`; cron writes; stale path tested |
| **4 — page** | `temperature-lab.html` (anonymous + free ladder), nav/catalog/hub/glyph | `tests/temperature-lab-smoke.spec.js` (routes mocked, ladder classes asserted), `lint-nav`, `site-sections`, `glyphs`, `importmap-order` |
| **5 — EarthView** | Lazy modal panel + anomaly mode + entry points + mobile | `tests/earth-temperature-lab.spec.js`, `tests/earth-time-controls-position.spec.js`, `tests/verdict-card-smoke.spec.js` |
| **6 — Intro** | `temp-calendar-view.js` extraction, 30-day card, outlook-grid cron + route, heat/cold-wave watch, 1961–1990 asset + lens, cities board, gate variants, telemetry | `tests/home-temp-outlook.spec.js` still green; gate variants smoke; Open-Meteo budget re-measured after 0b |
| **7 — verification + follow-ons** | Score the forecast-anomaly map and the heat-wave watch against `temperature_daily_cells` (skill printed on the page once ≥ 30 issues are scored, "accruing" before); monthly harness vs C3S; Storm Watch baseline per D10 | Ledger populated; skill numbers are measured, never claimed |

---

## 10. Tests and gates (new + existing, by phase)

**Node:**

- `tests/temperature-normals.mjs`: decode, the fixture cross-check, the harness constants,
  DOY wrap at Dec 31 / leap day.
- `tests/temperature-lab-model.mjs`:
  - the rarity ranking orders a high-latitude ΔT of 9 K below a tropical ΔT of 4 K when the
    latter is rarer (R5 as a test);
  - separation;
  - nulls stay null;
  - **never sources a value from a clamped texture path**;
  - planet-strip area weights sum to 1;
  - the fallback-disclosure flag.
- `tests/geo-regions.mjs`: the moved table is byte-identical in behaviour to the old
  `api/weather/extremes.js` labels.
- `tests/temperature-sites.mjs` and `tests/temperature-snapshot-route.mjs`: the pure half of
  the route, with stale/expired paths.
- Existing: `tests/pipeline-registry.mjs`, `tests/glyphs.mjs`, `tests/site-sections.mjs`,
  `tests/simulations-catalog.mjs`, `tests/importmap-order.mjs`, `scripts/lint-nav.mjs`.

**Browser:**

- `tests/temperature-lab-smoke.spec.js`:
  - mocked snapshot, sites and outlook-grid routes;
  - anonymous / free / Intro ladder via the auth stub;
  - gate fires on reach and not on load;
  - suppressed under preview.
- `tests/earth-temperature-lab.spec.js`.
- Existing: `tests/earth-time-controls-position.spec.js`, `tests/verdict-card-smoke.spec.js`,
  `tests/home-temp-outlook.spec.js`, `tests/nav-responsive.spec.js` (the Earth & Orbit menu
  now at its 10-link cap).

---

## 11. What this plan deliberately does NOT do

- **No new global data fetch.** The live field is the existing grid. Its fix (0b) helps
  EarthView too.
- **No "records" or "hottest on Earth" claims** (R10).
  - An **observed-stations lens** would be the honest way to make station claims: METAR /
    SYNOP daily max/min at a few thousand stations.
  - It is a separate feed with its own freshness contract, scoped later and not here.
- **No second 3D globe.** The page is 2D; 3D is EarthView.
- **No new forecast engine.** The 30-day projection is `temp-outlook.js` and its engine plan.
  The Intro forecast map is NWP daily output relaxed toward the normal past day 8 (the
  pressure-outlook lesson: a raw frame past ~day 8 loses to climatology), and it says so.
- **No server-side tier enforcement in v1** (D8).
- **No change to the `basic` plan id** (HOME_GATING_PLAN D1).

---

## 12. Decisions for the author

| # | Decision | Recommended default | What changes if you pick otherwise |
|---|---|---|---|
| D1 | The access ladder (§7.1): what anonymous sees | Map + strip + top 3 free to anonymous; full live lab free with an account; prediction/analysis Intro | Account-wall the whole lab → loses the anonymous top of funnel; open everything → the Intro set must be re-picked |
| D2 | Default baseline | 1991–2020 (WMO), 1961–1990 as Intro lens | Defaulting to 1961–1990 makes every map ~+0.5 K warmer (R8) and is non-standard for a "vs normal" product |
| D3 | Rank "unusual" by rarity | Rarity (R5); raw ΔT as a toggle | Raw-ΔT default turns the card into "Siberia and Antarctica" most days (66–75 %) |
| D4 | Scorecards land-only by default | Land default, ocean toggle | Ocean-inclusive surfaces marine heatwaves (real) but reads oddly as "where" |
| D5 | Page is 2D; 3D lives in EarthView | 2D | A second globe duplicates EarthView's renderer and the phone budget |
| D6 | Nav slot | Spend the last Earth & Orbit slot (→ 10/10) | Hub + catalog only, no menu entry |
| D7 | EarthView "modal" = non-blocking panel; gates are true modals | As stated | A scrimmed modal hides the globe the fly-to targets |
| D8 | Gating enforcement | Client-side (AurOracle precedent) | Server checks: JWT on the Intro routes, per-request auth lookups |
| D9 | Units | Locale default (US → °F, matches the homepage), toggle, SI in every payload | — |
| D10 | Storm Watch's 30-day "Global extremes" | Re-label it now ("vs the last 30 days"); move it onto the normal in Phase 7 (§2 F: 33 % / 21 % precision) | Leave as is — it will disagree with the lab on screen at the same time |
| D11 | The word for the $9.99 plan | Pick one of "Intro" / "Basic" across gate copy, AurOracle, pricing | — |
| D12 | Open-Meteo key (0b + Intro load) | Decide after the heartbeat's `last_failure_reason` (written since 0b step 1) says why the grid falls back; the cron already reads `OPEN_METEO_API_KEY` | Staying keyless may cap the Intro forecast grid and cities board (§4.4 table) |

---

## 13. Reproducing Phase 0

The scripts are offline and not deployed. WB2 serves over plain HTTPS without credentials.

```bash
cd scripts/temperature_lab_spike
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python fetch.py data      # ~5 min, ~30 GB streamed, ~1.9 GB kept (resumable)
.venv/bin/python spike.py data results.json   # ~6 min, ~8 GB RAM peak
```

- `results-2026-10-05.json` is the run this document quotes.
- Every table in §2 is a key in it: `A`–`I`, `_meta`.
- The production-state facts in §0 / §9 (100 % `met-norway:72x36` frames, heartbeat green)
  came from read-only queries against `weather_grid_cache` and `pipeline_heartbeat` on
  2026-10-05.
