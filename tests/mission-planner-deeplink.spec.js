import { test, expect } from '@playwright/test';

/**
 * mission-planner-deeplink.spec.js — moon.html's "Fly it in the mission
 * planner" link lands with the origin / pad / destination preselected, the
 * parking inclination follows the pad, and the colony shortlist is in the
 * Moon-origin pad list. Unknown ids are ignored. Live feeds are not needed
 * for the selects to populate.
 */

test.use({
    launchOptions: { args: ['--ignore-certificate-errors', '--allow-insecure-localhost'] },
    ignoreHTTPSErrors: true,
});

test('deep link preselects pad + target and the colony bases exist', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto('/mission-planner.html?origin=earth&target=moon&pad=kourou');
    await expect.poll(() => page.evaluate(() => window.__mpDeepLink?.pad), { timeout: 30_000 }).toBe('kourou');
    expect(await page.evaluate(() => window.__mpDeepLink)).toEqual({ origin: 'earth', pad: 'kourou', target: 'moon' });
    expect(await page.locator('#mp-site').inputValue()).toBe('kourou');
    expect(await page.locator('#mp-target').inputValue()).toBe('moon');
    expect(Math.abs(Number(await page.locator('#mp-park-inc').inputValue()) - 5.236)).toBeLessThan(0.3);   // slider step 0.5°

    // Moon origin: the colony shortlist is among the pads
    await page.click('[data-body="moon"]');
    const moonPads = await page.locator('#mp-site option').allTextContents();
    expect(moonPads.filter(t => t.startsWith('Colony ·')).length).toBe(3);

    // Unknown ids are ignored, never guessed
    await page.goto('/mission-planner.html?origin=earth&pad=nope&target=nowhere');
    await expect.poll(() => page.evaluate(() => window.__mpDeepLink?.origin), { timeout: 30_000 }).toBe('earth');
    const dl = await page.evaluate(() => window.__mpDeepLink);
    expect(dl.pad).toBe('ksc');
    expect(dl.target).not.toBe('nowhere');
    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
});
