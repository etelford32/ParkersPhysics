/**
 * paleo/rotations.js — where a piece of the Earth's surface was, at any age
 * a plate model covers. PURE: no DOM, no fetch, no clock.
 *
 * The model is a GPlates rotation file (data/paleo/muller2019-rotations.json,
 * baked by scripts/build-paleo-model.py from Müller et al. 2019 v2.0,
 * CC BY-SA 4.0). Each row is a TOTAL RECONSTRUCTION POLE: the finite rotation
 * that carries a MOVING plate from its present position to its position at
 * `age`, relative to a FIXED plate. A plate's position relative to the
 * ANCHOR (plate 0 here: the model's optimised mantle frame) is the chain
 *     R(P, t) = R(fixed, t) · R(P → fixed, t),     R(0, t) = I.
 * Between two rows of one sequence the rotation is SPHERICAL-LINEAR
 * interpolation of the two quaternions (GPlates' rule), with the second
 * quaternion flipped into the first one's hemisphere so the path is the
 * short one (q and −q are the same rotation; a sign flip between rows
 * would otherwise send slerp the long way round).
 *
 * What a reconstructed latitude IS: a position in the model's MANTLE frame
 * (optimised on trench migration, net rotation and hotspot tracks — the
 * archive's README). It is NOT a palaeomagnetic latitude: true polar wander
 * (a few degrees since 66 Ma) is not in it. Consumers that need the spin
 * axis — an impactor's trajectory — must say so.
 *
 * Refusals, never extrapolations: an age past a plate's oldest row, a plate
 * the file does not contain, or a chain that loops returns null.
 *
 * The one copy: every page that moves geography through time (the Chicxulub
 * reconstruction now, a deep-time Earth view later) goes through this file.
 */

const DEG = Math.PI / 180;

// ── quaternions [w, x, y, z] ────────────────────────────────────────────────
export function quatFromPole(latDeg, lonDeg, angleDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG, h = angleDeg * DEG / 2, s = Math.sin(h);
    return [Math.cos(h), s * Math.cos(la) * Math.cos(lo), s * Math.cos(la) * Math.sin(lo), s * Math.sin(la)];
}
export function quatMul(a, b) {
    return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
}
export const quatConj = (q) => [q[0], -q[1], -q[2], -q[3]];
export const IDENTITY = Object.freeze([1, 0, 0, 0]);

export function slerp(a, b, f) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let c = b;
    if (d < 0) { c = b.map((v) => -v); d = -d; }
    if (d > 0.9999999) {                          // nearly equal: linear, then normalise
        const r = a.map((v, i) => v + (c[i] - v) * f), n = Math.hypot(...r);
        return r.map((v) => v / n);
    }
    const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - f) * th) / s, wb = Math.sin(f * th) / s;
    return a.map((v, i) => wa * v + wb * c[i]);
}

/** Rotate a unit vector by q. */
export function rotate(q, v) {
    const p = quatMul(quatMul(q, [0, v[0], v[1], v[2]]), quatConj(q));
    return [p[1], p[2], p[3]];
}
export function unitVector(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}
export function latLonOf(v) {
    return { lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG, lon: Math.atan2(v[1], v[0]) / DEG };
}
/** Pole and angle of a quaternion (angle in [0, 180]). */
export function poleOfQuat(q) {
    const s = q[0] < 0 ? -1 : 1, w = Math.min(1, s * q[0]), v = [s * q[1], s * q[2], s * q[3]];
    const angle = 2 * Math.acos(w) / DEG, n = Math.hypot(...v);
    if (n < 1e-15) return { lat: 90, lon: 0, angle: 0 };
    return { ...latLonOf(v.map((x) => x / n)), angle };
}
/** Central angle (deg) between two points. */
export function angularDistance(lat1, lon1, lat2, lon2) {
    const a = unitVector(lat1, lon1), b = unitVector(lat2, lon2);
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return Math.atan2(Math.hypot(...c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / DEG;
}

// ── the model ───────────────────────────────────────────────────────────────
/**
 * Build a model from the baked JSON ({ sequences: [[moving, fixed, rows]] }).
 * Sequences of one moving plate are kept in FILE ORDER; where two cover the
 * same age (a crossover), the first wins — the gate measures how far the
 * second disagrees at every crossover.
 */
export function createModel(baked) {
    const byPlate = new Map();
    for (const [moving, fixed, rows] of baked.sequences) {
        const r = rows.map(([age, lat, lon, ang]) => ({ age, q: quatFromPole(lat, lon, ang), lat, lon, ang }));
        if (!byPlate.has(moving)) byPlate.set(moving, []);
        byPlate.get(moving).push({ moving, fixed, rows: r, from: r[0].age, to: r[r.length - 1].age });
    }
    const cache = new Map();

    /** The rotation of `moving` relative to its fixed plate at `age`, or null. */
    function relative(moving, age) {
        const list = byPlate.get(moving);
        if (!list) return null;
        for (const s of list) {
            if (age < s.from - 1e-9 || age > s.to + 1e-9) continue;
            const R = s.rows;
            for (let i = 0; i < R.length - 1; i++) {
                const a = R[i], b = R[i + 1];
                if (age >= a.age - 1e-9 && age <= b.age + 1e-9) {
                    const span = b.age - a.age;
                    const f = span > 0 ? Math.min(1, Math.max(0, (age - a.age) / span)) : 0;
                    return { fixed: s.fixed, q: f === 0 ? a.q : f === 1 ? b.q : slerp(a.q, b.q, f), sequence: s };
                }
            }
            if (R.length === 1 && Math.abs(age - R[0].age) < 1e-9) return { fixed: s.fixed, q: R[0].q, sequence: s };
        }
        return null;
    }

    /** Total rotation of `plate` relative to plate `anchor` (default 0) at `age`. */
    function total(plate, age, anchor = 0) {
        const key = plate + '@' + age + '>' + anchor;
        if (cache.has(key)) return cache.get(key);
        let q = IDENTITY, p = plate, chain = [];
        for (let hop = 0; p !== 0 && hop < 64; hop++) {
            const r = relative(p, age);
            if (!r) { cache.set(key, null); return null; }
            chain.push(p);
            q = quatMul(r.q, q);
            p = r.fixed;
        }
        if (p !== 0) { cache.set(key, null); return null; }          // looped
        let out = q;
        if (anchor !== 0) {
            const qa = total(anchor, age, 0);
            if (!qa) { cache.set(key, null); return null; }
            out = quatMul(quatConj(qa.q), q);
        }
        const res = { q: out, chain: chain.concat(0) };
        cache.set(key, res);
        return res;
    }

    /** Where a point that is at (lat, lon) TODAY on `plate` was at `age`. */
    function reconstruct(latDeg, lonDeg, plate, age, anchor = 0) {
        const t = total(plate, age, anchor);
        if (!t) return null;
        return latLonOf(rotate(t.q, unitVector(latDeg, lonDeg)));
    }

    /**
     * Mean relative angular velocity of `a` with respect to `b` over the
     * last `spanMa` (rad/Ma, FORWARD in time: the present-day sense, the
     * convention Bird's PB2002 poles use). The reconstruction rotation carries
     * today's position back; motion forward is its inverse, divided by time.
     */
    function meanVelocity(a, b, spanMa) {
        const t = total(a, spanMa, b);
        if (!t) return null;
        const inv = quatConj(t.q), s = inv[0] < 0 ? -1 : 1;
        const w = Math.min(1, s * inv[0]), ang = 2 * Math.acos(w), n = Math.hypot(inv[1], inv[2], inv[3]);
        if (n < 1e-15) return [0, 0, 0];
        return [s * inv[1] / n * ang / spanMa, s * inv[2] / n * ang / spanMa, s * inv[3] / n * ang / spanMa];
    }

    /** Every crossover: the angle (deg) between the two sequences' answers at the switch age. */
    function crossovers() {
        const out = [];
        for (const [plate, list] of byPlate) {
            for (let i = 0; i < list.length - 1; i++) {
                const A = list[i], B = list[i + 1], age = A.to;
                if (Math.abs(B.from - age) > 1e-9) continue;
                const qa = total(A.fixed, age), qb = total(B.fixed, age);
                if (!qa || !qb) continue;
                const ta = quatMul(qa.q, A.rows[A.rows.length - 1].q), tb = quatMul(qb.q, B.rows[0].q);
                const d = Math.abs(ta[0] * tb[0] + ta[1] * tb[1] + ta[2] * tb[2] + ta[3] * tb[3]);
                out.push({ plate, age, fixedBefore: A.fixed, fixedAfter: B.fixed, jumpDeg: 2 * Math.acos(Math.min(1, d)) / DEG });
            }
        }
        return out;
    }

    const plates = () => [...byPlate.keys()];
    const oldest = (plate) => { const l = byPlate.get(plate); return l ? Math.max(...l.map((s) => s.to)) : null; };
    return { relative, total, reconstruct, meanVelocity, crossovers, plates, oldest, meta: baked.meta };
}

/**
 * A bearing measured TODAY at a point, carried to `age`: the azimuth (deg
 * clockwise from north) of the same direction on the rotated plate. Taken by
 * rotating a point a short way along the bearing and measuring the angle at
 * the reconstructed site, so it needs no tangent-frame algebra of its own.
 */
export function reconstructBearing(model, latDeg, lonDeg, bearingDeg, plate, age, stepDeg = 0.05) {
    const p0 = model.reconstruct(latDeg, lonDeg, plate, age);
    if (!p0) return null;
    const la = latDeg * DEG, lo = lonDeg * DEG, d = stepDeg * DEG, b = bearingDeg * DEG;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    const p1 = model.reconstruct(la2 / DEG, lo2 / DEG, plate, age);
    const A = p0.lat * DEG, B = p1.lat * DEG, dl = (p1.lon - p0.lon) * DEG;
    const az = Math.atan2(Math.sin(dl) * Math.cos(B), Math.cos(A) * Math.sin(B) - Math.sin(A) * Math.cos(B) * Math.cos(dl)) / DEG;
    return ((az % 360) + 360) % 360;
}
