# Chicxulub reconstruction — status and next steps

*Written 2026-11-23. Page: `chicxulub.html`. Kernels: `js/chicxulub/*`. Gates:
`node tests/chicxulub.mjs` (360 checks), `node tests/paleo-rotations.mjs` (23) and `tests/chicxulub-page.spec.js` (8).*

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

### C. Palaeo-geography — *done 2026-11-23 (two of three consumers)*

- **Built on a real published model, not recalled poles.** Müller et al. 2019
  (EarthByte, CC BY-SA 4.0) is baked by `scripts/build-paleo-model.py`
  (sha-pinned) into `data/paleo/` and read by the shared kernel
  `js/paleo/rotations.js`. `scripts/build-chicxulub-paleo.mjs` turns it into the
  66 Ma site table `js/chicxulub/paleo-sites.js`.
- **The gate** (`tests/paleo-rotations.mjs`, 23 checks): every file row is
  reproduced exactly, interpolation is the rotation-space geodesic, round
  trips, rigidity and refusals. It also checks the model against an
  INDEPENDENT dataset: the last 5 Myr of motion agree with Bird's PB2002 to
  15 % in speed and 6° in direction, and the sign flip is the negative control.
- **Results, measured:**
  - the crater was at 21.95°N, 74.53°W in the mantle frame (today 21.33°N,
    89.50°W). Its compass has since turned 12.2° clockwise, so "from the
    north-east" in today's geography becomes ~57° then;
  - the trajectory hardly moves: main-belt share 22 % vs 23 %, best hour 10 h
    both;
  - **Beloc was 1078 km from the crater, not 1796.** It rides the Caribbean
    plate. At that distance the held-out debris prediction is 33.6 cm against
    the 46 cm measured: **−0.29σ, where it was −1.7σ.** It stays HELD OUT. A
    prediction that lands is stronger evidence than a fit, and the deposit is
    reworked. Moving it into the fit is the owner's call;
  - El Mimbral, Raton and Tanis ride the crater's own plate, so their
    distances, and the fit, are unchanged (gated).
- **Not done:** the land/sea mask on the globe. The coastlines are baked, but
  they are TODAY's coastlines carried back. A K–Pg shoreline needs a
  palaeogeography dataset, which belongs to the deep-time Earth simulation
  (`DEEP_TIME_EARTH_PLAN.md`).
- **Still assumed:** the mantle frame, not the spin axis, and today's
  obliquity. **Measured 2026-11-25:** the second model on the deep-time page
  (Merdith et al. 2021, a palaeomagnetic frame) puts the crater at 25.0°N, 3.0°
  north of the mantle frame's 21.9°N — the size of the latitude systematic the
  trajectory carries. Not yet propagated into the trajectory (the hour-of-day
  family and the main-belt share would move a little); the two models are not
  independent, so 3° is a floor on the frame uncertainty, not its size.

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

### E. A physical crater collapse — *first attempt measured out, 2026-11-23*

- **Tried: a depth-averaged Bingham layer** (`js/chicxulub/collapse.js`):
  axisymmetric, staggered grid so a frozen surface stays exactly frozen,
  yield strength calibrated once on Earth's simple-to-complex transition,
  acoustic-fluidisation viscosity and decay (recalled), the model's own
  ejecta blanket as the rim. It conserves mass to 1e-15, freezes in
  5–15 minutes and throws up a central uplift tens of km high — and **does
  not make a peak ring**:
  1. the central uplift does not converge with the grid (45 / 55 / 70 km at
     240 / 480 / 960 cells);
  2. where a ring appears it sits at the ASSUMED edge of the fluidised zone
     (1.1–1.3 × that radius at 60, 155 and 300 km craters) — the parameter,
     not a prediction;
  3. a layer on a rigid base fills the cavity only from the sides, so the
     basin comes out 3–4× too wide.
  Pinned in the gate (§11); the page does not use it.
- **Why, and what it needs instead:** a peak ring forms where the collapsing
  uplift flows outward OVER the rim material slumping in — the overturned
  stratigraphy the IODP core found. A single-valued surface cannot overturn.
  It takes an axisymmetric (r, z) continuum code: incompressible
  viscoplastic flow with a free surface, the same rheology (yield calibrated
  on D_c, decaying fluidisation), material tracers so the overturn can be
  seen. A particle-in-cell / material-point scheme fits that best (no mesh
  tangling). **Several sessions**, not one: the solver, its own gates
  (a Bingham slump with a known run-out, a viscous drop with a known decay
  rate, mass and grid convergence), then Chicxulub. Done when the ring's
  radius converges with the grid and does not track any one parameter.
- **Honest alternative** (unchanged, needs step A): time the stage's sketch
  from a published hydrocode's frames.

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

If A stays blocked here, **C** is done (above) and the next best is **B**,
now that the ejecta distances are the 66 Ma ones. **D** was tried here and
now waits on A (see its entry).

## 5. Decisions needed from the owner

1. Can a session get paper access (or can PDFs be dropped into the repo)?
2. Is the page for the public showcase or a research tool first? (Sets how
   much of F and E is worth doing.)
3. Open the PR now, or after step A?
