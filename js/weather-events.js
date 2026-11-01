/**
 * weather-events.js — what is worth a marker on the time bar, for one place.
 *
 * EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §6.3. PURE: no DOM, no fetch, no
 * ambient time. Input is a WeatherCube series for the selected place
 * (hourly, gaps = NaN) plus optional sky functions; output is a list of
 * dated events the strip draws as clickable markers.
 *
 * What it finds, and the rule for each (every threshold is a named constant):
 *
 *   rain-start  hourly precip rises to ≥ RAIN_ON mm/h after ≥ DRY_HOURS
 *               dry hours (< RAIN_OFF). Detail: the spell's peak + length.
 *   rain-stop   precip falls below RAIN_OFF after a spell of ≥ WET_HOURS.
 *   wind-peak   the strongest hour of each local day, if ≥ WIND_NOTABLE.
 *               This is the 10 m MEAN wind — the cube has no gust channel,
 *               and the label says "wind", never "gust".
 *   freeze      2 m temperature crosses below 0 °C after ≥ WARM_HOURS ≥ 0.
 *   aurora      the start of each run of hours where verdict-engine's ONE
 *               aurora rule (auroraVerdict: margin ≤ 5°, clouds < 60 %, sun
 *               below −12°) says GO, from the Kp forecast for that hour.
 *               Past the forecast's reach Kp is UNKNOWN and nothing is
 *               marked — never a quiet-sky default (the day-view rule).
 *
 * Held / missing hours (NaN) break every run: a gap is neither dry nor wet.
 */

import { auroraVerdict } from './verdict-engine.js';

export const RAIN_ON      = 0.2;    // mm/h — measurable rain
export const RAIN_OFF     = 0.1;    // mm/h — hysteresis floor
export const DRY_HOURS    = 2;
export const WET_HOURS    = 1;
export const WIND_NOTABLE = 10;     // m/s — Beaufort 5–6, "strong breeze"
export const WARM_HOURS   = 3;
export const AURORA_DARK_DEG = -12; // astronomical-ish darkness (verdict-engine's)

/** Display priority when markers crowd (higher wins a contested pixel). */
export const EVENT_PRIORITY = Object.freeze({
    aurora: 5, freeze: 4, 'rain-start': 3, 'wind-peak': 2, 'rain-stop': 1,
});

const HOUR_MS = 3_600_000;

/**
 * @param {{ t: Float64Array, values: { precip?, t2m?, wind?, cloudTotal? } }} series
 * @param {object} [o]
 * @param {(t:number)=>number} [o.dayStart]   local midnight for the day containing t
 * @param {(t:number)=>number} [o.sunAltDeg]  sun altitude at the place (deg)
 * @param {(t:number)=>(number|null)} [o.kpAt] Kp for the hour, null when unknown
 * @param {number} [o.magLat]                 the place's magnetic latitude (deg)
 * @returns {{ t:number, type:string, label:string, detail:string, priority:number }[]}
 */
export function detectEvents(series, { dayStart = null, sunAltDeg = null, kpAt = null, magLat = null } = {}) {
    const out = [];
    const t = series?.t;
    const n = t?.length ?? 0;
    if (!n) return out;
    const P = series.values?.precip, T = series.values?.t2m, W = series.values?.wind, C = series.values?.cloudTotal;
    const fin = Number.isFinite;

    // ── rain spells ──────────────────────────────────────────────────────
    if (P) {
        let dry = 0, wet = false, start = -1, peak = 0;
        for (let i = 0; i < n; i++) {
            const p = P[i];
            if (!fin(p)) {            // a gap breaks the spell AND the dry run
                if (wet) closeSpell(i - 1);
                wet = false; dry = 0; continue;
            }
            if (!wet) {
                if (p >= RAIN_ON && dry >= DRY_HOURS) { wet = true; start = i; peak = p; }
                else if (p < RAIN_OFF) dry++;
                else dry = 0;          // drizzle between the thresholds: not dry, not a start
            } else {
                peak = Math.max(peak, p);
                if (p < RAIN_OFF) { closeSpell(i); wet = false; dry = 1; }
            }
        }
        if (wet) closeSpell(-1);       // still raining at the window's end
        function closeSpell(endIdx) {
            const hours = endIdx < 0 ? n - start : endIdx - start;
            out.push(ev(t[start], 'rain-start', 'Rain starts',
                `peaks ${peak.toFixed(1)} mm/h${endIdx < 0 ? ' · ongoing at the end of the window' : ` · ${hours} h`}`));
            if (endIdx >= 0 && hours >= WET_HOURS) out.push(ev(t[endIdx], 'rain-stop', 'Rain ends', `after ${hours} h`));
        }
    }

    // ── strongest wind of each local day ─────────────────────────────────
    if (W && typeof dayStart === 'function') {
        let day = null, best = -1, bestI = -1;
        const flush = () => {
            if (bestI >= 0 && best >= WIND_NOTABLE) {
                out.push(ev(t[bestI], 'wind-peak', `Wind ${best.toFixed(0)} m/s`,
                    `strongest hour of the day (10 m mean wind, not gusts)`));
            }
        };
        for (let i = 0; i < n; i++) {
            const d = dayStart(t[i]);
            if (d !== day) { flush(); day = d; best = -1; bestI = -1; }
            if (fin(W[i]) && W[i] > best) { best = W[i]; bestI = i; }
        }
        flush();
    }

    // ── freezes ──────────────────────────────────────────────────────────
    if (T) {
        let warm = 0;
        for (let i = 0; i < n; i++) {
            const v = T[i];
            if (!fin(v)) { warm = 0; continue; }
            if (v >= 0) { warm++; continue; }
            if (warm >= WARM_HOURS) {
                let low = v;
                for (let j = i; j < n && fin(T[j]) && T[j] < 0; j++) low = Math.min(low, T[j]);
                out.push(ev(t[i], 'freeze', 'Below freezing', `low ${low.toFixed(1)} °C`));
            }
            warm = 0;
        }
    }

    // ── aurora windows (dark, clear enough, oval in reach) ───────────────
    if (typeof kpAt === 'function' && typeof sunAltDeg === 'function' && fin(magLat)) {
        let inRun = false;
        for (let i = 0; i < n; i++) {
            const kp = kpAt(t[i]);
            const alt = sunAltDeg(t[i]);
            const cloud = C ? C[i] : NaN;
            let go = false, verdict = null;
            if (fin(kp) && fin(alt) && alt < AURORA_DARK_DEG && fin(cloud)) {
                verdict = auroraVerdict(kp, magLat, cloud, alt);
                go = verdict.state === 'go';
            }
            if (go && !inRun) {
                out.push(ev(t[i], 'aurora', 'Aurora window',
                    `Kp ${kp.toFixed(1)} · cloud ${Math.round(cloud)} % · oval ${verdict.margin <= 0 ? 'overhead' : `${verdict.margin.toFixed(0)}° poleward`}`));
            }
            inRun = go;
        }
    }

    return out.sort((a, b) => a.t - b.t || b.priority - a.priority);
}

function ev(t, type, label, detail) {
    return { t, type, label, detail, priority: EVENT_PRIORITY[type] ?? 0 };
}

/**
 * Kp lookup over SWPC's 3-hourly product rows ({time_tag, kp_index}): the bin
 * that CONTAINS t (time_tag is the bin start). Outside the rows' span → null,
 * which detectEvents treats as unknown. Pure.
 */
export function kpLookup(rows) {
    const bins = [];
    for (const r of rows ?? []) {
        const t0 = r?.time_tag instanceof Date ? r.time_tag.getTime() : Date.parse(r?.time_tag);
        const kp = Number(r?.kp_index ?? r?.kp);
        if (Number.isFinite(t0) && Number.isFinite(kp)) bins.push([t0, kp]);
    }
    bins.sort((a, b) => a[0] - b[0]);
    return (t) => {
        let lo = 0, hi = bins.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (bins[m][0] <= t) lo = m + 1; else hi = m; }
        const i = lo - 1;
        if (i < 0 || t >= bins[i][0] + 3 * HOUR_MS) return null;
        return bins[i][1];
    };
}
