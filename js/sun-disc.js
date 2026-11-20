/**
 * sun-disc.js — the photosphere's colour at the limb and its sub-frame detail (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 4 (the part that needs no new solver),
 * 2026-11-20. No three, no DOM. Gate: `node tests/sun-disc.mjs`. sunFS
 * interpolates DISC_GLSL and the constants below — ONE copy.
 *
 * ── 1. The limb is REDDER, not only darker ───────────────────────────────
 * sun.html darkened the limb with one grey curve (Neckel & Labs's 5-term
 * polynomial) multiplied onto a yellow base colour. Darkening a yellow
 * uniformly gives OLIVE — measured on the real HMI frame, disc centre
 * (255, 254, 188), 0.98 R☉ (172, 147, 71) — which is what made the disc read
 * as flat khaki. The real limb is redder as well as darker: at the limb the
 * sightline reaches unit optical depth higher in the photosphere, where it is
 * cooler, and a cooler Planck curve loses blue faster than red.
 *
 * That is derived here, not tabulated. For a grey atmosphere in the Eddington
 * approximation,
 *
 *     T(τ)⁴ = ¾ · T_eff⁴ · (τ + ⅔),
 *
 * and the Eddington–Barbier relation says the emergent intensity at angle μ
 * is the source function at τ = μ:  I_λ(μ) ≈ B_λ(T(τ = μ)). So
 *
 *     I_λ(μ) / I_λ(1) = B_λ(T(μ)) / B_λ(T(1))
 *                     = (e^{x(1)} − 1) / (e^{x(μ)} − 1),   x(μ) = c₂ / (λ T(μ)).
 *
 * It is a textbook model and it is not exact (the real photosphere is not
 * grey; H⁻ opacity makes the observed law a little shallower). So it is used
 * ONLY FOR THE COLOUR: the LUMINANCE of the limb darkening stays the measured
 * Neckel & Labs polynomial the page already had and that the observed ↔ model
 * fusion is calibrated against. `limbChroma` returns the three ratios divided
 * by their own luminance-weighted mean for the colour they multiply, so the
 * product's luminance is exactly unchanged (the gate checks it to 1e-12) and
 * every photometric gate on the page (tests/sun-fusion.spec.js) is untouched.
 *
 * The node gate also checks the derivation against observation where it can.
 * MEASURED: the model's 549 nm darkening against the Neckel & Labs polynomial
 * is 0.868 vs 0.873 at μ = 0.8, 0.667 vs 0.731 at 0.5, 0.463 vs 0.543 at 0.2
 * — 1 %, 9 % and 15 % low, always on the over-darkening side, as a grey model
 * should be. Close enough to trust its COLOUR ratio, not close enough to
 * replace the polynomial. The tint it yields is small — at μ = 0.2 red ×1.07,
 * blue ×0.87 — which is the point: it is a hue shift, not a second darkening.
 *
 * ── 2. The palette is sRGB, the buffer is linear ─────────────────────────
 * sunFS's `blackbody()` returns colour PICKS — (1.00, 0.83, 0.40) is
 * commented "golden (G2V)" — and the composer encodes linear → sRGB at the
 * end, so the pick was displayed as (255, 235, 168): pale yellow, not gold.
 * The orrery had the same fault (SOLAR_SYSTEM_VISUAL_REVIEW.md S1,
 * js/tone-decode.js). `PALETTE_DECODE_GAMMA` is applied to the pick so the
 * colour its author named is the colour on screen.
 *
 * ── 3. Below the frame's sample spacing the disc is SYNTHESISED, and says so
 * An HMI browse frame resolves 1.5–3 Mm per pixel; granules are ~1.4 Mm. When
 * the camera magnifies the disc past the frame's own resolution the picture
 * is an up-scaled JPEG and looks like one. Plan Phase 4 (and the Mars regolith
 * rule) allow one thing there: a synthesised pattern at TRUE scale, applied as
 * SHADING only — it multiplies the observed radiance by 1 ± a few per cent, it
 * never moves, recolours or replaces an observed feature — faded in only as
 * the view passes the frame's resolution, suppressed inside sunspots, damped
 * toward the limb by foreshortening, and DISCLOSED in the provenance chip.
 * `detailWeight` is the fade; `GRANULE_MM` and `GRANULE_CONTRAST` are the two
 * stated numbers (Bray, Loughhead & Durrant 1984: mean cell ~1.4 Mm; rms
 * continuum contrast at 5000 Å after a 1″ instrument ≈ 5–8 %).
 */

/** Second radiation constant c₂ = hc/k, m·K (CODATA 2018). */
export const C2_M_K = 1.438776877e-2;
/** Dominant wavelengths of the sRGB primaries, metres (R ≈ 611 nm, G ≈ 549 nm, B ≈ 464 nm). */
export const LAMBDA_RGB_M = Object.freeze([611e-9, 549e-9, 464e-9]);
/** Rec. 709 luminance weights (linear). */
export const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);
/** The palette's picks are sRGB; this decodes them to linear (the orrery's toneDecode exponent). */
export const PALETTE_DECODE_GAMMA = 2.2;
/** μ floor for the colour law: at the extreme limb the plane-parallel model is not valid. */
export const MU_FLOOR = 0.05;

/** Grey-atmosphere temperature at optical depth τ, kelvin. */
export function greyTemperature(tau, teff) {
    return teff * Math.pow(0.75 * (tau + 2 / 3), 0.25);
}

/** Planck ratio B_λ(T(μ)) / B_λ(T(1)) for one wavelength — the Eddington–Barbier limb darkening. */
export function limbDarkeningEB(mu, lambdaM, teff = 5778) {
    const m = Math.max(mu, MU_FLOOR);
    const x1 = C2_M_K / (lambdaM * greyTemperature(1, teff));
    const xm = C2_M_K / (lambdaM * greyTemperature(m, teff));
    return Math.expm1(x1) / Math.expm1(xm);
}

/**
 * Per-channel colour factor at μ for a base colour `base` (linear RGB):
 * the three Eddington–Barbier ratios, rescaled so that
 * luminance(base ∘ chroma) === luminance(base). Returns [r, g, b].
 */
export function limbChroma(mu, base = [1, 1, 1], teff = 5778) {
    const c = LAMBDA_RGB_M.map((l) => limbDarkeningEB(mu, l, teff));
    const L0 = base[0] * LUMA[0] + base[1] * LUMA[1] + base[2] * LUMA[2];
    const L1 = base[0] * c[0] * LUMA[0] + base[1] * c[1] * LUMA[1] + base[2] * c[2] * LUMA[2];
    const k = L1 > 0 ? L0 / L1 : 1;
    return c.map((v) => v * k);
}

/** Neckel & Labs (1994) 5-term law the page uses for LUMINANCE — mirrored from sunFS, pinned by the gate. */
export function limbLuminanceNL(mu) {
    const m2 = mu * mu, m3 = m2 * mu, m4 = m2 * m2, m5 = m4 * mu;
    return Math.max(0.06, 0.36459 + 1.06147 * mu - 1.01793 * m2 + 1.01203 * m3 - 0.70623 * m4 + 0.25007 * m5);
}

/** sRGB pick → linear, the palette decode. */
export function decodePick(rgb) { return rgb.map((v) => Math.pow(Math.max(v, 0), PALETTE_DECODE_GAMMA)); }

// ── Sub-frame granulation ──────────────────────────────────────────────────
export const RSUN_MM = 695.7;
/** Mean granule cell size, Mm, and the same in R☉. */
export const GRANULE_MM = 1.4;
export const GRANULE_RSUN = GRANULE_MM / RSUN_MM;
/** Cells per unit length on the unit sphere — the noise frequency that puts one cell per granule. */
export const GRANULE_FREQ = Math.round(1 / GRANULE_RSUN);
/** Peak-to-mean shading amplitude at disc centre once fully faded in. */
export const GRANULE_CONTRAST = 0.07;

/**
 * How much of the synthesised detail is shown, 0..1, from how far the view
 * magnifies the observed frame. `screenRsunPerPx` is the scene's scale at the
 * sub-camera point; `frameRsunPerPx` is the frame's own. Nothing while the
 * screen is coarser than the frame; all of it once the frame is being
 * magnified 2×.
 */
export function detailWeight(screenRsunPerPx, frameRsunPerPx) {
    if (!(screenRsunPerPx > 0) || !(frameRsunPerPx > 0)) return 0;
    const ratio = screenRsunPerPx / frameRsunPerPx;        // < 1 ⇒ magnifying past the frame
    const t = Math.min(1, Math.max(0, (1 - ratio) / 0.5));
    return t * t * (3 - 2 * t);
}

/** Scene scale at the sub-camera point of a unit sphere: R☉ per CSS pixel. */
export function screenScaleAt(distance, fovDeg, viewportHeightPx) {
    const d = Math.max(distance - 1, 1e-3);
    return (2 * d * Math.tan(0.5 * fovDeg * Math.PI / 180)) / Math.max(viewportHeightPx, 1);
}

/** A frame's own scale: R☉ per frame pixel, from its measured disc radius (fraction of the frame width). */
export function frameScale(diskFraction, framePx) {
    return 1 / Math.max(diskFraction * framePx, 1);
}

const f = (x) => { const s = String(x); return /[.e]/.test(s) ? s : s + '.0'; };

/** GLSL for sunFS. No backticks in here. */
export const DISC_GLSL = /* glsl */`
    // ── js/sun-disc.js — generated, do not retype ──────────────────────────
    const float DISC_C2      = ${f(C2_M_K)};
    const vec3  DISC_LAMBDA  = vec3(${LAMBDA_RGB_M.map(f).join(', ')});
    const float DISC_MU_FLOOR = ${f(MU_FLOOR)};
    const float DISC_GRAN_FREQ = ${f(GRANULE_FREQ)};
    const float DISC_GRAN_AMP  = ${f(GRANULE_CONTRAST)};
    // sRGB pick -> linear.
    vec3 discDecode(vec3 c) { return pow(max(c, vec3(0.0)), vec3(${f(PALETTE_DECODE_GAMMA)})); }
    // Eddington-Barbier colour of the limb darkening for base colour 'base':
    // per-channel Planck ratio of a grey atmosphere, rescaled so the luminance
    // of base * chroma equals the luminance of base.
    vec3 limbChroma(float mu, vec3 base, float teff) {
        float m  = max(mu, DISC_MU_FLOOR);
        float t1 = teff * pow(0.75 * (1.0 + 0.6666667), 0.25);
        float tm = teff * pow(0.75 * (m   + 0.6666667), 0.25);
        vec3  x1 = DISC_C2 / (DISC_LAMBDA * t1);
        vec3  xm = DISC_C2 / (DISC_LAMBDA * tm);
        vec3  c  = (exp(x1) - 1.0) / (exp(xm) - 1.0);
        const vec3 W = vec3(${LUMA.map(f).join(', ')});
        float L0 = dot(base, W), L1 = dot(base * c, W);
        return c * (L1 > 0.0 ? L0 / L1 : 1.0);
    }
`;
