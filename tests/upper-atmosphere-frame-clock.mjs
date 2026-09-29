/**
 * tests/upper-atmosphere-frame-clock.mjs — the stepped clock never runs backwards
 *   node tests/upper-atmosphere-frame-clock.mjs
 *
 * js/upper-atmosphere-frame-clock.js is what the camera, the transit and the
 * explore layer read instead of performance.now(). Every consumer differences
 * two readings, so the one property that matters beyond "manual time moves
 * only when stepped" is that switching modes never makes it jump backwards —
 * a pinned test start (1e6 ms) is far from the wall clock, and a backwards
 * jump is a negative dt in the transit and a negative path progress.
 */
import assert from 'node:assert/strict';
import { frameClock as c } from '../js/upper-atmosphere-frame-clock.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

t('live by default, and live is the wall clock', () => {
    assert.equal(c.isManual(), false);
    const a = performance.now(), b = c.now(), d = performance.now();
    assert.ok(b >= a && b <= d);
});
t('manual time starts where it is told and moves only by advance()', () => {
    c.setManual(true, 1e6);
    assert.equal(c.now(), 1e6);
    assert.equal(c.now(), 1e6);
    assert.equal(c.advance(1000 / 60), 1e6 + 1000 / 60);
    c.advance(-5); c.advance(NaN);
    assert.equal(c.now(), 1e6 + 1000 / 60, 'non-positive / non-finite steps are ignored');
    c.setManual(true, 5);   // already manual: a second switch changes nothing
    assert.equal(c.now(), 1e6 + 1000 / 60);
});
t('leaving manual resumes FROM the manual time, not the wall clock', () => {
    const m = c.now();
    c.setManual(false);
    const a = c.now();
    assert.ok(a >= m && a - m < 50, `resumed at ${a - m} ms from the manual time`);
    const b = c.now();
    assert.ok(b >= a, 'and runs forward');
});
t('re-entering manual without a start continues from where the clock is', () => {
    const a = c.now();
    c.setManual(true);
    assert.ok(c.now() >= a && c.now() - a < 50);
    c.setManual(false);
});
t('advance() does nothing while live', () => {
    const a = c.now();
    const b = c.advance(1e9);
    assert.ok(b - a < 50);
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-frame-clock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
