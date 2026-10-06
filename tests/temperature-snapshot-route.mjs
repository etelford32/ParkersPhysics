/**
 * tests/temperature-snapshot-route.mjs — /api/temperature/snapshot
 *
 *   node tests/temperature-snapshot-route.mjs
 *
 * The route against a stubbed Supabase and the REAL shipped normals (served
 * from disk through the same fetch the route uses on its own origin). Gates:
 *   • a healthy aggregate → freshness 'live', five cards, 2592-cell arrays
 *   • a fallback source / an old window / thin coverage → 'stale' + the reason
 *   • a missing table (migration not applied), an empty table, a malformed
 *     payload or unreachable normals → a 200 with 'expired' — NEVER a 5xx —
 *     and a note that names the cause
 *   • an asset outage does not poison the isolate: the next request recovers
 *   • ?surface=ocean reaches the model
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CELLS, dailyNormal, parseNormalsAsset } from '../js/temperature-normals.js';
import { freshnessOf, normalizeLabRow } from '../api/_lib/temperature-snapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SB = 'https://sb.test';
process.env.SUPABASE_URL = SB;
process.env.SUPABASE_SERVICE_KEY = 'service-key';
const { default: route } = await import('../api/temperature/snapshot.js');

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('temperature-snapshot-route.mjs');

const daily = parseNormalsAsset(new Uint8Array(readFileSync(join(ROOT, 'assets/temperature/normals-1991-2020.bin'))));
const realFetch = globalThis.fetch;

/** A cache row for a planet sitting on its normal, window ending `frameTo`. */
function row({ frameTo = new Date(Date.now() - 30 * 60e3).toISOString(), sources = { 'open-meteo:72x36': 24 }, holes = 0 } = {}) {
    const mid = Date.parse(frameTo) - 11.5 * 3600e3;
    const p = { t24max: [], t24min: [], t24mean: [], tnow: [], prev24mean: [], n24: [] };
    for (let c = 0; c < CELLS; c++) {
        const dn = dailyNormal(daily, c, mid);
        const hole = c < holes;
        p.t24max.push(hole ? null : dn.tmax.mean); p.t24min.push(hole ? null : dn.tmin.mean);
        p.t24mean.push(hole ? null : dn.tmean.mean); p.tnow.push(dn.tmean.mean);
        p.prev24mean.push(dn.tmean.mean); p.n24.push(hole ? 0 : 24);
    }
    return { computed_at: frameTo, frame_from: frameTo, frame_to: frameTo, n_frames: 24, sources, payload: p };
}

/** `db`: rows array | {status} ; `assets`: true to serve the files, or an HTTP status. */
function stub({ db, assets = true }) {
    const seen = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        seen.push(u);
        if (u.startsWith(`${SB}/rest/v1/temperature_lab_cache`)) {
            if (!Array.isArray(db)) return new Response('{"message":"relation does not exist"}', { status: db.status });
            return Response.json(db);
        }
        const m = /\/assets\/temperature\/([\w.-]+\.bin)$/.exec(new URL(u).pathname);
        if (m) {
            if (assets !== true) return new Response('nope', { status: assets });
            return new Response(readFileSync(join(ROOT, 'assets/temperature', m[1])), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    return seen;
}
const restore = () => { globalThis.fetch = realFetch; };
const call = async (qs = '') => {
    const res = await route(new Request(`https://lab.test/api/temperature/snapshot${qs}`));
    return { res, body: await res.json() };
};

await ok('an asset outage is a 200 + expired, and does not poison the isolate', async () => {
    try {
        stub({ db: [row()], assets: 404 });
        const a = await call();
        assert.equal(a.res.status, 200);
        assert.equal(a.body.freshness, 'expired');
        assert.deepEqual(a.body.reasons, ['normals-unavailable']);
        assert.match(a.body.note, /normals unavailable/);
        assert.match(a.res.headers.get('cache-control'), /s-maxage=60\b/, 'a degraded answer is cached briefly');
        stub({ db: [row()] });
        const b = await call();
        assert.equal(b.body.freshness, 'live', 'the next request retries the load and recovers');
    } finally { restore(); }
});

await ok('a healthy aggregate → live, five cards, 2592-cell arrays, rounded', async () => {
    try {
        const seen = stub({ db: [row()] });
        const { res, body } = await call();
        assert.equal(res.status, 200);
        assert.equal(body.freshness, 'live');
        assert.deepEqual(body.reasons, []);
        assert.deepEqual(Object.keys(body.cards).sort(), ['above', 'below', 'coldest', 'hottest', 'swings']);
        assert.equal(body.grid.anomalyK.length, CELLS);
        assert.equal(body.grid.percentile.length, CELLS);
        assert.ok(body.grid.anomalyK.every(v => v === null || Math.abs(v * 10 - Math.round(v * 10)) < 1e-9));
        assert.ok(Math.abs(body.planet.anomalyK) < 0.01);
        assert.equal(body.planet.decileExpected, 0.1);
        assert.match(body.disclosure.liveField, /not station observations/);
        assert.match(res.headers.get('cache-control'), /s-maxage=900\b/);
        assert.ok(!seen.some(u => u.includes('/assets/')), 'the normals stayed cached in module scope');
        assert.ok(body.cards.hottest.length > 0 && body.cards.hottest.length <= 25);
    } finally { restore(); }
});

await ok('a fallback source in the window → stale, with the disclosure', async () => {
    try {
        stub({ db: [row({ sources: { 'met-norway:72x36': 24 } })] });
        const { body } = await call();
        assert.equal(body.freshness, 'stale');
        assert.ok(body.reasons.includes('fallback-source'));
        assert.equal(body.disclosure.fallbackSource, true);
        assert.match(body.disclosure.note, /understates extremes/);
    } finally { restore(); }
});

await ok('an old window and thin coverage are each named', async () => {
    try {
        stub({ db: [row({ frameTo: new Date(Date.now() - 5 * 3600e3).toISOString(), holes: 600 })] });
        const { body } = await call();
        assert.equal(body.freshness, 'stale');
        assert.ok(body.reasons.includes('window-old'));
        assert.ok(body.reasons.includes('low-coverage'));
    } finally { restore(); }
});

await ok('the migration not applied / an empty table / a malformed payload → 200 + expired, never 5xx', async () => {
    try {
        stub({ db: { status: 404 } });
        const a = await call();
        assert.equal(a.res.status, 200);
        assert.equal(a.body.freshness, 'expired');
        assert.match(a.body.note, /migration\.sql applied/);
        assert.equal(a.body.cards, null);

        stub({ db: [] });
        const b = await call();
        assert.equal(b.body.freshness, 'expired');
        assert.match(b.body.note, /runs hourly at :25/);

        const bad = row(); bad.payload.t24mean = bad.payload.t24mean.slice(0, 100);
        stub({ db: [bad] });
        const c = await call();
        assert.equal(c.body.freshness, 'expired', 'a short array is refused, never padded');
    } finally { restore(); }
});

await ok('?surface=ocean reaches the model; an unknown surface falls back to land', async () => {
    try {
        stub({ db: [row()] });
        const o = await call('?surface=ocean');
        assert.equal(o.body.surface, 'ocean');
        assert.ok(o.body.cards.hottest.every(r => r.landPct < 50));
        const x = await call('?surface=mars');
        assert.equal(x.body.surface, 'land');
    } finally { restore(); }
});

await ok('normalizeLabRow: numeric strings become numbers, gaps stay null, no frame_to is refused', async () => {
    const r = row();
    r.payload.t24max[0] = '31.25'; r.payload.t24max[1] = 'NaN'; r.payload.t24max[2] = '';
    const s = normalizeLabRow(r);
    assert.equal(s.t24max[0], 31.25);
    assert.equal(s.t24max[1], null);
    assert.equal(s.t24max[2], null);
    assert.equal(normalizeLabRow({ ...r, frame_to: null }), null);
    assert.equal(normalizeLabRow(null), null);
});

await ok('freshnessOf: no aggregate and no normals are both expired, in that order', async () => {
    assert.deepEqual(freshnessOf({ snapshot: null, model: null, normalsOk: false, nowMs: 0 }),
        { freshness: 'expired', reasons: ['no-aggregate'] });
    assert.deepEqual(freshnessOf({ snapshot: { frame_to: new Date().toISOString() }, model: null, normalsOk: false, nowMs: Date.now() }),
        { freshness: 'expired', reasons: ['normals-unavailable'] });
});

console.log(`\n${passed} passed`);
