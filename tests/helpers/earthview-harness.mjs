/**
 * tests/helpers/earthview-harness.mjs — one copy of how a gate drives EarthView
 * ═══════════════════════════════════════════════════════════════════════════
 * Shared by tests/earth-regional-lod.spec.js and tests/earthview-validation.spec.js
 * so the two cannot disagree about the stubs, the quiet layer set or how a
 * frame is read back.
 *
 * Hermetic: the three-globe maps are served from assets/earth (the SAME
 * images, resized — assets/earth/SOURCES.md); GIBS snapshots by a GEOGRAPHIC
 * stub (0.15°-period longitude stripes north of 40° N, uniform grey south —
 * latitude-asymmetric on purpose, so a flipped texture cannot pass); every
 * other external request is aborted. Run with --workers=1 on the sandbox
 * (parallel SwiftShader workers kill the browser session).
 */
import { readFileSync } from 'node:fs';
import { encodePng, decodePng } from './cloud-source.mjs';

export { encodePng, decodePng };

export const MAPS = {
    'earth-blue-marble.jpg': 'assets/earth/day-2k.webp',
    'earth-night.jpg':       'assets/earth/lights-2k.webp',
    'earth-water.png':       'assets/earth/water-2k.webp',
    'earth-topology.png':    'assets/earth/relief-2k.webp',
};
/** Layers that would add light or geometry of their own to a measured frame. */
export const QUIET = ['lyr-obs-sst', 'lyr-isobars', 'lyr-wind', 'lyr-cities', 'lyr-atm', 'lyr-obs-precip',
    'lyr-obs-fires', 'lyr-obs-snow', 'lyr-rotate', 'lyr-weather', 'lyr-grid', 'lyr-tropic', 'lyr-lights'];
export const STRIPE_DEG = 0.15;   // 12.7 km at 40° N: under the global frame's Nyquist, over the window's
export const NORTH_OF = 40;

/**
 * Load earth.html hermetically and quiet it. `lights` keeps city lights on
 * (the lighting checks need them); `gibs` collects every snapshot request.
 * Returns the array that collects shader / page errors.
 */
export async function boot(page, query, { clouds = true, lights = false, gibs = [] } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' && /WebGLProgram|Shader Error|ERROR: \d+:\d+/.test(m.text())) errors.push(m.text().slice(0, 400));
    });
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
        const url = route.request().url();
        const map = url.match(/three-globe@[^/]+\/example\/img\/([^?]+)/)?.[1];
        if (map && MAPS[map]) {
            return route.fulfill({ status: 200, contentType: 'image/webp', body: readFileSync(new URL(`../../${MAPS[map]}`, import.meta.url)) });
        }
        if (/wvs\.earthdata\.nasa\.gov\/api\/v1\/snapshot/.test(url)) {
            const u = new URL(url);
            const layer = u.searchParams.get('LAYERS') ?? '';
            const W = Number(u.searchParams.get('WIDTH')), H = Number(u.searchParams.get('HEIGHT'));
            const [la0, lo0, la1, lo1] = (u.searchParams.get('BBOX') ?? '').split(',').map(Number);
            gibs.push({ layer, time: u.searchParams.get('TIME'), bbox: [la0, lo0, la1, lo1], W, H });
            if (!/Band13|Band_13/.test(layer)) {
                return route.fulfill({ status: 200, contentType: 'image/png', body: encodePng(4, 4, () => [0, 0, 0, 0]) });
            }
            // encodePng calls back with (column, row) — not a flat index
            // (treating it as one put every row on the north edge, which is
            // exactly the bug the window gate exists to catch, in the stub).
            const body = encodePng(W, H, (x, y) => {
                const lon = lo0 + ((x + 0.5) * (lo1 - lo0)) / W;
                const lat = la1 - ((y + 0.5) * (la1 - la0)) / H;          // row 0 = north
                if (lat < NORTH_OF) return [150, 150, 150, 255];
                return (Math.floor(lon / (STRIPE_DEG / 2)) & 1) ? [235, 235, 235, 255] : [70, 70, 70, 255];
            });
            return route.fulfill({ status: 200, contentType: 'image/png', body, headers: { 'access-control-allow-origin': '*' } });
        }
        return route.abort();
    });
    await page.goto('/earth.html' + query, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof window.__evLod === 'function' && typeof window.__evPick === 'function'
        && typeof window.__evCloudDetail === 'function', null, { timeout: 120_000 });
    await page.waitForTimeout(8_000);   // textures + the first mosaic
    await page.evaluate(({ quiet, clouds, lights }) => {
        const set = (id, on) => {
            const el = document.getElementById(id);
            if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
        };
        for (const id of quiet) set(id, false);
        set('lyr-clouds', clouds);
        set('lyr-lights', lights);
    }, { quiet: QUIET, clouds, lights });
    return errors;
}

/** Let the page's own loop run `n` frames (where the sun override and the camera pose are applied). */
export async function frames(page, n = 3) {
    await page.evaluate(async (n) => {
        for (let i = 0; i < n; i++) await new Promise((res) => requestAnimationFrame(res));
    }, n);
}

/** Hold the Sun at a world direction (window.__evSetSunDir) and let it take effect. */
export async function setSun(page, dir) {
    await page.evaluate((d) => window.__evSetSunDir(d[0], d[1], d[2]), dir);
    await frames(page, 3);
}

/**
 * Light the view: the Sun 30° north of the camera's own direction. The
 * surface is physically lit and the night side is black, and scrubbing the
 * clock cannot help — the globe's rotation is frozen at page load, so hours
 * of sim time move the terminator by a fraction of a degree. 30° keeps the
 * ocean glint off the measured centre.
 */
export async function sunBehindCamera(page) {
    const { p, north } = await cameraFrame(page);
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    await setSun(page, p.map((v, i) => v * c + north[i] * s));
    await page.waitForTimeout(500);
}

/** The camera's unit direction and the local north / east tangents at the sub-camera point (world frame, +Y north). */
export async function cameraFrame(page) {
    const pos = await page.evaluate(() => window.__evCamera().pos);
    const r = Math.hypot(...pos);
    const p = pos.map((v) => v / r);
    let north = [-p[1] * p[0], 1 - p[1] * p[1], -p[1] * p[2]];
    const nl = Math.hypot(...north) || 1;
    north = north.map((v) => v / nl);
    // east = north × p (right-handed: with p toward the viewer, north up, east is screen-right)
    const east = [north[1] * p[2] - north[2] * p[1], north[2] * p[0] - north[0] * p[2], north[0] * p[1] - north[1] * p[0]];
    return { pos, dist: r, p, north, east };
}

export async function flyAndSettle(page, lat, lon, dist) {
    await page.evaluate(([la, lo, d]) => window.flyToLatLon(la, lo, d), [lat, lon, dist]);
    await page.waitForFunction(() => !window.__evCamera().flying, null, { timeout: 120_000 });
    await page.waitForTimeout(2_500);   // footprint throttle (1.5 s) + a frame
}

/** The canvas alone (chrome hidden for the shot, restored after), as PNG bytes + decoded. */
export async function canvasShot(page) {
    const tag = await page.addStyleTag({ content: 'body *{visibility:hidden !important} #c{visibility:visible !important}' });
    await page.waitForTimeout(1_200);
    const png = await page.locator('#c').screenshot();
    await tag.evaluate((el) => el.remove());
    return { png, img: decodePng(png) };
}

export const lum = (img, x, y) => {
    const o = (y * img.width + x) * 4;
    return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
};

/** Bright↔dark flips along rows (hysteresis around each row's own mean). */
export function transitions(img, y0f, y1f, x0f = 0.2, x1f = 0.8, hyst = 10) {
    let flips = 0;
    const x0 = Math.round(img.width * x0f), x1 = Math.round(img.width * x1f);
    for (let y = Math.round(img.height * y0f); y < Math.round(img.height * y1f); y += 3) {
        let m = 0;
        for (let x = x0; x < x1; x++) m += lum(img, x, y);
        m /= (x1 - x0);
        let state = -1;
        for (let x = x0; x < x1; x++) {
            const v = lum(img, x, y);
            const s = v > m + hyst ? 1 : v < m - hyst ? 0 : state;
            if (state !== -1 && s !== state) flips++;
            state = s;
        }
    }
    return flips;
}

/**
 * The antimeridian column: column means over the TOP band of the frame (high
 * latitude); the seam is the largest excess of one column over the median of
 * its ±8 px neighbours, within ±40 px of the centre. Why the top band: with
 * anisotropic filtering the GPU takes its level of detail from the
 * footprint's SHORT axis, so the seam's 1→0 jump in u alone only reaches the
 * coarsest mip where v varies fast too — near the pole, where the meridians
 * converge. Measured on SwiftShader: the line runs from the disc's top edge
 * down ~45 px and is absent across the equatorial band.
 */
export function seamColumn(img) {
    const cx = img.width >> 1, y0 = Math.round(img.height * 0.005), y1 = Math.round(img.height * 0.06);
    const col = (x) => { let s = 0; for (let y = y0; y < y1; y++) s += lum(img, x, y); return s / (y1 - y0); };
    let seam = 0, at = cx;
    for (let x = cx - 40; x <= cx + 40; x++) {
        const nb = [];
        for (let k = 2; k <= 8; k++) nb.push(col(x - k), col(x + k));
        nb.sort((a, b) => a - b);
        const d = Math.abs(col(x) - nb[nb.length >> 1]);
        if (d > seam) { seam = d; at = x; }
    }
    return { seam, x: at, y0, y1 };
}

/** A nearest-neighbour enlargement of a rectangle of `img`, as PNG bytes (for the report). */
export function cropPng(img, x0, y0, w, h, scale = 4) {
    x0 = Math.max(0, Math.min(img.width - w, Math.round(x0)));
    y0 = Math.max(0, Math.min(img.height - h, Math.round(y0)));
    return encodePng(w * scale, h * scale, (x, y) => {
        const o = ((y0 + Math.floor(y / scale)) * img.width + (x0 + Math.floor(x / scale))) * 4;
        return [img.data[o], img.data[o + 1], img.data[o + 2], 255];
    });
}
