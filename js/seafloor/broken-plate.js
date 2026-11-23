/**
 * broken-plate.js — the bending plate with TWO thicknesses. PURE.
 *
 * Both published global trench studies this page is checked against (Zhang et al. 2018, Garcia et al.
 * 2019; `trench-literature.js`) find that the plate WEAKENS as it bends: normal faults open seaward of
 * the trench and the plate near the axis is thinner, elastically, than the plate that has not yet bent.
 * Zhang et al. fit that as an elastic plate whose thickness steps from T_eM (seaward of a break point
 * x_r) to T_em (between the trench axis and x_r), loaded at the axis by a vertical force V₀ and a
 * bending moment M₀. This module is that model, solved EXACTLY:
 *
 *     D(x)·w'''' + Δρ·g·w = 0      piecewise:  D = D_m on 0 < x < x_r,  D = D_M on x > x_r
 *
 *   inner (0 < x < x_r, u = x/α_m):  w = e^(−u)(A cos u + B sin u) + e^(u − u_r)(C cos u + E sin u)
 *   outer (x > x_r,     s = (x − x_r)/α_M):  w = e^(−s)(F cos s + G sin s)          (decays seaward)
 *
 * with α = (4D/Δρg)^(1/4) and D = E·T_e³/(12(1 − ν²)) — the same constants (`ELASTIC`) and the same
 * relation the single-thickness fit uses (`elasticFromRise`). Six conditions fix the six constants: the
 * moment and the shear at the axis (two unit loads → two RESPONSES, `g1` the moment's and `g2` the
 * shear's, whose amplitudes the fit finds by linear least squares) and continuity of w, w′, the moment
 * D·w″ and the shear (D·w″)′ at the break. The growing inner term is written e^(u − u_r) so nothing in
 * the 6×6 system exceeds 1. With T_em = T_eM the plate is uniform and the solution IS the closed form
 * e^(−u)(c₁ cos u + c₂ sin u) — the universal trench profile with a free zero crossing — so the
 * one-thickness fit is NESTED in this one (gated, both as an identity and as a fit).
 *
 * THE FIT (`fitBrokenPlate`) runs on a profile the one-thickness fit has already ACCEPTED, on the points
 * it KEPT (seamounts out): depth = d_ref + slope·x + b₁·g1 + b₂·g2 for every (T_em ≤ T_eM, x_r) of a grid
 * (thickness on a geometric ladder, break every `GRID.xrStepKm`). What it reports, and the rules:
 *   · the uniform-plate fit on the SAME grid (T_em = T_eM), so the comparison is like for like;
 *   · WHETHER A SECOND THICKNESS IS NEEDED AT ALL: Δχ² = n_eff·(SS₁/SS₂ − 1) against χ²₂ (2 more
 *     parameters), where n_eff is the number of INDEPENDENT points (residuals are correlated over tens of
 *     km on a 2 km profile — counting every point would make any wiggle "significant"; n_eff comes from
 *     the best fit's own lag-1 residual autocorrelation, n(1 − ρ)/(1 + ρ));
 *   · each parameter's PROFILE-LIKELIHOOD interval (the grid values whose best fit lies within
 *     `GRID.deltaChi2` of the minimum, same n_eff) — an interval that reaches the top of the grid is
 *     UNBOUNDED and the unbent thickness is then not measured, only bounded from below;
 *   · `quality` 'good' only when the second thickness is needed, T_eM is bounded on both sides and the
 *     break is not at the edge of its range.
 *
 * MEASURED on the 15 subduction sites, 72 fitted cross-sections (2026-11-23):
 *   · the uniform plate on this grid IS the one-thickness fit (misfit within 2 %, thickness within the grid step,
 *     at all 25 sections that pass) — the identity holds on real data, not only on paper;
 *   · a second thickness is SIGNIFICANTLY better at 28 of 72 sections, and where it is the misfit falls by up to
 *     half (Tonga 152 → 60 m) — the one-thickness fit's commonest rejection, "rise within the scatter", is at
 *     several of them this model's residual;
 *   · both thicknesses are pinned down (every test, the reach test, the near-trench value stable) at only 8;
 *     the unbent plate's interval closes at 3 of those and is otherwise a LOWER BOUND; one site, Middle America,
 *     has three accepted sections and is quoted, with a near-trench thickness ranging 3–26 km by section;
 *   · against Zhang et al.'s two-thickness rows for the same trench, all three published numbers fall inside
 *     ours at 4 of the 8 (Tonga ×2, Izu–Bonin, one Middle America section) and NOT at the other 4 (Kuril, Java,
 *     two Middle America) — recorded, not tuned;
 *   · a planted 12 / 40 km plate is recovered inside its intervals, and the ONE-thickness fit reads it as 7 km:
 *     a single thickness measures something nearer the weak plate than the strong one.
 * THE KNOWN TRADE-OFF: a very stiff outer plate's long, low deflection can stand in for part of the regional
 * slope (Middle America's centre section prefers a 745 m rise on a −2.2 m/km tilt). The intervals are profile
 * likelihoods with the slope FREE, so the trade-off widens them rather than hiding; the near-trench reach test
 * is what caught the stations where it moved the answer.
 * It does NOT measure what the literature also removes: sediment loading, the non-isostatic part of the
 * topography, or a gradual (elastic–plastic) weakening; the step is the simplest weakening there is, and
 * Zhang et al. show its integrated reduction matches an elastic–plastic plate's (their Fig. 12).
 */
import { ELASTIC, SLOPE_MAX_M_PER_KM } from './trench-model.js';

/** The search: thickness ladder (km, geometric), break distances (km from the axis), the interval threshold. */
export const GRID = Object.freeze({ teMinKm: 3, teMaxKm: 90, teRatio: 1.08, xrMinKm: 10, xrMaxKm: 200, xrStepKm: 10, latticeKm: 2, deltaChi2: 4, significance: 5.99 });

/** Flexural rigidity (N m) and flexural parameter (km) of a plate of elastic thickness T_e (km). */
export function plateOf(teKm, k = ELASTIC) {
    const D = k.E * (teKm * 1000) ** 3 / (12 * (1 - k.nu * k.nu));
    return { D, alphaKm: Math.pow(4 * D / ((k.rhoMantle - k.rhoWater) * k.g), 0.25) / 1000 };
}

/** d^n/du^n of e^(λu + c)·cos u and ·sin u at u: [cos-part, sin-part] (via (λ + i)^n e^((λ+i)u)). */
function dnExpTrig(lambda, u, c, n) {
    let re = 1, im = 0;
    for (let k = 0; k < n; k++) { const r = re * lambda - im, i = re + im * lambda; re = r; im = i; }
    const e = Math.exp(lambda * u + c), cu = Math.cos(u), su = Math.sin(u);
    return [e * (re * cu - im * su), e * (re * su + im * cu)];
}

/** Gaussian elimination with partial pivoting on an augmented n×(n+m) matrix; returns the m solution columns. */
function solve(M, n, m) {
    for (let c = 0; c < n; c++) {
        let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (!(Math.abs(M[p][c]) > 1e-300)) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k < n + m; k++) M[r][k] -= f * M[c][k]; }
    }
    const out = [];
    for (let j = 0; j < m; j++) { const x = new Array(n); for (let r = n - 1; r >= 0; r--) { let s = M[r][n + j]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; } out.push(x); }
    return out;
}

/**
 * The two unit responses of the broken plate: `coef[j]` = [A, B, C, E, F, G] for load j (0: w_uu(0) = 1 —
 * a moment; 1: w_uuu(0) = 1 — a shear), u in units of the INNER flexural parameter. With temKm === teMKm the
 * break is invisible and the outer constants continue the inner decaying solution.
 */
export function brokenSolution(temKm, teMKm, xrKm, k = ELASTIC) {
    const a1 = plateOf(temKm, k).alphaKm, a2 = plateOf(teMKm, k).alphaKm, ur = xrKm / a1, q = a2 / a1;
    const row = (n, u, c) => [...dnExpTrig(-1, u, 0, n), ...dnExpTrig(1, u, c, n)];
    const out = (n) => dnExpTrig(-1, 0, 0, n);
    const M = [
        [...row(2, 0, -ur), 0, 0, 1, 0],
        [...row(3, 0, -ur), 0, 0, 0, 1],
    ];
    // continuity at the break: w, α_m·w′, α_m²·(D w″)/D_m, α_m³·(D w″)′/D_m  (D_M/D_m = q⁴)
    const scale = [1, 1 / q, q * q, q];
    for (let n = 0; n < 4; n++) { const o = out(n); M.push([...row(n, ur, -ur), -scale[n] * o[0], -scale[n] * o[1], 0, 0]); }
    const sol = solve(M, 6, 2);
    return sol && { temKm, teMKm, xrKm, a1, a2, coef: sol };
}

/** The two responses at x (km): [g1, g2]. */
export function brokenResponse(sol, xKm) {
    const r = [0, 0];
    if (xKm <= sol.xrKm) {
        const u = xKm / sol.a1, ur = sol.xrKm / sol.a1, e1 = Math.exp(-u), e2 = Math.exp(u - ur), c = Math.cos(u), s = Math.sin(u);
        for (let j = 0; j < 2; j++) { const k = sol.coef[j]; r[j] = e1 * (k[0] * c + k[1] * s) + e2 * (k[2] * c + k[3] * s); }
    } else {
        const v = (xKm - sol.xrKm) / sol.a2, e = Math.exp(-v), c = Math.cos(v), s = Math.sin(v);
        for (let j = 0; j < 2; j++) { const k = sol.coef[j]; r[j] = e * (k[4] * c + k[5] * s); }
    }
    return r;
}

/**
 * The n-th derivative in x (per km^n) of the two responses at x, from the analytic pieces — for the gate, which
 * checks the six conditions and the plate equation itself rather than trusting the 6×6 solve.
 */
export function brokenDerivative(sol, xKm, n) {
    const r = [0, 0];
    if (xKm <= sol.xrKm) {
        const u = xKm / sol.a1, ur = sol.xrKm / sol.a1, d1 = dnExpTrig(-1, u, 0, n), d2 = dnExpTrig(1, u, -ur, n), f = sol.a1 ** -n;
        for (let j = 0; j < 2; j++) { const k = sol.coef[j]; r[j] = f * (k[0] * d1[0] + k[1] * d1[1] + k[2] * d2[0] + k[3] * d2[1]); }
    } else {
        const d = dnExpTrig(-1, (xKm - sol.xrKm) / sol.a2, 0, n), f = sol.a2 ** -n;
        for (let j = 0; j < 2; j++) { const k = sol.coef[j]; r[j] = f * (k[4] * d[0] + k[5] * d[1]); }
    }
    return r;
}

/** The thickness ladder of the grid. */
export function thicknessLadder(g = GRID) { const out = []; for (let t = g.teMinKm; t <= g.teMaxKm * 1.0001; t *= g.teRatio) out.push(t); return out; }

/** Height of the bent plate above its reference (m) at x for a fit: −(b₁·g1 + b₂·g2). */
export function brokenHeight(fit, xKm) { const g = brokenResponse(fit.sol, xKm); return -(fit.b1 * g[0] + fit.b2 * g[1]); }

/** Zero crossing, outer-rise distance and height of a fitted plate (scanned at 0.5 km). */
export function riseOf(fit, reachKm) {
    let x0 = null, xb = null, wb = -Infinity, prev = brokenHeight(fit, 0);
    for (let x = 0.5; x <= reachKm; x += 0.5) {
        const w = brokenHeight(fit, x);
        if (x0 == null && prev < 0 && w >= 0) x0 = x - 0.5 * w / (w - prev);
        if (x0 != null && w > wb) { wb = w; xb = x; }
        if (x0 != null && w < wb && x > xb + 60) break;
        prev = w;
    }
    return { x0, xb, wb: x0 == null ? null : wb, w0: brokenHeight(fit, 0) };
}

/**
 * Fit the two-thickness plate to a seaward profile [{ x (km, ≥ 0 from the axis), depth (m) }]: normally the
 * points the one-thickness fit KEPT. Returns null, or
 *   { temKm, teMKm, xrKm, dRef, slope, b1, b2, sol, rms, ss, uniform: { teKm, rms, ss, … }, nEff, rho,
 *     dChi2, needed, intervals: { tem, teM, xr: [lo, hi, loOpen, hiOpen] }, rise, reasons, quality, n, reachKm }.
 */
export function fitBrokenPlate(profile, { grid = GRID, minPoints = 30, k = ELASTIC } = {}) {
    const pts = profile.filter((p) => p.depth != null && p.x >= 0).sort((a, b) => a.x - b.x);
    if (pts.length < minPoints) return null;
    const n = pts.length, x = pts.map((p) => p.x), y = pts.map((p) => p.depth), reachKm = x[n - 1];
    let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
    const dx = new Float64Array(n), dy = new Float64Array(n); let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) { dx[i] = x[i] - mx; dy[i] = y[i] - my; sxx += dx[i] * dx[i]; sxy += dx[i] * dy[i]; syy += dy[i] * dy[i]; }
    const ladder = thicknessLadder(grid), xrs = []; for (let r = grid.xrMinKm; r <= grid.xrMaxKm; r += grid.xrStepKm) xrs.push(r);
    const alpha = ladder.map((t) => plateOf(t, k).alphaKm);
    // per-thickness tables at the profile's points: inner e^(∓u)·(cos, sin) and outer pieces are recomputed per break
    const inner = alpha.map((a) => { const t = new Float64Array(6 * n); for (let i = 0; i < n; i++) { const u = x[i] / a, c = Math.cos(u), s = Math.sin(u), e1 = Math.exp(-u), e2 = Math.exp(Math.min(u, 700)); t[6 * i] = e1 * c; t[6 * i + 1] = e1 * s; t[6 * i + 2] = e2 * c; t[6 * i + 3] = e2 * s; t[6 * i + 4] = u; } return t; });
    // seaward of the break the response depends only on (x − x_r)/α_M: on a lattice (every stacked profile is one,
    // and every break is a multiple of it) that is a TABLE per thickness, not an exp and a cos per point and break
    const h = grid.latticeKm || 2, lat = x.every((v) => Math.abs(v / h - Math.round(v / h)) < 1e-6) && xrs.every((r) => Math.abs(r / h - Math.round(r / h)) < 1e-9);
    const J = lat ? Math.round(reachKm / h) + 1 : 0, ki = lat ? Int32Array.from(x, (v) => Math.round(v / h)) : null;
    const outer = lat ? alpha.map((a) => { const t = new Float64Array(2 * J); for (let j = 0; j < J; j++) { const v = j * h / a, e = Math.exp(-v); t[2 * j] = e * Math.cos(v); t[2 * j + 1] = e * Math.sin(v); } return t; }) : null;
    const g1 = new Float64Array(n), g2 = new Float64Array(n);
    const bestBy = { tem: new Float64Array(ladder.length).fill(Infinity), teM: new Float64Array(ladder.length).fill(Infinity), xr: new Float64Array(xrs.length).fill(Infinity) };
    let best = null, uni = null;
    const evalCombo = (im, iM, ir) => {
        const sol = brokenSolution(ladder[im], ladder[iM], xrs[ir], k);
        if (!sol) return null;
        const t = inner[im], xr = xrs[ir], ur = xr / sol.a1, eur = Math.exp(-ur), [c1, c2] = sol.coef, to = lat ? outer[iM] : null, kr = lat ? Math.round(xr / h) : 0;
        for (let i = 0; i < n; i++) {
            if (x[i] <= xr) { const o = 6 * i, a = t[o], b = t[o + 1], c = t[o + 2] * eur, d = t[o + 3] * eur;
                g1[i] = c1[0] * a + c1[1] * b + c1[2] * c + c1[3] * d; g2[i] = c2[0] * a + c2[1] * b + c2[2] * c + c2[3] * d; }
            else if (lat) { const o = 2 * (ki[i] - kr), cs = to[o], sn = to[o + 1]; g1[i] = c1[4] * cs + c1[5] * sn; g2[i] = c2[4] * cs + c2[5] * sn; }
            else { const v = (x[i] - xr) / sol.a2, e = Math.exp(-v), cs = e * Math.cos(v), sn = e * Math.sin(v);
                g1[i] = c1[4] * cs + c1[5] * sn; g2[i] = c2[4] * cs + c2[5] * sn; }
        }
        // centred normal equations for [slope, b1, b2]
        let s1 = 0, s2 = 0; for (let i = 0; i < n; i++) { s1 += g1[i]; s2 += g2[i]; } const m1 = s1 / n, m2 = s2 / n;
        let a11 = sxx, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, r1 = sxy, r2 = 0, r3 = 0;
        for (let i = 0; i < n; i++) { const p = g1[i] - m1, q = g2[i] - m2; a12 += dx[i] * p; a13 += dx[i] * q; a22 += p * p; a23 += p * q; a33 += q * q; r2 += p * dy[i]; r3 += q * dy[i]; }
        const S = solve([[a11, a12, a13, r1], [a12, a22, a23, r2], [a13, a23, a33, r3]], 3, 1);
        if (!S) return null;
        const [sl, b1, b2] = S[0], ss = Math.max(0, syy - sl * r1 - b1 * r2 - b2 * r3);
        // the axis must be the low point of the plate (the trench), and a rise must stand somewhere seaward
        const w0 = -(b1 * g1[0] + b2 * g2[0]); if (x[0] > 5 || !(w0 < 0)) return null;
        let up = false; for (let i = 0; i < n && !up; i++) if (-(b1 * g1[i] + b2 * g2[i]) > 0) up = true;
        if (!up) return null;
        return { sol, sl, b1, b2, ss, dRef: my - sl * mx - b1 * m1 - b2 * m2 };
    };
    for (let iM = 0; iM < ladder.length; iM++) for (let im = 0; im <= iM; im++) for (let ir = 0; ir < (im === iM ? 1 : xrs.length); ir++) {
        const r = evalCombo(im, iM, ir);
        if (!r) continue;
        if (im === iM) { if (!uni || r.ss < uni.ss) uni = { ...r, im, iM, ir }; for (let j = 0; j < xrs.length; j++) bestBy.xr[j] = Math.min(bestBy.xr[j], r.ss); }
        else bestBy.xr[ir] = Math.min(bestBy.xr[ir], r.ss);
        bestBy.tem[im] = Math.min(bestBy.tem[im], r.ss); bestBy.teM[iM] = Math.min(bestBy.teM[iM], r.ss);
        if (!best || r.ss < best.ss) best = { ...r, im, iM, ir };
    }
    if (!best || !uni) return null;
    // independent points, from the best fit's own residuals (lag-1 autocorrelation along the profile)
    const res = new Float64Array(n); { const f = { sol: best.sol, b1: best.b1, b2: best.b2 }; for (let i = 0; i < n; i++) res[i] = y[i] - (best.dRef + best.sl * x[i] - brokenHeight(f, x[i])); }
    let c0 = 0, c1 = 0, mr = 0; for (let i = 0; i < n; i++) mr += res[i]; mr /= n;
    for (let i = 0; i < n; i++) { c0 += (res[i] - mr) ** 2; if (i && x[i] - x[i - 1] <= 4.01) c1 += (res[i] - mr) * (res[i - 1] - mr); }
    const rho = Math.max(0, Math.min(0.98, c1 / c0)), nEff = Math.max(3, n * (1 - rho) / (1 + rho));
    const chi = (ss) => nEff * (ss / best.ss - 1);
    const interval = (vals, arr) => { let lo = null, hi = null; for (let j = 0; j < arr.length; j++) if (chi(arr[j]) <= grid.deltaChi2) { if (lo == null) lo = j; hi = j; }
        return lo == null ? null : [vals[lo], vals[hi], lo === 0, hi === vals.length - 1]; };
    const fit = { temKm: ladder[best.im], teMKm: ladder[best.iM], xrKm: xrs[best.ir], dRef: best.dRef, slope: best.sl, b1: best.b1, b2: best.b2, sol: best.sol,
        ss: best.ss, rms: Math.sqrt(best.ss / n), n, reachKm, rho, nEff,
        uniform: { teKm: ladder[uni.im], dRef: uni.dRef, slope: uni.sl, b1: uni.b1, b2: uni.b2, sol: uni.sol, ss: uni.ss, rms: Math.sqrt(uni.ss / n) } };
    fit.dChi2 = nEff * (uni.ss / best.ss - 1);
    fit.needed = fit.dChi2 >= grid.significance && best.im !== best.iM;
    fit.intervals = { tem: interval(ladder, bestBy.tem), teM: interval(ladder, bestBy.teM), xr: interval(xrs, bestBy.xr) };
    fit.rise = riseOf(fit, reachKm); fit.uniform.rise = riseOf(fit.uniform, reachKm);
    const reasons = [], I = fit.intervals, R = fit.rise;
    // THE SAME TESTS THE ONE-THICKNESS FIT HAS TO PASS (trench-model.js fitOnce), on this fit's own curve
    let lx = 0, ly = 0; for (let i = 0; i < n; i++) { lx += dx[i] * dx[i]; ly += dx[i] * dy[i]; } const lb = ly / lx;
    let lss = 0; for (let i = 0; i < n; i++) lss += (dy[i] - lb * dx[i]) ** 2; fit.lineRms = Math.sqrt(lss / n);
    if (fit.rms > 0.6 * fit.lineRms) reasons.push('no-better-than-a-slope');
    if (R.xb == null || R.xb > reachKm - 10) reasons.push('rise-outside-the-data');
    if (!(R.wb >= 50)) reasons.push('no-rise');
    if (R.wb > 1500) reasons.push('rise-implausibly-high');
    if (Math.abs(fit.slope) > SLOPE_MAX_M_PER_KM) reasons.push('slope-implausible');
    if (R.x0 != null && R.xb != null) {
        const L = R.xb - R.x0, far = pts.filter((q) => q.x >= R.xb + L).map((q) => q.depth - (fit.dRef + fit.slope * q.x)).sort((u, v) => u - v);
        fit.farOffset = far.length >= 8 ? far[far.length >> 1] : null;
        if (fit.farOffset == null) reasons.push('far-field-not-in-the-data');
        else if (Math.abs(fit.farOffset) > 0.4 * R.wb) reasons.push('far-field-not-level');
        if (R.wb < 1.5 * fit.rms) reasons.push('rise-within-the-scatter');
    }
    if (!fit.needed) reasons.push('one-thickness-is-enough');
    if (!I.teM || I.teM[3]) reasons.push('unbent-not-bounded');
    if (I.teM && I.teM[2]) reasons.push('unbent-at-search-floor');
    if (best.ir === 0 || best.ir === xrs.length - 1) reasons.push('break-at-search-bound');
    if (fit.rise.x0 == null || fit.rise.wb == null || !(fit.rise.wb > 0)) reasons.push('no-rise');
    fit.reasons = reasons; fit.quality = reasons.length ? 'poor' : 'good';
    return fit;
}

/** The points a one-thickness fit KEPT (its seamount runs left out) — the profile the two-thickness fit is run on. */
export function keptPoints(profile, flexure) {
    const runs = (flexure && flexure.masked) || [];
    return (profile || []).filter((p) => p.depth != null && p.x >= 0 && !runs.some((r) => p.x >= r.x0 - 1e-9 && p.x <= r.x1 + 1e-9));
}

/**
 * THE REACH TEST, AGAIN: the two-thickness fit is repeated on the nearest `STABILITY_2.fraction` of the profile.
 * The near-trench thickness T_em is what the near profile still sees, so its best value may move by at most
 * `STABILITY_2.temTolerance` (the one-thickness rule); the unbent thickness is a far-field quantity, so its two
 * INTERVALS must overlap. MEASURED: with the intervals-only version of this test (both thicknesses) the Middle
 * America stations passed with near-trench thicknesses that moved 24 → 5 and 19 → 12 km when the far quarter was
 * dropped — a slope traded for a stiff outer plate (see the header) — so T_em is held to the stricter rule.
 */
export const STABILITY_2 = Object.freeze({ fraction: 0.75, temTolerance: 0.25 });
export function brokenStation(profile, flexure, opts = {}) {
    const pts = keptPoints(profile, flexure);
    const fit = fitBrokenPlate(pts, opts);
    if (!fit) return null;
    const near = fitBrokenPlate(pts.filter((p) => p.x <= STABILITY_2.fraction * fit.reachKm), opts);
    const a = fit.intervals.teM, b = near && near.intervals.teM;
    const ok = !!near && Math.abs(near.temKm - fit.temKm) <= STABILITY_2.temTolerance * Math.max(near.temKm, fit.temKm) && !!a && !!b && a[0] <= b[1] && b[0] <= a[1];
    fit.stability = { reachKm: near ? near.reachKm : null, temKm: near ? near.temKm : null, teMKm: near ? near.teMKm : null, teM: b || null, ok };
    if (!ok) fit.reasons.push('not-stable-with-reach');
    // ACCEPTED: a second thickness is needed, the curve passes every profile test and survives the reach test.
    // The unbent thickness is then MEASURED when its interval closes, and a LOWER BOUND when it reaches the grid top.
    const blocking = fit.reasons.filter((r) => r !== 'unbent-not-bounded');
    fit.accepted = blocking.length === 0;
    fit.teMStatus = !fit.accepted ? null : (fit.intervals.teM && !fit.intervals.teM[3] ? 'measured' : 'lower-bound');
    fit.quality = fit.accepted && fit.teMStatus === 'measured' ? 'good' : 'poor';
    return fit;
}

/**
 * Two thicknesses along the trench: `brokenStation` at every station of a trenchModel's `along` (or at its one
 * section). A site is QUOTED when `ALONG_2.minGood` stations are accepted — the one-thickness rule — and the
 * numbers are the accepted stations' MEDIANS with their ranges: T_em, x_r, and for T_eM the median of the
 * lower bounds ("at least"), plus an upper value only if EVERY accepted station closed its interval.
 */
export const ALONG_2 = Object.freeze({ minGood: 3 });
function med(a) { const v = a.filter(Number.isFinite).sort((p, q) => p - q); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; }
/** The sections of a trenchModel the two-thickness fit is run on: its stations, or its one section. */
export function twoThicknessSections(tm) { return !tm || !tm.profile ? [] : tm.along ? tm.along.stations : [{ offsetKm: 0, profile: tm.profile, flexure: tm.flexure }]; }
export function twoThickness(tm, opts = {}) {
    if (!tm || !tm.profile) return null;
    return summarizeTwoThickness(twoThicknessSections(tm).map((s) => ({ offsetKm: s.offsetKm, fit: s.profile && s.flexure ? brokenStation(s.profile, s.flexure, opts) : null })), !tm.along);
}
/** The site summary from per-section results [{ offsetKm, fit }] (a page can compute the sections one at a time). */
export function summarizeTwoThickness(stations, single = false) {
    const acc = stations.filter((s) => s.fit && s.fit.accepted).map((s) => s.fit);
    const quotable = acc.length >= ALONG_2.minGood;
    const tem = acc.map((f) => f.temKm), xr = acc.map((f) => f.xrKm), lo = acc.map((f) => f.intervals.teM[0]);
    const closed = acc.length && acc.every((f) => f.teMStatus === 'measured');
    return { stations, accepted: acc.length, fitted: stations.filter((s) => s.fit).length, needed: stations.filter((s) => s.fit && s.fit.needed).length, quotable, single,
        temKm: med(tem), temMin: tem.length ? Math.min(...tem) : null, temMax: tem.length ? Math.max(...tem) : null,
        xrKm: med(xr), xrMin: xr.length ? Math.min(...xr) : null, xrMax: xr.length ? Math.max(...xr) : null,
        teMAtLeastKm: med(lo), teMLowerMin: lo.length ? Math.min(...lo) : null, teMLowerMax: lo.length ? Math.max(...lo) : null, teMKm: closed ? med(acc.map((f) => f.teMKm)) : null, teMUpperKm: closed ? med(acc.map((f) => f.intervals.teM[1])) : null,
        rmsGain: acc.length ? med(acc.map((f) => 1 - f.rms / f.uniform.rms)) : null };
}
