/**
 * moon-craters.js — the lunar impact record as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch. Gated by tests/moon-craters.mjs. The
 * surface shader (js/moon-skin.js) draws craters from THESE numbers: the
 * crater density per size band comes from the chronology, the bowl shape
 * from Pike's morphometry, and the shadow inside each bowl from the same
 * closed form this file derives and tests — the GLSL below is generated
 * from the kernel's own constants so the two cannot drift.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * The page's base map resolves nothing below ~7 km/px, so every crater
 * smaller than ~20 km on screen was shader noise. This replaces that noise
 * with a STATISTICAL crater population — not a catalogue: a given 2-km
 * crater drawn at a given spot does not exist at that spot on the real
 * Moon (the named ones are the landmark layer's job), but how MANY there
 * are per km² at each size, how deep they are, and how their floors fall
 * into shadow as the Sun drops are all taken from the literature:
 *
 *   • Size–frequency: the Neukum production function (Neukum, Ivanov &
 *     Hartmann 2001, Space Sci. Rev. 96:55 — the 11th-order polynomial in
 *     log D, valid 0.01–300 km) scaled by the lunar chronology function
 *     N(1 km) = 5.44·10⁻¹⁴ (e^{6.93 T} − 1) + 8.38·10⁻⁴ T, T in Ga.
 *   • Saturation: ancient terrain cannot hold the production function's
 *     small-crater count — new impacts erase old ones. The density is
 *     capped at Hartmann's (1984) empirical saturation level, the
 *     commonly quoted N_sat(≥D) = 0.079 D^{−1.83} km⁻² — the highlands sit
 *     ON that line for D below a few km, which is what "saturated" means.
 *   • Terrain age: maria ~3.3 Ga (basalts span ~1.2–4.0 Ga, Hiesinger et al.
 *     2011), highlands ~4.3 Ga. The shader picks between them by the base
 *     map's albedo, because that IS how the maria are told from the
 *     highlands at this resolution.
 *   • Morphometry: Pike (1977) fresh simple craters, depth d = 0.196 D^1.01
 *     and rim height 0.036 D^1.014 for D < 15 km; the complex-crater branch
 *     d = 1.044 D^0.301 above. Degradation shallows the bowl (a disclosed
 *     schematic factor; the fresh end is the measured one).
 *   • Shadow: for a paraboloid bowl of depth/diameter ratio ρ and a Sun at
 *     elevation e, the shadow cast by the up-Sun rim covers a fraction
 *     f = max(0, 1 − tan e / 4ρ) of the floor's diameter — derived in
 *     shadowChordFraction's comment and checked against a brute-force
 *     ray test. A fresh bowl (ρ = 0.2) is shadow-free above e = 38.7°;
 *     at the terminator every floor is black. This is the single most
 *     recognisable thing about lunar craters and it is geometry, not art.
 */

// ── Chronology ───────────────────────────────────────────────────────────────
/** Neukum production function coefficients (NIH 2001, Table 2, lunar). log₁₀ N(≥D) = Σ aᵢ (log₁₀ D)ⁱ, N per km² at 1 Ga. */
export const NPF_COEFFICIENTS = Object.freeze([
    -3.0876, -3.557528, 0.781027, 1.021521, -0.156012, -0.444058,
    0.019977, 0.086850, -0.005874, -0.006809, 8.25e-4, 5.54e-5,
]);
export const NPF_VALID_KM = Object.freeze([0.01, 300]);
export const MARE_AGE_GA = 3.3;
export const HIGHLAND_AGE_GA = 4.3;
/** Hartmann (1984) empirical saturation: N_sat(≥D) = SAT_COEFF · D^SAT_EXP per km². */
export const SATURATION_COEFF = 0.079;
export const SATURATION_EXPONENT = -1.83;

/** Cumulative crater density N(≥D) per km² at the 1 Ga reference (production function alone). */
export function neukumProductionPerKm2(dKm) {
    const D = Math.min(Math.max(dKm, NPF_VALID_KM[0]), NPF_VALID_KM[1]);
    const x = Math.log10(D);
    let logN = 0, p = 1;
    for (let i = 0; i < NPF_COEFFICIENTS.length; i++) { logN += NPF_COEFFICIENTS[i] * p; p *= x; }
    return Math.pow(10, logN);
}

/** Lunar chronology function: N(≥1 km) per km² for a surface of age T (Ga). */
export function chronologyN1(ageGa) {
    const T = Math.max(0, ageGa);
    return 5.44e-14 * (Math.exp(6.93 * T) - 1) + 8.38e-4 * T;
}

/** Empirical saturation density N(≥D) per km². */
export function saturationPerKm2(dKm) {
    return SATURATION_COEFF * Math.pow(dKm, SATURATION_EXPONENT);
}

/**
 * Cumulative crater density N(≥D) per km² on terrain of age T (Ga):
 * production function × chronology, capped at saturation. `saturated`
 * says whether the cap bit — i.e. whether this size on this terrain is in
 * equilibrium rather than still counting.
 */
export function craterDensityPerKm2(dKm, ageGa) {
    const production = neukumProductionPerKm2(dKm) * chronologyN1(ageGa) / chronologyN1(1);
    const sat = saturationPerKm2(dKm);
    return { density: Math.min(production, sat), production, saturation: sat, saturated: production >= sat };
}

// ── Morphometry (Pike 1977) ──────────────────────────────────────────────────
export const SIMPLE_COMPLEX_TRANSITION_KM = 15;
/** Fresh-crater depth (km) for diameter D (km). */
export function freshDepthKm(dKm) {
    return dKm < SIMPLE_COMPLEX_TRANSITION_KM
        ? 0.196 * Math.pow(dKm, 1.010)
        : 1.044 * Math.pow(dKm, 0.301);
}
/** Fresh-crater rim height above the surroundings (km), simple branch. */
export function freshRimHeightKm(dKm) { return 0.036 * Math.pow(dKm, 1.014); }
/** Depth/diameter ratio for a crater of diameter D at freshness f ∈ [0,1] (1 = pristine). */
export const DEGRADED_DEPTH_FLOOR = 0.15;       // a fully degraded bowl keeps 15 % of its fresh depth — schematic, disclosed
export function depthOverDiameter(dKm, freshness = 1) {
    const f = Math.min(1, Math.max(0, freshness));
    return (freshDepthKm(dKm) / dKm) * (DEGRADED_DEPTH_FLOOR + (1 - DEGRADED_DEPTH_FLOOR) * f);
}

// ── Shadow geometry ──────────────────────────────────────────────────────────
/**
 * Fraction of a paraboloid bowl's diameter (along the Sun's azimuth) in the
 * shadow of its up-Sun rim, for depth/diameter ρ and Sun elevation e.
 *
 * Normalised to D = 1: floor z(x) = ρ(4x² − 1) for x ∈ [−½, ½] (z = 0 at the
 * rim, −ρ at the centre); the shadow plane through the up-Sun rim is
 * z_s(x) = −(x + ½) tan e. Shadow where z < z_s: 4ρx² + x·tan e + (tan e/2 − ρ) < 0.
 * Discriminant tan²e − 8ρ tan e + 16ρ² = (tan e − 4ρ)², so the far root is
 * x_s = ½ − tan e/(4ρ) when tan e < 4ρ (else the plane only grazes the rim)
 * and the shadowed chord fraction is x_s + ½ = 1 − tan e/(4ρ). The 4ρ is the
 * paraboloid's wall slope at the rim: no shadow once the Sun clears it.
 */
export function shadowChordFraction(depthOverDiam, sunElevDeg) {
    if (sunElevDeg <= 0) return 1;
    const t = Math.tan(sunElevDeg * Math.PI / 180);
    return Math.max(0, 1 - t / (4 * depthOverDiam));
}
/** Sun elevation (deg) above which a bowl of depth/diameter ρ has no floor shadow. */
export function shadowFreeElevationDeg(depthOverDiam) {
    return Math.atan(4 * depthOverDiam) * 180 / Math.PI;
}
/**
 * Brute-force reference for the test: is the floor point at normalised
 * position x shadowed by the up-Sun rim? (height compared to the plane)
 */
export function floorPointShadowed(depthOverDiam, sunElevDeg, x) {
    const z = depthOverDiam * (4 * x * x - 1);
    const zs = -(x + 0.5) * Math.tan(sunElevDeg * Math.PI / 180);
    return z < zs;
}

// ── The shader's lattice bands ───────────────────────────────────────────────
// One crater candidate per cell of a 3-D lattice of spacing `cellKm`
// intersecting the surface shell; its radius is drawn from [rMin, rMax]·cell,
// so a band covers diameters [2 rMin, 2 rMax]·cell. The OCCUPANCY (chance a
// cell holds a crater) is what the chronology says that band's count per
// cell is — clamped at one candidate per cell, which is why the bands are
// narrow: a lattice cannot hold more craters than it has cells, and the
// test reports where the clamp bites.
export const BAND_RADIUS_FRACTION = Object.freeze([0.08, 0.28]);
export const CRATER_BANDS = Object.freeze([
    Object.freeze({ cellKm: 24, viewFadeKm: [900, 1800], seed: 17.0 }),   // D ≈ 3.8–13 km
    Object.freeze({ cellKm: 6, viewFadeKm: [220, 480], seed: 29.0 }),     // D ≈ 1–3.4 km
    Object.freeze({ cellKm: 1.5, viewFadeKm: [55, 130], seed: 47.0 }),    // D ≈ 240–840 m
    Object.freeze({ cellKm: 0.4, viewFadeKm: [12, 30], seed: 61.0 }),     // D ≈ 64–224 m (short final only)
]);

/** Diameter range (km) a band draws. */
export function bandDiameterRangeKm(band) {
    return [2 * BAND_RADIUS_FRACTION[0] * band.cellKm, 2 * BAND_RADIUS_FRACTION[1] * band.cellKm];
}

/** Expected craters per lattice cell in a band on terrain of age T, and the clamped occupancy. */
export function bandOccupancy(band, ageGa) {
    const [dMin, dMax] = bandDiameterRangeKm(band);
    const perKm2 = craterDensityPerKm2(dMin, ageGa).density - craterDensityPerKm2(dMax, ageGa).density;
    const expected = perKm2 * band.cellKm * band.cellKm;
    return { expected, occupancy: Math.min(1, Math.max(0, expected)), clamped: expected > 1, dMinKm: dMin, dMaxKm: dMax };
}

/** Occupancies for every band at both reference terrains — the shader uniforms. */
export function craterUniforms() {
    return {
        cellKm: CRATER_BANDS.map(b => b.cellKm),
        occupancyMare: CRATER_BANDS.map(b => bandOccupancy(b, MARE_AGE_GA).occupancy),
        occupancyHighland: CRATER_BANDS.map(b => bandOccupancy(b, HIGHLAND_AGE_GA).occupancy),
        seeds: CRATER_BANDS.map(b => b.seed),
        fadeNear: CRATER_BANDS.map(b => b.viewFadeKm[0]),
        fadeFar: CRATER_BANDS.map(b => b.viewFadeKm[1]),
    };
}

/**
 * Panel readout for a site: terrain class from albedo (the base map's
 * sRGB luminance — maria ≲ 0.3, highlands ≳ 0.45, blended between), model
 * age, N(≥1 km), whether that size is saturated, and the floor-shadow
 * fraction of a fresh 1 km bowl at the given Sun elevation.
 */
export const MARE_ALBEDO_MAX = 0.30;
export const HIGHLAND_ALBEDO_MIN = 0.45;
export function terrainClassFromAlbedo(luminance) {
    const t = (luminance - MARE_ALBEDO_MAX) / (HIGHLAND_ALBEDO_MIN - MARE_ALBEDO_MAX);
    return Math.min(1, Math.max(0, t));    // 0 = mare, 1 = highland
}
export function siteCraterReport({ albedo = null, highlandWeight = null, sunElevDeg = 45 } = {}) {
    const w = highlandWeight ?? (albedo == null ? 1 : terrainClassFromAlbedo(albedo));
    const ageGa = MARE_AGE_GA + (HIGHLAND_AGE_GA - MARE_AGE_GA) * w;
    const n1 = craterDensityPerKm2(1, ageGa);
    const rho = depthOverDiameter(1, 1);
    return {
        highlandWeight: w,
        terrain: w < 0.35 ? 'mare basalt' : w > 0.65 ? 'highland crust' : 'mare / highland margin',
        ageGa,
        n1PerKm2: n1.density,
        saturatedAt1km: n1.saturated,
        freshDepthOverDiameter1km: rho,
        shadowFraction1km: shadowChordFraction(rho, sunElevDeg),
        shadowFreeElevationDeg: shadowFreeElevationDeg(rho),
    };
}

// ── GLSL mirror — generated from the constants above ─────────────────────────
// The shader's bowl + shadow + occupancy must be THIS kernel's; the gate
// checks the interpolated numbers are present in the string. Keep it
// transliterable: typed float declarations, no arrays, no backticks.
const f = (v, n = 4) => Number(v).toFixed(n);
export const CRATER_GLSL = /* glsl */`
// ── moon-craters.js mirror — do not edit numbers here, edit the kernel ──
const float CR_R_MIN = ${f(BAND_RADIUS_FRACTION[0], 3)};
const float CR_R_MAX = ${f(BAND_RADIUS_FRACTION[1], 3)};
const float CR_DEPTH_FLOOR = ${f(DEGRADED_DEPTH_FLOOR, 3)};
// Pike (1977) fresh depth/diameter for the simple branch (D < 15 km): 0.196·D^0.010
float crDepthOverDiameter(float dKm, float fresh) {
    float rho = 0.196 * pow(max(dKm, 0.01), 0.010);
    return rho * (CR_DEPTH_FLOOR + (1.0 - CR_DEPTH_FLOOR) * fresh);
}
float crHash(vec3 p) {
    p = mod(p, 289.0);
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
// One lattice band. P: body-frame point on the reference sphere (km),
// N: surface normal, L: body-frame Sun. Returns (albedo delta, lit multiplier)
// where the lit multiplier folds the bowl's Lambert slope shading and the
// up-Sun rim's cast shadow (shadowChordFraction's plane test, in 3-D).
vec2 crBand(vec3 P, vec3 N, vec3 L, float cellKm, float occ, float seed, float R) {
    vec3 base = floor(P / cellKm);
    float alb = 0.0;
    float lit = 1.0;
    float nl = max(dot(N, L), 0.02);
    vec3 Lt = L - N * dot(N, L);
    float ltLen = max(length(Lt), 1e-4);
    vec3 sunT = Lt / ltLen;
    float tanE = max(dot(N, L), 0.0) / ltLen;
    for (int dx = -1; dx <= 1; dx += 1) {
        for (int dy = -1; dy <= 1; dy += 1) {
            for (int dz = -1; dz <= 1; dz += 1) {
                vec3 cell = base + vec3(float(dx), float(dy), float(dz));
                float h = crHash(cell + seed);
                if (h > occ) continue;
                vec3 c = (cell + 0.5 + 0.8 * (vec3(fract(h * 127.1), fract(h * 311.7), fract(h * 74.7)) - 0.5)) * cellKm;
                float cr = length(c);
                if (abs(cr - R) > 0.5 * cellKm) continue;    // one shell of cells → uniform area density
                vec3 cS = c * (R / cr);
                vec3 off = P - cS;
                float d = length(off);
                float r = cellKm * mix(CR_R_MIN, CR_R_MAX, fract(h * 43.7));
                if (d > r * 1.6) continue;
                float x = d / r;
                float fresh = pow(fract(h * 17.3), 3.0);
                float rho = crDepthOverDiameter(2.0 * r, fresh);
                vec3 rd = off - N * dot(off, N);
                rd = rd / max(length(rd), 1e-5);
                float u = dot(rd, sunT) * x;                 // −1 up-Sun rim … +1 down-Sun rim
                if (x < 1.0) {
                    // Paraboloid wall: slope 4ρx toward the centre
                    float s = 4.0 * rho * x;
                    vec3 n = normalize(N - rd * s);
                    lit *= clamp(max(dot(n, L), 0.0) / nl, 0.0, 2.2);
                    // Cast shadow of the up-Sun rim: height below the plane
                    float zFrag = 2.0 * r * rho * (x * x - 1.0);
                    float zPlane = -(u + 1.0) * r * tanE;
                    if (zFrag < zPlane) lit *= 0.08;
                    alb += 0.06 * fresh;                     // immature regolith is bright
                } else if (x < 1.15) {
                    // Raised rim: inner face lit like the wall top, outer face reversed
                    float s = (x < 1.0) ? 0.0 : -4.0 * rho * (1.15 - x) / 0.15;
                    vec3 n = normalize(N - rd * s);
                    lit *= clamp(max(dot(n, L), 0.0) / nl, 0.0, 2.2);
                    alb += 0.05 * fresh;
                } else {
                    alb += 0.045 * fresh * (1.6 - x) / 0.45;   // ejecta blanket
                }
            }
        }
    }
    return vec2(alb, lit);
}
`;
