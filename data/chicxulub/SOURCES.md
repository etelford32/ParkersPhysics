# Chicxulub — sources and what was checked

The evidence table is `js/chicxulub/observations.js` (the ONE copy; this file
is its prose). Built 2026-11-22.

## How the numbers were gathered

Every paper host (nature.com, PMC, arXiv, Wiley/AGU, PNAS, NSF PAR, Wikipedia)
was **egress-blocked** from the build machine, so nothing here was read from a
paper's own page. Two kinds of row result, and the table flags each:

| `verified` | Meaning |
|---|---|
| `'search'` | The number appeared in a web-search result quoting the source (abstract, press release, repository record) on 2026-11-22. |
| `false` | Written from memory of the literature. **Not checked.** |

49 rows: 35 search-confirmed, 14 recalled. `scripts/chicxulub-report.mjs`
prints the reconstruction; `node tests/chicxulub.mjs` gates it.

## Search-confirmed

| Quantity | Value | Source |
|---|---|---|
| Crater centre | 21°20′N 89°30′W | crater listings |
| Outer rim | 180–200 km | Morgan et al. 1997; Gulick et al. 2008 |
| Inner (topographic) rim | 140–170 km | Gulick et al. 2013 |
| Peak ring | 80–90 km, ≤ 400 m relief | Morgan et al. 1997; Rae et al. 2019 |
| Hole M0077A | 21°26.996′N 89°56.968′W; core 505.70–1334.69 mbsf; suevite/melt 617.33–747.02; granitoid below | IODP–ICDP Exp. 364 |
| First-day deposit | ~130 m, lowest 40–50 m in minutes | Gulick et al. 2019 PNAS |
| Age | 66.043 ± 0.011 Ma | Renne et al. 2013 |
| Trajectory | 45–60° to horizontal, from the NE; < 30° ruled out | Collins et al. 2020 Nat. Commun. 11, 1480 |
| Asymmetry | peak-ring centre ~5 % of D downrange, mantle uplift uprange | Collins et al. 2020 |
| Global Ir fluence | 55 ± 3 ng/cm² (52 sections); 10–45 near the crater | Goderis et al. 2021 Sci. Adv. |
| Lower Ir fluence | 28 ng/cm² | Moore & Sharma 2013 (LPSC 2431) |
| Impactor type | CM2-like (⁵⁴Cr); carbonaceous, outer Solar System (Ru); fossil meteorite | Trinquier 2006; Fischer-Gödde 2024; Kyte 1998 |
| Source region | main belt, ~60 % beyond 2.5 au; ≥ 10 km every ~250 Myr | Nesvorný, Bottke & Marchi 2021 |
| Energy | ~10²³ J (4×10²³ J also quoted) | Morgan et al. 2022 |
| Earthquake | Mw 10–11 | DePalma et al. 2019 and refs |
| Tsunami | 14 km body at 12 km/s; 4.5 km wave at 2.5 min; 1.5 km at 220 km, 10 min; > 100 m Gulf; > 10 m far coasts; 30 000 × 2004 | Range et al. 2022 AGU Adv. |
| Volatiles | 325 Gt S, 425 Gt CO₂ | Artemieva & Morgan 2017 |
| Soot | 15 000 Tg → −16 °C, < 1 % light for ~2 yr | Bardeen et al. 2017 PNAS |
| Dust | up to −15 °C, photosynthesis off ~2 yr | Senel et al. 2023 Nat. Geosci. |
| Ejecta | Beloc 46 cm (reworked to 125 cm); NE Mexico 0–1 m; distal ~3 mm beyond 5000 km | Kring (LPI); Morgan et al. 2022 |

## Recalled — check before relying on them

- Collins 2020 model inputs (17 km, 12 km/s, 2630 kg/m³) and Artemieva & Morgan's (12 km, 18 km/s).
- Transient cavity ~100 km, Moho uplift 1.5–2 km, burial ~1 km, 3 km sediment cover.
- Chondrite iridium abundances (CM 595 ng/g, Wasson & Kallemeyn 1988).
- Impactor bulk density range; Raton Basin thickness; all ejecta-site coordinates.
- Boreal-spring season (During et al. 2022); Brugger 2017's −26 °C; ~75 % species loss.
- **The crater scaling coefficients themselves** (Collins, Melosh & Marcus 2005) —
  `SCALING.verified` is false in `js/chicxulub/impact-model.js`.
- The asteroid impact-speed prior and the aerosol extinction coefficients.

## Deliberately left empty

- **Senel 2023 dust mass.** Not confirmed, and recalled with a possible 1000×
  ambiguity (Tg vs 10¹⁸ g). `null`, and the climate box is not run for dust.

## Still missing (`OPEN_DATA`)

Yucatán palaeolatitude and rotation at 66 Ma · Collins 2020 centre offsets in
km · Nesvorný 2021 impact-speed distribution · a fitted ejecta thickness table
with K–Pg distances · GCM land/ocean splits · the gravity and magnetic grids.

One networked session reading the six open-access papers settles most of the
recalled rows: flip each flag as it is checked, and correct the value if the
paper disagrees — the gate does not pin recalled values.
