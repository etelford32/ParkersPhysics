/**
 * glacier-flowmap.js — the flow map: the OBSERVED 2014–2024 mean surface-velocity field
 * of one glacier (ITS_LIVE, baked by scripts/build-glacier-velocity.py), with ice parcels
 * advected through it by js/glacier-engine.js `advect`.
 *
 * Computes nothing about glaciers: speed, advection and the north direction are engine
 * calls. The map is drawn in the field's own projected grid (UTM or polar stereographic,
 * square 120 m cells block-averaged) — a north arrow shows true north, which is not "up"
 * in a polar stereographic grid.
 *
 * THE ONE DISHONESTY, disclosed in the caption: TIME is compressed. A parcel moves at the
 * observed speed × a factor chosen so the fastest ice crosses ~1 px per frame; the caption
 * prints "1 s of animation ≈ N days". Relative speeds are exact; nothing is magnified in space.
 *
 * Performance: one offscreen raster (≤ 160² cells) drawn scaled; ≤ 1400 parcels; the loop
 * parks when the canvas is off screen (IntersectionObserver), the tab is hidden, the user
 * pauses, or prefers-reduced-motion is set.
 */
import { fieldSampler, advect, northInGrid } from './glacier-engine.js';

const RAMP = ['#0b1f3a', '#123a68', '#1d5f9a', '#2f8bd0', '#62b6ec', '#a9dcfa', '#eef9ff'];   // one hue, dark → light
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAMP_RGB = RAMP.map(hex);

export function rampColor(f) {
    const x = Math.max(0, Math.min(1, f)) * (RAMP_RGB.length - 1), i = Math.min(RAMP_RGB.length - 2, Math.floor(x)), t = x - i;
    const a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class FlowMap {
    constructor(canvas, { tip, onStats } = {}) {
        this.canvas = canvas; this.tip = tip; this.onStats = onStats;
        this.ctx = canvas.getContext('2d');
        this.running = true; this.visible = true;
        this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (this.reduced) this.running = false;
        this.parcels = []; this.frameMs = []; this.raf = 0;
        this._loop = this._loop.bind(this);
        new ResizeObserver(() => this._resize()).observe(canvas);
        if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver(es => { this.visible = es[0].isIntersecting; this._kick(); }).observe(canvas);
        document.addEventListener('visibilitychange', () => this._kick());
        canvas.addEventListener('pointermove', (e) => this._hover(e));
        canvas.addEventListener('pointerleave', () => { if (this.tip) this.tip.style.display = 'none'; });
    }

    setGlacier(glacier, detail, gauges) {
        this.g = glacier; this.det = detail; this.gauges = gauges;
        const f = detail.field;
        this.sample = fieldSampler(f);
        const sp = [];
        for (let k = 0; k < f.vx.length; k++) if (f.ice[k] >= 0.5 && Number.isFinite(f.vx[k])) sp.push(Math.hypot(f.vx[k], f.vy[k]));
        sp.sort((a, b) => a - b);
        this.vHi = sp.length ? sp[Math.floor(0.995 * (sp.length - 1))] : 100;
        this.vLo = Math.max(1, sp.length ? sp[Math.floor(0.05 * (sp.length - 1))] : 1);
        this.v95 = sp.length ? sp[Math.floor(0.95 * (sp.length - 1))] : 50;
        this.north = northInGrid(glacier.flowline);
        this._raster();
        this._resize();
        this._seed();
        this._kick();
    }

    setRunning(on) { this.running = !!on && !this.reduced; this._kick(); }

    _raster() {
        const f = this.det.field, off = document.createElement('canvas');
        off.width = f.nx; off.height = f.ny;
        const img = off.getContext('2d').createImageData(f.nx, f.ny);
        const l0 = Math.log10(this.vLo), l1 = Math.log10(Math.max(this.vHi, this.vLo * 1.5));
        for (let i = 0; i < f.ny; i++) for (let j = 0; j < f.nx; j++) {
            const k = i * f.nx + j, o = 4 * k;
            const ice = f.ice[k];
            if (Number.isFinite(f.vx[k]) && ice >= 0.5) {
                const [r, g, b] = rampColor((Math.log10(Math.max(1, Math.hypot(f.vx[k], f.vy[k]))) - l0) / (l1 - l0));
                img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
            } else { img.data[o] = 18; img.data[o + 1] = 22; img.data[o + 2] = 30; img.data[o + 3] = 255; }      // off-ice: neutral ground
        }
        off.getContext('2d').putImageData(img, 0, 0);
        this.off = off;
    }

    _resize() {
        if (!this.det) return;
        const r = this.canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
        this.canvas.width = Math.max(10, Math.round(r.width * dpr)); this.canvas.height = Math.max(10, Math.round(r.height * dpr));
        this.dpr = dpr; this.cw = r.width; this.ch = r.height;
        const f = this.det.field;
        // NORTH-UP: rotate the grid so true north (engine northInGrid) points up the screen. In a
        // polar stereographic grid (Greenland, Alaska in EPSG:3413) grid north can be ~100° off.
        const a = Math.atan2(this.north[1] / f.dy, this.north[0] / f.dx);      // north in un-rotated pixel space
        const rot = -Math.PI / 2 - a, c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot));
        const s = Math.min(r.width / (f.nx * c + f.ny * sn), r.height / (f.nx * sn + f.ny * c));
        this.view = { s, rot, cos: Math.cos(rot), sin: Math.sin(rot), cx: r.width / 2, cy: r.height / 2 };
        // time compression: the 95th-percentile speed crosses ~0.9 px per frame (60 fps)
        const mPerPx = Math.abs(f.dx) / s;
        this.dtYears = 0.9 * mPerPx / Math.max(1, this.v95);
        this.daysPerSecond = this.dtYears * 60 * 365.25;
        this.trail = document.createElement('canvas');
        this.trail.width = this.canvas.width; this.trail.height = this.canvas.height;
        this.onStats?.({ daysPerSecond: this.daysPerSecond, vLo: this.vLo, vHi: this.vHi });
        this._drawStatic();
    }

    toPx(x, y) {
        const f = this.det.field, v = this.view;
        const u = ((x - f.x0) / f.dx + 0.5 - f.nx / 2) * v.s, w = ((y - f.y0) / f.dy + 0.5 - f.ny / 2) * v.s;
        return [v.cx + u * v.cos - w * v.sin, v.cy + u * v.sin + w * v.cos];
    }
    toMap(px, py) {
        const f = this.det.field, v = this.view, dx = px - v.cx, dy = py - v.cy;
        const u = dx * v.cos + dy * v.sin, w = -dx * v.sin + dy * v.cos;
        return [f.x0 + (u / v.s + f.nx / 2 - 0.5) * f.dx, f.y0 + (w / v.s + f.ny / 2 - 0.5) * f.dy];
    }

    _seed() {
        const f = this.det.field, n = Math.min(1400, Math.max(300, Math.round(f.nx * f.ny * 0.12)));
        this.parcels = [];
        const ice = [];
        for (let k = 0; k < f.vx.length; k++) if (f.ice[k] >= 0.5 && Number.isFinite(f.vx[k])) ice.push(k);
        this.iceCells = ice;
        for (let i = 0; i < n; i++) this.parcels.push(this._spawn(Math.random() * 120));
    }

    _spawn(age = 0) {
        const f = this.det.field, k = this.iceCells[(Math.random() * this.iceCells.length) | 0] ?? 0;
        const i = Math.floor(k / f.nx), j = k % f.nx;
        return { x: f.x0 + (j + Math.random() - 0.5) * f.dx, y: f.y0 + (i + Math.random() - 0.5) * f.dy, age, life: 90 + Math.random() * 160 };
    }

    _drawStatic() {
        const ctx = this.ctx, v = this.view, dpr = this.dpr, f = this.det.field;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#050a14'; ctx.fillRect(0, 0, this.cw, this.ch);
        ctx.imageSmoothingEnabled = true;
        ctx.translate(v.cx, v.cy); ctx.rotate(v.rot);
        ctx.drawImage(this.off, -f.nx * v.s / 2, -f.ny * v.s / 2, f.nx * v.s, f.ny * v.s);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.base = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        this._overlay();
    }

    _overlay() {
        const ctx = this.ctx, fl = this.g.flowline;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.setLineDash([6, 4]);
        ctx.beginPath();
        fl.x.forEach((x, k) => { const [px, py] = this.toPx(x, fl.y[k]); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.stroke(); ctx.setLineDash([]);
        ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const gg of this.gauges || []) {
            if (gg.id === 'fastest') continue;
            const [px, py] = this.toPx(fl.x[gg.idx], fl.y[gg.idx]);
            ctx.beginPath(); ctx.arc(px, py, 9, 0, 2 * Math.PI); ctx.fillStyle = gg.selected ? '#f2b84b' : '#0b1120'; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#f2b84b'; ctx.stroke();
            ctx.fillStyle = gg.selected ? '#0b1120' : '#f2b84b'; ctx.fillText(gg.id[0].toUpperCase(), px, py + 0.5);
        }
        // north arrow (true north in the grid)
        const fld = this.det.field, cxm = fld.x0 + fld.nx * fld.dx / 2, cym = fld.y0 + fld.ny * fld.dy / 2;
        const [a0, b0] = this.toPx(cxm, cym), [a1, b1] = this.toPx(cxm + this.north[0] * 1000, cym + this.north[1] * 1000);
        const nl = Math.hypot(a1 - a0, b1 - b0) || 1, ux = (a1 - a0) / nl, uy = (b1 - b0) / nl, cx = this.cw - 28, cy = this.ch - 34;
        ctx.strokeStyle = '#e3eaf6'; ctx.fillStyle = '#e3eaf6'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - ux * 12, cy - uy * 12); ctx.lineTo(cx + ux * 12, cy + uy * 12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + ux * 16, cy + uy * 16); ctx.lineTo(cx + ux * 8 - uy * 5, cy + uy * 8 + ux * 5); ctx.lineTo(cx + ux * 8 + uy * 5, cy + uy * 8 - ux * 5); ctx.closePath(); ctx.fill();
        ctx.fillText('N', cx + ux * 25, cy + uy * 25);
        // scale bar
        const f = this.det.field, mPerPx = Math.abs(f.dx) / this.view.s;
        const target = mPerPx * 100, nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].find(v => v >= target * 0.6) || 20000;
        const len = nice / mPerPx, bx = this.cw - 22 - len, by = 18;
        ctx.fillStyle = 'rgba(4,8,16,.7)'; ctx.fillRect(bx - 8, by - 12, len + 16, 26);
        ctx.strokeStyle = '#e3eaf6'; ctx.beginPath(); ctx.moveTo(bx, by + 6); ctx.lineTo(bx + len, by + 6); ctx.stroke();
        ctx.fillStyle = '#e3eaf6'; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + len / 2, by - 3);
    }

    _kick() {
        const want = this.running && this.visible && !document.hidden && !!this.det;
        if (want && !this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this._loop); }
        if (!want && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
        if (!want && this.det && this.base) { this.ctx.putImageData(this.base, 0, 0); this._drawParcelsStill(); this._overlay(); }
    }

    _drawParcelsStill() {
        const ctx = this.ctx; ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        for (const p of this.parcels) { const [px, py] = this.toPx(p.x, p.y); ctx.fillRect(px - 0.8, py - 0.8, 1.6, 1.6); }
    }

    _loop(now) {
        this.raf = 0;
        const t0 = performance.now();
        const ctx = this.ctx, tctx = this.trail.getContext('2d'), dpr = this.dpr;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.globalCompositeOperation = 'destination-out'; tctx.fillStyle = 'rgba(0,0,0,0.08)'; tctx.fillRect(0, 0, this.trail.width, this.trail.height);
        tctx.globalCompositeOperation = 'source-over';
        tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        tctx.strokeStyle = 'rgba(255,255,255,0.85)'; tctx.lineWidth = 1.1;
        tctx.beginPath();
        for (let i = 0; i < this.parcels.length; i++) {
            let p = this.parcels[i];
            const nxt = advect(this.sample, p.x, p.y, this.dtYears);
            p.age++;
            if (!nxt || p.age > p.life) { this.parcels[i] = this._spawn(); continue; }
            const [a, b] = this.toPx(p.x, p.y), [c, d] = this.toPx(nxt[0], nxt[1]);
            tctx.moveTo(a, b); tctx.lineTo(c, d);
            p.x = nxt[0]; p.y = nxt[1];
        }
        tctx.stroke();
        ctx.putImageData(this.base, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.trail, 0, 0);
        this._overlay();
        this.frameMs.push(performance.now() - t0);
        if (this.frameMs.length > 120) this.frameMs.shift();
        this._kick();
    }

    /** Median per-frame CPU cost of the animation over the last ≤ 120 frames (ms) — the perf gate reads this. */
    frameCostMs() { const s = this.frameMs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; }

    _hover(e) {
        if (!this.det || !this.tip) return;
        const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        const [x, y] = this.toMap(px, py), v = this.sample(x, y);
        if (!v) { this.tip.style.display = 'none'; return; }
        const fl = this.g.flowline;
        let best = 0, bd = Infinity;
        fl.x.forEach((fx, k) => { const d = (fx - x) ** 2 + (fl.y[k] - y) ** 2; if (d < bd) { bd = d; best = k; } });
        const sp = Math.hypot(v[0], v[1]);
        this.tip.innerHTML = `<b>${sp >= 1000 ? (sp / 1000).toFixed(2) + ' km/yr' : sp.toFixed(0) + ' m/yr'}</b> · ${(sp / 365.25).toFixed(sp > 365 ? 1 : 2)} m/day` +
            (Math.sqrt(bd) < 1500 ? `<br><span style="color:#aab6cc">${(fl.s_m[best] / 1000).toFixed(1)} km down the flowline</span>` : '');
        this.tip.style.display = 'block';
        this.tip.style.left = Math.min(this.cw - this.tip.offsetWidth - 6, px + 12) + 'px';
        this.tip.style.top = Math.max(0, py - 30) + 'px';
    }
}
