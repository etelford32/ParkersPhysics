# EarthView — visual dial-in plan: wind · isobars · aurora · clouds · ocean & air temperature

Status: **written 2026-10-27; step 1 (the wind colour system) shipped in the
same PR.** Everything else is planned, not built. Companion to
`EARTHVIEW_LOD_UX_PLAN.md` (data, LOD framework, UX — Phase 0 shipped
2026-10-26) and `CLOUD_WIND_DEPTH_PLAN.md` (the volumetric renderer, the
exaggeration ramp, the clock). Those two own *what the data is* and *where it
comes from*; this one owns *how the layers look together*, *how fast they
draw*, and *what detail appears as you zoom* — the three things the owner
asked for on 2026-10-27: synergised, FAST, high LOD, better than Windy and
better than NASA.

The benchmark is explicit, so it is stated up front (§1). Every target in
§3–§8 is either a number a gate can measure or a decision the author has to
make (§11). Nothing here re-plans the data work; where a visual depends on
data that is not there yet, the row says which plan phase it waits on.

---

## 0. TL;DR

| Layer | What is wrong today (measured in the code) | The dial-in |
|---|---|---|
| **Wind** | Four hue families for one quantity (blue→magenta, sage→amber, violet→cyan, crimson→gold) across **five** private copies of a ramp; additive trails saturate to white at globe view; the aloft winds are a gain on the 10 m field | **Shipped:** ONE blue family (`js/wind-palette.js`) — brighter = faster, deeper = lower altitude, derived from the real altitude table. Next: energy-conserving trail compositing, barbs + streamlines at zoom, pressure-level winds on the ring (LOD plan Phase 2) |
| **Isobars** | White lines at one weight at every zoom, re-contoured only on the global 5° grid, H/L sprites; pressure→colour ramp is its own purple→orange scheme | Screen-space line weight and label density by LOD tier; regional re-contouring from the patch (LOD plan Phase 3); colour reduced to **two** roles (line + H/L markers) so the isobars read as structure over the colour layers, not as a third colour layer |
| **Aurora** | A Kp-formula oval (`max(52, 72 − Kp·17/9)` + sine ripple) drawn as a flat band + a surface glow + a shell; three painters; not the OVATION oval the homepage hero already consumes | Port the hero's **OVATION-on-the-dipole** oval (`js/hero-aurora.js`, `/api/noaa/aurora-grid`) and its physically-ordered 557.7/630.0 nm colour; curtains with height on the IGRF dipole frame; one painter |
| **Clouds** | Renderer is sound (volumetric march, half-res, sim-time advection — gates pass, see §2); the picture is limited by the **data**: no LOD, antimeridian mip seam, strips from the 5° gate | Nothing new to invent: ship LOD plan Phase 1 (seam, strips, three-tier ladder) and add the **lighting pass** this plan specifies (§6): sun-angle-correct shading at the terminator, cloud shadows on the ground at every tier, tops that read as tops |
| **Ocean temperature** | A pre-coloured NASA PNG at 20 km/px, opacity 0.35, no number under the cursor, hand-coded legend stops | Quantitative SST (LOD plan Phase 4) drawn through **the site's one temperature ramp** so sea and air temperature share a key; anomaly view; MUR 1 km texture at zoom |
| **Air temperature** | The ramp (`js/temp-ramp.js`) is already the validated diverging design; the surface tint and the 3-D volume are two separate toggles with one key | Keep the ramp. Add the **thermal LOD** (patch-resolution tint at regional tier, 0 °C line as a contour at local tier), and make SST + 2 m + the volume one temperature *family* in the panel |
| **All of them** | Six colour systems, three time semantics, one reactive governor that trades pixel ratio → bloom → cloud tier and knows nothing about the other layers | §3 the **colour contract** (one hue per quantity, one key per quantity, numbers on every key), §4 the **compositing order**, §5 the **frame budget** per tier with the governor extended to every layer, §9 the **image-metric gates** with negative controls |

---

## 1. The benchmark: what Windy and NASA do that we do not, and what we do that they cannot

Written from their public products as of 2026-10; re-check before quoting
in marketing.

### 1.1 Windy (windy.com)

- **One colour system per quantity, numbers on every key, hover value
  everywhere.** Wind is one ramp (purple-blue → green → yellow → red →
  magenta); temperature, pressure, clouds, rain each have one. The legend is
  the scale bar at the bottom and it *is* the hover readout's units.
- **Particles everywhere, at every zoom, at a constant screen density.**
  Zooming does not change the look, only the sampling. This is their
  signature and it is cheap (2-D canvas).
- **Isobars are an overlay, not a layer**: thin, screen-constant width,
  labelled inline, drawn OVER every colour layer.
- **LOD is data LOD**: global model at low zoom, regional model (ICON-D2,
  HRRR, NAM) swaps in automatically under ~4 km/px. The user never chooses.
- **Time is one scrubber**; every layer answers to it; forecast-only (no
  observation replay of clouds — their clouds are model cloud cover, and the
  satellite tab is a separate product).
- What they do **not** have: a 3-D globe with depth (it is a 2-D projected
  map), a vertical wind stack, observed clouds as a time-coherent volume,
  aurora as physics, any space-weather coupling, any honesty chip about
  source/age.

### 1.2 NASA Worldview + Eyes on the Earth + GIBS

- **Observed imagery at native resolution with a time slider** — the
  ground truth every other product samples from. Tiles to 250 m (VIIRS/MODIS)
  and 2 km (ABI); SST (MUR) to 1 km. This is the data EarthView's LOD plan
  streams.
- **Eyes on the Earth** (3-D): true-colour globe, satellite positions, a
  handful of science layers; no forecast, no particles, no vertical stack.
- What NASA does **not** have: forecast, wind particles, a fused view (every
  layer is a separate opaque image), any model/observed fusion, any
  disclosure of how layers relate in time.

### 1.3 What only EarthView can do, which is the whole point of the dial-in

1. **Depth.** The troposphere is a volume here: clouds are marched, the wind
   stack fans by real altitude, the temperature volume is a march. Neither
   competitor draws a column. Every visual decision below protects that
   advantage (nothing may flatten the stack back into decals).
2. **Observed + modelled, fused and labelled.** The mosaic is advected by
   the model wind into the near future and *says so* (`cloud-time.js`
   modes). Windy has no observation; NASA has no model.
3. **Space weather on the same globe.** The aurora oval, Kp, the
   magnetosphere hero — EarthView is the only weather globe where a G4 storm
   and a Pacific typhoon are the same picture.
4. **Honesty.** Source · age · mode chips (LOD plan 10.2) — neither
   competitor tells you a layer is yesterday's.

The dial-in is therefore NOT "look like Windy". It is: **match Windy's
clarity (one ramp per quantity, constant particle density, inline labels,
numbers under the cursor) and NASA's fidelity (native-resolution tiles at
zoom) while keeping the depth, fusion and honesty they cannot offer.**

---

## 2. Ground truth, 2026-10-27

Measured in this session on the build sandbox (software GL; NASA, Open-Meteo
and the CDN are egress-blocked, so every gate ran on the synthetic stubs).

- `node tests/cloud-time.mjs tests/cloud-mosaic-core.mjs tests/atmo-scale.mjs
  tests/wind-column.mjs tests/open-meteo-request.mjs`: **all pass**.
- Browser gates (`tests/atmo-stack-smoke.spec.js`, `tests/cloud-shells-smoke.spec.js`,
  `tests/cloud-timeline.spec.js`, `tests/wind-levels-smoke.spec.js`, and the new
  `tests/wind-palette-page.spec.js`): **they must run with `--workers=1` on the
  sandbox.** Four parallel workers booting earth.html on SwiftShader killed the
  browser session mid-test (`Protocol error … session closed`, `page.goto`
  timing out at 60 s) — a resource failure that reads like a page bug. Run
  serially, the two wind gates pass (2.1 min). The cloud gates' serial run is
  recorded in the commit that follows the wind palette. Also: `npm install`
  alone pulls a `@playwright/test` whose browser revision is not installed
  here; the runner has to match the pre-installed browser build
  (`npm install --no-save @playwright/test@<preinstalled> playwright@<same>`).
- **The cloud renderer is working as designed.** Four routes (volumetric /
  split / composite / off) pick correctly by tier + research mode; the march
  arms on sustained headroom and never on frame 1; half-res compositing,
  sim-time advection and the per-mode time semantics are gated. What the
  owner sees as "clouds not working" on production is the **data** half:
  the antimeridian mip seam, the 5°-gated strips, no detail at zoom, and —
  until Phase 0 deployed on 2026-10-26 — a month of MET Norway fallback.
  Those are LOD plan Phases 1 and 0 respectively, and the lighting work in
  §6 here. Nothing in `cloud-volume.js` needs re-tuning until it has been
  seen over a real mosaic on a GPU (`CLOUD_LIVE=1`, the only gate that sees
  how clouds look).
- **Wind colour had five copies.** `WindParticles._speedColor`, an inline
  mirror in `WindArrows`, an inline mirror in `_paintWindLegend`, and one
  closure per pressure level in `WIND_LEVEL_DEFS`, in four hue families.
  Replaced this session by `js/wind-palette.js` (§3.1).
- **Trail compositing is additive** (`THREE.AdditiveBlending` on
  `LineBasicMaterial`, vertex colours × a per-segment strength). Additive
  light sums, so at globe view the thousands of overlapping trails clip to
  white and the speed ramp is destroyed (CLOUD_WIND_DEPTH_PLAN §4 already
  dimmed per-trail brightness at far zoom for this reason; the clip is
  still reachable). The new deep-navy slow end makes the clip *less* likely
  (less energy per trail) but does not remove it.
- **The page has an HDR chain** (RenderPass → UnrealBloomPass, ACES,
  `TONE_EXPOSURE`), unlike the homepage hero's re-fitted linear pipeline
  (`js/hero-color.js`). The two were tuned independently.
- **Isobars**: marching squares on channel P (now MSLP) after a 3-pass blur,
  4 hPa, global grid only, H/L canvas sprites, one line weight. The
  `pressureToRGB` ramp (purple/blue → white → orange/red) is a third
  diverging scheme on a page whose temperature ramp is already diverging.
- **Aurora**: three painters — the surface glow in `EARTH_FRAG`
  (`u_aurora_on`), the oval shell (`AURORA_FRAG`: Kp formula + Bz kicker,
  sine + value-noise ripple, rays, pulse, substorm), and a third the
  `lyr-aurora` comment at earth.html ≈16026 names. The oval is NOT
  OVATION, while the homepage hero already draws OVATION on the IGRF dipole
  with a 557.7 nm green / 630.0 nm red altitude split (`js/hero-aurora.js`).
- **SST** is a picture (LOD plan §1.4) and **air temperature** is the
  validated `js/temp-ramp.js` diverging ramp with a 0 °C pivot, used by the
  surface tint, the 3-D volume and the legend from ONE byte array.

---

## 3. The colour contract (one system, every layer)

Principle: **one hue per quantity, one key per quantity, numbers on every
key, the same bytes on the globe and in the key.** The dataviz rules apply
(sequential = one hue light↔dark; diverging = two hues + a neutral pivot;
never a rainbow; text in text colours, never in a series colour).

### 3.1 Wind — SHIPPED 2026-10-27 (`js/wind-palette.js`, `tests/wind-palette.mjs`, `tests/wind-palette-page.spec.js`)

- **Blue.** Speed → brightness (lightness strictly increasing in speed at
  every altitude). Altitude → shade (10 m darkest navy → 250 hPa palest ice;
  strictly increasing in altitude at every speed; a √ law on the real
  altitude so the 1.5 km step to 850 hPa is a visible step). Hue drifts
  indigo-ward at the ground and cyan-ward aloft, all inside 185–245°, so a
  fast surface wind and a slow jet never coincide exactly even though both
  axes lift lightness — and the levels are separated in geometry and by
  arrow/trail length regardless (the CVD rule in `wind-column.js`).
- **One function, no mirrors.** The trails, the arrows, the profile columns
  and all four legend canvases call it. The live instances' ramps are
  probed through `window.__evWindStack().ramp` and compared to the module
  in the browser gate, so a private copy cannot return.
- **Disclosed** under the key (`#wind-palette-note`): "Blue = wind.
  Brighter = faster. Deeper shade = lower altitude".
- Still to do in this family (§7): the **compositing** (3.1a) and the
  **constant screen density** (LOD plan Phase 2.3).

**3.1a Energy-conserving trails.** Additive blending is kept (it commutes,
so the camera may descend through the stack), but the sum must not clip:
render the four trail layers into the HDR target (they already are, before
the bloom) and apply a soft-knee on the *trail* contribution before the ACES
curve — the hero's `heroTone` shoulder — so dense regions saturate to the
*pale* end of the blue family, not to white. Gate: a solo trail render at
globe view; the 99th-percentile pixel must stay inside the palette's hue
band (negative control: the raw additive path, which goes achromatic).

### 3.2 Temperature — ONE family for air and sea

- `js/temp-ramp.js` stays the ramp (validated, 0 °C pivot, lightness
  monotonic per arm). **SST adopts it** when the quantitative SST field
  lands (LOD plan 8.1): sea and air temperature are the same quantity in
  the same key; the only difference is the mask. The NASA MUR *picture*
  stays available as "NASA MUR imagery" with its own palette, off by
  default.
- The anomaly view (SST − normal, 2 m − normal when the 1991–2020 normals
  are wired through `js/temperature-normals.js`) is **diverging about 0 K**
  with a neutral grey pivot, a *different* ramp from absolute temperature
  so the two can never be confused; rank "unusual" by rarity
  (`PLANETARY_TEMPERATURE_LAB_PLAN.md` rule), never by raw ΔT.

### 3.3 Pressure / isobars — structure, not colour

- Isobars become a **monochrome structural overlay**: one ink (the page's
  text-primary at ~60 % over colour layers, 85 % on the clean globe), two
  weights (every 4 hPa thin, every 20 hPa heavier), inline labels in text
  colour. H/L markers keep a *two*-colour status (blue L / red H — the only
  colour the layer carries) with the central value printed.
- `pressureToRGB` is retired from the lines (kept for the probe card's
  pressure readout chip if anything still reads it). A coloured-line
  isobar over a coloured temperature field is two colour encodings fighting
  — Windy draws isobars in one ink for this reason.

### 3.4 Clouds — luminance, not colour

Clouds carry **no hue of their own** beyond what the light gives them: white
tops, sun-coloured at low sun angle, blue-grey in shadow, the planet's
night-side blue in earthshine. The IR-derived top height is drawn as
*height*, never as a colour ramp (the EUV channel rule on sun.html: observed
structure, model light). Research mode keeps its measured-only alpha and
may show the IR top as a colour ramp *there* with a key.

### 3.5 Aurora — physically ordered colour

Green (557.7 nm) low, red (630.0 nm) above ~200 km, purple/blue lower-border
on strong electron precipitation (427.8 nm N₂⁺) — the hero's ordering,
driven by the precipitation energy OVATION reports, not by Kp. Brightness
is OVATION's probability drawn as √(p / 30 %) and disclosed; the Kp ring is
the fallback on a dead feed (`js/hero-aurora.js`'s `_applyAurora` rule: a
replayed model storm never wears today's observed oval).

### 3.6 Status / category / attention colours are reserved

Amber = stale, red = down, green = live, grey = reference/climatology; a
selection ring is one colour; alerts use the alert palette. None of these
may be used for a data value, and the wind family's blue is not the status
green/amber/red's blue.

---

## 4. Compositing order and the one tone pipeline

Today's draw order is by `renderOrder` constants scattered through
earth.html (trails 3.0–3.3, arrows 3.35, columns 3.4, aurora 4, temp volume
5, …). The dial-in fixes the order *as a contract* and writes it in one
table (`js/earth-layer-order.js`, PURE, node-gated against the live
`renderOrder` values via a page probe):

```
ground      base texture → SST / temperature tint → precip / AQ / obs images → cloud SHADOW
structure   isobars (screen-space lines, depth-tested against the ground only)
volume      cloud march (premultiplied, front-to-back) — or the decal fallback
stack       wind trails sfc → 850 → 500 → 250 (additive, into HDR), arrows, columns
outer       aurora curtains → stratosphere haze → atmosphere rim
post        bloom (threshold re-fitted) → tone (ACES or the hero's PBR-Neutral shoulder) → sRGB → dither
```

Rules:

1. **Everything that is light adds; everything that is data blends.** Trails,
   aurora, glints add. Tints, images, clouds blend premultiplied. A layer in
   the wrong class is a bug (a tint drawn additive over the day side goes
   white; a trail drawn alpha goes grey).
2. **One tone curve, fitted once, with bloom threshold re-fitted against it**
   (the hero's lesson: a linear halo reads wider; threshold 0.214, strength
   0.75 there — re-fit here, do not copy). `?hdr=0` stays the fallback.
3. **Clouds shadow the ground at every tier**, not only at `q > 0.83`
   (today `u_cloud_shadow` is tier-gated). The shadow is what makes a cloud
   read as *above* the surface — it is the cheapest depth cue on the page
   and is currently the first thing the governor drops. Make it a 1-tap
   shadow at the floor tier and 6 taps at the top tier instead of 0/6.
4. **The order does not change with zoom.** LOD changes resolution and
   budgets (§5), never which layer is over which.

---

## 5. FAST: the frame budget and the governor

Target: **16.7 ms at the top tier on a 2020 integrated GPU at DPR 2**, 33 ms
at the mid tier, and *never* a frame over 100 ms at the floor tier
(SwiftShader, phones). Measured per layer on the governor's own EMA.

| Tier (today's `_cloudQIdx`) | Pixel ratio | Clouds | Wind | Isobars | Aurora | Temp | Insets |
|---|---|---|---|---|---|---|---|
| 0 top | cap | march 48 steps, half-res | 4 levels, full density, columns | regional re-contour | curtains + oval | volume march | all tiers |
| 1 mid | −0.25 | march 28 steps | 2 levels, 0.6 density | global grid | oval only | surface tint | tier B only |
| 2 floor | floor | composite decal | 1 level, 0.35 density, no arrows | global, no labels | oval, no rays | surface tint | none |

Changes to make this real:

- **Extend `_governResolution` to every layer.** Today it trades pixel ratio
  → bloom → cloud tier; wind already reads `_cloudQIdx` for its level cap.
  The LOD-plan view-level kernel (§9.1 there) becomes the *input*; the tier
  table above becomes the *output*, published once per change on a
  `ev-quality` event every layer subscribes to. No layer reads the
  governor's internals.
- **Per-layer cost probes.** `EXT_disjoint_timer_query_webgl2` where
  available, else wall-clock bracketing per render group, surfaced in
  `window.__evFrameBudget()` so a gate can say *which* layer blew the
  budget. Without this, "it's slow" has no owner.
- **Trails on the GPU.** The particle advection is JS (6000 + 4000 × 3
  particles, per frame, bilinear lookups + a 20–34-segment ring buffer
  rebuilt into a position/colour attribute). Move advection to a transform
  feedback / ping-pong texture pass (WebGL2) with the JS path kept as the
  WebGL1 fallback. This is what unlocks Windy's constant on-screen density
  at every zoom (LOD plan Phase 2.3) without a CPU budget.
- **Boot**: the LOD plan's never-black boot (10.1) — boot texture tier,
  dismiss `#loading` on the first textured frame, stage requests. Cheap
  and the single largest perceived-speed win.
- **Worker the contouring.** Marching squares + blur on every
  `weather-update` runs on the main thread; at patch resolution it will
  not. Move it to `js/weather-forecast-worker.js`'s sibling.

---

## 6. HIGH LOD: what each layer shows as you zoom

The LOD framework is the LOD plan's Phase 5 (`js/earth-view-level.js`,
the shared tile streamer, the governed request budget). This section says
what each layer *draws* at each tier once that exists, and which pieces can
land before it (marked ◇).

| Tier | Wind | Isobars | Clouds | Temperature / SST | Aurora |
|---|---|---|---|---|---|
| **orbit** > 1.5 R | trails, 4 shades, constant screen density ◇ | global, 4 hPa, no labels; H/L only | global mosaic, march; shadow ◇ | 5° tint; SST 0.25° field | OVATION oval + curtains ◇ |
| **regional** | + arrows; patch field (0.25–1°) feeds the trails ◇ (exists for sfc) | patch re-contour, 2 hPa where supported, inline labels, tendency arrows | Tier B: ABI 2 km tiles in the volume AND the decal | patch tint; 0 °C line as a contour; SST MUR 1 km texture, OISST value | curtains with height on the dipole frame |
| **local** < 0.16 R | barbs + streamlines from the patch; columns ◇ (exist) | labels every N px of arc; H/L with value + tendency | Tier C procedural octaves, disclosed "below 2 km is synthesized" | 2 m station values (the lab's own feed) as pinned readouts | — (an oval is a global object) |
| **ground** | the surface view (LOD plan 10.4): horizon camera, barbs at the horizon, a hover readout that is the *verdict card's* numbers | — | the sky from below: the march's own column over the camera (the upper-atmosphere transit rule — a camera-local cloud, disclosed) | — | curtains overhead from below (upper-atmosphere explore's curtain geometry, reused, not copied) |

Two rules from the sibling pages that apply unchanged: **LOD is driven by
camera distance / footprint, never by what the LOD changes** (the Mars
`regionalReliefScale` trap), and **a tier is a higher-resolution sample of
the same quantity, never a re-tuned one** (LOD plan §9.4).

### 6.1 Cloud lighting (the renderer work this plan adds)

The march's light model is physically shaped (HG dual lobe, Wrenninge
octaves, powder, planet shadow) and was tuned at the terminator over a
synthetic mosaic. Three things make clouds *read* as clouds and are not yet
there:

1. **Sun-coloured low-angle light.** The sun is white at every elevation
   today. Tint the light by a Rayleigh-attenuated path length at the cloud
   top (one `exp(−τ(μ))` with the same optical depth the atmosphere rim
   shader already carries) so dawn/dusk tops go gold → copper and the
   terminator stops being a grey ramp.
2. **Earthshine + city light on the night side.** The night hemisphere's
   clouds are black today; real ones are faint blue-grey (moonlight is out
   of scope) and glow faintly over cities. Ambient = night-sky blue × a
   small term + the city-light texture sampled below the column (the
   texture is already on `u_night`).
3. **Shadow at every tier** (§4 rule 3) and a **terminator-aware shadow
   length** (the cylinder shadow is already soft; make its length ride the
   drawn exaggeration so shadows stretch at low sun).

Gate: `tests/earth-image-metrics.spec.js` (the LOD plan's new gate) gains a
*lighting* case: a solo cloud render along the sun vector must have top-vs-
base luminance ratio > 1.8 and a terminator cloud's chroma must be warm
(b* < 0 in Lab), with the white-sun shader as the negative control.

---

## 7. Wind — the rest of the family (after the colour step)

| # | Item | Depends on |
|---|---|---|
| 7.1 | **Energy-conserving trails** (§3.1a) | — |
| 7.2 | **Constant screen density**: particles per 1000 px² constant across zoom; GPU advection (§5) | — (JS path first, GPU second) |
| 7.3 | **Barbs + streamlines at local tier** from the patch field (speed legible on a still frame) | LOD plan Phase 2.2 |
| 7.4 | **Pressure-level winds on the ring** so all four levels scrub coherently and `windGainAt` retires | LOD plan Phase 2.1 |
| 7.5 | **Hover readout** on the wind layer by default (10 m + enabled levels, m/s · km/h · kt · bearing) — the `#` opt-in badge goes | LOD plan 10.3 |
| 7.6 | **Profile columns pickable** → the probe card | CLOUD_WIND_DEPTH_PLAN §7 |
| 7.7 | The per-level key rows show **altitude** ("850 hPa · 1.5 km") beside the speed ticks — the shade axis needs its number as much as the speed axis does | — (one line) |

---

## 8. Aurora — one painter, physics-ordered

1. **Port the hero oval.** `js/hero-aurora.js` already: dipole frame from
   `js/geomag/dipole.js` (IGRF-14), OVATION per-azimuth colatitude +
   intensity from `/api/noaa/aurora-grid`, curtain direction mirrored
   from the engine, the Kp ring as the dead-feed fallback, and the
   "replayed storm never wears today's oval" switch. EarthView gets the
   same module through the same seams — never a copy.
2. **Curtains with height** on the outer-shell radius `atmo-scale.js`
   already lifts the aurora to (above the marched volume; 1.019 → ~1.026),
   with the 557.7 / 630.0 nm split by altitude and a lower border on
   strong precipitation.
3. **Retire two of the three painters.** The surface glow in `EARTH_FRAG`
   (`u_aurora_on`) stays as the *ground* illumination the curtains cast; the
   sine-ripple band shell goes once the curtains draw.
4. **The night mask stays** (dayside discard) and the quiet-period rule stays
   (the oval is visible, dim, at Kp < 1.5 — a toggle that does nothing is
   read as broken).

Gate: `tests/earth-aurora.spec.js` (new) serves the synthetic OVATION grid
`tests/fixtures/ovation-synthetic.mjs` and asserts the drawn colatitude
against the grid per azimuth, the colour ordering by altitude, and the
fallback ring on a dead feed; negative control = the old Kp-formula band.

---

## 9. Verification — every visual claim becomes a number

The rule from the upper-atmosphere image-metrics gate: **a threshold without
a negative control is a guess.** Every gate below carries one.

| Gate | Kind | What it measures | Negative control |
|---|---|---|---|
| `tests/wind-palette.mjs` ✔ shipped | node | monotone luminance in speed and altitude; hue in band; closure ≡ direct | — (pure) |
| `tests/wind-palette-page.spec.js` ✔ shipped | browser | live instances + arrows + 4 legend canvases read the module | a stale private ramp (would fail the probe compare) |
| `tests/wind-compositing.spec.js` | browser, solo render | p99 pixel stays in the blue band at globe view | raw additive path |
| `tests/earth-image-metrics.spec.js` (LOD plan) | browser, `gl.readPixels` | antimeridian seam contrast; stripe autocorrelation; cloud top/base ratio; terminator chroma | gradient-free shader; current decode; white-sun shader |
| `tests/earth-layer-order.mjs` + page probe | node + browser | the compositing table matches live `renderOrder` | — |
| `tests/earth-frame-budget.spec.js` | browser | per-layer cost from `__evFrameBudget()` under each tier; floor tier never > 100 ms on SwiftShader | — (a measurement, reported, not asserted on hardware the sandbox lacks) |
| `tests/earth-aurora.spec.js` | browser, synthetic OVATION | drawn colatitude per azimuth; colour by altitude; dead-feed ring | Kp-formula band |
| `tests/isobar-engine.mjs` (LOD plan) | node | MSLP contours; label spacing; H/L values | — |
| `CLOUD_LIVE=1 … --headed` on a GPU | live | **the only gate that sees how it looks** | — |

Every screenshot gate in the sandbox runs on SwiftShader over synthetic
stubs. **Nothing about how these layers look is verified until the live
gate has run on a GPU** — the plan's own §2 says so and this one repeats
it on purpose.

---

## 10. Sequence

Ordered so each step is visible on its own and nothing waits on the big
framework unless it must.

| Order | Step | Effort | Depends on |
|---|---|---|---|
| 1 ✔ | Wind colour system (`js/wind-palette.js`, gates, key disclosure) | done | — |
| 2 | Wind compositing (7.1) + per-level altitude on the key (7.7) | 1 day | — |
| 3 | Never-black boot + one status chip (LOD plan 10.1, 10.2) | 1–2 days | — |
| 4 | Cloud seam + strips + one cloud field (LOD plan 5.1, 5.2, 5.4) | 2–3 days | — |
| 5 | Cloud lighting pass (§6.1) + shadow at every tier (§4.3) | 2 days | 4 (to judge it on real pixels) |
| 6 | Isobars as structure (§3.3) + MSLP labels/H-L (LOD plan 7.3) | 2 days | — |
| 7 | Aurora port (§8) | 2 days | — |
| 8 | View-level kernel + tile streamer + governor extension (LOD plan 9; §5 here) | 3–4 days | — |
| 9 | Cloud LOD ladder (LOD plan 5.3) | 3–4 days | 4, 8 |
| 10 | Wind density + GPU advection + barbs (7.2, 7.3) | 3 days | 8 |
| 11 | Quantitative SST through the temperature ramp + anomaly (§3.2, LOD plan 8) | 3–4 days | 8 + a networked-machine probe |
| 12 | Temperature LOD (patch tint, 0 °C contour) | 1–2 days | 8 |
| 13 | Compositing contract + one tone pipeline (§4) | 2 days | 2, 5, 7 (so it is fitted against the final layers) |
| 14 | Frame-budget probe + per-layer governor (§5) | 2 days | 8, 13 |
| 15 | Surface view + hover readout + presets + URL state (LOD plan 10.3–10.5) | 4–5 days | 8 |

Steps 2–7 are independent of the framework and of each other; they can be
parallel sessions. Steps 9–12 wait on 8.

---

## 11. Decisions that are the author's

1. **The wind family's dark end.** The shipped surface ramp starts at a
   deep navy (luminance 0.05). Under additive blending a calm is therefore
   *dim*, which reads as calm — but on the lit day side a 2 m/s field is
   now close to invisible where the old pale-blue start was always
   visible. The alternative is a lighter floor (≈ 0.12) at the cost of less
   shade separation from the jet. Recommend: keep the navy, and let the
   trail compositing (step 2) and the hover readout carry the calm case.
2. **ACES vs the hero's PBR-Neutral shoulder** for the one tone pipeline.
   ACES desaturates highlights toward white (which is what clips the trails
   today); PBR-Neutral is hue-preserving. Recommend PBR-Neutral, re-fitted
   here, with `?tone=aces` as the A/B.
3. **Isobar ink.** One ink over everything (recommended; Windy's reading),
   or keep a faint pressure colour on the heavy lines only.
4. **Aurora curtains by default** at orbit tier, or oval only (curtains cost
   a draw and read as a halo from far away). Recommend: oval at orbit,
   curtains from regional tier.
5. **GPU particle advection** — WebGL2 transform feedback (cleaner) vs a
   ping-pong float texture (works where TF is flaky on mobile). Recommend
   ping-pong; it is also what Windy's WebGL renderer does.
6. **Default-on layers at boot** (LOD plan §13.6): clouds + wind + isobars
   + SST recommended; everything else one tap away. Fewer layers at boot is
   the single cheapest speed win after the boot texture.
