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
| Lean wire format `trojan-v2` + its one decoder `recordsFromCatalog` (reads the original row shape too) | `js/trojan-dynamics.js` | both gates (round trip on real rows) |
| Whole-population analysis (worker threads; `--require-live` refuses a degraded body) | `scripts/analyze-trojans.mjs` | — |
| **The precomputed artifact pages load** — `trojan-dynamics-v1`, columnar, one row per object (regime, amplitude, period, φ range, run-averaged a/e/i, size, orbit quality, and the PROPER elements D_p, f, e_p, g, sin I_p, s — null where the run cannot resolve them) | `data/trojans/trojans-dynamics.json` via `encodeDynamics` / `decodeDynamics` | `node tests/trojan-dynamics.mjs` |
| Frequency analysis (NAFF, PURE, reusable) | `js/frequency-analysis.js` | `node tests/frequency-analysis.mjs` |
| Proper elements (`properLibration`, `properSecular`, `PROPER`) | `js/trojan-dynamics.js` | `node tests/trojan-dynamics.mjs` (theory + REAL objects vs AstDyS) |
| AstDyS synthetic proper elements relay — the external validation set (VERIFIED Jun 2024 `tro.syn`, 11 867 Trojans) | `api/trojans/proper.js`, `api/_lib/astdys-proper.js` | `node tests/astdys-proper.mjs` |
| Validation against AstDyS (incl. the g-vs-D trend test) | `scripts/compare-astdys.mjs` → `data/trojans/astdys-comparison*.json` | — |
| Long-run secular elements merged into the artifact by designation | `scripts/merge-long-proper.mjs` | — |
| The population list | `scripts/build-trojan-report.mjs` → `data/trojans/TROJANS_LIST.md` | — |
| Weekly refresh — fetch catalogue + AstDyS, gate, integrate 600 yr + 20 kyr, score both against AstDyS, rebuild, upload the full CSVs as an artifact, open/update ONE PR | `.github/workflows/trojans-refresh.yml` | — |
| CI gate (path-filtered) | `.github/workflows/trojan-kernels.yml` | — |
| Status-board registration | `js/pipeline-registry.js` id `trojans-catalog` | `node tests/pipeline-registry.mjs` |

Refresh: the weekly workflow does it (or run it by hand: Actions → trojans-refresh →
Run workflow; a preview URL is accepted). Locally:
`curl https://www.parkersphysics.com/api/trojans/catalog > cat.json`, then
`node scripts/analyze-trojans.mjs cat.json --require-live --out data/trojans` and
`node scripts/build-trojan-report.mjs data/trojans [--long <dir of a --years 3000 run>]`.
`data/trojans/trojans-analysis.csv` is written but NOT tracked (~3 MB per refresh).

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

8. **Supabase is not involved, on purpose.** Nothing in this pipeline reads or
   writes it: the catalogue is an edge-cached relay (24 h, one upstream run a
   day — measured `x-vercel-cache: HIT`), the results are a static file. The
   only thing worth a table later is a one-row-per-day count / L4:L5 series.
9. **The browser never integrates the population.** Measured costs: analytic
   pass over all 16 445 rows 152 ms, N-body epoch alignment 550 ms, the full
   600-yr run ~3 CPU-minutes (~1.5 at the 40-day step), one object ~50 ms. A
   page loads `trojans-dynamics.json` (~430 KB brotli with the six proper-element
   columns — 284 KB without — and ~95 ms parse + decode)
   and may integrate ONE object on demand in a worker.
10. **The wire is lean** (`trojan-v2`): 2.47 → 1.85 MB raw, 785 → 655 KB brotli
    on the real catalogue; dropped columns were constant or meaningless here
    (`cls`, `flags`, `q`, `tp`, Earth `moid`). Readers resolve columns by name.
11. **The step is 40 days because it was measured** (see §3b). Epoch
    alignment keeps 20 d (`ALIGN_DT_DAYS`).
12. **The refresh opens a PR, it never pushes to main** — a push to main is a
    production deploy. Needs the repo setting "Allow GitHub Actions to create
    and approve pull requests"; a PR opened with `GITHUB_TOKEN` does not trigger
    other workflows' CI.
13. **ONE orbit-quality rule** (`orbitQuality`): U ≥ 6, OR arc < 1 yr, OR off
    the shared epoch ⇒ short-arc. The script and report builder used to carry
    hand-synced copies.
14. **One same-step retry on a TRANSIENT SBDB failure** (timeout / network
    error / 502 / 503 / 504), never a loop; a 4xx steps down the ladder and a
    plain 500 is reported. Measured 2026-11-03 19:48–19:55: a hung connection
    (the request waited its whole 30 s budget; healthy answers take ~2 s) and
    then HTTP 502 — the production NEO catalogue failed identically, so it was
    JPL. The first attempt is 20 s to leave room for the retry.
15. **Proper elements are frequency-analysed (NAFF), not min/max.** The
    half-range of φ grows with run length (+0.26° median 600 → 3 000 yr); the
    amplitude of the fundamental libration line does not. Definitions follow
    Milani (1993) / AstDyS so the two compare: z = (φ − φ̄) + i(a/a_J − 1)/√(3μ)
    (a circle of radius D at small amplitude), f = its strongest line inside
    the libration band, D_p and da_p from the real φ and a signals at f.
16. **D_p is the CLUSTER amplitude, √ΣA².** The secular cycle frequency-
    modulates the libration; once a record resolves f ± g the single line's
    amplitude falls to D·J₀(β) (659 Nestor 9.95° → 9.31° at 20 kyr, AstDyS
    9.87°). For FM, ΣJₙ² = 1, so the quadrature sum over the cluster is the
    unmodulated amplitude whether or not the sidebands are resolved.
17. **Three guards, each a measured failure:** the libration line must sit in
    the libration band (0.4–1.3 × the small-amplitude 2.43°/yr — Jupiter's
    11.86-yr line was reported as f = 30.2°/yr for D ≈ 0.05° objects); secular
    lines must sit below f/3 (the first version returned that same orbital
    line, ~109 000″/yr, as a "free" e); and e_p / sin I_p are WITHHELD below
    18 kyr / 250 kyr — spans DERIVED from AstDyS's own g (p5 146″/yr) and s
    (median 11.8″/yr) — because below them the free line merges with the
    forced ones and a weak residual passes every other test (3 000 yr gave
    e_p 0.008 at 897″/yr for 588 Achilles; AstDyS 0.104 at 344″/yr).
18. **AstDyS's own failures are excluded and counted**, never compared: f below
    1.5°/yr (values of 0.006–0.26 where the physics says ~2.45; AstDyS's p1 is
    1.92) and g locked onto Jupiter's g5 (< 20″/yr: the forced line taken as
    free).
19. **The weekly long run is 20 kyr**, because that is what resolves e_p and g;
    sin I_p needs ~250 kyr and stays a sample-scale validation run (§4).

## 3. What the first run found (catalogue of 2026-11-03)

600-yr run (`data/trojans/trojans-summary.json`; 21 s on 4 threads at the
40-day step, 52 s with the proper-element frequency analysis), the first
3 000-yr check run (121 s), and the 20-kyr long run that now replaces it
(`data/trojans/trojans-summary-long.json`, 993 s with frequency analysis):

| | 600 yr | 3 000 yr | 20 kyr |
|---|---|---|---|
| L4 tadpole | 10 347 | 10 326 | 10 286 |
| L5 tadpole | 5 955 | 5 952 | 5 947 |
| meets Jupiter (≤ 3 Hill radii) | 109 | 152 | 207 |
| horseshoe | 33 | 15 | 5 |
| circulating | 1 | 0 | 0 |

- **99.0 % of the 16 445 TJN objects librate** about L4 or L5 for 20 000 yr
  (99.1 % for 3 000 yr); among WELL-DETERMINED orbits only 22 meet Jupiter.
- **L4 : L5 = 1.74 overall — 1.60 (1.57–1.63) among well-determined orbits
  (8 805 : 5 507) but 3.44 (3.26–3.63) among short-arc ones (1 542 : 448).**
  A large part of the catalogue's L4 excess is recent discovery history,
  not dynamics.
- Median libration amplitude 14.8°, median period 152 yr (theory: 148 yr at
  zero amplitude, lengthening with amplitude — the run shows it).
- **The impostors.** Among WELL-DETERMINED orbits (U ≤ 5, arc ≥ 1 yr, on the
  shared epoch) 19 meet Jupiter within 600 yr (22 within 3 000) and one
  horseshoes; most sit far from ±60° (118624 at φ = −125°, 2000 CN152 at
  −160°, 690577 at −152°) — filed as Trojans by their semimajor axis, not
  Trojans by motion. The one well-determined horseshoe, 2016 TE71 (U0, 17-yr
  arc), meets Jupiter in the 3 000-yr run: a transient co-orbital. The other
  non-librators are short-arc orbits (mostly U9, 2–5-day arcs from 2014–2019
  surveys) whose a is too uncertain for a verdict.
- 48 objects change regime between 600 and 3 000 yr ("slow escapers"), all but
  a handful short-arc. (Numbers here are the 40-day-step run; the 20-day run
  differed only in 5 chaotic U9 objects — §3b.)
- The full tables are in `data/trojans/TROJANS_LIST.md`; every object is a row of
  `data/trojans/trojans-dynamics.json` (and of the untracked
  `trojans-analysis.csv` / the refresh workflow's artifact).

## 3b. How good is the integration? (measured 2026-11-03)

Seeded random sample of 800 WELL-DETERMINED Trojans, 600 yr, unless stated:

| Question | Measurement | Verdict |
|---|---|---|
| Is the step converged? | vs a 5-day reference: \|Δ amplitude\| median 0.001°, max 0.007° (10 d) / 0.010° (20 d) / 0.011° (40 d); 0 regime flips at every step | Over-converged at 20 d; **40 d is free speed** (whole population: 5 flips, all chaotic U9 arcs; tadpole p99 0.010°) |
| What does Saturn do? | with − without: \|Δ amplitude\| median 0.11°, p95 0.32°, max 0.60°; period median shift 0.00 yr; 0 regime flips | Small over centuries; matters for SECULAR (Myr) behaviour, not for today's verdict |
| Does run length matter? | 3 000-yr − 600-yr amplitude, 14 767 tadpoles: median +0.26°, p90 +0.57°, p99 +0.93° (+1.8 % median, +7.5 % p90); amplitudes < 3° grow most (+0.40°) | **A min/max amplitude is run-length dependent** — the case for proper (frequency-analysed) amplitudes |
| How good is the analytic estimate? | analytic − integrated: median 0.06–0.40°, \|p95\| 1.9° (i < 10°) → 2.7° (i 20–40°); 2.2° (e < 0.05) → 2.7° (e > 0.1) | Unbiased, ~2–3° scatter growing with e and i — good for a first paint, not a verdict |
| Libration period at small amplitude | amplitude < 5° (n = 59): median 149.2 yr vs planar-circular theory 147.8 yr | +1 %, the expected direction for inclined, eccentric orbits |
| Period precision | ~0.1–0.4 yr floor from the annual sampling cadence, independent of step | Sample faster if periods ever need to be quoted to < 0.5 yr |

## 3c. Proper elements vs AstDyS (measured 2026-11-03)

AstDyS synthetic proper elements, Knežević, June 2024 (`tro.syn`, 11 867
Trojans, 5- or 50-Myr integrations with the four outer planets) against ours
(Sun + Jupiter + Saturn), 8 936 matched librators; AstDyS's own failed fits
excluded and counted (61 with f < 1.5°/yr, 133 with g locked to g5). Full
tables: `data/trojans/astdys-comparison*.json` and `TROJANS_LIST.md` §13.

| Element (run) | Median ours − AstDyS | Median abs Δ | 90th pct | 99th pct | r |
|---|---|---|---|---|---|
| **D_p** (600 yr) | +0.07° | **0.11°** | 0.53° | 1.96° | 0.998 |
| D_p, AstDyS 5-Myr rows only | | **0.09°** | 0.23° | 0.43° | 0.9997 |
| D_p, AstDyS 50-Myr rows only | | 0.35° | 1.15° | 3.0° | 0.995 |
| *old half-range* (600 yr) | +0.29° | 0.30° | 0.85° | 2.05° | 0.998 |
| *old half-range* (20 kyr) | +0.72° | 0.72° | 1.31° | 2.43° | 0.997 |
| da_p (600 yr) | +0.0004 AU | 0.0006 AU | 0.0023 | 0.0079 | 0.998 |
| f (20 kyr) | +0.004°/yr | 0.0044°/yr | 0.0069 | 0.062 | 0.87 |
| **e_p** (20 kyr) | −0.0004 | **0.0004** | 0.0070 | 0.0134 | 0.995 |
| e_p, AstDyS 5-Myr rows only | | **0.0003** | 0.0008 | 0.0020 | 0.9997 |
| g (20 kyr), AstDyS 5-Myr rows | | **0.29″/yr** | 0.70″/yr | 86″/yr | |

- **The run-length drift is gone.** D_p moves 0.01° between the 600-yr and
  20-kyr runs against AstDyS; the half-range's bias grows from +0.29° to +0.72°.
- **sin I_p and s** match too where the record can resolve them (a 300-kyr
  sample run: 588 Achilles 0.1970/0.197, −10.85/−11.03″/yr; 624 Hektor
  0.3256/0.3258, −12.97/−12.80; 884 Priamus, 659 Nestor likewise) and are
  correctly WITHHELD for 617 and 911, whose |s| sits within two bins of zero —
  even with Jupiter and Saturn only.
- **Where we disagree.** D_p: almost all of the large misses are AstDyS 50-Myr
  rows (the harder, likelier-chaotic orbits) or recent discoveries whose SBDB
  orbit has moved since June 2024; in every case our D_p agrees with our own
  half-range, so the measurement is self-consistent. g: 1 503 objects disagree
  by > 20″/yr (1 382 of them 50-Myr rows). **The g-vs-D trend test** decides
  the large-amplitude ones: on agreed objects g rises smoothly with D_p
  (342 → 428″/yr); above D_p ≈ 15° our disputed g continues that trend
  (360–433″/yr) while AstDyS's sits far below it (154–259″/yr, its worst near
  Saturn's g6 with an identical e ≈ 0.030 across unrelated objects — a forced
  line taken as free). Below 15° neither side follows the trend: unresolved.
  This is inference from a trend, not proof (§4 item 1b).

## 4. Next steps — the big list

Ranked by what each buys per unit of effort; every item names the
measurement that motivates it.

**A. Make the numbers better (physics)**
1. ~~**Proper libration amplitude and frequencies**~~ — **DONE 2026-11-03**
   (§2 decisions 15–19, §3c). D_p / da_p / f from every run, e_p / g from
   the weekly 20-kyr run, sin I_p / s withheld until a ≥ 250-kyr run exists;
   all validated against AstDyS. Original item, for the record: frequency-analyse φ(t),
   e·e^{iϖ} and sin I·e^{iΩ} (Laskar's NAFF / FMFT) instead of min/max. Fixes
   the measured run-length drift (+0.26° median 600→3 000 yr), gives the
   libration frequency f, the secular frequencies g and s, and the proper
   (D, e_p, sin I_p) that AstDyS publishes — which becomes our validation set.
   Needs the φ series the integrator already keeps (`keepSeries`) at a finer,
   uniform cadence. *Effort: medium. Highest value.*
1b. **Settle the g disputes** — a ≥ 250-kyr run WITH Uranus and Neptune on a
   stratified sample of the 1 503 disputed objects (both sides of D_p = 15°),
   compared against AstDyS and our 20-kyr values. Decides the trend-test
   verdicts and whether the < 15° group are secular-resonance neighbours.
   *Effort: small once item 4 exists (planetTrack already generalises).*
1c. **sin I_p for the whole population** — needs ≥ 250 kyr per object
   (~2.5 s each in JS: ~3 CPU-hours for 16 k). Either the WASM integrator of
   item 5, or a monthly (not weekly) job. The kernel already withholds it
   honestly until then.
2. **Chaos indicator per object (MEGNO or a 1e-9 shadow clone)** — the 5 objects
   that flipped regime when only the step changed are, by that fact, chaotic;
   a Lyapunov time separates "unstable" from "unknowable" for every row and
   becomes a column of the artifact. *Effort: small–medium.*
3. **Clone ensembles for short-arc orbits** — 1 990 short-arc objects librate
   and ~120 do not; sample each orbit's covariance (SBDB `sigma_*` fields as a
   further optional ladder rung) and publish P(librating) instead of a verdict.
   *Effort: medium.*
4. **Add Uranus and Neptune** (`planetTrack` already generalises over
   planets) — Saturn moved amplitudes only 0.11° over 600 yr, so this is for
   the secular frequencies of item 1, not today's verdict. *Effort: small.*
5. **Long runs with a symplectic Wisdom–Holman integrator in Rust/WASM** (the
   repo already ships Rust kernels): 10⁵–10⁶ yr for diffusion maps and the real
   stability boundary. *Effort: large.*
6. **A better instant estimate** — fit amplitude and period corrections in
   (e, i) against the integrated population (the analytic error grows from
   1.9° to 2.7° p95 with inclination; the small-amplitude period runs +1 %
   long), or adopt Érdi's 3D co-orbital theory; gate it on held-out objects.
   *Effort: small.*
7. **Collisional families** — now UNBLOCKED in (D_p, e_p) for all 16 k
   objects; add sin I_p when item 1c lands. (HCM on the proper elements;
   Eurybates — a Lucy target — is the archetype). *Effort: medium, after 1.*
8. **Debiased L4:L5 asymmetry** — the measured split (1.60 well-determined vs
   3.44 short-arc) says the raw count is survey history; cut at the magnitude
   where both camps are complete and compare. *Effort: small.*
9. **Yarkovsky drift for the smallest Trojans** — negligible for today's
   verdicts; relevant to escape over Gyr. Note it, do not build yet.

**B. Make it cheaper or more robust (pipeline)**
10. **Weekly delta in the refresh PR** — diff the new artifact against the
    committed one: new discoveries, regime changes, the L4:L5 ratio. Turns the
    PR into the discovery-rate time series (Rubin/LSST is in operations).
    *Effort: small.*
10b. **Keep the last good catalogue through a JPL outage.** Observed
    2026-11-03: during SBDB's outage the degraded body (cached 300 s +
    stale-while-revalidate 600 s) would REPLACE a good cached catalogue when a
    revalidation fails, so a page reading the live route sees an empty swarm
    for up to ~15 min. The committed dynamics artifact is unaffected. Fix:
    have the route fall back to a last-good copy (e.g. Vercel Blob, written on
    every live answer) served as `freshness:'stale'` with its age, or have
    pages fall back to the artifact + its own epoch. *Effort: small–medium.*
11. **A daily count row in Supabase** (date, rows, L4, L5, epoch) only if the
    time series is wanted on a page — ~365 rows a year. *Effort: small.*
12. **Sample φ every 30 days, not 365**, if periods must be quoted below the
    measured ~0.1–0.4 yr floor (cost: a little more elements work per step).
13. **SBDB `sigma_*` / `rot_per` / colour columns** as further optional ladder
    rungs (each self-reported; the ladder already absorbs a refusal).

**C. Put it on screen (product)**
14. **Orrery layer** on solar-system.html: the swarms as an instanced point
    cloud (the NEO layer's Lommel–Seeliger impostor and pixel picking), coloured
    by camp, sized by the artifact's diameter, with a "co-rotating with
    Jupiter" toggle that turns each object's φ range into the textbook
    tadpole/horseshoe arc. Data: catalogue (positions) + artifact (dynamics).
15. **Libration replay card** — integrate ONE object in a worker (~50 ms) with
    `keepSeries` and draw φ(t), a(t) as the tadpole in the rotating frame.
16. **Lucy mission tracker** — Horizons serves the spacecraft (body −49);
    compute its closest approaches to the five targets from the SAME ephemeris
    rather than typing the published schedule.
17. **Tonight's sky** — where the L4 and L5 clouds are, through SkyView's engine.
18. **A Trojans section** on the Local/Deep Space hub page (the nav menus are at
    their 10-link cap; overflow belongs on the hub — `js/site-sections.js`).
19. **Generalise to other planets' Trojans** (Neptune — no SBDB class, a
    dynamical cut of our own; Mars; Earth's 2010 TK7 and 2020 XL5) with the
    planet as a kernel parameter.

**D. Carried over from the first version of this list**
20. **Escape routes for the impostors** — integrate the objects that meet
    Jupiter past the encounter (a close-encounter-capable integrator) and
    record where they go: Jupiter-family comets, Centaurs, Hildas.
21. **A curated, cited table of binaries** (Patroclus–Menoetius,
    Hektor–Skamandrios, Eurybates–Queta, Polymele–Shaun) for the cards.
22. **Status board:** once production serves the route, confirm the
    `trojans-catalog` row reads green; then the 4xx ladder can be trimmed if
    desired (every rung was accepted on 2026-11-03).

## 5. Found in passing

`api/cron/archive-forecasts.js`, `farside-ingest.js`, `validation-rerun.js` and
`refresh-weather-grid.js` declare `runtime: 'nodejs'` and RETURN a Response
from their default export, which this route measured as ignored by Vercel's
Node runtime (request hangs to the timeout). Their side effects may still
complete; verify in the production logs and apply the dual-mode entry from
`api/trojans/catalog.js` if confirmed.
