/**
 * deep-links.spec.js — the fragment links emails and pages send people to
 * actually land (companion to the static scan in tests/site-anchors.mjs,
 * which proves the ids EXIST; this proves they are reachable on screen).
 *
 *   · admin.html#activation opens the Activation tab — the Stripe webhook's
 *     staff email links there, and until 2026-09-24 admin.html ignored the
 *     hash entirely and always opened on Overview.
 *   · settings.html#alert-prefs / #saved-locations (the alert email and the
 *     daily digest's "manage" links, which pointed at a dashboard card that
 *     no longer existed) scroll a visible section into view.
 *
 * Auth: tests/fixtures/supabase-session.mjs (a stubbed Supabase session).
 */
import { test, expect } from '@playwright/test';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';

const signIn = (page, plan, role) => stubSupabaseSession(page, { plan, role });

test('admin.html#activation opens the Activation tab', async ({ page }) => {
    await signIn(page, 'enterprise', 'admin');
    await page.goto('/admin.html#activation');
    await expect(page.locator('#admin-main')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#panel-activation')).toHaveClass(/\bactive\b/, { timeout: 30_000 });
    await expect(page.locator('.tab[data-tab="activation"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#panel-overview')).not.toHaveClass(/\bactive\b/);
    // …and a later hash change switches tabs too.
    await page.evaluate(() => { location.hash = 'system'; });
    await expect(page.locator('#panel-system')).toHaveClass(/\bactive\b/);
});

test('admin.html with no hash still opens on Overview', async ({ page }) => {
    await signIn(page, 'enterprise', 'admin');
    await page.goto('/admin.html');
    // Overview is `active` in the static markup, so without the gate check this
    // would pass even on the "Insufficient Permissions" screen (it did, once).
    await expect(page.locator('#admin-main')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#panel-overview')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#panel-activation')).not.toHaveClass(/\bactive\b/);
});

for (const frag of ['alert-prefs', 'saved-locations']) {
    test(`settings.html#${frag} lands on a visible section`, async ({ page }) => {
        await signIn(page, 'basic', 'user');
        await page.goto(`/settings.html#${frag}`);
        const section = page.locator(`#${frag}`);
        await expect(section).toBeVisible({ timeout: 30_000 });
        await expect(section).toBeInViewport({ ratio: 0.1 });
    });
}
