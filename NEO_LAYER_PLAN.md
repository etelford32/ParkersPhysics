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
   Earth.** The planets ride mean-motion circles (`angle0` + uniform rate);
   Earth's equation of centre alone is ±2° ≈ ±13 LD. Geocentric vectors are
   computed against `earthHeliocentric(jd)` and drawn relative to
   `earthP.mesh.position`. Numbers are honest; the anchor is a display
   convention, said so in the panel note.
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
- **The far field is the SAME BODY, drawn as a sphere impostor** (2026-09-18).
  It used to be an additive Gaussian PSF with a diffraction cross — the
  rendering convention for a point SOURCE of light. Three things followed: the
  population glowed on its own, tens of thousands of additive sprites stacked
  into an orange haze, and an object CHANGED SPECIES as it crossed `ROCK_RANGE`
  into a Lambert-shaded mesh. `POINT_VS` / `POINT_FS` now shade the visible
  hemisphere with the same terms as `ROCK_FS`. The Sun is the scene origin, so
  the vertex shader has the exact solar direction in view space for free
  (`viewMatrix * vec4(0,0,0,1)`), and **the phase angle is real** — an object
  between the camera and the Sun is a crescent, one at opposition a full disc;
  nothing is keyed to it. Blending is **normal, premultiplied**, so a body in
  front of the Sun is a SILHOUETTE and no number of bodies can add up to a glow.
  Tone is `aAlbedo` — MEASURED where JPL publishes one, else the taxonomic class
  mean (§2d), never a hash of the designation.
  **The magnitude-derived ALPHA is gone**: H is size *and* albedo, both of which
  the body now carries honestly, and as an opacity it made a faint rock a
  see-through one the moment the blend stopped being additive. Alpha is
  visibility and the local-frame cross-fade, nothing else. NATURAL S/C-type
  tints stay the default, the class palette stays behind "Colour by class".
- **A comet's coma is the one thing here that may glow.** `aComa` carries its
  1/r² strength (the tails' own law) and the nucleus stays the dark body it is —
  the sprite no longer swells to fake a coma.
- **Attention is a RETICLE, never a halo.** Flybys within ±7 d, in-zone objects
  and the hovered body wear a hairline ring outside the limb, breathing in
  OPACITY (a size pulse reads as a body that changes size). A halo says "this
  object is bright"; a ring says "the page is pointing at it".
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

## 2c. Interaction (2026-09-18, the "it selects at random" pass)

- **A click is not the start of a drag.** Selection fired on `pointerdown`, so
  every camera orbit that began over the population selected whatever was under
  the press and — through `selectBody()` → `setCamLock()` — threw the camera
  into a lock on it. It now fires on `pointerup`, and only when the pointer
  stayed inside `CLICK_SLOP_PX` (6 px, or `TOUCH_SLOP_PX` 12 for a finger or a
  pen — a touch never lands as still as a mouse) for less than `CLICK_MAX_MS`
  (700). Same rule mars.html already carries: a confirmed drag is the camera's,
  a bare click is a selection. Right and middle buttons never select.
- **Picking is measured in PIXELS.** `pick()` takes `{ camera, ndc, pixels }`
  and the accept radius is THE DRAWN RADIUS — `gl_PointSize / 2` plus `GRAB_PX`
  of grace for a 2 px body. It cannot drift from what is drawn, because the
  attenuation clamp, both pads and the pixel floor live once in `SPRITE` and are
  interpolated into the GLSL, and `drawnPx()` is the JS mirror of `POINT_VS`
  (`clip.w` IS −viewZ for a perspective camera — the exact term the vertex
  shader attenuates by). The rule a visitor can learn: you can click what you
  can see, and only what you can see.
- **Rock meshes are picked first, and exactly.** A body close enough to be drawn
  as a shaped rock was previously not clickable at all: only the two point
  clouds were in the pick set, and a meshed object's sprite is suppressed
  (`_meshed` ⇒ alpha 0), so the one object on screen with a real silhouette was
  the one thing a click could not hit.
- **Hover answers "what am I about to click?"** before the click, because the
  population is dark bodies a few pixels across. `hover(index)` seats the same
  reticle the selection uses (dimmer), `hoverText(index)` fills `#neo-hover-tip`
  — `position: fixed` (it is placed from clientX/clientY) and
  `pointer-events: none` (a tooltip that can be hovered steals the pointermove
  keeping it alive). Throttled to 70 ms: a pick projects the whole loaded
  catalogue, which is sub-millisecond but not free, and no hover needs frame rate.

## 2d. Photometry (2026-09-18, the "more visual accuracy" pass)

Everything about how a body looks is now derived from published quantities
through the kernel, and `tests/solar-system-neo-smoke.spec.js` asserts the page
agrees with `js/neo-orbits.js` object by object.

- **Drawn size is a TRUE PROJECTED SIZE.** `aRadius` is `drawnRockRadius` of the
  object's diameter, put through the perspective division in `POINT_VS`
  (`projectionMatrix[1][1]`, which is 1/tan(fov/2)), floored at `SPRITE.minPx`
  where it falls below a pixel. **The attenuation curve it replaced saturated at
  both ends** — `clamp(u_att / viewDepth, 0.55, 2.30)` is at its ceiling for
  anything closer than ~13 scene units and at its floor past ~54, so a whole
  framing came out as one wall of same-size rocks and depth did not read at all.
  It also means the impostor and the mesh that replaces it inside `ROCK_RANGE`
  **subtend the same angle**, so nothing jumps size across the LOD line; the
  browser gate measures the mesh's own projected limb and compares.
- **The scattering law is LOMMEL–SEELIGER, not Lambert.** Single scattering off
  a dark particulate regolith, ∝ μ₀/(μ₀+μ): nearly FLAT across the disc where a
  Lambertian sphere darkens toward the limb. This is the difference between a
  body that reads as a disc and one that reads as a shiny ball — it is why the
  full Moon looks like a disc. Both the impostor and the rock meshes use it.
- **The phase function is the IAU H–G law** the published H and G are defined in
  (`phaseHG`, mirrored in GLSL — change both together). It carries the
  opposition surge for free. **It is held past α = 120°** (`HG_ALPHA_MAX`): the
  fit says nothing beyond that and its basis functions run to zero there, which
  drew every backlit object as nothing at all. A floor is honest, an
  extrapolation off the end of a published fit is not.
- **Illumination falls as 1/r².** `aIllum` is (1 AU / r)² from the worker's own
  heliocentric distance, so an object at 3 AU is 9× darker than the same object
  at 1 AU. Before this, everything was lit as though it sat at Earth's distance.
- **Albedo and taxonomy are MEASURED where JPL has them.** `opticalProperties`
  returns the measured albedo when the archive published one, else the class
  mean from `TAXONOMY` (Tholen/Bus–DeMeo means: C 0.06, S 0.20, V 0.36, E 0.45,
  D 0.04, cometary nucleus 0.04), else the IAU defaults — and reports WHICH in
  `measured`. The panel prints the coverage. **The albedo is load-bearing twice
  over**: it sets the tone, and it sets the size, because D = 1329/√p·10^(−H/5)
  — assuming 0.14 for a C-type draws it √(0.14/0.06) = 1.53× too small.
- **The optional columns can never take the catalogue down.** `albedo` /
  `spec_B` / `spec_T` are UNVERIFIED spellings on an egress-blocked API, and a
  `fields` list JPL does not recognise is rejected whole. `SBDB_FIELDS` is
  therefore split core / photometry, and `api/neo/catalog.js` retries once
  without the optional list on a 4xx, self-reporting `photometry_fields:
  'dropped'`. One production request settles it.
- **Level carries a DISCLOSED display normalisation** (`SPRITE.gain`,
  `SPRITE.stretch`): the population spans several decades of reflected radiance
  and no linear gain shows both ends. Neither constant changes anything
  relative. Shape from Lommel–Seeliger and level from H–G is a rendering
  approximation, not a self-consistent Hapke model, and the header says so.
- **Opacity rises with the light the body returns** (floor 0.30). The drawn disc
  is inflated by the log size map — `drawnRockRadius` draws a 1 km rock at about
  2 000 km — so a fully opaque backlit body punched a solid black hole in the
  sky, occulting a patch thousands of times larger than the real object could.
  The floor keeps a body crossing a bright background reading as a shadow.
- **The data card reports V, exactly.** `apparentMagnitudeV(H, r, Δ, α, G)` with
  r, Δ and α from the propagated vectors — the magnitude AS SEEN FROM EARTH, not
  from the drawn scene. At r = Δ = 1 AU, α = 0 it returns H, which is the
  definition and what the kernel gate asserts.

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
  **That was necessary and not sufficient** — the gate decides WHETHER the class
  of labels is drawn, not whether any two of them collide, and with Earth in
  front of the Sun a dozen of them still stacked across the glare (2026-09-18,
  reported from a live screenshot). The cap is now `LOCAL_LABEL_MAX` = 8 AND a
  screen-separation test: `_labelClear()` projects each candidate and drops it
  if it lands within `LABEL_SEP_NDC` of one already placed — nearest object
  first, so the closer one keeps its label. Separation is in NDC because the
  labels are `sizeAttenuation:false` sprites, i.e. sized as a fraction of the
  VIEW. What is dropped is not lost: hover names it. **Off-screen is not a
  conflict** — an early version also culled labels outside the frustum, which
  made the label set depend on the framing, churned a canvas raster on every pan
  and turned the local-frame browser gate flaky. The pass re-runs on camera
  motion as well as on a worker frame, throttled — otherwise orbiting with the
  SIM PAUSED never re-places anything, because the frame that normally does it
  never arrives.
- **Label re-raster per worker frame.** A flyby label's text carries its
  distance, which changes every frame at warp speed; rebuilding a canvas
  texture per frame × 12 labels was the most expensive thing on the page.
  Throttled to 4 Hz per label.
- **Gaussian year ≠ 365.25 d.** The first kernel test derived a period from
  365.25 and "failed" at 1.4e-8; the period is 2π/n with k = 0.01720209895.
- **"(2024 YR4)" ≠ "2024 YR4".** SBDB's `full_name` for unnamed objects is
  the designation in parentheses; the "same as designation → ship null"
  byte-saver has to strip them.
- **Points raycast sorts along the ray, not across it.** The first `pick()`
  re-sorted hits by `distanceToRay` so a click meant "nearest the cursor" —
  which is still the right idea and still the wrong measure. `distanceToRay` is
  a perpendicular distance in SCENE units, and the threshold it was compared
  against (0.012 × the camera range) is a world-space radius: on a log radial
  scale that is a fraction of a pixel out at Neptune and a third of the screen a
  few hundredths of a unit from the eye. A click on empty sky routinely returned
  an object hundreds of pixels away, which is what "it selects random NEOs"
  looks like from the outside. Measure in pixels (§2c).
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
- **A sprite that is a light and a mesh that is a rock are two different
  objects.** The LOD line was also a species line: an additive PSF out here, a
  sunlit body up close. Nothing failed — it just quietly said the population
  emits light. One lighting model now spans both (§2b).
- **`gl_PointCoord.y` runs DOWN the screen.** The impostor's normal is built in
  VIEW space, where +y is up, so the sphere normal is `vec3(q.x, -q.y, …)`. With
  the sign wrong the terminator tilts the wrong way and the crescent points at
  the wrong side of the sky — a picture that still looks plausible.
- **The pad in `POINT_VS` and the `bodyR` in `POINT_FS` were one number in two
  places.** The quad grows to make room for the reticle and the coma and the
  body shrinks inside it by the same factor — so the vertex shader now PASSES
  the body's share of the quad (`vBodyFrac`) instead of the fragment shader
  re-deriving it, and `drawnPx()` is the one JS mirror the pick radius uses.
- **A size curve that saturates is not a size.** The old attenuation clamp was
  at one end or the other for every framing anyone actually uses, so the
  population drew at a near-constant pixel size and the scene lost its depth
  cue entirely. Nothing errored; it just looked like wallpaper.
- **An inflated body must not occult like a real one.** Drawn radii are
  log-inflated by ~3 orders of magnitude, so an opaque backlit rock erased a
  patch of sky no real 1 km body could touch. Opacity follows the returned
  light now, with a floor for the silhouette.
- **A published fit has an end.** Running the H–G phase function to α = 180°
  took every backlit object to zero brightness — plausible-looking, and wrong,
  because the law is fitted to α ≲ 120° and a real body still shows a crescent.
- **Albedo is inside a square root.** Deriving D from H at a blanket 0.14 draws
  every dark object too small — 1.53× for a C-type — which is a size error that
  looks like a rendering choice.

## 4. Open items

- Production self-report: after the first deploy, read
  `/api/neo/catalog?tier=pha` `groups.*.field_map` and `/api/neo/watch`
  `sources.*` and trim the candidate lists in `api/_lib/neo-sources.js`.
  **Read `groups.*.photometry_fields` in the same request**: 'dropped' means JPL
  refused the optional albedo/taxonomy columns and every tone and derived size
  on the page is a class mean — fix the spelling or trim
  `SBDB_FIELDS_PHOTOMETRY`. `groups.*.photometry.albedo_measured` /
  `.spec_measured` say how many rows actually carried them.
  Confirm the interstellar query (`e > 1.1`) returns 1I/2I/3I and nothing
  else.
- Vercel edge response size for `tier=all` (~3.4 MB) is untested in
  production. If it is refused, the page keeps `bright` and says so;
  the fallback is to serve `all` in two halves (`sb-cdata` on H).
- The synthetic flybys in the smoke spec share Earth's mean motion, so
  their geocentric trails are points; a real flyby draws a proper arc.
- Fireballs are listed, not drawn on the sphere: Earth's drawn rotation is
  not tied to UT (rotation.y accumulates), so a lat/lon marker would be
  placed on the wrong meridian. Tie the Earth mesh to GMST first.
