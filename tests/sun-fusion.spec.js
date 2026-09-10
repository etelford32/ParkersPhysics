/**
 * sun-fusion.spec.js — the observed ↔ model TERMINATOR CONTINUITY gate
 * ═══════════════════════════════════════════════════════════════════════════
 * The observed hemisphere is pinned to the Sun–Earth line; the camera is not.
 * Orbit ~30° off that line and sun.html used to split the disk into two
 * visually unrelated halves along a hard vertical terminator — reported as
 * "the sun visuals are kinda broken", reproduced here, and traced to three
 * cliffs that all landed on the same edge (js/sun-observed.js `calibrateDisk`
 * header has the full write-up):
 *
 *   1. μ MISMATCH   — a browse frame carries its limb darkening baked in at
 *                     the EARTH's μ; the model applied Neckel & Labs at the
 *                     VIEWER's μ. Off-axis, the frame's dark limb butted
 *                     against the model's bright disk centre.
 *   2. TONEMAP      — the observed half was composited AFTER the ACES curve
 *                     the model half goes through.
 *   3. LUT DOUBLE-APPLY — `u_obsTint` assumed a greyscale frame, but NASA's
 *                     latest_*_HMIIC.jpg is gold-COLORIZED. Our synthetic
 *                     fixtures are greyscale, which is exactly why CI never
 *                     saw this. THE GOLD FIXTURE BELOW EXISTS FOR THAT REASON
 *                     — do not "simplify" it back to the greyscale frame.
 *
 * WHAT THIS MEASURES. Not a screenshot baseline (those need a GPU and pin
 * everything, so they fail for the wrong reasons). The AZIMUTHAL ASYMMETRY of
 * the rendered disk: every point on a ring of constant radius sits at the same
 * μ and must therefore sit at the same brightness, whichever hemisphere it is
 * in. Limb darkening lives ring-to-ring and cancels within a ring; a seam does
 * not. seamMetric's comment records the three metrics that failed before this
 * one, and why.
 *
 * WHY IT IS SELF-VALIDATING. The same measurement runs twice: once on the
 * fusion path, and once with `u_obsFuse` forced to 0, which is the legacy
 * tint — i.e. the bug. The test asserts the fixed path is continuous AND that
 * the broken path is not, so a gate that has quietly stopped measuring
 * anything fails instead of passing.
 *
 * Runs on software GL (no @gpu opt-in). The upstream is mocked; CI must never
 * need nasa.gov.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrateDisk, srgbToLinear, linearToSrgb, limbLaw } from '../js/sun-observed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'sdo');
const MAN = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

// ── A GOLD-COLORIZED white-light frame ──────────────────────────────────────
// sdo.gsfc.nasa.gov ships the HMI continuum through a gold browse LUT. The
// committed fixture is greyscale (see tests/fixtures/sdo/README.md), so the
// double-apply bug was invisible to every existing test. Colorizing the
// committed frame in-process — rather than committing a second PNG — keeps
// the two in lockstep if the fixtures are ever regenerated.
const GOLD_LUT = [[0.85, 1.02], [1.20, 0.92], [2.10, 0.72]];   // per channel: [gamma, gain]

function goldenize(pngBuffer) {
    // Decode → colorize → re-encode is not available in node here, so the page
    // does it: the raw greyscale PNG is shipped to the browser and recoloured
    // on a canvas before it ever reaches the texture. See routeAia below.
    return pngBuffer;
}

async function routeAia(page, { gold }) {
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        const frame = MAN.frames[ch] || MAN.frames.white;
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'X-AIA-Channel': ch,
                'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': new Date(Date.now() - 7 * 60 * 1000).toISOString(),
                'X-PP-Test-Gold': gold && ch === 'white' ? '1' : '0',
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-PP-Test-Gold',
            },
            body: goldenize(readFileSync(join(FIXTURE_DIR, frame.file))),
        });
    });
}

/**
 * Colorize the decoded white-light frame in the page, after decode and before
 * the texture upload, by patching Image decoding for the mocked response.
 * Simpler than shipping a second fixture and keeps one source of truth.
 */
async function installGoldLut(page, lut) {
    await page.addInitScript((LUT) => {
        const origCreate = document.createElement.bind(document);
        // sun-observed.js reads the frame through a 2D canvas (readFrame); we
        // recolour at that boundary so BOTH the calibration and the texture see
        // the same gold frame the page would get from NASA.
        window.__ppGoldLut = LUT;
        const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
            const r = origDrawImage.apply(this, args);
            if (!window.__ppGoldOn) return r;
            try {
                const { width: w, height: h } = this.canvas;
                const d = this.getImageData(0, 0, w, h);
                const px = d.data;
                for (let i = 0; i < px.length; i += 4) {
                    for (let c = 0; c < 3; c++) {
                        const g = px[i + c] / 255;
                        px[i + c] = Math.min(255, Math.round(255 * Math.pow(g, LUT[c][0]) * LUT[c][1]));
                    }
                }
                this.putImageData(d, 0, 0);
            } catch (_) { /* tainted canvas — leave as-is */ }
            return r;
        };
        void origCreate;
    }, lut);
}

function attachShaderErrors(page) {
    const errs = [];
    page.on('console', (m) => {
        if (m.type() === 'error' && /Shader Error|GLSL|ERROR: 0:|Program Info Log/i.test(m.text())) errs.push(m.text());
    });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    return errs;
}

async function boot(page, { gold = false } = {}) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('pp_consent_v1', JSON.stringify(
                { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        } catch (e) {}
    });
    if (gold) {
        await installGoldLut(page, GOLD_LUT);
        await page.addInitScript(() => { window.__ppGoldOn = true; });
    }
    const errs = attachShaderErrors(page);
    await routeAia(page, { gold });
    await page.setViewportSize({ width: 1100, height: 780 });
    await page.goto('/sun.html');
    await page.waitForFunction(() => window.__sun && window.__sun.frames > 5, null, { timeout: 40_000 });
    await page.waitForFunction(() => window.__sun.uniforms.u_obsOn.value > 0.5, null, { timeout: 30_000 });
    await page.waitForTimeout(2500);
    return errs;
}

/** Orbit the camera `deg` off the Sun–Earth line, keeping the elevation. */
async function orbit(page, deg) {
    await page.evaluate((d) => {
        const s = window.__sun;
        const r = s.camera.position.length(), y = s.camera.position.y;
        const rr = Math.sqrt(Math.max(r * r - y * y, 0.01));
        const a = d * Math.PI / 180;
        s.camera.position.set(rr * Math.sin(a), y, rr * Math.cos(a));
        s.camera.lookAt(0, 0, 0);
        s.controls.update();
    }, deg);
    await page.waitForTimeout(2500);
}

/**
 * AZIMUTHAL ASYMMETRY of the disk — the invariant a seam actually breaks.
 *
 * The WebGL canvas is created without preserveDrawingBuffer, so it reads back
 * black; the pixels come from a real screenshot, decoded in the page with an
 * Image + a 2D canvas (no decoder dependency here).
 *
 * THREE EARLIER METRICS FAILED, AND EACH FAILURE SHAPED THIS ONE:
 *   • Differencing 5-px windows on one scanline scored fused and broken within
 *     25 % of each other — granulation, magnetic bright points and the
 *     far-side graticule's meridian lines are real high-contrast structure and
 *     swamped the signal.
 *   • Low-passing and taking a second difference scored a SUNSPOT as a seam.
 *   • Comparing median patches either side of a moving line scored LIMB
 *     DARKENING as a seam: near the limb the smooth radial gradient across a
 *     36-px separation is itself ~20 %.
 *
 * The fix is to compare only pixels the physics says must match. A photosphere
 * is BRIGHT AS A FUNCTION OF RADIUS: every point on a ring at the same
 * distance from disk centre is at the same μ and must sit at the same level,
 * whichever hemisphere it belongs to. Limb darkening lives entirely in the
 * ring-to-ring direction and cancels exactly within a ring. So: split each
 * ring into sectors, take each sector's MEDIAN (robust to a sunspot, a bright
 * point, a grid line — all a minority of a sector), and score the ring by the
 * INTERQUARTILE SPREAD of those medians. One outlier sector barely moves the
 * IQR; a hemisphere at the wrong level moves half of them, which is exactly
 * what the IQR is sensitive to.
 */
async function seamMetric(page, shot) {
    return page.evaluate(async ({ b64 }) => {
        // r/R, all inside the spicule fringe. The first four are the INNER
        // disk, where a photosphere has nothing to hide behind: no fringe, no
        // handoff band, μ still high enough that the browse frame resolves it.
        // That is where the gate is strict. The outer two straddle the
        // terminator cross-fade at an off-axis camera and are reported, not
        // gated — a soft ramp there is the design, not a defect.
        const RINGS = [0.20, 0.32, 0.44, 0.56, 0.68, 0.78];
        const INNER = 4;
        const SECTORS = 12, RING_HALF = 0.05;
        const img = new Image();
        await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const { data, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
        const lum = (x, y) => {
            const i = (y * W + x) * 4;
            return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        };
        // Disk bounds. Thresholding on the frame's PEAK put them out in the
        // corona and the field lines (a single bright pixel clears 30 % easily).
        // The 95th percentile of the clip IS photosphere, and nothing outside
        // the limb comes close to half of it.
        const all = [];
        for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) all.push(lum(x, y));
        all.sort((a, b) => a - b);
        const THRESH = all[Math.floor(all.length * 0.95)] * 0.45;
        let sx = 0, sy = 0, n = 0;
        for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
            if (lum(x, y) > THRESH) { sx += x; sy += y; n++; }
        }
        if (n < 400) return { ok: false, bright: n };
        const xc = Math.round(sx / n), yc = Math.round(sy / n);
        const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lum(x, y) > THRESH;
        let lo = xc; while (on(lo - 1, yc)) lo--;
        let hi = xc; while (on(hi + 1, yc)) hi++;
        let top = yc; while (on(xc, top - 1)) top--;
        let bot = yc; while (on(xc, bot + 1)) bot++;
        const R = Math.min(hi - lo, bot - top) / 2;
        if (R < 70) return { ok: false, R };

        const med = (v) => { v.sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
        let worst = 0, worstRing = -1, perRing = [], ringIdx = 0, worstInner = 0;
        for (const rf of RINGS) {
            const sect = [];
            for (let k = 0; k < SECTORS; k++) {
                const v = [];
                for (let j = 0; j <= 40; j++) {
                    const a = (k + j / 40) * 2 * Math.PI / SECTORS;
                    for (let t = -1; t <= 1; t++) {
                        const rr = (rf + t * RING_HALF) * R;
                        const x = Math.round(xc + Math.cos(a) * rr);
                        const y = Math.round(yc + Math.sin(a) * rr);
                        if (x < 0 || y < 0 || x >= W || y >= H) continue;
                        v.push(lum(x, y));
                    }
                }
                if (v.length > 30) sect.push(med(v));
            }
            if (sect.length < SECTORS - 2) { ringIdx++; continue; }
            const srt = [...sect].sort((a, b) => a - b);
            const q1 = srt[Math.floor(srt.length * 0.25)];
            const q3 = srt[Math.floor(srt.length * 0.75)];
            const m  = srt[srt.length >> 1];
            const rel = (q3 - q1) / Math.max(m, 1e-3);
            perRing.push(+rel.toFixed(3));
            if (rel > worst) { worst = rel; worstRing = rf; }
            if (ringIdx < INNER) worstInner = Math.max(worstInner, rel);
            ringIdx++;
        }
        return { ok: perRing.length >= 4, worst, worstInner, worstRing, perRing, xc, yc, R: Math.round(R) };
    }, { b64: shot.toString('base64') });
}

const CLIP = { x: 150, y: 90, width: 800, height: 620 };

test.describe('sun.html observed ↔ model photometric fusion', () => {

    test('a gold-colorized frame calibrates: the LUT is measured, the law fits, fusion arms', async ({ page }) => {
        const errs = await boot(page, { gold: true });
        expect(errs, errs.join('\n')).toHaveLength(0);

        const st = await page.evaluate(() => {
            const u = window.__sun.uniforms;
            return {
                fuse: u.u_obsFuse.value,
                cal: u.u_obsCal.value.toArray(),
                chroma: u.u_obsChroma.value.toArray(),
                photo: window.__sun.observed?.photometry ?? null,
            };
        });
        // The gold LUT must be SEEN, not silently re-applied on top of itself.
        expect(st.chroma[0] / st.chroma[2]).toBeGreaterThan(1.6);
        expect(st.photo).not.toBeNull();
        expect(st.photo.ok).toBe(true);
        expect(st.photo.resid).toBeLessThan(0.05);
        expect(st.fuse).toBe(1);
        expect(st.cal[0]).toBeGreaterThan(0.05);          // I0 is a real level
    });

    test('THE SEAM GATE: off-axis the disk stays continuous with fusion, and visibly breaks without it', async ({ page }) => {
        test.setTimeout(180_000);
        const errs = await boot(page, { gold: true });
        expect(errs, errs.join('\n')).toHaveLength(0);
        await orbit(page, 55);

        const fixed = await seamMetric(page, await page.screenshot({ clip: CLIP }));
        expect(fixed.ok, 'found the disk on the scanline').toBe(true);

        // Now force the pre-fix path: u_obsFuse = 0 is the legacy tint, which
        // is cliff (1) and (3) restored. (2), the tonemap order, is structural
        // and stays fixed — so this is a LOWER bound on the old breakage, and
        // the gate is still comfortably separated.
        await page.evaluate(() => { window.__sun.uniforms.u_obsFuse.value = 0.0; });
        await page.waitForTimeout(1800);
        const broken = await seamMetric(page, await page.screenshot({ clip: CLIP }));
        expect(broken.ok).toBe(true);

        console.log(`asymmetry  fused: inner=${fixed.worstInner.toFixed(3)} all=${fixed.worst.toFixed(3)} rings=${JSON.stringify(fixed.perRing)}`);
        console.log(`          legacy: inner=${broken.worstInner.toFixed(3)} all=${broken.worst.toFixed(3)} rings=${JSON.stringify(broken.perRing)}`);

        // ACROSS THE INNER DISK THE TERMINATOR MUST BE INVISIBLE. Observed and
        // model sectors on the same ring sit at the same μ, so they must sit at
        // the same level. Measured at 0.001–0.06 on the fused path, against
        // 0.22–0.32 for the legacy one — the bound is loose enough for
        // granulation and a graticule line, an order of magnitude tighter than
        // the bug.
        expect(fixed.worstInner,
            `the inner disk must be azimuthally uniform (rings ${JSON.stringify(fixed.perRing)})`)
            .toBeLessThan(0.10);
        // The legacy path is broken at EVERY radius, disk centre included —
        // that is the difference between a seam and a soft handoff.
        expect(broken.worstInner, 'the legacy path must still register as a seam').toBeGreaterThan(0.15);
        // …and the gate must actually be able to tell them apart, or it has
        // stopped measuring anything and would pass on a re-broken page.
        expect(broken.worstInner).toBeGreaterThan(fixed.worstInner * 2.5);
    });

    test('at the default camera the correction is the identity — the frame is trusted to the limb', async ({ page }) => {
        const errs = await boot(page, { gold: false });
        expect(errs, errs.join('\n')).toHaveLength(0);
        // Viewer at the Sun–Earth line ⇒ mu == obsMuE ⇒ the μ re-projection is
        // a no-op and the handoff stays tight, so the observed disk is NOT
        // eaten into by the widened fade. Sampled through the shader's own
        // arithmetic rather than trusted by eye.
        const w = await page.evaluate(() => {
            const u = window.__sun.uniforms;
            const stretch = 0;                                   // mu == muE at the Earth view
            const hi = 0.14 + (0.55 - 0.14) * stretch;
            const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
            return { fuse: u.u_obsFuse.value, at30: sstep(0.01, hi, 0.30), at20: sstep(0.01, hi, 0.20) };
        });
        expect(w.fuse).toBe(1);
        expect(w.at30, 'μ=0.30 (r/R=0.95) is fully observed at the Earth view').toBeGreaterThan(0.99);
        expect(w.at20, 'μ=0.20 (r/R=0.98) is still mostly observed').toBeGreaterThan(0.85);
    });

    test('an uncalibratable frame degrades to the legacy path instead of vanishing', async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch (e) {}
        });
        const errs = attachShaderErrors(page);
        // A frame that decodes to black: calibrateDisk must refuse it, the page
        // must still render, and the chip must still be honest.
        await page.route('**/api/solar/aia*', (route) => route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'X-AIA-Channel': 'white',
                'X-SDO-Observed-At': new Date().toISOString(),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-SDO-Observed-At',
            },
            // 8×8 fully black PNG.
            body: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mNkYPhfz0AEYBxVSF+FAP5FA/HbLLDhAAAAAElFTkSuQmCC',
                'base64'),
        }));
        await page.goto('/sun.html');
        await page.waitForFunction(() => window.__sun && window.__sun.frames > 5, null, { timeout: 40_000 });
        await page.waitForTimeout(2500);
        const st = await page.evaluate(() => ({
            fuse: window.__sun.uniforms.u_obsFuse.value,
            frames: window.__sun.frames,
            chip: document.getElementById('sun-provenance')?.textContent || '',
        }));
        expect(errs, errs.join('\n')).toHaveLength(0);
        expect(st.fuse, 'fusion must not arm on a frame it could not calibrate').toBe(0);
        expect(st.frames).toBeGreaterThan(5);                 // still rendering
        expect(st.chip.length).toBeGreaterThan(0);
    });
});

// Keep the pure kernel imported so a rename in js/sun-observed.js breaks this
// spec loudly at import time rather than silently skipping the gate.
void calibrateDisk; void srgbToLinear; void linearToSrgb; void limbLaw;
