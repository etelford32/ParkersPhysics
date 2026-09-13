# Near-Earth Objects on the Solar System orrery — design, status, scars

> `solar-system.html` · `js/neo-orbits.js` (kernel) · `js/neo-worker.js` ·
> `js/neo-layer.js` · `js/neo-panel.js` · `api/neo/catalog.js` ·
> `api/neo/watch.js` · `api/_lib/neo-sources.js`
>
> Gates: `node tests/neo-orbits.mjs tests/neo-sources.mjs tests/pipeline-registry.mjs`
> + `npx playwright test tests/solar-system-neo-smoke.spec.js`

## 1. What shipped (2026-09)

Every catalogued near-Earth object — asteroids, near-Earth comets, and the
interstellar visitors — drawn at its propagated position for the orrery's
sim clock, plus the things a visitor actually asks about:

| Surface | Source | Refresh |
|---|---|---|
| Population (points, class colours, PHA/flyby highlights) | JPL SBDB query API → `/api/neo/catalog?tier=pha\|bright\|all` | daily (elements) |
| Close-approach list (7 d back → 60 d ahead, ≤ 0.05 AU) | JPL CAD API → `/api/neo/watch` | hourly |
| Impact monitor (Torino / Palermo) | JPL Sentry API → `/api/neo/watch` | hourly |
| Recent fireballs | JPL Fireball API (US Gov sensors) → `/api/neo/watch` | hourly |
| Meteor showers active at the sim date, next peak, inbound radiant arrows | IAU MDC / IMO table in the kernel, keyed to solar longitude | computed |
| Notable-object chips (Apophis, Bennu, 2024 YR4, 3I/ATLAS …) | kernel table, matched into the loaded catalogue | computed |
| Earth-local frame: 1/5/10/20 LD rings, in-zone markers, ±3 d trails, labels | kernel | per frame |
| Selected object: orbit line, marker, camera-lock anchor, live data card | kernel | per frame |

The page's own `selectBody()` / `setCamLock()` machinery drives NEO bodies
exactly like planets (a body object with `mesh: anchor`); clicking a point on
the canvas, a row in the panel, a notable chip or a shower's parent all go
through it.

## 2. Decisions (read before changing)

1. **Two drawing conventions, cross-faded, both disclosed.** The orrery's
   log radial scale makes the drawn Earth ~17 lunar distances wide, so a
   flyby at 1 LD lands inside the planet. Objects inside 20 LD are therefore
   drawn on an Earth-anchored frame using the Moon's OWN compression
   (`planet-moons.js` `MOON_VIS_CFG.earth`, minus its 6 R⊕ clamp), so the
   1 LD ring passes through the drawn Moon. **No single monotonic radial map
   can serve both frames**: the Moon-anchored map at 1 LD (0.283 units)
   already exceeds the heliocentric map at 40 LD (0.27 units), so any bridge
   would draw an object moving AWAY from Earth on screen while it approaches
   in reality. Hence an alpha cross-fade over 14–20 LD, never a positional
   blend. Do not re-derive this; `tests/neo-orbits.mjs` pins the Moon anchor.
2. **Ecliptic of date, not J2000.** JPL elements are J2000; the page's planets
   come from VSOP87D, which is equinox of date. The difference is the general
   precession in longitude — 0.37° in 2026 — which at 1 AU is ~2.5 LD, i.e.
   the whole flyby geometry. The worker rotates every position by
   `precessionLongitudeRad(jd)` once per frame; the kernel test shows the
   unrotated error is > 2 LD for an object coincident with Earth.
3. **Flyby geometry uses Earth's TRUE position, anchored at the DRAWN
   Earth.** Geocentric vectors are computed against `earthHeliocentric(jd)`
   and drawn relative to `earthP.mesh.position`. Since the 2026-09 accuracy
   pass the drawn Earth IS its VSOP87D position on the log map (see 2c), so
   the anchor no longer hides an equation-of-centre error — it only bridges
   the log radial map to the Moon-compressed local frame.
4. **The approach LIST is JPL's, not ours.** Two-body propagation from
   osculating elements drifts at arcminutes per year and far faster across a
   planetary encounter. The CAD table (JPL's integrated orbits) is the source
   of truth for when/how close; the kernel only draws where things are
   between the table's rows, and every data card says
   `elementsAgeNote` out loud.
5. **Tier ladder pha → bright → all, each REPLACING the previous.** Tiers
   nest, so replacement is exact. `all` (~38 000 rows, ~3.4 MB JSON, ~1 MB
   on the wire) is skipped on save-data connections. Most close approachers
   are small (H > 22) and only exist in `all`; a row whose object is not in
   the loaded tier still renders from CAD data and says "not in loaded tier".
6. **Routes never 5xx.** Both answer 200 with `freshness:'stale'` and a
   per-source `field_map` / `unmapped` self-report. status.html renders
   that amber; the page shows "feed down" and draws nothing. The SBDB / CAD
   / Sentry / Fireball schemas are UNVERIFIED — ssd-api.jpl.nasa.gov is
   egress-blocked from the build sandbox (403 at the proxy) — so every
   column is resolved from a candidate list. **One production request per
   route settles the schema; read the self-report and trim the lists.**
7. **No client parameter reaches an upstream URL.** The catalogue route
   takes a tier NAME; the watch route takes nothing. `tests/neo-sources.mjs`
   asserts unknown tiers are refused, not defaulted.
8. **Propagation is off-thread and allocation-free.** `prepareColumns`
   precomputes the perifocal basis; the hot loop is one Kepler solve and six
   multiplies per object. Measured in node: 38 040 objects prepare in 82 ms,
   propagate + frame-derive in 17 ms. Main-thread fallback (no module
   workers) runs at 1 Hz on purpose.

## 2b. Rendering (2026-09, "make it realistic" pass)

- **Bodies are meshes wherever they can have a shape.** `js/neo-rocks.js`
  builds seeded rocks (lumpy field + craters + a family profile: potato,
  elongated, contact binary, spinning top, spheroid — Bennu/Ryugu/Didymos
  are tops, Apophis/Eros elongated, Itokawa/Toutatis contact) with real
  spin periods where known. A pool of 24 meshes is assigned at ~10 Hz to the
  selected object, the flybys inside the Earth-local frame and the nearest
  objects to the camera within 2.5 units; their sprites are suppressed while
  a mesh stands in. Spin is a closed-form function of SIM time (period ×
  seeded phase), so warp and scrub stay honest. Rocks light themselves from
  the Sun direction (the page's PointLight decays physically and leaves 1 AU
  dim) — same convention as the page's planet shader.
- **Sprites for the far field only**, sized and brightened by absolute
  magnitude, additive Gaussian PSF with a faint diffraction cross on the
  brightest, NATURAL S/C-type tints by default (PHAs warm-biased) with the
  class palette behind a "Colour by class" toggle.
- **Comets grow tails**: ion tail straight anti-sunward (exact — the Sun is
  the scene origin), dust tail lagging the motion with a t² curve, lengths
  and coma ∝ 1/r² inside 3.5 AU; the nucleus mesh gets a self-lit haze.
- **Meteor showers are meteoroid streams**: instanced tumbling rocks on a
  cone converging on Earth at the stream's speed, plus faint streaks and a
  hairline guide with the label.
- **`_lockDistance` in the page has an NEO branch** (floor 0.09, not the
  planets' 0.35): a rock a few hundredths of a unit across was ~40 px at the
  planet floor. The page's asteroid belt points also got a soft round sprite
  — untextured `PointsMaterial` squares were suddenly within a few units of
  the eye in every locked NEO view.
- **Sizes are a disclosed log map** (`drawnRockRadius`): a 30 m rock and Eros
  differ 500× in reality and ~4× on screen. Never used for physics.

## 2c. Accuracy + sizes (2026-09, "too big when zoomed out" pass)

Measured on the 2026-09-13 deploy (42 572 objects loaded — the `tier=all`
payload and the JPL schemas both resolved in production): the population was
a wall of 10–25 px blobs at the inner-system zoom and a dozen flyby labels
sat on a 200 px Earth disc.

- **Planets ride their EPHEMERIDES, not phased circles.** `PLANET_EPH` in the
  page maps every planet (+ Ceres, new mean elements in `horizons.js`) to its
  of-date heliocentric function, evaluated every frame and drawn through the
  kernel's `helioToScene` — the SAME log map the objects use. The circles
  had Mercury's ±23° / Mars's ±10.6° equation of centre and no radial swing
  at all, so an accurately propagated NEO sat in the wrong place relative to
  every inner planet. The orbit ribbon is the sampled TRUE path over one
  period (`ephemerisPathScene` + `ribbonStrip`), rebuilt on a > 10 yr scrub.
  The `angle0` block survives only as the fallback for a body with no
  ephemeris function (none today).
- **Brightness and size follow the APPARENT magnitude from Earth now**, IAU
  H–G with G = 0.15 (`apparentMagnitude`, computed per frame in the worker
  as `vmag`). V 12 → 3.4 px, V ≥ 23 → 1.4 px; alpha 1 at V 14 down to a 0.07
  haze at V ≥ 27.5 (`MAG_DISPLAY`). A 30 m rock at 0.1 AU and a 5 km one at
  3 AU can be equally bright — the point is observability, not size. The
  near-camera growth is now √(12/depth) capped at 1.6× (the linear 0.6–2.3×
  put everything at 2.3× across the whole inner system).
- **Rocks are TRUE scale with a disclosed screen-space floor**
  (`rockDrawRadius`): (D/2)·earthR/R⊕ in the drawn-Earth convention (Eros
  1.6e-4 units — invisible, correctly), floored at 5 px for the pool and
  34 px for the selected object so its shape and spin stay inspectable. The
  card's "Drawn size" row prints ×N. `drawnRockRadius` (the old log map) is
  gone; `body.radius` handed to the page is the TRUE radius, so
  `_lockDistance` always lands at its 0.09 floor.
- **Flyby labels are a zoom LADDER** — built for the nearest 12, shown by
  rank: 3 while the 20 LD ring is < 45 % of the view, 6 to 90 %, all 12 above
  (six at 27 % still overlapped in the capture).
- **Analysis on the card and on the orbit**: apparent V + phase + elongation,
  speed relative to Earth (Earth's velocity by central difference through the
  page's own ephemeris), ecliptic λ/β (helio + geo, of date), node crossing
  distances with the Earth-crossing verdict (band 0.983–1.017 AU), Tisserand
  T_J, next perihelion date. On the selected orbit: ☊ / ☋ / q marks and a
  drop line to the ecliptic plane. Every number is a kernel function with a
  node test; the layer only formats.

## 3. Scars (each was a bug during the build)

- **TDZ abort.** `NeoPanel` renders synchronously in its constructor and
  reads the page's sim clock; instantiated before `let _ephemEpoch` it threw
  a `ReferenceError` that aborted the WHOLE page module (no animate loop, no
  planets). The wiring block now lives just above `function animate()`.
- **Labels pile up at the top view.** Sprites with `sizeAttenuation:false`
  keep their pixel size at any zoom; at 55 units out, four ring labels and
  a dozen flyby labels stacked on the Earth disc. Ring labels show when the
  1 LD ring subtends > 2 % of the view, object labels when the 20 LD ring
  subtends > 8 %; the selected object never gets a second local label.
- **Label re-raster per worker frame.** A flyby label's text carries its
  distance, which changes every frame at warp speed; rebuilding a canvas
  texture per frame × 12 labels was the most expensive thing on the page.
  Throttled to 4 Hz per label.
- **Gaussian year ≠ 365.25 d.** The first kernel test derived a period from
  365.25 and "failed" at 1.4e-8; the period is 2π/n with k = 0.01720209895.
- **"(2024 YR4)" ≠ "2024 YR4".** SBDB's `full_name` for unnamed objects is
  the designation in parentheses; the "same as designation → ship null"
  byte-saver has to strip them.
- **Points raycast sorts along the ray, not across it.** `pick()` re-sorts
  hits by `distanceToRay` so a click means "nearest the cursor".
- **"Earth View" did not look at Earth.** The page's preset was a fixed
  camera aimed at the +X axis, where Earth sits in late September; on any
  other date it framed empty space (the Geminids capture on Dec 14 showed
  nothing). `setCam('earth')` now frames the drawn Earth wherever it is.
- **1-px GL lines vanish against the point cloud.** Radiant arrow shafts
  are thin cylinders, not `THREE.Line`.
- **three's icosahedron `detail` is LINEAR, not recursive.** `detail: 3`
  gives 162 vertices, not 642; the rocks use 7 (1280 faces).
- **A label that follows the sprite's alpha disappears when a mesh stands
  in.** Flyby labels follow the local-frame weight only.
- **Absolute magnitude is not brightness.** Sizing sprites by H made the
  whole 42k population 10–25 px blobs at any zoom; apparent V fixed it.
- **A pixel floor that scales with distance never shows a shape.** A locked
  rock at a 5 px floor stays 5 px however far you zoom in (the floor follows
  the camera). The selected object gets its own 34 px floor for that reason.
- **Float32 paths in float64 tests.** `ephemerisPathScene` / `ribbonStrip`
  return Float32Arrays; identities on them hold to ~1e-6, not 1e-9.

## 4. Open items

- Production self-report: the 2026-09-13 deploy loaded 42 572 objects and a
  populated close-approach list (author's screenshot), so the SBDB and CAD
  schemas resolved and the `tier=all` payload is fine on the edge. Still to
  do: read `groups.*.field_map` / `sources.*` once and trim the candidate
  lists in `api/_lib/neo-sources.js`; confirm the interstellar query
  (`e > 1.1`) returns 1I/2I/3I and nothing else.
- Ceres's mean elements are anchored on the 2018-04-28 perihelion from
  memory (Dawn's extended mission observed it); verify `CERES_EL` against
  JPL SBDB when egress allows. Expected ~1° 1990–2060.
- The synthetic flybys in the smoke spec share Earth's mean motion, so
  their geocentric trails are points; a real flyby draws a proper arc.
- Fireballs are listed, not drawn on the sphere: Earth's drawn rotation is
  not tied to UT (rotation.y accumulates), so a lat/lon marker would be
  placed on the wrong meridian. Tie the Earth mesh to GMST first.
