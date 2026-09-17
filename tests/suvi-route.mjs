/**
 * tests/suvi-route.mjs — the SUVI branch of /api/solar/aia
 *
 *   node tests/suvi-route.mjs
 *
 * The route's own contract, exercised against a stubbed upstream (SWPC is
 * egress-blocked at build time — which is the whole reason the URL resolves
 * from a candidate list in the first place). Gates:
 *   • the image path tries candidates IN ORDER and stops at the first hit,
 *     and names the winner in X-SUVI-Source so one production request settles
 *     the URL
 *   • a 200 that is not an image is SWPC's error page, not a frame — it is
 *     rejected and the walk continues
 *   • `meta=1` probes EVERY candidate (the diagnostic call) and NEVER 5xxs, so
 *     status.html reads a dead feed as DOWN rather than the route as broken
 *   • a SUVI request never reaches the SDO upstream, and an SDO request is
 *     completely untouched by any of this
 */
import assert from 'node:assert/strict';
import handler, { upstreamUrl } from '../api/solar/aia.js';
import { candidateUrls } from '../js/suvi-geometry.js';

let passed = 0;
function ok(name, fn) { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }
console.log('suvi-route.mjs');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const realFetch = globalThis.fetch;

/** Stub upstream: `plan` maps a URL substring → { status, type, body }. */
function stubFetch(plan) {
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        seen.push({ url: u, method: init.method || 'GET' });
        const key = Object.keys(plan).find(k => u.includes(k));
        const r = key ? plan[key] : { status: 404, type: 'text/html' };
        return new Response(
            r.status === 200 && r.type?.startsWith('image/') ? PNG : (r.body ?? 'nope'),
            { status: r.status, headers: {
                'content-type': r.type ?? 'text/html',
                ...(r.lastModified ? { 'last-modified': r.lastModified } : {}),
            } });
    };
    return seen;
}
const restore = () => { globalThis.fetch = realFetch; };
const req = (qs) => new Request(`https://x.test/api/solar/aia?${qs}`);

await ok('the image path stops at the FIRST candidate that answers, and names it', async () => {
    const cands = candidateUrls('304');
    const seen = stubFetch({ [cands[0].url]: { status: 200, type: 'image/png', lastModified: 'Wed, 17 Sep 2026 12:00:00 GMT' } });
    try {
        const res = await handler(req('channel=suvi304'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
        assert.equal(res.headers.get('X-SUVI-Source'), cands[0].id);
        assert.equal(res.headers.get('X-SUVI-Satellite'), 'primary');
        assert.equal(res.headers.get('X-SUVI-Upstream'), cands[0].url);
        assert.equal(res.headers.get('X-SUVI-Band'), '304');
        assert.equal(res.headers.get('X-SDO-Observed-At'), '2026-09-17T12:00:00.000Z');
        // Stopped at the first: exactly one upstream call.
        assert.equal(seen.length, 1, `walked ${seen.length} candidates`);
        // SUVI caches at its own 4 min cadence, not AIA's 12.
        assert.match(res.headers.get('cache-control'), /s-maxage=240/);
        // The expose list must carry the SUVI headers or the browser cannot read them.
        assert.match(res.headers.get('Access-Control-Expose-Headers'), /X-SUVI-Source/);
    } finally { restore(); }
});

await ok('it walks PAST a 404 and past a 200 that is not an image', async () => {
    const cands = candidateUrls('131');
    const seen = stubFetch({
        [cands[0].url]: { status: 404, type: 'text/html' },
        // SWPC's own error page: a 200 carrying HTML. Decoding this as a frame
        // is how a dead feed turns into a convincing black corona.
        [cands[1].url]: { status: 200, type: 'text/html', body: '<html>not found</html>' },
        [cands[2].url]: { status: 200, type: 'image/png' },
    });
    try {
        const res = await handler(req('channel=suvi131'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-SUVI-Source'), cands[2].id);
        assert.equal(seen.length, 3);
    } finally { restore(); }
});

await ok('no candidate answering is a 502 with the walk attached, never a blank frame', async () => {
    stubFetch({});
    try {
        const res = await handler(req('channel=suvi304'));
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.error, 'suvi_unavailable');
        assert.equal(body.band, '304');
        assert.equal(body.tried.length, candidateUrls('304').length, 'every candidate is reported');
        for (const t of body.tried) assert.equal(t.ok, false);
    } finally { restore(); }
});

await ok('meta=1 probes EVERY candidate and reports each status', async () => {
    const cands = candidateUrls('304');
    const seen = stubFetch({
        [cands[0].url]: { status: 503, type: 'text/html' },
        [cands[1].url]: { status: 200, type: 'image/png', lastModified: new Date(Date.now() - 300e3).toUTCString() },
        [cands[2].url]: { status: 200, type: 'image/png' },
    });
    try {
        const res = await handler(req('channel=suvi304&meta=1'));
        assert.equal(res.status, 200);
        const b = await res.json();
        assert.equal(b.source, 'goes-suvi');
        assert.equal(b.band, '304');
        assert.equal(b.wavelength_angstrom, 304);
        assert.equal(b.ion, 'He II');
        // The winner is the FIRST ok candidate even though a later one also answers.
        assert.equal(b.source_id, cands[1].id);
        assert.equal(b.upstream, cands[1].url);
        assert.equal(b.freshness, 'live');
        assert.ok(b.age_seconds >= 290 && b.age_seconds <= 310, `age ${b.age_seconds}`);
        // ALL candidates probed — this is the diagnostic call.
        assert.equal(b.candidates.length, cands.length);
        assert.equal(seen.length, cands.length);
        assert.equal(seen.every(s => s.method === 'HEAD'), true, 'probes are HEADs');
        assert.equal(b.candidates[0].status, 503);
        assert.equal(b.candidates[0].ok, false);
    } finally { restore(); }
});

await ok('meta=1 with nothing answering is 200 + expired, NEVER a 5xx', async () => {
    stubFetch({});
    try {
        const res = await handler(req('channel=suvi195&meta=1'));
        // A 5xx here scores the ROUTE as broken on status.html; the feed being
        // down (or the path being wrong) must read as the FEED being down.
        assert.equal(res.status, 200);
        const b = await res.json();
        assert.equal(b.freshness, 'expired');
        assert.equal(b.error, 'suvi_unresolved');
        assert.equal(b.source_id, null);
        assert.equal(b.upstream, null);
        assert.ok(b.note.includes('UNVERIFIED'), 'the note says the path is a guess');
        assert.equal(b.candidates.length, candidateUrls('195').length);
    } finally { restore(); }
});

await ok('a SUVI request never touches the SDO upstream', async () => {
    const seen = stubFetch({ 'services.swpc.noaa.gov': { status: 200, type: 'image/png' } });
    try {
        await handler(req('channel=suvi304'));
        assert.equal(seen.some(s => s.url.includes('sdo.gsfc.nasa.gov')), false);
    } finally { restore(); }
});

await ok('the SDO path is untouched — this is a layer, not a swap', async () => {
    const seen = stubFetch({ 'sdo.gsfc.nasa.gov': { status: 200, type: 'image/jpeg' } });
    try {
        const res = await handler(req('channel=304&res=1024'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/jpeg');
        assert.equal(res.headers.get('X-SUVI-Source'), null, 'no SUVI headers on an SDO frame');
        assert.match(res.headers.get('cache-control'), /s-maxage=720/, 'AIA keeps its 12 min cadence');
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, upstreamUrl('304', 1024));
        assert.equal(seen.some(s => s.url.includes('swpc')), false);
    } finally { restore(); }
});

await ok('the candidate walk is bounded, and unreached candidates say so', async () => {
    // A total miss is exactly the case the candidate list exists for, so it is
    // the one that must not be killed by the platform's own timeout: five slow
    // candidates would otherwise run past an edge invocation's limit and
    // surface as a 5xx instead of the 502-with-the-walk this route promises.
    const realFetchLocal = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (url, init = {}) => {
        calls++;
        // Every candidate hangs until its own AbortSignal fires. The long
        // setTimeout is what keeps node's event loop alive: AbortSignal.timeout
        // timers are unref'd, so without it the process exits mid-await and the
        // test reports "unsettled top-level await" instead of a result.
        return new Promise((_, rej) => {
            const t = setTimeout(() => rej(new Error('stub never answered')), 60_000);
            init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('timed out')); });
        });
    };
    try {
        const t0 = Date.now();
        const res = await handler(req('channel=suvi304'));
        const elapsed = Date.now() - t0;
        assert.equal(res.status, 502);
        const body = await res.json();
        // Every candidate is still ACCOUNTED FOR, so the diagnostic stays
        // complete: a path that was never reached must not look like a 404.
        assert.equal(body.tried.length, candidateUrls('304').length);
        assert.ok(body.tried.some(t => t.reject === 'budget_exhausted'),
            'unreached candidates are reported as such');
        assert.ok(elapsed < 20_000, `walk took ${elapsed}ms — must stay inside the edge budget`);
        assert.ok(calls < candidateUrls('304').length, 'it stopped calling once the budget was spent');
    } finally { globalThis.fetch = realFetchLocal; }
});

console.log(`\n${passed} checks passed`);
