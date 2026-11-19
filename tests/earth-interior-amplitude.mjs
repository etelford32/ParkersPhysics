#!/usr/bin/env node
/**
 * earth-interior-amplitude.mjs — gate for js/earth-interior/amplitude.js
 * (phase amplitudes + the station-elevation correction).
 * Run: node tests/earth-interior-amplitude.mjs
 *
 * Oracles the kernel did not produce:
 *   A. ENERGY CONSERVATION at every interface type (solid–solid, solid–liquid,
 *      liquid–solid, free surface, SH), pre- and post-critical — the Zoeppritz
 *      solve never imposes it
 *   B. closed forms: normal-incidence impedance contrast, a welded interface
 *      between identical media transmits everything, the free surface reflects
 *      everything, SH off a fluid is total
 *   C. ray-tube spreading in a UNIFORM medium is exactly 1/L (the chord)
 *   D. t* by an independent quadrature on PREM's Q along the same path, and
 *      the empirical scale (t*_P ≈ 1 s, t*_S ≈ 4–5 s teleseismically)
 *   E. structure: PKiKP is tens of dB below P at short range, P decays with
 *      distance, a caustic and a diffracted phase are refused, never sized
 *   F. station elevation: the exact raised-receiver chord (first order in h),
 *      with the vertical h/v negative control
 */

import assert from 'node:assert/strict';
import { R_EARTH_KM, premAt } from '../js/earth-interior/prem.js';
import { buildShells } from '../js/earth-interior/raytrace.js';
import { createPhaseModel, premPhaseModel, travelTimeTable, arrivals } from '../js/earth-interior/phases.js';
import {
    psvCoefficients, shCoefficients, INTERFACES, SURFACE_MEDIUM, spreading, tStar, qAt, phaseAmplitude, visibility,
    elevationCorrection, interfaceEvents,
} from '../js/earth-interior/amplitude.js';
import { rayFor } from '../js/earth-interior/quake-model.js';

let passed = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); passed++; };
const DEG = Math.PI / 180, R = R_EARTH_KM;
const at = (r) => INTERFACES.find((f) => Math.abs(f.rKm - r) < 0.5);

// ── A. energy conservation ──────────────────────────────────────────────────
{
    const moho = at(6346.6), m670 = at(5701), cmb = at(3480), icb = at(1221.5);
    const cases = [
        ['P', moho.above, moho.below], ['S', moho.above, moho.below], ['P', moho.below, moho.above], ['S', moho.below, moho.above],
        ['P', m670.above, m670.below], ['S', m670.below, m670.above],
        ['P', cmb.above, cmb.below], ['S', cmb.above, cmb.below], ['P', cmb.below, cmb.above],
        ['P', icb.above, icb.below], ['P', icb.below, icb.above], ['S', icb.below, icb.above],
        ['P', SURFACE_MEDIUM, null], ['S', SURFACE_MEDIUM, null],
    ];
    let worst = 0, n = 0, post = 0;
    for (const [inc, from, to] of cases) {
        const v = inc === 'P' ? from.vp : from.vs;
        for (let k = 0; k < 60; k++) {
            const ph = (k / 60) / v * 0.999;
            const c = psvCoefficients(inc, from, to, ph);
            worst = Math.max(worst, Math.abs(c.R.P + c.R.S + c.T.P + c.T.S - 1)); n++;
            if (to && (ph * (to.vp || 0) > 1 || ph * (to.vs || 0) > 1 || (inc === 'S' && ph * from.vp > 1))) post++;
        }
    }
    let wsh = 0;
    for (const [f, t] of [[moho.above, moho.below], [moho.below, moho.above], [m670.above, m670.below]]) for (let k = 0; k < 60; k++) {
        const c = shCoefficients(f, t, (k / 60) / f.vs * 0.999); wsh = Math.max(wsh, Math.abs(c.R + c.T - 1));
    }
    assert.ok(worst < 1e-12 && wsh < 1e-12 && post > 50, `energy ${worst} sh ${wsh} post ${post}`);
    ok(`energy conserved at every interface type: P-SV worst ${worst.toExponential(1)} over ${n} cases (${post} post-critical), SH ${wsh.toExponential(1)}`);
}

// ── B. closed forms ─────────────────────────────────────────────────────────
{
    const m1 = { rho: 3300, vp: 8.1, vs: 4.5 }, m2 = { rho: 4400, vp: 10.8, vs: 5.9 };
    const c = psvCoefficients('P', m1, m2, 0), Z1 = m1.rho * m1.vp, Z2 = m2.rho * m2.vp;
    assert.ok(Math.abs(c.R.P - ((Z2 - Z1) / (Z2 + Z1)) ** 2) < 1e-12 && c.R.S < 1e-20 && c.T.S < 1e-20);
    const same = psvCoefficients('P', m1, m1, 0.05), sameS = psvCoefficients('S', m1, m1, 0.1);
    assert.ok(Math.abs(same.T.P - 1) < 1e-12 && Math.abs(sameS.T.S - 1) < 1e-12 && same.R.P < 1e-24);
    const fs = psvCoefficients('P', SURFACE_MEDIUM, null, 0);
    assert.ok(Math.abs(fs.R.P - 1) < 1e-12 && fs.R.S < 1e-20, 'free surface at normal incidence: P back as P, all of it');
    assert.equal(shCoefficients(at(3480).above, at(3480).below, 0.1).R, 1, 'SH off a fluid is total');
    ok(`closed forms: normal-incidence ((Z₂−Z₁)/(Z₂+Z₁))², identical media transmit all, free surface and SH-off-fluid reflect all`);
}

// ── C. uniform-medium spreading ────────────────────────────────────────────
{
    const v = 6, sh = buildShells(() => v, [{ name: 'U', rInnerKm: 0, rOuterKm: R }], 10);
    const m = createPhaseModel({ shellsP: sh, shellsS: sh, cmbKm: 0, icbKm: 0 });
    let worst = 0;
    let n = 0;
    for (const h of [0, 300, 1500]) for (const name of ['P', 'p']) for (const p of [80, 250, 500, 800]) {
        const rs = R - h, r = m.phaseRay(name, p, { sourceDepthKm: h });
        // Under 1° the kernel REFUSES by design (an epicentral focus) — not this check's business.
        if (!r || r.deltaRad < 1.5 * DEG) continue;
        n++;
        const d = 1e-4 * p, a = m.phaseRay(r.name, p - d, { sourceDepthKm: h }), b = m.phaseRay(r.name, p + d, { sourceDepthKm: h });
        const s = spreading(p, r.deltaRad, (b.deltaRad - a.deltaRad) / (2 * d), { rs, vs: v, vr: v, R });
        const L = Math.sqrt(rs * rs + R * R - 2 * rs * R * Math.cos(r.deltaRad));
        worst = Math.max(worst, Math.abs(s * L - 1));
    }
    assert.ok(worst < 1e-5 && n >= 14, `spreading ${worst} over ${n}`);
    ok(`uniform medium: ray-tube spreading ≡ 1/L, the straight chord, to ${worst.toExponential(1)} (surface and deep sources, up- and down-going)`);
}

// ── D. t* ───────────────────────────────────────────────────────────────────
const M = premPhaseModel(), T29 = travelTimeTable(29);
const firstRay = (D, ph, tab = T29, depth = 29) => { const a = arrivals(D, tab).find((x) => x.phase === ph); return a ? rayFor(a, depth, M) : null; };
{
    const rayP = firstRay(60, 'P'), rayS = firstRay(60, 'S');
    const tp = tStar(rayP), ts = tStar(rayS);
    // Independent quadrature: walk the travel-ordered nodes and integrate dt/Q with Q at the node MIDPOINT radius, P only.
    const { intervals } = M.samplePath(rayP, { sub: 3 });
    let q = 0; for (const iv of intervals) if (iv.dT) q += iv.dT / qAt('P', iv.rMid);
    assert.ok(Math.abs(q - tp.P) / tp.P < 0.01, `t* quadrature ${q} vs ${tp.P}`);
    assert.ok(tp.P > 0.6 && tp.P < 1.4 && tp.S === 0, `t*_P ${tp.P}`);
    assert.ok(ts.S / tp.P > 3 && ts.S / tp.P < 5.5, `t*_S/t*_P ${ts.S / tp.P}`);
    const qs = premAt(4000, { ocean: false });
    assert.equal(qAt('S', 4000), qs.qMu);
    assert.ok(qAt('P', 2000) === premAt(2000, { ocean: false }).qKappa, 'liquid core: Q_P is Q_κ');
    ok(`t* at 60°: P ${tp.P.toFixed(2)} s, S ${ts.S.toFixed(2)} s (ratio ${(ts.S / tp.P).toFixed(1)}; empirical ≈ 1 s and ≈ 4) — the same integral at 3× resolution agrees to 1 %`);
}

// ── E. structure ────────────────────────────────────────────────────────────
{
    const A = (D, ph) => phaseAmplitude(firstRay(D, ph), { sourceDepthKm: 29 });
    const p30 = A(30, 'P'), p80 = A(80, 'P'), pkikp40 = A(40, 'PKiKP');
    assert.ok(p30.amp > p80.amp, 'P decays with distance');
    assert.ok(visibility(pkikp40.amp, A(40, 'P').amp).db < -30, `PKiKP at 40° is a weak partial reflection: ${visibility(pkikp40.amp, A(40, 'P').amp).db}`);
    const ev = interfaceEvents(firstRay(150, 'PKIKP'));
    assert.ok(ev.filter((e) => e.rKm === 3480).length === 2 && ev.filter((e) => e.rKm === 1221.5).length === 2, 'PKIKP crosses the CMB and ICB twice each');
    const sks = interfaceEvents(firstRay(90, 'SKS')).filter((e) => e.rKm === 3480);
    assert.deepEqual(sks.map((e) => `${e.inc}${e.out}`), ['SP', 'PS'], 'SKS converts S→P going in and P→S coming out');
    const pp = interfaceEvents(firstRay(90, 'PP')).filter((e) => e.kind === 'surface');
    assert.equal(pp.length, 1);
    const diff = phaseAmplitude(M.diffractedRay('Pdiff', 10 * DEG, { sourceDepthKm: 29 }), { sourceDepthKm: 29 });
    assert.equal(diff.amp, null);
    // A caustic: PKP's B caustic near 145°. Some ray on the branch must be refused.
    const seg = T29.PKP[0];
    const refused = seg.filter((r) => Math.abs(r.deltaDeg - seg.reduce((a, b) => (b.deltaDeg < a.deltaDeg ? b : a)).deltaDeg) < 0.05)
        .map((r) => phaseAmplitude(r, { sourceDepthKm: 29 }));
    assert.ok(refused.some((x) => x.amp === null && /caustic/.test(x.reason)), 'the PKP caustic is refused, not sized');
    assert.equal(visibility(1, 1).label, 'strong'); assert.equal(visibility(1e-3, 1).label, 'very weak');
    ok(`structure: P decays 30°→80°; PKiKP at 40° is ${visibility(pkikp40.amp, A(40, 'P').amp).db.toFixed(0)} dB below P; PKIKP/SKS interface ledgers right; Pdiff and the PKP caustic are refused`);
}

// ── F. station elevation ────────────────────────────────────────────────────
{
    // Uniform sphere: source at depth, receiver raised by h above R at the SAME angle.
    const v = 5.8, crust = { rho: 2600, vp: v, vs: 3.2 };
    const chord = (rs, rr, D) => Math.sqrt(rs * rs + rr * rr - 2 * rs * rr * Math.cos(D));
    // First order in h: near grazing (a regional ray at 3°) the h² sin²i / 2L term is the
    // whole error, so the gate is ABSOLUTE everywhere and RELATIVE where incidence is steep.
    let worst = 0, ctrl = 0, abs = 0;
    for (const D of [0.05, 0.3, 0.8]) for (const h of [0.5, 2, 4]) {
        const rs = R - 30, L = chord(rs, R, D);
        // The ray's p at the receiver: p = R sin i / v, sin i from the chord geometry.
        const cosI = (R - rs * Math.cos(D)) / L, p = R * Math.sqrt(1 - cosI * cosI) / v;
        const exact = (chord(rs, R + h, D) - L) / v;
        const err = Math.abs(elevationCorrection(p, 'P', h, { crust }) - exact);
        abs = Math.max(abs, err);
        if (D >= 0.3) worst = Math.max(worst, err / exact);
        ctrl = Math.max(ctrl, Math.abs(h / v - exact) / exact);
    }
    assert.ok(worst < 1e-2 && abs < 5e-3, `elevation ${worst} abs ${abs}`);
    assert.ok(ctrl > 0.2, `vertical h/v control ${ctrl}`);
    assert.equal(elevationCorrection(500, 'P', 0), 0);
    assert.ok(elevationCorrection(500, 'S', 1) > elevationCorrection(500, 'P', 1), 'S is slower through the same metre');
    ok(`station elevation: h·√(1/v² − (p/R)²) ≡ the exact raised-receiver chord to ${(worst * 100).toFixed(2)} % (teleseismic) and ${(abs * 1000).toFixed(1)} ms (any); plain h/v misses by ${(ctrl * 100).toFixed(0)} % (control)`);
}

console.log(`\nearth-interior-amplitude: ${passed} checks passed`);
