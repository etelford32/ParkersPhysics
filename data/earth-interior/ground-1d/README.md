# 1-D ground-conductivity columns — provenance

`usgs-v1.3/` is a BYTE-FOR-BYTE copy of `bezpy/mt/data_1d/` from
`greglucas/bezpy` @ `b7944f9404f3ab59373279f8116cc288e90dc390` (MIT, see
`LICENSE-bezpy.txt`). Never hand-edit; `scripts/build-ground-models.mjs` pins
every file by sha256 and generates `js/earth-interior/ground-models.js`
(`--check` in CI).

| Files | Origin | Licence |
|---|---|---|
| 21 regions (AK1A … SU1) | USGS ground-conductivity model v1.3 — Fernberg (2012) EPRI TU 1026430; Love & Blum (USGS). See `00README.txt` | US Government work (public domain) |
| BOU | USGS Boulder observatory; its own header: "We are not sure how it was produced." | US Government work |
| ALE BLC BRD CBB FCC GLN IQA MEA OTT PBQ RES SNK STJ VIC YKC | Geological Survey of Canada Open File 8115 (Trichtchenko, Fernberg & Danskin) | Open Government Licence – Canada (TO CONFIRM) |
| QUE | NERC TPL-007-4 Attachment 1 Table 4 — the reference Earth (Quebec) | published standard values |

The 21 USGS regions are cross-checked layer by layer against an independent
copy (`butala/pyrsss` @ `5b9d347`, kept as
`tests/fixtures/earth-interior/pyrsss_usgs_conductivity.py`). The canonical
files and the region polygons live at https://geomag.usgs.gov/conductivity/
(egress-blocked at build time) — UNVERIFIED against canonical until a refresh
run fetches them. The polygons are not baked, so no code maps a location to a
column. See `INNER_EARTH_PLAN.md` §8a.
