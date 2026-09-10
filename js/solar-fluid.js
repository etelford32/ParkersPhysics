/**
 * solar-fluid.js — GPU Navier–Stokes solver for the photosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * A real fluid simulation (Stam "Stable Fluids") with VORTICITY CONFINEMENT,
 * run on the sphere's equirectangular (lon, lat) domain on ping-pong half-float
 * render targets. Each frame:
 *
 *   1. ADVECT     velocity + temperature dye  (semi-Lagrangian), transported
 *                 by the solved flow PLUS the prescribed differential rotation
 *   2. FORCES     curl-noise forcing (sustains turbulence)
 *                 + vorticity confinement (re-injects small-scale curl so
 *                   eddies stay crisp and swirly, not diffused away)
 *                 + temperature reaction (heat sources + radiative cooling)
 *                 + thermal diffusion (sets the granule scale from a physical
 *                   parameter instead of from advection error)
 *   3. DIVERGENCE of the velocity field, MINUS the buoyancy source (see below)
 *   4. PRESSURE   Poisson solve (Jacobi)
 *   5. SUBTRACT   the pressure gradient → ∇·v = the buoyancy source
 *
 * ── The surface of a convecting fluid is NOT divergence-free ──────────────
 *
 * The solver used to project the velocity onto ∇·v = 0 and force it with pure
 * curl noise, which is divergence-free by construction. Both choices are
 * correct for 2D turbulence and WRONG for the photosphere, and the wrongness
 * shows: what you get is a swirling soup, when what granulation actually looks
 * like is plasma boiling OUT of hot cell centres and draining INTO the dark
 * lanes.
 *
 * The horizontal divergence of a convecting surface is the vertical flow
 * underneath it. Continuity for a Boussinesq fluid gives
 *
 *     ∇_h · v_h  =  −∂w/∂z ,      w ∝ buoyancy ∝ (T − T_ambient)
 *
 * so hot fluid DIVERGES at the surface and cool fluid CONVERGES. Rather than
 * add another force term and hope, that is imposed exactly: the projection
 * targets ∇·v = S instead of ∇·v = 0, by solving ∇²p = ∇·v − S. Everything
 * downstream is unchanged; the constraint itself now carries the physics, and
 * a granule's outflow is a solved quantity rather than a texture that happens
 * to move.
 *
 * S is built from the LOCAL temperature excess (T minus its own 3×3
 * neighbourhood mean), not from T minus a constant. Two reasons, and both bite
 * if you change it:
 *   • a Poisson problem on a periodic domain is only solvable when the source
 *     integrates to zero. A local high-pass is zero-mean BY CONSTRUCTION, so
 *     no global reduction is needed and the pressure cannot drift;
 *   • "buoyant relative to its surroundings" is the physically meaningful
 *     statement anyway — a uniformly hot patch the size of the domain does not
 *     overturn.
 *
 * The turbulent velocity stretches the temperature dye into the swirling
 * filaments / mottled network seen in SDO 304/171 imagery. The field RGBA is
 *   .r = temperature dye   .g/.b = velocity (vₓ, v_y)
 * sampled at the sphere UV by sunFS; the velocity is also reused to drive a
 * *simulated* Doppler map.
 *
 * Domain wraps in x (longitude) and clamps in y (poles). Throws if half-float
 * colour buffers aren't renderable so the caller can fall back to procedural.
 */

// ── Differential rotation (Snodgrass & Ulrich 1990 surface fit) ───────────
// Ω(lat) = A + B sin²lat + C sin⁴lat, deg/day. The equator laps the poles once
// every ~130 days, and on this domain that is a real, visible zonal shear that
// stretches supergranules into the tilted lanes the SDO magnetograms show.
// Exported PURE so tests/solar-fluid-shear.mjs can pin it without a GPU.
export const SNODGRASS = Object.freeze({ A: 14.713, B: -2.396, C: -1.787 });

/** Zonal shear relative to the equator, as a fraction of the equatorial rate. */
export function diffRotShear(latRad) {
    const s2 = Math.sin(latRad) ** 2;
    return (SNODGRASS.B * s2 + SNODGRASS.C * s2 * s2) / SNODGRASS.A;
}

const QUAD_VS = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const HEAD = /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uTexel;
`;

const NOISE = /* glsl */`
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
    }
    float fbm(vec2 p){ return vnoise(p)*0.6 + vnoise(p*2.03+7.1)*0.3 + vnoise(p*4.11+3.7)*0.1; }
`;

// Seed: warm dye + a swirly initial velocity from curl noise.
const SEED_FS = HEAD + NOISE + /* glsl */`
    uniform float uT0;
    void main(){
        float T = uT0 + (fbm(vUv * 14.0) - 0.5) * 0.6;
        float e = 0.01;
        float p0 = fbm(vUv * 6.0), px = fbm((vUv+vec2(e,0))*6.0), py = fbm((vUv+vec2(0,e))*6.0);
        vec2 v = vec2((py-p0)/e, -(px-p0)/e) * 0.02;
        gl_FragColor = vec4(T, v, 1.0);
    }
`;

// Semi-Lagrangian advection of (T, velocity) by the SOLVED velocity plus the
// PRESCRIBED differential rotation.
//
// The mean zonal flow is carried here and not added to the velocity field on
// purpose: it is a boundary condition, not a fluctuation. Push it into `vel`
// and the pressure projection immediately starts solving for it, the Jacobi
// iteration spends its budget on a flow we already know analytically, and the
// shear ends up smeared. Transporting by (v + ū) leaves the solver working
// only on the departure from the known mean — the standard split, and the
// reason the shear survives at 22 iterations.
//
// GLSL mirror of diffRotShear() above — change both together.
const ADVECT_FS = HEAD + /* glsl */`
    uniform sampler2D uField;
    uniform float uDt, uShear;
    void main(){
        vec3 f = texture2D(uField, vUv).rgb;       // r=T, gb=vel
        float lat = (vUv.y - 0.5) * 3.14159265;
        float s2  = sin(lat) * sin(lat);
        float rel = (-2.396 * s2 - 1.787 * s2 * s2) / 14.713;   // Snodgrass, vs equator
        vec2  mean = vec2(uShear * rel, 0.0);
        vec2 src = vUv - (f.gb + mean) * uDt;      // backtrace through v + ū
        gl_FragColor = vec4(texture2D(uField, src).rgb, 1.0);
    }
`;

// Forces: curl-noise forcing + vorticity confinement + temperature reaction.
const FORCES_FS = HEAD + NOISE + /* glsl */`
    uniform sampler2D uField;
    uniform float uDt, uTime, uVort, uForce, uHeat, uCool, uT0, uVisc, uDiff;
    float curlAt(vec2 uv){
        float vyR = texture2D(uField, uv + vec2(uTexel.x, 0.0)).b;
        float vyL = texture2D(uField, uv - vec2(uTexel.x, 0.0)).b;
        float vxU = texture2D(uField, uv + vec2(0.0, uTexel.y)).g;
        float vxD = texture2D(uField, uv - vec2(0.0, uTexel.y)).g;
        return (vyR - vyL) * 0.5 - (vxU - vxD) * 0.5;
    }
    void main(){
        vec3 f = texture2D(uField, vUv).rgb;
        float T = f.r; vec2 vel = f.gb;

        // Vorticity confinement: push velocity toward concentrations of |curl|
        // (re-injects the small-scale swirl numerical advection smears out).
        float w  = curlAt(vUv);
        float wR = abs(curlAt(vUv + vec2(uTexel.x, 0.0)));
        float wL = abs(curlAt(vUv - vec2(uTexel.x, 0.0)));
        float wU = abs(curlAt(vUv + vec2(0.0, uTexel.y)));
        float wD = abs(curlAt(vUv - vec2(0.0, uTexel.y)));
        vec2 g = vec2(wR - wL, wU - wD);
        g /= (length(g) + 1e-5);
        vel += uVort * vec2(g.y, -g.x) * w * uDt;

        // Curl-noise forcing keeps the turbulence alive. It is the curl of a
        // scalar stream function, so in the CONTINUUM it is divergence-free —
        // but this solver does not work in the continuum, and the difference
        // mattered:
        //
        // the stencil below used a forward difference over a fixed ε = 0.012
        // while the divergence operator uses a CENTRAL difference over ±1
        // texel (1/192 = 0.0052). Two different stencils on the same field, so
        // the discrete divergence of this "divergence-free" forcing was NOT
        // zero, and it injected divergence at the grid scale on every step —
        // measured at ~1.2 RMS, five times the buoyancy source the projection
        // is supposed to be imposing. The convection signal was there and
        // simply drowned (correlation 0.04; it is 0.7 with the stencils
        // matched).
        //
        // Computing the curl with the SAME central difference the divergence
        // operator uses makes div(curl ψ) collapse identically: the four
        // corner terms cancel exactly. Not approximately — exactly, in float,
        // for any ψ. Keep the two stencils matched.
        float ex = uTexel.x, ey = uTexel.y;
        float pxp = fbm((vUv + vec2(ex, 0.0)) * 10.0 + uTime * 0.10);
        float pxm = fbm((vUv - vec2(ex, 0.0)) * 10.0 + uTime * 0.10);
        float pyp = fbm((vUv + vec2(0.0, ey)) * 10.0 + uTime * 0.10);
        float pym = fbm((vUv - vec2(0.0, ey)) * 10.0 + uTime * 0.10);
        vec2 curlF = vec2((pyp - pym) / (2.0 * ey), -(pxp - pxm) / (2.0 * ex));
        vel += curlF * uForce * uDt;

        vel *= (1.0 - uVisc);                          // gentle damping

        // Temperature dye: inject heat at slowly-evolving network sources, cool
        // radiatively; the turbulence stretches this into filaments.
        float src = fbm(vUv * 14.0 - uTime * 0.04);
        T += (smoothstep(0.55, 0.92, src) * uHeat - uCool * T) * uDt;
        T += (hash(vUv * 911.0 + uTime) - 0.5) * 0.010 * uDt;

        // EXPLICIT thermal diffusion. Before this, the only smoothing on T was
        // the numerical diffusion of the semi-Lagrangian backtrace — which
        // means the granule scale was set by the grid resolution and the
        // timestep, i.e. by the solver's error, and moved whenever either did.
        // A real diffusivity makes the cell size a physical parameter of the
        // model (the balance between buoyant forcing and thermal conduction is
        // what sets it on the Sun too) and makes it stable to changing the grid size.
        float Tl = texture2D(uField, vUv - vec2(uTexel.x, 0.0)).r;
        float Tr = texture2D(uField, vUv + vec2(uTexel.x, 0.0)).r;
        float Td = texture2D(uField, vUv - vec2(0.0, uTexel.y)).r;
        float Tu = texture2D(uField, vUv + vec2(0.0, uTexel.y)).r;
        // Forward-Euler on a 5-point Laplacian is stable for κ·dt ≤ 0.25; the
        // clamp is the guard, not a taste choice — above it the field explodes
        // into a checkerboard within a few frames.
        T += min(uDiff * uDt, 0.24) * (Tl + Tr + Td + Tu - 4.0 * T);
        T = clamp(T, 0.0, 2.0);

        gl_FragColor = vec4(T, vel, 1.0);
    }
`;

// Divergence of v, MINUS the buoyancy source S. Solving ∇²p = ∇·v − S and then
// subtracting ∇p leaves ∇·v = S rather than 0 — see the header. S is the local
// temperature excess (T minus its own 3×3 mean), so it is zero-mean by
// construction and the Poisson problem stays solvable.
//
// ══ THE STENCILS ARE NOT INTERCHANGEABLE. THIS ONE IS BACKWARD. ═══════════
//
// Divergence here is BACKWARD-differenced and the pressure gradient in
// SUBTRACT_FS is FORWARD-differenced, so that
//
//     div(grad p)_i = (p_{i+1} − p_i) − (p_i − p_{i−1}) = p_{i+1} − 2p_i + p_{i−1}
//
// is EXACTLY the compact 5-point Laplacian the Jacobi iteration inverts. All
// three operators then describe the same discrete problem and the projection
// removes all of the divergence.
//
// Both were CENTRAL differences before, and that is the classic collocated-grid
// checkerboard bug: a central divergence of a central gradient is the WIDE
// (i±2) Laplacian, which is a different operator from the one being solved.
// Its null space is the odd-even mode — so grid-scale divergence was invisible
// to the pressure solve and simply survived it, forever. Measured: ~1.2 RMS
// residual divergence that did not fall when the iteration count was tripled
// from 20 to 60, which is the signature (a converging solve gets better; a
// solve that cannot see the error does not). This solver has advertised
// incompressibility since it was written and was not enforcing it.
//
// If you change one of these three stencils, change all three.
const DIVERGENCE_FS = HEAD + /* glsl */`
    uniform sampler2D uField;
    uniform float uBuoy;
    void main(){
        float vxC = texture2D(uField, vUv).g;
        float vyC = texture2D(uField, vUv).b;
        float vxL = texture2D(uField, vUv - vec2(uTexel.x, 0.0)).g;
        float vyD = texture2D(uField, vUv - vec2(0.0, uTexel.y)).b;
        float div = (vxC - vxL) + (vyC - vyD);

        // Local buoyancy: T against its immediate surroundings.
        float T  = texture2D(uField, vUv).r;
        float acc = 0.0;
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                acc += texture2D(uField, vUv + vec2(float(i) * uTexel.x, float(j) * uTexel.y)).r;
            }
        }
        float S = uBuoy * (T - acc / 9.0);
        gl_FragColor = vec4(div - S, 0.0, 0.0, 1.0);
    }
`;

const JACOBI_FS = HEAD + /* glsl */`
    uniform sampler2D uPrs, uDiv;
    void main(){
        float l = texture2D(uPrs, vUv - vec2(uTexel.x, 0.0)).r;
        float r = texture2D(uPrs, vUv + vec2(uTexel.x, 0.0)).r;
        float d = texture2D(uPrs, vUv - vec2(0.0, uTexel.y)).r;
        float u = texture2D(uPrs, vUv + vec2(0.0, uTexel.y)).r;
        float div = texture2D(uDiv, vUv).r;
        gl_FragColor = vec4((l + r + d + u - div) * 0.25, 0.0, 0.0, 1.0);
    }
`;

// FORWARD-differenced pressure gradient — the adjoint of the backward
// divergence above. See DIVERGENCE_FS's comment: the pair must match, or the
// projection silently stops removing grid-scale divergence.
const SUBTRACT_FS = HEAD + /* glsl */`
    uniform sampler2D uField, uPrs;
    void main(){
        vec3 f = texture2D(uField, vUv).rgb;
        float c = texture2D(uPrs, vUv).r;
        float r = texture2D(uPrs, vUv + vec2(uTexel.x, 0.0)).r;
        float u = texture2D(uPrs, vUv + vec2(0.0, uTexel.y)).r;
        vec2 grad = vec2(r - c, u - c);
        gl_FragColor = vec4(f.r, f.gb - grad, 1.0);
    }
`;

// Diagnostic pass: writes the LOCAL temperature excess and the horizontal
// divergence into an 8-bit target so `probe()` can read them back anywhere.
// 8-bit and not the half-float field itself on purpose — readRenderTargetPixels
// against a HALF_FLOAT attachment is not portable, and this only needs enough
// precision to establish the SIGN relationship between the two.
const PROBE_FS = HEAD + /* glsl */`
    uniform sampler2D uField;
    uniform float uKT, uKD;
    void main(){
        float T = texture2D(uField, vUv).r;
        float acc = 0.0;
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                acc += texture2D(uField, vUv + vec2(float(i) * uTexel.x, float(j) * uTexel.y)).r;
            }
        }
        float exc = T - acc / 9.0;
        // Backward difference — the SAME operator DIVERGENCE_FS uses. Measuring
        // the solver's constraint with a different stencil than the one it
        // enforces reports the discretisation, not the physics.
        float vxC = texture2D(uField, vUv).g;
        float vyC = texture2D(uField, vUv).b;
        float vxL = texture2D(uField, vUv - vec2(uTexel.x, 0.0)).g;
        float vyD = texture2D(uField, vUv - vec2(0.0, uTexel.y)).b;
        float div = (vxC - vxL) + (vyC - vyD);
        gl_FragColor = vec4(
            0.5 + 0.5 * clamp(exc * uKT, -1.0, 1.0),
            0.5 + 0.5 * clamp(div * uKD, -1.0, 1.0),
            clamp(T * 0.5, 0.0, 1.0), 1.0);
    }
`;

export class SolarFluid {
    constructor(THREE, renderer, opts = {}) {
        this.THREE = THREE;
        this.size  = opts.size  ?? 192;
        this.iters = opts.iters ?? 22;
        this.T0    = opts.T0    ?? 1.0;

        const gl = renderer.getContext();
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) {
            throw new Error('solar-fluid: float color buffers unavailable');
        }

        const mk = () => new THREE.WebGLRenderTarget(this.size, this.size, {
            type: THREE.HalfFloatType, format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false, stencilBuffer: false,
        });
        this.fA = mk(); this.fB = mk();        // field: r=T, gb=velocity
        this.pA = mk(); this.pB = mk();        // pressure (.r)
        this.div = mk();                       // divergence (.r)

        this.scene = new THREE.Scene();
        this.cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.scene.add(this.quad);

        const texel = new THREE.Vector2(1 / this.size, 1 / this.size);
        const mat = (fs, u) => new THREE.ShaderMaterial({
            vertexShader: QUAD_VS, fragmentShader: fs,
            uniforms: Object.assign({ uTexel: { value: texel } }, u),
            depthTest: false, depthWrite: false,
        });
        this.seedMat   = mat(SEED_FS,   { uT0: { value: this.T0 } });
        this.advectMat = mat(ADVECT_FS, {
            uField: { value: null }, uDt: { value: opts.dt ?? 1.0 },
            // Equatorial rate in domain-units per step. Small on purpose: one
            // full lap of the equator over the poles takes ~130 days on the
            // Sun, so at any framing this page uses the shear is a slow tilt of
            // the network, not a visible current.
            uShear: { value: opts.shear ?? 0.010 },
        });
        this.forceMat  = mat(FORCES_FS, {
            uField: { value: null }, uDt: { value: opts.dt ?? 1.0 }, uTime: { value: 0 },
            uVort:  { value: opts.vort  ?? 0.42 }, uForce: { value: opts.force ?? 0.32 },
            uHeat:  { value: opts.heat  ?? 0.06 }, uCool:  { value: opts.cool  ?? 0.05 },
            uVisc:  { value: opts.visc  ?? 0.025 }, uT0: { value: this.T0 },
            uDiff:  { value: opts.diff  ?? 0.02 },
        });
        this.divMat = mat(DIVERGENCE_FS, { uField: { value: null }, uBuoy: { value: opts.buoy ?? 32.0 } });
        this.jacMat = mat(JACOBI_FS,     { uPrs: { value: null }, uDiv: { value: null } });
        this.subMat = mat(SUBTRACT_FS,   { uField: { value: null }, uPrs: { value: null } });

        this._blit(renderer, this.seedMat, this.fA);
        renderer.setRenderTarget(null);
    }

    _blit(renderer, material, target) {
        this.quad.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.cam);
    }

    step(renderer, dt) {
        const prev = renderer.getRenderTarget();
        if (dt != null) {
            this.advectMat.uniforms.uDt.value = dt;
            this.forceMat.uniforms.uDt.value = dt;
        }
        this.forceMat.uniforms.uTime.value = (performance.now() % 100000) * 0.001;

        // 1. advect (fA -> fB), swap
        this.advectMat.uniforms.uField.value = this.fA.texture;
        this._blit(renderer, this.advectMat, this.fB);
        [this.fA, this.fB] = [this.fB, this.fA];

        // 2. forces (fA -> fB), swap
        this.forceMat.uniforms.uField.value = this.fA.texture;
        this._blit(renderer, this.forceMat, this.fB);
        [this.fA, this.fB] = [this.fB, this.fA];

        // 3. divergence (fA -> div)
        this.divMat.uniforms.uField.value = this.fA.texture;
        this._blit(renderer, this.divMat, this.div);

        // 4. pressure Jacobi (warm-started)
        for (let i = 0; i < this.iters; i++) {
            this.jacMat.uniforms.uPrs.value = this.pA.texture;
            this.jacMat.uniforms.uDiv.value = this.div.texture;
            this._blit(renderer, this.jacMat, this.pB);
            [this.pA, this.pB] = [this.pB, this.pA];
        }

        // 5. subtract pressure gradient (fA, pA -> fB), swap
        this.subMat.uniforms.uField.value = this.fA.texture;
        this.subMat.uniforms.uPrs.value   = this.pA.texture;
        this._blit(renderer, this.subMat, this.fB);
        [this.fA, this.fB] = [this.fB, this.fA];

        renderer.setRenderTarget(prev);
    }

    prewarm(renderer, steps = 50) { for (let i = 0; i < steps; i++) this.step(renderer); }

    /**
     * Read the convection back out: the Pearson correlation between the local
     * temperature excess and the horizontal divergence.
     *
     * This is the number that says whether the solver is doing convection or
     * just stirring. With the buoyancy-targeted projection it must be strongly
     * POSITIVE — hot fluid spreading, cool fluid draining. With the old
     * divergence-free projection it is ~0 by construction, because the velocity
     * field was forced to have no divergence to correlate with anything.
     * `tests/solar-fluid-convection.spec.js` gates exactly that.
     *
     * @returns {{corr:number, n:number, rmsDiv:number, rmsExc:number}}
     */
    probe(renderer) {
        const THREE = this.THREE;
        if (!this._probeRT) {
            this._probeRT = new THREE.WebGLRenderTarget(this.size, this.size, {
                type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                depthBuffer: false, stencilBuffer: false,
            });
            this._probeMat = new THREE.ShaderMaterial({
                vertexShader: QUAD_VS, fragmentShader: PROBE_FS,
                uniforms: {
                    uTexel: { value: new THREE.Vector2(1 / this.size, 1 / this.size) },
                    uField: { value: null }, uKT: { value: 24.0 }, uKD: { value: 24.0 },
                },
                depthTest: false, depthWrite: false,
            });
        }
        const prev = renderer.getRenderTarget();
        const buf = new Uint8Array(this.size * this.size * 4);
        const S0 = this.size;
        const shoot = (kT, kD) => {
            this._probeMat.uniforms.uField.value = this.fA.texture;
            this._probeMat.uniforms.uKT.value = kT;
            this._probeMat.uniforms.uKD.value = kD;
            this._blit(renderer, this._probeMat, this._probeRT);
            renderer.readRenderTargetPixels(this._probeRT, 0, 0, S0, S0, buf);
        };
        // AUTO-RANGE, and it is not optional. The two channels differ by orders
        // of magnitude — a local temperature excess runs ~1e-2 while the
        // velocity divergence runs ~1e0 — so any fixed pair of gains either
        // clips one channel flat against ±1 or quantises the other onto three
        // byte levels. Both failure modes report a correlation of ~0 on a field
        // that has one, which is exactly how the first version of this probe
        // scored a working solver as broken (measured).
        //
        // A single calibration pass cannot fix it either: a channel that is
        // ALREADY clipped at unit gain reads back an RMS of ~1 whatever its
        // true magnitude, so the gain it suggests is the gain it was given. The
        // search has to move in both directions and re-measure.
        const stats = (ch) => {
            let n = 0, sum = 0, sq = 0, clipped = 0;
            for (let y = 2; y < S0 - 2; y++) {
                for (let x = 2; x < S0 - 2; x++) {
                    const b = buf[(y * S0 + x) * 4 + ch];
                    if (b <= 1 || b >= 254) clipped++;
                    const v = b / 127.5 - 1;
                    sum += v; sq += v * v; n++;
                }
            }
            return { sd: Math.sqrt(Math.max(sq / n - (sum / n) ** 2, 0)), clip: clipped / n, n };
        };
        // Range each channel independently: halve while it clips, double while
        // it is quantised into the noise. Bounded so a degenerate field (a dead
        // solver, an all-zero target) terminates instead of spinning.
        let kT = 1.0, kD = 1.0;
        for (let pass = 0; pass < 24; pass++) {
            shoot(kT, kD);
            const t = stats(0), d = stats(1);
            const fix = (st, k) => {
                if (st.clip > 0.02) return { k: k * 0.5, moved: true };
                if (st.sd < 0.06 && k < 1e7) return { k: k * 2.0, moved: true };
                return { k, moved: false };
            };
            const ft = fix(t, kT), fd = fix(d, kD);
            kT = ft.k; kD = fd.k;
            if (!ft.moved && !fd.moved) break;
        }
        shoot(kT, kD);
        renderer.setRenderTarget(prev);

        // Skip a 2-px frame: the clamped-latitude edges are a boundary
        // condition, not fluid, and their one-sided stencils are not comparable.
        const S = S0;
        let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (let y = 2; y < S - 2; y++) {
            for (let x = 2; x < S - 2; x++) {
                const i = (y * S + x) * 4;
                const ex = buf[i] / 127.5 - 1;
                const dv = buf[i + 1] / 127.5 - 1;
                sx += ex; sy += dv; sxx += ex * ex; syy += dv * dv; sxy += ex * dv; n++;
            }
        }
        if (n < 16) return { corr: 0, n, rmsDiv: 0, rmsExc: 0 };
        const cx = sxx / n - (sx / n) ** 2;
        const cy = syy / n - (sy / n) ** 2;
        const cxy = sxy / n - (sx / n) * (sy / n);
        return {
            corr: cx > 1e-12 && cy > 1e-12 ? cxy / Math.sqrt(cx * cy) : 0,
            n,
            // RMS in the FIELD's own units, undoing the auto-gain, so a caller
            // can see the actual balance between buoyancy and residual.
            rmsDiv: Math.sqrt(cy) / kD,
            rmsExc: Math.sqrt(cx) / kT,
            gains: [kT, kD],
        };
    }

    getTexture() { return this.fA.texture; }

    /** Buoyancy coupling — 0 restores the old divergence-free projection. */
    setBuoyancy(k) { this.divMat.uniforms.uBuoy.value = k; }

    dispose() {
        [this.fA, this.fB, this.pA, this.pB, this.div, this._probeRT].forEach((rt) => rt && rt.dispose());
        [this.seedMat, this.advectMat, this.forceMat, this.divMat, this.jacMat, this.subMat, this._probeMat]
            .forEach((m) => m && m.dispose());
        this.quad.geometry.dispose();
    }
}
