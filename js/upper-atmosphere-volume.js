/**
 * upper-atmosphere-volume.js — the atmosphere as a continuous volume
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the five discrete gradient shells as the DEFAULT look of the
 * globe. The shells are not deleted — they stay as the A/B reference and
 * as the fallback when a device cannot afford the march (`setMode`
 * on AtmosphereGlobe switches between them). Both paths stay live.
 *
 * WHAT WAS WRONG WITH SHELLS
 * ──────────────────────────
 * Five spheres with flat per-layer colours and hard boundaries at 85 /
 * 250 / 600 / 1200 km. The atmosphere has no boundaries there — those
 * numbers are names we give to parts of a smooth exponential — and the
 * render was shading by the local ρ at each layer's mid-altitude, which
 * cannot produce limb brightening because limb brightening is a
 * GEOMETRIC effect of the column, not a property of the local density.
 * The result read as concentric sci-fi rings.
 *
 * WHAT THIS DOES INSTEAD
 * ──────────────────────
 * One ray-march through the whole 80–2000 km column, accumulating the
 * real ∫ρ dl. The bright limb then falls out of the geometry for free,
 * at the right thickness, and it moves correctly when the thermosphere
 * inflates. Every number the march uses comes from the engine via the
 * kernel's LUTs — there is no second density model here and no tuned
 * "glow" term.
 *
 * TWO COMPONENTS, AND THE PAGE MUST KEEP THEM APART
 * ─────────────────────────────────────────────────
 * This matters more than it looks:
 *
 *   • DENSITY FIELD — a false-colour rendering of ∫ρ dl, tinted by the
 *     composition profile. This is DATA VISUALISATION. You could not see
 *     it. Above 80 km there is essentially no Rayleigh scattering, so the
 *     neutral atmosphere emits no visible light of its own; a render that
 *     shows a glowing shell and implies it is a photograph is lying.
 *
 *   • AIRGLOW — the emission layers from `AIRGLOW_LAYERS`, at their
 *     observed altitudes, widths and colours. THIS is what an astronaut
 *     actually sees on the limb: a thin green-white band at ~90–100 km
 *     and a broad faint red glow at ~250 km.
 *
 * They are separately toggleable and the legend names which is which.
 * Do not merge them into one prettier-looking term.
 *
 * THE SHADER MIRRORS THE KERNEL — CHANGE THEM TOGETHER
 * ────────────────────────────────────────────────────
 * `VOLUME_FRAG` re-implements, in GLSL, three functions that
 * `upper-atmosphere-column.js` owns and tests:
 *     geoFromVectors      → scene position to (latitude, local solar time)
 *     jacchiaDiurnalRatio → the diurnal bulge
 *     auroralHeatingK     → the auroral ΔT∞
 * The kernel is the oracle. If you change one of those, change the GLSL
 * in the same commit and re-run `node tests/upper-atmosphere-column.mjs`.
 * The hour-angle sign in particular is a silent failure: measured about
 * +north instead of −north it puts the diurnal bulge on the MORNING side
 * and nothing else in the render looks any different.
 *
 * SAMPLING — WHY THIS DIFFERS FROM THE CPU INTEGRATOR ON PURPOSE
 * ──────────────────────────────────────────────────────────────
 * `rayColumn` in the kernel marches UNIFORMLY, because uniform trapezoid
 * on this integrand converges superalgebraically (see its header) and it
 * wants an accurate number. The shader marches with QUADRATIC spacing
 * about the tangent point, which is measurably worse quadrature, because
 * it wants something the kernel does not: it must not ALIAS. The visible
 * airglow band is 10 km FWHM; a limb ray crosses the volume in ~10 000 km,
 * so uniform 64-step sampling lands ~160 km apart and the band flickers in
 * and out as the camera moves. Tangent-centred quadratic spacing puts the
 * near-tangent samples ~5 km apart, which resolves it. A ~0.2 % error in a
 * quantity that then goes through an asinh display stretch is invisible;
 * a strobing airglow band is not. The two schemes are deliberate and the
 * reason is per-consumer — do not "unify" them.
 *
 * BRIGHTNESS IS A LOG STRETCH, AND IT IS DISCLOSED
 * ────────────────────────────────────────────────
 * Measured, from tangent altitude 80 km to 1950 km:
 *
 *     tangent alt    column / column(80 km)
 *          80 km      1
 *         100 km      5.8e-2
 *         400 km      2.1e-6
 *        1600 km      1.1e-9
 *
 * TEN DECADES. The first version used the standard astronomical asinh
 * stretch and it was wrong for this data: asinh is built for a few
 * decades above a noise floor, and at every gain that kept the limb from
 * clipping, everything above ~200 km mapped to pure black — the render
 * was a hard white ring on nothing. The transform is now
 *
 *     brightness = ((log₁₀(column/column_ref) + D) / D) ^ γ
 *
 * over D display decades, which is the same log axis the page's own
 * density plot uses, so the render and the plot agree by construction.
 *
 * γ shapes how much of the faint outer exosphere survives, and it is the
 * one knob here that is a judgement rather than a measurement. Displayed
 * brightness by tangent altitude at D=10, gain 0.90:
 *
 *     γ        80    200   400   800  1400  1950 km
 *     1.15    0.90  0.51  0.34  0.16  0.09  0.02
 *     0.95    0.90  0.56  0.41  0.22  0.13  0.04   ← shipped
 *     0.80    0.90  0.60  0.46  0.27  0.18  0.06
 *
 * 1.15 was tried first and crushed the 800–2000 km halo to almost
 * nothing: the render read as a bright ring with empty space above it,
 * when in fact the exosphere is the largest part of what is being drawn.
 * 0.95 keeps the limb exactly as bright — the base is pinned by the
 * reference — and lifts the outer band into view. Below ~0.8 the faint
 * end starts washing out the star field.
 *
 * D and γ are both reported by `getScaleInfo()` and the legend prints
 * them: it is a display transform, not a change to the physics, and it
 * must stay labelled.
 *
 * THE TWO COMPONENTS COLOUR THEMSELVES DIFFERENTLY, ON PURPOSE
 * ────────────────────────────────────────────────────────────
 * DENSITY takes its colour from the ray's LOWEST POINT. A column-weighted
 * average is dominated by the densest altitude the ray touches, so every
 * fragment came out the same lower-thermosphere blue and the
 * compositional stratification — N₂/O₂ blue, atomic-O amber, He pink,
 * H yellow — was invisible. A limb ray at tangent altitude h samples
 * predominantly the h … h+H shell, so its honest colour is the
 * composition there; for a ray that meets the planet that lowest point is
 * the surface, which correctly gives the dense floor colour.
 *
 * AIRGLOW takes its colour from the EMISSION-WEIGHTED INTEGRAL instead,
 * because the emitting band is ~10 km thick and at whole-globe framing
 * that is one or two PIXELS. Coloured by its lowest point the ring came
 * out salmon — the OH base at 87 km — while the green line at 97 km that
 * dominates the band's visible output never got its own pixel. What a
 * camera records there is the integral across the unresolved band, and
 * the integral is green. Zoomed in far enough to resolve it, both
 * schemes agree. The weighting texel is the same one the brightness
 * integral already fetches, so this costs nothing.
 */

import * as THREE from 'three';
import {
    buildFieldLUT, buildAtmosphereLUT, rayColumn, airglowColumn, airglowAt,
    AURORAL_OVAL, DIPOLE_POLE, diurnalMeanRatio, auroralMeanK,
    R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM,
} from './upper-atmosphere-column.js';

const DEG = Math.PI / 180;

// Reference tangent altitudes the two display stretches are normalised
// against. The density reference sits at the MODEL FLOOR because that ray
// carries the largest column the render can produce — normalising higher
// up (150 km was the first try) clips everything below it into a flat
// white band ~70 km thick, which is what the first screenshots showed.
const TAU_REF_ALT_KM  = MODEL_FLOOR_KM;
// The airglow reference sits on the emitting band itself.
const GLOW_REF_ALT_KM = 90;

/** Step counts per quality tier (samples per half-ray). */
export const VOLUME_QUALITY = Object.freeze({
    low:    16,
    medium: 28,
    high:   40,
});

const VOLUME_VERT = /* glsl */`
    varying vec3 vWorldPos;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

const VOLUME_FRAG = /* glsl */`
    precision highp float;

    uniform vec3      uCameraPos;
    uniform sampler2D uFieldLut;      // (altitude × T∞) → normalised log₁₀ρ
    uniform sampler2D uAltLut;        // row 0 composition rgb · row 1 airglow
    uniform float     uOuterR;
    uniform float     uPlanetR;
    uniform float     uMinKm;
    uniform float     uMaxKm;
    uniform float     uTinfMin;
    uniform float     uTinfMax;
    uniform float     uSpanDecades;
    uniform vec3      uSunDir;
    uniform vec3      uNorth;
    uniform vec3      uMagPole;
    uniform float     uSunDeclRad;
    uniform float     uTinfGlobal;
    uniform float     uDiurnalMean;
    uniform float     uAuroralAmp;
    uniform float     uAuroralMean;
    uniform float     uAuroralCentre;
    uniform float     uAuroralWidth;
    uniform float     uTauRefLog;      // log₁₀ of the reference column
    uniform float     uGlowRefLog;
    uniform float     uDecades;        // display decades, density
    uniform float     uGlowDecades;
    uniform float     uGamma;
    uniform int       uSteps;
    uniform float     uDensityGain;
    uniform float     uAirglowGain;
    uniform float     uShowDensity;   // 0/1
    uniform float     uShowAirglow;   // 0/1
    uniform int       uMode;          // 0 column · 1 composition · 2 anomaly
    uniform float     uFade;

    varying vec3 vWorldPos;

    const float R_EARTH_KM = ${R_EARTH_KM}.0;

    vec2 raySphere(vec3 ro, vec3 rd, float r) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - r * r;
        float disc = b * b - c;
        if (disc < 0.0) return vec2(1e9, -1e9);
        float sq = sqrt(disc);
        return vec2(-b - sq, -b + sq);
    }

    // Disclosed display transform: log₁₀ of the column ratio, spread over
    // uDecades decades, shaped by uGamma. See the module header for the
    // measured dynamic range that rules out a linear or asinh mapping.
    float logStretch(float value, float refLog, float decades) {
        float lx = log2(max(value, 1e-30)) * 0.30103 - refLog;
        return pow(clamp((lx + decades) / decades, 0.0, 1.0), uGamma);
    }

    // ── MIRROR OF upper-atmosphere-column.js geoFromVectors ──────────
    // The hour angle is measured about −uNorth because the scene's
    // longitude convention (x=cos·cos, y=sin, z=cos·sin) increases
    // CLOCKWISE seen from +Y. Flipping this sign moves the diurnal bulge
    // to the morning side and looks perfectly plausible. Gated by
    // 'LST MATCHES localSolarTime' in the kernel test.
    void geoAt(vec3 u, out float latRad, out float lstHr) {
        latRad = asin(clamp(dot(u, uNorth), -1.0, 1.0));
        vec3 pe = u - uNorth * dot(u, uNorth);
        vec3 se = uSunDir - uNorth * dot(uSunDir, uNorth);
        float pl = length(pe), sl = length(se);
        if (pl < 1e-6 || sl < 1e-6) { lstHr = 12.0; return; }
        pe /= pl; se /= sl;
        float sinA = -dot(cross(se, pe), uNorth);
        float cosA = dot(se, pe);
        float hourDeg = degrees(atan(sinA, cosA));
        lstHr = mod(12.0 + hourDeg / 15.0 + 24.0, 24.0);
    }

    // ── MIRROR OF upper-atmosphere-column.js jacchiaDiurnalRatio ─────
    // τ is wrapped into (−180°, 180°]. Without the wrap cos³(τ/2) goes
    // negative near local midnight and the night side comes out colder
    // than T_c. See the kernel comment.
    float diurnalFactorAt(float latRad, float lstHr) {
        float eta   = abs(latRad - uSunDeclRad) * 0.5;
        float theta = abs(latRad + uSunDeclRad) * 0.5;
        float H = mod(15.0 * (lstHr - 12.0) + 180.0, 360.0) - 180.0;
        float tauD = H - 37.0 + 6.0 * sin(radians(H + 43.0));
        tauD = mod(tauD + 180.0, 360.0) - 180.0;
        float sS = pow(abs(sin(theta)), 2.2);
        float cC = pow(abs(cos(eta)),   2.2);
        float c3 = pow(cos(radians(tauD) * 0.5), 3.0);
        return (1.0 + 0.3 * (sS + (cC - sS) * c3)) / uDiurnalMean;
    }

    // ── MIRROR OF upper-atmosphere-column.js auroralHeatingK ─────────
    // Magnetic latitude of a unit vector is asin(u · polê): 90° minus the
    // angular distance from the dipole pole. Zero-mean by construction —
    // the engine's 3·Ap already carries the global response.
    float auroralAt(vec3 u) {
        float magLat = degrees(asin(clamp(dot(u, uMagPole), -1.0, 1.0)));
        float d = (abs(magLat) - uAuroralCentre) / uAuroralWidth;
        return uAuroralAmp * exp(-d * d) - uAuroralMean;
    }

    void main() {
        vec3 ro = uCameraPos;
        vec3 rd = normalize(vWorldPos - uCameraPos);

        vec2 hOut = raySphere(ro, rd, uOuterR);
        if (hOut.y < 0.0) discard;

        float t0 = max(0.0, hOut.x);
        float t1 = hOut.y;
        vec2 hPl = raySphere(ro, rd, uPlanetR);
        // The planet is opaque: stop the march where the ray enters it.
        if (hPl.x > 0.0) t1 = min(t1, hPl.x);
        if (t1 <= t0) discard;

        // Closest approach to the centre, clamped into the visible
        // segment. This is where the column is concentrated and where the
        // thin emission layers must be resolved, so it anchors the
        // sampling on both sides.
        float tMid = clamp(-dot(ro, rd), t0, t1);

        float tau      = 0.0;          // ∫ (ρ/ρmax) dl, scene units
        float glow     = 0.0;          // ∫ visible airglow rate dl
        vec3  glowCol  = vec3(0.0);    // emission-weighted airglow colour
        float anomAcc  = 0.0;          // ∫ (ρ/ρ_global) · (ρ/ρmax) dl
        // Lowest altitude the ray reaches — this fragment's colour comes
        // from there, not from a column average. See the header.
        float minAlt   = 1e9;
        float tinfGlobalN = clamp(
            (uTinfGlobal - uTinfMin) / (uTinfMax - uTinfMin), 0.0, 1.0);

        int steps = uSteps;
        // NB: not 'half' — that is a RESERVED WORD in GLSL ES and the
        // shader fails to compile with a syntax error pointing at the
        // for-statement, which reads like a loop-structure problem rather
        // than a naming one.
        for (int side = 0; side < 2; side++) {
            float dir   = (side == 0) ? -1.0 : 1.0;
            float sMax  = (side == 0) ? (tMid - t0) : (t1 - tMid);
            if (sMax <= 0.0) continue;

            for (int i = 0; i < 64; i++) {
                if (i >= steps) break;
                // Quadratic node spacing about the tangent point — fine
                // where the signal and the thin layers are, coarse in the
                // empty outer volume. See the module header for why this
                // deliberately differs from the CPU integrator.
                float f0 = float(i) / float(steps);
                float f1 = float(i + 1) / float(steps);
                float s0 = sMax * f0 * f0;
                float s1 = sMax * f1 * f1;
                float ds = s1 - s0;
                if (ds <= 0.0) continue;
                vec3 pos = ro + rd * (tMid + dir * (s0 + s1) * 0.5);

                float r = length(pos);
                float altKm = (r - 1.0) * R_EARTH_KM;
                if (altKm > uMaxKm) continue;
                // Below the model floor the engine does not extrapolate,
                // so the render clamps to the floor value rather than
                // inventing an atmosphere it has no model for.
                float altN = clamp((altKm - uMinKm) / (uMaxKm - uMinKm), 0.0, 1.0);

                vec3 u = pos / r;
                float latRad, lstHr;
                geoAt(u, latRad, lstHr);
                float Tinf = max(300.0,
                    uTinfGlobal * diurnalFactorAt(latRad, lstHr) + auroralAt(u));
                float tN = clamp((Tinf - uTinfMin) / (uTinfMax - uTinfMin), 0.0, 1.0);

                float v = texture2D(uFieldLut, vec2(altN, tN)).r;
                float rhoRel = exp2((v - 1.0) * uSpanDecades * 3.3219281);

                minAlt = min(minAlt, altKm);
                tau  += rhoRel * ds;
                vec4 ag = texture2D(uAltLut, vec2(altN, 0.75));
                glow    += ag.a * ds;
                glowCol += ag.rgb * ag.a * ds;

                if (uMode == 2) {
                    float vg = texture2D(uFieldLut, vec2(altN, tinfGlobalN)).r;
                    float rhoGlobal = exp2((vg - 1.0) * uSpanDecades * 3.3219281);
                    anomAcc += (rhoRel / max(rhoGlobal, 1e-30)) * rhoRel * ds;
                }
            }
        }

        vec3 col = vec3(0.0);
        float alpha = 0.0;
        float colAltN = clamp((min(minAlt, uMaxKm) - uMinKm) / (uMaxKm - uMinKm),
                              0.0, 1.0);

        if (uShowDensity > 0.5 && tau > 0.0) {
            float b = clamp(logStretch(tau * R_EARTH_KM, uTauRefLog, uDecades)
                            * uDensityGain, 0.0, 1.0);

            vec3 base = texture2D(uAltLut, vec2(colAltN, 0.25)).rgb;
            if (uMode == 2) {
                // Anomaly view: colour by the local drag multiplier
                // ρ/ρ_global — cool where the field is thinner than the
                // spherically symmetric model, hot where the diurnal bulge
                // and the auroral inflation put extra mass. This is the
                // view that makes the bulge the SUBJECT rather than a
                // few-percent shading difference on the limb.
                float ratio = anomAcc / max(tau, 1e-30);
                float k = clamp((ratio - 0.7) / 0.8, 0.0, 1.0);
                base = mix(vec3(0.22, 0.48, 1.00), vec3(1.00, 0.40, 0.14),
                           smoothstep(0.0, 1.0, k));
            }
            col   += base * b;
            alpha += b;
        }

        if (uShowAirglow > 0.5 && glow > 0.0) {
            float bg = clamp(logStretch(glow * R_EARTH_KM, uGlowRefLog, uGlowDecades)
                             * uAirglowGain, 0.0, 1.0);
            col   += (glowCol / glow) * bg;
            alpha += bg;
        }

        alpha = clamp(alpha, 0.0, 1.0) * uFade;
        if (alpha <= 0.001) discard;
        gl_FragColor = vec4(col, alpha);
    }
`;

/**
 * Encode a Float32Array of 0..1 values into a half-float RGBA texture.
 *
 * Half-float rather than 32-bit float on purpose: linear filtering of
 * RGBA16F is core in WebGL2, while linear filtering of RGBA32F needs
 * OES_texture_float_linear, which is not universal. Nearest sampling on a
 * 96-bin altitude table bands visibly across the limb, so filtering is not
 * optional here. Half-float's ~3 significant digits over the normalised
 * 0..1 range works out to ~3 % density steps after the 12-decade expansion,
 * which is well under what survives the asinh display stretch.
 */
function _halfFloatTexture(src, width, height) {
    const half = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    const tex = new THREE.DataTexture(
        half, width, height, THREE.RGBAFormat, THREE.HalfFloatType,
    );
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

export class AtmosphereVolume {
    /**
     * @param {THREE.Scene} scene
     * @param {object} opts
     * @param {THREE.Vector3} opts.sunDir      sub-solar direction, world frame
     * @param {number} [opts.quality]          samples per half-ray
     */
    constructor(scene, {
        sunDir = new THREE.Vector3(1, 0, 0),
        quality = VOLUME_QUALITY.medium,
        f107 = 150, ap = 15,
    } = {}) {
        this._scene = scene;
        this._disposed = false;
        this._state = { f107, ap, sunDeclDeg: 0 };
        this._showDensity = true;
        this._showAirglow = true;
        this._mode = 0;

        const rOuter = 1 + MODEL_CEIL_KM / R_EARTH_KM;

        // Dipole pole in the scene frame, built with the SAME lat/lon → xyz
        // map the globe uses for the sub-solar point.
        const pLat = DIPOLE_POLE.latDeg * DEG, pLon = DIPOLE_POLE.lonDeg * DEG;
        const pc = Math.cos(pLat);
        const magPole = new THREE.Vector3(
            pc * Math.cos(pLon), Math.sin(pLat), pc * Math.sin(pLon),
        );

        this._material = new THREE.ShaderMaterial({
            vertexShader:   VOLUME_VERT,
            fragmentShader: VOLUME_FRAG,
            uniforms: {
                uCameraPos:     { value: new THREE.Vector3() },
                uFieldLut:      { value: null },
                uAltLut:        { value: null },
                uOuterR:        { value: rOuter },
                uPlanetR:       { value: 1.0 },
                uMinKm:         { value: MODEL_FLOOR_KM },
                uMaxKm:         { value: MODEL_CEIL_KM },
                uTinfMin:       { value: 400 },
                uTinfMax:       { value: 3000 },
                uSpanDecades:   { value: 12 },
                uSunDir:        { value: sunDir.clone().normalize() },
                uNorth:         { value: new THREE.Vector3(0, 1, 0) },
                uMagPole:       { value: magPole },
                uSunDeclRad:    { value: 0 },
                uTinfGlobal:    { value: 1000 },
                uDiurnalMean:   { value: 1.15 },
                uAuroralAmp:    { value: 0 },
                uAuroralMean:   { value: 0 },
                uAuroralCentre: { value: AURORAL_OVAL.centreDeg },
                uAuroralWidth:  { value: AURORAL_OVAL.widthDeg },
                uTauRefLog:     { value: 0 },
                uGlowRefLog:    { value: 0 },
                uDecades:       { value: 10 },
                uGlowDecades:   { value: 2.2 },
                uGamma:         { value: 0.95 },
                uSteps:         { value: quality },
                uDensityGain:   { value: 0.90 },
                uAirglowGain:   { value: 0.95 },
                uShowDensity:   { value: 1 },
                uShowAirglow:   { value: 1 },
                uMode:          { value: 0 },
                uFade:          { value: 1 },
            },
            transparent: true,
            side: THREE.BackSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        this._mesh = new THREE.Mesh(
            new THREE.SphereGeometry(rOuter, 64, 48),
            this._material,
        );
        this._mesh.renderOrder = -1;          // behind every overlay
        this._mesh.frustumCulled = false;
        this._mesh.userData = { kind: 'atmosphere-volume' };
        scene.add(this._mesh);

        this.setState({ f107, ap });
    }

    /**
     * Rebuild both LUTs for a new (F10.7, Ap). ~5 ms; call on profile
     * change, never per frame.
     */
    setState({ f107, ap, sunDeclDeg } = {}) {
        if (this._disposed) return;
        if (Number.isFinite(f107)) this._state.f107 = f107;
        if (Number.isFinite(ap))   this._state.ap   = ap;
        if (Number.isFinite(sunDeclDeg)) this._state.sunDeclDeg = sunDeclDeg;
        const { f107: F, ap: A, sunDeclDeg: decl } = this._state;
        const u = this._material.uniforms;

        const field = buildFieldLUT({ f107Sfu: F, ap: A });
        const alt   = buildAtmosphereLUT({ f107Sfu: F, ap: A, bins: 128 });

        u.uFieldLut.value?.dispose?.();
        u.uAltLut.value?.dispose?.();
        u.uFieldLut.value = _halfFloatTexture(field.data, field.altBins, field.tinfBins);
        u.uAltLut.value   = _halfFloatTexture(alt.data, alt.bins, alt.rows);

        u.uTinfMin.value     = field.tinfMin;
        u.uTinfMax.value     = field.tinfMax;
        u.uSpanDecades.value = field.spanDecades;
        u.uMinKm.value       = field.minKm;
        u.uMaxKm.value       = field.maxKm;

        // Display-stretch references, both anchored on a REAL limb ray so
        // the normalisation tracks the storm state instead of being a
        // magic constant. Density: the column of a ray tangent at the
        // model floor, which is the brightest ray the render can produce,
        // so nothing clips. Airglow: a ray tangent to the emitting band.
        const rhoMax = Math.pow(10, field.logRhoMax);
        const ref = rayColumn({ tangentAltKm: TAU_REF_ALT_KM, f107Sfu: F, ap: A });
        u.uTauRefLog.value = Math.log10(
            Math.max(ref.columnKgM2 / (rhoMax * 1000), 1e-12));

        let verMax = 1e-9;
        for (let h = MODEL_FLOOR_KM; h <= 200; h += 2) {
            verMax = Math.max(verMax, airglowAt(h, { f107Sfu: F, ap: A }).visibleTotal);
        }
        const glowRef = airglowColumn({
            tangentAltKm: GLOW_REF_ALT_KM, f107Sfu: F, ap: A,
        });
        u.uGlowRefLog.value = Math.log10(
            Math.max(glowRef.brightness / verMax, 1e-12));

        u.uTinfGlobal.value  = 900 + 2 * (F - 150) + 3 * A;
        u.uDiurnalMean.value = diurnalMeanRatio(decl);
        u.uAuroralAmp.value  = AURORAL_OVAL.peakDeltaK
            * (1 - Math.exp(-Math.max(0, A) / AURORAL_OVAL.apScaleK));
        u.uAuroralMean.value = auroralMeanK(A);
        u.uSunDeclRad.value  = decl * DEG;

        this._scaleInfo = {
            transform:   'log10',
            decades:     u.uDecades.value,
            gamma:       u.uGamma.value,
            refAltKm:    TAU_REF_ALT_KM,
            glowRefAltKm: GLOW_REF_ALT_KM,
            glowDecades: u.uGlowDecades.value,
            logRhoMin:   field.logRhoMin,
            logRhoMax:   field.logRhoMax,
            spanDecades: field.spanDecades,
        };
    }

    /** Sub-solar direction, world frame. */
    setSunDir(vec3) {
        if (this._disposed || !vec3) return;
        this._material.uniforms.uSunDir.value.copy(vec3).normalize();
    }

    /** Solar declination drives both the Jacchia term and its normaliser. */
    setSunDeclination(deg) {
        if (this._disposed || !Number.isFinite(deg)) return;
        if (Math.abs(deg - this._state.sunDeclDeg) < 0.05) return;
        this._state.sunDeclDeg = deg;
        this._material.uniforms.uSunDeclRad.value = deg * DEG;
        this._material.uniforms.uDiurnalMean.value = diurnalMeanRatio(deg);
    }

    /** Per-frame: the march needs the live camera position. */
    update(camera) {
        if (this._disposed || !this._mesh.visible) return;
        this._material.uniforms.uCameraPos.value.copy(camera.position);
    }

    setVisible(on)      { this._mesh.visible = !!on; }
    getVisible()        { return !!this._mesh.visible; }
    setDensityVisible(on) {
        this._showDensity = !!on;
        this._material.uniforms.uShowDensity.value = on ? 1 : 0;
    }
    setAirglowVisible(on) {
        this._showAirglow = !!on;
        this._material.uniforms.uShowAirglow.value = on ? 1 : 0;
    }
    getComponentVisibility() {
        return { density: this._showDensity, airglow: this._showAirglow };
    }

    /** 'column' | 'composition' | 'anomaly' */
    setMode(mode) {
        const idx = { column: 0, composition: 1, anomaly: 2 }[mode];
        if (idx === undefined) return;
        this._mode = idx;
        this._material.uniforms.uMode.value = idx;
    }
    getMode() { return ['column', 'composition', 'anomaly'][this._mode]; }

    setQuality(steps) {
        const s = Math.max(6, Math.min(64, Math.round(steps)));
        this._material.uniforms.uSteps.value = s;
    }
    getQuality() { return this._material.uniforms.uSteps.value; }

    setExposure({ density, airglow, decades, gamma } = {}) {
        const u = this._material.uniforms;
        if (Number.isFinite(density)) u.uDensityGain.value = density;
        if (Number.isFinite(airglow)) u.uAirglowGain.value = airglow;
        if (Number.isFinite(decades)) u.uDecades.value = Math.max(1, decades);
        if (Number.isFinite(gamma))   u.uGamma.value   = Math.max(0.2, gamma);
        if (this._scaleInfo) {
            this._scaleInfo.decades = u.uDecades.value;
            this._scaleInfo.gamma   = u.uGamma.value;
        }
    }

    /**
     * Fade the volume out when the camera is deep inside it, the same way
     * the discrete shells do — otherwise free-fly users fly into a wall of
     * additive alpha.
     */
    setFade(f) {
        this._material.uniforms.uFade.value = Math.max(0, Math.min(1, f));
    }

    /** Numbers the legend needs so the display stretch can be labelled. */
    getScaleInfo() { return { ...this._scaleInfo }; }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        const u = this._material.uniforms;
        u.uFieldLut.value?.dispose?.();
        u.uAltLut.value?.dispose?.();
        this._mesh.geometry.dispose();
        this._material.dispose();
        this._scene.remove(this._mesh);
    }
}
