/**
 * climalytix/map.js — the location map at the top of climalytix.html.
 * ═══════════════════════════════════════════════════════════════════════════
 * DRAWS and WIRES only. Every number comes from map-view.js (PURE, gated by
 * tests/climalytix-map-view.mjs) and the field route's own body.
 *
 *   basemap   NASA GIBS EPSG:4326 tiles, browser-direct (GIBS serves CORS
 *             for every origin — the Worldview pattern; js/earth-detail-inset.js
 *             owns the tile grid and the URL). Blue Marble NG is ARCHIVAL
 *             imagery (a monthly composite) and the attribution says so; the
 *             features + labels overlays are drawn when they load and simply
 *             absent when they do not (their layer ids are unverified from
 *             the sandbox, which cannot reach GIBS).
 *   layers    the rail LEFT of the map; Temperature is the first toggle and
 *             draws the heat field from OUR OWN GFS archive
 *             (/api/climalytix/nwp-field). Nothing stands in for it: archive
 *             down ⇒ no heat and the rail says why. It is drawn the way
 *             EarthView draws temperature on the globe: the VALUE is
 *             interpolated, then coloured by the one LUT, then the freezing
 *             seam is added (map-view heatImage) — plus, under it, labelled
 *             isotherms in the reader's unit with the freezing line
 *             emphasised (contours.js) and the window's warmest/coldest nodes.
 *   controls  lower-right: zoom ± and a D-pad with recentre. Also: drag,
 *             wheel/trackpad zoom AT THE CURSOR, two-finger pinch, double-
 *             click zoom, and the keyboard (arrows, + −, 0) once the map has
 *             focus.
 *   time      the heat field follows the timeline's crosshair while it is on
 *             a time the run covers, and "now" otherwise — never a frame held
 *             past the end of the run (fieldTimeIndex returns null there).
 */

import {
    makeView, zoomAt, panBy, panStep, geoToPx, pxToGeo, tilePlan, scaleBar, scales, wrapNear,
    fieldTimeIndex, fieldSample, fieldRange, fieldExtremes, heatImage, ZOOM_STEP,
} from './map-view.js';
import { contourLines, isothermLevels, labelAnchor } from './contours.js';
import { GIBS_LAYERS, buildTileUrl } from '../earth-detail-inset.js';
import { buildTempLUTPixels, TEMP_ENCODE_MIN_C, TEMP_ENCODE_SPAN_C } from '../temp-ramp.js';

const BASE = GIBS_LAYERS.blueMarble;
// Reference overlays (transparent PNG). UNVERIFIED layer ids — absent if 404.
const OVERLAYS = [
    { id: 'Reference_Features_15m', matrixSet: '15.625m', ext: 'png', time: 'default', maxLevel: 7 },
    { id: 'Reference_Labels_15m', matrixSet: '15.625m', ext: 'png', time: 'default', maxLevel: 7 },
];
const TILE_CACHE_MAX = 240;
const OCEAN = '#0a1a2e';
const HEAT_ALPHA_DEFAULT = 0.62;
const HEAT_STEP_PX = 2;          // one data sample per 2×2 CSS px block

const LUT = buildTempLUTPixels();

export function mountMap(root, deps) {
    const stage = root.querySelector('#cx-map-stage');
    const canvas = root.querySelector('#cx-map-canvas');
    const ctx = canvas.getContext('2d');
    const tip = root.querySelector('#cx-map-tip');
    const scaleEl = root.querySelector('#cx-map-scale');
    const M = {
        view: null, site: null, field: null, fieldState: 'loading', fieldNote: '',
        timeMs: null, layers: { temperature: true, isotherms: true, extremes: true }, heatAlpha: HEAT_ALPHA_DEFAULT,
        tiles: new Map(), w: 0, h: 0, dpr: 1, raf: 0, hover: null, drawn: { heat: false, tiles: 0, t: null, isotherms: 0, isoLevels: [], freezing: false, extremes: false },
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
        const r = { west: f.lonW, east: f.lonW + (f.nCols - 1) * f.dlon,
                    north: f.latN, south: f.latN - (f.nRows - 1) * f.dlat };
        const shift = wrapNear((r.west + r.east) / 2, M.view.lon) - (r.west + r.east) / 2;
        const a = lin(r.north, r.west + shift), b = lin(r.south, r.east + shift);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(232,241,248,.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
        ctx.restore();
        M.drawn.heat = true;
        M.drawn.t = t;
        if (M.layers.isotherms) drawIsotherms(t, shift);
        if (M.layers.extremes) drawExtremes(t, shift);
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

    // ── Frame ──────────────────────────────────────────────────────────────
    function draw() {
        M.raf = 0;
        if (!M.view || !M.w) return;
        ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
        ctx.fillStyle = OCEAN;
        ctx.fillRect(0, 0, M.w, M.h);
        const plan = tilePlan(M.view, M.w, M.h, { dpr: M.dpr, maxLevel: BASE.maxLevel });
        M.drawn.tiles = drawTileLayer(BASE, plan);
        drawHeat();
        for (const o of OVERLAYS) drawTileLayer(o, plan);
        drawSite();
        const sb = scaleBar(M.view, M.h, 110);
        scaleEl.querySelector('i').style.width = `${sb.px.toFixed(1)}px`;
        scaleEl.querySelector('span').textContent = sb.label;
        updateTip();
        deps.onFrame?.(frameInfo());
    }

    function requestDraw() {
        if (!M.raf) M.raf = requestAnimationFrame(draw);
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
        requestDraw();
    }
    new ResizeObserver(resize).observe(stage);

    // ── Hover readout ──────────────────────────────────────────────────────
    function updateTip() {
        if (!M.hover || !M.view) { tip.hidden = true; return; }
        const g = pxToGeo(M.view, M.w, M.h, M.hover.x, M.hover.y);
        const t = currentTimeIndex();
        const v = M.layers.temperature ? fieldSample(M.field, t, g.lat, g.lon) : null;
        const ll = `${Math.abs(g.lat).toFixed(2)}°${g.lat >= 0 ? 'N' : 'S'} ${Math.abs(((g.lon + 540) % 360) - 180).toFixed(2)}°${((g.lon + 540) % 360) - 180 >= 0 ? 'E' : 'W'}`;
        tip.textContent = v == null ? ll : `${deps.formatTemp(v)} · ${ll}`;
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

    function setView(v) { M.view = v; requestDraw(); }

    // ── API ────────────────────────────────────────────────────────────────
    const api = {
        setSite(site) {
            if (!site) return;
            const moved = !M.site || M.site.lat !== site.lat || M.site.lon !== site.lon;
            M.site = site;
            if (moved) { M.view = makeView(site.lat, site.lon); M.home = { span: M.view.span }; }
            requestDraw();
        },
        setField(state, body, note) {
            M.fieldState = state; M.field = body?.values ? body : null; M.fieldNote = note || '';
            requestDraw();
        },
        setTime(ms) { M.timeMs = Number.isFinite(ms) ? ms : null; requestDraw(); },
        setLayer(name, on) { M.layers[name] = !!on; requestDraw(); },
        /** The reader's unit changed: isotherm levels are chosen in it. */
        unitsChanged() { isoCache = { key: '', levels: [] }; requestDraw(); },
        setHeatAlpha(a) { M.heatAlpha = Math.max(0, Math.min(1, a)); requestDraw(); },
        act,
        get state() {
            return {
                view: M.view && { ...M.view }, size: { w: M.w, h: M.h }, layers: { ...M.layers },
                field: M.field ? { nRows: M.field.nRows, nCols: M.field.nCols, run: M.field.run } : null,
                fieldState: M.fieldState, drawn: { ...M.drawn }, frame: frameInfo(),
            };
        },
        rampDomain: { min: TEMP_ENCODE_MIN_C, span: TEMP_ENCODE_SPAN_C },
        lut: LUT,
    };
    resize();
    return api;
}
