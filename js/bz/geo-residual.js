/**
 * js/bz/geo-residual.js — the geosynchronous rung of the Bz engine (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B3 (§4.6). No DOM, no fetch, no ambient time.
 * Gate: tests/bz-geo.mjs.
 *
 * The GOES magnetometers are the only real-time field measurement INSIDE the
 * magnetosphere. This module turns their published E/P/N components into a
 * RESIDUAL — measured minus the internal (core) field — which is the part
 * the solar wind and the magnetospheric currents are responsible for, and it
 * holds a first, deliberately simple prediction of that residual up against
 * the measurement.
 *
 * ── THE FRAME, PINNED TO PRODUCTION ──────────────────────────────────────
 * GOES publishes the field in its own E/P/N frame. At a satellite on the
 * equator at east longitude λ:
 *     P  along Earth's SPIN axis, northward        (= −θ̂ of IGRF)
 *     E  EARTHWARD, i.e. radially inward           (= −r̂)
 *     N  EASTWARD                                  (= +φ̂)
 * so the internal field in that frame is (He, Hp, Hn) = (−B_r, −B_θ, B_φ) of
 * js/geomag/igrf.js — the site's ONE field evaluator — and no GSM/GSE chain
 * is involved at all. This was CHECKED against production on 2026-11-20:
 *     GOES-19 measured (32.6, 100.4,  0.4) nT, IGRF at 75.2°W (31.9, 98.1, −0.8)
 *     GOES-18 measured (14.4,  91.4, 14.1) nT, IGRF at 137.2°W (13.2, 101.3, 16.1)
 * He and Hn agree to ~1–2 nT on both — and swapping the two longitudes misses
 * He by ~18 nT, so the convention AND the slots are confirmed by the data.
 * The Hp difference (+2 and −10 nT) is the signal this rung exists for.
 *
 * ── LONGITUDES ARE NOMINAL SLOTS ─────────────────────────────────────────
 * The magnetometer file carries no position. `GOES_SLOTS` holds the nominal
 * operational longitudes; station-keeping holds a GOES within ~0.1°, and the
 * check above would expose a wrong slot as tens of nT. A satellite NOT in the
 * table gets no residual — never a guessed longitude.
 *
 * ── THE PREDICTION IS ONE TERM OF SEVERAL, AND SAYS SO ───────────────────
 * `meadEpn` is the field of the magnetopause (Chapman–Ferraro) currents: a
 * uniform northward term ∝ r₀⁻³ plus a sunward gradient ∝ r₀⁻⁴, with r₀ the
 * Shue standoff from js/geomag/geospace.js at the wind that has ARRIVED. It
 * omits the ring current and the tail current, which at geosynchronous orbit
 * are tens of nT and negative. So the ledger scores VARIATION (medians
 * removed) and reports the level it cannot explain as `unmodelled_offset_nt`.
 * The two Mead (1964) coefficients were transcribed from memory and could NOT
 * be confirmed against the paper from the build sandbox: `MEAD.verified` is
 * false and every result built on them says so.
 *
 * ── ARCJETS ──────────────────────────────────────────────────────────────
 * A flagged minute is thruster contamination, and the flag is routine (74
 * minutes of GOES-19 in one measured day). Flagged minutes AND a guard band
 * either side are excluded from every residual statistic and counted.
 */
import { coeffsAt, fieldGeocentric, NMAX } from '../geomag/igrf.js';
import { subsolarPointGeo, dipoleBasisForYear, decimalYear } from '../geomag/dipole.js';
import { RE_KM } from './frames.js';

const DEG = Math.PI / 180;
export const GEO_RADIUS_KM = 42164.2;
export const GEO_RADIUS_RE = GEO_RADIUS_KM / RE_KM;

/** Nominal operational slots, east longitude. See the header. */
export const GOES_SLOTS = Object.freeze({
    'GOES-19': Object.freeze({ lonEastDeg: -75.2, slot: 'GOES-East' }),
    'GOES-18': Object.freeze({ lonEastDeg: -137.2, slot: 'GOES-West' }),
});

/** Mead (1964) magnetopause-current field, nT, for r₀ in R_E. UNVERIFIED coefficients. */
export const MEAD = Object.freeze({ verified: false, uniformNt: 25, gradientNtPerRe: 2.1, r0RefRe: 10 });

export const GEO_DEFAULTS = Object.freeze({
    arcjetGuardMin: 10,     // minutes excluded either side of a flagged sample
    responseLagMin: 5,      // bow shock → geosynchronous allowance when it cannot be measured
    windHoldMin: 15,        // how long an arrived wind value may stand in for the next
    minScored: 120,
});

/** Internal field at a geostationary slot in the GOES frame, nT. */
export function igrfEpn(lonEastDeg, date) {
    const f = fieldGeocentric(coeffsAt(decimalYear(date)), NMAX, GEO_RADIUS_KM, Math.PI / 2, lonEastDeg * DEG);
    return { he: -f.br, hp: -f.btheta, hn: f.bphi };
}

/** Unit vectors of the GOES frame, and the radial, in Earth-fixed coordinates. */
function epnBasis(lonEastDeg) {
    const l = lonEastDeg * DEG;
    const r = [Math.cos(l), Math.sin(l), 0];
    return { r, e: [-r[0], -r[1], 0], p: [0, 0, 1], n: [-Math.sin(l), Math.cos(l), 0] };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Sun direction, Earth-fixed unit vector. */
function sunGeo(date) {
    const s = subsolarPointGeo(date);
    const la = s.latDeg * DEG, lo = s.lonDeg * DEG;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Solar local time at an east longitude, hours [0, 24). */
export function localTimeH(lonEastDeg, date) {
    const s = subsolarPointGeo(date);
    return (((lonEastDeg - s.lonDeg) / 15 + 12) % 24 + 24) % 24;
}

/**
 * The satellite's sunward coordinate in the SM frame, R_E: its position
 * projected on the Sun direction taken PERPENDICULAR to the dipole axis.
 * +6.6 at magnetic noon, −6.6 at magnetic midnight.
 */
export function xSmRe(lonEastDeg, date) {
    const m = dipoleBasisForYear(decimalYear(date)).z, s = sunGeo(date);
    const k = dot(s, m);
    let sp = [s[0] - k * m[0], s[1] - k * m[1], s[2] - k * m[2]];
    const n = Math.hypot(...sp); sp = sp.map((x) => x / n);
    return GEO_RADIUS_RE * dot(epnBasis(lonEastDeg).r, sp);
}

/**
 * Field of the magnetopause currents at a geostationary slot, in the GOES
 * frame, for a standoff distance r₀ (R_E). Along the DIPOLE axis:
 *     ΔB = 25·(10/r₀)³ + 2.1·(10/r₀)⁴ · x_SM   [nT]
 * @returns {{he,hp,hn,along:number,coefficients_verified:false} | null}
 */
export function meadEpn(r0Re, lonEastDeg, date) {
    if (!(r0Re > 0)) return null;
    const q = MEAD.r0RefRe / r0Re;
    const along = MEAD.uniformNt * q ** 3 + MEAD.gradientNtPerRe * q ** 4 * xSmRe(lonEastDeg, date);
    const m = dipoleBasisForYear(decimalYear(date)).z, b = epnBasis(lonEastDeg);
    return { he: along * dot(m, b.e), hp: along * dot(m, b.p), hn: along * dot(m, b.n), along, coefficients_verified: MEAD.verified };
}

/**
 * Residual series for one satellite: measured − IGRF in the GOES frame, on
 * the samples' own time tags. Arcjet-flagged minutes and their guard band
 * are NaN and counted.
 * @param {Array<{t,he,hp,hn,total,arcjet}>} samples ascending
 * @returns {{ t:Float64Array, he,hp,hn:Float64Array, valid:number, arcjet:number, guarded:number, gaps:number } | null}
 */
export function residualSeries(samples, lonEastDeg, opts = {}) {
    const o = { ...GEO_DEFAULTS, ...opts };
    const n = samples?.length ?? 0;
    if (!n) return null;
    const t = new Float64Array(n), he = new Float64Array(n).fill(NaN), hp = new Float64Array(n).fill(NaN), hn = new Float64Array(n).fill(NaN);
    const bad = new Uint8Array(n);
    let arcjet = 0;
    for (let i = 0; i < n; i++) { t[i] = samples[i].t; if (samples[i].arcjet === true) { bad[i] = 1; arcjet++; } }
    // Guard band, by TIME (the series may have gaps).
    const guard = o.arcjetGuardMin * 60e3;
    let guarded = 0;
    if (arcjet) {
        let j = 0;
        const flagged = []; for (let i = 0; i < n; i++) if (bad[i] === 1) flagged.push(t[i]);
        for (let i = 0; i < n; i++) {
            if (bad[i]) continue;
            while (j < flagged.length - 1 && flagged[j] < t[i] - guard) j++;
            const near = Math.min(Math.abs(flagged[j] - t[i]), j > 0 ? Math.abs(flagged[j - 1] - t[i]) : Infinity,
                j + 1 < flagged.length ? Math.abs(flagged[j + 1] - t[i]) : Infinity);
            if (near <= guard) { bad[i] = 2; guarded++; }
        }
    }
    // The internal field at a fixed Earth-fixed point changes by < 0.1 nT/yr: evaluate it once.
    const ig = igrfEpn(lonEastDeg, new Date(t[n >> 1]));
    let valid = 0, gaps = 0;
    for (let i = 0; i < n; i++) {
        const s = samples[i];
        if (bad[i]) continue;
        if (s.hp == null || s.he == null || s.hn == null) { gaps++; continue; }
        he[i] = s.he - ig.he; hp[i] = s.hp - ig.hp; hn[i] = s.hn - ig.hn; valid++;
    }
    return { t, he, hp, hn, igrf: ig, valid, arcjet, guarded, gaps };
}

function median(a) {
    const s = Float64Array.from(a).sort(), m = s.length >> 1;
    return s.length ? (s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])) : NaN;
}

/**
 * Score a prediction of a series against the series, on VARIATION: each is
 * taken about its own median over the scored minutes, so a constant the
 * prediction does not model (ring + tail currents) is reported, not scored.
 *
 *   rmse / rmse_baseline   about-median RMS error of the prediction and of the baseline
 *   skill                  1 − MSE / MSE_baseline
 *   r                      correlation of prediction with observation
 *   offset                 median(obs − pred): the level left unexplained
 */
export function scoreVariation(obs, pred, baseline, minScored = GEO_DEFAULTS.minScored) {
    const o = [], p = [], b = [];
    for (let i = 0; i < obs.length; i++) {
        if (obs[i] === obs[i] && pred[i] === pred[i] && baseline[i] === baseline[i]) { o.push(obs[i]); p.push(pred[i]); b.push(baseline[i]); }
    }
    const n = o.length;
    if (n < minScored) return { n, rmse: null, rmse_baseline: null, skill: null, r: null, offset: null };
    const mo = median(o), mp = median(p), mb = median(b);
    let se = 0, sb = 0, sop = 0, soo = 0, spp = 0;
    const ao = o.reduce((x, y) => x + y, 0) / n, ap = p.reduce((x, y) => x + y, 0) / n;
    for (let i = 0; i < n; i++) {
        se += ((o[i] - mo) - (p[i] - mp)) ** 2;
        sb += ((o[i] - mo) - (b[i] - mb)) ** 2;
        sop += (o[i] - ao) * (p[i] - ap); soo += (o[i] - ao) ** 2; spp += (p[i] - ap) ** 2;
    }
    return { n, rmse: Math.sqrt(se / n), rmse_baseline: Math.sqrt(sb / n), skill: sb > 0 ? 1 - se / sb : null,
        r: soo > 0 && spp > 0 ? sop / Math.sqrt(soo * spp) : null, offset: median(o.map((x, i) => x - p[i])) };
}

/**
 * The value of an arrival-ordered series at time `tMs − lagMs`: the newest
 * arrival at or before it, HELD for at most holdMs. NaN otherwise.
 * `arrivalMs` must be ascending.
 */
export function arrivedValue(arrivalMs, values, tMs, lagMs, holdMs, cursor = { i: 0 }) {
    const want = tMs - lagMs;
    const n = arrivalMs.length;
    if (!n) return NaN;
    if (cursor.i >= n || arrivalMs[cursor.i] > want) cursor.i = 0;          // series scanned forward; reset if asked to go back
    while (cursor.i + 1 < n && arrivalMs[cursor.i + 1] <= want) cursor.i++;
    if (arrivalMs[cursor.i] > want || want - arrivalMs[cursor.i] > holdMs) return NaN;
    return values[cursor.i];
}

/**
 * UT hour at which a series' 3-hour running mean peaks — for Hp, the dayside
 * compression maximum, which sits near LOCAL NOON. A cheap, model-free check
 * that a satellite is where its slot says: GOES-East and GOES-West differ by
 * 4.1 hours. Needs ≥ 20 h of coverage; null otherwise.
 */
export function diurnalPeakUtH(t, x) {
    const bins = new Float64Array(24), cnt = new Float64Array(24);
    for (let i = 0; i < t.length; i++) if (x[i] === x[i]) { const h = Math.floor(((t[i] / 3600e3) % 24 + 24) % 24); bins[h] += x[i]; cnt[h]++; }
    let have = 0; for (let h = 0; h < 24; h++) if (cnt[h] >= 20) have++;
    if (have < 20) return null;
    let best = -Infinity, at = null;
    for (let h = 0; h < 24; h++) {
        let s = 0, c = 0;
        for (const d of [-1, 0, 1]) { const k = (h + d + 24) % 24; if (cnt[k]) { s += bins[k] / cnt[k]; c++; } }
        if (c === 3 && s / 3 > best) { best = s / 3; at = h + 0.5; }
    }
    return at;
}
