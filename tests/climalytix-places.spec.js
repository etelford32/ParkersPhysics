/**
 * climalytix-places.spec.js — browser gate for Climalytix's location search,
 * history and saved places (js/climalytix/places.js + places-store.js).
 *
 * Every feed is mocked (tests/fixtures/climalytix-mocks.mjs); the geocoder and
 * Supabase are answered locally. What it pins:
 *   · suggestions come WITHOUT the network (the city list + the reader's own
 *     places) and are a real combobox: arrows, Enter, Escape, "/" to focus
 *   · a submitted query takes the best match and OFFERS the others; picking
 *     another one corrects the history instead of keeping the wrong guess
 *   · typed coordinates never reach the geocoder
 *   · the address bar names the visit (shareable) and is bare at Home
 *   · SIGNED OUT: history lasts the session (sessionStorage, never
 *     localStorage), the page says so, and Save opens the sign-up gate
 *     WITHOUT saving — the sign-up line
 *   · SIGNED IN: the account row is pulled and MERGED with this device and
 *     with what the visitor collected before signing in, the merge is pushed
 *     back, Save needs no gate, and the page only says "in your account" once
 *     a sync has landed. NEGATIVE CONTROL: the sync failing ⇒ "on this
 *     device", never an account claim
 *   · phone width: no horizontal scroll, the suggestion list stays on screen
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks } from './fixtures/climalytix-mocks.mjs';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const SPRINGFIELDS = [
    { lat: '39.7990', lon: '-89.6440', display_name: 'Springfield, Illinois, United States', address: { city: 'Springfield', state: 'Illinois', country: 'United States' } },
    { lat: '37.2090', lon: '-93.2923', display_name: 'Springfield, Missouri, United States', address: { city: 'Springfield', state: 'Missouri', country: 'United States' } },
    { lat: '42.1015', lon: '-72.5898', display_name: 'Springfield, Massachusetts, United States', address: { city: 'Springfield', state: 'Massachusetts', country: 'United States' } },
];

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce' });

async function boot(page, { session = null, signedIn = null, path = '/climalytix.html', beforeGoto = null } = {}) {
    const errors = [], geocoder = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page);
    await page.route('https://nominatim.openstreetmap.org/**', (route) => {
        const url = new URL(route.request().url());
        geocoder.push(url.pathname + url.search);
        if (url.pathname.startsWith('/search')) {
            const q = (url.searchParams.get('q') || '').toLowerCase();
            return route.fulfill({ json: q.includes('springfield') ? SPRINGFIELDS : q.includes('nowhere') ? [] : [SPRINGFIELDS[0]] });
        }
        return route.fulfill({ json: { display_name: 'Denver, Colorado, United States', address: { city: 'Denver', state: 'Colorado', country: 'United States' } } });
    });
    if (signedIn) await stubSupabaseSession(page, signedIn);
    await beforeGoto?.();
    await page.addInitScript(({ device, session }) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('pp_auth', JSON.stringify({ signedIn: false, location: device }));
        if (session && !sessionStorage.getItem('__seeded')) {
            sessionStorage.setItem('pp_climalytix_places_v1', JSON.stringify(session));
            sessionStorage.setItem('__seeded', '1');
        }
    }, { device: BOULDER, session });
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await settled(page);
    return { errors, geocoder };
}

const settled = (page) => page.waitForFunction(() => window.__climalytix && window.__climalytix.state.loading.length === 0
    && Object.keys(window.__climalytix.state.datasets).length === 5, null, { timeout: 60_000 });
const places = (page) => page.evaluate(() => window.__climalytix.state.places);

test('suggestions need no network; arrows + Enter pick one; the visit is remembered for the session', async ({ page }) => {
    const { errors, geocoder } = await boot(page);
    await expect(page.locator('#cx-site-name')).toHaveText('Boulder, CO');
    await expect(page.locator('#cx-places-gate')).toContainText('Sign up free');
    await expect(page.locator('#cx-save-btn')).toBeHidden();          // Home is already the account's place

    await page.keyboard.press('/');
    await expect(page.locator('#cx-search')).toBeFocused();
    await page.keyboard.type('tok');
    const list = page.locator('#cx-suggest');
    await expect(list).toBeVisible();
    await expect(list.locator('li[role="option"]').first()).toContainText('Tokyo');
    await expect(page.locator('#cx-search')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(list.locator('li[aria-selected="true"]')).toContainText('Tokyo');
    await page.keyboard.press('Enter');

    await expect(page.locator('#cx-site-name')).toHaveText('Tokyo');
    await expect(page.locator('#cx-site-badge')).toHaveText('VISITING');
    await expect(list).toBeHidden();
    expect(geocoder, 'a suggestion never asks the geocoder').toEqual([]);
    expect(new URL(page.url()).searchParams.get('name')).toBe('Tokyo');
    await expect(page.locator('.cx-place[data-kind="recent"]')).toHaveCount(1);
    await expect(page.locator('#cx-places-gate')).toContainText('1 place kept for this session only');
    const stores = await page.evaluate(() => ({
        session: !!sessionStorage.getItem('pp_climalytix_places_v1'),
        local: Object.keys(localStorage).filter((k) => k.startsWith('pp_climalytix_places')),
    }));
    expect(stores).toEqual({ session: true, local: [] });
    expect((await places(page)).kept).toBe('session');

    // Return home: bare URL, and the place stays one tap away.
    await page.locator('#cx-home-btn').click();
    await expect(page.locator('#cx-site-badge')).toHaveText('HOME');
    expect(new URL(page.url()).search).toBe('');
    await page.locator('.cx-place[data-kind="recent"] .cx-pl-go').click();
    await expect(page.locator('#cx-site-name')).toHaveText('Tokyo');

    // Escape closes the list; the reader's own places are offered on an empty box.
    await page.locator('#cx-search').focus();
    await expect(list.locator('li[data-kind="home"]')).toHaveCount(1);
    await expect(list.locator('li[data-kind="recent"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    expect(errors).toEqual([]);
});

test('a submitted query takes the best match and offers the others; choosing one corrects the history', async ({ page }) => {
    const { geocoder } = await boot(page);
    await page.locator('#cx-search').fill('springfield');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText('Springfield');
    expect(geocoder.length, 'ONE geocoder request, on submit').toBe(1);
    await expect(page.locator('#cx-search-msg')).toContainText('Illinois');
    await expect(page.locator('#cx-search-msg')).toContainText('2 other matches');
    const alts = page.locator('#cx-suggest li[data-kind="match"]');
    await expect(alts).toHaveCount(2);
    await expect(alts.nth(0)).toContainText('Missouri');
    await alts.nth(0).dispatchEvent('pointerdown');
    await expect.poll(async () => (await page.evaluate(() => window.__climalytix.state.site.lat)).toFixed(2)).toBe('37.21');
    const p = await places(page);
    expect(p.recent, 'the wrong first guess is not history').toEqual(['Springfield']);
    await expect(page.locator('.cx-place[data-kind="recent"] .cx-pl-go')).toHaveAttribute('title', /Missouri/);

    // No match says so and changes nothing.
    await page.locator('#cx-search').fill('nowhere at all');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-search-msg')).toContainText('not found');
    expect((await page.evaluate(() => window.__climalytix.state.site.lat)).toFixed(2)).toBe('37.21');
});

test('typed coordinates go straight there; history can be pruned and cleared', async ({ page }) => {
    const { geocoder } = await boot(page);
    await page.locator('#cx-search').fill('64.13N 21.90W');
    await expect(page.locator('#cx-suggest li[data-kind="coords"]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText('64.130°N 21.900°W');
    expect(geocoder).toEqual([]);
    await page.locator('#cx-search').fill('paris');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText('Paris');
    await expect(page.locator('.cx-place[data-kind="recent"]')).toHaveCount(2);
    await page.locator('.cx-place[data-kind="recent"]', { hasText: '64.130' }).locator('.cx-pl-x').click();
    await expect(page.locator('.cx-place[data-kind="recent"]')).toHaveCount(1);
    await page.locator('#cx-places-clear').click();
    await expect(page.locator('#cx-places')).toBeHidden();
    expect((await places(page)).recent).toEqual([]);
});

test('“My location” asks the browser, names the point and goes there', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 39.7392, longitude: -104.9903 });
    await boot(page);
    await page.locator('#cx-locate').click();
    await expect(page.locator('#cx-site-name')).toHaveText('Denver');
    expect((await places(page)).recent).toEqual(['Denver']);
});

test('SIGNED OUT: Save opens the sign-up gate and saves nothing', async ({ page }) => {
    await boot(page, { path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await expect(page.locator('#cx-save-btn')).toBeVisible();
    await page.locator('.pp-consent-banner').evaluateAll((els) => els.forEach((e) => e.remove()));
    await page.locator('#cx-save-btn').click();
    await expect(page.locator('#pp-gate-root')).toBeVisible();
    await expect(page.locator('#pp-gate-headline')).toHaveText('Keep your places.');
    await page.keyboard.press('Escape');
    await expect(page.locator('#pp-gate-root')).toHaveCount(0);
    await expect(page.locator('#cx-save-btn')).toHaveAttribute('aria-pressed', 'false');
    expect((await places(page)).saved).toEqual([]);
    // The line under the chips is the same gate.
    await page.locator('#cx-places-gate [data-gate]').click();
    await expect(page.locator('#pp-gate-root')).toBeVisible();
});

const T0 = Date.UTC(2026, 10, 1);
const REMOTE = { places: { v: 1, clearedAt: 0, places: [
    { lat: 48.8566, lon: 2.3522, city: 'Paris', detail: 'France', at: T0, n: 3, pin: 1, pinAt: T0 },
    { lat: 51.5074, lon: -0.1278, city: 'London', at: T0 + 5, n: 1 },
] } };
const BEFORE_SIGNUP = { v: 1, clearedAt: 0, places: [{ lat: 35.6762, lon: 139.6503, city: 'Tokyo', at: T0 + 9, n: 1 }] };

test('SIGNED IN: the account row is merged with this device and with pre-sign-up places, and pushed back', async ({ page }) => {
    const pushes = [];
    await boot(page, {
        signedIn: { plan: 'free' },                       // a FREE account: places are not plan-gated
        session: BEFORE_SIGNUP,
        beforeGoto: () => page.route('**/rest/v1/dashboards**', (route) => {
            const req = route.request();
            if (req.method() === 'GET') {
                const page_ = new URL(req.url()).searchParams.get('page');
                return route.fulfill({ json: page_ === 'eq.climalytix-places' ? [{ doc: REMOTE, updated_at: new Date(T0).toISOString() }] : [] });
            }
            pushes.push(JSON.parse(req.postData())[0]);
            return route.fulfill({ status: 201, json: [] });
        }),
    });
    await expect.poll(async () => (await places(page)).kept, { timeout: 30_000 }).toBe('account');
    const p = await places(page);
    expect(p.saved).toEqual(['Paris']);
    expect(p.recent).toEqual(['Tokyo', 'London']);
    expect(p.adopted).toBe(1);
    await expect(page.locator('#cx-places-gate')).toHaveAttribute('data-stage', 'welcome');
    await expect(page.locator('#cx-places-gate')).toContainText('1 place from before you signed in is now in your account');
    await expect(page.locator('.cx-place[data-kind="saved"]')).toHaveCount(1);
    // The merge was pushed: the row now holds the pre-sign-up Tokyo too.
    await expect.poll(() => pushes.length).toBeGreaterThan(0);
    expect(pushes[0].page).toBe('climalytix-places');
    expect(pushes[0].doc.places.places.map((x) => x.city).sort()).toEqual(['London', 'Paris', 'Tokyo']);
    // The session copy moved into the account's own key.
    const keys = await page.evaluate(() => ({
        session: sessionStorage.getItem('pp_climalytix_places_v1'),
        local: Object.keys(localStorage).filter((k) => k.startsWith('pp_climalytix_places')),
    }));
    expect(keys.session).toBeNull();
    expect(keys.local).toEqual(['pp_climalytix_places_v1.00000000-0000-0000-0000-0000000abcde']);

    // Save needs no gate, and reaches the account.
    await page.locator('.cx-place[data-kind="recent"] .cx-pl-go', { hasText: 'London' }).click();
    await expect(page.locator('#cx-site-name')).toHaveText('London');
    const before = pushes.length;
    await page.locator('#cx-save-btn').click();
    await expect(page.locator('#pp-gate-root')).toHaveCount(0);
    await expect(page.locator('#cx-save-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => pushes.length, { timeout: 15_000 }).toBeGreaterThan(before);
    expect(pushes.at(-1).doc.places.places.find((x) => x.city === 'London').pin).toBe(1);
});

test('NEGATIVE CONTROL: signed in but the sync fails ⇒ “on this device”, never an account claim', async ({ page }) => {
    await boot(page, {
        signedIn: { plan: 'free' },
        session: BEFORE_SIGNUP,
        beforeGoto: () => page.route('**/rest/v1/dashboards**', (route) => route.fulfill({ status: 500, json: { message: 'boom' } })),
    });
    await expect.poll(async () => (await places(page)).syncState, { timeout: 30_000 }).toBe('error');
    expect((await places(page)).kept).toBe('device');
    await expect(page.locator('#cx-places-gate')).toContainText('on this device');
    await expect(page.locator('#cx-places-gate')).not.toContainText('in your account');
    expect((await places(page)).recent, 'the places themselves still work').toEqual(['Tokyo']);
});

test('phone width: no horizontal scroll and the suggestion list stays on screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    await page.locator('#cx-search').fill('s');
    await expect(page.locator('#cx-suggest')).toBeVisible();
    const box = await page.locator('#cx-suggest').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});
