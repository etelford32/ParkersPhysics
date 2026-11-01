#!/usr/bin/env node
/**
 * weather-events.mjs — gates js/weather-events.js (the time-bar markers) and
 * js/time-loop.js (loop playback), EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §6.3–6.4.
 * Synthetic series with PLANTED events: each must be found within its hour;
 * each control (a flat series, a gap, Kp unknown) must yield nothing.
 */
import assert from 'node:assert/strict';
import { detectEvents, kpLookup, RAIN_ON, WIND_NOTABLE } from '../js/weather-events.js';
import { loopWindow, loopRate, loopStep, LOOP_TARGET_S, LOOP_RATE_MIN, LOOP_RATE_MAX } from '../js/time-loop.js';
import { auroraVerdict } from '../js/verdict-engine.js';
import { placeMarkers } from '../js/time-strip-model.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1);
let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name); console.error('    ', e.stack || e.message); }
}
function series(n, f) {
    const t = new Float64Array(n);
    const v = { precip: new Float32Array(n), t2m: new Float32Array(n), wind: new Float32Array(n), cloudTotal: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
        t[i] = T0 + i * HOUR;
        const r = f(i);
        v.precip[i] = r.p ?? 0; v.t2m[i] = r.t ?? 10; v.wind[i] = r.w ?? 3; v.cloudTotal[i] = r.c ?? 20;
    }
    return { t, values: v };
}
const dayStart = (t) => T0 + Math.floor((t - T0) / (24 * HOUR)) * 24 * HOUR;
const of = (evs, type) => evs.filter((e) => e.type === type);
console.log('weather-events + time-loop');

check('rain spell: start and end at the planted hours, peak + length in the detail', () => {
    const s = series(48, (i) => ({ p: i >= 10 && i < 14 ? (i === 12 ? 4 : 1) : 0 }));
    const ev = detectEvents(s);
    assert.deepEqual(of(ev, 'rain-start').map((e) => e.t), [T0 + 10 * HOUR]);
    assert.deepEqual(of(ev, 'rain-stop').map((e) => e.t), [T0 + 14 * HOUR]);
    assert.match(of(ev, 'rain-start')[0].detail, /peaks 4\.0 mm\/h · 4 h/);
});

check('controls: a dry series, drizzle under the threshold, and a gap mark no rain', () => {
    assert.equal(detectEvents(series(48, () => ({ p: 0 }))).length, 0);
    assert.equal(of(detectEvents(series(48, () => ({ p: RAIN_ON * 0.9 }))), 'rain-start').length, 0);
    // Rain right after a gap: no dry run precedes it, so no start is claimed.
    const s = series(24, (i) => ({ p: i >= 6 ? 2 : 0 }));
    s.values.precip[5] = NaN;
    assert.equal(of(detectEvents(s), 'rain-start').length, 0, 'a gap is not a dry hour');
});

check('rain ongoing at the window end: a start, no invented end', () => {
    const ev = detectEvents(series(24, (i) => ({ p: i >= 20 ? 2 : 0 })));
    assert.equal(of(ev, 'rain-start').length, 1);
    assert.equal(of(ev, 'rain-stop').length, 0);
    assert.match(of(ev, 'rain-start')[0].detail, /ongoing/);
});

check('wind: the strongest hour of each day, only if notable, labelled as mean wind', () => {
    const s = series(48, (i) => ({ w: i === 15 ? 14 : i === 30 ? WIND_NOTABLE - 1 : 4 }));
    const w = of(detectEvents(s, { dayStart }), 'wind-peak');
    assert.deepEqual(w.map((e) => e.t), [T0 + 15 * HOUR], 'day 2 peaks below the threshold: no marker');
    assert.match(w[0].detail, /not gusts/);
});

check('freeze: the first sub-zero hour after a warm spell, with the low', () => {
    const s = series(36, (i) => ({ t: i >= 20 && i < 26 ? -3 + (i === 23 ? -2 : 0) : 4 }));
    const f = of(detectEvents(s), 'freeze');
    assert.deepEqual(f.map((e) => e.t), [T0 + 20 * HOUR]);
    assert.match(f[0].detail, /low -5\.0 °C/);
    assert.equal(of(detectEvents(series(36, () => ({ t: -5 }))), 'freeze').length, 0, 'never warm: no onset claimed');
});

check('aurora: only dark + clear + GO hours (verdict-engine\'s rule), unknown Kp marks nothing', () => {
    const magLat = 50;
    const sunAltDeg = (t) => (((t - T0) / HOUR) % 24 >= 20 || ((t - T0) / HOUR) % 24 < 4 ? -20 : 10);
    const kpRows = Array.from({ length: 8 }, (_, k) => ({ time_tag: new Date(T0 + k * 3 * HOUR).toISOString(), kp_index: k >= 6 ? 7 : 2 }));
    const s = series(24, (i) => ({ c: i === 22 ? 90 : 10 }));
    const a = of(detectEvents(s, { sunAltDeg, kpAt: kpLookup(kpRows), magLat }), 'aurora');
    // Kp 7 from 18 UTC; dark from 20; 22 h is cloudy → two runs: 20–21, 23.
    assert.deepEqual(a.map((e) => (e.t - T0) / HOUR), [20, 23]);
    assert.equal(auroraVerdict(7, magLat, 10, -20).state, 'go', 'fixture sanity: the oracle says GO');
    // Kp beyond the rows → null → no marker (never a quiet-sky default either way).
    const late = of(detectEvents(series(48, () => ({ c: 0 })), { sunAltDeg, kpAt: kpLookup(kpRows), magLat }), 'aurora');
    assert.ok(late.every((e) => e.t < T0 + 24 * HOUR), 'nothing marked past the forecast rows');
    assert.equal(kpLookup(kpRows)(T0 + 24 * HOUR), null);
    assert.equal(kpLookup(kpRows)(T0 - 1), null);
});

check('markers: priority wins a contested pixel, separation holds, out-of-window dropped', () => {
    const dom = { t0: T0, t1: T0 + 100 * HOUR };
    const evs = [
        { t: T0 + 10 * HOUR, priority: 1, type: 'rain-stop' },
        { t: T0 + 10.5 * HOUR, priority: 5, type: 'aurora' },
        { t: T0 + 40 * HOUR, priority: 3, type: 'rain-start' },
        { t: T0 + 500 * HOUR, priority: 5, type: 'aurora' },
    ];
    const placed = placeMarkers(evs, dom, 0, 1000, 15);
    assert.deepEqual(placed.map((e) => e.type), ['aurora', 'rain-start']);
    for (let i = 1; i < placed.length; i++) assert.ok(placed[i].x - placed[i - 1].x >= 15);
});

check('loop: preset windows relative to now, clamped to the slider domain', () => {
    const now = T0 + 1000 * HOUR;
    const dom = { t0: now - 7 * 24 * HOUR, t1: now + 14 * 24 * HOUR };
    assert.deepEqual(loopWindow('pm24', now, dom), { t0: now - 24 * HOUR, t1: now + 24 * HOUR });
    assert.deepEqual(loopWindow('next72', now, dom), { t0: now, t1: now + 72 * HOUR });
    const tight = { t0: now - 2 * HOUR, t1: now + 30 * HOUR };
    assert.deepEqual(loopWindow('pm24', now, tight), { t0: now - 2 * HOUR, t1: now + 24 * HOUR });
    assert.equal(loopWindow('custom', now, dom, null), null);
    assert.deepEqual(loopWindow('custom', now, dom, { t0: now + 5 * HOUR, t1: now + 2 * HOUR }), { t0: now + 2 * HOUR, t1: now + 5 * HOUR });
});

check('loop: ~12 s per pass at any span (rate clamped), steps forward and wraps', () => {
    const win = { t0: 0, t1: 48 * HOUR };
    assert.equal(loopRate(win), 48 * HOUR / LOOP_TARGET_S);
    assert.equal(loopRate({ t0: 0, t1: HOUR }), LOOP_RATE_MIN);
    assert.equal(loopRate({ t0: 0, t1: 30 * 24 * HOUR }), LOOP_RATE_MAX);
    let t = -5 * HOUR;
    t = loopStep(t, win, 16);
    assert.equal(t, 0, 'outside the window starts at t0');
    let wall = 0;
    while (wall < LOOP_TARGET_S * 1000 - 16) { t = loopStep(t, win, 16); wall += 16; }
    assert.ok(t > 47 * HOUR, `one target duration covers the window (t=${t / HOUR} h)`);
    t = loopStep(47.99 * HOUR, win, 200);
    assert.ok(t >= 0 && t < 2 * HOUR, 'passing t1 wraps to the start, never reverses');
    assert.equal(loopStep(10 * HOUR, win, 60_000), loopStep(10 * HOUR, win, 250), 'a stalled tab does not leap');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
