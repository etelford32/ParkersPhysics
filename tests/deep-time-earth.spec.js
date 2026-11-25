// deep-time-earth.spec.js — browser gate for deep-time-earth.html
//   npx playwright test tests/deep-time-earth.spec.js
// The page has no feeds: it draws the baked plate model (data/paleo/) through
// js/paleo/* (gated against pyGPlates in tests/paleo-rotations.mjs).
import { test, expect } from '@playwright/test';

const NOISE = /supabase|Failed to load resource|ERR_|net::|favicon|GL Driver|GPU stall/i;

async function boot(page, q = '') {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
    await page.goto('/deep-time-earth.html' + q);
    await page.waitForFunction(() => window.__deepTime, null, { timeout: 90_000 });
    await page.addStyleTag({ content: '.pp-consent-banner{display:none!important}' });
    return errors;
}

test('boots, tiles today\'s surface, and loses crust going back', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await boot(page);
    const k = await page.evaluate(() => {
        const g = window.__deepTime.globe;
        return { stats: g.stats, now: g.coveredFraction(0), at100: g.coveredFraction(100), at200: g.coveredFraction(200) };
    });
    expect(k.stats.plates).toBeGreaterThan(350);
    // today the static polygons tile the sphere (small gaps/overlaps from simplification)
    expect(Math.abs(k.now - 1)).toBeLessThan(0.02);
    // going back, crust that formed later is not drawn: the drawn surface shrinks
    expect(k.at100).toBeLessThan(k.now - 0.15);
    expect(k.at200).toBeLessThan(k.at100);
    await expect(page.locator('#dte-check li')).toHaveCount(3);
    await expect(page.locator('#dte-check')).toContainText('pyGPlates 1.0.0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('the Atlantic is ocean today and not there at 200 Ma (pixels)', async ({ page }) => {
    test.setTimeout(150_000);
    await boot(page);
    // aim the camera at the central Atlantic today, read the centre pixel; then the same pixel at 200 Ma
    const px = await page.evaluate(async () => {
        const { globe, setAge } = window.__deepTime;
        globe.lookAt(25, -40);
        const c = document.getElementById('dte-globe').getBoundingClientRect();
        setAge(0); const now = globe.readPixel(c.width / 2, c.height / 2);
        setAge(200); const then = globe.readPixel(c.width / 2, c.height / 2);
        return { now, then };
    });
    const [r0, g0, b0] = px.now, [r1, g1, b1] = px.then;
    expect(b0).toBeGreaterThan(r0 + 40);                       // blue seafloor today
    // at 200 Ma the spot is continent (Pangaea) or destroyed crust — never young blue seafloor
    expect(b1).toBeLessThan(r1 + 20);
    expect(Math.hypot(r1 - r0, g1 - g0, b1 - b0)).toBeGreaterThan(60);
});

test('a deep link selects Chicxulub at 66 Ma with the kernel\'s position', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await boot(page, '?age=66.04&at=21.3333,-89.5');
    await expect(page.locator('#dte-when b')).toHaveText('66 million years ago');
    const body = page.locator('#dte-point-body');
    await expect(body).toContainText('Yucatan');
    await expect(body).toContainText('21.9°N 74.5°W');
    await expect(page.locator('#dte-chart svg path')).toHaveCount(1);
    // the crater's marker is drawn at 66 Ma and hidden before the crater existed
    await expect(page.locator('.dte-mark.crater')).toBeVisible();
    await page.evaluate(() => window.__deepTime.setAge(80));
    await page.waitForTimeout(300);
    await expect(page.locator('.dte-mark.crater')).toBeHidden();
    expect(errors).toEqual([]);
});

test('clicking young seafloor says it had not formed, never places it', async ({ page }) => {
    test.setTimeout(150_000);
    await boot(page);
    await page.evaluate(() => { window.__deepTime.selectPresent(0.5, -24.0, null); window.__deepTime.setAge(100); });
    await expect(page.locator('#dte-point-body')).toContainText('not there yet');
    // a real click on the globe picks a plate and fills the panel
    await page.evaluate(() => window.__deepTime.setAge(0));
    const box = await page.locator('#dte-globe').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#dte-point-body dl')).toBeVisible();
    await expect(page.locator('#dte-point-body')).toContainText('Plate');
});

test('play runs forward in time and stops at today', async ({ page }) => {
    test.setTimeout(150_000);
    await boot(page, '?age=12');
    await page.locator('#dte-play').click();
    await expect(page.locator('#dte-play')).toHaveText('Pause');
    await expect(page.locator('#dte-when b')).toHaveText('Today', { timeout: 60_000 });
    await expect(page.locator('#dte-play')).toHaveText('Play');
});
