/**
 * star-collider/charts.js — 2D canvas charts for the Star Collider Lab
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure drawing: every function takes a canvas and plain data and paints it.
 * No physics, no DOM lookups beyond the canvas handed in. One small plotting
 * helper (`plot`) owns axes, scales and the frame so the five charts read as
 * one instrument.
 *
 *   drawMassRadius   M–R diagram: every EOS faint, the active one bright, the
 *                    catalog's measured stars with their error bars, and the
 *                    two bodies in the collider.
 *   drawWaveform     h₊(t) over the dense tail of the PN inspiral, with the
 *                    SPH stage's quadrupole strain overlaid when running.
 *   drawFrequencyTrack  f_GW against time before merger (log–log) with the
 *                    ground-detector band.
 *   drawKilonova     bolometric light curve, blue/red/total, log L vs t.
 *   drawEnergy       the SPH run's energy ledger against sim time.
 */

const FONT = '11px "Segoe UI", system-ui, sans-serif';
const C = {
    bg: '#06071a', grid: 'rgba(120,140,190,0.14)', axis: 'rgba(160,180,220,0.55)', text: '#9fb0cc',
    accent: '#5ee1ff', amber: '#ffb066', red: '#ff6b7a', blue: '#7aa5ff', green: '#7dffb0', magenta: '#f08cff', dim: 'rgba(160,180,220,0.35)',
};

function prep(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    return { ctx, w, h };
}

/** Axis + scale helper. `x`/`y` are {min, max, log?, label}. */
function plot(canvas, x, y, pad = { l: 46, r: 12, t: 12, b: 28 }) {
    const { ctx, w, h } = prep(canvas);
    for (const a of [x, y]) {
        if (!Number.isFinite(a.min)) a.min = a.log ? 1 : 0;
        if (!Number.isFinite(a.max) || !(a.max > a.min)) a.max = a.log ? a.min * 10 : a.min + 1;
        if (a.log && !(a.min > 0)) a.min = 1e-30;
    }
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const sx = x.log ? (v) => pad.l + (Math.log10(v) - Math.log10(x.min)) / (Math.log10(x.max) - Math.log10(x.min)) * pw
        : (v) => pad.l + (v - x.min) / (x.max - x.min) * pw;
    const sy = y.log ? (v) => pad.t + ph - (Math.log10(v) - Math.log10(y.min)) / (Math.log10(y.max) - Math.log10(y.min)) * ph
        : (v) => pad.t + ph - (v - y.min) / (y.max - y.min) * ph;
    // grid
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const ticks = (a) => {
        if (a.log) {
            const out = [];
            for (let e = Math.ceil(Math.log10(a.min)); e <= Math.floor(Math.log10(a.max)); e++) out.push(10 ** e);
            return out;
        }
        // The end tolerance must be RELATIVE to the step: a strain axis spans
        // 10⁻²² and an absolute 1e-9 slack ran the loop 10¹³ times ("Invalid
        // array length" on first paint). Capped at 40 ticks regardless.
        const span = a.max - a.min;
        if (!(span > 0) || !Number.isFinite(span)) return [a.min];
        const step = niceStep(span / 5), out = [];
        for (let v = Math.ceil(a.min / step) * step; v <= a.max + step * 1e-6 && out.length < 40; v += step) out.push(+v.toPrecision(6));
        return out;
    };
    ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of ticks(x)) {
        const px = sx(v); ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, pad.t + ph); ctx.stroke();
        ctx.fillText(fmtTick(v, x.log), px, pad.t + ph + 4);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of ticks(y)) {
        const py = sy(v); ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(pad.l + pw, py); ctx.stroke();
        ctx.fillText(fmtTick(v, y.log), pad.l - 4, py);
    }
    ctx.strokeStyle = C.axis; ctx.strokeRect(pad.l, pad.t, pw, ph);
    if (x.label) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = C.dim; ctx.fillText(x.label, pad.l + pw, pad.t + ph - 3); }
    if (y.label) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = C.dim; ctx.fillText(y.label, pad.l + 4, pad.t + 3); }
    ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    const line = (pts, color, width = 1.5, dash = null) => {
        if (!pts.length) return;
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
        ctx.beginPath(); let started = false;
        for (const p of pts) {
            if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || (x.log && p[0] <= 0) || (y.log && p[1] <= 0)) { started = false; continue; }
            const px = sx(p[0]), py = sy(p[1]);
            if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke(); ctx.setLineDash([]);
    };
    const dot = (px, py, color, r = 3) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx(px), sy(py), r, 0, Math.PI * 2); ctx.fill(); };
    const text = (px, py, str, color = C.text, align = 'left', dy = 0) => { ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(str, sx(px), sy(py) + dy); };
    const band = (x0, x1, color) => { ctx.fillStyle = color; const a = sx(x0), b = sx(x1); ctx.fillRect(Math.min(a, b), pad.t, Math.abs(b - a), ph); };
    const hband = (y0, y1, color) => { ctx.fillStyle = color; const a = sy(y0), b = sy(y1); ctx.fillRect(pad.l, Math.min(a, b), pw, Math.abs(b - a)); };
    const done = () => ctx.restore();
    return { ctx, sx, sy, line, dot, text, band, hband, done, w, h, pad, pw, ph };
}

function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function fmtTick(v, log) {
    if (log) { const e = Math.round(Math.log10(v)); return e >= -2 && e <= 3 ? String(v) : `1e${e}`; }
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000 || a < 0.01) return v.toExponential(0);
    return String(+v.toPrecision(3));
}

// ── Charts ──────────────────────────────────────────────────────────────────

/**
 * @param curves  [{id, points:[{rKm, M, stable}], active}]
 * @param objects [{name, rKm, M, plus, minus, sigma}] measured stars (NS only)
 * @param bodies  [{name, rKm, M, kind}]
 * @param bands   {mmaxObserved: 2.08}
 */
export function drawMassRadius(canvas, { curves = [], objects = [], bodies = [], bands = {} }) {
    const p = plot(canvas, { min: 8, max: 17, label: 'R  (km)' }, { min: 0.2, max: 3.0, label: 'M  (M☉)' });
    // GR forbidden region R < 2GM/c² (and Buchdahl 9/4): shade R < 2.25 × 1.4766 M
    const buch = [];
    for (let m = 0.2; m <= 3.0; m += 0.05) buch.push([2.25 * 1.4766 * m, m]);
    p.ctx.fillStyle = 'rgba(255,107,122,0.10)';
    p.ctx.beginPath(); p.ctx.moveTo(p.sx(8), p.sy(0.2));
    for (const b of buch) p.ctx.lineTo(p.sx(b[0]), p.sy(b[1]));
    p.ctx.lineTo(p.sx(8), p.sy(3.0)); p.ctx.closePath(); p.ctx.fill();
    p.line(buch, 'rgba(255,107,122,0.5)', 1, [4, 3]);
    p.text(8.2, 2.85, 'Buchdahl limit', 'rgba(255,107,122,0.7)');
    if (bands.mmaxObserved) {
        p.hband(bands.mmaxObserved - 0.07, bands.mmaxObserved + 0.07, 'rgba(94,225,255,0.08)');
        p.text(16.9, bands.mmaxObserved, 'J0740+6620', 'rgba(94,225,255,0.6)', 'right', -9);
    }
    for (const c of curves) {
        const stable = c.points.filter(q => q.stable).map(q => [q.rKm, q.M]);
        const unstable = c.points.filter(q => !q.stable).map(q => [q.rKm, q.M]);
        p.line(stable, c.active ? C.accent : 'rgba(120,140,190,0.35)', c.active ? 2.2 : 1);
        p.line(unstable, c.active ? 'rgba(94,225,255,0.45)' : 'rgba(120,140,190,0.18)', 1, [3, 3]);
        const top = c.points.reduce((a, q) => (q.M > a.M ? q : a), c.points[0]);
        if (top) p.text(top.rKm, top.M, c.id, c.active ? C.accent : 'rgba(120,140,190,0.6)', 'left', -8);
    }
    for (const o of objects) {
        p.ctx.strokeStyle = 'rgba(255,176,102,0.7)'; p.ctx.lineWidth = 1;
        p.ctx.beginPath(); p.ctx.moveTo(p.sx(o.rKm - (o.minus || 0)), p.sy(o.M)); p.ctx.lineTo(p.sx(o.rKm + (o.plus || 0)), p.sy(o.M)); p.ctx.stroke();
        if (o.sigma) { p.ctx.beginPath(); p.ctx.moveTo(p.sx(o.rKm), p.sy(o.M - o.sigma)); p.ctx.lineTo(p.sx(o.rKm), p.sy(o.M + o.sigma)); p.ctx.stroke(); }
        p.dot(o.rKm, o.M, C.amber, 3.5);
        p.text(o.rKm, o.M, o.name, 'rgba(255,176,102,0.9)', 'left', 10);
    }
    for (const b of bodies) {
        if (b.kind !== 'ns' || !Number.isFinite(b.rKm)) continue;
        p.dot(b.rKm, b.M, C.magenta, 5);
        p.text(b.rKm, b.M, b.name, C.magenta, 'left', -10);
    }
    p.done();
}

/**
 * @param tail {t[], hPlus[]}   seconds from tailStart, strain
 * @param sph  [{t, hp}]         seconds, strain (optional overlay)
 */
/** Vertical time cursor (the transport's review position) drawn over a finished plot. */
function drawCursor(p, t, x, label = 'cursor') {
    if (!Number.isFinite(t) || t < x.min || t > x.max) return;
    const { ctx } = p;
    const px = p.sx(t);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(px, p.pad.t); ctx.lineTo(px, p.pad.t + p.ph); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.textAlign = px > p.pad.l + p.pw * 0.8 ? 'right' : 'left'; ctx.textBaseline = 'top';
    ctx.fillText(label, px + (px > p.pad.l + p.pw * 0.8 ? -4 : 4), p.pad.t + 14);
    ctx.restore();
}

/** @param cursorT seconds (same axis as the series) — the review position; null/undefined draws none. */
export function drawWaveform(canvas, { tail, sph = null, label = '', cursorT = null }) {
    const hasTail = tail && tail.t.length > 1;
    const hasSph = sph && sph.length > 1;
    let hmax = 1e-23;
    if (hasTail) for (const v of tail.hPlus) hmax = Math.max(hmax, Math.abs(v));
    if (hasSph) for (const s of sph) hmax = Math.max(hmax, Math.abs(s.hp));
    const t0 = hasTail ? tail.t[0] : (hasSph ? sph[0].t : 0);
    const t1 = hasTail ? tail.t[tail.t.length - 1] : (hasSph ? sph[sph.length - 1].t : 1);
    const p = plot(canvas, { min: t0, max: Math.max(t1, t0 + 1e-6), label: 't  (s)' }, { min: -1.15 * hmax, max: 1.15 * hmax, label: 'h₊' });
    if (hasTail) p.line(tail.t.map((t, i) => [t, tail.hPlus[i]]), C.accent, 1.2);
    if (hasSph) p.line(sph.map(s => [s.t, s.hp]), C.amber, 1.4);
    if (label) p.text(t0, 1.0 * hmax, label, C.dim);
    if (hasSph && hasTail) p.text(t1, -1.0 * hmax, 'amber: SPH quadrupole · cyan: PN', C.dim, 'right');
    const xAxis = { min: t0, max: Math.max(t1, t0 + 1e-6) };
    if (hasSph && cursorT !== null) drawCursor(p, cursorT, xAxis, 'review');
    p.done();
}

/** @param track [{tS, fHz}] with tS measured from the start; tEnd = time to merger. */
export function drawFrequencyTrack(canvas, { track, timeToMergerS, fEndHz, endReason }) {
    if (!track || track.length < 2) { prep(canvas); return; }
    const pts = track.map(s => [Math.max(timeToMergerS - s.tS, 1e-4), s.fHz]).filter(q => q[0] > 0);
    const tmax = Math.max(...pts.map(q => q[0])), tmin = Math.min(...pts.map(q => q[0]));
    const p = plot(canvas, { min: Math.max(tmin, 1e-4), max: tmax * 1.2, log: true, label: 'time to merger  (s)' },
        { min: 5, max: Math.max(6000, fEndHz * 1.3), log: true, label: 'f_GW  (Hz)' });
    p.hband(10, 5000, 'rgba(94,225,255,0.06)');
    p.text(tmax, 20, 'LIGO/Virgo band', 'rgba(94,225,255,0.5)', 'right');
    p.line(pts, C.accent, 2);
    p.dot(pts[pts.length - 1][0], pts[pts.length - 1][1], C.amber, 4);
    p.text(pts[pts.length - 1][0], pts[pts.length - 1][1], endReason === 'contact' ? 'contact' : endReason === 'isco' ? 'ISCO' : endReason, C.amber, 'left', -10);
    p.done();
}

/** @param kn kilonova() result */
export function drawKilonova(canvas, kn, extraLabel = '') {
    if (!kn || !kn.visible || !kn.tDays.length) {
        const { ctx, w, h } = prep(canvas);
        ctx.fillStyle = C.dim; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('no ejecta → no kilonova', w / 2, h / 2);
        return;
    }
    const lmax = Math.max(kn.peakL, 1e39);
    const p = plot(canvas, { min: 0.01, max: 30, log: true, label: 't  (days)' }, { min: lmax / 3000, max: lmax * 2.5, log: true, label: 'L_bol  (erg/s)' });
    p.line(kn.tDays.map((t, i) => [t, kn.blue.L[i] || 0]), C.blue, 1.2, [4, 3]);
    p.line(kn.tDays.map((t, i) => [t, kn.red.L[i] || 0]), C.red, 1.2, [4, 3]);
    p.line(kn.tDays.map((t, i) => [t, kn.total[i]]), C.amber, 2);
    p.text(0.012, lmax * 1.8, `peak ${kn.peakL.toExponential(1)} erg/s at ${kn.tPeakDays.toFixed(1)} d${extraLabel ? ' · ' + extraLabel : ''}`, C.amber);
    p.text(25, lmax / 2000, 'blue: disk wind · red: dynamical', C.dim, 'right');
    p.done();
}

/** @param series [{t, eKin, eThermal, ePot, eTotal, eGw}] in code units */
/** @param cursorT code-unit time of the review position; null draws none. */
export function drawEnergy(canvas, series, cursorT = null) {
    if (!series || series.length < 2) { prep(canvas); return; }
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const k of ['eKin', 'eThermal', 'ePot', 'eTotal']) { lo = Math.min(lo, s[k]); hi = Math.max(hi, s[k]); }
    if (!(hi > lo)) { hi = lo + 1; }
    const pad = 0.08 * (hi - lo);
    const p = plot(canvas, { min: series[0].t, max: Math.max(series[series.length - 1].t, series[0].t + 1e-6), label: 't  (code units)' },
        { min: lo - pad, max: hi + pad, label: 'E  (M☉c²)' });
    p.line(series.map(s => [s.t, s.ePot]), C.blue, 1.2);
    p.line(series.map(s => [s.t, s.eKin]), C.amber, 1.2);
    p.line(series.map(s => [s.t, s.eThermal]), C.red, 1.2);
    p.line(series.map(s => [s.t, s.eTotal]), C.accent, 2);
    p.line(series.map(s => [s.t, s.eTotal + s.eGw]), 'rgba(125,255,176,0.8)', 1, [3, 3]);
    p.text(series[0].t, hi + pad * 0.5, 'cyan E_tot · green E_tot + E_gw · amber kinetic · red thermal · blue potential', C.dim);
    if (cursorT !== null) drawCursor(p, cursorT, { min: series[0].t, max: Math.max(series[series.length - 1].t, series[0].t + 1e-6) }, 'review');
    p.done();
}
