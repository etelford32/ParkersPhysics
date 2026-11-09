#!/usr/bin/env node
/**
 * climalytix-map-view.mjs — node gate for js/climalytix/map-view.js.
 *
 * Pins: zoom keeps the ground under the cursor fixed (exact); a clamped zoom
 * does not pan; drag and the D-pad move the right way; the view never shows
 * past a pole; the GIBS tile plan uses the REAL 288/2^z grid, covers the view,
 * splits across the dateline and clips padded edge tiles; the heat field's
 * pixels use the site-wide temperature LUT bytes and gaps are transparent.
 *
 *   node tests/climalytix-map-view.mjs
 */

import assert from 'node:assert/strict';
import {
    makeView, clampView, scales, geoToPx, pxToGeo, viewBounds, zoomAt, panBy, panStep,
    tilePlan, scaleBar, fieldTimeIndex, fieldSample, fieldRange,
    heatImage, heatColor, fieldExtremes,
    wrap180, SPAN_MIN_DEG, SPAN_MAX_DEG, ZOOM_STEP,
} from '../js/climalytix/map-view.js';
import { tileSpanDeg, tilesAcross } from '../js/earth-detail-inset.js';
import { buildTempLUTPixels, TEMP_LUT_SIZE, TEMP_ENCODE_MIN_C, TEMP_ENCODE_SPAN_C, FREEZE_SEAM, freezingSeam } from '../js/temp-ramp.js';
import { readFileSync } from 'node:fs';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const W = 900, H = 420;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

console.log('climalytix map view');

ok('geo ↔ px round trip; east–west is true scale at the centre latitude', () => {
    const v = makeView(40, -105.27);
    const p = geoToPx(v, W, H, 41.2, -103.9);
    const g = pxToGeo(v, W, H, p.x, p.y);
    near(g.lat, 41.2, 1e-9, 'lat'); near(g.lon, -103.9, 1e-9, 'lon');
    const { kx, ky } = scales(v, H);
    near(kx / ky, Math.cos(40 * Math.PI / 180), 1e-12, 'aspect = cos φ');
    // Negative control: plate carrée 1:1 would stretch a 40°N site 1.31× east–west.
    assert.ok(ky / kx > 1.3);
});

ok('zoom keeps the ground under the cursor under the cursor (exact), in and out', () => {
    let v = makeView(40, -105.27);
    for (const [f, px, py] of [[ZOOM_STEP, 120, 80], [ZOOM_STEP, 700, 300], [1 / ZOOM_STEP, 30, 400], [2.7, 450, 210]]) {
        const before = pxToGeo(v, W, H, px, py);
        v = zoomAt(v, f, px, py, W, H);
        const after = geoToPx(v, W, H, before.lat, before.lon);
        near(after.x, px, 1e-9, 'x'); near(after.y, py, 1e-9, 'y');
    }
    // Zooming at the centre does not move the centre.
    const c = zoomAt(makeView(10, 20), 2, W / 2, H / 2, W, H);
    near(c.lat, 10, 1e-12, 'centre lat'); near(c.lon, 20, 1e-12, 'centre lon');
});

ok('a zoom at a span limit does not pan (no drift when the wheel keeps going)', () => {
    const v = makeView(40, -105, SPAN_MIN_DEG);
    assert.deepEqual(zoomAt(v, 2, 10, 10, W, H), v);
    const out = makeView(0, 0, SPAN_MAX_DEG);
    assert.deepEqual(zoomAt(out, 0.5, 800, 400, W, H), out);
});

ok('drag moves the content with the pointer; the D-pad moves the VIEW that way', () => {
    const v = makeView(40, -105);
    const dragged = panBy(v, 100, 0, W, H);                  // pointer moved right → we look further west
    assert.ok(dragged.lon < v.lon);
    const g = pxToGeo(v, W, H, 300, 200);
    const p = geoToPx(dragged, W, H, g.lat, g.lon);
    near(p.x, 400, 1e-9, 'the grabbed point followed the pointer');
    assert.ok(panStep(v, 'right', W, H).lon > v.lon, '▶ looks east');
    assert.ok(panStep(v, 'up', W, H).lat > v.lat, '▲ looks north');
    assert.ok(panStep(v, 'left', W, H).lon < v.lon);
    assert.ok(panStep(v, 'down', W, H).lat < v.lat);
    near(panStep(v, 'up', W, H).lat - v.lat, v.span * 0.25, 1e-9, 'a quarter of the view');
});

ok('the view never shows past a pole and longitude wraps', () => {
    const v = clampView({ lat: 89, lon: 190, span: 10 });
    assert.equal(v.lat, 85);
    assert.equal(v.lon, -170);
    const b = viewBounds(v, W, H);
    assert.ok(b.north <= 90 + 1e-9);
    assert.equal(wrap180(180), -180);
    assert.equal(wrap180(-180), -180);
});

ok('the tile plan uses GIBS’ real 288/2^z grid and covers the whole view', () => {
    const v = makeView(40, -105.27);
    const { z, tiles } = tilePlan(v, W, H, { dpr: 1 });
    assert.ok(512 / tileSpanDeg(z) >= H / v.span || z === 7, 'resolution meets the screen');
    for (const t of tiles) {
        near(t.geo.west, -180 + t.col * tileSpanDeg(z) + t.lonOffset, 1e-9, 'col → lon');
        assert.ok(t.col < tilesAcross(z), 'never a tile past the matrix edge');
    }
    const b = viewBounds(v, W, H);
    const covered = (lat, lon) => tiles.some((t) => lon >= t.geo.west && lon <= t.geo.east && lat <= t.geo.north && lat >= t.geo.south);
    for (const [y, x] of [[0, 0], [0, W], [H, 0], [H, W], [H / 2, W / 2]]) {
        const g = pxToGeo(v, W, H, x, y);
        assert.ok(covered(Math.min(b.north, g.lat), g.lon), `corner ${x},${y} covered`);
    }
    // Negative control: the power-of-two pyramid would ask for col ≥ tilesAcross at z = 3.
    assert.ok(2 * 2 ** 3 > tilesAcross(3));
});

ok('across the dateline: two intervals, padded edge tiles clipped to 180°E', () => {
    const v = makeView(-17.7, 179.5, 12);                    // Fiji
    const { z, tiles } = tilePlan(v, W, H);
    const offsets = new Set(tiles.map((t) => t.lonOffset));
    assert.deepEqual([...offsets].sort((a, b) => a - b), [0, 360], 'west side canonical, east side shifted +360');
    const edge = tiles.filter((t) => t.col === tilesAcross(z) - 1);
    assert.ok(edge.length > 0);
    for (const t of edge) {
        assert.ok(t.geo.east - t.lonOffset <= 180 + 1e-9, 'clipped at 180°E');
        assert.ok(t.src.sw < 512 || tileSpanDeg(z) * tilesAcross(z) === 360, 'source rect cut to the real data');
    }
});

ok('the scale bar is a round number that fits', () => {
    const s = scaleBar(makeView(40, -105, 7.5), H);
    assert.ok(s.px <= 120 && s.px > 40, `${s.px}px`);
    assert.match(s.label, /^(1|2|5)0* km$/);
    assert.match(scaleBar(makeView(40, -105, SPAN_MIN_DEG), H, 60).label, /km|m$/);
});

// A 3×4 field, two times, one gap.
const F = {
    latN: 41, lonW: -106, dlat: 0.5, dlon: 0.5, nRows: 3, nCols: 4,
    times: [0, 3 * 3_600_000],
    values: [
        10, 11, 12, 13,   9, 10, 11, 12,   8, 9, 10, 11,     // t0
        20, 21, 22, null, 19, 20, 21, 22,  18, 19, 20, 21,   // t1 (a gap at row 0, col 3)
    ],
};

ok('field sampling: nodes exact, bilinear between, gaps and the outside null', () => {
    assert.equal(fieldSample(F, 0, 41, -106), 10);
    near(fieldSample(F, 0, 40.75, -105.75), 10, 1e-12, 'centre of the first cell');
    assert.equal(fieldSample(F, 1, 40.9, -104.6), null, 'a gap corner is a gap');
    assert.equal(fieldSample(F, 0, 45, -106), null, 'outside the window');
    assert.deepEqual(fieldRange(F, 0), { min: 8, max: 13 });
    assert.equal(fieldTimeIndex(F.times, 2.9 * 3_600_000), 1);
    assert.equal(fieldTimeIndex(F.times, 10 * 3_600_000), null, 'past the run: no frame, never the last one held');
});

ok('heat colours are the site-wide temperature LUT bytes; a gap corner is transparent', () => {
    const lut = buildTempLUTPixels();
    const idx = Math.round(((20 - TEMP_ENCODE_MIN_C) / TEMP_ENCODE_SPAN_C) * (TEMP_LUT_SIZE - 1));
    assert.deepEqual([...heatColor(20, lut).slice(0, 3)], [...lut.slice(idx * 4, idx * 4 + 3)], '20 °C = the LUT byte (no seam far from 0 °C)');
    // F at t1 has a gap at its NE node: the cell next to it draws nothing.
    const v = makeView(40.5, -105, 2);
    const img = heatImage(F, 1, v, 400, 400, lut, { step: 1 });
    const p = geoToPx(v, 400, 400, 40.85, -104.65);         // inside the NE cell
    assert.equal(img.data[(Math.floor(p.y) * img.cw + Math.floor(p.x)) * 4 + 3], 0, 'gap cell transparent');
    const q = geoToPx(v, 400, 400, 40.25, -105.75);         // a complete cell
    assert.equal(img.data[(Math.floor(q.y) * img.cw + Math.floor(q.x)) * 4 + 3], 255);
});

ok('the freezing seam is EarthView’s own: constants pinned to the globe shader’s source', () => {
    const src = readFileSync(new URL('../js/earth-skin.js', import.meta.url), 'utf8');
    const m = /float frz = 1\.0 - smoothstep\(([\d.]+), ([\d.]+), abs\(tC\)\);\s*return c \+ vec3\(([\d.]+)\) \* frz;/.exec(src);
    assert.ok(m, 'weatherOverlay still has the seam expression');
    assert.deepEqual([+m[1], +m[2], +m[3]], [FREEZE_SEAM.innerC, FREEZE_SEAM.outerC, FREEZE_SEAM.gain]);
    assert.equal(freezingSeam(0), 1);
    assert.equal(freezingSeam(0.35), 1);
    assert.equal(freezingSeam(1.1), 0);
    assert.equal(freezingSeam(-0.7), freezingSeam(0.7), 'symmetric about 0 °C');
});

ok('heat is interpolated as a VALUE then coloured; NEGATIVE CONTROL: blending colours paints a hue the ramp never has', () => {
    const lut = buildTempLUTPixels();
    // Two columns of nodes, −10 °C west and +10 °C east: halfway is 0 °C.
    const f = { latN: 1, lonW: 0, dlat: 1, dlon: 1, nRows: 2, nCols: 2, times: [0], values: [-10, 10, -10, 10] };
    const v = makeView(0.5, 0.5, 1);
    const img = heatImage(f, 0, v, 200, 200, lut, { step: 1 });
    const mid = (100 * img.cw + 100) * 4;                  // the pixel at the window centre
    const want = heatColor(fieldSample(f, 0, 0.5, 0.5), lut);
    assert.deepEqual([...img.data.slice(mid, mid + 4)], [...want], 'value-space: LUT(0 °C) + the seam');
    near(fieldSample(f, 0, 0.5, 0.5), 0, 0.06, 'the midpoint is ~0 °C');
    const a = heatColor(-10, lut), b = heatColor(10, lut);
    const blend = [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
    const dist = Math.hypot(...[0, 1, 2].map((k) => blend[k] - want[k]));
    assert.ok(dist > 40, `colour-blending would paint ${blend.map(Math.round)} instead of ${[...want.slice(0, 3)]} (Δ ${dist.toFixed(0)})`);
    assert.ok(want[0] > lut[Math.round(((0 - TEMP_ENCODE_MIN_C) / TEMP_ENCODE_SPAN_C) * (TEMP_LUT_SIZE - 1)) * 4], 'the seam brightens the freezing line');
});

ok('outside the data window the heat image is transparent — nothing is extrapolated', () => {
    const lut = buildTempLUTPixels();
    const img = heatImage(F, 0, makeView(40, -105, 6), 300, 200, lut, { step: 2 });
    let inside = 0, outside = 0;
    for (let j = 0; j < img.ch; j++) for (let i = 0; i < img.cw; i++) {
        const a = img.data[(j * img.cw + i) * 4 + 3];
        const g = pxToGeo(makeView(40, -105, 6), 300, 200, (i + 0.5) * 2, (j + 0.5) * 2);
        const inF = g.lat <= F.latN && g.lat >= F.latN - (F.nRows - 1) * F.dlat && g.lon >= F.lonW && g.lon <= F.lonW + (F.nCols - 1) * F.dlon;
        if (inF) inside += a > 0; else outside += a > 0;
    }
    assert.equal(outside, 0);
    assert.ok(inside > 0);
    assert.equal(heatImage(null, 0, makeView(0, 0), 10, 10, lut).data.every((x) => x === 0), true);
});

ok('extremes are the warmest and coldest NODES, gaps skipped', () => {
    const e = fieldExtremes(F, 1);
    assert.deepEqual(e.max, { v: 22, lat: 41, lon: -105 }, 'two 22s: the first in row order wins');
    assert.deepEqual(e.min, { v: 18, lat: 40, lon: -106 });
    assert.equal(fieldExtremes(F, null), null);
});

console.log(`\n${passed} passed`);
