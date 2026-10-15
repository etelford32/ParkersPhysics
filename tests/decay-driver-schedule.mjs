#!/usr/bin/env node
/**
 * decay-driver-schedule.mjs — gate for the time-varying decay drivers
 * (DECAY_BRIEF_PLAN.md §3 gap A / §4 step 1):
 *   js/decay/driver-schedule.js, js/decay/scheduled-decay.js,
 *   js/decay/msis-profile.js, and the additive rhoAtT / maxStepDays /
 *   onStep hooks in js/operations/msis-drag.js integrateDecay.
 *
 * Part A (pure, analytic atmosphere):
 *   1. The hooks are inert: rhoAtT that ignores t reproduces the
 *      constant-profile integrator EXACTLY (assert.equal, not approx).
 *   2. A one-state schedule reproduces the constant-profile lifetime.
 *   3. Source priority, gap holding, and provenance accounting.
 *   4. NRLMSISE-00 conventions: previous-day F10.7, centred 81-day
 *      F10.7A, the 7-element ap history.
 *   5. Monthly → daily interpolation.
 *   6. Physics through the schedule: a declining cycle outlives a held
 *      high one; a storm splice costs life, only inside its window; the
 *      segment-capped steps converge against a brute-force fine step.
 *   7. Past the schedule's end the state is held and `heldDays` says so.
 *
 * Part B (committed NRLMSISE-00 WASM): the real provider through the
 * schedule — the ap history array reaches MSIS (a storm's density lags
 * its ap), a 400 km CubeSat lifetime is plausible, and a three-day
 * G4-class splice shortens it.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { integrateDecay, makeRhoInterp } from '../js/operations/msis-drag.js';
import {
    buildDriverSchedule, segmentIndexAt, expandMonthlyToDaily, DAY_MS, SLOT_MS,
} from '../js/decay/driver-schedule.js';
import { scheduledDecay } from '../js/decay/scheduled-decay.js';
import { makeMsisProfileProvider } from '../js/decay/msis-profile.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const approx = (a, b, rel, msg) =>
    assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)), `${msg}: ${a} vs ${b}`);

const T0 = Date.UTC(2026, 9, 1);            // 2026-10-01 00:00 UTC
const day = (d) => T0 + d * DAY_MS;

// Analytic atmosphere: exponential in altitude, linear in F10.7, rising
// with the CURRENT ap only (Part B checks the history array separately).
const H_KM = 55, RHO400 = 3e-12;
const analyticProfile = ({ f107, ap }) => {
    const n = 151, alt0 = 90, step = 10;
    const rho = new Float64Array(n);
    const k = (f107 / 150) * (1 + ap / 40);
    for (let i = 0; i < n; i++) rho[i] = RHO400 * k * Math.exp(-(alt0 + i * step - 400) / H_KM);
    return { alt0, step, rho };
};
const flat = (value, d0, d1, spanMs = DAY_MS) => {
    const out = [];
    for (let t = day(d0); t < day(d1); t += spanMs) out.push({ tMs: t, value });
    return out;
};
const CUBESAT = { perigeeKm: 400, apogeeKm: 410, bc: 0.02 };

/* ═══ Part A — pure ═══════════════════════════════════════════════ */
console.log('Part A — schedule + scheduled decay (analytic atmosphere)');

// ── 1. Hooks are inert ──
{
    const rhoAt = makeRhoInterp(analyticProfile({ f107: 150, ap: 10 }));
    const a = integrateDecay({ ...CUBESAT, rhoAt });
    const b = integrateDecay({ ...CUBESAT, rhoAt: null, rhoAtT: (alt) => rhoAt(alt) });
    assert.equal(b.lifetimeDays, a.lifetimeDays, 'rhoAtT ignoring t is bit-identical');
    assert.equal(b.steps, a.steps);
    assert.equal(b.dadtKmDay, a.dadtKmDay);
    let calls = 0;
    integrateDecay({ ...CUBESAT, rhoAt, onStep: () => calls++ });
    assert.equal(calls, a.steps + 1, 'onStep fires at t = 0 and after every step');
    ok('rhoAtT / onStep leave the constant-profile arithmetic unchanged');
}

// ── 2. One-state schedule ≡ constant profile ──
{
    const sched = buildDriverSchedule({
        startMs: T0, endMs: day(4000),
        sources: [{ name: 'obs', f107: flat(150, -60, 4100), ap: flat(10, -5, 4100, SLOT_MS) }],
    });
    // Away from the data edges every slot is the same state.
    const mid = sched.segments.filter(s => s.t1Ms > day(1) && s.t0Ms < day(3900));
    assert.equal(new Set(mid.map(s => s.key)).size, 1, 'one state in the interior');
    const res = scheduledDecay({ ...CUBESAT, schedule: sched, profileFor: analyticProfile });
    const ref = integrateDecay({ ...CUBESAT, rhoAt: makeRhoInterp(analyticProfile({ f107: 150, ap: 10 })) });
    approx(res.lifetimeDays, ref.lifetimeDays, 2e-3, 'constant schedule lifetime');
    assert.ok(res.reentered && res.heldDays === 0);
    ok(`one-state schedule reproduces the constant lifetime (${res.lifetimeDays.toFixed(1)} d)`);
}

// ── 3. Priority, holding, provenance ──
{
    const sched = buildDriverSchedule({
        startMs: T0, endMs: day(20),
        sources: [
            { name: 'observed', f107: flat(100, -50, 2), ap: flat(5, -5, 2, SLOT_MS) },
            { name: 'forecast', f107: flat(200, 0, 10), ap: flat(30, 0, 10) },
            { name: 'outlook',  f107: flat(300, 0, 15) },
        ],
    });
    const at = (d) => sched.segments[segmentIndexAt(sched, day(d))];
    assert.equal(at(0.5).src.ap, 'observed', 'observed beats forecast where both exist');
    assert.equal(at(1.5).f107, 100, 'previous-day F10.7 (day 0 observed) on day 1');
    assert.equal(at(3.5).src.f107, 'forecast');
    assert.equal(at(3.5).f107, 200);
    assert.equal(at(5).ap, 30, 'daily forecast Ap fills all eight slots of its day');
    assert.equal(at(12).src.f107, 'outlook', 'outlook covers what the forecast does not');
    assert.equal(at(12).src.ap, 'held', 'ap past every source is held, and says so');
    assert.equal(at(12).ap, 30, 'held from the last real value');
    const hrs = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    assert.equal(hrs(sched.provenance.f107), 20 * 24, 'provenance accounts for every hour');
    assert.equal(hrs(sched.provenance.ap), 20 * 24);
    assert.equal(buildDriverSchedule({ startMs: T0, endMs: day(1), sources: [] }), null,
        'no data at all → null, never invented');
    ok('priority order, gap holding and provenance accounting');
}

// ── 4. MSIS conventions ──
{
    // F10.7 ramp: value = 100 + day index; ap = slot index within its day.
    const f = [], ap = [];
    for (let d = -60; d < 70; d++) f.push({ tMs: day(d), value: 100 + d });
    for (let s = -40; s < 30 * 8; s++) ap.push({ tMs: T0 + s * SLOT_MS, value: ((s % 8) + 8) % 8 });
    const sched = buildDriverSchedule({ startMs: T0, endMs: day(10), sources: [{ name: 'x', f107: f, ap }] });
    const seg = sched.segments[segmentIndexAt(sched, day(5) + 4 * SLOT_MS + 1)];   // day 5, slot 4
    assert.equal(seg.f107, 104, 'F10.7 is the PREVIOUS day');
    assert.equal(seg.f107a, 105, 'F10.7A is the centred 81-day mean (ramp → its centre)');
    assert.deepEqual(seg.apArray,
        [Math.round(3.5), 4, 3, 2, 1, Math.round((0 + 7 + 6 + 5 + 4 + 3 + 2 + 1) / 8),
         Math.round((0 + 7 + 6 + 5 + 4 + 3 + 2 + 1) / 8)],
        '[daily Ap, ap now, −3h, −6h, −9h, mean −12…−33h, mean −36…−57h]');
    assert.equal(sched.provenance.f107aClipped, 0, 'enough data on both sides → no clipping');
    const short = buildDriverSchedule({ startMs: T0, endMs: day(3), sources: [{ name: 'x', f107: flat(120, -3, 3), ap }] });
    assert.ok(short.provenance.f107aClipped > 0, 'thin data → clipped F10.7A is counted');
    ok('previous-day F10.7, centred F10.7A, 7-element ap history');
}

// ── 5. Monthly → daily ──
{
    const daily = expandMonthlyToDaily([{ tMs: day(0), value: 100 }, { tMs: day(30), value: 160 }]);
    assert.equal(daily.length, 31);
    assert.equal(daily[0].value, 100);
    approx(daily[15].value, 130, 1e-12, 'linear midpoint');
    assert.equal(daily[30].value, 160);
    ok('monthly outlook interpolates linearly to daily, no extrapolation');
}

// ── 6. Physics through the schedule ──
{
    const end = day(3000);
    const held = buildDriverSchedule({ startMs: T0, endMs: end,
        sources: [{ name: 'h', f107: flat(180, -60, 3100), ap: flat(10, -5, 3100) }] });
    const decline = [];
    for (let d = -60; d < 3100; d++) decline.push({ tMs: day(d), value: Math.max(75, 180 - 0.15 * d) });
    const declining = buildDriverSchedule({ startMs: T0, endMs: end,
        sources: [{ name: 'd', f107: decline, ap: flat(10, -5, 3100) }] });
    const rHeld = scheduledDecay({ ...CUBESAT, schedule: held, profileFor: analyticProfile });
    const rDecl = scheduledDecay({ ...CUBESAT, schedule: declining, profileFor: analyticProfile });
    // Decay rate ∝ ρ ∝ F10.7 in this atmosphere, so the lifetime L under
    // F(t) = F0 − k·t solves ∫₀ᴸ F dt = F0·L_held exactly:
    //   (k/2)L² − F0·L + F0·L_held = 0.
    // F10.7 enters one day late (previous-day convention), so the first
    // day runs at the value before the ramp starts — a ~0.1 % effect.
    const F0 = 180, kDecl = 0.15;
    const Lexact = (F0 - Math.sqrt(F0 * F0 - 2 * kDecl * F0 * rHeld.lifetimeDays)) / kDecl;
    assert.ok(rDecl.lifetimeDays > rHeld.lifetimeDays, 'a declining cycle outlives today\'s flux held fixed');
    approx(rDecl.lifetimeDays, Lexact, 0.01, 'declining-cycle lifetime vs closed form');

    // Storm: three days at ap 200 starting on day 30.
    const quiet = { name: 'q', f107: flat(150, -60, 3100), ap: flat(8, -5, 3100) };
    const stormAp = new Array(24).fill(200);
    const base  = buildDriverSchedule({ startMs: T0, endMs: end, sources: [quiet] });
    const storm = buildDriverSchedule({ startMs: T0, endMs: end, sources: [quiet],
        storm: { startMs: day(30), ap: stormAp } });
    const before = storm.segments[segmentIndexAt(storm, day(29.9))];
    const inside = storm.segments[segmentIndexAt(storm, day(31))];
    const after  = storm.segments[segmentIndexAt(storm, day(36))];
    assert.equal(before.ap, 8);
    assert.equal(inside.ap, 200);
    assert.equal(inside.src.ap, 'storm-scenario');
    assert.equal(after.ap, 8, 'splice ends with its window');
    const rBase  = scheduledDecay({ ...CUBESAT, schedule: base, profileFor: analyticProfile });
    const rStorm = scheduledDecay({ ...CUBESAT, schedule: storm, profileFor: analyticProfile, record: true });
    const cost = rBase.lifetimeDays - rStorm.lifetimeDays;
    assert.ok(cost > 3, `the storm costs life (${cost.toFixed(1)} d)`);

    // Convergence: the same run with every step forced ≤ 0.02 d.
    const segInterp = new Map();
    const rhoFine = (alt, t) => {
        const seg = storm.segments[segmentIndexAt(storm, T0 + t * DAY_MS)];
        if (!segInterp.has(seg)) segInterp.set(seg, makeRhoInterp(analyticProfile(seg)));
        return segInterp.get(seg)(alt);
    };
    const fine = integrateDecay({
        ...CUBESAT, rhoAt: null, rhoAtT: rhoFine, maxSteps: 2e6, maxStepDays: 0.02,
    });
    approx(rStorm.lifetimeDays, fine.lifetimeDays, 0.01, 'segment-capped steps vs brute force');

    // The storm window is resolved by step boundaries, not stepped over.
    // (Segments of identical state merge, so this is not one step per
    // slot — it is a step boundary exactly where the drivers change.)
    const lands = (d) => rStorm.track.some(p => Math.abs(p.tDays - d) < 1e-9);
    assert.ok(lands(30), 'a step boundary lands on the storm onset');
    assert.ok(lands(33), 'and on the end of the storm window');
    for (const seg of storm.segments.filter(s => s.t0Ms > T0 && s.t0Ms < day(40))) {
        assert.ok(lands((seg.t0Ms - T0) / DAY_MS), `boundary at every driver change (${(seg.t0Ms - T0) / DAY_MS} d)`);
    }
    assert.ok(rStorm.profiles < 60, `profile cache stays small (${rStorm.profiles})`);
    ok(`declining cycle +${(100 * (rDecl.lifetimeDays / rHeld.lifetimeDays - 1)).toFixed(0)} % life; 3-day ap-200 storm costs ${cost.toFixed(1)} d; converged`);
}

// ── 7. Held past the schedule ──
{
    const sched = buildDriverSchedule({ startMs: T0, endMs: day(30),
        sources: [{ name: 'q', f107: flat(150, -60, 40), ap: flat(10, -5, 40) }] });
    const res = scheduledDecay({ ...CUBESAT, schedule: sched, profileFor: analyticProfile });
    assert.ok(res.reentered && res.lifetimeDays > 30);
    approx(res.heldDays, res.lifetimeDays - 30, 1e-9, 'heldDays = lifetime past the schedule end');
    ok(`drivers held past the schedule are reported (${res.heldDays.toFixed(0)} d held)`);
}

/* ═══ Part B — real NRLMSISE-00 WASM ══════════════════════════════ */
console.log('Part B — committed NRLMSISE-00 WASM');

const { default: initWasm, nrlmsise00_density_profile, nrlmsise00_profile_stride } =
    await import('../js/sgp4-wasm/sgp4_wasm.js');
await initWasm({ module_or_path: await readFile(new URL('../js/sgp4-wasm/sgp4_wasm_bg.wasm', import.meta.url)) });
const msis = makeMsisProfileProvider({
    densityProfile: nrlmsise00_density_profile, profileStride: nrlmsise00_profile_stride,
});

// ── 8. The ap history reaches MSIS ──
{
    const rhoAt400 = (p) => makeRhoInterp(p)(400);
    const base = { f107: 150, f107a: 150, dateMs: day(10) };
    const quiet  = rhoAt400(msis({ ...base, ap: 10, apArray: [10, 10, 10, 10, 10, 10, 10] }));
    const onset  = rhoAt400(msis({ ...base, ap: 200, apArray: [60, 200, 10, 10, 10, 10, 10] }));
    const mature = rhoAt400(msis({ ...base, ap: 200, apArray: [200, 200, 200, 200, 200, 150, 80] }));
    assert.ok(onset > quiet, 'storm onset raises ρ');
    assert.ok(mature > 1.2 * onset, `a sustained storm raises ρ further than its first slot (${mature} vs ${onset})`);
    ok('MSIS sees the ap history: onset < sustained storm');
}

// ── 9. CubeSat through a real schedule ──
{
    const end = day(1500);
    const decline = [];
    for (let d = -60; d < 1600; d++) decline.push({ tMs: day(d), value: Math.max(75, 150 - 0.08 * d) });
    const quiet = { name: 'cycle', f107: decline, ap: flat(8, -5, 1600) };
    const base = buildDriverSchedule({ startMs: T0, endMs: end, sources: [quiet] });
    const g4 = buildDriverSchedule({ startMs: T0, endMs: end, sources: [quiet],
        storm: { name: 'g4', startMs: day(30), ap: [...new Array(8).fill(150), ...new Array(8).fill(207), ...new Array(8).fill(80)] } });
    const sat = { perigeeKm: 420, apogeeKm: 430, bc: 0.025 };
    const rBase = scheduledDecay({ ...sat, schedule: base, profileFor: msis });
    const rG4   = scheduledDecay({ ...sat, schedule: g4,   profileFor: msis });
    assert.ok(rBase && rG4, 'real provider runs end to end');
    assert.ok(rBase.lifetimeDays > 60 && rBase.lifetimeDays < 1500,
        `420 km 3U-class lifetime plausible (${rBase.lifetimeDays.toFixed(0)} d)`);
    const cost = rBase.lifetimeDays - rG4.lifetimeDays;
    assert.ok(cost > 0.5 && cost < 0.3 * rBase.lifetimeDays,
        `a three-day G4-class splice costs life, within reason (${cost.toFixed(1)} d)`);
    ok(`420 km: ${rBase.lifetimeDays.toFixed(0)} d; G4 splice costs ${cost.toFixed(1)} d; ${rBase.profiles} profiles`);
}

console.log(`\nAll ${passed} checks passed.`);
