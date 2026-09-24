/**
 * hero-aurora.js — PURE kernel for the homepage hero's aurora
 * ═══════════════════════════════════════════════════════════════════════════
 * No three.js, no DOM, no fetch, no ambient time; `node tests/hero-aurora.mjs`
 * pins it. The hero (js/hero-space-weather.js) and the magnetosphere engine
 * draw only what this module decides.
 *
 * ── WHAT IS REAL NOW ───────────────────────────────────────────────────────
 * Two things replace the parametric oval the hero used to draw everywhere:
 *
 *   1. THE MAGNETIC POLE. `dipoleFrame(date)` is the IGRF-14 centred dipole
 *      (js/geomag/dipole.js → igrf.js, the site's single source of truth for
 *      the field) expressed in the canonical scene frame (js/geo/coords.js:
 *      +X lon 0°, +Y north, −Z lon 90°E). The engine's equatorial group —
 *      curtains, belts, plasmasphere, field lines — is turned into it, so the
 *      oval rings the geomagnetic pole over the Canadian Arctic, not an
 *      arbitrary 11.5° tilt about the scene's x axis.
 *   2. THE OVAL. NOAA SWPC's OVATION Prime nowcast (via /api/noaa/aurora-grid:
 *      [lonEast, lat, prob%] cells, brightest first) is resampled onto the
 *      engine's own curtain ring: for every curtain azimuth, the curtain
 *      stands at the probability-weighted magnetic colatitude of the oval at
 *      that azimuth and is as bright as the oval there. So the curtains follow
 *      the real oval's shape (fatter and further equatorward on the night
 *      side) and vanish where NOAA sees no aurora. `footprintTexture` is the
 *      same grid as a map for the globe's night side.
 *
 * ── THE ONE CONVENTION TRAP ────────────────────────────────────────────────
 * dipole.js works in ECEF (x lon 0°, y lon 90°E, z north); the scene is y-up
 * with −z at 90°E. `ecefToCanon` = (x, z, −y), a proper rotation. The curtain
 * geometry (magnetosphere-engine.js `buildAuroralCurtains`) places a vertex at
 * (sinθ cosφ, ±cosθ, sinθ sinφ) in the group's frame; `curtainDirection`
 * mirrors that expression exactly and every oval computation goes through it,
 * so the frame the ring is COMPUTED in and the frame it is DRAWN in cannot
 * disagree. (With X = dipole x̂ and Y = the dipole axis, Z = X × Y = −ŷ_dip,
 * so a curtain azimuth φ is dipole longitude −φ — the test pins it.)
 *
 * ── DISPLAY CHOICES (disclosed) ────────────────────────────────────────────
 * OVATION gives a PROBABILITY of visible aurora, not a brightness. It is drawn
 * as √(p / P_FULL), clamped to 1: a quiet night-side oval (~10 %) still reads,
 * a storm (≥ 30 %) saturates. The feed counts as STALE after STALE_S and the
 * hero then falls back to the Kp-driven ring — a dead feed must look like the
 * model, never like a live quiet night.
 */
import { dipoleBasisForYear, decimalYear } from './geomag/dipole.js';
import { matrixToQuaternion } from './hero-earth.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Probability (%) drawn at full strength. */
export const P_FULL = 30;
/** Below this peak probability an azimuth has no oval to stand a curtain on. */
export const P_VALID = 5;
/** The feed is stale after this long past its forecast time. */
export const STALE_S = 5400;
/** Curtain segments — MUST equal magnetosphere-engine.js buildAuroralCurtains N_SEG. */
export const N_SEG = 180;
/** Colatitude search band from the dipole pole (deg). */
export const TH_MIN = 3, TH_MAX = 42, TH_STEP = 0.5;
/** Grid: 1° cells, lon 0..359 East × lat −90..90. */
const GW = 360, GH = 181;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** ECEF (dipole.js) → canonical scene frame (js/geo/coords.js). Proper rotation. */
export function ecefToCanon(v) { return [v[0], v[2], -v[1]]; }

/** Canonical unit vector → geographic { lat, lon } in degrees (lon −180..180). */
export function canonToLatLon(n) {
    return { lat: Math.asin(Math.max(-1, Math.min(1, n[1]))) * RAD, lon: Math.atan2(-n[2], n[0]) * RAD };
}

/**
 * The IGRF centred-dipole frame in canonical axes, Earth-fixed. Columns:
 * X = dipole x̂ (toward the geographic pole's meridian), Y = the NORTH dipole
 * axis, Z = X × Y. Row-major 3×3 + quaternion.
 * @param {Date} date
 */
export function dipoleFrame(date) {
    const b = dipoleBasisForYear(decimalYear(date));
    const X = ecefToCanon(b.x), Y = ecefToCanon(b.z), Z = cross(X, Y);
    const m = [X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]];
    return { matrix: m, quaternion: matrixToQuaternion(m), poleLatDeg: b.pole.poleLatDeg, poleLonDeg: b.pole.poleLonDeg };
}

/**
 * Earth-fixed canonical direction of a curtain footpoint at azimuth φ (rad)
 * and colatitude θ (deg) from the north (or south) dipole pole. Mirrors the
 * vertex placement in magnetosphere-engine.js buildAuroralCurtains.
 */
export function curtainDirection(frame, phi, colatDeg, north = true) {
    const t = colatDeg * DEG, s = north ? 1 : -1;
    const l = [Math.sin(t) * Math.cos(phi), s * Math.cos(t), Math.sin(t) * Math.sin(phi)];
    const m = frame.matrix;
    return [
        m[0] * l[0] + m[1] * l[1] + m[2] * l[2],
        m[3] * l[0] + m[4] * l[1] + m[5] * l[2],
        m[6] * l[0] + m[7] * l[1] + m[8] * l[2],
    ];
}

/**
 * OVATION cells → a dense 1° grid (Float32Array, row = lat + 90, col = lonEast).
 * The route keeps every SECOND longitude column; a missing odd column takes
 * the mean of its present neighbours (never extrapolated past an edge).
 * @param {Array<[number, number, number]>} cells [lonEast 0..359, lat, prob %]
 */
export function ovationGrid(cells) {
    const g = new Float32Array(GW * GH);
    const seen = new Uint8Array(GW * GH);
    for (const c of cells || []) {
        if (!Array.isArray(c) || c.length < 3) continue;
        const lon = ((Math.round(+c[0]) % 360) + 360) % 360;
        const lat = Math.round(+c[1]), p = +c[2];
        if (!Number.isFinite(lat) || !Number.isFinite(p) || lat < -90 || lat > 90) continue;
        const i = (lat + 90) * GW + lon;
        g[i] = Math.max(g[i], p);
        seen[i] = 1;
    }
    for (let r = 0; r < GH; r++) {
        for (let c = 0; c < GW; c++) {
            const i = r * GW + c;
            if (seen[i]) continue;
            const L = r * GW + ((c + GW - 1) % GW), R = r * GW + ((c + 1) % GW);
            if (seen[L] && seen[R]) g[i] = 0.5 * (g[L] + g[R]);
        }
    }
    return g;
}

/** Bilinear sample of the grid at (lat, lon) degrees; lon wraps. */
export function sampleGrid(g, lat, lon) {
    const y = Math.max(0, Math.min(GH - 1.000001, lat + 90));
    const x = ((lon % 360) + 360) % 360;
    const r0 = Math.floor(y), c0 = Math.floor(x);
    const fy = y - r0, fx = x - c0;
    const r1 = Math.min(GH - 1, r0 + 1), c1 = (c0 + 1) % GW;
    const a = g[r0 * GW + c0], b = g[r0 * GW + c1], c = g[r1 * GW + c0], d = g[r1 * GW + c1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

const display = (p) => Math.sqrt(Math.max(0, Math.min(1, p / P_FULL)));

function circularSmooth(a, half) {
    const n = a.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -half; k <= half; k++) s += a[(i + k + n) % n];
        out[i] = s / (2 * half + 1);
    }
    return out;
}

/**
 * The oval on the engine's curtain ring for one hemisphere.
 * @returns {null | { colatDeg: Float32Array, intensity: Float32Array,
 *   meanColatDeg: number, peakProb: number, coverage: number }}
 *   arrays have N_SEG + 1 entries (the ring closes on itself, like the
 *   curtain geometry); null when no azimuth reaches P_VALID.
 */
export function ovalFromGrid(g, frame, north = true, nSeg = N_SEG) {
    const colat = new Float32Array(nSeg).fill(NaN);
    const peak = new Float32Array(nSeg);
    let valid = 0, peakProb = 0;
    for (let k = 0; k < nSeg; k++) {
        const phi = (k / nSeg) * Math.PI * 2;
        let w = 0, wt = 0, mx = 0;
        for (let th = TH_MIN; th <= TH_MAX + 1e-9; th += TH_STEP) {
            const { lat, lon } = canonToLatLon(curtainDirection(frame, phi, th, north));
            const p = sampleGrid(g, lat, lon);
            // p² weighting: the centroid follows the band's CREST, not the
            // faint polar-cap drizzle either side of it.
            w += p * p; wt += p * p * th;
            if (p > mx) mx = p;
        }
        peak[k] = mx;
        if (mx >= P_VALID && w > 0) { colat[k] = wt / w; valid++; }
        if (mx > peakProb) peakProb = mx;
    }
    if (!valid) return null;
    // Azimuths with no oval (a day-side gap) inherit the colatitude of their
    // nearest valid neighbours, so the ring stays continuous; their intensity
    // is what makes them invisible.
    for (let k = 0; k < nSeg; k++) {
        if (!Number.isNaN(colat[k])) continue;
        let a = 1, b = 1;
        while (Number.isNaN(colat[(k - a + nSeg) % nSeg])) a++;
        while (Number.isNaN(colat[(k + b) % nSeg])) b++;
        const ca = colat[(k - a + nSeg) % nSeg], cb = colat[(k + b) % nSeg];
        colat[k] = ca + (cb - ca) * (a / (a + b));
    }
    const cs = circularSmooth(colat, 4);
    const ps = circularSmooth(peak, 3);
    const colatDeg = new Float32Array(nSeg + 1), intensity = new Float32Array(nSeg + 1);
    let mean = 0;
    for (let k = 0; k < nSeg; k++) {
        colatDeg[k] = cs[k]; intensity[k] = display(ps[k]); mean += cs[k];
    }
    colatDeg[nSeg] = colatDeg[0]; intensity[nSeg] = intensity[0];
    return { colatDeg, intensity, meanColatDeg: mean / nSeg, peakProb, coverage: valid / nSeg };
}

/**
 * The grid as an equirectangular R8 map in the CANONICAL UV (u = 0 at lon
 * −180°, v = 0 at +90°N — js/geo/coords.js), display-stretched like the
 * curtains and softened by one 3×3 pass so the stride and the 1° cells do
 * not show at the globe's ~190 px.
 * @returns {Uint8Array} w × h, row 0 = north
 */
export function footprintTexture(g, w = 360, h = 180) {
    const raw = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
        const lat = 90 - (r + 0.5) * (180 / h);
        for (let c = 0; c < w; c++) {
            const lon = -180 + (c + 0.5) * (360 / w);
            raw[r * w + c] = display(sampleGrid(g, lat, lon));
        }
    }
    const out = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            let s = 0, n = 0;
            for (let dr = -1; dr <= 1; dr++) {
                const rr = r + dr;
                if (rr < 0 || rr >= h) continue;
                for (let dc = -1; dc <= 1; dc++) { s += raw[rr * w + ((c + dc + w) % w)]; n++; }
            }
            out[r * w + c] = Math.round(255 * s / n);
        }
    }
    return out;
}

/**
 * Everything the hero needs from one /api/noaa/aurora-grid response.
 * @param {object} json   the route's body ({ data: { cells, updated, north_gw, south_gw } })
 * @param {Date}   now
 * @returns {{ ok: true, north, south, footprint: Uint8Array, updatedMs: number,
 *             northGw: number, southGw: number, frame }
 *          | { ok: false, reason: 'malformed'|'empty'|'stale'|'no-oval' }}
 */
export function auroraProduct(json, now) {
    const d = json?.data;
    if (!d || !Array.isArray(d.cells)) return { ok: false, reason: 'malformed' };
    if (!d.cells.length) return { ok: false, reason: 'empty' };
    const updatedMs = Date.parse(d.updated ?? '');
    if (Number.isFinite(updatedMs) && (now.getTime() - updatedMs) / 1000 > STALE_S) return { ok: false, reason: 'stale' };
    const frame = dipoleFrame(now);
    const g = ovationGrid(d.cells);
    const north = ovalFromGrid(g, frame, true);
    const south = ovalFromGrid(g, frame, false);
    if (!north && !south) return { ok: false, reason: 'no-oval' };
    return {
        ok: true, north, south, frame,
        footprint: footprintTexture(g),
        updatedMs: Number.isFinite(updatedMs) ? updatedMs : NaN,
        northGw: +d.north_gw || 0, southGw: +d.south_gw || 0,
    };
}
