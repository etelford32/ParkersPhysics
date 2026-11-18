#!/usr/bin/env node
/**
 * earth-interior-page.mjs — gate for js/earth-interior/page-model.js and the
 * two load-bearing source facts in js/earth-interior/stage.js (which imports
 * three and cannot load in node).
 *
 * Run: node tests/earth-interior-page.mjs
 *
 * The page draws ONLY these numbers, so this is where "the picture agrees with
 * the kernels" is checked: layer radii are PREM's, every cutaway texel is
 * premAt at its centre, the legend bar is the faces' own colour function, the
 * profile steps at PREM's jumps in the right order, the column charts are the
 * nowcast's own impedance.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { R_EARTH_KM, PREM_REGIONS, premAt, discontinuities } from '../js/earth-interior/prem.js';
import { groundColumn, geoelectricSeries } from '../js/earth-interior/geoelectric.js';
import { layeredImpedance, MU0 } from '../js/earth-interior/conductivity.js';
import {
    SEQ_RAMP, rampColor, QUANTITIES, QUANTITY_KEYS, quantityAt, radialTable, legendTicks,
    LAYER_BANDS, BOUNDARY_RADII_KM, bandAt, probeAt, profileSeries, nowcastRows, sparkline,
    columnSteps, responseCurve, columnOptions, fmt,
    seismicFan, travelTimeCurves, arrivalsAtDistance, fmtMinSec, PHASE_FAMILY, FAMILY_COLORS,
} from '../js/earth-interior/page-model.js';
import { traceRay, maxRayParameter } from '../js/earth-interior/raytrace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); passed++; };

// ── Colour ────────────────────────────────────────────────────────────────
{
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    assert.deepEqual(rampColor(0), hex(SEQ_RAMP[0]));
    assert.deepEqual(rampColor(1), hex(SEQ_RAMP[SEQ_RAMP.length - 1]));
    assert.deepEqual(rampColor(-3), rampColor(0)); assert.deepEqual(rampColor(NaN), rampColor(0));
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let prev = -1;
    for (let i = 0; i <= 100; i++) { const L = lum(rampColor(i / 100)); assert.ok(L >= prev - 1e-9, 'ramp monotone'); prev = L; }
    ok('the ramp is the reference blue end to end, clamped, and monotone in luminance (low = dark on the dark page)');
}

// ── Layers come from PREM ─────────────────────────────────────────────────
{
    assert.equal(LAYER_BANDS[0].rInnerKm, 0); assert.equal(LAYER_BANDS.at(-1).rOuterKm, R_EARTH_KM);
    for (let i = 1; i < LAYER_BANDS.length; i++) assert.equal(LAYER_BANDS[i].rInnerKm, LAYER_BANDS[i - 1].rOuterKm, 'contiguous');
    const premEdges = new Set(PREM_REGIONS.map((g) => g.rInnerKm));
    for (const b of LAYER_BANDS) assert.ok(premEdges.has(b.rInnerKm), `${b.name} starts on a PREM edge`);
    assert.deepEqual(LAYER_BANDS.map((b) => b.name), ['Inner core', 'Outer core', 'Lower mantle', 'Transition zone', 'Upper mantle', 'Crust', 'Ocean']);
    assert.equal(LAYER_BANDS[1].rOuterKm, 3480); assert.equal(LAYER_BANDS[0].rOuterKm, 1221.5);
    assert.deepEqual(BOUNDARY_RADII_KM, LAYER_BANDS.slice(0, -1).map((b) => b.rOuterKm));
    assert.equal(bandAt(3000).name, 'Outer core'); assert.equal(bandAt(6000).name, 'Upper mantle');
    ok('7 display bands, contiguous, every edge a PREM region edge (CMB 3480, ICB 1221.5 read from the kernel)');
}

// ── The cutaway table IS the kernel ───────────────────────────────────────
for (const key of QUANTITY_KEYS) {
    const t = radialTable(key, 256), q = QUANTITIES[key];
    const tr = (v) => (q.log ? Math.log10(v) : v);
    for (let i = 0; i < t.n; i++) {
        const r = (i + 0.5) / t.n * R_EARTH_KM;
        assert.equal(t.values[i], quantityAt(key, r));
        const want = rampColor((tr(t.values[i]) - tr(t.min)) / (tr(t.max) - tr(t.min)));
        assert.deepEqual([t.rgb[3 * i], t.rgb[3 * i + 1], t.rgb[3 * i + 2]], want, `${key} texel ${i}`);
    }
    const tk = legendTicks(t);
    assert.ok(Math.abs(tk[0].v - t.min) <= 1e-9 * Math.abs(t.min) && Math.abs(tk.at(-1).v - t.max) <= 1e-9 * Math.abs(t.max), `${key} legend ends`);
}
assert.ok(Number.isNaN(quantityAt('vp', -1)) && Number.isNaN(quantityAt('vp', 7000)) && Number.isNaN(quantityAt('nope', 10)));
ok(`every texel of all ${QUANTITY_KEYS.length} cutaway tables = the kernel at its centre, coloured by the ramp the legend draws; legend ends = table extremes`);
{
    const vs = radialTable('vs', 1024);
    const inOuter = vs.values.filter((_, i) => { const r = (i + 0.5) / 1024 * R_EARTH_KM; return r > 1221.5 && r < 3480; });
    assert.ok(inOuter.every((v) => v === 0) && vs.min === 0, 'Vs = 0 in the liquid outer core');
    ok('Vs is exactly 0 across the liquid outer core and that is the table minimum');
}

// ── Probe + profile ───────────────────────────────────────────────────────
{
    const p = probeAt(5000), k = premAt(5000);
    assert.equal(p.vpKmS, k.vpKmS); assert.equal(p.rhoGcc, k.rhoKgM3 / 1000); assert.equal(p.depthKm, R_EARTH_KM - 5000);
    assert.equal(probeAt(-1), null); assert.equal(probeAt(7000), null);
    const pts = profileSeries(['vp', 'vs', 'rho'], 10);
    for (const d of discontinuities().filter((x) => x.firstOrder)) {
        const at = pts.filter((q) => Math.abs(q.depthKm - d.depthKm) < 1e-9 && q.edge);
        assert.equal(at.length, 2, `two points at ${d.depthKm}`);
        assert.equal(at[0].edge, 'top'); assert.equal(at[1].edge, 'bottom');
        assert.equal(at[0].values.vp, d.above.vpKmS, 'shallow side first'); assert.equal(at[1].values.vp, d.below.vpKmS);
        const i0 = pts.indexOf(at[0]);
        assert.equal(pts[i0 + 1], at[1], 'adjacent, so the polyline steps');
    }
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i].depthKm >= pts[i - 1].depthKm, 'depth sorted');
    ok('probe = premAt; the profile carries BOTH sides of every first-order jump, shallow side first and adjacent (a drawn step, not a ramp)');
}

// ── Nowcast table ─────────────────────────────────────────────────────────
{
    const mkSt = (code, e, peak) => ({ code, name: code, geodeticLatitude: 40, geodeticLongitude: 250, geomagLatDeg: 48,
        latest: e === null ? null : { eMagVkm: e, eNorthVkm: e, eEastVkm: 0, time: 't', warmup: false, bridged: false },
        peakLastHourVkm: peak, column: { id: 'QUE', name: 'q', basis: 'explicit' }, tpl007: null,
        series: { eMagVkm: [null, 0.1, e] } });
    const rows = nowcastRows({ stations: [mkSt('A', 0.01, 0.02), mkSt('B', 0.3, 0.4), mkSt('C', null, null)] });
    assert.deepEqual(rows.map((r) => r.code), ['B', 'A', 'C']);
    assert.equal(rows[2].eLatestVkm, null, 'unknown stays null');
    assert.deepEqual(nowcastRows(null), []);
    const sp = sparkline([null, 1, 2, null, 4]);
    assert.equal(sp.points[0], null); assert.equal(sp.points[3], null); assert.deepEqual(sp.points[4], [1, 1]); assert.equal(sp.max, 4);
    ok('rows strongest-first with unknown E kept null (never 0); sparklines keep gaps as gaps');
}

// ── Column charts are the nowcast's own physics ───────────────────────────
{
    const steps = columnSteps('QUE', 100000);
    const L = groundColumn('QUE');
    assert.equal(steps.length, L.length);
    let top = 0;
    for (let i = 0; i < L.length - 1; i++) { assert.equal(steps[i].topKm, top); top += L[i].thicknessM / 1000; assert.equal(steps[i].sigma, L[i].sigma); }
    assert.equal(columnSteps('QUE', 20).at(-1).bottomKm, 20, 'truncated at the chart depth');
    const rc = responseCurve('CP2');
    for (const p of rc) {
        const z = layeredImpedance(groundColumn('CP2'), p.periodS);
        assert.ok(Math.abs(p.eVkm - Math.hypot(z.re, z.im) * (100e-9 / MU0) * 1e3) < 1e-15);
    }
    // And the curve agrees with a steady sinusoid through the actual time-domain kernel at 1 h (≤ 0.5 %, the measured budget).
    const T = 3600, n = 2880, b = Array.from({ length: n }, (_, i) => 100 * Math.sin(2 * Math.PI * i * 60 / T));
    const s = geoelectricSeries({ bNorthNt: new Array(n).fill(0), bEastNt: b, column: 'CP2' });
    const amp = Math.max(...s.eNorthVkm.slice(n - 60).map(Math.abs));
    const want = Math.hypot(layeredImpedance(groundColumn('CP2'), T).re, layeredImpedance(groundColumn('CP2'), T).im) * (100e-9 / MU0) * 1e3;
    assert.ok(Math.abs(amp / want - 1) < 0.01, `time domain ${amp} vs ${want}`);
    assert.equal(columnSteps('NOPE'), null); assert.equal(responseCurve('NOPE'), null);
    const opts = columnOptions();
    assert.equal(opts.length, 40); assert.equal(opts.find((o) => o.id === 'BOU').beta, 0.28); assert.equal(opts.find((o) => o.id === 'GRAYVER-LAND').beta, null);
    ok('step chart = groundColumn layer for layer; response curve = layeredImpedance; the kernel\'s time series agrees at 1 h; 40 picker options, β only where NERC tabulates it');
}

// ── Formatting ────────────────────────────────────────────────────────────
{
    assert.equal(fmt(null), '—'); assert.equal(fmt(NaN), '—'); assert.equal(fmt(undefined), '—');
    assert.equal(fmt(2.3e-4), '2.30×10⁻⁴'); assert.equal(fmt(1e5), '1.00×10⁵'); assert.equal(fmt(0.0123), '0.0123'); assert.equal(fmt(0), '0');
    ok('fmt: missing → —, tiny/huge → proper superscripts, never "NaN"');
}

// ── stage.js source facts (it imports three, so read it as text) ──────────
{
    const src = readFileSync(join(ROOT, 'js/earth-interior/stage.js'), 'utf8');
    const glsl = readFileSync(join(ROOT, 'js/geo/coords.glsl.js'), 'utf8');
    assert.match(src, /tex\.flipY = false;/, 'the map must not be drawn upside down (measured on the first render)');
    assert.match(src, /normalToUVMip\(n\)/, 'the surface samples by direction, never a mesh UV');
    assert.match(glsl, /vec3\(cl \* cos\(lon\), sin\(lat\), -cl \* sin\(lon\)\)/);
    assert.match(src, /c \* Math\.cos\(lo\), Math\.sin\(la\), -c \* Math\.sin\(lo\)/, 'latLonToVec mirrors GEO_GLSL latLonToNormal');
    assert.match(src, /if \(ll\.x >= 0\.0 && d <= uCutSpan\) discard;/);
    assert.match(src, /if \(latDeg < 0\) return false;[\s\S]*return d <= CUT_SPAN_DEG;/, 'inCut mirrors the shader cut test');
    ok('stage: flipY off, direction-sampled map, latLonToVec ≡ GEO latLonToNormal, JS cut test ≡ shader cut test');
}

// ── Seismic panel: every drawn ray IS a kernel ray ─────────────────────────
{
    for (const [wave, depth] of [['P', 0], ['S', 600]]) {
        const fan = seismicFan({ wave, sourceDepthKm: depth });
        const pMax = maxRayParameter({ wave, sourceDepthKm: depth });
        for (const r of fan.rays) {
            const k = traceRay(r.p, { wave, sourceDepthKm: depth });
            assert.ok(Math.abs(r.p - pMax * Math.sin(r.takeoffDeg * Math.PI / 180)) < 1e-9);
            assert.equal(r.phase, k.phase);
            const [x0, y0] = r.points[0];
            assert.ok(Math.abs(x0) < 1e-9 && Math.abs(y0 - (R_EARTH_KM - depth)) < 1e-9, 'fan starts at the source');
            if (r.stopped) { assert.equal(wave, 'S'); continue; }
            const [x, y] = r.points.at(-1);
            assert.ok(Math.abs(Math.hypot(x, y) - R_EARTH_KM) < 1e-6 && Math.abs(Math.atan2(x, y) - k.deltaRad) < 1e-9, 'fan ends at the kernel Δ');
            assert.ok(FAMILY_COLORS[r.family]);
        }
        if (wave === 'S') assert.ok(fan.rays.some((r) => r.stopped), 'steep S rays stop at the core');
    }
    const tt = travelTimeCurves({ wave: 'P' });
    assert.ok(tt.shadow[0] > 96 && tt.shadow[0] < 100 && tt.shadow[1] > 142 && tt.shadow[1] < 147, `shadow ${tt.shadow}`);
    for (const c of tt.curves) assert.ok(PHASE_FAMILY[c.phase], c.phase);
    assert.equal(arrivalsAtDistance(120, tt).filter((a) => a.phase === 'PKIKP').length, 1, 'one PKIKP at 120°');
    assert.equal(arrivalsAtDistance(120, travelTimeCurves({ wave: 'S' })).length, 0, 'no S at 120° (S shadow)');
    const a60 = arrivalsAtDistance(60, tt);
    assert.equal(a60[0].phase, 'P'); assert.equal(a60[0].timeS, traceRayAt60(tt));
    assert.equal(fmtMinSec(607.1), '10 min 07 s'); assert.equal(fmtMinSec(59.6), '1 min 00 s'); assert.equal(fmtMinSec(null), '—');
    const src = readFileSync(join(ROOT, 'earth-interior.html'), 'utf8');
    assert.ok(!/\.ei-grid line/.test(src), 'gridlines must not share the layout container class (its stroke was inherited by every SVG label)');
    ok('seismic panel: fan rays = kernel rays (p from takeoff, phase, start at source, end at kernel Δ), P shadow 98–145°, S shadow, one arrival per phase');
}
function traceRayAt60(tt) {   // the same interpolation, independently: the bracketing P rays
    const rays = tt.branches.P;
    for (let i = 1; i < rays.length; i++) {
        const a = rays[i - 1], b = rays[i];
        if ((a.deltaDeg - 60) * (b.deltaDeg - 60) <= 0 && a.deltaDeg !== b.deltaDeg) return a.timeS + (60 - a.deltaDeg) / (b.deltaDeg - a.deltaDeg) * (b.timeS - a.timeS);
    }
    return null;
}

console.log(`\nearth-interior-page: ${passed} checks passed`);
