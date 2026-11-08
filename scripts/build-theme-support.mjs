#!/usr/bin/env node
/**
 * build-theme-support.mjs — which pages can go LIGHT, and their <head> wiring.
 *
 *   node scripts/build-theme-support.mjs           # write the wiring
 *   node scripts/build-theme-support.mjs --check   # exit 1 on drift (tests/theme-schedule.mjs runs this)
 *
 * The light theme (white + blue, auto by daylight — js/theme-schedule.js) is
 * OPT-IN PER PAGE. A page in LIGHT_PAGES gets:
 *   - `data-theme-support="light"` on its <html> tag, and
 *   - THEME_HEAD just before </head>: js/theme-light.css (after the page's
 *     own styles, so it wins ties) and js/theme-boot.js, a CLASSIC script
 *     that puts `theme-light` on <html> before the body paints.
 * Every other page is untouched and stays dark. That is deliberate, not a
 * backlog: the immersive simulations draw space, and space is black — a
 * white page around a WebGL sky reads as a broken page. The list is the
 * reading pages (hubs, catalogue, blog, legal, account, marketing).
 *
 * TO ADD A PAGE: put it in LIGHT_PAGES, run this script, then look at it in
 * light mode (`?theme=light`) and fix what the shared sheet cannot know about
 * — hard-coded rgba() cards, gradient headings — as `html.theme-light …`
 * rules in the page's OWN <style>. js/theme-light.css holds only the palette,
 * the token remaps and the element base.
 *
 * The section hubs are generated whole-file by scripts/build-section-pages.mjs,
 * which imports THEME_HEAD from here so the two can never disagree.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LIGHT_PAGES = Object.freeze([
    // Catalogue + section hubs (js/catalog-styles.css)
    'simulations.html',
    'space-weather-hub.html', 'earth-orbit.html', 'local-space.html', 'deep-space.html', 'research.html',
    // Home (the live hero canvas stays dark — it is a sky; the page around it goes light)
    'index.html',
    // Blog + legal
    'blog.html', 'blog-gannon-hindcast.html', 'blog-stpatrick-hindcast.html', 'blog-why-aurora-forecasts-miss.html',
    'privacy.html', 'eula.html', 'dpa.html', 'api-policy.html',
    // Sign-in / onboarding
    'signin.html', 'signup.html', 'reset-password.html', 'welcome.html', 'request-access.html', '404.html',
    // Account
    'account.html', 'settings.html', 'feedback.html', 'status.html',
    // Marketing
    'pricing.html', 'for-operators.html', 'for-educators.html', 'contact-enterprise.html',
    // EarthView: its chrome has carried a full light theme since before this
    // existed (js/design-tokens.css + earth.html's rule overrides) — it takes
    // the boot script only, never js/theme-light.css (see OWN_LIGHT_THEME).
    'earth.html',
]);

/** Pages with their OWN complete light theme: wired for the class (boot
 *  script + attribute) but NOT given js/theme-light.css, whose element base
 *  (white body, forms, links) would repaint chrome they already theme. */
export const OWN_LIGHT_THEME = Object.freeze(['earth.html']);

/** Section hubs written by build-section-pages.mjs (it emits THEME_HEAD itself). */
export const GENERATED_PAGES = Object.freeze([
    'space-weather-hub.html', 'earth-orbit.html', 'local-space.html', 'deep-space.html', 'research.html',
]);

const START = '<!-- theme-support:start — scripts/build-theme-support.mjs -->';
const END = '<!-- theme-support:end -->';

export const THEME_HEAD = [
    START,
    '<link rel="stylesheet" href="/js/theme-light.css">',
    '<script src="/js/theme-boot.js"></script>',
    END,
].join('\n');

export const THEME_HEAD_BOOT_ONLY = [
    START,
    '<script src="/js/theme-boot.js"></script>',
    END,
].join('\n');

export const HTML_ATTR = 'data-theme-support="light"';

const BLOCK_RE = /<!-- theme-support:start[\s\S]*?<!-- theme-support:end -->\n?/;
const HTML_TAG_RE = /<html\b[^>]*>/i;

/** Pure: the page's text with (or without) the wiring. */
export function wirePage(text, enable, { bootOnly = false } = {}) {
    let out = text.replace(BLOCK_RE, '');
    out = out.replace(HTML_TAG_RE, (tag) => tag.replace(/\s+data-theme-support="[^"]*"/i, ''));
    if (!enable) return out;
    if (!/<\/head>/i.test(out)) throw new Error('no </head>');
    out = out.replace(/<\/head>/i, `${bootOnly ? THEME_HEAD_BOOT_ONLY : THEME_HEAD}\n</head>`);
    out = out.replace(HTML_TAG_RE, (tag) => tag.replace(/^<html\b/i, `<html ${HTML_ATTR}`));
    return out;
}

function main() {
    const check = process.argv.includes('--check');
    const all = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
    const wanted = new Set(LIGHT_PAGES);
    const problems = [];
    let written = 0;

    for (const page of LIGHT_PAGES) {
        if (!existsSync(join(ROOT, page))) problems.push(`${page}: listed in LIGHT_PAGES but does not exist`);
    }
    for (const page of all) {
        const path = join(ROOT, page);
        const text = readFileSync(path, 'utf8');
        const enable = wanted.has(page);
        // Pages without the wiring and not wanted: leave them byte-identical.
        if (!enable && !BLOCK_RE.test(text) && !/data-theme-support=/i.test(text.match(HTML_TAG_RE)?.[0] ?? '')) continue;
        let next;
        try { next = wirePage(text, enable, { bootOnly: OWN_LIGHT_THEME.includes(page) }); } catch (e) { problems.push(`${page}: ${e.message}`); continue; }
        if (next === text) continue;
        if (check || GENERATED_PAGES.includes(page)) {
            problems.push(`${page}: ${enable ? 'missing / stale theme wiring' : 'carries theme wiring but is not in LIGHT_PAGES'}`
                + (GENERATED_PAGES.includes(page) ? ' (generated — run scripts/build-section-pages.mjs)' : ''));
            continue;
        }
        writeFileSync(path, next);
        written++;
    }
    if (problems.length) {
        console.error(`❌ theme support drift${check ? '' : ' (fix and re-run)'}:`);
        for (const p of problems) console.error(`   - ${p}`);
        process.exit(1);
    }
    console.log(check
        ? `✅ ${LIGHT_PAGES.length} light-capable page(s) wired; every other page untouched.`
        : `✅ wrote ${written} page(s); ${LIGHT_PAGES.length} light-capable.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
