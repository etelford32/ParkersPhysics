# Boötes Void — dynamical footprint

**Status:** Phase 1–2 shipped 2026-09-07. Phase 3 (the observational programme)
is not started and is not a code task.

`bootes-void.html` · `js/bootes-void-model.js` · `js/bootes-web-model.js` ·
`js/bootes-void-data.js` · `js/bootes/{page,scene,charts}.js`

---

## 1. The question, and why it is not the obvious one

The obvious framing — *does the Boötes Void have gravity?* — is not a question.
Of course it does. The one this page is built around is:

> **Does the observed Boötes underdensity produce a measurable dynamical
> signature in the surrounding cosmic web consistent with ΛCDM structure
> formation, and out to what radius does it still matter?**

That is falsifiable, and it is a chain in which every arrow is testable:

```
galaxies → δ(r) → Δ(<r) → v_r(r) → Φ(r) → g(r) → T_ij(r) → cosmic-web morphology
                                        ↘ Σ(R) → ΔΣ(R) → γ_t
                                        ↘ s∥ = r∥ + v∥/aH
                                        ↘ Φ̇ → ΔT/T
```

**A void does not push.** There is no repulsive force anywhere in this. There is
less inward attraction from the underdense direction, so peculiar motion — the
motion on top of the Hubble flow — is outward. Every sign convention in
`js/bootes-void-model.js` is spelled out because this is the thing that gets
misread, and because a sign error here produces a picture that looks fine.

---

## 2. What shipped

### Level 1 — characterisation

- HSW profile δ(r), integrated contrast Δ(<r), the zero crossing r_s and the
  compensating wall.
- Mass deficit, wall mass, and the **compensation fraction** C — the fraction of
  the evacuated interior the wall has piled back up.
- The h⁻¹ → Mpc conversion, in one place. See `data/bootes/SOURCES.md`.
- The two galaxy deficits that disagree, printed side by side and unreconciled.

### Level 2 — the physics result

- **Test 1** outflow v_r(r), linear and quasi-linear.
- **Test 2** the continuity identity ∇·v = −aHfδ, verified in integral form.
- **Test 3** the tidal tensor, with its closed-form eigenvalues.
- **Test 4** the counterfactual: fill the void to cosmic mean, subtract the
  fields. Reported as a share-of-acceleration profile with a 16–84 band across
  directions, plus a velocity horizon at a stated threshold.
- **Test 5** filament alignment against the void's compression axis, with a
  deliberately circular positive control.

### Level 3 — the cosmological signatures

- **Test 6** redshift-space distortion and the quadrupole that carries β = f/b.
- **Test 7** weak lensing ΔΣ(R), γ_t(R) and a shape-noise SNR. Honest null.
- **Test 8** the ISW imprint ΔT(θ). Honest null.

---

## 3. Decisions, and what would have to change to revisit them

### 3.1 The web's mass is the profile's own wall

**Decided.** `js/bootes-web-model.js` takes exactly `wallMassMsun(profile)` and
redistributes it. It does **not** give each named cluster a published mass.

Test 5 asks whether the void or the surrounding filaments dominate the local
force. Supercluster masses are uncertain at the factor-of-two level, so any mass
typed in would make the answer a function of what somebody typed — circular.
Constraining the total to the profile's own wall removes that freedom: the
monopole of the clumped model and the smooth model are identical by
construction, so the only thing that differs is arrangement.

To revisit this you would need a real mass reconstruction for the region, at
which point the whole page stops being a model.

### 3.2 The counterfactual is an identity, not a difference

**Decided.** `splitProfile()` splits δ into δ⁻ (the deficit) and δ⁺ (the wall),
exactly. Model A is δ⁻ + the discrete wall; model B is the discrete wall alone,
**bit-identical**. So Δg = g(δ⁻), analytically, with no cancellation error.

Differencing two independently summed particle fields would agree to about four
digits and lose precision exactly in the outskirts, which is where the
R_influence answer lives.

### 3.3 "Radius of influence" is reported three ways, and never as a fraction

**Decided, and this one took a wrong turn first.** The tempting metric is *the
radius where the void contributes less than X % of the local acceleration*. It
is backwards: the void and its own wall pull in opposite directions and nearly
cancel outside the shell, so the total field out there is small *because* the
void's contribution is large. That ratio therefore grows without bound exactly
where the void's absolute influence is vanishing.

`influenceProfile()` returns instead:

1. **velocityHorizonMpc** — absolute and observational. The radius beyond which
   the void alone could not have induced more than a stated peculiar velocity.
   Default 50 km/s, adjustable, always printed with its threshold.
2. **shareProfile** — the void's share of |g| with a 16–84 band across
   directions. **The band is the result.** Clumping widens it without moving the
   median; that anisotropy is the answer.
3. **crossover** — where the web overtakes the void, per direction, plus the
   fraction of directions in which that happens at all. For an under-compensated
   void it usually does not, and "no crossover in 70 % of directions" is a
   result, not a failure to converge.

### 3.4 The tangential eigenvectors are degenerate

**Load-bearing.** A spherical void's tidal tensor has λ_tangential *twice*. The
two tangential eigenvectors are therefore not defined, and any alignment
measured against e₂ or e₃ is an artefact of the eigen-solver. `filamentAlignment`
defaults to `axis: 1` and reports `minEigenGap` so the degeneracy is visible
rather than silent. `tests/bootes-web-model.mjs` asserts the gap collapses.

### 3.5 Under-compensation is pinned by a test

**Load-bearing.** An over-compensated profile flips the sign of Φ in the
outskirts, which inverts the ISW prediction. During development that turned the
predicted cold spot into a near-cancellation at 4 % of the correct amplitude,
with δ, Δ, v and g all still looking perfectly reasonable on the way past.
`tests/bootes-void-model.mjs` asserts 0 < C < 1 and Φ > 0 everywhere.

---

## 4. Bugs that shipped during development, and the checks that caught them

These are recorded because each was silent and plausible-looking.

| Bug | Symptom | What caught it |
|-----|---------|----------------|
| `(1+z)³` in the comoving Poisson factor instead of `(1+z)` | Φ inflated 11 %; ISW amplitude wrong; nothing looked odd | `g = −dΦ/dr_phys` across two independent chains |
| Missing `(1+z)²` in `pointGravityVector` | The void's field was physical, the web's comoving — a silent 10 % bias in the void's favour on every comparison | the **shell theorem** check in `tests/bootes-web-model.mjs` |
| Over-compensated profile parameters | ISW cold spot became a 4 %-amplitude near-cancellation | `compensationFraction` + the Φ > 0 assertions |
| `Map` of `data-bv` key → element | Three headline readouts frozen on their em-dash forever, looking like "not available" | `tests/bootes-void-page.mjs` duplicate-key check |
| `#bv-stage-fallback` with author `display:flex` | "WebGL is unavailable" rendered over a working canvas | the `[hidden]` specificity check; same failure as `.feature-item[hidden]` on Mars |
| Float-accumulated axis ticks | An axis label reading `−5.6e-17` where zero should be | eyes on a screenshot; now fixed at the tick generator *and* the formatter |

The velocity-divergence identity also could not be tested by numerical
differentiation at all — Δ(<r) is a linearly interpolated table, so its
derivative is piecewise constant, and δ has a kink at the wall. A narrow stencil
measures the interpolation; a wide one straddles the kink. It is tested in
**integral form** (the divergence theorem) instead, against a quadrature that
shares no code with the kernel.

---

## 4a. The stage: a ruler and a camera (2026-09-09)

The first build had neither. The render was a starburst with no scale reference
at all — nothing said whether it spanned 90 Mpc or 900 — and the camera was a
bare OrbitControls with a snap-to-default button.

### The ruler

`js/bootes/scale-refs.js`, in three parts that do different jobs:

- **Range rings**, fixed multiples of R_eff on the graticule plane, labelled
  with both the multiple and the distance. FIXED, never adaptive: a ruler whose
  tick spacing changes as you zoom is not a ruler, and "two rings out" has to
  mean the same thing before and after a zoom.
- **The DOM scale bar**, which IS adaptive and carries the other half of the
  job — what a screen distance is worth right now. It rounds DOWN to 1/2/5×10ⁿ
  so it can never overflow the box it was measured against, and it says it is
  exact at the pivot plane.
- **Labels on the measured objects only** — the nine catalogued clusters and
  the sightline. Everything else in the scene is model, so labelling it by name
  would imply an identification that does not exist.

### The camera

`js/bootes/camera.js` over the pure `js/bootes/camera-math.js`:

- Five viewpoints, **two of them derived from the real oblique sightline**
  (RA 14ʰ50ᵐ, Dec +46°) rather than from a coordinate axis. Substituting an
  axis produces a view that looks plausible and shows the wrong projection.
- Eased flights that interpolate θ, φ and **log**-radius, not Cartesian
  position — a straight lerp between opposite sides dives through the void.
- Keyboard, gated on `document.activeElement` so the rail's sliders keep their
  arrow keys.
- Double-click-to-focus on the catalogued clusters, by screen-space projection
  rather than a Points raycast (no threshold to tune per zoom).
- A live pose readout: distance, azimuth, elevation, field of view.

`camera.up` stays +Y and never changes, so — unlike Mars, the Moon and the
Stage — this rig never has to rebuild OrbitControls. See its header.

### Bugs found while building it

| Bug | Symptom | Fix |
|-----|---------|-----|
| Near-fade injected BEFORE `<opaque_fragment>` | That chunk ends by assigning `gl_FragColor`, so the alpha write was discarded. Compiled clean, no warning, zero effect — identical output with the fade at 7 Mpc and at 9999 | Inject after the chunk |
| Untextured `PointsMaterial` | Points are hard axis-aligned quads with no size cap, so the inside-the-void viewpoint rendered galaxies as fat white rectangles | One shared soft-dot alpha texture |
| Wireframe shell seen from inside | The far half fills the frame and reads as a lattice, a structure the model does not have | Hidden once the camera is inside R_eff |
| Fixed arrow length | A hairline at 360 Mpc out, a screen-crossing streak from inside | Glyph length scales with camera distance — a symbol zoom, not a magnitude change, and disclosed |
| `across` viewpoint via Gram-Schmidt perpendicular | Landed the camera 62° above the plane; the rings arrived as a steep ellipse | Horizontal perpendicular: still ⟂ the sightline, level horizon |
| Label wiring spliced inside the debounce callback | The `L` shortcut did nothing on a fresh page and started working only after some other control had been touched | Registered at the top level |
| `data-bv` collected as key→element | Seven readouts appear twice on purpose; only the last updated | key→LIST, gated by `tests/bootes-void-page.mjs` |

---

## 4b. The force probe (2026-10-11)

`js/bootes-force-probe.js` (PURE) → `js/bootes/probe-panel.js` (DOM) →
`js/bootes/probe-layer.js` (stage glyphs + pointer). The page's eight tests
answer along radial profiles and fixed sample shells — right for a summary,
wrong for exploring. The probe evaluates the whole chain at ANY point, live,
as it is dragged (~0.2 ms per probe, ~1.2 ms per ray sweep, ~2.2 ms per
streamline, measured in node; coalesced to one evaluation per frame).

At the probe: the peculiar acceleration split five ways (void δ⁻, smooth wall
δ⁺, clumped web = model B, clumping = web − smooth wall, total A), each radial /
tangential; the void share (the SAME definition as `counterfactualAt`); the
linear velocity v = 2fg/(3Ωm H); Φ (void analytic + web softened point masses);
the full tidal tensor with its axes, the stretch/squeeze across a 10 Mpc rod and
the T-web class (threshold exposed, default λ_th = 0.2); the web force broken
down by model node and filament with PROJECTED shares (they sum to 1 exactly);
the streamline of the total field both ways; and the radial components along
the probe's own ray, beside Test 4's direction median.

**It adds up what the two kernels say and computes nothing new**, so every
check in `tests/bootes-force-probe.mjs` is an identity against them: the one-pass
web sum IS `externalGravityAt` / `externalTidalAt` (1e-12); void + smooth wall IS
the full profile; Σ structures IS the web force; the void's linear velocity IS
`radialVelocityKms(…, {linear:true})`; g = −∇Φ and T = −∂g/∂x_phys ÷ 4πGρ̄ hold
by finite differences across the probe's own outputs (every (1+z) power in
play); tr T = δ. Three of those residuals are also printed LIVE under the card
at whatever point the reader chose.

Load-bearing details, each found while building it:

| Thing | Why |
|-------|-----|
| `radialSplit` takes the tangential part from the RESIDUAL VECTOR, not √(|v|² − v_r²) | the square-root form cancels and gave the exactly-radial void term a ~1e-8 tangential part |
| `probeAt` REFUSES a web built at a different z | the (1+z)² bias got in once through two halves evaluated at different redshifts |
| Node particles are joined to their node by `offsetMpc` ARRAY IDENTITY | no tolerance or nearest-match; the gate asserts the structures partition the particles with no 'other' group |
| Shift-drag / armed-tool listeners are CAPTURE-phase + `stopImmediatePropagation` on down AND move | either guard alone suffices; with both removed OrbitControls pans the camera 3.6 units — the browser gate's negative control |
| The clamp is max(2.6 R_eff, farthest node × 1.05) | the wall's r⁻³ tail puts nodes past the chart edge; clamping at 2.6 R_eff stopped a contributor's "go" 12 Mpc short of the structure it named |
| The ring marker is a `sizeAttenuation:false` sprite OUTSIDE the scaled glyph group | the dot alone vanished among 700 field arrows; a parent scale would multiply a non-attenuated sprite's size |
| Keys are written LITERALLY (`set('probeGVoidR', …)`), never from a prefix | the data-bv gate finds keys by matching `set('…')` in the source |

Disclosed on the card: the web rows describe THIS seeded realisation (re-roll and
they move; the void rows do not — the browser gate asserts both), velocity is
linear (no honest non-spherical quasi-linear correction), the streamline is
today's flow and not a trajectory, and the T-web class below the softening
length describes the softened mass.

## 4c. The galaxy tracker (2026-10-11)

`js/bootes-void-tracker.js` (PURE) → `js/bootes/track-panel.js` (DOM) →
`js/bootes/track-layer.js` (stage paths + rings). Asked for as "track the stars
and nebulae inside the void": at ~230 Mpc nothing smaller than a galaxy is
resolved, and the void's ~60 galaxies are gas-rich star-formers (Szomoru 1996,
Cruzen 2002) whose H II regions are its nebulae — so the tracker follows
GALAXIES, says why on the card, and says they are model tracers.

Linear theory run in time, with no other dynamics: δ and the tidal field ∝ D,
physical g ∝ (1+z)²D (the model kernel's own two (1+z) powers), Zel'dovich
paths x(t) = x_obs + (D/D_obs − 1)ψ with ψ from the probe's linear velocity at
z_obs, v = aHfDψ. Timeline 1 Gyr → t₀ + 6 Gyr, 140 epochs shared by every
tracked galaxy so a chart crosshair is one instant.

The result the card leads with: the void DEEPENS and its outflow SPEEDS UP,
but the physical pull on its galaxies was strongest when the universe was
young (g ∝ (1+z) in the matter era) — a shallower void in a denser universe
pulled harder — and Λ then flattens every curve.

| Thing | Why |
|-------|-----|
| f is the EXACT dlnD/dlna in the tracker, not γ = 0.55 | with γ the reported speed was not the path's own derivative (4e-4 off at t = 4 Gyr); γ is 0.4 % off at z_obs and 2 % by a = 1.4 |
| ψ = v_probe / (aHf_exact) at z_obs | so the tracked galaxy reads EXACTLY what the force probe reads at z_obs (gated) |
| Cosmic time is Simpson in √a | the √a matter-era integrand has infinite slope at 0 in `a` |
| A tracked galaxy is its observed POSITION, not a tracer index | a re-roll re-samples the tracers; an index would silently follow a different galaxy. Rows say "re-tracked" |
| At the observed epoch the stage is restored EXACTLY (`setTracerOffsetsMpc(null)` + the original web) | every other readout on the page is an observed-epoch claim about that picture — gated with strict equality |
| The motion is NOT magnified | void galaxies drift a few to ~15 Mpc in 18 Gyr; the table prints the drift and "fly to" brings the camera to it instead |
| Track colours avoid the term palette | void blue / web orange / clumping green / total violet already mean something on the same stage |

Disclosed: linear theory past |δ| = 0.5 (flagged live — the void centre is
≈ −0.6 at z_obs), straight Zel'dovich paths, times after today are forecasts.

### 4c.1 Nonlinear shells, the bias band, proper distances (2026-10-11, second pass)

Asked for directly: the four caveats the first tracker shipped with. What each
became:

| Caveat | Now |
|--------|-----|
| "linear theory, straight lines" | DEFAULT mode is nonlinear: each galaxy's SPHERICAL shell (the full profile δ⁻ + δ⁺) follows Newton's shell equation in ΛCDM — `y'' + (2 − 1.5Ωm)y' = −(Ωm/2)(y⁻² − y)`, Λ cancels between shell and background — integrated once into a table (`shellTable`, ~0.1 s) and INVERTED at z_obs because the profile is the observed nonlinear state. The clumped part (web − smooth wall) stays linear on top. Linear mode is kept as the A/B reference and ghosted on the charts |
| "the centre is too deep for linear theory" | gone with the above; the live flag is now SHELL CROSSING (local δ from neighbouring shells, 1 + δ = d(q³)/d(r³)), where any spherical model stops |
| "times after today are forecasts" | still forecasts, now with the page's dominant systematic run through them: the whole model (profile + web + dynamics) at b × 0.8 and b × 1.2, shaded on every chart. A systematic band, not a statistical interval — the card says so |
| "the motion is small" | still not magnified. Added a PROPER-distance frame (the drawn universe × a(t)/a_obs, exactly 1 at z_obs) so the reader sees how much growth is cosmic expansion, and a follow camera that TRANSLATES the rig by exactly the galaxy's motion (star-collider rule) |

Measured and gated (`tests/bootes-void-tracker.mjs` §8–12):

- The table reproduces the exact Ωm = 1 parametric solution to 9e-4 in (1+Δ)
  out to Δ_L = −4, and its linear limit at every epoch.
- Bernardeau's ν = 3/2 closed form is 1.1 % off at Δ_L = −1 and 5.9 % at −5 —
  MEASURED, and the gate fails if the table is ever replaced by the formula.
- At z_obs: position, force and void share equal the probe's exactly; local δ
  from shell spacing equals the profile's δ (mass conservation).
- Nonlinear outflow is +12 % over linear at 0.45 R_eff.
- Paths bow by ~6 kpc over ~10 Mpc near the wall — REAL BUT SMALL (both clocks
  are monotone). Gated at > 1 kpc vs linear's exactly-zero; never oversold.
- SHELL CROSSING never happens in the page's void, nor in any smooth HSW
  profile tried (α up to 8, β up to 40). It fires inside a thin dense wall —
  at a = 1.21 with Ωm = 1 and a = 1.47 in ΛCDM: dark energy stalls the
  growth that drives it. A void edge that has not crossed by now essentially
  never will.

Scars from this pass: `drawTrackSeries`' `series` parameter shadows the
module's `series()` helper (the ghost line called the array) — reached through
`drawLine`; the band and ghost re-use the ONE timeline so a crosshair is one
instant; proper-frame label sprites are counter-scaled (they are text, not
geometry) and the probe's drag divides by its group scale so it still lands in
comoving Mpc.

## 4d. The N-body forecast (2026-10-11, third pass)

Asked for directly: "the web's lumpy pull is linear — work towards an N-body
simulation". Phase 1 shipped as a third tracker mode, **N-body forecast**:
every particle — the void's smooth matter (~35 200 since §4i: a uniform
12 Mpc quiet start sampling ρ̄(1 + δ⁻) to 2.6 R_eff, its grain relaxed away)
and the web's 802 mass particles — gravitates on every
other in the expanding ΛCDM background, FORWARD from the observed epoch to
t₀ + 6 Gyr. The web's pull is therefore fully nonlinear and the web itself
responds. Kernel `js/bootes-nbody.js` (PURE) → `js/bootes/nbody-worker.js`
(thin shell) → `js/bootes/nbody-runner.js` (builds the ICs, falls back to
stepping on the page without a Worker) → `js/bootes/track-panel.js`.

| Decision | Why |
|----------|-----|
| Barnes–Hut octree, monopole + QUADRUPOLE, θ = 0.5, leaf 16 | the force error must be quoted against the PECULIAR force: the raw sum is dominated by the mean density's pull, so a monopole tree's 1 % raw error was a ~50 % error at the wall. Quadrupoles cut it 10×; at θ = 0.5 it is ~0.9 % of the rms peculiar force (gated) |
| Comoving x, canonical p = a·u, KDK leapfrog in N = ln a, drift/kick coefficients ∫dN/(a²H), ∫dN/(aH) integrated per step | symplectic in the comoving Hamiltonian; 6 steps are within 0.05 % of 24 on the page's run (gated) |
| The mean density is SUBTRACTED as a kernel-smoothed uniform sphere (`meanSphereForce`) | only the peculiar force acts, and a uniform particle sphere feels ≤ 0.07 % of the raw pull INCLUDING across its smoothed edge (gated) |
| The void's smooth matter uses Gadget-2's COMPACT spline (h = 24 Mpc on the page); the web keeps the probe's PLUMMER ε | Plummer's density tail falls as r⁻⁵, its second moment diverges, and smoothing a void with it weakened the deficit's pull by ~ε²·ln — 4 % at ε = 4.8 Mpc, 26 % at 12 Mpc, measured. The web stays Plummer so the N-body's web force at z_obs IS the probe's (gated to the tree's 0.1 %) |
| Quiet start: shells of Fibonacci directions, randomly rotated, radii STRATIFIED IN MASS within each shell | positions carry no Poisson noise; see the scars below for why both "stratified" and "in mass" are load-bearing |
| Initial velocity = exact spherical shell flow (the tracker's table) + the clumped part's linear growing mode at the probe's f | an N-body galaxy leaves z_obs with the shell tracker's velocity (gated to < 0.2 %) — the two modes JOIN at z_obs and part only after it |
| Galaxies are massless TEST particles; the worker keeps the matter's snapshots | a galaxy tracked after the run is flown through the same matter with no re-run, bitwise what an inline test particle gives (gated) |
| The mode is a FORECAST only; before z_obs it shows the shell reconstruction | see Phase 2 below — the past is not faked |

Measured (page configuration, `tests/bootes-nbody.mjs` + the browser gate):
~30 s in a Worker since §4i (was 8.4 s); the self-gravitating web moves the
deepest void galaxy ~4 kpc from the shell tracker over the next 6 Gyr (median
tracer 1 kpc, p90 2 kpc since §4j, against a median forecast displacement of
0.19 Mpc); smooth matter within 20 Mpc of the web's nodes grows +4.9 %. Until §4i this
read 6 / 35 / 75 kpc: that was the old layout's LATTICE GRAIN pushing the
galaxies about, not the web (measured — §4i). REAL BUT SMALL: Λ is
switching growth off (D rises only ×1.18 from z_obs to t₀ + 6 Gyr), and the
page says so rather than magnifying it.

Physics gates (each against something the N-body code does not contain):
- FULL HISTORY, z = 19 → z_obs, with the exact SPHERICAL solver (Gauss's law
  on the particles' own enclosed mass, no tree): every shell lands on the
  ΛCDM shell ODE to 0.09 % of its displacement — the integrator, ICs and mean
  subtraction, isolated.
- FORWARD, z_obs → t₀ + 6 Gyr, 3D tree: shells track the ODE to 0.4 %.
- LINEAR GROWTH, 3D tree: a broad 1 % mode grows ×15.3 = D(z_obs)/D(19) to
  0.5 % (discreteness noise, ~30× the signal at z = 19, cancels against a
  matched uniform run with the identical layout).
- Recorded, not gated: the 3D tree run from z = 19 undershoots the shell ODE by
  5 % in the interior and up to ~15 % across the steep wall (β = 9) at
  h = 16–24 Mpc. That is the smooth matter's RESOLUTION smoothing the wall,
  not an error — and it is why the page runs forward only from z_obs, where
  the same configuration is within 0.4 %.

Scars — each measured, each silent:

| Bug | How it presented | Fix |
|-----|------------------|-----|
| Tree error quoted against the RAW force | "1 % median" looked fine; at the wall the peculiar force is ~2 % of the raw, so it was a 50 % error | quadrupoles + the gate measures against the rms PECULIAR force |
| Plummer softening on a smooth void | full-history run 26 % short at ε = 12 Mpc; Gauss's-law check 4 % low even at ε = 4.8 | compact spline for the smooth matter |
| Shells STACKED on one radius | a uniform quiet sphere pulled 5.8 % weak at r = 20 Mpc (∝ (s/r)², independent of ε) — a midpoint-rule quadrature of the radial mass | radii stratified within each shell |
| Stratified uniformly in VOLUME | an exact spherical solver missed the shell ODE by 11 % from z = 19; the particle masses put 0.9 % too much mass inside r = 80 Mpc across the steep wall | stratified in MASS (inverse CDF of 4πρ̄(1+δ)r²) |
| A particle excluded from its own enclosed mass | 0.1 % in a z = 19 shell's end radius | half its own mass counts as inside (it stands for its stratum) |
| "Momentum drift 3.7 %" | looked like a conservation bug | it is not conserved: the mean subtraction is an external background and the clumped web's centre of mass is off-origin. The gate checks Newton III on the INTERNAL forces instead (1e-5) |

### Phase 2 — the past as an N-body (2026-10-11, built: §4e)

Running the web backward is not "the same integrator with dt < 0": gravity
amplifies forward, so a backward run grows every error and every grain of the
sampling into the past. The well-posed question is "which SMOOTH early state
evolves into today's field", answered in §4e; its ICs are second order since §4f.

## 4e. Reconstructing the initial conditions (2026-10-11, fourth pass)

Asked for directly: "start phase 2, reconstruct the web's initial
conditions". Kernel `js/bootes-reconstruct.js` (PURE) → the worker's
`reconstruct` message → "Reconstruct the past" in the tracker's N-body mode.
Once it lands, the N-body mode draws ONE run from z = 9 through z_obs to
t₀ + 6 Gyr for the whole span, every galaxy shot to where it is seen.

| Step | What | Why this and not the obvious thing |
|------|------|------------------------------------|
| 1. Glass | a uniform quiet sphere relaxed under REPULSIVE gravity, overdamped, until no element feels a force | the standard pre-initial load; relaxing the observed quiet start instead slid its lattice sideways ~2 Mpc (grain motion with no physics) and that poisoned every displacement built on it |
| 2. Gravitational matching | x ← x + r·[F_obs − F_now]/(4πGρ̄₀) until the elements' field is the observed one | in linear theory F/(4πGρ̄₀) IS the displacement, so this is Zel'dovich iterated to its fixed point; curl-free and smooth (a sum of gravitational fields), hence near-least-action; EXACT for a spherical void (gated against the shell table, 2.5 %) |
| 3. 2LPT ICs at z = 9 (§4f) | ψ = X − q split by fixed point into s₁ + D₂ₒs₂[s₁]; x = q + d₁s₁ + d₂s₂, u = aH(d₁′s₁ + d₂′s₂); nothing iterated on top | Zel'dovich (x = q + (D_i/D_obs)ψ) over-counts the second-order part ~7×; see §4f, and the two rejections below |
| Galaxies | first guess from the elements' ψ, then SHOT through stored snapshots by moving their START | test particles are independent (bitwise) and well-conditioned this way; moving ψ with q pinned barely converged |
| Per-particle softening | each source smoothed at 2 × its own cell size | with one global h, galaxies in the zoom's coarse outskirts stalled 0.5–10 Mpc off target |
| Uniform 12 Mpc layout, ~35 000 elements | NOT the forecast's zoom | the zoom's outskirts (h → 48 Mpc) missed the web's 11 Mpc clumps by 50–66 % where most galaxies sit; uniform 14 Mpc still 29 %; 12 Mpc ≤ 10 % (matched) |
| z = 9, not z = 19 | | from z = 19, 15× of growth turns the glass's residual grain into scatter (convergence 0.6/shot vs 0.4) — and z = 9 is before the tracker's 1 Gyr axis begins |

Measured REJECTIONS, each with its number (do not re-try blind):

- **Position shooting** (re-run, feed the miss back into ψ, secant gain):
  lands the elements to 0.03 Mpc — and makes the initial field WORSE. In
  the twin test the recovered field went 9 % → 21–25 % (smoothed at the
  resolution), 41 % → 149 % unsmoothed: softening makes sub-resolution
  modes respond weakly and the shots amplify them chasing grain (the ~3 Mpc
  element-level miss is the quiet-start lattice no glass reproduces).
  Smoothing the correction or dropping the gain to 1 did not rescue it.
- **Field feedback** (re-run, push ψ by the gravity still missing): today's
  field 16 → 10 %, and the twin's initial field 8.1 → 6.4 % at a void-like
  amplitude — but at δ ≈ 1 the initial field got WORSE, erratically
  (15 → 39 % after one pass, 20 % after two). Better today, corrupted past,
  and nothing the reader sees could tell which: over-fitting.

Gated (`tests/bootes-reconstruct.mjs`, 9 checks, ~25 s on a reduced layout):
per-particle tree == direct; the two-segment frame clock; the glass quiets
16×; the spherical identity (2.5 %); the TWIN EXPERIMENT — a planted initial
field recovered from a DIFFERENT glass to 9 % (correlation 0.996) at the
elements' resolution, which is the truth's own nonlinearity; the z = 9 state
is a linear growing mode (its own gravity IS 4πGρ̄₀ × its displacement:
correlation 0.89); today's gravity reproduced; galaxies landed to kpc and
independent bitwise; the nodes grow (matter within 20 Mpc of the node
markers +14 % from z = 9 to z_obs).

On the page (browser gate + measured): ~115 s in a Worker (glass 1 s, match
23 s, run 35 s, galaxies 35 s); today's gravity reproduced to 7–9 % inside
R_eff with Zel'dovich ICs (2.7–4.1 % with 2LPT, §4f), 21 % at 1.3–1.6 R_eff
and 34–42 % out on the clumpy wall — NOT order (2LPT left it unchanged)
and, as §4h measured, not the elements' resolution either: it is the
forecast's own grainy sampling of the wall, which no smooth past can grow
into. The page
prints its own run's numbers. Galaxies land within ~4 kpc. A run's
reconstructed matter is ONE population (the web's mass is in the elements),
so the table prints no void/web split for it rather than "100 %".

### 4f. Second-order initial conditions (2LPT) — `js/bootes-lpt.js`

The matched displacement ψ = X − q is the FULL displacement to today. To
second order (Bouchet et al. 1995; Scoccimarro 1998) x = q + D₁s₁ + D₂s₂ with
s₂ = ∇φ₂, ∇²φ₂ = Σ_{i>j}[s₁ᵢ,ᵢs₁ⱼ,ⱼ − s₁ᵢ,ⱼ²], and the second-order part grows
as D₁² — so Zel'dovich ICs, which scale all of ψ back by D_i/D_obs, carry it
into z = 9 ~7× too large. The 2LPT inverse (D₁(a_obs) = 1) solves
ψ = s₁ + D₂ₒs₂[s₁] by fixed point (contracts ~6× per pass; 4 passes) and lays
both orders down with their own growing-mode velocities.

| Piece | How | Gated |
|-------|-----|-------|
| D₁, D₂, D₁′, D₂′ | the exact ODE (RK4 in ln a from D₁ = a, D₂ = −3a²/7) | D₁ = the growth INTEGRAL to 1e-8; −(3/7)D₁²Ω_m^(−1/143) to 0.02 %, f₂ = 2Ω_m^(6/11) to 0.4 % |
| ∂s₁/∂q on the glass | weighted local least squares within h = 2 × spacing, symmetrised | exact for a linear field at every element, rim included |
| ∇²φ₂ = S | the N-body TREE: elements carry S·V/(4πG), positive and negative parts in separate trees (a mixed-sign monopole has no centre), spline-softened; ISOLATED boundary = "matter beyond is the mean" | uniform source ball: Sq/3 inside (1 %), SR³q/3\|q\|³ outside; a plane wave (1-D, where Zel'dovich is exact) gives 0.1 % of a spherical strain's s₂ |
| The map | — | an exact Newton + Λ top-hat shell gives δ = Δ + 0.812Δ² (17/21·Ω_m^(−1/143) = 0.816); at \|Δ\| = 0.05 the 2LPT map misses it by 5e-6, Zel'dovich by 4e-4 |

MEASURED, and what decided it (`tests/bootes-lpt.mjs`, twins on a 140 Mpc
glass; the page run):

- **Planted void twin** (δ_L = −1.5, run forward, reconstructed from a
  different glass): recovered linear field 8.8 → 4.0 %; run forward, today's
  displacement 7.2 → 3.4 %. At δ_L = −1: 7.7 → 4.9 %.
- **Planted cluster twin** (δ_L = +0.5 / +0.8): Zel'dovich WINS, 5.4 / 3.4 %
  vs 6.2 / 4.7 %. Not because it is right: the softened integrator grows a
  40 Mpc mode ~3.5 % too slowly, and Zel'dovich's double-counted collapse
  happens to offset that. 2LPT's recovered amplitude sits at 0.965 for
  EITHER sign of δ — the deficit, exposed. Calibrating it by a tiny-amplitude
  linear forward run was tried and is unmeasurable (the glass's own grain
  dominates at linear amplitude: g came out 0.28–0.80 depending on the field).
- **Random 3 Mpc wave field**: a tie (8.1 vs 8.4 %) — there the second-order
  part is ~2 % of ψ and the error is grain + softening.
- **The page** (void + web, uniform 12 Mpc, 35 233 elements): today's gravity
  in the void's core 7.4 → 2.7 % (30–60 Mpc) and 7.1 → 4.1 % (60–90 Mpc);
  beyond R_eff unchanged to ±1 % (19.6, 35.1, 39.7, 42.0 %) — read at the
  time as RESOLUTION; §4h measured that wrong (it is the target's grain).
  +6 s on a ~110 s run. Galaxies,
  node accretion and the z = 9 linearity check (amplitude 0.82 → 0.83)
  unchanged.

So 2LPT is the default (`RECON_CONFIG.ics`; `'za'` stays as the A/B
reference). Galaxies take s₁ as their first guess; their shots absorb the
rest.

### 4g. The softened integrator's own growth — `js/bootes-softgrowth.js`

What §4f exposed: the N-body softens each element with the compact spline of
support h = 2 × spacing, and for that kernel the softened pull of a point IS
the Newtonian pull of the spline-shaped mass — so mode k feels ŵ_h(k) × the
force and grows to T(k) < 1 of ideal by a_obs (the growth ODE with
(3/2)Ω_m ŵ D, started in the IDEAL growing mode we lay down). On the page
(h = 24 Mpc) T = 0.979 / 0.881 / 0.804 at λ = 200 / 80 / 60 Mpc.

MEASURED before building anything (curl-free plane waves on the glass; a
windowed plane-wave DISPLACEMENT has a curl part that does not grow and
first read 0.71 at λ = 200 — that was the test, not the integrator):

| Probe | Result |
|-------|--------|
| 90 steps vs 30 | 0.9214 vs 0.9208 — not time-stepping |
| θ 0.25 vs 0.5 | identical — not the tree |
| sphere 220 vs 140 Mpc | λ = 80: 0.805 → 0.834 against T = 0.844 — the residual below T is the test WINDOW spreading the field onto higher k |
| the tree's softened pull vs the enclosed mass of the transformed kernel | 1.4e-8 — ŵ is the integrator's own kernel |

THE FIX lays s₁ down as T(k)⁻¹s₁ so the softened integrator grows it into
today's field. Matching compares SOFTENED fields on both sides, so the
matched Ψ is today's displacement and needs no correction itself. T⁻¹ is
isotropic, so it is a RADIAL CONVOLUTION applied on the glass — no grid:
C(q) = ∫K(|q−q′|)[s₁(q′) − s₁(q)]d³q′ with K the transform of
G(k) = (1/T − 1)·exp(−(kh/κ)⁴), κ = 3, tabulated to 6h. Each choice was
measured:

- **Difference form**: K integrates to zero (G(0) = 0) — a positive core
  and a negative ring — so summed against s₁ itself the glass's quadrature
  error times the whole field would be the answer. On the glass a plane wave
  gets the table's response to 0.15 % of the field, rim included (the rim is
  continued as s₁(q), never zero).
- **Taper**: a GAUSSIAN taper cut the correction 30 % already at λ = 120 Mpc
  (convolution exact — the taper was the loss); a flat-top exp(−(kh/κ)⁸)
  RANG, and truncated at 4h the kernel no longer integrated to zero
  (κ = 3.5 overshot to 1.044). Quartic at 6h: 99.4 % of 1/T − 1 at
  λ = 200 Mpc, rolling off where κ says. 5h lost 3–6 % at long waves.
- **κ**: 3, 3.5 and 4 gave the SAME twin numbers to 0.1 % — so the most
  conservative, κ = 3 (least amplification of sub-resolution grain, the
  failure that rejected shooting in §4e).
- **2LPT only.** Zel'dovich + deconvolution made the CLUSTER twin worse
  (4.1 → 5.3 %, amplitude 1.03): it removes the deficit that was hiding
  Zel'dovich's double-counted collapse — §4f's explanation, confirmed.

Twins (same glasses; recovered linear field | forward miss):

| Planted | Zel'dovich | 2LPT | 2LPT + deconvolution |
|---------|-----------|------|----------------------|
| void δ_L = −1.5 | 8.8 \| 7.2 % | 4.0 \| 3.4 % (amp 0.965) | **1.7 \| 1.3 %** (amp 0.999) |
| cluster δ_L = +0.8 | 4.1 \| 3.3 % | 5.3 \| 4.6 % | 4.4 \| **3.1 %** (amp 1.004) |
| random 3 Mpc waves | 8.6 \| 6.8 % | 8.4 \| 7.2 % | **6.6 \| 4.9 %** |

The cluster's §4f loss is closed on the forward claim (what the page
prints) and within 0.3 % on the recovered field. On the page (void + web,
35 233 elements), today's gravity: 30–60 Mpc 2.7 → 2.6 %, 60–90 4.1 → 3.0,
90–120 8.0 → 7.1, 120–150 19.6 → 18.6, and on the wall 35.1 / 39.7 / 42.0 →
33.0 / 37.9 / 41.5 %; overall 27.5 → 26.6 %. +8 s (~122 s total). Node
accretion +19.5 → +21.8 % to z_obs. Gated: `tests/bootes-softgrowth.mjs`.

NOT corrected, and disclosed where it is used: the second-order term's own
softening deficit (~T on a term ~5 % of Ψ) and modes above the taper, which
the reconstruction never claimed.

### 4h. Finer elements on the wall — measured, and NOT the lever

§4f/§4g read the wall's 33–41 % as the elements' RESOLUTION. Measured
before building the refinement (page configuration throughout):

| Probe | Result |
|-------|--------|
| the MATCHED state (elements placed on today's field, before any evolution) | the wall to **8.7–9.5 %** at 12 Mpc — the elements CAN represent it; the 33–41 % is gained in evolution |
| uniform 9 Mpc elements, full run | wall 33 / 38 / 41.5 → 22 / 24 / 28 %, overall 26.6 → 17.7 % — but 112 412 elements, 445 s (3.6×) |
| a bare glass run z = 9 → z_obs | 0.007 Mpc smoothed drift, rim included — the glass is not the floor |
| fine 9 Mpc elements within 30 Mpc of web matter (+36 % elements, 150 s) | wall galaxies 0–15 Mpc from web matter 32.6 → 24.3 %, 15–25 Mpc 37.1 → 28.7 % — but those carry 13 % of the wall's error; galaxies > 40 Mpc from any web matter carry **76 %** and did not move (37.7 → 37.6 %) |
| the TARGET's smooth field vs the EXACT void (deficit) field (force probe, scale-fitted on r < 90 Mpc) | page layout (13 427 particles, zoom cells → 24 Mpc at the rim, ONE h = 24): 7 % in the core, **91 / 177 / 229 %** at 150 / 180 / 210 Mpc; per-particle h = 2 × cell: 64 / 96 / 103 %; uniform 12 Mpc: 40 / 52 / 58 %; uniform 9 Mpc: 29 / 40 / 45 % |
| uniform 12 Mpc, seed 7 vs seed 99 | 50 / 71 / 71 % apart on the wall — √2 × each one's miss against the exact field: it is GRAIN, not a systematic |

So the wall's "error" is mostly the forecast's OWN sampling grain (outside
the void the deficit's true pull decays, the quiet start's grain does not),
which a smooth past cannot grow into — uniform 9 Mpc elements "improved"
it by copying more of the grain. The refined (mixed-resolution) glass was
built, measured as above and NOT shipped. The lever is the FORECAST's
observed state on the wall — done, with the author's go, in §4i.

### 4i. The forecast's observed state, sampled and relaxed — `createRelaxer`

The N-body's smooth matter is a quiet start of the void's deficit. Measured
against the EXACT model field at the tracers (force probe; errors relative to
the model's TOTAL field there — deficit + web — which is small on the wall
because the void and its wall nearly cancel):

| Observed state | Particles | Core 30–60 | Wall 150 / 180 / 210 Mpc |
|----------------|-----------|-----------|----------------------|
| old zoom (cells → 24 Mpc beyond 1.3 R_eff, one h = 24) | 13 427 | 7.7 % | 172 / 415 / 629 % |
| zoom + per-particle 2 × cell softening | 13 427 | 7.7 % | 121 / 225 / 282 % |
| **uniform 12 Mpc** | 35 233 | 7.2 % | 76 / 122 / 158 % |
| old zoom, relaxed | 13 427 | 2.4 % | 37 / 131 / 278 % |
| **uniform 12 Mpc, relaxed (shipped)** | 35 233 | 2.3 % | **8.4 / 13 / 20.5 %** |

(The relaxed core keeps a ~2–3 % floor against the BARE field that is the
24 Mpc softening, not grain.) Two seeds of the unrelaxed uniform layout
differ by 50–71 % on the wall — √2 × each one's miss — so it is grain.

THE RELAXATION removes only the NON-SPHERICAL part of the smooth matter's
field: each pass subtracts the shell-averaged radial force (2 Mpc bins) and
moves every particle against the rest, r·F_grain/4πGρ̄₀ (the glass
relaxation of §4e step 1, restricted). The quiet start already carries the
profile's spherical part exactly, so that is kept (gated: Δ(<r) ±0.009 after
20 passes; since §4j it is PINNED to the quiet start's enclosed mass). Velocities are recomputed where the particles now sit with the
SAME arithmetic as `observedState` (gated to 1e-6) — they move ~1.7 Mpc rms,
and a stale velocity near a clump is ~10 km/s, the size of the effect.
MEASURED REJECTION: relaxing the WHOLE field onto the analytic deficit table.
The particles and the table differ by a uniform ~0.7 % (softening + tree)
that no arrangement removes; every pass pushed mass outward chasing it, and
20 passes bent the enclosed contrast by up to 0.11 (−0.62 for −0.56 at
20 Mpc) while the residual it minimised fell nicely. The gate now checks the
profile, which is what caught it.

| What moved (page configuration) | Before | After |
|---------------------------------|--------|-------|
| forecast: deepest galaxy vs the shell tracker, 6 Gyr | 7 kpc | 4 kpc |
| forecast: tracers, median / p90 | 35 / 75 kpc | **2 / 4 kpc** |
| forecast: matter ≤ 20 Mpc of the nodes | +4.6 % | +4.1 % |
| forecast: wall-clock in a Worker | ~8 s | ~30 s (20 passes ≈ 13 s) |
| reconstruction: today's gravity 30–60 / 60–90 / 90–120 Mpc | 2.6 / 3.0 / 7.1 % | **1.4 / 1.4 / 4.0 %** |
| reconstruction: 120–150 / 150–180 / 180–210 / 210–240 Mpc | 18.6 / 33.0 / 37.9 / 41.5 % | **6.7 / 12.1 / 19.1 / 35.8 %** |
| reconstruction: overall | 26.6 % | **6.2 %** |

The forecast's headline effect SHRANK, and that is the finding: the
self-gravitating web's own pull on a galaxy over the next 6 Gyr is a few kpc,
and most of what the page used to print was the sampling. Intermediate
layouts land in between (uniform unrelaxed 16 / 28 kpc, relaxed zoom
5–7 / 27–30 kpc), tracking the grain level. The outermost bin is the sphere's
rim, where the model's field is weakest.

(§4j re-measures these with the relaxation it adds — the rim was this grain.)

### 4j. The rim — a flat miss over a vanishing field, and the grain floor under it

"Fix the rim" started from the outermost bins: the forecast's observed state
20.5 % off the model at 210 Mpc, the reconstruction 35.8 % in 210–240 Mpc.
MEASURED FIRST, the rim is not a place where anything goes wrong:

| Forecast observed state (relaxed, §4i) | 30 | 60 | 90 | 120 | 150 | 180 | 210 Mpc |
|-----|----|----|----|-----|-----|-----|-----|
| miss, (km/s)²/Mpc | 418 | 522 | 203 | 183 | 166 | 159 | 151 |
| model total field there | 15 133 | 16 003 | 8 752 | 3 776 | 2 032 | 1 242 | 748 |

The miss is FLAT from the wall to the rim; the field it is divided by falls
~20× because the void and its wall cancel outside the shell — the reason
`influenceProfile` never reports reach as a fraction of the total (§3). Two
tests ruled the edge itself out: sampling the smooth matter to 3.0 R_eff
(275 Mpc, 52 278 particles) with the same tracers left every bin unchanged
(210 Mpc: 151 → 166, noise), and evaluating at θ = 0.25 instead of 0.5 moved
nothing (149), so it is neither truncation nor tree error. (The core's 400–500
is the 24 Mpc SOFTENING, not grain: the particles' unsoftened monopole matches
the exact field to < 0.1 % at 20–200 Mpc, the softened shell average reads
2–3 % low inside the void.)

THE FLOOR is the relaxation's leftover grain. A fixed rate shrinks a grain
mode by (1 − rate·ŵ) per pass, ŵ the softened force's response to it; modes
near the softening scale barely moved at 0.7. 40 passes took 151 → 98 at
twice the cost; larger rates did better per pass but MOVED THE PROFILE
(Δ(<r) drifted 0.016 at 0.7, 0.022 at 1.5, 0.12 at an aggressive Chebyshev
schedule) — subtracting each shell's average radial force does not stop mass
moving radially at second order. Two changes, both in `createRelaxer`:

- **THE MONOPOLE PIN.** After every pass each particle is put back at the
  radius where the QUIET START had the same enclosed mass (rank by radius,
  interpolate the start's cumulative mass at mid-particle) — only |x| changes,
  never the direction. Δ(<r) is then the quiet start's to ~1e-4 whatever the
  steps are (gated: exact on the test layout, unpinned 9e-3).
- **CHEBYSHEV STEP SIZES** over ŵ ∈ [0.25, 1] (`chebyshevRates`), largest and
  smallest alternated so no run of large steps goes unchecked; the product
  polynomial leaves any mode in that band ≤ 6e-10 of itself after 20 passes
  (a fixed 0.7: 0.021). Measured with the pin, same 20 passes and cost:

| Schedule (pinned) | 120 | 150 | 180 | 210 Mpc | history |
|-------------------|-----|-----|-----|---------|---------|
| fixed 0.7 | 185 | 168 | 161 | 153 | monotone |
| fixed 1.9 | 109 | 101 | 89 | 83 | monotone |
| Chebyshev [0.15, 1] | 102 | 90 | 77 | 70 | GREW to 0.45 first; Δ(<r) 1.6e-3 |
| **Chebyshev [0.25, 1] (shipped)** | 109 | 100 | 88 | 81 | monotone, Δ(<r) 1e-4 |

| What moved (page configuration, 1 200 tracers) | §4i | §4j |
|---------------------------------|--------|-------|
| forecast observed state, 150 / 180 / 210 Mpc | 8.1 / 12.8 / 20.2 % | **4.9 / 7.1 / 10.8 %** |
| forecast observed state, core 30 / 60 Mpc | 2.8 / 3.3 % | 2.4 / 2.8 % |
| forecast vs shell tracker, deepest / tracers median / p90 (6 Gyr) | 4 / 2 / 4 kpc | **4 / 1 / 2 kpc** |
| forecast: matter ≤ 20 Mpc of the nodes | +4.1 % | +4.9 % |
| reconstruction: 120 / 150 / 180 / 210 Mpc bins | 6.7 / 12.1 / 19.1 / 35.8 % | 6.3 / 11.2 / 17.8 / 31.9 % |
| reconstruction: overall | 6.2 % | **5.5 %** |

The reconstruction barely moved because its rim is ITS OWN flat floor, not
the target's: its miss is 177 / 195 / 353 / 256 / 221 / 208 / 236
(km/s)²/Mpc from the core to the rim, ≤ 2.3 % of the void's peak pull
everywhere. The MATCHED state (before the forward run) is already at
~80–130 with a small edge bump (133 in the rim bin vs ~80 just inside); the
forward run from z = 9 adds ~200 roughly uniformly — the non-linear
evolution 2LPT + the softened-growth correction do not capture, and not a
rim effect. `fieldMatch` therefore now returns each bin's `abs` and `field`
in (km/s)²/Mpc beside `rel` (gated: rel ≡ abs/field), and the page quotes
the outside of R_eff against the void's PEAK pull ("within ~2 % … out to the
rim", browser-gated < 5 %), never as a share of the vanishing local field.

Next, honestly: the forward run's ~200 (km/s)²/Mpc floor (the reconstruction's
remaining error everywhere, not just the rim); a Bayesian forward model whose
prior regularises the shooting that failed in §4e — and, before any of it
matters for science, a REAL density field in place of the model web (§6).

---

## 5. What is deliberately NOT here

- **No galaxy catalogue.** Astronomy archives are egress-blocked at build time.
  Everything past the published bulk parameters is model, disclosed permanently
  on the page. `scripts/fetch-bootes-anchors.mjs` is the refresher for a
  networked machine.
- **No claim of detection.** Two of the eight tests are labelled *honest null*
  because current instruments cannot detect them for a single void. That is the
  correct answer and saying so is the point.
- **No N-body past by default.** The tracker's N-body mode (§4d) runs forward
  from the observed state; the past becomes an N-body only when the reader
  asks for the reconstruction (§4e), because it costs ~2 minutes and is ONE
  of many pasts compatible with today. The page's Tests 1–8 stay on linear
  theory plus the spherical correction, which is what the void literature
  uses and what keeps every relation checkable as an identity.
- **No WASM.** The whole kernel is ~1 ms per profile rebuild and ~80 ms for the
  influence scan. There is nothing here that needs Rust, and adding it would put
  a compiled artefact between the reader and numbers whose selling point is that
  they are traceable. The N-body forecast (~8 s in a Worker) is the one place
  WASM would pay; it stays JS so the node gate runs the very code the page
  runs — revisit only if the particle count must grow.

---

## 6. Phase 3 — the observational programme (not started)

This is the part that would turn the page into a paper, and none of it is a code
task in this repo:

1. **Reconstruct δ(r) from a real tracer catalogue** (SDSS / 2MRS / DESI) rather
   than fitting an HSW form. This is the single change that would move the most:
   every amplitude on the page inherits the profile.
2. **Compare against Cosmicflows peculiar velocities.** Test 1 becomes a
   measurement rather than a prediction the moment observed v_r(r) can be laid
   over the predicted curve.
3. **Test 2 as a real consistency check.** Density and velocity are independent
   observations; agreement between them is the strongest available evidence that
   the void is a dynamically evolving structure rather than a sampling gap.
4. **Replace the synthetic web with a reconstructed density field**, at which
   point Test 5's alignment statistic stops being circular in its control and
   becomes a real measurement of whether Boötes organises its surroundings.

Until (1) and (4) are done, the honest summary of this page is: *the chain is
right, the identities hold, and the inputs are literature values with a fitted
profile in the middle.*

---

## 7. Gates

```
node tests/bootes-void-model.mjs      # 17 checks — the physics kernel
node tests/bootes-web-model.mjs       # 12 checks — the web + published inputs
node tests/bootes-camera-math.mjs     #  9 checks — the camera + scale arithmetic
node tests/bootes-void-page.mjs       # 10 checks — the DOM contract (incl. probe + tracker + N-body mode)
node tests/bootes-force-probe.mjs     #  9 checks — the force probe's identities
node tests/bootes-void-tracker.mjs    # 12 checks — the tracker's clock, linear + nonlinear shells
node tests/bootes-nbody.mjs           # 10 checks — the N-body kernel (~15 s)
node tests/bootes-reconstruct.mjs     #  9 checks — the initial-conditions reconstruction (~25 s)
npx playwright test tests/bootes-void-smoke.spec.js tests/bootes-void-probe.spec.js tests/bootes-void-tracker.spec.js tests/bootes-void-nbody.spec.js   # 17 + 6 + 11 + 5
node tests/site-sections.mjs tests/simulations-catalog.mjs tests/glyphs.mjs
node scripts/lint-nav.mjs
```

After any IA edit also re-run `node scripts/build-section-pages.mjs` and
`node scripts/build-simulations-page.mjs` — the hub pages are generated whole,
and hand-editing them is reverted by the next run.

**Deep Space is now at the nav cap.** Three section headers (Stars · Black
holes · Cosmic web) and ten links is the editorial limit documented in
`js/site-sections.js`; the next thing that lands in this section goes into an
existing group or onto the hub page only.
