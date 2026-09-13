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

## 4. Open items

- Production self-report: after the first deploy, read
  `/api/neo/catalog?tier=pha` `groups.*.field_map` and `/api/neo/watch`
  `sources.*` and trim the candidate lists in `api/_lib/neo-sources.js`.
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
