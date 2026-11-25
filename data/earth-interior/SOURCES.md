# data/earth-interior — baked inputs for earth-interior.html

Every file here is BUILT by a script from sha256-pinned upstream copies; never hand-edit one.
`--check` rebuilds and compares (CI: `.github/workflows/earth-interior-kernels.yml`).

| File | Built by | Upstream | Licence / credit |
|------|----------|----------|------------------|
| `ground-1d/` | (raw copies) → `scripts/build-ground-models.mjs` → `js/earth-interior/ground-models.js` | greglucas/bezpy @ b7944f9 | USGS public domain; GSC OF 8115 OGL-Canada (confirm); bezpy MIT |
| `chaos-8.1.json.gz` | `scripts/build-chaos.mjs` | DTU CHAOS-8.1 via ESA-VirES/MagneticModel @ 6aa2d4f (`CHAOS-8.1_{core,core_extrapolated,static}.shc`) | DTU distributes CHAOS freely with citation — Finlay, Kloss, Olsen et al., CHAOS-8 (confirm the terms page in writing) |
| `plates-pb2002.json.gz` | `scripts/build-plates.mjs` | Bird (2003) G³ 4(3) 1027 supplement, unmodified in fraxen/tectonicplates @ 339b0c5 `original/` | Open Data Commons Attribution 1.0 — credit Peter Bird and Hugo Ahlenius (Nordpil); seafloor ages Müller et al. (1997) and depths ETOPO5 as tabulated by Bird |

| `slab2.json.gz` | `scripts/build-slab2.mjs` (pins in `scripts/slab2-pins.json`) | USGS Slab2 (Hayes et al. 2018, release 03/01/2018) — `Slab2_TXT/*_{dep,unc}_*.xyz` in ndb38/arc-metals @ 543bf32; canonical ScienceBase doi:10.5066/F7PV6JNV | USGS — public domain; cite Hayes et al. (2018) Science 362, 58–61 |
| `seafloor-age.bin.gz` + `seafloor-age.json` | `scripts/build-seafloor-age.mjs` | Seton et al. (2020) G³ 21 e2020GC009214, release 2020.1, `age.2020.1.GTS2012.6m.grd` (sha256 `67c1803d…2f6c`) from EarthByte `earthbyte/agegrid/2020/Grids/` — every 2nd node (0.2°), subsampled never averaged | CC BY 4.0 — cite Seton et al. (2020) |

Oracles (tests only): `tests/fixtures/geomag/chaos-oracle.json` — ChaosMagPy 0.16 on the same
three SHC files, written by `scripts/chaos_oracle.py`. `tests/fixtures/earth-interior/slab2-contours.json`
(Slab2's own GMT depth contours) and `slab2-dips.json` (Slab2's own dip grid at 1° nodes), written by
`scripts/build-slab2-fixtures.mjs` from the same commit.
`tests/fixtures/earth-interior/seafloor-age-xyz.json` — nodes of the SAME release's text twin (`age.2020.1.GTS2012.6m.xyz`, sha256 `dd3ac333…2d52a`), written by `scripts/build-seafloor-age.mjs --fixture`.
