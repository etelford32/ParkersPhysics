/**
 * neo-rocks.js — 3D bodies for the near-Earth object layer
 * ═══════════════════════════════════════════════════════════════════════════
 * Procedural, seeded asteroid / comet-nucleus meshes and the instanced
 * meteoroid streams that stand in for point sprites whenever an object is
 * close enough to the camera to have a shape at all.
 *
 * ── Shapes ────────────────────────────────────────────────────────────────
 * A rock is an icosphere displaced by (a) a low-frequency lumpy field — a sum
 * of eight seeded cosine bumps, which is smooth and cheap and has no lattice
 * artefacts — (b) a handful of bowl craters with a raised rim, and (c) a
 * family profile:
 *     potato     the default; mild triaxial squash
 *     elongated  Eros / Apophis-like, ~2:1
 *     contact    two lobes and a neck — Itokawa, Toutatis, Arrokoth
 *     top        the "spinning top" with an equatorial ridge — Bennu, Ryugu,
 *                Didymos (a rubble pile spun up by YORP)
 *     spheroid   nearly round
 * Known bodies get their real family via NOTABLE_SHAPES and their real spin
 * period via ROTATION_PERIOD_H; everything else is seeded from its
 * designation so a given object always looks the same.
 *
 * ── Lighting ──────────────────────────────────────────────────────────────
 * The orrery's Sun is a physically-decaying PointLight that leaves anything
 * at 1 AU dim, so the rocks light THEMSELVES from the Sun direction (the Sun
 * is always at the world origin — the same convention the page's planet
 * shader uses). The scattering law is LOMMEL–SEELIGER, not Lambert: single
 * scattering off a dark particulate regolith, ∝ μ₀/(μ₀+μ), nearly flat across
 * the disc where a Lambertian sphere darkens toward the limb — the reason a
 * full Moon reads as a disc rather than a ball. Level comes from the object's
 * own albedo times the illumination and the IAU H–G phase function, through
 * the same disclosed display compression js/neo-layer.js POINT_FS uses: the
 * LOD handoff between an impostor and a mesh must change the geometry and
 * nothing else. Plus a faint scattered fill, a rim so a dark limb still reads
 * against black, and a per-vertex regolith speckle. The shader handles
 * `instanceMatrix` so the same material drives the InstancedMesh streams.
 *
 * ── Scale ─────────────────────────────────────────────────────────────────
 * `drawnRockRadius(diamKm)` is a LOG map from real diameter to scene units:
 * a 30 m rock and Eros differ by 500× in size, and on a log-scale orrery
 * where Earth is 0.12 units that has to compress to ~4×. Disclosed in the
 * panel note. Sizes are never used for any physics.
 */

import * as THREE from 'three';
import { TONE_DECODE_GLSL } from './tone-decode.js';

export const ROTATION_PERIOD_H = Object.freeze({
    '99942': 30.6, '101955': 4.30, '162173': 7.63, '65803': 2.26, '2024 YR4': 0.33, '3200': 3.60,
    '433': 5.27, '25143': 12.1, '29075': 2.12, '4179': 176, '1566': 2.27, '2062': 40.8, '1862': 3.07,
    '1221': 7.3, '163693': 3.4, '367943': 9.5, '1P': 52.8, '109P': 69, '2P': 11.1, '55P': 15, '21P': 9.5,
});
export const NOTABLE_SHAPES = Object.freeze({
    '101955': 'top', '162173': 'top', '65803': 'top',
    '99942': 'elongated', '433': 'elongated', '2024 YR4': 'elongated', '1566': 'spheroid',
    '25143': 'contact', '4179': 'contact',
});
export const SHAPES = Object.freeze(['potato', 'elongated', 'contact', 'top', 'spheroid']);

/** FNV-1a → 32-bit. */
export function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
/** mulberry32 PRNG. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Real diameter (km) → drawn radius (scene units), log-compressed. */
export function drawnRockRadius(diamKm) {
    const d = Number.isFinite(diamKm) && diamKm > 0 ? diamKm : 0.1;
    return 0.010 + 0.011 * Math.log10(1 + 10 * d);
}

/** Shape family for an object: the known one, else seeded. */
export function shapeFor(des, seed) {
    if (des != null && NOTABLE_SHAPES[des]) return NOTABLE_SHAPES[des];
    const r = rng(seed ^ 0x9e3779b9)();
    if (r < 0.12) return 'contact';
    if (r < 0.32) return 'elongated';
    if (r < 0.42) return 'top';
    if (r < 0.52) return 'spheroid';
    return 'potato';
}

/** Merge duplicated vertices of a non-indexed geometry so normals come out smooth. */
function mergeVertices(geo, precision = 1e-4) {
    const pos = geo.attributes.position;
    const key = new Map();
    const out = [];
    const index = new Uint32Array(pos.count);
    const q = 1 / precision;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const k = `${Math.round(x * q)}|${Math.round(y * q)}|${Math.round(z * q)}`;
        let id = key.get(k);
        if (id === undefined) { id = out.length / 3; key.set(k, id); out.push(x, y, z); }
        index[i] = id;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    merged.setIndex(new THREE.BufferAttribute(index, 1));
    return merged;
}

/**
 * Build a rock geometry of unit nominal radius.
 * @param {{ seed:number, shape?:string, detail?:number }} opts  detail is three's LINEAR subdivision: 7 ⇒ 1280 faces / 642 vertices
 */
export function rockGeometry({ seed, shape = 'potato', detail = 7 }) {
    const rand = rng(seed);
    const geo = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
    const pos = geo.attributes.position;
    const n = pos.count;

    // (a) lumpy field: eight seeded cosine bumps.
    const bumps = [];
    for (let i = 0; i < 8; i++) {
        const th = rand() * Math.PI * 2, ph = Math.acos(rand() * 2 - 1);
        bumps.push({ kx: Math.sin(ph) * Math.cos(th), ky: Math.sin(ph) * Math.sin(th), kz: Math.cos(ph),
            f: 1.2 + rand() * 2.8, phase: rand() * Math.PI * 2, amp: (0.05 + rand() * 0.07) / (1 + i * 0.25) });
    }
    // (b) craters: bowl with a rim.
    const craters = [];
    const nCr = 4 + Math.floor(rand() * 7);
    for (let i = 0; i < nCr; i++) {
        const th = rand() * Math.PI * 2, ph = Math.acos(rand() * 2 - 1);
        craters.push({ x: Math.sin(ph) * Math.cos(th), y: Math.sin(ph) * Math.sin(th), z: Math.cos(ph),
            rho: 0.12 + rand() * 0.35, depth: 0.03 + rand() * 0.07 });
    }
    const squash = { x: 1 + (rand() - 0.5) * 0.25, y: 1 + (rand() - 0.5) * 0.25, z: 1 + (rand() - 0.5) * 0.25 };
    const speck = new Float32Array(n);
    const sRand = rng(seed ^ 0x51ed270b);

    for (let i = 0; i < n; i++) {
        let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        let r = 1;
        for (const b of bumps) r += b.amp * Math.cos(b.f * (b.kx * x + b.ky * y + b.kz * z) + b.phase);
        for (const c of craters) {
            const ang = Math.acos(Math.max(-1, Math.min(1, x * c.x + y * c.y + z * c.z)));
            if (ang < c.rho) {
                const u = ang / c.rho;                       // 0 centre → 1 rim
                r -= c.depth * (1 - u * u) * (1 - u * u);    // bowl
                r += c.depth * 0.45 * Math.exp(-Math.pow((u - 0.92) / 0.09, 2));   // rim
            }
        }
        // (c) family profile.
        let sx = squash.x, sy = squash.y, sz = squash.z;
        if (shape === 'elongated') { sx *= 1.95; sy *= 0.82; sz *= 0.78; }
        else if (shape === 'spheroid') { sx = sy = sz = 1; r = 1 + (r - 1) * 0.4; }
        else if (shape === 'top') {
            // Equatorial ridge + diamond profile (Bennu / Ryugu).
            r += 0.16 * Math.exp(-Math.pow(y / 0.14, 2)) - 0.10 * Math.abs(y) * Math.abs(y);
            sy *= 0.92;
        } else if (shape === 'contact') {
            r += 0.32 * Math.exp(-Math.pow((x - 0.55) / 0.42, 2)) + 0.26 * Math.exp(-Math.pow((x + 0.55) / 0.40, 2))
               - 0.22 * Math.exp(-Math.pow(x / 0.22, 2));
            sx *= 1.55; sy *= 0.78; sz *= 0.78;
        }
        pos.setXYZ(i, x * r * sx, y * r * sy, z * r * sz);
        speck[i] = sRand();
    }
    geo.setAttribute('aSpeck', new THREE.BufferAttribute(speck, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // Normalise so the bounding radius is 1 — sizing is then exact in drawnRockRadius units.
    const R = geo.boundingSphere.radius || 1;
    for (let i = 0; i < n; i++) pos.setXYZ(i, pos.getX(i) / R, pos.getY(i) / R, pos.getZ(i) / R);
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
}

const ROCK_VS = /* glsl */`
    attribute float aSpeck;
    varying vec3  vN;
    varying vec3  vW;
    varying float vSpeck;
    void main() {
        mat4 M = modelMatrix;
        #ifdef USE_INSTANCING
            M = modelMatrix * instanceMatrix;
        #endif
        vec4 wp = M * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(M) * normal);
        vSpeck = aSpeck;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const ROCK_FS = /* glsl */`${TONE_DECODE_GLSL}
    uniform vec3  u_base;
    uniform float u_glow;        // comet nucleus: faint self-lit coma haze
    uniform float u_albedo;      // geometric albedo — measured, or the class mean
    uniform float u_light;       // (1 AU / r)² × Φ_HG(α): illumination × phase
    uniform float u_gain;        // display normalisation, shared with the impostor
    uniform float u_stretch;     // DISCLOSED display compression
    varying vec3  vN;
    varying vec3  vW;
    varying float vSpeck;
    void main() {
        vec3 n = normalize(vN);
        vec3 toSun = normalize(-vW);                  // Sun at the world origin
        vec3 toCam = normalize(cameraPosition - vW);
        // LOMMEL–SEELIGER, not Lambert. Single scattering off a dark
        // particulate regolith: brightness ∝ μ₀/(μ₀+μ), which is nearly FLAT
        // across the disc where a Lambertian sphere falls off toward the limb.
        // It is why the full Moon reads as a disc and not a ball, and it is the
        // same law js/neo-layer.js POINT_FS applies to the far-field impostor —
        // the LOD handoff must not change the physics, only the geometry.
        float mu0 = max(dot(n, toSun), 0.0);
        float mu  = max(dot(n, toCam), 1e-3);
        float ls  = 2.0 * mu0 / (mu0 + mu);           // normalised at μ₀ = μ
        float wrap = max(dot(n, toSun) * 0.5 + 0.5, 0.0) * 0.06;   // faint scattered fill
        float lit = pow(clamp((u_albedo * u_light * ls + wrap * u_albedo) * u_gain, 0.0, 6.0), u_stretch);
        float rim  = pow(1.0 - max(dot(n, toCam), 0.0), 3.0) * (0.06 + u_glow * 0.5);
        vec3 col = u_base * lit * (0.82 + 0.36 * vSpeck) + rim * vec3(0.7, 0.85, 1.0);
        col += u_glow * vec3(0.55, 0.75, 1.0) * 0.25;
        gl_FragColor = vec4(col, 1.0);
        gl_FragColor.rgb = toneDecode(gl_FragColor.rgb);   // sRGB colour picks → linear
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

/**
 * @param {number} colorHex   the taxonomy's tint
 * @param {number} glow       cometary coma haze, 0..1
 * @param {{albedo?:number, light?:number, gain?:number, stretch?:number}} [phot]
 *        photometry: geometric albedo, illumination × phase function, and the
 *        display normalisation the far-field impostor uses. Defaults reproduce
 *        a 0.14-albedo body at 1 AU seen at opposition.
 */
export function rockMaterial(colorHex, glow = 0, phot = {}) {
    return new THREE.ShaderMaterial({
        vertexShader: ROCK_VS, fragmentShader: ROCK_FS,
        uniforms: {
            u_base: { value: new THREE.Color(colorHex) }, u_glow: { value: glow },
            u_albedo:  { value: phot.albedo ?? 0.14 },
            u_light:   { value: phot.light ?? 1 },
            u_gain:    { value: phot.gain ?? 6.2 },
            u_stretch: { value: phot.stretch ?? 0.38 },
        },
    });
}

/** Spin axis (unit) and phase for an object — seeded, stable. */
export function spinFor(des, seed) {
    const r = rng(seed ^ 0x2545f491);
    const th = r() * Math.PI * 2, ph = Math.acos(r() * 2 - 1);
    const axis = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)).normalize();
    const periodH = ROTATION_PERIOD_H[des] ?? (2.2 + r() * 9.5);
    return { axis, periodH, phase: r() * Math.PI * 2 };
}

/**
 * A meteoroid stream: `count` small rocks on a converging cone that pour in
 * from the radiant direction toward Earth (the origin of the parent group),
 * each tumbling. CPU-updated (a few hundred matrix composes per frame).
 */
export class MeteoroidStream {
    constructor({ count = 140, seed = 1, colorHex = 0x8f877c } = {}) {
        this.count = count;
        const geo = rockGeometry({ seed, shape: 'potato', detail: 2 });   // 80 faces per meteoroid
        this.mesh = new THREE.InstancedMesh(geo, rockMaterial(colorHex), count);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.name = 'neo-meteoroids';
        const r = rng(seed ^ 0x7f4a7c15);
        this.seed = new Float32Array(count);
        this.jit = new Float32Array(count * 3);
        this.size = new Float32Array(count);
        this.axis = [];
        this.rate = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            this.seed[i] = r();
            this.jit[i * 3] = r() * 2 - 1; this.jit[i * 3 + 1] = r() * 2 - 1; this.jit[i * 3 + 2] = r() * 2 - 1;
            // Power-law sizes: many pebbles, a few boulders.
            this.size[i] = 0.0022 + 0.0075 * Math.pow(r(), 3);
            const th = r() * Math.PI * 2, ph = Math.acos(r() * 2 - 1);
            this.axis.push(new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)));
            this.rate[i] = 2 + r() * 6;
        }
        this.dir = new THREE.Vector3(0, 1, 0);
        this.speed = 0.5;
        this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    }
    setDirection(v) { this.dir.copy(v).normalize(); }
    setSpeed(s) { this.speed = s; }
    update(t) {
        const { dir, _m, _q, _p, _s } = this;
        for (let i = 0; i < this.count; i++) {
            const s = (this.seed[i] + t * this.speed) % 1;               // 0 far out → 1 at Earth
            const along = 1.25 + (0.16 - 1.25) * s;
            const spread = 0.05 + 0.13 * (1 - s);
            _p.set(dir.x * along + this.jit[i * 3] * spread, dir.y * along + this.jit[i * 3 + 1] * spread, dir.z * along + this.jit[i * 3 + 2] * spread);
            _q.setFromAxisAngle(this.axis[i], t * this.rate[i] + this.seed[i] * 6.28);
            _s.setScalar(this.size[i]);
            _m.compose(_p, _q, _s);
            this.mesh.setMatrixAt(i, _m);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
    }
    dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
