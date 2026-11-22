/**
 * flare-arcade.js — the 3D post-flare ARCADE and eruptive PLUME.
 * ═══════════════════════════════════════════════════════════════════════════
 * The flare geometry that extends off the disk into space: an arcade of
 * reconnected loops straddling the polarity-inversion line at the flare
 * site, and a jet of ejecta leaving along the site's radial. Both are
 * DRAWN FROM KERNEL NUMBERS ONLY — `js/flare-geometry.js` decides where the
 * site is, how the PIL is oriented, how far the feet sit apart, how high
 * the apex is, how sheared the arcade is, and how far the plume has risen
 * at a given time since onset. This module owns no physics; it owns
 * buffers, materials and a canvas dot texture.
 *
 * Consumers: sun.html (sun radius 1, full-size), solar-system.html (sun
 * radius 1.5, `heightScale` < 1 so it reads but does not dominate). The
 * caller parents `group` and ROTATES it with the site's own differential
 * rate (`siteRotation(eqAngle, latRad)` on sun.html; the sun frame on the
 * orrery) — every position here is in the site's EPOCH frame.
 *
 * The PIL is a PRIOR (Joy's law) unless `pairs` — the field atlas's real
 * conjugate footpoints from js/flare-ribbons.js — are supplied; `state.pil`
 * says which, so a HUD can disclose it.
 *
 * ── Two ways to draw a loop ──────────────────────────────────────────────
 * `style: 'line'` (the default, and what the orrery uses — its Sun is ~30 px
 * across) draws each loop as a 1 px additive `THREE.Line`. On sun.html, where
 * the arcade can fill a third of the frame, eleven hairlines seen obliquely
 * read as a coiled spring, not as plasma. `style: 'ribbon'` draws each loop as
 * a camera-facing ribbon with the PHYSICAL strand width (`strandMm`, a
 * post-flare loop strand is ~1–2 Mm across) and a pixel FLOOR — below it the
 * strand is dimmed in proportion, so a sub-pixel loop keeps its energy
 * instead of fattening (the NEO-sprite rule). The cross profile is a soft
 * tube, the along-loop profile follows the phase the kernel reports (looptop
 * source while hot, legs once it cools), and the colour is written ABOVE 1.0
 * so sun.html's HDR chain blooms it. It is a `MeshBasicMaterial` with the
 * projection and two fragment lines replaced (`onBeforeCompile`), never a raw
 * shader — the js/screen-line.js construction, for the same reason.
 * Positions, heights, shear and timing are the kernel's in BOTH styles.
 *
 * In 'ribbon' style (and with no atlas pairs) the loops are the kernel's
 * NESTED arcade, `arcadeShells`: every generation of loops at once, newest and
 * outermost last. Each loop is coloured and dimmed by ITS OWN age — hot
 * (131 Å teal) when it has just formed, cooling to 171 Å gold, then fading as
 * it leaves the EUV bands — so the arcade has a hot outer edge over a cooler
 * interior and lights up along the inversion line from its centre, instead of
 * being one generation of identical loops in one colour that fades as a block.
 * A loop's mesh is keyed by (station, generation), so a formed loop keeps its
 * strand from frame to frame.
 *
 * HOT LOOPS ARE FUZZY, COOL LOOPS ARE CRISP (ribbon style). A loop that has
 * just been filled is drawn HOT_FUZZ times wider and that much fainter, and
 * sharpens to the physical strand as it cools: the width × brightness of a
 * strand — its light per unit length — never changes. This is how flare
 * arcades look (soft in 131 / 94 Å, threaded in 171 Å), and it is what stops
 * a young arcade reading as a comb of identical hairlines.
 *
 * PLASMA MOVES ALONG THE STRANDS. A strand's brightness is multiplied by the
 * kernel's `strandFlowGain` (js/flare-geometry.js — ONE function in JS and in
 * GLSL; this file interpolates the GLSL and never retypes it), driven per
 * strand by `u_flow` = (mode, p1, p2, p3) and `u_flowK`: a new loop FILLS from
 * its feet (evaporation, a brighter front at the edge), a cooled loop RAINS
 * (clumps running down both legs). The numbers are the kernel's `loopFlow` for
 * the loop's own age and length; with mode 0 the gain is exactly 1.
 *
 * THE ARCADE HAS ITS OWN EXPOSURE CONTROL (`arcadeExposure`, PURE). Strands
 * ADD, so an arcade seen from close, or along its loops, piles tens of
 * strands on each pixel and the whole thing clips to flat white — colour
 * (temperature) and structure gone. Real EUV imagers shorten their exposure
 * on a flare for exactly this reason (SDO/AIA's automatic exposure control).
 * Each frame the view adds up the light its loops will put on screen, divides
 * by the screen area they cover, and — only when that mean is above
 * AEC_TARGET — turns the arcade's gain down to hold it there (never below
 * AEC_FLOOR, never up). `state.exposure` says what it did; a flare seen from
 * the hero distance is untouched (exposure 1).
 *
 * Node-gated through the kernel (tests/flare-geometry.mjs); browser gates
 * tests/sun-flare-geometry.spec.js and tests/solar-system-flare.spec.js
 * assert the drawn loops and plume against the kernel's own answers.
 */

const LOOP_SAMPLES = 24;
const RIBBON_SAMPLES = 48;
const RSUN_MM = 695.7;
/** A ribbon quad is this many strand half-widths wide: strand core + diffuse halo. */
const HALO_K = 4;
/** A just-formed (hot) loop is drawn this many times wider — and that much fainter — than a cooled one. */
export const HOT_FUZZ = 2.4;
/**
 * The light one strand puts on screen per pixel of its length, per pixel of its HALF-width, at opacity 1
 * and gain 1: the integral of the strand shader's cross-profile (core 2.35 + halo 0.53 half-widths) times
 * its mean along-loop factor (0.84). Used only by the exposure control's estimate.
 */
export const STRAND_LIGHT = 2.4;
/** The exposure control holds the arcade's mean on-screen stacking at this (HDR units; 1 = display white). */
export const AEC_TARGET = 0.45;
/** …and never turns the gain below this fraction. */
export const AEC_FLOOR = 0.12;
/** The share of the loops' screen bounding box that an arcade actually covers (a half-cylinder seen obliquely). */
export const AEC_FILL = 0.6;

/**
 * PURE. The arcade's mean stacking on screen, and the exposure that keeps it in range.
 * @param {Array<{opacity:number, lenPx:number, halfPx:number, x0:number, x1:number, y0:number, y1:number}>} items
 *        one per drawn loop: its opacity, projected length and strand half-width (px) and screen bounds (px)
 * @param {object} [o]
 * @param {number} [o.gain=1]    the HDR gain the loops are drawn at when exposure is 1
 * @returns {{stack:number, exposure:number, light:number, areaPx:number}}
 *          stack = mean HDR level over the covered area at exposure 1; exposure ∈ [floor, 1]
 */
export function arcadeExposure(items, { gain = 1, target = AEC_TARGET, floor = AEC_FLOOR, fill = AEC_FILL } = {}) {
    let light = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    for (const it of items) {
        if (!(it.opacity > 0) || !(it.lenPx > 0)) continue;
        light += it.opacity * it.lenPx * it.halfPx * STRAND_LIGHT * gain;
        if (it.x0 < x0) x0 = it.x0; if (it.x1 > x1) x1 = it.x1; if (it.y0 < y0) y0 = it.y0; if (it.y1 > y1) y1 = it.y1;
        n++;
    }
    if (!n) return { stack: 0, exposure: 1, light: 0, areaPx: 0 };
    // A box at least one strand across: loops seen exactly edge-on have no width of their own.
    const areaPx = Math.max((x1 - x0), 2) * Math.max((y1 - y0), 2) * fill;
    const stack = light / areaPx;
    return { stack, exposure: stack > target ? Math.max(floor, target / stack) : 1, light, areaPx };
}

/** Shared uniforms + material factory for `style: 'ribbon'`. */
export function ribbonKit(THREE, { strandMm, minPx, gain, R, hotFuzz = 1, flowGlsl = '' }) {
    const uniforms = {
        u_viewport:  { value: new THREE.Vector2(1280, 720) },    // drawing buffer, device px
        u_dpr:       { value: 1 },
        u_halfW:     { value: 0.5 * (strandMm / RSUN_MM) * R },  // world half-width of one strand
        u_minHalfPx: { value: 0.5 * minPx },
        u_tanStep:   { value: 0.004 * R },
        u_gain:      { value: gain },
        u_cool:      { value: 0 },                               // 0 hot (looptop source) → 1 cooled (legs)
    };
    const size = new THREE.Vector2();
    const onBeforeRender = (renderer) => {
        renderer.getDrawingBufferSize(size);
        uniforms.u_viewport.value.copy(size);
        uniforms.u_dpr.value = renderer.getPixelRatio();
    };
    function material() {
        const m = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        // u_cool is PER LOOP (each has its own age); everything else is shared.
        const own = { u_cool: { value: 0 }, u_flow: { value: new THREE.Vector4(0, 2, 0, 0) }, u_flowK: { value: 1 } };
        m.userData.cool = own.u_cool;
        m.userData.flow = own.u_flow;       // (mode, p1, p2, p3) — the kernel's strandFlowGain arguments
        m.userData.flowK = own.u_flowK;
        m.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms, own);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>
    attribute vec3 aTangent;
    attribute float aSide;
    attribute float aArc;
    attribute float aTurn;
    varying float vTurn;
    uniform vec2 u_viewport;
    uniform float u_dpr;
    uniform float u_halfW;
    uniform float u_minHalfPx;
    uniform float u_tanStep;
    uniform float u_cool;
    varying float vSide;
    varying float vArc;
    varying float vFloor;
    varying float vFuzz;
    varying float vEndOn;`)
                .replace('#include <project_vertex>', `
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    vec4 clipA = projectionMatrix * mvPosition;
    vec4 clipB = projectionMatrix * (modelViewMatrix * vec4(transformed + aTangent * u_tanStep, 1.0));
    float wA = max(abs(clipA.w), 1e-5);
    vec2 sA = clipA.xy / wA * u_viewport;
    vec2 sB = clipB.xy / max(abs(clipB.w), 1e-5) * u_viewport;
    vec2 dir = sB - sA;
    dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // TRUE projected half-width of the strand, device px, with a pixel floor.
    // Hot plasma is fuzzy: a hot strand is drawn wider and (fragment) that much fainter.
    vFuzz = mix(${hotFuzz.toFixed(2)}, 1.0, clamp(u_cool, 0.0, 1.0));
    float truePx  = u_halfW * vFuzz * projectionMatrix[1][1] * u_viewport.y * 0.5 / wA;
    float floorPx = u_minHalfPx * u_dpr;
    // The quad is HALO_K strand-widths wide: the strand is its core and the
    // rest is the diffuse emission of the unresolved threads around it.
    float halfPx  = max(truePx, floorPx) * ${HALO_K.toFixed(1)};
    // Below the floor the ribbon is wider than the strand: dim it by the
    // ratio so the strand's energy, not its drawn width, is what is kept.
    vFloor = clamp(truePx / floorPx, 0.0, 1.0);
    vTurn = aTurn;
    // A STRAND POINTING AT THE CAMERA HAS NO DIRECTION ON SCREEN. A ribbon is offset across its projected
    // tangent; where the strand runs along the line of sight (the top of a loop seen in its own plane) that
    // tangent is a few sub-pixels of noise, and the quad there is a short, wide, hard-ended block in an
    // arbitrary orientation — every looptop of an arcade seen along its loops drew as a little square with
    // a hole in it (measured at the limb). Foreshortening = projected length of the tangent step ÷ its
    // length face-on; the strand fades out below ~0.4 of it rather than draw the block.
    float facePx = u_tanStep * projectionMatrix[1][1] * u_viewport.y * 0.5 / wA;
    vEndOn = smoothstep(0.08, 0.42, clamp(length(sB - sA) * 0.5 / max(facePx, 1e-6), 0.0, 1.0));
    vSide = aSide;
    vArc  = aArc;
    clipA.xy += nrm * aSide * (halfPx * 2.0 / u_viewport) * clipA.w;
    gl_Position = clipA;`);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
    uniform float u_gain;
    uniform float u_cool;
    uniform vec4 u_flow;
    uniform float u_flowK;
    ${flowGlsl}
    varying float vSide;
    varying float vArc;
    varying float vFloor;
    varying float vFuzz;
    varying float vEndOn;
    varying float vTurn;`)
                .replace('#include <color_fragment>', `#include <color_fragment>
    {
        float sw    = vSide * ${HALO_K.toFixed(1)};           // strand half-widths from the spine
        float core  = exp(-sw * sw * 1.4);              // the strand itself
        float halo  = exp(-sw * sw * 0.14) * (1.0 - vSide * vSide);   // unresolved threads; zero at the quad edge
        float sA    = sin(3.14159265 * clamp(vArc, 0.0, 1.0));
        // Brighter toward the top while hot — gently. (It was pow(sA, 1.5), a 3:1 knot at each apex: with a
        // few dozen drawn loops standing for thousands, the knots read as a row of beads along the arcade's
        // edge instead of the continuous bright ridge a real arcade's looptops merge into.)
        float top   = mix(0.45, 1.0, sA);
        float legs  = 0.50 + 0.50 * (1.0 - sA * sA);    // legs + feet once it cools
        float along = mix(top, legs, u_cool);
        diffuseColor.a   *= (core * mix(0.30, 1.0, vFloor) + 0.11 * halo) * (0.30 + 0.70 * along) * vEndOn / vFuzz;
        // A POINTED LOOPTOP IS SMALLER THAN THE RIBBON DRAWN ROUND IT. Where the strand folds within one
        // sample (the tip of a cusp: aTurn is the angle it turns there, rad) the ribbon's quads fan about
        // the fold into a cap as wide as the ribbon — a blob at every looptop of a young arcade, brighter
        // than the loop it caps (measured). The strand fades into the fold instead.
        diffuseColor.a   *= 1.0 - smoothstep(0.25, 1.0, vTurn);
        ${flowGlsl ? 'diffuseColor.a *= strandFlowGain(clamp(vArc, 0.0, 1.0), u_flow.x, u_flow.y, u_flow.z, u_flow.w, u_flowK);' : ''}
        diffuseColor.rgb *= u_gain * (1.0 + 0.8 * core);
    }`);
        };
        // The fuzz is baked into the program text, so it is part of the program's identity (the rope's kit has none).
        m.customProgramCacheKey = () => 'flare-arcade-ribbon-v6-fuzz' + hotFuzz.toFixed(2) + (flowGlsl ? '-flow' : '');
        return m;
    }
    return { uniforms, material, onBeforeRender };
}

export function ribbonGeometry(THREE, samples = RIBBON_SAMPLES) {
    const n = samples + 1;
    const g = new THREE.BufferGeometry();
    const side = new Float32Array(n * 2), arc = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        side[i * 2] = -1; side[i * 2 + 1] = 1;
        arc[i * 2] = arc[i * 2 + 1] = i / samples;
    }
    const index = [];
    for (let i = 0; i < samples; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        index.push(a, b, c, b, d, c);
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('aTangent', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('aTurn', new THREE.BufferAttribute(new Float32Array(n * 2), 1));      // 0 = a smooth strand (the rope leaves it so)
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aArc', new THREE.BufferAttribute(arc, 1));
    g.setIndex(index);
    return g;
}

function softDotTexture(THREE) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

/**
 * @param {object} o
 * @param {object} o.THREE      the page's three.js namespace
 * @param {object} o.geometry   js/flare-geometry.js namespace (the kernel)
 * @param {number} [o.sunRadius=1]     scene radius of the photosphere
 * @param {number} [o.heightScale=1]   multiplier on drawn heights / plume reach (disclosed by the caller)
 * @param {number} [o.maxLoops=11]
 * @param {number} [o.plumeParticles=220]
 * @param {number} [o.seed=1]
 * @param {'line'|'ribbon'} [o.style='line']  how a loop is drawn (header)
 * @param {number} [o.strandMm=1.6]  ribbon: physical strand width, Mm
 * @param {number} [o.minPx=1.4]     ribbon: pixel floor on the drawn width (CSS px)
 * @param {number} [o.gain=1.15]     ribbon: HDR emission gain. ONE strand stays under display white so its
 *                                   colour (its temperature) survives the tone curve; the arcade's brightness
 *                                   is many strands ADDING — at 2.2 every loop clipped to a white tube (measured)
 */
export function createFlareArcade({
    THREE, geometry, sunRadius = 1, heightScale = 1, maxLoops = 11, plumeParticles = 220, seed = 1,
    style = 'line', strandMm = 1.6, minPx = 1.4, gain = 1.15,
} = {}) {
    if (!THREE || !geometry) throw new Error('createFlareArcade: THREE and geometry are required');
    const FG = geometry;
    // The SHAPE LAWS come from a flare model (js/flare-geometry.js makeFlareModel)
    // and can be swapped at run time with setModel(); FG stays the module, for the
    // frame helpers. Defaults to the module's shipped model.
    let LAW = geometry.FLARE_MODEL ?? geometry;
    const R = sunRadius;
    const group = new THREE.Group();
    group.name = 'flare-arcade';
    group.visible = false;

    // ── Loops ──────────────────────────────────────────────────────────────
    const loops = [];
    const ribbon = style === 'ribbon';
    const SAMPLES = ribbon ? RIBBON_SAMPLES : LOOP_SAMPLES;
    const kit = ribbon ? ribbonKit(THREE, { strandMm, minPx, gain, R, hotFuzz: HOT_FUZZ, flowGlsl: FG.STRAND_FLOW_GLSL ?? '' }) : null;
    let flowOn = true, lastFlow = { filling: 0, raining: 0 };
    // ── The exposure control (header). Runs once per rendered frame, from the first loop drawn. ──
    let baseGain = gain, aecOn = true, exposure = 1, lastAec = { stack: 0, exposure: 1, light: 0, areaPx: 0 }, aecFrame = -1;
    const _v = new THREE.Vector3(), _size = new THREE.Vector2();
    function aecTick(renderer, camera) {
        const frame = renderer.info.render.frame;
        if (frame === aecFrame) return;
        aecFrame = frame;
        renderer.getDrawingBufferSize(_size);
        const W = _size.x, H = _size.y, dpr = renderer.getPixelRatio();
        const pxPerUnitAt1 = camera.projectionMatrix.elements[5] * H * 0.5;        // px per world unit at clip w = 1
        const items = [];
        for (const mesh of loops) {
            if (!mesh.visible || !(mesh.material.opacity > 0)) continue;
            const pos = mesh.geometry.attributes.position.array, n = pos.length / 6;
            let lenPx = 0, px = 0, py = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, wSum = 0, k = 0;
            for (let i = 0; i < n; i += 6) {                                      // every 6th sample is plenty for a length
                _v.set(pos[i * 6], pos[i * 6 + 1], pos[i * 6 + 2]).applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
                const w = Math.max(-_v.z, 1e-4);
                _v.applyMatrix4(camera.projectionMatrix);
                const x = (_v.x * 0.5 + 0.5) * W, y = (0.5 - _v.y * 0.5) * H;
                if (k) lenPx += Math.hypot(x - px, y - py);
                px = x; py = y; wSum += w; k++;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            const cool = mesh.material.userData.cool ? mesh.material.userData.cool.value : 1;
            const fuzz = HOT_FUZZ + (1 - HOT_FUZZ) * Math.min(1, Math.max(0, cool));
            // The strand's drawn half-width (true size or the pixel floor) and its brightness (÷ fuzz): as the shader has them.
            const halfPx = Math.max(kit.uniforms.u_halfW.value * fuzz * pxPerUnitAt1 / (wSum / k), kit.uniforms.u_minHalfPx.value * dpr);
            items.push({ opacity: mesh.material.opacity / fuzz, lenPx, halfPx, x0, x1, y0, y1 });
        }
        lastAec = arcadeExposure(items, { gain: baseGain });
        // Eased, so a loop forming or the camera arriving never steps the brightness.
        const want = aecOn ? lastAec.exposure : 1;
        exposure += (want - exposure) * 0.3;
        if (Math.abs(want - exposure) < 1e-3) exposure = want;
        kit.uniforms.u_gain.value = baseGain * exposure;
    }
    // Nested arcade: `maxLoops` stations along the PIL × the kernel's generations.
    const GENS = ribbon && LAW.arcadeShells ? LAW.ARCADE.MAX_GENERATIONS : 1;   // the pool is sized once; a model may use fewer generations, not more
    const POOL = maxLoops * GENS;
    for (let i = 0; ribbon && i < POOL; i++) {
        const mesh = new THREE.Mesh(ribbonGeometry(THREE), kit.material());
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.onBeforeRender = (renderer, scene, camera) => { kit.onBeforeRender(renderer); aecTick(renderer, camera); };
        group.add(mesh);
        loops.push(mesh);
    }
    for (let i = 0; !ribbon && i < maxLoops; i++) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LOOP_SAMPLES + 1) * 3), 3));
        const mat = new THREE.LineBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const line = new THREE.Line(geo, mat);
        line.visible = false;
        line.frustumCulled = false;
        group.add(line);
        loops.push(line);
    }

    // ── Plume (Points along the site radial) ───────────────────────────────
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pu = new Float32Array(plumeParticles);
    const pphi = new Float32Array(plumeParticles);
    const prho = new Float32Array(plumeParticles);
    for (let i = 0; i < plumeParticles; i++) {
        pu[i] = Math.pow(rnd(), 0.6);          // biased toward the front
        pphi[i] = rnd() * Math.PI * 2;
        prho[i] = Math.sqrt(rnd());            // uniform over the cross-section
    }
    const plumeGeo = new THREE.BufferGeometry();
    const plumePos = new Float32Array(plumeParticles * 3);
    const plumeCol = new Float32Array(plumeParticles * 3);
    plumeGeo.setAttribute('position', new THREE.BufferAttribute(plumePos, 3));
    plumeGeo.setAttribute('color', new THREE.BufferAttribute(plumeCol, 3));
    const plumeMat = new THREE.PointsMaterial({
        size: 0.028 * R, map: softDotTexture(THREE), vertexColors: true,
        transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, sizeAttenuation: true,
    });
    const plume = new THREE.Points(plumeGeo, plumeMat);
    plume.visible = false;
    plume.frustumCulled = false;
    group.add(plume);

    // ── State ──────────────────────────────────────────────────────────────
    let site = null;            // { latRad, lonRad0, pilAngle, cls, complex, pairs }
    let lastBuiltT = -Infinity;
    let siteVersion = 0, builtVersion = -1;
    let lastLoops = [];
    let lastPlume = { front: 1, tail: 1, radius: 0, alpha: 0, rMax: 1 };
    let lastT = 0;
    let shown = true;
    let plumeOn = true;
    const colOut = new THREE.Color();
    // Per-loop thermal look (sim units — the ribbon clock). COOL_T is sunFS's own
    // arcadeCol timescale; the rest are when a cooled loop dims and leaves the EUV bands.
    const COOL_T = 250, AGE_DIM = 150, AGE_OUT0 = 420, AGE_OUT1 = 720, NEST_LIFE = 420;
    // A loop's weight by age: new 0.55, long-cooled 0.30. It was 1.00 → 0.30, and with the brighter hot
    // pick a young arcade was 64 % clipped white; at 0.72 it was still 44 % (both measured by the look gate).
    const YOUNG_FLOOR = 0.30, YOUNG_GAIN = 0.25;
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    // Line style keeps the shader's own arcadeCol picks. In RIBBON style the hot colour is brought to the
    // SAME LUMINANCE as the cool one (0.806): a hot strand is a different colour, not 40 % more light —
    // with the brighter pick, a young arcade (every loop new, every loop at full weight) clipped 64 % of
    // its pixels to white and its temperature was unreadable (measured, tests/sun-flare-look.spec.js).
    const HOT  = ribbon ? new THREE.Color(0.39, 0.92, 0.85) : new THREE.Color(0.55, 1.30, 1.20);   // AIA 131 teal
    const COOL = new THREE.Color(1.00, 0.80, 0.30);   // AIA 171 gold as the arcade cools

    function setSite(next) {
        if (!next || !Number.isFinite(next.latRad) || !Number.isFinite(next.lonRad0)) { site = null; siteVersion++; return; }
        site = {
            latRad: next.latRad,
            lonRad0: next.lonRad0,
            pilAngle: Number.isFinite(next.pilAngle) ? next.pilAngle : FG.pilAngleRad(next.latRad),
            cls: next.cls ?? 'M',
            complex: !!next.complex,
            chirality: next.chirality < 0 ? -1 : 1,        // the flare's handedness (shear sense); +1 unless told
            pairs: Array.isArray(next.pairs) && next.pairs.length ? next.pairs : null,
        };
        siteVersion++;
        lastBuiltT = -Infinity;
    }

    /** Draw another flare-shape model (null → the module's shipped one). The next update rebuilds. */
    function setModel(m) {
        LAW = m ?? (FG.FLARE_MODEL ?? FG);
        siteVersion++;
        lastBuiltT = -Infinity;
    }
    /** Ribbon style: the strands' HDR gain (the look gate's negative control drives it). */
    function setGain(g) { if (kit && Number.isFinite(g)) { baseGain = g; kit.uniforms.u_gain.value = g * exposure; } }
    /** The exposure control on/off (off = the gain as set, whatever the stacking): the A/B and the gate's negative control. */
    /** The flows along the loops on/off (off = every loop lit end to end, as before 2026-11-22): the A/B and the gates' control. */
    function setFlowEnabled(on) { flowOn = !!on; }
    function setAutoExposure(on) { aecOn = !!on; if (!aecOn && kit) { exposure = 1; kit.uniforms.u_gain.value = baseGain; } }

    function rebuildLoops(t) {
        const nested = GENS > 1 && !site.pairs;
        lastLoops = nested
            ? LAW.arcadeShells({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle,
                t, cls: site.cls, n: maxLoops, complex: site.complex, samples: SAMPLES, generations: GENS, chirality: site.chirality })
            : LAW.arcadeLoops({
                latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle,
                t, cls: site.cls, n: maxLoops, complex: site.complex,
                pairs: site.pairs ? site.pairs.slice(0, POOL) : null, samples: SAMPLES, chirality: site.chirality,
            });
        // A nested loop's mesh is keyed by (station, generation): it keeps its strand.
        const slot = new Array(loops.length).fill(null);
        lastLoops.forEach((L, i) => { const k = nested ? L.station * GENS + L.generation : i; if (k < slot.length) slot[k] = L; });
        for (let i = 0; i < loops.length; i++) {
            const L = slot[i];
            const line = loops[i];
            line.userData.loop = L;
            if (!L) { line.visible = false; continue; }
            const arr = line.geometry.attributes.position.array;
            const stride = ribbon ? 6 : 3;      // a ribbon carries each sample twice (one per edge)
            for (let k = 0; k <= SAMPLES; k++) {
                const p = L.pts[Math.min(k, L.pts.length - 1)];
                // Heights above the photosphere scale by heightScale; the feet stay on the sphere.
                const r = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
                const rr = Math.sqrt(r);
                const drawnR = 1 + (rr - 1) * heightScale;
                const f = (drawnR / rr) * R;
                arr[k * stride] = p[0] * f; arr[k * stride + 1] = p[1] * f; arr[k * stride + 2] = p[2] * f;
                if (ribbon) { arr[k * 6 + 3] = arr[k * 6]; arr[k * 6 + 4] = arr[k * 6 + 1]; arr[k * 6 + 5] = arr[k * 6 + 2]; }
            }
            if (ribbon) {
                // Central-difference tangent along the loop, written to both edges.
                const tan = line.geometry.attributes.aTangent.array;
                for (let k = 0; k <= SAMPLES; k++) {
                    const a = Math.max(k - 1, 0) * 6, b = Math.min(k + 1, SAMPLES) * 6;
                    let tx = arr[b] - arr[a], ty = arr[b + 1] - arr[a + 1], tz = arr[b + 2] - arr[a + 2];
                    const tl = Math.hypot(tx, ty, tz) || 1;
                    tx /= tl; ty /= tl; tz /= tl;
                    tan[k * 6] = tan[k * 6 + 3] = tx; tan[k * 6 + 1] = tan[k * 6 + 4] = ty; tan[k * 6 + 2] = tan[k * 6 + 5] = tz;
                }
                line.geometry.attributes.aTangent.needsUpdate = true;
                // How sharply the strand turns AT each sample (rad): ~π/SAMPLES on a round loop, ~2 at a cusp's tip.
                const turn = line.geometry.attributes.aTurn.array;
                for (let k = 0; k <= SAMPLES; k++) {
                    let th = 0;
                    if (k > 0 && k < SAMPLES) {
                        const a = (k - 1) * 6, c = k * 6, b = (k + 1) * 6;
                        const ux = arr[c] - arr[a], uy = arr[c + 1] - arr[a + 1], uz = arr[c + 2] - arr[a + 2];
                        const vx = arr[b] - arr[c], vy = arr[b + 1] - arr[c + 1], vz = arr[b + 2] - arr[c + 2];
                        const d = (ux * vx + uy * vy + uz * vz) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1);
                        th = Math.acos(Math.max(-1, Math.min(1, d)));
                    }
                    turn[k * 2] = turn[k * 2 + 1] = th;
                }
                line.geometry.attributes.aTurn.needsUpdate = true;
            }
            line.geometry.attributes.position.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.userData.weight = L.weight;
            // Half the loop's own length (kernel units), and a fixed offset so no two loops rain in step.
            line.userData.halfLength = FG.polylineLength ? 0.5 * FG.polylineLength(L.pts) : 0.05;
            line.userData.flowSeed = ((i * 0.6180339887) % 1) * 5.0;
            line.visible = true;
        }
        lastBuiltT = t;
        builtVersion = siteVersion;
    }

    function writePlume(ps) {
        const radial = FG.stonyhurstToUnit(site.latRad, site.lonRad0);
        const { u: ua, v: va } = FG.coneBasis(radial);
        const front = 1 + (ps.front - 1) * heightScale;
        const tail  = 1 + (ps.tail  - 1) * heightScale;
        const rad   = ps.radius * heightScale;
        for (let i = 0; i < plumeParticles; i++) {
            const u = pu[i];
            const rr = (tail + u * (front - tail)) * R;
            const w = rad * (0.3 + 0.7 * u) * prho[i] * R;
            const cx = Math.cos(pphi[i]) * w, sx = Math.sin(pphi[i]) * w;
            plumePos[i * 3]     = radial[0] * rr + ua[0] * cx + va[0] * sx;
            plumePos[i * 3 + 1] = radial[1] * rr + ua[1] * cx + va[1] * sx;
            plumePos[i * 3 + 2] = radial[2] * rr + ua[2] * cx + va[2] * sx;
            // Tail gold → front white-blue (hot ejecta ahead, cooling behind).
            const k = u;
            plumeCol[i * 3]     = 1.0 - 0.15 * k;
            plumeCol[i * 3 + 1] = 0.72 + 0.25 * k;
            plumeCol[i * 3 + 2] = 0.30 + 0.70 * k;
        }
        plumeGeo.attributes.position.needsUpdate = true;
        plumeGeo.attributes.color.needsUpdate = true;
        plumeGeo.computeBoundingSphere();
    }

    /**
     * @param {object} o
     * @param {number} o.tFlare      sim units since onset (u_flare_t)
     * @param {number} [o.intensity] impulsive flash 0..1 (u_flare_intensity)
     * @param {number} [o.showFlares=1]
     * @param {number} [o.rebuildEvery=0.5]
     */
    function update({ tFlare, intensity = 0, showFlares = 1, rebuildEvery = 0.5 } = {}) {
        lastT = tFlare;
        if (!site || !shown || !(tFlare >= 0) || tFlare > 900) { group.visible = false; return; }
        const decay = LAW.ribbonDecay(tFlare);
        const ps = LAW.plumeState(tFlare, site.cls);
        lastPlume = ps;
        const nested = GENS > 1 && !site.pairs;
        // One generation fades as a block with the ribbons; a nested arcade
        // outlives them — its loops fade one by one as each cools (below).
        const loopAlpha = (nested ? Math.max(decay, Math.exp(-tFlare / NEST_LIFE)) : decay) * showFlares;
        if (loopAlpha < 0.01 && ps.alpha * showFlares < 0.005) { group.visible = false; return; }
        group.visible = true;

        if (builtVersion !== siteVersion || Math.abs(tFlare - lastBuiltT) >= rebuildEvery) rebuildLoops(tFlare);
        const flash = 0.35 + 0.65 * Math.min(1, intensity + decay);
        let filling = 0, raining = 0;
        for (const line of loops) {
            if (!line.visible) continue;
            const L = line.userData.loop;
            // The loop's OWN age (advanced between rebuilds), or the arcade's for a single generation.
            const age = nested && L ? L.age + (tFlare - lastBuiltT) : tFlare;
            // Colour cools teal → gold on the shader's own timescale (arcadeCol, t/250).
            const cool = Math.min(1, age / COOL_T);
            colOut.copy(HOT).lerp(COOL, cool);
            line.material.color.copy(colOut);
            if (line.material.userData.cool) line.material.userData.cool.value = cool;
            if (line.material.userData.flow) {
                // What is moving along this loop, from the kernel: filling from its feet, then raining.
                const fl = flowOn && nested && L && LAW.loopFlow ? LAW.loopFlow({ age, halfLength: line.userData.halfLength }) : null;
                if (fl) {
                    line.material.userData.flow.value.set(1, fl.fill, fl.rain, fl.rainPhase + line.userData.flowSeed);
                    line.material.userData.flowK.value = fl.clumps;
                    if (fl.fill < 1.15) filling++;
                    if (fl.rain > 0.02) raining++;
                } else line.material.userData.flow.value.set(0, 2, 0, 0);
            }
            const w = 0.35 + 0.65 * (line.userData.weight ?? 1);
            line.material.opacity = nested
                // newest brightest; each loop dims as it cools and leaves the EUV bands
                ? Math.min(1, showFlares * (L?.alpha ?? 1) * w * (YOUNG_FLOOR + YOUNG_GAIN * Math.exp(-age / AGE_DIM)) * (1 - smooth(AGE_OUT0, AGE_OUT1, age)) * (0.6 + 0.4 * flash))
                : Math.min(1, loopAlpha * flash * w);
        }

        lastFlow = { filling, raining };

        if (plumeOn && ps.alpha * showFlares > 0.005) {
            writePlume(ps);
            plumeMat.opacity = Math.min(1, ps.alpha * showFlares);
            plume.visible = true;
        } else {
            plume.visible = false;
        }
    }

    function setVisible(v) { shown = !!v; if (!shown) group.visible = false; }
    /** Draw the loops without the eruptive plume (the look gate isolates the arcade with it). */
    function setPlumeEnabled(v) { plumeOn = !!v; if (!plumeOn) plume.visible = false; }

    function dispose() {
        for (const l of loops) { l.geometry.dispose(); l.material.dispose(); }
        plumeGeo.dispose(); plumeMat.map?.dispose?.(); plumeMat.dispose();
        group.parent?.remove(group);
    }

    return {
        group, setSite, update, setVisible, dispose, setModel, setGain, setPlumeEnabled, setAutoExposure, setFlowEnabled,
        get site() { return site ? { ...site, pairs: site.pairs ? site.pairs.length : 0 } : null; },
        get state() {
            const apexR = lastLoops.length ? Math.max(...lastLoops.map(L => L.apexR)) : null;
            const nested = GENS > 1 && !!site && !site.pairs;
            return {
                active: group.visible,
                t: lastT,
                loops: lastLoops.length,
                apexR,                                   // tallest drawn loop, kernel R☉ (before heightScale)
                // The kernel's envelope at the last rebuild: every nested loop stands within HEIGHT_JITTER of an
                // arcadeHeight(τ ≤ t). For a single generation this IS apexR.
                envelopeApexR: site && Number.isFinite(lastBuiltT) ? 1 + LAW.arcadeHeight(Math.max(lastBuiltT, 0), site.cls, site.complex) : null,
                model: LAW.id ?? null,                                     // which shape model drew this
                builtT: Number.isFinite(lastBuiltT) ? lastBuiltT : null,   // the flare time the drawn loops were built at
                nested,
                generations: nested ? new Set(lastLoops.map(L => L.generation)).size : 1,
                ages: nested && lastLoops.length ? { min: Math.min(...lastLoops.map(L => L.age)), max: Math.max(...lastLoops.map(L => L.age)) } : null,
                drawnApexR: apexR == null ? null : 1 + (apexR - 1) * heightScale,
                plume: { ...lastPlume, visible: plume.visible },
                pil: site ? (site.pairs ? 'atlas' : 'prior') : null,
                pilAngle: site?.pilAngle ?? null,
                heightScale,
                style: ribbon ? 'ribbon' : 'line',
                strandMm: ribbon ? strandMm : null,
                // The exposure control: the gain actually drawn = gain × exposure; `stack` is the mean stacking it measured.
                gain: ribbon ? baseGain : null, exposure: ribbon ? exposure : null, autoExposure: ribbon ? aecOn : null,
                stack: ribbon ? lastAec.stack : null, hotFuzz: ribbon ? HOT_FUZZ : null,
                // Plasma along the loops: how many are still filling from their feet, how many are raining.
                flow: ribbon ? { on: flowOn, ...lastFlow } : null,
                sunRadius: R,
            };
        },
    };
}
