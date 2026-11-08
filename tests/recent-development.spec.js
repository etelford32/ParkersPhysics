/**
 * recent-development.spec.js — the build log page renders the WHOLE log,
 * filters it, deep-links into it, fits a phone, and feeds feedback.html.
 *
 * tests/dev-log.mjs gates the DATA; this gates what only a browser can see.
 * No network needed — the page ships no feeds.
 */
import { test, expect } from '@playwright/test';
import { DEV_LOG, SPRINTS } from '../js/dev-log.js';

test.describe('recent development', () => {
    test('renders every entry, grouped by sprint, with a spotlight', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto('/recent-development.html', { waitUntil: 'load' });
        await page.waitForSelector('.rd-entry');

        await expect(page.locator('.rd-entry')).toHaveCount(DEV_LOG.length);
        await expect(page.locator('.rd-spot')).toHaveCount(3);
        await expect(page.locator('.rd-sprint')).toHaveCount(SPRINTS.length);
        await expect(page.locator('#rd-stats')).toContainText(`${DEV_LOG.length} updates logged`);

        // Newest first, and the open sprint is labelled.
        await expect(page.locator('.rd-entry').first()).toHaveAttribute('id', DEV_LOG[0].id);
        if (SPRINTS[0].end === null) await expect(page.locator('.rd-sprint').first().locator('.rd-live')).toBeVisible();

        // Every entry offers a way to go and see it.
        const linkless = await page.locator('.rd-entry').evaluateAll(els =>
            els.filter(el => !el.querySelector('.rd-links a.rd-open')).map(el => el.id));
        expect(linkless).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('kind / section / search filters, reflected in the URL', async ({ page }) => {
        await page.goto('/recent-development.html', { waitUntil: 'load' });
        await page.waitForSelector('.rd-entry');

        const fixes = DEV_LOG.filter(e => e.kind === 'fix').length;
        await page.click('#rd-kind-chips [data-kind="fix"]');
        await expect(page.locator('.rd-entry')).toHaveCount(fixes);
        expect(page.url()).toContain('kind=fix');
        await expect(page.locator('#rd-result')).toHaveText(`Showing ${fixes} of ${DEV_LOG.length} updates`);

        await page.click('#rd-kind-chips [data-kind=""]');
        await page.fill('#rd-search', 'zzzz-no-such-word');
        await expect(page.locator('#rd-empty')).toBeVisible();
        await page.click('#rd-clear');
        await expect(page.locator('.rd-entry')).toHaveCount(DEV_LOG.length);

        // A filtered URL restores its filter on load.
        await page.goto('/recent-development.html?section=deep-space', { waitUntil: 'load' });
        await expect(page.locator('.rd-entry')).toHaveCount(DEV_LOG.filter(e => e.section === 'deep-space').length);
    });

    test('a deep link scrolls to its entry even when a filter would hide it', async ({ page }) => {
        const target = DEV_LOG.find(e => e.kind !== 'fix' && e.highlights);
        await page.goto(`/recent-development.html?kind=fix#${target.id}`, { waitUntil: 'load' });
        const el = page.locator(`#${target.id}`);
        await expect(el).toBeInViewport();
        await expect(el).toHaveClass(/rd-flash/);
        await expect(el.locator('details')).toHaveAttribute('open', '');
    });

    test('fits a phone with no sideways scroll', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/recent-development.html', { waitUntil: 'load' });
        await page.waitForSelector('.rd-entry');
        const overflow = await page.evaluate(() => {
            const w = document.documentElement.clientWidth;
            // .sim-search-label is a screen-reader label parked at left:-9999px on purpose.
            return [...document.querySelectorAll('main *')]
                .filter(el => !el.closest('.sim-search-label'))
                .filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > w + 1 || r.left < -1); })
                .map(el => el.className || el.tagName).slice(0, 5);
        });
        expect(overflow).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('reachable from the Research menu, and feedback.html shows the newest entries', async ({ page }) => {
        await page.goto('/research.html', { waitUntil: 'load' });
        await expect(page.locator('nav a[href="recent-development.html"]').first()).toBeAttached();
        await expect(page.locator('main a[href="recent-development.html"]').first()).toBeVisible();

        await page.goto('/feedback.html', { waitUntil: 'load' });
        await expect(page.locator('#devlog-latest .rd-compact')).toHaveCount(5);
        await expect(page.locator('#devlog-latest .rd-compact-title').first()).toHaveText(DEV_LOG[0].title);
    });
});
