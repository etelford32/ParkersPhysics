/**
 * star-collider-interactions.mjs — gate for js/star-collider/interactions.js
 *
 * Run: node tests/star-collider-interactions.mjs
 *
 * Every check is an identity or an exact comparison, never a remembered
 * number:
 *   1. the neighbour search finds EXACTLY the brute-force pair set, including
 *      pairs that involve the fat (above-p90) kernels the grid does not hold;
 *   2. a uniform velocity field has ∇·v = 0 and no viscous heating
 *      (Galilean invariance of the pair terms);
 *   3. a homologous expansion v = H x has ∇·v ≈ 3H in the interior and still
 *      no heating (expanding pairs never trigger Π);
 *   4. a homologous COLLAPSE heats every interior particle, the heating is
 *      ≥ 0 everywhere, and the total equals the pair sum written out by hand
 *      (Σ m_i du_i = Σ_pairs (m_i m_j)(Π dW v·r) — the kernel's energy
 *      bookkeeping);
 *   5. two separated stars have zero mixing and no A–B pairs; the same two
 *      lattices interleaved mix to ≈ ½ and every link is A–B;
 *   6. against the shipped WASM: a relaxed pair run to contact produces
 *      A–B pairs, mixing and heating where a far-apart pair produced none.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeInteractions, forEachPair, kernelW, kernelDw, packInteractions, AUX_STRIDE } from '../js/star-collider/interactions.js';
import { loadKernel } from '../js/star-collider/kernel.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** A jittered cubic lattice (side s, spacing a) — star 0 unless `starOf`. */
function lattice({ side = 8, a = 1, jitter = 0.15, seed = 1, offset = [0, 0, 0], starOf = () => 0, hOf = () => 1.2 * a } = {}) {
    const rnd = lcg(seed);
    const pts = [];
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) for (let z = 0; z < side; z++) {
        pts.push([offset[0] + (x + jitter * (rnd() - 0.5)) * a, offset[1] + (y + jitter * (rnd() - 0.5)) * a, offset[2] + (z + jitter * (rnd() - 0.5)) * a]);
    }
    return pts.map((p, i) => ({ p, star: starOf(i, p), h: hOf(i, p) }));
}
function toState(parts, velOf = () => [0, 0, 0], { rho = 1, u = 0 } = {}) {
    const n = parts.length;
    const st = {
        n, pos: new Float64Array(3 * n), vel: new Float64Array(3 * n), h: new Float64Array(n), mass: new Float64Array(n).fill(1),
        rho: new Float64Array(n).fill(rho), u: new Float64Array(n).fill(u), star: new Uint8Array(n), alive: new Uint8Array(n).fill(1),
        bodies: [{ k: 1, gamma: 2 }, { k: 1, gamma: 2 }],
    };
    parts.forEach((q, i) => {
        st.pos.set(q.p, 3 * i); st.vel.set(velOf(q.p, i), 3 * i); st.h[i] = q.h; st.star[i] = q.star;
    });
    return st;
}

// 1 ── exact neighbour search
{
    const rnd = lcg(9);
    const parts = lattice({ side: 9, seed: 3, hOf: () => 0.6 + 0.8 * rnd() });
    // a few fat ejecta kernels far above p90
    for (const i of [5, 77, 300, 701]) parts[i].h = 4 + 3 * rnd();
    const st = toState(parts);
    st.alive[11] = 0;   // a dead particle must never appear
    const got = new Set();
    forEachPair(st, (i, j) => { assert.ok(i < j, 'pairs are ordered'); const k = `${i},${j}`; assert.ok(!got.has(k), `pair ${k} visited twice`); got.add(k); });
    const want = new Set();
    for (let i = 0; i < st.n; i++) for (let j = i + 1; j < st.n; j++) {
        if (!st.alive[i] || !st.alive[j]) continue;
        const d = Math.hypot(st.pos[3 * i] - st.pos[3 * j], st.pos[3 * i + 1] - st.pos[3 * j + 1], st.pos[3 * i + 2] - st.pos[3 * j + 2]);
        if (d < 2 * Math.max(st.h[i], st.h[j])) want.add(`${i},${j}`);
    }
    assert.equal(got.size, want.size, `pair count ${got.size} vs brute force ${want.size}`);
    for (const k of want) assert.ok(got.has(k), `missing pair ${k}`);
    ok(`neighbour search = brute force (${want.size} pairs, 4 fat kernels, a dead particle excluded)`);
}

// kernel normalisation sanity: ∫W dV = 1, and dW is dW/dr
{
    const h = 0.7; let s = 0; const dr = 1e-3;
    for (let r = dr / 2; r < 2 * h; r += dr) s += 4 * Math.PI * r * r * kernelW(r, h) * dr;
    assert.ok(Math.abs(s - 1) < 1e-4, `∫W = ${s}`);
    for (const r of [0.2, 0.9, 1.3]) {
        const fd = (kernelW(r + 1e-6, h) - kernelW(r - 1e-6, h)) / 2e-6;
        assert.ok(Math.abs(fd - kernelDw(r, h)) < 1e-5 * Math.max(1, Math.abs(fd)), `dW at ${r}`);
    }
    ok('kernel W normalised, kernelDw = dW/dr (the sph.rs cubic spline)');
}

const interior = (st, i, lo, hi) => [0, 1, 2].every(c => st.pos[3 * i + c] > lo && st.pos[3 * i + c] < hi);

// 2 ── uniform flow
{
    const st = toState(lattice({ side: 8, seed: 5 }), () => [0.3, -1.1, 0.7]);
    const r = computeInteractions(st);
    const maxDiv = Math.max(...r.div.map(Math.abs)), maxHeat = Math.max(...r.heatRate);
    assert.ok(maxDiv < 1e-12, `uniform flow ∇·v = ${maxDiv}`);
    assert.equal(maxHeat, 0, 'uniform flow is not heated');
    ok('uniform velocity: ∇·v = 0 and zero viscous heating (Galilean invariance)');
}

// 3 ── homologous expansion
{
    const H = 0.05, c = 3.5;
    const st = toState(lattice({ side: 8, seed: 6, jitter: 0 }), (p) => p.map(x => H * (x - c)));
    // ρ consistent with the lattice: m / a³ = 1
    const r = computeInteractions(st);
    const vals = [];
    for (let i = 0; i < st.n; i++) if (interior(st, i, 2.5, 4.5)) vals.push(r.div[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    assert.ok(Math.abs(mean - 3 * H) < 0.04 * 3 * H, `interior ∇·v ${mean} vs 3H ${3 * H}`);
    assert.equal(Math.max(...r.heatRate), 0, 'expansion is not heated');
    ok(`homologous expansion: interior ∇·v = ${mean.toFixed(4)} vs 3H = ${(3 * H).toFixed(4)}; no heating`);
}

// 4 ── homologous collapse: heating ≥ 0, and the pair-sum identity
{
    const H = -0.08, c = 3.5;
    const st = toState(lattice({ side: 8, seed: 7 }), (p) => p.map(x => H * (x - c)), { rho: 1, u: 0.02 });
    const params = { alpha: 1, beta: 2, gammaTh: 1.75 };
    const r = computeInteractions(st, params);
    assert.ok(r.heatRate.every(x => x >= 0), 'heating is never negative');
    let interiorHeated = 0, interiorN = 0;
    for (let i = 0; i < st.n; i++) if (interior(st, i, 1.5, 5.5)) { interiorN++; if (r.heatRate[i] > 0) interiorHeated++; }
    assert.equal(interiorHeated, interiorN, 'every interior particle is heated by a collapse');
    assert.ok(r.div.filter((_, i) => interior(st, i, 2.5, 4.5)).every(d => d < 0), 'interior ∇·v < 0 (compression)');
    // By hand: Σ m_i du_i = Σ_pairs (m_i m_j + m_j m_i)·½Π dW v·r
    let byHand = 0;
    const cs = (i) => Math.sqrt(2 * 1 * st.rho[i] + 1.75 * 0.75 * st.u[i]);
    for (let i = 0; i < st.n; i++) for (let j = i + 1; j < st.n; j++) {
        const dx = st.pos[3 * i] - st.pos[3 * j], dy = st.pos[3 * i + 1] - st.pos[3 * j + 1], dz = st.pos[3 * i + 2] - st.pos[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz, hij = 0.5 * (st.h[i] + st.h[j]);
        if (r2 >= 4 * hij * hij) continue;
        const rr = Math.sqrt(r2), dw = kernelDw(rr, hij) / rr;
        const vdotr = (st.vel[3 * i] - st.vel[3 * j]) * dx + (st.vel[3 * i + 1] - st.vel[3 * j + 1]) * dy + (st.vel[3 * i + 2] - st.vel[3 * j + 2]) * dz;
        if (vdotr >= 0) continue;
        const mu = hij * vdotr / (r2 + 0.01 * hij * hij);
        const visc = (-1 * 0.5 * (cs(i) + cs(j)) * mu + 2 * mu * mu) / 1;
        byHand += 2 * 0.5 * visc * dw * vdotr;
    }
    const sum = r.heatRate.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - byHand) < 1e-9 * Math.abs(byHand), `Σ heat ${sum} vs pair sum ${byHand}`);
    assert.ok(r.summary.heatingPower > 0 && r.summary.shockFraction > 0, 'summary reports the heating');
    ok(`homologous collapse: every interior particle heated, heating ≥ 0, total = the hand pair sum (${byHand.toExponential(3)})`);
}

// 5 ── mixing
{
    const A = lattice({ side: 6, seed: 8 });
    const B = lattice({ side: 6, seed: 9, offset: [20, 0, 0], starOf: () => 1 });
    const apart = computeInteractions(toState(A.concat(B)));
    assert.equal(Math.max(...apart.mix), 0, 'separated stars do not mix');
    assert.equal(apart.summary.abPairs, 0, 'and share no pairs');
    // interleave: star by checkerboard parity on the same lattice
    const C = lattice({ side: 8, seed: 10, starOf: (i) => { const x = Math.floor(i / 64), y = Math.floor(i / 8) % 8, z = i % 8; return (x + y + z) % 2; } });
    const st = toState(C);
    const mixed = computeInteractions(st);
    const inner = [];
    for (let i = 0; i < st.n; i++) if (interior(st, i, 2.5, 4.5)) inner.push(mixed.mix[i]);
    const m = inner.reduce((a, b) => a + b, 0) / inner.length;
    assert.ok(m > 0.35 && m < 0.55, `interleaved interior mixing ${m}`);
    assert.ok(mixed.summary.abPairs > 0 && mixed.links.every(l => st.star[l.i] !== st.star[l.j]), 'every link is an A–B pair');
    ok(`mixing: 0 for separated stars; ${m.toFixed(3)} for interleaved lattices (self-weight keeps it under ½); links are A–B only`);
}

// packing
{
    const st = toState(lattice({ side: 4, seed: 2 }), (p) => [p[0], -p[1], 0.5]);
    const r = computeInteractions(st);
    const { aux, links } = packInteractions(st, r);
    assert.equal(aux.length, st.n * AUX_STRIDE);
    assert.equal(aux[AUX_STRIDE * 3 + 3], Math.fround(st.h[3]));
    assert.equal(links.length, r.links.length * 4);
    ok('packing: aux stride 7 (v, h, ∇·v, mixing, heating), links stride 4');
}

// 6 ── against the shipped kernel
{
    const wasm = readFileSync(fileURLToPath(new URL('../js/star-collider/wasm/star_collider_kernel.wasm', import.meta.url)));
    const kernel = await loadKernel(wasm);
    const R = 7.0, M = 1.35;   // ~10 km neutron stars in G M☉/c² units
    const run = (sep, steps) => {
        kernel.init();
        kernel.setParams({ c: 1, alpha: 1, beta: 2, gammaTh: 1.75, pn1: false, pn25: true });
        kernel.setBody(0, { kind: 'star', mass: M, radius: R, gamma: 2 });
        kernel.setBody(1, { kind: 'star', mass: M, radius: R, gamma: 2 });
        kernel.build(150, 150, 7);
        kernel.relax(40, 0.6, 0.05);
        kernel.setOrbit(sep, 0, 0, 0, true);
        if (steps) kernel.advance(1e9, steps, 0.6);
        const n = kernel.n();
        const state = {
            n, pos: kernel.pos().slice(), vel: kernel.vel().slice(), h: kernel.h().slice(), mass: kernel.mass().slice(),
            rho: kernel.rho().slice(), u: kernel.u().slice(), star: kernel.star().slice(), alive: kernel.alive().slice(),
            bodies: [{ k: kernel.bodyK(0), gamma: 2 }, { k: kernel.bodyK(1), gamma: 2 }],
        };
        return { state, r: computeInteractions(state, { alpha: 1, beta: 2, gammaTh: 1.75 }) };
    };
    const far = run(60, 0);
    assert.equal(far.r.summary.abPairs, 0, 'stars 60 apart share no kernels');
    assert.equal(Math.max(...far.r.mix), 0, 'and do not mix');
    // Deliberately overlapping start: the stars are already in contact.
    const touch = run(1.4 * R, 120);
    assert.ok(touch.r.summary.abPairs > 20, `in contact: ${touch.r.summary.abPairs} A–B pairs`);
    assert.ok(touch.r.summary.mixedFraction > 0, 'some gas is mixed');
    assert.ok(touch.r.summary.heatingPower > 0, 'and the contact is being shock-heated');
    // the strongest heaters are on the contact: their mixing beats the median
    const order = [...touch.r.heatRate.keys()].sort((a, b) => touch.r.heatRate[b] - touch.r.heatRate[a]).slice(0, 20);
    const sorted = [...touch.r.mix].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    const top = order.reduce((s, i) => s + touch.r.mix[i], 0) / order.length;
    assert.ok(top > med, `top heaters' mixing ${top} > median ${med}`);
    ok(`WASM: apart → 0 pairs; in contact → ${touch.r.summary.abPairs} A–B pairs, mixed ${(100 * touch.r.summary.mixedFraction).toFixed(1)} %, heating on the interface`);
}

console.log(`✅ star-collider-interactions: ${passed} checks passed`);
