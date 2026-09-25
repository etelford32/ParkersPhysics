/**
 * climate-lab/lab-watches.js — "lab watches": forecast conditions a user asks
 * the lab to keep an eye on at the home station (gusts over X in the next
 * 24 h, rain chance over Y, AQI over Z…).
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE and node-gated. WHAT A WATCH IS, and is not — the console prints this
 * next to the controls, because the difference matters to the reader:
 *   · It is evaluated IN THE BROWSER against the same station forecast the
 *     instruments draw, every time the lab refreshes (≈ 15 min), and shows
 *     its state on the dashboard (and, opt-in, as a browser notification
 *     while the tab is open).
 *   · It is NOT an emailed alert. There is no server-side sender for wind,
 *     rain, UV, AQI or visibility thresholds (surveyed 2026-09-24: the only
 *     terrestrial email is the daily digest, which has no thresholds), and
 *     the lab adds no schema. The account's emailed alerts are the existing
 *     notify_* columns, edited in the same console, and labelled as such.
 *
 * The comparison runs in SI on the kernel's units; thresholds are STORED in
 * SI too (lab-prefs.js WATCH_KINDS), so switching °F↔°C never moves a
 * threshold — only its label.
 */

import { WATCH_KINDS } from './lab-prefs.js';

const HOUR = 3_600_000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Hourly series for a watch metric: [{t, v}] within (now, now + horizon]. */
function metricSeries(metric, obs, air, nowMs, horizonMs) {
    const H = obs?.hourly;
    const inWin = (t) => isNum(t) && t > nowMs && t <= nowMs + horizonMs;
    const from = (key) => (H?.t || []).map((t, i) => ({ t, v: H[key]?.[i] })).filter((p) => inWin(p.t) && isNum(p.v));
    switch (metric) {
        case 'tempMax': case 'tempMin': return from('tempC');
        case 'gustMax': return from('gustMs');
        case 'popMax': return from('pop');
        case 'precipSum': return from('precipMm');
        case 'uvMax': return from('uvi');
        case 'visMin': return from('visM');
        case 'aqiMax':
            return (Array.isArray(air?.aqiHourly) ? air.aqiHourly : [])
                .map((p) => ({ t: p?.time, v: p?.aqi })).filter((p) => inWin(p.t) && isNum(p.v));
        default: return [];
    }
}

/**
 * Evaluate one watch.
 * @returns {{ id, kind, state:'clear'|'triggered'|'nodata', value:number|null,
 *             at:number|null, firstAt:number|null }}
 *   value/at — the window's extreme (or the sum, for precipSum);
 *   firstAt  — the first hour the condition is met (triggered only).
 */
export function evaluateWatch(watch, obs, { nowMs, air = null } = {}) {
    const kind = WATCH_KINDS[watch?.kind];
    const base = { id: watch?.id, kind: watch?.kind, state: 'nodata', value: null, at: null, firstAt: null };
    if (!kind || !isNum(nowMs) || !isNum(watch.threshold)) return base;
    const series = metricSeries(kind.metric, obs, air, nowMs, (watch.horizonH || 24) * HOUR);
    if (!series.length) return base;

    const meets = (v) => (kind.cmp === '>=' ? v >= watch.threshold : v <= watch.threshold);
    if (kind.metric === 'precipSum') {
        let sum = 0, firstAt = null;
        for (const p of series) { sum += p.v; if (firstAt == null && sum >= watch.threshold) firstAt = p.t; }
        return { ...base, state: sum >= watch.threshold ? 'triggered' : 'clear', value: sum, at: series[series.length - 1].t, firstAt };
    }
    let ext = series[0], firstAt = null;
    for (const p of series) {
        if (kind.cmp === '>=' ? p.v > ext.v : p.v < ext.v) ext = p;
        if (firstAt == null && meets(p.v)) firstAt = p.t;
    }
    return { ...base, state: firstAt != null ? 'triggered' : 'clear', value: ext.v, at: ext.t, firstAt };
}

/** Evaluate every enabled watch. Disabled watches report state 'off'. */
export function evaluateWatches(watches, obs, opts) {
    return (watches || []).map((w) => (w?.on ? evaluateWatch(w, obs, opts)
        : { id: w?.id, kind: w?.kind, state: 'off', value: null, at: null, firstAt: null }));
}

/**
 * Which triggered watches are NEW since the last evaluation — the only ones
 * worth a browser notification. `seen` is a Set of `${id}@${firstAtHour}`
 * keys the caller persists for the session, so a watch that stays triggered
 * across refreshes notifies once, and a NEW episode (a later first hour)
 * notifies again.
 */
export function newlyTriggered(results, seen) {
    const out = [];
    for (const r of results || []) {
        if (r.state !== 'triggered' || !isNum(r.firstAt)) continue;
        const key = `${r.id}@${Math.floor(r.firstAt / HOUR)}`;
        if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    return out;
}
