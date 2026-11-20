# BZ_ENGINE_PLAN.md — the Bz analysis engine

> **Status (2026-11-20): B0 DONE — feeds SETTLED against production.** The
> feed catalogue + normalisers (`js/bz/feeds.js`, PURE), the relay
> (`/api/bz/feeds?feed=…[&meta=1]`), the probe (`scripts/probe-bz-feeds.mjs`)
> and the gate (`node tests/bz-feeds.mjs`, CI `bz-kernels.yml`) exist, and four
> of the five feeds were measured on a Vercel preview the same day — **§11 has
> the results, and they change the plan: L1 has THREE spacecraft, not two, and
> DSCOVR is not one of them.** Sections 1–9 below are the original plan and
> still say "ACE + DSCOVR" in places; where they disagree with §11, §11 wins.
> B1+ are not built. Owner decisions: §10.
---

## 0. The one-paragraph version

Today the site — like every public space-weather product — shows **one number**:
Bz at L1, one sample a minute, from one spacecraft, 1.5 million km upstream.
The Bz engine replaces that number with a **column**: the north–south field and
the magnetic **flux transport** it drives at every altitude between L1 and the
ground, each with an uncertainty, each scored against the instrument that
actually sits at that altitude. We do not get more detail by owning better
instruments. We get it four ways: (1) reading the higher-cadence and
multi-spacecraft data nobody downstream uses, (2) carrying the field between
instruments with physics instead of a flat time delay, (3) fusing the
instruments with a sequential estimator that reports a posterior, and
(4) deriving the quantities that matter (reconnection flux rate, open flux,
energy flux into the ionosphere, dB/dt at the ground) rather than the raw
component. And we **grade ourselves in public**: wherever an instrument exists
(GEO, ground), the engine's value for that altitude is locked before the
instrument reports and scored after.

---

## 1. What is there now (measured from the repo, 2026-11-20)

| Piece | Where | What it gives the engine |
|---|---|---|
| L1 IMF + plasma, 1-min | `js/swpc-feed.js` (`rtsw_mag_1m.json`, `rtsw_wind_1m.json`), `solar_wind_samples`, `sw_geomag_dataset` (one row per UTC minute, sealed days in R2, read ONLY through `api/_lib/sw-geomag-store.js`) | ~4 months of minute history; the training/validation archive |
| Background Bz noise | `js/flux-rope-noise.js` (MAD σ_bg, σ_hf) | the engine's L1 observation-noise model — reuse, never re-fit |
| Predicted Bz(t) at L1 | flux-rope kernel + the ONE provider `js/flux-rope-forecast.js` | the engine's *forecast* prior beyond the L1 lead time |
| Magnetopause / bow shock | `js/geomag/geospace.js` (Shue 1998 + Farris 1991, aberrated axis), `js/ring-current-model.js` (r₀/α) | the boundary geometry for the altitude ladder |
| Convection E-field, penetration | `js/ring-current-efield.js` (Maynard–Chen, shielding τ) | the inner-magnetosphere rung |
| Ring current / Dst | `js/ring-current-model.js`, transport kernel (JS oracle + WASM) | the 2–6 R_E rung |
| Ground field, 14 USGS stations, 1-min | `/api/geomag/observatories`, `js/geomag/tiga.js` (sequential Bayesian estimator), `js/geomag/igrf.js` (the ONE field evaluator) | the 0 km rung and the estimator pattern |
| Geoelectric field | `js/earth-interior/` geoelectric kernel (exact ramp response, Filon) | the below-ground rung (dB/dt → E) |
| Aurora / precipitation | `/api/noaa/aurora-grid` (OVATION) | an independent check on the ~110 km rung |
| Global MHD | `swmf/` (BATS-R-US), Gannon hindcast | the offline ORACLE for every transfer function |

**What is missing**, and is the engine's actual work:

1. Bz is consumed as a *scalar at L1*. No module carries it to the bow shock
   with a real propagation delay; pages use a flat or speed-only lag.
2. One spacecraft. ACE and DSCOVR are both in the feed; nothing compares them,
   so a single-instrument glitch and a real southward turning look identical.
3. Nothing at GEO. GOES magnetometers (the only real-time field measurement
   inside the magnetosphere) are not ingested at all.
4. Ground data is 1-minute and used only for q₁⁰ (TIGA). USGS serves 1-second.
5. No derived flux quantity anywhere: no reconnection rate, no open-flux
   estimate, no Poynting flux. "Bz = −12 nT" is shown with no statement of
   how much flux that is opening per second.
6. No sub-minute structure. Minute averages erase the Alfvénic fluctuations
   that decide whether a −5 nT hour is steady driving or noise.

---

## 2. Definitions — said once so the pages cannot blur them

- **Bz** is always **GSM** unless a label says otherwise. GSE↔GSM is a
  rotation about X by the dipole tilt angle, which comes from
  `js/geomag/dipole.js` (the ONE tilt). A feed that is GSE is rotated ONCE, at
  ingest, and tagged.
- **"Flux" means three different things and each has its own unit and name:**
  - **Φ̇_D — dayside reconnection rate** (magnetic flux opened per second),
    in **kV** (1 kV ≡ 1 kWb/s). The headline quantity.
  - **F_PC — open polar-cap flux**, in **GWb**, the time-integral of
    Φ̇_D − Φ̇_N (expanding/contracting polar cap).
  - **S — electromagnetic energy flux** (Poynting) into the ionosphere, in
    **mW/m²**, and its hemispheric integral in **GW**.
  Particle flux (GOES electrons/protons) is NOT part of this engine; it is
  already on the site and is only read as context.
- **MEASURED** = an instrument at that altitude reported it.
  **ESTIMATED** = the engine's posterior at an altitude with no instrument.
  **FORECAST** = an estimate for a time after now. Every value the engine
  emits carries exactly one of these three tags plus a 1σ, and no page may
  drop the tag. (The upper-atmosphere / TIGA rule: never let an estimate wear
  a measurement's clothes.)

---

## 3. The altitude ladder

The engine's state is Bz (and the full vector where known) plus the flux
quantities on a fixed set of **rungs**. Altitude is geocentric distance along
the Sun–Earth line down to GEO, then height above the surface.

| # | Rung | Where | Instrument (real time) | Status |
|---|---|---|---|---|
| 0 | L1 | ~235 R_E upstream | ACE MAG, DSCOVR MAG (+ SWFO-L1, IMAP I-ALiRT if public — UNVERIFIED) | MEASURED |
| 1 | Bow-shock nose | ~13–15 R_E | none | ESTIMATED (propagated) |
| 2 | Magnetosheath / subsolar magnetopause | ~10 R_E | none | ESTIMATED (shock jump + draping) |
| 3 | Geosynchronous | 6.6 R_E | GOES-East + GOES-West magnetometers | MEASURED at 2 longitudes, ESTIMATED elsewhere |
| 4 | Ring current | 2–6 R_E | none direct (Dst/SYM-H is its ground shadow) | ESTIMATED (existing models) |
| 5 | LEO / topside | 400–850 km | none public in real time (Swarm, AMPERE are delayed) | ESTIMATED (FAC, Poynting) |
| 6 | E-region | ~110 km | none direct; OVATION is an independent model check | ESTIMATED (equivalent currents from rung 7) |
| 7 | Ground | 0 km | 14 USGS observatories | MEASURED |
| 8 | Below ground | conducting Earth | none | ESTIMATED (existing geoelectric kernel) |

Two rungs are measured at the top, one in the middle, one at the bottom. That
is exactly the geometry of a data-assimilation problem: instruments pin the
ends and one interior point, physics fills between, and the interior
instrument (GOES) is the test of whether the physics is right.

---

## 4. Where the extra detail comes from

This is the answer to "how do we measure more than is currently available".
Each item names what public products do today, what we do instead, and how we
would know it worked.

### 4.1 Cadence — read the seconds, not the minutes

- **L1**: SWPC's public 1-minute product is an average of a faster stream.
  If a 1-second real-time DSCOVR magnetometer product is reachable
  (UNVERIFIED — candidate list, self-reporting route, the `noaa-regions`
  pattern), ingest it. If not, the minute product stays the floor and §4.1
  degrades to ground + GEO only; the engine says which.
- **Ground**: USGS serves `sampling_period=1` (UNVERIFIED from here; the
  existing route requests 60). 1-second ground data resolves Pc5 pulsations,
  sudden impulses to the second, and dB/dt honestly (a minute mean
  under-reads peak dB/dt several-fold in a substorm).
- **GEO**: GOES magnetometer real-time JSON is 1-minute (UNVERIFIED cadence).
- What sub-minute buys: a **structure spectrum** per rung — power in
  0.5–5 mHz (Pc5), 5–100 mHz, and the Bz/|B| Alfvénicity — and the *timing*
  of a southward turning to seconds instead of a minute.
- Cost reality: 1-second × 14 stations × 3 components is ~3.6 M values/day.
  This NEVER goes to Postgres (`SUPABASE_OFFLOAD_PLAN.md`). Browser-side
  ring buffer for live; R2 day files (the `archive-sweep` pattern) for
  history, and only if we decide to keep history (§10 D3).

### 4.2 Two spacecraft are a gradient, not a spare

- ACE and DSCOVR sit at different points of the L1 halo, separated by tens
  of R_E mostly *across* the Sun–Earth line. Public products pick one
  ("active spacecraft") and discard the other.
- We keep both and compute, per minute: the **difference** (a robust
  instrument-fault / calibration detector — a spike in one and not the other
  is not solar wind), the **cross-correlation lag** between them (which,
  with their known separation, measures the **tilt of the phase front**
  directly), and a noise-weighted fused Bz with a σ that widens when they
  disagree.
- Spacecraft positions: SWPC publishes ephemerides for both (UNVERIFIED
  path); JPL Horizons via the existing `js/horizons.js` query builder is the
  fallback.
- If SWFO-L1 and/or IMAP I-ALiRT real-time magnetometer data are public by
  the time this is built, they join as additional rung-0 members through the
  same interface. Three or four points make the phase-front normal a
  least-squares fit instead of a single lag. (UNVERIFIED — do not design
  around them.)

### 4.3 Propagation — carry the field, don't delay it

- Today: lag = distance / speed. Known error: ±10–20 min, because
  structures arrive as **tilted planes**, not as fronts normal to the flow.
- Engine: **phase-front propagation** (Weimer & King 2008 lineage): estimate
  the front normal **n** by minimum-variance analysis on a sliding window
  (constrained ⟨B·n⟩ = 0), cross-checked against the two-spacecraft lag of
  §4.2; delay = (r_target − r_sc)·n / (v·n). Out-of-order arrivals are
  resolved explicitly (a later parcel can overtake), and a window whose
  eigenvalue ratio is too small to define n FALLS BACK to the flat delay and
  is flagged.
- Target is the bow-shock nose from `geospace.js` at the *current* dynamic
  pressure — the standoff distance moves 3+ R_E in a storm, which is minutes
  of delay by itself.
- Verification that needs no new instrument: the propagated arrival time of
  every sharp pressure jump is checked against the **sudden impulse** in the
  1-second ground H and the GOES compression. That gives a continuously
  accumulating error distribution for the timing, per method — flat delay is
  the permanent negative control.

### 4.4 Through the shock and sheath — the transfer nobody publishes

- Rung 1→2: Rankine–Hugoniot jump at the local shock geometry (the same
  conditions the Shielding Lab and flux-rope sheath already reason about),
  then stagnation-line **draping/pile-up** to the subsolar magnetopause.
  Result: the Bz that actually reconnects is typically 3–4× the L1 value and
  its clock angle is preserved to first order but not exactly.
- This is a MODEL, so it is fitted and gated against an oracle we already
  own: the BATS-R-US runs in `swmf/` (Gannon + whatever quiet/moderate
  intervals we add). The transfer function is a small analytic kernel whose
  coefficients are FITTED to MHD output and whose residual is printed — not
  an MHD run in the browser.

### 4.5 Flux — the quantity Bz is a proxy for

- **Φ̇_D** from the fused, propagated upstream state. Two independent
  estimators, both reported, never averaged silently: Milan et al. 2012
  (L_eff·v·B_yz·sin^{9/2}(θ/2)) and Newell et al. 2007 (dΦ_MP/dt). Their
  disagreement is part of the stated uncertainty.
- **Φ̇_N** (nightside closure) from the ground: substorm onsets and the
  auroral-electrojet response in the high-latitude USGS stations (BRW, CMO,
  DED, SHU, SIT). With five stations this is coarse — said plainly.
- **F_PC(t)** = ∫(Φ̇_D − Φ̇_N)dt with a relaxation prior, giving a live
  polar-cap size. Independent check: the OVATION oval's poleward boundary
  (already ingested) — a model-vs-model check, labelled as such.
- **Saturation**: cross-polar-cap potential saturates in strong driving
  (Siscoe–Hill). The engine carries the saturated value and shows both, so a
  −40 nT Gannon-class Bz does not print a physically impossible potential.

### 4.6 Inside the magnetosphere — one real anchor, used hard

- GOES-East and GOES-West magnetometers: rotate to GSM, subtract a quiet
  model field (IGRF from `igrf.js` + an external model — T89c is the
  smallest honest choice, parameterised by Kp; anything newer needs solar
  wind history and is a later phase).
- The **residual** is the measured magnetospheric response: dayside
  compression, nightside stretching (growth phase — the field at GEO goes
  tail-like *before* onset, which is a real, usable precursor), and
  dipolarization at onset.
- The engine PREDICTS that residual from rungs 0–2 and scores itself against
  the two satellites every minute. This is the engine's main skill ledger
  (§6) because it is the only interior measurement there is.

### 4.7 LEO and the E-region — estimated, and disclosed as such

- Field-aligned currents and Poynting flux at 400–850 km from an empirical
  coupling model driven by the engine's rung-2 state (Weimer-class; exact
  choice is a Phase 5 decision, with licence checked first).
- E-region equivalent currents by upward continuation of the ground
  perturbation (spherical elementary currents over North America, where the
  14 stations are). Coverage is regional and the map is drawn ONLY where
  stations constrain it — no global map from 14 points.
- There is NO real-time public instrument at these rungs. The engine says so
  on every surface, and validates retrospectively against delayed public
  data (Swarm FAC products, AMPERE) in the hindcast set, not live.

### 4.8 The estimator — one posterior for the whole column

- State: per-rung Bz (+ vector where known), Φ̇_D, Φ̇_N, F_PC, timing offset.
- Process model: the transfer kernels of §4.3–4.7.
- Observations: ACE, DSCOVR, GOES-E, GOES-W, the USGS stations — each with
  its own noise model (`flux-rope-noise.js` at L1; measured quiet-day
  scatter elsewhere).
- Filter: sequential, in the TIGA mould (`js/geomag/tiga.js` is the house
  pattern and its OSSE gate is the template). Linear-Gaussian where the
  kernels allow; the timing offset is the one nonlinear state and gets a
  small particle set.
- **Calibration is gated, including its shortfall** (the TIGA rule): an OSSE
  runs the filter on synthetic truth from the MHD oracle, and the gate pins
  coverage. Widening error bars to pass it must fail.
- Past the L1 lead time (~30–60 min) the prior comes from the EXISTING
  flux-rope provider's published forecast (`'flux-rope-forecast'` event) —
  the engine never runs a second ensemble.

---

## 5. Architecture (house rules applied)

```
feeds (edge relays, candidate lists, self-reporting, never 5xx)
  /api/bz/l1          ACE + DSCOVR mag (+ positions)       → registry
  /api/bz/geo         GOES-E/W magnetometers                → registry
  /api/geomag/observatories  (+ optional sampling_period=1) → exists
        │
        ▼
js/bz/  — PURE kernels, node-gated, no DOM / fetch / ambient time
  frames.js       GSE↔GSM (tilt from geomag/dipole.js), spacecraft geometry
  fuse-l1.js      two-spacecraft fusion, fault detection, σ
  propagate.js    MVAB phase-front delay, flat-delay fallback + flag
  sheath.js       shock jump + draping transfer (coefficients fitted to SWMF)
  flux.js         Φ̇_D (two estimators), saturation, F_PC integration
  geo-residual.js GOES − (IGRF + external model), GSM
  ground.js       1-s spectra, dB/dt, equivalent currents (regional)
  spectrum.js     band powers, Alfvénicity, structure classification
  column.js       the estimator — the ONE object pages read
        │
        ▼
js/bz-engine-provider.js   ONE shared provider (the flux-rope-forecast
                           pattern): runs in a Worker, publishes
                           window.__bzColumn + a 'bz-column' event
        │
        ▼
bz.html (new page) · space-weather.html panel · status band row ·
verdict card line · upper-atmosphere / ring-current drivers (later)
```

- Kernels are JS first (they are small). A Rust/WASM port happens only if a
  measured budget demands it, with JS kept as the oracle (the ring-current
  rule).
- No bundler, no framework, flat `bz.html` at the root, nav through
  `js/site-sections.js` (Space Weather menu is at its 10-link cap → the page
  goes on the hub unless something is displaced; §10 D5).
- Every route registered in `js/pipeline-registry.js`, emits
  `freshness:'stale'` on fallback, upstream added to `api/health.js`.
- High-rate data stays out of Postgres. A scoring ledger (a few rows/hour)
  is the only database write, and only after the owner approves the
  migration (§10 D4).

---

## 6. How we know it is better — the skill ledger

A claim of "more detailed than what is available" is only worth making if it
is scored. Four scores, each with a permanent baseline to beat:

| Score | Truth | Baseline (negative control) |
|---|---|---|
| Arrival timing of L1 discontinuities | sudden impulse in 1-s ground H + GOES | flat distance/speed delay |
| GEO field residual, ΔB at GOES-E/W | GOES magnetometer | quiet model alone (no driving) and persistence |
| Ground ΔH / dB/dt at each USGS station, +15…+60 min | the station | persistence and a Bz-only regression |
| Fused L1 Bz with one spacecraft WITHHELD | the withheld spacecraft | the other spacecraft's raw value |

Predictions are **locked before truth arrives** (the CME ledger's
`selectScorableLock` discipline: a lock issued after the observation is
never scored). Hindcast set first: Gannon (May 2024, MHD oracle exists),
St. Patrick's 2015 (replay bundle exists), plus quiet and moderate days from
`sw_geomag_dataset` so the scores are not storm-only.

---

## 7. Phases

Each phase ends on something visible and a node gate; none depends on an
unverified feed that an earlier phase did not settle.

- **B0 — Settle the feeds (days).** Candidate-list routes for L1 dual
  spacecraft + positions, GOES magnetometers, USGS 1-second. One production
  request each records field maps, cadence, frame (GSE vs GSM), and whether
  a 1-second L1 product exists. Real snapshots become fixtures (never
  hand-edited). *Output: this document's UNVERIFIED tags resolved.*
- **B1 — L1 done properly.** `frames.js`, `fuse-l1.js`, `spectrum.js`.
  Two-spacecraft fusion with σ, fault flags, band powers. Withheld-spacecraft
  score running on the archive. *Visible: a Bz trace with an honest error
  band and a "spacecraft disagree" flag.*
- **B2 — Propagation + flux.** `propagate.js`, `flux.js`. Phase-front delay
  to the live bow-shock nose; Φ̇_D (two estimators) with saturation.
  Timing score vs ground sudden impulses on the hindcast set. *Visible: "flux
  opening at the magnetopause now: N kV, arriving T min after L1".*
- **B3 — GEO anchor.** `geo-residual.js`, GOES ingest. Measured residual at
  two longitudes; first interior prediction-vs-measurement ledger.
- **B4 — Sheath transfer + the column estimator.** `sheath.js` fitted to
  SWMF; `column.js` with its OSSE gate; the shared provider. *Visible: the
  altitude ladder — every rung, tagged MEASURED / ESTIMATED / FORECAST.*
- **B5 — Ground at 1 s and the low rungs.** `ground.js`: Pc5, dB/dt,
  regional equivalent currents, F_PC from Φ̇_D − Φ̇_N, hand-off to the
  existing geoelectric kernel. FAC / Poynting model chosen and licensed.
- **B6 — Page + consumers.** `bz.html` (ladder as the hero, time on one
  shared axis, small multiples per rung, never a dual axis), the
  space-weather.html panel, a status-band row, and — only once the ledger
  shows skill — the engine's propagated Bz offered as a `SolarWindDriver`
  for the sims that already speak that contract.
- **B7 — Forecast extension.** Join the flux-rope provider's Bz(t) as the
  prior past the L1 horizon; score the joined forecast in the same ledger.

---

## 8. Honesty rules (binding on every surface)

1. Three tags, always shown: MEASURED · ESTIMATED · FORECAST.
2. A rung with no instrument never prints a value without its 1σ.
3. A dead feed widens the posterior and SAYS which feed; it never falls back
   to a quiet default (the "feeds down must look down" rule).
4. Gaps are gaps — no interpolation through a data gap, no differencing
   across one (`flux-rope-noise.js` already enforces this at L1).
5. No global map from regional data.
6. The two Φ̇_D estimators are shown side by side; their spread is
   uncertainty, not something to hide by averaging.
7. Marketing copy says "physics-propagated and instrument-scored", never
   "AI-powered" (CLAUDE.md §7).

---

## 9. Risks

- **The 1-second L1 product may not be public.** Then the L1 cadence gain is
  zero and the engine's edge is fusion + propagation + the column. Still
  worth building; the plan does not hinge on it.
- **Two spacecraft are often nearly co-located** relative to structure
  scale; the measured phase-front tilt will be poorly conditioned much of
  the time. Hence MVAB as the primary and the lag as a cross-check, with an
  explicit conditioning flag.
- **One of ACE / DSCOVR may be retired or degraded** as SWFO-L1 takes over.
  The rung-0 interface is N-spacecraft from the start for that reason.
- **14 ground stations, one continent.** Φ̇_N and equivalent currents are
  regional and coarse; INTERMAGNET/SuperMAG would fix it and are excluded by
  the standing licensing decision (TIGA_PLAN.md).
- **GOES arcjet firings and eclipse seasons** contaminate the magnetometer;
  the feed's flags must be honoured or the ledger scores thruster noise.
- **Filter over-confidence.** Mitigated by the OSSE gate; expected, and
  pinned rather than tuned away.

---

## 10. Owner decisions needed

- **D1 — Scope of "flux".** This plan reads it as magnetic flux transport
  (Φ̇_D, F_PC) plus energy flux. If energetic-particle flux by altitude was
  meant as well, that is a second engine sharing the ladder — say so.
- **D2 — External field model at GEO.** T89c (simple, Kp-driven, public
  domain code) first, or go straight to a solar-wind-driven model?
- **D3 — Keep 1-second history?** Live-only ring buffer (zero storage), or
  R2 day files (~tens of MB/day) so the ledger and hindcasts can use it.
- **D4 — Ledger storage.** A small service-role-only table (new migration,
  author's go required) vs R2 JSON only.
- **D5 — Nav slot.** Space Weather menu is at its cap; hub-only, or displace
  an entry.
- **D6 — Audience.** Operator-first (dB/dt, GIC precursors, GEO environment
  for satellite operators — fits the B2G wedge) or research-first (the
  ladder and spectra). It changes what `bz.html` leads with, not the kernels.

---

## 11. B0 — what the feeds actually are (MEASURED 2026-11-20)

One `meta=1` request per feed against a Vercel preview of this branch (edge
region iad1). The swpc JSON files were NOT 403'd from the edge on this
occasion; the WAF caveat in `api/health.js` still stands, so the browser-direct
path through the same module remains the fallback.

| Feed | Result |
|---|---|
| `l1-mag` | `json/rtsw/rtsw_mag_1m.json` — **three spacecraft: `SOLAR1` (active), `IMAP`, `ACE`. No DSCOVR.** 1-minute, 24 h, GSM and GSE both published. 1383 of ~1437 minutes have a valid Bz on at least two spacecraft. IMAP's time tags are off the minute (…:02, …:03). |
| `l1-ephem` | `json/rtsw/rtsw_ephemerides_1h.json` — hourly, **km**, GSE + GSM + GCI positions and velocities, ~31 days, the same three spacecraft. |
| `geo-mag` | primary = **GOES-19**, secondary = **GOES-18**, 1-minute, He/Hp/Hn/total + `arcjet_flag`. GOES-19 carried **74 arcjet-flagged minutes in 24 h**. |
| `ground-1s` | USGS serves `sampling_period=1` variation data in real time. X/Y were **129 s** behind the clock and Z **73 s**, identically at BOU and FRD; the 60 s product was 147 s behind. |
| `l1-mag-fast` | All four guessed names are **404**. That rules out those names only. Still open. |

Dropped candidates: `products/solar-wind/mag-2-hour.json`, `mag-1-day.json`
and `ephemerides.json` (404); `json/ace/mag/ace_mag_1h.json` (hourly — no use
at this cadence).

Spacecraft positions at 14:00 UT that day (GSE, R_E):

| | x | y | z |
|---|---|---|---|
| ACE | 230.3 | +41.0 | +22.0 |
| IMAP | 227.7 | −36.8 | −5.7 |
| SOLAR1 | 225.0 | −48.1 | −18.3 |

Pairwise: ACE–IMAP 82.7 R_E, ACE–SOLAR1 ~98 R_E, IMAP–SOLAR1 ~17 R_E. All
three sit within ~5 R_E of each other ALONG the Sun–Earth line and are spread
almost entirely ACROSS it.

`SOLAR1` is SWPC's own tag. It is presumably SWFO-L1 under its operational
name — NOT confirmed here; confirm before any page prints a mission name.

### What this changes

1. **§4.2 is a three-point problem, and a better one.** Three spacecraft
   spread across the flow form a triangle whose plane is nearly perpendicular
   to the Sun–Earth line. Two independent arrival-time lags give the
   phase-front normal's two transverse components directly — a measurement,
   where two spacecraft gave only one component and MVAB had to supply the
   rest. MVAB becomes the cross-check instead of the primary (§4.3).
2. **The baselines are very unequal** (17 vs 83–98 R_E). The short one
   measures small-scale structure and instrument agreement; the long ones
   measure front tilt. `fuse-l1.js` must weight by baseline, not treat the
   three as interchangeable.
3. **DSCOVR is gone from the feed.** Every "ACE + DSCOVR" in §1–§9 reads
   "the spacecraft in the file". The N-spacecraft interface (§9) was the
   right call; nothing may hard-code a spacecraft name.
4. **The withheld-spacecraft score (§6) gets stronger**: withhold one, fuse
   the other two, score against the third — for each of the three.
5. **Align by instant.** IMAP's off-minute tags mean no code may join the
   three streams by array index or by time-tag string.
6. **Arcjet flags are routine**, not rare (5 % of GOES-19's day). The GEO
   ledger must exclude them from the start, and the engine should expect
   to lose one longitude for an hour at a time.
7. **1-second ground data is live** with a ~2-minute horizon. The timing
   score against sudden impulses (§4.3, §6) can run in near real time, and
   §10 D3 (keep 1-second history?) is now a real decision, not a
   hypothetical.
8. **No sub-minute L1 product found.** §4.1's L1 cadence gain stays zero
   for now; the L1 detail comes from three spacecraft instead of from
   seconds. Places still worth one look: the IMAP I-ALiRT service and NCEI.

### Still open from B0

- Real fixtures. `node scripts/probe-bz-feeds.mjs --save` (from a machine
  with open network) writes the raw upstream bodies to `tests/fixtures/bz/`;
  the gate's payloads are still SYNTHETIC, shaped on the measured schema.
- The plasma file (`rtsw_wind_1m.json`) per spacecraft — B2 needs speed and
  density for each of the three, and nothing has checked whether that file
  carries all three as well.
- GOES satellite longitudes (needed to rotate E/P/N into GSM in B3) are not
  in the magnetometer file.
