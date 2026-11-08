/**
 * glacier-weather.js — the daily DRIVERS of a glacier: temperature and snowfall at the
 * glacier's own altitude, from Open-Meteo (browser-direct, CORS, the app's weather source).
 *
 * Split PURE / IO: `weatherUrls`, `parseWeather`, `degreeDays`, `seasonCompare` are pure
 * and node-gated; `loadGlacierWeather` is the only function that fetches.
 *
 * WHAT IT IS: for each gauge (upper / middle / lower glacier, js/glacier-engine.js
 * `gauges`) one request location at the gauge's GLO-30 elevation — Open-Meteo applies
 * its lapse-rate correction to the `elevation=` given, so the temperature is the air at
 * that altitude, not at the coarse model grid's mean height. Two calls:
 *   ARCHIVE  (ERA5 reanalysis, ~5-day lag): from the start of the hydrological year
 *            TEN years ago up to 6 days ago — the comparison years AND this year so far;
 *   FORECAST (past 7 days + 16 days ahead): closes the archive's lag and adds the outlook.
 *
 * WHAT IT IS NOT: a mass balance. Positive degree-days (Σ max(T̄_day, 0), °C·d) are the
 * standard melt DRIVER of a temperature-index model; turning them into metres of ice needs
 * a per-glacier calibrated melt factor (GLACIER_WATCH_PLAN.md §5, P4), so the page shows
 * PDD and snowfall as drivers and says so. ERA5 at 0.25° over steep terrain carries known
 * biases; comparing THIS year with the SAME source's previous years cancels most of them.
 */

export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const COMPARE_YEARS = 10;
export const ARCHIVE_LAG_DAYS = 6;
const DAY = 864e5;
const DAILY = 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum';

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Hydrological-year start (Oct 1 N / Apr 1 S) on or before tMs. */
export function hydroStart(tMs, lat) {
    const d = new Date(tMs), y = d.getUTCFullYear(), m = d.getUTCMonth(), sm = lat >= 0 ? 9 : 3;
    return Date.UTC(m >= sm ? y : y - 1, sm, 1);
}

/** The two URLs for a set of points [{lat, lon, elev}] at `nowMs`. */
export function weatherUrls(points, nowMs, lat0 = points[0].lat) {
    const loc = `latitude=${points.map(p => p.lat.toFixed(4)).join(',')}&longitude=${points.map(p => p.lon.toFixed(4)).join(',')}`
        + `&elevation=${points.map(p => Math.round(p.elev)).join(',')}`;
    const start = hydroStart(nowMs, lat0);
    const aStart = Date.UTC(new Date(start).getUTCFullYear() - COMPARE_YEARS, new Date(start).getUTCMonth(), 1);
    const aEnd = nowMs - ARCHIVE_LAG_DAYS * DAY;
    return {
        archive: `${ARCHIVE_URL}?${loc}&start_date=${ymd(aStart)}&end_date=${ymd(aEnd)}&daily=${DAILY}&timezone=UTC`,
        forecast: `${FORECAST_URL}?${loc}&daily=${DAILY}&past_days=7&forecast_days=16&timezone=UTC`,
        hydroStartMs: start, archiveStartMs: aStart, archiveEndMs: aEnd,
    };
}

/** Open-Meteo answers one object for one location and an array for several; normalise to an array. */
function asList(j) { return Array.isArray(j) ? j : [j]; }

/**
 * Merge archive + forecast into one daily record per point. Forecast days REPLACE archive
 * days only where the archive has no value (the archive is the better analysis where both
 * exist); days after `nowMs` are flagged `forecast`.
 * → [{ elevModel, days: [{ t, tmean, tmax, tmin, precip, snow, forecast }] }]
 */
export function parseWeather(archiveJson, forecastJson, nowMs) {
    const A = asList(archiveJson || []), F = asList(forecastJson || []);
    const n = Math.max(A.length, F.length);
    const out = [];
    const today = Math.floor(nowMs / DAY) * DAY;
    for (let k = 0; k < n; k++) {
        const map = new Map();
        const add = (j, src) => {
            const d = j?.daily;
            if (!d?.time) return;
            for (let i = 0; i < d.time.length; i++) {
                const t = Date.parse(d.time[i] + 'T00:00:00Z');
                const row = { t, tmean: d.temperature_2m_mean?.[i] ?? null, tmax: d.temperature_2m_max?.[i] ?? null, tmin: d.temperature_2m_min?.[i] ?? null,
                    precip: d.precipitation_sum?.[i] ?? null, snow: d.snowfall_sum?.[i] ?? null, src };
                if (row.tmean === null && row.tmax !== null && row.tmin !== null) row.tmean = (row.tmax + row.tmin) / 2;
                const prev = map.get(t);
                if (!prev || (prev.tmean === null && row.tmean !== null)) map.set(t, row);
            }
        };
        add(A[k], 'archive'); add(F[k], 'forecast');
        const days = [...map.values()].sort((a, b) => a.t - b.t).map(r => ({ ...r, forecast: r.t > today }));
        out.push({ elevModel: A[k]?.elevation ?? F[k]?.elevation ?? null, days });
    }
    return out;
}

/** Cumulative positive degree-days and snowfall (cm) over [fromMs, toMs]; nulls are SKIPPED and counted. */
export function degreeDays(days, fromMs, toMs) {
    let pdd = 0, snow = 0, n = 0, missing = 0;
    const series = [];
    for (const d of days) {
        if (d.t < fromMs || d.t > toMs) continue;
        if (d.tmean === null || !Number.isFinite(d.tmean)) missing++;
        else { pdd += Math.max(0, d.tmean); n++; }
        if (Number.isFinite(d.snow)) snow += d.snow;
        series.push({ t: d.t, pdd, snow });
    }
    return { pdd, snow, n, missing, series };
}

/**
 * This hydrological year so far vs the same day-of-season in each of the previous
 * COMPARE_YEARS years (same source, same point): rank and the comparison values.
 * Only observed days count for "this year" (forecast days excluded).
 */
export function seasonCompare(days, nowMs, lat) {
    const start = hydroStart(nowMs, lat);
    const lastObs = days.filter(d => !d.forecast && Number.isFinite(d.tmean)).reduce((m, d) => Math.max(m, d.t), -Infinity);
    const upto = Math.min(nowMs, lastObs);
    const span = upto - start;
    const now = degreeDays(days, start, upto);
    const past = [];
    for (let y = 1; y <= COMPARE_YEARS; y++) {
        const s = Date.UTC(new Date(start).getUTCFullYear() - y, new Date(start).getUTCMonth(), 1);
        const r = degreeDays(days, s, s + span);
        if (r.n >= 0.9 * Math.round(span / DAY)) past.push({ year: new Date(s).getUTCFullYear() + 1, pdd: r.pdd, snow: r.snow });
    }
    const rankPdd = 1 + past.filter(p => p.pdd > now.pdd).length;
    const rankSnow = 1 + past.filter(p => p.snow > now.snow).length;
    const mean = (k) => past.length ? past.reduce((a, p) => a + p[k], 0) / past.length : NaN;
    return { startMs: start, uptoMs: upto, days: Math.round(span / DAY), pdd: now.pdd, snow: now.snow, past, rankPdd, rankSnow, of: past.length + 1, meanPdd: mean('pdd'), meanSnow: mean('snow') };
}

/** IO: both calls; either failing leaves the other's days and says which failed. */
export async function loadGlacierWeather(points, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
    const u = weatherUrls(points, nowMs);
    const get = async (url) => { const r = await fetchImpl(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
    const [a, f] = await Promise.allSettled([get(u.archive), get(u.forecast)]);
    const failed = [a.status === 'rejected' && 'archive', f.status === 'rejected' && 'forecast'].filter(Boolean);
    const points_ = parseWeather(a.value, f.value, nowMs);
    return { urls: u, failed, points: points_ };
}
