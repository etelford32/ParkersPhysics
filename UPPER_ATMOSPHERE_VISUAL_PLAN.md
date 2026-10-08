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

### 9.6 Exploring the whole band (2026-09-28)

| module | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-explore-model.js` | PURE: flight ALONG the sphere (`exploreStep`), the one transition path for dives in and the climb out (`cameraPath` / `divePath` / `climbPath`), boundaries from the layer schema + crossings + membrane weight + grid level, model-placed points of interest, auroral curtain geometry, milestones, the log altitude gauge | `node tests/upper-atmosphere-explore.mjs` (23) |
| `js/upper-atmosphere-explore.js` | analytic boundary membranes, POI beacons, auroral curtains, crossing / milestone / discovery events | `tests/upper-atmosphere-explore.spec.js` |
| `js/upper-atmosphere-explore-hud.js` | DOM: altitude column, toasts, POI labels, readout nav rows, the panel, immersive | same |
| `js/upper-atmosphere-camera.js` | new `'explore'` mode, `runPath` (cancel on any input, FOV kick restored exactly), `setExternalDriver` for the transit | same + the transit gate |

- **Explore flies ALONG the sphere.** State is a unit position, a tangent
  heading parallel-transported along each great-circle step, an altitude and
  a pitch — no lat/lon, so no pole singularity (the gate flies over the pole
  and comes down the far meridian heading south). W flies where you LOOK: the
  vertical part is taken in log-altitude, so diving at the floor slows
  exponentially instead of hitting it. Speed is 1.2 × altitude per second, a
  NAVIGATION speed the readout prints next to the circular orbital speed.
- **One path for every transition.** Position slerps along a great circle
  while altitude interpolates in LOG space, so the path can never pass below
  the lower of its two ends (no chord through the planet); the view turns from
  where it was, to the ground under the destination, to the destination's
  horizon. Both ends are exact (gated). Any key, press or wheel cancels it
  where it is (the TIGA rule); the FOV kick is restored exactly.
- **The transit now hands over to EXPLORE**, not fly: from 95 km, fly mode's
  straight lines leave the band in a few hundred km.
- **Boundary membranes are ANALYTIC**, one pass on a bounding sphere, never a
  tessellated shell per boundary (the §9.5 facet lesson). Three scars, each
  measured: (1) line width must be the pixel's ANISOTROPIC footprint on the
  sphere, computed from the ray-sphere hit — an isotropic width divided by
  the grazing cosine bloomed the latitude line under the camera into a 30 px
  orange wedge; (2) a camera sitting exactly ON a boundary gets a
  rounding-level hit at t ≈ 0 on a grid meridian and floods a wedge of the
  view — the near fade starts at the camera's own height above the surface;
  (3) dives land on round coordinates, so the grid sits at HALF-integer cells
  or a stripe runs straight down the middle of the view. A surface above the
  camera draws at about half weight: seen edge-on it is the whole sky, and a
  marker must not drown the airglow.
- **Points of interest are PLACED BY THE MODEL** — the bulge and trough where
  the page's own Jacchia term peaks and bottoms, the aurora on the page's
  own oval for Kp from the live Ap, the exobase where the engine's λ equals
  its scale height, the airglow where the emission table puts it. None is a
  typed coordinate; each card says what placed it.
- **Auroral curtains** ride the same oval, 100–300 km, green low / red high,
  a sharp lower border. Placement is the model's; brightness and folds are
  symbolic and the panel says so. They fade in only below ~4000 km, so the
  default orbit view is unchanged (gated). The ring's seam vertex is
  DUPLICATED: closed by index, the last quad swept 23.9 → 0 h of MLT and
  squeezed a day of the ray pattern into one quad, dead ahead at magnetic
  midnight where the aurora stop looks.
- **The gas streaks.** Every dot draws a line to where it appeared one
  shutter ago — the camera's motion through the gas, not the gas's own
  (that stays thermal jitter). After a jump of more than a cloud diameter
  dots are re-seeded uniformly: mirrored, they all re-entered in the one
  cone pointing back at the old cloud.
- **The near plane follows the camera down** (0.25 × altitude, clamped to
  0.002–0.01 R⊕; far fixed, so the depth ratio stays ≤ 5×10⁵). From the
  orbit view it is the old 0.01 exactly.
- **Focus covers the transition, not just the mode.** The hoops (tori, field
  lines, orbit loops) are quieted while the camera is in explore OR a dive /
  climb is running; keyed on the mode alone, the dive swept them through the
  view as giant coloured bands before it arrived.
- **Every curtain pattern term is periodic in 24 h of MLT** (`noiseP` with an
  integer cell period, folds at integer multiples of 2π/24). Duplicating the
  seam vertex fixed the geometry, but a non-periodic noise still left a hard
  vertical edge in the curtain dead ahead at magnetic midnight.
- **The hover picks the first VISIBLE hit.** three's raycaster does not skip
  hidden objects, so with focus on, a hover over a hidden cascade marker
  showed a tooltip titled "undefined". The layer shells are exempt: hidden in
  the default volume render, they still answer "which layer is this".

### 9.7 Testing what the camera sees (2026-09-29)

| piece | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-frame-clock.js` | the ONE clock the camera stack reads: `performance.now()` normally, stepped time in manual mode, continuous across the switch | `node tests/upper-atmosphere-frame-clock.mjs` (5) + every spec below |
| `globe.setManualClock(on, { startMs })` / `stepFrames(n, dt, { render })` / `seedRandom(seed)` | the test hook: rAF idles, frames advance by exactly `dt` | `tests/upper-atmosphere-camera-feel.spec.js` (5) |
| `tests/helpers/image-metrics.mjs` | PURE metrics on raw RGBA: `horizonDeviation`, `lineWidths` (half maximum), `runWidths`, `coverage`, `seamStep`, `blobStats` | `node tests/image-metrics.mjs` (12, synthetic, each metric shown failing its bug) |
| `tests/upper-atmosphere-image-metrics.spec.js` | four solo-render gates, each with a runtime NEGATIVE CONTROL | itself (5 tests, ~45 s) |
| `.github/workflows/upper-atmosphere-kernels.yml` | the node tests on every push that touches them | CI, ~2 s |

- **The frame clock.** Everything that moves the camera or times a visual —
  dives/climbs/flyTo (`-camera.js`), the transit and the gas (`-transit.js`),
  POI refresh, discovery checks and the aurora's `uTime` (`-explore.js`) —
  reads `frameClock.now()`. In manual mode the render loop idles, the time
  bus is NOT stepped (sun, probes and scene instant are frozen), the volume
  governor does not run on stepped frames (it would read a software
  rasteriser's frame time as a verdict), and `stepFrames` advances exactly
  `n × dt`. Leaving manual mode resumes FROM the manual time (a pinned
  start is far from the wall clock, and a backwards jump would be a negative
  dt in the transit and a negative path progress). A module singleton on purpose: threading a clock through every
  constructor would put test plumbing into production signatures. Anything
  new that animates on this page must read it, or it will not stand still
  under the hook and its test will be measuring the machine.
- **The camera-feel gate compares the page to the kernel, frame for frame.**
  Held keys fly EXACTLY `exploreStep`'s cruise/turn/climb/boost (1e-6°),
  mouse look is exactly pixels × 0.0035 rad, a dive IS `divePath` at every
  stepped frame (1e-9) with the kernel's FOV gain and lands on time, any
  input stops a dive on the event, and a seeded gas cloud is repeatable with
  streak length = shutter × speed (1 %). On a renderer that draws one frame
  every ~0.6 s, none of that was checkable before — only "it moved, roughly
  east".
- **Image metrics run on SOLO renders.** The layer under test is drawn alone
  on black (`__uaSolo` hides every other leaf, clears the background, renders
  and `gl.readPixels` in the same task because the drawing buffer is not
  preserved), off-site requests are blocked so EarthSkin keeps its grey
  fallback, and the manual clock starts at a fixed instant. The numbers:

  | gate | now | control (the old bug, put back at runtime) |
  |---|---|---|
  | limb vs the ANALYTIC limb (per-column ray tangency), 300 / 110 km | 0.86 / 0.79 px | 14 / 24 px — `IcosahedronGeometry(1, 5)`, the 720-face planet |
  | the line straight ahead, width at half maximum, 270 km grazing | ≤ 4 px | 25 px — isotropic width ÷ grazing cosine |
  | camera 10 m above the 250 km boundary on the equator, coverage | 0 | 59 % of the frame — whole-degree grid, no near fade |
  | aurora column-to-column step at the MLT seam (÷ mean) | 0.08 | 0.81, AT the seam — non-periodic noise + folds |
  | nearest sprite at 1.1–10 × the near plane | ≤ cap + 1 px, a disc | gas 30 px; layer particle 243 px square (fill 1.0) |

  Every gate asserts its control FAILS — a metric that cannot see the bug is
  not a gate, and a threshold set without a control is a guess. Controls are
  shader-text patches (`split/join` on the exact source line; a patch that
  no longer applies throws, so a refactor cannot silently turn a control
  into a no-op), a swapped geometry, or a replaced material, always
  restored. Three measuring choices, each forced by a first attempt that
  could not separate the two: the grid is drawn at 16× gain for the
  measurement (the product draws it at ~8/255, where 8-bit quantisation IS
  the width) and widths are taken at HALF the line's own peak above the
  row's median, so neither the gain nor the dim rim fill enters; only the
  receding line dead ahead is measured (every other line crosses rows at a
  slant, and a slanted line's horizontal run is its width ÷ sin θ); and the
  seam step is column-to-column (`win = 1`) because the rays are 20–40 px
  wide and an 8 px window scored them 0.55 against the seam's 1.05.
- **Sprites nearer than the camera's near plane are clipped**, so the sprite
  gate places its dot at multiples of `camera.near` (24 km at 95 km
  altitude) rather than at a fixed distance — at 0.5–20 km neither the
  product nor the control drew anything, which is a passing test of nothing.
- **Tuning**: `UA_METRICS_LOG=1` prints each measurement beside its control's
  and `UA_METRICS_PNG=<dir>` writes every solo render as a PNG (a 30-line
  encoder on `node:zlib`; the repo has no image dependency and needs none).

### 9.8 Where the airglow is (2026-09-29)

Until now every airglow band was the same everywhere on the planet, day and
night — `airglowAt` depends on altitude only, so the render drew one even
ring. The real airglow is the most structured thing in the band.

| piece | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-airglow-field.js` | PURE: the band GROUPS (mesospheric: OH, Na, O₂, green; red line), day/night on the red line, the equatorial arcs + plasma bubbles via `FountainSampler`, SAR arcs, symbolic ripples, the probe's column, the renderer's tables, and the GLSL mirror GENERATED from its own constants | `node tests/upper-atmosphere-airglow-field.mjs` (27) |
| `js/upper-atmosphere-volume.js` | evaluates the field once per half-ray per emitting shell (92 km, 250 km) and applies it per sample | `tests/upper-atmosphere-airglow.spec.js` (5) |
| `js/upper-atmosphere-globe.js` | drives the fountain on the SCENE clock, ripple phases, Kp; `airglowFieldAt(point)` for the probe | same |
| explore stop `eia-arcs` | the strongest evening crest, placed by the fountain | `node tests/upper-atmosphere-explore.mjs` |

- **Two groups, because the physics splits there.** The mesospheric group
  (OH Meinel, Na D, O₂, the O(¹S) green line, 85–100 km) is
  chemiluminescence that runs day and night, so it gets NO day/night factor;
  its structure is gravity-wave ripples. The red line (630 nm, ~250 km) is
  where the day/night, equatorial and storm structure lives. With every
  factor at 1 the two groups add up to the old `airglowAt` EXACTLY (gated),
  so a location where nothing is happening renders as before.
- **Day is "sunlit at altitude", not the ground terminator.** A point is dark
  when the sunward ray to it grazes below the EUV screening height (100 km);
  at 250 km that is ~12° past the ground terminator. The 630 nm dayglow is
  taken as 20× the nightglow (the low end of Solomon & Abreu's range). One
  log stretch shows both — no camera exposure could, and the legend says so.
- **The arcs and bubbles are the SHARED fountain model**, imported from
  `js/ionosphere-fountain.js` (what ring-current.html runs), never re-derived.
  `FountainSampler` ticks it on the scene clock (36 h spin-up, re-spun on a
  backwards jump or one > 6 h — the model is deterministic per sim-date, so a
  re-spin to the same instant gives the same state), and samples it into a
  1440×1 half-float texture: crest intensity, crest magnetic latitude, bubble
  mask, bubble latitude extent. (Since §9.9 the fountain also takes the
  prompt-penetration ΔA from ring-current-efield via `IonosphereDriver`.)
  Crest gain 4 (arcs ~3–5× the mid-latitude nightglow, as observed); bubbles
  cut 85 % of the red line in a ~170 km-wide field-aligned wedge.
- **SAR arcs** sit on the plasmapause footprint at ~400 km, onset above
  Kp 4, dark side only — since §9.9 the TEARDROP plasmapause per MLT
  (`plasmapauseL`, Carpenter & Anderson, is the fallback).
- **The ripples are SYMBOLIC** and live in the mesospheric group only: eight
  fixed waves (30–300 km), each in its OWN packet — a spherical cap and its
  antipode, ~18° across — with the wave direction tangent at the packet
  centre. Two earlier versions gated the waves with cosine envelopes (one
  shared, then one each); a cos(k·u) envelope is a set of bands that wrap
  the planet, the bands crossed everywhere, and from orbit the waves read as
  a waffle lattice. Phases are computed on the CPU in double precision
  (ω·t on absolute time is ~10³ rad, beyond float32) and waves shorter than
  ~4 px fade out.
- **Where the shader evaluates the field.** Per fragment, at the point where
  each half-ray crosses the 92 km and the 250 km shell (or the ray's closest
  approach if it passes over): a limb ray tangent at 90 km crosses 250 km
  ~1400 km from its tangent point, so the red line must NOT be held at the
  tangent point the way the T∞ field is. Sunlit-ness is evaluated per SAMPLE
  from terms hoisted per half-ray. A half-ray with no samples (the far half
  of a ray that strikes the planet) is skipped.
- **The march still fetches TWO texels per sample.** A third (a separate
  red/SAR row) measured +70 % frame time on SwiftShader, so the red-line and
  SAR profiles ride in the density table's spare G/B channels
  (`packRedIntoFieldLUT`; ~20 km bins hold a 90 km-wide line) and the 10 km
  green band keeps its own finer table. Measured, solo volume at the default
  orbit framing, ms/frame on SwiftShader (noisy ±10 %):

  | rung | before | after |
  |---|---|---|
  | 10 steps (floor, default) | 228 | 303 |
  | 24 | 447 | 489 |
  | 40 | 808 | 859 |

- **A bug found on the way: the volume's magnetic pole was MIRRORED.** It was
  typed inline as `+cos·sin(lon)` — the frame the page used before §9.1 — so
  since 2026-09-27 the auroral Joule-heating term in the density render has
  been centred on a pole at 72.7°E instead of 72.7°W, and nothing looked
  wrong. It now comes from `latLonToScene(DIPOLE_POLE)`, and the airglow
  spec asserts it (a check that fails on the old line).
- **The gates** (`tests/upper-atmosphere-airglow.spec.js`, solo renders at
  the 2026 March equinox 00 UT, each with a control): noon/midnight red 4.7×
  vs 1.000 with dayglow patched out; both crests within 4 px of the rows the
  NODE kernel predicts, crest/trough 13.9 vs 1.00 with the arcs patched out;
  an injected bubble cuts both crests 99 % vs <5 % with bubbles patched out;
  a Kp 8 SAR arc 51× above its surroundings on the plasmapause row vs 1.000
  at Kp 2; ripple energy 4.0 vs 0.85 with ripples patched out. The solo-
  render harness is now shared (`tests/helpers/ua-render.mjs`).
- **The probe card** prints what shapes the 630 nm line under the cursor
  (dayglow / equatorial arc / plasma bubble / SAR arc / nightglow, and the
  multiplier), from the same kernel and drivers the shader reads.

### 9.9 How thick the plasma is, and the waves in it (2026-09-29)

The page drew the neutral gas and the light the gas emits; it did not draw
the PLASMA — the ionosphere a GNSS signal crosses. That field now exists, and
it is built almost entirely from models already in the repo, so this is a
JOIN, not a second ionosphere model:

| piece | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-plasma-field.js` | PURE: the electron density field and its TEC. The vertical E/F1/F2 stack is ring-current.html's `columnProfile` (`js/ionosphere-descent.js`); the crests + bubbles are the SHARED fountain; the night-side main trough sits on ring-current-efield's TEARDROP plasmapause; `IonosphereDriver` runs `ConvectionEField` + the fountain on the scene clock; `slantTec` is the shader's oracle; the GLSL is generated from its constants | `node tests/upper-atmosphere-plasma-field.mjs` (29) |
| `js/upper-atmosphere-tid.js` | PURE: the travelling ionospheric disturbances — ONE copy, read by the plasma field AND the red line | same (the GLSL mirrors are transliterated back to JS and run against the kernel) |
| volume mode `'plasma'` | slant TEC along every view ray, drawn OVER the globe | `tests/upper-atmosphere-plasma.spec.js` (7) |
| `js/upper-atmosphere-airglow-field.js` | the red line now carries the TIDs; SAR arcs moved onto the teardrop | `node tests/upper-atmosphere-airglow-field.mjs` (29) + `tests/upper-atmosphere-airglow.spec.js` (5) |
| globe | `IonosphereDriver` fed Kp + the page's solar-wind VBs (v·Bs); `plasmaFieldAt(point)`, `ionosphereState()` | both specs |
| page | a `plasma` chip (exclusive with `anomaly`), the probe rows `vTEC · NmF2` / `plasma`, `plasmaLegend` (prints the live E-field + ΔA) | smoke |

- **The data integration with the ring-current engine is two-way-shaped but
  one-way-wired**: this page's solar wind drives ring-current-efield's
  shielding model (Kp + VBs → driver amplitude; the shield relaxes with
  τ = 25 min). Its prompt-PENETRATION ΔA = A_drv − A_sh goes into the shared
  fountain (`FountainSampler.advanceTo(…, { dA })` — the super-fountain: a
  southward turning lifts the evening crests), and its TEARDROP separatrix,
  evaluated per longitude at that longitude's MLT (`ppData`, a second
  1440×1 texture), places the night-side trough and the SAR arcs. Nothing
  flows back into ring-current.html; both pages run the same kernels.
- **A driver change at the SAME scene instant re-equilibrates** (the shield
  is set to the new driver, ΔA = 0): a preset is a what-if, and no time has
  passed for region-2 currents to respond. Penetration needs time to pass
  while the driver differs from the shield — which is what it is.
- **One departure from the shared stack, stated.** `columnProfile`'s F2 term
  is 0.65 + 0.35·day, a readability choice for the descent inspector's bars
  that puts midnight at 65 % of noon. A TEC map with that contrast has no
  night side, and observed mid-latitude NmF2 falls to ~25–40 % overnight, so
  the column uses `f2NightFloor` (0.3) + 0.7·√cos χ in its place. Heights,
  storm loss and the E/F1 terms are the stack's own. vTEC at F10.7 150:
  ~26 TECU midday mid-latitude, ~7 midnight, ~57 in a daytime crest.
- **TEC is integrated over 80–2000 km only.** Real GNSS TEC includes the
  plasmasphere (+10–30 %); the legend says so. The display is log₁₀ over
  1–316 TECU (a vertical ray spans ~3–60; limb rays saturate), on an
  inferno-like ramp whose floor is lifted to deep violet so the thin night
  side still reads.
- **The plasma view is drawn premultiplied OVER the globe with the depth
  test OFF.** The volume is a back-face shell behind the opaque Earth, so
  depth-tested it only ever shows at the limb — right for a glow, useless for
  a map. The march already stops each ray at the planet, so nothing behind
  the Earth is integrated, and the volume is first in the transparent pass so
  orbits and field lines still draw over it. Blend and depth are GL state:
  switching mode costs no recompile.
- **The field is held per half-ray at the 300 km shell** (the airglow rule,
  §9.8) and the per-sample cost is three `exp` pairs of the α-Chapman stack
  with NO texture fetch — the plasma view is CHEAPER than the column view
  (SwiftShader, floor rung, solo: 210 vs 300 ms/frame), and modes 0–2 pay
  only a uniform branch.
- **TIDs are ILLUSTRATIVE** (observed speeds, wavelengths, directions, bands
  and Kp dependence; not a TID forecast). LSTIDs: λ 1500 km, 500 m/s,
  launched equatorward from `ovalCenterMaglat` (the cell engine's oval,
  imported), δN/N up to 15 % above Kp 3, decaying over 3000 km, 0.6 on the
  day side. MSTIDs: λ 250 km, 100 m/s, night, |magnetic latitude| 20–50°,
  fronts NW–SE travelling SOUTH-WEST in the north and NORTH-WEST in the south
  (the Perkins morphology), an INTEGER zonal wavenumber so the pattern closes
  at the date line, faded below ~4 px per wavelength. The red line sees
  1.8 × δN/N. Phases are double precision on the CPU.
- **The gates**, each with a control: rendered slant TEC vs the kernel's
  `slantTec` on the page's own drivers over 71 rays, display |Δt| median
  0.0009 / max 0.015 (≈ 4 % TEC) — control (horizontal structure patched
  out) max 0.089; crest/equator TEC 2.25 vs 1.10 with crests off; a Kp 8
  trough found exactly on the teardrop row (0° off) at depth 0.165 vs 0.011;
  LSTIDs in TEC correlate with the kernel r = 0.998/0.997 at two instants
  15 min apart, and the later render against the EARLIER kernel r = −0.25
  (the pattern moved); MSTID bands in the 630 nm line r = 0.999 vs −0.999
  against the half-period-shifted kernel; a southward turning in the page's
  solar wind gives ΔA 0.60 and lifts the evening crest 0.58 → 0.66 vs
  ΔA 0.000 under northward IMF. The SAR gate now finds the arc on the
  teardrop row (54.4° inv. lat; Carpenter–Anderson would put it at 49.1°).

### 9.10 The camera rig, and the CME coming at it (2026-09-30)

Until now a left drag could only rotate the globe about its centre; there was
no pan, no swivel, no lens, and no view in which the layers could actually be
told apart — from the default ~3 R⊕ camera the whole 50–2000 km band is a
0.3 R⊕ rim and the mesosphere is two pixels of it. And nothing on the page
said what was coming from the Sun.

| piece | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-camera-rig.js` | PURE: lens (fov ↔ 35 mm focal length), the pivot bound, pan / swivel / keyboard orbit / dolly, limb sites, **limb views** | `node tests/upper-atmosphere-camera-rig.mjs` (13) |
| `js/upper-atmosphere-camera.js` | applies the rig: drag TOOL (orbit · pan · swivel), right/Shift-drag pan, Alt-drag swivel, arrows / +− / [ ] keys, `setFov`, `limbView` / `flyToPose`, the orbit frame REBUILT for a new axis | `tests/upper-atmosphere-camera-rig.spec.js` (6) |
| `js/upper-atmosphere-camera-rig-panel.js` | DOM: tool, lens, pivot, the LAYER LENS (site × layer), the particle population card, "only this layer's particles" | same |
| `js/upper-atmosphere-cme-model.js` | PURE: the flux-rope frame in the Earth-FIXED scene, the compressed corridor, the true-scale near-Earth field lines, the camera stations | `node tests/upper-atmosphere-cme-model.mjs` (12, incl. the real WASM) |
| `js/upper-atmosphere-cme-layer.js` / `-cme-panel.js` | the ropes, the drawn Sun + AU ruler, the field lines + B-at-Earth arrow; the chip, clock, rope table, disclosure | the spec |
| `js/upper-atmosphere-instruments.js` | a LIMB SCALE: layer bands + altitude ticks at the tangent points, when the disc ruler has nothing to hang on | the spec (`limbTangentTicks`) |

- **The orbit frame is rebuilt, never re-aimed.** Vendored r160
  OrbitControls reads its orbit axis from `camera.up` ONCE, at
  construction. A limb view orbits the limb point about the LOCAL RADIAL, so
  the controller disposes and rebuilds the controls with `camera.up` set
  first (`_buildOrbit`) — the Stage / Mars / Moon scar, avoided the same way.
  `setMode('orbit')`, Reset and the "⌖ planet" button rebuild the planet
  frame (+Y about the centre). The spec's gate drags in a limb view and
  checks the camera's height along the radial is conserved; its NEGATIVE
  CONTROL rebuilds the controls about +Y and the same drag must break it.
- **Pan and swivel move the pivot, and the pivot is bounded** (the TIGA
  lesson): within 6 R⊕ of the centre, or just past the camera's own radius.
  A swivel that would carry the pivot out SHORTENS it along the new
  sightline — sideways would jump the picture. The orbit camera never goes
  below 20 km (radial lift). The swivel is captured on `pointerdown` in the
  CAPTURE phase and stopped there, so OrbitControls never starts a rotate.
- **Keyboard** (orbit mode, pointer over the globe or the canvas focused —
  otherwise the arrows belong to the page and its sliders): arrows orbit at
  exactly `keyOrbitRadS`, Shift+arrows pan, +/− dolly toward the pivot,
  [ / ] change the lens. The ＋/− HUD buttons now dolly toward the PIVOT, so
  they zoom onto a limb point instead of onto the planet's centre.
- **A limb camera stands ABOVE the band it frames.** The first version stood
  in the band's tangent plane AT mid-height: from 89 km a horizontal
  sightline runs hundreds of km through the densest near-side gas and the
  frame was pink haze (measured screenshots). Now the camera is at
  `max(400 km, top + 250 km)` on the tangent line of the band's mid-height
  sphere, so every ray's lowest point is its tangent height and the layers
  stack by tangent height — the geometry of an ISS airglow photograph. The
  frame is sized from the TANGENT rays to the band top, bottom and the
  ground (the altitude reference, always in frame), the band fills ≥ half
  of it, and it is composed ABOVE a bottom strip (`limbReserveBottom` 0.22)
  that the time scrubber and render buttons cover. The mesosphere needs a
  ~2.7° lens (≈ 500 mm) from 400 km; the whole band ~55°.
- **Limb sites are local times or the model's own points**: noon, dusk,
  midnight, dawn from the sub-solar point; the diurnal bulge, the pre-dawn
  trough and the auroral oval from the explore kernel's `pointsOfInterest`.
- **A limb view quiets the hoops** (the explore focus): under a telephoto
  lens the altitude tori and mesosphere rings are seen edge-on and filled the
  frame as pastel bands (measured). Focus holds until the camera orbits the
  planet again.
- **The limb scale.** The disc ruler hangs ticks along a bearing from the
  planet's centre; in a limb view the centre is far off-screen. The overlay
  then draws the LAYERS as coloured bands between their boundaries' tangent
  points, with altitude ticks, at screen-left (`limbTangentTicks`, pure
  geometry on the globe, the overlay stays three-free).
- **Particle populations** are separable: "only this layer's particles"
  composes with the per-layer toggles (a layer the user switched off stays
  off), and the card prints the engine's number fractions, n, ρ, T, λ, v_th
  and Kn at the layer's peak for the page's F10.7 / Ap. The mesosphere sits
  mostly below the density model's 80 km floor; its view shows the column
  clamped there and the airglow above it.

**The incoming CME** computes no flux-rope physics — the orrery / hero
pattern: `startFluxRopeProvider` (once per page), `trainAt` for geometry
(kernel probes, mirror fallback), `ropeSurfaceGrid` / `ropeAxisPoints`,
`kernel.fieldAt` for every colour that means field. What is new is the
frame join and the two scales:

- **The frame.** The rope frame is heliocentric (+x Sun→Earth, +z ecliptic
  north). This scene is Earth-FIXED, so ecliptic north is the ecliptic pole
  turned by the sidereal angle, (−sin θ sin ε, cos ε, cos θ sin ε), and the
  basis e1 = −ŝ, e3 = N̂ ⟂ e1, e2 = e3 × e1 is RIGHT-handed ((x, z, −y) is a
  rotation — not the orrery's mirror, so no `drawTilt`). The node gate pins
  N̂ ⟂ the page's own Sun on every day of a year (worst |ŝ·N̂| < 2e-3) and
  MEASURES e2 against the Sun's own motion (ΔŜ ∝ −e2), so a sign error in
  east/west cannot pass.
- **The corridor is compressed and says so**: the Stage's `stageRadius`,
  rescaled so the drawn Sun is 160 R⊕ up the Sun line and 1 AU lands exactly
  on Earth — ×110 near Earth, the Sun drawn ×6 its size on that map. Rope
  surfaces fade within ~10 R⊕ of Earth and of the camera, and recede to a
  ghost while the camera is inside ~60 R⊕, where the true-scale field lines
  are the picture. The camera may pull back to 380 R⊕ while the layer is on;
  the star backdrop now rides the camera (it is at infinity, and the camera
  can now stand beyond its old 220–340 shell).
- **The field near Earth is TRUE scale.** Within 40 R⊕ the lines trace the
  kernel's field at real positions (Earth at 1 AU). A rope is thousands of
  R⊕ across, so they are nearly straight; what moves is their direction.
  They stop where the kernel says the rope stops (the front shows as lines
  appearing) and at the Shue magnetopause the page already draws — the
  kernel's field is the undisturbed rope, so a line that crosses the
  magnetosphere comes out as its upstream and downstream pieces: clipped,
  never bent by hand. ~2400 `fieldAt` calls per trace, 5–9 ms, on a 250 ms
  leash.
- **Honesty.** LIVE only when the provider has an Earth-relevant train;
  otherwise the Gannon May 2024 replay on its own kernel (the hero's
  `gannonReplay`), chip "REPLAY · MAY 2024 G5 · <why>". The CME clock follows
  the page clock for a live train; scrubbing moves only the rope layer.
- **Stations** (`cmeViewPose`): approach (side-on, Sun and Earth both in
  frame — gated), upstream (30 R⊕ up the Sun line looking back), side-on;
  each orbits its pivot about ecliptic north, through the same rebuilt frame.

### 9.11 Where the satellites sit, and a way home for the camera (2026-10-04)

The page drew the tracked catalogue as an eight-checkbox "Live catalog
overlay": dots and nothing else. You could not see a shell or a plane, GPS and
GEO "loaded" behind the home camera (3.4 R⊕; GPS is at 4.2, GEO at 6.6), and
four things were wrong underneath.

| piece | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-sat-suites.js` | PURE: the suite catalogue (21 CelesTrak groups in 8 categories), mean elements from TLE or OMM with SGP4's own a/n recovery, secular J2 node/perigee/anomaly drift, orbit rings, TEME → scene (coords.js `eciToEcef`, transcribed), the plane-spreading ring sample, the altitude ladder over the ENGINE's layer table, regimes, `framingDistance` on the binding half-angle | `node tests/upper-atmosphere-sat-suites.mjs` (11, against the committed SGP4 WASM) |
| `js/upper-atmosphere-sat-suites-panel.js` | DOM: suites by category with counts, Orbit rings, Frame LEO / MEO / GEO / Fit shown, the ladder (one series, one hue, bands labelled, caption = table view) | `tests/upper-atmosphere-satellites.spec.js` (6) |
| globe | `setSuiteRingsVisible`, `setFocusSatellite`, `getSuiteLadder`, `frameSatellites`, `forgetCatalogGroup` | same |

**Measured, not assumed.** A ring is the MEAN orbit; SGP4's short-period
terms move the real satellite about it. Worst SGP4-to-ring over 24 h: ISS
7.7 km, GPS 8.7 km, Molniya 42 km. Without the J2 drift the ISS ring misses by
471 km in a day (the negative control). In the browser the dots sit within
2 km of the page's own SGP4 at the scene instant and every ring passes within
25 km of its dot, on rebuilt AND rotation-only frames (rings are built once in
the inertial frame and turned by `rotation.y = −GMST`; rebuilt every 10 sim-min
for the J2 drift).

**Fixed on the way:**
- **The catalogue ran on the WALL clock** (`tick(Date.now())`) while the
  probes, the sun and the terminator read the bus: at warp or under a scrub
  every dot sat hours away from its own day/night. It now ticks at
  `_sceneTimeMs()`; the spec's control puts the old tick back with the bus 3 h
  away and must miss by > 500 km.
- **The tracker's dots were uncapped, untextured squares** (0.008 R⊕ ≈ 51 km
  world size) — the §9.5 rule had never reached them. `capPointSize` 6 px +
  the disc.
- **Hidden suites still answered the cursor** (their slots draw in the hidden
  colour but stayed in the raycast set).
- **A suite that failed to load stuck** as an empty "shown" group forever; it
  is now forgotten and re-fetched on the next tick of its box.

**The camera escape (user report 2026-10-04: "stuck in this visual").** Visit
ISS flies in and LOCKS follow; while following, the (symbolically scaled) ISS
fills much of the frame, so every click the visitor made to look around landed
on it and re-started the fly-in + lock. And the lock itself was scheduled by a
`setTimeout` at the end of the fly-in, so a Reset pressed during the fly-in was
overridden a second later. Now: deferred follows are GENERATION-checked and
any Reset / Top / Stop-follow / mode change cancels them; clicking the target
already being followed is a no-op; Reset drops every lock (follow, transit,
explore path) and lands in the planet orbit frame itself (no racing
`setTimeout(setMode('orbit'))`); **R** resets from anywhere and **Esc** lets go
of a follow. The spec's control removes the cancellation and the lock must
re-engage.

**Full screen** was a bare ⛶ glyph in the preset row. It is now the HUD's
largest control ("⛶ Full screen  F", ≥ 44 px), **F** toggles it, and the label
flips to "Exit full screen".

### 9.12 One Earth radius, one propagator per object (2026-10-04)

§9.11 left a known split: the shared tracker drew at 6378.135 km per scene
unit in a 6371 km scene. Auditing every satellite path on the page for the
same kind of drift turned up four views of the SAME objects that disagreed.

| where | what it did | now |
|---|---|---|
| catalogue dots | `new SatelliteTracker(scene, 1.0)` ⇒ km / 6378.135 — every dot 7 km low against the shells, probes and camera readout | `TRACKER_EARTH_RADIUS` ⇒ km / 6371 |
| named probes with a live TLE (ISS, Hubble, …) | two-body circle, node FROZEN at the TLE epoch (ISS regresses −5°/day), radius from the relay's WGS-72 mean altitude drawn as a page altitude | SGP4 on the probe's own lines (the dots' propagator); mean elements + J2 until the WASM answers; orbit loop = the kernel's J2 ring, re-sampled every 10 sim-min |
| debris sample | same frozen-node circle, anchored at boot wall-clock | mean elements + J2 (`inertialSceneAt` with a perifocal table) |
| Walker constellation shells | radius 6371 + h, period from 6378.135 + h | one radius for both (`_rScene`) |
| fleet ribbons | WASM `alt_km` (WGS-72) drawn as a page altitude | `catalogAltToScene` |
| trajectory analyzer / fleet MC / backtest | page density profile looked up at the WASM's WGS-72 altitude — ρ read 7 km low, **~12–15 % dense** at 400 km against the probe tooltip for the same object | `profileToRhoGrid` hands the grid over in the WASM's convention; `dragPressureSeries` converts back |
| printed altitudes (fleet card, story card, analysis panel) | WGS-72 | page altitude |

`js/upper-atmosphere-datum.js` is the ONE seam: the page's datum is the
column kernel's 6371 (drawn sphere, engine, camera, flight kernel); WGS-72 is
what SGP4, the relay and the WASM drag integrator speak; analysis modules
stay internally in WGS-72 and convert only where they hand something to a
view. The kernel's GMST now comes from `js/sun-altitude.js` (its header asks
for no third copy).

The conjunction screener now reads every object through the same
`_lookupProbePositionAt` its drawn dot uses; to keep assets × debris × steps
affordable each object's track is computed ONCE per scan and shared by its
pairs (it used to re-propagate both sides per pair).

**Gates.** `node tests/upper-atmosphere-datum.mjs` (inverses, one radius,
the tracker hand-off, and the analyzer seam with a negative control at the
raw WGS-72 altitude: +15 %). In the browser, "one satellite, one place": the
named ISS probe, NORAD 25544 in the stations suite, the probe's own orbit loop
and a flight seeded from its TLE coincide — with two negative controls, the
legacy frozen-node orbit on a 2-day-old TLE and the old tracker scale, each of
which must break it. Measured: probe ↔ dot 0.002 km, probe ↔ its own orbit
loop 4.7 km, flight seed ↔ dot 0.002 km, the mean-element fallback 5.1 km;
controls 266 km (frozen node) and 7.6 km (old scale); catalogue dots vs the
page's SGP4 0.005 km.

### 9.13 The three "environmental" failures, root-caused (2026-10-05)

The regression runs after §9.11/§9.12 carried seven failures written off as
environment. Two of the three groups were not.

**"Overlay toggles do not throw" — three real page bugs, stacked.**
1. `body { overflow-x: hidden }` made BODY a scroll container (overflow-y
   computes to auto). A sticky element sticks to its nearest scroll container,
   and body never scrolls — the window does — so `#ua-aside-tabs` (and the
   site nav) NEVER stuck. 5000 px down the Controls column the Controls /
   Analysis switch was 5000 px off screen. Now `overflow-x: clip` (with
   `hidden` as the fallback); the tabs stick at 64 px, under the 50 px nav
   that now sticks too.
2. Offscreen, the page kept rendering the globe every frame. On SwiftShader
   the queued work landed as ONE 37 s frame when the globe scrolled back; on a
   laptop it is GPU time spent on pixels nobody sees. `_animate` now passes
   `render: false` while an IntersectionObserver says the canvas is off
   screen — state still marches every frame (the Stage/TIGA rule).
3. The offscreen frames were ~17 ms, and the volume's quality governor read
   them as headroom and climbed 10 → 16 march steps (measured). It now ticks
   only on frames it can see and resets its clock on return.

**"Boots without console errors" — the network, but not by filtering.**
The gate ran against live NOAA / CelesTrak / unpkg and failed wherever they
are unreachable. `tests/fixtures/upper-atmosphere-feeds.mjs` serves every feed
the page touches (the shapes its own clients read; the Earth textures are the
self-hosted NASA maps), so the gate judges the page. It carries a NEGATIVE
CONTROL (a 404'd page module must still be reported) and a sibling gate boots
with every feed dead and requires no uncaught exception.

**The DSMC e2e — environmental, and now runnable without Docker.** Against a
real API (`scripts/dsmc-backend-local.sh`: the CI compose's seed + serve,
natively) four of five passed at once. The fifth slept a fixed 1.2 s for the
debounced backend answer, which lands at ~3.6 s on SwiftShader while the
behaviour is right; it now waits for the request with the new F10.7 and for
the pill to return to SPARTA. The suite's `beforeAll` fails with the start
instructions when the API is down.

### 9.14 The ops HUD: the stage as an instrument (2026-10-08)

The stage was a fixed 500 px card (644×500 on a 1440×900 laptop) with the
chrome — a 3-row camera HUD whose time-warp row spanned most of the width, an
8-row readout in the middle of the planet, the explore column, the limb ruler
under it, a legend, an 11-button control row, the scrubber and the explore
POI labels — covering most of the render. The owner's ask: compact, on the
design tokens, and able to tell the atmosphere's layers apart for spacecraft.

| piece | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-ops-bands.js` | PURE: the OPERATIONAL bands (entry interface · decay zone · VLEO · station band · constellation shells · SSO · upper LEO · top of LEO, 80–2000 km contiguous) and the numbers printed beside them from the ENGINE's density: circular speed, period, drag deceleration, height lost per orbit, King–Hele lifetime at a disclosed reference B | `node tests/upper-atmosphere-ops-bands.mjs` (8) |
| `js/upper-atmosphere-ops-bands-layer.js` | the analytic limb-ring pass (one bounding sphere; a ring where a ray's closest approach equals a band edge, a faint wash between edges; pixel-footprint width; skipped inside the lowest edge) | `tests/upper-atmosphere-ops-hud.spec.js` |
| the page | viewport-driven stage, ONE token block on `#ua-globe-wrap`, the camera dock, the time dock, the toolbar, the legend pill, the folding readout | same (7) |

**The stage is viewport-driven.** `clamp(540px, 100vh − 178px, 1100px)`:
178 is the nav + the compact hero + the page padding, so the whole stage is
on screen at load and sticks at 14 px once the page scrolls. The hero's
introduction went behind a disclosure and the plots column gave up 80 px.
Measured stage: 744×722 at 1440×900 (was 644×500), 958×542 at the test
viewport, 1224×902 at 1920×1080.

**One token set.** Every piece of chrome over the canvas reads the block on
`#ua-globe-wrap` (`--ua-cyan` #5fd8ff + its rgb triplet, three surfaces,
four text shades, a 4 px spacing grid, three radii, one 24 px control
height, one monospace stack) — the readout used to carry its own mirror with
`--ua-cyan: #0ff` while the toolbar used #5fd8ff, and the fleet-UI block it
mirrored defines `--ua-cyan-mid: var(--ua-cyan-mid)` (a cycle, so every
`var(--ua-cyan-mid)` in the scrubber had been computing to nothing). The
scrubber host dropped its `.ua-pane-analysis` scope for the same reason.

**Where things went.**
- Camera dock (top-right): the mode switch as a segment beside the full
  screen button (still ≥ 44 × 120, still > 2× Reset's area — the §9.11
  rule), one row of view presets + the drag-tool segment + ISS + Stop follow,
  then the readout: altitude · physics layer · OPS BAND in a header that
  stays, the six gas rows in a two-column grid that FOLDS (remembered in
  localStorage, best effort) with the orbit row (speed · period · decay for
  the band the camera is in) and the nav / transit rows under it.
- Time dock (bottom): the time-warp chips moved INTO the scrubber's head
  (the bootstrap reparents the row after the scrubber mounts — its listeners
  are on the row, so they travel). UTC · mode · chips · ⟳ Now is one line;
  the scrubber's own ⏭ Now is folded away (one control, one action).
- Toolbar (bottom-left): four labelled segments — show (ρ column · airglow ·
  gas), view (anomaly · plasma · shells), instruments (ops bands · probe),
  transit (⇣ ⇡ rate) — and the legend as a one-line pill above it, clearing
  the toolbar by its MEASURED height (`--ua-toolbar-h`: the toolbar wraps
  to two rows at laptop widths, and a constant put the pill under it; the
  gate's negative control zeroes the measurement and must see the overlap).
- The explore column starts at the top (the HUD no longer spans the width)
  and carries an OPS STRIP beside the physics bar on the same log scale,
  named where a band is tall enough to carry its label.
- The limb ruler now PICKS its bearing per frame from four candidates by how
  much live chrome its run would cross (hysteresis against flicker), and
  draws the band segments beside its spine, named along the spine where the
  segment is longer than the label. The compass clears the dock by the
  published floor.
- POI labels are hidden where they would print across chrome (they used to
  cross the readout's numbers); the beacon still marks the place and the
  panel lists it.
- The boot pose is the Reset home (`y = 0.65 d`, d = 3.4): the page used to
  open 20 % closer than Reset lands, which clipped the 2000 km band top and
  bottom on the taller stage.
- The density plot thins its decade labels to what fits (eleven decades in
  340 px overprinted).

**Three `[hidden]` guards were each needed** (the Mars feature-index trap,
again): the transit hold button inside a segment, the readout's folded
rows, and the explore column's unfit band names each carry an author
`display`, which beats the UA sheet's `[hidden]`.

**The bands are a ruler and the page says so.** Band edges are planning
conventions (below 200 km you are down within days; above 600 km passive
decay no longer meets the 5-year rule), not features of the gas — the
legend's ops row says RULER, and the palette is deliberately distinct from
the physics layers' (orange thermosphere / violet exosphere; the node gate
checks no colour is shared). The lifetime is King–Hele's closed form for a
circular orbit in an exponential atmosphere with the LOCAL scale height
(pinned against a hand integration), at B = 50 kg/m², and the readout prints
`@B50` beside it: it scales linearly in B and the page does not know the
vehicle. Two things it says about the model: below 120 km the engine's
density is T∞-independent, so a storm leaves the entry band's number alone;
and at 160 km the density PIVOTS (×1.04 at Ap 300 while H grows ×1.6), so
the decay zone's King–Hele estimate LENGTHENS under a storm — pinned as
measured rather than "fixed", because the estimate integrates the modelled
profile below the orbit, which the hot storm thins.

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
- **The airglow field's next steps.** A dayglow peak that sits lower
  (~220 km) than the nightglow's; an explore stop that follows a live bubble
  or the storm trough.
- **The plasma field's next steps.** The plasmasphere above 2000 km (it is
  why GNSS TEC is higher than ours); storm-enhanced density and its plume
  (the dusk-side counterpart of the trough — ring-current-efield's SAPS
  bridge is the natural driver); the TIDs as a propagating field launched by
  the auroral Joule heating the T∞ field already carries (they are a
  climatological wave train here); and a real TEC map (GNSS, e.g. Madrigal)
  to score the field against, with the same measured-vs-model split the
  rest of the page keeps.
- **Airglow radiance.** The volume emission rates are order-of-magnitude
  typical values used for *relative* brightness. This is not a radiance
  calculation and the page must not present it as one.
- **The `dt` bug in §6.** The controls are fixed (§9.3); particles, drag
  tracers and the substorm still take the ~0 value. Worth its own change,
  with the animation-speed consequences looked at deliberately.
- **The browser gates still do not run in CI.** The seven node kernel tests
  now do (`upper-atmosphere-kernels.yml`, §9.7); the Playwright specs —
  camera-feel and image-metrics included — are run per the CLAUDE.md table.
  They are deterministic and need only Chromium + the dev server (~4 min for
  the upper-atmosphere set on SwiftShader), so a browser job is the natural
  next step. The DSMC end-to-end workflow is still the only CI job that boots
  this page, which is why a 5× frame-cost regression reached CI as a
  mysterious timeout rather than as a failed assertion.
- **Nothing measures how it looks on a GPU.** Every image number above is
  SwiftShader. Geometry and shape metrics transfer; brightness and bloom do
  not, and the Vercel preview on real hardware is still where those are
  judged.
