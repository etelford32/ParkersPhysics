/**
 * diagnostics.js — what a plate reconstruction says about the planet at time t (PURE).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. Every number is computed HERE, from the baked boundaries and our own
 * rotation kernel — never read from the model's tables. tests/plate-history-diagnostics.mjs
 * then holds them to an oracle we did not write: Merdith et al. (2021) SM3a/SM3b, their
 * published ridge length, trench length and crust production/consumption every 1 Myr.
 *
 *   RIDGES. A "MidOceanRidge" feature in the model is a zig-zag of spreading segments AND the
 *   transform offsets between them. A piece is a SPREADING segment when the relative motion of
 *   the two plates it separates is within OBLIQUITY_MAX_DEG of its normal; otherwise it is a
 *   transform and counts as neither ridge length nor production. 70° is the threshold GPlates'
 *   own tooling uses (gplately ptt DEFAULT_TRANSFORM_SEGMENT_DEVIATION_DEGREES), stated, not
 *   fitted. CRUST PRODUCTION is Σ length × the OPENING rate (the normal component of relative
 *   motion — the rate at which sea floor area is made; the full rate on an oblique ridge would
 *   count motion along it as new area).
 *
 *   TRENCHES. Every "SubductionZone" piece counts toward length. CONSUMPTION is Σ length × the
 *   convergence rate of the SUBDUCTING plate relative to the OVERRIDING plate, normal to the
 *   trench (pygplates names both plates per piece; a piece where it cannot is counted in length
 *   only, and `unknownPolarityKm` says how much). Divergence across a "trench" is not negative
 *   consumption; it is reported as `openingKm` (the model drawing a trench where plates part).
 *
 *   PLATE SPEED. Area-weighted RMS of |v| over the 1° plate raster (cell area ∝ cos φ), each
 *   cell moving with its plate's rotation; the continental RMS is the same over continental
 *   cells only.
 *
 *   SUPERCONTINENT INDEX. Continents carried to t; R̄ = |Σ A_i ĉ_i| / Σ A_i, the area-weighted
 *   mean resultant length of the continental polygons' centroids (1 = all continental crust at
 *   one point, 0 = spread evenly round the globe). It knows no names and no dates; whether its
 *   peaks fall on Pangaea, Rodinia and Nuna is a measurement.
 *
 * All velocities from rotations.js eulerVector (stage t+1 → t). Units: km, Myr, km²/Myr.
 */
import { R_EARTH_KM } from './rotations.js';

export const OBLIQUITY_MAX_DEG = 70;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** Unit-sphere arc between two unit vectors (radians). */
export function arc(a, b) { return Math.atan2(norm(cross(a, b)), dot(a, b)); }

function pieces(xyz, fn) {
    for (let j = 0; j + 5 < xyz.length; j += 3) {
        const a = [xyz[j], xyz[j + 1], xyz[j + 2]], b = [xyz[j + 3], xyz[j + 4], xyz[j + 5]];
        const len = arc(a, b);
        if (len < 1e-12) continue;
        const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mn = norm(m);
        const r = scale(m, 1 / mn);
        const tan = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const left = cross(r, tan), ln = norm(left);
        fn(r, len * R_EARTH_KM, scale(left, 1 / ln));
    }
}

/** Velocity (km/Myr, 3-D) of a plate with Euler vector w (rad/Myr) at unit point r. */
const vel = (w, r) => scale(cross(w, r), R_EARTH_KM);

/**
 * Ridge + trench statistics for boundary segments `segs` (from frames.js boundariesAt) at t.
 * opts.obliquityMaxDeg overrides the ridge/transform split (the gate's negative control).
 */
export function boundaryStats(model, segs, t, opts = {}) {
    const obl = (opts.obliquityMaxDeg ?? OBLIQUITY_MAX_DEG) * Math.PI / 180;
    const cosObl = Math.cos(obl);
    const W = new Map();
    const w = (pid) => { if (!W.has(pid)) W.set(pid, model.eulerVector(pid, t)); return W.get(pid); };
    const out = {
        ridgeKm: 0, ridgeTransformKm: 0, ridgeUnpairedKm: 0, productionKm2: 0, productionFullRateKm2: 0,
        trenchKm: 0, consumptionKm2: 0, openingKm: 0, unknownPolarityKm: 0, transformKm: 0, otherKm: 0,
        byType: {},
    };
    for (const s of segs) {
        let typeLen = 0;
        if (s.type === 'MidOceanRidge') {
            pieces(s.xyz, (r, L, nl) => {
                typeLen += L;
                if (s.left < 0 || s.right < 0) { out.ridgeUnpairedKm += L; return; }
                const v = vel([w(s.left)[0] - w(s.right)[0], w(s.left)[1] - w(s.right)[1], w(s.left)[2] - w(s.right)[2]], r);
                const sp = norm(v);
                const open = Math.abs(dot(v, nl));
                if (sp === 0 || open / sp >= cosObl) {
                    out.ridgeKm += L; out.productionKm2 += L * open; out.productionFullRateKm2 += L * sp;
                } else out.ridgeTransformKm += L;
            });
        } else if (s.type === 'SubductionZone') {
            pieces(s.xyz, (r, L, nl) => {
                typeLen += L; out.trenchKm += L;
                if (s.over < 0 || s.sub < 0) { out.unknownPolarityKm += L; return; }
                const ws = w(s.sub), wo = w(s.over);
                const v = vel([ws[0] - wo[0], ws[1] - wo[1], ws[2] - wo[2]], r);
                // Normal pointing from the subducting side INTO the overriding plate.
                const toOver = s.over === s.left ? nl : s.over === s.right ? scale(nl, -1) : null;
                if (!toOver) { out.unknownPolarityKm += L; return; }
                const c = dot(v, toOver);
                if (c >= 0) out.consumptionKm2 += L * c; else out.openingKm += L;
            });
        } else {
            pieces(s.xyz, (r, L) => { typeLen += L; });
            if (s.type === 'Transform') out.transformKm += typeLen; else out.otherKm += typeLen;
        }
        out.byType[s.type] = (out.byType[s.type] || 0) + typeLen;
    }
    return out;
}

/**
 * Area-weighted RMS plate speed over the frame's raster at t (mm/yr = km/Myr).
 * `isContinental(lat, lon)` (optional) restricts a second RMS to continental cells.
 */
export function speedStats(model, fr, frame, t, isContinental = null) {
    const d = fr.rasterDeg, nc = 360 / d, nr = 180 / d, DEG = Math.PI / 180;
    const W = frame.plates.map((p) => model.eulerVector(p.p, t));
    let s2 = 0, sw = 0, c2 = 0, cw = 0, mx = 0;
    for (let i = 0; i < nr; i++) {
        const lat = 90 - d * (i + 0.5), cl = Math.cos(lat * DEG);
        for (let j = 0; j < nc; j++) {
            const k = frame.raster[i * nc + j];
            if (k === 255) continue;
            const lon = -180 + d * (j + 0.5);
            const r = [cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG)];
            const v = norm(vel(W[k], r));
            s2 += cl * v * v; sw += cl; mx = Math.max(mx, v);
            if (isContinental && isContinental(lat, lon)) { c2 += cl * v * v; cw += cl; }
        }
    }
    return { rms: sw ? Math.sqrt(s2 / sw) : NaN, continentalRms: cw ? Math.sqrt(c2 / cw) : NaN, max: mx, coverage: sw };
}

/** Signed solid angle of a closed ring of unit vectors (Van Oosterom–Strackee fan from its centroid). */
export function ringArea(xyz) {
    const n = xyz.length / 3;
    let c = [0, 0, 0];
    for (let i = 0; i < n; i++) { c[0] += xyz[3 * i]; c[1] += xyz[3 * i + 1]; c[2] += xyz[3 * i + 2]; }
    c = scale(c, 1 / norm(c));
    let area = 0;
    for (let i = 0; i < n; i++) {
        const a = [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]];
        const k = (i + 1) % n;
        const b = [xyz[3 * k], xyz[3 * k + 1], xyz[3 * k + 2]];
        const num = dot(c, cross(a, b));
        const den = 1 + dot(c, a) + dot(a, b) + dot(b, c);
        area += 2 * Math.atan2(num, den);
    }
    return { area, centroid: c };
}

/**
 * Supercontinent index from continents carried to t (frames.js shapesAt output).
 * { index: R̄, areaSr, centroid, n } — areaSr is the total continental area in steradians.
 */
export function supercontinentIndex(placed) {
    let S = [0, 0, 0], A = 0, n = 0;
    for (const p of placed) {
        const { area, centroid } = ringArea(p.xyz);
        const a = Math.abs(area);
        if (!(a > 0) || a > 2 * Math.PI) continue;   // a ring wound the long way round is not a continent
        S = [S[0] + centroid[0] * a, S[1] + centroid[1] * a, S[2] + centroid[2] * a]; A += a; n++;
    }
    const R = A ? norm(S) / A : NaN;
    return { index: R, areaSr: A, centroid: A ? scale(S, 1 / norm(S)) : null, n };
}
