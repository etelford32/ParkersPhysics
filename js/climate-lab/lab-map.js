/**
 * climate-lab/lab-map.js — the lab's live world map (2D canvas).
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP IS ARCHIVAL, THE VIEW IS LIVE (the hero/Mars rule). The imagery is
 * the self-hosted NASA Blue Marble + city-lights composites the homepage hero
 * already ships (assets/earth/SOURCES.md) — years-old, cloud-free. What is
 * live is the geometry: every pixel is lit by the REAL sub-solar point
 * (sun-altitude.js `subSolarPoint`), so the terminator, the twilight band
 * and the cities that are actually in darkness are where they are right now.
 * The caption under every instance says both halves.
 *
 * If the imagery cannot load, the map draws a FEATURELESS ocean with the
 * same live terminator (the neo-watch rule: never invent geography).
 *
 * Cost: the day/night composite is rebuilt at most every REBUILD_MS and at
 * no more than the texture's own 1024 px width (drawImage scales it); the
 * per-pixel work is a precomputed-row/column dot product. Overlays (pins,
 * ground tracks, footprints) are redrawn by the caller at ≤ 1 Hz, crisp at
 * device resolution.
 *
 * Projection: plate carrée. x = (lon + 180)/360·W, y = (90 − lat)/180·H.
 */

import { subSolarPoint } from '../sun-altitude.js';

const DAY_URL = new URL('../../assets/earth/day-1k.webp', import.meta.url).href;
const LIGHTS_URL = new URL('../../assets/earth/lights-1k.webp', import.meta.url).href;
const REBUILD_MS = 4 * 60_000;
const DEG = Math.PI / 180;

let _tex = null;   // Promise<{day, lights, w, h} | null>

function loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

/** Decode both textures once per page into raw RGBA arrays. */
function loadTextures() {
    if (_tex) return _tex;
    _tex = (async () => {
        const [day, lights] = await Promise.all([loadImage(DAY_URL), loadImage(LIGHTS_URL)]);
        if (!day) return null;
        const w = day.naturalWidth || 1024, h = day.naturalHeight || 512;
        const read = (img) => {
            if (!img) return null;
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0, w, h);
            try { return g.getImageData(0, 0, w, h).data; } catch { return null; }
        };
        const dayPx = read(day);
        return dayPx ? { day: dayPx, lights: read(lights), w, h } : null;
    })();
    return _tex;
}

const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/**
 * Build the day/night base at `bw × bh` for instant `nowMs`.
 * Night keeps a little of the day map so coastlines stay legible; the
 * twilight ramp runs from the sun 6° below the horizon (civil twilight's
 * end) to 3° above it.
 */
function composeBase(tex, bw, bh, nowMs) {
    const c = document.createElement('canvas');
    c.width = bw; c.height = bh;
    const g = c.getContext('2d');
    const img = g.createImageData(bw, bh);
    const out = img.data;
    const ss = subSolarPoint(new Date(nowMs));
    const sinD = Math.sin(ss.lat * DEG), cosD = Math.cos(ss.lat * DEG);
    const cosDl = new Float32Array(bw);
    for (let x = 0; x < bw; x++) {
        const lon = (x + 0.5) / bw * 360 - 180;
        cosDl[x] = Math.cos((lon - ss.lon) * DEG);
    }
    const lo = Math.sin(-6 * DEG), hi = Math.sin(3 * DEG);
    for (let y = 0; y < bh; y++) {
        const lat = 90 - (y + 0.5) / bh * 180;
        const sL = Math.sin(lat * DEG), cL = Math.cos(lat * DEG);
        const ty = tex ? Math.min(tex.h - 1, Math.floor((y + 0.5) / bh * tex.h)) : 0;
        for (let x = 0; x < bw; x++) {
            const sinAlt = sL * sinD + cL * cosD * cosDl[x];
            const d = smooth(lo, hi, sinAlt);
            const o = (y * bw + x) * 4;
            let r, gg, b;
            if (tex) {
                const tx = Math.min(tex.w - 1, Math.floor((x + 0.5) / bw * tex.w));
                const ti = (ty * tex.w + tx) * 4;
                const k = 0.16 + 0.84 * d;
                r = tex.day[ti] * k; gg = tex.day[ti + 1] * k; b = tex.day[ti + 2] * (k + (1 - d) * 0.10);
                if (tex.lights) {
                    const L = tex.lights[ti] * (1 - d) * 1.1;
                    r += L; gg += L * 0.82; b += L * 0.45;
                }
            } else {
                // Featureless ocean: day blue, night navy — geometry only.
                r = 10 + 30 * d; gg = 26 + 70 * d; b = 58 + 110 * d;
            }
            out[o] = r > 255 ? 255 : r; out[o + 1] = gg > 255 ? 255 : gg; out[o + 2] = b > 255 ? 255 : b; out[o + 3] = 255;
        }
    }
    g.putImageData(img, 0, 0);
    return c;
}

/**
 * Mount a map on a canvas. The canvas's CSS box sets the size.
 * @param {HTMLCanvasElement} canvas
 * @param {{ overlay?: (ctx, api) => void }} opts
 * @returns {{ draw(nowMs?), setOverlay(fn), project(lat, lon), destroy(), ready: Promise<boolean> }}
 */
export function createWorldMap(canvas, { overlay = null } = {}) {
    const ctx = canvas.getContext('2d');
    let base = null, baseAt = 0, baseW = 0, tex = null, drawFn = overlay, destroyed = false;

    const size = () => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; base = null; }
        return { W: cw, H: ch, dpr };
    };
    const project = (lat, lon) => ({
        x: ((lon + 180) / 360) * canvas.width,
        y: ((90 - lat) / 180) * canvas.height,
    });

    const api = {
        project,
        get dpr() { return Math.min(2, window.devicePixelRatio || 1); },
        /** Polyline in lat/lon, split where it crosses the antimeridian. */
        path(points) {
            ctx.beginPath();
            let prev = null;
            for (const p of points || []) {
                if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) { prev = null; continue; }
                const q = project(p.lat, p.lon);
                if (!prev || Math.abs(p.lon - prev.lon) > 180) ctx.moveTo(q.x, q.y);
                else ctx.lineTo(q.x, q.y);
                prev = p;
            }
        },
    };

    function draw(nowMs = Date.now()) {
        if (destroyed) return;
        const { W, H, dpr } = size();
        if (!base || nowMs - baseAt > REBUILD_MS) {
            baseW = Math.min(1024, Math.max(256, Math.round(W / dpr)));
            base = composeBase(tex, baseW, Math.round(baseW / 2), nowMs);
            baseAt = nowMs;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(base, 0, 0, W, H);
        // Graticule every 30°, the equator a touch brighter.
        ctx.lineWidth = Math.max(1, dpr * 0.6);
        for (let lon = -150; lon <= 150; lon += 30) {
            const { x } = project(0, lon);
            ctx.strokeStyle = 'rgba(200,225,255,0.10)';
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let lat = -60; lat <= 60; lat += 30) {
            const { y } = project(lat, 0);
            ctx.strokeStyle = lat === 0 ? 'rgba(120,210,255,0.22)' : 'rgba(200,225,255,0.10)';
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        if (drawFn) { try { drawFn(ctx, api); } catch (e) { console.warn('[lab-map] overlay failed:', e); } }
    }

    const ready = loadTextures().then((t) => { tex = t; base = null; draw(); return !!t; });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(canvas);
    draw();

    return {
        draw,
        ready,
        project,
        setOverlay(fn) { drawFn = fn; draw(); },
        destroy() { destroyed = true; ro?.disconnect(); },
    };
}
