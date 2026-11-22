/**
 * tests/coronagraph-route.mjs — the SOHO/LASCO branch of /api/solar/aia
 *
 *   node tests/coronagraph-route.mjs
 *
 * The route's own contract for `channel=c2|c3`, against a stubbed upstream
 * (nasa.gov is egress-blocked at build time). Gates:
 *   • c2 / c3 fetch SOHO's realtime browse frame and NAME the instrument in
 *     `X-SOHO-Instrument` — the header js/sun-coronagraph.js requires, because
 *     an unknown channel on this route has always fallen back to the HMI disc
 *   • only 512 and 1024 exist upstream; any other `res` is served as 1024
 *   • a 200 that is not an image is an error page and is rejected
 *   • the image path fails as a 502 JSON (no placeholder frame); `meta=1`
 *     NEVER 5xxs — a dead upstream is 200 + freshness:'expired' + error
 *   • freshness is scored on LASCO's own thresholds, not AIA's
 *   • a LASCO request never touches the SDO or SUVI upstreams, and the SDO
 *     path is untouched (including its long-standing unknown-channel default,
 *     which is exactly why the instrument header exists)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler, { upstreamUrl } from '../api/solar/aia.js';
import { lascoUrl, lascoSize, parseLascoChannel, LASCO_CACHE_S, LASCO_WARN_S, LASCO_CRIT_S, lascoFreshness } from '../js/lasco-sources.js';
import { INSTRUMENT_HEADER } from '../js/sun-coronagraph.js';

let passed = 0;
function ok(name, fn) { return Promise.resolve(fn()).then(() => { passed++; console.log(`  ✓ ${name}`); }); }
console.log('coronagraph-route.mjs');

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const realFetch = globalThis.fetch;

/** Stub upstream: `plan` maps a URL substring → { status, type, body, lastModified }. */
function stubFetch(plan) {
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        seen.push({ url: u, method: init.method || 'GET' });
        const key = Object.keys(plan).find(k => u.includes(k));
        const r = key ? plan[key] : { status: 404, type: 'text/html' };
        if (r.throws) throw new Error(r.throws);
        return new Response(
            r.status === 200 && r.type?.startsWith('image/') ? JPG : (r.body ?? 'nope'),
            { status: r.status, headers: {
                'content-type': r.type ?? 'text/html',
                ...(r.lastModified ? { 'last-modified': r.lastModified } : {}),
            } });
    };
    return seen;
}
const restore = () => { globalThis.fetch = realFetch; };
const req = (qs) => new Request(`https://x.test/api/solar/aia?${qs}`);

await ok('the source table is one small pure module: names, sizes, the path', () => {
    assert.equal(parseLascoChannel('c2'), 'c2');
    assert.equal(parseLascoChannel('C3'), 'c3');
    for (const not of ['c1', 'c4', '304', 'suvi304', 'white', '', null, undefined, 'toString', '__proto__']) {
        assert.equal(parseLascoChannel(not), null, `${not} is not a LASCO channel`);
    }
    assert.equal(lascoSize(512), 512);
    for (const r of [1024, 2048, 4096, 256, NaN, undefined]) assert.equal(lascoSize(r), 1024);
    assert.equal(lascoUrl('c2', 1024), 'https://soho.nascom.nasa.gov/data/realtime/c2/1024/latest.jpg');
    assert.equal(lascoUrl('c3', 512),  'https://soho.nascom.nasa.gov/data/realtime/c3/512/latest.jpg');
    assert.throws(() => lascoUrl('c9'));
    // Dependency-free: the edge function must not pull the layer's kernel in.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'lasco-sources.js'), 'utf8');
    assert.doesNotMatch(src, /^\s*import\s/m, 'js/lasco-sources.js must import nothing');
    // The same files the SDO Live drawer already loads as <img> sources.
    const soho = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'soho-feed.js'), 'utf8');
    assert.ok(soho.includes(lascoUrl('c2', 1024)) && soho.includes(lascoUrl('c3', 1024)), 'the path is the one js/soho-feed.js uses');
});

await ok('c2 / c3 stream the realtime frame and name the instrument', async () => {
    for (const id of ['c2', 'c3']) {
        const seen = stubFetch({ 'soho.nascom.nasa.gov': { status: 200, type: 'image/jpeg', lastModified: 'Fri, 20 Nov 2026 12:00:00 GMT' } });
        try {
            const res = await handler(req(`channel=${id}&res=1024`));
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'image/jpeg');
            assert.equal(res.headers.get(INSTRUMENT_HEADER), id);
            assert.equal(res.headers.get('X-AIA-Channel'), id);
            assert.equal(res.headers.get('X-AIA-Mode'), 'live');
            assert.equal(res.headers.get('X-SOHO-Upstream'), lascoUrl(id, 1024));
            assert.equal(res.headers.get('X-SDO-Observed-At'), '2026-11-20T12:00:00.000Z');
            assert.ok(res.headers.get('X-SDO-Fetched-At'));
            assert.match(res.headers.get('cache-control'), new RegExp(`s-maxage=${LASCO_CACHE_S}\\b`));
            // The browser can only read headers the expose list names.
            for (const h of [INSTRUMENT_HEADER, 'X-SDO-Observed-At', 'X-SOHO-Upstream']) {
                assert.ok(res.headers.get('Access-Control-Expose-Headers').includes(h), `${h} not exposed`);
            }
            assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPG);
            assert.equal(seen.length, 1);
            assert.equal(seen[0].url, lascoUrl(id, 1024));
        } finally { restore(); }
    }
});

await ok('only 512 and 1024 exist: anything else is served as 1024', async () => {
    for (const [asked, served] of [['512', 512], ['1024', 1024], ['2048', 1024], ['4096', 1024], ['banana', 1024]]) {
        const seen = stubFetch({ 'soho.nascom.nasa.gov': { status: 200, type: 'image/jpeg' } });
        try {
            const res = await handler(req(`channel=c3&res=${asked}`));
            assert.equal(res.status, 200);
            assert.equal(seen[0].url, lascoUrl('c3', served), `res=${asked}`);
        } finally { restore(); }
    }
});

await ok('a 200 that is not an image is rejected; a dead upstream is a 502 JSON, never a blank frame', async () => {
    for (const plan of [
        { 'soho.nascom.nasa.gov': { status: 200, type: 'text/html', body: '<html>maintenance</html>' } },
        { 'soho.nascom.nasa.gov': { status: 503, type: 'text/html' } },
        { 'soho.nascom.nasa.gov': { throws: 'connect ECONNREFUSED' } },
    ]) {
        stubFetch(plan);
        try {
            const res = await handler(req('channel=c2'));
            assert.equal(res.status, 502);
            assert.equal(res.headers.get(INSTRUMENT_HEADER), null, 'a failure must not carry the instrument header');
            const b = await res.json();
            assert.equal(b.error, 'lasco_unavailable');
            assert.equal(b.instrument, 'c2');
            assert.ok(b.detail);
        } finally { restore(); }
    }
});

await ok('meta=1 reports provenance on LASCO\'s own freshness thresholds', async () => {
    const twoHours = new Date(Date.now() - 2 * 3600e3).toUTCString();
    const seen = stubFetch({ 'soho.nascom.nasa.gov': { status: 200, type: 'image/jpeg', lastModified: twoHours } });
    try {
        const res = await handler(req('channel=c2&meta=1'));
        assert.equal(res.status, 200);
        const b = await res.json();
        assert.equal(b.source, 'soho-lasco');
        assert.equal(b.instrument, 'c2');
        assert.equal(b.upstream, lascoUrl('c2', 1024));
        assert.ok(Math.abs(b.age_seconds - 7200) < 10, `age ${b.age_seconds}`);
        // Two hours old is past AIA's 90 min CRITICAL — and is this feed's normal.
        assert.equal(b.freshness, 'live');
        assert.equal(b.observed_at_basis, 'upstream Last-Modified');
        assert.equal(seen[0].method, 'HEAD');
        assert.equal(seen.length, 1);
    } finally { restore(); }
    assert.equal(lascoFreshness(LASCO_WARN_S + 60), 'stale');
    assert.equal(lascoFreshness(LASCO_CRIT_S + 60), 'expired');
    for (const [ageH, want] of [[5, 'stale'], [30, 'expired']]) {
        stubFetch({ 'soho.nascom.nasa.gov': { status: 200, type: 'image/jpeg', lastModified: new Date(Date.now() - ageH * 3600e3).toUTCString() } });
        try { assert.equal((await (await handler(req('channel=c3&meta=1'))).json()).freshness, want); } finally { restore(); }
    }
});

await ok('meta=1 with the upstream dead, wrong, or undated is 200 + expired, NEVER a 5xx', async () => {
    for (const [plan, detail] of [
        [{}, /HTTP 404/],
        [{ 'soho.nascom.nasa.gov': { status: 200, type: 'text/html' } }, /not_an_image/],
        [{ 'soho.nascom.nasa.gov': { throws: 'timed out' } }, /timed out/],
    ]) {
        stubFetch(plan);
        try {
            const res = await handler(req('channel=c3&meta=1'));
            assert.equal(res.status, 200);
            const b = await res.json();
            assert.equal(b.freshness, 'expired');
            assert.equal(b.error, 'lasco_unavailable');
            assert.match(b.detail, detail);
            assert.equal(b.observed_at, null);
        } finally { restore(); }
    }
    // An image with no Last-Modified: the age is unknown, which is not "live".
    stubFetch({ 'soho.nascom.nasa.gov': { status: 200, type: 'image/jpeg' } });
    try {
        const b = await (await handler(req('channel=c2&meta=1'))).json();
        assert.equal(b.age_seconds, null);
        assert.equal(b.freshness, 'expired');
        assert.equal(b.error, undefined);
    } finally { restore(); }
});

await ok('a LASCO request never touches the SDO or SUVI upstreams', async () => {
    const seen = stubFetch({ 'soho.nascom.nasa.gov': { status: 200, type: 'image/jpeg' } });
    try {
        await handler(req('channel=c2'));
        await handler(req('channel=c3&meta=1'));
        assert.equal(seen.length, 2);
        assert.equal(seen.every(s => s.url.startsWith('https://soho.nascom.nasa.gov/')), true);
    } finally { restore(); }
});

await ok('the SDO and SUVI paths are untouched', async () => {
    const seen = stubFetch({ 'sdo.gsfc.nasa.gov': { status: 200, type: 'image/jpeg' } });
    try {
        const res = await handler(req('channel=171&res=2048'));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get(INSTRUMENT_HEADER), null, 'no SOHO header on an SDO frame');
        assert.match(res.headers.get('cache-control'), /s-maxage=720/);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, upstreamUrl('171', 2048));
        // THE REASON THE INSTRUMENT HEADER EXISTS: an unknown channel still
        // answers with the HMI disc and echoes the channel name. A client that
        // trusted X-AIA-Channel would wrap a photosphere around the corona.
        const unk = await handler(req('channel=c9'));
        assert.equal(unk.status, 200);
        assert.equal(unk.headers.get('X-AIA-Channel'), 'c9');
        assert.equal(unk.headers.get(INSTRUMENT_HEADER), null);
        assert.equal(seen[1].url, upstreamUrl('white', 1024));
    } finally { restore(); }
});

console.log(`\n${passed} checks passed (coronagraph route)`);
