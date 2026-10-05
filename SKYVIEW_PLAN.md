# SkyView — plan, decisions, and status

`skyview.html` answers one question for one person: **what can I see in my sky
right now?** It lists the top 10 objects by visibility from the visitor's
location and draws their sky with the top 100 labelled — and it draws the
Galaxy Map's objects (black holes, quasars, superclusters) where they really
are overhead, even though no eye can see them.

Shipped 2026-10-05. Nav: Local Space → Maps & missions (took Lunar Colony's
menu slot; Colony stays on the hub and in the catalogue).

## 1. Architecture

```
scripts/build-skyview-catalog.mjs ──► data/skyview/sky-catalog.json (365 KB)
   ├─ d3-celestial (BSD-3; Hipparcos)   stars V≲6, names, figures, DSOs, Milky Way
   └─ galactic-map.html CATALOG         extracted + evaluated as data, cross-matched

js/skyview/sky-engine.js      PURE  frames, atmosphere, magnitudes, visibility, rise/set
js/skyview/sky-projection.js  PURE  one stereographic view, two framings (dome / look)
js/skyview/sky-catalog.js     PURE* unpack + evaluateSky (the ONE evaluation per instant)
js/skyview/sky-renderer.js    DOM   2D canvas; draws evaluateSky's output, computes nothing
js/skyview/skyview-page.js    DOM   location, clock, input, panels
```

Gates: `node tests/skyview-engine.mjs tests/skyview-catalog.mjs` (CI:
`.github/workflows/skyview-kernels.yml`) and
`npx playwright test tests/skyview-smoke.spec.js`.

## 2. Decisions

1. **No second ephemeris.** GMST, precession, the Moon (Meeus 47), the Sun and
   Earth (VSOP87D) come from `js/neo-space.js` / `js/horizons.js`. SkyView adds
   the horizon, the atmosphere, magnitudes and visibility — nothing else.
2. **Rank by MARGIN in magnitudes** (tonight's limit − observed magnitude). One
   physically meaningful number that compares a planet, a star and a galaxy.
   The limit is an EMPIRICAL twilight + moonlight + light-pollution model and
   the page says so. Default sky is *suburban* (mag 5.0) — where most visitors
   stand.
3. **Landmarks are never ranked.** A galaxy-map object with no naked-eye
   counterpart is drawn (hollow magenta diamond) and listed under "Up there,
   but invisible", never given a fake magnitude to reach a top 10.
4. **2D canvas, not three.js.** ~5 000 points and ~700 segments redrawn on
   change; runs on a software rasteriser, needs no import map.
5. **Stereographic, two framings, one rule.** `right = centre × up`: the
   overhead dome has east on the LEFT, Look mode facing north has east on the
   RIGHT. Both are pinned.
6. **Faint stars are ghosted, not hidden** — the chart shows what is up there
   AND which part of it you can see. Sun and Moon have a floor size,
   disclosed in the legend.
7. **Location is the site-wide current view** (`ppx_user_location`); URL
   `?lat=&lon=` override it for one visit without writing it. Times print in
   the device's zone WITH the zone name (no tz database for an arbitrary
   lat/lon).

## 2b. The time machine (2026-10-05, second pass)

The page forecasts, not just reports. `js/skyview/sky-predict.js` (PURE,
`tests/skyview-predict.mjs`) + `js/skyview/skyview-forecast-ui.js` (DOM).

8. **A night is local-mean-solar noon → noon** at the SITE, and after 06:00
   LMT the upcoming evening is night 0. Device-clock times are printed with
   their zone; the calendar's vertical axis is the site's solar time.
9. **One grid per forecast, anchored at the slider's START.** `buildNightGrid`
   samples 30 nights × 97 steps once (~60 ms): frame matrix, Sun altitude,
   Moon. A fixed object then costs one 3×3 multiply per sample, so all ~120
   Galaxy Map objects forecast in a few ms. Scrubbing never re-anchors (only
   Live, Tonight and a new location do), so dragging through a month never
   rebuilds what it is reading.
10. **Galactic objects are FIXED; the sky moves because the Earth does.** At the
    same clock time a fixed object is 0.9856° further west each night (the
    sidereal drift) — that is the motion "same time, each night" playback and
    the nightly track dots show. The Moon and planets are evaluated per sample
    (`bodyTarget`) because they also move against the stars.
11. **Tracks: at most 3, colour fixed to the OBJECT.** The first three dataviz
    slots validate all-pairs for colour-vision deficiency on this sky (worst
    CVD ΔE 9.4); a fourth would pair yellow with orange, which fails. The 4th
    track drops the oldest; an untracked object's colour is freed, never
    shifted onto the survivors.
12. **"Best night" is a stated heuristic** (usable hours × (1 − 0.7 · Moon lit ·
    Moon-up fraction)); the calendar and table print hours and the Moon
    separately. The season date is when the object is opposite the Sun (it
    crosses the meridian at local midnight), from the Sun's own RA.

## 3. Scars (each one measured while building — don't re-learn them)

- **The galaxy map had ten misplaced stars.** ε Eridani 8.7° off, η Eridani
  17°, Pollux 1.4°, Aldebaran 0.7°, Rigel/Sargas/ζ²/η/ι¹ Sco/Acamar 0.3–0.4°.
  Invisible in a 3D map, obvious on a sky chart. Fixed in `galactic-map.html`
  to the Hipparcos-derived (l, b); `GALACTIC_HIP` pins each star's IDENTITY by
  Hipparcos number (never inferred from the map's own position), and
  `tests/skyview-catalog.mjs` fails past 0.2°.
- **The planet series are in two frames.** Mercury–Mars (`horizons.js` mean
  elements, Table 31.b rates) are J2000; Earth and Jupiter–Neptune (VSOP87D)
  are OF DATE despite `outer-planets.js`'s header saying J2000 — the L1
  constants are Meeus's of-date values. `PLANET_FRAMES` is the one table. The
  test measures each series' longitude DRIFT against an independent J2000
  Kepler propagation over 1800–2200 (raw outer planets ≈ 1.4°/century =
  precession; rotated ≈ 0). Endpoint comparisons were tried first and are
  inconclusive (Uranus's mean elements are themselves ~0.9° off).
- **The galactic centre is DARK in the Milky Way raster** — it sits behind a
  dust lane, as on the real sky; the brightest contour is the Sagittarius Star
  Cloud a few degrees east. The test asserts both.
- **The outer Milky Way contour wraps the RA seam** (two rings that each go
  all the way round), so it is rasterised by meridian rays from the south
  celestial pole (outside the band), not filled as planar polygons.
- **Same-time drift is NOT an azimuth change.** Two nights at one clock time
  move a star 2 × 0.9856° in HOUR ANGLE, which is ≈ 1.54° on the sky for Vega
  but only 0.77° of azimuth (high stars sweep azimuth slowly). The browser gate
  measures great-circle separation.
- **A grid row is as tall as its tallest cell.** The chart grew to the
  sidebar's height and the dome overflowed the screen; the stage is now
  `align-self:start` + sticky and sized from the viewport.

## 4. Roadmap (not built)

- **Satellites.** The ISS is often the brightest thing in a twilight sky. Add a
  satellite source: `/api/celestrak/tle?group=stations` → `satellite-tracker.js`
  `propagate` (SGP4 WASM) → `pass-predictor.js` `lookAngle`, Earth-shadow test,
  standard-magnitude + diffuse-sphere phase law (`m = m_std + 5 log(d/1000) −
  2.5 log F(φ)`). Rank alongside everything else; show pass times in the card.
- **Bright comets / NEOs** from the existing `/api/neo/*` routes when one
  crosses naked-eye or binocular brightness.
- **Aurora layer** from `/api/noaa/aurora-grid` (OVATION) as a poleward glow on
  the horizon, gated on the verdict engine's aurora oracle.
- **Weather.** Cloud cover from the point forecast already used by
  `js/local-sky.js` — "visible" should be able to say "if the clouds part".
- **Look-mode pinch zoom** on touch (buttons and keys exist).
- **Year view** of the calendar (12 months × the season curve) and an
  "observing plan" export (ICS / CSV of tonight's windows for tracked objects).
- **Retrograde loops** drawn against the stars for planets (RA/Dec trail over
  months, not alt/az) — the kernel's `bodyTarget` already supports it.
