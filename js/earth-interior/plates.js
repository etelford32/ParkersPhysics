/**
 * plates.js — tectonic plates and how they move: Bird's PB2002 model (PURE).
 * ═══════════════════════════════════════════════════════════════════════════
 * Data: Bird, P. (2003), An updated digital model of plate boundaries, G³ 4(3)
 * 1027 — 52 plates, 229 boundary segments, 5,819 digitisation steps, and an
 * Euler pole for every plate RELATIVE TO THE PACIFIC (PA ≡ 0). Baked by
 * scripts/build-plates.mjs (pinned copy, see data/earth-interior/SOURCES.md).
 *
 * What this module computes, and what each number is:
 *   • A plate's velocity at a point is RIGID ROTATION: v = ω × r, with ω the
 *     Euler vector (deg/Ma CCW about the pole). That is the whole model; there
 *     is no deformation inside a plate (orogens are where that fails, and Bird
 *     flags them).
 *   • The relative velocity across a boundary step is v_left − v_right at the
 *     step's midpoint, split into the DIVERGENT component (opening, negative =
 *     convergence) and the RIGHT-LATERAL component, against the step's own
 *     azimuth. tests/earth-interior-plates.mjs reproduces Bird's published
 *     numbers for all 5,819 steps from the poles alone.
 *   • NO-NET-ROTATION frame: Bird's poles are relative to the Pacific, which
 *     is a choice of frame, not physics. The NNR frame is the one in which
 *         Σ_plates ∫ r × v dA = 0,
 *     i.e. Ω = (3 / 8π) Σ_p M_p ω_p with M_p = ∫_p (I − r̂ r̂ᵀ) dA (unit
 *     sphere) — the AREA-WEIGHTED mean rotation (solved with the raster's own
 *     Σ M_p in place of (8π/3) I, so the residual is zero on the raster). We integrate M_p over the
 *     baked plate raster; the gate compares the result with the published
 *     NNR-NUVEL-1A Pacific pole (the plate geometry differs, so to a tolerance).
 *     "Absolute" motion relative to the deep mantle (hotspot frames) is a
 *     DIFFERENT, model-dependent frame; this page does not claim it.
 */

export const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;

/** Unit vector of (lat, lon) in degrees, Earth-fixed ECEF (x → 0°E, z → north). */
export function unit(latDeg, lonDeg) {
    const a = latDeg * DEG, b = lonDeg * DEG;
    return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/** Euler vector (rad/Ma) from a pole { lat, lon, rateDegMa }. */
export function eulerVector(p) {
    const u = unit(p.lat, p.lon), w = p.rateDegMa * DEG;
    return [u[0] * w, u[1] * w, u[2] * w];
}
/** The pole { lat, lon, rateDegMa } of an Euler vector (rad/Ma). */
export function poleOf(w) {
    const r = norm(w);
    if (r === 0) return { lat: 0, lon: 0, rateDegMa: 0 };
    return { lat: Math.asin(w[2] / r) / DEG, lon: Math.atan2(w[1], w[0]) / DEG, rateDegMa: r / DEG };
}

/** Local east / north unit vectors at (lat, lon). */
function enu(latDeg, lonDeg) {
    const a = latDeg * DEG, b = lonDeg * DEG;
    return { e: [-Math.sin(b), Math.cos(b), 0], n: [-Math.sin(a) * Math.cos(b), -Math.sin(a) * Math.sin(b), Math.cos(a)] };
}

/**
 * Velocity of a rigid plate with Euler vector w (rad/Ma) at (lat, lon):
 * { east, north, speed } in mm/yr (1 km/Ma = 1 mm/yr), azimuth deg clockwise from north.
 */
export function plateVelocity(w, latDeg, lonDeg, rKm = R_EARTH_KM) {
    const r = unit(latDeg, lonDeg);
    const v = cross(w, r).map((x) => x * rKm);
    const { e, n } = enu(latDeg, lonDeg);
    const east = dot(v, e), north = dot(v, n);
    return { east, north, speed: Math.hypot(east, north), azimuth: ((Math.atan2(east, north) / DEG) + 360) % 360 };
}

/** Great-circle midpoint and initial azimuth (deg) of the step a → b. */
export function stepGeometry(lat1, lon1, lat2, lon2) {
    const a = unit(lat1, lon1), b = unit(lat2, lon2);
    const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const k = norm(m);
    const mid = { lat: Math.asin(m[2] / k) / DEG, lon: Math.atan2(m[1], m[0]) / DEG };
    // Azimuth of the step AT its midpoint: the tangent of the great circle a→b there.
    const t = cross(cross(a, b), m.map((x) => x / k));        // (a×b)×m̂ points along the arc
    const { e, n } = enu(mid.lat, mid.lon);
    const azimuth = ((Math.atan2(dot(t, e), dot(t, n)) / DEG) + 360) % 360;
    const lengthKm = Math.atan2(norm(cross(a, b)), dot(a, b)) * R_EARTH_KM;
    return { mid, azimuth, lengthKm };
}

/**
 * Relative motion across a boundary step: the LEFT plate relative to the RIGHT
 * (left/right as one travels a → b looking down from outside — Bird's convention).
 * Returns mm/yr: speed, azimuth, divergent (opening > 0), rightLateral.
 */
export function relativeMotion(wLeft, wRight, lat1, lon1, lat2, lon2) {
    const g = stepGeometry(lat1, lon1, lat2, lon2);
    const v = plateVelocity(sub(wLeft, wRight), g.mid.lat, g.mid.lon);
    const s = g.azimuth * DEG;
    // Unit vectors along the step and toward the LEFT side (azimuth − 90°), in (east, north).
    const along = [Math.sin(s), Math.cos(s)], left = [-Math.cos(s), Math.sin(s)];
    const divergent = v.east * left[0] + v.north * left[1];
    // Stand on the right plate facing the left one (facing azimuth − 90°): the step direction
    // is on your right hand, so the left plate moving FORWARD along the step slides to your
    // right — right-lateral is the component ALONG the step. (Bird's sign; the gate fails on
    // the opposite one, which is what this line first said.)
    const rightLateral = v.east * along[0] + v.north * along[1];
    return { ...g, speed: v.speed, velAzimuth: v.azimuth, divergent, rightLateral };
}

// ── Plate membership ────────────────────────────────────────────────────────

/**
 * Winding angle of a closed spherical polygon (vertices [lat, lon]) about the
 * point p: ±2π inside, ~0 outside. Each edge contributes the signed angle at p
 * between the two vertices' tangent-plane projections — exact for great-circle
 * edges, independent of longitude wrap, valid for polygons around a pole.
 */
export function windingAngle(polyXYZ, p) {
    let sum = 0;
    for (let i = 0; i < polyXYZ.length - 1; i++) {
        const a = polyXYZ[i], b = polyXYZ[i + 1];
        sum += Math.atan2(dot(p, cross(a, b)), dot(a, b) - dot(a, p) * dot(b, p));
    }
    return sum;
}

/** Exact spherical area (unit sphere, steradians) of a closed CCW polygon of unit vectors. */
export function polygonArea(polyXYZ) {
    // Sum of signed triangle excesses (Van Oosterom & Strackee) about the first vertex's antipode-free origin.
    const o = polyXYZ[0];
    let s = 0;
    for (let i = 1; i < polyXYZ.length - 2; i++) {
        const a = polyXYZ[i], b = polyXYZ[i + 1];
        s += 2 * Math.atan2(dot(o, cross(a, b)), 1 + dot(o, a) + dot(a, b) + dot(b, o));
    }
    return s < 0 ? s + 4 * Math.PI : s;
}

/** The raster cell (lat-major from +90, lon from −180) at a point. */
export function rasterIndex(raster, latDeg, lonDeg) {
    const { stepDeg, nLat, nLon } = raster;
    const i = Math.min(nLat - 1, Math.max(0, Math.floor((90 - latDeg) / stepDeg)));
    let lon = ((lonDeg + 180) % 360 + 360) % 360;
    const j = Math.min(nLon - 1, Math.floor(lon / stepDeg));
    return i * nLon + j;
}
/** Plate index at a point, or −1. */
export function plateAt(raster, latDeg, lonDeg) {
    return raster.cells[rasterIndex(raster, latDeg, lonDeg)];
}

/** Steradians and M = ∫(I − r̂r̂ᵀ)dA per plate, by raster quadrature (cell-centre rule, exact cell areas). */
export function plateMoments(raster, nPlates) {
    const { stepDeg, nLat, nLon, cells } = raster;
    const area = new Float64Array(nPlates), M = Array.from({ length: nPlates }, () => new Float64Array(9));
    const dl = stepDeg * DEG;
    for (let i = 0; i < nLat; i++) {
        const lat1 = (90 - i * stepDeg) * DEG, lat0 = lat1 - dl;
        const cellA = dl * (Math.sin(lat1) - Math.sin(lat0));
        const lat = (lat0 + lat1) / 2;
        for (let j = 0; j < nLon; j++) {
            const p = cells[i * nLon + j];
            if (p < 0) continue;
            const lon = (-180 + (j + 0.5) * stepDeg) * DEG;
            const r = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
            area[p] += cellA;
            const m = M[p];
            for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[3 * a + b] += cellA * ((a === b ? 1 : 0) - r[a] * r[b]);
        }
    }
    return { area, M };
}

/**
 * The no-net-rotation correction Ω (rad/Ma) for Euler vectors ws on a raster:
 * ω_NNR = ω − Ω. Solves (Σ_p M_p) Ω = Σ_p M_p ω_p with the raster's OWN total
 * moment (analytically (8π/3) I; the cell-centre rule misses that by ~1e-5),
 * so the NNR field has zero net rotation ON THE RASTER to rounding.
 */
export function nnrRotation(ws, moments) {
    const L = [0, 0, 0], T = new Float64Array(9);
    ws.forEach((w, p) => {
        const m = moments.M[p];
        for (let a = 0; a < 3; a++) L[a] += m[3 * a] * w[0] + m[3 * a + 1] * w[1] + m[3 * a + 2] * w[2];
        for (let k = 0; k < 9; k++) T[k] += m[k];
    });
    return solve3(T, L);
}

function solve3(A, b) {
    const [a, b1, c, d, e, f, g, h, i] = A;
    const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
    const inv = [e * i - f * h, c * h - b1 * i, b1 * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b1 * g - a * h, a * e - b1 * d];
    return [0, 1, 2].map((r) => (inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) / det);
}

// ── The baked model ─────────────────────────────────────────────────────────

export const STEP_CLASSES = {
    OSR: 'oceanic spreading ridge', OTF: 'oceanic transform fault', OCB: 'oceanic convergent boundary',
    SUB: 'subduction zone', CRB: 'continental rift', CTF: 'continental transform fault', CCB: 'continental convergent boundary',
};

/** Decode the bake (scripts/build-plates.mjs) and derive both frames. */
export function decodePlates(baked) {
    const plates = baked.plates.map((p, i) => ({ ...p, index: i, w: eulerVector(p) }));
    const byId = new Map(plates.map((p) => [p.id, p]));
    const raster = { ...baked.raster, cells: Int8Array.from(baked.raster.cells) };
    const moments = plateMoments(raster, plates.length);
    const omega = nnrRotation(plates.map((p) => p.w), moments);
    for (const p of plates) {
        p.wNnr = sub(p.w, omega);
        p.areaKm2 = moments.area[p.index] * R_EARTH_KM ** 2;
        p.nnrPole = poleOf(p.wNnr);
    }
    const S = baked.steps, q = S.scale;
    const steps = [];
    for (let k = 0; k < S.left.length; k++) {
        steps.push({
            lon1: S.lon1[k] * q, lat1: S.lat1[k] * q, lon2: S.lon2[k] * q, lat2: S.lat2[k] * q,
            left: plates[S.left[k]], right: plates[S.right[k]], polarity: S.polarity[k],
            cls: S.classes[S.cls[k]], elevationM: S.elev[k], ageMa: S.age[k] > 180 ? null : S.age[k],
            orogen: S.orogen[k] === 1,
        });
    }
    return { plates, byId, raster, steps, nnrOmega: omega, source: baked.source };
}

/** A plate's velocity in the chosen frame ('nnr' | 'pacific'). */
export function velocityIn(plate, latDeg, lonDeg, frame = 'nnr') {
    return plateVelocity(frame === 'pacific' ? plate.w : plate.wNnr, latDeg, lonDeg);
}

/** Every step's motion from the poles (the frame cancels in a relative velocity). */
export function stepMotions(model) {
    return model.steps.map((s) => ({ step: s, ...relativeMotion(s.left.w, s.right.w, s.lat1, s.lon1, s.lat2, s.lon2) }));
}

/**
 * Which plate goes down at a subduction step: Bird's title symbol — "/" the
 * RIGHT plate subducts under the left, "\\" the left under the right.
 */
export function subductingPlate(step) {
    if (step.polarity === '/') return step.right;
    if (step.polarity === '\\') return step.left;
    return null;
}

/** Totals by class: length km and length-weighted mean rates (spreading = divergent, subduction = convergent). */
export function boundarySummary(motions) {
    const out = {};
    for (const m of motions) {
        const c = m.step.cls;
        const o = (out[c] ??= { lengthKm: 0, rateLen: 0, n: 0 });
        o.lengthKm += m.lengthKm; o.n++;
        o.rateLen += m.lengthKm * Math.abs(c === 'OSR' || c === 'CRB' ? m.divergent : (c === 'SUB' || c === 'OCB' || c === 'CCB') ? m.divergent : m.rightLateral);
    }
    for (const c of Object.keys(out)) out[c].meanRate = out[c].rateLen / out[c].lengthKm;
    return out;
}
