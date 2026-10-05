#!/usr/bin/env node
/**
 * spaceship-designer.mjs — gate for the Space Ship Designer's pure kernels:
 * engine geometry, cluster packing, the stack layout, design normalisation
 * (js/spaceship-designer-engine.js) and flight playback
 * (js/spaceship-designer-flight.js).
 *
 * Run: node tests/spaceship-designer.mjs
 *
 * The load-bearing pins:
 *   • ENGINES ARE REAL SIZE. Published exit diameters are used where they
 *     exist, and the de Laval derivation agrees with them to within the c*
 *     efficiency gap (it is the fallback for engines with no figure).
 *   • PACKING IS PHYSICAL. No two exits overlap (checked by an independent
 *     pairwise oracle), a cluster that "fits" stays inside its skin, and the
 *     real layouts fall out: Falcon 9's 1+8, Super Heavy's three rings, and
 *     five F-1s that do NOT fit a 10.1 m core without Saturn V's fairings.
 *   • ONE GEOMETRY. computeStats measures the same stack the 3D view draws:
 *     interstages house the upper engines and count toward the body length,
 *     an overhanging cluster widens the reference diameter.
 *   • THE ENGINE DECIDES THE PROPELLANT, and the legacy spec-id engineId
 *     ('raptor_2_vac') that used to fly a Merlin resolves to Raptor Vacuum.
 *   • FLIGHT POSES ARE TRUE GEOMETRY on a true-radius planet.
 */

import assert from 'node:assert/strict';
import * as E from '../js/spaceship-designer-engine.js';
import * as F from '../js/spaceship-designer-flight.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed += 1; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── Engine geometry ──────────────────────────────────────────────────────────
console.log('engine geometry');
{
    const g = (k) => E.engineGeometry(E.ENGINE_CATALOG[k]);
    near(2 * g('merlin_1d').exitR_m, 0.92, 1e-9, 'Merlin 1D exit (published)');
    near(2 * g('rs_25').exitR_m, 2.30, 1e-9, 'RS-25 exit (published)');
    near(2 * g('merlin_vac').exitR_m, 3.30, 1e-9, 'MVac exit (published)');
    // RS-25's real nozzle is 3.07 m long; the 80 % Rao bell must land close.
    near(g('rs_25').bellLen_m, 3.07, 0.3, 'RS-25 bell length (Rao 80 %)');
    for (const e of Object.values(E.ENGINE_CATALOG)) {
        const x = E.engineGeometry(e);
        assert.ok(x.exitR_m > 0 && x.bellLen_m > 0 && Number.isFinite(x.totalLen_m), `${e.key} geometry finite`);
        if (x.kind === 'ion') continue;
        near(x.throatR_m, x.exitR_m / Math.sqrt(x.eps), 1e-9, `${e.key} throat = exit/√ε`);
        // Ideal c* over-predicts the throat by the c* efficiency (and the
        // published figure is the real one): the two must still agree to 20 %.
        if (x.source === 'published') {
            const r = x.derivedExitR_m / x.exitR_m;
            assert.ok(r > 0.8 && r < 1.2, `${e.key} derived/published exit ratio ${r.toFixed(3)}`);
        }
    }
    ok('published exits, Rao bell length, derived ≈ published within the c* gap');
}

// ── Catalog: every propellant has an engine; propellant follows the engine ──
console.log('catalog');
{
    for (const p of Object.values(E.PROPELLANTS)) {
        assert.ok(Object.values(E.ENGINE_CATALOG).some((e) => e.propellant === p.id), `${p.id} has an engine`);
    }
    for (const [key, e] of Object.entries(E.ENGINE_CATALOG)) assert.equal(e.key, key, `${key} carries its own key`);
    assert.equal(E.engineFor('raptor_2_vac').key, 'raptor_vac', 'legacy spec id resolves to Raptor Vacuum, not a Merlin');
    assert.equal(E.engineFor('nonsense').key, 'merlin_1d', 'unknown engine falls back to the default');

    const legacy = E.defaultDesign();
    legacy.stages[1].engineId = 'raptor_2_vac';
    legacy.stages[0].propellantId = 'ion';                   // a Merlin "burning xenon"
    const n = E.normalizeDesign(legacy);
    assert.equal(n.stages[1].engineId, 'raptor_vac');
    assert.equal(n.stages[1].propellantId, 'methalox');
    assert.equal(n.stages[0].propellantId, 'kerolox');
    // computeStats reads the propellant from the engine, so the mismatched
    // blob and its normalised form fly identically.
    near(E.computeStats(legacy).propMass_kg, E.computeStats(n).propMass_kg, 1e-6, 'propellant mass ignores a mismatched propellantId');
    ok('every propellant has an engine; legacy ids + mismatched propellants normalise');
}

// ── Cluster packing ──────────────────────────────────────────────────────────
console.log('cluster packing');
{
    const noOverlap = (c, exitR, label) => {
        const P = c.positions;
        for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
            const d = Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z);
            assert.ok(d >= 2 * exitR - 1e-6, `${label}: exits ${i},${j} overlap (${d.toFixed(3)} < ${(2 * exitR).toFixed(3)})`);
        }
    };
    const f9 = E.clusterLayout(9, 0.46, 1.85);
    assert.equal(f9.pattern, '1+8', 'Falcon 9 octaweb');
    assert.ok(f9.fits, 'nine Merlins fit the 3.7 m core');
    noOverlap(f9, 0.46, 'F9');

    const sh = E.clusterLayout(33, 0.65, 4.5);
    assert.equal(sh.rings.length, 3, 'Super Heavy packs in three rings');
    assert.ok(sh.overhang_m < 0.1, `Super Heavy within 10 cm of its skin (${sh.overhang_m.toFixed(3)})`);
    noOverlap(sh, 0.65, 'SH');

    const sv = E.clusterLayout(5, 1.88, 5.05);
    assert.ok(!sv.fits && sv.overhang_m > 0, 'five F-1s overhang a 10.1 m core (Saturn V needed engine fairings)');
    noOverlap(sv, 1.88, 'S-IC');

    // Property sweep with the independent oracle.
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 300; k++) {
        const n = 1 + Math.floor(rnd() * 45), re = 0.2 + rnd() * 2, R = 0.5 + rnd() * 9;
        const c = E.clusterLayout(n, re, R);
        assert.equal(c.positions.length, n, 'every engine placed');
        noOverlap(c, re, `sweep n=${n} re=${re.toFixed(2)} R=${R.toFixed(2)}`);
        const reach = Math.max(...c.positions.map((p) => Math.hypot(p.x, p.z))) + re;
        near(reach, c.clusterR_m, 1e-6, 'clusterR is the outermost exit edge');
        if (c.fits) assert.ok(reach <= R + 1e-6, 'a fitting cluster stays inside its skin');
        else near(c.overhang_m, reach - R, 1e-6, 'overhang is measured, not guessed');
    }
    ok('F9 1+8, Super Heavy 3 rings, S-IC overhang, 300-case no-overlap sweep');
}

// ── Stack layout = the geometry computeStats measures ──────────────────────
console.log('stack layout');
{
    const d = E.defaultDesign();
    const st = E.stackLayout(d);
    const s0 = st.stages[0], s1 = st.stages[1];
    assert.ok(s0.interstage, 'stage 1 carries the interstage');
    assert.ok(s0.interstage.length >= s1.geo.totalLen_m, 'interstage houses the upper engine');
    near(st.bodyLength_m, d.stages[0].length_m + s0.interstage.length + d.stages[1].length_m + d.payload.fairingLen_m, 1e-9, 'body length');
    near(st.engineDrop_m, s0.geo.bellLen_m, 1e-12, 'mount height follows stage 1 bells');
    const stats = E.computeStats(d);
    near(stats.height_m, st.bodyLength_m, 1e-9, 'computeStats height = drawn stack');

    const big = E.defaultDesign();
    big.stages[0] = { ...big.stages[0], diameter_m: 10.1, engineId: 'f1', propellantId: 'kerolox', engineCount: 5 };
    const bs = E.computeStats(big);
    assert.ok(bs.stack.stages[0].aftSkirt, 'overhanging cluster → flared aft skirt');
    assert.ok(bs.maxDiameter_m > 10.1, 'the flare widens the reference diameter');

    // Upper-stage TWR on VACUUM thrust: a vacuum engine's SL rating is 0.
    const mv = E.defaultDesign();
    mv.stages[1] = { ...mv.stages[1], engineId: 'merlin_vac', propellantId: 'kerolox' };
    assert.ok(E.computeStats(mv).stages[1].twr > 0.3, 'MVac upper stage TWR is quoted on vacuum thrust');
    ok('interstage, body length, aft flare, vacuum TWR');
}

// ── Ascent + flight playback ─────────────────────────────────────────────────
console.log('flight');
{
    const d = E.defaultDesign();
    const r = E.runAscent(d);
    assert.equal(r.status, 'orbit', 'default design reaches orbit');
    const T = r.trajectory;
    assert.ok(T.every((p) => Number.isFinite(p.pitch_deg) && Number.isFinite(p.downrange_km)), 'samples carry pitch + downrange');
    near(T[0].pitch_deg, 90, 1e-9, 'vertical at liftoff');
    near(T[0].downrange_km, 0, 1e-6, 'downrange starts at the pad (ground-relative)');
    assert.ok(T[T.length - 1].pitch_deg < 1, 'horizontal by the end of the burn');
    assert.ok(T[T.length - 1].downrange_km > 500, 'flies downrange');

    // Interpolation is exact on a linear field and categorical keys snap.
    const s = F.sampleTrajectory([{ t: 0, a: 0, stage: 1 }, { t: 10, a: 100, stage: 2 }], 2.5);
    near(s.a, 25, 1e-12, 'linear interpolation'); assert.equal(s.stage, 1, 'categorical from the nearer sample');

    // Poses: true geometry over a true-radius planet.
    const R = E.LAUNCH_BODIES.earth.R_km * 1000;
    const p0 = F.poseAt({ alt_km: 0, downrange_km: 0, pitch_deg: 90 }, R, 6);
    near(p0.x, 0, 1e-9, 'pad x'); near(p0.y, 6, 1e-6, 'pad y = mount'); near(p0.rotZ, 0, 1e-12, 'vertical');
    const ph = F.poseAt({ alt_km: 0, downrange_km: 0, pitch_deg: 0 }, R);
    near(ph.axis[0], 1, 1e-12, 'pitch 0 at the pad points downrange (+X)');
    for (const sm of [T[100], T[300], T[T.length - 1]]) {
        const p = F.poseAt(sm, R);
        near(Math.hypot(p.x, p.y + R), R + sm.alt_km * 1000, 1e-3, 'altitude above the curved surface');
        // Pitch is measured from the LOCAL horizontal under the vehicle.
        const east = [p.up[1], -p.up[0]];
        const el = Math.atan2(p.axis[0] * p.up[0] + p.axis[1] * p.up[1], p.axis[0] * east[0] + p.axis[1] * east[1]);
        near(el * 180 / Math.PI, sm.pitch_deg, 1e-6, 'axis pitch vs local horizontal');
    }

    const ev = F.flightEvents(r, d, E.LAUNCH_BODIES.earth);
    const stg = ev.find((e) => e.kind === 'staging'), fair = ev.find((e) => e.kind === 'fairing');
    assert.ok(stg && fair, 'staging + fairing events');
    const atFair = F.sampleTrajectory(T, fair.t);
    assert.ok(atFair.alt_km > 20 && atFair.q_kPa < F.FAIRING_Q_KPA + 1e-9, 'fairing goes only once q has fallen');
    const sp = { ...d, payload: { ...d.payload, nosecone: 'spaceplane' } };
    assert.ok(!F.flightEvents(E.runAscent(sp), sp, E.LAUNCH_BODIES.earth).some((e) => e.kind === 'fairing'), 'no fairing on a spaceplane');

    near(F.playbackRate(1, ev, 533), 1, 1e-12, 'real time while clearing the tower');
    assert.ok(F.playbackRate(stg.t + 2, ev, 533) <= F.EVENT_RATE + 1e-12, 'slow motion through staging');
    const wall = F.playbackDuration(T[T.length - 1].t, ev);
    assert.ok(wall > 15 && wall < 60, `whole burn plays in a watchable time (${wall.toFixed(1)} s)`);
    near(F.airFraction(E.LAUNCH_BODIES.moon, 0), 0, 0, 'no air on the Moon');
    ok('pitch/downrange samples, true-geometry poses, events, time warp');
}

// ── Launch site: longitude ───────────────────────────────────────────────────
console.log('launch site');
{
    near(E.wrapLon(190), -170, 1e-12, 'wrap east past 180');
    near(E.wrapLon(-190), 170, 1e-12, 'wrap west past −180');
    near(E.wrapLon(180), -180, 1e-12, '180 → −180 (half-open)');
    assert.ok(Object.is(E.wrapLon(0), 0) && Object.is(E.wrapLon(-360), 0), 'no −0');
    assert.equal(E.wrapLon(177.9), 177.9, 'in-range longitude is returned bit-exact (no float noise in saved designs)');
    assert.equal(E.formatLatLon(-39.3, 177.9), '39.3° S · 177.9° E');

    // Legacy drafts: the meridian the view used to hard-code IS the default.
    const legacy = E.defaultDesign(); delete legacy.launchLongitude;
    near(E.normalizeDesign(legacy).launchLongitude, -80.6, 1e-12, 'legacy Earth draft → Cape meridian');
    near(E.normalizeDesign({ ...legacy, bodyId: 'mars' }).launchLongitude, 77.5, 1e-12, 'legacy Mars draft → Jezero meridian');
    near(E.normalizeDesign({ ...legacy, launchLongitude: 270 }).launchLongitude, -90, 1e-12, 'stored longitude is wrapped');
    near(E.normalizeDesign({ ...legacy, launchLatitude: 120 }).launchLatitude, 90, 1e-12, 'latitude clamped');
    assert.equal(E.matchLaunchSite('earth', 5.2, -52.8)?.id, 'kourou');
    assert.equal(E.matchLaunchSite('earth', 5.3, -52.8), null, 'off-preset is custom');
    for (const [body, sites] of Object.entries(E.LAUNCH_SITES)) {
        assert.ok(E.LAUNCH_BODIES[body], `${body} is a launch body`);
        for (const x of sites) assert.ok(Math.abs(x.lat) <= 90 && x.lon >= -180 && x.lon < 180, `${x.id} in range`);
    }

    // The orientation the 3D planet uses: the pad's own (lat, lon) lands on +Y,
    // local east on +X (downrange) and north on −Z, as a proper rotation.
    const P = (f, l) => [Math.cos(f) * Math.cos(l), Math.sin(f), -Math.cos(f) * Math.sin(l)];
    const rad = Math.PI / 180;
    for (const [la, lo] of [[28.5, -80.6], [-39.3, 177.9], [0, 0], [89.5, 45], [-89.5, -120]]) {
        const { E: e, U: u, Nneg: n } = F.padBasis(la, lo);
        const map = (v) => [e, u, n].map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
        const det = e[0] * (u[1] * n[2] - u[2] * n[1]) - e[1] * (u[0] * n[2] - u[2] * n[0]) + e[2] * (u[0] * n[1] - u[1] * n[0]);
        near(det, 1, 1e-12, `proper rotation at ${la},${lo}`);
        const up = map(P(la * rad, lo * rad));
        near(up[1], 1, 1e-12, `pad on +Y at ${la},${lo}`);
        const east = map(P(la * rad, (lo + 0.01) * rad));         // a step east
        assert.ok(east[0] > 0 && Math.abs(east[2]) < Math.abs(east[0]) * 1e-3 + 1e-12, `east is +X at ${la},${lo}`);
        const north = map(P((la + 0.01 * Math.sign(90 - la)) * rad, lo * rad));
        if (Math.abs(la) < 89) assert.ok(north[2] < 0, `north is −Z at ${la},${lo}`);
    }

    // Longitude chooses the ground, not the Δv: the 2D ascent flies due east.
    const a = E.runAscent({ ...E.defaultDesign(), launchLongitude: -80.6 });
    const b = E.runAscent({ ...E.defaultDesign(), launchLongitude: 131.0 });
    assert.equal(a.final_vt_kms, b.final_vt_kms, 'longitude changes no ascent number');
    ok('wrap/clamp, legacy meridians, presets, padBasis orientation, Δv-neutral longitude');
}

console.log(`\n${passed} groups passed`);
