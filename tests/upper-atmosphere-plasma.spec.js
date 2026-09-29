/**
 * upper-atmosphere-plasma.spec.js — how thick the plasma is, measured
 * ═══════════════════════════════════════════════════════════════════════════
 * The plasma view (volume mode 'plasma') integrates the electron density of
 * js/upper-atmosphere-plasma-field.js along every view ray — slant TEC — and
 * the red line carries the travelling ionospheric disturbances of
 * js/upper-atmosphere-tid.js. These gates read the renders back and compare
 * them with the NODE-TESTED kernels evaluated on the page's own drivers
 * (the fountain table, the teardrop plasmapause, the TID phases), at a
 * PINNED scene instant: the 2026 March equinox, 00 UT, so the sub-solar
 * point is on the 180° meridian.
 *
 *   TEC           the rendered slant TEC is the kernel's slantTec along the
 *                 same rays (colour ramp inverted pixel by pixel)
 *   crests        the equatorial crests brighten TEC where the fountain puts
 *                 them; the night-side trough sits on ring-current-efield's
 *                 teardrop plasmapause
 *   LSTIDs        storm-time waves in TEC match the kernel's δN/N, and the
 *                 pattern moves equatorward between two instants
 *   MSTIDs        night bands in the 630 nm line match the kernel
 *   penetration   a southward turning in the page's solar wind reaches the
 *                 E-field driver (ΔA > 0) and lifts the equatorial crests
 *   cost          what the plasma view costs over the column view
 *
 * Every gate carries a runtime NEGATIVE CONTROL: the same render with the
 * piece under test switched off by patching the shader text (the patch
 * throws if its target is gone), or with the physics driver itself off.
 *
 * UA_METRICS_LOG=1 prints the measurements; UA_METRICS_PNG=<dir> writes the
 * renders.
 */

import { test, expect } from '@playwright/test';
import { boot, log, dumpPng } from './helpers/ua-render.mjs';
import { PLASMA } from '../js/upper-atmosphere-plasma-field.js';
import { TID } from '../js/upper-atmosphere-tid.js';

test.describe.configure({ timeout: 300_000 });

const T0 = Date.UTC(2026, 2, 20, 0, 0);
const n9 = (x) => Number(x).toPrecision(9);

// Controls — each switches off exactly the piece under test.
const NO_HORIZONTAL = [['p.x *= plHorizontal(lonDeg, magLat, night)', 'p.x *= 1.0']];
const NO_ARCS_TEC = [['    float c = max(arcs.r, 0.0);\n    float dN = (magLat - arcs.g)', '    float c = 0.0;\n    float dN = (magLat - arcs.g)']];
const NO_TROUGH = [[`float trough = 1.0 - ${n9(PLASMA.troughDepth)} * night`, 'float trough = 1.0 - 0.0 * night']];
const NO_LSTID = [['if (uTidAmpL > 0.0 && distKm > 0.0) {', 'if (false) {']];
const NO_MSTID = [['if (band > 0.0 && night > 0.0) {', 'if (false) {']];
const NO_RED_TID = [[`max(0.0, 1.0 + ${n9(TID.redGain)} * tid)`, '1.0']];
const RED_ONLY = [['float mesoRate = gm.a * fM.x;', 'float mesoRate = 0.0;']];
// The mid-latitude red nightglow sits ~2 counts deep in the page's log
// stretch: lift it (the same display gain on both sides of a comparison)
// so an 8-bit readback can resolve a ±20 % wave.
// (On the RATE, so the brightness and the colour-weighted sum move together.)
const RED_LIFT = [['float redRate = fl.g * redF + fl.b * sarF;', 'float redRate = (fl.g * redF + fl.b * sarF) * 40.0;']];

async function setup(page, { mode = 'plasma' } = {}) {
    await boot(page, { sceneTimeMs: T0 });
    await page.evaluate(async (mode) => {
        const g = window.__ua.globe;
        const K = await import('/js/upper-atmosphere-plasma-field.js');
        const T = await import('/js/upper-atmosphere-tid.js');
        const C = await import('/js/upper-atmosphere-column.js');
        window.__pl = { K, T, C };
        g._volume.setQuality(24);
        g.stepFrames(2, 1 / 60, { render: 'none' });
        g.setVolumeMode(mode);
        /** Camera at (lat, lon, alt) looking at the Earth's centre, north up. */
        window.__plNadir = (latDeg, lonDeg, altKm) => {
            const d = Math.PI / 180, r = 1 + altKm / 6371;
            const u = [Math.cos(latDeg * d) * Math.cos(lonDeg * d), Math.sin(latDeg * d), -Math.cos(latDeg * d) * Math.sin(lonDeg * d)];
            const c = g._camera;
            c.up.set(0, 1, 0);
            c.position.set(u[0] * r, u[1] * r, u[2] * r);
            c.lookAt(0, 0, 0);
            c.updateMatrixWorld();
            g._volume.update(c, { govern: false, viewportHeight: g.canvas.clientHeight });
            g._updateAirglowField(true);
        };
        /** Move the scene instant (sun, fountain, E-field, TID phases). */
        window.__plTime = (ms) => {
            g.setSceneTime(ms);
            g.stepFrames(1, 1 / 60, { render: 'none' });
            g._updateAirglowField(true);
        };
        /** Solo volume render with shader patches applied (and restored). */
        window.__plCapture = (patches = []) => {
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
        /** The plasma view's colour → display t → TECU, by table inversion. */
        const P = K.PLASMA;
        const table = [];
        for (let i = 0; i <= 4000; i++) {
            const t = i / 4000;
            const sm = Math.min(1, t / 0.12), s3 = sm * sm * (3 - 2 * sm);
            const a = s3 * Math.min(0.92, Math.max(0, 0.35 + 1.5 * t));
            table.push([t, K.plasmaColour(t).map((c) => 255 * c * a)]);
        }
        window.__plInvert = (rgb) => {
            let best = null, err = Infinity;
            for (const [t, c] of table) {
                const e = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
                if (e < err) { err = e; best = t; }
            }
            return best;
        };
        window.__plTecOfT = (t) => 10 ** (P.tecLogMin + t * (P.tecLogMax - P.tecLogMin));
        /** A pixel's view ray (drawing-buffer coordinates, row 0 at the top). */
        window.__plRay = (x, y) => {
            const gl = g._renderer.getContext();
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const V = g._camera.position.constructor;
            const p = new V((x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h * 2, 0.5).unproject(g._camera);
            const o = g._camera.position;
            const d = p.clone().sub(o).normalize();
            return { ro: [o.x, o.y, o.z], rd: [d.x, d.y, d.z] };
        };
        /** Kernel slant TEC for a pixel, on the page's own drivers. */
        window.__plKernelTec = (x, y) => {
            const { ro, rd } = window.__plRay(x, y);
            return K.slantTec({ ro, rd, fieldAtUnit: (u) => g.plasmaFieldAt(u), steps: 3000 });
        };
        /** Where a scene point lands on the drawing buffer. */
        window.__plProject = (pts) => {
            const gl = g._renderer.getContext();
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const V = g._camera.position.constructor;
            return pts.map((p) => {
                const v = new V(p[0], p[1], p[2]).project(g._camera);
                return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
            });
        };
        window.__plShell = (latDeg, lonDeg, altKm) => C.latLonToScene(latDeg, lonDeg).map((v) => v * (1 + altKm / 6371));
    }, mode);
}

const capture = (page, patches) => page.evaluate((p) => window.__plCapture(p), patches);
const px = (cap, x, y) => {
    const b = Buffer.from(cap.b64, 'base64');
    const i = (Math.round(y) * cap.w + Math.round(x)) * 4;
    return [b[i], b[i + 1], b[i + 2]];
};
/** Mean RGB over a (2r+1)² patch — sub-quantisation precision on smooth fields. */
const patch = (cap, x, y, r = 1) => {
    const b = Buffer.from(cap.b64, 'base64');
    const s = [0, 0, 0];
    let n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const i = ((Math.round(y) + dy) * cap.w + Math.round(x) + dx) * 4;
        s[0] += b[i]; s[1] += b[i + 1]; s[2] += b[i + 2]; n++;
    }
    return s.map((v) => v / n);
};
const tOf = (page, rgbs) => page.evaluate((a) => a.map((c) => window.__plInvert(c)), rgbs);
const corr = (a, b) => {
    const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb || 1e-30);
};

// ─────────────────────────────────────────────────────────────────────────

test('the rendered slant TEC is the kernel\'s, ray by ray (control: horizontal structure off)', async ({ page }) => {
    await setup(page);
    // Evening over the Atlantic (20–22 h LT at 00 UT): crests, trough and
    // day/night gradient all in view, disc and limb rays both sampled.
    await page.evaluate(() => window.__plNadir(5, -45, 12000));
    const img = await capture(page, []);
    const ctl = await capture(page, NO_HORIZONTAL);
    dumpPng('pl-tec', img);
    const pts = [];
    for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) pts.push([img.w * (0.2 + 0.6 * i / 8), img.h * (0.12 + 0.76 * j / 8)]);
    const kern = await page.evaluate((p) => p.map(([x, y]) => window.__plKernelTec(x, y)), pts);
    const tImg = await tOf(page, pts.map(([x, y]) => patch(img, x, y)));
    const tCtl = await tOf(page, pts.map(([x, y]) => patch(ctl, x, y)));
    const tKer = await page.evaluate((k) => k.map((v) => window.__pl.K.tecDisplay(v)), kern);
    const dev = [], devC = [];
    for (let k = 0; k < pts.length; k++) {
        if (tKer[k] <= 0.02 || tKer[k] >= 0.98) continue;   // off the ramp: nothing to compare
        dev.push(Math.abs(tImg[k] - tKer[k]));
        devC.push(Math.abs(tCtl[k] - tKer[k]));
    }
    const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
    const max = (a) => Math.max(...a);
    log('TEC display |Δt| median', med(dev).toFixed(4), 'max', max(dev).toFixed(4), 'n', dev.length,
        '· control median', med(devC).toFixed(4), 'max', max(devC).toFixed(4),
        '· TECU range', Math.min(...kern).toFixed(1), '–', Math.max(...kern).toFixed(1));
    expect(dev.length).toBeGreaterThan(40);
    // Δt 0.02 on this scale is 10^(0.05) − 1 ≈ 12 % in TEC.
    expect(med(dev)).toBeLessThan(0.012);
    expect(max(dev)).toBeLessThan(0.04);
    expect(max(devC), 'the control (no crests / trough / bubbles / TIDs) must disagree somewhere').toBeGreaterThan(0.06);
});

test('the equatorial crests brighten TEC where the fountain puts them (control: crests off)', async ({ page }) => {
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
    expect(pick?.crest).toBeGreaterThan(0.25);
    const lon = pick.lon;
    const rows = await page.evaluate(([lon, cl]) => {
        const lf = (ml) => { let lo = -89, hi = 89; for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (window.__pl.C.magneticLatitude(m, lon) < ml) lo = m; else hi = m; } return 0.5 * (lo + hi); };
        const latEq = lf(0);
        window.__plNadir(latEq, lon, 9000);
        return window.__plProject([
            window.__plShell(lf(cl), lon, 300), window.__plShell(lf(-cl), lon, 300), window.__plShell(latEq, lon, 300),
        ]);
    }, [lon, pick.crestLatDeg]);
    const [pN, pS, pEq] = rows;
    const img = await capture(page, []), ctl = await capture(page, NO_ARCS_TEC);
    dumpPng('pl-crests', img);
    const scale = PLASMA.tecLogMax - PLASMA.tecLogMin;
    const tec = async (cap) => (await tOf(page, [pN, pS, pEq].map((p) => patch(cap, p.x, p.y, 2))))
        .map((t) => 10 ** (PLASMA.tecLogMin + t * scale));
    const [n, s, eq] = await tec(img);
    const [nc, sc, eqc] = await tec(ctl);
    const r = Math.min(n, s) / eq, rc = Math.min(nc, sc) / eqc;
    log('crest/equator TEC', r.toFixed(3), `(${n.toFixed(1)} ${s.toFixed(1)} / ${eq.toFixed(1)} TECU)`, 'control', rc.toFixed(3));
    expect(r).toBeGreaterThan(1.6);
    expect(rc, 'the control (no crests) has no crest-over-trough contrast').toBeLessThan(1.2);
});

test('a storm puts the night-side trough on the TEARDROP plasmapause (control: trough off)', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { const g = window.__ua.globe; g._airglowAp = 240; g._updateAirglowField(true); });   // Kp 8
    const lon = 0;                                                                       // local midnight at 00 UT
    const info = await page.evaluate((lon) => {
        const g = window.__ua.globe;
        const ppLat = g._iono.plasmapauseAt(lon);
        const lf = (ml) => { let lo = -89, hi = 89; for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (window.__pl.C.magneticLatitude(m, lon) < ml) lo = m; else hi = m; } return 0.5 * (lo + hi); };
        const latT = lf(ppLat + window.__pl.K.PLASMA.troughOffsetDeg);
        window.__plNadir(latT - 4, lon, 8000);
        const rows = [];
        for (let dl = -10; dl <= 10; dl += 0.5) rows.push({ dl, p: window.__plProject([window.__plShell(latT + dl, lon, 300)])[0] });
        return { ppLat, latT, rows, efield: g._iono.efield() };
    }, lon);
    // The storm's TIDs ride across this profile; take them out of BOTH
    // renders so the control measures the trough and nothing else.
    const iso = [...NO_LSTID, ...NO_MSTID];
    const img = await capture(page, iso), ctl = await capture(page, [...iso, ...NO_TROUGH]);
    dumpPng('pl-trough', img);
    const profile = async (cap) => tOf(page, info.rows.map(({ p }) => patch(cap, p.x, p.y, 1)));
    const t = await profile(img), tc = await profile(ctl);
    let iMin = 0; for (let i = 1; i < t.length; i++) if (t[i] < t[iMin]) iMin = i;
    const depth = (a) => { const m = Math.min(...a.slice(12, 29)); return 0.5 * (a[0] + a[a.length - 1]) - m; };
    log('plasmapause inv lat', info.ppLat.toFixed(2), 'A_sh', info.efield.A_sh.toFixed(3),
        'trough found at', info.rows[iMin].dl, '° from the kernel', 'depth', depth(t).toFixed(3), 'control', depth(tc).toFixed(3));
    expect(Math.abs(info.rows[iMin].dl), 'trough minimum where the kernel puts it').toBeLessThanOrEqual(1.5);
    expect(depth(t)).toBeGreaterThan(0.08);
    expect(depth(tc), 'the control (no trough) has no dip there').toBeLessThan(0.02);
});

test('storm-time LSTIDs in TEC match the kernel and travel equatorward (control: LSTIDs off)', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { const g = window.__ua.globe; g._airglowAp = 240; g._updateAirglowField(true); });
    const lon = 30;   // ~02 h local time: dark, well clear of the terminator
    // Isolate the large-scale family: the MSTID bands are switched off in
    // BOTH renders (they are gated on their own below).
    const measure = async (ms) => {
        const rows = await page.evaluate(([ms, lon]) => {
            window.__plTime(ms);
            window.__plNadir(40, lon, 9000);
            const out = [];
            for (let lat = 22; lat <= 52; lat += 0.5) {
                const p = window.__plProject([window.__plShell(lat, lon, 300)])[0];
                const f = window.__ua.globe.plasmaFieldAt(window.__plShell(lat, lon, 300));
                out.push({ lat, p, lstid: f.factors.lstid });
            }
            return out;
        }, [ms, lon]);
        const img = await capture(page, NO_MSTID), ctl = await capture(page, [...NO_MSTID, ...NO_LSTID]);
        const t = await tOf(page, rows.map(({ p }) => patch(img, p.x, p.y, 1)));
        const tc = await tOf(page, rows.map(({ p }) => patch(ctl, p.x, p.y, 1)));
        const scale = PLASMA.tecLogMax - PLASMA.tecLogMin;
        // Rendered δ: the TEC ratio to the no-LSTID render, in log space.
        const dRender = t.map((v, i) => 10 ** ((v - tc[i]) * scale) - 1);
        return { rows, dRender, dKernel: rows.map((r) => r.lstid), img };
    };
    const a = await measure(T0 + 2 * 3600e3), b = await measure(T0 + 2 * 3600e3 + 15 * 60e3);
    dumpPng('pl-lstid', a.img);
    const ca = corr(a.dRender, a.dKernel), cb = corr(b.dRender, b.dKernel);
    // The negative control: the later render against the EARLIER kernel. If
    // the render did not move with the kernel, this would match as well.
    const cStale = corr(b.dRender, a.dKernel);
    // The kernel's strongest crest in the band, and where it went.
    const crest = (m) => { let best = -1, at = 0; for (let i = 8; i < m.dKernel.length - 8; i++) if (m.dKernel[i] > best) { best = m.dKernel[i]; at = m.rows[i].lat; } return at; };
    const amp = Math.max(...a.dRender.map(Math.abs));
    log('LSTID render↔kernel r', ca.toFixed(3), cb.toFixed(3), '· later render vs earlier kernel', cStale.toFixed(3),
        '· amp', amp.toFixed(3), '· crest lat', crest(a).toFixed(1), '→', crest(b).toFixed(1));
    expect(ca).toBeGreaterThan(0.85);
    expect(cb).toBeGreaterThan(0.85);
    expect(amp).toBeGreaterThan(0.04);
    expect(cStale, 'the pattern moved: the stale kernel no longer matches').toBeLessThan(ca - 0.5);
});

test('night MSTID bands in the 630 nm line match the kernel (control: red-line TIDs off)', async ({ page }) => {
    await setup(page, { mode: 'column' });
    await page.evaluate(() => {
        const g = window.__ua.globe;
        g._volume.setDensityVisible(false);
        g._airglowAp = 7; g._updateAirglowField(true);   // quiet: MSTIDs only
    });
    const lat0 = 33, lon0 = -15;
    const pts = await page.evaluate(([la, lo]) => {
        window.__plNadir(la, lo, 2500);
        const out = [];
        const lf = window.__pl;
        for (let k = -40; k <= 40; k++) {
            // A line across the fronts (they run NW–SE), 0.08° per step.
            const lat = la - 0.06 * k, lon = lo - 0.06 * k / Math.cos(la * Math.PI / 180);
            const p = window.__plProject([window.__plShell(lat, lon, 250)])[0];
            const f = window.__ua.globe.airglowFieldAt(window.__plShell(lat, lon, 250));
            // The same point half an MSTID period later: the phase-flipped control.
            const T = window.__pl.T;
            const later = T.tidField({ magLatDeg: f.magLatDeg, latDeg: lat, lonDeg: lon,
                mltHr: (((lon / 15) % 24) + 24) % 24, night: 1, kp: 2,
                phases: T.tidPhases(window.__ua.globe.getSceneTimeMs() / 1000 + 0.5 * T.TID.mstid.lambdaKm / (T.TID.mstid.speedMs / 1000)) });
            out.push({ p, tid: f.tid, later: later.mstid });
        }
        void lf;
        return out;
    }, [lat0, lon0]);
    const img = await capture(page, [...RED_ONLY, ...RED_LIFT]);
    const ctl = await capture(page, [...RED_ONLY, ...RED_LIFT, ...NO_RED_TID]);
    dumpPng('pl-mstid-red', img);
    const red = (cap) => pts.map(({ p }) => patch(cap, p.x, p.y, 1)[0]);
    const ri = red(img), rc = red(ctl);
    const ratio = ri.map((v, i) => v / Math.max(rc[i], 1e-6) - 1);
    const kern = pts.map((q) => q.tid);
    const r = corr(ratio, kern);
    const rLater = corr(ratio, pts.map((q) => q.later));
    const amp = Math.max(...ratio.map(Math.abs));
    log('MSTID red-line render↔kernel r', r.toFixed(3), '· vs half a period later', rLater.toFixed(3),
        '· amp', amp.toFixed(3), '· mean red', (rc.reduce((s, v) => s + v, 0) / rc.length).toFixed(1));
    expect(Math.max(...kern.map(Math.abs)), 'the kernel puts MSTIDs here').toBeGreaterThan(0.05);
    expect(rc.reduce((s, v) => s + v, 0) / rc.length, 'enough counts to resolve the wave').toBeGreaterThan(25);
    expect(r).toBeGreaterThan(0.85);
    expect(amp).toBeGreaterThan(0.05);
    expect(rLater, 'control: the phase-flipped kernel anti-correlates').toBeLessThan(-0.5);
});

test('a southward turning in the page\'s solar wind penetrates: ΔA > 0 and the crests lift (control: northward IMF)', async ({ page }) => {
    await setup(page);
    const run = async (bz) => page.evaluate(([bz, T0]) => {
        const g = window.__ua.globe;
        g.setSolarWind({ speed: 450, density: 5, bz: 1 });
        window.__plTime(T0 + 18 * 3600e3);
        g.setSolarWind({ speed: 650, density: 12, bz });
        let maxDA = -Infinity;
        for (let m = 5; m <= 90; m += 5) {
            window.__plTime(T0 + 18 * 3600e3 + m * 60e3);
            maxDA = Math.max(maxDA, g.ionosphereState().efield.dA);
        }
        let crest = 0;
        for (let lon = -10; lon <= 45; lon += 1) crest = Math.max(crest, g._arcs.sampleAt(lon).crest);
        return { maxDA, crest };
    }, [bz, T0]);
    const south = await run(-15), north = await run(3);
    log('penetration ΔA', south.maxDA.toFixed(3), 'crest', south.crest.toFixed(3), '· control ΔA', north.maxDA.toFixed(3), 'crest', north.crest.toFixed(3));
    expect(south.maxDA).toBeGreaterThan(0.3);
    expect(north.maxDA, 'northward IMF: nothing to penetrate').toBeLessThan(0.05);
    expect(south.crest).toBeGreaterThan(north.crest * 1.05);
});

test('the plasma view\'s cost over the column view (logged; bounded)', async ({ page }) => {
    await setup(page, { mode: 'column' });
    const ms = await page.evaluate(() => {
        const g = window.__ua.globe;
        window.__plNadir(10, -40, 20000);
        g._volume.setQuality(10);
        const time = (mode) => {
            g.setVolumeMode(mode);
            window.__uaSolo([g._volume._mesh]);    // compile / warm
            const t0 = performance.now();
            for (let i = 0; i < 4; i++) window.__uaSolo([g._volume._mesh]);
            return (performance.now() - t0) / 4;
        };
        return { column: time('column'), plasma: time('plasma'), column2: time('column') };
    });
    log('ms/frame at the floor rung — column', ms.column.toFixed(1), 'plasma', ms.plasma.toFixed(1), 'column again', ms.column2.toFixed(1));
    expect(ms.plasma).toBeLessThan(1.6 * Math.max(ms.column, ms.column2));
});
