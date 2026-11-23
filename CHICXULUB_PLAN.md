# Chicxulub reconstruction — status and next steps

*Written 2026-11-23. Page: `chicxulub.html`. Kernels: `js/chicxulub/*`. Gates:
`node tests/chicxulub.mjs` (341 checks) and `tests/chicxulub-page.spec.js` (8).*

## 1. Where it stands

| Piece | State |
|---|---|
| Evidence table (49 rows, each flagged checked / from memory) | built |
| Forward scaling: crater, ejecta, quake, fireball, blast, tsunami, iridium | built — coefficients from memory |
| Backward: impactor posterior, escape hyperbola, orbit family by hour of day | built |
| Constraint lab: 7 fitted rows, 5 held out, sensitivities, stiff/loose directions | built |
| 3-D stage, one clock T−20 s → T+30 yr, planet view with four fronts | built — software-rendered only |
| Climate: one-reservoir box anchored on published darkness and peak cooling | built — cannot do the recovery |

Current answer: a 13–21 km body at 13–25 km/s, 45–60° from the north-east,
with 5–20 % of its iridium in the global layer.

## 2. What limits it now (measured, in order of how much it matters)

1. **Nothing has been read from a paper.** 14 evidence rows and every scaling
   coefficient are from memory. A good fit means "consistent under these laws".
2. **The loosest direction is free by ×4.4** — size against speed against
   iridium share. Only the population speed prior holds it.
3. **Which ring is the rim** moves the size by ~20 %. The ejecta favour the
   inner rim (outer ring −2.5σ), resting on two sections, one recalled.
4. **The trajectory uses today's geography**: site latitude, obliquity, and
   present-day distances to every ejecta site.
5. **The climate box has one heat reservoir**: right depth of cold by
   construction, recovery far too slow, soot spread-up assumed.
6. **The collapse is an interpolation**, the globe has no land or sea, and the
   whole stage has never been seen on a GPU.

## 3. Next steps

Each step names what it would change and how we would know it worked.

### A. Verify the evidence and the laws — *needs network access to the papers*

- Read Collins 2005 (scaling), Collins 2020, Morgan 2022, Goderis 2021,
  Artemieva & Morgan 2017, Bardeen 2017, Senel 2023, Nesvorný 2021. Flip each
  `verified` flag; correct values that differ.
- Replace the recalled speed prior with Nesvorný's distribution for ≥10 km
  carbonaceous impactors.
- **Done when:** no fitted row and no scaling coefficient is `verified: false`,
  and the report is re-run. Expect the headline to move; that is the point.
- *One session. Highest value per hour. Blocked in this environment.*

### B. More constraints on the loose direction

- **Ejecta table with K–Pg distances.** Add Belize, Brazos, Tanis and a
  restored Beloc using a plate reconstruction; each is another D_tc⁴ row.
- **Melt volume** and **Moho uplift** as rows (both respond to energy and
  depth, not just crater width) — the first rows that see speed separately
  from size.
- **Spherule size or shocked-quartz reach** if a usable scaling exists.
- **Done when:** the loosest direction in `stiffness` is tighter than ×2
  without the speed prior, or we can say why it cannot be.

### C. Palaeo-geography — *one kernel, three consumers*

- A pure `paleo.js`: rotate present coordinates to 66 Ma (published Euler
  poles for North America, Caribbean, and the crater's own plate).
- Feeds (1) the trajectory's latitude and bearing, (2) ejecta distances,
  (3) a land/sea mask on the globe so the tsunami ring stops at coasts.
- **Done when:** Beloc moves from held-out to fitted and stops being a 1.7σ
  miss, or stays a miss for a reason we can state.

### D. Climate that can recover — *first attempt measured out, 2026-11-23*

- **Tried: a second ocean layer** (`impactWinterLayered`: surface 60 m takes
  the forcing; mixes with the water below when colder, floats when warmer).
  Same peak cooling, exact heat budget — and **no recovery**: −3.0 … −6.0 K
  at 30 yr across the exchange range (one box −7.3 K). Even cut off from the
  deep water the surface needs ~14 yr, because its own e-folding time is
  C_s/λ = 6.7 yr. The deep ocean was not the limit. Pinned in the gate; the
  page does not use it.
- **What it needs instead: LAND as its own box.** Land has almost no heat
  capacity, so it cools far more and recovers in about a year; the published
  global mean is a land/ocean average. That takes the published land/ocean
  split (and a recovery time to hold out) — both in step A. Do not build it
  on a recalled split.
- **Done when:** the recovery phase and its slider mark can be added back and
  the gate's "still cold at 30 yr" pin is replaced by a held-out check.

### E. A physical crater collapse — *larger, optional*

- Replace the interpolation with an axisymmetric model of the transient
  cavity's collapse (acoustic-fluidisation-style rheology, as in the published
  hydrocodes), or bake frames from a real iSALE run if one can be obtained.
- Honest alternative: keep the sketch, but time its phases from a published
  simulation's frames rather than from a coefficient.
- **Done when:** the peak-ring radius comes OUT of the model instead of being
  drawn at the measured value.

### F. Visuals — *needs a GPU session*

- First look on real hardware; fix what a software renderer hid.
- Fireball as a volume, not a shell; debris curtain as particles on the
  kernel's ballistic paths; re-entry glow inside the debris ring; water
  returning to the crater.
- Capture for the homepage showcase and write the build-log entry.

### G. Site integration

- Open the PR, add the dev-log entry, decide whether it earns a nav slot
  (menus are at their cap) or stays on the Earth & Orbit hub.
- Cross-link: Near-Earth Watch (what a 10 km object looks like in the
  catalogue), Volcanoes (same climate box), Inner Earth (crater in section).

## 4. Recommended order

**A → C → B → D**, with **F** whenever a GPU machine is available and **G**
when you want it visible. A first because every later number depends on it;
C before B because the new ejecta rows need palaeo-distances; D last of the
four because it needs the masses A confirms. E only if the page should make
claims about the peak ring.

If A stays blocked here, the best work available in this environment is **C**
(pure geometry from published poles, testable against known plate motions)
— **D** was tried here and now waits on A (see its entry).

## 5. Decisions needed from the owner

1. Can a session get paper access (or can PDFs be dropped into the repo)?
2. Is the page for the public showcase or a research tool first? (Sets how
   much of F and E is worth doing.)
3. Open the PR now, or after step A?
