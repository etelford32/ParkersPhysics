/**
 * msis-profile.js — the density-profile provider the scheduled decay
 * path injects (DECAY_BRIEF_PLAN.md §3, gap A).
 * ═══════════════════════════════════════════════════════════════════════════
 * Same profile shape as js/operations/msis-drag.js `startMsisDecay`
 * (equatorial, day/night-averaged: two NRLMSISE-00 columns at local solar
 * midnight and noon, averaged — the diurnal swing is ×2–3 at 400 km and an
 * orbit passes through both sides), with the two inputs that provider
 * cannot carry:
 *   • the 81-day CENTRED F10.7A from the schedule (the console passes
 *     f107 as both F10.7 and F10.7A in node, and the bridge's own
 *     trailing estimate in the browser);
 *   • the 7-element ap HISTORY array, so storm-time density lags its ap
 *     the way MSIS models it.
 *
 * The WASM entry points are INJECTED ({ densityProfile, profileStride },
 * i.e. nrlmsise00_density_profile / nrlmsise00_profile_stride from the
 * committed js/sgp4-wasm build), so this file stays PURE and loadable in
 * node without a fetch. Gate: node tests/decay-driver-schedule.mjs
 */

import { PROFILE_MIN_KM, PROFILE_MAX_KM, PROFILE_NPOINTS } from '../operations/msis-drag.js';

const RHO_COLUMN = 6;      // total mass density, kg/m³, in the WASM row

function doyOf(date) {
    return Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
}

export function makeMsisProfileProvider({
    densityProfile, profileStride,
    minKm = PROFILE_MIN_KM, maxKm = PROFILE_MAX_KM, nPoints = PROFILE_NPOINTS,
}) {
    if (typeof densityProfile !== 'function' || typeof profileStride !== 'function') {
        throw new Error('makeMsisProfileProvider: inject densityProfile + profileStride');
    }
    const step = (maxKm - minKm) / (nPoints - 1);
    const alts = new Float64Array(nPoints);
    for (let i = 0; i < nPoints; i++) alts[i] = minKm + i * step;
    const stride = profileStride();

    return ({ f107, f107a, ap, apArray, dateMs }) => {
        const date = new Date(dateMs);
        const sec  = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
        const utHr = sec / 3600;
        const apArr = Array.isArray(apArray) && apArray.length === 7
            ? Float64Array.from(apArray)
            : new Float64Array(7).fill(ap);
        const fa = Number.isFinite(f107a) ? f107a : f107;
        const rho = new Float64Array(nPoints);
        for (const lst of [0, 12]) {
            const lon  = ((lst - utHr) * 15 + 540) % 360 - 180;
            const flat = densityProfile(date.getUTCFullYear(), doyOf(date), sec,
                0, lon, lst, fa, f107, apArr, alts);
            if (!flat) return null;
            for (let i = 0; i < nPoints; i++) rho[i] += 0.5 * flat[i * stride + RHO_COLUMN];
        }
        return { alt0: minKm, step, rho };
    };
}
