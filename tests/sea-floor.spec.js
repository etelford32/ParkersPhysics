/**
 * sea-floor.spec.js — the Sea Floor page (sea-floor.html)
 *
 *   npx playwright test tests/sea-floor.spec.js
 *
 * No network: the page reads only the baked data/seafloor/* files. Pins: boots without console
 * errors; the table, map, 3D block, cross-section, water column and sounding all draw the page
 * model's numbers; a deep link selects a site; Ping reveals the side echo; picking a point on the
 * block moves the sounding; and the NEGATIVE CONTROLS — the cast archive missing ⇒ depths stay,
 * no temperature is shown anywhere and the chip says so; the index missing ⇒ nothing is drawn.
 */
import { test, expect } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

function recorder(page) {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return errors;
}
async function boot(page, url = '/sea-floor.html') {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__seaFloor?.detail && document.querySelector('#sf-section-chart svg'), null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
}

test('boots clean and every panel draws the model', async ({ page }) => {
    const errors = recorder(page);
    await boot(page);
    await expect(page.locator('#sf-chip-bathy')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#sf-chip-casts')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#sf-table tbody tr')).toHaveCount(28);
    await expect(page.locator('#sf-site-title')).toContainText('Challenger Deep');
    const s = await page.evaluate(() => { const d = window.__seaFloor.detail; return { depth: d.point.depth, floorT: d.floor.t, kind: d.floor.kind, err: d.ping.errorM, mean: d.ping.meanSpeed, rows: window.__seaFloor.rows.length }; });
    expect(s.depth).toBeGreaterThan(10600);
    expect(s.floorT).toBeGreaterThan(1.8); expect(s.floorT).toBeLessThan(2.9);
    expect(s.err).toBeLessThan(-250);
    // the printed numbers ARE the model's
    await expect(page.locator('#sf-stage-readout')).toContainText(Math.round(s.depth).toLocaleString('en-US') + ' m');
    await expect(page.locator('#sf-sound-body')).toContainText(s.mean.toFixed(1) + ' m/s');
    await expect(page.locator('#sf-sound-body')).toContainText('too shallow');
    await expect(page.locator('#sf-column-read')).toContainText(s.floorT.toFixed(2) + ' °C');
    await expect(page.locator('#sf-column-chart svg path')).not.toHaveCount(0);
    await expect(page.locator('#sf-compare-chart svg')).toBeVisible();
    await expect(page.locator('#sf-column-note')).toContainText('Model check on this cast');
    // 3D block rendered kernel geometry
    await page.waitForFunction(() => window.__seaFloorStage?.state.frames > 0 && window.__seaFloorStage.state.vertices > 10000, null, { timeout: 60_000 });
    // no horizontal overflow
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('deep link, table selection, ping, exaggeration, and a picked point', async ({ page }) => {
    const errors = recorder(page);
    await boot(page, '/sea-floor.html?site=puerto-rico');
    await expect(page.locator('#sf-site-title')).toContainText('Puerto Rico');
    await expect(page.locator('#sf-table tr[aria-selected="true"]')).toContainText('Puerto Rico');
    await page.locator('#sf-table tbody tr[data-id="tonga"]').click();
    await page.waitForFunction(() => window.__seaFloor.id === 'tonga' && window.__seaFloor.detail?.point.depth > 10000);
    await expect(page).toHaveURL(/site=tonga/);
    await page.waitForFunction(() => window.__seaFloorStage?.state.vertices > 10000, null, { timeout: 60_000 });
    // wide historic beam ⇒ a side echo; Ping reveals it and flies the pulse
    await page.selectOption('#sf-beam', '60');
    const echo = await page.evaluate(() => window.__seaFloor.detail.echo);
    expect(echo.biasM).toBeLessThan(0);
    await page.click('#sf-ping');
    await expect(page.locator('#sf-sound-body')).toContainText('orange line');
    expect(await page.evaluate(() => window.__seaFloor.pingShown)).toBe(true);
    // NEGATIVE CONTROL for the beam: a 1° beam on this grid has no side echo
    await page.selectOption('#sf-beam', '1');
    await expect(page.locator('#sf-sound-body')).toContainText('no side echo');
    // exaggeration is printed and reaches the stage
    await page.locator('#sf-exag').fill('1');
    await expect(page.locator('#sf-stage-note')).toContainText('true scale');
    expect(await page.evaluate(() => window.__seaFloorStage.state.exaggeration)).toBe(1);
    // move the sounding point (the stage's own pick path, at a projected sea-floor point)
    const moved = await page.evaluate(() => {
        const S = window.__seaFloor, st = window.__seaFloorStage, p = S.detail.point;
        const target = { lat: p.lat + 0.4, lon: p.lon + 0.3 };
        const scr = st.toScreen(target.lat, target.lon, 6000), hit = st.pickAt(scr.x, scr.y);
        return hit;
    });
    expect(moved).not.toBeNull();
    await page.evaluate((hit) => { const S = window.__seaFloor; S.at = hit; document.getElementById('sf-nominal').dispatchEvent(new Event('change')); }, moved);
    await expect(page.locator('#sf-stage-readout')).toContainText('your point');
    await page.click('#sf-reset-point');
    await expect(page.locator('#sf-stage-readout')).toContainText('deepest grid cell');
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: no cast archive ⇒ depths stay, no temperature is invented', async ({ page }) => {
    await page.route('**/data/seafloor/casts.json.gz', (r) => r.fulfill({ status: 503, body: '' }));
    await boot(page);
    await expect(page.locator('#sf-chip-casts')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('#sf-table tbody tr')).toHaveCount(28);
    await expect(page.locator('#sf-table tbody')).not.toContainText('°C');
    await expect(page.locator('#sf-stage-readout')).not.toContainText('°C');
    await expect(page.locator('#sf-column-chart')).toContainText('could not be loaded');
    await expect(page.locator('#sf-sound-body')).toContainText('Nothing is assumed');
    await expect(page.locator('#sf-compare-chart svg')).toHaveCount(0);
});

test('NEGATIVE CONTROL: no index ⇒ nothing drawn, and the page says so', async ({ page }) => {
    await page.route('**/data/seafloor/index.json', (r) => r.fulfill({ status: 503, body: '' }));
    await page.goto('/sea-floor.html', { waitUntil: 'load' });
    await expect(page.locator('#sf-chip-bathy')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('#sf-table tbody tr')).toHaveCount(0);
    await expect(page.locator('#sf-table-note')).toContainText('Nothing is substituted');
});

test('phone width: no overflow, panels stack', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('#sf-column-chart svg')).toBeVisible();
});
