/**
 * tone-decode.js — the sRGB decode half of a colour-managed custom shader.
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS FOR. three.js applies its tone curve and its output
 * encode through the `<tonemapping_fragment>` and `<colorspace_fragment>`
 * chunks, which live only in the BUILT-IN materials. A raw `ShaderMaterial`
 * that writes `gl_FragColor` itself gets neither, so `renderer.toneMapping`
 * is silently a no-op on it — that was solar-system.html's S1 bug, where the
 * Sun's disc ran 100 % clipped in R and G and the flare-state luminance σ
 * across it was 0.00 (SOLAR_SYSTEM_VISUAL_REVIEW.md §1.1).
 *
 * APPENDING THE TWO CHUNKS IS ONLY HALF THE FIX, and the other half is this
 * file. Both chunks assume the value handed to them is LINEAR RADIANCE. The
 * colour literals inside these shaders are not: `vec3(1.0, 0.62, 0.12)` is an
 * sRGB colour somebody picked by eye, exactly like the hex you pass to a
 * MeshBasicMaterial — and three.js decodes THAT for you (ColorManagement, on
 * by default since r152). It cannot reach a literal buried in a shader.
 *
 * Encoding an already-encoded value is what destroys saturation, because the
 * transfer curve lifts dark channels far more than bright ones: 0.12 encodes
 * to 0.43 while 1.0 stays 0.93, so that saturated orange comes out pale
 * khaki. Measured across the whole orrery when the chunks went in alone — the
 * corona, the solar-wind disc and every planet lost their colour.
 *
 * `toneDecode()` is the exact inverse of the sRGB transfer function
 * `<colorspace_fragment>` applies, so
 *
 *     decode → ACES → encode
 *
 * leaves hue and saturation where the author put them and adds only the
 * filmic roll-off. USE IT IN ANY SHADER WHOSE OUTPUT IS A COLOUR PICK.
 *
 * DO NOT use it in a shader whose output is genuine HDR emission in arbitrary
 * units — there the number is already linear and the right treatment is an
 * exposure fit, not a decode. `sunFS` in solar-system.html is that case and
 * documents its own `SUN_EXPOSURE`.
 *
 * Gate: `tests/solar-system-tone.spec.js` (it also asserts that every shader
 * on that page carries both chunks, so a new one cannot quietly land on the
 * old pipeline).
 */

/**
 * GLSL declaration block. Interpolate it into a fragment shader's top level,
 * then call `toneDecode()` on the colour immediately before
 * `#include <tonemapping_fragment>`.
 */
export const TONE_DECODE_GLSL = /* glsl */`
    // sRGB EOTF — the exact inverse of three's sRGBTransferOETF. The max()
    // guards pow() against a negative base: a shader that subtracts (a dark
    // sunspot, a filament channel) can hand this a small negative, and pow()
    // of one is undefined, which shows up as NaN pixels, not as a dim pixel.
    vec3 toneDecode(vec3 c) {
        c = max(c, vec3(0.0));
        return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92,
                   vec3(lessThanEqual(c, vec3(0.04045))));
    }
`;
