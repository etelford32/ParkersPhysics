/**
 * upper-atmosphere-ops-bands.mjs — the operational altitude bands
 * ═══════════════════════════════════════════════════════════════════════════
 * js/upper-atmosphere-ops-bands.js: the one copy of the bands a mission
 * planner thinks in (entry interface → top of LEO) and the numbers printed
 * beside them. Pins:
 *   • the table tiles 80–2000 km with no gaps, no overlaps, ascending, with
 *     each band's reference altitude inside it, labels short enough for a
 *     limb ruler segment, colours distinct from the PHYSICS layers' palette;
 *   • `bandForAltitude` is half-open and null outside the band;
 *   • the orbital closed forms (ISS: 7.67 km/s, 92.6 min);
 *   • King–Hele against a hand integration of da/dt = −√(μa)·ρ(a)/B in an
 *     exponential atmosphere (the formula IS that integral), and linear in B;
 *   • the metrics come from the ENGINE's density (the one-model rule): a
 *     storm (Ap 300) shortens every band's lifetime, and the ladder is
 *     monotone — higher band, longer life;
 *   • the lifetime label is the word an operator uses for the number.
 *
 * Run: node tests/upper-atmosphere-ops-bands.mjs
 */
import assert from 'node:assert/strict';
import * as K from '../js/upper-atmosphere-ops-bands.js';
import { density } from '../js/upper-atmosphere-engine.js';
import { ATMOSPHERIC_LAYER_SCHEMA } from '../js/upper-atmosphere-layers.js';
import { gaugeFraction } from '../js/upper-atmosphere-explore-model.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const rel = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${msg}: ${a} vs ${b}`);

console.log('upper-atmosphere-ops-bands');

ok('the bands tile 80–2000 km: contiguous, ascending, reference inside, short labels', () => {
    assert.equal(K.OPS_FLOOR_KM, 80);
    assert.equal(K.OPS_CEIL_KM, 2000);
    let prev = null;
    const ids = new Set();
    for (const b of K.OPS_BANDS) {
        assert.ok(b.maxKm > b.minKm, `${b.id} is a band`);
        if (prev) assert.equal(b.minKm, prev.maxKm, `${prev.id} → ${b.id} contiguous`);
        assert.ok(b.refKm >= b.minKm && b.refKm < b.maxKm, `${b.id} refKm inside`);
        assert.ok(b.short.length <= 9, `${b.id} short label fits a ruler segment`);
        assert.ok(b.ops.length > 40 && b.examples.length >= 1, `${b.id} says what it is`);
        assert.ok(!ids.has(b.id)); ids.add(b.id);
        prev = b;
    }
    assert.deepEqual(K.OPS_EDGES_KM, [80, 120, 200, 350, 450, 600, 850, 1200, 2000]);
    assert.ok(Object.isFrozen(K.OPS_BANDS) && Object.isFrozen(K.OPS_BANDS[0]));
});

ok('the ops palette is distinct from the physics layers\' palette', () => {
    const phys = new Set(ATMOSPHERIC_LAYER_SCHEMA.flatMap(L => [L.colorLow, L.colorHigh]));
    const seen = new Set();
    for (const b of K.OPS_BANDS) {
        assert.ok(!phys.has(b.colorHex), `${b.id} must not reuse a physics layer colour`);
        assert.ok(!seen.has(b.colorHex), `${b.id} colour unique`); seen.add(b.colorHex);
    }
    assert.equal(K.hexCss(0x5fd8ff), '#5fd8ff');
    assert.equal(K.hexCss(0x000a0b), '#000a0b');
});

ok('bandForAltitude is half-open, pins the ceiling, null outside', () => {
    assert.equal(K.bandForAltitude(79.9), null);
    assert.equal(K.bandForAltitude(80).id, 'entry');
    assert.equal(K.bandForAltitude(119.99).id, 'entry');
    assert.equal(K.bandForAltitude(120).id, 'decay');
    assert.equal(K.bandForAltitude(420).id, 'station');
    assert.equal(K.bandForAltitude(550).id, 'constellation');
    assert.equal(K.bandForAltitude(705).id, 'sso');
    assert.equal(K.bandForAltitude(1999.9).id, 'leo-top');
    assert.equal(K.bandForAltitude(2000).id, 'leo-top');
    assert.equal(K.bandForAltitude(2000.1), null);
    assert.equal(K.bandForAltitude(NaN), null);
});

ok('orbital closed forms: the ISS', () => {
    near(K.circularSpeedKmS(420), 7.66, 0.01, 'v_circ at 420 km');
    near(K.circularPeriodS(420) / 60, 92.9, 0.3, 'period at 420 km');
    near(K.circularSpeedKmS(0), 7.91, 0.01, 'surface');
});

ok('King–Hele lifetime IS the integral of the decay rate in an exponential atmosphere, linear in B', () => {
    // Hand-integrate da/dt = −√(μ a) ρ(a) / B from a0 down to a0 − 12 H with
    // ρ(a) = ρ0·exp(−(a − a0)/H), where the remaining tail is e^−12 of the total.
    const altKm = 400, H = 60, rho0 = 3e-12, B = 50;
    const mu = K.MU_KM3_S2 * 1e9, a0 = (K.R_EARTH_KM + altKm) * 1000, Hm = H * 1000;
    let t = 0, a = a0;
    const da = 2; // metres
    while (a > a0 - 12 * Hm) {
        const rho = rho0 * Math.exp(-(a - a0) / Hm);
        const rate = Math.sqrt(mu * a) * rho / B;
        t += da / rate; a -= da;
    }
    const L = K.lifetimeKingHeleS({ rhoKgM3: rho0, scaleHeightKm: H, altKm, ballisticKgM2: B });
    rel(L, t, 0.01, 'closed form vs integral');
    rel(K.lifetimeKingHeleS({ rhoKgM3: rho0, scaleHeightKm: H, altKm, ballisticKgM2: 2 * B }), 2 * L, 1e-12, 'linear in B');
    assert.equal(K.lifetimeKingHeleS({ rhoKgM3: 0, scaleHeightKm: H, altKm }), Infinity);
    // Drag deceleration = ρ v² / 2B and height lost per orbit = 2π ρ a² / B.
    const v = K.circularSpeedKmS(altKm) * 1000;
    near(K.dragDecelMS2({ rhoKgM3: rho0, altKm, ballisticKgM2: B }), rho0 * v * v / (2 * B), 1e-15, 'decel');
});

ok('bandMetrics reads the ENGINE (one density model) and the ladder is monotone', () => {
    const quiet = K.opsLadder({ f107Sfu: 150, ap: 15 });
    assert.equal(quiet.length, K.OPS_BANDS.length);
    for (const { band, metrics } of quiet) {
        const s = density({ altitudeKm: band.refKm, f107Sfu: 150, ap: 15 });
        assert.equal(metrics.rhoKgM3, s.rho, `${band.id} ρ is the engine's`);
        assert.equal(metrics.scaleHeightKm, s.H_km, `${band.id} H is the engine's`);
        assert.equal(metrics.ballisticKgM2, K.REF_BALLISTIC_KG_M2);
        assert.ok(metrics.decayPerOrbitM > 0 && Number.isFinite(metrics.lifetimeS), band.id);
    }
    for (let i = 1; i < quiet.length; i++) {
        assert.ok(quiet[i].metrics.lifetimeS > quiet[i - 1].metrics.lifetimeS,
            `${quiet[i].band.id} outlives ${quiet[i - 1].band.id}`);
        assert.ok(quiet[i].metrics.vKmS < quiet[i - 1].metrics.vKmS, 'slower higher');
    }
    // A great storm inflates the thermosphere and shortens every lifetime
    // ABOVE the homopause. Below 120 km the engine's density does not depend
    // on T∞ at all (mixing clamps it — the limb probe's own disclosure), so
    // the entry band, whose reference altitude is 100 km, must come out
    // EQUAL: a band that changed there would mean a second density model.
    // Just above it (the decay zone, 160 km) the engine's density PIVOTS:
    // ρ barely moves (×1.04 at Ap 300) while the local scale height grows
    // ×1.6, so King–Hele's H/ρ LENGTHENS — the estimate integrates the
    // modelled profile below the orbit, which the hot storm thins. Pinned
    // as measured so nobody "fixes" it by hand; from VLEO up ρ wins.
    const storm = K.opsLadder({ f107Sfu: 150, ap: 300 });
    for (let i = 0; i < quiet.length; i++) {
        const q = quiet[i].metrics, s = storm[i].metrics;
        if (quiet[i].band.refKm < 120) {
            assert.equal(s.lifetimeS, q.lifetimeS, `${quiet[i].band.id}: T∞-independent below 120 km`);
        } else {
            assert.ok(s.rhoKgM3 > q.rhoKgM3, `${quiet[i].band.id}: storm density up`);
            if (quiet[i].band.refKm >= 200) assert.ok(s.lifetimeS < q.lifetimeS, `${quiet[i].band.id} storm shortens`);
        }
    }
    rel(storm[1].metrics.rhoKgM3 / quiet[1].metrics.rhoKgM3, 1.04, 0.05, 'decay-zone density pivot');
    // Order of magnitude: the station band is months, the decay zone is hours.
    assert.equal(quiet.find(r => r.band.id === 'decay').metrics.lifetime.cls, 'hours');
    assert.ok(['months', 'years'].includes(quiet.find(r => r.band.id === 'station').metrics.lifetime.cls));
    assert.equal(quiet.find(r => r.band.id === 'upper-leo').metrics.lifetime.cls, 'centuries');
    // Evaluate elsewhere inside the band on request.
    const at400 = K.bandMetrics(K.bandForAltitude(400), { f107Sfu: 150, ap: 15, altKm: 400 });
    assert.equal(at400.altKm, 400);
    near(at400.vKmS, 7.67, 0.01, 'v at 400');
});

ok('lifetimeLabel speaks the operator\'s units', () => {
    assert.deepEqual(K.lifetimeLabel(600), { text: '10 min', cls: 'hours' });
    assert.deepEqual(K.lifetimeLabel(5 * 3600), { text: '5.0 h', cls: 'hours' });
    assert.deepEqual(K.lifetimeLabel(30 * 86400), { text: '30 d', cls: 'days' });
    assert.deepEqual(K.lifetimeLabel(200 * 86400), { text: '7 mo', cls: 'months' });
    assert.deepEqual(K.lifetimeLabel(5.5 * 365.25 * 86400), { text: '5.5 yr', cls: 'years' });
    assert.deepEqual(K.lifetimeLabel(840 * 365.25 * 86400), { text: '800 yr', cls: 'centuries' });
    assert.deepEqual(K.lifetimeLabel(1e12), { text: '> 10 000 yr', cls: 'centuries' });
    assert.deepEqual(K.lifetimeLabel(Infinity), { text: 'no decay', cls: 'none' });
});

ok('the ladder fraction is the explore column\'s own log mapping', () => {
    for (const z of [80, 100, 250, 420, 1000, 2000]) near(K.ladderFraction(z), gaugeFraction(z), 1e-12, `at ${z}`);
    assert.equal(K.ladderFraction(10), 0);
    assert.equal(K.ladderFraction(5000), 1);
});

ok('rayClosestApproach: b and range from the camera', () => {
    const r = K.rayClosestApproach([0, 0, 4], [0, 0, -1]);
    near(r.b, 0, 1e-12, 'straight at the centre'); near(r.tc, 4, 1e-12, 'range'); near(r.dist, 4, 1e-12, 'dist');
    const r2 = K.rayClosestApproach([0, 0, 4], [0.3, 0, -1]);
    near(r2.b, 4 * 0.3 / Math.hypot(0.3, 1), 1e-12, 'off-axis b');
    assert.ok(K.rayClosestApproach([0, 0, 4], [0, 0, 1]).tc < 0, 'pointing away');
});

ok('pickOpsBand: edges within tolerance first, then the wash, nothing on the disc or from inside', () => {
    const R = K.R_EARTH_KM;
    const rStation = 1 + 350 / R, rSso = 1 + 600 / R;
    const dist = 4;
    // On the station band's lower edge ring (350 km), within tolerance.
    let p = K.pickOpsBand({ b: rStation + 0.0004, dist, tolR: 0.001 });
    assert.equal(p.part, 'edge'); assert.equal(p.band.id, 'station'); assert.equal(p.edgeKm, 350);
    // The same radius is also the VLEO band's upper edge: it belongs to the band ABOVE.
    assert.notEqual(p.band.id, 'vleo');
    // Between edges, outside tolerance: the wash of the band the ray is in.
    p = K.pickOpsBand({ b: (rStation + 1 + 450 / R) / 2, dist, tolR: 0.0005 });
    assert.equal(p.part, 'fill'); assert.equal(p.band.id, 'station');
    // The model ceiling belongs to the top band.
    p = K.pickOpsBand({ b: 1 + 2000 / R - 0.0001, dist, tolR: 0.001 });
    assert.equal(p.part, 'edge'); assert.equal(p.band.id, 'leo-top'); assert.equal(p.edgeKm, 2000);
    // The nearest edge wins when two are within tolerance.
    p = K.pickOpsBand({ b: rSso - 0.0002, dist, tolR: 0.01 });
    assert.equal(p.edgeKm, 600);
    // Rays into the disc and above the band pick nothing.
    assert.equal(K.pickOpsBand({ b: 0.9, dist, tolR: 0.01 }), null);
    assert.equal(K.pickOpsBand({ b: 1.5, dist, tolR: 0.01 }), null);
    // From inside a band there is no ring for its edges above the camera and no wash.
    const inside = 1 + 400 / R;
    assert.equal(K.pickOpsBand({ b: inside - 0.001, dist: inside, tolR: 0.0005 }), null);
});

ok('shellChord: the chord through a shell, occluded by the planet, longest at the lower tangent', () => {
    const lo = 1.05, hi = 1.10;
    // Clearing the planet: twice (outer − inner).
    near(K.shellChord(1.0, lo, hi), 2 * (Math.sqrt(hi * hi - 1) - Math.sqrt(lo * lo - 1)), 1e-12, 'b = 1');
    // Tangent to the lower edge: no inner part, the maximum.
    near(K.shellChord(lo, lo, hi), 2 * Math.sqrt(hi * hi - lo * lo), 1e-12, 'tangent');
    near(K.shellChordMax(lo, hi), K.shellChord(lo, lo, hi), 1e-12, 'max is the lower tangent');
    for (const b of [1.0, 1.02, 1.05, 1.07, 1.09]) assert.ok(K.shellChord(b, lo, hi) <= K.shellChordMax(lo, hi) + 1e-12, `b=${b} ≤ max`);
    // Hitting the planet: the near side only — half of the two-sided chord
    // when the ray never reaches the shell's inner edge before the ground.
    near(K.shellChord(0.5, lo, hi), Math.sqrt(hi * hi - 0.25) - Math.sqrt(lo * lo - 0.25), 1e-12, 'near side');
    // A ray grazing the planet inside the shell (lo ≤ b < 1): ends on the ground.
    const lo2 = 0.99;
    near(K.shellChord(0.995, lo2, hi), Math.sqrt(hi * hi - 0.995 ** 2) - Math.sqrt(1 - 0.995 ** 2), 1e-12, 'ends on ground');
    // Outside the shell: nothing. Degenerate shell: nothing.
    assert.equal(K.shellChord(1.2, lo, hi), 0);
    assert.equal(K.shellChord(1.0, hi, lo), 0);
    assert.equal(K.shellChordMax(hi, lo), 0);
    // Continuous across b = 1 (the planet's limb): the two formulas agree there.
    near(K.shellChord(1 - 1e-9, lo, hi), K.shellChord(1, lo, hi) / 2, 1e-6, 'limb continuity (near side = half)');
});

console.log(`\n${passed} passed`);
