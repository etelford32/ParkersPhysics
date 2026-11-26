/**
 * paleo/plates.js — WHICH plate a piece of the surface rides, and where it
 * was. PURE: no DOM, no fetch, no clock.
 *
 * Reads data/paleo/muller2019-plates.json (baked by
 * scripts/build-paleo-model.py from Müller et al. 2019, CC BY-SA 4.0):
 *   static      the model's present-day STATIC PLATE POLYGONS — every piece
 *               of today's surface, with its plate id and the age range it
 *               exists for (`fromAge` is when that crust appears: oceanic
 *               crust younger than an age does not exist at it);
 *   continents  the model's continental-crust outlines (NOT shorelines).
 *
 * `plateAt` is pyGPlates' own PlatePartitioner rule, reproduced: of the
 * polygons containing the point, the HIGHEST PLATE ID wins (pyGPlates'
 * default, chosen because it is deterministic; static polygons overlap in
 * places — Beloc sits in two). The gate runs it against pyGPlates on 4000
 * points (scripts/paleo_oracle.py → tests/fixtures/paleo/). Containment is a
 * ray cast in lon/lat on the SIMPLIFIED rings, so a point within the
 * simplification tolerance (~5 km) of a boundary can land on the neighbour —
 * the gate measures that share; it is not a property of the model.
 *
 * Everything this file returns about the past goes through
 * js/paleo/rotations.js (the one copy of the rotation chain).
 */

const DEG = Math.PI / 180;
const unit = (lon, lat) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];
/** Great-circle midpoint of two lon/lat points, as lon/lat (null if antipodal/coincident). */
function gcMid(a, b) {
    const u = unit(a[0], a[1]), v = unit(b[0], b[1]), m = [u[0] + v[0], u[1] + v[1], u[2] + v[2]], n = Math.hypot(...m);
    if (n < 1e-12) return null;
    return [Math.atan2(m[1], m[0]) / DEG, Math.asin(Math.max(-1, Math.min(1, m[2] / n))) / DEG];
}
/**
 * A polygon edge IS a great-circle arc (that is how GPlates, and so the
 * model, defines it); a lon/lat ray cast and a lon/lat triangulation treat it
 * as a straight line in lon/lat. The two agree on meridians and the equator
 * and part near the poles — by 1.5° at 88.7°S on Merdith 2021's Antarctic
 * polygons, which put a point pyGPlates places on plate 8021 in a gap. Each
 * edge whose great-circle midpoint leaves the lon/lat chord by more than
 * `tolDeg` is split there, recursively; an edge touching a pole is left alone
 * (its lon/lat run along the pole closes a cut polygon and has no arc).
 */
export function densifyGreatCircle(ring, tolDeg = GC_TOL_DEG) {
    ring = expandPoles(ring);
    const out = [ring[0]];
    const add = (a, b, depth) => {
        if (Math.abs(a[1]) > 89.999 || Math.abs(b[1]) > 89.999 || Math.abs(a[0] - b[0]) < 1e-9) { out.push(b); return; }
        const m = gcMid(a, b);
        if (!m || depth > 10) { out.push(b); return; }
        const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const dev = Math.hypot((m[0] - c[0]) * Math.cos(c[1] * DEG), m[1] - c[1]);
        if (dev <= tolDeg || Math.abs(m[0] - c[0]) > 90) { out.push(b); return; }
        add(a, m, depth + 1); add(m, b, depth + 1);
    };
    for (let i = 1; i < ring.length; i++) add(ring[i - 1], ring[i], 0);
    return out;
}
export const GC_TOL_DEG = 0.01;

/**
 * A ring that passes THROUGH a pole as one vertex (Merdith 2021's East
 * Antarctica: …(180, −86.7) → (0, −90) → (−180, −86.0)…) encloses the polar
 * cap on the sphere but only a V-shaped wedge in lon/lat. In lon/lat the pole
 * is a LINE, so the vertex becomes a run along it: (lon_prev, ±90) →
 * (lon_next, ±90). A ring already written that way is unchanged.
 */
export function expandPoles(ring) {
    const n = ring.length, closed = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
    const out = [];
    for (let i = 0; i < n; i++) {
        const v = ring[i];
        if (Math.abs(v[1]) < 89.999) { out.push(v); continue; }
        const prev = ring[i > 0 ? i - 1 : (closed ? n - 2 : n - 1)], next = ring[i < n - 1 ? i + 1 : (closed ? 1 : 0)];
        const lat = v[1] > 0 ? 90 : -90;
        if (Math.abs(prev[1]) < 89.999 && Math.abs(next[1]) < 89.999 && prev[0] !== next[0]) out.push([prev[0], lat], [next[0], lat]);
        else out.push(v);
    }
    if (closed && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
    return out;
}

/**
 * Decode the baked polygons into { plate, fromAge, toAge, name, rings: [[lon, lat]], bbox },
 * with every edge densified onto its great circle (`densifyGreatCircle`).
 */
export function decodePlates(baked, { greatCircle = true } = {}) {
    const one = (block) => block.polygons.map(([plate, fromAge, toAge, ni, rings]) => {
        const rs = rings.map((d) => {
            const out = [];
            let x = 0, y = 0;
            for (let i = 0; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; out.push([x / 1000, y / 1000]); }
            return greatCircle ? densifyGreatCircle(out) : out;
        });
        let a = 180, b = 90, c = -180, e = -90;
        for (const r of rs) for (const [x, y] of r) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > e) e = y; }
        return { plate, fromAge, toAge: toAge < 0 ? 0 : toAge, name: block.names[ni], rings: rs, bbox: [a, b, c, e] };
    });
    return { static: one(baked.static), continents: one(baked.continents), meta: baked.meta };
}

/** Even-odd ray cast on a lon/lat ring. */
export function inRing(lon, lat, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j], [x2, y2] = ring[i];
        if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
}

export function inPolygon(lon, lat, poly) {
    const [a, b, c, e] = poly.bbox;
    if (lon < a || lon > c || lat < b || lat > e) return false;
    let n = 0;
    for (const r of poly.rings) if (inRing(lon, lat, r)) n++;
    return n % 2 === 1;
}

/** Does this piece of crust exist at `age` (Ma)? */
export const existsAt = (poly, age) => age <= poly.fromAge + 1e-9 && age >= poly.toAge - 1e-9;

/**
 * The plate under a present-day point: every static polygon containing it,
 * highest plate id first (pyGPlates' default order); null in a gap.
 */
export function plateAt(plates, latDeg, lonDeg) {
    const hits = plates.static.filter((p) => inPolygon(lonDeg, latDeg, p));
    if (!hits.length) return null;
    hits.sort((p, q) => q.plate - p.plate);
    const h = hits[0];
    return { plate: h.plate, name: h.name, fromAge: h.fromAge, toAge: h.toAge, overlaps: hits.length - 1, polygon: h, hits };
}

/** Is a present-day point continental crust (inside a continental polygon)? */
export const isContinental = (plates, latDeg, lonDeg) => plates.continents.some((p) => inPolygon(lonDeg, latDeg, p));

/**
 * Where a present-day point on `plate` was at each of `ages`. An age the
 * point's crust did not yet exist at (`fromAge`), or the model does not cover
 * for the plate, is null — never extrapolated.
 */
export function trackOf(model, latDeg, lonDeg, plate, fromAge, ages) {
    return ages.map((age) => {
        if (age > fromAge + 1e-9) return null;
        const p = model.reconstruct(latDeg, lonDeg, plate, age);
        return p ? { age, lat: p.lat, lon: p.lon } : null;
    });
}
