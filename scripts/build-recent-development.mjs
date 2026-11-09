#!/usr/bin/env node
/**
 * build-recent-development.mjs — bake js/dev-log.js into recent-development.html
 * and write the RSS feed recent-development.xml.
 *
 * WHY THE PAGE IS PRE-RENDERED
 * ────────────────────────────
 * Recent Development is the page that gets SHARED — announcements, partner
 * follow-ups, link previews in Slack / LinkedIn / iMessage — and those
 * unfurlers and most AI crawlers do not run JavaScript. Client-rendered, they
 * saw a hero and an empty timeline. So the markup is baked here from the SAME
 * builders the page re-renders with (js/recent-development.js), the toolbar is
 * baked `hidden` (it does nothing without JS), and the page module only adds
 * filtering, search and the live "NEW" badges on top. simulations.html made
 * the same choice for the same reason (scripts/build-simulations-page.mjs).
 *
 * DETERMINISM: everything time-dependent is relative to the NEWEST ENTRY's
 * date (`bakeNowMs`), never the build clock — otherwise `--check` would go
 * red overnight with nobody having touched the log.
 *
 * THE FEED: RSS 2.0, newest FEED_LIMIT entries, one <item> per entry with a
 * permalink guid of recent-development.html#<id> (ids are stable by contract,
 * js/dev-log.js), so readers never re-announce an entry whose wording was
 * edited. It is a separate feed from rss.xml (the Field Notes feed) on purpose:
 * someone who wants the writing is not asking for every fix.
 *
 * DEPLOY: .github/workflows/deploy.yml copies root assets by an EXPLICIT list
 * (its globs only match *.html/*.css/*.js) — recent-development.xml is on that
 * list; a feed missing from it works locally and 404s in production.
 *
 *   node scripts/build-recent-development.mjs          # rewrite both files
 *   node scripts/build-recent-development.mjs --check  # exit 1 if stale (CI)
 *
 * `buildOutputs()` is exported so tests/dev-log.mjs can compare without
 * shelling out.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DEV_LOG, KINDS, LOG_SECTIONS, latest, linkLabel, formatDate } from '../js/dev-log.js';
import { statsHtml, spotlightHtml, timelineHtml, bakeNowMs } from '../js/recent-development.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'recent-development.html');
const FEED = join(ROOT, 'recent-development.xml');
const ORIGIN = 'https://parkersphysics.com';
const PAGE_URL = `${ORIGIN}/recent-development.html`;
const FEED_URL = `${ORIGIN}/recent-development.xml`;
export const FEED_LIMIT = 50;

const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const REGIONS = ['HEAD', 'STATS', 'SPOTLIGHT', 'TIMELINE'];

function headHtml() {
    const newest = latest(1)[0];
    const desc = `Every simulation, data set, layer and fix shipped on Parkers Physics — ${DEV_LOG.length} updates, `
        + `logged sprint by sprint${newest ? `, last updated ${formatDate(newest.date)}` : ''}, each with a link to open it.`;
    const short = newest
        ? `What we shipped, sprint by sprint. Latest: ${newest.title}.`
        : 'What we shipped, sprint by sprint.';
    return [
        `<meta name="description" content="${esc(desc)}">`,
        `<meta property="og:description" content="${esc(short)}">`,
        `<meta name="twitter:description" content="${esc(short)}">`,
    ].join('\n');
}

export function pageRegions() {
    const now = bakeNowMs();
    return {
        HEAD: headHtml(),
        STATS: statsHtml(),
        SPOTLIGHT: spotlightHtml(now),
        TIMELINE: timelineHtml({}, now),
    };
}

/** Replace every RD:<NAME> sentinel region of `html` with `regions[NAME]`. */
export function applyRegions(html, regions) {
    let out = html;
    for (const name of REGIONS) {
        const begin = `<!-- RD:${name}:BEGIN -->`;
        const end = `<!-- RD:${name}:END -->`;
        const a = out.indexOf(begin);
        const b = out.indexOf(end);
        if (a < 0 || b < a) throw new Error(`recent-development.html is missing the ${begin} … ${end} sentinels`);
        out = out.slice(0, a + begin.length) + '\n' + regions[name] + '\n' + out.slice(b);
    }
    return out;
}

// ── RSS ─────────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' → RFC 822 date at 00:00 GMT (RSS 2.0 requires RFC 822). */
export function rfc822(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    const p2 = n => String(n).padStart(2, '0');
    return `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} 00:00:00 GMT`;
}

function absolute(href) { return `${ORIGIN}/${href.replace(/^\//, '')}`; }

const KIND_LABEL = Object.fromEntries(KINDS.map(k => [k.id, k.label]));
const SECTION_LABEL = Object.fromEntries(LOG_SECTIONS.map(s => [s.id, s.label]));

/** The item body, as HTML (escaped once more into the XML text node). */
function itemDescription(entry) {
    const parts = [`<p>${esc(entry.summary)}</p>`];
    if (entry.highlights && entry.highlights.length) {
        parts.push(`<ul>${entry.highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul>`);
    }
    parts.push(`<p>${entry.links.map(l =>
        `<a href="${esc(absolute(l.href))}">Open ${esc(linkLabel(l) || l.href)}</a>`).join(' · ')}</p>`);
    return parts.join('');
}

export function feedXml() {
    const items = latest(FEED_LIMIT);
    const newest = items[0];
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!--',
        '  GENERATED by scripts/build-recent-development.mjs from js/dev-log.js — do not hand-edit.',
        '  The Recent Development build log as RSS 2.0. rss.xml is the separate Field Notes feed.',
        '-->',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        '  <channel>',
        '    <title>Parkers Physics — Recent Development</title>',
        `    <link>${PAGE_URL}</link>`,
        `    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>`,
        '    <description>New simulations, data sets, layers and fixes on Parkers Physics, as they ship — each with a link to open it.</description>',
        '    <language>en-us</language>',
        '    <copyright>Telford Projects LLC</copyright>',
        newest ? `    <lastBuildDate>${rfc822(newest.date)}</lastBuildDate>` : null,
        '    <image>',
        `      <url>${ORIGIN}/ParkersPhysics_logo2.jpg</url>`,
        '      <title>Parkers Physics — Recent Development</title>',
        `      <link>${PAGE_URL}</link>`,
        '    </image>',
    ].filter(l => l !== null);
    for (const e of items) {
        lines.push(
            '',
            '    <item>',
            `      <title>${esc(e.title)}</title>`,
            `      <link>${PAGE_URL}#${esc(e.id)}</link>`,
            `      <guid isPermaLink="true">${PAGE_URL}#${esc(e.id)}</guid>`,
            `      <pubDate>${rfc822(e.date)}</pubDate>`,
            `      <category>${esc(KIND_LABEL[e.kind] || e.kind)}</category>`,
            `      <category>${esc(SECTION_LABEL[e.section] || e.section)}</category>`,
            `      <description>${esc(itemDescription(e))}</description>`,
            '    </item>',
        );
    }
    lines.push('', '  </channel>', '</rss>', '');
    return lines.join('\n');
}

/** Both outputs, as the files should read. */
export function buildOutputs() {
    return {
        page: applyRegions(readFileSync(PAGE, 'utf8'), pageRegions()),
        feed: feedXml(),
    };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const check = process.argv.includes('--check');
    const out = buildOutputs();
    const stale = [];
    if (readFileSync(PAGE, 'utf8') !== out.page) stale.push('recent-development.html');
    if (!existsSync(FEED) || readFileSync(FEED, 'utf8') !== out.feed) stale.push('recent-development.xml');
    if (check) {
        if (stale.length) {
            console.error(`❌ out of date with js/dev-log.js: ${stale.join(', ')}\n`
                + '   Run: node scripts/build-recent-development.mjs');
            process.exit(1);
        }
        console.log(`✅ recent-development.html + recent-development.xml in sync (${DEV_LOG.length} entries).`);
    } else {
        writeFileSync(PAGE, out.page);
        writeFileSync(FEED, out.feed);
        console.log(stale.length
            ? `✅ wrote ${stale.join(' + ')} (${DEV_LOG.length} entries, feed carries ${Math.min(FEED_LIMIT, DEV_LOG.length)}).`
            : `recent-development.html + recent-development.xml already up to date (${DEV_LOG.length} entries).`);
    }
}
