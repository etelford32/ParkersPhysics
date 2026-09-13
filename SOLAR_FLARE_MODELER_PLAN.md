# SOLAR_FLARE_MODELER_PLAN.md — the solar flare modeler: status, decisions, roadmap

> Read `CLAUDE.md` first. This document is the plan for making the flare
> modeler "fully functional, visually and in terms of model fidelity", with
> the geometry contract that now ties it to the Sun page and the orrery.
> Status log at the bottom; the geometry work of 2026-09-13 is DONE, the
> fidelity phases are NOT started.

---

## 0. What "the flare modeler" is in this repo

Two things model a flare here, and they are not the same thing:

| | Where | What it is | Deployed? |
|---|---|---|---|
| **A. Flare Mode** | `star2d.html` (2D Stellar Modeler) · `crates/stellar-mhd-2d/` · `js/mhd/loader.js` · `static/mhd/stellar_mhd_2d.wasm` | A real 2.5-D resistive MHD kernel (PLM + SSP-RK2 + HLLD + GLM cleaning, per-cell η) on a Harris current sheet with a localised η bump — the Yokoyama–Shibata reconnection trigger. Renders \|J_z\|, reports t, peak \|v_y\|, peak \|J_z\|, and pulses ejecta particles on the star canvas. | Yes |
| **B. The X9.0 prototype** | `ET&CLAUDE_SUN_MHD_NASA_X9.0_Flare_2024-10-03` (repo root, added in #956) | A standalone page: field-line RK4 tracing, helmet streamers, HCS/sector boundaries, a free-energy estimate, flare-site detection from \|J\|, prominences, and a "trigger flare" that fires a dome + arc at the highest-J site. Loads three.js r128 from a CDN. | No — an artifact, not linked, and its CDN three violates the vendored-three rule |

**Decision (2026-09-13): A is the modeler.** It has a physics kernel with a
test grid, a WASM build, and a page in the nav. B is the design reference
for the *energy → site → eruption* loop that A does not yet have (§3 Phase
2 and 5). B is not promoted to a page in this plan; if the owner wants it,
it needs the vendored three, nav registration and `lint-nav` — a separate
ask.

## 1. Status of Flare Mode (measured 2026-09-13)

**Works.** The WASM loads lazily on first click, `initFlare({nx:128, ny:64,
lx:4, ly:2})` installs the Harris sheet, `step()` advances it, the inset
shows the sheet pinching and the ±y jets forming, and `peakVy()` drives
`window.__pulseFlare(intensity)` on the star canvas.

**Was wrong / is missing.**

1. **The ejecta jet had no geometry.** It left the star at a hard-coded
   −π/4 ("upper-right, where the inset is"). FIXED: the Flare-Mode module
   now owns a flare SITE (`FLARE_SITE = N20 W45`) and the jet leaves the
   disk along that site's radial through `js/flare-geometry.js`
   `siteOnDisk2D` (north up, west right — the convention every sun renderer
   shares). `window.__star2dFlare` exposes the site, the jet angle and
   Earth's Parker footpoint longitude for tests. Never reintroduce a
   hand-picked angle.
2. **The MHD box is not anchored to the star.** The inset is a corner
   overlay; nothing maps the sheet's (x, y) to the disk. The outflow axis
   (±y in the box) should be the site's radial; the sheet (x) should lie
   along the site's PIL (`tangentFrame(...).pilAxis`). Phase 1.
3. **No energy budget, no class, no clock.** The kernel runs in code units
   (μ₀ = 1, ρ = 1, τ_A = δ/v_A). Nothing converts released magnetic energy
   to erg, to a GOES class, or to seconds. Phase 2.
4. **No reconnection diagnostic.** Peak \|v_y\| is a proxy; the rate
   M_A = v_in / v_A and its η-scaling (Sweet–Parker ∝ η^½ versus the
   Petschek plateau) are the actual physics claim of this configuration.
   Phase 3.
5. **The 3D pages do not consume it.** sun.html's arcade + plume and the
   orrery's arcade take their time dependence from the kernel's class-only
   laws (`arcadeHeight`, `plumeState`). The box could be their oracle for a
   live flare. Phase 4.
6. **No gates.** `crates/stellar-mhd-2d` has no `tests/` directory,
   `build-wasm.sh` does not build it (the committed `.wasm` can drift from
   the Rust silently), and no browser test opens Flare Mode. Phase 6.

## 2. The geometry contract (DONE 2026-09-13)

One kernel, `js/flare-geometry.js` (PURE, `tests/flare-geometry.mjs`),
owns flare-site geometry for every page:

- Stonyhurst strings (W positive), the sun-frame unit vector, the PROGRADE
  rotation (`rotateY` ≡ three.js `makeRotationY`, pinned), the Snodgrass
  differential rate, epoch ↔ now longitude conversion;
- the local tangent frame, Joy's-law bipole tilt, the PIL prior and the
  `tangentFrame` (`pilAxis`, `loopAxis`);
- ribbon separation / width / envelope / decay MIRRORING sunFS's literals
  (the node test reads sun.html and fails on drift), arcade height + shear,
  `arcadeLoops`, `plumeState`;
- Earth-view angle (μ, side-on fraction), heliocentric site direction for
  the orrery, Carrington → Stonyhurst via L0 (`solarEphemeris` now returns
  `l0Deg`, pinned to Meeus 29.a AND to L0 = 0 at the CR-1 epoch),
  Parker footpoint longitude, cone basis, 2D disk placement.

Consumers and their gates:

| Page | What reads the kernel | Gate |
|---|---|---|
| `sun.html` | `u_rotAngle` (ONE accumulator) → sunFS scroll, AR slots, observed de-rotation, ribbon polylines; `setFlareSite()` → every shader's `u_flare_lon`, flash rings, HXR group, `js/flare-arcade.js` arcade + plume | `tests/sun-flare-geometry.spec.js` |
| `solar-system.html` | sun frame (loops, prominences, arcade co-rotate), Carrington → Earth-relative azimuth for spots, CME cone axis, prograde sidereal spin | `tests/solar-system-flare.spec.js` |
| `star2d.html` | `siteOnDisk2D` for the ejecta jet | (Phase 6) |
| `js/swpc-feed.js` | `parseStonyhurst` (was EAST-positive — every SWPC-driven flare fired mirrored) | `tests/flare-geometry.mjs` |

## 3. Fidelity roadmap

### Phase 1 — Anchor the box to the Sun (small)
- Map box (x, y) → the site's tangent frame: x along `pilAxis`, +y along
  `radial` (the upward jet), −y toward the loop-top. Draw the inset AT the
  site, rotated by `siteOnDisk2D(...).angle`, sized to the drawn disk, with
  the jet spawning from the box's top edge instead of the disk centre.
- Node test: box +y ↦ site radial; box x ↦ pilAxis (dot products to 1e-12).
- Exit: the jet, the inset and the site are one geometry on screen.

### Phase 2 — Energy, class and clock (medium)
- In the kernel: `mhd_energy_mag()` (∫B²/2) and `mhd_energy_free()`
  (magnetic minus the potential field for the same B_x boundary flux —
  the box's Harris sheet has a closed-form potential counterpart).
- Physical scaling, DISCLOSED on the panel: δ = 1 Mm, v_A = 1000 km s⁻¹,
  ρ = 10⁻¹² g cm⁻³ ⇒ τ_A = 1 s, B₀ ≈ 100 G, E_box per unit depth; a
  stated sheet depth (100 Mm) turns released energy into erg and a GOES
  class (X1 ≈ 4×10³¹ erg in 0.1–0.8 nm over ~10 min — a calibration, not a
  derivation; print both).
- `cargo test`: energy monotone-decreasing after tearing onset; released
  fraction bounded by the free energy.
- Exit: the panel prints class, elapsed minutes, and energy released, and
  says which numbers are calibration.

### Phase 3 — Reconnection rate (medium)
- Report M_A = v_in / v_A measured at the X-point inflow, alongside peak
  \|v_y\|; plot vs time.
- `cargo test`: over η ∈ {10⁻⁴, 4×10⁻⁴, 1.6×10⁻³} the steady rate scales as
  η^½ within 20 % (Sweet–Parker) with the bump off, and saturates with the
  bump on (Petschek-like). This is the physics the configuration exists to
  show; it is what would catch a broken resistive term.

### Phase 4 — Drive the 3D pages from the box (small once 2–3 exist)
- Publish `flareDrive = { tSim, energyReleasedFrac, outflowVA, classEst }`
  on a `flare-drive` event; sun.html's `flareArcade.update` accepts an
  optional drive so `arcadeHeight` / `plumeState` follow measured release
  rather than the class-only law. Class-only remains the fallback (a live
  flare on the Sun page must never wait for a WASM run).

### Phase 5 — Real initial conditions (medium)
- Seed B₀ (area → field), sheet orientation (Joy's law → `pilAngleRad`)
  and β from the live NOAA region the user picks, so Flare Mode runs
  today's AR. Disclose the 2.5-D idealisation on the panel.

### Phase 6 — Gates and build hygiene (small, do first if time is short)
- `build-wasm.sh`: build `crates/stellar-mhd-2d` to `static/mhd/` (both
  rustc paths, CLAUDE.md §4.3); `tests/stellar-mhd-kernel-smoke.mjs` pins the
  committed WASM against a `cargo test` fixture (peak \|J_z\| at t = 2 on
  the 128×64 grid) so drift fails CI.
- `tests/star2d-flare.spec.js`: WASM loads, Trigger → Run, ≥ 40 steps,
  peak \|v_y\| grows, ejecta spawn within ±0.25 rad of
  `__star2dFlare.jetAngle`.

## 4. Guardrails

- No framework, no bundler (CLAUDE.md §1). The prototype's CDN three is the
  reason it is not a page.
- `js/flare-geometry.js` is the ONE geometry source; the MHD kernel is the
  ONE physics source for the box. Do not re-derive either inline.
- Every number that is a calibration (Phase 2) is printed as one.
- The ejecta angle is derived from the site; never a literal again.

## 5. Status log

- **2026-09-13 — geometry contract shipped.** Kernel + node test (23
  checks), sun.html unified on one prograde accumulator with the arcade +
  plume, orrery Earth-relative placement + prograde spin + arcade, feed
  east/west fix, star2d jet from the site. Fidelity Phases 1–6 open.
