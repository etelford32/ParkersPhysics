/**
 * bootes-void-nbody.spec.js — browser gate for the galaxy tracker's
 * "N-body forecast" mode on bootes-void.html.
 *
 * Run: npx playwright test tests/bootes-void-nbody.spec.js
 *
 * The physics is pinned in node (tests/bootes-nbody.mjs). This checks what
 * only a browser can: that the run happens in a Worker and lands, that the
 * N-body future JOINS the shell tracker at the observed epoch (position and
 * velocity) and leaves the past untouched, that the stage's field and web are
 * the run's particles after z_obs and are put back exactly at z_obs, that a
 * galaxy tracked after the run is flown through the stored matter, and that
 * with no Worker the page computes the IDENTICAL forecast itself.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/bootes-void.html';
const RUN_TIMEOUT = 150_000;

async function ready(page) {
    await page.goto(PAGE);
    await page.waitForFunction(
        () => document.querySelector('#bv-track-card')?.dataset.trackReady === '1',
        null, { timeout: 25000 });
}

async function runNbody(page) {
    await page.selectOption('[data-bv-track="mode"]', 'nbody');
    await page.waitForFunction(
        () => document.querySelector('#bv-track-card')?.dataset.nbody === 'ready',
        null, { timeout: RUN_TIMEOUT });
}

const text = (page, key) => page.locator(`[data-bv="${key}"]`).first().textContent();

/** Galaxy A at time t: the composed (N-body) sample and the shell tracker's. */
const sampleA = (page, t) => page.evaluate((tt) => {
    const tr = window.__bootesLab.tracker;
    const tl = tr.timeline;
    const k = tl.epochs.reduce((best, e, i) => (Math.abs(e.tGyr - tt) < Math.abs(tl.epochs[best].tGyr - tt) ? i : best), 0);
    const ep = tl.epochs[k];
    const g = tr.tracked[0];
    const pick = (s) => ({ pos: s.positionMpc, v: s.vKms, g: s.gA, nbody: !!s.nbody, tGyr: s.tGyr });
    return { main: pick(g.main.at(ep)), shell: pick(g.linear.at(ep)) };
}, t);

test.describe('Boötes Void — N-body forecast', () => {
    test.setTimeout(RUN_TIMEOUT + 60_000);

    test('runs in a worker, joins the shell tracker at z_obs, and takes over after it', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await ready(page);
        await expect(page.locator('[data-bv="trackNbody"]').first()).toContainText('off');
        expect(await page.evaluate(() => window.__bootesLab.tracker.nbody.state.status)).toBe('idle');
        await runNbody(page);
        expect(await page.evaluate(() => window.__bootesLab.tracker.nbody.state.status)).toBe('ready');
        await expect(page.locator('[data-bv="trackNbody"]').first()).toContainText('done in');
        await expect(page.locator('[data-bv="trackNbody"]').first()).toContainText('galaxies as test particles');

        // THE JOIN. Frame 0 of the run is the observed state: galaxy A sits
        // at its observed point with the shell tracker's velocity.
        const join = await page.evaluate(() => {
            const tr = window.__bootesLab.tracker;
            const g = tr.tracked[0];
            const tObs = tr.timeline.tObsGyr;
            const z = tr.timeline.zObs;
            const ep = { tGyr: tObs + 1e-6, a: 1 / (1 + z), z, D: 1, gravity: 1, tidal: 1, velocity: 1 };
            const nb = tr.nbody.sampleFor(g.xObsMpc, ep);
            const sh = g.linear.at({ ...ep, tGyr: tObs });
            return {
                dPos: Math.hypot(...nb.positionMpc.map((c, i) => c - g.xObsMpc[i])),
                dV: Math.abs(nb.vKms - sh.vKms) / sh.vKms,
                dG: Math.abs(nb.gA - sh.gA) / sh.gA,
            };
        });
        expect(join.dPos).toBeLessThan(1e-4);
        expect(join.dV).toBeLessThan(2e-3);
        // The force differs only by the smooth matter's resolution (~24 Mpc).
        expect(join.dG).toBeLessThan(0.15);

        // The past is the shell reconstruction, exactly.
        const past = await sampleA(page, 5);
        expect(past.main.nbody).toBe(false);
        expect(past.main.pos).toEqual(past.shell.pos);

        // The future is the run's, and it differs from the shell tracker by a
        // real but small amount — the nonlinear web.
        const t0 = await page.evaluate(() => window.__bootesLab.tracker.timeline.t0Gyr);
        const fut = await sampleA(page, t0 + 5);
        expect(fut.main.nbody).toBe(true);
        const d = Math.hypot(...fut.main.pos.map((c, i) => c - fut.shell.pos[i]));
        expect(d).toBeGreaterThan(1e-4);
        expect(d).toBeLessThan(5);

        await page.evaluate((t) => window.__bootesLab.tracker.setTime(t), t0 + 5);
        await expect.poll(() => page.locator('#bv-track-rows tr').first().locator('td').nth(6).textContent())
            .toBe('N-body');
        await expect(page.locator('[data-bv="trackAccretion"]').first()).toContainText('% since z_obs');
        await expect(page.locator('[data-bv="trackNlGain"]').first()).toContainText('kpc from the shell');
        await expect(page.locator('[data-bv="trackRegime"]').first()).toContainText('self-gravitating');
        expect(errors).toEqual([]);
    });

    test('the stage draws the run\'s particles after z_obs and is restored exactly at z_obs', async ({ page }) => {
        await ready(page);
        const drawn = () => page.evaluate(() => {
            const pts = window.__bootesLab.scene.groups.tracers.children[0];
            return Array.from(pts.geometry.getAttribute('position').array.slice(0, 600));
        });
        const atObs = await drawn();
        await runNbody(page);
        const t0 = await page.evaluate(() => window.__bootesLab.tracker.timeline.t0Gyr);
        await page.evaluate((t) => window.__bootesLab.tracker.setTime(t), t0 + 5);
        await expect.poll(async () => {
            const now = await drawn();
            return now.some((c, i) => Math.abs(c - atObs[i]) > 1e-3);
        }).toBe(true);
        // The tracers drawn ARE the run's frames at that instant.
        const match = await page.evaluate((t) => {
            const lab = window.__bootesLab;
            const tl = lab.tracker.timeline;
            const ep = tl.epochs.reduce((b, e) => (Math.abs(e.tGyr - t) < Math.abs(b.tGyr - t) ? e : b));
            lab.tracker.setTime(ep.tGyr);
            return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
                const want = lab.tracker.nbody.tracerPositionsAt(ep.a);
                const pts = lab.scene.groups.tracers.children[0];
                const got = pts.geometry.getAttribute('position').array;
                // scene.js draws Mpc / SCENE_SCALE (20).
                let worst = 0;
                for (let i = 0; i < 300; i++) worst = Math.max(worst, Math.abs(got[i] * 20 - want[i]));
                resolve({ worst });
            })));
        }, t0 + 5);
        expect(match.worst).toBeLessThan(1e-3);
        await page.click('#bv-track-obs');
        await expect.poll(async () => {
            const now = await drawn();
            return now.every((c, i) => c === atObs[i]);
        }).toBe(true);
    });

    test('a galaxy tracked after the run is flown through the stored matter', async ({ page }) => {
        await ready(page);
        await runNbody(page);
        await page.click('#bv-track-add-random');
        const t0 = await page.evaluate(() => window.__bootesLab.tracker.timeline.t0Gyr);
        await expect.poll(() => page.evaluate((t) => {
            const tr = window.__bootesLab.tracker;
            const ep = tr.timeline.epochs.find(e => e.tGyr > t);
            return !!tr.tracked[1]?.main.at(ep).nbody;
        }, t0 + 3), { timeout: 30000 }).toBe(true);
    });

    test('with no Worker the page computes the identical forecast itself', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const a = await ctxA.newPage();
        await ready(a);
        await runNbody(a);
        const t0 = await a.evaluate(() => window.__bootesLab.tracker.timeline.t0Gyr);
        const withWorker = await sampleA(a, t0 + 4);
        await ctxA.close();

        const ctxB = await browser.newContext();
        await ctxB.addInitScript(() => { delete window.Worker; });
        const b = await ctxB.newPage();
        await ready(b);
        expect(await b.evaluate(() => typeof Worker)).toBe('undefined');
        await runNbody(b);
        const local = await sampleA(b, t0 + 4);
        await ctxB.close();
        expect(local.main.nbody).toBe(true);
        expect(local.main.pos).toEqual(withWorker.main.pos);
        expect(local.main.v).toBe(withWorker.main.v);
    });
});
