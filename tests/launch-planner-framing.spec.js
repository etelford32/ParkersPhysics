/**
 * launch-planner-framing.spec.js — can the camera actually SEE the vehicle?
 *
 * The other launch-planner gates prove the canvas draws SOMETHING and that
 * every camera is above the ground. None of them noticed that the default
 * Falcon 9 shot put a 95 m lightning tower between the camera and the rocket
 * (fixed 2026-11-02 in js/launch-pad-3d.js) — a screenshot "looks fine" to a
 * luminance check while the subject is behind a lattice.
 *
 * Two of the page's own measurements, both pure geometry (GPU-independent,
 * so this runs with the post chain off for speed) swept over every vehicle ×
 * camera preset on a desktop and a phone:
 *   · `api.measureForeground()` — how much of the frame's central band is
 *     covered by tall pad structures standing in FRONT of the vehicle. This
 *     is the one that sees the tower bug.
 *   · `api.measureOcclusion()` — rays through the vehicle's on-screen box:
 *     how many reach it only after hitting something else first.
 * plus: the non-cropped presets keep the whole stack inside the frame and
 * clear of the toolbars (the safe insets the page measured).
 *
 * The Top preset is exempt from the clutter limit: looking DOWN a stack, the
 * strongback / tower beside it is nearer the camera by construction.
 *
 * NEGATIVE CONTROLS (each must FAIL, or its measurement is decoration):
 *   · the four lightning towers planted back at their pre-fix spots (70 m out
 *     on the diagonals) ⇒ the default Falcon 9 view fails the clutter limit.
 *     Measured 2026-11-02: 20.6 % of the band vs 0 % shipped. The occlusion
 *     measure alone does NOT catch it (0 %): the tower stood ~24 m off the
 *     camera→rocket line — which is why the clutter measure exists.
 *   · a solid block on the camera→rocket line ⇒ the occlusion limit fails.
 */
import { test, expect } from '@playwright/test';

// Mirrors of js/launch-render-health.js (asserted equal below).
const OCCLUSION_LIMIT = 0.12;
const FOREGROUND_LIMIT = 0.03;

async function boot(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.route('**/api/telemetry/log', (r) =>
        r.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    await page.goto('/launch-planner.html?lpfx=off', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__lpVehicle3d?.measureOcclusion, null, { timeout: 60_000 });
    await page.evaluate(() => {
        const el = document.querySelector('.lh-vehicle-canvas-host');
        window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
    });
    return errors;
}

// Switch vehicle (optional) and preset, wait for the flight to land, measure.
async function measure(page, { vehicle, variant, view } = {}) {
    return page.evaluate(async ({ vehicle, variant, view }) => {
        const a = window.__lpVehicle3d;
        const settle = () => new Promise((res) => {
            const t = () => (a.isTweening ? setTimeout(t, 80) : res());
            setTimeout(t, 80);
        });
        if (vehicle) { a.setVehicle(vehicle, variant || undefined); await settle(); }
        if (view) { a.setView(view); await settle(); }
        const H = document.getElementById('lh-vehicle-canvas').clientHeight;
        return { ...a.measureOcclusion(), fg: a.measureForeground(), view: a.view, canvasH: H };
    }, { vehicle, variant, view });
}

const VEHICLES = [['shuttle', ''], ['falcon9', 'block5'], ['falcon9', 'heavy'], ['starship', 'v3']];
// Presets that frame the WHOLE stack (closeup / top crop or look down on purpose).
const FULL_STACK = new Set(['threequarter', 'wide', 'front', 'side']);

function expectInFrame(r, label) {
    const { ndcBox, view, canvasH } = r;
    // NDC of the safe rectangle's edges (the page shifts the principal point
    // into it, so a fitted stack sits between them).
    const top = 1 - 2 * (view.insets.top || 0) / canvasH;
    const bottom = -1 + 2 * (view.insets.bottom || 0) / canvasH;
    const tol = 0.04;
    expect(ndcBox.y1, `${label}: stack top inside the frame / under the toolbars`).toBeLessThanOrEqual(top + tol);
    expect(ndcBox.y0, `${label}: stack base inside the frame / above the dock`).toBeGreaterThanOrEqual(bottom - tol);
    expect(ndcBox.x0, `${label}: left edge`).toBeGreaterThanOrEqual(-1 - tol);
    expect(ndcBox.x1, `${label}: right edge`).toBeLessThanOrEqual(1 + tol);
}

test.describe('launch-planner 3D: nothing stands between the camera and the vehicle', () => {
    test.setTimeout(300_000);

    test('the limit here matches the page module', async ({ page }) => {
        await boot(page);
        const lim = await page.evaluate(async () => {
            const m = await import('/js/launch-render-health.js');
            return [m.OCCLUSION_LIMIT, m.FOREGROUND_LIMIT];
        });
        expect(lim).toEqual([OCCLUSION_LIMIT, FOREGROUND_LIMIT]);
    });

    test('desktop 1440×900: every vehicle × preset', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = await boot(page);
        // The first impression: whatever Auto opened on, before any click.
        const first = await measure(page, {});
        expect(first.ok, `default load: ${JSON.stringify(first.occluders)}`).toBe(true);
        expect(first.fg.frac, `default load clutter: ${JSON.stringify(first.fg.items)}`).toBeLessThanOrEqual(FOREGROUND_LIMIT);
        expectInFrame(first, 'default load');
        const rows = [];
        for (const [vehicle, variant] of VEHICLES) {
            let swap = true;   // switch vehicle on its first preset only
            for (const view of ['threequarter', 'wide', 'front', 'side', 'top', 'closeup']) {
                const r = await measure(page, swap ? { vehicle, variant, view } : { view });
                swap = false;
                rows.push(`${vehicle}/${variant || '-'} ${view}: occluded ${r.frac} of ${r.reached} ${JSON.stringify(r.occluders)} · clutter ${r.fg.frac}`);
                const label = `${vehicle}/${variant} ${view}`;
                expect(r.reached, `${label}: the vehicle is in view at all`).toBeGreaterThan(20);
                expect(r.frac, `${label} hidden behind ${JSON.stringify(r.examples)}`).toBeLessThanOrEqual(OCCLUSION_LIMIT);
                if (view !== 'top') {
                    expect(r.fg.frac, `${label} foreground clutter ${JSON.stringify(r.fg.items)}`).toBeLessThanOrEqual(FOREGROUND_LIMIT);
                }
                if (FULL_STACK.has(view)) expectInFrame(r, label);
            }
        }
        console.log(rows.join('\n'));
        expect(errors).toEqual([]);
    });

    test('phone 390×844: the default view and Wide for every vehicle', async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const page = await ctx.newPage();
        const errors = await boot(page);
        for (const [vehicle, variant] of VEHICLES) {
            await page.evaluate(([v, vv]) => window.__lpVehicle3d.setVehicle(v, vv || undefined), [vehicle, variant]);
            // Auto: a new vehicle opens on the screen's own default preset.
            await page.evaluate(() => window.__lpVehicle3d.resetView());
            const auto = await measure(page, {});
            expect(auto.frac, `${vehicle} phone default: ${JSON.stringify(auto.examples)}`).toBeLessThanOrEqual(OCCLUSION_LIMIT);
            expect(auto.fg.frac, `${vehicle} phone default clutter: ${JSON.stringify(auto.fg.items)}`).toBeLessThanOrEqual(FOREGROUND_LIMIT);
            expectInFrame(auto, `${vehicle} phone default`);
            const wide = await measure(page, { view: 'wide' });
            expect(wide.frac, `${vehicle} phone wide: ${JSON.stringify(wide.examples)}`).toBeLessThanOrEqual(OCCLUSION_LIMIT);
            expect(wide.fg.frac, `${vehicle} phone wide clutter: ${JSON.stringify(wide.fg.items)}`).toBeLessThanOrEqual(FOREGROUND_LIMIT);
        }
        expect(errors).toEqual([]);
        await ctx.close();
    });

    // NEGATIVE CONTROL 1 — the clutter measure must see the tower bug.
    test('negative control: the pre-fix lightning-tower layout fails the default Falcon 9 view', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const clean = await measure(page, { vehicle: 'falcon9', variant: 'block5', view: 'threequarter' });
        expect(clean.fg.ok).toBe(true);
        const planted = await page.evaluate(() => {
            const pad = window.__lpVehicle3d.scene.getObjectByName('FalconTEL');
            // A lightning tower: a direct child group standing ~110 m out.
            const tower = pad.children.find((c) => c.isGroup && Math.abs(Math.hypot(c.position.x, c.position.z) - 110) < 1);
            if (!tower) return false;
            // Where all four stood before 2026-11-02: 70 m out on the diagonals.
            for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
                const old = tower.clone();
                old.name = 'OldLightningTower';
                old.position.set(sx * 70 * Math.SQRT1_2, 0, sz * 70 * Math.SQRT1_2);
                pad.add(old);
            }
            return true;
        });
        expect(planted, 'found a lightning tower to clone').toBe(true);
        const bad = await measure(page, {});
        console.log('[negative control: towers]', JSON.stringify({ clutter: bad.fg.frac, items: bad.fg.items, occluded: bad.frac }));
        expect(bad.fg.ok, 'the planted towers must be caught').toBe(false);
        expect(bad.fg.items.map((i) => i.name)).toContain('OldLightningTower');
    });

    // NEGATIVE CONTROL 2 — the occlusion measure must see a wall in the way.
    test('negative control: a block on the camera→rocket line fails occlusion', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const clean = await measure(page, { vehicle: 'falcon9', variant: 'block5', view: 'threequarter' });
        expect(clean.ok).toBe(true);
        await page.evaluate(() => {
            const a = window.__lpVehicle3d;
            const pad = a.scene.getObjectByName('FalconTEL');
            // Re-use the pad deck (a solid box) as the wall: 4× taller, half
            // way along the camera→target line.
            const deck = pad.children.find((c) => c.isMesh && c.geometry?.parameters?.width === 22);
            const wall = deck.clone();
            wall.name = 'Wall';
            const [cx, , cz] = a.renderStats.cameraPos, [tx, ty, tz] = a.renderStats.target;
            wall.position.set((cx + tx) / 2, ty, (cz + tz) / 2);
            wall.scale.set(0.6, 6, 0.6);
            pad.add(wall);
        });
        const bad = await measure(page, {});
        console.log('[negative control: wall]', JSON.stringify({ occluded: bad.frac, occluders: bad.occluders }));
        expect(bad.ok, 'the wall must be caught').toBe(false);
    });
});
