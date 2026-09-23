// tests/hero-earth.mjs — the homepage hero Earth's pure kernel (js/hero-earth.js)
//
//   node tests/hero-earth.mjs
//
// Pins: the canonical frame matches js/geo/coords.js; the orientation carries
// the REAL sub-solar point onto the scene Sun with a right-handed rotation
// and the pole at (90° − sub-solar latitude) from it, as close to scene +y
// as that allows; the sub-solar point agrees with the site's independent
// Almanac series (js/geomag/dipole.js); the texture tier picker; and that
// every file the tier table names exists.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    TEXTURE_TIERS, UHD_SHORTFALL, pickTextureTier, latLonToNormal,
    earthOrientation, matrixToQuaternion, applyMatrix,
} from '../js/hero-earth.js';
import { subsolarPointGeo } from '../js/geomag/dipole.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const vnear = (a, b, tol, msg) => a.forEach((x, i) => near(x, b[i], tol, `${msg}[${i}]`));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180 / Math.PI;

// ── 1. Canonical frame (js/geo/coords.js header) ──────────────────────────
vnear(latLonToNormal(0, 0), [1, 0, 0], 1e-15, 'lon 0 → +X');
vnear(latLonToNormal(90, 0), [0, 1, 0], 1e-15, 'north pole → +Y');
vnear(latLonToNormal(0, 90), [0, 0, -1], 1e-15, 'lon 90°E → −Z');
vnear(latLonToNormal(0, -90), [0, 0, 1], 1e-15, 'lon 90°W → +Z');

// ── 2. Orientation: the real sub-solar point faces the scene Sun ──────────
// The hero's SUN_DIR (js/hero-space-weather.js) and a few others, across the
// year and the day — equinoxes, solstices, arbitrary instants.
const SUN_DIRS = [norm([1, 0.12, -0.08]), [1, 0, 0], norm([0.3, -0.4, 0.8])];
const DATES = [
    '2026-03-20T14:46:00Z', '2026-06-21T08:24:00Z', '2026-09-23T00:05:00Z',
    '2026-12-21T20:50:00Z', '2026-09-23T15:30:00Z', '2027-02-14T03:11:27Z',
].map((s) => new Date(s));
for (const S of SUN_DIRS) {
    for (const d of DATES) {
        const o = earthOrientation(d, S);
        const m = o.matrix;
        const tag = `${d.toISOString()} S=${S.map((x) => x.toFixed(2))}`;
        // Orthonormal, det +1 (a rotation, never a reflection).
        const c0 = [m[0], m[3], m[6]], c1 = [m[1], m[4], m[7]], c2 = [m[2], m[5], m[8]];
        near(dot(c0, c0), 1, 1e-12, `${tag} |c0|`); near(dot(c1, c1), 1, 1e-12, `${tag} |c1|`);
        near(dot(c2, c2), 1, 1e-12, `${tag} |c2|`);
        near(dot(c0, c1), 0, 1e-12, `${tag} c0·c1`); near(dot(c1, c2), 0, 1e-12, `${tag} c1·c2`);
        const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
        near(det, 1, 1e-12, `${tag} det`);
        // The sub-solar point lands exactly on the Sun direction.
        vnear(applyMatrix(m, latLonToNormal(o.subsolar.lat, o.subsolar.lon)), S, 1e-12, `${tag} sub-solar → S`);
        // Pole at (90° − φ☉) from the Sun: the seasonal tilt is real.
        near(dot(o.pole, S), Math.sin(o.subsolar.lat * Math.PI / 180), 1e-12, `${tag} pole·S = sin φ☉`);
        // …and as close to scene +y as that allows: it lies in the plane of
        // +y and S, on the +y side.
        const planeNormal = norm([S[2], 0, -S[0]]);          // ŷ × S
        near(dot(o.pole, planeNormal), 0, 1e-12, `${tag} pole in span(ŷ, S)`);
        const upPerp = norm([0 - S[1] * S[0], 1 - S[1] * S[1], 0 - S[1] * S[2]]);
        assert.ok(dot(o.pole, upPerp) > 0.9, `${tag} pole leans to +y`);
        // Quaternion encodes the same rotation.
        const [x, y, z, w] = o.quaternion;
        near(Math.hypot(x, y, z, w), 1, 1e-12, `${tag} |q|`);
        const qm = [
            1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
        ];
        vnear(qm, m, 1e-12, `${tag} q ↔ matrix`);
    }
}

// matrixToQuaternion covers every branch (trace ≤ 0 cases included).
for (const m of [
    [1, 0, 0, 0, -1, 0, 0, 0, -1],     // 180° about x
    [-1, 0, 0, 0, 1, 0, 0, 0, -1],     // 180° about y
    [-1, 0, 0, 0, -1, 0, 0, 0, 1],     // 180° about z
]) {
    const [x, y, z, w] = matrixToQuaternion(m);
    near(Math.hypot(x, y, z, w), 1, 1e-12, 'branch |q|');
    near(Math.abs(w), 0, 1e-12, 'branch 180° has w = 0');
}

// ── 3. The sub-solar point is the real one ────────────────────────────────
// Two independent series on the site must agree (sun-altitude's NOAA/Meeus
// vs geomag/dipole's Almanac); and the solstice / equinox land where the
// calendar says.
for (const d of DATES) {
    const a = earthOrientation(d, [1, 0, 0]).subsolar;
    const b = subsolarPointGeo(d);
    near(a.lat, b.latDeg, 0.05, `${d.toISOString()} sub-solar lat vs dipole.js`);
    const dLon = ((a.lon - b.lonDeg + 540) % 360) - 180;
    near(dLon, 0, 0.1, `${d.toISOString()} sub-solar lon vs dipole.js`);
}
near(earthOrientation(new Date('2026-06-21T12:00:00Z'), [1, 0, 0]).subsolar.lat, 23.44, 0.05, 'June solstice declination');
near(earthOrientation(new Date('2026-12-21T12:00:00Z'), [1, 0, 0]).subsolar.lat, -23.44, 0.05, 'December solstice declination');
near(earthOrientation(new Date('2026-03-20T14:46:00Z'), [1, 0, 0]).subsolar.lat, 0, 0.05, 'March equinox declination');
// Noon at Greenwich (± the equation of time, < 17 min ⇒ < 4.2°).
near(earthOrientation(new Date('2026-09-23T12:00:00Z'), [1, 0, 0]).subsolar.lon, 0, 4.2, 'sub-solar lon at 12:00 UTC');
// The Sun moves WEST 15°/h over the ground.
{
    const l0 = earthOrientation(new Date('2026-09-23T12:00:00Z'), [1, 0, 0]).subsolar.lon;
    const l1 = earthOrientation(new Date('2026-09-23T13:00:00Z'), [1, 0, 0]).subsolar.lon;
    near(l1 - l0, -15, 0.05, 'sub-solar drifts west 15°/h');
}
// Seasonal tilt, in words: June lights the Arctic (pole leans sunward),
// December darkens it.
{
    const S = norm([1, 0.12, -0.08]);
    const june = earthOrientation(new Date('2026-06-21T12:00:00Z'), S).pole;
    const dec = earthOrientation(new Date('2026-12-21T12:00:00Z'), S).pole;
    assert.ok(dot(june, S) > 0.39 && dot(dec, S) < -0.39, 'solstice pole leans toward / away from the Sun');
    near(angDeg(june, S), 90 - 23.44, 0.1, 'June pole–Sun angle');
}

// ── 4. Texture tiers ───────────────────────────────────────────────────────
assert.equal(pickTextureTier({ restRadiusPx: 192, dpr: 1 }), 'hd', '1440×900 at 1× → 2k');
assert.equal(pickTextureTier({ restRadiusPx: 192, dpr: 2 }), 'uhd', '1440×900 at 2× → 4k');
assert.equal(pickTextureTier({ restRadiusPx: 192, dpr: 2, saveData: true }), 'boot', 'save-data stays on the boot tier');
assert.equal(pickTextureTier({ restRadiusPx: 110, dpr: 3, phone: true }), 'hd', 'phones never fetch 4k');
assert.equal(pickTextureTier({ restRadiusPx: 0 }), 'hd', 'unmeasured stage → 2k');
// The 4k threshold is exactly "2k falls UHD_SHORTFALL short".
const edge = TEXTURE_TIERS.hd.dayWidth * UHD_SHORTFALL / (2 * Math.PI);
assert.equal(pickTextureTier({ restRadiusPx: edge * 0.999 }), 'hd');
assert.equal(pickTextureTier({ restRadiusPx: edge * 1.001 }), 'uhd');

for (const [name, t] of Object.entries(TEXTURE_TIERS)) {
    for (const key of ['day', 'water', 'lights', 'relief']) {
        const p = join(ROOT, t[key]);
        assert.ok(existsSync(p) && statSync(p).size > 1000, `${name}.${key} missing: ${t[key]}`);
    }
    assert.ok(t.day.includes(t.dayWidth === 4096 ? '4k' : t.dayWidth === 2048 ? '2k' : '1k'), `${name} day width label`);
}

console.log('hero-earth: all assertions passed');
