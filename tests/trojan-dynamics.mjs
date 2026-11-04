/**
 * Gate for js/trojan-dynamics.js.
 *
 * Every assertion is against THEORY or an IDENTITY, never against a number
 * this kernel produced on a previous run:
 *   - state ↔ elements round-trips (and λ survives e → 0, i → 0)
 *   - the co-orbital potential's minimum sits at 60° and the separatrix's
 *     near turning point is Murray & Dermott's 23.9°
 *   - small-amplitude libration period T = P/√(27μ/4) ≈ 148 yr
 *   - in the circular restricted problem (the one the invariant is derived
 *     in) the INTEGRATOR's measured tadpole matches the ANALYTIC turning
 *     points, and its period lengthens with amplitude, as theory says
 *   - a particle placed on L3 (beyond the separatrix) horseshoes; one at
 *     Jupiter's own a but 1.2 AU off circulates or meets Jupiter
 *   - the regime classifier on synthetic φ series with known answers
 *   - REAL DATA (tests/fixtures/trojans/*): the Standish fallback agrees with
 *     Horizons' osculating Jupiter to well inside the libration amplitudes
 *     it would be used to measure, and well-established camp memberships
 *     come out right
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as T from '../js/trojan-dynamics.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
import { naff as naffRaw } from '../js/frequency-analysis.js';
/** Amplitude of the single strongest real-signal line near ω (the definition the cluster replaces). */
function naffSingle(sig, dt, omega) {
    const mean = sig.reduce((a, b) => a + b, 0) / sig.length;
    const t = naffRaw(Float64Array.from(sig, v => v - mean), null, dt, { terms: 1 });
    return 2 * t[0].amp;
}

// ── Elements ↔ state ────────────────────────────────────────────────────────
{
    for (const el of [
        { a: 5.21, e: 0.08, i: 12.3, om: 33.4, w: 211.1, M: 77.7 },
        { a: 5.18, e: 0.15, i: 31.0, om: 280.0, w: 10.0, M: 300.0 },
        { a: 5.20, e: 0.001, i: 0.0005, om: 10, w: 20, M: 30 },
    ]) {
        const s = T.stateFromElements(el);
        const b = T.elementsFromState(s.r, s.v);
        near(b.a, el.a, 1e-10, 'a round-trip');
        near(b.e, el.e, 1e-10, 'e round-trip');
        near(b.i, el.i, 1e-9, 'i round-trip');
        near(T.wrap180(b.lambda - (el.om + el.w + el.M)), 0, 1e-7, 'λ round-trip (defined even as e, i → 0)');
    }
    assert.equal(T.wrap180(180), 180); assert.equal(T.wrap180(-180), 180); assert.equal(T.wrap180(-190), 170); assert.equal(T.wrap180(721), 1);
}

// ── Theory pins ─────────────────────────────────────────────────────────────
{
    near(T.coorbitalPotential(60), 0.5, 1e-12, 'F(60°) = 1/2');
    near(T.coorbitalPotential(180), 1.5, 1e-12, 'F(180°) = 3/2');
    for (const d of [-3, -0.5, 0.5, 3]) assert.ok(T.coorbitalPotential(60 + d) > 0.5, 'L4 is the minimum');
    near(T.separatrixMinAngle(), 23.9, 0.05, 'separatrix near turning point (Murray & Dermott 1999 §3.9)');
    near(T.smallAmplitudePeriodDays() / T.JULIAN_YEAR_D, 147.8, 0.5, 'T = P/√(27μ/4)');
    near(T.MU_JUPITER, 9.5388e-4, 1e-7, 'μ');
    near(T.HILL_RADIUS_AU, 0.355, 0.001, 'Jupiter Hill radius');
    const lib = T.analyticLibration(5.2, 5.2, 60);
    near(lib.amplitude, 0, 1e-6, 'a body AT L4 has zero amplitude');
    const sym = [T.analyticLibration(5.21, 5.2, 50), T.analyticLibration(5.21, 5.2, -50)];
    near(sym[0].amplitude, sym[1].amplitude, 1e-12, 'L4/L5 symmetry'); assert.equal(sym[1].camp, 'L5');
    assert.equal(T.analyticLibration(5.2, 5.2, 175).regime, 'tadpole');
    assert.equal(T.analyticLibration(5.2, 5.2, 179.9).regime, 'tadpole');
    assert.equal(T.analyticLibration(5.2 * 1.01, 5.2, 180).regime, 'beyond-separatrix');
}

// ── Integrator vs the analytic invariant (circular restricted problem) ──────
{
    const aJ = 5.2;
    const jupiter = { ...T.stateFromElements({ a: aJ, e: 0, i: 0, om: 0, w: 0, M: 0 }, T.planetGm('jupiter')), m: T.M_JUPITER, source: 'test' };
    const steps = Math.ceil(700 * T.JULIAN_YEAR_D / 20);
    const track = T.planetTrack({ jupiter, saturn: null }, steps, 20, { useSaturn: false, circularJupiter: true });
    const jel = T.elementsFromState(jupiter.r, jupiter.v, T.planetGm('jupiter'));
    const periods = [];
    for (const dphi of [5, 15, 25, 35]) {
        const st = T.stateFromElements({ a: aJ, e: 0, i: 0, om: 0, w: 0, M: 60 + dphi });
        const num = T.integrateParticle(st, track, { dtDays: 20, sampleDays: 73 });
        const el = T.elementsFromState(st.r, st.v);
        const ana = T.analyticLibration(el.a, jel.a, T.wrap180(el.lambda - jel.lambda));
        assert.equal(num.regime, 'L4', `Δφ ${dphi}: tadpole about L4`);
        near(num.phiMin, ana.phiMin, 0.3, `Δφ ${dphi}: near turning point`);
        near(num.phiMax, ana.phiMax, 0.3, `Δφ ${dphi}: far turning point`);
        near(num.amplitude, ana.amplitude, 0.25, `Δφ ${dphi}: amplitude`);
        periods.push(num.periodYears);
    }
    near(periods[0], 147.8, 2, 'small-amplitude period');
    for (let k = 1; k < periods.length; k++) assert.ok(periods[k] > periods[k - 1], 'period lengthens with amplitude');
    // Mirror: L5 tadpole
    const l5 = T.integrateParticle(T.stateFromElements({ a: aJ, e: 0, i: 0, om: 0, w: 0, M: -75 }), track, { dtDays: 20, sampleDays: 73 });
    assert.equal(l5.regime, 'L5');
    near(l5.phiMax, -47.8, 0.3, 'L5 mirror of the 15° case (its near turning point is 47.8°)');
    near(l5.phiMin, -75.0, 0.3, 'L5 far turning point is the start');
    // Beyond the separatrix: start just outside L3 — a horseshoe.
    const hs = T.integrateParticle(T.stateFromElements({ a: aJ * 1.0006, e: 0, i: 0, om: 0, w: 0, M: 180 }), track, { dtDays: 20, sampleDays: 73 });
    assert.equal(hs.regime, 'horseshoe', `L3 start horseshoes (got ${hs.regime}, φ ${hs.phiMin}…${hs.phiMax})`);
    // Far from co-orbital: drifts through 360° (or meets Jupiter).
    const circ = T.integrateParticle(T.stateFromElements({ a: aJ + 1.2, e: 0.05, i: 3, om: 0, w: 0, M: 60 }), track, { dtDays: 20, sampleDays: 73 });
    assert.ok(['circulating', 'encounter'].includes(circ.regime), `a = 6.4 AU is not co-orbital (got ${circ.regime})`);
}

// ── The classifier on synthetic series ──────────────────────────────────────
{
    const series = (f, n = 400) => Float64Array.from({ length: n }, (_, k) => f(k));
    const s1 = T.summarisePhi(series(k => 60 + 20 * Math.sin(2 * Math.PI * k / 150)), { sampleYears: 1 });
    assert.equal(s1.regime, 'L4'); near(s1.amplitude, 20, 0.05, 'synthetic amplitude'); near(s1.periodYears, 150, 1, 'synthetic period');
    assert.equal(T.summarisePhi(series(k => -60 + 30 * Math.sin(k / 20)), { sampleYears: 1 }).regime, 'L5');
    // A tadpole that straddles the ±180 wrap in the unwrapped frame (L5 seen from +300°).
    assert.equal(T.summarisePhi(series(k => 300 + 20 * Math.sin(k / 20)), { sampleYears: 1 }).regime, 'L5');
    assert.equal(T.summarisePhi(series(k => 180 + 150 * Math.sin(k / 30)), { sampleYears: 1 }).regime, 'horseshoe');
    assert.equal(T.summarisePhi(series(k => k * 2), { sampleYears: 1 }).regime, 'circulating');
    assert.equal(T.summarisePhi(series(k => 60), { sampleYears: 1, encounterYear: 12 }).regime, 'encounter');
}

// ── Sizes ───────────────────────────────────────────────────────────────────
{
    assert.deepEqual(T.trojanDiameterKm({ diam: 225, H: 7.2 }), { km: 225, basis: 'measured' });
    const pop = T.trojanDiameterKm({ H: 10, diam: null, albedo: null });
    assert.equal(pop.basis, 'H+population-albedo');
    near(pop.km, 1329 / Math.sqrt(0.07) * 0.01, 1e-9, 'D = 1329/√0.07 · 10^(−H/5)');
    assert.equal(T.trojanDiameterKm({ H: 10, albedo: 0.05 }).basis, 'H+measured-albedo');
    assert.equal(T.trojanDiameterKm({ H: null }).km, null);
    const r = T.campRatio(1000, 600);
    near(r.ratio, 1000 / 600, 1e-12, 'ratio'); assert.ok(r.lo < r.ratio && r.ratio < r.hi);
}

// ── Proper elements by frequency analysis (synthetic, known answers) ────────
{
    const mu = T.MU_JUPITER, D = 10, omega = 2 * Math.PI / 150, Os = 2 * Math.PI / 3800, beta = 0.4;
    const make = (years, dt) => {
        const n = Math.floor(years / dt) + 1, phi = new Float64Array(n), x = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            const t = k * dt, th = omega * t + beta * Math.sin(Os * t);
            phi[k] = 60 + D * Math.cos(th);
            x[k] = Math.sqrt(3 * mu) * (D * Math.PI / 180) * Math.sin(th);
        }
        return { phi, x, dt };
    };
    // The secular cycle frequency-modulates the libration: the cluster
    // amplitude must not depend on whether the f ± g sidebands are resolved.
    const short = make(600, 1), long = make(20000, 5);
    const ps = T.properLibration(short.phi, short.x, 1), pl = T.properLibration(long.phi, long.x, 5);
    assert.ok(ps.ok && pl.ok);
    near(ps.D, D, 0.15, 'D_p, sidebands unresolved (600 yr)');
    near(pl.D, D, 0.05, 'D_p, sidebands resolved (20 kyr)');
    near(pl.f, omega * 180 / Math.PI, 1e-3, 'libration frequency (deg/yr)');
    near(pl.da, 5.2029 * Math.sqrt(3 * mu) * D * Math.PI / 180, 2e-4, 'da_p = a_J·√(3μ)·D (the small-amplitude identity)');
    // NEGATIVE CONTROL: a single-line amplitude in the long record is the
    // carrier alone, D·J₀(β) — the run-length drift the cluster removes.
    const J0 = 1 - beta ** 2 / 4 + beta ** 4 / 64;
    const single = naffSingle(long.phi, 5, omega);
    near(single, D * J0, 0.05, `single-line amplitude falls to D·J₀(β) = ${(D * J0).toFixed(3)}`);
    assert.ok(Math.abs(single - D) > 0.3, 'and is visibly short of D');
    const tooShort = T.properLibration(make(200, 1).phi, make(200, 1).x, 1);
    assert.equal(tooShort.ok, false); assert.match(tooShort.reason, /libration cycles/);
}
{
    // Secular: forced line at Jupiter's g5, free line at g, plus the two
    // impostors the first implementation reported (Jupiter's orbital line and
    // the libration coupling).
    const ARC = 180 / Math.PI * 3600, g5 = 4.25 / ARC, g = 340 / ARC, fLib = 2.4 * Math.PI / 180;
    const make = (years, dt, Af = 0.04, Ae = 0.08) => {
        const n = Math.floor(years / dt) + 1, re = new Float64Array(n), im = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            const t = k * dt;
            for (const [A, nu] of [[Af, g5], [Ae, g], [0.003, 2 * Math.PI / 11.86], [0.002, 8300 / ARC]]) { re[k] += A * Math.cos(nu * t); im[k] += A * Math.sin(nu * t); }
        }
        return { re, im };
    };
    const opts = { maxNu: fLib * T.PROPER.secularBandOfLibration, minSpanYears: T.PROPER.secularMinSpanYears.e };
    const ok = make(20000, 5); const r = T.properSecular(ok.re, ok.im, [g5], 5, opts);
    assert.ok(r.ok, r.reason); near(r.amp, 0.08, 1e-3, 'free e'); near(r.arcsecPerYr, 340, 1, 'free g (arcsec/yr)');
    const short = make(3000, 1); const rs = T.properSecular(short.re, short.im, [g5], 1, opts);
    assert.equal(rs.ok, false, 'a 3 000-yr record cannot resolve g ≈ 340″/yr'); assert.equal(rs.needYears, 18000);
    // NEGATIVE CONTROL: without the band limit and span gate the impostors win.
    const unguarded = T.properSecular(short.re, short.im, [g5], 1, {});
    assert.ok(!unguarded.ok || Math.abs(unguarded.arcsecPerYr - 340) > 100, 'unguarded extraction does not find the true line in 3 000 yr');
    // A STRONG forced line sitting on Jupiter's own frequency is explained and
    // must not block a small, cleanly resolved free line.
    const big = make(20000, 5, 0.5, 0.01); const ra = T.properSecular(big.re, big.im, [g5], 5, opts);
    assert.ok(ra.ok, `a forced line on g5 is skipped, not ambiguous (${ra.reason})`); near(ra.amp, 0.01, 5e-4, 'small free e beside a big forced one');
    // An UNEXPLAINED near-forced line (a fused blob ~1 bin off every forced
    // frequency) that dwarfs the candidate → ambiguous, withheld.
    {
        const n = 4001, re = new Float64Array(n), im = new Float64Array(n), blob = 1.2 * (2 * Math.PI / 20000);
        for (let k = 0; k < n; k++) { const t = k * 5; for (const [A, nu] of [[0.3, blob], [0.02, g]]) { re[k] += A * Math.cos(nu * t); im[k] += A * Math.sin(nu * t); } }
        const rb = T.properSecular(re, im, [g5], 5, opts);
        assert.equal(rb.ok, false); assert.match(rb.reason, /^ambiguous/);
    }
}

// ── Orbit quality (the ONE rule) and the dynamics artifact codec ────────────
{
    assert.equal(T.orbitQuality({ cc: '0', arc_d: 43526 }, 'epoch'), 'well-determined');
    assert.equal(T.orbitQuality({ cc: '6', arc_d: 43526 }, 'epoch'), 'short-arc', 'U ≥ 6');
    assert.equal(T.orbitQuality({ cc: '0', arc_d: 200 }, 'epoch'), 'short-arc', 'arc < 1 yr');
    assert.equal(T.orbitQuality({ cc: '0', arc_d: 9000 }, 'n-body'), 'short-arc', 'off the shared epoch');
    assert.equal(T.orbitQuality({}, 'epoch'), 'unknown');
    assert.equal(T.orbitQuality({ cc: 0, arc_d: '400' }, 'epoch'), 'well-determined', 'numeric/string tolerant');

    const analysed = [
        { des: '624', phi: 72.31, diameterKm: 225, sizeBasis: 'measured', alignMethod: 'epoch', rec: { cc: '0', arc_d: 43526 } },
        { des: '2014 EL58', phi: 97.28, diameterKm: 6.234, sizeBasis: 'H+population-albedo', alignMethod: 'n-body', rec: { cc: '9', arc_d: 3 } },
    ];
    const results = [
        { regime: 'L4', amplitude: 19.34, periodYears: 155.8, phiMean: 62.7, phiMin: 42.61, phiMax: 81.22, aMean: 5.20712, eMean: 0.01534, iMean: 18.21,
          proper: { ok: true, D: 18.9512, f: 2.31744 }, properE: { ok: false }, properI: { ok: false } },
        { regime: 'encounter', amplitude: 120.1, periodYears: null, phiMean: 90, phiMin: 30, phiMax: 150, aMean: 4.97, eMean: 0.12, iMean: 9.3 },
    ];
    const doc = T.encodeDynamics(analysed, results, { generated_at: 'x' });
    assert.equal(doc.format, T.DYNAMICS_FORMAT);
    assert.deepEqual(Object.keys(doc.data), [...T.DYNAMICS_COLUMNS], 'columnar');
    const back = JSON.parse(JSON.stringify(doc));
    const o = T.decodeDynamics(back);
    assert.equal(o.length, 2);
    assert.deepEqual(o[0], { des: '624', regime: 'L4', amp: 19.3, period: 156, phi_mean: 62.7, phi_min: 42.6, phi_max: 81.2,
        a_mean: 5.2071, e_mean: 0.015, i_mean: 18.2, diam: 225, size: 'measured', quality: 'well-determined', phi0: 72.3,
        D_p: 18.95, f_lib: 2.3174, e_p: null, g: null, sinI_p: null, s: null });
    assert.equal(o[1].regime, 'encounter'); assert.equal(o[1].period, null); assert.equal(o[1].diam, 6.2, 'small bodies keep a decimal');
    assert.equal(o[1].quality, 'short-arc');
    assert.throws(() => T.encodeDynamics([analysed[0]], [{ ...results[0], regime: 'trojan' }]), /unknown regime/);
    assert.throws(() => T.decodeDynamics({ format: 'nope' }), /expected trojan-dynamics-v1/);
}

// ── Real data (baked from production; see the fixture's provenance block) ───
const FIX = new URL('./fixtures/trojans/trojans-sample.json', import.meta.url);
if (existsSync(FIX)) {
    const fx = JSON.parse(readFileSync(FIX, 'utf8'));
    const epoch = fx.epoch.epoch;
    const pert = T.perturberStates(fx.perturbers, epoch);
    assert.equal(pert.jupiter.source, 'horizons');
    const std = T.standishElements('jupiter', epoch);
    near(T.wrap180(std.lambda - pert.jupiter.el.lambda), 0, 0.5, 'Standish mean λ_J vs Horizons osculating λ_J');
    near(std.a, pert.jupiter.el.a, 0.05, 'Standish a_J vs osculating a_J');
    const fallback = T.perturberStates({}, epoch);
    assert.equal(fallback.jupiter.source, 'standish-mean');
    // Camp memberships that are not in dispute (Lucy mission targets + the
    // two "spies" each named for the other side, and the first Trojan found).
    const KNOWN = { '624': 'L4', '588': 'L4', '3548': 'L4', '15094': 'L4', '11351': 'L4', '21900': 'L4', '617': 'L5', '1172': 'L5' };
    const recs = T.recordsFromCatalog(fx);   // the fixture is the ORIGINAL row shape
    // The lean wire must decode to the same records (round trip on REAL rows).
    {
        const lean = { format: T.TROJAN_WIRE_FORMAT, columns: [...T.TROJAN_WIRE_COLUMNS], epoch: fx.epoch,
            rows: T.encodeCatalogRows(recs, fx.epoch.epoch) };
        assert.deepEqual(T.recordsFromCatalog(lean).map(r => ({ ...r, tp: null })), recs.map(r => ({ ...r, tp: null })), 'trojan-v2 round trip on real rows');
    }
    let checked = 0;
    for (const [des, camp] of Object.entries(KNOWN)) {
        const rec = recs.find(r => r.des === des);
        if (!rec) continue;
        const an = T.analyseRecord(rec, pert.jupiter, epoch);
        assert.equal(an.camp, camp, `${rec.name}: ${camp}`);
        assert.ok(Math.abs(an.phi) > 20 && Math.abs(an.phi) < 120, `${rec.name}: φ ${an.phi} in a tadpole window`);
        checked++;
    }
    assert.ok(checked >= 6, `fixture carries the known-camp objects (${checked})`);
    // Integrated measurement on the real sample: every known-camp object librates in its camp.
    const sample = recs.filter(r => KNOWN[r.des]);
    const parts = sample.map(r => { const at = T.elementsAtEpoch(r, epoch); return T.stateFromElements(at.el); });
    const run = T.integrateSwarm(parts, pert, { years: 320 });
    sample.forEach((r, k) => {
        assert.equal(run.results[k].regime, KNOWN[r.des], `${r.name}: integrated regime`);
        near(run.results[k].periodYears ?? 150, 150, 25, `${r.name}: libration period`);
    });
    // EPOCH ALIGNMENT. Plant Hektor 12 yr in the past by integrating it
    // BACKWARDS with the planets, publish that as an old-epoch record, and
    // align it forward again: N-body must recover the join state; the old
    // two-body advance (the negative control) must not.
    {
        const hek = recs.find(r => r.des === '624');
        const s0 = T.stateFromElements(T.elementsAtEpoch(hek, epoch).el);
        const old = epoch - 4480;
        const n = Math.ceil(4480 / 20), h = -4480 / n;
        const back = T.integrateParticle(s0, T.planetTrack(pert, n, h), { dtDays: h, sampleDays: Infinity, returnState: true });
        const oe = T.elementsFromState(back.state.r, back.state.v);
        const planted = { ...hek, des: 'planted', a: oe.a, e: oe.e, i: oe.i, om: oe.om, w: oe.w, ma: oe.M, epoch: old };
        const [nb] = T.alignToEpoch([planted], pert, epoch);
        assert.equal(nb.method, 'n-body');
        const err = Math.hypot(...nb.state.r.map((x, k) => x - s0.r[k]));
        assert.ok(err < 1e-5, `N-body alignment recovers the planted state (${err} AU)`);
        const tb = T.stateFromElements(T.elementsAtEpoch(planted, epoch).el);
        const errTb = Math.hypot(...tb.r.map((x, k) => x - s0.r[k]));
        assert.ok(errTb > 0.05, `negative control: a 12-yr two-body advance is visibly wrong (${errTb.toFixed(3)} AU)`);
        const near0 = T.alignToEpoch([{ ...hek, epoch: epoch - 10, ma: hek.ma - 10 * 0.083 }], pert, epoch)[0];
        assert.equal(near0.method, 'two-body', 'within ALIGN_TWO_BODY_MAX_DAYS stays two-body');
        console.log(`  alignment: N-body ${err.toExponential(1)} AU vs two-body ${errTb.toFixed(3)} AU after 12.3 yr`);
    }
    // STEP CONVERGENCE on real Trojans: the default step must agree with a
    // 4× finer one. This is what licenses SWARM_RUN.dtDays (see its header).
    {
        const fine = T.integrateSwarm(parts, pert, { years: 320, dtDays: T.SWARM_RUN.dtDays / 4 }).results;
        const coarse = T.integrateSwarm(parts, pert, { years: 320 }).results;
        coarse.forEach((r, k) => {
            assert.equal(r.regime, fine[k].regime, `${sample[k].name}: regime step-independent`);
            near(r.amplitude, fine[k].amplitude, 0.05, `${sample[k].name}: amplitude converged at ${T.SWARM_RUN.dtDays} d`);
        });
    }
    // PROPER ELEMENTS ON REAL TROJANS vs AstDyS (Jun 2024 synthetic proper
    // elements; the six rows are REAL, captured from production — see
    // tests/fixtures/trojans/astdys-tro-head.syn).
    {
        const { parseSyn } = await import('../api/_lib/astdys-proper.js');
        const ast = Object.fromEntries(parseSyn(readFileSync(new URL('./fixtures/trojans/astdys-tro-head.syn', import.meta.url), 'utf8')).rows.map(r => [r.des, r]));
        const both = recs.filter(r => ast[r.des]);
        assert.ok(both.length >= 3, `fixture overlaps AstDyS head (${both.length})`);
        const st = both.map(r => T.stateFromElements(T.elementsAtEpoch(r, epoch).el));
        const r600 = T.integrateSwarm(st, pert, { years: 600 }).results;
        const r3k = T.integrateSwarm(st, pert, { years: 3000 }).results;
        let halfRangeDrift = 0;
        both.forEach((r, k) => {
            const a = ast[r.des];
            near(r600[k].proper.D, a.D, 0.35, `${r.name}: D_p (600 yr) vs AstDyS`);
            near(r600[k].proper.da, a.da, 0.0015, `${r.name}: da_p vs AstDyS`);
            near(r600[k].proper.f, a.f, 0.05, `${r.name}: f vs AstDyS`);
            near(r3k[k].proper.D, r600[k].proper.D, 0.15, `${r.name}: D_p is run-length stable (600 → 3 000 yr)`);
            halfRangeDrift = Math.max(halfRangeDrift, Math.abs(r3k[k].amplitude - r600[k].amplitude));
            assert.equal(r600[k].properE.ok, false, 'e_p withheld below its resolvable span');
        });
        assert.ok(halfRangeDrift > 0.4, `NEGATIVE CONTROL: the min/max half-range DOES drift with run length (${halfRangeDrift.toFixed(2)}°)`);
        // e_p and g need ~18 kyr; three objects keep the gate to a few seconds.
        const pick = both.slice(0, 3);
        const r20 = T.integrateSwarm(pick.map(r => T.stateFromElements(T.elementsAtEpoch(r, epoch).el)), pert, { years: 20000 }).results;
        pick.forEach((r, k) => {
            const a = ast[r.des], e = r20[k].properE;
            assert.ok(e.ok, `${r.name}: e_p resolved at 20 kyr (${e.reason})`);
            near(e.amp, a.e, 0.002, `${r.name}: e_p vs AstDyS`);
            near(e.arcsecPerYr, a.g, 2, `${r.name}: g vs AstDyS (″/yr)`);
            near(r20[k].proper.D, a.D, 0.35, `${r.name}: D_p (20 kyr) vs AstDyS`);
            assert.equal(r20[k].properI.ok, false, 'sin I_p withheld below 250 kyr');
        });
        console.log(`  proper vs AstDyS: ${both.map((r, k) => `${r.des} D ${r600[k].proper.D.toFixed(2)}/${ast[r.des].D}`).join(' · ')}`);
    }
    console.log(`  real fixture: ${recs.length} rows @ JD ${epoch}; Standish−Horizons Δλ_J = ${T.wrap180(std.lambda - pert.jupiter.el.lambda).toFixed(3)}°`);
} else {
    console.log('  (no real-data fixture yet — tests/fixtures/trojans/trojans-sample.json)');
}

console.log('trojan-dynamics: elements, theory pins, integrator-vs-invariant, classifier, sizes passed');
