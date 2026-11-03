/**
 * Gate for api/_lib/astdys-proper.js + api/trojans/proper.js.
 * The AstDyS layout is UNVERIFIED from the sandbox, so this pins the ADAPTER'S
 * CONTRACT: columns from the file's own header (never by position), the
 * libration unit detected and reported, junk refused (not guessed), the route
 * never 5xx, and no client string reaching an upstream URL.
 */
import assert from 'node:assert/strict';
import { ASTDYS_CANDIDATES, parseSyn, libUnit, normaliseDesignation, composeProperResponse } from '../api/_lib/astdys-proper.js';

const SYN = [
    '% Jupiter Trojans synthetic proper elements',
    '% Name  Mag.  D(deg)  e_p  sinI  f  g  s  LCE',
    '624   7.20   18.95  0.0270  0.3050  0.38  350.1  -12.3  1.5',
    '617   8.19    5.10  0.1410  0.3770  0.37  410.0  -20.0  0.9',
    '2001QR322 13.4 30.2 0.0610 0.0220 0.33 300.5 -5.0 3.1',
].join('\n');
{
    const p = parseSyn(SYN);
    assert.equal(p.ok, true); assert.equal(p.count, 3);
    assert.equal(p.lib_unit, 'deg', 'unit from the header token');
    assert.deepEqual(p.field_map, { name: 'Name', H: 'Mag.', lib: 'D(deg)', e: 'e_p', sinI: 'sinI', f: 'f', g: 'g', s: 's', lce: 'LCE' });
    assert.deepEqual(p.rows[0], { des: '624', H: 7.2, lib: 18.95, e: 0.027, sinI: 0.305, f: 0.38, g: 350.1, s: -12.3, lce: 1.5 });
    assert.equal(p.rows[2].des, '2001QR322');
    // Columns are found BY NAME: a reordered header still maps.
    const re = parseSyn(['% name e_p mag D', '624 0.027 7.2 18.95'].join('\n'));
    assert.equal(re.rows[0].lib, 18.95); assert.equal(re.rows[0].e, 0.027); assert.equal(re.rows[0].H, 7.2);
}
{
    assert.equal(normaliseDesignation('2001 QR322'), '2001QR322', 'SBDB and AstDyS designations compare equal');
    assert.equal(normaliseDesignation('(2014 EL58)'), '2014EL58');
    assert.equal(libUnit('da', [{ lib: 0.05 }]), 'au');
    assert.equal(libUnit('x', [{ lib: 0.04 }, { lib: 0.06 }, { lib: 0.1 }]), 'au', 'by value when the token is silent');
    assert.equal(libUnit('x', [{ lib: 12 }, { lib: 20 }]), 'deg');
    assert.equal(parseSyn('<!DOCTYPE html><html>Not found</html>').reason, 'html_not_data');
    assert.match(parseSyn('624 7.2 18.9\n617 8.1 5.1').reason, /^no_header/, 'no header → refuse, never guess by position');
    assert.match(parseSyn('% a b c\n624 7.2 18.9').reason, /^missing_columns/);
    assert.equal(composeProperResponse({ parsed: { ok: false, reason: 'x', sample_lines: ['a'] } }).freshness, 'stale');
    for (const u of ASTDYS_CANDIDATES) assert.ok(/^https:\/\/(newton\.spacedys\.com|hamilton\.dm\.unipi\.it)\/~astdys2\/propsynth\/[a-z.]+$/.test(u), u);
}
{
    const real = globalThis.fetch; const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return String(url).includes('hamilton') ? new Response(SYN) : new Response('nope', { status: 404 }); };
    const { default: h } = await import('../api/trojans/proper.js');
    let res = await h(new Request('https://x/api/trojans/proper?url=http://evil'));
    let b = await res.json();
    assert.equal(res.status, 200); assert.equal(b.freshness, 'live'); assert.equal(b.count, 3);
    assert.match(b.source_url, /hamilton/); assert.ok(calls.every(c => !c.includes('evil')), 'no client string upstream');
    res = await h(new Request('https://x/api/trojans/proper?meta=1')); b = await res.json();
    assert.equal(b.candidates.length, ASTDYS_CANDIDATES.length); assert.ok(b.candidates.some(c => c.ok && c.rows === 3));
    globalThis.fetch = async () => new Response('down', { status: 503 });
    res = await h(new Request('https://x/api/trojans/proper')); b = await res.json();
    assert.equal(res.status, 200, 'never 5xx'); assert.equal(b.freshness, 'stale');
    globalThis.fetch = real;
}
console.log('astdys-proper: header-driven parse, unit detection, designations, route modes and degradation passed');
