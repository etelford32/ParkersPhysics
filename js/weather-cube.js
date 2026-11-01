/**
 * weather-cube.js — ONE answer to "what is the weather at (lat, lon, t)?"
 *
 * EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §3 (T1). PURE: no DOM, no three.js,
 * no fetch, no ambient time (callers pass `nowMs` where it matters), relative
 * imports only — so a module Worker can load it and node can test it.
 *
 * What it is
 * ──────────
 * A read-only FACADE over the rings EarthView already keeps. It stores no
 * frames of its own; it indexes theirs:
 *
 *   history  — js/weather-history.js WeatherHistory. Observed tier (hourly,
 *              ≤72 rows, IDB-backed) + the Open-Meteo forecast tier (≤336
 *              rows, memory-only). Rows carry `isForecast`.
 *   nowcast  — js/weather-forecast.js ForecastPaintProvider. The in-browser
 *              RK2 model's dense 0..24 h set, h = 0 at the newest
 *              observation.
 *
 * Every answer carries its PROVENANCE ('observed' | 'nowcast' | 'nwp'), the
 * upstream source string, whether the row was served stale, and whether the
 * instant is outside the data (`held`) — so a consumer can never show a
 * forecast under an "observed" label, or a frozen edge frame as weather.
 *
 * Which frame wins (the resolver's rules, moved here so every consumer gets
 * them — js/weather-frame-resolver.js stays the RENDER path until the GPU
 * time atlas (T3) replaces it; the parity is gated in tests/weather-cube.mjs):
 *
 *   1. The nowcast owns (first target, last target) — its h = 0 frame IS the
 *      newest observation, so the observed→nowcast join has no seam. The
 *      observation hour itself stays labelled 'observed' (the resolver hands
 *      that exact instant to the model; the value is the same frame).
 *   2. Within SEAM_BLEND_MS of the nowcast's last target, if the history
 *      ring has an NWP frame at t, the value crossfades model → NWP:
 *      w = 0 at (edge − SEAM_BLEND_MS), 1 at edge. Same constant, same ramp
 *      as WeatherFrameResolver._dispatchSeamBlend.
 *   3. Everywhere else, the merged history ring: observed rows first, then
 *      NWP rows; on an hour-key collision the OBSERVATION wins (the
 *      WeatherHistory.bracket rule — a stale forecast row that has become
 *      past must never shadow the measurement for that hour).
 *
 * Fast on purpose
 * ───────────────
 * WeatherHistory.bracket() concatenates and sorts up to 408 rows on EVERY
 * call. The cube builds its merged index ONCE per data change (both sources
 * expose a monotonically increasing `version`), and `series()` walks the
 * index with a moving cursor and ONE set of bilinear weights — a 21-day
 * hourly series of five variables is a few hundred thousand multiply-adds.
 *
 * Geometry
 * ────────
 * Coarse frames are channel-major (CHW), row-major (lat slow, lon fast),
 * cell CENTRES at the canonical grid of js/open-meteo-request.js GRID:
 * lat = −90 + Δ/2 + j·Δ, lon = −180 + Δλ/2 + i·Δλ. Longitude wraps; latitude
 * clamps at the outermost row centres. NOTE the renderer's decodeCoarse
 * stretches the outer centres onto the poles/edges when it upsamples, so a
 * cube value and the drawn texel can differ by a fraction of a cell; the
 * cube follows where the data was actually sampled.
 *
 * Gaps are NULL, never 0 (the pollution-lab scar: `Number(null)` is 0 and
 * finite). A non-finite channel value, or any corner of the bilinear stencil
 * that is non-finite, yields null.
 */

import { dewPointC } from './composite-indices.js';

// ── Provenance vocabulary (plan §2.1 — shared with cloud-time.js modes) ─────
export const PROVENANCE = Object.freeze({
    OBSERVED: 'observed',
    NOWCAST:  'nowcast',
    NWP:      'nwp',
});

/** Short consumer-facing labels. One table so every surface says the same. */
export const PROVENANCE_LABEL = Object.freeze({
    observed: 'Observed',
    nowcast:  'Nowcast (in-browser model)',
    nwp:      'Forecast (NWP)',
});

/** Same constant as js/weather-frame-resolver.js DEFAULT_SEAM_BLEND_MS. */
export const SEAM_BLEND_MS = 4 * 3_600_000;

/** Frames further apart than this are a GAP, not something to interpolate across. */
export const MAX_INTERP_GAP_MS = 3 * 3_600_000;

const HOUR_MS = 3_600_000;

// ── Variables ────────────────────────────────────────────────────────────────
// Raw channels = the 9-channel CHW contract of js/weather-history.js. New
// variables join the cube as new SOURCES, never as new channels here
// (plan §1 — the contract is shared with IDB, the validator and the worker).
export const CHANNEL = Object.freeze({
    t2m: 0,        // °C
    mslp: 1,       // hPa, mean sea-level
    rh: 2,         // %
    u10: 3,        // m/s eastward
    v10: 4,        // m/s northward
    cloudLow: 5,   // %
    cloudMid: 6,   // %
    cloudHigh: 7,  // %
    precip: 8,     // mm/h
});

/**
 * Derived variables: computed from interpolated raw channels at the sample
 * point (never interpolated themselves — interpolating a direction or a
 * dew point across frames is wrong in different ways).
 */
const DERIVED = {
    wind:       { needs: ['u10', 'v10'], fn: (c) => Math.hypot(c.u10, c.v10) },
    // Meteorological convention: the direction the wind blows FROM, 0 = N.
    windDirDeg: { needs: ['u10', 'v10'], fn: (c) => (Math.atan2(-c.u10, -c.v10) * 180 / Math.PI + 360) % 360 },
    // Random overlap of the three decks — a stated approximation; the
    // upstream total-cloud field is not part of the 9-channel contract.
    cloudTotal: { needs: ['cloudLow', 'cloudMid', 'cloudHigh'],
                  fn: (c) => 100 * (1 - (1 - clamp01(c.cloudLow / 100)) * (1 - clamp01(c.cloudMid / 100)) * (1 - clamp01(c.cloudHigh / 100))) },
    dewpoint:   { needs: ['t2m', 'rh'], fn: (c) => dewPointC(c.t2m, c.rh) },
};

export const VARIABLES = Object.freeze([...Object.keys(CHANNEL), ...Object.keys(DERIVED)]);

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Raw channels a variable list needs, deduplicated, in CHANNEL order. */
function rawNeeds(vars) {
    const set = new Set();
    for (const v of vars) {
        if (v in CHANNEL) set.add(v);
        else if (v in DERIVED) for (const n of DERIVED[v].needs) set.add(n);
        else throw new RangeError(`weather-cube: unknown variable '${v}'`);
    }
    return Object.keys(CHANNEL).filter((k) => set.has(k));
}

// ── Bilinear stencil on the cell-centre grid ─────────────────────────────────

/**
 * Four corner indices + weights for (lat, lon) on a gridW×gridH cell-centre
 * grid. Pure; reused across every frame that shares the grid.
 */
export function stencil(lat, lon, gridW, gridH) {
    const dLat = 180 / gridH;
    const dLon = 360 / gridW;
    // Fractional row from the first centre; clamp to the outer centres.
    let fy = (lat - (-90 + dLat / 2)) / dLat;
    if (fy < 0) fy = 0;
    if (fy > gridH - 1) fy = gridH - 1;
    const j0 = Math.min(Math.floor(fy), gridH - 2 < 0 ? 0 : gridH - 2);
    const j1 = Math.min(j0 + 1, gridH - 1);
    const ty = fy - j0;
    // Fractional column, wrapped into [0, gridW).
    let fx = (lon - (-180 + dLon / 2)) / dLon;
    fx = ((fx % gridW) + gridW) % gridW;
    const i0 = Math.floor(fx) % gridW;
    const i1 = (i0 + 1) % gridW;
    const tx = fx - Math.floor(fx);
    return {
        k: [j0 * gridW + i0, j0 * gridW + i1, j1 * gridW + i0, j1 * gridW + i1],
        w: [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty],
        n: gridW * gridH,
    };
}

/** One channel of one CHW frame at a stencil; null on any non-finite corner. */
function at(coarse, ch, st) {
    const base = ch * st.n;
    let s = 0;
    for (let q = 0; q < 4; q++) {
        const wq = st.w[q];
        if (wq === 0) continue;
        const v = coarse[base + st.k[q]];
        if (!Number.isFinite(v)) return null;
        s += wq * v;
    }
    return s;
}

function lerpN(a, b, f) {
    if (a == null || b == null) return null;
    return a + (b - a) * f;
}

// ── Source adapters ──────────────────────────────────────────────────────────

function readVersion(obj) {
    const v = obj?.version;
    return Number.isFinite(v) ? v : 0;
}

/** Normalise a WeatherHistory (or a test double with the same surface). */
function historyEntries(history) {
    const past = typeof history.all === 'function' ? history.all() : [];
    const fc   = typeof history.allForecasts === 'function' ? history.allForecasts() : [];
    const byKey = new Map();
    // Forecast rows first, observations second: an observation OVERWRITES a
    // forecast row at the same hour key (the bracket() collision rule).
    for (const r of fc)   if (validRow(r)) byKey.set(r.t, entryOf(r, PROVENANCE.NWP));
    for (const r of past) if (validRow(r)) byKey.set(r.t, entryOf(r, r.isForecast ? PROVENANCE.NWP : PROVENANCE.OBSERVED));
    return [...byKey.values()].sort((a, b) => a.t - b.t);
}

function validRow(r) {
    return r && Number.isFinite(r.t) && r.coarse && Number.isFinite(r.gridW) && Number.isFinite(r.gridH)
        && r.coarse.length >= r.gridW * r.gridH * 9;
}

function entryOf(r, provenance) {
    return {
        t: r.t,
        coarse: r.coarse,
        gridW: r.gridW,
        gridH: r.gridH,
        provenance,
        source: r.source ?? null,
        stale: r.freshness === 'stale',
    };
}

/** Normalise a ForecastPaintProvider (public `coarseFrames()` + meta). */
function nowcastEntries(provider) {
    if (!provider || typeof provider.coarseFrames !== 'function') return [];
    const frames = provider.coarseFrames();
    const out = [];
    for (const f of frames) {
        if (!f || !Number.isFinite(f.t) || !f.coarse) continue;
        out.push({
            t: f.t,
            coarse: f.coarse,
            gridW: f.gridW,
            gridH: f.gridH,
            provenance: PROVENANCE.NOWCAST,
            source: f.source ?? null,
            stale: false,
        });
    }
    return out.sort((a, b) => a.t - b.t);
}

// ── Bracketing on a sorted entry array ───────────────────────────────────────

/** First index with entry.t > t (upper bound). */
function upper(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * { a, b, frac, held } from a sorted lane. `held` = t is outside the lane or
 * inside a gap wider than MAX_INTERP_GAP_MS (the nearer frame is returned so
 * the RENDER can keep showing something, but data consumers must not call it
 * weather).
 */
function bracketLane(arr, t) {
    if (arr.length === 0) return null;
    const u = upper(arr, t);
    if (u === 0) return { a: arr[0], b: arr[0], frac: 0, held: t < arr[0].t };
    if (u === arr.length) {
        const last = arr[arr.length - 1];
        return { a: last, b: last, frac: 0, held: t > last.t };
    }
    const a = arr[u - 1], b = arr[u];
    const span = b.t - a.t;
    if (span > MAX_INTERP_GAP_MS) {
        // Exactly on a frame is data, even at the edge of a gap.
        if (t === a.t) return { a, b: a, frac: 0, held: false };
        const near = (t - a.t) <= (b.t - t) ? a : b;
        return { a: near, b: near, frac: 0, held: true };
    }
    return { a, b, frac: span > 0 ? (t - a.t) / span : 0, held: false };
}

// ── The cube ─────────────────────────────────────────────────────────────────

export class WeatherCube {
    /**
     * @param {object} opts
     * @param {object} [opts.history]  WeatherHistory (all/allForecasts/version)
     * @param {object} [opts.nowcast]  ForecastPaintProvider (coarseFrames/version)
     * @param {number} [opts.seamBlendMs=SEAM_BLEND_MS]
     */
    constructor({ history = null, nowcast = null, seamBlendMs = SEAM_BLEND_MS } = {}) {
        this._history = history;
        this._nowcast = nowcast;
        this._seamBlendMs = seamBlendMs;
        this._base = [];      // merged history lane (observed + nwp), sorted
        this._now  = [];      // nowcast lane, sorted
        this._seenVersions = null;
        this._stencilCache = new Map();
        this._version = 0;    // bumps whenever the index is rebuilt
    }

    setNowcast(provider) { this._nowcast = provider; this._seenVersions = null; }
    setHistory(history)  { this._history = history;  this._seenVersions = null; }

    /** Monotonic: changes exactly when the indexed data changed. */
    get version() { this._sync(); return this._version; }

    /** Rebuild the lanes only when a source's version moved. O(1) otherwise. */
    _sync() {
        const hv = this._history ? readVersion(this._history) : -1;
        const nv = this._nowcast ? readVersion(this._nowcast) : -1;
        // Sizes guard sources without a version counter (test doubles,
        // older builds): a size change still invalidates.
        const hs = this._history ? (this._history.size ?? 0) + 1000 * (this._history.forecastSize ?? 0) : -1;
        const sig = `${hv}|${nv}|${hs}`;
        if (sig === this._seenVersions) return;
        this._seenVersions = sig;
        this._base = this._history ? historyEntries(this._history) : [];
        this._now  = this._nowcast ? nowcastEntries(this._nowcast) : [];
        this._version++;
    }

    _stencil(lat, lon, gridW, gridH) {
        const key = `${lat}|${lon}|${gridW}|${gridH}`;
        let st = this._stencilCache.get(key);
        if (!st) {
            if (this._stencilCache.size > 64) this._stencilCache.clear();
            st = stencil(lat, lon, gridW, gridH);
            this._stencilCache.set(key, st);
        }
        return st;
    }

    /**
     * Resolve which frames answer for `t` — the one rule every consumer
     * shares. Returns null when there is no data at all.
     *
     * @returns {null | {
     *   lane: 'nowcast'|'base', a, b, frac, held,
     *   blend: null | { w, nwp: {a, b, frac} },
     *   provenance, source, stale }}
     */
    resolve(t) {
        this._sync();
        const now = this._now;
        if (now.length >= 2 && t > now[0].t && t < now[now.length - 1].t) {
            const nb = bracketLane(now, t);
            const edge = now[now.length - 1].t;
            let blend = null;
            if (this._seamBlendMs > 0 && t > edge - this._seamBlendMs) {
                const hb = bracketLane(this._base, t);
                if (hb && !hb.held && hb.a.provenance === PROVENANCE.NWP) {
                    let w = (t - (edge - this._seamBlendMs)) / this._seamBlendMs;
                    w = w < 0 ? 0 : w > 1 ? 1 : w;
                    blend = { w, nwp: hb };
                }
            }
            return { lane: 'nowcast', ...nb, blend, provenance: PROVENANCE.NOWCAST,
                     source: nb.a.source, stale: false };
        }
        const hb = bracketLane(this._base, t);
        if (!hb) return null;
        // A bracket that straddles the observed→NWP boundary takes the LATER
        // frame's label once past the newest observation: the value at t is
        // already part forecast.
        const label = hb.frac > 0 && hb.b.provenance !== hb.a.provenance ? hb.b : hb.a;
        return { lane: 'base', ...hb, blend: null, provenance: label.provenance,
                 source: label.source, stale: !!(hb.a.stale || hb.b.stale) };
    }

    /** Raw channel at a resolved bracket, honouring the seam blend. */
    _channelAt(r, ch, lat, lon) {
        const sa = this._stencil(lat, lon, r.a.gridW, r.a.gridH);
        const sb = r.b === r.a ? sa : this._stencil(lat, lon, r.b.gridW, r.b.gridH);
        const va = at(r.a.coarse, ch, sa);
        const v  = r.b === r.a ? va : lerpN(va, at(r.b.coarse, ch, sb), r.frac);
        if (!r.blend) return v;
        const n = r.blend.nwp;
        const na = at(n.a.coarse, ch, this._stencil(lat, lon, n.a.gridW, n.a.gridH));
        const nv = n.b === n.a ? na : lerpN(na, at(n.b.coarse, ch, this._stencil(lat, lon, n.b.gridW, n.b.gridH)), n.frac);
        // out = model·(1−w) + nwp·w  — the resolver's in-place _lerpInto order.
        return lerpN(v, nv, r.blend.w);
    }

    /**
     * One variable at one point and instant.
     * @returns {{ value: number|null, provenance, source, stale, held, frameT: [number, number], blendW: number|null } | null}
     */
    sample(variable, lat, lon, t) {
        const out = this.sampleMany([variable], lat, lon, t);
        if (!out) return null;
        return { ...out.meta, value: out.values[variable] };
    }

    /** Several variables at one point/instant, one resolve. */
    sampleMany(vars, lat, lon, t) {
        const r = this.resolve(t);
        if (!r) return null;
        const raw = {};
        for (const name of rawNeeds(vars)) raw[name] = this._channelAt(r, CHANNEL[name], lat, lon);
        const values = {};
        for (const v of vars) values[v] = valueOf(v, raw);
        return {
            values,
            meta: {
                provenance: r.provenance,
                source: r.source,
                stale: r.stale,
                held: r.held,
                frameT: [r.a.t, r.b.t],
                blendW: r.blend ? r.blend.w : null,
            },
        };
    }

    /**
     * A point time series — what the time-bar meteogram draws.
     * Held samples (outside the data, or inside a gap) are NULL unless
     * `hold: true`; a series is a claim about the weather, a frozen edge
     * frame is not.
     *
     * @param {string[]} vars
     * @param {number} lat
     * @param {number} lon
     * @param {number} t0  inclusive
     * @param {number} t1  inclusive
     * @param {object} [opts]
     * @param {number} [opts.stepMs=HOUR_MS]
     * @param {boolean} [opts.hold=false]
     * @returns {{ t: Float64Array, values: Object<string, Float32Array>, provenance: string[], stale: Uint8Array, version: number }}
     */
    series(vars, lat, lon, t0, t1, { stepMs = HOUR_MS, hold = false } = {}) {
        this._sync();
        if (!(stepMs > 0) || !(t1 >= t0)) throw new RangeError('weather-cube.series: bad range');
        const n = Math.floor((t1 - t0) / stepMs) + 1;
        const t = new Float64Array(n);
        const values = {};
        for (const v of vars) values[v] = new Float32Array(n).fill(NaN);
        const provenance = new Array(n).fill(null);
        const stale = new Uint8Array(n);
        const need = rawNeeds(vars);
        const raw = {};
        for (let s = 0; s < n; s++) {
            const ts = t0 + s * stepMs;
            t[s] = ts;
            const r = this.resolve(ts);
            if (!r || (r.held && !hold)) continue;
            for (const name of need) raw[name] = this._channelAt(r, CHANNEL[name], lat, lon);
            for (const v of vars) {
                const x = valueOf(v, raw);
                values[v][s] = x == null ? NaN : x;
            }
            provenance[s] = r.provenance;
            stale[s] = r.stale ? 1 : 0;
        }
        return { t, values, provenance, stale, version: this._version };
    }

    /**
     * What exists where on the time axis: runs of one provenance, split at
     * gaps wider than MAX_INTERP_GAP_MS. What the time-bar band draws.
     * Frames are hour-cadence, so a run spans [first frame, last frame].
     *
     * @returns {{ t0: number, t1: number, provenance: string, stale: boolean, source: string|null }[]}
     */
    coverage() {
        this._sync();
        const now = this._now;
        const nowLo = now.length >= 2 ? now[0].t : Infinity;
        const nowHi = now.length >= 2 ? now[now.length - 1].t : -Infinity;
        // The timeline is the base lane with the nowcast's window cut out:
        // observations up to and including the issue hour, the nowcast's
        // frames after it up to its edge, the NWP lane beyond the edge.
        const pts = [];
        for (const e of this._base) {
            if (e.t > nowLo && e.t <= nowHi) continue;
            pts.push(e);
        }
        if (now.length >= 2) for (const e of now) if (e.t > nowLo) pts.push(e);
        pts.sort((a, b) => a.t - b.t);

        const runs = [];
        let cur = null;
        for (const e of pts) {
            const joined = cur && e.t - cur.t1 <= MAX_INTERP_GAP_MS;
            if (joined && cur.provenance === e.provenance && cur.stale === e.stale) { cur.t1 = e.t; continue; }
            // A change of provenance within the interpolation gap joins edge
            // to edge (the interval between the two frames already belongs to
            // the later claim — resolve() labels it that way too).
            cur = { t0: joined ? cur.t1 : e.t, t1: e.t, provenance: e.provenance, stale: e.stale, source: e.source };
            runs.push(cur);
        }
        return runs;
    }

    /** Diagnostics for the page hook / tests. */
    stats() {
        this._sync();
        return {
            version: this._version,
            baseFrames: this._base.length,
            nowcastFrames: this._now.length,
            observed: this._base.filter((e) => e.provenance === PROVENANCE.OBSERVED).length,
            nwp: this._base.filter((e) => e.provenance === PROVENANCE.NWP).length,
            span: this._base.length ? [this._base[0].t, this._base[this._base.length - 1].t] : null,
        };
    }
}

function valueOf(v, raw) {
    if (v in CHANNEL) return raw[v] ?? null;
    const d = DERIVED[v];
    for (const n of d.needs) if (raw[n] == null) return null;
    const x = d.fn(raw);
    return Number.isFinite(x) ? x : null;
}

export default WeatherCube;
