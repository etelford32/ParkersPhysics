#!/usr/bin/env node
/**
 * climalytix-archive.mjs — node gate for /api/climalytix/archive and its pure
 * half js/climalytix/archive-request.js.
 *
 * The handler is run for real with `fetch` stubbed (no network in CI): a good
 * upstream, an HTTP error, a throw and an empty body. The three degraded cases
 * must answer 200 + freshness:'expired' — never a 5xx — and bad input a 400.
 *
 *   node tests/climalytix-archive.mjs
 */

import assert from 'node:assert/strict';
import {
    snapCoord, parseArchiveQuery, archivePath, buildArchiveUrl, normalizeArchive,
    degradedArchive, haversineKm, ARCHIVE_VARIABLES, ARCHIVE_MIN_YEAR, ARCHIVE_DEFAULT_YEAR,
} from '../js/climalytix/archive-request.js';
import handler from '../api/climalytix/archive.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const NOW = Date.UTC(2026, 10, 8, 12);

console.log('climalytix archive route');

await ok('snapCoord puts every visitor in a cell on one 0.05° key', () => {
    assert.equal(snapCoord(40.0149), 40);
    assert.equal(snapCoord(40.026), 40.05);
    assert.equal(snapCoord(-105.271), -105.25);
    assert.equal(snapCoord(-0.01), 0, 'no −0 in a cache key');
    assert.equal(archivePath({ lat: 40.0149, lon: -105.271, fromYear: 1991 }),
        '/api/climalytix/archive?lat=40.00&lon=-105.25&from=1991');
});

await ok('parseArchiveQuery validates and clamps', () => {
    assert.deepEqual(parseArchiveQuery({ lat: '40.01', lon: '-105.27' }, NOW), { lat: 40, lon: -105.25, fromYear: ARCHIVE_DEFAULT_YEAR });
    assert.equal(parseArchiveQuery({ lat: 40, lon: 0, from: '1800' }, NOW).fromYear, ARCHIVE_MIN_YEAR);
    assert.equal(parseArchiveQuery({ lat: 40, lon: 0, from: '2099' }, NOW).fromYear, 2025, 'at most last year');
    assert.match(parseArchiveQuery({ lat: 'x', lon: 0 }).error, /lat/);
    assert.match(parseArchiveQuery({ lat: 0, lon: 200 }).error, /lon/);
    assert.match(parseArchiveQuery({ lat: null, lon: 0 }).error, /lat/, 'Number(null) is 0 — a missing lat must not become the equator');
});

await ok('buildArchiveUrl pins SI units, local days, unix time and the ERA5 lag', () => {
    const u = new URL(buildArchiveUrl({ lat: 40, lon: -105.25, fromYear: 1991 }, NOW));
    assert.equal(u.searchParams.get('start_date'), '1991-01-01');
    assert.equal(u.searchParams.get('end_date'), '2026-11-03', 'today − 5 days');
    assert.equal(u.searchParams.get('wind_speed_unit'), 'ms');
    assert.equal(u.searchParams.get('temperature_unit'), 'celsius');
    assert.equal(u.searchParams.get('timezone'), 'auto');
    assert.equal(u.searchParams.get('timeformat'), 'unixtime');
    assert.deepEqual(u.searchParams.get('daily').split(','), Object.values(ARCHIVE_VARIABLES));
});

const upstream = (n = 3) => ({
    latitude: 40.02, longitude: -105.27, elevation: 1624, timezone: 'America/Denver', utc_offset_seconds: -25200,
    daily: {
        time: Array.from({ length: n }, (_, i) => 1767250800 + i * 86400),
        temperature_2m_max: [10, null, 12], temperature_2m_min: [0, 1, 'x'],
        temperature_2m_mean: [5, 6, 7], precipitation_sum: [0, 4.2, null],
        wind_speed_10m_max: [3, 4, 5], wind_gusts_10m_max: [8, 9, 10], et0_fao_evapotranspiration: [1, 1.1, 1.2],
    },
});

await ok('normalizeArchive: local-midnight ms, gaps null (never 0), coverage and distance reported', () => {
    const req = { lat: 40, lon: -105.25, fromYear: 1991 };
    const b = normalizeArchive(upstream(), req, NOW);
    assert.equal(b.daily.t[0], 1767250800000);
    assert.equal(b.daily.tmax[1], null);
    assert.equal(b.daily.tmin[2], null, 'a non-number is a gap');
    assert.equal(b.daily.precip[0], 0, 'a real zero stays zero');
    assert.equal(b.daily.precip[2], null);
    assert.equal(b.coverage, +(18 / 21).toFixed(4));
    assert.equal(b.site.utc_offset_seconds, -25200);
    assert.ok(b.site.distance_km > 0 && b.site.distance_km < 3);
    assert.equal(b.role, 'bootstrap', 'the body says it is the bootstrap source');
    assert.equal(normalizeArchive({ daily: { time: [] } }, req, NOW), null);
    assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.195) < 0.01);
});

const realFetch = globalThis.fetch;
const call = async (qs, stub) => {
    globalThis.fetch = stub;
    try { return await handler(new Request(`https://x/api/climalytix/archive?${qs}`)); }
    finally { globalThis.fetch = realFetch; }
};

await ok('handler: good upstream → 200 live with a long edge cache', async () => {
    let asked = null;
    const res = await call('lat=40.01&lon=-105.27', async (u) => { asked = String(u); return Response.json(upstream()); });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /s-maxage=43200/);
    const b = await res.json();
    assert.equal(b.freshness, 'live');
    assert.match(asked, /latitude=40\.00&longitude=-105\.25/, 'upstream asked for the SNAPPED site');
});

await ok('handler: every degraded upstream is 200 + expired, never a 5xx', async () => {
    for (const [label, stub] of [
        ['HTTP 429', async () => new Response('rate limited', { status: 429 })],
        ['throw', async () => { throw new TypeError('fetch failed'); }],
        ['empty', async () => Response.json({ daily: { time: [] } })],
    ]) {
        const res = await call('lat=40&lon=-105', stub);
        assert.equal(res.status, 200, `${label}: 200`);
        const b = await res.json();
        assert.equal(b.freshness, 'expired', `${label}: expired`);
        assert.equal(b.daily, null);
        assert.ok(b.reasons?.length === 1, `${label}: says why`);
        assert.match(res.headers.get('cache-control'), /s-maxage=120/, `${label}: short cache so it recovers`);
    }
    assert.match(degradedArchive(null, 'x', NOW).reasons[0], /x/);
});

await ok('handler: bad input is a 400', async () => {
    const res = await call('lat=abc&lon=0', async () => { throw new Error('must not be called'); });
    assert.equal(res.status, 400);
});

console.log(`\n${passed} passed`);
