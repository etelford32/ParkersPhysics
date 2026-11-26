/**
 * profile.js — the water column over a sea-floor site: MEASURED where an instrument went,
 * MODELLED (adiabat) below it. PURE.
 *
 * THE PHYSICS THE PAGE IS ABOUT: below ~4 km the deep ocean is nearly one water mass, so its
 * POTENTIAL temperature is almost constant — and its IN-SITU temperature therefore RISES with
 * depth along the adiabat (~0.1–0.18 °C per km), because the water is compressed. A trench floor
 * is warmer than the abyssal plain beside it. `buildColumn` continues a cast below its last
 * level by exactly that: the last measured parcel moved adiabatically (seawater.js
 * `potentialTemperature`), salinity held. Each level says `kind: 'measured' | 'model'`.
 *
 * WHAT THE MODEL IS NOT: it assumes the water below the cast is the SAME water (θ and S constant).
 * That is good in a trench (the hadal water is ventilated over the sill and is well mixed) and
 * is what `withheldTest` MEASURES on real casts — the adiabat against two controls (temperature
 * held constant; the last 500 m's gradient extrapolated). It ignores geothermal heating
 * (~mK over the bottom hundreds of metres) and is wrong across a water-mass boundary, which is why
 * a column whose model gap exceeds `MODEL_GAP_WARN_M`, or whose model part starts above
 * `ADIABAT_SAFE_FROM_M`, is flagged on the page.
 */
import { soundSpeed, potentialTemperature, pressureFromDepth, inFittedRange } from './seawater.js';

export const MODEL_STEP_M = 50;
export const MODEL_GAP_WARN_M = 1500;
/** Used ONLY where a cast carries no usable salinity at all; disclosed as `sKind: 'assumed'`. */
export const DEFAULT_SALINITY = 34.7;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Salinity at every level: measured, else linearly bridged between measured neighbours, else held, else assumed. */
export function fillSalinity(z, s) {
    const n = z.length, out = new Array(n), kind = new Array(n);
    const have = [];
    for (let i = 0; i < n; i++) if (s && fin(s[i])) have.push(i);
    if (!have.length) { for (let i = 0; i < n; i++) { out[i] = DEFAULT_SALINITY; kind[i] = 'assumed'; } return { s: out, kind }; }
    let k = 0;
    for (let i = 0; i < n; i++) {
        while (k < have.length - 1 && have[k + 1] <= i) k++;
        const a = have[k], b = have[Math.min(k + 1, have.length - 1)];
        if (a === i) { out[i] = s[i]; kind[i] = 'measured'; }
        else if (i < a || a === b || i > b) { out[i] = s[i < a ? a : (i > b ? b : a)]; kind[i] = 'held'; }
        else { const f = (z[i] - z[a]) / (z[b] - z[a]); out[i] = s[a] + f * (s[b] - s[a]); kind[i] = 'bridged'; }
    }
    return { s: out, kind };
}

/**
 * The full column from the surface-most measured level to `floorDepthM`.
 * @returns {{levels: Array, measuredTo: number, floorDepth: number, gapM: number, modelled: boolean,
 *            salinity: 'measured'|'partly'|'assumed', flags: string[]}}
 */
export function buildColumn({ z, t, s = null, lat, floorDepthM }) {
    if (!z || !t || z.length !== t.length || z.length < 2) return null;
    const sal = fillSalinity(z, s);
    const levels = [];
    for (let i = 0; i < z.length; i++) {
        if (!fin(z[i]) || !fin(t[i])) continue;
        if (fin(floorDepthM) && z[i] > floorDepthM + 1e-6 && levels.length) {
            // a cast that reads DEEPER than the grid's floor is kept whole: the grid is the coarser of the two
        }
        const p = pressureFromDepth(z[i], lat);
        levels.push(level(z[i], p, t[i], sal.s[i], 'measured', sal.kind[i]));
    }
    if (levels.length < 2) return null;
    const last = levels[levels.length - 1];
    const measuredTo = last.z;
    const floor = fin(floorDepthM) ? Math.max(floorDepthM, measuredTo) : measuredTo;
    let zz = measuredTo;
    while (zz < floor - 1e-6) {
        zz = Math.min(floor, (Math.floor(zz / MODEL_STEP_M + 1e-9) + 1) * MODEL_STEP_M);
        const p = pressureFromDepth(zz, lat);
        const tm = potentialTemperature(last.s, last.t, last.p, p);
        levels.push(level(zz, p, tm, last.s, 'model', 'held'));
    }
    const kinds = new Set(sal.kind);
    const gapM = floor - measuredTo;
    const flags = [];
    if (gapM > MODEL_GAP_WARN_M) flags.push('long-model-gap');
    if (gapM > 200 && measuredTo < ADIABAT_SAFE_FROM_M) flags.push('model-from-shallow');
    if (levels.some((l) => !inFittedRange(l.s, l.t, l.p))) flags.push('outside-fitted-range');
    if (fin(floorDepthM) && measuredTo > floorDepthM + 1) flags.push('cast-deeper-than-grid');
    return {
        levels, measuredTo, floorDepth: floor, gapM, modelled: gapM > 1e-6, flags,
        salinity: kinds.has('assumed') ? 'assumed' : (kinds.size === 1 && kinds.has('measured') ? 'measured' : 'partly'),
    };
}

function level(z, p, t, s, kind, sKind) {
    return { z, p, t, s, theta: potentialTemperature(s, t, p, 0), c: soundSpeed(s, t, p), kind, sKind };
}

/** Linear interpolation of one field of a column at a depth (null outside it — never extrapolated). */
export function columnAt(column, depthM, field = 't') {
    const L = column.levels;
    if (!(depthM >= L[0].z - 1e-9) || depthM > L[L.length - 1].z + 1e-9) return null;
    let lo = 0, hi = L.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m].z <= depthM) lo = m; else hi = m; }
    const a = L[lo], b = L[hi];
    if (b.z === a.z) return a[field];
    return a[field] + (b[field] - a[field]) * (depthM - a.z) / (b.z - a.z);
}

/** Temperature at the floor and how it is known. */
export function floorTemperature(column) {
    const b = column.levels[column.levels.length - 1];
    return { t: b.t, theta: b.theta, p: b.p, kind: b.kind, gapM: column.gapM, measuredTo: column.measuredTo };
}

/** Depth of the in-situ temperature MINIMUM (below 500 m, so a polar surface layer is not it). */
export function temperatureMinimum(column, belowM = 500) {
    let best = null;
    for (const l of column.levels) if (l.z >= belowM && (!best || l.t < best.t)) best = l;
    return best && { z: best.z, t: best.t, kind: best.kind, atFloor: best === column.levels[column.levels.length - 1] };
}

/** The SOFAR axis: the sound-speed minimum of the column (null if it is at either end). */
export function soundChannelAxis(column) {
    const L = column.levels;
    let k = 0;
    for (let i = 1; i < L.length; i++) if (L[i].c < L[k].c) k = i;
    return { z: L[k].z, c: L[k].c, interior: k > 0 && k < L.length - 1 };
}

/**
 * HOW GOOD IS THE ADIABAT HERE? Withhold everything below `cutDepthM` of a real cast, predict it
 * three ways from the level at the cut, and score against what the instrument recorded.
 *   adiabat     the page's model
 *   isothermal  temperature held (control: "the deep sea is uniformly cold")
 *   gradient    the last `fitM` metres' dT/dz extrapolated (control: "keep doing what it was doing")
 * Returns null unless at least `minLevels` withheld levels exist.
 */
export function withheldTest({ z, t, s = null, lat }, cutDepthM, { fitM = 500, minLevels = 4 } = {}) {
    const sal = fillSalinity(z, s).s;
    let k = -1;
    for (let i = 0; i < z.length; i++) if (z[i] <= cutDepthM) k = i;
    if (k < 1 || z.length - 1 - k < minLevels) return null;
    const p0 = pressureFromDepth(z[k], lat);
    let j = k;
    while (j > 0 && z[k] - z[j - 1] <= fitM) j--;
    if (j === k) j = k - 1;
    const grad = (t[k] - t[j]) / (z[k] - z[j]);
    const sq = { adiabat: 0, isothermal: 0, gradient: 0 }, end = {};
    let n = 0;
    for (let i = k + 1; i < z.length; i++) {
        const pred = {
            adiabat: potentialTemperature(sal[k], t[k], p0, pressureFromDepth(z[i], lat)),
            isothermal: t[k],
            gradient: t[k] + grad * (z[i] - z[k]),
        };
        for (const m in sq) { sq[m] += (pred[m] - t[i]) ** 2; end[m] = pred[m] - t[i]; }
        n++;
    }
    const rms = {};
    for (const m in sq) rms[m] = Math.sqrt(sq[m] / n);
    return { cutDepth: z[k], toDepth: z[z.length - 1], n, rms, endError: end, observedRise: t[z.length - 1] - t[k] };
}

/**
 * The reference cast for a site: the deepest — but a cast that reaches within `REFERENCE_TIE_M` of
 * the deepest with MORE levels is preferred (a 9 000-level CTD over a 9-bottle cast to nearly the
 * same depth). Remaining ties go to the most recent.
 */
export const REFERENCE_TIE_M = 300;
export function referenceCast(casts) {
    if (!casts || !casts.length) return null;
    const max = Math.max(...casts.map((c) => c.max_depth_m));
    return casts.filter((c) => c.max_depth_m >= max - REFERENCE_TIE_M)
        .sort((a, b) => ((b.levels || 0) - (a.levels || 0)) || (b.max_depth_m - a.max_depth_m) || (a.date < b.date ? 1 : -1))[0];
}

/**
 * WHERE THE ADIABAT MAY BE STARTED. MEASURED on the real casts (tests/seafloor-kernels.mjs §5):
 * continued from below ~6 km it predicts withheld hadal water to a median 0.01 °C; started at
 * 4–5 km in the Atlantic or the eastern Indian Ocean it LOSES to "temperature held", because
 * colder Antarctic Bottom Water lies underneath and the model cannot know. A column whose model
 * part starts above this depth is flagged `model-from-shallow` and the page says the modelled
 * floor is probably too WARM.
 */
export const ADIABAT_SAFE_FROM_M = 5500;
