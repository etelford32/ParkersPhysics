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
 *   • THE GUIDANCE STOPS AT ORBIT. The two-burn insertion ends in a bound
 *     orbit at the target on every airless world (the old path flew the Moon
 *     run to 2.87 km/s — past lunar ESCAPE — and graded it "Orbit"), the
 *     lunar ascent costs what Apollo's did (~1.85 km/s), and the honest
 *     failures are reported as such: Venus never lifts off, an over-powered
 *     booster breaks up in Titan's air.
 *   • DESTINATIONS ARE TEXTBOOK. TLI 3.13, LOI 0.82, TMI 3.61, Earth escape
 *     3.22, GTO 2.44 + 1.47, Earth–Mars Hohmann 259 d, synodic 780 d.
 */

import assert from 'node:assert/strict';
import * as E from '../js/spaceship-designer-engine.js';
import * as F from '../js/spaceship-designer-flight.js';
import * as A from '../js/spaceship-designer-ascent.js';
import * as M from '../js/spaceship-designer-mission.js';

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

// ── Guided ascent (two-burn insertion) ───────────────────────────────────────
console.log('guided ascent');
{
    const mu = 3.986e14, r = 6.578e6, vc = Math.sqrt(mu / r);
    const c = A.orbitElements(mu, r, 0, vc);
    near(c.peri_r, r, 1, 'circular: periapsis = r'); near(c.apo_r, r, 1, 'circular: apoapsis = r');
    assert.equal(A.orbitElements(mu, r, 0, vc * Math.SQRT2 * 1.001).apo_r, Infinity, 'above escape speed: unbound');
    near(A.atmosphereTopKm(E.LAUNCH_BODIES.earth), 99.6, 0.5, 'Earth atmosphere top ≈ Kármán line');
    assert.equal(A.atmosphereTopKm(E.LAUNCH_BODIES.moon), 0, 'airless');
    assert.ok(A.atmosphereTopKm(E.LAUNCH_BODIES.titan) > 200, 'Titan’s air reaches far higher than Earth’s');

    const fly = (body, extra = {}) => E.runAscent(E.normalizeDesign({ ...E.defaultDesign(), bodyId: body, ...extra }));
    const earth = fly('earth');
    assert.equal(earth.status, 'orbit');
    assert.ok(earth.orbit.peri_km >= 0.9 * 200 && earth.orbit.apo_km < 260, `Earth orbit near target (${earth.orbit.peri_km.toFixed(0)} × ${earth.orbit.apo_km.toFixed(0)})`);
    assert.ok(earth.dv_used_kms > 9.0 && earth.dv_used_kms < 10.5, `Earth Δv to LEO ${earth.dv_used_kms.toFixed(2)} km/s`);
    for (const b of ['moon', 'mercury', 'europa', 'enceladus', 'mars']) {
        const r2 = fly(b);
        assert.equal(r2.status, 'orbit', `${b} reaches orbit`);
        assert.ok(Number.isFinite(r2.orbit.apo_km) && r2.orbit.energy < 0, `${b}: bound orbit, not escape`);
        assert.ok(r2.orbit.peri_km >= 0.9 * 200 && r2.orbit.apo_km < 300, `${b}: at the target (${r2.orbit.peri_km.toFixed(0)} × ${r2.orbit.apo_km.toFixed(0)})`);
    }
    const moon = fly('moon');
    assert.ok(moon.dv_used_kms > 1.75 && moon.dv_used_kms < 2.1, `lunar ascent ${moon.dv_used_kms.toFixed(2)} km/s (Apollo LM ≈ 1.85)`);
    assert.equal(fly('venus').status, 'no-liftoff', 'Venus: no thrust against 92 bar');
    const titan = fly('titan');
    assert.equal(titan.status, 'breakup');
    assert.ok(titan.max_q_kPa > A.Q_BREAKUP_FACTOR * 35, 'Titan breakup is a measured q exceedance');

    // Rotation assist now shows up as Δv LEFT (both runs stop at circular).
    assert.ok(fly('earth', { launchLatitude: 0 }).remaining_dv_kms > fly('earth', { launchLatitude: 90 }).remaining_dv_kms, 'equator beats pole');
    // Δv left is the rocket equation on what is left, stage by stage.
    near(earth.remaining_stages.reduce((a, x) => a + x.dv_kms, 0), earth.remaining_dv_kms, 1e-9, 'remaining Δv sums its stages');
    // Deterministic (the turn search must not depend on anything ambient).
    assert.deepEqual(E.runAscent(E.defaultDesign()).orbit, earth.orbit, 'deterministic');
    // The planners' integrator is untouched: the designer no longer calls it.
    assert.equal(earth.guidance, 'insertion');

    // Liftoff thrust at the BODY's surface pressure (the flight's own law).
    const st = (b) => E.computeStats(E.normalizeDesign({ ...E.defaultDesign(), bodyId: b }));
    near(st('earth').liftoffThrust_kN, 854 * 9, 1e-6, 'Earth: the sea-level rating, exactly');
    assert.equal(st('venus').liftoffThrust_kN, 0, 'Venus: a Merlin cannot push against 92 bar');
    assert.ok(st('mars').liftoffThrust_kN > st('earth').liftoffThrust_kN, 'Mars: near-vacuum thrust');

    // Playback: an airless ascent coasts ~50 min; it must still play briskly.
    const ev = F.flightEvents(moon, E.defaultDesign(), E.LAUNCH_BODIES.moon);
    assert.ok(ev.some((e) => e.kind === 'coast') && ev.some((e) => e.kind === 'circularize'), 'coast + circularize events');
    const wall = F.playbackDuration(moon.trajectory[moon.trajectory.length - 1].t, ev);
    assert.ok(wall < 60, `lunar ascent plays in ${wall.toFixed(1)} s`);
    ok('bound orbits at target on 6 worlds, Apollo-class lunar Δv, Venus/Titan failures, surface thrust, playback');
}

// ── Beyond orbit (mission kernel) ────────────────────────────────────────────
console.log('mission budgets');
{
    const b = (o, alt, d) => M.transferBudget(o, alt, d);
    near(b('earth', 200, 'moon').depart_kms, 3.13, 0.02, 'TLI from 200 km');
    near(b('earth', 200, 'moon').capture_kms, 0.82, 0.04, 'lunar orbit insertion');
    near(b('earth', 200, 'mars').depart_kms, 3.61, 0.02, 'trans-Mars injection');
    near(b('earth', 200, 'escape').depart_kms, 3.22, 0.01, 'Earth escape (C3 = 0)');
    const geo = b('earth', 200, 'geo');
    near(geo.depart_kms, 2.45, 0.02, 'GTO'); near(geo.capture_kms, 1.47, 0.02, 'GEO circularisation');
    near(b('earth', 200, 'mars').tof_days, 259, 1, 'Earth–Mars Hohmann');
    near(b('earth', 200, 'mars').window_days, 780, 1, 'Mars synodic period');
    near(b('earth', 200, 'venus').window_days, 584, 1, 'Venus synodic period');
    near(b('moon', 100, 'earth').depart_kms, 0.82, 0.05, 'trans-Earth injection');
    // Symmetry: Earth→Mars departure equals Mars→Earth capture-free arrival speed pairing.
    near(b('earth', 200, 'mars').vinf_depart_kms, b('mars', 200, 'earth').vinf_arrive_kms, 1e-9, 'v∞ symmetric');
    for (const [o, list] of Object.entries(M.DESTINATIONS)) {
        for (const d of list) {
            const x = b(o, 200, d);
            assert.ok(x && Number.isFinite(x.total_kms) && x.total_kms > 0, `${o} → ${d} modelled`);
        }
    }
    const opts = M.missionOptions('earth', 200, 4.0);
    const r = Object.fromEntries(opts.map((x) => [x.id, x.reach]));
    assert.equal(r.moon, 'orbit'); assert.equal(r.mars, 'aero'); assert.equal(r.escape, 'orbit');
    assert.equal(M.missionOptions('earth', 200, 1.0).find((x) => x.id === 'moon').reach, 'no');
    ok('TLI/LOI/TMI/escape/GTO/GEO, Hohmann times, synodic windows, reach logic');
}

console.log(`\n${passed} groups passed`);
