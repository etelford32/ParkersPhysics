/**
 * launch-smoke.js — Lit, depth-sorted smoke / steam SPRITES for the launch
 * planner's 3D canvas. Draws the PURE kernel in js/launch-smoke-sim.js and
 * computes no motion of its own.
 *
 * Why instanced quads and not THREE.Points: a puff a few metres from the
 * camera covers hundreds of pixels, and gl_PointSize is capped by the GPU
 * (ALIASED_POINT_SIZE_RANGE is 64 px on some mobile parts) — a ground cloud
 * drawn as points would shrink to a polka-dot carpet exactly when you are
 * closest to it. A camera-facing quad has no such ceiling.
 *
 * Shading (all in VIEW space, per fragment):
 *   · Each quad is treated as the front hemisphere of a sphere, so the
 *     normal comes from the quad's own coordinates. That gives a puff a
 *     lit side and a shadow side instead of a flat decal.
 *   · Sky ambient (top/bottom), the key light (wrapped Lambert, so the
 *     shadow side never goes black — real smoke scatters), and the ENGINE
 *     FLAME as a point light: inverse-square-ish falloff from the nozzle,
 *     so the bottom of the ground cloud glows orange at ignition and the
 *     trail fades to cool grey as it falls behind the vehicle.
 *   · A puff born in the flame (heat ≈ 1) self-emits while it cools.
 *   · Exponential-squared fog matching scene.fog (copied per frame).
 *   · Premultiplied alpha + NormalBlending, sorted back-to-front every
 *     frame (≤ 2 k instances; one Float32 key sort).
 *
 * Draw order: renderOrder 1 — BEFORE the additive engine plumes (renderOrder
 * 2 set by the host), so a plume always reads through its own exhaust cloud.
 *
 * Public API:
 *   createSmokeRenderer({ capacity }) → {
 *     mesh, uniforms,
 *     update(sim, camera, light),   // light: { keyDir, keyColor, flamePos,
 *                                   //   flameColor, flameIntensity, flameRange,
 *                                   //   ambTop, ambBottom, fog, exhaust, ground, steam }
 *     dispose(),
 *   }
 */

import * as THREE from 'three';
import { smokeAlpha, smokeRadius } from './launch-smoke-sim.js';

// ── Procedural puff atlas (2×2) ─────────────────────────────────────────────
// Each tile is a soft billow: several fbm-modulated blobs summed and passed
// through a soft threshold. A = density, R = internal detail (used as
// self-shadowing so the puff reads as lumpy, not as a gaussian).
function buildPuffAtlas(size = 256) {
    const W = size * 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = W;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, W);
    const d = img.data;

    // Seeded value noise (deterministic atlas across loads).
    let s = 1337;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const G = 64;
    const lattice = new Float32Array(G * G);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    const lv = (x, y) => lattice[((y % G + G) % G) * G + ((x % G + G) % G)];
    function noise(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        let fx = x - xi, fy = y - yi;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const a = lv(xi, yi), b = lv(xi + 1, yi), c2 = lv(xi, yi + 1), e = lv(xi + 1, yi + 1);
        return (a + (b - a) * fx) * (1 - fy) + (c2 + (e - c2) * fx) * fy;
    }
    function fbm(x, y) {
        let v = 0, amp = 0.5, f = 1;
        for (let o = 0; o < 5; o++) { v += amp * noise(x * f, y * f); f *= 2.03; amp *= 0.5; }
        return v;
    }

    for (let tile = 0; tile < 4; tile++) {
        const ox = (tile % 2) * size, oy = Math.floor(tile / 2) * size;
        // 5–7 sub-blobs per billow.
        const blobs = [];
        const nb = 5 + Math.floor(rnd() * 3);
        for (let b = 0; b < nb; b++) {
            const a = rnd() * Math.PI * 2, r = 0.10 + rnd() * 0.20;
            blobs.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.20 + rnd() * 0.14]);
        }
        blobs.push([0.5, 0.5, 0.30]);
        const off = tile * 17.3;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const u = x / size, v = y / size;
                let dens = 0;
                for (const [bx, by, br] of blobs) {
                    const q = Math.hypot(u - bx, v - by) / br;
                    if (q < 1) dens += (1 - q * q) * (1 - q * q);
                }
                const n = fbm(u * 6 + off, v * 6 - off);
                const n2 = fbm(u * 14 - off, v * 14 + off);
                dens = dens * (0.35 + 1.0 * n) * (0.75 + 0.5 * n2);
                // Window to ZERO by 0.88 of the tile radius: the coarse mip
                // levels average neighbouring tiles, and content reaching the
                // tile edge bled across as a straight cut on distant puffs.
                const edge = Math.hypot(u - 0.5, v - 0.5) * 2 / 0.88;
                dens *= Math.max(0, 1 - Math.pow(Math.min(edge, 1), 4));
                // Treat density as optical depth: 1 − e^(−τ) gives the soft,
                // wispy edge of real smoke instead of a cut-out silhouette.
                const a = Math.max(0, Math.min(1, 1 - Math.exp(-dens * 1.9)));
                const detail = Math.max(0, Math.min(1, 0.35 + 0.9 * (fbm(u * 11 - off, v * 11 + off) - 0.3)));
                const k = ((oy + y) * W + (ox + x)) * 4;
                d[k] = detail * 255; d[k + 1] = detail * 255; d[k + 2] = detail * 255;
                d[k + 3] = a * 255;
            }
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;        // data, not colour
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.premultiplyAlpha = false;
    return tex;
}

const SMOKE_VERT = /* glsl */`
    attribute vec3 iPos;      // world centre
    attribute vec4 iData;     // x radius, y alpha, z rotation, w seed
    attribute vec2 iHeat;     // x heat, y kind
    varying vec2  vCorner;    // -1..1, un-rotated (normal)
    varying vec2  vAtlasUv;
    varying float vAlpha;
    varying float vHeat;
    varying float vKind;
    varying float vSeed;
    varying vec3  vCenterView;
    varying float vRadius;
    void main() {
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        vec2 corner = position.xy * 2.0;           // PlaneGeometry(1,1) → ±0.5 → ±1
        float c = cos(iData.z), s = sin(iData.z);
        vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
        vCenterView = mv.xyz;
        vRadius = iData.x;
        // Pull the billboard toward the camera by 0.7 r (scaled so it still
        // subtends the puff's true angle). A quad through the puff's CENTRE
        // half-buries itself in the deck / ground and the depth test cut a
        // hard straight line through the cloud along every surface it
        // touched; in front of the centre, only geometry truly inside the
        // puff can clip it. Clamped short of the near plane.
        float d = -mv.z;
        float dz = min(iData.x * 0.7, max(d - 1.0, 0.0));
        float k = (d - dz) / max(d, 1e-3);
        mv.z += dz;
        mv.xy = mix(vec2(0.0), mv.xy, k) + corner * iData.x * k;
        gl_Position = projectionMatrix * mv;
        vCorner = corner;
        // Pick one of four atlas tiles by seed; rotate the texture lookup.
        float tile = floor(iData.w * 3.999);
        vec2 tileOff = vec2(mod(tile, 2.0), floor(tile / 2.0)) * 0.5;
        vAtlasUv = tileOff + (rc * 0.5 + 0.5) * 0.5;
        vAlpha = iData.y;
        vHeat  = iHeat.x;
        vKind  = iHeat.y;
        vSeed  = iData.w;
    }
`;

const SMOKE_FRAG = /* glsl */`
    uniform sampler2D uMap;
    uniform vec3  uKeyDir;        // view space, toward the light
    uniform vec3  uKeyColor;
    uniform vec3  uAmbTop;
    uniform vec3  uAmbBottom;
    uniform vec3  uUpView;        // world +Y in view space
    uniform vec3  uFlameView;     // flame position, view space
    uniform vec3  uFlameColor;
    uniform float uFlameIntensity;
    uniform float uFlameRange;
    uniform vec3  uExhaust;
    uniform vec3  uGround;
    uniform vec3  uSteam;
    uniform vec3  uFogColor;
    uniform float uFogDensity;
    varying vec2  vCorner;
    varying vec2  vAtlasUv;
    varying float vAlpha;
    varying float vHeat;
    varying float vKind;
    varying float vSeed;
    varying vec3  vCenterView;
    varying float vRadius;
    void main() {
        float r2 = dot(vCorner, vCorner);
        if (r2 > 1.0) discard;
        vec4 tex = texture2D(uMap, vAtlasUv);
        float dens = tex.a * vAlpha;
        if (dens < 0.002) discard;

        // Front hemisphere of a sphere: normal from the quad's coordinates.
        vec3 n = normalize(vec3(vCorner, sqrt(max(0.0, 1.0 - r2)) + 0.25));
        vec3 base = vKind < 0.5 ? uExhaust : (vKind < 1.5 ? uGround : uSteam);
        base *= 0.92 + 0.16 * vSeed;                       // puff-to-puff tint

        // Lumpy self-shadow: thin (low-density) fringes are lit through,
        // dense cores shade themselves.
        float detail = mix(0.55, 1.10, tex.r) * mix(1.0, 0.78, tex.a);
        float up = dot(n, uUpView) * 0.5 + 0.5;
        vec3 amb = mix(uAmbBottom, uAmbTop, up);
        float wrap = clamp((dot(n, uKeyDir) + 0.30) / 1.30, 0.0, 1.0);
        vec3 col = base * (amb + uKeyColor * wrap * wrap * wrap) * detail;

        // Engine flame as a point light.
        vec3 p = vCenterView + n * vRadius * 0.6;
        vec3 L = uFlameView - p;
        float d2 = dot(L, L);
        float fall = uFlameIntensity / (1.0 + d2 / (uFlameRange * uFlameRange));
        // L / |L| guarded: normalize(0) is NaN on real GPUs (puff AT the flame).
        float facing = clamp(dot(n, L * inversesqrt(max(d2, 1e-8))) * 0.6 + 0.4, 0.0, 1.0);
        col += base * uFlameColor * fall * facing * detail;

        // Born in the flame: glows while it cools.
        float h2 = vHeat * vHeat;
        col += uFlameColor * (h2 * h2) * 2.2 * tex.r * smoothstep(0.0, 0.4, uFlameIntensity);

        float depth = -vCenterView.z;
        float fogF = 1.0 - exp(-uFogDensity * uFogDensity * depth * depth);
        col = mix(col, uFogColor, fogF);
        dens *= 1.0 - fogF * 0.6;

        gl_FragColor = vec4(col * dens, dens);
    }
`;

export function createSmokeRenderer({ capacity = 1600 } = {}) {
    const N = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const iPos  = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    const iData = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    const iHeat = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2);
    for (const a of [iPos, iData, iHeat]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', iPos);
    geo.setAttribute('iData', iData);
    geo.setAttribute('iHeat', iHeat);
    geo.instanceCount = 0;

    const uniforms = {
        uMap:            { value: buildPuffAtlas(256) },
        uKeyDir:         { value: new THREE.Vector3(0, 1, 0) },
        uKeyColor:       { value: new THREE.Color(1, 1, 1) },
        uAmbTop:         { value: new THREE.Color(0.18, 0.20, 0.28) },
        uAmbBottom:      { value: new THREE.Color(0.06, 0.05, 0.07) },
        uUpView:         { value: new THREE.Vector3(0, 1, 0) },
        uFlameView:      { value: new THREE.Vector3() },
        uFlameColor:     { value: new THREE.Color(1.0, 0.55, 0.22) },
        uFlameIntensity: { value: 0 },
        uFlameRange:     { value: 30 },
        uExhaust:        { value: new THREE.Color(0.85, 0.84, 0.82) },
        uGround:         { value: new THREE.Color(0.80, 0.78, 0.76) },
        uSteam:          { value: new THREE.Color(0.92, 0.94, 0.97) },
        uFogColor:       { value: new THREE.Color(0, 0, 0) },
        uFogDensity:     { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SMOKE_VERT,
        fragmentShader: SMOKE_FRAG,
        transparent: true,
        premultipliedAlpha: true,
        blending: THREE.NormalBlending,
        depthWrite: false,
        depthTest: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'LaunchSmoke';
    mesh.frustumCulled = false;       // instances span the whole pad + trail
    mesh.renderOrder = 1;

    // Sort scratch.
    const order = new Uint32Array(N);
    const keys  = new Float32Array(N);
    const tmpM  = new THREE.Matrix3();

    function update(sim, camera, light = {}) {
        const cap = Math.min(sim.capacity, N);
        const vm = camera.matrixWorldInverse;
        const e = vm.elements;
        // View-space depth of every live puff (−z_view = distance in front).
        let n = 0;
        for (let i = 0; i < cap; i++) {
            if (sim.life[i] <= 0) continue;
            const a = smokeAlpha(sim, i);
            if (a < 0.003) continue;
            const x = sim.pos[i * 3], y = sim.pos[i * 3 + 1], z = sim.pos[i * 3 + 2];
            const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
            order[n] = i;
            keys[i] = vz;                      // more negative = farther
            n++;
        }
        // Back-to-front: farthest (most negative z) first.
        const sub = order.subarray(0, n);
        sub.sort((a, b) => keys[a] - keys[b]);

        const P = iPos.array, D = iData.array, H = iHeat.array;
        for (let k = 0; k < n; k++) {
            const i = sub[k];
            P[k * 3]     = sim.pos[i * 3];
            P[k * 3 + 1] = sim.pos[i * 3 + 1];
            P[k * 3 + 2] = sim.pos[i * 3 + 2];
            D[k * 4]     = smokeRadius(sim, i);
            D[k * 4 + 1] = smokeAlpha(sim, i);
            D[k * 4 + 2] = sim.rot[i];
            D[k * 4 + 3] = sim.seed[i];
            H[k * 2]     = sim.heat[i];
            H[k * 2 + 1] = sim.kind[i];
        }
        geo.instanceCount = n;
        for (const a of [iPos, iData, iHeat]) {
            a.clearUpdateRanges?.();
            a.needsUpdate = true;
        }

        // Lighting uniforms in view space.
        tmpM.setFromMatrix4(vm);
        if (light.keyDir) uniforms.uKeyDir.value.copy(light.keyDir).applyMatrix3(tmpM).normalize();
        uniforms.uUpView.value.set(0, 1, 0).applyMatrix3(tmpM).normalize();
        if (light.keyColor)  uniforms.uKeyColor.value.copy(light.keyColor);
        if (light.ambTop)    uniforms.uAmbTop.value.copy(light.ambTop);
        if (light.ambBottom) uniforms.uAmbBottom.value.copy(light.ambBottom);
        if (light.flamePos)  uniforms.uFlameView.value.copy(light.flamePos).applyMatrix4(vm);
        if (light.flameColor) uniforms.uFlameColor.value.copy(light.flameColor);
        uniforms.uFlameIntensity.value = light.flameIntensity ?? 0;
        uniforms.uFlameRange.value = light.flameRange ?? 30;
        if (light.exhaust) uniforms.uExhaust.value.copy(light.exhaust);
        if (light.ground)  uniforms.uGround.value.copy(light.ground);
        if (light.steam)   uniforms.uSteam.value.copy(light.steam);
        if (light.fog) {
            uniforms.uFogColor.value.copy(light.fog.color);
            uniforms.uFogDensity.value = light.fog.density;
        }
        return n;
    }

    function dispose() {
        geo.dispose();
        quad.dispose();
        mat.dispose();
        uniforms.uMap.value.dispose();
    }

    return { mesh, uniforms, update, dispose };
}
