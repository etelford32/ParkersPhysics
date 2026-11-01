/**
 * time-loop.js — play a window of time on repeat (EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §6.4).
 *
 * PURE: no DOM, no ambient time. js/time-strip.js owns the controller and
 * writes the slider; this decides WHERE the loop is and how far it moves.
 *
 * A loop always lasts about LOOP_TARGET_S of wall clock, whatever its span
 * (the rate is span / target, clamped), so "±24 h" and "next 3 days" both
 * read as one comfortable pass — a fixed rate made a 3-day loop drag and a
 * 6-hour one flash.
 */

const HOUR = 3_600_000;

export const LOOP_TARGET_S = 12;
export const LOOP_RATE_MIN = 1 * HOUR;    // sim ms per wall second
export const LOOP_RATE_MAX = 12 * HOUR;

/** The offered windows, relative to NOW. Order = the select's order. */
export const LOOP_PRESETS = Object.freeze([
    { id: 'pm24',   label: '±24 h',       t0: -24 * HOUR, t1: 24 * HOUR },
    { id: 'next24', label: 'Next 24 h',   t0: 0,          t1: 24 * HOUR },
    { id: 'past24', label: 'Past 24 h',   t0: -24 * HOUR, t1: 0 },
    { id: 'next72', label: 'Next 3 days', t0: 0,          t1: 72 * HOUR },
]);
export const DEFAULT_LOOP = 'pm24';

/**
 * Absolute window for a preset (or a custom absolute range), clamped to the
 * slider's own domain so a loop can never ask the clock for an instant the
 * bar cannot show.
 * @param {string} id               preset id, or 'custom'
 * @param {number} nowMs
 * @param {{t0:number,t1:number}} domain   the slider's absolute domain
 * @param {{t0:number,t1:number}|null} [custom]
 * @returns {{t0:number, t1:number}|null}  null if the window is empty
 */
export function loopWindow(id, nowMs, domain, custom = null) {
    let t0, t1;
    if (id === 'custom') {
        if (!custom) return null;
        t0 = Math.min(custom.t0, custom.t1); t1 = Math.max(custom.t0, custom.t1);
    } else {
        const p = LOOP_PRESETS.find((x) => x.id === id) ?? LOOP_PRESETS[0];
        t0 = nowMs + p.t0; t1 = nowMs + p.t1;
    }
    t0 = Math.max(t0, domain.t0); t1 = Math.min(t1, domain.t1);
    return t1 - t0 >= 15 * 60_000 ? { t0, t1 } : null;
}

/** Sim-ms per wall-second for a window. */
export function loopRate({ t0, t1 }) {
    const r = (t1 - t0) / LOOP_TARGET_S;
    return Math.max(LOOP_RATE_MIN, Math.min(LOOP_RATE_MAX, r));
}

/**
 * One step of the loop. Starting outside the window starts at t0; passing t1
 * wraps to t0 (never a reverse sweep — weather plays forward). dtWallMs is
 * clamped so a backgrounded tab resumes where it was instead of leaping.
 */
export function loopStep(t, win, dtWallMs) {
    if (!(t >= win.t0 && t <= win.t1)) return win.t0;
    const dt = Math.max(0, Math.min(dtWallMs, 250));
    const next = t + loopRate(win) * dt / 1000;
    return next > win.t1 ? win.t0 + (next - win.t1) % (win.t1 - win.t0) : next;
}
