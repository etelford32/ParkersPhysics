#!/usr/bin/env node
/**
 * star-collider-page.mjs — the DOM contract between star-collider.html and
 * js/star-collider/page.js.
 *
 * Run: node tests/star-collider-page.mjs
 *
 * The page's readouts are wired by `data-sc="<key>"`, a string contract with
 * no compiler behind it. A key in the markup that nothing writes stays on its
 * em-dash forever and looks like "not available"; a key written by the module
 * with no element to receive it is a number computed, formatted and thrown
 * away. Neither throws. This gate diffs the two key sets statically, in both
 * directions, plus the controls and the chart canvases — the same gate
 * tests/bootes-void-page.mjs runs for its page.
 *
 * page.js writes A/B readouts through template keys (`name${s}`), so the
 * extractor expands `${s}` to both suffixes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const html = read('../star-collider.html');
const page = read('../js/star-collider/page.js');
const charts = read('../js/star-collider/charts.js');

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const uniq = (a) => [...new Set(a)];
const matchAll = (src, re) => uniq([...src.matchAll(re)].map(m => m[1]));

// ── 1. Readout keys, both directions ────────────────────────────────────────
{
    const inMarkup = matchAll(html, /data-sc="([a-zA-Z0-9_]+)"/g);
    const literal = matchAll(page, /\bset\('([a-zA-Z0-9_]+)'/g);
    const templated = matchAll(page, /\bset\(`([a-zA-Z0-9_]*)\$\{s\}([a-zA-Z0-9_]*)`/g);
    const expanded = [];
    for (const m of page.matchAll(/\bset\(`([a-zA-Z0-9_]*)\$\{s\}([a-zA-Z0-9_]*)`/g)) {
        expanded.push(`${m[1]}A${m[2]}`, `${m[1]}B${m[2]}`);
    }
    const written = uniq(literal.concat(expanded));
    const neverWritten = inMarkup.filter(k => !written.includes(k));
    const noElement = written.filter(k => !inMarkup.includes(k));
    assert.deepEqual(neverWritten, [], `data-sc keys in the markup that page.js never writes: ${neverWritten.join(', ')}`);
    assert.deepEqual(noElement, [], `keys page.js writes with no element: ${noElement.join(', ')}`);
    assert.ok(inMarkup.length >= 55, `expected a rich readout set, got ${inMarkup.length}`);
    assert.ok(templated.length >= 1, 'A/B template keys present');
    ok(`${inMarkup.length} readout keys match in both directions`);
}

// ── 2. Controls ─────────────────────────────────────────────────────────────
{
    const inMarkup = matchAll(html, /data-sc-control="([a-zA-Z0-9_]+)"/g);
    const handled = uniq(matchAll(page, /\bctl\('([a-zA-Z0-9_]+)'\)/g)
        .concat(matchAll(page, /\bval\('([a-zA-Z0-9_]+)'\)/g))
        .concat(matchAll(page, /\bnum\('([a-zA-Z0-9_]+)'/g)));
    // Template-keyed controls: ctl(`${k}${s}`) over kind/mass/radius/chi × A/B, ctl(`body${s}`) etc.
    const templ = [];
    for (const k of ['kind', 'mass', 'radius', 'chi', 'body']) for (const s of ['A', 'B']) templ.push(`${k}${s}`);
    const all = uniq(handled.concat(templ));
    const unhandled = inMarkup.filter(k => !all.includes(k));
    assert.deepEqual(unhandled, [], `controls in the markup page.js never reads: ${unhandled.join(', ')}`);
    for (const must of ['run', 'pause', 'reset', 'eos', 'pair', 'particles', 'separation', 'pn25']) {
        assert.ok(inMarkup.includes(must), `control "${must}" missing from markup`);
    }
    ok(`${inMarkup.length} controls all handled`);
}

// ── 3. Charts ───────────────────────────────────────────────────────────────
{
    const inMarkup = matchAll(html, /data-sc-chart="([a-zA-Z0-9_]+)"/g);
    const drawn = matchAll(page, /charts\.get\('([a-zA-Z0-9_]+)'\)/g);
    const missing = inMarkup.filter(k => !drawn.includes(k));
    assert.deepEqual(missing, [], `chart canvases nothing draws: ${missing.join(', ')}`);
    const exported = matchAll(charts, /export function (draw[A-Za-z]+)/g);
    for (const fn of ['drawMassRadius', 'drawWaveform', 'drawFrequencyTrack', 'drawKilonova', 'drawEnergy']) {
        assert.ok(exported.includes(fn), `${fn} not exported by charts.js`);
        assert.ok(page.includes(fn + '('), `${fn} never called by page.js`);
    }
    ok(`${inMarkup.length} chart canvases have drawing calls`);
}

// ── 4. Structural must-haves ────────────────────────────────────────────────
{
    assert.ok(/<nav><\/nav>/.test(html), 'nav shell present');
    assert.ok(/initNav\("star-collider"\)/.test(html), 'initNav called with the page id');
    assert.ok(/id="sc-stage"/.test(html) && /id="sc-stage-fallback"/.test(html), 'stage + fallback present');
    // An author display on the fallback needs its own [hidden] rule.
    assert.ok(/#sc-stage-fallback\[hidden\]\s*\{\s*display:\s*none/.test(html), 'fallback carries its own [hidden]{display:none} rule');
    assert.ok(/id="sc-catalog"/.test(html), 'catalog rail present');
    assert.ok(/MEASURED · MODELLED/.test(html), 'provenance banner present');
    assert.ok(!/fetch\(/.test(page), 'page.js fetches nothing — the page is offline by design');
    assert.ok(/three\/addons\//.test(html), 'importmap for three present');
    ok('structure: nav shell, stage + fallback rule, catalog rail, provenance, no fetch');
}

// ── 5. Registration ─────────────────────────────────────────────────────────
{
    const catalog = read('../js/simulations-catalog.js');
    assert.ok(/href: 'star-collider\.html'/.test(catalog), 'registered in js/simulations-catalog.js');
    const sitemap = read('../sitemap.xml');
    assert.ok(/star-collider\.html/.test(sitemap), 'in sitemap.xml');
    const build = read('../build-wasm.sh');
    assert.ok(/rust-star-collider/.test(build), 'crate in build-wasm.sh');
    const cargo = read('../Cargo.toml');
    assert.ok(/"rust-star-collider"/.test(cargo), 'crate excluded from the root workspace');
    ok('registered: catalog, sitemap, build-wasm.sh, root Cargo.toml exclude');
}

console.log(`✅ star-collider-page: ${passed} checks passed`);
