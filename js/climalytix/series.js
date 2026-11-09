/**
 * climalytix/series.js — the SiteSeries contract and the agg-aware resampler.
 * ═══════════════════════════════════════════════════════════════════════════
 * CLIMALYTIX_PLAN.md §4.1. Every dataset Climalytix reads, whatever its
 * source, becomes a SiteSeries: one variable at one site on one time axis,
 * carrying what it IS (kind), how it AGGREGATES (agg) and where it came from
 * (provenance). Everything downstream — the timeline, the crosshair readout,
 * later the climatology / events / ladder — reads only this shape.
 *
 * PURE: no DOM, no fetch, no ambient time. Node-gated by
 * tests/climalytix-series.mjs.
 *
 * Rules, each inherited from a scar elsewhere in the repo:
 *   · ALIGN BY INSTANT, never by array index (the pollution time-machine rule).
 *     `alignToGrid` places every sample in the bucket its timestamp names.
 *   · A GAP IS NOT A ZERO. Missing values are NaN inside the typed arrays and
 *     `null` at every API boundary (`valueAt`, readouts). `Number(null)` is 0
 *     and finite — `num()` below is the guard, and it is load-bearing.
 *   · RESAMPLING FOLLOWS `agg`. Precip SUMS, a daily high takes the MAX, a
 *     temperature MEANS. A series without an `agg` is refused at construction,
 *     because a wrong aggregation is a silent, plausible-looking error.
 *   · NEVER UPSAMPLE. A target step finer than the native cadence returns the
 *     series unchanged: inventing sub-daily values from a daily record is
 *     fabrication, and the timeline says "native daily" instead.
 *   · A SPARSE BUCKET IS A GAP. A day with 3 of 24 hourly samples is not a
 *     day: below `minCoverage` the bucket is NaN, so a partial sum can never
 *     masquerade as a dry day.
 *   · STATION-LOCAL BUCKETS. Day and longer buckets are aligned to the SITE's
 *     local midnight through `originMs` (= −utcOffset), never the browser's
 *     zone and never UTC — a UTC day splits a Pacific afternoon in two.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** What a series IS. Order is the order chips are listed in. */
export const KINDS = Object.freeze([
    'observed', 'reanalysis', 'nowcast', 'forecast', 'ensemble',
    'outlook', 'index', 'derived', 'scenario',
]);

/** How a series aggregates when its buckets get coarser. */
export const AGGS = Object.freeze(['mean', 'sum', 'max', 'min']);

const KIND_SET = new Set(KINDS);
const AGG_SET = new Set(AGGS);

/** Finite number or null. `Number(null)` is 0 — never coerce a gap. */
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Build a SiteSeries. Samples are sorted by time, duplicate instants keep the
 * LAST value given (a later revision of the same hour wins), non-finite
 * values become gaps.
 *
 * @param {object} o
 * @param {string} o.id        stable dataset-variable id, e.g. 'era5.tmax'
 * @param {string} o.variable  short variable key, e.g. 'tmax'
 * @param {string} o.label     human label
 * @param {string} o.quantity  a js/climate-lab/lab-units.js QUANTITIES key
 * @param {string} o.kind      one of KINDS
 * @param {string} o.agg       one of AGGS
 * @param {number} o.cadenceMs native sample spacing
 * @param {Array<number>} o.t  epoch ms
 * @param {Array<number|null>} o.v  SI values
 */
export function makeSeries(o) {
    if (!o || typeof o !== 'object') throw new TypeError('makeSeries: options required');
    for (const k of ['id', 'variable', 'label', 'quantity']) {
        if (typeof o[k] !== 'string' || !o[k]) throw new TypeError(`makeSeries: ${k} is required`);
    }
    if (!KIND_SET.has(o.kind)) throw new TypeError(`makeSeries(${o.id}): unknown kind "${o.kind}"`);
    if (!AGG_SET.has(o.agg)) {
        throw new TypeError(`makeSeries(${o.id}): agg is required (one of ${AGGS.join('|')}) — a series cannot be resampled without it`);
    }
    if (!(num(o.cadenceMs) > 0)) throw new TypeError(`makeSeries(${o.id}): cadenceMs must be > 0`);
    const tIn = Array.isArray(o.t) || ArrayBuffer.isView(o.t) ? o.t : [];
    const vIn = Array.isArray(o.v) || ArrayBuffer.isView(o.v) ? o.v : [];

    // Index pairs with a usable instant, sort by time (stable), last write wins.
    const pairs = [];
    for (let i = 0; i < tIn.length; i++) {
        const t = num(tIn[i]);
        if (t == null) continue;
        pairs.push([t, num(vIn[i]), i]);
    }
    pairs.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const t = [];
    const v = [];
    for (const [ti, vi] of pairs) {
        if (t.length && t[t.length - 1] === ti) { v[v.length - 1] = vi; continue; }
        t.push(ti); v.push(vi);
    }
    const T = Float64Array.from(t);
    const V = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) V[i] = v[i] == null ? NaN : v[i];

    return Object.freeze({
        id: o.id,
        variable: o.variable,
        label: o.label,
        quantity: o.quantity,
        kind: o.kind,
        agg: o.agg,
        cadenceMs: o.cadenceMs,
        t: T,
        v: V,
        issuedAt: num(o.issuedAt),
        provenance: Object.freeze({
            source: o.provenance?.source ?? 'unknown',
            version: o.provenance?.version ?? null,
            fetchedAt: num(o.provenance?.fetchedAt),
            freshness: ['live', 'stale', 'expired'].includes(o.provenance?.freshness)
                ? o.provenance.freshness : 'live',
            note: o.provenance?.note ?? null,
        }),
        spatial: Object.freeze({
            kind: o.spatial?.kind === 'point' ? 'point' : 'cell',
            resKm: num(o.spatial?.resKm),
            distanceKm: num(o.spatial?.distanceKm),
        }),
    });
}

/** First index whose time is >= ms (binary search). */
export function lowerBound(t, ms) {
    let lo = 0, hi = t.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (t[mid] < ms) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** Value at EXACTLY `ms`, or null (no interpolation — a readout is a sample). */
export function valueAt(series, ms) {
    const i = lowerBound(series.t, ms);
    if (i >= series.t.length || series.t[i] !== ms) return null;
    return num(series.v[i]);
}

/** Time span and data health of a series. */
export function seriesExtent(series) {
    const n = series.t.length;
    let finite = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(series.v[i])) finite++;
    return {
        n,
        finite,
        gaps: n - finite,
        t0: n ? series.t[0] : null,
        t1: n ? series.t[n - 1] : null,
    };
}

/**
 * Bucket index for an instant: bucket k is [k·step + origin, (k+1)·step + origin).
 * `originMs` shifts the edges so day buckets start at the SITE's local
 * midnight; get it from `localOrigin`, the ONE place that sign lives.
 */
export function bucketIndex(ms, stepMs, originMs = 0) {
    return Math.floor((ms - originMs) / stepMs);
}

/** Start instant of bucket k. */
export function bucketStart(k, stepMs, originMs = 0) {
    return k * stepMs + originMs;
}

/**
 * Bucket origin that puts edges at the site's local midnight.
 * Local midnight satisfies (t + offset) ≡ 0 (mod day), i.e. t ≡ −offset.
 */
export function localOrigin(utcOffsetSeconds) {
    const off = num(utcOffsetSeconds) ?? 0;
    return off === 0 ? 0 : -off * 1000;
}

/**
 * Resample a series onto buckets of `stepMs`, aggregating by its own `agg`.
 * Returns a NEW series (same metadata, `cadenceMs = stepMs`) whose instants
 * are bucket STARTS. A target step at or below the native cadence returns
 * the series itself (never upsample).
 *
 * @param {object} series
 * @param {object} o
 * @param {number} o.stepMs
 * @param {number} [o.originMs=0]
 * @param {number} [o.from]  inclusive — buckets starting before are dropped
 * @param {number} [o.to]    exclusive
 * @param {number} [o.minCoverage=0.75]  fraction of expected native samples a
 *                                       bucket needs, else it is a gap
 */
export function resample(series, { stepMs, originMs = 0, from = -Infinity, to = Infinity, minCoverage = 0.75 } = {}) {
    if (!(stepMs > 0)) throw new RangeError('resample: stepMs must be > 0');
    if (stepMs <= series.cadenceMs) {
        // Never upsample — but still honour the window.
        if (from === -Infinity && to === Infinity) return series;
        const i0 = lowerBound(series.t, from);
        const i1 = lowerBound(series.t, to);
        return withSamples(series, Array.from(series.t.subarray(i0, i1)),
            Array.from(series.v.subarray(i0, i1), (x) => (Number.isFinite(x) ? x : null)), series.cadenceMs);
    }
    const expected = stepMs / series.cadenceMs;
    const need = Math.max(1, Math.ceil(expected * minCoverage - 1e-9));
    const outT = [];
    const outV = [];
    const n = series.t.length;
    let i = 0;
    while (i < n) {
        const k = bucketIndex(series.t[i], stepMs, originMs);
        const start = bucketStart(k, stepMs, originMs);
        const end = start + stepMs;
        let count = 0, acc = 0, mx = -Infinity, mn = Infinity;
        while (i < n && series.t[i] < end) {
            const x = series.v[i];
            if (Number.isFinite(x)) {
                count++; acc += x;
                if (x > mx) mx = x;
                if (x < mn) mn = x;
            }
            i++;
        }
        if (start < from || start >= to) continue;
        let val = null;
        if (count >= need) {
            switch (series.agg) {
                case 'sum': val = acc; break;
                case 'max': val = mx; break;
                case 'min': val = mn; break;
                default:    val = acc / count;
            }
        }
        outT.push(start); outV.push(val);
    }
    return withSamples(series, outT, outV, stepMs);
}

function withSamples(series, t, v, cadenceMs) {
    return makeSeries({
        ...series,
        provenance: { ...series.provenance },
        spatial: { ...series.spatial },
        cadenceMs,
        t,
        v,
    });
}

/**
 * Put several series on ONE shared bucket grid, aligned by instant. Each
 * column is resampled by its own agg first (finer series aggregate, coarser
 * ones keep their native samples and land in the bucket their instant names).
 *
 * @returns {{ t: Float64Array, columns: Float32Array[], stepMs, originMs }}
 */
export function alignToGrid(seriesList, { from, to, stepMs, originMs = 0, minCoverage = 0.75 }) {
    if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new RangeError('alignToGrid: need finite from < to');
    const k0 = bucketIndex(from, stepMs, originMs);
    const k1 = bucketIndex(to - 1, stepMs, originMs);
    const nB = Math.max(0, k1 - k0 + 1);
    const t = new Float64Array(nB);
    for (let j = 0; j < nB; j++) t[j] = bucketStart(k0 + j, stepMs, originMs);
    const columns = seriesList.map((s) => {
        const col = new Float32Array(nB).fill(NaN);
        const r = resample(s, { stepMs, originMs, minCoverage });
        for (let i = 0; i < r.t.length; i++) {
            const j = bucketIndex(r.t[i], stepMs, originMs) - k0;
            if (j >= 0 && j < nB && Number.isFinite(r.v[i])) col[j] = r.v[i];
        }
        return col;
    });
    return { t, columns, stepMs, originMs };
}
