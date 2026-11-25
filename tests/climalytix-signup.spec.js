/**
 * climalytix-signup.spec.js — browser gate for Climalytix's location search AS
 * A SIGN-UP MECHANISM: the pitch ladder (js/climalytix/places-pitch.js), the
 * dialog it opens, what survives the trip to sign in, and what the page says
 * afterwards. The rules themselves are node-gated (tests/climalytix-pitch.mjs);
 * this file proves the PAGE obeys them, end to end, with every feed mocked.
 *
 *   THE LADDER    invite line → session line → ownership card at 3 places;
 *                 "Not now" holds (through a reload) until 6
 *   THE ASK       every entry point opens the SAME dialog, which names the
 *                 reader's own places and returns them to the place they were on
 *   THE EMAIL     a submitted email moves the places to a store that survives
 *                 another tab; a FAILED submit changes nothing (negative control)
 *   THE RETURN    Save → sign in → back: the place is saved as asked and the
 *                 welcome says so once; a DISMISSED dialog saves nothing
 *                 (negative control)
 *   SIGN-OUT      a synced account leaves no location history on the machine;
 *                 an unsynced one keeps its only copy (negative control)
 *   HOSTILE INPUT a place name with markup is text; storage that throws and
 *                 documents that are garbage do not break the page
 *   THE BOX       no geocoder request while typing; the last of two submits
 *                 wins; a dead geocoder says so; keyboard, ARIA and focus
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks } from './fixtures/climalytix-mocks.mjs';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const USER_KEY = 'pp_climalytix_places_v1.00000000-0000-0000-0000-0000000abcde';
const T0 = Date.UTC(2026, 10, 1);
const place = (city, lat, lon, extra = {}) => ({ lat, lon, city, at: T0, n: 1, ...extra });
const doc = (...places) => ({ v: 1, clearedAt: 0, places });

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce' });

async function boot(page, { session = null, signedIn = null, path = '/climalytix.html', geocode = null, dashboards = null, before = null } = {}) {
    const log = { errors: [], geocoder: [], pushes: [], gate: [] };
    page.on('pageerror', (e) => log.errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page);
    await page.route('https://nominatim.openstreetmap.org/**', async (route) => {
        const url = new URL(route.request().url());
        log.geocoder.push(url.searchParams.get('q') ?? url.pathname);
        if (geocode) return geocode(route, url);
        return route.fulfill({ json: [{ lat: '39.7990', lon: '-89.6440', display_name: 'Springfield, Illinois, United States', address: { city: 'Springfield', state: 'Illinois', country: 'United States' } }] });
    });
    await page.route('**/api/auth/gate-signup', (route) => {
        log.gate.push(JSON.parse(route.request().postData() || '{}'));
        return route.fulfill({ json: { ok: true } });
    });
    if (signedIn) await signIn(page, log, { ...signedIn, dashboards });
    await before?.();
    await page.addInitScript(({ device, session }) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        if (!localStorage.getItem('pp_auth')) localStorage.setItem('pp_auth', JSON.stringify({ signedIn: false, location: device }));
        if (session && !sessionStorage.getItem('__seeded')) {
            sessionStorage.setItem('pp_climalytix_places_v1', JSON.stringify(session));
            sessionStorage.setItem('__seeded', '1');
        }
    }, { device: BOULDER, session });
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await settled(page);
    return log;
}

/** Make the NEXT load a signed-in one (routes now, the session token by init script). */
async function signIn(page, log, { plan = 'free', dashboards = null } = {}) {
    await stubSupabaseSession(page, { plan });
    await page.route('**/rest/v1/dashboards**', (route) => {
        const req = route.request();
        if (dashboards) return dashboards(route, req, log);
        if (req.method() === 'GET') return route.fulfill({ json: [] });
        log.pushes.push(JSON.parse(req.postData())[0]);
        return route.fulfill({ status: 201, json: [] });
    });
}

async function settled(page) {
    await page.waitForFunction(() => window.__climalytix && window.__climalytix.state.loading.length === 0
        && Object.keys(window.__climalytix.state.datasets).length === 5, null, { timeout: 60_000 });
    await page.locator('.pp-consent-banner').evaluateAll((els) => els.forEach((e) => e.remove()));
}
const st = (page) => page.evaluate(() => window.__climalytix.state);
const pitchEl = (page) => page.locator('#cx-places-gate');
const gateRoot = (page) => page.locator('#pp-gate-root');

/** Visit a city from the built-in list, by keyboard, without the network. */
async function visit(page, typed, name) {
    await page.locator('#cx-search').fill(typed);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText(name);
}

// ── THE LADDER ──────────────────────────────────────────────────────────────

test('the ladder: a quiet line, then what is at stake, then the card at the third place', async ({ page }) => {
    const log = await boot(page);
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'invite');
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'line');
    await expect(page.locator('.cx-pitch-cta')).toHaveCount(0);       // a first-time visitor is never shown the card
    await expect(page.locator('.cx-place-ghost')).toHaveCount(0);

    await visit(page, 'tok', 'Tokyo');
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'session');
    await expect(pitchEl(page)).toContainText('1 place kept for this session only — gone when this tab closes.');
    await expect(page.locator('.cx-place-ghost')).toBeVisible();       // the Saved row is visible before it is asked for

    await visit(page, 'pari', 'Paris');
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'line');
    await expect(pitchEl(page)).toContainText('2 places kept');

    await visit(page, 'reyk', 'Reykjavík');
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'ownership');
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'card');
    await expect(pitchEl(page)).toHaveAttribute('role', 'region');
    await expect(pitchEl(page).locator('strong')).toHaveText('Keep your 3 places?');
    await expect(pitchEl(page)).toContainText('Reykjavík, Paris and Tokyo are only kept until this tab closes');
    await expect(page.locator('.cx-pitch-cta')).toHaveText('Keep my places — free');
    // The page's state IS the kernel's answer.
    const s = await st(page);
    expect(s.pitch.stage).toBe('ownership');
    expect(s.pitch.count).toBe(3);
    expect(log.errors).toEqual([]);
});

test('“Not now” is respected through a reload and until there is more to lose', async ({ page }) => {
    await boot(page, { session: doc(place('Tokyo', 35.68, 139.65), place('Paris', 48.86, 2.35, { at: T0 + 1 }), place('Lima', -12.05, -77.04, { at: T0 + 2 })) });
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'card');
    await page.locator('.cx-pitch-no').click();
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'line');
    await expect(pitchEl(page)).toContainText('3 places kept for this session only');
    await visit(page, 'syd', 'Sydney');                                // 4
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'line');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'line');  // the dismissal outlives the reload
    await visit(page, 'nair', 'Nairobi');                              // 5
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'line');
    await visit(page, 'osl', 'Oslo');                                  // 6 — the next step
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'card');
    await expect(pitchEl(page).locator('strong')).toHaveText('Keep your 6 places?');
    await expect(pitchEl(page)).toContainText('and 4 more');
    // Clearing the history takes the reason for the card away with it.
    await page.locator('#cx-places-clear').click();
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'invite');
});

// ── THE ASK ─────────────────────────────────────────────────────────────────

test('every entry point opens the same dialog, which names the reader’s places and comes back to this one', async ({ page }) => {
    await boot(page, {
        session: doc(place('Paris', 48.86, 2.35), place('Lima', -12.05, -77.04, { at: T0 + 2 })),
        path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo',
    });
    const openers = [
        ['#cx-save-btn', 'Tokyo, Lima and Paris will be waiting in your account.'],   // the place being saved leads
        ['.cx-place-ghost', 'Tokyo, Lima and Paris will be waiting in your account.'],
        ['.cx-pitch-cta', 'Tokyo, Lima and Paris will be waiting in your account.'],
    ];
    for (const [sel, note] of openers) {
        await page.locator(sel).click();
        await expect(gateRoot(page)).toBeVisible();
        await expect(page.locator('#pp-gate-headline')).toHaveText('Keep your places.');
        await expect(page.locator('[data-gate-note]')).toHaveText(note);
        // Sign-in keeps the place: ?next= carries the site the reader is on.
        const href = await page.locator('[data-gate-signin]').getAttribute('href');
        const next = decodeURIComponent(new URL(href, 'http://x').searchParams.get('next'));
        expect(next).toContain('/climalytix.html?');
        expect(next).toContain('lat=35.68');
        expect(next).toContain('name=Tokyo');
        await page.keyboard.press('Escape');
        await expect(gateRoot(page)).toHaveCount(0);
        await expect(page.locator(sel)).toBeFocused();                 // focus returns to what opened it
    }
    // The line's own sign-in link goes back to this place too.
    await page.locator('.cx-pitch-no').click();
    const lineHref = await pitchEl(page).locator('a.cx-pitch-signin').getAttribute('href');
    expect(decodeURIComponent(lineHref)).toContain('lat=35.68');
    await pitchEl(page).locator('.cx-pitch-link').click();
    await expect(gateRoot(page)).toBeVisible();
    // Nothing was saved by any of it.
    expect((await st(page)).places.saved).toEqual([]);
});

// ── THE EMAIL ───────────────────────────────────────────────────────────────

test('a submitted email saves the place and moves everything to a store another tab can see', async ({ page, context }) => {
    const log = await boot(page, { session: doc(place('Paris', 48.86, 2.35)), path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await page.locator('#cx-save-btn').click();
    await page.locator('[data-gate-email]').fill('reader@example.test');
    await page.locator('[data-gate-submit]').click();
    await expect(page.locator('#pp-gate-headline')).toContainText('Check your inbox');
    expect(log.gate).toHaveLength(1);
    expect(log.gate[0].variant).toBe('save-places');
    expect(log.gate[0].resume).toBe('save');
    expect(log.gate[0].next).toContain('lat=35.68');
    await page.locator('[data-gate-done]').click();

    const s = await st(page);
    expect(s.places.scope).toBe('pending');
    expect(s.places.kept).toBe('device');
    expect(s.places.saved).toEqual(['Tokyo']);
    await expect(page.locator('#cx-save-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'pending');
    await expect(pitchEl(page)).toContainText('Check your inbox');
    await expect(page.locator('.cx-pitch-cta, .cx-pitch-link, .cx-place-ghost')).toHaveCount(0);   // they signed up: no second ask
    const keys = await page.evaluate(() => ({
        session: sessionStorage.getItem('pp_climalytix_places_v1'),
        pending: JSON.parse(localStorage.getItem('pp_climalytix_places_v1.pending')).places.map((p) => p.city).sort(),
    }));
    expect(keys).toEqual({ session: null, pending: ['Paris', 'Tokyo'] });

    // The magic link opens in ANOTHER tab: the places are there.
    const other = await context.newPage();
    await installClimalytixMocks(other);
    await other.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await settled(other);
    const o = await st(other);
    expect(o.places.scope).toBe('pending');
    expect(o.places.saved).toEqual(['Tokyo']);
    expect(o.places.recent).toEqual(['Paris']);
    // Saving is no longer gated for them.
    await other.locator('.cx-place[data-kind="recent"] .cx-pl-go').click();
    await expect(other.locator('#cx-site-name')).toHaveText('Paris');
    await other.locator('#cx-save-btn').click();
    await expect(other.locator('#pp-gate-root')).toHaveCount(0);
    await expect(other.locator('#cx-save-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(log.errors).toEqual([]);
});

test('NEGATIVE CONTROL: a failed email submit saves nothing and moves nothing', async ({ page }) => {
    await boot(page, {
        path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo',
        before: () => page.route('**/api/auth/gate-signup', (route) => route.fulfill({ status: 500, json: { error: 'boom' } })),
    });
    await page.locator('#cx-save-btn').click();
    await page.locator('[data-gate-email]').fill('reader@example.test');
    await page.locator('[data-gate-submit]').click();
    await expect(page.locator('[data-gate-error]')).toBeVisible();
    await page.keyboard.press('Escape');
    const s = await st(page);
    expect(s.places.scope).toBe('session');
    expect(s.places.saved).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('pp_climalytix_places_v1.pending'))).toBeNull();
    await expect(page.locator('#cx-save-btn')).toHaveAttribute('aria-pressed', 'false');
});

// ── THE RETURN ──────────────────────────────────────────────────────────────

test('Save → sign in → back: the place is saved as asked, the welcome says so once', async ({ page }) => {
    const log = await boot(page, { session: doc(place('Paris', 48.86, 2.35)), path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await page.locator('#cx-save-btn').click();
    await expect(gateRoot(page)).toBeVisible();
    // The reader leaves to sign in (Google, or the dialog's link) and returns with ?resume=.
    await signIn(page, log);
    await page.goto('/climalytix.html?lat=35.68&lon=139.65&name=Tokyo&resume=save', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect.poll(async () => (await st(page)).places.kept, { timeout: 30_000 }).toBe('account');
    const s = await st(page);
    expect(s.places.saved).toEqual(['Tokyo']);
    expect(s.places.recent).toEqual(['Paris']);
    expect(s.places.resumed).toBe('Tokyo');
    expect(s.places.adopted).toBeGreaterThan(0);
    expect(new URL(page.url()).searchParams.has('resume')).toBe(false);   // the address bar is cleaned
    expect(new URL(page.url()).searchParams.get('name')).toBe('Tokyo');
    await expect(page.locator('#cx-save-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'welcome');
    await expect(pitchEl(page)).toHaveAttribute('data-tone', 'good');
    await expect(pitchEl(page)).toContainText('Tokyo is saved, as you asked');
    await expect(pitchEl(page)).toContainText('now in your account');
    await expect(page.locator('.cx-pitch-cta, .cx-place-ghost')).toHaveCount(0);
    // …and the account row received it.
    await expect.poll(() => log.pushes.length).toBeGreaterThan(0);
    const pushed = log.pushes.at(-1).doc.places.places;
    expect(pushed.find((p) => p.city === 'Tokyo').pin).toBe(1);
    expect(pushed.map((p) => p.city).sort()).toEqual(['Paris', 'Tokyo']);
    // The intent is spent, and the welcome is shown once.
    expect(await page.evaluate(() => sessionStorage.getItem('pp_climalytix_save_intent'))).toBeNull();
    await page.locator('.cx-pitch-no').click();
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'account');
    await expect(pitchEl(page)).toContainText('kept in your account');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect.poll(async () => (await st(page)).places.kept, { timeout: 30_000 }).toBe('account');
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'account');
    expect((await st(page)).places.saved).toEqual(['Tokyo']);
    expect(log.errors).toEqual([]);
});

test('NEGATIVE CONTROL: a dismissed dialog is not a request — signing in later saves nothing', async ({ page }) => {
    const log = await boot(page, { path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await page.locator('#cx-save-btn').click();
    await expect(gateRoot(page)).toBeVisible();
    await page.keyboard.press('Escape');                               // "not now"
    await signIn(page, log);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect.poll(async () => (await st(page)).places.kept, { timeout: 30_000 }).toBe('account');
    const s = await st(page);
    expect(s.places.saved).toEqual([]);
    expect(s.places.resumed).toBeNull();
    expect(s.places.recent).toEqual(['Tokyo']);                        // the visit itself still came along
    await expect(pitchEl(page)).toContainText('1 place from before you signed in is now in your account');
    await expect(pitchEl(page)).not.toContainText('as you asked');
});

test('a stale save-intent (an hour old) is ignored', async ({ page }) => {
    const log = { errors: [], pushes: [] };
    await installClimalytixMocks(page);
    await signIn(page, log);
    await page.addInitScript((old) => {
        localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 40.015, lon: -105.271, city: 'Boulder, CO' }));
        if (!sessionStorage.getItem('__seeded')) {
            sessionStorage.setItem('pp_climalytix_save_intent', JSON.stringify({ lat: 35.68, lon: 139.65, city: 'Tokyo', at: old }));
            sessionStorage.setItem('__seeded', '1');
        }
    }, Date.now() - 61 * 60 * 1000);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect.poll(async () => (await st(page)).places.scope, { timeout: 30_000 }).toBe('account');
    expect((await st(page)).places.saved).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('pp_climalytix_save_intent'))).toBeNull();
});

// ── SIGN-OUT ────────────────────────────────────────────────────────────────

test('signing out of a synced account leaves no location history on the machine', async ({ page }) => {
    await boot(page, { signedIn: {}, session: doc(place('Tokyo', 35.68, 139.65)) });
    await expect.poll(async () => (await st(page)).places.kept, { timeout: 30_000 }).toBe('account');
    expect(await page.evaluate((k) => !!localStorage.getItem(k), USER_KEY)).toBe(true);
    await page.evaluate(async () => { const m = await import('/js/auth.js'); await m.auth.signOut(null); });
    await expect.poll(async () => (await st(page)).places.scope).toBe('session');
    expect(await page.evaluate((k) => localStorage.getItem(k), USER_KEY)).toBeNull();
    const s = await st(page);
    expect(s.places.recent).toEqual([]);
    expect(s.places.saved).toEqual([]);
    await expect(page.locator('#cx-places')).toBeHidden();
    await expect(pitchEl(page)).toHaveAttribute('data-stage', 'invite');
});

test('NEGATIVE CONTROL: with the sync down, sign-out keeps the only copy there is', async ({ page }) => {
    await boot(page, {
        signedIn: {}, session: doc(place('Tokyo', 35.68, 139.65)),
        dashboards: (route) => route.fulfill({ status: 500, json: { message: 'boom' } }),
    });
    await expect.poll(async () => (await st(page)).places.syncState, { timeout: 30_000 }).toBe('error');
    await expect(pitchEl(page)).toHaveAttribute('data-tone', 'warn');
    await expect(pitchEl(page)).not.toContainText('in your account');
    await page.evaluate(async () => { const m = await import('/js/auth.js'); await m.auth.signOut(null); });
    await expect.poll(async () => (await st(page)).places.scope).toBe('session');
    const kept = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), USER_KEY);
    expect(kept.places.map((p) => p.city)).toEqual(['Tokyo']);
    expect((await st(page)).places.recent).toEqual([]);                // …but it is not SHOWN to whoever is signed out
});

test('a paid plan is not required: a FREE account syncs places, while its workspace stays on the device', async ({ page }) => {
    const log = await boot(page, { signedIn: { plan: 'free' }, session: doc(place('Tokyo', 35.68, 139.65)) });
    await expect.poll(async () => (await st(page)).places.kept, { timeout: 30_000 }).toBe('account');
    await expect.poll(() => log.pushes.length).toBeGreaterThan(0);
    expect(log.pushes.every((p) => p.page === 'climalytix-places')).toBe(true);
    expect(log.pushes.some((p) => p.page === 'climalytix'), 'the workspace sync keeps its Basic+ line').toBe(false);
});

// ── HOSTILE INPUT ───────────────────────────────────────────────────────────

test('markup in a place name is text everywhere it is drawn', async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><b>Evil</b>';
    const log = await boot(page, {
        session: doc(place(evil, 10, 10), place('Paris', 48.86, 2.35, { detail: '<i onmouseover="window.__xss=2">x</i>' }), place('Lima', -12.05, -77.04)),
        path: `/climalytix.html?lat=10&lon=10&name=${encodeURIComponent(evil)}`,
        geocode: (route) => route.fulfill({ json: [
            { lat: '1', lon: '1', display_name: evil, address: { city: `${evil}2`, state: '<u>st</u>' } },
            { lat: '2', lon: '2', display_name: 'x', address: { city: '<script>window.__xss=3</script>' } },
        ] }),
    });
    await expect(page.locator('#cx-site-name')).toHaveText(evil);
    await expect(pitchEl(page)).toContainText('<img src=x');           // the card lists it — as text
    await page.locator('#cx-search').fill('img');
    await expect(page.locator('#cx-suggest li[role="option"]').first()).toContainText('<img src=x');
    await page.locator('#cx-search').fill('anything');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-suggest li[data-kind="match"]')).toHaveCount(1);
    await expect(page.locator('#cx-suggest li[data-kind="match"]')).toContainText('<script>');
    await page.keyboard.press('Escape');
    await page.locator('#cx-save-btn').click();
    await expect(page.locator('[data-gate-note]')).toContainText('<img src=x');
    const found = await page.evaluate(() => ({
        xss: window.__xss ?? null,
        // (#cx-brand's own <b> is the page's; in the dialog only the NOTE is ours to check)
        injected: document.querySelectorAll('#cx-site img, #cx-site b:not(#cx-brand b), #cx-site i, #cx-site u, #cx-site script, [data-gate-note] *, #pp-gate-root script').length,
    }));
    expect({ xss: found.xss, injected: found.injected }).toEqual({ xss: null, injected: 0 });
    expect(log.errors).toEqual([]);
});

test('storage that throws does not break the search (private mode, quota)', async ({ page }) => {
    const log = await boot(page, {
        before: () => page.addInitScript(() => {
            const mine = (k) => String(k).startsWith('pp_climalytix_places') || k === 'pp_climalytix_pitch';
            const deny = () => { throw new DOMException('denied', 'QuotaExceededError'); };
            const set = Storage.prototype.setItem, get = Storage.prototype.getItem, del = Storage.prototype.removeItem;
            Storage.prototype.setItem = function (k, v) { if (mine(k)) deny(); return set.call(this, k, v); };
            Storage.prototype.getItem = function (k) { if (mine(k)) deny(); return get.call(this, k); };
            Storage.prototype.removeItem = function (k) { if (mine(k)) deny(); return del.call(this, k); };
        }),
    });
    await visit(page, 'tok', 'Tokyo');
    await visit(page, 'pari', 'Paris');
    const s = await st(page);
    expect(s.places.recent).toEqual(['Paris', 'Tokyo']);               // remembered in memory for this page
    await expect(page.locator('.cx-place[data-kind="recent"]')).toHaveCount(2);
    expect(log.errors).toEqual([]);
});

test('garbage in the local store and in the account row is ignored, field by field', async ({ page }) => {
    const log = await boot(page, {
        signedIn: {},
        before: () => page.addInitScript((k) => {
            sessionStorage.setItem('pp_climalytix_places_v1', '{not json');
            localStorage.setItem(k, JSON.stringify({ v: 99, clearedAt: 'x', places: [null, 7, { lat: 999, lon: 0, city: 'Nowhere' }, { lat: 48.86, lon: 2.35, city: 'Paris', at: 5, pin: 'yes' }] }));
            sessionStorage.setItem('pp_climalytix_pitch', '[]');
            sessionStorage.setItem('pp_climalytix_save_intent', '"tokyo"');
        }, USER_KEY),
        dashboards: (route, req, l) => {
            if (req.method() === 'GET') return route.fulfill({ json: [{ doc: { places: { places: 'nope', clearedAt: -5 } }, updated_at: 'never' }] });
            l.pushes.push(JSON.parse(req.postData())[0]);
            return route.fulfill({ status: 201, json: [] });
        },
    });
    await expect.poll(async () => (await st(page)).places.kept, { timeout: 30_000 }).toBe('account');
    const s = await st(page);
    expect(s.places.saved).toEqual(['Paris']);                         // the one valid record survived
    expect(s.places.recent).toEqual([]);
    await expect.poll(() => log.pushes.length).toBeGreaterThan(0);     // and the cleaned document replaced the garbage row
    expect(log.pushes.at(-1).doc.places.v).toBe(1);
    expect(log.errors).toEqual([]);
});

// ── THE BOX ─────────────────────────────────────────────────────────────────

test('typing never asks the geocoder; Enter asks once; matches are highlighted', async ({ page }) => {
    const log = await boot(page);
    await page.locator('#cx-search').focus();
    await page.keyboard.type('springfield illinois', { delay: 5 });
    await page.waitForTimeout(400);
    expect(log.geocoder).toEqual([]);
    await expect(page.locator('#cx-suggest .cx-sg-everywhere')).toContainText('search everywhere for “springfield illinois”');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText('Springfield');
    expect(log.geocoder).toEqual(['springfield illinois']);
    await page.locator('#cx-search').fill('rey');
    const first = page.locator('#cx-suggest li[role="option"]').first();
    await expect(first.locator('mark')).toHaveText('Rey');
    await expect(first).toContainText('Reykjavík');
});

test('the last of two submits wins, and a dead geocoder says so without moving the site', async ({ page }) => {
    let release;
    const held = new Promise((r) => { release = r; });
    const log = await boot(page, {
        geocode: async (route, url) => {
            const q = url.searchParams.get('q');
            if (q === 'down') return route.fulfill({ status: 503, body: 'no' });
            if (q === 'slow') { await held; return route.fulfill({ json: [{ lat: '1', lon: '1', address: { city: 'Slowtown' } }] }).catch(() => {}); }
            return route.fulfill({ json: [{ lat: '2', lon: '2', address: { city: 'Fastville' } }] });
        },
    });
    await page.locator('#cx-search').fill('slow');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-search-msg')).toHaveText('Searching…');
    await page.locator('#cx-search').fill('fast');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText('Fastville');
    release();
    await page.waitForTimeout(500);
    await expect(page.locator('#cx-site-name')).toHaveText('Fastville');   // the slow answer never lands
    expect((await st(page)).places.recent).toEqual(['Fastville']);

    await page.locator('#cx-search').fill('down');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-search-msg')).toContainText('Geocoder HTTP 503');
    await expect(page.locator('#cx-search-msg')).toHaveAttribute('data-kind', 'warn');
    await expect(page.locator('#cx-site-name')).toHaveText('Fastville');
    await expect(page.locator('#cx-search')).toHaveValue('down');          // the query is kept for a retry
    expect(log.errors).toEqual([]);
});

test('a first visit is offered examples; a reader with places is offered their own', async ({ page }) => {
    await boot(page);
    await page.locator('#cx-search').focus();
    const list = page.locator('#cx-suggest');
    await expect(list).toBeVisible();
    await expect(list.locator('li[data-kind="home"]')).toHaveCount(1);
    await expect(list.locator('li[data-kind="example"]')).toHaveCount(5);
    await expect(list).toContainText('Try a place');
    await list.locator('li[data-kind="example"]', { hasText: 'Nairobi' }).dispatchEvent('pointerdown');
    await expect(page.locator('#cx-site-name')).toHaveText('Nairobi');
    await expect(list).toBeHidden();
    await page.locator('#cx-search').click();                              // still focused: a click reopens it
    await expect(list.locator('li[data-kind="recent"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowDown');                                // …and so does the arrow key
    await expect(list).toBeVisible();
    await expect(list.locator('li[data-kind="example"]')).toHaveCount(0);  // theirs, not ours
});

test('the search box is a real combobox: ARIA, wrap-around arrows, Escape, the site clock', async ({ page }) => {
    await boot(page, { session: doc(place('Tokyo', 35.68, 139.65), place('Paris', 48.86, 2.35, { at: T0 + 1 })) });
    const input = page.locator('#cx-search');
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-controls', 'cx-suggest');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#cx-suggest')).toHaveAttribute('role', 'listbox');
    const options = page.locator('#cx-suggest li[role="option"]');
    const n = await options.count();
    expect(n).toBe(3);                                                     // Home + two recents
    expect(await input.getAttribute('aria-activedescendant')).toBeNull();
    for (let i = 0; i < n; i++) {
        await page.keyboard.press('ArrowDown');
        const id = await input.getAttribute('aria-activedescendant');
        expect(id).toBe(`cx-sg-${i}`);
        await expect(page.locator(`#${id}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#cx-suggest li[aria-selected="true"]')).toHaveCount(1);
    }
    await page.keyboard.press('ArrowDown');                                // past the end: back to the typed text
    expect(await input.getAttribute('aria-activedescendant')).toBeNull();
    await page.keyboard.press('ArrowUp');                                  // and up from there: the last row
    expect(await input.getAttribute('aria-activedescendant')).toBe(`cx-sg-${n - 1}`);
    await page.keyboard.press('Escape');
    await expect(page.locator('#cx-suggest')).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    // "/" typed INTO a field is a character, not a shortcut.
    await input.fill('');
    await page.keyboard.type('a/b');
    await expect(input).toHaveValue('a/b');
    // The site's own clock, from the datasets' UTC offset.
    await expect(page.locator('#cx-site-time')).toHaveText(/^\d\d:\d\d local$/);
    await expect(page.locator('#cx-site-time')).toHaveAttribute('title', /UTC[+−]\d/);
});

test('phone: the card and its button fit, are thumb-sized, and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, {
        session: doc(place('Tokyo', 35.68, 139.65), place('Paris', 48.86, 2.35, { at: T0 + 1 }), place('A very long place name that goes on and on, Somewhere', -12.05, -77.04, { at: T0 + 2 })),
        path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo',
    });
    await expect(pitchEl(page)).toHaveAttribute('data-kind', 'card');
    for (const sel of ['.cx-pitch-cta', '#cx-search', '#cx-locate', '#cx-search-form button[type="submit"]']) {
        const b = await page.locator(sel).boundingBox();
        expect(b.height, `${sel} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    const card = await pitchEl(page).boundingBox();
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.locator('.cx-pitch-cta').click();
    const dialog = await page.locator('#pp-gate-root .pp-gate-card').boundingBox();
    expect(dialog.x).toBeGreaterThanOrEqual(0);
    expect(dialog.x + dialog.width).toBeLessThanOrEqual(390);
});
