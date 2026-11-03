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
import { rowToRecord } from '../js/neo-orbits.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

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
    const recs = fx.rows.map(rowToRecord);
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
    console.log(`  real fixture: ${recs.length} rows @ JD ${epoch}; Standish−Horizons Δλ_J = ${T.wrap180(std.lambda - pert.jupiter.el.lambda).toFixed(3)}°`);
} else {
    console.log('  (no real-data fixture yet — tests/fixtures/trojans/trojans-sample.json)');
}

console.log('trojan-dynamics: elements, theory pins, integrator-vs-invariant, classifier, sizes passed');
