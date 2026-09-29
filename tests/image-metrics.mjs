/**
 * tests/image-metrics.mjs — the metrics themselves, on synthetic images
 *   node tests/image-metrics.mjs
 *
 * Every metric is shown passing a clean image AND failing the bug it exists
 * to catch, drawn synthetically: a gate that cannot fail is not a gate.
 */
import assert from 'node:assert/strict';
import {
    luminance, horizonDeviation, brightRunStats, runWidths, lineWidths, firstLitRow, coverage,
    seamStep, blobStats, imageFromCapture,
} from './helpers/image-metrics.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

function blank(w, h) { return { w, h, data: new Uint8Array(w * h * 4) }; }
function set(img, x, y, v) {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const j = (y * img.w + x) * 4;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
}
/** Fill everything below the curve y = f(x) with `v`. */
function fillBelow(img, f, v = 160) {
    for (let x = 0; x < img.w; x++) {
        const yc = f(x);
        for (let y = Math.max(0, Math.ceil(yc)); y < img.h; y++) set(img, x, y, v);
    }
}

const W = 400, H = 200;
// A smooth "horizon": a shallow arc.
const arc = (x) => 80 + 0.0006 * (x - W / 2) ** 2;

console.log('\n── luminance ──');
t('luma uses the Rec. 709 weights', () => {
    const img = blank(1, 1);
    img.data.set([255, 0, 0, 255]);
    assert.ok(Math.abs(luminance(img)[0] - 0.2126 * 255) < 1e-3);
});

console.log('\n── horizon ──');
t('a limb drawn where the sphere is deviates by under a pixel', () => {
    const img = blank(W, H);
    fillBelow(img, arc);
    const pred = Array.from({ length: W }, (_, x) => arc(x));
    const r = horizonDeviation(img, pred);
    assert.ok(r.maxDev <= 1, `maxDev ${r.maxDev}`);
    assert.equal(r.missing, 0);
    assert.ok(r.columns > W * 0.9);
});
t('a POLYGON limb (the 720-face planet) is caught', () => {
    const img = blank(W, H);
    // Chords between knots every 100 px sag below... i.e. sit ABOVE the arc
    // when the arc is convex downward on screen; either way they deviate.
    const knots = [0, 100, 200, 300, 399];
    const poly = (x) => {
        let i = 0; while (i < knots.length - 2 && x > knots[i + 1]) i++;
        const a = knots[i], b = knots[i + 1], u = (x - a) / (b - a);
        return arc(a) + (arc(b) - arc(a)) * u;
    };
    fillBelow(img, poly);
    const pred = Array.from({ length: W }, (_, x) => arc(x));
    const r = horizonDeviation(img, pred);
    assert.ok(r.maxDev >= 1.4, `polygon only deviates ${r.maxDev} px`);
    // A coarser polygon deviates more — the metric scales with the defect.
    const img2 = blank(W, H);
    fillBelow(img2, (x) => arc(0) + (arc(W - 1) - arc(0)) * x / (W - 1));
    assert.ok(horizonDeviation(img2, pred).maxDev > 20);
});
t('columns with no predicted limb, or no drawn one, are reported, not scored', () => {
    const img = blank(W, H);
    const pred = new Array(W).fill(NaN);
    pred[10] = 50;
    const r = horizonDeviation(img, pred);
    assert.equal(r.columns, 0);
    assert.equal(r.missing, 1);
});

console.log('\n── bright runs / coverage ──');
function gridImage(lineW) {
    const img = blank(W, H);
    for (let x = 20; x < W; x += 40) for (let y = 0; y < H; y++) for (let k = 0; k < lineW; k++) set(img, x + k, y, 200);
    for (let y = 15; y < H; y += 30) for (let x = 0; x < W; x++) set(img, x, y, 200);
    return img;
}
t('thin grid lines have narrow runs off the horizontal lines', () => {
    const img = gridImage(2);
    const rows = [];
    // Rows between the horizontal lines.
    const r = brightRunStats(img, { row0: 16, row1: 44 });
    assert.ok(r.max <= 2, `max run ${r.max}`);
    assert.ok(coverage(img) < 0.1);
    void rows;
});
t('a wedge (a line bloomed to 30 px) is caught, and so is a flood', () => {
    const img = gridImage(2);
    for (let y = 0; y < H; y++) for (let x = 200; x < 200 + 10 + y / 4; x++) set(img, x, y, 220);
    assert.ok(brightRunStats(img, { row0: 16, row1: 44 }).max >= 12);
    const flood = blank(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x > y) set(flood, x, y, 220);
    assert.ok(coverage(flood) > 0.4);
});

t('run widths see a wedge among lines that legitimately cross the view', () => {
    // Converging 2 px lines plus full-width crossing lines, as a grid seen
    // from above a surface looks.
    const lines = (wedge) => {
        const img = blank(W, H);
        for (let y = 20; y < H; y += 25) for (let x = 0; x < W; x++) set(img, x, y, 200);
        for (let k = -4; k <= 4; k++) {
            for (let y = 0; y < H; y++) {
                const xc = W / 2 + k * (10 + y * 0.4);
                const half = wedge && k === 0 ? 1 + (H - y) * 0.08 : 1;
                for (let x = Math.round(xc - half); x < Math.round(xc + half); x++) set(img, x, y, 200);
            }
        }
        return img;
    };
    const ok = runWidths(lines(false), { maxRun: W / 2 });
    assert.ok(ok.p90 <= 3 && ok.count > 1000, JSON.stringify(ok));
    const bad = runWidths(lines(true), { maxRun: W / 2 });
    assert.ok(bad.p99 >= 12, JSON.stringify(bad));
    assert.equal(firstLitRow(lines(false)), 0);
    assert.equal(firstLitRow(blank(4, 4)), -1);
});

t('half-maximum widths ignore brightness and a dim fill, and still see the wedge', () => {
    // Soft 2-px-FWHM lines (a triangle profile) on a dim fill, at two
    // brightnesses; then the centre line bloomed.
    const soft = (gain, wedge) => {
        const img = blank(W, H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) set(img, x, y, 10);
            for (let k = -3; k <= 3; k++) {
                const xc = W / 2 + k * 50;
                const hw = wedge && k === 0 ? 2 + (H - y) * 0.1 : 2;   // half-width at base
                for (let x = Math.floor(xc - hw); x <= Math.ceil(xc + hw); x++) {
                    const v = Math.max(0, 1 - Math.abs(x - xc) / hw);
                    if (v > 0) set(img, x, y, Math.round(10 + gain * v));
                }
            }
        }
        return img;
    };
    const dim = lineWidths(soft(30, false), { minContrast: 3 });
    const bright = lineWidths(soft(200, false), { minContrast: 3 });
    assert.ok(dim.p99 <= 3 && bright.p99 <= 3, JSON.stringify({ dim, bright }));
    assert.equal(runWidths(soft(200, false), { threshold: 5, maxRun: W / 3 }).count, 0, 'the fill merges plain runs into one per row');
    const bad = lineWidths(soft(200, true), { minContrast: 3 });
    assert.ok(bad.max >= 15, JSON.stringify(bad));
});

console.log('\n── seams ──');
function curtain(seam) {
    const img = blank(W, H);
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let x = 0; x < W; x++) {
        const base = 110 + 40 * Math.sin(x * 0.05) + 30 * rnd();   // rays + folds
        const v = seam && x >= W / 2 ? base * 0.45 : base;
        for (let y = 40; y < 160; y++) set(img, x, y, Math.max(0, Math.min(255, Math.round(v))));
    }
    return img;
}
t('rays and folds without a seam give a small step', () => {
    const r = seamStep(curtain(false), { row0: 40, row1: 160 });
    assert.ok(r.step < 0.35, `step ${r.step}`);
});
t('a hard edge between two plateaus is caught, at the right column', () => {
    const r = seamStep(curtain(true), { row0: 40, row1: 160 });
    assert.ok(r.step > 0.45, `step ${r.step}`);
    assert.ok(Math.abs(r.at - W / 2) <= 2, `found at ${r.at}`);
});

console.log('\n── blobs ──');
t('a soft round dot is small and not square; an uncapped square is caught', () => {
    const dot = blank(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const r = Math.hypot(x - 32, y - 32);
        if (r < 6) set(dot, x, y, Math.round(220 * (1 - Math.max(0, r - 3.3) / 2.7)));
    }
    const a = blobStats(dot);
    assert.ok(a.found && a.width <= 12 && a.fill < 0.9, JSON.stringify(a));
    const sq = blank(64, 64);
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) set(sq, x, y, 200);
    const b = blobStats(sq);
    assert.equal(b.width, 30);
    assert.ok(b.fill > 0.99);
    assert.equal(blobStats(blank(8, 8)).found, false);
});

t('the capture format decodes', () => {
    const img = imageFromCapture({ w: 1, h: 1, b64: Buffer.from([1, 2, 3, 255]).toString('base64') });
    assert.deepEqual(Array.from(img.data), [1, 2, 3, 255]);
});

console.log(`\n${fail ? '✗' : '✓'} image-metrics: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
