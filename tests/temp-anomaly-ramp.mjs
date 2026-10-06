/**
 * tests/temp-anomaly-ramp.mjs — js/temp-anomaly-ramp.js
 *
 *   node tests/temp-anomaly-ramp.mjs
 *
 * The anomaly ramp is the lab's ONE colour source (map, legend, chips,
 * EarthView mini-map). Gates:
 *   • LUT shape, opaque, endpoints = the terminal stops, deterministic
 *   • 0 K and the 50th percentile land on the neutral stop; a gap is null,
 *     never painted as "normal"
 *   • the class edges 10 / 33⅓ / 66⅔ / 90 sit EXACTLY on stops
 *   • CVD: under the Machado (2009) severity-1 protan / deutan / tritan
 *     simulations, CIELAB lightness still rises to the pivot and falls after
 *     it, and every cold stop stays distinguishable from its mirrored warm
 *     stop (a reader with CVD must still tell +5 K from −5 K)
 */
import assert from 'node:assert/strict';
import {
    ANOMALY_RAMP_STOPS, ANOMALY_KNOTS_K, PERCENTILE_KNOTS, ANOMALY_LUT_SIZE,
    anomalyToFrac, percentileToFrac, rampColorAt, buildAnomalyLUTPixels, anomalyCss, inkOn,
} from '../js/temp-anomaly-ramp.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('temp-anomaly-ramp.mjs');

// ── colour science (sRGB ↔ linear, Machado 2009 severity 1, CIELAB D65) ────
const toLin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const toSrgb = (l) => { const v = Math.max(0, Math.min(1, l)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
const MACHADO = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
function simulate(rgb, kind) {
    if (kind === 'normal') return rgb;
    const lin = rgb.map(toLin), M = MACHADO[kind];
    return M.map(row => toSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
}
function lab(rgb) {
    const [r, g, b] = rgb.map(toLin);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const KINDS = ['normal', 'protan', 'deutan', 'tritan'];
const PIVOT = 5;

ok('LUT: 256×4, opaque, terminal stops exact, deterministic', () => {
    const px = buildAnomalyLUTPixels();
    assert.equal(px.length, ANOMALY_LUT_SIZE * 4);
    for (let i = 0; i < ANOMALY_LUT_SIZE; i++) assert.equal(px[i * 4 + 3], 255);
    assert.deepEqual([...px.slice(0, 3)], ANOMALY_RAMP_STOPS[0]);
    assert.deepEqual([...px.slice(-4, -1)], ANOMALY_RAMP_STOPS[10]);
    assert.deepEqual(buildAnomalyLUTPixels(), px);
});

ok('0 K and p50 are the neutral stop; a gap is null, never "normal"', () => {
    assert.equal(anomalyToFrac(0), 0.5);
    assert.equal(percentileToFrac(50), 0.5);
    assert.deepEqual(rampColorAt(0.5), ANOMALY_RAMP_STOPS[PIVOT]);
    assert.equal(anomalyToFrac(null), null);
    assert.equal(anomalyToFrac(NaN), null);
    assert.equal(percentileToFrac(undefined), null);
    assert.equal(anomalyCss(null, 'none'), 'none');
});

ok('knots: symmetric, increasing, class edges on stops, clamped beyond', () => {
    for (const knots of [ANOMALY_KNOTS_K, PERCENTILE_KNOTS]) {
        assert.equal(knots.length, ANOMALY_RAMP_STOPS.length);
        for (let i = 1; i < knots.length; i++) assert.ok(knots[i] > knots[i - 1]);
    }
    for (let i = 0; i < ANOMALY_KNOTS_K.length; i++) assert.equal(ANOMALY_KNOTS_K[i], -ANOMALY_KNOTS_K[10 - i] || 0);
    for (const [p, stop] of [[10, 3], [100 / 3, 4], [200 / 3, 6], [90, 7]]) {
        assert.ok(Math.abs(percentileToFrac(p) - stop / 10) < 1e-12, `p${p} on stop ${stop}`);
    }
    assert.equal(anomalyToFrac(-40), 0);
    assert.equal(anomalyToFrac(40), 1);
    assert.ok(anomalyToFrac(2) > anomalyToFrac(1) && anomalyToFrac(2) < anomalyToFrac(3));
});

const measured = {};
ok('CVD: lightness rises to the pivot and falls after it, in every vision', () => {
    for (const kind of KINDS) {
        const L = ANOMALY_RAMP_STOPS.map(s => lab(simulate(s, kind))[0]);
        for (let i = 1; i <= PIVOT; i++) assert.ok(L[i] > L[i - 1], `${kind}: cold arm L* not rising at ${i} (${L[i - 1].toFixed(1)} → ${L[i].toFixed(1)})`);
        for (let i = PIVOT + 1; i < L.length; i++) assert.ok(L[i] < L[i - 1], `${kind}: warm arm L* not falling at ${i}`);
    }
});

ok('CVD: every cold stop stays distinguishable from its mirrored warm stop (ΔE76 ≥ 15)', () => {
    for (const kind of KINDS) {
        let worst = Infinity;
        for (let i = 0; i < PIVOT; i++) {
            const d = dE(lab(simulate(ANOMALY_RAMP_STOPS[i], kind)), lab(simulate(ANOMALY_RAMP_STOPS[10 - i], kind)));
            worst = Math.min(worst, d);
        }
        measured[kind] = worst;
        assert.ok(worst >= 15, `${kind}: ±mirror ΔE ${worst.toFixed(1)}`);
    }
    if (process.env.RAMP_LOG) console.log('     worst ±mirror ΔE76:', Object.entries(measured).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
});

ok('CVD: adjacent stops stay apart (ΔE76 ≥ 8) in every vision', () => {
    for (const kind of KINDS) {
        for (let i = 1; i < ANOMALY_RAMP_STOPS.length; i++) {
            const d = dE(lab(simulate(ANOMALY_RAMP_STOPS[i - 1], kind)), lab(simulate(ANOMALY_RAMP_STOPS[i], kind)));
            assert.ok(d >= 8, `${kind}: stops ${i - 1}/${i} ΔE ${d.toFixed(1)}`);
        }
    }
});

ok('negative control: a red–green ramp of matched lightness FAILS the deutan mirror test', () => {
    // The classic CVD trap — distinguishable to normal vision, not to deutans.
    const green = [0x1b, 0x9e, 0x3e], red = [0xd9, 0x5f, 0x5f];
    assert.ok(dE(lab(green), lab(red)) >= 15, 'normal vision tells them apart');
    assert.ok(dE(lab(simulate(green, 'deutan')), lab(simulate(red, 'deutan'))) < 15,
        'the simulation collapses them, so the gate above can fail');
});

ok('inkOn picks readable text over the ends and the middle', () => {
    assert.equal(inkOn(ANOMALY_RAMP_STOPS[0]), '#fff');
    assert.equal(inkOn(ANOMALY_RAMP_STOPS[PIVOT]), '#000');
    assert.equal(inkOn(ANOMALY_RAMP_STOPS[10]), '#fff');
});

console.log(`\n${passed} passed`);
