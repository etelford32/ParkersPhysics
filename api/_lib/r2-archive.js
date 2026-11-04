/**
 * api/_lib/r2-archive.js — the ONE copy of how bulk data lives in R2.
 *
 * SUPABASE_OFFLOAD_PLAN.md Phases B + C. Two kinds of object, both gzip,
 * both written ONLY by api/cron/archive-sweep.js:
 *
 *   weather/grid/YYYY/MM/DD/<iso>.json.gz   one weather_grid_cache ROW
 *                                           ({ fetched_at, source, payload })
 *   datasets/sw-geomag/YYYY/MM/DD.ndjson.gz one sealed UTC day of
 *                                           sw_geomag_dataset, one PostgREST
 *                                           row per line, exactly as select=*
 *                                           returned it
 *
 * THE INDEX IS THE TRUTH, NOT THE BUCKET. Each object has a row in
 * public.weather_grid_archive / public.sw_geomag_archive written AFTER the
 * PUT succeeded, so "indexed" implies "in R2". The Postgres trims delete a
 * frame / a day ONLY when its index row exists (supabase-r2-offload-
 * migration.sql), which is what makes every step of this safe to deploy with
 * the R2 secrets unset: nothing is indexed, so nothing is ever deleted that
 * is not somewhere else.
 *
 * Objects are stored as raw gzip bytes (content-type application/gzip, NO
 * content-encoding) and decompressed explicitly. With content-encoding: gzip
 * some fetch implementations decompress transparently and some do not; an
 * explicit DecompressionStream behaves the same in the Edge runtime and in
 * Node 18+, so one helper serves both the Edge readers and the Node crons.
 *
 * The bucket is private. Readers fetch through a short-lived presigned URL
 * from the SERVER side and the public sees our routes' CDN-cached responses
 * — "served through the CDN" means Vercel's edge cache in front of the
 * existing endpoints, not a public bucket.
 */

import { putObject, getSignedUrl, R2_CONFIGURED } from './r2-client.js';

export { R2_CONFIGURED };

export const WEATHER_PREFIX = 'weather/grid/';
export const SW_GEOMAG_PREFIX = 'datasets/sw-geomag/';

const pad2 = n => String(n).padStart(2, '0');

/** Object key for one weather frame. Millisecond ISO, ':' made key-safe. */
export function weatherFrameKey(fetchedAt) {
    const d = new Date(fetchedAt);
    if (!Number.isFinite(d.getTime())) throw new Error(`bad fetched_at: ${fetchedAt}`);
    const iso = d.toISOString().replace(/:/g, '-');
    return `${WEATHER_PREFIX}${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${iso}.json.gz`;
}

/** Object key for one sealed UTC day ('YYYY-MM-DD'). */
export function swGeomagDayKey(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day: ${day}`);
    const [y, m, d] = day.split('-');
    return `${SW_GEOMAG_PREFIX}${y}/${m}/${d}.ndjson.gz`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function streamBytes(stream) {
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}

export async function gzipText(text) {
    const src = new Blob([enc.encode(text)]).stream();
    return streamBytes(src.pipeThrough(new CompressionStream('gzip')));
}

export async function gunzipText(bytes) {
    const src = new Blob([bytes]).stream();
    return dec.decode(await streamBytes(src.pipeThrough(new DecompressionStream('gzip'))));
}

export async function sha256Hex(bytes) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** NDJSON (one JSON value per non-empty line) → array. */
export function parseNdjson(text) {
    const out = [];
    for (const line of text.split('\n')) if (line.trim()) out.push(JSON.parse(line));
    return out;
}

export function toNdjson(rows) {
    return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Gzip + PUT. Returns what the index row needs. Throws on any failure so the
 * caller never writes an index row for an object that is not there.
 */
export async function putGzText(key, text, metadata = {}) {
    const gz = await gzipText(text);
    const sha256 = await sha256Hex(gz);
    const res = await putObject(key, gz, {
        contentType: 'application/gzip',
        cacheControl: 'private, max-age=31536000, immutable',
        metadata: { sha256, ...metadata },
    });
    if (!res?.ok) throw new Error(`r2 put ${key}: HTTP ${res?.status}`);
    return { key, bytes: gz.byteLength, sha256 };
}

/**
 * GET + gunzip. Returns null on 404 (an index row whose object is gone is a
 * READ miss, never a crash: callers fall back to Postgres or report it).
 */
export async function getGzText(key, { timeoutMs = 10_000 } = {}) {
    const url = await getSignedUrl(key, { expiresIn: 300 });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctl.signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`r2 get ${key}: HTTP ${res.status}`);
        return gunzipText(new Uint8Array(await res.arrayBuffer()));
    } finally {
        clearTimeout(timer);
    }
}

/** Run async fn over items with at most `limit` in flight; keeps order. */
export async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * Plan a weather range read across the two stores. PURE.
 *
 * dbTimes / idxTimes: fetched_at strings present in weather_grid_cache and
 * in weather_grid_archive at or after `since`. Returns the first `limit`
 * instants (ascending) with where each should be read from: R2 when indexed
 * (that is the whole point: the bulk payload egress leaves Supabase), else
 * Postgres. Instants are compared by MILLISECOND so the two stores' text
 * spellings of one timestamp cannot be taken for two frames.
 */
export function planRangeSources(dbTimes, idxTimes, limit) {
    const byMs = new Map();
    for (const t of dbTimes)  { const ms = Date.parse(t); if (Number.isFinite(ms) && !byMs.has(ms)) byMs.set(ms, { fetched_at: t, from: 'db' }); }
    for (const t of idxTimes) { const ms = Date.parse(t); if (Number.isFinite(ms)) byMs.set(ms, { fetched_at: t, from: 'r2', dbAlso: byMs.has(ms) }); }
    return [...byMs.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, v]) => v);
}

// ── sw_geomag_dataset day helpers (PURE) ──────────────────────────────────

/** UTC days ('YYYY-MM-DD') overlapping [startMs, endMs). */
export function utcDaysCovering(startMs, endMs) {
    const days = [];
    let d = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), new Date(startMs).getUTCDate());
    for (; d < endMs; d += 86_400_000) days.push(new Date(d).toISOString().slice(0, 10));
    return days;
}

export function utcDayOf(t) {
    return new Date(t).toISOString().slice(0, 10);
}

/**
 * Days in [startMs, endMs) that Postgres returned NO rows for — the ones to
 * look for in R2. A day is all-in-Postgres or all-in-R2 because the trim
 * deletes whole sealed days (and gap minutes are rows, so a stored day is
 * never partially present).
 */
export function daysMissingFrom(rows, startMs, endMs) {
    const have = new Set(rows.map(r => utcDayOf(r.t)));
    return utcDaysCovering(startMs, endMs).filter(d => !have.has(d));
}

/** Merge two t-sorted row lists into one ascending list, de-duplicated by instant (first list wins). */
export function mergeByT(primary, secondary) {
    const seen = new Set(primary.map(r => Date.parse(r.t)));
    const out = primary.concat(secondary.filter(r => !seen.has(Date.parse(r.t))));
    return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}
