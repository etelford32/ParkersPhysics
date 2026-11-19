# data/earth-interior — baked inputs for earth-interior.html

Every file here is BUILT by a script from sha256-pinned upstream copies; never hand-edit one.
`--check` rebuilds and compares (CI: `.github/workflows/earth-interior-kernels.yml`).

| File | Built by | Upstream | Licence / credit |
|------|----------|----------|------------------|
| `ground-1d/` | (raw copies) → `scripts/build-ground-models.mjs` → `js/earth-interior/ground-models.js` | greglucas/bezpy @ b7944f9 | USGS public domain; GSC OF 8115 OGL-Canada (confirm); bezpy MIT |
| `chaos-8.1.json.gz` | `scripts/build-chaos.mjs` | DTU CHAOS-8.1 via ESA-VirES/MagneticModel @ 6aa2d4f (`CHAOS-8.1_{core,core_extrapolated,static}.shc`) | DTU distributes CHAOS freely with citation — Finlay, Kloss, Olsen et al., CHAOS-8 (confirm the terms page in writing) |
| `plates-pb2002.json.gz` | `scripts/build-plates.mjs` | Bird (2003) G³ 4(3) 1027 supplement, unmodified in fraxen/tectonicplates @ 339b0c5 `original/` | Open Data Commons Attribution 1.0 — credit Peter Bird and Hugo Ahlenius (Nordpil); seafloor ages Müller et al. (1997) and depths ETOPO5 as tabulated by Bird |

Oracles (tests only): `tests/fixtures/geomag/chaos-oracle.json` — ChaosMagPy 0.16 on the same
three SHC files, written by `scripts/chaos_oracle.py`.
