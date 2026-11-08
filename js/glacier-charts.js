/**
 * glacier-charts.js — the small canvas chart kit Glacier Watch draws with.
 *
 * One rule set (the dataviz skill's): ONE y-axis per panel — two measures of
 * different scale are stacked PANELS sharing the x-axis (small multiples), never
 * a dual axis; 2 px lines, ≥ 8 px markers, recessive grid; text in ink colours,
 * never in a series colour; every chart has a hover layer (nearest mark, or a
 * crosshair snapped to the nearest x for line-only panels).
 *
 * spec = {
 *   x: { min, max, type: 'time'|'linear', label?, fmt? },
 *   panels: [{ weight?, y: { min, max, label?, fmt?, zero? }, layers: [...] }],
 *   height?: px
 * }
 * layers:
 *   { type:'line',   pts:[[x,y|null],…], color, width?, dash?, alpha?, tip? (x,y)=>string, endLabel? (y)=>string }
 *     endLabel: a DIRECT label at the line's last finite point (in ink, beside a colour swatch —
 *     text never wears the series colour); the chart reserves right margin when any line has one.
 *   { type:'area',   pts:[[x,y],…], color, alpha?, base? }
 *   { type:'band',   lo:[[x,y]…], hi:[[x,y]…], color, alpha? }
 *   { type:'points', pts:[{ x, y, e?, shape?:'circle'|'square'|'triangle', color, hollow?, tip? }], size? }
 *   { type:'bars',   pts:[{ x, y, color, tip? }], width? (x units) }
 *   { type:'vline',  x, label?, color? }
 *   { type:'hline',  y, color?, dash? }
 */

const INK = '#e3eaf6', INK2 = '#b4c0d6', INK3 = '#8d9ab2', GRID = 'rgba(140,190,255,.07)', AXIS = 'rgba(140,190,255,.28)', SURFACE = '#0b1120';
const FONT = '12px system-ui, sans-serif', FONT_B = '600 12px system-ui, sans-serif';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function niceTicks(min, max, n = 5) {
    if (!(max > min)) return [min];
    const step0 = (max - min) / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9 * step; v += step) out.push(+v.toFixed(10));
    return out;
}

export function timeTicks(min, max) {
    const span = (max - min) / 864e5, out = [];
    if (span > 3 * 365) {
        const y0 = new Date(min).getUTCFullYear(), y1 = new Date(max).getUTCFullYear();
        const every = span > 25 * 365 ? 10 : span > 10 * 365 ? 5 : span > 5 * 365 ? 2 : 1;
        for (let y = Math.ceil(y0 / every) * every; y <= y1; y += every) out.push({ t: Date.UTC(y, 0, 1), label: String(y) });
    } else {
        const d = new Date(min);
        let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
        const every = span > 500 ? 3 : span > 200 ? 2 : 1;
        for (; Date.UTC(y, m, 1) <= max; m++) {
            if (m > 11) { y++; m = 0; }
            const t = Date.UTC(y, m, 1);
            if (t > max) break;
            if (m % every === 0) out.push({ t, label: m === 0 ? String(y) : MONTHS[m] });
        }
    }
    return out;
}

export const fmtNum = (v) => (Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : Math.abs(v) >= 1000 ? `${(v / 1e3).toFixed(1)}k` : Math.abs(v) < 10 && v !== 0 ? v.toFixed(1) : v.toFixed(0));
export const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

export function mountChart(container, { height = 240, ariaLabel = '' } = {}) {
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    if (ariaLabel) canvas.setAttribute('aria-label', ariaLabel);
    const tip = document.createElement('div');
    tip.className = 'gw-tip';
    container.append(canvas, tip);
    let spec = null, geo = null;
    const chart = { canvas, render, destroy, get spec() { return spec; } };

    function size() {
        const w = Math.max(240, container.clientWidth);
        const h = spec?.height ?? height;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.style.height = h + 'px';
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        return { w, h, dpr };
    }

    function render(next) {
        spec = next;
        if (!spec) { canvas.style.height = '0px'; canvas.width = canvas.height = 0; tip.style.display = 'none'; geo = null; return; }
        if (spec?.ariaLabel) canvas.setAttribute('aria-label', spec.ariaLabel);
        draw();
    }

    function draw() {
        if (!spec) return;
        const { w, h, dpr } = size();
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const hasEnd = spec.panels.some(p => p.layers.some(l => l.endLabel));
        const L = 54, R = hasEnd ? 92 : 16, T = 4, B = 26, GAP = 14, HEAD = 20;      // HEAD: each panel's title row ABOVE its plot
        const total = spec.panels.reduce((a, p) => a + (p.weight ?? 1), 0);
        const innerH = h - T - B - GAP * (spec.panels.length - 1) - HEAD * spec.panels.length;
        const X = spec.x;
        const sx = (x) => L + (x - X.min) / (X.max - X.min) * (w - L - R);
        let top = T;
        const panels = spec.panels.map(p => {
            const ph = innerH * (p.weight ?? 1) / total;
            const geoP = { head: top, top: top + HEAD, bottom: top + HEAD + ph, p };
            geoP.sy = (y) => geoP.bottom - (y - p.y.min) / (p.y.max - p.y.min) * ph;
            top += HEAD + ph + GAP;
            return geoP;
        });
        geo = { sx, panels, L, R, w, h };
        ctx.font = FONT;
        // x grid + labels (bottom panel only); ticks thinned so labels never collide (≥ 64 px apart)
        let xt = X.type === 'time' ? timeTicks(X.min, X.max) : niceTicks(X.min, X.max, Math.max(3, Math.floor((w - L - R) / 90))).map(v => ({ t: v, label: (X.fmt || fmtNum)(v) }));
        if (xt.length > 1) { const every = Math.ceil(64 / Math.max(1, (sx(xt[1].t) - sx(xt[0].t)))); if (every > 1) xt = xt.filter((_, i) => i % every === 0); }
        for (const g of panels) {
            ctx.strokeStyle = GRID; ctx.lineWidth = 1;
            for (const tk of xt) { const x = Math.round(sx(tk.t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke(); }
            const yt = niceTicks(g.p.y.min, g.p.y.max, Math.max(2, Math.round((g.bottom - g.top) / 40)));
            ctx.fillStyle = INK3; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            for (const v of yt) {
                const y = Math.round(g.sy(v)) + 0.5;
                ctx.strokeStyle = v === 0 ? AXIS : GRID;
                ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
                ctx.fillText((g.p.y.fmt || fmtNum)(v), L - 6, y);
            }
            if (g.p.y.label) {
                ctx.save(); ctx.font = FONT_B; ctx.fillStyle = INK2; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(g.p.y.label, L, g.head + 10); ctx.restore();
            }
            ctx.save();
            ctx.beginPath(); ctx.rect(L, g.top - 6, w - L - R, g.bottom - g.top + 12); ctx.clip();
            for (const layer of g.p.layers) drawLayer(ctx, layer, sx, g.sy, g);
            ctx.restore();
            // direct end labels (ink text + a colour swatch), de-overlapped vertically
            const ends = [];
            for (const ly of g.p.layers) if (ly.type === 'line' && ly.endLabel) {
                const last = [...ly.pts].reverse().find(p => Number.isFinite(p[1]));
                if (last) ends.push({ y: Math.max(g.top + 6, Math.min(g.bottom - 6, g.sy(last[1]))), x: sx(last[0]), text: ly.endLabel(last[1]), color: ly.color });
            }
            ends.sort((a, b) => a.y - b.y);
            for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
            ctx.font = FONT_B; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            for (const e of ends) {
                ctx.fillStyle = e.color; ctx.fillRect(w - R + 6, e.y - 1.5, 10, 3);
                ctx.fillStyle = INK; ctx.fillText(e.text, w - R + 18, e.y);
            }
            ctx.font = FONT;
        }
        const last = panels[panels.length - 1];
        ctx.fillStyle = INK2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const tk of xt) ctx.fillText(tk.label, sx(tk.t), last.bottom + 7);
        if (X.label) { ctx.textAlign = 'right'; ctx.fillText(X.label, w - R, last.bottom + 6); }
    }

    function drawLayer(ctx, ly, sx, sy, g) {
        const a = ly.alpha ?? 1;
        ctx.globalAlpha = a;
        if (ly.type === 'line' || ly.type === 'area') {
            ctx.strokeStyle = ly.color; ctx.lineWidth = ly.width ?? 2; ctx.setLineDash(ly.dash || []);
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            let open = false;
            ctx.beginPath();
            for (const [x, y] of ly.pts) {
                if (y === null || !Number.isFinite(y)) { open = false; continue; }
                if (!open) { ctx.moveTo(sx(x), sy(y)); open = true; } else ctx.lineTo(sx(x), sy(y));
            }
            if (ly.type === 'area') {
                const pts = ly.pts.filter(p => Number.isFinite(p[1]));
                if (pts.length) {
                    ctx.lineTo(sx(pts.at(-1)[0]), sy(ly.base ?? g.p.y.min)); ctx.lineTo(sx(pts[0][0]), sy(ly.base ?? g.p.y.min)); ctx.closePath();
                    ctx.fillStyle = ly.color; ctx.globalAlpha = ly.fillAlpha ?? 0.18; ctx.fill(); ctx.globalAlpha = a;
                }
            } else ctx.stroke();
            ctx.setLineDash([]);
        } else if (ly.type === 'band') {
            const lo = ly.lo.filter(p => Number.isFinite(p[1])), hi = ly.hi.filter(p => Number.isFinite(p[1]));
            if (lo.length && hi.length) {
                ctx.beginPath();
                hi.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
                for (let i = lo.length - 1; i >= 0; i--) ctx.lineTo(sx(lo[i][0]), sy(lo[i][1]));
                ctx.closePath(); ctx.fillStyle = ly.color; ctx.globalAlpha = ly.alpha ?? 0.16; ctx.fill();
            }
        } else if (ly.type === 'points') {
            const r = (ly.size ?? 8) / 2;
            for (const p of ly.pts) {
                if (!Number.isFinite(p.y)) continue;
                const x = sx(p.x), y = sy(p.y);
                if (Number.isFinite(p.e) && p.e > 0) {
                    ctx.strokeStyle = p.color; ctx.globalAlpha = 0.45 * a; ctx.lineWidth = 1.5;
                    const y0 = sy(p.y - p.e), y1 = sy(p.y + p.e);
                    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.moveTo(x - 2.5, y0); ctx.lineTo(x + 2.5, y0); ctx.moveTo(x - 2.5, y1); ctx.lineTo(x + 2.5, y1); ctx.stroke();
                    ctx.globalAlpha = a;
                }
                ctx.beginPath();
                if (p.shape === 'square') ctx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
                else if (p.shape === 'triangle') { ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r, y + r * 0.75); ctx.lineTo(x - r, y + r * 0.75); ctx.closePath(); }
                else ctx.arc(x, y, r, 0, 2 * Math.PI);
                ctx.lineWidth = 2; ctx.strokeStyle = SURFACE; ctx.stroke();                     // 2 px surface ring on overlaps
                if (p.hollow) { ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.stroke(); }
                else { ctx.fillStyle = p.color; ctx.fill(); }
            }
        } else if (ly.type === 'bars') {
            const bw = Math.max(2, Math.abs(sx(ly.width ?? 1) - sx(0)) - 2);
            for (const p of ly.pts) {
                if (!Number.isFinite(p.y)) continue;
                const x = sx(p.x) - bw / 2, y0 = sy(0), y1 = sy(p.y);
                ctx.fillStyle = p.color;
                ctx.beginPath();
                const top = Math.min(y0, y1), hgt = Math.max(1, Math.abs(y1 - y0)), rad = Math.min(4, bw / 2, hgt);
                if (ctx.roundRect) ctx.roundRect(x, top, bw, hgt, p.y >= 0 ? [rad, rad, 0, 0] : [0, 0, rad, rad]); else ctx.rect(x, top, bw, hgt);
                ctx.fill();
            }
        } else if (ly.type === 'vline') {
            const x = Math.round(sx(ly.x)) + 0.5;
            ctx.strokeStyle = ly.color || INK3; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke(); ctx.setLineDash([]);
            if (ly.label) { ctx.font = FONT; ctx.fillStyle = INK2; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(ly.label, x + 4, g.top + 4); }
        } else if (ly.type === 'hline') {
            const y = Math.round(sy(ly.y)) + 0.5;
            ctx.strokeStyle = ly.color || AXIS; ctx.setLineDash(ly.dash || []); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(geo.L, y); ctx.lineTo(geo.w - geo.R, y); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
    }

    function hit(mx, my) {
        if (!geo || !spec) return null;
        const g = geo.panels.find(q => my >= q.head && my <= q.bottom + 6) || null;
        if (!g) return null;
        let best = null, bd = 18 * 18;                                       // hit target bigger than the mark
        for (const ly of g.p.layers) {
            if ((ly.type === 'points' || ly.type === 'bars') && ly.pts) for (const p of ly.pts) {
                if (!p.tip || !Number.isFinite(p.y)) continue;
                const dx = geo.sx(p.x) - mx, dy = ly.type === 'bars' ? 0 : g.sy(p.y) - my;
                const d = ly.type === 'bars' ? (Math.abs(dx) < 10 ? dx * dx : Infinity) : dx * dx + dy * dy;
                if (d < bd) { bd = d; best = { x: geo.sx(p.x), y: ly.type === 'bars' ? g.sy(p.y) : g.sy(p.y), html: p.tip() }; }
            }
        }
        if (best) return best;
        const lines = g.p.layers.filter(l => l.type === 'line' && l.tip);   // crosshair on line panels
        if (!lines.length) return null;
        const X = spec.x, xv = X.min + (mx - geo.L) / (geo.w - geo.L - geo.R) * (X.max - X.min);
        const rows = [];
        let snapX = null;
        for (const l of lines) {
            let q = null, qd = Infinity;
            for (const p of l.pts) if (Number.isFinite(p[1]) && Math.abs(p[0] - xv) < qd) { qd = Math.abs(p[0] - xv); q = p; }
            if (q && Math.abs(geo.sx(q[0]) - mx) < 30) { rows.push(l.tip(q[0], q[1])); snapX = geo.sx(q[0]); }
        }
        return rows.length ? { x: snapX, y: my, html: rows.join('<br>'), crosshair: { x: snapX, g } } : null;
    }

    function onMove(ev) {
        const r = canvas.getBoundingClientRect();
        const h = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (!h) { tip.style.display = 'none'; return; }
        tip.innerHTML = h.html;
        tip.style.display = 'block';
        const tw = tip.offsetWidth, cw = container.clientWidth;
        tip.style.left = Math.min(cw - tw - 4, Math.max(4, h.x + 12)) + 'px';
        tip.style.top = Math.max(0, h.y - 34) + 'px';
    }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(container);
    function destroy() { ro?.disconnect(); container.innerHTML = ''; }
    return chart;
}

/** Inclusive [min, max] of finite values with a relative pad; falls back to [0, 1]. */
export function extent(values, { pad = 0.08, zero = false } = {}) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) return [0, 1];
    if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi === lo) { hi += Math.abs(hi) * 0.1 || 1; lo -= Math.abs(lo) * 0.1 || 1; }
    const p = (hi - lo) * pad;
    return [zero && lo >= 0 ? 0 : lo - p, hi + p];
}
