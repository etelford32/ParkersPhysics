/**
 * js/bz/frames.js — GSE ↔ GSM and spacecraft geometry for the Bz engine (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B1. No DOM, no fetch, no ambient time.
 *
 * ── ONE TILT ─────────────────────────────────────────────────────────────
 * GSM is GSE turned about the Sun–Earth line (X) until the dipole axis lies in
 * the X–Z plane. The dipole axis and the Sun are js/geomag/dipole.js's — the
 * SAME ones tiga.html's tilt and terminator use; this module adds only the
 * projection. It is not a second ephemeris.
 *
 * ── WHY THIS EXISTS WHEN THE FEED ALREADY PUBLISHES GSM ──────────────────
 * SWPC's L1 file carries both frames, and the engine USES THE PUBLISHED GSM.
 * This rotation is (1) the CHECK on that — `fitRotationAngle` measures the
 * angle the feed itself used and the route compares it with ours, so a frame
 * mix-up upstream or here shows as a number, not as a subtly wrong Bz — and
 * (2) what turns the hourly GSE ephemerides and, later, GOES into GSM.
 *
 * Pinned against production: on 2026-11-20 14:17 UT the feed's own GSE→GSM
 * pairs for three spacecraft imply μ ≈ −17.7°; tests/bz-l1.mjs holds this
 * module to that.
 *
 * SIGN: (y, z)_gsm = R(μ)·(y, z)_gse with
 *     y' = y cos μ − z sin μ,   z' = y sin μ + z cos μ,
 * μ = atan2(M_y, M_z) for the dipole axis M in GSE — so M has y' = 0, z' > 0.
 */
import { julianDate, sunGei, gmstRad, dipoleBasisForYear, decimalYear } from '../geomag/dipole.js';

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
export const RE_KM = 6371.2;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };

/** The dipole axis (north geomagnetic pole direction) as a unit vector in GSE. */
export function dipoleAxisGse(date) {
    const n = julianDate(date) - J2000;
    const m = dipoleBasisForYear(decimalYear(date)).z;
    const th = gmstRad(n);
    const M = [m[0] * Math.cos(th) - m[1] * Math.sin(th), m[0] * Math.sin(th) + m[1] * Math.cos(th), m[2]];
    const x = sunGei(n);                                   // GSE X: Earth → Sun
    const eps = (23.439 - 4e-7 * n) * DEG;
    const zEcl = [0, -Math.sin(eps), Math.cos(eps)];       // ecliptic north pole in GEI
    const y = unit(cross(zEcl, x));
    const z = cross(x, y);
    return [dot(M, x), dot(M, y), dot(M, z)];
}

/** μ: the GSE→GSM rotation angle about X, radians. See the SIGN note above. */
export function gseToGsmAngleRad(date) {
    const M = dipoleAxisGse(date);
    return Math.atan2(M[1], M[2]);
}

/** Rotate a GSE vector [x, y, z] into GSM by μ (radians). */
export function gseToGsm(v, mu) {
    const c = Math.cos(mu), s = Math.sin(mu);
    return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/** The inverse. */
export function gsmToGse(v, mu) { return gseToGsm(v, -mu); }

/**
 * The rotation angle a set of published (GSE, GSM) pairs actually used:
 * the least-squares μ with (y', z') = R(μ)(y, z). Samples too close to the
 * axis carry no angle and are weighted out by their own magnitude.
 * @param {Array<{by_gse,bz_gse,by_gsm,bz_gsm}>} samples
 * @returns {{ muRad:number, n:number, rmsNt:number } | null}
 */
export function fitRotationAngle(samples) {
    let sc = 0, ss = 0, n = 0;
    for (const p of samples) {
        const y = p.by_gse, z = p.bz_gse, yp = p.by_gsm, zp = p.bz_gsm;
        if (![y, z, yp, zp].every(Number.isFinite)) continue;
        sc += y * yp + z * zp;
        ss += y * zp - z * yp;
        n++;
    }
    if (n < 3 || (sc === 0 && ss === 0)) return null;
    const muRad = Math.atan2(ss, sc);
    let e2 = 0;
    for (const p of samples) {
        const y = p.by_gse, z = p.bz_gse, yp = p.by_gsm, zp = p.bz_gsm;
        if (![y, z, yp, zp].every(Number.isFinite)) continue;
        const r = gseToGsm([0, y, z], muRad);
        e2 += (r[1] - yp) ** 2 + (r[2] - zp) ** 2;
    }
    return { muRad, n, rmsNt: Math.sqrt(e2 / (2 * n)) };
}

/**
 * A spacecraft's position at `tMs`, R_E, in the frame of the samples, by
 * LINEAR interpolation between the two bracketing ephemeris rows (hourly; an
 * L1 halo orbit moves ~0.1 R_E an hour, so linear is exact to the last digit
 * that matters). Outside the record the nearest row is HELD for at most
 * `holdMs` and the result says so; beyond that it is null — never a guess.
 *
 * @param {Array<{t:number,x:number,y:number,z:number}>} samples ascending, km or R_E
 * @param {number} tMs
 * @param {{ unit?: 'km'|'Re', holdMs?: number }} [opts]
 * @returns {{ x:number, y:number, z:number, held:boolean } | null}
 */
export function positionAt(samples, tMs, { unit = 'km', holdMs = 6 * 3600e3 } = {}) {
    if (!samples?.length) return null;
    const k = unit === 'km' ? 1 / RE_KM : 1;
    const out = (s, held) => ({ x: s.x * k, y: s.y * k, z: s.z * k, held });
    const first = samples[0], last = samples[samples.length - 1];
    if (tMs <= first.t) return first.t - tMs <= holdMs ? out(first, tMs < first.t) : null;
    if (tMs >= last.t) return tMs - last.t <= holdMs ? out(last, tMs > last.t) : null;
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].t <= tMs) lo = m; else hi = m; }
    const a = samples[lo], b = samples[hi], f = (tMs - a.t) / (b.t - a.t);
    return { x: (a.x + f * (b.x - a.x)) * k, y: (a.y + f * (b.y - a.y)) * k, z: (a.z + f * (b.z - a.z)) * k, held: false };
}
