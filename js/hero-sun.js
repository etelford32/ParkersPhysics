/**
 * hero-sun.js — the homepage hero's LIVE SUN: the star the corridor's CME
 * flux ropes leave, drawn with what it is doing today.
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the corridor's plain limb-darkened ball (hero-rope-layer.js) with:
 *
 *   · PHOTOSPHERE — granulation (Worley cells + supergranular network),
 *     a per-channel limb-darkening law (the limb reddens because blue
 *     darkens faster), and every NOAA region on the disc at its reported
 *     position carried forward by differential rotation: a sunspot BIPOLE
 *     laid along Joy's law (leading spot west + equatorward, bigger;
 *     umbra, filamented penumbra, pores along the PIL of a γ/δ region),
 *     inside a facular plage that brightens toward the limb as real
 *     faculae do. A flare on the bus lights two ribbons either side of its
 *     region's PIL.
 *   · LOOPS — each region's nested bipole arcade (hero-sun-model
 *     `regionLoops`) as thin additive tubes with siphon-flow pulses running
 *     foot to foot; their brightness is the region's `activityHeat`. They
 *     are depth-tested against the photosphere, so an arcade rotating over
 *     the W limb stands up in profile and then sets.
 *   · CORONA — one FrontSide shell evaluated on the view ray's IMPACT
 *     PARAMETER b (closed-form column ~ b^−2.6 with an outer e-fold), never
 *     `pow(rim, n)` on a back face (identically 1 there — the orrery's S3
 *     scar). Structure: a low-latitude streamer belt, radial rays from noise
 *     on the sky-plane DIRECTION only (so they are radial by construction),
 *     and a bright fan over every region, weighted by how near the limb it
 *     sits in the sky plane. A thin chromospheric rim at b ≈ 1. Brightens
 *     with the live GOES X-ray level.
 *   · FLASHES / LIFTOFFS — sprites at flare sites (bus flares with a
 *     location, carried to τ) and at each engine rope's source site around
 *     its launch (the Stage's `liftoffAt` envelope), so a CME is seen
 *     leaving the place it left from.
 *
 * Frame: `root` carries the FLUX-ROPE frame (x = Sun→Earth, y = west,
 * z = north — hero-sun-model.js header) mapped into the hero scene by the
 * rope layer's `heroBasis`, scaled to the drawn radius. Region geometry is
 * built once at each region's anchor longitude and TURNED about +z by its
 * own latitude's rate — a 30° region lags the equator, as it should.
 *
 * Colour: every raw shader ends in `heroRadiance` (the photosphere — an HDR
 * emitter in linear light) or `heroEmit` (the additive layers); built-in
 * sprites are converted by the hero's per-frame sweep (js/hero-color.js).
 * A BACKTICK inside any GLSL below terminates the template literal — keep
 * comments in the shaders backtick-free (the orrery scar).
 *
 * Pure half: js/hero-sun-model.js (`node tests/hero-sun-model.mjs`).
 */

import { HERO_COLOR_GLSL } from './hero-color.js';
import {
    MAX_REGIONS, helioUnit, regionAt, regionTurnRad, bipoleAxisAt, bipoleSize,
    activityHeat, regionLoops, flareSites, flareFlash, stonyhurstDriftDegPerDay,
} from './hero-sun-model.js';
import { liftoffAt } from './stage/model.js';

const DEG = Math.PI / 180;
const DAY = 86400e3;

/** Corona shell radius, in drawn solar radii. The glow must fade out well
 *  inside it — the geometry's silhouette must never be the visible edge. */
export const CORONA_SHELL_R = 3.6;
/** Loop tube radius, in drawn solar radii (≈1.2 px at a 150 px Sun). */
export const LOOP_TUBE_R = 0.009;
/** Photosphere disc-centre level in linear light: well under the tone
 *  curve's knee, because the bloom (threshold 0.214 linear) adds its own
 *  glow ON TOP of the disc — at 0.86 the pair washed the disc to a flat
 *  peach and the granulation and spots vanished (measured, first render). */
export const PHOTOSPHERE_LEVEL = 0.40;
/** Drawn umbra size relative to the model's `bipoleSize` — a disclosed
 *  legibility factor (a real 500 MSH umbra is ~3 px on a 150 px Sun). */
export const SPOT_SCALE = 1.55;

const PHOTO_VS = /* glsl */`
    varying vec3 vPos; varying vec3 vN; varying vec3 vV;
    void main(){
        vPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const NOISE_GLSL = /* glsl */`
    float hash3(vec3 p){
        p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x){
        vec3 i = floor(x); vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                       mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                       mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }
    float fbm(vec3 p){
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }
        return s;
    }`;

const PHOTO_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    #define MAXR ${MAX_REGIONS}
    const float SPOT_SCALE = ${SPOT_SCALE.toFixed(3)};
    uniform float u_time;
    uniform float u_level;
    uniform int   u_n;
    uniform vec4  u_reg[MAXR];   // xyz centre (unit, root frame), w half-separation (rad)
    uniform vec4  u_ax[MAXR];    // xyz bipole axis following to leading, w umbra radius (rad)
    uniform vec4  u_act[MAXR];   // x heat, y flare flash, z complex
    varying vec3 vPos; varying vec3 vN; varying vec3 vV;
    ${NOISE_GLSL}
    // Worley F1/F2 on a jittered lattice: bright granules, dark lanes.
    vec2 worley(vec3 p){
        vec3 i = floor(p); vec3 f = fract(p);
        float d1 = 8.0, d2 = 8.0;
        for (int z = -1; z <= 1; z++)
        for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
            vec3 g = vec3(float(x), float(y), float(z));
            vec3 o = vec3(hash3(i + g), hash3(i + g + 19.1), hash3(i + g + 47.7));
            vec3 r = g + o - f;
            float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
        return vec2(sqrt(d1), sqrt(d2));
    }
    // One sunspot: umbra + filamented penumbra. Returns the intensity factor.
    float spotI(vec3 p, vec3 s, float r, vec3 ax, vec3 side, inout float umbraW){
        float d = length(p - s);
        if (d > r * 2.6) return 1.0;
        float ang = atan(dot(p - s, side), dot(p - s, ax));
        float fil = 0.78 + 0.22 * sin(ang * 34.0 + 5.0 * vnoise(p * 140.0));
        float pen = 1.0 - smoothstep(r * 1.9, r * 2.45, d);
        float um  = 1.0 - smoothstep(r * 0.80, r * 1.05, d);
        umbraW = max(umbraW, um);
        return mix(mix(1.0, 0.50 * fil, pen), 0.10, um);
    }
    void main(){
        vec3 p = normalize(vPos);
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);

        // Granulation + supergranular network, contrast foreshortened to the limb.
        vec2 w = worley(p * 48.0 + vec3(0.0, 0.0, u_time * 0.035));
        float gran = smoothstep(0.02, 0.34, w.y - w.x);
        float net = fbm(p * 9.0 + 3.1);
        float tex = 0.78 + 0.30 * gran + 0.12 * (net - 0.5);
        tex = mix(1.0, tex, 0.25 + 0.75 * mu);

        float I = 1.0, umbraW = 0.0, fac = 0.0, rib = 0.0;
        for (int i = 0; i < MAXR; i++) {
            if (i >= u_n) break;
            vec3 c = u_reg[i].xyz; float hs = u_reg[i].w;
            float dc = length(p - c);
            if (dc > hs * 3.4) continue;
            vec3 ax = u_ax[i].xyz; float ru = u_ax[i].w;
            vec3 side = normalize(cross(c, ax));             // along the PIL
            float heat = u_act[i].x, flash = u_act[i].y, cx = u_act[i].z;
            // The bipole: leading spot west + bigger, following spot trailing.
            I *= spotI(p, normalize(c + ax * hs * 0.85), ru * SPOT_SCALE, ax, side, umbraW);
            I *= spotI(p, normalize(c - ax * hs * 1.05), ru * SPOT_SCALE * 0.74, ax, side, umbraW);
            // A gamma/delta region: pores and small spots crowd the PIL.
            float e = dot(p - c, ax), a = dot(p - c, side);
            float band = exp(-pow(e / (hs * 0.35), 2.0) - pow(a / (hs * 0.9), 2.0));
            I *= 1.0 - cx * 0.55 * band * smoothstep(0.58, 0.78, vnoise(p * 240.0));
            // Plage: patchy faculae over the whole region.
            float plage = smoothstep(0.42, 0.78, fbm(p * 64.0 + float(i) * 7.3));
            fac += plage * (1.0 - smoothstep(hs * 1.3, hs * 2.9, dc)) * (0.45 + 0.55 * heat);
            // White-light flare ribbons either side of the PIL.
            if (flash > 0.001) {
                float r1 = exp(-pow((e - 0.26 * hs) / (0.07 * hs), 2.0)) + exp(-pow((e + 0.26 * hs) / (0.07 * hs), 2.0));
                rib += flash * r1 * exp(-pow(a / (0.75 * hs), 2.0));
            }
        }
        // Faculae are a limb phenomenon: nearly invisible at disc centre.
        I *= 1.0 + min(fac, 1.2) * (0.05 + 0.42 * (1.0 - mu));

        float lm = 1.0 - mu;
        vec3 limb = vec3(1.0) - vec3(0.42, 0.58, 0.76) * lm - vec3(0.18, 0.20, 0.16) * lm * lm;
        vec3 base = heroDecode(vec3(1.0, 0.82, 0.52));
        vec3 umbraTint = mix(vec3(1.0), vec3(1.0, 0.72, 0.52), umbraW);
        vec3 col = base * limb * tex * I * umbraTint * u_level;
        col += vec3(1.0, 0.96, 0.9) * rib * 2.2;          // HDR: ribbons bloom
        gl_FragColor = heroRadiance(col);
    }`;

const LOOP_VS = /* glsl */`
    attribute float aU;
    attribute float aSeed;
    varying float vU; varying float vSeed; varying vec3 vN; varying vec3 vV;
    void main(){
        vU = aU; vSeed = aSeed;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const LOOP_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    uniform float u_time; uniform float u_heat; uniform float u_flash; uniform float u_xray; uniform float u_vis;
    varying float vU; varying float vSeed; varying vec3 vN; varying vec3 vV;
    void main(){
        // Soft round tube: brightest where the line of sight grazes the most plasma.
        float edge = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 0.7);
        // Siphon flows: brightness knots running foot to foot.
        float flow = 0.5 + 0.5 * sin(6.2831 * (vU * 1.6 - u_time * 0.11 + vSeed * 7.0));
        float feet = smoothstep(0.0, 0.07, vU) * smoothstep(1.0, 0.93, vU);
        float hot = clamp(u_heat + 0.5 * u_flash + 0.3 * u_xray, 0.0, 1.0);
        vec3 col = mix(vec3(1.0, 0.58, 0.20), vec3(1.0, 0.88, 0.60), hot);
        float a = (0.30 + 0.70 * flow) * feet * edge * (0.40 + 0.95 * u_heat) * (1.0 + 1.6 * u_flash) * u_vis;
        gl_FragColor = heroEmit(col, a);
    }`;

const CORONA_VS = /* glsl */`
    varying vec3 vW;
    void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const CORONA_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    #define MAXR ${MAX_REGIONS}
    uniform mat4  u_w2l;          // world to root frame (unit = one drawn solar radius)
    uniform float u_time; uniform float u_xray; uniform float u_vis;
    uniform int   u_n;
    uniform vec4  u_reg[MAXR];    // xyz centre (unit), w heat
    varying vec3 vW;
    ${NOISE_GLSL}
    void main(){
        vec3 ro = (u_w2l * vec4(cameraPosition, 1.0)).xyz;
        vec3 pw = (u_w2l * vec4(vW, 1.0)).xyz;
        vec3 rd = normalize(pw - ro);
        vec3 P  = ro - rd * dot(ro, rd);                 // closest approach to the Sun's centre
        float b = length(P);                             // impact parameter, in solar radii
        vec3 s  = P / max(b, 1e-4);                      // sky-plane direction of this ray
        // K-corona column (closed form, n ~ r^-3.2) with an outer e-fold.
        float column = pow(max(b, 1.0), -2.2) * exp(-max(b - 1.0, 0.0) / 2.2);
        // Structure lives on the DIRECTION only, so every feature is radial:
        // a helmet-streamer belt at low latitude, fainter polar-hole plumes,
        // and fine streaks from noise at two angular scales.
        float belt  = mix(0.30, 1.0, exp(-pow(s.z / 0.42, 2.0)));
        float drift = u_time * 0.004;
        float rays  = 0.45 + 0.55 * vnoise(s * 9.0 + drift) + 0.55 * pow(vnoise(s * 31.0 - drift), 2.0);
        float ar = 0.0;
        for (int i = 0; i < MAXR; i++) {
            if (i >= u_n) break;
            vec3 c = u_reg[i].xyz;
            vec3 cs = c - rd * dot(c, rd);               // the region, projected on the sky
            float lim = length(cs);                      // 1 on the limb, 0 at disc centre
            if (lim < 1e-3) continue;
            float fan = pow(max(dot(s, cs / lim), 0.0), 40.0);
            ar += u_reg[i].w * fan * lim * lim;
        }
        float glow = column * (belt * rays + 0.9 * ar * rays) * (0.7 + 0.8 * u_xray);
        // Over the disc the photosphere outshines it — let it through only as a veil.
        glow *= mix(0.12, 1.0, smoothstep(0.985, 1.03, b));
        // Chromospheric rim.
        float chrom = exp(-max(b - 1.0, 0.0) / 0.014) * smoothstep(0.995, 1.004, b);
        vec3 col = vec3(1.0, 0.86, 0.66) * glow * 0.55 + vec3(1.0, 0.36, 0.42) * chrom * 0.6;
        gl_FragColor = heroEmit(col, u_vis);
    }`;

/** A tube mesh's arrays for a set of polylines (unit-sphere coords × apex). */
export function loopTubeArrays(loops, radius = LOOP_TUBE_R, radial = 5) {
    let nv = 0, ni = 0;
    for (const l of loops) { nv += l.pts.length * radial; ni += (l.pts.length - 1) * radial * 6; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
    const aU = new Float32Array(nv), aSeed = new Float32Array(nv);
    const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
    let v = 0, k = 0;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const unit = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
    loops.forEach((l, li) => {
        const pts = l.pts, n = pts.length;
        const mid = pts[Math.floor(n / 2)];
        // The loop is near-planar: one binormal for the whole arc.
        const B = unit(cross(sub(pts[n - 1], pts[0]), mid));
        const seed = ((li * 0.618034) % 1);
        const base = v;
        for (let i = 0; i < n; i++) {
            const T = unit(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
            const N = unit(cross(B, T));
            for (let j = 0; j < radial; j++) {
                const th = (j / radial) * Math.PI * 2;
                const c = Math.cos(th), s = Math.sin(th);
                const d = [N[0] * c + B[0] * s, N[1] * c + B[1] * s, N[2] * c + B[2] * s];
                pos[v * 3] = pts[i][0] + d[0] * radius; pos[v * 3 + 1] = pts[i][1] + d[1] * radius; pos[v * 3 + 2] = pts[i][2] + d[2] * radius;
                nor[v * 3] = d[0]; nor[v * 3 + 1] = d[1]; nor[v * 3 + 2] = d[2];
                aU[v] = i / (n - 1); aSeed[v] = seed;
                v++;
            }
        }
        for (let i = 0; i < n - 1; i++) {
            for (let j = 0; j < radial; j++) {
                const a = base + i * radial + j, b = base + i * radial + ((j + 1) % radial);
                const c = a + radial, d = b + radial;
                idx[k++] = a; idx[k++] = c; idx[k++] = b;
                idx[k++] = b; idx[k++] = c; idx[k++] = d;
            }
        }
    });
    return { pos, nor, aU, aSeed, idx };
}

/**
 * @param {object} o
 * @param {object} o.THREE
 * @param {object} o.parent     Object3D positioned at the drawn Sun's centre (the rope layer's sunGroup)
 * @param {{e1:number[],e2:number[],e3:number[]}} o.basis  flux-rope frame → hero world (heroBasis)
 * @param {number} o.radius     drawn solar radius, hero units
 */
export function createHeroSun({ THREE, parent, basis, radius }) {
    const root = new THREE.Group();
    root.name = 'hero-live-sun';
    const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...basis.e1), new THREE.Vector3(...basis.e2), new THREE.Vector3(...basis.e3));
    root.quaternion.setFromRotationMatrix(m);
    root.scale.setScalar(radius);
    parent.add(root);

    const regU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());
    const axU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());
    const actU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());
    const corU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());

    const photoMat = new THREE.ShaderMaterial({
        uniforms: {
            u_time: { value: 0 }, u_level: { value: PHOTOSPHERE_LEVEL }, u_n: { value: 0 },
            u_reg: { value: regU }, u_ax: { value: axU }, u_act: { value: actU },
        },
        vertexShader: PHOTO_VS, fragmentShader: PHOTO_FS, fog: false,
    });
    const photosphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), photoMat);
    photosphere.name = 'hero-sun-photosphere';
    root.add(photosphere);

    const w2l = new THREE.Matrix4();
    const coronaMat = new THREE.ShaderMaterial({
        uniforms: {
            u_w2l: { value: w2l }, u_time: { value: 0 }, u_xray: { value: 0 }, u_vis: { value: 1 },
            u_n: { value: 0 }, u_reg: { value: corU },
        },
        vertexShader: CORONA_VS, fragmentShader: CORONA_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false,
    });
    const corona = new THREE.Mesh(new THREE.SphereGeometry(CORONA_SHELL_R, 64, 40), coronaMat);
    corona.name = 'hero-sun-corona';
    corona.renderOrder = 5;
    root.add(corona);

    const dotTex = (() => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const g = cv.getContext('2d');
        const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,240,210,0.6)');
        gr.addColorStop(0.6, 'rgba(255,190,120,0.14)'); gr.addColorStop(1, 'rgba(255,160,80,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const makeSprite = (color) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        }));
        s.visible = false; s.renderOrder = 8;
        root.add(s);
        return s;
    };
    const flashSprites = Array.from({ length: 4 }, () => makeSprite(0xffffff));
    const liftSprites = Array.from({ length: 6 }, () => [makeSprite(0xffe2b0), makeSprite(0xffc78a)]);

    let regions = [];
    let slots = [];          // { reg, group, mesh, mat, heat }
    let sites = [];          // flare sites on the bus
    let liftoffs = [];       // { launchMs, latDeg, lonDeg }
    let xray = 0;
    let tauMs = Date.now();
    let visible = 1;
    let live = true;         // false: a replay of another date — no TODAY on this Sun

    function disposeSlots() {
        for (const s of slots) { root.remove(s.group); s.mesh.geometry.dispose(); s.mat.dispose(); }
        slots = [];
    }

    /** Regions from hero-sun-model `latestRegions`. Rebuilds the loop meshes. */
    function setRegions(list) {
        disposeSlots();
        regions = (list ?? []).slice(0, MAX_REGIONS);
        for (const reg of regions) {
            const { pos, nor, aU, aSeed, idx } = loopTubeArrays(regionLoops(reg));
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
            g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
            g.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
            g.setIndex(new THREE.BufferAttribute(idx, 1));
            const heat = activityHeat(reg);
            const mat = new THREE.ShaderMaterial({
                uniforms: {
                    u_time: { value: 0 }, u_heat: { value: heat }, u_flash: { value: 0 },
                    u_xray: { value: xray }, u_vis: { value: 1 },
                },
                vertexShader: LOOP_VS, fragmentShader: LOOP_FS,
                transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
            });
            const mesh = new THREE.Mesh(g, mat);
            mesh.renderOrder = 6;
            const group = new THREE.Group();
            group.add(mesh);
            root.add(group);
            slots.push({ reg, group, mesh, mat, heat });
        }
        update(tauMs, true);
    }

    /** The live bus state (js/swpc-feed.js): X-ray level + located flares. */
    function setBus(state) {
        if (!state) return;
        const x = state.derived?.xray_intensity;
        xray = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : xray;
        sites = flareSites(state.flares ?? state.recent_flares ?? []);
    }

    /** Engine rope launches: [{ launchMs, latDeg, lonDeg }]. */
    function setLiftoffs(list) { liftoffs = (list ?? []).slice(0, liftSprites.length); }

    const tmpV = new THREE.Vector3();
    const place = (sprite, latDeg, lonDeg, r, scale, opacity) => {
        const u = helioUnit(latDeg, lonDeg);
        sprite.position.set(u[0] * r, u[1] * r, u[2] * r);
        sprite.scale.setScalar(scale);
        sprite.material.opacity = opacity;
        sprite.visible = opacity > 0.01;
    };

    /** Place everything at instant τ (epoch ms). */
    function update(t, force = false) {
        if (!Number.isFinite(t)) return;
        if (!force && t === tauMs) return;
        tauMs = t;
        let n = 0;
        for (const s of slots) {
            s.group.visible = live;
            if (!live) continue;
            const at = regionAt(s.reg, tauMs);
            s.group.rotation.set(0, 0, regionTurnRad(s.reg, tauMs));
            const c = helioUnit(at.latDeg, at.lonDeg);
            const ax = bipoleAxisAt(at.latDeg, at.lonDeg);
            const { halfSepRad, umbraRad } = bipoleSize(s.reg.area);
            // Flash from any located flare within 10° of this region.
            let flash = 0;
            for (const f of sites) {
                const drift = stonyhurstDriftDegPerDay(f.latDeg) * (tauMs - f.timeMs) / DAY;
                const fc = helioUnit(f.latDeg, f.lonDeg + drift);
                if (c[0] * fc[0] + c[1] * fc[1] + c[2] * fc[2] > Math.cos(10 * DEG)) flash = Math.max(flash, flareFlash(f, tauMs));
            }
            s.mat.uniforms.u_flash.value = flash;
            s.mat.uniforms.u_xray.value = xray;
            regU[n].set(c[0], c[1], c[2], halfSepRad);
            axU[n].set(ax[0], ax[1], ax[2], umbraRad);
            actU[n].set(s.heat, flash, s.reg.complex ? 1 : 0, 0);
            corU[n].set(c[0], c[1], c[2], s.heat);
            n++;
        }
        photoMat.uniforms.u_n.value = n;
        coronaMat.uniforms.u_n.value = n;
        coronaMat.uniforms.u_xray.value = live ? xray : 0;

        // Flare flashes at their own sites (a flare need not sit in a numbered region).
        flashSprites.forEach((sp, i) => {
            const f = live ? sites[i] : null;
            if (!f) { sp.visible = false; return; }
            const fl = flareFlash(f, tauMs);
            const drift = stonyhurstDriftDegPerDay(f.latDeg) * (tauMs - f.timeMs) / DAY;
            const lon = f.lonDeg + drift;
            const facing = Math.cos(f.latDeg * DEG) * Math.cos(lon * DEG) > -0.15;
            place(sp, f.latDeg, lon, 1.02, 0.35 + 0.9 * fl, facing ? fl : 0);
        });
        // CME liftoffs: a plume at the rope's source site around its launch.
        liftSprites.forEach(([a, b], i) => {
            const L = liftoffs[i];
            const lo = L ? liftoffAt(L.launchMs, tauMs) : 0;
            if (!lo) { a.visible = false; b.visible = false; return; }
            place(a, L.latDeg, L.lonDeg, 1.06, 0.5 + 0.7 * lo, 0.9 * lo);
            place(b, L.latDeg, L.lonDeg, 1.28 + 0.25 * (1 - lo), 0.8 + 1.0 * lo, 0.55 * lo);
        });
    }

    /** Per frame: shader clocks + the world→root matrix the corona marches in. */
    function tick(wallT) {
        photoMat.uniforms.u_time.value = wallT;
        coronaMat.uniforms.u_time.value = wallT;
        for (const s of slots) s.mat.uniforms.u_time.value = wallT;
        root.updateWorldMatrix(true, false);
        w2l.copy(root.matrixWorld).invert();
    }

    /**
     * true: this is TODAY's Sun (regions, X-ray, flares from the live feeds).
     * false: the drawing is a replay of another date (the Gannon transit) —
     * the Sun keeps its photosphere and a quiet corona, and wears none of
     * today's activity.
     */
    function setLive(v) {
        if (live === !!v) return;
        live = !!v;
        update(tauMs, true);
    }

    /** 0..1: how much of the Sun's additive dressing shows (the photosphere is opaque). */
    function setVisibility(v) {
        visible = Math.max(0, Math.min(1, v));
        coronaMat.uniforms.u_vis.value = visible;
        for (const s of slots) s.mat.uniforms.u_vis.value = visible;
    }

    return {
        root, photosphere, corona,
        setRegions, setBus, setLiftoffs, setLive, update, tick, setVisibility,
        get state() {
            return {
                regions: live ? regions.length : 0,
                earthFacing: !live ? 0 : regions.filter((r) => regionAt(r, tauMs).earthFacing).length,
                flares: sites.length,
                flashing: flashSprites.filter((s) => s.visible).length,
                liftoffs: liftSprites.filter(([a]) => a.visible).length,
                xray, tauMs, visible, live,
            };
        },
        dispose() {
            disposeSlots();
            parent.remove(root);
            photosphere.geometry.dispose(); photoMat.dispose();
            corona.geometry.dispose(); coronaMat.dispose();
            for (const s of [...flashSprites, ...liftSprites.flat()]) s.material.dispose();
            dotTex.dispose();
        },
    };
}
