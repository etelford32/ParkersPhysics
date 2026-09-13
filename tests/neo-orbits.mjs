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

// ═══════════════════════════════════════════════════════════════════════════
// Photometry, sizing, analysis, planet paths (2026-09 accuracy pass)
// ═══════════════════════════════════════════════════════════════════════════
import {
    phaseAngleDeg, elongationDeg, hgPhaseFunction, apparentMagnitude, MAG_DISPLAY, magnitudeSizePx, magnitudeAlpha,
    trueScaleRadius, pixelFloorRadius, rockDrawRadius, EARTH_RADIUS_KM,
    tisserandJ, JUPITER_A_AU, nodeDistancesAU, earthCrossingNote, nextPerihelionJD, jdToIsoDate, eclipticLonLatDeg,
    ephemerisPathScene, ribbonStrip,
} from '../js/neo-orbits.js';
import { ceresHeliocentric, marsHeliocentric, mercuryHeliocentric, PLANET_ELEMENTS } from '../js/horizons.js';

// ── Apparent magnitude: H–G identities ──────────────────────────────────────
near(apparentMagnitude(0, 1, 1, 0), 0, 1e-12, 'V = H at r = Δ = 1 AU, α = 0');
near(hgPhaseFunction(0), 1, 1e-12, 'Φ(0) = 1');
{
    const v90 = apparentMagnitude(0, 1, 1, 90);
    assert.ok(v90 > 3.0 && v90 < 3.4, `α = 90° costs ~3.2 mag for G = 0.15, got ${v90}`);
    assert.ok(apparentMagnitude(20, 1, 0.01, 0) < apparentMagnitude(20, 1, 0.1, 0), 'closer ⇒ brighter');
    assert.ok(apparentMagnitude(20, 1, 0.1, 0) < apparentMagnitude(20, 1, 1, 0), 'closer ⇒ brighter (2)');
    assert.ok(apparentMagnitude(20, 1, 1, 30) > apparentMagnitude(20, 1, 1, 0), 'phase ⇒ fainter');
    for (let a = 0; a < 150; a += 5) assert.ok(hgPhaseFunction(a + 5) < hgPhaseFunction(a), `Φ monotone at ${a}`);
    near(apparentMagnitude(10, 2, 1, 0, { comet: true }), 10 + 10 * Math.log10(2), 1e-12, 'comet n = 4 law');
    assert.equal(apparentMagnitude(null, 1, 1, 0), null, 'no H ⇒ null');
    assert.equal(apparentMagnitude(20, 0, 1, 0), null, 'r = 0 ⇒ null');
}
// Geometry: object beyond Earth on the Sun–Earth line is at opposition (α = 0, ε = 180); between them, α = 180, ε = 0.
near(phaseAngleDeg(2, 0, 0, 1, 0, 0), 0, 1e-9, 'opposition phase angle');
near(phaseAngleDeg(0.5, 0, 0, -0.5, 0, 0), 180, 1e-9, 'inferior conjunction phase angle');
near(elongationDeg(1, 0, 0, 1, 0, 0), 180, 1e-9, 'opposition elongation');
near(elongationDeg(1, 0, 0, -0.5, 0, 0), 0, 1e-9, 'conjunction elongation');
near(elongationDeg(1, 0, 0, 0, 1, 0), 90, 1e-9, 'quadrature');
assert.equal(phaseAngleDeg(0, 0, 0, 1, 0, 0), null, 'degenerate phase ⇒ null');

// ── Display maps: monotone, bounded, defined for unknowns ───────────────────
{
    let prevS = Infinity, prevA = Infinity;
    for (let V = 0; V <= 40; V += 0.5) {
        const s = magnitudeSizePx(V), a = magnitudeAlpha(V);
        assert.ok(s <= prevS && a <= prevA, `maps non-increasing at V ${V}`);
        assert.ok(s >= MAG_DISPLAY.sizeMinPx && s <= MAG_DISPLAY.sizeMaxPx, 'size bounded');
        assert.ok(a >= MAG_DISPLAY.alphaMin - 1e-12 && a <= 1, 'alpha bounded');
        prevS = s; prevA = a;
    }
    assert.equal(magnitudeSizePx(MAG_DISPLAY.sizeBrightV), MAG_DISPLAY.sizeMaxPx, 'bright end');
    assert.equal(magnitudeSizePx(40), MAG_DISPLAY.sizeMinPx, 'faint end');
    near(magnitudeAlpha(40), MAG_DISPLAY.alphaMin, 1e-12, 'alpha floor');
    assert.equal(magnitudeAlpha(NaN), MAG_DISPLAY.unknownAlpha, 'unknown alpha');
    assert.ok(magnitudeSizePx(NaN) > MAG_DISPLAY.sizeMinPx, 'unknown size is mid-range');
}
// deriveFrames' bulk V is the scalar formula, bit-for-bit in spirit (1e-9 in V).
{
    const recs = [
        { des: 'A', H: 19.7, e: 0.19, a: 0.92, i: 3.3, om: 204, w: 126, ma: 10, epoch: 2461000.5, flags: FLAG.NEO },
        { des: 'C', H: 8.0, e: 0.6, a: 3.2, i: 12, om: 30, w: 200, ma: 100, epoch: 2461000.5, flags: FLAG.NEO | FLAG.COMET },
        { des: 'N', e: 0.3, a: 1.5, i: 5, om: 10, w: 20, ma: 30, epoch: 2461000.5, flags: FLAG.NEO },   // no H
    ];
    const { cols, els } = prepareColumns(recs);
    const N = cols.count;
    const helio = new Float64Array(3 * N), scene = new Float32Array(3 * N), rH = new Float32Array(N), rG = new Float32Array(N), vmag = new Float32Array(N);
    const jd = 2461030.5;
    propagateColumns(cols, jd, helio);
    const E = earthHeliocentric(jd), earth = [E.x_AU, E.y_AU, E.z_AU];
    const prec = precessionLongitudeRad(jd);
    deriveFrames(helio, N, earth, scene, rH, rG, prec, vmag, cols.H, cols.flags);
    for (let k = 0; k < N; k++) {
        const d = rotateAboutPole(helio[k * 3], helio[k * 3 + 1], helio[k * 3 + 2], prec);
        const g = { x: d.x - earth[0], y: d.y - earth[1], z: d.z - earth[2] };
        const alpha = phaseAngleDeg(d.x, d.y, d.z, g.x, g.y, g.z);
        const V = apparentMagnitude(els[k].H, rH[k], rG[k], alpha, { comet: !!(els[k].flags & FLAG.COMET) });
        if (V == null) assert.ok(Number.isNaN(vmag[k]), 'no H ⇒ NaN in bulk');
        else near(vmag[k], V, 1e-4, `bulk V ≡ scalar V for ${els[k].des}`);
    }
    assert.ok(Number.isNaN(cols.H[2]), 'missing H stored as NaN');
}

// ── Sizes: true scale + pixel floor ─────────────────────────────────────────
near(trueScaleRadius(2 * EARTH_RADIUS_KM), LOCAL_FRAME.earthSceneRadius, 1e-15, 'an Earth-sized body draws at the drawn Earth radius');
assert.equal(trueScaleRadius(null), 0, 'unknown size ⇒ 0 true radius');
{
    // 36 px at 0.09 units, 900 px tall, fov 50°: r/d = (36/900)·2·tan 25°.
    const floor = pixelFloorRadius(0.09, 36, 900, 50);
    near(floor / 0.09, (36 / 900) * 2 * Math.tan(25 * Math.PI / 180), 1e-12, 'pixel floor subtends the requested fraction');
    const rk = rockDrawRadius(0.34, { camDist: 0.09, minPx: 36, viewHeightPx: 900, fovDeg: 50 });
    assert.ok(rk.atFloor && rk.r === floor, 'a 340 m rock is at the floor from 0.09 units');
    assert.ok(rk.exaggeration > 100, `and says so (×${rk.exaggeration.toFixed(0)})`);
    const big = rockDrawRadius(2 * EARTH_RADIUS_KM, { camDist: 0.09, minPx: 36 });
    assert.ok(!big.atFloor && big.exaggeration === 1, 'a planet-sized body is drawn true');
    assert.equal(rockDrawRadius(null, { camDist: 0.09 }).exaggeration, null, 'unknown size ⇒ no exaggeration claim');
}

// ── Orbit analysis identities ───────────────────────────────────────────────
near(tisserandJ(JUPITER_A_AU, 0, 0), 3, 1e-12, 'Jupiter\'s own orbit: T_J = 3');
assert.ok(tisserandJ(17.8, 0.967, 162.3) < 2, 'Halley-type: T_J < 2');
assert.equal(tisserandJ(-1.2, 1.1, 10), null, 'unbound ⇒ null');
{
    const el = normalizeElements({ e: 0.191, a: 0.922, i: 3.3, om: 204, w: 126.4, ma: 0, epoch: 2461000.5 }).el;   // Apophis-like
    const nd = nodeDistancesAU(el);
    const p = el.a * (1 - el.e * el.e);
    near(1 / nd.asc + 1 / nd.desc, 2 / p, 1e-12, 'node distances: 1/r_asc + 1/r_desc = 2/p');
    assert.ok(nd.asc > 0.983 && nd.asc < 1.017, `Apophis-like: ascending node in Earth's band (${nd.asc.toFixed(4)})`);
    assert.equal(earthCrossingNote(nd), 'crosses Earth’s orbit at the ascending node');
    const circ = normalizeElements({ e: 0, a: 1.3, i: 10, om: 0, w: 45, ma: 0, epoch: 2461000.5 }).el;
    const nc = nodeDistancesAU(circ);
    near(nc.asc, 1.3, 1e-12, 'circle: asc node at a'); near(nc.desc, 1.3, 1e-12, 'circle: desc node at a');
    assert.equal(earthCrossingNote(nc), 'no node inside Earth’s orbital band');
    assert.equal(earthCrossingNote({ asc: 1.0, desc: 1.0 }), 'crosses Earth’s orbit at both nodes');
    const hyp = normalizeElements({ e: 3.2, q: 0.3, i: 90, om: 0, w: 0, tp: 2461000.5 }).el;
    const nh = nodeDistancesAU(hyp);
    near(nh.asc, 0.3, 1e-12, 'hyperbola: ν = 0 node at q');
    assert.equal(nh.desc, null, 'hyperbola: the ν = 180° node is not on the orbit');
}
{
    const el = normalizeElements({ e: 0.2, a: 1, i: 0, om: 0, w: 0, ma: 0, epoch: 2451545 }).el;
    const P = 2 * Math.PI / el.n;
    near(nextPerihelionJD(el, 2451545), 2451545, 1e-9, 'at perihelion now');
    near(nextPerihelionJD(el, 2451545 + 1), 2451545 + P, 1e-6, 'next perihelion one period on');
    near(nextPerihelionJD(el, 2451545 + 2.5 * P), 2451545 + 3 * P, 1e-6, 'wraps whole periods');
    const hyp = normalizeElements({ e: 1.5, q: 0.5, i: 0, om: 0, w: 0, tp: 2461000.5 }).el;
    near(nextPerihelionJD(hyp, 2460000.5), 2461000.5, 1e-9, 'hyperbola: tp ahead');
    assert.equal(nextPerihelionJD(hyp, 2462000.5), null, 'hyperbola: tp behind ⇒ null');
    assert.equal(jdToIsoDate(2451545.0), '2000-01-01', 'J2000 noon is 2000-01-01');
    const ll = eclipticLonLatDeg(0, 1, 0); near(ll.lon, 90, 1e-12, 'lon'); near(ll.lat, 0, 1e-12, 'lat');
    near(eclipticLonLatDeg(-1, 0, 1).lat, 45, 1e-9, 'lat 45');
    near(eclipticLonLatDeg(1, -1e-9, 0).lon, 360, 1e-6, 'lon wraps to [0,360)');
}

// ── Planet paths: the sampled TRUE path lands where the planet is drawn ─────
{
    const jd = 2461000.5;
    const path = ephemerisPathScene(earthHeliocentric, jd, 365.25, 64);
    assert.equal(path.length, 64 * 3);
    const R = logSceneRadius(1);
    for (let k = 0; k < 64; k++) {
        const r = Math.hypot(path[k * 3], path[k * 3 + 1], path[k * 3 + 2]);
        assert.ok(Math.abs(r - R) / R < 0.02, `Earth path radius within 2 % of the 1 AU ring at sample ${k}`);
    }
    // Sample 0 is half a period before jd, sample 32 is jd itself: opposite sides of the Sun.
    const dot = path[0] * path[96] + path[2] * path[98];
    assert.ok(dot < 0, 'half a period apart ⇒ opposite sides');
    const E = earthHeliocentric(jd), s = helioToScene(E.x_AU, E.y_AU, E.z_AU);
    near(path[96], s.x, 1e-5, 'the mid sample IS the planet\'s drawn position (x)');
    near(path[98], s.z, 1e-5, 'the mid sample IS the planet\'s drawn position (z)');
    // Mercury: the radial swing that the circle model never had.
    const merc = ephemerisPathScene(mercuryHeliocentric, jd, 87.969, 128);
    let rMin = Infinity, rMax = 0;
    for (let k = 0; k < 128; k++) { const r = Math.hypot(merc[k * 3], merc[k * 3 + 1], merc[k * 3 + 2]); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
    near(rMin, logSceneRadius(0.3075), 0.02, 'Mercury perihelion on the log map');
    near(rMax, logSceneRadius(0.4667), 0.02, 'Mercury aphelion on the log map');
    // Ribbon: sides are in-plane, perpendicular to the tangent, of the requested width, and the strip closes.
    const hw = 0.012;
    const rib = ribbonStrip(path, hw);
    assert.equal(rib.positions.length, 64 * 6); assert.equal(rib.indices.length, 64 * 6);
    for (let i = 0; i < 64; i++) {
        const ip = (i + 63) % 64, inx = (i + 1) % 64;
        const t = [path[inx * 3] - path[ip * 3], path[inx * 3 + 1] - path[ip * 3 + 1], path[inx * 3 + 2] - path[ip * 3 + 2]];
        const d = [rib.positions[i * 6] - rib.positions[i * 6 + 3], rib.positions[i * 6 + 1] - rib.positions[i * 6 + 4], rib.positions[i * 6 + 2] - rib.positions[i * 6 + 5]];
        near(Math.hypot(...d), 2 * hw, 1e-6, `ribbon width at ${i}`);   // float32 output
        near(Math.abs(t[0] * d[0] + t[1] * d[1] + t[2] * d[2]) / (Math.hypot(...t) * 2 * hw), 0, 1e-4, `side ⟂ tangent at ${i}`);
        // Both sides are in the orbital plane: (p × t) · side = 0.
        const p = [path[i * 3], path[i * 3 + 1], path[i * 3 + 2]];
        const nrm = [p[1] * t[2] - p[2] * t[1], p[2] * t[0] - p[0] * t[2], p[0] * t[1] - p[1] * t[0]];
        near(Math.abs(nrm[0] * d[0] + nrm[1] * d[1] + nrm[2] * d[2]) / (Math.hypot(...nrm) * 2 * hw), 0, 1e-4, `side in plane at ${i}`);
        for (let j = 0; j < 6; j++) assert.ok(rib.indices[i * 6 + j] < 128, 'index in range');
    }
}
// Ceres: the mean elements reproduce perihelion on 2018-04-28 and stay inside q..Q for 60 years.
{
    const q = PLANET_ELEMENTS.ceres.a * (1 - PLANET_ELEMENTS.ceres.e), Q = PLANET_ELEMENTS.ceres.a * (1 + PLANET_ELEMENTS.ceres.e);
    near(ceresHeliocentric(2458236.5).dist_AU, q, 0.002, 'Ceres at perihelion on 2018-04-28');
    for (let jd = 2451545; jd < 2451545 + 60 * 365.25; jd += 37) {
        const c = ceresHeliocentric(jd);
        assert.ok(c.dist_AU >= q - 1e-6 && c.dist_AU <= Q + 1e-6, `Ceres r in [q, Q] at ${jd}`);
    }
    const d1 = ceresHeliocentric(2461000.5).lon, d2 = ceresHeliocentric(2461010.5).lon;
    const rate = (((d2 - d1) % 360) + 360) % 360 / 10;
    assert.ok(rate > 0.17 && rate < 0.26, `Ceres moves ~0.21°/day (${rate.toFixed(3)})`);
    // Mars, the same way the page draws it: through helioToScene.
    const m = marsHeliocentric(2461000.5), sm = helioToScene(m.x_AU, m.y_AU, m.z_AU);
    near(Math.hypot(sm.x, sm.y, sm.z), logSceneRadius(m.dist_AU), 1e-9, 'planet radius on the log map');
}
console.log('neo-orbits photometry / sizing / analysis / planet-path checks passed');
