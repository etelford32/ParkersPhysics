#!/usr/bin/env node
/**
 * Structural gate for the homepage Simulation Showcase
 * (js/home-showcase-slides.js + assets/home/showcase/manifest.json).
 *
 * WHAT THIS CATCHES
 * ─────────────────
 * The showcase joins a JS registry to the simulations catalogue and to a
 * generated manifest at runtime and SKIPS anything that doesn't line up — a
 * slide whose catalogue id was renamed, a manifest entry whose file was
 * deleted, a capture recipe pointing at a page that no longer exists. Every
 * one of those fails silently in the browser (the card just isn't there, or
 * shows "capture pending" forever), so the gate makes them loud:
 *
 *   1. registry entries are well-formed, ids unique and CATALOGUED
 *      (js/simulations-catalog.js), capture urls exist on disk, every
 *      section used is a js/site-sections.js section
 *   2. the manifest (when present) references only registered ids and only
 *      files that exist; every captured slide has a poster, a date and a
 *      renderer
 *   3. media stays inside the budget the module header promises — one
 *      slide's poster + clip must never exceed 1.5 MB, so a "quick" re-capture
 *      at 4K cannot quietly triple the page's weight
 *   4. index.html mounts the showcase and no longer branches on the retired
 *      home_bg_carousel experiment, which must be paused in js/experiments.js
 *
 * Run: node tests/home-showcase.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SHOWCASE_ENTRIES, SHOWCASE_SLIDES, resolveSlides, MANIFEST_URL, MEDIA_DIR } =
    await import(pathToFileURL(path.join(ROOT, 'js/home-showcase-slides.js')).href);
const { SIMULATIONS } = await import(pathToFileURL(path.join(ROOT, 'js/simulations-catalog.js')).href);
const { SITE_SECTIONS } = await import(pathToFileURL(path.join(ROOT, 'js/site-sections.js')).href);
// experiments.js boots telemetry (window) on import, so read it as text.
const expSrc = readFileSync(path.join(ROOT, 'js/experiments.js'), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const ok   = (msg) => console.log('  ✓ ' + msg);

// 1. registry
console.log('registry');
const catalogIds = new Set(SIMULATIONS.map((s) => s.id));
const sectionIds = new Set(SITE_SECTIONS.map((s) => s.id));
const ids = new Set();
for (const e of SHOWCASE_ENTRIES) {
    if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) fail(`bad id ${JSON.stringify(e.id)}`);
    if (ids.has(e.id)) fail(`duplicate id ${e.id}`); ids.add(e.id);
    if (!catalogIds.has(e.id)) fail(`${e.id}: not a js/simulations-catalog.js id`);
    for (const k of ['does', 'claim', 'model', 'data', 'verb', 'accent']) if (!e[k]) fail(`${e.id}: missing ${k}`);
    if (e.accent && !/^#[0-9a-f]{6}$/i.test(e.accent)) fail(`${e.id}: accent must be a 6-digit hex`);
    for (const k of ['does', 'claim']) if (e[k] && !/[.!?]$/.test(e[k].trim())) fail(`${e.id}: ${k} should end with a period`);
    if (e.verb && /[.!?]$/.test(e.verb.trim())) fail(`${e.id}: verb must not end with punctuation (the card adds the arrow)`);
    const c = e.capture;
    if (!c) { fail(`${e.id}: no capture recipe`); continue; }
    const page = c.url.replace(/^\//, '').split('?')[0];
    if (!existsSync(path.join(ROOT, page))) fail(`${e.id}: capture url ${c.url} not on disk`);
    if (!c.crop || !c.ready) fail(`${e.id}: capture needs crop + ready`);
    if (!Array.isArray(c.hide)) fail(`${e.id}: capture.hide must be an array`);
}
if (SHOWCASE_SLIDES.length !== SHOWCASE_ENTRIES.length) fail(`resolveSlides dropped ${SHOWCASE_ENTRIES.length - SHOWCASE_SLIDES.length} entr(ies) — uncatalogued id`);
for (const s of SHOWCASE_SLIDES) {
    if (!sectionIds.has(s.section)) fail(`${s.id}: catalogue category ${s.section} is not a site section`);
    if (!s.href || !existsSync(path.join(ROOT, s.href.split('#')[0]))) fail(`${s.id}: href ${s.href} not on disk`);
    if (!s.title || !s.tier) fail(`${s.id}: catalogue record lacks title/tier`);
}
if (SHOWCASE_SLIDES.length < 12) fail(`expected at least 12 showcase slides, got ${SHOWCASE_SLIDES.length}`);
// resolveSlides is PURE: an uncatalogued id is dropped, never thrown.
const dropped = resolveSlides([{ id: 'no-such-sim', capture: {} }], SIMULATIONS);
if (dropped.length !== 0) fail('resolveSlides must drop uncatalogued ids');
// Every nav section with a showcase card, so the filter row is not one chip.
const sectionsUsed = new Set(SHOWCASE_SLIDES.map((s) => s.section));
if (sectionsUsed.size < 3) fail(`showcase spans only ${sectionsUsed.size} section(s); filters need at least 3`);
if (!failures) ok(`${SHOWCASE_SLIDES.length} slides, all catalogued, capture urls exist, ${sectionsUsed.size} sections`);

// 2 + 3. manifest
console.log('manifest');
const mPath = path.join(ROOT, MANIFEST_URL);
if (!existsSync(mPath)) {
    console.log('  – no manifest (every card shows "capture pending"; run scripts/capture-home-showcase.mjs)');
} else {
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    if (!Array.isArray(m.slides)) fail('manifest.slides is not an array');
    const BUDGET = 1.5 * 1024 * 1024;
    for (const e of m.slides || []) {
        if (!ids.has(e.id)) { fail(`manifest id ${e.id} is not registered`); continue; }
        if (!e.poster || !e.poster.startsWith(MEDIA_DIR)) fail(`${e.id}: poster must live under ${MEDIA_DIR}`);
        if (!e.capturedAt || Number.isNaN(Date.parse(e.capturedAt))) fail(`${e.id}: capturedAt missing/invalid`);
        if (!e.renderer) fail(`${e.id}: renderer missing (the card discloses software renders)`);
        let bytes = 0;
        for (const k of ['poster', 'clip']) {
            if (!e[k]) continue;
            const p = path.join(ROOT, e[k]);
            if (!existsSync(p)) { fail(`${e.id}: ${k} ${e[k]} not on disk`); continue; }
            bytes += statSync(p).size;
        }
        if (bytes > BUDGET) fail(`${e.id}: poster+clip is ${(bytes / 1048576).toFixed(2)} MB (> 1.5 MB budget)`);
    }
    const missing = SHOWCASE_SLIDES.filter((s) => !(m.slides || []).some((e) => e.id === s.id)).map((s) => s.id);
    if (missing.length) console.log(`  – not yet captured: ${missing.join(', ')}`);
    if (!failures) ok(`${(m.slides || []).length} manifest entries resolve to files within budget`);
}

// 4. wiring
console.log('wiring');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!/home-showcase\.js/.test(html)) fail('index.html does not import js/home-showcase.js');
if (!/id="showcase-host"/.test(html)) fail('index.html has no #showcase-host');
if (/assign\('home_bg_carousel'\)/.test(html)) fail("index.html still branches on assign('home_bg_carousel') — the background carousel was retired 2026-11-09");
if (/home-carousel\.js/.test(html)) fail('index.html still references the retired js/home-carousel.js');
const expBlock = expSrc.match(/home_bg_carousel:\s*\{[\s\S]*?\n\s{4}\},/);
if (!expBlock) fail('EXPERIMENTS.home_bg_carousel is missing (keep the entry paused so admin keeps its history)');
else if (/status:\s*'running'/.test(expBlock[0])) fail('home_bg_carousel is still running — it was concluded 2026-11-09');
if (existsSync(path.join(ROOT, 'js/home-carousel.js'))) fail('js/home-carousel.js is back — the showcase replaced it');
if (!failures) ok('showcase mounted in index.html, carousel experiment paused, old module gone');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
