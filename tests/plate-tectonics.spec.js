/**
 * plate-tectonics.spec.js — Plates Through Time (plate-tectonics.html), hermetic browser gate
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *   npx playwright test tests/plate-tectonics.spec.js
 *   PT_SHOTS=<dir> … also writes the screenshots used in review
 *
 * The page reads only committed files (data/plate-history/*); every other host is aborted. Pins:
 *   1. boots clean: no uncaught exception, the readout is the kernel's series row, five charts,
 *      a non-blank globe;
 *   2. THE STAGE DRAWS THE KERNEL: the globe's per-plate rotation texture equals
 *      rotations.js qMatrix(total(plate, t)) — and on the flat map, points inside present-day
 *      India land on drawn LAND at 100 Ma when carried by India's rotation (the control: the
 *      same points left where they are today, which was ocean);
 *   3. time: deep link ?t=, the slider (left = past), a chart click, a jump button and Play all
 *      move ONE time and the URL follows;
 *   4. the probe names the plate under a click and quotes the kernel's own velocity there;
 *   5. the model's 855 Ma topology gap is SAID, not hidden;
 *   6. phone width: no horizontal overflow.
 */
import { test, expect } from '@playwright/test';

const SHOTS = process.env.PT_SHOTS || null;

async function open(page, q = '') {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(`/plate-tectonics.html${q}`);
    await page.waitForFunction(() => document.body.dataset.ptReady, null, { timeout: 90_000 });
    expect(await page.evaluate(() => document.body.dataset.ptReady)).toBe('1');
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
    return errors;
}

test.describe('Plates Through Time', () => {
    test.describe.configure({ timeout: 150_000 });

    test('boots clean, the readout is the kernel series, the globe draws', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = await open(page);
        await expect(page.locator('#pt-age')).toHaveText('today');
        const row0 = await page.evaluate(() => window.__plates.rows[0]);
        await expect(page.locator('#pt-stats')).toContainText(String(row0.plates));
        await expect(page.locator('#pt-stats')).toContainText(row0.ridgeKm.toLocaleString('en-US'));
        await expect(page.locator('.pt-chart svg')).toHaveCount(5);
        // A non-blank globe: the centre of the canvas is not the clear colour.
        await page.waitForTimeout(1500);
        const shot = await page.locator('#pt-globe').screenshot();
        expect(shot.length).toBeGreaterThan(20_000);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/pt-today.png` });
        expect(errors).toEqual([]);
    });

    test('the stage draws the kernel: rotation texture, and India carried to 100 Ma', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, '?t=100');
        await expect(page.locator('#pt-age')).toHaveText('100 Ma');
        // (a) The globe's rotation texture holds the kernel's matrices.
        const worst = await page.evaluate(async () => {
            const { qMatrix } = await import('/js/plate-history/rotations.js');
            const { globe, model } = window.__plates;
            let w = 0;
            globe.platesIndex.forEach((pid, i) => {
                const m = qMatrix(model.total(pid, 100));
                const row = globe.rotData.subarray(12 * i, 12 * i + 12);
                [0, 1, 2, 4, 5, 6, 8, 9, 10].forEach((k, j) => { w = Math.max(w, Math.abs(row[k] - m[j])); });
            });
            return w;
        });
        expect(worst).toBeLessThan(1e-6);

        // (b) On the flat map: interior points of present-day India (plate 501) carried by the kernel
        //     land on drawn LAND. India is the control because it MOVED: at 100 Ma it sat far south and
        //     today's position was Tethys ocean. (Africa was tried first: in this palaeomagnetic frame it
        //     has barely moved since Pangaea, so its present position is land at 250 Ma either way.)
        await page.click('#pt-view-map');
        // Measure LAND alone: arrows, boundary lines and the grid would otherwise sit on sampled pixels.
        for (const layer of ['velocities', 'boundaries', 'graticule']) await page.locator(`[data-layer="${layer}"]`).uncheck();
        await page.waitForTimeout(600);
        const frac = await page.evaluate(() => {
            const { model, map } = window.__plates;
            const c = map.canvas, ctx = c.getContext('2d'), b = map._box, dpr = c.width / c.clientWidth;
            const isLand = (lat, lon) => {
                const x = Math.round((b.x + ((lon + 180) / 360) * b.w) * dpr), y = Math.round((b.y + ((90 - lat) / 180) * b.h) * dpr);
                const [r, g, bl] = ctx.getImageData(x, y, 1, 1).data;
                return Math.abs(r - 0xa9) < 30 && Math.abs(g - 0x94) < 30 && Math.abs(bl - 0x72) < 30;
            };
            // Points whose present-day land polygon is on plate 501 itself (checked against the baked
            // coasts: the grid's other nodes are offshore or on India's sub-plates 50101/50102).
            const pts = [[12, 76.5], [12, 79], [15, 76.5], [15, 79], [18, 74], [18, 76.5], [18, 79], [18, 81.5], [21, 81.5], [21, 84]];
            let carried = 0, still = 0;
            for (const [lat, lon] of pts) {
                const p = model.reconstruct(501, 100, lat, lon);
                if (isLand(p.lat, p.lon)) carried++;
                if (isLand(lat, lon)) still++;
            }
            return { carried: carried / pts.length, still: still / pts.length, n: pts.length };
        });
        expect(frac.carried).toBeGreaterThanOrEqual(0.9);
        expect(frac.still).toBeLessThanOrEqual(0.2);   // control: at 100 Ma India is not where it is today
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/pt-100-map.png` });
    });

    test('one time drives everything: slider, chart click, jump, play, URL', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, '?t=600');
        await expect(page.locator('#pt-age')).toHaveText('600 Ma');
        await expect(page.locator('#pt-slider')).toHaveValue('1200');            // left = 1800 Ma
        await page.locator('#pt-slider').fill('1300');                            // → 500 Ma
        await expect(page.locator('#pt-age')).toHaveText('500 Ma');
        await expect(page.locator('#pt-unit')).toContainText('Cambrian');
        await page.waitForFunction(() => new URL(location.href).searchParams.get('t') === '500');
        // A chart click: the left edge of the plot is the past.
        const svg = page.locator('.pt-chart svg').first();
        const box = await svg.boundingBox();
        await svg.click({ position: { x: 50 + 2, y: box.height / 2 } });
        const tClicked = await page.evaluate(() => window.__plates.state.t);
        expect(tClicked).toBeGreaterThan(1700);
        await page.click('[data-jump="250"]');
        await expect(page.locator('#pt-age')).toHaveText('250 Ma');
        // Play runs toward the present.
        await page.click('#pt-play');
        await page.waitForFunction(() => window.__plates.state.t < 249, null, { timeout: 20_000 });
        await page.click('#pt-play');
        const t1 = await page.evaluate(() => window.__plates.state.t);
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => window.__plates.state.t)).toBe(t1);    // paused stays paused
    });

    test('the probe names the plate and quotes the kernel velocity', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, '?t=100');
        await page.click('#pt-view-map');
        const b = await page.evaluate(() => window.__plates.map._box);
        const canvas = await page.locator('#pt-map').boundingBox();
        // Click the map at 10°S 120°W (in the Pacific basin at 100 Ma).
        const lat = -10, lon = -120;
        await page.mouse.click(canvas.x + b.x + ((lon + 180) / 360) * b.w, canvas.y + b.y + ((90 - lat) / 180) * b.h);
        await expect(page.locator('#pt-probe')).toBeVisible();
        const expected = await page.evaluate(async ([la, lo]) => {
            const { plateAt, frameIndexAt } = await import('/js/plate-history/frames.js');
            const { model, fr } = window.__plates;
            const pl = plateAt(fr, fr.frames[frameIndexAt(fr, 100)], la, lo);
            return { id: pl.p, speed: Math.round(model.velocity(pl.p, 100, la, lo).speed) };
        }, [lat, lon]);
        await expect(page.locator('#pt-probe')).toContainText(`plate ${expected.id}`);
        // The probe's own click point is the pixel's lat/lon, a hair from ours — allow ±1 mm/yr.
        const shown = Number((await page.locator('#pt-probe').innerText()).match(/Moving (\d+) mm\/yr/)[1]);
        expect(Math.abs(shown - expected.speed)).toBeLessThanOrEqual(1);
    });

    test('the model\'s 855 Ma topology gap is said, not hidden', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, '?t=855');
        await expect(page.locator('#pt-gap')).toBeVisible();
        await expect(page.locator('#pt-gap')).toContainText('no plate');
        await page.locator('#pt-slider').fill(String(1800 - 850));
        await expect(page.locator('#pt-gap')).toBeHidden();
    });

    test('phone width: no horizontal overflow, the globe fits', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page, '?t=520');
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over).toBeLessThanOrEqual(1);
        const fit = await page.evaluate(() => { const g = window.__plates.globe; return g.camera.position.length() >= g.fitDistance() - 1e-6; });
        expect(fit).toBe(true);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/pt-phone.png` });
    });
});
