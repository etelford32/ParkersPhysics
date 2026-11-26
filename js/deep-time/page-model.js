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
import * as GT from '../plate-history/geotime.js';
import { AGE_RAMP, AGE_RAMP_MAX_MYR, ageColor, ageAt } from '../earth-interior/seafloor-age.js';
import * as PR from '../paleo/rotations.js';
import * as PL from '../paleo/plates.js';

export const AGE_MAX = 250;
export const R_EARTH_KM = 6371;

/**
 * Geological periods inside the model's range: the SITE's one time scale,
 * js/plate-history/geotime.js (the ICS chart, written from memory, its
 * VERIFIED flag carried through), clipped to this page's 250 Myr. Only the
 * colours are this page's own. A display aid for the slider, never an input.
 * The Triassic began at 251.902 Ma, just past the model's 250.
 */
const PERIOD_COLORS = { Quaternary: '#c9c27a', Neogene: '#d9b34f', Paleogene: '#d98a4f', Cretaceous: '#7fb069', Jurassic: '#4fa3b5', Triassic: '#8c6bb8' };
export const PERIODS = Object.freeze(GT.PERIODS.filter(([, base, top]) => top < AGE_MAX).map(([name, from, to, approx]) =>
    Object.freeze({ name, from, to, approx: !!approx, color: PERIOD_COLORS[name] || '#888' })));
export const PERIODS_VERIFIED = GT.VERIFIED;
export const PERIODS_SOURCE = GT.SOURCE;

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
export function pointReport(model, plates, lat, lon, age, grid = null) {
    const hit = hitAt(plates, lat, lon, grid);
    if (!hit) return { ok: false, reason: 'no-plate', today: { lat, lon } };
    const reach = reachOf(model, hit);
    const continental = PL.isContinental(plates, lat, lon);
    const base = { today: { lat, lon }, plate: hit.plate, plateName: hit.name, fromAge: hit.fromAge, crustSource: hit.crustSource, gridAge: hit.gridAge, continental, reach, overlaps: hit.overlaps };
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
export function trackSamples(model, plates, lat, lon, stepMa = 1, grid = null) {
    const hit = hitAt(plates, lat, lon, grid);
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
 * Seafloor colour: the age of the crust AT THE DISPLAYED AGE (its age today
 * minus the displayed age) on the SITE's one ocean-age ramp, the one the
 * Inner Earth and Plates Through Time pages use (js/earth-interior/seafloor-age.js
 * AGE_RAMP, pale yellow = young, deep purple = old, held past 180 Myr).
 * Where the ocean floor still exists, its age today is Seton et al. 2020's
 * grid (crustAgeToday). Where it has since been subducted, there is no grid
 * value and the model's own ISOCHRON polygon bins stand in (the age of that
 * strip to within its bin). Returns [r, g, b] in 0..1 (sRGB).
 */
export const SEAFLOOR_RAMP = AGE_RAMP;
export const SEAFLOOR_RAMP_MAX_MYR = AGE_RAMP_MAX_MYR;
export const crustColor = (crustAgeMa) => ageColor(Math.max(0, crustAgeMa));
/** The seafloor's age today at (lat, lon) from the Seton 2020 grid, or null (continent / no grid). */
export const crustAgeToday = (grid, lat, lon) => (grid ? ageAt(grid, lat, lon) : null);
/**
 * When a piece of ocean floor first exists: the OLDER of the model's polygon age and the grid's
 * age today. Only ever earlier, never later — a grid age younger than the polygon is a time-scale
 * or gridding difference, not crust the model has wrongly placed. Continental crust (grid null)
 * keeps the model's age. The globe, the panel and the track all go through this.
 */
export const crustAppearAge = (polyFrom, gridAge) => (gridAge != null && gridAge > polyFrom ? gridAge : polyFrom);
/** plateAt, with the appearance age the grid allows; `crustSource` says which set it. */
export function hitAt(plates, lat, lon, grid = null) {
    const hit = PL.plateAt(plates, lat, lon);
    if (!hit) return null;
    const g = PL.isContinental(plates, lat, lon) ? null : crustAgeToday(grid, lat, lon);
    const from = crustAppearAge(hit.fromAge, g);
    return { ...hit, fromAge: from, polygonFromAge: hit.fromAge, gridAge: g, crustSource: from > hit.fromAge ? 'grid' : 'model' };
}
/** Crust whose appearance age is a placeholder (≥ this) is not seafloor of known age. */
export const CRUST_AGE_UNKNOWN = 400;

/** A latitude-vs-age chart model for the track: x = age (right = older), y = latitude. */
export function latitudeChart(track, width, height, { pad = { l: 34, r: 8, t: 8, b: 20 }, second = null } = {}) {
    if (!track || track.points.length < 2) return null;
    const both = track.points.concat(second && second.points.length > 1 ? second.points : []);
    const lats = both.map((p) => p.lat);
    let lo = Math.min(...lats, 0), hi = Math.max(...lats, 0);
    const span = Math.max(10, hi - lo);
    lo = Math.max(-90, Math.floor((lo - span * 0.1) / 10) * 10);
    hi = Math.min(90, Math.ceil((hi + span * 0.1) / 10) * 10);
    const x = (age) => pad.l + (width - pad.l - pad.r) * age / AGE_MAX;
    const y = (lat) => pad.t + (height - pad.t - pad.b) * (hi - lat) / (hi - lo);
    const pathOf = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.age).toFixed(1)},${y(p.lat).toFixed(1)}`).join('');
    const path = pathOf(track.points);
    const path2 = second && second.points.length > 1 ? pathOf(second.points) : null;
    const yTicks = [];
    const step = hi - lo > 60 ? 30 : hi - lo > 30 ? 15 : 10;
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) yTicks.push({ v, y: y(v), label: v === 0 ? '0°' : formatLat(v) });
    const xTicks = [0, 50, 100, 150, 200, 250].map((a) => ({ v: a, x: x(a), label: a === 0 ? 'now' : `${a}` }));
    return { path, path2, x, y, lo, hi, yTicks, xTicks, width, height, pad };
}

/**
 * THE SECOND MODEL. Merdith et al. 2021 (data/paleo/merdith2021-*,
 * scripts/build-paleo-merdith.py, CC BY 4.0) is in a PALAEOMAGNETIC frame —
 * the spin axis, as ancient magnetised rocks record it — where Müller 2019 is
 * in a MANTLE frame. Comparing the two is the page's uncertainty, with two
 * limits the panel states every time:
 *   - they are NOT independent (Merdith's last 250 Myr is compiled from
 *     Young et al. 2019, the same EarthByte lineage), so their difference is
 *     the LEAST the uncertainty can be, never an error bar;
 *   - palaeomagnetism does not fix LONGITUDE, so the latitude difference is
 *     the meaningful one and the distance apart includes a longitude that is
 *     a convention of each frame.
 */
export const SECOND_MODEL = Object.freeze({
    id: 'merdith2021', label: 'Merdith et al. 2021', frame: 'palaeomagnetic (spin axis)',
    files: ['data/paleo/merdith2021-rotations.json', 'data/paleo/merdith2021-plates.json'],
    coastFile: 'data/paleo/merdith2021-coastlines.json',
});
export const PRIMARY_MODEL = Object.freeze({ id: 'muller2019', label: 'Müller et al. 2019', frame: 'mantle' });

/**
 * One present-day point in both models at `age`. Each model assigns the point
 * to a plate with ITS OWN polygons, so the comparison never assumes the two
 * use a plate id for the same piece of crust. Returns { a, b, dLatDeg,
 * apartKm } — the differences only where both models place the point.
 */
export function compareModels(primary, second, lat, lon, age, lonShiftDeg = null) {
    const a = pointReport(primary.model, primary.plates, lat, lon, age);
    const b = pointReport(second.model, second.plates, lat, lon, age);
    if (!a.ok || !b.ok) return { a, b, dLatDeg: null, apartKm: null, apartKmAligned: null };
    const km = (lo) => PR.angularDistance(a.then.lat, a.then.lon, b.then.lat, lo) * Math.PI / 180 * R_EARTH_KM;
    return {
        a, b,
        dLatDeg: b.then.lat - a.then.lat,
        apartKm: km(b.then.lon),
        apartKmAligned: lonShiftDeg == null ? null : km(b.then.lon - lonShiftDeg),
    };
}

/**
 * How far apart the two models put the CONTINENTS at an age: a fixed sample
 * of present-day points on continental crust (Fibonacci sphere, both models
 * must assign a plate), each carried back in both. `spreadSample` does the
 * plate lookups once; `spreadAt` is cheap and is re-run per age. Median and
 * 90th percentile of |Δlatitude| (the meaningful number) and the median
 * distance apart (which includes each frame's longitude convention).
 */
export function spreadSample(primary, second, n = 1500) {
    const g = Math.PI * (3 - Math.sqrt(5)), out = [];
    for (let i = 0; i < n; i++) {
        const lat = Math.asin(1 - 2 * (i + 0.5) / n) * 180 / Math.PI;
        const lon = ((i * g * 180 / Math.PI) % 360 + 540) % 360 - 180;
        if (!PL.isContinental(primary.plates, lat, lon)) continue;
        const ha = PL.plateAt(primary.plates, lat, lon), hb = PL.plateAt(second.plates, lat, lon);
        if (ha && hb) out.push({ lat, lon, ha, hb });
    }
    return out;
}
function pairsAt(sample, primary, second, age) {
    const out = [];
    for (const s of sample) {
        if (age > reachOf(primary.model, s.ha).maxAge + 1e-9 || age > reachOf(second.model, s.hb).maxAge + 1e-9) continue;
        const a = primary.model.reconstruct(s.lat, s.lon, s.ha.plate, age), b = second.model.reconstruct(s.lat, s.lon, s.hb.plate, age);
        if (a && b) out.push([a, b]);
    }
    return out;
}
const quantile = (arr, f) => { if (!arr.length) return null; const v = arr.slice().sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(f * v.length))]; };
/**
 * The LONGITUDE ALIGNMENT. Palaeomagnetism fixes latitude, not longitude, so
 * each frame's longitudes are its own convention; drawn raw, the second
 * model's continents sit mostly EAST-WEST of the first's (1311 km at
 * Chicxulub at 66 Ma, measured), and that offset is the part of the picture
 * that means least. The shift is the circular mean of (lon_b − lon_a) over the
 * continental sample: turning the second model about the spin axis by −shift
 * changes no latitude, so it hides nothing the comparison may claim. Returns
 * degrees, or null on a thin sample.
 */
export function longitudeShift(pairs) {
    if (pairs.length < 20) return null;
    let sx = 0, sy = 0;
    for (const [a, b] of pairs) { const d = (b.lon - a.lon) * Math.PI / 180; sx += Math.cos(d); sy += Math.sin(d); }
    return Math.atan2(sy, sx) * 180 / Math.PI;
}
export function spreadAt(sample, primary, second, age) {
    const pairs = pairsAt(sample, primary, second, age);
    const shift = longitudeShift(pairs);
    const dl = [], km = [], kmAligned = [];
    for (const [a, b] of pairs) {
        dl.push(Math.abs(b.lat - a.lat));
        km.push(PR.angularDistance(a.lat, a.lon, b.lat, b.lon) * Math.PI / 180 * R_EARTH_KM);
        if (shift != null) kmAligned.push(PR.angularDistance(a.lat, a.lon, b.lat, b.lon - shift) * Math.PI / 180 * R_EARTH_KM);
    }
    return { n: dl.length, medianDLat: quantile(dl, 0.5), p90DLat: quantile(dl, 0.9), medianKm: quantile(km, 0.5),
        lonShiftDeg: shift, medianKmAligned: quantile(kmAligned, 0.5) };
}
/** The longitude shift at every `step` Ma from 0 to AGE_MAX (computed once; `shiftAt` interpolates it). */
export function lonShiftTable(sample, primary, second, step = 2) {
    const ages = [], shift = [];
    for (let a = 0; a <= AGE_MAX + 1e-9; a += step) { ages.push(a); shift.push(longitudeShift(pairsAt(sample, primary, second, a))); }
    return { step, ages, shift };
}
export function shiftAt(table, age) {
    if (!table) return 0;
    const i = Math.max(0, Math.min(table.ages.length - 2, Math.floor(age / table.step)));
    const s0 = table.shift[i], s1 = table.shift[i + 1];
    if (s0 == null || s1 == null) return s0 ?? s1 ?? 0;
    const f = Math.max(0, Math.min(1, (age - table.ages[i]) / table.step));
    let d = s1 - s0; d = ((d + 540) % 360) - 180;                     // the short way round
    return s0 + d * f;
}

/**
 * What the pyGPlates check measured, for BOTH models (scripts/paleo_oracle.py →
 * tests/fixtures/paleo/pygplates-oracle*.json, gated in
 * tests/paleo-rotations.mjs §6–7 through tests/helpers/paleo-oracle.mjs).
 * `off`/`offDeg`: plate-and-age rotations away from a crossover and their
 * worst disagreement; `at`/`atDeg`: those AT a crossover instant (where
 * pyGPlates' answer is one the file allows, but its tie rule is not
 * reproduced). The page prints these; tests/deep-time-earth.mjs re-measures
 * them with the same helper and fails if they drift.
 */
export const ORACLE_CHECK = Object.freeze({
    pygplates: '1.0.0',
    muller2019: Object.freeze({ off: 12712, offDeg: 7.6e-10, at: 105, atDeg: 1.8e-4, refusedBoth: 3599, points: 4000, agree: 3995 }),
    merdith2021: Object.freeze({ off: 14190, offDeg: 9.4e-10, at: 221, atDeg: 5.6e-3, refusedBoth: 3941, points: 4000, agree: 3991 }),
    sitesDeg: 4.6e-5,
});
