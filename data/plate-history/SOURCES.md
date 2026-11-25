# data/plate-history — baked inputs for plate-tectonics.html

Every file here is BUILT from a sha256-pinned upstream; never hand-edit one. `--check` rebuilds and
compares (CI: `.github/workflows/plate-history-kernels.yml`).

| File | Built by | Upstream | Licence / credit |
|------|----------|----------|------------------|
| `rotations.json.gz` | `scripts/build-plate-history.py` | Cao et al. 1.8 Ga model — `1.8Ga_model_submit.zip` from EarthByte `Data_Collections/Cao_etal_2023/` (sha256 `e9f5861c…dc5a9`): the two `.rot` files, parsed as written (999 comment lines skipped WITHOUT ending their sequence) | CC BY 4.0 (EarthByte `Data_Collections/License.txt`, read 2026-11-23) — cite Cao et al. and Merdith et al. (2021) |
| `continents.json.gz` | same | `shapes_continents_Cao.gpmlz` (continental crust incl. shelves) + `shapes_coasts_Cao.gpmlz` (present-day coastlines), exterior rings, 3-D Douglas–Peucker at 0.05° | same |
| `frames.json.gz` | same (pygplates 1.0.0 `resolve_topologies` every 5 Myr, 0–1800 Ma) | the model's eight topology files | same |
| `meta.json` | same | provenance, per-input sha256, per-frame topology checks (Σ area ÷ 4π, unassigned raster cells), output hashes | — |
| `series.json` | `scripts/build-plate-history-series.mjs` — OUR kernel (`js/plate-history/*`) over the frames | derived; nothing in it is copied from the model's tables | — |
| `published/SM3a_SUB_stats.csv`, `published/SM3b_MOR_stats.csv` | copied verbatim | Merdith et al. (2021) supplementary SM3a/SM3b from EarthByte `Data_Collections/Merdith_etal_2021_ESR/` (sha256 `2a6b35bd…dc62`, `3c211de6…6eac`) — THEIR v1.0 (Sept 2020) trench/ridge length and crust consumption/production per Myr | CC BY 4.0 — the ORACLE the diagnostics gate and the page's dashed lines compare against |

Oracle (tests only): `tests/fixtures/plate-history/pygplates-oracle.json`, written by
`scripts/plate_history_oracle.py` from the same zip with pygplates 1.0.0.

Known properties of the model, reported and never repaired:
- 853–855.1 Ma: the topology does not close (Σ area 1.037); the 855 Ma frame leaves 47 % of the globe in no plate.
- 100, 135, 475, 535–540, 685–690 Ma: overlapping polygons (Σ area 1.01–1.10).
- Rotation seams (a plate's total rotation jumps) at e.g. 410, 560, 720, 1000 (the two rotation files meet), 1080, 1200 Ma.
