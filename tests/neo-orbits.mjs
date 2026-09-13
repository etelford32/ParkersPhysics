/**
 * Gate for js/neo-orbits.js — the pure small-body kernel.
 *
 * Every assertion here is an IDENTITY or a pinned anchor, never a remembered
 * number from a previous run:
 *   - Kepler's equation is solved to 1e-12 on both branches, including the
 *     hard corner (e = 0.999, M near 0 and near π).
 *   - Propagation of Earth's own mean elements lands within 0.1° / 0.2 % of
 *     the page's VSOP87D Earth over ±20 years (two independent code paths).
 *   - Position and velocity obey vis-viva and finite-difference agreement,
 *     the hyperbolic branch reaches its asymptote and never inside q.
 *   - The bulk (columnar) path is bit-for-bit the scalar path.
 *   - The Earth-local frame reproduces the drawn Moon (planet-moons.js
 *     moonKmToScene('earth') at 384 400 km) — the anchor the whole local
 *     convention hangs on. planet-moons.js imports three, so the number is
 *     re-derived here from the SAME constants rather than imported.
 *   - The log scale matches solar-system.html's simDist (mirrored constants).
 *   - Meteor shower activity is zero outside windows and peaks at the peak.
 */
import assert from 'node:assert/strict';
import {
    AU_KM, LD_AU, GAUSS_K, LOG_SCALE, LOCAL_FRAME, FLAG, NEO_ROW_COLUMNS,
    solveKeplerElliptic, solveKeplerHyperbolic,
    normalizeElements, propagate, perifocalBasis, sampleOrbit, positionAtTrueAnomaly,
    prepareColumns, propagateColumns, deriveFrames,
    logSceneRadius, helioToScene, localSceneRadius, geoToLocalScene, localFrameWeight,
    precessionLongitudeRad, rotateAboutPole, toOfDate,
    neoClass, diameterKmFromH, formatSize, formatLD, toLD, speedKms, elementsAgeNote,
    rowToRecord, recordToRow, findNotable,
    METEOR_SHOWERS, solarLongitudeDeg, showerActivity, activeShowers, nextShower, radiantEclipticUnit,
} from '../js/neo-orbits.js';
import { earthHeliocentric } from '../js/horizons.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── Kepler solvers ──────────────────────────────────────────────────────────
for (const e of [0, 0.1, 0.5, 0.8, 0.95, 0.999]) {
    for (const M of [0, 1e-6, 0.3, 1.5, Math.PI - 1e-6, Math.PI, 4.0, 6.28, -2.0, 25.0]) {
        const E = solveKeplerElliptic(M, e);
        const Mn = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        near(E - e * Math.sin(E), Mn, 1e-11, `elliptic residual e=${e} M=${M}`);
    }
}
for (const e of [1.05, 1.2, 3.36, 6.14, 12]) {
    for (const M of [0, 1e-6, 0.4, 3, 40, 1e3, -0.4, -40]) {
        const H = solveKeplerHyperbolic(M, e);
        near(e * Math.sinh(H) - H, M, Math.max(1e-11, Math.abs(M) * 1e-13), `hyperbolic residual e=${e} M=${M}`);
    }
}

// ── Element normalisation ───────────────────────────────────────────────────
assert.equal(normalizeElements({ e: 1.0004, a: -100, i: 0, om: 0, w: 0, tp: 2460000 }).ok, false, 'parabolic band refused');
assert.equal(normalizeElements({ e: 0.5, a: 1.2, i: 0, om: 0, w: 0 }).ok, false, 'no time anchor refused');
assert.equal(normalizeElements({ e: 0.5, a: 1.2, i: 0, om: 0, w: 0 }).reason, 'no_time_anchor');
{
    const r = normalizeElements({ e: 3.36, q: 2.0, i: 44, om: 308, w: 209, tp: 2458826.0 });
    assert.equal(r.ok, true, 'hyperbolic from q alone');
    near(r.el.a, 2.0 / (1 - 3.36), 1e-12, 'a from q for e > 1 is negative');
    assert.equal(r.el.Q, null);
    const r2 = normalizeElements({ e: 3.36, a: Math.abs(r.el.a), i: 44, om: 308, w: 209, tp: 2458826.0 });
    assert.ok(r2.el.a < 0, 'a published as |a| for a hyperbola is flipped negative');
}
{
    const r = normalizeElements({ e: 0.2, a: 1.5, i: 10, om: 20, w: 30, ma: 40, epoch: 2461000.5 });
    near(r.el.q, 1.2, 1e-12, 'q derived'); near(r.el.Q, 1.8, 1e-12, 'Q derived');
    near(r.el.per_y, Math.pow(1.5, 1.5), 1e-12, 'period in years is a^1.5');
    near(r.el.n, GAUSS_K / Math.pow(1.5, 1.5), 1e-15, 'mean motion');
}

// ── Propagation identities ──────────────────────────────────────────────────
// (1) A circular orbit stays circular and closes after one period.
{
    const { el } = normalizeElements({ e: 0, a: 2.0, i: 0, om: 0, w: 0, ma: 0, epoch: 2451545.0 });
    const P = 2 * Math.PI / el.n;   // Gaussian year is 365.2569 d, not 365.25
    for (const f of [0, 0.25, 0.5, 0.9]) {
        const p = propagate(el, 2451545.0 + f * P);
        near(p.r, 2.0, 1e-12, 'circular radius');
    }
    const p0 = propagate(el, 2451545.0), p1 = propagate(el, 2451545.0 + P);
    near(p0.x, p1.x, 1e-9, 'closes in x'); near(p0.y, p1.y, 1e-9, 'closes in y');
}
// (2) Orientation: i = 90°, Ω = 0, ω = 0, ν = 90° ⇒ straight up the ecliptic pole.
{
    const { el } = normalizeElements({ e: 0, a: 1, i: 90, om: 0, w: 0, ma: 90, epoch: 2451545.0 });
    const p = propagate(el, 2451545.0);
    near(p.x, 0, 1e-12, 'x'); near(p.y, 0, 1e-12, 'y'); near(p.z, 1, 1e-12, 'z is up');
}
// (3) Earth's mean elements versus the page's VSOP87D Earth, ±20 years.
{
    // Standish (1992) J2000 mean elements, rates per century — an independent source.
    const T = 0;
    const { el } = normalizeElements({
        e: 0.01671123, a: 1.00000261, i: -0.00001531 + 0 * T,
        om: 0.0, w: 102.93768193, ma: (100.46457166 - 102.93768193 + 360) % 360, epoch: 2451545.0,
    });
    for (const jd of [2451545.0, 2455000.5, 2461000.5, 2458849.5, 2444239.5]) {
        const p = toOfDate(propagate(el, jd), jd);      // J2000 elements → ecliptic of date
        const v = earthHeliocentric(jd);                  // VSOP87D is OF DATE
        const lonK = Math.atan2(p.y, p.x), lonV = v.lon_rad;
        let dlon = ((lonK - lonV) * 180 / Math.PI + 540) % 360 - 180;
        // What is left is the secular drift of the mean elements (~0.05°/26 yr)
        // and Earth's periodic perturbations (~0.01°). Without the precession
        // rotation this is 0.41° in 2025 — 2.5 lunar distances at 1 AU.
        assert.ok(Math.abs(dlon) < 0.12, `Earth longitude at JD ${jd}: kernel vs VSOP87D differ by ${dlon.toFixed(3)}°`);
        near(p.r / v.dist_AU, 1, 2e-3, `Earth distance at JD ${jd}`);
    }
    // The rotation is a proper rotation about the pole with the IAU 1976 rate.
    { const T = (2461000.5 - 2451545) / 36525;
      near(precessionLongitudeRad(2461000.5) * 180 / Math.PI, (5029.0966 * T + 1.11113 * T * T) / 3600, 1e-12, 'p_A at 2025 (IAU 1976)'); }
    const rr = rotateAboutPole(1, 0, 0.5, Math.PI / 2); near(rr.x, 0, 1e-15, 'rot x'); near(rr.y, 1, 1e-15, 'rot y'); assert.equal(rr.z, 0.5);
}
// (4) Velocity: vis-viva and finite difference, both branches.
for (const rec of [
    { e: 0.191, a: 0.9224, i: 3.33, om: 204.4, w: 126.4, ma: 200, epoch: 2461000.5 },   // Apophis-like
    { e: 6.14, q: 1.356, i: 175.1, om: 322.2, w: 128.0, tp: 2460977.6 },                  // 3I/ATLAS-like
]) {
    const { el } = normalizeElements(rec);
    const mu = GAUSS_K * GAUSS_K;   // AU³/day²
    for (const jd of [2460900.5, 2461050.5, 2461500.5]) {
        const p = propagate(el, jd, true);
        const v2 = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
        near(v2, mu * (2 / p.r - 1 / el.a), 1e-12, `vis-viva e=${el.e} JD ${jd}`);
        const h = 1e-3;
        const pa = propagate(el, jd - h), pb = propagate(el, jd + h);
        near(p.vx, (pb.x - pa.x) / (2 * h), 1e-7, 'vx finite difference');
        near(p.vy, (pb.y - pa.y) / (2 * h), 1e-7, 'vy finite difference');
        near(p.vz, (pb.z - pa.z) / (2 * h), 1e-7, 'vz finite difference');
        assert.ok(p.r >= el.q * (1 - 1e-9), 'never inside perihelion');
    }
    if (el.e > 1) {
        // Long after perihelion the hyperbola approaches its asymptote and keeps receding.
        const far = propagate(el, el.t0 + 40 * 365.25), farther = propagate(el, el.t0 + 80 * 365.25);
        assert.ok(farther.r > far.r * 1.9, 'hyperbola recedes ~linearly');
        assert.ok(far.r > 50, '40 years out it is well past Neptune');
    }
}
// (5) Perifocal basis is orthonormal.
{
    const B = perifocalBasis(23.4, 155.2, 300.1);
    near(B.Px * B.Px + B.Py * B.Py + B.Pz * B.Pz, 1, 1e-14, '|P|');
    near(B.Qx * B.Qx + B.Qy * B.Qy + B.Qz * B.Qz, 1, 1e-14, '|Q|');
    near(B.Px * B.Qx + B.Py * B.Qy + B.Pz * B.Qz, 0, 1e-14, 'P⊥Q');
}
// (6) Orbit sampling: ellipse closes and every sample obeys the conic; hyperbola
//     is cut at rMax and stays outside q.
{
    const { el } = normalizeElements({ e: 0.6, a: 2.5, i: 12, om: 33, w: 77, ma: 10, epoch: 2461000.5 });
    const pts = sampleOrbit(el, 64);
    assert.equal(pts.length, 64);
    near(pts[0].r, el.q, 1e-12, 'ν = 0 is perihelion');
    near(pts[32].r, el.Q, 1e-9, 'ν = π is aphelion');
    const { el: hy } = normalizeElements({ e: 3.36, q: 2.0, i: 44, om: 308, w: 209, tp: 2458826.0 });
    const hp = sampleOrbit(hy, 100, 30);
    assert.equal(hp.length, 101);
    for (const p of hp) { assert.ok(p.r >= hy.q - 1e-9 && p.r <= 30 + 1e-6, `hyperbola sample r=${p.r}`); }
    near(positionAtTrueAnomaly(hy, 0).r, hy.q, 1e-12, 'hyperbola perihelion');
}

// ── Bulk path ≡ scalar path ─────────────────────────────────────────────────
{
    const records = [
        { des: 'a', e: 0.191, a: 0.9224, i: 3.33, om: 204.4, w: 126.4, ma: 200, epoch: 2461000.5, flags: FLAG.NEO | FLAG.PHA },
        { des: 'b', e: 6.14, q: 1.356, i: 175.1, om: 322.2, w: 128.0, tp: 2460977.6, flags: FLAG.INTERSTELLAR },
        { des: 'bad', e: 1.0002, a: -50, i: 0, om: 0, w: 0, tp: 2460000 },
        { des: 'c', e: 0.83, a: 1.27, i: 22.2, om: 265.2, w: 322.2, ma: 45.5, epoch: 2461000.5, flags: FLAG.NEO },
    ];
    const { els, cols, rejected } = prepareColumns(records);
    assert.equal(els.length, 3); assert.equal(rejected.parabolic, 1);
    assert.equal(cols.flags[0], FLAG.NEO | FLAG.PHA);
    const helio = new Float64Array(9);
    const jd = 2461123.25;
    assert.equal(propagateColumns(cols, jd, helio), 3);
    for (let k = 0; k < 3; k++) {
        const p = propagate(els[k], jd);
        assert.equal(helio[k * 3], p.x, `bulk x ${k}`);
        assert.equal(helio[k * 3 + 1], p.y, `bulk y ${k}`);
        assert.equal(helio[k * 3 + 2], p.z, `bulk z ${k}`);
    }
    const scene = new Float32Array(9), rH = new Float32Array(3), rG = new Float32Array(3);
    const prec = precessionLongitudeRad(jd);
    deriveFrames(helio, 3, [1, 0, 0], scene, rH, rG, prec);
    for (let k = 0; k < 3; k++) {
        const d = rotateAboutPole(helio[k * 3], helio[k * 3 + 1], helio[k * 3 + 2], prec);
        const s = helioToScene(d.x, d.y, d.z);
        near(scene[k * 3], s.x, 1e-6, 'scene x'); near(scene[k * 3 + 1], s.y, 1e-6, 'scene y'); near(scene[k * 3 + 2], s.z, 1e-6, 'scene z');
        near(rH[k], Math.hypot(d.x, d.y, d.z), 1e-6, 'r helio');
        near(rG[k], Math.hypot(d.x - 1, d.y, d.z), 1e-6, 'r geo (Earth given of date)');
    }
    // Without the rotation the geocentric distance of an object AT Earth is
    // off by 2.5 LD in 2025 — the bug this parameter exists to prevent.
    {
        const eOfDate = rotateAboutPole(1, 0, 0, prec);
        const atEarthJ2000 = new Float64Array([1, 0, 0]);
        const sc = new Float32Array(3), a = new Float32Array(1), g0 = new Float32Array(1), g1 = new Float32Array(1);
        deriveFrames(atEarthJ2000, 1, [eOfDate.x, eOfDate.y, 0], sc, a, g0, 0);
        deriveFrames(atEarthJ2000, 1, [eOfDate.x, eOfDate.y, 0], sc, a, g1, prec);
        assert.ok(g0[0] / LD_AU > 2, `unrotated error is ${(g0[0] / LD_AU).toFixed(2)} LD`);
        assert.ok(g1[0] / LD_AU < 1e-4, 'rotated: coincident');
    }
}

// ── Scene conventions ───────────────────────────────────────────────────────
// Log scale: mirrors solar-system.html simDist = 2.5 + 4.2·ln(1 + 1.8·d).
assert.deepEqual({ ...LOG_SCALE }, { base: 2.5, gain: 4.2, k: 1.8 });
near(logSceneRadius(1), 2.5 + 4.2 * Math.log(2.8), 1e-12, 'simDist(1)');
assert.ok(logSceneRadius(0.1) < logSceneRadius(1) && logSceneRadius(1) < logSceneRadius(30), 'monotonic');
{
    // Axis swap: ecliptic +y (λ = 90°) is scene +z; ecliptic +z (north) is scene +y.
    const s = helioToScene(0, 1, 0); near(s.z, logSceneRadius(1), 1e-12, 'λ=90° → +z'); near(s.y, 0, 1e-12, 'flat');
    const n = helioToScene(0, 0, 1); near(n.y, logSceneRadius(1), 1e-12, 'north → +y');
}
// Earth-local frame: the Moon anchors it.
{
    // planet-moons.js: R·0.85·(r/60268)^0.55, R = 0.12 (earthR in solar-system.html), unclamped for r = 384 400 km
    const moonDrawn = 0.12 * 0.85 * Math.pow(384_400 / 60_268, 0.55);
    assert.ok(moonDrawn > 0.12 * 1.7 && moonDrawn < 0.12 * 6.0, 'the Moon sits inside the moon clamp, so both maps agree there');
    near(localSceneRadius(384_400), moonDrawn, 1e-12, 'local frame draws 1 LD where the page draws the Moon');
    near(localSceneRadius(384_400), 0.2826, 2e-4, 'pinned Moon radius');
    assert.equal(LOCAL_FRAME.maxLD, 20);
    const g = geoToLocalScene(LD_AU, 0, 0);
    near(g.dLD, 1, 1e-9, 'dLD'); near(Math.hypot(g.x, g.y, g.z), moonDrawn, 1e-12, 'offset magnitude');
    const up = geoToLocalScene(0, 0, 2 * LD_AU); near(up.y, localSceneRadius(2 * LD_AU * AU_KM), 1e-12, 'north is scene +y');
    // The clamp-free frame keeps growing past 5.5 LD, where the moon config saturates.
    assert.ok(localSceneRadius(10 * LD_AU * AU_KM) > 0.12 * 6.0, 'no 6 R⊕ clamp');
    assert.equal(localFrameWeight(1), 0); assert.equal(localFrameWeight(25), 1);
    const mid = localFrameWeight(17); assert.ok(mid > 0.4 && mid < 0.6, 'smooth mid-fade');
    assert.ok(localFrameWeight(15) < localFrameWeight(19), 'monotonic fade');
}

// ── Classification / physical ───────────────────────────────────────────────
assert.equal(neoClass(0.9224, 0.191), 'ATE', 'Apophis is an Aten');
assert.equal(neoClass(1.126, 0.204), 'APO', 'Bennu is an Apollo');
assert.equal(neoClass(1.458, 0.223), 'AMO', 'Eros is an Amor');
assert.equal(neoClass(0.741, 0.322), 'IEO', '163693 Atira');
assert.equal(neoClass(-1.27, 6.14), 'HYA');
near(diameterKmFromH(22, 0.14), 1329 / Math.sqrt(0.14) * Math.pow(10, -4.4), 1e-9, 'H → D');
assert.ok(diameterKmFromH(22, 0.14) > 0.13 && diameterKmFromH(22, 0.14) < 0.15, 'H 22 ≈ 140 m');
assert.equal(formatSize(0.055), '~55 m'); assert.equal(formatSize(0.34), '~340 m'); assert.equal(formatSize(1.23), '~1.2 km'); assert.equal(formatSize(null), '—');
assert.equal(formatLD(5 * LD_AU), '5.00 LD'); assert.equal(formatLD(12.34 * LD_AU), '12.3 LD');
assert.match(formatLD(0.05 * LD_AU), /km$/);
near(toLD(0.05), 19.46, 0.01, '0.05 AU ≈ 19.5 LD');
near(speedKms(GAUSS_K, 0, 0), 29.78, 0.05, 'Earth’s circular speed');
assert.match(elementsAgeNote(2461000.5, 2461100.5), /current/);
assert.match(elementsAgeNote(2461000.5, 2461000.5 + 5 * 365.25), /perturbations/);

// ── Wire format round trip ──────────────────────────────────────────────────
{
    const rec = { des: '99942', name: '99942 Apophis (2004 MN4)', H: 19.09, cls: 'ATE', flags: 3, e: 0.1914, a: 0.9224, q: null, i: 3.34, om: 203.9, w: 126.7, ma: 100.1, tp: null, epoch: 2461000.5, moid: 0.0003, diam: 0.34 };
    assert.equal(recordToRow(rec).length, NEO_ROW_COLUMNS.length);
    assert.deepEqual(rowToRecord(recordToRow(rec)), rec);
    assert.equal(findNotable(rec).label, 'Apophis');
    assert.equal(findNotable({ des: 'C/2025 N1', name: '3I/ATLAS (C/2025 N1)' }).label, '3I/ATLAS');
    assert.equal(findNotable({ des: '2020 XY', name: '(2020 XY)' }), null);
}

// ── Meteor showers ──────────────────────────────────────────────────────────
assert.ok(METEOR_SHOWERS.length >= 12);
for (const s of METEOR_SHOWERS) {
    near(showerActivity(s, s.peakLon), 1, 1e-12, `${s.code} peaks at its peak`);
    assert.equal(showerActivity(s, s.startLon - 5), 0, `${s.code} silent before window`);
    assert.equal(showerActivity(s, s.endLon + 5), 0, `${s.code} silent after window`);
    assert.ok(showerActivity(s, s.startLon + 0.01) < 0.1, `${s.code} faint at window start`);
}
{
    // 2026-08-12 → λ☉ ≈ 139.7°: Perseids at peak, Geminids silent.
    const aug = activeShowers(139.7);
    assert.equal(aug[0].shower.code, 'PER');
    assert.ok(!aug.find(x => x.shower.code === 'GEM'));
    const jan = activeShowers(283.15); assert.equal(jan[0].shower.code, 'QUA');
    const nx = nextShower(150); assert.equal(nx.shower.code, 'DRA'); assert.ok(nx.daysAhead > 40 && nx.daysAhead < 50);
    const wrap = nextShower(275.5); assert.equal(wrap.shower.code, 'QUA', 'wraps through 360°');
    // λ☉ from Earth's heliocentric longitude: Earth at λ = 320° ⇒ Sun at 140°.
    near(solarLongitudeDeg(320 * Math.PI / 180), 140, 1e-9, 'λ☉ = λ⊕ + 180');
    const u = radiantEclipticUnit(48, 58);
    near(Math.hypot(u.x, u.y, u.z), 1, 1e-12, 'radiant is a unit vector');
    const pole = radiantEclipticUnit(270, 66.5607); near(pole.z, 1, 2e-6, 'RA 18h Dec +66.56° is the ecliptic north pole');
}

console.log(`neo-orbits: Kepler ×${6 * 10 + 5 * 8} residuals, Earth-vs-VSOP87D, vis-viva, bulk≡scalar, Moon anchor, ${METEOR_SHOWERS.length} showers — passed`);
