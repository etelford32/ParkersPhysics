#!/usr/bin/env node
/**
 * capture-home-showcase.mjs — record the homepage Simulation Showcase media
 * ═══════════════════════════════════════════════════════════════════════════
 * For every entry in js/home-showcase-slides.js SHOWCASE_SLIDES: open the
 * real page, hide its chrome, let the scene settle, shoot a poster (JPEG)
 * and record a short muted loop (WebM), crop both to the sim's canvas, and
 * write assets/home/showcase/manifest.json — the join table
 * js/home-showcase.js reads at runtime.
 *
 *   node scripts/capture-home-showcase.mjs                # every slide, against
 *                                                         # a dev server it starts
 *   node scripts/capture-home-showcase.mjs --only mars,moon
 *   node scripts/capture-home-showcase.mjs --base http://localhost:3000
 *   node scripts/capture-home-showcase.mjs --gpu           # real GPU (see below)
 *   node scripts/capture-home-showcase.mjs --no-clip       # posters only
 *
 * WHERE TO RUN IT
 * ───────────────
 * Anywhere Playwright's Chromium runs, but the output quality follows the
 * rasteriser. CI / cloud sessions have no GPU: Chromium falls back to
 * SwiftShader, the sims run at a few fps, bloom and volumetrics never arm,
 * and the loops look like time-lapse. That is why the manifest records
 * `renderer` per slide — re-run on a machine with a GPU (`--gpu` drops the
 * software-GL flags) and the captured date + renderer update honestly. The
 * runtime never cares which; it only reads poster/clip/capturedAt.
 *
 * FFMPEG
 * ──────
 * Uses Playwright's bundled ffmpeg by default (VP8 only). Set FFMPEG=/path
 * to a full build to get VP9 (`-c:v libvpx-vp9`, ~40% smaller at the same
 * quality); the script probes the encoder and picks the best available.
 *
 * MEDIA BUDGET
 * ────────────
 * Posters 1920×1200 JPEG q80 (~150–350 kB), clips 1280-wide VP8 ~900 kbps ×
 * 6–7 s (~700–800 kB). Posters load lazily and a clip is fetched only while
 * its card is hovered, so the page cost is a few posters, not the whole set.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SHOWCASE_SLIDES: CAPTURED_SLIDES, MEDIA_DIR } = await import(pathToFileURL(path.join(ROOT, 'js/home-showcase-slides.js')).href);

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt  = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY   = opt('--only', '').split(',').map(s => s.trim()).filter(Boolean);
const GPU    = flag('--gpu');
// --preview <dir>: posters only, written to <dir>, manifest untouched — the
// loop for composing a shot (edit the recipe's `shots`, look, repeat).
const PREVIEW = opt('--preview', '');
// --moon-map <file>: moon.html loads its albedo map from Wikimedia. Where that
// host is unreachable the Moon is a grey fallback sphere; this serves a REAL
// lunar albedo mosaic from disk in its place (same equirectangular layout,
// 0° longitude at the centre). The HEIGHT map is never substituted — a
// look-alike bump image is not LOLA, and the page draws a smooth sphere
// rather than relief it cannot vouch for.
const MOON_MAP = opt('--moon-map', '');
// --replay <dir>: answer same-origin /api/* requests from RECORDED production
// responses — a file named after the path with '/' → '__' and '.json'
// (/api/cme/skill → api__cme__skill.json). For routes the capture machine
// cannot serve itself (the skill ledger needs the production database). Only
// real, unedited response bodies belong in that directory; a route with no
// file falls through to the dev server untouched.
const REPLAY = opt('--replay', '');
const NOCLIP = flag('--no-clip') || !!PREVIEW;
const PORT   = Number(opt('--port', '8765'));
let   BASE   = opt('--base', '');
// 16:10 at 1920 — the card's aspect (js/home-showcase.js .hs-media) so a
// poster is never cropped twice; wide enough for a 2× card at 640 px.
const VIEW   = { width: 1920, height: 1200 };
const CLIP_W = 1280;

// ── ffmpeg ─────────────────────────────────────────────────────────────────
function findFfmpeg() {
    if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
    try {
        const require = createRequire(import.meta.url);
        const reg = require('playwright-core/lib/server/registry/index.js');
        const exe = reg.registry?.findExecutable?.('ffmpeg')?.executablePath?.();
        if (exe && existsSync(exe)) return exe;
    } catch {}
    const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
    try {
        const { readdirSync } = await_import_fs();
        for (const d of readdirSync(base)) {
            if (!d.startsWith('ffmpeg')) continue;
            for (const f of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe', 'ffmpeg-mac-arm64']) {
                const p = path.join(base, d, f);
                if (existsSync(p)) return p;
            }
        }
    } catch {}
    return null;
}
function await_import_fs() { return createRequire(import.meta.url)('node:fs'); }

function pickEncoder(ffmpeg) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    if (/libvpx-vp9/.test(out)) return { codec: 'libvpx-vp9', args: ['-b:v', '700k', '-crf', '34', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2'] };
    if (/\blibvpx\b/.test(out))  return { codec: 'libvpx',     args: ['-b:v', '900k', '-crf', '12', '-qmin', '4', '-qmax', '48', '-auto-alt-ref', '0', '-deadline', 'good', '-cpu-used', '1'] };
    return null;
}

// ── dev server (only when --base is not given) ─────────────────────────────
let server = null;
async function ensureServer() {
    if (BASE) return;
    BASE = `http://localhost:${PORT}`;
    server = spawn(process.execPath, ['dev-server.mjs'], {
        cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
        try { const r = await fetch(BASE + '/index.html', { method: 'HEAD' }); if (r.ok) return; } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('dev server did not come up on ' + BASE);
}

const EARTH_LOCAL = { 'earth-blue-marble.jpg': 'day-4k.webp', 'earth-night.jpg': 'lights-2k.webp', 'earth-water.png': 'water-2k.webp', 'earth-topology.png': 'relief-2k.webp' };

// ── capture one slide ──────────────────────────────────────────────────────
async function captureSlide(browser, slide, ffmpeg, enc, outDir, tmpDir) {
    const c = slide.capture;
    const ctx = await browser.newContext({
        viewport: VIEW,
        // A recipe may ask for a denser buffer (`scale: 2`) when its crop is a
        // short 2D canvas that would otherwise be upsampled into the 1280 thumbnail.
        deviceScaleFactor: c.scale || 1,
        recordVideo: NOCLIP ? undefined : { dir: tmpDir, size: VIEW },
        reducedMotion: 'no-preference',
        colorScheme: 'dark',
    });
    const tCtx = Date.now();
    const page = await ctx.newPage();
    page.on('pageerror', e => console.warn(`   [${slide.id}] page error: ${e.message.slice(0, 120)}`));
    await page.addInitScript(() => {
        // js/cookie-consent.js STORAGE_KEY / BANNER_VERSION — a stored decision
        // keeps the banner out of every shot.
        try { localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: false, analytics: false, ts: Date.now(), version: 1 })); } catch {}
        window.addEventListener('message', (e) => { if (e.data?.type === 'preview-ready') window.__previewReady = true; });
    });
    // A recipe's `storage` is localStorage the page reads at boot (e.g. the
    // current-view location, `ppx_user_location`) — set before any page script.
    if (c.storage) await page.addInitScript((kv) => {
        for (const [k, v] of Object.entries(kv)) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch {} }
    }, c.storage);
    // EarthView (and every page sharing js/earth-skin.js) loads its NASA
    // surface maps from unpkg. Where that CDN is unreachable the globe renders
    // BLACK — so the CDN is probed ONCE per run (CDN_OK) and, when it is down,
    // the maps are served from the repo's own copies
    // of the same images (assets/earth, see its SOURCES.md; the test fixtures
    // do the same). The night map falls back to the lights-only extract, so an
    // offline capture's night side is darker than production's.
    if (REPLAY) await page.route('**/api/**', async (route) => {
        const u = new URL(route.request().url());
        const file = path.join(REPLAY, u.pathname.replace(/^\//, '').replace(/\//g, '__') + '.json');
        if (u.origin !== new URL(BASE).origin || !existsSync(file)) return route.fallback();
        return route.fulfill({ status: 200, contentType: 'application/json', body: await readFile(file) });
    });
    if (MOON_MAP && !WIKI_OK) await page.route('https://upload.wikimedia.org/**', async (route) => {
        if (!/Moon_texture_nasa_lro_lola/.test(route.request().url())) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: await readFile(MOON_MAP) });
    });
    if (!CDN_OK) await page.route('https://unpkg.com/three-globe@*/example/img/*', async (route) => {
        const local = EARTH_LOCAL[route.request().url().split('/').pop().split('?')[0]];
        if (!local) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: await readFile(path.join(ROOT, 'assets/earth', local)) });
    });
    // `waitUntil` per recipe: EarthView's `load` can outlast 90 s on a software
    // rasteriser (its ready condition below is the real gate).
    await page.goto(BASE + c.url, { waitUntil: c.waitUntil || 'load', timeout: 120_000 });
    const hide = ['nav', '.pp-consent-banner', '.skip-link', ...(c.hide || [])];
    await page.addStyleTag({ content: `${hide.join(',')}{display:none!important;visibility:hidden!important}` +
        `html,body{overflow:hidden!important}*{cursor:none!important}` });
    try {
        await page.waitForFunction(new Function('return (' + c.ready + ')'), null, { timeout: 60_000 });
    } catch {
        console.warn(`   [${slide.id}] ready condition timed out — capturing whatever rendered`);
    }
    // Generic chrome stripper: every fixed/absolute/sticky element that is
    // not a canvas, does not contain one, and is not an ancestor of the crop
    // target is page UI (panels, tickers, tips, scrubbers) — hide it. The
    // per-slide `hide` list still handles in-flow chrome.
    if (c.stripOverlays !== false) {
        await page.evaluate((cropSel) => {
            const crop = document.querySelector(cropSel);
            let n = 0;
            for (const el of document.body.querySelectorAll('*')) {
                if (el.tagName === 'CANVAS' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
                if (crop && (el === crop || el.contains(crop))) continue;
                const pos = getComputedStyle(el).position;
                if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
                if (el.querySelector('canvas')) continue;
                el.style.setProperty('display', 'none', 'important');
                n++;
            }
            return n;
        }, c.crop).then(n => { if (n) console.log(`   stripped ${n} overlay element(s)`); });
    }
    if (c.prep) {
        try { await page.evaluate(new Function(c.prep)); }
        catch (err) { console.warn(`   [${slide.id}] prep failed: ${err.message.slice(0, 120)}`); }
    }
    // COMPOSE THE SHOT (2026-11-22). `shots` is a list of real input gestures
    // on the crop element — the page's own camera controls, driven the way a
    // visitor would: no page-specific hooks, so a recipe survives a refactor.
    // Coordinates are fractions of the crop box.
    //   { wheel: dy, at: [fx, fy], n: 1 }        zoom (dy < 0 = in), n pushes
    //   { drag: [fx0, fy0, fx1, fy1], button }   orbit ('left') / pan ('right')
    //   { dblclick: [fx, fy] } · { click: [fx, fy] } · { key: 'Escape' }
    //   { eval: 'js' } · { wait: ms }
    if (Array.isArray(c.shots) && c.shots.length) {
        let b = null;
        try { b = await page.locator(c.crop).first().boundingBox(); } catch {}
        if (!b) b = { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
        const pt = (fx, fy) => [b.x + b.width * fx, b.y + b.height * fy];
        for (const sh of c.shots) {
            try {
                if (sh.wheel != null) {
                    const [x, y] = pt(...(sh.at || [0.5, 0.5]));
                    await page.mouse.move(x, y);
                    for (let i = 0; i < (sh.n || 1); i++) { await page.mouse.wheel(0, sh.wheel); await page.waitForTimeout(sh.gap ?? 260); }
                } else if (sh.drag) {
                    const [x0, y0] = pt(sh.drag[0], sh.drag[1]), [x1, y1] = pt(sh.drag[2], sh.drag[3]);
                    await page.mouse.move(x0, y0);
                    await page.mouse.down({ button: sh.button || 'left' });
                    for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8); await page.waitForTimeout(60); }
                    await page.mouse.up({ button: sh.button || 'left' });
                } else if (sh.dblclick) { await page.mouse.dblclick(...pt(...sh.dblclick)); }
                else if (sh.click) { await page.mouse.click(...pt(...sh.click)); }
                else if (sh.key) { await page.keyboard.press(sh.key); }
                else if (sh.eval) { await page.evaluate(new Function(sh.eval)); }
                if (sh.wait) await page.waitForTimeout(sh.wait);
            } catch (err) { console.warn(`   [${slide.id}] shot step failed: ${err.message.split('\n')[0].slice(0, 120)}`); }
        }
    }
    // Park the pointer off the scene: a cursor left where the last gesture
    // ended leaves a hover tooltip in the shot.
    if (Array.isArray(c.shots) && c.shots.length) await page.mouse.move(2, 2).catch(() => {});
    await page.waitForTimeout(c.settleMs ?? 8000);

    // Crop box: the sim's own element, else the viewport. Even-sized, clamped.
    let box = null;
    try { box = await page.locator(c.crop).first().boundingBox(); } catch {}
    if (!box || box.width < 200 || box.height < 120) box = { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
    // `cropHeightOf`: end the frame at the bottom of another element (a two-
    // column layout whose shorter column would otherwise leave dead space).
    if (c.cropHeightOf) {
        try {
            const b2 = await page.locator(c.cropHeightOf).first().boundingBox();
            if (b2 && b2.y + b2.height > box.y + 120) box = { ...box, height: Math.min(box.height, b2.y + b2.height + 8 - box.y) };
        } catch {}
    }
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.min(VIEW.width  - x, Math.floor(box.width  / 2) * 2);
    const h = Math.min(VIEW.height - y, Math.floor(box.height / 2) * 2);

    const poster = `${slide.id}.jpg`;
    // A software rasteriser can take well over Playwright's 30 s default to
    // present a frame of a heavy page (upper-atmosphere.html timed out there).
    await page.screenshot({ path: path.join(outDir, poster), type: 'jpeg', quality: 80, clip: { x, y, width: w, height: h }, timeout: 150_000 });
    const tPoster = Date.now() - tCtx;

    let clip = null;
    if (!NOCLIP && enc) {
        await page.waitForTimeout(c.clipMs ?? 6000);
        const video = page.video();
        await ctx.close();                                  // flushes the recording
        const src = await video.path();
        clip = `${slide.id}.webm`;
        const out = path.join(outDir, clip);
        const scaleW = Math.min(CLIP_W, w);
        const args = ['-y', '-hide_banner', '-loglevel', 'error',
            '-ss', (tPoster / 1000).toFixed(2), '-t', ((c.clipMs ?? 6000) / 1000).toFixed(2), '-i', src,
            '-vf', `crop=${w}:${h}:${x}:${y},scale=${scaleW}:-2`,
            '-an', '-c:v', enc.codec, ...enc.args, '-pix_fmt', 'yuv420p', out];
        const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
        if (r.status !== 0) { console.warn(`   [${slide.id}] ffmpeg failed: ${r.stderr.slice(0, 300)}`); clip = null; }
        await rm(src, { force: true });
    } else {
        await ctx.close();
    }
    const sizes = { poster: (await stat(path.join(outDir, poster))).size, clip: clip ? (await stat(path.join(outDir, clip))).size : 0 };
    return {
        id: slide.id,
        poster: MEDIA_DIR + poster,
        clip: clip ? MEDIA_DIR + clip : null,
        width: w, height: h,
        source: c.url,
        capturedAt: new Date().toISOString(),
        renderer: GPU ? 'gpu' : 'swiftshader',
        bytes: sizes,
    };
}

// ── main ───────────────────────────────────────────────────────────────────
const outDir = PREVIEW ? path.resolve(PREVIEW) : path.join(ROOT, MEDIA_DIR);
await mkdir(outDir, { recursive: true });
const tmpDir = path.join(os.tmpdir(), 'pp-carousel-' + process.pid);
await mkdir(tmpDir, { recursive: true });

const ffmpeg = NOCLIP ? null : findFfmpeg();
const enc = ffmpeg ? pickEncoder(ffmpeg) : null;
if (!NOCLIP && !enc) console.warn('ffmpeg with libvpx not found — posters only (set FFMPEG=/path/to/ffmpeg)');
else if (enc) console.log(`ffmpeg: ${ffmpeg} (${enc.codec})`);

const manifestPath = path.join(outDir, 'manifest.json');
let manifest = { version: 1, generatedAt: null, slides: [] };
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}

await ensureServer();
// One probe decides for the whole run (per-request fallbacks stalled page load for minutes).
let CDN_OK = false;
try { const r = await fetch('https://unpkg.com/three-globe@2.31.0/example/img/earth-water.png', { method: 'HEAD', signal: AbortSignal.timeout(5000) }); CDN_OK = r.ok; } catch {}
if (!CDN_OK) console.log('unpkg unreachable — EarthView maps served from assets/earth');
let WIKI_OK = false;
if (MOON_MAP) {
    try { const r = await fetch('https://upload.wikimedia.org/wikipedia/commons/4/4f/Moon_bump.jpg', { method: 'HEAD', signal: AbortSignal.timeout(5000) }); WIKI_OK = r.ok; } catch {}
    if (!WIKI_OK) console.log(`Wikimedia unreachable — the Moon's albedo map served from ${MOON_MAP} (no relief)`);
}
const args = GPU ? ['--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: true, args });
// OWNER CAPTURES (2026-11-26): a manifest entry with `capturedBy: 'owner'` is
// a real-GPU screenshot the owner took of the live page (e.g. Inner Earth's
// live seismic view, which needs the USGS feed this machine cannot reach),
// cropped to its scene and never retouched. A software re-capture is worse
// by construction, so it is SKIPPED unless `--replace-owner` is passed.
const REPLACE_OWNER = flag('--replace-owner');
const ownerIds = new Set((manifest.slides || []).filter(e => e.capturedBy === 'owner').map(e => e.id));
const todo = CAPTURED_SLIDES.filter(s => (!ONLY.length || ONLY.includes(s.id))
    && (REPLACE_OWNER || !ownerIds.has(s.id) || (console.log(`· ${s.id}: owner GPU capture kept (--replace-owner to re-shoot)`), false)));
const results = [];
try {
    for (const slide of todo) {
        console.log(`▶ ${slide.id}  ${slide.capture.url}`);
        try {
            const entry = await captureSlide(browser, slide, ffmpeg, enc, outDir, tmpDir);
            results.push(entry);
            console.log(`   ✓ ${entry.width}×${entry.height}  poster ${(entry.bytes.poster / 1024).toFixed(0)} kB` +
                        (entry.clip ? `  clip ${(entry.bytes.clip / 1024).toFixed(0)} kB` : '  (no clip)'));
        } catch (err) {
            console.warn(`   ✗ ${slide.id}: ${err.message.split('\n')[0]}`);
        } finally {
            // A slide that threw (screenshot timeout on a software rasteriser)
            // used to leave its context — and its WebGL page — running behind
            // every later capture; measured: two leaked renderers at 16 min.
            for (const c of browser.contexts()) await c.close().catch(() => {});
        }
    }
} finally {
    await browser.close();
    server?.kill();
    await rm(tmpDir, { recursive: true, force: true });
}

// Merge: re-captured ids replace, untouched ids stay, order follows the registry.
const byId = new Map((manifest.slides || []).map(s => [s.id, s]));
for (const r of results) byId.set(r.id, r);
manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    slides: CAPTURED_SLIDES.map(s => byId.get(s.id)).filter(Boolean),
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${manifest.slides.length} slide(s) → ${path.relative(ROOT, manifestPath)}`);
if (!results.length) process.exitCode = 1;
