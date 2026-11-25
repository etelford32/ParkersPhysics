# data/paleo — the plate model

**Müller, R. D., Zahirovic, S., Williams, S. E., et al. (2019).** A global plate
model including lithospheric deformation along major rifts and orogens since
the Triassic. *Tectonics* 38. doi:10.1029/2018TC005462. Plate model v2.0,
archive "Updated" (v2.02), downloaded 2026-11-23 from EarthByte's own server:

    https://www.earthbyte.org/webdav/ftp/Data_Collections/Muller_etal_2019_Tectonics/Muller_etal_2019_PlateMotionModel/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics_Updated.zip
    sha256 8976f140f3be194d2e3e1286eedcc7bed0a718663d8e2580af97674b77972483

**Licence: Creative Commons Attribution-ShareAlike 4.0** (stated in the
archive's `_README.txt`). The four files here are derived from it and are
therefore CC BY-SA 4.0 as well; credit Müller et al. (2019) / EarthByte
wherever they are shown. The code that reads them (`js/paleo/`) is ours and is
not a derivative of the data.

| File | From | What it is |
|---|---|---|
| `muller2019-rotations.json` | `Global_250-0Ma_Rotations_2019_v2.rot` | every rotation sequence, values as written (metadata rows dropped) |
| `muller2019-sites.json` | `StaticPolygons/…StaticPlatePolygons_2019_v1.shp` | the plate each named site sits on |
| `muller2019-coastlines.json` | `Coastlines/Global_coastlines_2019_v1_low_res.shp` | TODAY's coastlines with plate ids, simplified to 0.15° |
| `muller2019-plates.json` | `StaticPolygons/…` + `ContinentalPolygons/…` | every static plate polygon (plate id, appearance age) and continental-crust outline, simplified to 0.05°, delta-coded millidegrees — what deep-time-earth.html draws |

Rebuild: `python3 scripts/build-paleo-model.py` (fetches and checks the hash;
`--zip PATH` to use a local copy, `--check` to compare without writing). The
mesh rotation files (deforming regions) are not baked: the rigid plates are all
in the global file.

## What these numbers are, and are not

- **The frame is the model's optimised MANTLE frame**, not a palaeomagnetic
  one. A reconstructed latitude is not where the spin axis would put the site:
  true polar wander of a few degrees since 66 Ma is not in it.
- **The coastlines are today's**, carried back on their plates. They are not
  the shoreline of the age they are drawn at — sea level, shelves and
  orogens were different. A palaeo-shoreline needs a palaeogeography dataset,
  which this is not.
- **Plate assignments come from the present-day static polygons.** In the
  Caribbean they overlap (Beloc, Haiti, falls in both the 2048 terrane and the
  973 oceanic polygon); the smaller polygon is taken and both are recorded.
- **Measured inside the model** (tests/paleo-rotations.mjs): two crossovers at
  45 Ma (plates 663 and 727, Indian Ocean) are not synchronised and jump by
  21.6° and 3.7°. None of the chains Chicxulub uses has a jump.
- **Checked against an independent dataset**: over the last 5 Myr the model's
  Caribbean–North America, North America–Eurasia and South America–Africa
  motion agrees with Bird's PB2002 present-day poles to within 15 % in speed and
  6° in direction. That checks the kernel's conventions; it does not check the
  model's 66 Ma reconstruction, which only the model's own data supports.
- **Checked against the model's reference software** (2026-11-25; numbers
  updated the same day after the second model's check found two more rules):
  `scripts/paleo_oracle.py` runs pyGPlates 1.0.0 on the same archive and writes
  `tests/fixtures/paleo/pygplates-oracle.json`. Every plate's total rotation at
  16 ages (12 817 pairs) agrees to 1.8e-4° (≈ 20 m, worst at a crossover age),
  the 3 599 refusals are identical, 3 995 of 4 000 points get pyGPlates' plate
  from the simplified polygons (the 5 misses are within ~5 km of a boundary),
  and the Chicxulub sites at 66 Ma agree to 4.6e-5°. One fix came out of it: at
  a crossover whose first chain dead-ends (plate 555 → 355 at 230 Ma) the next
  sequence is used, as pyGPlates does. Overlapping static polygons resolve
  highest plate id first — pyGPlates' default order (at Beloc: 2048, as before).
  Away from crossover instants the rotations agree to 1e-9°; AT one (a hop
  where two sequences of a plate both cover the age) the file allows two
  answers and pyGPlates' tie rule is not reproduced (file order, "starts
  there", fixed-plate id and a breadth-first tree were each tried and each
  mismatched somewhere), so the gate proves pyGPlates' answer is one of the
  file's own chains and bounds the difference: 105 cases, ≤ 1.8e-4° (≈ 20 m).
- **Polygon geometry follows GPlates**: an edge is a GREAT-CIRCLE arc, so the
  bake simplifies ON THE SPHERE (lon/lat Douglas–Peucker collapsed runs along a
  parallel into chords that bent 0.13° at 65°S), `js/paleo/plates.js` densifies
  each edge onto its arc, and a ring passing through a pole as ONE vertex is
  expanded into a run along the pole line (Merdith's East Antarctica).

## The second model: Merdith et al. 2021

**Merdith, A. S., et al. (2021).** Extending full-plate tectonic models into deep
time: linking the Neoproterozoic and the Phanerozoic. *Earth-Science Reviews*
214, 103477. doi:10.1016/j.earscirev.2020.103477. Supplementary model SM2,
v1.2.4 (the December 2023 corrections), from EarthByte's own server:

    https://www.earthbyte.org/webdav/ftp/Data_Collections/Merdith_etal_2021_ESR/SM2-Merdith_et_al_1_Ga_reconstruction_v1.2.4.zip
    sha256 ea247ec5f8975fb7e6034c8ec48704b11805fc6f520ee7526c5757b830386982

**Licence: Creative Commons Attribution 4.0.** The archive carries no licence
of its own; the statement is `License.txt` at the root of EarthByte's
`Data_Collections` directory, which holds it
(https://www.earthbyte.org/webdav/ftp/Data_Collections/License.txt, sha256
93b0e3272777ad090ca5720c30619412559831dcd8fccbac496cf1bec625dc8f on
2026-11-25). Credit Merdith et al. (2021) / EarthByte wherever it is shown.

| File | From | What it is |
|---|---|---|
| `merdith2021-rotations.json` | `1000_0_rotfile_Merdith_et_al.rot` | rotation sequences, trimmed to 250 Ma (plus the one row past it a sequence needs) |
| `merdith2021-plates.json` | `shapes_static_polygons_Merdith_et_al.gpml` + `shapes_continents.gpml` | the muller2019-plates.json format |
| `merdith2021-coastlines.json` | `shapes_coastlines_Merdith_et_al_v2.gpmlz` | the model's own present-day coastlines |

Rebuild: `python3 scripts/build-paleo-merdith.py [--zip PATH] [--check]`
(stdlib; GPML positions are LAT LON; the baker refuses a ring crossing the
antimeridian — none do).

**What it is for, and its limits:**
- It is in a **palaeomagnetic** frame (Africa on a global apparent-polar-wander
  path after Tetley 2018; the archive's `APWP.txt`), where Müller 2019 is in a
  mantle frame. Comparing the two shows how much the frame (true polar wander)
  and the relative motions move a place.
- It is **not independent** of Müller 2019: for 250–0 Ma it compiles Young et al.
  (2019), of the same EarthByte lineage. Their difference is a LOWER bound on
  the uncertainty, never an error bar, and the page says so.
- Palaeomagnetism fixes **latitude, not longitude**. On the page the second
  model's coastlines are turned about the spin axis by the circular-mean
  longitude offset of the continents (`longitudeShift` in
  js/deep-time/page-model.js), which changes no latitude; the distances it
  reports say which convention they use.
- The rotation file parses into **one-row fragments** where rows are
  interleaved (plates 4011, 4301, 531 near 250 Ma); GPlates ignores a one-row
  sequence and so does the kernel (61 in the full file, 9 after the trim).
- Checked against **pyGPlates 1.0.0** on the archive's FULL 1000 Ma file and its
  GPML polygons (`tests/fixtures/paleo/pygplates-oracle-merdith2021.json`):
  14 190 rotations away from a crossover to 9.4e-10°; 221 at a crossover
  within 5.6e-3° (≈ 620 m), each pyGPlates answer one of the file's chains;
  3 941 identical refusals; 3 991 of 4 000 plate lookups.
- **Measured**: at 66 Ma the two models put today's continents a median 3.7° of
  latitude apart (90th percentile 5.7°); at 200 Ma 12.8° (21.7°). Chicxulub at
  66 Ma: 21.9°N (Müller, mantle) vs 25.0°N (Merdith, palaeomagnetic).
