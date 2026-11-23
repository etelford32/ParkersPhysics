# Deep-time Earth — a separate simulation of the planet's geography through time

*Proposed 2026-11-23, after the Chicxulub reconstruction needed 66 Ma
geography. Nothing here is built yet except the shared kernel and data.*

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
