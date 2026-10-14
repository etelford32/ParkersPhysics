/**
 * bootes-void-probe.spec.js — browser gate for the force probe on bootes-void.html.
 *
 * Run: npx playwright test tests/bootes-void-probe.spec.js
 *
 * The probe's PHYSICS is pinned in node by tests/bootes-force-probe.mjs and its
 * DOM contract by tests/bootes-void-page.mjs. What only a browser can check is
 * the interaction: that Shift-drag moves the probe and NOT the camera (the
 * capture-phase listener has to beat OrbitControls, which would otherwise pan),
 * that a plain drag still orbits, that the armed tool hands the plain drag to
 * the probe and gives it back, and that every input path lands on one probe.
 *
 * NO NETWORK, same as the page's smoke spec.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/bootes-void.html';

async function ready(page) {
    await page.goto(PAGE);
    await page.waitForFunction(
        () => document.querySelector('#bv-probe-card')?.dataset.probeReady === '1',
        null, { timeout: 20000 });
}

/** Stage in view, auto-rotate off, focus released — see the smoke spec's note. */
async function stageReady(page) {
    await page.evaluate(() => {
        document.querySelector('.bv-stage-grid').scrollIntoView({ block: 'center' });
        const rot = document.querySelector('[data-bv-control="autorotate"]');
        if (rot.checked) rot.click();
        document.activeElement?.blur?.();
    });
    await page.waitForTimeout(500);
}

const probePos = (page) => page.evaluate(() => window.__bootesLab.probe.state.positionMpc);
const camPos = (page) => page.evaluate(() => window.__bootesLab.scene.camera.position.toArray());
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const text = (page, key) => page.locator(`[data-bv="${key}"]`).first().textContent();

/**
 * Wait until the camera has stopped moving. OrbitControls' damping keeps
 * easing for a while after auto-rotate is switched off or an orbit ends — on
 * a software rasteriser for well over a second — and a pose sampled inside
 * that tail reads as "the drag moved the camera" when nothing did.
 */
async function settle(page) {
    let prev = await camPos(page);
    // Damping decays geometrically PER FRAME, so on a loaded software
    // rasteriser reaching 1e-7 can take ~20 s. 1e-5 per 150 ms leaves a drift
    // of < 2e-4 over a whole drag — four orders below the 3.6-unit pan the
    // negative control produced (both stopImmediatePropagation calls removed).
    for (let i = 0; i < 80; i++) {
        await page.waitForTimeout(150);
        const next = await camPos(page);
        if (dist(prev, next) < 1e-5) return;
        prev = next;
    }
    throw new Error('camera never settled');
}


/** Drag across the stage from 40 % to 60 % of its width at mid-height. */
async function dragStage(page, { shift = false } = {}) {
    const box = await page.locator('#bv-stage').boundingBox();
    const y = box.y + box.height * 0.5;
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(box.x + box.width * 0.4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y + 20, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.6, y + 30, { steps: 6 });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(450);          // one rAF evaluation + damping tail
}

test.describe('Boötes Void — force probe', () => {
    test('boots with every row filled and its live identities holding', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await ready(page);
        for (const key of ['probeGVoid', 'probeGWeb', 'probeGA', 'probeVel', 'probeL1', 'probeTweb', 'probeStream']) {
            const t = (await text(page, key)).trim();
            expect(t, key).not.toBe('—');
            expect(t.length, key).toBeGreaterThan(0);
        }
        // "Σ structures − web 1e-15 · Σ shares − 1 2e-16 · tr T − δ 0" — every
        // residual printed on the page must be at round-off.
        const check = await text(page, 'probeCheck');
        const residuals = check.split('·').map(seg => Number(seg.trim().split(/\s+/).at(-1)));
        expect(residuals.length).toBeGreaterThanOrEqual(3);
        for (const r of residuals) {
            expect(Number.isFinite(r), check).toBe(true);
            expect(r).toBeLessThan(1e-9);
        }
        expect(await page.locator('#bv-probe-contrib li').count()).toBeGreaterThanOrEqual(3);
        // The ray chart has paint on it.
        const painted = await page.evaluate(() => {
            const c = document.querySelector('[data-bv-chart="probeRay"]');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        });
        expect(painted).toBeGreaterThan(500);
        expect(errors).toEqual([]);
    });

    test('Shift-drag moves the probe and leaves the camera alone', async ({ page }) => {
        await ready(page);
        await stageReady(page);
        await settle(page);
        const p0 = await probePos(page);
        const c0 = await camPos(page);
        await dragStage(page, { shift: true });
        const p1 = await probePos(page);
        const c1 = await camPos(page);
        expect(dist(p0, p1), 'the probe moved').toBeGreaterThan(5);
        // OrbitControls pans on Shift-drag; if the capture-phase listener ever
        // stops winning, the camera moves here and this fails.
        expect(dist(c0, c1), 'the camera did not').toBeLessThan(2e-3);
        // And the readout followed.
        const last = await page.evaluate(() => window.__bootesLab.probe.last.positionMpc);
        expect(dist(last, p1)).toBeLessThan(1e-9);
    });

    test('a plain drag orbits; the armed tool takes it over and gives it back', async ({ page }) => {
        await ready(page);
        await stageReady(page);

        // Plain drag → camera moves, probe does not.
        await settle(page);
        let p0 = await probePos(page);
        let c0 = await camPos(page);
        await dragStage(page);
        expect(dist(c0, await camPos(page)), 'plain drag orbits').toBeGreaterThan(0.05);
        expect(dist(p0, await probePos(page)), 'plain drag leaves the probe').toBeLessThan(1e-9);

        // Arm → plain drag moves the probe, not the camera.
        await page.click('#bv-probe-tool');
        await expect(page.locator('#bv-probe-tool')).toHaveAttribute('aria-pressed', 'true');
        await settle(page);                       // the plain drag's damping tail
        p0 = await probePos(page);
        c0 = await camPos(page);
        await dragStage(page);
        expect(dist(p0, await probePos(page)), 'armed drag moves the probe').toBeGreaterThan(5);
        expect(dist(c0, await camPos(page)), 'armed drag leaves the camera').toBeLessThan(2e-3);

        // Disarm → orbiting again.
        await page.click('#bv-probe-tool');
        await expect(page.locator('#bv-probe-tool')).toHaveAttribute('aria-pressed', 'false');
        p0 = await probePos(page);
        c0 = await camPos(page);
        await dragStage(page);
        expect(dist(c0, await camPos(page)), 'disarmed drag orbits again').toBeGreaterThan(0.05);
        expect(dist(p0, await probePos(page))).toBeLessThan(1e-9);
    });

    test('the jump list and the sliders place the probe', async ({ page }) => {
        await ready(page);
        await page.selectOption('[data-bv-probe="jump"]', 'centre');
        await expect(page.locator('[data-bv="probeGVoid"]').first()).toHaveText('0.00');
        await expect(page.locator('[data-bv="probeTwebSmooth"]').first()).toHaveText('void');
        // A void exerts nothing at its own centre, and its potential there is a HILL.
        expect((await text(page, 'probePhiVoid')).startsWith('+')).toBe(true);

        await page.locator('[data-bv-probe="r"]').evaluate((el) => {
            el.value = '1.5';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(page.locator('[data-bv="probePos"]').first()).toContainText('1.50 R_eff');
        const r = await page.evaluate(() => Math.hypot(...window.__bootesLab.probe.state.positionMpc)
            / window.__bootesLab.derived.profile.params.rvMpc);
        expect(r).toBeCloseTo(1.5, 6);
        // Outside the void the void term points OUTWARD — less pull, not a push.
        expect((await text(page, 'probeGVoidR')).startsWith('+')).toBe(true);

        // A catalogued cluster from the jump list lands on its measured position.
        const anchor = await page.evaluate(() => {
            const opt = [...document.querySelectorAll('[data-bv-probe="jump"] option')]
                .find(o => o.value.startsWith('anchor:'));
            return opt.value;
        });
        await page.selectOption('[data-bv-probe="jump"]', anchor);
        await page.waitForTimeout(200);
        const pos = await probePos(page);
        expect(Math.hypot(...pos)).toBeGreaterThan(10);
    });

    test('re-rolling the web moves the web rows and not the void rows', async ({ page }) => {
        await ready(page);
        const void0 = await text(page, 'probeGVoid');
        const web0 = await text(page, 'probeGWeb');
        await page.click('#bv-reroll');
        await expect.poll(() => text(page, 'probeGWeb'), { timeout: 8000 }).not.toBe(web0);
        expect(await text(page, 'probeGVoid')).toBe(void0);
    });

    test('a contributor\'s go button moves the probe onto that structure', async ({ page }) => {
        await ready(page);
        const target = await page.evaluate(() => window.__bootesLab.probe.last.contributors.top[1].positionMpc);
        await page.locator('#bv-probe-contrib li .bv-probe-go').nth(1).click();
        await expect.poll(async () => dist(await probePos(page), target), { timeout: 4000 }).toBeLessThan(1e-6);
    });
});
