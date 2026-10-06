/**
 * temperature-normals.js — the ONE reader of the Planetary Temperature Lab's
 * 1991–2020 ERA5 normals (PLANETARY_TEMPERATURE_LAB_PLAN.md §3.1, §4.2, §4.6)
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no fetch, no ambient time. The Edge route, the lab page, the
 * EarthView panel and `node tests/temperature-normals.mjs` all import this file,
 * so "what is normal here today" has one definition.
 *
 * The assets are built offline by scripts/build-temperature-normals.py and the
 * gate is a Python-computed fixture (tests/fixtures/temperature/normals-check.json)
 * evaluated from the SAME quantised integers that ship — the reader is checked
 * against what is committed, never against itself (the SGP4 lesson).
 *
 * ── The four files (all one container, "PTLN") ──────────────────────────────
 *   bytes 0–3   ASCII "PTLN"
 *   bytes 4–7   u32 LE: length of the JSON header INCLUDING its space padding
 *   header      UTF-8 JSON (version, kind, grid, harmonic orders, scales,
 *               provenance, licence); padded so the body starts 2-byte aligned
 *   body        int16 LE. Temperatures are centi-°C (the constant term is
 *               absolute °C; harmonic terms are differences), variances K²×20
 *
 *   kind 'daily'      per cell × {tmax, tmin, tmean}: mean N=4 (9 coefs) +
 *                     variance N=2 (5); then landPct[cells], elevM[cells]
 *   kind 'quantiles'  per cell × var × {p01 p05 p10 p33 p50 p67 p90 p95 p99}: N=3 (7)
 *   kind 'records'    per cell × var × pentad (73) × [max, min], absolute °C
 *   kind 'hourly'     per cell: annual N=3 row a (7) × diurnal K=2 →
 *                     [a, a·cos h, a·sin h, a·cos 2h, a·sin 2h] (35)
 *
 * ── Conventions (each mirrors the builder exactly) ──────────────────────────
 *   cells   the 72×36 grid of api/cron/refresh-weather-grid.js: index j*72+i,
 *           j from the SOUTH (lat −87.5 + 5j), i from lon −177.5 + 5i
 *   phase   φ(t) = 2π·frac((t/86 400 000 − 10 957) / 365.2425) at UTC ms t
 *   days    a cell's local SOLAR day = whole UTC hours shifted by
 *           off = floor(lon/15 + 0.5) — NOT Math.round's half-up being "the same
 *           thing as numpy": numpy's round is half-to-EVEN, and the cell
 *           centres hit exact halves (7.5° → 0.5 h, −22.5° → −1.5 h). A day
 *           normal is evaluated at the day's (or trailing-24-h window's) UTC
 *           MIDPOINT
 *   doy     that local solar day's calendar day of year (1..366)
 *   hours   solar hour h = (UTC hour + lon/15) mod 24, CONTINUOUS
 *
 * ── What it claims (plan §3.3, §3.7) ────────────────────────────────────────
 *   • rarity is the EMPIRICAL percentile from the quantile curves, never Φ(z):
 *     Gaussian tails miscalibrate by up to 3× at 1 % (plan §2.3). z is
 *     returned for colour scales only
 *   • the classes are climatePosition's (js/climate-lab/lab-physics.js) so
 *     the Climate Lab and this lab speak one vocabulary
 *   • `beyondRecord` is against a ±9-day pentad pool, a SUPERSET of every
 *     member date's ±7-day pool, so it can only ever under-claim a record —
 *     and it means "beyond 1991–2020 in ERA5 for the date", never an all-time
 *     station record
 *   • these are 1.5° BOX means at a point (the header says so); the live grid
 *     is a point sample. The representativeness offset is Phase 1b
 */

export const GRID = Object.freeze({ w: 72, h: 36, lat0: -87.5, lon0: -177.5, deg: 5 });
export const CELLS = GRID.w * GRID.h;
export const VARS = Object.freeze(['tmax', 'tmin', 'tmean']);
export const Q_LEVELS = Object.freeze([0.01, 0.05, 0.10, 0.33, 0.50, 0.67, 0.90, 0.95, 0.99]);
export const N_PENTAD = 73;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAY0_2000 = 10_957;
const YEAR_DAYS = 365.2425;
const SD_FLOOR_VAR = 0.04;            // σ ≥ 0.2 K, as built
const TAIL_SIGMA_FLOOR = 0.05;        // K
const Z01 = -2.3263478740408408;
const Z05 = -1.6448536269514729;

// Layout constants: a parsed header that disagrees with any of them is a
// different format and is REFUSED, never read with the wrong strides.
const LAYOUT = Object.freeze({
    daily:     { stride: 42, mean: 9, variance: 5 },
    quantiles: { stride: 189, per: 7 },
    records:   { stride: 438 },
    hourly:    { stride: 35 },
});

// ── Container ───────────────────────────────────────────────────────────────

/**
 * Parse one PTLN file. Throws on a wrong magic, kind, grid or harmonic order —
 * a v2 asset with a different layout must fail loudly, not misread.
 * @param {ArrayBuffer|Uint8Array} buf
 */
export function parseNormalsAsset(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'PTLN') throw new Error(`temperature-normals: bad magic "${magic}"`);
    const hlen = dv.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, hlen)));
    const g = header.grid || {};
    if (header.format !== 'PTLN' || header.version !== 1) throw new Error(`temperature-normals: unsupported ${header.format} v${header.version}`);
    if (g.w !== GRID.w || g.h !== GRID.h || g.lat0 !== GRID.lat0 || g.lon0 !== GRID.lon0 || g.deg !== GRID.deg) {
        throw new Error('temperature-normals: grid does not match the 72×36 weather grid');
    }
    const kind = header.kind;
    const expect = {
        daily:     () => header.harmonics?.mean === 4 && header.harmonics?.variance === 2,
        quantiles: () => header.harmonics === 3 && JSON.stringify(header.levels) === JSON.stringify(Q_LEVELS),
        records:   () => header.pentads === N_PENTAD,
        hourly:    () => header.harmonics?.annual === 3 && header.harmonics?.diurnal === 2,
    }[kind];
    if (!expect || !expect()) throw new Error(`temperature-normals: unexpected ${kind} layout`);
    const off = 8 + hlen;
    const n = (ab.byteLength - off) / 2;
    const body = littleEndianInt16(ab, off, n);
    const want = kind === 'daily' ? CELLS * (LAYOUT.daily.stride + 2) : CELLS * LAYOUT[kind].stride;
    if (body.length !== want) throw new Error(`temperature-normals: ${kind} body has ${body.length} values, expected ${want}`);
    return Object.freeze({
        kind, header, body,
        tScale: header.scale?.temperature,
        vScale: header.scale?.variance ?? null,
    });
}

function littleEndianInt16(ab, off, n) {
    const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (le) return new Int16Array(ab, off, n);
    const dv = new DataView(ab), out = new Int16Array(n);
    for (let k = 0; k < n; k++) out[k] = dv.getInt16(off + 2 * k, true);
    return out;
}

// ── Grid, time ──────────────────────────────────────────────────────────────

/** Nearest cell to (lat, lon); lon wraps, lat clamps. */
export function cellIndex(lat, lon) {
    const j = Math.min(GRID.h - 1, Math.max(0, Math.round((lat - GRID.lat0) / GRID.deg)));
    const i = ((Math.round((lon - GRID.lon0) / GRID.deg) % GRID.w) + GRID.w) % GRID.w;
    return j * GRID.w + i;
}

export function cellCentre(cell) {
    const j = Math.floor(cell / GRID.w), i = cell % GRID.w;
    return { lat: GRID.lat0 + GRID.deg * j, lon: GRID.lon0 + GRID.deg * i };
}

/** φ(t) — the annual phase every fit was taken in. */
export function yearPhase(utcMs) {
    const d = utcMs / DAY_MS - DAY0_2000;
    return 2 * Math.PI * (((d % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS) / YEAR_DAYS;
}

/** Whole-hour offset of a longitude's local solar day: floor(lon/15 + 0.5). */
export function solarDayOffsetHours(lon) {
    return Math.floor(lon / 15 + 0.5);
}

/**
 * The local solar day containing `utcMs` at longitude `lon`:
 * { dayIndex (days since 1970), doy (1..366), midpointMs }.
 */
export function localSolarDay(utcMs, lon) {
    const off = solarDayOffsetHours(lon);
    const dayIndex = Math.floor((utcMs / HOUR_MS + off) / 24);
    const date = new Date(dayIndex * DAY_MS);
    const doy = Math.floor((dayIndex * DAY_MS - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
    return { dayIndex, doy, midpointMs: (dayIndex * 24 - off + 12) * HOUR_MS };
}

export function pentadOfDoy(doy) {
    return Math.min(N_PENTAD, Math.floor((doy - 1) / 5) + 1);
}

// ── Harmonics ───────────────────────────────────────────────────────────────

/** [1, cos φ, sin φ, …, cos nφ, sin nφ] */
export function harmonicRow(phase, n) {
    const row = new Float64Array(2 * n + 1);
    row[0] = 1;
    for (let k = 1; k <= n; k++) { row[2 * k - 1] = Math.cos(k * phase); row[2 * k] = Math.sin(k * phase); }
    return row;
}

function dot(row, body, at, scale) {
    let s = 0;
    for (let k = 0; k < row.length; k++) s += row[k] * body[at + k];
    return s * scale;
}

/**
 * Least-squares harmonic fit (the R2 method: N=4 for a mean normal, N=2 for a
 * variance, N=3 for a quantile curve — each order measured by split-half CV). Exported so the 30-day outlook engine can fit
 * a per-location climatology the SAME way (plan §8). Normal equations solved
 * by Gaussian elimination with partial pivoting; samples with a non-finite
 * value are skipped (a gap is not a zero).
 * @returns {Float64Array} 2n+1 coefficients
 */
export function fitHarmonics(phases, values, n) {
    const p = 2 * n + 1;
    const A = Array.from({ length: p }, () => new Float64Array(p + 1));
    let used = 0;
    for (let s = 0; s < phases.length; s++) {
        const y = values[s];
        if (!Number.isFinite(y) || !Number.isFinite(phases[s])) continue;
        const r = harmonicRow(phases[s], n);
        for (let a = 0; a < p; a++) {
            for (let b = 0; b < p; b++) A[a][b] += r[a] * r[b];
            A[a][p] += r[a] * y;
        }
        used++;
    }
    if (used < p) throw new Error(`fitHarmonics: ${used} finite samples for ${p} coefficients`);
    for (let c = 0; c < p; c++) {
        let piv = c;
        for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
        [A[c], A[piv]] = [A[piv], A[c]];
        if (Math.abs(A[c][c]) < 1e-12) throw new Error('fitHarmonics: singular — phases do not span the year');
        for (let r = 0; r < p; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
        }
    }
    return Float64Array.from(A, (row, c) => row[p] / row[c]);
}

// ── Evaluation ──────────────────────────────────────────────────────────────

function varIndex(name) {
    const v = VARS.indexOf(name);
    if (v < 0) throw new Error(`temperature-normals: unknown variable "${name}"`);
    return v;
}

/**
 * The daily normal at a cell for the window whose UTC midpoint is `midpointMs`:
 * { tmax: {mean, sd}, tmin: {…}, tmean: {…} } in °C / K.
 */
export function dailyNormal(daily, cell, midpointMs) {
    const phase = yearPhase(midpointMs);
    const rm = harmonicRow(phase, 4), rv = harmonicRow(phase, 2);
    const out = {};
    VARS.forEach((name, v) => {
        const at = cell * LAYOUT.daily.stride + v * 14;
        const mean = dot(rm, daily.body, at, daily.tScale);
        const variance = dot(rv, daily.body, at + 9, daily.vScale);
        out[name] = { mean, sd: Math.sqrt(Math.max(variance, SD_FLOOR_VAR)) };
    });
    return out;
}

/** Land percentage and elevation (m) at the cell centre, from the 0.25° statics. */
export function cellSurface(daily, cell) {
    const base = CELLS * LAYOUT.daily.stride;
    return { landPct: daily.body[base + cell], elevM: daily.body[base + CELLS + cell] };
}

/** The nine quantile values (°C), forced non-decreasing (the raw curves may cross). */
export function quantileCurve(quantiles, cell, varName, midpointMs) {
    const v = varIndex(varName);
    const row = harmonicRow(yearPhase(midpointMs), 3);
    const per = LAYOUT.quantiles.per;
    const out = new Float64Array(Q_LEVELS.length);
    for (let k = 0; k < Q_LEVELS.length; k++) {
        out[k] = dot(row, quantiles.body, cell * LAYOUT.quantiles.stride + v * per * Q_LEVELS.length + k * per, quantiles.tScale);
        if (k > 0 && out[k] < out[k - 1]) out[k] = out[k - 1];
    }
    return out;
}

/**
 * erfc, fractional error < 1.2e-7 everywhere (Numerical Recipes, Chebyshev).
 * The CDF is built on erfc, not 0.5·(1 + erf): in the far lower tail erf → −1
 * and the sum cancels to exactly 0, so a value 15 K below p01 scored the
 * same 0th percentile as one 40 K below (caught by the monotonicity gate).
 */
export function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
        + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
        + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
}
export const normalCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);

/**
 * Empirical percentile (0–100) of `x` against a quantileCurve: linear between
 * the stored levels; beyond p01 / p99 a Gaussian tail scaled by the curve's
 * OWN outer spacing, so the tail inherits the place's skew rather than a
 * global σ.
 */
export function percentileOf(curve, x) {
    const L = Q_LEVELS, n = curve.length;
    if (x < curve[0]) {
        const s = Math.max((curve[1] - curve[0]) / (Z05 - Z01), TAIL_SIGMA_FLOOR);
        return 100 * normalCdf(Z01 + (x - curve[0]) / s);
    }
    if (x > curve[n - 1]) {
        const s = Math.max((curve[n - 1] - curve[n - 2]) / (Z05 - Z01), TAIL_SIGMA_FLOOR);
        return 100 * normalCdf(-Z01 + (x - curve[n - 1]) / s);
    }
    for (let k = 0; k < n - 1; k++) {
        if (curve[k] <= x && x <= curve[k + 1]) {
            if (curve[k + 1] - curve[k] < 1e-9) return 100 * (L[k] + L[k + 1]) / 2;
            return 100 * (L[k] + (L[k + 1] - L[k]) * (x - curve[k]) / (curve[k + 1] - curve[k]));
        }
    }
    return 100 * L[n - 1];
}

/** climatePosition's classes, identical thresholds. */
export function climateClass(percentile) {
    return percentile < 10 ? 'much-below'
        : percentile < 100 / 3 ? 'below'
        : percentile <= 200 / 3 ? 'near'
        : percentile <= 90 ? 'above' : 'much-above';
}

/**
 * The 1991–2020 record envelope for the cell's local solar day containing
 * `midpointMs`, widened to the quantile curve's outer levels when a curve is
 * given (a record can never sit inside p01–p99).
 */
export function recordEnvelope(records, cell, varName, midpointMs, curve = null) {
    const v = varIndex(varName);
    const { doy } = localSolarDay(midpointMs, cellCentre(cell).lon);
    const p = pentadOfDoy(doy);
    const at = cell * LAYOUT.records.stride + v * 146 + (p - 1) * 2;
    let max = records.body[at] * records.tScale, min = records.body[at + 1] * records.tScale;
    if (curve) { max = Math.max(max, curve[curve.length - 1]); min = Math.min(min, curve[0]); }
    return { max, min, pentad: p, doy };
}

/**
 * Where `valueC` sits for this cell and day — the lab's one rarity answer,
 * shaped like climatePosition: { normal, sd, anomaly, z, percentile, cls,
 * beyondRecord: 'high'|'low'|null, record: {max, min} }.
 * @param {{daily, quantiles, records}} assets  parsed PTLN files
 */
export function position(assets, cell, varName, midpointMs, valueC) {
    if (!Number.isFinite(valueC)) return null;
    const dn = dailyNormal(assets.daily, cell, midpointMs)[varName];
    const curve = quantileCurve(assets.quantiles, cell, varName, midpointMs);
    const percentile = percentileOf(curve, valueC);
    const rec = assets.records ? recordEnvelope(assets.records, cell, varName, midpointMs, curve) : null;
    return {
        normal: dn.mean, sd: dn.sd,
        anomaly: valueC - dn.mean,
        z: (valueC - dn.mean) / dn.sd,
        percentile, cls: climateClass(percentile),
        beyondRecord: rec ? (valueC > rec.max ? 'high' : valueC < rec.min ? 'low' : null) : null,
        record: rec ? { max: rec.max, min: rec.min } : null,
    };
}

/** The hour-of-day normal (°C) at a cell for UTC instant `utcMs`. */
export function hourlyNormal(hourly, cell, utcMs) {
    const a = harmonicRow(yearPhase(utcMs), 3);
    const sh = (((utcMs / HOUR_MS) % 24 + cellCentre(cell).lon / 15) % 24 + 24) % 24;
    const at = cell * LAYOUT.hourly.stride;
    let s = 0;
    for (let k = 0; k < 7; k++) s += a[k] * hourly.body[at + k];
    for (let m = 1; m <= 2; m++) {
        const c = Math.cos(2 * Math.PI * m * sh / 24), sn = Math.sin(2 * Math.PI * m * sh / 24);
        const bc = at + 7 * (2 * m - 1), bs = at + 7 * (2 * m);
        for (let k = 0; k < 7; k++) s += a[k] * (c * hourly.body[bc + k] + sn * hourly.body[bs + k]);
    }
    return s * hourly.tScale;
}

/**
 * Area-weighted global mean of the annual-mean Tmean normal (°C) — the R1
 * harness quantity (C3S: 14.38 °C for 1991–2020). Harmonic terms integrate
 * to zero over a year, so this is the area-weighted constant term.
 */
export function globalMeanTmean(daily) {
    let s = 0, w = 0;
    for (let cell = 0; cell < CELLS; cell++) {
        const wt = Math.cos(cellCentre(cell).lat * Math.PI / 180);
        s += wt * daily.body[cell * LAYOUT.daily.stride + 2 * 14] * daily.tScale;
        w += wt;
    }
    return s / w;
}
