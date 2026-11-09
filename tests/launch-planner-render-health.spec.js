/**
 * launch-planner-render-health.spec.js — the browser gate for "the launch
 * planner's 3D stage is a black rectangle" (reported 2026-11-08 on a real
 * GPU, while every headless gate passed).
 *
 * THE CAUSE: one non-finite HDR pixel (NaN from pow() of a negative base /
 * normalize(0) / atan(0,0), or Inf past half-float's 65504) entered the
 * bloom's mip chain, the separable blur smeared it into a rectangle most of
 * the frame wide, and ACES(NaN) is black. SwiftShader evaluates those shader
 * ops tamely, which is why CI never saw it — so this gate does not wait for a
 * driver to produce the NaN: it PLANTS one, and proves the stage survives it.
 *
 * Every pixel claim reads the drawing buffer through the canvas's own
 * `_sampleFrame()` hook (render now + readPixels in the same task), so the
 * measurements are identical in Chromium, Firefox and WebKit — no screenshot
 * decoding, no preserveDrawingBuffer.
 *
 * NEGATIVE CONTROLS (each runs inside the test that needs it, every run):
 *   · planted NaN with the sanitize OFF must black out the frame (proves the
 *     plant reproduces the reported failure and the metric can see it);
 *   · the deep-link test boots the strip AFTER the feed, the order the old
 *     page dropped on the floor.
 *
 * Hermetic: every non-localhost request is aborted and /api/* is mocked.
 * Runs on software GL (quality 'low' by detection), so waits are generous.
 */
import { test, expect } from '@playwright/test';

const PAGE = '/launch-planner.html';

// A non-black frame of this scene has a dead fraction (pixels ≤ 3/255) far
// below this; the reported failure was ~0.93 of the frame, a planted NaN on
// the pre-fix chain is ~1.0.
const LIT_MAX_DEAD = 0.5;
const BLACK_MIN_DEAD = 0.85;

const LAUNCH_ID = 'a2423132-f965-423f-8b03-6891b775dc54';
function mockFeed() {
    const now = Date.now();
    const mk = (id, name, vehicle, provider, h, cc = 'US') => ({
        id, name, slug: id, status: 'Go', status_name: 'Go for Launch', mission: '', vehicle, provider,
        pad: { name: 'LC-39A', lat: 28.608, lon: -80.604, location: 'Kennedy Space Center, FL, USA', country_code: cc, wiki: '' },
        net_iso: new Date(now + h * 3600e3).toISOString(),
        window_start_iso: null, window_end_iso: null, probability_pct: 90, image: '', info_url: '',
    });
    const launches = [
        mk('cz-1', 'Long March 7 | Tianzhou', 'Long March 7', 'China Aerospace Science and Technology Corporation', 5, 'CN'),
        mk(LAUNCH_ID, 'Falcon 9 Block 5 | Starlink Group 12-3', 'Falcon 9', 'SpaceX', 20),
        mk('ss-1', 'Starship | Flight 13', 'Starship', 'SpaceX', 40),
    ];
    return { source: 'mock', fetched_at: new Date().toISOString(), count: launches.length, launches };
}

async function hermetic(page, { feed = null, feedDelayMs = 0, threeDelayMs = 0 } = {}) {
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    // Weather / NWS / telemetry answer fast and empty: the canvas is the subject.
    await page.route('**/api/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"mock"}' }));
    await page.route('**/api/launches/upcoming*', async (r) => {
        if (feedDelayMs) await new Promise((z) => setTimeout(z, feedDelayMs));
        if (!feed) return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"mock"}' });
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed) });
    });
    if (threeDelayMs) {
        await page.route('**/three.module.js', async (r) => {
            await new Promise((z) => setTimeout(z, threeDelayMs));
            return r.continue();
        });
    }
}

async function boot(page, query = '', opts = {}) {
    await hermetic(page, opts);
    await page.goto(PAGE + query, { waitUntil: 'domcontentloaded' });
    await page.locator('#lh-vehicle-canvas').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__lpVehicle3d?.renderHealth, null, { timeout: 90_000 });
    // The consent banner covers the bottom of the page; it is chrome, not stage.
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
    // Say which renderer this engine gave us and which rung detectQuality chose
    // from it: a software renderer that hides its name (Firefox sanitizes the
    // string) would get the full 'high' post chain on a CPU rasteriser.
    const gpu = await page.evaluate(() => {
        const a = window.__lpVehicle3d, gl = a.renderer.getContext();
        let name = '';
        try { const e = gl.getExtension('WEBGL_debug_renderer_info'); name = e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); } catch (_) { /* hardened */ }
        return { name, quality: a.renderHealth.quality, webgl2: a.renderer.capabilities.isWebGL2 };
    });
    console.log(`[render-health] renderer "${gpu.name}" · quality ${gpu.quality} · webgl2 ${gpu.webgl2}`);
}

async function frames(page, n = 3) {
    await page.evaluate((n) => new Promise((res) => {
        let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
    }), n);
}

const sample = (page) => page.evaluate(() => window.__lpVehicle3d._sampleFrame());

// Plant a small sphere whose fragments are NaN (0/0 through a uniform, so no
// compiler can fold it) or +Inf (1e30², past every float format), in front of
// the vehicle. This is the reported failure's input, made deterministic.
async function plant(page, mode) {
    await page.evaluate(async (mode) => {
        const THREE = await import('three');
        const a = window.__lpVehicle3d;
        const mat = new THREE.ShaderMaterial({
            uniforms: { uZero: { value: 0 }, uBig: { value: 1e30 } },
            vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: mode === 'inf'
                ? 'uniform float uBig; void main(){ float v = uBig * uBig; gl_FragColor = vec4(v, v, v, 1.0); }'
                : 'uniform float uZero; void main(){ float n = uZero / uZero; gl_FragColor = vec4(n, n, n, 1.0); }',
        });
        // depthTest off + drawn last: the plant must ALWAYS reach the HDR
        // buffer. Depth-tested, it hid behind the launch tower on some
        // framings and both the fix checks and the negative control went
        // vacuous (measured under parallel load).
        mat.depthTest = false;
        mat.depthWrite = false;
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), mat);
        m.renderOrder = 999;
        m.frustumCulled = false;
        m.name = 'TestNonFinitePlant';
        // On the line from the camera to its target, 30 % of the way: always
        // in frame and in front of everything, whatever the framing.
        const t = new THREE.Vector3(...a.renderStats.target);
        m.position.copy(a.camera.position).lerp(t, 0.3);
        a.scene.add(m);
    }, mode);
}
const unplant = (page) => page.evaluate(() => {
    const s = window.__lpVehicle3d.scene;
    s.getObjectByName('TestNonFinitePlant')?.removeFromParent();
});

test.describe('launch-planner 3D stage — render health', () => {
    test.setTimeout(300_000);
    // Every test boots its own page and restores nothing it shares, so they run
    // in PARALLEL and SHARD: on software GL the boot alone is ~18 s locally and
    // ~2.4× that on a CI runner, and Firefox's software WebGL is slower again.
    // Run serially in one job, the ten boots plus a retry outlasted the job's
    // 40-minute cap and Firefox was cancelled before printing a single result
    // (every run since 2026-11-08). The workflow shards the Firefox job.
    test.describe.configure({ mode: 'parallel' });

    test('a planted NaN or Inf pixel cannot black out the stage (negative control: sanitize off)', async ({ page }) => {
        await boot(page);
        const h0 = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        test.skip(!h0.post, 'no WebGL2 post chain in this browser — nothing to sanitize');

        const clean = await sample(page);
        expect(clean.dead, `clean frame grid ${JSON.stringify(clean.grid)}`).toBeLessThan(LIT_MAX_DEAD);

        for (const mode of ['nan', 'inf']) {
            await plant(page, mode);
            await frames(page, 2);
            const s = await sample(page);
            expect(s.dead, `${mode}: grid ${JSON.stringify(s.grid)}`).toBeLessThan(LIT_MAX_DEAD);
            // The plant covers a few hundred pixels at most; the frame's mean
            // level must not collapse either.
            expect(s.mean, `${mode}: mean`).toBeGreaterThan(clean.mean * 0.6);
            await unplant(page);
        }

        // Everything above ran on the post chain the browser booted with — a
        // monitor step-down to the direct render would make it vacuous.
        const h1 = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        expect(h1.steps).toEqual([]);
        expect(h1.quality).toBe(h0.quality);

        // NEGATIVE CONTROL — the same NaN with the guard off is the reported
        // black rectangle. If this ever stops going black, the plant no
        // longer reproduces the failure and the checks above prove nothing.
        await page.evaluate(() => window.__lpVehicle3d._setPostSanitize(false));
        await plant(page, 'nan');
        await frames(page, 2);
        const bad = await sample(page);
        await unplant(page);
        await page.evaluate(() => window.__lpVehicle3d._setPostSanitize(true));
        expect(bad.dead, `negative control grid ${JSON.stringify(bad.grid)}`).toBeGreaterThan(BLACK_MIN_DEAD);
    });

    test('the health monitor steps a black post chain down until the stage is lit', async ({ page }) => {
        await boot(page);
        const h0 = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        test.skip(!h0.post, 'no WebGL2 post chain in this browser');
        expect(h0.state).toBe('ok');
        // Break the chain the way a driver would (sanitize off + a NaN): the
        // post chain is black at every rung that blooms, and only the direct
        // render — where a NaN is one pixel — is lit again.
        await page.evaluate(() => window.__lpVehicle3d._setPostSanitize(false));
        await plant(page, 'nan');
        await page.waitForFunction(() => window.__lpVehicle3d.renderHealth.quality === 'off',
            null, { timeout: 120_000, polling: 500 });
        const h1 = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        expect(h1.state).toBe('degraded');
        expect(h1.steps.map((s) => s.to)).toContain('off');
        const s = await sample(page);
        expect(s.dead, `after step-down grid ${JSON.stringify(s.grid)}`).toBeLessThan(LIT_MAX_DEAD);
        // No "could not draw" notice — the direct render worked.
        await expect(page.locator('.lh-render-notice')).toHaveCount(0);
    });

    test('every vehicle and view renders finite HDR and a lit frame', async ({ page }) => {
        await boot(page);
        const rows = [];
        const VEHICLES = [['shuttle', null], ['falcon9', 'block5'], ['falcon9', 'heavy'], ['starship', 'v2'], ['starship', 'v3']];
        for (const [v, variant] of VEHICLES) {
            await page.evaluate(([v, variant]) => window.__lpVehicle3d.setVehicle(v, variant || undefined), [v, variant]);
            for (const view of ['threequarter', 'wide', 'top', 'engines']) {
                await page.evaluate((view) => window.__lpVehicle3d.setView(view), view);
                await page.waitForTimeout(950);            // the view tween is 800 ms
                const r = await page.evaluate(async () => {
                    const THREE = await import('three');
                    const a = window.__lpVehicle3d;
                    const R = a.renderer;
                    const w = R.domElement.width, h = R.domElement.height;
                    // Render the LINEAR scene into a float target and look at
                    // every value — this is what the bloom would have read.
                    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType });
                    R.setRenderTarget(rt); R.render(a.scene, a.camera); R.setRenderTarget(null);
                    const buf = new Float32Array(w * h * 4);
                    R.readRenderTargetPixels(rt, 0, 0, w, h, buf);
                    rt.dispose();
                    let nonFinite = 0, max = 0;
                    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) {
                        const x = buf[i * 4 + c];
                        if (!Number.isFinite(x)) nonFinite++; else if (x > max) max = x;
                    }
                    const f = a._sampleFrame();
                    return { nonFinite, max, dead: f.dead, mean: f.mean };
                });
                rows.push({ v, variant, view, ...r });
            }
        }
        console.log('[render-health] per-view:', JSON.stringify(rows.map((r) =>
            [r.v + (r.variant ? '/' + r.variant : ''), r.view, r.nonFinite, +r.max.toFixed(2), +r.dead.toFixed(3), +r.mean.toFixed(1)])));
        for (const r of rows) {
            const tag = `${r.v}/${r.variant} ${r.view}`;
            expect(r.nonFinite, `${tag}: non-finite HDR values`).toBe(0);
            expect(r.max, `${tag}: HDR peak under the sanitize ceiling`).toBeLessThan(256);
            expect(r.dead, `${tag}: dead fraction`).toBeLessThan(LIT_MAX_DEAD);
        }
        // The monitor's trip line must sit far above every legitimate frame,
        // or it would degrade a healthy stage.
        const worst = Math.max(...rows.map((r) => r.dead));
        expect(worst).toBeLessThan(0.97 - 0.3);
        const h = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        expect(h.steps, 'a healthy stage must never be stepped down').toEqual([]);
    });

    test('looking straight up at the zenith stays finite (sky normalize(0) guard)', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(async () => {
            const THREE = await import('three');
            const a = window.__lpVehicle3d;
            const R = a.renderer;
            const cam = a.camera.clone();
            cam.position.set(0, 20, 0);
            cam.up.set(0, 0, -1);
            cam.lookAt(0, 1000, 0);
            cam.updateMatrixWorld();
            const w = 256, h = 160;
            const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType });
            R.setRenderTarget(rt); R.render(a.scene, cam); R.setRenderTarget(null);
            const buf = new Float32Array(w * h * 4);
            R.readRenderTargetPixels(rt, 0, 0, w, h, buf);
            rt.dispose();
            let nonFinite = 0;
            for (const x of buf) if (!Number.isFinite(x)) nonFinite++;
            return { nonFinite };
        });
        expect(r.nonFinite).toBe(0);
    });

    for (const q of ['high', 'low', 'off']) {
        test(`quality rung '${q}' renders a lit stage (?lpfx=${q})`, async ({ page }) => {
            await boot(page, `?lpfx=${q}`);
            await frames(page, 3);
            const h = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
            const webgl2 = await page.evaluate(() => window.__lpVehicle3d.renderer.capabilities.isWebGL2);
            expect(h.quality).toBe(webgl2 ? q : 'off');
            const s = await sample(page);
            expect(s.dead, `grid ${JSON.stringify(s.grid)}`).toBeLessThan(LIT_MAX_DEAD);
            expect(s.mean).toBeGreaterThan(8);
        });
    }

    test('a lost WebGL context is restored and the stage draws again', async ({ page }) => {
        await boot(page);
        const ok = await page.evaluate(() => !!window.__lpVehicle3d.renderer.getContext().getExtension('WEBGL_lose_context'));
        test.skip(!ok, 'WEBGL_lose_context unavailable');
        await page.evaluate(() => {
            const ext = window.__lpVehicle3d.renderer.getContext().getExtension('WEBGL_lose_context');
            window.__lpLoseExt = ext;
            ext.loseContext();
        });
        await page.waitForFunction(() => window.__lpVehicle3d.renderHealth.state === 'context-lost', null, { timeout: 20_000 });
        await expect(page.locator('.lh-render-notice')).toHaveCount(1);
        await page.evaluate(() => window.__lpLoseExt.restoreContext());
        await page.waitForFunction(() => window.__lpVehicle3d.renderHealth.state !== 'context-lost', null, { timeout: 30_000 });
        await frames(page, 4);
        const h = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        expect(h.steps.map((s) => s.reason)).toContain('context restored');
        await expect(page.locator('.lh-render-notice')).toHaveCount(0);
        const s = await sample(page);
        expect(s.dead, `restored grid ${JSON.stringify(s.grid)}`).toBeLessThan(LIT_MAX_DEAD);
    });

    test('a frame that throws does not freeze the render loop', async ({ page }) => {
        await boot(page);
        // A mesh whose onBeforeRender throws twice, then behaves.
        await page.evaluate(async () => {
            const THREE = await import('three');
            const a = window.__lpVehicle3d;
            const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
            m.name = 'TestThrower';
            let left = 2;
            m.onBeforeRender = () => { if (left-- > 0) throw new Error('planted render failure'); };
            m.position.set(0, 1, 0);
            a.scene.add(m);
        });
        await page.waitForFunction(() => window.__lpVehicle3d.renderHealth.errors >= 2, null, { timeout: 30_000 });
        await frames(page, 4);
        const h = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        expect(h.lastError).toContain('planted render failure');
        expect(h.state).not.toBe('failed');
        const s = await sample(page);
        expect(s.dead).toBeLessThan(LIT_MAX_DEAD);
    });

    test('a ?launch= deep link loads that launch\'s vehicle, even when the feed beats three.js', async ({ page }) => {
        // three.js arrives 2.5 s late and the feed instantly: the order the
        // old page dropped (empty strip, canvas stuck on the Shuttle).
        await boot(page, `?launch=${LAUNCH_ID}`, { feed: mockFeed(), threeDelayMs: 2500 });
        await page.waitForFunction(() => window.__lpVehicle3d.vehicle.id === 'falcon9', null, { timeout: 60_000 });
        expect(await page.evaluate(() => window.__lpVehicle3d.vehicle)).toEqual({ id: 'falcon9', variant: 'block5' });
        await expect(page.locator('.lp-strip-card')).toHaveCount(3);
        await expect(page.locator(`.lp-strip-card[data-id="${LAUNCH_ID}"]`)).toHaveClass(/lp-strip-card--active/);
        await expect(page.locator('.lh-vp-btn--on[data-vehicle="falcon9"]').first()).toBeVisible();

        // A Starship launch from the strip swaps the canvas (V2 is the variant
        // the picker ships pre-lit — the other half of the old guard bug).
        await page.locator('.lp-strip-card[data-id="ss-1"]').click();
        await page.waitForFunction(() => window.__lpVehicle3d.vehicle.id === 'starship', null, { timeout: 60_000 });
        expect((await page.evaluate(() => window.__lpVehicle3d.vehicle)).variant).toMatch(/^v[123]$/);
        const s = await sample(page);
        expect(s.dead).toBeLessThan(LIT_MAX_DEAD);
    });
});
