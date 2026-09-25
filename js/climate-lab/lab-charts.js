/**
 * climate-lab/lab-charts.js — the lab's instruments, drawn as SVG strings.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: every function returns markup; nothing touches the DOM, so the
 * geometry is node-tested (tests/climate-lab.mjs). Colour lives in
 * js/climate-lab/climate-lab.css under CLASS names — never in SVG presentation
 * attributes, where CSS custom properties do not resolve (the DESIGN_TOKENS
 * gotcha) — so the theme can move without touching this file.
 *
 * Visual grammar (the dataviz method, applied):
 *   · Sparklines are de-emphasis ink with the CURRENT point in the accent;
 *     the forecast tail is dashed because a dash means "projection" — it is
 *     the one place a dash is data, not decoration.
 *   · Gaps break lines (a missing hour is not a zero).
 *   · One axis per plot. The meteogram is SMALL MULTIPLES on one shared
 *     time axis; wind gusts ride their own speed axis as an envelope of the
 *     same hue, never a second scale.
 *   · Text is never data-coloured; status is icon + label.
 */

import { sparkPoints, sparkPath } from './lab-physics.js';
import { QUANTITIES } from './lab-units.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const f1 = (v) => (Math.round(v * 10) / 10).toString();

export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

/** Convert an SI value to the display unit for `q` (NaN-safe). */
export function toDisplay(q, v, units) {
    const Q = QUANTITIES[q];
    if (!Q || !isNum(v)) return null;
    const u = Q.units[units?.[q]] || Object.values(Q.units)[0];
    return u.to(v);
}
function unitSym(q, units) {
    const Q = QUANTITIES[q];
    if (!Q) return '';
    return (Q.units[units?.[q]] || Object.values(Q.units)[0]).sym;
}

// ── Sparkline ───────────────────────────────────────────────────────────────

/**
 * A tile sparkline. `spark` = { values (SI), t, nowIdx, kind, q, label }.
 * Past is solid, future dashed; the now-point wears the accent.
 */
export function sparkSvg(spark, { w = 148, h = 34, units = null } = {}) {
    if (!spark || !Array.isArray(spark.values) || spark.values.filter(isNum).length < 2) return '';
    const vals = spark.values.map((v) => toDisplay(spark.q, v, units));
    const { nowIdx = -1 } = spark;
    const label = `${esc(spark.label || '')} — past 24 h and next 24 h`;
    if (spark.kind === 'bars') {
        const finite = vals.filter(isNum);
        const max = Math.max(...finite, 0) || 1;
        const n = vals.length, bw = Math.max(1, (w - 2) / n - 1);
        let bars = '';
        vals.forEach((v, i) => {
            if (!isNum(v) || v <= 0) return;
            const bh = Math.max(1, (v / max) * (h - 4));
            const x = 1 + i * ((w - 2) / n);
            bars += `<rect class="${i <= nowIdx ? 'cl-spark-bar-past' : 'cl-spark-bar'}" x="${f1(x)}" y="${f1(h - bh - 1)}" width="${f1(bw)}" height="${f1(bh)}" rx="1"/>`;
        });
        const nx = nowIdx >= 0 ? 1 + (nowIdx + 0.5) * ((w - 2) / n) : null;
        return `<svg class="cl-spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${label}" preserveAspectRatio="none">`
            + `<line class="cl-spark-base" x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}"/>`
            + bars
            + (nx != null ? `<line class="cl-spark-now" x1="${f1(nx)}" y1="0" x2="${f1(nx)}" y2="${h}"/>` : '')
            + '</svg>';
    }
    const { points } = sparkPoints(vals, { w, h, pad: 4 });
    const past = points.map((p, i) => (i <= nowIdx ? p : null));
    const future = points.map((p, i) => (i >= nowIdx && nowIdx >= 0 ? p : (nowIdx < 0 ? p : null)));
    const np = nowIdx >= 0 ? points[nowIdx] : null;
    return `<svg class="cl-spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${label}" preserveAspectRatio="none">`
        + `<path class="cl-spark-line" d="${sparkPath(past)}"/>`
        + `<path class="cl-spark-fc" d="${sparkPath(future)}"/>`
        + (np ? `<circle class="cl-spark-dot" cx="${f1(np.x)}" cy="${f1(np.y)}" r="3.2"/>` : '')
        + '</svg>';
}

// ── Meters ──────────────────────────────────────────────────────────────────

/** Fill meter (0..max) or today's range meter with a current marker. */
export function meterSvg(meter, { w = 148, h = 10 } = {}) {
    if (!meter || !isNum(meter.v) || !isNum(meter.min) || !isNum(meter.max) || !(meter.max > meter.min)) return '';
    const x = (v) => 1 + ((Math.min(meter.max, Math.max(meter.min, v)) - meter.min) / (meter.max - meter.min)) * (w - 2);
    if (meter.kind === 'range') {
        const lo = x(meter.lo ?? meter.min), hi = x(meter.hi ?? meter.max), cx = x(meter.v);
        return `<svg class="cl-meter" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" aria-hidden="true" preserveAspectRatio="none">`
            + `<rect class="cl-meter-track" x="1" y="${h / 2 - 2}" width="${w - 2}" height="4" rx="2"/>`
            + `<rect class="cl-meter-range" x="${f1(lo)}" y="${h / 2 - 2}" width="${f1(Math.max(2, hi - lo))}" height="4" rx="2"/>`
            + `<circle class="cl-meter-mark" cx="${f1(cx)}" cy="${h / 2}" r="${h / 2 - 1}"/>`
            + '</svg>';
    }
    const fw = Math.max(0, x(meter.v) - 1);
    return `<svg class="cl-meter" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" aria-hidden="true" preserveAspectRatio="none">`
        + `<rect class="cl-meter-track" x="1" y="${h / 2 - 2}" width="${w - 2}" height="4" rx="2"/>`
        + `<rect class="cl-meter-fill" x="1" y="${h / 2 - 2}" width="${f1(fw)}" height="4" rx="2"/>`
        + '</svg>';
}

// ── Anemometer compass ─────────────────────────────────────────────────────

/**
 * Wind rose-style dial. The wedge sits on the rim at the direction the wind
 * blows FROM (the meteorological convention the readout prints); the arrow
 * crosses the dial DOWNWIND so the dial reads the way a vane points.
 */
export function compassSvg({ dirDeg, speedMs } = {}, { size = 76 } = {}) {
    const c = size / 2, r = c - 6;
    let ticks = '';
    for (let i = 0; i < 16; i++) {
        const a = (i * 22.5 - 90) * Math.PI / 180, major = i % 4 === 0;
        const r0 = r - (major ? 6 : 3);
        ticks += `<line class="${major ? 'cl-dial-tick-major' : 'cl-dial-tick'}" x1="${f1(c + r0 * Math.cos(a))}" y1="${f1(c + r0 * Math.sin(a))}" x2="${f1(c + r * Math.cos(a))}" y2="${f1(c + r * Math.sin(a))}"/>`;
    }
    const lbl = (t, deg) => {
        const a = (deg - 90) * Math.PI / 180, rr = r - 13;
        return `<text class="cl-dial-label" x="${f1(c + rr * Math.cos(a))}" y="${f1(c + rr * Math.sin(a) + 3)}" text-anchor="middle">${t}</text>`;
    };
    let needle = '';
    if (isNum(dirDeg)) {
        const from = (dirDeg - 90) * Math.PI / 180;
        const to = from + Math.PI;
        const fx = c + (r - 2) * Math.cos(from), fy = c + (r - 2) * Math.sin(from);
        const tx = c + (r - 16) * Math.cos(to), ty = c + (r - 16) * Math.sin(to);
        const hl = 6, ha = 0.5;
        const h1x = tx - hl * Math.cos(to - ha), h1y = ty - hl * Math.sin(to - ha);
        const h2x = tx - hl * Math.cos(to + ha), h2y = ty - hl * Math.sin(to + ha);
        const w0 = from - 0.22, w1 = from + 0.22;
        needle = `<path class="cl-dial-wedge" d="M${f1(c + r * Math.cos(w0))},${f1(c + r * Math.sin(w0))} A${r},${r} 0 0 1 ${f1(c + r * Math.cos(w1))},${f1(c + r * Math.sin(w1))} L${f1(c + (r - 9) * Math.cos(from))},${f1(c + (r - 9) * Math.sin(from))} Z"/>`
            + (isNum(speedMs) && speedMs < 0.5 ? '' :
                `<line class="cl-dial-needle" x1="${f1(fx)}" y1="${f1(fy)}" x2="${f1(tx)}" y2="${f1(ty)}"/>`
                + `<path class="cl-dial-head" d="M${f1(tx)},${f1(ty)} L${f1(h1x)},${f1(h1y)} L${f1(h2x)},${f1(h2y)} Z"/>`);
    }
    return `<svg class="cl-dial" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Wind direction dial">`
        + `<circle class="cl-dial-face" cx="${c}" cy="${c}" r="${r}"/>`
        + ticks + lbl('N', 0) + lbl('E', 90) + lbl('S', 180) + lbl('W', 270) + needle
        + '</svg>';
}

/** Low / mid / high cloud layers as three thin bars. */
export function layersSvg({ low, mid, high } = {}, { w = 148 } = {}) {
    const rows = [['High', high], ['Mid', mid], ['Low', low]];
    if (!rows.some(([, v]) => isNum(v))) return '';
    const rh = 10, h = rows.length * (rh + 4);
    let out = '';
    rows.forEach(([name, v], i) => {
        const y = i * (rh + 4);
        const bw = isNum(v) ? Math.max(0, Math.min(100, v)) / 100 * (w - 40) : 0;
        out += `<text class="cl-layer-label" x="0" y="${y + rh - 1}">${name}</text>`
            + `<rect class="cl-meter-track" x="34" y="${y + 3}" width="${w - 40}" height="4" rx="2"/>`
            + (bw > 0 ? `<rect class="cl-layer-fill" x="34" y="${y + 3}" width="${f1(bw)}" height="4" rx="2"/>` : '')
            + `<text class="cl-layer-val" x="${w}" y="${y + rh - 1}" text-anchor="end">${isNum(v) ? Math.round(v) + '%' : '—'}</text>`;
    });
    return `<svg class="cl-layers" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Cloud cover by layer: high ${isNum(high) ? Math.round(high) : 'unknown'}%, mid ${isNum(mid) ? Math.round(mid) : 'unknown'}%, low ${isNum(low) ? Math.round(low) : 'unknown'}%">${out}</svg>`;
}

// ── Climate strip plot ─────────────────────────────────────────────────────

/**
 * Where today's value sits among this season's archive values: every sample
 * a de-emphasis dot on one temperature axis, the normal a hairline tick,
 * today the accent marker. Emphasis form — one entity is the point.
 */
export function stripSvg({ samplesC, valueC, normalC, units, label = 'Today' } = {}, { w = 320, h = 54 } = {}) {
    const xs = (samplesC || []).map((v) => toDisplay('temp', v, units)).filter(isNum);
    const val = toDisplay('temp', valueC, units);
    const nrm = toDisplay('temp', normalC, units);
    if (xs.length < 3) return '';
    let lo = Math.min(...xs, isNum(val) ? val : Infinity), hi = Math.max(...xs, isNum(val) ? val : -Infinity);
    const pad = Math.max(1, (hi - lo) * 0.08); lo -= pad; hi += pad;
    const x = (v) => 8 + ((v - lo) / (hi - lo)) * (w - 16);
    const sorted = [...xs].sort((a, b) => a - b);
    // Beeswarm-lite: stack coincident dots so a dense season stays readable.
    const bins = new Map();
    let dots = '';
    for (const v of sorted) {
        const k = Math.round(x(v) / 5);
        const n = bins.get(k) || 0; bins.set(k, n + 1);
        dots += `<circle class="cl-strip-dot" cx="${f1(x(v))}" cy="${f1(30 - (n % 4) * 5)}" r="2.2"/>`;
    }
    const sym = unitSym('temp', units);
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad].map((v) =>
        `<text class="cl-axis-label" x="${f1(x(v))}" y="${h - 2}" text-anchor="middle">${Math.round(v)}${sym}</text>`).join('');
    return `<svg class="cl-strip" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(label)} compared with ${xs.length} archive values for this time of year">`
        + `<line class="cl-axis" x1="4" y1="36" x2="${w - 4}" y2="36"/>`
        + dots
        + (isNum(nrm) ? `<line class="cl-strip-normal" x1="${f1(x(nrm))}" y1="8" x2="${f1(x(nrm))}" y2="38"/>` : '')
        + (isNum(val) ? `<line class="cl-strip-mark" x1="${f1(x(val))}" y1="4" x2="${f1(x(val))}" y2="38"/><circle class="cl-strip-today" cx="${f1(x(val))}" cy="36" r="4.5"/>` : '')
        + ticks
        + '</svg>';
}

// ── Meteogram (small multiples on one time axis) ───────────────────────────

const PANELS = Object.freeze([
    { id: 'temp',   h: 104, title: 'Temperature · dew point' },
    { id: 'pop',    h: 46,  title: 'Chance of precipitation' },
    { id: 'wind',   h: 58,  title: 'Wind · gust envelope' },
    { id: 'press',  h: 50,  title: 'Sea-level pressure' },
    { id: 'cloud',  h: 14,  title: 'Cloud cover' },
]);

/** Nice tick step for a span (1/2/5 × 10^n). */
export function niceStep(span, target = 3) {
    if (!(span > 0)) return 1;
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / mag;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * mag;
}

/** The next step up the 1-2-5 ladder (1 → 2 → 5 → 10 …). */
export function nextNice(step) {
    const mag = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    const m = Math.round(step / mag);
    return (m < 2 ? 2 : m < 5 ? 5 : 10) * mag;
}

/**
 * Build the meteogram. `W` is an hourly window (hourlyWindow() output, SI);
 * `utcOffsetS` puts the time axis on the STATION's clock. Returns
 * `{ svg, layout }`; layout carries what the DOM probe needs to map a
 * pointer to an hour (x positions, panel extents) without re-deriving it.
 */
export function meteogramSvg(W, { nowMs, utcOffsetS = 0, units, width = 720 } = {}) {
    const n = W?.t?.length || 0;
    if (n < 3) return { svg: '', layout: null };
    const L = 46, R = 12, gap = 18, top = 16, axisH = 30;
    const plotW = width - L - R;
    const xOf = (i) => L + (i / (n - 1)) * plotW;
    const panelsH = PANELS.reduce((s, p) => s + p.h + gap, 0);
    const H = top + panelsH + axisH;
    const disp = (q, arr) => (arr || []).map((v) => toDisplay(q, v, units));

    let body = '', y0 = top;
    const extents = {};
    // Night shading behind every panel (context, not data).
    let night = '';
    for (let i = 0; i < n; i++) {
        if (W.isDay?.[i] === 0) {
            const x0 = i === 0 ? L : (xOf(i - 1) + xOf(i)) / 2;
            const x1 = i === n - 1 ? L + plotW : (xOf(i) + xOf(i + 1)) / 2;
            night += `<rect class="cl-mg-night" x="${f1(x0)}" y="${top}" width="${f1(x1 - x0 + 0.3)}" height="${f1(panelsH - gap)}"/>`;
        }
    }

    const linePath = (vals, yOf) => sparkPath(vals.map((v, i) => (isNum(v) ? { x: xOf(i), y: yOf(v) } : null)));

    for (const P of PANELS) {
        const yT = y0, yB = y0 + P.h;
        extents[P.id] = { yT, yB };
        body += `<text class="cl-mg-title" x="${L}" y="${yT - 1}">${esc(P.title)}</text>`;
        const frame = `<line class="cl-grid" x1="${L}" y1="${yB}" x2="${L + plotW}" y2="${yB}"/>`;
        if (P.id === 'temp' || P.id === 'wind' || P.id === 'press') {
            const series = P.id === 'temp'
                ? [disp('temp', W.tempC), disp('temp', W.dewC)]
                : P.id === 'wind' ? [disp('wind', W.windMs), disp('wind', W.gustMs)]
                : [disp('pressure', W.mslHpa)];
            const all = series.flat().filter(isNum);
            if (!all.length) { body += frame; y0 = yB + gap; continue; }
            let lo = Math.min(...all), hi = Math.max(...all);
            if (P.id === 'wind') lo = 0;
            // ~1 gridline per 28 px: 3 on the temperature panel, 2 on the short
            // ones — and step up the 1-2-5 ladder until the labels actually fit.
            const target = Math.max(2, Math.floor(P.h / 28));
            let step = niceStep(hi - lo || 1, target);
            while (Math.ceil(hi / step) - Math.floor(lo / step) > target + 1) step = nextNice(step);
            lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
            if (hi === lo) hi = lo + step;
            const yOf = (v) => yB - 4 - ((v - lo) / (hi - lo)) * (P.h - 10);
            for (let v = lo; v <= hi + 1e-9; v += step) {
                body += `<line class="cl-grid" x1="${L}" y1="${f1(yOf(v))}" x2="${L + plotW}" y2="${f1(yOf(v))}"/>`
                    + `<text class="cl-axis-label" x="${L - 6}" y="${f1(yOf(v) + 3)}" text-anchor="end">${esc(step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : Math.round(v))}</text>`;
            }
            if (P.id === 'wind') {
                const [spd, gst] = series;
                const up = gst.map((g, i) => (isNum(g) && isNum(spd[i]) ? { x: xOf(i), y: yOf(Math.max(g, spd[i])) } : null));
                const dn = spd.map((s, i) => (isNum(s) && isNum(gst[i]) ? { x: xOf(i), y: yOf(s) } : null));
                // Envelope polygon over contiguous runs only.
                let run = [];
                const flush = () => {
                    if (run.length > 1) {
                        const a = run.map((i) => `${f1(up[i].x)},${f1(up[i].y)}`);
                        const b = run.slice().reverse().map((i) => `${f1(dn[i].x)},${f1(dn[i].y)}`);
                        body += `<polygon class="cl-mg-gust" points="${[...a, ...b].join(' ')}"/>`;
                    }
                    run = [];
                };
                up.forEach((p, i) => { if (p && dn[i]) run.push(i); else flush(); });
                flush();
                body += `<path class="cl-mg-wind" d="${linePath(spd, yOf)}"/>`;
            } else if (P.id === 'temp') {
                body += `<path class="cl-mg-dew" d="${linePath(series[1], yOf)}"/>`
                    + `<path class="cl-mg-temp" d="${linePath(series[0], yOf)}"/>`;
            } else {
                body += `<path class="cl-mg-press" d="${linePath(series[0], yOf)}"/>`;
            }
            extents[P.id].scale = { lo, hi };
            body += frame;
        } else if (P.id === 'pop') {
            const bw = Math.max(1, plotW / n - 1.5);
            (W.pop || []).forEach((v, i) => {
                if (!isNum(v) || v <= 0) return;
                const bh = (v / 100) * (P.h - 6);
                body += `<rect class="cl-mg-pop" x="${f1(xOf(i) - bw / 2)}" y="${f1(yB - bh)}" width="${f1(bw)}" height="${f1(bh)}" rx="1"/>`;
            });
            body += `<text class="cl-axis-label" x="${L - 6}" y="${yT + 8}" text-anchor="end">100%</text>`
                + `<line class="cl-grid" x1="${L}" y1="${f1(yB - (P.h - 6) / 2)}" x2="${L + plotW}" y2="${f1(yB - (P.h - 6) / 2)}"/>`
                + frame;
        } else if (P.id === 'cloud') {
            const cw = plotW / n;
            (W.cloudPct || []).forEach((v, i) => {
                if (!isNum(v)) return;
                const o = (Math.max(0, Math.min(100, v)) / 100 * 0.85 + 0.05).toFixed(2);
                body += `<rect class="cl-mg-cloud" x="${f1(L + i * cw)}" y="${yT}" width="${f1(cw + 0.4)}" height="${P.h}" fill-opacity="${o}"/>`;
            });
        }
        y0 = yB + gap;
    }

    // Time axis on the STATION's clock: 6-hourly ticks, midnight day labels.
    let axis = '';
    const yAxis = top + panelsH - gap + 12;
    for (let i = 0; i < n; i++) {
        const t = W.t[i];
        if (!isNum(t)) continue;
        const d = new Date(t + utcOffsetS * 1000);
        const hh = d.getUTCHours();
        if (hh % 6 !== 0) continue;
        const x = xOf(i);
        if (hh === 0) {
            axis += `<line class="cl-mg-midnight" x1="${f1(x)}" y1="${top}" x2="${f1(x)}" y2="${f1(yAxis - 10)}"/>`
                + `<text class="cl-axis-day" x="${f1(x + 3)}" y="${f1(yAxis + 12)}">${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</text>`;
        }
        axis += `<text class="cl-axis-label" x="${f1(x)}" y="${f1(yAxis)}" text-anchor="middle">${String(hh).padStart(2, '0')}</text>`;
    }
    let nowX = null;
    if (isNum(nowMs) && W.t[0] <= nowMs && nowMs <= W.t[n - 1]) {
        let i = 0; while (i < n - 1 && W.t[i + 1] <= nowMs) i++;
        const frac = (nowMs - W.t[i]) / ((W.t[i + 1] ?? W.t[i]) - W.t[i] || 1);
        nowX = xOf(i) + frac * (xOf(Math.min(n - 1, i + 1)) - xOf(i));
        axis += `<line class="cl-mg-now" x1="${f1(nowX)}" y1="${top}" x2="${f1(nowX)}" y2="${f1(yAxis - 10)}"/>`
            + `<text class="cl-mg-now-label" x="${f1(nowX + 3)}" y="${top + 8}">now</text>`;
    }

    const svg = `<svg class="cl-mg" viewBox="0 0 ${width} ${H}" width="100%" role="img" aria-label="Meteogram: temperature, dew point, precipitation chance, wind, pressure and cloud cover by hour" tabindex="0">`
        + night + body + axis
        + `<line class="cl-mg-probe" x1="0" y1="${top}" x2="0" y2="${f1(yAxis - 10)}" visibility="hidden"/>`
        + '</svg>';
    return {
        svg,
        layout: { n, L, plotW, width, height: H, top, xs: W.t.map((_, i) => xOf(i)), nowX, extents },
    };
}

// ── Sky dome (satellite pass) ──────────────────────────────────────────────

/**
 * Polar plot of a pass as seen from the station: zenith at centre, horizon
 * at the rim, north up. It is a SKY chart — drawn as seen looking UP, the
 * planisphere / Heavens-Above convention — so east plots on the LEFT; the
 * cardinal letters are printed so nobody has to know that. The track is the
 * sampled look-angle path; rise and set get small markers, the culmination
 * a larger one.
 * @param {Array<{azDeg:number, elDeg:number}>} track
 */
export function skyDomeSvg(track, { size = 168, label = 'Pass' } = {}) {
    const c = size / 2, R = c - 14;
    /** az/el → chart xy. a = az − 90°, and x = c − r·cos(a) mirrors E to the left. */
    const p2 = (az, el) => {
        const r = R * (1 - Math.max(0, el) / 90);
        const a = (az - 90) * Math.PI / 180;
        return { x: c - r * Math.cos(a), y: c + r * Math.sin(a) };
    };
    let rings = '';
    for (const el of [0, 30, 60]) {
        rings += `<circle class="${el === 0 ? 'cl-dome-horizon' : 'cl-grid-ring'}" cx="${c}" cy="${c}" r="${f1(R * (1 - el / 90))}"/>`;
        if (el) rings += `<text class="cl-axis-label" x="${c + 2}" y="${f1(c - R * (1 - el / 90) - 2)}">${el}°</text>`;
    }
    const card = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, az]) => {
        const p = p2(az, -8);
        return `<text class="cl-dial-label" x="${f1(p.x)}" y="${f1(p.y + 3)}" text-anchor="middle">${t}</text>`;
    }).join('');
    const pts = (track || []).filter((s) => isNum(s?.azDeg) && isNum(s?.elDeg));
    let path = '', marks = '';
    if (pts.length > 1) {
        path = sparkPath(pts.map((s) => p2(s.azDeg, s.elDeg)));
        const first = p2(pts[0].azDeg, pts[0].elDeg);
        const last = p2(pts[pts.length - 1].azDeg, pts[pts.length - 1].elDeg);
        const peak = pts.reduce((a, s) => (s.elDeg > a.elDeg ? s : a), pts[0]);
        const pk = p2(peak.azDeg, peak.elDeg);
        marks = `<circle class="cl-dome-end" cx="${f1(first.x)}" cy="${f1(first.y)}" r="3"/>`
            + `<circle class="cl-dome-end" cx="${f1(last.x)}" cy="${f1(last.y)}" r="3"/>`
            + `<circle class="cl-dome-peak" cx="${f1(pk.x)}" cy="${f1(pk.y)}" r="4.5"/>`
            + `<text class="cl-dome-tag" x="${f1(first.x)}" y="${f1(first.y - 6)}" text-anchor="middle">rise</text>`;
    }
    return `<svg class="cl-dome" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}: sky track from rise to set, as seen looking up">`
        + `<circle class="cl-dome-sky" cx="${c}" cy="${c}" r="${R}"/>`
        + rings + card
        + (path ? `<path class="cl-dome-track" d="${path}"/>` : '')
        + marks
        + '</svg>';
}
