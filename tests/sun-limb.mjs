/**
 * tests/sun-limb.mjs — pins the analytic limb in js/sun-limb.js
 *
 *   node tests/sun-limb.mjs
 *
 * THE CLAIM: sun.html's chromosphere / transition-region fringe is read off
 * each pixel's sightline at TRUE scale and pre-filtered over the pixel, and
 * the canvas mesh's silhouette is never the visual edge. What it replaced was
 * pow(rim, n) on a DoubleSide shell — constant across the whole visible
 * annulus and 0.06 R☉ wide — and check 6 keeps that old expression around as
 * the NEGATIVE CONTROL, so this gate can still see the bug it was written for.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    RSUN_MM, H_CHROMO, H_SPICULE, H_TR, H_CHROMO_MM, H_SPICULE_MM, SPICULE_WIDTH, SPICULE_FREQ,
    CHROMO_MESH_R, TR_MESH_R, shellAA, shellPoint, shellOnDisk, sightline, LIMB_GLSL,
} from '../js/sun-limb.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-limb.mjs');

ok('scale heights are the stated megametres, not a look', () => {
    assert.ok(Math.abs(H_CHROMO * RSUN_MM - H_CHROMO_MM) < 1e-12);
    assert.ok(Math.abs(H_SPICULE * RSUN_MM - H_SPICULE_MM) < 1e-12);
    // The whole fringe is gone by ~10 Mm: under 10 % of its base at 10 Mm.
    assert.ok(shellPoint(10 / RSUN_MM, H_SPICULE) < 0.10);
    // …and the chromosphere proper is ~2 Mm deep.
    assert.ok(shellPoint(2.1 / RSUN_MM, H_CHROMO) < 0.25 && H_CHROMO < H_TR && H_TR < H_SPICULE);
});

ok('shellAA is the box integral of the point profile (vs quadrature)', () => {
    for (const H of [H_CHROMO, H_SPICULE]) for (const pix of [H * 0.05, H * 0.7, H * 4, H * 40]) for (const h of [-pix, -0.2 * pix, 0, 0.3 * pix, H, 3 * H, 3 * H + pix]) {
        const N = 4000; let acc = 0;
        for (let i = 0; i < N; i++) acc += shellPoint(h - 0.5 * pix + pix * (i + 0.5) / N, H);
        const quad = acc / N, got = shellAA(h, H, pix);
        assert.ok(Math.abs(got - quad) < 2e-3 + 2e-3 * quad, `H=${H} pix=${pix} h=${h}: ${got} vs ${quad}`);
    }
});

ok('a sub-pixel shell keeps its ENERGY: Σ over pixels = H, whatever the pixel size', () => {
    for (const pix of [H_CHROMO * 0.1, H_CHROMO, H_CHROMO * 9, H_CHROMO * 60]) {
        let sum = 0;
        for (let k = -3; k < 4000; k++) sum += shellAA((k + 0.37) * pix, H_CHROMO, pix) * pix;
        assert.ok(Math.abs(sum - H_CHROMO) / H_CHROMO < 1e-3, `pix ${pix}: ${sum} vs ${H_CHROMO}`);
    }
    // Negative control — point sampling does NOT: at 60 scale heights per pixel
    // the answer depends on where the sample happens to fall.
    const pix = H_CHROMO * 60;
    const a = shellPoint(0.01 * pix, H_CHROMO) * pix, b = shellPoint(0.6 * pix, H_CHROMO) * pix;
    assert.ok(Math.abs(a - b) / H_CHROMO > 10, 'point sampling should alias here');
});

ok('the mesh silhouette is never the visual edge', () => {
    for (const [R, H] of [[CHROMO_MESH_R, H_SPICULE * 1.45], [TR_MESH_R, H_SPICULE]]) {
        assert.ok(shellPoint(R - 1 - 0.003, H) < 2e-2, `emission at the canvas edge of r=${R}: ${shellPoint(R - 1 - 0.003, H)}`);
    }
    assert.ok(shellPoint(CHROMO_MESH_R - 1, H_CHROMO) < 1e-10);
});

ok('on the disc the shell is invisible except in the outer 0.1 % of the radius', () => {
    assert.equal(shellOnDisk(0.0, H_CHROMO), 0.5);
    assert.ok(shellOnDisk(1.0, H_CHROMO) < 0.02);                      // disc centre
    const muAt = (b) => Math.sqrt(1 - b * b);
    assert.ok(shellOnDisk(muAt(0.995), H_CHROMO) < 0.2);
    assert.ok(shellOnDisk(muAt(0.99999), H_CHROMO) === 0.5);
});

ok('NEGATIVE CONTROL: the old pow(rim, n) limb is flat across the annulus; the new one is not', () => {
    // Old: back faces of an r = 1.06 shell, rim = 1 − max(n·v, 0) = 1 everywhere in the annulus.
    const oldAt = () => Math.pow(1 - Math.max(-0.4, 0), 2.2) * 0.45;       // n·v < 0 on a back face
    const hs = [0.002, 0.01, 0.02, 0.04, 0.055];
    const oldV = hs.map(oldAt), newV = hs.map((h) => shellAA(h, H_SPICULE, 1e-4));
    assert.ok(Math.max(...oldV) - Math.min(...oldV) < 1e-12, 'old profile is constant');
    assert.ok(newV[0] / newV[newV.length - 1] > 1e3, 'new profile falls by orders of magnitude');
    for (let i = 1; i < newV.length; i++) assert.ok(newV[i] < newV[i - 1]);
});

ok('sightline(): impact parameter, mu and the point the ray is about', () => {
    const c = [0, 0, 6];
    // Straight at disc centre.
    let s = sightline(c, [0, 0, 1.06]);
    assert.ok(s.b < 1e-12 && Math.abs(s.mu - 1) < 1e-12 && s.onDisk);
    assert.ok(Math.abs(s.n[2] - 1) < 1e-12);
    // A ray whose closest approach is 1.02 R☉ on +x.
    const tgt = [1.02, 0, 0];
    const d = Math.hypot(tgt[0] - c[0], tgt[2] - c[2]);
    const ray = [(tgt[0] - c[0]) / d, 0, (tgt[2] - c[2]) / d];
    const bTrue = Math.abs(c[0] * ray[2] - c[2] * ray[0]);
    s = sightline(c, [c[0] + ray[0] * 5, 0, c[2] + ray[2] * 5]);
    assert.ok(Math.abs(s.b - bTrue) < 1e-12 && !s.onDisk && s.mu === 0);
    assert.ok(Math.abs(Math.hypot(...s.n) - 1) < 1e-12 && s.n[0] > 0.9);
    // On the disc the point is ON the unit sphere along the ray: b² + mu² = 1.
    s = sightline(c, [0.5, 0.3, 1.0]);
    assert.ok(s.onDisk && Math.abs(s.b * s.b + s.mu * s.mu - 1) < 1e-12);
    // Independent of where along the ray the canvas fragment sits (tessellation-proof).
    const s2 = sightline(c, [c[0] + (0.5 - c[0]) * 0.7, c[1] + (0.3 - c[1]) * 0.7, c[2] + (1.0 - c[2]) * 0.7]);
    assert.ok(Math.abs(s2.b - s.b) < 1e-12 && Math.abs(s2.n[0] - s.n[0]) < 1e-12);
});

ok('the GLSL is generated from these constants and sun.html uses it for BOTH shells', () => {
    const num = (x) => { const t = String(x); return /[.e]/.test(t) ? t : t + '.0'; };
    for (const v of [H_CHROMO, H_SPICULE, H_TR, SPICULE_WIDTH, SPICULE_FREQ]) assert.ok(LIMB_GLSL.includes(num(v)), `LIMB_GLSL carries ${v}`);
    assert.ok(!LIMB_GLSL.includes('`'), 'no backtick inside the GLSL literal');
    const html = readFileSync(new URL('../sun.html', import.meta.url), 'utf8');
    const block = (name, end) => html.slice(html.indexOf(`const ${name} = /* glsl */`), html.indexOf(end));
    for (const [name, end] of [['chromoFS', 'const chromoMesh'], ['trFS', 'const trMesh']]) {
        const src = block(name, end);
        assert.ok(src.includes('${LIMB_GLSL}') && src.includes('sightline();'), `${name} reads the kernel`);
        // No limb term may be a bare pow(rim, n) again: every one is either
        // gated to the disc or multiplied by a shell envelope.
        const stray = src.split('\n').filter((l) => /pow\(rim,/.test(l) && /alpha/.test(l) && !/sightDisk|limbEnv|fringeEnv|evt/.test(l));
        assert.deepEqual(stray, [], `${name}: alpha term on bare pow(rim): ${stray.join(' | ')}`);
        assert.ok(!/normalize\(vNormal\)/.test(src), `${name} no longer takes heliographic coordinates from the view-space normal`);
    }
    assert.ok(/SphereGeometry\(CHROMO_MESH_R[^)]*\),\s*new THREE\.ShaderMaterial\(\{[^}]*side:THREE\.FrontSide/s.test(html), 'chromosphere canvas is FrontSide');
    assert.ok(/SphereGeometry\(TR_MESH_R[^)]*\),\s*new THREE\.ShaderMaterial\(\{[^}]*side: THREE\.FrontSide/s.test(html), 'TR canvas is FrontSide');
    assert.ok(html.includes('uniforms.u_limbObs.value = sunOffLimb ? sunOffLimb.limbWeight : 0.0'), 'the model fringe yields to the observed limb');
});

console.log(`${passed} checks passed (sun-limb)`);
