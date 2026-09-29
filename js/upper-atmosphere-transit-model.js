/**
 * upper-atmosphere-transit-model.js — travelling THROUGH the layers
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel for the layer-transit mode. No THREE, no DOM, no ambient
 * time. Node-tested by `tests/upper-atmosphere-transit.mjs`.
 *
 * Two questions, both answered from the page's ONE density model:
 *
 *   1. WHERE IS THE CAMERA, and where should it look, when it rides the
 *      local vertical above a point on the ground? `transitPose` builds the
 *      position from the canonical frame (`latLonToScene`) and a forward
 *      direction from a compass heading + pitch in the local east/north/up
 *      basis, so the horizon is level and "east" is the texture's east.
 *
 *   2. WHAT IS THE MEDIUM AROUND IT? `ambientGas` turns the engine's point
 *      physics at the camera's altitude into the parameters of a camera-
 *      local particle cloud: how many dots (∝ log₁₀ n_total — the number
 *      density spans ten decades from 80 to 2000 km and a linear count
 *      would be either empty or a wall), which species each dot is (drawn
 *      from the engine's number fractions, so composition CHANGES as you
 *      descend: N₂ blue → atomic-O amber → He pink → H yellow), how fast
 *      they jitter (∝ the dominant species' thermal speed, compressed by
 *      the same factor the layer particle systems use), and how far a dot
 *      flies before it changes heading (the mean free path, so the
 *      mesosphere reads as a random walk and the exosphere as straight
 *      ballistic arcs).
 *
 * THE CLOUD IS A SYMBOL, NOT A SIMULATION. One dot is not one molecule:
 * at 400 km there are ~10¹⁵ per cubic metre. Every number the cloud is
 * built from is real (n, fractions, v_th, λ) and the legend says what the
 * mapping is; the dot COUNT is a log stretch and is disclosed as one.
 */

import { pointPhysics, SPECIES_COLOR_HEX } from './upper-atmosphere-physics.js';
import { SPECIES } from './upper-atmosphere-engine.js';
import { latLonToScene, sceneToLatLon, R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM } from './upper-atmosphere-column.js';

const DEG = Math.PI / 180;

export { R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM };

/** Dot budget and the log₁₀ n_total span it is stretched over. */
export const CLOUD = Object.freeze({
    maxDots: 4000,
    minDots: 120,                // never an empty exosphere — a few atoms still pass
    logNLo: 11.0,                // ~2000 km
    logNHi: 20.6,                // ~80 km
    radiusRunit: 0.03,           // cloud radius around the camera, R⊕ (~190 km)
    dotSizeRunit: 0.0005,
    vthVisFactor: 1 / 4.0e6,     // R⊕ per (m/s · s): v_th → drawn drift (symbolic)
    maxStepRunit: 0.002,
});

/**
 * Local east / north / up unit vectors in the SCENE frame at (lat, lon).
 * East is the direction of increasing longitude in `latLonToScene`, i.e.
 * −Z at Greenwich — the texture's east, not the old mirrored one.
 */
export function localBasis(latDeg, lonDeg) {
    const phi = latDeg * DEG, lam = lonDeg * DEG;
    const up = latLonToScene(latDeg, lonDeg);
    const east = [-Math.sin(lam), 0, -Math.cos(lam)];
    // north = up × east
    const north = [
        up[1] * east[2] - up[2] * east[1],
        up[2] * east[0] - up[0] * east[2],
        up[0] * east[1] - up[1] * east[0],
    ];
    void phi;
    return { up, east, north };
}

/**
 * Camera pose on the local vertical above (lat, lon) at `altKm`, looking
 * along compass `headingDeg` (0 = north, 90 = east) tilted by `pitchDeg`
 * (+ up). Returns scene-frame position, forward and up.
 */
export function transitPose({ latDeg, lonDeg, altKm, headingDeg = 90, pitchDeg = 0 }) {
    const { up, east, north } = localBasis(latDeg, lonDeg);
    const r = 1 + altKm / R_EARTH_KM;
    const position = [up[0] * r, up[1] * r, up[2] * r];
    const h = headingDeg * DEG, p = pitchDeg * DEG;
    const ch = Math.cos(p) * Math.sin(h), cn = Math.cos(p) * Math.cos(h), cu = Math.sin(p);
    const forward = [0, 1, 2].map(i => ch * east[i] + cn * north[i] + cu * up[i]);
    return { position, forward, up };
}

/** Sub-camera latitude / longitude / altitude of a scene position. */
export function poseFromPosition(p) {
    const ll = sceneToLatLon(p);
    const r = Math.hypot(p[0], p[1], p[2]);
    return { latDeg: ll.latDeg, lonDeg: ll.lonDeg, altKm: (r - 1) * R_EARTH_KM };
}

/**
 * Altitude along a constant-rate transit: from `fromKm` toward `toKm` at
 * `kmPerSec` of real time, clamped at the target.
 */
/** Where a descent stops: half a km above the floor so the readouts stay in-domain. */
export const TRANSIT_FLOOR_KM = MODEL_FLOOR_KM + 0.5;

export function transitAltitude({ fromKm, toKm, kmPerSec, tS }) {
    const dir = Math.sign(toKm - fromKm) || 1;
    const span = Math.abs(toKm - fromKm);
    const travelled = Math.max(0, kmPerSec) * Math.max(0, tS);
    const done = travelled >= span;
    return { altKm: fromKm + dir * Math.min(span, travelled), done, fraction: span > 0 ? Math.min(1, travelled / span) : 1 };
}

/**
 * The camera-local gas at one altitude: everything the cloud renderer
 * needs, all traced to `pointPhysics`.
 *
 * @returns {{ count:number, fractions:object, species:Array<{id,fraction,hex}>,
 *             dominant:string, dominantHex:number, vth_m_s:number, mfp_km:number,
 *             knudsen:number, regime:string, T:number, rho:number, nTotal:number,
 *             logN:number, densityNorm:number, driftRunitPerS:number,
 *             headingChangeHz:number, outOfBand:boolean }}
 */
export function ambientGas({ altitudeKm, f107Sfu = 150, ap = 15 }) {
    const outOfBand = !(altitudeKm >= MODEL_FLOOR_KM && altitudeKm <= MODEL_CEIL_KM);
    const alt = Math.max(MODEL_FLOOR_KM, Math.min(MODEL_CEIL_KM, altitudeKm));
    const ph = pointPhysics({ altitudeKm: alt, f107Sfu, ap });
    const logN = Math.log10(Math.max(ph.n, 1));
    const densityNorm = Math.max(0, Math.min(1, (logN - CLOUD.logNLo) / (CLOUD.logNHi - CLOUD.logNLo)));
    const count = outOfBand && altitudeKm > MODEL_CEIL_KM
        ? 0
        : Math.round(CLOUD.minDots + (CLOUD.maxDots - CLOUD.minDots) * densityNorm);
    const species = SPECIES
        .map(id => ({ id, fraction: ph.fractions[id] || 0, hex: SPECIES_COLOR_HEX[id] ?? 0xffffff }))
        .filter(s => s.fraction > 1e-4)
        .sort((a, b) => b.fraction - a.fraction);
    // Drift per second of real time, symbolic compression of v_th.
    const drift = Math.min(CLOUD.maxStepRunit * 60, ph.vth_m_s * CLOUD.vthVisFactor);
    // How often a dot re-draws its heading: the collision frequency,
    // compressed onto a 0.2–20 Hz band so the random walk is visible in the
    // mesosphere and the exosphere's dots hold a heading for seconds.
    const headingChangeHz = Math.max(0.2, Math.min(20, ph.collisionHz > 0 ? Math.log10(1 + ph.collisionHz) * 4 : 0.2));
    return {
        count, fractions: ph.fractions, species,
        dominant: ph.dominant, dominantHex: ph.dominantColor,
        vth_m_s: ph.vth_m_s, mfp_km: ph.mfp_km, knudsen: ph.knudsen, regime: ph.regime,
        T: ph.T, rho: ph.ρ, nTotal: ph.n, logN, densityNorm,
        driftRunitPerS: drift, headingChangeHz, outOfBand,
    };
}

/**
 * Assign `count` dots to species by cumulative fraction (deterministic
 * given a hash seed so the assignment does not flicker between frames).
 * Returns an Int8Array of indices into `gas.species`.
 */
export function assignSpecies(gas, count, seed = 1) {
    const out = new Int8Array(count);
    const cum = [];
    let acc = 0;
    for (const s of gas.species) { acc += s.fraction; cum.push(acc); }
    const total = acc || 1;
    let x = seed >>> 0 || 1;
    for (let i = 0; i < count; i++) {
        // xorshift32 — the same dot keeps the same species across frames.
        x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
        const u = (x / 4294967296) * total;
        let k = 0;
        while (k < cum.length - 1 && u > cum[k]) k++;
        out[i] = k;
    }
    return out;
}

/** One-line legend for the cloud, so the page can say what a dot means. */
export function ambientLegend(gas) {
    if (!gas) return '';
    const comp = gas.species.slice(0, 3).map(s => `${s.id} ${(s.fraction * 100).toFixed(0)}%`).join(' · ');
    return `camera-local gas — ${gas.count} dots ∝ log₁₀ n (n = ${gas.nTotal.toExponential(1)} m⁻³) · `
         + `${comp} · v_th ${Math.round(gas.vth_m_s)} m/s · λ ${gas.mfp_km >= 1 ? gas.mfp_km.toFixed(0) + ' km' : (gas.mfp_km * 1000).toFixed(1) + ' m'} · ${gas.regime}`;
}
