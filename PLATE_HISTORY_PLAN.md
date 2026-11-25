# Plates Through Time — plan & status (`plate-tectonics.html`)

**Status (2026-11-23): Phase 1 (the reconstruction, 1.8 Ga → today) BUILT. Phase 2 (the deep past to
4.5 Ga) SCOPED below, not built.**

## 0. Owner decisions (2026-11-23)

1. **A new page**, `plate-tectonics.html` ("Plates Through Time"), Earth & Orbit → Earth systems. It
   links to Inner Earth for today's plates/slabs in 3-D; it does not share that stage.
2. **Reconstruction first** (this phase), then the deep past.
3. **Before 1.8 Ga: physics + evidence, no invented maps.** A mantle thermal-history model to 4.5 Ga
   and an evidence timeline (Phase 2). Schematic early-Earth globes were offered and declined: they
   would look like data.

## 1. What the model is — and is not

Cao et al.'s 1.8 Ga full-plate model (EarthByte `Data_Collections/Cao_etal_2023`), which extends
Merdith et al. (2021, *ESR* 214, 103477, 1 Ga → now) and carries its 2023 corrections. CC BY 4.0.
A KINEMATIC reconstruction: finite rotations in a palaeomagnetic absolute frame + time-dependent plate
topologies. Before ~200 Ma no ocean floor survives, so oceanic plates are inferred from the continents;
palaeomagnetism constrains latitude, not longitude. Not a mantle simulation; no forces.

Reachability (measured 2026-11-23): EarthByte's WebDAV (`www.earthbyte.org/webdav/ftp/…`) answers from
the build sandbox — INNER_EARTH_PLAN.md §2 recorded EarthByte blocked on 2026-11-18; it is not any more.
`repo.gplates.org` and Zenodo stay blocked. pygplates 1.0.0 installs from PyPI.

## 2. Architecture

```
EarthByte zip (sha256-pinned)
  └─ scripts/build-plate-history.py  (pygplates; --check)        → data/plate-history/{rotations,continents,frames}.json.gz + meta.json
       └─ js/plate-history/rotations.js   PURE: the PLATES4 rotation hierarchy (our own; gated vs pygplates)
       └─ js/plate-history/frames.js      PURE: decode; continents at ANY t; boundaries carried between frames
       └─ js/plate-history/diagnostics.js PURE: ridge/trench length, crust made/destroyed, RMS speed, supercontinent index
            └─ scripts/build-plate-history-series.mjs (--check)  → data/plate-history/series.json
  page: js/plate-history/{page,globe,map,charts,geotime}.js  (renderers draw kernel numbers only)
```

## 3. Load-bearing rules (each was a measured bug)

1. **`999` lines are comments INSIDE a sequence** — pygplates interpolates across them. Ending the
   sequence there broke Laurentia's circuit 1480–1600 Ma (176° off). Gate + control.
2. **A broken circuit holds the plate at IDENTITY**, not "relative to the anchor" (75° off). Gate + control.
3. **Slerp, not linear interpolation** of quaternions (3.5° off). Control.
4. **Velocities never difference across a ROTATION SEAM** (a plate's total rotation jumps when it changes
   sequence; the two rotation files meet at 1000 Ma): measured 13 600 mm/yr at 1000 Ma and 12 240 RMS at
   1800 Ma with the naive stage. `velocityInterval` uses GPlates' `[t, t+1]` EXACTLY when no seam touches
   it (so the oracle stays exact), else the clean side. The model's oldest edge (`validToMa`, 1800) is a
   seam: past it every plate is at identity and read as STOPPED.
5. **Ridge length needs the obliquity split.** A `MidOceanRidge` feature includes its transform offsets;
   a piece counts as spreading only within 70° of the relative motion (gplately's own default, stated not
   fitted). Without it ridge length reads 1.20× Merdith's.
6. **Production is length × the OPENING rate** (normal component). Reads 0.84× Merdith's (their method or
   model version differs; full rate reads 0.93× and correlates no better) — kept as the physically right one.
7. **The model's own defects are SHOWN**: the 855 Ma topology gap (47 % in no plate) is hatched and
   labelled, never filled or re-timed.
8. **Colours**: raw shaders get sRGB components directly (THREE.Color would linearise them — too dark).
9. **Land = filled coast polygons over filled continental crust**, never outlines (the coast file splits
   land along every terrane boundary; outlines drew all of them). "Today's land, carried back" — disclosed.

## 4. Measured (gates: `tests/plate-history-{rotations,diagnostics,geotime}.mjs`, `tests/plate-tectonics.spec.js`)

| Check | Result | Control |
|---|---|---|
| Total rotations, 816 (plate, t) vs pygplates | worst 4.4e-10° | nlerp 3.5°, broken→anchor 75°, cut sequence 177° |
| Velocities, 300 points | worst 3e-4 mm/yr | — |
| Whole continent features end to end (161 + 119 absent) | first vertex ≤ 5.8e-3° (0.01° quantum) | unreconstructed 164° |
| Ridge length vs Merdith SM3b (201 frames) | median ratio 0.995, r 0.958 | with transforms 1.198 |
| Trench length vs SM3a | 1.008, r 0.855 | — |
| Crust consumption vs SM3a | 1.004, r 0.969 | shifted 100 Myr: r 0.55 |
| Crust production vs SM3b | 0.837, r 0.767 | — |
| 0 Ma vs Bird PB2002 (independent) | ridges 13.8 km, trenches 25.6 km median | turned 10°: ~570 km |
| Supercontinent index peaks | Pangaea 255 Ma, Rodinia 760 Ma, Nuna 1420 Ma (+ Gondwana 510 Ma) | unreconstructed: 0.29 vs 0.52 |
| Browser: rotation texture ≡ kernel; India drawn on land at 100 Ma | 1e-6; 100 % on land | today's position: ≤ 20 % |

## 5. Phase 2 — the deep past (scoped, not built)

Goal: carry the page from 1.8 Ga back to 4.5 Ga honestly. No maps.

1. **Mantle thermal history** (`js/plate-history/thermal-history.js`, PURE): one-box energy balance
   C dT/dt = H(t) − Q(T); radiogenic H(t) from U-238/U-235/Th-232/K-40 with their exact decay constants
   and present abundances; Q ∝ T^(1+β) Ra^β plate-tectonic scaling. GATES: (a) integrated BACKWARD from
   today with classical β ≈ 1/3 and Urey ratio ~0.3 it hits the THERMAL CATASTROPHE (runaway T) before
   ~2 Ga — the famous result, reproduced and shown; (b) β → 0 (Korenaga's sluggish/strong-plate regime)
   gives a smooth history whose peak sits near the petrological Tp estimates (Herzberg et al. 2010:
   ~1500–1600 °C at ~2.5–3 Ga) — compared, never fitted. Disclose Urey ratio and β as the model's knobs.
2. **Evidence timeline**: oldest zircons (Jack Hills ~4.4 Ga), oldest rocks (Acasta ~4.0 Ga), Isua,
   earliest paired metamorphism / eclogites / ophiolites, cited with `verified: false` until checked.
   The continents file's own begin times (crust to 3.8 Ga) can feed a "crust that exists" curve.
3. **Regime**: mobile vs stagnant lid as a function of Tp (a stated, cited criterion), drawn as a band
   on the time axis, not as a globe.
4. The scrubber extends to 4.5 Ga with the reconstruction ending at 1.8 Ga, visibly.

## 6. Limitations / next

- Never seen on a real GPU (SwiftShader only). Check at 1440 and 390 in Chrome/Safari/Firefox.
- Boundaries between 5 Myr frames are carried by their feature plate's rotation; a ridge that should
  lengthen between frames does not until the next frame.
- Merdith's SM3 is their v1.0; a re-run of their statistics on Cao's model would be a closer oracle.
- `geotime.js` boundaries are from memory (VERIFIED false) — check against stratigraphy.org.
- Literature supercontinent windows are from memory, wide, unverified.
- Velocities on the globe are an Eulerian lattice (fixed points), not tracers.
