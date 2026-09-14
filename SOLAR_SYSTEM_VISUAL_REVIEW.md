# Solar System orrery — visual review and improvement plan

**Page:** `solar-system.html` (4008 lines) + `js/neo-*.js`, `js/flare-*.js`
**Reviewed:** 2026-09-14, at `8e72cf8` (flare geometry kernel) on a software rasteriser
**Status:** review complete. One finding — **L2**, the CME — is now implemented (see §3.2);
everything else is still the plan.

> **Scope note.** This is a review of the *visuals*, in three areas the author
> named: the Sun's animation, near-Earth objects, and flare propagation + NEOs
> as explorable layers. It does not touch the orbital mechanics, the ephemeris,
> the NEO kernel maths, or the flare geometry kernel — all of which were checked
> against their gates and are not implicated in anything below.

---

## 0. How this was measured (so the numbers can be re-derived)

Both live feeds are egress-blocked from this sandbox, so the capture harness
mocks them the way the specs do:

- **JPL** (`ssd-api.jpl.nasa.gov`) returns 403. The NEO catalogue was composed
  through the route's own pure composers (`api/_lib/neo-sources.js`
  `composeCatalogResponse` / `composeWatchResponse`) over a synthetic 1 418-object
  population with a realistic Apollo/Amor/Aten mix, the named objects (Apophis,
  Bennu, Eros, Phaethon, Ryugu, Itokawa, 2024 YR4), five comets, one interstellar
  object, and four synthetic flybys at 2.4 / 6.8 / 13.5 / 30 LD. **Population
  density is the thing a visual review of this layer has to judge**, so the
  count matters — a five-object fixture would have hidden every finding in §2.
- **SWPC** is `connect_rejected`. Space weather was driven with one synthetic
  `swpc-update` on the feed's documented event contract (`js/swpc-feed.js`
  `_buildState`), the same technique `tests/solar-system-flare.spec.js` uses:
  X2.8 at N12W40, four active regions, Kp 7, Bz −18 nT.

**Two capture artifacts to know about before reading any screenshot:**

1. **FPS reads 3–5 in every frame.** That is SwiftShader, not the page. No
   performance claim below rests on it.
2. **`#backdrop` dims the whole canvas by 45 % whenever the info panel is open**
   (`solar-system.html:269–273`, `rgba(0,0,0,.45)` at z-index 25). The first
   measurement pass read a disc ceiling of exactly 140/255 — which is
   255 × (1 − 0.45) — and that was the overlay, not the render. Every number in
   §1 was re-measured with the panel closed. *This is itself finding **U1**.*

Harness + screenshots: `scripts/review/` is **not** where these live — they were
run from a scratch directory and are attached to the review, not committed.

---

## 1. The Sun

### 1.1 The disc is fully clipped in red and green, at all times — S1

Measured on the brightest 8 000 disc pixels, panel closed, 1400 × 900:

| state | disc RGB | luminance σ | R,G at 255 |
|---|---|---|---|
| quiet | (255, 255, 243) | 1.64 | **100 %** |
| X2.8 flare | (255, 255, 255) | **0.00** | **100 %** |

A luminance standard deviation of **0.00** across the disc during a flare means
literally zero spatial structure: the granulation, the sunspots, the filament
channels and the active regions are all present in the shader and all of them
are above the clip ceiling. The star renders as a featureless white cut-out.

Quiet is barely better — R and G pinned at 255 with B at 243 is exactly the pale
yellow-green cast in the screenshots, and it is two channels at the ceiling, not
a colour choice.

**Mechanism.** `sunFS` accumulates emission and writes it raw:

```glsl
col += base * bmod * limb * 1.80;     // base ≈ (1.0, 0.79, 0.50), bmod ∈ [0.05, 3.0]
…
gl_FragColor = vec4(col, 1.0);         // solar-system.html:1025
```

`base.r · bmod · limb · 1.80` reaches ≈ 5.4 before the network, nanoflare, rim,
spicule and transition-region terms are added on top. Nothing bounds it.

**`renderer.toneMapping = THREE.ACESFilmicToneMapping` is set at line 815 and
never runs on this shader.** three.js applies the tone curve and the output
colour-space conversion through the `<tonemapping_fragment>` and
`<colorspace_fragment>` chunks, which only exist in the built-in materials. A raw
`ShaderMaterial` that writes `gl_FragColor` directly gets neither. **All 12 raw
`gl_FragColor` writes in `solar-system.html` and all 3 in the NEO modules bypass
it** — the Sun, both glow shells, the chromosphere, every planet, the wind, the
heliospheric current sheet, the magnetosphere, and the NEO rocks and points.

**This is the single highest-leverage finding in the review, and it is not a
one-line fix.** An A/B was run to check: adding the two chunks to `sunFS` alone
moved the flare-state σ from 0.00 to 0.10 and left the disc 100 % clipped,
because the input is so far above the curve's working range that ACES cannot
recover it. **Exposure and curve have to move together.**

**Plan — S1.**
1. Add `#include <tonemapping_fragment>` + `#include <colorspace_fragment>` to
   every custom fragment shader on the page, in one commit, so the page stops
   having two colour pipelines.
2. In the same commit, bring `sunFS`'s emission into the curve's range: the
   `× 1.80` gain and the additive term weights need re-fitting against a target
   of "quiet disc centre lands near 0.8 in linear, limb near 0.45", not against
   what looks right on a clipped display. Sun.html solved the same problem with
   a real HDR chain (`js/sun-post.js`); the orrery does not need the mip-chain
   bloom, but it does need to stop handing the framebuffer values above 5.
3. Gate it: extend `tests/solar-system-flare.spec.js`, or add a sibling spec,
   with the measurement above — **disc luminance σ > 2 in quiet and > 4 under
   X-class, and R,G clipped on under 20 % of disc pixels**. That test fails today
   and is what stops the fix from being undone.

### 1.2 The flare terms saturate at C-class, so the page never shows a sunspot — S2

`u_flare_str` is fed straight from the feed's `xray_intensity`
(`solar-system.html:3751`), which is
`clamp01((log10(flux) + 9) / 6)` (`js/swpc-feed.js:229`). That maps:

| GOES class | flux | `u_flare_str` |
|---|---|---|
| A1 (background) | 1e-8 | **0.17** |
| C1 | 1e-6 | **0.50** |
| M1 | 1e-5 | 0.67 |
| X1 | 1e-4 | 0.83 |
| X2.8 | 2.8e-4 | 0.91 |

The shader's flare terms were written as if this ran 0 → ~0.3. It does not:

```glsl
arDark  += inAR * core * (1.0 - u_flare_str*2.5) * 0.5;   // negative above 0.40
filDark +=  … * max(0.0, 1.0 - u_flare_str * 2.5);        // identically 0 above 0.40
```

**At C1 — which is most days — the sunspot term goes negative and the filament
channels vanish entirely.** At quiet background (0.17) the spots are already 42 %
erased. The two features the shader works hardest to draw are the two it
switches off first.

The whiteout has the same root: the disc-wide temperature mix

```glsl
float flareTemp = u_teff * (1.0 + u_flare_str * 0.55);
vec3  base      = mix(blackbody(u_teff), blackbody(flareTemp), u_flare_str * 0.75);
```

is **global**. A real X-class flare brightens ~10⁻⁴ of the visible disc in white
light and is invisible in the continuum outside the ribbons. Here it reheats the
entire photosphere to 8 956 K.

**Plan — S2.** Make every flare term spatially weighted by the active region it
belongs to, and re-scale the thresholds against the real `xray_intensity` range:

- `arDark` loses its `u_flare_str` factor completely — **a sunspot does not
  disappear because the region flared**; if anything it is more visible.
- The temperature mix multiplies by an AR-proximity weight (the `arBrite`
  accumulator already computes exactly this) so only the flaring region heats.
- `filDark`'s flare disruption becomes `max(0.35, 1 - u_flare_str * 0.6)` —
  eruption thins a filament, it does not delete the channel, and the channel is
  still there after the eruption.
- Re-derive the constants from the table above, with `0.17` as "nothing is
  happening" rather than `0.0`.

**This is the fix that makes an X-class flare look like an event instead of a
lighting change**, and it composes with S1: once the disc is not clipped, a
*locally* brightened ribbon pair actually reads.

### 1.3 The corona is two hard-edged spheres — S3

```js
[{r:1.9, fs:sgInFS}, {r:2.8, fs:sgOutFS}].forEach(({r, fs}) => {
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 24), …BackSide…));
});
```

Two back-side spheres whose alpha is `pow(rim, n)` — which peaks **at the
sphere's own silhouette**. The result is a bullseye: a bright orange annulus with
a hard outer edge at r = 1.9, a duller brown disc with a hard outer edge at
r = 2.8, and nothing beyond. At `Sun View` framing the boundary of the r = 2.8
shell is a visibly **faceted 24-gon**. The Sun reads as a target, not a star.

Two further consequences:

- The shells are fixed at 1.9 and 2.8 **scene** units while Earth is drawn at
  `simDist(1.0) = 2.5 + 4.2·ln(2.8) ≈ 6.8`. So from Earth View, the corona is a
  hard-edged orange smear covering a quarter of the frame (visible in every
  Earth-local screenshot). It is 41 % of the Sun–Earth distance wide.
- The prominences, the coronal loops and the flare arcade — the physics the page
  actually models — are drawn *inside* that wash at
  `MeshBasicMaterial` opacity 0.18, so they are nearly invisible. The X2.8
  screenshots show the arcade as a few grey hairlines against a solid orange
  plate.

**Plan — S3.** Replace the two shells with **one** radially-integrated corona:

- a single back-side sphere at a generous radius with a fragment shader that
  integrates a `r^-2.5`-ish density along the view ray and **fades to zero well
  inside its own geometry**, so the mesh silhouette is never the visual edge;
- segments 24 → 96 (the geometry is one mesh; the cost is nothing);
- brightness scaled by `u_flare_str` so an eruption actually lights the corona;
- and the loops/prominences/arcade lifted above it in `renderOrder` with their
  opacity raised, because they are the modelled physics and the wash is
  decoration.

The visual reference is `sun.html`'s volumetric corona
(`js/corona-volumetric.js`), **but do not import it** — that is a full march on
camera layer 1 with an accumulation buffer, and the orrery draws the Sun at
30 px for most of a session. A single integrated shell is the right rung here.

### 1.4 Smaller Sun findings

- **S4 — one sunspot, no penumbra.** The AR shader draws a hard dark core
  (`core = 1 - smoothstep(arR*0.15, arR*0.45, angD)`) with no umbra/penumbra
  split. Four regions were dispatched; one dot is visible. Cheap fix: two nested
  smoothsteps and a warm penumbra ring.
- **S5 — the flare kit is thinner here than on sun.html.** The orrery imports
  `js/flare-arcade.js` but not `js/flare-ring.js` (flash rings) or
  `js/flare-ribbons.js` (H-α ribbons), both of which already exist, are pure,
  and are gated. Wiring them in is the cheapest possible upgrade to "a flare
  looks like a flare" and adds no new physics.

---

## 2. Near-Earth objects

**The NEO layer is the best-built thing on this page.** The point shader is a
real PSF (Gaussian core + halo + diffraction spikes on the brightest, additive),
size and alpha are driven by absolute magnitude inside an honest 1.7–5.6 px band,
the rock meshes have seeded shape families and real rotation periods, the comet
tails are physical in direction and schematic in length *and say so*, and the
Earth-local frame with its 1/5/10/20 LD rings is the single strongest image the
page produces. The findings below are about **legibility and discoverability**,
not about the rendering being wrong.

### 2.1 The default palette hides the population's structure — N1

`colorMode` defaults to `'natural'` (`js/neo-layer.js:326`), whose asteroid range
is `sType 0xd6bb95 → cType 0x9a9691` — tan to grey, a very narrow band. That is
honest: it is roughly what a camera would record. But at 1 400 objects on a black
field the whole population collapses into **one undifferentiated dust haze**
clustered near the Sun, and the class structure — Apollo vs Aten vs Amor vs PHA,
which *is* the scientific story of a near-Earth population — is invisible.

Switching `Colour by class` on transforms it: red PHAs, orange Apollos, cyan
Atens, purple Amors resolve into a legible, differentiated swarm. That toggle is
the sixth checkbox in a collapsed accordion section.

**Plan — N1.** Keep both palettes; change the affordance. Replace the checkbox
with a two-button segmented control (`Natural | Class`) at the top of the NEO
panel with the class legend beside it, the way the pollution lab separates its
magnitude scale from its categorical `SERIES_COLORS`. Leave `natural` the
default for the establishing view; make one tap reach the data-viz palette.
(`tests/solar-system-neo-smoke.spec.js` already drives `colorMode` — extend it
to the new control rather than adding a second state store.)

### 2.2 Labels have no collision handling — N2

Measured in the Sun View capture: `20 LD` and `10 LD` overprint each other,
`1 LD` lands on a planet, and `2P/Encke` renders directly over the Sun's glare
where it cannot be read. In the Earth-local views the object labels float with no
leader line, so `2026 RA9 · 2.40 LD` sits ~200 px from a dot you cannot pick out.

**Plan — N2.** Two changes, both local to `js/neo-layer.js`:
- a screen-space declutter pass over the ≤ ~12 live label sprites (project,
  sort by priority — selected > in-zone > rings — and suppress any whose box
  overlaps a higher-priority one already placed);
- a 1 px leader line from each object label to its object, which is what makes
  a label at 200 px distance mean anything.

### 2.3 The selected object renders as a black silhouette — N3

`ROCK_FS` lights from the world origin with a night-side floor of
`0.05 + wrap(0.10)` and a rim term of `0.06`. That is physically right, and the
consequence is that the flagship "here is the object you selected" view is a
featureless black blob whenever the camera lands on the night side — which is
half the time, and was the case in the capture.

**Plan — N3.** Do not brighten the night side — that would make the shading lie.
Instead:
- raise the rim term for the **selected** object only (it already has a `u_glow`
  uniform; give it a selection analogue), so the terminator reads as a crescent
  rather than a void;
- and have `setCamLock` on an NEO place the camera on the **sunward** side of the
  lock offset by default, the way a mission camera would frame it. The user can
  still orbit into the dark.

### 2.4 Smaller NEO findings

- **N4 — the Earth-local frame is muddy.** Measured: inside the frame the
  background reads (23, 26, 33) vs (11, 13, 19) outside — a broad, flat, +12-level
  additive wash with a hard elliptical silhouette. It is **not** occluding
  anything (that was a first-pass misread; additive cannot darken). The source is
  Earth's magnetosphere shell — a radius-1.2 back-side additive sphere, i.e.
  **10 × the drawn Earth radius** — sitting in the same volume as the 1–20 LD
  rings. Two honest layers that individually read fine, stacked, produce a flat
  plate. Fix is the S3 fix applied to the magnetosphere shell (fade inside its own
  geometry), plus a `renderOrder` split so the LD rings sit above it.
- **N5 — the ±3-day geocentric trails the module header promises were not
  visible** in any in-zone capture. Worth confirming against a live catalogue
  before changing anything — the fixture's flybys are on synthetic circular
  orbits and may simply not have triggered a track request.
- **N6 — the LD ring labels are placed at fixed azimuths**, so at Earth View
  `5 LD` lands in the bottom-left corner under the time bar. Place them at the
  ring's screen-space top instead.

---

## 3. Layers you can explore

This is where the page has the largest gap, and it is an architecture gap rather
than a rendering one.

### 3.1 The NEO layer has a layer model; the Sun has none — L1

`js/neo-layer.js` carries a real visibility model —
`{ asteroids, comets, population, local, radiants, orbit, labels, colorMode }` —
surfaced as six checkboxes plus a population filter, each driving the scene
graph. It is a good foundation and the rest of the page should look like it.

**The entire solar side has exactly one toggle: `#tog-wind`.** There is no way to
show or hide the coronal loops, the prominences, the flare arcade, the coronal
rain, the CME, the heliospheric current sheet, or the magnetosphere. They are all
on, all the time, stacked on top of each other, which is most of why §1.3 reads
as mud.

**Plan — L1.** Add a **Layers** section to the panel, above `Bodies`, with the
same shape as the NEO block, owning:

| group | layers |
|---|---|
| Solar surface | Active regions · Coronal loops · Prominences · Coronal rain |
| Eruptive | Flare arcade · Flash + ribbons (S5) · CME cone |
| Heliosphere | Solar wind · Parker spiral / current sheet · Magnetosphere |
| Small bodies | (the existing NEO block, moved in) |

One flat `layers` object on the page, one `applyLayers()` that writes `.visible`,
persisted to `localStorage`. Three presets — **Orrery** (planets + orbits only),
**Space weather** (everything solar), **Small bodies** (NEO + showers, solar wash
off) — because the useful thing is not 14 checkboxes, it is three good defaults.

The two 3D pages that already do this well are `earth.html` (`#layer-panel`) and
`ring-current.html`; copy the *shape*, not the code.

### 3.2 Flare propagation is a loop, not a propagation — L2 · **IMPLEMENTED 2026-09-14**

> **Status: done, for the modeled path.** `js/orrery-rope-layer.js` now draws the
> Compounding Watch's own flux-rope surface on the orrery, off the ONE shared
> provider, on the page's own sim clock. The three problems below are fixed for
> every CME the ensemble models; the particle burst survives only as the
> no-DONKI fallback and is suppressed whenever a rope is drawn, so its wrap bug
> can no longer contradict anything on screen. Gates: `tests/orrery-rope-layer.mjs`
> (4 800 assertions) + `tests/solar-system-rope.spec.js` (5 browser tests on the
> REAL committed WASM). The original finding is kept below unedited.

This one matters most for the author's stated framing, because **the page
announces an arrival time that the picture cannot honour**.

`updateCME()` (`solar-system.html:2062–2085`):

```js
cmePhaseArr[i] += cmeSpeedArr[i] * Math.min(simSpeed, 50);
if (cmePhaseArr[i] > 1.0) cmePhaseArr[i] -= 1.0;    // ← wraps
```

Three separate problems:

1. **Particles wrap.** The "CME" is a recirculating stream over its whole radial
   range, not a shell leaving the Sun. Particles start at `Math.random()*0.25`,
   so the front is smeared across a quarter of the range on frame one and is
   everywhere within a cycle. **You cannot watch a CME travel from the Sun to
   Earth**, which is the single most compelling thing this page could show.
2. **Its clock is decoupled from sim time.** `Math.min(simSpeed, 50)` caps the
   advance for legibility — a defensible call on its own — but it means the drawn
   position has no relationship to the `CME ETA ~1.3d` in the HUD beside it.
   A picture that contradicts the number next to it is the failure mode this
   repo's other pages go out of their way to avoid.
3. **The cone is not a cone.** `y = cmeYOff * (r / WIND_MAX_R) * 0.8` flattens the
   cone toward the ecliptic as it propagates; a real CME expands self-similarly.

And the CME shares the wind's sprite and additive blend, differing only in tint,
so at a glance an eruption and the ambient wind are the same thing.

**Plan — L2.** Make the CME a **propagating front on the sim clock**:

- Give it a launch JD and a speed in km/s from the feed. Radius comes from
  `(simJD − launchJD)` and the speed — no per-frame phase accumulator, no wrap,
  so scrubbing time backwards un-launches it correctly and the arrival lands
  where the ETA says.
- Draw the leading edge as an actual **shock surface** (a spherical cap on the
  cone, alpha ∝ local compression) with the particle cloud behind it, so the
  front is a front.
- Keep the cone's half-angle constant in angle, not in `y`.
- Flash the drawn Earth and fire the existing storm-level UI **at the moment the
  front reaches `simDist(1.0)`**, so the geometry and the ETA are the same claim.
- The feed already supplies `cme_eta_hours`; `js/flux-rope-forecast.js` is the
  one shared provider for anything more sophisticated — **consume it, do not add
  a second ensemble compute here** (the dashboard rule in CLAUDE.md §4.4 applies).

Gate: extend `tests/solar-system-flare.spec.js` — it already drives a synthetic
X-class through `window.__solarFlare` and reads `cmeActive` / `cmeAxisAz` back.
Add: **scrub the clock to launch + ETA and assert the front's drawn radius is
within a few percent of the drawn Earth's.** That is the assertion that stops the
picture and the number from drifting apart again.

### 3.3 Two smaller layer findings

- **L3 — no flare propagation is drawn at all below the CME.** The light travel
  time (8 min 20 s, the X-ray/radio arrival) and the SEP arrival (~30 min, along
  the Parker spiral footpoint the page *already computes* — `FG.parkerFootpointLonDeg`
  is in `window.__solarFlare.state`) are both modelled and neither is drawn. Three
  arrivals on three timescales, from one flare, on one clock, is the story this
  page is uniquely placed to tell.
- **L4 — clicking a close-approach row is the intended discovery path and it
  works well.** The `Selected Body` card it fills is genuinely good — designation,
  class, distance in LD *and* AU, size with the albedo assumption stated, orbit
  a·e·i, MOID, next approach, and the propagation provenance. Nothing to fix;
  noted so it does not get "simplified" in the course of §3.1.

---

## 4. UI findings that affect the visuals

- **U1 — the info panel dims the whole simulation by 45 %, at every viewport
  width.** `openPanel()` unconditionally adds `.show` to `#backdrop`
  (`solar-system.html:791`), which is `rgba(0,0,0,.45)` over the full canvas.
  There is no breakpoint guard, so reading the panel on a 1920 desktop means
  watching the simulation through a grey filter. The backdrop is a
  mobile/tablet affordance (tap-outside-to-close); gate it to the width where
  the panel is an overlay rather than a column.
- **U2 — the `⚡ Weather` and `☰ Info` buttons overprint the panel header.** At
  every width captured, `#btn-sw` sits on top of the `Solar System` title.
- **U3 — on a 390 px phone the panel takes ~75 % of the width** and the Sun is
  pushed entirely off-screen. The panel is a fixed side column, not a bottom
  sheet. `earth.html`'s storm-watch panel already solves this
  (`js/storm-watch-panel.js`, `≤640` bottom-sheet geometry).
- **U4 — scrolling the panel scrolls the document**, taking the nav and the HUD
  off screen with it, because `#solar-data-section` makes the page scrollable and
  the panel body is not its own scroll container.

---

## 5. Suggested order

Sequenced so each step is independently shippable and each one makes the next
easier to judge.

| # | Work | Why first |
|---|---|---|
| 1 | **U1** (backdrop gate) | One line. Until it is fixed, every visual judgement on this page is made through a 45 % grey filter — including the next four steps'. |
| 2 | **S1** (tone mapping + exposure, all shaders, one commit) + its gate | Nothing else in §1 can be evaluated while the disc is 100 % clipped. Highest leverage on the page. |
| 3 | **S2** (localise the flare terms) | Depends on S1 to be visible at all. Turns an X-class from a lighting change into an event, and gives the page its sunspots back on ordinary C-class days. |
| 4 | **S3** (one integrated corona) + **S5** (wire in the existing ring/ribbon modules) | The bullseye is the most-seen defect; S5 is nearly free once the corona stops drowning it. |
| 5 | **L1** (layer panel + three presets) | Architecture the rest hangs off; also the honest fix for "too much is on at once". |
| 6 | **L2** (CME as a propagating front on the sim clock) + its gate | The largest single gain in what the page *says*, and the one place the picture currently contradicts the HUD. |
| 7 | **N1 · N2 · N3** (palette affordance, label declutter, selection framing) | Polish on an already-good layer. |
| 8 | **L3** (light / SEP / CME as three arrivals on one clock) | The differentiator. Only worth building on top of a working L2. |

**Before any of it:** CLAUDE.md §5 applies. `04fdf34` added the NEO layer and
`8e72cf8` the flare geometry kernel **eight days ago**; both are recent, both are
gated, and neither is implicated in anything above. Nothing in this plan should
revert either — S2 changes the shader's *flare response*, not the flare
*geometry*, and the `tests/flare-geometry.mjs` /
`tests/solar-system-flare.spec.js` pair must stay green through all of it.

---

*Review by Claude Code, 2026-09-14. Screenshots and the capture harness are
attached to the review, not committed — re-run against a live feed on hardware
before treating any brightness number here as final; the σ and clipping figures
are renderer-independent (they are framebuffer reads), the FPS figures are not.*
