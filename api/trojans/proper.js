/**
 * Vercel Edge Function: /api/trojans/proper  (optional ?meta=1)
 *
 * AstDyS's synthetic proper elements for the Jupiter Trojans, relayed as
 * compact rows — the EXTERNAL validation set for our own frequency-analysed
 * proper libration amplitude (js/trojan-dynamics.js `properLibration`,
 * scripts/compare-astdys.mjs). Parsing and the unverified-layout story live in
 * api/_lib/astdys-proper.js.
 *
 * Normal mode walks the frozen candidate URLs in order and parses the first
 * that answers with data. `?meta=1` probes ALL candidates in parallel and
 * returns each one's status, byte count and first lines (no rows) — the one
 * request that settles which path and layout production actually sees.
 *
 * Never 5xx: a total miss is 200 + freshness:'stale' + degraded_reason. Cache
 * a week — AstDyS recomputes proper elements a few times a year.
 */
import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { ASTDYS_CANDIDATES, parseSyn, composeProperResponse } from '../_lib/astdys-proper.js';

export const config = { runtime: 'edge' };

const TIMEOUT_MS = 12_000;
const WEEK = 7 * 86_400;

async function fetchText(url) {
    try {
        const res = await fetchWithTimeout(url, { headers: { Accept: 'text/plain, */*' }, timeoutMs: TIMEOUT_MS });
        if (!res.ok) return { url, ok: false, status: res.status, reason: `HTTP ${res.status}` };
        const text = await res.text();
        return { url, ok: true, status: res.status, text };
    } catch (e) {
        return { url, ok: false, status: 0, reason: `unreachable: ${e.message || 'fetch failed'}` };
    }
}

export default async function handler(request) {
    const meta = new URL(request.url).searchParams.get('meta') === '1';
    if (meta) {
        const all = await Promise.all(ASTDYS_CANDIDATES.map(fetchText));
        const candidates = all.map(r => {
            if (!r.ok) return { url: r.url, ok: false, status: r.status, reason: r.reason };
            const p = parseSyn(r.text);
            return { url: r.url, ok: p.ok, status: r.status, bytes: r.text.length, rows: p.count,
                header_line: p.header_line ?? null, field_map: p.field_map ?? {}, lib_unit: p.lib_unit ?? null,
                reason: p.ok ? null : p.reason, first_lines: r.text.split(/\r?\n/).slice(0, 8) };
        });
        return jsonOk({ source: 'astdys', meta: true, generated_at: new Date().toISOString(), candidates }, { maxAge: 300, swr: 600 });
    }
    const attempts = [];
    for (const url of ASTDYS_CANDIDATES) {
        const r = await fetchText(url);
        if (!r.ok) { attempts.push(`${url}: ${r.reason}`); continue; }
        const parsed = parseSyn(r.text);
        if (!parsed.ok) { attempts.push(`${url}: ${parsed.reason}`); continue; }
        const body = composeProperResponse({ parsed, source: url, attempts });
        return jsonOk(body, { maxAge: WEEK, swr: WEEK });
    }
    const body = composeProperResponse({ parsed: { ok: false, reason: `no candidate answered with data (${attempts.length} tried)` }, attempts });
    return jsonOk(body, { maxAge: 300, swr: 600 });
}
