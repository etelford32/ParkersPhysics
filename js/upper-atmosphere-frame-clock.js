/**
 * upper-atmosphere-frame-clock.js — the ONE clock the camera stack reads
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything on upper-atmosphere.html that moves the camera or times a
 * visual — the dive / climb paths and flyTo animations
 * (upper-atmosphere-camera.js), the layer transit and the gas cloud
 * (-transit.js), the POI refresh, discovery checks and aurora animation
 * (-explore.js) — reads `frameClock.now()` instead of `performance.now()`.
 *
 * Normally that IS `performance.now()`. In MANUAL mode (the test hook:
 * `globe.setManualClock(true)` + `globe.stepFrames(n, dt)`) it only moves
 * when a frame is stepped, by exactly the step. That is what makes camera
 * behaviour testable to the last digit on a software renderer that draws
 * a frame every ~0.6 s: a test holds W, steps 60 frames of 1/60 s and the
 * camera has flown exactly one second of cruise, not "whatever the machine
 * managed".
 *
 * A module-level singleton on purpose: the stepped modules are constructed
 * in different places, and threading a clock object through every
 * constructor would put test plumbing into production signatures.
 */

let manual = false;
let tMs = 0;
// Live time is performance.now() + offset. The offset is 0 until a manual
// run ends; then it carries the clock on from the manual instant, so time
// never runs backwards across the switch (a pinned `startMs` is usually far
// from the wall clock, and every consumer differences two readings).
let offset = 0;

export const frameClock = Object.freeze({
    /** Milliseconds: wall time normally, stepped time in manual mode. */
    now() { return manual ? tMs : performance.now() + offset; },
    isManual() { return manual; },
    /**
     * Enter or leave manual mode. Manual time starts at `startMs` if given,
     * else where the clock already is; leaving resumes from the manual time.
     */
    setManual(on, startMs = null) {
        on = !!on;
        if (on === manual) return;
        if (on) tMs = Number.isFinite(startMs) ? startMs : performance.now() + offset;
        else offset = tMs - performance.now();
        manual = on;
    },
    /** Advance manual time (no-op otherwise). Returns the new time. */
    advance(ms) {
        if (manual && Number.isFinite(ms) && ms > 0) tMs += ms;
        return this.now();
    },
});
