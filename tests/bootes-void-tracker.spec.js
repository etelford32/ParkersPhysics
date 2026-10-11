/**
 * bootes-void-tracker.spec.js — browser gate for the galaxy tracker on
 * bootes-void.html.
 *
 * Run: npx playwright test tests/bootes-void-tracker.spec.js
 *
 * The physics is pinned in node (tests/bootes-void-tracker.mjs) and the DOM
 * contract statically (tests/bootes-void-page.mjs). This gate checks what only
 * a browser can: that the tracker boots tracking a galaxy, that scrubbing time
 * moves the readouts the way the scalings say AND moves the stage, that the
 * observed epoch puts the stage back EXACTLY (every other readout on the page
 * is an observed-epoch claim about that picture), and the add / pick / play /
 * re-roll paths. No network, same as the page's smoke spec.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/bootes-void.html';

async function ready(page) {
    await page.goto(PAGE);
    await page.waitForFunction(
        () => document.querySelector('#bv-track-card')?.dataset.trackReady === '1',
        null, { timeout: 25000 });
}

const text = (page, key) => page.locator(`[data-bv="${key}"]`).first().textContent();
const rows = (page) => page.locator('#bv-track-rows tr').count();
const factor = async (page, key) => Number((await text(page, key)).replace('×', '').trim());

/** The tracer field's drawn positions, as a plain array. */
const tracerPositions = (page) => page.evaluate(() => {
    const pts = window.__bootesLab.scene.groups.tracers.children[0];
    return Array.from(pts.geometry.getAttribute('position').array.slice(0, 300));
});

test.describe('Boötes Void — galaxy tracker', () => {
    test('boots tracking the deepest void galaxy, with every readout and chart filled', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await ready(page);
        expect(await rows(page)).toBe(1);
        for (const key of ['trackTime', 'trackEpoch', 'trackGrowth', 'trackGScale', 'trackVScale', 'trackLinear']) {
            expect((await text(page, key)).trim(), key).not.toBe('—');
        }
        // Booted at the observed epoch: every scaling is exactly 1.
        expect(await factor(page, 'trackGrowth')).toBe(1);
        expect(await factor(page, 'trackGScale')).toBe(1);
        for (const key of ['trackG', 'trackV', 'trackR']) {
            const painted = await page.evaluate((k) => {
                const c = document.querySelector(`[data-bv-chart="${k}"]`);
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
                return n;
            }, key);
            expect(painted, key).toBeGreaterThan(500);
        }
        // The tracked galaxy really is inside the void.
        const r = await page.evaluate(() => Math.hypot(...window.__bootesLab.tracker.state.tracked[0].xObsMpc));
        const rEff = await page.evaluate(() => window.__bootesLab.derived.profile.params.rvMpc);
        expect(r).toBeLessThan(rEff);
        expect(errors).toEqual([]);
    });

    test('scrubbing back in time follows the linear-theory scalings and moves the stage', async ({ page }) => {
        await ready(page);
        const base = await tracerPositions(page);
        const g0 = Number((await page.locator('#bv-track-rows tr td').nth(2).textContent()).trim());

        await page.evaluate(() => window.__bootesLab.tracker.setTime(3));
        await expect.poll(() => page.locator('#bv-track-card').getAttribute('data-track-t')).toBe('3.0000');
        // Shallower void, slower outflow — and a STRONGER pull.
        expect(await factor(page, 'trackGrowth')).toBeLessThan(1);
        expect(await factor(page, 'trackVScale')).toBeLessThan(1);
        expect(await factor(page, 'trackGScale')).toBeGreaterThan(1);
        const gEarly = Number((await page.locator('#bv-track-rows tr td').nth(2).textContent()).trim());
        expect(gEarly).toBeGreaterThan(g0);

        // The field moved.
        const moved = await tracerPositions(page);
        let delta = 0;
        for (let i = 0; i < base.length; i++) delta = Math.max(delta, Math.abs(moved[i] - base[i]));
        expect(delta).toBeGreaterThan(1e-3);

        // And the observed epoch restores it EXACTLY.
        await page.click('#bv-track-obs');
        await expect.poll(async () => {
            const back = await tracerPositions(page);
            return back.every((v, i) => v === base[i]);
        }).toBe(true);
        expect(await factor(page, 'trackGScale')).toBe(1);
    });

    test('"move every galaxy" off leaves the field at the observed epoch', async ({ page }) => {
        await ready(page);
        const base = await tracerPositions(page);
        await page.locator('[data-bv-track="animate"]').uncheck();
        await page.evaluate(() => window.__bootesLab.tracker.setTime(3));
        await expect.poll(() => page.locator('#bv-track-card').getAttribute('data-track-t')).toBe('3.0000');
        const now = await tracerPositions(page);
        expect(now.every((v, i) => v === base[i])).toBe(true);
    });

    test('add buttons, the three-galaxy cap, remove and clear', async ({ page }) => {
        await ready(page);
        await page.click('#bv-track-add-deep');
        await page.click('#bv-track-add-probe');
        expect(await rows(page)).toBe(3);
        await page.click('#bv-track-add-random');
        expect(await rows(page)).toBe(3);                // oldest dropped, cap holds
        const colors = await page.evaluate(() => window.__bootesLab.tracker.state.tracked.map(t => t.color));
        expect(new Set(colors).size).toBe(3);            // one colour per galaxy
        await page.locator('#bv-track-rows tr').first().locator('button[title^="Stop"]').click();
        expect(await rows(page)).toBe(2);
        await page.click('#bv-track-clear');
        expect(await rows(page)).toBe(0);
        await expect(page.locator('[data-bv="trackLinear"]').first()).toContainText('Nothing tracked');
    });

    test('the pick tool adds the galaxy under a tap and disarms the probe tool', async ({ page }) => {
        await ready(page);
        await page.evaluate(() => {
            document.querySelector('.bv-stage-grid').scrollIntoView({ block: 'center' });
            const rot = document.querySelector('[data-bv-control="autorotate"]');
            if (rot.checked) rot.click();
        });
        await page.click('#bv-probe-tool');
        await page.click('#bv-track-pick');
        await expect(page.locator('#bv-track-pick')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#bv-probe-tool')).toHaveAttribute('aria-pressed', 'false');
        // Clicking the button scrolled the card into view; bring the stage back.
        await page.evaluate(() => document.querySelector('.bv-stage-grid').scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(600);
        // A tracer inside the void that projects onto the canvas.
        const target = await page.evaluate(() => {
            const lab = window.__bootesLab;
            const rect = document.querySelector('#bv-stage').getBoundingClientRect();
            const rEff = lab.derived.profile.params.rvMpc;
            for (const t of lab.derived.tracers) {
                if (t.radiusMpc > rEff * 0.6) continue;
                const s = lab.scene.screenOfMpc(t.offsetMpc);
                // The canvas must be the TOP element there: HUD chips and the
                // page's privacy banner sit over parts of the stage.
                if (!s.behind && s.x > rect.left + 60 && s.x < rect.right - 60
                    && s.y > rect.top + 80 && s.y < rect.bottom - 80
                    && document.elementFromPoint(s.x, s.y)?.id === 'bv-stage') return s;
            }
            return null;
        });
        expect(target).not.toBeNull();
        const before = await rows(page);
        await page.mouse.click(target.x, target.y);
        await expect.poll(() => rows(page)).toBe(Math.min(3, before + 1));
    });

    test('play advances cosmic time', async ({ page }) => {
        await ready(page);
        const t0 = Number(await page.locator('#bv-track-card').getAttribute('data-track-t'));
        await page.click('#bv-track-play');
        await expect(page.locator('#bv-track-play')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(async () => Number(await page.locator('#bv-track-card').getAttribute('data-track-t')),
            { timeout: 8000 }).toBeGreaterThan(t0 + 0.2);
        await page.click('#bv-track-play');
        await expect(page.locator('#bv-track-play')).toHaveAttribute('aria-pressed', 'false');
    });

    test('re-rolling the web re-tracks each galaxy from the same observed point', async ({ page }) => {
        await ready(page);
        const before = await page.evaluate(() => window.__bootesLab.tracker.state.tracked[0].xObsMpc);
        await page.click('#bv-reroll');
        await expect(page.locator('#bv-track-rows tr').first()).toContainText('re-tracked', { timeout: 10000 });
        const after = await page.evaluate(() => window.__bootesLab.tracker.state.tracked[0].xObsMpc);
        expect(after).toEqual(before);
    });
});
