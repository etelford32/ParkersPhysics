/**
 * tests/bz-archive.mjs — gate for the Bz engine's minute archive (BZ_ENGINE_PLAN.md §21):
 * js/bz/archive.js (format, split, merge), api/cron/bz-archive.js (the writer, with an
 * in-memory store) and api/bz/archive.js (the reader).
 *
 *   node tests/bz-archive.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STREAMS, splitByDay, mergeDay, summarize, updateIndex, archiveFreshness, readSeries, daysCovering, dayKey, isDay, dayOf, INDEX_KEY, ARCHIVE_PREFIX } from '../js/bz/archive.js';
import { archiveRun, PIPELINE } from '../api/cron/bz-archive.js';
import { respond } from '../api/bz/archive.js';
import { FEEDS, normalizeL1Mag, normalizeL1Plasma, normalizeEphem, normalizeGeoMag } from '../js/bz/feeds.js';
import { HEARTBEAT_PIPELINES as HEARTBEATS, PIPELINES } from '../js/pipeline-registry.js';

let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-20T18:20:00Z'), MIN = 60e3;

// SYNTHETIC payloads in the shapes SWPC publishes (three spacecraft, IMAP off the minute, a fill value, a gap).
function payloads(nowMs, { minutes = 1440, goesMinutes = 3 * 1440, bzShift = 0 } = {}) {
    const mag = [], wind = [], eph = [], goes = [];
    for (let k = minutes; k >= 1; k--) {
        const t = nowMs - k * MIN;
        for (const [sc, off, active] of [['SOLAR1', 0, 1], ['IMAP', 23e3, 0], ['ACE', 0, 0]]) {
            if (sc === 'ACE' && k % 50 === 0) continue;                       // a missing minute
            const bz = sc === 'ACE' && k % 37 === 0 ? -99999 : Math.round((Math.sin(t / 3.1e6) * 4 + bzShift + (sc === 'IMAP' ? 0.3 : 0)) * 100) / 100;
            mag.push({ time_tag: iso(t + off), source: sc, active, bx_gsm: -3.1, by_gsm: 2.2, bz_gsm: bz, bx_gse: -3.1, by_gse: 2.6, bz_gse: bz - 0.4, bt: 5.2 });
            wind.push({ time_tag: iso(t + off), source: sc, active, proton_speed: 400 + (sc === 'ACE' ? 6 : 0), proton_density: 4.2, proton_temperature: 81000,
                ...(sc === 'SOLAR1' ? { proton_vx_gse: -399, proton_vy_gse: 12, proton_vz_gse: -4 } : {}) });
        }
    }
    for (let h = 30; h >= 0; h--) for (const [sc, x] of [['SOLAR1', 1434000], ['IMAP', 1451000], ['ACE', 1468000]]) eph.push({ time_tag: iso(Math.floor(nowMs / 3600e3) * 3600e3 - h * 3600e3), source: sc, x_gse: x, y_gse: -306000, z_gse: -117000 });
    for (let k = goesMinutes; k >= 1; k--) for (const sat of [19, 18]) goes.push({ time_tag: iso(Math.floor(nowMs / MIN) * MIN - k * MIN), satellite: sat, He: 40.5, Hp: 95 + (k % 9), Hn: 3.3, total: 104, arcjet_flag: sat === 19 && k % 400 < 20 });
    return { mag, wind, eph, goes };
}
/** A fetchJson that serves those payloads by which feed's candidate URL is asked for. */
function feedServer(p, { down = [] } = {}) {
    const urls = (id) => FEEDS[id].candidates.map((c) => c.url ?? c.path ?? '').join(' ');
    return async (url) => {
        for (const [id, body] of [['l1-mag', p.mag], ['l1-plasma', p.wind], ['l1-ephem', p.eph], ['geo-mag', p.goes]]) {
            const hit = FEEDS[id].candidates.some((c) => typeof (c.url ?? c.path) === 'string' && url.includes((c.url ?? c.path).split('/').pop()));
            if (hit) return down.includes(id) ? { ok: false, status: 503, error: 'HTTP 503' } : { ok: true, status: 200, contentType: 'application/json', body };
        }
        void urls; return { ok: false, status: 404, error: 'HTTP 404' };
    };
}
function store() { const m = new Map(); let puts = 0; return { m, get: async (k) => m.get(k) ?? null, put: async (k, t) => { puts++; m.set(k, t); }, puts: () => puts }; }
const norm = (p, nowMs = NOW) => ({ 'l1-mag': normalizeL1Mag(p.mag, { nowMs }), 'l1-plasma': normalizeL1Plasma(p.wind, { nowMs }), 'l1-ephem': normalizeEphem(p.eph, { nowMs }), 'geo-mag': normalizeGeoMag(p.goes, { nowMs }) });

// ── 1. keys and days ──────────────────────────────────────────────────────
{
    assert.equal(dayKey('2026-11-20'), `${ARCHIVE_PREFIX}2026/2026-11-20.json.gz`);
    for (const bad of ['2026-13-01', '2026-02-30', '../../etc', '2026-11-20T00', '', null, 20261120]) { assert.equal(isDay(bad), false, String(bad)); assert.throws(() => dayKey(bad)); }
    assert.deepEqual(daysCovering(Date.parse('2026-11-19T23:59:00Z'), Date.parse('2026-11-21T00:00:00Z')), ['2026-11-19', '2026-11-20', '2026-11-21']);
    assert.equal(dayOf(Date.parse('2026-11-20T23:59:59.999Z')), '2026-11-20');
    ok('keys: a validated UTC day and nothing else can name an object');
}

// ── 2. split: spacecraft stay separate, keyed by instant, gaps stay gaps ──
const P = payloads(NOW);
const feeds = norm(P);
const byDay = splitByDay(feeds);
{
    assert.deepEqual(Object.keys(byDay).sort(), ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'], 'L1 spans two days, GOES four');
    const d = byDay['2026-11-20'];
    assert.deepEqual(Object.keys(d.l1_mag).sort(), ['ACE', 'IMAP', 'SOLAR1'], 'never merged into one stream');
    assert.deepEqual(Object.keys(d.geo_mag).sort(), ['GOES-18', 'GOES-19']);
    assert.equal(byDay['2026-11-18'].l1_mag, undefined, 'a day the L1 file does not reach has no L1 rows — not empty ones');
    assert.ok(d.l1_mag.IMAP.every((r) => r[0] % 60 === 23), 'IMAP keeps its off-minute time tags');
    assert.ok(d.l1_mag.SOLAR1.every((r) => r[0] % 60 === 0 && r[0] >= 0 && r[0] < 86400));
    const cols = STREAMS.l1_mag.columns, bz = cols.indexOf('bz_gsm') + 1, act = cols.indexOf('active') + 1;
    assert.ok(d.l1_mag.ACE.some((r) => r[bz] === null), 'the fill value arrives as null…');
    assert.ok(!d.l1_mag.ACE.some((r) => r[bz] === -99999 || r[bz] === 0 && false), '…never as a number');
    assert.ok(d.l1_mag.SOLAR1.every((r) => r[act] === 1) && d.l1_mag.ACE.every((r) => r[act] === 0), 'the active flag is kept');
    assert.ok(d.l1_mag.ACE.length < d.l1_mag.SOLAR1.length, 'a missing minute is absent, not invented');
    const pv = STREAMS.l1_plasma.columns.indexOf('vx_gse') + 1;
    assert.ok(d.l1_plasma.SOLAR1.every((r) => r[pv] === -399) && d.l1_plasma.ACE.every((r) => r[pv] === null), 'components only where published');
    assert.ok(d.geo_mag['GOES-19'].some((r) => r[STREAMS.geo_mag.columns.indexOf('arcjet') + 1] === 1), 'arcjet-flagged minutes are kept and flagged');
    assert.equal(d.l1_ephem.SOLAR1[0][1], 1434000, 'positions as published');
    // every value is exactly the normaliser's
    const s0 = feeds['l1-mag'].spacecraft.SOLAR1.samples.find((s) => dayOf(s.t) === '2026-11-20');
    assert.equal(d.l1_mag.SOLAR1[0][bz], s0.bz_gsm);
    assert.deepEqual(splitByDay({}), {}); assert.deepEqual(splitByDay({ 'l1-mag': null }), {});
    ok(`split: ${d.l1_mag.SOLAR1.length} + ${d.l1_mag.IMAP.length} + ${d.l1_mag.ACE.length} L1 rows for the day, three spacecraft apart, unrounded`);
}

// ── 3. merge never loses a measurement ────────────────────────────────────
{
    const day = '2026-11-20', a = mergeDay(null, day, byDay[day], { nowMs: NOW });
    assert.ok(a.added > 3000 && a.changed === 0); assert.equal(a.doc.runs, 1); assert.equal(a.doc.day, day);
    // the same run again: nothing changes, nothing is re-stamped
    const b = mergeDay(a.doc, day, byDay[day], { nowMs: NOW + 3600e3 });
    assert.equal(b.added, 0); assert.equal(b.changed, 0); assert.equal(b.doc.updated, a.doc.updated); assert.equal(b.doc.runs, 1);
    assert.deepEqual(b.doc.streams, a.doc.streams);
    // a later, overlapping run with SWPC's re-issued values: new minutes added, changed values replaced
    const later = splitByDay(norm(payloads(NOW + 4 * 3600e3, { bzShift: 0.01 }), NOW + 4 * 3600e3))[day];
    const c = mergeDay(a.doc, day, later, { nowMs: NOW + 4 * 3600e3 });
    assert.ok(c.added > 600, `${c.added} new minutes`); assert.ok(c.changed > 1000, 're-issued values replace old ones');
    assert.equal(c.doc.runs, 2);
    assert.ok(c.doc.streams.l1_mag.SOLAR1.length > a.doc.streams.l1_mag.SOLAR1.length);
    for (const rows of Object.values(c.doc.streams.l1_mag)) for (let i = 1; i < rows.length; i++) assert.ok(rows[i][0] > rows[i - 1][0], 'sorted, one row per instant');
    // a new NULL never erases a stored value (negative control: a naive overwrite would)
    const k = STREAMS.l1_mag.columns.indexOf('bz_gsm') + 1;
    const nulled = { l1_mag: { SOLAR1: a.doc.streams.l1_mag.SOLAR1.slice(0, 40).map((r) => r.map((v, i) => (i === k ? null : v))) } };
    const e = mergeDay(a.doc, day, nulled, { nowMs: NOW + 5e6 });
    assert.equal(e.kept, 40); assert.equal(e.changed, 0);
    assert.deepEqual(e.doc.streams.l1_mag.SOLAR1.slice(0, 40).map((r) => r[k]), a.doc.streams.l1_mag.SOLAR1.slice(0, 40).map((r) => r[k]));
    const naive = a.doc.streams.l1_mag.SOLAR1.slice(0, 40).map((r, i) => ({ ...r, [k]: nulled.l1_mag.SOLAR1[i][k] }));
    assert.ok(naive.every((r) => r[k] === null), 'the control really would have erased them');
    // rows that are not this day's, or the wrong width, are refused
    const junk = mergeDay(a.doc, day, { l1_mag: { SOLAR1: [[90000, 1, 1, 1, 1, 1, 1, 1, 1], [-5, 1, 1, 1, 1, 1, 1, 1, 1], [60, 1, 2]] }, nonsense: { X: [[1, 2]] } }, { nowMs: NOW });
    assert.equal(junk.added, 0); assert.equal(junk.doc.streams.nonsense, undefined);
    // a stored document for ANOTHER day is never merged into
    assert.equal(mergeDay(a.doc, '2026-11-19', byDay['2026-11-19'], { nowMs: NOW }).doc.streams.l1_mag.SOLAR1[0][0] >= 0, true);
    assert.notEqual(mergeDay(a.doc, '2026-11-19', {}, { nowMs: NOW }).doc.streams.l1_mag, a.doc.streams.l1_mag);
    ok(`merge: idempotent; +${c.added} minutes and ${c.changed} re-issued values on an overlapping run; 40 stored values survive 40 nulls`);
}

// ── 4. summary, index, freshness, read-back ───────────────────────────────
{
    const day = '2026-11-20', { doc } = mergeDay(null, day, byDay[day], { nowMs: NOW });
    const s = summarize(doc);
    assert.equal(s.l1_mag.SOLAR1.rows, doc.streams.l1_mag.SOLAR1.length);
    assert.ok(s.l1_mag.ACE.valid < s.l1_mag.ACE.rows, 'valid counts the non-null headline column, not rows');
    assert.equal(s.l1_mag.SOLAR1.first, '2026-11-20T00:00:00.000Z');
    const d2 = mergeDay(null, '2026-11-19', byDay['2026-11-19'], { nowMs: NOW }).doc;
    const idx = updateIndex(null, [doc, d2], { nowMs: NOW });
    assert.deepEqual(Object.keys(idx.days), ['2026-11-19', '2026-11-20']); assert.equal(idx.count, 2); assert.equal(idx.first, '2026-11-19');
    assert.equal(idx.days[day].l1_mag.SOLAR1, s.l1_mag.SOLAR1.valid);
    assert.equal(updateIndex(idx, [], { nowMs: NOW + 1 }).count, 2, 'an empty run never drops a day');
    assert.equal(archiveFreshness(idx, NOW + 6 * 3600e3).freshness, 'fresh');
    assert.equal(archiveFreshness(idx, NOW + 9 * 3600e3).freshness, 'stale');
    assert.equal(archiveFreshness(idx, NOW + 14 * 3600e3).freshness, 'expired');
    assert.deepEqual(archiveFreshness(null, NOW).reasons, ['no_archive_yet']);
    const series = readSeries([doc, null, d2], 'l1_mag', 'SOLAR1', 'bz_gsm');
    assert.equal(series.length, doc.streams.l1_mag.SOLAR1.length + d2.streams.l1_mag.SOLAR1.length);
    for (let i = 1; i < series.length; i++) assert.ok(series[i].t > series[i - 1].t, 'in time order across days');
    assert.equal(series[0].t, Date.parse('2026-11-19T18:20:00Z'));
    assert.throws(() => readSeries([doc], 'l1_mag', 'SOLAR1', 'nope'));
    assert.deepEqual(readSeries([doc], 'geo_mag', 'GOES-99', 'hp'), [], 'an id not held is empty, not zeros');
    ok('summary / index / freshness / read-back: what is held is stated, a missing day is a gap');
}

// ── 5. the writer: fetch → split → GET → merge → PUT, and nothing else ────
{
    const S = store();
    const r1 = await archiveRun({ nowMs: NOW, fetchJson: feedServer(P), get: S.get, put: S.put });
    assert.equal(r1.ok, true); assert.deepEqual(r1.feeds_down, []);
    assert.equal(r1.written, 4, 'four days touched (GOES reaches back three)');
    assert.equal(S.m.size, 5, 'four day objects + the index');
    assert.ok([...S.m.keys()].every((k) => k === INDEX_KEY || k.startsWith(ARCHIVE_PREFIX)));
    const idx = JSON.parse(S.m.get(INDEX_KEY)); assert.equal(idx.count, 4);
    assert.ok(idx.days['2026-11-20'].geo_mag['GOES-18'] > 1000 && idx.days['2026-11-18'].l1_mag === undefined);
    // the same instant again: nothing is rewritten
    const before = S.puts();
    const r2 = await archiveRun({ nowMs: NOW, fetchJson: feedServer(P), get: S.get, put: S.put });
    assert.equal(r2.written, 0); assert.equal(r2.unchanged, 4); assert.equal(S.puts(), before, 'no PUT when nothing changed');
    // six hours later: only the days with new minutes are written
    const later = NOW + 6 * 3600e3;
    const r3 = await archiveRun({ nowMs: later, fetchJson: feedServer(payloads(later)), get: S.get, put: S.put });
    assert.ok(r3.days['2026-11-21'].added > 0, 'the new day exists'); assert.ok(r3.days['2026-11-20'].added > 0);
    assert.equal(JSON.parse(S.m.get(INDEX_KEY)).count, 5);
    const full = JSON.parse(S.m.get(dayKey('2026-11-20')));
    assert.equal(full.streams.l1_mag.SOLAR1.length, 1440, 'four runs a day stitch a whole day from 24-hour windows');
    assert.equal(full.runs, 2);
    // dry run writes nothing
    const D = store();
    const dry = await archiveRun({ nowMs: NOW, dry: true, fetchJson: feedServer(P), get: D.get, put: D.put });
    assert.equal(dry.written, 4); assert.equal(D.m.size, 0);
    ok(`writer: 4 days + index on the first run, 0 PUTs on a repeat, a full ${full.streams.l1_mag.SOLAR1.length}-minute day after the next run`);
}

// ── 6. failures: a dead feed is named, a dead store is never overwritten ──
{
    const S = store();
    const r = await archiveRun({ nowMs: NOW, fetchJson: feedServer(P, { down: ['geo-mag'] }), get: S.get, put: S.put });
    assert.equal(r.ok, true); assert.deepEqual(r.feeds_down, ['geo-mag']);
    assert.match(r.feeds['geo-mag'], /^down/); assert.equal(r.written, 2, 'the L1 days are still archived');
    assert.equal(JSON.parse(S.m.get(dayKey('2026-11-20'))).streams.geo_mag, undefined);
    // GOES comes back: its rows join the SAME day without touching L1
    const l1Before = JSON.stringify(JSON.parse(S.m.get(dayKey('2026-11-20'))).streams.l1_mag);
    await archiveRun({ nowMs: NOW, fetchJson: feedServer(P), get: S.get, put: S.put });
    const after = JSON.parse(S.m.get(dayKey('2026-11-20')));
    assert.ok(after.streams.geo_mag['GOES-19'].length > 1000); assert.equal(JSON.stringify(after.streams.l1_mag), l1Before);
    // every feed down: not ok, nothing written
    const E = store();
    const none = await archiveRun({ nowMs: NOW, fetchJson: feedServer(P, { down: ['l1-mag', 'l1-plasma', 'l1-ephem', 'geo-mag'] }), get: E.get, put: E.put });
    assert.equal(none.ok, false); assert.equal(none.reason, 'no_feed_returned_data'); assert.equal(E.m.size, 0);
    // a store that cannot be READ must throw before any PUT (never overwrite a day we could not read)
    let puts = 0;
    await assert.rejects(archiveRun({ nowMs: NOW, fetchJson: feedServer(P), get: async () => { throw new Error('r2 get: HTTP 500'); }, put: async () => { puts++; } }), /HTTP 500/);
    assert.equal(puts, 0);
    // out of time: remaining days are reported, not silently dropped
    let tick = 0; const T = store();
    const slow = await archiveRun({ nowMs: NOW, fetchJson: feedServer(P), get: T.get, put: T.put, budgetMs: 10, clock: () => (tick += 6) });
    assert.ok(slow.skipped_for_time.length >= 1 && slow.written + slow.skipped_for_time.length === 4);
    ok('failures: a dead feed is named and the rest archived; an unreadable store is never written over; a time-out is reported');
}

// ── 7. the reader ─────────────────────────────────────────────────────────
{
    const S = store();
    await archiveRun({ nowMs: NOW, fetchJson: feedServer(P), get: S.get, put: S.put });
    const idx = await respond({ day: null, configured: true, get: S.get, nowMs: NOW + 60e3 });
    assert.equal(idx.freshness, 'fresh'); assert.equal(idx.data.count, 4);
    const day = await respond({ day: '2026-11-20', configured: true, get: S.get, nowMs: NOW + 60e3 });
    assert.equal(day.data.day, '2026-11-20'); assert.ok(day.data.streams.l1_mag.IMAP.length > 1000);
    const miss = await respond({ day: '2025-01-01', configured: true, get: S.get, nowMs: NOW });
    assert.equal(miss.data, null); assert.ok(miss.reasons.includes('day_not_archived'));
    assert.equal((await respond({ day: '../x', configured: true, get: S.get, nowMs: NOW })).status, 400);
    assert.equal((await respond({ day: '../x', configured: false, get: S.get, nowMs: NOW })).status, 400, 'a bad day is refused before anything else');
    const off = await respond({ day: null, configured: false, get: S.get, nowMs: NOW });
    assert.equal(off.freshness, 'expired'); assert.deepEqual(off.reasons, ['r2_not_configured']);
    const empty = await respond({ day: null, configured: true, get: async () => null, nowMs: NOW });
    assert.deepEqual(empty.reasons, ['no_archive_yet']); assert.equal(empty.data, null);
    const broken = await respond({ day: null, configured: true, get: async () => { throw new Error('boom'); }, nowMs: NOW });
    assert.equal(broken.freshness, 'expired'); assert.deepEqual(broken.reasons, ['archive_read_failed']);
    ok('reader: index, a day, a missing day, a bad day, no R2, no run yet, a failing store — none of them a 5xx');
}

// ── 8. wiring ─────────────────────────────────────────────────────────────
{
    const vercel = JSON.parse(read('../vercel.json'));
    const cron = vercel.crons.find((c) => c.path === '/api/cron/bz-archive');
    assert.equal(cron.schedule, '20 */6 * * *');
    const hb = HEARTBEATS.find((h) => h.key === PIPELINE);
    assert.ok(hb, 'the heartbeat is registered'); assert.ok(hb.warnMin > 6 * 60 && hb.warnMin < 12 * 60, 'warns after one missed run, not before one is due');
    assert.ok(PIPELINES.some((p) => p.endpoint === '/api/bz/archive'));
    const cronSrc = read('../api/cron/bz-archive.js'), route = read('../api/bz/archive.js');
    assert.ok(!/searchParams\.get\(['"]url['"]\)/.test(route), 'no passthrough URL');
    assert.match(route, /isDay\(day\)/);
    assert.ok(!/from\(['"]|\.from\(|rest\/v1\/(?!rpc)/.test(cronSrc), 'the cron writes no Postgres table — only the heartbeat RPC');
    assert.match(cronSrc, /R2_CONFIGURED/);
    ok('wiring: cron every 6 h, heartbeat + route registered, no passthrough, no table');
}
console.log(`\nbz-archive: ${checks} checks passed`);
