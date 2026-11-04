/**
 * api/_lib/weather-cell-stats.js — the daily per-cell 30-day percentile pass,
 * ported out of Postgres. PURE (no fetch, no ambient time).
 *
 * SUPABASE_OFFLOAD_PLAN.md Phase A2. Until 2026-11 this was
 * public.compute_weather_cell_stats(), which needs 30 days of 170 kB JSONB
 * frames IN Postgres. Once the frames live in R2 (Phase B) the database keeps
 * only the last day, so the pass has to run where the frames are:
 * api/cron/weather-cell-stats.js reads them from R2 and calls this, then
 * writes the result into public.weather_cell_stats (stats_source = 'r2')
 * through replace_weather_cell_stats(). The hourly compute_weather_extremes()
 * is unchanged and still joins the newest frame to that table.
 *
 * MIRRORS THE SQL, on purpose, so the cutover does not move a single flag:
 *
 *   - FRAME SELECTION (selectStatsFrames) is what the SQL pass would have
 *     seen: the frames trim_weather_grid_cache() kept (hourly for the last
 *     72 h before the newest frame, 3-hourly — UTC hour % 3 == 0 — older,
 *     nothing older than newest − 30 d), within now − window, EXCLUDING the
 *     newest (so "beats the window max" stays a record). R2 holds every
 *     hourly frame from the cutover on; reading all of them would quietly
 *     change the sample the percentiles are taken over.
 *   - VALUES are float4: the SQL casts `->>'temperature_2m'` to real, so a
 *     value is Math.fround(Number(text)) here. JSON null / missing → null,
 *     skipped by every aggregate (as SQL aggregates skip NULL).
 *   - percentile_cont is Postgres's: position p·(n−1) in the sorted sample,
 *     linear between the neighbours, in double precision. avg is the double
 *     mean of the float4 values. tests/r2-offload.mjs pins both against
 *     numbers Postgres itself returned.
 *   - CELLS are keyed by round(lat, 2) / round(lon, 2), half AWAY from zero
 *     like numeric round — never by array position.
 */

export const WINDOW_DAYS = 30;
export const HOURLY_TAIL_H = 72;
export const DECIMATE_EVERY_H = 3;

const H = 3_600_000;

/** Postgres numeric round(x, 2): half away from zero. */
export function round2(x) {
    const s = Math.sign(x);
    return s * Math.round(Math.abs(x) * 100) / 100;
}

/** (text or number) → float4 or null, as `(...)::real` does. */
export function toReal(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.fround(n) : null;
}

/** Postgres percentile_cont over an ASCENDING array of numbers. */
export function percentileCont(sorted, p) {
    const n = sorted.length;
    if (n === 0) return null;
    const pos = p * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values) {
    if (!values.length) return null;
    let s = 0;
    for (const v of values) s += v;
    return s / values.length;
}

/**
 * Which archived frames the SQL pass would have used. `frames` is a list of
 * { fetched_at } (any extra fields ride along); `newestMs` is the newest
 * frame in the system (it is excluded); `nowMs` anchors the window.
 */
export function selectStatsFrames(frames, { newestMs, nowMs, windowDays = WINDOW_DAYS }) {
    const out = [];
    for (const f of frames) {
        const t = Date.parse(f.fetched_at);
        if (!Number.isFinite(t)) continue;
        if (t >= newestMs) continue;                          // history excludes the newest
        if (t <= nowMs - windowDays * 24 * H) continue;       // fetched_at > now() - window
        if (t < newestMs - 30 * 24 * H) continue;             // trim: nothing older than newest - 30 d
        const inTail = t > newestMs - HOURLY_TAIL_H * H;
        const onDecimatedHour = new Date(t).getUTCHours() % DECIMATE_EVERY_H === 0;
        if (inTail || onDecimatedHour) out.push(f);
    }
    return out.sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at));
}

/** How many frames a fully-archived window holds (the coverage gate's denominator). */
export function expectedStatsFrames(windowDays = WINDOW_DAYS) {
    return HOURLY_TAIL_H + Math.floor((windowDays * 24 - HOURLY_TAIL_H) / DECIMATE_EVERY_H);
}

/**
 * Accumulator: feed it frames one at a time (so a 30-day pass never holds
 * 288 parsed payloads at once), then call rows().
 */
export function createCellAccumulator() {
    const cells = new Map();   // "lat|lon" → { lat, lon, t:[], w:[], pr:[] }
    let frames = 0;
    return {
        addFrame(payload) {
            if (!Array.isArray(payload)) return;
            frames++;
            for (const c of payload) {
                const latRaw = toReal(c?.latitude);
                const lonRaw = toReal(c?.longitude);
                // numeric round of the JSON TEXT, not of a float4 — use the raw number.
                const lat = c?.latitude == null ? null : round2(Number(c.latitude));
                const lon = c?.longitude == null ? null : round2(Number(c.longitude));
                if (latRaw === null || lonRaw === null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                const k = `${lat}|${lon}`;
                let cell = cells.get(k);
                if (!cell) { cell = { lat, lon, t: [], w: [], pr: [] }; cells.set(k, cell); }
                const cur = c.current ?? {};
                const t = toReal(cur.temperature_2m);
                const w = toReal(cur.wind_speed_10m);
                const pr = toReal(cur.precipitation);
                if (t !== null) cell.t.push(t);
                if (w !== null) cell.w.push(w);
                if (pr !== null) cell.pr.push(pr);
            }
        },
        get frames() { return frames; },
        rows() {
            const asc = (a, b) => a - b;
            const out = [];
            for (const c of cells.values()) {
                const t = c.t.slice().sort(asc);
                const w = c.w.slice().sort(asc);
                const pr = c.pr.slice().sort(asc);
                out.push({
                    lat: c.lat, lon: c.lon,
                    n_t: t.length,
                    t_mean: mean(c.t),
                    t_p01: percentileCont(t, 0.01),
                    t_p05: percentileCont(t, 0.05),
                    t_p95: percentileCont(t, 0.95),
                    t_p99: percentileCont(t, 0.99),
                    t_min: t.length ? t[0] : null,
                    t_max: t.length ? t[t.length - 1] : null,
                    w_p95: percentileCont(w, 0.95),
                    w_p99: percentileCont(w, 0.99),
                    w_max: w.length ? w[w.length - 1] : null,
                    pr_p95: percentileCont(pr, 0.95),
                    pr_p99: percentileCont(pr, 0.99),
                    pr_max: pr.length ? pr[pr.length - 1] : null,
                });
            }
            return out.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
        },
    };
}
