/**
 * sun-offlimb.js — the OBSERVED corona, off the limb, on the plane of sky
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3b. Read the plan's §5 honesty rules
 * and js/sun-observed.js's header (the fusion scars) before touching this.
 *
 * ── What this draws, and why it is honest ─────────────────────────────────
 *
 * js/sun-observed.js wraps the SDO frame onto the near hemisphere of the
 * photosphere sphere and stops at the limb, because a DISK pixel is a
 * measurement OF A SURFACE and a surface is where you can put it. Everything
 * the frame carries OUTSIDE ρ = 1 — prominences, post-flare arcades, the
 * streamer bases, every dimming and every eruption — was thrown away.
 *
 * That off-limb half is optically thin EUV. An off-limb pixel at plane-of-sky
 * radius ρ is the line integral of ε(n_e, T) along the whole ray whose closest
 * approach to Sun centre is ρ — it is not a measurement of any one point, and
 * PLANE-OF-SKY IS ITS NATIVE GEOMETRY. So the honest place to put it is a
 * plane through the Sun's centre, normal to the Sun–Earth line: that plane is
 * exactly the locus of closest approach for a distant observer, which is where
 * the emission along each of those rays is weighted. Nothing is being invented
 * or de-projected; the integral is drawn where the integral lives.
 *
 * Three consequences follow, and all three are features, not bugs:
 *
 *   1. THE SPHERE OCCLUDES IT. The plane passes through the centre, so its far
 *      half is behind the photosphere and depth-tests away. That is correct —
 *      and it is what makes the layer read as a three-dimensional object with
 *      the Sun in front of it rather than a decal pasted on the camera.
 *      KNOWN LIMIT: the silhouette cone of a unit sphere seen from distance D
 *      cuts the central plane at ρ = D/√(D²−1), so a CLOSE camera hides more
 *      of the annulus (ρ<1.014 at D=6, but ρ<1.16 at D=2). The plane-of-sky
 *      construction is a distant-observer statement; at close range it is the
 *      construction that is approximate, not the render. Documented, not
 *      papered over — do not "fix" it by floating the plane toward the camera,
 *      which would put the emission somewhere it demonstrably is not.
 *   2. IT DOES NOT CO-ROTATE. The photosphere sphere spins; this plane does
 *      not. A frame is a snapshot in the OBSERVER's frame (the Far-Side Watch
 *      rule: the clock moves the observer, not the data), so the layer is
 *      pinned to the Sun–Earth line and replaced by the feed, never spun.
 *      Spinning it would smear a plane-of-sky integral through a volume.
 *   3. IT FADES OFF-AXIS. Orbit away from the Sun–Earth line and the plane is
 *      seen edge-on — the projection the frame encodes is no longer the
 *      viewer's projection, and holding it would be a lie about 3-D structure.
 *      `offAxisWeight` is the plane analogue of the per-fragment `stretch`
 *      term sunFS's fusion already uses (js/sun-observed.js): the same
 *      quantity, |cos of the viewer–observer separation|, applied to a plane
 *      instead of a fragment. Full weight inside OFF_AXIS_FULL_DEG (where the
 *      foreshortening is under 2 %), gone by OFF_AXIS_ZERO_DEG.
 *
 * ── Two channels, not one ────────────────────────────────────────────────
 * 304 Å (He II, 50 kK) and 131 Å (Fe XXI, 10 MK) — the coolest and hottest
 * things the corona does, drawn together. 304 carries prominences, spicules
 * and eruptive filaments; 131 carries flare plasma and post-flare arcades.
 * A viewer sees both at once, in the browse frames' OWN colours: an AIA browse
 * JPEG is already colorized and already byte-scaled by AIA's own display
 * stretch, and per the plan's honesty rule 2 no procedural term may recolour
 * an observed pixel. We correct the LEVEL only (below) and nothing else.
 *
 * ── Level normalisation, and why it is not I0 ────────────────────────────
 * The fusion lesson applies unchanged: a browse JPEG's ABSOLUTE level is a
 * display choice, not radiometry. On the disk that is handled by dividing by
 * the frame's own limb law at disk centre (I0). Off the limb there is no limb
 * law, and disk centre is the wrong reference anyway — for 131 the disk is
 * nearly empty while the off-limb arcade is the whole signal, so an I0 ratio
 * would swing by an order of magnitude between a quiet day and a flare and
 * make the layer's brightness a function of the DISK.
 *
 * So `calibrateOffLimb` measures the frame's own REFERENCE SHELL: the median
 * linear luminance of the annulus REF_SHELL (1.05–1.15 R☉), which is the low
 * corona that is always present. Everything is drawn relative to that. "1.0"
 * therefore means "as bright as this frame's own low corona", which is
 * frame-independent, survives a re-scaling of the browse product, and is the
 * only statement a display-stretched 8-bit JPEG actually supports.
 *
 * A frame whose reference shell is black (no off-limb signal at all: a bad
 * decode, an occulted product, a channel that came back as a disk cutout) sets
 * `ok = false` and THE LAYER DOES NOT DRAW. Dividing by ≈0 would amplify JPEG
 * ringing into a convincing corona, which is the exact failure the plan's
 * honesty rules exist to prevent — feeds down must look down.
 *
 * ── The display stretch, and why there has to be one ─────────────────────
 * Normalised by that shell, the off-limb field spans about 70:1 between the
 * quiet low corona and a bright prominence in the synthetic fixtures, and more
 * than that on a real frame. NO LINEAR MAPPING SHOWS BOTH: pick a gain that
 * makes the quiet corona visible and every prominence clips to white; pick one
 * that holds the prominence and the corona is black. This is exactly why AIA's
 * own off-limb displays are log- or sqrt-stretched.
 *
 * So the layer draws √(L/ref) — the same square-root stretch, applied once,
 * DISCLOSED in the chip tooltip, and applied AFTER the normalisation so it
 * cannot be confused with the level correction. STRETCH_GAMMA is the exponent
 * and is a rendering choice, not a measurement; the structure and the relative
 * ordering of brightnesses are untouched by a monotone stretch, which is what
 * makes it legitimate at all.
 *
 * (The first version had no stretch and a gain of 0.85 tuned as if the field
 * were of order 1. It is not: the sRGB EOTF the texture tag applies — correct,
 * and needed so this agrees with the disk path — re-expands an 8:1 range in
 * byte values into a 72:1 range in linear. Recorded so the gain is not
 * "fixed" again by turning it down until the prominences go away.)
 *
 * ── Running difference ───────────────────────────────────────────────────
 * Consecutive frames, subtracted: the standard way eruptions, EIT waves and
 * coronal dimmings are seen at all, and free here because the layer already
 * holds two frames for its cross-fade. Requirements that are easy to get
 * wrong and are gated by the node test:
 *   • the two frames must be different OBSERVATIONS. `diffReady` is false
 *     while the previous frame carries the same observedAt, and the chip says
 *     so rather than drawing a black annulus and calling it quiet.
 *   • both frames are normalised by their OWN reference shell before the
 *     subtraction — otherwise a change in the browse product's byte-scaling
 *     between two refreshes reads as a full-disk eruption.
 *   • the layer is ADDITIVE, so it cannot darken. A difference is a derived
 *     quantity rather than an observed pixel, so the bipolar encoding
 *     (brightening in the channel's own hue, dimming in DIM_COLOR) is a
 *     legitimate presentation — and it is disclosed in the chip and the
 *     tooltip as a running difference, never shown as an image.
 *
 * ── Split ────────────────────────────────────────────────────────────────
 *   PURE (node-gated by tests/sun-offlimb.mjs): the annulus profile, the
 *     observer basis, the plane→frame mapping, the off-axis weight, the
 *     reference-shell photometry, the chip label.
 *   BROWSER (`SunOffLimb`): fetch both channels through the same proxy the
 *     disk uses, build the ring mesh, drive the uniforms.
 */

import { solarEphemeris, srgbToLinear, luminance, resolveDiskGeometry, readFrame } from './sun-observed.js';

// ── Geometry of the annulus ────────────────────────────────────────────────

/** The two channels drawn. Cool + hot; see the header. */
export const OFFLIMB_CHANNELS = Object.freeze(['304', '131']);

export const R_INNER = 1.0;      // R☉ — the limb
export const R_OUTER = 1.6;      // R☉ — where an AIA frame's off-limb signal is gone
/**
 * Feather widths. The inner ramp exists because the observed DISK already owns
 * ρ < 1: without it the two layers meet at a hard step and the limb reads as a
 * drawn ring. The outer ramp keeps the annulus from ending on a visible edge
 * in a medium the viewer knows has no edge.
 */
export const FEATHER_IN  = 0.015;
export const FEATHER_OUT = 0.14;

/** The shell whose median sets the layer's brightness unit (see the header). */
export const REF_SHELL = Object.freeze({ lo: 1.05, hi: 1.15 });

/**
 * Radial profile of the annulus, 0 outside [R_INNER, R_OUTER].
 * Smoothstep on both edges; the inner ramp starts AT the limb so the observed
 * disk and the observed annulus are continuous across ρ = 1.
 */
export function annulusWeight(rho) {
    if (!(rho >= R_INNER) || rho >= R_OUTER) return 0;
    const inW  = smoothstep(R_INNER, R_INNER + FEATHER_IN, rho);
    const outW = 1 - smoothstep(R_OUTER - FEATHER_OUT, R_OUTER, rho);
    return inW * outW;
}

function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/**
 * The plane-of-sky basis, in the photosphere sphere's object frame.
 *
 * MUST agree with sunFS's disk projection (js/sun-observed.js header): the
 * frame is north-up and only B0 is applied, so Earth's direction is
 * e = (0, sin B0, cos B0), the image's +x is the scene +x, and the image's +y
 * is solar north projected into the plane of sky. Derived, not guessed — these
 * are exactly the rows of the rotation sunFS applies to get `q`, and the node
 * test pins them against that same arithmetic.
 *
 * @returns {{right:number[], up:number[], normal:number[]}} unit vectors
 */
export function observerBasis(b0Rad) {
    const cb = Math.cos(b0Rad), sb = Math.sin(b0Rad);
    return {
        right:  [1, 0, 0],
        up:     [0, cb, -sb],
        normal: [0, sb, cb],
    };
}

/**
 * Plane-of-sky point (x, y) in R☉ → frame UV, using the SAME disk geometry
 * convention the disk path uses: geom = (cx, 1 − cy, r) as fractions of the
 * frame, v already flipped for three.js. No de-rotation: the plane is pinned
 * to the observer, not to the spinning sphere (header, point 2).
 */
export function planeOfSkyUV(x, y, geom) {
    return {
        u: geom.cx + x * geom.r,
        v: (1 - geom.cy) + y * geom.r,
        rho: Math.hypot(x, y),
    };
}

// ── Off-axis gate ──────────────────────────────────────────────────────────

/**
 * Inside this separation the plane-of-sky the frame encodes is the viewer's to
 * better than 1 − cos 12° = 2.2 %, which is well under the level accuracy a
 * byte-scaled browse product supports. Beyond OFF_AXIS_ZERO_DEG the plane is
 * seen at more than 55° and the layer is a foreshortened claim about 3-D
 * structure it does not have.
 */
export const OFF_AXIS_FULL_DEG = 12;
export const OFF_AXIS_ZERO_DEG = 55;

/** Off-axis weight from the cosine of the viewer–observer separation. */
export function offAxisWeight(cosSep) {
    const c = Math.max(-1, Math.min(1, cosSep));
    const full = Math.cos(OFF_AXIS_FULL_DEG * Math.PI / 180);
    const zero = Math.cos(OFF_AXIS_ZERO_DEG * Math.PI / 180);
    return smoothstep(zero, full, c);
}

/** Convenience for the tests and the tooltip. */
export function offAxisWeightDeg(deg) { return offAxisWeight(Math.cos(deg * Math.PI / 180)); }

// ── Reference-shell photometry ─────────────────────────────────────────────

/**
 * Minimum median the reference shell must reach to be believed, LINEAR 0..1.
 *
 * Derived, not picked: a browse product is an 8-bit JPEG, so the smallest
 * distinguishable signal is one code value and anything at or below that is
 * quantisation and ringing rather than corona. The floor is two code values —
 * srgbToLinear(2) ≈ 6.1e-4 — which refuses a black shell while still
 * accepting a genuinely faint one.
 *
 * (It was 2e-3 on the first pass, which was a guess, and a guess that sat
 * ABOVE what a real faint 304 annulus carries: the synthetic 304 fixture's
 * shell measures ≈2.4e-3 and calibrated only intermittently, so the browser
 * gate failed on the 304 channel while 131 passed. A floor with no argument
 * behind it is a floor you cannot debug — hence the derivation above.)
 */
export const REF_MIN_CODE_VALUES = 2;
export const REF_FLOOR = srgbToLinear(REF_MIN_CODE_VALUES);
/** Minimum pixels in the shell before the median means anything. */
export const REF_MIN_SAMPLES = 64;

/**
 * Measure the frame's own low-corona reference level. PURE.
 *
 * Median (not mean) of the linear luminance in REF_SHELL: a single bright
 * prominence or a cosmic-ray hit must not set the unit the whole layer is
 * drawn in, the same reason calibrateDisk fits on μ-binned medians.
 *
 * @param {ArrayLike<number>} rgba row-major RGBA bytes, w·h·4
 * @param {{cx:number, cy:number, r:number}} geom fractions of the frame
 * @returns {{ref:number, samples:number, ok:boolean}}
 */
export function calibrateOffLimb(rgba, w, h, geom) {
    const fail = { ref: 1, samples: 0, ok: false };
    if (!rgba || !geom || !(geom.r > 0)) return fail;
    const R = geom.r * Math.min(w, h);
    const cx = geom.cx * w, cy = geom.cy * h;
    const lo2 = (REF_SHELL.lo * R) ** 2, hi2 = (REF_SHELL.hi * R) ** 2;
    const vals = [];
    // Walk only the bounding box of the outer shell — the frame is 256² here
    // (readFrame's downsample) so this is a few thousand pixels, not a scan.
    const x0 = Math.max(0, Math.floor(cx - REF_SHELL.hi * R));
    const x1 = Math.min(w - 1, Math.ceil(cx + REF_SHELL.hi * R));
    const y0 = Math.max(0, Math.floor(cy - REF_SHELL.hi * R));
    const y1 = Math.min(h - 1, Math.ceil(cy + REF_SHELL.hi * R));
    for (let y = y0; y <= y1; y++) {
        const dy = y - cy;
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const d2 = dx * dx + dy * dy;
            if (d2 < lo2 || d2 > hi2) continue;
            const o = (y * w + x) * 4;
            vals.push(luminance(srgbToLinear(rgba[o]), srgbToLinear(rgba[o + 1]), srgbToLinear(rgba[o + 2])));
        }
    }
    if (vals.length < REF_MIN_SAMPLES) return fail;
    vals.sort((a, b) => a - b);
    const ref = vals[vals.length >> 1];
    // A black shell is not a quiet corona, it is a frame with no off-limb
    // signal. Drawing 1/ref of it would manufacture one out of JPEG ringing.
    if (!(ref >= REF_FLOOR)) return { ref, samples: vals.length, ok: false };
    return { ref, samples: vals.length, ok: true };
}

// ── Chip ───────────────────────────────────────────────────────────────────

/**
 * The suffix the #sun-provenance chip carries while this layer is live.
 * The chip is never wrong (plan §5.1): it names the channels actually drawn,
 * says when the layer is a running difference, and says when it is present but
 * faded out by the camera rather than letting a blank sky imply a quiet Sun.
 */
export function offLimbLabel(state) {
    if (!state || !state.enabled) return '';
    const live = (state.channels || []).filter(c => c.ok).map(c => c.channel);
    if (!live.length) return state.feedDown ? ' · off-limb feed down' : ' · off-limb loading';
    const tag = live.join('+');
    if (state.axisWeight <= 0.01) return ` · off-limb ${tag} (off-axis)`;
    if (state.diff) return state.diffReady ? ` · off-limb Δ${tag}` : ` · off-limb Δ${tag} (awaiting next frame)`;
    return ` · off-limb ${tag}`;
}

// ── GLSL ───────────────────────────────────────────────────────────────────

export const OFFLIMB_VERT = /* glsl */`
    varying vec2 vPlane;          // plane-of-sky position in R☉
    void main() {
        // The ring geometry is built in its own XY plane and the mesh is
        // oriented by observerBasis(), so object-space xy IS plane-of-sky.
        vPlane = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const OFFLIMB_FRAG = /* glsl */`
    precision highp float;

    uniform sampler2D u_texA;      // 304
    uniform sampler2D u_prevA;
    uniform vec3      u_geomA;     // (cx, 1-cy, r) — the disk path's convention
    uniform float     u_onA;
    uniform float     u_refA;      // reference-shell median, linear

    uniform sampler2D u_texB;      // 131
    uniform sampler2D u_prevB;
    uniform vec3      u_geomB;
    uniform float     u_onB;
    uniform float     u_refB;

    uniform float u_diff;          // 0 = frames, 1 = running difference
    uniform float u_diffGain;
    uniform float u_gain;
    uniform float u_stretch;       // display stretch exponent (√ by default) — see the module header
    uniform float u_axis;          // offAxisWeight() — see the module header
    uniform vec4  u_radial;        // (rIn, featherIn, rOut, featherOut)
    uniform vec3  u_dimColor;      // difference-view dimming hue

    varying vec2 vPlane;

    float annulus(float rho) {
        float inW  = smoothstep(u_radial.x, u_radial.x + u_radial.y, rho);
        float outW = 1.0 - smoothstep(u_radial.z - u_radial.w, u_radial.z, rho);
        return inW * outW;
    }

    // One channel's contribution. Returns the channel's OWN colour (the browse
    // frame is already AIA-colorized and AIA-byte-scaled; we correct the level
    // and nothing else — plan honesty rule 2) in the direct view, or the
    // bipolar difference encoding when u_diff is on.
    vec3 channelAt(sampler2D tex, sampler2D prev, vec3 geom, float ref, vec2 p) {
        vec2 uv = vec2(geom.x + p.x * geom.z, geom.y + p.y * geom.z);
        // Outside the frame there is no measurement. Never clamp-extend a
        // border texel across the sky.
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
        vec3 cur = texture2D(tex, uv).rgb / max(ref, 1e-4);
        if (u_diff < 0.5) {
            // DISPLAY STRETCH (module header): the normalised field spans ~70:1
            // and no linear mapping shows both the quiet corona and a
            // prominence. Monotone, so structure and ordering are untouched.
            // Applied per channel on the LUMINANCE so the browse product's own
            // colour ratio survives it — stretching R, G and B separately
            // would desaturate every bright feature toward white.
            float L = max(dot(cur, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
            return cur * (pow(L, u_stretch) / L);
        }
        vec3 old = texture2D(prev, uv).rgb / max(ref, 1e-4);
        float d  = dot(cur - old, vec3(0.2126, 0.7152, 0.0722));
        // Same stretch, signed: a running difference spans the same decades.
        float m  = pow(abs(d), u_stretch) * u_diffGain;
        // Additive blending cannot darken, so the sign rides the hue: the
        // channel's own colour for a brightening, u_dimColor for a dimming.
        vec3 hue = normalize(max(cur, vec3(1e-3)));
        return d >= 0.0 ? hue * m : u_dimColor * m;
    }

    void main() {
        float rho = length(vPlane);
        float w = annulus(rho) * u_axis;
        if (w <= 0.001) discard;
        vec3 col = vec3(0.0);
        if (u_onA > 0.5) col += channelAt(u_texA, u_prevA, u_geomA, u_refA, vPlane);
        if (u_onB > 0.5) col += channelAt(u_texB, u_prevB, u_geomB, u_refB, vPlane);
        col *= w * u_gain;
        if (dot(col, col) < 1e-8) discard;
        gl_FragColor = vec4(col, 1.0);   // additive blending: alpha is unused
    }
`;

// ── Browser half ───────────────────────────────────────────────────────────

const DEG = Math.PI / 180;

/** Dimming hue for the running-difference view (cool blue, disclosed in the chip). */
export const DIM_COLOR = Object.freeze([0.30, 0.55, 1.00]);

/**
 * Display gains and the stretch exponent. Rendering choices, disclosed as such
 * in the chip tooltip. STRETCH_GAMMA = 0.5 is a square root — see the module
 * header for why there has to be a stretch at all.
 */
export const DEFAULT_GAIN = 0.16;
export const DEFAULT_DIFF_GAIN = 0.9;
export const STRETCH_GAMMA = 0.5;

/** The stretch, in JS — the node test pins it against the GLSL. */
export function displayStretch(v, gamma = STRETCH_GAMMA) {
    return Math.pow(Math.max(v, 0), gamma);
}

/**
 * The observed off-limb annulus as a scene object.
 *
 * @param {object} opts
 * @param {object} opts.THREE
 * @param {object} opts.scene
 * @param {string} [opts.base]      proxy base, default '/api/solar/aia'
 * @param {number} [opts.res]       1024 | 2048
 * @param {number} [opts.refreshMs] re-fetch cadence
 * @param {(state:object)=>void} [opts.onState]
 * @param {()=>number} [opts.now]   clock injection for tests
 */
export class SunOffLimb {
    constructor(opts) {
        this.THREE     = opts.THREE;
        this.scene     = opts.scene;
        this.base      = opts.base || '/api/solar/aia';
        this.res       = opts.res || 1024;
        this.refreshMs = opts.refreshMs || 5 * 60 * 1000;
        this.onState   = opts.onState || (() => {});
        this.now       = opts.now || (() => Date.now());
        this.doc       = opts.doc || (typeof document !== 'undefined' ? document : null);
        this.renderOrder = opts.renderOrder ?? 3;
        this.enabled   = false;
        this.diff      = false;
        this.frames    = new Map();       // channel → { tex, prev, observedAt, prevObservedAt, geom, ref, ok }
        this.mesh      = null;
        this.uniforms  = null;
        this.b0Rad     = 0;
        this.axisWeight = 0;
        this.state = { enabled: false, diff: false, diffReady: false, feedDown: false, channels: [], axisWeight: 0, b0Deg: 0 };
        this._timer = null;
        this._gen = 0;
    }

    /** Build the ring mesh. Idempotent. */
    mount() {
        if (this.mesh) return this.mesh;
        const T = this.THREE;
        const geo = new T.RingGeometry(R_INNER, R_OUTER, 160, 6);
        this.uniforms = {
            u_texA:   { value: null }, u_prevA: { value: null },
            u_geomA:  { value: new T.Vector3(0.5, 0.5, 0.39) }, u_onA: { value: 0 }, u_refA: { value: 1 },
            u_texB:   { value: null }, u_prevB: { value: null },
            u_geomB:  { value: new T.Vector3(0.5, 0.5, 0.39) }, u_onB: { value: 0 }, u_refB: { value: 1 },
            u_diff:      { value: 0 },
            u_diffGain:  { value: DEFAULT_DIFF_GAIN },
            u_gain:      { value: DEFAULT_GAIN },
            u_stretch:   { value: STRETCH_GAMMA },
            u_axis:      { value: 0 },
            u_radial:    { value: new T.Vector4(R_INNER, FEATHER_IN, R_OUTER, FEATHER_OUT) },
            u_dimColor:  { value: new T.Vector3(...DIM_COLOR) },
        };
        const mat = new T.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: OFFLIMB_VERT,
            fragmentShader: OFFLIMB_FRAG,
            transparent: true,
            blending: T.AdditiveBlending,
            // depthTest ON is the point: the photosphere sphere occludes the
            // far half of the plane (header, point 1). depthWrite OFF so an
            // additive layer never shadows anything drawn after it.
            depthTest: true,
            depthWrite: false,
            side: T.DoubleSide,
        });
        this.mesh = new T.Mesh(geo, mat);
        this.mesh.renderOrder = this.renderOrder;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.name = 'sun-offlimb';
        this._orient();
        this.scene?.add(this.mesh);
        return this.mesh;
    }

    /** Orient the plane so its normal is the Sun–Earth line (observerBasis). */
    _orient() {
        if (!this.mesh) return;
        const T = this.THREE;
        const b = observerBasis(this.b0Rad);
        const m = new T.Matrix4().makeBasis(
            new T.Vector3(...b.right), new T.Vector3(...b.up), new T.Vector3(...b.normal));
        this.mesh.quaternion.setFromRotationMatrix(m);
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.mesh) this.mesh.visible = this.enabled && this._anyOk();
        this._emit();
        if (this.enabled) this.refresh();
    }

    setDiff(on) {
        this.diff = !!on;
        if (this.uniforms) this.uniforms.u_diff.value = this.diff ? 1 : 0;
        this._emit();
    }

    setGain(g) { if (this.uniforms) this.uniforms.u_gain.value = Math.max(0, +g || 0); }

    start() {
        if (this._timer) return this;
        this._timer = setInterval(() => this.refresh(), this.refreshMs);
        return this;
    }

    stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

    _anyOk() { return OFFLIMB_CHANNELS.some(c => this.frames.get(c)?.ok); }

    /**
     * Per-frame. The off-axis weight is the only thing that changes with the
     * camera; the plane itself is pinned to the observer (header, point 2).
     * @param {{x:number,y:number,z:number}} cameraPosition — world, Sun at origin
     */
    update(cameraPosition) {
        if (!this.uniforms || !this.mesh) return;
        const p = cameraPosition;
        const len = Math.hypot(p.x, p.y, p.z) || 1;
        const e = observerBasis(this.b0Rad).normal;
        const cos = (p.x * e[0] + p.y * e[1] + p.z * e[2]) / len;
        const w = offAxisWeight(cos);
        if (Math.abs(w - this.axisWeight) > 1e-3) {
            this.axisWeight = w;
            this.state.axisWeight = w;
            this._emit();
        }
        this.uniforms.u_axis.value = w;
        this.mesh.visible = this.enabled && this._anyOk() && w > 0.001;
    }

    /** Fetch both channels. Each fails independently — one dead channel must not blank the other. */
    async refresh(force = false) {
        if (!this.enabled) return null;
        if (!force && this.doc && this.doc.visibilityState === 'hidden') return null;
        const gen = ++this._gen;
        const bucket = Math.floor(this.now() / this.refreshMs);
        const results = await Promise.all(OFFLIMB_CHANNELS.map(ch => this._fetchChannel(ch, bucket, force)));
        if (gen !== this._gen) return null;
        this.state.feedDown = results.every(r => !r);
        this._applyAll();
        return results;
    }

    async _fetchChannel(ch, bucket, force) {
        const prev = this.frames.get(ch);
        if (!force && prev && prev.bucket === bucket) return prev;
        const url = `${this.base}?channel=${encodeURIComponent(ch)}&res=${this.res}&b=${bucket}`;
        try {
            const res = await fetch(url, { cache: 'default' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const observedAt = parseDate(res.headers.get('X-SDO-Observed-At'))
                            ?? parseDate(res.headers.get('Last-Modified'))
                            ?? parseDate(res.headers.get('Date'));
            const blob = await res.blob();
            const img  = await decodeImage(blob);
            const read = readFrame(img);
            const geom = resolveDiskGeometry(read.measured, ch);
            const cal  = read.rgba ? calibrateOffLimb(read.rgba, read.size, read.size, geom) : { ref: 1, samples: 0, ok: false };
            const tex  = new this.THREE.Texture(img);
            tex.colorSpace = this.THREE.SRGBColorSpace;
            tex.minFilter = this.THREE.LinearFilter;   // no mips: a mipped annulus bleeds the disk across the limb
            tex.magFilter = this.THREE.LinearFilter;
            tex.wrapS = tex.wrapT = this.THREE.ClampToEdgeWrapping;
            tex.needsUpdate = true;
            const frame = {
                channel: ch, tex, observedAt, geom, ref: cal.ref, ok: cal.ok, samples: cal.samples, bucket,
                prev: prev?.tex ?? tex,
                prevObservedAt: prev?.observedAt ?? observedAt,
                error: null,
            };
            // The old previous-frame texture is now two generations back.
            if (prev && prev.prev && prev.prev !== prev.tex) { try { prev.prev.dispose(); } catch (_) {} }
            this.frames.set(ch, frame);
            return frame;
        } catch (e) {
            // Keep the last good frame; a channel that never loaded stays off.
            if (prev) { prev.error = String(e?.message || e); return prev; }
            this.frames.set(ch, { channel: ch, tex: null, ok: false, error: String(e?.message || e), bucket });
            return null;
        }
    }

    _applyAll() {
        if (!this.uniforms) return;
        const u = this.uniforms;
        const slots = [['A', OFFLIMB_CHANNELS[0]], ['B', OFFLIMB_CHANNELS[1]]];
        let b0Src = null;
        for (const [slot, ch] of slots) {
            const f = this.frames.get(ch);
            const on = !!(f && f.ok && f.tex);
            u[`u_on${slot}`].value = on ? 1 : 0;
            if (!on) continue;
            u[`u_tex${slot}`].value  = f.tex;
            u[`u_prev${slot}`].value = f.prev || f.tex;
            u[`u_geom${slot}`].value.set(f.geom.cx, 1 - f.geom.cy, f.geom.r);
            u[`u_ref${slot}`].value  = f.ref;
            if (!b0Src) b0Src = f.observedAt;
        }
        // B0 from the frame's own epoch, exactly as the disk path does.
        const eph = solarEphemeris(new Date(b0Src ?? this.now()));
        this.b0Rad = eph.b0Deg * DEG;
        this.state.b0Deg = eph.b0Deg;
        this._orient();
        if (this.mesh) this.mesh.visible = this.enabled && this._anyOk() && this.axisWeight > 0.001;
        this._emit();
    }

    _emit() {
        const channels = OFFLIMB_CHANNELS.map(ch => {
            const f = this.frames.get(ch);
            return {
                channel: ch,
                ok: !!(f && f.ok),
                observedAt: f?.observedAt ?? null,
                ref: f?.ref ?? null,
                samples: f?.samples ?? 0,
                error: f?.error ?? null,
            };
        });
        // A running difference needs two DIFFERENT observations (header).
        const diffReady = channels.some(c => {
            const f = this.frames.get(c.channel);
            return c.ok && f?.prev && f.prev !== f.tex && f.prevObservedAt !== f.observedAt;
        });
        Object.assign(this.state, {
            enabled: this.enabled, diff: this.diff, diffReady,
            channels, axisWeight: this.axisWeight,
        });
        this.state.label = offLimbLabel(this.state);
        try { this.onState(this.state); } catch (_) {}
    }

    getState() { return { ...this.state }; }

    dispose() {
        this.stop();
        if (this.mesh) {
            this.scene?.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = null;
        }
        for (const f of this.frames.values()) {
            try { f.tex?.dispose(); } catch (_) {}
            try { if (f.prev && f.prev !== f.tex) f.prev.dispose(); } catch (_) {}
        }
        this.frames.clear();
    }
}

function parseDate(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

async function decodeImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('decode failed')); img.src = url; });
        return img;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
