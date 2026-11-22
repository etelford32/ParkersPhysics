/**
 * sun-flare-look.spec.js — the flare as it is actually DRAWN
 * ═══════════════════════════════════════════════════════════════════════════
 * js/flare-realism.js scores the flare-shape MODEL (numbers out of the
 * kernel). This is the other half: that sun.html draws that model, and that
 * what reaches the screen still carries the information the model has.
 *
 * The arcade is isolated by DIFFERENCING: the same frame with the 3D arcade
 * shown and hidden (both flare clocks held, plume off, camera settled), so
 * nothing else on the page — the observed disc, the ribbons on the surface,
 * the corona — is in the measurement.
 *
 *   1. PLACE. The lit pixels' bounding box is the active model's loops,
 *      projected through the page's own camera. NEGATIVE CONTROL: with the
 *      v1 laws (?flaremodel=v1 at run time) the drawn box no longer fits the
 *      v2 projection — and does fit v1's. A swap that silently did nothing,
 *      or a view that kept its own copy of a law, fails here.
 *   2. COLOUR IS TEMPERATURE. A hot arcade (5.7 min) is teal, a cooled one
 *      (30 min) is gold — measured as the sign of blue − red over the lit
 *      pixels. And a strand is not a white tube: the share of lit pixels
 *      that are clipped white is bounded. NEGATIVE CONTROL: the strand gain
 *      this page shipped with for a day (2.2) clips several times as many.
 *
 *   3. THE RIBBONS ARE J-SHAPED. With the arcade hidden, the flare's surface
 *      light (flares on − flares off) is sampled along each ribbon's hook, as
 *      the model's own centreline projects it, and at the MIRRORED positions
 *      — where the hooks would be for the opposite handedness, and where the
 *      site-centred glows contribute exactly as much. Light at the hooks,
 *      none at the mirror. NEGATIVE CONTROL: under the v1 laws (straight
 *      ribbons) the two are equal.
 *
 *   4. THE ERUPTING ROPE. With the arcade hidden, rope shown minus rope
 *      hidden: the lit region is the model's strands, projected. NEGATIVE
 *      CONTROL: the same flare stated CONFINED draws no rope at all, and the
 *      caption says "confined".
 *
 * FLARE_SHOTS=<dir> also writes every frame it measured (model × age) and a
 * measurements.json — the pictures to judge a change by eye, taken the same
 * way every time. Software GL: this gates placement and colour, not beauty.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../scripts/lib/sdo-synth.mjs';

const PAGE = '/sun.html';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdo');
const MANIFEST = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
const SHOTS = process.env.FLARE_SHOTS || null;
const SITE = { cls: 'X2.0', latDeg: 12, lonDeg: 30 };
const HOT_T = 120, COOL_T = 630;          // sim units: 5.7 min and 30 min after onset
const EARLY_T = 40;                       // 1.9 min: the ribbons are at their brightest

async function routeFeeds(page) {
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        const frame = MANIFEST.frames[ch] || MANIFEST.frames.white;
        const isLasco = ch === 'c2' || ch === 'c3';
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png', 'X-AIA-Channel': ch, 'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': new Date(Date.now() - 7 * 60e3).toISOString(),
                ...(isLasco ? { 'X-SOHO-Instrument': ch } : {}),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SOHO-Instrument',
            },
            body: readFileSync(join(FIXTURE_DIR, frame.file)),
        });
    });
    await page.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.href), (route) => route.abort());
}

/** The camera has stopped changing AND frames have been drawn with it (the sun-real-frames rule). */
async function settle(page) {
    const sig = () => page.evaluate(() => {
        const s = window.__sun, c = s.camera, el = s.renderer.domElement;
        return JSON.stringify([c.position.toArray().map((x) => +x.toFixed(5)), c.fov, c.aspect,
            c.view && c.view.enabled ? [c.view.offsetX, c.view.offsetY, c.view.fullWidth, c.view.fullHeight] : null, el.width, el.height,
            s.flareGeometry.arcade.builtT, s.flareGeometry.arcade.model]);
    });
    let prev = await sig(), same = 0;
    for (let i = 0; i < 80 && same < 3; i++) {
        await page.waitForTimeout(400);
        const cur = await sig();
        same = cur === prev ? same + 1 : 0; prev = cur;
    }
    await page.evaluate(() => new Promise((ok) => { let n = 0; const f = () => (++n >= 3 ? ok() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
}

/** Screenshot → {width, height, rgba}. */
async function grab(page) { await settle(page); return decodePng(await page.screenshot()); }

/**
 * Pixels the arcade added: (on − off) by luminance, then THE LARGEST CONNECTED
 * REGION of them. The page is alive between two screenshots (the corona march
 * re-converges, a star twinkles), so a bare threshold leaves specks across the
 * frame — the first version's "box" was 1155 px wide around a 70 px arcade.
 * Connectivity is on 4 px cells (8-neighbour), so a strand's own gaps do not
 * split it. Colour is of the light the arcade ADDED (the difference), not of
 * the pixel: a teal strand over a gold disc is still a teal strand.
 */
function arcadePixels(on, off, { thresh = 22, cell = 4 } = {}) {
    const { width: W, height: H } = on;
    const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
    const count = new Uint16Array(cw * ch);
    const lit = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = 0.2126 * (on.rgba[i] - off.rgba[i]) + 0.7152 * (on.rgba[i + 1] - off.rgba[i + 1]) + 0.0722 * (on.rgba[i + 2] - off.rgba[i + 2]);
        if (d >= thresh) { lit[y * W + x] = 1; count[((y / cell) | 0) * cw + ((x / cell) | 0)]++; }
    }
    // Flood-fill the cells that hold at least two lit pixels; keep the largest region.
    const label = new Int32Array(cw * ch).fill(-1);
    let best = -1, bestN = 0, regions = 0;
    const stack = [];
    for (let c0 = 0; c0 < cw * ch; c0++) {
        if (count[c0] < 2 || label[c0] >= 0) continue;
        let n = 0; label[c0] = regions; stack.push(c0);
        while (stack.length) {
            const c = stack.pop(); n += count[c];
            const cx = c % cw, cy = (c / cw) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
                const k = ny * cw + nx;
                if (count[k] >= 2 && label[k] < 0) { label[k] = regions; stack.push(k); }
            }
        }
        if (n > bestN) { bestN = n; best = regions; }
        regions++;
    }
    let n = 0, x0 = W, x1 = -1, y0 = H, y1 = -1, dr = 0, dg = 0, db = 0, white = 0, total = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!lit[y * W + x]) continue;
        total++;
        if (label[((y / cell) | 0) * cw + ((x / cell) | 0)] !== best) continue;
        const i = (y * W + x) * 4;
        n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        dr += on.rgba[i] - off.rgba[i]; dg += on.rgba[i + 1] - off.rgba[i + 1]; db += on.rgba[i + 2] - off.rgba[i + 2];
        if (Math.min(on.rgba[i], on.rgba[i + 1], on.rgba[i + 2]) >= 245) white++;
    }
    return { n, strays: total - n, regions, box: n ? { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
             added: n ? [dr / n, dg / n, db / n] : null, blueMinusRed: n ? (db - dr) / n : null, white: n ? white / n : null };
}

/** Where the active (or a named) model's loops fall on screen, through the page's own camera and site transform. */
function projectedBox(page, modelSpec) {
    return page.evaluate(({ modelSpec, n }) => {
        const s = window.__sun, T = s.THREE, FG = s.FG;
        const model = modelSpec === 'active' ? s.flareModel : FG.makeFlareModel(null, modelSpec === 'v1' ? FG.FLARE_SHAPE_V1 : FG.FLARE_SHAPE_V2);
        const site = s.flareArcade.site, t = s.flareGeometry.arcade.builtT;
        const loops = model.arcadeShells({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle, t, cls: site.cls, n, complex: site.complex, chirality: site.chirality, samples: 48 })
            .filter((L) => L.alpha > 0.5);
        const el = s.renderer.domElement, r = el.getBoundingClientRect(), M = s.flareArcade.group.matrixWorld;
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        const v = new T.Vector3();
        for (const L of loops) for (const p of L.pts) {
            v.set(p[0], p[1], p[2]).applyMatrix4(M).project(s.camera);
            const x = r.left + (v.x * 0.5 + 0.5) * r.width, y = r.top + (-v.y * 0.5 + 0.5) * r.height;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, loops: loops.length, model: model.id, t };
    }, { modelSpec, n: 23 });
}

/**
 * Screen positions along both ribbons' HOOKS as the v2 model places them, and of the same points mirrored
 * along the inversion line (a → −a) — equally far from the flare site, on the un-hooked ends.
 */
function hookProbes(page, t) {
    return page.evaluate(({ t }) => {
        const s = window.__sun, T = s.THREE, FG = s.FG;
        const model = FG.makeFlareModel(null, FG.FLARE_SHAPE_V2);
        const site = s.flareArcade.site;
        const rc = model.ribbonCurves({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle, t, cls: site.cls, chirality: site.chirality, samples: 60 });
        const tf = FG.tangentFrame(site.latRad, site.lonRad0, site.pilAngle);
        const el = s.renderer.domElement, r = el.getBoundingClientRect(), M = s.flareArcade.group.matrixWorld, v = new T.Vector3();
        const screen = (a, c) => {
            const z = Math.sqrt(Math.max(0, 1 - a * a - c * c));
            v.set(tf.pilAxis[0] * a + tf.loopAxis[0] * c + tf.radial[0] * z, tf.pilAxis[1] * a + tf.loopAxis[1] * c + tf.radial[1] * z, tf.pilAxis[2] * a + tf.loopAxis[2] * c + tf.radial[2] * z)
                .applyMatrix4(M).project(s.camera);
            return [Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height)];
        };
        const hook = [], mirror = [];
        for (const side of [rc.plus, rc.minus]) {
            // The part of the hook that has clearly left the straight ribbon: beyond a third of the arc's reach.
            const out = side.filter((q) => Math.abs(q.c) > rc.sep + 0.6 * rc.hook.rho);
            for (let i = 0; i < out.length; i += 3) { hook.push(screen(out[i].a, out[i].c)); mirror.push(screen(-out[i].a, out[i].c)); }
        }
        return { hook, mirror, hookDef: rc.hook, sep: rc.sep };
    }, { t });
}

/** Mean luminance the flare's surface layer added (on − off) over 3×3 patches at the given pixels. */
function addedAt(on, off, pts) {
    const { width: W, height: H } = on;
    let sum = 0, n = 0;
    for (const [x0, y0] of pts) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = x0 + dx, y = y0 + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        sum += 0.2126 * (on.rgba[i] - off.rgba[i]) + 0.7152 * (on.rgba[i + 1] - off.rgba[i + 1]) + 0.0722 * (on.rgba[i + 2] - off.rgba[i + 2]); n++;
    }
    return n ? sum / n : NaN;
}

/** Placement tolerance for a projected box, px. */
const PLACE_TOL = (p) => 6 + 0.03 * Math.max(p.w, p.h);
/** How far a measured box is from a projected one: the worst edge, in pixels. */
const boxMiss = (m, p) => Math.max(Math.abs(m.x0 - p.x0), Math.abs(m.x1 - p.x1), Math.abs(m.y0 - p.y0), Math.abs(m.y1 - p.y1));

test.describe('sun.html: the flare as drawn', () => {
    // A dozen settled screenshots on a software rasteriser: 5.8 min run alone (measured), longer beside another worker.
    test.describe.configure({ timeout: 900_000 });

    test('the arcade is drawn where the active shape model puts it, in the colour of its age', async ({ page }) => {
        const errs = [];
        page.on('console', (m) => { if (m.type() === 'error' && /Shader Error|GLSL|ERROR: 0:|Program Info Log/i.test(m.text())) errs.push(m.text().slice(0, 300)); });
        page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
        await page.addInitScript(() => { try { localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 })); } catch (e) {} });
        await routeFeeds(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready && window.__sun.frames > 5 && window.__sun.cam, null, { timeout: 60_000 });
        await page.waitForFunction(() => window.__sun.uniforms.u_obsOn.value > 0.5, null, { timeout: 40_000 });

        // One flare, held; the 171 Å view (where the director sends the viewer); the flare shot; the plume off.
        const id = await page.evaluate(({ SITE, HOT_T }) => {
            const s = window.__sun;
            const el = document.getElementById('view-mode'); el.value = '2'; el.dispatchEvent(new Event('change', { bubbles: true }));
            s.testFlare(SITE.cls, SITE.latDeg, SITE.lonDeg, { flash: false });
            s.holdFlareAt(HOT_T);
            s.flareArcade.setPlumeEnabled(false);
            s.flareRope.setVisible(false);              // parts 1–3 measure the arcade and the ribbons; the rope is part 4
            s.cam.playShot('flare');
            return s.flareModel.id;
        }, { SITE, HOT_T });
        expect(id).toBe('flare-shape-v2');
        await page.waitForFunction(() => !window.__sun.cam.state.flying, null, { timeout: 90_000 });
        // Nothing but the arcade may differ between the two frames of a pair: hold the sim clock
        // (the flare clocks are held separately) and the auto-exposure where it has settled.
        await page.evaluate(() => { const s = window.__sun; s.freeze(120); const e = s.post?.exposure; if (e) e.step = function () { return this.exposure; }; });
        await page.addStyleTag({ content: '#canvas-wrap > *:not(canvas), nav, #lsb-bar, #sun-watch-dock, #snw-pill, #scroll-hint { visibility: hidden !important; }' });

        const out = {};
        const frames = {};
        /** Measure the arcade at one age under one model. */
        async function measureAt(t, model, tag) {
            await page.evaluate(({ t, model }) => { const s = window.__sun; s.setFlareModel(model); s.holdFlareAt(t); s.flareArcade.setVisible(true); }, { t, model });
            await page.waitForFunction((t) => Math.abs(window.__sun.flareGeometry.arcade.builtT - t) < 1e-6 && window.__sun.flareGeometry.arcade.loops > 0, t, { timeout: 30_000 });
            // The arcade's exposure control eases toward its answer over a few frames: measure it settled.
            await page.waitForFunction(() => {
                const a = window.__sun.flareArcade.state, A = window.__sun.flareArcadeConst;
                if (!a.autoExposure) return a.exposure === 1;
                if (!(a.stack > 0)) return false;
                const want = a.stack > A.AEC_TARGET ? Math.max(A.AEC_FLOOR, A.AEC_TARGET / a.stack) : 1;
                return Math.abs(a.exposure - want) < 0.01;
            }, null, { timeout: 60_000 });
            const exposure = await page.evaluate(() => { const a = window.__sun.flareArcade.state; return { stack: a.stack, exposure: a.exposure, gain: a.gain, auto: a.autoExposure }; });
            const on = await grab(page);
            const proj = await projectedBox(page, 'active');
            await page.evaluate(() => window.__sun.flareArcade.setVisible(false));
            await page.waitForFunction(() => !window.__sun.flareGeometry.arcade.active, null, { timeout: 30_000 });
            const off = await grab(page);
            await page.evaluate(() => window.__sun.flareArcade.setVisible(true));
            const px = arcadePixels(on, off);
            out[tag] = { t, model: proj.model, pixels: px, projected: proj, exposure };
            frames[tag] = on;
            if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.waitForFunction(() => window.__sun.flareGeometry.arcade.active, null, { timeout: 30_000 }); await settle(page); writeFileSync(join(SHOTS, `${tag}.png`), await page.screenshot()); }
            return out[tag];
        }

        const hot = await measureAt(HOT_T, null, 'v2-hot');
        const cool = await measureAt(COOL_T, null, 'v2-cool');
        const brief = (m) => ({ box: m.pixels.box, proj: { x0: Math.round(m.projected.x0), x1: Math.round(m.projected.x1), y0: Math.round(m.projected.y0), y1: Math.round(m.projected.y1) },
            loops: m.projected.loops, added: m.pixels.added.map((v) => +v.toFixed(1)), white: +m.pixels.white.toFixed(3), n: m.pixels.n, strays: m.pixels.strays });
        console.log('flare look:', JSON.stringify({ hot: brief(hot), cool: brief(cool) }));

        // ── 1. PLACE ────────────────────────────────────────────────────────
        for (const m of [hot, cool]) {
            expect(m.pixels.n, `${m.t}: the arcade lights pixels`).toBeGreaterThan(400);
            expect(m.projected.loops).toBeGreaterThan(10);
            // Strands have width and a halo: a margin in pixels plus a share of the box. MEASURED: the lit box sits
            // within 2 px of the projection at both ages, so this is ~5× the observed miss, not a guess.
            const tol = PLACE_TOL(m.projected);
            expect(boxMiss(m.pixels.box, m.projected), `t=${m.t}: the lit box is the model's loops (worst edge off by ${boxMiss(m.pixels.box, m.projected).toFixed(0)} px, tolerance ${tol.toFixed(0)})`).toBeLessThan(tol);
        }
        // The arcade GROWS: the cooled arcade is larger on screen than the hot one, as the model says it is.
        expect(cool.pixels.box.w * cool.pixels.box.h).toBeGreaterThan(1.3 * hot.pixels.box.w * hot.pixels.box.h);

        // ── 2. COLOUR IS TEMPERATURE ────────────────────────────────────────
        expect(hot.pixels.blueMinusRed, 'a hot arcade is teal: more blue than red').toBeGreaterThan(8);
        expect(cool.pixels.blueMinusRed, 'a cooled arcade is gold: more red than blue').toBeLessThan(-8);

        // NEGATIVE CONTROL (place): the v1 laws draw a different arcade — and the box follows the model that drew it.
        const v1 = await measureAt(COOL_T, 'v1', 'v1-cool');
        const v2proj = await projectedBox(page, 'v2');
        expect(v1.model).toBe('flare-shape-v1');
        const tolV1 = PLACE_TOL(v1.projected);
        expect(boxMiss(v1.pixels.box, v1.projected), 'under v1 the lit box is v1\'s loops').toBeLessThan(tolV1);
        console.log('flare look, v1 control:', JSON.stringify({ box: v1.pixels.box, missV1: +boxMiss(v1.pixels.box, v1.projected).toFixed(1), missV2: +boxMiss(v1.pixels.box, v2proj).toFixed(1), tol: +tolV1.toFixed(1) }));
        expect(boxMiss(v1.pixels.box, v2proj), 'under v1 the lit box is NOT where v2 puts the loops — the swap really changes what is drawn').toBeGreaterThan(2 * tolV1);
        const caption = await page.evaluate(() => document.querySelector('#flare-caption .fc-text')?.textContent || '');
        // The caption is hidden with the rest of the chrome, but its text must say an A/B model is on screen.
        await expect.poll(() => page.evaluate(() => document.querySelector('#flare-caption .fc-text')?.textContent || ''), { timeout: 15_000 }).toContain('shape model: flare-shape-v1');
        void caption;

        // THE ARCADE'S EXPOSURE CONTROL, and its NEGATIVE CONTROLS (colour): the same arcade with the control
        // off, and then at the strand gain that clipped every loop to a white tube (as it shipped: no control).
        await page.evaluate(() => window.__sun.setFlareModel(null));
        const before = await measureAt(HOT_T, null, 'v2-hot-again');
        await page.evaluate(() => window.__sun.flareArcade.setAutoExposure(false));
        const open = await measureAt(HOT_T, null, 'v2-hot-exposure-off');
        await page.evaluate(() => window.__sun.flareArcade.setGain(2.2));
        const loud = await measureAt(HOT_T, null, 'v2-hot-gain2.2');
        await page.evaluate(() => { const A = window.__sun.flareArcade; A.setGain(1.15); A.setAutoExposure(true); });
        const AEC = await page.evaluate(() => window.__sun.flareArcadeConst);
        console.log('flare look, clipped-white share of the lit pixels:', JSON.stringify({ shipped: before.pixels.white, exposureOff: open.pixels.white, gain22: loud.pixels.white, cool: cool.pixels.white,
            exposure: { hot: before.exposure, cool: cool.exposure } }));
        expect(before.pixels.white, 'the hot arcade is not a white slab').toBeLessThan(0.45);
        expect(cool.pixels.white, 'the cooled arcade keeps its colour').toBeLessThan(0.20);
        expect(loud.pixels.white, 'gain 2.2 with no exposure control clips far more of it').toBeGreaterThan(before.pixels.white + 0.10);
        // The control only ever turns the gain DOWN, never below its floor, and what it holds is its own stated target.
        for (const m of [before, cool]) {
            expect(m.exposure.exposure).toBeLessThanOrEqual(1); expect(m.exposure.exposure).toBeGreaterThanOrEqual(AEC.AEC_FLOOR);
            if (m.exposure.stack > AEC.AEC_TARGET) expect(m.exposure.exposure * m.exposure.stack, 'stack × exposure is the target').toBeGreaterThan(Math.min(AEC.AEC_TARGET, AEC.AEC_FLOOR * m.exposure.stack) - 0.02);
        }
        expect(open.exposure.exposure, 'off means off').toBe(1);
        // In this close-up the hot arcade stacks past the target, so the control is at work — and without it more of the arcade is white.
        expect(before.exposure.stack, 'the close-up stacks strands past the target (else this check is not exercising the control)').toBeGreaterThan(AEC.AEC_TARGET);
        expect(open.pixels.white, 'with the control off, more of the hot arcade clips').toBeGreaterThan(before.pixels.white + 0.03);

        // ── 3. THE RIBBONS ARE J-SHAPED ─────────────────────────────────────
        /** The flare's SURFACE light at one age under one model: arcade hidden, flares shown minus flares off. */
        async function surfaceAt(t, model, tag) {
            await page.evaluate(({ t, model }) => { const s = window.__sun; s.setFlareModel(model); s.holdFlareAt(t); s.flareArcade.setVisible(false); s.uniforms.u_showFlares.value = 1; }, { t, model });
            await page.waitForFunction((t) => Math.abs(window.__sun.uniforms.u_flare_t.value - t) < 1e-6 && !window.__sun.flareGeometry.arcade.active, t, { timeout: 30_000 });
            const on = await grab(page);
            if (SHOTS) writeFileSync(join(SHOTS, `${tag}.png`), await page.screenshot());
            await page.evaluate(() => { window.__sun.uniforms.u_showFlares.value = 0; });
            const off = await grab(page);
            await page.evaluate(() => { window.__sun.uniforms.u_showFlares.value = 1; });
            const pr = await hookProbes(page, t);
            return { hook: addedAt(on, off, pr.hook), mirror: addedAt(on, off, pr.mirror), probes: pr.hook.length, sweepDeg: pr.hookDef.sweep * 180 / Math.PI };
        }
        const j2 = await surfaceAt(EARLY_T, null, 'v2-ribbons');
        const j1 = await surfaceAt(EARLY_T, 'v1', 'v1-ribbons');
        await page.evaluate(() => { const s = window.__sun; s.setFlareModel(null); s.flareArcade.setVisible(true); });
        out.hooks = { v2: j2, v1: j1 };
        console.log('flare look, J hooks (light added at the hooks vs at their mirror):', JSON.stringify({ v2: j2, v1: j1 }));
        expect(j2.probes, 'the model has hook points to probe').toBeGreaterThan(12);
        expect(j2.hook, 'the hooks are lit').toBeGreaterThan(12);
        expect(j2.hook, 'and the mirrored ends are not: the ribbons are J-shaped, one hook each').toBeGreaterThan(3 * Math.max(j2.mirror, 1));
        // NEGATIVE CONTROL: straight ribbons light the two sets of points alike (the site-centred glows are symmetric).
        expect(Math.abs(j1.hook - j1.mirror), 'under v1 there is no hook: the same light at both').toBeLessThan(0.25 * j2.hook);
        expect(j1.hook, 'and it is the faint symmetric glow, not a ribbon').toBeLessThan(0.5 * j2.hook);

        // ── 4. THE ERUPTING ROPE ────────────────────────────────────────────
        const ROPE_T = 60;                         // 2.9 min: the slow rise, the rope still low over the arcade
        const call = await page.evaluate(() => window.__sun.flareEruption);
        expect(call.eruptive, 'an X2 with no CME report is drawn eruptive on the class prior').toBe(true);
        expect(call.basis).toBe('class-prior');
        await page.evaluate((t) => { const s = window.__sun; s.holdFlareAt(t); s.flareArcade.setVisible(false); s.flareRope.setVisible(true); }, ROPE_T);
        await page.waitForFunction(() => window.__sun.flareGeometry.rope.active && window.__sun.flareGeometry.rope.strands > 0, null, { timeout: 30_000 });
        const ropeOn = await grab(page);
        if (SHOTS) writeFileSync(join(SHOTS, 'v2-rope.png'), await page.screenshot());
        const ropeProj = await page.evaluate(({ t }) => {
            const s = window.__sun, T = s.THREE, site = s.flareRope.site;
            const strands = s.flareModel.ropeStrands({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle, t, cls: site.cls, chirality: site.chirality, n: s.flareRope.state.count, samples: s.flareRope.state.samples });
            const el = s.renderer.domElement, r = el.getBoundingClientRect(), M = s.flareRope.group.matrixWorld, v = new T.Vector3();
            let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
            for (const S of strands) for (const p of S.pts) {
                v.set(p[0], p[1], p[2]).applyMatrix4(M).project(s.camera);
                const x = r.left + (v.x * 0.5 + 0.5) * r.width, y = r.top + (-v.y * 0.5 + 0.5) * r.height;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, state: s.flareGeometry.rope };
        }, { t: ROPE_T });
        await page.evaluate(() => window.__sun.flareRope.setVisible(false));
        await page.waitForFunction(() => !window.__sun.flareGeometry.rope.active, null, { timeout: 30_000 });
        const ropeOff = await grab(page);
        const ropePx = arcadePixels(ropeOn, ropeOff, { thresh: 14 });
        out.rope = { pixels: ropePx, projected: ropeProj };
        console.log('flare look, rope:', JSON.stringify({ box: ropePx.box, proj: { x0: Math.round(ropeProj.x0), x1: Math.round(ropeProj.x1), y0: Math.round(ropeProj.y0), y1: Math.round(ropeProj.y1) },
            n: ropePx.n, added: ropePx.added && ropePx.added.map((v) => +v.toFixed(1)), apexR: ropeProj.state.apexR }));
        expect(ropePx.n, 'the rope lights pixels').toBeGreaterThan(600);
        // Strands thin out and dim toward the feet, so the lit box may fall a little INSIDE the projection — never outside it.
        const rtol = PLACE_TOL(ropeProj) + 0.10 * Math.max(ropeProj.w, ropeProj.h);
        expect(boxMiss(ropePx.box, ropeProj), `the lit region is the model's strands (worst edge ${boxMiss(ropePx.box, ropeProj).toFixed(0)} px, tolerance ${rtol.toFixed(0)})`).toBeLessThan(rtol);
        expect(ropePx.box.x0).toBeGreaterThan(ropeProj.x0 - PLACE_TOL(ropeProj)); expect(ropePx.box.x1).toBeLessThan(ropeProj.x1 + PLACE_TOL(ropeProj));
        expect(ropePx.box.y0).toBeGreaterThan(ropeProj.y0 - PLACE_TOL(ropeProj)); expect(ropePx.box.y1).toBeLessThan(ropeProj.y1 + PLACE_TOL(ropeProj));
        expect(ropeProj.state.apexR, 'it stands above the arcade').toBeGreaterThan(cool.projected ? 1.05 : 1.05);
        // NEGATIVE CONTROL: the same flare, stated confined — no rope, and the caption says so.
        const confined = await page.evaluate(({ SITE, t }) => {
            const s = window.__sun;
            s.testFlare(SITE.cls, SITE.latDeg, SITE.lonDeg, { flash: false, eruptive: false });
            s.holdFlareAt(t); s.flareRope.setVisible(true);
            return s.flareEruption;
        }, { SITE, t: ROPE_T });
        expect(confined).toMatchObject({ eruptive: false, basis: 'stated' });
        await page.evaluate(() => new Promise((ok) => { let n = 0; const f = () => (++n >= 4 ? ok() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
        expect((await page.evaluate(() => window.__sun.flareGeometry.rope)).active, 'a confined flare draws no rope').toBe(false);
        await expect.poll(() => page.evaluate(() => document.querySelector('#flare-caption .fc-text')?.textContent || ''), { timeout: 15_000 }).toContain('confined');

        if (SHOTS) writeFileSync(join(SHOTS, 'measurements.json'), JSON.stringify(out, null, 1));
        expect(errs, errs.join('\n')).toEqual([]);
    });
});
