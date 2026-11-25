/**
 * earth-interior-seafloor.spec.js — the ocean-floor age surface on Inner Earth's Plates view.
 *
 *   npx playwright test tests/earth-interior-seafloor.spec.js
 *
 * Every host but the page's own is aborted (the age grid, PB2002 and Slab2 are committed files).
 * Pins: the grid is NOT fetched before the Plates view opens; on "Surface: Seafloor age" the key
 * names Seton et al. (2020) and the panel prints the KERNEL's own numbers (mean age, area, the
 * Seton-vs-Müller median) — computed here again from the same kernel and compared; the globe's
 * overlay is the age ramp (a Pacific pixel differs between the two surfaces); and the CONTROL:
 * with the surface back on Plates the age key is gone and the overlay is the plate tint again.
 */
import { test, expect } from '@playwright/test';

test.describe('Inner Earth — seafloor age', () => {
    test.describe.configure({ timeout: 150_000 });

    test('age surface: lazy load, kernel numbers on the page, a different globe, and back', async ({ page }) => {
        const errors = [], fetched = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => { if (/data\/earth-interior\/seafloor-age/.test(r.url())) fetched.push(r.url()); });
        await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/earth-interior.html');
        await page.waitForFunction(() => document.querySelector('[data-view="plates"]') && document.querySelector('#ei-stage canvas'), null, { timeout: 60_000 });
        await page.waitForTimeout(4000);
        await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
        expect(fetched, 'the age grid must not load before the Plates view opens').toEqual([]);

        await page.click('[data-view="plates"]');
        await expect(page.locator('#ei-pstatus')).toContainText('PB2002 (Bird 2003)', { timeout: 60_000 });
        await expect(page.locator('#ei-ppanel')).toContainText('How old is the ocean floor?', { timeout: 60_000 });
        await expect(page.locator('#ei-ppanel')).toContainText('Oceanic crust covers', { timeout: 60_000 });

        // The panel's numbers are the kernel's: recompute them here from the same files.
        const k = await page.evaluate(async () => {
            const m = await import('/js/earth-interior/seafloor-age.js');
            const { grid } = await m.loadSeafloorAge();
            const A = m.areaAgeDistribution(grid);
            return { mean: Math.round(A.meanMyr), pct: Math.round(100 * A.globeFraction), mkm2: Math.round(A.oceanAreaKm2 / 1e6) };
        });
        const panel = await page.locator('#ei-ppanel').innerText();
        expect(panel).toContain(`covers ${k.pct} % of the planet (${k.mkm2} million km²)`);
        expect(panel).toContain(`mean age is ${k.mean} Myr`);
        expect(panel).toMatch(/disagree by a median \d+\.\d Myr/);

        // The surface: read the overlay texture the stage holds, at a mid-Pacific texel.
        const texel = () => page.evaluate(() => {
            const st = window.__earthInterior?.stage;
            const tex = st?.surfaceMat?.uniforms?.uOverlay?.value;
            if (!tex?.image?.data) return null;
            const { width: w, height: h, data } = tex.image;
            const r = Math.floor((90 + 20) / 180 * h), c = Math.floor((-150 + 180) / 360 * w);   // 20°S 150°W
            const k = 4 * (r * w + c);
            return { w, h, rgba: [data[k], data[k + 1], data[k + 2], data[k + 3]] };
        });
        await page.click('[data-psurface="age"]');
        await expect(page.locator('#ei-pkeys')).toContainText('Age of the ocean floor (Seton et al. 2020)');
        const age = await texel();
        await page.click('[data-psurface="plates"]');
        await expect(page.locator('#ei-pkeys')).not.toContainText('Age of the ocean floor');   // CONTROL
        const plates = await texel();
        expect(age, 'the stage overlay texture must be readable through window.__earthInterior.stage').not.toBeNull();
        expect(age.w).toBe(1800);
        expect(plates.w).not.toBe(1800);
        expect(age.rgba[3]).toBeGreaterThan(200);
        expect(Math.abs(age.rgba[0] - plates.rgba[0]) + Math.abs(age.rgba[1] - plates.rgba[1]) + Math.abs(age.rgba[2] - plates.rgba[2])).toBeGreaterThan(30);
        expect(fetched.length).toBeGreaterThan(0);
        expect(errors).toEqual([]);
    });
});
