/**
 * Vercel Node Cron: /api/cron/bz-archive — every 6 hours at :20 (vercel.json)
 *
 * The ONE writer of the Bz engine's minute archive (BZ_ENGINE_PLAN.md §21):
 * every L1 spacecraft separately (field, plasma, position) and each GOES
 * magnetometer, one R2 object per UTC day. It exists because the first
 * archive hindcast (§20) could test only the Dst model — the site kept one
 * merged L1 stream and no GOES magnetometer history.
 *
 * Each run: fetch the four feeds through js/bz/feeds.js (the ONE catalogue +
 * normaliser), split their rows by UTC day, and for each day touched
 * GET → merge → PUT (js/bz/archive.js; a PUT happens only when the merge
 * added or changed something). Then the index object is rewritten.
 *
 * WHY EVERY 6 HOURS: SWPC's one-minute L1 files hold about 24 hours, so a
 * daily run would lose the minutes around its own hour. Four overlapping
 * runs a day means one failed run loses nothing. GOES comes from the 7-day
 * files, so the first run back-fills a week of GOES.
 *
 * Nothing here touches Postgres except the heartbeat ('bz_archive'). With the
 * R2 secrets unset it records a failed heartbeat (r2_not_configured) and
 * writes nothing. A feed that is down is named in the response and in the
 * heartbeat; the other streams are still archived.
 *
 * Auth: x-vercel-cron, or Authorization: Bearer ${CRON_SECRET}.
 * Query: ?dry=1 reports what would be written without writing.
 */
import { fetchWithTimeout } from '../_lib/responses.js';
import { R2_CONFIGURED, putGzText, getGzText } from '../_lib/r2-archive.js';
import { fetchJson } from '../_lib/bz-fetch.js';
import { runFeed } from '../../js/bz/feeds.js';
import { STREAMS, splitByDay, mergeDay, updateIndex, dayKey, INDEX_KEY } from '../../js/bz/archive.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';
export const PIPELINE = 'bz_archive';
const BUDGET_MS = 45_000;

function readHeader(request, name) {
    const h = request?.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return h.get(name) ?? '';
    return h[name.toLowerCase()] ?? '';
}
function isAuthorized(request) {
    if (readHeader(request, 'x-vercel-cron')) return true;
    return !!CRON_SECRET && readHeader(request, 'authorization') === `Bearer ${CRON_SECRET}`;
}
function queryParam(request, name) {
    try { return new URL(request.url, 'http://local').searchParams.get(name); } catch { return null; }
}
async function rpc(name, args) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', timeoutMs: 10_000,
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (!res.ok) throw new Error(`rpc ${name} ${res.status}`);
}

/**
 * The run, with every side effect injected (tests/bz-archive.mjs drives it with an in-memory store).
 * @param {{ nowMs:number, dry?:boolean, fetchJson:Function, get:(key:string)=>Promise<string|null>, put:(key:string, text:string)=>Promise<any>, budgetMs?:number }} deps
 */
export async function archiveRun({ nowMs, dry = false, fetchJson: fj, get, put, budgetMs = BUDGET_MS, clock = () => Date.now() }) {
    const started = clock();
    const feedIds = [...new Set(Object.values(STREAMS).map((s) => s.feed))];
    const feeds = {}, feedReport = {};
    await Promise.all(feedIds.map(async (id) => {
        try {
            const r = await runFeed(id, { fetchJson: fj, nowMs });
            feeds[id] = r.data; feedReport[id] = r.data ? (r.source_id ?? 'ok') : `down: ${(r.reasons ?? []).join(',') || 'no data'}`;
        } catch (e) { feeds[id] = null; feedReport[id] = `down: ${String(e?.message ?? e).slice(0, 80)}`; }
    }));
    const byDay = splitByDay(feeds);
    const days = Object.keys(byDay).sort();
    const out = { ok: true, dry, feeds: feedReport, days: {}, written: 0, unchanged: 0, skipped_for_time: [] };
    const docs = [];
    for (const day of days) {
        if (clock() - started > budgetMs) { out.skipped_for_time.push(day); continue; }
        const key = dayKey(day);
        let existing = null;
        const text = await get(key);              // a read failure THROWS: never overwrite a day we could not read
        if (text) existing = JSON.parse(text);
        const { doc, added, changed, kept } = mergeDay(existing, day, byDay[day], { nowMs });
        out.days[day] = { added, changed, kept_over_null: kept, summary: Object.fromEntries(Object.entries(doc.summary).map(([s, ids]) => [s, Object.fromEntries(Object.entries(ids).map(([id, v]) => [id, v.valid]))])) };
        if (!added && !changed && existing) { out.unchanged++; continue; }
        if (!dry) await put(key, JSON.stringify(doc));
        out.written++; docs.push(doc);
    }
    if (docs.length && !dry) {
        const idxText = await get(INDEX_KEY);
        await put(INDEX_KEY, JSON.stringify(updateIndex(idxText ? JSON.parse(idxText) : null, docs, { nowMs })));
    }
    const down = Object.entries(feedReport).filter(([, v]) => String(v).startsWith('down')).map(([k]) => k);
    out.feeds_down = down;
    if (!days.length) { out.ok = false; out.reason = 'no_feed_returned_data'; }
    return out;
}

async function run(request) {
    if (!isAuthorized(request)) return { status: 401, body: { error: 'unauthorized' } };
    if (!R2_CONFIGURED) {
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: 'r2_not_configured: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET' }); } catch { /* heartbeat best-effort */ }
        return { status: 503, body: { ok: false, reason: 'r2_not_configured' } };
    }
    const dry = queryParam(request, 'dry') === '1';
    let out;
    try {
        out = await archiveRun({ nowMs: Date.now(), dry, fetchJson, get: (k) => getGzText(k), put: (k, t) => putGzText(k, t) });
    } catch (e) {
        const reason = String(e?.message ?? e).slice(0, 300);
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: reason }); } catch { /* best-effort */ }
        return { status: 502, body: { ok: false, reason } };
    }
    if (!dry) {
        try {
            if (!out.ok) await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: out.reason });
            else {
                // A partial run is recorded as a failure FIRST, then a success, so the reason is kept and the streak ends at 0 (the weather-grid rule).
                if (out.feeds_down.length) await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: `feeds down: ${out.feeds_down.join(', ')}` });
                await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: `days +${out.written} (${out.unchanged} unchanged)${out.feeds_down.length ? ` · partial: ${out.feeds_down.join(',')} down` : ''}` });
            }
        } catch { /* heartbeat best-effort */ }
    }
    return { status: out.ok ? 200 : 502, body: out };
}

// Node runtime hands (req, res); dev-server and tests hand a Request.
export default async function handler(req, res) {
    const { status, body } = await run(req);
    if (res && typeof res.status === 'function') { res.status(status).json(body); return; }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
