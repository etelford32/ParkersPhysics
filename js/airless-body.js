/**
 * airless-body.js — ONE copy of how a sunlit, airless body is shaded
 * ═══════════════════════════════════════════════════════════════════════════
 * The orrery draws three kinds of airless body and they must not disagree
 * about the physics: the far-field NEO impostor (js/neo-layer.js), the NEO
 * rock meshes (js/neo-rocks.js) and every natural satellite on the page
 * (solar-system.html). This module owns the GLSL they all include, so the
 * scattering law, the opposition surge, the display compression and the
 * eclipse test exist ONCE. The pure arithmetic they mirror lives in
 * js/eclipse-geometry.js and js/neo-orbits.js.
 *
 * ── The scattering law is LOMMEL–SEELIGER ─────────────────────────────────
 * Single scattering off a dark particulate regolith: I ∝ μ₀/(μ₀+μ). It is
 * nearly FLAT across the disc where a Lambertian sphere darkens toward the
 * limb, which is why a full Moon reads as a disc and not a ball — the law was
 * derived from lunar photometry, and the Moon is the body it describes best.
 *
 * ── The phase function is NOT applied on top of it ────────────────────────
 * An earlier pass multiplied the BRDF by the IAU H–G function as well. That
 * DOUBLE-COUNTS the phase: H–G is a DISC-INTEGRATED law — it already contains
 * the terminator that the BRDF is busy drawing — so a crescent was dimmed
 * twice and had to be rescued with a clamp past 120°. A resolved body gets its
 * phase behaviour from its own terminator, and the only thing the BRDF misses
 * is the OPPOSITION SURGE, so that is what is applied: Hapke's shadow-hiding
 * term B(α) = 1 + B₀/(1 + tan(α/2)/h), with the Moon-like B₀ = 1, h = 0.07.
 * The full moon really is anomalously bright for exactly this reason.
 * `apparentMagnitudeV` in js/neo-orbits.js keeps H–G, because a magnitude IS
 * a disc-integrated quantity — that is the right home for it.
 *
 * ── Eclipses are evaluated PER FRAGMENT, in real kilometres ───────────────
 * `solarLitAt` mirrors js/eclipse-geometry.js `shadowIllumination` in GLSL, so
 * a body inside a planet's shadow is dimmed by exactly the fraction of the
 * solar disc that planet covers AT THAT POINT ON ITS SURFACE. That is what
 * gives a partially eclipsed Moon the curved bite that proved the Earth round,
 * and it is why the uniforms carry REAL km vectors rather than drawn ones —
 * the body's own radius is real, only its distance from the parent is
 * compressed for the display. Change this function and the kernel together.
 *
 * Far-field impostors do NOT use it: they are two to ten pixels across, a
 * curved shadow edge is invisible on them, and evaluating it for 38 000 points
 * would be paid every frame for nothing. They receive a scalar from the CPU.
 */

import * as THREE from 'three';
import { TONE_DECODE_GLSL } from './tone-decode.js';
import { UMBRAL_TRANSMISSION, UMBRAL_TINT, SUN_RADIUS_KM } from './eclipse-geometry.js';

/**
 * Display normalisation and compression, shared by every airless body so a
 * rock and a moon of the same albedo at the same distance render alike.
 * DISCLOSED: reflected radiance across this scene spans several decades
 * (a 0.04 nucleus at 5 AU to a 1.4 Enceladus at 9.5 AU), and no linear gain
 * shows both ends. Neither constant changes anything RELATIVE.
 */
export const AIRLESS_DISPLAY = Object.freeze({ gain: 6.2, stretch: 0.38 });
/** Hapke shadow-hiding opposition effect, Moon-like. */
export const OPPOSITION = Object.freeze({ B0: 1.0, h: 0.07 });

export const AIRLESS_GLSL = /* glsl */`
    // Hapke's shadow-hiding opposition surge: the sharp brightening in the last
    // few degrees before zero phase, as shadows hide behind the grains casting
    // them. B(0) = 1 + B0; it has decayed to ~1 by 15 degrees.
    float oppositionSurge(float alpha, float B0, float h) {
        float t = tan(clamp(alpha, 0.0, 1.53) * 0.5);
        return 1.0 + B0 / (1.0 + t / max(h, 1e-4));
    }
    // Lommel-Seeliger, normalised to 1 where mu0 == mu (backscatter), so the
    // level is carried by the illumination and not by the law's own scale.
    float lommelSeeliger(float mu0, float mu) {
        return 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + max(mu, 1e-3));
    }
    // The DISCLOSED display compression. Radiance in, screen tone out.
    float airlessTone(float radiance, float gain, float stretch) {
        return pow(clamp(radiance * gain, 0.0, 6.0), stretch);
    }
    // Fraction of disc A hidden behind disc B, centres sep apart — the GLSL
    // mirror of eclipse-geometry.js occultedFraction(). Same four regimes.
    float occultedFraction(float rA, float rB, float sep) {
        if (rA <= 0.0 || rB <= 0.0) return 0.0;
        float d = max(sep, 0.0);
        if (d >= rA + rB) return 0.0;
        if (d <= rB - rA) return 1.0;
        if (d <= rA - rB) return clamp((rB * rB) / (rA * rA), 0.0, 1.0);
        float d2 = d * d, a2 = rA * rA, b2 = rB * rB;
        float lens = a2 * acos(clamp((d2 + a2 - b2) / (2.0 * d * rA), -1.0, 1.0))
                   + b2 * acos(clamp((d2 + b2 - a2) / (2.0 * d * rB), -1.0, 1.0))
                   - 0.5 * sqrt(max(0.0, (-d + rA + rB) * (d + rA - rB) * (d - rA + rB) * (d + rA + rB)));
        return clamp(lens / (3.14159265 * a2), 0.0, 1.0);
    }
    // Fraction of the Sun still visible from a point, given the vectors to the
    // Sun and to the occulting body FROM THAT POINT, in kilometres.
    float solarLitAt(vec3 sunFromPt, vec3 occFromPt, float occRadiusKm, float sunRadiusKm) {
        float dSun = length(sunFromPt), dOcc = length(occFromPt);
        if (dOcc <= 0.0 || dSun <= 0.0 || dOcc >= dSun) return 1.0;
        float sunAng = asin(clamp(sunRadiusKm / dSun, 0.0, 1.0));
        float occAng = (dOcc <= occRadiusKm) ? 1.5707963 : asin(clamp(occRadiusKm / dOcc, 0.0, 1.0));
        float sep = acos(clamp(dot(sunFromPt / dSun, occFromPt / dOcc), -1.0, 1.0));
        return 1.0 - occultedFraction(sunAng, occAng, sep);
    }
`;

const SPHERE_VS = /* glsl */`
    varying vec3 vN;
    varying vec3 vW;
    varying vec3 vLocal;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vLocal = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

/**
 * An airless satellite. Everything about how it looks is a published number:
 * its geometric albedo, the light actually reaching it (1/r² in the units the
 * Sun's output is quoted in), whatever its parent planet is reflecting onto
 * its night side, and whether that parent is standing in the way of the Sun.
 */
const SPHERE_FS = /* glsl */`${TONE_DECODE_GLSL}${AIRLESS_GLSL}
    uniform vec3  u_base;          // surface tint (a display choice; the LEVEL is albedo)
    uniform float u_albedo;        // published geometric albedo
    uniform float u_illum;         // (1 AU / r)² — sunlight reaching this body
    uniform float u_gain;
    uniform float u_stretch;
    uniform float u_B0;
    uniform float u_hOpp;
    uniform float u_shine;         // parent-reflected light, as a fraction of direct
    uniform vec3  u_shineDir;      // unit, toward the parent, SCENE axes
    // Real geometry for the eclipse test, rotated into SCENE axes so it shares
    // a frame with the drawn normals. Kilometres.
    uniform vec3  u_sunFromBodyKm;
    uniform vec3  u_occFromBodyKm;
    uniform float u_occRadiusKm;
    uniform float u_sunRadiusKm;
    uniform float u_bodyRadiusKm;
    uniform float u_umbralT;
    uniform vec3  u_umbralTint;
    uniform float u_texMix;        // 0 = flat tint, 1 = full surface mottling
    varying vec3 vN;
    varying vec3 vW;
    varying vec3 vLocal;

    // Cheap value noise so a 16-segment sphere does not read as a billiard
    // ball. Albedo variation ONLY — it never moves the surface, so it cannot
    // lie about shape, and it is scaled by u_texMix per body.
    float hash13(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0));
        float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
        float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
        float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
        return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    }

    void main() {
        vec3 n = normalize(vN);
        vec3 toSun = normalize(u_sunFromBodyKm);
        vec3 toCam = normalize(cameraPosition - vW);

        // THE ECLIPSE IS EVALUATED AT THIS POINT ON THE SURFACE, not at the
        // body's centre: the offset is the REAL body radius along the drawn
        // normal, which is what puts a curved shadow edge across the disc.
        vec3 offs = n * u_bodyRadiusKm;
        float lit = solarLitAt(u_sunFromBodyKm - offs, u_occFromBodyKm - offs, u_occRadiusKm, u_sunRadiusKm);
        // Totality is not black: sunlight refracted through the occulter's
        // atmosphere fills the umbra (a DISCLOSED constant — see the kernel).
        vec3 sunTint = mix(u_umbralTint, vec3(1.0), clamp(lit * 3.0, 0.0, 1.0));
        float direct = max(lit, (1.0 - lit) * u_umbralT);

        float mu0 = max(dot(n, toSun), 0.0);
        float mu  = max(dot(n, toCam), 1e-3);
        float alpha = acos(clamp(dot(toSun, toCam), -1.0, 1.0));
        float brdf = lommelSeeliger(mu0, mu) * oppositionSurge(alpha, u_B0, u_hOpp);

        // Parent-reflected light (earthshine and its cousins): its own little
        // Lommel-Seeliger lobe from the parent's direction, so the night side
        // is lit from the right side of the sky and not by a flat ambient.
        float mu0p = max(dot(n, normalize(u_shineDir)), 0.0);
        float shine = u_shine * lommelSeeliger(mu0p, mu);

        float mottle = mix(1.0, 0.72 + 0.56 * vnoise(vLocal * 7.0), u_texMix);
        float radiance = u_albedo * u_illum * (brdf * direct + shine) * mottle;
        vec3 col = u_base * airlessTone(radiance, u_gain, u_stretch) * sunTint;
        // A faint limb so a dark body still reads against black.
        col += pow(1.0 - max(dot(n, toCam), 0.0), 3.0) * 0.05 * vec3(0.55, 0.62, 0.78);

        gl_FragColor = vec4(col, 1.0);
        gl_FragColor.rgb = toneDecode(gl_FragColor.rgb);   // sRGB colour picks → linear
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

/**
 * @param {{ colorHex:number, albedo:number, bodyRadiusKm:number,
 *           occulterRadiusKm?:number, texMix?:number }} o
 */
export function airlessSphereMaterial(o) {
    return new THREE.ShaderMaterial({
        vertexShader: SPHERE_VS, fragmentShader: SPHERE_FS,
        uniforms: {
            u_base:          { value: new THREE.Color(o.colorHex ?? 0xbfbcb4) },
            u_albedo:        { value: o.albedo ?? 0.14 },
            u_illum:         { value: 1 },
            u_gain:          { value: AIRLESS_DISPLAY.gain },
            u_stretch:       { value: AIRLESS_DISPLAY.stretch },
            u_B0:            { value: OPPOSITION.B0 },
            u_hOpp:          { value: OPPOSITION.h },
            u_shine:         { value: 0 },
            u_shineDir:      { value: new THREE.Vector3(0, 0, 1) },
            u_sunFromBodyKm: { value: new THREE.Vector3(1.496e8, 0, 0) },
            u_occFromBodyKm: { value: new THREE.Vector3(0, 0, 0) },
            u_occRadiusKm:   { value: o.occulterRadiusKm ?? 0 },
            u_sunRadiusKm:   { value: SUN_RADIUS_KM },
            u_bodyRadiusKm:  { value: o.bodyRadiusKm ?? 1 },
            u_umbralT:       { value: UMBRAL_TRANSMISSION },
            u_umbralTint:    { value: new THREE.Color(UMBRAL_TINT.r, UMBRAL_TINT.g, UMBRAL_TINT.b) },
            u_texMix:        { value: o.texMix ?? 1 },
        },
    });
}
