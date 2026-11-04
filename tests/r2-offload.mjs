/**
 * tests/r2-offload.mjs — SUPABASE_OFFLOAD_PLAN.md Phases A2 / B / C.
 *
 *   node tests/r2-offload.mjs
 *
 * No network: every Supabase and R2 call is answered by a stubbed fetch, and
 * the R2 secrets are FAKE values set before any module loads (r2-client reads
 * them at import). What it pins:
 *
 *   1. The stats kernel IS Postgres: percentile_cont / avg over float4 match
 *      numbers Postgres 17 returned for the same sample (production query,
 *      2026-11-04), cells are keyed by lat/lon not array position, and the
 *      frame selection reproduces what trim_weather_grid_cache() leaves
 *      (288 frames over 30 days, NOT the 719 hourly frames R2 will hold —
 *      the negative control).
 *   2. THE SAFETY ORDER: the sweep writes an index row only AFTER its R2 PUT
 *      succeeded; a failed PUT leaves no index row (so the archive-gated
 *      trims can never delete something that is not in R2).
 *   3. The grid range read takes archived frames from R2 and asks Postgres
 *      for payloads ONLY of frames not yet archived; an R2 failure falls
 *      back to Postgres.
 *   4. The minute-dataset reader answers old days from sealed R2 files and
 *      never touches R2 for recent windows.
 */

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.R2_ACCOUNT_ID = 'acct';
process.env.R2_ACCESS_KEY_ID = 'AKIDTEST';
process.env.R2_SECRET_ACCESS_KEY = 'secret';
process.env.R2_BUCKET = 'bucket';

const assert = (await import('node:assert/strict')).default;
const A = await import('../api/_lib/r2-archive.js');
const S = await import('../api/_lib/weather-cell-stats.js');
const store = await import('../api/_lib/sw-geomag-store.js');
const sweep = await import('../api/cron/archive-sweep.js');
const statsCron = await import('../api/cron/weather-cell-stats.js');
const { default: gridRoute } = await import('../api/weather/grid.js');

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const realFetch = globalThis.fetch;
const H = 3_600_000, DAY = 86_400_000;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

// ── 1. the stats kernel is Postgres ─────────────────────────────────────────
await ok('percentile_cont / avg over float4 match Postgres 17 to the last digit it printed', () => {
    // select count(x), avg(x), percentile_cont(...) from (values (12.3::real), ... , (null::real))
    const raw = [12.3, -4.7, 0.1, 33.9, 7.25, 7.25, -0.05, 18.6, 2.2, 9.9, null];
    const acc = S.createCellAccumulator();
    for (const v of raw) acc.addFrame([{ latitude: 1, longitude: 2, current: { temperature_2m: v } }]);
    const [r] = acc.rows();
    assert.equal(r.n_t, 10, 'the null is skipped, as count(t) skips it');
    near(r.t_mean, 8.67500019557774, 1e-14);
    near(r.t_p01, -4.28149982649833, 1e-14);
    near(r.t_p05, -2.6074998954311, 1e-14);
    near(r.t_p95, 27.0150010108948, 1e-14);
    near(r.t_p99, 32.5230014228821, 1e-14);
    assert.equal(r.t_min, Math.fround(-4.7));
    assert.equal(r.t_max, Math.fround(33.9));
    // Negative control: double-precision inputs (no ::real) miss Postgres.
    const dbl = raw.filter(v => v != null).sort((a, b) => a - b);
    assert.ok(Math.abs(S.percentileCont(dbl, 0.95) - 27.0150010108948) > 1e-7, 'float4 casting is load-bearing');
});

await ok('cells are keyed by round(lat,2)/round(lon,2), never by array position; empty samples give nulls', () => {
    const f1 = [{ latitude: -87.5, longitude: -177.5, current: { temperature_2m: 1, wind_speed_10m: 2, precipitation: 0 } },
                { latitude: 2.5,   longitude: 2.5,    current: { temperature_2m: 10 } }];
    const f2 = [f1[1], f1[0]].map(c => ({ ...c, current: { ...c.current, temperature_2m: c.current.temperature_2m + 1 } }));
    const acc = S.createCellAccumulator();
    acc.addFrame(f1); acc.addFrame(f2);
    const rows = acc.rows();
    assert.equal(rows.length, 2);
    const south = rows.find(r => r.lat === -87.5);
    assert.deepEqual([south.n_t, south.t_min, south.t_max], [2, 1, 2]);
    const eq = rows.find(r => r.lat === 2.5);
    assert.equal(eq.w_p95, null, 'no wind sample → null, like percentile_cont over an empty set');
    assert.equal(S.round2(-0.125), -0.13, 'numeric round is half AWAY from zero');
    assert.equal(S.round2(0.125), 0.13);
});

const hourly = (newestMs, hours) => Array.from({ length: hours }, (_, i) =>
    ({ fetched_at: new Date(newestMs - i * H).toISOString(), r2_key: `k${i}` }));

await ok('frame selection reproduces the SQL pass\'s decimated window (288), excluding the newest', () => {
    const newest = Date.UTC(2026, 10, 3, 12, 1);
    const frames = hourly(newest, 40 * 24);              // R2 holds every hour
    const sel = S.selectStatsFrames(frames, { newestMs: newest, nowMs: newest + 5 * 60e3 });
    assert.ok(!sel.some(f => Date.parse(f.fetched_at) === newest), 'newest excluded');
    assert.ok(Math.abs(sel.length - S.expectedStatsFrames()) <= 1, `${sel.length} ≈ ${S.expectedStatsFrames()}`);
    assert.ok(sel.length < 300 && frames.filter(f => Date.parse(f.fetched_at) > newest - 30 * DAY).length > 700,
        'negative control: without the trim mirror the sample would be ~720 hourly frames');
    const old = sel.filter(f => Date.parse(f.fetched_at) <= newest - 72 * H);
    assert.ok(old.every(f => new Date(f.fetched_at).getUTCHours() % 3 === 0), 'older than 72 h: 3-hourly only');
});

await ok('coverage gate: refuses a partial archive, accepts a full window', () => {
    const newest = Date.UTC(2026, 10, 3, 12, 1);
    const full = S.selectStatsFrames(hourly(newest, 31 * 24), { newestMs: newest, nowMs: newest });
    assert.equal(statsCron.coverageVerdict(full, { newestMs: newest, nowMs: newest }).ok, true);
    const week = S.selectStatsFrames(hourly(newest, 7 * 24), { newestMs: newest, nowMs: newest });
    const v = statsCron.coverageVerdict(week, { newestMs: newest, nowMs: newest });
    assert.equal(v.ok, false); assert.equal(v.reaches, false);
});

// ── keys, gzip, planning ────────────────────────────────────────────────────
await ok('object keys, gzip round trip, NDJSON', async () => {
    assert.equal(A.weatherFrameKey('2026-11-03T19:01:03.272401+00:00'), 'weather/grid/2026/11/03/2026-11-03T19-01-03.272Z.json.gz');
    assert.equal(A.swGeomagDayKey('2026-07-04'), 'datasets/sw-geomag/2026/07/04.ndjson.gz');
    assert.throws(() => A.swGeomagDayKey('2026-7-4'));
    const text = JSON.stringify({ a: 'x'.repeat(5000) });
    const gz = await A.gzipText(text);
    assert.ok(gz.byteLength < 200);
    assert.equal(await A.gunzipText(gz), text);
    assert.deepEqual(A.parseNdjson(A.toNdjson([{ t: 1 }, { t: 2 }])), [{ t: 1 }, { t: 2 }]);
});

await ok('range plan prefers R2, matches instants across spellings, keeps the first `limit` ascending', () => {
    const plan = A.planRangeSources(
        ['2026-11-03T10:00:00+00:00', '2026-11-03T11:00:00+00:00', '2026-11-03T12:00:00+00:00'],
        ['2026-11-03T09:00:00.000Z', '2026-11-03T10:00:00Z'], 3);
    assert.deepEqual(plan.map(p => p.from), ['r2', 'r2', 'db']);
    assert.equal(plan[1].dbAlso, true, 'the same instant in both stores is one frame');
});

await ok('sweep planning: frames newest-first by instant; days sealed only past the horizon', () => {
    assert.deepEqual(sweep.framesToArchive(
        ['2026-11-03T10:00:00+00:00', '2026-11-03T11:00:00+00:00'], ['2026-11-03T10:00:00Z']),
        ['2026-11-03T11:00:00+00:00']);
    const now = Date.UTC(2026, 10, 4, 3, 0);
    const days = sweep.daysToSeal('2026-10-30T00:00:00+00:00', ['2026-10-31'], now);
    assert.deepEqual(days, ['2026-10-30', '2026-11-01', '2026-11-02'], '11-02 ended 27 h ago (> 26 h) → sealed; 11-03 ended 3 h ago → not yet');
    assert.ok(!sweep.daysToSeal('2026-11-03T00:00:00Z', [], now).length);
});

await ok('day helpers: coverage, missing days, merge de-duplicates by instant', () => {
    const s = Date.UTC(2026, 9, 1, 18), e = Date.UTC(2026, 9, 3, 6);
    assert.deepEqual(A.utcDaysCovering(s, e), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.deepEqual(A.daysMissingFrom([{ t: '2026-10-02T00:00:00+00:00' }], s, e), ['2026-10-01', '2026-10-03']);
    const m = A.mergeByT([{ t: '2026-10-02T00:01:00+00:00', v: 'db' }], [{ t: '2026-10-02T00:01:00Z', v: 'r2' }, { t: '2026-10-01T00:00:00Z' }]);
    assert.deepEqual(m.map(r => r.v ?? '-'), ['-', 'db']);
});

// ── a fake world: Supabase + R2 behind one fetch ────────────────────────────
function world() {
    const w = { r2: new Map(), puts: [], inserts: [], sbGets: [], failPut: false, failGet: false, rpcs: [] };
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = (init.method ?? 'GET').toUpperCase();
        if (url.host === 'acct.r2.cloudflarestorage.com') {
            const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''));
            if (method === 'PUT') {
                if (w.failPut) return new Response('nope', { status: 500 });
                w.puts.push(key); w.r2.set(key, new Uint8Array(init.body));
                return new Response('', { status: 200, headers: { etag: '"e"' } });
            }
            if (w.failGet) return new Response('', { status: 500 });
            return w.r2.has(key) ? new Response(w.r2.get(key)) : new Response('', { status: 404 });
        }
        const path = url.pathname.replace('/rest/v1/', '');
        if (path.startsWith('rpc/')) { w.rpcs.push(path.slice(4)); return new Response(path.includes('trim_sw') ? '0' : '', { status: 200 }); }
        if (method === 'POST') { w.inserts.push({ table: path, row: JSON.parse(init.body) }); return new Response('', { status: 201 }); }
        w.sbGets.push(decodeURIComponent(url.search));
        return Response.json(w.onGet(path, url.searchParams) ?? []);
    };
    return w;
}
const cronReq = (q = '') => new Request(`https://x.test/api/cron/archive-sweep${q}`, { headers: { 'x-vercel-cron': '1' } });

await ok('THE SAFETY ORDER: PUT then index; a failed PUT writes no index row', async () => {
    const frame = { fetched_at: '2026-11-03T10:00:03.1+00:00', source: 'open-meteo:72x36', payload: [{ current: { pressure_msl: 1000 } }] };
    for (const failPut of [false, true]) {
        const w = world();
        w.failPut = failPut;
        w.onGet = (path, q) => {
            if (path === 'weather_grid_cache' && q.get('select') === 'fetched_at') return q.get('offset') === '0' ? [{ fetched_at: frame.fetched_at }] : [];
            if (path === 'weather_grid_cache') return [frame];
            if (path === 'sw_geomag_dataset') return [];
            return [];
        };
        const res = await sweep.default(cronReq());
        const body = await res.json();
        if (!failPut) {
            assert.equal(res.status, 200, JSON.stringify(body));
            assert.deepEqual(w.puts, [A.weatherFrameKey(frame.fetched_at)]);
            const ix = w.inserts.find(i => i.table === 'weather_grid_archive');
            assert.equal(ix.row.r2_key, w.puts[0]);
            assert.equal(ix.row.pressure_kind, 'msl');
            assert.equal(JSON.parse(await A.gunzipText(w.r2.get(w.puts[0]))).fetched_at, frame.fetched_at, 'the object is the whole row');
            assert.ok(w.rpcs.includes('trim_weather_grid_cache') && w.rpcs.includes('trim_sw_geomag_dataset'));
        } else {
            assert.equal(res.status, 502);
            assert.equal(w.inserts.filter(i => i.table === 'weather_grid_archive').length, 0, 'no index row for an upload that failed');
            assert.ok(w.rpcs.includes('record_pipeline_failure'));
        }
    }
    globalThis.fetch = realFetch;
});

await ok('the sweep seals a complete UTC day as NDJSON and indexes it', async () => {
    const day = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
    const rows = [0, 1, 2].map(m => ({ t: `${day}T00:0${m}:00+00:00`, sw_flag: 'ok' }));
    const w = world();
    w.onGet = (path, q) => {
        if (path === 'weather_grid_cache') return [];
        if (path === 'sw_geomag_dataset' && q.get('limit') === '1') return [{ t: rows[0].t }];
        if (path === 'sw_geomag_archive') return [];
        if (path === 'sw_geomag_dataset') return q.get('t') ? rows : [];
        return [];
    };
    // the dataset query carries two `t=` filters; serve the rows for the day asked
    w.onGet = ((orig) => (path, q) => {
        if (path === 'sw_geomag_dataset' && q.getAll('t').length === 2) {
            const a = q.getAll('t')[0].slice(4);
            return a.startsWith(day) && q.get('offset') === '0' ? rows : [];
        }
        return orig(path, q);
    })(w.onGet);
    const res = await sweep.default(cronReq());
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const ix = w.inserts.find(i => i.table === 'sw_geomag_archive' && i.row.day === day);
    assert.ok(ix, 'the oldest complete day was sealed');
    assert.equal(ix.row.rows, 3);
    assert.deepEqual(A.parseNdjson(await A.gunzipText(w.r2.get(ix.row.r2_key))), rows);
    globalThis.fetch = realFetch;
});

// ── 3. grid range read ──────────────────────────────────────────────────────
await ok('range mode: archived frames come from R2; Postgres is asked for payloads only of the rest', async () => {
    const t = (h) => new Date(Date.UTC(2026, 10, 3, h)).toISOString().replace('Z', '+00:00');
    const mk = (h) => ({ fetched_at: t(h), source: 'open-meteo:72x36', payload: [{ current: { temperature_2m: h, pressure_msl: 1000 } }] });
    for (const failGet of [false, true]) {
        const w = world();
        w.failGet = failGet;
        for (const h of [8, 9]) w.r2.set(A.weatherFrameKey(t(h)), await A.gzipText(JSON.stringify(mk(h))));
        const payloadAsks = [];
        w.onGet = (path, q) => {
            if (path === 'weather_grid_archive') return [8, 9].map(h => ({ fetched_at: t(h), r2_key: A.weatherFrameKey(t(h)) }));
            if (path === 'weather_grid_cache' && q.get('select') === 'fetched_at') return [9, 10].map(h => ({ fetched_at: t(h) }));
            if (path === 'weather_grid_cache') {
                payloadAsks.push(q.get('fetched_at'));
                const asked = q.get('fetched_at');
                return [9, 10].filter(h => asked.includes(t(h))).map(mk);
            }
            return [];
        };
        const since = encodeURIComponent(t(0));
        const body = await (await gridRoute(new Request(`https://x.test/api/weather/grid?since=${since}&limit=72`))).json();
        assert.deepEqual(body.frames.map(f => f.data[0].current.temperature_2m), failGet ? [9, 10] : [8, 9, 10]);
        if (!failGet) {
            assert.deepEqual(body.store, { r2: 2, db: 1, missing: 0 });
            assert.equal(payloadAsks.length, 1);
            assert.ok(payloadAsks[0].includes(t(10)) && !payloadAsks[0].includes(t(9)), 'no payload read for an archived frame');
        } else {
            assert.deepEqual(body.store, { r2: 0, db: 2, missing: 1 }, 'R2 down: falls back where Postgres still has the row, drops (and counts) the one it does not');
        }
    }
    globalThis.fetch = realFetch;
});

// ── 4. minute-dataset reader ────────────────────────────────────────────────
await ok('dataset reader: old days from sealed R2 files, recent windows never touch R2', async () => {
    const now = Date.now();
    const oldDay = new Date(now - 30 * DAY).toISOString().slice(0, 10);
    const oldRows = [{ t: `${oldDay}T12:00:00+00:00`, sw_flag: 'ok', sw_v_km_s: 400 }, { t: `${oldDay}T12:01:00+00:00`, sw_flag: 'gap', sw_v_km_s: null }];
    const w = world();
    w.r2.set(A.swGeomagDayKey(oldDay), await A.gzipText(A.toNdjson(oldRows)));
    w.onGet = (path) => {
        if (path === 'sw_geomag_archive') return [{ day: oldDay, r2_key: A.swGeomagDayKey(oldDay) }];
        return [];                                     // Postgres no longer has that day
    };
    const s = Date.parse(`${oldDay}T11:00:00Z`), e = Date.parse(`${oldDay}T13:00:00Z`);
    const all = await store.readSwGeomag({ startMs: s, endMs: e });
    assert.deepEqual(all.rows.map(r => r.sw_flag), ['ok', 'gap']);
    assert.deepEqual(all.r2Days, [oldDay]);
    const okOnly = await store.readSwGeomag({ startMs: s, endMs: e, select: 't,sw_v_km_s', filter: '&sw_flag=eq.ok', where: r => r.sw_flag === 'ok' });
    assert.deepEqual(okOnly.rows, [{ t: oldRows[0].t, sw_v_km_s: 400 }], 'the R2 rows get the same filter and projection');
    assert.equal(await store.countSealedDay(oldDay, r => r.sw_flag === 'ok'), 1);

    const before = w.sbGets.length;
    const recent = await store.readSwGeomag({ startMs: now - 6 * H, endMs: now });
    assert.deepEqual(recent.r2Days, []);
    assert.ok(!w.sbGets.slice(before).some(q => q.includes('day=in')), 'a recent window never looks in the archive');
    globalThis.fetch = realFetch;
});

console.log(`r2-offload: ${passed} checks passed`);
