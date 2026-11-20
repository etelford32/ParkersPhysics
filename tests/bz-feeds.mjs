/**
 * tests/bz-feeds.mjs — gate for js/bz/feeds.js (BZ_ENGINE_PLAN.md phase B0).
 *
 *   node tests/bz-feeds.mjs
 *
 * THE PAYLOADS HERE ARE SYNTHETIC, written from the published SWPC / USGS
 * layouts as best known — the real hosts are egress-blocked at build time.
 * They gate the RULES (gaps are null, spacecraft stay separate, cadence is
 * measured, candidates walk in order, a miss is 'expired'), not the upstream
 * schema. When scripts/probe-bz-feeds.mjs --save has produced real snapshots
 * under tests/fixtures/bz/, add a real-data section and never hand-edit them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FEEDS, FEED_IDS, FILL_ABS, num, timeMs, toRecords, measureCadenceS, resolveFields,
    normalizeL1Mag, normalizeGeoMag, mergeGeoMag, normalizeEphem, normalizeGround,
    groundProbeUrl, candidateUrl, feedFreshness, runFeed, summarize,
} from '../js/bz/feeds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${name}`); };
const T0 = Date.parse('2026-11-20T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

// ── 1. primitives ─────────────────────────────────────────────────────────
assert.equal(num(null), null);
assert.equal(num(''), null);
assert.equal(num('abc'), null);
assert.equal(num(-9999), null, 'fill value is a gap');
assert.equal(num(99999.9), null);
assert.equal(num(FILL_ABS - 1), FILL_ABS - 1);
assert.equal(num('-3.25'), -3.25);
assert.ok(Object.is(num(0), 0), 'a real zero stays zero');
ok('num: gaps and fill values are null, zero is zero');

assert.equal(timeMs('2026-11-20T12:00:00Z'), T0);
assert.equal(timeMs('2026-11-20 12:00:00.000'), T0, 'zone-less SWPC tag is UTC');
assert.equal(timeMs('2026-11-20T12:00:00'), T0);
assert.equal(timeMs('nonsense'), null);
ok('timeMs: both SWPC spellings, always UTC');

assert.deepEqual(toRecords([['time_tag', 'bz_gsm'], ['a', '1'], ['b', '2']]),
    [{ time_tag: 'a', bz_gsm: '1' }, { time_tag: 'b', bz_gsm: '2' }]);
assert.deepEqual(toRecords({ not: 'an array' }), []);
assert.deepEqual(toRecords([1, 2, 3]), []);
ok('toRecords: object rows and header tables, nothing else');

assert.equal(measureCadenceS([T0, T0 + 60e3, T0 + 120e3, T0 + 600e3, T0 + 660e3]), 60, 'a gap does not move the median');
assert.equal(measureCadenceS([T0]), null);
assert.equal(measureCadenceS([T0, T0 + 1000, T0 + 2000]), 1);
ok('measureCadenceS: median spacing, robust to a gap');

{
    const r = resolveFields(['Time_Tag', 'Hp', 'extra'], { time: ['time_tag'], hp: ['hp', 'Hp'], he: ['He'] });
    assert.deepEqual(r.map, { time: 'Time_Tag', hp: 'Hp', he: null });
    assert.deepEqual(r.unmapped, ['extra']);
    ok('resolveFields: case-insensitive, reports unmapped keys');
}

// ── 2. L1 magnetometer: two spacecraft stay two ───────────────────────────
function l1Payload() {
    const rows = [];
    for (let i = 0; i < 30; i++) {
        const t = iso(T0 - (29 - i) * 60e3).replace('Z', '');
        rows.push({ time_tag: t, active: true, source: 'DSCOVR', bt: 6, bx_gse: 1, by_gse: -2, bz_gse: -4 - i * 0.1,
            bx_gsm: 1, by_gsm: -2.5, bz_gsm: -3.8 - i * 0.1, overall_quality: 0 });
        // ACE: present on the first 20 minutes only, with one fill value.
        if (i < 20) rows.push({ time_tag: t, active: false, source: 'ACE', bt: 6.2, bx_gse: 1.1, by_gse: -2.1,
            bz_gse: i === 5 ? -9999 : -4.2, bx_gsm: 1.1, by_gsm: -2.4, bz_gsm: i === 5 ? null : -4.0, overall_quality: 0 });
    }
    return rows;
}
{
    const m = normalizeL1Mag(l1Payload(), { nowMs: T0 + 90e3 });
    assert.deepEqual(Object.keys(m.spacecraft).sort(), ['ACE', 'DSCOVR']);
    assert.equal(m.spacecraft.DSCOVR.n, 30);
    assert.equal(m.spacecraft.ACE.n, 20);
    assert.equal(m.spacecraft.DSCOVR.cadence_s, 60);
    assert.equal(m.active_spacecraft, 'DSCOVR');
    assert.equal(m.spacecraft.ACE.active_fraction, 0);
    assert.equal(m.spacecraft.ACE.bz_gsm_valid, 19, 'the null row is a gap');
    assert.equal(m.spacecraft.ACE.bz_gse_valid, 19, 'the -9999 row is a gap');
    assert.equal(m.spacecraft.ACE.samples[5].bz_gsm, null);
    assert.equal(m.spacecraft.ACE.samples[5].bz_gse, null);
    assert.equal(m.overlap_minutes, 19, 'minutes with a valid Bz on BOTH spacecraft');
    assert.deepEqual(m.frames, { gsm: true, gse: true });
    assert.equal(m.age_s, 90);
    assert.equal(m.field_map.bz_gsm, 'bz_gsm');
    assert.deepEqual(m.unmapped, []);
    // GSM and GSE are carried side by side, exactly as published.
    assert.equal(m.spacecraft.DSCOVR.samples[0].bz_gse, -4);
    assert.equal(m.spacecraft.DSCOVR.samples[0].bz_gsm, -3.8);
    ok('normalizeL1Mag: per-spacecraft, gaps null, overlap counted, frames side by side');

    // Negative control: forget the source column and the two instruments
    // collapse into one stream with duplicate time tags — overlap must be 0.
    const merged = normalizeL1Mag(l1Payload().map(({ source, ...r }) => r), { nowMs: T0 });
    assert.deepEqual(Object.keys(merged.spacecraft), ['unknown']);
    assert.equal(merged.overlap_minutes, 0);
    assert.equal(merged.spacecraft.unknown.n, 30, 'duplicate time tags collapse to one row each');
    ok('negative control: without a source column there is nothing to fuse');
}
{
    // The older header-table product (single stream, GSM only).
    const table = [['time_tag', 'bx_gsm', 'by_gsm', 'bz_gsm', 'lon_gsm', 'lat_gsm', 'bt'],
        ['2026-11-20 11:58:00.000', '1.0', '2.0', '-5.5', '10', '20', '6.1'],
        ['2026-11-20 11:59:00.000', '1.0', '2.0', null, '10', '20', '6.0'],
        ['2026-11-20 12:00:00.000', '1.0', '2.0', '-6.5', '10', '20', '6.9']];
    const m = normalizeL1Mag(table, { nowMs: T0 });
    assert.equal(m.rows, 3);
    assert.deepEqual(m.frames, { gsm: true, gse: false });
    assert.equal(m.spacecraft.unknown.bz_gsm_valid, 2);
    assert.deepEqual(m.unmapped, ['lon_gsm', 'lat_gsm']);
    assert.equal(m.active_spacecraft, null, 'no active flag ⇒ no claim about which is active');
    assert.equal(m.age_s, 0);
    ok('normalizeL1Mag: header-table product, unmapped keys reported');
}

// ── 2b. three spacecraft, one off the minute (the MEASURED 2026-11-20 shape) ─
{
    const rows = [];
    for (let i = 0; i < 10; i++) {
        const base = T0 - (9 - i) * 60e3;
        rows.push({ time_tag: iso(base).replace('Z', ''), active: true, source: 'SOLAR1', bz_gsm: -0.2, bz_gse: -0.3, bt: 5.4 });
        rows.push({ time_tag: iso(base).replace('Z', ''), active: false, source: 'ACE', bz_gsm: -1.1, bz_gse: -1.5, bt: 6.5 });
        rows.push({ time_tag: iso(base + 2000).replace('Z', ''), active: false, source: 'IMAP', bz_gsm: 0.02, bz_gse: 0.28, bt: 5.2 });
    }
    const m = normalizeL1Mag(rows, { nowMs: T0 });
    assert.deepEqual(Object.keys(m.spacecraft).sort(), ['ACE', 'IMAP', 'SOLAR1']);
    assert.equal(m.active_spacecraft, 'SOLAR1');
    assert.equal(m.spacecraft.IMAP.cadence_s, 60);
    assert.equal(m.spacecraft.IMAP.samples[0].t % 60000, 2000, 'an off-minute time tag is kept as published');
    assert.equal(m.overlap_minutes, 10, 'overlap is by minute BUCKET, so the 2 s offset still overlaps');
    const e = normalizeEphem([
        { time_tag: '2026-11-20T14:00:00Z', source: 'ACE', x_gse: 1466940, y_gse: 261498, z_gse: 140316 },
        { time_tag: '2026-11-20T14:00:00Z', source: 'IMAP', x_gse: 1450498, y_gse: -234369, z_gse: -36380 },
        { time_tag: '2026-11-20T14:00:00Z', source: 'SOLAR1', x_gse: 1433591, y_gse: -306182, z_gse: -116505 },
    ], { nowMs: T0 });
    assert.equal(e.separations_re.length, 3, 'every pair, not just the first two');
    const pair = (a, b) => e.separations_re.find((s) => s.pair.includes(a) && s.pair.includes(b)).r;
    assert.ok(Math.abs(pair('ACE', 'IMAP') - 82.66) < 0.05, 'matches the production report');
    assert.ok(pair('ACE', 'SOLAR1') > 95 && pair('ACE', 'SOLAR1') < 100);
    assert.ok(pair('IMAP', 'SOLAR1') > 15 && pair('IMAP', 'SOLAR1') < 20);
    ok('three spacecraft: off-minute tags kept, all pairwise separations reported');
}

// ── 3. GOES magnetometer ──────────────────────────────────────────────────
function goes(sat, minutes, arcjetAt = -1) {
    return Array.from({ length: minutes }, (_, i) => ({
        time_tag: iso(T0 - (minutes - 1 - i) * 60e3), satellite: sat,
        He: 20.5, Hp: 98.2 + i * 0.01, Hn: -3.1, total: 100.4, arcjet_flag: i === arcjetAt,
    }));
}
{
    const a = normalizeGeoMag(goes(19, 360, 100), { nowMs: T0 + 120e3 });
    assert.deepEqual(Object.keys(a.satellites), ['GOES-19']);
    assert.equal(a.satellites['GOES-19'].cadence_s, 60);
    assert.equal(a.satellites['GOES-19'].arcjet_flagged, 1);
    assert.equal(a.satellites['GOES-19'].samples[100].arcjet, true, 'flagged sample is kept, and flagged');
    assert.equal(a.satellites['GOES-19'].samples[100].hp != null, true);
    assert.equal(a.age_s, 120);
    const b = normalizeGeoMag(goes(18, 360), { nowMs: T0 });
    const day = normalizeGeoMag(goes(19, 1440), { nowMs: T0 });
    const m = mergeGeoMag([a, b, day], { nowMs: T0 });
    assert.deepEqual(Object.keys(m.satellites).sort(), ['GOES-18', 'GOES-19']);
    assert.equal(m.satellites['GOES-19'].n, 1440, 'the longer record wins');
    assert.equal(m.rows, 1800);
    ok('normalizeGeoMag + merge: two longitudes, arcjet flag kept, longer record wins');
}

// ── 4. ephemerides: the unit is inferred, and reported ────────────────────
{
    const km = [{ time_tag: '2026-11-20T11:00:00Z', source: 'ACE', x_gse: 1.45e6, y_gse: 2.0e5, z_gse: -1.0e5 },
        { time_tag: '2026-11-20T11:00:00Z', source: 'DSCOVR', x_gse: 1.50e6, y_gse: -1.5e5, z_gse: 8.0e4 }];
    const e = normalizeEphem(km, { nowMs: T0 });
    assert.equal(e.spacecraft.ACE.unit_inferred, 'km');
    assert.ok(Math.abs(e.spacecraft.ACE.last_re.x - 1.45e6 / 6371.2) < 0.01);
    assert.ok(e.separation_re.r > 50 && e.separation_re.r < 70, `separation ${e.separation_re.r} R_E`);
    const re = normalizeEphem(km.map((r) => ({ ...r, x_gse: r.x_gse / 6371.2, y_gse: r.y_gse / 6371.2, z_gse: r.z_gse / 6371.2 })), { nowMs: T0 });
    assert.equal(re.spacecraft.ACE.unit_inferred, 'Re');
    assert.ok(Math.abs(re.separation_re.r - e.separation_re.r) < 0.05, 'same separation either way');
    const odd = normalizeEphem([{ time_tag: '2026-11-20T11:00:00Z', source: 'ACE', x_gse: 3, y_gse: 1, z_gse: 0 }], { nowMs: T0 });
    assert.equal(odd.spacecraft.ACE.unit_inferred, 'unknown');
    assert.equal(odd.spacecraft.ACE.last_re, null, 'an implausible magnitude is not converted');
    ok('normalizeEphem: km and R_E give one separation; an implausible unit is refused');
}

// ── 5. USGS ground: latency is the newest NON-NULL sample ─────────────────
{
    const times = Array.from({ length: 600 }, (_, i) => iso(T0 - (599 - i) * 1000));
    const x = times.map((_, i) => (i < 480 ? 20800.1 + i * 0.01 : null));   // last 120 s not yet in
    x[10] = 99999;                                                             // an IAGA fill
    const payload = { metadata: { station: { id: 'BOU' } }, times,
        values: [{ id: 'X', values: x }, { id: 'Y', values: x.map(() => null) }] };
    const g = normalizeGround(payload, { nowMs: T0 });
    assert.equal(g.cadence_s, 1);
    assert.equal(g.rows, 600);
    assert.equal(g.elements.X.valid, 479, 'nulls and the 99999 fill are gaps');
    assert.equal(g.elements.X.latency_s, 120);
    assert.equal(g.elements.Y.latency_s, null);
    assert.equal(g.elements.Y.valid, 0);
    assert.equal(g.latency_s, 120, 'latency ignores the null padding up to now');
    assert.equal(g.completeness, 0.798);
    const empty = normalizeGround({ times, values: [{ id: 'X', values: times.map(() => null) }] }, { nowMs: T0 });
    assert.equal(empty.latency_s, null, 'no valid sample ⇒ no latency claim');
    ok('normalizeGround: cadence, completeness and honest latency');

    const u = groundProbeUrl({ station: 'BOU', samplingPeriod: 1 }, T0);
    assert.match(u, /^https:\/\/geomag\.usgs\.gov\/ws\/data\/\?id=BOU&type=variation&elements=X,Y,Z&sampling_period=1&format=json/);
    assert.match(u, /starttime=2026-11-20T11%3A50%3A00Z&endtime=2026-11-20T12%3A00%3A00Z$/);
    assert.match(groundProbeUrl({ station: 'BOU', samplingPeriod: 7 }, T0), /sampling_period=60/, 'only 1 or 60 is ever sent');
    ok('groundProbeUrl: built from the catalogue, ten-minute window at 1 s');
}

// ── 6. the catalogue ──────────────────────────────────────────────────────
for (const id of FEED_IDS) {
    const f = FEEDS[id];
    if (!f.verified) assert.ok(f.candidates.length >= 2, `${id}: more than one candidate while unverified`);
    else {
        assert.match(f.verified.on, /^\d{4}-\d{2}-\d{2}$/, `${id}: verified carries its date`);
        for (const part of f.verified.candidate.split('+')) assert.ok(f.candidates.some((c) => c.id === part), `${id}: verified candidate ${part} is still listed`);
    }
    const ids = new Set();
    for (const c of f.candidates) {
        assert.ok(!ids.has(c.id), `${id}: duplicate candidate ${c.id}`); ids.add(c.id);
        const u = candidateUrl(f, c, T0);
        assert.match(u, /^https:\/\/(services\.swpc\.noaa\.gov|geomag\.usgs\.gov)\//, `${id}/${c.id}: only the two public hosts`);
    }
    assert.ok(Number.isFinite(f.cadence_s) && f.cadence_s > 0);
    assert.ok('verified' in f, `${id}: carries a verified field`);
}
ok(`catalogue: ${FEED_IDS.length} feeds, unique candidates, two public hosts only`);

// ── 7. runFeed: candidate walk, merge, freshness, total miss ──────────────
function fakeFetch(table, calls) {
    return async (url) => {
        calls?.push(url);
        const hit = Object.entries(table).find(([k]) => url.includes(k));
        if (!hit) return { ok: false, status: 404, error: 'HTTP 404' };
        if (hit[1] === 'throw') throw new Error('boom');
        if (hit[1] === 'html') return { ok: false, status: 200, contentType: 'text/html', error: 'not JSON' };
        return { ok: true, status: 200, contentType: 'application/json', body: hit[1] };
    };
}
{
    // First candidate 404s, second answers: the data path stops there.
    const calls = [];
    const out = await runFeed('l1-mag-fast', { fetchJson: fakeFetch({ 'rtsw_mag.json': l1Payload() }, calls), nowMs: T0 + 60e3 });
    assert.equal(out.source_id, 'rtsw-mag');
    assert.equal(calls.length, 2, 'stops at the first candidate that yields rows');
    assert.equal(out.candidates[0].ok, false);
    assert.equal(out.candidates[0].http_status, 404);
    assert.equal(out.freshness, 'fresh');
    assert.deepEqual(out.reasons, []);
    assert.equal(out.data.spacecraft.DSCOVR.samples.length, 30, 'the data path keeps samples');
    ok('runFeed: walks candidates in order and stops at the first hit');

    // meta probes ALL of them, even after a hit.
    const calls2 = [];
    const meta = await runFeed('l1-mag-fast', { fetchJson: fakeFetch({ 'rtsw_mag_1s': l1Payload(), 'dscovr_mag_1s': 'html', 'mag-5-minute': 'throw' }, calls2), nowMs: T0, meta: true });
    assert.equal(calls2.length, FEEDS['l1-mag-fast'].candidates.length);
    assert.equal(meta.source_id, 'rtsw-mag-1s');
    assert.equal(meta.candidates.find((c) => c.id === 'dscovr-mag-1s').error, 'not JSON', 'a 200 error page is a miss');
    assert.equal(meta.candidates.find((c) => c.id === 'products-mag-5m').error, 'boom', 'a throwing fetch is a miss, not a crash');
    assert.equal(meta.candidates[0].summary.spacecraft.DSCOVR.samples, undefined, 'the report carries no sample arrays');
    assert.ok(meta.candidates[0].summary.spacecraft.DSCOVR.latest);
    ok('runFeed meta: every candidate probed; error pages and throws are misses');
}
{
    const out = await runFeed('geo-mag', {
        fetchJson: fakeFetch({ 'primary/magnetometers-1-day': goes(19, 360), 'secondary/magnetometers-1-day': goes(18, 360) }),
        nowMs: T0 });
    assert.deepEqual(Object.keys(out.data.satellites).sort(), ['GOES-18', 'GOES-19']);
    assert.equal(out.source_id, 'goes-primary-1d+goes-secondary-1d');
    ok('runFeed geo-mag: primary and secondary are MERGED, not first-hit');
}
{
    const dead = await runFeed('l1-mag', { fetchJson: fakeFetch({}), nowMs: T0 });
    assert.equal(dead.data, null);
    assert.equal(dead.freshness, 'expired');
    assert.deepEqual(dead.reasons, ['no_candidate_answered']);
    const stale = await runFeed('l1-mag', { fetchJson: fakeFetch({ 'rtsw_mag_1m': l1Payload() }), nowMs: T0 + 2 * 3600e3 });
    assert.equal(stale.freshness, 'stale');
    assert.match(stale.reasons[0], /^newest_sample_7200s_old$/);
    const old = await runFeed('l1-mag', { fetchJson: fakeFetch({ 'rtsw_mag_1m': l1Payload() }), nowMs: T0 + 7 * 3600e3 });
    assert.equal(old.freshness, 'expired');
    const emptyOk = await runFeed('l1-mag', { fetchJson: fakeFetch({ 'rtsw_mag_1m': [] }), nowMs: T0 });
    assert.equal(emptyOk.freshness, 'expired', 'an empty 200 is never healthy');
    assert.equal(feedFreshness(FEEDS['l1-mag'], null), 'expired');
    await assert.rejects(runFeed('nope', { fetchJson: fakeFetch({}), nowMs: T0 }), /unknown feed/);
    ok('freshness: dead ⇒ expired with a reason; old data ⇒ stale then expired; empty 200 ⇒ expired');
}
{
    const s = summarize(normalizeL1Mag(l1Payload(), { nowMs: T0 }));
    assert.ok(JSON.stringify(s).length < 2500, 'a summary is small');
}

// ── 8. the route: no passthrough, never a 5xx for an upstream miss ────────
{
    const src = readFileSync(join(ROOT, 'api', 'bz', 'feeds.js'), 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/js\/bz\/feeds\.js'/, 'the route imports the pure module');
    assert.ok(!/searchParams\.get\('url'\)/.test(src), 'no passthrough URL parameter');
    assert.ok(!/jsonError\('upstream_unavailable'/.test(src), 'an upstream miss is a 200 + freshness, not a 5xx');
    assert.match(src, /FEED_IDS\.includes\(feedId\)/, 'feed is whitelisted');

    const real = globalThis.fetch;
    try {
        const { default: handler } = await import('../api/bz/feeds.js');
        globalThis.fetch = async () => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } });
        const bad = await handler(new Request('https://x.test/api/bz/feeds?feed=evil'));
        assert.equal(bad.status, 400);
        const dead = await handler(new Request('https://x.test/api/bz/feeds?feed=l1-mag&meta=1'));
        assert.equal(dead.status, 200);
        const body = await dead.json();
        assert.equal(body.freshness, 'expired');
        assert.equal(body.data, null);
        assert.ok(body.candidates.every((c) => c.http_status === 403 && !c.ok), 'the WAF 403 is reported per candidate');

        globalThis.fetch = async (u) => String(u).includes('rtsw_mag_1m')
            ? Response.json(l1Payload().map((r) => ({ ...r, time_tag: iso(Date.parse(r.time_tag + 'Z') + (Date.now() - T0)).replace('Z', '') })))
            : new Response('no', { status: 404 });
        const live = await (await handler(new Request('https://x.test/api/bz/feeds?feed=l1-mag&samples=5'))).json();
        assert.equal(live.freshness, 'fresh');
        assert.equal(live.source_id, 'rtsw-mag-1m');
        assert.equal(live.data.spacecraft.DSCOVR.samples.length, 5, 'samples= trims each spacecraft');
        assert.ok(live.age_seconds >= 0 && live.age_seconds < 120);
        assert.equal(live.verified.candidate, 'rtsw-mag-1m', 'carries what was verified, and when');
    } finally { globalThis.fetch = real; }
    ok('route: 400 on an unknown feed; WAF 403 ⇒ 200 + expired; live path trims samples');
}

console.log(`\nbz-feeds: ${n} checks passed`);
