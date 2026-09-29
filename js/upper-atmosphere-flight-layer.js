/**
 * upper-atmosphere-flight-layer.js — the flight, drawn
 * ═══════════════════════════════════════════════════════════════════════════
 * three.js renderer for one `Flight` from js/upper-atmosphere-flight.js.
 * It computes NO physics: every number it draws is a column of the
 * kernel's sample table, and every position is the kernel's own
 * `sceneAt` / `scenePositionOfRow` (ECI → Earth-fixed at each sample's
 * own sidereal angle). The scene is Earth-fixed, so a 24-hour ground
 * track drawn this way precesses westward under the orbit exactly as the
 * real one does — the ribbon is static geometry and only the head moves.
 *
 * WHAT IS ON SCREEN
 * ─────────────────
 *   • THE RIBBON — a screen-space-width polyline (custom shader; a
 *     LineBasicMaterial is 1 px on every platform that matters) coloured
 *     per sample by one of `COLOR_MODES` on a FIXED range, so the colour
 *     of a given altitude or q is the same in every flight and does not
 *     drift as the flight grows. Behind the head it fades with an
 *     e-folding `tailS`; ahead of it, it is dashed BY TIME (one dash per
 *     `dashS` of flight), so dash length is a speed ruler.
 *   • THE HEAD — additive core sprite + a generic bus model that shows
 *     when the camera is close, and a HEATING WAKE: an additive sprite
 *     stretched along −v_rel whose length and colour follow the kernel's
 *     Sutton–Graves proxy. It is a symbol for a number, not a plasma
 *     rendering, and the deck says which number.
 *   • THE VECTORS — velocity (green), gravity (cyan), drag (red), lift
 *     (violet) at the head. Accelerations span ten decades (8.7 m/s² of
 *     gravity against 1e-6 of drag at the ISS), so their arrow LENGTH is
 *     log₁₀|a| mapped over 1e-8…10 m/s² (`accelArrowLength`) and the deck
 *     prints the true values; the velocity arrow is a direction only.
 *   • THE GROUND TRACK on the surface, and a ring where the flight
 *     reached the model floor.
 *
 * THE CLOCK
 * ─────────
 * The head sits at mission time T+. By default T+ = (bus sim time − t0):
 * the flight is live-locked to the page's own clock, so the page's
 * scrubber and warp move it and scrubbing before the launch un-launches
 * it (the orrery's rope rule). The deck's own transport detaches it
 * (`mode: 'own'`) with its own rate and seek, because the page bus clamps
 * one hour into the future and a 24-hour decay cannot be played through
 * it. While detached the layer publishes `getSceneTimeMs()` and the globe
 * pins the sun / terminator to it, so warping a day of flight sweeps the
 * bulge under the orbit. The layer times itself with the wall clock — the
 * globe's `dt` is ~0 every frame (plan §6).
 *
 * Integration is CHUNKED: `update()` gives the kernel a few milliseconds
 * per frame until the flight is done and keeps a look-ahead ahead of the
 * head, so a 7-day decay never stalls a frame and the ribbon visibly grows.
 */

import * as THREE from 'three';
import { COL, STRIDE, STATUS, R_EARTH_KM } from './upper-atmosphere-flight.js';
import { buildGenericSatModel } from './satellite-models.js';

// ── Colour modes: FIXED ranges, so colour means the same thing in every flight
const RAMP_SEQ = [
    [0.06, 0.05, 0.35], [0.05, 0.45, 0.95], [0.10, 0.90, 0.85],
    [0.70, 0.98, 0.35], [1.00, 0.85, 0.20], [1.00, 0.45, 0.15], [1.00, 0.95, 0.90],
];
const RAMP_DIV = [
    [0.15, 0.40, 1.00], [0.40, 0.75, 1.00], [0.92, 0.94, 0.98], [1.00, 0.55, 0.35], [1.00, 0.20, 0.15],
];
export const COLOR_MODES = Object.freeze({
    altitude: { label: 'altitude', col: COL.ALT,   unit: 'km',    log: true,  min: 80,   max: 2000, ramp: RAMP_SEQ },
    speed:    { label: '|v|',      col: COL.SPEED, unit: 'km/s',  log: false, min: 0,    max: 11,   ramp: RAMP_SEQ },
    q:        { label: 'drag q',   col: COL.Q,     unit: 'Pa',    log: true,  min: 1e-8, max: 10,   ramp: RAMP_SEQ },
    heating:  { label: 'heating',  col: COL.HEAT,  unit: 'W/cm²', log: true,  min: 1e-4, max: 100,  ramp: RAMP_SEQ },
    energy:   { label: 'energy ε', col: COL.ENERGY, unit: 'km²/s²', log: false, min: -35, max: 5,   ramp: RAMP_DIV },
    gload:    { label: 'g-load',   col: COL.GLOAD, unit: 'g',     log: true,  min: 1e-4, max: 1,    ramp: RAMP_SEQ },
});

export function rampColor(ramp, u, out = [0, 0, 0]) {
    const x = Math.max(0, Math.min(1, u)) * (ramp.length - 1);
    const i = Math.min(Math.floor(x), ramp.length - 2), f = x - i;
    for (let k = 0; k < 3; k++) out[k] = ramp[i][k] + f * (ramp[i + 1][k] - ramp[i][k]);
    return out;
}
export function normalise(mode, value) {
    const m = COLOR_MODES[mode] || COLOR_MODES.altitude;
    if (!Number.isFinite(value)) return 0;
    if (m.log) {
        const v = Math.max(value, m.min);
        return (Math.log10(v) - Math.log10(m.min)) / (Math.log10(m.max) - Math.log10(m.min));
    }
    return (value - m.min) / (m.max - m.min);
}

/** Arrow length (R⊕) for an acceleration in m/s²: log₁₀ over 1e-8…10. */
export function accelArrowLength(aMs2) {
    if (!(aMs2 > 0)) return 0;
    const u = Math.max(0, Math.min(1, (Math.log10(aMs2) + 8) / 9));
    return 0.04 + 0.26 * u;
}
export const VELOCITY_ARROW_LENGTH = 0.22;

const RIBBON_VERT = /* glsl */`
    attribute vec3 aPrev;
    attribute vec3 aNext;
    attribute float aSide;
    attribute float aT;
    attribute vec3 aColor;
    uniform vec2 uResolution;
    uniform float uWidthPx;
    uniform float uNowT;
    varying vec3 vColor;
    varying float vT;
    varying float vSide;
    void main() {
        mat4 mvp = projectionMatrix * modelViewMatrix;
        vec4 cur = mvp * vec4(position, 1.0);
        vec4 pr  = mvp * vec4(aPrev, 1.0);
        vec4 nx  = mvp * vec4(aNext, 1.0);
        vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
        vec2 cs = cur.xy / max(cur.w, 1e-6) * aspect;
        vec2 ps = pr.xy  / max(pr.w,  1e-6) * aspect;
        vec2 ns = nx.xy  / max(nx.w,  1e-6) * aspect;
        vec2 d1 = ns - cs;
        vec2 d2 = cs - ps;
        vec2 dir = d1 + d2;
        float dl = length(dir);
        dir = dl < 1e-7 ? vec2(1.0, 0.0) : dir / dl;
        vec2 nrm = vec2(-dir.y, dir.x) / aspect;
        // Recent past and the head are drawn a little wider so the eye
        // finds the body; the far tail and the future stay thin.
        float dt = uNowT - aT;
        float headBoost = dt >= 0.0 ? 1.0 + 0.7 * exp(-dt / 600.0) : 1.0;
        float halfW = uWidthPx * headBoost / uResolution.y;
        cur.xy += nrm * aSide * halfW * cur.w;
        gl_Position = cur;
        vColor = aColor;
        vT = aT;
        vSide = aSide;
    }
`;
const RIBBON_FRAG = /* glsl */`
    precision highp float;
    uniform float uNowT;
    uniform float uTailS;
    uniform float uDashS;
    uniform float uOpacity;
    uniform float uFutureOn;
    uniform float uUnderlay;
    varying vec3 vColor;
    varying float vT;
    varying float vSide;
    void main() {
        float dt = uNowT - vT;
        float a;
        if (dt >= 0.0) {
            a = 0.38 + 0.62 * exp(-dt / uTailS);
        } else {
            // Dashed by TIME: one dash per uDashS seconds of flight.
            float ph = fract(-dt / uDashS);
            a = uFutureOn * (0.30 + 0.55 * step(ph, 0.55));
        }
        float across = abs(vSide);
        float soft = 1.0 - smoothstep(0.55, 1.0, across);
        float core = 1.0 - smoothstep(0.0, 0.40, across);
        vec3 c = vColor * (0.8 + 0.9 * core);
        // uUnderlay = 1 draws the same strip as a dark, wider outline beneath
        // the coloured pass, which is what keeps the ribbon legible across
        // the white limb band and the page's other overlays.
        if (uUnderlay > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, a * soft * 0.7); return; }
        gl_FragColor = vec4(c, a * soft * uOpacity);
    }
`;

function _softDotTexture(size = 64) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
}
function _wakeTexture(w = 128, h = 32) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    // Bright at the body (right edge), fading down the wake (left).
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    // Soft vertical falloff.
    const v = g.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(0,0,0,1)');
    v.addColorStop(0.5, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = v;
    g.fillRect(0, 0, w, h);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
}

const MAX_RIBBON_SAMPLES = 80000;

export class FlightLayer {
    /**
     * @param {THREE.Scene} scene
     * @param {object} deps
     * @param {Function} deps.getSimTimeMs   the page bus's sim time
     */
    constructor(scene, { getSimTimeMs } = {}) {
        this._scene = scene;
        this._getSimTimeMs = getSimTimeMs || (() => Date.now());
        this._flight = null;
        this._colorMode = 'altitude';
        this._options = { ribbon: true, vectors: true, groundTrack: true, wake: true, future: true };
        this._clock = { mode: 'live', tS: 0, rate: 1, playing: true };
        this._lastWallMs = null;
        this._builtN = 0;
        this._lastBuildMs = 0;
        this._sample = new Float64Array(STRIDE);
        this._haveSample = false;
        this._launched = false;
        this._tmpV = new THREE.Vector3();
        this._tmpV2 = new THREE.Vector3();

        this.group = new THREE.Group();
        this.group.name = 'flight-layer';
        this.group.visible = false;
        scene.add(this.group);

        // ── ribbon
        this._cap = 4096;
        this._allocRibbon(this._cap);
        const mkMat = (underlay) => new THREE.ShaderMaterial({
            vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
            uniforms: {
                uResolution: { value: new THREE.Vector2(1280, 720) },
                uWidthPx:    { value: underlay ? 8.5 : 4.2 },
                uNowT:       { value: 0 },
                uTailS:      { value: 1800 },
                uDashS:      { value: 120 },
                uOpacity:    { value: 1 },
                uFutureOn:   { value: 1 },
                uUnderlay:   { value: underlay ? 1 : 0 },
            },
            transparent: true, depthWrite: false, depthTest: true,
            blending: underlay ? THREE.NormalBlending : THREE.AdditiveBlending,
            side: THREE.DoubleSide,
        });
        this._ribbonMat = mkMat(false);
        this._underMat = mkMat(true);
        this._ribbon = new THREE.Mesh(this._ribbonGeo, this._ribbonMat);
        this._ribbon.frustumCulled = false;
        this._ribbon.renderOrder = 4;
        this._ribbon.userData = { kind: 'flight-ribbon' };
        this._under = new THREE.Mesh(this._ribbonGeo, this._underMat);
        this._under.frustumCulled = false;
        this._under.renderOrder = 3;
        this.group.add(this._under);
        this.group.add(this._ribbon);

        // ── ground track
        this._trackPos = new Float32Array(MAX_RIBBON_SAMPLES * 3);
        this._trackGeo = new THREE.BufferGeometry();
        this._trackGeo.setAttribute('position', new THREE.BufferAttribute(this._trackPos, 3));
        this._trackGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        this._trackGeo.setDrawRange(0, 0);
        this._track = new THREE.Line(this._trackGeo, new THREE.LineBasicMaterial({
            color: 0x9fe8ff, transparent: true, opacity: 0.32, depthWrite: false,
        }));
        this._track.frustumCulled = false;
        this._track.userData = { kind: 'flight-groundtrack' };
        this.group.add(this._track);

        // ── head
        this._head = new THREE.Group();
        this._head.name = 'flight-head';
        const dotTex = _softDotTexture();
        this._core = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTex, color: 0xffffff, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this._core.scale.set(0.055, 0.055, 1);
        this._core.renderOrder = 6;
        this._head.add(this._core);
        this._halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTex, color: 0x5fd8ff, transparent: true, opacity: 0.45, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this._halo.scale.set(0.11, 0.11, 1);
        this._halo.renderOrder = 5;
        this._head.add(this._halo);
        // A bus model for close range; the LOD swaps it in under 0.08 R⊕.
        this._model = buildGenericSatModel('#dfe9f5');
        this._model.scale.setScalar(0.45);
        this._lod = new THREE.LOD();
        this._lod.addLevel(this._model, 0);
        this._lod.addLevel(new THREE.Group(), 0.08);
        this._head.add(this._lod);
        this._head.userData = { kind: 'flight-head', tooltip: 'Flight probe — see the flight deck.' };
        this.group.add(this._head);

        // ── wake (heating)
        this._wake = new THREE.Sprite(new THREE.SpriteMaterial({
            map: _wakeTexture(), color: 0xffa040, transparent: true, opacity: 0,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._wake.center.set(1.0, 0.5);       // anchored at the body, extends behind
        this._wake.renderOrder = 5;
        this.group.add(this._wake);

        // ── vectors
        const mk = (hex) => {
            const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.2, hex, 0.045, 0.02);
            a.line.material.transparent = true; a.line.material.depthWrite = false;
            a.cone.material.transparent = true; a.cone.material.depthWrite = false;
            a.renderOrder = 7;
            return a;
        };
        this._arrows = {
            velocity: mk(0x62f59a), gravity: mk(0x58d8ff), drag: mk(0xff5a5a), lift: mk(0xc48cff),
        };
        for (const k in this._arrows) this.group.add(this._arrows[k]);

        // ── floor / end marker
        this._endRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.028, 0.003, 8, 40),
            new THREE.MeshBasicMaterial({ color: 0xff7a5a, transparent: true, opacity: 0.85,
                                          depthWrite: false, blending: THREE.AdditiveBlending }));
        this._endRing.visible = false;
        this._endRing.renderOrder = 6;
        this.group.add(this._endRing);
    }

    _allocRibbon(cap) {
        this._cap = cap;
        const nv = cap * 2;
        this._rPos  = new Float32Array(nv * 3);
        this._rPrev = new Float32Array(nv * 3);
        this._rNext = new Float32Array(nv * 3);
        this._rSide = new Float32Array(nv);
        this._rT    = new Float32Array(nv);
        this._rCol  = new Float32Array(nv * 3);
        const idx = new Uint32Array((cap - 1) * 6);
        for (let i = 0; i < cap - 1; i++) {
            const a = i * 2, b = a + 1, c = a + 2, d = a + 3, o = i * 6;
            idx[o] = a; idx[o + 1] = b; idx[o + 2] = c;
            idx[o + 3] = b; idx[o + 4] = d; idx[o + 5] = c;
        }
        const geo = new THREE.BufferGeometry();
        const attr = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
        geo.setAttribute('position', attr(this._rPos, 3));
        geo.setAttribute('aPrev', attr(this._rPrev, 3));
        geo.setAttribute('aNext', attr(this._rNext, 3));
        geo.setAttribute('aSide', attr(this._rSide, 1));
        geo.setAttribute('aT', attr(this._rT, 1));
        geo.setAttribute('aColor', attr(this._rCol, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.setDrawRange(0, 0);
        if (this._ribbonGeo) {
            this._ribbonGeo.dispose();
            this._ribbon.geometry = geo;
            this._under.geometry = geo;
        }
        this._ribbonGeo = geo;
    }

    // ── public: flight ───────────────────────────────────────────────────
    setFlight(flight, { colorMode = null } = {}) {
        this._flight = flight;
        if (colorMode && COLOR_MODES[colorMode]) this._colorMode = colorMode;
        this._builtN = 0;
        this._clock = { mode: 'live', tS: 0, rate: 1, playing: true };
        this._endRing.visible = false;
        this.group.visible = !!flight;
        this._haveSample = false;
        this._launched = false;
        if (flight) this._rebuild(true);
    }
    clear() { this.setFlight(null); }
    getFlight() { return this._flight; }
    hasFlight() { return !!this._flight; }

    setColorMode(mode) {
        if (!COLOR_MODES[mode]) return;
        this._colorMode = mode;
        this._builtN = 0;
        if (this._flight) this._rebuild(true);
    }
    getColorMode() { return this._colorMode; }

    setOptions(o = {}) {
        Object.assign(this._options, o);
        this._ribbon.visible = !!this._options.ribbon;
        this._under.visible = !!this._options.ribbon;
        this._track.visible = !!this._options.groundTrack;
        this._ribbonMat.uniforms.uFutureOn.value = this._options.future ? 1 : 0;
        this._underMat.uniforms.uFutureOn.value = this._options.future ? 1 : 0;
    }
    getOptions() { return { ...this._options }; }

    // ── public: clock ────────────────────────────────────────────────────
    getClock() {
        const f = this._flight;
        return {
            ...this._clock,
            tEndS: f ? f.tEndS : 0,
            done: f ? f.done : true,
            status: f ? f.status : null,
            launched: this._launched,
        };
    }
    setClockMode(mode) {
        if (mode === this._clock.mode) return;
        if (mode === 'live') {
            this._clock.mode = 'live';
        } else {
            // Detach at the current head time so nothing jumps.
            this._clock.mode = 'own';
            this._clock.playing = true;
        }
        this._lastWallMs = null;
    }
    setRate(r) { if (Number.isFinite(r) && r > 0) { this._clock.rate = r; this.setClockMode('own'); } }
    play()  { this.setClockMode('own'); this._clock.playing = true; }
    pause() { this.setClockMode('own'); this._clock.playing = false; }
    seek(tS) {
        this.setClockMode('own');
        this._clock.tS = Math.max(0, tS);
        this._clock.playing = false;
    }
    /** Unix ms of the head's instant — what the globe pins the sun to. */
    getSceneTimeMs() {
        if (!this._flight || this._clock.mode !== 'own') return null;
        return this._flight.t0Ms + this._clock.tS * 1000;
    }

    // ── public: state at the head ────────────────────────────────────────
    /** The interpolated kernel row at the head, or null before launch. */
    currentSample() { return this._haveSample ? this._sample : null; }
    getHeadPosition() { return this._head.position; }
    isLaunched() { return this._launched; }

    // ── per frame ────────────────────────────────────────────────────────
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {number} width   canvas CSS px
     * @param {number} height
     */
    update(camera, width, height) {
        const f = this._flight;
        if (!f) return;
        const wall = performance.now();
        const dtWall = this._lastWallMs == null ? 0 : (wall - this._lastWallMs) / 1000;
        this._lastWallMs = wall;

        // Clock.
        const c = this._clock;
        if (c.mode === 'live') {
            c.tS = (this._getSimTimeMs() - f.t0Ms) / 1000;
        } else if (c.playing) {
            c.tS += dtWall * c.rate;
        }
        // Keep the kernel ahead of the head (10 min look-ahead) and, until
        // the flight is finished, give it a few ms a frame regardless.
        if (!f.done) {
            const want = c.tS + 600;
            f.step({ untilS: Math.max(want, f.tS + 1),
                     budgetMs: c.mode === 'own' && c.playing ? 8 : 5, maxSteps: 20000 });
        }
        if (f.done && c.mode === 'own' && c.tS > f.tEndS) { c.tS = f.tEndS; c.playing = false; }
        // A slow renderer can be out-run by a fast clock: the head then waits
        // at the integration frontier instead of vanishing off the end.
        if (!f.done && c.mode === 'own' && c.tS > f.tEndS) c.tS = f.tEndS;
        if (c.mode === 'own' && c.tS < 0) c.tS = 0;

        // Geometry catch-up (throttled while integrating).
        if (f.n !== this._builtN && (f.done || wall - this._lastBuildMs > 200)) this._rebuild(false);

        for (const m of [this._ribbonMat, this._underMat]) {
            m.uniforms.uResolution.value.set(Math.max(1, width), Math.max(1, height));
            m.uniforms.uNowT.value = c.tS;
        }

        // Head.
        const s = f.sampleAt(c.tS, this._sample);
        this._launched = c.tS >= 0 && !!s;
        this._haveSample = !!s;
        if (!s) {
            this._head.visible = false; this._wake.visible = false;
            for (const k in this._arrows) this._arrows[k].visible = false;
            return;
        }
        const pos = f.sceneAt(c.tS, [0, 0, 0], s);
        this._head.visible = true;
        this._head.position.set(pos[0], pos[1], pos[2]);
        this._lod.update(camera);
        const camDist = camera.position.distanceTo(this._head.position);
        // Keep the core a readable size at any range without letting it
        // balloon into a lamp when the camera is on top of it.
        const sc = Math.max(0.010, Math.min(0.09, camDist * 0.022));
        // Glyph scale: arrows are world-space geometry and at chase range a
        // full-size cone filled the frame (measured). Shrink them with the
        // camera distance so they read the same at any range.
        const ak = Math.max(0.06, Math.min(1, camDist / 2.4));
        this._core.scale.set(sc, sc, 1);
        this._halo.scale.set(sc * 2.1, sc * 2.1, 1);
        // Core colour follows the ribbon's current value.
        const m = COLOR_MODES[this._colorMode];
        const rgb = rampColor(m.ramp, normalise(this._colorMode, s[m.col]));
        this._core.material.color.setRGB(rgb[0], rgb[1], rgb[2]).lerp(new THREE.Color(1, 1, 1), 0.55);

        // Vectors: directions from the ECI velocity / radial / drag, rotated
        // into the scene at the head's sidereal angle.
        const v = f.sceneDirectionAt([s[COL.VX], s[COL.VY], s[COL.VZ]], c.tS);
        const vlen = Math.hypot(v[0], v[1], v[2]) || 1;
        const vDir = this._tmpV.set(v[0] / vlen, v[1] / vlen, v[2] / vlen);
        const up = this._tmpV2.copy(this._head.position).normalize();
        const showVec = this._options.vectors;
        const A = this._arrows;
        const place = (arrow, dir, len0, on) => {
            const len = len0 * ak;
            arrow.visible = on && len > 0;
            if (!arrow.visible) return;
            arrow.position.copy(this._head.position);
            arrow.setDirection(dir);
            arrow.setLength(len, Math.min(0.045 * ak, len * 0.35), Math.min(0.02 * ak, len * 0.18));
        };
        place(A.velocity, vDir, VELOCITY_ARROW_LENGTH, showVec);
        place(A.gravity, up.clone().negate(), accelArrowLength(s[COL.AGRAV]), showVec);
        // Drag is anti-parallel to the air-relative wind, which differs from
        // −v̂ by the co-rotation term; at LEO speeds the difference is a few
        // degrees, so −v̂ is drawn and the deck prints |v_rel| beside |v|.
        place(A.drag, vDir.clone().negate(), accelArrowLength(s[COL.ADRAG]), showVec && s[COL.ADRAG] > 1e-8);
        if (s[COL.ALIFT] > 1e-8) {
            const l = up.clone().sub(vDir.clone().multiplyScalar(up.dot(vDir)));
            if (l.lengthSq() > 1e-9) place(A.lift, l.normalize(), accelArrowLength(s[COL.ALIFT]), showVec);
            else A.lift.visible = false;
        } else A.lift.visible = false;

        // Wake: length + brightness follow the heating proxy (log over
        // 1e-3…100 W/cm²), stretched along −v on screen.
        const heat = s[COL.HEAT];
        const hu = heat > 0 ? Math.max(0, Math.min(1, (Math.log10(heat) + 3) / 5)) : 0;
        // Below ~0.06 W/cm² (LEO cruise is ~0.01) the wake is decoration; it
        // appears once heating means something.
        if (this._options.wake && hu > 0.35) {
            this._wake.visible = true;
            this._wake.position.copy(this._head.position);
            const len = sc * (1.5 + 9 * hu);
            this._wake.scale.set(len, sc * (0.8 + 1.2 * hu), 1);
            // Screen angle of the velocity direction.
            const p0 = this._head.position.clone().project(camera);
            const p1 = this._head.position.clone().addScaledVector(vDir, 0.02).project(camera);
            const ang = Math.atan2((p1.y - p0.y), (p1.x - p0.x) * (width / Math.max(1, height)));
            this._wake.material.rotation = ang;
            this._wake.material.opacity = 0.25 + 0.75 * hu;
            // Blue-white when hot, orange when mild — a blackbody cue.
            this._wake.material.color.setRGB(1, 0.55 + 0.45 * hu, 0.25 + 0.75 * hu * hu);
        } else {
            this._wake.visible = false;
        }
    }

    _rebuild(force) {
        const f = this._flight;
        if (!f) return;
        const n = Math.min(f.n, MAX_RIBBON_SAMPLES);
        if (n > this._cap) this._allocRibbon(Math.min(MAX_RIBBON_SAMPLES, Math.max(n, this._cap * 2)));
        const from = force ? 0 : Math.max(0, this._builtN - 2);
        const m = COLOR_MODES[this._colorMode];
        const p = [0, 0, 0], rgb = [0, 0, 0];
        const d = f.data;
        for (let i = from; i < n; i++) {
            f.scenePositionOfRow(i, p);
            const t = d[i * STRIDE + COL.T];
            rampColor(m.ramp, normalise(this._colorMode, d[i * STRIDE + m.col]), rgb);
            for (let k = 0; k < 2; k++) {
                const vi = i * 2 + k;
                this._rPos[vi * 3] = p[0]; this._rPos[vi * 3 + 1] = p[1]; this._rPos[vi * 3 + 2] = p[2];
                this._rSide[vi] = k === 0 ? -1 : 1;
                this._rT[vi] = t;
                this._rCol[vi * 3] = rgb[0]; this._rCol[vi * 3 + 1] = rgb[1]; this._rCol[vi * 3 + 2] = rgb[2];
            }
            // Ground track at 1.003 R⊕.
            const r = Math.hypot(p[0], p[1], p[2]) || 1;
            this._trackPos[i * 3] = p[0] / r * 1.003;
            this._trackPos[i * 3 + 1] = p[1] / r * 1.003;
            this._trackPos[i * 3 + 2] = p[2] / r * 1.003;
        }
        // prev/next tangents (endpoints repeat themselves).
        for (let i = Math.max(0, from - 1); i < n; i++) {
            const ip = Math.max(0, i - 1), inx = Math.min(n - 1, i + 1);
            for (let k = 0; k < 2; k++) {
                const vi = i * 2 + k;
                for (let a = 0; a < 3; a++) {
                    this._rPrev[vi * 3 + a] = this._rPos[(ip * 2) * 3 + a];
                    this._rNext[vi * 3 + a] = this._rPos[(inx * 2) * 3 + a];
                }
            }
        }
        const g = this._ribbonGeo;
        for (const name of ['position', 'aPrev', 'aNext', 'aSide', 'aT', 'aColor']) g.attributes[name].needsUpdate = true;
        g.setDrawRange(0, Math.max(0, (n - 1) * 6));
        this._trackGeo.attributes.position.needsUpdate = true;
        this._trackGeo.setDrawRange(0, n);
        this._builtN = n;
        this._lastBuildMs = performance.now();

        if (f.done && f.status === STATUS.FLOOR && n > 0) {
            f.scenePositionOfRow(n - 1, p);
            this._endRing.visible = true;
            this._endRing.position.set(p[0], p[1], p[2]);
            this._endRing.lookAt(0, 0, 0);
        }
    }

    dispose() {
        this._scene.remove(this.group);
        this._ribbonGeo.dispose(); this._ribbonMat.dispose(); this._underMat.dispose();
        this._trackGeo.dispose(); this._track.material.dispose();
        this._core.material.map?.dispose(); this._core.material.dispose();
        this._halo.material.dispose(); this._wake.material.map?.dispose(); this._wake.material.dispose();
        this._endRing.geometry.dispose(); this._endRing.material.dispose();
    }
}
