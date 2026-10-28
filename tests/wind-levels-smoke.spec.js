import { test, expect } from '@playwright/test';

/**
 * wind-levels-smoke.spec.js — Phase-1 pressure-level wind layers.
 *
 * Runs without live network (the sandbox blocks Open-Meteo; the layers must
 * degrade to their fetching/error pips without throwing). Asserts:
 *   1. earth.html boots with the three new level checkboxes present and the
 *      jet checkbox relabelled to the real 250 hPa layer.
 *   2. Toggling every level on produces no page errors (lazy instance
 *      creation, feed start, governor cap all execute).
 *   3. Per-level legend rows follow the dead-chrome rule: hidden until the
 *      level is enabled, visible after.
 *   4. The surface wind layer still boots checked (default view unchanged).
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test.describe.configure({ timeout: 180_000 });

test('pressure-level wind layers boot, toggle, and legend without errors', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message + '\n' + (err.stack ?? '')));

    // Wait for the page MODULE, not the load event: `load` waits on the
    // egress-blocked CDN texture requests to time out (74–97 s measured on
    // the sandbox, 2026-10-28), which is longer than the test budget and
    // says nothing about the layers under test.
    await page.goto('/earth.html', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof window.__evWindStack === 'function', null, { timeout: 120_000 });
    await page.waitForTimeout(2000);   // first frames render

    // 1. New layer rows exist; jet row is the real 250 hPa layer now.
    await expect(page.locator('#lyr-wind-850')).toHaveCount(1);
    await expect(page.locator('#lyr-wind-500')).toHaveCount(1);
    await expect(page.locator('label[for="lyr-jet"]')).toContainText('250 hPa');

    // 4. Surface layer default unchanged.
    await expect(page.locator('#lyr-wind')).toBeChecked();

    // 3. Legend rows exist and start hidden.
    for (const key of ['w850', 'w500', 'jet']) {
        await expect(page.locator(`#wx-windlvl-legend-${key}`)).toBeHidden();
    }

    // 2. Toggle every level on (checkboxes may sit in a collapsed panel —
    // drive the change event directly, which is what the UI wiring listens
    // to, rather than fighting the layout for a click target).
    for (const id of ['lyr-wind-850', 'lyr-wind-500', 'lyr-jet']) {
        await page.evaluate((elId) => {
            const el = document.getElementById(elId);
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, id);
        await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1500);   // lazy instances + (failing) feed start

    for (const key of ['w850', 'w500', 'jet']) {
        await expect(page.locator(`#wx-windlvl-legend-${key}`)).toBeVisible();
    }

    // Toggling back off re-hides the legend rows.
    await page.evaluate(() => {
        const el = document.getElementById('lyr-wind-850');
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#wx-windlvl-legend-w850')).toBeHidden();

    if (pageErrors.length) {
        console.log('=== PAGE ERRORS ===');
        for (const e of pageErrors) console.log(e);
    }
    expect(pageErrors, pageErrors.join('\n---\n')).toHaveLength(0);
});
