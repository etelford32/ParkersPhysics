/**
 * climalytix/coast.js — the PURE kernel behind Climalytix's Coast card: where
 * the shore is and which way it faces, what the waves arriving there carry,
 * how they are likely to break, and what the tide is doing.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no clock. Three kinds of number come out of here and the
 * card must keep them apart, because they are different claims:
 *
 *   GEOMETRY   `shoreFromGrid` — the nearest water in an ELEVATION grid, and
 *              the direction the coast faces. It is only as fine as the grid
 *              (the result carries `resKm`), and "water" means "at or below
 *              sea level in the elevation data": land below sea level (a
 *              polder, a desert basin) reads as water, a lake above sea level
 *              reads as land. Disclosed; never dressed up as a survey.
 *   PHYSICS    linear wave theory in closed form — wavelength from the exact
 *              dispersion relation, deep-water energy flux, shoaling to a
 *              breaker height. Exact for the idealisation; the sea is not it.
 *   EMPIRICAL  Komar & Gaughan (1972) breaker height, the Iribarren number's
 *              breaker classes (Battjes 1974), Stockdon et al. (2006) runup.
 *              Fits to field data with real scatter. They need the BEACH
 *              SLOPE, which no global dataset resolves — so the kernel takes
 *              the slope as an argument and the card quotes a RANGE over
 *              `SLOPE_RANGE`, never one number for a beach nobody measured.
 *
 * COEFFICIENTS ARE FROM MEMORY OF THE CITED PAPERS (no access at build time)
 * and each constant says `verified: false` in `SOURCES`. The identities the
 * gate checks (dispersion, energy conservation in shoaling, limits) do not
 * depend on them; the fitted coefficients do, and checking one against its
 * paper is real work still to do.
 *
 * DIRECTIONS. Every compass direction here is degrees clockwise from north.
 * Waves and wind are given as where they come FROM (the meteorological and
 * oceanographic convention of the feeds). `normalDeg` is the direction the
 * coast FACES — from land out to sea. A wave arriving head-on therefore comes
 * FROM `normalDeg`, and a wind FROM `normalDeg` is an onshore wind.
 */

export const G = 9.80665;
export const RHO_SEA = 1025;                 // kg/m³
export const BREAKER_INDEX = 0.78;           // Hb / hb, solitary-wave limit (McCowan 1894)
export const COAST_KM = 25;                  // a site within this of the shore gets the Coast card
export const SLOPE_RANGE = Object.freeze([0.02, 0.10]);   // tan β: a flat dissipative beach … a steep reflective one

export const SOURCES = Object.freeze({
    breakerHeight: { cite: 'Komar & Gaughan (1972)', form: 'Hb = 0.39 g^(1/5) (T H0²)^(2/5)', verified: false },
    breakerClass: { cite: 'Battjes (1974)', form: 'ξ0 < 0.5 spilling · 0.5–3.3 plunging · > 3.3 surging', verified: false },
    runup: { cite: 'Stockdon et al. (2006)', form: 'R2% = 1.1 (0.35 β √(H0 L0) + ½ √(H0 L0 (0.563 β² + 0.004))); ξ0 < 0.3: 0.043 √(H0 L0)', verified: false },
    energyFlux: { cite: 'linear theory, irregular sea', form: 'P = ρ g² Hs² Te / (64 π)', verified: true },
});

const DEG = Math.PI / 180;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pos = (v) => (num(v) != null && v > 0 ? v : null);
export const wrap360 = (d) => ((d % 360) + 360) % 360;
/** Signed smallest difference a − b in (−180, 180]. */
export const angDiff = (a, b) => { const d = wrap360(a - b); return d > 180 ? d - 360 : d; };

// ── Waves ───────────────────────────────────────────────────────────────────

/** Deep-water wavelength, m. */
export function deepWavelength(T) { return pos(T) == null ? null : G * T * T / (2 * Math.PI); }

/** Wavelength at depth d (m) from ω² = g k tanh(k d), by Newton's method. Exact to 1e-12 relative. */
export function wavelength(T, d) {
    if (pos(T) == null || pos(d) == null) return null;
    const w2 = (2 * Math.PI / T) ** 2;
    let k = w2 / G;                                              // deep-water start
    k = Math.max(k, Math.sqrt(w2 / (G * d)) * 0.999);            // …or the shallow one, whichever is larger
    for (let i = 0; i < 60; i++) {
        const th = Math.tanh(k * d);
        const f = G * k * th - w2;
        const df = G * th + G * k * d * (1 - th * th);
        const dk = f / df;
        k -= dk;
        if (Math.abs(dk) < 1e-14 * k) break;
    }
    return 2 * Math.PI / k;
}

/** Phase and group speed at depth d, m/s. */
export function waveSpeeds(T, d) {
    const L = wavelength(T, d);
    if (L == null) return null;
    const k = 2 * Math.PI / L, c = L / T, kd = k * d;
    const n = 0.5 * (1 + (2 * kd) / Math.sinh(Math.min(2 * kd, 700)));
    return { c, cg: n * c, n, L };
}

/** Deep-water energy flux of an irregular sea, W per metre of crest. */
export function energyFlux(Hs, Te) {
    return pos(Hs) == null || pos(Te) == null ? null : RHO_SEA * G * G * Hs * Hs * Te / (64 * Math.PI);
}

/** Shoaling coefficient H(d)/H0 for a wave approaching head-on (energy flux conserved). */
export function shoaling(T, d) {
    const s = waveSpeeds(T, d);
    if (!s) return null;
    const cg0 = G * T / (4 * Math.PI);
    return Math.sqrt(cg0 / s.cg);
}

/** Breaker height from the deep-water wave (Komar & Gaughan 1972), m. */
export function breakerHeight(H0, T) {
    return pos(H0) == null || pos(T) == null ? null : 0.39 * G ** 0.2 * (T * H0 * H0) ** 0.4;
}

/** Water depth where a wave of height Hb breaks, m. */
export function breakerDepth(Hb) { return pos(Hb) == null ? null : Hb / BREAKER_INDEX; }

/** Deep-water Iribarren number ξ0 = tan β / √(H0 / L0). */
export function iribarren(slope, H0, T) {
    const L0 = deepWavelength(T);
    return pos(slope) == null || pos(H0) == null || L0 == null ? null : slope / Math.sqrt(H0 / L0);
}

/** How the wave breaks on that slope. */
export function breakerType(xi) {
    if (pos(xi) == null) return null;
    return xi < 0.5 ? 'spilling' : xi <= 3.3 ? 'plunging' : 'surging';
}

/** 2 % exceedance runup above still water (Stockdon et al. 2006), m. */
export function runup2pct(H0, T, slope) {
    const L0 = deepWavelength(T);
    if (pos(H0) == null || L0 == null || pos(slope) == null) return null;
    const hl = Math.sqrt(H0 * L0);
    if (iribarren(slope, H0, T) < 0.3) return 0.043 * hl;        // dissipative beach: slope drops out
    return 1.1 * (0.35 * slope * hl + 0.5 * Math.sqrt(H0 * L0 * (0.563 * slope * slope + 0.004)));
}

/** Douglas sea-state word for a significant wave height. */
export function seaState(Hs) {
    if (num(Hs) == null || Hs < 0) return null;
    const table = [[0.1, 'calm'], [0.5, 'smooth'], [1.25, 'slight'], [2.5, 'moderate'], [4, 'rough'], [6, 'very rough'], [9, 'high'], [14, 'very high']];
    for (const [top, name] of table) if (Hs <= top) return name;
    return 'phenomenal';
}

// ── The shore's point of view ───────────────────────────────────────────────

/**
 * A wave (or wind) coming FROM `fromDeg`, seen from a coast that FACES `normalDeg`.
 * `angle` is 0 for head-on, ±90 for along the shore (positive = it arrives from
 * the left of someone standing on the beach looking out to sea… i.e. clockwise
 * of the normal), and beyond ±90 it is coming over the land.
 */
export function incidence(fromDeg, normalDeg) {
    if (num(fromDeg) == null || num(normalDeg) == null) return null;
    const angle = angDiff(fromDeg, normalDeg);
    return { angle, fromSea: Math.abs(angle) < 90 };
}

/** Wind against the shore: 'onshore' (from the sea), 'offshore' (from the land) or 'cross-shore'. */
export function windRelation(windFromDeg, normalDeg) {
    const i = incidence(windFromDeg, normalDeg);
    if (!i) return null;
    const a = Math.abs(i.angle);
    return a <= 45 ? 'onshore' : a >= 135 ? 'offshore' : 'cross-shore';
}

/**
 * Longshore drift from an obliquely arriving wave. The CERC transport goes as
 * sin(2α) of the breaker angle; here α is the deep-water angle (refraction
 * shrinks it, so this is the SENSE and a relative strength, not a rate).
 * A wave from over the land drives nothing.
 * @returns {{towardDeg:number, strength:number}|null} strength in [0, 1]
 */
export function longshoreDrift(waveFromDeg, normalDeg) {
    const i = incidence(waveFromDeg, normalDeg);
    if (!i) return null;
    if (!i.fromSea) return { towardDeg: null, strength: 0 };
    const strength = Math.abs(Math.sin(2 * i.angle * DEG));
    if (strength < 1e-9) return { towardDeg: null, strength: 0 };
    // A wave from clockwise of the normal pushes water anticlockwise along the shore, and vice versa.
    return { towardDeg: wrap360(normalDeg + (i.angle > 0 ? -90 : 90)), strength };
}

// ── Tide ────────────────────────────────────────────────────────────────────

/**
 * Highs and lows of a sea-level series, each refined by a parabola through
 * its three samples (an hourly series places a tide to a few minutes that
 * way; the raw sample is up to 30 min off). Gaps break the search: an
 * extremum needs a value on both sides.
 * @returns {Array<{t:number, level:number, kind:'high'|'low'}>}
 */
export function tideExtrema(times, levels) {
    const out = [];
    if (!Array.isArray(times) || !Array.isArray(levels)) return out;
    for (let i = 1; i < times.length - 1; i++) {
        const a = num(levels[i - 1]), b = num(levels[i]), c = num(levels[i + 1]);
        if (a == null || b == null || c == null) continue;
        const high = b > a && b >= c, low = b < a && b <= c;
        if (!high && !low) continue;
        const den = a - 2 * b + c;
        const x = den === 0 ? 0 : 0.5 * (a - c) / den;                // vertex offset in samples, |x| ≤ 0.5
        const dtL = times[i] - times[i - 1], dtR = times[i + 1] - times[i];
        out.push({ t: times[i] + x * (x < 0 ? dtL : dtR), level: b - 0.25 * (a - c) * x, kind: high ? 'high' : 'low' });
    }
    return out;
}

/** What the tide is doing at `nowMs`: level (interpolated), direction, the next high and low, the range around now. */
export function tideNow(times, levels, nowMs) {
    if (!Array.isArray(times) || times.length < 2 || !(nowMs >= times[0] && nowMs <= times[times.length - 1])) return null;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= nowMs) i++;
    const a = num(levels[i]), b = num(levels[i + 1]);
    if (a == null || b == null) return null;
    const w = (nowMs - times[i]) / (times[i + 1] - times[i]);
    const ex = tideExtrema(times, levels);
    const next = (kind) => ex.find((e) => e.kind === kind && e.t > nowMs) || null;
    const prev = [...ex].reverse().find((e) => e.t <= nowMs) || null;
    const after = ex.find((e) => e.t > nowMs) || null;
    return {
        level: a + (b - a) * w,
        trend: b > a ? 'rising' : b < a ? 'falling' : 'slack',
        nextHigh: next('high'), nextLow: next('low'),
        range: prev && after ? Math.abs(after.level - prev.level) : null,
    };
}

// ── Where the shore is ──────────────────────────────────────────────────────

const R_KM = 6371.0088;

/**
 * The nearest shore to a site in an elevation grid (terrain.js `sampleGrid`
 * shape: NW → SE, `values` in metres, NaN unknown), and the way it faces.
 *
 *   water      a node at or below `seaLevelM`
 *   distance   to the nearest node of the OTHER kind (water for a site on
 *              land, land for a site on water), less half a node — the shore
 *              lies between the two
 *   normalDeg  the bearing from the centroid of the LAND nodes to the
 *              centroid of the WATER nodes within `fitKm` of the shore point,
 *              in true kilometres (east–west spacing × cos φ — without it a
 *              coast at 60° N is skewed by tens of degrees; the gate's
 *              negative control)
 *
 * @returns {{state:'coastal'|'inland'|'unknown', onWater:boolean, distanceKm, bearingDeg, shoreLat, shoreLon,
 *            normalDeg, resKm:number, waterFraction:number}}
 */
export function shoreFromGrid(g, site, { seaLevelM = 0, coastKm = COAST_KM, fitKm = null, cosLat = true } = {}) {
    const none = (state, extra = {}) => ({ state, onWater: false, distanceKm: null, bearingDeg: null, shoreLat: null, shoreLon: null, normalDeg: null, resKm: null, waterFraction: null, ...extra });
    if (!g || !g.values || !site || num(site.lat) == null || num(site.lon) == null) return none('unknown');
    const { nRows, nCols, values, latN, lonW, dlat, dlon } = g;
    const kmLat = dlat * DEG * R_KM;
    const kx = (lat) => DEG * R_KM * (cosLat ? Math.cos(lat * DEG) : 1);
    const resKm = Math.max(kmLat, dlon * kx(site.lat));
    let known = 0, wet = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) { known++; if (values[i] <= seaLevelM) wet++; }
    if (known < values.length * 0.5) return none('unknown', { resKm });
    const waterFraction = wet / known;
    const si = Math.round((latN - site.lat) / dlat), sj = Math.round((site.lon - lonW) / dlon);
    if (si < 0 || sj < 0 || si >= nRows || sj >= nCols) return none('unknown', { resKm, waterFraction });
    const hs = values[si * nCols + sj];
    if (!Number.isFinite(hs)) return none('unknown', { resKm, waterFraction });
    const onWater = hs <= seaLevelM;
    const xy = (i, j) => { const lat = latN - i * dlat; return [(lonW + j * dlon - site.lon) * kx(site.lat), (lat - site.lat) * DEG * R_KM]; };
    let best = null;
    for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) {
        const h = values[i * nCols + j];
        if (!Number.isFinite(h) || (h <= seaLevelM) === onWater) continue;
        const [x, y] = xy(i, j), d2 = x * x + y * y;
        if (!best || d2 < best.d2) best = { d2, x, y, i, j };
    }
    if (!best) return none('inland', { onWater, resKm, waterFraction });       // all land (or all sea) in the window
    const d = Math.sqrt(best.d2);
    const distanceKm = Math.max(0, d - resKm / 2);
    const shore = d > 0 ? { x: best.x * (distanceKm / d), y: best.y * (distanceKm / d) } : { x: 0, y: 0 };
    // Which way the coast faces: land centroid → water centroid, near the shore point.
    const R = fitKm ?? Math.max(5, 4 * resKm);
    let lx = 0, ly = 0, ln = 0, wx = 0, wy = 0, wn = 0;
    for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) {
        const h = values[i * nCols + j];
        if (!Number.isFinite(h)) continue;
        const [x, y] = xy(i, j);
        if ((x - shore.x) ** 2 + (y - shore.y) ** 2 > R * R) continue;
        if (h <= seaLevelM) { wx += x; wy += y; wn++; } else { lx += x; ly += y; ln++; }
    }
    let normalDeg = null;
    if (ln && wn) {
        const nx = wx / wn - lx / ln, ny = wy / wn - ly / ln;
        if (Math.hypot(nx, ny) > 1e-6) normalDeg = wrap360(Math.atan2(nx, ny) / DEG);
    }
    return {
        state: distanceKm <= coastKm ? 'coastal' : 'inland', onWater, distanceKm,
        bearingDeg: d > 0 ? wrap360(Math.atan2(best.x, best.y) / DEG) : null,
        shoreLat: site.lat + shore.y / (DEG * R_KM), shoreLon: site.lon + shore.x / kx(site.lat),
        normalDeg, resKm, waterFraction,
    };
}

/** The elevation window the Coast card reads around a site: ±`halfKm` in both directions. */
export function coastWindow(site, halfKm = 33) {
    const dLat = halfKm / (DEG * R_KM);
    const dLon = dLat / Math.max(0.2, Math.cos(site.lat * DEG));
    return { north: Math.min(84.5, site.lat + dLat), south: Math.max(-84.5, site.lat - dLat), west: site.lon - dLon, east: site.lon + dLon };
}

// ── The card's numbers, assembled ───────────────────────────────────────────

/**
 * Everything the Coast card prints about the sea state at one instant.
 * Inputs are SI and may be null; a missing input leaves its outputs null —
 * nothing is assumed in its place.
 * @param {{waveM, wavePeriodS, waveDirDeg, swellM, swellPeriodS, swellDirDeg, sstC}} sea
 * @param {{normalDeg:number|null}} shore
 * @param {{fromDeg:number|null, speedMs:number|null}} wind
 */
export function surfReport(sea = {}, shore = {}, wind = {}) {
    const H = pos(sea.waveM), T = pos(sea.wavePeriodS);
    const Hb = breakerHeight(H, T);
    const perSlope = SLOPE_RANGE.map((slope) => {
        const xi = iribarren(slope, H, T);
        return { slope, xi, type: breakerType(xi), runupM: runup2pct(H, T, slope) };
    });
    const wave = incidence(sea.waveDirDeg, shore.normalDeg);
    return {
        seaState: seaState(num(sea.waveM)),
        wavelengthM: deepWavelength(T),
        fluxKwM: energyFlux(H, T) == null ? null : energyFlux(H, T) / 1000,
        breakerM: Hb, breakerDepthM: breakerDepth(Hb),
        perSlope,
        runupM: perSlope.every((p) => p.runupM != null) ? [Math.min(...perSlope.map((p) => p.runupM)), Math.max(...perSlope.map((p) => p.runupM))] : null,
        wave,                                              // { angle, fromSea } against the shore
        reachesShore: wave ? wave.fromSea : null,
        drift: longshoreDrift(sea.waveDirDeg, shore.normalDeg),
        wind: windRelation(wind.fromDeg, shore.normalDeg),
    };
}
