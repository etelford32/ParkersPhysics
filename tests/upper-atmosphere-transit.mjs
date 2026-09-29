/**
 * tests/upper-atmosphere-transit.mjs — gate for the layer-transit kernel
 *   node tests/upper-atmosphere-transit.mjs
 */
import assert from 'node:assert/strict';
import {
    localBasis, transitPose, poseFromPosition, transitAltitude,
    ambientGas, assignSpecies, ambientLegend, CLOUD, R_EARTH_KM,
} from '../js/upper-atmosphere-transit-model.js';
import { latLonToScene } from '../js/upper-atmosphere-column.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

console.log('\n── pose ──');

t('local basis is orthonormal and right-handed, east is the TEXTURE east (−Z at Greenwich)', () => {
    const { up, east, north } = localBasis(0, 0);
    assert.deepEqual(up.map(v => +v.toFixed(12)), [1, 0, 0]);
    assert.deepEqual(east.map(v => +v.toFixed(12)), [0, 0, -1]);
    assert.deepEqual(north.map(v => +v.toFixed(12)), [0, 1, 0]);
    for (const [lat, lon] of [[51.5, -0.1], [-33.9, 151.2], [80, 170]]) {
        const b = localBasis(lat, lon);
        near(dot(b.up, b.east), 0, 1e-12, 'up·east'); near(dot(b.up, b.north), 0, 1e-12, 'up·north');
        near(dot(b.east, b.north), 0, 1e-12, 'east·north');
        near(Math.hypot(...b.north), 1, 1e-12, '|north|');
        // A small step east increases longitude.
        const p = latLonToScene(lat, lon).map((v, i) => v + 1e-4 * b.east[i]);
        const lon2 = Math.atan2(-p[2], p[0]) / (Math.PI / 180);
        assert.ok(((lon2 - lon + 540) % 360) - 180 > 0, `east step at ${lat},${lon} did not increase lon`);
    }
});

t('transitPose puts the camera on the local vertical at the altitude, level horizon at pitch 0', () => {
    const pose = transitPose({ latDeg: 25, lonDeg: -140, altKm: 400, headingDeg: 90, pitchDeg: 0 });
    near(Math.hypot(...pose.position), 1 + 400 / R_EARTH_KM, 1e-12, 'radius');
    near(dot(pose.forward, pose.up), 0, 1e-12, 'level');
    const back = poseFromPosition(pose.position);
    near(back.latDeg, 25, 1e-9, 'lat'); near(back.lonDeg, -140, 1e-9, 'lon'); near(back.altKm, 400, 1e-6, 'alt');
    const down = transitPose({ latDeg: 0, lonDeg: 0, altKm: 100, headingDeg: 0, pitchDeg: -90 });
    near(dot(down.forward, down.up), -1, 1e-12, 'pitch −90 looks straight down');
});

t('transitAltitude runs at the rate and clamps at the target', () => {
    const a = transitAltitude({ fromKm: 2000, toKm: 80, kmPerSec: 50, tS: 10 });
    near(a.altKm, 1500, 1e-9, 'after 10 s'); assert.equal(a.done, false);
    const b = transitAltitude({ fromKm: 2000, toKm: 80, kmPerSec: 50, tS: 1e4 });
    near(b.altKm, 80, 1e-9, 'clamped'); assert.equal(b.done, true);
    const c = transitAltitude({ fromKm: 100, toKm: 800, kmPerSec: 200, tS: 2 });
    near(c.altKm, 500, 1e-9, 'ascending');
});

console.log('\n── the gas around the camera ──');

t('dot count falls monotonically with altitude, floors in the exosphere, zero above the model', () => {
    let prev = Infinity;
    for (const alt of [80, 100, 150, 250, 400, 700, 1200, 2000]) {
        const g = ambientGas({ altitudeKm: alt });
        assert.ok(g.count <= prev, `count rose at ${alt} km: ${g.count} > ${prev}`);
        assert.ok(g.count >= CLOUD.minDots && g.count <= CLOUD.maxDots, `count ${g.count} at ${alt}`);
        prev = g.count;
    }
    assert.ok(ambientGas({ altitudeKm: 80 }).count > 0.8 * CLOUD.maxDots, 'dense at the floor');
    assert.equal(ambientGas({ altitudeKm: 2500 }).count, 0);
    assert.equal(ambientGas({ altitudeKm: 2500 }).outOfBand, true);
});

t('composition changes with altitude: N₂ leads at 100 km, O at 400 km, H at 2000 km', () => {
    assert.equal(ambientGas({ altitudeKm: 100 }).dominant, 'N2');
    assert.equal(ambientGas({ altitudeKm: 400 }).dominant, 'O');
    assert.equal(ambientGas({ altitudeKm: 2000 }).dominant, 'H');
    for (const alt of [90, 300, 900]) {
        const g = ambientGas({ altitudeKm: alt });
        const sum = g.species.reduce((s, x) => s + x.fraction, 0);
        near(sum, 1, 0.01, `fractions at ${alt} km`);
        assert.ok(g.species[0].fraction >= g.species[g.species.length - 1].fraction, 'sorted');
    }
});

t('jitter follows the thermal speed and heading changes follow collisions', () => {
    const lo = ambientGas({ altitudeKm: 90 }), hi = ambientGas({ altitudeKm: 1500 });
    assert.ok(hi.vth_m_s > lo.vth_m_s, 'hydrogen aloft is faster than N₂ below');
    assert.ok(hi.driftRunitPerS > lo.driftRunitPerS, 'drift follows v_th');
    assert.ok(lo.headingChangeHz > hi.headingChangeHz, 'more collisions below');
    assert.ok(hi.mfp_km > 1000 * lo.mfp_km, 'mean free path grows by orders of magnitude');
    assert.ok(lo.driftRunitPerS > 0 && hi.driftRunitPerS <= CLOUD.maxStepRunit * 60);
});

t('the storm state moves the gas: Ap 300 is denser and hotter at 400 km', () => {
    const q = ambientGas({ altitudeKm: 400, f107Sfu: 150, ap: 15 });
    const s = ambientGas({ altitudeKm: 400, f107Sfu: 150, ap: 300 });
    assert.ok(s.nTotal > q.nTotal && s.T > q.T && s.count >= q.count);
});

t('assignSpecies is deterministic, respects the fractions, and indexes the species list', () => {
    const g = ambientGas({ altitudeKm: 400 });
    const a = assignSpecies(g, 4000, 7), b = assignSpecies(g, 4000, 7);
    assert.deepEqual(Array.from(a.slice(0, 50)), Array.from(b.slice(0, 50)));
    const counts = new Array(g.species.length).fill(0);
    for (const k of a) { assert.ok(k >= 0 && k < g.species.length); counts[k]++; }
    for (let k = 0; k < g.species.length; k++) {
        near(counts[k] / 4000, g.species[k].fraction, 0.03, `species ${g.species[k].id} share`);
    }
});

t('the legend discloses the log stretch and names the mixture', () => {
    const l = ambientLegend(ambientGas({ altitudeKm: 400 }));
    assert.match(l, /dots ∝ log₁₀ n/);
    assert.match(l, /O \d+%/);
    assert.match(l, /v_th \d+ m\/s/);
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-transit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
