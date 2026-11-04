/**
 * neo-watch/sim-clock.js — the ONE simulation clock for neo-watch.html (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no ambient time: every function takes the wall-clock instant it is
 * evaluated at (`realMs`, epoch ms) and returns a NEW frozen state. Gate:
 * `node tests/neo-watch-clock.mjs`.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The controller used to carry four loosely coupled fields (warp, a warp
 * anchor, an offset, a paused JD) and three of their combinations were wrong:
 *
 *   1. SCRUBBING WHILE PAUSED DID NOTHING. The paused branch returned the JD
 *      frozen at pause time and ignored the offset the slider had just set.
 *   2. RESUMING AT REAL TIME JUMPED AHEAD by however long the page had been
 *      paused, because at ×1 the clock read the wall clock and ignored the
 *      anchor the resume had just written.
 *   3. THE SLIDER NEVER MOVED UNDER WARP. It wrote an offset but never read
 *      one back, so at ×1 day/s the thumb sat at "now" while the stage was a
 *      week ahead.
 *
 * Here the clock is ONE affine map, jd(t) = anchorJd + rate·(t − anchorMs),
 * plus two flags: `paused` freezes it, and `live` pins it to the wall clock
 * EXACTLY (jd = wall JD, offset exactly 0) — the page's resting state, which
 * must not be able to drift from the clock it claims to follow
 * (NEO_WATCH_PLAN.md §2 decision 7). Every control is a function of
 * (state, realMs) that preserves the CURRENT simulated instant unless moving
 * it is the point: changing rate, pausing and resuming never jump the stage.
 *
 * `rate` is simulated seconds per real second and may be NEGATIVE (play the
 * sky backwards). The slider reads `offsetDays` = jd − wall JD, so it shows
 * where the stage is relative to now whatever moved it there.
 */

export const JD_UNIX_0 = 2440587.5;
export const MS_PER_DAY = 86_400_000;
export const msToJd = (ms) => ms / MS_PER_DAY + JD_UNIX_0;
export const jdToMs = (jd) => (jd - JD_UNIX_0) * MS_PER_DAY;

/** Rates offered by the page, simulated seconds per real second. 1 = real time. */
export const RATES = Object.freeze([-86400, -3600, 1, 60, 600, 3600, 21600, 86400]);

/** Slider half-spans, days. The slider picks the smallest that holds the offset. */
export const SPANS_DAYS = Object.freeze([2, 7, 30, 90, 365, 1825, 7300]);
/** The span the page opens with: ±30 days of sky, the close-approach window's scale. */
export const DEFAULT_SPAN_DAYS = 30;

/** Real time, now. */
export function liveClock(realMs) {
    return Object.freeze({ live: true, paused: false, rate: 1, anchorMs: realMs, anchorJd: msToJd(realMs) });
}

/** The simulated instant (JD) at wall time `realMs`. */
export function jdAt(c, realMs) {
    if (c.live) return msToJd(realMs);
    if (c.paused) return c.anchorJd;
    return c.anchorJd + (c.rate * (realMs - c.anchorMs)) / MS_PER_DAY;
}

/** Simulated minus wall clock, days. Exactly 0 while live. */
export function offsetDays(c, realMs) {
    return c.live ? 0 : jdAt(c, realMs) - msToJd(realMs);
}

/** Live means real time, running, at now — nothing else. */
export function isLive(c) { return !!c.live; }

/** Re-anchor at the current instant with some fields changed. Never jumps. */
function reanchor(c, realMs, patch) {
    const jd = jdAt(c, realMs);
    return Object.freeze({ live: false, paused: c.paused, rate: c.rate, ...patch, anchorMs: realMs, anchorJd: patch.anchorJd ?? jd });
}

/** Change the rate, keeping the stage where it is. Rate 1 at offset 0 is NOT live: Now is. */
export function setRate(c, rate, realMs) {
    if (!Number.isFinite(rate) || rate === 0) return c;
    if (c.live && rate === 1) return c;
    return reanchor(c, realMs, { rate });
}

/** Pause or resume. Resuming continues from the paused instant, at the same rate. */
export function setPaused(c, paused, realMs) {
    if (!!paused === !!c.paused && !c.live) return c;
    if (c.live && !paused) return c;
    return reanchor(c, realMs, { paused: !!paused });
}

/** Put the stage `days` from now (the slider). Keeps the rate and the pause. */
export function seekOffset(c, days, realMs) {
    if (!Number.isFinite(days)) return c;
    return reanchor(c, realMs, { anchorJd: msToJd(realMs) + days });
}

/** Put the stage at an absolute JD (an approach row). */
export function seekJd(c, jd, realMs) {
    if (!Number.isFinite(jd)) return c;
    return reanchor(c, realMs, { anchorJd: jd });
}

/** Step the stage by `days` (the ± buttons and arrow keys). */
export function step(c, days, realMs) {
    if (!Number.isFinite(days) || days === 0) return c;
    return reanchor(c, realMs, { anchorJd: jdAt(c, realMs) + days });
}

/**
 * The slider's half-span for an offset: the smallest offered span that holds
 * it with 5 % to spare, never below `floorDays` — so the thumb is never pinned
 * against an end while the stage is somewhere the end does not reach, and a
 * scrub never makes the slider jump under the user's finger (the caller holds
 * the span while a drag is in progress).
 */
export function spanFor(offsetDaysValue, floorDays = DEFAULT_SPAN_DAYS) {
    const need = Math.abs(offsetDaysValue) * 1.05;
    for (const s of SPANS_DAYS) if (s >= floorDays && s >= need) return s;
    return SPANS_DAYS[SPANS_DAYS.length - 1];
}

/** Slider step for a span: ~1/2000 of the travel, rounded to a readable unit. */
export function sliderStepDays(spanDays) {
    const raw = (2 * spanDays) / 2000;
    const units = [1 / 1440, 5 / 1440, 15 / 1440, 1 / 24, 3 / 24, 0.25, 1, 2, 5, 10];
    for (const u of units) if (u >= raw) return u;
    return 10;
}

/** "×1 h/s", "real time", "◀ ×1 d/s" — the rate's label. */
export function rateLabel(rate) {
    if (rate === 1) return 'real time';
    const a = Math.abs(rate);
    const txt = a >= 86400 ? `${a / 86400} d/s` : a >= 3600 ? `${a / 3600} h/s` : a >= 60 ? `${a / 60} min/s` : `${a}×`;
    return rate < 0 ? `◀ ${txt} (reverse)` : `×${txt}`;
}

/** A compact offset: "now", "+3 h 20 m", "−12.4 d", "+2.3 yr". */
export function formatOffset(days) {
    if (!Number.isFinite(days)) return '—';
    const a = Math.abs(days), s = days < 0 ? '−' : '+';
    if (a < 1 / 86400) return 'now';
    if (a < 1 / 24) return `${s}${Math.round(a * 1440)} min`;
    if (a < 2) {
        const h = Math.floor(a * 24), m = Math.round((a * 24 - h) * 60);
        return m === 60 ? `${s}${h + 1} h` : `${s}${h} h${m ? ` ${m} m` : ''}`;
    }
    if (a < 730) return `${s}${a.toFixed(a < 20 ? 2 : 1)} d`;
    return `${s}${(a / 365.25).toFixed(1)} yr`;
}

/** The state chip: LIVE / PAUSED / REVERSE / ×rate / OFFSET. */
export function stateLabel(c) {
    if (c.live) return 'LIVE';
    if (c.paused) return 'PAUSED';
    if (c.rate < 0) return 'REVERSE';
    if (c.rate !== 1) return 'FAST-FORWARD';
    return 'OFFSET';
}
