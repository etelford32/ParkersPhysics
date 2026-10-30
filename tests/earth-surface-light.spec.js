import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * earth-surface-light.spec.js — EarthView's surface is physically lit, in PIXELS.
 *
 * `node tests/earth-surface-light.mjs` pins the model (js/earth-surface-light.js).
 * This gate reads the FINAL frame — after the page's ACES + sRGB output pass,
 * through `window.__evFrameStats` — because a model that is right in JS can
 * still be wrong on screen (the 2026-10-30 review found the wind palette
 * tested in arrays and washed out on the canvas). Same frames, two shaders:
 * the physical default and `?earthlight=legacy`, which is the NEGATIVE CONTROL
 * — every check below must fail on it, or the gate cannot see the bug.
 *
 *   1. DARK NIGHT. The share of the night-side disc where any ground shows
 *      at all (max channel ≥ 8): legacy drew the night as the daytime photo
 *      at ~19 %, physical leaves starlight + airglow (black after the tone
 *      curve) and the lamps. A coverage, not a mean — the lamps are bright
 *      and a mean would let them carry a lit-up night past the gate.
 *   2. LAMPS ARE EMITTERS. Lamp-core pixels (max channel ≥ 150) on the night
 *      disc: legacy multiplied the lamps by its 0.35 lighting floor, physical
 *      adds them after the lighting.
 *   3. THE MAP SURVIVES NOON. The sunward disc is white-balanced to the
 *      zenith beam, so its mean brightness stays within 15 % of the legacy
 *      render — physics must not quietly re-expose the page.
 *   4. Both shaders COMPILE (no WebGLProgram error) and the page throws nothing.
 *
 * Hermetic: unpkg is egress-blocked here, so the four three-globe maps are
 * served from assets/earth (the SAME images, resized — assets/earth/SOURCES.md).
 * The night map stands in as lights-2k (lamps only, already floor-subtracted,
 * so the shader's floor dims its faint lamps: the cores this gate counts
 * survive). Layers that would add light of their own are switched off.
 *
 * Run with --workers=1 on the sandbox: parallel SwiftShader workers kill the
 * browser session (EARTHVIEW_VISUAL_DIALIN_PLAN.md §2).
 */

test.describe.configure({ timeout: 600_000 });

const MAPS = {
    'earth-blue-marble.jpg': 'assets/earth/day-2k.webp',
    'earth-night.jpg':       'assets/earth/lights-2k.webp',
    'earth-water.png':       'assets/earth/water-2k.webp',
    'earth-topology.png':    'assets/earth/relief-2k.webp',
};
const OFF_LAYERS = ['lyr-clouds', 'lyr-obs-sst', 'lyr-isobars', 'lyr-wind', 'lyr-cities', 'lyr-atm',
                    'lyr-obs-precip', 'lyr-obs-fires', 'lyr-obs-snow', 'lyr-rotate', 'lyr-weather'];

async function measure(page, query) {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (m) => {
        if (m.type() === 'error' && /WebGLProgram|Shader Error|ERROR: \d+:\d+/.test(m.text())) errors.push(m.text().slice(0, 600));
    });
    await page.route(/three-globe@[^/]+\/example\/img\//, (route) => {
        const name = route.request().url().split('/').pop();
        const file = MAPS[name];
        if (!file) return route.abort();
        return route.fulfill({ status: 200, contentType: 'image/webp', body: readFileSync(new URL(`../${file}`, import.meta.url)) });
    });
    await page.goto('/earth.html' + query, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof window.__evFrameStats === 'function', null, { timeout: 120_000 });
    // The textures resolve asynchronously; wait until the day map is on the globe.
    await page.waitForTimeout(12_000);
    await page.evaluate((ids) => {
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el && el.checked) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        const lights = document.getElementById('lyr-lights');
        if (lights && !lights.checked) { lights.checked = true; lights.dispatchEvent(new Event('change', { bubbles: true })); }
    }, OFF_LAYERS);
    await page.waitForTimeout(1_500);

    const views = {};
    for (const [name, sign] of [['day', 1], ['night', -1]]) {
        views[name] = await page.evaluate((sign) => {
            const s = window.__evSunDir();
            window.__evSetCamDist(3.0);
            window.__evSetCamDir(sign * s[0], sign * s[1], sign * s[2]);
            // The disc: the centre half of the shorter side (globe radius ≈ 0.41 H at 3 R).
            const cv = document.querySelector('#c');
            const W = cv.width, H = cv.height;
            const side = Math.floor(Math.min(W, H) * 0.5);
            const box = { x: (W - side) >> 1, y: (H - side) >> 1, w: side, h: side };
            window.__evFrameStats(box);                               // settle one frame at the new pose
            const all  = window.__evFrameStats({ ...box, lit: 0 });   // meanMax over every pixel
            const seen = window.__evFrameStats({ ...box, lit: 8 });     // any ground visible at all
            const core = window.__evFrameStats({ ...box, lit: 150 });
            return { meanMax: all.meanMax, fracSeen: seen.lit / seen.n, lampCores: core.lit, n: all.n };
        }, sign);
    }
    return { views, errors };
}

test('physical surface: dark night, emitted lamps, the map at noon — and legacy fails each', async ({ page, browser }) => {
    const phys = await measure(page, '');
    const legacyPage = await browser.newPage();
    const leg = await measure(legacyPage, '?earthlight=legacy');
    await legacyPage.close();
    console.log('[earth-surface-light]', JSON.stringify({ physical: phys.views, legacy: leg.views }));

    for (const r of [phys, leg]) expect(r.errors, r.errors.join('\n')).toHaveLength(0);
    for (const r of [phys, leg]) expect(r.views.day.meanMax, 'the day disc rendered at all').toBeGreaterThan(40);

    // 1. dark night (measured 2026-10-30 on SwiftShader: physical 0.048, legacy 0.365)
    expect(phys.views.night.fracSeen, 'physical night side is dark but for the lamps').toBeLessThan(0.12);
    expect(leg.views.night.fracSeen, 'NEGATIVE CONTROL: legacy painted the day photo on the night side').toBeGreaterThan(0.25);

    // 2. lamps are emitters (measured: physical 1348 core pixels, legacy 335)
    expect(phys.views.night.lampCores, 'lamp cores on the physical night side').toBeGreaterThan(200);
    expect(phys.views.night.lampCores, 'NEGATIVE CONTROL: legacy dimmed the lamps by its lighting floor')
        .toBeGreaterThan(2 * leg.views.night.lampCores);

    // 3. the map survives noon (measured: 87.4 vs 85.8)
    const dayRel = phys.views.day.meanMax / leg.views.day.meanMax;
    expect(dayRel, 'noon brightness is the map, not a re-exposure').toBeGreaterThan(0.85);
    expect(dayRel).toBeLessThan(1.15);
});
