/**
 * spaceship-designer-fx.js — Environment + particle effects for the Space Ship
 * Designer's 3D view (sky, planet, stars, exhaust smoke / pad steam).
 *
 * Everything here is cosmetic and says so; nothing feeds back into the ascent.
 * The two physical inputs are the body (which sets the palette and whether
 * there is any air to scatter light or hold smoke) and the ambient pressure
 * fraction p/p₀ at the camera / vehicle (`airFraction` in the flight kernel).
 *
 * THE PLANET IS TRUE SCALE. It is a sphere of the body's real radius centred
 * at (0, −R, 0) under the pad, so climbing to orbit shows the horizon curve and
 * the limb exactly as far away as it really is. Earth and Mars wear the
 * self-hosted archival maps (assets/earth, assets/mars — the hero / mars.html
 * sources); every other body is a featureless sphere in its mean surface
 * colour rather than invented geography. The pad sits at the design's own
 * launchLatitude / launchLongitude (presets in the engine's LAUNCH_SITES);
 * `padBasis` in the flight kernel is the one, node-tested, orientation.
 *
 * Colour pipeline: the renderer does NO tone mapping, and the raw shaders here
 * write display-space values (their colour uniforms are set without the
 * sRGB→linear conversion three.js applies to `new THREE.Color(hex)`), matching
 * the shared plume shader's convention.
 */

import * as THREE from 'three';
import { padBasis } from './spaceship-designer-flight.js';

// ── Per-body look ────────────────────────────────────────────────────────────
// zenith / horizon: clear-day sky at the surface; ground: mean surface tint;
// limb: colour of the atmosphere seen edge-on from orbit; fog: visibility
// scale (m) at the surface; smoke: whether exhaust condenses into a lasting
// trail; map: archival albedo map, if we self-host one.
export const BODY_LOOK = {
    earth:     { zenith: 0x3a78c2, horizon: 0xb7d3ea, ground: 0x6b6f5c, limb: 0x5f9cff, fog: 5500, map: 'assets/earth/day-2k.webp' },
    mars:      { zenith: 0x8a6448, horizon: 0xd9b58e, ground: 0x9a5a36, limb: 0xd8a070, fog: 6000,  map: 'assets/mars/mars-viking-jpl.jpg' },
    venus:     { zenith: 0x9a7a40, horizon: 0xe0c07a, ground: 0x6e5a3a, limb: 0xf0d090, fog: 2500 },
    titan:     { zenith: 0x8a6428, horizon: 0xcf9c4c, ground: 0x4c3a26, limb: 0xd89a3a, fog: 4000 },
    moon:      { ground: 0x8a8884 },
    mercury:   { ground: 0x6f6a64 },
    europa:    { ground: 0xcbbfae },
    enceladus: { ground: 0xe6eaee },
};

const SUN_DIR = new THREE.Vector3(0.45, 0.78, 0.43).normalize();
export function sunDirection() { return SUN_DIR.clone(); }

/** Display-space colour (no sRGB→linear conversion) for raw-shader uniforms. */
function rawColor(hex) { return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace); }

// ── Sky dome ─────────────────────────────────────────────────────────────────
// A camera-centred sphere drawn FIRST with no depth test: zenith→horizon
// gradient about the LOCAL vertical under the camera (it turns as the vehicle
// flies downrange), a sun glow, all scaled by the air above the camera so the
// sky goes black on the way up. Below the horizon it is never seen: the planet
// draws over it.
const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.9999, p.w);   // just inside the far plane
    }`;
const SKY_FRAG = /* glsl */`
    uniform vec3 uZenith, uHorizon, uUp, uSun;
    uniform float uAir;
    varying vec3 vDir;
    void main() {
        vec3 d = normalize(vDir);
        float e = dot(d, uUp);
        float h = 1.0 - clamp(e, 0.0, 1.0);
        vec3 col = mix(uZenith, uHorizon, pow(h, 5.0));
        float s = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.95, 0.85) * (pow(s, 900.0) * 1.5 + pow(s, 24.0) * 0.18);
        col *= uAir;
        // The Sun's disc stays visible from space (no air to scatter it).
        col += vec3(1.0, 0.97, 0.9) * pow(s, 2400.0) * (1.0 - uAir);
        gl_FragColor = vec4(col, 1.0);
    }`;

export function createSky(look) {
    const uniforms = {
        uZenith: { value: rawColor(look.zenith ?? 0x000000) },
        uHorizon: { value: rawColor(look.horizon ?? 0x000000) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSun: { value: SUN_DIR.clone() },
        uAir: { value: 1 },
    };
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1000, 48, 24),
        new THREE.ShaderMaterial({
            uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
            side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
        }),
    );
    mesh.renderOrder = -10;
    mesh.frustumCulled = false;
    return {
        mesh,
        /** @param camPos world camera position, @param up local vertical, @param air 0..1 */
        update(camPos, up, air) {
            mesh.position.copy(camPos);
            uniforms.uUp.value.copy(up);
            uniforms.uAir.value = air;
        },
        dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
    };
}

// ── Stars ───────────────────────────────────────────────────────────────────
export function createStars() {
    const N = 2400;
    const arr = new Float32Array(N * 3), col = new Float32Array(N * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
        const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
        arr[i * 3] = 900 * Math.sin(ph) * Math.cos(th);
        arr[i * 3 + 1] = 900 * Math.cos(ph);
        arr[i * 3 + 2] = 900 * Math.sin(ph) * Math.sin(th);
        const b = 0.35 + 0.65 * Math.pow(rnd(), 3);
        const warm = rnd();
        col[i * 3] = b * (0.85 + 0.15 * warm); col[i * 3 + 1] = b * 0.92; col[i * 3 + 2] = b * (1.0 - 0.15 * warm);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        size: 1.8, sizeAttenuation: false, vertexColors: true, fog: false,
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = -9;
    pts.frustumCulled = false;
    return {
        points: pts,
        update(camPos, visibility) {
            pts.position.copy(camPos);
            mat.color.setScalar(Math.max(0, Math.min(1, visibility)));
            pts.visible = visibility > 0.01;
        },
        dispose() { geo.dispose(); mat.dispose(); },
    };
}

// ── Planet ───────────────────────────────────────────────────────────────────
// Limb glow: an impact-parameter shell (NOT a pow(rim) term — on a back-face
// sphere that is identically 1; see SOLAR_SYSTEM_VISUAL_REVIEW.md S3). Each
// fragment's view ray finds its closest approach b to the planet centre and
// glows as exp(−(b − R)/H_vis). The far half of the shell sits behind the
// opaque planet, so the glow can only appear around the limb.
const LIMB_VERT = /* glsl */`
    varying vec3 vWorld;
    void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
    }`;
const LIMB_FRAG = /* glsl */`
    uniform vec3 uCamRel;        // camera − planet centre (m), computed in doubles on the CPU
    uniform float uR, uH, uStrength;
    uniform vec3 uColor;
    varying vec3 vWorld;
    void main() {
        vec3 d = normalize(vWorld - cameraPosition);
        float tca = -dot(uCamRel, d);
        vec3 closest = uCamRel + d * max(tca, 0.0);
        float h = max(length(closest) - uR, 0.0);
        float glow = exp(-h / uH);
        gl_FragColor = vec4(uColor * glow * uStrength, 1.0);
    }`;

export function createPlanet(body, look, latDeg = 0, lonDeg = 0) {
    const R = body.R_km * 1000;
    const group = new THREE.Group();
    group.position.set(0, -R, 0);

    const mat = new THREE.MeshStandardMaterial({ color: look.ground, roughness: 1, metalness: 0 });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 96), mat);
    // Orient the sphere so the pad's (lat, lon) is at +Y and local EAST is +X
    // (the downrange direction) — `padBasis` gives the rotation's rows.
    const { E, U, Nneg } = padBasis(latDeg, lonDeg);
    const basis = new THREE.Matrix4().set(
        E[0], E[1], E[2], 0,
        U[0], U[1], U[2], 0,
        Nneg[0], Nneg[1], Nneg[2], 0,
        0, 0, 0, 1,
    );
    sphere.quaternion.setFromRotationMatrix(basis);
    group.add(sphere);

    let tex = null;
    if (look.map) {
        new THREE.TextureLoader().load(look.map, (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = 4;
            tex = t;
            mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true;
        }, undefined, () => { /* map unavailable → keep the flat mean colour */ });
    }

    let limb = null, limbU = null;
    if (body.rho0_kg_m3 > 1e-6 && look.limb != null) {
        const H = (body.H_km || 8.5) * 1000;
        limbU = {
            uCamRel: { value: new THREE.Vector3() }, uR: { value: R },
            uH: { value: H * 2.2 }, uStrength: { value: 0 }, uColor: { value: rawColor(look.limb) },
        };
        limb = new THREE.Mesh(
            new THREE.SphereGeometry(R + H * 10, 128, 64),
            new THREE.ShaderMaterial({
                uniforms: limbU, vertexShader: LIMB_VERT, fragmentShader: LIMB_FRAG,
                side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending,
                depthWrite: false, fog: false,
            }),
        );
        group.add(limb);
    }

    return {
        group, R,
        /** camPos world; altCam metres above the surface. */
        update(camPos, altCam) {
            if (!limb) return;
            limbU.uCamRel.value.set(camPos.x, camPos.y + R, camPos.z);
            // Only reads as a limb from altitude; from the pad it would be a
            // bright band smeared along the horizon on top of the sky dome.
            limbU.uStrength.value = 0.9 * smooth01((altCam - 8000) / 60000);
        },
        dispose() {
            sphere.geometry.dispose(); mat.dispose(); tex?.dispose();
            if (limb) { limb.geometry.dispose(); limb.material.dispose(); }
        },
    };
}

// ── Particles: exhaust trail, pad steam, regolith dust ─────────────────────────
// One world-space pool, soft round sprites. Emitters push particles with a
// start/end size, life (wall seconds), colour, drag and buoyancy; the pool
// ages them on the CPU (≤ a few thousand, cheap) and uploads once per frame.
const PART_VERT = /* glsl */`
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    uniform float uScale;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.0, 900.0);
        vAlpha = aAlpha;
        vColor = aColor;
    }`;
const PART_FRAG = /* glsl */`
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c) * 4.0;
        if (r2 > 1.0) discard;
        float a = pow(1.0 - r2, 1.6) * vAlpha;
        // Lit from above: the top of each puff a touch brighter than its belly.
        float shade = mix(1.08, 0.72, gl_PointCoord.y);
        gl_FragColor = vec4(vColor * shade, a);
    }`;

export function createParticles(max = 3200) {
    const pos = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max), color = new Float32Array(max * 3);
    const vel = new Float32Array(max * 3), age = new Float32Array(max), life = new Float32Array(max);
    const s0 = new Float32Array(max), s1 = new Float32Array(max), a0 = new Float32Array(max);
    const drag = new Float32Array(max), buoy = new Float32Array(max);
    life.fill(0);
    const geo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    const aAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    const aColor = new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('aSize', aSize);
    geo.setAttribute('aAlpha', aAlpha);
    geo.setAttribute('aColor', aColor);
    const uniforms = { uScale: { value: 400 } };
    const mat = new THREE.ShaderMaterial({
        uniforms, vertexShader: PART_VERT, fragmentShader: PART_FRAG,
        transparent: true, depthWrite: false, fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 2;
    let head = 0, live = 0;
    const tmp = new THREE.Color();

    function emit(p) {
        const i = head; head = (head + 1) % max;
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        vel[i * 3] = p.vx || 0; vel[i * 3 + 1] = p.vy || 0; vel[i * 3 + 2] = p.vz || 0;
        age[i] = 0; life[i] = p.life; s0[i] = p.size0; s1[i] = p.size1; a0[i] = p.alpha;
        drag[i] = p.drag ?? 0.6; buoy[i] = p.buoy ?? 0;
        tmp.setHex(p.color, THREE.LinearSRGBColorSpace);
        color[i * 3] = tmp.r; color[i * 3 + 1] = tmp.g; color[i * 3 + 2] = tmp.b;
    }

    function update(dt, camera, viewportH) {
        uniforms.uScale.value = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
        live = 0;
        for (let i = 0; i < max; i++) {
            if (life[i] <= 0) { alpha[i] = 0; size[i] = 0; continue; }
            age[i] += dt;
            const f = age[i] / life[i];
            if (f >= 1) { life[i] = 0; alpha[i] = 0; size[i] = 0; continue; }
            live++;
            const k = Math.exp(-drag[i] * dt);
            vel[i * 3] *= k; vel[i * 3 + 1] = vel[i * 3 + 1] * k + buoy[i] * dt; vel[i * 3 + 2] *= k;
            pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
            // Puffs expand fast then slowly (√ growth, like a turbulent plume).
            size[i] = s0[i] + (s1[i] - s0[i]) * Math.sqrt(f);
            alpha[i] = a0[i] * Math.min(1, f * 12) * Math.pow(1 - f, 1.4);
        }
        aPos.needsUpdate = true; aSize.needsUpdate = true; aAlpha.needsUpdate = true; aColor.needsUpdate = true;
    }

    return {
        points, emit, update,
        get live() { return live; },
        clear() { life.fill(0); alpha.fill(0); size.fill(0); aAlpha.needsUpdate = true; aSize.needsUpdate = true; },
        dispose() { geo.dispose(); mat.dispose(); },
    };
}

/** Exhaust-smoke character per propellant (cosmetic, disclosed as such). */
export const SMOKE = {
    kerolox:    { color: 0x8c847a, alpha: 0.55, grow: 1.0 },   // soot-laden
    methalox:   { color: 0xe6ebef, alpha: 0.22, grow: 0.8 },   // clean, thin condensation
    hydrolox:   { color: 0xf2f6fa, alpha: 0.18, grow: 0.7 },   // water vapour only
    hypergolic: { color: 0xc49a70, alpha: 0.40, grow: 0.9 },   // NO₂ tint
    solid:      { color: 0xf4f2ee, alpha: 0.85, grow: 1.6 },   // Al₂O₃ — the thick white column
    nuclear:    null,                                          // hot hydrogen: no visible trail
    ion:        null,
};

function smooth01(x) { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); }
