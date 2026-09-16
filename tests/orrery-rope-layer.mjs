// orrery-rope-layer.mjs — pure contract tests for the orrery's flux-rope layer.
//
// The headline assertion is the FRAME IDENTITY. solar-system.html already has
// one copy of "where a flare is and which way it faces" (js/flare-geometry.js
// heliocentricSiteDirection), and the flux-rope kernel has its own frame
// (flux-rope/view.js ropeFrame, Stonyhurst with Earth at lon 0). The orrery
// layer joins them with a basis and no conversion. If those ever drift, a
// flare and the CME it launched appear on opposite limbs — which looks
// entirely plausible and is completely wrong. That is the bug this file
// exists to catch.
//
// Run: node tests/orrery-rope-layer.mjs

import assert from 'node:assert/strict';
import {
    launchBasis, earthAzAtLaunch, ropePointToScene, mapSurface, passedFade, drawTilt, drawRope,
    ropeSceneRadius, ROPE_SCALE_GAIN, SUN_DRAWN_R, PASSED_HIDE_AU, N_PSI, N_THETA,
} from '../js/orrery-rope-layer.js';
import { ropeFrame } from '../js/flux-rope/view.js';
import { ropeSurfaceGrid } from '../js/stage/model.js';
import { heliocentricSiteDirection, heliocentricAzimuth } from '../js/flare-geometry.js';
import { logSceneRadius } from '../js/neo-orbits.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const YEAR_MS = 365.25 * 86400e3;
let passed = 0;
const close = (a, b, tol, what) => {
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
    passed++;
};
const ok = (cond, what) => { assert.ok(cond, what); passed++; };

/** Rotate a rope-frame vector into orrery world coords (no radial map). */
function rotate(v, b) {
    return [
        v[0] * b.e1[0] + v[1] * b.e2[0] + v[2] * b.e3[0],
        v[0] * b.e1[1] + v[1] * b.e2[1] + v[2] * b.e3[1],
        v[0] * b.e1[2] + v[1] * b.e2[2] + v[2] * b.e3[2],
    ];
}

// ── 1. THE FRAME IDENTITY ───────────────────────────────────────────────────
// ropeFrame(lon, lat).eDir pushed through launchBasis MUST equal
// flare-geometry's heliocentricSiteDirection for the same site.
for (const earthAzDeg of [0, 37, 130, -95, 210]) {
    for (const spinSign of [1, -1]) {
        const b = launchBasis(earthAzDeg * DEG, spinSign);
        for (const lonDeg of [0, 30, -60, 90, -145, 179]) {
            for (const latDeg of [0, 14, -28, 55]) {
                const world = rotate(ropeFrame(lonDeg, latDeg, 0).eDir, b);
                const fg = heliocentricSiteDirection({
                    latRad: latDeg * DEG, lonRad: lonDeg * DEG,
                    earthAzRad: earthAzDeg * DEG, spinSign,
                });
                close(world[0], fg[0], 1e-12, `eDir.x @ az${earthAzDeg} s${spinSign} W${lonDeg} N${latDeg}`);
                close(world[1], fg[1], 1e-12, 'eDir.y');
                close(world[2], fg[2], 1e-12, 'eDir.z');
            }
        }
    }
}

// A sub-Earth rope (Stonyhurst 0) leaves along Earth's own azimuth — the
// definition of Earth-directed, and the thing an operator reads off the screen.
{
    const A = 1.1;
    const b = launchBasis(A, 1);
    const world = rotate(ropeFrame(0, 0, 0).eDir, b);
    close(heliocentricAzimuth(world), A, 1e-12, 'Stonyhurst 0 leaves along Earth azimuth');
}

// West is AHEAD of Earth in the spin sense; east is behind. (Getting this
// backwards is exactly the 2026-09-13 bug js/swpc-feed.js already carries a
// scar for, on the other side of the same convention.)
{
    const A = 0.4, b = launchBasis(A, 1);
    const w30 = heliocentricAzimuth(rotate(ropeFrame(30, 0, 0).eDir, b));
    const e30 = heliocentricAzimuth(rotate(ropeFrame(-30, 0, 0).eDir, b));
    close(w30, A + 30 * DEG, 1e-12, 'W30 is 30° ahead of Earth');
    close(e30, A - 30 * DEG, 1e-12, 'E30 is 30° behind Earth');
}

// The basis is orthonormal, so rotating cannot change a
// length — which is what lets ropePointToScene use |p| for the radius.
{
    const b = launchBasis(0.77, 1);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.5, 0.8]]) {
        const w = rotate(v, b);
        close(Math.hypot(...w), Math.hypot(...v), 1e-12, 'rotation preserves length');
    }
    const e1 = b.e1, e2 = b.e2, e3 = b.e3;
    close(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], 0, 1e-12, 'e1 ⟂ e2');
    close(e1[0] * e3[0] + e1[1] * e3[1] + e1[2] * e3[2], 0, 1e-12, 'e1 ⟂ e3');
    // LEFT-handed, ON PURPOSE. The page maps ecliptic (x,y,z) -> world (x,z,y)
    // (neo-orbits.js helioToScene), a swap whose determinant is -1, so the
    // orrery's scene is a mirror of the ecliptic. Pinning eDir to
    // heliocentricSiteDirection fixes two axes and the third has no freedom
    // left. Asserted so a future "fix" to right-handedness has to come here
    // and read why -- and so the tilt compensation below stays justified.
    const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    close(cross[0] * e3[0] + cross[1] * e3[1] + cross[2] * e3[2], -1, 1e-12,
        'e1xe2 = -e3: the basis is LEFT-handed because the scene mirrors the ecliptic');
    close(b.handedness, -1, 1e-12, 'and the basis says so');
}

// ── 1b. THE TILT SURVIVES THE MIRROR ────────────────────────────────────────
// A mirror negates a rotation about an axis, so a rope fitted at +30 deg would
// be DRAWN at -30 deg: the right cloud lying the wrong way across the sky.
// drawTilt() pre-negates so the page's own mirror cancels it. What a viewer
// measures is the right-handed angle about eDir in WORLD coordinates, because
// world is what three.js renders -- so that is what this measures.
{
    const A = 0.62, b = launchBasis(A, 1);
    /** Signed right-handed angle about `axis`, from `ref` to `v`, all world. */
    const signedAngle = (axis, ref, v) => {
        const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
        const proj = (p) => {
            const d = dot(p, axis);
            return [p[0] - d * axis[0], p[1] - d * axis[1], p[2] - d * axis[2]];
        };
        const a = proj(ref), c = proj(v);
        const na = Math.hypot(...a), nc = Math.hypot(...c);
        const u = [a[0] / na, a[1] / na, a[2] / na];
        const w = [c[0] / nc, c[1] / nc, c[2] / nc];
        const crossUW = [
            u[1] * w[2] - u[2] * w[1],
            u[2] * w[0] - u[0] * w[2],
            u[0] * w[1] - u[1] * w[0],
        ];
        return Math.atan2(dot(crossUW, axis), dot(u, w));
    };

    for (const tiltDeg of [0, 15, 30, -40, 72]) {
        for (const [lonDeg, latDeg] of [[0, 0], [35, 12], [-55, -20]]) {
            // Built naively (tilt straight through) the drawn angle is mirrored…
            const naive = ropeFrame(lonDeg, latDeg, tiltDeg);
            const axisN = rotate(naive.eDir, b);
            const refN = rotate(ropeFrame(lonDeg, latDeg, 0).eP, b);
            close(signedAngle(axisN, refN, rotate(naive.eP, b)) / DEG, -tiltDeg, 1e-9,
                `naive build draws ${tiltDeg} deg mirrored`);

            // …and with drawTilt it is the tilt the ensemble actually fitted.
            const drawn = ropeFrame(lonDeg, latDeg, drawTilt(tiltDeg));
            const axisD = rotate(drawn.eDir, b);
            const refD = rotate(ropeFrame(lonDeg, latDeg, 0).eP, b);
            close(signedAngle(axisD, refD, rotate(drawn.eP, b)) / DEG, tiltDeg, 1e-9,
                `drawTilt restores ${tiltDeg} deg on screen`);
        }
    }

    // drawRope carries the negation and touches nothing else -- trainAt still
    // probes the kernel by index, so the kinematics stay the oracle's.
    const src = { lonDeg: 12, latDeg: -4, tiltDeg: 33, v0Kms: 900, launchOffsetS: 7200, handedness: 1 };
    const drawn = drawRope(src);
    close(drawn.tiltDeg, -33, 1e-12, 'drawRope negates the tilt');
    for (const k of ['lonDeg', 'latDeg', 'v0Kms', 'launchOffsetS', 'handedness']) {
        close(drawn[k], src[k], 1e-12, `drawRope passes ${k} through`);
    }
    close(src.tiltDeg, 33, 1e-12, 'drawRope does not mutate its input');
    close(drawTilt(undefined), 0, 1e-12, 'a missing tilt is 0, not NaN');
}

// ── 2. THE RADIAL ANCHORS ───────────────────────────────────────────────────
// r = 0 lands on the Sun's drawn surface, r = 1 AU lands exactly on the page's
// own drawn Earth orbit. Both anchors are load-bearing: the first attaches the
// rope to the star, the second makes "the cloud reaches Earth" true on screen.
close(ropeSceneRadius(0), SUN_DRAWN_R, 1e-12, 'r=0 → Sun drawn surface');
close(ropeSceneRadius(1), logSceneRadius(1), 1e-12, 'r=1 AU → drawn Earth orbit');
ok(ROPE_SCALE_GAIN > 1, 'gain > 1 (the shift steepens to keep both anchors)');

// Monotone, and strictly inside the page's own map between the anchors — the
// disclosed dishonesty, bounded so it can never overtake a planet.
{
    let prev = -Infinity;
    for (let r = 0; r <= 1.4; r += 0.02) {
        const v = ropeSceneRadius(r);
        ok(v > prev, `monotone at r=${r.toFixed(2)}`);
        prev = v;
    }
    for (const r of [0.1, 0.39, 0.72]) {
        ok(ropeSceneRadius(r) < logSceneRadius(r), `inside the page map at ${r} AU`);
    }
    ok(ropeSceneRadius(1.4) > logSceneRadius(1.4), 'and outside it beyond 1 AU (the shift is a rotation about 1 AU)');
}

// The bug this map exists to prevent: the page's own logSceneRadius has a
// non-zero intercept, so a surface reaching the origin would be thrown onto a
// 2.5-unit sphere. Assert the intercept really is non-zero (i.e. the naive
// map would break) AND that ours does not.
ok(logSceneRadius(0) > 2, 'page map has the non-zero intercept this layer works around');
close(ropeSceneRadius(1e-9), SUN_DRAWN_R, 1e-6, 'near-origin vertices collapse to the Sun, not a shell');

// ── 3. BALLISTIC FREEZING ───────────────────────────────────────────────────
// The drawn Earth rides a mean-motion circle; the launch azimuth is exact.
{
    const azNow = 2.0, now = Date.parse('2026-09-14T00:00:00Z');
    close(earthAzAtLaunch(azNow, now, now), azNow, 1e-12, 'launch == now is a no-op');
    const oneDay = earthAzAtLaunch(azNow, now, now - 86400e3);
    close(azNow - oneDay, TAU / 365.25, 1e-12, 'one day back is one mean-motion day');
    const oneYear = earthAzAtLaunch(azNow, now, now - YEAR_MS);
    close(azNow - oneYear, TAU, 1e-12, 'one year back is one full turn');
    // A rope launched 3 days ago holds a heading ~3° off today's Earth line —
    // which is the point: it does NOT track Earth around its orbit.
    const threeDay = earthAzAtLaunch(azNow, now, now - 3 * 86400e3);
    close((azNow - threeDay) / DEG, 3 * 360 / 365.25, 1e-9, 'three days ≈ 2.96°');
    ok(Number.isFinite(earthAzAtLaunch(azNow, now, NaN)) , 'a missing launch falls back, never NaN');
    close(earthAzAtLaunch(azNow, now, NaN), azNow, 1e-12, 'fallback is the current azimuth');
}

// ── 4. SURFACE MAPPING ──────────────────────────────────────────────────────
{
    const spec = { frame: ropeFrame(28, 14, 0), dAu: 0.62, sigApexAu: 0.11 };
    const { positions, indices } = ropeSurfaceGrid(spec, N_PSI, N_THETA);
    const b = launchBasis(0.9, 1);
    const mapped = mapSurface(positions, b);

    ok(mapped.length === positions.length, 'mapped length matches');
    ok(mapped.every(Number.isFinite), 'no NaN or Infinity in the mapped surface');
    ok(indices.length === N_PSI * N_THETA * 6, 'index count matches the lattice');

    // Every vertex sits between the Sun's surface and the apex shell — the
    // bulb-at-the-base failure would blow the lower bound wide open.
    let rMin = Infinity, rMax = -Infinity;
    for (let i = 0; i < mapped.length; i += 3) {
        const r = Math.hypot(mapped[i], mapped[i + 1], mapped[i + 2]);
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
    }
    ok(rMin >= SUN_DRAWN_R - 1e-9, `no vertex inside the Sun (min ${rMin.toFixed(3)})`);
    ok(rMax <= ropeSceneRadius(spec.dAu + spec.sigApexAu) + 1e-6, 'no vertex beyond apex+σ');
    // The whole point of the shifted map: the base is snug to the star, not a
    // 2.5-unit shell. Under the page's raw map this is ~2.5 and the test fails.
    ok(rMin < SUN_DRAWN_R + 0.35, `rope base is snug to the Sun (min ${rMin.toFixed(3)})`);

    // Writing into a caller-supplied buffer allocates nothing and agrees.
    const dst = new Float32Array(positions.length);
    const again = mapSurface(positions, b, dst);
    ok(again === dst, 'mapSurface writes into the supplied buffer');
    for (let i = 0; i < dst.length; i++) close(dst[i], mapped[i], 1e-12, 'buffered == allocated');

    // The apex really does land on the drawn Earth orbit when it reaches 1 AU.
    const at1 = { frame: ropeFrame(0, 0, 0), dAu: 1, sigApexAu: 0.08 };
    const tip = ropePointToScene(at1.frame.eDir.map(v => v * 1), b);
    close(Math.hypot(...tip), logSceneRadius(1), 1e-9, 'apex at 1 AU sits on the drawn Earth orbit');
}

// ── 5. THE PASSED-L1 FADE ───────────────────────────────────────────────────
// A front that has gone by must stop implying it is still inbound.
close(passedFade(0.5), 1, 1e-12, 'inbound is fully opaque');
close(passedFade(1), 1, 1e-12, 'at 1 AU still fully opaque');
close(passedFade(PASSED_HIDE_AU), 0, 1e-12, 'gone by the hide radius');
ok(passedFade(1.1) < 1 && passedFade(1.1) > 0, 'fades across the band');
ok(passedFade(99) === 0, 'never negative');

console.log(`orrery-rope-layer.mjs — ${passed} assertions passed`);
