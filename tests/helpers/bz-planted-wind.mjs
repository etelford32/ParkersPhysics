/**
 * tests/helpers/bz-planted-wind.mjs — a PLANTED solar wind for the Bz engine's
 * gates: one band-limited random field carried past the spacecraft as a tilted
 * PLANE, so every arrival time is known in closed form. SYNTHETIC by design —
 * it is the truth the estimators are scored against, not a stand-in for data.
 */
import { RE_KM, gseToGsmAngleRad, gsmToGse } from '../../js/bz/frames.js';
import { STEP_MS } from '../../js/bz/fuse-l1.js';

export const DEG = 180 / Math.PI;
/** GSE, R_E — the geometry MEASURED on 2026-11-20. */
export const POS = Object.freeze({
    ACE:    { x: 230.25, y: 41.04,  z: 22.02 },
    IMAP:   { x: 227.66, y: -36.79, z: -5.71 },
    SOLAR1: { x: 225.01, y: -48.06, z: -18.29 },
});

export function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    return { u, g: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) };
}

/** Unit normal from two tilt angles (degrees): about z (in x–y) then toward z. */
export function unitNormal(tiltXY, tiltZ = 0) {
    const a = tiltXY / DEG, b = tiltZ / DEG;
    return { x: Math.cos(a) * Math.cos(b), y: Math.sin(a) * Math.cos(b), z: Math.sin(b) };
}

/** Minutes at which a plane (normal n, radial speed v km/s) reaches p, relative to the origin. */
export function arrivalMin(p, n, v) { return -((p.x * n.x + p.y * n.y + p.z * n.z) * RE_KM) / (v * n.x) / 60; }

export function plantedField(seed, minutes, lead = 400) {
    const R = rng(seed), N = minutes + 2 * lead;
    const mk = (corr, amp, mean = 0) => {
        const a = new Float64Array(N); let x = 0; const phi = Math.exp(-1 / corr);
        for (let i = 0; i < N; i++) { x = phi * x + Math.sqrt(1 - phi * phi) * R.g(); a[i] = mean + amp * x; }
        return a;
    };
    return { bx: mk(40, 2), by: mk(30, 3), bz: mk(25, 4), lead, N };
}
export function at(arr, tau) {
    const i = Math.floor(tau), f = tau - i;
    if (i < 0 || i + 1 >= arr.length) return NaN;
    return arr[i] * (1 - f) + arr[i + 1] * f;
}

/**
 * Normalised-feed-shaped payloads (rows for rtsw_mag_1m / rtsw_wind_1m /
 * ephemerides) whose LAST minute is `nowMs − ageMs`.
 */
export function plantedFeeds({ field, normal, speedKms = 400, densityCc = 5, minutes = 1440, nowMs, ageMs = 120e3,
    noise = 0.25, seed = 7, active = 'SOLAR1', pos = POS, vector = false, plasmaFor = null } = {}) {
    const R = rng(seed);
    const tLast = Math.round((nowMs - ageMs) / STEP_MS) * STEP_MS;
    const t0 = tLast - (minutes - 1) * STEP_MS;
    const mag = [], wind = [], eph = [];
    for (const [sc, p] of Object.entries(pos)) {
        const d = arrivalMin(p, normal, speedKms);
        for (let i = 0; i < minutes; i++) {
            const t = t0 + i * STEP_MS, tau = i + field.lead - d;
            const b = [at(field.bx, tau) + noise * R.g(), at(field.by, tau) + noise * R.g(), at(field.bz, tau) + noise * R.g()];
            const e = gsmToGse(b, gseToGsmAngleRad(new Date(t)));
            mag.push({ time_tag: new Date(t).toISOString().replace('Z', ''), source: sc, active: sc === active,
                bx_gsm: b[0], by_gsm: b[1], bz_gsm: b[2], bx_gse: e[0], by_gse: e[1], bz_gse: e[2], bt: Math.hypot(...b), overall_quality: 0 });
            if (!plasmaFor || plasmaFor.includes(sc)) {
                wind.push({ time_tag: new Date(t).toISOString().replace('Z', ''), source: sc, active: sc === active,
                    proton_speed: speedKms + R.g(), proton_density: densityCc + 0.05 * R.g(), proton_temperature: 2.4e5,
                    ...(vector ? { proton_vx_gse: -speedKms, proton_vy_gse: 0, proton_vz_gse: 0 } : {}) });
            }
        }
        for (let h = -30; h <= 0; h++) eph.push({ time_tag: new Date(Math.floor(nowMs / 3600e3) * 3600e3 + h * 3600e3).toISOString(), source: sc,
            x_gse: p.x * RE_KM, y_gse: p.y * RE_KM, z_gse: p.z * RE_KM });
    }
    return { mag, wind, eph, t0, tLast };
}
