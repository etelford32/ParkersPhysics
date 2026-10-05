#!/usr/bin/env node
/**
 * satellite-components.mjs — gate for the Satellite Designer's component
 * library, layout kernel and engineering review.
 *
 * Run: node tests/satellite-components.mjs
 *
 * The load-bearing pins:
 *   • ONE MASS. The layout places every item of massBreakdown(), so the sum of
 *     placed masses must equal deriveDesign().dryMass — the number the flight
 *     model flies. If a renderer-side part ever gains a mass the builder does
 *     not know about (or vice versa), the CG the review reports is a fiction.
 *   • NOTHING OVERLAPS, NOTHING ESCAPES. Internal units stay inside the bus
 *     envelope and clear of each other; face-mounted parts stay on their face,
 *     clear of each other and of the reserved footprints. Checked by an
 *     independent geometric oracle written here.
 *   • CAPACITY IS GEOMETRY. A tank's propellant capacity is its inner volume ×
 *     storage density × fill, so the drawn tank and the number agree; Auto
 *     always holds the load when any fitting set can.
 *   • REAL SATELLITES CLOSE THEIR BUDGETS. Every curated blueprint passes the
 *     engineering review with zero FAILs at its own orbit.
 *   • The closed-form physics is right where a textbook value exists
 *     (eclipse fraction, deorbit Δv, dish gain, inverse-square link law).
 *   • Moving mass off-axis moves the CG — and the review notices.
 */

import assert from 'node:assert/strict';
import * as B from '../js/satellite-builder.js';
import * as C from '../js/satellite-components.js';
import * as L from '../js/satellite-layout.js';
import * as E from '../js/satellite-engineering.js';
import * as BP from '../js/satellite-blueprints.js';
import * as ENG from '../js/satellite-designer-engine.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed += 1; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const env = ENG.defaultEnv();
const memo = new Map();
const rhoAt = (h) => {
    const k = Math.round(h * 2);
    if (!memo.has(k)) memo.set(k, ENG.airDensity(k / 2 * 1000, env));
    return memo.get(k);
};

// ── builder + blueprint self-tests still hold ───────────────────────────────
console.log('legacy self-tests');
for (const [name, fn] of [['builder', B.selfTest], ['blueprints', BP.selfTest], ['engine', ENG.selfTest]]) {
    const bad = fn().filter(r => !r.pass);
    assert.equal(bad.length, 0, `${name} self-test: ${bad.map(b => b.msg).join('; ')}`);
    ok(`${name} selfTest passes`);
}

// ── resolveBuild ────────────────────────────────────────────────────────────
console.log('resolveBuild');
{
    const legacy = { body: 'bus_med', thruster: 'monoprop', thrusterCount: 4, panel: 'dual', panelSpan: 3, payload: 'optical_cam' };
    const rb = B.resolveBuild(legacy);
    assert.equal(rb.battery, C.BODY_DEFAULTS.bus_med.battery);
    assert.equal(rb.adcs, C.BODY_DEFAULTS.bus_med.adcs);
    assert.deepEqual(rb.extras, C.BODY_DEFAULTS.bus_med.extras);
    assert.ok(rb.auto.extras && rb.auto.tank);
    ok('a legacy build (no subsystem fields) resolves to the bus default kit');
    const junk = B.resolveBuild({ body: 'nope', battery: 'x', extras: [{ k: 'bogus', face: '+Q' }, { k: 's_patch', face: '+Y' }] });
    assert.equal(junk.body, 'smallsat');
    assert.deepEqual(junk.extras, [{ k: 's_patch', face: '+Y' }]);
    ok('unknown keys fall back instead of throwing');
    const d0 = B.deriveDesign(legacy), d1 = B.deriveDesign({ ...legacy, battery: 'li_4800' });
    near(d1.dryMass - d0.dryMass, C.BATTERIES.li_4800.mass - C.BATTERIES[C.BODY_DEFAULTS.bus_med.battery].mass, 0.11, 'battery swap Δmass');
    ok('swapping a unit changes dry mass by exactly the unit delta');
}

// ── tanks: capacity is geometry ─────────────────────────────────────────────
console.log('tanks');
{
    const t = C.TANKS.ti_m, r = t.d / 2 - 0.005;
    near(C.tankVolume(t), 4 / 3 * Math.PI * r ** 3, 1e-12, 'sphere volume');
    near(C.tankCapacityKg(t, 'monoprop'), C.tankVolume(t) * 1004 * 0.92, 1e-9, 'hydrazine capacity');
    ok('capacity = inner volume × density × fill');
    for (const body of Object.keys(B.BODIES)) {
        for (const thr of ['monoprop', 'biprop', 'gridded_ion', 'cold_gas']) {
            for (const fuel of [0, 1, 5, 20, 60, 150]) {
                const d = B.deriveDesign({ ...B.defaultBuild(), body, thruster: thr, fuelKg: fuel });
                const lay = L.layoutBuild(d.resolved);
                const tanksFit = !lay.issues.some(i => i.id === 'layout.tanks');
                // If Auto reports a fit and enough capacity exists in SOME
                // fitting configuration, it must have chosen one that holds.
                if (tanksFit && d.tankCapacityKg < fuel) {
                    const any = Object.entries(C.TANKS).some(([k, tk]) => {
                        if (tk.cubesatOnly && C.bodyClass(body) !== 'cubesat') return false;
                        return [1, 2, 3, 4].some(n => {
                            const lb = L.layoutBuild({ ...d.resolved, tank: k, tankCount: n, auto: { ...d.resolved.auto, tank: false } });
                            return !lb.issues.some(i => i.sev === 'fail' && /tanks|battery|adcs|obc/.test(i.id))
                                && C.tankCapacityKg(tk, thr) * n >= fuel;
                        });
                    });
                    assert.ok(!any, `${body}/${thr}/${fuel} kg: Auto chose ${d.tank}×${d.tankCount} (${d.tankCapacityKg} kg) though a larger fitting set exists`);
                }
            }
        }
    }
    ok('Auto tank holds the load whenever any fitting tank set can');
    const bp = B.resolveBuild({ ...B.defaultBuild(), body: 'bus_med', thruster: 'biprop', fuelKg: 120 });
    assert.equal(bp.tankCount % 2, 0, `biprop auto tank count ${bp.tankCount}`);
    ok('biprop Auto prefers separate fuel/oxidiser tanks (even count)');
}

// ── layout oracle ───────────────────────────────────────────────────────────
console.log('layout');
function checkLayout(build, label) {
    const d = B.deriveDesign(build);
    const lay = L.layoutBuild(build);
    const sum = lay.parts.reduce((a, p) => a + p.mass, 0);
    near(sum, d.dryMass, 0.06, `${label}: placed mass vs dryMass`);
    const env3 = C.innerEnvelope(lay.body, lay.rb.body);
    const internals = lay.parts.filter(p => p.internal && !p.hidden && p.fits);
    for (const p of internals) {
        for (let k = 0; k < 3; k++) {
            const lo = (k === 2 ? env3.zc : 0) - env3.size[k] / 2 - 1e-6;
            const hi = (k === 2 ? env3.zc : 0) + env3.size[k] / 2 + 1e-6;
            assert.ok(p.c[k] - p.s[k] / 2 >= lo && p.c[k] + p.s[k] / 2 <= hi, `${label}: ${p.id} escapes the envelope on axis ${k}`);
        }
        if (env3.shape === 'cyl' && p.slot !== 'tank') {
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                assert.ok(Math.hypot(p.c[0] + sx * p.s[0] / 2, p.c[1] + sy * p.s[1] / 2) <= env3.r + 1e-6, `${label}: ${p.id} outside the cylinder`);
            }
        }
    }
    // Internal boxes must not overlap (tanks against each other as boxes is
    // too strict for spheres, so spheres are tested as spheres).
    const sphereOf = (p) => p.slot === 'tank' && C.TANKS[p.key].shape === 'sphere' ? C.TANKS[p.key].d / 2 : 0;
    for (let i = 0; i < internals.length; i++) for (let j = i + 1; j < internals.length; j++) {
        const a = internals[i], b = internals[j];
        const ra = sphereOf(a), rb = sphereOf(b);
        let clash;
        if (ra && rb) clash = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]) < ra + rb - 1e-6;
        else if (ra || rb) {
            const [s, bx] = ra ? [a, b] : [b, a];
            const r = ra || rb;
            let d2 = 0;
            for (let k = 0; k < 3; k++) {
                const q = Math.max(bx.c[k] - bx.s[k] / 2, Math.min(s.c[k], bx.c[k] + bx.s[k] / 2));
                d2 += (s.c[k] - q) ** 2;
            }
            clash = d2 < r * r - 1e-9;
        } else clash = [0, 1, 2].every(k => Math.abs(a.c[k] - b.c[k]) < (a.s[k] + b.s[k]) / 2 - 1e-6);
        assert.ok(!clash, `${label}: ${a.id} overlaps ${b.id}`);
    }
    // Extras: on their face, inside it, clear of each other.
    const extras = lay.parts.filter(p => p.slot === 'extra' && p.fits);
    for (const p of extras) {
        const g = C.faceGeometry(lay.body, p.face);
        const x = C.EXTRAS[p.key];
        assert.ok(Math.abs(p.fu) + x.foot[0] / 2 <= g.W / 2 + 1e-6 && Math.abs(p.fv) + x.foot[1] / 2 <= g.H / 2 + 1e-6,
            `${label}: ${p.id} hangs off ${p.face}`);
    }
    for (let i = 0; i < extras.length; i++) for (let j = i + 1; j < extras.length; j++) {
        const a = extras[i], b = extras[j];
        if (a.face !== b.face) continue;
        const A = C.EXTRAS[a.key].foot, Bf = C.EXTRAS[b.key].foot;
        const clash = Math.abs(a.fu - b.fu) < (A[0] + Bf[0]) / 2 - 1e-6 && Math.abs(a.fv - b.fv) < (A[1] + Bf[1]) / 2 - 1e-6;
        assert.ok(!clash, `${label}: ${a.id} overlaps ${b.id} on ${a.face}`);
    }
    return { d, lay };
}
for (const body of Object.keys(B.BODIES)) {
    const { lay } = checkLayout({ ...B.defaultBuild(), body, fuelKg: C.bodyClass(body) === 'cubesat' ? 0.5 : 60 }, body);
    assert.equal(lay.issues.filter(i => i.sev === 'fail').length, 0,
        `${body} default kit has packaging failures: ${lay.issues.map(i => i.msg).join('; ')}`);
}
ok('every bus with its default kit: mass sums, no overlaps, no escapes, no packaging fails');
for (const b of BP.BLUEPRINTS) checkLayout(BP.blueprintBuild(b), b.id);
ok('every blueprint lays out cleanly under the oracle');
{
    // Crowd a CubeSat face until the packer must refuse — and report it.
    const extras = Array.from({ length: 14 }, () => ({ k: 's_patch', face: '+Y' }));
    const lay = L.layoutBuild({ ...B.defaultBuild(), body: 'cubesat_3u', fuelKg: 0.2, extras });
    assert.ok(lay.issues.some(i => i.sev === 'fail' && /extra/.test(i.id)), 'overflow reported');
    ok('a crowded face reports the parts that have no room');
}

// ── mass properties ─────────────────────────────────────────────────────────
console.log('mass properties');
{
    const sym = { ...B.defaultBuild(), extras: [] , bodyCells: [] };
    const mp = L.massProperties(L.layoutBuild(sym), 60);
    assert.ok(Math.hypot(mp.cg[0], mp.cg[1]) < 0.01, `symmetric build CG off-axis by ${Math.hypot(mp.cg[0], mp.cg[1])} m`);
    ok('a symmetric build keeps its CG on the thrust axis');
    const heavyY = { ...sym, extras: [{ k: 'ka_dish', face: '+Y' }, { k: 'laser_term', face: '+Y' }] };
    const mp2 = L.massProperties(L.layoutBuild(heavyY), 60);
    assert.ok(mp2.cg[1] > 0.02, `CG y after mounting 17 kg on +Y: ${mp2.cg[1]}`);
    const r = E.reviewDesign(heavyY, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.ok(r.massProps.thrustTorque > 0.5, 'thrust torque rises with the offset');
    ok('mounting heavy parts on +Y walks the CG toward +Y and raises thrust torque');
    // Principal moments are the eigenvalues: trace is invariant.
    const tr = mp2.I[0][0] + mp2.I[1][1] + mp2.I[2][2];
    near(mp2.principal.reduce((a, b) => a + b, 0), tr, 1e-6 * tr, 'trace invariance');
    ok('principal moments preserve the inertia trace');
}

// ── closed forms ────────────────────────────────────────────────────────────
console.log('closed forms');
{
    const o = E.orbitGeometry(500);
    near(o.eclipseFrac, Math.asin(6371 / 6871) / Math.PI, 1e-12, 'eclipse fraction');
    near(o.eclipseS / 60, 35.7, 0.3, 'eclipse minutes at 500 km');
    near(o.periodS / 60, 94.6, 0.2, 'period at 500 km');
    ok('500 km: 94.6 min period, 35.7 min eclipse at β = 0');
    // By hand: v_c(6871 km) = 7616.6 m/s; apoapsis speed of the 6871 × 6571
    // km ellipse = √(μ(2/r − 2/(r+r_p))) = 7531.1 m/s → 85.5 m/s.
    near(E.deorbitDv(500, 200), 85.5, 0.2, 'deorbit Δv 500→200 km perigee');
    assert.equal(E.deorbitDv(150), 0);
    ok('deorbit Δv (Hohmann first burn) = 85.5 m/s from 500 km');
    near(E.dishGainDbi(0.6, 26e9), 42.0, 0.3, '0.6 m Ka dish gain');
    ok('parabolic gain 0.6 m @ 26 GHz ≈ 42 dBi (η 0.6)');
    const x = { ...C.EXTRAS.x_patch, maxBps: Infinity };
    const a = E.linkBudget(x, 1e6), b = E.linkBudget(x, 2e6);
    near(10 * Math.log10(a.rawBps / b.rawBps), 6.02, 0.01, 'inverse-square');
    ok('doubling range costs 6.02 dB of data rate');
    const slant = E.slantRange(500, 90);
    near(slant, 500e3, 1, 'zenith slant range');
    ok('slant range at zenith = altitude');
    const lo = E.decayLifetimeYears(350, 0.01, rhoAt), hi = E.decayLifetimeYears(600, 0.01, rhoAt);
    assert.ok(hi > lo * 5, `lifetime 350 km ${lo} yr vs 600 km ${hi} yr`);
    const heavy = E.decayLifetimeYears(400, 0.005, rhoAt), light = E.decayLifetimeYears(400, 0.02, rhoAt);
    near(heavy / light, 4, 1e-9, 'lifetime ∝ ballistic coefficient');
    ok('decay lifetime grows with altitude and scales with m/(C_d A)');
}

// ── thermal: the recommended radiator is a fixed point ──────────────────────
console.log('thermal');
{
    const b = { ...B.defaultBuild(), body: 'bus_med', payload: 'sar_radar' };
    const r = E.reviewDesign(b, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.ok(r.thermal.radRecFrac != null && r.thermal.radRecFrac > 0 && r.thermal.radRecFrac < 1, `rec ${r.thermal.radRecFrac}`);
    const r2 = E.reviewDesign({ ...b, radiator: r.thermal.radRecFrac }, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    near(r2.thermal.hotC, 25, 0.2, 'hot case at the recommended coverage');
    ok('installing the recommended radiator puts the hot case at +25 °C');
    const more = E.reviewDesign({ ...b, radiator: Math.min(1, r.thermal.radRecFrac + 0.3) }, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.ok(more.thermal.coldC < r2.thermal.coldC && more.thermal.heaterW >= r2.thermal.heaterW, 'more radiator ⇒ colder, more heater power');
    assert.ok(more.power.loadSunW >= r2.power.loadSunW, 'heaters land in the power budget');
    ok('over-sizing the radiator costs heater power, and the power budget carries it');
}

// ── power ────────────────────────────────────────────────────────────────────
console.log('power');
{
    const b = { ...B.defaultBuild(), battery: 'li_20' };
    const r = E.reviewDesign(b, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.equal(r.checks.find(c => c.id === 'power.dod').sev, 'fail', 'a 20 Wh pack on a smallsat must fail DoD');
    const big = E.reviewDesign({ ...b, battery: 'li_1200' }, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.equal(big.checks.find(c => c.id === 'power.dod').sev, 'pass');
    ok('battery sizing drives the depth-of-discharge check');
    const cube = B.deriveDesign({ ...B.defaultBuild(), body: 'cubesat_3u', panel: 'none' });
    assert.ok(cube.cellPower > 3 && cube.cellPower < 20, `3U body-cell power ${cube.cellPower} W`);
    ok('a bare 3U makes a few watts from body-mounted cells (A/4 orientation average)');
}

// ── comms ───────────────────────────────────────────────────────────────────
console.log('comms');
{
    const none = E.reviewDesign({ ...B.defaultBuild(), extras: [] }, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.equal(none.checks.find(c => c.id === 'comms.radio').sev, 'fail');
    ok('no radio ⇒ FAIL');
    const s = E.reviewDesign({ ...B.defaultBuild(), payload: 'sar_radar', extras: [{ k: 's_patch', face: '-Y' }] }, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    const x = E.reviewDesign({ ...B.defaultBuild(), payload: 'sar_radar', extras: [{ k: 's_patch', face: '-Y' }, { k: 'x_horn', face: '+Y' }] }, { presets: ENG.ENGINE_PRESETS, altKm: 500, rhoAt });
    assert.ok(x.comms.stations < s.comms.stations, `X-band cuts the station count (${s.comms.stations} → ${x.comms.stations})`);
    ok('adding an X-band horn cuts the ground stations a SAR needs');
}

// ── the realism gate ────────────────────────────────────────────────────────
console.log('blueprints close their budgets');
for (const b of BP.BLUEPRINTS) {
    const r = E.reviewDesign(BP.blueprintBuild(b), { presets: ENG.ENGINE_PRESETS, altKm: b.orbit.periKm, rhoAt });
    const fails = r.checks.filter(c => c.sev === 'fail');
    assert.equal(fails.length, 0, `${b.id}: ${fails.map(f => f.title + ' — ' + f.detail).join(' | ')}`);
}
ok(`all ${BP.BLUEPRINTS.length} blueprints pass the engineering review with zero FAILs`);
{
    const r = E.reviewDesign(B.defaultBuild(), { presets: ENG.ENGINE_PRESETS, altKm: 350, rhoAt });
    assert.equal(r.counts.fail + r.counts.warn, 0, `default build at 350 km: ${r.checks.filter(c => c.sev !== 'pass').map(c => c.title).join('; ')}`);
    ok('the default build at the default 350 km start altitude is clean (no warnings)');
}

console.log(`\n${passed} checks passed`);
