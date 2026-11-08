/**
 * climalytix/timeline-model.js — the Explore timeline, as numbers and markup.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, `nowMs` always a parameter): the window for a range preset,
 * the bucket step, one panel's geometry, the SVG for it, and the crosshair
 * readout. tests/climalytix-timeline.mjs gates it; the page only places the
 * strings this returns.
 *
 * The grammar is the Climate Lab meteogram's, extended from 48 h to 85 years
 * (js/climate-lab/lab-charts.js header):
 *   · SMALL MULTIPLES ON ONE TIME AXIS — every panel shares x; a panel has
 *     ONE y axis and only same-quantity series share it. Never a dual axis.
 *   · PAST SOLID, FUTURE DASHED — every sample after `now` is drawn dashed,
 *     whatever the series kind, because a dash means projection.
 *   · GAPS BREAK LINES — a NaN bucket ends the path; nothing is bridged.
 *   · COLOUR IN CSS CLASSES (`cx-s0`…`cx-s3`), never in SVG attributes, so
 *     the theme resolves custom properties (the DESIGN_TOKENS gotcha).
 *   · Long windows are AGGREGATED, never thinned: the bucket step grows with
 *     the span (BUCKET_LADDER) and each series aggregates by its own `agg`,
 *     so a 30-year panel of daily highs shows each 30-day bucket's MAX, and
 *     the caption names the bucket so nobody reads it as a daily line.
 */

import { HOUR_MS, DAY_MS, resample, localOrigin, num } from './series.js';

/** Range presets: how far back and forward of `now` the window reaches. */
export const RANGES = Object.freeze({
    '7d':  { label: '7 days',   pastMs: 4 * DAY_MS,          futureMs: 3 * DAY_MS },
    '30d': { label: '30 days',  pastMs: 27 * DAY_MS,         futureMs: 3 * DAY_MS },
    '1y':  { label: '1 year',   pastMs: 365 * DAY_MS,        futureMs: 3 * DAY_MS },
    '10y': { label: '10 years', pastMs: 3653 * DAY_MS,       futureMs: 3 * DAY_MS },
    'all': { label: 'All',      pastMs: null,                futureMs: 3 * DAY_MS },
});

/**
 * Bucket ladder. Day-and-longer buckets align to the site's local midnight
 * (series.js localOrigin). 5-day pentads and 30-day buckets are the
 * climatologist's units; they are NOT calendar months and the caption says so.
 */
export const BUCKET_LADDER = Object.freeze([
    { ms: HOUR_MS,      label: 'hourly' },
    { ms: 3 * HOUR_MS,  label: '3-hourly' },
    { ms: 6 * HOUR_MS,  label: '6-hourly' },
    { ms: DAY_MS,       label: 'daily' },
    { ms: 5 * DAY_MS,   label: '5-day' },
    { ms: 30 * DAY_MS,  label: '30-day' },
    { ms: 365 * DAY_MS, label: '365-day' },
]);

/** Max buckets per panel — ~1 bucket per 1–2 px on a desktop panel. */
export const MAX_BUCKETS = 1200;

/** The smallest ladder step that keeps a span within MAX_BUCKETS. */
export function chooseStep(spanMs, maxBuckets = MAX_BUCKETS) {
    for (const b of BUCKET_LADDER) if (spanMs / b.ms <= maxBuckets) return b;
    return BUCKET_LADDER[BUCKET_LADDER.length - 1];
}

/**
 * Window for a range id. 'all' starts at the earliest sample of any series
 * (`earliestMs`), so it shows the record the user actually loaded.
 */
export function windowFor(rangeId, nowMs, earliestMs = null) {
    const r = RANGES[rangeId] || RANGES['30d'];
    const to = nowMs + r.futureMs;
    let from = r.pastMs == null ? (num(earliestMs) ?? nowMs - 365 * DAY_MS) : nowMs - r.pastMs;
    if (from >= to) from = to - DAY_MS;
    return { from, to, rangeId: RANGES[rangeId] ? rangeId : '30d' };
}

/** "Nice" axis ticks covering [lo, hi] (1-2-5 steps). */
export function niceTicks(lo, hi, count = 4) {
    if (!(Number.isFinite(lo) && Number.isFinite(hi))) return [];
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    // Round to the NEAREST 1-2-5 step (rounding up left 2 ticks on −3.2…7.9).
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7.5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
        out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
    }
    return out;
}

/**
 * One panel: resample each series onto the shared step, then map to pixel
 * space. Returns plain numbers; `panelSvg` turns them into markup.
 *
 * @param {Array} seriesList  SiteSeries of ONE quantity (the caller groups)
 * @param {object} o  { from, to, nowMs, stepMs, utcOffsetS, width, height,
 *                      pad: {l,r,t,b}, toDisplay: (si)=>number }
 */
export function panelModel(seriesList, o) {
    const { from, to, nowMs, width, height } = o;
    // ONE BUCKET FOR EVERY SUM IN A PANEL. A sum's value is "per bucket", so a
    // daily total (mm/day) and an hourly total (mm/h) on one axis would put two
    // different units on one ruler. Every series in a panel that holds a sum is
    // drawn at the coarsest summed cadence (an hourly sum becomes a daily sum).
    const sums = seriesList.filter((s) => s.agg === 'sum');
    const stepMs = sums.length ? Math.max(o.stepMs, ...sums.map((s) => s.cadenceMs)) : o.stepMs;
    const pad = { l: 46, r: 10, t: 8, b: 18, ...(o.pad || {}) };
    const toDisplay = typeof o.toDisplay === 'function' ? o.toDisplay : (x) => x;
    const originMs = stepMs >= DAY_MS ? localOrigin(o.utcOffsetS) : 0;
    const iw = Math.max(1, width - pad.l - pad.r);
    const ih = Math.max(1, height - pad.t - pad.b);
    const xOf = (ms) => pad.l + ((ms - from) / (to - from)) * iw;

    let lo = Infinity, hi = -Infinity;
    const lines = seriesList.map((s) => {
        const r = resample(s, { stepMs, originMs, from, to });
        const pts = [];
        for (let i = 0; i < r.t.length; i++) {
            const t = r.t[i];
            if (t < from || t >= to) continue;
            const raw = r.v[i];
            const y = Number.isFinite(raw) ? toDisplay(raw) : null;
            if (y != null && Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
            pts.push({ t, y: y != null && Number.isFinite(y) ? y : null });
        }
        // TOO SHORT FOR THIS ZOOM: the series has data inside the window but
        // not one bucket reaches coverage (a 4-day forecast in a 30-day
        // bucket). Say so — "No data" would be false, and a partial bucket
        // drawn as a value would be worse.
        let inWindow = 0, firstIn = null, lastIn = null;
        for (let i = 0; i < s.t.length; i++) {
            if (s.t[i] < from || s.t[i] >= to || !Number.isFinite(s.v[i])) continue;
            inWindow++; if (firstIn == null) firstIn = s.t[i]; lastIn = s.t[i];
        }
        const drawn = pts.some((p) => p.y != null);
        return {
            id: s.id, label: s.label, kind: s.kind, agg: s.agg,
            nativeMs: s.cadenceMs, drawnMs: Math.max(stepMs, s.cadenceMs), pts,
            tooShort: !drawn && inWindow > 0 ? { spanMs: lastIn - firstIn + s.cadenceMs } : null,
        };
    });

    const hasData = Number.isFinite(lo);
    if (!hasData) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const ticks = niceTicks(lo, hi, 4);
    const yLo = Math.min(lo, ticks[0] ?? lo);
    const yHi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
    const yOf = (v) => pad.t + ih - ((v - yLo) / (yHi - yLo || 1)) * ih;

    for (const ln of lines) {
        // Split into runs: a gap ends a run; crossing `now` starts a dashed run.
        const runs = [];
        let cur = null;
        for (const p of ln.pts) {
            if (p.y == null) { cur = null; continue; }
            const future = p.t > nowMs;
            const xy = [xOf(p.t), yOf(p.y)];
            if (!cur || cur.future !== future) {
                const prev = cur && cur.pts.length ? cur.pts[cur.pts.length - 1] : null;
                cur = { future, pts: prev ? [prev] : [] };
                runs.push(cur);
            }
            cur.pts.push(xy);
        }
        ln.runs = runs;
    }

    const nowX = nowMs >= from && nowMs <= to ? xOf(nowMs) : null;
    return {
        width, height, pad, from, to, nowMs, nowX, stepMs, hasData,
        tooShort: !hasData && lines.some((l) => l.tooShort),
        yTicks: ticks.map((v) => ({ v, y: yOf(v) })),
        lines,
    };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = (x) => (Math.round(x * 10) / 10).toString();

/**
 * SVG markup for a panel model. `slotOf(seriesId)` → 0–3 colour slot;
 * `fmtTick(v)` formats a y tick (already in display units).
 */
export function panelSvg(m, { slotOf = () => 0, fmtTick = (v) => String(v), title = '' } = {}) {
    const { width, height, pad } = m;
    const parts = [];
    parts.push(`<svg class="cx-panel-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">`);
    if (m.nowX != null) {
        parts.push(`<rect class="cx-future" x="${f1(m.nowX)}" y="${pad.t}" width="${f1(width - pad.r - m.nowX)}" height="${height - pad.t - pad.b}"/>`);
    }
    for (const tk of m.yTicks) {
        parts.push(`<line class="cx-grid" x1="${pad.l}" x2="${width - pad.r}" y1="${f1(tk.y)}" y2="${f1(tk.y)}"/>`);
        parts.push(`<text class="cx-tick" x="${pad.l - 6}" y="${f1(tk.y + 3)}" text-anchor="end">${esc(fmtTick(tk.v))}</text>`);
    }
    for (const ln of m.lines) {
        const slot = `cx-s${Math.max(0, Math.min(3, slotOf(ln.id) | 0))}`;
        for (const run of ln.runs) {
            if (run.pts.length === 1) {
                const [x, y] = run.pts[0];
                parts.push(`<circle class="cx-dot ${slot}" cx="${f1(x)}" cy="${f1(y)}" r="1.6" data-series="${esc(ln.id)}"/>`);
                continue;
            }
            const d = run.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f1(x)},${f1(y)}`).join('');
            parts.push(`<path class="cx-line ${slot}${run.future ? ' cx-proj' : ''}" d="${d}" data-series="${esc(ln.id)}"/>`);
        }
    }
    if (m.nowX != null) {
        parts.push(`<line class="cx-now" x1="${f1(m.nowX)}" x2="${f1(m.nowX)}" y1="${pad.t}" y2="${height - pad.b}"/>`);
    }
    if (!m.hasData) {
        const msg = m.tooShort ? 'Too short to show at this zoom — choose a shorter range' : 'No data in this window';
        parts.push(`<text class="cx-empty" x="${f1(width / 2)}" y="${f1(height / 2)}" text-anchor="middle">${msg}</text>`);
    }
    parts.push('</svg>');
    return parts.join('');
}

/**
 * Decimals a tick label needs to tell its neighbours apart, from the tick
 * SPACING, not the unit — unit decimals printed 0.5-spaced index ticks as
 * "1, 1, 0, −1". Accepts numbers or {v} ticks.
 */
export function tickDecimals(ticks) {
    if (!Array.isArray(ticks) || ticks.length < 2) return 0;
    const val = (k) => (typeof k === 'number' ? k : k?.v);
    const d = Math.abs(val(ticks[1]) - val(ticks[0]));
    if (!(d > 0)) return 0;
    return Math.min(3, Math.max(0, -Math.floor(Math.log10(d) + 1e-9)));
}

/**
 * Time-axis ticks for the shared x axis (one row under the panels). The step
 * is the first rung giving ≤ 8 labels: sub-day → days → weeks → 1/2/3/6
 * calendar months → 1/2/5/10/20 years (a 1-year window jumping straight to
 * yearly ticks drew ONE label — the multi-month rungs exist for it).
 */
export function timeTicks(from, to, width, padL = 46, padR = 10) {
    const span = to - from;
    const iw = width - padL - padR;
    const MONTH = DAY_MS * 30.4375, YEAR = DAY_MS * 365.25;
    const rungs = [
        { ms: 6 * HOUR_MS }, { ms: DAY_MS }, { ms: 7 * DAY_MS },
        { months: 1 }, { months: 2 }, { months: 3 }, { months: 6 },
        { years: 1 }, { years: 2 }, { years: 5 }, { years: 10 }, { years: 20 },
    ];
    const approx = (r) => r.ms ?? (r.months ? r.months * MONTH : r.years * YEAR);
    const rung = rungs.find((r) => span / approx(r) <= 8) ?? rungs[rungs.length - 1];
    const out = [];
    if (rung.years) {
        const y0 = new Date(from).getUTCFullYear();
        for (let y = Math.ceil(y0 / rung.years) * rung.years; ; y += rung.years) {
            const t = Date.UTC(y, 0, 1);
            if (t > to) break;
            if (t >= from) out.push({ t, label: String(y) });
        }
    } else if (rung.months) {
        const d = new Date(from);
        let idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
        idx = Math.ceil(idx / rung.months) * rung.months;
        for (;; idx += rung.months) {
            const t = Date.UTC(Math.floor(idx / 12), idx % 12, 1);
            if (t > to) break;
            if (t >= from) out.push({ t, label: new Date(t).toISOString().slice(0, 7) });
        }
    } else {
        for (let t = Math.ceil(from / rung.ms) * rung.ms; t <= to; t += rung.ms) {
            out.push({ t, label: new Date(t).toISOString().slice(5, rung.ms >= DAY_MS ? 10 : 13).replace('T', ' ') });
        }
    }
    return out.map((k) => ({ ...k, x: padL + ((k.t - from) / span) * iw }));
}

/**
 * Crosshair: the value of every line at the bucket containing `ms`. A gap
 * reads null, never 0.
 */
export function readoutAt(models, ms) {
    const out = [];
    for (const m of models) {
        for (const ln of m.lines) {
            let best = null;
            for (const p of ln.pts) {
                if (p.t <= ms && ms < p.t + ln.drawnMs) { best = p; break; }
            }
            out.push({ id: ln.id, label: ln.label, t: best?.t ?? null, y: best?.y ?? null, future: ms > m.nowMs });
        }
    }
    return out;
}

/** Instant at an x pixel of a panel model (inverse of the x map). */
export function msAtX(m, x) {
    const iw = m.width - m.pad.l - m.pad.r;
    const f = Math.min(1, Math.max(0, (x - m.pad.l) / iw));
    return m.from + f * (m.to - m.from);
}
