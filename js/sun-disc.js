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
 *
 * ── 4. The unobserved hemisphere is seen through the same instrument ──────
 * (2026-11-22.) The observed and model hemispheres were fused in LEVEL,
 * palette, limb law and tone curve (tests/sun-fusion.spec.js) but not in
 * TEXTURE. The model's granulation is a display pattern — cells 15 Mm across
 * (ten granules) at ±34 % — and it is the model Sun's look. Beside an HMI
 * browse frame, whose quiet disc is smooth to about a per cent at 2.6 Mm a
 * pixel, it is a claim the instrument contradicts: orbiting away from the
 * Sun–Earth line showed a smooth half and a speckled half meeting at a hard
 * seam (measured on the real frame: pixel-to-pixel texture 23 display levels
 * on the model half against 5 on the observed, the model half ~10 % dimmer).
 *
 * So while a calibrated frame is drawn, the model half's QUIET-SUN texture is
 * scaled, about its smooth photosphere, to the contrast the frame was
 * measured to have: `farTextureGain(sigmaQuiet)` = the frame's robust quiet
 * contrast (sun-observed.js calibrateDisk) ÷ the model texture's own
 * (`MODEL_TEXTURE_SIGMA`). The smooth photosphere it is scaled about is the
 * same `baseCol` the observed half is drawn on, so the LEVELS agree by
 * construction too, and the model's display-level lifts (F10.7, the p-mode
 * pulse) are not applied to that half. Spots, plage, faculae and flares on
 * the unobserved half are untouched, and so is the MODEL view (no frame ⇒
 * gain exactly 1). Below the frame's own resolution both halves get the
 * section-3 synthesis — one pattern, continuous across the terminator.
 * What this is NOT: an observation of the far side. It is the model, shown
 * at the contrast the observing instrument records; the 15° graticule still
 * marks that half as model.
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

// ── The unobserved hemisphere through the same instrument (header §4) ──────
/**
 * The model texture's own contrast, in the units of calibrateDisk's
 * `sigmaQuiet`: the frame contrast at which the model half would be drawn
 * with its texture untouched. MEASURED, not derived — it is the value at
 * which the model half's rendered pixel-to-pixel texture equals the observed
 * half's on the real HMI frame (sigmaQuiet 0.0209), camera 90° off the
 * Sun–Earth line, graticule off, 5×5 high-pass, display levels:
 *
 *     gain     1.00   0.60   0.30   0.20   0.14   0.09   0.05   0      observed half
 *     texture  12.9   7.1    3.4    2.3    1.76   1.26   0.81   0.56   1.28
 *     level    211    212    212    212    212    212    212    211    209
 *
 * The match is at a gain of 0.09, so 0.0209 / 0.09 = 0.23. It is a
 * calibration on rendered pixels, not the pattern's RMS (the tone curve sits
 * between the two). tests/sun-fusion.spec.js re-measures the match on the
 * page — texture ratio 1.0, level within 1 % — and keeps the model's own
 * granulation as its negative control (5× and 10 %).
 */
export const MODEL_TEXTURE_SIGMA = 0.23;
/**
 * The model texture's mean level as a fraction of the smooth photosphere it is
 * drawn on (dark lanes and filaments outweigh the bright cells). The texture
 * is scaled about THIS, so the unobserved half sits on the smooth photosphere
 * at every gain — the level row above. MEASURED on the page: scaled about the
 * smooth photosphere itself (i.e. with this at 1) the half's level fell from
 * 212 display levels at gain 0 to 201 at 0.3 and 163 at 1, so a frame rougher
 * than the real one would have brought the seam back in level; at gain 0.3
 * the level reads 211.8 with 0.60, 208.8 with 0.72, 205.6 with 0.85.
 */
export const MODEL_TEXTURE_MEAN = 0.60;
/** Never draw the model half perfectly flat: a frame that measures ~0 (a smooth synthetic) keeps a trace. */
export const FAR_TEXTURE_MIN = 0.03;

/**
 * The gain on the model hemisphere's quiet texture while a calibrated frame is
 * drawn: the frame's measured quiet contrast over the model texture's own.
 * 1 (the model's look, untouched) when there is no measurement.
 */
export function farTextureGain(sigmaQuiet) {
    if (!(sigmaQuiet >= 0) || !Number.isFinite(sigmaQuiet)) return 1;
    return Math.min(1, Math.max(FAR_TEXTURE_MIN, sigmaQuiet / MODEL_TEXTURE_SIGMA));
}

/**
 * Continuum contrast of faculae / plage at the extreme limb, as a fraction of
 * the model's (Ca / EUV-bright) plage term; times (1 − μ), so nothing at disc
 * centre. White-light faculae are a limb phenomenon of order 10 %.
 */
export const FACULA_CONTINUUM_LIMB = 0.15;

const f = (x) => { const s = String(x); return /[.e]/.test(s) ? s : s + '.0'; };

/** GLSL for sunFS. No backticks in here. */
export const DISC_GLSL = /* glsl */`
    // ── js/sun-disc.js — generated, do not retype ──────────────────────────
    const float DISC_C2      = ${f(C2_M_K)};
    const vec3  DISC_LAMBDA  = vec3(${LAMBDA_RGB_M.map(f).join(', ')});
    const float DISC_MU_FLOOR = ${f(MU_FLOOR)};
    const float DISC_GRAN_FREQ = ${f(GRANULE_FREQ)};
    const float DISC_GRAN_AMP  = ${f(GRANULE_CONTRAST)};
    const float DISC_FACULA_LIMB = ${f(FACULA_CONTINUUM_LIMB)};
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
