#!/usr/bin/env node
/**
 * climalytix-aq-field.mjs — node gate for js/climalytix/aq-field.js and
 * api/climalytix/aq-field.js (upstream stubbed).
 *
 *   · the grid is the site's ±4° window on the 0.5° lattice, row-major from
 *     the NW, continuous across the dateline; one URL under the 414 ceiling
 *   · hours are matched BY INSTANT per location — NEGATIVE CONTROL: a
 *     location whose hours arrive in reverse order would be wrong if matched
 *     by position, and is right here; only 3-hourly UTC instants are kept
 *   · gaps stay null (a null PM2.5 is never 0), a missing variable is all
 *     null, and a wrong location count throws (no partial field)
 *   · colour is the EPA category of the PM2.5 sub-index at the breakpoints
 *   · residuals pair a monitor with the nearest field instant within 1.5 h,
 *     never further; bias and MAE are exact
 *   · alignByInstant joins two axes by instant, gaps null
 *   · the route: 200 fresh with the field; upstream 500 / short chunk /
 *     thrown fetch ⇒ 200 + expired + reasons, fields null; bad input 400
 *
 *   node tests/climalytix-aq-field.mjs
 */

import assert from 'node:assert/strict';
import {
    aqGrid, aqRequestUrls, aqFieldBody, aqPath, pm25Aqi, pm25Paint, residuals, residualSummary, alignByInstant,
    AQ_VARS, AQ_CADENCE_H,
} from '../js/climalytix/aq-field.js';
import { MAX_URL_BYTES } from '../js/open-meteo-request.js';
import { AQI_CATEGORIES } from '../js/aqi-scale.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix aq-field');

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 9, 14, 20);
const t0 = Math.floor(NOW / 86_400_000) * 86_400_000 - 86_400_000;           // midnight yesterday UTC
const hours = Array.from({ length: 24 * 6 }, (_, k) => t0 + k * H);
const pmAt = (lat, lon, ms) => +(8 + 0.5 * (lat - 40) + 0.25 * (lon + 105) + 4 * Math.sin(ms / (6 * H))).toFixed(2);

/** A synthetic Open-Meteo multi-location payload for a grid. */
function upstream(grid, { reverseAt = -1, gapAt = -1, dropVar = null } = {}) {
    return grid.lats.map((lat, p) => {
        const lon = grid.lons[p];
        let ts = hours.slice();
        if (p === reverseAt) ts = ts.reverse();
        const hourly = { time: ts.map((ms) => ms / 1000) };
        for (const v of AQ_VARS) {
            hourly[v.om] = ts.map((ms) => (p === gapAt && ms === t0 + 6 * H ? null : v.id === 'pm25' ? pmAt(lat, lon, ms) : 1));
        }
        if (dropVar) delete hourly[dropVar];
        return { latitude: lat, longitude: lon, hourly };
    });
}

await ok('the grid: ±4° on the 0.5° lattice, NW-first, continuous across the dateline; one URL under the 414 ceiling', () => {
    const g = aqGrid(40.015, -105.271);
    assert.equal(g.nRows, 17); assert.equal(g.nCols, 17);
    assert.equal(g.latN, 44); assert.equal(g.lonW, -109.5);
    assert.deepEqual([g.lats[0], g.lons[0]], [44, -109.5]);
    assert.deepEqual([g.lats.at(-1), g.lons.at(-1)], [36, -101.5]);
    const urls = aqRequestUrls(g);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].url.length < MAX_URL_BYTES);
    assert.match(urls[0].url, /hourly=pm2_5,ozone,nitrogen_dioxide,dust,aerosol_optical_depth/);
    assert.match(urls[0].url, /past_days=1&forecast_days=5/);
    const d = aqGrid(-17, 179.2);                       // Fiji: window crosses 180°
    assert.equal(d.lonW, 175);
    assert.ok(d.lons.every((x) => x >= -180 && x < 180), 'requested in [-180, 180)');
    assert.ok(d.lons.includes(-177), 'east of the dateline wraps for the request');
    assert.equal(aqPath({ lat: 40.015, lon: -105.271 }), '/api/climalytix/aq-field?lat=40.00&lon=-105.50');
});

await ok('hours matched BY INSTANT per location; only 3-hourly UTC instants; NEGATIVE CONTROL: reversed hours', () => {
    const g = aqGrid(40, -105);
    const body = aqFieldBody(g, upstream(g, { reverseAt: 5 }), { nowMs: NOW });
    assert.equal(body.times.length, 48, '6 days × 8 instants');
    assert.ok(body.times.every((ms) => ms % (AQ_CADENCE_H * H) === 0));
    const plane = g.nRows * g.nCols;
    for (const p of [0, 5, 100]) {
        for (const t of [0, 7, 47]) {
            assert.equal(body.values[t * plane + p], pmAt(g.lats[p], g.lons[p], body.times[t]), `p${p} t${t}`);
        }
    }
    // Matched by POSITION, location 5 would read its hours backwards.
    const byPosition = upstream(g, { reverseAt: 5 })[5].hourly.pm2_5[0];
    assert.notEqual(byPosition, body.values[0 * plane + 5], 'the reversed location is NOT read by position');
});

await ok('gaps stay null (never 0); a missing variable is all null; a wrong location count throws', () => {
    const g = aqGrid(40, -105);
    const plane = g.nRows * g.nCols;
    const body = aqFieldBody(g, upstream(g, { gapAt: 3 }), { nowMs: NOW });
    const t6 = body.times.indexOf(t0 + 6 * H);
    assert.equal(body.values[t6 * plane + 3], null);
    assert.ok(body.values[t6 * plane + 4] != null);
    const nod = aqFieldBody(g, upstream(g, { dropVar: 'dust' }), { nowMs: NOW });
    assert.ok(nod.fields.dust.every((x) => x === null));
    assert.ok(nod.fields.pm25.some((x) => x != null));
    assert.throws(() => aqFieldBody(g, upstream(g).slice(1), { nowMs: NOW }), /expected 289/);
    const empty = aqFieldBody(g, g.lats.map(() => ({ hourly: { time: [] } })), { nowMs: NOW });
    assert.equal(empty.freshness, 'expired', 'no values is not a healthy field');
});

await ok('colour = the EPA category of the PM2.5 sub-index, at the breakpoints', () => {
    const at = (pm) => { const d = new Uint8ClampedArray(4); pm25Paint(pm, d, 0); return [...d]; };
    const rgb = (k) => [...AQI_CATEGORIES[k].rgb.map((c) => Math.round(c * 255)), 255];
    assert.deepEqual(at(9.0), rgb(0));
    assert.deepEqual(at(9.1), rgb(1));
    assert.deepEqual(at(35.5), rgb(2));
    assert.deepEqual(at(55.5), rgb(3));
    assert.deepEqual(at(150), rgb(4));
    assert.deepEqual(at(null), [0, 0, 0, 0], 'a gap paints nothing');
    assert.equal(pm25Aqi(12), 56, '(100−51)/(35.4−9.1)·(12−9.1)+51 = 56.4 → 56');
});

await ok('residuals: nearest field instant within 1.5 h only; bias and MAE exact', () => {
    const times = [0, 3, 6].map((h) => t0 + h * H);
    const sample = (t, lat) => 10 + t + (lat - 40);
    const rows = residuals([
        { id: 'a', lat: 40, lon: -105, pm25: 12, validMs: t0 + 3 * H },          // t=1: model 11
        { id: 'b', lat: 41, lon: -105, pm25: 9, validMs: t0 + 4 * H },           // t=1 (1 h away): model 12
        { id: 'c', lat: 40, lon: -105, pm25: 9, validMs: t0 + 10 * H },          // 4 h past the last instant
        { id: 'd', lat: 40, lon: -105, pm25: null, validMs: t0 },
    ], times, sample);
    assert.deepEqual(rows.map((r) => r.diff), [-1, 3, null, null]);
    assert.deepEqual(residualSummary(rows), { n: 2, bias: 1, mae: 2 });
});

await ok('alignByInstant joins by instant, gaps null', () => {
    assert.deepEqual(alignByInstant([1, 2, 3], [10, null, 30], [3, 2, 9, 1]), [30, null, null, 10]);
});

// ── The route ────────────────────────────────────────────────────────────
const { default: handler } = await import('../api/climalytix/aq-field.js');
const call = async (qs) => { const r = await handler(new Request(`https://x.test/api/climalytix/aq-field?${qs}`)); return { status: r.status, body: await r.json() }; };
const realFetch = globalThis.fetch;
const realNow = Date.now;

await ok('route: 200 fresh with every variable on the window', async () => {
    Date.now = () => NOW;
    globalThis.fetch = async (u) => {
        const url = new URL(typeof u === 'string' ? u : u.url);
        assert.equal(url.hostname, 'air-quality-api.open-meteo.com');
        const lats = url.searchParams.get('latitude').split(',').map(Number);
        const lons = url.searchParams.get('longitude').split(',').map(Number);
        return Response.json(upstream({ lats, lons }));
    };
    const { status, body } = await call('lat=40.02&lon=-105.27');
    assert.equal(status, 200);
    assert.equal(body.freshness, 'fresh');
    assert.equal(body.role, 'bootstrap');
    assert.deepEqual(body.vars, ['pm25', 'o3', 'no2', 'dust', 'aod']);
    assert.equal(body.values.length, body.times.length * 289);
    assert.equal(body.values[0], pmAt(44, -109.5, body.times[0]), 'NW node of the window snapped to -105.5');
});

await ok('route: upstream 500 / short chunk / thrown fetch ⇒ 200 + expired + reasons, never a partial field; bad input 400', async () => {
    for (const bad of [
        async () => new Response('nope', { status: 500 }),
        async () => Response.json([{ hourly: { time: [] } }]),
        async () => { throw new Error('network down'); },
    ]) {
        globalThis.fetch = bad;
        const { status, body } = await call('lat=40&lon=-105');
        assert.equal(status, 200);
        assert.equal(body.freshness, 'expired');
        assert.equal(body.fields, null);
        assert.match(body.reasons[0], /^upstream_failed/);
    }
    assert.equal((await call('lat=x&lon=0')).status, 400);
    globalThis.fetch = realFetch; Date.now = realNow;
});

console.log(`\n${passed} passed`);
