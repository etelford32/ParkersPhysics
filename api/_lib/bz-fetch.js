/**
 * api/_lib/bz-fetch.js — the bounded JSON fetch the Bz engine's routes hand to
 * js/bz/feeds.js `runFeed`. One copy: /api/bz/feeds and /api/bz/l1 both use it.
 * A 200 that is not JSON is an error page (the DONKI lesson) and is a miss.
 */
import { fetchWithTimeout } from './responses.js';

export async function fetchJson(url) {
    let res;
    try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: 9000 });
    } catch (e) {
        return { ok: false, status: null, error: String(e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? e)).slice(0, 120) };
    }
    const contentType = res.headers.get('content-type');
    if (!res.ok) return { ok: false, status: res.status, contentType, error: `HTTP ${res.status}` };
    let body;
    try { body = await res.json(); }
    catch { return { ok: false, status: res.status, contentType, error: 'not JSON' }; }
    return { ok: true, status: res.status, contentType, body };
}
