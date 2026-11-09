# GLACIER_WATCH_PLAN.md — Glacier Watch: glacier motion + snowpack, observed and simulated

*Status (2026-11-08): P0 + P1 + P2 (EarthView layer) + the WEEKLY REFRESH + WGMS through 2025 + 48 GLACIERS + the GLOBAL CATALOGUE (RGI 7.0) + ITS_LIVE SPEED FOR EVERY GLACIER BUILT. §0 is the build log;
§2 holds numbers MEASURED in the planning session; "to verify" items are unchecked.*

## 0. Built (2026-11-08)

**Speed for every glacier (2026-11-08).** ITS_LIVE annual-composite v0 (2014–2024 mean) summarised
inside every RGI outline (median / p90 / p98, trend, coverage) by `scripts/build-glacier-catalog-speed.py`
(1 354 tiles). Verdict = the tracked tier's own rule (resolved above 2 × the measured pair error of the
region's tracked glaciers), agreeing with the tracked tier on 38 of 41 linked glaciers; the ice-free-ground
floor and p90 were each measured and rejected (header of the baker). 4 434 glaciers resolved — 44 % of the
ice area — and ~268 000 honestly below what a 120 m composite resolves. Map colour mode "Surface speed",
a speed row on every record card, a speed line in EarthView's tooltip.

**A speed history for the glacier you click (2026-11-08).** Every RESOLVED glacier's card draws its speed
year by year — each calendar year of the same ITS_LIVE annual composites (`v` per year, seasonal cycle
fitted out; 1982–2025 where Landsat 4/5 reach, ~2013/2015→2025 elsewhere) over the same outline pixels
as the speed table: fastest ice (p98) always, the typical (median) ± ITS_LIVE's own error only when the
median is itself resolved. A year is a GAP when < 50 % of the glacier was imaged OR its speed is not above twice that
year's own ITS_LIVE error (where a tile's record thins out the error jumps 15–25× and the p98 of noise read as a
speed-up: NE Greenland 2023, 86 → 210 m/yr); the part-year 2025 is WITHHELD, as the tracked tier's `annualAt` does.
DECISION: a BAKE, not a server route and not Supabase — the composites are republished about once a year,
a live route would have to blosc-decode ~2.2 MB per year (~90 MB for a 42-year tile) per click and hold
the outlines the site does not ship, and Postgres is the wrong home for static bulk data
(`SUPABASE_OFFLOAD_PLAN.md`). `scripts/build-glacier-catalog-annual.py` (525 tiles, 8.5 min) writes one
small file per RGI region (692 KB in all), fetched when a card opens. Below-detection glaciers get NO
series on purpose. Measured (gated in `tests/glacier-catalog.mjs` §10): a series for exactly the 4 434 resolved glaciers; the
2014–2024 years average back to ITS_LIVE's own decade mean (median ratio 1.015 typical / 1.019 fastest); the
year-to-year CHANGE matches the tracked flowlines at r = 0.40 over 428 glacier-years and falls to ≈ 0 shifted
±1 year (the negative control — correlating LEVELS did not discriminate: a trend survives a shift); trend
direction agrees with ITS_LIVE's dv/dt on 126 of 148 clear-trend glaciers; the part-year reads high across
the catalogue (2025/2024 median ×1.07, one in ten ×1.73, vs 2024/2023 ×0.99 / ×1.18) — why it is withheld.
113 957 of 143 495 glacier-years are drawn (26 267 coverage gaps, 3 271 noise gaps); 141 glaciers have no
drawable year and the card says so.
Next: geodetic mass change (Hugonnet et al. 2021) if a mirror is reachable.

**The global catalogue — every glacier on Earth (2026-11-08).** RGI 7.0 (274 531 glaciers, 706 744 km²)
from an unofficial GeoParquet mirror reachable on public S3, accepted only because it reproduces the RGI
Consortium's own region tables exactly (19 + 90 regions, zero mismatches). `data/glaciers/catalog/` (9.1 MB:
a 1.7 MB points file for all glaciers + per-region detail shards + names + meta), the PURE kernel
`js/glacier-catalog.js`, a searchable world map + record card + size story + region table on
glacier-watch.html (lazy), and EarthView's "All glaciers (RGI 7.0)" layer. 41 of the 48 tracked glaciers
are joined to their RGI outline by point-in-polygon; the 7 ice-sheet outlets have none (RGI excludes the
ice sheets). Findings printed on the page: 84 % of glaciers are under 1 km², the 994 over 100 km² hold
55 % of the ice. Next: per-glacier context for untracked glaciers on demand (ITS_LIVE composite speed at a
clicked centroid via a small route; geodetic mass change from Hugonnet et al. 2021 if a mirror is
reachable) — never an invented series.

**Batch 3 — 48 glaciers (2026-11-08).** +17 WGMS field-programme glaciers (Claridenfirn 1915→, Silvretta
1919→, Gries, Taku, Storbreen, Engabreen, Midtre Lovénbreen, Kongsvegen, White, Urumqi No. 1, Tuyuksu,
Abramov, Echaurren Norte, Djankuat, Yala, Bahía del Diablo, Athabasca — every series through 2025) and 6
great outlets (Petermann 81 km, Kangerlussuaq 64 km, Lambert 78 km on GROUNDED ice, Malaspina, Fedchenko's
middle trunk, Franz Josef). Allalin dropped (ITS_LIVE tile edge). States as of 2026-11-08: 11 faster,
3 slower, 4 usual, 28 below detection (the small field glaciers), 2 unknown. Picker gains a filter box.

**WGMS through 2025 (2026-11-08).** `massbalance.json` v2: annual balances from WGMS FoG 2026-02-10
(14 of 15 series now end 2025; Zongo is not in the copy and stays at 2018), split kept from the 2022
extract only where the annual is unchanged — the USGS benchmark glaciers were recalibrated (Gulkana 54,
Wolverine 55, South Cascade 62, Lemon Creek 68 revised years), Nigardsbreen 7, Pasterze 2, Storglaciären 1.
Fixed on the way: the cumulative balance summed straight across gaps; it now restarts after each one
(Aletsch −8.6 m w.e. since 2020, not a total that booked 2000–2019 as zero). Winter/summer for 2021–2025
need the full release (wgms.ch zip) — a networked CI step could add them.

**Weekly refresh (2026-11-08).** `.github/workflows/glacier-refresh.yml` re-bakes every glacier on
Wednesdays (GLO-30 tiles in the Actions cache), rebuilds elevation + summary, runs the gates and opens
or updates ONE PR on `data/glaciers-refresh`. The bake is incremental (a stored pair or remembered
rejection is reused only at an identical flowline — South Cascade's re-run fetched 0 MB, Columbia's
first incremental run 540 MB → only its rejected picks), fault tolerant (`--keep-going`, `--report`)
and refused when degraded (`scripts/check-glacier-refresh.mjs`). Each summary row carries its own
`as_of`; the EarthView pip discloses older entries. Needs the repo setting "Allow GitHub Actions to
create and approve pull requests" for the PR step.


- **25 glaciers** (the ten of §4 + Hintereisferner, Rhône, Mer de Glace, Nigardsbreen,
  Wolverine, Lemon Creek, Chhota Shigri, Brewster, Pasterze, Helheim, Thwaites, Pine Island,
  Hubbard, Baltoro, Breiðamerkurjökull). Decisions taken: daily tracking from MULTIPLE sources
  (owner, 2026-11-08); calving/ice-sheet glaciers are motion-only; hydrological years; the page
  lives on the Earth & Orbit HUB (the menu is at its 10-link cap) — a menu slot is still open.
- **Bakes** — `scripts/build-glacier-velocity.py` (ITS_LIVE: composites 1982/84/2013–2025,
  ≤ 240 short-baseline pairs over the last year, block-averaged field + GLO-30 terrain grid,
  hybrid velocity/topography flowline), `scripts/build-glacier-elevation.py` (GLO-30 profile),
  `scripts/build-glacier-massbalance.mjs` (15 WGMS series via OGGM's mirror, sha256-pinned).
- **Daily sources** — `/api/glaciers/velocity` (new ITS_LIVE pairs since the bake, jsfive in
  Node; measured locally: 35 new Columbia pairs, newest 2026-11-06), `/api/glaciers/stations`
  (USGS + SNOTEL, UNVERIFIED), Open-Meteo archive + forecast at gauge elevations (browser).
- **Engine** — `js/glacier-engine.js` (seasonal expectation, outliers, daily series,
  faster/slower/normal/below-detection, trends, advection, north, the SIA ice body);
  `js/glacier-pairs.js` (the shared pair rules); `js/glacier-weather.js` (degree-days, season rank).
- **Page** — `glacier-watch.html`: a resizable / full-screen 3D stage at the top (terrain,
  estimated bed, translucent ice body with margins, flowline thickness section, flowing parcels;
  layers speed / thickness / flux / driving stress; density readout of volume and mass), name-only
  selector with rich tooltips, then Right-now, 12-month, profile, decades, mass balance,
  weather and gauges panels.
- **Scars found while building** (each recorded where it lives): datacubes end May 2025; h5py's
  global lock froze threaded range reads; jsfive hides scalar-dataset attributes; small glaciers
  are below ITS_LIVE detection (v0 ~0.5 m/yr); composite year spans are tile-dependent; a comment
  once swallowed the seasonal amplitude/phase in the baker.
- **P2 EarthView layer (2026-11-08)** — `js/earth-glacier-layer.js`: a diamond per glacier
  coloured by the engine's mid-glacier state (from `data/glaciers/summary.json`, 20.7 KB,
  derived by `scripts/build-glacier-summary.mjs`, AS OF the archive date), the observed
  flowlines with log-compressed moving dots, pixel picking, hover + tap-pinned deep link.
  Off at boot, ~130 KB on first enable. Gates: node gate §8, `tests/earth-glacier-layer.spec.js` (4).
  At the archive date 9 of the 12 detectable mid-glacier gauges read "faster than usual":
  check that against the next bake before reading it as a signal — short-baseline autumn
  optical pairs may carry a seasonal bias the 2014–2024 sinusoid does not.
- **Next** — (WGMS 2021–2025: DONE 2026-11-08, annual only); verify the stations route in
  production; a weekly `glacier-refresh.yml` (trojans-refresh pattern) to fold the daily tail
  into the archive; geodetic mass change for the calving glaciers; then the planet (§8 P5).

Glacier Watch is a new Earth & Orbit simulation: ten glaciers to start, their
**motion** (surface velocity), their **mass balance** (are they gaining or losing
ice), and the **snowpack** that feeds them — observed first, then simulated by a
physics kernel that is scored against those observations. It ships as its own
page (`glacier-watch.html`) and as a **Glaciers** layer on EarthView, with the
same engine feeding both (the Volcanoes pattern: PURE engine → page + layer, the
layer computes nothing).

---

## 1. What "real-time" honestly means for a glacier

Three different clocks, and the page must never blur them (the Mars
"map is archival, view is live" rule, applied here):

| Quantity | Real cadence | Latency | What we may call it |
|---|---|---|---|
| **Snowpack** (SWE, snow depth, snow cover) | daily / hourly | hours–1 day | **live** |
| **Surface velocity** (glacier motion) | per satellite image pair (Landsat 8/9, Sentinel-1/2) | ~2–6 weeks (pair spans + processing) | **near-real-time**, always printed with the pair's dates |
| **Mass balance** | seasonal (winter/summer) field campaigns, annual totals | published ~3–9 months after the hydrological year ends | **annual**; the current year is a **model nowcast** until it resolves |

So "the most recent year of data" means: velocity pairs through the last few
weeks, the **2025 hydrological year** mass balance (Oct 2024–Sep 2025 in the
northern hemisphere, now published), and daily snowpack for the **2026 water
year** (from 1 Oct 2025). The 2026 glacier balance does not exist yet anywhere
— that is the gap the simulation fills, and the gap where its skill is scored
once WGMS publishes.

---

## 2. Measured ground truth (2026-11-08, this session)

- **Egress.** From the build sandbox NSIDC, WGMS, NRCS (SNOTEL), Open-Meteo,
  GLIMS, Zenodo, NOAA mapservices and its-live.jpl.nasa.gov are all
  **blocked**. **Reachable:** `its-live-data.s3.amazonaws.com` (NASA ITS_LIVE),
  `copernicus-dem-30m.s3.amazonaws.com` (Copernicus GLO-30 DEM), GitHub, PyPI.
  Same constraint the Volcanoes baker hit; same answer: bake in CI (GitHub
  Actions has open egress) or bake here from the two AWS buckets, and let
  Vercel routes reach the rest at runtime.
- **ITS_LIVE datacubes:** `datacubes/catalog_v02.json` lists **3,160** Zarr
  cubes (120 m grid). The Columbia Glacier cube
  (`v2-updated-october2024/N60W140/ITS_LIVE_vel_EPSG3413_G0120_X-3150000_Y650000.zarr`)
  has **70,070** image pairs, `date_updated` 26 Jun 2025, newest `mid_date`
  **2025-05-25** — the cubes are the HISTORY, not the last year.
  `v` is chunked **[20000, 10, 10]** (time-major), Blosc-compressed, so one
  pixel's full 1986–2025 series is ~4 chunk reads. Annual composites exist
  (`composites/annual/v2-updated-september2025/`).
- **ITS_LIVE near-real-time pairs** are flowing: on the Columbia tiles
  (Landsat WRS-2 067/068-017) there are pairs whose second image is
  **2026-10-21 / 2026-10-22** — 17 days before this check. Layout:
  `velocity_image_pair/{landsatOLI,sentinel1,sentinel2}/v02/<10°tile>/<pair>.nc`
  (+ `.png` quicklook, `.premet`, `.spatial`). The last-year velocity has to
  come from these granules.
- **Velocity coverage per candidate** (pairs in the covering cube):
  Columbia 70,070 · Jakobshavn 80,568 · Aletsch 87,053 · Khumbu 88,841 ·
  Perito Moreno 76,822 · Gulkana 72,926 · South Cascade 75,092 ·
  Storglaciären 69,891 · Peyto 87,982 · Zongo 52,858 · Hintereisferner
  119,008 · Brewster 71,408 · Chhota Shigri 97,290 · Thwaites 17,154 ·
  **Lewis (Kenya) 111 — too few; excluded.**

---

## 3. Datasets

Ranked by role. "Sandbox" = reachable from the build sandbox today.

### 3.1 Glacier motion (the "movement" in the brief)

| Dataset | Gives | Cadence / span | Access | License | Sandbox |
|---|---|---|---|---|---|
| **NASA ITS_LIVE v2** image-pair velocities (Gardner et al.; *The Cryosphere* 19, 3517, 2025; DOI 10.5067/JQ6337239C96) | vx, vy, v + per-pair error, 120 m, Landsat 4–9 + Sentinel-1/2 | per pair, 1982 → ~3 weeks ago (measured) | public S3, no login | NASA open | ✅ |
| ITS_LIVE Zarr datacubes | same, stacked per 100 km tile | 1982 → May 2025 (measured) | public S3 | NASA open | ✅ |
| ITS_LIVE annual composites / mosaics | one velocity field per year (+ amplitude of the seasonal cycle) | annual, to 2024–25 | public S3 | NASA open | ✅ |
| Millan et al. 2022 (*Nat. Geosci.*) velocity + thickness | global 50 m velocity mosaic 2017–18 + ice thickness | static | Sedoo/Zenodo | CC-BY | ❌ (CI) |

ITS_LIVE is the backbone. It is the only global, open, near-real-time glacier
velocity product, it is reachable from here, and its per-pair error lets the
page draw honest uncertainty bands.

### 3.2 Mass balance (gaining or losing ice)

| Dataset | Gives | Span | Role here |
|---|---|---|---|
| **WGMS Fluctuations of Glaciers (FoG)** + the 2025 bulletin (408 ± 132 Gt lost in hydrological year 2025) | glaciological annual + seasonal balance per glacier, ~160 reporting glaciers | 1946 → 2025 | the OBSERVED truth for the top 10; seasonal balances score the snow model |
| **Dussaillant et al. 2025** (*ESSD* 17, 1977; DOI 10.5904/wgms-amce-2025-02, *to verify which DOI resolves*) | ANNUAL mass change for every glacier (~207 000) + 0.5° grid + regional | 1976 → 2024 | the bridge to global; the 0.5° grid is a natural EarthView raster |
| **Hugonnet et al. 2021** (*Nature*) | per-glacier geodetic elevation/mass change | 2000–2019 (5- and 20-yr windows) | per-glacier CALIBRATION target for the melt model (the OGGM standard) |
| **GlaMBIE 2025** (*Nature* 639, 382; 273 ± 16 Gt/yr 2000–2023) | community regional estimates | 2000 → 2023 | regional cross-check / headline context |
| National programmes: GLAMOS (CH, −1.6 m w.e. in 2024/25), NVE (NO), USGS Benchmark Glaciers (Gulkana, Wolverine, Lemon Creek, South Cascade, Sperry) | the same glaciological series, often earlier and with point stakes | to 2025 | freshest numbers for specific glaciers; USGS releases are public domain |
| GRACE/GRACE-FO mascons (CSR RL06.3 to Jan 2026, JPL to Nov 2025 — from catalogue listings, *to verify*) | monthly regional mass anomaly (~300 km) | 2002 → ~2 months ago | regional sanity check (Gulf of Alaska, Patagonia, HMA) — NEVER drawn per glacier |

### 3.3 Glacier geometry (what the model runs on)

| Dataset | Gives | Access | License |
|---|---|---|---|
| **RGI 7.0** (NSIDC-0770, DOI 10.5067/F6JMOVY5NAVZ) | outlines + attributes for ~274 000 glaciers; the shared ID every other product keys on | NSIDC (Earthdata login) | CC-BY 4.0 |
| **OGGM preprocessed glacier directories** (v1.6, RGI6 and RGI7) | per-glacier flowlines, hypsometry, bed from consensus thickness, calibrated melt parameters, W5E5 climate | Bremen cluster (open HTTP) | BSD / data CC-BY |
| Farinotti et al. 2019 consensus thickness · Millan 2022 thickness | bed topography → ice volume and the flowline's bed | ETH / Sedoo | CC-BY |
| **Copernicus GLO-30 DEM** | 30 m surface for the 3D view and the elevation bands | public S3 | Copernicus licence (attribution) | ✅ sandbox |

OGGM's directories are the biggest shortcut: they already contain the flowline,
bed, hypsometry and a calibration consistent with Hugonnet for every glacier.
We would port the PHYSICS (a few hundred lines), not run Python in production.

### 3.4 Snowpack

| Dataset | Gives | Cadence | Coverage | Access |
|---|---|---|---|---|
| **NRCS SNOTEL** (AWDB REST, element `WTEQ`, stations like `713:CO:SNTL`; daily value is the midnight PST reading) | point SWE, snow depth, precip, temperature | daily/hourly, ~hours latency | ~900 stations, western US + Alaska | runtime route (no key) |
| CDEC (California) snow sensors | point SWE | daily | Sierra Nevada | runtime route |
| **NOAA IMS** 1 km / 4 km (NSIDC G02156; NOAA ImageServer `usnic_ims_snow_ice_1km`, 3 = ice, 4 = snow) | binary snow / ice cover, NH | daily | Northern Hemisphere | runtime ImageServer export |
| **MODIS NDSI snow cover via GIBS** | fractional snow cover | daily | global | **already in EarthView** (`js/earth-obs-feed.js`, `MODIS_Terra_NDSI_Snow_Cover`) — reuse it |
| SNODAS (NOAA NOHRSC) | modelled 1 km SWE | daily | CONUS | CI baker (tarballs) |
| **ERA5-Land via Open-Meteo** archive | snow depth (ERA5-Land 0.1°), snowfall (ERA5), T and precip | hourly, ~5-day lag | global | runtime; Open-Meteo is already the app's weather source |

Point snow observations outside the US are fragmented (SLF in Switzerland,
national services elsewhere). Phase 1 treats them as later additions. The
global snowpack picture is IMS + MODIS cover plus ERA5-Land depth.

### 3.5 Forcing for the simulation

Hourly 2 m temperature and precipitation from the **Open-Meteo archive
(ERA5 / ERA5-Land)** at each glacier, plus Open-Meteo's forecast models for the
next ~16 days. Both are lapsed to elevation bands. W5E5 is what OGGM calibrated
on, so the bias between the two forcings is measured once per glacier and
stored. That calibration constant is disclosed, never hidden in the melt
factor.

---

## 4. The top 10 (proposal — needs your call, §9.1)

Criterion proposed: **the best-observed glaciers that together span the
climate and dynamics range**. Each must have an annual mass-balance record
through 2025 or a geodetic record, plus dense ITS_LIVE coverage. Fame counts
as a tiebreaker. Four are calving or ice-sheet glaciers chosen for MOTION; the
rest are land-terminating glaciers chosen for the full model chain.

| # | Glacier | Region | Why | Model chain? |
|---|---|---|---|---|
| 1 | **Sermeq Kujalleq (Jakobshavn Isbræ)** | Greenland | fastest glacier on Earth; seasonal speed-up; the velocity flagship | motion only — an ice-sheet outlet (outside RGI's glacier regions) and calving |
| 2 | **Columbia Glacier** | Alaska | textbook tidewater retreat; NRT pairs to 2026-10-22 measured | motion + geodetic MB; calving ⇒ no flowline sim |
| 3 | **Gulkana Glacier** | Alaska | USGS benchmark since 1966; WGMS reference | full chain |
| 4 | **South Cascade Glacier** | Washington | USGS benchmark since 1959; SNOTEL nearby ⇒ the snowpack→glacier link | full chain |
| 5 | **Peyto Glacier** | Canadian Rockies | WGMS reference; meltwater for the Bow/Saskatchewan | full chain |
| 6 | **Great Aletsch Glacier** | Swiss Alps | largest Alpine glacier; GLAMOS | full chain |
| 7 | **Storglaciären** | Sweden | longest continuous mass-balance record (since 1946) | full chain |
| 8 | **Khumbu Glacier** | Nepal (Everest) | High Mountain Asia; debris-covered (a real physics caveat) | geodetic MB; debris flagged in the melt model |
| 9 | **Perito Moreno** | Patagonia | one of the few near-stable calving glaciers; famous ice-dam ruptures | motion + geodetic MB |
| 10 | **Zongo Glacier** | Bolivia | tropical, WGMS reference (*verify*); water supply for La Paz | full chain |

Measured alternates: Hintereisferner (AT, record since 1953, 119k pairs),
Brewster (NZ, adds Oceania, 71k), Chhota Shigri (India, WGMS, 97k),
Thwaites (Antarctica, motion only, 17k).

---

## 5. The simulation layer (physics-first, scored)

One PURE JS kernel family, node-gated, with a Rust/WASM port only once the
global scale needs it (the ring-current pattern: JS stays the oracle).

1. **Snow module** — a temperature-index snowpack (SNOW-17 family: rain/snow
   partition by temperature, degree-day melt with a seasonal melt-factor
   cycle, liquid retention, refreeze) per elevation band. It is **scored
   against SNOTEL SWE** (NSE, peak-SWE error, melt-out date error) before
   anything is built on it.
2. **Surface mass balance** — the SAME snow module over the glacier
   hypsometry, plus ice melt with its own factor once snow is gone (Hock-style
   separate snow/ice factors). Calibrated per glacier to the geodetic mean
   (Hugonnet 2000–2019), then **validated out of sample** against the WGMS
   seasonal balances it was never fitted to. Debris cover (Khumbu) gets a
   disclosed melt reduction, not a silent tweak.
3. **Ice flow** — a 1-D flowline shallow-ice approximation with a sliding term
   on the OGGM/consensus bed. It produces a MODELLED velocity profile, so
   motion becomes both observed (ITS_LIVE) and simulated, and the residual is
   the skill. Calving glaciers (#1, #2, #9) are **observation-only** and say
   so. An SIA cannot represent calving, and pretending otherwise would be the
   first lie on the page.
4. **The nowcast + ledger** — run the chain through the current hydrological
   year on ERA5 + forecast forcing: the 2026 balance "so far" and a projected
   end-of-season band. Each year's projection is **locked** on 1 Sep and scored
   when WGMS/GLAMOS/USGS publish, the CME-ledger pattern. That is the
   physics-first differentiator: a published, verifiable glacier forecast.

Analytic gates for the kernel: degree-day melt closed forms; snow mass
conservation (P = ΔSWE + melt + sublimation, to round-off); the SIA Vialov /
Bueler steady-state profile; and flux conservation along the flowline.

---

## 6. Architecture (proposed files)

```
scripts/build-glacier-catalog.mjs      → data/glaciers/glaciers.json     (outlines simplified, flowlines,
                                                                           hypsometry, MB series, DEM tile refs)
scripts/build-glacier-velocity.py      → data/glaciers/velocity.json     (cube history at flowline points +
                                                                           last-year NRT pairs; numcodecs/netCDF)
.github/workflows/glacier-refresh.yml    weekly CI bake → ONE PR on data/glaciers-refresh (trojans-refresh pattern;
                                         never pushes to main). Needs an Earthdata login secret for NSIDC (RGI, IMS).
api/snow/snotel.js                       SNOTEL relay: candidate field lists, never 5xx, freshness:'stale'
api/snow/ims.js                          IMS ImageServer export relay (snow/ice cover tile for a bbox)
js/glacier-engine.js        (PURE)       decode, status ("thinning/advancing/retreating"), stats, ledger scoring
js/glacier-snow-model.js    (PURE)       snow module (§5.1)
js/glacier-smb-model.js     (PURE)       mass balance (§5.2)
js/glacier-flowline.js      (PURE)       SIA flowline (§5.3)
js/earth-glacier-layer.js                EarthView layer: glyphs, velocity ribbons on the flowline, hover/pin tip
glacier-watch.html + js/glacier-watch-page.js   the page
data/glaciers/SOURCES.md                 provenance, citations, observed/modelled split
```

- **Velocity in v1 is baked weekly, not read per request.** Granules are
  NetCDF/HDF5 (painful in a Vercel function) and the source latency is weeks,
  so a weekly bake loses nothing. The page prints the newest pair's dates.
- **Register every new route in `js/pipeline-registry.js`.** A new `cryosphere`
  category needs adding to `CATEGORIES`, or the status page renders nothing
  for it.
- **EarthView:** Layers → Glaciers, OFF at boot, data loaded on first enable
  (the Volcanoes rule: no cost to every visitor). It reuses the existing MODIS
  snow-cover layer and adds IMS cover and SNOTEL dots. Picking goes through
  `globeHits()` (CLAUDE.md: mesh UVs name the antipode).
- **The page:** glacier picker → per-glacier 3D terrain (GLO-30 + outline),
  velocity field and flowline particles, a hydrological-year scrubber (snowline
  rising, cumulative balance vs past years), velocity seasonal-cycle chart, and
  snowpack vs normal. Charts follow the `dataviz` rules and small multiples.

---

## 7. Testing, screenshots, performance, usability

- **Node gates** for every PURE module (closed forms from §5, real-data
  fixtures baked from SNOTEL + ITS_LIVE + WGMS, never hand-edited), in a
  `glacier-kernels.yml` CI job.
- **Playwright** with mocked feeds: page smoke, an EarthView layer spec, and a
  feeds-all-down negative control (feeds down must LOOK down).
- **Screenshot evidence per feature:** frames + measured numbers written to
  `validation-output/glacier-watch/` (the EarthView validation-harness
  pattern), each claim paired with a negative control that must fail.
  Screenshots are shared as each feature lands.
- **Performance budget**, measured on SwiftShader and quoted as numbers: page
  boot to first interactive, frame time at the default view, payload sizes
  (catalogue gzip, velocity JSON), and EarthView boot cost with the layer OFF
  (must be ~0).
- **Usability:** scripted tasks ("Is Columbia Glacier speeding up this year?",
  "How does this winter's snowpack compare to normal near South Cascade?",
  "Scrub to last August"). Plus 390 px phone width, touch targets ≥ 44 px,
  keyboard reachability, and the consent banner not hiding controls.

---

## 8. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 — data** | verify each source's schema in CI/production; bake the top 10 (geometry, MB to 2025, velocity history + last year); `SOURCES.md` | baker `--check`, fixtures |
| **P1 — observed page** | `glacier-watch.html` v0: picker, velocity history + last-year pairs, MB record, live SNOTEL/IMS snowpack | page smoke + screenshots |
| **P2 — EarthView layer** | Glaciers layer + SNOTEL dots + IMS cover | layer spec, boot-cost measurement |
| **P3 — snow model** | snow module scored against SNOTEL | skill numbers printed on the page |
| **P4 — glacier model** | SMB + flowline for the full-chain glaciers, 2026 nowcast, locked ledger | analytic gates + out-of-sample WGMS |
| **P5 — the planet** | RGI 7 global markers, Dussaillant 0.5° grid as an EarthView raster, ITS_LIVE annual mosaics, WASM port if needed | scale + perf gates |

---

## 9. Decisions needed before building

1. **The top-10 criterion** — "best-observed across climates" (§4) vs largest
   vs most famous. It changes the list.
2. **Nav slot** — the Earth & Orbit menu is at its **10-link cap**
   (`js/site-sections.js`). Something moves to the hub page, or Glacier Watch
   lives on the hub + EarthView only at first.
3. **Calving / ice-sheet glaciers** in the top 10 as motion-only entries
   (Jakobshavn, Columbia, Perito Moreno) — yes, or full-chain glaciers only?
4. **Earthdata login for CI** (RGI 7, IMS NetCDF from NSIDC) — OK to add a repo
   secret? Without it, P0 leans on OGGM directories (open HTTP) for geometry.
5. **Year convention** — hydrological year (Oct–Sep NH, Apr–Mar SH; what the
   science uses) vs calendar year in the UI.
