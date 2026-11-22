/**
 * tests/sun-post.mjs — pins the pure half of js/sun-post.js (Phase 2)
 *
 *   node tests/sun-post.mjs
 *
 *   • ExposureController: locks L_calib from the first frames (EV stays 0),
 *     then tracks log2(L_calib / L) with the ASYMMETRIC time constants
 *     (brighten τ 1.2 s, darken τ 0.5 s), clamps to [evMin, evMax], ignores
 *     non-finite input, and recalibrates on demand
 *   • ACCOMMODATION (2026-11-22): a frame that is brighter because the camera
 *     moved in is not a brighter Sun — a close-up returns to EV 0, a flash
 *     still dips and then recovers, a zoom back out does not over-brighten,
 *     the dark side is untouched, and the calibration lock describes one
 *     framing. The law shipped until then (`accommodate: false`) is the
 *     negative control: it holds the close-up at the −2 EV floor for ever
 *   • bloomMipSizes halves down to the floor and never returns an empty chain
 *   • flareBloomBoost keeps the old tight pass's 0.15 knee
 *
 * The GLSL half is gated by tests/sun-smoke.spec.js (shader-compile errors
 * surface as console errors there) and by the @gpu visual baseline.
 */
import assert from 'node:assert/strict';
import { ExposureController, EXPOSURE_DEFAULTS, bloomMipSizes, flareBloomBoost } from '../js/sun-post.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-post.mjs');

const LN = Math.log;

ok('calibration: EV is 0 for the first calibFrames samples, then L_calib is the geometric mean of them', () => {
    const c = new ExposureController({ calibFrames: 4 });
    for (const L of [0.10, 0.20, 0.10, 0.20]) { c.step(LN(L), 1 / 60); assert.equal(c.ev, 0); }
    assert.ok(c.calibrated);
    assert.ok(Math.abs(c.calibLum - Math.sqrt(0.10 * 0.20)) < 1e-12, 'geometric mean');
    // Same luminance after calibration → target EV 0, no drift.
    for (let i = 0; i < 100; i++) c.step(LN(c.calibLum), 1 / 60);
    assert.ok(Math.abs(c.ev) < 1e-9);
});

ok('a dark scene brightens toward log2(L_calib/L) with τ = 1.2 s; a bright one darkens with τ = 0.5 s', () => {
    const mk = (o = {}) => { const c = new ExposureController({ calibFrames: 1, ...o }); c.step(LN(0.2), 1 / 60); return c; };
    // Darker by 4× → target EV +2. After exactly one τ (1.2 s) a first-order system reaches 63.2 %.
    let c = mk();
    for (let t = 0; t < 1.2 - 1e-9; t += 1 / 120) c.step(LN(0.05), 1 / 120);
    assert.ok(Math.abs(c.evTarget - 2) < 1e-9, 'target +2 EV');
    assert.ok(c.ev > 2 * 0.60 && c.ev < 2 * 0.66, `63 % of the way after one τ (got ${(c.ev / 2 * 100).toFixed(1)} %)`);
    // Brighter by 4× → target −2; after 0.5 s (its τ) also ~63 % (the iris itself: accommodation off).
    c = mk({ accommodate: false });
    for (let t = 0; t < 0.5 - 1e-9; t += 1 / 120) c.step(LN(0.8), 1 / 120);
    assert.ok(Math.abs(c.evTarget + 2) < 1e-9, 'target −2 EV');
    assert.ok(c.ev < -2 * 0.60 && c.ev > -2 * 0.66, `63 % darkened after one τ (got ${(c.ev / -2 * 100).toFixed(1)} %)`);
    // Darkening is faster than brightening for the same elapsed time.
    const a = mk(); const b = mk({ accommodate: false });
    for (let i = 0; i < 30; i++) { a.step(LN(0.05), 1 / 60); b.step(LN(0.8), 1 / 60); }
    assert.ok(Math.abs(b.ev) > Math.abs(a.ev), 'asymmetric: darken beats brighten');
});

ok('EV clamps to [evMin, evMax] however extreme the scene', () => {
    const c = new ExposureController({ calibFrames: 1 });
    c.step(LN(0.2), 1 / 60);
    for (let i = 0; i < 2000; i++) c.step(LN(1e-6), 1 / 60);
    assert.ok(Math.abs(c.ev - EXPOSURE_DEFAULTS.evMax) < 1e-6, `pinned at evMax (${c.ev})`);
    // The floor: a flash 250× the calibrated frame, the moment it appears.
    for (let i = 0; i < 12; i++) c.step(LN(50), 1 / 60);
    assert.ok(Math.abs(c.evTarget - EXPOSURE_DEFAULTS.evMin) < 1e-9, `target pinned at evMin (${c.evTarget})`);
    const legacy = new ExposureController({ calibFrames: 1, accommodate: false });
    legacy.step(LN(0.2), 1 / 60);
    for (let i = 0; i < 2000; i++) legacy.step(LN(50), 1 / 60);
    assert.ok(Math.abs(legacy.ev - EXPOSURE_DEFAULTS.evMin) < 1e-6, `legacy law: pinned at evMin (${legacy.ev})`);
    assert.ok(Math.abs(legacy.exposure - Math.pow(2, EXPOSURE_DEFAULTS.evMin)) < 1e-9);
});

// ── Accommodation: a brighter frame is not a brighter Sun ───────────────────
// The numbers are the page's own, measured in the 304 Å view on real frames:
// the hero frame's log-mean luminance is 0.0127, a close-up at 2.16 R☉ reads
// 0.0721 — 2.5 EV brighter with nothing on the Sun having changed.
const HERO = 0.0127, CLOSE = 0.0721;
const locked = (o = {}) => { const c = new ExposureController({ calibFrames: 1, ...o }); c.step(LN(HERO), 1 / 60); return c; };
/** Fly hero → close-up over `secs`, the camera reported as moving; returns the deepest EV on the way. */
function flyIn(c, secs = 2, fps = 60) {
    let deepest = 0;
    for (let i = 1; i <= secs * fps; i++) {
        const k = i / (secs * fps);
        c.step(LN(HERO) + (LN(CLOSE) - LN(HERO)) * k, 1 / fps, { moving: true });
        deepest = Math.min(deepest, c.ev);
    }
    // The page keeps reporting motion for a short tail after the camera stops (damping, re-accumulation).
    for (let i = 0; i < 0.6 * fps; i++) { c.step(LN(CLOSE), 1 / fps, { moving: true }); deepest = Math.min(deepest, c.ev); }
    return deepest;
}

ok('a close-up of the disc is exposed like the hero frame; the old law held it at the −2 EV floor', () => {
    const c = locked();
    const dip = flyIn(c);
    assert.ok(dip > -0.35, `the flight in dips by under a third of a stop (deepest ${dip.toFixed(3)} EV)`);
    for (let i = 0; i < 600; i++) c.step(LN(CLOSE), 1 / 60);            // ten seconds on the close-up
    assert.ok(Math.abs(c.ev) < 0.01, `settled at EV ${c.ev.toFixed(4)} — the disc keeps its exposure`);
    assert.ok(Math.abs(c.accommodated - Math.log2(CLOSE / HERO)) < 0.01, `the whole 2.5 EV is accommodated as framing (${c.accommodated.toFixed(4)})`);
    // NEGATIVE CONTROL — the shipped-until-now law: the same flight, the same ten seconds.
    const old = locked({ accommodate: false });
    flyIn(old);
    for (let i = 0; i < 600; i++) old.step(LN(CLOSE), 1 / 60);
    assert.ok(Math.abs(old.ev - EXPOSURE_DEFAULTS.evMin) < 1e-3, `legacy law sits at the floor (${old.ev.toFixed(3)} EV = ×${old.exposure.toFixed(2)})`);
});

ok('a flash with the camera still snaps the iris shut, and it reopens on tauAccommodateStill', () => {
    const c = locked();
    flyIn(c);
    for (let i = 0; i < 300; i++) c.step(LN(CLOSE), 1 / 60);
    // The frame doubles (a flare kernel) and stays doubled; the camera does not move.
    let deepest = 0, at1 = null;
    const tau = EXPOSURE_DEFAULTS.tauAccommodateStill;
    for (let i = 1; i <= 60 * 40; i++) {
        c.step(LN(CLOSE * 2), 1 / 60);
        deepest = Math.min(deepest, c.ev);
        if (i === Math.round(60 * tau)) at1 = c.evTarget;
    }
    assert.ok(deepest < -0.6 && deepest > -1.0, `the flash stops down most of a stop (deepest ${deepest.toFixed(3)} EV)`);
    assert.ok(Math.abs(at1 + Math.exp(-1)) < 0.01, `one τ later the target has recovered to 1/e of the step (${at1.toFixed(3)})`);
    assert.ok(Math.abs(c.ev) < 0.01, `and it reopens (EV ${c.ev.toFixed(4)} after 40 s)`);
    // The flash ends: the excess falls back to the close-up's, and the exposure must NOT overshoot bright.
    let peak = -9;
    for (let i = 0; i < 600; i++) { c.step(LN(CLOSE), 1 / 60); peak = Math.max(peak, c.ev); }
    assert.ok(peak < 0.005, `no brightening overshoot when the flash ends (peak ${peak.toFixed(4)} EV)`);
});

ok('zooming back out returns to EV 0 with no overshoot; the dark side is untouched', () => {
    const c = locked();
    flyIn(c);
    for (let i = 0; i < 300; i++) c.step(LN(CLOSE), 1 / 60);
    let peak = -9;
    for (let i = 1; i <= 120; i++) {                                   // fly back out
        const k = i / 120;
        c.step(LN(CLOSE) + (LN(HERO) - LN(CLOSE)) * k, 1 / 60, { moving: true });
        peak = Math.max(peak, c.ev);
    }
    for (let i = 0; i < 300; i++) { c.step(LN(HERO), 1 / 60); peak = Math.max(peak, c.ev); }
    assert.ok(peak < 0.01 && Math.abs(c.ev) < 0.01, `back on the hero frame at EV ${c.ev.toFixed(4)} (peak ${peak.toFixed(4)})`);
    assert.equal(c.accommodated, 0, 'nothing is accommodated on the calibrated frame');
    // Darker than calibrated (a flight inside the corona): opens up and STAYS open, moving or not.
    const a = locked(), b = locked({ accommodate: false });
    for (let i = 0; i < 2400; i++) { a.step(LN(HERO / 8), 1 / 60, { moving: i < 200 }); b.step(LN(HERO / 8), 1 / 60); }
    assert.ok(Math.abs(a.ev - 3) < 1e-3, `+3 EV held for 40 s (${a.ev.toFixed(4)})`);
    assert.ok(Math.abs(a.ev - b.ev) < 1e-9, 'identical to the legacy law on the dark side');
});

ok('the calibration lock describes one framing: motion restarts it, and a view it may not count is skipped', () => {
    const c = new ExposureController({ calibFrames: 4 });
    c.step(LN(HERO), 1 / 60); c.step(LN(HERO), 1 / 60);
    c.step(LN(0.03), 1 / 60, { moving: true });                         // the camera left mid-count
    assert.equal(c.calibrated, false);
    for (let i = 0; i < 6; i++) c.step(LN(CLOSE), 1 / 60, { calibrate: false });   // a close-up: not the default subject
    assert.equal(c.calibrated, false, 'a view that may not calibrate never locks');
    for (let i = 0; i < 3; i++) c.step(LN(HERO), 1 / 60);
    assert.equal(c.calibrated, false, 'three still samples are not four');
    c.step(LN(HERO), 1 / 60);
    assert.ok(c.calibrated && Math.abs(c.calibLum - HERO) < 1e-12, `locked on the hero frame alone (${c.calibLum})`);
    // NEGATIVE CONTROL — the old lock averaged whatever arrived (measured on the page: 0.0265, between the two).
    const old = new ExposureController({ calibFrames: 4, accommodate: false });
    for (const L of [HERO, HERO, CLOSE, CLOSE]) old.step(LN(L), 1 / 60, { moving: true });
    assert.ok(old.calibrated && old.calibLum > HERO * 1.5 && old.calibLum < CLOSE / 1.5, `legacy lock is a mixture (${old.calibLum.toFixed(4)})`);
});

ok('non-finite input is ignored; recalibrate() re-locks and resets EV', () => {
    const c = new ExposureController({ calibFrames: 1 });
    c.step(LN(0.2), 1 / 60);
    for (let i = 0; i < 60; i++) c.step(LN(0.05), 1 / 60);
    const before = c.ev;
    c.step(NaN, 1 / 60); c.step(LN(0.05), NaN);
    assert.equal(c.ev, before);
    c.recalibrate();
    assert.equal(c.ev, 0); assert.equal(c.calibrated, false);
    c.step(LN(0.05), 1 / 60);
    assert.ok(c.calibrated && Math.abs(c.calibLum - 0.05) < 1e-12, 're-locked at the new luminance');
});

ok('bloomMipSizes: halves to the floor, honours maxMips, never empty', () => {
    const s = bloomMipSizes(1280, 720);
    assert.deepEqual(s[0], [640, 360]);
    assert.deepEqual(s[s.length - 1], [20, 11]);
    assert.equal(s.length, 6);
    assert.equal(bloomMipSizes(1280, 720, { maxMips: 3 }).length, 3);
    assert.equal(bloomMipSizes(2560, 1440).length, 6);
    assert.deepEqual(bloomMipSizes(10, 10), [[5, 5]], 'tiny canvas still gets one mip');
});

ok('flareBloomBoost: 0 below the 0.15 knee, linear above', () => {
    assert.equal(flareBloomBoost(0), 0);
    assert.equal(flareBloomBoost(0.1), 0);
    assert.ok(Math.abs(flareBloomBoost(0.15) - 0) < 1e-12);
    assert.ok(Math.abs(flareBloomBoost(1.0) - 0.85 * 1.2) < 1e-12);
    assert.equal(flareBloomBoost(NaN), 0);
});

console.log(`\n${passed} checks passed`);
