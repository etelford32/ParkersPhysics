#!/usr/bin/env node
/**
 * climalytix-nwp-route.mjs — node gate for /api/climalytix/nwp.
 *
 * The handler runs for real against a FAKE R2 bucket served by a stubbed
 * `fetch` (presigned URLs and all — no network in CI). The bucket holds the
 * cross-language tile fixture (tests/fixtures/climalytix/tile/, written by
 * tiles.py from a real GFS message) under a `latest` pointer, so the route's
 * answer must equal the bilinear value Python computed. Then every degraded
 * path: R2 unset, no run published, a tile that will not read, an old run —
 * each a 200 with the right freshness, never a 5xx. Bad input is a 400.
 *
 *   node tests/climalytix-nwp-route.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const DIR = new URL('./fixtures/climalytix/tile/', import.meta.url);
const man = JSON.parse(readFileSync(new URL('manifest.json', DIR)));
const { points } = JSON.parse(readFileSync(new URL('expected.json', DIR)));

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ── A fake bucket behind the presigned-URL fetch ────────────────────────────
const BUCKET = 'pp-test';
let objects = new Map();
let requests = [];
function resetBucket({ runMs = Date.now() - 6 * 3600_000, publish = true, rename = null } = {}) {
    objects = new Map();
    requests = [];
    const m = { ...man, runMs };
    if (rename) m.vars = m.vars.map((v) => ({ ...v, id: rename[v.id] ?? v.id }));
    for (const f of readdirSync(DIR)) {
        if (f.endsWith('.i16')) objects.set(`fixture/t/${f}`, new Uint8Array(readFileSync(new URL(f, DIR))));
    }
    objects.set('fixture/manifest.json.gz', gzipSync(JSON.stringify(m)));
    if (publish) {
        objects.set('climalytix/nwp/gfs/1p00/latest.json.gz',
            gzipSync(JSON.stringify({ schema: 'climalytix.latest.v1', run: m.run, runMs, manifest: 'fixture/manifest.json.gz' })));
    }
}
globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    assert.ok(u.searchParams.get('X-Amz-Signature'), 'every R2 read is presigned');
    const key = decodeURIComponent(u.pathname.slice(`/${BUCKET}/`.length));
    const range = init.headers?.Range;
    requests.push({ key, range });
    const body = objects.get(key);
    if (!body) return new Response('NoSuchKey', { status: 404 });
    if (range) {
        const [, a, b] = range.match(/^bytes=(\d+)-(\d+)$/);
        return new Response(body.subarray(Number(a), Number(b) + 1), { status: 206 });
    }
    return new Response(body, { status: 200 });
};

async function call(qs, route = 'nwp') {
    const { default: handler } = await import(`../api/climalytix/${route}.js`);
    const { _resetCache } = await import('../api/_lib/climalytix-r2.js');
    _resetCache();
    const res = await handler(new Request(`https://x.test/api/climalytix/${route}?${qs}`));
    return { status: res.status, body: await res.json() };
}

console.log('climalytix nwp route');

// R2 unset: r2-client reads its env ONCE at import, so this path runs in a
// clean child process with the four secrets removed.
await ok('R2 not configured → 200 + expired + reason (a dry run is not a healthy route)', async () => {
    const { execFileSync } = await import('node:child_process');
    const env = { ...process.env };
    for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) delete env[k];
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { default: h } = await import(${JSON.stringify(new URL('../api/climalytix/nwp.js', import.meta.url).href)});
        const r = await h(new Request('https://x.test/api/climalytix/nwp?lat=40&lon=-105'));
        console.log(JSON.stringify({ status: r.status, body: await r.json() }));`], { env, encoding: 'utf8' });
    const { status, body } = JSON.parse(out);
    assert.equal(status, 200);
    assert.equal(body.freshness, 'expired');
    assert.deepEqual(body.reasons, ['r2_not_configured']);
    assert.equal(body.series, null);
});

Object.assign(process.env, {
    R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: BUCKET,
    R2_ENDPOINT: 'https://r2.test',
});

await ok('a site is two range reads on one tile and equals Python’s bilinear value', async () => {
    resetBucket();
    const p = points.find((x) => x.name === 'Boulder');
    const { status, body } = await call(`lat=${p.lat}&lon=${p.lon}&grid=1p00`);
    assert.equal(status, 200);
    assert.equal(body.freshness, 'fresh');
    assert.ok(body.age_seconds > 5 * 3600 && body.age_seconds < 7 * 3600, 'age = now − run time');
    const tileReads = requests.filter((r) => r.key.endsWith('.i16'));
    assert.equal(tileReads.length, 2);
    assert.ok(tileReads.every((r) => r.key === 'fixture/t/r02-c12.i16' && r.range));
    // The route rounds the site to 0.01° for its cache key; compare at that site.
    assert.equal(body.site.lat, 40.02);
    assert.equal(body.site.lon, -105.27);
    assert.ok(Math.abs(body.series.tempC[0] - p.values[0][0]) < 0.05, `${body.series.tempC[0]} vs ${p.values[0][0]}`);
    assert.equal(body.series.col[0], p.values[2][0], 'column index at the same longitude is exact');
    assert.deepEqual(body.times, man.times);
    assert.equal(body.role, 'archive');
});

await ok('the seam west of Greenwich reads through the wrapped halo', async () => {
    resetBucket();
    const p = points.find((x) => x.name.startsWith('seam west'));
    const { body } = await call(`lat=${p.lat}&lon=${p.lon}&grid=1p00`);
    assert.ok(requests.some((r) => r.key === 'fixture/t/r01-c17.i16'));
    assert.ok(Math.abs(body.series.tempC[0] - p.values[0][0]) < 1e-3);
});

await ok('no run published yet → 200 + expired + no_run_published', async () => {
    resetBucket({ publish: false });
    const { status, body } = await call('lat=40&lon=-105&grid=1p00');
    assert.equal(status, 200);
    assert.deepEqual(body.reasons, ['no_run_published']);
});

await ok('a tile that will not read → 200 + expired, nothing substituted', async () => {
    resetBucket();
    objects.delete('fixture/t/r02-c12.i16');
    const { status, body } = await call('lat=40.015&lon=-105.27&grid=1p00');
    assert.equal(status, 200);
    assert.equal(body.freshness, 'expired');
    assert.match(body.reasons[0], /^tile_read_failed/);
    assert.equal(body.series, null);
});

await ok('an old run is served but says so: stale at 40 h, expired at 60 h', async () => {
    resetBucket({ runMs: Date.now() - 40 * 3600_000 });
    assert.equal((await call('lat=40&lon=-105&grid=1p00')).body.freshness, 'stale');
    resetBucket({ runMs: Date.now() - 60 * 3600_000 });
    const { body } = await call('lat=40&lon=-105&grid=1p00');
    assert.equal(body.freshness, 'expired');
    assert.ok(Array.isArray(body.series.tempC), 'the data is still returned, flagged');
});

await ok('bad input is a 400', async () => {
    assert.equal((await call('lat=x&lon=0')).status, 400);
    assert.equal((await call('lat=0&lon=200')).status, 400);
    assert.equal((await call('lat=0&lon=0&grid=9p99')).status, 400);
});

await ok('the field route returns every node in the window, one range per row, matching the point route', async () => {
    resetBucket();
    const { status, body } = await call('lat=40.00&lon=-105.25&half=3&grid=1p00', 'nwp-field');
    assert.equal(status, 200);
    assert.equal(body.freshness, 'fresh');
    assert.equal(body.var, 'tempC');
    assert.equal(body.layout, 'time,row,col');
    assert.equal(body.values.length, body.times.length * body.nRows * body.nCols);
    assert.equal(body.latN, 43);
    assert.equal(body.lonW, -108);
    const tileReads = requests.filter((r) => r.key.endsWith('.i16'));
    assert.equal(tileReads.length, body.nRows, 'one range per row inside one tile');
    assert.ok(tileReads.every((r) => r.range));
    // Bilinear on the field's nodes at the point route's own site = the point route's value.
    const pt = (await call('lat=40.00&lon=-105.25&grid=1p00')).body.series.tempC[0];
    const y = (body.latN - 40) / body.dlat, x = (-105.25 - body.lonW) / body.dlon;
    const i = Math.floor(y), j = Math.floor(x), fy = y - i, fx = x - j;
    const at = (a, b) => body.values[a * body.nCols + b];
    const v = (1 - fy) * ((1 - fx) * at(i, j) + fx * at(i, j + 1)) + fy * ((1 - fx) * at(i + 1, j) + fx * at(i + 1, j + 1));
    assert.ok(Math.abs(v - pt) < 0.06, `field ${v} vs point ${pt} (0.1-rounded on the wire)`);
});

await ok('vars=uMs,vMs: both components from the SAME byte ranges, each landing on its own node', async () => {
    // The fixture (written by the Python gate) carries tempC plus two
    // IDENTITY variables, `row` and `col` = each node's global index. Renamed
    // to uMs/vMs here, every value must equal its own node's index — a read
    // from the wrong variable slot or the wrong node cannot pass.
    resetBucket({ rename: { row: 'uMs', col: 'vMs' } });
    const n0 = requests.length;
    const { status, body } = await call('lat=40.00&lon=-105.25&half=3&grid=1p00&vars=uMs,vMs', 'nwp-field');
    assert.equal(status, 200);
    assert.deepEqual(body.vars, ['uMs', 'vMs'], JSON.stringify(body.reasons));
    assert.equal(body.var, 'uMs');
    assert.deepEqual(body.values, body.fields.uMs, 'values is the first variable');
    const reads = requests.slice(n0).filter((r) => r.key.endsWith('.i16'));
    assert.equal(reads.length, body.nRows, 'a second variable costs no extra read');
    const plane = body.nRows * body.nCols;
    for (let t = 0; t < body.times.length; t += 20) {
        for (let i = 0; i < body.nRows; i++) for (let j = 0; j < body.nCols; j++) {
            const row = (90 - (body.latN - i * body.dlat)) / body.dlat;
            const col = ((((body.lonW + j * body.dlon) % 360) + 360) % 360) / body.dlon;
            assert.equal(body.fields.uMs[t * plane + i * body.nCols + j], row, `row at ${i},${j}`);
            assert.equal(body.fields.vMs[t * plane + i * body.nCols + j], col, `col at ${i},${j}`);
        }
    }
    assert.equal((await call('lat=40&lon=-105&vars=uMs,secretVar', 'nwp-field')).status, 400, 'unknown variable');
    resetBucket();
    const missing = await call('lat=40.00&lon=-105.25&grid=1p00&vars=uMs,vMs', 'nwp-field');
    assert.equal(missing.body.fields, null, 'a run without the variable: no field, never a partial one');
    assert.match(missing.body.reasons[0], /no variable [uv]Ms/);
    const plain = await call('lat=40.00&lon=-105.25&half=3&grid=1p00', 'nwp-field');
    assert.equal(plain.body.fields, undefined, 'the default request keeps the original body');
});

await ok('the field route degrades like the point route, and refuses a bad window', async () => {
    resetBucket({ publish: false });
    const a = await call('lat=40&lon=-105&grid=1p00', 'nwp-field');
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.reasons, ['no_run_published']);
    assert.equal(a.body.values, null);
    resetBucket();
    objects.delete('fixture/t/r02-c12.i16');
    const b = await call('lat=40&lon=-105.25&grid=1p00', 'nwp-field');
    assert.match(b.body.reasons[0], /^tile_read_failed/);
    assert.equal(b.body.values, null, 'never a partial field');
    assert.equal((await call('lat=40&lon=-105&half=9', 'nwp-field')).status, 400);
    assert.equal((await call('lat=x&lon=0', 'nwp-field')).status, 400);
});

console.log(`\n${passed} passed`);
