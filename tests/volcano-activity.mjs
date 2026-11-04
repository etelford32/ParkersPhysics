/**
 * volcano-activity.mjs — /api/volcanoes/activity against stubbed upstreams
 *   node tests/volcano-activity.mjs
 *
 * USGS HANS and NASA EONET are egress-blocked at build time, so the route's
 * contract is exercised on stubs:
 *   • HANS rows normalise from ANY of the candidate spellings and the route
 *     self-reports which key answered (field_map) and what it ignored;
 *   • the HANS walk stops at the first candidate URL that answers;
 *   • an HTML page served with a 200 is a failure, never data;
 *   • one source down ⇒ 200 + freshness:'stale' + reasons (PARTIAL list);
 *     both down ⇒ 200 + stale + empty list — never a 5xx;
 *   • EONET titles reduce to a volcano name; stale events are dropped;
 *   • matchActivity joins HANS by GVP number and EONET by position/name,
 *     and RETURNS what it cannot join.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/volcanoes/activity.js';
import { HANS_URLS, EONET_URL, parseHansElevated, eonetVolcanoName } from '../api/_lib/volcano-activity.js';
import { decodeCatalog, matchActivity } from '../js/volcano-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('volcano-activity.mjs');

const NOW = Date.now();
const day = 86_400_000;
const HANS_BODY = [
    { vnum: '332010', volcano_name: 'Kilauea', color_code: 'ORANGE', alert_level: 'WATCH',
      sent_utc: new Date(NOW - 2 * day).toISOString().slice(0, 19).replace('T', ' '), notice_url: 'https://example/n1', obs_abbr: 'hvo' },
    { vnum: '311120', volcano_name: 'Great Sitkin', color_code: 'YELLOW', alert_level: 'ADVISORY', sent_unixtime: Math.floor((NOW - day) / 1000) },
];
const EONET_BODY = { events: [
    { id: 'EONET_1', title: 'Etna Volcano, Italy', link: 'https://eonet/1', sources: [{ id: 'SIVolcano', url: 'https://si/etna' }],
      geometry: [{ type: 'Point', date: new Date(NOW - 20 * day).toISOString(), coordinates: [14.999, 37.748] },
                 { type: 'Point', date: new Date(NOW - 3 * day).toISOString(), coordinates: [14.999, 37.748] }] },
    { id: 'EONET_2', title: 'Fuego Volcano, Guatemala',
      geometry: [{ type: 'Point', date: new Date(NOW - 5 * day).toISOString(), coordinates: [-90.88, 14.47] }] },
    // a LONG-OPEN eruption: EONET pins it once at its start and keeps it open
    // (measured on production). It must be KEPT, and joins by position — GVP
    // files Sakurajima under the Aira caldera.
    { id: 'EONET_OLD', title: 'Sakurajima Volcano, Japan',
      geometry: [{ type: 'Point', date: new Date(NOW - 400 * day).toISOString(), coordinates: [130.657, 31.593] }] },
    { id: 'EONET_SEA', title: 'Unnamed Submarine Volcano, Pacific Ocean',
      geometry: [{ type: 'Point', date: new Date(NOW - 1 * day).toISOString(), coordinates: [-150, -40] }] },
] };

const realFetch = globalThis.fetch;
function stub(plan) {
    const seen = [];
    globalThis.fetch = async (url) => {
        const u = String(url); seen.push(u);
        const r = plan(u);
        return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/json' } });
    };
    return seen;
}
const json = b => ({ body: JSON.stringify(b) });

await ok('HANS rows normalise from candidate spellings, with field_map / unmapped', async () => {
    const p = parseHansElevated(HANS_BODY, NOW);
    assert.equal(p.items.length, 2);
    assert.equal(p.items[0].num, 332010);
    assert.equal(p.items[0].colorCode, 'ORANGE');
    assert.equal(p.items[0].alertLevel, 'WATCH');
    assert.ok(Math.abs(p.items[0].ageDays - 2) < 0.2, `zone-less HANS timestamp read as UTC (${p.items[0].ageDays})`);
    assert.ok(Math.abs(p.items[1].ageDays - 1) < 0.2, 'unix-seconds timestamp');
    assert.equal(p.fieldMap.num, 'vnum');
    assert.deepEqual(p.unmapped, []);
    const alt = parseHansElevated({ data: [{ vNum: 332010, vName: 'Kilauea', colorCode: 'red', alertLevel: 'warning', extra: 1 }] }, NOW);
    assert.equal(alt.items[0].colorCode, 'RED');
    assert.equal(alt.fieldMap.name, 'vName');
    assert.deepEqual(alt.unmapped, ['extra']);
});

await ok('both sources up ⇒ live, HANS stops at the first candidate that answers', async () => {
    const seen = stub(u => u === HANS_URLS[0] ? json(HANS_BODY) : u === EONET_URL ? json(EONET_BODY) : { status: 404 });
    try {
        const b = await (await handler()).json();
        assert.equal(b.freshness, 'live');
        assert.equal(b.sources.usgs_hans.url, HANS_URLS[0]);
        assert.equal(seen.filter(u => u === HANS_URLS[1]).length, 0);
        assert.equal(b.sources.eonet.count, 4, 'a long-open eruption is kept — EONET open/closed is the authority');
        assert.equal(b.sources.eonet.received, 4, 'raw EONET event count is self-reported');
        assert.equal(b.sources.eonet.dropped_stale, 0, 'no age cut');
        assert.equal(b.count, 6);
    } finally { globalThis.fetch = realFetch; }
});

await ok('a 200 HTML page is a failure; the walk continues to the next candidate', async () => {
    stub(u => u === HANS_URLS[0] ? { body: '<html>maintenance</html>', type: 'text/html' }
        : u === HANS_URLS[1] ? json(HANS_BODY) : u === EONET_URL ? json(EONET_BODY) : { status: 404 });
    try {
        const b = await (await handler()).json();
        assert.equal(b.sources.usgs_hans.url, HANS_URLS[1]);
        assert.deepEqual(b.sources.usgs_hans.tried, HANS_URLS);
        assert.equal(b.freshness, 'live');
    } finally { globalThis.fetch = realFetch; }
});

await ok('one source down ⇒ 200 + stale + reasons (partial); both down ⇒ empty, never 5xx', async () => {
    stub(u => u === EONET_URL ? json(EONET_BODY) : { status: 503 });
    try {
        const res = await handler(); const b = await res.json();
        assert.equal(res.status, 200);
        assert.equal(b.freshness, 'stale');
        assert.deepEqual(b.reasons, ['usgs-hans-down']);
        assert.match(b.note, /PARTIAL/);
        assert.equal(b.count, 4);
    } finally { globalThis.fetch = realFetch; }
    stub(() => { throw new Error('ECONNREFUSED'); });
    try {
        const res = await handler(); const b = await res.json();
        assert.equal(res.status, 200);
        assert.equal(b.freshness, 'stale');
        assert.equal(b.count, 0);
        assert.deepEqual(b.reasons, ['usgs-hans-down', 'eonet-down']);
    } finally { globalThis.fetch = realFetch; }
});

await ok('EONET titles → names', async () => {
    assert.equal(eonetVolcanoName('Etna Volcano, Italy'), 'Etna');
    assert.equal(eonetVolcanoName('Kilauea Volcano, Hawaii, United States'), 'Kilauea');
    assert.equal(eonetVolcanoName('Taal Volcanic Complex, Philippines'), 'Taal');
});

await ok('matchActivity joins by GVP number / name / position and returns the rest', async () => {
    const cat = decodeCatalog(JSON.parse(fs.readFileSync(path.join(HERE, '../data/volcanoes/volcanoes-catalog.json'), 'utf8')));
    stub(u => u === HANS_URLS[0] ? json(HANS_BODY) : json(EONET_BODY));
    let b;
    try { b = await (await handler()).json(); } finally { globalThis.fetch = realFetch; }
    const { live, unmatched } = matchActivity(cat, b.items);
    const names = [...live.values()].map(x => x.volcano.name).sort();
    assert.deepEqual(names, ['Aira', 'Etna', 'Fuego', 'Great Sitkin', 'Kilauea']);
    const kil = [...live.values()].find(x => x.volcano.name === 'Kilauea');
    assert.equal(kil.colorCode, 'ORANGE');
    assert.equal(unmatched.length, 1);
    assert.match(unmatched[0].title, /Submarine/);
});

await ok('REAL production body (PR #1068 preview, 2026-11-04) joins completely', async () => {
    // tests/fixtures/volcano-activity-2026-11-04.json is a VERBATIM route body
    // from the deployed preview — never hand-edit it; re-capture from the route.
    const cat = decodeCatalog(JSON.parse(fs.readFileSync(path.join(HERE, '../data/volcanoes/volcanoes-catalog.json'), 'utf8')));
    const body = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/volcano-activity-2026-11-04.json'), 'utf8'));
    assert.equal(body.sources.usgs_hans.field_map.num, 'vnum', 'HANS schema as verified');
    assert.equal(body.sources.eonet.received, 32);
    assert.equal(body.sources.eonet.dropped_stale, 0, 'no long-open eruption dropped');
    const { live, unmatched } = matchActivity(cat, body.items);
    assert.equal(unmatched.length, 0, `unmatched: ${unmatched.map(u => u.name).join(', ')}`);
    assert.equal(live.size, 34, '35 reports → 34 volcanoes (Kilauea is reported by both sources)');
    const kil = [...live.values()].find(x => x.volcano.num === 332010);
    assert.deepEqual(kil.items.map(i => i.source).sort(), ['eonet', 'usgs-hans']);
    assert.equal(kil.colorCode, 'ORANGE');
    const near = (it, v) => {
        const r = Math.PI / 180, dLat = (v.lat - it.lat) * r, dLon = (v.lon - it.lon) * r;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(it.lat * r) * Math.cos(v.lat * r) * Math.sin(dLon / 2) ** 2;
        return 2 * 6371 * Math.asin(Math.sqrt(a));
    };
    for (const x of live.values()) for (const it of x.items) {
        if (it.lat != null) assert.ok(near(it, x.volcano) < 2, `${it.name} joined ${x.volcano.name} ${near(it, x.volcano).toFixed(1)} km away`);
    }
    // GVP files Sakurajima under Aira and Titan Ridge under the Central Bismarck Sea group
    assert.ok([...live.values()].some(x => x.volcano.name === 'Aira'));
});

console.log(`${passed} passed`);
