/**
 * site-anchors.mjs — every `page.html#fragment` link must land on something.
 * ═══════════════════════════════════════════════════════════════════════════
 * A fragment that names no element fails SILENTLY: the browser opens the page
 * at the top and nothing errors. That is how the alert email's "Manage alert
 * preferences" link, the daily digest's "Manage digest preferences" link and
 * both EarthView "saved location" links all pointed at
 * `dashboard.html#saved-locations-card` for months after that card moved to
 * settings.html — and how `pricing.html#advanced` missed `#card-advanced`.
 *
 * Scans every .html / .js / .mjs outside node_modules, tests and build output
 * for `<page>.html#<frag>` and requires that `<page>.html` exists and either
 *   · has an element with id="<frag>", or
 *   · routes tabs from the hash (`openTabFromHash`, admin.html) and has a
 *     `data-tab="<frag>"` tab.
 * JSON-LD `"@id"` values are identifiers, not links, and are skipped.
 *
 * Then renders the two user-facing email templates and checks their links
 * directly, so a template that builds its href at runtime is covered too.
 *
 * Run: node tests/site-anchors.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'target', 'test-results', 'playwright-report', 'pkg']);

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(html|m?js)$/.test(e.name)) out.push(p);
    }
    return out;
}

const pageCache = new Map();
function page(name) {
    if (!pageCache.has(name)) {
        const p = path.join(ROOT, name);
        pageCache.set(name, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
    }
    return pageCache.get(name);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does `#frag` resolve on `name`? */
export function fragmentResolves(name, frag) {
    const html = page(name);
    if (html == null) return false;
    if (new RegExp(`\\bid=["']${escRe(frag)}["']`).test(html)) return true;
    return /openTabFromHash/.test(html) && new RegExp(`data-tab=["']${escRe(frag)}["']`).test(html);
}

// ── 1. Static scan ──────────────────────────────────────────────────────────
const LINK = /(?:https?:\/\/[a-z0-9.-]+\/|\$\{[A-Z_]+\}\/|["'`(=\/])([a-z0-9-]+\.html)#([A-Za-z][\w-]*)/g;
let checked = 0;
for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (/"@id"\s*:/.test(line)) return;                 // JSON-LD identifier
        for (const m of line.matchAll(LINK)) {
            checked++;
            const [, target, frag] = m;
            if (page(target) == null) fail(`${rel}:${i + 1} links ${target}#${frag} — no such page`);
            else if (!fragmentResolves(target, frag)) fail(`${rel}:${i + 1} links ${target}#${frag} — no element or tab "${frag}" there`);
        }
    });
}
console.log(`  ✓ scanned ${checked} page#fragment links`);

// ── 2. Rendered email templates ─────────────────────────────────────────────
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
function checkRenderedLinks(label, html, mustInclude) {
    const all = hrefs(html);
    for (const want of mustInclude) {
        if (!all.some((h) => h.endsWith(want))) fail(`${label}: expected a link to ${want}, got ${JSON.stringify(all)}`);
    }
    for (const h of all) {
        const m = h.match(/([a-z0-9-]+\.html)#([\w-]+)$/);
        if (m && !fragmentResolves(m[1], m[2])) fail(`${label}: link ${h} does not resolve`);
    }
}

const { buildEmailHtml } = await import('../api/alerts/email.js');
checkRenderedLinks('alert email', buildEmailHtml('Kp 7 storm', 'Aurora likely overhead.', 'warning', 'storm', 'Boulder, CO'),
    ['settings.html#alert-prefs']);

const { buildDigestHtml } = await import('../api/cron/daily-forecast-digest.js');
const day = (i) => ({ date: `2026-09-${24 + i}`, tmax: 24, tmin: 11, precipProb: 20, precipSum: 0, windMax: 18, weatherCode: 1, uvMax: 5 });
let digest;
try {
    digest = buildDigestHtml({ label: 'Home', city: 'Boulder, CO', forecast: { timezone: 'America/Denver', days: [0, 1, 2].map(day) }, plan: 'basic' });
} catch (e) {
    fail(`digest template threw on a minimal forecast: ${e.message}`);
}
if (digest) checkRenderedLinks('daily digest', digest, ['settings.html#saved-locations']);

if (failures) { console.error(`site-anchors: ${failures} FAILED`); process.exit(1); }
console.log('site-anchors: ALL PASS');
