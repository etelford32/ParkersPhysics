/**
 * moon-exosphere-hops.js — a Monte-Carlo surface-boundary exosphere.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel: no DOM, no three.js, no ambient time, SEEDED (the renderer
 * and the node gate drive the same instance the same way). Gated by
 * tests/moon-exosphere-hops.mjs.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────
 * The one thing the analytic exosphere kernel (moon-exosphere-model.js)
 * says it is NOT — a transport simulation — in its simplest honest form:
 * N test atoms of one species, each launched from the regolith with a
 * flux-weighted Maxwellian at the LOCAL surface temperature, flown
 * ballistically under the Moon's central gravity (the same g the interior
 * kernel integrates), landed, re-thermalized, and relaunched. Nothing
 * about where the gas ends up is painted on: the night-side pooling of
 * helium, the dawn release of adsorbed argon, the sodium atoms that leave
 * on one hop, all EMERGE from the kinematics plus three per-species facts
 * from the species table — mass, the suprathermal source temperature for
 * Na/K, and whether the species adsorbs on cold regolith.
 *
 * It is the real Monte-Carlo method the lunar-exosphere literature uses
 * (Hodges 1973; Butler 1997; the LADEE-era models) at toy resolution:
 * ~10³ atoms instead of ~10⁶, uniform respawn instead of mapped sources,
 * isotropic re-emission with full thermal accommodation, no collisions
 * (which is correct — the real exosphere has none). Time runs COMPRESSED
 * (a thermal hop lasts ~15 min; the page shows it in ~3 s) and the panel
 * says by how much.
 *
 * What is physics: launch speeds, hop heights/times, the escape test
 * against v_esc(r), the photoionization clock for Na/K, the adsorption
 * residence time for Ar. What is decoration: particle count, respawn
 * placement, the time compression, the marker size the renderer picks.
 */

import {
    SPECIES, K_BOLTZ, AMU_KG, SURFACE_G_MS2, ESCAPE_V_MS,
    surfaceTemperatureK, residenceTimeS, SODIUM_PHOTOION_LIFETIME_HR,
} from './moon-exosphere-model.js';
import { R_MOON_KM } from './moon-interior-model.js';
import { SYNODIC_MONTH_DAYS } from './moon-ephemeris.js';

export const PHASE = Object.freeze({ REST: 0, FLY: 1, ESCAPE: 2 });
export const DEFAULT_TIME_COMPRESSION = 300;
export const SUBSTEP_S = 20;                   // sim seconds per integration step
export const RECYCLE_RADIUS = 2.6;             // moon radii: an escaper this far out is gone
export const MAX_RESIDENCE_S = 3e6;            // ~35 days — longer than any night
/** One local solar hour of the lunar day, in seconds (29.53 d / 24). */
export const LOCAL_HOUR_S = SYNODIC_MONTH_DAYS * 86400 / 24;
export const SYNODIC_SPIN_RAD_PER_S = 2 * Math.PI / (SYNODIC_MONTH_DAYS * 86400);
const R_M = R_MOON_KM * 1e3;
const GM = SURFACE_G_MS2 * R_M * R_M;

/** Small seeded PRNG (mulberry32) so a run is reproducible. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {object} o
 * @param {string} o.speciesKey    key in SPECIES
 * @param {number} [o.count=1500]
 * @param {number} [o.seed=1]
 * @param {number} [o.timeCompression=300]  sim seconds per real second
 * @param {number} [o.uniformTemperatureK]  test hook: override the surface map
 */
export function createHopSim({
    speciesKey, count = 1500, seed = 1, timeCompression = DEFAULT_TIME_COMPRESSION, uniformTemperatureK = null,
} = {}) {
    const species = SPECIES.find(s => s.key === speciesKey);
    if (!species) throw new Error(`createHopSim: unknown species ${speciesKey}`);
    const mass = species.amu * AMU_KG;
    const rand = mulberry32(seed);
    const n = count;
    const pos = new Float64Array(n * 3);      // metres, body frame
    const vel = new Float64Array(n * 3);      // m/s
    const phase = new Uint8Array(n);
    const restUntil = new Float64Array(n);    // sim seconds
    const restSince = new Float64Array(n);    // when the current rest began
    const apexKm = new Float32Array(n);       // highest point of the current/last hop
    const unit = new Float32Array(n * 3);     // positions in moon radii (renderer view)
    const sun = { x: 1, y: 0, z: 0 };
    let simTime = 0;
    const totals = { hops: 0, escapes: 0, ionized: 0, apexSumKm: 0, apexFlatSumKm: 0 };
    const ionRate = 1 / ((species.photoionLifetimeHr ?? SODIUM_PHOTOION_LIFETIME_HR) * 3600);
    const apexFlatKm = new Float32Array(n);   // v_z²/2g at launch — the flat-moon apex (test identity)

    const gauss = () => {
        const u = Math.max(rand(), 1e-12), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const zenithDeg = (i) => {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const r = Math.hypot(x, y, z) || 1;
        const c = (x * sun.x + y * sun.y + z * sun.z) / r;
        return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
    };
    const groundTempK = (i) => (uniformTemperatureK ?? surfaceTemperatureK(zenithDeg(i)));
    /** Local solar hour (0 = midnight) from the particle's longitude about the spin axis (+y). */
    const localHour = (i) => {
        const lon = Math.atan2(-pos[i * 3 + 2], pos[i * 3]);
        const lonSun = Math.atan2(-sun.z, sun.x);
        const h = 12 + (lon - lonSun) * (180 / Math.PI) / 15;
        return ((h % 24) + 24) % 24;
    };
    // THE FRAME IS SUN-FIXED. The exosphere is organized by the Sun, so the
    // simulation holds the sub-solar point still and turns the GROUND under
    // it at the synodic rate (prograde about +y). A resting atom therefore
    // drifts toward dawn with the regolith it sits on — which is how an
    // atom adsorbed at dusk comes to be released at sunrise two weeks later
    // without anybody moving the Sun. Flying atoms carry no such term: the
    // surface's 4.6 m/s is noise against a 300–1000 m/s thermal launch.
    let spinRadPerS = 2 * Math.PI / (SYNODIC_MONTH_DAYS * 86400);
    const rotateResting = (i, dt) => {
        const a = spinRadPerS * dt;
        const c = Math.cos(a), sn = Math.sin(a);
        const x = pos[i * 3], z = pos[i * 3 + 2];
        pos[i * 3] = x * c + z * sn;
        pos[i * 3 + 2] = -x * sn + z * c;
    };
    /** Launch temperature: suprathermal source on the dayside for Na/K, else the regolith. */
    const launchTempK = (i) => {
        const tGround = groundTempK(i);
        if (species.suprathermalK && zenithDeg(i) < 90) return species.suprathermalK;
        return tGround;
    };

    const respawn = (i) => {
        // Source placement: suprathermal species are MADE by sunlight and the
        // solar wind, so a new Na/K atom appears on the dayside weighted by
        // cos χ (the photon flux); noble gases (implanted solar wind released
        // everywhere, radiogenic venting) respawn uniformly.
        let x = gauss(), y = gauss(), z = gauss();
        let r = Math.hypot(x, y, z) || 1;
        if (species.suprathermalK) {
            for (let k = 0; k < 16; k++) {
                const c = (x * sun.x + y * sun.y + z * sun.z) / r;
                if (c > 0 && rand() < c) break;
                x = gauss(); y = gauss(); z = gauss();
                r = Math.hypot(x, y, z) || 1;
            }
        }
        pos[i * 3] = x / r * R_M; pos[i * 3 + 1] = y / r * R_M; pos[i * 3 + 2] = z / r * R_M;
        vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0;
        phase[i] = PHASE.REST;
        restUntil[i] = simTime;
        restSince[i] = simTime;
        apexKm[i] = 0;
    };

    const launch = (i) => {
        const T = launchTempK(i);
        const sigma = Math.sqrt(K_BOLTZ * T / mass);
        // Flux-weighted vertical component (p ∝ v_z exp(−v_z²/2σ²)), isotropic tangential
        const vz = sigma * Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12)));
        const vt1 = sigma * gauss(), vt2 = sigma * gauss();
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const r = Math.hypot(x, y, z) || 1;
        const nx = x / r, ny = y / r, nz = z / r;
        // Tangent basis: t = n × ŷ (or n × x̂ near the poles), b = n × t
        let tx, ty, tz;
        if (Math.abs(ny) < 0.9) { tx = -nz; ty = 0; tz = nx; }
        else { tx = 0; ty = nz; tz = -ny; }
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        vel[i * 3] = nx * vz + tx * vt1 + bx * vt2;
        vel[i * 3 + 1] = ny * vz + ty * vt1 + by * vt2;
        vel[i * 3 + 2] = nz * vz + tz * vt1 + bz * vt2;
        phase[i] = PHASE.FLY;
        apexKm[i] = 0;
        apexFlatKm[i] = vz * vz / (2 * SURFACE_G_MS2) / 1e3;
        totals.apexFlatSumKm += apexFlatKm[i];
        totals.hops++;
        // Escape test against the local escape speed (r = R here)
        const v2 = vel[i * 3] ** 2 + vel[i * 3 + 1] ** 2 + vel[i * 3 + 2] ** 2;
        if (v2 >= ESCAPE_V_MS * ESCAPE_V_MS) { phase[i] = PHASE.ESCAPE; totals.escapes++; }
    };

    const land = (i) => {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const r = Math.hypot(x, y, z) || 1;
        pos[i * 3] = x / r * R_M; pos[i * 3 + 1] = y / r * R_M; pos[i * 3 + 2] = z / r * R_M;
        vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0;
        phase[i] = PHASE.REST;
        totals.apexSumKm += apexKm[i];
        // Condensables AND the alkalis adsorb on cold regolith for an
        // Arrhenius residence time (the night side is a cold trap for Na/K
        // too — it is what feeds their own dawn enhancement); the light
        // noble gases re-emit on the next step.
        // Residence is re-evaluated as the ground warms (see stepOnce): an
        // adsorbed atom carried into daylight by the rotation lets go when
        // the Arrhenius clock at the NEW temperature has run out.
        restUntil[i] = simTime + ((species.condensable || species.suprathermalK)
            ? Math.min(MAX_RESIDENCE_S, residenceTimeS(groundTempK(i)))
            : 0);
        restSince[i] = simTime;
    };

    for (let i = 0; i < n; i++) respawn(i);

    /** Sunlit test for a particle at radius r: the shadow cylinder behind the Moon. */
    const sunlit = (i, r) => {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const along = x * sun.x + y * sun.y + z * sun.z;
        if (along >= 0) return true;
        const perp2 = r * r - along * along;
        return perp2 > R_M * R_M;
    };

    const stepOnce = (dt) => {
        const pIon = ionRate * dt;
        for (let i = 0; i < n; i++) {
            const ph = phase[i];
            if (ph === PHASE.REST) {
                rotateResting(i, dt);
                if (simTime < restUntil[i]) {
                    // The ground it sits on may have warmed since it landed
                    // (dawn arrives): residence is the Arrhenius time at the
                    // CURRENT temperature, measured from when the rest began.
                    const tau = residenceTimeS(groundTempK(i));
                    if (simTime - restSince[i] >= tau) { launch(i); continue; }
                    // An atom resting in daylight is still exposed to the Sun's
                    // ionizing UV; one adsorbed on the night side is shielded.
                    if (zenithDeg(i) < 90 && rand() < pIon) { totals.ionized++; respawn(i); }
                    continue;
                }
                launch(i);
                continue;
            }
            const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            const r2 = x * x + y * y + z * z;
            const r = Math.sqrt(r2);
            // Photoionization — only in sunlight; an atom in flight through
            // the shadow cylinder is safe until it comes out.
            if (rand() < pIon && sunlit(i, r)) { totals.ionized++; respawn(i); continue; }
            const a = -GM / (r2 * r);
            // Semi-implicit Euler under central gravity
            vel[i * 3] += a * x * dt; vel[i * 3 + 1] += a * y * dt; vel[i * 3 + 2] += a * z * dt;
            pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
            const rNew = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            const altKm = (rNew - R_M) / 1e3;
            if (altKm > apexKm[i]) apexKm[i] = altKm;
            if (ph === PHASE.ESCAPE) {
                if (rNew > RECYCLE_RADIUS * R_M) respawn(i);
            } else if (rNew <= R_M) {
                land(i);
            }
        }
        simTime += dt;
    };

    const refreshUnit = () => {
        for (let i = 0; i < n * 3; i++) unit[i] = pos[i] / R_M;
    };
    refreshUnit();

    return {
        species,
        count: n,
        timeCompression,
        /** Ground rotation rate under the fixed Sun (rad per SIM second); default synodic. */
        setSurfaceSpin(radPerSimS) { spinRadPerS = radPerSimS; },
        get surfaceSpinRadPerS() { return spinRadPerS; },
        localHour,
        /** Body-frame Sun direction (unit) — the surface temperature map hangs on it. */
        setSunDir(v) {
            const l = Math.hypot(v.x, v.y, v.z) || 1;
            sun.x = v.x / l; sun.y = v.y / l; sun.z = v.z / l;
        },
        get simTime() { return simTime; },
        /** Advance by real seconds (× timeCompression of simulated time), capped per call. */
        step(realSeconds) {
            let remaining = Math.min(realSeconds, 0.25) * timeCompression;
            while (remaining > 0) {
                const dt = Math.min(SUBSTEP_S, remaining);
                stepOnce(dt);
                remaining -= dt;
            }
            refreshUnit();
        },
        /** Advance by SIMULATED seconds (tests). */
        advanceSim(simSeconds) {
            let remaining = simSeconds;
            while (remaining > 0) {
                const dt = Math.min(SUBSTEP_S, remaining);
                stepOnce(dt);
                remaining -= dt;
            }
            refreshUnit();
        },
        /** Positions in moon radii (Float32Array, xyz interleaved, body frame). */
        get positions() { return unit; },
        get phases() { return phase; },
        get apexKm() { return apexKm; },
        get apexFlatKm() { return apexFlatKm; },
        zenithDeg,
        stats() {
            let rest = 0, fly = 0, esc = 0, night = 0, altSum = 0, frozen = 0, low = 0, lowNight = 0, flyNight = 0;
            for (let i = 0; i < n; i++) {
                const altKm = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]) / 1e3 - R_MOON_KM;
                if (phase[i] === PHASE.REST) {
                    rest++;
                    if (restUntil[i] - simTime > 3600) frozen++;
                } else if (phase[i] === PHASE.FLY) {
                    fly++;
                    altSum += altKm;
                } else esc++;
                const isNight = zenithDeg(i) > 90;
                if (isNight) night++;
                if (isNight && phase[i] === PHASE.FLY) flyNight++;
                // Surface-bound population: below ~3 scale heights of the
                // coldest gas, which is where "the exosphere" lives
                if (altKm < 400) { low++; if (isNight) lowNight++; }
            }
            const landed = totals.hops - fly - esc;
            return {
                resting: rest, flying: fly, escaping: esc, frozen,
                nightFraction: night / n,
                surfaceNightFraction: low ? lowNight / low : 0,
                flyingNightFraction: fly ? flyNight / fly : 0,
                meanFlightAltitudeKm: fly ? altSum / fly : 0,
                meanApexKm: landed > 0 ? totals.apexSumKm / landed : 0,
                meanApexFlatKm: totals.hops > 0 ? totals.apexFlatSumKm / totals.hops : 0,
                hops: totals.hops, escapes: totals.escapes, ionized: totals.ionized,
                simTimeS: simTime,
            };
        },
    };
}
