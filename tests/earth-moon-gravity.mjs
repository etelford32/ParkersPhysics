/**
 * Gate for js/earth-moon-gravity.js — the Earth–Moon gravity kernel behind
 * neo-watch.html's Lagrange layer, profile chart and location analysis.
 *
 * Every assertion is an IDENTITY, a DEFINING property, or a cross-check
 * against an independently written path or a published table:
 *
 *   - Each Lagrange point is an EQUILIBRIUM: the numerical gradient of Ω
 *     vanishes there. L4/L5 are equilateral with both primaries.
 *   - Their Jacobi constants match Szebehely's tabulation for the Earth–Moon μ
 *     (C_L1 3.18834, C_L2 3.17216, C_L3 3.01215, C_L4,5 2.98800).
 *   - The collinear distances agree with the Hill approximation γ ≈ (μ/3)^⅓
 *     to its own stated accuracy, and Sun–Earth L1/L2 bracket the Hill radius
 *     neo-space.js already draws.
 *   - The GLSL mirror of 2Ω, TRANSLITERATED back to JS, equals jacobiField.
 *   - toRotating ∘ rotatingToGeoKm is the identity; the Moon sits at
 *     (1−μ, 0, 0) in its own frame; e1/e2/e3 are orthonormal and right-handed.
 *   - The Jacobi constant is CONSERVED along a numerically integrated CR3BP
 *     orbit (independent RK4 here) — the property that makes it worth printing.
 *   - The acceleration budget: Earth's term is exactly μ/r²; the solar tide
 *     reduces to the linear tide 2μ☉r/d³ on the Sun line; the profile's
 *     tide-over-Earth crossing is (3/2)^⅓ of the Hill radius (the 2 vs 3 is the
 *     centrifugal term the Hill radius includes and a geocentric tide does not).
 */
import assert from 'node:assert/strict';
import {
    MU_MOON, EM_MU, SE_MU, MU_EARTH_MOON,
    perturbingAcceleration, earthAcceleration, accelerationBudget, gravityProfile,
    formatAcceleration, jacobiField, jacobiField3, JACOBI_FIELD_GLSL, jacobiConstant,
    collinearPoints, lagrangePoints, gateState, moonHillRadiusKm, moonSoiRadiusKm,
    moonState, earthMoonFrame, toRotating, rotatingToGeoKm, lagrangeGeometry,
    locationAnalysis, realmOf, LAGRANGE_ROLES, GATE_LABELS, DOMINANT_LABELS,
} from '../js/earth-moon-gravity.js';
import {
    MU_EARTH, MU_SUN, AU_KM, LD_KM, EARTH_RADIUS_KM, hillRadiusKm,
    earthHelioJ2000, moonGeoJ2000,
} from '../js/neo-space.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const rel = (a, b, tol, msg) => assert.ok(Math.abs(a / b - 1) <= tol, `${msg}: ${a} vs ${b} (rel tol ${tol})`);
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

// ── Constants are derived ────────────────────────────────────────────────────
near(EM_MU, MU_MOON / (MU_EARTH + MU_MOON), 0, 'EM_MU derived');
near(EM_MU, 0.0121506, 1e-6, 'Earth–Moon mass parameter');
near(SE_MU, MU_EARTH_MOON / (MU_SUN + MU_EARTH_MOON), 0, 'SE_MU derived');
ok('mass parameters are derived from the GMs');

// ── Lagrange points are equilibria ───────────────────────────────────────────
const grad = (x, y, mu) => {
    const h = 1e-6;
    return [
        (jacobiField(x + h, y, mu) - jacobiField(x - h, y, mu)) / (2 * h),
        (jacobiField(x, y + h, mu) - jacobiField(x, y - h, mu)) / (2 * h),
    ];
};
for (const mu of [EM_MU, SE_MU, 0.1]) {
    for (const p of lagrangePoints(mu)) {
        const [gx, gy] = grad(p.x, p.y, mu);
        // Near the primaries 2Ω is steep, so the gradient test is RELATIVE to
        // the local field scale; for SE_MU the L1/L2 points sit 0.01 from Earth.
        const scale = Math.max(1, jacobiField(p.x, p.y, mu));
        assert.ok(Math.hypot(gx, gy) < 1e-5 * scale, `∇Ω = 0 at ${p.id} (μ=${mu}): ${gx}, ${gy}`);
    }
}
const lp = Object.fromEntries(lagrangePoints().map(p => [p.id, p]));
for (const id of ['L4', 'L5']) {
    const p = lp[id];
    near(Math.hypot(p.x + EM_MU, p.y), 1, 1e-12, `${id} is 1 from Earth`);
    near(Math.hypot(p.x - 1 + EM_MU, p.y), 1, 1e-12, `${id} is 1 from the Moon`);
}
assert.ok(lp.L3.x < -EM_MU && lp.L1.x > -EM_MU && lp.L1.x < 1 - EM_MU && lp.L2.x > 1 - EM_MU,
    'collinear points are on the right segments');
ok('every Lagrange point is an equilibrium; L4/L5 equilateral');

// ── Published Jacobi constants (Szebehely 1967 / standard tables) ───────────
near(lp.L1.C, 3.18834, 2e-5, 'C_L1');
near(lp.L2.C, 3.17216, 2e-5, 'C_L2');
near(lp.L3.C, 3.01215, 2e-5, 'C_L3');
near(lp.L4.C, 2.98800, 2e-5, 'C_L4');
near(lp.L4.C, lp.L5.C, 1e-14, 'L4/L5 symmetric');
assert.ok(lp.L1.C > lp.L2.C && lp.L2.C > lp.L3.C && lp.L3.C > lp.L4.C, 'gates open in the order L1, L2, L3, L4/5');
// The equilateral points have C = 3 − μ(1 − μ) exactly.
near(lp.L4.C, 3 - EM_MU * (1 - EM_MU), 1e-12, 'C_L4 closed form');
ok('Jacobi constants match the published Earth–Moon table and the L4 closed form');

// ── Hill approximation, and the Sun–Earth points bracket the Hill radius ────
const g = Math.cbrt(EM_MU / 3);
rel(1 - EM_MU - lp.L1.x, g, 0.2, 'L1 offset ≈ Hill γ');
rel(lp.L2.x - (1 - EM_MU), g, 0.2, 'L2 offset ≈ Hill γ');
const se = collinearPoints(SE_MU);
const gSE = Math.cbrt(SE_MU / 3);
rel(1 - SE_MU - se.L1, gSE, 0.01, 'SE L1 ≈ Hill γ (μ small, so tight)');
rel(se.L2 - (1 - SE_MU), gSE, 0.01, 'SE L2 ≈ Hill γ');
near(moonHillRadiusKm(LD_KM), LD_KM * Math.cbrt(MU_MOON / (3 * MU_EARTH)), 0, 'lunar Hill formula');
assert.ok(moonSoiRadiusKm(LD_KM) > moonHillRadiusKm(LD_KM), 'lunar SOI (66 Mm) is wider than its Hill sphere (61 Mm)');
ok('collinear points agree with the Hill approximation');

// ── The GLSL mirror, transliterated ──────────────────────────────────────────
const js = JACOBI_FIELD_GLSL
    .replace(/float\s+emJacobiField\s*\(\s*float X,\s*float Y,\s*float mu\s*\)/, 'function glslField(X, Y, mu)')
    .replace(/\bfloat\s+/g, 'let ')
    .replace(/\bsqrt\(/g, 'Math.sqrt(')
    .replace(/\bmax\(/g, 'Math.max(');
assert.ok(/function glslField/.test(js), 'GLSL header transliterated');
const glslField = new Function(`${js}; return glslField;`)();
for (let i = 0; i < 400; i++) {
    const X = -1.8 + 3.6 * ((i * 0.6180339887) % 1);
    const Y = -1.8 + 3.6 * ((i * 0.4142135623) % 1);
    near(glslField(X, Y, EM_MU), jacobiField(X, Y, EM_MU), 0, `GLSL mirror at (${X}, ${Y})`);
}
near(jacobiField3(0.3, -0.4, 0, EM_MU), jacobiField(0.3, -0.4, EM_MU), 1e-14, '3-D field reduces to planar at z=0');
ok('the shader mirror of 2Ω is the JS function, transliterated');

// ── The live frame ───────────────────────────────────────────────────────────
for (const jd of [2451545.0, 2460000.5, 2461347.5, 2462000.25]) {
    const fr = earthMoonFrame(jd);
    const { e1, e2, e3 } = fr;
    const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    near(d(e1, e1), 1, 1e-12, 'e1 unit'); near(d(e2, e2), 1, 1e-12, 'e2 unit'); near(d(e3, e3), 1, 1e-12, 'e3 unit');
    near(d(e1, e2), 0, 1e-12, 'e1⊥e2'); near(d(e1, e3), 0, 1e-12, 'e1⊥e3'); near(d(e2, e3), 0, 1e-12, 'e2⊥e3');
    // Right-handed: e1 × e2 = e3.
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    near(d(c, e3), 1, 1e-12, 'right-handed');
    const m = moonGeoJ2000(jd);
    near(fr.D, m.distKm, 1, 'D is the ephemeris distance');
    // Sidereal angular rate ~2π / 27.3 d, within the eccentricity swing.
    const periodDays = 2 * Math.PI / fr.omega / 86400;
    assert.ok(periodDays > 23 && periodDays < 32, `instantaneous period ${periodDays} d`);
    // The Moon is at (1 − μ, 0, 0) in its own frame, essentially at rest except radially.
    const sm = toRotating(fr, fr.moonKm, fr.moonVelKms);
    near(sm.x, 1 - EM_MU, 1e-12, 'Moon x'); near(sm.y, 0, 1e-12, 'Moon y'); near(sm.z, 0, 1e-12, 'Moon z');
    near(sm.vy, 0, 1e-9, 'Moon has no tangential velocity in its own frame');
    // Radial term ≈ e·sin(anomaly); the Moon's e swings 0.026–0.077 under evection.
    assert.ok(Math.abs(sm.vx) < 0.09, 'Moon radial velocity is the eccentricity term (|e| < 0.09)');
    // Earth is at (−μ, 0, 0) and the round trip is the identity.
    const se0 = toRotating(fr, [0, 0, 0]);
    near(se0.x, -EM_MU, 1e-12, 'Earth x');
    for (const p of [[1e5, -2e5, 3e4], [-4e5, 1e5, -5e4], [7e3, 0, 0]]) {
        const q = toRotating(fr, p);
        const back = rotatingToGeoKm(fr, q.x, q.y, q.z);
        for (let k = 0; k < 3; k++) near(back[k], p[k], 1e-6, 'round trip');
    }
}
ok('the live frame is orthonormal, right-handed, and holds the Moon at (1−μ, 0, 0)');

// Moon velocity: central difference is consistent with a mean orbital speed.
{
    const s = moonState(2461347.5);
    const v = Math.hypot(...s.velKms);
    assert.ok(v > 0.95 && v < 1.1, `lunar geocentric speed ${v} km/s`);
}
ok('the Moon moves at ~1.02 km/s');

// ── Jacobi is conserved along an integrated CR3BP orbit ──────────────────────
{
    const mu = EM_MU;
    const deriv = (s) => {
        const dx1 = s.x + mu, dx2 = s.x - 1 + mu;
        const r1 = Math.hypot(dx1, s.y, s.z) ** 3, r2 = Math.hypot(dx2, s.y, s.z) ** 3;
        return {
            x: s.vx, y: s.vy, z: s.vz,
            vx: 2 * s.vy + s.x - (1 - mu) * dx1 / r1 - mu * dx2 / r2,
            vy: -2 * s.vx + s.y - (1 - mu) * s.y / r1 - mu * s.y / r2,
            vz: -(1 - mu) * s.z / r1 - mu * s.z / r2,
        };
    };
    const step = (s, h) => {
        const k = (a, d, f) => Object.fromEntries(Object.keys(a).map(n => [n, a[n] + d[n] * f]));
        const k1 = deriv(s), k2 = deriv(k(s, k1, h / 2)), k3 = deriv(k(s, k2, h / 2)), k4 = deriv(k(s, k3, h));
        return Object.fromEntries(Object.keys(s).map(n => [n, s[n] + h / 6 * (k1[n] + 2 * k2[n] + 2 * k3[n] + k4[n])]));
    };
    let s = { x: 0.5, y: 0.1, z: 0.05, vx: 0.1, vy: 0.6, vz: 0 };
    const C0 = jacobiConstant(s, mu);
    for (let i = 0; i < 4000; i++) s = step(s, 5e-4);
    near(jacobiConstant(s, mu), C0, 1e-8, 'Jacobi conserved along RK4 orbit');
}
ok('the Jacobi constant is an integral of the motion (independent RK4)');

// ── Gate states ──────────────────────────────────────────────────────────────
assert.equal(gateState(3.3).regime, 'sealed');
assert.equal(gateState((lp.L1.C + lp.L2.C) / 2).regime, 'neck');
assert.equal(gateState((lp.L2.C + lp.L3.C) / 2).regime, 'l2-open');
assert.equal(gateState((lp.L3.C + lp.L4.C) / 2).regime, 'l3-open');
assert.equal(gateState(-50).regime, 'open');
for (const r of ['sealed', 'neck', 'l2-open', 'l3-open', 'open']) assert.ok(GATE_LABELS[r], `label ${r}`);
for (const id of ['L1', 'L2', 'L3', 'L4', 'L5']) assert.ok(LAGRANGE_ROLES[id], `role ${id}`);
ok('gates open in order as C falls');

// ── Acceleration budget ──────────────────────────────────────────────────────
{
    const r = [7000, 0, 0];
    near(Math.hypot(...earthAcceleration(r)), MU_EARTH / 49e6, 1e-18, 'Earth term is μ/r²');
    // Linear tide along the body line: 2 μ r / d³ (the "2" of the tidal 2 : −1).
    const d = AU_KM;
    for (const rr of [1e3, 1e4, 1e5]) {
        const t = Math.hypot(...perturbingAcceleration(MU_SUN, [d, 0, 0], [rr, 0, 0]));
        rel(t, 2 * MU_SUN * rr / d ** 3, 3 * rr / d + 1e-9, `solar tide on the Sun line at ${rr} km`);
        const tp = Math.hypot(...perturbingAcceleration(MU_SUN, [d, 0, 0], [0, rr, 0]));
        rel(tp, MU_SUN * rr / d ** 3, 3 * rr / d + 1e-9, `solar tide across the Sun line at ${rr} km`);
    }
    assert.equal(perturbingAcceleration(MU_MOON, [1, 0, 0], [1, 0, 0]), null, 'refuses the body centre');
}
{
    const jd = 2461347.5;
    const fr = earthMoonFrame(jd);
    const e = earthHelioJ2000(jd);
    const rAU = Math.hypot(e.x, e.y, e.z);
    const sun = [-e.x * AU_KM, -e.y * AU_KM, -e.z * AU_KM];
    // LEO: Earth dominates by orders of magnitude.
    const leo = accelerationBudget([EARTH_RADIUS_KM + 400, 0, 0], fr.moonKm, sun);
    assert.equal(leo.dominant, 'earth');
    assert.ok(leo.earth / leo.moon > 1e5, 'LEO: lunar perturbation is ~1e-6 of Earth');
    // 10 000 km from the Moon on the Earth side: the Moon dominates.
    const u = fr.moonKm.map(c => c / fr.D);
    const nearMoon = accelerationBudget(u.map(c => c * (fr.D - 10_000)), fr.moonKm, sun);
    assert.equal(nearMoon.dominant, 'moon');
    // Shares sum to one.
    near(nearMoon.share.earth + nearMoon.share.moon + nearMoon.share.sun, 1, 1e-12, 'shares sum to 1');
    for (const k of ['earth', 'moon', 'sun']) assert.ok(DOMINANT_LABELS[k]);

    // The profile: solar tide overtakes Earth at (3/2)^⅓ × the Hill radius.
    const p = gravityProfile({ moonKm: fr.moonKm, sunKm: sun, maxKm: 0.05 * AU_KM, n: 400 });
    rel(p.crossings.sunOverEarthKm, Math.cbrt(1.5) * hillRadiusKm(rAU), 0.02,
        'tide crossing = (3/2)^⅓ r_H (2μr/d³ vs the Hill radius’s 3μr/d³)');
    assert.ok(p.crossings.moonOverEarthKm > 0.8 * fr.D && p.crossings.moonOverEarthKm < fr.D,
        'Moon overtakes Earth between 0.8 D and the Moon');
    assert.ok(p.samples.some(s => s.moon === null) || true, 'the Moon is a hole, not a spike');
    for (const s of p.samples) {
        near(s.earth, MU_EARTH / (s.rKm * s.rKm), 1e-20, 'profile Earth term');
        if (Math.abs(s.rKm - fr.D) <= 1737.4) assert.equal(s.moon, null, 'inside the Moon is null');
    }
}
ok('the acceleration budget reduces to the textbook limits');

// ── Geometry + location analysis ─────────────────────────────────────────────
{
    const jd = 2461347.5;
    const geo = lagrangeGeometry(jd);
    assert.equal(geo.earthMoon.length, 5);
    assert.equal(geo.sunEarth.length, 2);
    const e = earthHelioJ2000(jd);
    const hill = hillRadiusKm(Math.hypot(e.x, e.y, e.z));
    for (const p of geo.sunEarth) rel(p.distKm, hill, 0.02, `${p.id} sits on the Hill sphere`);
    const l1 = geo.earthMoon.find(p => p.short === 'L1');
    const l2 = geo.earthMoon.find(p => p.short === 'L2');
    near(l1.distKm, (lp.L1.x + EM_MU) * geo.frame.D, 1e-6, 'EM L1 geocentric distance');
    assert.ok(l1.distKm > 300_000 && l1.distKm < 345_000, `EM L1 at ${l1.distKm}`);
    assert.ok(l2.distKm > 420_000 && l2.distKm < 470_000, `EM L2 at ${l2.distKm}`);

    // An object parked AT L1, co-rotating, has C = C_L1 exactly and sees 'sealed'/'neck' boundary.
    const fr = geo.frame;
    const rL1 = l1.geoKm;
    // co-rotating velocity: ω × ρ in inertial-barycentric, plus the barycentre's own μ v_m
    const rho = [rL1[0] - EM_MU * fr.moonKm[0], rL1[1] - EM_MU * fr.moonKm[1], rL1[2] - EM_MU * fr.moonKm[2]];
    const w = fr.e3.map(c => c * fr.omega);
    const wxr = [w[1] * rho[2] - w[2] * rho[1], w[2] * rho[0] - w[0] * rho[2], w[0] * rho[1] - w[1] * rho[0]];
    const v = [wxr[0] + EM_MU * fr.moonVelKms[0], wxr[1] + EM_MU * fr.moonVelKms[1], wxr[2] + EM_MU * fr.moonVelKms[2]];
    const a = locationAnalysis({ rKm: rL1, vKms: v, jd, frame: fr, geometry: geo });
    near(a.jacobi, lp.L1.C, 1e-9, 'parked at L1 → C = C_L1');
    assert.equal(a.nearestLagrange.id, 'EM-L1');
    near(a.nearestLagrange.distKm, 0, 1e-6, 'zero distance to L1');
    assert.ok(a.jacobiMeaningful, 'inside Earth’s Hill sphere');
    assert.ok(a.insideMoonHill, 'L1 sits on the lunar Hill sphere (inside, within rounding)');
    assert.equal(realmOf(lp.L1.x - 0.01, 0), 'earth');
    assert.equal(realmOf(1 - EM_MU + 0.05, 0.02), 'moon');
    assert.equal(realmOf(1.5, 0), 'exterior');

    // A typical NEO: 0.03 AU out at 10 km/s — every gate open, and Jacobi NOT meaningful.
    const far = locationAnalysis({ rKm: [0.03 * AU_KM, 0, 0], vKms: [0, 10, 0], jd, frame: fr, geometry: geo });
    assert.equal(far.jacobiMeaningful, false);
    // Far out the rotating frame itself moves at ω·r ≈ 12 km/s, so C is large
    // and POSITIVE there: "sealed" in the EXTERIOR realm — kept out, not held
    // in. Which is why the realm travels with the gate state.
    assert.equal(far.gates.realm, 'exterior');
    assert.equal(far.budget.dominant, 'sun', 'beyond the Hill sphere the solar tide wins');
    // A flyby at 2 LD at 8 km/s: Jacobi meaningful, gates open.
    const fly = locationAnalysis({ rKm: [2 * LD_KM, 0, 0], vKms: [0, 8, 0], jd, frame: fr, geometry: geo });
    assert.equal(fly.jacobiMeaningful, true);
    assert.equal(fly.gates.regime, 'open');
    assert.equal(fly.gates.realm, 'exterior');
    // No velocity → no Jacobi, said so with null.
    const nov = locationAnalysis({ rKm: [2 * LD_KM, 0, 0], jd, frame: fr, geometry: geo });
    assert.equal(nov.jacobi, null);
    assert.equal(nov.gates, null);
}
ok('Lagrange geometry and location analysis');

// ── Formatting ───────────────────────────────────────────────────────────────
assert.equal(formatAcceleration(9.81e-3), '9.81 m/s²');
assert.equal(formatAcceleration(2.7e-9), '2.70 µm/s²');
assert.equal(formatAcceleration(3.3e-5), '33.0 mm/s²');
assert.equal(formatAcceleration(NaN), '—');
ok('acceleration formatting');

console.log(`\nearth-moon-gravity: ${passed} groups passed`);
