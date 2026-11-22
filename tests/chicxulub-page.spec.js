// chicxulub-page.spec.js — browser gate for chicxulub.html
//   npx playwright test tests/chicxulub-page.spec.js
// The page has no feeds: everything it draws comes from js/chicxulub/*.
import { test, expect } from '@playwright/test';

const NOISE = /supabase|Failed to load resource|ERR_|net::|favicon/i;

async function boot(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
    await page.goto('/chicxulub.html');
    await page.waitForFunction(() => window.__chicxulub);
    await page.addStyleTag({ content: '.pp-consent-banner{display:none!important}' });
    return errors;
}

test('renders the reconstruction from the kernels, with no errors', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#chx-tiles .chx-tile')).toHaveCount(7);
    const k = await page.evaluate(() => {
        const c = window.__chicxulub;
        return { d: c.base.diameterKm.med, v: c.base.speedKms.med, rows: c.O.allRows().length };
    });
    await expect(page.locator('#chx-tiles .chx-tile').first()).toContainText(`${Math.round(k.d)} km`);
    await expect(page.locator('#chx-evidence tbody tr:not(.grp)')).toHaveCount(k.rows);
    // both provenance badges are on the page — nothing silently promoted
    expect(await page.locator('#chx-evidence .chx-badge.ok').count()).toBeGreaterThan(20);
    expect(await page.locator('#chx-evidence .chx-badge.no').count()).toBeGreaterThan(5);
    await expect(page.locator('#chx-orbit svg path')).toHaveCount(1);
    await expect(page.locator('#chx-hours rect[data-hr]')).toHaveCount(48);
    await expect(page.locator('#chx-ejecta svg')).toBeVisible();
    await expect(page.locator('#chx-climate svg')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('the evidence switch changes the answer; all-iridium needs comet speed', async ({ page }) => {
    await boot(page);
    const kv = page.locator('#chx-post-kv');
    const before = await kv.innerText();
    await page.locator('#chx-scenario button[data-v="all-iridium"]').click();
    await expect(kv).not.toHaveText(before);
    await expect(kv).toContainText('all of it (imposed)');
    await expect(page.locator('#chx-post-note')).toContainText('comet');
    await page.locator('#chx-scenario button[data-v="asteroid"]').click();
    await page.locator('#chx-rim button[data-v="190"]').click();
    const d190 = await page.evaluate(() => window.__chicxulub.R.reconstructImpactor({ scenario: 'asteroid', craterKm: 190 }).diameterKm.med);
    await expect(kv).toContainText(`${d190.toFixed(1)} km`);
});

test('trajectory: picking an hour redraws the orbit; a slow arrival constrains nothing', async ({ page }) => {
    await boot(page);
    const kv = page.locator('#chx-orbit-kv');
    const before = await kv.innerText();
    await page.locator('#chx-hours rect[data-hr="15"]').click();
    await expect(page.locator('#chx-hr-o')).toHaveText('15:00');
    await expect(kv).not.toHaveText(before);
    await page.locator('#chx-v').fill('12');
    await expect(page.locator('#chx-traj-note')).toContainText('every hour of the day');
});

test('distance slider reorders the timeline; phone width does not overflow', async ({ page }) => {
    await boot(page);
    await page.locator('#chx-r').fill('0.1');
    const near = await page.locator('#chx-timeline').innerText();
    await page.locator('#chx-r').fill('0.95');
    const far = await page.locator('#chx-timeline').innerText();
    expect(far).not.toEqual(near);
    expect(far).toContain('below the horizon');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
