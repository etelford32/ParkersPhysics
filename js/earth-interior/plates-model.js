/**
 * plates-model.js — what the stage's PLATES view draws (PURE: no DOM, no
 * three.js). Every kinematic number is plates.js (Bird's PB2002 Euler poles);
 * the seafloor ages and depths along the boundaries are Bird's tabulated
 * Müller et al. (1997) and ETOPO5 values, drawn as observations.
 *
 *   • BOUNDARY STYLE by Bird's step class, three families a reader can name:
 *     spreading (OSR, CRB), sliding (OTF, CTF), closing (SUB, OCB, CCB) —
 *     subduction gets its own colour because it is where seafloor goes back
 *     into the mantle.
 *   • ARROWS: the plate's own velocity at points of a Fibonacci (near
 *     equal-area) lattice, in the chosen frame. Length is a DISPLAY scale
 *     (ARROW_DEG_PER_MM_YR degrees of arc per mm/yr — 10 Myr of motion at
 *     1:1 would be ~10°), disclosed in the legend.
 *   • DEPTH vs AGE: Bird's oceanic transform-fault steps sample seafloor of
 *     every age along the fracture zones; their depths are compared with the
 *     plate-cooling curve of Parsons & Sclater (1977), d = 2500 + 350√t m
 *     (t ≤ 70 Ma) and 6400 − 3200 e^(−t/62.8) m beyond. A boundary is not a
 *     random sample of the seafloor (transforms sit in fracture-zone
 *     troughs), so this is a comparison, not a fit, and the panel says so.
 */
import { plateVelocity, relativeMotion, unit, subductingPlate, STEP_CLASSES } from './plates.js';

export const CLASS_FAMILY = { OSR: 'spreading', CRB: 'spreading', OTF: 'sliding', CTF: 'sliding', OCB: 'closing', CCB: 'closing', SUB: 'subduction' };
export const FAMILY_STYLE = {
    spreading: { label: 'Spreading (ridge, rift)', hex: '#f2c14e' },
    sliding: { label: 'Sliding (transform fault)', hex: '#7fd1b9' },
    closing: { label: 'Colliding (convergent, no slab)', hex: '#e58fb0' },
    subduction: { label: 'Subduction zone', hex: '#ff5d3a' },
};
export const ARROW_DEG_PER_MM_YR = 0.12;

export function stepFamily(step) { return CLASS_FAMILY[step.cls]; }

/** ~n points of a Fibonacci lattice on the sphere (near equal-area). [{ lat, lon }] */
export function fibonacciPoints(n) {
    const out = [], ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const z = 1 - (2 * i + 1) / n, t = i * ga;
        out.push({ lat: Math.asin(z) * 180 / Math.PI, lon: ((((t * 180 / Math.PI) + 180) % 360) + 360) % 360 - 180 });
    }
    return out;
}

/** Destination (lat, lon) after travelling `distDeg` from (lat, lon) along azimuth `azDeg`. */
export function travel(lat, lon, azDeg, distDeg) {
    const D = Math.PI / 180, p = lat * D, l = lon * D, a = azDeg * D, d = distDeg * D;
    const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(a));
    const l2 = l + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
    return { lat: p2 / D, lon: ((l2 / D + 540) % 360) - 180 };
}

/**
 * Velocity arrows on a lattice: [{ lat, lon, plate, east, north, speed, azimuth, shaft: [{lat,lon}×k], head: [[{lat,lon}×3]] }].
 * frame: 'nnr' | 'pacific'. Points where the plate is (nearly) still in that frame get no arrow.
 */
export function velocityArrows(model, frame = 'nnr', { n = 700, plateAt } = {}) {
    const out = [];
    for (const p of fibonacciPoints(n)) {
        const k = plateAt(model.raster, p.lat, p.lon);
        if (k < 0) continue;
        const plate = model.plates[k];
        const v = plateVelocity(frame === 'pacific' ? plate.w : plate.wNnr, p.lat, p.lon);
        if (v.speed < 1) continue;
        const L = v.speed * ARROW_DEG_PER_MM_YR, shaft = [];
        for (let i = 0; i <= 6; i++) shaft.push(travel(p.lat, p.lon, v.azimuth, (L * i) / 6));
        const tip = shaft[6], back = Math.min(L * 0.35, 1.6);
        // The head's barbs: from the tip, back along the reverse azimuth ±28°.
        const rev = (v.azimuth + 180) % 360;
        const head = [[travel(tip.lat, tip.lon, rev - 28, back), tip, travel(tip.lat, tip.lon, rev + 28, back)]];
        out.push({ ...p, plate, ...v, shaft, head });
    }
    return out;
}

/** The step nearest to (lat, lon) (great-circle distance to its midpoint), with its motion and distance km. */
export function nearestStep(model, latDeg, lonDeg) {
    const q = unit(latDeg, lonDeg);
    let best = null, bestDot = -2;
    for (const s of model.steps) {
        const a = unit(s.lat1, s.lon1), b = unit(s.lat2, s.lon2);
        const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]], k = Math.hypot(...m);
        const d = (m[0] * q[0] + m[1] * q[1] + m[2] * q[2]) / k;
        if (d > bestDot) { bestDot = d; best = s; }
    }
    if (!best) return null;
    const motion = relativeMotion(best.left.w, best.right.w, best.lat1, best.lon1, best.lat2, best.lon2);
    return { step: best, motion, km: Math.acos(Math.min(1, bestDot)) * 6371, family: stepFamily(best), down: subductingPlate(best), className: STEP_CLASSES[best.cls] };
}

/** Plate-cooling depth (m below sea level) at seafloor age t (Ma) — Parsons & Sclater (1977). */
export function coolingDepthM(t) {
    if (!(t >= 0)) return null;
    return t <= 70 ? 2500 + 350 * Math.sqrt(t) : 6400 - 3200 * Math.exp(-t / 62.8);
}

/**
 * Depth vs age along Bird's OCEANIC TRANSFORM steps: binned medians (bins in √t) + the cooling curve.
 * Returns { points: [{ age, depth }], bins: [{ age, depth, n }], curve: [{ age, depth }] }.
 */
export function depthAge(model, cls = 'OTF') {
    const pts = model.steps.filter((s) => s.cls === cls && s.ageMa != null && s.elevationM < 0).map((s) => ({ age: s.ageMa, depth: -s.elevationM }));
    const groups = new Map();
    for (const p of pts) { const k = Math.floor(Math.sqrt(p.age) * 2) / 2; (groups.get(k) ?? groups.set(k, []).get(k)).push(p); }
    const bins = [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([, g]) => g.length >= 5).map(([, g]) => {
        const d = g.map((p) => p.depth).sort((x, y) => x - y), a = g.map((p) => p.age).sort((x, y) => x - y);
        return { age: a[a.length >> 1], depth: d[d.length >> 1], n: g.length };
    });
    const curve = [];
    for (let t = 0; t <= 180; t += 2) curve.push({ age: t, depth: coolingDepthM(t) });
    return { points: pts, bins, curve };
}

/** Area-weighted centroid direction of each plate on the raster (label anchors): [{ lat, lon }] by plate index. */
export function plateCentroids(model) {
    const { stepDeg, nLat, nLon, cells } = model.raster, acc = model.plates.map(() => [0, 0, 0]);
    for (let i = 0; i < nLat; i++) {
        const lat = 90 - (i + 0.5) * stepDeg, w = Math.cos(lat * Math.PI / 180);
        for (let j = 0; j < nLon; j++) {
            const k = cells[i * nLon + j]; if (k < 0) continue;
            const u = unit(lat, -180 + (j + 0.5) * stepDeg);
            acc[k][0] += w * u[0]; acc[k][1] += w * u[1]; acc[k][2] += w * u[2];
        }
    }
    return acc.map((v) => { const r = Math.hypot(...v) || 1; return { lat: Math.asin(v[2] / r) * 180 / Math.PI, lon: Math.atan2(v[1], v[0]) * 180 / Math.PI }; });
}

/** A muted, distinct tint per plate (golden-angle hue), sRGB bytes. Identity only — never a quantity. */
export function plateTint(index) {
    const h = (index * 137.508) % 360, s = 0.42, l = 0.52;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

/** The plate raster as RGBA (row 0 = north), alpha `a`. */
export function plateRGBA(model, a = 120) {
    const { nLat, nLon, cells } = model.raster, out = new Uint8Array(4 * nLat * nLon);
    const tints = model.plates.map((_, i) => plateTint(i));
    for (let k = 0; k < cells.length; k++) { const c = tints[cells[k]]; if (c) out.set([c[0], c[1], c[2], a], 4 * k); }
    return out;
}
