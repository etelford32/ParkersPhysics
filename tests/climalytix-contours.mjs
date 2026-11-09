#!/usr/bin/env node
/**
 * climalytix-contours.mjs — node gate for js/climalytix/contours.js.
 *
 * On a PLANAR field (T linear in lat and lon) an isotherm is a straight line
 * whose position is known in closed form, so the contour points are checked
 * exactly; a bowl gives a closed loop; a saddle never produces crossing
 * lines; a gap corner draws nothing; levels are round in the reader's unit
 * and the freezing line is always its own flagged level.
 *
 *   node tests/climalytix-contours.mjs
 */

import assert from 'node:assert/strict';
import { contourLines, isothermLevels, labelAnchor } from '../js/climalytix/contours.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

function field(nRows, nCols, fn, { latN = 42, lonW = -108, d = 0.25 } = {}) {
    const values = [];
    for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) values.push(fn(latN - i * d, lonW + j * d, i, j));
    return { latN, lonW, dlat: d, dlon: d, nRows, nCols, values };
}

const C = { toDisplay: (c) => c, fromDisplay: (d) => d, sym: '°C' };
const F = { toDisplay: (c) => c * 9 / 5 + 32, fromDisplay: (f) => (f - 32) * 5 / 9, sym: '°F' };

console.log('climalytix contours');

ok('planar field: the isotherm is the exact straight line T = level', () => {
    // T = 10 − 2·(lat − 40) + 1·(lon + 107)  ⇒  T = 10 on lat = 40 + (lon + 107)/2
    const f = field(9, 9, (lat, lon) => 10 - 2 * (lat - 40) + (lon + 107));
    const chains = contourLines(f, 0, 10);
    assert.equal(chains.length, 1, 'one line');
    assert.equal(chains[0].closed, false);
    for (const p of chains[0].pts) {
        assert.ok(Math.abs(p.lat - (40 + (p.lon + 107) / 2)) < 1e-9, `${p.lat},${p.lon} on the line`);
    }
    const onEdge = (p) => [p.lat - 42, p.lat - 40, p.lon + 108, p.lon + 106].some((x) => Math.abs(x) < 1e-9);
    const pts = chains[0].pts;
    assert.ok(onEdge(pts[0]) && onEdge(pts[pts.length - 1]), 'an open isotherm ends on the window boundary');
});

ok('a warm bowl gives one CLOSED loop at the right radius', () => {
    const f = field(21, 21, (lat, lon, i, j) => 20 - ((i - 10) ** 2 + (j - 10) ** 2) * 0.1);
    const chains = contourLines(f, 0, 15);                 // radius² = 50 cells²
    assert.equal(chains.length, 1);
    assert.equal(chains[0].closed, true);
    for (const p of chains[0].pts) {
        const di = (42 - p.lat) / 0.25 - 10, dj = (p.lon + 108) / 0.25 - 10;
        assert.ok(Math.abs(Math.hypot(di, dj) - Math.sqrt(50)) < 0.35, 'on the circle (linear interpolation error < 0.35 cells)');
    }
});

ok('a saddle cell never makes crossing lines (centre mean decides the pairing)', () => {
    for (const centre of [15, 5]) {
        // 2×2 nodes TL 0, TR 20, BL 20, BR 0: case 5 (TR + BL above 10).
        const f = { latN: 1, lonW: 0, dlat: 1, dlon: 1, nRows: 2, nCols: 2, values: [0, 20, 20, 0] };   // row-major: TL 0, TR 20 / BL 20, BR 0
        const chains = contourLines(f, 0, centre === 15 ? 9.99 : 10.01);
        assert.equal(chains.length, 2, 'two separate segments');
        const keys = chains.map((c) => c.pts.map((p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`).sort().join('|'));
        assert.notEqual(keys[0], keys[1]);
    }
});

ok('a gap corner draws nothing through the missing data', () => {
    const f = field(5, 5, (lat, lon, i, j) => j * 5);      // isotherms run north–south
    assert.equal(contourLines(f, 0, 7.5).length, 1, 'control: without the gap, one unbroken line');
    f.values[2 * 5 + 2] = null;                            // node (row 2, col 2) missing
    const chains = contourLines(f, 0, 7.5);                // the line between cols 1 and 2
    assert.equal(chains.length, 2, 'the line is cut where the gap is');
    for (const p of chains.flatMap((c) => c.pts)) {
        const row = (42 - p.lat) / 0.25;
        assert.ok(row <= 1 + 1e-9 || row >= 3 - 1e-9, `no point in the cells touching the gap (row ${row})`);
    }
});

ok('levels are round in the READER’S unit; the freezing line is its own flagged level', () => {
    const c = isothermLevels(-3.2, 9.6, C);
    assert.ok(c.length >= 4 && c.length <= 13, `${c.length} levels`);
    assert.ok(c.every((l) => Number.isInteger(l.c * 2)), 'round °C');
    assert.equal(c.filter((l) => l.freezing).length, 1);
    const f = isothermLevels(-3.2, 9.6, F);
    for (const l of f.filter((x) => !x.freezing)) assert.ok(Number.isInteger(+l.label.replace('°', '')), `${l.label} is a whole °F`);
    const frz = f.find((l) => l.freezing);
    assert.ok(frz && frz.c === 0 && frz.label === '32°', 'freezing at 0 °C labelled 32° for a °F reader');
    assert.equal(isothermLevels(5, 9, C).some((l) => l.freezing), false, 'no freezing line when the range does not span 0');
    assert.deepEqual(isothermLevels(5, 5, C), [], 'a flat field has no isotherms');
});

ok('labels sit mid-chain on the longest chain, and short scraps get none', () => {
    const chains = [{ pts: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] }, { pts: Array.from({ length: 9 }, (_, k) => ({ lat: k, lon: 0 })) }];
    assert.deepEqual(labelAnchor(chains), { lat: 4, lon: 0 });
    assert.equal(labelAnchor([chains[0]]), null);
});

console.log(`\n${passed} passed`);
