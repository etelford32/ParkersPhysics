/**
 * slabs.js — subducting slabs from USGS Slab2 (Hayes et al. 2018). PURE: no
 * DOM, no three.js, no fetch.
 * ═══════════════════════════════════════════════════════════════════════════
 * A slab is the part of a plate that has gone back down into the mantle at a
 * subduction zone. Slab2 maps the depth of its upper SURFACE under 27 zones,
 * built from earthquakes, active-source seismics, tomography and sediment
 * thickness, with a 1σ uncertainty per node. The bake (scripts/build-slab2.mjs)
 * keeps Slab2's own node values at 0.2° and flips the sign once: here depth is
 * POSITIVE DOWN, km. Everything between nodes is bilinear interpolation of
 * Slab2 numbers, and nothing is drawn outside Slab2's clipping mask (a cell
 * with any NaN corner is not interpolated).
 *
 * What this module claims and does not:
 *   • the slab SURFACE only — Slab2's thickness grid exists but is not used,
 *     so "below the slab surface" means inside OR beneath the slab;
 *   • single-valued surfaces — four slabs overturn (dip > 90°: Izu–Bonin,
 *     Kermadec, Manila, Solomon) and Slab2 gives those parts as separate nodes,
 *     which are not baked;
 *   • a quake's RELATION to the slab is a geometric comparison of its catalogue
 *     depth with the surface depth there, within the larger of Slab2's 1σ and
 *     NEAR_KM — a proximity statement, never a focal-mechanism classification
 *     (interface thrust vs intraslab) that would need the mechanism.
 *
 * FRAME: the canonical js/geo/coords.js frame the stage draws in — x toward
 * 0°E, y north, −z toward 90°E (stage.js latLonToVec, mirrored here because
 * that one returns a THREE.Vector3; the gate pins the two together).
 */

export const R_EARTH_KM = 6371;
export const NEAR_KM = 10;
const DEG = Math.PI / 180;

/** Canonical unit vector (stage.js latLonToVec without three.js). */
export function latLonToXYZ(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG, c = Math.cos(la);
    return [c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo)];
}

export function decodeSlabs(baked) {
    const q = baked.scale;
    const slabs = baked.slabs.map((s) => ({
        code: s.code, name: s.name, lon0: s.lon0, lat0: s.lat0, step: s.step, nLon: s.nLon, nLat: s.nLat, maxDepthKm: s.maxDepthKm,
        depth: Float32Array.from(s.depth, (v) => (v == null ? NaN : v * q)),
        unc: Float32Array.from(s.unc, (v) => (v == null ? NaN : v * q)),
    }));
    return { slabs, byCode: new Map(slabs.map((s) => [s.code, s])), source: baked.source };
}

/** Fractional grid coordinates of (lat, lon) in a slab's grid (longitude modulo 360). */
function gridXY(s, latDeg, lonDeg) {
    const x = ((((lonDeg - s.lon0) % 360) + 360) % 360) / s.step;
    const y = (s.lat0 - latDeg) / s.step;
    return { x, y };
}

/** Bilinear read of field `f` ('depth' | 'unc') at (lat, lon); null outside the mask or the grid. */
export function slabValueAt(s, latDeg, lonDeg, f = 'depth') {
    const { x, y } = gridXY(s, latDeg, lonDeg);
    if (!(x >= 0 && y >= 0 && x <= s.nLon - 1 && y <= s.nLat - 1)) return null;
    const j = Math.min(s.nLon - 2, Math.floor(x)), i = Math.min(s.nLat - 2, Math.floor(y));
    const fx = x - j, fy = y - i, g = s[f], n = s.nLon;
    const a = g[i * n + j], b = g[i * n + j + 1], c = g[(i + 1) * n + j], d = g[(i + 1) * n + j + 1];
    if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) return null;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Every slab surface beneath (lat, lon), shallowest first: [{ slab, depthKm, uncKm }]. */
export function slabsBeneath(model, latDeg, lonDeg) {
    const out = [];
    for (const s of model.slabs) {
        const d = slabValueAt(s, latDeg, lonDeg);
        if (d != null) out.push({ slab: s, depthKm: d, uncKm: slabValueAt(s, latDeg, lonDeg, 'unc') });
    }
    return out.sort((a, b) => a.depthKm - b.depthKm);
}

/**
 * Where a hypocentre sits relative to the slab surface beneath it:
 * { slab, slabDepthKm, uncKm, dzKm (quake − slab, + = deeper), relation } or null outside every slab.
 * relation: 'near' (|dz| ≤ max(σ, NEAR_KM)), 'above' (upper plate / mantle wedge side), 'below'
 * (inside or beneath the slab — Slab2's thickness is not used).
 */
export function quakeSlabContext(model, quake) {
    if (!quake || !Number.isFinite(quake.lat) || !Number.isFinite(quake.depthKm)) return null;
    const under = slabsBeneath(model, quake.lat, quake.lon);
    if (!under.length) return null;
    // The surface nearest the hypocentre in depth (two only where slabs stack, e.g. the Philippines).
    const u = under.reduce((a, b) => (Math.abs(b.depthKm - quake.depthKm) < Math.abs(a.depthKm - quake.depthKm) ? b : a));
    const dz = quake.depthKm - u.depthKm, tol = Math.max(Number.isFinite(u.uncKm) ? u.uncKm : 0, NEAR_KM);
    return { slab: u.slab, slabDepthKm: u.depthKm, uncKm: u.uncKm, dzKm: dz, tolKm: tol, relation: Math.abs(dz) <= tol ? 'near' : dz < 0 ? 'above' : 'below' };
}

/**
 * The slab surface as a triangle mesh in the stage frame (Earth radius = 1):
 * { positions: Float32Array (xyz), depths: Float32Array (km per vertex), index: Uint32Array }.
 * One vertex per valid node at radius (R − depth)/R; a cell becomes two triangles only when all
 * four corners are inside the mask — no triangle ever spans an edge Slab2 did not map.
 */
export function slabMesh(s) {
    const n = s.nLon, map = new Int32Array(s.depth.length).fill(-1);
    const pos = [], dep = [], idx = [];
    for (let i = 0; i < s.nLat; i++) for (let j = 0; j < n; j++) {
        const d = s.depth[i * n + j];
        if (!Number.isFinite(d)) continue;
        const r = (R_EARTH_KM - d) / R_EARTH_KM, u = latLonToXYZ(s.lat0 - i * s.step, s.lon0 + j * s.step);
        map[i * n + j] = dep.length;
        pos.push(u[0] * r, u[1] * r, u[2] * r); dep.push(d);
    }
    for (let i = 0; i < s.nLat - 1; i++) for (let j = 0; j < n - 1; j++) {
        const a = map[i * n + j], b = map[i * n + j + 1], c = map[(i + 1) * n + j], d = map[(i + 1) * n + j + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        idx.push(a, c, b, b, c, d);
    }
    return { positions: Float32Array.from(pos), depths: Float32Array.from(dep), index: Uint32Array.from(idx) };
}

// ── Down-dip geometry and cross-sections ──────────────────────────────────

const KM_PER_DEG = R_EARTH_KM * DEG;
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Local east / north unit vectors in the stage frame. */
export function eastNorth(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG;
    return { e: [-Math.sin(lo), 0, -Math.cos(lo)], n: [-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo)] };
}

/**
 * The slab's steepest-descent direction and dip at (lat, lon), from the BAKED depth grid alone
 * (central differences one node either side, metres east scaled by cos φ): { azimuthDeg, dipDeg } or null.
 * Gated against Slab2's own dip grid (tests/fixtures/earth-interior/slab2-dips.json).
 */
export function downDip(s, latDeg, lonDeg) {
    const h = s.step;
    const dE = [slabValueAt(s, latDeg, lonDeg + h), slabValueAt(s, latDeg, lonDeg - h)];
    const dN = [slabValueAt(s, latDeg + h, lonDeg), slabValueAt(s, latDeg - h, lonDeg)];
    if (dE.some((v) => v == null) || dN.some((v) => v == null)) return null;
    const gE = (dE[0] - dE[1]) / (2 * h * KM_PER_DEG * Math.cos(latDeg * DEG)), gN = (dN[0] - dN[1]) / (2 * h * KM_PER_DEG);
    return { azimuthDeg: ((Math.atan2(gE, gN) / DEG) + 360) % 360, dipDeg: Math.atan(Math.hypot(gE, gN)) / DEG };
}

/** The point `distDeg` of arc from (lat, lon) along azimuth `azDeg`. */
function travelDeg(latDeg, lonDeg, azDeg, distDeg) {
    const p = latDeg * DEG, a = azDeg * DEG, d = distDeg * DEG;
    const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(a));
    const l2 = lonDeg * DEG + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
    return { lat: p2 / DEG, lon: ((l2 / DEG + 540) % 360) - 180 };
}

export const SECTION_ANCHOR_KM = 100;

/**
 * A trench-perpendicular cross-section through one slab, chosen from the data:
 *   1. the anchor is the node at ~SECTION_ANCHOR_KM depth nearest the middle of the slab's
 *      80–120 km band (so the cut crosses the slab where it is well mapped);
 *   2. the cut runs along the slab's own down-dip azimuth there (`downDip`);
 *   3. it starts SEAWARD of the shallowest point the slab reaches up-dip (the trench side).
 * Returns { slab, origin:{lat,lon}, azimuthDeg, dipDeg, plane:{e1,e2,n}, profile:[{sDeg, lat, lon, depthKm|null}], lengthDeg }
 * with e1 the origin, e2 the down-dip tangent there and n = e1 × e2 (the stage's wedge convention:
 * the removed quarter is n > 0 ∧ e2 > 0 — the arc side, one strike half). null when the slab
 * has no usable 80–120 km band (the Himalaya never reaches it).
 */
export function slabSection(model, code, { stepDeg = 0.05, seawardDeg = 1.2 } = {}) {
    const s = model.byCode.get(code);
    if (!s) return null;
    const band = [];
    for (let i = 0; i < s.nLat; i++) for (let j = 0; j < s.nLon; j++) {
        const d = s.depth[i * s.nLon + j];
        if (d >= 80 && d <= 120) band.push({ lat: s.lat0 - i * s.step, lon: ((s.lon0 + j * s.step + 540) % 360) - 180, d });
    }
    if (band.length < 4) return null;
    const c = band.reduce((a, p) => { const u = latLonToXYZ(p.lat, p.lon); return [a[0] + u[0], a[1] + u[1], a[2] + u[2]]; }, [0, 0, 0]);
    const k = Math.hypot(...c), mid = c.map((v) => v / k);
    let best = null, bestScore = -Infinity;
    for (const p of band) {
        if (!downDip(s, p.lat, p.lon)) continue;
        const score = dot3(latLonToXYZ(p.lat, p.lon), mid) - Math.abs(p.d - SECTION_ANCHOR_KM) * 1e-4;
        if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return null;
    const dd = downDip(s, best.lat, best.lon);
    // Walk UP-dip until the slab ends (or stops shallowing): that is the trench side.
    let top = { lat: best.lat, lon: best.lon, d: best.d }, walked = 0;
    for (let t = stepDeg; t < 15; t += stepDeg) {
        const q = travelDeg(best.lat, best.lon, (dd.azimuthDeg + 180) % 360, t), d = slabValueAt(s, q.lat, q.lon);
        if (d == null || d > top.d + 0.5) break;
        top = { ...q, d }; walked = t;
    }
    const origin = travelDeg(best.lat, best.lon, (dd.azimuthDeg + 180) % 360, walked + seawardDeg);
    // The section's azimuth AT the origin points back through the anchor (great circle origin → anchor).
    const e1 = latLonToXYZ(origin.lat, origin.lon), b = latLonToXYZ(best.lat, best.lon);
    const t2 = b.map((v, i) => v - dot3(b, e1) * e1[i]), tn = Math.hypot(...t2), e2 = t2.map((v) => v / tn);
    const n = cross3(e1, e2);
    const { e, n: north } = eastNorth(origin.lat, origin.lon);
    const azimuthDeg = ((Math.atan2(dot3(e2, e), dot3(e2, north)) / DEG) + 360) % 360;
    const profile = [];
    let lastValid = 0;
    for (let sDeg = 0; sDeg <= 25; sDeg += stepDeg) {
        const a = sDeg * DEG, p = [0, 1, 2].map((i) => Math.cos(a) * e1[i] + Math.sin(a) * e2[i]);
        const lat = Math.asin(Math.max(-1, Math.min(1, p[1]))) / DEG, lon = Math.atan2(-p[2], p[0]) / DEG;
        const depthKm = slabValueAt(s, lat, lon);
        profile.push({ sDeg, lat, lon, depthKm });
        if (depthKm != null) lastValid = sDeg;
        else if (lastValid > 0 && sDeg > lastValid + 2) break;
    }
    return { slab: s, origin, anchor: { lat: best.lat, lon: best.lon, depthKm: best.d }, azimuthDeg, dipDeg: dd.dipDeg, plane: { e1, e2, n }, profile, lengthDeg: lastValid };
}
