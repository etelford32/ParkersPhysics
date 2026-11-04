/**
 * Gate for js/neo-watch/sim-clock.js — neo-watch.html's one simulation clock.
 *
 * Each of the three bugs the module header records is asserted here, against
 * the behaviour it replaced:
 *   1. a scrub while paused MOVES the stage;
 *   2. resuming at real time continues from the paused instant (no jump);
 *   3. the slider's offset tracks warp (it is read back, not just written).
 * Plus the invariants: live is the wall clock EXACTLY (offset === 0), rate
 * changes and pause/resume never move the stage, reverse rates run backwards,
 * and the slider span always holds the offset.
 */
import assert from 'node:assert/strict';
import {
    msToJd, MS_PER_DAY, RATES, SPANS_DAYS, DEFAULT_SPAN_DAYS,
    liveClock, jdAt, offsetDays, isLive, setRate, setPaused, seekOffset, seekJd, step,
    spanFor, sliderStepDays, rateLabel, formatOffset, stateLabel,
} from '../js/neo-watch/sim-clock.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const SEC = 1000, HOUR = 3600 * SEC, DAY = MS_PER_DAY;
const JD_EPS = 1e-9;     // ~0.1 ms — far below anything a slider can set
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// ── Live is the wall clock, exactly ─────────────────────────────────────────
{
    const c = liveClock(T0);
    assert.equal(isLive(c), true);
    for (const t of [T0, T0 + 5 * SEC, T0 + 3 * DAY]) {
        assert.equal(jdAt(c, t), msToJd(t), 'live reads the wall clock');
        assert.equal(offsetDays(c, t), 0, 'live offset is exactly 0');
    }
    assert.equal(stateLabel(c), 'LIVE');
    assert.equal(setRate(c, 1, T0), c, 'rate 1 on a live clock is a no-op');
    assert.equal(setPaused(c, false, T0), c, 'resuming a live clock is a no-op');
}
ok('live is the wall clock exactly');

// ── Rate changes never move the stage; warp advances at the rate ────────────
{
    let c = liveClock(T0);
    c = setRate(c, 3600, T0 + 10 * SEC);
    near(jdAt(c, T0 + 10 * SEC), msToJd(T0 + 10 * SEC), JD_EPS, 'no jump on rate change');
    near(jdAt(c, T0 + 20 * SEC), msToJd(T0 + 10 * SEC) + 10 * 3600 / 86400, JD_EPS, '10 s at 1 h/s = 10 h');
    assert.equal(isLive(c), false);
    assert.equal(stateLabel(c), 'FAST-FORWARD');
    const jdBefore = jdAt(c, T0 + 30 * SEC);
    c = setRate(c, -86400, T0 + 30 * SEC);
    near(jdAt(c, T0 + 30 * SEC), jdBefore, JD_EPS, 'no jump into reverse');
    near(jdAt(c, T0 + 32 * SEC), jdBefore - 2, JD_EPS, 'reverse: 2 s at 1 d/s is −2 d');
    assert.equal(stateLabel(c), 'REVERSE');
    assert.equal(setRate(c, 0, T0), c, 'rate 0 refused (that is Pause)');
    assert.equal(setRate(c, NaN, T0), c, 'NaN refused');
}
ok('rate changes are continuous and reverse runs backwards');

// ── BUG 3: the offset tracks warp ───────────────────────────────────────────
{
    let c = setRate(liveClock(T0), 86400, T0);
    near(offsetDays(c, T0 + 7 * SEC), 7 - 7 * SEC / DAY, 1e-9, 'a week ahead after 7 s at 1 d/s');
    assert.ok(spanFor(offsetDays(c, T0 + 7 * SEC)) >= 7, 'the span grows to hold it');
}
ok('the slider offset is read back under warp');

// ── BUG 1: a scrub while paused moves the stage ─────────────────────────────
{
    let c = setPaused(liveClock(T0), true, T0);
    assert.equal(stateLabel(c), 'PAUSED');
    near(jdAt(c, T0 + HOUR), msToJd(T0), JD_EPS, 'paused holds');
    c = seekOffset(c, 5, T0 + HOUR);
    near(jdAt(c, T0 + HOUR), msToJd(T0 + HOUR) + 5, JD_EPS, 'the scrub lands');
    near(jdAt(c, T0 + 2 * HOUR), msToJd(T0 + HOUR) + 5, JD_EPS, 'and stays paused there');
    assert.equal(c.paused, true);
}
ok('scrubbing while paused moves the stage and stays paused');

// ── BUG 2: resume continues from the paused instant ─────────────────────────
{
    let c = setPaused(liveClock(T0), true, T0);
    c = setPaused(c, false, T0 + 10 * 60 * SEC);           // 10 minutes later
    near(jdAt(c, T0 + 10 * 60 * SEC), msToJd(T0), JD_EPS, 'no jump on resume');
    near(jdAt(c, T0 + 11 * 60 * SEC), msToJd(T0) + 60 / 86400, JD_EPS, 'then runs at real time');
    near(offsetDays(c, T0 + 11 * 60 * SEC), -10 / 1440, 1e-9, '10 min behind now');
    assert.equal(isLive(c), false, 'behind now is not live');
    assert.equal(stateLabel(c), 'OFFSET');
    // ...and a resumed warp keeps its rate.
    let w = setPaused(setRate(liveClock(T0), 3600, T0), true, T0 + SEC);
    w = setPaused(w, false, T0 + 60 * SEC);
    near(jdAt(w, T0 + 61 * SEC) - jdAt(w, T0 + 60 * SEC), 3600 / 86400, 1e-9, 'resumed at 1 h/s');
}
ok('resume continues from where it paused, at the same rate');

// ── Seeks and steps ─────────────────────────────────────────────────────────
{
    let c = seekJd(liveClock(T0), 2462240.4, T0);
    near(jdAt(c, T0), 2462240.4, JD_EPS, 'absolute seek');
    near(jdAt(c, T0 + HOUR), 2462240.4 + 1 / 24, JD_EPS, 'runs at real time from there');
    c = step(c, -1, T0 + HOUR);
    near(jdAt(c, T0 + HOUR), 2462240.4 + 1 / 24 - 1, JD_EPS, 'step −1 d');
    assert.equal(step(c, 0, T0), c);
    assert.equal(seekOffset(c, NaN, T0), c);
    assert.equal(seekJd(c, Infinity, T0), c);
    // Seeking to offset 0 is NOT live — only Now is (rate/pause may be set).
    const z = seekOffset(setRate(liveClock(T0), 600, T0), 0, T0);
    assert.equal(isLive(z), false);
    near(offsetDays(z, T0), 0, 1e-12, 'at now');
}
ok('seeks and steps');

// ── Slider span, step and labels ────────────────────────────────────────────
{
    assert.equal(spanFor(0), DEFAULT_SPAN_DAYS, 'opens at the default span');
    assert.ok(SPANS_DAYS.includes(DEFAULT_SPAN_DAYS));
    for (const d of [0, 1, -6.9, 29, 31, -95, 400, 900, -2000, 6000]) {
        const s = spanFor(d);
        assert.ok(s >= Math.abs(d), `span ${s} holds ${d}`);
        assert.ok(SPANS_DAYS.includes(s));
    }
    assert.equal(spanFor(1e6), SPANS_DAYS[SPANS_DAYS.length - 1], 'capped at the widest');
    assert.equal(spanFor(1, 2), 2, 'floor respected');
    for (const s of SPANS_DAYS) {
        const st = sliderStepDays(s);
        assert.ok(st > 0 && (2 * s) / st <= 3000 && (2 * s) / st >= 200, `step ${st} for span ${s}`);
    }
    assert.ok(RATES.includes(1) && RATES.some(r => r < 0), 'real time and reverse are offered');
    for (const r of RATES) assert.ok(rateLabel(r).length > 0);
    assert.equal(rateLabel(1), 'real time');
    assert.match(rateLabel(-3600), /reverse/);
    assert.equal(formatOffset(0), 'now');
    assert.equal(formatOffset(1 / 24), '+1 h');
    assert.equal(formatOffset(-0.5), '−12 h');
    assert.equal(formatOffset(3.256), '+3.26 d');
    assert.equal(formatOffset(1000), '+2.7 yr');
}
ok('slider span/step and labels');

console.log(`\nneo-watch-clock: ${n} groups passed`);
