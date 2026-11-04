# data/volcanoes — the Earth Volcanoes catalogue

`volcanoes-catalog.json` is **generated** by `scripts/build-volcano-catalog.mjs`
— never hand-edit it; re-run the baker (`--check` fails if it has drifted from
its sources). Read it only through `js/volcano-engine.js` `decodeCatalog`.

| Source | What it contributes | Pinned copy (sha256 in the baker) |
|---|---|---|
| Smithsonian GVP, *Volcanoes of the World* 5.3.4 — Holocene list, downloaded 22 Mar 2026 | 1,222 volcanoes: identity, position, type, landform, tectonic setting, rock, activity evidence, **last known eruption** | `jwilleke/volcano-lists@063f6ad` `data/GVP_Volcano_List_Holocene_202603220718.xls` |
| Same, Pleistocene list | 1,439 volcanoes with no known Holocene eruption (the "inactive" class) | same repo, `…Pleistocene_202603220718.xls` |
| GVP eruption + volcano tables, exported for TidyTuesday 2020-05-12 | 9,769 confirmed eruptions (start year, VEI, end year) through early 2020; LandScan population within 5/10/30/100 km for 954 volcanoes | `rfordatascience/tidytuesday@f422450` `data/2020/2020-05-12/{eruptions,volcano}.csv` |

**Why mirrors.** volcano.si.edu and its GeoServer are egress-blocked from the
build sandbox. The GVP files are byte-for-byte the "Download list" exports
(SpreadsheetML), hashed. On a machine that can reach GVP, the same files can be
downloaded there and dropped into `scripts/.cache/volcanoes/` — the hash check
will say whether they are the same release.

**The six-year gap.** The per-eruption table ends in 2020; the lists are 2026.
The engine never invents eruptions to fill it: a volcano whose list-reported
last eruption is newer than the table gets exactly ONE extra onset in the
hazard count, and "last known eruption" takes whichever source is newer.
161 eruption rows reference volcano numbers that are no longer in the 2026
Holocene list (renumbered or merged) and are counted, not merged.

**Citation.** Global Volcanism Program. *Volcanoes of the World* (v. 5.3.4).
Smithsonian Institution. https://volcano.si.edu/ — GVP data are freely usable
with this attribution; keep it visible on any page that draws them.

**Live status** is NOT in this file: it is `/api/volcanoes/activity` (USGS
HANS elevated volcanoes + NASA EONET open volcano events), joined to the
catalogue client-side by `matchActivity`.
