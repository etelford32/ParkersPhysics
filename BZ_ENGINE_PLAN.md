# BZ_ENGINE_PLAN.md — the Bz analysis engine

> **Status (2026-11-20): B0–B6 BUILT and run on real data.** Feeds settled
> (§11); L1 fusion `/api/bz/l1` (§12); propagation + flux `/api/bz/flux`
> (§13); GOES residual + ledger `/api/bz/geo` (§14); the altitude ladder
> `/api/bz/column` + provider (§15); ground at 1 s + ring current
> `/api/bz/ground` (§16); the page `bz.html` (§17).
> **Read §12–§17 before §4. On the one real day looked at — a quiet one —
> most PREDICTIVE claims in §4 scored at or below their controls**: lag
> alignment did not beat the naive mean, the fixed GEO formula lost to a
> nominal wind, the learning GEO filter lost to 30-minute persistence. The
> one that looked ahead — Dst from the arrived wind — is NOT robustly so:
> +0.29, +0.27, +0.18 and then −0.06 across four runs the same afternoon. What
> held up everywhere is the MEASUREMENT side and the honesty of the error bars
> (61–69 % coverage of a stated 1σ). Those are measurements with their numbers
> recorded, not tuning problems, and nothing below has been tuned to hide
> them — the page prints the same verdicts. Sections 1–9 are the original
> plan; where they disagree with §11–§17, the later sections win. Open
> decisions and what is still not built: §18.
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

---

## 12. B1 — the L1 rung (BUILT; first real day MEASURED 2026-11-20)

`js/bz/frames.js` · `fuse-l1.js` · `spectrum.js` · `l1-analysis.js` ·
`/api/bz/l1[?summary=1]` · gate `node tests/bz-l1.mjs` (22 checks, against a
planted tilted solar wind).

**What it does.** Puts every spacecraft on one minute axis by instant;
measures the arrival-time lag of each pair by cross-correlating all three
field components over a trailing 180 min, re-estimated every 30 min from past
data only; reconstructs each spacecraft from the others (the withheld score);
fuses them in the active spacecraft's frame with 1/σ² weights; flags and
excludes a spacecraft the others contradict.

**On the planted wind it works** (36° front, 0.25 nT noise): lags recovered to
< 0.6 min, the far spacecraft predicted to 0.64 nT against 3.97 nT for the
unshifted mean, fused error 0.17 nT against 0.25 nT for one spacecraft, a
12 nT single-spacecraft glitch flagged on 19 of 20 minutes and attributed to
the right spacecraft.

**On the first real day it did not beat the naive mean.** 24 h ending
2026-11-20 14:54 UT — quiet: σ_bg 0.74 nT, Bz median −0.9 nT, 378 km/s.

| Spacecraft withheld | n | RMSE aligned | RMSE unshifted | skill | 1σ coverage |
|---|---|---|---|---|---|
| SOLAR1 | 1349 | 1.16 nT | 1.15 nT | −0.02 | 66 % |
| IMAP | 1172 | 0.99 nT | 0.98 nT | −0.03 | 64 % |
| ACE | 1327 | 1.38 nT | 1.36 nT | −0.02 | 66 % |

- A lag passed the correlation floor on only **35 %** of steps for the 17 R_E
  pair and **4–13 %** for the two ~80–98 R_E pairs. Peak correlations sat at
  0.47–0.56 — inside or barely above what two unrelated red-noise series
  reach (the floor, 0.65, was set from that null distribution).
- So for most of the day the three spacecraft were NOT seeing the same
  structure at different times; they were seeing different fluctuations.
  Predicting one from the others misses by ~1.0–1.4 nT, more than the day's
  own background scatter.
- **The error bar is honest**: the stated 1σ covered 64–66 % of residuals
  (68 % is the target), on real data, out of sample.
- 32 minutes were flagged "one contradicted", spread over all three
  spacecraft (10/13/9) — on a day this incoherent that is transverse
  structure, not instrument faults. The flag cannot tell them apart when the
  spacecraft are decorrelated, and must not be read as a fault count.
- Frame check: our GSE→GSM angle is 0.47–0.55° from the one the feed uses,
  consistently the same sign across three runs. Small (0.9 % of By leaking
  into Bz); probably a different dipole epoch upstream. Not resolved.

**What this means for the plan.** §4.2's claim holds for COHERENT structure —
shocks, CME sheaths and ejecta, sector boundaries, the events that matter —
and has yet to be seen on real data because none occurred. On a quiet day the
honest product of three spacecraft is (a) a measured transverse decorrelation,
which is itself a number nobody publishes, and (b) a calibrated error bar on
"Bz at L1" that is ~1 nT, not the instrument's 0.1 nT. The engine reports
both. **The withheld score must be re-read on the first disturbed day before
B1 is called a success.**

Two defects the gate caught before anything shipped, both now pinned:
the lag search read up to 45 min past its window (a look-ahead that made the
"causal" track non-causal), and the first contradiction test could not
attribute a glitch because the bad spacecraft dragged every other residual to
half its own size.

Not built in B1: no page. The plan's "visible" trace is `/api/bz/l1`'s
`trace` (JSON) until B6.

## 13. B2 — propagation and flux (BUILT; first real day MEASURED 2026-11-20)

`js/bz/propagate.js` · `flux.js` · `flux-analysis.js` · the `l1-plasma` feed ·
`/api/bz/flux[?summary=1]` · gate `node tests/bz-flux.mjs` (17 checks).

**What it does.** Every delay is r·m for a slowness vector m with V·m = 1.
m comes from the measured multi-spacecraft lags when at least two pairs
passed; otherwise the flat delay. The target is the bow-shock nose from
`geospace.js` at the parcel's own dynamic pressure. The reconnection rate is
Milan et al. 2012 in kV, with Newell et al. 2007 beside it and a Siscoe–Hill
saturated potential. Rows are ordered by arrival time and tagged ESTIMATED
(arrived) or FORECAST (still in transit).

**On the planted wind:** a 36° front is delivered to the nose in 46 min
against a true 45.9; the flat delay says 56.

**A finding about the real geometry.** Across the flow the three spacecraft
form a triangle 97.8 R_E long and 6.8 R_E high, so one component of the front
normal is poorly fixed (0.5-min lag noise → 6.7° median error). But the
Sun–Earth line passes 3.1 R_E from the line through the spacecraft, so the
delay to Earth depends almost only on the well-fixed component: the same
noise moves it 0.22 min rms. Trust the delay; read the tilt as rough. This is
a property of where the halo orbits are THIS season — `condition` is reported
so it can be watched.

**On the first real day** (same 24 h):

- Plasma feed settled: all three spacecraft at 1 min; velocity COMPONENTS for
  SOLAR1 only.
- Wind: 378 km/s, 1.2–1.4 cm⁻³ (very thin), P_dyn 0.3 nPa → bow-shock nose at
  18.1–18.5 R_E, 4–5 R_E further out than nominal.
- Reconnection rate at the bow shock: **5.8 ± 4.5 kV** (Milan); Newell-scaled
  11.5 kV — the two functional forms differ by 2× at this weak, near-zero-Bz
  driving, which is exactly why both are shown. 0.024 GWb opened in the hour.
- Delay L1 → nose 58 min; the forecast horizon (delay minus data age) 54 min.
- Method: multi-spacecraft lags for only **133** minutes of the day (see §12:
  the lags were rarely measurable).
- **MVAB did not earn its place.** In the first run it was chosen for 600–800
  minutes with nothing checking it, so a check was added: wherever a pair lag
  WAS measured, what would the MVAB normal have predicted for that pair?
  Median error 5.52 min, against 5.72 min for the flat delay (n = 11). No
  demonstrated gain, so **MVAB is now off by default** (`useMvab`), still
  computed and still scored on every request.
- The same check says something else: when a lag IS measurable, the flat
  delay misses it by a median ~6 minutes. Fronts are tilted; the flat delay
  is not a safe default, it is just the only one available most of this day.

**Not verified / not built in B2 — do not lose these:**

1. **Siscoe–Hill coefficients are from memory.** The form was confirmed; the
   numbers (57.6, 0.0125, ξ = 4.45 − 1.08 log Σ) could not be checked against
   the paper from the sandbox. `SISCOE_HILL.verified` is false and every
   payload carries `coefficients_verified: false`. Check before any page
   prints a transpolar potential.
2. **Newell 2007 has no agreed conversion to volts.** The "scaled" column is
   normalised to Milan at 400 km/s, −5 nT; it shows functional form only.
3. **The timing score against ground sudden impulses (§6 row 1) is NOT
   built.** It needs the 1-second ground stream and a sharp pressure jump to
   occur; it belongs with B5. Until then the only real-data check on
   propagation is the pair-lag check above.
4. **The sheath is not modelled.** The rate uses the upstream field and the
   delay stops at the shock nose; B4.
5. 96 minutes were dropped as "overtaken". Some are real (speed changes);
   some are an artefact of the method switching at 30-minute step boundaries
   and moving the delay discontinuously. Not separated yet.
6. Only one production day has been looked at, and it was quiet.

---

## 14. B3 — the geosynchronous rung (BUILT; first real day MEASURED 2026-11-20)

`js/bz/geo-residual.js` · `geo-analysis.js` · `/api/bz/geo[?summary=1]` ·
gate `node tests/bz-geo.mjs` (10 checks).

**The measurement works, and the data confirm the frame.** GOES publishes
E (earthward) / P (spin axis) / N (east). IGRF at the two NOMINAL slots, in
that frame, against the magnetometers:

| | He meas / IGRF | Hn meas / IGRF | Hp meas / IGRF |
|---|---|---|---|
| GOES-19, 75.2°W | 32.6 / 31.9 | 0.4 / −0.8 | 100.4 / 98.1 |
| GOES-18, 137.2°W | 14.4 / 13.2 | 14.1 / 16.1 | 91.4 / 101.3 |

He and Hn agree to 1–2 nT; swapping the two slots misses He by ~18 nT and
flipping E's sign by > 50 nT — so the convention and the longitudes are
settled by the instrument, with no position in the file. Over 7 days the
median |residual| of He and Hn is 1.0–2.5 nT. No GSE/GSM chain is involved.

- The Hp residual (measured − IGRF) is the signal: over 7 days it has a mean
  level of about **−11 nT** and a **±21 nT** local-time swing (noon high,
  midnight low) on BOTH satellites.
- Arcjets: GOES-19 had 148 flagged minutes in 7 days (188 excluded with the
  10-minute guard); GOES-18 none.
- The Hp daily maximum falls 0.5–0.6 h before local noon on both satellites.

**The first ledger FAILED.** Prediction: the magnetopause-current field
(uniform + sunward-gradient terms) at the Shue standoff of the wind that has
arrived. Control: the same formula at a nominal wind.

| | RMSE live wind | RMSE nominal wind | skill | r |
|---|---|---|---|---|
| GOES-19 | 9.8 nT | 7.2 nT | **−0.85** | 0.79 |
| GOES-18 | 9.5 nT | 6.9 nT | **−0.89** | 0.87 |

Why: the wind that day was very thin (0.3 nPa), so the live standoff was
~13.6 R_E and the formula predicted a SMALL daily swing — while the observed
swing was ±21 nT, because most of the day–night asymmetry at 6.6 R_E is the
TAIL current, which the formula omits. The nominal wind "wins" by accident: a
closer magnetopause gives a larger swing that happens to resemble the tail's.
The correlation (0.8) is the shared local-time shape, not skill. The response
lag could not be measured (the driven part anti-correlates, −0.45 to −0.69,
which is the same confound). **A fixed magnetopause-current term is not a
model of the field at geosynchronous orbit**, and typing in more coefficients
from memory (the two used here are already UNVERIFIED) is not the fix.

## 15. B4 — shock jump, learning filter, the ladder (BUILT; MEASURED 2026-11-20)

`js/bz/sheath.js` · `geo-filter.js` · `column.js` ·
`js/bz-engine-provider.js` · `/api/bz/column` · gate
`node tests/bz-column.mjs` (9 checks, incl. an OSSE).

**The ladder exists.** One object, ten rungs, each tagged MEASURED /
ESTIMATED / FORECAST / NOT_BUILT / NOT_AVAILABLE with σ, basis and caveats.
On the real day at 15:22 UT:

| Rung | Kind | Bz (GSM) / value |
|---|---|---|
| L1 (SOLAR1, 3 of 3 spacecraft) | MEASURED | −0.66 ± 0.36 nT |
| Bow-shock nose, 18.4 R_E | ESTIMATED | −0.30 ± 0.43 nT (seen at L1 58 min earlier) |
| …same, newest arrival | FORECAST | −0.66 nT, 54 min ahead |
| Magnetosheath at the shock | ESTIMATED | −0.86 nT (×2.9; M_fast 3.1, β 0.36) |
| Subsolar magnetopause, 13.6 R_E | ESTIMATED | 2.6 ± 3.2 kV opening (Newell-scaled 6.8) |
| Geosynchronous, GOES-19 / -18 | MEASURED | Hp residual +9.5 / −2.5 nT |
| Ring current · LEO · E-region · ground · below ground | NOT_BUILT | — |

**What is NOT in B4, against the plan:**

1. **The SWMF-fitted sheath transfer is not built.** The repository holds no
   MHD magnetosheath output to fit (`swmf/fixtures` carries polar-cap
   potential and hemispheric power only). `sheath.js` is the EXACT
   perpendicular-shock jump at the nose — no fitted number — and is a LOWER
   bound on the field at the magnetopause. Pile-up, sheath transit time and
   everything off the nose are missing and named in its header. To build the
   real thing: export B, ρ, v along the stagnation line from a BATS-R-US run.
2. **The "one posterior for the whole column" of §4.8 is not built.** With
   the interior transfer functions failing their first test (§14), a joint
   filter would have been built on kernels known not to predict. What exists
   is `column.js` (an ASSEMBLY — it computes nothing) plus one real
   sequential estimator at the one interior rung that has an instrument.

**The learning filter, and its real-data score.** `geo-filter.js` is a Kalman
filter whose STATE is six coefficients: a level, two local-time harmonics,
and one gain on √P_dyn of the arrived wind. It predicts 30 minutes ahead and
is scored against persistence and against itself with the gain pinned at 0.

In the OSSE it recovers a planted gain (12.2 vs 12) with skill 0.93 over the
harmonics-only control, a scrambled driver earns nothing, and it is causal to
the bit. On 7 days of real GOES data:

| | RMSE filter | RMSE harmonics-only | RMSE persistence (30 min) | 1σ coverage |
|---|---|---|---|---|
| GOES-19 (n 9460) | 4.74 nT | 4.45 nT | 4.34 nT | 66 % |
| GOES-18 (n 9709) | 4.69 nT | 4.49 nT | 4.33 nT | 61 % |

- **It loses to 30-minute persistence** (skill −0.19, −0.17) and to its own
  no-wind control (−0.13, −0.09).
- The learned gain is −0.3 ± 2.0 and −0.7 ± 2.0 nT/√nPa — **consistent with
  zero**. Only ~1300 of the 10 000 minutes had a driver at all (the L1 files
  are 24 h; the GOES files are 7 days), and on that day the driver barely
  moved. The gain cannot be learned from one quiet day.
- The level and swing it learned (−11 nT, ±21 nT) are real and stable, and
  its stated 1σ covered 61–66 %.

So at geosynchronous orbit the engine currently MEASURES well and forecasts
no better than "it will be what it was half an hour ago". That is the honest
state. What would change it, in order of expected value:
  (a) more than 24 h of L1 history to learn the gain over — our own
      `sw_geomag_dataset` holds ~4 months of minute L1 data (read through
      `api/_lib/sw-geomag-store.js`), which a ROUTE can join to the 7-day
      GOES record; the 24 h limit is the SWPC file's, not ours;
  (b) a disturbed day — a pressure pulse or a southward turning is when a
      wind-driven term can beat persistence at all;
  (c) a tail-current driver (the midnight sector responds to loading and
      unloading, not to √P_dyn);
  (d) scoring at 60–90 minutes, where persistence weakens and the L1 lead
      still covers the forecast.

**Reused, not forked:** `flux.js` now delegates Newell to
`js/ring-current-model.js` `newellCoupling` (B2 had written a second copy;
only the gap rule differs and the gate pins that).

**The provider** (`js/bz-engine-provider.js`) is the one way a page gets the
column: one poll loop per page, `window.__bzColumn` + a `bz-column` event, a
failed fetch published as DOWN with the last good column marked stale. No
page consumes it yet (B6).

---

## 16. B5 — ground at one second, and the ring current (BUILT; MEASURED 2026-11-20)

`js/bz/ground.js` · `ground-analysis.js` · `api/_lib/bz-ground-fetch.js` ·
`/api/bz/ground[?summary=1]` · gate `node tests/bz-ground.mjs` (12 checks).

**Two production failures before it read a single sample — both now pinned.**

1. *28 requests at once, no reason attached.* The first run reported every
   station down and could not say why. The fan-out is now capped at 6 in
   flight and every failure is DESCRIBED (HTTP status / timeout / not JSON /
   no usable samples) in `upstream.usgs`.
2. *The payload was readable; our reader was not.* With diagnostics on, all
   28 responses were well-formed JSON that normalised to nothing. USGS puts
   station coordinates at **`metadata.intermagnet.imo.coordinates`**, and the
   reader looked only at `metadata.station.geometry.coordinates`.
   `groundCoordinates` now resolves from a candidate list and the route
   reports which one answered; an unreadable payload is described by
   STRUCTURE (keys only).

**The same bug was live in an existing route.** `/api/geomag/observatories`
— TIGA's live nowcast and the Inner Earth geoelectric panel — made the same
single-layout assumption and answered **503 "No USGS observatory returned
data"** on the preview while USGS was healthy. It now uses the same
`groundCoordinates`. How long it had been failing in production is NOT known
from here; `tiga.html` and `earth-interior.html` should be looked at once
this is deployed.

**First real hour (14 stations, all at 1 s, 167 s behind the clock):**

- **dB/dt.** Network peak 0.63 nT/s. Read as a one-minute product the same
  record gives 0.029 nT/s. Per station the minute product under-reads the
  1-second rate by a **median factor of 8** (range 4–21) — on a quiet day,
  where much of the 1-second rate is small fast fluctuation. The plan's
  "several-fold" claim holds as a measurement; what it will be in a storm is
  not yet known.
- **A bad record.** FRN read −2766 nT against its 24 h median — a baseline
  step, not geophysics — and owned the network peak. A station past
  `suspectDeltaNt` (1500 nT) is now flagged, shown, and kept out of every
  network-level number.
- **Electrojet proxy** (BRW, CMO, DED, SIT ≥ 60° dipole latitude): −8 / +3 nT.
  Quiet. Labelled a regional proxy, not AL/AU.
- **Sudden impulses: none. Predicted pressure jumps: none.** So the timing
  score — the one real check on propagation (§6 row 1) — has still never
  scored. It reports `no_events_in_window` rather than a pass.
- **Ring current: ahead on three runs, level on the fourth — so, not shown.**
  The site's own Dst model (O'Brien–McPherron, `integrateDst`) driven by the
  ARRIVED wind, anchored once and free-run for ~22 hours, against
  persistence:

  | run (UT) | anchored | hours | model rmse | persistence | skill |
  |---|---|---|---|---|---|
  | 15:42 | 17:00 | 22 | 6.83 nT | 8.09 nT | +0.29 |
  | 15:51 | 17:00 | 22 | 6.91 nT | 8.09 nT | +0.27 |
  | 16:01 | 17:00 | 22 | 7.35 nT | 8.09 nT | +0.18 |
  | 16:14 | 18:00 | 21 | 6.55 nT | — | **−0.06** |

  When the 24-hour L1 window rolled forward one hour the anchor moved, and
  the advantage vanished. With ~21 hourly points and ONE anchor, the score
  is dominated by where the anchor happens to fall. This is not a result in
  either direction; it needs many anchors over many days (§18).
- **After the fixes, on real data:** `/api/geomag/observatories` returns 14
  of 14 stations; the column's ground rung reads 14 stations (13 at 1 s — one
  1-second request timed out and is named), leaves FRN out as a bad record,
  and reports a network dB/dt peak of 0.505 nT/s at CMO against 0.099 nT/s
  as a minute product.

**Bugs the gate caught:** the pressure-jump detector timed every jump 3 min
early (first threshold crossing), then 2 min early (a difference of medians
is a plateau, not a peak); it now takes the apex of a difference of means.

**Not built, against the plan's B5:**

- **F_PC (open polar-cap flux).** Needs a nightside closure rate; no
  verified formula was available and none was invented.
- **A FAC / Poynting model at LEO.** Not chosen: the candidate empirical
  models carry licence terms that could not be checked from here.
- **Equivalent currents as a map.** Per-station vectors only (infinite-sheet,
  sign checked against a Biot–Savart integration). Fourteen stations on one
  continent do not support a map and none is drawn.
- **The geoelectric field at 1 s.** The existing kernel is validated at
  1-minute cadence with a 4-hour warm-up; it was NOT run on the 1-second
  series. The ladder's bottom rung is DELEGATED to the existing nowcast.
- **1-second history.** Nothing is stored (§10 D3 is still open).

## 17. B6 — the page (BUILT 2026-11-20)

`bz.html` · `js/bz-page.js` · `js/bz/page-model.js` (PURE) · gate
`node tests/bz-page.mjs` (5 checks). Filed in `js/simulations-catalog.js`
(Space Weather → Geospace response), so it is on the hub and the catalogue;
it is NOT in the nav menu (the menu is at its cap).

- **The ladder is the hero**: ten rungs, each with a DRAWN mark and a word
  (measured / estimated / forecast — the half-circle glyph is missing from
  common system fonts, so the marks are CSS), a headline with its error bar,
  and a fold-out that says where the number comes from and what it omits.
  Fold-outs keep their open state across the once-a-minute re-render.
- **Three small multiples on one time axis** (3 h back, 1¼ h ahead) with one
  crosshair: Bz at L1 (each spacecraft + the fused line and its 1σ band),
  flux opening by arrival time (solid arrived, dashed in transit), the GOES
  residual beside its 30-minute-ahead prediction. Never a second y scale.
  Charts are drawn at the column's real pixel width (a scaled viewBox made
  ticks ~3 px on a phone); the categorical colours are the three validated
  all-pairs slots, identity only.
- **The scorecard** prints every scored prediction beside its control with
  ahead / level / behind / not scored. Skill within ±0.05 is "level". On the
  real first day that reads: L1 fusion level, GEO filter behind, Dst ahead,
  timing not scored.
- The renderer computes NO physics (gated by source text); the column comes
  only through `js/bz-engine-provider.js`.

**Verified how:** driven in Chromium at 1440 px and 390 px against planted
data — ten rungs, three charts, hover readout, no horizontal overflow.
**Not verified:** no Playwright spec is committed (the repo's test runner is
not installed in the build sandbox). Since B7 the page HAS been looked at on
real feeds — see §19.

**Not built, against the plan's B6:** the space-weather.html panel, the
status-band row, and the propagated Bz as a `SolarWindDriver` (deliberately
withheld — the ledger has not shown skill).

## 18. Where this stands, and what decides the next step

Built: feeds, L1 fusion, propagation, flux, GEO residual + filter, the
ladder, ground at 1 s, ring current, the page. All gated (103 node checks in
eight files).

**Still unverified — do not print as fact:** Siscoe–Hill saturation
coefficients; Mead magnetopause-current coefficients; `SOLAR1` = SWFO-L1.

**Still open from §10:** D1 (does "flux" include particles), D3 (keep
1-second history), D4 (ledger storage — nothing is stored today; every score
is recomputed from the feeds' own windows), D6 (operator- or research-first).
New: the licence check for a FAC model at LEO.

**The recommendation from §15 stands and is now the main thing.** Every
verdict above comes from ONE quiet day. Our own archive (`sw_geomag_dataset`
through `api/_lib/sw-geomag-store.js`) holds about four months of minute L1
data and certainly contains disturbed days. Running the GEO filter, the Dst
model and the propagation against that record is what turns "level on a
quiet day" into an answer — and it needs D4, because scores over months
cannot be recomputed per request.

## 19. B7 — the forecast past the L1 horizon, and the stage (BUILT 2026-11-20)

**The join** (`js/bz/forecast-join.js`, PURE, no imports;
`tests/bz-forecast-join.mjs`, 9 checks on the real flux-rope WASM). Past the
last minute L1 has measured, the only thing this site can say is what the
flux-rope provider says about a CME in flight. The module joins that on and
adds nothing:

- Measurement wins: the rope is never drawn or blended inside the L1 horizon.
- The rope's Bz(t) is at L1; it is moved to the bow shock by the engine's
  CURRENT delay (a caveat on every joined result: inside a fast CME the real
  delay is shorter).
- No rope, no forecast. `no_rope` / `train_passed` / `rope_down` / `pending` /
  `rope_beyond` are five different statuses and none draws a line.
- **The rope is silent about ordinary wind.** Before any ensemble member has
  the CME at L1 the fan is a zero-width line at 0 nT. The first build drew
  that as a flat "forecast" of calm and scored it (0 % coverage, skill
  exactly level) — both wrong. Those steps are now a gap (`silentSteps`) and
  are not scored.
- The seam between the L1-based forecast and the rope is reported (step, and
  whether L1 is inside the rope's 5–95 % band), never smoothed.
- **The score uses the UNCONDITIONED prior** (`scoreRope`), against the fused
  L1 field, beside "no CME, Bz = 0". The provider's `fan` is conditioned on
  that same L1 record, so its error is returned labelled in-sample and never
  produces a verdict (gated with a swap control).

It runs in the browser: `bz-page.js` starts the ONE provider
(`js/sun-flux-rope.js startFluxRopeProvider`) and listens for
`flux-rope-forecast`. Nothing server-side changed and no route was added.
"Scored in the same ledger" means a row on the page's scorecard; there is
still no stored ledger (D4).

**The stage** (`js/bz/planet-view.js` PURE scene model →
`js/bz-planet-canvas.js` renderer; `tests/bz-planet.mjs`, 7 checks). A
noon–midnight cut, Sun on the left. Each arrow is one minute of wind L1 has
measured, placed where that wind is now (the engine's arrival time read back
as distance); the bow shock and magnetopause are `geospace.js` on the wind
the column says is at the shock; the tilt is `dipole.js`. What is not to
scale is owned by ONE function (`layout`) and printed under the canvas: true
scale within 30 R_E, a DERIVED compression from there to L1, and — only when
a CME forecast exists — a time axis left of L1 holding hollow arrows and the
5–95 % band. No wind at the shock ⇒ no boundary is drawn; no L1 ⇒ nothing
upstream. The renderer may not contain a boundary formula or a trig call
(source-text gated).

**Seen on real data (2026-11-20 18:33 UT, replayed into a local copy of the
page because the sandbox cannot reach the preview):** 30 parcels in transit,
all south at −1 to −2.5 nT; standoff 13.09 / shock nose 17.85 R_E matching
the column; no CME in flight, so today the fourth readout says so and the
outlook chart is hidden. The joined state has only been seen with a PLANTED
CME (a test fixture, not an event).

**Found while looking, fixed the same day:** FRN read −245 nT and 2.645 nT/s
while the nine other low/mid-latitude stations read 0–15 nT. That is under
the 1500 nT absolute threshold, so it became the network's headline dB/dt
and the strongest E-region current. `flagNeighbourOutliers` (ground.js) now
flags a LOW/MID-latitude station standing above the median of the others by
more than max(100 nT, 8 robust σ of the others); it needs ≥ 4 comparable
stations and never judges an auroral or sub-auroral one. Gated on the real
18:33 UT values (only FRN is flagged; a planted storm and an auroral bay are
not). It cannot tell a bad record from a real disturbance confined to one
low-latitude station, and it has NOT been tested on a real extreme storm,
when the oval reaches these latitudes. Not yet confirmed on the preview.
The Dst model's fifth run scored −0.67.

**Not built:** a Playwright spec; the space-weather.html panel; the stored
ledger. The join has never been scored on a real CME.

