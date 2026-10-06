/**
 * sky-predict.js — PURE forecasting kernel for SkyView: the sky over TIME
 * ═══════════════════════════════════════════════════════════════════════════
 * sky-engine.js answers "where is it NOW". This answers the observer's next
 * questions, all of them predictions:
 *
 *   - When is it up in the dark tonight, and how high does it get?
 *   - Which of the next 30 nights is best for it (and what is the Moon doing)?
 *   - What path does it trace across my sky tonight?
 *   - Where will it be at THIS clock time on each of the coming nights?
 *   - When in the year is its season (it crosses the meridian at midnight)?
 *
 * ── WHY THE SKY "MOVES" FROM NIGHT TO NIGHT ──────────────────────────────
 * A galactic object is FIXED on the celestial sphere: its whole motion in your
 * sky is the Earth turning under it. But the Earth turns once per SIDEREAL day
 * (23 h 56 m 4 s), not per clock day, so at the same clock time every star is
 * 0.9856° further west each night and rises 3 m 56 s earlier — a full circuit
 * in a year. That drift is what turns "where is Orion tonight" into "Orion is a
 * winter constellation". The Moon (≈13°/day) and planets (slower, sometimes
 * BACKWARDS — retrograde) additionally move against the stars, so they are
 * evaluated per sample from the ephemeris rather than as a fixed direction.
 *
 * ── THE NIGHT GRID (why this is fast enough to forecast everything) ──────
 * `buildNightGrid` samples each night noon→noon ONCE: the observer's frame
 * matrix, the Sun's altitude and the Moon's position at every step. A FIXED
 * target then costs one 3×3 multiply per sample — 120 galaxy-map objects over
 * 30 nights is ~350 000 multiplies, a few milliseconds — while a moving body
 * (planet, Moon) re-runs only its own ephemeris. The grid is anchored to the
 * forecast's START, not to the scrubbed time, so dragging the time slider
 * through a month never rebuilds it.
 *
 * A "night" is the local-mean-solar noon → noon window that contains one
 * evening; after 06:00 local mean time the upcoming evening is night 0.
 *
 * Window edges are linearly interpolated between samples (15 min default):
 * the Sun moves ≤ 0.25° and a star ≤ 3.75° per step, so edges land within a
 * minute or two — the test pins that against the refined rise/set solver.
 */

import {
    skyFrame, toEnu, raDecToVec, vecToRaDec, refractionDeg, solarSystemObjects,
    D2R, R2D,
} from './sky-engine.js';
import {
    sunGeoDirectionJ2000, moonGeoJ2000, moonPhase, eclipticToEquatorial, OBLIQUITY_J2000_DEG,
} from '../neo-space.js';
import { AU_KM } from '../neo-orbits.js';

export const SIDEREAL_RATIO = 1.00273790935;                    // sidereal days per solar day
/** Degrees a fixed star moves west, at the same clock time, per night. */
export const NIGHTLY_DRIFT_DEG = 360 * (SIDEREAL_RATIO - 1);    // 0.9856°
/** Minutes earlier a fixed star rises each night. */
export const NIGHTLY_EARLIER_MIN = 1440 * (1 - 1 / SIDEREAL_RATIO); // 3.93 min

export const DEFAULT_MIN_ALT_DEG = 20;   // airmass ≈ 2.9 — the usual planner floor
export const DARK_SUN_DEG = -18;          // astronomical darkness
export const TWILIGHT_SUN_DEG = -6;       // civil twilight (the chart's lighter band)

const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const eqJ = (x, y, z) => eclipticToEquatorial(x, y, z, OBLIQUITY_J2000_DEG);

/**
 * The local-mean-solar NOON (JD) that opens the night belonging to `jd`'s
 * evening. Local mean midnight is where jd + 0.5 + lon/360 is an integer.
 */
export function nightNoonJd(jd, lonDeg) {
    const lmt = jd + 0.5 + lonDeg / 360;
    const f = lmt - Math.floor(lmt);                 // fraction of the local mean day
    const midnightBefore = jd - f;
    return f >= 0.25 ? midnightBefore + 0.5 : midnightBefore - 0.5;
}

/** Interpolated level crossings of a sampled series: [{ jd, up }]. */
function crossings(jds, vals, level) {
    const out = [];
    for (let i = 1; i < vals.length; i++) {
        const a = vals[i - 1] - level, b = vals[i] - level;
        if ((a <= 0 && b > 0) || (a > 0 && b <= 0)) {
            const t = a / (a - b);
            out.push({ jd: jds[i - 1] + (jds[i] - jds[i - 1]) * t, up: b > 0 });
        }
    }
    return out;
}

/** First interval where vals < level (dusk → dawn), or the whole window, or null. */
function belowInterval(jds, vals, level) {
    const cx = crossings(jds, vals, level);
    const n = jds.length;
    const startBelow = vals[0] < level;
    if (!cx.length) return startBelow ? { start: jds[0], end: jds[n - 1], whole: true } : null;
    const down = startBelow ? null : cx.find((c) => !c.up);
    const start = startBelow ? jds[0] : down?.jd;
    if (start == null) return null;
    const up = cx.find((c) => c.up && c.jd > start);
    return { start, end: up ? up.jd : jds[n - 1], whole: false };
}

/**
 * Sample `nights` nights from the night containing `jdStart`. Each night:
 * jd[], frame matrices m (9 per sample), sun altitude, Moon direction (J2000,
 * topocentric) and altitude, plus dusk/dawn at DARK_SUN_DEG and at
 * TWILIGHT_SUN_DEG and the Moon's lit fraction at local midnight.
 */
export function buildNightGrid({ latDeg, lonDeg }, jdStart, nights = 30, {
    stepMin = 15, darkSunDeg = DARK_SUN_DEG, twilightSunDeg = TWILIGHT_SUN_DEG,
} = {}) {
    const noon0 = nightNoonJd(jdStart, lonDeg);
    const per = Math.round(1440 / stepMin);
    const step = 1 / per;
    const out = [];
    for (let k = 0; k < nights; k++) {
        const noon = noon0 + k;
        const n = per + 1;
        const jd = new Float64Array(n), m = new Float64Array(n * 9);
        const sunAlt = new Float32Array(n), moonAlt = new Float32Array(n), moonVec = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const t = noon + i * step;
            jd[i] = t;
            const f = skyFrame(t, latDeg, lonDeg);
            m.set(f.m, i * 9);
            const s = sunGeoDirectionJ2000(t);
            const se = eqJ(s.x, s.y, s.z);
            sunAlt[i] = Math.asin(clamp1(toEnu(f, [se.x, se.y, se.z])[2])) * R2D;
            const mo = moonGeoJ2000(t);
            const me = eqJ(mo.x * AU_KM, mo.y * AU_KM, mo.z * AU_KM);
            const o = f.observerJ2000Km;
            const v = [me.x - o[0], me.y - o[1], me.z - o[2]];
            const r = Math.hypot(v[0], v[1], v[2]);
            moonVec[i * 3] = v[0] / r; moonVec[i * 3 + 1] = v[1] / r; moonVec[i * 3 + 2] = v[2] / r;
            moonAlt[i] = Math.asin(clamp1(toEnu(f, [v[0] / r, v[1] / r, v[2] / r])[2])) * R2D;
        }
        const dark = belowInterval(jd, sunAlt, darkSunDeg);
        const twi = belowInterval(jd, sunAlt, twilightSunDeg);
        const ph = moonPhase(noon + 0.5);
        out.push({
            index: k, noonJd: noon, midnightJd: noon + 0.5,
            jd, m, sunAlt, moonAlt, moonVec,
            dusk: dark?.start ?? null, dawn: dark?.end ?? null,
            twilightStart: twi?.start ?? null, twilightEnd: twi?.end ?? null,
            darkHours: dark ? (dark.end - dark.start) * 24 : 0,
            moonIllum: ph.illuminated, moonPhaseName: ph.name,
        });
    }
    return Object.freeze({ latDeg, lonDeg, stepMin, darkSunDeg, twilightSunDeg, startNoonJd: noon0, nights: out });
}

/** A fixed target from J2000 RA/Dec. */
export function fixedTarget(raDeg, decDeg) {
    return { moving: false, vec: raDecToVec(raDeg, decDeg) };
}

/**
 * A solar-system body (topocentric, from sky-engine's own ephemeris). Moving
 * targets are re-evaluated per sample — the Moon moves ~0.5° an hour.
 */
export function bodyTarget(id, { latDeg, lonDeg }) {
    return {
        moving: true, id,
        vecAt(jd) {
            const f = skyFrame(jd, latDeg, lonDeg);
            const o = solarSystemObjects(f, { only: id })[0];
            return raDecToVec(o.raDeg, o.decDeg);
        },
    };
}

/** Apparent altitude/azimuth from a frame matrix and a J2000 unit vector. */
function altAzFromMatrix(m, off, v) {
    const e = m[off] * v[0] + m[off + 1] * v[1] + m[off + 2] * v[2];
    const n = m[off + 3] * v[0] + m[off + 4] * v[1] + m[off + 5] * v[2];
    const u = m[off + 6] * v[0] + m[off + 7] * v[1] + m[off + 8] * v[2];
    const geo = Math.asin(clamp1(u)) * R2D;
    let az = Math.atan2(e, n) * R2D;
    if (az < 0) az += 360;
    return { altDeg: geo + refractionDeg(geo), azDeg: az };
}

/**
 * Per-night visibility of a target over a grid. "Usable" = Sun below the dark
 * limit AND target at or above `minAltDeg`; windows are the usable intervals
 * with interpolated edges. The Moon is reported, not hidden: its lit fraction,
 * how much of the window it is up, and its distance from the target.
 *
 * `score` = usable hours × (1 − 0.7 · lit fraction · Moon-up fraction): a
 * stated heuristic for "best night", not a sky-brightness model. The page
 * prints hours and the Moon separately so nobody has to trust it.
 */
export function forecastVisibility(grid, target, { minAltDeg = DEFAULT_MIN_ALT_DEG } = {}) {
    const nights = grid.nights.map((nt) => {
        const n = nt.jd.length;
        const alt = new Float32Array(n), az = new Float32Array(n);
        const vecs = target.moving ? new Array(n) : null;
        for (let i = 0; i < n; i++) {
            const v = target.moving ? (vecs[i] = target.vecAt(nt.jd[i])) : target.vec;
            const a = altAzFromMatrix(nt.m, i * 9, v);
            alt[i] = a.altDeg; az[i] = a.azDeg;
        }
        // g > 0 ⇔ usable. Its zero crossings are the window edges.
        const g = new Float32Array(n);
        for (let i = 0; i < n; i++) g[i] = Math.min(grid.darkSunDeg - nt.sunAlt[i], alt[i] - minAltDeg);
        const windows = [];
        let open = g[0] > 0 ? nt.jd[0] : null;
        for (let i = 1; i < n; i++) {
            const a = g[i - 1], b = g[i];
            if (a <= 0 && b > 0) open = nt.jd[i - 1] + (nt.jd[i] - nt.jd[i - 1]) * (a / (a - b));
            else if (a > 0 && b <= 0 && open != null) {
                windows.push({ start: open, end: nt.jd[i - 1] + (nt.jd[i] - nt.jd[i - 1]) * (a / (a - b)) });
                open = null;
            }
        }
        if (open != null) windows.push({ start: open, end: nt.jd[n - 1] });
        const hours = windows.reduce((h, w) => h + (w.end - w.start) * 24, 0);

        // Culmination over the whole noon→noon window, and the best moment in the dark.
        let cul = 0, peak = -1;
        for (let i = 0; i < n; i++) {
            if (alt[i] > alt[cul]) cul = i;
            if (nt.sunAlt[i] <= grid.darkSunDeg && (peak < 0 || alt[i] > alt[peak])) peak = i;
        }
        // Moon: up-fraction over the usable samples, separation at the dark peak.
        let usable = 0, moonUp = 0;
        for (let i = 0; i < n; i++) if (g[i] > 0) { usable++; if (nt.moonAlt[i] > 0) moonUp++; }
        const moonUpFrac = usable ? moonUp / usable : 0;
        let moonSepDeg = null;
        if (peak >= 0) {
            const v = target.moving ? vecs[peak] : target.vec;
            const mv = [nt.moonVec[peak * 3], nt.moonVec[peak * 3 + 1], nt.moonVec[peak * 3 + 2]];
            moonSepDeg = Math.acos(clamp1(v[0] * mv[0] + v[1] * mv[1] + v[2] * mv[2])) * R2D;
        }
        return {
            index: nt.index, noonJd: nt.noonJd, midnightJd: nt.midnightJd,
            dusk: nt.dusk, dawn: nt.dawn, twilightStart: nt.twilightStart, twilightEnd: nt.twilightEnd,
            darkHours: nt.darkHours, moonIllum: nt.moonIllum, moonPhaseName: nt.moonPhaseName,
            windows, hours,
            culminationJd: nt.jd[cul], culminationAltDeg: alt[cul],
            peakJd: peak >= 0 ? nt.jd[peak] : null, peakAltDeg: peak >= 0 ? alt[peak] : null,
            peakAzDeg: peak >= 0 ? az[peak] : null,
            moonUpFrac, moonSepDeg,
            score: hours * (1 - 0.7 * nt.moonIllum * moonUpFrac),
        };
    });
    let best = -1;
    nights.forEach((n, i) => { if (n.score > 0 && (best < 0 || n.score > nights[best].score + 1e-9)) best = i; });
    return {
        minAltDeg, nights, best,
        totalHours: nights.reduce((h, n) => h + n.hours, 0),
        nightsUsable: nights.filter((n) => n.hours > 0).length,
    };
}

/**
 * Apparent alt/az samples of a target between two instants — the path it
 * draws across the sky (tonight's arc). `hourMarks` flags samples that fall on
 * a whole UTC hour + the given offset, for tick labels.
 */
export function pathSamples({ latDeg, lonDeg }, target, jdFrom, jdTo, { stepMin = 10 } = {}) {
    const out = [];
    const step = stepMin / 1440;
    for (let t = jdFrom; t <= jdTo + 1e-9; t += step) {
        const f = skyFrame(t, latDeg, lonDeg);
        const v = target.moving ? target.vecAt(t) : target.vec;
        const a = altAzFromMatrix(f.m, 0, v);
        out.push({ jd: t, altDeg: a.altDeg, azDeg: a.azDeg });
    }
    return out;
}

/** Where the target is at the SAME clock time on each of `nights` nights. */
export function sameTimeSamples({ latDeg, lonDeg }, target, jd0, nights, { stepDays = 1 } = {}) {
    const out = [];
    for (let k = 0; k < nights; k++) {
        const t = jd0 + k * stepDays;
        const f = skyFrame(t, latDeg, lonDeg);
        const v = target.moving ? target.vecAt(t) : target.vec;
        const a = altAzFromMatrix(f.m, 0, v);
        out.push({ jd: t, night: k, altDeg: a.altDeg, azDeg: a.azDeg });
    }
    return out;
}

/**
 * The date (JD) in the year after `jdFrom` when a FIXED target sits opposite
 * the Sun — i.e. crosses the meridian near local midnight: the middle of its
 * observing season. Daily scan of the Sun's RA, linear interpolation. Exact to
 * a day or so (the equation of time moves "midnight" by up to 16 minutes).
 */
export function seasonPeakJd(raDeg, jdFrom) {
    const sunRa = (jd) => {
        const s = sunGeoDirectionJ2000(jd);
        const e = eqJ(s.x, s.y, s.z);
        return vecToRaDec([e.x, e.y, e.z]).raDeg;
    };
    const diff = (jd) => ((sunRa(jd) + 180 - raDeg + 540) % 360) - 180;   // −180..180
    let prev = diff(jdFrom);
    for (let d = 1; d <= 367; d++) {
        const cur = diff(jdFrom + d);
        // The Sun's RA increases, so the difference crosses 0 going UP (and wraps
        // from +180 to −180 once — that jump is not a crossing).
        if (prev <= 0 && cur > 0 && cur - prev < 90) {
            return jdFrom + d - 1 + (-prev) / (cur - prev);
        }
        prev = cur;
    }
    return null;
}

export { D2R };
