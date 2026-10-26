# EarthView — clouds · wind · isobars · ocean temperature: data, LOD and UX plan

Status: **Phase 0 shipped 2026-10-26** (§4, one PR; its nine items are each
node- or browser-gated — see the table). Phases 1–6 remain **planned, not
built**. Written after a code audit of the
cloud / wind / isobar / ocean stacks and two production probes (the Supabase
`weather_grid_cache` + `pipeline_heartbeat` tables and `/api/weather/grid`).
Every number in §1 was measured; every cause in §2 is cited to a file and line,
or is marked *inference* where the code allows it but a live run has not shown it.

Companion docs this one assumes: `CLOUD_WIND_DEPTH_PLAN.md` (the volumetric
cloud renderer, the atmo-scale ramp, the clock), `WEATHER_FORECAST_PLAN.md`,
`PRESSURE_OUTLOOK_ENGINE_PLAN.md` (§2 measured skill, the MSLP Phase 0),
`EARTH_LOD_NASA_PRECIP_PLAN.md`, `PLANETARY_TEMPERATURE_LAB_PLAN.md`
(the fallback-source scoring). Nothing here replaces them; this doc is the
EarthView-wide sequence that ties them together and adds the LOD and UX work
none of them owns.

---

## 0. TL;DR

The two screenshots (2026-10-25, Firefox, production) show four things, and
three of them have a single root cause each:

| What the user sees | What it is | Where |
|---|---|---|
| A sharp **vertical line** down the cloud field | A mipmap seam at the antimeridian: the mosaic is the only mip-mapped cloud texture and its `u` coordinate jumps 1→0 per fragment, so the GPU picks the coarsest mip along one pixel column | §2.1 |
| Clouds as **horizontal strips**, no detail on zoom | Coverage is gated by the 5° weather grid wherever satellite confidence is low; MODIS optical-thickness fill decodes transparent (polar-night / swath-gap) pixels as *clear*; and there is **no cloud LOD at all** — one 2048×1024 global snapshot (~20 km/px) at every zoom | §2.2, §2.3 |
| "**Isobars: live weather unavailable — showing synthetic circulation**", "**forecast unavailable**", WIND SKILL dashes | **Open-Meteo answers HTTP 414 Request-URI Too Large** to every 864-location chunk. The hourly cron has fallen to MET Norway on every run for at least 30 days (287 of 287 cached frames), and the three browser-side feeds (forecast ring, 850/500/250 hPa winds, regional patch) build URLs of the same size and almost certainly fail the same way | §1.1, §2.4 |
| A **black globe** for many seconds while the status bar waits on `wvs.earthdata.nasa.gov` | The base texture is a 1×1 black texel until the unpkg 4K JPEG lands; the loading overlay waits for all four CDN textures; 9 GIBS snapshots fire at boot in parallel with it. The wvs wait is the longest-pending request, not the blocker | §2.5 |

The plan is six phases. Phase 0 is small, mechanical, and gets the live data
back; it should ship first and alone. Phases 1–4 make each layer hold up
under zoom. Phase 5 builds the one LOD framework the layers then share.
Phase 6 is the UX pass, and its items are listed so they can be pulled
forward — several (never-black boot, honest status chips, a default hover
readout) are cheap and worth doing beside Phase 0.

---

## 1. Ground truth, measured 2026-10-26

### 1.1 The weather grid has been on the fallback for a month, and the reason is a 414

```sql
select source, count(*), min(fetched_at), max(fetched_at) from weather_grid_cache group by source;
-- met-norway:72x36 | 287 | 2026-09-26 03:00 | 2026-10-26 02:00
```

Every frame the table holds (it retains 30 days) is the MET Norway 10°
fallback, bilinear-upsampled to 72×36 server-side. `/api/weather/grid` on
production returns `"source":"met-norway:72x36"`. The heartbeat row names the
cause:

```
pipeline_name = weather_grid
last_source   = met-norway:72x36
reason        = degraded: served met-norway:72x36;
                open-meteo chunk 1728 HTTP 414: <html>…414 Request-URI Too Large…nginx…
              | open-meteo-gfs chunk 1728 HTTP 414: …
```

The cron builds three GET requests of 864 locations each
(`api/cron/refresh-weather-grid.js:126`, `chunkUrl` at `:209-218`). Measured URL
length for one chunk: **~10.5 KB**. Nginx's default request-line limit is
8 KB. The header comment at `:124` says "~10 KB, well inside Open-Meteo's
accepted range" — that was true of an earlier front end and is not true now.
The browser-side feeds are the same shape and longer, because they print
coordinates with `toFixed(2)`:

| Feed | Locations per request | Estimated URL | File |
|---|---|---|---|
| hourly cron (current) | 864 | ~10.5 KB | `api/cron/refresh-weather-grid.js:126` |
| forecast ring (hourly, +16 d) | 864 | ~12.3 KB | `js/weather-forecast-feed.js:62` |
| 850/500/250 hPa winds | 864 | ~12.3 KB | `js/temp-volume-feed.js:58` |
| regional weather patch | 640 (`toFixed(3)`) | ~11.5 KB | `js/weather-patch.js:82,359-364` |

A 414 from Open-Meteo arrives **without CORS headers**, so in the browser it
surfaces as a bare `NetworkError` (`earth.html:9601-9605` already documents
this for the 429 case). That is why the time bar says "forecast unavailable"
with no further detail, why WIND SKILL shows "—" at every lead (the
`open-meteo-gfs-v1` model abstains on an empty ring, `js/weather-forecast.js:150`),
and — *inference, not yet observed* — why there is no regional detail in the
wind or isobars when zoomed: the patch never loads. The sandbox cannot reach
Open-Meteo to confirm the browser-side 414s; the heartbeat confirms the server
side, and the URL arithmetic is the same.

**Consequences that are not obvious from the symptoms**

- Isobars in production are drawn from **sea-level pressure** (MET Norway writes
  `air_pressure_at_sea_level` into the P slot, cron `:470-483`), so the
  "isobars contour terrain" bug in `PRESSURE_OUTLOOK_ENGINE_PLAN.md` is
  currently masked and will return the moment Open-Meteo is restored. Phase 0
  must switch the channel to `pressure_msl` **in the same change** that fixes
  the 414.
- The MET Norway fallback averages `wind_direction_10m` **linearly in degrees**
  during upsampling (cron `:367-372`, `:430-431`). 350° and 10° average to 180°.
  `js/weather-feed.js:486-489` already explains why this is wrong for the
  client path; the server path repeats it.
- `freshness:'stale'` is emitted by the grid route and **never read by the
  client** (`js/weather-feed.js:354-359`), so a MET Norway frame shows a green
  status pip.
- The "Isobars: live weather unavailable" toast is a **boot race** independent
  of the outage: the first `animate()` tick dispatches the feed's initial
  `loaded:false` meta before any fetch can resolve (`weather-frame-resolver.js:236-241`,
  `weather-feed.js:130`), every checked weather row is marked fallback, and
  nothing ever un-shows the toast (`earth.html:10904-10952`). It would appear on
  a perfectly healthy page.

### 1.2 Clouds

- One whole-globe equirectangular snapshot per layer from
  `wvs.earthdata.nasa.gov/api/v1/snapshot`, 2048×1024 (≈0.176°, ≈19.5 km per
  pixel), browser-direct, no `api/` relay (`js/cloud-imagery.js:59,131-145`;
  `SAT_W` in `js/satellite-feed.js:84`). Products: geostationary IR Band 13 for
  GOES-East / GOES-West / Himawari / Meteosat IODC (Prime as fallback), MODIS
  Terra/Aqua Cloud Optical Thickness daily composites for the polar fill
  walking back up to 3 days, then true-colour as a last resort.
- Live poll every 10 min, 4-frame LRU, retention **assumed** 30 d
  (`cloud-time.js:95`).
- Each region picks its own freshest successful time (up to 90 min back, or a
  day-old date-only frame), but the mosaic reports **one** `timestampMs` — the
  newest region's — so older discs are advected with the wrong lead
  (`cloud-imagery.js:199-215`, `:350-353`).
- A GIBS out-of-range time returns a **blank transparent PNG with HTTP 200**;
  `loadImage` treats any `onload` as success (`cloud-imagery.js:156`), so a
  blank disc ends the fallback walk and contributes nothing.
- The volumetric march, decal and ground shadow all sample the mosaic through
  `normalToUV` with no explicit gradient (`earth-skin.js:1031`, `:394-396`;
  `cloud-volume.js:373,376`). The mosaic is `LinearMipMapLinearFilter` with
  anisotropy 8 (`cloud-imagery.js:274-278`); `u_cloud_layers` and `u_wind` have
  no mips.
- Noise floor ≈25–30 km (base frequency ×22 per Earth radius, detail ×4.3,
  `cloud-volume.js:461,519`; decal ×14, `earth-skin.js:879`). Nothing changes
  with camera distance except the exaggeration ramp and the step ladder.
- The high-res weather patch reaches the **decal** through `sampleCloudLayers`
  (`earth-skin.js:121-131`) but the **volumetric** path reads `u_cloud_layers`
  directly and has no patch uniforms (`cloud-volume.js:354`).
- The surface detail inset streams `VIIRS_SNPP_CorrectedReflectance_TrueColor`
  at `time=default` (`earth-detail-inset.js:44-67`): that day's clouds are baked
  into the ground, so at zoom the live cloud layer sits over a second,
  time-mismatched cloud field. *Inference; not screenshotted.*
- Tests: `tests/fixtures/clouds/` does not exist, so every sandbox gate runs on
  64×32 synthetic stubs with vertical bands (`tests/helpers/cloud-source.mjs:175-176`).
  No gate measures a seam, a stripe, time-to-first-textured-frame, a blank-200
  frame, mixed-time discs, or close-zoom detail.

### 1.3 Wind and isobars

- Grid: 72×36 at 5°, nine channels, hourly cron → `weather_grid_cache` →
  `/api/weather/grid` (CDN 3600 s) → `WeatherFeed` (15 min poll) →
  `weather-decode.js` bilinear to 360×180. In production the field is
  therefore bilinear twice (10°→5° server, 5°→1° client).
- Four wind levels: 10 m from the grid; 850/500/250 hPa from `temp-volume-feed.js`
  (Open-Meteo, browser-direct, on enable, −24 h…+72 h). Winds aloft used by the
  cloud advection are a **gain on the 10 m wind** (`windGainAt`), not those fields.
- Isobars: marching squares at 4 hPa on channel P after a 3-pass blur
  (`isobar-engine.js:43-45`, `:338-341`, `:530-628`), rebuilt on every
  `weather-update`, global grid only — never the regional patch.
- Scrubber: −7 d … +14 d. The IDB ring holds 24 hourly frames and `bracket()`
  clamps, so −24 h to −7 d shows the oldest frame frozen (`weather-history.js:76`,
  `:493-524`) although the server keeps 72 h hourly + 30 d 3-hourly
  (`grid.js:102-106`). 0…+24 h is in-browser RK2 advection, cross-faded into the
  Open-Meteo ring at +20…+24 h, then raw deterministic frames to +14 d. Past
  ~day 8 those are worse than climatology (plan §2: d14 MSE skill −0.65).

### 1.4 Ocean temperature and currents

- **There is an SST layer and it is on by default** (`lyr-obs-sst`, `earth.html:3199`):
  NASA GIBS `GHRSST_L4_MUR_Sea_Surface_Temperature` as a **pre-coloured PNG** at
  2048×1024 (≈20 km/px against MUR's 1 km native), drawn on a shell at
  radius 1.002 at opacity 0.35 (`js/earth-obs-feed.js:168-186`; `earth.html:10663-10754`).
  Pixels encode colour, not °C: there is **no hover readout, no probe value, no
  zoom path**, and the legend's stops are hand-coded (`earth.html:3971-3981`).
- Numeric SST exists only at points: Open-Meteo Marine `sea_surface_temperature`
  in the Marine Conditions click card (`js/trip-planner.js:284`) with a
  **latitude-formula fallback** `28 − |lat|·0.32` °C when that fails
  (`earth.html:9245-9250`), and NDBC `water_temp_c` in the buoy card.
- **Ocean currents are synthetic**: 28 hand-placed current axes + 7 gyres + a
  box land-mask (`js/ocean-currents-feed.js:47-251`), no network call, no time
  dependence, yet `oceanCurrentsMeta()` reports `status:'live'` and the pip is
  forced green (`:395`; `earth.html:8637-8644`).
- None of `/api/ocean/*` is in `js/pipeline-registry.js`; they 503 on upstream
  failure rather than emitting `freshness:'stale'`.

### 1.5 LOD and chrome today

- Camera 1.004 R (`AtmoScale.cameraFloor`) to 10 R. Zoom drives: near plane,
  the ×10→×55 exaggeration ramp (2.50→1.06 R), wind particle count/trail
  brightness on the same anchors, wind arrows (`zoom01 ≥ 0.18`), wind columns
  (`≥ 0.30`), AQ tiers (1.65 / 1.22 R), alert icon scale.
- Footprint-driven insets (`js/focus-footprint.js`): weather patch < 32° span,
  VIIRS imagery inset < 45°, shaded-relief bump < 25°, terrain mesh < 18° and
  DEM < 6° (both behind `?terrain3d=1`, never on mobile).
- `body[data-ev-alt]` is set to orbit / regional / low every frame
  (`earth.html:14786-14787`) and **nothing reads it**.
- One reactive governor (`_governResolution`, `earth.html:4640-4688`): pixel
  ratio → bloom → cloud tier; insets and the patch ignore it.
- Layer state is **not persisted** and the URL encodes no layers, camera or
  time. No presets. The point probe is opt-in (`#` badges) and covers no SST,
  CAPE, vorticity, AQ or observation layer. Keyboard: Space and N, documented
  in a `title` attribute. No tour, no help overlay.

---

## 2. Diagnosis of the screenshots

### 2.1 The vertical line

`normalToUV` computes `u = atan(-n.z, n.x)/2π + 0.5` per fragment
(`js/geo/coords.glsl.js:39-54`). Across the antimeridian `u` goes 1→0 in one
pixel; the hardware derivative `dFdx(u)` there is ~1, the LOD computation
selects the coarsest mip, and the GPU draws one or two pixel columns of
globally-averaged cloud. This hits every cloud tap that reads the mosaic
(volume ×2, decal, ground shadow) and nothing else, because the mosaic is the
**only** mip-mapped cloud texture. `RepeatWrapping` does not help — wrap fixes
the *sample*, not the *derivative*. Two data-side lunes can add a softer
north–south boundary nearby (the daily-composite dateline in the polar fill,
`cloud-mosaic-core.js:188,304-308`; and the GOES-East ↔ Meteosat-IODC gap at
≈15°W where the primary weight falls below 0.6 above ~45° — hand calculation,
`diag.composite.gapCenterLon` would locate it). The sharp line is the mip.

Fix (Phase 1.1): sample with explicit gradients. Compute `du/dx, du/dy` from
the *unwrapped* longitude (`fwidth` on `atan` is discontinuous; `fwidth` on
`n.x, n.z` is not) and use `textureGrad` (WebGL2) or `texture2DLodEXT`
(`EXT_shader_texture_lod`, WebGL1), with a `textureLod(…, 0)`-at-the-seam
fallback when neither exists. Gate with an image metric: column-wise mean
over the antimeridian band vs its neighbours must not spike, with the
unpatched shader as the negative control (the `upper-atmosphere-image-metrics`
pattern — a threshold without a control is a guess).

### 2.2 The strips

Three mechanisms, in order of likely contribution:

1. **Coverage is gated to the 5° grid wherever satellite confidence is low.**
   `columnAt` sets `covLow = mix(0.55, mix(0.02, 1.0, cl.r), g)` with `g` clamped
   to 1 (`cloud-volume.js:355-361`; decal at `earth-skin.js:983-986`). Where the
   mosaic alpha is low, the drawn coverage *is* the bilinear 72×36 field —
   today the twice-upsampled 10° MET Norway field — which is strongly zonal.
   The decal's own comment says it fixed exactly this once (`earth-skin.js:911-919`).
2. **COT transparent = clear.** Transparent pixels in the MODIS optical-thickness
   fill decode as *observed clear at confidence 0.45*
   (`cloud-mosaic-core.js:72-78`, `:97-101`). COT is a daytime visible retrieval;
   in late October the Arctic is in polar night, so the whole polar cap and
   every swath gap become forced-clear bands. *Inference.*
3. **Zonal handoffs**: the geostationary feather fades between 60° and 76°
   view angle and the fill takes over, so a fresh/stale, sharp/soft boundary
   runs around the globe at high latitude.

Fix (Phase 1.2): treat *unobserved* as unobserved (alpha 0, not "clear at 0.45")
unless the pixel is sunlit at retrieval time; blend coverage with the grid
through a confidence weight that falls to the **procedural** field, not the 5°
field, where confidence is low; stage the polar fill from a product that
works at night (MODIS/VIIRS IR brightness temperature or cloud-top height,
not optical thickness) — to be verified against the live WMTS capabilities.

### 2.3 No detail on zoom

There is no cloud LOD. One 2048-wide texture is ~20 km per pixel; the drawn
noise floor is ~25–30 km; at the 1.06 R inner anchor the camera is ~380 km
up and a 1280 px frame spans ~400 km, so one mosaic texel is ~60 px wide. The
"3D LOD details" the user is asking for do not exist in the renderer today.
Phase 1.3 adds a three-tier ladder; §5 generalises it.

### 2.4 The data toasts

See §1.1. One root cause (414) plus one UI race. Phase 0.

### 2.5 The black globe

`u_day` starts as a 1×1 black texel (`js/earth-skin.js:1762-1763`) and changes
only when the unpkg 4K JPEG lands (`:30-35`, `:1888-1940`, no timeout). The
`#loading` overlay is dismissed only when **all four** CDN textures settle
(`earth.html:5551-5554`). Meanwhile nine wvs snapshot requests start (4 cloud
discs + polar, plus 4 default-on observation layers: IMERG, SST, fires, snow —
`earth-obs-feed.js:143-265`, `earth.html:10606`) and compete for bandwidth.
The first `animate()` sits behind a top-level `await wxGridHistory.open()`
(`earth.html:9414`), guarded at 5 s. The status bar names wvs because it is
the longest pending request. Nothing awaits wvs. Phase 6.1 (never-black boot)
fixes this and it can ship with Phase 0.

---

## 3. Principles this plan holds to

Carried from `CLAUDE.md` and the sibling plans; listed so a reviewer can check
each phase against them.

1. **A feed that is down must look down.** Never substitute a nearer frame, a
   latitude formula, or a climatology under a label that says "live". The
   label changes with the data (`cloud-time.js` modes are the model).
2. **Observed and modelled are different claims** and are rendered, labelled
   and toggled separately (the upper-atmosphere density/airglow rule).
3. **One copy.** One chunk-size constant for Open-Meteo requests, one
   view-level kernel for LOD, one tile streamer for every inset, one status
   chip renderer. Three copies of the 864 constant is how this outage happened.
4. **LOD is driven by camera distance / footprint, never by what the LOD
   changes** (the Mars `regionalReliefScale` feedback trap; `atmo-scale.js`
   §2 rule).
5. **Pure kernels, node-gated; renderers draw kernel numbers.** Every new
   piece of logic (view level, tile plan, SST decode, seam/stripe metrics)
   lands as a `js/*.js` pure module with a `tests/*.mjs`.
6. **Image gates carry a negative control** that puts the old bug back and
   must fail (`tests/upper-atmosphere-image-metrics.spec.js` pattern).
7. **Disclose every stretch and every lie** (exaggeration, colour stretch,
   synthetic fields) live in the legend, never in a comment.
8. **No framework, no bundler, flat `*.html`.**

---

## 4. Phase 0 — plug the data back in (small, ship first)

**Shipped 2026-10-26.** Everything here is mechanical and each item is
independently verifiable against the heartbeat or a node test. The one
copy of the Open-Meteo chunk rule is `js/open-meteo-request.js`
(`tests/open-meteo-request.mjs`); the one copy of the ocean reference
markers is `js/ocean-reference-stations.js`. Two things the sandbox could
NOT verify and the deploy must (Open-Meteo, NASA and parkersphysics.com are
egress-blocked at build time): that `pipeline_heartbeat.last_source` for
`weather_grid` reads `open-meteo:72x36` within two hours of deploy, and
that a healthy production load of earth.html shows neither the
synthetic-circulation toast nor the "forecast unavailable" badge. The MSLP
switch also tags every frame `pressure_kind` and bumps the IDB ring to v2
(the v1 store is dropped on upgrade); the status page now reads a route's
`freshness` before its `freshnessExempt` short-circuit, which the ocean rows
needed to score amber rather than green.

| # | Change | Where | Gate |
|---|---|---|---|
| 0.1 | **Chunk ≤ 400 locations** (≈5.4 KB URL at `%g` precision) for every Open-Meteo multi-location request. Move the constants to **one** pure module `js/open-meteo-request.js` (`chunkRanges(gridN, max)`, `chunkUrl(...)`, a `MAX_URL_BYTES = 7000` assert) imported by the cron, the forecast ring, the temp-volume feed and the patch. Drop `toFixed(2/3)` where the grid is on exact half-degrees. Update the wrong header comment at cron `:119-126`. | `api/cron/refresh-weather-grid.js`, `js/weather-forecast-feed.js`, `js/temp-volume-feed.js`, `js/weather-patch.js` | `tests/open-meteo-request.mjs` asserts every emitted URL < 7000 bytes and that the merged order is unchanged; `tests/weather-grid-pipeline.mjs` extended with a 414 fixture → must fall back AND record the reason. After deploy: `pipeline_heartbeat.last_source` must read `open-meteo:72x36` within two hours. |
| 0.2 | **Pressure channel = MSLP.** Request `pressure_msl` in the cron, `RANGE_KEEP_FIELDS`, `_extractCoarse`, `HOURLY_VARS`, the patch and the temp-volume feed; tag frames `pressure_kind:'msl'`; bump the IDB ring version so old `surface_pressure` frames are not blended with new MSLP frames; MET Norway path unchanged (already MSLP). | per `PRESSURE_OUTLOOK_ENGINE_PLAN.md` Phase 0 | node test on the P path; before/after screenshot over Tibet on the live gate |
| 0.3 | **Vector-average wind direction** in the MET Norway upsampler (U/V, then back to speed/direction). | cron `:367-372`, `:430-431` | node test: 350° and 10° → 0°, not 180° |
| 0.4 | **Read `freshness`** in `WeatherFeed` and carry it on `meta` (`live` / `stale` / `expired` + `source`); pips go amber on `stale`. | `js/weather-feed.js:354-359`, `earth.html:10884-10952` | `tests/earth-smoke.spec.js` with a mocked stale grid |
| 0.5 | **Kill the toast race**: the fallback toast fires only on a *transition* from `loaded:true` to a failure, never on the initial `loaded:false`; a later good `weather-update` **clears** it. | `earth.html:10922-10952`, `weather-frame-resolver.js:236-241` | browser gate: healthy mocked grid → no toast within 10 s |
| 0.6 | **Per-region mosaic timestamps**: return `timestampMs` per disc; advect each disc with its own lead; the row tooltip names the oldest. | `js/cloud-imagery.js:350-353`, `satellite-feed.js`, `cloud-time.js` | `tests/cloud-time.mjs` |
| 0.7 | **Detect blank-200 GIBS frames** (alpha-sum below a floor after decode) and treat them as a miss so the fallback walk continues. | `js/cloud-imagery.js:156`, `cloud-mosaic-core.js` | node test with a blank PNG fixture |
| 0.8 | **Register the ocean routes** (`/api/ocean/tides`, `buoys`, `dart`, `/api/weather/enso-mjo`) in `js/pipeline-registry.js`; make them answer 200 + `freshness:'stale'` with flagged reference markers instead of 503. Label the currents overlay `status:'reference'`, pip amber, row text "climatology, not a live observation". | `api/ocean/*`, `js/ocean-currents-feed.js:395`, `earth.html:8637-8644` | `tests/pipeline-registry.mjs` |
| 0.9 | **Use the server's history depth**: the client's 24-frame ring backfill should ask `/api/weather/grid?range=…` for 72 h hourly (cap 72 is the route's own limit), so −3 d scrubs move instead of freezing. | `js/weather-history.js:76`, `earth.html:9429` | `tests/weather-grid-pipeline.mjs` |

Deliberately **not** in Phase 0: anything that changes how a layer looks.

---

## 5. Phase 1 — clouds that survive zoom

### 5.1 The seam (one shader change, three taps)

Add `sampleMosaic(dir)` to the shared GLSL (`js/geo/coords.glsl.js` is the
right home — one copy): computes `uv = normalToUV(dir)` **and** analytic
gradients from `dFdx/dFdy` of `dir` (continuous), then `textureGrad` /
`texture2DGradEXT`; WebGL1 without the extension falls back to
`texture2DLodEXT`-free bias sampling with the seam column clamped to mip 0.
Replace the four raw `texture2D(u_satellite, normalToUV(…))` taps. Also the
right fix for any future mip-mapped equirectangular layer (SST tiles in §8).

Gate: `tests/earth-image-metrics.spec.js` (new; pure metrics in
`tests/helpers/image-metrics.mjs` already exist) renders clouds solo with the
antimeridian facing the camera and asserts the seam-column contrast against
its ±8 px neighbours is below a threshold, with the gradient-free shader as
the negative control.

### 5.2 The strips

1. **Unobserved stays unobserved.** In `cloud-mosaic-core.js` decode, COT
   transparent → alpha 0 unless the pixel's local solar elevation at the
   composite's date was > 5° (the Sun is already in `js/sun-altitude.js`;
   reuse it). Polar night then falls to the model/procedural field with a
   disclosed "no daytime retrieval" state.
2. **Confidence falls to procedural, not to the grid.** Change `g` from a
   constant to `mix(procedural, gridCoverage, gridTrust)` where `gridTrust`
   is a *per-channel* confidence published on `weather-update`
   (1.0 for Open-Meteo 5°, 0.5 for upsampled MET Norway, 0 for synthetic).
   The grid still sets the regional mean; it no longer draws its own cell
   edges.
3. **Night-capable polar fill**: evaluate `MODIS_*_Cloud_Top_Height` /
   `VIIRS_*_Brightness_Temp` layers as the fill (IR, day/night consistent, the
   same reason IR leads the geostationary chains). **Unverified** — the layer
   IDs must be checked against the live WMTS capabilities on a networked
   machine before any of this is wired (the `noaa-regions` candidate-list
   pattern: resolve from a list, self-report the winner).

Gate: a row-autocorrelation stripe metric on a solo cloud render at 70°N
(high zonal autocorrelation with low meridional autocorrelation = strips),
negative control = the current decode.

### 5.3 The cloud LOD ladder

Three tiers, selected by the one view-level kernel of §9 (until that lands,
by the existing `focus-footprint` span):

| Tier | Trigger (footprint lat span) | Data | Where it goes |
|---|---|---|---|
| **A — global** | > 45° | the existing 2048×1024 mosaic | `u_satellite` (unchanged) |
| **B — regional** | ≤ 45° | GIBS **WMTS tiles** of the same geostationary IR product covering the footprint (GOES ABI Band 13 is served on the 2 km matrix set, ≈0.018°/px — 10× the snapshot), stitched by the generalised inset streamer (§9.2) into `u_satDetail` + `u_satDetailBounds`, time = the disc's own timestamp so it matches the global frame | both the volume **and** the decal (today only the decal has a patch path) |
| **C — local** | ≤ 12° | two more procedural noise octaves scaled by camera distance, constrained by the Tier-B coverage and the IR top height (`cloud-volume.js` already turns IR top into column height; at this tier the march's step budget rises because the ray is short) | volume only |

Rules: the tier texture is **coverage-normalised through the same
`cloud-mosaic-core` decode** as the global one (one encoding, or the Tier-B
edge becomes the next "vertical line"); the blend is a soft edge like the
surface inset's `smoothstep(0, 0.12, edge)`; Tier B is fetched only when the
camera has settled (the inset streamer's 1500 ms cadence) and aborted on a
new plan; the request budget is governed (§9.3). Tier C is the only tier that
*invents* structure and the legend says so ("detail below 2 km is synthesized").

### 5.4 One cloud field, not two

The surface inset's VIIRS true-colour tiles carry that day's clouds. Options:
(a) switch the imagery inset to a cloud-free base
(`BlueMarble_NextGeneration` is already in its layer list) and let the live
layer be the only clouds; (b) keep VIIRS but only in Research / "satellite
imagery" mode where the live cloud layer is off. Recommendation: **(a) by
default, (b) as an explicit "Today's satellite image" layer** — an observed
true-colour picture of today is a thing people want, but not under a
different cloud field.

### 5.5 Boot order and the black globe → see §10.1 (ship with Phase 0)

---

## 6. Phase 2 — wind

1. **Pressure-level winds on the ring.** Put 850/500/250 hPa U/V on the hourly
   ring the scrubber replays (the `CLOUD_WIND_DEPTH_PLAN.md` §7 "next step").
   This makes the cloud advection's `windGainAt` approximation go away and
   lets the four wind levels scrub coherently. Server side this is three more
   channel pairs in the grid payload (fetch in the same Open-Meteo call —
   `wind_speed_850hPa` etc. are `hourly` variables; size the payload against
   the Edge body limit the retention note at `supabase-weather-cache-migration.sql`
   describes).
2. **Regional wind at zoom.** The patch (0.25–1°, ≤32° span) already re-feeds
   the surface particles; once 0.1 restores it, extend it to the three
   levels and to the **isobar** contouring (§7). Below a 12° span, show
   **streamlines + barbs** from the patch field in addition to particles —
   barbs carry speed and direction legibly on a still frame, which particles
   do not.
3. **Particle LOD is already camera-anchored** (`WIND_LOD_NEAR/FAR`). Add a
   footprint-density rule so the on-screen particle count per 1000 px² is
   constant across zoom rather than the per-level budget.
4. **Wind columns pickable** → the probe card (plan §7 open item).
5. **Legend**: speed ramp with numbers, level altitude, exaggeration (exists),
   and the *source + age* chip ("Open-Meteo GFS · 10 m · 42 min old").

Gates: `tests/wind-column.mjs`, `tests/wind-levels-smoke.spec.js`, plus a
new node test that the ring's level winds are time-coherent with the surface
frame they ride with.

---

## 7. Phase 3 — isobars

1. **MSLP end to end** (Phase 0.2) — otherwise everything below contours Tibet.
2. **Resolution follows the view**: global grid at Tier A; the regional patch
   field at Tier B (0.25–1° marching squares, 2 hPa spacing when the field
   supports it); contours are **re-contoured**, never upsampled lines.
3. **Labels on the lines** (inline, hPa, every N px of arc, screen-space so
   they stay readable), **H / L markers with their central value**, and the
   24 h **tendency** arrow at H/L centres from the ring.
4. **Smoothing disclosed**: the 3-pass blur is a display choice; print the
   effective smoothing length in the legend.
5. The forecast tail follows `PRESSURE_OUTLOOK_ENGINE_PLAN.md`: raw
   deterministic frames to ~day 5, relaxing toward the calendar normal past
   day 8, drawn **dashed** and labelled, never frozen.

Gate: `tests/isobar-engine.mjs` (contour a synthetic MSLP field with a known
low and a 5 km mountain: zero contours on the mountain).

---

## 8. Phase 4 — ocean temperature (and honest currents)

### 8.1 A quantitative SST field

Today's layer is a picture. Replace the default with a **data** layer:

- **Source (global, daily, 0.25°)**: NOAA OISST v2.1 via NOAA CoastWatch
  ERDDAP griddap (CSV/JSON or `.png` with our own palette) through a new
  **`/api/ocean/sst`** relay — the cron pattern (one fetch per day, cached,
  `freshness` on the payload, registered in the pipeline registry). ERDDAP
  CORS is unverified from the sandbox (egress-blocked), hence the relay, not
  browser-direct. Candidate list in `api/_lib/sst-sources.js` (OISST griddap
  → GHRSST MUR griddap at 0.25° subsample → Open-Meteo Marine gridded as the
  last resort), self-reported like `noaa-regions`.
- **Encoding**: a `Float32`/RGBA8-quantised texture in °C with a known
  transfer, our own colour ramp (the repo's validated sequential palette), so
  the **hover readout gives a number** and the legend is the real scale.
- **Anomaly view**: OISST ships its 1991–2020 climatology; a second channel
  carries SST − normal so the user can switch between "how warm" and "how
  unusual" (the Temperature Lab's rule: rank the unusual by rarity, not by
  raw ΔT).
- **Zoom**: Tier B tiles of GIBS MUR (1 km) through the shared inset streamer
  for *texture*, with the OISST field still the *number* under the cursor
  (observation structure from the fine product, values from the calibrated
  one — the sun.html fusion lesson, in miniature). The picture layer stays as
  "NASA MUR imagery" for users who want NASA's palette.
- **Time**: one frame per UTC day on the shared timeline (`earth-obs-time.js`
  already does this); future scrubs hold the last observation and the chip
  says "latest observation (SST is not forecast here)".

### 8.2 Currents

Say what it is until it is real: amber pip, row text "climatological
reference field". Then evaluate real data behind the same relay: OSCAR
v2 (PO.DAAC needs Earthdata login — server-side token, keyed env var,
never in the client), or CoastWatch ERDDAP mirrors of OSCAR / HYCOM surface
currents (unverified, candidate list). Particles switch source when a real
field loads; the legend's source chip flips with it.

### 8.3 Marine point card

Remove the `28 − |lat|·0.32` formula as a *fallback value*; a failed marine
fetch prints "no marine model answer" (principle 1). Add buoy marker colour
by `water_temp_c` through the same SST palette so stations and field agree.

Gates: `tests/sst-sources.mjs`, `tests/ocean-feeds.mjs` extended, a browser
gate that hovers the field and asserts a numeric readout.

---

## 9. Phase 5 — the LOD framework everything shares

### 9.1 `js/earth-view-level.js` (PURE)

Input: camera distance, fov, aspect, pointer; output: `tier`
(`orbit` > 1.5 R surface distance · `regional` > 0.16 · `local` > 0.035 · `ground`),
footprint (centre, lat/lon span — fold `focus-footprint.js` in or make it
the one caller), and per-layer **budgets** (texels, requests, particle
density). One function, node-gated against the thresholds the page already
uses, replaces the five hard-coded activation spans and gives `body[data-ev-alt]`
a consumer at last (CSS density: panel compaction, label size, legend detail).

### 9.2 One tile streamer

Generalise `earth-detail-inset.js` into `js/earth-tile-streamer.js`: N named
layers, each with its own tile grid (GIBS WMTS 288/2^z with padded edges; a
plain geodetic 2·2^z×2^z grid for non-GIBS sources — the Mars-tiles note says
never to mix the two), time parameter, LRU, abort-on-replan, and a
**priority queue with a concurrency cap shared across layers** (surface
imagery, clouds Tier B, SST Tier B, relief). Each layer gets a
`u_<layer>Detail` + bounds pair and the same soft edge. The GLSL half lives
in `js/geo/inset.glsl.js` (exists).

### 9.3 Budgets and the governor

The governor today trades pixel ratio → bloom → cloud tier. Add the LOD tier
to it: at the floor tier, Tier B/C never activate, and the streamer's
concurrency drops to 2. Request budget at boot: **base texture first, cloud
discs second, default-on observation layers only after the first textured
frame** (§10.1). LOD requests are camera-settled (1500 ms cadence) so a fling
fetches nothing.

### 9.4 What does *not* change with zoom

The physics. Exaggeration, step ladders, particle counts and texture tiers
move; coverage, pressure, SST values do not — a layer's Tier-B field is a
higher-resolution *sample* of the same quantity, never a re-tuned one.

---

## 10. Phase 6 — UX

Ordered by impact over cost. Items marked ★ are cheap enough to ship with
Phase 0.

### 10.1 ★ The first ten seconds — never a black globe

- Ship a **boot texture tier** for EarthView the way the homepage hero does
  (`assets/earth` boot tier, ~115 KB, already built by
  `scripts/build-hero-earth-textures.py`): `u_day` starts on it, not on a
  1×1 black texel. The 4K JPEG and the GIBS Blue Marble upgrade swap in
  behind it (strictly no-worse, as `_scheduleBaseUpgrade` already is).
- Dismiss `#loading` on the **first textured frame**, not on all four textures.
- Stage requests (§9.3): default-on observation layers start after first
  paint; wvs snapshots are capped at 3 concurrent.
- A one-line **boot caption** under the globe for the first seconds:
  "Loading live clouds — GOES-East · Himawari · Meteosat…" that becomes the
  cloud row's status chip. The user should never read a browser status bar
  to learn what the page is waiting on.

### 10.2 ★ Honest, specific status everywhere (one chip renderer)

Replace the four pip colours + ad-hoc toasts with one `StatusChip`
(`js/layer-status-chip.js`, pure text model + DOM): **source · age · mode**
("GOES-East IR · 12 min" / "MET Norway 10° · upsampled · stale" /
"climatology · reference" / "no daytime retrieval"). Rules: a chip never says
"live" for a fallback; a toast appears only on a *transition* and clears on
recovery; a feed down shows *what is drawn instead* (model / nothing), never
a blank. The cloud-time mode names (live / replay / nowcast / model /
unavailable) are the vocabulary for every time-dependent layer.

### 10.3 ★ A default hover readout

The `#` opt-in badges go. When a layer is on, hovering shows its value:
cloud % (and tier source), wind (10 m + the enabled levels), MSLP, SST °C,
precip mm/h, temperature. A compact pill near the cursor, with the
provenance/confidence chip the scrubbed readout already has
(`earth.html:5694-5790`). Click → the probe card (today opt-in via
`lyr-probe`) becomes the default click on bare globe: values, a 48 h
sparkline from the ring + forecast ring, and "Fly here".

### 10.4 Zoom is a feature, so say so

- An **altitude / scale readout** in the time bar's right end ("1 200 km ·
  120 km/px"), and the current LOD tier as a word ("Regional detail").
- **Zoom toward the cursor** (orbit-view); double-click flies in (exists);
  two wheel pushes against the floor enter a **surface view** (the Mars
  zoom-through rule) with a horizon camera — EarthView has the horizon tilt
  but no explicit surface mode.
- A one-time hint when a layer gains a finer tier: "Regional cloud detail
  loaded — GOES ABI 2 km" (dismissable, once per session).
- Terrain relief on by default where the DEM source is verified (today
  behind `?terrain3d=1`), governed off on weak GPUs.

### 10.5 The layer panel

- **Three tiers of panel**: a short **Featured** list (clouds, wind, pressure,
  precipitation, SST, aurora, alerts) open by default; **groups** below as
  today; **search** stays. The featured list shows the status chip and an
  inline **legend strip** under each enabled row (numbers, units, the
  disclosure line) — legends live in the panel today and vanish when `#wx-panel`
  is minimised.
- **Presets**: Weather · Ocean · Space weather · Clean globe · Research —
  each a layer set + camera + time mode. Stored as a v1 doc and synced for
  sync tiers through the existing `dashboards` table (`dashboard-sync.js`,
  the space-weather pattern — no new schema).
- **Persist layer state** (local, versioned, with a permanent migrator) and
  **encode layers + camera + time in the URL** (`?l=clouds,wind,sst&cam=…&t=…`)
  so a view can be shared; `?trip=` already shows the way.
- "NEW" badges expire (30 days from ship date, in data not markup).

### 10.6 The time bar

- The hindcast half draws solid, the forecast half dashed; a **source band**
  under the scrubber names what feeds each range ("observed · nowcast ·
  GFS/ECMWF · climatology relax") — the WIND SKILL row's slot, which only
  specialists read, moves into the Weather Analysis panel.
- "forecast unavailable" → "forecast ring: Open-Meteo refused (414) — showing
  nowcast to +24 h". The error class is known in the feed; print it.
- A **"now" pulse** and a +24 h tick so the visible boundary between
  observation-derived and model frames is marked on the bar itself.

### 10.7 Help, shortcuts, onboarding

- `?` opens a keyboard/mouse cheat-sheet (Space, N, ±, R reset, F
  fullscreen, 1–5 presets, L layers, T time bar).
- A three-step first-visit tour on the live page (Featured layers → scrub →
  zoom in), skippable, stored. `js/explore-tour.js` already has a one-step
  earth banner to extend.

### 10.8 Mobile and accessibility

- The featured list is the mobile sheet's first screen; status chips are
  text, not only colour; every palette used for data is the repo's validated
  sequential/categorical set with numbers on the legend; the hover readout
  becomes tap-to-pin.

---

## 11. Verification

| Gate | Kind | What it proves |
|---|---|---|
| `tests/open-meteo-request.mjs` | node | every Open-Meteo URL < 7000 B; merge order unchanged |
| `tests/weather-grid-pipeline.mjs` (+414 fixture) | node | cron falls back AND records the reason; vector-mean direction |
| `tests/earth-image-metrics.spec.js` (new) | browser, solo renders, `gl.readPixels` | seam contrast at the antimeridian; stripe autocorrelation at 70°N; each with a negative control |
| `tests/earth-boot.spec.js` (new) | browser, mocked CDN + wvs with injected latency | time to first textured frame < 1.5 s with wvs stalled for 30 s; no black frame after `#loading` dismisses |
| `tests/cloud-timeline.spec.js` + fixtures | browser | per-disc timestamps; blank-200 handled |
| `tests/earth-view-level.mjs` | node | tier thresholds, footprint, budgets |
| `tests/earth-tile-streamer.mjs` | node | both tile grids, priority queue, abort |
| `tests/sst-sources.mjs`, `tests/ocean-feeds.mjs` | node | candidate resolution, decode, stale not 503 |
| `tests/isobar-engine.mjs` | node | MSLP contours, no mountain contours |
| `CLOUD_LIVE=1 … --headed` on a GPU machine | live | the only gate that sees how the clouds look |

Production checks after Phase 0 deploys: `pipeline_heartbeat.last_source`
reads `open-meteo:72x36`; `weather_grid_cache` gains Open-Meteo rows;
status.html's weather row turns green; a client with the fix shows a green
chip and *no* toast on a healthy load.

---

## 12. Sequence and rough effort

| Order | Phase | Effort | Depends on |
|---|---|---|---|
| 1 | 0 — data back in (+10.1, 10.2 chips) | 1–2 days | — |
| 2 | 1.1 seam + 1.2 strips + 5.4 one cloud field | 2–3 days | 0 |
| 3 | 9.1 view level + 9.2 tile streamer | 3–4 days | — |
| 4 | 1.3 cloud LOD ladder | 3–4 days | 2, 3 |
| 5 | 3 — isobars (MSLP, regional, labels) | 2 days | 0, 3 |
| 6 | 2 — wind (levels on the ring, regional, barbs) | 3 days | 0, 3 |
| 7 | 4 — SST field + honest currents | 3–4 days | 3 (+ one networked-machine probe) |
| 8 | 6 — remaining UX (probe, presets, URL state, time bar, help) | 4–5 days | 1–7 incrementally |

---

## 13. Decisions that are the author's

1. **Chunk size vs call accounting.** 400-location chunks mean 7 cron
   requests/hour instead of 3. Open-Meteo weights large requests by location
   count, so the daily budget should be unchanged — but the free tier's exact
   rule is theirs, and `OPEN_METEO_API_KEY` (customer endpoint) removes the
   question. Recommend: ship 400 now, decide on the key after a week of
   heartbeat data.
2. **Which cloud picture is default at zoom** (§5.4): cloud-free base + live
   clouds (recommended) vs today's VIIRS true colour.
3. **SST source order** (§8.1): OISST 0.25° as the number, MUR 1 km as the
   texture — or MUR for both through a griddap subsample. Needs one probe
   from a networked machine; the candidate-list code does not.
4. **Currents**: keep the climatology (relabelled) until OSCAR/HYCOM is
   relayed, or hide the layer until it is real.
5. **Surface view** (§10.4): worth an explicit mode, or is the horizon tilt
   enough? The Mars and Moon pages have one; EarthView would be the third
   copy of that camera and should reuse their rules (controls rebuilt with
   `camera.up` set first).
6. **Default-on layers at boot**: today clouds, wind, isobars, SST, IMERG,
   fires, snow, cities, rotate. Fewer at boot = faster first frame.
   Recommend clouds + wind + isobars + SST; the rest one tap away in Featured.
