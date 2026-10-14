# CME Outlook — projecting past the launched-CME horizon

Status: **Phase A shipped (2026-10-14)**. Companion to
`CME_FORECAST_VALIDATION_PLAN.md` (the arrival ledger) and
`FLUX_ROPE_SIMULATOR_PLAN.md` (the kernel). Code: `js/cme-outlook.js` (pure),
`js/cme-outlook-response.js` (baked table), `js/cme-source-prior.js`.

## 1. The horizon problem

The cme-forecast.html calendar plots issue-locked ARRIVAL forecasts. Those
exist only after a CME has launched, so their lead time is the transit:
about 1–4 days. Physics caps it, and no model changes that.

Past that horizon the honest product is a different quantity: the
**probability that an Earth-impacting CME arrives on day D, from an eruption
that has not happened yet**. It is never an arrival time, it is never
plotted as a chip, and it never touches the arrival ledger.

| Horizon | What carries the skill | Status |
|---|---|---|
| 0–4 d | Launched CMEs → flux-rope kernel → ledger | shipped |
| 0–4 d, Bz | Source-region rope orientation (§3) | shadow model, scoring |
| 1–7 d | Eruption outlook: visible regions × flare rate × CME association × kernel response (§4) | **Phase A** |
| 3–14 d | Far-side regions rotating on (`js/farside/*`) feeding §4 | Phase B |
| 5–27 d | Coronal-hole recurrence (`holeArrivalForecast`) | overlaid on the strip (Phase A), scored by the `recurrence` study |
| > 27 d | Solar-cycle climatology only | say so |

## 2. Rules (each is a decision, not a default)

1. **Separate model, separate ledger.** `model_id = 'cme-outlook-v0'`, its
   own table (`cme_outlook_issues`). It never writes `cme_arrival_forecasts`
   and nothing in it moves a number on an arrival chip.
2. **Separate visual language.** Probability shading on a strip, labelled
   "from eruptions that haven't happened yet". Never an arrival chip.
3. **Scored as probabilities.** Brier score per lead day against two
   baselines: climatology (the ledger's own base rate of observed arrivals
   per day) and, later, SWPC's 3-day forecast. **If it cannot beat
   climatology it is not a forecast**, and the page must say so once the
   record exists.
4. **Coverage is disclosed.** Phase A sees only the regions on the disc now.
   New regions emerge and far-side regions rotate on, so later lead days are
   LOWER BOUNDS. The strip says so on days 4–7.
5. **No new propagation physics.** Synthetic CMEs go through the same
   flux-rope kernel (via the baked response table) with the same
   `donkiToPreset` priors as a real DONKI CME.

## 3. Audit: rope orientation on the live path (2026-10-14)

`donkiToPreset` seeded every rope with `ROPE_DEFAULTS` (tilt 0°, H +1) and
spreads σ_tilt 40°, p_flip 0.5. A coin-toss chirality around an ecliptic axis
gives a prior median Bz ≈ 0 for every CME: the forecast carried no Bz
information before L1 assimilation.

Fix, opt-in: `js/cme-source-prior.js` derives (γ, H) for a flare-associated
CME from Hale's law + Joy's law (`flare-geometry.js joyTiltRad`) + the
hemispheric helicity rule (p_flip 0.3 = that rule's ~70 % reliability). The
node gate checks the derivation against the committed WASM's own field.
σ_tilt stays 40° so only the CENTRE moves.

It is locked daily as the shadow model **`flux-rope-v1-src`** beside the
unchanged `flux-rope-v1`, and the `flux-rope` validation row carries
`metrics.shadow` (Brier hit/−10/−20 nT and min-Bz error, both models, same
events, same leakage-proof lock selection). **Switch the default only when
that comparison favours it over a meaningful sample** (≥ 10 scored events).

A falsifiable consequence worth watching: in cycle 25 the construction puts
the axial field **north in both hemispheres** (polarity and helicity both
flip across the equator). If real cycle-25 ropes show southward axes, the
prior is wrong and the ledger will show it.

Known limitation: the kernel flips H independently of γ (spec §7); under the
construction a wrong chirality also reverses the axis. Expressing that
coupling needs a Rust change (a "flip both" mode). Follow-up.

## 4. Phase A model chain (`js/cme-outlook.js`)

For each visible NOAA region r (latest report, `hero-sun-model.latestRegions`)
and flare band c ∈ {M, X}:

- **Flare rate.** SWPC's own 24 h probabilities, as published, turned into
  Poisson rates (`rateFromDailyProbability`). M band = rate(p_M) − rate(p_X),
  treating SWPC's M probability as "M or greater" (conservative). The rate is
  held constant over the horizon (persistence). Disclosed.
- **CME association.** P(CME | flare): M 0.49, X 0.90 (Yashiro et al. 2006,
  approximate). Disclosed constants.
- **CME speed.** Log-normal around a class median (M 650, X 1200 km/s,
  σ_ln 0.45), representative of the LASCO catalogue relation; a fitted
  relation is Phase B.
- **Geometry.** The region's longitude at launch time by synodic differential
  rotation (`regionAt`); CME direction = source location (no deflection).
  Regions past ±90° contribute nothing.
- **Response.** `js/cme-outlook-response.js`: for a grid of (lon, |lat|, v0),
  the kernel ensemble's P(rope hit), arrival quantiles given a hit, and
  P(min Bz < −10 nT) — sheath included, so it can exceed P(hit): a flank
  pass the rope misses still drags its sheath over L1. Baked by `scripts/build-cme-outlook-table.mjs`
  through `donkiToPreset` (half-angle 40°); `tests/cme-outlook.mjs`
  recomputes sample cells against the WASM so a kernel change fails the gate
  until the table is re-baked.

Superposition: expected Earth-arriving CMEs on day D,
μ_D = Σ_r Σ_c ∫ λ_rc · p_cme,c · P(arrive in D | launch t) dt, and
P(≥ 1) = 1 − e^(−μ_D). Same for the geoeffective version (min Bz < −10 nT).

## 5. Locking and scoring (Phase A)

The daily validation cron (`api/cron/validation-rerun.js`) issues one outlook
per UTC day into `cme_outlook_issues` (INSERT, duplicates ignored: the first
issue of a day is the record). Rows for valid days at least 2 days past are
resolved from `cme_l1_observations`: an arrival on day D whose CME launched
AFTER the issue time. A CME DONKI never flagged as Earth-relevant has no
observation row and is invisible to the resolver; that is disclosed.
Brier + climatology Brier per lead day are logged in the run line.

**`supabase-cme-outlook-migration.sql` is written but NOT applied** (needs the
author's go). Until it is, the cron logs `reason: 'table_missing'` loudly and
the rest of the run is unaffected.

## 6. Phase B and later

- Far-side regions (`farside-track` + flare-climatology base rate) as extra
  sources from their projected emergence day.
- Persistence decay fitted from the ledger instead of constant rates.
- Fitted flare-class → CME speed / width relation (the DONKI FLR ↔ CME
  pairs the cron already associates).
- Source-region prior in the response table, if `flux-rope-v1-src` wins.
- CME–HSS interaction (a CME riding a fast stream arrives early).
- SWPC 3-day forecast as the second Brier baseline.
