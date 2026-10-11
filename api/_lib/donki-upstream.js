/**
 * donki-upstream.js — the ONE way server code reaches NASA DONKI.
 *
 * CCMC MOVED DONKI on 2026-09-30. The web service now lives at
 * ccmc.gsfc.nasa.gov/DONKI-API/get/<product> (keyless, same query
 * parameters, same JSON, date ranges capped at 60 days). BOTH old hosts —
 * kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get and the api.nasa.gov/DONKI gateway
 * in front of it — now answer HTTP 200 with CCMC's ~58 KB "Announcements"
 * HTML page (measured on a Vercel preview 2026-10-11, both hosts, even for
 * the Gannon 2024 window). Before that the gateway also 404'd and timed
 * out. Every /api/donki/* route therefore returned 503, flux-rope-live.html
 * could never leave its DEMO badge, the aurora cron lost its flux-rope
 * layer, and status.html stayed GREEN because api/health.js only checked
 * for a 200. Nothing errored loudly for eleven days.
 *
 * So: the new host is primary, and the gateway is RACED alongside it as a
 * hedge (NASA may re-point it; today it costs one fast HTML answer). The
 * first VALID JSON wins and the loser is aborted. A 200 that is not JSON
 * counts as a failure of that host, never a result, and the error
 * DESCRIBES it (type, size, visible text) — that description is what
 * diagnosed the migration. The gateway gets NASA_API_KEY; the new host
 * needs none.
 *
 * Errors NEVER carry the request URL: the gateway URL contains the API key,
 * and the aurora cron used to print it into the Vercel logs verbatim.
 */

export const DONKI_HOSTS = Object.freeze([
    Object.freeze({ id: 'ccmc',         base: 'https://ccmc.gsfc.nasa.gov/DONKI-API/get', keyed: false }),
    Object.freeze({ id: 'api.nasa.gov', base: 'https://api.nasa.gov/DONKI',               keyed: true  }),
]);

/** The new host rejects ranges over this (HTTP 400). Every caller is inside it. */
export const DONKI_MAX_RANGE_DAYS = 60;

/** Per-attempt budget. The old CCMC host answered in ~7 s cold (2026-10-11);
 *  the edge runtime must begin its response inside 25 s, and both hosts run
 *  in parallel, so this is the whole upstream wait. */
export const DONKI_TIMEOUT_MS = 15_000;

export function nasaApiKey() {
    return (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
}

/**
 * One-line description of a body that failed to parse: content type, size,
 * and the first visible text with tags stripped and the key redacted. Lets
 * the 503 say WHAT DONKI served (outage page vs empty body) without a URL.
 */
export function describeBody(res, text, apiKey = '') {
    const type = (res.headers?.get?.('content-type') || 'no content-type').split(';')[0];
    if (!text || !text.trim()) return `${type}, empty body`;
    let gist = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (apiKey) gist = gist.split(apiKey).join('[key]');
    gist = gist.replace(/https?:\/\/\S+/g, '[url]').slice(0, 120);
    return `${type}, ${text.length} B: "${gist}"`;
}

/** Build one host's URL. Pure — exported for the node gate. */
export function donkiUrl(host, path, params = {}, apiKey = 'DEMO_KEY') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, String(v));
    if (host.keyed) q.set('api_key', apiKey);
    const qs = q.toString();
    return `${host.base}/${path}${qs ? `?${qs}` : ''}`;
}

/**
 * Fetch one DONKI product from whichever host answers first with JSON.
 * @returns {Promise<{ data: any, host: string }>}
 * @throws Error whose message names each host's failure (never a URL).
 */
export async function fetchDonki(path, params = {}, {
    timeoutMs = DONKI_TIMEOUT_MS,
    apiKey = nasaApiKey(),
    fetchImpl = fetch,
    hosts = DONKI_HOSTS,
} = {}) {
    const controllers = hosts.map(() => new AbortController());
    const attempts = hosts.map(async (host, i) => {
        const timer = setTimeout(() => controllers[i].abort(new Error('timeout')), timeoutMs);
        try {
            let res;
            try {
                res = await fetchImpl(donkiUrl(host, path, params, apiKey), {
                    signal: controllers[i].signal,
                    headers: { Accept: 'application/json', 'User-Agent': 'parkersphysics.com (DONKI relay)' },
                });
            } catch (e) {
                throw new Error(`${host.id} ${controllers[i].signal.aborted ? 'timeout' : 'network error'}`);
            }
            if (!res.ok) throw new Error(`${host.id} HTTP ${res.status}`);
            // Read as text first so a non-JSON answer can be DESCRIBED: an
            // outage page and an empty "no records" body need different fixes.
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch {
                throw new Error(`${host.id} returned non-JSON (${describeBody(res, text, apiKey)})`);
            }
            return { data, host: host.id, i };
        } finally {
            clearTimeout(timer);
        }
    });
    try {
        const win = await Promise.any(attempts);
        controllers.forEach((c, i) => { if (i !== win.i) c.abort(new Error('lost race')); });
        return { data: win.data, host: win.host };
    } catch (agg) {
        const why = (agg?.errors ?? [agg]).map((e) => e?.message ?? String(e)).join('; ');
        throw new Error(`DONKI ${path}: ${why}`);
    }
}
