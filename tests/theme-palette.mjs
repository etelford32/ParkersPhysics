/**
 * tests/theme-palette.mjs — WCAG contrast gate for the light (white + blue)
 * palette in js/theme-light.css.
 *
 *   node tests/theme-palette.mjs
 *
 * Reads the --pl-* tokens straight out of the stylesheet (so the numbers
 * checked are the numbers shipped) and computes WCAG 2.x contrast for every
 * pair the header promises. A palette tweak that makes body copy grey-on-
 * white or the link blue too pale fails here, not in a screenshot review.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'js/theme-light.css'), 'utf8');

const tok = {};
for (const m of css.matchAll(/--(pl-[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) tok[m[1]] = m[2];

function lum(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

const need = [
    // [foreground, background, minimum, why]
    ['pl-text-1', 'pl-bg', 7, 'headings on the page'],
    ['pl-text-2', 'pl-bg', 7, 'body on the page'],
    ['pl-text-2', 'pl-bg-soft', 7, 'body on soft panels'],
    ['pl-text-3', 'pl-bg', 4.5, 'secondary body'],
    ['pl-text-3', 'pl-bg-sunk', 4.5, 'secondary body in wells'],
    ['pl-text-4', 'pl-bg', 4.5, 'captions on the page'],
    ['pl-text-4', 'pl-bg-soft', 4.5, 'captions on soft panels'],
    ['pl-text-5', 'pl-bg', 3, 'meta / large text only'],
    ['pl-blue', 'pl-bg', 4.5, 'links on the page'],
    ['pl-blue', 'pl-bg-soft', 4.5, 'links on soft panels'],
    ['pl-blue', 'pl-blue-soft', 4.5, 'blue text on a blue chip'],
    ['pl-blue-deep', 'pl-blue-soft', 7, 'hover / small bold on a chip'],
    ['pl-sky', 'pl-bg', 4.5, 'second accent as text'],
    ['pl-ok', 'pl-bg', 4.5, 'status ok'],
    ['pl-warn', 'pl-bg', 4.5, 'status warn'],
    ['pl-danger', 'pl-bg', 4.5, 'status danger'],
    ['pl-border-strong', 'pl-bg', 3, 'input outlines (WCAG 1.4.11 non-text 3:1)'],
];

let n = 0;
for (const [fg, bg, min, why] of need) {
    assert.ok(tok[fg] && tok[bg], `missing token --${tok[fg] ? bg : fg}`);
    const c = contrast(tok[fg], tok[bg]);
    assert.ok(c >= min, `${why}: --${fg} ${tok[fg]} on --${bg} ${tok[bg]} is ${c.toFixed(2)}:1 < ${min}:1`);
    n++;
}
// White text on the button fill (and its hover).
for (const k of ['pl-btn', 'pl-btn-hover', 'pl-blue']) {
    const c = contrast('#ffffff', tok[k]);
    assert.ok(c >= 4.5, `white on --${k} ${tok[k]} is ${c.toFixed(2)}:1 < 4.5:1`);
    n++;
}
// Every stop of the button gradient carries white text too.
for (const stop of (css.match(/--pl-grad-btn:[^;]+;/)?.[0].match(/#[0-9a-f]{6}/gi) ?? [])) {
    assert.ok(contrast('#ffffff', stop) >= 4.5, `white on button-gradient stop ${stop}`);
    n++;
}
// "White and blue": the accent really is blue (hue 200–225°), not the old UV.
for (const k of ['pl-blue', 'pl-blue-deep', 'pl-blue-bright', 'pl-btn']) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(tok[k].slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = (mx === b ? 4 + (r - g) / d : mx === g ? 2 + (b - r) / d : ((g - b) / d) % 6) * 60;
    assert.ok(h >= 200 && h <= 225, `--${k} hue ${h.toFixed(0)}° is not blue`);
    n++;
}
console.log(`theme-palette: ${n} contrast/hue checks passed`);
