/**
 * moon-exosphere.js — renderer for the lunar surface-boundary exosphere.
 * ═══════════════════════════════════════════════════════════════════════════
 * Renderer ONLY. Every number drawn here comes from js/moon-exosphere-model.js
 * (the pure kernel with its own Node gate, tests/moon-exosphere-model.mjs).
 *
 * ── WHAT IS PHYSICS AND WHAT IS DECORATION ───────────────────────────────
 *   PHYSICS (from the kernel):
 *     • The glow shell's radial falloff — exp(−(b−1)/H) in the view ray's
 *       impact parameter, with H the kernel's own scale heights (suprathermal
 *       Na ≈ 267 km dayside, cold thermal gas ≈ 100–130 km nightside, in
 *       moon-radius units). The halo really is ~15–25% of a radius deep;
 *       almost no exaggeration was needed, which is itself the point.
 *     • Day/night colour split: the dayside glows sodium-yellow (Na D
 *       resonance scattering needs sunlight); the nightside is the faint
 *       blue-grey of the cold He/Ar gas that concentrates there.
 *     • The dawn-limb argon bulge — condensable ⁴⁰Ar released at sunrise
 *       (the LACE signature). The dawn limb is computed from the sun
 *       direction and the Moon's spin axis, not hand-placed.
 *     • Tail brightness and glow intensity scale with the kernel's live
 *       sodium source total (PSD + sputtering + impacts), so magnetotail
 *       passage visibly dims it and meteor showers visibly feed it.
 *   DECORATION (disclosed):
 *     • Absolute brightness — a real exosphere is invisible to the eye;
 *       drawing it AT ALL is the exaggeration, and the panel says so.
 *     • The tail's on-screen length (~8 R_moon) COMPRESSES a structure
 *       observed to stream for hundreds of moon radii (the "sodium spot"
 *       passes Earth at new moon). Particle motion pacing is art.
 */

import * as THREE from 'three';
import {
    SPECIES, speciesProfile, effectivePoolingExponent, DAY_K, NIGHT_K,
    SUNRISE_RELEASE_HOUR, SUNRISE_RELEASE_SIGMA_H, CONDENSATION_TAU_H,
} from './moon-exosphere-model.js';
import { createHopSim, PHASE, DEFAULT_TIME_COMPRESSION } from './moon-exosphere-hops.js';
import { R_MOON_KM } from './moon-interior-model.js';

/*
 * ── 2026-11 ADDITIONS ───────────────────────────────────────────────────────
 *   • setSunDir(): the Sun is LIVE now (js/moon-ephemeris.js). The dawn limb
 *     and the tail's anti-sunward axis are re-derived from it each frame —
 *     they were computed once from a fixed vector before.
 *   • SPECIES MODE (setSpecies): the glow shell can draw ONE species' map —
 *     the kernel's `localDensityCm3` transliterated into GLSL (thermal
 *     T^(−γ) pooling with the table's own exponent, the argon dawn bulge
 *     from the local solar hour, dayside sodium ∝ cos χ) with a scale height
 *     that tracks the LOCAL surface temperature. Every constant arrives as a
 *     uniform from the kernel's exports; nothing is retyped.
 *   • THE HOP LAYER (setHopSpecies / setHopsVisible): js/moon-exosphere-hops.js
 *     runs ~1500–3000 test atoms of the chosen species as a Monte-Carlo
 *     exosphere — launched from the regolith at the local temperature,
 *     flown under central gravity, cold-trapped at night, ionized in
 *     sunlight, escaping when fast enough — and this file only draws
 *     them: colour by species, size by phase (flying bright, adsorbed dim
 *     and blue, escaping fading out). Positions sit CLEAR_R above the
 *     reference sphere so resting atoms are not buried under the drawn
 *     relief; that offset is rendering clearance, not altitude. The sim
 *     clock runs DEFAULT_TIME_COMPRESSION × real time and the panel says so.
 */

// ── Glow shell shader ───────────────────────────────────────────────────────
// Drawn on a BackSide sphere at r = SHELL_R: only the far hemisphere renders
// and the Moon's own depth buffer occludes the disk, leaving a clean limb
// halo. The camera can enter the shell (minDistance 1.04) — BackSide keeps
// rendering and the exp falloff handles it.
const SHELL_R = 1.45;

const GLOW_VERT = /* glsl */`
varying vec3 vPos;
void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GLOW_FRAG = /* glsl */`
precision highp float;
uniform vec3  u_sun_dir;
uniform vec3  u_dawn_dir;     // sunrise limb (from sun dir × spin axis)
uniform float u_h_day;        // dayside (suprathermal Na) scale height, moon radii
uniform float u_h_night;      // nightside (cold thermal gas) scale height, moon radii
uniform float u_activity;     // live Na source total, ×quiet (kernel)
uniform float u_intensity;    // master visibility gain (decoration, disclosed)
// ── species mode (all from the kernel; see setSpecies) ──
uniform float u_mode;         // 0 composite · 1 one species
uniform vec3  u_sp_n;         // (day, night, sunrise) cm⁻³
uniform vec3  u_sp_flags;     // (∝cos χ suprathermal, condensable, pooling exponent γ)
uniform float u_sp_h;         // scale height at the species' reference T, moon radii
uniform float u_sp_norm;      // 1 / max density
uniform vec3  u_sp_color;
uniform vec4  u_sp_consts;    // (DAY_K, NIGHT_K, SUNRISE_RELEASE_HOUR, SUNRISE_RELEASE_SIGMA_H)
uniform float u_sp_tau;       // CONDENSATION_TAU_H
varying vec3 vPos;

// Mirror of moon-exosphere-model.js surfaceTemperatureK + localDensityCm3
float spTemperature(float cosChi) {
    if (cosChi <= 0.0) return u_sp_consts.y;
    return max(u_sp_consts.y, u_sp_consts.x * pow(cosChi, 0.25));
}
float spLocalHour(vec3 cdir, vec3 S) {
    float lon = atan(-cdir.z, cdir.x);
    float lonSun = atan(-S.z, S.x);
    float h = 12.0 + degrees(lon - lonSun) / 15.0;
    return mod(mod(h, 24.0) + 24.0, 24.0);
}
float spDensity(vec3 cdir, vec3 S) {
    float cosChi = dot(cdir, S);
    if (u_sp_flags.x > 0.5) {
        return u_sp_n.y + (u_sp_n.x - u_sp_n.y) * max(cosChi, 0.0);
    }
    if (u_sp_flags.y > 0.5) {
        float h = spLocalHour(cdir, S);
        float dh = h - u_sp_consts.z;
        if (dh > 12.0) dh -= 24.0;
        if (dh < -12.0) dh += 24.0;
        float bulge = (u_sp_n.z - u_sp_n.y) * exp(-(dh * dh) / (2.0 * u_sp_consts.w * u_sp_consts.w));
        bool day = (h >= 6.0 && h < 18.0);
        if (day) return u_sp_n.x + max(bulge, 0.0);
        float since = (h >= 18.0) ? h - 18.0 : h + 6.0;
        return u_sp_n.y + (u_sp_n.x - u_sp_n.y) * exp(-since / u_sp_tau) + max(bulge, 0.0);
    }
    float T = spTemperature(cosChi);
    return u_sp_n.x * pow(u_sp_consts.x / T, u_sp_flags.z);
}

void main() {
    // Impact parameter of the view ray w.r.t. the Moon's centre (origin)
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vPos - ro);
    float tca = dot(-ro, rd);
    vec3 closest = ro + rd * max(tca, 0.0);
    float b = length(closest);
    vec3 cdir = closest / max(b, 1e-5);
    // Observer INSIDE the shell looking outward (descent mode): the ray's
    // closest approach is the camera itself, so the limb formula would paint
    // the whole sky at limb brightness. The upward column through an
    // exponential layer is shorter than the tangent column by the Chapman
    // factor √(2πR/H) — applied below once H is known — so the sky from the
    // ground reads ~7× fainter than the limb, as it should.
    float upward = (tca <= 0.0) ? 1.0 : 0.0;

    vec3 S = normalize(u_sun_dir);
    if (u_mode > 0.5) {
        // ONE species: brightness ∝ local density × local scale height,
        // the column the kernel implies at this limb point
        float cosChi = dot(cdir, S);
        float T = spTemperature(cosChi);
        float Hs = (u_sp_flags.x > 0.5) ? u_sp_h : u_sp_h * T / u_sp_consts.x;
        float xs = max(b - 1.0, 0.0) / max(Hs, 1e-4);
        float n = spDensity(cdir, S) * u_sp_norm;
        float chapmanS = mix(1.0, inversesqrt(6.2831853 / max(Hs, 1e-4)), upward);
        float a = u_intensity * exp(-xs) * n * 1.3 * chapmanS;
        gl_FragColor = vec4(u_sp_color * a, a);
        return;
    }

    // Day/night from where the ray grazes the exosphere
    float dayness = clamp(dot(cdir, S) * 0.5 + 0.5, 0.0, 1.0);
    float H = mix(u_h_night, u_h_day, dayness);

    // Column falloff in the impact parameter — the kernel's scale height
    float x = max(b - 1.0, 0.0) / max(H, 1e-4);
    float col = exp(-x) * mix(1.0, inversesqrt(6.2831853 / max(H, 1e-4)), upward);

    // Sodium-yellow by day (D-line resonance scattering), cold blue-grey by night
    vec3 naCol = vec3(1.00, 0.82, 0.35);
    vec3 coldCol = vec3(0.45, 0.55, 0.80);
    vec3 tint = mix(coldCol, naCol, dayness);

    // Dawn-limb argon bulge (LACE sunrise release)
    float dawn = pow(clamp(dot(cdir, normalize(u_dawn_dir)), 0.0, 1.0), 8.0);
    tint += vec3(0.55, 0.62, 0.85) * dawn * 0.6;
    col *= 1.0 + 0.8 * dawn;

    // Live activity brightens the dayside sodium component
    float act = clamp(u_activity, 0.0, 3.0);
    float gain = mix(0.6, 0.6 + 0.4 * act, dayness);

    float a = u_intensity * col * gain;
    gl_FragColor = vec4(tint * a, a);
}`;

// ── Sodium tail shader ──────────────────────────────────────────────────────
// Particles stream anti-sunward inside a widening cone. Geometry is built in
// a local frame with the cone axis on +X; the group quaternion rotates +X to
// −sunDir. Per-particle seeds live in an attribute; positions are computed
// in the vertex shader so the outflow animates without CPU writes.
const TAIL_SPAN = 8.0;    // on-screen tail length, moon radii (compressed — see header)
const TAIL_R0 = 1.06;   // cone start just above the surface

const TAIL_VERT = /* glsl */`
attribute vec4 a_seed;        // (s0 ∈ [0,1) along-tail phase, angle, radial ∈ [0,1], size)
uniform float u_time;
uniform float u_strength;     // live Na source total, ×quiet
varying float vFade;
void main() {
    float span = ${TAIL_SPAN.toFixed(1)};
    // Outflow: phase drifts down-tail; faster when the source runs hot
    float s = fract(a_seed.x + u_time * 0.022 * (0.6 + 0.4 * u_strength));
    float x = ${TAIL_R0.toFixed(2)} + s * span;
    // Cone widens down-tail; radial jitter from the seed
    float spread = (0.10 + 0.24 * s * span) * a_seed.z;
    vec3 pos = vec3(x, cos(a_seed.y) * spread, sin(a_seed.y) * spread);
    // Fade in off the surface, fade out down-tail (photoionization death)
    vFade = smoothstep(0.0, 0.06, s) * pow(1.0 - s, 1.4);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    // Fine-grained stream: a few px per atom-packet, capped so near
    // particles can't balloon into blobs
    gl_PointSize = min(9.0, a_seed.w * 16.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
}`;

const TAIL_FRAG = /* glsl */`
precision mediump float;
uniform float u_opacity;
varying float vFade;
void main() {
    // Soft round sprite
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float soft = 1.0 - smoothstep(0.05, 0.25, r2);
    vec3 naCol = vec3(1.0, 0.84, 0.38);
    gl_FragColor = vec4(naCol, u_opacity * vFade * soft);
}`;

// ── Hop-layer shaders ───────────────────────────────────────────────────────
const HOP_VERT = /* glsl */`
attribute float a_phase;      // 0 rest · 1 fly · 2 escape · 3 adsorbed (cold trap)
varying float vPhase;
varying float vAlt;
void main() {
    vPhase = a_phase;
    vAlt = length(position) - 1.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float sz = (a_phase == 1.0) ? 7.0 : (a_phase == 2.0) ? 5.0 : 4.0;
    gl_PointSize = min(10.0, sz * 2.2 / max(0.25, -mv.z));
    gl_Position = projectionMatrix * mv;
}`;
const HOP_FRAG = /* glsl */`
precision mediump float;
uniform vec3 u_color;
varying float vPhase;
varying float vAlt;
void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float soft = 1.0 - smoothstep(0.04, 0.25, r2);
    vec3 col = u_color;
    float a = 0.9;
    if (vPhase == 3.0) { col = mix(u_color, vec3(0.55, 0.75, 1.0), 0.7); a = 0.45; }   // adsorbed: cold, dim
    else if (vPhase == 0.0) { a = 0.35; }
    else if (vPhase == 2.0) { a = 0.9 * clamp(1.0 - vAlt / 1.6, 0.1, 1.0); }           // escaping: fades out
    gl_FragColor = vec4(col, a * soft);
}`;

/** Species → display colour (sRGB picks; Na is its D-line yellow, Ne its discharge orange). */
export const SPECIES_COLORS = Object.freeze({
    he: 0x9ad6ff, ne: 0xff8a5c, h2: 0xe8b4ff, ar: 0x7fe3ff, na: 0xffd166, k: 0xc77dff,
});
const HOP_CLEAR_R = 0.03;     // rendering clearance above the reference sphere (relief tops out at +0.025)
const HOP_COUNT = Object.freeze({ he: 1500, ne: 1500, h2: 1500, ar: 2000, na: 3000, k: 3000 });

// ═══════════════════════════════════════════════════════════════════════════
export class MoonExosphere {
    constructor(parent, sunDir = new THREE.Vector3(1, 0.15, 0.3), { radius = 1.0 } = {}) {
        this.group = new THREE.Group();
        this.group.name = 'moon-exosphere';
        this.group.scale.setScalar(radius);
        parent.add(this.group);

        this._disposables = [];
        const track = (o) => { this._disposables.push(o); return o; };

        // Kernel scale heights → moon-radius units (the falloff the shader draws)
        const na = speciesProfile('na');
        const he = speciesProfile('he');
        const hDay = na.scaleHeightDayKm / R_MOON_KM;      // suprathermal Na, ~0.15
        const hNight = he.scaleHeightNightKm / R_MOON_KM;  // cold thermal gas, ~0.07

        // Dawn limb: with spin axis +Y and the terminator at 90° from the sun,
        // surface points rotate from the (sunDir × up) side into sunlight.
        const dawnDir = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0, 1, 0)).normalize();

        this._glowU = {
            u_sun_dir: { value: sunDir.clone() },
            u_dawn_dir: { value: dawnDir },
            u_h_day: { value: hDay },
            u_h_night: { value: hNight },
            u_activity: { value: 1 },
            u_intensity: { value: 0.65 },
            u_mode: { value: 0 },
            u_sp_n: { value: new THREE.Vector3(1, 1, 0) },
            u_sp_flags: { value: new THREE.Vector3(0, 0, 2.5) },
            u_sp_h: { value: hDay },
            u_sp_norm: { value: 1 },
            u_sp_color: { value: new THREE.Color(0xffffff) },
            u_sp_consts: { value: new THREE.Vector4(DAY_K, NIGHT_K, SUNRISE_RELEASE_HOUR, SUNRISE_RELEASE_SIGMA_H) },
            u_sp_tau: { value: CONDENSATION_TAU_H },
        };
        const glowMat = track(new THREE.ShaderMaterial({
            vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
            uniforms: this._glowU, side: THREE.BackSide,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._glowMesh = new THREE.Mesh(track(new THREE.SphereGeometry(SHELL_R, 64, 48)), glowMat);
        this._glowMesh.renderOrder = 4;
        this.group.add(this._glowMesh);

        // Sodium tail — points in a local +X frame, rotated anti-sunward
        const N = 1100;
        const seeds = new Float32Array(N * 4);
        for (let i = 0; i < N; i++) {
            seeds[i * 4] = Math.random();                    // along-tail phase
            seeds[i * 4 + 1] = Math.random() * Math.PI * 2;      // azimuth in the cone
            seeds[i * 4 + 2] = Math.pow(Math.random(), 0.7);     // radial (edge-biased slightly in)
            seeds[i * 4 + 3] = 0.5 + Math.random();              // size
        }
        const tailGeo = track(new THREE.BufferGeometry());
        // Static placeholder positions — the vertex shader computes the real ones
        tailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
        tailGeo.setAttribute('a_seed', new THREE.Float32BufferAttribute(seeds, 4));
        // The cone spans the whole tail; give the culler the true bounds
        tailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(TAIL_SPAN / 2, 0, 0), TAIL_SPAN);

        this._tailU = {
            u_time: { value: 0 },
            u_strength: { value: 1 },
            u_opacity: { value: 0.5 },
        };
        const tailMat = track(new THREE.ShaderMaterial({
            vertexShader: TAIL_VERT, fragmentShader: TAIL_FRAG,
            uniforms: this._tailU,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._tailPoints = new THREE.Points(tailGeo, tailMat);
        this._tailPoints.renderOrder = 4;
        // Rotate local +X onto the anti-sunward direction
        this._tailPoints.quaternion.setFromUnitVectors(
            new THREE.Vector3(1, 0, 0),
            sunDir.clone().multiplyScalar(-1).normalize()
        );
        this.group.add(this._tailPoints);

        // Hop layer — points fed from the Monte-Carlo kernel each frame
        this._hopSim = null;
        this._hopSpecies = null;
        this._hopGeo = null;
        this._hopU = { u_color: { value: new THREE.Color(0xffffff) } };
        this._hopMat = track(new THREE.ShaderMaterial({
            vertexShader: HOP_VERT, fragmentShader: HOP_FRAG, uniforms: this._hopU,
            transparent: true, depthWrite: false,
        }));
        this._hopPoints = null;
        this._hopsOn = false;
        this._hopTrack = track;

        this._glowOn = true;
        this._tailOn = true;
        this._mode = true;   // surface-view visibility gate
        this._applyVisibility();
    }

    _applyVisibility() {
        this._glowMesh.visible = this._mode && this._glowOn;
        this._tailPoints.visible = this._mode && this._tailOn;
        if (this._hopPoints) this._hopPoints.visible = this._mode && this._hopsOn;
    }

    /** Live Sun (world frame): shell, dawn limb, tail axis and the hop sim all follow. */
    setSunDir(v) {
        const s = v.clone().normalize();
        this._glowU.u_sun_dir.value.copy(s);
        this._glowU.u_dawn_dir.value.crossVectors(s, new THREE.Vector3(0, 1, 0)).normalize();
        this._tailPoints.quaternion.setFromUnitVectors(
            new THREE.Vector3(1, 0, 0), s.clone().multiplyScalar(-1).normalize());
        if (this._hopSim) this._hopSim.setSunDir(s);
    }

    /**
     * Draw ONE species' map on the shell (key from SPECIES), or null for the
     * composite. Every number is the kernel's: densities, pooling exponent,
     * scale height at the species' source temperature.
     */
    setSpecies(key) {
        const u = this._glowU;
        const sp = key ? SPECIES.find(x => x.key === key) : null;
        if (!sp) { u.u_mode.value = 0; this.species = null; return; }
        const p = speciesProfile(key);
        const gamma = effectivePoolingExponent(key);
        u.u_mode.value = 1;
        u.u_sp_n.value.set(sp.dayCm3, sp.nightCm3, sp.sunriseCm3 ?? 0);
        u.u_sp_flags.value.set(sp.suprathermalK ? 1 : 0, sp.condensable ? 1 : 0, Number.isNaN(gamma) ? 2.5 : gamma);
        u.u_sp_h.value = p.scaleHeightDayKm / R_MOON_KM;
        u.u_sp_norm.value = 1 / Math.max(sp.dayCm3, sp.nightCm3, sp.sunriseCm3 ?? 0);
        u.u_sp_color.value.set(SPECIES_COLORS[key] ?? 0xffffff);
        this.species = key;
    }

    /** Start (or switch) the Monte-Carlo hop layer on a species. */
    setHopSpecies(key, { seed = 1 } = {}) {
        if (!SPECIES.find(x => x.key === key)) return;
        this._hopSpecies = key;
        const count = HOP_COUNT[key] ?? 1500;
        this._hopSim = createHopSim({ speciesKey: key, count, seed });
        this._hopSim.setSunDir(this._glowU.u_sun_dir.value);
        if (this._hopPoints) {
            this.group.remove(this._hopPoints);
            this._hopGeo.dispose();
        }
        this._hopGeo = new THREE.BufferGeometry();
        this._hopGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
        this._hopGeo.setAttribute('a_phase', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
        this._hopGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3);
        this._hopU.u_color.value.set(SPECIES_COLORS[key] ?? 0xffffff);
        this._hopPoints = new THREE.Points(this._hopGeo, this._hopMat);
        this._hopPoints.renderOrder = 5;
        this._hopPoints.frustumCulled = false;
        this.group.add(this._hopPoints);
        this._fillHops();
        this._applyVisibility();
    }
    setHopsVisible(v) { this._hopsOn = !!v; this._applyVisibility(); }
    get hopSpecies() { return this._hopSpecies; }
    get hopTimeCompression() { return DEFAULT_TIME_COMPRESSION; }
    hopStats() { return this._hopSim ? this._hopSim.stats() : null; }

    _fillHops() {
        const sim = this._hopSim;
        if (!sim || !this._hopGeo) return;
        const src = sim.positions;
        const phases = sim.phases;
        const posAttr = this._hopGeo.attributes.position;
        const phAttr = this._hopGeo.attributes.a_phase;
        const out = posAttr.array;
        const n = sim.count;
        for (let i = 0; i < n; i++) {
            const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
            const r = Math.hypot(x, y, z) || 1;
            const k = (r + HOP_CLEAR_R) / r;
            out[i * 3] = x * k; out[i * 3 + 1] = y * k; out[i * 3 + 2] = z * k;
            // Adsorbed (cold-trapped) atoms are resting atoms on the night side
            let ph = phases[i];
            if (ph === PHASE.REST && sim.zenithDeg(i) > 90) ph = 3;
            phAttr.array[i] = ph;
        }
        posAttr.needsUpdate = true;
        phAttr.needsUpdate = true;
    }

    /** Master gate — false in the interior cutaway view. */
    setVisible(v) { this._mode = !!v; this._applyVisibility(); }
    setGlowVisible(v) { this._glowOn = !!v; this._applyVisibility(); }
    setTailVisible(v) { this._tailOn = !!v; this._applyVisibility(); }

    /**
     * Feed the kernel's live sodium source total (×quiet). Glow and tail
     * brighten with the source; the magnetotail dip and shower spikes come
     * through this one number.
     */
    setActivity(total) {
        const a = Math.max(0, total);
        this._glowU.u_activity.value = a;
        this._tailU.u_strength.value = a;
        this._tailU.u_opacity.value = Math.min(0.85, 0.3 + 0.28 * a);
    }

    update(t, dtReal = 0) {
        this._tailU.u_time.value = t;
        if (this._hopSim && this._hopsOn && this._mode && dtReal > 0) {
            this._hopSim.step(dtReal);
            this._fillHops();
        }
    }

    dispose() {
        this.group.parent?.remove(this.group);
        this._hopGeo?.dispose();
        for (const o of this._disposables) o.dispose?.();
        this._disposables.length = 0;
    }
}
