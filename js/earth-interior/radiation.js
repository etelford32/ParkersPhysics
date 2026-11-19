/**
 * radiation.js — the earthquake's OWN radiation pattern (PURE, no DOM, no fetch).
 *
 * A shear fault does not radiate equally in every direction: P is strongest
 * 45° off the fault plane and ZERO on it and on the plane perpendicular to it
 * (the two NODAL planes); S is strongest along them. amplitude.js used to
 * scale every phase by the focal-sphere RMS (P √(4/15), each S polarisation
 * √(1/5)) because it did not know the source. With a published moment tensor
 * it now uses the coefficient for the direction THIS ray actually leaves the
 * focus, and the RMS stays as the disclosed fallback when no mechanism exists.
 *
 * FRAME. Aki & Richards' source frame: x = north, y = east, z = DOWN (NED).
 * USGS publishes the tensor in USE (r = up, t = south, p = east), so
 *      Mzz = Mrr, Mxx = Mtt, Myy = Mpp, Mxz = Mrt, Myz = −Mrp, Mxy = −Mtp.
 * A ray leaves with take-off angle i (from the DOWNWARD vertical) and azimuth
 * φ (clockwise from north):
 *      γ    = (sin i cos φ, sin i sin φ, cos i)      direction of travel
 *      ê_SV = (cos i cos φ, cos i sin φ, −sin i)     ∂γ/∂i
 *      ê_SH = (−sin φ, cos φ, 0)                     ∂γ/∂φ / sin i
 * and the far-field coefficients (A&R 4.29, normalised by M0) are
 *      R_P = γ·M̂·γ,  R_SV = ê_SV·M̂·γ,  R_SH = ê_SH·M̂·γ.
 *
 * THE ORACLES (tests/earth-interior-radiation.mjs): the tensor is built two
 * independent ways (Box 4.4's closed form vs M0(n dᵀ + d nᵀ) from the fault
 * normal and slip); the tensor contraction is checked against A&R's closed
 * double-couple formulas (4.89); the focal-sphere means ⟨R_P²⟩ = 4/15 and
 * ⟨R_SV² + R_SH²⟩ = 2/5 are integrated numerically (the SV/SH SPLIT depends
 * on the mechanism — SV : SH = 1 : 5 for a vertical strike-slip — so the fallback's
 * even split is itself an average over mechanisms, disclosed); R_P vanishes on both
 * nodal planes and is +1 on the T axis; strike/dip/rake → tensor → planes
 * round-trips; the auxiliary plane gives the SAME tensor.
 *
 * NOT CLAIMED: the radiation coefficient is the far-field POINT-source one
 * (no finite rupture, no directivity), and the take-off angle uses PREM at the
 * hypocentre — a slab or a slow sediment layer bends real take-offs. Near a
 * nodal plane the predicted amplitude collapses toward zero, and a few degrees
 * of take-off error moves it a long way in dB; such arrivals are FLAGGED
 * 'near-nodal' rather than reported as confidently invisible.
 */

const DEG = Math.PI / 180;
/** Focal-sphere RMS coefficients — the fallback when the source is unknown. */
export const RMS_RADIATION = Object.freeze({ P: Math.sqrt(4 / 15), SV: Math.sqrt(1 / 5), SH: Math.sqrt(1 / 5) });
/** |R| below this fraction of the RMS is reported as near a nodal plane. */
export const NEAR_NODAL_FRACTION = 0.2;

// ── small linear algebra ───────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const matVec = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
const unit = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };

/** Scalar moment of a tensor, M0 = √(ΣM²/2) (exact for a pure double couple). */
export function scalarMoment(M) {
    let s = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += M[i][j] * M[i][j];
    return Math.sqrt(s / 2);
}
/** Moment magnitude (Hanks & Kanamori, M0 in N·m). */
export const momentMagnitude = (m0) => (2 / 3) * (Math.log10(m0) - 9.1);

/** Aki & Richards Box 4.4: the double couple of strike φs, dip δ, rake λ (degrees), NED. */
export function doubleCoupleTensor(strikeDeg, dipDeg, rakeDeg, m0 = 1) {
    const f = strikeDeg * DEG, d = dipDeg * DEG, l = rakeDeg * DEG;
    const sd = Math.sin(d), cd = Math.cos(d), s2d = Math.sin(2 * d), c2d = Math.cos(2 * d);
    const sl = Math.sin(l), cl = Math.cos(l);
    const sf = Math.sin(f), cf = Math.cos(f), s2f = Math.sin(2 * f), c2f = Math.cos(2 * f);
    const xx = -(sd * cl * s2f + s2d * sl * sf * sf);
    const xy = sd * cl * c2f + 0.5 * s2d * sl * s2f;
    const xz = -(cd * cl * cf + c2d * sl * sf);
    const yy = sd * cl * s2f - s2d * sl * cf * cf;
    const yz = -(cd * cl * sf - c2d * sl * cf);
    const zz = s2d * sl;
    return [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]].map((r) => r.map((v) => v * m0));
}

/** Fault normal n (pointing into the hanging wall — upward) and slip d, NED. */
export function faultVectors(strikeDeg, dipDeg, rakeDeg) {
    const f = strikeDeg * DEG, d = dipDeg * DEG, l = rakeDeg * DEG;
    const n = [-Math.sin(d) * Math.sin(f), Math.sin(d) * Math.cos(f), -Math.cos(d)];
    const s = [Math.cos(l) * Math.cos(f) + Math.cos(d) * Math.sin(l) * Math.sin(f),
        Math.cos(l) * Math.sin(f) - Math.cos(d) * Math.sin(l) * Math.cos(f),
        -Math.sin(l) * Math.sin(d)];
    return { n, d: s };
}

/** The same double couple built from the fault geometry: M0 (n dᵀ + d nᵀ). */
export function tensorFromVectors(n, d, m0 = 1) {
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => m0 * (n[i] * d[j] + d[i] * n[j])));
}

/** A plane's strike/dip/rake from its (upward-pointing after flip) normal and slip, degrees. */
export function planeFromVectors(nIn, dIn) {
    let n = unit(nIn), d = unit(dIn);
    if (n[2] > 0) { n = n.map((x) => -x); d = d.map((x) => -x); }     // normal points UP (z is down)
    const dip = Math.acos(Math.min(1, Math.max(-1, -n[2])));
    let strike = Math.hypot(n[0], n[1]) < 1e-12 ? 0 : Math.atan2(-n[0], n[1]);
    if (strike < 0) strike += 2 * Math.PI;
    const sd = Math.sin(dip), cd = Math.cos(dip), sf = Math.sin(strike), cf = Math.cos(strike);
    // cos λ = d·(cos φs, sin φs, 0); sin λ from the dip-direction and vertical components together
    // (−d_z = sin λ sin δ, d_x sin φs − d_y cos φs = sin λ cos δ), so a horizontal plane still works.
    const cl = d[0] * cf + d[1] * sf;
    const sl = -d[2] * sd + (d[0] * sf - d[1] * cf) * cd;
    return { strike: strike / DEG, dip: dip / DEG, rake: Math.atan2(sl, cl) / DEG };
}

/** Symmetric 3×3 eigen-decomposition (cyclic Jacobi). Values descending, vectors as columns-list. */
export function eigenSymmetric(Min) {
    const A = Min.map((r) => r.slice());
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
        if (off < 1e-30 * (A[0][0] ** 2 + A[1][1] ** 2 + A[2][2] ** 2 + 1e-300)) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(A[p][q]) < 1e-300) continue;
            const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {          // A ← A·J
                const akp = A[k][p], akq = A[k][q];
                A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {          // A ← Jᵀ·A
                const apk = A[p][k], aqk = A[q][k];
                A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = V[k][p], vkq = V[k][q];
                V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const out = [0, 1, 2].map((i) => ({ value: A[i][i], vector: [V[0][i], V[1][i], V[2][i]] }));
    return out.sort((a, b) => b.value - a.value);
}

/**
 * Everything the page needs from a tensor (NED, any units): normalised M̂,
 * M0, the T/N/P axes, the best double couple's two nodal planes, and the
 * double-couple percentage (100(1 − 2|ε|), ε = −λ_N / max|λ|).
 */
export function decompose(M) {
    const tr = (M[0][0] + M[1][1] + M[2][2]) / 3;
    const dev = M.map((r, i) => r.map((v, j) => v - (i === j ? tr : 0)));
    const eig = eigenSymmetric(dev);
    const [T, N, P] = eig;
    const big = Math.max(Math.abs(T.value), Math.abs(P.value));
    const m0 = (Math.abs(T.value) + Math.abs(P.value)) / 2;
    const eps = big > 0 ? -N.value / big : 0;
    const t = T.vector, p = P.vector;
    const n1 = unit(t.map((x, i) => x + p[i])), d1 = unit(t.map((x, i) => x - p[i]));
    const plane1 = planeFromVectors(n1, d1), plane2 = planeFromVectors(d1, n1);
    const norm = m0 > 0 ? m0 : 1;
    return {
        m0, mHat: M.map((r) => r.map((v) => v / norm)), isotropicFraction: m0 > 0 ? tr / m0 : 0,
        axes: { T: axis(t, T.value), N: axis(N.vector, N.value), P: axis(p, P.value) },
        planes: [plane1, plane2], percentDC: 100 * (1 - 2 * Math.abs(eps)),
    };
}
/** An axis as trend/plunge (degrees, plunge downward positive). */
function axis(vIn, value) {
    let v = unit(vIn);
    if (v[2] < 0) v = v.map((x) => -x);
    let trend = Math.atan2(v[1], v[0]) / DEG;
    if (trend < 0) trend += 360;
    return { trend, plunge: Math.asin(Math.min(1, v[2])) / DEG, value, vector: v };
}

/** Ray direction and the two S polarisation vectors at take-off. */
export function rayFrame(takeoffRad, azimuthRad) {
    const si = Math.sin(takeoffRad), ci = Math.cos(takeoffRad), sf = Math.sin(azimuthRad), cf = Math.cos(azimuthRad);
    return { g: [si * cf, si * sf, ci], sv: [ci * cf, ci * sf, -si], sh: [-sf, cf, 0] };
}

/** Signed radiation coefficients for one take-off direction. `mHat` is NED, normalised by M0. */
export function radiationCoefficients(mHat, takeoffRad, azimuthRad) {
    const { g, sv, sh } = rayFrame(takeoffRad, azimuthRad);
    const Mg = matVec(mHat, g);
    return { P: dot(g, Mg), SV: dot(sv, Mg), SH: dot(sh, Mg) };
}

/**
 * Aki & Richards (4.89): the closed double-couple radiation pattern, written
 * independently of the tensor (the gate checks the two against each other).
 */
export function doubleCoupleRadiation(strikeDeg, dipDeg, rakeDeg, takeoffRad, azimuthRad) {
    const d = dipDeg * DEG, l = rakeDeg * DEG, i = takeoffRad, f = azimuthRad - strikeDeg * DEG;
    const sl = Math.sin(l), cl = Math.cos(l), sd = Math.sin(d), cd = Math.cos(d), s2d = Math.sin(2 * d), c2d = Math.cos(2 * d);
    const si = Math.sin(i), ci = Math.cos(i), s2i = Math.sin(2 * i), c2i = Math.cos(2 * i);
    const sf = Math.sin(f), cf = Math.cos(f), s2f = Math.sin(2 * f), c2f = Math.cos(2 * f);
    return {
        P: cl * sd * si * si * s2f - cl * cd * s2i * cf + sl * s2d * (ci * ci - si * si * sf * sf) + sl * c2d * s2i * sf,
        SV: sl * c2d * c2i * sf - cl * cd * c2i * cf + 0.5 * cl * sd * s2i * s2f - 0.5 * sl * s2d * s2i * (1 + sf * sf),
        SH: cl * cd * ci * sf + cl * sd * si * c2f + sl * c2d * ci * cf - 0.5 * sl * s2d * si * s2f,
    };
}

/**
 * Take-off angle of a ray of slowness p (s/rad) from a source at radius rs
 * with speed v there: sin i = p v / r. Down-going leaves at i ≤ 90°, up-going
 * (pP, sS, p, s …) at π − i. Returns null for an evanescent p.
 */
export function takeoffAngle(p, vKmS, rsKm, downgoing) {
    const s = p * vKmS / rsKm;
    if (!(s <= 1 + 1e-9)) return null;
    const i = Math.asin(Math.min(1, s));
    return downgoing ? i : Math.PI - i;
}

/** Lower-hemisphere equal-area (Schmidt) projection of a take-off direction → (x east, y north), unit circle. */
export function projectLowerHemisphere(takeoffRad, azimuthRad) {
    let i = takeoffRad, f = azimuthRad;
    if (i > Math.PI / 2) { i = Math.PI - i; f += Math.PI; }        // an up-going ray plots at its antipode
    const r = Math.SQRT2 * Math.sin(i / 2);
    return { x: r * Math.sin(f), y: r * Math.cos(f) };
}
/** Inverse of the projection (inside the unit circle). */
export function unprojectLowerHemisphere(x, y) {
    const r = Math.hypot(x, y);
    if (r > 1) return null;
    return { takeoffRad: 2 * Math.asin(r / Math.SQRT2), azimuthRad: Math.atan2(x, y) };
}

/** Sign of R_P on a square n×n grid over the beachball (1 compression, −1 dilatation, 0 outside). */
export function beachballGrid(mHat, n = 64) {
    const out = new Int8Array(n * n);
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
        const x = (2 * (col + 0.5)) / n - 1, y = 1 - (2 * (row + 0.5)) / n;
        const u = unprojectLowerHemisphere(x, y);
        if (!u) continue;
        out[row * n + col] = radiationCoefficients(mHat, u.takeoffRad, u.azimuthRad).P >= 0 ? 1 : -1;
    }
    return out;
}

// ── USGS product parsing ───────────────────────────────────────────────────
const TENSOR_KEYS = Object.freeze({
    rr: ['tensor-mrr'], tt: ['tensor-mtt'], pp: ['tensor-mpp'],
    rt: ['tensor-mrt'], rp: ['tensor-mrp'], tp: ['tensor-mtp'],
});
const PLANE_KEYS = Object.freeze({
    strike: ['nodal-plane-1-strike'], dip: ['nodal-plane-1-dip'], rake: ['nodal-plane-1-rake', 'nodal-plane-1-slip'],
});
const num = (v) => { const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(x) ? x : null; };
const pick = (props, keys) => { for (const k of keys) { const v = num(props?.[k]); if (v !== null) return { v, key: k }; } return null; };

/** USE (r, t, p) components → NED. */
export function useToNed({ rr, tt, pp, rt, rp, tp }) {
    return [[tt, -tp, rt], [-tp, pp, -rp], [rt, -rp, rr]];
}

/**
 * The mechanism of a USGS event detail (GeoJSON from properties.detail):
 * the preferred 'moment-tensor' product first (full tensor), else a
 * 'focal-mechanism' product (one nodal plane ⇒ a double couple). Every
 * component resolves from a candidate list and the result reports which key
 * answered and which were missing — the upstream schema is not re-asserted.
 */
export function parseMechanism(detail) {
    const products = detail?.properties?.products ?? {};
    const tried = [];
    for (const type of ['moment-tensor', 'focal-mechanism']) {
        const list = Array.isArray(products[type]) ? products[type] : [];
        // USGS lists the PREFERRED product first; keep that order.
        for (const prod of list) {
            const pr = prod?.properties ?? {};
            const source = `${type}:${prod?.source ?? pr['beachball-source'] ?? '?'}`;
            tried.push(source);
            const comps = {}, missing = [];
            for (const [k, keys] of Object.entries(TENSOR_KEYS)) { const h = pick(pr, keys); if (h) comps[k] = h.v; else missing.push(keys[0]); }
            const m0Pub = pick(pr, ['scalar-moment'])?.v ?? null;
            const depth = pick(pr, ['derived-depth'])?.v ?? null;
            const magPub = pick(pr, ['derived-magnitude'])?.v ?? null;
            const methodRaw = pr['derived-magnitude-type'] ?? pr['beachball-type'] ?? null;
            const common = { product: type, source: prod?.source ?? null, method: methodRaw, publishedM0: m0Pub, derivedDepthKm: depth,
                derivedMagnitude: magPub, percentDCPublished: pick(pr, ['percent-double-couple'])?.v ?? null };
            if (!missing.length) {
                const M = useToNed(comps);
                const dec = decompose(M);
                if (dec.m0 > 0) return { ...common, kind: 'tensor', tensorNed: M, ...dec, mw: momentMagnitude(dec.m0), unmapped: [], tried };
            }
            const pl = { strike: pick(pr, PLANE_KEYS.strike), dip: pick(pr, PLANE_KEYS.dip), rake: pick(pr, PLANE_KEYS.rake) };
            if (pl.strike && pl.dip && pl.rake) {
                const m0 = m0Pub ?? 1;
                const M = doubleCoupleTensor(pl.strike.v, pl.dip.v, pl.rake.v, m0);
                const dec = decompose(M);
                return { ...common, kind: 'double-couple', tensorNed: M, ...dec, m0: m0Pub, mw: m0Pub ? momentMagnitude(m0Pub) : null,
                    unmapped: missing, tried };
            }
        }
    }
    return { kind: null, tried, reason: tried.length ? 'products present but unreadable' : 'no moment tensor or focal mechanism published' };
}

/** The radiation term for one ray: |R| for the recorded polarisation, signed R, near-nodal flag. */
export function rayRadiation(mHat, { takeoffRad, azimuthRad, wave, polarization }) {
    const R = radiationCoefficients(mHat, takeoffRad, azimuthRad);
    const comp = wave === 'P' ? 'P' : polarization;
    const value = R[comp];
    return { component: comp, signed: value, magnitude: Math.abs(value), all: R,
        nearNodal: Math.abs(value) < NEAR_NODAL_FRACTION * RMS_RADIATION[comp] };
}
