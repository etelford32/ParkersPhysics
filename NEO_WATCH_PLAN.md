# Near-Earth Watch — the geocentric near-Earth simulation

> `neo-watch.html` · `js/neo-space.js` (kernel) · `js/neo-watch.js` (controller) ·
> `js/neo-watch/stage.js` · `js/neo-watch/panels.js` ·
> shared with the orrery: `js/neo-orbits.js` · `js/neo-worker.js` ·
> `js/neo-rocks.js` · `api/neo/catalog.js` · `api/neo/watch.js`
>
> Gates: `node tests/neo-space.mjs tests/neo-orbits.mjs tests/neo-sources.mjs`
> + `npx playwright test tests/neo-watch-smoke.spec.js`

## 1. What this page is, and why it is not the orrery

`solar-system.html` already draws every catalogued near-Earth object
(`NEO_LAYER_PLAN.md`). It draws them **heliocentrically**, on a log radial map
where the Sun is the origin, with a 20-LD Earth-anchored inset cross-faded in
for the flybys. That page answers *where is this thing in the solar system*.

This page answers the other question — *what is around Earth right now* — and
answers it from the middle of the Earth:

| Surface | Source | Refresh |
|---|---|---|
| Population at its live propagated geocentric position | `/api/neo/catalog` → `js/neo-worker.js` `geoframe` | elements daily, positions per frame |
| Nearest-right-now board: distance, size, magnitude, RA/Dec, your alt/az | kernel `buildObjectRow` | 3 Hz |
| Close approaches (7 d back → 60 d ahead, ≤ 0.05 AU) | JPL CAD → `/api/neo/watch` | hourly |
| Impact risk, with an energy estimate | JPL Sentry → `/api/neo/watch` | hourly |
| Fireballs, **pinned at their real lat/lon on the globe** | JPL Fireball → `/api/neo/watch` | hourly |
| The ruler: LEO · GEO · 1/5/10/20 LD · 0.05 / 0.2 AU | kernel `SHELLS` | per frame |
| The Moon: true relative size, real phase, real path, marked apsides | kernel `moonGeoJ2000` · `moonPhase` · `moonPath` · `moonApsides` | per frame |
| Earth: GMST-locked globe, marched Rayleigh atmosphere, ocean glint | stage, from the kernel's Sun direction | per frame |
| Globe locked to sidereal time — terminator, sub-solar point, your horizon | kernel `gmstRad`, `subSolarPoint` | per frame |
| Our two-body pass vs JPL's integrated one, for the selected object | kernel `findApproach` + `compareApproach` | on selection |
| Earth's gravitational boundaries, drawn at their live radii | kernel `hillRadiusKm` · `soiRadiusKm` | per frame |
| Per-object encounter screen: geocentric speed, v∞, bound/unbound, focused impact corridor | kernel `encounterAnalysis` | 3 Hz |
| Catalogue-wide "which orbits can reach us at all" by Earth MOID | worker `screen` + kernel `reachesGravityDomain` | per catalogue load |

Nothing in the data layer is forked. The elements, the wire format, Kepler, the
class table and the rock meshes are the orrery's; what is new is a kernel for
the view *from* Earth and a stage that draws it.

## 2. Decisions (read before changing)

1. **One dishonest function, disclosed and removable.** `geoSceneRadius` is the
   only place the drawing distorts distance: logarithmic in geocentric radius,
   anchored so Earth's surface is 1.0 scene unit and the Moon is `MOON_SCENE`.
   `GEO_MAP.gain` is **derived** from those two anchors — the gate fails if
   anyone types a value in. The compression is labelled on-stage, carries a live
   ruler of real distances, and `trueSceneRadius` turns it off entirely. This is
   `js/stage/scale.js`'s rule, applied to a different scene.
   Consequence worth keeping: because the anchor is the surface, the map is
   within 8 % of truth at the geostationary belt and only compresses hard past
   the Moon — the region an operator cares about is the least distorted one.
2. **Four decades in one camera.** 1 R⊕ → 0.5 AU is 1 → 26 scene units on the
   log map, so no mode switching, no LOD, and no re-ranging while browsing. True
   scale puts the same span at 1 → 11 700, which is why `_applyRange()` moves
   `camera.far`, the controls' limits and the star backdrop together when the
   toggle flips.
3. **The page works in J2000; only pointing is of date.** Elements are ecliptic
   J2000; VSOP87D Earth and the Meeus Moon are of date. The conversion happens
   ONCE, in `earthHelioJ2000` / `moonGeoJ2000`, rotating those two BACK — so
   every geocentric vector, distance and RA/Dec downstream is in the frame the
   catalogue is published in. `topocentricAltAz` is the single exception and
   rotates forward again, because sidereal time is measured from the equinox of
   date by definition. RA/Dec is reported J2000, altitude and azimuth of date,
   and the page says which is which.
4. **The globe is rotated back, not the sky.** A rotation of every object about
   the ecliptic pole is a rigid rotation of the whole scene, so rather than
   precess 38 000 positions per frame the stage precesses the Earth the other
   way: `earthSceneMatrix(jd)` is that rotation, already conjugated into scene
   axes, and the globe spins by GMST inside it. Worth 0.37° in 2026 — about one
   pixel on a 200 px globe, which is exactly why it would never have been
   noticed, and would have put the drawn horizon out of step with the printed
   altitude.
5. **Equatorial, Y-up, and therefore no OrbitControls rebuild, ever.** Scene +Y
   is the north celestial pole and `camera.up` is never reassigned, so the
   vendored-r160 orbit-axis capture that bit the Stage, Mars, the Moon and TIGA
   cannot bite here. `equatorialToScene` is `(x, z, −y)` — a rotation, det +1,
   **not** the `(x, z, y)` reflection the heliocentric orrery uses, which would
   mirror every right ascension while looking entirely plausible. The gate pins
   the determinant.
6. **The approach LIST is JPL's; the disagreement is ours to show.** Two-body
   propagation of osculating elements drifts, fastest across an encounter, so
   the page never decides which approaches exist. What it does do is refine its
   OWN minimum around JPL's time (`findApproach` over a `geotrack`) and print
   the difference — because the honest way to draw a flyby is to say how far
   your drawing is from the integrated answer, not to quote one number and draw
   another. `findApproach` returns null when the minimum lands on the window
   edge, so an encounter our propagation misses by more than a day produces no
   comparison rather than a comparison to a boundary.
7. **Real time is the resting state.** `_jdNow()` reads the wall clock every
   frame rather than integrating a delta — a page that claims to be live must
   not be able to drift from the clock it claims to follow. Warp and scrub are
   an offset on top, and `isLive` is true exactly when that offset is zero.
8. **Fireballs can be pinned here, and could not be on the orrery.** The
   orrery's Earth accumulates `rotation.y` rather than tracking UT, so a lat/lon
   marker lands on the wrong meridian — `NEO_LAYER_PLAN.md` §4 lists this as an
   open item. This globe IS tied to GMST, so the pins go where the bolides
   actually happened. They are children of the globe mesh, which is what makes
   the longitude honest; the gate asserts the parenting, not just the position.
9. **Topocentric, not geocentric, alt/az.** The observer's offset from Earth's
   centre is subtracted before the angles are taken: the diurnal parallax is
   0.95° at one lunar distance and 9.5° at a tenth of it, which is the whole
   difference between "just above your horizon" and "not up".
10. **BODIES ARE DRAWN AT TRUE RELATIVE SIZE; only distance is compressed.**
    `bodySceneRadius` is the whole rule: the drawn Earth is 1 R⊕ across and the
    drawn Moon is 0.2727 of it, in both display modes and at every distance.
    This is what keeps the compressed radius legible — a viewer who knows how
    big the Moon looks next to Earth has a working ruler for the one thing a
    logarithmic radial map takes away. The Moon's mesh is therefore built at
    that radius and NEVER scaled; the gate asserts `scale === 1` before and
    after a True-scale flip, because a scale factor is exactly how "just make it
    a bit easier to see" would get in.
11. **The Moon is a body, not a marker.** Its phase is not drawn — it is the
    same Sun direction the terminator and the sub-solar point come from, so the
    three cannot disagree. It is lit by LOMMEL–SEELIGER rather than Lambert,
    which is why a full moon reads flat across the disc as the real one does,
    plus an earthshine term for the dark limb. Its path is `moonPath` over one
    SIDEREAL month (the circuit that closes in an inertial frame; a synodic
    month leaves a visible gap), and `moonApsides` marks perigee and apogee —
    drawn because a ring would hide the 13 % the lunar orbit's eccentricity is
    actually worth. It is selectable as the string `'moon'` rather than a
    sentinel index, because an index would read into the population arrays.
12. **THE PAGE DRAWS ITS OWN COMPETENCE BOUNDARY.** Every object here is
    propagated on a two-body orbit about the SUN — Earth supplies the origin and
    nothing else. That is fine until an object is close enough for Earth's
    gravity to matter, and the SOI (0.0062 AU, 2.4 LD) is exactly where it stops
    being fine. So the stage draws it, in amber, next to the Hill sphere
    (0.0100 AU, 3.9 LD), and an object inside it gets `modelValid: false` and a
    panel warning saying our own position for it is no longer the right model.
    Both radii ride Earth's live heliocentric distance (3.3 % over a year) and
    are recomputed per frame; the `km` in `SHELLS` is nominal and the gate pins
    it against the formula. Note where they land — INSIDE the 1–5 LD rings.
    Earth's gravitational domain is smaller than most people's intuition for it,
    and drawing it inside the familiar lunar-distance ladder is the point.
13. **Three different questions, three different kinds of answer.** The gravity
    card keeps them apart because conflating them is the trap: WHERE THE
    BOUNDARY IS is pure physics and certain; WHO IS INSIDE IT NOW is our
    propagation, and is explicitly untrustworthy inside the SOI; WHO COULD EVER
    BE is the Earth MOID, a property of the ORBITS, which makes it a hard
    catalogue-wide filter that says nothing whatever about timing. The converse
    of the MOID filter does not hold and the card says so: a small MOID means
    the orbits pass close, not that the bodies do.
14. **Estimates say they are estimates.** A published diameter is used where JPL
    has one; otherwise size comes from absolute magnitude with a stated albedo.
    Magnitudes use the IAU H,G system and are **absent** past its 120° phase fit
    limit rather than extrapolated. Comets get no H,G magnitude at all — their
    light is activity-driven — and the row says so.

## 2b. The gravity analysis, in numbers

Computed from the kernel, at Earth's mean distance:

| Quantity | Value | Why it matters |
|---|---|---|
| Hill radius | 1,503,600 km · **3.91 LD** | Outer bound of anything that can orbit Earth |
| Sphere of influence | 929,000 km · **2.42 LD** | Where our heliocentric model stops being right |
| Escape speed at the Hill radius | **0.73 km/s** | What an arrival must be under to be captured |
| Typical NEO arrival speed | 5–20 km/s | An order of magnitude too fast — why minimoons are rare |
| Focused cross-section at v∞ = 3 km/s | **14.9×** geometric | Earth is a much bigger target than Earth |
| Focused cross-section at v∞ = 20 km/s | 1.31× geometric | Fast encounters are barely focused at all |

The capture margin is the whole story: an object reaching the Hill sphere at a
typical 8 km/s is going 7.3 km/s faster than it could be and still be bound, and
nothing in a two-body encounter can shed that — which is why temporary capture
needs a third body and why the known minimoons (2006 RH120, 2020 CD3) are a list
of two rather than a population.

## 3. Shared code, and what was added to it

- **`js/neo-orbits.js`** gained `deriveGeocentric`, the geocentric sibling of
  `deriveFrames`. It lives there rather than in the geocentric kernel so
  `js/neo-worker.js`'s dependency graph does not grow: `js/neo-space.js` pulls
  in the VSOP87D + Meeus modules (73 KB) that a worker propagating osculating
  elements has no use for. `neo-space.js` re-exports it.
- **`js/neo-worker.js`** gained four additive messages — `geoframe`,
  `geotrack`, `meta` and `screen`. Same catalogue, same propagation, one load;
  the two pages differ only in what they ask for at the end. The orrery's
  `frame` and `track` paths are untouched. `meta` also ships each named object's
  orientation and time anchor, which is what lets the main thread call
  `propagate(el, jd, true)` for a VELOCITY on the fourteen rows a readout is
  about to name — rather than shipping 38 000 velocity vectors every frame.
- **`js/neo-rocks.js`** `rockMaterial` gained a `u_sunPos` uniform whose default
  `(0,0,0)` reproduces the orrery's `normalize(-vW)` exactly. The orrery draws
  the Sun at the world origin; this stage draws Earth there.

## 4. Scars (each was a bug while building this)

- **`Math.asin` at the zenith is NaN.** Standing at the sub-solar point,
  `Z / range` is 1 to within one ulp and one ulp over is NaN — a silent hole
  exactly where the answer matters most. Every arcsine in the kernel is clamped,
  and the gate stands at the sub-solar point on four dates to prove it.
- **0.05 AU is 19.46 LD, i.e. INSIDE the 20 LD ring.** The first shell table had
  them the other way round and the "shells ascend" assertion caught it. They are
  drawn a hair apart on purpose: JPL's watch radius and the orrery's local frame
  are not the same fence.
- **Negative zero fails `deepEqual`.** `equatorialToScene(0,0,1)` returns
  `z: -0`; the handedness assertions compare numerically.
- **A Julian Day has ~1e-8 d of precision left.** `compareApproach`'s hour
  difference is exact to about 4 µs on a JD near 2.46e6, not to 1e-9; the
  tolerance is the epoch's precision, not the function's.
- **Two fresh `Float32Array`s per frame is ~900 kB of garbage per frame** at
  warp with the full catalogue. The population buffers are grown, never
  reallocated, and the bounding sphere is nulled rather than computed over the
  oversized tail.
- **The atmosphere cannot use a rim term.** The first instinct is
  `pow(1 - dot(n, viewDir), k)` on a BackSide shell, and on a back-side sphere
  the drawn faces are the far hemisphere whose outward normals point away from
  the camera, so that dot is 0 and the rim is IDENTICALLY 1 — the exact failure
  `SOLAR_SYSTEM_VISUAL_REVIEW.md` S3 measured as five consecutive annuli at
  35.52. The shell here is FrontSide and marches the real view chord, which
  also buys the thing a closed form would not: each sample can ask whether it
  is in Earth's own shadow, and that shadow test is what puts the sunset ring
  on the terminator instead of a uniform halo.
- **The white blowout was not the atmosphere.** Measured, not guessed: with the
  globe hidden the shell read (18, 26, 48) at the disc centre and with it
  visible the pixel was unchanged, because that sample was on the NIGHT side
  where the shadow test correctly zeroes it. The blowout was the procedural
  fallback's ice caps, which began at 51° — the latitude of London — and were
  pure white. They are gone: a featureless ocean sphere with a graticule is
  unambiguous about being schematic, where a fake cap reads as a map. Two
  probes' worth of tuning was spent on the wrong term first.
- **The lit hemisphere needs a cosine.** Without it the day side is one flat
  colour and the globe reads as a circle rather than a ball. It is also simply
  correct once a texture arrives: an albedo map is a reflectance.
- **A cached path outlives the map it was built on.** `_placeMoonOrbit`
  throttles to 0.05 d of sim time, so flipping True scale or moving the horizon
  left the old geometry on screen indefinitely until both invalidate
  `_moonOrbitJd`.
- **A table that redraws detaches the row under the cursor.** The board
  refreshes at 3 Hz; rebuilding its innerHTML each time meant a click landing
  between two redraws hit a node that was already gone. Playwright reported it
  as "element was detached from the DOM, retrying" and then a click timeout; a
  visitor would have experienced a row that sometimes just does not respond.
  Both live tables now rebuild their markup ONLY when the set of rows or their
  order changes, and write the numbers into the existing cells otherwise — the
  EarthView verdict card's stable-header rule (CLAUDE.md §4.4), arrived at the
  same way.
- **`moonApsides` was DATE-DEPENDENT and shipped that way for a day.** It used
  `findApproach`, which deliberately refuses an extremum on its window edge —
  right for a close approach, wrong for an apsis. Searching forward from `jd`
  put whichever apsis was a few hours ahead ON that edge, so the marker silently
  vanished for roughly one day in fourteen. The browser gate caught it the next
  morning purely because the date had rolled over onto a bad one. It now uses
  `findExtrema` over a window that STARTS BEFORE `jd`, and
  `tests/neo-space.mjs` sweeps 120 epochs across both cycles so the catch is no
  longer an accident of the calendar.
- **The anomalistic month is a MEAN.** The follow-up assertion — "the next
  apsis is within one anomalistic month" — also failed, and this time the code
  was right: solar perturbation swings the real perigee-to-perigee interval over
  ~24.6–28.6 days (28.4 d measured as the longest wait across 2026). The search
  window and the test bound are both sized to the real interval, not the mean.
- **A `const` in a later section is in its temporal dead zone.** `SHELLS`
  (section 1) seeds the two gravity boundaries by calling `hillRadiusKm` /
  `soiRadiusKm`, whose `EARTH_SUN_MASS_RATIO` was a `const` in section 5b — the
  module threw on import and took the page with it. Function declarations hoist;
  `const` does not. The gravitational constants now live in the top constants
  block. `NEO_LAYER_PLAN.md` §3 records the same failure mode on the orrery.
- **Three call sites want the same ephemeris every frame.** `earthHelioJ2000`
  and `moonGeoJ2000` carry a single-entry memo keyed on the Julian Day; they
  stay pure (same input, same frozen output).

## 5. Open items

- The Moon's path is sampled over one sidereal month from the current instant,
  so at high warp it is rebuilt every 0.05 d of sim time. Fine at 128 samples;
  revisit if the sample count grows.
- The atmosphere march is 8 fixed samples. It is cheap because the shell covers
  few pixels at any useful framing, but it is a fixed cost per covered fragment
  and the globe fills the frame in the Earth view. If a weak GPU ever shows up
  in the numbers, the sample count is the knob — not the shell radius, which is
  a disclosed physical claim.
- Earth's day/night imagery and the lunar surface map are both optional CDN
  loads (`js/earth-skin.js`, `js/moon-skin.js`). Everything on the page is
  correct without them and the feed chip says which is showing, but the
  procedural globe is deliberately featureless, so a local equirectangular
  basemap would be a real improvement rather than a cosmetic one.
- Objects outside the view horizon are counted but not drawn at all. A faint
  out-of-horizon population (dimmed, at the horizon radius) would show how much
  is just off-stage; deliberately not shipped, because drawing something at a
  radius it is not at is the one thing this page's scale rules forbid.
- The starfield is procedural and is **not** a star catalogue — the page's sky
  positions are the objects', and a wrong star field would imply a pointing
  accuracy this stage does not claim. A real catalogue behind a toggle would be
  a genuine addition; it needs a source and a magnitude limit first.
- `tier=all` (~38 000 objects, ~3.4 MB) is offered here as on the orrery and is
  equally untested against Vercel's edge response limit in production.
- The same production self-report as `NEO_LAYER_PLAN.md` §4 applies: one
  request to `/api/neo/catalog?tier=pha` and `/api/neo/watch` settles the
  unverified JPL schemas, after which the candidate lists in
  `api/_lib/neo-sources.js` should be trimmed.
