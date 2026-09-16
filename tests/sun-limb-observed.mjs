/**
 * tests/sun-limb-observed.mjs — pins js/sun-limb-observed.js (the observed
 * off-limb plane)
 *
 *   node tests/sun-limb-observed.mjs
 *
 *   • the plane's (a, b) → (u, v) mapping IS the disk's projectDiskUV with
 *     q = (a, b, ·) — one geometry, two surfaces
 *   • the sky-plane basis is orthonormal and its normal is Earth's direction
 *   • frame extents per instrument: AIA reaches 1.28 R☉ at the edge and 1.81
 *     at the corners; HMI barely clears the limb
 *   • the mask is 0 on the disk, 1 just above the limb, 0 at the frame edge
 *   • the view weight is 1 on-axis, 0 past 60°, symmetric front/back
 *   • only the EUV passbands get a plane; white light and the magnetogram
 *     never do, whatever the view; a model disk never does
 *   • the GLSL carries the same constants as the mask (no drift)
 */
import assert from 'node:assert/strict';
import {
    LIMB_INNER, LIMB_FEATHER, LIMB_EDGE_FEATHER, LIMB_PLANE_HALF, VIEW_FULL_DEG, VIEW_ZERO_DEG, BACKGROUND_FLOOR,
    frameEdgeRadius, frameCornerRadius, skyPlaneBasis, planePointToUV, viewWeight, limbMask,
    channelHasOffLimb, limbState, LIMB_FRAG, LIMB_VERT,
} from '../js/sun-limb-observed.js';
import { projectDiskUV, DISK_FRACTION, CHANNELS } from '../js/sun-observed.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-limb-observed.mjs');
const DEG = Math.PI / 180;

ok('the plane mapping IS the disk mapping: (a, b) on the sky plane and q = (a, b, ·) give the same (u, v)', () => {
    const geom = { cx: 0.503, cy: 0.497, r: 0.39, b0Rad: -4 * DEG };
    const { xAxis, yAxis } = skyPlaneBasis(geom.b0Rad);
    for (const [a, b] of [[0, 0], [1.05, 0], [0, -1.2], [0.8, 0.9], [-1.5, 0.3]]) {
        // A sky-plane point in the object frame, fed through the disk's own projection…
        const p = [a * xAxis[0] + b * yAxis[0], a * xAxis[1] + b * yAxis[1], a * xAxis[2] + b * yAxis[2]];
        const d = projectDiskUV(p, geom);
        const m = planePointToUV(a, b, geom);
        assert.ok(Math.abs(d.u - m.u) < 1e-12 && Math.abs(d.v - m.v) < 1e-12, `(${a}, ${b}) → disk (${d.u}, ${d.v}) vs plane (${m.u}, ${m.v})`);
    }
});

ok('the sky-plane basis is orthonormal and its normal is Earth\'s direction (0, sin B0, cos B0)', () => {
    for (const b0 of [-7.25 * DEG, -4 * DEG, 0, 3 * DEG, 7.25 * DEG]) {
        const { normal, xAxis, yAxis } = skyPlaneBasis(b0);
        const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        for (const v of [normal, xAxis, yAxis]) assert.ok(Math.abs(dot(v, v) - 1) < 1e-12);
        assert.ok(Math.abs(dot(normal, xAxis)) < 1e-12 && Math.abs(dot(normal, yAxis)) < 1e-12 && Math.abs(dot(xAxis, yAxis)) < 1e-12);
        assert.ok(Math.abs(normal[1] - Math.sin(b0)) < 1e-12 && Math.abs(normal[2] - Math.cos(b0)) < 1e-12);
        // x̂ × ŷ = normal (right-handed: image right × image up = toward the observer)
        const cx = xAxis[1] * yAxis[2] - xAxis[2] * yAxis[1], cy = xAxis[2] * yAxis[0] - xAxis[0] * yAxis[2], cz = xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0];
        assert.ok(Math.abs(cx - normal[0]) < 1e-12 && Math.abs(cy - normal[1]) < 1e-12 && Math.abs(cz - normal[2]) < 1e-12);
    }
});

ok('frame extents: an AIA frame reaches 1.28 R☉ at its edge and 1.81 at the corners; HMI clears the limb by 7 %', () => {
    const aia = { r: DISK_FRACTION.aia }, hmi = { r: DISK_FRACTION.hmi };
    assert.ok(Math.abs(frameEdgeRadius(aia) - 1.282) < 0.002, `AIA edge ${frameEdgeRadius(aia)}`);
    assert.ok(Math.abs(frameCornerRadius(aia) - 1.813) < 0.002, `AIA corner ${frameCornerRadius(aia)}`);
    assert.ok(Math.abs(frameEdgeRadius(hmi) - 1.075) < 0.002, `HMI edge ${frameEdgeRadius(hmi)}`);
    assert.ok(LIMB_PLANE_HALF >= frameCornerRadius(aia), 'the plane covers the corners');
});

ok('the mask is 0 on the disk, 1 just above the limb, and 0 again at the frame edge', () => {
    const rEdge = frameEdgeRadius({ r: DISK_FRACTION.aia });
    assert.equal(limbMask(0.5, rEdge), 0);
    assert.equal(limbMask(1.0, rEdge), 0, 'exactly the limb: still 0');
    assert.ok(limbMask(LIMB_INNER + LIMB_FEATHER, rEdge) > 0.999, 'fully in just above the feather');
    assert.ok(limbMask(1.1, rEdge) > 0.999);
    assert.ok(limbMask(rEdge - LIMB_EDGE_FEATHER / 2, rEdge) > 0.4 && limbMask(rEdge - LIMB_EDGE_FEATHER / 2, rEdge) < 0.6, 'half-way through the edge feather');
    assert.equal(limbMask(rEdge, rEdge), 0);
    assert.equal(limbMask(rEdge + 0.5, rEdge), 0);
    let prev = 0;
    for (let rho = 1.0; rho <= 1.1; rho += 0.005) { const m = limbMask(rho, rEdge); assert.ok(m >= prev - 1e-12); prev = m; }
});

ok('the view weight is 1 within 30° of the Sun–Earth line, 0 past 60°, and symmetric front/back', () => {
    assert.equal(viewWeight(1), 1);
    assert.equal(viewWeight(-1), 1, 'the far-side viewer sees the plane (through the DoubleSide) at full weight — the fade is about the angle, not the side');
    assert.ok(viewWeight(Math.cos(VIEW_FULL_DEG * DEG)) > 0.999);
    assert.ok(viewWeight(Math.cos(45 * DEG)) > 0.2 && viewWeight(Math.cos(45 * DEG)) < 0.8, 'mid-fade at 45°');
    assert.equal(viewWeight(Math.cos(VIEW_ZERO_DEG * DEG)), 0);
    assert.equal(viewWeight(0), 0, 'edge-on: nothing');
    assert.ok(VIEW_FULL_DEG < VIEW_ZERO_DEG);
});

ok('only the EUV passbands get a plane; white light and the magnetogram never do; a model disk never does', () => {
    for (const k of ['94', '131', '171', '193', '211', '304']) assert.equal(channelHasOffLimb(k), true, k);
    assert.equal(channelHasOffLimb('white'), false);
    assert.equal(channelHasOffLimb('mag'), false);
    assert.equal(channelHasOffLimb('nope'), false);
    const geom = { r: DISK_FRACTION.aia };
    const on = limbState({ obsOn: 1, channel: '304', cosTheta: 1, geom });
    assert.equal(on.active, true); assert.equal(on.weight, 1); assert.ok(Math.abs(on.rEdge - 1.282) < 0.002);
    assert.equal(limbState({ obsOn: 1, channel: 'white', cosTheta: 1, geom }).reason, 'no-off-limb-emission');
    assert.equal(limbState({ obsOn: 1, channel: 'mag',   cosTheta: 1, geom }).reason, 'no-off-limb-emission');
    assert.equal(limbState({ obsOn: 0, channel: '304',   cosTheta: 1, geom }).reason, 'model');
    assert.equal(limbState({ obsOn: 1, channel: '304',   cosTheta: 1, geom: null }).reason, 'no-geometry');
    assert.equal(limbState({ obsOn: 1, channel: '304',   cosTheta: 0.2, geom }).reason, 'off-axis');
    assert.equal(limbState({ obsOn: 1, channel: '304',   cosTheta: 1, geom, userOn: false }).reason, 'user-off');
    assert.equal(Object.keys(CHANNELS).filter(channelHasOffLimb).length, 6, 'six AIA passbands');
});

ok('the GLSL carries the mask constants and the black floor (no drift from limbMask)', () => {
    assert.ok(LIMB_FRAG.includes(`smoothstep(${LIMB_INNER.toFixed(2)}, ${(LIMB_INNER + LIMB_FEATHER).toFixed(2)}, rho)`));
    assert.ok(LIMB_FRAG.includes(`rEdge - ${LIMB_EDGE_FEATHER.toFixed(2)}`));
    assert.ok(LIMB_FRAG.includes(`vec3(${BACKGROUND_FLOOR.toFixed(2)})`));
    assert.ok(LIMB_FRAG.includes('abs(u_obsKind - 1.0) > 0.5') && LIMB_FRAG.includes('u_obsOn < 0.5'), 'EUV-only and observed-only gates');
    assert.ok(LIMB_FRAG.includes('u_obsGeom.x + vLocal.x * u_obsGeom.z') && LIMB_FRAG.includes('u_obsGeom.y + vLocal.y * u_obsGeom.z'), 'the disk formula');
    assert.ok(LIMB_VERT.includes('vLocal = position.xy'));
});

console.log(`\n${passed} checks passed`);
