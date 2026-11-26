/**
 * sounder.js — measuring depth the way ships and landers do. PURE.
 *
 * THREE INSTRUMENTS, three different errors, and the page shows all of them at one point:
 *
 * 1. ECHO TIME. An echo sounder measures a two-way travel time, never a depth:
 *        t = 2 ∫₀ᴰ dz / c(z)          (vertical incidence; c from the column's T, S, p)
 *    Sounders are built around a NOMINAL speed (1500 m/s; 800 fathoms/s = 1463 m/s on older
 *    British charts) and the reading is corrected afterwards from the real sound-speed profile
 *    (historically Matthews' and Carter's tables). Because c rises ~17 m/s per km of depth, the
 *    harmonic-mean speed over an 11 km column is ~1550 m/s and an uncorrected 1500 m/s reading
 *    is ~350 m TOO SHALLOW. `sounding()` returns the time, the naive depth and the correction;
 *    `depthFromTravelTime()` is the exact inverse on the same column (gated round trip).
 *
 * 2. BEAM GEOMETRY. A beam is a cone; the FIRST echo comes from the NEAREST sea floor inside it,
 *    not from the point below the ship. Over a trench wall that is a side echo and the sounding
 *    reads SHOAL — the classic reason single-beam trench depths disagree. `firstReturn()` finds
 *    the nearest grid point within the cone (straight rays: refraction over a vertical-ish path is
 *    second order and ignored, disclosed). A narrow multibeam beam (~1°) removes most of it; that
 *    it can only be evaluated on a ~1.8 km grid is disclosed too.
 *
 * 3. PRESSURE. Landers and submersibles (Challenger Deep, 1960 → 2020) measure PRESSURE and
 *    convert: seawater.js `depthFromPressure`. Its error is the density model's, ~0.1–0.2 %.
 */
import { depthFromPressure, pressureFromDepth, SOUND_SPEED_UNCERTAINTY } from './seawater.js';
import { depthAtCell, cellLat, cellLon, localOffsetKm, sampleDepth } from './bathy.js';

export const NOMINAL_SPEEDS = Object.freeze({ metric: 1500, fathoms800: 1463.04 });
export const BEAMS = Object.freeze([
    { id: 'multibeam', label: 'Modern multibeam (1°)', deg: 1 },
    { id: 'narrow',    label: 'Narrow single beam (12°)', deg: 12 },
    { id: 'wide',      label: 'Wide single beam (30°)', deg: 30 },
    { id: 'historic',  label: '1950s wide beam (60°)', deg: 60 },
]);
const D2R = Math.PI / 180;

/** One-way vertical travel time (s) from the column's first level to depthM: trapezoid on slowness. */
function oneWay(column, depthM) {
    const L = column.levels;
    let t = 0;
    // above the first measured level the first level's speed is held (the top few metres)
    if (L[0].z > 0) t += Math.min(depthM, L[0].z) / L[0].c;
    for (let i = 1; i < L.length && L[i - 1].z < depthM; i++) {
        const a = L[i - 1], b = L[i];
        const zb = Math.min(b.z, depthM);
        const cb = b.z === a.z ? b.c : a.c + (b.c - a.c) * (zb - a.z) / (b.z - a.z);
        t += (zb - a.z) * 0.5 * (1 / a.c + 1 / cb);
    }
    const last = L[L.length - 1];
    if (depthM > last.z) return null;            // never timed through water the column does not describe
    return t;
}

export function travelTime(column, depthM) {
    const t = oneWay(column, depthM);
    return t == null ? null : 2 * t;
}

/** Depth whose two-way time is `twoWayS` on this column (bisection; null if deeper than the column). */
export function depthFromTravelTime(column, twoWayS) {
    const max = column.levels[column.levels.length - 1].z;
    if (!(twoWayS >= 0) || travelTime(column, max) < twoWayS) return null;
    let lo = 0, hi = max;
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (travelTime(column, m) < twoWayS) lo = m; else hi = m; }
    return (lo + hi) / 2;
}

/**
 * A vertical sounding of a floor at `depthM`.
 * errorM < 0 means the uncorrected reading is too SHALLOW; correctionM is what must be ADDED to it.
 */
export function sounding(column, depthM, { nominal = NOMINAL_SPEEDS.metric } = {}) {
    const twoWayS = travelTime(column, depthM);
    if (twoWayS == null) return null;
    const meanSpeed = 2 * depthM / twoWayS;                // the harmonic mean: what a correction table tabulates
    const naiveDepth = nominal * twoWayS / 2;
    return {
        depthM, twoWayS, meanSpeed, nominal, naiveDepth,
        errorM: naiveDepth - depthM, correctionM: depthM - naiveDepth,
        speedUncertaintyM: depthM * SOUND_SPEED_UNCERTAINTY,
    };
}

export const beamFootprintM = (depthM, beamDeg) => 2 * depthM * Math.tan(beamDeg * D2R / 2);

/**
 * The first echo inside a beam cone of full width `beamDeg` pointed straight down at (lat, lon).
 * Scans the grid's cells: slant range R = √(h² + D²) to each cell centre (D horizontal, h its
 * depth), kept if its off-axis angle atan(D/h) ≤ beam/2; the smallest R is the first return and
 * what a time-of-flight sounder reports as "depth". The point directly below is always a candidate,
 * so the apparent depth is never deeper than the true one.
 */
export function firstReturn(g, lat, lon, beamDeg) {
    const below = sampleDepth(g, lat, lon);
    if (below == null || !(below > 0)) return null;
    const half = beamDeg * D2R / 2;
    const reachKm = below * Math.tan(half) / 1000;
    const stepKm = g.step * D2R * 6371.0088;
    const dj = Math.ceil(reachKm / stepKm) + 1;
    const di = Math.ceil(reachKm / (stepKm * Math.max(Math.cos(lat * D2R), 0.05))) + 1;
    const j0 = Math.round((g.north - lat) / g.step);
    let fi = lon - g.west; fi -= 360 * Math.floor(fi / 360);
    const i0 = Math.round(fi / g.step);
    let best = { range: below, depth: below, offKm: 0, lat, lon, bearingDeg: null };
    for (let j = Math.max(0, j0 - dj); j <= Math.min(g.ny - 1, j0 + dj); j++) {
        for (let i = Math.max(0, i0 - di); i <= Math.min(g.nx - 1, i0 + di); i++) {
            const h = depthAtCell(g, i, j);
            if (!(h > 0)) continue;
            const o = localOffsetKm(lat, lon, cellLat(g, j), cellLon(g, i));
            const D = Math.hypot(o.e, o.n) * 1000;
            if (Math.atan2(D, h) > half) continue;
            const R = Math.hypot(D, h);
            if (R < best.range) best = { range: R, depth: h, offKm: D / 1000, lat: cellLat(g, j), lon: cellLon(g, i), bearingDeg: (Math.atan2(o.e, o.n) / D2R + 360) % 360 };
        }
    }
    return { trueDepth: below, apparentDepth: best.range, biasM: best.range - below, hit: best, footprintM: beamFootprintM(below, beamDeg), beamDeg };
}

/** What a pressure gauge on the floor reads, and the depth that reading converts back to. */
export function pressureSounding(depthM, lat) {
    const p = pressureFromDepth(depthM, lat);
    return { dbar: p, MPa: p / 100, atm: p / 10.1325 + 1, depthM: depthFromPressure(p, lat) };
}
