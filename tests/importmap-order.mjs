#!/usr/bin/env node
/**
 * Import-map ordering gate — every top-level page.
 *
 * A page's import map is only honoured if it is parsed BEFORE the first module
 * load. A `<link rel="modulepreload">` counts as a module load, and so does a
 * `<script type="module">`. Firefox then ignores any later import map, so a
 * bare `import … from 'three'` fails with "The specifier 'three' was a bare
 * specifier, but was not remapped to anything" and the module never runs.
 * Chromium merges late import maps, so a Chromium-only test suite never sees
 * it: mars.html shipped a modulepreload above its import map on 2026-08-06
 * and its 3D engine never started in Firefox until 2026-09-27 (the error was
 * sitting in client_telemetry the whole time).
 *
 * Comments are stripped first — dashboard.html's own warning about this trap
 * quotes `<script type="module">` inside a comment.
 *
 * Usage:  node tests/importmap-order.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>/i;
const MODULE_LOADS = [
    { what: '<link rel="modulepreload">', re: /<link\b[^>]*\brel\s*=\s*["']?modulepreload["']?[^>]*>/i },
    { what: '<script type="module">', re: /<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>/i },
];

let failures = 0;
let checked = 0;
for (const file of readdirSync(ROOT).filter(name => name.endsWith('.html')).sort()) {
    const html = readFileSync(join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const map = IMPORT_MAP.exec(html);
    if (!map) continue;
    checked += 1;
    for (const { what, re } of MODULE_LOADS) {
        const load = re.exec(html);
        if (load && load.index < map.index) {
            const line = html.slice(0, load.index).split('\n').length;
            console.error(`✗ ${file}: ${what} (comment-stripped line ${line}) comes before the import map — Firefox will ignore the map`);
            failures += 1;
        }
    }
}

if (failures) {
    console.error(`\n${failures} page(s) load a module before their import map.`);
    process.exit(1);
}
console.log(`✓ import map precedes every module load on all ${checked} pages that declare one`);
