# Inner Earth — dataset scope and plan

**Status:** SCOPED + DECIDED (2026-11-18, §0). **P0 SHIPPED** (kernels only,
no page): `js/earth-interior/prem.js` + `conductivity.js`, gate
`node tests/earth-interior-prem.mjs` (25 checks, CI `earth-interior-kernels.yml`).
P0 measured: C/MR² 0.33080 (DA81 0.3308), M 5.9732×10²⁴ kg (0.017 % from
GM⊕/G); every G-scaled g/p value sits a uniform 0.065 % above DA81's print
(a G-convention offset, pinned); TauP's isotropic equivalent differs from DA81's
isotropic polynomials by ≤ 1.2×10⁻³ km/s in the anisotropic 24.4–220 km band.
100 nT at 600 s gives 0.011 V/km (ocean, 7 kS) vs 0.19 (global land) vs 0.027
(10 km of 0.3 S/m sediment): the first P1 numbers. `core-model.js` is NOT yet
switched to these kernels (TIGA unchanged). Every source below was
**probed from the build sandbox on 2026-11-18**: what is reachable, which
copy, which version, how big. Numbers marked *measured* were computed here.
**Page:** `earth-interior.html` (Earth & Orbit section), a NEW simulation that
shares kernels with TIGA but not its stage.

## 0. Decisions (owner, 2026-11-18)

1. **A new Earth-interior simulation** (`earth-interior.html`). It shares
   kernels with TIGA (`igrf.js` stays the one field evaluator) and has its own
   stage.
2. **Both audiences, focused on OPERATORS.** The phase order is set by
   operational value (§9). The cutaway and the column probe are the shared
   surface.
3. **3-D mantle tomography: scoped** (§10).
4. **CHAOS-8.1 from the ESA mirror is the starting point**; refresh to DTU's
   current 8.x later.
5. **Show CFM's preliminary northern faults (flagged), and add as much data
   as commercial-use terms allow.** The licence inventory is §11, and its
   tiers are BINDING: nothing in tier C or D ships without the action listed.

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

## 7. Phasing

See §8: the order is now set by operator value.

---


## 8. Phasing — operator order (supersedes the first draft's order)

| Phase | Ships | Operator it serves | Licence tier (§11) |
|---|---|---|---|
| **P0** | `prem.js` + `conductivity.js` kernels, gated (no network, no page) | foundation for every phase below | A |
| **P1** | **Geoelectric hazard (GIC)**: 1-D conductivity column per site (Grayver mantle under CRUST1.0/ocean conductance) → plane-wave impedance Z(ω) → E(t) from TIGA's live USGS observatory B(t) | power-grid / pipeline operators | A (mantle σ) + C (CRUST1.0 thickness, see §11) |
| **P2** | **Field at orbit**: CHAOS-8 through an extended `igrf.js` (variable nmax + time spline); |B| at altitude, SAA position/drift, SV | satellite operators (magnetorquers, SAA radiation exposure) | B |
| **P3** | **Quake context**: Slab2 + GEM Global Active Faults + USGS Quaternary Faults + CFM 7.0 → each live USGS event labelled (interface / intraslab / upper plate / near mapped fault) with distances | infrastructure + insurers | A + B |
| **P4** | **The page**: cutaway globe at true radii, the column probe (`column.js`), slab surfaces, faults, CMB field; layers OFF until enabled | both | — |
| **P5** | **Gravity**: EGM2008 geoid + gravity anomaly; degree ≤ 36 to the stage, full grids baked | satellite OD context, surveying | A |
| **P6** | **Tomography** (§10), only after permission | context | C |

P1 comes first because it is the one place where **the interior changes a
space-weather number an operator acts on**: the same storm makes 10× more
geoelectric field over resistive shield than over conductive sediments.
That joins the interior model to the platform's core (TIGA, live geomag,
the storm forecasts) and is not a museum exhibit. **Honest label:** 1-D layered
Earth under a plane-wave source, which is the NERC TPL-007 benchmark method.
It is NOT a 3-D magnetotelluric (MT) inversion. Coast effects and 3-D
structure are absent, and the page says so. Gate: the analytic impedance of a
uniform half-space, Z = √(iωμ₀/σ), exactly, plus a two-layer analytic case.

## 9. Why operators (what each operator actually gets)

- **Grid / pipeline:** E-field (V/km) now and during a forecast storm at
  their location, with the ground model that produced it shown as a column.
  This is the product wedge.
- **Satellite:** CHAOS field at their altitude and the SAA boundary drifting
  west. `igrf.js` `findSAA` already exists; CHAOS adds the secular variation
  and degree 14–20.
- **Infrastructure / insurance:** "what is this quake": the slab and fault
  context in seconds, with no label outside data coverage.
- **Everyone:** the column probe, the one picture that ties it together.

## 10. Tomography — scope

**What it adds:** lateral structure in the mantle. The two LLSVPs (large
low-shear-velocity provinces) under Africa and the Pacific, slabs as fast
curtains into the lower mantle, plumes. PREM alone draws onion shells.

**Candidates found (all reachable, measured 2026-11-18):**

| Model | Copy | Format | Licence status |
|---|---|---|---|
| SEMUCB-WM1 (French & Romanowicz 2014) | `bsl-group/SEMUCB-WM1-Model` @ `870eb96` (the authors' own repo) | A3d splines + reader | **no licence file** |
| S40RTS (Ritsema et al. 2011) | `romaguir/sph_models` @ `a2bbef1` (`S40.*.sph`, plus S20RTS, GAP_P4, GypSum_S) | SH degree 40 × 21 radial splines (easy to evaluate in a shader) | **no licence file**, third-party copy |
| SAVANI (Auer et al. 2014) | `auerl/savani` @ `9348e27` (authors) | 1° ASCII grids | **no licence file** |
| GLAD-M25 (Lei et al. 2020) | `caiociardelli/gladm25` @ `16d1ec8` | SphGLL blocks | **GPL-3.0** |

**Verdict: no tomography model is cleanly licensed for commercial use.** No
licence means all rights reserved. GPL on a data file served to browsers is a
copyleft question nobody should answer by accident. **Action: written
permission from the authors** (one email each; a short letter naming the
commercial use and the attribution). Start with S40RTS (cheapest to
evaluate: SH × splines) and SEMUCB-WM1 (authors' repo, highest resolution).

**Gates once permitted:** the LLSVPs emerge as dVs < −1 % at the CMB under
Africa and the Pacific (positions measured, not typed); fast anomalies sit
beneath Slab2 slabs at 400–660 km more often than a shuffled-slab control;
two models agree on the large scale (correlation by degree, reported) and
disagree on the small scale. That disagreement is shown as a feature,
the "vote map" idea.

## 11. Data inventory under commercial-use terms

Tiers: **A** public domain / permissive, ship it · **B** attribution or
share-alike, ship with the obligation · **C** no licence or ambiguous, **ask
the authors in writing first** · **D** non-commercial, never ship (the
INTERMAGNET precedent in TIGA). Licences marked † were read from the
reachable copy; the others are recalled and must be confirmed against the
canonical page before shipping.

| Dataset | Use | Copy | Tier | Licence / obligation |
|---|---|---|---|---|
| PREM | radial structure | published table | A | cite DA81 |
| Grayver et al. 2017 σ(r) | mantle conductivity (P1) | ChaosMagPy 0.16 wheel `lib/Earth_conductivity.dat` (sha256 `d3c59317…56ed`) | A | package MIT †; cite the paper |
| Slab2 | slabs | `ndb38/arc-metals` | A | USGS public domain |
| USGS ComCat | live quakes (already used) | USGS feed | A | public domain |
| USGS Quaternary Faults, NSHM23 fault sections | US faults beyond CA | USGS (blocked here; reachability TBD) | A | public domain |
| NOAA EMAG2v3 | crustal magnetic anomaly, 2 arc-min | NOAA (blocked) | A | public domain; cross-checks CHAOS n ≤ 185 |
| NOAA ETOPO 2022 / GEBCO | relief and bathymetry for the column top | (blocked) | A / B | public domain / GEBCO attribution |
| EGM2008 | geoid + gravity (P5) | NGA (blocked); `flightaware/egm2008` BSD-3 † derived grid as a stopgap | A | NGA unlimited distribution |
| SCEC CFM 7.0 (incl. preliminary N/central CA, flagged) | CA faults | `harvardvizlab/cfm7-fault-explorer` | B | BSD-3 † — keep the notice |
| CHAOS-8.1 | field | ESA-VirES mirror | B | DTU: free with citation (confirm terms page) |
| GEM Global Active Faults | world faults | `cossatot/gem-global-active-faults` @ `5681650` (10.6 MB geojson) | B | **CC BY-SA 4.0** † — our baked derivative must be published CC BY-SA too (fine; the app code is unaffected) |
| PB2002 plates (Bird 2003) | plate boundaries | `liveatlasearth/tectonic-plates-and-faults` (CC BY-SA 4.0 †, a derivative) | B | prefer Bird's original file; cite |
| Seafloor age (Seton et al. 2020) | lithosphere age → thickness | EarthByte (blocked) | B | CC BY 4.0 |
| Global Heat Flow Database (IHFC) | surface heat flow | GFZ (blocked); `ihfc-iugg/ghfdb-portal` is CODE (MIT) | B | CC BY 4.0 (release data) |
| CRUST1.0 | crust | `jrleeman/Crust1.0` (MIT applies to the PYTHON; the model files carry no licence) | **C** | **ask Laske et al.** — blocks P1's crust term until answered (P1 can run with a stated generic crust meanwhile) |
| LITHO1.0 | lithosphere thickness | `underworldcode/litho1pt0` GPL-3.0 † | C | ask Pasyanos / LLNL for the original terms |
| Tomography (§10) | mantle | various | C | ask authors |
| Global CMT | focal mechanisms | (blocked) | C | free, no licence; ask or link only |
| GEM hazard/risk maps | — | — | **D** | CC BY-NC-SA — never ship |

**Permission letters to send (owner):** Laske (CRUST1.0) · Ritsema (S40RTS) ·
Romanowicz (SEMUCB-WM1) · Pasyanos (LITHO1.0) · DTU (confirm the CHAOS terms in
writing). Keep the replies in `data/earth-interior/PERMISSIONS.md`.
