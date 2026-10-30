import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { encodePng, decodePng } from './helpers/cloud-source.mjs';
import { regionById, regionView } from '../js/earth-regions.js';

/**
 * earth-regional-lod.spec.js — EarthView zoomed in to a region, in PIXELS.
 *
 * `node tests/cloud-regional.mjs` + `node tests/earth-regions.mjs` pin the
 * pure halves. This gate reads the page, and every check carries a NEGATIVE
 * CONTROL that puts the old behaviour back and must fail it:
 *
 *   1. REGIONS. "Go to a region" lands the camera where js/earth-regions.js
 *      says, the footprint is in regional detail and the readout says so,
 *      and the point under the screen centre is the region — through the
 *      page's analytic globe pick. Control: the mesh's own UVs (what every
 *      pick read until 2026-10-30) name the ANTIPODE.
 *   2. THE REGIONAL CLOUD WINDOW. A geographic GIBS stub draws 0.15°-period
 *      longitude stripes north of 40° N and a uniform grey south of it —
 *      finer than the 20 km global frame can resolve. Over the dateline at
 *      40° N (a window fetched as TWO BBOXes) the north half of the screen
 *      must show the stripes and the south half must not: finer than the
 *      global frame, the right way up, and stitched. The window must have
 *      been fetched at the global frame's OWN times. Control: ?cloud_detail=0.
 *   3. THE ANTIMERIDIAN SEAM. Base map only, the 180° meridian straight down
 *      the screen centre: no column stands out of its neighbours in the high-
 *      latitude band where the coarsest mip is reachable (see the test). Control:
 *      ?uvseam=legacy, which drops the seam-safe UV and brings the coarsest-
 *      mip line back.
 *
 * Hermetic: the three-globe maps are served from assets/earth (the SAME
 * images, resized); GIBS snapshots by the stub; everything else external is
 * aborted. The Sun is held just off the camera's own direction
 * (window.__evSetSunDir), so every measured view is sunlit (the surface is
 * physically lit — night is black — and the frozen globe rotation means
 * scrubbing the clock cannot bring daylight to a chosen meridian).
 * Run with --workers=1 on the sandbox (parallel SwiftShader workers kill
 * the browser session — EARTHVIEW_VISUAL_DIALIN_PLAN.md §2).
 */

test.describe.configure({ timeout: 600_000 });

const MAPS = {
    'earth-blue-marble.jpg': 'assets/earth/day-2k.webp',
    'earth-night.jpg':       'assets/earth/lights-2k.webp',
    'earth-water.png':       'assets/earth/water-2k.webp',
    'earth-topology.png':    'assets/earth/relief-2k.webp',
};
const QUIET = ['lyr-obs-sst', 'lyr-isobars', 'lyr-wind', 'lyr-cities', 'lyr-atm', 'lyr-obs-precip',
               'lyr-obs-fires', 'lyr-obs-snow', 'lyr-rotate', 'lyr-weather', 'lyr-grid', 'lyr-tropic', 'lyr-lights'];
const STRIPE_DEG = 0.15;   // 12.7 km at 40° N: under the global frame's Nyquist, over the window's
const NORTH_OF = 40;

async function boot(page, query, { clouds = true, gibs = [] } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' && /WebGLProgram|Shader Error|ERROR: \d+:\d+/.test(m.text())) errors.push(m.text().slice(0, 400));
    });
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
        const url = route.request().url();
        const map = url.match(/three-globe@[^/]+\/example\/img\/([^?]+)/)?.[1];
        if (map && MAPS[map]) {
            return route.fulfill({ status: 200, contentType: 'image/webp', body: readFileSync(new URL(`../${MAPS[map]}`, import.meta.url)) });
        }
        if (/wvs\.earthdata\.nasa\.gov\/api\/v1\/snapshot/.test(url)) {
            const u = new URL(url);
            const layer = u.searchParams.get('LAYERS') ?? '';
            const W = Number(u.searchParams.get('WIDTH')), H = Number(u.searchParams.get('HEIGHT'));
            const [la0, lo0, la1, lo1] = (u.searchParams.get('BBOX') ?? '').split(',').map(Number);
            gibs.push({ layer, time: u.searchParams.get('TIME'), bbox: [la0, lo0, la1, lo1], W, H });
            if (!/Band13|Band_13/.test(layer)) {
                return route.fulfill({ status: 200, contentType: 'image/png', body: encodePng(4, 4, () => [0, 0, 0, 0]) });
            }
            // encodePng calls back with (column, row) — not a flat index
            // (treating it as one put every row on the north edge, which is
            // exactly the bug this gate exists to catch, in the stub).
            const body = encodePng(W, H, (x, y) => {
                const lon = lo0 + ((x + 0.5) * (lo1 - lo0)) / W;
                const lat = la1 - ((y + 0.5) * (la1 - la0)) / H;          // row 0 = north
                if (lat < NORTH_OF) return [150, 150, 150, 255];
                return (Math.floor(lon / (STRIPE_DEG / 2)) & 1) ? [235, 235, 235, 255] : [70, 70, 70, 255];
            });
            return route.fulfill({ status: 200, contentType: 'image/png', body, headers: { 'access-control-allow-origin': '*' } });
        }
        return route.abort();
    });
    await page.goto('/earth.html' + query, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof window.__evLod === 'function' && typeof window.__evPick === 'function'
        && typeof window.__evCloudDetail === 'function', null, { timeout: 120_000 });
    await page.waitForTimeout(8_000);   // textures + the first mosaic
    await page.evaluate(({ quiet, clouds }) => {
        const set = (id, on) => {
            const el = document.getElementById(id);
            if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
        };
        for (const id of quiet) set(id, false);
        set('lyr-clouds', clouds);
    }, { quiet: QUIET, clouds });
    return errors;
}

/**
 * Light the view: hold the Sun 30° north of the camera's own direction
 * (window.__evSetSunDir). The surface is physically lit and the night side
 * is black, and scrubbing the clock cannot help — the globe's rotation is
 * frozen at page load, so hours of sim time move the terminator by a
 * fraction of a degree (this gate measured a black disc that way first).
 * 30° keeps the ocean glint off the measured centre.
 */
async function sunBehindCamera(page) {
    await page.evaluate(() => {
        const [x, y, z] = window.__evCamera().pos;
        const r = Math.hypot(x, y, z);
        const p = [x / r, y / r, z / r];
        // North tangent at the sub-camera point (world +Y projected off p).
        let t = [-p[1] * p[0], 1 - p[1] * p[1], -p[1] * p[2]];
        const tl = Math.hypot(...t) || 1;
        t = t.map(v => v / tl);
        const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
        window.__evSetSunDir(p[0] * c + t[0] * s, p[1] * c + t[1] * s, p[2] * c + t[2] * s);
    });
    await page.waitForTimeout(1_500);
}

async function flyAndSettle(page, lat, lon, dist) {
    await page.evaluate(([la, lo, d]) => window.flyToLatLon(la, lo, d), [lat, lon, dist]);
    await page.waitForFunction(() => !window.__evCamera().flying, null, { timeout: 120_000 });
    await page.waitForTimeout(2_500);   // footprint throttle (1.5 s) + a frame
}

/** The canvas alone (chrome hidden), decoded. */
async function canvasPixels(page, tag = 'frame') {
    await page.addStyleTag({ content: 'body *{visibility:hidden !important} #c{visibility:visible !important}' });
    await page.waitForTimeout(1_500);
    const png = await page.locator('#c').screenshot();
    // REGIONAL_LOD_PNG=<dir> keeps every measured frame beside its numbers.
    if (process.env.REGIONAL_LOD_PNG) writeFileSync(`${process.env.REGIONAL_LOD_PNG}/${tag}.png`, png);
    return decodePng(png);
}
const lum = (img, x, y) => {
    const o = (y * img.width + x) * 4;
    return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
};
/** Bright↔dark flips along rows (hysteresis around each row's own mean). */
function transitions(img, y0f, y1f, x0f = 0.2, x1f = 0.8, hyst = 10) {
    let flips = 0;
    const x0 = Math.round(img.width * x0f), x1 = Math.round(img.width * x1f);
    for (let y = Math.round(img.height * y0f); y < Math.round(img.height * y1f); y += 3) {
        let m = 0;
        for (let x = x0; x < x1; x++) m += lum(img, x, y);
        m /= (x1 - x0);
        let state = -1;
        for (let x = x0; x < x1; x++) {
            const v = lum(img, x, y);
            const s = v > m + hyst ? 1 : v < m - hyst ? 0 : state;
            if (state !== -1 && s !== state) flips++;
            state = s;
        }
    }
    return flips;
}

test('regions: the picker lands in regional detail, the readout says so, the pick is the true point', async ({ page }) => {
    const errors = await boot(page, '', { clouds: false });
    const r = regionById('us-great-plains-and-midwest');
    // The globe's own LOD: the opening view draws the coarse mesh (its facets
    // are sub-pixel there), the regional close-up swaps in level 47.
    const far = await page.evaluate(() => ({ detail: window.__evLod().globeDetail, dist: window.__evCamera().dist }));
    expect(far.detail, `the far globe is the coarse mesh (camera at ${far.dist?.toFixed?.(2)} R)`).toBe(15);
    const opts = await page.$$eval('#ev-region option', (os) => os.map((o) => o.value).filter(Boolean));
    expect(opts.length, 'every REGIONS box is offered').toBeGreaterThanOrEqual(45);
    expect(opts).toContain(r.id);

    await page.selectOption('#ev-region', r.id);
    await page.waitForFunction(() => !window.__evCamera().flying, null, { timeout: 120_000 });
    await page.waitForFunction(() => window.__evLod().tier === 'regional', null, { timeout: 60_000 });
    const st = await page.evaluate(() => ({
        cam: window.__evCamera(), lod: window.__evLod(), pick: window.__evPick(0, 0),
        aspect: (() => { const c = document.getElementById('c'); return c.clientWidth / c.clientHeight; })(),
        sel: document.getElementById('ev-region').value,
        toolsH: getComputedStyle(document.getElementById('layer-panel')).getPropertyValue('--layer-tools-h'),
        toolsReal: document.querySelector('#layer-panel .layer-tools').offsetHeight,
    }));
    console.log('[regional-lod] region', JSON.stringify({ dist: st.cam.dist, lod: st.lod.text, pick: st.pick }));
    expect(errors, errors.join('\n')).toHaveLength(0);

    const want = regionView(r, { fovDeg: 40, aspect: st.aspect, minDist: 1.014, maxDist: 10 });
    expect(Math.abs(st.cam.dist - want.dist) / want.dist, 'landed at the framed distance').toBeLessThan(0.01);
    expect(st.lod.footprint.spanLatDeg, 'the footprint is in regional detail').toBeLessThanOrEqual(45);
    expect(st.lod.text).toContain('Regional detail');
    expect(st.lod.globeDetail, 'up close the globe is the level-47 mesh').toBe(47);
    expect(st.lod.text).toMatch(/over (US Great Plains|Eastern North America|Western North America|Mexico)/);
    expect(st.lod.text).toMatch(/\d+(\.\d)? (km|Mm) up/);
    expect(st.sel, 'the picker returns to its prompt so the same region can be chosen again').toBe('');
    expect(parseInt(st.toolsH, 10), '#layer-feedback sticks under the MEASURED tools block').toBe(st.toolsReal);

    // The pick: the screen centre is the region's centre …
    expect(Math.abs(st.pick.analytic.lat - r.lat)).toBeLessThan(1.5);
    expect(Math.abs(st.pick.analytic.lon - r.lon)).toBeLessThan(1.5);
    // … and the NEGATIVE CONTROL: the mesh UVs name its antipode.
    expect(Math.abs(st.pick.meshUv.lat + r.lat), 'mesh UV latitude is mirrored').toBeLessThan(1.5);
    const dLonAnti = Math.abs(((st.pick.meshUv.lon - (r.lon + 180)) % 360 + 540) % 360 - 180);
    expect(dLonAnti, 'mesh UV longitude is 180° off').toBeLessThan(1.5);
});

test('deep link: ?region= flies there on load', async ({ page }) => {
    const errors = await boot(page, '?region=japan-and-korea', { clouds: false });
    await page.waitForFunction(() => !window.__evCamera().flying && window.__evCamera().dist < 2, null, { timeout: 60_000 });
    const pick = await page.evaluate(() => window.__evPick(0, 0).analytic);
    expect(errors, errors.join('\n')).toHaveLength(0);
    expect(Math.abs(pick.lat - 38)).toBeLessThan(2);
    expect(Math.abs(pick.lon - 137)).toBeLessThan(2);
});

test('regional cloud window: finer than the global frame, right way up, stitched across the dateline', async ({ browser }) => {
    const run = async (query) => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const gibs = [];
        const errors = await boot(page, query, { clouds: true, gibs });
        await flyAndSettle(page, NORTH_OF, 180, 1 + 2800 / 6371);
        await sunBehindCamera(page);
        if (!query.includes('cloud_detail=0')) {
            await page.waitForFunction(() => window.__evCloudDetail().status === 'live', null, { timeout: 120_000 });
        }
        await page.waitForTimeout(3_000);
        const detail = await page.evaluate(() => window.__evCloudDetail());
        const img = await canvasPixels(page, `window${query.replace(/[^a-z0-9]+/gi, '_')}`);
        const out = {
            north: transitions(img, 0.12, 0.40),
            south: transitions(img, 0.60, 0.88),
            detail, gibs, errors,
        };
        await page.close();
        return out;
    };
    const on = await run('');
    const off = await run('?cloud_detail=0');
    console.log('[regional-lod] window', JSON.stringify({
        on: { north: on.north, south: on.south, status: on.detail.status, used: on.detail.used, kmPerPx: on.detail.kmPerPx },
        off: { north: off.north, south: off.south },
    }));
    for (const r of [on, off]) expect(r.errors, r.errors.join('\n')).toHaveLength(0);

    // Fetched over the dateline as TWO boxes, at the global frame's OWN times.
    const regional = on.gibs.filter((g) => !(g.bbox[1] === -180 && g.bbox[3] === 180));
    expect(regional.some((g) => g.bbox[3] === 180) && regional.some((g) => g.bbox[1] === -180), 'two BBOXes meeting at ±180°').toBe(true);
    for (const g of regional) {
        const global = on.gibs.filter((x) => x.layer === g.layer && x.bbox[1] === -180 && x.bbox[3] === 180).map((x) => x.time);
        expect(global, `${g.layer} at ${g.time} is a time the global frame used`).toContain(g.time);
    }
    expect(on.detail.status).toBe('live');
    expect(on.detail.kmPerPx, 'the window is several times finer than the 20 km global frame').toBeLessThan(6);

    // Finer: the stripes resolve only with the window.
    expect(on.north, 'stripes resolved in the north half').toBeGreaterThan(2.5 * Math.max(1, off.north));
    // Right way up: the stripes are NORTH of 40° N, the uniform field south.
    expect(on.north, 'north half striped, south half not (a flipped window fails here)').toBeGreaterThan(3 * Math.max(1, on.south));
});

test('antimeridian: no coarsest-mip column down the 180° meridian', async ({ browser }) => {
    const run = async (query) => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const errors = await boot(page, query, { clouds: false });
        // THREE camera longitudes ~½ px apart at the equator, worst one kept.
        // The coarsest-mip column only appears where the u jump falls INSIDE
        // a 2×2 derivative quad; where the 180° line lands on a quad boundary
        // the old UV draws nothing wrong. Which one it is depends on the
        // line's sub-pixel position — and that moved with the globe mesh: one
        // pose read the control 14.6, 5.9 and 0.36 across runs once the globe
        // got its own LOD. Three phases always put one inside a quad.
        let seam = 0;
        for (const dLon of [0, 0.04, 0.08]) {
            await flyAndSettle(page, 0, 180 - dLon, 1 + 9000 / 6371);
            await sunBehindCamera(page);
            seam = Math.max(seam, await measureSeam(page, `seam${query.replace(/[^a-z0-9]+/gi, '_')}_${dLon}`));
        }
        await page.close();
        return { seam, errors };
    };
    const measureSeam = async (page, tag) => {
        const img = await canvasPixels(page, tag);
        // Column means over the TOP of the disc (high latitude); the seam is
        // the largest excess of one column over the median of its ±8 px
        // neighbours. Why the top band: with anisotropic filtering the GPU
        // takes its level of detail from the footprint's SHORT axis, so the
        // seam's 1→0 jump in u alone only reaches the coarsest mip where v
        // varies fast too — near the pole, where the meridians converge.
        // Measured on SwiftShader: the line runs from the disc's top edge
        // down ~45 px and is absent across the equatorial band.
        const cx = img.width >> 1, y0 = Math.round(img.height * 0.005), y1 = Math.round(img.height * 0.06);
        const col = (x) => { let s = 0; for (let y = y0; y < y1; y++) s += lum(img, x, y); return s / (y1 - y0); };
        let seam = 0;
        for (let x = cx - 40; x <= cx + 40; x++) {
            const nb = [];
            for (let k = 2; k <= 8; k++) nb.push(col(x - k), col(x + k));
            nb.sort((a, b) => a - b);
            seam = Math.max(seam, Math.abs(col(x) - nb[nb.length >> 1]));
        }
        return seam;
    };
    const fixed = await run('');
    const legacy = await run('?uvseam=legacy');
    console.log('[regional-lod] seam', JSON.stringify({ fixed: fixed.seam, legacy: legacy.seam }));
    for (const r of [fixed, legacy]) expect(r.errors, r.errors.join('\n')).toHaveLength(0);
    expect(legacy.seam, 'NEGATIVE CONTROL: the old UV draws the coarsest-mip column').toBeGreaterThan(8);
    expect(fixed.seam, 'the seam-safe UV leaves no column').toBeLessThan(legacy.seam / 3);
});
