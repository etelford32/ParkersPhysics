/**
 * launch-planner-boot.spec.js — review how the launch planner's 3D stage
 * LOADS, not just how it looks once it has settled.
 *
 * THE BUG THIS EXISTS FOR (2026-11-02): "it zooms in on the scaffolding
 * immediately". It had been reported, "fixed" twice (the resize comments in
 * js/launch-vehicle-3d.js) and kept coming back, because every gate loaded
 * the page, waited, and judged the final frame. None of them did what a
 * visitor does first: scroll. The canvas covers ~70 % of a 1440×900 screen
 * and preventDefault-ed every wheel event, so scrolling down the page dollied
 * the camera OUT, scrolling back up dollied it IN (124 m → 50 m: a frame full
 * of service-structure scaffolding), the page itself never moved, and the
 * wheel CLAIMED the camera, which switches off every later auto-reframe.
 *
 * HOW: the page records every camera mutation with its reason —
 * `api.cameraTrace` (vehicle swap, resize, safe-inset change, preset flight,
 * auto-pick, the first input that claims the camera, wheel pass-through, and
 * every rendered frame whose pose moved). That record is frame-rate
 * independent, which matters: this sandbox renders the page at ~1 fps, so a
 * screenshot-based review never sees a load-time transient at all.
 *
 * Every boot is reviewed against the same rules (`reviewBoot`):
 *   · nothing claimed the camera that the scenario did not do on purpose;
 *   · once the final vehicle was built, no recorded pose came closer than
 *     0.8 × the distance it settled at — "it zooms in at load" in numbers;
 *   · the pose it settled on IS the preset framing (a recenter lands within
 *     2 % of it) and passes the foreground-clutter + occlusion limits;
 *   · it stays settled — no pose change once boot is over.
 * Scenarios: idle boot at three desktop sizes, boot WITH a launch roster (the
 * feed is egress-blocked here, so the auto-select-first-launch path had never
 * run in a test), wheel-scrolling the page during and after load, deliberate
 * zoom (click-then-wheel, ctrl+wheel), and a returning visitor whose panel
 * was saved collapsed.
 *
 * The roster scenario found a SECOND bug on its first run: picking a launch
 * never changed the 3D vehicle (the "already showing?" check read a lit
 * variant button, and every variant row keeps its default lit), fixed in
 * launch-planner.html to ask `api.currentVehicle`.
 *
 * NEGATIVE CONTROL: `?lpwheel=capture` restores the old always-capture wheel.
 * The scroll scenario must then FAIL — page stuck at 0, camera claimed and
 * moved — or the scroll checks prove nothing.
 */
import { test, expect } from '@playwright/test';

const DESKTOPS = [[1440, 900], [1366, 768], [1920, 1080]];

// A realistic /api/launches/upcoming payload (shape of api/launches/upcoming.js
// project()). The first launch is auto-selected on load and swaps the stage
// to its vehicle — the path the dead feed had always skipped.
function launchFeed() {
    const iso = (h) => new Date(Date.now() + h * 3600e3).toISOString();
    const L = (id, name, vehicle, provider, pad, h) => ({
        id, name, slug: id, status: 'Go', status_name: 'Go for Launch', mission: '', mission_type: 'Communications',
        orbit: 'LEO', vehicle, vehicle_family: '', provider, provider_type: 'Commercial',
        pad: { name: pad[0], lat: pad[1], lon: pad[2], location: pad[3], country_code: 'USA', wiki: '' },
        net_iso: iso(h), window_start_iso: iso(h), window_end_iso: iso(h + 2), probability_pct: 90, image: '', info_url: '',
    });
    return {
        launches: [
            L('f9-starlink', 'Falcon 9 Block 5 | Starlink Group 12-3', 'Falcon 9', 'SpaceX', ['Space Launch Complex 40', 28.5618, -80.577, 'Cape Canaveral SFS, FL, USA'], 30),
            L('electron-1', 'Electron | Test Mission', 'Electron', 'Rocket Lab', ['Rocket Lab Launch Complex 1A', -39.26, 177.86, 'Mahia Peninsula, New Zealand'], 50),
            L('starship-x', 'Starship | Flight 14', 'Starship', 'SpaceX', ['Orbital Launch Mount A', 25.997, -97.157, 'SpaceX Starbase, TX, USA'], 90),
            L('fh-1', 'Falcon Heavy | USSF-X', 'Falcon Heavy', 'SpaceX', ['Launch Complex 39A', 28.608, -80.604, 'Kennedy Space Center, FL, USA'], 140),
        ],
        fetched_at: new Date().toISOString(),
    };
}

async function boot(page, { query = '?lpfx=off', feed = false, storage = null, beforeApi = null } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.route('**/api/telemetry/log', (r) => r.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
    if (feed) {
        await page.route('**/api/launches/upcoming**', (r) =>
            r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(launchFeed()) }));
    }
    // Weather / NWS answer at once with the page's own "upstream down" shape:
    // the dev server's proxies otherwise hang on their egress-blocked
    // upstreams, and the roster's auto-select waits on the first launch's
    // weather.
    const down = (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' });
    await page.route('**/api/weather/**', down);
    await page.route('**/api/nws/**', down);
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    if (storage) await page.addInitScript((s) => { try { localStorage.setItem('lp:ui-state-v1', JSON.stringify(s)); } catch {} }, storage);
    // Keep the cookie banner from covering the stage (it is not under test).
    await page.addInitScript(() => {
        const css = '#pp-cookie-banner,.cookie-banner,[class*="privacy-choices"],[id*="cookie"],[class*="consent"]{display:none!important}';
        document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); });
    });
    await page.goto('/launch-planner.html' + query, { waitUntil: 'domcontentloaded' });
    if (beforeApi) await beforeApi();
    await page.waitForFunction(() => window.__lpVehicle3d?.cameraTrace, null, { timeout: 90_000 });
    return errors;
}

const getTrace = (page) => page.evaluate(() => window.__lpVehicle3d.cameraTrace);
const structural = (tr) => tr.filter((e) => e.reason !== 'frame');

// Wait until boot is over: no structural trace entry (resize, insets, vehicle,
// preset…) for `quietMs`, and no camera flight in progress.
async function waitSettled(page, { quietMs = 3000, timeout = 90_000 } = {}) {
    const t0 = Date.now();
    let lastLen = -1, quietSince = Date.now();
    while (Date.now() - t0 < timeout) {
        const { n, tweening } = await page.evaluate(() => ({
            n: window.__lpVehicle3d.cameraTrace.filter((e) => e.reason !== 'frame').length,
            tweening: window.__lpVehicle3d.isTweening,
        }));
        if (n !== lastLen || tweening) { lastLen = n; quietSince = Date.now(); }
        else if (Date.now() - quietSince >= quietMs) return;
        await page.waitForTimeout(250);
    }
    throw new Error('stage never settled');
}

// The shared review. `allowClaims` lists claim reasons the scenario caused on purpose.
async function reviewBoot(page, label, { allowClaims = [], expectVehicle = null } = {}) {
    const trace = await getTrace(page);
    const final = trace[trace.length - 1];
    const claims = trace.filter((e) => e.reason.startsWith('claim:')).map((e) => e.reason);
    expect(claims.filter((c) => !allowClaims.includes(c)), `${label}: unrequested camera claims`).toEqual([]);
    expect(final.user, `${label}: camera ended user-owned`).toBe(allowClaims.length > 0);
    if (expectVehicle) expect(final.vehicle, `${label}: vehicle`).toBe(expectVehicle);

    // Never closer than the settled framing once the final vehicle exists.
    const builtAt = trace.findLastIndex((e) => e.reason === 'vehicle' && e.vehicle === final.vehicle);
    expect(builtAt, `${label}: the final vehicle was built`).toBeGreaterThanOrEqual(0);
    const after = trace.slice(builtAt);
    const closest = after.reduce((m, e) => (e.dist < m.dist ? e : m), after[0]);
    expect(closest.dist / final.dist,
        `${label}: zoomed in to ${closest.dist} m (${closest.reason} at t=${closest.t} ms) before settling at ${final.dist} m`)
        .toBeGreaterThanOrEqual(0.8);

    // It stays settled.
    const n0 = trace.length;
    await page.waitForTimeout(2500);
    const later = (await getTrace(page)).slice(n0);
    expect(later.filter((e) => e.reason !== 'wheel-pass'), `${label}: the camera kept moving after boot`).toEqual([]);

    // The settled frame is clean and IS the preset framing.
    const m = await page.evaluate(() => ({ fg: window.__lpVehicle3d.measureForeground(), occ: window.__lpVehicle3d.measureOcclusion() }));
    expect(m.fg.ok, `${label}: foreground clutter ${JSON.stringify(m.fg.items)}`).toBe(true);
    expect(m.occ.ok, `${label}: vehicle hidden ${JSON.stringify(m.occ.examples)}`).toBe(true);
    if (!allowClaims.length) {
        const recentered = await page.evaluate(async () => {
            const a = window.__lpVehicle3d;
            a.recenter();
            await new Promise((r) => { const t = () => (a.isTweening ? setTimeout(t, 80) : r()); setTimeout(t, 80); });
            return a.renderStats.distance;
        });
        expect(Math.abs(recentered - final.dist) / final.dist, `${label}: settled ${final.dist} m vs preset ${recentered} m`).toBeLessThan(0.02);
    }
    return { trace, final };
}

async function scrollOverStage(page, dy, n = 8) {
    const vp = page.viewportSize();
    await page.mouse.move(vp.width / 2, vp.height * 0.6);
    for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(100); }
}

test.describe('launch-planner 3D: the boot sequence', () => {
    test.setTimeout(300_000);

    test('idle boot at three desktop sizes: nothing moves the camera that nobody asked for', async ({ browser }) => {
        for (const [w, h] of DESKTOPS) {
            const ctx = await browser.newContext({ viewport: { width: w, height: h } });
            const page = await ctx.newPage();
            const errors = await boot(page);
            await page.evaluate(() => {
                const el = document.querySelector('.lh-vehicle-canvas-host');
                window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
            });
            await waitSettled(page);
            const { trace } = await reviewBoot(page, `${w}×${h}`, { expectVehicle: 'shuttle' });
            console.log(`[${w}×${h}]`, structural(trace).map((e) => `${e.t}ms ${e.reason} d=${e.dist}`).join(' · '));
            expect(errors).toEqual([]);
            await ctx.close();
        }
    });

    test('boot with a launch roster: the first launch swaps the stage, framed and unclaimed', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = await boot(page, { feed: true });
        await page.waitForFunction(() => window.__lpVehicle3d.cameraTrace.some((e) => e.reason === 'vehicle' && e.vehicle === 'falcon9'),
            null, { timeout: 120_000 });
        await waitSettled(page);
        const { trace } = await reviewBoot(page, 'with roster', { expectVehicle: 'falcon9' });
        console.log('[roster]', structural(trace).map((e) => `${e.t}ms ${e.reason}${e.vehicle ? ':' + e.vehicle : ''} d=${e.dist}`).join(' · '));
        expect(errors).toEqual([]);
    });

    test('scrolling the page over the stage scrolls the PAGE and leaves the camera alone', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // A visitor who starts scrolling while the page is still loading…
        const errors = await boot(page, { beforeApi: () => scrollOverStage(page, 120, 4) });
        await waitSettled(page);
        // …and keeps going, down and back up, once it has loaded.
        const y0 = await page.evaluate(() => scrollY);
        await scrollOverStage(page, 120);
        const yDown = await page.evaluate(() => scrollY);
        expect(yDown, 'the page scrolled down').toBeGreaterThan(y0 + 200);
        await scrollOverStage(page, -120, 12);
        const yUp = await page.evaluate(() => scrollY);
        expect(yUp, 'the page scrolled back up').toBeLessThan(yDown - 200);
        await reviewBoot(page, 'page scroll');
        const passes = (await getTrace(page)).filter((e) => e.reason === 'wheel-pass').length;
        expect(passes, 'wheel pass-through was recorded').toBeGreaterThan(0);
        expect(errors).toEqual([]);
    });

    test('a deliberate zoom still works: click-then-wheel, and ctrl+wheel (trackpad pinch)', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        await page.evaluate(() => {
            const el = document.querySelector('.lh-vehicle-canvas-host');
            window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
        });
        await waitSettled(page);
        const box = await page.locator('#lh-vehicle-canvas').boundingBox();
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        const d0 = await page.evaluate(() => window.__lpVehicle3d.renderStats.distance);
        await page.mouse.click(cx, cy);
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(400);
        const d1 = await page.evaluate(() => window.__lpVehicle3d.renderStats.distance);
        expect(d1, 'click-then-wheel zoomed in').toBeLessThan(d0 * 0.95);
        // Leave the canvas (disengages), come back, pinch.
        await page.mouse.move(5, 5);
        await page.mouse.move(cx, cy);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, 200);
        await page.keyboard.up('Control');
        await page.waitForTimeout(400);
        const d2 = await page.evaluate(() => window.__lpVehicle3d.renderStats.distance);
        expect(d2, 'ctrl+wheel zoomed out').toBeGreaterThan(d1 * 1.05);
        const claims = (await getTrace(page)).filter((e) => e.reason.startsWith('claim:')).map((e) => e.reason);
        expect(claims).toEqual(['claim:wheel']);
    });

    test('returning visitor: panel saved collapsed, then expanded — framed on expand', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = await boot(page, { storage: { 'collapse:vehicle': true, camHintSeen: true } });
        await page.click('#lp-vehicle .lp-collapse-hd');
        await page.evaluate(() => {
            const el = document.querySelector('.lh-vehicle-canvas-host');
            window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
        });
        await waitSettled(page);
        await reviewBoot(page, 'expanded after collapsed load', { expectVehicle: 'shuttle' });
        expect(errors).toEqual([]);
    });

    // NEGATIVE CONTROL — with the old always-capture wheel the scroll checks must fail.
    test('negative control: ?lpwheel=capture reproduces the scaffolding zoom', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, { query: '?lpfx=off&lpwheel=capture' });
        await waitSettled(page);
        const d0 = await page.evaluate(() => window.__lpVehicle3d.renderStats.distance);
        await scrollOverStage(page, -120, 8);
        await page.waitForTimeout(600);
        const r = await page.evaluate(() => ({
            y: scrollY, d: window.__lpVehicle3d.renderStats.distance,
            claims: window.__lpVehicle3d.cameraTrace.filter((e) => e.reason.startsWith('claim:')).map((e) => e.reason),
        }));
        console.log('[negative control]', JSON.stringify({ d0, ...r }));
        expect(r.claims, 'the wheel claimed the camera').toContain('claim:wheel');
        expect(r.d, 'the camera dollied in (the scaffolding close-up)').toBeLessThan(d0 * 0.8);
        let reviewFailed = false;
        try { await reviewBoot(page, 'capture'); } catch { reviewFailed = true; }
        expect(reviewFailed, 'the shared review must flag it').toBe(true);
    });
});
