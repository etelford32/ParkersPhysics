/**
 * Vercel Edge Function: /api/bz/archive[?day=YYYY-MM-DD]
 *
 * Read access to the Bz engine's minute archive (BZ_ENGINE_PLAN.md §21;
 * written only by api/cron/bz-archive.js, format in js/bz/archive.js).
 *
 *   GET /api/bz/archive                  → the index: one line per archived UTC day
 *   GET /api/bz/archive?day=2026-11-20   → that day's document (every L1 spacecraft
 *                                          and GOES satellite, per-instant rows)
 *
 * There is no passthrough: the only caller-supplied value is a validated UTC
 * day, and the object key is rebuilt from it.
 *
 * Never a 5xx for a missing archive:
 *   R2 secrets unset     → 200 + freshness:'expired' + reasons:['r2_not_configured']
 *   no run yet           → 200 + freshness:'expired' + reasons:['no_archive_yet']
 *   day not archived     → 200 + data:null + reasons:['day_not_archived']
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { R2_CONFIGURED, getGzText } from '../_lib/r2-archive.js';
import { INDEX_KEY, dayKey, isDay, archiveFreshness } from '../../js/bz/archive.js';

export const config = { runtime: 'edge' };

/** Exported for tests: the route with its store injected. */
export async function respond({ day, configured, get, nowMs }) {
    const base = { source: 'Bz engine minute archive (R2) · js/bz/archive.js', model: 'bz-archive-v1' };
    if (day != null && !isDay(day)) return { ...base, error: 'day must be YYYY-MM-DD (UTC)', status: 400 };
    if (!configured) return { ...base, freshness: 'expired', reasons: ['r2_not_configured'], data: null };
    let index = null;
    try { const t = await get(INDEX_KEY); if (t) index = JSON.parse(t); }
    catch (e) { return { ...base, freshness: 'expired', reasons: ['archive_read_failed'], note: String(e?.message ?? e).slice(0, 120), data: null }; }
    const f = archiveFreshness(index, nowMs);
    if (!day) return { ...base, freshness: f.freshness, reasons: f.reasons, age_seconds: f.age_s, data: index ? { updated: index.updated, ...index } : null };
    let doc = null;
    try { const t = await get(dayKey(day)); if (t) doc = JSON.parse(t); }
    catch (e) { return { ...base, freshness: 'expired', reasons: ['archive_read_failed'], note: String(e?.message ?? e).slice(0, 120), data: null }; }
    if (!doc) return { ...base, freshness: f.freshness, reasons: [...f.reasons, 'day_not_archived'], data: null };
    return { ...base, freshness: f.freshness, reasons: f.reasons, data: doc };
}

export default async function handler(req) {
    const url = new URL(req.url);
    const body = await respond({ day: url.searchParams.get('day'), configured: R2_CONFIGURED, get: (k) => getGzText(k), nowMs: Date.now() });
    if (body.status === 400) return jsonError('bad_request', body.error, { status: 400 });
    // A past day never changes once the GOES 7-day window has moved on; the index and recent days are short-lived.
    return jsonOk(body, { maxAge: 300, swr: 60 });
}
