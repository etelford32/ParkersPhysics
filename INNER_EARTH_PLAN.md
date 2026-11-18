# Inner Earth — dataset scope and plan

**Status:** SCOPING (2026-11-18). Nothing built. Every source below was
**probed from the build sandbox on 2026-11-18**: what is reachable, which
copy, which version, how big. Numbers marked *measured* were computed here.
**Proposed page:** `earth-interior.html` (Earth & Orbit section) — see §8 Q1.

The ask: start an interactive Earth-interior model from five datasets that
together give the structural and magnetic foundation —
**PREM + CRUST1.0 + Slab2 + SCEC CFM + CHAOS-8**.

---

## 1. What each dataset actually is (and is not)

| Dataset | What it is | Coverage / resolution | What it is NOT | Honest label |
|---|---|---|---|---|
| **PREM** (Dziewonski & Anderson 1981) | 1-D reference: ρ, Vp, Vs, Q_μ, Q_κ as piecewise **polynomials in radius**. First-order jumps at 15 / 24.4 / 220 / 400 / 670 / 2891 / 5149.5 km depth (*measured* in `prem.nd`), plus polynomial-only boundaries at 80 and 600 km | Whole Earth, radial only. Transversely isotropic 24.4–220 km | Lateral structure. Hot/cold mantle. Slabs. Any 3-D tomography | *reference model* |
| **CRUST1.0** (Laske, Masters, Ma & Pasyanos 2013) | Per 1°×1° cell: tops of 9 layers (water, ice, 3 sediment, 3 crystalline crust, then Moho) with Vp, Vs, ρ in each | Global, 64 800 cells. Where there is no local data, cells are filled by **crustal-type extrapolation** | A measurement at every cell. Anything below the Moho except one uppermost-mantle value | *compilation* |
| **Slab2** (Hayes et al. 2018, USGS) | Depth, dip, strike, thickness and **uncertainty** grids of the subducting slab surface | 27 subduction zones, ~0.05° grids | Global mantle. Slab below where seismicity and tomography constrain it (the `unc` grid says where) | *observed geometry + uncertainty* |
| **SCEC CFM 7.0** (Plesch, Marshall & Shaw 2024) | 608 triangulated 3-D fault surfaces (556 preferred, 39 alternative, 13 rupture) + per-fault metadata | **California only.** Southern CA is mature; central/northern CA additions are *preliminary pending community evaluation* (the release says so) | A global fault model. A slip-rate or hazard model | *regional community model* |
| **CHAOS-8** (Finlay, Kloss, Olsen et al., DTU) | Spherical-harmonic geomagnetic field from Swarm/CHAMP/Ørsted + observatories: **time-dependent core field n ≤ 20** (B-spline in time) + **static lithospheric field n = 21–185** | 1997 → present (the core part past the last data is extrapolated) | A dynamo. The external/ionospheric field (separate model parts) | *observation-derived* |

**The geographic mismatch is the first design fact.** PREM, CRUST1.0 and
CHAOS are global. Slab2 is the world's 27 trenches. CFM is one state. The
interior view is therefore **global by default with two regional zoom-ins**,
not one uniform 3-D Earth. Pretending CFM-style fault detail exists
everywhere would be the Moon-terrain trap (synthesised detail indistinguishable
from data).

---

## 2. Reachability — measured 2026-11-18

Every canonical host is egress-blocked from the build sandbox (IRIS EMC,
igppweb.ucsd.edu, space.dtu.dk / spacecenter.dk, sciencebase.gov, scec.org,
zenodo.org). PyPI and GitHub are reachable, and each dataset has a reachable
copy there. Same pattern as volcanoes and glaciers: **a sha256-pinned copy
from a reachable mirror, gated, plus a `scripts/fetch-*.mjs` refresher that
verifies the mirror against the canonical host on a networked machine.**

| Dataset | Reachable copy (pin) | Version in copy | Size | Canonical (blocked) | License |
|---|---|---|---|---|---|
| PREM | Transcribe the polynomials from DA81 Table 1. **Cross-check** against `obspy/taup/data/prem.nd` in the ObsPy 1.5.2 wheel (PyPI) | Isotropic PREM, no ocean layer (starts at 5.8 km/s crust) | 5.4 KB | ds.iris.edu EMC | published table; ObsPy LGPL-3 (used only as a test oracle, not shipped) |
| CRUST1.0 | `jrleeman/Crust1.0` @ `c38babe` — `model/crust1.{bnds,vp,vs,rho}`, 64 800 rows each (bnds sha256 `77ea8ef6…b2cf`) | 1.0 (2016 copy) | ~11 MB raw | igppweb.ucsd.edu/~gabi/crust1 | mirror MIT; the model itself is freely distributed by its authors with no explicit license → **cite, and verify against canonical** |
| Slab2 | `ndb38/arc-metals` @ `543bf32` `…/supporting_datasets/Hayes2018/` — all 27 slabs × {dep, dip, str, thk, unc} `.grd` + contours | Slab2_2018 release (02.23–02.26.18 files) | 0.2–0.6 MB per depth grid | ScienceBase doi:10.5066/F7PV6JNV | USGS → public domain |
| CFM 7.0 | `harvardvizlab/cfm7-fault-explorer` @ `020294a` — 2000 m meshes as base64 Float32 + metadata JSON (8.9 MB) | 7.0 | 8.9 MB | Zenodo doi:10.5281/zenodo.13685611 (500/1000/2000 m TSurfs) | BSD-3 (CFM authors) |
| CHAOS-8 | `ESA-VirES/MagneticModel` @ `6aa2d4f` `eoxmagmod/data/CHAOS-8.1_{core,core_extrapolated,static}.shc` | **CHAOS-8.1**, extracted 2024-10-14, core samples 1997.10 → 2025.10 | 2.1 MB core | space.dtu.dk CHAOS-8 | DTU distributes freely with citation; mirror's terms to confirm |

Bonus found on the way: the **ChaosMagPy 0.16 wheel ships
`Earth_conductivity.dat` (Grayver et al. 2017)**, a measured 1-D mantle
conductivity profile. It is the honest replacement for the five hand-picked σ
values in `js/geomag/core-model.js` `LAYERS` (see §4). ChaosMagPy itself (MIT,
on PyPI) is also the **test oracle** for our CHAOS evaluation.

**Version caveat:** the user asked for CHAOS-8. The reachable copy is 8.1
from October 2024. DTU very likely has a newer 8.x, and the refresher should
record which is current. The two repo copies of CRUST1.0 and Slab2 are
third-party re-hosts, so their integrity is **UNVERIFIED** until the
refresher compares them byte-for-byte with the canonical files. Say so on the
page until it has.

---

## 3. What already exists — reuse, never fork

| Piece | Where | How the interior model uses it |
|---|---|---|
| Field evaluation (Schmidt P, downward continuation, grids, Lowes spectrum) | `js/geomag/igrf.js` — **the single source of truth** (TIGA hard rule) | CHAOS goes through it. It needs a coefficient set with its **own nmax** (20 core, 185 lithosphere) instead of the fixed IGRF `NMAX = 13`; mind the fixed-stride Legendre tables noted at the top of `igrf.js`. **Extend it, never write a second evaluator.** |
| Core layers, dimensionless numbers, mantle screening, diffusion | `js/geomag/core-model.js`, `diffusion.js` | Should READ radii from the PREM kernel. Today it types 5711 km for the upper/lower-mantle boundary (= 660 km depth); PREM's is 5701 (670 km). Small, but two Earths in one repo is how drift starts |
| 3-D core stage (CMB B_r shader, tubes, cutaway, camera rule) | `js/geomag/core-3d.js` on tiga.html | Pattern + camera rules (one-shot flights, no spring, never rebuild controls without `camera.up` first). Q1 decides whether to share the stage or only the kernels |
| Layer/MoI/gravity/pressure kernel pattern | `js/moon-interior-model.js` | Same shape for Earth: ρ(r) → M(r), g(r), p(r), C/MR², gated against measured values |
| Live earthquakes | `js/earth-feeds.js` (USGS M2.5+ 30 d) on earth.html | Placed against Slab2 / CFM (§5) |
| Volcano catalogue (VOTW, tectonic setting) | `data/volcanoes`, `js/volcano-engine.js` | The arc-above-slab gate (§5) |
| Relief / coastlines / frame | `assets/earth/relief-*`, `js/geo/coords.js` (+X Greenwich, +Y north, −Z = 90°E) | One frame for every layer |

---

## 4. Architecture (proposed)

```
scripts/build-earth-interior.py     bake: mirrors → compact binaries, sha256-pinned, --check
scripts/fetch-earth-interior.mjs    networked machine: verify mirrors vs canonical hosts
data/earth-interior/SOURCES.md      provenance, versions, pins, licenses, the measured split
data/earth-interior/*.bin.gz        CRUST1.0 grid, Slab2 grids, CFM meshes, CHAOS coeffs

js/earth-interior/prem.js           PURE: ρ, Vp, Vs, Q(r) polynomials; M(r) g(r) p(r) K μ; C/MR²
js/earth-interior/conductivity.js   PURE: Grayver 2017 σ(r) (core-model.js imports it)
js/earth-interior/crust1.js         PURE: decode, cell lookup, column profile, Moho, isostasy
js/earth-interior/slab2.js          PURE: decode, slab depth/dip/unc at (lat, lon), cross-sections
js/earth-interior/cfm.js            PURE: meshes in the canonical frame, distance-to-fault
js/earth-interior/chaos.js          PURE: .shc + B-spline in time → coeffs at t; then igrf.js
js/earth-interior/column.js         PURE: THE JOIN — one radial profile at (lat, lon) from all of the above
js/earth-interior/stage.js          three.js renderer only, draws kernel numbers
earth-interior.html
tests/earth-interior-*.mjs + tests/earth-interior-smoke.spec.js
```

Shape rules, matching the rest of the repo: kernels are pure and node-gated,
the renderer computes nothing, assets are baked (no runtime proxy for
static models), lazy-loaded by layer, and a dead asset draws nothing and says
so.

**`column.js` is the product.** "Pick any point and see the Earth beneath
it": ocean → CRUST1.0 layers → Moho → (Slab2 surface, if inside one of the 27
zones, at its depth ± `unc`) → PREM mantle → CMB (CHAOS B_r continued down)
→ outer/inner core. The join has to state its seams. CRUST1.0 *replaces*
PREM's 1-D crust (15/24.4 km) above the local Moho, and PREM resumes below
it. That re-hangs PREM's lid, and §5 measures what it costs in mass.

---

## 5. Gates — the physics each dataset must reproduce

Every gate is an identity or a published measured number, and each gets a
NEGATIVE CONTROL that has to fail (repo rule: a threshold without a control
is a guess).

**PREM.** Integrated mass = 5.9722×10²⁴ kg, C/MR² = 0.3307 (observed); g at
the CMB ≈ 10.7 m/s²; central pressure ≈ 364 GPa; continuity across every
discontinuity where PREM says continuous. *Measured on the ObsPy nodes today,
with linear interpolation:* **M = 5.9755×10²⁴ kg, C/MR² = 0.3309.** The
transcribed polynomials must beat that, and match the 88 `prem.nd` nodes to
the file's printed precision. Negative control: drop the inner-core density
jump and C/MR² must move out of the band. Then **seismic rays**: tracing P
through Vp(r) must open the P shadow zone at ~103°–142°, checked against
`obspy.taup` PREM travel times at fixed distances (offline, baked oracle).

**CRUST1.0.** Layer tops monotonic and every thickness ≥ 0 in all 64 800
cells. Cell lookup reproduces the reference `getCN1point` at test points,
**index convention included** (row order from 89.5° N, −179.5° E; an
off-by-one cell is the classic silent bug). **Isostasy:** lithostatic
pressure at a 250 km compensation depth (CRUST1.0 column over PREM below the
Moho), compared across cells, should be far flatter than the topography's own
load. Report the measured scatter; do not tune toward a target. Negative
control: a constant-thickness crust under the same topography must scatter
much more.

**Slab2.** Depth-grid sign convention (Slab2 depths are negative km) and
0–360° longitude pinned. Then two emergent checks against data we already
hold. (1) **Arc front above the slab:** join the volcano catalogue's
subduction-zone volcanoes to Slab2 depth beneath each. The published
distribution is roughly 70–170 km, mean ~100 km (Syracuse & Abers 2006); we
report OUR measured distribution, with a ±1° shuffled-position control.
(2) **Live quakes:** label each USGS event as interface / intraslab / upper
plate by its depth against Slab2 ± `unc`, and only inside the grid. Outside
the grid it gets *no label*, never a guess.

**CFM.** NAD27 / UTM 11N → WGS84. The datum shift is ~100 m-class, below the
2000 m mesh spacing, but disclosed. Gates: round-trip a few fault traces
against the 5.3 `lonLat` traces in `SCECcode/CFM` (BSD-3, reachable), and
check that SoCal M≥2.5 seismicity sits measurably closer to CFM surfaces than
a shuffled control.

**CHAOS.** Our evaluator (through `igrf.js`) against ChaosMagPy at a grid of
points and epochs: nT agreement within the shc rounding. CHAOS-8 vs IGRF-14
at 2020.0 for n ≤ 13: a few nT, the known model difference, reported rather
than forced to zero. The **Lowes–Mauersberger knee** (core-dominated → crust
flat, ~n 14) becomes MEASURED from CHAOS core + lithosphere instead of the
sentence asserted in `core-model.js`. Secular variation / secular acceleration
at the CMB come from the spline derivatives. Geomagnetic jerks may be called
out **only where the model's own SA changes sign**, never from a literature
list. Past the last data epoch: the `_extrapolated` file, labelled as such.

---

## 6. Data budget

| Asset | Raw | Ship as | Loaded when |
|---|---|---|---|
| PREM | 5 KB | code constants | always |
| Grayver σ | <1 KB | code constants | always |
| CRUST1.0 | ~11 MB | int16-quantised layer tops + per-type velocity/density tables, gzip; aim < 1 MB | crust layer / column probe |
| Slab2 (27 × dep + unc) | ~10–15 MB | int16 per grid, sharded per slab; dip/strike/thk optional | slab layer / probe inside a zone |
| CFM 7.0 (2000 m) | 8.9 MB | quantised positions, one shard | California inset only |
| CHAOS core | 2.1 MB | Float32 spline coefficients, n ≤ 20 | field layer |
| CHAOS lithosphere (n ≤ 185) | ~0.6 MB coeffs | precomputed B_r map at the surface (evaluating n = 185 per vertex is too slow for a browser) | crustal-field layer |

---

## 7. Phasing (proposed)

- **P0 — PREM + conductivity kernels.** No network needed. Gates above;
  `core-model.js` reads radii and σ from them, and **all existing TIGA gates
  must pass unchanged** except where the σ swap moves a printed number. Any
  such move is listed in the PR, not quietly re-baselined.
- **P1 — CRUST1.0** bake + `crust1.js` + the column probe (PREM + crust).
- **P2 — Slab2** bake + kernel; quake labelling + the arc-depth gate.
- **P3 — CHAOS-8** — extend `igrf.js` to variable nmax + the time spline;
  ChaosMagPy oracle; TIGA can then offer CHAOS as an alternative core field.
- **P4 — the page**: cutaway globe at true radii, the column probe, slab
  surfaces under the trenches, CMB field. Tiered layers, OFF until enabled.
- **P5 — CFM** California inset (regional camera, its own disclosure).

Each phase ships with its refresher run on a networked machine, or with the
page saying the mirror is unverified.

---

## 8. Decisions for the owner

1. **Where does it live?** (a) a new `earth-interior.html` with its own stage
   that *shares the kernels* with TIGA (recommended: TIGA is a geomagnetic
   estimator, and the interior is broader than magnetism); or (b) new layers
   on TIGA's existing Core stage.
2. **Audience first?** A B2G / operator angle (slab + fault context for live
   quakes) or an education / exploration angle (the cutaway + column). It
   changes P2-vs-P4 order.
3. **3-D mantle tomography** (e.g. S40RTS, SEMUCB-WM1, GLAD-M25) is the
   obvious next dataset: PREM alone makes the mantle a set of featureless
   onion shells. Out of scope for now, unless you want it scoped too.
4. **CHAOS version:** accept 8.1 from the ESA mirror now and refresh to
   DTU's current 8.x from a networked machine, or wait for the canonical file?
5. **CFM's preliminary northern faults:** show them, flagged, or Southern
   California only?
