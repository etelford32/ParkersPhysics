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
- **Checked against the model's reference software** (2026-11-25):
  `scripts/paleo_oracle.py` runs pyGPlates 1.0.0 on the same archive and writes
  `tests/fixtures/paleo/pygplates-oracle.json`. Every plate's total rotation at
  16 ages (12 817 pairs) agrees to 1.8e-4° (≈ 20 m, worst at a crossover age),
  the 3 599 refusals are identical, 3 995 of 4 000 points get pyGPlates' plate
  from the simplified polygons (the 5 misses are within ~5 km of a boundary),
  and the Chicxulub sites at 66 Ma agree to 4.6e-5°. One fix came out of it: at
  a crossover whose first chain dead-ends (plate 555 → 355 at 230 Ma) the next
  sequence is used, as pyGPlates does. Overlapping static polygons resolve
  highest plate id first — pyGPlates' default order (at Beloc: 2048, as before).
