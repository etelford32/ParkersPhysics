/**
 * deep-time/page-model.js — what deep-time-earth.html says, computed. PURE:
 * no DOM, no fetch, no clock. Every position goes through
 * js/paleo/rotations.js and every plate lookup through js/paleo/plates.js —
 * this file only asks them questions and formats the answers.
 *
 * The page is a renderer of these numbers (js/deep-time/globe.js draws, the
 * page module wires). Rules the renderer relies on:
 *   - the model reaches 250 Ma (AGE_MAX) and refuses past it: no position
 *     is ever extrapolated;
 *   - a point is reported only back to when its crust EXISTS (the static
 *     polygon's appearance age) — a piece of 40-million-year-old seafloor has
 *     no position at 100 Ma, because it had not formed;
 *   - positions are in the model's MANTLE frame (not palaeomagnetic) and the
 *     report says so;
 *   - the outlines are TODAY's, carried back: continents are continental-crust
 *     outlines, coastlines are today's coastlines.
 */
import * as PR from '../paleo/rotations.js';
import * as PL from '../paleo/plates.js';

export const AGE_MAX = 250;
export const R_EARTH_KM = 6371;

/**
 * Geological periods inside the model's range, from the International
 * Chronostratigraphic Chart (v2023/09), written FROM MEMORY at build time —
 * a display aid for the slider, never an input to a position.
 * The Triassic began at 251.9 Ma, just past the model's 250.
 */
export const PERIODS = Object.freeze([
    { name: 'Quaternary', from: 2.58, to: 0, color: '#c9c27a' },
    { name: 'Neogene', from: 23.03, to: 2.58, color: '#d9b34f' },
    { name: 'Paleogene', from: 66.0, to: 23.03, color: '#d98a4f' },
    { name: 'Cretaceous', from: 145.0, to: 66.0, color: '#7fb069' },
    { name: 'Jurassic', from: 201.4, to: 145.0, color: '#4fa3b5' },
    { name: 'Triassic', from: 251.9, to: 201.4, color: '#8c6bb8' },
]);
export const PERIODS_VERIFIED = false;

/** Moments the slider offers as one-click stops. Ages in Ma. */
export const STOPS = Object.freeze([
    { age: 0, label: 'Today', title: 'Today' },
    { age: 66.04, label: '66 Ma', title: 'The Chicxulub impact, 66.04 million years ago' },
    { age: 100, label: '100 Ma', title: '100 million years ago' },
    { age: 150, label: '150 Ma', title: '150 million years ago' },
    { age: 200, label: '200 Ma', title: 'About when Pangaea began to break apart' },
    { age: 250, label: '250 Ma', title: 'The model\u2019s oldest age' },
]);

/** The Chicxulub crater: today's coordinates (the evidence table's) and its age. */
export const CHICXULUB = Object.freeze({ lat: 21 + 20 / 60, lon: -(89 + 30 / 60), ageMa: 66.04 });

export const periodAt = (age) => PERIODS.find((p) => age <= p.from + 1e-9 && age >= p.to - 1e-9) || null;

export function formatAge(age) {
    if (age < 0.005) return 'Today';
    if (age < 10) return `${age.toFixed(2).replace(/0$/, '')} million years ago`;
    return `${age < 100 ? age.toFixed(1).replace(/\.0$/, '') : Math.round(age)} million years ago`;
}
export const formatLat = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;
export const formatLon = (v) => { const w = ((v + 540) % 360) - 180; return `${Math.abs(w).toFixed(1)}°${w >= 0 ? 'E' : 'W'}`; };
export const formatLatLon = (p) => `${formatLat(p.lat)} ${formatLon(p.lon)}`;

/** Climate-zone word for a latitude (a reading aid, labelled as such). */
export function latitudeBand(lat) {
    const a = Math.abs(lat);
    return a < 23.4 ? 'tropics' : a < 35 ? 'subtropics' : a < 66.6 ? 'mid-latitudes' : 'polar circle';
}

/**
 * How far back a present-day point can be followed: the earliest of the
 * model's reach (AGE_MAX), the plate's oldest rotation and the age its crust
 * appears. Returns { maxAge, limit: 'model' | 'plate' | 'crust' }.
 */
export function reachOf(model, hit) {
    const plateMax = model.oldest(hit.plate);
    let maxAge = AGE_MAX, limit = 'model';
    if (plateMax != null && plateMax < maxAge) { maxAge = plateMax; limit = 'plate'; }
    if (hit.fromAge < maxAge) { maxAge = hit.fromAge; limit = 'crust'; }
    return { maxAge, limit };
}

/**
 * Everything the panel says about a PRESENT-DAY point at `age`. Returns
 * { ok: false, reason } when there is nothing to say (no plate, crust not
 * formed yet, model's end) — never a guess.
 */
export function pointReport(model, plates, lat, lon, age) {
    const hit = PL.plateAt(plates, lat, lon);
    if (!hit) return { ok: false, reason: 'no-plate', today: { lat, lon } };
    const reach = reachOf(model, hit);
    const continental = PL.isContinental(plates, lat, lon);
    const base = { today: { lat, lon }, plate: hit.plate, plateName: hit.name, fromAge: hit.fromAge, continental, reach, overlaps: hit.overlaps };
    if (age > reach.maxAge + 1e-9) return { ...base, ok: false, reason: reach.limit === 'crust' ? 'not-formed' : 'beyond-model' };
    const then = model.reconstruct(lat, lon, hit.plate, age);
    if (!then) return { ...base, ok: false, reason: 'beyond-model' };
    const movedKm = PR.angularDistance(lat, lon, then.lat, then.lon) * Math.PI / 180 * R_EARTH_KM;
    return { ...base, ok: true, age, then, movedKm, band: latitudeBand(then.lat), bandToday: latitudeBand(lat) };
}

/**
 * The point's path from today back to its reach, every `stepMa`: the track
 * the globe draws and the latitude chart plots. Each sample { age, lat, lon }.
 */
export function trackSamples(model, plates, lat, lon, stepMa = 1) {
    const hit = PL.plateAt(plates, lat, lon);
    if (!hit) return null;
    const { maxAge } = reachOf(model, hit);
    const ages = [];
    for (let a = 0; a < maxAge - 1e-9; a += stepMa) ages.push(Math.round(a * 1e6) / 1e6);
    ages.push(maxAge);
    const pts = PL.trackOf(model, lat, lon, hit.plate, hit.fromAge, ages).filter(Boolean);
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += PR.angularDistance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) * Math.PI / 180 * R_EARTH_KM;
    return { plate: hit.plate, points: pts, pathKm: km, maxAge };
}

/**
 * Invert a click: a point on the globe at `age` (unit vector, ECEF axes)
 * that the renderer says lies on `plate` → where that piece of surface is
 * TODAY. The renderer knows which plate's triangle was hit; this undoes that
 * plate's rotation. null if the model has no rotation there.
 */
export function presentPointOf(model, plate, unitAtAge, age) {
    const t = model.total(plate, age);
    if (!t) return null;
    return PR.latLonOf(PR.rotate(PR.quatConj(t.q), unitAtAge));
}

/**
 * Seafloor colour: the age of the crust AT THE DISPLAYED AGE (its
 * appearance age minus the displayed age), on a single-hue blue ramp,
 * lighter = younger. The appearance ages are the model's ISOCHRON polygon
 * bins — the age of a strip of seafloor to within its bin, not a grid.
 * Returns [r, g, b] in 0..1 (sRGB).
 */
export const CRUST_RAMP = Object.freeze([
    [0, [0.62, 0.86, 0.96]],
    [20, [0.36, 0.66, 0.88]],
    [60, [0.20, 0.45, 0.74]],
    [120, [0.13, 0.30, 0.56]],
    [200, [0.09, 0.19, 0.40]],
]);
export function crustColor(crustAgeMa) {
    const a = Math.max(0, crustAgeMa);
    for (let i = 1; i < CRUST_RAMP.length; i++) {
        const [a1, c1] = CRUST_RAMP[i];
        if (a <= a1) {
            const [a0, c0] = CRUST_RAMP[i - 1], f = (a - a0) / (a1 - a0);
            return c0.map((v, k) => v + (c1[k] - v) * f);
        }
    }
    return CRUST_RAMP[CRUST_RAMP.length - 1][1].slice();
}
/** Crust whose appearance age is a placeholder (≥ this) is not seafloor of known age. */
export const CRUST_AGE_UNKNOWN = 400;

/** A latitude-vs-age chart model for the track: x = age (right = older), y = latitude. */
export function latitudeChart(track, width, height, pad = { l: 34, r: 8, t: 8, b: 20 }) {
    if (!track || track.points.length < 2) return null;
    const lats = track.points.map((p) => p.lat);
    let lo = Math.min(...lats, 0), hi = Math.max(...lats, 0);
    const span = Math.max(10, hi - lo);
    lo = Math.max(-90, Math.floor((lo - span * 0.1) / 10) * 10);
    hi = Math.min(90, Math.ceil((hi + span * 0.1) / 10) * 10);
    const x = (age) => pad.l + (width - pad.l - pad.r) * age / AGE_MAX;
    const y = (lat) => pad.t + (height - pad.t - pad.b) * (hi - lat) / (hi - lo);
    const path = track.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.age).toFixed(1)},${y(p.lat).toFixed(1)}`).join('');
    const yTicks = [];
    const step = hi - lo > 60 ? 30 : hi - lo > 30 ? 15 : 10;
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) yTicks.push({ v, y: y(v), label: v === 0 ? '0°' : formatLat(v) });
    const xTicks = [0, 50, 100, 150, 200, 250].map((a) => ({ v: a, x: x(a), label: a === 0 ? 'now' : `${a}` }));
    return { path, x, y, lo, hi, yTicks, xTicks, width, height, pad };
}

/**
 * What the pyGPlates check measured (scripts/paleo_oracle.py →
 * tests/fixtures/paleo/pygplates-oracle.json, gated in
 * tests/paleo-rotations.mjs §6). The page prints these; tests/deep-time-earth.mjs
 * re-measures them and fails if they drift, so the page cannot overstate it.
 */
export const ORACLE_CHECK = Object.freeze({
    pygplates: '1.0.0',
    rotations: 12817, refusals: 3599, worstDeg: 1.8e-4,
    points: 4000, partitionAgree: 3995,
    sitesDeg: 4.6e-5,
});
