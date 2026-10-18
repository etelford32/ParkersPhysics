/**
 * satellite-designer-smoke.spec.js — browser gate for Storm Pilot
 * (satellite-designer.html; the old parts-bay designer was replaced by the game).
 *
 * Hermetic: telemetry beacons are answered locally and nothing needs NOAA or
 * Supabase (a guest plays with session-only progress). Runs are driven through
 * `window.__stormPilot` with fixed seeds so they are reproducible.
 */
import { test, expect } from '@playwright/test';

const URL = '/satellite-designer.html';

async function boot(page) {
    await page.route('**/api/telemetry/**', (r) => r.fulfill({ status: 204, body: '' }));
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__stormPilot, { timeout: 15_000 });
    const reject = page.locator('button[data-action="reject"]').first();
    if (await reject.count()) await reject.click();
}
function recordErrors(page) {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return errors;
}

test.describe('Storm Pilot (satellite-designer.html)', () => {
    test('boots to the world map without errors', async ({ page }) => {
        const errors = recordErrors(page);
        await boot(page);
        await expect(page.locator('#sp-title')).toBeVisible();
        await expect(page.locator('#sp-map .sp-node')).toHaveCount(5);
        await expect(page.locator('#sp-levels .sp-lv')).toHaveCount(4);          // Earth: levels 1, 2, 7, 8
        await expect(page.locator('#sp-levels .sp-lv.lock')).toHaveCount(3);     // only Shakedown is open
        await expect(page.locator('#sp-b-save')).toBeVisible();                  // guests are told progress is not saved
        await page.waitForTimeout(800);
        const real = errors.filter((e) => !/supabase|jsdelivr|Failed to fetch|net::ERR|status of 50[13]/i.test(e));
        expect(real, real.join('\n')).toHaveLength(0);
    });

    test('map → hangar → launch → the run advances and the HUD reads real numbers', async ({ page }) => {
        await boot(page);
        await page.click('#sp-b-play');
        await expect(page.locator('#sp-hangar')).toBeVisible();
        await expect(page.locator('#sp-ships .sp-ship')).toHaveCount(4);
        await expect(page.locator('#sp-ships .sp-ship.lock')).toHaveCount(1);    // Dawn needs 12 stars
        await page.click('#sp-ships .sp-ship[data-ship="wren"]');
        await expect(page.locator('#sp-ships .sp-ship[data-ship="wren"]')).toHaveClass(/\bon\b/);
        await page.click('#sp-b-launch');
        await expect(page.locator('#sp-hud')).toBeVisible();

        await page.keyboard.press('Digit2');                                     // autopilot prograde
        await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
        await page.waitForFunction(() => window.__stormPilot.game.t > 2, null, { timeout: 15_000 });
        const g = await page.evaluate(() => { const G = window.__stormPilot.game; return { ship: G.ship.id, sas: G.sas, fuel: G.fuel }; });
        expect(g.ship).toBe('wren');
        expect(g.sas).toBe('pro');
        expect(g.fuel).toBeLessThan(100);                                        // the burn used propellant
        const tele = await page.locator('#sp-tele').textContent();
        const alt = Number(/ALT ([\d,]+)/.exec(tele)[1].replace(/,/g, ''));
        expect(alt).toBeGreaterThan(400); expect(alt).toBeLessThan(3000);         // a real LEO altitude
        await expect(page.locator('#sp-tele')).toContainText('TRACKED DEBRIS');
    });

    test('a severe storm compresses the magnetopause and the HUD says so', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {                                              // fast-forward 30 s of sim time
            const SP = window.__stormPilot, G = SP.start({ level: 2, ship: 'atlas', seed: 11 });
            G.frags = [];
            while (G.t < 30 && !G.done) SP.sim.stepGame(G, {}, 1 / 120);
        });
        await page.waitForTimeout(300);                                          // one HUD frame
        const so = await page.evaluate(() => window.__stormPilot.sim.standoffRadii(window.__stormPilot.game.planet, window.__stormPilot.game.S.P));
        expect(so).toBeLessThan(7);                                              // 10 R⊕ quiet → ~5 R⊕ at P×60
        await expect(page.locator('#sp-tele')).toContainText('MAGNETOPAUSE');
    });

    test('pause shows the controls and the game-scale disclosure; Esc resumes', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => window.__stormPilot.start({ level: 1, ship: 'kestrel', seed: 2 }));
        await page.keyboard.press('Escape');
        await expect(page.locator('#sp-pause')).toBeVisible();
        await expect(page.locator('#sp-scale-note')).toContainText('Chapman');
        await expect(page.locator('#sp-scale-note')).toContainText('real breakup altitudes');
        const t0 = await page.evaluate(() => window.__stormPilot.game.t);
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => window.__stormPilot.game.t)).toBe(t0);    // paused means paused
        await page.keyboard.press('Escape');
        await expect(page.locator('#sp-pause')).toBeHidden();
    });

    test('winning a level shows stars, the real story, and unlocks the next level for the session', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => window.__stormPilot.start({ level: 1, ship: 'kestrel', seed: 2 }));
        await page.evaluate(() => window.__stormPilot.finish());
        await expect(page.locator('#sp-debrief')).toBeVisible();
        await expect(page.locator('#sp-d-title')).toHaveText('Mission complete');
        await expect(page.locator('#sp-d-real')).toContainText('Hohmann');
        await expect(page.locator('#sp-d-real')).toContainText('Iridium');       // the debris cloud's true story
        await expect(page.locator('#sp-d-save')).toBeVisible();                  // guests are offered a save
        await expect(page.locator('#sp-b-next')).toBeVisible();
        await page.click('#sp-b-map');
        await expect(page.locator('#sp-levels .sp-lv[data-level="2"]')).not.toHaveClass(/lock/);
        const guest = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pp_storm_pilot_guest')));
        expect(guest.stars['1']).toBeGreaterThan(0);
        expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pp_storm_pilot')).length)).toBe(0);
    });

    test('a fast debris strike snaps a wing off and the wing becomes debris', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const SP = window.__stormPilot, G = SP.start({ level: 2, ship: 'atlas', seed: 5 });
            G.frags = []; G.t = 3; G.rng = () => 0.1;
            const a = Math.PI / 2 - 0.12, r = Math.hypot(G.x, G.y), v = Math.sqrt(0.06 / r);
            G.frags.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, vx: -Math.sin(a) * v, vy: Math.cos(a) * v, spin: 0, ws: 0, sz: 3, cloud: 'kosmos1408', seed: 0.5 });
        });
        await page.waitForFunction(() => window.__stormPilot.game.wingsLost === 1, null, { timeout: 10_000 });
        await expect(page.locator('#sp-alert')).toContainText(/WING SHEARED|DEBRIS STRIKE/);
        expect(await page.evaluate(() => window.__stormPilot.game.frags.some((f) => f.wing))).toBe(true);
    });

    test('touch controls drive the ship (phone width)', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 780 });
        await boot(page);
        await page.evaluate(() => window.__stormPilot.start({ level: 1, ship: 'kestrel', seed: 2 }));
        const thrust = page.locator('.sp-key[data-k="thrust"]');
        await expect(thrust).toBeVisible();
        const box = await thrust.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.waitForTimeout(500); await page.mouse.up();
        expect(await page.evaluate(() => window.__stormPilot.game.fuel)).toBeLessThan(100);
        await page.click('.sp-key[data-k="shield"]');
        expect(await page.evaluate(() => window.__stormPilot.game.shield)).toBe(true);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });
});
