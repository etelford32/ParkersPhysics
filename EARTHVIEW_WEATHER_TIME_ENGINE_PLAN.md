# EarthView — the weather time engine: one 4-D weather cube, a scrubber that shows the weather, physics between the frames

Status: **written 2026-10-31. Planned, not built.** Nothing in this document
has shipped.

Companion plans this one sits on top of, and does NOT re-plan:

| Plan | Owns | This plan uses it for |
|---|---|---|
| `EARTHVIEW_LOD_UX_PLAN.md` | data feeds, the LOD framework (§9), boot, status chips, presets + URL state (§10) | the view-level kernel, the tile streamer, the one status chip, the preset doc |
| `EARTHVIEW_VISUAL_DIALIN_PLAN.md` | the colour contract, compositing order, frame budget, aurora port | one ramp per quantity, the `ev-quality` tier, the OVATION oval |
| `CLOUD_WIND_DEPTH_PLAN.md` | the volumetric cloud march, `atmo-scale.js`, `cloud-time.js` | the march (gains real cloud bases here), the cloud clock vocabulary |
| `PRESSURE_OUTLOOK_ENGINE_PLAN.md` | the 0 → +14 d MSLP engine, climatology relax | the far end of the scrubber for pressure |
| `TEMP_OUTLOOK_ENGINE_PLAN.md`, `PLANETARY_TEMPERATURE_LAB_PLAN.md` | point/30-day temperature, normals | the climatology band, anomaly views |
| `WEATHER_FORECAST_PLAN.md` | the in-browser forecaster registry + validator | the nowcast members and the skill numbers the scrubber prints |

Those plans make each **layer** right. This one makes **time** right: one
store every layer reads at the scrubbed instant, one interpolation that moves
weather instead of cross-fading it, and a time bar that is an instrument
rather than a slider. It is the "one-stop shop for 3-D weather over time"
ask from 2026-10-31.

---

## 0. TL;DR

Today the scrubber drives **five independent clocks over five stores** — the
9-channel `WeatherHistory` ring (hourly, 5°, −72 h → +14 d), the pressure-level
ring in `temp-volume-feed.js` (−24 h → +72 h, its own memory), the
`weather-patch.js` regional ring (only as old as the session), the cloud
mosaic (`cloud-time.js`, 10-min archive + nowcast + model), and the
observation images (`earth-obs-time.js`). Between two hourly frames
`WeatherFrameResolver` **lerps** on the CPU at 360×180 and re-uploads three
Float32 textures. A front moving 500 km in an hour is drawn as two
half-strength fronts that cross-fade. Every layer answers "what is the
weather at t?" its own way.

The engine is six pieces, each shippable alone:

| # | Piece | What the user gets | Why it is ours, not Windy's |
|---|---|---|---|
| **T1** | **The Weather Cube** (`js/weather-cube.js`, PURE) — one time-indexed sampler over every source, with provenance per sample | Every layer, readout and chart agrees about *t*; the time bar knows what exists where | Windy has one model per view; we fuse observed + nowcast + NWP + outlook and label each |
| **T2** | **Flow-morph interpolation** — frames are moved along the wind, not cross-faded; temperature follows the Sun between frames | Smooth, physically continuous motion at any scrub speed; no ghosted fronts | Our semi-Lagrangian + Lucas–Kanade kernels already exist (`weather-flow.js`); the diurnal shape comes from the solar ephemeris |
| **T3** | **The GPU time atlas** — the whole cube resident as texture arrays; scrubbing is a uniform change | 60 fps scrub across −7 d → +14 d on a laptop | The page already ray-marches; this feeds the march from the cube directly |
| **T4** | **A time bar that shows the weather** — point meteogram in the track, provenance bands, event markers, loop/range brush, A/B swipe | The timeline answers "when does it rain here?" before you scrub | Provenance bands + skill on the track are things no consumer product shows |
| **T5** | **Physics-derived 3-D structure** — cloud bases at the LCL, precip phase at the freezing level, rain shafts and virga, snow line, geostrophic check | Clouds sit at the right height, rain falls out of them, snow is snow | Derived from the cube's own channels by closed-form physics, disclosed — not another fetch |
| **T6** | **Primary field + structural overlays** — one colour field at a time (wind / rain / temperature / clouds / pressure), the others drawn as structure; accumulations over a brushed window; tracked lows; "aurora through the clouds" | One clear picture per question, Windy-level legibility in 3-D | Space weather on the same clock: the oval × cloud cover at the scrubbed hour is ours alone |

Recommended order: **T1 → T3 → T2 → T4 → T6 → T5** (§9). T1 is the
foundation; T3 and T2 are the "futuristic engine" feel; T4 is the largest UX
win; T5 is the largest 3-D win.

---

## 1. Ground truth (read from the code, 2026-10-31)

- **Scrubber domain**: `#tc-scrub` is −10080 … +20160 minutes (−7 d … +14 d),
  matching the time-bus `PAST_MS`/`FUTURE_MS` (earth.html ≈ 4065, 14685).
- **Durable ring**: `js/weather-history.js` — 9-channel CHW coarse frames
  (T, P=MSLP, RH, U, V, cloud low/mid/high, precip mm), hourly. Observed
  tier 72 rows; forecast tier `FORECAST_CAPACITY = 14·24`. The 9-channel
  contract is shared by the validator, the worker protocol, IDB and the
  server cache — **`temp-volume-feed.js`'s header explains why new variables
  must NOT be added as channels** (it would invalidate stored rings and touch
  a dozen modules). This plan respects that: new variables are new *sources*
  in the cube, never new channels.
- **Interpolation**: `js/weather-frame-resolver.js` brackets the ring,
  decodes both frames (LRU) and **linearly lerps** into scratch Float32 trios
  at `TEX_W×TEX_H` = 360×180, then dispatches `weather-update`. Within 30 min
  of wall clock it passes the live trio through (`liveBypassMs`). The
  RK2-model → NWP handoff has a 4 h seam crossfade (`DEFAULT_SEAM_BLEND_MS`).
  Redraw throttles at 60 s of sim time.
- **Forecasters already in the browser** (`js/weather-flow.js`, 1829 lines):
  `WindAdvectionForecaster`, `WindAdvectionRK2Forecaster`,
  `MultiLevelAdvectionForecaster`, `OpticalFlowForecaster` (Lucas–Kanade),
  horizontal diffusion, convergence growth of precip, thermal wind. The RK2
  dense run is off-thread (`weather-forecast-worker.js`).
- **Pressure levels**: `temp-volume-feed.js` — 850 + 500 hPa T and wind,
  −24 h → +72 h, lazy (only when the volume layer is on).
- **Precipitation today**: channel 8 (modelled mm/h on the 5° grid), the
  `lyr-precip-rate` layer, the IMERG observation image (`lyr-obs-precip-rate`)
  and `nasa-precip-extractor.js`, which inverts IMERG's colour ramp to mm/h
  on the 72×36 grid for bias scoring. There is **no precipitation phase, no
  accumulation, and no 3-D precipitation** anywhere on the page.
- **Point ensemble kernel**: `rust-forecast/` (WASM) — a 24 h deterministic
  multi-method point ensemble (persistence, a **sun-locked** diurnal harmonic
  from `astro.rs`, AR(1), NWP, bias-corrected NWP). The sun-locking idea is
  the seed of T2's temperature interpolation.
- **Extrema**: `js/isobar-engine.js` already finds H/L centres per frame
  (`nmsExtrema`); nothing links them across frames.
- **63 layer toggles** (`lyr-*`). Seven of them are weather quantities a
  visitor would call "the weather"; they are scattered across groups.

---

## 2. Principles (additions to `EARTHVIEW_LOD_UX_PLAN.md` §3, which all hold)

1. **One instant.** Every pixel, number, chip and chart on the page reads the
   cube at the *same* scrubbed `t`. A layer that cannot answer for `t` says so
   (the `cloud-time.js` vocabulary: live / replay / nowcast / model / outlook /
   climatology / unavailable) — it never shows "now" under a past or future label.
2. **Interpolation is a model and is disclosed.** A morph between two frames
   is a claim about where the weather was in between. The time bar says
   "interpolated (flow-morph) between 12:00 and 13:00 frames" when the
   scrubber sits between frames; the A/B control (`?morph=lerp`) stays.
3. **Derived ≠ fetched.** A cloud base computed from dew-point spread is
   labelled *derived*, with the formula one click away. It is never presented
   as a measurement.
4. **The Sun is the clock's anchor, the Sun is not a weather forecaster.**
   The stellar engine gives us exact solar geometry, irradiance and space
   weather on one clock. It does **not** give tropospheric skill, and no copy
   may imply that sunspots forecast rain (§8).
5. **Scrub cost is O(1) in history depth.** Moving the scrubber never decodes
   or uploads a full frame on the main thread once T3 is in.

---

## 3. T1 — the Weather Cube (`js/weather-cube.js`, PURE)

### 3.1 What it is

A read-only facade over the existing rings — **not a new store**. Each ring
registers as a *source* with a declared coverage:

```js
cube.register({
  id: 'grid9',            // WeatherHistory
  vars: ['t2m','mslp','rh','u10','v10','cl','cm','ch','precip'],
  grid: { kind: 'global', w: 72, h: 36 },
  times(),                // sorted sample instants it holds
  provenanceAt(t),        // 'observed' | 'nowcast' | 'nwp' | 'outlook' | 'climatology'
  frame(t),               // CHW Float32 view, no copy
});
cube.register({ id: 'levels', vars: ['t850','u850','v850','t500','u500','v500'], ... }); // temp-volume-feed
cube.register({ id: 'patch',  vars: [...grid9 vars], grid: { kind: 'bbox', ... }, ... });  // weather-patch
cube.register({ id: 'clouds', vars: ['cloud_obs'], ... });   // cloud-time.js modes map to provenance
cube.register({ id: 'imerg',  vars: ['precip_obs'], ... });  // nasa-precip-extractor
```

API, all pure:

- `cube.sample(var, lat, lon, t, { alt })` → `{ value, provenance, lead, source, interp }`
- `cube.bracket(var, t)` → the two source frames and `frac` (what T2/T3 consume)
- `cube.coverage(var)` → a list of `[t0, t1, provenance]` runs — **what the
  time bar draws** (T4.2)
- `cube.series(var, lat, lon, t0, t1)` → a point time series with provenance
  per sample — **what the meteogram draws** (T4.1)
- Priority when sources overlap: patch > grid for space; observed > nowcast >
  nwp > outlook > climatology for time, with the existing 4 h seam blend as
  the one rule for model→NWP (moved from the resolver into the cube so every
  consumer gets it, not just the render).

### 3.2 What changes

- `WeatherFrameResolver` becomes a cube consumer (its bracket/lerp/seam logic
  moves into `cube.bracket` + T2). Its `weather-update` event and buffers stay
  byte-compatible until T3 retires them.
- The hover readout, the verdict card's "at scrubbed time" values, the probe
  card and the Storm Watch panel read `cube.sample` instead of each feed.
- Every time-dependent layer publishes its provenance through the cube, so the
  LOD plan's one `StatusChip` (§10.2 there) gets its mode from one place.

### 3.3 Gates

`node tests/weather-cube.mjs`: overlap priority, seam blend identical to the
resolver's current output (`assert.equal` on a fixture — the resolver's
behaviour is the oracle until T2 replaces it on purpose), coverage runs on
synthetic rings with gaps, a gap is `null` never 0 (the pollution-lab scar),
provenance never says `observed` for a forecast-tier row.

---

## 4. T2 — flow-morph interpolation (the physics between the frames)

### 4.1 The problem, in one measurement

Linear interpolation of a feature translating by `d` between frames produces,
at `frac = ½`, **two copies at half amplitude** `d` apart instead of one copy
at full amplitude `d/2` along. For a 5° grid and a 50 km/h front, `d` ≈ 1
cell per hour; for a jet-streak cloud band at 150 km/h it is 2–3 cells. The
eye reads it as flicker; a precipitation maximum halves in the middle of
every hour.

### 4.2 The fix — bidirectional semi-Lagrangian morph

For a sample at `t = t0 + frac·Δ`:

```
x_back = departure point of x traced BACKWARD along the flow for frac·Δ
x_fwd  = departure point of x traced FORWARD  along the flow for (1−frac)·Δ
value  = (1−frac) · F0(x_back) + frac · F1(x_fwd)
```

- **Flow** = the cube's own `u10/v10` lerped in time (surface fields), the
  850/500 hPa winds for cloud mid/high (the multi-level steering
  `MultiLevelAdvectionForecaster` already uses), and **Lucas–Kanade flow
  between F0 and F1** for clouds and precipitation, where feature motion ≠
  surface wind (`OpticalFlowForecaster` already estimates it). Both kernels
  exist in `weather-flow.js`; the morph imports them, it does not re-derive
  them.
- **Vectors** (`u, v`) are morphed component-wise (never as direction — the
  `weather-history.js` U/V note).
- **Conservation**: precipitation is a flux; the morph keeps the spatial
  integral within the two endpoints' (gated). MSLP is smooth and morphs
  with surface wind; its extrema then *travel* instead of blinking.
- **Fallback**: where the two flow estimates disagree by more than a
  threshold, the cell falls back to lerp and is counted (the disagreement is
  the uncertainty signal `weather-flow.js` already describes) — disclosed in
  the morph diagnostic.

### 4.3 Temperature follows the Sun between frames

Past about day 5 the underlying global models are 3- or 6-hourly (Open-Meteo
returns hourly values interpolated from them — **verify per model which hours
are native**; `models=` metadata). Lerping 2 m temperature across a 6 h gap
cuts off the afternoon maximum and the dawn minimum. The engine instead
interpolates the **anomaly from a sun-locked diurnal shape**:

```
T(t) = D(x, t) + lerp(T0 − D(x, t0), T1 − D(x, t1), frac)
D(x, t) = amplitude(x, season) · shape(solar elevation h☉(x, t))
```

- `h☉` from `js/sun-altitude.js` (the site's one sub-solar implementation —
  reuse it), so the shape is locked to real local solar time, latitude and
  season, polar day/night included.
- `amplitude` from the cube's own hindcast half (fit per cell from the
  observed-tier diurnal range) with the 1991–2020 normals
  (`js/temperature-normals.js`) as the prior — the `rust-forecast` DIURNAL
  member's idea, applied to a field.
- Cloud cover damps the amplitude (cloudy days have small diurnal ranges);
  the damping coefficient is fitted on the hindcast, not typed.
- At native hourly frames this reduces exactly to lerp (`frac` ∈ {0, 1} and
  1 h gaps make `D` nearly linear) — gated, so it cannot change the near term.

This is the honest version of "the stellar engine gives us an advantage": the
interpolation between model frames is anchored to exact solar geometry rather
than to a straight line.

### 4.4 Gates (each with a negative control)

`node tests/weather-morph.mjs`:
1. A Gaussian blob translated by 2 cells between frames: morph at `frac=½` has
   **one** peak at ≥ 0.95 amplitude at the midpoint; lerp (the control) has
   two peaks at ≈ 0.5 — the test asserts the control fails.
2. Precip integral within the endpoints' bracket; the control breaks it for a
   divergent synthetic flow if conservation is removed.
3. A sun-locked synthetic temperature sampled every 6 h: diurnal interpolation
   recovers T_max within 0.3 K; lerp misses it by > 2 K (control).
4. Native hourly frames: diurnal interpolation equals lerp to 1e-6.
5. Morph of a field with zero flow equals lerp exactly.

---

## 5. T3 — the GPU time atlas

### 5.1 Size

The coarse cube is small: 72×36 cells × 9 channels × (72 observed + 336
forecast) frames ≈ 9.5 M values ≈ **19 MB as half floats**, ~38 MB as
float32. The 850/500 levels add ~6 channels × 96 frames. All of it fits as
WebGL2 `TEXTURE_2D_ARRAY`s (one layer per frame, RGBA packing of the 9
channels into three layers-of-four).

### 5.2 Design

- The cube streams frames into the arrays as they arrive (observed ring at
  boot from IDB, forecast ring progressively as `WeatherForecastFeed`
  already walks it). Upload is per-frame, once.
- The scrubbed `t` becomes `{ layer0, layer1, frac }` uniforms. The **morph
  runs in the shader** (§4.2 traced with 2–3 RK2 substeps against the wind
  layers), so every consumer — surface tint, cloud march, wind particle
  advection, isobar texture, precip shafts — samples the same morphed field at
  full resolution with GPU bilinear. The CPU never builds a 360×180 trio
  again.
- The isobar contouring needs a CPU field: it reads the morphed coarse frame
  computed by the same kernel in JS (T2 is written once as a pure JS module
  and **transliterated** into GLSL — the `AIRGLOW_FIELD_GLSL` pattern: the
  kernel generates the GLSL text, and a node test transliterates it back and
  runs it against the kernel).
- **Fallback**: no WebGL2 / no float textures → the current CPU resolver path,
  unchanged (`?atlas=0` is also the A/B).

### 5.3 Gates

- `node tests/weather-atlas.mjs`: pack/unpack round-trip of the 9 channels
  bit-exact at float32, within half-float ulp at half; layer index ↔ time.
- `tests/weather-atlas.spec.js` (browser): a full −7 d → +14 d scrub in 200
  steps with no main-thread task > 50 ms (Long Tasks API), and the rendered
  field at three instants equals the CPU morph to within half-float tolerance
  — the control is the CPU lerp path, which must differ on the translating
  fixture.

---

## 6. T4 — a time bar that shows the weather

The bar stays **top-docked** and keeps publishing `--ev-timebar-h`
(CLAUDE.md §4.6; `tests/earth-time-controls-position.spec.js` is still the
gate). Everything below lives inside it or in a drawer it opens.

### 6.1 The meteogram in the track

Behind the scrubber's track, a 28 px strip draws `cube.series` for the
**selected location** (the verdict card's location; the cursor's location
while Shift is held): temperature line, precip bars, a wind-speed tick row,
and cloud cover as a grey band. Day boundaries and local midnight ticks; the
night half shaded from `sun-altitude.js`. Reading the bar tells you when it
rains *before* you scrub there. Colours come from the visual dial-in plan's
contract (one ramp per quantity) — this strip adds no new palette.

### 6.2 Provenance bands

Under the track, a 4 px band drawn from `cube.coverage`: observed · nowcast
(in-browser RK2) · NWP · outlook (PRESSURE / TEMP engines) · climatology.
The forecast half is dashed (LOD plan §10.6). Hovering a band names the
source, its age and its measured skill at that lead (the existing
`WeatherForecastValidator` numbers — the `#tc-skill-strip` content moves here
and the separate strip retires).

### 6.3 Event markers

A pure detector (`js/weather-events.js`) runs over `cube.series` for the
selected location and over the field for a few global events, and drops
markers on the track: **rain starts / stops, peak gust, front passage**
(T drop + wind veer + MSLP minimum within a window), **first freeze, heat
peak, deepest nearby low**, and from the space-weather side **Kp ≥ 5
windows** and **clear-sky aurora windows** (T6.4). Click a marker → the
scrubber jumps there and the camera frames it. Markers are capped and
de-duplicated by the screen-separation rule (the NEO label lesson).

### 6.4 Interaction

- **Range brush**: drag on the track with Alt (or the bracket button) to set
  `[t0, t1]`. The brush is the **loop range** for playback and the
  **integration window** for accumulations (T6.2).
- **Playback**: speed chips (1 h/s · 3 h/s · 6 h/s · 1 d/s), loop, and
  J / K / L (back / pause / forward, repeated L doubles speed — the video
  editor convention). Space and N keep their current meaning.
- **Frame snapping** while dragging slowly (a detent at each native frame),
  free while dragging fast; the time label shows "13:20 · interpolated" off a
  frame.
- **A/B swipe**: a vertical divider on the globe; left half at `t`, right half
  at `t + Δ` — or left = forecast, right = observed at the same `t` (clouds:
  mosaic vs model cloud; precip: IMERG vs channel 8). The second sample is a
  second set of atlas uniforms on the same draw; no second scene.
- **Onion skin** for isobars and fronts: the previous 3 and next 3 hours drawn
  as fading ghosts while playing, so motion reads even at low frame rates.
- **Export**: "Record loop" captures the brushed range with
  `canvas.captureStream()` + `MediaRecorder` to WebM, with the provenance
  band and source credits burned in. A share link encodes layers + camera +
  `t` + brush (LOD plan §10.5's URL state, extended with `t`/`range`).

### 6.5 The point and the column (the drawer)

Click on bare globe (LOD plan §10.3 makes this the default) → a drawer with:
- **Meteogram**: small multiples on one time axis (temperature + dew point,
  precip + phase, wind + gust, MSLP, cloud low/mid/high) — the Climate Lab
  meteogram's rules (`js/climate-lab/lab-charts.js`: never a dual axis, colour
  follows the quantity). Crosshair locked to the scrubber, both directions.
- **Time-height section**: the column over time — 1000/850/500/250 hPa
  temperature as colour, wind barbs per level, the derived LCL and freezing
  level (T5) as lines. Coarse (four levels) and labelled as such.
- **Cross-section curtain** (3-D): draw a line on the globe → a vertical
  curtain stands on it in the scene, painted with the cube's levels at the
  scrubbed `t` (temperature, wind speed, cloud from the march's own density
  function), scrubbing with everything else. This is the "3-D weather over
  time" view no 2-D product can draw.

### 6.6 Gates

`node tests/weather-events.mjs` (synthetic series with planted front, rain
onset, freeze — each detected within one frame, none in a flat control);
`tests/earth-timebar-instrument.spec.js` (meteogram strip renders the
fixture's precip hours at the right x; brush sets the loop; marker click moves
`t`; A/B halves differ on a translating fixture) — plus the existing
top-dock position gate at all five widths.

---

## 7. T5 — physics-derived 3-D structure

Everything here is computed from the cube's existing channels by closed-form
physics in one pure module, `js/weather-derived.js`, node-gated against
textbook values, and **labelled derived** in the legend.

| Field | Formula | From | Drives |
|---|---|---|---|
| Dew point | Magnus (`composite-indices.js` already has it — import, do not re-derive) | T, RH | readouts, LCL |
| **Cloud base (LCL)** | ≈ 125 m × (T − T_d) (Espy) | T, RH | the cloud march's per-cell base for the **low** deck, replacing the fixed deck altitude where the low-cloud fraction is non-zero |
| **Freezing level** | height of 0 °C by the 1000→850→500 hPa lapse | T2m, T850, T500 (levels source) | precip phase, the bright band, a translucent 0 °C surface in the stack |
| **Precip phase** | wet-bulb T near the surface + freezing-level height (snow / rain / mixed / freezing-rain risk when a warm nose sits over sub-zero surface) | T, RH, T850 | precip colour family + particle sprite (drop vs flake), snow line on terrain |
| **Rain shafts + virga** | shafts hang from the LCL; evaporation length ∝ sub-cloud dryness (T − T_d); where the shaft evaporates before the ground it is drawn as virga | precip, T, RH | a volumetric precipitation pass under the cloud march (same half-res compositor, its own density) |
| Geostrophic wind | f⁻¹ k × ∇p / ρ from MSLP, away from the equator (|lat| > 15°) | MSLP | an ageostrophic diagnostic (observed − geostrophic) for the Weather Analysis panel; a consistency check on the feed |
| Thickness-based snow line | 1000–500 hPa thickness ≈ 5400 m rule | only if geopotential heights are fetched (decision §11.4) | cross-check of the wet-bulb phase |

Design notes:
- The cloud march today places decks at fixed real altitudes through
  `atmo-scale.js`. The LCL becomes a per-cell **input** sampled from the
  atlas; `atmo-scale.js` still owns exaggeration (its single-owner rule is
  untouched — the LCL is a real altitude handed to it, never a scene radius).
- The precipitation volume rides the cloud march's compositor and the same
  governor tier (visual dial-in plan §5): floor tier = flat precip tint, mid =
  shafts without virga, top = shafts + virga + phase sprites.
- Precip phase colours: rain in the precipitation ramp, snow as a
  white-violet family, mixed as hatch — chosen and validated with the
  colour-contract procedure, never improvised.

Gates: `node tests/weather-derived.mjs` (LCL at T=30 °C, T_d=20 °C ≈ 1250 m;
freezing level on a standard-atmosphere column ≈ its analytic height; phase
table on canonical soundings incl. a warm-nose freezing-rain case; geostrophic
speed on a synthetic Gaussian low against the closed form);
`tests/earth-precip-volume.spec.js` with a negative control that pins the
cloud base back to the fixed deck and must fail the "base tracks LCL" probe.

---

## 8. T6 — one picture per question, and what only we can show

### 8.1 Primary field + structural overlays

The weather panel gets a **primary selector** — Wind · Rain · Temperature ·
Clouds · Pressure · (Snow when any snow is in range) — and exactly one of them
paints colour on the globe. The others stay on as **structure**: isobars as
lines, wind as particles (coloured by the wind ramp only when Wind is
primary, otherwise neutral), clouds as the volume, precip as shafts. This is
the visual dial-in colour contract turned into a control: one colour field,
one key, one hover unit. It is built on the LOD plan's preset doc (a primary
is a preset with one colour layer), so it syncs and URL-encodes for free.
The 63 `lyr-*` toggles stay for research mode; the primary selector is the
default surface.

### 8.2 Accumulations and windowed statistics

With a range brushed (§6.4), the primary field can switch from "at t" to
"over [t0, t1]": total precipitation (and snowfall when phase is known),
maximum gust, T_max / T_min, hours below freezing. Integrated on the GPU from
the atlas (sum over layers with the morph at each step) — the per-cell answer
is a cube query, so the hover readout and the meteogram agree with it. The
legend says "accumulated over Sat 06:00 → Mon 06:00, 48 h, from NWP".

### 8.3 Tracked lows and highs through time

Link the per-frame H/L centres from `isobar-engine.js` across frames
(nearest-neighbour with a speed cap, the pure `js/pressure-tracks.js`) and
draw each low's track as a ribbon on the globe: past solid, future dashed,
time ticks every 6 h, central pressure in the label. The current position
follows the scrubber. With ensemble data (decision §11.3), the future track
gets a spread cone. `storm-track-overlay.js` stays the tropical-cyclone layer;
this is the extratropical companion and shares its drawing conventions.

### 8.4 Space weather on the same clock — the part nobody else has

- **Aurora through the clouds**: at the scrubbed hour, P(visible aurora) =
  P(oval overhead or within the viewing margin) × (1 − total cloud cover) ×
  darkness (solar elevation < −12°). Oval from the OVATION port (visual
  dial-in plan §8) for the present and the Kp forecast for the next ~3 days
  (beyond that the layer says `unknown`, the day-view rule); clouds from the
  cube. Painted as a night-side probability field and a marker type on the
  time bar (§6.3). This is a real decision product for aurora chasers and it
  uses physics we already own end to end.
- **The coupled hindcast showcase**: the May 2024 Gannon storm night with the
  real cloud field from the ERA5 reanalysis (decision §11.5) — "who could see
  it, and who was clouded out". It reuses the Gannon hindcast assets for the
  space-weather half; the weather half is a cube source pinned to an archive
  date.
- **Honest scope**: the coupling is *visibility and impacts* (aurora,
  upper-atmosphere drag on the same clock via upper-atmosphere.html's engine,
  GNSS/HF disturbance notes), and *exact solar geometry* (T2's diurnal shape,
  insolation, terminator). It is **not** a claim that solar activity
  forecasts tropospheric weather; the copy must never say so (principle 4).

### 8.5 Beyond the 7-day window — the time machine

The cube can pin any source to an archive instant. Open-Meteo's historical
APIs (ERA5 reanalysis and archived forecasts) answer the same variable names
on the same chunked request pattern (`js/open-meteo-request.js` — the ONE
chunker; reuse it). A **date picker** next to the scrubber opens a past event
(reanalysis, labelled *reanalysis*, never *observed*), with the scrubber's
domain re-centred on that date. Server-side caching follows the
`weather_grid_cache` pattern; a total miss is 200 + `freshness:'stale'`.
Endpoints and field names are **unverified from the build sandbox**
(egress-blocked) — candidate lists + one production probe, the house rule.

---

## 9. Sequence and rough effort

| Order | Piece | Effort | Depends on | Visible result |
|---|---|---|---|---|
| 1 | T1 cube facade + resolver as consumer + readouts on the cube | 3 days | — | every number on the page agrees about *t*; provenance in one place |
| 2 | T3 atlas (CPU lerp in the shader first, identical output) | 3–4 days | 1 | smooth 60 fps scrub; no hitch at frame boundaries |
| 3 | T2 morph (JS kernel + generated GLSL) + diurnal temperature | 3–4 days | 1, 2 | fronts and cloud bands move instead of cross-fading |
| 4 | T4.1–4.3 meteogram strip, provenance band, event markers | 3 days | 1 | the time bar answers "when" at a glance |
| 5 | T4.4 brush / playback / snapping / J-K-L / A/B swipe / onion skin | 3 days | 2, 4 | an instrument, not a slider |
| 6 | T6.1 primary selector (on the LOD-plan preset doc) | 2 days | LOD plan §10.5 | one clear picture per question |
| 7 | T4.5 drawer: meteogram + time-height section | 2–3 days | 1 | the column over time at any point |
| 8 | T5 derived fields + LCL cloud bases | 2–3 days | 2 | clouds at the right height |
| 9 | T5 precipitation volume (shafts, virga, phase) | 3–4 days | 8, visual dial-in §5 | rain and snow falling out of the clouds |
| 10 | T6.2 accumulations + T6.3 tracked lows | 3 days | 2, 5 | storm totals and storm paths |
| 11 | T6.4 aurora-through-clouds + markers | 2 days | 1, visual dial-in §8 | the product only we can make |
| 12 | T4.5 cross-section curtain (3-D) | 3 days | 2, 8 | slice the atmosphere along any line |
| 13 | T6.5 archive time machine + Gannon showcase | 3–4 days | 1 + a production probe | any past date, the coupled hindcast |
| 14 | T4.4 export (WebM loop + share link with `t`/range) | 1–2 days | 5 | share a storm |

Steps 4, 6, 7 and 8 do not depend on the atlas and can run as parallel
sessions after step 1. The data-side prerequisites (LOD plan Phase 0, shipped)
are in place; the ensemble and archive items wait on decisions §11.3 / §11.5.

---

## 10. Verification summary

| Gate | Kind | Proves | Negative control |
|---|---|---|---|
| `tests/weather-cube.mjs` | node | priority, seam, coverage, gaps are null | resolver output is the oracle |
| `tests/weather-morph.mjs` | node | one peak at full amplitude; integral kept; T_max recovered | lerp must fail each |
| `tests/weather-atlas.mjs` + `.spec.js` | node + browser | pack round-trip; no long task on a full scrub; GPU = CPU morph | CPU lerp path differs on the translating fixture |
| `tests/weather-events.mjs` | node | planted events detected within one frame | flat series yields none |
| `tests/weather-derived.mjs` | node | LCL, freezing level, phase, geostrophic vs closed forms | — (analytic) |
| `tests/earth-timebar-instrument.spec.js` | browser | strip, brush, markers, A/B | + `earth-time-controls-position.spec.js` unchanged |
| `tests/earth-precip-volume.spec.js` | browser | cloud base tracks LCL; shafts end at the ground or evaporate | fixed-deck base must fail |

Browser gates run `--workers=1` on the sandbox (the visual dial-in plan §2
SwiftShader note). How any of this *looks* is unverified until it runs on a
GPU with live data (`CLOUD_LIVE=1` path).

---

## 11. Decisions that are the author's

1. **Default surface.** Primary-field selector as the default EarthView
   weather surface, with the 63 toggles behind research mode (recommended) —
   or keep the layer list as the default and offer the selector as a preset.
2. **WebGL1 / no-float devices.** Keep the CPU resolver as their path forever
   (recommended — it works today), or drop them to a reduced scrub range.
3. **Ensembles.** Open-Meteo ensemble members cost ~20–50× the bytes of one
   deterministic run. Recommend: point-only ensembles first (the meteogram
   fan and the low-track cone for the selected location), field ensembles
   only if the point version earns its keep.
4. **More pressure levels / geopotential.** Fetching 925/700/300 hPa and
   geopotential heights improves the time-height section and enables the
   thickness snow line, at roughly 2× the levels feed's requests. Recommend:
   add 700 hPa + 500 hPa height only, lazily, when the drawer opens.
5. **Archive time machine.** Worth a server-side cache + a production probe of
   the ERA5 endpoints (recommended — it is what turns EarthView into a
   reference tool and enables the Gannon showcase), or keep the scrubber at
   −7 d.
6. **Video export** — ship to everyone, or a Basic+ feature on the
   `tierAllowsSync` line (the stage-layout precedent).
7. **B2G framing** (CLAUDE.md §7): the consumer-facing items here (primary
   selector, export, aurora-through-clouds) and the operator-facing ones
   (provenance, skill on the track, archive replay, cross-sections) can be
   ordered either way. Which audience leads EarthView in 2027 is the author's
   call.
