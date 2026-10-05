/**
 * sky-renderer.js — draws SkyView's chart on a 2D canvas
 * ═══════════════════════════════════════════════════════════════════════════
 * DOM-only module: it draws what sky-catalog's `evaluateSky` computed and
 * computes NO astronomy of its own. Every position comes from the frame
 * (`toEnu`), every screen point from sky-projection, so the chart and the
 * ranked list cannot disagree about where something is.
 *
 * Why a 2D canvas and not three.js: the whole chart is ~5 000 points, ~700
 * line segments and one 200×200 raster, redrawn only when something changes.
 * It runs on a software rasteriser without a governor, and it needs no import
 * map (the Firefox import-map scar in CLAUDE.md §8 cannot happen here).
 *
 * THREE THINGS ARE DRAWN DIFFERENTLY ON PURPOSE:
 *  - Stars fainter than tonight's limit are drawn as GHOSTS (dimmed), not
 *    hidden: the chart shows what is up there AND which part of it you can
 *    see, and the legend says so. In daylight the whole field is ghosted.
 *  - The Sun and Moon are drawn at a FLOOR size (they are half a degree, a
 *    pixel or two on the dome) — symbolic, disclosed in the legend; zoom in
 *    the Look view and they reach true angular size.
 *  - Galaxy-map LANDMARKS (black holes, distant quasars, superclusters) are
 *    hollow diamonds: located exactly, never drawn as if they shine.
 */

import { toEnu, fromEnu, altAzToEnu, raDecToVec, vecToRaDec, galacticToEquatorial, D2R } from './sky-engine.js';
import { project, unproject, horizonCircle } from './sky-projection.js';
import { bvToRgb } from './sky-catalog.js';

const MW_RES = 220;                  // offscreen Milky Way raster (px, square-ish)

const KIND_COLOR = Object.freeze({
    galaxy: '#c9a7ff', nebula: '#7fe0c8', 'open-cluster': '#ffd98a', globular: '#ffb8a0',
    asterism: '#ffd98a', landmark: '#ff6fd8',
});

/** Sky background colour for a Sun altitude (day → twilight → night). */
export function skyColor(sunAltDeg) {
    const stops = [
        [ 10, [ 62, 118, 182]],
        [  0, [ 52,  84, 140]],
        [ -6, [ 24,  36,  78]],
        [-12, [ 10,  14,  38]],
        [-18, [  4,   6,  18]],
    ];
    if (sunAltDeg >= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        const [h1, c1] = stops[i - 1], [h2, c2] = stops[i];
        if (sunAltDeg >= h2) {
            const t = (sunAltDeg - h1) / (h2 - h1);
            return c1.map((v, k) => Math.round(v + (c2[k] - v) * t));
        }
    }
    return stops[stops.length - 1][1];
}

/** 0 in daylight → 1 in full darkness: how much the faint layers may show. */
export function darkness(sunAltDeg) {
    return Math.max(0, Math.min(1, (-sunAltDeg - 2) / 14));
}

export class SkyRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.dpr = 1;
        this._mw = document.createElement('canvas');
        this._mwKey = '';
        this.hitList = [];            // [{key, x, y, r, priority}] from the last draw
    }

    resize(cssW, cssH) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this.dpr = dpr;
        this.canvas.width = Math.round(cssW * dpr);
        this.canvas.height = Math.round(cssH * dpr);
        this.canvas.style.width = `${cssW}px`;
        this.canvas.style.height = `${cssH}px`;
        this._mwKey = '';
    }

    /**
     * Draw everything. `s` = { view, frame, cat, sky, layers, topKeys (Map key→rank),
     * selectedKey, hoverKey }.
     */
    draw(s) {
        const { ctx, dpr } = this;
        const { view, frame, cat, sky, layers } = s;
        const W = view.width, H = view.height;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const sunAlt = sky.env.sunAltDeg;
        const dark = darkness(sunAlt);
        this.hitList = [];

        // 1. Sky
        const [r, g, b] = skyColor(sunAlt);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, W, H);
        const hz = horizonCircle(view);

        // Clip everything celestial to the sky side of the horizon.
        ctx.save();
        this._clipSky(hz, W, H);

        if (layers.milkyWay && dark > 0.05) this._drawMilkyWay(s, dark);
        if (layers.grid) this._drawGrid(view);
        if (layers.galactic) this._drawGreatCircle(s, (t) => galacticToEquatorial(t, 0), 'rgba(255,111,216,0.55)', 'Galactic plane');
        if (layers.ecliptic) this._drawGreatCircle(s, (t) => eclipticPoint(t), 'rgba(255,214,120,0.5)', 'Ecliptic');
        if (layers.constellations) this._drawConstellations(s, dark);
        this._drawStars(s, dark);
        this._drawDeepSky(s, dark);
        if (layers.landmarks) this._drawLandmarks(s);
        this._drawSolarSystem(s);
        if (s.tracks?.length) this._drawTracks(s);
        ctx.restore();

        // Ground over everything below the horizon, then the horizon line.
        this._drawGround(hz, W, H, sunAlt);
        this._drawCardinals(view);
        if (layers.labels) this._drawLabels(s);
        this._drawSelection(s);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    _p(view, frame, v) { return project(view, toEnu(frame, v)); }

    _clipSky(hz, W, H) {
        const ctx = this.ctx;
        ctx.beginPath();
        if (!hz) { ctx.rect(0, 0, W, H); ctx.clip(); return; }
        if (hz.groundInside) {
            ctx.rect(0, 0, W, H);
            ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2, true);
            ctx.clip('evenodd');
        } else {
            ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2);
            ctx.clip();
        }
    }

    _drawGround(hz, W, H, sunAlt) {
        if (!hz) return;
        const ctx = this.ctx;
        const day = Math.max(0, Math.min(1, (sunAlt + 6) / 12));
        const g0 = [10 + 26 * day, 14 + 30 * day, 12 + 20 * day];
        ctx.save();
        ctx.beginPath();
        if (hz.groundInside) {
            ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2);
        } else {
            ctx.rect(0, 0, W, H);
            ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2, true);
        }
        ctx.fillStyle = `rgb(${g0.map(Math.round).join(',')})`;
        ctx.fill('evenodd');
        ctx.beginPath();
        ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(160,200,255,0.55)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
    }

    _drawCardinals(view) {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [label, az] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]) {
            // Just below the horizon so the letter sits on the ground.
            const p = project(view, altAzToEnu(view.mode === 'dome' ? -3.5 : -2.5, az));
            if (!p || p.x < 8 || p.x > view.width - 8 || p.y < 8 || p.y > view.height - 8) continue;
            ctx.fillStyle = label.length === 1 ? '#ffd27a' : 'rgba(200,215,240,0.7)';
            ctx.font = label.length === 1 ? '700 13px system-ui, sans-serif' : '500 10px system-ui, sans-serif';
            ctx.fillText(label, p.x, p.y);
        }
        ctx.restore();
    }

    _drawGrid(view) {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(140,170,230,0.16)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        for (const alt of [30, 60]) {
            ctx.beginPath();
            let first = true;
            for (let az = 0; az <= 360; az += 3) {
                const p = project(view, altAzToEnu(alt, az));
                if (!p) { first = true; continue; }
                if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        }
        for (let az = 0; az < 360; az += 45) {
            ctx.beginPath();
            let first = true;
            for (let alt = 0; alt <= 88; alt += 4) {
                const p = project(view, altAzToEnu(alt, az));
                if (!p) { first = true; continue; }
                if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawGreatCircle(s, pointAt, color, label) {
        const { view, frame } = s;
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.1;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        let first = true, labelAt = null;
        for (let t = 0; t <= 360; t += 2) {
            const { raDeg, decDeg } = pointAt(t);
            const p = this._p(view, frame, raDecToVec(raDeg, decDeg));
            if (!p) { first = true; continue; }
            if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
            if (!labelAt && p.cosTheta > 0.2 && toEnu(frame, raDecToVec(raDeg, decDeg))[2] > 0.15) labelAt = p;
        }
        ctx.stroke();
        if (labelAt) {
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.font = '500 10px system-ui, sans-serif';
            ctx.fillText(label, labelAt.x + 4, labelAt.y - 4);
        }
        ctx.restore();
    }

    _drawConstellations(s, dark) {
        const { view, frame, cat } = s;
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = `rgba(120,160,235,${0.22 + 0.28 * dark})`;
        ctx.lineWidth = 1;
        for (const c of cat.constellations) {
            for (const line of c.lineVecs) {
                ctx.beginPath();
                let first = true;
                for (const v of line) {
                    const p = this._p(view, frame, v);
                    if (!p) { first = true; continue; }
                    if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
                }
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _drawStars(s, dark) {
        const { view, frame, cat, sky } = s;
        const ctx = this.ctx;
        const S = cat.stars;
        const limit = sky.env.limit;
        const scale = view.mode === 'dome' ? 1 : Math.min(1.8, Math.max(1, 90 / view.fovDeg) ** 0.35);
        ctx.save();
        for (let i = S.n - 1; i >= 0; i--) {                  // faint first, bright on top
            if (sky.starAlt[i] < -1) continue;
            const v = [S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]];
            const p = this._p(view, frame, v);
            if (!p || p.x < -4 || p.y < -4 || p.x > view.width + 4 || p.y > view.height + 4) continue;
            const m = S.mag[i];
            const rad = Math.max(0.55, (0.55 + 0.42 * (6.2 - m)) * scale);
            const seen = m <= limit;
            const alpha = seen ? Math.min(1, 0.55 + 0.12 * (limit - m)) : 0.18 + 0.12 * dark;
            const [cr, cg, cb] = bvToRgb(S.bv[i]);
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
            ctx.fill();
            if (m < 1.6 && seen) {
                const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 3.2);
                gr.addColorStop(0, `rgba(${cr},${cg},${cb},0.35)`);
                gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
                ctx.fillStyle = gr;
                ctx.beginPath();
                ctx.arc(p.x, p.y, rad * 3.2, 0, Math.PI * 2);
                ctx.fill();
            }
            if (m <= 4.5) this.hitList.push({ key: `hip:${S.hip[i]}`, x: p.x, y: p.y, r: rad, priority: 3 - m * 0.1 });
        }
        ctx.restore();
    }

    _drawDeepSky(s, dark) {
        const { view, frame, sky, topKeys } = s;
        const ctx = this.ctx;
        ctx.save();
        for (const o of sky.objects) {
            if (o.kind === 'star' || o.kind === 'planet' || o.kind === 'sun' || o.kind === 'moon') continue;
            if (o.altDeg < 0) continue;
            const inTop = topKeys.has(o.key);
            if (!inTop && !(o.mag <= 7.5)) continue;
            const p = this._p(view, frame, raDecToVec(o.raDeg, o.decDeg));
            if (!p) continue;
            const seen = o.vis.margin >= 0;
            const col = KIND_COLOR[o.kind] ?? '#ccc';
            const pxPerDeg = view.s * D2R * 2 / (1 + p.cosTheta);
            const rr = Math.max(4, Math.min(60, ((o.dimArcmin ?? 10) / 60) * pxPerDeg / 2));
            ctx.globalAlpha = seen ? 0.9 : 0.35 + 0.25 * dark;
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            if (o.kind === 'galaxy') ctx.ellipse(p.x, p.y, rr, rr * 0.5, -0.5, 0, Math.PI * 2);
            else if (o.kind === 'nebula') ctx.rect(p.x - rr * 0.8, p.y - rr * 0.8, rr * 1.6, rr * 1.6);
            else if (o.kind === 'globular') { ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.moveTo(p.x - rr, p.y); ctx.lineTo(p.x + rr, p.y); ctx.moveTo(p.x, p.y - rr); ctx.lineTo(p.x, p.y + rr); }
            else { ctx.setLineDash([2, 2]); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); }
            ctx.stroke();
            ctx.setLineDash([]);
            this.hitList.push({ key: o.key, x: p.x, y: p.y, r: Math.max(rr, 6), priority: 2 });
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    _drawLandmarks(s) {
        const { view, frame, sky } = s;
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = KIND_COLOR.landmark;
        ctx.lineWidth = 1.1;
        for (const o of sky.landmarks) {
            if (o.altDeg < 0) continue;
            const p = this._p(view, frame, raDecToVec(o.raDeg, o.decDeg));
            if (!p) continue;
            const d = 4.5;
            ctx.globalAlpha = 0.75;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d, p.y); ctx.lineTo(p.x, p.y + d); ctx.lineTo(p.x - d, p.y); ctx.closePath();
            ctx.stroke();
            this.hitList.push({ key: o.key, x: p.x, y: p.y, r: 6, priority: 1 });
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    _drawSolarSystem(s) {
        const { view, frame, sky } = s;
        const ctx = this.ctx;
        const sun = sky.env.sun;
        for (const o of sky.objects) {
            if (o.kind !== 'planet' && o.kind !== 'sun' && o.kind !== 'moon') continue;
            if (o.altDeg < -1) continue;
            const p = this._p(view, frame, raDecToVec(o.raDeg, o.decDeg));
            if (!p) continue;
            const pxPerDeg = view.s * D2R * 2 / (1 + p.cosTheta);
            const trueR = (o.angDiamArcsec / 3600 / 2) * pxPerDeg;
            ctx.save();
            if (o.kind === 'sun') {
                const R = Math.max(9, trueR);
                const gr = ctx.createRadialGradient(p.x, p.y, R * 0.3, p.x, p.y, R * 4);
                gr.addColorStop(0, 'rgba(255,240,200,0.9)');
                gr.addColorStop(1, 'rgba(255,220,150,0)');
                ctx.fillStyle = gr;
                ctx.beginPath(); ctx.arc(p.x, p.y, R * 4, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#fff6dc';
                ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
                this.hitList.push({ key: o.key, x: p.x, y: p.y, r: R + 4, priority: 6 });
            } else if (o.kind === 'moon') {
                const R = Math.max(8, trueR);
                this._drawMoon(p, R, o, sun, view, frame);
                this.hitList.push({ key: o.key, x: p.x, y: p.y, r: R + 4, priority: 6 });
            } else {
                const R = Math.max(2.4, Math.min(7, 1.6 + 0.9 * (2.5 - o.mag)), trueR);
                ctx.fillStyle = o.color;
                ctx.shadowColor = o.color;
                ctx.shadowBlur = 8;
                ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
                if (o.id === 'saturn' && R < 9) {
                    ctx.strokeStyle = 'rgba(234,217,166,0.8)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.ellipse(p.x, p.y, R * 2, R * Math.max(0.15, Math.abs(Math.sin((o.ringTiltDeg ?? 0) * D2R))) * 2, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                this.hitList.push({ key: o.key, x: p.x, y: p.y, r: R + 5, priority: 5 });
            }
            ctx.restore();
        }
    }

    /** Phase-correct Moon: bright limb toward the Sun's SCREEN direction. */
    _drawMoon(p, R, moon, sun, view, frame) {
        const ctx = this.ctx;
        // Screen direction to the Sun: step 2° from the Moon toward the Sun on the sky.
        const vm = raDecToVec(moon.raDeg, moon.decDeg), vs = raDecToVec(sun.raDeg, sun.decDeg);
        const t = [vs[0] - vm[0], vs[1] - vm[1], vs[2] - vm[2]];
        const k = vm[0] * t[0] + vm[1] * t[1] + vm[2] * t[2];
        const perp = [t[0] - k * vm[0], t[1] - k * vm[1], t[2] - k * vm[2]];
        const pl = Math.hypot(...perp) || 1;
        const step = [vm[0] + 0.035 * perp[0] / pl, vm[1] + 0.035 * perp[1] / pl, vm[2] + 0.035 * perp[2] / pl];
        const q = project(view, toEnu(frame, step));
        const ang = q ? Math.atan2(q.y - p.y, q.x - p.x) : 0;
        const cosA = Math.cos(moon.phaseAngleDeg * D2R);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(ang);
        ctx.fillStyle = '#1b1d24';
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#eceadf';
        ctx.beginPath(); ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2); ctx.fill();           // sunward half
        ctx.beginPath(); ctx.ellipse(0, 0, Math.abs(cosA) * R, R, 0, 0, Math.PI * 2);
        ctx.fillStyle = cosA > 0 ? '#eceadf' : '#1b1d24';                                     // gibbous adds, crescent removes
        ctx.fill();
        ctx.strokeStyle = 'rgba(236,234,223,0.35)';
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
    }

    _drawMilkyWay(s, dark) {
        const { view, frame, cat } = s;
        const mw = cat.milkyWay;
        const key = `${view.width}x${view.height}|${view.mode}|${view.centerAltDeg.toFixed(2)}|${view.centerAzDeg.toFixed(2)}|${view.fovDeg}|${frame.jd.toFixed(4)}`;
        const aspect = view.width / view.height;
        const w = aspect >= 1 ? MW_RES : Math.round(MW_RES * aspect);
        const h = aspect >= 1 ? Math.round(MW_RES / aspect) : MW_RES;
        if (key !== this._mwKey) {
            this._mwKey = key;
            this._mw.width = w; this._mw.height = h;
            const c2 = this._mw.getContext('2d');
            const img = c2.createImageData(w, h);
            const sx = view.width / w, sy = view.height / h;
            for (let j = 0; j < h; j++) {
                for (let i = 0; i < w; i++) {
                    const enu = unproject(view, (i + 0.5) * sx, (j + 0.5) * sy);
                    if (enu[2] < -0.02) continue;
                    const { raDeg, decDeg } = vecToRaDec(fromEnu(frame, enu));
                    const val = sampleGrid(mw, raDeg, decDeg) / mw.levels;
                    if (val <= 0) continue;
                    const o = (j * w + i) * 4;
                    img.data[o] = 205; img.data[o + 1] = 214; img.data[o + 2] = 255;
                    img.data[o + 3] = Math.round(255 * Math.pow(val, 1.25));
                }
            }
            c2.putImageData(img, 0, 0);
        }
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 0.42 * dark;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(2px)';
        ctx.drawImage(this._mw, 0, 0, view.width, view.height);
        ctx.filter = 'none';
        ctx.restore();
    }

    _drawLabels(s) {
        const { view, frame, sky, topKeys, selectedKey } = s;
        const ctx = this.ctx;
        const placed = [];
        const fits = (x, y, w, h) => {
            if (x < 2 || y < 2 || x + w > view.width - 2 || y + h > view.height - 2) return false;
            for (const b of placed) if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return false;
            return true;
        };
        const items = [];
        for (const o of sky.ranked) {
            if (!topKeys.has(o.key)) continue;
            items.push(o);
        }
        // Famous landmarks get a label too (the map's linked objects first).
        const marks = s.layers.landmarks
            ? sky.landmarks.filter((o) => o.altDeg > 0 && (o.galactic.link || FAMOUS_LANDMARKS.has(o.id)))
            : [];
        ctx.save();
        ctx.textBaseline = 'middle';
        // Object labels first (rank order), then landmarks; constellation names
        // last and only where they collide with nothing — a name over a star's
        // label made both unreadable.
        for (const o of [...items, ...marks]) {
            const p = this._p(view, frame, raDecToVec(o.raDeg, o.decDeg));
            if (!p) continue;
            const rank = topKeys.get(o.key);
            const isTop10 = rank != null && rank <= 10;
            const text = isTop10 ? `${rank}  ${o.name}` : o.name;
            ctx.font = isTop10 ? '700 11.5px system-ui, sans-serif' : '500 10.5px system-ui, sans-serif';
            const w = ctx.measureText(text).width + (isTop10 ? 8 : 2);
            const hgt = isTop10 ? 16 : 13;
            // Clear the selection reticle (radius 13 + ticks) when this is the selected object.
            const off = o.key === selectedKey ? 22 : o.kind === 'sun' || o.kind === 'moon' ? 13 : 7;
            let spot = null;
            for (const [dx, dy] of [[off, -hgt / 2], [off, -hgt], [-w - off, -hgt / 2], [off, 0], [-w / 2, off]]) {
                if (fits(p.x + dx, p.y + dy, w, hgt)) { spot = [p.x + dx, p.y + dy]; break; }
            }
            if (!spot && o.key !== selectedKey) continue;
            spot ??= [p.x + off, p.y - hgt / 2];
            placed.push({ x: spot[0], y: spot[1], w, h: hgt });
            if (isTop10) {
                ctx.fillStyle = 'rgba(8,12,28,0.72)';
                roundRect(ctx, spot[0], spot[1], w, hgt, 4);
                ctx.fill();
                ctx.fillStyle = o.vis.margin >= 0 ? '#ffe7a8' : '#b7c2dc';
                ctx.fillText(text, spot[0] + 4, spot[1] + hgt / 2 + 0.5);
            } else {
                ctx.fillStyle = o.kind === 'landmark' ? 'rgba(255,111,216,0.85)'
                    : o.vis.margin >= 0 ? 'rgba(225,232,255,0.9)' : 'rgba(170,184,214,0.6)';
                ctx.fillText(text, spot[0] + 1, spot[1] + hgt / 2);
            }
        }
        if (s.layers.constellations) {
            ctx.font = '500 10px system-ui, sans-serif';
            ctx.fillStyle = 'rgba(140,175,240,0.55)';
            for (const c of s.cat.constellations) {
                const enu = toEnu(frame, c.labelVec);
                if (enu[2] < 0.05) continue;
                const p = project(view, enu);
                if (!p) continue;
                const text = c.name.toUpperCase();
                const w = ctx.measureText(text).width + 2, hgt = 12;
                const x = p.x - w / 2, y = p.y - hgt / 2;
                if (!fits(x, y, w, hgt)) continue;
                placed.push({ x, y, w, h: hgt });
                ctx.fillText(text, x + 1, y + hgt / 2);
            }
        }
        ctx.restore();
    }

    _drawSelection(s) {
        const { view, frame, selectedKey, hoverKey, sky } = s;
        const ctx = this.ctx;
        for (const [key, color, w] of [[hoverKey, 'rgba(160,200,255,0.75)', 1.2], [selectedKey, '#7fd0ff', 2]]) {
            if (!key) continue;
            const o = findObject(sky, key);
            // Below the horizon there is nothing to point at: the ground covers it
            // in Look mode, and on the dome it would float outside the rim.
            if (!o || o.altDeg < -0.5) continue;
            const p = this._p(view, frame, raDecToVec(o.raDeg, o.decDeg));
            if (!p) continue;
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = w;
            const R = 13;
            ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.stroke();
            for (let a = 0; a < 4; a++) {
                const t = a * Math.PI / 2;
                ctx.beginPath();
                ctx.moveTo(p.x + Math.cos(t) * (R + 3), p.y + Math.sin(t) * (R + 3));
                ctx.lineTo(p.x + Math.cos(t) * (R + 8), p.y + Math.sin(t) * (R + 8));
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    /**
     * Tracked objects (≤ 3, fixed colour slot per object — js/skyview/skyview-page.js
     * TRACK_COLORS, validated for CVD on this sky). Two layers, both computed
     * by sky-predict.js, never here:
     *   arc     the path across the sky through tonight's darkness, with a tick
     *           and label on every whole hour of the device clock
     *   nightly the object at THIS clock time on each coming night — for a
     *           galactic object a slow westward march (0.99°/night, the sidereal
     *           drift); for the Moon and planets, their own motion on top
     * Labels wear text ink; the colour lives on the mark (identity, not text).
     */
    _drawTracks(s) {
        const { view, tracks, layers } = s;
        const ctx = this.ctx;
        const P = (p) => project(view, altAzToEnu(p.altDeg, p.azDeg));
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const t of tracks) {
            if (layers.trackArc && t.arc?.length) {
                ctx.strokeStyle = t.color;
                ctx.globalAlpha = 0.85;
                ctx.lineWidth = 2;
                ctx.setLineDash([]);
                ctx.beginPath();
                let first = true;
                for (const q of t.arc) {
                    const p = q.altDeg > -3 ? P(q) : null;
                    if (!p) { first = true; continue; }
                    if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
                }
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.font = '600 10px system-ui, sans-serif';
                ctx.textBaseline = 'middle';
                for (const tk of t.ticks ?? []) {
                    if (tk.altDeg < 0) continue;
                    const p = P(tk);
                    if (!p) continue;
                    ctx.fillStyle = t.color;
                    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = 'rgba(4,6,15,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
                    ctx.fillStyle = 'rgba(230,236,250,0.9)';
                    ctx.fillText(tk.label, p.x + 6, p.y - 6);
                }
            }
            // The tracked object is always named, at where it is now, in text ink
            // beside a ring in its colour — even if the label pass dropped it.
            const now = t.nightly?.[0];
            if (now && now.altDeg > 0) {
                const p = P(now);
                if (p) {
                    ctx.strokeStyle = t.color; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
                    ctx.font = '700 11px system-ui, sans-serif';
                    ctx.textBaseline = 'middle';
                    const w = ctx.measureText(t.name).width;
                    ctx.fillStyle = 'rgba(8,12,28,0.78)';
                    ctx.fillRect(p.x + 11, p.y - 17, w + 8, 15);
                    ctx.fillStyle = '#eef3ff';
                    ctx.fillText(t.name, p.x + 15, p.y - 9);
                }
            }
            if (layers.trackNights && t.nightly?.length) {
                const n = t.nightly.length;
                for (let k = n - 1; k >= 0; k--) {
                    const q = t.nightly[k];
                    if (q.altDeg < 0) continue;
                    const p = P(q);
                    if (!p) continue;
                    ctx.globalAlpha = 1 - 0.6 * (k / Math.max(1, n - 1));
                    ctx.fillStyle = t.color;
                    ctx.beginPath(); ctx.arc(p.x, p.y, k === 0 ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = 'rgba(4,6,15,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
                    if (q.label) {
                        ctx.fillStyle = 'rgba(230,236,250,0.85)';
                        ctx.font = '500 10px system-ui, sans-serif';
                        ctx.fillText(q.label, p.x + 7, p.y + 9);
                    }
                }
            }
        }
        ctx.restore();
    }

    /** Nearest drawn object within `radiusPx` of (x, y), preferring higher priority on ties. */
    pick(x, y, radiusPx = 16) {
        let best = null, bestScore = Infinity;
        for (const h of this.hitList) {
            const d = Math.hypot(h.x - x, h.y - y);
            if (d > Math.max(radiusPx, h.r + 4)) continue;
            const score = d - h.priority * 2;
            if (score < bestScore) { bestScore = score; best = h; }
        }
        return best?.key ?? null;
    }
}

/** Names of landmarks worth labelling even when they are not the map's linked pages. */
export const FAMOUS_LANDMARKS = new Set([
    'sgr_a', 'ton618', 'great_attractor', 'laniakea', 'bootes_void', 'coma_cluster', 'cygnus_x1',
    'gn_z11', 'cassiopeia_a', 'eta_car', '3c273', 'cen_a', 'earendel',
]);

export function findObject(sky, key) {
    return sky.objects.find((o) => o.key === key) ?? sky.landmarks.find((o) => o.key === key) ?? null;
}

/** Bilinear sample of the Milky Way grid (levels) at RA/Dec. */
export function sampleGrid(mw, raDeg, decDeg) {
    const fx = ((raDeg % 360) + 360) % 360 - 0.5;
    const fy = (90 - decDeg) * (mw.height / 180) - 0.5;
    const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(mw.height - 2, Math.floor(fy)));
    const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
    const at = (x, y) => mw.grid[y * mw.width + (((x % mw.width) + mw.width) % mw.width)];
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty)
         + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** Point on the ecliptic (J2000) at longitude t. */
function eclipticPoint(t) {
    const eps = 23.4392911 * D2R, l = t * D2R;
    return vecToRaDec([Math.cos(l), Math.sin(l) * Math.cos(eps), Math.sin(l) * Math.sin(eps)]);
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
