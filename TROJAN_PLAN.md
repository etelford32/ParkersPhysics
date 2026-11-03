# Jupiter Trojans — plan and status

*Started 2026-11-03.* The Jupiter Trojans are the ~16 000 asteroids that share
Jupiter's orbit, librating about the L4 (leading, "Greek camp") and L5
(trailing, "Trojan camp") Lagrange points. This is the data + dynamics layer;
no page draws them yet (§4).

## 1. What exists

| Piece | File | Gate |
|---|---|---|
| Data route — every SBDB orbit-class **TJN** object (full-precision elements, photometry, orbit quality) + Jupiter and Saturn **Horizons** state vectors at the catalogue's own epoch | `api/trojans/catalog.js`, `api/_lib/trojan-sources.js` | `node tests/trojan-sources.mjs` |
| Dynamics kernel (PURE) — resonant angle, L4/L5 camp, analytic tadpole invariant, epoch alignment, Sun+Jupiter+Saturn integrator that MEASURES libration | `js/trojan-dynamics.js` | `node tests/trojan-dynamics.mjs` |
| Whole-population analysis (worker threads) | `scripts/analyze-trojans.mjs` | — |
| The population list | `scripts/build-trojan-report.mjs` → `data/trojans/TROJANS_LIST.md` | — |
| Status-board registration | `js/pipeline-registry.js` id `trojans-catalog` | `node tests/pipeline-registry.mjs` |

Refresh the list: `curl https://parkersphysics.com/api/trojans/catalog > cat.json`, then
`node scripts/analyze-trojans.mjs cat.json --out data/trojans` and
`node scripts/build-trojan-report.mjs data/trojans [--long <dir of a --years 3000 run>]`.

## 2. Decisions (each one is a scar or a measurement)

1. **φ is formed against Horizons' OSCULATING Jupiter at the catalogue epoch, in
   the same frame.** Mean elements are the disclosed fallback
   (`jupiterSource: 'standish-mean'`); measured 0.016° from Horizons at JD
   2461200.5, so the fallback is good — but the join should not depend on it.
2. **TJN is a box, libration is a motion.** JPL's class is an (a, e) cut. The
   kernel decides membership from φ(t), and the list publishes the impostors
   (§3) rather than hiding them.
3. **The integrator is the authority; the invariant is an estimate.** The
   averaged planar-circular integral `C = ¾x² + 2μF(φ)` is exact in its own
   problem (the gate holds the integrator to it at ≤0.3°) but ignores e, i,
   Jupiter's eccentricity and Saturn. Population median |difference| 0.94°.
4. **Off-epoch rows are aligned by N-body, not two-body.** 1 644 rows sit off
   the shared epoch, many by ~12 yr; the first full run's two-body advance
   produced 173 "non-librators", 143 of them exactly those rows. The gate plants
   Hektor 12 yr back and requires recovery to <1e-5 AU (measured 1.7e-7) with
   two-body as the negative control (0.107 AU off).
5. **Trojan sizes use the Trojan albedo.** Population mean p_V = 0.07 (Grav et
   al. 2011), not the site-wide 0.14 unclassified default, which would draw
   every Trojan 1.41× too small. Measured diameters win where JPL has them
   (1 879 of 16 445).
6. **Optional query refinements ride a 4xx ladder** (quality → full-prec →
   photometry), each self-reported. All three were VERIFIED in production on
   2026-11-03 (`precision: 'full'`, `quality_fields: 'requested'`, 16 445/16 445
   quality rows attached); the ladder stays as defence.
7. **Node runtime, dual-mode entry.** An edge function must start responding
   within 25 s; this route chains SBDB → Horizons, so it runs on Node with a
   50 s deadline. Vercel's Node runtime calls the DEFAULT export as
   `(req, res)` and ignores a returned Response (measured: the request hung to
   the 60 s timeout; a named `GET` export did not help). The entry writes
   through `res` when given one and returns the Response otherwise, for
   `dev-server.mjs`. **The four `api/cron/*` handlers on the Node runtime use the
   failing pattern** — see §5.

## 3. What the first run found (catalogue of 2026-11-03, 600 yr)

- 16 445 TJN objects; **16 304 librate** (10 349 L4, 5 955 L5) — 99.1 %.
- **L4 : L5 = 1.74** overall, but **1.61 among well-determined orbits and ~3.4
  among short-arc ones**: a large part of the catalogue's L4 excess is recent
  discovery history, not dynamics.
- Median libration amplitude 14.8°, median period 152 yr (theory: 148 yr at
  zero amplitude, lengthening with amplitude — the run shows it).
- **The impostors.** Among WELL-DETERMINED orbits (U ≤ 5, arc ≥ 1 yr, on the
  shared epoch) 19 meet Jupiter and one horseshoes; most sit far from ±60°
  (e.g. 118624 at φ = −125°, 2000 CN152 at −160°) — filed as Trojans by their
  semimajor axis, not Trojans by motion. The other ~120 non-librators are
  short-arc orbits whose a is too uncertain for a verdict.
- The full tables are in `data/trojans/TROJANS_LIST.md`.

## 4. Next steps — the big list

**Data**
1. Extend the route to the other Trojan families SBDB files separately — Neptune
   (`TNO` subset with a ≈ 30.1 AU; there is no dedicated SBDB class, so this is
   a dynamical cut we make ourselves), Mars, Uranus, Earth (2010 TK7,
   2020 XL5) — through the same kernel with the planet as a parameter.
2. Ingest **AstDyS synthetic proper elements for Trojans** (Milani 1993;
   proper D, e_p, sin I_p, libration frequency) as a validation set: our
   600-yr amplitudes should correlate with proper D; disagreements are bugs or
   short arcs.
3. Ask SBDB for `rot_per`, `BV`, `UB`, `extent` (shapes / colours) as further
   optional rungs — the Trojan colour bimodality (red vs less-red) is a
   live research question.
4. Record which objects are binaries (Patroclus–Menoetius, Hektor–Skamandrios,
   Eurybates–Queta, Polymele–Shaun) from a curated, cited table.
5. A daily cron that snapshots the TJN count and the L4:L5 ratio so the
   discovery rate (Rubin/LSST is now in operations) is itself a time series.

**Dynamics**
6. Long runs (10⁴–10⁶ yr) with a symplectic Wisdom–Holman integrator in WASM
   (the repo already compiles Rust kernels) to measure DIFFUSION — the real
   stability boundary, which is not the 600-yr regime.
7. Add Uranus and Neptune as perturbers; secular resonances (ν₅, ν₁₆) shape
   the high-inclination edge of the swarms.
8. Proper elements of our own: frequency-analyse φ(t), e(t), i(t) (FFT /
   frequency-modified Fourier) and publish D_p, e_p, I_p with their
   libration/secular frequencies.
9. **Collisional families** in proper-element space (Eurybates — Lucy's target —
   is the archetype; Ennomos, Hektor, 1996 RJ): hierarchical clustering on
   (D_p, e_p, sin I_p).
10. Size–frequency distribution per camp from H with the population albedo,
    and the bias-corrected asymmetry (a magnitude-limited, well-determined
    subset, cut where both camps are complete).
11. A Monte-Carlo clone run for the short-arc objects (sample their covariance
    once SBDB's `sigma_*` fields are added) to turn "uncertain" into a
    probability of libration.
12. Escape-route statistics for the impostors: where do the objects that
    leave go (Jupiter-family comets, Centaurs, Hildas)?

**Product**
13. **Orrery layer** on solar-system.html: the two swarms as an
    instanced point cloud (reusing the NEO layer's Lommel–Seeliger impostor
    and pixel-space picking), coloured by camp, with a "co-rotating with
    Jupiter" frame toggle that turns the swarms into the textbook tadpole and
    horseshoe drawings.
14. A **libration replay**: pick an object, play its φ(t) and a(t) from the
    integrator as a tadpole curve in the rotating frame beside its orbit.
15. A **Lucy mission tracker** card: the spacecraft's encounter dates against
    the five targets' live positions.
16. A Trojans section on the Deep/Local Space hub page (the nav menus are at
    their 10-link cap; the hub is where overflow belongs — `js/site-sections.js`).
17. Observer view: where the L4 and L5 clouds are in tonight's sky, through
    SkyView's engine (one ephemeris, no second copy).
18. Status-board probe: once production has served the route, confirm the
    `trojans-catalog` row reads green and trim the 4xx ladder if desired.

## 5. Found in passing

`api/cron/archive-forecasts.js`, `farside-ingest.js`, `validation-rerun.js` and
`refresh-weather-grid.js` declare `runtime: 'nodejs'` and RETURN a Response
from their default export, which this route measured as ignored by Vercel's
Node runtime (request hangs to the timeout). Their side effects may still
complete; verify in the production logs and apply the dual-mode entry from
`api/trojans/catalog.js` if confirmed.
