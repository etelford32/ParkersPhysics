/**
 * wind-trail-compositor.js — energy-conserving compositing for the wind trails
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The pure half (`trailKnee`, `TRAIL_TONE`, the GLSL text) is THREE-free and
 * node-gated by `tests/wind-trail-compositor.mjs`; only `TrailCompositor`
 * touches THREE, and it takes THREE by injection like `WindColumns` does.
 *
 * THE PROBLEM (`EARTHVIEW_VISUAL_DIALIN_PLAN.md` §3.1a, measured 2026-10-27)
 * ──────────────────────────────────────────────────────────────────────────
 * The four trail layers are `LineBasicMaterial` with ADDITIVE blending:
 * on-screen brightness is the SUM of every trail crossing a pixel. That is
 * right for light, and it is what lets the camera descend through the stack
 * (addition commutes, so draw order does not matter). But a sum has no
 * ceiling: at globe view thousands of trails pile up and the pixel runs past
 * 1.0 in every channel. ACES then rolls the excess off toward WHITE — the
 * tone curve desaturates highlights on purpose — so exactly where the wind
 * is densest the blue family is destroyed and the field reads as a white
 * haze. `CLOUD_WIND_DEPTH_PLAN.md` §4 dimmed each trail at far zoom
 * (0.62 + 1.08·zoom01) to push the clip further out; it did not remove it.
 *
 * THE FIX
 * ───────
 * Sum the trails ALONE, then compress the sum ONCE, then composite:
 *
 *   trail layer  ──► offscreen HalfFloat target (additive, planet-occluded)
 *   target       ──► trailKnee(): hue-preserving shoulder, peak → 1 asymptotically
 *   kneed sum    ──► premultiplied OVER the scene, alpha = kneed peak
 *
 * `trailKnee` is `heroTone` (js/hero-color.js, Khronos PBR Neutral's
 * shoulder) with NO desaturation: every channel is scaled by the same
 * factor, so ten slow navy trails saturate to a deep pure blue and ten fast
 * ones to the pale ice of the palette's fast end — the hue is the
 * palette's, always, and the brightest a bundle can get is the brightest
 * the palette has. A single trail (peak ≈ 0.6 at globe view) sits under the
 * knee and is drawn exactly as before.
 *
 * WHY "OVER", NOT ADDITIVE, FOR THE FINAL COMPOSITE
 * ─────────────────────────────────────────────────
 * Capping the sum bounds the trail light, but adding it onto a sunlit
 * continent at 0.8 would push the pixel past 1 again and hand it back to
 * ACES. So the kneed sum is composited premultiplied-over with alpha = its
 * own kneed peak: a faint trail (peak 0.1) is 90 % additive and reads as
 * light; a dense bundle (peak → 1) REPLACES what is under it and reads as
 * ink — the way Windy draws particles over its colour layers. Light where
 * sparse, ink where dense, never white. On the night side the two blends
 * are indistinguishable (there is nothing under the trail to replace).
 *
 * THINGS THAT ARE LOAD-BEARING
 * ────────────────────────────
 * • The offscreen pass needs the PLANET'S DEPTH or trails on the far side
 *   show through the globe. `render()` first draws an OCCLUDER — a
 *   colour-write-off icosphere at the planet's radius, level 4 (5 120
 *   faces; chord sag 6e-4 R, under a pixel at any zoom) parented to the
 *   globe so it follows its rotation — into the target's depth buffer,
 *   then the trails depth-tested against it. Drawing the real globe mesh
 *   (level 6, 81 920 faces) for its depth alone cost a visible slice of
 *   the frame on software GL (measured 2026-10-28: the page-boot gates
 *   went from passing to timing out). The occluder is selected by a THREE
 *   layer (`globeLayer`), the trails by another (`trailLayer`); the main
 *   pass renders layer 0 only, so the trails are drawn exactly once and
 *   the occluder never. Layers are per-object, not inherited.
 * • The target is MULTISAMPLED where WebGL2 allows (the composer's own
 *   target is), or the 1-px lines alias against today's render — and the
 *   sample count FOLLOWS THE GOVERNOR (`setSamples`: 4 / 2 / 0 by tier),
 *   because a 4× resolve of a full-res half-float target every frame is
 *   exactly the kind of cost the floor tier exists to shed.
 * • HalfFloat where the context can render to it; on an 8-bit target the
 *   sum clips per channel BEFORE the knee and the layer degrades to
 *   today's behaviour minus the ACES whitening. `hdr` reports which.
 * • `readback()` exists for the gates: it reads the RAW sum (pre-knee) so a
 *   test can prove the clip would have happened (peak > 1 somewhere) and
 *   that the knee bounds it — a threshold without that control is a guess.
 *
 * Hatches: `?trailcomp=0` keeps the trails on the old additive path (the
 * negative control and the A/B); `window.setTrailCompositing(bool)`.
 */

import { heroTone } from './hero-color.js';

/** Knee on the summed trails' PEAK channel: identity below, shoulder above. */
export const TRAIL_TONE = Object.freeze({ knee: 0.60 });

/**
 * Hue-preserving compression of a summed trail colour (linear, ≥ 0): the
 * heroTone shoulder with desat 0. peak ≤ knee → unchanged; peak → ∞ → 1.
 */
export function trailKnee(rgb, { knee = TRAIL_TONE.knee } = {}) {
    return heroTone([Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])], { knee, desat: 0 });
}

/** Alpha the composite uses for a kneed colour: its peak channel. */
export function trailAlpha(kneed) {
    return Math.min(1, Math.max(0, Math.max(kneed[0], kneed[1], kneed[2])));
}

/** GLSL mirror of trailKnee — the knee is interpolated, never retyped. */
export const TRAIL_KNEE_GLSL = /* glsl */`
#define TRAIL_KNEE ${TRAIL_TONE.knee.toFixed(4)}
vec3 trailKnee(vec3 c) {
    c = max(c, vec3(0.0));
    float peak = max(c.r, max(c.g, c.b));
    if (peak <= TRAIL_KNEE) return c;
    float d  = 1.0 - TRAIL_KNEE;
    float np = 1.0 - d * d / (peak + d - TRAIL_KNEE);
    return c * (np / peak);
}`;

const COMPOSITE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D u_tex;
uniform float u_gain;
varying vec2 vUv;
${TRAIL_KNEE_GLSL}
void main() {
    vec3 t = trailKnee(texture2D(u_tex, vUv).rgb * u_gain);
    float a = max(t.r, max(t.g, t.b));
    // Premultiplied over: light where sparse, ink where dense (see header).
    gl_FragColor = vec4(t, a);
}`;

/** Half-float (binary16) bits → number; for readback() on a HalfFloat target. */
export function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Summary of a readback: distribution of the PEAK channel over lit pixels
 * (peak > floor), raw and after the knee. Pure; the gate calls it on the
 * numbers `TrailCompositor.readback()` returns.
 */
export function sumStats(rgbPeaks, { floor = 0.02, knee = TRAIL_TONE.knee } = {}) {
    const lit = [];
    for (const p of rgbPeaks) if (p > floor) lit.push(p);
    lit.sort((a, b) => a - b);
    const q = (t) => (lit.length ? lit[Math.min(lit.length - 1, Math.floor(t * lit.length))] : 0);
    const over = lit.filter((p) => p > 1).length;
    const kneedMax = lit.length ? trailKnee([q(1), 0, 0], { knee })[0] : 0;
    return {
        n: lit.length, p50: q(0.5), p99: q(0.99), max: q(1),
        fracOver1: lit.length ? over / lit.length : 0,
        kneedMax,
    };
}

export class TrailCompositor {
    /**
     * @param {object} THREE
     * @param {THREE.WebGLRenderer} renderer
     * @param {object} opts
     *   scene       the page scene (the trails and the globe live in it)
     *   globe       the planet mesh the occluder is parented to (follows its rotation)
     *   radius      the planet's radius in scene units (the occluder's)
     *   trailLayer  THREE layer index the trails are moved to (default 3)
     *   globeLayer  THREE layer index the occluder lives on (default 4)
     *   renderOrder where the composite quad sits in the scene's draw order
     *   mobile      fewer MSAA samples
     */
    constructor(THREE, renderer, { scene, globe, radius = 1, trailLayer = 3, globeLayer = 4, renderOrder = 3.31, mobile = false } = {}) {
        this.THREE      = THREE;
        this.renderer   = renderer;
        this.scene      = scene;
        this.globe      = globe;
        this.trailLayer = trailLayer;
        this.globeLayer = globeLayer;
        this.enabled    = true;
        this._meshes    = new Set();
        this.knee       = TRAIL_TONE.knee;

        const gl2 = renderer.capabilities.isWebGL2;
        const canHalf = gl2 && (renderer.extensions.has('EXT_color_buffer_float')
                              || renderer.extensions.has('EXT_color_buffer_half_float'));
        this.hdr        = canHalf;
        this.maxSamples = gl2 ? (mobile ? 2 : 4) : 0;
        this.samples    = this.maxSamples;
        this.rt = null;
        this._buildTarget(2, 2);

        // The occluder: planet depth only (colour write off, depth write on),
        // on the globe layer so the main pass never draws it.
        this._depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
        this.occluder = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 4), this._depthMat);
        this.occluder.layers.set(globeLayer);
        this.occluder.frustumCulled = false;
        globe.add(this.occluder);

        this.uniforms = { u_tex: { value: this.rt.texture }, u_gain: { value: 1 } };
        const mat = new THREE.ShaderMaterial({
            vertexShader:   COMPOSITE_VERT,
            fragmentShader: COMPOSITE_FRAG,
            uniforms:       this.uniforms,
            transparent:    true,
            depthWrite:     false,
            depthTest:      false,
            blending:       THREE.CustomBlending,
            blendSrc:       THREE.OneFactor,
            blendDst:       THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha:  THREE.OneFactor,
            blendDstAlpha:  THREE.OneMinusSrcAlphaFactor,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        this.quad.frustumCulled = false;
        this.quad.renderOrder   = renderOrder;
        this.quad.visible       = false;
        scene.add(this.quad);

        this._size  = new THREE.Vector2();
        this._clear = new THREE.Color();
        this._mask  = 0;
    }

    _buildTarget(w, h) {
        const THREE = this.THREE;
        if (this.rt) this.rt.dispose();
        this.rt = new THREE.WebGLRenderTarget(w, h, {
            type:            this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
            format:          THREE.RGBAFormat,
            minFilter:       THREE.NearestFilter,
            magFilter:       THREE.NearestFilter,
            depthBuffer:     true,
            stencilBuffer:   false,
            generateMipmaps: false,
            samples:         this.samples,
        });
        if (this.uniforms) this.uniforms.u_tex.value = this.rt.texture;
    }

    /**
     * MSAA sample count for the sum target, clamped to what the context
     * allows; the governor calls this per tier. Rebuilds the target (a
     * render target's sample count is fixed at creation in three r160).
     */
    setSamples(n) {
        const want = Math.max(0, Math.min(this.maxSamples, Math.round(Number(n) || 0)));
        if (want === this.samples) return this.samples;
        this.samples = want;
        this._buildTarget(this.rt.width, this.rt.height);
        return this.samples;
    }

    /** Put a trail mesh on the compositor's layer (or back on 0 when disabled). */
    adopt(mesh) {
        this._meshes.add(mesh);
        this._seat(mesh);
    }
    _seat(mesh) {
        if (this.enabled) { mesh.layers.set(this.trailLayer); }
        else              { mesh.layers.set(0); }
    }

    setEnabled(on) {
        this.enabled = !!on;
        for (const m of this._meshes) this._seat(m);
        if (!this.enabled) this.quad.visible = false;
    }

    /** Any adopted trail mesh drawing this frame? */
    get active() {
        if (!this.enabled) return false;
        for (const m of this._meshes) if (m.visible) return true;
        return false;
    }

    get targetSize() { return { width: this.rt.width, height: this.rt.height }; }

    /**
     * Sum the trails into the offscreen target. Call once per frame BEFORE
     * the main render; the quad then composites during it.
     */
    render(renderer, camera) {
        const on = this.active;
        this.quad.visible = on;
        if (!on) return;

        renderer.getDrawingBufferSize(this._size);
        const w = Math.max(1, Math.round(this._size.x));
        const h = Math.max(1, Math.round(this._size.y));
        if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);

        const prevTarget = renderer.getRenderTarget();
        const prevAuto   = renderer.autoClear;
        renderer.getClearColor(this._clear);
        const prevAlpha  = renderer.getClearAlpha();
        const prevMask   = camera.layers.mask;

        renderer.setRenderTarget(this.rt);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = false;
        renderer.clear(true, true, false);

        // 1. Planet depth (the occluder), colour off.
        camera.layers.set(this.globeLayer);
        renderer.render(this.scene, camera);

        // 2. Trails, additive, depth-tested against the planet.
        camera.layers.set(this.trailLayer);
        renderer.render(this.scene, camera);

        camera.layers.mask = prevMask;
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(this._clear, prevAlpha);
        renderer.autoClear = prevAuto;
    }

    /**
     * Read the RAW sum back (pre-knee) and return the peak channel per
     * sampled pixel, striding by `step`. Half floats are decoded; an 8-bit
     * target returns 0‥1 (and `hdr` says so). For gates and probes only.
     */
    readback(renderer, { step = 4 } = {}) {
        const THREE = this.THREE;
        const w = this.rt.width, h = this.rt.height;
        if (w < 2 || h < 2) return { peaks: [], width: w, height: h, hdr: this.hdr };
        const half = this.rt.texture.type === THREE.HalfFloatType;
        const buf = half ? new Uint16Array(w * h * 4) : new Uint8Array(w * h * 4);
        renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
        const peaks = [];
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const i = (y * w + x) * 4;
                let r, g, b;
                if (half) { r = halfToFloat(buf[i]); g = halfToFloat(buf[i + 1]); b = halfToFloat(buf[i + 2]); }
                else      { r = buf[i] / 255;        g = buf[i + 1] / 255;        b = buf[i + 2] / 255; }
                peaks.push(Math.max(r, g, b));
            }
        }
        return { peaks, width: w, height: h, hdr: this.hdr };
    }

    dispose() {
        this.rt.dispose();
        this.globe.remove(this.occluder);
        this.occluder.geometry.dispose();
        this._depthMat.dispose();
        this.quad.geometry.dispose();
        this.quad.material.dispose();
    }
}
