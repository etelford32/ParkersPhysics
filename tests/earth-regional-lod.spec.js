import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { boot, sunBehindCamera, flyAndSettle, canvasShot, transitions, seamColumn, NORTH_OF } from './helpers/earthview-harness.mjs';
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

// The stubs, the quiet layer set and the frame read-back live in ONE place,
// shared with tests/earthview-validation.spec.js.
async function canvasPixels(page, tag = 'frame') {
    const { png, img } = await canvasShot(page);
    // REGIONAL_LOD_PNG=<dir> keeps every measured frame beside its numbers.
    if (process.env.REGIONAL_LOD_PNG) writeFileSync(`${process.env.REGIONAL_LOD_PNG}/${tag}.png`, png);
    return img;
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
    const measureSeam = async (page, tag) => seamColumn(await canvasPixels(page, tag)).seam;
    const fixed = await run('');
    const legacy = await run('?uvseam=legacy');
    console.log('[regional-lod] seam', JSON.stringify({ fixed: fixed.seam, legacy: legacy.seam }));
    for (const r of [fixed, legacy]) expect(r.errors, r.errors.join('\n')).toHaveLength(0);
    expect(legacy.seam, 'NEGATIVE CONTROL: the old UV draws the coarsest-mip column').toBeGreaterThan(8);
    expect(fixed.seam, 'the seam-safe UV leaves no column').toBeLessThan(legacy.seam / 3);
});
