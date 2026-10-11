/**
 * upper-atmosphere-ops-bands.js — the operational altitude bands (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * The page already knows the atmosphere two ways: the PHYSICS layers
 * (`upper-atmosphere-layers.js`: mesosphere → outer exosphere, by what the
 * gas is doing) and the ENGINE's formal table (`ATMOSPHERIC_LAYERS`). Neither
 * answers the operator's question, which is about SPACECRAFT, not gas:
 * "what happens to a vehicle at this altitude, and how long does it stay".
 *
 * This module is the ONE copy of that third view — the altitude bands a
 * mission planner thinks in, from the entry interface to the top of LEO —
 * and the numbers the page prints beside each one. It is PURE (no DOM, no
 * three.js, no ambient time) and node-gated by tests/upper-atmosphere-ops-bands.mjs.
 *
 * WHAT THE BANDS ARE
 * ──────────────────
 * Named by OPERATIONS, bounded by round altitudes where the operational
 * character changes, and deliberately NOT aligned with the physics layers:
 * a band edge here is a planning convention ("below this perigee you are
 * down within a day"), and drawing it over the volumetric render as a thin
 * ring is a RULER, not a claim that the gas changes there. The render's own
 * legend already says the physics layers' boundaries are names; these are
 * names too, and the layer legend says so.
 *
 * EVERY NUMBER COMES FROM THE ENGINE
 * ─────────────────────────────────
 * `bandMetrics` evaluates the engine's own `density()` (the ONE density
 * model on this page — the §2.1 rule) at the band's representative altitude
 * and derives:
 *   • circular orbital speed and period from μ (closed form);
 *   • the drag deceleration ρ v² / (2 B) for a stated ballistic coefficient;
 *   • an ORBITAL-LIFETIME ESTIMATE, King–Hele's closed form for a circular
 *     orbit in an exponential atmosphere with the LOCAL scale height:
 *         L ≈ B · H / (ρ · a · v)
 *     It is an order-of-magnitude figure (a real decay integrates a density
 *     that varies with solar cycle, season and local time — the fleet
 *     analyzer's WASM integrator does that per object); this is the number
 *     an operator uses to decide whether a band is "days", "months" or
 *     "centuries", and it is printed as such, with B disclosed. It scales
 *     LINEARLY in B, so the readout states the reference B rather than
 *     pretending to know the vehicle.
 *
 * The reference ballistic coefficient is 50 kg/m² (a generic smallsat; a
 * 1U CubeSat is ~60, the ISS ~75, a Starlink v1.5 bus ~15). Callers may pass
 * their own.
 */

import { density } from './upper-atmosphere-engine.js';

export const R_EARTH_KM = 6371;
export const MU_KM3_S2 = 398600.4418;
export const REF_BALLISTIC_KG_M2 = 50;

/**
 * The bands. `short` is the on-canvas label (≤ 9 characters so it fits a
 * limb ruler segment), `refKm` the representative altitude the metrics are
 * evaluated at, `examples` real assets that live there, `ops` what the band
 * means for planning. Colours are a single perceptual ramp warm → cool with
 * altitude so the ladder reads top-to-bottom at a glance; they are DISTINCT
 * from the physics layers' palette on purpose (orange thermosphere / violet
 * exosphere) so the two rulers cannot be confused for each other.
 */
export const OPS_BANDS = Object.freeze([
    Object.freeze({
        id: 'entry', name: 'Entry interface', short: 'ENTRY',
        minKm: 80, maxKm: 120, refKm: 100, colorHex: 0xff5e6a,
        ops: 'Entry interface (122 km) to peak heating. Nothing orbits: a vehicle here is coming down this pass. Plasma blackout; uncontrolled bodies break up near the floor.',
        examples: ['Kármán line 100 km', 'Shuttle / Dragon entry interface 122 km'],
    }),
    Object.freeze({
        id: 'decay', name: 'Decay zone', short: 'DECAY',
        minKm: 120, maxKm: 200, refKm: 160, colorHex: 0xff9a4d,
        ops: 'Perigee here means re-entry within hours to days. Deorbit burns target it; sounding rockets and capsules pass through it.',
        examples: ['Deorbit perigee targets', 'Sounding-rocket apogees'],
    }),
    Object.freeze({
        id: 'vleo', name: 'Very low Earth orbit', short: 'VLEO',
        minKm: 200, maxKm: 350, refKm: 275, colorHex: 0xffd24d,
        ops: 'Drag-dominated. Weeks to months of passive lifetime; sustained operation needs continuous thrust. Constellations deploy and raise through it.',
        examples: ['GOCE 255 km', 'Starlink deployment ~290 km'],
    }),
    Object.freeze({
        id: 'station', name: 'Crewed-station band', short: 'STATION',
        minKm: 350, maxKm: 450, refKm: 420, colorHex: 0x5fe3a8,
        ops: 'Where crewed stations fly: low enough for reach and debris shielding, high enough for months between reboosts. Storm-time density doubles the decay rate.',
        examples: ['ISS ~420 km', 'Tiangong ~390 km'],
    }),
    Object.freeze({
        id: 'constellation', name: 'Constellation shells', short: 'CONSTELL',
        minKm: 450, maxKm: 600, refKm: 550, colorHex: 0x5fd8ff,
        ops: 'Broadband shells and most new smallsats. Passive decay within the 5-year post-mission rule still holds here; above ~600 km it does not.',
        examples: ['Starlink 540–570 km', 'Hubble ~530 km'],
    }),
    Object.freeze({
        id: 'sso', name: 'Sun-synchronous imaging', short: 'SSO',
        minKm: 600, maxKm: 850, refKm: 705, colorHex: 0x7fa6ff,
        ops: 'Earth-observation altitudes: constant local time, repeat ground tracks. Drag is a trim term; lifetimes run decades to centuries without a deorbit device.',
        examples: ['Landsat 705 km', 'Sentinel-2 786 km', 'Iridium 780 km'],
    }),
    Object.freeze({
        id: 'upper-leo', name: 'Upper LEO', short: 'UPPER LEO',
        minKm: 850, maxKm: 1200, refKm: 1000, colorHex: 0xa98bff,
        ops: 'Weather and broadband polar orbits. Effectively drag-free: what goes here stays for centuries, which is why the debris population peaks just below it.',
        examples: ['NOAA / Metop ~830 km', 'OneWeb 1200 km'],
    }),
    Object.freeze({
        id: 'leo-top', name: 'Top of LEO', short: 'LEO TOP',
        minKm: 1200, maxKm: 2000, refKm: 1600, colorHex: 0xd49cff,
        ops: 'LEO by definition ends at 2000 km; the model ends with it. Geocoronal hydrogen only. Atmospheric drag is no longer a design input.',
        examples: ['Inner Van Allen belt above', 'MEO / GNSS far above'],
    }),
]);

export const OPS_FLOOR_KM = OPS_BANDS[0].minKm;
export const OPS_CEIL_KM = OPS_BANDS[OPS_BANDS.length - 1].maxKm;

/** Every band edge, ascending, de-duplicated. */
export const OPS_EDGES_KM = Object.freeze(
    [...new Set(OPS_BANDS.flatMap(b => [b.minKm, b.maxKm]))].sort((a, b) => a - b));

/** The band an altitude falls in (half-open), the top band at the ceiling, null outside. */
export function bandForAltitude(altKm) {
    if (!Number.isFinite(altKm)) return null;
    for (const b of OPS_BANDS) if (altKm >= b.minKm && altKm < b.maxKm) return b;
    if (altKm === OPS_CEIL_KM) return OPS_BANDS[OPS_BANDS.length - 1];
    return null;
}

/** `#rrggbb` for a band colour (or any hex int). */
export function hexCss(n) { return `#${(n >>> 0).toString(16).padStart(6, '0')}`; }

/** Circular orbital speed [km/s] at an altitude. */
export function circularSpeedKmS(altKm) {
    return Math.sqrt(MU_KM3_S2 / (R_EARTH_KM + altKm));
}

/** Circular orbital period [s] at an altitude. */
export function circularPeriodS(altKm) {
    const a = R_EARTH_KM + altKm;
    return 2 * Math.PI * Math.sqrt(a * a * a / MU_KM3_S2);
}

/**
 * King–Hele circular-orbit lifetime [s] for an exponential atmosphere:
 * L ≈ B·H / (ρ·a·v), with H the LOCAL scale height, a the orbit radius and
 * v the circular speed. Inputs in SI except where named.
 * @param {object} o
 * @param {number} o.rhoKgM3       density at the orbit
 * @param {number} o.scaleHeightKm local scale height
 * @param {number} o.altKm
 * @param {number} [o.ballisticKgM2=REF_BALLISTIC_KG_M2]
 */
export function lifetimeKingHeleS({ rhoKgM3, scaleHeightKm, altKm, ballisticKgM2 = REF_BALLISTIC_KG_M2 }) {
    if (!(rhoKgM3 > 0) || !(scaleHeightKm > 0) || !Number.isFinite(altKm)) return Infinity;
    const a = (R_EARTH_KM + altKm) * 1000;
    const v = circularSpeedKmS(altKm) * 1000;
    return ballisticKgM2 * scaleHeightKm * 1000 / (rhoKgM3 * a * v);
}

/** Drag deceleration [m/s²] on a body with ballistic coefficient B at circular speed. */
export function dragDecelMS2({ rhoKgM3, altKm, ballisticKgM2 = REF_BALLISTIC_KG_M2 }) {
    const v = circularSpeedKmS(altKm) * 1000;
    return rhoKgM3 * v * v / (2 * ballisticKgM2);
}

/** A lifetime in seconds as the word an operator uses, plus the class. */
export function lifetimeLabel(s) {
    if (!Number.isFinite(s)) return { text: 'no decay', cls: 'none' };
    const h = s / 3600, d = h / 24, y = d / 365.25;
    if (h < 1)    return { text: `${Math.max(1, Math.round(s / 60))} min`, cls: 'hours' };
    if (h < 48)   return { text: `${h.toFixed(h < 10 ? 1 : 0)} h`, cls: 'hours' };
    if (d < 60)   return { text: `${Math.round(d)} d`, cls: 'days' };
    if (y < 2)    return { text: `${Math.round(d / 30.44)} mo`, cls: 'months' };
    if (y < 100)  return { text: `${y.toFixed(y < 10 ? 1 : 0)} yr`, cls: 'years' };
    if (y < 1e4)  return { text: `${Math.round(y / 100) * 100} yr`, cls: 'centuries' };
    return { text: '> 10 000 yr', cls: 'centuries' };
}

/**
 * The numbers printed for one band under the live indices.
 * @param {object} band  an OPS_BANDS entry (or any {refKm})
 * @param {object} o
 * @param {number} o.f107Sfu
 * @param {number} o.ap
 * @param {number} [o.altKm=band.refKm]       evaluate at another altitude inside the band
 * @param {number} [o.ballisticKgM2]
 */
export function bandMetrics(band, { f107Sfu = 150, ap = 15, altKm = null, ballisticKgM2 = REF_BALLISTIC_KG_M2 } = {}) {
    const z = Number.isFinite(altKm) ? altKm : band.refKm;
    const s = density({ altitudeKm: Math.max(80, z), f107Sfu, ap });
    const vKmS = circularSpeedKmS(z);
    const periodS = circularPeriodS(z);
    const lifetimeS = lifetimeKingHeleS({ rhoKgM3: s.rho, scaleHeightKm: s.H_km, altKm: z, ballisticKgM2 });
    const decelMS2 = dragDecelMS2({ rhoKgM3: s.rho, altKm: z, ballisticKgM2 });
    // Height lost per orbit for a circular orbit: Δa = 2π ρ a² / B.
    const aM = (R_EARTH_KM + z) * 1000;
    const decayPerOrbitM = 2 * Math.PI * s.rho * aM * aM / ballisticKgM2;
    return {
        id: band.id, altKm: z,
        rhoKgM3: s.rho, scaleHeightKm: s.H_km, T: s.T,
        vKmS, periodMin: periodS / 60,
        lifetimeS, lifetime: lifetimeLabel(lifetimeS),
        decelMS2, decayPerOrbitM,
        ballisticKgM2,
    };
}

/**
 * The whole ladder under the live indices — one row per band, for the
 * readout / legend / explore column.
 */
export function opsLadder({ f107Sfu = 150, ap = 15, ballisticKgM2 = REF_BALLISTIC_KG_M2 } = {}) {
    return OPS_BANDS.map(b => ({ band: b, metrics: bandMetrics(b, { f107Sfu, ap, ballisticKgM2 }) }));
}

/**
 * Position of an altitude on a LOG ladder spanning the bands — the same
 * mapping the explore column uses (`gaugeFraction`), restated here so the
 * ops strip on that column and the kernel agree by construction.
 */
export function ladderFraction(altKm, floorKm = OPS_FLOOR_KM, ceilKm = OPS_CEIL_KM) {
    const z = Math.min(ceilKm, Math.max(floorKm, altKm));
    return Math.log(z / floorKm) / Math.log(ceilKm / floorKm);
}

// ── Picking and the expanded shell (PURE; the layer and the globe mirror these) ─

/**
 * A ray's closest approach to the planet centre: `b` (scene units, 1 = the
 * surface) and the range `tc` along the ray to that point. The origin is
 * the camera. A ray pointing away from the planet has tc ≤ 0.
 */
export function rayClosestApproach(origin, dir) {
    const [ox, oy, oz] = origin;
    let [dx, dy, dz] = dir;
    const L = Math.hypot(dx, dy, dz) || 1;
    dx /= L; dy /= L; dz /= L;
    const tc = -(ox * dx + oy * dy + oz * dz);
    const oo = ox * ox + oy * oy + oz * oz;
    const b = Math.sqrt(Math.max(0, oo - tc * tc));
    return { b, tc, dist: Math.sqrt(oo) };
}

/**
 * Which band a ray picks. EDGES first — a ring is the thing a cursor aims
 * at — within `tolR` of an edge's shell radius (a pixel tolerance converted
 * by the caller: pixAng × tc × px), only for edges the camera is outside
 * (a ring exists only when dist > its radius); then the band whose wash the
 * ray falls in (lo ≤ b < hi). Rays that hit the planet (b < 1) pick nothing
 * — the disc is the globe's own click target.
 * @returns {{ band, index, part:'edge'|'fill', edgeKm?:number }|null}
 */
export function pickOpsBand({ b, dist, tolR = 0 }) {
    if (!Number.isFinite(b) || !Number.isFinite(dist) || b < 1) return null;
    let best = null, bestD = Infinity;
    OPS_BANDS.forEach((band, index) => {
        for (const km of [band.minKm, band.maxKm]) {
            // A shared edge belongs to the band ABOVE it (its lower edge),
            // except the model ceiling, which belongs to the top band.
            if (km === band.maxKm && index !== OPS_BANDS.length - 1) continue;
            const r = 1 + km / R_EARTH_KM;
            if (r >= dist) continue;
            const d = Math.abs(b - r);
            if (d <= tolR && d < bestD) { bestD = d; best = { band, index, part: 'edge', edgeKm: km }; }
        }
    });
    if (best) return best;
    const index = OPS_BANDS.findIndex(band => b >= 1 + band.minKm / R_EARTH_KM && b < 1 + band.maxKm / R_EARTH_KM);
    if (index < 0) return null;
    const band = OPS_BANDS[index];
    if (dist <= 1 + band.maxKm / R_EARTH_KM) return null;     // inside it: no wash to pick
    return { band, index, part: 'fill' };
}

/**
 * Path length of a ray with closest approach `b` through the spherical
 * shell lo ≤ r ≤ hi, on the camera's side of the planet — i.e. what a
 * translucent layer of the atmosphere would look like from outside:
 * the full chord where the ray clears the planet, the near-side chord only
 * where the ray hits it. Radii in scene units (1 = the surface). The camera
 * is assumed outside hi (the layer skips the pass otherwise).
 */
export function shellChord(b, lo, hi) {
    if (!(hi > lo) || !(b >= 0) || b >= hi) return 0;
    const outer = Math.sqrt(hi * hi - b * b);
    const inner = b < lo ? Math.sqrt(lo * lo - b * b) : 0;
    if (b >= 1) return 2 * (outer - inner);                    // clears the planet
    const ground = Math.sqrt(1 - b * b);                        // the ray ends on the planet
    return outer - Math.max(inner, ground);                     // near side only
}

/** The longest chord through a shell from outside: tangent to its lower edge. */
export function shellChordMax(lo, hi) {
    if (!(hi > lo)) return 0;
    const tangentAt = Math.max(lo, 1);
    return shellChord(tangentAt, lo, hi);
}
