/**
 * cloud-time.js — the ONE copy of how the cloud layer relates to the clock.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE + THREE-free + DOM-free on purpose, so `node tests/cloud-time.mjs`
 * can pin every rule here without a GL context. Nothing in this module
 * fetches, renders, or reads ambient time — every function takes its
 * instants as arguments.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Before it, the cloud layer mixed THREE clocks and never said so:
 *
 *   • The Open-Meteo coverage grid followed the time bus (WeatherFrameResolver
 *     lerps hourly frames), so scrubbing moved the coarse 5° field.
 *   • The satellite mosaic — the sharpest, most trusted cloud signal, blended
 *     at 0.82 influence — was fetched for "now" every ten minutes and NEVER
 *     followed the bus. Scrub back six hours and the model field shifted
 *     underneath an observed frame that stayed pinned to wall-clock; scrub
 *     into the future and today's clouds were painted over a forecast globe.
 *   • The procedural noise that gives the clouds their shape ran on
 *     clock.getElapsedTime(): pause did not freeze it, 60× did not speed it
 *     up, and the same instant rendered differently every time it was
 *     revisited.
 *
 * Everything below is a function of SIMULATION time so the three agree.
 *
 * THE MOSAIC HAS A TIME DIMENSION (resolveMosaicTime)
 * ───────────────────────────────────────────────────
 * GIBS serves the geostationary IR products at their native ~10-min cadence
 * with real UTC timestamps (js/cloud-imagery.js already requested them that
 * way for "now"). A requested instant resolves to one of five modes:
 *
 *   live         within one cadence of the newest publishable frame → the
 *                frame the 10-min poll already fetches. Zero extra work.
 *   replay       in the past, inside the archive's retention → the 10-min
 *                frame at or before the instant. A real observation.
 *   nowcast      in the future, but no further than NOWCAST_MAX_MS → the
 *                newest observed frame, ADVECTED forward by the model wind.
 *                This is persistence-advection nowcasting — what operational
 *                nowcasts do out to a few hours, and for cloud it beats the
 *                5° NWP grid at short leads. Its confidence weight DECAYS
 *                with lead (mosaicWeight) and the page discloses it.
 *   model        further into the future → no observation exists. The mosaic
 *                weight is ZERO and the render falls back to the forecast
 *                grid alone. Painting "now" over a forecast globe is the one
 *                thing this module must never allow.
 *   unavailable  past the archive's retention (or a frame that could not be
 *                fetched, which the feed maps onto this mode) → weight zero,
 *                disclosed. An observation of the wrong instant is worse
 *                than none for anyone reading the clock.
 *
 * The RETENTION number is an ASSUMPTION: NASA is egress-blocked from the
 * build sandbox, so the rolling window of the GOES / Himawari / Meteosat
 * layers on GIBS has not been measured here. It is set wider than the time
 * bus's −7 d past window on purpose, so the only way a replay frame goes
 * 'unavailable' is a fetch that actually fails — which the feed reports
 * honestly rather than substituting a nearer frame.
 *
 * WIND-ADVECTED FLOW (flowPhase / advectDirection)
 * ─────────────────────────────────────────────────
 * Cloud motion between keyframes comes from the WIND, not from a noise
 * drift. Two things use it:
 *
 *   1. The mosaic is sampled UPSTREAM by (simTime − frameTime) × wind, so a
 *      10-min frame moves for the ten minutes it stands in for, and the next
 *      frame arrives where the previous one had already drifted to — the
 *      crossfade at a frame boundary is between two nearly identical fields
 *      instead of a swap. The same displacement, with a lead of hours, is
 *      the nowcast above.
 *   2. The procedural noise is a FLOW MAP: the sample point is displaced by
 *      the local wind for a bounded period T, on two layers half a period
 *      apart, cross-faded by a triangle wave (Vlachos' flow-map animation).
 *      Unbounded advection would shear the noise domain forever; a single
 *      periodic reset pops; two phases hide each other's resets exactly.
 *
 * The displacement is first-order semi-Lagrangian on the sphere: the wind at
 * the destination is used for the whole step, which is exact for uniform
 * flow and good to a few percent of the step for the ≤ 4 h leads clamped
 * below (a 5° grid cannot resolve the difference anyway).
 *
 * Winds aloft are stronger than the 10 m wind the scrubbed frames carry —
 * `windGainAt` scales the surface wind by altitude, a stated approximation
 * until the pressure-level winds ride the same hourly ring. The GLSL in
 * js/cloud-volume.js mirrors these functions; the constants are interpolated
 * from FLOW so the two cannot drift.
 */

export const R_EARTH_M = 6371000;

/** Mosaic timing constants. */
export const MOSAIC = Object.freeze({
    cadenceMin:    10,                       // GOES / Himawari / Meteosat full-disc cadence
    ingestLagMin:  20,                       // GIBS ingest delay before a frame is servable
    retentionMs:   30 * 24 * 3_600_000,      // ASSUMED rolling archive window — see header
    nowcastMaxMs:  3 * 3_600_000,            // persistence-advection horizon
    leadClampMs:   4 * 3_600_000,            // |simTime − frameTime| beyond this is not advected
});

/** Flow-map constants, mirrored into the shaders. */
export const FLOW = Object.freeze({
    periodSec:       7200,        // one advection cycle = 2 sim-hours
    // Shape-noise morph per sim-second. The old wall-clock drift was 0.0026
    // per second — tuned so a viewer at 1× saw something move within a
    // minute. Real cloud morphology evolves over HOURS, so the sim-time rate
    // is that number per sim-MINUTE: at 60× the viewer sees the old cadence,
    // at 1× the clouds are (correctly) still and the wind carries the motion,
    // and at 3600× a sim-hour per wall-second morphs without flickering.
    morphRatePerSec: 0.0026 / 60,
    windGainAloft:   1.8,         // surface → 10 km gain, see windGainAt
    windGainTopKm:   10.0,
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Floor an instant to the mosaic cadence.
 * @param {number} ms
 * @param {number} [cadenceMin]
 */
export function floorToCadence(ms, cadenceMin = MOSAIC.cadenceMin) {
    const cad = cadenceMin * 60_000;
    return Math.floor(ms / cad) * cad;
}

/**
 * Newest frame GIBS can be expected to serve at `nowMs`.
 * @param {number} nowMs
 * @param {{cadenceMin?:number, lagMin?:number}} [o]
 */
export function latestFrameMs(nowMs, { cadenceMin = MOSAIC.cadenceMin, lagMin = MOSAIC.ingestLagMin } = {}) {
    return floorToCadence(nowMs - lagMin * 60_000, cadenceMin);
}

/**
 * Confidence weight the mosaic carries for a given mode + lead.
 *   live / replay → 1
 *   nowcast       → decays 1 → 0.35 across the nowcast window (persistence
 *                   skill falls with lead; the floor keeps the observed
 *                   structure legible right up to the handoff, where the
 *                   feed cross-fades to the model)
 *   model / unavailable → 0
 * @param {string} mode
 * @param {number} leadMs   simTime − frameTime (≥ 0 for nowcast)
 * @param {{nowcastMaxMs?:number}} [o]
 */
export function mosaicWeight(mode, leadMs = 0, { nowcastMaxMs = MOSAIC.nowcastMaxMs } = {}) {
    if (mode === 'live' || mode === 'replay') return 1;
    if (mode === 'nowcast') {
        const f = clamp01(leadMs / Math.max(nowcastMaxMs, 1));
        return 1 - 0.65 * f;
    }
    return 0;
}

/**
 * Resolve a simulation instant to the observed frame that should stand in
 * for it. See the header for the five modes.
 *
 * @param {object} o
 * @param {number} o.simTimeMs
 * @param {number} o.nowMs
 * @param {number} [o.cadenceMin]
 * @param {number} [o.lagMin]
 * @param {number} [o.retentionMs]
 * @param {number} [o.nowcastMaxMs]
 * @returns {{ mode:'live'|'replay'|'nowcast'|'model'|'unavailable',
 *             frameMs:number|null, key:string|null, requestedMs:number,
 *             latestMs:number, leadMs:number, weight:number }}
 */
export function resolveMosaicTime({
    simTimeMs,
    nowMs,
    cadenceMin   = MOSAIC.cadenceMin,
    lagMin       = MOSAIC.ingestLagMin,
    retentionMs  = MOSAIC.retentionMs,
    nowcastMaxMs = MOSAIC.nowcastMaxMs,
} = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const requestedMs = Number.isFinite(simTimeMs) ? simTimeMs : now;
    const latestMs = latestFrameMs(now, { cadenceMin, lagMin });
    const cadMs = cadenceMin * 60_000;

    const out = (mode, frameMs) => {
        const leadMs = frameMs == null ? 0 : requestedMs - frameMs;
        return {
            mode,
            frameMs,
            key: frameMs == null ? null : new Date(frameMs).toISOString().slice(0, 16) + 'Z',
            requestedMs,
            latestMs,
            leadMs,
            weight: mosaicWeight(mode, leadMs, { nowcastMaxMs }),
        };
    };

    // Ahead of wall clock: nowcast for a while, then model only.
    if (requestedMs > now + cadMs) {
        // Lead is measured from the newest OBSERVED frame, not from wall
        // clock — the frame is what gets advected, ingest lag included.
        const leadFromLatest = requestedMs - latestMs;
        if (leadFromLatest <= nowcastMaxMs) return out('nowcast', latestMs);
        return out('model', null);
    }

    // From one cadence before the newest frame up to wall clock (the ingest
    // lag sits in here): what the live poll already serves.
    if (requestedMs >= latestMs - cadMs) return out('live', latestMs);

    // The past: the frame at or before the instant, if the archive still
    // holds it.
    if (now - requestedMs > retentionMs) return out('unavailable', null);
    return out('replay', floorToCadence(requestedMs, cadenceMin));
}

/**
 * Two-phase flow-map weights for sim-time `tSec` and period `periodSec`.
 *
 *   p0  phase of layer A in [0,1): its displacement is p0·T·wind
 *   p1  phase of layer B, half a period behind
 *   w   blend toward B: 1 exactly when A resets (p0 = 0), 0 when B resets
 *
 * Both resets are therefore hidden under the other layer at full weight.
 * @param {number} tSec
 * @param {number} [periodSec]
 */
export function flowPhase(tSec, periodSec = FLOW.periodSec) {
    const T = Math.max(periodSec, 1e-6);
    const p0 = ((tSec / T) % 1 + 1) % 1;
    const p1 = ((tSec / T + 0.5) % 1 + 1) % 1;
    const w  = Math.abs(2 * p0 - 1);
    return { p0, p1, w };
}

/**
 * Surface-wind → wind-aloft gain at altitude `altKm`. A smoothstep from 1 at
 * the surface to (1 + windGainAloft) at windGainTopKm and above. Stated
 * approximation; see header.
 * @param {number} altKm
 */
export function windGainAt(altKm) {
    const x = clamp01(altKm / FLOW.windGainTopKm);
    const s = x * x * (3 - 2 * x);
    return 1 + FLOW.windGainAloft * s;
}

/**
 * Local east / north tangent frame at unit direction `n` in the page's
 * Earth-fixed frame (spin axis = +Y, lon 0 at +X, lon 90°E at −Z — see
 * js/geo/coords.js latLonToNormal).
 * @param {number[]} n  unit vector [x, y, z]
 * @returns {{east:number[], north:number[]}}
 */
export function tangentFrame(n) {
    // east = normalize(cross(up, n)) with up = +Y  → (n.z, 0, −n.x)/|…|
    let ex = n[2], ez = -n[0];
    let el = Math.hypot(ex, ez);
    if (el < 1e-9) { ex = 1; ez = 0; el = 1; }   // pole: any tangent will do
    ex /= el; ez /= el;
    const east = [ex, 0, ez];
    // north = cross(n, east)
    const north = [
        n[1] * east[2] - n[2] * east[1],
        n[2] * east[0] - n[0] * east[2],
        n[0] * east[1] - n[1] * east[0],
    ];
    return { east, north };
}

/**
 * Displace a unit direction UPSTREAM by the wind for `dtSec`: the material
 * that is at `n` now was at the returned direction `dtSec` ago. Negative
 * `dtSec` therefore advects DOWNSTREAM. First-order semi-Lagrangian.
 *
 * @param {number[]} n        unit direction
 * @param {number}   uMs      eastward wind, m/s
 * @param {number}   vMs      northward wind, m/s
 * @param {number}   dtSec    lead in seconds
 * @param {number}   [gain]   windGainAt() factor
 * @returns {number[]} unit direction
 */
export function advectDirection(n, uMs, vMs, dtSec, gain = 1) {
    const { east, north } = tangentFrame(n);
    const k = (dtSec * gain) / R_EARTH_M;       // metres → radians
    const dx = (uMs * east[0] + vMs * north[0]) * k;
    const dy = (uMs * east[1] + vMs * north[1]) * k;
    const dz = (uMs * east[2] + vMs * north[2]) * k;
    const x = n[0] - dx, y = n[1] - dy, z = n[2] - dz;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
}

/**
 * Lead the shaders should advect a frame by, clamped so a stale feed can
 * never smear the observation off the globe.
 * @param {number} simTimeMs
 * @param {number|null} frameMs
 * @param {{leadClampMs?:number}} [o]
 * @returns {number} seconds
 */
export function clampedLeadSec(simTimeMs, frameMs, { leadClampMs = MOSAIC.leadClampMs } = {}) {
    if (!Number.isFinite(simTimeMs) || !Number.isFinite(frameMs)) return 0;
    const lead = simTimeMs - frameMs;
    return Math.max(-leadClampMs, Math.min(leadClampMs, lead)) / 1000;
}

/**
 * Human-readable disclosure for the layer tooltip / status pip.
 * @param {ReturnType<typeof resolveMosaicTime>} r
 */
export function describeMosaicMode(r) {
    if (!r) return 'Satellite: not resolved';
    const frame = r.frameMs == null ? null : new Date(r.frameMs).toISOString().slice(11, 16) + 'Z';
    const hrs = (ms) => `${(Math.abs(ms) / 3_600_000).toFixed(1)} h`;
    switch (r.mode) {
        case 'live':     return `Observed frame ${frame} (live)`;
        case 'replay':   return `Observed frame ${frame} · replay`;
        case 'nowcast':  return `Nowcast: frame ${frame} advected +${hrs(r.leadMs)} by the model wind · confidence ${Math.round(r.weight * 100)}%`;
        case 'model':    return `Model cloud only — no satellite image exists this far ahead (+${hrs(r.requestedMs - r.latestMs)})`;
        default:         return 'Model cloud only — no observed frame for this instant';
    }
}

export default resolveMosaicTime;
