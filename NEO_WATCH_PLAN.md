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
| Globe locked to sidereal time — terminator, sub-solar point, your horizon | kernel `gmstRad`, `subSolarPoint` | per frame |
| Our two-body pass vs JPL's integrated one, for the selected object | kernel `findApproach` + `compareApproach` | on selection |

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
10. **Estimates say they are estimates.** A published diameter is used where JPL
    has one; otherwise size comes from absolute magnitude with a stated albedo.
    Magnitudes use the IAU H,G system and are **absent** past its 120° phase fit
    limit rather than extrapolated. Comets get no H,G magnitude at all — their
    light is activity-driven — and the row says so.

## 3. Shared code, and what was added to it

- **`js/neo-orbits.js`** gained `deriveGeocentric`, the geocentric sibling of
  `deriveFrames`. It lives there rather than in the geocentric kernel so
  `js/neo-worker.js`'s dependency graph does not grow: `js/neo-space.js` pulls
  in the VSOP87D + Meeus modules (73 KB) that a worker propagating osculating
  elements has no use for. `neo-space.js` re-exports it.
- **`js/neo-worker.js`** gained three additive messages — `geoframe`,
  `geotrack` and `meta`. Same catalogue, same propagation, one load; the two
  pages differ only in what they ask for at the end. The orrery's `frame` and
  `track` paths are untouched.
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
- **Three call sites want the same ephemeris every frame.** `earthHelioJ2000`
  and `moonGeoJ2000` carry a single-entry memo keyed on the Julian Day; they
  stay pure (same input, same frozen output).

## 5. Open items

- The Moon's ring is sampled over one sidereal month from the current instant,
  so at high warp it is rebuilt every 0.05 d of sim time. Fine at 96 samples;
  revisit if the sample count grows.
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
