/**
 * climalytix-temp-toggles.spec.js — the Temperature controls follow the data.
 *
 * THE BUG (production, 2026-11-09): our GFS archive had no run published, so
 * the map drew no temperature — while the rail showed Temperature ticked,
 * Isotherms and Warmest/coldest ticked and clickable, a live opacity slider
 * and a colour key on the map. Every toggle worked and changed nothing.
 * The rule (js/climalytix/layer-state.js): a control is live only while it can
 * change what is drawn; the checkbox alone keeps the reader's intent.
 *
 * Feeds are mocked (tests/fixtures/climalytix-mocks.mjs). What it pins:
 *   · archive down ⇒ Temperature stays TICKED but says "No data"; the
 *     sub-toggles and the slider are disabled; NO key on the map; the map
 *     carries the reason and a Retry; nothing is drawn or substituted
 *   · NEGATIVE CONTROL: archive up ⇒ every control live, key on the map, no
 *     notice, the badge is the source label again
 *   · Retry: the archive comes up mid-session ⇒ one click draws the heat and
 *     re-arms every control, with no page reload; a retry that fails again
 *     leaves the notice up
 *   · each toggle changes exactly what it names — heat, isotherms, markers,
 *     opacity (pixels at the site) — and off → on restores the same frame
 *   · switching to another fill and back restores the Temperature controls
 *   · the units control re-labels the key, the ticks and the isotherms
 *   · Airflow, fed by the same archive, wears the same badge
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks } from './fixtures/climalytix-mocks.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };

test.describe.configure({ timeout: 90_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce', viewport: { width: 1366, height: 900 } });

async function boot(page, mocks = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('ppx_tour_completed', '1');
    }, BOULDER);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    return errors;
}

/** Every feed answered and the Temperature control has left 'loading'. */
const settled = (page) => page.waitForFunction(() => {
    const s = window.__climalytix?.state;
    return s && s.loading.length === 0 && s.map && s.field?.state !== 'loading' && s.tempControl && s.tempControl.mode !== 'loading';
}, null, { timeout: 60_000 });
const state = (page) => page.evaluate(() => window.__climalytix.state);
const mode = (page) => page.evaluate(() => window.__climalytix.state.tempControl.mode);
const nextFrame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Mean colour of a small block of the map canvas, away from the site ring. */
const sample = (page) => page.evaluate(() => {
    const c = document.getElementById('cx-map-canvas');
    const d = c.getContext('2d').getImageData(Math.round(c.width * 0.72), Math.round(c.height * 0.3), 8, 8).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
    return sum.map((x) => Math.round(x / 64));
});
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const row = (page) => page.locator('label.cx-layer:has(#cx-layer-temp)');
const badge = (page) => row(page).locator('.cx-layer-src');

test('archive down: Temperature stays ticked but its controls stop claiming a field', async ({ page }) => {
    const errors = await boot(page, { nwp: 'unpublished' });
    expect(await mode(page)).toBe('down');
    // The reader's intent is kept…
    await expect(page.locator('#cx-layer-temp')).toBeChecked();
    await expect(page.locator('#cx-layer-temp')).toBeEnabled();
    // …and everything that could only change an absent field is off.
    await expect(row(page)).toHaveAttribute('data-avail', 'down');
    await expect(badge(page)).toHaveText('No data');
    await expect(page.locator('#cx-layer-iso')).toBeDisabled();
    await expect(page.locator('#cx-layer-ext')).toBeDisabled();
    await expect(page.locator('#cx-heat-alpha')).toBeDisabled();
    await expect(page.locator('#cx-map-key')).toBeHidden();
    // The map itself says why, where the key would be, and offers Retry.
    await expect(page.locator('#cx-map-notice')).toBeVisible();
    await expect(page.locator('#cx-map-notice')).toContainText('Temperature is not drawn');
    await expect(page.locator('#cx-map-notice')).toContainText('not published yet');
    await expect(page.locator('#cx-map-notice button')).toBeVisible();
    await expect(page.locator('#cx-heat-retry')).toBeVisible();
    await expect(page.locator('#cx-heat-status')).toHaveAttribute('data-state', 'down');
    // Nothing drawn, nothing substituted; the basemap is still there.
    const s = await state(page);
    expect(s.map.drawn.heat).toBe(false);
    expect(s.map.drawn.isotherms).toBe(0);
    expect(s.map.drawn.tiles).toBeGreaterThan(0);
    // Airflow reads the same archive and says so the same way.
    await expect(page.locator('label.cx-layer:has(#cx-layer-airflow) .cx-layer-src')).toHaveText('No data');

    // Unticking is the reader's choice: no notice, no red badge. Re-ticking brings the truth back.
    await page.locator('#cx-layer-temp').uncheck();
    await expect(page.locator('#cx-map-notice')).toBeHidden();
    await expect(badge(page)).toHaveText('Ours');
    await expect(page.locator('#cx-heat-retry')).toBeHidden();
    await page.locator('#cx-layer-temp').check();
    await expect(page.locator('#cx-map-notice')).toBeVisible();
    await expect(badge(page)).toHaveText('No data');
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: archive up — every control is live and changes exactly what it names', async ({ page }) => {
    const errors = await boot(page);
    expect(await mode(page)).toBe('on');
    await expect(row(page)).toHaveAttribute('data-avail', 'on');
    await expect(badge(page)).toHaveText('Ours');
    await expect(page.locator('#cx-layer-iso')).toBeEnabled();
    await expect(page.locator('#cx-layer-ext')).toBeEnabled();
    await expect(page.locator('#cx-heat-alpha')).toBeEnabled();
    await expect(page.locator('#cx-map-notice')).toBeHidden();
    await expect(page.locator('#cx-heat-retry')).toBeHidden();
    await expect(page.locator('#cx-map-key')).toBeVisible();
    await expect(page.locator('#cx-map-key #cx-heat-key')).toHaveCount(1);

    const on = await state(page);
    expect(on.map.drawn.heat).toBe(true);
    expect(on.map.drawn.isotherms).toBeGreaterThan(0);
    expect(on.map.drawn.extremes).toBe(true);
    const heatPx = await sample(page);

    // Isotherms off: only the isotherms go.
    await page.locator('#cx-layer-iso').uncheck();
    await nextFrame(page);
    let s = await state(page);
    expect([s.map.drawn.heat, s.map.drawn.isotherms, s.map.drawn.extremes]).toEqual([true, 0, true]);
    await page.locator('#cx-layer-iso').check();
    // Warmest / coldest off: only the markers go.
    await page.locator('#cx-layer-ext').uncheck();
    await nextFrame(page);
    s = await state(page);
    expect([s.map.drawn.heat, s.map.drawn.isotherms > 0, s.map.drawn.extremes]).toEqual([true, true, false]);
    await page.locator('#cx-layer-ext').check();

    // Opacity: the same field, visibly weaker.
    await page.locator('#cx-heat-alpha').fill('0.2');
    await nextFrame(page);
    const faintPx = await sample(page);
    expect(dist(faintPx, heatPx)).toBeGreaterThan(8);
    await page.locator('#cx-heat-alpha').fill('0.62');
    await nextFrame(page);
    expect(dist(await sample(page), heatPx)).toBeLessThan(3);

    // Temperature off: the heat is gone from the pixels, the sub-controls are off, the key leaves the map.
    await page.locator('#cx-layer-temp').uncheck();
    await nextFrame(page);
    s = await state(page);
    expect([s.map.drawn.heat, s.map.drawn.isotherms, s.map.drawn.extremes]).toEqual([false, 0, false]);
    expect(dist(await sample(page), heatPx)).toBeGreaterThan(8);
    await expect(page.locator('#cx-layer-iso')).toBeDisabled();
    await expect(page.locator('#cx-heat-alpha')).toBeDisabled();
    await expect(page.locator('#cx-map-key')).toBeHidden();
    await expect(page.locator('#cx-heat-status')).toHaveText('Temperature layer off.');
    // …and on again: the same frame, the sub-toggles as the reader left them.
    await page.locator('#cx-layer-temp').check();
    await nextFrame(page);
    s = await state(page);
    expect(s.map.drawn.heat).toBe(true);
    expect(s.map.drawn.isotherms).toBe(on.map.drawn.isotherms);
    expect(dist(await sample(page), heatPx)).toBeLessThan(3);
    await expect(page.locator('#cx-layer-iso')).toBeEnabled();
    await expect(page.locator('#cx-layer-iso')).toBeChecked();
    await expect(page.locator('#cx-map-key')).toBeVisible();

    // Another fill takes the map and its key; coming back restores Temperature's.
    await page.locator('#cx-layer-aq').check();
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    await expect(page.locator('#cx-layer-iso')).toBeDisabled();
    await expect(page.locator('#cx-map-key #cx-aq-key')).toHaveCount(1);
    await expect(page.locator('#cx-map-key #cx-heat-key')).toHaveCount(0);
    await page.locator('#cx-layer-temp').check();
    await expect(page.locator('#cx-layer-aq')).not.toBeChecked();
    await expect(page.locator('#cx-layer-iso')).toBeEnabled();
    await expect(page.locator('#cx-map-key #cx-heat-key')).toHaveCount(1);
    await nextFrame(page);
    expect((await state(page)).map.drawn.heat).toBe(true);
    expect(errors).toEqual([]);
});

test('units: the key, its ticks and the isotherms follow the reader\'s unit', async ({ page }) => {
    const errors = await boot(page);
    await page.selectOption('#cx-units', 'metric');
    await nextFrame(page);
    await expect(page.locator('#cx-map-key .cx-mk-title')).toContainText('°C');
    const c = await state(page);
    expect(c.map.drawn.isoLevels).toContain('0°');
    await expect(page.locator('#cx-heat-key .cx-key-ticks')).toContainText('20°');
    await expect(page.locator('#cx-heat-status')).toContainText('°C');

    await page.selectOption('#cx-units', 'imperial');
    await nextFrame(page);
    await expect(page.locator('#cx-map-key .cx-mk-title')).toContainText('°F');
    const f = await state(page);
    expect(f.map.drawn.isoLevels).toContain('32°');
    expect(f.map.drawn.isoLevels).not.toEqual(c.map.drawn.isoLevels);
    await expect(page.locator('#cx-heat-key .cx-key-ticks')).toContainText('80°');
    await expect(page.locator('#cx-heat-status')).toContainText('°F');
    // The field itself did not change — only its labels.
    expect(f.map.drawn.heat).toBe(true);
    expect(errors).toEqual([]);
});

test('Retry: the archive comes up mid-session and one click draws it', async ({ page }) => {
    let archive = 'unpublished';
    const errors = await boot(page, { nwp: () => archive });
    expect(await mode(page)).toBe('down');

    // Still down: a retry asks again and the notice stays.
    await page.locator('#cx-heat-retry').click();
    await settled(page);
    expect(await mode(page)).toBe('down');
    await expect(page.locator('#cx-map-notice')).toBeVisible();

    // The ingest publishes a run; Retry on the map picks it up without a reload.
    archive = 'fresh';
    await page.locator('#cx-map-notice button').click();
    await page.waitForFunction(() => window.__climalytix.state.tempControl.mode === 'on' && window.__climalytix.state.map.drawn.heat, null, { timeout: 30_000 });
    await settled(page);
    await expect(page.locator('#cx-map-notice')).toBeHidden();
    await expect(page.locator('#cx-heat-retry')).toBeHidden();
    await expect(badge(page)).toHaveText('Ours');
    await expect(page.locator('#cx-layer-iso')).toBeEnabled();
    await expect(page.locator('#cx-heat-alpha')).toBeEnabled();
    await expect(page.locator('#cx-map-key #cx-heat-key')).toHaveCount(1);
    await expect(page.locator('#cx-heat-status')).toHaveAttribute('data-state', 'live');
    const s = await state(page);
    expect(s.map.drawn.isotherms).toBeGreaterThan(0);
    // The same click brought the wind back (one archive, one retry).
    await expect(page.locator('label.cx-layer:has(#cx-layer-airflow) .cx-layer-src')).toHaveText('Ours');
    expect(s.datasets.gfs.state).toBe('live');
    expect(errors).toEqual([]);
});
