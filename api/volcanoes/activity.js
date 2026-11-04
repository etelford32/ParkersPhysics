/**
 * api/volcanoes/activity.js — Vercel edge function: which volcanoes are
 * active RIGHT NOW (the live half of the Earth Volcanoes engine).
 *
 * The catalogue (data/volcanoes/volcanoes-catalog.json, GVP lists of 22 Mar
 * 2026) knows what erupted up to its download; this route says what is
 * happening today:
 *   USGS HANS  elevated US volcanoes, aviation colour + alert level, joined
 *              to the catalogue by GVP number;
 *   NASA EONET open volcano events worldwide, joined by position client-side.
 * Normalizers + candidate field lists: api/_lib/volcano-activity.js.
 *
 * Never a 5xx: a dead upstream answers 200 + `freshness:'stale'` + `reasons`
 * + a `note`, so status.html scores it amber and the layer says "live status
 * unavailable" instead of drawing a quiet planet. CDN cache 30 min (HANS
 * notices are event-driven; EONET curates ~daily).
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    HANS_URLS, EONET_URL, parseHansElevated, parseEonetVolcanoes, composeActivity,
} from '../_lib/volcano-activity.js';

export const config = { runtime: 'edge' };

async function getJson(url) {
    const res = await fetchWithTimeout(url, { timeoutMs: 12_000, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    // an HTML maintenance page on a 200 is a failure, not data (the DONKI scar)
    if (!/json/i.test(type) && !/^\s*[[{]/.test(text)) throw new Error(`non-JSON answer (${type || 'no content-type'})`);
    return JSON.parse(text);
}

async function loadHans(nowMs) {
    const tried = [];
    let lastErr = 'no candidate answered';
    for (const url of HANS_URLS) {
        tried.push(url);
        try {
            const parsed = parseHansElevated(await getJson(url), nowMs);
            return { ok: true, url, tried, ...parsed };
        } catch (e) { lastErr = `${url.replace(/^https:\/\/[^/]+/, '')}: ${e?.message ?? e}`; }
    }
    return { ok: false, tried, error: lastErr };
}

async function loadEonet(nowMs) {
    try { return { ok: true, ...parseEonetVolcanoes(await getJson(EONET_URL), nowMs) }; }
    catch (e) { return { ok: false, error: e?.message ?? 'unknown' }; }
}

export default async function handler() {
    const nowMs = Date.now();
    const [hans, eonet] = await Promise.all([loadHans(nowMs), loadEonet(nowMs)]);
    const body = composeActivity({ hans, eonet, nowMs });
    return jsonOk(body, body.freshness === 'live' ? { maxAge: 1800, swr: 300 } : { maxAge: 300, swr: 60 });
}
