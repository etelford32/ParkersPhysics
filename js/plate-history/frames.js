/**
 * frames.js — the baked plate topologies and continents, decoded and carried to any time (PURE).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. Reads data/plate-history/frames.json.gz and continents.json.gz (both
 * baked by scripts/build-plate-history.py; format in that script's header).
 *
 * WHAT MOVES, AND HOW:
 *   • CONTINENTS move EXACTLY at any instant: each is a present-day polygon on one plate, and
 *     its position at t is that plate's total rotation (rotations.js). It exists at t when its
 *     valid time [begin ≥ t ≥ end] contains t — the end-to-end gate checks that rule and the
 *     plate ids against pygplates.reconstruct.
 *   • PLATE BOUNDARIES are resolved by pygplates every STEP Myr (5). Between frames each
 *     boundary piece is carried by ITS OWN FEATURE's stage rotation from the nearest frame's
 *     time to t — so ridges and trenches glide with the plates instead of jumping every 5 Myr.
 *     Where a boundary's shape CHANGES (a ridge jump, a new trench), it changes at the frame:
 *     that is the model's own time resolution, not ours to invent.
 *   • The PLATE RASTER (which plate is where, 1°) is HELD at the nearest frame. It is used for
 *     area-weighted statistics and for picking, never drawn as if it were finer than it is.
 */
import { qMul, qConj, qRotate, unit, latLon } from './rotations.js';

const NO_PLATE = 255;

/** Decode a delta-coded 0.01° line into a Float64Array of [lat, lon, lat, lon, …]. */
export function decodeLine(code, q = 100) {
    const out = new Float64Array(code.length);
    let la = 0, lo = 0;
    for (let i = 0; i < code.length; i += 2) {
        la += code[i]; lo += code[i + 1];
        out[i] = la / q; out[i + 1] = lo / q;
    }
    return out;
}

/** Run-length [value, run, …] → Uint8Array. */
export function decodeRle(rle, n) {
    const out = new Uint8Array(n);
    let k = 0;
    for (let i = 0; i < rle.length; i += 2) { out.fill(rle[i], k, k + rle[i + 1]); k += rle[i + 1]; }
    if (k !== n) throw new Error(`raster run-length covers ${k} cells, expected ${n}`);
    return out;
}

/** Decode the frames document into usable frames. */
export function decodeFrames(doc) {
    const n = (180 / doc.rasterDeg) * (360 / doc.rasterDeg);
    const typeIndex = Object.fromEntries(doc.types.map((t, i) => [t, i]));
    const frames = doc.frames.map((f) => ({
        t: f.t,
        plates: f.plates,
        raster: decodeRle(f.raster, n),
        segs: f.segs.map(([type, fp, left, right, over, sub, line]) => ({
            type: doc.types[type], featurePlate: fp, left, right, over, sub, pts: decodeLine(line, doc.q),
        })),
    }));
    return { stepMa: doc.stepMa, tMaxMa: doc.tMaxMa, rasterDeg: doc.rasterDeg, types: doc.types, typeIndex, frames };
}

/** Decode continents/coasts: each { plate, begin, end, name, pts: Float64Array lat/lon ring }. */
export function decodeShapes(doc) {
    const one = (s) => ({ plate: s.p, begin: s.b, end: s.e, name: s.n, pts: decodeLine(s.r, doc.q) });
    return { continents: doc.continents.map(one), coasts: doc.coasts.map(one), forever: doc.forever };
}

/** Index of the frame nearest t (frames are 0, step, 2·step, …). */
export function frameIndexAt(fr, t) {
    const i = Math.round(t / fr.stepMa);
    return Math.max(0, Math.min(fr.frames.length - 1, i));
}

/** Does a shape exist at time t? (valid time begin ≥ t ≥ end, as GPlates.) */
export const existsAt = (s, t) => s.begin >= t && t >= s.end;

/** Rotate a lat/lon array by quaternion q → Float64Array of unit xyz. */
export function rotateLine(q, pts) {
    const out = new Float64Array((pts.length / 2) * 3);
    for (let i = 0, j = 0; i < pts.length; i += 2, j += 3) {
        const v = qRotate(q, unit(pts[i], pts[i + 1]));
        out[j] = v[0]; out[j + 1] = v[1]; out[j + 2] = v[2];
    }
    return out;
}

/** Continents (or coasts) existing at t, each as { shape, xyz } — the polygon carried to t. */
export function shapesAt(model, shapes, t) {
    const out = [];
    for (const s of shapes) {
        if (!existsAt(s, t)) continue;
        out.push({ shape: s, xyz: rotateLine(model.total(s.plate, t), s.pts) });
    }
    return out;
}

/**
 * Boundary segments at time t: the nearest frame's, each carried by its feature's stage rotation
 * from the frame time to t. Returns { frame, segs: [{ ...seg, xyz }] }.
 */
export function boundariesAt(model, fr, t) {
    const frame = fr.frames[frameIndexAt(fr, t)];
    const dq = new Map();
    const carry = (pid) => {
        if (!dq.has(pid)) dq.set(pid, frame.t === t ? null : qMul(model.total(pid, t), qConj(model.total(pid, frame.t))));
        return dq.get(pid);
    };
    const segs = frame.segs.map((s) => {
        const q = carry(s.featurePlate);
        let xyz;
        if (!q) {
            xyz = new Float64Array((s.pts.length / 2) * 3);
            for (let i = 0, j = 0; i < s.pts.length; i += 2, j += 3) {
                const v = unit(s.pts[i], s.pts[i + 1]); xyz[j] = v[0]; xyz[j + 1] = v[1]; xyz[j + 2] = v[2];
            }
        } else xyz = rotateLine(q, s.pts);
        return { ...s, xyz };
    });
    return { frame, segs };
}

/** Plate (frame plate record) at (lat, lon) in the frame's raster, or null. */
export function plateAt(fr, frame, latDeg, lonDeg) {
    const d = fr.rasterDeg, nc = 360 / d, nr = 180 / d;
    const r = Math.min(nr - 1, Math.max(0, Math.floor((90 - latDeg) / d)));
    let c = Math.floor((((lonDeg + 180) % 360) + 360) % 360 / d);
    c = Math.min(nc - 1, c);
    const k = frame.raster[r * nc + c];
    return k === NO_PLATE ? null : frame.plates[k];
}

export { NO_PLATE, latLon };
