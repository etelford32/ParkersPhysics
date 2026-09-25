/**
 * satellites-passes.spec.js — the satellite panel's pass list renders.
 * ═══════════════════════════════════════════════════════════════════════════
 * satellites.html → search a satellite → _selectByTle → _updateAnalytics,
 * whose "Pass predictions" block runs only when a location is saved. It used
 * to hand predictPasses an inline propagator that referenced TWOPI /
 * MIN_PER_DAY / DEG2RAD (private to js/satellite-tracker.js), so for every
 * visitor WITH a location the list threw a ReferenceError and stayed empty.
 * Visitors without a location never reached the code — which is how it hid.
 *
 * CelesTrak is served from tests/fixtures/climate-lab-mocks.mjs (every other
 * third-party host aborted; CI has no outbound network). The pass NUMBERS are
 * pinned in Node by tests/orbital-analytics-passes.mjs; this pins the wiring.
 */
import { test, expect } from '@playwright/test';
import { installLabMocks } from './fixtures/climate-lab-mocks.mjs';

test.describe.configure({ timeout: 120_000 });

async function openAndTrackIss(page, location) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installLabMocks(page);
    await page.addInitScript((loc) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('pp_tour_completed', '1');
        if (loc) localStorage.setItem('ppx_user_location', JSON.stringify(loc));
        else localStorage.removeItem('ppx_user_location');
    }, location);
    await page.goto('/satellites.html', { waitUntil: 'domcontentloaded' });
    await page.locator('#sp-search-input').fill('25544');
    await page.locator('#sp-search-btn').click();
    await expect(page.locator('#sp-search-result')).toContainText('ISS', { timeout: 60_000 });
    return errors;
}

test('with a saved location, the ISS pass list renders (no ReferenceError)', async ({ page }) => {
    const errors = await openAndTrackIss(page, { lat: 40.015, lon: -105.271, city: 'Boulder, CO' });
    const passes = page.locator('#sp-passes');
    await expect(passes).toContainText(/\d+ min, max elev \d/, { timeout: 30_000 });
    const rows = await passes.locator('div').allTextContents();
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
        const min = Number(r.match(/(\d+) min/)[1]);
        expect(min, r).toBeGreaterThanOrEqual(1);
        expect(min, r).toBeLessThanOrEqual(10);
    }
    expect(errors.filter((e) => /ReferenceError|is not defined/.test(e)), errors.join('\n')).toEqual([]);
});

test('without a location, the panel asks for one instead', async ({ page }) => {
    await openAndTrackIss(page, null);
    await expect(page.locator('#sp-passes')).toContainText('Set location', { timeout: 30_000 });
});
