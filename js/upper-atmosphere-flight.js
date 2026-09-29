/**
 * upper-atmosphere-flight.js — flight dynamics through the LIVE atmosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel. No THREE, no DOM, no fetch, no ambient time — every input is
 * an argument. Node-tested by `tests/upper-atmosphere-flight.mjs`; run it
 * after ANY edit here.
 *
 * WHAT IT ANSWERS
 * ───────────────
 * "Where does THIS body go, through THIS atmosphere, and what does it feel
 * on the way?" — for a satellite, a re-entering capsule, a suborbital hop
 * or a hypersonic glide. The page already had two half-answers: SGP4 (the
 * catalogue's mean-element truth, which carries no local atmosphere) and a
 * circular-orbit RK4 in Rust (one ρ(h) profile, no geometry). Neither can
 * show a spacecraft decaying faster on the day side than the night side,
 * which is the whole reason the volumetric render draws a diurnal bulge.
 *
 * THE EQUATION OF MOTION
 * ──────────────────────
 *     r̈ = −μ r/|r|³ + a_J2(r) − ½ ρ(r, t) |v_rel| v_rel · BC + a_lift
 *
 *   • point-mass gravity + the J2 oblateness term (WGS-84 constants). J2 is
 *     what precesses the node and the perigee — the visible difference
 *     between a real 24-hour ground track and a fixed ellipse.
 *   • drag against a CO-ROTATING atmosphere: v_rel = v − ω⊕ × r. Air at the
 *     equator moves at 0.46 km/s, so a prograde LEO body sees ~6 % less
 *     relative wind than still air (~12 % less drag) and ~22 % less drag
 *     than the same body flying retrograde (gated). Not a detail — it is
 *     why launch sites face east.
 *   • ρ comes from a caller-supplied SAMPLER (`createDensitySampler`): the
 *     engine's own model evaluated at the LOCAL T∞ of the column kernel —
 *     diurnal bulge + auroral inflation — at the instant of each sample,
 *     so the bulge moves under the orbit as the flight advances.
 *   • an optional unbanked lift term, L/D × |a_drag| normal to v_rel in the
 *     vertical plane, so a lifting capsule or a glider can be flown. No
 *     bank angle, no trim schedule; the page says so wherever L/D ≠ 0.
 *
 * Integration is classical RK4 with an altitude-scheduled step
 * (`stepSecondsFor`): 8 s at orbital altitude is ~700 steps per LEO orbit,
 * where a fourth-order method conserves energy to ~1e-9 per orbit (gated).
 * The step tightens to 0.25 s below 110 km, where the scale height is 7 km
 * and a re-entry decelerates at several g.
 *
 * THE ONE-MODEL RULE, AGAIN
 * ─────────────────────────
 * There is exactly one density model on this page (`upper-atmosphere-
 * engine.js`) and one T∞ field (`upper-atmosphere-column.js`). The sampler
 * here builds an (altitude × T∞) table of log₁₀ρ FROM the engine and reads
 * it bilinearly — ~1 µs against ~14 µs for the direct call, which is the
 * difference between a 24-hour flight integrating in a tenth of a second
 * and in seconds. It is gated to reproduce `densityFieldAt` within 3 %
 * across the band. If you find yourself writing an exponential in here,
 * stop.
 *
 * FRAMES — READ BEFORE TOUCHING A SIGN
 * ────────────────────────────────────
 * Physics runs in ECI (astronomical: +Z = north pole, +X = equinox; TEME
 * from SGP4 is treated as ECI, the same approximation the catalogue
 * tracker makes). The scene is EARTH-FIXED in the site's canonical frame
 * (`latLonToScene`: +X Greenwich, +Y north, −Z 90°E). `eciToScene` here
 * is exactly js/geo/coords.js `eciToEcef` — rotate by the Greenwich
 * sidereal angle, then swap axes — kept three-free so it can be gated in
 * node. The sidereal angle is `sun-altitude.js`'s `greenwichSiderealDeg`,
 * the ONE sidereal clock this page keeps.
 *
 * WHAT IS MODEL AND WHAT IS NOT
 * ─────────────────────────────
 *   • gravity, J2, co-rotation    published constants, no fit
 *   • ρ                            the page's Jacchia-class surrogate — the
 *                                  same claim the rest of the page makes,
 *                                  no stronger
 *   • the 80 km floor              the ENGINE's floor. A flight that reaches
 *                                  it is reported as 'floor' and stopped —
 *                                  never continued into an atmosphere the
 *                                  page does not model
 *   • heating                      Sutton–Graves stagnation-point convective
 *                                  heating for a 1 m nose radius, W/cm². A
 *                                  PROXY for the ordering of "how hot", not
 *                                  a thermal-protection calculation
 *   • g-load                       |a_drag + a_lift| / g₀ — the load a
 *                                  free-falling body actually feels; gravity
 *                                  is not a load
 */

import { density, exosphereTempK } from './upper-atmosphere-engine.js';
import {
    exosphereTempField, localSolarTime,
    MODEL_FLOOR_KM, MODEL_CEIL_KM, R_EARTH_KM,
} from './upper-atmosphere-column.js';
import { subSolarPoint, greenwichSiderealDeg } from './sun-altitude.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// ── Constants ────────────────────────────────────────────────────────────
export const MU_KM3_S2       = 398600.4418;     // WGS-84 GM, km³/s²
export const J2              = 1.08262668e-3;   // WGS-84 second zonal harmonic
export const R_EQ_KM         = 6378.137;        // J2 reference radius (equatorial)
export const OMEGA_EARTH     = 7.2921159e-5;    // rad/s, sidereal rotation
export const G0              = 9.80665;         // m/s²
export const SUTTON_GRAVES_K = 1.7415e-4;       // W·m⁻²·(m/s)⁻³·(kg/m³)^-½·m^½
export const NOSE_RADIUS_M   = 1.0;             // the heating proxy's reference body
export { R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM };

// ─────────────────────────────────────────────────────────────────────────
// 1. FRAMES
// ─────────────────────────────────────────────────────────────────────────

/** Greenwich sidereal angle (rad) at a Unix instant. */
export function gmstRad(unixMs) {
    return greenwichSiderealDeg(unixMs) * DEG;
}

/**
 * ECI (astronomical, Z-up) → scene (Earth-fixed, Y-up, canonical frame).
 * Identical to js/geo/coords.js `eciToEcef`: rotate by −gmst about Z,
 * then (x, y, z)_ecef → (x, z, −y)_scene.
 */
export function eciToScene(r, gmst, out = [0, 0, 0]) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    const xe =  c * r[0] + s * r[1];
    const ye = -s * r[0] + c * r[1];
    out[0] = xe; out[1] = r[2]; out[2] = -ye;
    return out;
}

/** Inverse of `eciToScene`. */
export function sceneToEci(p, gmst, out = [0, 0, 0]) {
    const xe = p[0], ye = -p[2], ze = p[1];
    const c = Math.cos(gmst), s = Math.sin(gmst);
    out[0] = c * xe - s * ye;
    out[1] = s * xe + c * ye;
    out[2] = ze;
    return out;
}

/** ECI position → geographic (spherical Earth, the page's 6371 km datum). */
export function eciToGeo(r, gmst) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    const xe =  c * r[0] + s * r[1];
    const ye = -s * r[0] + c * r[1];
    const ze = r[2];
    const rad = Math.hypot(xe, ye, ze) || 1e-9;
    return {
        latDeg: Math.asin(Math.max(-1, Math.min(1, ze / rad))) / DEG,
        lonDeg: Math.atan2(ye, xe) / DEG,
        altKm:  rad - R_EARTH_KM,
        radiusKm: rad,
    };
}

/** Geographic → ECI position (km). */
export function geoToEci({ latDeg, lonDeg, altKm = 0 }, gmst, out = [0, 0, 0]) {
    const phi = latDeg * DEG, lam = lonDeg * DEG;
    const rad = R_EARTH_KM + altKm;
    const cp = Math.cos(phi);
    const xe = rad * cp * Math.cos(lam);
    const ye = rad * cp * Math.sin(lam);
    const ze = rad * Math.sin(phi);
    const c = Math.cos(gmst), s = Math.sin(gmst);
    out[0] = c * xe - s * ye;
    out[1] = s * xe + c * ye;
    out[2] = ze;
    return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. FORCES
// ─────────────────────────────────────────────────────────────────────────

/** Gravitational acceleration (km/s²) at ECI position r: point mass + J2. */
export function gravityAccel(r, out = [0, 0, 0], j2 = true) {
    const x = r[0], y = r[1], z = r[2];
    const r2 = x * x + y * y + z * z;
    const rad = Math.sqrt(r2);
    const r3 = r2 * rad;
    const k = -MU_KM3_S2 / r3;
    out[0] = k * x; out[1] = k * y; out[2] = k * z;
    if (j2) {
        const zr2 = (z * z) / r2;
        const f = 1.5 * J2 * MU_KM3_S2 * R_EQ_KM * R_EQ_KM / (r2 * r3);
        out[0] += f * x * (5 * zr2 - 1);
        out[1] += f * y * (5 * zr2 - 1);
        out[2] += f * z * (5 * zr2 - 3);
    }
    return out;
}

/**
 * Specific mechanical energy (km²/s²), including the J2 potential so that
 * it is a conserved quantity of `gravityAccel` — the conservation gate in
 * the test depends on the two being the same field.
 */
export function specificEnergy(r, v, j2 = true) {
    const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    const rad = Math.sqrt(r2);
    let e = 0.5 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) - MU_KM3_S2 / rad;
    if (j2) {
        const z2 = r[2] * r[2];
        e += 0.5 * MU_KM3_S2 * J2 * R_EQ_KM * R_EQ_KM
           * (3 * z2 / (r2 * r2 * rad) - 1 / (r2 * rad));
    }
    return e;
}

/** Specific angular momentum r × v (km²/s). */
export function angularMomentum(r, v, out = [0, 0, 0]) {
    out[0] = r[1] * v[2] - r[2] * v[1];
    out[1] = r[2] * v[0] - r[0] * v[2];
    out[2] = r[0] * v[1] - r[1] * v[0];
    return out;
}

/** Velocity of the co-rotating atmosphere at r: ω⊕ × r (km/s). */
export function atmosphereVelocity(r, out = [0, 0, 0]) {
    out[0] = -OMEGA_EARTH * r[1];
    out[1] =  OMEGA_EARTH * r[0];
    out[2] =  0;
    return out;
}

/**
 * Drag acceleration (km/s²) from a mass density (kg/m³), the AIR-relative
 * velocity (km/s) and a ballistic coefficient CdA/m (m²/kg). Writes the
 * vector into `out` and returns its magnitude.
 *
 *   ½ ρ (v·1000)² BC  [m/s²]   →   500 ρ v² BC  [km/s²]
 */
export function dragAccel(rho, vRel, bcM2PerKg, out = [0, 0, 0]) {
    const vm = Math.hypot(vRel[0], vRel[1], vRel[2]);
    const a = 500 * rho * vm * vm * bcM2PerKg;
    if (vm < 1e-12 || a === 0) { out[0] = out[1] = out[2] = 0; return 0; }
    const k = -a / vm;
    out[0] = k * vRel[0]; out[1] = k * vRel[1]; out[2] = k * vRel[2];
    return a;
}

/** Circular orbital speed (km/s) at an altitude above the 6371 km datum. */
export function circularSpeedKms(altKm) {
    return Math.sqrt(MU_KM3_S2 / (R_EARTH_KM + altKm));
}

/**
 * Launch azimuth (° from north, clockwise) that produces inclination `i`
 * from latitude φ: sin β = cos i / cos φ. Returns null when |cos i| >
 * |cos φ| (that inclination cannot be reached from that latitude without a
 * plane change). Retrograde inclinations come back as 180°–360° headings.
 */
export function headingForInclination(incDeg, latDeg) {
    const s = Math.cos(incDeg * DEG) / Math.cos(latDeg * DEG);
    if (!Number.isFinite(s) || Math.abs(s) > 1) return null;
    const beta = Math.asin(s) / DEG;
    return ((beta % 360) + 360) % 360;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. THE DENSITY SAMPLER — the engine's field, read fast
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a bilinear (altitude × T∞) log₁₀ρ table from the engine for one
 * (F10.7, Ap) state and return a sampler that evaluates the column
 * kernel's LOCAL T∞ at (lat, lon, instant) and reads ρ from the table.
 *
 * Outside the modelled band: below the 80 km floor the floor value is
 * returned (the flight terminates there anyway); above the 2000 km ceiling
 * ρ is ZERO and `aboveModel` is set — the engine is not validated up there
 * and drag at 2000 km is already ~1e-9 m/s².
 *
 * The sub-solar point is cached for `sunCacheS` seconds of sim time: it
 * moves 15°/h, so a 60 s cache is a 0.25° error in local time.
 */
export function createDensitySampler({
    f107Sfu = 150, ap = 15,
    altStepKm = 5, tinfBins = 25, tinfMin = 400, tinfMax = 3000,
    sunCacheS = 60,
} = {}) {
    const altBins = Math.floor((MODEL_CEIL_KM - MODEL_FLOOR_KM) / altStepKm) + 1;
    const table = new Float32Array(altBins * tinfBins);
    const tinfStep = (tinfMax - tinfMin) / (tinfBins - 1);
    for (let j = 0; j < tinfBins; j++) {
        const Tinf = tinfMin + j * tinfStep;
        for (let i = 0; i < altBins; i++) {
            const altKm = Math.min(MODEL_CEIL_KM, MODEL_FLOOR_KM + i * altStepKm);
            const rho = density({ altitudeKm: altKm, f107Sfu, ap, TinfK: Tinf }).rho;
            table[j * altBins + i] = Math.log10(Math.max(rho, 1e-30));
        }
    }
    const TinfGlobal = exosphereTempK(f107Sfu, ap);

    let sunCache = { ms: NaN, lat: 0, lon: 0 };
    const sunAt = (ms) => {
        if (!(Math.abs(ms - sunCache.ms) < sunCacheS * 1000)) {
            const s = subSolarPoint(new Date(ms));
            sunCache = { ms, lat: s.lat, lon: s.lon };
        }
        return sunCache;
    };

    const lookup = (altKm, Tinf) => {
        if (altKm > MODEL_CEIL_KM) return 0;
        const a = (Math.max(altKm, MODEL_FLOOR_KM) - MODEL_FLOOR_KM) / altStepKm;
        const i0 = Math.min(Math.floor(a), altBins - 2);
        const fa = Math.min(1, a - i0);
        const t = Math.max(0, Math.min(tinfBins - 1, (Tinf - tinfMin) / tinfStep));
        const j0 = Math.min(Math.floor(t), tinfBins - 2);
        const ft = t - j0;
        const r00 = table[j0 * altBins + i0],       r01 = table[j0 * altBins + i0 + 1];
        const r10 = table[(j0 + 1) * altBins + i0], r11 = table[(j0 + 1) * altBins + i0 + 1];
        const l = (r00 * (1 - fa) + r01 * fa) * (1 - ft) + (r10 * (1 - fa) + r11 * fa) * ft;
        return Math.pow(10, l);
    };

    function fieldAt(altKm, latDeg, lonDeg, unixMs) {
        const sun = sunAt(unixMs);
        const lstHr = localSolarTime(lonDeg, sun.lon);
        const f = exosphereTempField({
            latDeg, lonDeg, localSolarTimeHr: lstHr, sunDeclDeg: sun.lat, f107Sfu, ap,
        });
        const rho = lookup(altKm, f.Tinf);
        const rhoGlobal = lookup(altKm, f.TinfGlobal);
        return {
            rho, rhoGlobal,
            rhoRatio: rhoGlobal > 0 ? rho / rhoGlobal : 1,
            Tinf: f.Tinf, TinfGlobal: f.TinfGlobal,
            lstHr, sunDeclDeg: sun.lat, subSolarLonDeg: sun.lon,
            aboveModel: altKm > MODEL_CEIL_KM,
        };
    }
    function rhoAt(altKm, latDeg, lonDeg, unixMs) {
        if (altKm > MODEL_CEIL_KM) return 0;
        const sun = sunAt(unixMs);
        const f = exosphereTempField({
            latDeg, lonDeg,
            localSolarTimeHr: localSolarTime(lonDeg, sun.lon),
            sunDeclDeg: sun.lat, f107Sfu, ap,
        });
        return lookup(altKm, f.Tinf);
    }
    return {
        rhoAt, fieldAt, lookup, sunAt,
        meta: { f107Sfu, ap, altBins, tinfBins, altStepKm, tinfMin, tinfMax, TinfGlobal },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. THE FLIGHT — RK4 through the field, sampled as it goes
// ─────────────────────────────────────────────────────────────────────────

/** Sample record layout. Positions/velocities are ECI km, km/s. */
export const COL = Object.freeze({
    T: 0,                        // s since launch
    RX: 1, RY: 2, RZ: 3,         // ECI position, km
    VX: 4, VY: 5, VZ: 6,         // ECI velocity, km/s
    ALT: 7,                      // km above the 6371 km datum
    SPEED: 8,                    // |v| inertial, km/s
    VREL: 9,                     // |v − ω×r| air-relative, km/s
    RHO: 10,                     // kg/m³ (local field)
    Q: 11,                       // ½ρv_rel², Pa
    ADRAG: 12,                   // m/s²
    AGRAV: 13,                   // m/s²
    ALIFT: 14,                   // m/s²
    ENERGY: 15,                  // specific mechanical energy, km²/s²
    HMAG: 16,                    // |r × v|, km²/s
    HEAT: 17,                    // Sutton–Graves proxy, W/cm² (1 m nose)
    GLOAD: 18,                   // |a_drag + a_lift| / g₀
    DEDT: 19,                    // dε/dt from drag+lift, W/kg (negative = losing)
    DADT: 20,                    // da/dt, km/day (bound orbits; NaN otherwise)
    LAT: 21, LON: 22,            // geographic, °
    LST: 23,                     // local solar time, h (NaN without a sampler)
});
export const STRIDE = 24;

/** Integration step (s) by altitude — see the module header. */
export function stepSecondsFor(altKm) {
    if (altKm > 600) return 10;
    if (altKm > 300) return 8;
    if (altKm > 150) return 3;
    if (altKm > 110) return 1;
    return 0.25;
}
/** Sample cadence (s) by altitude — dense where things happen fast. */
export function sampleIntervalFor(altKm) {
    if (altKm > 300) return 12;
    if (altKm > 150) return 5;
    return 1;
}

export const STATUS = Object.freeze({
    RUNNING:   'running',
    FLOOR:     'floor',        // reached the 80 km model floor
    ESCAPE:    'escape',       // positive energy, beyond the model ceiling
    HORIZON:   'horizon',      // integrated the requested duration
    CAP:       'sample-cap',   // ran out of sample storage
});

export function describeStatus(status) {
    switch (status) {
        case STATUS.FLOOR:   return 'reached the 80 km model floor — the page does not model the air below it';
        case STATUS.ESCAPE:  return 'unbound — positive energy beyond the model ceiling';
        case STATUS.HORIZON: return 'integrated to the horizon';
        case STATUS.CAP:     return 'stopped at the sample cap';
        default:             return 'integrating';
    }
}

export class Flight {
    /**
     * @param {object} o
     * @param {number[]} o.r0            ECI position at launch, km
     * @param {number[]} o.v0            ECI velocity at launch, km/s
     * @param {number}   o.t0Ms          launch instant, Unix ms (sets the sidereal angle
     *                                   and the sub-solar point the field is read at)
     * @param {number}   [o.bcM2PerKg]   CdA/m
     * @param {number}   [o.liftToDrag]  unbanked L/D (0 = ballistic)
     * @param {object}   [o.sampler]     from createDensitySampler (or null = vacuum)
     * @param {Function} [o.rhoAt]       custom (altKm, latDeg, lonDeg, unixMs) → kg/m³
     * @param {boolean}  [o.j2]
     * @param {boolean}  [o.corotate]    drag against the rotating air (true) or still air
     * @param {number}   [o.floorKm]
     * @param {number}   [o.horizonS]
     * @param {number}   [o.maxSamples]
     */
    constructor({
        r0, v0, t0Ms,
        bcM2PerKg = 0.02, liftToDrag = 0,
        sampler = null, rhoAt = null,
        j2 = true, corotate = true,
        floorKm = MODEL_FLOOR_KM, horizonS = 86400, maxSamples = 80000,
        name = 'probe', meta = {},
    }) {
        if (!r0 || !v0 || r0.length < 3 || v0.length < 3) throw new Error('Flight: r0 and v0 are required');
        if (!Number.isFinite(t0Ms)) throw new Error('Flight: t0Ms is required');
        this.name = name;
        this.meta = { ...meta };
        this.t0Ms = t0Ms;
        this.bc = bcM2PerKg;
        this.liftToDrag = liftToDrag;
        this.sampler = sampler;
        this.rhoAt = rhoAt || (sampler ? sampler.rhoAt : () => 0);
        this.j2 = j2;
        this.corotate = corotate;
        this.floorKm = floorKm;
        this.horizonS = horizonS;
        this.maxSamples = maxSamples;
        this.gmst0 = gmstRad(t0Ms);

        this.status = STATUS.RUNNING;
        this.n = 0;
        this.steps = 0;
        this.data = new Float64Array(2048 * STRIDE);
        this.tS = 0;
        this.r = [r0[0], r0[1], r0[2]];
        this.v = [v0[0], v0[1], v0[2]];
        this._lastSampleT = -Infinity;
        this._prevR = [0, 0, 0]; this._prevV = [0, 0, 0];
        // scratch
        this._aux = { rho: 0, aGrav: 0, aDrag: 0, aLift: 0, vRel: 0, lat: 0, lon: 0,
                      drag: [0, 0, 0], lift: [0, 0, 0] };
        this._k1 = [0, 0, 0]; this._k2 = [0, 0, 0]; this._k3 = [0, 0, 0]; this._k4 = [0, 0, 0];
        this._rt = [0, 0, 0]; this._vt = [0, 0, 0];
        this._g = [0, 0, 0]; this._va = [0, 0, 0]; this._vr = [0, 0, 0];
        this._v2 = [0, 0, 0]; this._v3 = [0, 0, 0]; this._v4 = [0, 0, 0];
        this._record(0, this.r, this.v);
    }

    get done() { return this.status !== STATUS.RUNNING; }
    get tEndS() { return this.n ? this.data[(this.n - 1) * STRIDE + COL.T] : 0; }

    /** Acceleration (km/s²) at (t, r, v); fills `aux` with the pieces when asked. */
    _accel(tS, r, v, out, aux = null) {
        const g = gravityAccel(r, this._g, this.j2);
        out[0] = g[0]; out[1] = g[1]; out[2] = g[2];

        const gmst = this.gmst0 + OMEGA_EARTH * tS;
        const geo = eciToGeo(r, gmst);
        const rho = geo.altKm > MODEL_CEIL_KM ? 0
            : this.rhoAt(Math.max(geo.altKm, MODEL_FLOOR_KM), geo.latDeg, geo.lonDeg,
                         this.t0Ms + tS * 1000);

        // Air-relative velocity.
        const vr = this._vr;
        if (this.corotate) {
            const va = atmosphereVelocity(r, this._va);
            vr[0] = v[0] - va[0]; vr[1] = v[1] - va[1]; vr[2] = v[2] - va[2];
        } else {
            vr[0] = v[0]; vr[1] = v[1]; vr[2] = v[2];
        }
        const drag = aux ? aux.drag : this._k4;   // _k4 is free during an accel call
        const aDrag = dragAccel(rho, vr, this.bc, drag);
        out[0] += drag[0]; out[1] += drag[1]; out[2] += drag[2];

        // Unbanked lift: L/D × |drag| along the component of local up normal
        // to the relative wind.
        let aLift = 0;
        if (this.liftToDrag > 0 && aDrag > 0) {
            const rad = Math.hypot(r[0], r[1], r[2]);
            const vm = Math.hypot(vr[0], vr[1], vr[2]);
            const ux = r[0] / rad, uy = r[1] / rad, uz = r[2] / rad;
            const wx = vr[0] / vm, wy = vr[1] / vm, wz = vr[2] / vm;
            const d = ux * wx + uy * wy + uz * wz;
            let lx = ux - d * wx, ly = uy - d * wy, lz = uz - d * wz;
            const ll = Math.hypot(lx, ly, lz);
            if (ll > 1e-6) {
                aLift = this.liftToDrag * aDrag;
                lx *= aLift / ll; ly *= aLift / ll; lz *= aLift / ll;
                out[0] += lx; out[1] += ly; out[2] += lz;
                if (aux) { aux.lift[0] = lx; aux.lift[1] = ly; aux.lift[2] = lz; }
            } else if (aux) { aux.lift[0] = aux.lift[1] = aux.lift[2] = 0; }
        } else if (aux) { aux.lift[0] = aux.lift[1] = aux.lift[2] = 0; }

        if (aux) {
            aux.rho = rho;
            aux.aGrav = Math.hypot(g[0], g[1], g[2]);
            aux.aDrag = aDrag;
            aux.aLift = aLift;
            aux.vRel = Math.hypot(vr[0], vr[1], vr[2]);
            aux.lat = geo.latDeg; aux.lon = geo.lonDeg; aux.alt = geo.altKm;
        }
        return out;
    }

    _record(tS, r, v) {
        if (this.n >= this.maxSamples) { this.status = STATUS.CAP; return; }
        if ((this.n + 1) * STRIDE > this.data.length) {
            const bigger = new Float64Array(this.data.length * 2);
            bigger.set(this.data);
            this.data = bigger;
        }
        const aux = this._aux;
        this._accel(tS, r, v, this._k1, aux);
        const o = this.n * STRIDE;
        const d = this.data;
        const speed = Math.hypot(v[0], v[1], v[2]);
        const vRelM = aux.vRel * 1000;
        const q = 0.5 * aux.rho * vRelM * vRelM;
        const energy = specificEnergy(r, v, this.j2);
        const h = angularMomentum(r, v, this._k2);
        const hMag = Math.hypot(h[0], h[1], h[2]);
        // Power of the non-conservative forces per unit mass: (a_drag + a_lift)·v.
        const dEdtKm = (aux.drag[0] + aux.lift[0]) * v[0]
                     + (aux.drag[1] + aux.lift[1]) * v[1]
                     + (aux.drag[2] + aux.lift[2]) * v[2];      // km²/s³
        const rad = Math.hypot(r[0], r[1], r[2]);
        const invA = 2 / rad - speed * speed / MU_KM3_S2;
        const a = invA > 1e-12 ? 1 / invA : NaN;
        const dadt = Number.isFinite(a) ? (2 * a * a / MU_KM3_S2) * dEdtKm * 86400 : NaN;
        const heat = SUTTON_GRAVES_K * Math.sqrt(aux.rho / NOSE_RADIUS_M) * vRelM ** 3 / 1e4;
        let lst = NaN;
        if (this.sampler) {
            const sun = this.sampler.sunAt(this.t0Ms + tS * 1000);
            lst = localSolarTime(aux.lon, sun.lon);
        }
        d[o + COL.T] = tS;
        d[o + COL.RX] = r[0]; d[o + COL.RY] = r[1]; d[o + COL.RZ] = r[2];
        d[o + COL.VX] = v[0]; d[o + COL.VY] = v[1]; d[o + COL.VZ] = v[2];
        d[o + COL.ALT] = aux.alt;
        d[o + COL.SPEED] = speed;
        d[o + COL.VREL] = aux.vRel;
        d[o + COL.RHO] = aux.rho;
        d[o + COL.Q] = q;
        d[o + COL.ADRAG] = aux.aDrag * 1000;
        d[o + COL.AGRAV] = aux.aGrav * 1000;
        d[o + COL.ALIFT] = aux.aLift * 1000;
        d[o + COL.ENERGY] = energy;
        d[o + COL.HMAG] = hMag;
        d[o + COL.HEAT] = heat;
        d[o + COL.GLOAD] = Math.hypot(aux.aDrag, aux.aLift) * 1000 / G0;
        d[o + COL.DEDT] = dEdtKm * 1e6;
        d[o + COL.DADT] = dadt;
        d[o + COL.LAT] = aux.lat; d[o + COL.LON] = aux.lon;
        d[o + COL.LST] = lst;
        this.n++;
        this._lastSampleT = tS;
    }

    /** One RK4 step of `dt` seconds. */
    _rk4(dt) {
        const r = this.r, v = this.v, t = this.tS;
        const k1 = this._accel(t, r, v, this._k1);
        const rt = this._rt, vt = this._vt;
        const v2 = this._v2, v3 = this._v3, v4 = this._v4;
        const h2 = dt / 2;
        for (let i = 0; i < 3; i++) { v2[i] = v[i] + h2 * k1[i]; rt[i] = r[i] + h2 * v[i]; }
        const k2 = this._accel(t + h2, rt, v2, this._k2);
        for (let i = 0; i < 3; i++) { v3[i] = v[i] + h2 * k2[i]; rt[i] = r[i] + h2 * v2[i]; }
        const k3 = this._accel(t + h2, rt, v3, this._k3);
        for (let i = 0; i < 3; i++) { v4[i] = v[i] + dt * k3[i]; rt[i] = r[i] + dt * v3[i]; }
        const k4 = this._accel(t + dt, rt, v4, [0, 0, 0]);
        for (let i = 0; i < 3; i++) {
            this._prevR[i] = r[i]; this._prevV[i] = v[i];
            r[i] += (dt / 6) * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]);
            v[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        }
        this.tS = t + dt;
        this.steps++;
    }

    /**
     * Advance the integration. Stops at the first of: `maxSteps` taken,
     * sim time `untilS` reached, `budgetMs` of wall time spent, or the
     * flight terminating. Returns the number of steps taken.
     */
    step({ maxSteps = 4000, untilS = Infinity, budgetMs = Infinity } = {}) {
        if (this.done) return 0;
        const clock = Number.isFinite(budgetMs) && globalThis.performance?.now
            ? () => globalThis.performance.now() : null;
        const start = clock ? clock() : 0;
        let taken = 0;
        while (!this.done && taken < maxSteps && this.tS < untilS) {
            if (clock && taken % 64 === 63 && clock() - start > budgetMs) break;
            const alt = Math.hypot(this.r[0], this.r[1], this.r[2]) - R_EARTH_KM;
            let dt = stepSecondsFor(alt);
            const remaining = this.horizonS - this.tS;
            if (remaining <= 0) { this.status = STATUS.HORIZON; break; }
            if (dt > remaining) dt = remaining;
            this._rk4(dt);
            taken++;

            const rad = Math.hypot(this.r[0], this.r[1], this.r[2]);
            const altNow = rad - R_EARTH_KM;
            if (altNow <= this.floorKm) {
                // Land the last sample exactly on the floor (linear in t
                // between the two bracketing states) so the endpoint is a
                // clean number rather than 'somewhere below 80 km'.
                const altPrev = Math.hypot(this._prevR[0], this._prevR[1], this._prevR[2]) - R_EARTH_KM;
                const f = altPrev > altNow ? Math.max(0, Math.min(1, (altPrev - this.floorKm) / (altPrev - altNow))) : 1;
                for (let i = 0; i < 3; i++) {
                    this.r[i] = this._prevR[i] + f * (this.r[i] - this._prevR[i]);
                    this.v[i] = this._prevV[i] + f * (this.v[i] - this._prevV[i]);
                }
                this.tS = this.tS - dt + f * dt;
                this._record(this.tS, this.r, this.v);
                this.status = STATUS.FLOOR;
                break;
            }
            const e = specificEnergy(this.r, this.v, this.j2);
            if (e > 0 && altNow > 2 * MODEL_CEIL_KM) {
                this._record(this.tS, this.r, this.v);
                this.status = STATUS.ESCAPE;
                break;
            }
            if (this.tS - this._lastSampleT >= sampleIntervalFor(altNow) - 1e-9
                || this.tS >= this.horizonS) {
                this._record(this.tS, this.r, this.v);
                if (this.status === STATUS.CAP) break;
            }
            if (this.tS >= this.horizonS) { this.status = STATUS.HORIZON; break; }
        }
        return taken;
    }

    /** Integrate everything (tests, offline use). */
    run() { while (!this.done) this.step({ maxSteps: 1e9 }); return this; }

    /** Index of the last sample at or before `tS` (−1 if before launch). */
    indexAt(tS) {
        const d = this.data, n = this.n;
        if (n === 0 || tS < d[COL.T]) return -1;
        let lo = 0, hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (d[mid * STRIDE + COL.T] <= tS) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    /** Row `i` as a plain object (allocates; for readouts, not hot loops). */
    row(i) {
        if (i < 0 || i >= this.n) return null;
        const o = i * STRIDE, d = this.data, out = {};
        for (const k in COL) out[k] = d[o + COL[k]];
        return out;
    }

    /**
     * Linear interpolation of every column at `tS`, into `out` (STRIDE
     * long). Returns null before launch or past the last sample.
     */
    sampleAt(tS, out = new Float64Array(STRIDE)) {
        const i = this.indexAt(tS);
        if (i < 0) return null;
        const d = this.data;
        if (i >= this.n - 1) {
            if (tS > d[(this.n - 1) * STRIDE + COL.T] + 1e-9) return null;
            out.set(d.subarray(i * STRIDE, i * STRIDE + STRIDE));
            return out;
        }
        const o0 = i * STRIDE, o1 = o0 + STRIDE;
        const t0 = d[o0 + COL.T], t1 = d[o1 + COL.T];
        const f = t1 > t0 ? (tS - t0) / (t1 - t0) : 0;
        for (let k = 0; k < STRIDE; k++) out[k] = d[o0 + k] + f * (d[o1 + k] - d[o0 + k]);
        // Longitude must not interpolate across the dateline.
        const l0 = d[o0 + COL.LON], l1 = d[o1 + COL.LON];
        if (Math.abs(l1 - l0) > 180) {
            const l1u = l1 + (l1 < l0 ? 360 : -360);
            let l = l0 + f * (l1u - l0);
            if (l > 180) l -= 360; else if (l < -180) l += 360;
            out[COL.LON] = l;
        }
        out[COL.T] = tS;
        return out;
    }

    /** Scene position (R⊕ units, Earth-fixed) of the state at `tS`. */
    sceneAt(tS, out = [0, 0, 0], sample = null) {
        const s = sample || this.sampleAt(tS);
        if (!s) return null;
        const r = [s[COL.RX] / R_EARTH_KM, s[COL.RY] / R_EARTH_KM, s[COL.RZ] / R_EARTH_KM];
        return eciToScene(r, this.gmst0 + OMEGA_EARTH * tS, out);
    }

    /** Scene position of sample row `i`. */
    scenePositionOfRow(i, out = [0, 0, 0]) {
        const o = i * STRIDE, d = this.data;
        const tS = d[o + COL.T];
        const r = [d[o + COL.RX] / R_EARTH_KM, d[o + COL.RY] / R_EARTH_KM, d[o + COL.RZ] / R_EARTH_KM];
        return eciToScene(r, this.gmst0 + OMEGA_EARTH * tS, out);
    }

    /** Scene-frame direction of an ECI vector at sample time `tS`. */
    sceneDirectionAt(vec, tS, out = [0, 0, 0]) {
        return eciToScene(vec, this.gmst0 + OMEGA_EARTH * tS, out);
    }

    /** Extremes and events over what has been integrated so far. */
    summary() {
        const d = this.data, n = this.n;
        const s = {
            status: this.status, statusText: describeStatus(this.status),
            n, steps: this.steps, tEndS: this.tEndS,
            minAltKm: Infinity, maxAltKm: -Infinity,
            maxQPa: 0, maxHeatWcm2: 0, maxG: 0, maxADrag: 0,
            energyStart: n ? d[COL.ENERGY] : NaN,
            energyEnd: n ? d[(n - 1) * STRIDE + COL.ENERGY] : NaN,
            perigeePasses: 0,
            floor: null, elementsStart: null, elementsEnd: null,
            decayPerOrbitKm: null,
        };
        let prevDr = 0, lastPerigeeA = null;
        for (let i = 0; i < n; i++) {
            const o = i * STRIDE;
            const alt = d[o + COL.ALT];
            if (alt < s.minAltKm) s.minAltKm = alt;
            if (alt > s.maxAltKm) s.maxAltKm = alt;
            if (d[o + COL.Q] > s.maxQPa) s.maxQPa = d[o + COL.Q];
            if (d[o + COL.HEAT] > s.maxHeatWcm2) s.maxHeatWcm2 = d[o + COL.HEAT];
            if (d[o + COL.GLOAD] > s.maxG) s.maxG = d[o + COL.GLOAD];
            if (d[o + COL.ADRAG] > s.maxADrag) s.maxADrag = d[o + COL.ADRAG];
            // Perigee pass: radial rate crosses from negative to positive.
            const dr = d[o + COL.RX] * d[o + COL.VX] + d[o + COL.RY] * d[o + COL.VY]
                     + d[o + COL.RZ] * d[o + COL.VZ];
            if (i > 0 && prevDr < 0 && dr >= 0) {
                s.perigeePasses++;
                const el = orbitalElements(
                    [d[o + COL.RX], d[o + COL.RY], d[o + COL.RZ]],
                    [d[o + COL.VX], d[o + COL.VY], d[o + COL.VZ]]);
                if (lastPerigeeA != null && Number.isFinite(el.aKm)) {
                    s.decayPerOrbitKm = el.aKm - lastPerigeeA;
                }
                if (Number.isFinite(el.aKm)) lastPerigeeA = el.aKm;
            }
            prevDr = dr;
        }
        if (n) {
            s.elementsStart = orbitalElements(
                [d[COL.RX], d[COL.RY], d[COL.RZ]], [d[COL.VX], d[COL.VY], d[COL.VZ]]);
            const o = (n - 1) * STRIDE;
            s.elementsEnd = orbitalElements(
                [d[o + COL.RX], d[o + COL.RY], d[o + COL.RZ]],
                [d[o + COL.VX], d[o + COL.VY], d[o + COL.VZ]]);
            if (this.status === STATUS.FLOOR) {
                s.floor = { tS: d[o + COL.T], latDeg: d[o + COL.LAT], lonDeg: d[o + COL.LON],
                            speedKms: d[o + COL.SPEED] };
            }
        }
        s.energyLossKJkg = (s.energyStart - s.energyEnd) * 1e3;
        return s;
    }
}

/** Convenience: build and fully integrate a flight. */
export function integrateFlight(opts) {
    return new Flight(opts).run();
}

// ─────────────────────────────────────────────────────────────────────────
// 5. ORBITAL ELEMENTS from a state vector
// ─────────────────────────────────────────────────────────────────────────

export function orbitalElements(r, v) {
    const rad = Math.hypot(r[0], r[1], r[2]);
    const s2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const invA = 2 / rad - s2 / MU_KM3_S2;
    const aKm = Math.abs(invA) > 1e-14 ? 1 / invA : Infinity;
    const h = angularMomentum(r, v);
    const hMag = Math.hypot(h[0], h[1], h[2]);
    const ev = [
        (v[1] * h[2] - v[2] * h[1]) / MU_KM3_S2 - r[0] / rad,
        (v[2] * h[0] - v[0] * h[2]) / MU_KM3_S2 - r[1] / rad,
        (v[0] * h[1] - v[1] * h[0]) / MU_KM3_S2 - r[2] / rad,
    ];
    const e = Math.hypot(ev[0], ev[1], ev[2]);
    const incRad = hMag > 0 ? Math.acos(Math.max(-1, Math.min(1, h[2] / hMag))) : NaN;
    const nx = -h[1], ny = h[0];
    const nMag = Math.hypot(nx, ny);
    let raan = 0;
    if (nMag > 1e-12) {
        raan = Math.acos(Math.max(-1, Math.min(1, nx / nMag)));
        if (ny < 0) raan = TAU - raan;
    }
    let argp = 0;
    if (nMag > 1e-12 && e > 1e-9) {
        argp = Math.acos(Math.max(-1, Math.min(1, (nx * ev[0] + ny * ev[1]) / (nMag * e))));
        if (ev[2] < 0) argp = TAU - argp;
    }
    let nu = 0;
    if (e > 1e-9) {
        nu = Math.acos(Math.max(-1, Math.min(1, (ev[0] * r[0] + ev[1] * r[1] + ev[2] * r[2]) / (e * rad))));
        if (r[0] * v[0] + r[1] * v[1] + r[2] * v[2] < 0) nu = TAU - nu;
    } else if (nMag > 1e-12) {
        // Circular: measure from the node (argument of latitude).
        nu = Math.acos(Math.max(-1, Math.min(1, (nx * r[0] + ny * r[1]) / (nMag * rad))));
        if (r[2] < 0) nu = TAU - nu;
    }
    const bound = e < 1 && Number.isFinite(aKm) && aKm > 0;
    return {
        aKm, e, incDeg: incRad / DEG, raanDeg: raan / DEG, argpDeg: argp / DEG, nuDeg: nu / DEG,
        perigeeAltKm: Number.isFinite(aKm) ? aKm * (1 - e) - R_EARTH_KM : NaN,
        apogeeAltKm:  bound ? aKm * (1 + e) - R_EARTH_KM : NaN,
        periodMin:    bound ? TAU * Math.sqrt(aKm ** 3 / MU_KM3_S2) / 60 : NaN,
        hMag, energy: 0.5 * s2 - MU_KM3_S2 / rad, bound,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// 6. LAUNCH — a state vector from where you are and how you are moving
// ─────────────────────────────────────────────────────────────────────────

/**
 * ECI state from a geographic launch point and a local velocity.
 *
 * @param {object} o
 * @param {number} o.latDeg, o.lonDeg, o.altKm
 * @param {number} o.speedKms        magnitude of the velocity
 * @param {number} o.fpaDeg          flight-path angle, + above the local horizon
 * @param {number} o.headingDeg      compass heading of the horizontal component
 *                                   (0 = north, 90 = east)
 * @param {number} o.unixMs          launch instant (sets the sidereal angle)
 * @param {boolean} [o.groundRelative=false]
 *        true  → speed is relative to the rotating ground (an aircraft's or
 *                a rocket's airspeed); ω⊕ × r is added to make it inertial
 *        false → speed is inertial (what an orbit is quoted in)
 * @returns {{ r:number[], v:number[], gmst:number, vGroundKms:number, vInertialKms:number }}
 */
export function launchState({
    latDeg, lonDeg, altKm, speedKms, fpaDeg = 0, headingDeg = 90,
    unixMs, groundRelative = false,
}) {
    const gmst = gmstRad(unixMs);
    const r = geoToEci({ latDeg, lonDeg, altKm }, gmst);
    const phi = latDeg * DEG, lam = lonDeg * DEG + gmst;   // ECI longitude of the site
    // Local ENU basis in ECI.
    const up    = [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
    const east  = [-Math.sin(lam), Math.cos(lam), 0];
    const north = [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)];
    const fpa = fpaDeg * DEG, hdg = headingDeg * DEG;
    const ch = Math.cos(fpa) * Math.sin(hdg), cn = Math.cos(fpa) * Math.cos(hdg), cu = Math.sin(fpa);
    const v = [0, 0, 0];
    for (let i = 0; i < 3; i++) v[i] = speedKms * (ch * east[i] + cn * north[i] + cu * up[i]);
    const vGround = Math.hypot(v[0], v[1], v[2]);
    if (groundRelative) {
        const va = atmosphereVelocity(r);
        v[0] += va[0]; v[1] += va[1]; v[2] += va[2];
    }
    return { r, v, gmst, vGroundKms: vGround, vInertialKms: Math.hypot(v[0], v[1], v[2]) };
}

// ─────────────────────────────────────────────────────────────────────────
// 7. PRESETS — nine flights that each show one thing
// ─────────────────────────────────────────────────────────────────────────

const KOUROU = { latDeg: 5.2, lonDeg: -52.8 };
export const FLIGHT_PRESETS = Object.freeze([
    {
        id: 'iss', name: 'ISS-class orbit', group: 'orbit',
        blurb: '420 km circular at 51.6° — the page\'s drag testbed. Watch da/dt swing with the diurnal bulge each orbit.',
        launch: { latDeg: 0, lonDeg: -60, altKm: 420, speedKms: circularSpeedKms(420),
                  fpaDeg: 0, headingDeg: headingForInclination(51.6, 0) },
        bcM2PerKg: 0.018, liftToDrag: 0, horizonS: 86400, colorMode: 'altitude',
    },
    {
        id: 'starlink', name: 'Starlink shell', group: 'orbit',
        blurb: '550 km at 53°. Higher, so ~10× less drag than the ISS — read it off q.',
        launch: { latDeg: 0, lonDeg: 20, altKm: 550, speedKms: circularSpeedKms(550),
                  fpaDeg: 0, headingDeg: headingForInclination(53, 0) },
        bcM2PerKg: 0.020, liftToDrag: 0, horizonS: 86400, colorMode: 'q',
    },
    {
        id: 'decay', name: 'Decaying satellite', group: 'orbit',
        blurb: '250 km circular, a tumbling body. Three days of decay through the live storm state.',
        launch: { latDeg: 0, lonDeg: 100, altKm: 250, speedKms: circularSpeedKms(250),
                  fpaDeg: 0, headingDeg: headingForInclination(51.6, 0) },
        bcM2PerKg: 0.030, liftToDrag: 0, horizonS: 3 * 86400, colorMode: 'altitude',
    },
    {
        id: 'sso', name: 'Sun-synchronous polar', group: 'orbit',
        blurb: '800 km at 98°, retrograde: the air-relative speed is HIGHER than the inertial one.',
        launch: { latDeg: 0, lonDeg: -100, altKm: 800, speedKms: circularSpeedKms(800),
                  fpaDeg: 0, headingDeg: headingForInclination(98, 0) },
        bcM2PerKg: 0.012, liftToDrag: 0, horizonS: 86400, colorMode: 'speed',
    },
    {
        id: 'gto', name: 'GTO transfer burn', group: 'transfer',
        blurb: 'Perigee kick to 10.2 km/s from Kourou: apogee at 35 800 km, perigee dipping back through the thermosphere.',
        launch: { ...KOUROU, altKm: 250, speedKms: 10.20, fpaDeg: 0, headingDeg: 90 },
        bcM2PerKg: 0.010, liftToDrag: 0, horizonS: 12 * 3600, colorMode: 'energy',
    },
    {
        id: 'escape', name: 'Escape trajectory', group: 'transfer',
        blurb: '11.0 km/s at 400 km — above escape speed. The energy readout goes positive and stays there.',
        launch: { latDeg: 0, lonDeg: -60, altKm: 400, speedKms: 11.0, fpaDeg: 0, headingDeg: 90 },
        bcM2PerKg: 0.010, liftToDrag: 0, horizonS: 6 * 3600, colorMode: 'energy',
    },
    {
        id: 'hop', name: 'Suborbital hop', group: 'flight',
        blurb: 'A sounding-rocket arc: 3 km/s ground-relative at 35° from White Sands. Apogee near 250 km, back to the floor in minutes.',
        launch: { latDeg: 32.9, lonDeg: -106.4, altKm: 100, speedKms: 3.0, fpaDeg: 35,
                  headingDeg: 90, groundRelative: true },
        bcM2PerKg: 0.005, liftToDrag: 0, horizonS: 3600, colorMode: 'altitude',
    },
    {
        id: 'capsule', name: 'Capsule re-entry', group: 'flight',
        blurb: 'Entry interface: 7.8 km/s at −1.6° over the Pacific, L/D 0.3. Heating and g-load peak as the air thickens.',
        launch: { latDeg: 25, lonDeg: -140, altKm: 120, speedKms: 7.8, fpaDeg: -1.6, headingDeg: 70 },
        bcM2PerKg: 0.0035, liftToDrag: 0.3, horizonS: 3600, colorMode: 'heating',
    },
    {
        id: 'glider', name: 'Hypersonic skip entry', group: 'flight',
        blurb: '7.6 km/s at 100 km, −0.4°, L/D 2 — a lifting entry. Above 80 km the air is thin enough that lift buys seconds, not minutes; the page models no bank and no control.',
        launch: { latDeg: 35, lonDeg: 100, altKm: 100, speedKms: 7.6, fpaDeg: -0.4, headingDeg: 90 },
        bcM2PerKg: 0.006, liftToDrag: 2.0, horizonS: 2 * 3600, colorMode: 'gload',
    },
]);

export function presetById(id) {
    return FLIGHT_PRESETS.find(p => p.id === id) || null;
}

/**
 * Epoch of a TLE (Unix ms) from line 1, columns 19–32: two-digit year
 * (57–99 → 1900s, else 2000s) and fractional day-of-year. Pure, so the
 * page can ask SGP4 for a state "tsince" minutes from it without the
 * catalogue tracker.
 */
export function tleEpochMs(line1) {
    if (typeof line1 !== 'string' || line1.length < 32) return NaN;
    const yy = parseInt(line1.slice(18, 20), 10);
    const doy = parseFloat(line1.slice(20, 32));
    if (!Number.isFinite(yy) || !Number.isFinite(doy)) return NaN;
    const year = yy >= 57 ? 1900 + yy : 2000 + yy;
    return Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
}

/** Build the Flight options for a preset at a launch instant. */
export function flightOptionsFromPreset(preset, unixMs, extra = {}) {
    const ls = launchState({ ...preset.launch, unixMs });
    return {
        r0: ls.r, v0: ls.v, t0Ms: unixMs,
        bcM2PerKg: preset.bcM2PerKg, liftToDrag: preset.liftToDrag,
        horizonS: preset.horizonS, name: preset.name,
        meta: { presetId: preset.id, launch: { ...preset.launch }, colorMode: preset.colorMode },
        ...extra,
    };
}
