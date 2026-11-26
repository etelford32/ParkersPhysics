# Deep-time Earth — a separate simulation of the planet's geography through time

*Proposed 2026-11-23, after the Chicxulub reconstruction needed 66 Ma
geography. **Steps 1–3 BUILT 2026-11-25**: the pyGPlates oracle, static
polygons in the browser, and the page (`deep-time-earth.html`). See §5.*

## 1. What exists already (built for Chicxulub, made to be shared)

| Piece | File | State |
|---|---|---|
| Plate-rotation kernel (PURE) | `js/paleo/rotations.js` | built, gated (`tests/paleo-rotations.mjs`, 23 checks) |
| Rotation model, 250 Ma → now | `data/paleo/muller2019-rotations.json` | baked, sha-pinned (Müller et al. 2019, CC BY-SA 4.0) |
| Today's coastlines with plate ids | `data/paleo/muller2019-coastlines.json` | baked (0.15°, 345 KB, 108 KB gzipped); not drawn anywhere yet |
| Site → plate lookup | `data/paleo/muller2019-sites.json` | baked for 5 sites only |

The kernel reproduces every row of the model exactly. Its conventions are
checked against an independent dataset: the last 5 Myr of motion agree with
Bird's PB2002 to 15 % in speed and 6° in direction. GPlates itself (pygplates,
the GPlates web service) was not reachable from the build machine, so no check
against GPlates' own reconstruction has been run yet. That is the first thing
to do on a networked machine.

## 2. What the page would be

A globe and a slider from 250 Ma to today: the continents' outlines moving on
their plates, the plate a clicked point is on, its path back through time and
its speed. Events on the same clock: Chicxulub at 66 Ma, the Deccan Traps, the
opening of the Atlantic, the Pangaea breakup, and later Tethys closing.
Consumers on other pages: Chicxulub (the 66 Ma geography), Inner Earth (plates
moving back from Bird's present-day ones), Volcanoes (large igneous provinces).

## 3. The honesty rules it must keep (the same as the rest of the site)

1. **Today's coastlines are not palaeo-shorelines.** Carried back they show
   where today's land WAS, not where the sea was. A real palaeo-shoreline
   needs a palaeogeography dataset (Cao et al. 2017, Scotese PALEOMAP —
   licences unchecked). Until one is baked the page draws "today's coasts,
   moved" and says so, never a sea.
2. **The frame is named.** Müller 2019's is the optimised mantle frame. A
   palaeomagnetic (spin-axis) frame differs by true polar wander. Latitudes
   for climate or for an impactor's sky need the second, so either bake a
   palaeomagnetic reference frame (e.g. Torsvik 2012 / Vaes 2023 APWPs) or
   print the frame beside every latitude.
3. **Uncertainty is not zero.** One model is one answer. Two models
   (Müller 2019 vs Merdith 2021, or a palaeomagnetic frame) side by side are
   the honest spread; the difference is the number to show.
4. **Deformation is not rigid.** The model has deforming meshes for rifts and
   orogens, and the rigid kernel ignores them. Regions inside a mesh must be
   flagged as approximate, never drawn as precise.
5. **Refuse past the model.** No extrapolation before 250 Ma, and no plate the
   file lacks.

## 4. Steps

1. **Oracle check** on a networked machine: pygplates (`pip install
   pygplates`) reconstructs a few hundred points at a dozen ages. Bake that as
   `tests/fixtures/paleo/pygplates-oracle.json` and gate the JS kernel to
   < 0.01° against it. Until this lands, the kernel is checked by identities
   and PB2002 only.
2. **Static polygons in the browser**: bake simplified polygons so any
   clicked point gets a plate id (today only five sites have one), with
   point-in-polygon on the sphere (not lon/lat) and the overlap rule as
   measured.
3. **The page**: globe + age slider, moving coastlines, plate colours, a
   clicked point's track, the event marks. Built on the site's stage
   conventions (the page may START a flight, never hold the camera; render on
   demand; three.js imported dynamically).
4. **Second model** for the spread (Merdith et al. 2021, 1 Ga → now, also
   EarthByte, licence to check).
5. **Palaeogeography layer** (land / shallow sea / deep sea) once a dataset
   with a usable licence is baked. Then Chicxulub's tsunami ring can stop at a
   real 66 Ma coast.
6. **Palaeomagnetic frame**, so latitudes are spin-axis latitudes.

## 5. Owner decisions

- Name and place in the nav (Local Space? Earth & Orbit? the menus are at
  their cap, so the hub page is the honest home).
- Is CC BY-SA data acceptable on the page? It needs attribution and
  share-alike for the derived data files (not for our code).
- Which palaeogeography dataset, once its licence is read.

## 5. Built 2026-11-25

- **Oracle** (`scripts/paleo_oracle.py`, pyGPlates 1.0.0 in a venv →
  `tests/fixtures/paleo/pygplates-oracle.json`, gated in
  `tests/paleo-rotations.mjs` §6): 12 817 plate/age rotations agree to
  1.8e-4°, refusals identical, 3 995/4 000 plate lookups agree, Chicxulub
  sites to 4.6e-5°. It found one kernel bug (a dead-end crossover chain;
  fixed by falling through to the next sequence).
- **Polygons** (`data/paleo/muller2019-plates.json`, 267 KB gzipped;
  `js/paleo/plates.js` PURE): static plate polygons with appearance ages and
  continental-crust outlines; `plateAt` is pyGPlates' highest-id-first rule.
  Millidegree precision is load-bearing — at centidegrees Beloc (a few km
  inside its terrane) fell out of it.
- **The page** (`deep-time-earth.html` → `js/deep-time-earth.js`, the PURE
  `js/deep-time/page-model.js`, the renderer `js/deep-time/globe.js`): one
  mesh per plate, set to the kernel's rotation each age; crust younger than
  the displayed age discarded; seafloor coloured by its isochron-bin age;
  today's coastlines; a mantle-frame graticule; click → plate, today, then,
  path and a latitude chart; Chicxulub, cities and "You" carried back;
  `?age=&at=` deep links (the Chicxulub page links in). Gates:
  `tests/deep-time-earth.mjs` (20) + `tests/deep-time-earth.spec.js` (5,
  including a pixel check that the central Atlantic is blue today and not at
  200 Ma, and that the drawn surface shrinks 1.00 → 0.63 → 0.37 of the
  sphere at 0 / 66 / 200 Ma as later crust drops out).

Still open, in order: deforming-mesh flags (rule 4), palaeo-shorelines
(rule 1), events on the clock beyond Chicxulub, and a palaeomagnetic frame
INDEPENDENT of the EarthByte lineage (rule 3, below).

## 6. Built 2026-11-25 (later): the second model, in a palaeomagnetic frame

- **Merdith et al. 2021** (ESR 214; SM2 v1.2.4; CC BY 4.0 by EarthByte's
  Data_Collections licence) baked by `scripts/build-paleo-merdith.py` into
  `data/paleo/merdith2021-*`. It covers rules 2 and 3 at once: it is a second
  model AND it is in a spin-axis (palaeomagnetic) frame. It is NOT independent
  (its last 250 Myr is Young et al. 2019, the same lineage), so the page calls
  the difference the least the uncertainty can be.
- **Oracle for both models**: `scripts/paleo_oracle.py --model merdith2021` runs
  pyGPlates on the archive's full 1000 Ma file and GPML polygons. It found
  three things, each now a rule with its own gate: (1) GPlates IGNORES one-row
  sequences (Merdith's interleaved rows made 61); (2) a sequence trimmed at
  250 Ma must keep the row strictly PAST 250, or it becomes one row and the
  plate is refused there; (3) polygon edges are GREAT CIRCLES — the bake
  simplifies on the sphere, the decoder densifies edges onto their arcs, and a
  ring through a pole as one vertex is expanded along the pole line. At
  crossover instants pyGPlates' tie rule is not reproduced (four rules were
  tried); the gate proves its answer is always one the file allows and bounds
  the difference (Müller 20 m, Merdith 620 m).
- **The page**: "Compare a second model" (default on, fetched after the first
  frame, `?second=0` opts out; a failure leaves the first model working and
  says so). The globe draws Merdith's coastlines in pink, TURNED ABOUT THE SPIN
  AXIS onto Müller's longitudes (`longitudeShift`, a circular mean over a
  continental sample, tabulated every 2 Ma) because palaeomagnetism fixes no
  longitude; the panel prints the second latitude, the latitude difference and
  both distances (aligned / as each frame writes longitude); the chart draws
  both tracks on one axis; a line under the globe gives the continents' median
  and 90th-percentile latitude difference at the slider's age.
- **Measured**: 3.7° (5.7°) at 66 Ma, 12.8° (21.7°) at 200 Ma. Chicxulub at
  66 Ma: 21.9°N vs 25.0°N.
- **Still open for rule 3**: an independent palaeomagnetic frame — Vaes et al.
  2023's global APWP is on GitHub (bramvaes/GlobalAPWP) but outside this
  session's GitHub access; Torsvik 2012's GAPWAP is the other candidate.

## 7. Integrated with the rest of the site (2026-11-25, while merging Plates Through Time)

Main gained `plate-tectonics.html` (Plates Through Time, Cao et al. 2023 to 1.8 Ga) and the
Seton et al. 2020 ocean-floor age grid (Inner Earth). This page now reuses both instead of
keeping its own copies:

- **Seafloor colour and appearance come from the Seton 2020 grid** (`js/earth-interior/seafloor-age.js`,
  the ONE ramp `AGE_RAMP`): a vertex's colour is its grid age today minus the age shown, and
  surviving floor appears at the OLDER of the polygon's age and the grid's (`crustAppearAge`, only
  ever earlier, never on continents). That matters in the Cretaceous quiet zone (~121–83 Ma, no
  reversals): Müller's Atlantic polygons start floor of 100–120 Myr at 83 Ma, so at 100 Ma the
  central Atlantic was drawn as fragments. Floor the grid does not have (subducted since) keeps
  the model's isochron bins. A failed grid load puts the bins back and the legend says so
  (browser gate negative control). Land is now sage (#8d9c7e), not tan: the ramp's young end
  (#fff3b0) had the same hue as the tan, so ridges read as land (ΔE 24 → 39).
- **Periods are `js/plate-history/geotime.js`** clipped to 250 Ma — one time scale on the site
  (the two from-memory tables disagreed on the Cretaceous base: 145.0 vs 143.1).
- **The two rotation kernels agree**: `tests/paleo-rotations.mjs` §8 runs both on Cao 2023 —
  9 436 plate-age pairs to 1.5e-10°, the same chain at all 72 crossover pairs. Two rule
  differences are pinned as measured: Plates Through Time holds a broken circuit at identity
  where this kernel refuses (6 233 pairs), and it USES one-row sequences, which GPlates ignores
  (plates 4011 and 4301 at 0 Ma — a question for that page's kernel, not changed here).
- Cross-links both ways; Merdith 2021's title corrected to the archive ReadMe's ("A continuous,
  kinematic full-plate motion model from 1 Ga to present").
