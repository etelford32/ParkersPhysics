# Upper Atmosphere Simulator — showing the atmosphere

Status doc for the visual + on-canvas-analysis layer of `upper-atmosphere.html`.
Read this before touching `js/upper-atmosphere-{column,volume,instruments}.js`.

---

## 1. What changed and why

The page always had a real density model — `upper-atmosphere-engine.js`, a
Bates T(z) profile with per-species diffusive equilibrium, mirroring the
DSMC pipeline's Python. What it did not have was a **rendering of that
model**. The atmosphere was drawn as five discrete spheres, each shaded a
flat per-layer colour by the local ρ at its own mid-altitude, with hard
boundaries at 85 / 250 / 600 / 1200 km.

Two things were wrong with that, and both are physics rather than taste:

1. **The boundaries are names, not features.** 85 km is where we start
   calling it the thermosphere. Nothing happens there. Drawing a hard edge
   at a naming convention makes the render assert a structure the model
   does not contain.

2. **Limb brightening is geometric and a per-layer shader cannot produce
   it.** A ray tangent at 400 km traverses ≈1600 km of equivalent local
   atmosphere — about 27 scale heights — because the geometry stretches
   the exponential into a √(2πrH) chord. That factor *is* the bright band
   around the edge of every photograph of Earth from orbit. Shading by
   local ρ gives you a ring of constant brightness instead, which is why
   the old render read as concentric sci-fi rings.

The fix is to integrate the column and to let the model's own asymmetry
show. Three new modules:

| module | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-column.js` | PURE kernel: the T∞ field, the column integrals, the airglow layers, the renderer's LUTs | `node tests/upper-atmosphere-column.mjs` (51 assertions) |
| `js/upper-atmosphere-volume.js` | the continuous volumetric renderer | `npx playwright test tests/upper-atmosphere-volume.spec.js` |
| `js/upper-atmosphere-instruments.js` | the on-canvas ruler / limb probe / diurnal compass | same spec |

---

## 2. Load-bearing decisions

### 2.1 There is still exactly ONE density model

The kernel never re-implements density. It computes a **T∞ field** —
scalar exospheric temperature varying with local solar time, latitude and
magnetic activity — and feeds it back into the engine's own `density()`
through a new optional `TinfK` argument. Composition, scale heights, the
heavy/light differential expansion when a storm inflates the thermosphere:
all still the engine's.

If you find yourself writing a barometric exponential in the kernel, stop.

### 2.2 Both spatial terms are area-mean-preserving

- The Jacchia-71 diurnal ratio is divided by **its own global area
  average** (exact quadrature, cached per solar declination).
- The auroral term has **zero area mean** by construction, because the
  engine's `3·Ap` already carries the global geomagnetic response and a
  second positive Ap term here would double-count it.

So turning the field on moves **no number the page already reports**. It
only says where that number is high and where it is low. Two tests gate
this. If a future session wants the global mean to move, that belongs in
`exosphereTempK`, not here.

### 2.3 Density and airglow are separate claims and must stay separate

Above 80 km there is essentially no Rayleigh scattering. The neutral
atmosphere **emits no visible light of its own**. So:

- the **density** render is a data visualisation of ∫ρ dl, and the legend
  says you could not see it;
- the **airglow** render is the emission layers at their observed
  altitudes, and that is what an eye actually records.

They are independently toggleable and separately coloured. Merging them
into one prettier term would make the page imply that the first is a
photograph. Don't.

### 2.4 The display transform is disclosed, always

The column spans **ten decades** from an 80 km tangent ray to a 1950 km
one. Brightness is `((log₁₀(column/column_ref) + D)/D)^γ` over D display
decades — the same log axis the page's own density plot uses, so render
and plot agree by construction. `getScaleInfo()` reports D and γ and the
legend prints them.

### 2.5 The shader mirrors the kernel; the kernel is the oracle

`VOLUME_FRAG` re-implements three kernel functions in GLSL:
`geoFromVectors`, `jacchiaDiurnalRatio`, `auroralHeatingK`. Change one,
change the other in the same commit, and re-run the node test — which
checks the JS version against an independent derivation, so the GLSL
inherits a verified answer rather than a second guess.

---

## 3. Measured rejections — do not re-litigate without re-running these

Each of these was built the "obvious" way first and measured worse.

### 3.1 Importance sampling is worse than uniform sampling (CPU)

Quadratic node spacing about the tangent point is textbook importance
sampling for an exponential integrand. Measured against a 6000-step
reference:

| tangent alt | uniform-64 | quadratic-64 |
|---|---|---|
| 85 km | 0.003 % | 0.163 % |
| 100 km | 0.011 % | 0.159 % |
| 400 km | 0.000 % | 0.050 % |

Euler–Maclaurin: the integrand decays smoothly to zero at both ends with
all its derivatives, so equally spaced trapezoid loses its boundary terms
and converges superalgebraically. Unequal spacing destroys that and drops
back to O(h²). `rayColumn` therefore marches **uniformly**.

### 3.2 …but the SHADER samples quadratically anyway, for a different reason

The shader is not trying to be accurate, it is trying not to **alias**.
The visible airglow band is 10 km FWHM; a limb ray crosses the volume in
~10 000 km, so uniform 64-step sampling lands ~160 km apart and the band
strobes as the camera moves. Tangent-centred quadratic spacing puts the
near-tangent samples ~5 km apart. A 0.2 % quadrature error behind a log
display stretch is invisible; a flickering airglow band is not.

**The two schemes differ on purpose and the reason is per-consumer.**

### 3.3 asinh is the wrong stretch here

The standard astronomical asinh stretch is built for a few decades above a
noise floor. At every gain that kept the limb from clipping, everything
above ~200 km mapped to pure black and the render was a hard white ring on
nothing. Replaced with the log stretch in §2.4.

### 3.4 Normalising the stretch at 150 km clipped a 70 km white band

The reference is now the model floor — the brightest ray the render can
produce — so nothing clips.

### 3.5 VER-weighted airglow colour comes out ORANGE

OH Meinel outshines every other airglow layer by an order of magnitude in
total photons, and ~98 % of that is at 1.5–2.0 µm. Layers therefore carry
a `visibleFraction`, and the display colour is weighted by **visible**
photons. Weighted that way the band is green-dominant at 92–105 km over a
dim red-brown base at 87 km, which is what it looks like in astronaut
photographs. `airglowAt` returns both `total` (physical) and
`visibleTotal`, plus `rgb` (visible) and `rgbPhysical`.

### 3.6 A column-average colour washes out the composition

The density term takes its colour from the ray's **lowest point**, so the
stratification (N₂/O₂ blue → atomic-O amber → He pink → H yellow) is
visible. The airglow term takes its colour from the **emission-weighted
integral**, because its band is one or two pixels at whole-globe framing
and what a camera records there is the integral. Both are argued in the
module header.

### 3.7 Shipping the ladder's middle rung as the default broke CI

The march is expensive on a software rasteriser. Measured at 1280×720,
whole-globe framing, median of five interleaved runs:

| render | ms/frame |
|---|---|
| old five shells (what this replaced) | 355 |
| march @ 28 steps (**the first default**) | 1760 |
| march @ 16 steps | 1311 |
| march @ 10 steps, field hoisted (**shipped**) | 462 |

A 1.8 s frame does not merely look bad — it saturates the main thread. The
DSMC end-to-end suite, which had been running **all five of its tests in
43 s total** on main, started blowing a **60 s per-test** budget, because
the harness's own polling was starved. Three tests failed; one passed only
on retry.

Two fixes, both of which had to land:

1. **The ladder starts at its floor and climbs** (`QUALITY_LADDER`,
   `_governQuality`). Same shape as the cloud-volume governor in
   earth.html and for the reason recorded there: a weak renderer that
   enters the expensive path on frame 1 can starve the very re-evaluation
   that would demote it. `setQuality()` PINS the ladder so an explicit
   choice cannot be walked back mid-run.

2. **The T∞ field is evaluated ONCE PER FRAGMENT, not per sample.** It was
   two `pow()`, an `atan()`, an `asin()` and an `exp()` on every one of up
   to 96 samples. A limb ray's column is concentrated within ±√(2rH) ≈
   ±900 km of its tangent point — about 8° of arc, half an hour of local
   solar time — over which the Jacchia term moves well under a percent, so
   holding it is a good approximation and not a shortcut that changes what
   is drawn. Worth 1126 → 462 ms/frame at the floor.

The governor **times itself** rather than taking the `dt` from the globe's
animate loop. See §6.

`tests/upper-atmosphere-volume.spec.js` gates the starting rung. That test
is the regression gate for this whole section; do not "optimise" it by
raising the default.

### 3.8 The anomaly view cannot read at the ray's lowest point

That was the first implementation and it produced a flat wash. Below
~120 km the engine's density does not depend on T∞ at all — turbulent
mixing clamps it — so the local/model ratio is exactly 1.00 for every ray
that reaches down there, which is most of the bright inner ring. It now
reads at the altitude the operator has selected, which is also the better
question: the view is asking *where* the drag multiplier is high, so
confounding it with each ray's tangent altitude is the wrong axis.

### 3.9 γ = 1.45 crushed the exosphere

Measured displayed brightness at D=10, γ=1.15, gain 0.90: 80 km → 0.90,
400 km → 0.34, 1000 km → 0.13, 1950 km → 0.02. That ramp is the halo.

---

## 4. The auroral term is a parameterisation and the page must not claim otherwise

A Gaussian in magnetic latitude: centre 67°, width 13°, amplitude
saturating in Ap. The centre and width track the statistical auroral oval;
the amplitude is anchored so the isolated auroral density enhancement at
400 km reaches ~1.6–1.7× at strong-storm Ap, the conservative end of what
was inferred during the May-2024 Gannon storm.

**It is not MSIS.** The magnetic latitude is a centred-dipole coordinate,
not a field evaluation — `js/geomag/igrf.js` remains the site's single
source of truth for field values, and this is deliberately not that.

The enhancement is **not monotonic in Ap**: it peaks near ap ≈ 200 and
eases at ap ≈ 400, because the scale height grows with T∞ and heating
loses leverage (dρ/ρ ≈ (z−z₀)/H · dT/T). Absolute density keeps rising
throughout. That is physics, not a fit artefact, and the test asserts it
so nobody tunes it away.

---

## 5. The on-canvas instruments

The side panel already reports the global model: one ρ, one T, one Kn, at
one altitude — the spherically symmetric answer. The whole point of the
volumetric render is that the atmosphere is *not* spherically symmetric,
and the operator's real question ("what is the density where my spacecraft
is") is a question about a **place**. A place is something you point at.

- **Altitude ruler** — ticks at 100/200/400/800/1200/2000 km hung on the
  actual limb. Ticks sit at the true radius; only the *labels* are pushed
  apart to a measured minimum separation, with leaders, because at
  whole-globe framing 100/200/400 land a few pixels apart.
- **Limb probe** — tangent altitude, ρ local **and** ρ model as two
  separate rows (they are different claims; one number would hide which),
  their ratio as the local drag multiplier, T/T∞, the column, the limb
  path equivalent, Kn and regime, plus a mini ρ(z) profile with the
  tangent altitude marked and the airglow band overlaid.
- **Diurnal compass** — sub-solar meridian, the bulge (which lags it by
  ~2 h), and the day/night density ratio at the selected altitude.

`upper-atmosphere-instruments.js` **does not import three.js**. It takes
three geometry hooks from the globe (`projectToScreen`, `probeScreenRay`,
`limbTicks`) and everything else from the pure kernel, so every number it
prints traces to a node-tested function. Keep it that way: if you need a
`Vector3` in there, add a hook to the globe instead.

### 5.1 Two disclosures the probe must never lose

- A ray can pass **above** the modelled band. The engine does not
  extrapolate above 2000 km, so the sample clamps to the ceiling — and the
  card says `ABOVE THE MODEL / ceiling values` rather than printing 2000 km
  physics beside a 3472 km tangent altitude. (Found by the browser gate.)
- **Below 120 km the engine's density does not depend on T∞ at all** —
  turbulent mixing clamps it — so `local / model` is exactly 1.00 down
  there. Without the note it reads as a dead instrument.

### 5.2 Layout constraints that were each a bug

- The overlay canvas is `pointer-events: none`. OrbitControls and the
  raycaster both listen on the WebGL canvas underneath; an overlay that
  swallowed pointer events would kill orbiting. Gated.
- The probe card avoids **every** piece of page chrome over the canvas,
  measured live from the elements. The camera HUD's time-warp row spans
  nearly the full width, so when the pointer is up there no near-cursor
  placement is clean and the card parks, joined by a leader.
- The legend and control row are lifted above the time scrubber via
  `--ua-atmo-floor`, measured from the scrubber's own height. Anchored to
  `bottom: 14px` they drew *on top of* it at 1280×720.
- Labels are not `text-transform: uppercase`: CSS uppercases `ρ` to a
  capital rho, drawn identically to a Latin P, so the button read
  "P COLUMN".

---

## 6. A pre-existing bug this work sits on top of, NOT fixed here

`_animate` in `js/upper-atmosphere-globe.js` does:

```js
const t  = this._clock.getElapsedTime();
const dt = this._clock.getDelta();
```

three.js's `Clock.getElapsedTime()` **calls `getDelta()` internally**, so
the second call returns the microseconds since the first. Measured: `dt`
is `0.0000` ms on essentially every frame. Every consumer of that `dt` on
this page — the layer particle systems, the drag-forecast tracer
advection, the substorm state machine, `controls.update(dt)` — is being
fed ~zero and is not advancing at the rate its code assumes.

It is **not fixed in this change** on purpose: correcting it would make
several animations across the page suddenly run at their intended speed
for the first time, which is a visible behavioural change nobody asked for
and a poor thing to smuggle into a rendering PR. It is written down here
so the next session finds it rather than rediscovering it.

The volume's quality governor therefore reads its own clock. A governor
that silently never ticks is worse than no governor.

## 7. Also fixed here

`SUN_FRAG` in `upper-atmosphere-globe.js` declared a variable named
`active` — a **reserved word in GLSL ES**. The shader had never compiled
and the Sun had been rendering on three.js's error-fallback material since
it shipped. Nothing in the page's own output said so. The browser gate now
asserts zero WebGL errors, which is how a failure like that gets caught
rather than lived with.

---

## 9. 2026-09-27 — ONE frame, and the flight layer

### 9.1 The page's longitude was mirrored against the continents

`_subSolarToVec3` in the globe mapped lon → `z = +cos·sin(lon)`, and the LST
oracle (`geoFromVectors`, its GLSL mirror), the drag-flow tracers, the fleet
ribbons and the MLT helper were all written against that. The EarthSkin
texture is drawn through `js/geo/coords.glsl.js`, whose frame puts +90°E at
**−Z**, and the SGP4 catalogue cloud uses the same. So the terminator and the
diurnal bulge sat at −lon over the continents — local noon drawn over India
at 18 UTC — and every still frame looked plausible.

**There is now ONE mapping**, `latLonToScene` / `sceneToLatLon` in the column
kernel, and every lat/lon → scene on the page goes through it (the sun vector,
the drag overlay, the ribbons, the MLT helper). The hour angle is measured
about +north; `tests/upper-atmosphere-column.mjs` gates the sign AND proves
the mirrored frame fails the gate (reads 6 h where the oracle says 18 h).

The reference probes (ISS, Hubble, Starlink, Iridium, Tiangong), the debris
sample and the Walker constellations had a second version of the same bug:
`_propagateKeplerian` returned ECI axes as scene axes with the y/z swap
mirrored and **never turned by the sidereal angle**, so the orbits sat still
over a planet that does not. They are now `[x, z, −y]` (coords.js at GMST 0)
rotated by −GMST(sim clock) about +Y (`_eciSceneToEarthFixed`; the orbit-path
loops get `rotation.y = −gmst`). Conjunction distances read the un-rotated
lookup tables and are frame-invariant. The sun now reads the BUS clock, not
the wall clock, so the page's scrubber finally moves the terminator (its copy
had always said so); the flight deck's own clock pins it further.

### 9.2 The flight layer

| module | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-flight.js` | PURE kernel: RK4 through the live field — gravity + J2, drag against the co-rotating air, unbanked lift; ECI↔scene; elements; launch builder; presets; TLE epoch | `node tests/upper-atmosphere-flight.mjs` (35) |
| `js/upper-atmosphere-flight-layer.js` | screen-space ribbon (custom shader + dark underlay), head, heating wake, log-scaled force arrows, ground track, floor ring, the mission clock | `tests/upper-atmosphere-flight.spec.js` |
| `js/upper-atmosphere-flight-deck.js` | DOM deck: every readout is a kernel column; two clocks; sparkline; name tag via `projectToScreen` | same spec |
| `js/upper-atmosphere-flight-panel.js` | presets / track-a-satellite / custom launch with pick-site | same spec |

Decisions, each with the reason it is not the obvious alternative:

- **The density sampler is a bilinear log₁₀ρ table over (altitude × T∞)**
  built from the engine per (F10.7, Ap): ~1 µs against ~14 µs for
  `densityFieldAt`, gated to 3 % (measured worst 0.95 %). A 24-h ISS flight
  integrates in ~65 ms. The table is the ENGINE's, not a second model.
- **Co-rotation is on by default** and it matters: a prograde equatorial body
  feels ~22 % less drag than the same body retrograde (gated).
- **Lift is marginal above 80 km and the preset says so.** The "skip entry"
  preset at 7.6 km/s with L/D 2 buys seconds before the floor, not a climb;
  a 6 km/s "glider" was tried first and simply fell. The real entry peak
  (40–60 km) is BELOW the model, so the capsule preset shows ~0.03 g and
  ~12 W/cm² on a 1 m nose and the deck says where the peak actually lives.
- **The 80 km floor terminates the flight** with the last sample landed ON
  the floor (linear crossing) — never continued into air the page does not
  model.
- **Arrow length is log₁₀|a|** over 1e-8…10 m/s² (gravity 8.7 vs drag 1e-6 at
  the ISS cannot share a linear scale); the deck prints the true numbers.
- **Colour ranges are FIXED per mode** so the same altitude or q is the same
  colour in every flight and does not drift as the ribbon grows.
- **Two clocks.** Live-locked to the bus by default (scrubbing before launch
  un-launches it — the orrery's rope rule); the deck's transport detaches it
  because the bus clamps one hour into the future and a day of decay cannot
  be played through it. The globe pins the sun to the detached clock.
- **A launch frames the camera** (`frameFlight`): at whole-globe framing the
  ribbon competes with every other overlay and the limb band (measured on
  the screenshots — it was invisible). The dark underlay pass is the other
  half of legibility.
- **"Track a satellite" needs a LIVE TLE**: seeded via Rust SGP4 at the sim
  clock. The mean-element fallback probes are visualisation-grade and the
  panel says "waiting for live TLE" rather than integrating them.
- **FOCUS quiets the competition** (`setFlightFocus`, on at every launch,
  a deck chip): the cascade field lines, conjunction chords, altitude tori,
  solar-wind streamers, the slider ring, the mesosphere rings and the
  probes' orbit loops. Each crossed the launch framing as a band brighter
  than the ribbon (measured on the screenshots; the flight could not be
  found). Every hidden object's OWN visibility is remembered and restored
  exactly on focus-off / clearFlight.
- **Glyphs scale with camera distance** (`ak = camDist / 2.4`, floor 0.06):
  the arrows are world geometry and at chase range one drag cone filled
  the frame. The heating wake appears only above ~0.06 W/cm² — at LEO
  cruise (0.01) it is decoration.

### 9.3 Fixed here, on the way

- The camera controller now receives a REAL wall-clock `dt`. The globe's
  `dt` is ~0 every frame (§6) — fly-mode WASD barely moved and the follow
  spring never closed, which the chase cam surfaced. ONLY the controls take
  the corrected value; every other `dt` consumer keeps its historical
  behaviour pending the deliberate look §6 asks for.
- The controls are stepped AFTER every position update, just before the
  render. A follow that aims at the target's PREVIOUS position lags it by a
  frame of motion; at time-warp on a software renderer that put the chased
  probe at the frame's edge (measured). The follow spring also keeps the
  camera at or above the target's own radius: a fast target moves tens of
  degrees between slow frames and the lerp's CHORD cut inside the planet
  (camera at −171 km after a 600× chase).
- A storm preset now PINS both indices (`_userPinnedKey = 'preset'`, no
  expiry) until "Use live NOAA" or the realtime toggle releases it. The
  realtime driver ticks every 100 ms and re-applied its own value over a
  preset before the plots had redrawn, so presets silently did nothing
  whenever the driver had a value — measured: reverted within 100 ms; the
  smoke gate only ever passed while the driver's first fetch was still in
  flight.
- The canvas click test uses `event.timeStamp`, not `performance.now()`: on
  a busy frame a genuine click measured as a drag and was dropped (the
  mars.html 914 ms scar, found again by the pick-site gate).
- A backtick in a comment inside the volume shader's template literal
  terminated the string and took the whole page down as a boot error (the
  CLAUDE.md scar, hit again). No backticks inside `/* glsl */` literals.

### 9.4 Travelling THROUGH the layers (2026-09-28)

| module | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-transit-model.js` | PURE: pose on the local vertical (canonical basis, texture east), constant-rate altitude profile, the camera-local gas from `pointPhysics` (dot count ∝ log₁₀ n, species by the engine's fractions, drift ∝ v_th, heading changes ∝ collision rate) | `node tests/upper-atmosphere-transit.mjs` (9) |
| `js/upper-atmosphere-transit.js` | the transit driver + the wrapped point cloud around the camera | `tests/upper-atmosphere-transit.spec.js` |

- **The transit rate is real time and keeps its own clock.** km of altitude
  per second of wall time; on the globe's capped frame delta a 200 km/s
  request ran at 60 km/s on a software renderer (measured).
- **The page STARTS the flight and never HOLDS the camera** (the TIGA
  rule): any fly key or a drag releases it. To hand back exactly the view
  it left, the fly controller gained a configurable UP (`setUpVector`):
  yaw/pitch live in an (e1, up, e3) basis that is (X, Y, Z) by default and
  the local radial during and after a transit; Q/E climb along it. With a
  fixed +Y the first fly frame after a transit on the +Z side of the globe
  rolled the view ~80° (quaternion Δ 0.47, gated < 0.15 now). Orbit mode
  and Reset put +Y back, because OrbitControls orbits about the +Y it
  cached at construction (the CLAUDE.md scar).
- **The gas cloud is a symbol and says so**: one dot is not one molecule;
  every parameter is the engine's number at the camera's altitude, and a
  dot leaving the sphere re-enters on the far side so a descent reads as
  gas streaming past. It is off above the 2000 km ceiling and disclosed in
  the `gas` button's title and the camera readout (gas · λ · v_th rows).

### 9.5 What the camera saw once it was down there (2026-09-28)

Screenshots from the transit showed three things the orbit view had hidden,
each measured at the 95 km floor and each gated by the third test in
`tests/upper-atmosphere-transit.spec.js`:

- **A polygon horizon.** The planet was `IcosahedronGeometry(1, 5)`, and
  three's `detail` is LINEAR: 720 faces, ~10.6° edges whose chords sag
  27 km below the sphere. From 95 km the horizon is ~10° away, so it was
  literally the mesh's edges. `EARTH_ICO_DETAIL = 40` (1.55° edges, 0.58 km
  sag); the gate asserts the sag < 1 km, not the number.
- **Squares and snowballs.** Every `THREE.Points` layer is sized in world
  units with `sizeAttenuation`: sub-pixel from the orbit view, 30 px
  untextured SQUARES (layer particles) and 71 px additive blobs (transit
  gas) a few km from the lens. `js/upper-atmosphere-point-cap.js` clamps
  `gl_PointSize` to a CSS-pixel ceiling (× the renderer's pixel ratio,
  because three multiplies `size` by it) and dims a clamped vertex-coloured
  sprite by the area it lost; below the ceiling nothing changes. The layer
  particles, debris and constellations also gained the disc texture.
- **A moon that was a satellite.** A far-tier probe marker is a 76 km ball
  in a 166 km halo — a dot from the default ~3.2 R⊕ camera, a 4.6° disc
  over the transit horizon. Closer than `PROBE_MARKER_REF_RUNIT` (2.0 R⊕,
  under the ~2.13 the default view ever reaches) it keeps that view's
  angle; the gate asserts the default view is untouched.

## 8. What is still open

- **Storm-time equatorward propagation.** Auroral Joule heating launches
  travelling atmospheric disturbances that carry the density enhancement
  toward the equator over hours. The field is currently static in that
  respect — the oval brightens in place. This is the most physically
  interesting next step and it has a natural home: the T∞ field already
  takes a time argument everywhere it matters.
- **Semiannual / seasonal density variation.** Real and sizeable
  (~×2 at 400 km between the April/October maxima and the solstice
  minima); not modelled.
- **The 0–80 km band.** The render clamps to the model floor rather than
  extrapolating, which is correct but means a ray tangent below 80 km is
  slightly under-bright. A proper stitch to a standard-atmosphere fit
  would fix it.
- **Airglow radiance.** The volume emission rates are order-of-magnitude
  typical values used for *relative* brightness. This is not a radiance
  calculation and the page must not present it as one.
- **The `dt` bug in §6.** The controls are fixed (§9.3); particles, drag
  tracers and the substorm still take the ~0 value. Worth its own change,
  with the animation-speed consequences looked at deliberately.
- **Neither of this feature's test files runs in CI.** `nav-lint.yml` runs
  two node tests; the other ~40 in `tests/` — these two included — are run
  per the CLAUDE.md table. The DSMC end-to-end workflow is the only CI job
  that boots this page at all, which is why a 5× frame-cost regression
  reached CI as a mysterious timeout rather than as a failed assertion.
