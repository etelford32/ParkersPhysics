// tests/hero-sonify.mjs — pure maps of js/hero-sonify.js
import assert from 'node:assert/strict';
import { droneHz, brightnessHz, tension, stormLift, shimmerLevel, TICKS_MAX_HZ, MASTER_GAIN } from '../js/hero-sonify.js';
const near = (a, b, eps, m) => assert.ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);

near(droneHz(300), 55, 1e-9, '300 km/s is the A1 drone');
near(droneHz(900), 110, 1e-9, '900 km/s is one octave up');
assert.ok(droneHz(NaN) > 55 && droneHz(NaN) < 110, 'missing speed → mid');
let prev = 0;
for (let v = 150; v <= 1400; v += 25) { const f = droneHz(v); assert.ok(f >= prev, 'monotone'); prev = f; }
assert.ok(droneHz(5000) <= 55 * 2 ** 1.4 + 1e-9, 'clamped high'); assert.ok(droneHz(0) >= 55 * 2 ** -0.3 - 1e-9, 'clamped low');

near(brightnessHz(0.5), 220 + 1600 * Math.log10(1.5) / Math.log10(31), 1e-9, 'dull at 0.5');
near(brightnessHz(30), 1820, 1e-9, 'bright at 30');
assert.ok(brightnessHz(NaN) > 220, 'missing density → quiet default, not silence');

assert.deepEqual(tension(5), { cents: -0, tremolo: 0 }, 'northward: no tension');
assert.deepEqual(tension(-10), { cents: -140, tremolo: 0.4 });
assert.equal(tension(-100).cents, -700, 'detune clamped'); assert.equal(tension(-100).tremolo, 1);
assert.equal(tension(NaN).tremolo, 0);
assert.equal(stormLift(-1), 0); assert.equal(stormLift(3), 1); assert.equal(stormLift(NaN), 0);

// Shimmer follows verdict-engine's oval, never a re-derivation.
const tromso = { lat: 69.65, lon: 18.96 }, miami = { lat: 25.76, lon: -80.19 };
assert.equal(shimmerLevel(null, 5).state, 'no-location'); assert.equal(shimmerLevel(null, 5).level, 0);
assert.equal(shimmerLevel(tromso, 3).level, 1, 'Tromsø at Kp 3: go');
assert.equal(shimmerLevel(miami, 2).level, 0, 'Miami at Kp 2: nothing');
const chicago = { lat: 41.88, lon: -87.63 };
assert.equal(shimmerLevel(chicago, 1).level, 0, 'Chicago at Kp 1: nothing');
assert.ok(shimmerLevel(chicago, 7).level > 0, 'Chicago at Kp 7: within reach — the oracle decides, not this file');
assert.ok(TICKS_MAX_HZ <= 20, 'a storm is a hail, not a wall');
assert.ok(MASTER_GAIN <= 0.2, 'ambience under a page');
console.log('hero-sonify: all assertions passed');
