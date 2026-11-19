#!/usr/bin/env node
/**
 * earth-interior-raytrace.mjs — gate for js/earth-interior/raytrace.js
 * (INNER_EARTH_PLAN.md §10 T1). Run: node tests/earth-interior-raytrace.mjs
 *
 * Oracles the kernel did not produce:
 *   A. a uniform sphere — straight chords, closed form, exact
 *   B. RK4 EIKONAL SHOOTING (d/ds(n·t) = ∇n, integrated in the plane) through a
 *      smooth model — a different physics formulation entirely
 *   C. direct quadrature on PREM's OWN polynomials (premAt), with the 1/√
 *      turning-point singularity removed by r = r_t + u² — measures the
 *      kernel's Bullen-shell approximation on the real model
 *   D. the τ-p identity dT/dΔ = p along every branch
 *   E. PREM's structure: the P shadow zone, the PKP caustic, PKIKP, S stopping
 *      at the liquid core — with a NO-CORE negative control in which the
 *      shadow must vanish
 *   F. the drawn path ends where the ray's own Δ says, turns at its own r_t
 */

import assert from 'node:assert/strict';
import { R_EARTH_KM, premAt, PREM_REGIONS } from '../js/earth-interior/prem.js';
import {
    buildShells, premShells, traceRay, travelTimeBranches, rayPath, maxRayParameter, arrivalsAt,
} from '../js/earth-interior/raytrace.js';

let passed = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); passed++; };
const DEG = Math.PI / 180;

// ── A. uniform sphere ───────────────────────────────────────────────────────
{
    const v = 6, R = R_EARTH_KM;
    const sh = buildShells(() => v, [{ name: 'Uniform', rInnerKm: 0, rOuterKm: R }], 50);
    let worst = 0;
    for (const p of [0, 50, 200, 500, 900, 1000]) {
        const r = traceRay(p, { shells: sh });
        const rt = p * v;
        const D = 2 * Math.acos(rt / R), T = 2 * Math.sqrt(R * R - rt * rt) / v;
        worst = Math.max(worst, Math.abs(r.deltaRad - D), Math.abs(r.timeS - T) / T);
    }
    assert.ok(worst < 1e-12, `uniform ${worst}`);
    ok(`uniform sphere: Δ = 2·acos(pv/R), T = chord/v to ${worst.toExponential(1)} (p = 0 … 1000 s/rad)`);
}

// ── B. RK4 eikonal shooting through a smooth model ─────────────────────────
{
    const R = R_EARTH_KM, vf = (r) => 13 - 7 * (r / R) ** 2;                  // no discontinuities
    const sh = buildShells((r) => vf(r), [{ name: 'Smooth', rInnerKm: 0, rOuterKm: R }], 2);
    const shoot = (p) => {
        // Start at the surface, angle from the vertical i0 with sin i0 = p·v(R)/R.
        const i0 = Math.asin(p * vf(R) / R);
        let x = 0, y = R, tx = Math.sin(i0), ty = -Math.cos(i0), T = 0;
        const ds = 0.5;   // km
        const nAt = (px, py) => 1 / vf(Math.hypot(px, py));
        const grad = (px, py) => {   // ∇n, analytic: n = 1/v(r)
            const r = Math.hypot(px, py), dv = -14 * r / (R * R), dn = -dv / vf(r) ** 2;
            return [dn * px / r, dn * py / r];
        };
        // Integrate d(n t)/ds = ∇n with t a unit tangent: state (x, y, qx=n tx, qy=n ty).
        let qx = nAt(x, y) * tx, qy = nAt(x, y) * ty;
        const f = (s) => { const n = nAt(s[0], s[1]); const g = grad(s[0], s[1]); return [s[2] / n, s[3] / n, g[0], g[1], n]; };
        for (let k = 0; k < 4e6; k++) {
            const s0 = [x, y, qx, qy];
            const k1 = f(s0);
            const k2 = f(s0.map((v, i) => v + 0.5 * ds * k1[i]));
            const k3 = f(s0.map((v, i) => v + 0.5 * ds * k2[i]));
            const k4 = f(s0.map((v, i) => v + ds * k3[i]));
            const nx = x + ds / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
            const ny = y + ds / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
            qx += ds / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
            qy += ds / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
            T += ds / 6 * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]);
            if (k > 10 && Math.hypot(nx, ny) >= R) {
                // Linear back-off to the exact exit.
                const r0 = Math.hypot(x, y), r1 = Math.hypot(nx, ny), f0 = (R - r0) / (r1 - r0);
                const ex = x + f0 * (nx - x), ey = y + f0 * (ny - y);
                T -= (1 - f0) * ds * nAt(ex, ey);
                return { delta: Math.atan2(ex, ey), T };
            }
            x = nx; y = ny;
        }
        throw new Error('ray never surfaced');
    };
    let worst = 0;
    for (const p of [200, 500, 800, 1000]) {
        const a = traceRay(p, { shells: sh }), b = shoot(p);
        worst = Math.max(worst, Math.abs(a.deltaRad - b.delta) / b.delta, Math.abs(a.timeS - b.T) / b.T);
    }
    assert.ok(worst < 2e-5, `eikonal ${worst}`);
    ok(`smooth model: τ-p Bullen shells ≡ RK4 eikonal ray shooting to ${worst.toExponential(1)} (relative Δ and T)`);
}

// ── C. PREM: kernel vs direct quadrature on the polynomials ────────────────
const R = R_EARTH_KM;
const regionsDry = PREM_REGIONS.slice(0, -1).map((g, i, a) => (i === a.length - 1 ? { ...g, rOuterKm: R } : g));
function etaReg(k, r, wave) {
    const g = regionsDry[k], side = r <= g.rInnerKm + 1e-9 ? 'above' : 'below';
    const s = premAt(r, { ocean: false, side });
    return r / (wave === 'S' ? s.vsKmS : s.vpKmS);
}
function quad(p, wave = 'P') {
    // Find the turning point: walk regions from the surface down.
    let D = 0, T = 0;
    for (let k = regionsDry.length - 1; k >= 0; k--) {
        const g = regionsDry[k];
        if (etaReg(k, g.rOuterKm, wave) < p) break;              // turns at this interface
        let lo = g.rInnerKm;
        const turnsHere = lo === 0 || etaReg(k, lo, wave) < p;
        if (turnsHere) {   // bisect η = p inside the region
            let a = lo, b = g.rOuterKm;
            for (let it = 0; it < 200; it++) { const m = 0.5 * (a + b); if (etaReg(k, m, wave) < p) a = m; else b = m; }
            lo = b;
        }
        // ∫_lo^hi f(r) dr with r = lo + u² (removes the √ singularity at a turning point).
        const hi = g.rOuterKm, U = Math.sqrt(hi - lo), N = 4000;
        let sd = 0, st = 0;
        for (let i = 0; i <= N; i++) {
            const u = U * i / N, r = lo + u * u, w = (i === 0 || i === N) ? 1 : (i % 2 ? 4 : 2);
            const e = etaReg(k, Math.max(r, 1e-6), wave), q = Math.sqrt(Math.max(e * e - p * p, 0));
            let fd, ft;
            if (i === 0 && turnsHere) {   // limit u → 0: 2u/√(η²−p²) → 2/√(2η η'), use a tiny offset
                const r2 = lo + (U / N) ** 2 * 1e-4, e2 = etaReg(k, r2, wave);
                const q2 = Math.sqrt(Math.max(e2 * e2 - p * p, 1e-300)), u2 = Math.sqrt(r2 - lo);
                fd = 2 * u2 * p / (r2 * q2); ft = 2 * u2 * e2 * e2 / (r2 * q2);
            } else { fd = 2 * u * p / (r * q); ft = 2 * u * e * e / (r * q); }
            sd += w * fd; st += w * ft;
        }
        D += sd * U / N / 3; T += st * U / N / 3;
        if (turnsHere) break;
    }
    return { delta: 2 * D, T: 2 * T };
}
{
    let wD = 0, wT = 0;
    for (const p of [100, 300, 450, 600, 700, 800, 900, 1000]) {
        const a = traceRay(p), b = quad(p);
        wD = Math.max(wD, Math.abs(a.deltaRad - b.delta) / DEG); wT = Math.max(wT, Math.abs(a.timeS - b.T));
    }
    assert.ok(wD < 0.01 && wT < 0.05, `PREM quadrature Δ ${wD}° T ${wT} s`);
    ok(`PREM, 5-km Bullen shells vs quadrature on the polynomials: Δ to ${wD.toFixed(4)}°, T to ${wT.toFixed(3)} s (8 rays, mantle + core)`);
}

// ── D. τ-p identity ─────────────────────────────────────────────────────────
{
    const branches = travelTimeBranches({ wave: 'P', n: 3000 });
    let worst = 0, n = 0;
    for (const rays of Object.values(branches)) {
        for (let i = 2; i < rays.length; i++) {
            const a = rays[i - 2], b = rays[i - 1], c = rays[i];
            const dD = c.deltaRad - a.deltaRad;
            if (Math.abs(dD) < 1e-6 || b.turnRegion !== a.turnRegion || b.turnRegion !== c.turnRegion) continue;
            // A caustic (Δ(p) reverses) makes a central difference ill-posed — skip the reversal itself.
            if ((b.deltaRad - a.deltaRad) * (c.deltaRad - b.deltaRad) <= 0) continue;
            worst = Math.max(worst, Math.abs((c.timeS - a.timeS) / dD - b.p) / b.p); n++;
        }
    }
    assert.ok(worst < 1e-3 && n > 2000, `τ-p ${worst} over ${n}`);
    ok(`dT/dΔ = p along every P branch (${n} triples, worst ${worst.toExponential(1)})`);
}

// ── E. PREM structure + the no-core negative control ───────────────────────
{
    const B = travelTimeBranches({ wave: 'P' });
    const span = (k) => { const d = B[k].map((r) => r.deltaDeg); return [Math.min(...d), Math.max(...d)]; };
    const [, pMaxD] = span('P'), [pkpMin] = span('PKP'), [pkikpMin, pkikpMax] = span('PKIKP');
    assert.ok(pMaxD > 96 && pMaxD < 100, `P ends ${pMaxD}`);
    assert.ok(pkpMin > 142 && pkpMin < 147, `PKP caustic ${pkpMin}`);
    assert.ok(pkikpMin > 110 && pkikpMin < 120 && Math.abs(pkikpMax - 180) < 1e-9);
    const vert = traceRay(0);
    assert.equal(vert.phase, 'PKIKP'); assert.ok(Math.abs(vert.deltaDeg - 180) < 1e-9);
    assert.ok(vert.timeS > 1205 && vert.timeS < 1215, `PKIKP(180) ${vert.timeS}`);
    ok(`P shadow: mantle P ends at ${pMaxD.toFixed(2)}°, PKP caustic at ${pkpMin.toFixed(2)}°, PKIKP ${pkikpMin.toFixed(1)}–180° (T(180°) ${vert.timeS.toFixed(1)} s)`);
    const S = travelTimeBranches({ wave: 'S' });
    assert.deepEqual(Object.keys(S), ['S'], 'no S phase crosses the liquid outer core');
    const sMax = Math.max(...S.S.map((r) => r.deltaDeg));
    assert.ok(sMax > 99 && sMax < 105, `S ends ${sMax}`);
    assert.equal(traceRay(100, { wave: 'S' }).phase, 'S→core');
    ok(`S: mantle S ends at ${sMax.toFixed(2)}°; a steep S ray reaches the liquid core and stops (no shear wave crosses it)`);
    // NEGATIVE CONTROL: no core — the lower-mantle law continued to the centre. The shadow must vanish.
    const lm = PREM_REGIONS.find((g) => g.name === 'D″');
    const poly = (c, x) => c.reduceRight((s, ci) => s * x + ci, 0);
    const noCore = buildShells((r, k) => (k === 0 ? poly(lm.vp, r / R) : premAt(r, { ocean: false, side: r <= regionsDry[k + 1].rInnerKm + 1e-9 ? 'above' : 'below' }).vpKmS),
        [{ name: 'No core', rInnerKm: 0, rOuterKm: 3480 }, ...regionsDry.slice(2)], 5);
    let maxD = 0;
    for (let i = 0; i <= 600; i++) { const r = traceRay(1098 * i / 600 * (1 - 1e-9), { shells: noCore }); if (r) maxD = Math.max(maxD, r.deltaDeg); }
    assert.ok(maxD > 179.9, `no-core reach ${maxD}`);
    ok(`negative control: with no core, direct P reaches ${maxD.toFixed(1)}° — no shadow zone; the core is what makes it`);
}

// ── F. drawn paths agree with the ray ──────────────────────────────────────
{
    for (const p of [0, 150, 400, 700, 1000]) {
        const path = rayPath(p);
        const end = path.points.at(-1);
        assert.ok(Math.abs(end.thetaRad - path.deltaRad) < 1e-9 && Math.abs(end.rKm - R) < 1e-9, `path end ${p}`);
        const minR = Math.min(...path.points.map((q) => q.rKm));
        assert.ok(Math.abs(minR - path.turnRKm) < 1e-6, `turn ${p}`);
        for (let i = 1; i < path.points.length; i++) assert.ok(path.points[i].thetaRad >= path.points[i - 1].thetaRad - 1e-12);
    }
    const deep = rayPath(400, { sourceDepthKm: 600 });
    assert.ok(deep && Math.abs(deep.points[0].rKm - (R - 600)) < 1e-9 && Math.abs(deep.points.at(-1).thetaRad - deep.deltaRad) < 1e-9);
    assert.equal(traceRay(maxRayParameter() * 1.01), null, 'p above η at the source cannot leave it');
    const arr = arrivalsAt(60, travelTimeBranches({ wave: 'P' }));
    assert.ok(arr.length >= 1 && arr[0].phase === 'P');
    ok('paths end at the ray\'s own Δ on the surface, bottom out at its own turning radius, θ monotone; deep sources and p > η(source) handled');
}

console.log(`\nearth-interior-raytrace: ${passed} checks passed`);
