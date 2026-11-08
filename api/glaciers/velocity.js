/**
 * GET /api/glaciers/velocity?g=<glacier id>[&max=6]
 *
 * Glacier Watch's DAILY tail: NASA ITS_LIVE image pairs published since the
 * committed bake (scripts/build-glacier-velocity.py → data/glaciers/*.json),
 * sampled at the SAME flowline points with the SAME rule (js/glacier-pairs.js).
 * The page appends these to the baked last-year series, de-duplicated by pair id.
 *
 * WHY THIS IS NODE, NOT EDGE: each pair is a ~5 MB NetCDF4 (HDF5) granule read
 * whole by the vendored pure-JS reader (js/vendor/jsfive-0.4.0.mjs, ~0.7 s of CPU
 * per 2560×2048 variable, measured 2026-11-08) — CPU an edge isolate does not
 * have. The DUAL-MODE default export is load-bearing (the trojans scar): Vercel's
 * Node runtime calls `default(req, res)` and ignores a returned Response.
 *
 * NO PASSTHROUGH URL: the client names a glacier id; scenes, points and the
 * projection come from our own static index, and the only upstream host is the
 * public ITS_LIVE bucket. That is the whole SSRF story.
 *
 * NEVER 5xx for upstream trouble: a failed listing is 200 + freshness:'stale' +
 * reasons, so status.html flags it instead of scoring an empty 200 healthy.
 * CDN cache 6 h (the prewarm cron's 'cold' tier refreshes it); a new Landsat or
 * Sentinel pair lands every few days on most of the ten glaciers, so 6 h is
 * "daily" with margin.
 */
import * as hdf5 from '../../js/vendor/jsfive-0.4.0.mjs';
import {
    BUCKET, parsePairName, isShortBaseline, scenePrefixes, keyMatchesScene,
    footprintContains, sampleGrid, pairHasCoverage, encodeI16,
} from '../../js/glacier-pairs.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const DEADLINE_MS = 48_000;
const MAX_DEFAULT = 6, MAX_CAP = 10;
const LOOKBACK_DAYS = 60;              // never list further back than this, whatever the bake date
const LIST_CONCURRENCY = 12;

function json(body, { status = 200, maxAge = 21600, swr = 3600 } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${swr}`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

async function getText(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
}

async function s3List(prefix, signal) {
    const keys = [];
    let token = null;
    for (let page = 0; page < 20; page++) {
        const q = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}` + (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
        const body = await getText(q, signal);
        for (const m of body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
        const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body);
        if (!t) break;
        token = t[1];
    }
    return keys;
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

/**
 * Read one granule and sample it at the flowline. Exported for the node gate.
 *
 * PROJECTION CHECK IS GEOMETRIC: jsfive drops the attributes of scalar datasets,
 * so the granule's `mapping.spatial_epsg` (3413 on the Columbia test granule,
 * per h5py) is invisible here. Instead the flowline must fall inside the granule's
 * own x/y extent — a granule in another projection (a neighbouring UTM zone is
 * ≥ ~600 km off in x, polar stereographic vs UTM is not even the same scale) lands
 * outside and is skipped as 'outside', never sampled at the wrong place.
 */
export function samplePairBuffer(arrayBuffer, xs, ys) {
    const f = new hdf5.File(arrayBuffer, 'pair.nc');
    const x = f.get('x').value, y = f.get('y').value;
    const xmin = Math.min(x[0], x[x.length - 1]), xmax = Math.max(x[0], x[x.length - 1]);
    const ymin = Math.min(y[0], y[y.length - 1]), ymax = Math.max(y[0], y[y.length - 1]);
    let inside = 0;
    for (let k = 0; k < xs.length; k++) if (xs[k] >= xmin && xs[k] <= xmax && ys[k] >= ymin && ys[k] <= ymax) inside++;
    if (!inside) return { skip: 'outside' };
    const grid = (name) => {
        const d = f.get(name);
        const [, ny, nx] = d.shape;
        return { data: d.value, nx, ny, x0: x[0], y0: y[0], dx: x[1] - x[0], dy: y[1] - y[0] };
    };
    const v = sampleGrid(grid('v'), xs, ys);
    if (!pairHasCoverage(v)) return { skip: 'sparse' };
    const e = sampleGrid(grid('v_error'), xs, ys);
    return { v, e };
}

async function loadIndex(origin, id, signal) {
    const idx = JSON.parse(await getText(`${origin}/data/glaciers/glaciers.json`, signal));
    const g = idx.glaciers.find(q => q.id === id);
    if (!g) return null;
    let bakedIds = new Set();
    try {
        const det = JSON.parse(await getText(`${origin}/data/glaciers/${id}.json`, signal));
        bakedIds = new Set(det.pairs.map(p => p.id));
    } catch { /* no detail file: every pair is new */ }
    return { g, bakedIds };
}

export async function handler(reqUrl, { origin, nowMs = Date.now() } = {}) {
    const url = new URL(reqUrl, origin);
    const id = (url.searchParams.get('g') || '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(id)) return json({ error: 'bad_request', detail: 'g=<glacier id> required' }, { status: 400, maxAge: 60 });
    const max = Math.min(MAX_CAP, Math.max(1, parseInt(url.searchParams.get('max') || MAX_DEFAULT, 10) || MAX_DEFAULT));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEADLINE_MS);
    const t0 = Date.now();
    const reasons = [];
    try {
        let meta;
        try { meta = await loadIndex(origin, id, ctl.signal); }
        catch (e) { return json({ glacier: id, freshness: 'stale', reasons: ['index-unavailable'], detail: e.message, pairs: [] }, { maxAge: 300, swr: 60 }); }
        if (!meta) return json({ error: 'unknown_glacier', glacier: id }, { status: 404, maxAge: 3600 });
        const { g, bakedIds } = meta;
        const bakedMs = Date.parse(g.baked);
        const sinceMs = Math.max(nowMs - LOOKBACK_DAYS * 864e5, bakedMs - 21 * 864e5);
        const jobs = [];
        for (const s of g.scenes) for (const p of scenePrefixes(s, sinceMs, nowMs)) jobs.push({ s, p });
        let listFailures = 0;
        const listed = await pool(jobs, LIST_CONCURRENCY, async ({ s, p }) => {
            try { return (await s3List(p, ctl.signal)).filter(k => keyMatchesScene(k, s)).map(k => ({ k, s })); }
            catch { listFailures++; return []; }
        });
        if (listFailures === jobs.length && jobs.length) reasons.push('listing-failed');
        const fresh = [];
        for (const { k, s } of listed.flat()) {
            const p = parsePairName(k);
            if (!isShortBaseline(p) || p.d2 < sinceMs || bakedIds.has(p.id)) continue;
            fresh.push({ ...p, key: k, sensor: s.sensor });
        }
        fresh.sort((a, b) => b.d2 - a.d2 || (a.id < b.id ? 1 : -1));
        const xs = g.flowline.x, ys = g.flowline.y;
        const pairs = [], skipped = {};
        for (const p of fresh) {
            if (pairs.length >= max || Date.now() - t0 > DEADLINE_MS - 9000) break;
            const gUrl = `${BUCKET}/${p.key}`;
            try {
                if (p.sensor === 'sentinel1') {
                    const sp = await getText(`${gUrl}.spatial`, ctl.signal);
                    if (!footprintContains(sp, g.lon, g.lat)) { skipped.footprint = (skipped.footprint || 0) + 1; continue; }
                }
                const r = await fetch(gUrl, { signal: ctl.signal });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const res = samplePairBuffer(await r.arrayBuffer(), xs, ys);
                if (res.skip) { skipped[res.skip] = (skipped[res.skip] || 0) + 1; continue; }
                pairs.push({ id: p.id, sensor: p.sensor, d1: new Date(p.d1).toISOString().slice(0, 10), d2: new Date(p.d2).toISOString().slice(0, 10), v: encodeI16(res.v), e: encodeI16(res.e) });
            } catch (e) {
                skipped[e.name === 'AbortError' ? 'deadline' : 'read-error'] = (skipped[e.name === 'AbortError' ? 'deadline' : 'read-error'] || 0) + 1;
            }
        }
        const newest = fresh[0] ? new Date(fresh[0].d2).toISOString().slice(0, 10) : null;
        return json({
            glacier: id, source: 'NASA ITS_LIVE v2 image pairs (its-live-data S3)',
            generated: new Date(nowMs).toISOString(), baked: g.baked, since: new Date(sinceMs).toISOString().slice(0, 10),
            freshness: reasons.length ? 'stale' : 'live', reasons,
            scenes: g.scenes.length, prefixes_listed: jobs.length, list_failures: listFailures,
            new_pairs_available: fresh.length, newest_pair_end: newest,
            pairs, skipped, elapsed_ms: Date.now() - t0,
        }, reasons.length ? { maxAge: 600, swr: 120 } : {});
    } finally {
        clearTimeout(timer);
    }
}

function originOf(req) {
    const h = req.headers;
    const get = (k) => (typeof h?.get === 'function' ? h.get(k) : h?.[k]);
    const host = get('x-forwarded-host') || get('host');
    if (!host) return 'http://localhost:3000';
    const proto = get('x-forwarded-proto') || (/^localhost|^127\./.test(host) ? 'http' : 'https');
    return `${proto}://${host}`;
}

export default async function entry(req, res) {
    const origin = originOf(req);
    const response = await handler(req.url, { origin });
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
        res.statusCode = response.status;
        response.headers.forEach((v, k) => { if (k !== 'content-length') res.setHeader(k, v); });
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
    }
    return response;
}
