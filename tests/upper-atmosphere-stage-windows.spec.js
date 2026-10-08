/**
 * upper-atmosphere-stage-windows.spec.js — every panel is a window, and
 * Basic+ remembers the arrangement
 * ═══════════════════════════════════════════════════════════════════════════
 * Hermetic (the feeds fixture). Pins (plan §9.16):
 *   • every dock carries a title bar and a grip; dragging the time dock's
 *     bar moves the dock and the entry is stored RELATIVE TO ITS CORNER;
 *     folding the render dock leaves only its bar; ⌂ sends it home with
 *     every inline style gone; the camera dock resizes from its grip;
 *   • MEMORY IS THE TIER GATE: as a Basic account the layout is written to
 *     localStorage and survives a reload (the dock lands within 2 px of the
 *     same corner offsets); as a free account nothing is stored and a reload
 *     is home — NEGATIVE CONTROL for the gate;
 *   • the ⧉ menu says which of the two it is and "every panel home" clears;
 *   • a window that was moved is re-placed from its corner when the stage
 *     resizes (the anchoring rule), and stays inside the stage.
 */

import { test, expect } from '@playwright/test';
import { routeUpperAtmosphereFeeds } from './fixtures/upper-atmosphere-feeds.mjs';

const URL = '/upper-atmosphere.html';
const KEY = 'pp-stage-layout.upper-atmosphere-stage';
test.describe.configure({ timeout: 240_000 });

async function boot(page, { plan = null, viewport = { width: 1440, height: 900 } } = {}) {
    await page.setViewportSize(viewport);
    await routeUpperAtmosphereFeeds(page);
    await page.route('**/api/donki/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.route('**/rest/v1/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    if (plan) {
        await page.addInitScript((plan) => {
            // The account mirror auth.js keeps for legacy modules (CLAUDE.md §6).
            localStorage.setItem('pp_auth', JSON.stringify({ signedIn: true, id: 'test-user', plan, role: 'user', email: 't@example.com' }));
        }, plan);
    }
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.stageWindows, null, { timeout: 60_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) await consent.locator('[data-action="reject"]').click().catch(() => {});
    await page.evaluate(() => { const g = window.__ua.globe; g.setManualClock(true, { startMs: 1.0e6 }); });
    await page.waitForTimeout(300);
}
const rect = (page, sel) => page.evaluate((sel) => {
    const s = document.getElementById('ua-globe-wrap').getBoundingClientRect();
    const r = document.querySelector(sel).getBoundingClientRect();
    return { left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height, right: s.width - (r.right - s.left), bottom: s.height - (r.bottom - s.top), x: r.left, y: r.top };
}, sel);
async function dragBar(page, sel, dx, dy) {
    const bar = await page.locator(`${sel} > .ua-win-bar`).boundingBox();
    // Press on the grip/title, left of the fold / home buttons (a narrow bar
    // such as the time dock's is ~104 px and its buttons start at ~64).
    const x = bar.x + 18, y = bar.y + bar.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + dx * i / 8, y + dy * i / 8);
    await page.mouse.up();
    await page.waitForTimeout(100);
}
const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY);

test('bars on every dock; drag moves and anchors, fold leaves the bar, home clears, the grip resizes', async ({ page }) => {
    await boot(page, { plan: 'basic' });
    for (const id of ['ua-camera-hud', 'ua-render-dock', 'ua-time-dock', 'ua-explore-gauge', 'ua-flight-deck']) {
        expect(await page.locator(`#${id} > .ua-win-bar`).count(), `${id} has a bar`).toBe(1);
    }
    expect(await page.evaluate(() => window.__ua.stageWindows.memoryState())).toBe('remembered');

    // Fold the render dock: the toolbar hides, its bar stays, the entry says so.
    await page.click('#ua-render-dock > .ua-win-bar [data-win-act="fold"]');
    await expect(page.locator('#ua-atmo-controls')).toBeHidden();
    await expect(page.locator('#ua-render-dock > .ua-win-bar')).toBeVisible();
    expect((await stored(page)).panels.render.open).toBe(false);
    // Home: every inline style gone, back at the CSS home, no entry.
    await page.click('#ua-render-dock > .ua-win-bar [data-win-act="home"]');
    await expect(page.locator('#ua-atmo-controls')).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('ua-render-dock').getAttribute('style') || '')).not.toMatch(/left|top|width/);
    expect((await stored(page))?.panels?.render).toBeUndefined();   // a home layout is not stored at all

    // Drag the time dock up by 160 px (after the render dock went home: the
    // raised dock would cover its bar): it moves, stored against a bottom corner.
    const before = await rect(page, '#ua-time-dock');
    await dragBar(page, '#ua-time-dock', 0, -160);
    const after = await rect(page, '#ua-time-dock');
    expect(Math.abs((before.top - after.top) - 160)).toBeLessThan(3);
    // The dock spans the stage, so its centre sits on the midline and either
    // bottom corner is the nearest; the offsets are measured from that one.
    const doc = await stored(page);
    expect(['bl', 'br']).toContain(doc.panels.time.anchor);
    expect(Math.abs(doc.panels.time.dy - after.bottom)).toBeLessThanOrEqual(2.5);   // offsets are stored rounded
    expect(Math.abs(doc.panels.time.dx - (doc.panels.time.anchor === 'bl' ? after.left : after.right))).toBeLessThanOrEqual(2.5);

    // Resize the camera dock from its grip: +80 px wide.
    const w0 = (await rect(page, '#ua-camera-hud')).w;
    const grip = await page.locator('#ua-camera-hud > .ua-win-resize').boundingBox();
    await page.mouse.move(grip.x + 6, grip.y + 6);
    await page.mouse.down();
    await page.mouse.move(grip.x + 86, grip.y + 6, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const w1 = (await rect(page, '#ua-camera-hud')).w;
    expect(Math.abs((w1 - w0) - 80)).toBeLessThan(3);
    expect(Math.abs((await stored(page)).panels.camera.w - w1)).toBeLessThanOrEqual(2.5);
});

test('memory is the tier gate: Basic survives a reload, free resets (negative control)', async ({ page }) => {
    await boot(page, { plan: 'basic' });
    await dragBar(page, '#ua-time-dock', 40, -200);
    const moved = await rect(page, '#ua-time-dock');
    expect(await stored(page)).not.toBeNull();
    await page.reload();
    await page.waitForFunction(() => !!window.__ua?.stageWindows, null, { timeout: 60_000 });
    await page.waitForTimeout(600);
    const again = await rect(page, '#ua-time-dock');
    expect(Math.abs(again.left - moved.left)).toBeLessThan(2);
    expect(Math.abs(again.bottom - moved.bottom)).toBeLessThan(2);
    // The ⧉ menu says so, and "every panel home" clears the store.
    await page.click('#ua-layout-btn');
    await expect(page.locator('#ua-layout-state')).toHaveAttribute('data-state', 'remembered');
    await page.click('#ua-layout-menu [data-layout="home"]');
    expect(await stored(page)).toBeNull();
    const home = await rect(page, '#ua-time-dock');
    expect(Math.abs(home.bottom - 12)).toBeLessThan(2);

    // NEGATIVE CONTROL: a free account arranges for the session only.
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await boot(page, { plan: 'free' });
    expect(await page.evaluate(() => window.__ua.stageWindows.memoryState())).toBe('session');
    await dragBar(page, '#ua-time-dock', 0, -150);
    expect((await rect(page, '#ua-time-dock')).bottom).toBeGreaterThan(100);
    expect(await stored(page)).toBeNull();
    await page.click('#ua-layout-btn');
    await expect(page.locator('#ua-layout-state')).toHaveAttribute('data-state', 'session');
    await expect(page.locator('#ua-layout-state')).toContainText('Basic');
    await page.reload();
    await page.waitForFunction(() => !!window.__ua?.stageWindows, null, { timeout: 60_000 });
    await page.waitForTimeout(600);
    expect(Math.abs((await rect(page, '#ua-time-dock')).bottom - 12)).toBeLessThan(2);
});

test('a moved window is re-placed from its corner when the stage resizes, and stays inside it', async ({ page }) => {
    await boot(page, { plan: 'basic', viewport: { width: 1920, height: 1080 } });
    // The camera dock, a little off the top-right.
    await dragBar(page, '#ua-camera-hud', -60, 40);
    const big = await rect(page, '#ua-camera-hud');
    expect(Math.abs(big.right - 72)).toBeLessThan(4);
    expect(Math.abs(big.top - 52)).toBeLessThan(4);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(500);
    const small = await rect(page, '#ua-camera-hud');
    expect(Math.abs(small.right - 72), 'same distance from the top-right corner').toBeLessThan(4);
    expect(Math.abs(small.top - 52)).toBeLessThan(4);
    // Dragged far off the stage: clamped so a grab's worth stays on it.
    await dragBar(page, '#ua-camera-hud', 2000, 2000);
    const stage = await page.evaluate(() => { const r = document.getElementById('ua-globe-wrap').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    const far = await rect(page, '#ua-camera-hud');
    expect(far.left).toBeLessThanOrEqual(stage.w - 36 + 1);
    expect(far.top).toBeLessThanOrEqual(stage.h - 36 + 1);
});
