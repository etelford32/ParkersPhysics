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
every particle — the void's smooth matter (~13 400, quiet start sampling
ρ̄(1 + δ⁻) to 2.6 R_eff) and the web's 802 mass particles — gravitates on every
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
8.4 s in a Worker; the self-gravitating web moves the deepest void galaxy
~6 kpc from the shell tracker over the next 6 Gyr (median tracer 35 kpc, p90
75 kpc, against a median forecast displacement of 0.2 Mpc); smooth matter
within 20 Mpc of the web's nodes grows +3.7–4.6 %. REAL BUT SMALL: Λ is
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

### Phase 2 — the past as an N-body (documented, not built)

Running the web BACKWARD is not "the same integrator with dt < 0": gravity
amplifies forward and the inverse problem is ill-posed — a clumped web at z_obs
is consistent with many initial fields, and noise in it grows backwards. What
it would take:

1. A reconstruction of the initial linear field from the observed (here:
   modelled) web — constrained realisations (Hoffman & Ribak 1991), or
   least-action / Monge–Ampère–Kantorovich reconstruction (Peebles 1989;
   Brenier et al. 2003), or a forward-model Bayesian sampler (BORG-style).
2. Initial conditions at z ≈ 50–100 drawn from it (2LPT), run FORWARD with this
   kernel, and scored against the observed state at z_obs.
3. Only then would the track before z_obs be N-body; until then it is the shell
   reconstruction, and the card says so. Running the shell flow backwards is
   well-posed only because the spherical problem has one degree of freedom per
   shell and an exact inverse (`shellTable.invert`).

---

## 5. What is deliberately NOT here

- **No galaxy catalogue.** Astronomy archives are egress-blocked at build time.
  Everything past the published bulk parameters is model, disclosed permanently
  on the page. `scripts/fetch-bootes-anchors.mjs` is the refresher for a
  networked machine.
- **No claim of detection.** Two of the eight tests are labelled *honest null*
  because current instruments cannot detect them for a single void. That is the
  correct answer and saying so is the point.
- **No N-body PAST.** The tracker's N-body mode (§4d) runs forward only; the
  past is the exact spherical-shell reconstruction plus the linear web, because
  an N-body past needs a reconstruction of the web's initial field (§4d
  Phase 2). The page's Tests 1–8 stay on linear theory plus the spherical
  correction, which is what the void literature uses and what keeps every
  relation checkable as an identity.
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
npx playwright test tests/bootes-void-smoke.spec.js tests/bootes-void-probe.spec.js tests/bootes-void-tracker.spec.js tests/bootes-void-nbody.spec.js   # 17 + 6 + 11 + 4
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
