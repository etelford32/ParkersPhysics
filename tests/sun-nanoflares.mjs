/**
 * tests/sun-nanoflares.mjs — pins the nanoflare population in js/sun-nanoflares.js
 *
 *   node tests/sun-nanoflares.mjs
 *
 * Gates:
 *   • the sampler ACTUALLY produces the α it is asked for — the slope is
 *     measured back out of a large draw, not trusted
 *   • the α = 2 threshold behaves the way Hudson (1991) says: below it the
 *     energy budget sits with the large events, above it with the small ones,
 *     and the crossing is exactly at 2
 *   • the closed-form mean energy agrees with a Monte-Carlo mean of the
 *     sampler (the two are written independently and must not drift)
 *   • α = 1 and α = 2 are removable singularities, not NaN
 *   • the heating budget is normalised to Withbroe & Noyes (1977) at ALPHA_NORM
 *   • the log2 packing the shader consumes round-trips
 *   • duration–energy scaling is monotone with the stated exponent
 *   • autoRange fits the range the SAMPLE spans (a power-law index is scale
 *     invariant, so this is legitimate — and it is what stops the SOC grid's
 *     stress-unit events pinning α at the search bound)
 *   • the KS guard refuses a log-normal, and a fit at the search bound is
 *     reported as one instead of being quoted
 *   • the MLE recovers the planted α from the sampler, and the sliding-window
 *     monitor tracks a population whose index CHANGES (the SOC driver's α is
 *     emergent, so the page measures it rather than setting it)
 */
import assert from 'node:assert/strict';
import {
    E_MIN_ERG, E_MAX_ERG, HEATING_REQUIREMENT, ALPHA_NORM, ALPHA_REFERENCES,
    DURATION_BETA, DURATION_REF_S, E_DUR_REF,
    sampleEnergy, energyFractionBelow, meanEnergy, durationFor,
    heatingFlux, rateForFlux, nanoflareState, nanoflareLabel, nanoflareUniform,
    fitAlphaMLE, AlphaMonitor,
} from '../js/sun-nanoflares.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-nanoflares.mjs');

/** Deterministic uniform stream — no ambient randomness in a gate. */
function lcg(seed = 20260909) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Recover α from a draw by fitting the survival function.
 * For dN/dE ∝ E^−α on [eMin, eMax], the number of events above E goes as
 * N(>E) ∝ E^(1−α) − eMax^(1−α); well below eMax the second term is negligible,
 * so log N(>E) vs log E is a straight line of slope (1−α). Fitting the
 * SURVIVAL function rather than a histogram avoids binning bias, which is the
 * classic way a power-law index gets measured wrong.
 */
function fitAlpha(samples, loDecade, hiDecade) {
    const sorted = [...samples].sort((a, b) => a - b);
    const N = sorted.length;
    const xs = [], ys = [];
    for (let d = loDecade; d <= hiDecade; d += 0.25) {
        const E = Math.pow(10, d);
        // count above E
        let lo = 0, hi = N;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < E) lo = m + 1; else hi = m; }
        const above = N - lo;
        if (above < 40) break;
        xs.push(Math.log10(E));
        ys.push(Math.log10(above));
    }
    assert.ok(xs.length >= 5, `enough points to fit (${xs.length})`);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return 1 - num / den;                                     // slope = 1 − α
}

ok('the sampler produces the α it is asked for (slope measured back out of 400k draws)', () => {
    for (const want of [1.6, 1.8, 2.0, 2.3, 2.6]) {
        const rnd = lcg(7 + Math.round(want * 100));
        const s = new Array(400000);
        for (let i = 0; i < s.length; i++) s[i] = sampleEnergy(rnd(), want);
        // Fit over the middle of the range, away from both bounds where the
        // finite upper cutoff bends the survival function by construction.
        const got = fitAlpha(s, 23.4, 25.6);
        assert.ok(Math.abs(got - want) < 0.06, `α ${want} → fitted ${got.toFixed(3)}`);
    }
});

ok('samples stay inside [E_MIN, E_MAX] for every α, including the u→1 edge', () => {
    for (const a of [1.2, 1.5, 2.0, 2.5, 3.0]) {
        for (const u of [0, 1e-9, 0.5, 1 - 1e-9, 1]) {
            const E = sampleEnergy(u, a);
            assert.ok(Number.isFinite(E), `finite at α=${a}, u=${u}`);
            assert.ok(E >= E_MIN_ERG * (1 - 1e-9) && E <= E_MAX_ERG * (1 + 1e-9),
                `α=${a} u=${u} → ${E}`);
        }
    }
    assert.ok(sampleEnergy(0, 2.0) <= E_MIN_ERG * 1.000001, 'u=0 is the low bound');
});

ok('α = 1 is the removable singularity (log-uniform), not a 0/0', () => {
    const E = sampleEnergy(0.5, 1.0);
    assert.ok(Number.isFinite(E));
    // Log-uniform ⇒ the median is the geometric mean of the bounds.
    assert.ok(Math.abs(Math.log10(E) - (23 + 27) / 2) < 1e-9, `median ${E}`);
    assert.ok(Number.isFinite(meanEnergy(1.0)));
});

ok('THE α=2 THRESHOLD: below it the big events carry the energy, above it the small ones, crossing exactly at 2', () => {
    // Half the four-decade range in log terms is 10²⁵.
    const at = (a) => energyFractionBelow(1e25, a);
    // Over four decades the split is symmetric about α = 2: at 2 ∓ 0.4 the
    // minority side carries ~14 % of the budget. (Closed form: with q = 2 − α,
    // the fraction is (10^25q − 10^23q)/(10^27q − 10^23q) = 0.137 at α = 1.6.)
    assert.ok(at(1.6) < 0.20, `α=1.6 puts ${(at(1.6) * 100).toFixed(1)}% below 10²⁵ — big events carry the rest`);
    assert.ok(at(2.4) > 0.80, `α=2.4 puts ${(at(2.4) * 100).toFixed(1)}% below 10²⁵ — small events dominate`);
    assert.ok(Math.abs(at(1.6) + at(2.4) - 1) < 0.01, 'the split is symmetric about α = 2');
    // At α = 2 the energy per logarithmic interval is flat, so exactly half the
    // budget sits in each half of the range. This is the crossing.
    assert.ok(Math.abs(at(2.0) - 0.5) < 1e-6, `α=2 → ${at(2.0)}`);
    // Monotone in α across the whole span, with no jump at the singularity.
    let prev = -1;
    for (let a = 1.3; a <= 2.9; a += 0.02) {
        const v = at(a);
        assert.ok(Number.isFinite(v), `finite at α=${a.toFixed(2)}`);
        assert.ok(v > prev, `monotone at α=${a.toFixed(2)}`);
        prev = v;
    }
    assert.ok(Math.abs(at(2.0 - 1e-7) - at(2.0 + 1e-7)) < 1e-4, 'continuous through α=2');
});

ok('energyFractionBelow is 0 at E_MIN and 1 at E_MAX, and clamps outside', () => {
    for (const a of [1.5, 2.0, 2.5]) {
        assert.equal(energyFractionBelow(E_MIN_ERG, a), 0);
        assert.ok(Math.abs(energyFractionBelow(E_MAX_ERG, a) - 1) < 1e-9);
        assert.equal(energyFractionBelow(1e10, a), 0, 'below the range');
        assert.ok(Math.abs(energyFractionBelow(1e40, a) - 1) < 1e-9, 'above the range');
    }
});

ok('the closed-form mean energy matches a Monte-Carlo mean of the sampler', () => {
    for (const a of [1.5, 1.8, 2.2, 2.6]) {
        const rnd = lcg(99 + Math.round(a * 10));
        const N = 600000;
        let acc = 0;
        for (let i = 0; i < N; i++) acc += sampleEnergy(rnd(), a);
        const mc = acc / N, closed = meanEnergy(a);
        // A power law with α < 2 has a heavy tail, so the MC mean converges
        // slowly and the tolerance has to be loose at the shallow end — that is
        // the same statistics that makes the α<2 budget a big-event budget.
        const tol = a < 2 ? 0.20 : 0.03;
        assert.ok(Math.abs(mc - closed) / closed < tol,
            `α=${a}: MC ${mc.toExponential(3)} vs closed ${closed.toExponential(3)}`);
    }
});

ok('mean energy falls as α steepens, and stays inside the bounds', () => {
    let prev = Infinity;
    for (const a of [1.4, 1.7, 2.0, 2.3, 2.6, 2.9]) {
        const m = meanEnergy(a);
        assert.ok(m > E_MIN_ERG && m < E_MAX_ERG, `α=${a} mean ${m.toExponential(2)} in range`);
        assert.ok(m < prev, `monotone decreasing at α=${a}`);
        prev = m;
    }
});

ok('heatingFlux and rateForFlux invert each other', () => {
    for (const a of [1.6, 2.0, 2.5]) {
        const r = rateForFlux(HEATING_REQUIREMENT.quiet, a);
        assert.ok(Math.abs(heatingFlux(r, a) - HEATING_REQUIREMENT.quiet) / HEATING_REQUIREMENT.quiet < 1e-12);
    }
});

ok('the budget is normalised to Withbroe & Noyes at ALPHA_NORM, and moves with α from there', () => {
    const base = nanoflareState({ f107: 65, arAreaMh: 0, alpha: ALPHA_NORM });
    // At the quiet-Sun F10.7 floor the activity factor is 1, so the quiet
    // population must deliver exactly the observed requirement.
    assert.ok(Math.abs(base.activityFactor - 1) < 1e-9, `activityFactor ${base.activityFactor}`);
    assert.ok(Math.abs(base.budgetQuiet - 1) < 1e-9, `budget ×${base.budgetQuiet}`);
    assert.ok(Math.abs(base.fluxQuiet - HEATING_REQUIREMENT.quiet) / HEATING_REQUIREMENT.quiet < 1e-12);
    // Shallower α ⇒ a bigger mean event ⇒ more power at the same event rate.
    const shallow = nanoflareState({ f107: 65, alpha: 1.6 });
    const steep   = nanoflareState({ f107: 65, alpha: 2.6 });
    assert.ok(shallow.budgetQuiet > base.budgetQuiet, 'α=1.6 delivers more at the same rate');
    assert.ok(steep.budgetQuiet   < base.budgetQuiet, 'α=2.6 delivers less at the same rate');
    assert.equal(base.canHeat, false, 'α = 2.0 is the boundary, not "can heat"');
    assert.equal(nanoflareState({ alpha: 2.2 }).canHeat, true);
});

ok('the live drive: F10.7 above quiet and AR area both raise the rate, and both are bounded', () => {
    const quiet  = nanoflareState({ f107: 65,  arAreaMh: 0 });
    const busy   = nanoflareState({ f107: 210, arAreaMh: 1200 });
    assert.ok(busy.rateQuiet  > quiet.rateQuiet,  'F10.7 raises the quiet-network rate');
    assert.ok(busy.rateActive > quiet.rateActive * 2, 'AR area raises the active rate harder');
    assert.ok(busy.budgetActive > 0, 'active budget is scored');
    // Nonsense input must not produce a nonsense population.
    for (const bad of [{ f107: NaN }, { f107: -50 }, { f107: 1e9 }, { arAreaMh: -3 }, { arAreaMh: 1e9 }, { alpha: NaN }, { alpha: 99 }]) {
        const s = nanoflareState(bad);
        assert.ok(Number.isFinite(s.rateQuiet) && s.rateQuiet > 0, `rate finite for ${JSON.stringify(bad)}`);
        assert.ok(s.alpha >= 1.2 && s.alpha <= 3.0, `α clamped for ${JSON.stringify(bad)}`);
        assert.ok(Number.isFinite(s.fluxActive) && s.fluxActive > 0);
    }
});

ok('duration scales as E^β and is anchored at the reference energy', () => {
    assert.ok(Math.abs(durationFor(E_DUR_REF) - DURATION_REF_S) < 1e-9);
    const ratio = durationFor(E_DUR_REF * 1000) / durationFor(E_DUR_REF);
    assert.ok(Math.abs(ratio - Math.pow(1000, DURATION_BETA)) < 1e-9, `ratio ${ratio}`);
    assert.ok(durationFor(E_MIN_ERG) < durationFor(E_MAX_ERG), 'monotone');
    assert.ok(durationFor(0) > 0 && Number.isFinite(durationFor(0)), 'guarded at zero');
});

ok('the shader uniform packs α and the log2 bounds the GLSL sampler needs', () => {
    const s = nanoflareState({ f107: 65, alpha: 2.1 });
    const [a, lmin, lmax, mult] = nanoflareUniform(s);
    assert.ok(Math.abs(a - 2.1) < 1e-9);
    assert.ok(Math.abs(Math.pow(2, lmin) - E_MIN_ERG) / E_MIN_ERG < 1e-9, 'log2 E_MIN round-trips');
    assert.ok(Math.abs(Math.pow(2, lmax) - E_MAX_ERG) / E_MAX_ERG < 1e-9, 'log2 E_MAX round-trips');
    assert.ok(Math.abs(mult - 1) < 1e-9, 'quiet-floor drive is the ×1 baseline');

    // The GLSL mirror, evaluated here in the same log2 space the shader uses.
    // If this drifts from sampleEnergy the rendered population stops having the
    // index the control claims — which is the whole point of the layer.
    const glslMirror = (u, alpha, l0, l1) => {
        const p = 1 - alpha;
        const A = Math.pow(2, l0 * p), B = Math.pow(2, l1 * p);
        return Math.log2(A + u * (B - A)) / p;               // log2(E)
    };
    for (const u of [0.02, 0.31, 0.5, 0.77, 0.99]) {
        for (const alpha of [1.6, 2.1, 2.7]) {
            const js = Math.log2(sampleEnergy(u, alpha));
            const gl = glslMirror(u, alpha, lmin, lmax);
            assert.ok(Math.abs(js - gl) < 1e-6, `mirror at u=${u} α=${alpha}: ${js} vs ${gl}`);
        }
    }
});

ok('nanoflareLabel names the regime and never claims the rate was measured', () => {
    const lo = nanoflareLabel(nanoflareState({ alpha: 1.7 }));
    const hi = nanoflareLabel(nanoflareState({ alpha: 2.4 }));
    assert.match(lo, /α<2/);
    assert.match(hi, /α>2/);
    assert.match(hi, /unresolved/);
    for (const s of [lo, hi]) assert.doesNotMatch(s, /observed|measured/i);
});

ok('the published α references bracket 2 on both sides — the question is open, and the UI must be able to say so', () => {
    assert.ok(ALPHA_REFERENCES.some(r => r.alpha < 2), 'a sub-2 reference exists');
    assert.ok(ALPHA_REFERENCES.some(r => r.alpha > 2), 'a super-2 reference exists');
    for (const r of ALPHA_REFERENCES) {
        assert.ok(r.alpha > 1.2 && r.alpha < 3.0, `${r.label} inside the control range`);
        assert.ok(/\d{4}/.test(r.label), `${r.label} carries a year`);
    }
});

// ── Measuring α back out ───────────────────────────────────────────────────

ok('the MLE recovers the planted α from the sampler, across the published range', () => {
    for (const want of [1.5, 1.8, 2.0, 2.3, 2.6, 2.9]) {
        const rnd = lcg(313 + Math.round(want * 100));
        const s = new Float64Array(30000);
        for (let i = 0; i < s.length; i++) s[i] = sampleEnergy(rnd(), want);
        const { alpha, ok: good, n } = fitAlphaMLE(s);
        assert.ok(good && n === s.length, `all ${s.length} events used, got n=${n}`);
        assert.ok(Math.abs(alpha - want) < 0.05, `α ${want} → MLE ${alpha.toFixed(3)}`);
    }
});

ok('the MLE beats a binned log-log regression on the same draw — which is why it is the MLE', () => {
    const want = 2.4;
    const rnd = lcg(4242);
    const s = new Float64Array(20000);
    for (let i = 0; i < s.length; i++) s[i] = sampleEnergy(rnd(), want);
    const mle = fitAlphaMLE(s).alpha;
    // A deliberately naive histogram fit, the thing CSN 2009 §3 warns about:
    // equal-width bins in log E, unweighted least squares on log N.
    const NB = 12, l0 = Math.log10(E_MIN_ERG), l1 = Math.log10(E_MAX_ERG);
    const counts = new Array(NB).fill(0);
    for (const E of s) {
        const b = Math.min(NB - 1, Math.floor((Math.log10(E) - l0) / (l1 - l0) * NB));
        counts[b]++;
    }
    const xs = [], ys = [];
    for (let b = 0; b < NB; b++) {
        if (counts[b] < 1) continue;
        const w = (l1 - l0) / NB;
        xs.push(l0 + (b + 0.5) * w);
        ys.push(Math.log10(counts[b]));
    }
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const binned = -num / den;
    assert.ok(Math.abs(mle - want) < Math.abs(binned - want),
        `MLE ${mle.toFixed(3)} should beat binned ${binned.toFixed(3)} against ${want}`);
});

ok('the MLE refuses to answer on a thin sample instead of printing a confident wrong number', () => {
    const rnd = lcg(5);
    const few = new Float64Array(20);
    for (let i = 0; i < few.length; i++) few[i] = sampleEnergy(rnd(), 2.0);
    const r = fitAlphaMLE(few);
    assert.equal(r.ok, false, '20 events is not enough to quote an index');
    assert.equal(r.n, 20);
    const none = fitAlphaMLE(new Float64Array(0));
    assert.equal(none.ok, false);
    assert.ok(Number.isNaN(none.alpha), 'no events ⇒ NaN, never a default');
});

ok('out-of-range events are DISCARDED, not clamped onto the bounds', () => {
    const rnd = lcg(11);
    const s = [];
    for (let i = 0; i < 20000; i++) s.push(sampleEnergy(rnd(), 2.2));
    const clean = fitAlphaMLE(s).alpha;
    // Splice in junk on both sides: a clamping implementation would pile these
    // onto E_MIN / E_MAX and drag the index; a discarding one ignores them.
    const dirty = s.concat(new Array(400).fill(1e10), new Array(400).fill(1e40), [0, -5, NaN]);
    const r = fitAlphaMLE(dirty);
    assert.equal(r.n, 20000, `only the in-range events counted, got ${r.n}`);
    assert.ok(Math.abs(r.alpha - clean) < 1e-9, `index unmoved: ${clean} vs ${r.alpha}`);
});

ok('AlphaMonitor tracks a population whose index changes, and forgets the old one', () => {
    const mon = new AlphaMonitor({ capacity: 3000 });
    const rnd = lcg(777);
    for (let i = 0; i < 6000; i++) mon.push(sampleEnergy(rnd(), 1.7));
    const before = mon.fit();
    assert.ok(before.ok);
    assert.ok(Math.abs(before.alpha - 1.7) < 0.08, `steady state α ${before.alpha.toFixed(3)}`);
    // The Sun changes regime; the window must follow it, not average over it.
    for (let i = 0; i < 6000; i++) mon.push(sampleEnergy(rnd(), 2.6));
    const after = mon.fit();
    assert.ok(Math.abs(after.alpha - 2.6) < 0.08, `after the change α ${after.alpha.toFixed(3)}`);
    assert.equal(mon.count, 3000, 'the window is bounded');
    assert.equal(mon.total, 12000, 'the total is not');
    mon.reset();
    assert.equal(mon.fit().ok, false, 'reset clears the window');
});

ok('AlphaMonitor ignores non-positive energies and never overruns its ring', () => {
    const mon = new AlphaMonitor({ capacity: 64 });
    for (const bad of [0, -1, NaN, undefined, null]) mon.push(bad);
    assert.equal(mon.count, 0);
    const rnd = lcg(3);
    for (let i = 0; i < 500; i++) mon.push(sampleEnergy(rnd(), 2.0));
    assert.equal(mon.count, 64);
    assert.equal(mon.total, 500);
    assert.ok(mon.buf.every(v => v >= E_MIN_ERG && v <= E_MAX_ERG));
});

ok('autoRange fits the range the SAMPLE spans — the fix for events measured in somebody else’s units', () => {
    // A population that only occupies one decade of the nominal four. Fitting
    // it against the nominal bounds is fitting the unit convention: it pinned
    // the SOC grid's index at the search bound (3.6) on the first live run.
    // Roughly what the SOC grid emits: released stress spanning a third of a
    // decade near the bottom of the nominal range.
    const rnd = lcg(8181);
    const lo = 1e23, hi = 2e23;
    const s = [];
    for (let i = 0; i < 12000; i++) s.push(sampleEnergy(rnd(), 2.2, lo, hi));
    const nominal = fitAlphaMLE(s);                          // wrong range
    const auto    = fitAlphaMLE(s, undefined, undefined, { autoRange: true });
    assert.ok(Math.abs(auto.alpha - 2.2) < 0.10, `autoRange recovers 2.2, got ${auto.alpha.toFixed(3)}`);
    assert.ok(auto.ok, `and it is quotable: ks=${auto.ks.toFixed(4)}`);
    // Against the nominal range the estimator runs to the edge of its search
    // and the guards catch it — which is the behaviour that protects the
    // readout, whatever number the likelihood happens to land on.
    assert.equal(nominal.ok, false, `nominal-range fit must not be quotable (α=${nominal.alpha.toFixed(3)}, ks=${nominal.ks.toFixed(3)}, atBound=${nominal.atBound})`);
    assert.ok(nominal.atBound || nominal.ks > 0.09, 'and it must say why');
    assert.ok(auto.eMin >= lo * 0.99 && auto.eMax <= hi * 1.01, 'range came from the data');
    // A power-law index is invariant under E → cE, so a rescaled copy of the
    // same events must fit the same index. This is why autoRange is legitimate.
    const scaled = s.map(E => E * 137);
    const a2 = fitAlphaMLE(scaled, undefined, undefined, { autoRange: true });
    assert.ok(Math.abs(a2.alpha - auto.alpha) < 0.02, `scale invariant: ${auto.alpha} vs ${a2.alpha}`);
});

ok('the KS guard refuses a sample that is NOT power-law distributed', () => {
    const rnd = lcg(606);
    const good = [];
    for (let i = 0; i < 4000; i++) good.push(sampleEnergy(rnd(), 2.2));
    const gf = fitAlphaMLE(good, undefined, undefined, { autoRange: true });
    assert.ok(gf.ok, `a real power law passes, ks=${gf.ks.toFixed(4)}`);
    assert.ok(gf.ks < 0.05, `ks small on a true power law, got ${gf.ks}`);

    // Log-normal: a plausible-looking heavy-tailed alternative that an
    // unguarded MLE answers for just as confidently.
    const bad = [];
    for (let i = 0; i < 4000; i++) {
        const u1 = Math.max(rnd(), 1e-9), u2 = rnd();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        bad.push(Math.exp(Math.log(1e25) + z * 1.2));
    }
    const bf = fitAlphaMLE(bad, undefined, undefined, { autoRange: true });
    assert.ok(bf.n > 3000, 'the sample was used');
    assert.ok(bf.ks > 0.09, `log-normal must fail the KS guard, ks=${bf.ks.toFixed(4)}`);
    assert.equal(bf.ok, false, 'and therefore must not be quoted');
});

ok('a fit pinned at the search bound is reported, not passed off as a measurement', () => {
    // Every event the same size: no index exists, and the likelihood runs to
    // the edge of the search. `ok` must be false and `atBound` must say why.
    const flat = new Array(400).fill(1e24).map((v, i) => v * (1 + i * 1e-6));
    const r = fitAlphaMLE(flat, undefined, undefined, { autoRange: true });
    assert.equal(r.ok, false);
    assert.ok(r.atBound || r.ks > 0.09, `flagged: atBound=${r.atBound} ks=${r.ks}`);
});

console.log(`\n${passed} checks passed`);
