/**
 * map.js — the flat (equirectangular) view of plate-tectonics.html (Canvas2D renderer only).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * Draws the SAME kernel numbers as globe.js: continents carried by rotations.js, boundaries from
 * frames.js boundariesAt, the 1° plate raster, velocity arrows from eulerVector. The frame is the
 * model's PALAEOMAGNETIC frame: latitude is constrained by palaeomagnetism, longitude is not
 * (before ~200 Ma it is a modelling choice) — the page says so beside the map.
 *
 * Antimeridian: every ring and line is UNWRAPPED (longitudes made continuous) and drawn at
 * −360°, 0 and +360° inside a clip, so a polygon that crosses 180° is filled whole. A ring that
 * winds round a pole (net Δλ = ±360°) is closed along the map's top or bottom edge.
 */
import { frameIndexAt, shapesAt, boundariesAt } from './frames.js';
import { BOUNDARY_COLORS, plateTint } from './globe.js';
import { velocityFromEuler } from './rotations.js';

const DEG = 180 / Math.PI;
const toLL = (x, y, z) => [Math.asin(Math.max(-1, Math.min(1, z))) * DEG, Math.atan2(y, x) * DEG];

function unwrap(xyz) {
    const out = [];
    let prev = null, off = 0;
    for (let j = 0; j < xyz.length; j += 3) {
        const [lat, lon0] = toLL(xyz[j], xyz[j + 1], xyz[j + 2]);
        let lon = lon0 + off;
        if (prev != null) {
            while (lon - prev > 180) { lon -= 360; off -= 360; }
            while (lon - prev < -180) { lon += 360; off += 360; }
        }
        out.push([lat, lon]); prev = lon;
    }
    return out;
}

export class PlateMap {
    constructor(canvas, { model, fr, shapes }) {
        this.canvas = canvas; this.model = model; this.fr = fr; this.shapes = shapes;
        this.ctx = canvas.getContext('2d');
        this.layers = { boundaries: true, velocities: true, coasts: true, tint: true, graticule: true };
        this.t = 0; this.onPick = null; this.onHover = null;
        this.raster = document.createElement('canvas'); this.raster.width = 360; this.raster.height = 180;
        this._frameIdx = -1;
        new ResizeObserver(() => this.draw()).observe(canvas);
        const ll = (ev) => {
            const r = canvas.getBoundingClientRect(), b = this._box;
            if (!b) return null;
            const px = ev.clientX - r.left, py = ev.clientY - r.top;
            if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) return null;
            return { lat: 90 - ((py - b.y) / b.h) * 180, lon: ((px - b.x) / b.w) * 360 - 180 };
        };
        let down = null, last = 0;
        canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp }; });
        canvas.addEventListener('pointerup', (ev) => {
            if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 6 && ev.timeStamp - down.t < 600) { const h = ll(ev); if (h && this.onPick) this.onPick(h); }
            down = null;
        });
        canvas.addEventListener('pointermove', (ev) => { if (ev.timeStamp - last < 50) return; last = ev.timeStamp; if (this.onHover) this.onHover(ll(ev)); });
        canvas.addEventListener('pointerleave', () => this.onHover && this.onHover(null));
    }
    setLayer(name, on) { this.layers[name] = on; this.draw(); }
    setTime(t) { this.t = t; this.draw(); }

    _paintRaster(frame) {
        const g = this.raster.getContext('2d'), img = g.createImageData(360, 180);
        const tints = frame.plates.map((p) => plateTint(p.p));
        for (let k = 0; k < frame.raster.length; k++) {
            const v = frame.raster[k], o = 4 * k;
            if (v === 255) {
                const stripe = ((k % 360) + Math.floor(k / 360)) % 6 < 3;
                img.data.set(stripe ? [76, 36, 38, 255] : [41, 20, 23, 255], o);
            } else {
                const c = tints[v];
                const base = [9, 19, 36];
                const m = this.layers.tint ? 0.55 : 0;
                img.data.set([base[0] + (c[0] * 255 - base[0]) * m, base[1] + (c[1] * 255 - base[1]) * m, base[2] + (c[2] * 255 - base[2]) * m, 255], o);
            }
        }
        g.putImageData(img, 0, 0);
    }

    draw() {
        const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cw = c.clientWidth || 1, ch = c.clientHeight || 1;
        if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#04070d'; ctx.fillRect(0, 0, cw, ch);
        // 2:1 box, centred.
        let w = cw - 24, h = w / 2;
        if (h > ch - 24) { h = ch - 24; w = 2 * h; }
        const b = this._box = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
        const X = (lon) => b.x + ((lon + 180) / 360) * b.w, Y = (lat) => b.y + ((90 - lat) / 180) * b.h;
        const { model, fr, t } = this;
        const fi = frameIndexAt(fr, t);
        this._paintRaster(fr.frames[fi]); this._frameIdx = fi;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.raster, b.x, b.y, b.w, b.h);
        ctx.save();
        ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
        const tripled = (fn) => { for (const o of [-360, 0, 360]) fn(o); };

        if (this.layers.graticule) {
            ctx.lineWidth = 1;
            for (let lat = -60; lat <= 60; lat += 30) { ctx.strokeStyle = lat === 0 ? 'rgba(140,158,189,.7)' : 'rgba(66,79,102,.55)'; ctx.beginPath(); ctx.moveTo(b.x, Y(lat)); ctx.lineTo(b.x + b.w, Y(lat)); ctx.stroke(); }
            ctx.strokeStyle = 'rgba(46,56,74,.5)';
            for (let lon = -150; lon < 180; lon += 30) { ctx.beginPath(); ctx.moveTo(X(lon), b.y); ctx.lineTo(X(lon), b.y + b.h); ctx.stroke(); }
        }
        // Continental crust (incl. shelves), then today's land on top — FILLED, never outlined (the
        // coast file splits land along every terrane boundary; outlines drew all of them).
        const fillRings = (list, color) => {
            // A hairline stroke in the fill colour seals the anti-aliasing seams between neighbours.
            ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 0.6;
            for (const p of shapesAt(model, list, t)) {
                const u = unwrap(p.xyz);
                if (u.length < 3) continue;
                const net = u[u.length - 1][1] - u[0][1];
                tripled((o) => {
                    ctx.beginPath();
                    u.forEach(([la, lo], i) => (i ? ctx.lineTo(X(lo + o), Y(la)) : ctx.moveTo(X(lo + o), Y(la))));
                    if (Math.abs(net) > 180) {               // winds round a pole: close along the map edge
                        const poleLat = u.reduce((s, q) => s + q[0], 0) / u.length > 0 ? 90 : -90;
                        ctx.lineTo(X(u[u.length - 1][1] + o), Y(poleLat)); ctx.lineTo(X(u[0][1] + o), Y(poleLat));
                    }
                    ctx.closePath(); ctx.fill(); ctx.stroke();
                });
            }
        };
        fillRings(this.shapes.continents, '#5e5543');
        if (this.layers.coasts) fillRings(this.shapes.coasts, '#a99472');
        if (this.layers.boundaries) {
            const { segs } = boundariesAt(model, fr, t);
            for (const s of segs) {
                const key = BOUNDARY_COLORS[s.type] ? s.type : 'other';
                ctx.strokeStyle = BOUNDARY_COLORS[key]; ctx.globalAlpha = key === 'other' ? 0.6 : 1;
                ctx.lineWidth = key === 'other' ? 1 : 1.8;
                const u = unwrap(s.xyz);
                tripled((o) => { ctx.beginPath(); u.forEach(([la, lo], i) => (i ? ctx.lineTo(X(lo + o), Y(la)) : ctx.moveTo(X(lo + o), Y(la)))); ctx.stroke(); });
            }
            ctx.globalAlpha = 1;
        }
        if (this.layers.velocities) {
            const frame = fr.frames[fi], W = new Map(), d = fr.rasterDeg;
            ctx.strokeStyle = 'rgba(236,240,247,.85)'; ctx.lineWidth = 1;
            for (let lat = -75; lat <= 75; lat += 15) for (let lon = -172.5; lon < 180; lon += 15) {
                const k = frame.raster[Math.floor((90 - lat) / d) * (360 / d) + Math.floor((lon + 180) / d)];
                if (k === 255) continue;
                const pid = frame.plates[k].p;
                if (!W.has(pid)) W.set(pid, model.eulerVector(pid, t));
                const w = W.get(pid);
                if (!Number.isFinite(w[0])) continue;
                const v = velocityFromEuler(w, lat, lon);
                if (v.speed < 1) continue;
                const L = Math.min(5.5, v.speed * 0.045);
                const ex = v.east / v.speed, ny = v.north / v.speed;
                const x0 = X(lon), y0 = Y(lat), x1 = x0 + (ex * L / 360) * b.w / Math.max(0.2, Math.cos(lat * Math.PI / 180)), y1 = y0 - (ny * L / 180) * b.h;
                ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
                const a = Math.atan2(y1 - y0, x1 - x0);
                ctx.moveTo(x1, y1); ctx.lineTo(x1 - 4 * Math.cos(a - 0.5), y1 - 4 * Math.sin(a - 0.5));
                ctx.moveTo(x1, y1); ctx.lineTo(x1 - 4 * Math.cos(a + 0.5), y1 - 4 * Math.sin(a + 0.5));
                ctx.stroke();
            }
        }
        ctx.restore();
        ctx.strokeStyle = '#22304a'; ctx.lineWidth = 1; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        if (this.marker) {
            ctx.strokeStyle = '#f0efec'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(X(this.marker.lon), Y(this.marker.lat), 6, 0, 2 * Math.PI); ctx.stroke();
        }
    }
    setMarker(m) { this.marker = m; this.draw(); }
}
