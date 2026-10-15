// Browser gate for sample-fleet-assessment.html: the sample sections render
// from the committed bake, and the interactive simulator (js/fleet-storm-sim.js)
// runs the real NRLMSISE-00 WASM in the page and hands a summary to the
// request-access form. No network beyond the dev server.
import { test, expect } from '@playwright/test';

const TLE = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0  30777-3 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;

test.describe('Sample fleet assessment + simulator', () => {
    test('sample sections render from the bake', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('/sample-fleet-assessment.html', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__sampleAssessment && window.__fleetSim);
        await expect(page.locator('#sa-table tbody tr')).toHaveCount(8);
        await expect(page.locator('#sa-gannon-chart svg')).toBeVisible();
        await expect(page.locator('#sa-starlink-chart svg')).toBeVisible();
        await expect(page.locator('[data-sim="storms"] input')).toHaveCount(5);
        expect(errors).toEqual([]);
    });

    test('builder run → results → summary prefills the request form', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('/sample-fleet-assessment.html#simulate', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__fleetSim);

        await page.locator('[data-sim="add"]').click();
        await expect(page.locator('.sim-row')).toHaveCount(4);
        await page.locator('.sim-row').nth(3).locator('input[data-f="altKm"]').fill('380');
        await page.locator('input[name="sim-storm"][value="halloween"]').check();
        await page.locator('[data-sim="run"]').click();

        await expect(page.locator('[data-sim="status"]')).toContainText(/Done in/, { timeout: 45_000 });
        await expect(page.locator('[data-sim="results"]')).toBeVisible();
        await expect(page.locator('[data-sim="table"] tbody tr')).toHaveCount(4);
        await expect(page.locator('[data-sim="bars"] svg')).toBeVisible();
        await expect(page.locator('[data-sim="ap-caption"]')).toContainText('peak Ap 400');
        // Physics sanity: the lowest satellite loses the most altitude.
        const losses = await page.evaluate(() => window.__fleetSim.state.last.results.map(r => [r.perigeeKm, r.e.extraLossKm]));
        const lowest = losses.reduce((a, b) => (b[0] < a[0] ? b : a));
        expect(Math.max(...losses.map(l => l[1]))).toBe(lowest[1]);

        await page.locator('[data-sim="cta"]').click();
        await page.waitForURL(/request-access\.html/);
        await expect(page.locator('#ra-message')).toHaveValue(/From the fleet simulator .*Halloween/s);
        await expect(page.locator('input[value="satellite_operations"]')).toBeChecked();
        expect(errors).toEqual([]);
    });

    test('pasted TLEs run, and garbage is reported rather than run', async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto('/sample-fleet-assessment.html#simulate', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__fleetSim);
        await page.locator('[data-sim-tab="paste"]').click();
        await page.locator('[data-sim="tle"]').fill('not a tle');
        await page.locator('[data-sim="run"]').click();
        await expect(page.locator('[data-sim="status"]')).toHaveClass(/err/);

        await page.locator('[data-sim="tle"]').fill(TLE);
        await expect(page.locator('[data-sim="tle-note"]')).toHaveText(/1 satellite read/);
        await page.locator('[data-sim="run"]').click();
        await expect(page.locator('[data-sim="status"]')).toContainText(/Done in/, { timeout: 45_000 });
        await expect(page.locator('[data-sim="table"] tbody')).toContainText('ISS (ZARYA)');
        await expect(page.locator('[data-sim="table"] tbody')).toContainText('TLE B*');
    });
});
