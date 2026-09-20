# Star Collider Lab — design, status, decisions

`star-collider.html` · `js/star-collider/*` · `rust-star-collider/` · 2026-09-20 (clock + transport 2026-09-20)

## 1. What it is

A compact-object merger laboratory. Two real objects from a catalogue of
neutron stars, black holes and white dwarfs (or custom ones) are built on a
nuclear equation of state, spiralled together with a post-Newtonian
integrator, collided in a smoothed-particle hydrodynamics engine, and read
out through the calibrated fits the field uses for the aftermath: remnant
fate, ejecta budget, kilonova light curve.

It is the most physics-dense page in the repo and it is EXPERIMENTAL on
purpose: every link in the chain is a control (EOS, masses, radii, spins,
separation, eccentricity, resolution, viscosity, thermal index, which PN
terms act). The provenance banner and the method section say what is
measured, what is modelled, and what each engine is worth.

## 2. Architecture

```
catalog.js ──resolveProfile(EOS)──▶ profile {M, R, C, Λ, k2, χ, I, kind}
                 │                      │
       eos.js ◀──┤                      ├──▶ inspiral.js  (TaylorT4 3.5PN + tides + SO; Peters)
       tov.js ◀──┘                      ├──▶ remnant.js   (BBH/BNS/NSBH/WD fits; kilonova; magnetar)
                                        └──▶ sph-worker.js ─▶ kernel.js ─▶ star_collider_kernel.wasm
page.js  (the ONE recompute; DOM contract data-sc / data-sc-control / data-sc-chart;
          transport bar + live-vs-rebuild control routing)
sph-worker.js (the run's CLOCK: chunk index, parameter events, checkpoint timeline,
          seek / step / replay / branch — see its header)
scene.js (three.js stage + camera rig: follow / presets / corotating frame / frame-to-fit /
          keyboard / colour modes / trails / pre-run preview; Y-up, rotation-mapped)
charts.js (M–R, waveform, frequency track, kilonova, energy ledger; review cursor)
```

The page opens on the stage (stage → transport → console under the hero;
the lede and the provenance banner follow). The console scrolls on its own
so Build & run stays beside the stage.

Every module under `js/star-collider/` except `page.js`, `scene.js` and the
worker is PURE (no DOM, no fetch, no ambient time) and node-tested.

**Units.** Geometric everywhere the kernel is involved: G = c = 1, mass in
M☉, length in G M☉/c² = 1.4766 km, time in G M☉/c³ = 4.9255 µs
(`eos.js` `GEOM_KM`, `GEOM_S`, `RHO_GEOM`). The EOS crust constants are
cgs with p/c² in g/cm³ (see the eos.js header — reading them as dyn/cm² is
10²¹ low and was the first bug).

## 3. Decisions (each one cost something)

1. **The tidal coefficient is derived, not copied.** (39/8)Λ̃ in the
   TaylorT4 bracket, from V = −(3/2)λ₁m₂²/r⁶ (deformation energy included),
   E(x) and F(x) — written out in `tests/star-collider-inspiral.mjs`. The
   (m₁ + 12m₂) weight it produces is the GW170817 papers' Λ̃ weight, which
   is the check.
2. **Contact uses the 1PN harmonic separation.** Newtonian M/x puts a
   1.4+1.4 SLy pair's contact at x = 0.177, past the ISCO, which would label
   every BNS "isco". At 1PN contact lands at 1.37 kHz — low against NR's
   1.5–2 kHz merger frequencies, and the page says so.
3. **The BBH radiated-energy fit is recalibrated.** The BMR12 spin bracket
   as recalled over-predicted (12 % at χ = 0.7 vs ~8.5 % NR); the structure
   is kept and the bracket pinned to SXS equal-mass 4.8/6.7/9.4 % at
   χ = 0/0.5/0.8 (`ERAD` in remnant.js). Do not "restore" the published
   coefficients without checking them against those three points.
4. **The kilonova diffusion time carries β = 3.** Metzger's one-zone ODE
   without the geometry factor peaks √3 late; with it, AT2017gfo-like ejecta
   at 40 Mpc give ~10⁴² erg/s at ~1 d. The red component still comes out ~2×
   under the observed red peak — a one-zone limit, tolerated and tested.
5. **Bauswein's threshold is reported with its scatter.** GW170817 on SLy is
   a prompt collapse by 0.1 M☉ — inside the ±0.1 M☉ fit residual — so the
   page prints "prompt collapse (marginal)", which is exactly how GW170817
   constrained M_th in the literature. On ENG it is hypermassive, on MPA1
   supramassive, on MS1 stable: the fate flipping with the EOS is the point.
6. **1PN is opt-in in the SPH engine.** At contact γ = M/rc² ≈ 0.17, the 1PN
   bracket is 1 − 0.74 (exact Schwarzschild would be 0.62; 2PN would add
   +0.18 back) and the truncated force stalls the merger at the contact
   radius — measured. The default driver is Newtonian SPH + 2.5PN radiation
   reaction (Lincoln & Will 1990), the Faber–Rasio class. 1PN stays as a toggle
   for wide orbits (γ ≲ 0.05) where the periastron advance is real and fine.
7. **The PN kick is integrated implicitly.** A KDK leapfrog evaluates a
   velocity-dependent force at the half-step velocity: 7.6 % energy loss over
   four circular 1PN orbits at 500 steps each. Two fixed-point iterations on
   the second half-kick take that to 2×10⁻⁸ (`sph.rs` `step()`).
8. **Separation and PN fade use density-weighted cores, not centres of mass.**
   After contact a 5 % tidal tail flung to hundreds of radii drags the
   mass-weighted CM with it — a merged pair read as "separation 134 and
   rising". The (m ρ)-weighted centroid stays on the core. Momentum
   conservation of the kick does not depend on which centroid is used.
9. **Density respects the relaxation isolation.** With `mutual = false` a
   particle sees only its own star; otherwise a light body parked inside a
   heavy one feeds on its density with no matching force and its h collapses
   (ρ_max ran away 36×). Bodies are also parked ±4R apart at build.
10. **The page took Black Hole Accretion's slot in the Deep Space menu**
    (2026-09-20, on the author's call). The menu is at its 10-link cap;
    black-hole-fluid.html stays on the Deep Space hub and in the catalogue.
11. **Follow is a rig translation, never a camera hold** (the TIGA rule).
    Each frame the followed point (system barycentre, core A or core B) moves
    `controls.target`, and the camera is translated by exactly the same
    vector — the user's orbit angle and zoom are never touched. The
    translation is EXACT: an eased version (e-folding 0.18 s) trailed a
    following core by 75° of orbit on a 3 fps software rasteriser, measured
    in the browser gate, and the followed point is a density-weighted
    centroid with no jitter worth smoothing. Presets and frame-to-fit are
    one-shot spherical tweens that any drag, wheel or key cancels
    (`controls`' 'start' event).
12. **The corotating frame is a rotation of the WORLD group, not of the
    camera.** `world.rotation.y = atan2(Z, X)` of the core–core line in the
    scene's x–z plane holds the cores on the x-axis; after the cores
    coincide the last measured ω carries the angle. The follow point is
    converted with `world.localToWorld` so follow and corotation compose.
13. **The frame carries a flags field** (stride 6: x, y, z, log₁₀ρ, u,
    star + 2·unbound). Unbound is the kernel's own Bernoulli test — the
    "bound / ejecta" colour mode and the M_unbound readout share one
    definition, pinned by the kernel smoke (flagged mass == diagnostic).
14. **Before a run the stage previews the configured pair** as wire spheres
    at the configured separation, framed to fit — the camera has the system
    to look at, not an empty grid, and the ring already reads in km. The
    preview re-frames itself when the extent moves by more than a quarter.
15. **The clock is the chunk index, not the wall clock** (2026-09-20). A
    chunk is `advance(chunkDt = 4·dt_max, 64 substeps max)`, so state(k) is
    a function of the build, the seed and the parameter events before k;
    the pace only decides how many chunks run per tick. The first worker
    advanced `warp × wallDt` in four pieces inside a millisecond budget, so
    the substep boundaries depended on the machine and two runs of one
    setup could not agree past the first frame — nothing could be rewound.
    `tests/star-collider-worker.mjs` pins chunk 3 identical across paces.
16. **A snapshot is everything the leapfrog reads, and restore is bit-exact.**
    KDK starts from the PREVIOUS step's acc/du, the timestep reads cs/h/acc,
    the implicit PN correction reads pn_kick/pn_weight, e_gw integrates
    diag[31], and h relaxes by a 0.5 blend on every density pass — so
    positions + velocities + a recompute is NOT the identity. `sph.rs`
    SNAP_* carries all of it (17 f64 per particle + bodies + scalars +
    params); `cargo test snapshot_restore_is_bit_exact` and the kernel
    smoke compare with `Object.is`/`to_bits`, never a tolerance.
17. **Live parameter changes are events on the clock; a change behind the
    head branches.** α, Γ_th, 2.5PN and 1PN are applied as `{chunk, params}`
    events, re-applied on every replay through them, so a run tuned in
    flight rewinds to the states it had. A change while reviewing cannot be
    folded into history without falsifying the recorded frames after it, so
    it truncates the timeline and moves the head to the cursor — and says
    so. Everything else (objects, masses, radii, spins, EOS, separation,
    eccentricity, tidal lock, resolution, seed) is a REBUILD, debounced
    650 ms while "apply changes to the running sim" is on; the console tags
    every field LIVE or REBUILD. THE SCAR: a live run's head is the
    worker's, not the page's — the page's last frame lags by a frame
    interval, and sending that chunk as the event position made every live
    tweak branch the run a few chunks back (caught by the browser gate).
    `at` is sent only while reviewing and ignored by a running worker.
18. **The timeline is capped and thins, never truncates.** Frames + diag
    every `every` chunks, a full snapshot every 4th entry; over 40 MB or
    600 entries it drops every other entry and doubles `every`, so a long
    run is still scrubbable end to end at a coarser resolution the
    transport prints. Scrubbing shows the nearest recorded frame at once
    (no kernel work); releasing replays from the nearest checkpoint — or
    from the kernel's own state when that is nearer — to the exact chunk.
    The head is held in `headSnap` while the kernel is behind it, so Live
    returns exactly. Trails clear whenever the shown time goes backwards.

## 4. What the SPH engine is and is not

Is: cubic-spline SPH, adaptive h (relaxed, no grad-h terms), symmetric
pressure force (exact momentum conservation), Monaghan viscosity, hybrid
cold + thermal EOS (only shocks heat), Plummer-softened direct gravity,
Paczyński–Wiita black holes with sinks, bulk 2.5PN radiation reaction with
E_gw accounting, quadrupole-formula strain from accelerations (exact, no
finite differencing), Bernoulli unbound mass. Deterministic (seeded LCG
jitter only).

Deterministic and rewindable: seeded LCG jitter at build, fixed-chunk
stepping, bit-exact snapshot/restore (decisions 15–18).

Is not: GR hydrodynamics, a nuclear EOS in the hydro (the polytrope is
fitted to the TOV radius), neutrinos, magnetic fields, a tree code (O(N²):
~2.5 ms/step at 400 particles in Node, ~25 ms at 1200). Energy drifts a few
percent per dynamical time once the remnant forms (adaptive h without
grad-h). Post-merger GW emission is measured but not fed back (the bulk
two-body term fades once the cores overlap).

## 5. Gates

```
node tests/star-collider-tov.mjs tests/star-collider-inspiral.mjs \
     tests/star-collider-remnant.mjs tests/star-collider-catalog.mjs \
     tests/star-collider-kernel-smoke.mjs tests/star-collider-worker.mjs \
     tests/star-collider-page.mjs
(cd rust-star-collider && cargo test --release)
npx playwright test tests/star-collider-smoke.spec.js
```

After ANY kernel edit: `cargo test`, rebuild the WASM
(`build-wasm.sh` or `cargo build --release --target wasm32-unknown-unknown`
+ copy to `js/star-collider/wasm/`), commit the binary, run the smoke.

## 6. Roadmap (not done, in order of value)

- Barnes–Hut gravity → 10⁴ particles per star in the browser.
- Grad-h SPH terms → energy conservation through the remnant phase.
- Post-merger radiation reaction from the measured Q⃛ (Burke–Thorne) so the
  remnant keeps radiating.
- Piecewise-polytrope cold EOS inside the kernel (the TOV builder's own
  pieces) instead of the single Γ = 2 polytrope.
- Spin–spin and precession in the PN inspiral; 6PN tidal term.
- Threshold-mass and ejecta fits with quoted uncertainties propagated to the
  kilonova light curve as a band.
- An OG image captured on real GPU hardware (the committed one is a software
  render).
