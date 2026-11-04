/**
 * Gate for api/_lib/astdys-proper.js + api/trojans/proper.js.
 * The AstDyS layout is UNVERIFIED from the sandbox, so this pins the ADAPTER'S
 * CONTRACT: columns from the file's own header (never by position), the
 * libration unit detected and reported, junk refused (not guessed), the route
 * never 5xx, and no client string reaching an upstream URL.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASTDYS_CANDIDATES, parseSyn, normaliseDesignation, composeProperResponse } from '../api/_lib/astdys-proper.js';

// REAL: the first 8 lines of production's tro.syn, captured by the route's
// ?meta=1 probe on 2026-11-03. Never hand-edit; re-capture from the probe.
const SYN = readFileSync(new URL('./fixtures/trojans/astdys-tro-head.syn', import.meta.url), 'utf8');
{
    const p = parseSyn(SYN);
    assert.equal(p.ok, true, p.reason); assert.equal(p.count, 6);
    assert.equal(p.header_line, 'Name H da(AU) D(deg) f(deg/y) e g("/y) sinI s("/y) L My',
        'the TITLE line has as many words as a data row — the header must be the one naming a designation column, with "sin I" merged');
    assert.deepEqual(p.field_map, { name: 'Name', H: 'H', da: 'da(AU)', D: 'D(deg)', f: 'f(deg/y)', e: 'e', g: 'g("/y)', sinI: 'sinI', s: 's("/y)', L: 'L', My: 'My' });
    assert.deepEqual(p.rows[2], { des: '624', H: 7.35, da: 0.0874, D: 18.83, f: 2.317, e: 0.0541, g: 335.59, sinI: 0.3258, s: -12.8, L: 4, My: 5 });
    assert.equal(p.rows[4].My, 50, 'per-row integration span relayed');
    // Columns are found BY NAME: a reordered header still maps.
    const re = parseSyn(['% name e mag D', '624 0.027 7.2 18.95'].join('\n'));
    assert.equal(re.rows[0].D, 18.95); assert.equal(re.rows[0].e, 0.027); assert.equal(re.rows[0].H, 7.2);
}
{
    assert.equal(normaliseDesignation('2001 QR322'), '2001QR322', 'SBDB and AstDyS designations compare equal');
    assert.equal(normaliseDesignation('(2014 EL58)'), '2014EL58');
    assert.equal(parseSyn('<!DOCTYPE html><html>Not found</html>').reason, 'html_not_data');
    assert.match(parseSyn('624 7.2 18.9\n617 8.1 5.1').reason, /^no_header/, 'no header → refuse, never guess by position');
    assert.match(parseSyn('% name b c\n624 7.2 18.9').reason, /^missing_columns:D\|da/);
    assert.equal(composeProperResponse({ parsed: { ok: false, reason: 'x', sample_lines: ['a'] } }).freshness, 'stale');
    for (const u of ASTDYS_CANDIDATES) assert.ok(/^https:\/\/(newton\.spacedys\.com|hamilton\.dm\.unipi\.it)\/~astdys2\/propsynth\/[a-z.]+$/.test(u), u);
}
{
    const real = globalThis.fetch; const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return String(url).includes('hamilton') ? new Response(SYN) : new Response('nope', { status: 404 }); };   // primary down, mirror answers
    const { default: h } = await import('../api/trojans/proper.js');
    let res = await h(new Request('https://x/api/trojans/proper?url=http://evil'));
    let b = await res.json();
    assert.equal(res.status, 200); assert.equal(b.freshness, 'live'); assert.equal(b.count, 6);
    assert.deepEqual(b.columns, ['des', 'H', 'da', 'D', 'f', 'e', 'g', 'sinI', 's', 'L', 'My']);
    assert.match(b.source_url, /hamilton/); assert.ok(calls.every(c => !c.includes('evil')), 'no client string upstream');
    res = await h(new Request('https://x/api/trojans/proper?meta=1')); b = await res.json();
    assert.equal(b.candidates.length, ASTDYS_CANDIDATES.length); assert.ok(b.candidates.some(c => c.ok && c.rows === 6));
    globalThis.fetch = async () => new Response('down', { status: 503 });
    res = await h(new Request('https://x/api/trojans/proper')); b = await res.json();
    assert.equal(res.status, 200, 'never 5xx'); assert.equal(b.freshness, 'stale');
    globalThis.fetch = real;
}
console.log('astdys-proper: header-driven parse, unit detection, designations, route modes and degradation passed');
