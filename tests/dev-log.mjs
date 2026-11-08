#!/usr/bin/env node
/**
 * dev-log.mjs — structural gate for js/dev-log.js (the build log behind
 * recent-development.html and feedback.html's "Recent changes" panel).
 *
 * What it pins:
 *   - every entry is well formed: unique kebab id, real date, known kind /
 *     section / glyph, summary ends with a period, no generic "AI-powered"
 *     copy (CLAUDE.md §7)
 *   - DEV_LOG is newest first (the page and the draft script rely on it)
 *   - every link points at a root page that EXISTS and resolves a label —
 *     a log entry that sends a visitor to a 404 is worse than no entry
 *   - every entry falls in exactly one sprint, sprints do not overlap, at
 *     most one sprint is open and it is the newest
 *   - PR numbers are unique and never both logged and in UNLOGGED_PRS
 *   - the page is registered as a non-simulation page and is linked from
 *     the nav (an orphaned log is how the last one went stale)
 *   - the helpers: filter, grouping, freshness, date formatting
 *   - the PRE-RENDERED page and the RSS feed are in sync with the log
 *     (scripts/build-recent-development.mjs), the feed carries one item per
 *     entry with a stable permalink guid, and nothing in it is unescaped
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    DEV_LOG, KINDS, KIND_IDS, LOG_SECTION_IDS, SPRINTS, UNLOGGED_PRS,
    dateMs, linkLabel, sprintFor, matches, groupBySprint, countByKind,
    isFresh, latest, formatDate, sprintRange,
} from '../js/dev-log.js';
import { GLYPH_IDS } from '../js/glyphs.js';
import { NON_SIMULATION_PAGES } from '../js/simulations-catalog.js';
import { buildOutputs, feedXml, rfc822, FEED_LIMIT } from '../scripts/build-recent-development.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('dev-log');

test('entries are well formed', () => {
    const ids = new Set();
    const glyphs = new Set(GLYPH_IDS);
    for (const e of DEV_LOG) {
        const at = `entry "${e.id}"`;
        assert.match(e.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${at}: id must be kebab-case`);
        assert.ok(!ids.has(e.id), `${at}: duplicate id`);
        ids.add(e.id);
        assert.ok(Number.isFinite(dateMs(e.date)), `${at}: bad date ${e.date}`);
        assert.ok(KIND_IDS.includes(e.kind), `${at}: unknown kind ${e.kind}`);
        assert.ok(LOG_SECTION_IDS.includes(e.section), `${at}: unknown section ${e.section}`);
        assert.ok(glyphs.has(e.icon), `${at}: unknown glyph ${e.icon} (js/glyphs.js GLYPH_IDS)`);
        assert.ok(typeof e.title === 'string' && e.title.length > 3 && !/\.$/.test(e.title),
            `${at}: title must be a short headline with no trailing period`);
        assert.ok(/[.!?]$/.test(e.summary.trim()), `${at}: summary must end with a period`);
        assert.ok(e.summary.length <= 360, `${at}: summary is ${e.summary.length} chars — move detail into highlights`);
        assert.ok(!/ai[- ]powered/i.test(JSON.stringify(e)), `${at}: no "AI-powered" copy (CLAUDE.md §7)`);
        assert.ok(e.pr === null || (Number.isInteger(e.pr) && e.pr > 0), `${at}: pr must be a positive integer or null`);
        assert.ok(Array.isArray(e.links) && e.links.length > 0, `${at}: needs at least one link`);
        if (e.highlights) assert.ok(Array.isArray(e.highlights) && e.highlights.every(h => typeof h === 'string' && h.length),
            `${at}: highlights must be non-empty strings`);
    }
});

test('DEV_LOG is newest first', () => {
    for (let i = 1; i < DEV_LOG.length; i++) {
        assert.ok(DEV_LOG[i - 1].date >= DEV_LOG[i].date,
            `"${DEV_LOG[i - 1].id}" (${DEV_LOG[i - 1].date}) is above "${DEV_LOG[i].id}" (${DEV_LOG[i].date})`);
    }
});

test('every link points at an existing root page and has a label', () => {
    for (const e of DEV_LOG) {
        for (const link of e.links) {
            const page = link.href.split(/[?#]/)[0];
            assert.match(page, /^[a-z0-9-]+\.html$/, `entry "${e.id}": href ${link.href} must be a root *.html page`);
            assert.ok(existsSync(join(ROOT, page)), `entry "${e.id}": ${page} does not exist`);
            assert.ok(linkLabel(link), `entry "${e.id}": ${page} is not in the catalog — give the link a label`);
        }
    }
});

test('sprints: windows valid, no overlap, one open sprint at most (the newest)', () => {
    const ids = new Set();
    for (const s of SPRINTS) {
        assert.ok(!ids.has(s.id), `duplicate sprint id ${s.id}`);
        ids.add(s.id);
        assert.ok(Number.isFinite(dateMs(s.start)), `sprint ${s.id}: bad start`);
        assert.ok(s.end === null || dateMs(s.end) >= dateMs(s.start), `sprint ${s.id}: end before start`);
        assert.ok(s.label && s.goal && /[.!?]$/.test(s.goal), `sprint ${s.id}: needs a label and a goal sentence`);
    }
    const open = SPRINTS.filter(s => s.end === null);
    assert.ok(open.length <= 1, 'more than one open sprint');
    if (open.length) assert.equal(open[0], SPRINTS[0], 'the open sprint must be the newest (first)');
    for (let i = 1; i < SPRINTS.length; i++) {
        assert.ok(SPRINTS[i].end !== null && dateMs(SPRINTS[i].end) < dateMs(SPRINTS[i - 1].start),
            `sprint ${SPRINTS[i].id} overlaps or is out of order with ${SPRINTS[i - 1].id}`);
    }
});

test('every entry lands in exactly one sprint', () => {
    for (const e of DEV_LOG) {
        const hits = SPRINTS.filter(s => dateMs(e.date) >= dateMs(s.start) && (s.end === null || dateMs(e.date) <= dateMs(s.end)));
        assert.equal(hits.length, 1, `entry "${e.id}" (${e.date}) is in ${hits.length} sprints — extend or fix SPRINTS`);
        assert.equal(sprintFor(e.date), hits[0]);
    }
});

test('PR numbers unique and not both logged and skipped', () => {
    const seen = new Set();
    for (const e of DEV_LOG.filter(e => e.pr)) {
        assert.ok(!seen.has(e.pr), `PR #${e.pr} logged twice`);
        seen.add(e.pr);
        assert.ok(!(e.pr in UNLOGGED_PRS), `PR #${e.pr} is logged AND in UNLOGGED_PRS`);
    }
    for (const [pr, why] of Object.entries(UNLOGGED_PRS)) {
        assert.ok(Number.isInteger(Number(pr)) && typeof why === 'string' && why.length, `UNLOGGED_PRS[${pr}] needs a reason`);
    }
});

test('the page is registered and linked from the nav', () => {
    assert.ok(existsSync(join(ROOT, 'recent-development.html')));
    assert.ok(NON_SIMULATION_PAGES.has('recent-development.html'), 'add recent-development.html to NON_SIMULATION_PAGES');
    assert.match(readFileSync(join(ROOT, 'js/nav.js'), 'utf8'), /href: 'recent-development\.html'/,
        'recent-development.html must be linked from js/nav.js');
    assert.match(readFileSync(join(ROOT, 'feedback.html'), 'utf8'), /js\/dev-log\.js/,
        'feedback.html must render its "Recent changes" from js/dev-log.js, not a hand-written list');
});

test('helpers: filter, grouping, counts', () => {
    const e = DEV_LOG[0];
    assert.ok(matches(e, {}));
    assert.ok(matches(e, { kind: e.kind }));
    assert.ok(!matches(e, { kind: KIND_IDS.find(k => k !== e.kind) }));
    assert.ok(matches(e, { q: e.title.split(' ')[0].toLowerCase() }));
    assert.ok(!matches(e, { q: 'zzzz-no-such-word' }));
    if (e.pr) assert.ok(matches(e, { q: `#${e.pr}` }));

    const all = groupBySprint();
    assert.equal(all.reduce((n, g) => n + g.entries.length, 0), DEV_LOG.length, 'grouping must not drop entries');
    const fixes = groupBySprint(DEV_LOG, { kind: 'fix' });
    assert.ok(fixes.every(g => g.entries.length && g.entries.every(x => x.kind === 'fix')));

    const counts = countByKind();
    assert.deepEqual(Object.keys(counts), KINDS.map(k => k.id));
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), DEV_LOG.length);
});

test('helpers: freshness, latest, formatting', () => {
    const now = dateMs('2026-11-08');
    assert.ok(isFresh({ date: '2026-11-04' }, now));
    assert.ok(!isFresh({ date: '2026-10-01' }, now));
    assert.ok(!isFresh({ date: '2026-12-01' }, now), 'a future date is not "new"');
    assert.equal(latest(1)[0], DEV_LOG[0]);
    assert.equal(formatDate('2026-11-04'), 'Nov 4, 2026');
    assert.equal(formatDate('2026-11-04', { year: false }), 'Nov 4');
    assert.ok(Number.isNaN(dateMs('2026-02-30')), 'impossible dates are rejected');
    assert.equal(sprintRange({ start: '2026-10-26', end: '2026-11-02' }), 'Oct 26 – Nov 2, 2026');
    assert.equal(sprintRange({ start: '2026-11-03', end: null }), 'Nov 3, 2026 – in progress');
});

test('pre-rendered page and RSS feed are in sync with the log', () => {
    const out = buildOutputs();
    assert.equal(readFileSync(join(ROOT, 'recent-development.html'), 'utf8'), out.page,
        'recent-development.html is stale — run: node scripts/build-recent-development.mjs');
    assert.ok(existsSync(join(ROOT, 'recent-development.xml')), 'recent-development.xml is missing — run the builder');
    assert.equal(readFileSync(join(ROOT, 'recent-development.xml'), 'utf8'), out.feed,
        'recent-development.xml is stale — run: node scripts/build-recent-development.mjs');
    // Every entry is baked into the page, and the toolbar ships hidden (it needs JS).
    for (const e of DEV_LOG) assert.ok(out.page.includes(`id="${e.id}"`), `entry "${e.id}" is not baked into the page`);
    assert.match(out.page, /<div class="rd-toolbar" id="rd-toolbar" role="search" hidden>/);
    assert.match(out.page, /<link rel="alternate" type="application\/rss\+xml"[^>]*href="\/recent-development\.xml">/);
});

test('RSS feed: one item per entry, permalink guids, RFC 822 dates, escaped text', () => {
    const xml = feedXml();
    const items = xml.split('<item>').slice(1);
    assert.equal(items.length, Math.min(FEED_LIMIT, DEV_LOG.length));
    const guids = items.map(i => i.match(/<guid isPermaLink="true">([^<]+)<\/guid>/)[1]);
    assert.equal(new Set(guids).size, guids.length, 'duplicate guid');
    assert.equal(guids[0], `https://parkersphysics.com/recent-development.html#${latest(1)[0].id}`);
    assert.equal(rfc822('2026-11-04'), 'Wed, 04 Nov 2026 00:00:00 GMT');
    // Outside the comment and markup, no raw '&' (must be an entity) and no raw '<' in text.
    const body = xml.replace(/<!--[\s\S]*?-->/, '');
    assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(body), 'unescaped & in the feed');
    for (const i of items) {
        const desc = i.match(/<description>([\s\S]*?)<\/description>/)[1];
        assert.ok(!desc.includes('<'), 'raw < inside an item description');
    }
    // The deploy workflow copies root assets by explicit list — the feed must be on it.
    assert.match(readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8'), /\brecent-development\.xml\b/,
        'recent-development.xml is not in deploy.yml\'s root-asset copy list — it would 404 in production');
});

console.log(`${passed} passed`);
