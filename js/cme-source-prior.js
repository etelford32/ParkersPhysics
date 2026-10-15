/**
 * js/cme-source-prior.js — a SOURCE-REGION prior for a flux rope's
 * magnetic orientation (tilt γ + chirality H).
 *
 * PURE. No DOM, no fetch, no ambient time (the date is an argument).
 * Node gate: tests/cme-source-prior.mjs, which also drives the COMMITTED
 * flux-rope WASM to prove the derived (γ, H) puts the kernel's own field
 * where this file says it goes.
 *
 * ── Why this exists (audit 2026-10-14) ─────────────────────────────────
 *
 * The live DONKI path (`donkiToPreset` in js/flux-rope-live.js) seeds every
 * rope with ROPE_DEFAULTS: tilt 0°, H = +1, then σ_tilt 40° and
 * p_flip 0.5. With p_flip 0.5 the chirality is a coin toss and the tilt
 * centre sits on the ecliptic, so the ensemble's prior median Bz is ~0 for
 * EVERY CME — a cone fit constrains when/where/how fast, not the field.
 * Bz is the geoeffective quantity, so that is the single largest hole in
 * the arrival forecast's usefulness. A flare-associated CME, though, comes
 * from an active region whose magnetic layout is constrained by three
 * well-established empirical laws (the Bothmer & Schwenn 1998 /
 * Palmerio et al. 2017 "intrinsic flux-rope type" construction):
 *
 *   1. HALE'S LAW — the leading polarity of a bipole is fixed per
 *      hemisphere per cycle and alternates between cycles. The leading
 *      polarity equals that hemisphere's polar-field sign at cycle onset;
 *      in ODD cycles (23, 25) the NORTHERN leading polarity is POSITIVE.
 *   2. JOY'S LAW — the bipole axis (following → leading) tilts so the
 *      leading spot sits equatorward. Reused from js/flare-geometry.js
 *      `joyTiltRad` (the site's ONE copy), never re-derived here.
 *   3. THE HEMISPHERIC HELICITY RULE — northern-hemisphere structures are
 *      predominantly LEFT-handed (negative helicity), southern RIGHT-
 *      handed. It holds for roughly 60–80 % of regions/filaments
 *      (Pevtsov et al. 2014 review), so it is a PRIOR, not a fact:
 *      `P_FLIP_HEMISPHERIC` = 0.3 is that reliability, disclosed.
 *
 * ── The construction (derived; the test checks it against the kernel) ─
 *
 * Work in the local horizontal frame at the source: Ŵ (heliographic west =
 * +Stonyhurst longitude = the kernel's ê_E), N̂ (north), Û (radial out);
 * (Ŵ, N̂, Û) is right-handed. With b̂ the Joy's-law bipole axis
 * (following → leading) and L the leading polarity sign:
 *
 *   p̂ = −L · b̂              the overlying (poloidal) field direction over
 *                            the top of the rope: from + polarity to −.
 *   â = H · (Û × p̂)         the AXIAL field direction. Gold–Hoyle with
 *                            chirality H puts B_pol = H·B·T·s along t̂ × r̂;
 *                            at the rope's TOP (r̂ = Û) that must equal p̂,
 *                            which fixes â for each H. (Û × p̂ = rot+90°(p̂).)
 *   γ = atan2(−â_N, −â_W)    because the kernel's apex tangent is
 *                            t̂(π) = −(cosγ·ê_E' + sinγ·ê_N') (spec §3) and
 *                            the axial field runs along +t̂.
 *
 * Consequence worth knowing: the rope's LEADING EDGE (its top) always
 * carries the overlying field p̂ whatever H is; chirality only decides
 * which way the AXIS points. That is what the node test checks against
 * the WASM.
 *
 * ── What this deliberately does NOT claim ──────────────────────────────
 *
 *   · The flux rope keeps its source orientation out to 1 AU. Real ropes
 *     rotate (tens of degrees, Yurchyshyn 2008; Lynch 2009), deflect,
 *     and interact. So σ_tilt STAYS at the cone-fit prior's 40°: only the
 *     CENTRE moves, so any skill change in the ledger is attributable to
 *     the centre, not to a narrower spread.
 *   · The kernel's ensemble flips H INDEPENDENTLY of γ (spec §7). Under the
 *     construction above a wrong chirality also reverses the axis; the
 *     kernel cannot express that coupling without a Rust change. Disclosed
 *     on `basis.notes`; recorded in CME_OUTLOOK_PLAN.md as follow-up.
 *   · Quiet-Sun filament eruptions (no flare) are NOT covered: the PIL of
 *     decayed flux is not given by Joy's law. No flare ⇒ no prior ⇒ the
 *     cone-fit defaults stand, and `basis` says so.
 *   · Cycle boundaries are a table, not a forecast. Past the last known
 *     onset + 13 years the cycle number is unknown and the prior refuses.
 *
 * It ships OPT-IN (`sourcePrior: true`) and is locked in the ledger as the
 * SHADOW model `flux-rope-v1-src` beside the unchanged `flux-rope-v1`, so
 * the daily validation loop measures whether it helps BEFORE anything is
 * switched (the v1.6 rule: knobs are fitted by the ledger, not by belief).
 */

import { joyTiltRad, parseStonyhurst, DEG } from './flare-geometry.js';

export const SOURCE_PRIOR_MODEL_ID = 'flux-rope-v1-src';

/** Reliability of the hemispheric helicity rule ⇒ chirality flip prior. */
export const P_FLIP_HEMISPHERIC = 0.3;

/** Tilt spread: UNCHANGED from the cone-fit prior on purpose (see header). */
export const SIG_TILT_SOURCE_DEG = 40;

/**
 * Solar-cycle onsets (minimum epochs, SIDC / NOAA–NASA prediction panel).
 * Cycle 25 minimum: December 2019. A date before the first or more than
 * 13 years past the last onset is "unknown" — never extrapolated.
 */
export const CYCLE_ONSETS = Object.freeze([
    { cycle: 23, startMs: Date.UTC(1996, 7, 1) },
    { cycle: 24, startMs: Date.UTC(2008, 11, 1) },
    { cycle: 25, startMs: Date.UTC(2019, 11, 1) },
]);
const MAX_CYCLE_MS = 13 * 365.25 * 86400e3;

/** Cycle number at `ms`, or null when outside the table. */
export function solarCycleAt(ms) {
    if (!Number.isFinite(ms)) return null;
    let hit = null;
    for (const c of CYCLE_ONSETS) if (ms >= c.startMs) hit = c;
    if (!hit || ms - hit.startMs > MAX_CYCLE_MS) return null;
    return hit.cycle;
}

/**
 * Hale's law: the leading polarity sign (+1/−1) of a bipole at `latDeg`
 * in `cycle`. Odd cycles: north leads +, south leads −. Null on the
 * equator or an unknown cycle.
 */
export function leadingPolarity(latDeg, cycle) {
    if (!Number.isFinite(latDeg) || latDeg === 0 || !Number.isFinite(cycle)) return null;
    const north = cycle % 2 === 1 ? 1 : -1;
    return latDeg > 0 ? north : -north;
}

/** Hemispheric helicity rule: north left-handed (−1), south right-handed (+1). */
export function hemisphericHandedness(latDeg) {
    if (!Number.isFinite(latDeg) || latDeg === 0) return null;
    return latDeg > 0 ? -1 : 1;
}

/**
 * Overlying-field direction p̂ (+ → −) and axial direction â in the local
 * (W, N) frame, plus the kernel tilt γ [deg] that realises â at the apex.
 */
export function ropeOrientation(latDeg, { leading, handedness }) {
    const g = joyTiltRad(latDeg * DEG);
    const b = [Math.cos(g), Math.sin(g)];          // following → leading
    const p = [-leading * b[0], -leading * b[1]];  // + → − over the top
    const a = [handedness * -p[1], handedness * p[0]];   // H·rot+90°(p̂)
    const tiltDeg = Math.atan2(-a[1], -a[0]) / DEG;
    return { overlying: p, axial: a, tiltDeg };
}

/**
 * The prior for one CME given its source location.
 *
 * @param {object} o
 * @param {string|null} [o.sourceLocation]  "N12W19"-style (DONKI FLR)
 * @param {number} [o.latDeg]               alternatively, a source latitude
 * @param {number} o.atMs                   eruption time (picks the cycle)
 * @returns {{ ok: true, tiltDeg, handedness, sigTiltDeg, pFlip, basis }
 *          | { ok: false, reason }}
 */
export function sourceRopePrior({ sourceLocation = null, latDeg = null, atMs } = {}) {
    let lat = Number.isFinite(latDeg) ? latDeg : null;
    if (lat == null && sourceLocation) lat = parseStonyhurst(sourceLocation)?.latDeg ?? null;
    if (lat == null) return { ok: false, reason: 'no-source-location' };
    if (lat === 0) return { ok: false, reason: 'equatorial-source' };
    const cycle = solarCycleAt(atMs);
    if (cycle == null) return { ok: false, reason: 'cycle-unknown' };
    const leading = leadingPolarity(lat, cycle);
    const handedness = hemisphericHandedness(lat);
    const o = ropeOrientation(lat, { leading, handedness });
    return {
        ok: true,
        tiltDeg: Math.round(o.tiltDeg * 10) / 10,
        handedness,
        sigTiltDeg: SIG_TILT_SOURCE_DEG,
        pFlip: P_FLIP_HEMISPHERIC,
        basis: {
            method: 'Hale + Joy + hemispheric helicity (Bothmer & Schwenn 1998)',
            sourceLatDeg: lat,
            cycle,
            leadingPolarity: leading,
            notes: 'source orientation assumed preserved to 1 AU (σ_tilt 40°); '
                + 'kernel flips chirality independently of the axis',
        },
    };
}

/**
 * Apply a prior to a donkiToPreset/donkiToTrainPreset rope list in place
 * of the cone-fit defaults. `priors` is index-aligned with `ropes`; a
 * null / !ok entry leaves that rope untouched. Spreads: pFlip takes the
 * MAX over ropes with and without a prior (the kernel samples ONE spread
 * set per train — the widest honest merge, same rule as the train seeder),
 * so a mixed train keeps 0.5 and only an all-sourced train narrows to 0.3.
 */
export function applySourcePriors(preset, priors) {
    if (!preset?.ropes?.length) return { preset, applied: 0 };
    let applied = 0;
    const ropes = preset.ropes.map((r, i) => {
        const p = priors?.[i];
        if (!p?.ok) return r;
        applied++;
        return { ...r, tiltDeg: p.tiltDeg, handedness: p.handedness };
    });
    const allSourced = applied === ropes.length;
    const spreads = { ...preset.spreads };
    if (allSourced) {
        spreads.pFlip = Math.max(...priors.map((p) => p.pFlip));
        spreads.sigTiltDeg = Math.max(...priors.map((p) => p.sigTiltDeg));
    }
    return { preset: { ...preset, ropes, rope: ropes[0], spreads }, applied };
}
