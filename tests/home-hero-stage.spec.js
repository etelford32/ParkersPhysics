// @ts-check
/**
 * home-hero-stage.spec.js — the homepage hero's STAGE geometry
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-20: the hero is split at ≥1100px (copy + console in a 560px left
 * column, Earth framed into the empty #hero-stage box on the right) and
 * stacked below that (the stage is a band between the copy and the console).
 * js/hero-space-weather.js reads the stage's rect and solves fov + NDC centre
 * (`__ppHero._frame` under ?debug=1). Pins:
 *   (1) nothing in the DOM overlaps the stage — the whole point of the layout;
 *   (2) on the split, Earth's NDC x is in the right half and the fov is a
 *       telephoto (the 2–2.5× disc), on the stack it is centred;
 *   (3) the console's tab row reflows to two columns inside the 560px lane
 *       (container query — a viewport query kept it 5-across and overflowed);
 *   (4) no horizontal page overflow at either width;
 *   (5) the CME flux-rope layer (js/hero-rope-layer.js) adopts a forecast
 *       whatever the feed does (live / idle→replay / failed→replay), mounts
 *       the scrubber under the stage without overlapping it, and scrubbing
 *       its CME TRANSIT tab pulls the camera to the corridor framing
 *       (mix → 1, corrDist > 0) with the train drawn — and, with a live
 *       OVATION oval served, puts the curtains back on the Kp ring while the
 *       MODEL storm drives the engine (a replayed G5 must not wear today's
 *       observed oval);
 *   (6) the ☉ NEXT 24 H tab (the default; js/hero-sun.js + hero-sun-model):
 *       on a SYNTHETIC active Sun (tests/fixtures/sun-outlook-synthetic.mjs —
 *       NOAA and DONKI are egress-blocked here) the live Sun wears the
 *       regions, the flux-rope KERNEL propagates every catalogued CME with
 *       its skin painted by the kernel's own Bz, scrubbing closes the camera
 *       on the Sun and parks the near-Earth scene, the resting Earth shot
 *       draws NO rope (an Earth-directed rope near 1 AU once engulfed the
 *       planet), and a dead regions feed LOOKS dead (no invented spots).
 * Chrome geometry only — no live network needed (feeds fail closed).
 */
import { test, expect } from '@playwright/test';
import { synthOvation } from './fixtures/ovation-synthetic.mjs';
import { synthRegions, synthBus } from './fixtures/sun-outlook-synthetic.mjs';

const URL = '/index.html?exp_home_bg_carousel=control&debug=1';

async function boot(page) {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // Hero boots (__ppHero) or hides its canvas on a GL failure.
    await page.waitForFunction(() => {
        const c = document.getElementById('hero-canvas');
        return !!window.__ppHero || (c && c.style.display === 'none');
    }, null, { timeout: 45_000 });
    await page.waitForSelector('.sc-tabs');
    await page.waitForTimeout(500);
}

function rect(page, sel) {
    return page.evaluate((s) => {
        const b = document.querySelector(s)?.getBoundingClientRect();
        return b ? { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } : null;
    }, sel);
}

function overlaps(a, b) {
    return a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
}

test.describe('home hero stage', () => {
    // Boot alone measured 41 s on the software rasteriser; the 60 s default
    // is what a full-file run tripped, not an assertion.
    test.describe.configure({ timeout: 150_000 });
    test('split layout at 1440: stage right of the copy, nothing over it, Earth framed right', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const stage = await rect(page, '#hero-stage');
        const top   = await rect(page, '.hero-top');
        const cons  = await rect(page, '#sky-console-host');
        const cta   = await rect(page, '.hero-cta');
        expect(stage.w).toBeGreaterThan(500);
        expect(stage.l).toBeGreaterThan(top.r);          // right column
        expect(stage.t).toBeLessThan(900);               // above the fold
        expect(stage.b).toBeLessThanOrEqual(900);        // the cap keeps the box in the viewport
        for (const box of [top, cons, cta]) expect(overlaps(stage, box)).toBe(false);

        // Console reflowed inside its lane
        const tabs = await page.evaluate(() => {
            const t = document.querySelector('.sc-tabs');
            const r = t.getBoundingClientRect();
            const cols = getComputedStyle(t).gridTemplateColumns.split(' ').length;
            const over = [...t.children].some(c => c.getBoundingClientRect().right > r.right + 1);
            return { w: r.width, cols, over };
        });
        expect(tabs.w).toBeGreaterThan(500);
        expect(tabs.cols).toBe(2);
        expect(tabs.over).toBe(false);

        const frame = await page.evaluate(() => window.__ppHero?._frame ?? null);
        test.skip(!frame, 'WebGL unavailable — framing not solvable here');
        expect(frame.nx).toBeGreaterThan(0.3);
        expect(frame.fov).toBeLessThan(36);

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    });

    test('rope layer: adopts a forecast, scrubber sits under the stage, scrubbing frames the corridor', async ({ page }) => {
        // Boot + the replay kernel's WASM + the corridor ease, all on a
        // software rasteriser: measured ~75 s end to end, over the 60 s default.
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        // A live OVATION oval (SYNTHETIC fixture — NOAA is egress-blocked
        // here), so the scrub below can prove a MODEL storm never wears it.
        const ovation = JSON.stringify(synthOvation(new Date()));
        await page.route('**/api/noaa/aurora-grid*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: ovation }));
        await boot(page);
        const hero = await page.evaluate(() => !!window.__ppHero);
        test.skip(!hero, 'WebGL unavailable — no rope layer without the scene');
        await page.waitForFunction(() => window.__ppHero._auroraSource === 'ovation', null, { timeout: 30_000 });
        // The replay's kernel is a 147 KB WASM; give it time on software GL.
        await page.waitForFunction(() => window.__heroRopes?.state.transitRopes > 0, null, { timeout: 60_000 });
        // Pausing parks the 24 h preview's self-start too (the hook the shots use).
        await page.evaluate(() => { window.__heroRopes.setPlaying(false); window.__heroRopes.setTab('transit'); });
        const st0 = await page.evaluate(() => window.__heroRopes.state);
        expect(st0.tab).toBe('transit');
        expect(st0.ropeCount).toBeGreaterThan(0);
        expect(['live', 'replay', 'down']).toContain(st0.mode);
        expect(st0.framing).toBe('earth');     // a tab switch by hook never moves the camera

        const scrub = await rect(page, '#hero-scrub');
        const stage = await rect(page, '#hero-stage');
        expect(scrub).not.toBeNull();
        expect(scrub.t).toBeGreaterThanOrEqual(stage.b - 1);   // under the stage, never over it
        expect(overlaps(scrub, stage)).toBe(false);
        await expect(page.locator('#hero-scrub .hrs-mode')).toContainText(/LIVE|REPLAY/);
        await expect(page.locator('#hero-scrub a[data-funnel-cta="hero_flux_rope"]')).toHaveCount(1);

        // Sound layer: mounted, OFF by default, no AudioContext until a click.
        const snd = page.locator('#hero-sound .hsn-btn');
        await expect(snd).toHaveAttribute('aria-pressed', 'false');
        expect(await page.evaluate(() => window.__heroSound?.state.hasContext)).toBe(false);
        expect(overlaps(await rect(page, '#hero-sound'), await rect(page, '#hero-stage'))).toBe(false);

        // Sign-up upsell: present for a signed-out visitor, one field, one
        // funnel-tracked button; a bad email fails client-side, no network.
        const up = page.locator('#hero-signup');
        await expect(up).toBeVisible();
        await expect(up.locator('button[data-funnel-cta="hero_magic_link"]')).toHaveCount(1);
        await up.locator('input[type="email"]').fill('not-an-email');
        await up.locator('form').evaluate((f) => f.requestSubmit());
        await expect(up).toHaveAttribute('data-state', 'error');
        expect(overlaps(await rect(page, '#hero-signup'), await rect(page, '#hero-stage'))).toBe(false);

        // The location field stands out until a place is saved.
        await expect(page.locator('#sky-console-host .sc-loc')).toHaveClass(/unset/);

        // Scrub to mid-transit: corridor framing, camera eased out, train drawn.
        await page.evaluate(() => {
            const r = window.__heroRopes; const w = r.state.window;
            r.setPlaying(false);
            // hold: a programmatic scrub is not a drag, and the layer rests
            // back to Earth 6 s after a drag ends — slower than this poll.
            r.setTau(w.t0 + (w.arrivalMs ? (w.arrivalMs - w.t0) * 0.85 : (w.t1 - w.t0) * 0.5), false, true);
        });
        await page.waitForFunction(() => window.__ppHero._mix > 0.95, null, { timeout: 20_000 });
        const st1 = await page.evaluate(() => ({ ...window.__heroRopes.state, frame: window.__ppHero._frame }));
        expect(st1.framing).toBe('corridor');
        expect(st1.frame.corrDist).toBeGreaterThan(20);
        expect(st1.drawn).toBeGreaterThan(0);
        expect(st1.apexAu.some((a) => a > 0 && a < 1.35)).toBe(true);
        expect(st1.oracle.filter(Boolean).every((o) => o === 'kernel' || o === 'mirror')).toBe(true);
        // The skins are the kernel's field wherever the kernel drew the rope.
        if (st1.oracle.includes('kernel')) expect(st1.fielded).toBeGreaterThan(0);
        // A replay is another date: the Sun wears none of TODAY's activity.
        if (st1.mode !== 'live') expect(st1.sun.live).toBe(false);
        // The engine is on the MODEL state at τ: the curtains go back to the
        // Kp ring, never today's observed oval (js/hero-space-weather.js
        // _applyAurora).
        await page.waitForFunction(() => window.__ppHero._auroraSource === 'kp' && window.__ppHero._engine._auroraOval === null, null, { timeout: 20_000 });
    });

    test('Next 24 h: the live Sun wears the regions, the kernel flies every CME, the camera closes on the Sun', async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        const now = Date.now();
        await page.route('**/api/noaa/regions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(synthRegions(now)) }));
        // The live feed (dead here: fallback state) would overwrite the
        // injected catalogue between frames — the hero's HARNESS SCAR.
        await page.addInitScript(() => {
            window.addEventListener('swpc-update', (e) => { if (!e.detail?.__synthetic) e.stopImmediatePropagation(); }, true);
        });
        await boot(page);
        const hero = await page.evaluate(() => !!window.__ppHero);
        test.skip(!hero, 'WebGL unavailable — no Sun without the scene');
        await page.waitForFunction(() => !!window.__heroRopes, null, { timeout: 60_000 });
        await page.evaluate((b) => {
            for (const f of b.flares) f.time = new Date(f.time);
            window.__heroRopes.setPlaying(false);
            window.__heroRopes.setBusState(b);
        }, synthBus(now));
        // Kernel WASM + the fixture regions.
        await page.waitForFunction(() => {
            const o = window.__heroRopes.state.outlook;
            return o.cmes === 4 && o.regions > 0;
        }, null, { timeout: 60_000 });
        const st0 = await page.evaluate(() => ({ ...window.__heroRopes.state, groupVisible: window.__heroRopes.group.visible }));
        expect(st0.tab).toBe('outlook');                       // the default tab
        expect(st0.outlook.regionsState).toBe('ok');
        expect(st0.outlook.regions).toBe(6);                    // history row superseded, 7 rows → 6 regions
        expect(st0.window.t1 - st0.window.t0).toBe(24 * 3600e3);
        expect(st0.window.t0).toBeGreaterThanOrEqual(now - 120e3);
        expect(st0.groupVisible).toBe(false);                   // the resting Earth shot draws no rope
        await expect(page.locator('#hero-scrub .hrs-tab[data-tab="outlook"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#hero-scrub .hrs-mode')).toContainText(/LIVE · Sun · next 24 h/i);
        await expect(page.locator('#hero-scrub a[data-funnel-cta="hero_flux_rope"]')).toHaveCount(1);
        await expect(page.locator('#hero-scrub a[data-funnel-cta="hero_sun_outlook"]')).toHaveCount(1);
        await expect(page.locator('#hero-scrub .hrs-legend')).toContainText('AR 4233');
        // The Earth-directed rope crosses 1 AU inside the day (kernel probe).
        await expect(page.locator('#hero-scrub .hrs-mark.arrive')).toHaveCount(1);

        // Scrub 3 h ahead: the camera closes on the drawn Sun.
        await page.evaluate(() => { const r = window.__heroRopes; r.setTau(r.state.window.t0 + 3 * 3600e3, false, true); });
        await page.waitForFunction(() => window.__ppHero._sunMix > 0.97, null, { timeout: 20_000 });
        const st1 = await page.evaluate(() => ({
            ...window.__heroRopes.state, sunMix: window.__ppHero._sunMix, parked: window.__ppHero._parked,
            earthVisible: window.__ppHero._earth.visible, groupVisible: window.__heroRopes.group.visible,
            frame: window.__ppHero._frame,
        }));
        expect(st1.framing).toBe('sun');
        expect(st1.frame.sunDist).toBeGreaterThan(5);
        expect(st1.parked).toBe(true);                          // globe + shells off the sightline
        expect(st1.earthVisible).toBe(false);
        expect(st1.groupVisible).toBe(true);
        expect(st1.sun.live).toBe(true);
        expect(st1.sun.regions).toBe(6);
        expect(st1.sun.earthFacing).toBeGreaterThanOrEqual(4);
        expect(st1.sun.xray).toBeCloseTo(0.55, 2);
        expect(st1.drawn).toBe(4);                               // every direction, not just Earth's
        expect(st1.oracle.every((o) => o === 'kernel')).toBe(true);
        expect(st1.fielded).toBe(4);                             // skins = kernel Bz
        // The regions rotate WEST over the day (the legend re-renders at 400 ms).
        const lonAt = async (h) => {
            await page.evaluate((hh) => { const r = window.__heroRopes; r.setTau(r.state.window.t0 + hh * 3600e3, false, true); }, h);
            await page.waitForTimeout(900);
            const m = /AR 4233[^·]*·\s*S09E(\d+)/.exec(await page.locator('#hero-scrub .hrs-legend').textContent());
            return m ? Number(m[1]) : null;
        };
        const e3 = await lonAt(3), e20 = await lonAt(20);
        expect(e3).not.toBeNull(); expect(e20).not.toBeNull();
        expect(e3 - e20).toBeGreaterThan(7);                    // ~13°/day × 17 h, east → west

        // Let go: back to Earth, the near-Earth scene restored.
        await page.evaluate(() => { window.__heroRopes.release(); window.__heroRopes.setTab('outlook'); });
        await page.waitForFunction(() => window.__ppHero._sunMix < 0.02 && !window.__ppHero._parked, null, { timeout: 30_000 });
        expect(await page.evaluate(() => window.__ppHero._earth.visible)).toBe(true);
    });

    test('Next 24 h with the regions feed down: no invented spots, and the chip says so', async ({ page }) => {
        test.setTimeout(150_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.route('**/api/noaa/regions*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }));
        await boot(page);
        const hero = await page.evaluate(() => !!window.__ppHero);
        test.skip(!hero, 'WebGL unavailable');
        await page.waitForFunction(() => window.__heroRopes?.state.outlook.regionsState === 'down', null, { timeout: 60_000 });
        const st = await page.evaluate(() => window.__heroRopes.state);
        expect(st.outlook.regions).toBe(0);
        expect(st.sun.regions).toBe(0);
        await expect(page.locator('#hero-scrub .hrs-mode')).toContainText(/regions feed down/i);
        await expect(page.locator('#hero-scrub .hrs-mode')).toHaveClass(/down/);
        // DONKI is unreachable here too: an empty sky must say WHY, never read as a quiet Sun.
        await expect(page.locator('#hero-scrub .hrs-legend')).toContainText(/not received|waiting for the live feed/);
        await expect(page.locator('#hero-scrub .hrs-legend')).not.toContainText(/No CMEs/);
    });

    test('stacked layout at 390: stage is a band between copy and console, Earth centred', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await boot(page);
        const stage = await rect(page, '#hero-stage');
        const top   = await rect(page, '.hero-top');
        const cons  = await rect(page, '#sky-console-host');
        expect(stage.h).toBeGreaterThanOrEqual(200);
        expect(stage.t).toBeGreaterThanOrEqual(top.b - 1);
        expect(cons.t).toBeGreaterThanOrEqual(stage.b - 1);
        expect(overlaps(stage, top)).toBe(false);
        expect(overlaps(stage, cons)).toBe(false);

        const frame = await page.evaluate(() => window.__ppHero?._frame ?? null);
        test.skip(!frame, 'WebGL unavailable — framing not solvable here');
        expect(Math.abs(frame.nx)).toBeLessThan(0.05);

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
});
