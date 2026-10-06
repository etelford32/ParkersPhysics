/**
 * Vercel Edge Function: /api/weather/extremes
 *
 * Global extreme-weather watch list — the analysis layer over the 30-day
 * weather_grid_cache archive.
 *
 * The heavy lifting (per-cell percentiles across ~240 sampled frames) runs
 * INSIDE Postgres, hourly, via pg_cron → compute_weather_extremes()
 * (supabase-weather-extremes-migration.sql). This endpoint only reads the
 * latest ~2 KB result row, clusters adjacent flagged cells into events, and
 * attaches human-readable region names.
 *
 * Semantics (mirrors the SQL): a cell is flagged when its CURRENT value
 * crosses its own per-cell 30-day distribution —
 *   sev 1 ≥ p95 · sev 2 ≥ p99 · sev 3 = beyond the 30-day window record
 * with absolute floors so the list reads as human-relevant events
 * (heat ≥ 25 °C, cold ≤ 0 °C, wind ≥ 15 m/s, precip ≥ 2 mm).
 *
 * Response:
 *   {
 *     updated, frame_time, window_days, frames_sampled,
 *     categories: {
 *       heat:   [{ region, lat, lon, value, p95, p99, wmax, mean, sev, cells }],
 *       cold:   [{ region, lat, lon, value, p05, p01, wmin, mean, sev, cells }],
 *       wind:   [{ region, lat, lon, value, p95, p99, wmax, sev, cells }],
 *       precip: [{ region, lat, lon, value, p95, p99, wmax, sev, cells }],
 *     },
 *     summary: { cells, heat_p95_cells, cold_p05_cells, wind_p95_cells,
 *                precip_p95_cells, record_cells },
 *     units: { t:'°C', wind:'m/s', precip:'mm' },
 *   }
 *
 * CDN cache: 15 min (the SQL job refreshes hourly at :20).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { clusterCells } from '../../js/geo-regions.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// Unlike the raw-pipeline readers (grid.js), this table carries derived
// PUBLIC analysis and has an anon SELECT policy (migration
// weather_extremes_public_read) — so the publishable key is a valid
// fallback. That keeps local dev working without the sensitive service
// secret, which `vercel env pull` writes as an empty string.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
    || '';

const CACHE_TTL = 900;    // 15 min
const CACHE_SWR = 300;

// Region labels + clustering live in js/geo-regions.js (shared with the
// Planetary Temperature Lab; api/ is not browser-importable).

// ── Handler ──────────────────────────────────────────────────────────────────

async function readLatest() {
    const url = `${SUPABASE_URL}/rest/v1/weather_extremes_cache` +
                `?select=computed_at,frame_time,window_days,frames_sampled,payload` +
                `&order=computed_at.desc&limit=1`;
    const res = await fetchWithTimeout(url, {
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function handler() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured',
            'SUPABASE_URL / SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY) missing',
            { status: 500 });
    }

    let row;
    try {
        row = await readLatest();
    } catch (err) {
        return jsonError('upstream_unavailable', err.message,
            { status: 503, source: 'Supabase weather_extremes_cache' });
    }

    if (!row) {
        // Fresh deploy before the first hourly pg_cron run — structured,
        // cache-briefly, so clients can show "warming up" rather than error.
        return jsonOk({
            updated: new Date().toISOString(),
            status:  'warming_up',
            hint:    'compute_weather_extremes() has not produced a row yet; the pg_cron job runs hourly at :20',
            categories: { heat: [], cold: [], wind: [], precip: [] },
        }, { maxAge: 60, swr: 60 });
    }

    const p = row.payload ?? {};
    return jsonOk({
        updated:        row.computed_at,
        frame_time:     row.frame_time,
        window_days:    row.window_days,
        frames_sampled: row.frames_sampled,
        categories: {
            heat:   clusterCells(p.heat),
            cold:   clusterCells(p.cold),
            wind:   clusterCells(p.wind),
            precip: clusterCells(p.precip),
        },
        summary: p.summary ?? {},
        units:   p.units   ?? { t: '°C', wind: 'm/s', precip: 'mm' },
        method:  'per-cell percentile vs 30-day archive; sev 1=p95, 2=p99, 3=window record',
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
