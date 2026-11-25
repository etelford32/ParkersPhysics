/**
 * rotations.js — the plate-rotation hierarchy of a kinematic reconstruction (PURE).
 * ═══════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. Reads data/plate-history/rotations.json.gz (baked by
 * scripts/build-plate-history.py from the Cao et al. 1.8 Ga model's two PLATES4 .rot files).
 *
 * THE MODEL. Each line of a rotation file is a FINITE rotation (Euler pole + angle) of a
 * MOVING plate relative to a FIXED plate, at a time in Ma. Consecutive lines with the same
 * (moving, fixed) pair form a SEQUENCE. The position of plate P at time t relative to the
 * ANCHOR (plate 0, here the palaeomagnetic frame) is a chain:
 *
 *     R_P(t) = R_fixed(t) · R_{P→fixed}(t)          (R_anchor ≡ identity)
 *
 * where R_{P→fixed}(t) is interpolated between the sequence's two samples that bracket t by
 * spherical-linear interpolation of their unit QUATERNIONS (slerp, taking the shorter arc).
 * A plate may change its fixed plate through time ("crossovers"); at each t the FIRST sequence
 * in file order whose [first, last] sample times contain t is used. A plate with no such
 * sequence at t — or whose chain to the anchor is BROKEN anywhere above it (an ancestor with
 * no sequence at t) — has no rotation at all: it is held at the IDENTITY relative to the
 * anchor, as pygplates does (a rotation relative to its own fixed plate is NOT enough). tests/plate-history-rotations.mjs holds every one of these rules to
 * pygplates 1.0 at 800+ (plate, time) pairs including the awkward ones.
 *
 * VELOCITY. Plate motion at time t is the STAGE rotation from t + Δ to t (Δ = 1 Myr, GPlates'
 * default): S = R_P(t) · R_P(t+Δ)⁻¹. Its Euler vector ω = axis · angle/Δ gives v = ω × r.
 * 1 km/Myr ≡ 1 mm/yr.
 *
 * Conventions: unit quaternions [w, x, y, z] in ECEF (x → 0°E, z → north). Time is Ma,
 * positive into the past.
 */

export const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;

// ── quaternion algebra ───────────────────────────────────────────────────────────────────
export const Q_IDENTITY = Object.freeze([1, 0, 0, 0]);

export function unit(latDeg, lonDeg) {
    const a = latDeg * DEG, b = lonDeg * DEG;
    return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
export function latLon(v) {
    const n = Math.hypot(v[0], v[1], v[2]);
    return { lat: Math.asin(Math.max(-1, Math.min(1, v[2] / n))) / DEG, lon: Math.atan2(v[1], v[0]) / DEG };
}

/** Quaternion of a rotation by angleDeg about the pole (lat, lon). */
export function qFromPole(latDeg, lonDeg, angleDeg) {
    const u = unit(latDeg, lonDeg), h = angleDeg * DEG / 2, s = Math.sin(h);
    return [Math.cos(h), u[0] * s, u[1] * s, u[2] * s];
}
export function qMul(a, b) {
    return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
}
export const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
/** Canonical sign (w ≥ 0) — q and −q are the same rotation. */
export const qCanon = (q) => (q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q.slice());

export function qSlerp(a, b, f) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
    let ka, kb;
    if (d > 1 - 1e-12) { ka = 1 - f; kb = f; }
    else {
        const th = Math.acos(d), s = Math.sin(th);
        ka = Math.sin((1 - f) * th) / s; kb = Math.sin(f * th) / s;
    }
    const q = [ka * a[0] + kb * bb[0], ka * a[1] + kb * bb[1], ka * a[2] + kb * bb[2], ka * a[3] + kb * bb[3]];
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function qNlerp(a, b, f) {
    const sg = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
    const q = a.map((x, i) => (1 - f) * x + f * sg * b[i]);
    const n = Math.hypot(...q);
    return q.map((x) => x / n);
}

/** Rotate vector v by unit quaternion q. */
export function qRotate(q, v) {
    const [w, x, y, z] = q;
    // t = 2 q_vec × v ; v' = v + w t + q_vec × t
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Rotation angle (radians, in [0, π]) between two quaternions — 0 when they are the same rotation. */
export function qAngleBetween(a, b) {
    // Angle of a · b⁻¹ by atan2 — acos of a dot product near 1 loses half the digits.
    const r = qMul(a, qConj(b));
    return 2 * Math.atan2(Math.hypot(r[1], r[2], r[3]), Math.abs(r[0]));
}

/** Euler vector (rad per unit time) of a quaternion rotation spread over dt. */
export function qEulerVector(q, dt) {
    const c = qCanon(q);
    const s = Math.hypot(c[1], c[2], c[3]);
    if (s < 1e-15) return [0, 0, 0];
    const ang = 2 * Math.atan2(s, c[0]);
    const k = ang / (s * dt);
    return [c[1] * k, c[2] * k, c[3] * k];
}

/** 3×3 row-major rotation matrix of a quaternion (for renderers). */
export function qMatrix(q) {
    const [w, x, y, z] = q;
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
}

// ── the model ────────────────────────────────────────────────────────────────────────────
/**
 * Build a rotation model from the baked document { anchor, seqs: [{ m, f, t[], lat[], lon[], a[] }] }.
 * Returns { total, stage, eulerVector, velocity, reconstruct, plates, tRange }.
 */
export function createRotationModel(doc, opts = {}) {
    const anchor = doc.anchor ?? 0;
    // NEGATIVE CONTROLS ONLY (tests/plate-history-rotations.mjs): the two rules this kernel got
    // wrong once. `interp: 'nlerp'` interpolates quaternions linearly; `brokenCircuit: 'skip'`
    // treats a broken ancestor as the anchor instead of holding the plate at identity.
    const nlerp = opts.interp === 'nlerp', skipBroken = opts.brokenCircuit === 'skip';
    const byPlate = new Map();
    let tMin = Infinity, tMax = -Infinity;
    for (const s of doc.seqs) {
        const qs = s.t.map((_, i) => qFromPole(s.lat[i], s.lon[i], s.a[i]));
        const rec = { m: s.m, f: s.f, t: s.t, q: qs, lo: Math.min(...s.t), hi: Math.max(...s.t) };
        if (!byPlate.has(s.m)) byPlate.set(s.m, []);
        byPlate.get(s.m).push(rec);
        tMin = Math.min(tMin, rec.lo); tMax = Math.max(tMax, rec.hi);
    }

    function relative(seq, t) {
        const T = seq.t;
        // samples are written in increasing time in these files; tolerate equal neighbours.
        for (let i = 0; i < T.length - 1; i++) {
            const t0 = T[i], t1 = T[i + 1];
            if (t >= Math.min(t0, t1) && t <= Math.max(t0, t1)) {
                if (t1 === t0) return seq.q[i];
                const f = (t - t0) / (t1 - t0);
                return nlerp ? qNlerp(seq.q[i], seq.q[i + 1], f) : qSlerp(seq.q[i], seq.q[i + 1], f);
            }
        }
        return T.length === 1 ? seq.q[0] : null;
    }

    // Per-time memo of every plate's chain. A few times are kept, not one: a velocity asks for
    // t and t + Δ alternately and a single-entry cache rebuilt every chain on every call.
    const caches = new Map();
    let cache = null;
    function total(pid, t) {
        cache = caches.get(t);
        if (!cache) {
            if (caches.size >= 8) caches.delete(caches.keys().next().value);
            cache = new Map(); caches.set(t, cache);
        }
        return totalAt(pid, t, 0);
    }
    function totalAt(pid, t, depth) {
        const q = chain(pid, t, depth);
        return q || Q_IDENTITY;
    }
    /** The rotation to the anchor, or null when the plate circuit is BROKEN at t. */
    function chain(pid, t, depth) {
        if (pid === anchor) return Q_IDENTITY;
        if (cache.has(pid)) return cache.get(pid);
        let out = null;
        if (depth < 64) {
            const seqs = byPlate.get(pid);
            if (seqs) for (const s of seqs) {
                if (t < s.lo || t > s.hi) continue;
                const rel = relative(s, t);
                if (!rel) continue;
                const up = chain(s.f, t, depth + 1) || (skipBroken ? Q_IDENTITY : null);
                out = up ? qMul(up, rel) : null;
                break;
            }
        }
        cache.set(pid, out);
        return out;
    }

    /** Stage rotation carrying plate pid from its position at t + dt to its position at t. */
    function stage(pid, t, dt = 1) {
        const a = total(pid, t + dt), b = total(pid, t);
        return qMul(b, qConj(a));
    }

    // ── ROTATION SEAMS ─────────────────────────────────────────────────────────────────────
    // A seam is a time at which a plate's total rotation JUMPS: it changes sequence (a new
    // fixed plate, or the second rotation file taking over at 1000 Ma) and the two poles do not
    // agree, or its circuit starts/stops. Positions jump there — that is the model, and the
    // page draws it. A VELOCITY differenced across a jump is not a velocity (measured: 13 600
    // mm/yr at 1000 Ma, 12 240 RMS at 1800 Ma), so eulerVector takes the stage from the side of
    // t where the rotation is continuous. Seams can only sit at a sequence's first or last
    // sample, so those times are the candidates; a candidate is a seam for plate P when P's
    // total rotation either side of it differs by more than SEAM_DEG.
    const SEAM_EPS = 1e-6, SEAM_DEG = 1e-3;
    const validTo = doc.validToMa ?? Infinity;
    const candidates = [...new Set(doc.seqs.flatMap((s) => [Math.min(...s.t), Math.max(...s.t)]))].sort((a, b) => a - b);
    const seamMemo = new Map();
    function isSeam(pid, T) {
        const key = pid + '@' + T;
        if (!seamMemo.has(key)) seamMemo.set(key, qAngleBetween(total(pid, T - SEAM_EPS), total(pid, T + SEAM_EPS)) > SEAM_DEG * DEG);
        return seamMemo.get(key);
    }
    /** Seam times of plate pid inside [a, b] (sorted). */
    function seamsIn(pid, a, b) {
        let lo = 0, hi = candidates.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (candidates[m] < a) lo = m + 1; else hi = m; }
        const out = [];
        for (let i = lo; i < candidates.length && candidates[i] <= b; i++) if (isSeam(pid, candidates[i])) out.push(candidates[i]);
        return out;
    }
    /**
     * The interval [young, old] the velocity at t is differenced over: GPlates' [t, t + dt]
     * EXACTLY when no seam touches it; otherwise the longest clean interval of up to dt that
     * ends at t on the older side, else on the younger side. `side` says which was used.
     */
    function velocityInterval(pid, t, dt = 1) {
        const near = seamsIn(pid, t - dt - SEAM_EPS, t + dt + SEAM_EPS);
        // The model's oldest edge counts as a seam: past validToMa every plate is at identity.
        if (t + dt > validTo + SEAM_EPS) near.push(validTo), near.sort((a, b) => a - b);
        if (!near.some((T) => T >= t - SEAM_EPS && T <= t + dt + SEAM_EPS)) return { young: t, old: t + dt, side: 'gplates' };
        const atT = near.some((T) => Math.abs(T - t) <= SEAM_EPS);
        const minLen = 0.05 * dt;
        // Older side: from t (or just past a seam AT t) to the next seam.
        const y0 = atT ? t + 2 * SEAM_EPS : t;
        const next = near.find((T) => T > y0 + SEAM_EPS);
        const o0 = Math.min(next === undefined ? t + dt : Math.min(t + dt, next - 2 * SEAM_EPS), validTo);
        if (o0 - y0 >= minLen) return { young: y0, old: o0, side: 'older' };
        // Younger side: from the previous seam (or t − dt) up to t (or just before a seam AT t).
        const o1 = atT ? t - 2 * SEAM_EPS : t;
        const prev = [...near].reverse().find((T) => T < o1 - SEAM_EPS);
        const y1 = prev === undefined ? Math.max(0, t - dt) : Math.max(Math.max(0, t - dt), prev + 2 * SEAM_EPS);
        if (o1 - y1 >= minLen) return { young: y1, old: o1, side: 'younger' };
        return { young: t, old: t + dt, side: 'none' };
    }
    /** Euler vector (rad/Myr) of plate pid's motion at time t (see ROTATION SEAMS). */
    function eulerVector(pid, t, dt = 1) {
        const iv = velocityInterval(pid, t, dt);
        if (iv.side === 'none') return [NaN, NaN, NaN];
        const a = total(pid, iv.old);
        const b = total(pid, iv.young);
        return qEulerVector(qMul(b, qConj(a)), iv.old - iv.young);
    }
    /** Surface velocity (mm/yr = km/Myr) of plate pid at (lat, lon) at time t. */
    function velocity(pid, t, latDeg, lonDeg, dt = 1) {
        return velocityFromEuler(eulerVector(pid, t, dt), latDeg, lonDeg);
    }
    /** Every seam of plate pid in [a, b] — for the page's disclosure and the gate. */
    function seams(pid, a = tMin, b = tMax) { return seamsIn(pid, a, b); }
    /** Present-day point (lat, lon) on plate pid, carried to time t. */
    function reconstruct(pid, t, latDeg, lonDeg) {
        return latLon(qRotate(total(pid, t), unit(latDeg, lonDeg)));
    }
    return { total, stage, eulerVector, velocityInterval, velocity, reconstruct, seams, plates: [...byPlate.keys()], tRange: [tMin, tMax], validToMa: validTo };
}

/** v = ω × r at (lat, lon): { east, north, speed } in mm/yr, azimuth clockwise from north. */
export function velocityFromEuler(w, latDeg, lonDeg, rKm = R_EARTH_KM) {
    const a = latDeg * DEG, b = lonDeg * DEG;
    const r = [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
    const v = [(w[1] * r[2] - w[2] * r[1]) * rKm, (w[2] * r[0] - w[0] * r[2]) * rKm, (w[0] * r[1] - w[1] * r[0]) * rKm];
    const e = [-Math.sin(b), Math.cos(b), 0];
    const n = [-Math.sin(a) * Math.cos(b), -Math.sin(a) * Math.sin(b), Math.cos(a)];
    const east = v[0] * e[0] + v[1] * e[1] + v[2] * e[2];
    const north = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    return { east, north, speed: Math.hypot(east, north), azimuth: ((Math.atan2(east, north) / DEG) + 360) % 360 };
}
