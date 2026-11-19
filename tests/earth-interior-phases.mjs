#!/usr/bin/env node
/**
 * earth-interior-phases.mjs — gate for js/earth-interior/phases.js (every
 * phase, composed from legs) and js/earth-interior/ellipticity.js (Clairaut's
 * figure + the first-order ellipticity correction).
 * Run: node tests/earth-interior-phases.mjs
 *
 * Oracles the kernels did not produce:
 *   A. uniform media, closed form / Fermat: the up-going chord (law of
 *      cosines), pP and PP as MIRROR reflections found by minimising the
 *      path length over the bounce point, PcP off an inner sphere the same way
 *   B. PREM: the P phase ≡ raytrace.js; PcP at Δ = 0 ≡ 2∫dr/v by quadrature
 *      on PREM's polynomials; reciprocity ScP ≡ PcS for a surface source (and
 *      NOT for a deep one — the control); PP(Δ) = 2·P(Δ/2); Pdiff is the
 *      grazing PcP plus slowness × arc, continuous with it; dT/dΔ = p on every
 *      branch; SKS overtakes S where the textbook says
 *   C. Clairaut: Maclaurin (uniform body, ε = 5m/4) and Roche (point mass,
 *      ε = m/2) closed forms; PREM's hydrostatic figure
 *   D. ellipticity: the exact chord on a uniform ellipsoid (second-order
 *      error, and the slope term's NEGATIVE CONTROL), two-point RK4 ray
 *      shooting through a flattened smooth model, the −2 polar/equatorial
 *      ratio of the p = 0 diameter, geocentric geometry
 */

import assert from 'node:assert/strict';
import { R_EARTH_KM, premAt, PREM_REGIONS } from '../js/earth-interior/prem.js';
import { buildShells, traceRay } from '../js/earth-interior/raytrace.js';
import { createPhaseModel, premPhaseModel, travelTimeTable, arrivals, foldDeg, PHASES } from '../js/earth-interior/phases.js';
import {
    clairaut, premFigure, ellipticityCorrection, pathGeometry, geocentricLatDeg, WGS84_F,
} from '../js/earth-interior/ellipticity.js';

let passed = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); passed++; };
const DEG = Math.PI / 180, R = R_EARTH_KM;

// Golden-section minimum of f on [a, b].
function golden(f, a, b, it = 120) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    for (let i = 0; i < it; i++) { if (f(c) < f(d)) { b = d; } else { a = c; } c = b - g * (b - a); d = a + g * (b - a); }
    return 0.5 * (a + b);
}
const pt = (r, th) => [r * Math.sin(th), r * Math.cos(th)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ── A. uniform media ────────────────────────────────────────────────────────
{
    const v = 6, c = 3000;
    const sh = buildShells(() => v, [{ name: 'U', rInnerKm: 0, rOuterKm: R }], 10);
    const m = createPhaseModel({ shellsP: sh, shellsS: sh, cmbKm: c, icbKm: 0 });
    const h = 400, rs = R - h, S = pt(rs, 0);
    let worst = 0;
    // Up-going: a straight chord from the source to the surface.
    for (const p of [100, 300, 600, 900]) {
        const r = m.phaseRay('p', p, { sourceDepthKm: h });
        const T = dist(S, pt(R, r.deltaRad)) / v;
        worst = Math.max(worst, Math.abs(r.timeS - T));
    }
    // pP, PP, PcP: a reflected ray is a STATIONARY path over its bounce point (Fermat:
    // a minimum off a convex mirror, a maximum or a saddle off the inside of a sphere, and
    // pP has several). The oracle finds EVERY zero of dT/dφ on the mirror and the
    // kernel's ray must be one of them — it never sees the kernel's bounce point.
    const reflections = (A, B, rMirror, D) => {
        const T = (phi) => (dist(A, pt(rMirror, phi)) + dist(pt(rMirror, phi), B)) / v;
        const dT = (phi) => (T(phi + 1e-7) - T(phi - 1e-7)) / 2e-7;
        const lo = -0.2, hi = D + 0.2, N = 4000, out = [];
        for (let i = 0; i < N; i++) {
            let a = lo + (hi - lo) * i / N, b = lo + (hi - lo) * (i + 1) / N;
            if (dT(a) * dT(b) > 0) continue;
            for (let k = 0; k < 80; k++) { const mid = 0.5 * (a + b); if (dT(a) * dT(mid) <= 0) b = mid; else a = mid; }
            out.push(T(0.5 * (a + b)));
        }
        return out;
    };
    const near = (t, list) => Math.min(...list.map((x) => Math.abs(x - t)));
    for (const p of [520, 700, 950]) {   // above c/v = 500: the surface ray turns in the 'mantle'
        const r = m.phaseRay('pP', p, { sourceDepthKm: h });
        worst = Math.max(worst, near(r.timeS, reflections(S, pt(R, r.deltaRad), R, r.deltaRad)));
        const pp = m.phaseRay('PP', p);
        worst = Math.max(worst, near(pp.timeS, reflections(pt(R, 0), pt(R, pp.deltaRad), R, pp.deltaRad)));
    }
    for (const p of [60, 120, 300]) {
        const r = m.phaseRay('PcP', p, { sourceDepthKm: h });
        worst = Math.max(worst, near(r.timeS, reflections(S, pt(R, r.deltaRad), c, r.deltaRad)));
    }
    assert.ok(worst < 1e-6, `uniform ${worst}`);
    ok(`uniform medium: up-going p, pP, PP and PcP ≡ straight chords / Fermat mirror reflections to ${worst.toExponential(1)} s`);
}

// ── B. PREM ─────────────────────────────────────────────────────────────────
const M = premPhaseModel();
const T0 = travelTimeTable(0), T600 = travelTimeTable(600);
const first = (d, tab, ph) => arrivals(d, tab).find((a) => a.phase === ph);
{
    let w = 0;
    for (const p of [50, 300, 600, 900]) {
        const a = traceRay(p), b = M.phaseRay(a.phase === 'P' ? 'P' : a.phase, p);
        if (!b) continue;
        w = Math.max(w, Math.abs(a.deltaRad - b.deltaRad), Math.abs(a.timeS - b.timeS));
    }
    assert.ok(w < 1e-9, `P ≡ raytrace ${w}`);
    // PcP at Δ = 0: twice the vertical time from the CMB, by quadrature on PREM's polynomials.
    let q = 0; const n = 20000;
    for (let i = 0; i < n; i++) {
        const r = 3480 + (R - 3480) * (i + 0.5) / n;
        const g = PREM_REGIONS.find((x) => r > x.rInnerKm && r <= x.rOuterKm);
        q += (R - 3480) / n / premAt(r, { ocean: false }).vpKmS;
        void g;
    }
    const pcp0 = M.phaseRay('PcP', 0);
    assert.ok(Math.abs(pcp0.timeS - 2 * q) < 0.05 && pcp0.deltaRad === 0, `PcP(0) ${pcp0.timeS} vs ${2 * q}`);
    ok(`PREM P ≡ raytrace.js (${w.toExponential(1)}); PcP at Δ = 0 is 2∫dr/v (${pcp0.timeS.toFixed(2)} s vs quadrature ${(2 * q).toFixed(2)} s)`);
}
{
    // Reciprocity: a surface source and a surface receiver cannot tell ScP from PcS.
    let w = 0;
    for (const d of [10, 30, 50]) w = Math.max(w, Math.abs(first(d, T0, 'ScP').timeS - first(d, T0, 'PcS').timeS));
    assert.ok(w < 0.01, `ScP/PcS reciprocity ${w}`);
    const deep = Math.abs(first(30, T600, 'ScP').timeS - first(30, T600, 'PcS').timeS);
    assert.ok(deep > 20, `deep source must break the symmetry: ${deep}`);
    ok(`reciprocity: ScP ≡ PcS for a surface source (${w.toFixed(4)} s); a 600 km source breaks it by ${deep.toFixed(1)} s (negative control)`);
}
{
    // PP(Δ) = 2·P(Δ/2) for a surface source — at the FIRST-arrival branch.
    let w = 0;
    for (const d of [60, 90, 120, 150]) {
        const pp = arrivals(d, T0).filter((a) => a.phase === 'PP'), p = arrivals(d / 2, T0).filter((a) => a.phase === 'P');
        w = Math.max(w, Math.min(...pp.map((a) => Math.min(...p.map((b) => Math.abs(a.timeS - 2 * b.timeS))))));
    }
    assert.ok(w < 0.2, `PP ${w}`);
    // Pdiff = grazing PcP + p·arc, continuous with PcP at the graze.
    const seg = T0.Pdiff[0], g = seg[0], pcp = T0.PcP.flat().reduce((a, r) => (r.p > a.p ? r : a));
    assert.ok(Math.abs(g.deltaRad - pcp.deltaRad) < 1e-6 && Math.abs(g.timeS - pcp.timeS) < 1e-3, 'Pdiff starts at the grazing PcP');
    for (const r of seg) assert.ok(Math.abs(r.timeS - g.timeS - g.p * (r.deltaRad - g.deltaRad)) < 1e-9);
    assert.ok(Math.abs(g.p - M.grazingP('P')) < 1e-12 && g.p * DEG > 4.3 && g.p * DEG < 4.6, `Pdiff slowness ${g.p * DEG} s/°`);
    ok(`PP(Δ) = 2·P(Δ/2) to ${w.toFixed(3)} s; Pdiff starts on the grazing PcP (${g.deltaDeg.toFixed(2)}°) and runs at ${(g.p * DEG).toFixed(3)} s/°`);
}
{
    // dT/dΔ = p on every branch: probe each sampled ray at p ± δ (a tight local difference,
    // not the sweep's spacing — the sweep's own triples are curvature-limited near grazing).
    let worst = 0, n = 0;
    for (const [ph, segs] of Object.entries(T600)) {
        if (ph.endsWith('diff')) continue;
        for (const s of segs) for (let i = 1; i < s.length - 1; i += 7) {
            const p = s[i].p, d = 1e-4 * Math.max(1, p * 1e-2);
            const a = M.phaseRay(ph, p - d, { sourceDepthKm: 600 }), c = M.phaseRay(ph, p + d, { sourceDepthKm: 600 });
            if (!a || !c || Math.abs(c.deltaRad - a.deltaRad) < 2e-6) continue;   // at a caustic dΔ/dp → 0 and the quotient is rounding noise
            worst = Math.max(worst, Math.abs((c.timeS - a.timeS) / (c.deltaRad - a.deltaRad) - p) / Math.max(p, 20)); n++;
        }
    }
    assert.ok(worst < 1e-5 && n > 600, `τ-p ${worst} over ${n}`);
    ok(`dT/dΔ = p on every branch of every phase from a 600 km source (${n} rays, worst ${worst.toExponential(1)})`);
}
{
    // Structure: SKS appears near 64° and becomes earlier than S before ~85°.
    let cross = null;
    for (let d = 65; d <= 100; d += 0.25) {
        const s = first(d, T0, 'S'), k = first(d, T0, 'SKS');
        if (s && k && k.timeS < s.timeS) { cross = d; break; }
    }
    assert.ok(cross > 76 && cross < 86, `SKS overtakes S at ${cross}`);
    assert.ok(Math.abs(foldDeg(200) - 160) < 1e-12 && Math.abs(foldDeg(-20) - 20) < 1e-12);
    assert.ok(arrivals(170, T0).some((a) => a.phase === 'PP'), 'PP folds past 180° (195° rays arrive at 165°)');
    assert.ok(!('pP' in T0) && 'pP' in T600 && 'p' in T600 && !('p' in T0), 'depth phases only from a deep source');
    for (const ph of PHASES) assert.ok(ph.name in T0 || ph.name in T600, `${ph.name} exists somewhere`);
    ok(`SKS overtakes S at ${cross}°; Δ folds past 180°; depth phases exist only below the surface; all ${PHASES.length} phases trace`);
}

// ── C. Clairaut ─────────────────────────────────────────────────────────────
{
    const m = 0.00345;
    const mac = clairaut(() => 5500, [{ rInnerKm: 0, rOuterKm: R }], m);
    assert.ok(Math.abs(mac.surface / (1.25 * m) - 1) < 1e-9, 'Maclaurin');
    const roche = clairaut((r, k) => (k === 0 ? 1e9 : 0), [{ rInnerKm: 0, rOuterKm: R / 100 }, { rInnerKm: R / 100, rOuterKm: R }], m);
    assert.ok(Math.abs(roche.surface / (0.5 * m) - 1) < 1e-6, 'Roche');
    const f = premFigure();
    assert.ok(1 / f.surface > 298.5 && 1 / f.surface < 301.5, `PREM hydrostatic 1/${1 / f.surface}`);
    assert.ok(1 / f.epsAt(3480) > 388 && 1 / f.epsAt(3480) < 398, `CMB 1/${1 / f.epsAt(3480)}`);
    for (let i = 1; i < f.eps.length; i++) assert.ok(f.eps[i] >= f.eps[i - 1] - 1e-6 * f.surface, 'ε grows outward in a centrally condensed body');
    ok(`Clairaut: Maclaurin 5m/4 and Roche m/2 exact; PREM hydrostatic surface 1/${(1 / f.surface).toFixed(1)} (observed 1/298.26), CMB 1/${(1 / f.epsAt(3480)).toFixed(1)}`);
}

// ── D. ellipticity correction ───────────────────────────────────────────────
{
    // D1: uniform ellipsoid — the exact chord between two points ON it.
    const v = 6;
    const sh = buildShells(() => v, [{ name: 'U', rInnerKm: 0, rOuterKm: R }], 25);
    const m = createPhaseModel({ shellsP: sh, shellsS: sh, cmbKm: 0, icbKm: 0 });
    const onSurf = (th, e) => pt(R * (1 - (2 / 3) * e * 0.5 * (3 * Math.cos(th) ** 2 - 1)), th);
    const err = (e, opts) => {
        let w = 0;
        for (const [th, D] of [[0.3, 1.0], [1.2, 2.0], [0.1, 0.6], [2.0, 0.8]]) {
            const ray = m.phaseRay('P', R * Math.cos(D / 2) / v);
            const dT = ellipticityCorrection(ray, m, { thetaS: th, azimuthRad: Math.PI }, () => e, opts);
            const exact = dist(onSurf(th, e), onSurf(th + D, e)) / v;
            w = Math.max(w, Math.abs(ray.timeS + dT - exact) / Math.abs(exact - ray.timeS));
        }
        return w;
    };
    const e1 = err(1 / 300), e2 = err(1 / 150), ctrl = err(1 / 300, { slopeTerm: false });
    assert.ok(e1 < 0.01 && e2 / e1 > 1.6, `chord ${e1} / ${e2}`);
    assert.ok(ctrl > 0.2, `slope-term control ${ctrl}`);
    ok(`uniform ellipsoid: first-order δT ≡ the exact chord to ${(e1 * 100).toFixed(2)} % of the correction, error first order in ε (×${(e2 / e1).toFixed(1)} at 2ε); without the slope term it misses by ${(ctrl * 100).toFixed(0)} % (control)`);
}
{
    // D2: two-point RK4 shooting through a FLATTENED smooth model in the meridian plane.
    const v0 = (r) => 13 - 7 * (r / R) ** 2;
    const sh = buildShells(v0, [{ name: 'Smooth', rInnerKm: 0, rOuterKm: R }], 2);
    const m = createPhaseModel({ shellsP: sh, shellsS: sh, cmbKm: 0, icbKm: 0 });
    const P2 = (c) => 0.5 * (3 * c * c - 1);
    const run = (e0, thS, thR) => {
        const eps = (r) => e0 * (0.5 + 0.5 * (r / R) ** 2);
        const r0Of = (x, z) => { const r = Math.hypot(x, z), c = z / r; let r0 = r; for (let i = 0; i < 6; i++) r0 = r / (1 - (2 / 3) * eps(r0) * P2(c)); return r0; };
        const n = (x, z) => 1 / v0(r0Of(x, z));
        const hgr = 0.02;
        const grad = (x, z) => [(n(x + hgr, z) - n(x - hgr, z)) / (2 * hgr), (n(x, z + hgr) - n(x, z - hgr)) / (2 * hgr)];
        const rS = R * (1 - (2 / 3) * eps(R) * P2(Math.cos(thS))), S = pt(rS, thS);
        const shoot = (alpha) => {   // alpha: take-off angle from the local inward radial, toward increasing θ
            let [x, z] = S;
            const rh = [-Math.sin(thS), -Math.cos(thS)], th = [Math.cos(thS), -Math.sin(thS)];
            let t = [rh[0] * Math.cos(alpha) + th[0] * Math.sin(alpha), rh[1] * Math.cos(alpha) + th[1] * Math.sin(alpha)];
            let qx = n(x, z) * t[0], qz = n(x, z) * t[1], T = 0;
            const ds = 1;
            const f = (s) => { const nn = n(s[0], s[1]), g = grad(s[0], s[1]); return [s[2] / nn, s[3] / nn, g[0], g[1], nn]; };
            for (let k = 0; k < 40000; k++) {
                const s0 = [x, z, qx, qz];
                const k1 = f(s0), k2 = f(s0.map((v, i) => v + ds / 2 * k1[i])), k3 = f(s0.map((v, i) => v + ds / 2 * k2[i])), k4 = f(s0.map((v, i) => v + ds * k3[i]));
                const nx = x + ds / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), nz = z + ds / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
                const dT = ds / 6 * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]);
                qx += ds / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]); qz += ds / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
                if (k > 20 && r0Of(nx, nz) >= R) {
                    const a0 = r0Of(x, z), a1 = r0Of(nx, nz), fr = (R - a0) / (a1 - a0);
                    return { th: Math.atan2(x + fr * (nx - x), z + fr * (nz - z)), T: T + fr * dT };
                }
                x = nx; z = nz; T += dT;
            }
            throw new Error('never surfaced');
        };
        // Secant on the take-off angle until the ray surfaces at θr.
        const D = thR - thS;
        const ray0 = (() => { let a = 0, b = R / v0(R) * 0.999; for (let i = 0; i < 80; i++) { const mid = 0.5 * (a + b); if (m.phaseRay('P', mid).deltaRad > D) a = mid; else b = mid; } return m.phaseRay('P', 0.5 * (a + b)); })();
        let a1 = Math.asin(ray0.p * v0(R) / R), a2 = a1 * 1.001, s1 = shoot(a1), s2 = shoot(a2);
        for (let i = 0; i < 12 && Math.abs(s2.th - thR) > 1e-10; i++) {
            const a3 = a2 + (thR - s2.th) * (a2 - a1) / (s2.th - s1.th);
            a1 = a2; s1 = s2; a2 = a3; s2 = shoot(a2);
        }
        const dT = ellipticityCorrection(ray0, m, { thetaS: thS, azimuthRad: Math.PI }, eps);
        return { shot: s2.T, model: ray0.timeS + dT, dT };
    };
    const rows = [[0.4, 1.4], [1.0, 2.1]].map(([a, b]) => ({ lo: run(1 / 120, a, b), hi: run(1 / 60, a, b) }));
    for (const { lo, hi } of rows) {
        const elo = Math.abs(lo.shot - lo.model), ehi = Math.abs(hi.shot - hi.model);
        assert.ok(elo < 0.05 * Math.abs(lo.dT), `shoot ${elo} vs δT ${lo.dT}`);
        assert.ok(ehi < 0.08 * Math.abs(hi.dT), `shoot hi ${ehi} vs δT ${hi.dT}`);
    }
    const r = rows[0].lo;
    ok(`flattened smooth model: first-order δT ≡ two-point RK4 ray shooting (δT ${r.dT.toFixed(3)} s, miss ${Math.abs(r.shot - r.model).toFixed(4)} s at ε = 1/120, exaggerated so the effect dominates the integrator)`);
}
{
    // D3: PREM — the p = 0 diameter: polar / equatorial = P₂(1)/P₂(0) = −2 exactly; sign and size.
    const ray = M.phaseRay('PKIKP', 0);
    const pol = ellipticityCorrection(ray, M, { thetaS: 0, azimuthRad: 0 });
    const eq = ellipticityCorrection(ray, M, { thetaS: Math.PI / 2, azimuthRad: Math.PI / 2 });
    assert.ok(Math.abs(pol / eq + 2) < 1e-9, `ratio ${pol / eq}`);
    assert.ok(pol < -2 && pol > -3.5, `pole-to-pole PKIKP ${pol}`);
    // Geometry: geocentric latitude, symmetric distance, azimuth.
    assert.ok(Math.abs(geocentricLatDeg(45) - 44.80757) < 1e-4, `geocentric 45° → ${geocentricLatDeg(45)}`);
    assert.equal(geocentricLatDeg(0), 0); assert.ok(Math.abs(geocentricLatDeg(90) - 90) < 1e-9);
    const g1 = pathGeometry(40, -105, 35, 139), g2 = pathGeometry(35, 139, 40, -105);
    assert.ok(Math.abs(g1.deltaRad - g2.deltaRad) < 1e-12);
    assert.ok(Math.abs(pathGeometry(0, 0, 10, 0).azimuthRad) < 1e-12 && Math.abs(pathGeometry(0, 0, 0, 10).azimuthRad - Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(1 / WGS84_F - 298.257223563) < 1e-9);
    ok(`PREM p = 0 diameter: pole-to-pole ${pol.toFixed(3)} s, equatorial +${eq.toFixed(3)} s, ratio exactly −2; geocentric latitude and path geometry pinned`);
}

console.log(`\nearth-interior-phases: ${passed} checks passed`);
