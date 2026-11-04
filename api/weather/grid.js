/**
 * Vercel Edge Function: /api/weather/grid
 *
 * Public reader for Supabase's weather_grid_cache (648/2592-location
 * Open-Meteo snapshots). Two modes:
 *
 *   GET /api/weather/grid
 *     → newest row only. Single-frame shape (back-compat with the
 *       live-fetch path in js/weather-feed.js).
 *
 *   GET /api/weather/grid?since=<ISO-8601>&limit=<N>
 *     → range mode. Returns { frames: [...], count, since } with
 *       up to N frames newer than the `since` instant, oldest first.
 *       Used by the cold-start backfill in WeatherFeed.backfill() so
 *       the 24-h replay slider has data the first time the page loads,
 *       not just after 24 hours of session lifetime.
 *
 *       limit defaults to 24 and is capped at 72 (the table's
 *       retention; see supabase-weather-cache-migration.sql).
 *
 * Cache strategy (two layers, single mode):
 *   1. Vercel Edge CDN fronts this route with s-maxage=3600 (live mode)
 *      or s-maxage=300 (range mode — shorter because the response is
 *      large and per-`since` query keys consume more cache slots).
 *      Once a POP has served one response, every subsequent visitor
 *      in that region with the same query gets cached bytes — zero DB
 *      hits, zero upstream calls.
 *   2. Supabase persists rows so a cold POP (or redeploy) still serves
 *      fresh data without waiting for the next refresh tick.
 *
 * stale-while-revalidate keeps a stale copy serving while the CDN
 * refreshes in the background.
 *
 * Refresher: the Vercel cron api/cron/refresh-weather-grid.js — hourly,
 * sole writer (2592-pt grid; scheduled in vercel.json). It REPLACED the
 * Supabase pg_cron writer described in supabase-weather-pgcron-migration.sql
 * (648-pt, kept only as history). Staleness is surfaced to the UI via the
 * `age_seconds` field on responses so a silent cron failure is visible
 * to visitors within one reload.
 *
 * Single-frame response shape (consumed by js/weather-feed.js):
 *   {
 *     source:      "open-meteo:72x36",          // optional :WxH grid suffix
 *     fetched_at:  "2025-…Z",
 *     age_seconds: 1234,
 *     grid:        { w: 72, h: 36, deg: 5 },    // null for legacy rows
 *     freshness:   "live" | "stale",            // "stale" = a FALLBACK upstream
 *     note?:       "fallback-source: …",        // present only when stale
 *     pressure_kind: "msl" | "surface" | null,  // what channel P means (below)
 *     data:        [ { current: { temperature_2m, … } }, … ]   // 2592 items
 *   }
 *
 * `pressure_kind` (2026-10-26): the cron now requests `pressure_msl`; rows
 * written before that carry `surface_pressure`, which for the MET Norway
 * fallback was ALREADY mean sea-level pressure under the wrong name and for
 * Open-Meteo was true station pressure. js/weather-decode.js pressureKindOf
 * is the ONE reader of that distinction; the client never blends a
 * 'surface' frame into the MSLP ring (PRESSURE_OUTLOOK_ENGINE_PLAN.md P1).
 * It is derived from the UNTRIMMED payload, because range mode strips the
 * per-location `__pressure_kind` tag.
 *
 * `freshness` is about the SOURCE, not the age (age is `age_seconds`). A frame
 * from the MET Norway safety net is 648 points at 10° bilinear-upsampled to
 * 72×36, and it is a 200 like any other, so without this flag status.html
 * scored it healthy for a month (js/pipeline-registry.js `isFallbackSource`,
 * the ONE copy of the rule). CLAUDE.md §8: a route that degrades to a fallback
 * says `freshness: 'stale'`.
 *
 * Range response shape:
 *   {
 *     since:  "2025-…Z",
 *     count:  24,
 *     frames: [ { source, fetched_at, age_seconds, grid, data }, … ]
 *   }
 *
 * The `grid` object is parsed out of the `source` column's `:WxH` suffix the
 * cron writer attaches (see api/cron/refresh-weather-grid.js). For older rows
 * written by the previous cron build the suffix is absent — frontend infers
 * dims from data.length in that case.
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role (bypasses RLS)
 */

import { jsonOk, jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';
import { isFallbackSource } from '../../js/pipeline-registry.js';
import { pressureKindOf } from '../../js/weather-decode.js';
import { R2_CONFIGURED, getGzText, mapLimit, planRangeSources } from '../_lib/r2-archive.js';

export const config = { runtime: 'edge' };

// Accept both the server-only naming (SUPABASE_URL / SUPABASE_SERVICE_KEY)
// and Supabase/Vercel's current convention (NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SECRET_KEY — "secret key" replaced "service_role key" in
// Supabase's 2024 rename). This removes a whole class of "I set the var
// but it still 500s" bugs on fresh deploys.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const CACHE_TTL = 3600;   // 1 hour — matches pg_cron cadence (live mode)
const CACHE_SWR = 600;    // serve stale up to 10 min while refreshing

// Range-mode caching is shorter because each unique `since` becomes its
// own cache key. Five minutes balances "many users on the same page-
// load instant share a cache" against "table retention is only 72 h, so
// stale rows aren't useful past a brief window".
const RANGE_MAX_AGE = 300;
const RANGE_SWR     = 60;

// Hard cap on range-query limit. The binding constraint is the Edge
// response-body ceiling (~4 MB compressed), NOT retention: trimmed frames
// gzip to ~60 KB each, so 72 frames ≈ 4.3 MB — already at the limit.
// (Retention is 30 days DECIMATED since supabase-storage-reclaim-
// migration.sql, 2026-09-19: hourly for the last 72 h, 3-hourly older.
// So a range read inside 72 h is hourly exactly as before — only a
// `since` reaching past 3 days returns a 3-hourly series. Raising this
// cap requires paginating the response, not just editing the constant.)
const RANGE_MAX_LIMIT     = 72;
const RANGE_DEFAULT_LIMIT = 24;

async function readLatest() {
    const url = `${SUPABASE_URL}/rest/v1/weather_grid_cache` +
                `?select=fetched_at,source,payload` +
                `&order=fetched_at.desc&limit=1`;
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

/**
 * Range read — rows newer than `sinceISO`, oldest first, capped at
 * `limit`. Returns [] when the table has no qualifying rows; throws on
 * Supabase HTTP errors so the handler can map to a uniform 503.
 */
async function readRange(sinceISO, limit) {
    const url = `${SUPABASE_URL}/rest/v1/weather_grid_cache` +
                `?select=fetched_at,source,payload` +
                `&fetched_at=gte.${encodeURIComponent(sinceISO)}` +
                `&order=fetched_at.asc` +
                `&limit=${limit}`;
    const res = await fetchWithTimeout(url, {
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
}

async function sbJson(path) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    return res.json();
}

/**
 * Range read across BOTH stores (SUPABASE_OFFLOAD_PLAN.md Phase B). Used
 * only when R2 is configured; otherwise readRange above is the whole story,
 * unchanged.
 *
 * Postgres keeps ~24 h of frames once the archive is warm; every frame
 * api/cron/archive-sweep.js has copied is indexed in weather_grid_archive.
 * So: list the instants each store holds at/after `since` (timestamps only —
 * a few KB, not payloads), take the first `limit` of their union, read the
 * indexed ones from R2 and only the not-yet-archived ones (the newest hour,
 * or the backlog while the backfill drains) from Postgres. An R2 read that
 * fails falls back to Postgres if the row is still there; a frame neither
 * store can produce is dropped and counted, never invented.
 *
 * Same rows out as readRange: { fetched_at, source, payload }, ascending.
 */
async function readRangeHybrid(sinceISO, limit) {
    const since = encodeURIComponent(sinceISO);
    const [dbT, idx] = await Promise.all([
        sbJson(`weather_grid_cache?select=fetched_at&fetched_at=gte.${since}&order=fetched_at.asc&limit=${limit}`),
        sbJson(`weather_grid_archive?select=fetched_at,r2_key&fetched_at=gte.${since}&order=fetched_at.asc&limit=${limit}`),
    ]);
    const keyByMs = new Map(idx.map(r => [Date.parse(r.fetched_at), r.r2_key]));
    const plan = planRangeSources(dbT.map(r => r.fetched_at), idx.map(r => r.fetched_at), limit);

    const byMs = new Map();
    await mapLimit(plan.filter(p => p.from === 'r2'), 12, async (p) => {
        try {
            const text = await getGzText(keyByMs.get(Date.parse(p.fetched_at)));
            if (text) byMs.set(Date.parse(p.fetched_at), JSON.parse(text));
        } catch { /* falls back to Postgres below */ }
    });
    const fromDb = plan.filter(p => !byMs.has(Date.parse(p.fetched_at)) && (p.from === 'db' || p.dbAlso));
    if (fromDb.length) {
        const list = fromDb.map(p => `"${p.fetched_at}"`).join(',');
        const rows = await sbJson(`weather_grid_cache?select=fetched_at,source,payload` +
            `&fetched_at=in.(${encodeURIComponent(list)})&order=fetched_at.asc`);
        for (const r of rows) byMs.set(Date.parse(r.fetched_at), r);
    }
    const rows = [];
    let r2 = 0, db = 0, missing = 0;
    for (const p of plan) {
        const row = byMs.get(Date.parse(p.fetched_at));
        if (!row) { missing++; continue; }
        rows.push(row);
        if (p.from === 'r2' && !fromDb.includes(p)) r2++; else db++;
    }
    return { rows, store: { r2, db, missing } };
}

/**
 * The 9 fields js/weather-feed.js _extractCoarse consumes. Range mode
 * trims the upstream payload to just these so the multi-frame response
 * stays well under Vercel Edge's response-body limit (~4 MB compressed).
 *
 * Field set MUST stay in lockstep with NUM_COARSE_CHANNELS in
 * weather-feed.js — adding a new client-consumed channel means adding
 * the field both here and in _extractCoarse.
 */
const RANGE_KEEP_FIELDS = [
    'temperature_2m',
    // Both pressure keys: `pressure_msl` is what the cron writes since
    // 2026-10-26; `surface_pressure` is kept so older MET Norway rows (MSLP
    // under the legacy name) still decode. The top-level `pressure_kind`
    // says which one a frame means — see projectRow.
    'pressure_msl',
    'surface_pressure',
    'relative_humidity_2m',
    'wind_speed_10m',
    'wind_direction_10m',
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'precipitation',
];

/**
 * Strip unused fields from each location's `current` block. Single
 * mode keeps full payloads for back-compat with frontends that may
 * read fields we don't list here; range mode trims because the gain
 * is meaningful at 24× frame multiplicity:
 *
 *   full upstream:  ~700 KB / frame  →  ~17 MB / 24 frames
 *   trimmed:        ~300 KB / frame  →   ~7 MB / 24 frames
 *   gzipped:                          →   ~1.5 MB on the wire
 */
function trimRowForRange(payload) {
    if (!Array.isArray(payload)) return payload;
    return payload.map(loc => {
        const c = loc?.current;
        if (!c) return { current: null };
        const trimmed = {};
        for (const k of RANGE_KEEP_FIELDS) trimmed[k] = c[k];
        return { current: trimmed };
    });
}

/**
 * Project a Supabase row into the wire shape both modes share. Single
 * mode returns one of these; range mode returns an array of them under
 * `frames`. Centralising the projection keeps the two paths in lockstep
 * — when the cron writer adds a new field (e.g. precip), both modes
 * pick it up by extending only this function.
 *
 * @param {object} row             — Supabase row (fetched_at/source/payload)
 * @param {boolean} [trim=false]   — strip payload to client-needed fields only
 */
function projectRow(row, trim = false) {
    const fetchedMs = Date.parse(row.fetched_at);
    const ageSec    = Number.isFinite(fetchedMs)
        ? Math.max(0, Math.floor((Date.now() - fetchedMs) / 1000))
        : null;

    // Source format: "<provider>" or "<provider>:<W>x<H>" — the grid
    // suffix the cron writer adds when it knows the resolution. Old
    // rows lack the suffix; clients fall back to inferring W,H from
    // data.length.
    const rawSource = row.source ?? 'open-meteo';
    let grid = null;
    const m = /:(\d+)x(\d+)$/.exec(rawSource);
    if (m) {
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            grid = { w, h, deg: 180 / h };
        }
    }
    const fallback = isFallbackSource('weather_grid', row.source);
    return {
        source:      rawSource,
        fetched_at:  row.fetched_at,
        age_seconds: ageSec,
        grid,
        freshness:   fallback ? 'stale' : 'live',
        ...(fallback ? { note: `fallback-source: ${rawSource} (the primary upstream failed for this frame)` } : {}),
        // Read off the first location BEFORE trimming (header note).
        pressure_kind: Array.isArray(row.payload) ? pressureKindOf(row.payload[0]) : null,
        data:        trim ? trimRowForRange(row.payload) : row.payload,
    };
}

export default async function handler(request) {
    // Explicit per-var reporting so an operator hitting the endpoint in a
    // browser (or the frontend's devtools Network tab) sees exactly which
    // env var Vercel is missing in the current environment — no more "why
    // is it 500?" detective work. Cache this briefly so a misconfigured
    // environment doesn't get hammered on every pageview.
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
    if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY)');
    if (missing.length) {
        return Response.json({
            error:   'supabase_not_configured',
            missing,
            hint:    'Vercel → Project Settings → Environment Variables → Production. Add missing vars, redeploy.',
        }, {
            status: 500,
            headers: {
                'Cache-Control': `public, s-maxage=60`,
                ...CORS_HEADERS,
            },
        });
    }

    // Branch on query string. `since` present → range mode; else single
    // newest row (existing back-compat path).
    const url    = new URL(request.url);
    const since  = url.searchParams.get('since');
    if (since) {
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) {
            return jsonError('bad_since',
                `since=${since} is not a valid ISO timestamp`,
                { status: 400, maxAge: 60 });
        }
        // Clamp limit to [1, RANGE_MAX_LIMIT] — silently rather than
        // 400ing on a too-large value, since the result is just "you
        // asked for 100, here's 72".
        const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(RANGE_MAX_LIMIT, rawLimit)
            : RANGE_DEFAULT_LIMIT;

        let rows, store;
        try {
            const sinceIso = new Date(sinceMs).toISOString();
            if (R2_CONFIGURED) {
                // The bulk payload egress leaves Supabase (Phase B). A
                // failure of the hybrid read itself (index table missing in
                // an environment that never ran the migration) degrades to
                // the plain Postgres read rather than to an error.
                try { ({ rows, store } = await readRangeHybrid(sinceIso, limit)); }
                catch { rows = await readRange(sinceIso, limit); }
            } else {
                rows = await readRange(sinceIso, limit);
            }
        } catch (e) {
            return jsonError('cache_unavailable', e.message,
                { source: 'supabase/weather_grid_cache' });
        }

        const frames = rows.map(r => projectRow(r, /* trim */ true));
        return jsonOk({ since, count: frames.length, frames, ...(store ? { store } : {}) },
            { maxAge: RANGE_MAX_AGE, swr: RANGE_SWR });
    }

    // Single-frame mode (default).
    let row;
    try {
        row = await readLatest();
    } catch (e) {
        return jsonError('cache_unavailable', e.message,
            { source: 'supabase/weather_grid_cache' });
    }
    if (!row) {
        // Cache never populated yet — shorten TTL so clients retry quickly
        // once the first refresh (pg_cron or Vercel daily) completes.
        return jsonError('cache_empty', 'weather_grid_cache is empty', {
            source: 'supabase/weather_grid_cache',
            maxAge: 30,
        });
    }

    return jsonOk(projectRow(row), { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
