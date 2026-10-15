/**
 * fleet-assessment-msis.js — the ONE NRLMSISE-00 profile provider for the
 * fleet assessment (scripts/build-sample-fleet-assessment.mjs in node,
 * js/fleet-storm-sim.js in the browser). PURE: the WASM functions are
 * injected, so both sides evaluate density identically and the sample bake
 * and the interactive simulator cannot drift apart.
 *
 * Profile shape and averaging mirror js/operations/msis-drag.js
 * `startMsisDecay` and tests/operations-msis-drag.mjs: equatorial, the mean
 * of local solar midnight and noon, F10.7 used for both daily and 81-day
 * values, Ap held flat across the 7-slot history. Season/UT come from one
 * fixed reference date so a run is reproducible.
 */

import { PROFILE_MIN_KM, PROFILE_MAX_KM, PROFILE_NPOINTS } from './operations/msis-drag.js';

export const PROFILE_STEP_KM = (PROFILE_MAX_KM - PROFILE_MIN_KM) / (PROFILE_NPOINTS - 1);

/**
 * @param {object} wasm  { nrlmsise00_density_profile, nrlmsise00_profile_stride }
 * @param {number} refMs reference instant (season + UT)
 * @returns {(f107:number, ap:number, dateMs?:number) => {alt0,step,rho}}
 */
export function makeMsisProfileProvider(wasm, refMs) {
    const { nrlmsise00_density_profile: profileFn, nrlmsise00_profile_stride: strideFn } = wasm;
    const alts = Float64Array.from({ length: PROFILE_NPOINTS }, (_, i) => PROFILE_MIN_KM + i * PROFILE_STEP_KM);
    const cache = new Map();
    return function profileAt(f107, ap, dateMs = refMs) {
        const key = `${f107}|${ap}|${dateMs}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const d   = new Date(dateMs);
        const doy = Math.floor((dateMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
        const sec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60;
        const stride = strideFn();
        const rho = new Float64Array(PROFILE_NPOINTS);
        for (const lst of [0, 12]) {
            const lon  = ((lst - sec / 3600) * 15 + 540) % 360 - 180;
            const flat = profileFn(d.getUTCFullYear(), doy, sec, 0, lon, lst,
                f107, f107, new Float64Array(7).fill(ap), alts);
            for (let i = 0; i < PROFILE_NPOINTS; i++) rho[i] += 0.5 * flat[i * stride + 6];
        }
        const p = { alt0: PROFILE_MIN_KM, step: PROFILE_STEP_KM, rho };
        cache.set(key, p);
        return p;
    };
}
