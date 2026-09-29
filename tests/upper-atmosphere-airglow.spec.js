/**
 * upper-atmosphere-airglow.spec.js — where the airglow is, measured
 * ═══════════════════════════════════════════════════════════════════════════
 * The airglow used to be one even ring. js/upper-atmosphere-airglow-field.js
 * gives it structure and the volume shader mirrors that kernel; these gates
 * measure the structure on SOLO renders of the volume (density off, airglow
 * only, one group isolated where the question is about one group), at a
 * PINNED scene instant — the 2026 March equinox, 00 UT, so the sub-solar
 * point is on the 180° meridian and 45°W is at 21 h local time.
 *
 * Every gate carries a runtime NEGATIVE CONTROL: the same render with the
 * piece under test switched off by patching the shader text (the patch
 * throws if its target is gone, so a refactor cannot turn a control into a
 * no-op), or with the physics driver itself off (quiet Kp for the SAR arc).
 * Positions are predicted by the NODE-side kernel and projected with the
 * page's own camera, so a mirror that drifts from the kernel fails here.
 *
 *   day/night     the red line is brighter where 250 km is sunlit
 *   arcs          two red crests at ±crestLat of magnetic latitude, where
 *                 the kernel puts them, over a trough at the dip equator
 *   bubble        a plasma bubble cuts a dark gap through the arc
 *   SAR arc       a storm puts a red band on the plasmapause footprint
 *   ripples       gravity-wave packets ripple the green/OH band
 *   frame         the volume's magnetic pole is in the page's ONE frame
 *                 (it was mirrored to 72.7°E until this change)
 *
 * UA_METRICS_LOG=1 prints the measurements; UA_METRICS_PNG=<dir> writes the
 * renders.
 */

import { test, expect } from '@playwright/test';
import { boot, log, dumpPng } from './helpers/ua-render.mjs';
import { imageFromCapture } from './helpers/image-metrics.mjs';
import {
    latLonToScene, magneticLatitude, DIPOLE_POLE, R_EARTH_KM,
} from '../js/upper-atmosphere-column.js';
import { sarArc, GW, AIRGLOW_FIELD } from '../js/upper-atmosphere-airglow-field.js';

test.describe.configure({ timeout: 240_000 });

const T0 = Date.UTC(2026, 2, 20, 0, 0);

// Isolate one group for a question about one group.
const RED_ONLY = [['float mesoRate = gm.a * fM.x;', 'float mesoRate = 0.0;']];
const MESO_ONLY = [['float redRate = fl.g * redF + fl.b * sarF;', 'float redRate = 0.0;']];
// Controls: each switches off exactly the piece under test.
const NO_DAYGLOW = [['smoothstep(0.0, 0.1, cosChi), agRedDay(cosChi));', 'smoothstep(0.0, 0.1, cosChi), 1.0);']];
const NO_ARCS = [['max(arcs.r, 0.0)', '0.0']];
const NO_BUBBLES = [['clamp(arcs.b, 0.0, 1.0)', '0.0']];
const NO_RIPPLES = [[`1.0 + ${Number(AIRGLOW_FIELD.gwAmpMeso).toPrecision(9)} * gw`, '1.0 + 0.0 * gw']];

async function setup(page) {
    await boot(page, { sceneTimeMs: T0 });
    await page.evaluate(() => {
        const g = window.__ua.globe;
        g._volume.setDensityVisible(false);
        g._volume.setAirglowVisible(true);
        g._volume.setQuality(24);
        g.stepFrames(2, 1 / 60, { render: 'none' });   // sun + field for the pinned instant
        /** Camera at (lat, lon, alt) looking at the Earth's centre, north up. */
        window.__agNadir = (latDeg, lonDeg, altKm) => {
            const d = Math.PI / 180;
            const r = 1 + altKm / 6371;
            const u = [Math.cos(latDeg * d) * Math.cos(lonDeg * d), Math.sin(latDeg * d), -Math.cos(latDeg * d) * Math.sin(lonDeg * d)];
            const c = g._camera;
            c.up.set(0, 1, 0);
            c.position.set(u[0] * r, u[1] * r, u[2] * r);
            c.lookAt(0, 0, 0);
            c.updateMatrixWorld();
            g._volume.update(c, { govern: false, viewportHeight: g.canvas.clientHeight });
            g._updateAirglowField(true);
        };
        /** Solo volume render with shader patches applied (and restored). */
        window.__agCapture = (patches) => {
            const mat = g._volume._material;
            const src = mat.fragmentShader;
            let s = src;
            for (const [a, b] of patches) {
                if (!s.includes(a)) throw new Error('patch did not apply: ' + a);
                s = s.split(a).join(b);
            }
            mat.fragmentShader = s; mat.needsUpdate = true;
            const cap = window.__uaSolo([g._volume._mesh]);
            mat.fragmentShader = src; mat.needsUpdate = true;
            return cap;
        };
        /** Project world points to pixel rows/cols of the drawing buffer. */
        window.__agProject = (pts) => {
            const gl = g._renderer.getContext();
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const V = g._camera.position.constructor;
            return pts.map((p) => {
                const v = new V(p[0], p[1], p[2]).project(g._camera);
                return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
            });
        };
    });
}

const capture = (page, patches) => page.evaluate((p) => window.__agCapture(p), patches);

/** Mean of one channel over a vertical strip (cols x0..x1), per row. */
function columnProfile(img, x0, x1, ch = 0) {
    const out = new Float64Array(img.h);
    for (let y = 0; y < img.h; y++) {
        let s = 0;
        for (let x = x0; x <= x1; x++) s += img.data[(y * img.w + x) * 4 + ch];
        out[y] = s / (x1 - x0 + 1);
    }
    return out;
}
function rowProfile(img, y0, y1, ch = 0) {
    const out = new Float64Array(img.w);
    for (let x = 0; x < img.w; x++) {
        let s = 0;
        for (let y = y0; y <= y1; y++) s += img.data[(y * img.w + x) * 4 + ch];
        out[x] = s / (y1 - y0 + 1);
    }
    return out;
}
const mean = (a, i0, i1) => { let s = 0; for (let i = i0; i <= i1; i++) s += a[i]; return s / (i1 - i0 + 1); };

/** Geographic latitude on meridian `lonDeg` where magnetic latitude = mlDeg. */
function latForMagLat(mlDeg, lonDeg) {
    let lo = -89, hi = 89;
    for (let k = 0; k < 60; k++) {
        const m = 0.5 * (lo + hi);
        if (magneticLatitude(m, lonDeg) < mlDeg) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
}
const shellPoint = (latDeg, lonDeg, altKm) => latLonToScene(latDeg, lonDeg).map((v) => v * (1 + altKm / R_EARTH_KM));

test('the volume\'s magnetic pole is in the page\'s ONE frame (it was mirrored to 72.7°E)', async ({ page }) => {
    await setup(page);
    const pole = await page.evaluate(() => window.__ua.globe._volume._material.uniforms.uMagPole.value.toArray());
    const want = latLonToScene(DIPOLE_POLE.latDeg, DIPOLE_POLE.lonDeg);
    for (let k = 0; k < 3; k++) expect(Math.abs(pole[k] - want[k])).toBeLessThan(1e-6);
    // …which is the dipole the fountain's dip equator and the kernel use:
    // the pole is 90° of magnetic latitude.
    const ll = { lat: DIPOLE_POLE.latDeg, lon: DIPOLE_POLE.lonDeg };
    expect(magneticLatitude(ll.lat, ll.lon)).toBeGreaterThan(89.999);
});

test('the red line is brighter where 250 km is sunlit (control: dayglow off)', async ({ page }) => {
    await setup(page);
    // The same limb geometry at local noon (180°) and local midnight (0°).
    const at = async (lonDeg, patches) => {
        await page.evaluate((lon) => {
            window.__ua.globe.diveTo({ latDeg: 0, lonDeg: lon, altKm: 400, headingDeg: 0, pitchDeg: -10, durationSec: 0.5 });
            window.__ua.globe.stepFrames(40, 1 / 60, { render: 'none' });
            window.__ua.globe._updateAirglowField(true);
        }, lonDeg);
        return imageFromCapture(await capture(page, patches));
    };
    const sumR = (img) => { let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i]; return s; };
    // Arcs and bubbles off on BOTH sides, so the only thing that can differ
    // between noon and midnight is the dayglow (the midnight limb crosses
    // the equatorial arcs; with them on, the control read 0.89).
    const base = [...RED_ONLY, ...NO_ARCS, ...NO_BUBBLES];
    const noon = await at(180, base), night = await at(0, base);
    const noonC = await at(180, [...base, ...NO_DAYGLOW]), nightC = await at(0, [...base, ...NO_DAYGLOW]);
    dumpPng('agl-noon', { w: noon.w, h: noon.h, b64: Buffer.from(noon.data).toString('base64') });
    dumpPng('agl-night', { w: night.w, h: night.h, b64: Buffer.from(night.data).toString('base64') });
    const r = sumR(noon) / sumR(night), rc = sumR(noonC) / sumR(nightC);
    log('day/night red', r.toFixed(3), 'control', rc.toFixed(3));
    expect(sumR(night)).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(1.8);
    expect(Math.abs(rc - 1), 'the control (no dayglow) must see no day/night difference').toBeLessThan(0.05);
});

test('the equatorial arcs sit where the kernel puts them, and a bubble cuts them (controls: arcs off, bubbles off)', async ({ page }) => {
    await setup(page);
    // The evening meridian with the strongest crest and no bubble near it.
    const pick = await page.evaluate(() => {
        const s = window.__ua.globe._arcs;
        let best = null;
        for (let lon = -75; lon <= -25; lon += 0.5) {
            const a = s.sampleAt(lon);
            let clear = true;
            for (let d = -4; d <= 4; d += 0.5) if (s.sampleAt(lon + d).bubble > 0.02) clear = false;
            if (clear && (!best || a.crest > best.crest)) best = { lon, ...a };
        }
        return best;
    });
    log('arcs meridian', JSON.stringify(pick));
    expect(pick, 'a clear evening meridian').not.toBeNull();
    expect(pick.crest).toBeGreaterThan(0.25);
    const lon = pick.lon;
    const latEq = latForMagLat(0, lon);
    await page.evaluate(([la, lo]) => window.__agNadir(la, lo, 9000), [latEq, lon]);

    // Predicted rows of the two crests and the trough, on the 250 km shell.
    const [pN, pS, pEq] = await page.evaluate((pts) => window.__agProject(pts), [
        shellPoint(latForMagLat(pick.crestLatDeg, lon), lon, 250),
        shellPoint(latForMagLat(-pick.crestLatDeg, lon), lon, 250),
        shellPoint(latEq, lon, 250),
    ]);
    const img = imageFromCapture(await capture(page, RED_ONLY));
    const ctl = imageFromCapture(await capture(page, [...RED_ONLY, ...NO_ARCS]));
    dumpPng('agl-arcs', { w: img.w, h: img.h, b64: Buffer.from(img.data).toString('base64') });
    const cx = Math.round(pEq.x);
    const prof = columnProfile(img, cx - 3, cx + 3), profC = columnProfile(ctl, cx - 3, cx + 3);
    const near = (p, y) => mean(p, Math.round(y) - 2, Math.round(y) + 2);
    // The brightest row within ±25 px of each prediction.
    const peakAround = (p, y) => {
        let best = -1, at = 0;
        for (let k = Math.round(y) - 25; k <= Math.round(y) + 25; k++) if (p[k] > best) { best = p[k]; at = k; }
        return { at, v: best };
    };
    const n = peakAround(prof, pN.y), s = peakAround(prof, pS.y);
    const contrast = Math.min(near(prof, pN.y), near(prof, pS.y)) / near(prof, pEq.y);
    const contrastC = Math.min(near(profC, pN.y), near(profC, pS.y)) / near(profC, pEq.y);
    log('arcs predicted rows', pN.y.toFixed(1), pS.y.toFixed(1), 'trough', pEq.y.toFixed(1),
        'found', n.at, s.at, 'contrast', contrast.toFixed(3), 'control', contrastC.toFixed(3));
    expect(Math.abs(n.at - pN.y), 'northern crest where the kernel puts it').toBeLessThan(8);
    expect(Math.abs(s.at - pS.y), 'southern crest where the kernel puts it').toBeLessThan(8);
    expect(contrast).toBeGreaterThan(1.25);
    expect(contrastC, 'the control (arcs off) has no crests over the trough').toBeLessThan(1.08);

    // A bubble on this meridian: field-aligned, so it darkens BOTH crests.
    await page.evaluate((lo) => {
        const g = window.__ua.globe;
        const f = g._arcs.fountain;
        f.cells[0].bubbles.push({ id: 'gate', lonDeg: lo, apexKm: 900, ageS: 1200, ttlS: 7200, strength: 1 });
        g.refreshAirglowField();
    }, lon);
    const bub = imageFromCapture(await capture(page, RED_ONLY));
    const bubC = imageFromCapture(await capture(page, [...RED_ONLY, ...NO_BUBBLES]));
    dumpPng('agl-bubble', { w: bub.w, h: bub.h, b64: Buffer.from(bub.data).toString('base64') });
    const depth = (im) => {
        const out = [];
        for (const p of [pN, pS]) {
            const row = rowProfile(im, Math.round(p.y) - 2, Math.round(p.y) + 2);
            const inGap = mean(row, cx - 2, cx + 2);
            const beside = 0.5 * (mean(row, cx - 60, cx - 50) + mean(row, cx + 50, cx + 60));
            out.push(1 - inGap / beside);
        }
        return out;
    };
    const d = depth(bub), dC = depth(bubC);
    log('bubble depth N/S', d.map((v) => v.toFixed(3)), 'control', dC.map((v) => v.toFixed(3)));
    for (const v of d) expect(v).toBeGreaterThan(0.2);
    for (const v of dC) expect(Math.abs(v), 'the control (bubbles off) has no gap').toBeLessThan(0.06);
});

test('a storm puts a SAR arc on the plasmapause footprint (control: the same night at quiet Kp)', async ({ page }) => {
    await setup(page);
    const lon = 0;                                       // local midnight at 00 UT
    const kp = 8;
    const sar = sarArc(kp);
    const latArc = latForMagLat(sar.latDeg, lon);
    await page.evaluate(([la, lo]) => window.__agNadir(la, lo, 9000), [latArc - 6, lon]);
    const [pArc] = await page.evaluate((pts) => window.__agProject(pts), [shellPoint(latArc, lon, AIRGLOW_FIELD.sarPeakKm)]);
    const run = async (ap) => {
        await page.evaluate((a) => { const g = window.__ua.globe; g._airglowAp = a; g._updateAirglowField(true); }, ap);
        return imageFromCapture(await capture(page, RED_ONLY));
    };
    const storm = await run(240), quiet = await run(7);  // Ap 240 = Kp 8; Ap 7 = Kp 2
    dumpPng('agl-sar', { w: storm.w, h: storm.h, b64: Buffer.from(storm.data).toString('base64') });
    const cx = Math.round(storm.w / 2);
    const bump = (im) => {
        const p = columnProfile(im, cx - 3, cx + 3);
        return mean(p, Math.round(pArc.y) - 2, Math.round(pArc.y) + 2)
            / (0.5 * (mean(p, Math.round(pArc.y) - 70, Math.round(pArc.y) - 60)
                    + mean(p, Math.round(pArc.y) + 60, Math.round(pArc.y) + 70)));
    };
    const b = bump(storm), bq = bump(quiet);
    log('SAR at row', pArc.y.toFixed(1), 'bump', b.toFixed(3), 'quiet', bq.toFixed(3));
    expect(b).toBeGreaterThan(1.3);
    expect(Math.abs(bq - 1), 'quiet Kp draws no SAR arc').toBeLessThan(0.08);
});

test('gravity-wave packets ripple the green/OH band, and only inside a packet (control: ripples off)', async ({ page }) => {
    await setup(page);
    // The longest resolvable wave whose packet centre is on the night side
    // (sub-solar point on the 180° meridian at T0).
    const sun = latLonToScene(0, 180);
    const cand = GW.waves
        .map((w) => ({ w, c: w.centre[0] * sun[0] + w.centre[1] * sun[1] + w.centre[2] * sun[2] }))
        .flatMap(({ w, c }) => [{ w, u: w.centre, c }, { w, u: w.centre.map((v) => -v), c: -c }])
        .filter((o) => o.c < -0.3 && o.w.lambdaKm > 80)
        .sort((a, b) => b.w.lambdaKm - a.w.lambdaKm)[0];
    expect(cand, 'a night-side packet').toBeTruthy();
    const lat = Math.asin(cand.u[1]) * 180 / Math.PI;
    const lon = Math.atan2(-cand.u[2], cand.u[0]) * 180 / Math.PI;
    await page.evaluate(([la, lo]) => window.__agNadir(la, lo, 1500), [lat, lon]);
    const img = imageFromCapture(await capture(page, MESO_ONLY));
    const ctl = imageFromCapture(await capture(page, [...MESO_ONLY, ...NO_RIPPLES]));
    dumpPng('agl-ripples', { w: img.w, h: img.h, b64: Buffer.from(img.data).toString('base64') });
    // Ripple energy: the residual after a box blur wider than a wave period
    // (the packet's wave is ~λ / (altitude · pixel angle) px long), over the
    // central patch — a narrower blur keeps only sub-period detail and
    // measured ~nothing (the first version used 31 px on a 120 px wave).
    const pxKm = 1500 * await page.evaluate(() => window.__ua.globe._volume._material.uniforms.uPixAng.value);
    const periodPx = cand.w.lambdaKm / pxKm;
    const energy = (im) => {
        const W = im.w, H = im.h, g = new Float64Array(W * H);
        for (let i = 0; i < W * H; i++) g[i] = im.data[i * 4 + 1];
        const r = Math.min(Math.round(0.75 * periodPx), 100), cx = W >> 1, cy = H >> 1;
        const half = Math.min(120, cy - r - 2);
        let e = 0, n = 0;
        for (let y = cy - half; y <= cy + half; y += 4) for (let x = cx - half; x <= cx + half; x += 4) {
            let s = 0, m = 0;
            for (let yy = y - r; yy <= y + r; yy += 5) for (let xx = x - r; xx <= x + r; xx += 5) { s += g[yy * W + xx]; m++; }
            const d = g[y * W + x] - s / m;
            e += d * d; n++;
        }
        return Math.sqrt(e / n);
    };
    const e = energy(img), eC = energy(ctl);
    log('ripple packet', cand.w.lambdaKm.toFixed(0), 'km =', periodPx.toFixed(0), 'px at', lat.toFixed(1), lon.toFixed(1), 'energy', e.toFixed(3), 'control', eC.toFixed(3));
    expect(e).toBeGreaterThan(3 * Math.max(eC, 0.3));
    expect(eC, 'the control (no ripples) is smooth').toBeLessThan(1.5);
});
