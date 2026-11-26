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
    // seafloor today on the shared ocean-age ramp: green is below red at every stop of it, while
    // the continental crust is sage (green above red) — the land colour was chosen off the ramp
    expect(g0).toBeLessThan(r0 - 10);
    // at 200 Ma the spot is continent (Pangaea) or destroyed crust — never that seafloor
    expect(g1 > r1 || Math.max(r1, g1, b1) < 70).toBe(true);
    expect(Math.hypot(r1 - r0, g1 - g0, b1 - b0)).toBeGreaterThan(60);
});

test('a deep link selects Chicxulub at 66 Ma with the kernel\'s position', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await boot(page, '?age=66.04&at=21.3333,-89.5&second=0');     // the first model alone
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

test('the second model loads after the first frame, compares, and can be turned off', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await boot(page, '?age=66.04&at=21.3333,-89.5');
    await page.waitForFunction(() => window.__deepTime.S.secondState === 'on', null, { timeout: 90_000 });
    await expect(page.locator('#dte-spread')).toContainText('median');
    await expect(page.locator('#dte-spread')).toContainText('no latitude is changed');
    const body = page.locator('#dte-point-body');
    await expect(body).toContainText('Second model');
    await expect(body).toContainText('25.0°N');                       // Merdith's crater latitude at 66 Ma
    await expect(body).toContainText('3.0° of latitude');
    await expect(page.locator('#dte-chart svg path')).toHaveCount(2);   // both tracks on one axis
    const g = await page.evaluate(() => ({ ghost: window.__deepTime.globe.drawn.ghostPlates, shift: window.__deepTime.globe.drawn.ghostShiftDeg, has: window.__deepTime.globe.hasSecondModel }));
    expect(g.has).toBe(true);
    expect(g.ghost).toBeGreaterThan(50);
    expect(Math.abs(g.shift)).toBeGreaterThan(5);                      // the alignment is applied to the drawing
    await page.locator('#dte-second').uncheck();
    await expect(body).not.toContainText('Second model');
    await expect(page.locator('#dte-chart svg path')).toHaveCount(1);
    expect(await page.evaluate(() => window.__deepTime.globe.hasSecondModel)).toBe(false);
    await expect(page.locator('#dte-spread')).toHaveText('');
    expect(errors).toEqual([]);
});

test('?second=0 fetches nothing of the second model; a failed second model leaves the first working', async ({ page }) => {
    test.setTimeout(150_000);
    const asked = [];
    page.on('request', (r) => { if (/merdith2021/.test(r.url())) asked.push(r.url()); });
    await boot(page, '?second=0&age=66');
    await page.waitForTimeout(1500);
    expect(asked).toEqual([]);
    await expect(page.locator('#dte-second')).not.toBeChecked();

    const p2 = await page.context().newPage();
    await p2.route(/merdith2021-plates\.json/, (r) => r.fulfill({ status: 503, body: 'down' }));
    const errs = [];
    p2.on('pageerror', (e) => errs.push(String(e)));
    await p2.goto('/deep-time-earth.html?age=66&at=51.51,-0.13');
    await p2.waitForFunction(() => window.__deepTime && window.__deepTime.S.secondState === 'failed', null, { timeout: 90_000 });
    await expect(p2.locator('#dte-spread')).toContainText('could not be loaded');
    await expect(p2.locator('#dte-point-body')).toContainText('England');     // the first model still answers
    expect(errs).toEqual([]);
});

test('the seafloor is coloured from the Seton 2020 grid; without it the model\'s isochrons stand in and the legend says so', async ({ page }) => {
    test.setTimeout(200_000);
    await boot(page, '?second=0');
    await page.waitForFunction(() => window.__deepTime.globe.hasSeafloorGrid, null, { timeout: 60_000 });
    const k = await page.evaluate(() => {
        const g = window.__deepTime.globe; g.setAge(0); const d0 = { ...g.drawn }; g.setAge(100);
        return { d0, d100: { ...g.drawn }, src: document.getElementById('dte-seafloor-src').textContent };
    });
    // today most seafloor vertices sit on present-day ocean floor of the grid; at 100 Ma more of it has since been subducted
    expect(k.d0.seafloorFromGrid).toBeGreaterThan(k.d0.seafloorFromBins);
    expect(k.d100.seafloorFromGrid).toBeLessThan(k.d0.seafloorFromGrid + k.d0.seafloorFromBins);
    expect(k.src).toContain('Seton');
    // the grid also brings back surviving floor the model's bins start late (the Cretaceous quiet zone)
    const cov = await page.evaluate(() => {
        const { globe, S } = window.__deepTime;
        const withGrid = globe.coveredFraction(100), ext = globe.drawn.seafloorExtended;
        globe.setSeafloorGrid(null); const without = globe.coveredFraction(100);
        globe.setSeafloorGrid(S.seafloor);
        return { withGrid, without, ext };
    });
    expect(cov.ext).toBeGreaterThan(1000);
    expect(cov.withGrid).toBeGreaterThan(cov.without + 0.01);
    // the point panel names the grid for an ocean point
    await page.evaluate(() => { window.__deepTime.setAge(0); window.__deepTime.selectPresent(0.0, -24.5, null); });
    await expect(page.locator('#dte-point-body')).toContainText('Seton et al. 2020 age grid');

    // negative control: the grid 404s
    const p2 = await page.context().newPage();
    await p2.route(/data\/earth-interior\/seafloor-age/, (r) => r.fulfill({ status: 404, body: '' }));
    await p2.goto('/deep-time-earth.html?second=0');
    await p2.waitForFunction(() => window.__deepTime && /isochron bins/.test(document.getElementById('dte-seafloor-src').textContent), null, { timeout: 90_000 });
    const n = await p2.evaluate(() => ({ grid: window.__deepTime.globe.hasSeafloorGrid, d: { ...window.__deepTime.globe.drawn } }));
    expect(n.grid).toBe(false);
    expect(n.d.seafloorFromGrid).toBe(0);
});
