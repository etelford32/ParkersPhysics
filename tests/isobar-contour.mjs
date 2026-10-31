#!/usr/bin/env node
/**
 * isobar-contour.mjs — gates js/isobar-contour.js, the pure isobar pipeline
 * that moved out of js/isobar-engine.js so it can run in the scrub Worker.
 *
 *   1. BIT-IDENTICAL to the pre-move inline pipeline: positions, colours,
 *      H/L centres (incl. sprite positions) and gradient stats are compared
 *      against tests/fixtures/isobar-contour-reference.json, which was baked
 *      from commit e063f2f's IsobarLayer on real three.js r160
 *      (scripts/bake-isobar-reference.mjs says how). SHA-256 over the raw
 *      Float32 bytes — one flipped bit fails.
 *   2. NEGATIVE CONTROL: the same field nudged by 0.01 hPa along one row must
 *      change the hash, so the comparison can see a change at all.
 *   3. The frame: toXYZ is the canonical js/geo/coords.js mapping
 *      (+X lon 0, +Y north, −Z = +90°E) — a 90° slip here is how the old
 *      hand-rolled formula put every isobar off its longitude.
 *   4. Deterministic and transfer-safe (fresh typed arrays each call).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { computeIsobars, _internals, ISOBAR_LEVELS } from '../js/isobar-contour.js';

const ref = JSON.parse(readFileSync(new URL('./fixtures/isobar-contour-reference.json', import.meta.url), 'utf8'));
const F = {
    waves: (x, y) => 1012 + 18 * Math.sin(x / 30) * Math.cos(y / 25),
    lows:  (x, y) => 1013 - 30 * Math.exp(-((x - 200) ** 2 + (y - 130) ** 2) / 300) + 22 * Math.exp(-((x - 60) ** 2 + (y - 50) ** 2) / 500) + 4 * Math.sin(x / 7 + y / 11),
};
const field = (f) => {
    const b = new Float32Array(360 * 180 * 4);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 360; x++) b[(y * 360 + x) * 4 + 1] = (f(x, y) - 850) / 210;
    return b;
};
const sha = (a) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name); console.error('    ', e.stack || e.message); }
}
console.log('isobar-contour');

for (const name of Object.keys(F)) {
    check(`bit-identical to the pre-move IsobarLayer (${name})`, () => {
        const r = computeIsobars(field(F[name]));
        const want = ref.fields[name];
        assert.equal(r.segments, want.segments);
        assert.equal(sha(r.positions), want.positionsSha256, 'positions');
        assert.equal(sha(r.colors), want.colorsSha256, 'colours');
        assert.deepEqual(r.extrema.map(({ x, y, type, hPa, pos }) => ({ x, y, type, hPa, pos })), want.extrema);
        assert.deepEqual(r.stats, want.stats);
    });
}

check('NEGATIVE CONTROL: a 0.01 hPa nudge along one row changes the hash', () => {
    // A whole row, because every isobar crosses it; a single cell at the
    // bottom of the low moves no contour at all (none crosses its edges).
    const b = field(F.lows);
    for (let x = 0; x < 360; x++) b[(90 * 360 + x) * 4 + 1] += 0.01 / 210;
    assert.notEqual(sha(computeIsobars(b).positions), ref.fields.lows.positionsSha256);
});

check('frame: +X = lon 0, +Y = north, −Z = +90°E (canonical coords.js)', () => {
    const { toXYZ } = _internals;
    const o = {};
    const at = (lat, lon) => toXYZ((lon + 180) / 360 * 360, (lat + 90) / 180 * 180, 1, o) && { ...o };
    const near = (p, x, y, z) => assert.ok(Math.abs(p.x - x) < 1e-12 && Math.abs(p.y - y) < 1e-12 && Math.abs(p.z - z) < 1e-12, JSON.stringify(p));
    near(at(0, 0), 1, 0, 0);
    near(at(90, 0), 0, 1, 0);
    near(at(0, 90), 0, 0, -1);
    near(at(0, -90), 0, 0, 1);
});

check('deterministic, fresh arrays each call, 25 levels', () => {
    const b = field(F.waves);
    const a = computeIsobars(b), c = computeIsobars(b);
    assert.equal(sha(a.positions), sha(c.positions));
    assert.notEqual(a.positions.buffer, c.positions.buffer, 'each call must own its arrays (they are transferred)');
    assert.equal(ISOBAR_LEVELS.length, 25);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
