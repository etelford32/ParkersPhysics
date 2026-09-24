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
 * Auth: a STUBBED Supabase session (the tests/auth-e2e.spec.js pattern — a
 * structurally valid unsigned JWT, every /auth/v1 and /rest/v1 call answered
 * locally). The pp_auth mock that tests/auth-tier-redirect.spec.js seeds only
 * applies when the Supabase client FAILS to initialise; the client is
 * self-hosted and initialises offline, finds no session and bounces to
 * sign-in — measured 2026-09-24, and that spec's settings/dashboard cases fail
 * in this sandbox for exactly that reason.
 */
import { test, expect } from '@playwright/test';

const PROJECT_REF = 'aijsboodkivnhzfstvdq';
const USER_ID = '00000000-0000-0000-0000-0000000abcde';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (sub) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role: 'authenticated', aud: 'authenticated', exp: 9999999999 })}.sig`;
const json = (obj, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) });

async function signIn(page, plan, role) {
    const user = {
        id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'links@playwright.test',
        user_metadata: { full_name: 'Link Tester' }, app_metadata: { provider: 'email' },
    };
    const session = {
        access_token: fakeJwt(USER_ID), token_type: 'bearer', expires_in: 3600,
        expires_at: 9999999999, refresh_token: 'fake-refresh-token', user,
    };
    const profile = { id: USER_ID, email: user.email, plan, role, full_name: 'Link Tester' };
    // Reverse-registration matching: catch-alls FIRST (see auth-e2e.spec.js).
    await page.route('**/rest/v1/**', (r) => r.fulfill(json([])));
    await page.route('**/auth/v1/**', (r) => r.fulfill(json({})));
    await page.route('**/auth/v1/user**', (r) => r.fulfill(json(user)));
    await page.route('**/auth/v1/token**', (r) => r.fulfill(json(session)));
    // auth.js reads the profile with .single(), which asks PostgREST for an
    // OBJECT (Accept: application/vnd.pgrst.object+json). Answering with an
    // array leaves role undefined and the admin gate refuses — answer in the
    // shape that was asked for.
    await page.route('**/rest/v1/user_profiles**', (r) => {
        const one = /vnd\.pgrst\.object/.test(r.request().headers().accept || '');
        return r.fulfill(json(one ? profile : [profile]));
    });
    await page.route('**/rest/v1/rpc/**', (r) => r.fulfill(json(plan)));
    await page.addInitScript(({ key, session }) => {
        localStorage.setItem(key, JSON.stringify(session));
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('pp_tour_completed', '1');
    }, { key: `sb-${PROJECT_REF}-auth-token`, session });
}

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
