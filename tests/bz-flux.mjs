/**
 * tests/bz-flux.mjs — gate for the Bz engine's B2 (BZ_ENGINE_PLAN.md):
 * js/bz/propagate.js, flux.js, flux-analysis.js, the l1-plasma normaliser and
 * api/bz/flux.js.
 *
 *   node tests/bz-flux.mjs
 *
 * Propagation is tested against a PLANTED tilted plane (tests/helpers/
 * bz-planted-wind.mjs) whose arrival time at any point is known in closed
 * form; the flat delay is the negative control throughout.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatSlowness, slownessFromLags, describeSlowness, slownessFromNormal, eigSym3, mvab, chooseSlowness, delayS, arrivalOrder, PROP_DEFAULTS } from '../js/bz/propagate.js';
import { milanRateKv, newellNative, newellMilanEquivalentKv, siscoeHillKv, milanSigmaKv, openedFluxGWb, clockAngle, SISCOE_HILL, REFERENCE_WIND, MILAN } from '../js/bz/flux.js';
import { analyzeFlux } from '../js/bz/flux-analysis.js';
import { normalizeL1Mag, normalizeEphem, normalizeL1Plasma, FEEDS } from '../js/bz/feeds.js';
import { RE_KM } from '../js/bz/frames.js';
import { POS, DEG, rng, unitNormal, arrivalMin, plantedField, plantedFeeds } from './helpers/bz-planted-wind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);
const V400 = [-400, 0, 0];
const PAIRS = [['ACE', 'IMAP'], ['ACE', 'SOLAR1'], ['IMAP', 'SOLAR1']];
/** Exact pair lags of a plane, as fuse-l1 would report them. */
function exactLags(n, v, jitter = null) {
    return PAIRS.map(([a, b]) => ({ pair: [a, b], r: 0.9, source: 'measured',
        lagMin: arrivalMin(POS[b], n, v) - arrivalMin(POS[a], n, v) + (jitter ? jitter() : 0) }));
}
const ang = (u, n) => Math.acos(Math.min(1, Math.abs(u[0] * n.x + u[1] * n.y + u[2] * n.z))) * DEG;

// ── 1. slowness from lags ─────────────────────────────────────────────────
{
    const f = flatSlowness(V400);
    close(delayS(f, { x: 225, y: -48, z: -18 }, { x: 14, y: 0, z: 0 }), (225 - 14) * RE_KM / 400, 1e-6, 'flat delay = Δx / v');
    assert.equal(flatSlowness([0, 0, 0]), null);

    for (const [txy, tz] of [[35, 0], [-50, 20], [10, -30], [0, 0]]) {
        const n = unitNormal(txy, tz);
        const s = slownessFromLags(POS, exactLags(n, 400), V400);
        assert.ok(ang(s.normal, n) < 1e-6, `normal recovered for tilt (${txy}, ${tz})`);
        close(s.m[0] * V400[0], 1, 1e-12, 'V·m = 1 exactly');
        close(s.closure_min, 0, 1e-9, 'a true plane closes its triangle');
        close(s.residual_min, 0, 1e-9);
        close(s.tiltDeg, Math.acos(n.x) * DEG, 1e-6);
        // …and the delay it implies to a point on the Sun–Earth line is the plane's own.
        const target = { x: 13.5, y: 0, z: 0 };
        close(delayS(s.m, POS.SOLAR1, target) / 60, arrivalMin(target, n, 400) - arrivalMin(POS.SOLAR1, n, 400), 1e-6, 'delay to the target');
    }
    ok('slownessFromLags: exact for four planted normals; V·m = 1; the triangle closes');

    // The flat delay is wrong by many minutes for a tilted front — the negative control.
    const n = unitNormal(35);
    const target = { x: 13.5, y: 0, z: 0 };
    const truth = arrivalMin(target, n, 400) - arrivalMin(POS.SOLAR1, n, 400);
    const flat = delayS(f, POS.SOLAR1, target) / 60;
    assert.ok(Math.abs(flat - truth) > 7, `flat delay ${flat.toFixed(1)} min vs true ${truth.toFixed(1)} min`);
    ok(`negative control: for a 35° front the flat delay is ${flat.toFixed(1)} min, the truth ${truth.toFixed(1)} min`);

    // Lag noise of 0.5 min. THE MEASURED GEOMETRY IS A THIN TRIANGLE (97.8 R_E
    // long, 6.8 R_E high), so one component of the normal is poorly fixed —
    // but the Sun–Earth line lies only 3.1 R_E off the spacecraft line, so the
    // delay TO EARTH barely depends on that component. Both halves are pinned.
    const R = rng(5);
    const errs = [], dErr = [];
    let closeMax = 0;
    for (let k = 0; k < 2000; k++) {
        const s = slownessFromLags(POS, exactLags(n, 400, () => 0.5 * R.g()), V400);
        errs.push(ang(s.normal, n));
        dErr.push(delayS(s.m, POS.SOLAR1, target) / 60 - truth);
        closeMax = Math.max(closeMax, Math.abs(s.closure_min));
    }
    errs.sort((x, y) => x - y);
    const med = errs[1000], rms = Math.sqrt(dErr.reduce((q, x) => q + x * x, 0) / dErr.length);
    assert.ok(med > 4 && med < 10, `median normal error ${med.toFixed(1)}° — degrees, not arc-minutes`);
    assert.ok(rms < 0.4, `delay-to-Earth-line rms ${rms.toFixed(2)} min`);
    assert.ok(closeMax > 0.5, 'noisy lags do not close, and closure says so');
    ok(`thin triangle: 0.5-min lag noise ⇒ normal off by ${med.toFixed(1)}° (median) but the delay to Earth by only ${rms.toFixed(2)} min rms`);

    // A vector velocity that is not radial still satisfies V·m = 1.
    const Vo = [-420, 30, -15];
    const so = slownessFromLags(POS, exactLags(n, 400), Vo);
    close(so.m[0] * Vo[0] + so.m[1] * Vo[1] + so.m[2] * Vo[2], 1, 1e-12, 'oblique V');

    // Refusals.
    assert.equal(slownessFromLags(POS, exactLags(n, 400).slice(0, 1), V400), null, 'one pair cannot fix a plane');
    assert.equal(slownessFromLags(POS, exactLags(n, 400).map((l) => ({ ...l, source: 'advective' })), V400), null, 'fallback lags are not measurements');
    assert.equal(slownessFromLags(POS, exactLags(n, 400).map((l) => ({ ...l, r: 0.4 })), V400), null, 'weakly correlated lags are not used');
    const line = { A: { x: 230, y: 40, z: 20 }, B: { x: 228, y: 0, z: 0 }, C: { x: 226, y: -40, z: -20 } };   // collinear across the flow
    const ll = [['A', 'B'], ['A', 'C'], ['B', 'C']].map(([a, b]) => ({ pair: [a, b], r: 0.9, source: 'measured',
        lagMin: arrivalMin(line[b], n, 400) - arrivalMin(line[a], n, 400) }));
    const sl = slownessFromLags(line, ll, V400);
    assert.ok(sl === null || sl.condition > 1e6, 'collinear spacecraft cannot fix both transverse components');
    const real = slownessFromLags(POS, exactLags(n, 400), V400);
    assert.ok(real.condition > 2 && real.condition < 20, `the measured geometry's condition number is ${real.condition.toFixed(1)}`);
    ok(`refusals: one pair, fallback lags, weak lags, collinear spacecraft; real geometry condition ${real.condition.toFixed(1)}`);
}

// ── 2. minimum variance ───────────────────────────────────────────────────
{
    const e = eigSym3([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);
    close(e.values[0], 1, 1e-12); close(e.values[1], 3, 1e-12); close(e.values[2], 5, 1e-12);
    close(Math.abs(e.vectors[0][0]), Math.SQRT1_2, 1e-9); close(e.vectors[0][0] + e.vectors[0][1], 0, 1e-9);

    // A planar structure: the field rotates in the plane ⟂ n, with a constant normal component.
    const n = unitNormal(40, 15), nv = [n.x, n.y, n.z];
    let a = [-nv[1], nv[0], 0]; const na = Math.hypot(...a); a = a.map((x) => x / na);
    const b = [nv[1] * a[2] - nv[2] * a[1], nv[2] * a[0] - nv[0] * a[2], nv[0] * a[1] - nv[1] * a[0]];
    const R = rng(9), g = { bx: new Float64Array(60), by: new Float64Array(60), bz: new Float64Array(60) };
    for (let i = 0; i < 60; i++) {
        const ph = i / 9, ca = 5 * Math.cos(ph), cb = 3 * Math.sin(ph * 1.7);
        g.bx[i] = 2 * nv[0] + ca * a[0] + cb * b[0] + 0.05 * R.g();
        g.by[i] = 2 * nv[1] + ca * a[1] + cb * b[1] + 0.05 * R.g();
        g.bz[i] = 2 * nv[2] + ca * a[2] + cb * b[2] + 0.05 * R.g();
    }
    const mv = mvab(g, 0, 60);
    assert.ok(mv.ok && mv.ratio > 100);
    assert.ok(ang(mv.normal, n) < 1, `MVAB normal within ${ang(mv.normal, n).toFixed(2)}°`);
    // Isotropic noise has no normal: the eigenvalue ratio refuses it.
    const iso = { bx: new Float64Array(60), by: new Float64Array(60), bz: new Float64Array(60) };
    for (let i = 0; i < 60; i++) { iso.bx[i] = R.g(); iso.by[i] = R.g(); iso.bz[i] = R.g(); }
    assert.equal(mvab(iso, 0, 60).ok, false, 'isotropic fluctuations ⇒ no normal claimed');
    assert.equal(mvab(g, 0, 10), null, 'too few samples');
    g.bx[5] = NaN;
    assert.equal(mvab(g, 0, 60).n, 59, 'a gap is skipped, not filled');
    ok('eigSym3 exact on a known matrix; MVAB recovers a planted normal and refuses isotropic noise');

    // ── chooseSlowness: priority and refusals ────────────────────────────
    const lags = exactLags(unitNormal(35), 400);
    const c1 = chooseSlowness({ positions: POS, lags, V: V400, mvabResult: mv });
    assert.equal(c1.method, 'multi-spacecraft-lags', 'measured lags outrank MVAB');
    const noLags = lags.map((l) => ({ ...l, source: 'advective' }));
    // MVAB is OFF by default (it has not beaten the flat delay on real data): available, named, not used.
    const c0 = chooseSlowness({ positions: POS, lags: noLags, V: V400, mvabResult: mv });
    assert.equal(c0.method, 'flat');
    assert.deepEqual(c0.notes, ['too_few_measured_lags', 'mvab_available_but_not_trusted_yet']);
    assert.equal(PROP_DEFAULTS.useMvab, false);
    const c2 = chooseSlowness({ positions: POS, lags: noLags, V: V400, mvabResult: mv }, { useMvab: true });
    assert.equal(c2.method, 'mvab');
    assert.deepEqual(c2.notes, ['too_few_measured_lags']);
    close(c2.tiltDeg, Math.acos(n.x) * DEG, 1);
    const c3 = chooseSlowness({ positions: POS, lags: [], V: V400, mvabResult: mvab(iso, 0, 60) }, { useMvab: true });
    assert.equal(c3.method, 'flat');
    assert.deepEqual(c3.notes, ['mvab_eigenvalues_not_separated']);
    const steep = chooseSlowness({ positions: POS, lags: exactLags(unitNormal(80), 400), V: V400 });
    assert.equal(steep.method, 'flat', 'an 80° normal is refused');
    assert.match(steep.notes[0], /^lag_normal_refused_tilt_80deg$/);
    assert.equal(PROP_DEFAULTS.maxTiltDeg, 70);
    assert.equal(slownessFromNormal([0, 1, 0], V400), null, 'a front parallel to the flow never arrives');
    assert.equal(describeSlowness(flatSlowness(V400), V400).tiltDeg, 0);
    ok('chooseSlowness: lags → (MVAB, opt-in) → flat, each labelled; a normal past 70° is refused with the reason');
}

// ── 3. arrival order ──────────────────────────────────────────────────────
{
    const t = [0, 60e3, 120e3, 180e3, 240e3];
    const o = arrivalOrder(t, [3000, 3000, 3000, 2900, NaN]);   // minute 3 arrives at 3080 s — before minute 2 (3120 s), after minute 1 (3060 s)
    assert.deepEqual(o.keep, [0, 1, 3]);
    assert.equal(o.overtaken, 1);
    assert.deepEqual(arrivalOrder(t, [3000, 3000, 3000, 2700, 2700]).keep, [3, 4], 'a fast stream overtakes everything ahead of it');
    assert.equal(o.undefinedDelay, 1);
    const same = arrivalOrder(t, [3000, 3000, 3000, 3000, 3000]);
    assert.deepEqual(same.keep, [0, 1, 2, 3, 4]);
    ok('arrivalOrder: overtaken parcels are dropped and counted; a missing delay is not an arrival');
}

// ── 4. flux ───────────────────────────────────────────────────────────────
{
    // By hand: 3.8 R_E × 400 km/s × 5 nT, due south = 3.8·6.3712e6·4e5·5e-9 V.
    close(milanRateKv(400, 0, -5), 3.8 * 6.3712e6 * 4e5 * 5e-9 / 1e3, 1e-9, 'Milan at the reference wind');
    close(milanRateKv(400, 0, -5), 48.421, 0.001);
    assert.equal(milanRateKv(400, 0, 5), 0, 'due north opens nothing');
    close(milanRateKv(400, 5, 0) / milanRateKv(400, 0, -5), Math.pow(Math.SQRT1_2, 4.5), 1e-12, 'θ = 90° ⇒ sin^(9/2)(45°)');
    close(milanRateKv(400, -5, 0), milanRateKv(400, 5, 0), 1e-12, 'By sign does not matter');
    close(milanRateKv(800, 0, -5) / milanRateKv(400, 0, -5), Math.pow(2, 4 / 3), 1e-12, 'v^(4/3) through L_eff');
    close(milanRateKv(400, 0, -10) / milanRateKv(400, 0, -5), 2, 1e-12, 'linear in B');
    assert.equal(milanRateKv(NaN, 0, -5), null);
    assert.equal(milanRateKv(400, NaN, -5), null, 'a missing component is null, never 0');
    assert.equal(milanRateKv(400, 0, 0), 0);
    assert.equal(clockAngle(0, 0), null);
    close(clockAngle(0, -1), Math.PI, 1e-12);
    assert.equal(MILAN.L0_RE, 3.8);
    ok('Milan 2012: 48.42 kV at 400 km/s, −5 nT; clock-angle, speed and field scalings exact');

    close(newellMilanEquivalentKv(REFERENCE_WIND.speedKms, REFERENCE_WIND.byNt, REFERENCE_WIND.bzNt), milanRateKv(400, 0, -5), 1e-9, 'normalised at the reference');
    close(newellMilanEquivalentKv(800, 0, -20) / milanRateKv(800, 0, -20), Math.pow(4, -1 / 3), 1e-9, 'B^(2/3) vs B¹');
    close(newellNative(400, 0, -5), Math.pow(400, 4 / 3) * Math.pow(5, 2 / 3), 1e-9);
    assert.ok(newellMilanEquivalentKv(400, 5, 0) > milanRateKv(400, 5, 0), 'Newell\'s gentler clock-angle factor gives more at θ = 90°');
    ok('Newell 2007: native units exact; scaled column equals Milan at the stated reference and differs only in form');

    const q = siscoeHillKv(400, 0, -5, 2), s = siscoeHillKv(800, 0, -40, 20), s2 = siscoeHillKv(800, 0, -80, 20);
    assert.equal(SISCOE_HILL.verified, false);
    assert.equal(q.coefficients_verified, false, 'every result says its coefficients are unverified');
    assert.ok(q.potentialKv < q.unsaturatedKv && q.potentialKv < q.saturationKv, 'below both limits');
    close(1 / q.potentialKv, 1 / q.unsaturatedKv + 1 / q.saturationKv, 1e-12, 'harmonic combination');
    assert.ok(s2.potentialKv / s.potentialKv < 1.25, 'doubling the driver under saturation adds < 25 %');
    assert.ok(s2.potentialKv < s2.saturationKv);
    assert.equal(siscoeHillKv(400, 0, -5, NaN), null);
    assert.equal(siscoeHillKv(400, 0, 5, 2).potentialKv, 0);
    ok('Siscoe–Hill form: harmonic, bounded, saturating — and flagged unverified');

    close(milanSigmaKv(400, 0, -5, 1), milanRateKv(400, 0, -1) * 1, 1e-9, 'σ for a due-south field is linear');
    assert.equal(milanSigmaKv(400, 0, -5, NaN), null, 'unknown σ is not zero σ');
    const f = openedFluxGWb([0, 60e3, 120e3, 3600e3, 3660e3], [50, 50, 50, 50, 50]);
    close(f.gwb, 50e3 * 180 / 1e9, 1e-12, '50 kV for the 180 covered seconds');
    assert.equal(f.gaps, 1, 'the 58-minute gap is counted, not integrated');
    close(openedFluxGWb(Array.from({ length: 61 }, (_, i) => i * 60e3), new Array(61).fill(50)).gwb, 0.18, 1e-12, '50 kV for an hour = 0.18 GWb');
    ok('σ propagation and ∫Φ dt: 50 kV for an hour is 0.18 GWb; a gap opens no flux');
}

// ── 5. the plasma normaliser ──────────────────────────────────────────────
{
    const rows = [
        { time_tag: '2026-11-20 12:00:00', source: 'SOLAR1', active: true, proton_speed: 412.3, proton_density: 4.8, proton_temperature: 3.1e5, proton_vx_gse: -411, proton_vy_gse: 20, proton_vz_gse: -5 },
        { time_tag: '2026-11-20 12:01:00', source: 'SOLAR1', active: true, proton_speed: -9999.9, proton_density: 0, proton_temperature: null },
        { time_tag: '2026-11-20 12:00:00', source: 'ACE', active: false, proton_speed: 405, proton_density: 5.2, proton_temperature: 9.0e4 },
    ];
    const p = normalizeL1Plasma(rows, { nowMs: Date.parse('2026-11-20T12:03:00Z') });
    assert.deepEqual(Object.keys(p.spacecraft).sort(), ['ACE', 'SOLAR1']);
    assert.equal(p.spacecraft.SOLAR1.speed_valid, 1, 'a fill value is a gap');
    assert.equal(p.spacecraft.SOLAR1.density_valid, 1, 'a zero density is a gap, not a vacuum');
    assert.equal(p.spacecraft.SOLAR1.samples[0].temperature, 3.1e5, 'a real 3e5 K is far above the field fill value and is kept');
    assert.equal(p.spacecraft.SOLAR1.samples[0].vx_gse, -411);
    assert.equal(p.spacecraft.ACE.vector_valid, 0);
    assert.deepEqual(p.vectors, { gse: true, gsm: false });
    assert.equal(p.age_s, 180, 'age is the newest VALID speed, not the newest row');
    assert.equal(p.active_spacecraft, 'SOLAR1');
    const table = normalizeL1Plasma([['time_tag', 'density', 'speed', 'temperature'], ['2026-11-20 12:00:00.000', '5.1', '398.2', '81234']], {});
    assert.equal(table.spacecraft.unknown.samples[0].speed, 398.2);
    assert.deepEqual(FEEDS['l1-plasma'].verified.vector_velocity, ['SOLAR1'], 'measured: only one spacecraft publishes velocity components');
    ok('normalizeL1Plasma: per spacecraft, fills/zeros are gaps, temperature kept, age from the newest valid speed');
}

// ── 6. the assembly on a planted tilted wind ──────────────────────────────
const NOW = Date.parse('2026-11-20T14:20:00Z');
const TILT = unitNormal(35, 10);
function build(opts = {}) {
    const f = plantedFeeds({ field: plantedField(11, 1440), normal: TILT, speedKms: 400, densityCc: 5, nowMs: opts.nowMs ?? NOW, ...opts });
    const now = opts.nowMs ?? NOW;
    return { f, mag: normalizeL1Mag(f.mag, { nowMs: now }), ephem: normalizeEphem(f.eph, { nowMs: now }), plasma: normalizeL1Plasma(f.wind, { nowMs: now }) };
}
{
    const { mag, ephem, plasma } = build();
    const a = analyzeFlux({ mag, ephem, plasma, nowMs: NOW, minutes: 240 });
    const p = a.propagation, fx = a.flux;
    assert.equal(p.from, 'SOLAR1');
    assert.equal(p.latest.method, 'multi-spacecraft-lags');
    const trueTilt = Math.acos(TILT.x) * DEG;
    close(p.latest.tilt_deg, trueTilt, 4, 'measured front tilt');
    assert.ok(Math.abs(p.latest.closure_min) < 1.5, `triangle closure ${p.latest.closure_min} min`);
    assert.ok(p.method_minutes['multi-spacecraft-lags'] > 800, 'most of the day is propagated on measured lags');

    // The delay to the bow-shock nose: truth is the plane's own arrival there.
    const row = fx.newest_arrival;
    const target = { x: row.bow_shock_nose_re, y: 0, z: 0 };
    const truth = arrivalMin(target, TILT, 400) - arrivalMin(POS.SOLAR1, TILT, 400);
    close(row.delay_min, truth, 2.0, 'phase-front delay vs the planted arrival');
    assert.ok(Math.abs(row.flat_delay_min - truth) > 6, `the flat delay (${row.flat_delay_min} min) misses the truth (${truth.toFixed(1)} min)`);
    assert.ok(row.bow_shock_nose_re > 11 && row.bow_shock_nose_re < 16);
    assert.ok(p.departure_from_flat_min.mean > 4);
    ok(`planted 36° front: delay ${row.delay_min} min vs truth ${truth.toFixed(1)}; the flat delay says ${row.flat_delay_min}`);

    // Kinds split at "now" by ARRIVAL time, and the horizon is the delay minus the data's age.
    assert.equal(fx.at_bow_shock_now.kind, 'ESTIMATED');
    assert.equal(row.kind, 'FORECAST');
    assert.ok(Date.parse(fx.at_bow_shock_now.arrives) <= NOW && Date.parse(row.arrives) > NOW);
    close(fx.forecast_horizon_min, row.delay_min - 2, 0.2, 'horizon = delay − age of the newest minute');
    const kinds = fx.trace.rows.map((r) => r[1]).join('');
    assert.match(kinds, /^E+F+$/, 'every estimate precedes every forecast');
    for (let i = 1; i < fx.trace.rows.length; i++) assert.ok(fx.trace.rows[i][0] > fx.trace.rows[i - 1][0], 'arrival-ordered');
    // The rate is Milan of the row's own inputs — nothing else slipped in.
    close(row.reconnection_rate_kv.milan2012, milanRateKv(row.speed_kms, row.by_nt, row.bz_nt), 0.6);
    assert.ok(row.reconnection_rate_kv.sigma >= 0);
    assert.equal(row.transpolar_potential_kv.coefficients_verified, false);
    assert.equal(fx.siscoe_hill_verified, false);
    assert.ok(fx.opened_last_hour.gwb > 0 && fx.opened_last_hour.covered_min > 50);
    assert.equal(a.plasma.is_reference, true);
    assert.ok(JSON.stringify({ ...a, trace: null, spectrum: null, flux: { ...fx, trace: null } }).length < 8000);
    ok('kinds split by arrival time (E…F), horizon = delay − age, rate = Milan of the row\'s own inputs');
}
{
    // An untilted front: the method may still be the lags, but the delay must equal the flat one.
    const { mag, ephem, plasma } = build({ normal: unitNormal(0) });
    const a = analyzeFlux({ mag, ephem, plasma, nowMs: NOW });
    const row = a.flux.newest_arrival;
    close(row.delay_min, row.flat_delay_min, 2.5, 'no tilt ⇒ no departure from the flat delay');
    ok('untilted front: the phase-front delay agrees with the flat delay');
}
{
    // Plasma only on ANOTHER spacecraft: used, and disclosed.
    const { mag, ephem, plasma } = build({ plasmaFor: ['ACE'] });
    const a = analyzeFlux({ mag, ephem, plasma, nowMs: NOW });
    assert.equal(a.plasma.spacecraft, 'ACE');
    assert.equal(a.plasma.is_reference, false);
    assert.ok(a.flux.newest_arrival.reconnection_rate_kv.milan2012 != null);

    // No plasma at all: the fused field survives, flux and propagation do not, and nothing nominal is substituted.
    const none = analyzeFlux({ mag, ephem, plasma: null, nowMs: NOW });
    assert.equal(none.flux, null);
    assert.equal(none.propagation, null);
    assert.deepEqual(none.reasons, ['no_plasma']);
    assert.ok(none.latest.bz_nt != null);

    // No ephemerides: no positions ⇒ no delay ⇒ nothing arrives.
    const noEph = analyzeFlux({ mag, ephem: null, plasma, nowMs: NOW });
    assert.equal(noEph.flux.newest_arrival, null);
    assert.equal(noEph.flux.at_bow_shock_now, null);
    assert.equal(analyzeFlux({ mag: normalizeL1Mag([], {}), nowMs: NOW }), null);
    ok('plasma from another spacecraft is disclosed; no plasma ⇒ no rate; no positions ⇒ no arrival');
}

// ── 7. the route ──────────────────────────────────────────────────────────
{
    const src = readFileSync(join(ROOT, 'api', 'bz', 'flux.js'), 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/js\/bz\/flux-analysis\.js'/);
    assert.ok(!/jsonError\('upstream_unavailable'/.test(src));
    const real = globalThis.fetch;
    try {
        const { default: handler } = await import('../api/bz/flux.js');
        const live = build({ nowMs: Date.now() }).f;
        const serve = (omit = []) => async (u) => {
            const s = String(u);
            if (s.includes('rtsw_mag_1m') && !omit.includes('mag')) return Response.json(live.mag);
            if (s.includes('rtsw_wind_1m') && !omit.includes('wind')) return Response.json(live.wind);
            if (s.includes('ephemerides') && !omit.includes('eph')) return Response.json(live.eph);
            return new Response('no', { status: 404 });
        };
        globalThis.fetch = serve();
        const full = await (await handler(new Request('https://x.test/api/bz/flux?minutes=30'))).json();
        assert.equal(full.freshness, 'fresh');
        assert.equal(full.data.flux.trace.rows.length, 30);
        assert.equal(full.data.trace, undefined, 'the L1 trace stays on /api/bz/l1');
        assert.equal(full.plasma_feed.source_id, 'rtsw-wind-1m');
        assert.equal(full.plasma_feed.spacecraft.SOLAR1.speed_valid, 1440);
        const sum = await (await handler(new Request('https://x.test/api/bz/flux?summary=1'))).json();
        assert.equal(sum.data.flux.trace, undefined);
        assert.ok(sum.data.flux.at_bow_shock_now.reconnection_rate_kv.milan2012 != null);

        globalThis.fetch = serve(['wind']);
        const noWind = await (await handler(new Request('https://x.test/api/bz/flux?summary=1'))).json();
        assert.equal(noWind.freshness, 'stale');
        assert.deepEqual(noWind.reasons, ['no_plasma']);
        assert.equal(noWind.data.flux, null);
        assert.ok(noWind.plasma_feed.candidates.every((c) => !c.ok), 'the plasma candidates are reported when none answers');
        assert.equal(sum.data.propagation.mvab_check === null || sum.data.propagation.mvab_check.n > 0, true);

        globalThis.fetch = serve(['eph']);
        const noEph = await (await handler(new Request('https://x.test/api/bz/flux?summary=1'))).json();
        assert.equal(noEph.freshness, 'stale');
        assert.deepEqual(noEph.reasons, ['ephemerides_unavailable', 'nothing_has_arrived_yet']);

        globalThis.fetch = serve(['mag']);
        const dead = await handler(new Request('https://x.test/api/bz/flux'));
        assert.equal(dead.status, 200);
        assert.equal((await dead.json()).freshness, 'expired');
    } finally { globalThis.fetch = real; }
    ok('route: full + summary; plasma or ephemerides down ⇒ stale with the reason; magnetometers down ⇒ expired');
}

console.log(`\nbz-flux: ${checks} checks passed`);
