/**
 * hero-color.js — the homepage hero's ONE colour pipeline (index.html canvas)
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONTRACT. Everything the hero draws is LINEAR LIGHT until the very last
 * pass, and exactly one thing turns light into display values:
 *
 *     every material ──► linear radiance ──► HalfFloat scene target (MSAA)
 *                          (blending here IS the addition of light)
 *     scene target ──► bloom (on the same linear HDR image, added in place)
 *     scene target ──► exposure → heroTone → sRGB encode → dither ──► canvas
 *
 * WHAT IT REPLACED (measured 2026-09-24, and each one is why this exists):
 *   • Two colour conventions in one frame. The Earth was lit in linear light
 *     and sRGB-encoded in its own shader; every other raw shader wrote a
 *     colour picked by eye straight to the 8-bit canvas; the built-in
 *     materials were encoded by three. Additive layers therefore ADDED
 *     DISPLAY VALUES — aurora over the atmosphere over the Earth saturated
 *     to cyan-white where they overlapped, which is not what light does.
 *   • No tone curve at all: everything clipped hard at 1.0 PER CHANNEL, so a
 *     bright green curtain turned yellow-white and an orange limb yellow at
 *     the clip (the clip changes the channel ratios, i.e. the hue).
 *   • The bloom saw a DIFFERENT image from the viewer: it re-rendered the
 *     scene into a float target, where three writes built-in materials
 *     LINEAR while the raw shaders still wrote display values — the Sun
 *     sprites and the shells entered the bloom ~2× too dark, relative to
 *     the Earth. And the scene was drawn TWICE per frame to get it.
 *   • The glow was added onto the 8-bit canvas, so every halo tail was
 *     quantised on its own: banded rings around the sunglint and the Sun.
 *
 * THE THREE RULES (the GLSL below, and the JS mirror that tests pin it to):
 *
 *   1. LINEAR RADIANCE goes through `heroRadiance(lin)` — the Earth, which
 *      is lit physically in linear light. Nothing to convert.
 *
 *   2. A DISPLAY-AUTHORED EMITTER — `gl_FragColor = vec4(c, a)` under
 *      additive blending, a colour and a strength somebody tuned BY EYE ON
 *      BLACK — goes through `heroEmit(c, a)`, which writes decode(c·a) with
 *      alpha 1. That is the one conversion that reproduces the author's
 *      pixel EXACTLY when the emitter is alone on black (the sRGB curve is
 *      not a power law: decode(c)·decode(a) is up to 2.3× dim in its linear
 *      toe, which is where a faint glow lives). So no layer changes how it
 *      looks on its own; what changes is how layers COMBINE: as light.
 *      Clamped to display white first — an emitter tuned on an 8-bit canvas
 *      was never brighter than white on its own, and must not become HDR by
 *      accident here. (THE ORRERY'S LESSON, solar-system.html S1: a colour
 *      pick that is encoded without being decoded first turns saturated
 *      orange into pale khaki. `heroEmit` is the decode.)
 *      Note what `c` is: whatever the old shader WROTE. Several of those are
 *      `THREE.Color` uniforms — which ColorManagement had already decoded to
 *      linear, then written as if display (so the wind and the shells ran
 *      darker and more saturated than their hex). That is the look the page
 *      shipped with and was tuned against; this rule preserves it rather
 *      than silently re-lighting every layer. It is recorded, not fixed.
 *
 *   3. BUILT-IN three materials already hand the shader LINEAR colour (three
 *      decodes `color`/`map`), but their OPACITY was tuned by eye as display
 *      coverage. `adaptMaterialForHdr` patches them: additive ones get the
 *      same premultiplied decode as rule 2 (decode(encode(rgb)·α), alpha 1);
 *      normal-blended transparent ones get their alpha decoded (the exact
 *      form does not exist for normal blending; this one is exact outside
 *      the sRGB toe). Opaque ones are already exact.
 *
 * ONE SWITCH. The raw shaders (the hero's, the magnetosphere engine's, the
 * rope layer's) all carry HERO_COLOR_GLSL and end in heroEmit/heroRadiance,
 * which are the IDENTITY without `HERO_HDR` — so the engine renders exactly
 * as it always did on earth.html, space-weather.html and the rest. The hero
 * turns the define on for ITS scene only, with the same per-frame sweep that
 * applies rule 3 (`adaptMaterialForHdr` on every material before each
 * render): no option threads through the engine's builders, and the shells
 * the engine REBUILDS at runtime are caught before their first draw (a
 * one-shot pass at boot missed them). A raw shader that does NOT end in one
 * of the two is reported as 'unconverted' and left alone — it would write
 * display values into linear light (washed out: the khaki trap) — and the
 * browser gate fails on it.
 *
 * THE TONE CURVE (`heroTone`) is identity below HERO_KNEE on the PEAK channel
 * — so rules 2 and 3 really do reproduce the authored pixels, and the Earth's
 * map and its own tuned roll-off (EARTH_FRAG) pass through untouched — then a
 * rational shoulder that reaches display white only asymptotically, applied
 * to all three channels by the SAME factor (hue-preserving), with the
 * compressed excess desaturated toward white (bright light goes white, the
 * way film and eyes see it, instead of going yellow at a per-channel clip).
 * The shoulder is Khronos PBR Neutral's (2024) — value AND slope continuous
 * at the knee — WITHOUT its toe: that toe maps a grey x < 0.08 to 6.25·x²,
 * which crushes a 0.02 night-side continent eightfold, the same failure the
 * EARTH_FRAG note records for ACES. HDR exists here only where light adds:
 * overlapping emitters, the sunglint, and the bloom.
 *
 * DITHER. The output adds triangular (±1 LSB) interleaved-gradient noise
 * before the 8-bit write. The deep field and the atmosphere's exponential
 * falloff are wide, dark, smooth gradients: undithered they band.
 *
 * FALLBACK. No WebGL2, or no colour-renderable half float: `HeroPost` is not
 * built, the materials compile WITHOUT `HERO_HDR`, `heroEmit` is the
 * identity (the old display-space render, exactly), and `heroRadiance`
 * applies heroTone + encode per pixel (exact for an opaque surface). No
 * bloom on that path — the old one needed a float target too.
 *
 * Gates: `node tests/hero-color.mjs` (the pure half: transfer functions,
 * the curve's continuity/monotonicity/hue, rule 2's exactness, the GLSL
 * constants pinned to TONE) and `tests/home-hero-color.spec.js` (the GLSL
 * run on a real GPU context against this file's JS mirror, and every
 * material in the live hero scene checked for rule 1/2/3).
 *
 * This module never imports three: the pure half runs under node, and
 * `HeroPost` takes THREE (and the bloom pass) by injection.
 */

// ── Pure: the sRGB transfer functions (IEC 61966-2-1) ───────────────────────

/** Display value → linear light. */
export function srgbDecode(c) {
    c = Math.max(0, c);
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light → display value. */
export function srgbEncode(x) {
    x = Math.max(0, x);
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

// ── Pure: the tone curve ─────────────────────────────────────────────────────

/**
 * knee: linear peak-channel level below which the curve is the identity
 *   (0.80 linear = 0.906 display: every display-authored emitter up to ~90 %
 *   of white keeps its exact pixel).
 * desat: Khronos PBR Neutral's desaturation rate for the compressed excess.
 */
export const TONE = Object.freeze({ knee: 0.80, desat: 0.15 });

/** heroTone, JS mirror of the GLSL (the gate pins them together). */
export function heroTone(rgb, { knee = TONE.knee, desat = TONE.desat } = {}) {
    const [r, g, b] = rgb;
    const peak = Math.max(r, g, b);
    if (!(peak > knee)) return [r, g, b];
    const d = 1 - knee;
    const np = 1 - (d * d) / (peak + d - knee);
    const s = np / peak;
    const w = 1 - 1 / (desat * (peak - np) + 1);
    return [r * s, g * s, b * s].map((v) => v + (np - v) * w);
}

/** The whole output transform (minus the dither): linear → display. */
export function outputTransform(lin, { exposure = 1 } = {}) {
    return heroTone(lin.map((v) => Math.max(0, v * exposure))).map(srgbEncode);
}

/** Rule 2: a display-authored additive emitter (c, a) → the linear light it adds. */
export function emitLinear(c, a) {
    const k = Math.min(1, Math.max(0, a));
    return c.map((v) => srgbDecode(Math.min(1, Math.max(0, v)) * k));
}

/** Rule 3 (additive built-in): linear colour + display-tuned opacity → the linear light it adds. */
export function builtinAdditiveLinear(lin, alpha) {
    const k = Math.min(1, Math.max(0, alpha));
    return lin.map((v) => srgbDecode(srgbEncode(v) * k));
}

// ── GLSL ─────────────────────────────────────────────────────────────────────
// Constants are INTERPOLATED from TONE — never type the knee twice.

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/**
 * Interpolate at a fragment shader's top level (any raw ShaderMaterial the
 * hero draws), then end the shader with `gl_FragColor = heroEmit(c, a);` or
 * `gl_FragColor = heroRadiance(lin);`. On the HDR path the hero's sweep
 * (`adaptMaterialForHdr`) gives the material `defines: { HERO_HDR: '' }`.
 */
export const HERO_COLOR_GLSL = /* glsl */`
    const float HERO_KNEE  = ${f(TONE.knee)};
    const float HERO_DESAT = ${f(TONE.desat)};
    float heroDecode1(float c) {
        c = max(c, 0.0);
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
    }
    vec3 heroDecode(vec3 c) {
        c = max(c, vec3(0.0));
        return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
    }
    vec3 heroEncode(vec3 x) {
        x = max(x, vec3(0.0));
        return mix(1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, x * 12.92, vec3(lessThanEqual(x, vec3(0.0031308))));
    }
    vec3 heroTone(vec3 c) {
        float peak = max(c.r, max(c.g, c.b));
        if (peak <= HERO_KNEE) return c;
        float d  = 1.0 - HERO_KNEE;
        float np = 1.0 - d * d / (peak + d - HERO_KNEE);
        c *= np / peak;
        float w = 1.0 - 1.0 / (HERO_DESAT * (peak - np) + 1.0);
        return mix(c, vec3(np), w);
    }
    // Rule 2 — a display-authored emitter (additive; or opaque with a = 1).
    vec4 heroEmit(vec3 c, float a) {
    #ifdef HERO_HDR
        return vec4(heroDecode(clamp(c, 0.0, 1.0) * clamp(a, 0.0, 1.0)), 1.0);
    #else
        return vec4(c, a);
    #endif
    }
    // Rule 1 — linear radiance (opaque).
    vec4 heroRadiance(vec3 lin) {
    #ifdef HERO_HDR
        return vec4(max(lin, 0.0), 1.0);
    #else
        return vec4(heroEncode(heroTone(max(lin, 0.0))), 1.0);
    #endif
    }
`;

// Rule 3, injected into three's built-in fragment shaders right after
// `<fog_fragment>` — the colour is final (and linear: on a render target
// three's `<colorspace_fragment>` is the identity) by then.
const BUILTIN_FUNCS = /* glsl */`
float heroBDecode1(float c) { c = max(c, 0.0); return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
vec3 heroBDecode(vec3 c) { c = max(c, vec3(0.0)); return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045)))); }
vec3 heroBEncode(vec3 x) { x = max(x, vec3(0.0)); return mix(1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, x * 12.92, vec3(lessThanEqual(x, vec3(0.0031308)))); }
`;
const FOG_CHUNK = '#include <fog_fragment>';

function hookAdditive(shader) {
    shader.fragmentShader = BUILTIN_FUNCS + shader.fragmentShader.replace(FOG_CHUNK,
        `${FOG_CHUNK}\n\tgl_FragColor = vec4(heroBDecode(heroBEncode(gl_FragColor.rgb) * clamp(gl_FragColor.a, 0.0, 1.0)), 1.0);`);
}
function hookNormal(shader) {
    shader.fragmentShader = BUILTIN_FUNCS + shader.fragmentShader.replace(FOG_CHUNK,
        `${FOG_CHUNK}\n\tgl_FragColor.a = heroBDecode1(clamp(gl_FragColor.a, 0.0, 1.0));`);
}

/**
 * Rules 2/3 for one material of the HDR scene. Returns what it did:
 *   'shader'      raw shader ending in heroEmit/heroRadiance → HERO_HDR on
 *   'unconverted' raw shader WITHOUT them — left alone (and a gate failure)
 *   'additive' | 'normal'   built-in, patched (rule 3)
 *   'opaque'      built-in, already exact
 *   'seen'        handled on an earlier sweep
 * Idempotent (tags `userData.heroHdr`). `additiveBlending` is
 * THREE.AdditiveBlending, injected (no three import here).
 */
export function adaptMaterialForHdr(material, additiveBlending) {
    if (!material) return 'none';
    material.userData = material.userData ?? {};
    if (material.userData.heroHdr) return 'seen';
    let kind;
    if (material.isShaderMaterial || material.isRawShaderMaterial) {
        kind = /\bhero(Emit|Radiance)\s*\(/.test(material.fragmentShader ?? '') ? 'shader' : 'unconverted';
        if (kind === 'shader') {
            material.defines = { ...(material.defines ?? {}), HERO_HDR: '' };
            material.needsUpdate = true;
        }
    } else if (material.blending === additiveBlending) kind = 'additive';
    else if (material.transparent) kind = 'normal';
    else kind = 'opaque';
    material.userData.heroHdr = kind;
    if (kind === 'additive' || kind === 'normal') {
        material.onBeforeCompile = kind === 'additive' ? hookAdditive : hookNormal;
        material.needsUpdate = true;
    }
    return kind;
}

// ── The output pass ──────────────────────────────────────────────────────────

const OUT_VS = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const HERO_OUTPUT_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tScene;
    uniform float uExposure;
    uniform float uDither;
    varying vec2 vUv;
    ${HERO_COLOR_GLSL}
    // Interleaved gradient noise (Jimenez 2014): screen-stable, no sin().
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main() {
        vec3 c = heroEncode(heroTone(max(texture2D(tScene, vUv).rgb * uExposure, 0.0)));
        // Triangular (TPDF) ±1 LSB: two uniform samples summed.
        float n = ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(47.0, 17.0)) - 1.0;
        gl_FragColor = vec4(c + n * uDither / 255.0, 1.0);
    }
`;

/**
 * The HDR path: scene → linear HalfFloat target (MSAA where it was on) →
 * bloom added in place → output transform to the canvas. Build it only when
 * `HeroPost.supported(renderer)`; otherwise render straight to the canvas
 * with the materials compiled without HERO_HDR (see FALLBACK above).
 */
export class HeroPost {
    /** WebGL2 with a colour-renderable half float. */
    static supported(renderer) {
        try {
            if (!renderer?.capabilities?.isWebGL2) return false;
            const ext = renderer.extensions;
            return !!(ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
        } catch { return false; }
    }

    /**
     * @param {object} THREE
     * @param {object} renderer
     * @param {object} opts
     * @param {number} opts.width   drawing-buffer px (the scene target IS the image)
     * @param {number} opts.height
     * @param {number} [opts.samples=0]  MSAA samples (the canvas itself no longer
     *                                   antialiases — it only ever receives one quad)
     * @param {object} [opts.bloom]  an UnrealBloomPass-shaped pass (render(r, write,
     *                               read), setSize, renderToScreen); added INTO the
     *                               scene target, before the curve
     */
    constructor(THREE, renderer, { width, height, samples = 0, bloom = null } = {}) {
        this.THREE = THREE;
        this.renderer = renderer;
        this.hdr = true;
        this.bloom = bloom;
        this.bloomEnabled = !!bloom;
        this.exposure = 1;
        this.samples = Math.max(0, Math.min(samples | 0, renderer.capabilities?.maxSamples ?? 0));
        this.target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
            type: THREE.HalfFloatType,
            samples: this.samples,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            depthBuffer: true, stencilBuffer: false,
        });
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tScene:    { value: this.target.texture },
                uExposure: { value: 1 },
                uDither:   { value: 1 },
            },
            vertexShader: OUT_VS,
            fragmentShader: HERO_OUTPUT_FS,
            depthTest: false, depthWrite: false,
        });
        this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this._quad.frustumCulled = false;
    }

    setSize(width, height) {
        this.target.setSize(Math.max(1, width), Math.max(1, height));
    }

    /**
     * Is the scene target actually renderable? `supported()` reads the
     * extension list; a driver can still refuse a multisampled RGBA16F
     * renderbuffer, and an incomplete framebuffer renders NOTHING (a black
     * hero, no error). Binds the target once and asks GL.
     */
    validate() {
        const r = this.renderer;
        const gl = r.getContext();
        const prev = r.getRenderTarget();
        let ok = false;
        try {
            r.setRenderTarget(this.target);
            ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        } catch { ok = false; }
        r.setRenderTarget(prev);
        return ok;
    }

    /** One frame: the scene ONCE into the linear target, bloom, output. */
    render(scene, camera) {
        const r = this.renderer;
        const prevTarget = r.getRenderTarget();
        const prevAutoClear = r.autoClear;
        r.autoClear = true;
        r.setRenderTarget(this.target);
        r.render(scene, camera);
        if (this.bloom && this.bloomEnabled) {
            this.bloom.renderToScreen = false;
            this.bloom.render(r, null, this.target, 0, false);
        }
        this.material.uniforms.uExposure.value = this.exposure;
        r.setRenderTarget(null);
        r.render(this._quad, this._camera);
        r.setRenderTarget(prevTarget);
        r.autoClear = prevAutoClear;
    }

    /** The output material + a stand-in scene, for program warm-up. */
    warmScene() {
        const s = new this.THREE.Scene();
        s.add(new this.THREE.Mesh(this._quad.geometry, this.material));
        return s;
    }

    dispose() {
        this.target.dispose();
        this.material.dispose();
        this._quad.geometry.dispose();
    }
}
