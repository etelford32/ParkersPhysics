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

/** Decode the baked polygons into { plate, fromAge, toAge, name, rings: [[lon, lat]], bbox }. */
export function decodePlates(baked) {
    const one = (block) => block.polygons.map(([plate, fromAge, toAge, ni, rings]) => {
        const rs = rings.map((d) => {
            const out = [];
            let x = 0, y = 0;
            for (let i = 0; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; out.push([x / 1000, y / 1000]); }
            return out;
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
