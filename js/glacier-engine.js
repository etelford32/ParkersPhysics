/**
 * glacier-engine.js — Glacier Watch's PURE engine: decode the bake, join the
 * daily tail, and turn image pairs into a daily motion record.
 *
 * No DOM, no fetch, no ambient time (every "now" is a parameter). The page
 * (glacier-watch.html), the EarthView layer and the node gate all call this; the
 * renderers compute nothing about glaciers themselves (the Volcanoes rule).
 *
 * THE DATA (scripts/build-glacier-velocity.py, NASA ITS_LIVE v2):
 *   index  — per glacier: a FLOWLINE (a streamline of the observed 2014–2024 mean
 *            field), the climatology along it (v0, seasonal amplitude + day of peak,
 *            trend), the scenes that see the glacier, and the bake date.
 *   detail — the annual means (tile-dependent start, last year PARTIAL; moved out of
 *            the index when 25 glaciers passed its 200 KB budget — `attachDetail`),
 *            the block-averaged mean field + terrain, and the last year of
 *            short-baseline pairs, each a velocity at every flowline point.
 *   live   — /api/glaciers/velocity: pairs published since the bake, same points,
 *            same 3×3-median rule (js/glacier-pairs.js). `mergePairs` joins them.
 *
 * THE SEASONAL EXPECTATION is ITS_LIVE's own sinusoid, never ours:
 *     v(t) = v0 + A·cos(2π (doy − φ) / 365.25)
 * with A the 2014–2024 seasonal amplitude along the mean flow and φ the day of
 * the peak. "Faster than usual" means faster than THAT, for that date — so a
 * spring speed-up is not reported as news (Columbia peaks in late March).
 *
 * WHAT A PAIR IS: an average over its separation Δt (1–64 days), stamped at its
 * MIDPOINT. A daily series is therefore a smoothed estimate, and `dailySeries`
 * says how many pairs and how much time support each day rests on — a day with
 * no pair inside its window is null, never interpolated.
 */

export const NODATA = -32768;
export const DAY_MS = 864e5;
export const YEAR_DAYS = 365.25;

// ── decoding ─────────────────────────────────────────────────────────────────

function b64bytes(s) {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
}

/** base64 little-endian int16 → Float32Array (NaN for no data), times `scale`. */
export function decodeI16(s, scale = 1) {
    if (!s) return new Float32Array(0);
    const u = b64bytes(s);
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const out = new Float32Array(u.byteLength >> 1);
    for (let k = 0; k < out.length; k++) {
        const v = dv.getInt16(2 * k, true);
        out[k] = v === NODATA ? NaN : v * scale;
    }
    return out;
}

export function decodeIndex(json) {
    if (!json || json.format !== 'glacier-watch-v1') throw new Error('not a glacier-watch-v1 index');
    return json.glaciers.map(g => ({
        ...g,
        bakedMs: Date.parse(g.baked),
        flowline: { ...g.flowline },
        climatology: {
            period: g.climatology.period,
            v0: decodeI16(g.climatology.v0),
            amp: decodeI16(g.climatology.amp),
            phaseDoy: decodeI16(g.climatology.phase_doy),
            trend: decodeI16(g.climatology.trend, 0.1),
            pairErr: decodeI16(g.climatology.pair_err),
        },
        annual: g.annual ? decodeAnnual(g.annual) : null,            // since 2026-11-08 it lives in the detail file;
        annualSpan: g.annual_span || (g.annual ? [g.annual.years[0], g.annual.years.at(-1)] : null),   // attachDetail() fills it in
    }));
}

function decodeAnnual(a) { return { years: a.years.slice(), partialLast: !!a.partial_last, v: a.v.map(s => decodeI16(s)) }; }

/** Give a decoded glacier the detail-file data the index no longer carries (the annual series). */
export function attachDetail(glacier, detail) {
    if (detail?.annual) glacier.annual = detail.annual;
    return glacier;
}

export function decodePair(p) {
    const d1 = Date.parse(p.d1), d2 = Date.parse(p.d2);
    return { id: p.id, sensor: p.sensor, d1, d2, mid: (d1 + d2) / 2, dtDays: Math.round((d2 - d1) / DAY_MS), v: decodeI16(p.v), e: decodeI16(p.e), live: !!p.live };
}

export function decodeDetail(json) {
    const f = json.field;
    return {
        id: json.id, epsg: json.epsg, bakedMs: Date.parse(json.baked), dtMaxDays: json.dt_max_days, skipped: json.skipped || {},
        annual: json.annual ? decodeAnnual(json.annual) : null,
        field: { nx: f.nx, ny: f.ny, x0: f.x0, y0: f.y0, dx: f.dx, dy: f.dy, vx: decodeI16(f.vx), vy: decodeI16(f.vy), ice: decodeI16(f.ice, 0.01), z: f.z ? decodeI16(f.z) : null },
        pairs: json.pairs.map(decodePair),
    };
}

/** Baked ∪ live, de-duplicated by pair id (live wins only for ids the bake lacks), sorted by midpoint. */
export function mergePairs(baked, live = []) {
    const seen = new Map();
    for (const p of baked) seen.set(p.id, p);
    for (const p of live) if (!seen.has(p.id)) seen.set(p.id, { ...p, live: true });
    return [...seen.values()].sort((a, b) => a.mid - b.mid || (a.id < b.id ? -1 : 1));
}

// ── time ─────────────────────────────────────────────────────────────────────

/** Fractional day of year (1 = Jan 1 00:00 UTC). */
export function dayOfYear(tMs) {
    const d = new Date(tMs);
    return (tMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS + 1;
}

/**
 * Glaciological (hydrological) year: Oct 1 – Sep 30 in the north, Apr 1 – Mar 31 in
 * the south (the WGMS convention), labelled by the calendar year it ENDS in.
 */
export function hydroYear(tMs, lat) {
    const d = new Date(tMs), y = d.getUTCFullYear(), m = d.getUTCMonth();
    const startMonth = lat >= 0 ? 9 : 3;           // Oct (0-based 9) | Apr (3)
    const label = m >= startMonth ? y + 1 : y;
    return { label, startMs: Date.UTC(label - 1, startMonth, 1), endMs: Date.UTC(label, startMonth, 1) };
}

// ── the seasonal expectation ─────────────────────────────────────────────────

export function seasonalExpected(v0, amp, phaseDoy, tMs) {
    if (!Number.isFinite(v0)) return NaN;
    if (!Number.isFinite(amp) || !Number.isFinite(phaseDoy)) return v0;
    return v0 + amp * Math.cos(2 * Math.PI * (dayOfYear(tMs) - phaseDoy) / YEAR_DAYS);
}

/** The pair-averaged expectation: the sinusoid averaged over [d1, d2] (closed form). */
export function seasonalExpectedOver(v0, amp, phaseDoy, d1, d2) {
    if (!Number.isFinite(v0)) return NaN;
    if (!Number.isFinite(amp) || !Number.isFinite(phaseDoy) || d2 <= d1) return seasonalExpected(v0, amp, phaseDoy, (d1 + d2) / 2);
    const w = 2 * Math.PI / YEAR_DAYS;
    const a = dayOfYear(d1) - phaseDoy, span = (d2 - d1) / DAY_MS;
    return v0 + amp * (Math.sin(w * (a + span)) - Math.sin(w * a)) / (w * span);
}

// ── gauges along the flowline ────────────────────────────────────────────────

/**
 * Three "gauges" at fixed fractions of the flowline from its head (upper / middle /
 * lower) plus the fastest point. They are where the daily record is read; each
 * reads the median of the finite pair values within ±halfWidth points.
 */
export function gauges(glacier) {
    const n = glacier.flowline.n, v0 = glacier.climatology.v0;
    let fast = 0;
    for (let k = 1; k < n; k++) if ((v0[k] || -1) > (v0[fast] || -1)) fast = k;
    const at = f => Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))));
    return [
        { id: 'upper', label: 'Upper glacier', idx: at(0.25) },
        { id: 'middle', label: 'Mid glacier', idx: at(0.5) },
        { id: 'lower', label: 'Lower glacier', idx: at(0.85) },
        { id: 'fastest', label: 'Fastest point', idx: fast },
    ];
}

function medianOf(arr) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b), n = s.length;
    return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

export function valueNear(values, idx, halfWidth = 2) {
    const got = [];
    for (let k = Math.max(0, idx - halfWidth); k <= Math.min(values.length - 1, idx + halfWidth); k++) if (Number.isFinite(values[k])) got.push(values[k]);
    return got.length ? medianOf(got) : NaN;
}

/**
 * One gauge's pair record with each pair compared to the seasonal expectation over
 * the SAME interval, and outliers flagged by a robust rule: |residual| beyond
 * max(4·1.4826·MAD, 2·σ_pair) — never silently dropped, the page draws them hollow.
 */
export function gaugeRecord(glacier, pairs, idx, halfWidth = 2) {
    const c = glacier.climatology;
    const v0 = valueNear(c.v0, idx, halfWidth), A = valueNear(c.amp, idx, halfWidth), ph = valueNear(c.phaseDoy, idx, 0);
    const pts = [];
    for (const p of pairs) {
        const v = valueNear(p.v, idx, halfWidth);
        if (!Number.isFinite(v)) continue;
        const e = valueNear(p.e, idx, halfWidth);
        const exp = seasonalExpectedOver(v0, A, ph, p.d1, p.d2);
        pts.push({ id: p.id, t: p.mid, d1: p.d1, d2: p.d2, dtDays: p.dtDays, sensor: p.sensor, live: !!p.live, v, e: Number.isFinite(e) ? e : NaN, expected: exp, resid: v - exp });
    }
    const res = pts.map(q => q.resid).filter(Number.isFinite);
    const mad = medianOf(res.map(r => Math.abs(r - medianOf(res))));
    for (const q of pts) {
        const lim = Math.max(4 * 1.4826 * mad, 2 * (Number.isFinite(q.e) ? q.e : 0), 1e-9);
        q.outlier = !Number.isFinite(q.resid) ? false : Math.abs(q.resid - medianOf(res)) > lim;
    }
    return { idx, v0, amp: A, phaseDoy: ph, mad, points: pts };
}

/**
 * A DAILY series from a gauge record: for each day, the weighted mean of the non-outlier
 * pairs whose midpoint lies within ±windowDays/2 — weight = (1/σ²) × a TRIANGULAR taper
 * (1 − |Δt|/half), σ = the pair's own error (floor `errFloor` m/yr). The taper replaced a
 * boxcar, whose estimate jumped whenever one pair entered or left the window (seen on
 * Columbia's first render). Days with no pair → null.
 * Returns { t[], v[], sigma[], n[] } — sigma is the standard error of that mean.
 */
export function dailySeries(record, { fromMs, toMs, windowDays = 30, errFloor = 5 } = {}) {
    const pts = record.points.filter(p => !p.outlier);
    const t = [], v = [], sigma = [], n = [];
    const half = windowDays / 2 * DAY_MS;
    for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS; d <= toMs; d += DAY_MS) {
        let sw = 0, swv = 0, k = 0;
        for (const p of pts) {
            if (Math.abs(p.t - d) > half) continue;
            const s = Math.max(errFloor, Number.isFinite(p.e) ? p.e : errFloor);
            const w = (1 - Math.abs(p.t - d) / half) / (s * s);
            if (w <= 0) continue;
            sw += w; swv += w * p.v; k++;
        }
        t.push(d); n.push(k);
        if (k) { v.push(swv / sw); sigma.push(1 / Math.sqrt(sw)); } else { v.push(null); sigma.push(null); }   // σ: weighted-mean SE (taper-weighted, indicative)
    }
    return { t, v, sigma, n };
}

/**
 * "Now" for one gauge: the last `days` of non-outlier pairs against the seasonal
 * expectation. anomaly = weighted mean residual; significance from its standard
 * error (inverse-variance, error floor applied). The label only claims a change
 * when |anomaly| > 2σ AND > 5 % of the expectation; otherwise "within normal range".
 */
export function currentState(record, nowMs, { days = 45, errFloor = 5, detect = null } = {}) {
    if (detect && !detect.ok) {
        const latest = record.points.filter(p => !p.outlier).reduce((a, p) => (!a || p.d2 > a.d2 ? p : a), null);
        return { n: 0, latest, state: 'undetectable', label: 'motion below what the satellites resolve here' };
    }
    const pts = record.points.filter(p => !p.outlier && p.t >= nowMs - days * DAY_MS && p.t <= nowMs && Number.isFinite(p.resid));
    const latest = record.points.filter(p => !p.outlier).reduce((a, p) => (!a || p.d2 > a.d2 ? p : a), null);
    if (!pts.length) return { n: 0, latest, label: 'no recent pairs', state: 'unknown' };
    let sw = 0, swr = 0, swe = 0;
    for (const p of pts) {
        const s = Math.max(errFloor, Number.isFinite(p.e) ? p.e : errFloor), w = 1 / (s * s);
        sw += w; swr += w * p.resid; swe += w * p.expected;
    }
    const anomaly = swr / sw, se = 1 / Math.sqrt(sw), expected = swe / sw;
    const pct = expected > 0 ? 100 * anomaly / expected : NaN;
    const sig = Math.abs(anomaly) > 2 * se && Math.abs(pct) > 5;
    const state = !sig ? 'normal' : anomaly > 0 ? 'faster' : 'slower';
    const label = state === 'normal' ? 'within normal range for the season'
        : `${Math.abs(pct).toFixed(0)}% ${state} than usual for the season`;
    return { n: pts.length, latest, anomaly, se, expected, pct, state, label };
}

/**
 * Is motion at this point DETECTABLE by the pairs? The 2014–2024 mean speed must exceed
 * twice the median ITS_LIVE error of the year's kept pairs there. Small slow glaciers fail
 * this (South Cascade's mean is ~1 m/yr against pair errors of tens of m/yr) — their pairs
 * are noise and the page must say so rather than draw a "record".
 */
export function detectable(glacier, idx, halfWidth = 2) {
    const v0 = valueNear(glacier.climatology.v0, idx, halfWidth);
    const err = valueNear(glacier.climatology.pairErr || [], idx, halfWidth);
    if (!Number.isFinite(v0)) return { ok: false, v0, err, reason: 'no mean field here' };
    if (!Number.isFinite(err)) return { ok: true, v0, err, reason: 'no pair errors recorded' };
    return { ok: v0 > 2 * err, v0, err, reason: v0 > 2 * err ? '' : 'below detection' };
}

// ── decades ──────────────────────────────────────────────────────────────────

/** Annual means at a gauge (the composites), skipping the PARTIAL last year unless asked. */
export function annualAt(glacier, idx, { includePartial = false, halfWidth = 2 } = {}) {
    const { years, v, partialLast } = glacier.annual;
    const out = [];
    for (let k = 0; k < years.length; k++) {
        if (partialLast && k === years.length - 1 && !includePartial) continue;
        const val = valueNear(v[k], idx, halfWidth);
        if (Number.isFinite(val)) out.push({ year: years[k], v: val, partial: partialLast && k === years.length - 1 });
    }
    return out;
}

/** Ordinary least squares slope (per year) over [fromYear, toYear]; null with < 5 years. */
export function linearTrend(series, fromYear = -Infinity, toYear = Infinity) {
    const s = series.filter(p => p.year >= fromYear && p.year <= toYear);
    if (s.length < 5) return null;
    const n = s.length, mx = s.reduce((a, p) => a + p.year, 0) / n, my = s.reduce((a, p) => a + p.v, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of s) { sxx += (p.year - mx) ** 2; sxy += (p.year - mx) * (p.v - my); syy += (p.v - my) ** 2; }
    const slope = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
    const resid = s.reduce((a, p) => a + (p.v - (my + slope * (p.year - mx))) ** 2, 0);
    const seSlope = n > 2 ? Math.sqrt(resid / (n - 2) / sxx) : NaN;
    return { slope, intercept: my - slope * mx, r, seSlope, n, from: s[0].year, to: s[n - 1].year };
}

// ── the particle view: advection through the OBSERVED mean field ─────────────

/** Bilinear sampler of the baked field in map coordinates → [vx, vy] m/yr, or null off-ice / no data. */
export function fieldSampler(field, iceMin = 0.5) {
    const { nx, ny, x0, y0, dx, dy, vx, vy, ice } = field;
    return (x, y) => {
        const fj = (x - x0) / dx, fi = (y - y0) / dy;
        const j = Math.floor(fj), i = Math.floor(fi);
        if (i < 0 || j < 0 || i >= ny - 1 || j >= nx - 1) return null;
        const a = fj - j, b = fi - i;
        let su = 0, sv = 0, sw = 0, si = 0;
        for (const [di, dj, w] of [[0, 0, (1 - a) * (1 - b)], [0, 1, a * (1 - b)], [1, 0, (1 - a) * b], [1, 1, a * b]]) {
            const k = (i + di) * nx + (j + dj);
            si += w * (Number.isFinite(ice[k]) ? ice[k] : 0);
            if (!Number.isFinite(vx[k]) || !Number.isFinite(vy[k])) continue;
            su += w * vx[k]; sv += w * vy[k]; sw += w;
        }
        if (si < iceMin || sw < 0.5) return null;
        return [su / sw, sv / sw];
    };
}

/** One midpoint (RK2) step of dtYears; returns the new [x, y] or null when the parcel leaves the ice. */
export function advect(sample, x, y, dtYears) {
    const k1 = sample(x, y);
    if (!k1) return null;
    const k2 = sample(x + 0.5 * dtYears * k1[0], y + 0.5 * dtYears * k1[1]);
    if (!k2) return null;
    return [x + dtYears * k2[0], y + dtYears * k2[1]];
}

/**
 * True north as a unit vector in the map grid: least-squares plane lat ≈ a + b·x + c·y over
 * the flowline points, north = ∇lat / |∇lat|. In UTM that is ~0–3° off the grid's +y; in
 * polar stereographic (Greenland, EPSG:3413) it can be anything — which is the point.
 */
export function northInGrid(flowline) {
    const { x, y, lat } = flowline, n = x.length;
    if (n < 3) return [0, 1];
    const mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n, ml = lat.reduce((a, v) => a + v, 0) / n;
    let sxx = 0, syy = 0, sxy = 0, sxl = 0, syl = 0;
    for (let k = 0; k < n; k++) {
        const dx = x[k] - mx, dy = y[k] - my, dl = lat[k] - ml;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxl += dx * dl; syl += dy * dl;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9 * (sxx * syy + 1)) return [0, 1];          // collinear points: assume grid north
    const b = (sxl * syy - syl * sxy) / det, c = (syl * sxx - sxl * sxy) / det, m = Math.hypot(b, c);
    return m > 0 ? [b / m, c / m] : [0, 1];
}

// ── the ice body: thickness, bed, stress, flux — the "density analysis" ────────

export const RHO_ICE = 917;          // kg m⁻³
export const G = 9.81;               // m s⁻²
export const GLEN_N = 3;
export const GLEN_A = 2.4e-24;       // Pa⁻³ s⁻¹ — temperate ice, Cuffey & Paterson (2010) Table 3.4
export const SEC_PER_YR = 365.25 * 86400;

/** Separable Gaussian smoothing on a row-major ny×nx grid, NaN-aware (weights renormalised). */
export function smoothGrid(a, nx, ny, sigma) {
    const r = Math.max(1, Math.ceil(3 * sigma)), k = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-0.5 * (i / sigma) ** 2));
    const pass = (src, horiz) => {
        const out = new Float64Array(src.length).fill(NaN);
        for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
            let sw = 0, sv = 0;
            for (let t = -r; t <= r; t++) {
                const ii = horiz ? i : i + t, jj = horiz ? j + t : j;
                if (ii < 0 || jj < 0 || ii >= ny || jj >= nx) continue;
                const v = src[ii * nx + jj];
                if (Number.isFinite(v)) { sw += k[t + r]; sv += k[t + r] * v; }
            }
            if (sw > 0.3) out[i * nx + j] = sv / sw;
        }
        return out;
    };
    return pass(pass(a, true), false);
}

/**
 * The ice body from what we OBSERVE (surface speed, ITS_LIVE) and what we MEASURE (surface
 * elevation, GLO-30) — a MODEL, and every page that draws it says so.
 *
 *   slope α   from the surface smoothed over ~2 ice thicknesses (σ = slopeSigmaM), floored
 *             at minSlopeDeg (a flat surface would make every estimate infinite);
 *   H_def     shallow-ice approximation, ALL surface motion taken as internal deformation:
 *             u_s = 2A/(n+1) · (ρ g sin α)ⁿ · Hⁿ⁺¹  ⇒  H = [ (n+1) u_s / (2A (ρ g sin α)ⁿ) ]^{1/(n+1)}
 *             Where the glacier SLIDES this over-estimates (part of u_s is not deformation);
 *   H_pl      perfectly-plastic bound H = τ_y / (ρ g sin α), τ_y = tauYieldKPa: ice cannot sustain
 *             a much larger driving stress, so this caps the fast, sliding outlets;
 *   H         = min(H_def, H_pl) on ice cells (ice fraction ≥ 0.5), 0 elsewhere;
 *   bed       = surface − H;   τ_d = ρ g H sin α;   q = (n+1)/(n+2) · u_s · H  (SIA depth-average × H);
 *   volume / mass over the ice cells INSIDE THE MAP WINDOW (an ice-sheet outlet extends past it).
 *
 * Calving fronts, floating tongues and the bed of an ice sheet are outside what the SIA can
 * represent; the result carries `assumptions` for the page to print verbatim.
 */
export function iceModel(field, { slopeSigmaM = 1000, minSlopeDeg = 1.5, tauYieldKPa = 150, A = GLEN_A, n = GLEN_N } = {}) {
    const { nx, ny, dx, dy, vx, vy, ice, z } = field;
    const N = nx * ny, cell = Math.abs(dx * dy);
    const zs = smoothGrid(z, nx, ny, Math.max(1, slopeSigmaM / Math.abs(dx)));
    const H = new Float32Array(N), bed = new Float32Array(N), tau = new Float32Array(N).fill(NaN), q = new Float32Array(N).fill(NaN);
    const slope = new Float32Array(N).fill(NaN), speed = new Float32Array(N).fill(NaN);
    const sinMin = Math.sin(minSlopeDeg * Math.PI / 180), rg = RHO_ICE * G, tauY = tauYieldKPa * 1e3;
    let vol = 0, nIce = 0, capped = 0, Hmax = 0;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
        const k = i * nx + j;
        bed[k] = z[k];
        if (!(ice[k] >= 0.5) || !Number.isFinite(z[k])) continue;
        const gx = (zs[i * nx + Math.min(nx - 1, j + 1)] - zs[i * nx + Math.max(0, j - 1)]) / ((Math.min(nx - 1, j + 1) - Math.max(0, j - 1)) * Math.abs(dx));
        const gy = (zs[Math.min(ny - 1, i + 1) * nx + j] - zs[Math.max(0, i - 1) * nx + j]) / ((Math.min(ny - 1, i + 1) - Math.max(0, i - 1)) * Math.abs(dy));
        const grad = Math.hypot(gx, gy);
        if (!Number.isFinite(grad)) continue;
        const sa = Math.max(sinMin, Math.sin(Math.atan(grad)));
        slope[k] = Math.atan(grad) * 180 / Math.PI;
        const us = Number.isFinite(vx[k]) && Number.isFinite(vy[k]) ? Math.hypot(vx[k], vy[k]) : 0;
        speed[k] = us;
        const hDef = us > 0 ? Math.pow((n + 1) * (us / SEC_PER_YR) / (2 * A * Math.pow(rg * sa, n)), 1 / (n + 1)) : 0;
        const hPl = tauY / (rg * sa);
        const h = Math.min(hDef, hPl);
        if (hPl < hDef) capped++;
        H[k] = h; bed[k] = z[k] - h;
        tau[k] = rg * h * sa / 1e3;
        q[k] = (n + 1) / (n + 2) * us * h;
        vol += h * cell; nIce++; if (h > Hmax) Hmax = h;
    }
    return {
        H, bed, tau, q, slope, speed,
        volumeKm3: vol / 1e9, massGt: vol * RHO_ICE / 1e12, iceAreaKm2: nIce * cell / 1e6,
        meanH: nIce ? vol / (nIce * cell) : NaN, maxH: Hmax, cappedFraction: nIce ? capped / nIce : NaN,
        assumptions: { A, n, rho: RHO_ICE, tauYieldKPa, minSlopeDeg, slopeSigmaM, note: 'shallow-ice inversion of observed surface speed (no sliding), capped by the perfectly-plastic bound; window only' },
    };
}

/**
 * iceModel options by glacier type — the slope must be averaged over a few ICE THICKNESSES
 * (Paterson), so the length scale grows with the ice. With one mountain-glacier setting
 * (1 km, floor 1.5°) every ice-sheet outlet hit the plastic cap at the slope floor — max
 * H = 637 m at Columbia AND Jakobshavn (2026-11-08 review), where Jakobshavn's trough is
 * ~2 km deep. The floor is a guard against a flat-surface blow-up, not a physical slope.
 */
export function iceModelOptions(kind) {
    if (kind === 'ice-sheet outlet') return { slopeSigmaM: 4000, minSlopeDeg: 0.35 };
    // a PIEDMONT lobe (Malaspina) spreads on a nearly flat plain: the mountain 1.5° floor capped a fifth of it
    if (kind === 'tidewater' || kind === 'lake-calving' || kind === 'piedmont') return { slopeSigmaM: 2000, minSlopeDeg: 0.8 };
    return { slopeSigmaM: 1000, minSlopeDeg: 1.5 };
}

// ── mass balance (WGMS glaciological series) ─────────────────────────────────

/** Rows { year, winter, summer, annual } in m w.e. → cumulative annual balance from the first year. */
export function cumulativeBalance(rows) {
    // A MISSING YEAR IS NOT A ZERO BALANCE: summing across a gap books every unmeasured year as
    // "no change" (Rhône's 1910–2006 gap is 93 such years; Great Aletsch's 2000–2019 the most
    // negative two decades of its record). The running total therefore RESTARTS after any gap:
    // each row carries its unbroken `run` and the year that run starts (`since`).
    const out = [];
    let c = 0, prev = null, run = -1, since = null;
    for (const r of rows.filter(q => Number.isFinite(q.annual)).sort((a, b) => a.year - b.year)) {
        if (prev === null || r.year !== prev + 1) { run++; c = 0; since = r.year; }
        c += r.annual; prev = r.year;
        out.push({ year: r.year, annual: r.annual, cumulative: c, run, since });
    }
    return out;
}

/** The most recent unbroken run of a cumulativeBalance() result (what a single number may quote). */
export function latestRun(cum) {
    const k = cum.at(-1)?.run;
    return k === undefined ? [] : cum.filter(c => c.run === k);
}
