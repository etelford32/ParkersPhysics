/**
 * time-strip-model.js — PURE geometry for the EarthView time-bar strip.
 *
 * EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §6.1–6.2 (T4.1 meteogram in the
 * track, T4.2 provenance band). Turns a WeatherCube series + coverage into
 * pixel geometry; js/time-strip.js paints it. No DOM, no canvas, no ambient
 * time — node-tested by tests/time-strip-model.mjs.
 *
 * The strip shares the SLIDER's time axis exactly: the caller passes the
 * pixel span of the range input's thumb travel (`trackX0`..`trackX1`, in
 * strip-local CSS px), so a feature drawn at x is the instant the thumb
 * reaches when it sits over x. Measured from the live layout, never assumed.
 *
 * What it draws (each a claim about the selected point):
 *   - temperature line, coloured by the site's ONE temperature ramp
 *     (js/temp-ramp.js), broken at gaps — a missing hour is a gap, not a
 *     straight line across it;
 *   - precipitation bars from the bottom, √-scaled so light rain shows
 *     (disclosed in the tooltip, which prints the number);
 *   - cloud cover as a grey veil from the top;
 *   - night shading where the Sun is below the horizon AT THE POINT;
 *   - the provenance band along the bottom edge (observed / nowcast / NWP,
 *     stale rows hatched, nothing where nothing exists).
 */

import { buildTempLUTPixels, tempToRampFrac } from './temp-ramp.js';

/** Band colours, keyed by provenance. Past = the slider's cyan, future = its amber. */
export const BAND_COLORS = Object.freeze({
    observed: 'rgba(0,200,200,0.85)',
    nowcast:  'rgba(120,220,170,0.85)',
    nwp:      'rgba(255,170,60,0.85)',
});

export const PRECIP_FULL_SCALE_MM_H = 10;   // same cap the decoder packs to
export const MIN_TEMP_SPAN_C = 6;           // never stretch a flat day into a cliff

const LUT = buildTempLUTPixels();

/** sRGB css colour for a temperature, from the shared ramp bytes. */
export function tempColor(tC) {
    const i = Math.round(tempToRampFrac(tC) * 255) * 4;
    return `rgb(${LUT[i]},${LUT[i + 1]},${LUT[i + 2]})`;
}

/** Time → strip x for a track [x0, x1] over the domain [t0, t1]. */
export function timeToX(t, { t0, t1 }, x0, x1) {
    return x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
}

/** Strip x → time, clamped to the domain. */
export function xToTime(x, { t0, t1 }, x0, x1) {
    const f = (x - x0) / (x1 - x0);
    return t0 + Math.max(0, Math.min(1, f)) * (t1 - t0);
}

/** Index of the series sample nearest to t (series.t is uniform). */
export function nearestIndex(series, t) {
    const n = series.t.length;
    if (n === 0) return -1;
    if (n === 1) return 0;
    const step = series.t[1] - series.t[0];
    const i = Math.round((t - series.t[0]) / step);
    return Math.max(0, Math.min(n - 1, i));
}

/**
 * Build the strip geometry.
 *
 * @param {object} p
 * @param {{t: Float64Array, values: Object<string, Float32Array>}} p.series
 *        must include t2m, precip, cloudTotal
 * @param {{t0:number,t1:number,provenance:string,stale:boolean}[]} p.coverage
 * @param {{t0:number,t1:number}} p.domain
 * @param {number} p.width      strip width, CSS px
 * @param {number} p.height     strip height, CSS px
 * @param {number} p.trackX0    thumb-travel start, strip-local px
 * @param {number} p.trackX1    thumb-travel end, strip-local px
 * @param {number} [p.bandH=4]  provenance band height
 * @param {(t:number)=>boolean} [p.isNight]  Sun below the horizon at the point
 * @param {(t:number)=>number}  [p.dayStart] start of the local day containing t
 */
export function stripModel({ series, coverage = [], domain, width, height, trackX0, trackX1,
                             bandH = 4, isNight = null, dayStart = null }) {
    const x0 = trackX0, x1 = trackX1;
    const plotTop = 1, plotBot = height - bandH - 1;
    const plotH = Math.max(1, plotBot - plotTop);
    const X = (t) => timeToX(t, domain, x0, x1);
    const n = series?.t?.length ?? 0;
    const step = n > 1 ? series.t[1] - series.t[0] : 3_600_000;
    const colW = Math.max(1, (x1 - x0) * step / (domain.t1 - domain.t0));

    // ── provenance band ──────────────────────────────────────────────────
    const bands = [];
    for (const r of coverage) {
        const a = Math.max(r.t0, domain.t0), b = Math.min(r.t1, domain.t1);
        if (!(b >= a)) continue;
        // A single-frame run still gets one column of width.
        const xa = X(a), xb = Math.max(X(b), xa + Math.min(colW, 2));
        bands.push({ x0: xa, x1: xb, y: height - bandH, h: bandH,
                     provenance: r.provenance, stale: !!r.stale, color: BAND_COLORS[r.provenance] ?? 'rgba(160,160,160,0.6)' });
    }

    // ── temperature range over the VISIBLE, non-null samples ─────────────
    const T = series?.values?.t2m, P = series?.values?.precip, Cc = series?.values?.cloudTotal;
    let tMin = Infinity, tMax = -Infinity, have = 0;
    for (let i = 0; i < n; i++) {
        const t = series.t[i];
        if (t < domain.t0 || t > domain.t1) continue;
        const v = T?.[i];
        if (Number.isFinite(v)) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); have++; }
    }
    let range = null;
    if (have > 0) {
        const mid = (tMin + tMax) / 2;
        const span = Math.max(MIN_TEMP_SPAN_C, (tMax - tMin) * 1.15);
        range = { min: mid - span / 2, max: mid + span / 2, dataMin: tMin, dataMax: tMax };
    }
    const Y = (v) => plotTop + (1 - (v - range.min) / (range.max - range.min)) * plotH;

    // ── temperature line, split at gaps, one colour per segment ─────────
    const tempSegs = [];
    let run = null;
    for (let i = 0; i < n; i++) {
        const t = series.t[i];
        const v = T?.[i];
        if (t < domain.t0 || t > domain.t1 || !Number.isFinite(v) || !range) { run = null; continue; }
        const pt = [X(t), Y(v), v];
        if (run) {
            const prev = run[run.length - 1];
            tempSegs.push({ x0: prev[0], y0: prev[1], x1: pt[0], y1: pt[1], color: tempColor((prev[2] + v) / 2) });
        }
        run = run ? (run.push(pt), run) : [pt];
    }

    // ── precip bars + cloud veil ─────────────────────────────────────────
    const precip = [], cloud = [];
    for (let i = 0; i < n; i++) {
        const t = series.t[i];
        if (t < domain.t0 || t > domain.t1) continue;
        const x = X(t) - colW / 2;
        const p = P?.[i];
        if (Number.isFinite(p) && p > 0.05) {
            const h = Math.min(1, Math.sqrt(p / PRECIP_FULL_SCALE_MM_H)) * plotH;
            precip.push({ x, w: colW, y: plotBot - h, h });
        }
        const c = Cc?.[i];
        if (Number.isFinite(c) && c > 5) cloud.push({ x, w: colW, a: Math.min(1, c / 100) });
    }

    // ── night shading (merged runs) ──────────────────────────────────────
    const night = [];
    if (typeof isNight === 'function') {
        let nx = null;
        const nStep = 30 * 60_000;
        for (let t = domain.t0; t <= domain.t1 + nStep; t += nStep) {
            const dark = t <= domain.t1 && isNight(t);
            if (dark && nx == null) nx = X(t);
            if (!dark && nx != null) { night.push({ x0: nx, x1: X(Math.min(t, domain.t1)) }); nx = null; }
        }
    }

    // ── day ticks ────────────────────────────────────────────────────────
    const days = [];
    if (typeof dayStart === 'function') {
        let d = dayStart(domain.t0);
        if (d < domain.t0) d = dayStart(d + 36 * 3_600_000);
        for (let guard = 0; d <= domain.t1 && guard < 64; guard++) {
            days.push({ t: d, x: X(d) });
            d = dayStart(d + 36 * 3_600_000);   // next local midnight, DST-safe
        }
    }
    const pxPerDay = (x1 - x0) * 86_400_000 / (domain.t1 - domain.t0);

    return {
        width, height, trackX0: x0, trackX1: x1, plotTop, plotBot,
        bands, tempSegs, precip, cloud, night, days,
        labelDays: pxPerDay >= 14,
        range,
        colW,
    };
}

/**
 * Plain-language summary of one instant for the tooltip / screen readers.
 * Units: °C with °F, mm/h, %, m/s with the 16-point FROM direction.
 */
export function describeSample(s, provenanceLabel) {
    if (!s) return null;
    const parts = [];
    const v = s.values || {};
    if (Number.isFinite(v.t2m)) parts.push(`${v.t2m.toFixed(1)} °C (${(v.t2m * 9 / 5 + 32).toFixed(0)} °F)`);
    if (Number.isFinite(v.precip)) parts.push(v.precip >= 0.05 ? `precip ${v.precip.toFixed(1)} mm/h` : 'dry');
    if (Number.isFinite(v.cloudTotal)) parts.push(`cloud ${Math.round(v.cloudTotal)} %`);
    if (Number.isFinite(v.wind)) {
        const dir = Number.isFinite(v.windDirDeg) ? ` ${compass16(v.windDirDeg)}` : '';
        parts.push(`wind ${v.wind.toFixed(1)} m/s${dir}`);
    }
    return { line: parts.length ? parts.join(' · ') : 'no data at this hour', source: provenanceLabel ?? '' };
}

const C16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compass16(deg) { return C16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }
