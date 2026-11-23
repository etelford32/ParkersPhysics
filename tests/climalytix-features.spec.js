/**
 * climalytix-features.spec.js — browser gate for the things a reader can DO
 * with a place on Climalytix beyond searching for it: pick one off the map,
 * name a saved one, make it Home, share it, and see all saved places at once.
 * Kernels are node-gated (tests/climalytix-glance.mjs, climalytix-places.mjs);
 * this proves the page obeys them. Every feed is mocked.
 *
 *   MAP PICK   a click offers the ground under it and asks first; a drag and
 *              a double-click (zoom) offer nothing (negative controls)
 *   RENAME     ✎ names a saved place in place; Escape keeps the old name; a
 *              background re-render never wipes a half-typed name
 *   HOME       signed out it is the sign-up gate; signed in it is two steps
 *              and writes the account; a refused write changes nothing and
 *              says so (negative control)
 *   SHARE      the copied link names the place even from Home
 *   GLANCE     saved places side by side from OUR archive, interpolated to
 *              now; archive unpublished ⇒ every row says why and shows no
 *              number (negative control); hidden while signed out
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks } from './fixtures/climalytix-mocks.mjs';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const T0 = Date.UTC(2026, 10, 1);
const SAVED = { v: 1, clearedAt: 0, places: [
    { lat: 35.6762, lon: 139.6503, city: 'Tokyo', detail: 'Japan', at: T0, n: 1, pin: 1, pinAt: T0 + 1 },
    { lat: 48.8566, lon: 2.3522, city: 'Paris', detail: 'France', at: T0 + 2, n: 1, pin: 1, pinAt: T0 + 3 },
] };

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce' });

async function boot(page, { mocks = {}, pending = null, signedIn = false, path = '/climalytix.html', profilePatch = null } = {}) {
    const log = { errors: [], geocoder: [], patches: [], nwp: [] };
    page.on('pageerror', (e) => log.errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, { ...mocks, onRequest: (u) => { if (u.pathname === '/api/climalytix/nwp') log.nwp.push(u.search); } });
    await page.route('https://nominatim.openstreetmap.org/**', (route) => {
        const url = new URL(route.request().url());
        log.geocoder.push(url.pathname);
        return route.fulfill({ json: { display_name: 'Lyons, Colorado, United States', address: { town: 'Lyons', state: 'Colorado', country: 'United States' } } });
    });
    if (signedIn) {
        await stubSupabaseSession(page, { plan: 'free' });
        await page.route('**/rest/v1/dashboards**', (route) => route.fulfill(route.request().method() === 'GET' ? { json: [] } : { status: 201, json: [] }));
        await page.route('**/rest/v1/user_profiles**', (route) => {
            const req = route.request();
            if (req.method() !== 'PATCH') return route.fallback();
            log.patches.push(JSON.parse(req.postData()));
            return route.fulfill({ json: profilePatch ? profilePatch() : [{ id: '00000000-0000-0000-0000-0000000abcde' }] });
        });
    }
    await page.addInitScript(({ device, pending }) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        if (!localStorage.getItem('pp_auth')) localStorage.setItem('pp_auth', JSON.stringify({ signedIn: false, location: device }));
        if (pending && !sessionStorage.getItem('__seeded')) {
            localStorage.setItem('pp_gate_member', JSON.stringify({ email: 'r@example.test', ts: Date.now() }));
            localStorage.setItem('pp_climalytix_places_v1.pending', JSON.stringify(pending));
            sessionStorage.setItem('__seeded', '1');
        }
    }, { device: BOULDER, pending });
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await settled(page);
    return log;
}
async function settled(page) {
    await page.waitForFunction(() => window.__climalytix && window.__climalytix.state.loading.length === 0
        && Object.keys(window.__climalytix.state.datasets).length === 5, null, { timeout: 60_000 });
    await page.locator('.pp-consent-banner').evaluateAll((els) => els.forEach((e) => e.remove()));
}
const st = (page) => page.evaluate(() => window.__climalytix.state);

// ── MAP PICK ────────────────────────────────────────────────────────────────

test('a click on the map offers that ground, asks first, and names it; a drag and a double-click offer nothing', async ({ page }) => {
    const log = await boot(page);
    const canvas = page.locator('#cx-map-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const pick = page.locator('#cx-map-pick');
    await expect(pick).toBeHidden();

    // NEGATIVE CONTROL 1: a drag pans the map and offers nothing.
    const before = await page.evaluate(() => window.__climalytix.map.state.view);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    await expect(pick).toBeHidden();
    const after = await page.evaluate(() => window.__climalytix.map.state.view);
    expect(after.lon).not.toBeCloseTo(before.lon, 3);

    // NEGATIVE CONTROL 2: a double-click zooms and offers nothing.
    await page.mouse.dblclick(cx + 40, cy - 40);
    await page.waitForTimeout(450);
    await expect(pick).toBeHidden();
    expect((await page.evaluate(() => window.__climalytix.map.state.view)).span).toBeLessThan(after.span);

    // A click offers the point — and does NOT move the site until asked.
    await page.mouse.click(cx + 90, cy - 50);
    await expect(pick).toBeVisible();
    await expect(pick.locator('[data-pick-where]')).toHaveText(/^\d+\.\d{3}°[NS] \d+\.\d{3}°[EW]$/);
    expect((await st(page)).site.city).toBe('Boulder, CO');
    const offered = await pick.evaluate((el) => ({ lat: Number(el.dataset.lat), lon: Number(el.dataset.lon) }));
    expect(offered.lat).toBeGreaterThan(BOULDER.lat - 8);
    // Dismissing it changes nothing.
    await pick.locator('[data-pick="no"]').click();
    await expect(pick).toBeHidden();
    expect((await st(page)).site.city).toBe('Boulder, CO');
    expect(log.geocoder).toEqual([]);

    // Accepting it names the point with ONE reverse lookup and goes there.
    await page.mouse.click(cx + 90, cy - 50);
    await expect(pick).toBeVisible();
    await pick.locator('[data-pick="go"]').click();
    await expect(page.locator('#cx-site-name')).toHaveText('Lyons');
    const s = await st(page);
    expect(s.site.lat).toBeCloseTo(offered.lat, 3);
    expect(s.site.lon).toBeCloseTo(offered.lon, 3);
    expect(s.places.recent).toEqual(['Lyons']);
    expect(log.geocoder).toEqual(['/reverse']);
    await expect(pick).toBeHidden();
    expect(log.errors).toEqual([]);
});

// ── RENAME ──────────────────────────────────────────────────────────────────

test('a saved place can be named in place; Escape keeps the old name; a re-render never wipes typing', async ({ page }) => {
    await boot(page, { pending: SAVED });
    const tokyo = page.locator('.cx-place[data-kind="saved"]', { hasText: 'Tokyo' });
    await tokyo.locator('.cx-pl-edit').click();
    const input = page.locator('.cx-pl-name');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('placeholder', 'Tokyo');
    await page.keyboard.type('Grand');
    // A background re-render (a sync landing, another tab) must not eat the half-typed name.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('climalytix-places')));
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Grand');
    await page.keyboard.type('ma');
    await page.keyboard.press('Enter');
    const named = page.locator('.cx-place[data-kind="saved"]', { hasText: 'Grandma' });
    await expect(named).toHaveCount(1);
    await expect(named.locator('.cx-pl-go')).toHaveAttribute('title', 'Tokyo — Japan');   // the real place is one hover away
    expect((await st(page)).places.saved).toEqual(['Tokyo', 'Paris']);                      // …and is still what is stored
    // The search finds it by the reader's own word.
    await page.locator('#cx-search').fill('gran');
    await expect(page.locator('#cx-suggest li[data-kind="saved"]')).toContainText('Tokyo');
    await page.keyboard.press('Escape');
    await page.locator('#cx-search').fill('');

    // Escape cancels; the name stays.
    await named.locator('.cx-pl-edit').click();
    await page.keyboard.type('Something else');
    await page.keyboard.press('Escape');
    await expect(page.locator('.cx-place[data-kind="saved"]', { hasText: 'Grandma' })).toHaveCount(1);
    // An empty box clears the name back to the place's own.
    await page.locator('.cx-place[data-kind="saved"]', { hasText: 'Grandma' }).locator('.cx-pl-edit').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cx-place[data-kind="saved"] .cx-pl-go').first()).toHaveText('Tokyo');
    // Markup typed as a name is a name.
    await page.locator('.cx-place[data-kind="saved"]', { hasText: 'Paris' }).locator('.cx-pl-edit').click();
    await page.keyboard.type('<img src=x onerror="window.__xss=1">');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cx-place[data-kind="saved"] .cx-pl-go').nth(1)).toHaveText('<img src=x onerror="window.__xss=1">');
    expect(await page.evaluate(() => ({ x: window.__xss ?? null, imgs: document.querySelectorAll('#cx-site img').length }))).toEqual({ x: null, imgs: 0 });
});

// ── HOME ────────────────────────────────────────────────────────────────────

test('Make home: signed out it is the sign-up gate and changes nothing', async ({ page }) => {
    await boot(page, { path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await expect(page.locator('#cx-sethome-btn')).toBeVisible();
    await page.locator('#cx-sethome-btn').click();
    await expect(page.locator('#pp-gate-root')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#cx-site-badge')).toHaveText('VISITING');
    // At Home there is nothing to make Home.
    await page.locator('#cx-home-btn').click();
    await expect(page.locator('#cx-sethome-btn')).toBeHidden();
});

test('Make home: signed in it takes two steps and writes the account', async ({ page }) => {
    const log = await boot(page, { signedIn: true, path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await expect.poll(async () => (await st(page)).places.scope, { timeout: 30_000 }).toBe('account');
    const btn = page.locator('#cx-sethome-btn');
    await btn.click();
    await expect(btn).toHaveText('Confirm: make Tokyo Home');
    await expect(page.locator('#cx-search-msg')).toContainText('alerts are evaluated');
    expect(log.patches, 'one click writes nothing').toEqual([]);
    await btn.click();
    await expect(page.locator('#cx-search-msg')).toHaveText('Tokyo is now your Home.');
    expect(log.patches).toHaveLength(1);
    expect(log.patches[0].location_city).toBe('Tokyo');
    expect(log.patches[0].location_lat).toBeCloseTo(35.68, 2);
    expect(Object.keys(log.patches[0]).sort()).toEqual(['location_city', 'location_lat', 'location_lon', 'updated_at']);   // never plan / role
    await expect(page.locator('#cx-site-badge')).toHaveText('HOME');
    await expect(btn).toBeHidden();
    expect(new URL(page.url()).search).toBe('');                       // Home is the bare page
    expect(log.errors).toEqual([]);
});

test('NEGATIVE CONTROL: an armed button disarms on its own, and a refused write changes nothing and says so', async ({ page }) => {
    const log = await boot(page, { signedIn: true, path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo', profilePatch: () => [] });
    await expect.poll(async () => (await st(page)).places.scope, { timeout: 30_000 }).toBe('account');
    const btn = page.locator('#cx-sethome-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('data-armed', '1');
    await expect(btn).not.toHaveAttribute('data-armed', '1', { timeout: 9000 });   // 6 s, then it is a plain button again
    await expect(btn).toHaveText('⌂ Make home');
    expect(log.patches).toEqual([]);
    await btn.click();
    await btn.click();
    await expect(page.locator('#cx-search-msg')).toContainText('Home was not changed');
    await expect(page.locator('#cx-site-badge')).toHaveText('VISITING');
    await expect(btn).toBeVisible();
});

// ── SHARE ───────────────────────────────────────────────────────────────────

test('Copy link names the place — even from Home, where the address bar is bare', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    expect(new URL(page.url()).search).toBe('');
    await page.locator('#cx-share-btn').click();
    await expect(page.locator('#cx-search-msg')).toHaveText('Link to Boulder, CO copied.');
    const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(link.pathname).toBe('/climalytix.html');
    expect(link.searchParams.get('lat')).toBe('40.0150');
    expect(link.searchParams.get('lon')).toBe('-105.2710');
    expect(link.searchParams.get('name')).toBe('Boulder, CO');
    // The link works: a fresh page opened on it analyses that place.
    const other = await context.newPage();
    await installClimalytixMocks(other);
    await other.addInitScript(() => localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 1, lon: 1, city: 'Elsewhere' })));
    await other.goto(link.pathname + link.search, { waitUntil: 'domcontentloaded' });
    await settled(other);
    await expect(other.locator('#cx-site-name')).toHaveText('Boulder, CO');
});

// ── GLANCE ──────────────────────────────────────────────────────────────────

test('“Your places right now”: saved places side by side, from our archive, interpolated to now', async ({ page }) => {
    const log = await boot(page, { pending: SAVED });
    const board = page.locator('#cx-glance');
    await expect(board).toBeVisible();
    await expect(page.locator('#cx-glance-n')).toHaveText('3');           // Home + two saved
    const before = log.nwp.length;                                         // closed: it has cost nothing yet
    await board.locator('summary').click();
    const rows = page.locator('#cx-glance-body tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-kind', 'home');
    await expect(rows.nth(0).locator('.cx-gl-go')).toHaveText('⌂ Boulder, CO');
    await expect(rows.nth(1).locator('.cx-gl-go')).toHaveText('★ Tokyo');
    await expect(page.locator('#cx-glance-body .cx-gl-wait')).toHaveCount(0);
    await expect(page.locator('#cx-glance-body .cx-gl-t')).toHaveCount(3);
    expect(log.nwp.length - before).toBe(3);                               // one archive read per place
    expect(log.nwp.some((q) => q.includes('lat=35.68') && q.includes('lon=139.65'))).toBe(true);

    // The number is the archive's, interpolated to this minute (the fixture is 9 + 7·sin over a day).
    const s = await st(page);
    const now = Date.now();
    const model = (t) => 9 + 7 * Math.sin(2 * Math.PI * (t / 86_400_000 - 0.4));
    for (const g of s.glance) {
        expect(g.state).toBe('ok');
        expect(Math.abs(g.tempC - model(now))).toBeLessThan(0.6);          // a chord of a 3-hour arc
        expect(g.hiC).toBeGreaterThan(g.loC);
        expect(g.windMs).toBeGreaterThan(0);
    }
    const f = Math.round(s.glance[1].tempC * 9 / 5 + 32);
    await expect(rows.nth(1).locator('.cx-gl-t')).toHaveText(new RegExp(`^${f}\\s?°F$`));
    await expect(page.locator('#cx-glance-note')).toContainText('own GFS archive');
    await expect(page.locator('#cx-glance-note')).toContainText('interpolated to this minute');

    // Units follow the page's control.
    await page.locator('#cx-units').selectOption('metric');
    await expect(rows.nth(1).locator('.cx-gl-t')).toHaveText(/°C$/);
    // A row is a way to go there, and marks where you are.
    await rows.nth(2).locator('.cx-gl-go').click();
    await expect(page.locator('#cx-site-name')).toHaveText('Paris');
    await expect(page.locator('#cx-glance-body tr[data-here="1"] .cx-gl-go')).toHaveText('★ Paris');
    // Re-rendering within the cache window asks the archive nothing new.
    const n = log.nwp.filter((q) => q.includes('lat=35.68')).length;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('climalytix-places')));
    await page.waitForTimeout(300);
    expect(log.nwp.filter((q) => q.includes('lat=35.68')).length).toBe(n);
    expect(log.errors).toEqual([]);
});

test('NEGATIVE CONTROL: archive unpublished ⇒ every row says why and shows no number', async ({ page }) => {
    await boot(page, { pending: SAVED, mocks: { nwp: 'unpublished' } });
    await page.locator('#cx-glance summary').click();
    const none = page.locator('#cx-glance-body .cx-gl-none');
    await expect(none).toHaveCount(3);
    await expect(none.first()).toContainText('our archive is not published yet');
    await expect(none.first()).toContainText('Nothing is substituted');
    await expect(page.locator('#cx-glance-body .cx-gl-t')).toHaveCount(0);
    expect((await st(page)).glance.every((g) => g.state === 'none' && g.tempC == null)).toBe(true);
});

test('the board is an account feature: hidden while signed out, and with nothing saved', async ({ page }) => {
    await boot(page, { path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await expect(page.locator('#cx-glance')).toBeHidden();
    expect((await st(page)).places.scope).toBe('session');
});

test('phone: the new controls fit and the board scrolls inside itself', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, { pending: SAVED, path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await page.locator('#cx-glance summary').click();
    await expect(page.locator('#cx-glance-body .cx-gl-t')).toHaveCount(3);
    for (const sel of ['#cx-sethome-btn', '#cx-share-btn', '#cx-save-btn']) {
        const b = await page.locator(sel).boundingBox();
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
