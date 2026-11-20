/**
 * js/bz/propagate.js — carrying the L1 field to the bow shock (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B2 (§4.3, and §11.1). No DOM, no fetch, no ambient
 * time. Gate: tests/bz-flux.mjs.
 *
 * ── WHAT A "DELAY" IS ────────────────────────────────────────────────────
 * Solar-wind structure is, to first order, a PLANE carried by the flow. A
 * plane with unit normal n moving at velocity V passes a point r at
 *
 *     t(r) = t₀ + (r · n) / (V · n)  =  t₀ + r · m,      m ≡ n / (V · n).
 *
 * m is the SLOWNESS vector (s/km): every delay in this module is r·m, and by
 * construction V · m = 1. The flat delay everyone uses (distance / speed) is
 * the special case n ∥ V. A front tilted across the flow arrives at Earth
 * earlier or later than that by (Δy, Δz)·(m_y, m_z) — tens of minutes for
 * the ~40 R_E a spacecraft sits off the Sun–Earth line.
 *
 * ── THREE WAYS TO GET m, IN ORDER OF TRUST ───────────────────────────────
 *   1. `slownessFromLags` — THREE OR MORE spacecraft: each measured pair lag
 *      is one linear equation Δr · m = Δt, and V · m = 1 closes the system.
 *      It is a MEASUREMENT of the front, and it carries its own check: the
 *      three pair lags of a triangle must close (L_ab + L_bc = L_ac);
 *      `closure_min` is that residual.
 *   2. `mvab` — ONE spacecraft: the minimum-variance direction of the field
 *      across a window is the normal of a planar structure (∇·B = 0 makes
 *      the normal component constant). Accepted only when the two smallest
 *      eigenvalues are well separated; otherwise the direction is noise.
 *   3. the flat delay, n ∥ V. Always available, always the BASELINE the
 *      other two are scored against, and labelled whenever it is used.
 *
 * ── THE MEASURED GEOMETRY IS A THIN TRIANGLE (2026-11-20) ────────────────
 * ACE, IMAP and SOLAR1 projected across the flow form a triangle 97.8 R_E
 * long and only 6.8 R_E high. One transverse component of m is therefore
 * fixed by a ~98 R_E baseline and the other by a ~7 R_E one: with 0.5-minute
 * lag noise the full normal is off by 6.7° at the median (15° at p90).
 * BUT the Sun–Earth line passes 3.1 R_E from the line through the spacecraft,
 * so the delay TO EARTH depends almost entirely on the well-fixed component:
 * the same noise moves it by 0.22 min rms. So: trust `delay`, read
 * `normal`/`tiltDeg` as rough, and watch `condition` — the halo orbits move,
 * and this fortunate alignment is a property of this season, not a constant.
 *
 * A normal more than `maxTiltDeg` from the flow is REFUSED (the delay
 * diverges as V·n → 0, and no L1 monitor can honestly support a
 * near-tangential front): the result falls back to the flat delay and says so.
 *
 * THE TARGET is the bow-shock NOSE from js/geomag/geospace.js at the wind's
 * own dynamic pressure — the engine does not carry a second boundary model.
 * What happens between the shock and the magnetopause is B4 (sheath.js).
 */
import { RE_KM } from './frames.js';

export const PROP_DEFAULTS = Object.freeze({
    maxTiltDeg: 70,       // refuse normals further than this from the flow
    mvabMinRatio: 5,      // λ_intermediate / λ_min needed to trust an MVAB normal
    mvabMinSamples: 20,
    minLagR: 0.65,        // a pair lag must be MEASURED (fuse-l1 rMin) to enter the fit
});

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Solve the 3×3 system A x = b (Cramer). null when singular. */
function solve3(A, b) {
    const d = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
        - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
        + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    if (!(Math.abs(d) > 1e-300)) return null;
    const col = (k) => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
    const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
        - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
        + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/** The flat-delay slowness: n ∥ V. */
export function flatSlowness(V) {
    const v2 = dot(V, V);
    return v2 > 0 ? [V[0] / v2, V[1] / v2, V[2] / v2] : null;
}

/** Unit normal (sunward-pointing) and tilt from the flow, for a slowness m. */
export function describeSlowness(m, V) {
    const n = Math.hypot(m[0], m[1], m[2]);
    if (!(n > 0)) return null;
    let u = [m[0] / n, m[1] / n, m[2] / n];
    if (u[0] < 0) u = [-u[0], -u[1], -u[2]];
    const v = Math.hypot(V[0], V[1], V[2]);
    const c = Math.abs(dot(u, V)) / v;
    return { normal: u, tiltDeg: Math.acos(Math.min(1, c)) * 180 / Math.PI, phaseSpeedKms: 1 / n };
}

/**
 * The slowness vector from measured pair lags.
 *
 * Minimises Σ w (Δr·m − Δt)² subject to V·m = 1 EXACTLY (the constraint is
 * eliminated, not penalised: m = m₀ + P u with P spanning V's orthogonal
 * complement). Needs at least two pairs whose baselines are independent
 * ACROSS the flow.
 *
 * @param {Record<string,{x,y,z}>} positions  R_E, any one frame
 * @param {Array<{pair:[string,string], lagMin:number, r:number|null, source:string}>} lags
 *        lagMin > 0 ⇔ pair[1] sees the structure LATER than pair[0]
 * @param {[number,number,number]} V  solar-wind velocity, km/s, same frame
 * @returns {{ m:number[], normal:number[], tiltDeg:number, pairs:number,
 *             closure_min:number|null, condition:number, residual_min:number } | null}
 */
export function slownessFromLags(positions, lags, V, opts = {}) {
    const o = { ...PROP_DEFAULTS, ...opts };
    const v2 = dot(V, V);
    if (!(v2 > 0)) return null;
    const used = lags.filter((l) => l.source === 'measured' && (l.r ?? 0) >= o.minLagR
        && positions[l.pair[0]] && positions[l.pair[1]]);
    if (used.length < 2) return null;

    // Two unit vectors spanning the plane ⟂ V.
    const vh = V.map((x) => x / Math.sqrt(v2));
    const seed = Math.abs(vh[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    let e1 = [seed[1] * vh[2] - seed[2] * vh[1], seed[2] * vh[0] - seed[0] * vh[2], seed[0] * vh[1] - seed[1] * vh[0]];
    const n1 = Math.hypot(...e1); e1 = e1.map((x) => x / n1);
    const e2 = [vh[1] * e1[2] - vh[2] * e1[1], vh[2] * e1[0] - vh[0] * e1[2], vh[0] * e1[1] - vh[1] * e1[0]];
    const m0 = flatSlowness(V);

    // Rows: (Δr·e1) u1 + (Δr·e2) u2 = Δt − Δr·m0
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    const rows = [];
    for (const l of used) {
        const A = positions[l.pair[0]], B = positions[l.pair[1]];
        const dr = [(B.x - A.x) * RE_KM, (B.y - A.y) * RE_KM, (B.z - A.z) * RE_KM];
        const w = (l.r ?? 0.7) ** 2;
        const c1 = dot(dr, e1), c2 = dot(dr, e2), rhs = l.lagMin * 60 - dot(dr, m0);
        a11 += w * c1 * c1; a12 += w * c1 * c2; a22 += w * c2 * c2; b1 += w * c1 * rhs; b2 += w * c2 * rhs;
        rows.push({ dr, dt: l.lagMin * 60, l });
    }
    const det = a11 * a22 - a12 * a12;
    const tr = a11 + a22;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const lMax = tr / 2 + disc, lMin = tr / 2 - disc;
    if (!(lMin > 0) || !(det > 0)) return null;
    const condition = Math.sqrt(lMax / lMin);
    const u1 = (b1 * a22 - b2 * a12) / det, u2 = (b2 * a11 - b1 * a12) / det;
    const m = [m0[0] + u1 * e1[0] + u2 * e2[0], m0[1] + u1 * e1[1] + u2 * e2[1], m0[2] + u1 * e1[2] + u2 * e2[2]];

    let res = 0;
    for (const r of rows) res += (dot(r.dr, m) - r.dt) ** 2;

    // Triangle closure: for any three spacecraft, L_ab + L_bc − L_ac must vanish.
    let closure = null;
    const key = (a, b) => used.find((l) => (l.pair[0] === a && l.pair[1] === b) || (l.pair[0] === b && l.pair[1] === a));
    const signed = (a, b) => { const l = key(a, b); return l ? (l.pair[0] === a ? l.lagMin : -l.lagMin) : null; };
    const names = [...new Set(used.flatMap((l) => l.pair))];
    for (let i = 0; i < names.length && closure == null; i++) {
        for (let j = i + 1; j < names.length && closure == null; j++) {
            for (let k = j + 1; k < names.length; k++) {
                const ab = signed(names[i], names[j]), bc = signed(names[j], names[k]), ac = signed(names[i], names[k]);
                if (ab != null && bc != null && ac != null) { closure = ab + bc - ac; break; }
            }
        }
    }
    const d = describeSlowness(m, V);
    return { m, normal: d.normal, tiltDeg: d.tiltDeg, pairs: used.length, closure_min: closure,
        condition, residual_min: Math.sqrt(res / rows.length) / 60 };
}

/** Eigen-decomposition of a symmetric 3×3 by cyclic Jacobi. Ascending eigenvalues. */
export function eigSym3(S) {
    const a = S.map((r) => r.slice());
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 60; sweep++) {
        const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
        if (off < 1e-30) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(a[p][q]) < 1e-300) continue;
            const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
            for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
            for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
        }
    }
    const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
    return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => [v[0][i], v[1][i], v[2][i]]) };
}

/**
 * Minimum-variance analysis of the field over [i0, i1) of a grid entry
 * ({bx,by,bz}). Returns the normal (minimum-variance direction) and the
 * eigenvalue ratio that says whether it means anything.
 */
export function mvab(g, i0, i1, opts = {}) {
    const o = { ...PROP_DEFAULTS, ...opts };
    let n = 0; const s = [0, 0, 0]; const q = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = Math.max(0, i0); i < Math.min(i1, g.bz.length); i++) {
        const b = [g.bx[i], g.by[i], g.bz[i]];
        if (!(b[0] === b[0] && b[1] === b[1] && b[2] === b[2])) continue;
        n++;
        for (let k = 0; k < 3; k++) { s[k] += b[k]; for (let l = 0; l < 3; l++) q[k][l] += b[k] * b[l]; }
    }
    if (n < o.mvabMinSamples) return null;
    const C = q.map((row, k) => row.map((x, l) => x / n - (s[k] / n) * (s[l] / n)));
    const e = eigSym3(C);
    const ratio = e.values[0] > 0 ? e.values[1] / e.values[0] : Infinity;
    return { normal: e.vectors[0], ratio, n, ok: ratio >= o.mvabMinRatio, eigenvalues: e.values };
}

/** Slowness from a unit normal: m = n / (V·n). null if the front is ⟂ to nothing (V·n = 0). */
export function slownessFromNormal(normal, V) {
    const d = dot(V, normal);
    return Math.abs(d) > 1e-9 ? normal.map((x) => x / d) : null;
}

/**
 * Choose the slowness for one instant: lags → MVAB → flat, refusing any
 * normal past maxTiltDeg. The result names the method that was USED and, when
 * a better one was tried and refused, why.
 */
export function chooseSlowness({ positions, lags, V, mvabResult = null }, opts = {}) {
    const o = { ...PROP_DEFAULTS, ...opts };
    const flat = flatSlowness(V);
    if (!flat) return null;
    const notes = [];
    const fromLags = positions && lags ? slownessFromLags(positions, lags, V, o) : null;
    if (fromLags) {
        if (fromLags.tiltDeg <= o.maxTiltDeg) return { method: 'multi-spacecraft-lags', m: fromLags.m, ...pick(fromLags), notes };
        notes.push(`lag_normal_refused_tilt_${Math.round(fromLags.tiltDeg)}deg`);
    } else if (lags?.length) notes.push('too_few_measured_lags');
    if (mvabResult?.ok) {
        const m = slownessFromNormal(mvabResult.normal, V);
        const d = m ? describeSlowness(m, V) : null;
        if (d && d.tiltDeg <= o.maxTiltDeg) return { method: 'mvab', m, normal: d.normal, tiltDeg: d.tiltDeg, mvab_ratio: mvabResult.ratio, notes };
        notes.push(d ? `mvab_normal_refused_tilt_${Math.round(d.tiltDeg)}deg` : 'mvab_normal_perpendicular');
    } else if (mvabResult) notes.push('mvab_eigenvalues_not_separated');
    const d = describeSlowness(flat, V);
    return { method: 'flat', m: flat, normal: d.normal, tiltDeg: 0, notes };
}
function pick(f) {
    return { normal: f.normal, tiltDeg: f.tiltDeg, pairs: f.pairs, closure_min: f.closure_min, condition: f.condition, residual_min: f.residual_min };
}

/** Delay (seconds) for a structure seen at `from` to reach `to` (R_E, same frame as m). */
export function delayS(m, from, to) {
    return ((to.x - from.x) * m[0] + (to.y - from.y) * m[1] + (to.z - from.z) * m[2]) * RE_KM;
}

/**
 * Turn source times + delays into an arrival-ordered series, dropping parcels
 * that are OVERTAKEN: a later-launched parcel arriving first means the two
 * have interacted on the way and the earlier one's upstream value is no
 * longer what arrives. Dropped parcels are counted, never silently merged.
 * @param {ArrayLike<number>} tMs      source times, ascending
 * @param {ArrayLike<number>} delaysS  NaN = no delay available
 * @returns {{ keep:number[], arrivalMs:Float64Array, overtaken:number, undefinedDelay:number }}
 */
export function arrivalOrder(tMs, delaysS) {
    const n = tMs.length;
    const arrivalMs = new Float64Array(n).fill(NaN);
    let undefinedDelay = 0;
    for (let i = 0; i < n; i++) {
        if (delaysS[i] === delaysS[i]) arrivalMs[i] = tMs[i] + delaysS[i] * 1000; else undefinedDelay++;
    }
    const keep = [];
    let earliestLater = Infinity, overtaken = 0;
    for (let i = n - 1; i >= 0; i--) {
        const a = arrivalMs[i];
        if (a !== a) continue;
        if (a < earliestLater) { keep.push(i); earliestLater = a; } else overtaken++;
    }
    keep.reverse();
    return { keep, arrivalMs, overtaken, undefinedDelay };
}
