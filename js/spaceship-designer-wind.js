/**
 * spaceship-designer-wind.js — PURE winds aloft + turbulence for the Space Ship
 * Designer's ascent. No DOM; node-tested by tests/spaceship-designer.mjs.
 *
 * WHAT A LAUNCH VEHICLE FEARS FROM THE WIND IS NOT DRAG, IT IS BENDING. A long,
 * thin, fuelled stack is a beam; air arriving at an angle of attack α puts a
 * side load on its nose that grows with q·α (dynamic pressure × angle). Every
 * real vehicle has a q·α limit, and upper-level winds — not rain, not cloud —
 * are the commonest weather scrub. So this module produces the AIR the ascent
 * flies through, and the integrator (spaceship-designer-ascent.js) turns it
 * into α and q·α:
 *
 *   mean wind   a representative profile per world (`WIND_PROFILES`): a
 *               surface wind plus a Gaussian jet at the altitude where that
 *               world's real one sits (Earth's subtropical jet ~11 km; Mars's
 *               winter westerlies ~40 km; Venus's and Titan's superrotation).
 *               REPRESENTATIVE, not a forecast — the page says so.
 *   gusts       a deterministic, seeded sum of sinusoids in ALTITUDE (the
 *               vehicle climbs through a frozen field; Taylor's hypothesis),
 *               scales 80 m – 3 km, rms set by `gust_ms` + a share of the local
 *               mean wind (turbulence lives where the shear is).
 *   steering    real vehicles WIND-BIAS: they fly zero-α into the MEASURED wind
 *               (balloon soundings hours before launch). What they cannot fly
 *               out is what changes faster than the control loop — shear and
 *               gusts. `steeringLag` is that loop: a first-order filter with
 *               τ = STEERING_TAU_S on the wind the vehicle steers into; the α
 *               that remains is between the real air and the filtered one.
 *
 * The 2D integrator flies due east, so a wind splits into an ALONG-track
 * component (enters the air-relative speed: q, drag, and the in-plane α the
 * gravity turn steers out) and a CROSS-track one (out of plane: q, and a yaw
 * angle the vehicle flies to keep α ≈ 0 — paid for as a cosine thrust loss,
 * the "steering" line). Cross-range drift is not modelled (2D) and is
 * disclosed.
 */

/** Steering-loop time constant (s): how fast the attitude follows the wind. */
export const STEERING_TAU_S = 2.5;

/**
 * Representative bending-load limit, kPa·deg. ~3000 psf·deg (143.6 kPa·deg) is
 * the figure quoted for 3–5 m class launchers (Atlas/Delta/Shuttle-era
 * load-relief designs). One number for every stack — disclosed.
 */
export const QALPHA_LIMIT_KPA_DEG = 143.6;

/**
 * Mean-wind profiles (m/s; km). jet: Gaussian peak at `jetAlt_km`, 1-σ width
 * `jetWidth_km`. `gust_ms`: rms turbulence floor inside `weatherTop_km`.
 */
export const WIND_PROFILES = {
    earth: { surface_ms: 6,  jet_ms: 40,  jetAlt_km: 11,  jetWidth_km: 4,  aloft_ms: 8,  gust_ms: 2.0, weatherTop_km: 20,
             note: 'subtropical jet stream near the tropopause' },
    mars:  { surface_ms: 5,  jet_ms: 35,  jetAlt_km: 40,  jetWidth_km: 14, aloft_ms: 10, gust_ms: 1.5, weatherTop_km: 50,
             note: 'mid-latitude westerlies of the winter hemisphere' },
    venus: { surface_ms: 1,  jet_ms: 100, jetAlt_km: 65,  jetWidth_km: 12, aloft_ms: 20, gust_ms: 1.0, weatherTop_km: 70,
             note: 'the cloud-deck superrotation' },
    titan: { surface_ms: 0.5, jet_ms: 100, jetAlt_km: 150, jetWidth_km: 50, aloft_ms: 5, gust_ms: 0.3, weatherTop_km: 200,
             note: 'stratospheric superrotation' },
};

/**
 * Wind settings the designer offers. `scale` multiplies the profile (and the
 * gusts); `toward_deg` is where the wind blows TO, measured from the flight
 * track (0 = pure tailwind, 90 = from the left, 180 = headwind).
 */
export const WIND_SETTINGS = {
    calm:      { id: 'calm',      name: 'Calm',                 scale: 0,   toward_deg: 0 },
    typical:   { id: 'typical',   name: 'Typical',              scale: 1,   toward_deg: 45 },
    strong:    { id: 'strong',    name: 'Strong jet',           scale: 1.8, toward_deg: 45 },
    crosswind: { id: 'crosswind', name: 'Strong crosswind jet', scale: 1.8, toward_deg: 90 },
    headwind:  { id: 'headwind',  name: 'Strong headwind jet',  scale: 1.8, toward_deg: 180 },
};
export const DEFAULT_WIND = 'typical';

/** Mean wind speed (m/s) at altitude h (m) on `bodyId`, before the setting's scale. */
export function meanWindSpeed(bodyId, h_m) {
    const p = WIND_PROFILES[bodyId];
    if (!p) return 0;
    const h = Math.max(0, h_m) / 1000;
    const jet = p.jet_ms * Math.exp(-0.5 * ((h - p.jetAlt_km) / p.jetWidth_km) ** 2);
    // Surface wind fades through the boundary layer (~1 km); the aloft floor
    // rises in above the jet so the profile does not drop to zero there.
    const surf = p.surface_ms * Math.exp(-h / 1.0);
    const aloft = p.aloft_ms * smooth01((h - p.jetAlt_km) / (2 * p.jetWidth_km));
    return jet + surf + aloft;
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Stable seed from a string (FNV-1a). */
export function seedFrom(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}

/**
 * A frozen turbulence field: N modes per component with a −5/3-ish amplitude
 * spectrum (Kolmogorov: energy ∝ k^−5/3 ⇒ amplitude ∝ k^−5/6), normalised so
 * the rms of the sum is 1. Evaluate with `gustAt`.
 */
export function makeGustField(seed, n = 14) {
    const rnd = prng(seed);
    const mk = () => {
        const modes = [];
        let sumA2 = 0;
        for (let i = 0; i < n; i++) {
            const lambda = 80 * Math.pow(3000 / 80, i / (n - 1));    // m
            const k = (2 * Math.PI) / lambda;
            const amp = Math.pow(lambda / 3000, 5 / 6);
            modes.push({ k, amp, phase: rnd() * 2 * Math.PI });
            sumA2 += amp * amp / 2;
        }
        const norm = 1 / Math.sqrt(sumA2);
        for (const m of modes) m.amp *= norm;
        return modes;
    };
    return { along: mk(), cross: mk() };
}

function evalModes(modes, h) {
    let s = 0;
    for (const m of modes) s += m.amp * Math.sin(m.k * h + m.phase);
    return s;
}

/**
 * The air at altitude h (m): { along, cross } in m/s (along = tailwind
 * positive), the mean part and the gust part separately.
 */
export function windAt({ bodyId, setting, field }, h_m) {
    const p = WIND_PROFILES[bodyId];
    const s = WIND_SETTINGS[setting] || WIND_SETTINGS[DEFAULT_WIND];
    if (!p || !(s.scale > 0)) return { along: 0, cross: 0, meanAlong: 0, meanCross: 0, gustAlong: 0, gustCross: 0, speed: 0, gustRms: 0 };
    const w = meanWindSpeed(bodyId, h_m) * s.scale;
    const ang = (s.toward_deg * Math.PI) / 180;
    const meanAlong = w * Math.cos(ang), meanCross = w * Math.sin(ang);
    // Turbulence: a floor inside the weather layer plus a share of the local
    // mean wind (shear-generated); it fades out above the weather top.
    const inside = 1 - smooth01((h_m / 1000 - p.weatherTop_km) / (0.3 * p.weatherTop_km));
    const gustRms = s.scale * (p.gust_ms + 0.12 * meanWindSpeed(bodyId, h_m)) * inside;
    const gustAlong = field ? gustRms * evalModes(field.along, h_m) : 0;
    const gustCross = field ? gustRms * evalModes(field.cross, h_m) : 0;
    return { along: meanAlong + gustAlong, cross: meanCross + gustCross,
             meanAlong, meanCross, gustAlong, gustCross, speed: w, gustRms };
}

/**
 * The control loop: a first-order follower of the wind the vehicle steers
 * into. `step(w, dt)` returns the filtered {along, cross}.
 */
export function steeringLag(tau = STEERING_TAU_S) {
    let a = null, c = null;
    return {
        step(w, dt) {
            if (a === null) { a = w.along; c = w.cross; }        // start trimmed into the launch wind
            const k = 1 - Math.exp(-dt / tau);
            a += (w.along - a) * k; c += (w.cross - c) * k;
            return { along: a, cross: c };
        },
    };
}

function smooth01(x) {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
}
