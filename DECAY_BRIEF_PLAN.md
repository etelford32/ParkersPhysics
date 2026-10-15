# Decay Brief — plan

Status: **planned, not built** (2026-10-15)
Owner: Parkers Physics
Parent: `ORBIT_MARGIN_ROADMAP.md` (this is the free top-of-funnel artifact
that leads into the $3,500 *Fleet Storm-Readiness Assessment* defined there)

## 1. What it is

A one-page, per-satellite **Decay Brief** we produce *before* first contact
with a university or small-fleet operator, built from public data only:

- where the satellite is now (perigee/apogee, TLE age, decay rate);
- **remaining lifetime as a band**, not a date, under the current solar-cycle
  outlook;
- **what one storm costs it**: days of life lost if a Gannon-class (May 2024)
  storm hits next month — the headline number for the outreach email;
- a deorbit-rule check (lifetime vs. the post-mission disposal limit that
  applies to the mission — confirm per licence, do not assume);
- assumptions, uncertainty and provenance, per the roadmap's principles 2–4.

It is a *conversation opener*, not a deliverable. The paid assessment is
where operator-supplied mass/area/attitude replace public-TLE guesses.

## 2. What already exists (reuse, do not fork)

| Piece | Where | Status |
|---|---|---|
| Orbit-averaged Gauss decay integrator over NRLMSISE-00 | `js/operations/msis-drag.js` (`integrateDecay`, `orbitAverageRates`, `msisDecayWithSigma`) | Shipped, node-gated by `tests/operations-msis-drag.mjs` incl. real WASM |
| B* → C_D·A/m conversion + σ ladder | same file (`ballisticFromTle`) | Shipped; ±35 % (TLE) / ±60 % (default) |
| SGP4 (Vallado-verified) | `rust-sgp4` → `js/sgp4-wasm` | Shipped |
| Live/single-object TLE fetch | `api/celestrak/tle.js` (`?norad=`) | Shipped |
| 45-day Ap + F10.7 forecast | `api/_lib/ap45.js` | Shipped (post-2026-03 SWPC product) |
| Definitive historical Ap/F10.7 | `dsmc/pipeline/fetch_historical_indices.py` (GFZ) | Shipped |
| F10.7 81-day average helper | `js/nrlmsise00-bridge.js` `computeF107A` | Shipped |

## 3. The three gaps

### Gap A — constant drivers over the whole lifetime

`integrateDecay` takes one `rhoAt(altKm)` for the entire integration, i.e.
today's F10.7/Ap held fixed for months or years. For a 400 km CubeSat that
lives 3–12 months on the declining side of Cycle 25 this is the dominant
error. **Fix:** an additive, optional time-dependent density
`rhoAtT(altKm, tDays)` in `integrateDecay` (default: today's behaviour, so the
existing gate is untouched), fed by a **driver schedule**:

1. realised indices up to now (GFZ / SWPC observed);
2. SWPC 45-day F10.7 + Ap forecast (`ap45.js`);
3. beyond 45 d, NOAA's predicted solar-cycle F10.7 (median + bounds). This is
   a **new source**; the schema is UNVERIFIED (NOAA is egress-blocked at build
   time), so it resolves from a candidate list and self-reports, the
   `noaa-regions` pattern. Register it in `js/pipeline-registry.js`.

Profiles are cached per (F10.7, Ap, 3-h bucket) already; a schedule just
walks those keys, so the WASM cost stays one profile per distinct state.

### Gap B — B* is not the satellite's ballistic coefficient

The kernel header says it plainly: B* is an SGP4 fit parameter, routinely a
factor ~2 from the physical C_D·A/m. That alone can halve or double a
lifetime. **Fix:** fit the ballistic coefficient from the satellite's *own*
observed decay. Take the last 30–60 days of element sets, integrate
semi-major axis forward through the *realised* indices, and solve for the
single B that best matches the observed mean-motion history (1-D, so a
bracketed root/least-squares solve is enough). The fit residual sets σ_B; it
replaces the blanket ±35 %. Fall back to B* (and its σ) when there is too
little history, and say which one ran (`bcSource: 'fit' | 'tle' | 'default'`).

TLE **history** needs a Space-Track account (`gp_history`); CelesTrak serves
only the latest set. Use the data for analysis; do not republish raw element
sets (check the Space-Track user agreement).

### Gap C — no evidence it works

We must not send a lifetime number to a flight-dynamics professor without a
track record. **Backtest on university CubeSats that have already re-entered**
(candidates from the target-list research, to be confirmed against
Space-Track decay dates):

- CySat-1 (Iowa State, deployed 2024-10-09, re-entered 2025-01-14)
- EagleSat-2 (Embry-Riddle, deployed 2025-12-02, re-entered 2026-05-17)
- Binar-2/3/4 (Curtin, re-entered late 2024, ~2 months instead of ~6 planned)
- HyTI (Hawaii, deployed Apr 2024, re-entered Dec 2024)
- GASPACS (Utah State, Jan → May 2022)
- JagSat-1 (South Alabama, Sep 2022 → Jan 2023)
- KITSUNE (Kyutech, Mar 2022 → Mar 2023)

For each, predict re-entry from the TLE at T−90, −60, −30, −14 and −7 days in
three modes:

| Mode | B source | Drivers | Answers |
|---|---|---|---|
| Naive baseline | B* | constant at issue time | what a free tool gives you |
| Operational | fitted B | forecast available *at issue time* | what we would really have said |
| Hindcast reference | fitted B | realised indices | the ceiling if drivers were perfect |

Metric: re-entry-date error as a **fraction of remaining life** (an error of
5 days means something different at T−7 and T−90), plus coverage of the
displayed band. The gap between "operational" and "hindcast" is the honest
size of solar-forecast uncertainty, and it is a selling point for the paid
storm-alert service, not something to hide.

**Gate before any brief is sent:** operational mode beats naive at every
horizon on the set, and the band covers the actual date in most cases. The
brief quotes the measured numbers ("on 7 re-entered university CubeSats,
our 30-day-out re-entry estimate was within N % of the remaining life"),
whatever they turn out to be.

## 4. Build sequence

| Step | Work | Output | Gate |
|---|---|---|---|
| 1 | `rhoAtT` option in `integrateDecay` + pure driver-schedule module | `js/decay/driver-schedule.js` | existing `tests/operations-msis-drag.mjs` unchanged and green; new test: a schedule held constant reproduces today's lifetime exactly |
| 2 | Ballistic-coefficient fit from element history | `js/decay/fit-ballistic.js` | synthetic test: decay generated with a known B and noisy elements recovers B within its σ |
| 3 | Data fetchers: Space-Track history (local CLI only, creds from env), predicted-cycle F10.7 (candidate list), GFZ realised indices | `scripts/decay/fetch-*.mjs` + committed fixtures | node tests run offline on fixtures |
| 4 | Backtest harness over the re-entered set | `scripts/decay/backtest.mjs` → `DECAY_BACKTEST_RESULTS.md` | the gate in §3C |
| 5 | Brief generator: NORAD ID in, JSON + one-page HTML (print-to-PDF) + one PNG chart for the email out | `scripts/decay/brief.mjs` | every number in the page comes from the JSON; caveats and provenance present |
| 6 | Run for the Wave 1 satellites; owner reviews every brief by hand | `briefs/` (not committed: names + outreach) | owner sign-off per brief |

Everything kernel-side stays PURE and node-testable (the repo's standing
rule); network fetches live only in the CLI scripts. The generator runs on a
networked machine. This sandbox cannot reach NOAA or Space-Track.

## 5. The brief, page layout

1. **Header**: satellite name, NORAD ID, operator, "prepared from public data
   on <date>".
2. **Now**: perigee / apogee, TLE age, decay rate (m/day), B and its source.
3. **Lifetime chart**: perigee altitude vs. date, median line + band, with the
   re-entry window shaded; a second dashed line for the storm scenario.
4. **Storm cost**: "A Gannon-class storm next month shortens the remaining
   life by ~N days (band)". The storm scenario is the realised May 2024 Ap
   series spliced into the schedule, not an invented number.
5. **Disposal check**: lifetime against the disposal limit that applies,
   flagged "verify against your licence".
6. **Assumptions & caveats**: public TLE, fitted or B*-derived B, NRLMSISE-00
   day/night-averaged profile, solar-cycle outlook source, backtest skill.
7. **Footer**: what the paid assessment adds (your real mass/area/attitude,
   weekly re-runs, storm alerts, post-storm scorecard against your tracking).

## 6. Open decisions for the owner

1. **Space-Track account.** Needed for steps 2–4. A free registration; keep
   the credentials local (env), never in the repo or Vercel.
2. **What goes in the first email.** Recommendation: the one storm-cost
   sentence plus the PNG chart, and the full brief offered on reply. Sending
   a full analysis unasked to people who know orbits better than a sales
   email reads as presumptuous; a single good number reads as competent.
3. **Price alignment.** `ORBIT_MARGIN_ROADMAP.md` sets the founding
   assessment at $3,500; use that one figure everywhere.
4. **MHD claims stay out.** Per roadmap principle 5, the brief sells
   lifetime-under-uncertainty and storm sensitivity, not superior density
   accuracy, until the Phase-0 density gate clears.
