/**
 * earth-surface-light.js — how sunlight reaches EarthView's ground, and the camera
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PURE + THREE-free + DOM-free, so `node tests/earth-surface-light.mjs` can pin
 * the physics without a GL context. The GLSL at the bottom (EARTH_LIGHT_GLSL)
 * is a hand MIRROR of the JS functions above it — every constant is
 * INTERPOLATED from `SURFACE_LIGHT`, never retyped, and the node test checks
 * that. Change a function here and its GLSL twin in the same commit.
 *
 * WHO USES IT
 * ───────────
 * js/earth-skin.js EARTH_FRAG compiles this model only under
 * `#define EARTH_PHYSICAL_LIGHT` (`EARTH_FRAG_PHYSICAL`). earth.html opts in
 * and hands the SAME shader text to the displaced terrain patch, so the two
 * can never shade differently. The six other pages that share EARTH_FRAG
 * (space-weather-globe, upper-atmosphere-globe, ring-current-globe,
 * heliosphere3d, mission-planner-3d, gravity-lab) compile the legacy
 * half-Lambert path byte-for-byte as before — the hero's opt-in rule.
 * `?earthlight=legacy` on earth.html is the A/B and the gate's negative control.
 *
 * WHAT REPLACED WHAT (the 2026-10-30 review of earth.html)
 * ────────────────────────────────────────────────────────
 * The legacy surface was HALF-LAMBERT with a 0.35 ambient floor and a night
 * side drawn as the DAYTIME photograph at ~19 % (0.55 × 0.35): the planet
 * never went dark and had no terminator, only a soft gradient with a painted
 * orange band. City lights, aurora and the space-weather glows were added
 * BEFORE the lighting multiply, so the lamps were dimmed by the darkness they
 * exist to light. The ocean glint was a Blinn lobe (pow 90) with no Fresnel.
 *
 * The model, every term a published one:
 *
 *   • DIRECT SUN — Lambert (N·L on the relief-bumped normal) × the beam's
 *     transmittance along its real slant path: Rayleigh + ozone (Chappuis) +
 *     aerosol optical depth through the Kasten & Young (1989) air mass. It is
 *     WHITE-BALANCED TO THE ZENITH BEAM: Blue Marble is surface reflectance
 *     under a high Sun, so at the sub-solar point the map is reproduced
 *     exactly and only the EXTRA path reddens it — the terminator turns
 *     orange because the blue is scattered out, not because a band is painted
 *     there. Cloud shadow blocks the beam, never the skylight.
 *   • SKYLIGHT — a blue diffuse term that outlives the sunset through civil
 *     twilight (the hero's term, same numbers).
 *   • NIGHT — dark. Starlight + airglow on the ground is NIGHT_FLOOR of the
 *     albedo: continents barely there, as from the ISS on a moonless night.
 *   • CITY LIGHTS — EMITTERS, added after the lighting, on after civil
 *     twilight (Sun −6°) and full by nautical (−12°). NASA's night map is a
 *     moonlit base with the lamps on top; the base never exceeds red code ~13,
 *     so lamps = (R − 16) / 90 — the floor the hero builder MEASURED
 *     (scripts/build-hero-earth-textures.py LIGHTS_FLOOR / LIGHTS_SPAN, the
 *     two copies move together). Sodium-dominated colour.
 *   • OCEAN — Cox & Munk (1954) wave-slope distribution (Beckmann) × Schlick
 *     Fresnel (F0 = 0.02, water) × a Smith-style masking term: the physically
 *     consistent glint, broad from orbit because the sea is rough. The slope
 *     variance comes from the LIVE 10 m wind (σ² = 0.003 + 0.00512·w), so the
 *     glint is a sharp mirror under a calm high and a wide dull patch under a
 *     gale. The same Fresnel reflects the SKY: water brightens toward grazing
 *     view (only the excess over the map's own nadir F0 is added). The
 *     Blue Marble's cartographic bathymetry (mid-ocean ridges no orbit ever
 *     sees) is pulled toward one deep-water colour, the hero's rule.
 *   • AERIAL PERSPECTIVE — the camera looks down through air too: the ground
 *     is attenuated by the view path and single-scattered sunlight is added
 *     (Rayleigh phase + Henyey–Greenstein aerosol), both by the EXCESS over a
 *     vertical column for the same white-balance reason, so the nadir view
 *     is the map and the haze builds toward the limb. The air above a dark
 *     ground stays sunlit until the Earth's shadow rises past it (μ☉ ≈ −0.07,
 *     √(2h/R) for h ≈ 15 km) — that, through a near-horizontal sun path, is
 *     the red twilight band at the terminator.
 *
 * Units: the diffuse term is albedo·E·μ₀ with E normalised to the zenith beam
 * (π × radiance / E₀), so a Lambert surface under an overhead Sun outputs its
 * albedo. Everything here is LINEAR light; the page's ONE output pass tone
 * maps and encodes. Single scattering only, a flat-layer path at the ground
 * point — an approximation, stated, not an identity.
 */

import { MAX_WIND_MS } from './weather-decode.js';

export const SURFACE_LIGHT = Object.freeze({
    // Vertical optical depths, ~680 / 550 / 440 nm.
    tauR:  Object.freeze([0.045, 0.098, 0.235]),   // Rayleigh (the hero's numbers)
    tauO3: Object.freeze([0.019, 0.032, 0.002]),   // ozone, Chappuis band, 300 DU — absorbs, does not scatter
    tauA:  0.10,                                   // aerosol, grey (clean continental)
    gAer:  0.70,                                   // aerosol Henyey–Greenstein asymmetry
    aerPhaseMax: 12.0,                             // cap the forward HG peak (a firefly guard, ~2.6° from the Sun)
    // Skylight irradiance relative to the zenith beam, and when it fades.
    sky:   Object.freeze([0.030, 0.050, 0.100]),   // = hero vec3(0.30, 0.50, 1.00) × 0.10
    skyMu: Object.freeze([-0.16, 0.30]),           // smoothstep on μ☉: lingers through civil twilight
    // Bumped-normal Lambert is gated by the SPHERE's sun cosine so a slope just
    // past the terminator cannot catch a sun that is below its horizon.
    beamGateMu: Object.freeze([-0.015, 0.02]),
    shadowMu:  -0.07,                              // air column above stops being sunlit (Earth's shadow, h ≈ 15 km)
    // Ocean.
    waterF0: 0.02,
    windClampMs: Object.freeze([2.0, 20.0]),       // Cox–Munk fit range; 2 m/s floor is also the no-data value
    deepOcean: Object.freeze([0.011, 0.024, 0.060]),   // the hero's deep-water colour (sRGB ≈ 27, 43, 69)
    // The hero fades the map's cartographic bathymetry by 0.55 at a 190 px
    // disc. EarthView zooms until a seamount is a 50 px blotch, and the map's
    // "deep" water spans (3,5,20)–(9,24,58) while ridges reach (20,36,76) and
    // the Hawaiian seamounts (37,56,95) (sRGB, measured on day-2k) — depth
    // shading no orbit sees. 0.80 keeps a hint of the shelves; the GIBS detail
    // inset (real imagery) replaces the map entirely where it is live.
    seafloorFade: 0.80,
    // Night.
    nightFloor: 0.006,                             // starlight + airglow on the ground, × albedo
    darkMu: Object.freeze([-0.21, -0.10]),         // lamps on after civil twilight (−6°), full by nautical (−12°)
    lamp: Object.freeze([1.0, 0.56, 0.24]),        // sodium-dominated city light (linear)
    lampGain: 0.55,
    lampGamma: 1.25,
    lightsFloorCode: 16,                           // scripts/build-hero-earth-textures.py LIGHTS_FLOOR
    lightsSpanCode: 90,                            // … LIGHTS_SPAN
    cloudShadow: 0.34,                             // beam blocked under the model cloud field (the legacy strength)
});

const S = SURFACE_LIGHT;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const map3 = (f) => [f(0), f(1), f(2)];

/** Kasten & Young (1989) relative air mass; μ clamped at the horizon (≈ 38). */
export function airMass(mu) {
    const m = clamp(mu, 0, 1);
    const z = Math.acos(m) * 180 / Math.PI;
    return 1 / (m + 0.50572 * Math.pow(96.07995 - z, -1.6364));
}

/** Total extinction optical depth per channel (Rayleigh + ozone + aerosol). */
export const tauExt = map3(c => S.tauR[c] + S.tauO3[c] + S.tauA);
/** Scattering optical depth per channel (ozone only absorbs). */
export const tauSca = map3(c => S.tauR[c] + S.tauA);

/** Beam transmittance at cosine μ, relative to the zenith beam (1 at μ = 1). */
export function beamRel(mu) {
    const dm = airMass(mu) - airMass(1);
    return map3(c => Math.exp(-tauExt[c] * dm));
}

/** Skylight irradiance (relative to the zenith beam) at sun cosine μ☉. */
export function skyIrradiance(muS) {
    const k = smoothstep(S.skyMu[0], S.skyMu[1], muS);
    return map3(c => S.sky[c] * k);
}

/** Schlick Fresnel for water. */
export function fresnel(cosT) {
    return S.waterF0 + (1 - S.waterF0) * Math.pow(1 - clamp(cosT, 0, 1), 5);
}

/** Cox & Munk (1954) isotropic slope variance at 10 m wind speed w (m/s). */
export function coxMunkVariance(windMs) {
    const w = clamp(Number.isFinite(windMs) ? windMs : 0, S.windClampMs[0], S.windClampMs[1]);
    return 0.003 + 0.00512 * w;
}

/**
 * Sun glint in the diffuse term's units (π·f_spec·μ₀), before the beam's
 * transmittance: Beckmann/Cox–Munk D × Schlick F × Smith-style G. The hero's
 * expression with σ² from the wind.
 */
export function glint({ NdH, NdV, NdL, VdH, s2 }) {
    const nh = Math.max(NdH, 1e-3), nv = Math.max(NdV, 1e-3), nl = Math.max(NdL, 0), vh = Math.max(VdH, 1e-3);
    const c2 = nh * nh;
    const D = Math.exp(-(1 - c2) / (c2 * s2)) / (Math.PI * s2 * c2 * c2);
    const F = fresnel(vh);
    const G = Math.min(1, 2 * nh * Math.min(nv, nl) / vh);
    return D * F * G / (4 * nv * Math.max(nl, 1e-3)) * nl * Math.PI;
}

/**
 * Single-scattered sunlight along the camera's EXCESS slant path (the
 * vertical column is already in the map). cosScatter = dot(−L, V): +1 looking
 * toward the Sun (forward scatter), −1 with the Sun behind the camera.
 */
export function pathRadiance({ muS, muV, cosScatter }) {
    const dm = Math.max(airMass(muV) - airMass(1), 0);
    const pR = 0.75 * (1 + cosScatter * cosScatter);
    const g = S.gAer;
    const pA = Math.min((1 - g * g) / Math.pow(1 + g * g - 2 * g * cosScatter, 1.5), S.aerPhaseMax);
    const sunHalf = beamRel(muS).map(Math.sqrt);              // ≈ the layer's mid-height
    const lit = smoothstep(S.shadowMu, 0.02, muS);
    return map3(c => {
        const phase = (S.tauR[c] * pR + S.tauA * pA) / tauSca[c];
        return (1 - Math.exp(-tauExt[c] * dm)) * (tauSca[c] / tauExt[c]) * phase * 0.25 * sunHalf[c] * lit;
    });
}

/** sRGB encode of a linear value (to recover the night map's byte code). */
export function srgbEncode(x) {
    const v = Math.max(x, 0);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Lamp fraction from the night map's (hardware-decoded, linear) red channel. */
export function cityLights(nightRedLinear) {
    const code = srgbEncode(nightRedLinear) * 255;
    return clamp((code - S.lightsFloorCode) / S.lightsSpanCode, 0, 1);
}

/** 1 where the ground is dark enough for the lamps (after civil twilight). */
export function darkness(muS) {
    return 1 - smoothstep(S.darkMu[0], S.darkMu[1], muS);
}

/**
 * The whole surface pixel, linear, before the page's emitters and overlays.
 * Inputs mirror what the fragment shader has in hand.
 *   albedo      linear rgb (map after the seafloor fade + detail inset)
 *   water       0‥1 ocean mask
 *   mu0         N·L on the BUMPED normal
 *   muS, muV    sun / view cosines on the SPHERE normal
 *   cosScatter  dot(−L, V)
 *   NdH, VdH    half-vector cosines on the sphere normal (water is flat)
 *   windMs      10 m wind speed
 *   nightRed    linear red of the night map
 *   cloudShade  0‥1 cloud shadow over the beam
 *   cityOn      0 / 1 (the Lights layer)
 */
export function shadeSurface(p) {
    const {
        albedo, water = 0, mu0, muS, muV, cosScatter = -1, NdH = 1, VdH = 1,
        windMs = 0, nightRed = 0, cloudShade = 0, cityOn = 1,
    } = p;
    const gate = smoothstep(S.beamGateMu[0], S.beamGateMu[1], muS);
    const beam = beamRel(muS);
    const block = 1 - S.cloudShadow * cloudShade;
    const direct = Math.max(mu0, 0) * gate * block;
    const sky = skyIrradiance(muS);
    const gl = glint({ NdH, NdV: muV, NdL: Math.max(muS, 0), VdH, s2: coxMunkVariance(windMs) }) * water * block;
    const seaSky = water * (fresnel(muV) - S.waterF0);
    const view = beamRel(muV);
    const path = pathRadiance({ muS, muV, cosScatter });
    const dark = darkness(muS);
    const lamps = Math.pow(cityLights(nightRed), S.lampGamma) * S.lampGain * dark * cityOn;
    const rgb = map3(c => {
        const ground = albedo[c] * (beam[c] * direct + sky[c]) + beam[c] * gl + seaSky * sky[c];
        const emit = S.lamp[c] * lamps + albedo[c] * S.nightFloor * dark;
        return (ground + emit) * view[c] + path[c];
    });
    return { rgb, path, view, dark };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GLSL MIRROR — prepended inside EARTH_FRAG under EARTH_PHYSICAL_LIGHT.
//  Names are el* / EL_* so nothing collides with the geo / inset helpers.
//  NO BACKTICKS in here: one inside a template literal ends it (the orrery scar).
// ═══════════════════════════════════════════════════════════════════════════
const f = (x) => Number(x).toFixed(6);
const v3 = (a) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

export const EARTH_LIGHT_GLSL = /* glsl */`
const vec3  EL_TAU_R    = ${v3(S.tauR)};
const vec3  EL_TAU_O3   = ${v3(S.tauO3)};
const float EL_TAU_A    = ${f(S.tauA)};
const float EL_G_AER    = ${f(S.gAer)};
const float EL_AER_PMAX = ${f(S.aerPhaseMax)};
const vec3  EL_SKY      = ${v3(S.sky)};
const vec2  EL_SKY_MU   = vec2(${f(S.skyMu[0])}, ${f(S.skyMu[1])});
const vec2  EL_GATE_MU  = vec2(${f(S.beamGateMu[0])}, ${f(S.beamGateMu[1])});
const float EL_SHADOW_MU = ${f(S.shadowMu)};
const float EL_F0       = ${f(S.waterF0)};
const vec2  EL_WIND_CLAMP = vec2(${f(S.windClampMs[0])}, ${f(S.windClampMs[1])});
const float EL_MAX_WIND = ${f(MAX_WIND_MS)};
const vec3  EL_DEEP_OCEAN = ${v3(S.deepOcean)};
const float EL_SEAFLOOR_FADE = ${f(S.seafloorFade)};
const float EL_NIGHT_FLOOR = ${f(S.nightFloor)};
const vec2  EL_DARK_MU  = vec2(${f(S.darkMu[0])}, ${f(S.darkMu[1])});
const vec3  EL_LAMP     = ${v3(S.lamp)};
const float EL_LAMP_GAIN  = ${f(S.lampGain)};
const float EL_LAMP_GAMMA = ${f(S.lampGamma)};
const float EL_LIGHTS_FLOOR = ${f(S.lightsFloorCode)};
const float EL_LIGHTS_SPAN  = ${f(S.lightsSpanCode)};
const float EL_CLOUD_SHADOW = ${f(S.cloudShadow)};
const float EL_PI = 3.14159265358979;

vec3 elTauExt() { return EL_TAU_R + EL_TAU_O3 + vec3(EL_TAU_A); }
vec3 elTauSca() { return EL_TAU_R + vec3(EL_TAU_A); }

float elAirMass(float mu) {
    float m = clamp(mu, 0.0, 1.0);
    float z = acos(m) * 57.29577951308232;
    return 1.0 / (m + 0.50572 * pow(96.07995 - z, -1.6364));
}

vec3 elBeamRel(float mu) {
    return exp(-elTauExt() * (elAirMass(mu) - elAirMass(1.0)));
}

vec3 elSkyIrradiance(float muS) {
    return EL_SKY * smoothstep(EL_SKY_MU.x, EL_SKY_MU.y, muS);
}

float elFresnel(float c) {
    return EL_F0 + (1.0 - EL_F0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}

float elCoxMunkVariance(float windMs) {
    return 0.003 + 0.00512 * clamp(windMs, EL_WIND_CLAMP.x, EL_WIND_CLAMP.y);
}

float elGlint(float NdH, float NdV, float NdL, float VdH, float s2) {
    float nh = max(NdH, 1e-3);
    float nv = max(NdV, 1e-3);
    float nl = max(NdL, 0.0);
    float vh = max(VdH, 1e-3);
    float c2 = nh * nh;
    float D  = exp(-(1.0 - c2) / (c2 * s2)) / (EL_PI * s2 * c2 * c2);
    float F  = elFresnel(vh);
    float G  = min(1.0, 2.0 * nh * min(nv, nl) / vh);
    return D * F * G / (4.0 * nv * max(nl, 1e-3)) * nl * EL_PI;
}

vec3 elPathRadiance(float muS, float muV, float cosScatter) {
    float dm = max(elAirMass(muV) - elAirMass(1.0), 0.0);
    float pR = 0.75 * (1.0 + cosScatter * cosScatter);
    float g  = EL_G_AER;
    float pA = min((1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosScatter, 1.5), EL_AER_PMAX);
    vec3  sunHalf = sqrt(elBeamRel(muS));
    float lit = smoothstep(EL_SHADOW_MU, 0.02, muS);
    vec3  tE = elTauExt();
    vec3  tS = elTauSca();
    vec3  phase = (EL_TAU_R * pR + vec3(EL_TAU_A * pA)) / tS;
    return (1.0 - exp(-tE * dm)) * (tS / tE) * phase * 0.25 * sunHalf * lit;
}

float elSrgbEncode(float x) {
    float v = max(x, 0.0);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

float elCityLights(float nightRedLinear) {
    float code = elSrgbEncode(nightRedLinear) * 255.0;
    return clamp((code - EL_LIGHTS_FLOOR) / EL_LIGHTS_SPAN, 0.0, 1.0);
}

float elDarkness(float muS) {
    return 1.0 - smoothstep(EL_DARK_MU.x, EL_DARK_MU.y, muS);
}
`;
