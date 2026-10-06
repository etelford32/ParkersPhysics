/**
 * tests/weather-grid-pipeline.mjs — the global weather grid must SAY when it
 * is running on its fallback.
 *
 *   node tests/weather-grid-pipeline.mjs
 *
 * For at least the 30 days to 2026-10-05 every weather_grid_cache frame was
 * the MET Norway safety net (648 points at 10°, bilinear-upsampled) while
 * pipeline_heartbeat read consecutive_fail 0 and status.html read green — and
 * the cron had discarded the primary's error, so nothing anywhere said why
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §0, Phase 0b). Gates, all against stubbed
 * upstreams (Open-Meteo and MET Norway are egress-blocked at build time):
 *
 *   • js/pipeline-registry.js isFallbackSource — the ONE copy of the rule
 *   • the cron keeps the failed attempts' reasons when a later attempt wins:
 *     logged, written via record_pipeline_failure BEFORE record_pipeline_success
 *     (so the streak still ends at 0 and the watchdog's email stays reserved
 *     for "nothing written"), and returned as `degraded` + `attempt_failures`
 *   • a 429 rate-limit short-circuits the same-IP gfs retry, like a 200 envelope
 *   • OPEN_METEO_API_KEY switches to the commercial host and never leaks
 *   • /api/weather/grid serves a fallback frame with freshness: 'stale'
 */
import assert from 'node:assert/strict';
import { isFallbackSource, HEARTBEAT_PIPELINES } from '../js/pipeline-registry.js';

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('weather-grid-pipeline.mjs');

const SB = 'https://sb.test';
process.env.SUPABASE_URL = SB;
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'cron-secret';
delete process.env.OPEN_METEO_API_KEY;

const realFetch = globalThis.fetch;
const realWarn = console.warn;

// ── the rule ────────────────────────────────────────────────────────────────
await ok('isFallbackSource: only a non-primary tag on a pipeline that declares a primary', async () => {
    assert.equal(isFallbackSource('weather_grid', 'met-norway:72x36'), true);
    assert.equal(isFallbackSource('weather_grid', 'met-norway-coarse:18x9'), true);
    assert.equal(isFallbackSource('weather_grid', 'open-meteo:72x36'), false);
    assert.equal(isFallbackSource('weather_grid', 'open-meteo-gfs:72x36'), false, 'the gfs retry is the same grid, not a coarser field');
    assert.equal(isFallbackSource('weather_grid', null), false, 'a legacy untagged row cannot be proven degraded');
    assert.equal(isFallbackSource('weather_grid', ''), false);
    assert.equal(isFallbackSource('solar_wind', 'anything'), false, 'no primarySource declared ⇒ never a fallback');
    assert.equal(isFallbackSource('not_a_pipeline', 'met-norway:72x36'), false);
    assert.equal(HEARTBEAT_PIPELINES.find(p => p.key === 'weather_grid').primarySource, 'open-meteo');
});

// ── stubbed upstreams ───────────────────────────────────────────────────────
/** Open-Meteo multi-location success: one item per requested latitude. */
function omItems(url) {
    const lats = new URL(url).searchParams.get('latitude').split(',');
    return lats.map((lat, i) => ({
        latitude: Number(lat), longitude: 0,
        current: { temperature_2m: 10 + (i % 7), relative_humidity_2m: 50, surface_pressure: 1000,
            wind_speed_10m: 3, wind_direction_10m: 180, cloud_cover_low: 10, cloud_cover_mid: 10,
            cloud_cover_high: 10, precipitation: 0 },
    }));
}
/** MET Norway compact point. */
function metnoPoint(url) {
    const u = new URL(url);
    return {
        geometry: { coordinates: [Number(u.searchParams.get('lon')), Number(u.searchParams.get('lat')), 0] },
        properties: { timeseries: [{ time: '2026-10-06T00:00:00Z', data: {
            instant: { details: { air_temperature: 12.5, relative_humidity: 60, air_pressure_at_sea_level: 1012,
                wind_speed: 4, wind_from_direction: 200, cloud_area_fraction_low: 5,
                cloud_area_fraction_medium: 5, cloud_area_fraction_high: 5 } },
            next_1_hours: { details: { precipitation_amount: 0 } } } }] },
    };
}
/**
 * `openMeteo(url)` returns { status, body } for every Open-Meteo request.
 * Records every request, every RPC in order, and the inserted row.
 */
function stub(openMeteo) {
    const log = { om: [], metno: 0, rpcs: [], insert: null, warns: [] };
    console.warn = (...a) => { log.warns.push(a.join(' ')); };
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.includes('open-meteo.com')) {
            log.om.push(u);
            const r = openMeteo(u);
            return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
                { status: r.status, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('api.met.no')) {
            log.metno++;
            return Response.json(metnoPoint(u));
        }
        if (u.startsWith(`${SB}/rest/v1/rpc/`)) {
            log.rpcs.push({ fn: u.slice(`${SB}/rest/v1/rpc/`.length), args: JSON.parse(init.body || '{}') });
            return new Response('null', { status: 200 });
        }
        if (u.startsWith(`${SB}/rest/v1/weather_grid_cache`)) {
            log.insert = JSON.parse(init.body);
            return Response.json([{ id: 4242 }], { status: 201 });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    return log;
}
function restore() { globalThis.fetch = realFetch; console.warn = realWarn; }
const cronReq = () => new Request('https://x.test/api/cron/refresh-weather-grid',
    { headers: { authorization: 'Bearer cron-secret' } });
const LIMIT = { error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' };

// ── the cron, keyless ───────────────────────────────────────────────────────
const { default: cronKeyless } = await import('../api/cron/refresh-weather-grid.js?keyless');

await ok('a fallback win KEEPS the primary\'s reason: logged, heartbeat failure-then-success, body says degraded', async () => {
    const log = stub(() => ({ status: 429, body: LIMIT }));
    try {
        const res = await cronKeyless(cronReq());
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.source, 'met-norway:72x36');
        assert.equal(body.degraded, true);
        assert.equal(log.insert.source, 'met-norway:72x36');
        assert.equal(log.insert.payload.length, 2592);
        assert.equal(log.metno, 648, 'the fallback samples the 10° grid');

        assert.deepEqual(body.attempt_failures.map(f => f.src), ['open-meteo', 'open-meteo-gfs', ]);
        assert.match(body.attempt_failures[0].reason, /HTTP 429: .*Minutely API request limit/);
        assert.match(body.attempt_failures[1].reason, /skipped \(rate-limit short-circuit\)/);
        assert.ok(!log.om.some(u => u.includes('gfs_seamless')), 'a 429 rate limit must not burn a same-IP gfs retry');

        const fns = log.rpcs.map(r => r.fn);
        const iFail = fns.indexOf('record_pipeline_failure');
        const iOk = fns.indexOf('record_pipeline_success');
        assert.ok(iFail >= 0 && iOk > iFail, `failure must be written BEFORE success (got ${fns.join(', ')})`);
        const reason = log.rpcs[iFail].args.p_reason;
        assert.match(reason, /^degraded: served met-norway:72x36; /);
        assert.match(reason, /Minutely API request limit/);
        assert.equal(log.rpcs[iOk].args.p_source, 'met-norway:72x36');
        assert.ok(log.warns.some(w => /served met-norway:72x36 after 2 failed attempt/.test(w)), 'the reason reaches the runtime log');
        assert.ok(log.om.every(u => u.startsWith('https://api.open-meteo.com/') && !u.includes('apikey')));
    } finally { restore(); }
});

await ok('a 200 rate-limit envelope short-circuits exactly the same way', async () => {
    const log = stub(() => ({ status: 200, body: { error: true, reason: 'Daily API request limit exceeded. Please try again tomorrow.' } }));
    try {
        const body = await (await cronKeyless(cronReq())).json();
        assert.equal(body.source, 'met-norway:72x36');
        assert.match(body.attempt_failures[0].reason, /upstream error: Daily API request limit/);
        assert.ok(!log.om.some(u => u.includes('gfs_seamless')));
    } finally { restore(); }
});

await ok('a non-limit primary failure still tries gfs, and a gfs win is recorded as degraded-but-primary-grid', async () => {
    const log = stub((u) => u.includes('gfs_seamless')
        ? { status: 200, body: omItems(u) }
        : { status: 502, body: '<html>bad gateway</html>' });
    try {
        const body = await (await cronKeyless(cronReq())).json();
        assert.equal(body.source, 'open-meteo-gfs:72x36');
        assert.equal(body.degraded, true, 'an attempt failed, so the run reports it');
        assert.deepEqual(body.attempt_failures.map(f => f.src), ['open-meteo']);
        assert.equal(log.metno, 0);
        assert.equal(isFallbackSource('weather_grid', body.source), false, 'but the gfs grid is not a fallback FIELD');
        const fns = log.rpcs.map(r => r.fn);
        assert.ok(fns.indexOf('record_pipeline_failure') < fns.indexOf('record_pipeline_success'));
    } finally { restore(); }
});

await ok('a clean primary run writes success only and reports degraded: false', async () => {
    const log = stub((u) => ({ status: 200, body: omItems(u) }));
    try {
        const body = await (await cronKeyless(cronReq())).json();
        assert.equal(body.source, 'open-meteo:72x36');
        assert.equal(body.degraded, false);
        assert.equal(body.attempt_failures, undefined);
        assert.ok(!log.rpcs.some(r => r.fn === 'record_pipeline_failure'));
        assert.equal(log.om.length, 3, '3 chunks × 864');
        assert.equal(log.warns.length, 0);
    } finally { restore(); }
});

await ok('a total failure records EVERY attempt\'s reason, not just the fallback\'s', async () => {
    const log = stub(() => ({ status: 429, body: LIMIT }));
    globalThis.fetch = ((inner) => async (url, init) => String(url).includes('api.met.no')
        ? new Response('busy', { status: 503 }) : inner(url, init))(globalThis.fetch);
    try {
        const res = await cronKeyless(cronReq());
        const body = await res.json();
        assert.equal(res.status, 502);
        assert.equal(log.insert, null);
        const fail = log.rpcs.filter(r => r.fn === 'record_pipeline_failure');
        assert.equal(fail.length, 1);
        assert.match(fail[0].args.p_reason, /open-meteo chunk \d+ HTTP 429: .*Minutely/);
        assert.match(fail[0].args.p_reason, /met-norway too many failures/);
        assert.ok(!log.rpcs.some(r => r.fn === 'record_pipeline_success'));
        assert.equal(body.reason, fail[0].args.p_reason);
    } finally { restore(); }
});

// ── the cron, with a commercial key ─────────────────────────────────────────
process.env.OPEN_METEO_API_KEY = 'sekret-KEY-123';
const { default: cronKeyed } = await import('../api/cron/refresh-weather-grid.js?keyed');
delete process.env.OPEN_METEO_API_KEY;

await ok('OPEN_METEO_API_KEY routes both Open-Meteo attempts to customer-api with &apikey=', async () => {
    const log = stub((u) => ({ status: 200, body: omItems(u) }));
    try {
        const body = await (await cronKeyed(cronReq())).json();
        assert.equal(body.source, 'open-meteo:72x36');
        assert.ok(log.om.length > 0);
        for (const u of log.om) {
            assert.ok(u.startsWith('https://customer-api.open-meteo.com/v1/forecast?'), u.slice(0, 60));
            assert.equal(new URL(u).searchParams.get('apikey'), 'sekret-KEY-123');
        }
    } finally { restore(); }
});

await ok('the key is scrubbed from every reason an upstream echoes back', async () => {
    const log = stub((u) => ({ status: 400, body: { error: true, reason: `Invalid apikey sekret-KEY-123 for ${u}` } }));
    try {
        const body = await (await cronKeyed(cronReq())).json();
        assert.equal(body.source, 'met-norway:72x36');
        const everything = JSON.stringify(body) + JSON.stringify(log.rpcs) + log.warns.join('\n');
        assert.ok(!everything.includes('sekret-KEY-123'), 'the key leaked into a reason, a log line or the heartbeat');
        assert.match(body.attempt_failures[0].reason, /\[apikey\]/);
    } finally { restore(); }
});

// ── the read route ──────────────────────────────────────────────────────────
const { default: gridRoute } = await import('../api/weather/grid.js');
function stubGridRows(rows) {
    globalThis.fetch = async (url) => {
        const u = String(url);
        assert.ok(u.startsWith(`${SB}/rest/v1/weather_grid_cache`), u);
        return Response.json(rows);
    };
}
const row = (source) => ({ fetched_at: new Date().toISOString(), source, payload: [{ current: { temperature_2m: 1 } }] });

await ok('/api/weather/grid serves a fallback frame as freshness: stale (single + range)', async () => {
    try {
        stubGridRows([row('met-norway:72x36')]);
        const one = await (await gridRoute(new Request('https://x.test/api/weather/grid'))).json();
        assert.equal(one.freshness, 'stale');
        assert.match(one.note, /^fallback-source: met-norway:72x36/);
        assert.deepEqual(one.grid, { w: 72, h: 36, deg: 5 });

        stubGridRows([row('open-meteo:72x36'), row('met-norway:72x36')]);
        const range = await (await gridRoute(new Request(`https://x.test/api/weather/grid?since=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`))).json();
        assert.deepEqual(range.frames.map(f => f.freshness), ['live', 'stale']);
        assert.equal(range.frames[0].note, undefined);
    } finally { restore(); }
});

await ok('/api/weather/grid serves a primary frame (and a legacy untagged one) as live', async () => {
    try {
        stubGridRows([row('open-meteo:72x36')]);
        const a = await (await gridRoute(new Request('https://x.test/api/weather/grid'))).json();
        assert.equal(a.freshness, 'live');
        assert.equal(a.note, undefined);
        stubGridRows([row(null)]);
        const b = await (await gridRoute(new Request('https://x.test/api/weather/grid'))).json();
        assert.equal(b.freshness, 'live');
    } finally { restore(); }
});

console.log(`\n${passed} passed`);
