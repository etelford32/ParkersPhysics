// tests/hero-sun-flow.mjs — the pure flow kernel behind the hero Sun's flare
// ejecta (js/hero-sun-flow.js). Run: node tests/hero-sun-flow.mjs
import assert from 'node:assert/strict';
import {
    FLOW_CLASS, CURL, R_LEAVE, KIND, STRIDE, LOOPS_PER_SITE, COOL_FRACTION,
    vnoise, potential, curlNoise, gradientNoise, divergence,
    siteLoops, loopPoint, makeRng, createFlowState, setSites, stepFlow, packFlow, flowCounts,
} from '../js/hero-sun-flow.js';
import { helioUnit, bipoleAxisAt, bipoleSize } from '../js/hero-sun-model.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const mag = (v) => Math.hypot(v[0], v[1], v[2]);

// ── Noise is bounded and smooth ──────────────────────────────────────────
{
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
        const v = vnoise(rng() * 20 - 10, rng() * 20 - 10, rng() * 20 - 10);
        assert.ok(v >= 0 && v < 1, 'value noise in [0,1)');
    }
    const p = potential(0.3, 0.2, 0.9, 1.5);
    assert.equal(p.length, 3);
}

// ── THE CLAIM: curl ψ is divergence-free; ∇ψ (the control) is not ────────
{
    const rng = makeRng(11);
    let divCurl = 0, divGrad = 0, divCurlCoarse = 0, divGradCoarse = 0, vmag = 0, N = 0;
    for (let i = 0; i < 300; i++) {
        const x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1, t = rng() * 10;
        const v = curlNoise(x, y, z, t);
        vmag += mag(v);
        // Same stencil: the discrete identity div(curl ψ) ≡ 0.
        divCurl += Math.abs(divergence(curlNoise, x, y, z, t));
        divGrad += Math.abs(divergence(gradientNoise, x, y, z, t));
        // A coarser stencil: no longer an identity, only the smoothness of ψ —
        // the curl field must still be the far less compressible of the two.
        divCurlCoarse += Math.abs(divergence(curlNoise, x, y, z, t, 0.01));
        divGradCoarse += Math.abs(divergence(gradientNoise, x, y, z, t, 0.01));
        N++;
    }
    divCurl /= N; divGrad /= N; divCurlCoarse /= N; divGradCoarse /= N; vmag /= N;
    assert.ok(vmag > 0.5, `the eddy field is not degenerate (|v| = ${vmag.toFixed(3)})`);
    assert.ok(divCurl < 1e-6 * vmag / CURL.eps, `curl ψ: div ≡ 0 on its own stencil (${divCurl.toExponential(2)})`);
    assert.ok(divGrad > 1e3 * Math.max(divCurl, 1e-12), `NEGATIVE CONTROL: ∇ψ is compressible on the same stencil (${divGrad.toFixed(3)})`);
    assert.ok(divGradCoarse > 1.5 * divCurlCoarse, `coarse stencil: ∇ψ still the more compressible (${divGradCoarse.toFixed(3)} vs ${divCurlCoarse.toFixed(3)})`);
}

// ── Site loops: nested over the PIL, footpoints on the sphere, apex lifted ─
const mkSite = (lat, lon, area, letter, flash) => {
    const c = helioUnit(lat, lon);
    const ax = bipoleAxisAt(lat, lon);
    const side = [c[1] * ax[2] - c[2] * ax[1], c[2] * ax[0] - c[0] * ax[2], c[0] * ax[1] - c[1] * ax[0]];
    return { c, ax, side, hs: bipoleSize(area).halfSepRad, letter, flash };
};
{
    const site = mkSite(-12, 20, 500, 'M', 1);
    const loops = siteLoops(site);
    assert.equal(loops.length, LOOPS_PER_SITE);
    let prevH = 0;
    for (const l of loops) {
        near(mag(l.a), 1, 1e-12, 'foot a on the sphere'); near(mag(l.b), 1, 1e-12, 'foot b on the sphere');
        assert.ok(l.apexH > prevH, 'nested: each loop higher than the last');
        prevH = l.apexH;
        near(mag(loopPoint(l, 0)), 1, 1e-9, 's=0 is on the photosphere');
        near(mag(loopPoint(l, 1)), 1, 1e-9, 's=1 is on the photosphere');
        near(mag(loopPoint(l, 0.5)), 1 + l.apexH, 1e-9, 'apex at s=½');
        // Foot a is on the +ax side (the leading polarity), b on the other.
        const da = l.a[0] * site.ax[0] + l.a[1] * site.ax[1] + l.a[2] * site.ax[2];
        const db = l.b[0] * site.ax[0] + l.b[1] * site.ax[1] + l.b[2] * site.ax[2];
        assert.ok(da > db, 'the loop crosses the PIL');
    }
}

// ── Emission follows class and flash; nothing without a flash ────────────
function run(letter, flash, seconds, seed = 3) {
    const st = createFlowState(3000, seed);
    setSites(st, [mkSite(10, -30, 400, letter, flash)]);
    let spawned = 0;
    for (let k = 0; k < seconds * 30; k++) spawned += stepFlow(st, 1 / 30).spawned;
    return { st, spawned };
}
{
    const c = run('C', 1, 2).spawned, m = run('M', 1, 2).spawned, x = run('X', 1, 2).spawned;
    assert.ok(x > m && m > c, `X > M > C emission (${x} > ${m} > ${c})`);
    near(m, FLOW_CLASS.M.rate * 2, FLOW_CLASS.M.rate * 0.1, 'rate × seconds at full flash');
    assert.equal(run('X', 0, 2).spawned, 0, 'no flash, no release');
    const half = run('M', 0.5, 2).spawned;
    near(half, m / 2, m * 0.1, 'emission scales with the flash');
}

// ── Determinism: same seed, same sites, same bytes ───────────────────────
{
    const a = run('M', 0.8, 3, 42).st, b = run('M', 0.8, 3, 42).st;
    assert.deepEqual(Array.from(a.data), Array.from(b.data), 'deterministic');
    assert.notDeepEqual(Array.from(a.data), Array.from(run('M', 0.8, 3, 43).st.data), 'seed matters');
}

// ── Populations behave: loops stay on loops, ejecta escape, nothing NaN ──
{
    const site = mkSite(5, 40, 600, 'X', 1);
    const st = createFlowState(4000, 9);
    setSites(st, [site]);
    const loops = st.loops[0];
    let maxLoopDev = 0, minR = Infinity, maxR = 0, ejectaSeen = 0, loopSeen = 0;
    const ejectaR = new Map();     // index → [r at birth, r later]
    for (let k = 0; k < 150; k++) {
        stepFlow(st, 1 / 30);
        for (let i = 0; i < st.n; i++) {
            if (!st.alive[i]) continue;
            const o = i * STRIDE;
            const p = [st.data[o], st.data[o + 1], st.data[o + 2]];
            for (const v of p) assert.ok(Number.isFinite(v), 'finite positions');
            const r = mag(p);
            minR = Math.min(minR, r); maxR = Math.max(maxR, r);
            if (st.data[o + 8] === KIND.LOOP) {
                loopSeen++;
                const l = loops[st.data[o + 7] | 0];
                const q = loopPoint(l, st.data[o + 5]);
                maxLoopDev = Math.max(maxLoopDev, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
                assert.ok(st.data[o + 5] > 0 && st.data[o + 5] < 1, 'arc fraction inside (0,1)');
            } else {
                ejectaSeen++;
                const e = ejectaR.get(i);
                if (!e) ejectaR.set(i, [r, r]); else e[1] = r;
            }
        }
    }
    assert.ok(loopSeen > 0 && ejectaSeen > 0, 'both populations present');
    assert.ok(maxLoopDev < 0.02, `loop particles ride their loop (max deviation ${maxLoopDev.toFixed(4)} R☉)`);
    assert.ok(minR >= 1.0 - 1e-6, `nothing below the photosphere (min r ${minR})`);
    assert.ok(maxR <= R_LEAVE + 0.05, `ejecta removed past R_LEAVE (max r ${maxR})`);
    let rising = 0, tracked = 0;
    for (const [r0, r1] of ejectaR.values()) { if (r1 !== r0) { tracked++; if (r1 > r0) rising++; } }
    assert.ok(tracked > 20 && rising / tracked > 0.9, `ejecta escape outward (${rising}/${tracked} rising)`);
    const counts = flowCounts(st);
    assert.equal(counts.total, st.count, 'count bookkeeping');
    const pk = packFlow(st);
    let live = 0;
    for (let i = 0; i < st.n; i++) { if (pk.age[i] < 1) live++; }
    assert.equal(live, counts.total, 'packed live count');

    // Rain: with the flash off, every loop particle drains and dies.
    setSites(st, [{ ...site, flash: 0 }]);
    for (let k = 0; k < 30 * 20; k++) stepFlow(st, 1 / 30);
    assert.equal(flowCounts(st).loop, 0, 'loops drain back to the photosphere');
    // The rain phase begins at the cooling fraction of life.
    assert.ok(COOL_FRACTION > 0.3 && COOL_FRACTION < 0.8);
}

// ── Re-setting the same site every frame must not starve the emitter ─────
{
    const st = createFlowState(2000, 5);
    let spawned = 0;
    for (let k = 0; k < 60; k++) {
        setSites(st, [{ id: 'f1', ...mkSite(0, 10, 300, 'C', 0.2) }]);   // 22/s: credit < 1 per frame
        spawned += stepFlow(st, 1 / 60).spawned;
    }
    assert.ok(spawned >= 15 && spawned <= 30, `credit carried across setSites (${spawned} in 1 s at 22/s)`);
}

// ── A pool that fills up stops spawning instead of throwing ──────────────
{
    const st = createFlowState(50, 1);
    setSites(st, [mkSite(0, 0, 900, 'X', 1)]);
    for (let k = 0; k < 60; k++) stepFlow(st, 1 / 30);
    assert.ok(st.count <= 50, 'bounded by the pool');
}

console.log('hero-sun-flow: ok');
