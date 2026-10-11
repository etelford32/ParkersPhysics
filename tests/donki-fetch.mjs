// donki-fetch.mjs — gate for api/_lib/donki-fetch.js (fake fetch, no network)
//
//   node tests/donki-fetch.mjs
//
// The scenario that took the validation ledger down 2026-09-30 → 10-11:
// api.nasa.gov answered 200 with an HTML page and every caller died in
// res.json(). The fetcher must classify that, say what the page was, and
// fall through to CCMC's own DONKI host.

import { fetchDonki, donkiUrl, describeBody, DONKI_HOSTS } from '../api/_lib/donki-fetch.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const resp = (status, body, ct = 'application/json') => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    text: async () => body,
});
const fakeFetch = (byHost) => {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        const host = new URL(url).host;
        const r = byHost[host];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(url) : r;
    };
    fn.calls = calls;
    return fn;
};
const CME = [{ associatedCMEID: '2026-10-01T00:00:00-CME-001', time21_5: '2026-10-01T03:00Z', speed: 800 }];
const opts = { startDate: '2026-09-25', endDate: '2026-10-11', apiKey: 'K' };

// URLs
check('url: gateway carries the key, CCMC does not',
    donkiUrl(DONKI_HOSTS[0], 'CMEAnalysis', opts).includes('api_key=K')
    && !donkiUrl(DONKI_HOSTS[1], 'CMEAnalysis', opts).includes('api_key'));
check('url: CCMC path is /DONKI/WS/get/<path>',
    donkiUrl(DONKI_HOSTS[1], 'FLR', opts)
        .startsWith('https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/FLR?startDate=2026-09-25'));

// Happy path: gateway answers, CCMC never called.
{
    const f = fakeFetch({ 'api.nasa.gov': resp(200, JSON.stringify(CME)) });
    const r = await fetchDonki('CMEAnalysis', { ...opts, fetchImpl: f });
    check('gateway ok → data from api.nasa.gov, one request',
        r.ok && r.host === 'api.nasa.gov' && r.data.length === 1 && f.calls.length === 1);
}
// THE production failure: 200 + HTML.
{
    const html = '<!DOCTYPE html><html><head><title>API Maintenance</title></head><body>…</body></html>';
    const f = fakeFetch({
        'api.nasa.gov': resp(200, html, 'text/html'),
        'kauai.ccmc.gsfc.nasa.gov': resp(200, JSON.stringify(CME)),
    });
    const r = await fetchDonki('CMEAnalysis', { ...opts, fetchImpl: f });
    check('200 + HTML from the gateway → falls back to CCMC',
        r.ok && r.host === 'ccmc' && r.data[0].speed === 800);
    check('…and the attempt log names the page instead of a parse error',
        r.attempts[0].reason === 'HTML page "API Maintenance"', r.attempts[0].reason);
}
// Gateway rate-limit object (valid JSON, not a list).
{
    const f = fakeFetch({
        'api.nasa.gov': resp(200, JSON.stringify({ error: { code: 'OVER_RATE_LIMIT' } })),
        'kauai.ccmc.gsfc.nasa.gov': resp(200, '[]'),
    });
    const r = await fetchDonki('FLR', { ...opts, fetchImpl: f });
    check('JSON error object is not DONKI → fallback, reason carries the code',
        r.ok && r.host === 'ccmc' && /OVER_RATE_LIMIT/.test(r.attempts[0].reason));
}
// Empty body = an empty window, not a failure.
{
    const f = fakeFetch({ 'api.nasa.gov': resp(200, '') });
    const r = await fetchDonki('WSAEnlilSimulations', { ...opts, fetchImpl: f });
    check('empty body → ok with [] (quiet Sun is not an outage)',
        r.ok && Array.isArray(r.data) && r.data.length === 0 && f.calls.length === 1);
}
// Everything down → never throws, error lists every host.
{
    const f = fakeFetch({
        'api.nasa.gov': resp(503, 'Service Unavailable', 'text/plain'),
        'kauai.ccmc.gsfc.nasa.gov': new Error('getaddrinfo ENOTFOUND'),
    });
    let threw = false, r;
    try { r = await fetchDonki('CMEAnalysis', { ...opts, fetchImpl: f }); } catch { threw = true; }
    check('all hosts down → resolves ok:false, never throws', !threw && r.ok === false);
    check('…error names both hosts and both reasons',
        /api\.nasa\.gov HTTP 503/.test(r.error) && /ccmc network: getaddrinfo/.test(r.error), r.error);
}
// describeBody never dumps a page.
check('describeBody: long non-HTML body truncated to a short head',
    describeBody('x'.repeat(5000)).length < 80);

console.log(failures ? `\n${failures} failure(s)` : '\nall donki-fetch checks passed');
process.exit(failures ? 1 : 0);
