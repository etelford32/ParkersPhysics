/**
 * Gate for api/_lib/trojan-sources.js + api/trojans/catalog.js.
 *
 * The SBDB column schema is shared with /api/neo/catalog and VERIFIED in
 * production (2026-11-03). What is new and must be pinned here:
 *   - the TJN query is frozen (no client input) and asks for full precision
 *   - the Horizons request is built only from a validated epoch
 *   - the Horizons CSV vector block parses, and junk is refused, not guessed
 *   - the route's ladder drops full-prec, then photometry, ONLY on a 4xx
 *   - freshness is 'live' only with the population AND Jupiter
 */
import assert from 'node:assert/strict';
import {
    sbdbTrojanUrl, horizonsVectorUrl, horizonsJd, parseHorizonsVector, modalEpoch,
    composeTrojanResponse, TROJAN_CLASS, EPOCH_WINDOW, SBDB_FIELDS_QUALITY, TROJAN_EXTRA_COLUMNS, parseTrojanQuery,
} from '../api/_lib/trojan-sources.js';
import { TROJAN_WIRE_FORMAT, TROJAN_WIRE_COLUMNS, recordsFromCatalog, encodeCatalogRows } from '../js/trojan-dynamics.js';
import { SBDB_FIELDS, SBDB_FIELDS_CORE } from '../api/_lib/neo-sources.js';

// ── URL builders ────────────────────────────────────────────────────────────
{
    const u = new URL(sbdbTrojanUrl());
    assert.equal(u.origin + u.pathname, 'https://ssd-api.jpl.nasa.gov/sbdb_query.api');
    assert.equal(u.searchParams.get('sb-class'), 'TJN');
    assert.equal(TROJAN_CLASS, 'TJN');
    assert.equal(u.searchParams.get('sb-kind'), 'a');
    assert.equal(u.searchParams.get('full-prec'), 'true');
    assert.equal(u.searchParams.get('fields'), SBDB_FIELDS.join(','));
    assert.equal(new URL(sbdbTrojanUrl({ quality: true })).searchParams.get('fields'), [...SBDB_FIELDS, ...SBDB_FIELDS_QUALITY].join(','));
    const plain = new URL(sbdbTrojanUrl({ fullPrecision: false, photometry: false }));
    assert.equal(plain.searchParams.get('full-prec'), null);
    assert.equal(plain.searchParams.get('fields'), SBDB_FIELDS_CORE.join(','));

    assert.equal(horizonsJd(2461200.5), 'JD2461200.50000');
    for (const bad of [NaN, null, undefined, 'x', EPOCH_WINDOW.min - 1, EPOCH_WINDOW.max + 1, "2461200.5'&COMMAND='399"]) {
        assert.equal(horizonsJd(bad), null, `refuses ${bad}`);
    }
    const h = new URL(horizonsVectorUrl('599', 2461200.5));
    assert.equal(h.origin + h.pathname, 'https://ssd.jpl.nasa.gov/api/horizons.api');
    assert.equal(h.searchParams.get('COMMAND'), "'599'");
    assert.equal(h.searchParams.get('CENTER'), "'500@10'", 'Sun body centre: SBDB elements are heliocentric');
    assert.equal(h.searchParams.get('REF_PLANE'), "'ECLIPTIC'");
    assert.equal(h.searchParams.get('START_TIME'), "'JD2461200.50000'");
    assert.equal(h.searchParams.get('STOP_TIME'), "'JD2461201.50000'");
    assert.equal(horizonsVectorUrl('399', 2461200.5), null, 'only the two perturbers');
    assert.equal(horizonsVectorUrl('599', 'now'), null);
}

// ── Horizons CSV vectors ────────────────────────────────────────────────────
{
    const body = { result: [
        '*******************************************************************************',
        ' Ephemeris / API_USER ...',
        '$$SOE',
        '2461200.500000000, A.D. 2026-Jun-11 00:00:00.0000, -1.234567890123456E+00,  5.012345678901234E+00,  6.789012345678901E-03, -7.345678901234567E-03, -1.789012345678901E-03,  1.678901234567890E-04,',
        '2461201.500000000, A.D. 2026-Jun-12 00:00:00.0000, -1.24E+00,  5.01E+00,  6.7E-03, -7.3E-03, -1.7E-03,  1.6E-04,',
        '$$EOE',
    ].join('\n') };
    const p = parseHorizonsVector(body);
    assert.equal(p.ok, true);
    assert.equal(p.jd, 2461200.5, 'the FIRST row is the epoch');
    assert.deepEqual(p.r, [-1.234567890123456, 5.012345678901234, 0.006789012345678901]);
    assert.equal(p.v[2], 0.000167890123456789);
    assert.equal(parseHorizonsVector({ error: 'Cannot interpret date' }).ok, false);
    assert.match(parseHorizonsVector({ error: 'Cannot interpret date' }).reason, /^horizons_error/);
    assert.equal(parseHorizonsVector({ result: 'no block here' }).reason, 'no_ephemeris_block');
    assert.equal(parseHorizonsVector({ result: '$$SOE\n2461200.5, A.D., x, y, z, 1, 2, 3,\n$$EOE' }).reason, 'unparseable_row');
    assert.equal(parseHorizonsVector({ result: '$$SOE\n2461200.5, A.D., 0.1, 0, 0, 1, 2, 3,\n$$EOE' }).reason, 'implausible_radius');
}

// ── Quality columns attach by designation, and leave `unmapped` ─────────────
{
    const json = { fields: [...SBDB_FIELDS, ...SBDB_FIELDS_QUALITY], data: [
        ['624', '624 Hektor (A907 CF)', '7.32', 'TJN', 'N', 'N', '.0243', '5.277', null, '18.15', '342.8', '181.3', '24.9', null, '2461200.5', '4.16', '225', '.025', null, null, '0', '43000', '5120'],
        ['2014 EL58', '(2014 EL58)', '14.48', 'TJN', 'N', 'N', '.1202', '4.969', null, '9.34', '1', '2', '3', null, '2456720.5', '3.9', null, null, null, null, '6', '12', '9'],
    ] };
    const p = parseTrojanQuery(json);
    assert.equal(p.records.length, 2);
    assert.deepEqual([p.records[0].cc, p.records[0].arc_d, p.records[0].n_obs], ['0', 43000, 5120]);
    assert.equal(p.records[1].cc, '6');
    assert.deepEqual(p.quality, { columns: { cc: 'condition_code', arc_d: 'data_arc', n_obs: 'n_obs_used' }, attached: 2 });
    assert.ok(!p.unmapped.includes('condition_code'), 'matched quality columns are not reported as unmapped');
    const body = composeTrojanResponse({ sbdb: p, quality: 'requested', perturbers: { jupiter: { ok: true, jd: 2461200.5, r: [1, 5, 0], v: [0, 0, 0] } } });
    assert.equal(body.format, TROJAN_WIRE_FORMAT);
    assert.deepEqual(body.columns, [...TROJAN_WIRE_COLUMNS]);
    for (const c of TROJAN_EXTRA_COLUMNS) assert.ok(body.columns.includes(c), `quality column ${c} on the wire`);
    for (const c of ['cls', 'flags', 'q', 'tp', 'moid', 'epoch']) assert.ok(!body.columns.includes(c), `${c} is not shipped`);
    assert.equal(body.rows[0].length, body.columns.length);
    // ROUND TRIP: the decoder gives back exactly what the parser produced.
    const back = recordsFromCatalog(body);
    for (const [k, rec] of p.records.entries()) {
        for (const c of ['des', 'name', 'H', 'e', 'a', 'i', 'om', 'w', 'ma', 'epoch', 'diam', 'albedo', 'cc', 'arc_d', 'n_obs']) {
            assert.deepEqual(back[k][c], rec[c] ?? null, `round trip ${rec.des}.${c}`);
        }
    }
    assert.equal(back[0].name, '624 Hektor (A907 CF)', 'name re-joined to its designation');
    assert.equal(body.rows[0][TROJAN_WIRE_COLUMNS.indexOf('name')], 'Hektor (A907 CF)', 'shipped without the designation');
    assert.equal(back[1].epoch, 2456720.5, 'an off-epoch row keeps its own epoch');
    assert.equal(body.rows[0][TROJAN_WIRE_COLUMNS.indexOf('epoch_off')], 0);
    // A perihelion-time-only elliptic row is folded into a mean anomaly.
    const [tpRow] = encodeCatalogRows([{ des: 'x', a: 5.2, e: 0.1, i: 1, om: 2, w: 3, ma: null, tp: 2461200.5 - 100, epoch: 2461200.5 }], 2461200.5);
    const n = Math.sqrt(0.01720209895 ** 2 / 5.2 ** 3) * 180 / Math.PI;
    assert.ok(Math.abs(tpRow[TROJAN_WIRE_COLUMNS.indexOf('ma')] - 100 * n) < 1e-3, 'tp folded into ma');
    // Without the columns the parser still works and attaches nothing.
    const bare = parseTrojanQuery({ fields: json.fields.slice(0, SBDB_FIELDS.length), data: json.data.map(r => r.slice(0, SBDB_FIELDS.length)) });
    assert.equal(bare.quality.attached, 0); assert.equal(bare.records[0].cc, undefined);
}

// ── Epoch and composition ───────────────────────────────────────────────────
{
    const recs = [{ epoch: 2461200.5 }, { epoch: 2461200.5 }, { epoch: 2453839.5 }, { epoch: null }];
    assert.deepEqual(modalEpoch(recs), { epoch: 2461200.5, shared: 2, distinct: 2 });
    const sbdb = { ok: true, records: [{ des: '624', name: '624 Hektor', e: 0.02, a: 5.26, i: 18, om: 342, w: 184, ma: 10, epoch: 2461200.5 }], field_map: {}, unmapped: [] };
    const jup = { ok: true, jd: 2461200.5, r: [1, 5, 0], v: [-0.007, 0.001, 0] };
    const live = composeTrojanResponse({ sbdb, precision: 'full', photometry: 'requested', perturbers: { jupiter: jup, saturn: { ok: false, reason: 'HTTP 503' } } });
    assert.equal(live.freshness, 'live', 'Saturn alone missing does not make the population stale');
    assert.equal(live.perturbers.saturn, null);
    assert.equal(live.sources.saturn.reason, 'HTTP 503');
    assert.equal(live.count, 1);
    assert.equal(recordsFromCatalog(live)[0].des, '624');
    const noJup = composeTrojanResponse({ sbdb, perturbers: { jupiter: { ok: false, reason: 'timeout' } } });
    assert.equal(noJup.freshness, 'stale');
    assert.match(noJup.degraded_reason, /^jupiter_vector_unavailable/);
    assert.equal(noJup.count, 1, 'the rows still ship — they are real');
    const none = composeTrojanResponse({ sbdb: { ok: false, reason: 'HTTP 500', records: [] }, perturbers: {} });
    assert.equal(none.freshness, 'stale');
    assert.equal(none.degraded_reason, 'HTTP 500');
}

// ── The route's ladder, with fetch mocked ───────────────────────────────────
{
    const realFetch = globalThis.fetch;
    const sbdbBody = {
        fields: [...SBDB_FIELDS],
        data: [['624', '624 Hektor (1907 XM)', '7.2', 'TJN', 'N', 'N', '.0238', '5.264', '5.14', '18.17', '342.8', '183.9', '10.1', '', '2461200.5', '4.2', '225', '.025', 'D', null]],
    };
    const vec = { result: '$$SOE\n2461200.5, A.D. 2026, 1.0, 5.0, -0.1, -0.007, 0.0015, 0.0001,\n$$EOE' };
    async function run(policy) {
        const calls = [];
        globalThis.fetch = async (url) => {
            calls.push(String(url));
            const u = new URL(url);
            if (u.hostname === 'ssd-api.jpl.nasa.gov') return policy(u);
            return Response.json(vec);
        };
        const mod = await import('../api/trojans/catalog.js');
        const res = await mod.default(new Request('https://x/api/trojans/catalog?evil=1'));
        return { res, body: await res.json(), calls };
    }
    let r = await run(() => Response.json(sbdbBody));
    assert.equal(r.body.freshness, 'live');
    assert.equal(r.body.precision, 'full');
    assert.equal(r.calls.length, 3, 'one SBDB + two Horizons');
    assert.ok(r.calls.every(c => !c.includes('evil')), 'no client parameter reaches an upstream');

    r = await run((u) => (u.searchParams.get('full-prec') ? new Response('nope', { status: 400 }) : Response.json(sbdbBody)));
    assert.equal(r.body.precision, 'default');
    assert.deepEqual(r.body.sources.sbdb.refused, ['full/requested/quality-requested: HTTP 400', 'full/requested/quality-dropped: HTTP 400']);

    r = await run((u) => (u.searchParams.get('fields').includes('condition_code') ? new Response('nope', { status: 400 }) : Response.json(sbdbBody)));
    assert.equal(r.body.precision, 'full', 'a refused quality column costs only the quality column');
    assert.equal(r.body.quality_fields, 'dropped');

    r = await run((u) => (u.searchParams.get('fields').includes('albedo') ? new Response('nope', { status: 400 }) : Response.json({ ...sbdbBody, fields: [...SBDB_FIELDS_CORE], data: [sbdbBody.data[0].slice(0, SBDB_FIELDS_CORE.length)] })));
    assert.equal(r.body.photometry_fields, 'dropped');
    assert.equal(r.body.freshness, 'live');

    // Node-runtime mode: Vercel passes (req, res) and ignores a return value.
    {
        const mod = await import('../api/trojans/catalog.js');
        const sent = { headers: {} };
        const res = { setHeader: (k, v) => { sent.headers[k] = v; }, end: (b) => { sent.body = b; } };
        const ret = await mod.default({ url: '/api/trojans/catalog' }, res);
        assert.equal(ret, undefined);
        assert.equal(res.statusCode, 200);
        assert.match(sent.headers['content-type'], /json/);
        assert.equal(JSON.parse(sent.body.toString()).freshness, 'live', 'the body is written through res');
    }

    r = await run(() => new Response('down', { status: 503 }));
    assert.equal(r.res.status, 200, 'never 5xx');
    assert.equal(r.body.freshness, 'stale');
    assert.equal(r.calls.length, 1, 'a 5xx is not a schema refusal — no ladder, no Horizons');
    globalThis.fetch = realFetch;
}

console.log('trojan-sources: URL builders, Horizons parser, composition and the route ladder passed');
