# MOON_MISSION_INTEGRATION_PLAN.md — the Moon as a mission-planner destination

> Status: **Phase 0 SHIPPED (2026-11-03)** — colony sites on moon.html, the
> Earth-launch brief, the shared pad table (`js/mission-pads.js`), the colony
> shortlist as planner bases, and deep links between the three pages.
> Phases 1–4 are scoped here and NOT built. Read `LUNAR_COLONY_PLAN.md`
> (the colony game) and the moon-page row of `CLAUDE.md` first.

---

## 1. What we are integrating

Three surfaces already exist and each knows something the others need:

| Surface | Knows | Did not know (before Phase 0) |
|---|---|---|
| `moon.html` | Today's Sun/Earth geometry (`js/moon-ephemeris.js`), the terrain, the crater record, the radiation environment | Where the proposed colony sites are; how you get there from Earth |
| `colony.html` + `js/colony-engine.js` | The ranked site survey (illumination, ice distance, quake exposure), the live-weather hazard model | Nothing about the trip; starts at "Touchdown" |
| `mission-planner.html` + `js/mission-planner-trajectory.js` | Real pads, the lunar transfer (Hohmann + Lambert), launch windows, Δv budgets per vehicle | Only four legacy Moon "bases"; no landing-site lighting; no link to the colony |

The integration rule is the one every other page follows: **one kernel per
fact, many consumers.** The transfer is the planner's; the Sun at the site
is the Moon page's; the site ranking is the colony engine's. Nothing is
re-derived on a second page.

## 2. Phase 0 — shipped

- **`js/mission-pads.js` (PURE, `node tests/mission-pads.mjs`)** — the ONE
  Earth pad table (moved out of the three.js renderer; the planner
  re-exports it as `LAUNCH_SITES`), `colonyShortlist(n)` (colony-engine's
  top-N as planner bases), and `lunarDepartureBrief()`:
  `planLunarTransfer` at the departure instant + the Earth-side plane rule
  (Moon declination at arrival vs the pad's inclination floor, single-
  impulse plane-change Δv as an upper bound) + arrival lighting at the site
  from `lunarGeometry(arriveJd)`. The gate pins the brief to the planner's
  numbers bit for bit and the declination to the 18.3°–28.6° standstill
  envelope.
- **moon.html** — "Proposed Colony Sites" (the survey, ranked; top three as
  green rings on the globe; click → crater report + launch brief; "Run this
  colony" → `colony.html?site=<id>`) and "Getting There — Earth Launch"
  (pad + site selects; depart/arrive, TOF, Δv TLI/LOI, v∞, declination vs
  pad floor, plane change, Sun at the site on arrival, phase; "Fly it in
  the mission planner" → `mission-planner.html?origin=earth&target=moon&pad=<id>`).
- **mission-planner.html** — deep links `?origin=&pad=&target=` (unknown
  values ignored; the parking inclination follows the pad's latitude);
  `MOON_BASES` gains the colony shortlist, so a Moon-origin mission can
  depart from the colony.
- **colony.html** — `?site=<id>` preselects the site card.

## 3. Phase 1 — a landing SITE as the planner's lunar destination

Today "Earth → Moon" ends in a 100 km circular lunar orbit. The colony needs
a surface.

1. **Destination = base.** When `target=moon`, show a "landing site" select
   (the same `MOON_BASES` list, colony shortlist included) and carry
   `base=<id>` in the deep link. The planner's lunar leg then ends with
   descent.
2. **Orbit plane from the site.** A polar colony needs a near-polar lunar
   orbit; the capture orbit's inclination becomes `max(|site lat|, …)` and
   the LOI plane change is costed from the inbound hyperbola's declination
   relative to the lunar equator (the Moon's axis from `moon-ephemeris`'s
   Cassini frame — the same 1.54° the libration already uses).
3. **Descent Δv.** Add a descent leg (Apollo-class ~1.9–2.1 km/s from a
   100 km orbit; a `DESCENT_DV_KMS` constant with its citation, later a
   gravity-turn integration reusing `js/spaceship-designer-ascent.js`'s
   machinery in reverse). The Δv budget bar then reads ascent + TLI + LOI +
   descent against the chosen vehicle.
4. **Arrival lighting as a planner constraint.** The brief already computes
   the Sun at the site at arrival. In the planner this becomes a window
   scan: step the departure day across a lunation and mark days whose
   arrival lighting is in the Apollo band (non-polar sites) or whose
   topographic illumination fraction is high (polar sites, from the survey)
   — the "Find Next Launch Window" button gets a second criterion.

Gate: a node test that a polar site's planned capture orbit is polar, that
descent Δv is added once, and that the lighting scan marks the same days
`lunarDepartureBrief` does.

## 4. Phase 2 — the colony receives the mission

1. **Cargo manifest.** The planner's payload mass at the surface (after
   descent) becomes a `delivery` event the colony engine can ingest:
   `{ arrivalJd, massKg, manifest: { materials, consumables, crew } }`.
   `colony-engine.js` gets a `receiveDelivery(state, delivery)` tick input
   (PURE, gated) that credits stock and lands crew at the pad.
2. **Resupply cadence.** The colony's consumption rates (already in `LIFE` /
   `ELECTROLYZER`) give a "days of margin"; the planner can be asked for
   the next window before margin runs out. Two kernels, one question.
3. **Hand-off links.** `colony.html?site=<id>&delivery=<base64 json>` is
   the simplest honest transport (no server); a later phase can store
   manifests in the dashboards table under the existing migration guard.

## 5. Phase 3 — the Moon page shows the mission

1. Draw the planner's lunar approach (the captured orbit + descent track)
   on moon.html's globe for the selected site, from the SAME
   `planLunarTransfer` / Lambert plan — the Moon page already has the
   spin/ephemeris frame to place an inertial orbit correctly (the
   upper-atmosphere page's GMST lesson: never draw an un-turned inertial
   orbit on a body-fixed scene).
2. The descent camera's landing reticle (already there) becomes the
   mission's target: "double-click to descend" lands where the planner
   says the lander does, with the brief's Sun elevation as the pilot SUN
   readout (it already prints the live elevation).

## 6. Phase 4 — the spaceship designer closes the loop

`js/spaceship-designer-mission.js` already prints a TLI/LOI budget from the
Δv left in the parking orbit. Give it the colony site as a destination so
its budget includes the Phase-1 descent leg and the plane-change upper
bound from `lunarDepartureBrief` for the design's own launch site — the
designer's `LAUNCH_SITES` (in `js/spaceship-designer-engine.js`) should
read `EARTH_LAUNCH_SITES` from `js/mission-pads.js` so there is one pad
table across the site (today it carries a second, differently-keyed copy —
a known duplication to retire in this phase, with `matchLaunchSite`
re-keyed).

## 7. Decisions (made now so sessions don't relitigate)

- The pad table lives in `js/mission-pads.js`, not in a renderer.
- The colony "proposed sites" ARE the Artemis III candidates ranked by the
  colony survey. There is no second list of colony coordinates anywhere.
- The brief's plane-change number is a disclosed UPPER bound; the planner's
  Lambert path is the real answer and the page says so.
- A polar site's arrival lighting is reported as the ephemeris Sun
  elevation (always within ~1.5° of the horizon) plus the survey's
  topographic illumination fraction; the Apollo 7–20° band is only quoted
  for non-polar sites.
- Deep links carry ids, never coordinates: a renamed site breaks a link
  loudly instead of landing a mission at a stale lat/lon.
