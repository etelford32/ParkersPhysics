/**
 * paleo-oracle.mjs — ONE measurement of the plate kernel against a pyGPlates
 * oracle (scripts/paleo_oracle.py → tests/fixtures/paleo/*.json), shared by
 * tests/paleo-rotations.mjs (which gates it) and tests/deep-time-earth.mjs
 * (which checks the numbers the page prints are these).
 *
 * Rotations are split at CROSSOVERS — a hop where two sequences of one plate
 * both cover the age. Away from them the kernel must agree to rounding. At
 * them pyGPlates' tie rule is not reproduced (file order, "the sequence that
 * starts there", fixed-plate id and a breadth-first tree were each tried and
 * each mismatched somewhere), so what is measured is whether pyGPlates'
 * answer is one of the chains the FILE allows there, and how far apart.
 */
import * as PR from '../../js/paleo/rotations.js';
import * as PL from '../../js/paleo/plates.js';

export const qAngle = (a, b) => { const d = PR.quatMul(PR.quatConj(a), b); return 2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0])) * 180 / Math.PI; };

/** Every chain the file allows: one candidate per hop, all combinations. */
export function allChains(model, plate, age, depth = 0) {
    if (plate === 0) return [PR.IDENTITY];
    if (depth > 64) return [];
    const out = [];
    for (const c of model.candidates(plate, age)) for (const up of allChains(model, c.fixed, age, depth + 1)) out.push(PR.quatMul(up, c.q));
    return out;
}

/** Planar distance (deg, lon scaled by cos lat) from a point to the nearest edge of `polys`. */
export function edgeDeg(lat, lon, polys) {
    let best = 1e9; const k = Math.cos(lat * Math.PI / 180);
    for (const p of polys) for (const r of p.rings) for (let i = 1; i < r.length; i++) {
        const ax = (r[i - 1][0] - lon) * k, ay = r[i - 1][1] - lat, dx = (r[i][0] - r[i - 1][0]) * k, dy = r[i][1] - r[i - 1][1], L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
}

export function measureAgainstOracle(model, plates, O) {
    const m = { off: 0, offDeg: 0, at: 0, atDeg: 0, atAllowed: 0, refusedBoth: 0, onlyUs: 0, onlyThem: 0,
        points: O.partition.length, agree: 0, sameAge: 0, missFar: 0, ageFar: 0 };
    const tol = 2 * plates.meta.toleranceDeg;
    for (const [plate, age, r] of O.rotations) {
        const t = model.total(plate, age);
        if (!r && !t) { m.refusedBoth++; continue; }
        if (!r) { m.onlyUs++; continue; }
        if (!t) { m.onlyThem++; continue; }
        const q = PR.quatFromPole(r[0], r[1], r[2]), a = qAngle(t.q, q);
        if (t.chain.slice(0, -1).some((x) => model.candidates(x, age).length > 1)) {
            m.at++; m.atDeg = Math.max(m.atDeg, a);
            if (Math.min(...allChains(model, plate, age).map((c) => qAngle(c, q))) < 1e-9) m.atAllowed++;
        } else { m.off++; m.offDeg = Math.max(m.offDeg, a); }
    }
    for (const [lat, lon, id, from] of O.partition) {
        const h = PL.plateAt(plates, lat, lon);
        if ((h ? h.plate : null) === id) {
            m.agree++;
            if (h === null || h.fromAge === from) m.sameAge++;
            else if (edgeDeg(lat, lon, plates.static.filter((p) => p.plate === id)) > tol) m.ageFar++;
        } else if (edgeDeg(lat, lon, plates.static.filter((p) => p.plate === id || p.plate === h?.plate)) > tol) m.missFar++;
    }
    return m;
}
