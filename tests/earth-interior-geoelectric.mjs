#!/usr/bin/env node
/**
 * earth-interior-geoelectric.mjs — gate for INNER_EARTH_PLAN.md P1:
 * js/earth-interior/{ground-models,geoelectric,geoelectric-nowcast}.js and
 * the `y` component added to api/geomag/observatories.js.
 *
 * Run: node tests/earth-interior-geoelectric.mjs   (~15 s, offline)
 *
 *   A. ground models — builder --check, raw-file pins, the Quebec reference vs
 *      an independent copy of TPL-007 Table 4, BOU's declared-vs-listed trap
 *   B. passivity — every column's impedance phase in (0°, 90°)
 *   C. the ramp response vs the closed-form half-space (+ σ negative control)
 *   D. kernel properties — causal, zero-for-constant, linear, isotropic,
 *      memory truncation small, and the SIGN via Poynting flux into the ground
 *      (+ flipped-sign negative control)
 *   E. steady sinusoid — |E|/|B| = |Z|/μ₀ and the phase lead = arg Z
 *   F. warm-up — the measured history error at WARMUP_SAMPLES
 *   G. gaps — bridged ≤ 5, split above, null never 0, one-component skipped
 *   H. TPL-007 — α, β only where tabulated, and our spectral β proxy RANKS
 *      the 22 models like the standard's Table 3 (+ scrambled control)
 *   I. the nowcast from a relay payload, and the relay's `y` passthrough
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MU0, impedanceSummary, layeredImpedance } from '../js/earth-interior/conductivity.js';
import { GROUND_MODELS, GROUND_MODEL_PINS } from '../js/earth-interior/ground-models.js';
import {
    groundColumn, GROUND_COLUMN_IDS, rampResponse, impulseResponse, geoelectricSeries, segmentSeries,
    WARMUP_SAMPLES, MAX_BRIDGE_SAMPLES, TPL007_BETA, tpl007Alpha, tpl007Planning,
} from '../js/earth-interior/geoelectric.js';
import {
    columnFor, stationNowcast, nowcastFromPayload, fetchGeoelectricNowcast, NOWCAST_WINDOW_MIN,
} from '../js/earth-interior/geoelectric-nowcast.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ── A. ground models ────────────────────────────────────────────────────────
console.log('A. ground models');
execFileSync(process.execPath, [join(ROOT, 'scripts/build-ground-models.mjs'), '--check'], { stdio: 'pipe' });
for (const [f, h] of Object.entries(GROUND_MODEL_PINS)) {
    const got = createHash('sha256').update(readFileSync(join(ROOT, 'data/earth-interior/ground-1d/usgs-v1.3', f))).digest('hex');
    assert.equal(got, h, `pin ${f}`);
}
ok(`builder --check clean; all ${Object.keys(GROUND_MODEL_PINS).length} raw files match their pins`);
const kinds = GROUND_MODELS.reduce((m, g) => ({ ...m, [g.kind]: (m[g.kind] ?? 0) + 1 }), {});
assert.deepEqual(kinds, { usgs: 21, nrcan: 15, bou: 1, nerc: 1 });
ok('38 models: 21 USGS regions (cross-checked vs pyrsss in the builder), 15 NRCan, BOU, NERC Quebec');
{   // TPL-007-4 Attachment 1 Table 4, as an INDEPENDENT copy (bezpy tpl007.py), not the file.
    const que = GROUND_MODELS.find((g) => g.id === 'QUE');
    assert.deepEqual(que.layers.map((l) => l.thicknessM), [15e3, 10e3, 125e3, 200e3]);
    const rho = [...que.layers.map((l) => 1 / l.sigma), 1 / que.halfspaceSigma];
    [20000, 200, 1000, 100, 3].forEach((r, i) => assert.ok(rel(rho[i], r) < 2e-4, `QUE ρ${i} ${rho[i]}`));
    ok('the NERC Quebec reference equals TPL-007 Table 4 (thicknesses exact, ρ to the file\'s rounding)');
}
{
    const bou = GROUND_MODELS.find((g) => g.id === 'BOU');
    assert.equal(bou.layers.length, 12, 'every LISTED layer kept');
    assert.equal(bou.layers[11].sigma, bou.halfspaceSigma, 'the 12th layer is the half-space σ');
    ok('BOU keeps all 12 listed layers; the 12th equals the half-space, so bezpy\'s 11-layer reading is the same Earth');
}

// ── B. passivity ────────────────────────────────────────────────────────────
console.log('B. passivity');
for (const id of GROUND_COLUMN_IDS) {
    const L = groundColumn(id);
    for (let T = 10; T <= 1e5; T *= 1.6) {
        const s = impedanceSummary(L, T);
        assert.ok(s.phaseDeg > 0 && s.phaseDeg < 90 && s.magOhm > 0, `${id} T=${T} phase ${s.phaseDeg}`);
    }
}
ok(`all ${GROUND_COLUMN_IDS.length} columns: 0° < arg Z < 90° from 10 s to 28 h (a passive 1-D Earth)`);

// ── C. ramp response vs the half-space closed form ──────────────────────────
console.log('C. ramp response');
{
    const sig = 1e-3, L = [{ sigma: sig, thicknessM: Infinity }], dt = 60;
    const exact = (t) => 1e-9 / MU0 * 1e3 * 2 * Math.sqrt(MU0 * t / (Math.PI * sig));
    const R = rampResponse(L, dt, 720);
    let worst = 0;
    for (let j = 2; j <= 720; j++) worst = Math.max(worst, rel(R[j], exact(j * dt)));
    assert.ok(worst < 5e-4, `worst ${worst}`);
    assert.ok(rel(R[1], exact(dt)) < 2e-3, `first lag ${rel(R[1], exact(dt))}`);
    ok(`R(t) = (2/μ₀)√(μ₀t/πσ) to ${worst.toExponential(1)} for t ≥ 2 min (${rel(R[1], exact(dt)).toExponential(1)} at 1 min)`);
    const wrong = rampResponse([{ sigma: 4 * sig, thicknessM: Infinity }], dt, 60);
    assert.ok(Math.abs(wrong[60] / exact(3600) - 0.5) < 1e-3, 'σ×4 halves it');
    ok('negative control: the same ramp over 4σ gives exactly half — the gate sees σ');
}

{   // LAYERED columns have no closed form, so the ramp response is checked
    // against an INDEPENDENT method: Gaver–Stehfest inverse Laplace of
    // Z(s)/(μ₀ s²), with Z(s) from a REAL-valued layer recursion written here.
    const zLaplace = (L, sv) => {
        const k = (sg) => Math.sqrt(sv * MU0 * sg);
        let Z = sv * MU0 / k(L[L.length - 1].sigma);
        for (let j = L.length - 2; j >= 0; j--) {
            const kk = k(L[j].sigma), eta = sv * MU0 / kk, t = Math.tanh(kk * L[j].thicknessM);
            Z = eta * (Z + eta * t) / (eta + Z * t);
        }
        return Z;
    };
    const fac = (x) => { let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; };
    const N = 16, V = [];
    for (let k = 1; k <= N; k++) {
        let acc = 0;
        for (let j = Math.floor((k + 1) / 2); j <= Math.min(k, N / 2); j++)
            acc += j ** (N / 2) * fac(2 * j) / (fac(N / 2 - j) * fac(j) * fac(j - 1) * fac(k - j) * fac(2 * j - k));
        V.push((-1) ** (k + N / 2) * acc);
    }
    const stehfest = (F, t) => { const a = Math.LN2 / t; let r = 0; for (let k = 1; k <= N; k++) r += V[k - 1] * F(k * a); return r * a; };
    let worst = 0;
    for (const id of ['CP2', 'QUE', 'PT1', 'BR1', 'GRAYVER-LAND']) {
        const L = groundColumn(id), R = rampResponse(L, 60, 720);
        for (const j of [10, 60, 240, 720]) {
            const st = stehfest((sv) => 1e-9 / MU0 * 1e3 * zLaplace(L, sv) / (sv * sv), j * 60);
            worst = Math.max(worst, rel(R[j], st));
        }
    }
    assert.ok(worst < 1e-4, `Stehfest ${worst}`);
    ok(`layered columns: Filon ramp response ≡ independent Stehfest inverse-Laplace to ${worst.toExponential(1)} (5 columns × 10 min–12 h)`);
}

// ── D. kernel properties ────────────────────────────────────────────────────
console.log('D. kernel');
const STORM = (() => {   // seeded red-noise storm with bursts (deterministic)
    let seed = 12345; const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const bx = [], by = []; let x = 0, y = 0;
    for (let i = 0; i < 3000; i++) {
        const burst = i % 400 < 40 ? 60 : 0;
        x += (r() - 0.5) * (8 + burst); y += (r() - 0.5) * (8 + burst); bx.push(x); by.push(y);
    }
    return { bx, by };
})();
{
    // The 12 h memory cut. The tail left there comes from the deep mantle every
    // column shares, so it is ~4e-6 V/km per nT for ALL of them (absolute bound).
    // Relative to the first response it is ≤ 1.01 % on land (measured: BOU 1.01,
    // BR1 0.63, AP1 0.60, the rest lower) — held at 1.5 %. Under the 7 kS ocean
    // the first response is itself screened ~30× smaller, so that one column is
    // held to 5 % (measured 3.4 %) — real physics, not a kernel defect.
    let worstAbs = 0;
    for (const id of GROUND_COLUMN_IDS) {
        const k = impulseResponse(groundColumn(id));
        assert.ok(k.w[0] > 0, `${id} w0`);
        worstAbs = Math.max(worstAbs, Math.abs(k.tailVkmPerNt));
        const relCap = id === 'GRAYVER-GLOBAL' ? 0.05 : 0.015;
        assert.ok(Math.abs(k.tailVkmPerNt / k.w[0]) < relCap, `${id} memory tail ${k.tailVkmPerNt / k.w[0]}`);
    }
    assert.ok(worstAbs < 6e-6, `absolute tail ${worstAbs}`);
    ok(`12 h memory cut: tail ≤ ${worstAbs.toExponential(1)} V/km per nT for every column; ≤ 1.5 % of the first response on land, < 5 % under the ocean`);
    const c = geoelectricSeries({ bNorthNt: new Array(300).fill(21000), bEastNt: new Array(300).fill(-1500), column: 'QUE' });
    assert.ok(c.eMagVkm.every((v) => v === 0), 'constant field ⇒ E ≡ 0');
    ok('a constant field (any baseline) gives E exactly 0 — the observatory level never enters');
    const bx = STORM.bx.slice(0, 600), by = STORM.by.slice(0, 600);
    const a = geoelectricSeries({ bNorthNt: bx, bEastNt: by, column: 'CP2' });
    const b = geoelectricSeries({ bNorthNt: bx.map((v) => 3 * v + 7), bEastNt: by.map((v) => 3 * v - 2), column: 'CP2' });
    for (let i = 0; i < 600; i++) assert.ok(Math.abs(b.eNorthVkm[i] - 3 * a.eNorthVkm[i]) < 1e-12 && Math.abs(b.eEastVkm[i] - 3 * a.eEastVkm[i]) < 1e-12);
    const th = 0.7, cs = Math.cos(th), sn = Math.sin(th);
    const rot = geoelectricSeries({ bNorthNt: bx.map((v, i) => cs * v - sn * by[i]), bEastNt: bx.map((v, i) => sn * v + cs * by[i]), column: 'CP2' });
    for (let i = 0; i < 600; i++) {
        assert.ok(Math.abs(rot.eNorthVkm[i] - (cs * a.eNorthVkm[i] - sn * a.eEastVkm[i])) < 1e-12);
        assert.ok(Math.abs(rot.eMagVkm[i] - a.eMagVkm[i]) < 1e-12);
    }
    ok('linear (3B + const ⇒ 3E) and isotropic (rotating B rotates E by the same angle)');
    // Energy must flow INTO the ground. For a ROTATING field (B_n = cos, B_e =
    // sin, period T) the mean downward Poynting flux ∝ ⟨E_n·B_e − E_e·B_n⟩ =
    // Re Z·|B|²/μ₀ > 0. Writing E_e = +Z·H_n instead (the classic sign slip)
    // makes the two terms cancel to ≈ 0 — that is the negative control.
    const T = 1800, n = 1440, Bn = [], Be = [];
    for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * i * 60 / T; Bn.push(30 * Math.cos(ph)); Be.push(30 * Math.sin(ph)); }
    const r = geoelectricSeries({ bNorthNt: Bn, bEastNt: Be, column: 'QUE' });
    let S = 0, Sflip = 0;
    for (let i = n - 4 * T / 60; i < n; i++) {
        S += r.eNorthVkm[i] * Be[i] - r.eEastVkm[i] * Bn[i];
        Sflip += r.eNorthVkm[i] * Be[i] + r.eEastVkm[i] * Bn[i];   // E_e sign flipped
    }
    assert.ok(S > 0, 'energy flows INTO the ground');
    assert.ok(Math.abs(Sflip) < 0.02 * S, `flipped-sign control ${Sflip / S}`);
    ok(`sign: net Poynting flux into the ground > 0 (E_n = +Z·H_e, E_e = −Z·H_n); with E_e flipped it cancels to ${(Sflip / S).toExponential(1)}`);
}

// ── E. steady sinusoid ──────────────────────────────────────────────────────
// Two separate claims, because they are two separate errors:
//  (1) THE METHOD: with B piecewise linear between samples, the exact discrete
//      transfer is W(f) = Σ_p Z(f + p/dt)·sinc²(f·dt + p) — images weighted up
//      by |Z| ∝ √f and aliased back. That, not Z(f), is what the convolution
//      must converge to as the memory grows (and it does, monotonically).
//  (2) THE SHIPPED NUMBER: with the 12 h memory, E vs the continuous |Z|·B/μ₀
//      is within 1 % and 2° for periods ≥ 30 min (measured below) — far inside
//      the factor-of-several uncertainty of any 1-D ground column.
// (The ramp response itself is checked against Stehfest in section C.)
console.log('E. steady sinusoid');
{
    const fitSine = (w, T, n = 2880, A = 50) => {
        const b = Array.from({ length: n }, (_, i) => A * Math.sin(2 * Math.PI * i * 60 / T));
        const E = new Float64Array(n);
        for (let i = 1; i < n; i++) { let acc = 0; for (let j = 0; j < Math.min(i, w.length); j++) acc += w[j] * (b[i - j] - b[i - j - 1]); E[i] = acc; }
        let ss = 0, sc = 0, cc = 0, es = 0, ec = 0;
        for (let i = n - Math.round(2 * T / 60); i < n; i++) {
            const ph = 2 * Math.PI * i * 60 / T, S = Math.sin(ph), C = Math.cos(ph);
            ss += S * S; sc += S * C; cc += C * C; es += E[i] * S; ec += E[i] * C;
        }
        const det = ss * cc - sc * sc, a = (es * cc - ec * sc) / det, c = (ec * ss - es * sc) / det;
        return { amp: Math.hypot(a, c) / (A * 1e-9 / MU0 * 1e3), lead: Math.atan2(c, a) * 180 / Math.PI };
    };
    const discrete = (L, T) => {
        let re = 0, im = 0;
        for (let p = -20000; p <= 20000; p++) {
            const fp = 1 / T + p / 60, x = Math.PI * fp * 60, k = (Math.sin(x) / x) ** 2;
            const z = layeredImpedance(L, 1 / Math.abs(fp));
            re += z.re * k; im += (fp >= 0 ? z.im : -z.im) * k;
        }
        return { amp: Math.hypot(re, im), lead: Math.atan2(im, re) * 180 / Math.PI };
    };
    for (const [id, T] of [['QUE', 3600], ['CP2', 3600], ['PT1', 1800]]) {
        const L = groundColumn(id), Z = impedanceSummary(L, T);
        const shipped = fitSine(impulseResponse(L).w, T);
        const ea = rel(shipped.amp, Z.magOhm), ep = Math.abs(shipped.lead - Z.phaseDeg);
        assert.ok(ea < 0.01 && ep < 2, `${id} T=${T}: ${ea} / ${ep}°`);
        const W = discrete(L, T);
        const longer = fitSine(impulseResponse(L, 60, { keep: 2160 }).w, T);
        const d720 = Math.abs(shipped.lead - W.lead), d2160 = Math.abs(longer.lead - W.lead);
        assert.ok(d2160 < d720 && rel(longer.amp, W.amp) < rel(shipped.amp, W.amp), `${id}: does not converge to W`);
        ok(`${id} T = ${T / 60} min: shipped E within ${(ea * 100).toFixed(2)} % / ${ep.toFixed(2)}° of |Z|; converges to the exact discrete transfer (phase gap ${d720.toFixed(2)}° → ${d2160.toFixed(2)}° as memory 12 → 36 h)`);
    }
    const L = groundColumn('PT1'), Z = impedanceSummary(L, 600), r = fitSine(impulseResponse(L).w, 600);
    console.log(`    (report, not gated) PT1 at T = 10 min: ${((r.amp / Z.magOhm - 1) * 100).toFixed(2)} % / ${(r.lead - Z.phaseDeg).toFixed(2)}° vs |Z|`);
}

// ── F. warm-up ──────────────────────────────────────────────────────────────
console.log('F. warm-up (missing history)');
{
    const N = STORM.bx.length, report = [];
    for (const id of ['QUE', 'GRAYVER-LAND', 'CP2', 'BR1', 'PT1', 'BOU']) {
        const full = geoelectricSeries({ bNorthNt: STORM.bx, bEastNt: STORM.by, column: id });
        let rms = 0; for (let i = 1000; i < N; i++) rms += full.eMagVkm[i] ** 2; rms = Math.sqrt(rms / (N - 1000));
        let err = 0; const starts = [800, 1200, 1600, 2000, 2400];
        for (const s0 of starts) {
            const part = geoelectricSeries({ bNorthNt: STORM.bx.slice(s0), bEastNt: STORM.by.slice(s0), column: id });
            err += (part.eNorthVkm[WARMUP_SAMPLES] - full.eNorthVkm[s0 + WARMUP_SAMPLES]) ** 2
                 + (part.eEastVkm[WARMUP_SAMPLES] - full.eEastVkm[s0 + WARMUP_SAMPLES]) ** 2;
        }
        const f = Math.sqrt(err / starts.length) / rms;
        assert.ok(f < 0.12, `${id} history error ${f}`);
        report.push(`${id} ${(f * 100).toFixed(1)}%`);
    }
    ok(`after the ${WARMUP_SAMPLES}-min warm-up, missing history is < 12 % of rms |E|: ${report.join(', ')}`);
}

// ── G. gaps ─────────────────────────────────────────────────────────────────
console.log('G. gaps');
{
    const v = Array.from({ length: 40 }, (_, i) => i * 2);
    for (let i = 10; i < 10 + MAX_BRIDGE_SAMPLES; i++) v[i] = null;          // bridged
    for (let i = 25; i < 25 + MAX_BRIDGE_SAMPLES + 1; i++) v[i] = null;      // splits
    const s = segmentSeries(v);
    assert.deepEqual(s.segments, [{ start: 0, end: 25 }, { start: 31, end: 40 }]);
    assert.equal(s.values[12], 24); assert.equal(s.bridged[12], 1); assert.equal(s.bridged[9], 0);
    const e = geoelectricSeries({ bNorthNt: v, bEastNt: v.map((x) => (x === null ? null : -x)), column: 'QUE' });
    for (let i = 25; i < 31; i++) assert.equal(e.eMagVkm[i], null, 'unknown E is null, not 0');
    assert.equal(e.warmup[31], 1, 'the next segment restarts its warm-up');
    assert.equal(e.eMagVkm[31], 0, 'a fresh segment starts from rest');
    ok(`≤ ${MAX_BRIDGE_SAMPLES}-min gaps bridged and flagged; longer gaps split, E null inside, warm-up restarts`);
    const half = geoelectricSeries({ bNorthNt: v.map((x, i) => (i === 3 ? null : x)), bEastNt: v, column: 'QUE' });
    assert.equal(half.bridged[3], 1, 'a sample missing EITHER component is a gap for both');
    ok('a sample with one component missing is a gap for both (never a half-computed E)');
}

// ── H. TPL-007 ──────────────────────────────────────────────────────────────
console.log('H. TPL-007 planning context');
{
    assert.equal(tpl007Alpha(20), 0.1); assert.equal(tpl007Alpha(80), 1);
    assert.ok(Math.abs(tpl007Alpha(60) - 0.001 * Math.exp(6.9)) < 1e-15);
    assert.ok(Math.abs(tpl007Alpha(-45) - 0.177) < 1e-3, 'bezpy notes 0.177 at 45°');
    assert.equal(tpl007Planning('GRAYVER-LAND', 50), null, 'no β is invented');
    const p = tpl007Planning('BOU', 48.5);
    assert.ok(Math.abs(p.benchmarkVkm - 8 * tpl007Alpha(48.5) * 0.28) < 1e-12);
    ok('α = 0.001·e^{0.115|L|} clipped [0.1, 1]; benchmark 8αβ only for columns with a published β');
    // Spectral β proxy: geometric-mean |Z| over 1–60 min, relative to Quebec.
    const band = (L) => { let s = 0, n = 0; for (let T = 60; T <= 3600; T *= 1.1) { s += Math.log(impedanceSummary(L, T).magOhm); n++; } return Math.exp(s / n); };
    const ids = Object.keys(TPL007_BETA), q = band(groundColumn('QUE'));
    const spearman = (a, b) => {
        const rk = (x) => { const o = x.map((v, i) => [v, i]).sort((p, r) => p[0] - r[0]); const r = []; o.forEach(([, i], k) => { r[i] = k; }); return r; };
        const ra = rk(a), rb = rk(b), n = a.length;
        return 1 - 6 * ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0) / (n * (n * n - 1));
    };
    const table = ids.map((id) => TPL007_BETA[id][0]);
    const proxy = ids.map((id) => band(groundColumn(id)) / q);
    const rho = spearman(table, proxy);
    assert.ok(rho > 0.95, `rank correlation ${rho}`);
    // NEGATIVE CONTROL: the same proxy on every column turned UPSIDE DOWN.
    const flipped = ids.map((id) => { const L = groundColumn(id); const up = [...L.slice(0, -1)].reverse(); return band([...up, L[L.length - 1]]) / q; });
    const rhoBad = spearman(table, flipped);
    assert.ok(rhoBad < 0.6, `control ${rhoBad}`);
    ok(`our |Z| proxy ranks the 22 models like TPL-007 Table 3: Spearman ${rho.toFixed(3)} (upside-down columns: ${rhoBad.toFixed(3)})`);
}

// ── I. nowcast + relay ──────────────────────────────────────────────────────
console.log('I. nowcast');
{
    const n = 600, t0 = Date.UTC(2026, 10, 18, 0, 0);
    const times = Array.from({ length: n }, (_, i) => new Date(t0 + i * 60000).toISOString().replace('.000', ''));
    const mk = (iaga, lat, lon, withY = true) => ({
        iaga, name: iaga, geodeticLatitude: lat, geodeticLongitude: lon, times,
        x: STORM.bx.slice(0, n).map((v) => 20000 + v), y: withY ? STORM.by.slice(0, n).map((v) => 4000 + v) : null,
    });
    // Synthetic coordinates — test data, NOT a station table.
    const payload = { data: { updated: times[n - 1], missing: ['SJG'], stations: [mk('BOU', 40.1, 254.8), mk('ZZZ', 38.2, 283.2), mk('YYY', 21.3, 202.0, false)] } };
    const nc = nowcastFromPayload(payload);
    assert.deepEqual(nc.skipped, [{ code: 'YYY', reason: 'no-east-component' }]);
    const [bou, zzz] = nc.stations;
    assert.equal(bou.column.id, 'BOU'); assert.equal(bou.column.basis, 'observatory-model');
    assert.equal(zzz.column.id, 'GRAYVER-LAND'); assert.equal(zzz.column.basis, 'global-default');
    assert.match(zzz.column.note, /global-average/);
    assert.ok(bou.tpl007 && zzz.tpl007 === null, 'TPL-007 only where a β exists');
    assert.ok(bou.latest.eMagVkm > 0 && !bou.latest.warmup && bou.peakLastHourVkm >= bou.latest.eMagVkm);
    assert.ok(Math.abs(bou.geomagLatDeg) > 30 && Math.abs(bou.geomagLatDeg) < 60, `dipole lat ${bou.geomagLatDeg}`);
    assert.match(nc.label, /Not a measured E/);
    assert.equal(columnFor('ZZZ', { ZZZ: 'CP2' }).basis, 'explicit');
    const short = stationNowcast({ ...mk('BOU', 40.1, 254.8), times: times.slice(0, 100), x: mk('BOU').x.slice(0, 100), y: mk('BOU').y.slice(0, 100) });
    assert.equal(short.latest.warmup, true, 'a short window is flagged warm-up');
    ok('nowcast: column by id (observatory model / explicit / flagged global default), skips Y-less sites, warm-up flagged, label carried');
    let asked = null;
    const fake = async (url) => { asked = url; return { ok: true, json: async () => payload }; };
    const live = await fetchGeoelectricNowcast({ fetchImpl: fake });
    assert.ok(asked.includes(`minutes=${NOWCAST_WINDOW_MIN}`) && live.stations.length === 2);
    ok(`fetches ${NOWCAST_WINDOW_MIN} min through TIGA's own fetchObservatories`);
}
{   // The relay: Y passes through; a site with no Y sends null, never a copy of X.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const id = new URL(url).searchParams.get('id');
        const series = [{ id: 'X', values: [1, 2, null] }];
        if (id !== 'HON') series.push({ id: 'Y', values: [5, null, 7] });
        return new Response(JSON.stringify({
            times: ['2026-11-18T00:00:00Z', '2026-11-18T00:01:00Z', '2026-11-18T00:02:00Z'],
            metadata: { station: { name: id, geometry: { coordinates: [-105.2, 40.1, 1682] } } }, values: series,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const { default: handler } = await import('../api/geomag/observatories.js');
        const res = await handler(new Request('https://x.test/api/geomag/observatories?minutes=30'));
        const body = await res.json();
        const bou = body.data.stations.find((s) => s.iaga === 'BOU'), hon = body.data.stations.find((s) => s.iaga === 'HON');
        assert.deepEqual(bou.y, [5, null, 7]); assert.deepEqual(bou.x, [1, 2, null]);
        assert.equal(hon.y, null);
        ok('relay: `y` passes through with gaps kept; a site without Y sends null (x unchanged for TIGA)');
    } finally { globalThis.fetch = realFetch; }
}

console.log(`\nearth-interior-geoelectric: ${passed} checks passed`);
