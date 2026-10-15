/**
 * scheduled-decay.js — orbit decay through TIME-VARYING drivers
 * (DECAY_BRIEF_PLAN.md §3, gap A).
 * ═══════════════════════════════════════════════════════════════════════════
 * Walks js/operations/msis-drag.js `integrateDecay` — the ONE decay
 * integrator; this file adds no physics — through a schedule from
 * js/decay/driver-schedule.js:
 *
 *   • density at time t is the profile for the segment containing t,
 *     cached per (segment state, season bucket) so a year-long run costs
 *     one provider call per distinct driver state, not per step;
 *   • every step is capped at the end of its segment, so a storm onset or
 *     the next day's F10.7 lands on a step boundary instead of being
 *     stepped over (the constant-profile integrator only bounds the
 *     change in a, which a sudden ×5 density jump does not respect);
 *   • past the schedule's end the last state is HELD and the result says
 *     for how many days (`heldDays`) — a lifetime that outruns its
 *     drivers must say so, not look as confident as one that doesn't.
 *
 * profileFor({ f107, f107a, ap, apArray, dateMs }) → { alt0, step, rho }
 * is injected (js/decay/msis-profile.js wraps the committed WASM), so
 * this module stays PURE and node-testable with an analytic atmosphere.
 * Gate: node tests/decay-driver-schedule.mjs
 */

import { integrateDecay, makeRhoInterp, RE_KM } from '../operations/msis-drag.js';
import { segmentIndexAt, DAY_MS } from './driver-schedule.js';

// MSIS's seasonal terms move slowly; re-evaluating a profile more often
// than this only multiplies provider calls.
export const SEASON_BUCKET_DAYS = 15;

/**
 * @returns {null | {
 *   lifetimeDays, reentered, dadtKmDay, finalE, steps,
 *   reentryMs,          // startMs + lifetime (null when it survives)
 *   heldDays,           // days integrated past the schedule's end
 *   profiles,           // distinct provider calls made
 *   track,              // [{ tDays, perigeeKm, apogeeKm }] when record
 * }}  null when the provider fails for any state the orbit reached.
 */
export function scheduledDecay({
    perigeeKm, apogeeKm, bc, schedule, profileFor,
    maxDays = 36525, reentryKm, record = false,
    seasonBucketDays = SEASON_BUCKET_DAYS, maxSteps = 200000,
}) {
    if (!schedule?.segments?.length || typeof profileFor !== 'function') return null;
    const { startMs, endMs, segments } = schedule;
    const bucketMs = seasonBucketDays * DAY_MS;
    const interps = new Map();
    let failed = false;

    const rhoFn = (seg, tMs) => {
        const bucket = Math.floor(tMs / bucketMs);
        const key = `${seg.key}|${bucket}`;
        let f = interps.get(key);
        if (f === undefined) {
            let p = null;
            try {
                p = profileFor({
                    f107: seg.f107, f107a: seg.f107a, ap: seg.ap,
                    apArray: seg.apArray, dateMs: (bucket + 0.5) * bucketMs,
                });
            } catch (_) { p = null; }
            f = p ? makeRhoInterp(p) : null;
            interps.set(key, f);
        }
        if (!f) { failed = true; return 0; }
        return f;
    };

    let segIdx = 0;
    const locate = (tDays) => {
        const tMs = startMs + tDays * DAY_MS;
        const s = segments[segIdx];
        // Steps move forward; check the cached segment and its successor
        // before falling back to a binary search.
        if (!(s.t0Ms <= tMs && tMs < s.t1Ms)) {
            const nx = segments[segIdx + 1];
            segIdx = (nx && nx.t0Ms <= tMs && tMs < nx.t1Ms) ? segIdx + 1 : segmentIndexAt(schedule, tMs);
        }
        return { seg: segments[segIdx], tMs };
    };

    let lastT = -1, lastRho = null;
    const rhoAtT = (altKm, tDays) => {
        if (tDays !== lastT) {
            const { seg, tMs } = locate(tDays);
            lastRho = rhoFn(seg, tMs);
            lastT = tDays;
        }
        return typeof lastRho === 'function' ? lastRho(altKm) : 0;
    };
    const maxStepDays = (tDays) => {
        const { seg, tMs } = locate(tDays);
        if (tMs >= endMs) return Infinity;
        return (seg.t1Ms - tMs) / DAY_MS;
    };

    const track = record ? [] : null;
    const onStep = record ? (t, aKm, e) => {
        track.push({ tDays: t, perigeeKm: aKm * (1 - e) - RE_KM, apogeeKm: aKm * (1 + e) - RE_KM });
    } : null;

    const res = integrateDecay({
        perigeeKm, apogeeKm: Number.isFinite(apogeeKm) ? apogeeKm : perigeeKm, bc,
        rhoAt: null, rhoAtT, maxStepDays, onStep, maxDays, maxSteps,
        ...(Number.isFinite(reentryKm) ? { reentryKm } : {}),
    });
    if (failed) return null;

    const endT = Number.isFinite(res.lifetimeDays) ? res.lifetimeDays : maxDays;
    const heldDays = Math.max(0, startMs + endT * DAY_MS - endMs) / DAY_MS;
    return {
        ...res,
        reentryMs: res.reentered ? startMs + res.lifetimeDays * DAY_MS : null,
        heldDays,
        profiles: interps.size,
        ...(record ? { track } : {}),
    };
}
