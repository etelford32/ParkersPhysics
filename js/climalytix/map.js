/**
 * climalytix/map.js — the location map at the top of climalytix.html.
 * ═══════════════════════════════════════════════════════════════════════════
 * DRAWS and WIRES only. Every number comes from map-view.js (PURE, gated by
 * tests/climalytix-map-view.mjs) and the field route's own body.
 *
 *   basemap   THREE STACKED SOURCES, each optional (basemap.js has the rules):
 *             the self-hosted Blue Marble underlay (assets/earth — same
 *             origin, so it paints at once and survives GIBS being down), the
 *             NASA GIBS EPSG:4326 500 m tiles over it wherever they load
 *             (browser-direct, CORS for every origin; js/earth-detail-inset.js
 *             owns the tile grid and the URL), and the TERRAIN hillshade of
 *             assets/earth/relief-2k composited with 'overlay' (flat ground =
 *             neutral grey = no change). Both images are ARCHIVAL composites
 *             and the attribution says so. PLACE LABELS are EarthView's own
 *             city list, decluttered (the unverified GIBS reference overlays
 *             they replace were never confirmed to exist).
 *   layers    the rail LEFT of the map; Temperature is the first toggle and
 *             draws the heat field from OUR OWN GFS archive
 *             (/api/climalytix/nwp-field). Nothing stands in for it: archive
 *             down ⇒ no heat and the rail says why. It is drawn the way
 *             EarthView draws temperature on the globe: the VALUE is
 *             interpolated, then coloured by the one LUT, then the freezing
 *             seam is added (map-view heatImage) — plus, under it, labelled
 *             isotherms in the reader's unit with the freezing line
 *             emphasised (contours.js) and the window's warmest/coldest nodes.
 *   airflow   our own GFS 10 m wind (airflow.js, PURE) on a SECOND canvas
 *             over the map (#cx-map-flow, pointer-events none) so the
 *             animation never repaints the base map: seeded particles move
 *             with the real wind, time-compressed (FLOW_COMPRESSION, printed
 *             in the rail), coloured by the site's ONE wind palette
 *             (js/wind-palette.js windColor at 10 m). Reduced motion gets
 *             static STREAMLINES from the same integrator. Wind down ⇒ no
 *             flow and the rail says why. The animation runs only while the
 *             layer is on, the field covers the shown time and the stage is
 *             on screen (IntersectionObserver).
 *   air       the CAMS PM2.5 field (aq-field.js, PURE; a BOOTSTRAP source and
 *             badged so) drawn like temperature — the concentration is
 *             interpolated, THEN coloured by its EPA category — and EPA
 *             AirNow MONITORS on top, each compared with the model at its
 *             own place and the nearest field instant (model − monitor).
 *             The page makes Temperature and Air quality one-at-a-time: two
 *             full-window fields on one map read as neither.
 *   terrain   §19 T1 (terrain.js, PURE): AWS Terrain Tiles through
 *             /api/climalytix/dem, sampled onto a lat/lon grid for the view
 *             (never a stretched Mercator image), ELEVATION contours at a round
 *             interval in the reader's unit, and SUN EXPOSURE — the slope's
 *             direct beam ÷ flat ground's, now or over today — as a diverging
 *             fill (one-at-a-time with Temperature / Air quality). A tile that
 *             will not load is a hole; nothing is invented under it.
 *   lift      §19 T2 (orographic.js, PURE): the wind forced up / down by the
 *             slope at the surface, w = u·∂h/∂x + v·∂h/∂y, from the SAME
 *             terrain grid and the SAME 10 m wind frame the airflow layer
 *             draws (its time index, not a second one). A fill in the
 *             one-at-a-time group; no wind or no DEM ⇒ nothing drawn.
 *   slope     §19 T3 (slope-wind.js, PURE): Prandtl's anabatic / katabatic
 *   winds     jet on every slope, forced by THAT slope's energy budget (the
 *             Sun at the timeline's instant + GFS cloud + 2 m temperature),
 *             drawn as ARROWS along the fall line — an overlay, not a fill,
 *             so it can sit on Sun exposure. Gentle slopes are blank (the
 *             flow cannot spin up); no cloud field ⇒ clear sky, disclosed.
 *   thermals  §19 T4 (thermals.js, PURE): Deardorff w* and the Romps cloud
 *             base on GFS's OWN 0.25° nodes (a fill in the one-at-a-time
 *             group) — the heat flux is the mean over the 3 h window that
 *             contains the instant, the other fields are interpolated across
 *             it. A run without the fields draws nothing and says why.
 *   updraft   §19 T5 (updraft.js, PURE): GFS's own geometric vertical
 *             velocity at the chosen pressure level as a fill, with every
 *             node where that level is BELOW THE GROUND left blank; the rail
 *             and hover LIST the vertical motions the other layers computed
 *             (surface, slope jet, thermal scale, grid mean) — never a sum.
 *   controls  lower-right: zoom ± and a D-pad with recentre. Also: drag,
 *             wheel/trackpad zoom AT THE CURSOR, two-finger pinch, double-
 *             click zoom, and the keyboard (arrows, + −, 0) once the map has
 *             focus.
 *   time      the heat field follows the timeline's crosshair while it is on
 *             a time the run covers, and "now" otherwise — never a frame held
 *             past the end of the run (fieldTimeIndex returns null there).
 */

import {
    makeView, zoomAt, panBy, panStep, geoToPx, pxToGeo, tilePlan, scaleBar, scales, wrapNear, viewBounds,
    fieldTimeIndex, fieldSample, fieldRange, fieldExtremes, heatImage, ZOOM_STEP,
} from './map-view.js';
import { contourLines, isothermLevels, labelAnchor } from './contours.js';
import { GIBS_LAYERS, buildTileUrl } from '../earth-detail-inset.js';
import { UNDERLAY_TIERS, RELIEF_SRC, underlayTier, underlayRects, hillshade, cityLabels } from './basemap.js';
import { MAJOR_CITIES } from '../data/major-cities.js';
import { createFlow, streamlines, windAt, fieldBox, fromDirection, compressionFor, compressionLabel, SECTOR_NAMES_16 } from './airflow.js';
import { windColor } from '../wind-palette.js';
import { pm25Paint, pm25Aqi, residuals, residualSummary } from './aq-field.js';
import { categoryForAqi } from '../aqi-scale.js';
import {
    demZoomFor, tilesFor, tileSampler, sampleGrid, slopeAspect, exposureGrid, exposurePaint, elevationLevels,
    demPath, compass16, DEM_MIN_Z,
} from './terrain.js';
import { orographicGrid, orographicExtremes, orographicPaint, windSide, formatW } from './orographic.js';
import { thermalAt, thermalPaint, windowAt } from './thermals.js';
import { LEVELS, levelHeightAgl, levelUsable, bracket, verticalMotion, updraftPaint } from './updraft.js';
import { slopeWind, slopeWindGrid, slopeWindExtremes, ANABATIC_RGB, KATABATIC_RGB, ARROW_MIN_MS, THETA0_DEFAULT_K } from './slope-wind.js';
import { solarPosition } from '../sun-altitude.js';
import { buildTempLUTPixels, TEMP_ENCODE_MIN_C, TEMP_ENCODE_SPAN_C } from '../temp-ramp.js';

const BASE = GIBS_LAYERS.blueMarble;
const TERRAIN_ALPHA = 0.7;
const DEM_MAX_TILES = 48;
const DEM_GRID_PX = 4;               // one DEM grid node per 4×4 CSS px of the view
const FLOW_ALT_KM = 0.01;            // the wind palette's shade for a 10 m field
const FLOW_FADE = 0.965;             // trail persistence per frame at 60 fps (half-life ≈ 0.33 s)
const FLOW_PX_PER_PARTICLE = 420;    // one particle per this many CSS px² of data box
const FLOW_MIN = 150, FLOW_MAX = 1600;
const ASSET_ROOT = new URL('../../', import.meta.url);
const TILE_CACHE_MAX = 240;
const OCEAN = '#0a1a2e';
const HEAT_ALPHA_DEFAULT = 0.62;
const HEAT_STEP_PX = 2;          // one data sample per 2×2 CSS px block

const LUT = buildTempLUTPixels();

export function mountMap(root, deps) {
    const stage = root.querySelector('#cx-map-stage');
    const canvas = root.querySelector('#cx-map-canvas');
    const ctx = canvas.getContext('2d');
    const flowCanvas = root.querySelector('#cx-map-flow');
    const fctx = flowCanvas.getContext('2d');
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const tip = root.querySelector('#cx-map-tip');
    const scaleEl = root.querySelector('#cx-map-scale');
    const M = {
        view: null, site: null, field: null, fieldState: 'loading', fieldNote: '',
        timeMs: null, layers: { temperature: true, isotherms: true, extremes: true, terrain: true, labels: true, airflow: true, airquality: false, monitors: true, elevation: false, exposure: false, orographic: false, slopewind: false, thermals: false, updraft: false },
        exposureMode: 'today',
        dem: { tiles: new Map(), z: null, grid: null, sa: null, key: '', state: 'idle', note: '', exp: null, expKey: '', iso: null, isoKey: '', timer: 0 },
        aq: null, aqState: 'loading', aqNote: '', monitors: [], monState: 'idle', monNote: '', heatAlpha: HEAT_ALPHA_DEFAULT,
        tiles: new Map(), w: 0, h: 0, dpr: 1, raf: 0, hover: null,
        underlay: new Map(), relief: { state: 'idle', canvas: null, ms: null },
        wind: null, windState: 'loading', windNote: '',
        flow: null, flowKey: '', flowRaf: 0, flowLast: 0, flowDirty: true, flowFrames: 0, onScreen: true,
        drawn: { heat: false, tiles: 0, t: null, isotherms: 0, isoLevels: [], freezing: false, extremes: false, underlay: null, terrain: false, labels: [],
                 airflow: { mode: null, t: null, particles: 0, lines: 0, frames: 0 },
                 aq: false, aqT: null, monitors: { n: 0, compared: 0, bias: null, mae: null },
                 elevation: { lines: 0, step: null, labels: [] }, exposure: false, orographic: false, slopewind: { arrows: 0, up: 0, down: 0 }, thermals: false, updraft: { drawn: false, masked: 0, nodes: 0 } },
    };

    // ── Tiles ──────────────────────────────────────────────────────────────
    function tile(url) {
        let e = M.tiles.get(url);
        if (e) { M.tiles.delete(url); M.tiles.set(url, e); return e; }   // LRU touch
        const img = new Image();
        img.crossOrigin = 'anonymous';
        e = { img, state: 'loading' };
        img.onload = () => { e.state = 'ok'; requestDraw(); };
        img.onerror = () => { e.state = 'err'; };
        img.src = url;
        M.tiles.set(url, e);
        if (M.tiles.size > TILE_CACHE_MAX) M.tiles.delete(M.tiles.keys().next().value);
        return e;
    }

    function drawTileLayer(layer, plan) {
        let n = 0;
        for (const t of plan.tiles) {
            if (t.z > layer.maxLevel) continue;
            const e = tile(buildTileUrl(layer, t.z, t.row, t.col));
            if (e.state !== 'ok') continue;
            // Tiles already carry their 360° turn (lonOffset): place them
            // LINEARLY. Wrapping each edge on its own flips a 288°-wide z0
            // tile's west edge to the other side of the view.
            const a = lin(t.geo.north, t.geo.west), b = lin(t.geo.south, t.geo.east);
            ctx.drawImage(e.img, t.src.sx, t.src.sy, t.src.sw, t.src.sh, a.x, a.y, b.x - a.x, b.y - a.y);
            n++;
        }
        return n;
    }

    // ── Underlay (self-hosted Blue Marble) ─────────────────────────────────
    function underlayImage(tier) {
        let e = M.underlay.get(tier.id);
        if (e) return e;
        const img = new Image();
        e = { img, state: 'loading', tier };
        img.onload = () => { e.state = 'ok'; requestDraw(); };
        img.onerror = () => { e.state = 'err'; requestDraw(); };
        img.src = new URL(tier.src, ASSET_ROOT).href;
        M.underlay.set(tier.id, e);
        return e;
    }

    /** The wanted tier if it has loaded, else the largest that has. */
    function drawUnderlay() {
        const want = underlayTier(M.view, M.w, M.h, M.dpr);
        underlayImage(want);
        const ready = UNDERLAY_TIERS.map((t) => M.underlay.get(t.id)).filter((e) => e?.state === 'ok');
        const e = M.underlay.get(want.id)?.state === 'ok' ? M.underlay.get(want.id) : ready[ready.length - 1];
        if (!e) return null;
        drawWorldImage(e.img, e.img.naturalWidth, e.img.naturalHeight);
        return e.tier.id;
    }

    function drawWorldImage(img, W, H) {
        for (const r of underlayRects(M.view, M.w, M.h, W, H)) {
            const a = lin(r.geo.north, r.geo.west), b = lin(r.geo.south, r.geo.east);
            ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, a.x, a.y, b.x - a.x, b.y - a.y);
        }
    }

    // ── Terrain (hillshade of the self-hosted relief map, computed once) ────
    function loadRelief() {
        if (M.relief.state !== 'idle') return;
        M.relief.state = 'loading';
        const img = new Image();
        img.onerror = () => { M.relief.state = 'err'; requestDraw(); };
        img.onload = () => setTimeout(() => {
            try {
                const t0 = performance.now();
                const W = img.naturalWidth, H = img.naturalHeight;
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const cx = c.getContext('2d', { willReadFrequently: true });
                cx.drawImage(img, 0, 0);
                const rgba = cx.getImageData(0, 0, W, H);
                const lv = new Uint8Array(W * H);
                for (let k = 0; k < lv.length; k++) lv[k] = rgba.data[k * 4];     // grey map: R = level
                const shade = hillshade(lv, W, H);
                for (let k = 0; k < lv.length; k++) {
                    const o = k * 4;
                    rgba.data[o] = rgba.data[o + 1] = rgba.data[o + 2] = shade[k];
                    rgba.data[o + 3] = 255;
                }
                cx.putImageData(rgba, 0, 0);
                M.relief = { state: 'ok', canvas: c, ms: Math.round(performance.now() - t0) };
            } catch {
                M.relief.state = 'err';
            }
            requestDraw();
        }, 0);
        img.src = new URL(RELIEF_SRC, ASSET_ROOT).href;
    }

    function drawTerrain() {
        if (!M.layers.terrain) return false;
        loadRelief();
        if (M.relief.state !== 'ok') return false;
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = TERRAIN_ALPHA;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        drawWorldImage(M.relief.canvas, M.relief.canvas.width, M.relief.canvas.height);
        ctx.restore();
        return true;
    }

    // ── Place labels (EarthView's city list) ───────────────────────────────
    /** Boxes of the DOM drawn over the canvas, in canvas CSS px. */
    function furniture() {
        const c = canvas.getBoundingClientRect();
        return ['#cx-map-ctl', '#cx-map-attr', '#cx-map-scale'].map((sel) => root.querySelector(sel))
            .filter((el) => el && el.offsetParent)
            .map((el) => { const r = el.getBoundingClientRect(); return { x0: r.left - c.left, y0: r.top - c.top, x1: r.right - c.left, y1: r.bottom - c.top }; });
    }

    const LABEL_FONT = '600 11px system-ui, sans-serif';
    function drawLabels() {
        if (!M.layers.labels) return [];
        ctx.save();
        ctx.font = LABEL_FONT;
        const labels = cityLabels(M.view, M.w, M.h, MAJOR_CITIES, {
            site: M.site, measure: (t) => ctx.measureText(t).width, avoid: furniture(),
        });
        ctx.textBaseline = 'middle';
        for (const l of labels) {
            ctx.fillStyle = 'rgba(4,10,20,.85)';
            ctx.beginPath(); ctx.arc(l.x, l.y, 3.2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#f4f8fb';
            ctx.beginPath(); ctx.arc(l.x, l.y, 2.1, 0, Math.PI * 2); ctx.fill();
            ctx.textAlign = l.text.align;
            halo(l.name, l.text.x, l.text.y, '#f4f8fb');
        }
        ctx.restore();
        return labels.map((l) => l.name);
    }

    /** View-linear projection (no wrap) — for geometry already in the view's turn. */
    function lin(lat, lon) {
        const { kx, ky } = scales(M.view, M.h);
        return { x: M.w / 2 + (lon - M.view.lon) * kx, y: M.h / 2 - (lat - M.view.lat) * ky };
    }

    // ── Heat ───────────────────────────────────────────────────────────────
    function currentTimeIndex() {
        const f = M.field;
        if (!f?.values) return null;
        const want = M.timeMs ?? Date.now();
        return fieldTimeIndex(f.times, want) ?? (M.timeMs == null ? null : fieldTimeIndex(f.times, Date.now()));
    }

    // The heat image is evaluated per screen block in DATA space (map-view
    // heatImage — EarthView's sample → LUT → freezing-seam order) and cached
    // for the view + time it was made for; hover moves do not recompute it.
    let heatCache = { key: '', canvas: null };
    function heatCanvasFor(t) {
        const f = M.field, v = M.view;
        const key = `${f.run}|${t}|${v.lat}|${v.lon}|${v.span}|${M.w}|${M.h}`;
        if (heatCache.key !== key) {
            const img = heatImage(f, t, v, M.w, M.h, LUT, { step: HEAT_STEP_PX });
            const c = heatCache.canvas || document.createElement('canvas');
            c.width = img.cw; c.height = img.ch;
            c.getContext('2d').putImageData(new ImageData(img.data, img.cw, img.ch), 0, 0);
            heatCache = { key, canvas: c };
        }
        return heatCache.canvas;
    }

    function drawHeat() {
        Object.assign(M.drawn, { heat: false, isotherms: 0, isoLevels: [], freezing: false, extremes: false });
        if (!M.layers.temperature || !M.field?.values) return;
        const t = currentTimeIndex();
        if (t == null) return;
        const f = M.field;
        ctx.save();
        ctx.globalAlpha = M.heatAlpha;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(heatCanvasFor(t), 0, 0, M.w, M.h);
        ctx.restore();
        // The data window: where the field ends is drawn, not implied. The
        // heat is evaluated between nodes only, so the box IS the node extent.
        const shift = dashedBox({ west: f.lonW, east: f.lonW + (f.nCols - 1) * f.dlon,
                                  north: f.latN, south: f.latN - (f.nRows - 1) * f.dlat });
        M.drawn.heat = true;
        M.drawn.t = t;
        if (M.layers.isotherms) drawIsotherms(t, shift);
        if (M.layers.extremes) drawExtremes(t, shift);
    }

    // ── Terrain: elevation contours + sun exposure (terrain.js) ─────────────
    const D = M.dem;
    function demWanted() { return (M.layers.elevation || M.layers.exposure || M.layers.orographic || M.layers.slopewind) && M.view && M.w; }

    function demTile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        let e = D.tiles.get(key);
        if (e) return e;
        e = { state: 'loading', data: null };
        D.tiles.set(key, e);
        const img = new Image();
        img.onload = () => {
            try {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                const cx = c.getContext('2d', { willReadFrequently: true });
                cx.drawImage(img, 0, 0);
                e.data = cx.getImageData(0, 0, c.width, c.height).data;
                e.state = c.width === 256 && c.height === 256 ? 'ok' : 'err';
            } catch { e.state = 'err'; }
            scheduleDem();
        };
        img.onerror = () => { e.state = 'err'; scheduleDem(); };
        img.src = demPath({ z, x, y });
        if (D.tiles.size > 400) D.tiles.delete(D.tiles.keys().next().value);
        return e;
    }

    function demBox() {
        const b = viewBounds(M.view, M.w, M.h);
        return { north: Math.min(84.5, b.north), south: Math.max(-84.5, b.south), west: b.west, east: b.east };
    }

    function scheduleDem() {
        clearTimeout(D.timer);
        D.timer = setTimeout(rebuildDem, 120);
    }

    /** Plan the tiles for this view, and once they have settled, sample the grid. */
    function rebuildDem() {
        if (!demWanted()) return;
        const box = demBox();
        let z = demZoomFor(scales(M.view, M.h).kx * M.dpr);
        let tiles = tilesFor(box, z);
        while (tiles.length > DEM_MAX_TILES && z > DEM_MIN_Z) tiles = tilesFor(box, --z);
        const entries = tiles.map((t) => demTile(t.z, t.x, t.y));
        const settled = entries.filter((e) => e.state !== 'loading').length;
        const ok = entries.filter((e) => e.state === 'ok').length;
        D.z = z;
        if (settled < entries.length) { D.state = 'loading'; D.note = `Loading elevation (${settled}/${entries.length} tiles)…`; deps.onDem?.(demInfo()); return; }
        if (!ok) { D.state = 'down'; D.note = 'Elevation tiles unavailable — nothing is drawn in their place.'; D.grid = null; requestDraw(); deps.onDem?.(demInfo()); return; }
        const key = `${z}|${box.north.toFixed(4)}|${box.west.toFixed(4)}|${M.view.span}|${M.w}|${M.h}|${ok}`;
        if (D.key !== key) {
            const sampler = tileSampler(z, (zz, x, y) => { const e = D.tiles.get(`${zz}/${x}/${y}`); return e?.state === 'ok' ? e.data : null; });
            const nCols = Math.max(3, Math.ceil(M.w / DEM_GRID_PX)), nRows = Math.max(3, Math.ceil(M.h / DEM_GRID_PX));
            D.grid = sampleGrid(box, nCols, nRows, sampler);
            D.sa = slopeAspect(D.grid);
            D.key = key; D.expKey = ''; D.isoKey = '';
        }
        D.state = 'ok';
        // Slopes are only as fine as the COARSER of the tile pixel and the grid node.
        const pixM = 40_075_000 / (256 * 2 ** z) * Math.cos(M.view.lat * Math.PI / 180);
        const nodeM = D.grid.dlat * 111_195;
        const resM = Math.max(pixM, nodeM);
        D.resM = resM;
        D.note = `Terrain Tiles z${z}; slopes resolved every ~${resM >= 1000 ? `${(resM / 1000).toFixed(1)} km` : `${Math.round(resM)} m`} (zoom in for finer).`
            + (ok < entries.length ? ` · ${entries.length - ok} tile(s) missing, left blank` : '');
        requestDraw();
        deps.onDem?.(demInfo());
    }

    function exposureFor() {
        if (!D.grid) return null;
        const timeMs = M.timeMs ?? Date.now();
        const mode = M.exposureMode;
        const lonC = M.view.lon;
        // "today" = the site's local solar day containing the instant on show.
        const dayStart = Math.floor((timeMs + lonC / 15 * 3_600_000) / 86_400_000) * 86_400_000 - lonC / 15 * 3_600_000;
        const key = `${D.key}|${mode}|${mode === 'now' ? Math.floor(timeMs / 600_000) : dayStart}`;
        if (D.expKey !== key) {
            const latC = M.view.lat;
            const track = mode === 'today'
                ? Array.from({ length: 96 }, (_, k) => solarPosition(new Date(dayStart + (k + 0.5) * 900_000), latC, lonC)) : null;
            const t = new Date(timeMs);
            D.exp = exposureGrid(D.grid, D.sa, { mode, track, sunAt: (lat, lon) => solarPosition(t, lat, lon) });
            D.expKey = key; D.expCanvasKey = '';
            D.track = mode === 'today' ? { dayStartMs: dayStart, lat: latC, lon: lonC } : null;
        }
        return D.exp;
    }

    let expCanvas = null;
    function drawExposure() {
        M.drawn.exposure = false;
        if (!M.layers.exposure || !D.grid) return;
        const exp = exposureFor();
        if (!exp) return;
        const f = { ...D.grid, values: exp };
        const key = `${D.expKey}|${M.view.lat}|${M.view.lon}|${M.view.span}|${M.w}|${M.h}`;
        if (D.expCanvasKey !== key) {
            const img = heatImage(f, 0, M.view, M.w, M.h, null, { step: HEAT_STEP_PX, paint: exposurePaint });
            expCanvas = expCanvas || document.createElement('canvas');
            expCanvas.width = img.cw; expCanvas.height = img.ch;
            expCanvas.getContext('2d').putImageData(new ImageData(img.data, img.cw, img.ch), 0, 0);
            D.expCanvasKey = key;
        }
        ctx.save();
        ctx.globalAlpha = Math.min(1, M.heatAlpha + 0.2);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(expCanvas, 0, 0, M.w, M.h);
        ctx.restore();
        M.drawn.exposure = true;
    }

    // ── Orographic lift (T2) ─────────────────────────────────────────────
    /** w on the terrain grid for the wind frame the airflow layer shows, or null. */
    function orographicFor() {
        const tw = windTimeIndex();
        if (!D.grid || tw == null || !M.wind) return null;
        const key = `${D.key}|${tw}|${M.wind.run ?? ''}|${M.wind.times?.[0] ?? ''}`;
        if (D.oroKey !== key) {
            D.oro = orographicGrid(D.grid, D.sa, (lat, lon) => windAt(M.wind, tw, lat, lon));
            D.oroKey = key; D.oroCanvasKey = '';
        }
        return D.oro;
    }

    let oroCanvas = null;
    function drawOrographic() {
        M.drawn.orographic = false;
        if (!M.layers.orographic) return;
        const w = D.grid ? orographicFor() : null;
        if (w) {
            const key = `${D.oroKey}|${M.view.lat}|${M.view.lon}|${M.view.span}|${M.w}|${M.h}`;
            if (D.oroCanvasKey !== key) {
                const img = heatImage({ ...D.grid, values: w }, 0, M.view, M.w, M.h, null, { step: HEAT_STEP_PX, paint: orographicPaint });
                oroCanvas = oroCanvas || document.createElement('canvas');
                oroCanvas.width = img.cw; oroCanvas.height = img.ch;
                oroCanvas.getContext('2d').putImageData(new ImageData(img.data, img.cw, img.ch), 0, 0);
                D.oroCanvasKey = key;
                D.oroExt = orographicExtremes(D.grid, w, demBox());
            }
            ctx.save();
            ctx.globalAlpha = Math.min(1, M.heatAlpha + 0.2);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(oroCanvas, 0, 0, M.w, M.h);
            ctx.restore();
            M.drawn.orographic = true;
        }
        const info = oroInfo();
        const sig = JSON.stringify([info.state, info.timeMs, info.up?.w, info.down?.w]);
        if (D.oroSig !== sig) { D.oroSig = sig; deps.onOro?.(info); }
    }

    function oroInfo() {
        if (!M.layers.orographic) return { state: 'off' };
        if (!M.wind) return { state: M.windState === 'loading' ? 'loading' : 'nowind', note: M.windNote };
        const tw = windTimeIndex();
        if (tw == null) return { state: 'notime', note: 'The wind field does not cover this time.' };
        if (!D.grid) return { state: D.state === 'down' ? 'nodem' : 'loading', note: D.note };
        return { state: 'ok', timeMs: M.wind.times[tw], up: D.oroExt?.up ?? null, down: D.oroExt?.down ?? null,
                 n: D.oroExt?.n ?? 0, resM: D.resM ?? null };
    }

    // ── Slope winds (T3) ─────────────────────────────────────────────────
    const SW = { forcing: null, state: 'idle', note: '', cloud: false, key: '', grid: null, ext: null, sig: '' };
    function slopeTimeMs() { return M.timeMs ?? Date.now(); }
    /** The forcing's own time index (its run's times) for the instant on show, or null. */
    function forcingIndex() {
        const f = SW.forcing;
        return f?.times ? fieldTimeIndex(f.times, slopeTimeMs()) : null;
    }
    function forcingAt(tf) {
        const f = SW.forcing;
        if (!f || tf == null) return { cloudAt: () => null, theta0At: () => null };
        const cloud = { ...f, values: f.cloud }, temp = f.temp ? { ...f, values: f.temp } : null;
        return {
            cloudAt: (lat, lon) => { const c = fieldSample(cloud, tf, lat, lon); return c == null ? null : c / 100; },
            theta0At: (lat, lon) => { const t = temp ? fieldSample(temp, tf, lat, lon) : null; return t == null ? null : t + 273.15; },
        };
    }
    function slopeFor() {
        if (!D.grid) return null;
        const timeMs = slopeTimeMs(), tf = forcingIndex();
        const key = `${D.key}|${Math.floor(timeMs / 600_000)}|${tf}|${SW.forcing?.run ?? 'none'}`;
        if (SW.key !== key) {
            const when = new Date(timeMs);
            SW.grid = slopeWindGrid(D.grid, D.sa, { sunAt: (lat, lon) => solarPosition(when, lat, lon), ...forcingAt(tf) });
            SW.key = key; SW.extKey = '';
        }
        return SW.grid;
    }

    function arrow(x, y, bearing, len, rgb) {
        const dx = Math.sin(bearing * Math.PI / 180), dy = -Math.cos(bearing * Math.PI / 180);
        const x0 = x - dx * len / 2, y0 = y - dy * len / 2, x1 = x + dx * len / 2, y1 = y + dy * len / 2;
        const hx = -dy, hy = dx, hl = Math.min(6, len * 0.4);
        const path = () => {
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
            ctx.moveTo(x1 - dx * hl + hx * hl * 0.55, y1 - dy * hl + hy * hl * 0.55); ctx.lineTo(x1, y1);
            ctx.lineTo(x1 - dx * hl - hx * hl * 0.55, y1 - dy * hl - hy * hl * 0.55);
        };
        ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(6,10,18,.75)'; path(); ctx.stroke();
        ctx.lineWidth = 1.6; ctx.strokeStyle = `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})`; path(); ctx.stroke();
    }

    function drawSlopeWind() {
        M.drawn.slopewind = { arrows: 0, up: 0, down: 0 };
        if (M.layers.slopewind && D.grid) drawSlopeArrows();
        // Always tell the rail — a dead DEM must say so, not sit on "loading".
        const info = slopeInfo();
        const sig = JSON.stringify([info.state, info.timeMs, info.up?.u, info.down?.u, info.counts, info.cloud]);
        if (SW.sig !== sig) { SW.sig = sig; deps.onSlope?.(info); }
    }

    function drawSlopeArrows() {
        const sw = slopeFor();
        if (!sw) return;
        const g = D.grid, STEP = 30;
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (let y = STEP / 2; y < M.h; y += STEP) {
            for (let x = STEP / 2; x < M.w; x += STEP) {
                const p = pxToGeo(M.view, M.w, M.h, x, y);
                const i = Math.round((g.latN - p.lat) / g.dlat), j = Math.round((wrapNear(p.lon, g.lonW + 180) - g.lonW) / g.dlon);
                if (i < 0 || j < 0 || i >= g.nRows || j >= g.nCols) continue;
                const k = i * g.nCols + j, u = sw.u[k];
                if (!Number.isFinite(u) || Math.abs(u) < ARROW_MIN_MS) continue;
                arrow(x, y, sw.toward[k], Math.min(26, 8 + 5 * Math.abs(u)), u > 0 ? ANABATIC_RGB : KATABATIC_RGB);
                M.drawn.slopewind.arrows++;
                if (u > 0) M.drawn.slopewind.up++; else M.drawn.slopewind.down++;
            }
        }
        ctx.restore();
        if (SW.extKey !== `${SW.key}|${M.view.lat}|${M.view.lon}|${M.view.span}`) {
            SW.extKey = `${SW.key}|${M.view.lat}|${M.view.lon}|${M.view.span}`;
            SW.ext = slopeWindExtremes(g, sw.u, demBox());
        }
    }

    function slopeInfo() {
        if (!M.layers.slopewind) return { state: 'off' };
        if (D.state === 'down') return { state: 'nodem', note: D.note };
        if (SW.state === 'loading' || SW.state === 'idle') return { state: 'loading', note: 'Loading the cloud field…' };
        if (!D.grid) return { state: 'loading', note: D.note || 'Loading elevation…' };
        return { state: 'ok', timeMs: slopeTimeMs(), forcingIndex: forcingIndex(), cloud: SW.cloud && forcingIndex() != null,
                 forcingNote: SW.note, counts: SW.grid?.counts ?? null,
                 up: SW.ext?.up ?? null, down: SW.ext?.down ?? null, resM: D.resM ?? null };
    }

    /** The slope wind at one point, from the SAME inputs as the grid (hover + test hook). */
    function slopeAt(lat, lon, slopeDeg, aspectDeg) {
        if (!M.layers.slopewind || slopeDeg == null) return null;
        const f = forcingAt(forcingIndex());
        const c = f.cloudAt(lat, lon), t = f.theta0At(lat, lon);
        return slopeWind({ slopeDeg, aspectDeg: aspectDeg ?? NaN, sun: solarPosition(new Date(slopeTimeMs()), lat, lon),
            cloudFrac: c ?? 0, theta0K: t ?? THETA0_DEFAULT_K });
    }

    // ── Thermals (T4) ────────────────────────────────────────────────────
    const TH = { field: null, state: 'idle', note: '', key: '', grid: null, canvasKey: '', sig: '' };
    const TH_VARS = ['shflxWm2', 'hpblM', 'psfcHpa', 'tempC', 'dewC'];
    function thermalTimeMs() { return M.timeMs ?? Date.now(); }
    /** The inputs at node k for window w = { i, f } (flux of window i; the rest lerped i−1 → i). */
    function thermalInputs(f, w, sample) {
        const lerp = (v) => {
            const a = sample(v, w.i - 1), b = sample(v, w.i);
            return a == null || b == null ? NaN : a + (b - a) * w.f;
        };
        const flux = sample('shflxWm2', w.i);
        return { fluxWm2: flux == null ? NaN : flux, ziM: lerp('hpblM'), psfcHpa: lerp('psfcHpa'),
                 tempC: lerp('tempC'), dewC: lerp('dewC') };
    }
    function thermalsFor() {
        const f = TH.field;
        if (!f) return null;
        const w = windowAt(f.times, thermalTimeMs());
        if (!w) return null;
        const key = `${f.run}|${w.i}|${Math.round(w.f * 36)}`;
        if (TH.key !== key) {
            const plane = f.nRows * f.nCols;
            const wstar = new Float32Array(plane).fill(NaN);
            for (let k = 0; k < plane; k++) {
                const r = thermalAt(thermalInputs(f, w, (v, t) => {
                    const x = f.fields[v][t * plane + k];
                    return x == null || !Number.isFinite(x) ? null : x;
                }));
                if (r) wstar[k] = r.wstar;
            }
            TH.grid = { w, wstar };
            TH.key = key; TH.canvasKey = '';
        }
        return TH.grid;
    }
    /** Thermals at a point: inputs interpolated to it, then the kernel (hover, rail, test hook). */
    function thermalHere(lat, lon, ms = thermalTimeMs()) {
        const f = TH.field;
        const w = f ? windowAt(f.times, ms) : null;
        if (!w) return null;
        return thermalAt(thermalInputs(f, w, (v, t) => fieldSample({ ...f, values: f.fields[v] }, t, lat, lon)));
    }

    let thCanvas = null;
    function drawThermals() {
        M.drawn.thermals = false;
        if (M.layers.thermals && thermalsFor()) {
            const f = TH.field;
            const key = `${TH.key}|${M.view.lat}|${M.view.lon}|${M.view.span}|${M.w}|${M.h}`;
            if (TH.canvasKey !== key) {
                const img = heatImage({ ...f, values: TH.grid.wstar }, 0, M.view, M.w, M.h, null, { step: HEAT_STEP_PX, paint: thermalPaint });
                thCanvas = thCanvas || document.createElement('canvas');
                thCanvas.width = img.cw; thCanvas.height = img.ch;
                thCanvas.getContext('2d').putImageData(new ImageData(img.data, img.cw, img.ch), 0, 0);
                TH.canvasKey = key;
            }
            ctx.save();
            ctx.globalAlpha = Math.min(1, M.heatAlpha + 0.2);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(thCanvas, 0, 0, M.w, M.h);
            ctx.restore();
            dashedBox(fieldBox(f));                 // where our GFS window ends — not a weather edge
            M.drawn.thermals = true;
        }
        const info = thermalInfo();
        const sig = JSON.stringify([info.state, info.timeMs, info.site?.wstar, info.peak?.wstar, info.maxInView]);
        if (TH.sig !== sig) { TH.sig = sig; deps.onThermals?.(info); }
    }

    /** The day at the site: w* at each window end of the local day containing the instant. */
    function thermalDay(site) {
        const f = TH.field;
        if (!f || !site) return null;
        const ms = thermalTimeMs(), off = (deps.utcOffsetS?.() ?? Math.round(site.lon / 15) * 3600) * 1000;
        const d0 = Math.floor((ms + off) / 86_400_000) * 86_400_000 - off;
        const rows = [];
        f.times.forEach((t, i) => {
            if (i === 0 || t <= d0 || t > d0 + 86_400_000) return;
            const r = thermalHere(site.lat, site.lon, t);
            if (r) rows.push({ endMs: t, startMs: f.times[i - 1], ...r });
        });
        const good = rows.filter((r) => r.wstar >= 1);
        const peak = rows.reduce((a, r) => (!a || r.wstar > a.wstar ? r : a), null);
        return { rows, peak: peak && peak.wstar > 0 ? peak : null,
                 fromMs: good.length ? good[0].startMs : null, toMs: good.length ? good[good.length - 1].endMs : null };
    }

    function thermalInfo() {
        if (!M.layers.thermals) return { state: 'off' };
        if (TH.state === 'loading' || TH.state === 'idle') return { state: 'loading', note: 'Loading the thermal fields…' };
        if (!TH.field) return { state: 'down', note: TH.note };
        const timeMs = thermalTimeMs();
        if (!windowAt(TH.field.times, timeMs)) return { state: 'notime', note: 'The GFS run does not cover this time (the analysis hour has no heat-flux window).' };
        const g = thermalsFor();
        let maxInView = null;
        if (g) {
            const b = viewBounds(M.view, M.w, M.h), f = TH.field;
            for (let i = 0; i < f.nRows; i++) {
                const lat = f.latN - i * f.dlat;
                if (lat > b.north || lat < b.south) continue;
                for (let j = 0; j < f.nCols; j++) {
                    const lon = f.lonW + j * f.dlon, v = g.wstar[i * f.nCols + j];
                    if (lon < b.west || lon > b.east || !Number.isFinite(v)) continue;
                    if (!maxInView || v > maxInView.wstar) maxInView = { wstar: v, lat, lon };
                }
            }
        }
        const day = thermalDay(M.site);
        const win = windowAt(TH.field.times, timeMs);
        return { state: TH.state, note: TH.note, timeMs,
                 window: { startMs: TH.field.times[win.i - 1], endMs: TH.field.times[win.i], f: win.f }, site: M.site ? thermalHere(M.site.lat, M.site.lon) : null,
                 peak: day?.peak ?? null, fromMs: day?.fromMs ?? null, toMs: day?.toMs ?? null, maxInView };
    }

    function thermalText(r) {
        if (!r) return null;
        if (r.regime === 'none') return 'no thermals (the ground is not heating the air)';
        const h = (m) => (deps.formatHeight ? deps.formatHeight(m) : `${Math.round(m)} m`);
        return `thermals w* ${r.wstar.toFixed(1)} m/s (${r.strength}) · `
            + (r.regime === 'cu' ? `cumulus base ${h(r.baseM)} AGL` : `blue (no cumulus) to ${h(r.topM)} AGL`);
    }

    // ── Updraft (T5) ─────────────────────────────────────────────────────
    const UP = { field: null, state: 'idle', note: '', level: 700, key: '', grid: null, canvasKey: '', sig: '' };
    const UP_VARS = ['wMs850', 'wMs700', 'wMs500', 'psfcHpa', 'tempC'];
    const levelSpec = (hPa) => LEVELS.find((l) => l.hPa === hPa);
    /** Level `hPa` at a point from per-time samplers: { w, zAgl, usable } or null outside the run. */
    function levelAt(hPa, ms, sample) {
        const f = UP.field, b = f ? bracket(f.times, ms) : null;
        if (!b) return null;
        const lerp = (v) => {
            const a = sample(v, b.i0), c = sample(v, b.i1);
            return a == null || c == null ? NaN : a + (c - a) * b.f;
        };
        const psfc = lerp('psfcHpa');
        const usable = levelUsable(psfc, hPa);
        return { hPa, w: usable ? lerp(levelSpec(hPa).id) : NaN, zAgl: levelHeightAgl(psfc, hPa, lerp('tempC')), usable, psfc };
    }
    function updraftFor() {
        const f = UP.field, ms = M.timeMs ?? Date.now();
        if (!f || !bracket(f.times, ms)) return null;
        const key = `${f.run}|${UP.level}|${Math.floor(ms / 600_000)}`;
        if (UP.key !== key) {
            const plane = f.nRows * f.nCols, w = new Float32Array(plane).fill(NaN);
            let masked = 0;
            for (let k = 0; k < plane; k++) {
                const r = levelAt(UP.level, ms, (v, t) => {
                    const x = f.fields[v][t * plane + k];
                    return x == null || !Number.isFinite(x) ? null : x;
                });
                if (!r) continue;
                if (!r.usable) masked++;
                else w[k] = r.w;
            }
            UP.grid = { w, masked, nodes: plane };
            UP.key = key; UP.canvasKey = '';
        }
        return UP.grid;
    }
    function updraftHere(lat, lon, hPa = UP.level) {
        const f = UP.field;
        if (!f) return null;
        return levelAt(hPa, M.timeMs ?? Date.now(), (v, t) => fieldSample({ ...f, values: f.fields[v] }, t, lat, lon));
    }

    let upCanvas = null;
    function drawUpdraft() {
        M.drawn.updraft = { drawn: false, masked: 0, nodes: 0 };
        if (M.layers.updraft && updraftFor()) {
            const f = UP.field, g = UP.grid;
            const key = `${UP.key}|${M.view.lat}|${M.view.lon}|${M.view.span}|${M.w}|${M.h}`;
            if (UP.canvasKey !== key) {
                const img = heatImage({ ...f, values: g.w }, 0, M.view, M.w, M.h, null, { step: HEAT_STEP_PX, paint: updraftPaint });
                upCanvas = upCanvas || document.createElement('canvas');
                upCanvas.width = img.cw; upCanvas.height = img.ch;
                upCanvas.getContext('2d').putImageData(new ImageData(img.data, img.cw, img.ch), 0, 0);
                UP.canvasKey = key;
            }
            ctx.save();
            ctx.globalAlpha = Math.min(1, M.heatAlpha + 0.2);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(upCanvas, 0, 0, M.w, M.h);
            ctx.restore();
            dashedBox(fieldBox(f));
            M.drawn.updraft = { drawn: true, masked: g.masked, nodes: g.nodes };
        }
        const info = updraftInfo();
        const sig = JSON.stringify([info.state, info.level, info.timeMs, info.masked, info.budget?.map((r) => [r.key, r.w])]);
        if (UP.sig !== sig) { UP.sig = sig; deps.onUpdraft?.(info); }
    }

    /** The vertical-motion LIST at a point from whatever the layers have computed. */
    function budgetAt(lat, lon) {
        const tr = D.grid ? terrainAt(lat, lon) : null;
        const sw = tr?.slopeWind;
        // Orographic w comes from the field itself, not from whether its FILL is showing
        // (it and this layer are one-at-a-time) — whenever terrain + wind are loaded.
        let oroW = null;
        const oro = D.grid ? orographicFor() : null;
        if (oro) {
            const i = Math.round((D.grid.latN - lat) / D.grid.dlat), j = Math.round((wrapNear(lon, D.grid.lonW + 180) - D.grid.lonW) / D.grid.dlon);
            const v = i >= 0 && j >= 0 && i < D.grid.nRows && j < D.grid.nCols ? oro[i * D.grid.nCols + j] : NaN;
            oroW = Number.isFinite(v) ? v : null;
        }
        return verticalMotion({
            orographicW: oroW,
            slope: sw && sw.u != null ? { u: sw.u, slopeDeg: tr.slope, zJet: sw.zJet } : null,
            thermal: TH.field ? thermalHere(lat, lon) : null,
            levels: UP.field ? LEVELS.map((l) => updraftHere(lat, lon, l.hPa)).filter(Boolean) : [],
        });
    }

    function updraftInfo() {
        if (!M.layers.updraft) return { state: 'off' };
        if (UP.state === 'loading' || UP.state === 'idle') return { state: 'loading', note: 'Loading the vertical-motion field…' };
        if (!UP.field) return { state: 'down', note: UP.note };
        const ms = M.timeMs ?? Date.now();
        if (!bracket(UP.field.times, ms)) return { state: 'notime', note: 'The GFS run does not cover this time.' };
        const g = updraftFor();
        return { state: UP.state, note: UP.note, level: UP.level, timeMs: ms, masked: g.masked, nodes: g.nodes,
                 site: M.site ? updraftHere(M.site.lat, M.site.lon) : null,
                 budget: M.site ? budgetAt(M.site.lat, M.site.lon) : null };
    }

    function updraftText(r) {
        if (!r) return null;
        if (!r.usable) return `${r.hPa} hPa is below the ground here`;
        const h = deps.formatHeight ? deps.formatHeight(r.zAgl) : `${Math.round(r.zAgl)} m`;
        const dir = Math.abs(r.w) < 0.005 ? 'level' : r.w > 0 ? 'rising' : 'sinking';
        return `GFS ${r.hPa} hPa (≈${h} above the ground): ${dir} ${Math.abs(r.w * 100).toFixed(1)} cm/s, 25 km mean`;
    }

    function drawElevation() {
        M.drawn.elevation = { lines: 0, step: null, labels: [] };
        if (!M.layers.elevation || !D.grid) return;
        const u = deps.heightUnits?.() ?? { toDisplay: (m) => m, fromDisplay: (d) => d, sym: 'm' };
        const isoKey = `${D.key}|${u.sym}`;
        if (D.isoKey !== isoKey) {
            const r = fieldRange(D.grid, 0);
            const lv = r ? elevationLevels(r.min, r.max, u) : { step: null, levels: [] };
            D.iso = { step: lv.step, levels: lv.levels.map((l) => ({ ...l, chains: contourLines(D.grid, 0, l.m) })) };
            D.isoKey = isoKey;
        }
        ctx.save();
        ctx.lineJoin = 'round';
        for (const l of D.iso.levels) {
            if (!l.chains.length) continue;
            ctx.lineWidth = l.major ? 1.4 : 0.7;
            ctx.strokeStyle = l.major ? 'rgba(255,244,220,.82)' : 'rgba(255,244,220,.45)';
            ctx.beginPath();
            for (const ch of l.chains) ch.pts.forEach((p, k) => { const q = lin(p.lat, p.lon); if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
            ctx.stroke();
            M.drawn.elevation.lines++;
            const at = l.major ? labelAnchor(l.chains) : null;
            if (at) {
                const q = lin(at.lat, at.lon);
                ctx.font = '600 10px system-ui, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                halo(l.label, q.x, q.y, '#fff4dc');
                M.drawn.elevation.labels.push(l.label);
            }
        }
        ctx.restore();
        M.drawn.elevation.step = D.iso.step;
        if (D.railStep !== D.iso.step) { D.railStep = D.iso.step; deps.onDem?.(demInfo()); }   // the rail quotes the interval
    }

    /** Terrain at a point from the sampled grid: { h, slope, aspect, ratio } (nulls where unknown). */
    function terrainAt(lat, lon) {
        if (!D.grid) return null;
        const h = fieldSample(D.grid, 0, lat, lon);
        const i = Math.round((D.grid.latN - lat) / D.grid.dlat), j = Math.round((wrapNear(lon, D.grid.lonW + 180) - D.grid.lonW) / D.grid.dlon);
        const k = i * D.grid.nCols + j;
        const inside = i >= 0 && j >= 0 && i < D.grid.nRows && j < D.grid.nCols;
        const sl = inside ? D.sa.slope[k] : NaN, as = inside ? D.sa.aspect[k] : NaN;
        const exp = M.layers.exposure && inside ? exposureFor()?.[k] : NaN;
        const oro = M.layers.orographic && inside ? orographicFor()?.[k] : NaN;
        const slope = Number.isFinite(sl) ? sl : null, aspect = Number.isFinite(as) ? as : null;
        return { h, slope, aspect, ratio: Number.isFinite(exp) ? exp : null, w: Number.isFinite(oro) ? oro : null,
                 slopeWind: inside ? slopeAt(D.grid.latN - i * D.grid.dlat, D.grid.lonW + j * D.grid.dlon, slope, aspect) : null };
    }

    function slopeWindText(r) {
        if (!r) return null;
        if (r.regime === 'flat') return 'flat: no slope wind';
        if (r.regime === 'gentle') return 'too gentle for a slope wind to spin up';
        if (r.regime === 'neutral' || r.u == null) return 'no slope wind (heating balanced)';
        const speed = deps.formatWind ? deps.formatWind(Math.abs(r.u)) : `${Math.abs(r.u).toFixed(1)} m/s`;
        const jet = deps.formatHeight ? deps.formatHeight(r.zJet) : `${Math.round(r.zJet)} m`;
        return `${r.u > 0 ? 'upslope' : 'downslope'} ${speed} toward ${compass16(r.toward)} (${r.regime}, jet ~${jet} up)`;
    }

    function demInfo() {
        return { state: D.state, note: D.note, z: D.z, mode: M.exposureMode, step: D.iso?.step ?? null, resM: D.resM ?? null,
                 track: M.layers.exposure ? D.track ?? null : null };
    }

    // ── Air quality (CAMS PM2.5 field + AirNow monitors) ───────────────────
    function aqTimeIndex() {
        const f = M.aq;
        if (!f?.values) return null;
        const want = M.timeMs ?? Date.now();
        return fieldTimeIndex(f.times, want) ?? (M.timeMs == null ? null : fieldTimeIndex(f.times, Date.now()));
    }

    let aqCache = { key: '', canvas: null };
    function aqCanvasFor(t) {
        const f = M.aq, v = M.view;
        const key = `${f.fetchedMs}|${t}|${v.lat}|${v.lon}|${v.span}|${M.w}|${M.h}`;
        if (aqCache.key !== key) {
            const img = heatImage(f, t, v, M.w, M.h, null, { step: HEAT_STEP_PX, paint: pm25Paint });
            const c = aqCache.canvas || document.createElement('canvas');
            c.width = img.cw; c.height = img.ch;
            c.getContext('2d').putImageData(new ImageData(img.data, img.cw, img.ch), 0, 0);
            aqCache = { key, canvas: c };
        }
        return aqCache.canvas;
    }

    function drawAq() {
        M.drawn.aq = false; M.drawn.aqT = null;
        if (!M.layers.airquality || !M.aq?.values) return;
        const t = aqTimeIndex();
        if (t == null) return;
        const f = M.aq;
        ctx.save();
        ctx.globalAlpha = M.heatAlpha;
        // Category colours are FLAT bands: smoothing the half-res image would
        // blend two categories into a colour neither has.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(aqCanvasFor(t), 0, 0, M.w, M.h);
        ctx.restore();
        dashedBox({ west: f.lonW, east: f.lonW + (f.nCols - 1) * f.dlon, north: f.latN, south: f.latN - (f.nRows - 1) * f.dlat });
        M.drawn.aq = true; M.drawn.aqT = t;
    }

    function monitorRows() {
        return residuals(M.monitors, M.aq?.times || [], (t, lat, lon) => fieldSample(M.aq, t, lat, lon));
    }

    function drawMonitors() {
        M.drawn.monitors = { n: 0, compared: 0, bias: null, mae: null };
        if (!M.layers.airquality || !M.layers.monitors || !M.monitors.length) return;
        const rows = monitorRows();
        ctx.save();
        let n = 0;
        for (const r of rows) {
            if (!Number.isFinite(r.pm25)) continue;
            const p = geoToPx(M.view, M.w, M.h, r.lat, r.lon);
            if (p.x < -6 || p.y < -6 || p.x > M.w + 6 || p.y > M.h + 6) continue;
            const cat = categoryForAqi(pm25Aqi(r.pm25));
            ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = cat ? `rgb(${cat.rgb.map((c) => Math.round(c * 255)).join(',')})` : '#888';
            ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#04111f'; ctx.stroke();
            ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
            ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(244,248,251,.9)'; ctx.stroke();
            n++;
        }
        ctx.restore();
        const sum = residualSummary(rows);
        M.drawn.monitors = { n, compared: sum.n, bias: sum.bias, mae: sum.mae };
    }

    function monitorNear(x, y) {
        if (!M.layers.airquality || !M.layers.monitors) return null;
        let best = null, bd = 12;
        for (const r of monitorRows()) {
            if (!Number.isFinite(r.pm25)) continue;
            const p = geoToPx(M.view, M.w, M.h, r.lat, r.lon);
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < bd) { bd = d; best = r; }
        }
        return best;
    }

    function aqInfo() {
        const t = aqTimeIndex();
        const sum = M.monitors.length ? residualSummary(monitorRows()) : { n: 0, bias: null, mae: null };
        return { state: M.aqState, note: M.aqNote, t, timeMs: t == null ? null : M.aq.times[t],
                 range: t == null ? null : fieldRange(M.aq, t), monState: M.monState, monNote: M.monNote,
                 monitors: M.monitors.length, compared: sum.n, bias: sum.bias, mae: sum.mae,
                 monitorsAt: M.monitors[0]?.validMs ?? null };
    }

    /** The data window: where a field ends is drawn, not implied. Returns its 360° shift. */
    function dashedBox(r) {
        const shift = wrapNear((r.west + r.east) / 2, M.view.lon) - (r.west + r.east) / 2;
        const a = lin(r.north, r.west + shift), b = lin(r.south, r.east + shift);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(232,241,248,.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
        ctx.restore();
        return shift;
    }

    // Isotherms depend on the field, the time and the reader's unit — never on
    // the view — so they are contoured once per (run, t, unit) and re-projected.
    let isoCache = { key: '', levels: [] };
    function isothermsFor(t) {
        const u = deps.tempUnits();
        const key = `${M.field.run}|${t}|${u.sym}`;
        if (isoCache.key !== key) {
            const range = fieldRange(M.field, t);
            const levels = range ? isothermLevels(range.min, range.max, u) : [];
            isoCache = { key, levels: levels.map((l) => ({ ...l, chains: contourLines(M.field, t, l.c) })) };
        }
        return isoCache.levels;
    }

    function halo(text, x, y, fill) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(4,10,20,.85)';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
    }

    function drawIsotherms(t, shift) {
        const levels = isothermsFor(t);
        ctx.save();
        ctx.lineJoin = 'round';
        for (const l of levels) {
            if (!l.chains.length) continue;
            const w = l.freezing ? 2.4 : l.major ? 1.3 : 0.8;
            for (const pass of l.freezing ? ['halo', 'line'] : ['line']) {
                ctx.lineWidth = pass === 'halo' ? w + 2.5 : w;
                ctx.strokeStyle = pass === 'halo' ? 'rgba(4,10,20,.55)'
                    : l.freezing ? 'rgba(225,248,255,.95)' : `rgba(255,255,255,${l.major ? 0.62 : 0.38})`;
                ctx.beginPath();
                for (const ch of l.chains) {
                    ch.pts.forEach((p, k) => {
                        const q = lin(p.lat, p.lon + shift);
                        if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
                    });
                }
                ctx.stroke();
            }
            M.drawn.isotherms++;
            M.drawn.isoLevels.push(l.label);
            if (l.freezing) M.drawn.freezing = true;
            const at = labelAnchor(l.chains);
            if (at && (l.major || l.freezing)) {
                const q = lin(at.lat, at.lon + shift);
                ctx.font = `${l.freezing ? 700 : 600} 11px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                halo(l.freezing ? `${l.label} freezing` : l.label, q.x, q.y, l.freezing ? '#e1f8ff' : '#f4f8fb');
            }
        }
        ctx.restore();
    }

    function drawExtremes(t, shift) {
        const e = fieldExtremes(M.field, t);
        if (!e || e.max.v === e.min.v) return;
        ctx.save();
        ctx.font = '700 11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        for (const [n, glyph, fill] of [[e.max, '▲', '#ffb48c'], [e.min, '▼', '#9fd8ff']]) {
            const q = lin(n.lat, n.lon + shift);
            ctx.textAlign = 'center';
            halo(glyph, q.x, q.y, fill);
            ctx.textAlign = 'left';
            halo(deps.formatTemp(n.v), q.x + 8, q.y, fill);
        }
        ctx.restore();
        M.drawn.extremes = true;
    }

    function drawSite() {
        if (!M.site) return;
        const p = geoToPx(M.view, M.w, M.h, M.site.lat, M.site.lon);
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#04211a';
        ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = getComputedStyle(root).getPropertyValue('--cx-home').trim() || '#5fffd0';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    // ── Airflow (second canvas) ────────────────────────────────────────────
    function windTimeIndex() {
        const f = M.wind;
        if (!f?.u) return null;
        const want = M.timeMs ?? Date.now();
        return fieldTimeIndex(f.times, want) ?? (M.timeMs == null ? null : fieldTimeIndex(f.times, Date.now()));
    }

    /** The data box on screen (CSS px), in the view's turn. */
    function windBoxPx() {
        const b = fieldBox(M.wind);
        const shift = wrapNear((b.west + b.east) / 2, M.view.lon) - (b.west + b.east) / 2;
        const a = lin(b.north, b.west + shift), c = lin(b.south, b.east + shift);
        return { x0: a.x, y0: a.y, x1: c.x, y1: c.y, shift };
    }

    /** Compression for this zoom (airflow.js compressionFor): CSS px per metre at the centre. */
    function flowCompression() {
        return compressionFor(scales(M.view, M.h).ky / 111_320);
    }

    function flowWanted() {
        return M.layers.airflow && M.wind?.u && M.view && M.w && windTimeIndex() != null;
    }

    const flowColor = (s) => {
        const c = windColor(s, FLOW_ALT_KM);
        return `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
    };
    // Ten colour buckets: one stroke per bucket per frame instead of one per particle.
    const FLOW_BUCKETS = Array.from({ length: 10 }, (_, k) => flowColor((k + 0.5) / 10));

    function clearFlow() {
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.clearRect(0, 0, flowCanvas.width, flowCanvas.height);
        fctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
    }

    function ensureFlow() {
        // Spawn only where the data box is on screen: constant density at any zoom.
        const { shift } = windBoxPx();
        const vb = viewBounds(M.view, M.w, M.h);
        const region = { north: vb.north, south: vb.south, west: vb.west - shift, east: vb.east - shift };
        const bx = windBoxPx();
        const vis = Math.max(0, Math.min(bx.x1, M.w) - Math.max(bx.x0, 0)) * Math.max(0, Math.min(bx.y1, M.h) - Math.max(bx.y0, 0));
        const count = Math.round(Math.min(FLOW_MAX, Math.max(FLOW_MIN, vis / FLOW_PX_PER_PARTICLE)));
        const compression = flowCompression();
        const key = `${M.wind.run}|${count}|${region.north.toFixed(3)}|${region.west.toFixed(3)}|${M.view.span}|${compression}`;
        if (M.flowKey !== key) {
            M.flow = createFlow(M.wind, { count, seed: 20261109, region, compression });
            M.flowKey = key;
        }
    }

    function drawStreamlines(t) {
        clearFlow();
        const { shift } = windBoxPx();
        const lines = streamlines(M.wind, t);
        fctx.lineWidth = 1.4;
        fctx.lineCap = 'round';
        for (const l of lines) {
            const s = l.pts.reduce((a, p) => a + p.s, 0) / l.pts.length;
            fctx.strokeStyle = flowColor(s);
            fctx.globalAlpha = 0.85;
            fctx.beginPath();
            l.pts.forEach((p, k) => { const q = lin(p.lat, p.lon + shift); if (k) fctx.lineTo(q.x, q.y); else fctx.moveTo(q.x, q.y); });
            fctx.stroke();
            // Arrowhead at the downwind end.
            const a = lin(l.pts.at(-2).lat, l.pts.at(-2).lon + shift), b = lin(l.pts.at(-1).lat, l.pts.at(-1).lon + shift);
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            fctx.beginPath();
            fctx.moveTo(b.x, b.y);
            fctx.lineTo(b.x - 6 * Math.cos(ang - 0.45), b.y - 6 * Math.sin(ang - 0.45));
            fctx.moveTo(b.x, b.y);
            fctx.lineTo(b.x - 6 * Math.cos(ang + 0.45), b.y - 6 * Math.sin(ang + 0.45));
            fctx.stroke();
        }
        fctx.globalAlpha = 1;
        Object.assign(M.drawn.airflow, { mode: 'streamlines', t, lines: lines.length, particles: 0 });
    }

    function flowFrame(ts) {
        M.flowRaf = 0;
        if (!flowWanted() || !M.onScreen) { M.drawn.airflow.mode = null; clearFlow(); return; }
        const t = windTimeIndex();
        const dt = M.flowLast ? Math.min(0.05, Math.max(0, (ts - M.flowLast) / 1000)) : 1 / 60;
        M.flowLast = ts;
        ensureFlow();
        const { shift } = windBoxPx();
        if (M.flowDirty) { clearFlow(); M.flowDirty = false; }
        // Fade the trails (frame-rate independent).
        fctx.save();
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.globalCompositeOperation = 'destination-in';
        fctx.fillStyle = `rgba(0,0,0,${Math.pow(FLOW_FADE, dt * 60)})`;
        fctx.fillRect(0, 0, flowCanvas.width, flowCanvas.height);
        fctx.restore();
        M.flow.step(dt, t);
        const paths = FLOW_BUCKETS.map(() => []);
        for (const p of M.flow.particles) {
            if (p.born) continue;
            paths[Math.min(9, Math.floor(p.s * 10))].push(p);
        }
        fctx.lineCap = 'round';
        fctx.lineWidth = 1.6;
        paths.forEach((ps, k) => {
            if (!ps.length) return;
            fctx.strokeStyle = FLOW_BUCKETS[k];
            fctx.beginPath();
            for (const p of ps) {
                const a = lin(p.prevLat, p.prevLon + shift), b = lin(p.lat, p.lon + shift);
                fctx.moveTo(a.x, a.y); fctx.lineTo(b.x, b.y);
            }
            fctx.stroke();
        });
        M.flowFrames++;
        Object.assign(M.drawn.airflow, { mode: 'particles', t, particles: M.flow.particles.length, frames: M.flowFrames, lines: 0 });
        M.flowRaf = requestAnimationFrame(flowFrame);
    }

    /** (Re)start whatever the airflow layer should be doing now. */
    function updateFlow() {
        M.flowDirty = true;
        if (!flowWanted() || !M.onScreen) {
            if (M.flowRaf) cancelAnimationFrame(M.flowRaf);
            M.flowRaf = 0;
            clearFlow();
            M.drawn.airflow.mode = null;
            return;
        }
        if (reduceMotion?.matches) {
            if (M.flowRaf) cancelAnimationFrame(M.flowRaf);
            M.flowRaf = 0;
            drawStreamlines(windTimeIndex());
            return;
        }
        if (!M.flowRaf) { M.flowLast = 0; M.flowRaf = requestAnimationFrame(flowFrame); }
    }
    reduceMotion?.addEventListener?.('change', updateFlow);
    new IntersectionObserver(([e]) => { M.onScreen = e.isIntersecting; updateFlow(); }).observe(stage);

    // ── Frame ──────────────────────────────────────────────────────────────
    function draw() {
        M.raf = 0;
        if (!M.view || !M.w) return;
        ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
        ctx.fillStyle = OCEAN;
        ctx.fillRect(0, 0, M.w, M.h);
        M.drawn.underlay = drawUnderlay();
        const plan = tilePlan(M.view, M.w, M.h, { dpr: M.dpr, maxLevel: BASE.maxLevel });
        M.drawn.tiles = drawTileLayer(BASE, plan);
        M.drawn.terrain = drawTerrain();
        drawHeat();
        drawAq();
        drawExposure();
        drawOrographic();
        drawThermals();
        drawUpdraft();
        if (!M.drawn.heat && !M.drawn.aq && flowWanted()) dashedBox(fieldBox(M.wind));
        drawElevation();
        drawSlopeWind();
        M.drawn.labels = drawLabels();
        drawMonitors();
        drawSite();
        const sb = scaleBar(M.view, M.h, 110);
        scaleEl.querySelector('i').style.width = `${sb.px.toFixed(1)}px`;
        scaleEl.querySelector('span').textContent = sb.label;
        updateTip();
        deps.onFrame?.(frameInfo());
        deps.onAq?.(aqInfo());
    }

    function requestDraw() {
        if (!M.raf) M.raf = requestAnimationFrame(draw);
    }

    function windInfo() {
        const t = windTimeIndex();
        return { state: M.windState, note: M.windNote, t, timeMs: t == null ? null : M.wind.times[t],
                 compression: M.view && M.h ? flowCompression() : null,
                 compressionLabel: M.view && M.h ? compressionLabel(flowCompression()) : null,
                 run: M.wind?.run ?? null, nRows: M.wind?.nRows ?? 0, nCols: M.wind?.nCols ?? 0 };
    }

    function frameInfo() {
        const t = currentTimeIndex();
        return {
            t, timeMs: t == null ? null : M.field.times[t],
            range: t == null ? null : fieldRange(M.field, t),
            state: M.fieldState, note: M.fieldNote, heat: M.drawn.heat,
        };
    }

    function resize() {
        const r = stage.getBoundingClientRect();
        M.dpr = Math.min(2, window.devicePixelRatio || 1);
        M.w = Math.max(1, Math.round(r.width));
        M.h = Math.max(1, Math.round(r.height));
        canvas.width = Math.round(M.w * M.dpr);
        canvas.height = Math.round(M.h * M.dpr);
        canvas.style.width = `${M.w}px`;
        canvas.style.height = `${M.h}px`;
        flowCanvas.width = canvas.width; flowCanvas.height = canvas.height;
        flowCanvas.style.width = `${M.w}px`;
        flowCanvas.style.height = `${M.h}px`;
        fctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
        requestDraw();
        updateFlow();
        if (demWanted()) scheduleDem();
    }
    new ResizeObserver(resize).observe(stage);

    // ── Hover readout ──────────────────────────────────────────────────────
    function updateTip() {
        if (!M.hover || !M.view) { tip.hidden = true; return; }
        const g = pxToGeo(M.view, M.w, M.h, M.hover.x, M.hover.y);
        const t = currentTimeIndex();
        const v = M.layers.temperature ? fieldSample(M.field, t, g.lat, g.lon) : null;
        const tw = windTimeIndex();
        const w = M.layers.airflow && tw != null ? windAt(M.wind, tw, g.lat, g.lon) : null;
        const ll = `${Math.abs(g.lat).toFixed(2)}°${g.lat >= 0 ? 'N' : 'S'} ${Math.abs(((g.lon + 540) % 360) - 180).toFixed(2)}°${((g.lon + 540) % 360) - 180 >= 0 ? 'E' : 'W'}`;
        const ta = M.layers.airquality ? aqTimeIndex() : null;
        const pm = ta == null ? null : fieldSample(M.aq, ta, g.lat, g.lon);
        const mon = monitorNear(M.hover.x, M.hover.y);
        if (mon) {
            const model = mon.model == null ? 'no model hour within 1.5 h' : `model ${mon.model.toFixed(1)} (${mon.diff >= 0 ? '+' : ''}${mon.diff})`;
            tip.textContent = `${mon.name}: PM2.5 ${mon.pm25.toFixed(1)} µg/m³ measured · ${model}`;
            tip.hidden = false;
            const x = Math.min(M.hover.x + 12, M.w - tip.offsetWidth - 6);
            tip.style.transform = `translate(${Math.max(4, x)}px, ${M.hover.y > 40 ? M.hover.y - 30 : M.hover.y + 14}px)`;
            return;
        }
        const tr = (M.layers.elevation || M.layers.exposure || M.layers.orographic || M.layers.slopewind) ? terrainAt(g.lat, g.lon) : null;
        const terrTxt = tr && tr.h != null
            ? [deps.formatHeight ? deps.formatHeight(tr.h) : `${Math.round(tr.h)} m`,
               tr.slope != null ? `${tr.slope.toFixed(0)}° slope${tr.slope >= 1 && tr.aspect != null ? ` facing ${compass16(tr.aspect)}` : ''}` : null,
               tr.ratio != null ? `${tr.ratio.toFixed(2)}× flat-ground sun ${M.exposureMode === 'now' ? 'now' : 'today'}` : null,
               tr.w != null ? `${formatW(tr.w, { feet: deps.heightUnits?.().sym === 'ft' })} ${windSide(tr.w, tr.slope)}` : null,
               slopeWindText(tr.slopeWind)].filter(Boolean).join(' · ')
            : null;
        const thTxt = M.layers.thermals ? thermalText(thermalHere(g.lat, g.lon)) : null;
        const upTxt = M.layers.updraft ? updraftText(updraftHere(g.lat, g.lon)) : null;
        const aqTxt = pm == null ? null : `PM2.5 ${pm.toFixed(1)} µg/m³ (AQI ${pm25Aqi(pm)}, ${categoryForAqi(pm25Aqi(pm))?.name})`;
        const wind = w && deps.formatWind
            ? `${SECTOR_NAMES_16[Math.round(fromDirection(w.u, w.v) / 22.5) % 16]} ${deps.formatWind(Math.hypot(w.u, w.v))}` : null;
        tip.textContent = [terrTxt, thTxt, upTxt, aqTxt, v == null ? null : deps.formatTemp(v), wind, ll].filter(Boolean).join(' · ');
        tip.hidden = false;
        const x = Math.min(M.hover.x + 12, M.w - tip.offsetWidth - 6);
        const y = M.hover.y > 40 ? M.hover.y - 30 : M.hover.y + 14;
        tip.style.transform = `translate(${Math.max(4, x)}px, ${y}px)`;
    }

    // ── Input ──────────────────────────────────────────────────────────────
    const pointers = new Map();
    let pinch = null;
    const local = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };

    canvas.addEventListener('pointerdown', (ev) => {
        canvas.focus({ preventScroll: true });
        try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
        pointers.set(ev.pointerId, local(ev));
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        }
        stage.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', (ev) => {
        const p = local(ev);
        M.hover = p;
        const prev = pointers.get(ev.pointerId);
        if (!prev) { requestDraw(); return; }
        pointers.set(ev.pointerId, p);
        if (pointers.size === 1) {
            setView(panBy(M.view, p.x - prev.x, p.y - prev.y, M.w, M.h));
        } else if (pointers.size === 2 && pinch) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            let v = panBy(M.view, mid.x - pinch.mid.x, mid.y - pinch.mid.y, M.w, M.h);
            if (pinch.d > 0 && d > 0) v = zoomAt(v, d / pinch.d, mid.x, mid.y, M.w, M.h);
            pinch = { d, mid };
            setView(v);
        }
    });
    const release = (ev) => {
        pointers.delete(ev.pointerId);
        if (pointers.size < 2) pinch = null;
        if (!pointers.size) stage.classList.remove('is-dragging');
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => { M.hover = null; tip.hidden = true; });
    canvas.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const k = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 1 : 0.0015;
        const p = local(ev);
        setView(zoomAt(M.view, Math.exp(-ev.deltaY * k), p.x, p.y, M.w, M.h));
    }, { passive: false });
    canvas.addEventListener('dblclick', (ev) => {
        const p = local(ev);
        setView(zoomAt(M.view, ev.shiftKey ? 1 / ZOOM_STEP : ZOOM_STEP, p.x, p.y, M.w, M.h));
    });
    canvas.addEventListener('keydown', (ev) => {
        const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[ev.key];
        if (dir) { ev.preventDefault(); act(`pan-${dir}`); return; }
        if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); act('zoom-in'); }
        else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); act('zoom-out'); }
        else if (ev.key === '0' || ev.key === 'Home') { ev.preventDefault(); act('recenter'); }
    });
    root.querySelector('#cx-map-ctl').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-map-act]');
        if (b) act(b.dataset.mapAct);
    });

    function act(a) {
        if (!M.view) return;
        if (a === 'zoom-in') setView(zoomAt(M.view, ZOOM_STEP, M.w / 2, M.h / 2, M.w, M.h));
        else if (a === 'zoom-out') setView(zoomAt(M.view, 1 / ZOOM_STEP, M.w / 2, M.h / 2, M.w, M.h));
        else if (a === 'recenter' && M.site) setView(makeView(M.site.lat, M.site.lon, M.home?.span ?? M.view.span));
        else if (a.startsWith('pan-')) setView(panStep(M.view, a.slice(4), M.w, M.h));
    }

    function setView(v) {
        const c0 = M.view && M.h ? flowCompression() : null;
        M.view = v; requestDraw(); updateFlow();
        if (demWanted()) scheduleDem();
        if (flowCompression() !== c0) deps.onWind?.(windInfo());
    }

    // ── API ────────────────────────────────────────────────────────────────
    const api = {
        setSite(site) {
            if (!site) return;
            const moved = !M.site || M.site.lat !== site.lat || M.site.lon !== site.lon;
            M.site = site;
            if (moved) { M.view = makeView(site.lat, site.lon); M.home = { span: M.view.span }; }
            requestDraw();
            updateFlow();
        },
        setField(state, body, note) {
            M.fieldState = state; M.field = body?.values ? body : null; M.fieldNote = note || '';
            requestDraw();
        },
        setTime(ms) {
            const before = windTimeIndex();
            M.timeMs = Number.isFinite(ms) ? ms : null;
            requestDraw();
            if (windTimeIndex() !== before) { updateFlow(); deps.onWind?.(windInfo()); }
        },
        setLayer(name, on) {
            M.layers[name] = !!on; requestDraw();
            if (name === 'airflow') updateFlow();
            if ((name === 'elevation' || name === 'exposure' || name === 'orographic' || name === 'slopewind') && on) scheduleDem();
        },
        /** The slope-wind forcing (GFS cloud + 2 m T); state 'loading' | 'live' | 'stale' | 'partial'. */
        setSlopeForcing(state, body, note, cloud) {
            SW.state = state; SW.forcing = body || null; SW.note = note || ''; SW.cloud = !!cloud; SW.key = '';
            requestDraw();
        },
        /** The thermal inputs field (GFS); state 'loading' | 'live' | 'stale' | 'down'. */
        setThermals(state, body, note) {
            TH.state = state; TH.field = body?.fields && TH_VARS.every((v) => body.fields[v]) ? body : null;
            TH.note = note || ''; TH.key = ''; TH.sig = '';
            requestDraw();
        },
        /** The vertical-motion field (GFS DZDT); state 'loading' | 'live' | 'stale' | 'down'. */
        setUpdraft(state, body, note) {
            UP.state = state; UP.field = body?.fields && UP_VARS.every((v) => body.fields[v]) ? body : null;
            UP.note = note || ''; UP.key = ''; UP.sig = '';
            requestDraw();
        },
        setUpdraftLevel(hPa) { if (levelSpec(hPa)) { UP.level = hPa; UP.key = ''; requestDraw(); } },
        /** One level at a point (test + console hook), and the full vertical-motion list. */
        updraftAt: (lat, lon, hPa) => updraftHere(lat, lon, hPa),
        verticalMotionAt: (lat, lon) => budgetAt(lat, lon),
        /** Thermals at a point and instant (test + console hook). */
        thermalAt: (lat, lon, ms) => thermalHere(lat, lon, ms),
        setExposureMode(mode) { M.exposureMode = mode === 'now' ? 'now' : 'today'; D.expKey = ''; requestDraw(); deps.onDem?.(demInfo()); },
        /** Terrain at a point (test + console hook). */
        terrainAt,
        /** The reader's unit changed: elevation levels are chosen in it. */
        heightUnitsChanged() { D.isoKey = ''; requestDraw(); },
        /** The flow canvas's painted share (0‥1 of pixels with alpha) — the gate's on/off control. */
        flowCoverage() {
            const d = fctx.getImageData(0, 0, flowCanvas.width, flowCanvas.height).data;
            let n = 0;
            for (let k = 3; k < d.length; k += 4) if (d[k] > 8) n++;
            return n / (d.length / 4);
        },
        setAq(state, body, note) {
            M.aqState = state; M.aq = body?.values ? body : null; M.aqNote = note || '';
            aqCache = { key: '', canvas: null };
            requestDraw();
        },
        setMonitors(state, list, note) {
            M.monState = state; M.monitors = Array.isArray(list) ? list : []; M.monNote = note || '';
            requestDraw();
        },
        /** The AQ field's instant on show (the page fetches monitors for it). */
        aqTimeMs() { const t = aqTimeIndex(); return t == null ? null : M.aq.times[t]; },
        setWind(state, body, note) {
            M.windState = state; M.wind = body?.u ? body : null; M.windNote = note || '';
            M.flowKey = '';
            updateFlow();
            requestDraw();
            deps.onWind?.(windInfo());
        },
        /** Particle positions now (copies) — the browser gate's direction check. */
        flowSnapshot() {
            return M.flow ? M.flow.particles.map((p) => ({ lat: p.lat, lon: p.lon, born: p.born })) : [];
        },
        /** The reader's unit changed: isotherm levels are chosen in it. */
        unitsChanged() { isoCache = { key: '', levels: [] }; D.isoKey = ''; requestDraw(); },
        setHeatAlpha(a) { M.heatAlpha = Math.max(0, Math.min(1, a)); requestDraw(); },
        act,
        get state() {
            return {
                view: M.view && { ...M.view }, size: { w: M.w, h: M.h }, layers: { ...M.layers },
                field: M.field ? { nRows: M.field.nRows, nCols: M.field.nCols, run: M.field.run } : null,
                fieldState: M.fieldState, drawn: { ...M.drawn }, frame: frameInfo(),
                relief: { state: M.relief.state, ms: M.relief.ms },
                wind: windInfo(),
                aq: aqInfo(),
                dem: demInfo(),
                orographic: oroInfo(),
                slopewind: slopeInfo(),
                thermals: thermalInfo(),
                updraft: updraftInfo(),
            };
        },
        rampDomain: { min: TEMP_ENCODE_MIN_C, span: TEMP_ENCODE_SPAN_C },
        lut: LUT,
    };
    resize();
    return api;
}
