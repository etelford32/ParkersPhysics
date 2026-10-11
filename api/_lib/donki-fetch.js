/**
 * donki-fetch.js — ONE way to read NASA DONKI from the server, with a
 * fallback host and an honest diagnosis when an upstream answers with
 * something that is not DONKI JSON.
 *
 * WHY (production, 2026-09-30 → 2026-10-11): api.nasa.gov started answering
 * the DONKI paths with an HTML page. `res.ok` was true, so every caller went
 * straight to `res.json()` and died on `Unexpected token '<'` — the daily
 * validation ledger (all four CME models, flux-rope included) locked nothing
 * for 11 days and the only trace was that parse error in the cron log.
 *
 * DONKI is CCMC's service; api.nasa.gov is a key-gated gateway in front of
 * it. CCMC also serves the same JSON directly at
 * kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/<path> with no key (api/health.js
 * already probes that host), so it is the natural second source. Each
 * attempt must return a JSON ARRAY (every DONKI list endpoint does) — a 200
 * HTML body is classified as a failure with its <title> in the reason, and
 * the next host is tried. The result self-reports which host answered, so
 * a quietly-degraded gateway shows up in telemetry instead of in a parser.
 *
 * Pure apart from the injected `fetchImpl` — tests/donki-fetch.mjs drives
 * it with fake responses; no network.
 */

export const DONKI_HOSTS = Object.freeze([
    { id: 'api.nasa.gov', base: 'https://api.nasa.gov/DONKI', needsKey: true },
    { id: 'ccmc', base: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get', needsKey: false },
]);

/** Build the request URL for one host. Dates are YYYY-MM-DD. */
export function donkiUrl(host, path, { startDate, endDate, apiKey, params = {} } = {}) {
    const q = new URLSearchParams();
    if (startDate) q.set('startDate', startDate);
    if (endDate) q.set('endDate', endDate);
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    if (host.needsKey) q.set('api_key', apiKey || 'DEMO_KEY');
    return `${host.base}/${path}?${q.toString()}`;
}

/** Explain a non-JSON body in one short line (never the whole page). */
export function describeBody(text, contentType = '') {
    const t = String(text ?? '');
    const title = /<title[^>]*>([^<]{0,120})/i.exec(t)?.[1]?.trim();
    if (title) return `HTML page "${title}"`;
    if (/^\s*</.test(t)) return `HTML/XML body (${contentType || 'no content-type'})`;
    const head = t.trim().slice(0, 60).replace(/\s+/g, ' ');
    return head ? `non-JSON body "${head}"` : 'empty body';
}

/**
 * Fetch one DONKI list endpoint (e.g. 'CMEAnalysis', 'FLR',
 * 'WSAEnlilSimulations'), trying each host in order.
 * Returns { ok: true, data: [...], host, attempts } or
 *         { ok: false, error, attempts } — never throws.
 * `attempts` is [{ host, status?, reason? }] for telemetry.
 */
export async function fetchDonki(path, {
    startDate, endDate, apiKey, params,
    fetchImpl = globalThis.fetch,
    timeoutMs = 12_000,
    hosts = DONKI_HOSTS,
} = {}) {
    const attempts = [];
    for (const host of hosts) {
        const url = donkiUrl(host, path, { startDate, endDate, apiKey, params });
        let res;
        try {
            res = await fetchImpl(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            attempts.push({ host: host.id, reason: `network: ${String(e?.message || e).slice(0, 80)}` });
            continue;
        }
        const ct = res.headers?.get?.('content-type') ?? '';
        const text = await res.text().catch(() => '');
        if (!res.ok) {
            attempts.push({ host: host.id, status: res.status, reason: `HTTP ${res.status}: ${describeBody(text, ct)}` });
            continue;
        }
        // DONKI answers an empty window with an empty BODY on some paths,
        // not with "[]" — that is a valid "nothing happened", not a failure.
        if (text.trim() === '') {
            attempts.push({ host: host.id, status: res.status });
            return { ok: true, data: [], host: host.id, attempts };
        }
        let data;
        try { data = JSON.parse(text); } catch {
            attempts.push({ host: host.id, status: res.status, reason: describeBody(text, ct) });
            continue;
        }
        if (!Array.isArray(data)) {
            // A gateway error object ({ error: { code: 'OVER_RATE_LIMIT' } })
            // parses fine and is still not DONKI.
            const code = data?.error?.code ?? data?.error ?? data?.msg ?? 'object';
            attempts.push({ host: host.id, status: res.status, reason: `JSON but not a list (${String(code).slice(0, 60)})` });
            continue;
        }
        attempts.push({ host: host.id, status: res.status });
        return { ok: true, data, host: host.id, attempts };
    }
    return {
        ok: false,
        error: `DONKI ${path}: ` + attempts.map((a) => `${a.host} ${a.reason ?? a.status}`).join(' | '),
        attempts,
    };
}
