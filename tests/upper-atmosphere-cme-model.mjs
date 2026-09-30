/**
 * tests/upper-atmosphere-cme-model.mjs — gate for the CME frame join
 *   node tests/upper-atmosphere-cme-model.mjs
 *
 * What is pinned:
 *   • the ecliptic pole in the Earth-FIXED scene is ⟂ the page's own Sun
 *     direction on every day of a year, and the rope basis is right-handed
 *     with e2 along Earth's orbital motion (the sense a west-limb eruption
 *     needs) — measured from the Sun's own motion, not asserted;
 *   • the corridor's anchors: the drawn Sun at `sunRe`, 1 AU exactly on the
 *     drawn Earth, directions preserved, an Earth-directed rope heading
 *     straight at the origin;
 *   • the true-scale map inverts, and GSE is the kernel frame's flip;
 *   • field lines: straight and parallel in a uniform field, never inside
 *     the magnetopause, never outside the rope (the front shows as where
 *     lines stop), seeded where the rope is when Earth is not yet inside;
 *   • on the REAL committed WASM with the Gannon train: nothing near Earth
 *     before the launch, lines at Earth after the observed arrival.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CME_VIEW, OBLIQUITY_DEG, eclipticNorthScene, ropeBasisScene, ropeVecToScene, sceneVecToRope,
    corridorRadiusRe, corridorCompression, corridorPointToScene, mapCorridorSurface, passedFade,
    sceneToHelioKm, helioKmToScene, toGse, shueRadiusRe, insideMagnetopause, traceImfLines,
    hoursToReach, cmeWindow, cmeViewPose,
} from '../js/upper-atmosphere-cme-model.js';
import { latLonToScene } from '../js/upper-atmosphere-column.js';
import { subSolarPoint, greenwichSiderealDeg } from '../js/sun-altitude.js';
import { ropeFrame } from '../js/flux-rope/view.js';
import { AU_KM, RE_KM } from '../js/stage/scale.js';
import { ropeSurfaceGrid } from '../js/stage/model.js';
import { trainAt } from '../js/corridor/corridor-model.js';
import { loadFluxRopeKernel, ROPE_DEFAULTS } from '../js/flux-rope-kernel.js';
import { GANNON_FIT } from '../js/flux-rope-presets.js';
import { buildReplayForecast } from '../js/hero-rope-layer.js';

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angDeg = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b)) / DEG;

/** The page's Sun and sidereal angle at an instant (what the globe uses). */
function frameAt(ms) {
    const ssp = subSolarPoint(new Date(ms));
    const sunDir = latLonToScene(ssp.lat, ssp.lon);
    const gmst = greenwichSiderealDeg(ms) * DEG;
    return { sunDir, gmst, basis: ropeBasisScene(sunDir, eclipticNorthScene(gmst)) };
}
/** Earth-fixed scene vector → the inertial frame (inverse of −θ about +Y). */
function toInertial(v, gmst) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

console.log('\n── the frame ──');

const T0 = Date.UTC(2026, 0, 1);

await t('the ecliptic pole is ⟂ the page\'s Sun on every day of a year, and ε from the spin axis', () => {
    let worst = 0;
    for (let d = 0; d < 366; d++) {
        const ms = T0 + d * 86400e3 + (d * 3571e3) % 86400e3;   // wander through the day too
        const { sunDir, gmst } = frameAt(ms);
        worst = Math.max(worst, Math.abs(dot(sunDir, eclipticNorthScene(gmst))));
    }
    assert.ok(worst < 2e-3, `worst |ŝ·N̂| = ${worst}`);
    near(angDeg(eclipticNorthScene(1.234), [0, 1, 0]), OBLIQUITY_DEG, 1e-9);
});

await t('the rope basis is right-handed, e1 is Sun→Earth, and e2 is Earth\'s orbital motion', () => {
    for (let d = 0; d < 360; d += 30) {
        const ms = T0 + d * 86400e3;
        const { sunDir, gmst, basis } = frameAt(ms);
        const { e1, e2, e3 } = basis;
        near(angDeg(e1, sunDir), 180, 1e-9, 'e1 = −ŝ');
        near(dot(cross(e1, e2), e3), 1, 1e-12, 'det +1');
        near(dot(e1, e2), 0, 1e-12); near(dot(e2, e3), 0, 1e-12); near(dot(e1, e3), 0, 1e-12);
        // The Sun moves EAST along the ecliptic, so Earth moves along
        // N̂ × (Sun→Earth) = e2. Measure it: ΔŜ (inertial) ∝ −e2.
        const later = frameAt(ms + 6 * 3600e3);
        const s0 = toInertial(sunDir, gmst), s1 = toInertial(later.sunDir, later.gmst);
        const dS = [s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]];
        const e2i = toInertial(e2, gmst);
        assert.ok(angDeg(dS, e2i.map((x) => -x)) < 1, `day ${d}: ΔŜ ${angDeg(dS, e2i.map((x) => -x)).toFixed(2)}° from −e2`);
    }
});

await t('rope-frame ↔ scene vectors are a rotation (round trip exact)', () => {
    const { basis } = frameAt(T0 + 40 * 86400e3);
    const v = [0.3, -1.7, 2.2];
    const back = sceneVecToRope(ropeVecToScene(v, basis), basis);
    for (let k = 0; k < 3; k++) near(back[k], v[k], 1e-12);
});

console.log('\n── the corridor (compressed, disclosed) ──');

await t('anchors: the drawn Sun at sunRe, 1 AU exactly on the drawn Earth, monotone', () => {
    near(corridorRadiusRe(1), CME_VIEW.sunRe, 1e-9);
    assert.equal(corridorRadiusRe(0), 0);
    let prev = 0;
    for (let r = 0.01; r < 1.4; r += 0.01) { const x = corridorRadiusRe(r); assert.ok(x > prev); prev = x; }
    const { sunDir, basis } = frameAt(T0);
    const earth = corridorPointToScene([1, 0, 0], basis, sunDir);
    near(len(earth), 0, 1e-9, 'an apex at 1 AU on the Sun–Earth line IS the drawn Earth');
    const sun = corridorPointToScene([0, 0, 0], basis, sunDir);
    near(angDeg(sun, sunDir), 0, 1e-9); near(len(sun), CME_VIEW.sunRe, 1e-9);
    // Compression near Earth is ~×110 (and disclosed as such by the page).
    const k = corridorCompression(1);
    assert.ok(k > 80 && k < 150, `compression ×${k.toFixed(0)}`);
});

await t('directions are preserved: a rope heads along its own eDir from the drawn Sun', () => {
    const { sunDir, basis } = frameAt(T0 + 100 * 86400e3);
    for (const [lon, lat] of [[0, 0], [45, 10], [-60, -20], [90, 0]]) {
        const f = ropeFrame(lon, lat, 0);
        const p = corridorPointToScene(f.eDir.map((x) => 0.5 * x), basis, sunDir);
        const sun = sunDir.map((x) => x * CME_VIEW.sunRe);
        const dir = [p[0] - sun[0], p[1] - sun[1], p[2] - sun[2]];
        near(angDeg(dir, ropeVecToScene(f.eDir, basis)), 0, 1e-9, `lon ${lon} lat ${lat}`);
    }
    // A whole surface maps finite, and fades past 1 AU.
    const grid = ropeSurfaceGrid({ frame: ropeFrame(10, 5, 30), dAu: 0.8, sigApexAu: 0.12 }, 12, 6);
    const m = mapCorridorSurface(grid.positions, basis, sunDir);
    assert.ok(m.every(Number.isFinite));
    assert.equal(passedFade(0.9), 1);
    near(passedFade(1 + 0.5 * (CME_VIEW.passedHideAu - 1)), 0.5, 1e-12);
    assert.equal(passedFade(2), 0);
});

console.log('\n── true scale near Earth ──');

await t('scene ↔ heliocentric km round-trips; the origin is Earth at 1 AU; GSE flips x and y', () => {
    const { basis, sunDir } = frameAt(T0 + 200 * 86400e3);
    const e = sceneToHelioKm([0, 0, 0], basis);
    near(e[0], AU_KM, 1e-3); near(e[1], 0, 1e-9); near(e[2], 0, 1e-9);
    // 10 R⊕ sunward is 10 R⊕ closer to the Sun.
    const s = sceneToHelioKm(sunDir.map((x) => 10 * x), basis);
    near(AU_KM - s[0], 10 * RE_KM, 1e-3);
    const q = helioKmToScene(sceneToHelioKm([3, -4, 5], basis), basis);
    near(q[0], 3, 1e-6); near(q[1], -4, 1e-6); near(q[2], 5, 1e-6);
    assert.deepEqual(toGse([1, 2, -3]), [-1, -2, -3]);
});

await t('the magnetopause is Shue: nose at r0, flaring, open down the tail', () => {
    const mp = { r0: 10, alpha: 0.58 };
    near(shueRadiusRe(0, 10, 0.58), 10, 1e-12);
    near(shueRadiusRe(Math.PI / 2, 10, 0.58), 10 * Math.pow(2, 0.58), 1e-12);
    assert.equal(shueRadiusRe(Math.PI, 10, 0.58), Infinity);
    const sun = [1, 0, 0];
    assert.equal(insideMagnetopause([9, 0, 0], sun, mp), true);
    assert.equal(insideMagnetopause([11, 0, 0], sun, mp), false);
    assert.equal(insideMagnetopause([-60, 0, 0], sun, mp), true, 'deep tail');
    assert.equal(insideMagnetopause([0, 30, 0], sun, mp), false, 'flank');
});

const MP = { r0: 10, alpha: 0.58 };

await t('a uniform southward rope field: straight parallel lines along −N̂, Bz everywhere, none inside the magnetopause', () => {
    const { basis, sunDir } = frameAt(T0 + 77 * 86400e3);
    const out = traceImfLines({ fieldAt: () => ({ bx: 0, by: 0, bz: -12, inside: true }), basis, sunDir, mp: MP });
    assert.equal(out.reference.at, 'earth');
    near(out.reference.gse[2], -12, 1e-9, 'GSE Bz');
    assert.ok(out.lines.length >= 20, `${out.lines.length} lines`);
    const dn = basis.e3.map((x) => -x);
    for (const L of out.lines) {
        const n = L.bz.length;
        assert.ok(L.bz.every((b) => b === -12));
        const a = L.points.slice(0, 3), b = L.points.slice(3 * (n - 1));
        near(angDeg([b[0] - a[0], b[1] - a[1], b[2] - a[2]], dn), 0, 1e-6, 'straight along the field');
        for (let i = 0; i < n; i++) {
            const p = L.points.slice(3 * i, 3 * i + 3);
            assert.ok(len(p) <= CME_VIEW.imfBoxRe + 1e-9, 'inside the box');
            assert.equal(insideMagnetopause(p, sunDir, MP), false, 'never inside the magnetopause');
        }
    }
});

await t('the front: lines exist only where the rope is, seeded sunward when Earth is not yet inside', () => {
    const { basis, sunDir } = frameAt(T0 + 150 * 86400e3);
    // Rope fills everything Sunward of a front `fRe` R⊕ from Earth (+ = past Earth).
    const field = (fRe) => (p) => ({ bx: 0, by: 8, bz: -3, inside: p[0] < AU_KM + fRe * RE_KM });
    const behind = traceImfLines({ fieldAt: field(10), basis, sunDir, mp: MP });
    assert.equal(behind.reference.at, 'earth');
    for (const L of behind.lines) for (let i = 0; i < L.bz.length; i++) {
        const p = L.points.slice(3 * i, 3 * i + 3);
        assert.ok(dot(p, basis.e1) < 10 + 1e-6, 'no line past the front');
    }
    const arriving = traceImfLines({ fieldAt: field(-20), basis, sunDir, mp: MP });
    assert.equal(arriving.reference.at, 'sunward', 'Earth not yet inside: seeded where the rope is');
    assert.ok(arriving.lines.length > 0);
    for (const L of arriving.lines) for (let i = 0; i < L.bz.length; i++) {
        assert.ok(dot(L.points.slice(3 * i, 3 * i + 3), basis.e1) < -20 + 1e-6);
    }
    const far = traceImfLines({ fieldAt: field(-60), basis, sunDir, mp: MP });
    assert.equal(far.reference, null, 'nothing in the box: nothing drawn');
    assert.equal(far.lines.length, 0);
});

await t('camera stations: the approach frames the drawn Sun AND Earth; the others look at Earth from sunward / the side', () => {
    const { basis, sunDir } = frameAt(T0 + 33 * 86400e3);
    const a = cmeViewPose('approach', basis, sunDir);
    const fwd = [a.target[0] - a.position[0], a.target[1] - a.position[1], a.target[2] - a.position[2]];
    const sun = sunDir.map((x) => x * CME_VIEW.sunRe);
    for (const [name, p] of [['sun', sun], ['earth', [0, 0, 0]]]) {
        const d = [p[0] - a.position[0], p[1] - a.position[1], p[2] - a.position[2]];
        assert.ok(angDeg(d, fwd) < 0.5 * a.fovDeg, `${name} in the approach frame`);
    }
    near(angDeg(a.up, basis.e3), 0, 1e-12, 'ecliptic north up');
    const u = cmeViewPose('upstream', basis, sunDir);
    assert.ok(dot(u.position, sunDir) > 25, 'upstream is sunward');
    const sd = cmeViewPose('side', basis, sunDir);
    assert.ok(Math.abs(dot(sd.position, sunDir)) < 10 && len(sd.position) > 30, 'side is abeam');
    assert.equal(cmeViewPose('nope', basis, sunDir), null);
});

console.log('\n── the train (kernel probes) ──');

await t('hoursToReach bisects the kernel\'s own apex probe; cmeWindow brackets launch → arrival → now', () => {
    const k = { apexKmAt: (i, tS) => 500 * tS };               // 500 km/s from the Sun
    near(hoursToReach(k, 0, 0), AU_KM / 500 / 3600, 1e-6);
    assert.equal(hoursToReach(k, 0, AU_KM / 500 + 10), 0, 'already there');
    assert.equal(hoursToReach({ apexKmAt: () => 1 }, 0, 0, AU_KM, { horizonH: 5 }), null);
    assert.equal(hoursToReach(null, 0, 0), null);
    const fc = { launchMs: 1e12, preset: { ropes: [{ launchOffsetS: 0 }, { launchOffsetS: 7200 }] },
                 summary: { arrivalP50Ms: 1e12 + 40 * 3600e3, arrivalP90Ms: 1e12 + 50 * 3600e3 } };
    const w = cmeWindow(fc, { nowMs: 1e12 + 90 * 3600e3 });
    assert.equal(w.t0, 1e12 - 6 * 3600e3);
    assert.equal(w.t1, 1e12 + 90 * 3600e3, 'extends to include now');
    assert.deepEqual(w.launches, [1e12, 1e12 + 7200e3]);
    assert.equal(cmeWindow({}), null);
});

await t('REAL kernel, Gannon train: no field at Earth before launch; the train reaches Earth and lines are drawn', async () => {
    const kernel = await loadFluxRopeKernel(readFileSync(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)));
    const fc = buildReplayForecast(kernel, GANNON_FIT, ROPE_DEFAULTS);
    const { basis, sunDir } = frameAt(fc.launchMs);
    const fieldAtTrain = (tS) => (p) => kernel.fieldAt(tS, p[0], p[1], p[2]);
    const before = traceImfLines({ fieldAt: fieldAtTrain(-3600), basis, sunDir, mp: MP });
    assert.equal(before.reference, null, 'before the launch there is no rope');
    // Leading rope's apex reaches 1 AU at a finite time; half a day later Earth sits in the train.
    const h = hoursToReach(kernel, 0, 0);
    assert.ok(h > 10 && h < 120, `rope 0 reaches 1 AU after ${h} h`);
    let hit = null;
    for (let dh = 0; dh <= 36 && !hit; dh += 1) {
        const tS = (h + dh) * 3600;
        const out = traceImfLines({ fieldAt: fieldAtTrain(tS), basis, sunDir, mp: MP });
        if (out.reference?.at === 'earth' && out.lines.length) hit = { tS, out };
    }
    assert.ok(hit, 'Earth inside the train within 36 h of the apex arrival');
    for (const L of hit.out.lines) assert.ok(L.points.every(Number.isFinite));
    // The corridor draws the same train through trainAt at that instant.
    const train = trainAt(fc.preset, fc.launchMs, fc.launchMs + hit.tS * 1000, kernel);
    assert.ok(train.length >= 1 && train.every((m) => m.geometry.oracle === 'kernel'));
    assert.ok(train.some((m) => m.geometry.dAu > 0.9), 'some rope apex past 0.9 AU');
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-cme-model: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
