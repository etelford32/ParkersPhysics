/**
 * Gate for api/_lib/neo-sources.js — the JPL SSD adapters behind
 * /api/neo/catalog and /api/neo/watch.
 *
 * The upstream schemas are UNVERIFIED (ssd-api.jpl.nasa.gov is egress-blocked
 * from the build sandbox), so the fixtures here are shaped from the published
 * API documentation and the assertions are about the ADAPTER'S CONTRACT, not
 * about JPL:
 *   - columns resolve by name from candidate lists, and the self-report says
 *     what matched and what did not
 *   - a renamed column still resolves; a total miss is ok:false, never an
 *     empty "healthy" result
 *   - the URL builders take a tier name or nothing — no client string ever
 *     reaches an upstream URL
 *   - rows that cannot be propagated are dropped AND counted
 *   - the composed bodies carry freshness:'stale' exactly when the essential
 *     feed failed, and still carry whatever the bonus feeds returned
 */
import assert from 'node:assert/strict';
import {
    CATALOG_TIERS, DEFAULT_TIER, SBDB_FIELDS, SBDB_FIELDS_CORE, SBDB_FIELDS_PHOTOMETRY,
    INTERSTELLAR_E_MIN, MAX_CATALOG_ROWS,
    sbdbAsteroidUrl, sbdbCometUrl, sbdbInterstellarUrl, cadUrl, sentryUrl, fireballUrl,
    parseSbdbQuery, parseCad, parseCadDate, parseSentry, parseFireballs,
    compactRows, composeCatalogResponse, composeWatchResponse, CAD_WINDOW, SENTRY_KEEP,
} from '../api/_lib/neo-sources.js';
import { NEO_ROW_COLUMNS, FLAG, rowToRecord, normalizeElements } from '../js/neo-orbits.js';

// ── URL builders: tier name in, frozen query out ────────────────────────────
{
    const u = new URL(sbdbAsteroidUrl('bright'));
    assert.equal(u.origin + u.pathname, 'https://ssd-api.jpl.nasa.gov/sbdb_query.api');
    assert.equal(u.searchParams.get('fields'), SBDB_FIELDS.join(','));
    assert.equal(u.searchParams.get('sb-kind'), 'a');
    assert.equal(u.searchParams.get('sb-group'), 'neo');
    assert.deepEqual(JSON.parse(u.searchParams.get('sb-cdata')), { AND: ['H|LE|22'] });
    const pha = new URL(sbdbAsteroidUrl('pha'));
    assert.equal(pha.searchParams.get('sb-group'), 'pha');
    assert.equal(pha.searchParams.get('sb-cdata'), null, 'PHA tier has no magnitude constraint');
    assert.equal(new URL(sbdbAsteroidUrl('all')).searchParams.get('sb-cdata'), null);
    assert.equal(sbdbAsteroidUrl('../etc/passwd'), null, 'unknown tiers are refused, not defaulted');
    assert.equal(sbdbAsteroidUrl('bright; DROP'), null);
    assert.ok(CATALOG_TIERS[DEFAULT_TIER]);
    const c = new URL(sbdbCometUrl());
    assert.equal(c.searchParams.get('sb-kind'), 'c'); assert.equal(c.searchParams.get('sb-group'), 'neo');
    const i = new URL(sbdbInterstellarUrl());
    assert.deepEqual(JSON.parse(i.searchParams.get('sb-cdata')), { AND: [`e|GT|${INTERSTELLAR_E_MIN}`] });
    assert.ok(INTERSTELLAR_E_MIN > 1.05 && INTERSTELLAR_E_MIN < 1.2, '1I (e≈1.20) must pass; outgassing-inflated Oort comets (e≲1.05) must not');
    for (const url of [sbdbAsteroidUrl('all'), sbdbCometUrl(), sbdbInterstellarUrl(), cadUrl(), sentryUrl(), fireballUrl()]) {
        assert.ok(url.startsWith('https://ssd-api.jpl.nasa.gov/'), `anchored to JPL: ${url}`);
    }
    const cad = new URL(cadUrl(Date.UTC(2026, 8, 13, 12)));
    assert.equal(cad.searchParams.get('date-min'), '2026-09-06');
    assert.equal(cad.searchParams.get('date-max'), '2026-11-12');
    assert.equal(cad.searchParams.get('dist-max'), String(CAD_WINDOW.distMaxAU));
    assert.equal(cad.searchParams.get('fullname'), 'true');
    assert.equal(new URL(fireballUrl()).searchParams.get('limit'), '20');

    // The optional photometry columns can be dropped from EVERY builder — the
    // route's retry path when JPL refuses a field spelling it does not know.
    // Without that, one unverified column name takes the whole catalogue down.
    assert.deepEqual(SBDB_FIELDS.slice(0, SBDB_FIELDS_CORE.length), [...SBDB_FIELDS_CORE], 'core columns come first');
    assert.deepEqual(SBDB_FIELDS.slice(SBDB_FIELDS_CORE.length), [...SBDB_FIELDS_PHOTOMETRY]);
    assert.ok(SBDB_FIELDS_PHOTOMETRY.length > 0);
    for (const build of [(o) => sbdbAsteroidUrl('all', o), sbdbCometUrl, sbdbInterstellarUrl]) {
        assert.equal(new URL(build({ photometry: true })).searchParams.get('fields'), SBDB_FIELDS.join(','));
        assert.equal(new URL(build({ photometry: false })).searchParams.get('fields'), SBDB_FIELDS_CORE.join(','));
        assert.equal(new URL(build()).searchParams.get('fields'), SBDB_FIELDS.join(','), 'photometry is the default');
    }
}

// ── SBDB query parser ───────────────────────────────────────────────────────
const sbdbFixture = {
    signature: { source: 'NASA/JPL Small-Body Database (SBDB) API', version: '1.3' },
    fields: ['pdes', 'full_name', 'H', 'class', 'neo', 'pha', 'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'epoch', 'moid', 'diameter'],
    count: 6,
    data: [
        ['99942', '   99942 Apophis (2004 MN4)', '19.09', 'ATE', 'Y', 'Y', '.1914', '.9224', '.7461', '3.339', '203.9', '126.7', '100.12345', '2461050.2', '2461000.5', '.000258', '.340'],
        ['2024 YR4', '(2024 YR4)', '23.92', 'APO', 'Y', 'N', '.6616', '2.516', '.8514', '3.408', '271.4', '134.4', '32.11', '2460700.1', '2461000.5', '.00283', null],
        ['3200', '3200 Phaethon (1983 TB)', '14.3', 'APO', 'Y', 'Y', '.8899', '1.271', '.1399', '22.26', '265.2', '322.2', '45.5', '2460900.0', '2461000.5', '.0196', '5.1'],
        // Missing inclination — cannot be propagated, must be dropped and counted.
        ['2099 XX', '(2099 XX)', '25.0', 'APO', 'Y', 'N', '.5', '1.5', '.75', null, '10', '20', '30', null, '2461000.5', null, null],
        // Near-parabolic — refused.
        ['C/2099 A1', 'C/2099 A1 (Test)', null, 'HYP', 'N', 'N', '1.0002', null, '.9', '80', '100', '200', null, '2461100.0', '2461000.5', null, null],
        // No time anchor at all.
        ['2098 YY', '(2098 YY)', '24.0', 'AMO', 'Y', 'N', '.3', '1.4', '.98', '5', '6', '7', null, null, null, null, null],
    ],
};
{
    const r = parseSbdbQuery(sbdbFixture, { kind: 'a' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 3, 'three propagatable rows');
    assert.deepEqual(r.dropped, { missing_elements: 1, parabolic: 1, no_time_anchor: 1 });
    assert.equal(r.field_map.des, 'pdes'); assert.equal(r.field_map.om, 'om'); assert.equal(r.field_map.diam, 'diameter');
    assert.deepEqual(r.unmapped, []);
    const ap = r.records[0];
    assert.equal(ap.des, '99942');
    assert.equal(ap.name, '99942 Apophis (2004 MN4)', 'whitespace collapsed');
    assert.equal(ap.flags, FLAG.NEO | FLAG.PHA);
    assert.equal(ap.cls, 'ATE'); assert.equal(ap.H, 19.09); assert.equal(ap.diam, 0.34); assert.equal(ap.moid, 0.00026);
    assert.equal(ap.q, null, 'ellipse: q is derivable, not shipped');
    assert.equal(ap.tp, null, 'ellipse with ma+epoch: tp not shipped');
    assert.equal(ap.ma, 100.1235); assert.equal(ap.epoch, 2461000.5);
    const yr4 = r.records[1];
    assert.equal(yr4.name, null, 'name identical to designation is shipped as null');
    assert.equal(yr4.flags, FLAG.NEO);
    // Every surviving record propagates.
    for (const rec of r.records) assert.equal(normalizeElements(rec).ok, true, `${rec.des} propagates`);
    // Wire rows round-trip.
    const rows = compactRows(r.records);
    assert.equal(rows[0].length, NEO_ROW_COLUMNS.length);
    assert.deepEqual(rowToRecord(rows[0]), { ...ap, name: ap.name });
}
{
    // ── Optional photometry ─────────────────────────────────────────────────
    // Measured albedo and taxonomy come through when JPL publishes them, and
    // the group SELF-REPORTS how many rows carried each — a route quietly
    // serving zero measured albedos is otherwise indistinguishable from one
    // serving thousands, and every drawn tone and derived size depends on it.
    const withPhot = {
        fields: ['pdes', 'full_name', 'H', 'class', 'e', 'a', 'i', 'om', 'w', 'ma', 'epoch', 'diameter', 'albedo', 'spec_B'],
        data: [
            ['101955', '101955 Bennu (1999 RQ36)', '20.2', 'APO', '.2037', '1.1264', '6.035', '2.06', '66.22', '220.5', '2461000.5', '.49', '.044', 'B'],
            ['433', '433 Eros (A898 PA)', '10.4', 'AMO', '.2227', '1.458', '10.83', '304.3', '178.9', '12.3', '2461000.5', '16.8', null, 'S'],
            ['2024 YR4', '(2024 YR4)', '23.92', 'APO', '.6616', '2.516', '3.408', '271.4', '134.4', '32.11', '2461000.5', null, null, null],
        ],
    };
    const r = parseSbdbQuery(withPhot, { kind: 'a' });
    assert.equal(r.ok, true); assert.equal(r.count, 3);
    assert.equal(r.records[0].albedo, 0.044, 'Bennu’s measured albedo survives the round trip');
    assert.equal(r.records[0].spec, 'B');
    assert.equal(r.records[1].albedo, null, 'no albedo published ⇒ null, never a class mean here');
    assert.equal(r.records[1].spec, 'S');
    assert.equal(r.records[2].spec, null);
    assert.equal(r.photometry.albedo_column, 'albedo');
    assert.equal(r.photometry.spec_column, 'spec_B');
    assert.equal(r.photometry.albedo_measured, 1);
    assert.equal(r.photometry.spec_measured, 2);
    // The wire row carries them, so the client never re-fetches to get them.
    const row = compactRows(r.records)[0];
    assert.equal(rowToRecord(row).albedo, 0.044);
    assert.equal(rowToRecord(row).spec, 'B');
    // A response with NO photometry columns at all still parses — that is the
    // dropped-columns retry path, and it must look like data, not a failure.
    const none = parseSbdbQuery(sbdbFixture, { kind: 'a' });
    assert.equal(none.ok, true);
    assert.equal(none.photometry.albedo_column, null);
    assert.equal(none.photometry.albedo_measured, 0);
    assert.equal(none.records[0].albedo, null);
    assert.equal(none.records[0].spec, null);
}
{
    // Renamed columns still resolve; extra columns are reported, not fatal.
    const alt = {
        fields: ['designation', 'fullname', 'h', 'orbit_class', 'ecc', 'sma', 'incl', 'node', 'peri', 'M', 'epoch_jd', 'weird_extra'],
        data: [['433', '433 Eros (A898 PA)', '10.4', 'AMO', '.2227', '1.458', '10.83', '304.3', '178.9', '12.3', '2461000.5', 'x']],
    };
    const r = parseSbdbQuery(alt, { kind: 'a' });
    assert.equal(r.ok, true); assert.equal(r.count, 1);
    assert.equal(r.field_map.om, 'node'); assert.equal(r.field_map.ma, 'M');
    assert.deepEqual(r.unmapped, ['weird_extra']);
    assert.equal(r.records[0].cls, 'AMO');
    assert.equal(r.records[0].flags, 0, 'neo/pha columns absent ⇒ no flags, not a guess');
}
{
    // Objects-shaped data (no `fields`) is accepted too.
    const objs = { data: [{ pdes: '1P', full_name: '1P/Halley', e: '0.967', a: '17.83', i: '162.3', om: '58.4', w: '111.3', ma: '38.4', epoch: '2461000.5' }] };
    const r = parseSbdbQuery(objs, { kind: 'c' });
    assert.equal(r.ok, true); assert.equal(r.records[0].flags & FLAG.COMET, FLAG.COMET);
}
{
    // Hyperbolic (interstellar) with only q + tp propagates and is flagged.
    const inter = { fields: ['pdes', 'full_name', 'e', 'q', 'i', 'om', 'w', 'tp', 'epoch', 'class'],
        data: [['C/2025 N1', '3I/ATLAS (C/2025 N1)', '6.14', '1.356', '175.1', '322.2', '128.0', '2460977.6', '2460900.5', 'HYP'],
               ['C/2020 F3', 'C/2020 F3 (NEOWISE)', '0.9992', '.295', '128.9', '61.0', '37.3', '2459034.2', '2459000.5', 'HYP']] };
    const r = parseSbdbQuery(inter, { interstellar: true });
    assert.equal(r.count, 1, 'the near-parabolic NEOWISE row is refused');
    assert.equal(r.records[0].flags & FLAG.INTERSTELLAR, FLAG.INTERSTELLAR);
    assert.equal(r.records[0].q, 1.356); assert.equal(r.records[0].tp, 2460977.6);
    assert.equal(normalizeElements(r.records[0]).ok, true);
    // An e>1.1 object in a plain asteroid query is flagged interstellar by eccentricity alone.
    const r2 = parseSbdbQuery(inter, { kind: 'a' });
    assert.equal(r2.records[0].flags & FLAG.INTERSTELLAR, FLAG.INTERSTELLAR);
}
{
    // Total miss → ok:false with a reason, never a healthy empty.
    assert.equal(parseSbdbQuery({ fields: ['foo', 'bar'], data: [['1', '2']] }).ok, false);
    assert.match(parseSbdbQuery({ fields: ['foo', 'bar'], data: [['1', '2']] }).reason, /missing_columns/);
    assert.equal(parseSbdbQuery({ signature: {} }).reason, 'no_data_array');
    assert.equal(parseSbdbQuery(null).ok, false);
    assert.equal(parseSbdbQuery('<html>').ok, false);
    // An empty-but-well-formed table is ok (a tier can legitimately be empty).
    assert.equal(parseSbdbQuery({ fields: sbdbFixture.fields, data: [] }).ok, true);
    assert.ok(MAX_CATALOG_ROWS >= 50_000, 'cap clears the ~38 000-object NEO catalogue with headroom');
}

// ── CAD parser ──────────────────────────────────────────────────────────────
const cadFixture = {
    signature: { source: 'NASA/JPL SBDB Close Approach Data API', version: '1.5' },
    count: '3',
    fields: ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h', 'diameter', 'diameter_sigma', 'fullname'],
    data: [
        ['2026 RX3', '4', '2461297.63', '2026-Sep-14 03:12', '0.00812', '0.00810', '0.00814', '12.34', '12.30', '< 00:01', '24.5', null, null, '       (2026 RX3)'],
        ['99942', '221', '2462240.34', '2029-Apr-13 21:46', '0.000254', '0.000253', '0.000255', '7.42', '5.84', '< 00:01', '19.09', '0.340', '0.020', '99942 Apophis (2004 MN4)'],
        ['2011 ES4', '9', '2461290.10', '2026-Sep-06 14:24', '0.03', '0.029', '0.031', '8.2', '8.1', '00:02', '25.2', null, null, '(2011 ES4)'],
    ],
};
{
    const r = parseCad(cadFixture);
    assert.equal(r.ok, true); assert.equal(r.count, 3);
    assert.deepEqual(r.approaches.map(a => a.des), ['2011 ES4', '2026 RX3', '99942'], 'sorted by time');
    const rx = r.approaches[1];
    assert.equal(rx.name, '(2026 RX3)'); assert.equal(rx.dist_au, 0.00812); assert.equal(rx.v_rel_kms, 12.34); assert.equal(rx.H, 24.5);
    assert.equal(rx.jd, 2461297.63);
    assert.equal(rx.t_ms, Math.round((2461297.63 - 2440587.5) * 86400e3), 't_ms from jd');
    assert.equal(r.approaches[2].diam_km, 0.34);
    assert.equal(r.field_map.name, 'fullname'); assert.deepEqual(r.unmapped, ['diameter_sigma']);
    // Without jd, the calendar string is parsed.
    const noJd = { fields: ['des', 'cd', 'dist'], data: [['X', '2026-Sep-14 03:12', '0.01']] };
    assert.equal(parseCad(noJd).approaches[0].t_ms, Date.UTC(2026, 8, 14, 3, 12));
    assert.equal(parseCadDate('2026-Sep-14 03:12'), Date.UTC(2026, 8, 14, 3, 12));
    assert.equal(parseCadDate('2026-09-14T03:12:00Z'), Date.UTC(2026, 8, 14, 3, 12));
    assert.equal(parseCadDate('2026-09-14 03:12:07'), Date.UTC(2026, 8, 14, 3, 12, 7));
    assert.equal(parseCadDate('garbage'), null);
    assert.equal(parseCad({ fields: ['x'], data: [] }).ok, false);
    assert.equal(parseCad({ count: '0', data: [] }).ok, false, 'no fields at all is a miss');
}

// ── Sentry parser ───────────────────────────────────────────────────────────
{
    const rows = [];
    for (let k = 0; k < 60; k++) rows.push({ des: `2030 A${k}`, fullname: `(2030 A${k})`, ip: '1e-7', ps_cum: String(-6 - k * 0.1), ps_max: '-6', ts_max: '0', range: '2100-2120', last_obs: '2026-01-01', n_imp: '3', h: '25', diameter: '0.03', v_inf: '10' });
    rows.push({ des: '2024 YR4', fullname: '(2024 YR4)', ip: '0.000', ps_cum: '-12.5', ps_max: '-12.5', ts_max: '0', range: '2032-2074', last_obs: '2025-05-01', n_imp: '1', h: '23.9', diameter: '0.06', v_inf: '13' });
    rows.push({ des: '29075', fullname: '29075 (1950 DA)', ip: '3.9e-4', ps_cum: '-0.9', ps_max: '-0.9', ts_max: null, range: '2880-2880', last_obs: '2024-11-11', n_imp: '1', h: '17.9', diameter: '1.3', v_inf: '14' });
    rows.push({ des: '2099 TS1', fullname: '(2099 TS1)', ip: '0.01', ps_cum: '-1.5', ps_max: '-1.5', ts_max: '1', range: '2040-2040', last_obs: '2026-09-01', n_imp: '2', h: '22', diameter: '0.14', v_inf: '9' });
    const r = parseSentry({ signature: {}, count: String(rows.length), data: rows });
    assert.equal(r.ok, true); assert.equal(r.total, 63); assert.equal(r.count, SENTRY_KEEP);
    assert.equal(r.objects[0].des, '2099 TS1', 'Torino 1 leads regardless of Palermo');
    assert.equal(r.objects[1].des, '29075', 'then highest cumulative Palermo');
    assert.equal(r.objects[1].ts_max, 0, 'null Torino reads as 0');
    assert.equal(r.objects[0].ip, 0.01); assert.equal(r.objects[1].diam_km, 1.3);
    assert.ok(!r.objects.find(o => o.des === '2024 YR4'), 'ps −12.5 falls below the keep line');
    assert.equal(parseSentry({ data: [{ nothing: 1 }] }).ok, false);
    // Columnar shape also accepted.
    const col = { fields: ['des', 'ps_cum', 'ip'], data: [['101955', '-1.4', '0.00037']] };
    assert.equal(parseSentry(col).objects[0].des, '101955');
}

// ── Fireball parser ─────────────────────────────────────────────────────────
{
    const fb = {
        signature: { source: 'NASA/JPL Fireball Data API', version: '1.0' },
        count: '2',
        fields: ['date', 'energy', 'impact-e', 'lat', 'lat-dir', 'lon', 'lon-dir', 'alt', 'vel'],
        data: [
            ['2026-09-10 12:34:56', '3.2', '0.11', '45.1', 'S', '12.3', 'W', '33.0', '18.2'],
            ['2026-09-12 01:02:03', '96.0', '2.4', '10.0', 'N', '150.0', 'E', null, null],
        ],
    };
    const r = parseFireballs(fb);
    assert.equal(r.ok, true); assert.equal(r.count, 2);
    assert.equal(r.events[0].t_ms, Date.UTC(2026, 8, 12, 1, 2, 3), 'newest first');
    assert.equal(r.events[1].lat, -45.1); assert.equal(r.events[1].lon, -12.3, 'S/W hemispheres are negative');
    assert.equal(r.events[1].impact_kt, 0.11); assert.equal(r.events[1].radiated_j, 3.2e10); assert.equal(r.events[1].vel_kms, 18.2);
    assert.equal(r.events[0].alt_km, null);
    assert.equal(r.field_map.impact_e, 'impact-e');
    assert.equal(parseFireballs({ fields: ['date'], data: [['2026-01-01 00:00:00']] }).ok, false, 'energy column required');
}

// ── Composed bodies ─────────────────────────────────────────────────────────
{
    const asteroids = parseSbdbQuery(sbdbFixture, { kind: 'a' });
    const comets = parseSbdbQuery({ fields: ['pdes', 'full_name', 'e', 'a', 'i', 'om', 'w', 'ma', 'epoch'], data: [['109P', '109P/Swift-Tuttle', '.9632', '26.09', '113.45', '139.38', '152.98', '5.1', '2461000.5']] }, { kind: 'c' });
    const dupComet = parseSbdbQuery({ fields: ['pdes', 'e', 'a', 'i', 'om', 'w', 'ma', 'epoch'], data: [['109P', '.9632', '26.09', '113.45', '139.38', '152.98', '5.1', '2461000.5']] }, { kind: 'c' });
    const live = composeCatalogResponse({ tier: 'pha', asteroids, comets, interstellar: { ok: false, reason: 'HTTP 503' }, generatedAt: '2026-09-13T00:00:00Z' });
    assert.equal(live.freshness, 'live'); assert.equal(live.count, 4); assert.deepEqual(live.columns, [...NEO_ROW_COLUMNS]);
    assert.equal(live.groups.interstellar.ok, false); assert.equal(live.groups.interstellar.reason, 'HTTP 503');
    assert.equal(live.groups.asteroids.dropped.parabolic, 1);
    assert.equal(live.tier_label, CATALOG_TIERS.pha.label);
    assert.ok(!('degraded_reason' in live));
    const dup = composeCatalogResponse({ tier: 'pha', asteroids, comets, interstellar: dupComet });
    assert.equal(dup.count, 4, 'duplicate designations across groups are merged');
    const dead = composeCatalogResponse({ tier: 'bright', asteroids: { ok: false, reason: 'unreachable: timeout' }, comets, interstellar: { ok: false } });
    assert.equal(dead.freshness, 'stale'); assert.equal(dead.degraded_reason, 'unreachable: timeout');
    assert.equal(dead.count, 1, 'bonus groups still ship when the essential one is down');
    assert.equal(dead.rows[0][0], '109P');

    const cad = parseCad(cadFixture);
    const w = composeWatchResponse({ cad, sentry: { ok: false, reason: 'HTTP 500' }, fireballs: parseFireballs({ fields: ['date', 'impact-e'], data: [['2026-09-01 00:00:00', '1']] }), nowMs: Date.UTC(2026, 8, 13) });
    assert.equal(w.freshness, 'live'); assert.equal(w.approaches.length, 3); assert.equal(w.sentry.length, 0); assert.equal(w.fireballs.length, 1);
    assert.equal(w.sources.sentry.ok, false); assert.equal(w.window.dist_max_au, 0.05);
    assert.equal(w.window.from, '2026-09-06T00:00:00.000Z'); assert.equal(w.window.to, '2026-11-12T00:00:00.000Z');
    const wDead = composeWatchResponse({ cad: { ok: false, reason: 'HTTP 503' }, sentry: parseSentry({ data: [{ des: 'x', ps_cum: '-2' }] }), fireballs: { ok: false } });
    assert.equal(wDead.freshness, 'stale'); assert.equal(wDead.degraded_reason, 'HTTP 503'); assert.equal(wDead.sentry.length, 1);
}

console.log('neo-sources: URL builders (no passthrough), SBDB/CAD/Sentry/Fireball parsers with self-report, composed bodies — passed');
