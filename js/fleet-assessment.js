/**
 * fleet-assessment.js — the Storm-Season Fleet Assessment's decay kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no fetch, no WASM, no ambient time). It answers the three
 * questions the paid assessment sells, per spacecraft:
 *
 *   1. Quiet outlook — remaining lifetime and today's decay rate with the
 *      indices held at a stated baseline.
 *   2. Storm replay — fly a REAL historical Ap sequence (Feb-2022, Gannon)
 *      through the spacecraft's orbit today, and report the extra altitude
 *      lost during the event and the lifetime it costs.
 *   3. Exposure — the ratio of storm-peak to quiet drag at the spacecraft's
 *      own altitude, which is what a pre-storm alert quotes.
 *
 * The physics is NOT new: every rate goes through js/operations/msis-drag.js
 * (`orbitAverageRates`, `integrateDecay`, `makeRhoInterp`) — the same
 * NRLMSISE-00 orbit-averaged integrator the Operations console runs, so a
 * number in a sample report and a number on operations.html cannot disagree.
 * Density arrives through an injected `profileFor(f107, ap)` that returns the
 * msis-drag profile shape `{ alt0, step, rho }`.
 *
 * WHAT A STORM REPLAY IS (and the page says so):
 *   • Only Ap is replayed. F10.7 is held at the scenario baseline for the
 *     whole run, so the difference between "quiet" and "storm" is the
 *     geomagnetic storm alone — not whatever the solar cycle was doing that
 *     week in 2022 or 2024. "The same storm, arriving at your fleet today."
 *   • The density model is NRLMSISE-00 driven by the REAL 3-hourly Ap.
 *     It is an EMPIRICAL model and is known to under-respond at storm onset
 *     (that is the whole Feb-2022 story); a replay is therefore a LOWER
 *     bound on the storm penalty, never a claim of MHD-grade skill. The MHD
 *     claim waits on the hindcast gate in MHD_DENSITY_PRODUCT_PLAN.md.
 *   • The ballistic coefficient B = C_D·A/m is an assumption; storm altitude
 *     loss is ∝ B and lifetime ∝ 1/B to first order, so the ±σ_B band is
 *     analytic and is reported beside every number.
 *
 * Run `node tests/fleet-assessment.mjs` after ANY edit.
 */

import {
    orbitAverageRates, integrateDecay, makeRhoInterp, bstarToBallistic, parseBstar,
} from './operations/msis-drag.js';

export const RE_KM = 6378.135;          // WGS-72, the msis-drag / SGP4 datum
const MU_KM3_S2    = 398600.8;          // WGS-72
const HOUR_DAY     = 1 / 24;

/** Default drag coefficient for a free-molecular-flow small satellite. */
export const DEFAULT_CD = 2.2;

/**
 * Spacecraft classes the sample fleet and the interactive simulator offer.
 * Typical published masses; `areaM2` is the attitude-averaged mean
 * cross-section with deployed panels. ONE table — the bake and the page
 * both read it, and the page prints it as an assumption.
 */
export const SPACECRAFT_CLASSES = Object.freeze({
    '3u':    { label: '3U CubeSat',      massKg: 4.0,   areaM2: 0.020 },
    '6u':    { label: '6U CubeSat',      massKg: 10.0,  areaM2: 0.060 },
    '12u':   { label: '12U CubeSat',     massKg: 20.0,  areaM2: 0.080 },
    'micro': { label: '100 kg microsat', massKg: 100.0, areaM2: 0.600 },
    'small': { label: '250 kg smallsat', massKg: 250.0, areaM2: 1.500 },
});

/**
 * Historical storms the simulator replays. Ap is the real 3-hourly index
 * from dsmc/fixtures/hindcast/<dir>/historical_ap.csv (GFZ definitive via
 * CelesTrak SW-All — dsmc/pipeline/fetch_indices_offline.py). Never add a
 * synth_* fixture here: those are constructed scenarios, not history.
 */
export const STORM_EVENTS = Object.freeze([
    { key: 'feb2022',    dir: 'feb_2022_starlink',   label: 'Feb 2022 · Starlink storm', scale: 'G1–G2' },
    { key: 'stpatrick',  dir: 'st_patrick_mar_2015', label: 'Mar 2015 · St. Patrick’s Day', scale: 'G4' },
    { key: 'oct2024',    dir: 'october_2024',        label: 'Oct 2024',                  scale: 'G4' },
    { key: 'gannon',     dir: 'gannon_may_2024',     label: 'May 2024 · Gannon',         scale: 'G5' },
    { key: 'halloween',  dir: 'halloween_oct_2003',  label: 'Oct 2003 · Halloween',      scale: 'G5' },
]);

/**
 * Parse a block of TLEs (2-line or 3-line with names; blank lines and
 * stray whitespace tolerated) into assessment inputs. B comes from B*
 * (σ ±35 %, msis-drag's figure for a B*-derived coefficient); an unusable
 * B* falls back to a default with σ ±60 %. Returns { sats, rejected }.
 */
export function parseTleBlock(text, { defaultBc = 0.015 } = {}) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const sats = [];
    let rejected = 0;
    for (let i = 0; i < lines.length; ) {
        let name = null;
        if (!lines[i].startsWith('1 ')) {
            if (lines[i].startsWith('2 ')) { rejected++; i++; continue; }
            name = lines[i++].replace(/^0 /, '');
        }
        const l1 = lines[i], l2 = lines[i + 1];
        if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) { rejected++; i++; continue; }
        i += 2;
        const el = elementsFromTle(l1, l2, { name });
        if (!el || !(el.perigeeKm > 0)) { rejected++; continue; }
        sats.push({
            ...el, cls: null,
            bc: el.bc ?? defaultBc,
            bcSigmaFrac: el.bc ? 0.35 : 0.6,
            bcSource: el.bc ? 'tle-bstar' : 'default',
        });
    }
    return { sats, rejected };
}

/**
 * B = C_D · A / m  [m²/kg]. `areaM2` is the MEAN cross-section the orbit
 * sees (tumbling / attitude-averaged), not the largest face.
 */
export function ballisticFromSpacecraft({ massKg, areaM2, cd = DEFAULT_CD }) {
    if (!(massKg > 0) || !(areaM2 > 0)) return null;
    return cd * areaM2 / massKg;
}

/**
 * Perigee / apogee altitude (km) from a TLE pair, plus B from its B*.
 * For running a REAL fleet: CelesTrak lines in, assessment inputs out.
 * Returns null on anything unparseable.
 */
export function elementsFromTle(line1, line2, { name = null } = {}) {
    if (typeof line1 !== 'string' || typeof line2 !== 'string') return null;
    const norad = parseInt(line1.slice(2, 7), 10);
    const ecc   = parseFloat('0.' + line2.slice(26, 33).trim());
    const nRevDay = parseFloat(line2.slice(52, 63));
    if (!Number.isFinite(ecc) || !(nRevDay > 0)) return null;
    const nRadS = nRevDay * 2 * Math.PI / 86400;
    const aKm   = Math.cbrt(MU_KM3_S2 / (nRadS * nRadS));
    const bstar = parseBstar(line1);
    const bc    = Number.isFinite(bstar) && bstar > 0 ? bstarToBallistic(bstar) : null;
    return {
        id: Number.isFinite(norad) ? String(norad) : null,
        name,
        perigeeKm: aKm * (1 - ecc) - RE_KM,
        apogeeKm:  aKm * (1 + ecc) - RE_KM,
        bc,
        bcSource: bc ? 'tle-bstar' : null,
    };
}

/**
 * Parse a historical_ap.csv (columns t, ap, f107_sfu) into a sorted
 * [{ tMs, ap }] step series. Ap is 3-hourly; each value holds until the next.
 */
export function parseApCsv(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
    const head  = lines[0].split(',').map(s => s.trim());
    const iT = head.indexOf('t'), iAp = head.indexOf('ap');
    if (iT < 0 || iAp < 0) throw new Error('historical_ap.csv needs t and ap columns');
    const out = [];
    for (const l of lines.slice(1)) {
        const f = l.split(',');
        const tMs = Date.parse(f[iT]);
        const ap  = Number(f[iAp]);
        if (Number.isFinite(tMs) && Number.isFinite(ap)) out.push({ tMs, ap });
    }
    out.sort((a, b) => a.tMs - b.tMs);
    return out;
}

/** Ap in force at tMs (step-held). */
export function apAt(series, tMs) {
    let ap = series[0].ap;
    for (const s of series) { if (s.tMs <= tMs) ap = s.ap; else break; }
    return ap;
}

function stateOf(perigeeKm, apogeeKm) {
    const aKm = RE_KM + (perigeeKm + apogeeKm) / 2;
    return { aKm, e: Math.max(0, (apogeeKm - perigeeKm) / (2 * aKm)) };
}
const perigeeOf = (s) => s.aKm * (1 - s.e) - RE_KM;
const meanAltOf = (s) => s.aKm - RE_KM;

/**
 * March (a, e) forward one hour at a time under a time-varying atmosphere.
 * `rhoAtFor(hourIndex)` returns a ρ(altKm) function for that hour. Stops
 * early (reentered) if perigee reaches `reentryKm`.
 */
export function marchHourly({ perigeeKm, apogeeKm, bc, hours, rhoAtFor, reentryKm = 100 }) {
    const s = stateOf(perigeeKm, apogeeKm);
    const meanAlt = [meanAltOf(s)];
    for (let h = 0; h < hours; h++) {
        if (perigeeOf(s) <= reentryKm) {
            return { ...s, meanAlt, reentered: true, hoursFlown: h };
        }
        const r = orbitAverageRates(s.aKm, s.e, bc, rhoAtFor(h));
        s.aKm += r.adotKmDay * HOUR_DAY;
        s.e    = Math.max(0, s.e + r.edotPerDay * HOUR_DAY);
        meanAlt.push(meanAltOf(s));
    }
    return { ...s, meanAlt, reentered: false, hoursFlown: hours };
}

/**
 * Assess ONE spacecraft. `profileFor(f107, ap)` → msis-drag profile.
 *
 *   sc        { id, name, perigeeKm, apogeeKm, bc, bcSigmaFrac }
 *   baseline  { f107, ap }    the quiet state everything is compared to
 *   events    [{ key, label, series:[{tMs,ap}] }]
 *
 * Returns per-event: storm-window altitude loss vs the same window quiet,
 * extra loss, lifetime with the event vs without, lifetime lost, peak drag
 * ratio — each with the ±σ_B band (analytic, first order).
 */
export function assessSpacecraft(sc, { profileFor, baseline, events, maxDays = 36525 }) {
    const quietRho = makeRhoInterp(profileFor(baseline.f107, baseline.ap));
    const sig = Number.isFinite(sc.bcSigmaFrac) ? sc.bcSigmaFrac : 0.25;
    const apo = Number.isFinite(sc.apogeeKm) ? sc.apogeeKm : sc.perigeeKm;

    const quietLife = integrateDecay({
        perigeeKm: sc.perigeeKm, apogeeKm: apo, bc: sc.bc, rhoAt: quietRho, maxDays,
    });
    const s0 = stateOf(sc.perigeeKm, apo);
    const r0 = orbitAverageRates(s0.aKm, s0.e, sc.bc, quietRho);
    const meanAlt0 = meanAltOf(s0);

    const rhoCache = new Map();
    const rhoForAp = (ap) => {
        const k = Math.round(ap);
        let f = rhoCache.get(k);
        if (!f) { f = makeRhoInterp(profileFor(baseline.f107, k)); rhoCache.set(k, f); }
        return f;
    };

    const out = [];
    for (const ev of events) {
        const t0 = ev.series[0].tMs;
        const t1 = ev.series[ev.series.length - 1].tMs + 3 * 3600e3;
        const hours = Math.round((t1 - t0) / 3600e3);
        const apHourly = Array.from({ length: hours }, (_, h) => apAt(ev.series, t0 + h * 3600e3));
        const storm = marchHourly({
            perigeeKm: sc.perigeeKm, apogeeKm: apo, bc: sc.bc, hours,
            rhoAtFor: (h) => rhoForAp(apHourly[h]),
        });
        const quiet = marchHourly({
            perigeeKm: sc.perigeeKm, apogeeKm: apo, bc: sc.bc, hours,
            rhoAtFor: () => quietRho,
        });
        const stormLossKm = meanAlt0 - meanAltOf(storm);
        const quietLossKm = meanAlt0 - meanAltOf(quiet);

        // Lifetime WITH the event: the window, then quiet from where the
        // storm left the orbit.
        let lifeWith;
        if (storm.reentered) {
            lifeWith = storm.hoursFlown / 24;
        } else {
            const rest = integrateDecay({
                perigeeKm: perigeeOf(storm), apogeeKm: storm.aKm * (1 + storm.e) - RE_KM,
                bc: sc.bc, rhoAt: quietRho, maxDays,
            });
            lifeWith = hours / 24 + rest.lifetimeDays;
        }
        const lifeLost = Number.isFinite(quietLife.lifetimeDays) && Number.isFinite(lifeWith)
            ? quietLife.lifetimeDays - lifeWith : null;

        const peakAp = Math.max(...apHourly);
        const dragRatioPeak = rhoForAp(peakAp)(meanAlt0) / quietRho(meanAlt0);

        out.push({
            key: ev.key,
            label: ev.label,
            windowHours: hours,
            peakAp,
            dragRatioPeak,
            stormLossKm,
            quietLossKm,
            extraLossKm: stormLossKm - quietLossKm,
            // Altitude loss ∝ B to first order (rate ∝ ρ·B at fixed altitude).
            extraLossBandKm: [(stormLossKm - quietLossKm) * (1 - sig), (stormLossKm - quietLossKm) * (1 + sig)],
            lifetimeWithDays: lifeWith,
            lifetimeLostDays: lifeLost,
            reenteredInWindow: storm.reentered,
            meanAltKm: storm.meanAlt.filter((_, i) => i % 3 === 0),   // 3-hourly trace
        });
    }

    const life = quietLife.lifetimeDays;
    return {
        id: sc.id,
        name: sc.name,
        cls: sc.cls ?? null,
        perigeeKm: sc.perigeeKm,
        apogeeKm: apo,
        bc: sc.bc,
        bcSigmaFrac: sig,
        quiet: {
            decayKmPerDay: -r0.adotKmDay,
            lifetimeDays: life,
            // lifetime ∝ 1/B under a fixed profile — exact, not linearised.
            lifetimeBandDays: Number.isFinite(life) ? [life / (1 + sig), life / (1 - sig)] : null,
            capped: !Number.isFinite(life),
        },
        events: out,
    };
}
