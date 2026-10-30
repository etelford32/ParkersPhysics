import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { regionById, regionView } from '../js/earth-regions.js';
import { horizonDeviation } from './helpers/image-metrics.mjs';
import {
    boot, frames, setSun, cameraFrame, flyAndSettle, canvasShot, lum,
    transitions, seamColumn, cropPng, NORTH_OF,
} from './helpers/earthview-harness.mjs';

/**
 * earthview-validation.spec.js — EarthView's surface + LOD claims, as EVIDENCE.
 *
 * Every check renders the SAME view twice — the shipped path and a NEGATIVE
 * CONTROL that puts the old behaviour back — saves both frames, measures a
 * number from the pixels, and gates on it. A threshold with no control that
 * fails it is a guess; every gate below names its control.
 *
 *   lighting    Lambert falloff measured per pixel against μ₀ (the hit's
 *               world normal · the held Sun), a dark night side, emitted lamps,
 *               the map unchanged at noon.            control ?earthlight=legacy
 *   glint       the ocean specular under the Sun (Cox–Munk × Fresnel).
 *               Recorded, NOT gated: the sea state is the live wind.
 *   limb        a low camera looking at the horizon; the drawn limb against
 *               the TRUE sphere's, column by column.  control: the globe at
 *               its pre-2026-10-30 level 6 (980 faces)
 *   seam        no coarsest-mip column down the 180° meridian.
 *                                                       control ?uvseam=legacy
 *   window      the regional cloud window resolves 0.15° stripes the global
 *               frame cannot, right way up, across the dateline.
 *                                                       control ?cloud_detail=0
 *   regions     "Go to a region" lands in regional detail, the readout says
 *               so, the pick is the true point.        control: the mesh UVs
 *               (the old pick) name the antipode
 *   deeplink    ?region= flies there on load.
 *
 * Output: EV_VALIDATION_DIR (default validation-output/earthview) gets
 * every frame as PNG plus manifest.json; `node scripts/build-earthview-validation-report.mjs`
 * turns them into a page. Frames come from SwiftShader (software GL) with the
 * hermetic stubs in tests/helpers/earthview-harness.mjs — they show what the
 * shaders compute, not how a GPU's filtering will look.
 *
 * Run: npx playwright test tests/earthview-validation.spec.js --workers=1
 */

// NOT serial: one failing check must not stop the others from leaving
// their evidence (each writes its own JSON before it asserts).
test.describe.configure({ timeout: 900_000 });

// NOT under test-results/: Playwright empties that directory at the start of
// every run, which would erase one run's evidence when the next starts.
const OUT = process.env.EV_VALIDATION_DIR || 'validation-output/earthview';
const VIEW = { width: 1280, height: 720 };
mkdirSync(OUT, { recursive: true });

const save = (name, buf) => { writeFileSync(`${OUT}/${name}`, buf); return name; };
const asMetricImg = (img) => ({ w: img.width, h: img.height, data: img.data });
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

function newCheck(id, title, claim, control) {
    return { id, title, claim, control, frames: [], metrics: {}, gates: [], notes: [] };
}
/** Record a gate; `control: true` marks the one the NEGATIVE CONTROL must fail. */
function gate(check, name, value, op, limit, { control = false } = {}) {
    const pass = op === '<' ? value < limit : op === '>' ? value > limit : value === limit;
    check.gates.push({ name, value: r3(value), op, limit, pass, control });
}
/** Write the check BEFORE asserting, so a failing run still leaves its evidence. */
function finish(check) {
    check.pass = check.gates.every((g) => g.pass);
    writeFileSync(`${OUT}/${check.id}.json`, JSON.stringify(check, null, 1));
    for (const g of check.gates) expect(g.pass, `${check.id}: ${g.name} = ${g.value} (want ${g.op} ${g.limit})`).toBe(true);
}

async function newPage(browser) {
    const page = await browser.newPage({ viewport: VIEW });
    return page;
}

test.afterAll(() => {
    const checks = readdirSync(OUT).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
        .map((f) => JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')));
    const order = ['lighting', 'relief', 'glint', 'limb', 'seam', 'window', 'regions', 'deeplink'];
    checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    let commit = null;
    try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }
    writeFileSync(`${OUT}/manifest.json`, JSON.stringify({
        generatedAt: new Date().toISOString(), commit, viewport: VIEW,
        renderer: 'Chromium + SwiftShader (software GL), hermetic stubs',
        checks,
    }, null, 1));
});

// ── 1. LIGHTING ─────────────────────────────────────────────────────────────
test('lighting: Lambert falloff, a dark night, emitted lamps, the map at noon', async ({ browser }) => {
    const check = newCheck('lighting', 'Physically lit surface',
        'Brightness follows the Sun\'s elevation (Lambert under a reddened beam), the night side is dark but for city lights, and the sub-solar map is not re-exposed.',
        '?earthlight=legacy — the old half-Lambert shader');
    const BINS = [[0.0, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 0.95]];
    const run = async (mode, query) => {
        const page = await newPage(browser);
        const errors = await boot(page, query, { clouds: false, lights: true });
        // ONE fixed place, the camera posed exactly on it, the Sun held
        // relative to it: nothing here depends on the hour the gate runs.
        await flyAndSettle(page, 35, 15, 3.0);
        const f = await cameraFrame(page);
        await page.evaluate((pose) => window.__evTestPose(pose), { pos: f.p.map((v) => v * 3), look: [0, 0, 0], fov: 40 });
        await frames(page, 3);
        const tilt = (axis, deg) => {
            const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
            return f.p.map((v, i) => v * c + axis[i] * s);
        };
        const views = {
            day: tilt(f.north, 20),                        // overhead light, glint off the box
            night: tilt(f.north, 20).map((v) => -v),       // straight behind the globe
            terminator: tilt(f.east, 60),                  // sub-solar point east, terminator west of centre
        };
        const out = { errors };
        for (const [view, sun] of Object.entries(views)) {
            await setSun(page, sun);
            const stats = await page.evaluate(() => {
                const cv = document.querySelector('#c');
                const side = Math.floor(Math.min(cv.width, cv.height) * 0.5);
                const box = { x: (cv.width - side) >> 1, y: (cv.height - side) >> 1, w: side, h: side };
                window.__evFrameStats(box);
                const all = window.__evFrameStats({ ...box, lit: 0 });
                const seen = window.__evFrameStats({ ...box, lit: 8 });
                const core = window.__evFrameStats({ ...box, lit: 150 });
                return { meanMax: all.meanMax, fracSeen: seen.lit / seen.n, lampCores: core.lit };
            });
            const { png, img } = await canvasShot(page);
            check.frames.push({ file: save(`lighting-${mode}-${view}.png`, png), mode, view });
            out[view] = stats;
            if (view === 'terminator') {
                // μ₀ per pixel from the page's own analytic pick (world normal)
                // · the held Sun; luminance from the same frame.
                const NX = 96, NY = 54;
                const samples = await page.evaluate(({ NX, NY }) => {
                    const q = [];
                    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) q.push([-1 + (2 * i + 1) / NX, 1 - (2 * j + 1) / NY]);
                    return window.__evPickMany(q).map((h, k) => (h ? [q[k][0], q[k][1], h.slice(2)] : null)).filter(Boolean);
                }, { NX, NY });
                const sums = BINS.map(() => [0, 0]);
                const curve = [];
                for (const [x, y, n] of samples) {
                    const mu0 = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
                    const px = Math.min(img.width - 1, Math.floor((x + 1) / 2 * img.width));
                    const py = Math.min(img.height - 1, Math.floor((1 - y) / 2 * img.height));
                    const L = lum(img, px, py);
                    curve.push([r3(mu0), Math.round(L)]);
                    const b = BINS.findIndex(([a, z]) => mu0 >= a && mu0 < z);
                    if (b >= 0) { sums[b][0] += L; sums[b][1]++; }
                }
                out.bins = BINS.map(([a, z], k) => ({ mu0: r3((a + z) / 2), L: sums[k][1] ? r3(sums[k][0] / sums[k][1]) : null, n: sums[k][1] }));
                const top = out.bins[out.bins.length - 1].L;
                out.falloff = out.bins[1].L / top;              // μ₀ ≈ 0.15 against μ₀ ≈ 0.875
                out.curve = curve;
            }
        }
        await page.close();
        return out;
    };
    const phys = await run('physical', '');
    const leg = await run('legacy', '?earthlight=legacy');
    check.metrics = {
        physical: { day: phys.day, night: phys.night, bins: phys.bins, falloff: r3(phys.falloff) },
        legacy:   { day: leg.day, night: leg.night, bins: leg.bins, falloff: r3(leg.falloff) },
        curve: { physical: phys.curve, legacy: leg.curve },
        noonRatio: r3(phys.day.meanMax / leg.day.meanMax),
    };
    for (const r of [phys, leg]) gate(check, 'no shader / page errors', r.errors.length, '=', 0);
    // Falloff: Lambert says L(μ₀ 0.15)/L(μ₀ 0.875) is ~0.17 in linear light
    // (lower still with the reddened slant beam); half-Lambert says ~0.6.
    // Limits sit between the first measured run (2026-10-30, SwiftShader:
    // physical 0.209, legacy 0.556) with margin on both sides.
    const rising = (bins) => bins.every((b, k) => k === 0 || (b.L != null && bins[k - 1].L != null && b.L > bins[k - 1].L)) ? 1 : 0;
    check.metrics.physical.rising = rising(phys.bins);
    check.metrics.legacy.rising = rising(leg.bins);
    gate(check, 'falloff L(μ₀≈0.15)/L(μ₀≈0.88), physical', phys.falloff, '<', 0.35);
    gate(check, 'falloff, legacy (control)', leg.falloff, '>', 0.45, { control: true });
    gate(check, 'brightness rises with μ₀ in every bin, physical', check.metrics.physical.rising, '=', 1);
    gate(check, 'brightness rises in every bin, legacy (control: brighter at the terminator)', check.metrics.legacy.rising, '=', 0, { control: true });
    gate(check, 'night: share of the disc where ground shows, physical', phys.night.fracSeen, '<', 0.12);
    gate(check, 'night: share, legacy (control)', leg.night.fracSeen, '>', 0.25, { control: true });
    gate(check, 'lamp-core pixels, physical', phys.night.lampCores, '>', 200);
    gate(check, 'lamp cores physical ÷ legacy (control dims them)', phys.night.lampCores / Math.max(1, leg.night.lampCores), '>', 2, { control: true });
    gate(check, 'noon brightness physical ÷ legacy (> 0.85)', check.metrics.noonRatio, '>', 0.85);
    gate(check, 'noon brightness physical ÷ legacy (< 1.15)', check.metrics.noonRatio, '<', 1.15);
    finish(check);
});

// ── 1b. RELIEF ──────────────────────────────────────────────────────────────
test('relief: terrain shading without texel hatching at a low Sun', async ({ browser }) => {
    const check = newCheck('relief', 'Clean terrain relief at a low Sun',
        'The relief slope is a Sobel gradient of the height map: a low Sun shades real terrain without drawing every 8-bit height step and compression-block edge as a ridge.',
        '?relief=forward — the one-texel forward difference the shader used before');
    // The Sahara under a low Sun (the lighting check's terminator view):
    // texel-scale ROUGHNESS (1-px second differences) must fall, and
    // terrain at a 4-px scale must survive — a blur would pass the first
    // and fail the second.
    const runs = {};
    for (const [mode, query] of [['shipped', ''], ['forward', '?relief=forward']]) {
        const page = await newPage(browser);
        const errors = await boot(page, query, { clouds: false });
        await flyAndSettle(page, 35, 15, 3.0);
        const f = await cameraFrame(page);
        await page.evaluate((pose) => window.__evTestPose(pose), { pos: f.p.map((v) => v * 3), look: [0, 0, 0], fov: 40 });
        const c = Math.cos(60 * Math.PI / 180), s = Math.sin(60 * Math.PI / 180);
        const sun = f.p.map((v, i) => v * c + f.east[i] * s);
        await setSun(page, sun);
        const { png, img } = await canvasShot(page);
        // Pixels over the Sahara (15–31° N, 12° W–30° E) lit at μ₀ 0.1–0.6.
        const pts = await page.evaluate(({ W, H, sun }) => {
            const px = [], q = [];
            for (let y = 2; y < H - 2; y += 3) for (let x = 2; x < W - 2; x += 3) { px.push([x, y]); q.push([(x + 0.5) / W * 2 - 1, 1 - (y + 0.5) / H * 2]); }
            return window.__evPickMany(q).map((h, k) => {
                if (!h) return null;
                const [lat, lon, nx, ny, nz] = h;
                const mu0 = nx * sun[0] + ny * sun[1] + nz * sun[2];
                return (lat > 15 && lat < 31 && lon > -12 && lon < 30 && mu0 > 0.1 && mu0 < 0.6) ? px[k] : null;
            }).filter(Boolean);
        }, { W: img.width, H: img.height, sun });
        let rough = 0, coarse = 0, mean = 0, cx = 0, cy = 0;
        for (const [x, y] of pts) {
            const L = lum(img, x, y);
            rough += (Math.abs(lum(img, x - 1, y) - 2 * L + lum(img, x + 1, y)) + Math.abs(lum(img, x, y - 1) - 2 * L + lum(img, x, y + 1))) / 2;
            const xs = Math.min(img.width - 1, x + 4), ys = Math.min(img.height - 1, y + 4);
            coarse += (Math.abs(lum(img, xs, y) - L) + Math.abs(lum(img, x, ys) - L)) / 2;
            mean += L; cx += x; cy += y;
        }
        const n = Math.max(1, pts.length);
        runs[mode] = { n: pts.length, roughness: rough / n, relief4px: coarse / n, meanL: mean / n, cx: cx / n, cy: cy / n, img, png, errors };
        check.frames.push({ file: save(`relief-${mode}.png`, png), mode });
        await page.close();
    }
    const at = runs.shipped;   // the SAME crop window for both
    for (const mode of ['shipped', 'forward']) {
        check.frames.push({ file: save(`relief-${mode}-crop.png`, cropPng(runs[mode].img, at.cx - 150, at.cy - 70, 300, 140, 3)), mode, crop: true });
        const r = runs[mode];
        check.metrics[mode] = { pixels: r.n, roughness: r3(r.roughness), relief4px: r3(r.relief4px), meanL: r3(r.meanL) };
        gate(check, `no shader / page errors (${mode})`, r.errors.length, '=', 0);
    }
    gate(check, 'Sahara pixels measured', runs.shipped.n, '>', 2000);
    // Measured 2026-10-30 (SwiftShader): roughness 0.30, 4-px relief 0.68 of the control's.
    gate(check, 'texel-scale roughness, Sobel ÷ forward (control draws the hatching)', runs.shipped.roughness / runs.forward.roughness, '<', 0.5, { control: true });
    gate(check, 'terrain relief at 4 px, Sobel ÷ forward (not blurred away)', runs.shipped.relief4px / runs.forward.relief4px, '>', 0.6);
    finish(check);
});

// ── 2. GLINT (recorded, not gated) ──────────────────────────────────────────
test('glint: the sun on the open ocean', async ({ browser }) => {
    const check = newCheck('glint', 'Ocean sun glint',
        'Cox–Munk slope statistics × Schlick Fresnel: a bright, wind-roughened specular patch where the half-vector meets the sea, absent on land.',
        '?earthlight=legacy');
    check.notes.push('Recorded, not gated: the patch size follows the LIVE 10 m wind, which the hermetic page does not hold fixed.');
    for (const [mode, query] of [['physical', ''], ['legacy', '?earthlight=legacy']]) {
        const page = await newPage(browser);
        const errors = await boot(page, query, { clouds: false });
        await flyAndSettle(page, 0, -150, 3.0);
        const f = await cameraFrame(page);
        await page.evaluate((pose) => window.__evTestPose(pose), { pos: f.p.map((v) => v * 3), look: [0, 0, 0], fov: 40 });
        // The Sun 25° off the camera: the specular point sits half-way, ~12° up the disc.
        const c = Math.cos(25 * Math.PI / 180), s = Math.sin(25 * Math.PI / 180);
        await setSun(page, f.p.map((v, i) => v * c + f.north[i] * s));
        const { png, img } = await canvasShot(page);
        check.frames.push({ file: save(`glint-${mode}.png`, png), mode });
        // Peak over median in the central disc.
        const vals = [];
        for (let y = img.height * 0.15; y < img.height * 0.85; y += 2) for (let x = img.width * 0.35; x < img.width * 0.65; x += 2) vals.push(lum(img, Math.floor(x), Math.floor(y)));
        vals.sort((a, b) => a - b);
        check.metrics[mode] = { peak: r3(vals[vals.length - 1]), median: r3(vals[vals.length >> 1]), p99: r3(vals[Math.floor(vals.length * 0.99)]) };
        gate(check, `no shader / page errors (${mode})`, errors.length, '=', 0);
        await page.close();
    }
    finish(check);
});

// ── 3. LIMB ─────────────────────────────────────────────────────────────────
test('limb: a low camera sees a round horizon', async ({ browser }) => {
    const check = newCheck('limb', 'Round horizon at low altitude',
        'From 320 km up, looking at the horizon, the drawn limb lies on the true sphere\'s limb to within a pixel; the globe swaps in its 46 080-face mesh on its own.',
        'the globe forced to level 6 (980 faces) — the mesh EarthView drew before this pass');
    const page = await newPage(browser);
    const errors = await boot(page, '', { clouds: false });
    await flyAndSettle(page, 20, 10, 1.3);
    const f = await cameraFrame(page);
    const d = 1.05;
    const dip = Math.acos(1 / d);                                   // the horizon's depression
    const P = f.p.map((v) => v * d);
    const look = P.map((v, i) => v + f.east[i] * Math.cos(dip) - f.p[i] * Math.sin(dip));
    const tangent = f.p.map((v, i) => v * Math.cos(dip) + f.east[i] * Math.sin(dip));
    const pred = await page.evaluate((pose) => window.__evTestPose(pose), { pos: P, look, fov: 40 });
    await setSun(page, tangent);                                    // noon at the horizon point: a bright limb
    const rows = pred.rows;
    check.metrics.camera = { altitudeKm: Math.round((d - 1) * 6371), dipDeg: r3(dip * 180 / Math.PI) };
    const levels = [['auto', null], ['47', 47], ['15', 15], ['6', 6]];
    for (const [label, det] of levels) {
        await page.evaluate((v) => window.__evSetGlobeDetail(v), det);
        await frames(page, 3);
        const detail = await page.evaluate(() => window.__evLod().globeDetail);
        const { png, img } = await canvasShot(page);
        const dev = horizonDeviation(asMetricImg(img), rows, { threshold: 30, band: 40, margin: 4 });
        const cx = img.width >> 1, cy = Number.isFinite(rows[cx]) ? rows[cx] : img.height / 2;   // JSON turns NaN into null
        check.frames.push({ file: save(`limb-${label}.png`, png), level: label, detail });
        check.frames.push({ file: save(`limb-${label}-crop.png`, cropPng(img, cx - 120, cy - 30, 240, 60, 4)), level: label, crop: true, detail });
        check.metrics[label] = { detail, maxDevPx: r3(dev.maxDev), meanDevPx: r3(dev.meanDev), columns: dev.columns, missing: dev.missing };
    }
    await page.evaluate(() => { window.__evSetGlobeDetail(null); window.__evTestPose(null); });
    await page.close();
    gate(check, 'no shader / page errors', errors.length, '=', 0);
    gate(check, 'LOD picks the 47 mesh on its own', check.metrics.auto.detail, '=', 47);
    gate(check, 'limb columns measured', check.metrics.auto.columns, '>', 1000);
    gate(check, 'max limb deviation, shipped (px)', check.metrics.auto.maxDevPx, '<', 1.5);
    gate(check, 'max limb deviation, level 6 (control, px)', check.metrics['6'].maxDevPx, '>', 5, { control: true });
    finish(check);
});

// ── 4. SEAM ─────────────────────────────────────────────────────────────────
test('seam: no coarsest-mip column down the 180° meridian', async ({ browser }) => {
    const check = newCheck('seam', 'No antimeridian line',
        'The map is sampled with seam-safe UVs, so no column of the coarsest mip level is drawn down the 180° meridian.',
        '?uvseam=legacy — the old single-branch UV');
    for (const [mode, query] of [['fixed', ''], ['legacy', '?uvseam=legacy']]) {
        const page = await newPage(browser);
        const errors = await boot(page, query, { clouds: false });
        // THREE camera longitudes ~½ px apart, worst kept: the column only
        // appears where the u jump falls INSIDE a 2×2 derivative quad.
        let worst = null;
        for (const dLon of [0, 0.04, 0.08]) {
            await flyAndSettle(page, 0, 180 - dLon, 1 + 9000 / 6371);
            const fr = await cameraFrame(page);
            const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
            await setSun(page, fr.p.map((v, i) => v * c + fr.north[i] * s));
            const { png, img } = await canvasShot(page);
            const m = seamColumn(img);
            if (!worst || m.seam > worst.m.seam) worst = { m, png, img, dLon };
        }
        check.frames.push({ file: save(`seam-${mode}.png`, worst.png), mode });
        check.frames.push({ file: save(`seam-${mode}-crop.png`, cropPng(worst.img, worst.m.x - 40, 0, 80, 60, 6)), mode, crop: true });
        check.metrics[mode] = { seam: r3(worst.m.seam), x: worst.m.x, dLon: worst.dLon };
        gate(check, `no shader / page errors (${mode})`, errors.length, '=', 0);
        await page.close();
    }
    gate(check, 'seam excess, legacy (control)', check.metrics.legacy.seam, '>', 8, { control: true });
    gate(check, 'seam excess, fixed ÷ legacy', check.metrics.fixed.seam / check.metrics.legacy.seam, '<', 1 / 3);
    finish(check);
});

// ── 5. REGIONAL CLOUD WINDOW ────────────────────────────────────────────────
test('window: the regional cloud window resolves what the global frame cannot', async ({ browser }) => {
    const check = newCheck('window', 'Regional cloud detail',
        'Zoomed in, clouds are re-fetched for the view at the instruments\' 2 km: stripes 0.15° apart resolve north of 40° N, the uniform field south stays uniform, and the window stitches across the dateline.',
        '?cloud_detail=0 — the 20 km global frame alone');
    check.notes.push('The cloud imagery here is a STUB (stripes north of 40° N, grey south) — a resolution and orientation target, not real weather. Production GIBS is egress-blocked in the sandbox.');
    for (const [mode, query] of [['window', ''], ['global', '?cloud_detail=0']]) {
        const page = await newPage(browser);
        const gibs = [];
        const errors = await boot(page, query, { clouds: true, gibs });
        await flyAndSettle(page, NORTH_OF, 180, 1 + 2800 / 6371);
        const fr = await cameraFrame(page);
        const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
        await setSun(page, fr.p.map((v, i) => v * c + fr.north[i] * s));
        if (mode === 'window') await page.waitForFunction(() => window.__evCloudDetail().status === 'live', null, { timeout: 120_000 });
        await page.waitForTimeout(3_000);
        const detail = await page.evaluate(() => window.__evCloudDetail());
        const { png, img } = await canvasShot(page);
        check.frames.push({ file: save(`window-${mode}.png`, png), mode });
        check.frames.push({ file: save(`window-${mode}-crop.png`, cropPng(img, img.width / 2 - 100, img.height * 0.4 - 60, 200, 120, 3)), mode, crop: true });
        const regional = gibs.filter((g) => !(g.bbox[1] === -180 && g.bbox[3] === 180));
        check.metrics[mode] = {
            north: transitions(img, 0.12, 0.40), south: transitions(img, 0.60, 0.88),
            status: detail.status, kmPerPx: r3(detail.kmPerPx), used: detail.used,
            regionalBoxes: regional.map((g) => g.bbox),
            timesMatchGlobal: regional.every((g) => gibs.some((x) => x.layer === g.layer && x.bbox[1] === -180 && x.bbox[3] === 180 && x.time === g.time)),
        };
        gate(check, `no shader / page errors (${mode})`, errors.length, '=', 0);
        await page.close();
    }
    const w = check.metrics.window, g = check.metrics.global;
    gate(check, 'window live', w.status === 'live' ? 1 : 0, '=', 1);
    gate(check, 'window km per pixel', w.kmPerPx, '<', 6);
    gate(check, 'fetched as two boxes meeting at ±180°', (w.regionalBoxes.some((b) => b[3] === 180) && w.regionalBoxes.some((b) => b[1] === -180)) ? 1 : 0, '=', 1);
    gate(check, 'fetched at the global frame\'s own times', w.timesMatchGlobal ? 1 : 0, '=', 1);
    gate(check, 'stripes resolved north: window ÷ global (control)', w.north / Math.max(1, g.north), '>', 2.5, { control: true });
    gate(check, 'right way up: north ÷ south', w.north / Math.max(1, w.south), '>', 3);
    finish(check);
});

// ── 6. REGIONS + READOUT + PICK ─────────────────────────────────────────────
async function dismissConsent(page) {
    const btn = page.getByRole('button', { name: /Reject non-essential/i });
    if (await btn.count()) await btn.first().click().catch(() => {});
}

test('regions: the picker lands in regional detail and the pick is the true point', async ({ browser }) => {
    const check = newCheck('regions', 'Go to a region',
        'Picking a region frames it on screen, the camera lands in regional detail, the readout names the place, altitude and km per pixel, and the point under the cursor is the real one.',
        'the mesh UVs every pick read before this pass — they name the antipode');
    const page = await newPage(browser);
    const errors = await boot(page, '', { clouds: false });
    await dismissConsent(page);
    const r = regionById('us-great-plains-and-midwest');
    const far = await page.evaluate(() => window.__evLod().globeDetail);
    await page.selectOption('#ev-region', r.id);
    await page.waitForFunction(() => !window.__evCamera().flying, null, { timeout: 120_000 });
    await page.waitForFunction(() => window.__evLod().tier === 'regional', null, { timeout: 60_000 });
    const st = await page.evaluate(() => ({
        cam: window.__evCamera(), lod: window.__evLod(), pick: window.__evPick(0, 0),
        aspect: (() => { const c = document.getElementById('c'); return c.clientWidth / c.clientHeight; })(),
    }));
    const fr = await cameraFrame(page);
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    await setSun(page, fr.p.map((v, i) => v * c + fr.north[i] * s));
    await page.waitForTimeout(1_000);
    check.frames.push({ file: save('regions-great-plains.png', await page.screenshot()), view: 'page' });
    const tools = page.locator('#layer-panel .layer-tools');
    if (await tools.count()) check.frames.push({ file: save('regions-readout.png', await tools.screenshot()), view: 'readout', crop: true });
    const want = regionView(r, { fovDeg: 40, aspect: st.aspect, minDist: 1.014, maxDist: 10 });
    const dLonAnti = Math.abs(((st.pick.meshUv.lon - (r.lon + 180)) % 360 + 540) % 360 - 180);
    check.metrics = {
        region: r.name, readout: st.lod.text, distance: r3(st.cam.dist), framedDistance: r3(want.dist),
        globeDetail: { far, near: st.lod.globeDetail }, footprintSpanDeg: r3(st.lod.footprint.spanLatDeg),
        pick: { analytic: st.pick.analytic, meshUv: st.pick.meshUv, regionCentre: { lat: r3(r.lat), lon: r3(r.lon) } },
    };
    await page.close();
    gate(check, 'no shader / page errors', errors.length, '=', 0);
    gate(check, 'distance error vs framed (relative)', Math.abs(st.cam.dist - want.dist) / want.dist, '<', 0.01);
    gate(check, 'footprint span (° lat, regional ≤ 45)', st.lod.footprint.spanLatDeg, '<', 45.001);
    gate(check, 'readout says Regional detail', st.lod.text.includes('Regional detail') ? 1 : 0, '=', 1);
    gate(check, 'globe mesh far / near', far * 100 + st.lod.globeDetail, '=', 1547);
    gate(check, 'pick error vs region centre (°)', Math.hypot(st.pick.analytic.lat - r.lat, st.pick.analytic.lon - r.lon), '<', 1.5);
    gate(check, 'mesh-UV pick distance from the ANTIPODE (control, °)', Math.hypot(st.pick.meshUv.lat + r.lat, dLonAnti), '<', 1.5, { control: true });
    finish(check);
});

test('deeplink: ?region= flies there on load', async ({ browser }) => {
    const check = newCheck('deeplink', 'Deep link to a region',
        '?region=japan-and-korea opens EarthView already framed on the region.', null);
    const page = await newPage(browser);
    const errors = await boot(page, '?region=japan-and-korea', { clouds: false });
    await dismissConsent(page);
    await page.waitForFunction(() => !window.__evCamera().flying && window.__evCamera().dist < 2, null, { timeout: 60_000 });
    const fr = await cameraFrame(page);
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    await setSun(page, fr.p.map((v, i) => v * c + fr.north[i] * s));
    await page.waitForTimeout(1_000);
    const st = await page.evaluate(() => ({ pick: window.__evPick(0, 0).analytic, lod: window.__evLod().text }));
    check.frames.push({ file: save('deeplink-japan.png', await page.screenshot()), view: 'page' });
    check.metrics = { pick: st.pick, readout: st.lod };
    await page.close();
    gate(check, 'no shader / page errors', errors.length, '=', 0);
    gate(check, 'pick error vs 38° N 137° E (°)', Math.hypot(st.pick.lat - 38, st.pick.lon - 137), '<', 2);
    finish(check);
});
