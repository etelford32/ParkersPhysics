#!/usr/bin/env node
/**
 * bootes-camera-math.mjs — gate for js/bootes/camera-math.js.
 *
 * Run: node tests/bootes-camera-math.mjs
 *
 * The camera's arithmetic is separated from its three.js plumbing precisely so
 * this file can exist, because the things that go wrong in a camera rig are
 * arithmetic and are invisible in a screenshot:
 *
 *   • A scale bar that rounds UP overflows its container at some zooms and
 *     gets clipped, which turns a scale reference into a lie about scale.
 *   • An elevation readout that runs the wrong way reads +88° when the camera
 *     is underneath, and nothing on screen contradicts it.
 *   • A "perpendicular to the sightline" viewpoint that is perpendicular to a
 *     COORDINATE AXIS instead looks entirely plausible and shows the wrong
 *     projection — the worst failure mode a figure has.
 *   • A pose interpolation that lerps Cartesian positions flies the camera
 *     through the middle of the void, and the flash lasts two frames.
 *
 * Every one of those is checked here against a property rather than against a
 * remembered number.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    clamp, clampPolar, POLAR_MIN, POLAR_MAX, normalise,
    perpendicularTo, horizontalPerpendicularTo,
    VIEWPOINTS, VIEWPOINT_IDS, viewpointDirection,
    sphericalFromDirection, directionFromSpherical,
    elevationDegFromPolar, azimuthDeg,
    visibleHeightMpc, mpcPerPixel, niceScaleMpc, scaleBar,
    RANGE_RINGS, easeInOutCubic, interpolatePose, KEY_BINDINGS,
} from '../js/bootes/camera-math.js';
import { losUnitFromVoid, effectiveRadiusMpc } from '../js/bootes-void-data.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

const LOS = losUnitFromVoid();

// ── 1. Clamps ───────────────────────────────────────────────────────────────
{
    assert.equal(clamp(5, 0, 3), 3);
    assert.equal(clamp(-5, 0, 3), 0);
    assert.equal(clamp(1, 0, 3), 1);

    // The polar standoff. Without it the camera's basis degenerates at the
    // pole and OrbitControls rolls; keyboard orbit, which steps in fixed
    // increments rather than tracking a pointer, walks straight into it.
    assert.equal(clampPolar(0), POLAR_MIN, 'polar is held off the north pole');
    assert.equal(clampPolar(Math.PI), POLAR_MAX, 'and off the south pole');
    assert.equal(clampPolar(-10), POLAR_MIN);
    assert.equal(clampPolar(1), 1, 'and left alone in between');
    assert.ok(POLAR_MIN > 0 && POLAR_MAX < Math.PI, 'the band is strictly interior');
    assert.ok(POLAR_MIN < 0.1, 'but small enough to read as "straight down"');
    ok('clamps: polar angle is held strictly off both poles');
}

// ── 2. Vectors ──────────────────────────────────────────────────────────────
{
    near(len(normalise([3, 0, 4])), 1, 1e-12, 'normalise returns a unit vector');
    assert.deepEqual(normalise([0, 0, 0]), [0, 1, 0], 'a zero vector degrades safely');

    for (const axis of [[0, 0, 1], LOS, [1, 1, 0], [0.3, -0.9, 0.2]]) {
        const p = perpendicularTo(axis);
        near(len(p), 1, 1e-12, 'perpendicularTo returns a unit vector');
        near(dot(p, normalise(axis)), 0, 1e-12, 'and is genuinely perpendicular');
        const h = horizontalPerpendicularTo(axis);
        near(len(h), 1, 1e-12, 'horizontalPerpendicularTo returns a unit vector');
        near(dot(h, normalise(axis)), 0, 1e-12, 'and is genuinely perpendicular');
        near(h[1], 0, 1e-12, 'and lies in the horizontal plane');
    }
    // The degenerate case: perpendicular to up itself.
    near(dot(perpendicularTo([0, 1, 0]), [0, 1, 0]), 0, 1e-12,
        'perpendicular to +Y is still perpendicular');
    near(dot(horizontalPerpendicularTo([0, 1, 0]), [0, 1, 0]), 0, 1e-12,
        'and so is the horizontal version');
    ok('perpendicular constructions are unit, perpendicular and degenerate-safe');
}

// ── 3. THE SIGHTLINE IS NOT AN AXIS ─────────────────────────────────────────
{
    // The premise. If Boötes ever sat on a coordinate axis the two
    // sightline-derived viewpoints would become untestable, so assert the
    // premise rather than assuming it.
    assert.ok(Math.max(...LOS.map(Math.abs)) < 0.95,
        `the sightline must be oblique for these viewpoints to mean anything `
        + `(got ${LOS.map(v => v.toFixed(2)).join(', ')})`);

    const along = viewpointDirection('sightline', LOS);
    near(dot(along, LOS), 1, 1e-12,
        'the sightline viewpoint sits ALONG +los — between us and the void, '
        + 'looking back at it. The opposite sign renders the far side with '
        + 'nothing to say so.');

    const across = viewpointDirection('across', LOS);
    near(dot(across, LOS), 0, 1e-12,
        'the across viewpoint is perpendicular to the sightline, so the '
        + 'sightline lies in the screen plane where the distortion is visible');
    near(across[1], 0, 1e-12, 'and level, so the horizon is not tilted 62°');

    // Neither may be a coordinate axis by accident.
    for (const [id, dir] of [['sightline', along], ['across', across]]) {
        const axisLike = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
            .some(ax => Math.abs(Math.abs(dot(dir, ax)) - 1) < 1e-6);
        assert.ok(!axisLike, `the ${id} viewpoint must not collapse onto a coordinate axis`);
    }

    assert.deepEqual(viewpointDirection('pole', LOS), [0, 1, 0],
        'the pole viewpoint is straight up, and that one IS an axis on purpose');
    for (const id of VIEWPOINT_IDS) {
        near(len(viewpointDirection(id, LOS)), 1, 1e-12, `${id} direction is a unit vector`);
    }
    ok('viewpoints: sightline-derived views are built from the real oblique sightline');
}

// ── 4. Viewpoint table ──────────────────────────────────────────────────────
{
    const keys = new Set();
    for (const id of VIEWPOINT_IDS) {
        const vp = VIEWPOINTS[id];
        assert.ok(vp.label && vp.hint, `${id} carries a label and a hint`);
        assert.ok(vp.distance > 0, `${id} has a positive distance`);
        assert.ok(vp.fovDeg > 10 && vp.fovDeg < 120, `${id} has a sane field of view`);
        assert.ok(!keys.has(vp.key), `${id}'s shortcut key ${vp.key} is not a duplicate`);
        keys.add(vp.key);
    }
    // The inside view has to actually be inside, and the rest outside.
    assert.ok(VIEWPOINTS.inside.distance < 1,
        'the "inside the void" viewpoint must sit inside R_eff');
    assert.ok(VIEWPOINTS.inside.fovDeg > 60,
        'and needs a wide lens — a narrow one shows a patch of wall and no context');
    for (const id of VIEWPOINT_IDS.filter(i => i !== 'inside')) {
        assert.ok(VIEWPOINTS[id].distance > 1.5, `${id} frames the whole void`);
    }

    // Every shortcut in the table is documented in the key help, which is
    // RENDERED from KEY_BINDINGS — so a binding added without documenting it
    // is impossible, and this asserts the two really do cover each other.
    const documented = KEY_BINDINGS.flatMap(b => b.keys);
    for (const id of VIEWPOINT_IDS) {
        assert.ok(documented.includes(VIEWPOINTS[id].key),
            `viewpoint ${id}'s key "${VIEWPOINTS[id].key}" is not in the on-screen help`);
    }
    ok(`viewpoint table: ${VIEWPOINT_IDS.length} views, unique keys, all documented`);
}

// ── 5. Spherical round-trip and the elevation sign ──────────────────────────
{
    for (const dir of [[1, 0, 0], [0, 0, 1], LOS, normalise([0.2, 0.7, -0.4])]) {
        const { theta, phi } = sphericalFromDirection(dir);
        const back = directionFromSpherical(theta, phi);
        for (let i = 0; i < 3; i++) {
            near(back[i], normalise(dir)[i], 1e-9, 'spherical round-trips');
        }
    }
    // The sign that ships inverted: polar runs from +Y, elevation runs from
    // the equator, so they go in OPPOSITE directions.
    near(elevationDegFromPolar(Math.PI / 2), 0, 1e-12, 'the equator is 0° elevation');
    near(elevationDegFromPolar(POLAR_MIN), 90 - (POLAR_MIN * 180) / Math.PI, 1e-9,
        'looking down from above is a POSITIVE elevation');
    assert.ok(elevationDegFromPolar(0.1) > 0, 'small polar angle ⇒ high above the plane');
    assert.ok(elevationDegFromPolar(Math.PI - 0.1) < 0, 'large polar angle ⇒ below it');

    near(azimuthDeg(0), 0, 1e-12);
    near(azimuthDeg(Math.PI), 180, 1e-12);
    near(azimuthDeg(-Math.PI / 2), 270, 1e-12, 'azimuth wraps into [0,360)');
    assert.ok(azimuthDeg(-7 * Math.PI) >= 0 && azimuthDeg(-7 * Math.PI) < 360,
        'and stays in range for any input');
    ok('spherical round-trip, and elevation runs opposite to polar as it must');
}

// ── 6. The scale bar ────────────────────────────────────────────────────────
{
    // h = 2 d tan(fov/2), checked against a case with an exact answer: at
    // fov = 90° the visible height equals twice the distance.
    near(visibleHeightMpc(100, 90), 200, 1e-9, 'at 90° fov the view spans 2d');
    assert.ok(visibleHeightMpc(200, 45) > visibleHeightMpc(100, 45),
        'further away shows more');
    assert.ok(visibleHeightMpc(100, 78) > visibleHeightMpc(100, 45),
        'a wider lens shows more');
    near(mpcPerPixel(100, 90, 200), 1, 1e-9, 'Mpc per pixel is the height over the pixels');
    assert.equal(mpcPerPixel(100, 45, 0), 0, 'a zero-height viewport is handled');

    // Nice-number rounding, and it must round DOWN.
    for (const [raw, want] of [[1, 1], [1.9, 1], [2, 2], [4.9, 2], [5, 5], [9.9, 5],
                               [10, 10], [37, 20], [180, 100], [0.42, 0.2], [640, 500]]) {
        near(niceScaleMpc(raw), want, 1e-9, `niceScaleMpc(${raw})`);
        assert.ok(niceScaleMpc(raw) <= raw + 1e-12,
            `niceScaleMpc must never round UP — a bar longer than the space it was `
            + `measured against gets clipped, and a clipped scale bar is a lie`);
    }
    assert.equal(niceScaleMpc(0), 0, 'a zero length is handled');
    assert.equal(niceScaleMpc(NaN), 0, 'and so is a NaN');

    // The bar as a whole: never wider than asked for, and its label is the
    // length it actually represents.
    for (const d of [20, 92, 226, 357, 900]) {
        const bar = scaleBar(d, 45, 600, 150);
        assert.ok(bar, `a bar exists at ${d} Mpc`);
        assert.ok(bar.px <= 150 + 1e-9, `the bar fits its box at ${d} Mpc`);
        assert.ok(bar.px > 20, `and is big enough to read at ${d} Mpc`);
        near(bar.mpc / mpcPerPixel(d, 45, 600), bar.px, 1e-9,
            'the label is exactly what the drawn width represents');
    }
    // Zooming out must make a given screen width worth MORE Mpc.
    assert.ok(scaleBar(900, 45, 600).mpc > scaleBar(90, 45, 600).mpc,
        'the bar reports a larger distance when the camera pulls back');
    assert.equal(scaleBar(0, 45, 600), null, 'a degenerate view returns null, not a bar');
    ok('scale bar: rounds down, fits its box, and its label matches its width');
}

// ── 7. Range rings ──────────────────────────────────────────────────────────
{
    assert.ok(RANGE_RINGS.length >= 4, 'there are enough rings to read as a ruler');
    assert.ok(RANGE_RINGS.includes(1), 'R_eff itself is one of them — it carries the argument');
    for (let i = 1; i < RANGE_RINGS.length; i++) {
        assert.ok(RANGE_RINGS[i] > RANGE_RINGS[i - 1], 'rings are strictly increasing');
    }
    assert.ok(Object.isFrozen(RANGE_RINGS),
        'the rings are FIXED. A ruler whose tick spacing changes as you zoom is '
        + 'not a ruler — the adaptive half of the job belongs to the scale bar.');
    // Sanity against the real void: the outermost ring should reach past the
    // catalogued clusters, which sit 109–204 Mpc from the centre.
    const rEff = effectiveRadiusMpc();
    assert.ok(Math.max(...RANGE_RINGS) * rEff > 210,
        'the outermost ring reaches past the furthest catalogued cluster');
    ok('range rings: fixed, increasing, and wide enough to contain the anchors');
}

// ── 8. Pose interpolation ───────────────────────────────────────────────────
{
    near(easeInOutCubic(0), 0, 1e-12);
    near(easeInOutCubic(1), 1, 1e-12);
    near(easeInOutCubic(0.5), 0.5, 1e-12, 'the ease is symmetric about the midpoint');
    assert.ok(easeInOutCubic(0.25) < 0.25, 'and starts slowly');
    assert.ok(easeInOutCubic(-5) === 0 && easeInOutCubic(5) === 1, 'clamped outside [0,1]');

    const a = { theta: 0.2, phi: 1.0, radius: 20, fovDeg: 45, target: [0, 0, 0] };
    const b = { theta: 2.5, phi: 2.0, radius: 400, fovDeg: 78, target: [10, 0, -5] };
    for (const k of ['theta', 'phi', 'radius', 'fovDeg']) {
        near(interpolatePose(a, b, 0)[k], a[k], 1e-9, `t=0 returns the start (${k})`);
        near(interpolatePose(a, b, 1)[k], b[k], 1e-9, `t=1 returns the end (${k})`);
    }

    // THE RADIUS NEVER COLLAPSES. A Cartesian lerp between two camera
    // positions on opposite sides passes through the target: the camera dives
    // through the void, the wall sweeps the near plane and the view flashes.
    // Interpolating the radius geometrically makes that impossible.
    const far = { theta: 0, phi: 1.4, radius: 300, fovDeg: 45, target: [0, 0, 0] };
    const opposite = { theta: Math.PI, phi: 1.4, radius: 300, fovDeg: 45, target: [0, 0, 0] };
    for (let t = 0; t <= 1; t += 0.02) {
        const p = interpolatePose(far, opposite, t);
        assert.ok(p.radius > 250,
            `the camera must stay out at ${(t * 100).toFixed(0)} % of a half-turn `
            + `(got radius ${p.radius.toFixed(1)}) — a Cartesian lerp would be at 0 here`);
        assert.ok(p.phi >= POLAR_MIN && p.phi <= POLAR_MAX, 'and inside the polar band');
    }

    // Azimuth takes the SHORT way around. 350° → 10° is a 20° move, not 340°.
    const from = { theta: (350 * Math.PI) / 180, phi: 1, radius: 100, fovDeg: 45, target: [0, 0, 0] };
    const to = { theta: (10 * Math.PI) / 180, phi: 1, radius: 100, fovDeg: 45, target: [0, 0, 0] };
    const mid = interpolatePose(from, to, 0.5);
    const midDeg = azimuthDeg(mid.theta);
    assert.ok(midDeg > 355 || midDeg < 5,
        `halfway from 350° to 10° must be near 0°, not near 180° (got ${midDeg.toFixed(1)}°)`);
    ok('pose interpolation: radius stays out, azimuth wraps short, ends are exact');
}

// ── 9. Purity ───────────────────────────────────────────────────────────────
{
    const src = readFileSync(
        fileURLToPath(new URL('../js/bootes/camera-math.js', import.meta.url)), 'utf8');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['document', 'window', 'fetch(', 'THREE', 'performance.']) {
        assert.ok(!body.includes(forbidden),
            `camera-math must stay pure — found "${forbidden}"`);
    }
    assert.ok(!/from ['"]three/.test(src), 'and must not import three.js');
    assert.ok(!/Math\.random|Date\.now/.test(body), 'and must be deterministic');
    ok('purity: no three, no DOM, no ambient time');
}

console.log(`\n${passed} checks passed — js/bootes/camera-math.js`);
