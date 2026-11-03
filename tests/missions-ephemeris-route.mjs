/**
 * tests/missions-ephemeris-route.mjs — /api/missions/ephemeris against a
 * stubbed JPL Horizons (egress-blocked at build time, which is why the
 * spacecraft ids resolve from CANDIDATE lists in the first place).
 *
 *   node tests/missions-ephemeris-route.mjs
 *
 * Gates:
 *   • candidates are tried IN ORDER and the walk stops at the first table;
 *     `command_used` names the winner and `tried` records each miss by reason
 *     (one production request settles the ids);
 *   • a Horizons name LIST (ambiguous) is a miss, not a table;
 *   • the host planets ride along (earth always) so local offsets anchor;
 *   • a dead upstream is 200 + freshness:'stale' + note, NEVER a 5xx, and a
 *     short cache; a live answer caches for an hour;
 *   • ids are capped and unknown ids are reported, not 400'd.
 */
import assert from 'node:assert/strict';
import handler, { DEFAULT_IDS, MAX_IDS, HORIZONS_CONCURRENCY } from '../api/missions/ephemeris.js';

let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log(`  ✓ ${name}`); });
console.log('missions-ephemeris-route.mjs');

const JD0 = 2461347.5;
function table(cmd) {
    const rows = [];
    for (let h = 0; h <= 26; h++) rows.push(`${(JD0 + h / 24).toFixed(9)}, A.D. 2026-Nov-03 00:00:00.0000, ${(0.3 + h * 1e-3).toExponential(15)}, 2.000000000000000E-01, 1.000000000000000E-03, 1.0E-02, 2.0E-03, 0.0E+00, 1.0E-03, 1.0E-01, 1.0E-02,`);
    return `Target body name: ${cmd}\n$$SOE\n${rows.join('\n')}\n$$EOE\n`;
}
const LIST = 'Multiple major-bodies match string "HERA"\n  ID#  Name\n  103 Hera\n -1176 Hera (spacecraft)\n';

const realFetch = globalThis.fetch;
/** plan: COMMAND value → 'table'|'list'|'nomatch'|'http500'|'http400'|'busy-once'|'throw' */
function stub(plan) {
    const seen = [];
    const busy = new Set();
    let active = 0; stub.peak = 0;
    globalThis.fetch = async (url) => {
        const u = new URL(String(url));
        assert.ok(!String(url).includes('+'), 'spaces go on the wire as %20, never +');
        assert.equal(u.searchParams.get('REF_PLANE'), 'ECLIPTIC');
        assert.equal(u.searchParams.get('REF_FRAME'), null, 'REF_FRAME is not a Horizons parameter');
        const cmd = (u.searchParams.get('COMMAND') || '').replace(/'/g, '');
        seen.push(cmd);
        active++; stub.peak = Math.max(stub.peak, active);
        await new Promise(r => setTimeout(r, 2));
        active--;
        const k = plan[cmd] || plan['*'] || 'nomatch';
        if (k === 'throw') throw new TypeError('fetch failed');
        if (k === 'http500') return new Response('oops', { status: 500 });
        if (k === 'http400') return new Response(JSON.stringify({ code: '400', message: 'one or more query parameter was not recognized' }), { status: 400 });
        if (k === 'busy-once') {
            if (!busy.has(cmd)) { busy.add(cmd); return new Response('busy', { status: 503 }); }
            return Response.json({ result: table(cmd) });
        }
        const result = k === 'table' ? table(cmd) : k === 'list' ? LIST : 'No matches found.';
        return Response.json({ signature: { version: '1.2' }, result });
    };
    return seen;
}
const restore = () => { globalThis.fetch = realFetch; };
const req = (qs = '') => new Request(`https://x.test/api/missions/ephemeris${qs ? '?' + qs : ''}`);

await ok('candidates walk in order, stop at the first table, and self-report', async () => {
    const seen = stub({ '-1176': 'nomatch', 'Hera (spacecraft)': 'table', '399': 'table', '-96': 'table' });
    const res = await handler(req('ids=hera,parker-solar-probe'), { now: JD0 + 0.5 });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.freshness, 'live');
    assert.equal(j.requested, 2);
    assert.equal(j.resolved, 2);
    const hera = j.spacecraft.find(s => s.id === 'hera');
    assert.equal(hera.ok, true);
    assert.equal(hera.command_used, 'Hera (spacecraft)');
    assert.deepEqual(hera.tried, [{ command: '-1176', reason: 'no-match' }]);
    assert.equal(hera.samples.length, 27);
    const psp = j.spacecraft.find(s => s.id === 'parker-solar-probe');
    assert.equal(psp.command_used, '-96');
    assert.deepEqual(psp.tried, []);
    assert.ok(seen.indexOf('-1176') < seen.indexOf('Hera (spacecraft)'), 'in order');
    assert.ok(j.hosts.earth && j.hosts.earth.command === '399' && j.hosts.earth.samples.length === 27, 'earth rides along');
    assert.match(res.headers.get('cache-control'), /s-maxage=3600/);
    assert.equal(j.window.hours, 26);
    restore();
});

await ok('an ambiguous NAME LIST is a miss, and a mission with no winner is ok:false with every reason', async () => {
    stub({ '-1176': 'list', 'Hera (spacecraft)': 'http500', '399': 'table', '-96': 'table' });
    const j = await (await handler(req('ids=hera,parker-solar-probe'), { now: JD0 })).json();
    const hera = j.spacecraft.find(s => s.id === 'hera');
    assert.equal(hera.ok, false);
    assert.equal(hera.command_used, null);
    assert.deepEqual(hera.tried.map(t => t.reason), ['ambiguous-name', 'http-500 (oops)']);
    assert.equal(hera.samples, null);
    assert.equal(j.resolved, 1);
    assert.equal(j.freshness, 'live');
    restore();
});

await ok('a 503 is retried once and a 400 carries Horizons\' own message; concurrency is capped', async () => {
    const seen = stub({ '-21': 'busy-once', '-92': 'http400', '399': 'table', '-8': 'table', '-78': 'table', '-43': 'table', '-96': 'table', '-144': 'table' });
    const j = await (await handler(req('ids=soho,ace,wind,dscovr,imap,parker-solar-probe,solar-orbiter'), { now: JD0 })).json();
    const soho = j.spacecraft.find(s => s.id === 'soho');
    assert.equal(soho.ok, true, 'resolved on the retry');
    assert.equal(seen.filter(c => c === '-21').length, 2, 'exactly one retry');
    const ace = j.spacecraft.find(s => s.id === 'ace');
    assert.equal(ace.ok, false);
    assert.equal(ace.tried[0].reason, 'http-400 (one or more query parameter was not recognized)');
    assert.equal(seen.filter(c => c === '-92').length, 1, 'a 400 is not retried');
    assert.ok(stub.peak <= HORIZONS_CONCURRENCY, `peak in-flight ${stub.peak} ≤ ${HORIZONS_CONCURRENCY}`);
    assert.ok(stub.peak >= 2, 'calls still overlap');
    restore();
});

await ok('local missions pull their host; mars rides along for an MRO request', async () => {
    const seen = stub({ '*': 'table' });
    const j = await (await handler(req('ids=mars-reconnaissance-orbiter'), { now: JD0 })).json();
    assert.ok(seen.includes('499'), 'asked Horizons for Mars');
    assert.ok(j.hosts.mars && j.hosts.earth);
    restore();
});

await ok('dead upstream: 200 + stale + note + short cache, never a 5xx', async () => {
    stub({ '*': 'throw' });
    const res = await handler(req('ids=soho,ace'), { now: JD0 });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.freshness, 'stale');
    assert.equal(j.resolved, 0);
    assert.match(j.note, /no vector table/);
    assert.equal(j.spacecraft[0].tried[0].reason, 'fetch:network');
    assert.ok(j.host_misses.some(h => h.host === 'earth'));
    assert.match(res.headers.get('cache-control'), /s-maxage=120/);
    restore();
});

await ok('spacecraft resolve but Earth does not → stale (local offsets cannot anchor)', async () => {
    stub({ '-21': 'table', '399': 'http500' });
    const j = await (await handler(req('ids=soho'), { now: JD0 })).json();
    assert.equal(j.resolved, 1);
    assert.equal(j.freshness, 'stale');
    assert.match(j.note, /Earth host vector missing/);
    restore();
});

await ok('default probe set is the heliophysics core; ids are capped; unknown ids are reported', async () => {
    const seen = stub({ '*': 'table' });
    const j = await (await handler(req(), { now: JD0 })).json();
    assert.deepEqual(j.spacecraft.map(s => s.id), [...DEFAULT_IDS]);
    assert.ok(!seen.includes('-170'), 'JWST not in the default probe');
    restore();
    stub({ '*': 'table' });
    const many = Array.from({ length: MAX_IDS + 5 }, (_, i) => i < 2 ? ['soho', 'ace'][i] : `nope-${i}`).join(',');
    const k = await (await handler(req(`ids=${many}`), { now: JD0 })).json();
    assert.equal(k.requested, 2);
    assert.ok(k.unknown_ids.length === MAX_IDS - 2, `unknown capped to ${k.unknown_ids.length}`);
    restore();
});

restore();
console.log(`missions-ephemeris-route.mjs: ${passed} checks passed`);
