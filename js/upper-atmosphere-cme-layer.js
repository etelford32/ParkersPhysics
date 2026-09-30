/**
 * upper-atmosphere-cme-layer.js — the incoming CME on upper-atmosphere.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws what js/upper-atmosphere-cme-model.js computes (read its header for
 * the frame join and the two scales). This module computes NO flux-rope
 * physics and must never gain any:
 *
 *   • the forecast is the ONE shared provider's result — started here with
 *     `startFluxRopeProvider` (js/sun-flux-rope.js, the sun.html / hero
 *     convention) and read from `window.__fluxRopeForecast` / the
 *     'flux-rope-forecast' event; no ensemble is ever run here;
 *   • rope geometry is `corridor/corridor-model.js` `trainAt` (the live
 *     kernel's apex / σ probes, the pinned mirror as the fallback), the
 *     surface `stage/model.js` `ropeSurfaceGrid`, the axis `ropeAxisPoints`;
 *   • every colour that means FIELD is `kernel.fieldAt` — rope skins (Bz
 *     just inside the boundary, σ×0.8, the Stage / hero rule) and the
 *     near-Earth field lines, red south / blue north.
 *
 * Honesty, as the other rope consumers:
 *   • LIVE when the provider has an Earth-relevant train. When it is idle
 *     (most days) or failed, the layer replays the validated Gannon May
 *     2024 train on its own kernel instance (`gannonReplay`, the hero's
 *     factory) and the chip says REPLAY and why — feeds down must look
 *     down, never quiet. A dead provider draws no LIVE rope, ever.
 *   • The corridor is compressed and the panel prints by how much; the
 *     field lines near Earth are true scale, clipped at the magnetopause,
 *     not draped.
 *   • Ropes are ballistic: their heading is the Sun line of the instant
 *     drawn, and they do not co-rotate with the Earth-fixed scene (the
 *     frame turns under them at the sidereal rate, which is the Sun line
 *     moving across the sky — correct).
 *
 * THE CME CLOCK. The layer draws at τ. Live, τ follows the page's scene
 * clock (the time bus); the scrubber sets τ inside the train's window
 * WITHOUT moving the page clock (satellites, the Sun and the atmosphere
 * stay at the page's instant — the panel says so). Replay has only its own
 * clock.
 */

import * as THREE from 'three';
import { trainAt } from './corridor/corridor-model.js';
import { ropeSurfaceGrid, ropeAxisPoints } from './stage/model.js';
import { AU_KM, RSUN_KM } from './stage/scale.js';
import {
    CME_VIEW, eclipticNorthScene, ropeBasisScene, corridorPointToScene, mapCorridorSurface,
    passedFade, traceImfLines, hoursToReach, cmeWindow, corridorCompression, toGse, sceneToHelioKm,
    corridorRadiusRe,
} from './upper-atmosphere-cme-model.js';

const N_PSI = 48;
const N_THETA = 20;
const ROPE_COLORS = [0xffb454, 0x4fc3f7, 0xc792ea, 0x7fe6c3, 0xff8866, 0xffd75e];   // the corridor's
const BZ_SOUTH = [0.95, 0.30, 0.18];
const BZ_NORTH = [0.15, 0.65, 0.95];
const FIELD_MS = 260;        // rope-skin field sampling cadence
const LINES_MS = 250;        // near-Earth field-line re-trace cadence
const MAX_LINE_VERTS = 12000;

const ROPE_VS = /* glsl */`
    attribute vec4 aField;
    varying vec4 vField;
    varying vec3 vN;
    varying vec3 vView;
    varying float vEarthR;
    varying float vCamD;
    void main() {
        vField = aField;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vEarthR = length(wp.xyz);
        vec4 mv = viewMatrix * wp;
        vCamD = -mv.z;
        vN = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
    }
`;
// Rim from |n·v| on a DOUBLE-SIDED surface with real normals — not the
// pow(rim) on a back face that is identically 1 (the orrery S3 scar).
const ROPE_FS = /* glsl */`
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform vec2 uNearFade;
    uniform vec2 uEarthFade;
    varying vec4 vField;
    varying vec3 vN;
    varying vec3 vView;
    varying float vEarthR;
    varying float vCamD;
    void main() {
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vView)));
        vec3 c = mix(uColor, vField.rgb, vField.a);
        float a = uOpacity * (0.18 + 0.62 * rim * rim);
        a *= smoothstep(uNearFade.x, uNearFade.y, vCamD);
        a *= smoothstep(uEarthFade.x, uEarthFade.y, vEarthR);
        if (a < 0.003) discard;
        gl_FragColor = vec4(c, a);
    }
`;

function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,244,214,1)');
    grd.addColorStop(0.18, 'rgba(255,214,140,0.9)');
    grd.addColorStop(0.45, 'rgba(255,150,60,0.28)');
    grd.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function labelSprite(text, color = '#cfd8ff') {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = '600 30px ui-monospace, Menlo, monospace';
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, sizeAttenuation: false });
    const s = new THREE.Sprite(m);
    s.scale.set(0.09, 0.0225, 1);
    return s;
}

export class CmeLayer {
    /**
     * @param {THREE.Scene} scene
     * @param {object} hooks
     * @param {() => THREE.Vector3} hooks.getSunDir       unit Earth→Sun (scene, live reference ok)
     * @param {(ms:number) => number} hooks.getGmstRad    sidereal angle at an instant
     * @param {() => number} hooks.getSceneTimeMs          the page clock
     * @param {() => {r0:number, alpha:number}|null} hooks.getMagnetopause
     */
    constructor(scene, { getSunDir, getGmstRad, getSceneTimeMs, getMagnetopause }) {
        this.scene = scene;
        this.hooks = { getSunDir, getGmstRad, getSceneTimeMs, getMagnetopause };
        this.root = new THREE.Group();
        this.root.name = 'cme-layer';
        this.root.visible = false;
        scene.add(this.root);

        this.status = { state: 'off', source: null, reason: null, updatedMs: null };
        this.fc = null;                 // the forecast being drawn (live or replay)
        this.liveFc = null;             // the provider's latest
        this.replayFc = null;
        this.mode = 'auto';             // 'auto' (live if any, else replay) | 'replay'
        this.clock = { follow: true, tauMs: null, playing: false, rateH: 2 };   // hours per second
        this.ropes = [];                // per rope index: { mesh, axis, fielded }
        this._lastField = 0;
        this._lastLines = 0;
        this._linesKey = '';
        this._atEarth = null;
        this._ropeRows = [];
        this._enabled = false;
        this._onFc = (ev) => this._adoptLive(ev.detail);

        this._buildSun();
        this._buildRuler();
        this._buildLines();
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    async enable() {
        if (this._enabled) return;
        this._enabled = true;
        this.root.visible = true;
        this.status = { ...this.status, state: 'loading' };
        window.addEventListener('flux-rope-forecast', this._onFc);
        if (window.__fluxRopeForecast) this._adoptLive(window.__fluxRopeForecast);
        // ONE provider per page: start it only if nobody has.
        if (!window.__fluxRopeProviderStarted) {
            window.__fluxRopeProviderStarted = true;
            try {
                const { startFluxRopeProvider } = await import('./sun-flux-rope.js');
                this._provider = startFluxRopeProvider({ delayMs: 300 });
            } catch (e) {
                window.__fluxRopeProviderStarted = false;
                this._adoptLive({ idle: true, failed: true, reason: e?.message ?? String(e) });
            }
        }
    }

    disable() {
        this._enabled = false;
        this.root.visible = false;
        this.clock.playing = false;
        window.removeEventListener('flux-rope-forecast', this._onFc);
    }
    isEnabled() { return this._enabled; }

    dispose() {
        this.disable();
        this._provider?.dispose?.();
        if (this._provider) window.__fluxRopeProviderStarted = false;
        this.root.traverse((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
        this.scene.remove(this.root);
    }

    // ── forecast sources ───────────────────────────────────────────────────

    _adoptLive(fc) {
        this.liveFc = fc || null;
        if (!fc || this.mode === 'replay') return;     // a chosen replay stays until "Live" is pressed
        if (this.hasLive()) {
            // A fresh live run replaces what is drawn; the clock keeps following.
            this._setForecast(fc, { state: 'live', source: 'live', reason: null });
            return;
        }
        // Idle (nothing Earth-relevant in flight) or failed: the replay, and say why.
        const reason = fc.failed ? 'live feed down'
            : fc.reason === 'cme-train-passed' ? 'the last train has passed' : 'no Earth-relevant CME in flight';
        if (this.status.source === 'replay') this.status = { ...this.status, reason };
        else this.useReplay(reason);
    }

    /**
     * Draw the validated Gannon May 2024 replay (own kernel instance).
     * `reason` null ⇒ the user chose it (it then stays until "Live");
     * otherwise it is the automatic stand-in for a quiet or failed feed.
     */
    async useReplay(reason = null) {
        if (reason === null) this.mode = 'replay';
        if (!this.replayFc) {
            this.status = { ...this.status, state: 'loading', source: 'replay' };
            try {
                const { gannonReplay } = await import('./hero-rope-layer.js');
                this.replayFc = await gannonReplay();
            } catch (e) {
                this.status = { state: 'failed', source: null, reason: `replay unavailable: ${e?.message ?? e}`, updatedMs: Date.now() };
                return;
            }
        }
        this._setForecast(this.replayFc, { state: 'replay', source: 'replay', reason: reason ?? 'chosen' });
        // The replay starts at its launch and plays; its clock is its own.
        this.clock.follow = false;
        this.clock.tauMs = this.replayFc.launchMs;
        this.clock.playing = true;
        this.clock.rateH = 4;
    }

    /** Back to the provider's live result (if it has one). */
    useLive() {
        this.mode = 'auto';
        const fc = this.liveFc;
        if (fc && !fc.idle && !fc.failed && fc.preset) {
            this._setForecast(fc, { state: 'live', source: 'live', reason: null });
            this.clock.follow = true;
            this.clock.playing = false;
            return true;
        }
        return false;
    }
    hasLive() { const fc = this.liveFc; return !!(fc && !fc.idle && !fc.failed && fc.preset); }

    _setForecast(fc, status) {
        this.fc = fc;
        this.status = { ...status, updatedMs: Date.now() };
        this._buildRopes(fc);
        this._linesKey = '';
        this._lastField = 0;
    }

    // ── clock ──────────────────────────────────────────────────────────────

    getWindow() {
        if (!this.fc) return null;
        const nowMs = this.status.source === 'live' ? this.hooks.getSceneTimeMs() : null;
        return cmeWindow(this.fc, { nowMs });
    }
    getTau() {
        if (this.clock.follow && this.status.source === 'live') return this.hooks.getSceneTimeMs();
        return Number.isFinite(this.clock.tauMs) ? this.clock.tauMs : (this.fc?.launchMs ?? this.hooks.getSceneTimeMs());
    }
    setTau(ms) {
        if (!Number.isFinite(ms)) return;
        const w = this.getWindow();
        this.clock.tauMs = w ? Math.min(w.t1, Math.max(w.t0, ms)) : ms;
        this.clock.follow = false;
    }
    followPageClock() {
        if (this.status.source !== 'live') return false;
        this.clock.follow = true; this.clock.playing = false;
        return true;
    }
    setPlaying(on) {
        if (on && this.clock.follow) { this.clock.tauMs = this.getTau(); this.clock.follow = false; }
        this.clock.playing = !!on;
    }
    setRate(hoursPerSecond) { if (hoursPerSecond > 0) this.clock.rateH = hoursPerSecond; }

    // ── builders ───────────────────────────────────────────────────────────

    _buildSun() {
        const g = new THREE.Group();
        g.name = 'cme-sun';
        const core = new THREE.Mesh(
            new THREE.SphereGeometry(CME_VIEW.sunDrawnRe, 32, 16),
            new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        glow.scale.set(CME_VIEW.sunDrawnRe * 7, CME_VIEW.sunDrawnRe * 7, 1);
        g.add(core, glow);
        this._sun = g;
        this.root.add(g);
    }

    _buildRuler() {
        // Sun–Earth line with FIXED true-AU ticks (a ruler whose ticks moved
        // with zoom would not be a ruler). Rebuilt when the Sun line moves.
        this._ruler = new THREE.Group();
        const lineGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(6, 3));
        this._rulerLine = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({
            color: 0x8da2d8, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.45, depthWrite: false,
        }));
        this._ruler.add(this._rulerLine);
        this._ticks = [0.25, 0.5, 0.75].map((au) => {
            const m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 6),
                new THREE.MeshBasicMaterial({ color: 0x8da2d8, transparent: true, opacity: 0.7 }));
            const lab = labelSprite(`${au} AU`);
            this._ruler.add(m, lab);
            return { au, m, lab };
        });
        this.root.add(this._ruler);
    }

    _buildLines() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_LINE_VERTS * 3), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_LINE_VERTS * 3), 3));
        geo.setDrawRange(0, 0);
        this._lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
        }));
        this._lines.name = 'cme-imf-lines';
        this._lines.frustumCulled = false;
        this.root.add(this._lines);
        // B at Earth: an arrow on the Sun line just upstream of the bow shock.
        this._arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 7, 0xffffff, 1.6, 0.9);
        this._arrow.visible = false;
        this.root.add(this._arrow);
    }

    _buildRopes(fc) {
        for (const r of this.ropes) {
            this.root.remove(r.mesh, r.axis);
            r.mesh.geometry.dispose(); r.mesh.material.dispose();
            r.axis.geometry.dispose(); r.axis.material.dispose();
        }
        this.ropes = [];
        const ropes = fc?.preset?.ropes?.length ? fc.preset.ropes : (fc?.preset?.rope ? [fc.preset.rope] : []);
        const nV = (N_PSI + 1) * (N_THETA + 1);
        ropes.forEach((rope, i) => {
            const color = new THREE.Color(ROPE_COLORS[i % ROPE_COLORS.length]);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
            geo.setAttribute('aField', new THREE.BufferAttribute(new Float32Array(nV * 4), 4));
            const idx = ropeSurfaceGrid({ frame: { eDir: [1, 0, 0], eP: [0, 1, 0], nHat: [0, 0, 1] }, dAu: 1, sigApexAu: 0.1 },
                N_PSI, N_THETA).indices;
            geo.setIndex(new THREE.BufferAttribute(idx, 1));
            const mat = new THREE.ShaderMaterial({
                vertexShader: ROPE_VS, fragmentShader: ROPE_FS,
                uniforms: {
                    uColor: { value: color },
                    uOpacity: { value: 0.8 },
                    uNearFade: { value: new THREE.Vector2(2, 14) },
                    uEarthFade: { value: new THREE.Vector2(3.5, 11) },
                },
                transparent: true, depthWrite: false, side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.frustumCulled = false;
            mesh.name = `cme-rope-${i}`;
            mesh.userData = { kind: 'cme-rope', index: i, name: `CME rope ${i + 1}` };
            const axGeo = new THREE.BufferGeometry().setAttribute('position',
                new THREE.BufferAttribute(new Float32Array(65 * 3), 3));
            const axis = new THREE.Line(axGeo, new THREE.LineBasicMaterial({
                color, transparent: true, opacity: 0.55, depthWrite: false,
            }));
            axis.frustumCulled = false;
            this.root.add(mesh, axis);
            this.ropes.push({ rope, mesh, axis, fielded: false, apexAu: NaN });
        });
    }

    // ── per frame ──────────────────────────────────────────────────────────

    update(camera, dtSec) {
        if (!this._enabled) return;
        if (this.clock.playing && !this.clock.follow) {
            const w = this.getWindow();
            let t = (this.clock.tauMs ?? this.getTau()) + dtSec * this.clock.rateH * 3600e3;
            if (w && t > w.t1) { t = w.t1; this.clock.playing = false; }
            this.clock.tauMs = t;
        }
        const sd = this.hooks.getSunDir();
        if (!sd) return;
        const sunDir = [sd.x, sd.y, sd.z];
        const tau = this.getTau();
        // The frame at the PAGE's instant: the Earth-fixed scene is drawn at
        // the page clock, so the Sun line and ecliptic pole are the page's.
        const basis = ropeBasisScene(sunDir, eclipticNorthScene(this.hooks.getGmstRad(this.hooks.getSceneTimeMs())));
        this._basis = basis;
        this._sunDirArr = sunDir;

        // Sun + ruler.
        this._sun.position.set(sunDir[0] * CME_VIEW.sunRe, sunDir[1] * CME_VIEW.sunRe, sunDir[2] * CME_VIEW.sunRe);
        const lp = this._rulerLine.geometry.attributes.position;
        lp.setXYZ(0, 0, 0, 0);
        lp.setXYZ(1, this._sun.position.x, this._sun.position.y, this._sun.position.z);
        lp.needsUpdate = true;
        this._rulerLine.computeLineDistances();
        for (const tk of this._ticks) {
            const p = corridorPointToScene([tk.au, 0, 0], basis, sunDir);
            tk.m.position.set(p[0], p[1], p[2]);
            tk.lab.position.set(p[0] + basis.e3[0] * 4, p[1] + basis.e3[1] * 4, p[2] + basis.e3[2] * 4);
        }

        const fc = this.fc;
        const kernel = fc?.kernel ?? null;
        const train = fc?.preset ? trainAt(fc.preset, fc.launchMs, tau, kernel) : [];
        const now = performance.now();
        const doField = now - this._lastField > FIELD_MS;
        if (doField) this._lastField = now;
        const byIndex = new Map(train.map((m) => [m.index, m]));
        // Two scales share this scene: from inside the true-scale zone
        // (camera within ~60 R⊕ of Earth) the COMPRESSED surfaces would sit
        // around the true-scale field lines as walls that mean something
        // else, so they recede to a ghost; out in the corridor they are the
        // picture.
        const camR = camera.position.length();
        const zt = Math.min(1, Math.max(0, (camR - 50) / 40));
        const zone = 0.15 + 0.85 * zt * zt * (3 - 2 * zt);
        const rows = [];
        for (let i = 0; i < this.ropes.length; i++) {
            const r = this.ropes[i];
            const m = byIndex.get(i);
            if (!m) { r.mesh.visible = false; r.axis.visible = false; if (doField) rows.push(this._row(i, r.rope, null, kernel, tau)); continue; }
            const g = m.geometry;
            const fade = passedFade(g.dAu);
            r.mesh.visible = r.axis.visible = fade > 0.01;
            r.apexAu = g.dAu;
            if (r.mesh.visible) {
                const grid = ropeSurfaceGrid(g, N_PSI, N_THETA);
                const pos = r.mesh.geometry.attributes.position;
                mapCorridorSurface(grid.positions, basis, sunDir, pos.array);
                pos.needsUpdate = true;
                r.mesh.geometry.computeVertexNormals();
                r.mesh.material.uniforms.uOpacity.value = 0.8 * fade * zone;
                const ax = ropeAxisPoints(g, 64);
                const aPos = r.axis.geometry.attributes.position;
                const q = [0, 0, 0];
                for (let k = 0; k < 65; k++) {
                    corridorPointToScene([ax[k * 3], ax[k * 3 + 1], ax[k * 3 + 2]], basis, sunDir, q);
                    aPos.setXYZ(k, q[0], q[1], q[2]);
                }
                aPos.needsUpdate = true;
                r.axis.material.opacity = 0.55 * fade * (0.4 + 0.6 * zone);
                if (doField) this._colorRope(r, g, kernel);
            }
            if (doField) rows.push(this._row(i, r.rope, g, kernel, tau));
        }
        // The table (and its ETA bisection on the kernel) rides the field cadence.
        if (doField) this._ropeRows = rows;

        // Near-Earth field lines (true scale), re-traced on a leash.
        if (now - this._lastLines > LINES_MS) {
            this._lastLines = now;
            this._traceLines(kernel, fc, tau, basis, sunDir);
        }
    }

    _row(i, rope, g, kernel, tau) {
        const launchMs = (this.fc?.launchMs ?? 0) + (rope.launchOffsetS ?? 0) * 1000;
        let speed = null, etaH = null;
        const tTrain = (tau - (this.fc?.launchMs ?? tau)) / 1000;
        if (g && kernel && g.oracle === 'kernel') {
            const v = kernel.apexVKmsAt?.(i, g.tTrainS);
            speed = Number.isFinite(v) ? v : null;
            etaH = hoursToReach(kernel, i, g.tTrainS);
        }
        return {
            index: i, color: ROPE_COLORS[i % ROPE_COLORS.length],
            launchMs, launched: !!g, lonDeg: rope.lonDeg, latDeg: rope.latDeg, tiltDeg: rope.tiltDeg ?? 0,
            apexAu: g ? g.dAu : null, sigmaAu: g ? g.sigApexAu : null, speedKms: speed,
            etaH, oracle: g?.oracle ?? null, tTrainS: tTrain,
        };
    }

    _colorRope(r, g, kernel) {
        const attr = r.mesh.geometry.attributes.aField;
        if (!kernel || typeof kernel.fieldAt !== 'function' || g.oracle !== 'kernel') {
            if (r.fielded) { attr.array.fill(0); attr.needsUpdate = true; r.fielded = false; }
            return;
        }
        const inner = { ...g, sigApexAu: g.sigApexAu * 0.8 };
        const { positions } = ropeSurfaceGrid(inner, N_PSI, N_THETA);
        const tTrain = g.tTrainS ?? g.tS;
        const bAxis = Math.max(1, Math.abs(r.rope.b1AuNt ?? 20) * Math.pow(Math.max(g.dAu, 0.05), -(r.rope.nB ?? 1.64)));
        const a = attr.array;
        const n = positions.length / 3;
        for (let i = 0; i < n; i++) {
            const f = kernel.fieldAt(tTrain, positions[i * 3] * AU_KM, positions[i * 3 + 1] * AU_KM, positions[i * 3 + 2] * AU_KM);
            const o = i * 4;
            if (f.inside && Number.isFinite(f.bz)) {
                const mag = Math.min(1, Math.abs(f.bz) / bAxis);
                const c = f.bz < 0 ? BZ_SOUTH : BZ_NORTH;
                const w = 0.35 + 0.65 * mag;
                a[o] = c[0] * w; a[o + 1] = c[1] * w; a[o + 2] = c[2] * w; a[o + 3] = 1;
            } else {
                a[o] = a[o + 1] = a[o + 2] = a[o + 3] = 0;
            }
        }
        attr.needsUpdate = true;
        r.fielded = true;
    }

    _traceLines(kernel, fc, tau, basis, sunDir) {
        const geo = this._lines.geometry;
        if (!kernel || typeof kernel.fieldAt !== 'function' || !fc) {
            geo.setDrawRange(0, 0); this._arrow.visible = false; this._atEarth = null; return;
        }
        const tS = (tau - fc.launchMs) / 1000;
        const mp = this.hooks.getMagnetopause?.() ?? null;
        const out = traceImfLines({
            fieldAt: (p) => kernel.fieldAt(tS, p[0], p[1], p[2]), basis, sunDir, mp,
        });
        // Field at Earth itself, for the readout (whether or not lines exist).
        const pe = sceneToHelioKm([0, 0, 0], basis);
        const fe = kernel.fieldAt(tS, pe[0], pe[1], pe[2]);
        this._atEarth = {
            inside: !!fe?.inside, count: fe?.count ?? 0,
            gse: fe?.inside ? toGse([fe.bx, fe.by, fe.bz]) : null,
            bmag: fe?.inside ? Math.hypot(fe.bx, fe.by, fe.bz) : null,
            lines: out.lines.length, reference: out.reference?.at ?? null,
        };
        const pos = geo.attributes.position.array, col = geo.attributes.color.array;
        let v = 0;
        const scaleB = Math.max(5, out.reference?.bmag ?? 20);
        for (const L of out.lines) {
            const n = L.bz.length;
            for (let k = 0; k < n - 1 && v < MAX_LINE_VERTS - 2; k++) {
                for (const j of [k, k + 1]) {
                    pos[v * 3] = L.points[j * 3]; pos[v * 3 + 1] = L.points[j * 3 + 1]; pos[v * 3 + 2] = L.points[j * 3 + 2];
                    const bz = L.bz[j];
                    const c = bz < 0 ? BZ_SOUTH : BZ_NORTH;
                    const w = 0.35 + 0.65 * Math.min(1, Math.abs(bz) / scaleB);
                    // Unsaturated grey-violet where Bz ≈ 0 so direction still reads.
                    col[v * 3] = 0.45 * (1 - w) + c[0] * w; col[v * 3 + 1] = 0.42 * (1 - w) + c[1] * w; col[v * 3 + 2] = 0.62 * (1 - w) + c[2] * w;
                    v++;
                }
            }
        }
        geo.setDrawRange(0, v);
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        if (this._atEarth.inside) {
            const g = this._atEarth.gse;
            // GSE → heliocentric (flip x, y) → scene.
            const hb = [-g[0], -g[1], g[2]];
            const d = new THREE.Vector3(
                hb[0] * basis.e1[0] + hb[1] * basis.e2[0] + hb[2] * basis.e3[0],
                hb[0] * basis.e1[1] + hb[1] * basis.e2[1] + hb[2] * basis.e3[1],
                hb[0] * basis.e1[2] + hb[1] * basis.e2[2] + hb[2] * basis.e3[2]).normalize();
            const nose = mp?.r0 ? mp.r0 * 1.45 : 15;
            this._arrow.position.set(sunDir[0] * nose, sunDir[1] * nose, sunDir[2] * nose);
            this._arrow.setDirection(d);
            this._arrow.setColor(new THREE.Color().setRGB(...(g[2] < 0 ? BZ_SOUTH : BZ_NORTH)));
            this._arrow.visible = true;
        } else {
            this._arrow.visible = false;
        }
    }

    // ── what the panel reads ───────────────────────────────────────────────

    getState() {
        const w = this.getWindow();
        return {
            enabled: this._enabled,
            status: this.status,
            mode: this.mode,
            hasLive: this.hasLive(),
            tauMs: this.fc ? this.getTau() : null,
            follow: this.clock.follow && this.status.source === 'live',
            playing: this.clock.playing,
            rateH: this.clock.rateH,
            window: w,
            launchMs: this.fc?.launchMs ?? null,
            summary: this.fc?.summary ?? null,
            ropes: this._ropeRows,
            atEarth: this._atEarth,
            compressionAt1Au: corridorCompression(1),
            sunRe: CME_VIEW.sunRe,
            sunExaggeration: CME_VIEW.sunDrawnRe / corridorRadiusRe(RSUN_KM / AU_KM),
            label: this.fc?.preset?.label ?? null,
        };
    }
    getBasis() { return this._basis ?? null; }
    getSunDirArr() { return this._sunDirArr ?? null; }
}
