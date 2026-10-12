// node tests/donki-upstream.mjs — gates api/_lib/donki-upstream.js (no network).
//
// The helper exists because CCMC moved DONKI (2026-09-30) and both old hosts
// started serving an HTML announcement page, starving flux-rope-live.html. These
// pin: both hosts are tried, the first VALID JSON wins, an HTML 200 is a
// failure not a result, the key goes only to the gateway, and an error
// message never carries a URL or the key.
import assert from 'node:assert/strict';
import { DONKI_HOSTS, donkiUrl, fetchDonki, describeBody } from '../api/_lib/donki-upstream.js';

const KEY = 'SECRETKEY123';
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ok', name); };

const hdrs = (type) => ({ get: (k) => (k.toLowerCase() === 'content-type' ? type : null) });
const jsonRes = (body, status = 200) => ({ ok: status < 400, status,
    headers: hdrs('application/json'), text: async () => JSON.stringify(body) });
const htmlRes = (html = '<html><head><title>Down</title></head><body><h1>DONKI is unavailable</h1></body></html>') =>
    ({ ok: true, status: 200, headers: hdrs('text/html; charset=utf-8'), text: async () => html });
const hostOf = (url) => (url.startsWith('https://ccmc.gsfc') ? 'ccmc' : 'api.nasa.gov');

/** Mock fetch: per-host behaviour = response factory | 'hang' | Error. */
function mockFetch(behaviour, calls = []) {
    return (url, init) => {
        const h = hostOf(url);
        calls.push({ host: h, url });
        const b = behaviour[h];
        if (b === 'hang') {
            return new Promise((_, rej) => init.signal.addEventListener('abort',
                () => rej(new DOMException('aborted', 'AbortError'))));
        }
        if (b instanceof Error) return Promise.reject(b);
        return new Promise((res) => setTimeout(() => res(b()), b.delay ?? 0));
    };
}

console.log('donki-upstream');

await t('URL shapes: origin unkeyed, gateway keyed, same path + params', () => {
    const [ccmc, gw] = DONKI_HOSTS;
    const p = { startDate: '2026-10-01', endDate: '2026-10-08', mostAccurateOnly: true, skip: null };
    assert.equal(donkiUrl(ccmc, 'CMEAnalysis', p, KEY),
        'https://ccmc.gsfc.nasa.gov/DONKI-API/get/CMEAnalysis?startDate=2026-10-01&endDate=2026-10-08&mostAccurateOnly=true');
    assert.equal(donkiUrl(gw, 'CMEAnalysis', p, KEY),
        `https://api.nasa.gov/DONKI/CMEAnalysis?startDate=2026-10-01&endDate=2026-10-08&mostAccurateOnly=true&api_key=${KEY}`);
});

await t('gateway timing out → new CCMC host answers', async () => {
    const calls = [];
    const r = await fetchDonki('CMEAnalysis', {}, {
        apiKey: KEY, timeoutMs: 200,
        fetchImpl: mockFetch({ ccmc: () => jsonRes([{ a: 1 }]), 'api.nasa.gov': 'hang' }, calls),
    });
    assert.equal(r.host, 'ccmc');
    assert.deepEqual(r.data, [{ a: 1 }]);
    assert.equal(calls.length, 2, 'both hosts raced');
});

await t('origin failing → gateway answers', async () => {
    const r = await fetchDonki('FLR', {}, {
        apiKey: KEY, timeoutMs: 200,
        fetchImpl: mockFetch({ ccmc: () => jsonRes(null, 502), 'api.nasa.gov': () => jsonRes([]) }),
    });
    assert.equal(r.host, 'api.nasa.gov');
});

await t('an HTML 200 is a host failure, not a result', async () => {
    const slow = () => jsonRes([{ ok: true }]); slow.delay = 30;
    const r = await fetchDonki('GST', {}, {
        apiKey: KEY, timeoutMs: 500,
        fetchImpl: mockFetch({ ccmc: htmlRes, 'api.nasa.gov': slow }),
    });
    assert.equal(r.host, 'api.nasa.gov');
    assert.deepEqual(r.data, [{ ok: true }]);
});

await t('a non-JSON answer is DESCRIBED (outage page vs empty), key + URLs redacted', async () => {
    const page = `<html><body><p>Service down. Retry https://api.nasa.gov/x?api_key=${KEY}</p><script>var k="${KEY}"</script></body></html>`;
    await assert.rejects(
        fetchDonki('CMEAnalysis', {}, {
            apiKey: KEY, timeoutMs: 200,
            fetchImpl: mockFetch({ ccmc: () => htmlRes(page), 'api.nasa.gov': () => htmlRes('') }),
        }),
        (e) => {
            assert.match(e.message, /ccmc returned non-JSON \(text\/html, \d+ B: "Service down\. Retry \[url\]"\)/);
            assert.match(e.message, /api\.nasa\.gov returned non-JSON \(text\/html, empty body\)/);
            assert.ok(!e.message.includes(KEY), 'key leaked');
            return true;
        });
    assert.equal(describeBody({ headers: hdrs(null) }, 'x', ''), 'no content-type, 1 B: "x"');
});

await t('the loser is aborted once a host wins', async () => {
    let aborted = false;
    const fetchImpl = (url, init) => {
        if (hostOf(url) === 'ccmc') return Promise.resolve(jsonRes([]));
        init.signal.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => {});
    };
    await fetchDonki('SEP', {}, { apiKey: KEY, timeoutMs: 5000, fetchImpl });
    assert.equal(aborted, true);
});

await t('total failure names each host, never a URL or the key', async () => {
    await assert.rejects(
        fetchDonki('CMEAnalysis', { startDate: '2026-10-01' }, {
            apiKey: KEY, timeoutMs: 50,
            fetchImpl: mockFetch({ ccmc: 'hang', 'api.nasa.gov': () => jsonRes(null, 404) }),
        }),
        (e) => {
            assert.match(e.message, /^DONKI CMEAnalysis: /);
            assert.match(e.message, /ccmc timeout/);
            assert.match(e.message, /api\.nasa\.gov HTTP 404/);
            assert.ok(!e.message.includes(KEY), 'key leaked into error');
            assert.ok(!/https?:\/\//.test(e.message), 'URL leaked into error');
            return true;
        });
});

await t('network error on both is reported per host', async () => {
    await assert.rejects(
        fetchDonki('FLR', {}, {
            apiKey: KEY, timeoutMs: 100,
            fetchImpl: mockFetch({ ccmc: new TypeError(`fetch failed ${KEY}`), 'api.nasa.gov': new TypeError('x') }),
        }),
        (e) => /ccmc network error/.test(e.message) && !e.message.includes(KEY));
});

console.log(`donki-upstream: ${pass} passed`);
