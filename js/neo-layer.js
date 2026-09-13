/**
 * neo-layer.js — near-Earth objects for solar-system.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws the whole catalogued near-Earth population (asteroids, near-Earth
 * comets, the interstellar visitors) at its propagated position for the
 * orrery's current Julian Day, plus:
 *
 *   · an Earth-anchored "near-Earth space" frame — rings at 1/5/10/20 lunar
 *     distances on the Moon's own compression, with every object currently
 *     inside 20 LD drawn there with a ±3-day geocentric trail and a label
 *   · the selected object's full orbit and a camera-lock anchor the page's
 *     selectBody()/setCamLock() can follow like a planet
 *   · inbound arrows for the meteor showers active at the sim date (the
 *     direction meteoroids arrive FROM, at the stream's geocentric speed)
 *
 * All orbital arithmetic for the population runs in js/neo-worker.js; this
 * module owns three.js objects, the data feeds, selection and picking. The
 * pure kernel (js/neo-orbits.js) is the single copy of every rule below.
 *
 * ── The two drawing conventions (read the kernel header first) ────────────
 * Population points ride the orrery's log radial scale in the ecliptic OF
 * DATE. Inside LOCAL_FRAME.maxLD of Earth an object is drawn on the local
 * frame instead, and across LOCAL_FRAME.fadeLD the two instances cross-fade
 * (alpha only — positions never jump). The page discloses both in the panel.
 *
 * ── Data ladder ───────────────────────────────────────────────────────────
 * /api/neo/catalog?tier=pha → bright → all, in sequence, each REPLACING the
 * previous (tiers nest). `all` is skipped on save-data connections. A feed
 * that fails leaves the previous tier on screen and says so in `status`; a
 * catalogue that never arrives draws NOTHING (never a stale invention).
 * /api/neo/watch supplies the close-approach table (JPL's integrated orbits,
 * not our two-body propagation), the Sentry risk list and recent fireballs.
 *
 * Browser gate: tests/solar-system-neo-smoke.spec.js (routes mocked).
 */

import * as THREE from 'three';
import {
    FLAG, LD_AU, AU_KM, LOCAL_FRAME, CLASS_LABELS,
    rowToRecord, normalizeElements, propagate, toOfDate, sampleOrbit,
    helioToScene, geoToLocalScene, localSceneRadius, localFrameWeight, precessionLongitudeRad, rotateAboutPole,
    diameterKmFromH, formatSize, formatLD, toLD, speedKms, elementsAgeNote, findNotable, neoClass,
    solarLongitudeDeg, activeShowers, nextShower, radiantEclipticUnit,
    magnitudeSizePx, magnitudeAlpha, rockDrawRadius, trueScaleRadius, apparentMagnitude, phaseAngleDeg, elongationDeg, tisserandJ, nodeDistancesAU, earthCrossingNote, nextPerihelionJD, jdToIsoDate, eclipticLonLatDeg, positionAtTrueAnomaly, D2R,
} from './neo-orbits.js';

import { rockGeometry, rockMaterial, shapeFor, spinFor, hash32, MeteoroidStream } from './neo-rocks.js';

const WORKER_URL = new URL('./neo-worker.js', import.meta.url);

// ── Mesh LOD ────────────────────────────────────────────────────────────────
// A sprite is honest for a 30 m rock two AU away; it is not for the object
// you locked the camera on. A pool of ROCK_SLOTS rock meshes is assigned, at
// ~10 Hz, to the selected object, the flybys inside the Earth-local frame and
// the objects nearest the camera within ROCK_RANGE scene units; their sprites
// are suppressed while a mesh stands in. Geometries are seeded per object and
// cached (GEO_CACHE_MAX), so a body always has the same shape.
const ROCK_SLOTS = 24;
const ROCK_RANGE = 2.5;
// Rocks are drawn at TRUE scale with a screen-space floor (neo-orbits.js
// rockDrawRadius): 5 px for the pool, 34 px for the selected object so its
// shape and spin are inspectable. The exaggeration is on the data card.
const ROCK_PX_FLOOR = 5;
const ROCK_PX_SELECTED = 34;
const GEO_CACHE_MAX = 48;
const _Y = new THREE.Vector3(0, 1, 0);
const _camUp = new THREE.Vector3();
const _qSpin = new THREE.Quaternion();

export const NEO_COLORS = Object.freeze({
    pha:          0xff5a3c,
    APO:          0xffb347,
    ATE:          0x5be0c8,
    AMO:          0xc39bff,
    IEO:          0xff8ad8,
    comet:        0x7fd7ff,
    interstellar: 0xffffff,
    other:        0xa09a8c,
    flyby:        0xfff2a8,
    ring:         0x6fa8dc,
    radiant:      0xffd27a,
});

export const NEO_TIER_LADDER = ['pha', 'bright', 'all'];

/**
 * Two palettes. NATURAL (default) is what a camera would record: asteroids
 * run from S-type reddish-grey to C-type dark neutral (a per-object hash keeps
 * the mix stable frame to frame), comets are blue-white, interstellar objects
 * white; a PHA carries a warm bias so hazard stays legible. CLASS is the
 * data-viz palette the legend names. Brightness and size come from ABSOLUTE
 * MAGNITUDE either way — Eros (H 10) outshines a 30 m rock (H 28) by eight
 * magnitudes, and the sprite says so inside the 1.7–5.6 px band a point can
 * honestly occupy. The sprite itself is a Gaussian core + soft PSF halo,
 * blended ADDITIVELY so dense regions glow instead of stacking opaque discs.
 */
export const NATURAL_COLORS = Object.freeze({
    sType: 0xd6bb95, cType: 0x9a9691, pha: 0xf0a97c, comet: 0xc4e8ff, interstellar: 0xffffff, flyby: 0xfff0c2,
});
function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10007) / 10007;
}
/**
 * Point size (CSS px before DPR and the near-camera growth) from the APPARENT
 * magnitude the worker computed for this frame. Absolute magnitude used to
 * size these, which made 42 000 sprites a wall of 10–25 px blobs at any zoom;
 * now a sprite is as big and bright as the object is observable from Earth
 * tonight (neo-orbits.js MAG_DISPLAY). Comets and the interstellar visitors
 * keep a modest floor so a tail has a nucleus to hang from.
 */
function sizeForV(el, V) {
    if (el.flags & FLAG.INTERSTELLAR) return 3.6;
    if (el.flags & FLAG.COMET) return Math.max(2.6, magnitudeSizePx(V));
    return magnitudeSizePx(V);
}
function alphaForV(el, V) {
    if (el.flags & (FLAG.INTERSTELLAR | FLAG.COMET)) return Math.max(0.6, magnitudeAlpha(V));
    return magnitudeAlpha(V);
}
function classColorHex(el) {
    if (el.flags & FLAG.INTERSTELLAR) return NEO_COLORS.interstellar;
    if (el.flags & FLAG.COMET) return NEO_COLORS.comet;
    if (el.flags & FLAG.PHA) return NEO_COLORS.pha;
    return NEO_COLORS[el.cls] ?? NEO_COLORS.other;
}
const _cB = new THREE.Color();
/** Writes the object's colour under `mode` ('natural' | 'class') into `out`; returns `out`. */
export function colorFor(el, mode, out) {
    if (mode === 'class') return out.setHex(classColorHex(el));
    if (el.flags & FLAG.INTERSTELLAR) return out.setHex(NATURAL_COLORS.interstellar);
    if (el.flags & FLAG.COMET) return out.setHex(NATURAL_COLORS.comet);
    const t = hash01(String(el.des ?? el.name ?? ''));
    out.setHex(NATURAL_COLORS.sType).lerp(_cB.setHex(NATURAL_COLORS.cType), 0.25 + 0.6 * t);
    if (el.flags & FLAG.PHA) out.lerp(_cB.setHex(NATURAL_COLORS.pha), 0.6);
    return out;
}
export function classLabel(el) {
    if (el.flags & FLAG.INTERSTELLAR) return 'Interstellar object';
    if (el.flags & FLAG.COMET) return (CLASS_LABELS[el.cls] ?? 'Comet') + ' · near-Earth comet';
    const c = CLASS_LABELS[el.cls] ?? CLASS_LABELS[neoClass(el.a, el.e)] ?? 'Near-Earth asteroid';
    return (el.flags & FLAG.PHA) ? `${c} · potentially hazardous` : c;
}
export function displayName(el) { return el.name || el.des || '—'; }

const DPR = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

const POINT_VS = /* glsl */`
    attribute vec3  aColor;
    attribute float aSize;
    attribute float aAlpha;
    attribute float aPulse;
    uniform float u_dpr;
    uniform float u_time;
    uniform float u_att;
    varying vec3  vColor;
    varying float vAlpha;
    varying float vPulse;
    varying float vPx;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // A flyby BREATHES its halo rather than blinking.
        float pulse = 1.0 + aPulse * (0.18 + 0.18 * sin(u_time * 2.2));
        // Near-camera growth is a square root and capped at 1.6×: the old
        // linear 0.6–2.3× put every sprite at 2.3× across the whole inner system.
        float att = clamp(sqrt(u_att / max(-mv.z, 0.05)), 0.75, 1.6);
        // ×2: the Gaussian core occupies the inner half of the sprite; the rest is halo.
        gl_PointSize = aSize * pulse * u_dpr * att * 2.0;
        vPx = gl_PointSize;
        gl_Position = projectionMatrix * mv;
        vColor = aColor; vAlpha = aAlpha; vPulse = aPulse;
    }
`;
const POINT_FS = /* glsl */`
    varying vec3  vColor;
    varying float vAlpha;
    varying float vPulse;
    varying float vPx;
    void main() {
        if (vAlpha <= 0.002) discard;
        vec2 c = (gl_PointCoord - 0.5) * 2.0;
        float d2 = dot(c, c);
        if (d2 > 1.0) discard;
        float core = exp(-d2 * 14.0);                  // the point source
        float glow = exp(-d2 * 3.0) * 0.30;            // soft PSF halo
        float spikes = 0.0;
        if (vPx > 9.0) {                               // brightest few: a faint diffraction cross
            float ax = abs(c.x), ay = abs(c.y);
            spikes = (pow(max(0.0, 1.0 - ay * 7.0), 2.0) + pow(max(0.0, 1.0 - ax * 7.0), 2.0))
                   * max(0.0, 1.0 - sqrt(d2)) * 0.22;
        }
        float halo = vPulse * exp(-d2 * 1.6) * 0.40;   // flyby breathing halo
        float a = (core + glow + spikes + halo) * vAlpha;
        gl_FragColor = vec4(vColor * a, a);            // premultiplied; blended additively
    }
`;

function makePointsMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        uniforms: {
            u_dpr:  { value: DPR },
            u_time: { value: 0 },
            u_att:  { value: 12.0 },
        },
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
}

// ── Comet tails ─────────────────────────────────────────────────────────────
// Two tails per active comet, as line segments with vertex colours fading to
// black (additive blend ⇒ fade). ION tail: straight, anti-sunward — the Sun is
// at the scene origin, so that direction is exact even on the log scale. DUST
// tail: shorter, lagging behind the motion with a t² curve. Length and coma
// brightness scale as 1/r² of heliocentric distance, gated below TAIL_MAX_R AU.
// Lengths are SCENE units and schematic (the radial scale is logarithmic);
// directions are physical.
const TAIL_SEG = 12;
const TAIL_VERTS = 2 * TAIL_SEG * 2;
const TAIL_MAX_R = 3.5;

// ── Meteoroid streams ───────────────────────────────────────────────────────
// A shower is drawn as what it is: a stream of particles converging on Earth
// from the radiant direction at the stream's speed. Everything is in the
// vertex shader (seed + time), so a stream costs the CPU nothing.
const STREAM_VS = /* glsl */`
    attribute float aSeed;
    attribute vec3  aJitter;
    uniform vec3  u_dir;
    uniform float u_time;
    uniform float u_speed;
    uniform float u_dpr;
    varying float vFade;
    void main() {
        float s = fract(aSeed + u_time * u_speed);                      // 0 far out → 1 at Earth
        vec3 p = u_dir * mix(1.25, 0.16, s) + aJitter * (0.05 + 0.13 * (1.0 - s));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.2 + 2.0 * s) * u_dpr * clamp(30.0 / max(-mv.z, 0.05), 0.6, 2.0);
        vFade = smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.88, 1.0, s));
        gl_Position = projectionMatrix * mv;
    }
`;
const STREAM_FS = /* glsl */`
    uniform vec3 u_color;
    varying float vFade;
    void main() {
        vec2 c = (gl_PointCoord - 0.5) * 2.0;
        float d2 = dot(c, c);
        if (d2 > 1.0) discard;
        float a = exp(-d2 * 4.0) * vFade * 0.35;   // faint streaks; the rocks carry the stream
        gl_FragColor = vec4(u_color * a, a);
    }
`;
function makeStream(count, colorHex) {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(count), jit = new Float32Array(count * 3), pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        seed[i] = Math.random();
        jit[i * 3] = Math.random() * 2 - 1; jit[i * 3 + 1] = Math.random() * 2 - 1; jit[i * 3 + 2] = Math.random() * 2 - 1;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aJitter', new THREE.BufferAttribute(jit, 3));
    const m = new THREE.ShaderMaterial({
        vertexShader: STREAM_VS, fragmentShader: STREAM_FS,
        uniforms: {
            u_dir: { value: new THREE.Vector3(0, 1, 0) }, u_time: { value: 0 }, u_speed: { value: 0.5 },
            u_dpr: { value: DPR }, u_color: { value: new THREE.Color(colorHex) },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    return pts;
}

/** Canvas-text sprite with constant on-screen size. */
function makeLabel(text, { color = '#dfe6f0', size = 22, weight = 500 } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = `${weight} ${size}px 'Segoe UI', system-ui, sans-serif`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 16, h = size + 12;
    canvas.width = w; canvas.height = h;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;
    ctx.fillStyle = color;
    ctx.fillText(text, 8, h / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false });
    const sprite = new THREE.Sprite(mat);
    // sizeAttenuation:false ⇒ scale is a fraction of the view (≈ scale / (2·tan(fov/2)) of the height).
    const hFrac = 0.032;
    sprite.scale.set(hFrac * (w / h), hFrac, 1);
    sprite.renderOrder = 20;
    sprite.userData.text = text;
    return sprite;
}

let _dotTex = null;
/** Soft round dot (shared) for the orbit analysis marks. */
function dotTexture() {
    if (_dotTex) return _dotTex;
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.4, 'rgba(255,255,255,.9)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
    _dotTex = new THREE.CanvasTexture(c);
    return _dotTex;
}

/** Simple emitter. */
class Emitter {
    constructor() { this._l = new Map(); }
    on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); return () => this._l.get(ev)?.delete(fn); }
    emit(ev, payload) { for (const fn of (this._l.get(ev) ?? [])) { try { fn(payload); } catch (e) { console.warn('[neo-layer]', ev, e); } } }
}

export class NeoLayer extends Emitter {
    /**
     * @param {{ scene: THREE.Scene, earthR?: number, fetchImpl?: typeof fetch,
     *           useWorker?: boolean, tiers?: string[], catalogUrl?: string, watchUrl?: string }} opts
     */
    constructor(opts) {
        super();
        this.scene = opts.scene;
        this.earthR = opts.earthR ?? LOCAL_FRAME.earthSceneRadius;
        this._fetch = opts.fetchImpl ?? ((u, o) => fetch(u, o));
        this.tiers = opts.tiers ?? NEO_TIER_LADDER;
        this.catalogUrl = opts.catalogUrl ?? '/api/neo/catalog';
        this.watchUrl = opts.watchUrl ?? '/api/neo/watch';
        this.useWorker = opts.useWorker ?? true;

        // Population state (index-aligned across els / worker / attributes).
        this.els = [];                 // normalized element records
        this.byDes = new Map();        // des → index
        this.count = 0;
        this.tier = null;
        this.status = {
            catalog: 'loading', catalogNote: 'loading…', tierLoaded: null, tiersPending: [...this.tiers],
            watch: 'loading', watchNote: 'loading…', worker: 'spawning', frameMs: 0, rejected: {},
            catalogMeta: null, watchMeta: null,
        };
        this.watch = { approaches: [], sentry: [], fireballs: [], window: null };
        // population: 'all' | 'bright' (H ≤ 22, PHAs, comets, interstellar) | 'pha'
        // colorMode: 'natural' (S/C-type tints) | 'class' (the legend's data-viz palette)
        this.visible = { asteroids: true, comets: true, population: 'all', local: true, radiants: true, orbit: true, labels: true, colorMode: 'natural' };

        // Frame state from the worker.
        this.frameJd = null;
        this.rGeo = null;              // Float32Array(N), AU
        this.rHelio = null;
        this.inZone = [];              // indices with dLD < LOCAL_FRAME.maxLD (sorted by distance)
        this.closest = null;           // { index, dLD }
        this._earthOfDate = [1, 0, 0];
        this._earthDrawn = new THREE.Vector3();
        this._lastJd = null;

        // Selection.
        this.selectedIndex = null;
        this._bodies = new Map();      // index → body object handed to the page

        // three.js objects.
        this.group = new THREE.Group(); this.group.name = 'neo-layer';
        this.localGroup = new THREE.Group(); this.localGroup.name = 'neo-local-frame';
        this.group.add(this.localGroup);
        this.scene.add(this.group);
        this._pointsMat = makePointsMaterial();
        this.points = null;            // heliocentric-frame population
        this.localPoints = null;       // in-zone instances
        this._localCap = 64;
        this._buildLocalFrame();
        this.orbitLine = null;
        this._orbitBuiltJd = null;
        this._orbitMarks = [];         // ☊ ☋ q marks on the selected orbit (sprite + label each)
        this._dropLine = null;         // selected object → ecliptic plane
        this.vmag = null;              // Float32Array(N): apparent V from Earth this frame
        this._selectedDraw = null;     // { index, r, rTrue, exaggeration, atFloor } for the card
        this._camDist = 20; this._viewH = 900; this._fov = 50;
        this.cometTails = null;        // LineSegments: two tails per active comet
        this._cometIdx = [];           // indices of objects that can grow a tail
        this.cometTailsActive = 0;
        this._rockSlots = [];          // { mesh, index, geoKey, shape, spin, isComet }
        this._geoCache = new Map();    // des → { geo, shape }
        this._meshed = new Set();      // indices drawn as meshes right now (sprites suppressed)
        this._rockTick = 0;
        this.anchor = new THREE.Object3D(); this.anchor.name = 'neo-anchor'; this.group.add(this.anchor);
        this.selectedMarker = this._buildSelectedMarker();
        this._labels = new Map();      // key → sprite
        // Labels have constant SCREEN size, so at the top view (camera ~55 units
        // out) a dozen of them pile onto the Earth disc. Each class is shown
        // only once the frame it annotates subtends enough of the view (measured
        // as ring radius / camera-to-Earth distance) — set every frame in update().
        this._labelVis = { rings: false, objects: false };
        this._radiants = [];           // { code, line, cone, label }
        this._trails = new Map();      // index → Line
        this._trackReq = new Map();    // index → pending id

        // Worker.
        this._worker = null; this._nextId = 1; this._inFlight = false; this._pendingJd = null;
        this._mainFallbackNext = 0;
        this._t = 0;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /** Kick off the data ladder. Safe to call once. */
    start() {
        this._ensureWorker();
        this._loadWatch();
        this._loadNextTier();
        return this;
    }

    dispose() {
        this._worker?.terminate();
        for (const slot of this._rockSlots) slot.mesh.material.dispose();
        for (const [, g] of this._geoCache) g.geo.dispose();
        for (const r of this._radiants) r.rocks.dispose();
        this.scene.remove(this.group);
    }

    // ── Worker bridge ───────────────────────────────────────────────────────

    _ensureWorker() {
        if (this._worker || !this.useWorker || typeof Worker === 'undefined') return;
        try {
            this._worker = new Worker(WORKER_URL, { type: 'module' });
        } catch (err) {
            console.warn('[neo-layer] module worker unsupported, propagating on main thread:', err);
            this.status.worker = 'main-thread';
            return;
        }
        this._worker.addEventListener('message', (ev) => this._onWorkerMsg(ev.data));
        this._worker.addEventListener('error', (err) => {
            console.warn('[neo-layer] worker error:', err.message || err);
            this.status.worker = 'main-thread';
            this._worker.terminate(); this._worker = null; this._inFlight = false;
        });
    }

    _onWorkerMsg(msg) {
        if (!msg) return;
        if (msg.type === 'ready') { this.status.worker = 'ready'; return; }
        if (msg.type === 'loaded') {
            this.status.rejected = msg.rejected ?? {};
            this.status.worker = `ready · ${msg.count.toLocaleString()} objects`;
            this._inFlight = false;
            this._requestFrame(true);
            return;
        }
        if (msg.type === 'frame') {
            this._inFlight = false;
            if (msg.count === this.count && this.points) this._applyFrame(msg);
            // Time moved on while we computed — go again immediately.
            if (this._pendingJd != null && Math.abs(this._pendingJd - msg.jd) > 1e-4) this._requestFrame(true);
            return;
        }
        if (msg.type === 'track') { this._applyTrack(msg); return; }
        if (msg.type === 'error') { console.warn('[neo-layer] worker:', msg.error); this._inFlight = false; }
    }

    _requestFrame(force = false) {
        if (!this.count || this._lastJd == null) return;
        const jd = this._lastJd;
        this._pendingJd = jd;
        if (this._worker) {
            if (this._inFlight) return;
            if (!force && this.frameJd != null && Math.abs(jd - this.frameJd) < 1e-4) return;
            this._inFlight = true;
            this._worker.postMessage({ type: 'frame', id: this._nextId++, jd, earth: this._earthOfDate });
            return;
        }
        // Main-thread fallback: 1 Hz, so a 38k solve never stalls the render loop for long.
        const now = performance.now();
        if (!force && now < this._mainFallbackNext) return;
        this._mainFallbackNext = now + 1000;
        this._mainThreadFrame(jd);
    }

    async _mainThreadFrame(jd) {
        const mod = await import('./neo-orbits.js');
        if (!this._cols) { const prep = mod.prepareColumns(this.els); this._cols = prep.cols; this._helio = new Float64Array(this.count * 3); }
        const N = this.count;
        const scene = new Float32Array(N * 3), rHelio = new Float32Array(N), rGeo = new Float32Array(N), vmag = new Float32Array(N);
        mod.propagateColumns(this._cols, jd, this._helio);
        mod.deriveFrames(this._helio, N, this._earthOfDate, scene, rHelio, rGeo, mod.precessionLongitudeRad(jd), vmag, this._cols.H, this._cols.flags);
        this._applyFrame({ jd, count: N, scene, rHelio, rGeo, vmag, ms: 0 });
    }

    // ── Data feeds ──────────────────────────────────────────────────────────

    async _loadJson(url) {
        const res = await this._fetch(url, { cache: 'default' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async _loadNextTier() {
        const tier = this.status.tiersPending.shift();
        if (!tier) return;
        if (tier === 'all' && typeof navigator !== 'undefined' && navigator.connection?.saveData) {
            this.status.catalogNote += ' · full catalogue skipped (save-data)';
            this.emit('catalog', this.status);
            return;
        }
        this.status.catalog = this.count ? 'ready' : 'loading';
        this.status.catalogNote = `loading ${tier}…`;
        this.emit('catalog', this.status);
        try {
            const body = await this._loadJson(`${this.catalogUrl}?tier=${encodeURIComponent(tier)}`);
            const rows = Array.isArray(body?.rows) ? body.rows : [];
            if (body?.freshness === 'stale' && rows.length === 0) throw new Error(body.degraded_reason || 'catalogue unavailable');
            this._ingestCatalog(rows, tier, body);
            this.status.catalog = 'ready';
            this.status.catalogNote = body?.freshness === 'stale'
                ? `partial — ${body.degraded_reason || 'asteroid population unavailable'}`
                : `${this.count.toLocaleString()} objects · ${body?.tier_label ?? tier}`;
        } catch (err) {
            console.warn(`[neo-layer] catalog tier ${tier}:`, err.message);
            if (!this.count) { this.status.catalog = 'down'; this.status.catalogNote = `feed down — ${err.message}`; }
            else this.status.catalogNote = `${this.count.toLocaleString()} objects (${this.tier}) · ${tier} failed: ${err.message}`;
        }
        this.emit('catalog', this.status);
        this._loadNextTier();
    }

    _ingestCatalog(rows, tier, meta) {
        const els = [];
        const rejected = {};
        for (const row of rows) {
            const r = normalizeElements(rowToRecord(row));
            if (!r.ok) { rejected[r.reason] = (rejected[r.reason] || 0) + 1; continue; }
            els.push(r.el);
        }
        this.els = els;
        this.count = els.length;
        this.tier = tier;
        this.status.tierLoaded = tier;
        this.status.rejected = rejected;
        this.status.catalogMeta = meta ? { generated_at: meta.generated_at, groups: meta.groups, freshness: meta.freshness, tier_label: meta.tier_label } : null;
        this.byDes = new Map();
        for (let k = 0; k < els.length; k++) if (els[k].des) this.byDes.set(els[k].des, k);
        this._cols = null;
        this._rebuildPoints();
        const prevSel = this.selectedIndex != null ? this._selectedDes : null;
        this.selectedIndex = null; this._bodies.clear();
        this._clearTrails();
        if (this._worker) {
            this._inFlight = true;
            this._worker.postMessage({ type: 'load', id: this._nextId++, records: els.map(el => ({
                des: el.des, name: el.name, H: el.H, cls: el.cls, flags: el.flags,
                e: el.e, a: el.a, q: el.q, i: el.i, om: el.om, w: el.w,
                ma: el.M0 * 180 / Math.PI, epoch: el.t0, tp: el.e >= 1 ? el.t0 : null, moid: el.moid, diam: el.diam,
            })), reset: true });
        } else {
            this._requestFrame(true);
        }
        this._resolveWatchIndices();
        if (prevSel != null && this.byDes.has(prevSel)) this.select(this.byDes.get(prevSel));
        this.emit('population', { count: this.count, tier });
    }

    async _loadWatch() {
        try {
            const body = await this._loadJson(this.watchUrl);
            this.watch = {
                approaches: Array.isArray(body?.approaches) ? body.approaches : [],
                sentry: Array.isArray(body?.sentry) ? body.sentry : [],
                fireballs: Array.isArray(body?.fireballs) ? body.fireballs : [],
                window: body?.window ?? null,
            };
            this.status.watchMeta = { generated_at: body?.generated_at, sources: body?.sources, freshness: body?.freshness };
            const cadDown = body?.freshness === 'stale';
            this.status.watch = cadDown ? 'down' : 'ready';
            this.status.watchNote = cadDown
                ? `approach table down — ${body?.degraded_reason || 'JPL CAD unavailable'}`
                : `${this.watch.approaches.length} approaches · ${this.watch.sentry.length} risk-listed · ${this.watch.fireballs.length} fireballs`;
        } catch (err) {
            console.warn('[neo-layer] watch:', err.message);
            this.status.watch = 'down';
            this.status.watchNote = `feed down — ${err.message}`;
        }
        this._resolveWatchIndices();
        this.emit('watch', this.watch);
    }

    _resolveWatchIndices() {
        for (const a of this.watch.approaches) a.index = this.byDes.has(a.des) ? this.byDes.get(a.des) : null;
        for (const s of this.watch.sentry) s.index = this.byDes.has(s.des) ? this.byDes.get(s.des) : null;
        this._applyStyles();
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    _rebuildPoints() {
        if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
        const N = this.count;
        const geo = new THREE.BufferGeometry();
        this._pos = new Float32Array(N * 3);
        this._col = new Float32Array(N * 3);
        this._size = new Float32Array(N);
        this._alpha = new Float32Array(N);
        this._pulse = new Float32Array(N);
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(this._col, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(this._size, 1));
        geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._alpha, 1));
        geo.setAttribute('aPulse', new THREE.BufferAttribute(this._pulse, 1));
        geo.setDrawRange(0, N);
        this.points = new THREE.Points(geo, this._pointsMat);
        this.points.name = 'neo-points';
        this.points.frustumCulled = false;
        this.points.renderOrder = 5;
        this.group.add(this.points);
        this.rGeo = null; this.rHelio = null; this.frameJd = null; this.inZone = []; this.closest = null;
        this._cometIdx = [];
        for (let k = 0; k < N; k++) {
            const el = this.els[k];
            const cometClass = /^(HYP|COM|JFc|JFC|HTC|ETc|CTc|PAR)$/.test(el.cls || '');
            if ((el.flags & FLAG.COMET) || ((el.flags & FLAG.INTERSTELLAR) && cometClass)) this._cometIdx.push(k);
        }
        this._buildCometTails();
        this._applyStyles();
    }

    _buildCometTails() {
        if (this.cometTails) { this.group.remove(this.cometTails); this.cometTails.geometry.dispose(); this.cometTails.material.dispose(); this.cometTails = null; }
        const n = this._cometIdx.length;
        this.cometTailsActive = 0;
        if (!n) return;
        const V = n * TAIL_VERTS;
        const g = new THREE.BufferGeometry();
        this._tailPos = new Float32Array(V * 3);
        this._tailCol = new Float32Array(V * 3);
        g.setAttribute('position', new THREE.BufferAttribute(this._tailPos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(this._tailCol, 3));
        this.cometTails = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.cometTails.name = 'neo-comet-tails';
        this.cometTails.frustumCulled = false;
        this.cometTails.renderOrder = 4;
        this.group.add(this.cometTails);
    }

    _writeTail(o, px, py, pz, f, rgb, b) {
        const pos = this._tailPos, col = this._tailCol;
        for (let i = 0; i < TAIL_SEG; i++) {
            const t0 = i / TAIL_SEG, t1 = (i + 1) / TAIL_SEG;
            const p0 = f(t0), p1 = f(t1);
            const q = o + i * 6;
            pos[q] = px + p0[0]; pos[q + 1] = py + p0[1]; pos[q + 2] = pz + p0[2];
            pos[q + 3] = px + p1[0]; pos[q + 4] = py + p1[1]; pos[q + 5] = pz + p1[2];
            const f0 = Math.pow(1 - t0, 1.6) * b, f1 = Math.pow(1 - t1, 1.6) * b;
            col[q] = rgb[0] * f0; col[q + 1] = rgb[1] * f0; col[q + 2] = rgb[2] * f0;
            col[q + 3] = rgb[0] * f1; col[q + 4] = rgb[1] * f1; col[q + 5] = rgb[2] * f1;
        }
    }

    /** Per worker frame: tails + coma for every comet inside TAIL_MAX_R AU. */
    _refreshCometTails() {
        if (!this.cometTails || this.frameJd == null) return;
        const jd = this.frameJd, prec = precessionLongitudeRad(jd);
        const cp = Math.cos(prec), sp = Math.sin(prec);
        const pos = this._tailPos, col = this._tailCol;
        let active = 0, sizeDirty = false;
        for (let i = 0; i < this._cometIdx.length; i++) {
            const k = this._cometIdx[i];
            const o = i * TAIL_VERTS * 3;
            const el = this.els[k];
            const r = this.rHelio[k];
            const vis = this._baseVis ? this._baseVis[k] : 1;
            const b = vis && r < TAIL_MAX_R ? Math.min(1, 0.9 / (r * r)) : 0;
            // Coma: the nucleus sprite swells and brightens as 1/r².
            const sz = sizeForV(el, this._V(k)) + (b > 0 ? 2.2 * b : 0);
            if (this._size[k] !== sz) { this._size[k] = sz; sizeDirty = true; }
            if (b <= 0.01) { pos.fill(0, o, o + TAIL_VERTS * 3); col.fill(0, o, o + TAIL_VERTS * 3); continue; }
            active++;
            const px = this._pos[k * 3], py = this._pos[k * 3 + 1], pz = this._pos[k * 3 + 2];
            const rs = Math.hypot(px, py, pz) || 1;
            const ax = px / rs, ay = py / rs, az = pz / rs;               // anti-sunward (Sun at origin)
            const v = propagate(el, jd, true);                              // J2000 AU/day
            const vx = cp * v.vx - sp * v.vy, vy = sp * v.vx + cp * v.vy;  // → of date
            const vn = Math.hypot(vx, vy, v.vz) || 1;
            const wx = vx / vn, wy = v.vz / vn, wz = vy / vn;              // scene axes (x, z, y)
            const L = Math.min(1.1, Math.max(0.05, 0.32 / (r * r)));
            this._writeTail(o, px, py, pz, (t) => [ax * t * L, ay * t * L, az * t * L], [0.55, 0.78, 1.0], b);
            const Ld = L * 0.75, lag = 0.45;
            this._writeTail(o + TAIL_SEG * 6, px, py, pz,
                (t) => [(ax * t - wx * lag * t * t) * Ld, (ay * t - wy * lag * t * t) * Ld, (az * t - wz * lag * t * t) * Ld],
                [1.0, 0.9, 0.72], b * 0.85);
        }
        this.cometTailsActive = active;
        this.cometTails.geometry.attributes.position.needsUpdate = true;
        this.cometTails.geometry.attributes.color.needsUpdate = true;
        if (sizeDirty) this.points.geometry.attributes.aSize.needsUpdate = true;
    }

    _buildLocalFrame() {
        // In-zone instances.
        const cap = this._localCap;
        const geo = new THREE.BufferGeometry();
        this._lpos = new Float32Array(cap * 3); this._lcol = new Float32Array(cap * 3);
        this._lsize = new Float32Array(cap); this._lalpha = new Float32Array(cap); this._lpulse = new Float32Array(cap);
        geo.setAttribute('position', new THREE.BufferAttribute(this._lpos, 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(this._lcol, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(this._lsize, 1));
        geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._lalpha, 1));
        geo.setAttribute('aPulse', new THREE.BufferAttribute(this._lpulse, 1));
        geo.setDrawRange(0, 0);
        this.localPoints = new THREE.Points(geo, this._pointsMat);
        this.localPoints.name = 'neo-local-points';
        this.localPoints.frustumCulled = false;
        this.localPoints.renderOrder = 6;
        this.localGroup.add(this.localPoints);
        this._localIndices = [];

        // Rings at fixed lunar distances — a ruler, so the ticks never move.
        this.rings = [];
        const ringLD = [1, 5, 10, 20];
        for (const [ri, ld] of ringLD.entries()) {
            const r = localSceneRadius(ld * LD_AU * AU_KM, this.earthR);
            const n = 128, arr = new Float32Array(n * 3);
            for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; arr[k * 3] = r * Math.cos(a); arr[k * 3 + 1] = 0; arr[k * 3 + 2] = r * Math.sin(a); }
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
            const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: NEO_COLORS.ring, transparent: true, opacity: ld === 1 ? 0.34 : 0.16, depthWrite: false }));
            line.name = `neo-ring-${ld}ld`;
            line.renderOrder = 4;
            this.localGroup.add(line);
            const label = makeLabel(`${ld} LD`, { color: '#8fb8e8', size: 18 });
            // Staggered azimuths: at the same azimuth the four labels project onto
            // one spot whenever the camera looks along the ring plane (Earth View).
            const az = (45 + ri * 28) * Math.PI / 180;
            label.position.set(r * Math.cos(az), 0.012, r * Math.sin(az));
            label.visible = false;
            this.localGroup.add(label);
            this.rings.push({ ld, r, line, label });
        }
    }

    _buildSelectedMarker() {
        // A thin reticle in the object's own colour, not a grey washer.
        const group = new THREE.Group();
        group.name = 'neo-selected-marker';
        const ring = (ri, ro, opacity) => new THREE.Mesh(new THREE.RingGeometry(ri, ro, 64),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide,
                depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
        // Hairlines: the lock camera sits ~0.1 unit from the rock, so a ring
        // 0.0025 thick was a 25 px band.
        group.add(ring(0.0222, 0.0228, 0.95), ring(0.0300, 0.0303, 0.30));
        group.visible = false;
        group.renderOrder = 15;
        this.group.add(group);
        return group;
    }

    /** Colour / size / base alpha per object from class + toggles + watch highlights. */
    _applyStyles() {
        if (!this.points) return;
        const N = this.count;
        const c = new THREE.Color();
        const flybySet = new Set();
        const nowMs = this._simMs ?? Date.now();
        for (const a of this.watch.approaches) {
            if (a.index != null && Math.abs(a.t_ms - nowMs) < 7 * 86400e3) flybySet.add(a.index);
        }
        if (!this._baseVis || this._baseVis.length !== N) this._baseVis = new Float32Array(N);
        if (!this._baseA || this._baseA.length !== N) this._baseA = new Float32Array(N);
        const pop = this.visible.population;
        const mode = this.visible.colorMode;
        const flybyHex = mode === 'class' ? NEO_COLORS.flyby : NATURAL_COLORS.flyby;
        for (let k = 0; k < N; k++) {
            const el = this.els[k];
            const isComet = !!(el.flags & FLAG.COMET), isInter = !!(el.flags & FLAG.INTERSTELLAR), isPha = !!(el.flags & FLAG.PHA);
            let vis;
            if (isComet)      vis = this.visible.comets;
            else if (isInter) vis = this.visible.asteroids || this.visible.comets;
            else {
                vis = this.visible.asteroids;
                if (pop === 'pha')    vis = vis && isPha;
                if (pop === 'bright') vis = vis && (isPha || (el.H != null && el.H <= 22));
            }
            const flyby = flybySet.has(k);
            if (flyby && this.visible.asteroids) vis = true;   // a flyby this week is always worth drawing
            if (flyby) c.setHex(flybyHex); else colorFor(el, mode, c);
            this._col[k * 3] = c.r; this._col[k * 3 + 1] = c.g; this._col[k * 3 + 2] = c.b;
            this._size[k] = flyby ? 3.2 : sizeForV(el, this._V(k));
            this._pulse[k] = flyby ? 1 : 0;
            this._baseVis[k] = vis ? 1 : 0;
            this._baseA[k] = flyby ? 1 : alphaForV(el, this._V(k));
        }
        this.points.geometry.attributes.aColor.needsUpdate = true;
        this.points.geometry.attributes.aSize.needsUpdate = true;
        this.points.geometry.attributes.aPulse.needsUpdate = true;
        this._flybySet = flybySet;
        this._refreshAlpha();
    }

    /** Apparent V of object k this frame (NaN without H or before the first frame). */
    _V(k) { return this.vmag ? this.vmag[k] : NaN; }

    /** Per-frame size / base alpha from the worker's apparent magnitudes (flybys keep their highlight). */
    _refreshPhotometry() {
        if (!this.points || !this.vmag) return;
        const N = this.count;
        for (let k = 0; k < N; k++) {
            if (this._flybySet?.has(k)) continue;
            const el = this.els[k], V = this.vmag[k];
            this._size[k] = sizeForV(el, V);
            this._baseA[k] = alphaForV(el, V);
        }
        this.points.geometry.attributes.aSize.needsUpdate = true;
    }

    _refreshAlpha() {
        if (!this.points) return;
        const N = this.count;
        for (let k = 0; k < N; k++) {
            if (this._meshed.has(k)) { this._alpha[k] = 0; continue; }   // a mesh stands in
            const base = (this._baseVis ? this._baseVis[k] : 1) * (this._baseA ? this._baseA[k] : 1);
            const dLD = this.rGeo ? toLD(this.rGeo[k]) : Infinity;
            const w = this.visible.local ? localFrameWeight(dLD) : 1;
            this._alpha[k] = base * (0.35 + 0.65 * w) * (k === this.selectedIndex ? 1 : 0.9);
            // Inside the fade band the local instance takes over; in the deep zone the helio instance is off.
            if (this.visible.local && dLD < LOCAL_FRAME.fadeLD[0]) this._alpha[k] = 0;
        }
        this.points.geometry.attributes.aAlpha.needsUpdate = true;
    }

    /** Frame from the worker: positions, distances, in-zone set, closest, local instances. */
    _applyFrame(msg) {
        const N = msg.count;
        this._pos.set(msg.scene);
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.computeBoundingSphere();
        this.rGeo = msg.rGeo; this.rHelio = msg.rHelio; this.frameJd = msg.jd;
        this.status.frameMs = msg.ms;
        if (msg.vmag) { this.vmag = msg.vmag; if (!this._baseA || this._baseA.length !== N) this._baseA = new Float32Array(N).fill(1); this._refreshPhotometry(); }

        // In-zone set + closest.
        const maxAU = LOCAL_FRAME.maxLD * LD_AU;
        const zone = [];
        let best = -1, bestD = Infinity;
        for (let k = 0; k < N; k++) {
            const d = this.rGeo[k];
            if (d < maxAU && (this._baseVis ? this._baseVis[k] : 1)) zone.push(k);
            if (d < bestD && (this._baseVis ? this._baseVis[k] : 1)) { bestD = d; best = k; }
        }
        zone.sort((a, b) => this.rGeo[a] - this.rGeo[b]);
        this.inZone = zone.slice(0, this._localCap);
        this.closest = best >= 0 ? { index: best, dLD: toLD(bestD), dAU: bestD } : null;
        this._refreshAlpha();
        this._refreshLocalInstances();
        this._refreshCometTails();
        this.emit('frame', { jd: msg.jd, count: N, closest: this.closest, inZone: this.inZone, ms: msg.ms });
    }

    /** Exact geocentric vector for one object at the frame JD (of-date frame). */
    geocentricAt(index, jd = this.frameJd ?? this._lastJd) {
        const el = this.els[index];
        if (!el || jd == null) return null;
        const p = toOfDate(propagate(el, jd), jd);
        const e = this._earthOfDate;
        return { x: p.x - e[0], y: p.y - e[1], z: p.z - e[2], helio: p };
    }

    _refreshLocalInstances() {
        const c = new THREE.Color();
        const jd = this.frameJd;
        const n = this.inZone.length;
        this._localIndices = this.inZone.slice();
        const keep = new Set();
        // Labels exist for the nearest 12; how many are SHOWN is the zoom
        // ladder's call (_labelCap, by rank): 3 when the 20 LD ring is a small
        // disc, 12 only once it fills most of the view — a dozen constant-
        // screen-size labels on a 200 px disc is what the 2026-09-13 deploy
        // screenshot showed.
        const labelCap = this._labelCap();
        for (let j = 0; j < n; j++) {
            const k = this.inZone[j];
            const el = this.els[k];
            const g = this.geocentricAt(k, jd);
            const off = geoToLocalScene(g.x, g.y, g.z, this.earthR);
            this._lpos[j * 3] = off.x; this._lpos[j * 3 + 1] = off.y; this._lpos[j * 3 + 2] = off.z;
            if (this._flybySet?.has(k)) c.setHex(this.visible.colorMode === 'class' ? NEO_COLORS.flyby : NATURAL_COLORS.flyby);
            else colorFor(el, this.visible.colorMode, c);
            this._lcol[j * 3] = c.r; this._lcol[j * 3 + 1] = c.g; this._lcol[j * 3 + 2] = c.b;
            this._lsize[j] = 3.2;
            this._lpulse[j] = 0.5;
            this._lalpha[j] = this.visible.local && !this._meshed.has(k) ? (1 - localFrameWeight(off.dLD)) : 0;
            // Labels + trails for the nearest few (the selected object already
            // carries the page-level label, so it gets no second one here).
            if (j < 12 && this.visible.local && this.visible.labels && k !== this.selectedIndex) {
                const key = `local:${k}`;
                keep.add(key);
                const text = `${displayName(el)} · ${off.dLD < 10 ? off.dLD.toFixed(2) : off.dLD.toFixed(1)} LD`;
                let s = this._labels.get(key);
                // A canvas re-raster per worker frame × 12 labels would be the
                // most expensive thing on the page at warp speed: 4 Hz per label.
                const nowMs = performance.now();
                if (!s || (s.userData.text !== text && nowMs - (s.userData.builtAt ?? 0) > 250)) {
                    if (s) { this.localGroup.remove(s); s.material.map.dispose(); s.material.dispose(); }
                    s = makeLabel(text, { color: '#ffe9a8', size: 19 });
                    s.userData.builtAt = nowMs;
                    this.localGroup.add(s);
                    this._labels.set(key, s);
                }
                s.position.set(off.x, off.y + 0.02, off.z);
                // The label follows the local-frame weight, NOT the sprite alpha — the
                // sprite is zeroed while a mesh stands in, the label must stay.
                s.material.opacity = this.visible.local ? (1 - localFrameWeight(off.dLD)) : 0;
                s.userData.rank = j;
                s.visible = this._labelVis.objects && j < labelCap;
            }
            if (j < 12 && this.visible.local) this._requestTrack(k);
        }
        for (const [key, s] of this._labels) {
            if (key.startsWith('local:') && !keep.has(key)) { this.localGroup.remove(s); s.material.map.dispose(); s.material.dispose(); this._labels.delete(key); }
        }
        for (const [k, line] of this._trails) {
            if (!this.inZone.slice(0, 12).includes(k)) { this.localGroup.remove(line); line.geometry.dispose(); this._trails.delete(k); }
        }
        this.localPoints.geometry.setDrawRange(0, n);
        for (const a of ['position', 'aColor', 'aSize', 'aAlpha', 'aPulse']) this.localPoints.geometry.attributes[a].needsUpdate = true;
        this.localPoints.geometry.computeBoundingSphere();
    }

    _labelCap() {
        const lv = this._labelVis.level ?? 0;
        return lv >= 3 ? 12 : lv === 2 ? 6 : lv === 1 ? 3 : 0;
    }

    _requestTrack(index) {
        if (!this._worker || this._trackReq.has(index)) return;
        const line = this._trails.get(index);
        if (line && Math.abs(line.userData.jd - this.frameJd) < 0.5) return;   // rebuilt twice a sim-day at most
        const days = 3, steps = 49;
        const jd0 = this.frameJd - days, dt = (2 * days) / (steps - 1);
        const earthAt = [];
        for (let k = 0; k < steps; k++) { const e = this._earthFn?.(jd0 + k * dt); earthAt.push(e ? [e.x_AU, e.y_AU, e.z_AU] : this._earthOfDate); }
        const id = this._nextId++;
        this._trackReq.set(index, id);
        this._worker.postMessage({ type: 'track', id, index, jd: this.frameJd, days, steps, earthAt });
    }

    _applyTrack(msg) {
        this._trackReq.delete(msg.index);
        if (!this.els[msg.index]) return;
        const steps = msg.geo.length / 3;
        const arr = new Float32Array(steps * 3);
        for (let k = 0; k < steps; k++) {
            const off = geoToLocalScene(msg.geo[k * 3], msg.geo[k * 3 + 1], msg.geo[k * 3 + 2], this.earthR);
            arr[k * 3] = off.x; arr[k * 3 + 1] = off.y; arr[k * 3 + 2] = off.z;
        }
        let line = this._trails.get(msg.index);
        if (line) { this.localGroup.remove(line); line.geometry.dispose(); }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const el = this.els[msg.index];
        const base = this._flybySet?.has(msg.index)
            ? _cB.setHex(this.visible.colorMode === 'class' ? NEO_COLORS.flyby : NATURAL_COLORS.flyby)
            : colorFor(el, this.visible.colorMode, _cB);
        // Bright at "now" (the middle sample), fading to both ends — a ±3-day exposure.
        const col = new Float32Array(steps * 3);
        for (let k = 0; k < steps; k++) {
            const f = 1 - Math.abs(k / (steps - 1) - 0.5) * 2;
            const bb = 0.06 + 0.94 * f * f;
            col[k * 3] = base.r * bb; col[k * 3 + 1] = base.g * bb; col[k * 3 + 2] = base.b * bb;
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
        line.name = `neo-trail-${msg.index}`;
        line.userData.jd = msg.jd0 + (steps - 1) * msg.dtDays / 2;
        line.visible = this.visible.local;
        this.localGroup.add(line);
        this._trails.set(msg.index, line);
    }

    _clearTrails() {
        for (const [, line] of this._trails) { this.localGroup.remove(line); line.geometry.dispose(); }
        this._trails.clear(); this._trackReq.clear();
    }

    // ── Mesh LOD (rock pool) ────────────────────────────────────────────────

    /**
     * Drawn radius for a rock: TRUE scale in the drawn-Earth convention with a
     * screen-space floor — 5 px for the pool, 34 px for the selected object so
     * its shape and spin can be inspected. Returns rockDrawRadius()'s record;
     * `.r` is the scale, `.exaggeration` goes on the data card.
     */
    _rockRadius(el, camDist = this._camDist, index = null) {
        const d = el.diam ?? diameterKmFromH(el.H) ?? ((el.flags & FLAG.COMET) ? 3 : 0.1);
        const selected = index != null && index === this.selectedIndex;
        return rockDrawRadius(d, { camDist, minPx: selected ? ROCK_PX_SELECTED : ROCK_PX_FLOOR, viewHeightPx: this._viewH, fovDeg: this._fov, earthR: this.earthR });
    }

    _ensureRockSlots() {
        if (this._rockSlots.length) return;
        const placeholder = new THREE.IcosahedronGeometry(1, 0);
        for (let i = 0; i < ROCK_SLOTS; i++) {
            const mesh = new THREE.Mesh(placeholder, rockMaterial(0x9a9691));
            mesh.visible = false; mesh.name = `neo-rock-${i}`; mesh.renderOrder = 8; mesh.frustumCulled = false;
            this.group.add(mesh);
            this._rockSlots.push({ mesh, index: -1, geoKey: null, shape: null, spin: null, isComet: false });
        }
    }

    _geometryFor(el) {
        const key = String(el.des ?? el.name);
        let hit = this._geoCache.get(key);
        if (!hit) {
            const seed = hash32(key);
            const shape = shapeFor(el.des, seed);
            hit = { geo: rockGeometry({ seed, shape, detail: 7 }), shape };   // three subdivides LINEARLY: 7 ⇒ 1280 faces
            this._geoCache.set(key, hit);
            if (this._geoCache.size > GEO_CACHE_MAX) {
                const first = this._geoCache.keys().next().value;
                if (first !== key && !this._rockSlots.some(sl => sl.geoKey === first)) { this._geoCache.get(first).geo.dispose(); this._geoCache.delete(first); }
            }
        }
        return { key, ...hit };
    }

    _isCometLike(el) {
        return !!(el.flags & FLAG.COMET) || (!!(el.flags & FLAG.INTERSTELLAR) && /^(HYP|COM|JFc|JFC|HTC|ETc|CTc|PAR)$/.test(el.cls || ''));
    }

    _updateRocks(f) {
        if (!this.count || !this._pos || !f.camera) return;
        this._ensureRockSlots();
        if ((this._rockTick++ % 6) === 0) {
            const want = [], seen = new Set();
            const visOf = (k) => (this._baseVis ? this._baseVis[k] : 1);
            const add = (k) => { if (k != null && k >= 0 && !seen.has(k) && visOf(k)) { seen.add(k); want.push(k); } };
            add(this.selectedIndex);
            for (const k of this.inZone.slice(0, 12)) add(k);
            // Nearest to the camera inside ROCK_RANGE, from the heliocentric-frame positions.
            const cx = f.camera.position.x, cy = f.camera.position.y, cz = f.camera.position.z;
            const R2 = ROCK_RANGE * ROCK_RANGE;
            const near = [];
            for (let k = 0; k < this.count; k++) {
                if (!visOf(k)) continue;
                const dx = this._pos[k * 3] - cx, dy = this._pos[k * 3 + 1] - cy, dz = this._pos[k * 3 + 2] - cz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > R2) continue;
                if (near.length < ROCK_SLOTS || d2 < near[near.length - 1].d2) {
                    let i = near.length; near.push(null);
                    while (i > 0 && near[i - 1].d2 > d2) { near[i] = near[i - 1]; i--; }
                    near[i] = { k, d2 };
                    if (near.length > ROCK_SLOTS) near.pop();
                }
            }
            for (const n of near) { if (want.length >= ROCK_SLOTS) break; add(n.k); }
            const wantSet = new Set(want);
            for (const slot of this._rockSlots) if (slot.index >= 0 && !wantSet.has(slot.index)) { slot.index = -1; slot.mesh.visible = false; }
            const held = new Set(this._rockSlots.map(sl => sl.index));
            for (const k of want) {
                if (held.has(k)) continue;
                const slot = this._rockSlots.find(sl => sl.index < 0);
                if (!slot) break;
                const el = this.els[k];
                const g = this._geometryFor(el);
                slot.mesh.geometry = g.geo; slot.geoKey = g.key; slot.shape = g.shape;
                slot.spin = spinFor(el.des, hash32(String(el.des ?? el.name)));
                slot.isComet = this._isCometLike(el);
                slot.mesh.material.uniforms.u_base.value.copy(colorFor(el, this.visible.colorMode, _cB)).multiplyScalar(slot.isComet ? 0.55 : 0.9);
                slot.mesh.material.uniforms.u_glow.value = 0;
                slot.index = k;
                slot.mesh.visible = true;
                held.add(k);
            }
            const meshed = new Set(this._rockSlots.filter(sl => sl.index >= 0).map(sl => sl.index));
            let changed = meshed.size !== this._meshed.size;
            if (!changed) for (const k of meshed) if (!this._meshed.has(k)) { changed = true; break; }
            if (changed) { this._meshed = meshed; this._refreshAlpha(); if (this.rGeo) this._refreshLocalInstances(); }
        }
        // Position + spin every frame. Spin is a closed-form function of SIM
        // time (real period, seeded phase), so it warps and scrubs correctly.
        const simMs = this._simMs ?? Date.now();
        for (const slot of this._rockSlots) {
            if (slot.index < 0) continue;
            const p = this.drawnPosition(slot.index, slot.mesh.position);
            if (!p) { slot.mesh.visible = false; continue; }
            slot.mesh.visible = true;
            // Scale every frame: the floor rides the camera distance to THIS rock.
            const rk = this._rockRadius(this.els[slot.index], f.camera.position.distanceTo(p), slot.index);
            slot.mesh.scale.setScalar(rk.r);
            if (slot.index === this.selectedIndex) this._selectedDraw = { index: slot.index, ...rk };
            const ang = ((simMs / 3.6e6 / slot.spin.periodH) * Math.PI * 2 + slot.spin.phase) % (Math.PI * 2);
            // Spin about the body's own symmetry axis (geometry +Y), tilted to the seeded pole.
            _qSpin.setFromAxisAngle(_Y, ang);
            slot.mesh.quaternion.setFromUnitVectors(_Y, slot.spin.axis).multiply(_qSpin);
            if (slot.isComet && this.rHelio) {
                const r = this.rHelio[slot.index];
                slot.mesh.material.uniforms.u_glow.value = r < TAIL_MAX_R ? Math.min(1, 0.9 / (r * r)) : 0;
            }
        }
    }

    // ── Selection / bodies ──────────────────────────────────────────────────

    /** Body object in the shape solar-system.html's selectBody() expects. */
    bodyFor(index) {
        const el = this.els[index];
        if (!el) return null;
        let b = this._bodies.get(index);
        if (!b) {
            b = { name: displayName(el), type: classLabel(el), radius: this._rockRadius(el, 0.09, index).rTrue || 1e-4, color: colorFor(el, this.visible.colorMode, _cB).getHex(), mesh: this.anchor, neoIndex: index, des: el.des, data: {} };
            this._bodies.set(index, b);
        }
        b.data = this.readout(index);
        return b;
    }

    /** Select by index (or null to clear). Rebuilds the orbit line and marker. */
    select(index) {
        if (index != null && !this.els[index]) index = null;
        this.selectedIndex = index;
        this._selectedDes = index != null ? this.els[index].des : null;
        if (this.orbitLine) { this.group.remove(this.orbitLine); this.orbitLine.geometry.dispose(); this.orbitLine = null; }
        this._clearOrbitMarks();
        if (this._dropLine) this._dropLine.visible = false;
        this._selectedDraw = null;
        const key = 'selected';
        const old = this._labels.get(key);
        if (old) { this.group.remove(old); old.material.map.dispose(); old.material.dispose(); this._labels.delete(key); }
        this.selectedMarker.visible = index != null;
        if (index != null) {
            // setCamLock() reads anchor.position synchronously — seat it now.
            const p = this.drawnPosition(index, this.anchor.position);
            if (p) this.selectedMarker.position.copy(p);
            const tint = colorFor(this.els[index], this.visible.colorMode, _cB).lerp(_cB.clone().set(0xffffff), 0.35).clone();
            for (const m of this.selectedMarker.children) m.material.color.copy(tint);
            this._buildOrbit(index);
            const s = makeLabel(displayName(this.els[index]), { color: '#ffffff', size: 21, weight: 600 });
            this.group.add(s); this._labels.set(key, s);
        }
        this._refreshAlpha();
        this.emit('select', index != null ? this.bodyFor(index) : null);
        return index != null ? this.bodyFor(index) : null;
    }

    selectByDes(des) {
        const idx = this.byDes.get(String(des));
        return idx == null ? null : this.select(idx);
    }

    _buildOrbit(index) {
        const el = this.els[index];
        const jd = this._lastJd ?? this.frameJd ?? el.epoch;
        const pts = sampleOrbit(el, el.e < 1 ? 360 : 200, 60);
        const prec = precessionLongitudeRad(jd);
        const arr = new Float32Array(pts.length * 3);
        for (let k = 0; k < pts.length; k++) {
            const d = rotateAboutPole(pts[k].x, pts[k].y, pts[k].z, prec);
            const s = helioToScene(d.x, d.y, d.z);
            arr[k * 3] = s.x; arr[k * 3 + 1] = s.y; arr[k * 3 + 2] = s.z;
        }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const Ctor = el.e < 1 ? THREE.LineLoop : THREE.Line;
        this.orbitLine = new Ctor(g, new THREE.LineBasicMaterial({ color: colorFor(el, this.visible.colorMode, _cB).getHex(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.orbitLine.name = 'neo-orbit';
        this.orbitLine.visible = this.visible.orbit;
        this.orbitLine.renderOrder = 3;
        this.group.add(this.orbitLine);
        this._orbitBuiltJd = jd;
        this._buildOrbitMarks(el, prec);
    }

    /**
     * Analysis marks on the selected orbit: ☊ / ☋ where it pierces the
     * ecliptic (with the heliocentric distance there — an Earth-crosser is one
     * whose node sits inside 0.983–1.017 AU) and q, the perihelion. Every
     * number comes from the kernel (nodeDistancesAU / positionAtTrueAnomaly).
     */
    _buildOrbitMarks(el, prec) {
        this._clearOrbitMarks();
        const nd = nodeDistancesAU(el);
        const w = el.w * D2R;
        const tint = colorFor(el, this.visible.colorMode, _cB).lerp(_cB.clone().set(0xffffff), 0.5).getStyle();
        const add = (nu, text, color) => {
            const q = positionAtTrueAnomaly(el, nu);
            if (!(q.r > 0) || q.r > 60) return;
            const d = rotateAboutPole(q.x, q.y, q.z, prec);
            const sc = helioToScene(d.x, d.y, d.z);
            const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(), color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, sizeAttenuation: false }));
            dot.scale.set(0.011, 0.011, 1); dot.position.set(sc.x, sc.y, sc.z); dot.renderOrder = 16; dot.name = 'neo-orbit-mark';
            const label = makeLabel(text, { color, size: 15 });
            label.position.set(sc.x, sc.y + 0.012, sc.z); label.name = 'neo-orbit-mark-label';
            dot.visible = label.visible = this.visible.orbit;
            this.group.add(dot, label);
            this._orbitMarks.push(dot, label);
        };
        if (nd.asc != null) add(-w, `☊ ${nd.asc.toFixed(3)} AU`, '#9ef0b0');
        if (nd.desc != null) add(Math.PI - w, `☋ ${nd.desc.toFixed(3)} AU`, '#ffb090');
        add(0, `q ${el.q.toFixed(3)} AU`, tint);
    }

    _clearOrbitMarks() {
        for (const o of this._orbitMarks) { this.group.remove(o); if (o.material.map && o.material.map !== _dotTex) o.material.map.dispose(); o.material.dispose(); }
        this._orbitMarks = [];
    }

    /** Vertical from the selected object to the ecliptic plane — the inclination made visible. */
    _updateDropLine(p, inHelioFrame) {
        if (!this._dropLine) {
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
            this._dropLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
            this._dropLine.name = 'neo-drop-line'; this._dropLine.renderOrder = 3; this._dropLine.frustumCulled = false;
            this.group.add(this._dropLine);
        }
        const vis = !!p && inHelioFrame && this.visible.orbit;
        this._dropLine.visible = vis;
        if (!vis) return;
        const a = this._dropLine.geometry.attributes.position.array;
        a[0] = p.x; a[1] = p.y; a[2] = p.z; a[3] = p.x; a[4] = 0; a[5] = p.z;
        this._dropLine.geometry.attributes.position.needsUpdate = true;
        this._dropLine.material.color.copy(colorFor(this.els[this.selectedIndex], this.visible.colorMode, _cB));
    }

    /** Drawn position of an object right now (local frame when inside the zone). */
    drawnPosition(index, out = new THREE.Vector3()) {
        const el = this.els[index];
        if (!el) return null;
        const jd = this._lastJd ?? this.frameJd;
        const g = this.geocentricAt(index, jd);
        if (!g) return null;
        const dLD = toLD(Math.hypot(g.x, g.y, g.z));
        const w = this.visible.local ? localFrameWeight(dLD) : 1;
        if (w < 0.5) {
            const off = geoToLocalScene(g.x, g.y, g.z, this.earthR);
            return out.set(this._earthDrawn.x + off.x, this._earthDrawn.y + off.y, this._earthDrawn.z + off.z);
        }
        const s = helioToScene(g.helio.x, g.helio.y, g.helio.z);
        return out.set(s.x, s.y, s.z);
    }

    /** Live data card rows for the Selected Body table. */
    readout(index) {
        const el = this.els[index];
        if (!el) return {};
        const jd = this._lastJd ?? this.frameJd ?? el.epoch;
        const p = propagate(el, jd, true);
        const g = this.geocentricAt(index, jd);
        const dGeo = g ? Math.hypot(g.x, g.y, g.z) : null;
        const notable = findNotable(el);
        const next = this.watch.approaches.filter(a => a.des === el.des && a.t_ms >= (this._simMs ?? Date.now()) - 86400e3).sort((a, b) => a.t_ms - b.t_ms)[0];
        const sentry = this.watch.sentry.find(s => s.des === el.des);
        const dKm = el.diam ?? diameterKmFromH(el.H);
        const out = {};
        if (notable) out['Why it matters'] = notable.why;
        out['Designation'] = el.des ?? '—';
        out['Class'] = classLabel(el);
        out['Distance from Earth'] = dGeo != null ? `${formatLD(dGeo)} · ${dGeo.toFixed(4)} AU` : '—';
        out['Distance from Sun'] = `${p.r.toFixed(3)} AU`;
        out['Heliocentric speed'] = `${speedKms(p.vx, p.vy, p.vz).toFixed(1)} km/s`;
        if (g) {
            // What a telescope sees now, and where to point it — all from the kernel.
            const E = this._earthOfDate;
            const alpha = phaseAngleDeg(g.helio.x, g.helio.y, g.helio.z, g.x, g.y, g.z);
            const elong = elongationDeg(E[0], E[1], E[2], g.x, g.y, g.z);
            const V = apparentMagnitude(el.H, p.r, dGeo, alpha, { comet: !!(el.flags & FLAG.COMET) });
            out['Apparent magnitude'] = (V != null ? `V ${V.toFixed(1)}` : 'no H') + (alpha != null ? ` · phase ${alpha.toFixed(0)}° · elongation ${elong.toFixed(0)}° from the Sun` : '');
            // Earth's velocity by central difference through the page's own ephemeris; the object's J2000 velocity rotated to date.
            if (this._earthFn) {
                const e1 = this._earthFn(jd - 0.05), e2 = this._earthFn(jd + 0.05);
                const pr = precessionLongitudeRad(jd), c = Math.cos(pr), sn = Math.sin(pr);
                const vx = c * p.vx - sn * p.vy, vy = sn * p.vx + c * p.vy;
                const rx = vx - (e2.x_AU - e1.x_AU) / 0.1, ry = vy - (e2.y_AU - e1.y_AU) / 0.1, rz = p.vz - (e2.z_AU - e1.z_AU) / 0.1;
                out['Speed relative to Earth'] = `${speedKms(rx, ry, rz).toFixed(1)} km/s`;
            }
            const hl = eclipticLonLatDeg(g.helio.x, g.helio.y, g.helio.z), gl = eclipticLonLatDeg(g.x, g.y, g.z);
            out['Ecliptic position (of date)'] = `helio λ ${hl.lon.toFixed(2)}° β ${hl.lat.toFixed(2)}° · geo λ ${gl.lon.toFixed(2)}° β ${gl.lat.toFixed(2)}°`;
        }
        out['Size'] = el.diam != null ? `${formatSize(el.diam)} (measured)` : (el.H != null ? `${formatSize(dKm)} (from H ${el.H.toFixed(1)}, albedo 0.14 assumed)` : '—');
        out['Orbit a · e · i'] = `${Math.abs(el.a).toFixed(3)} AU · ${el.e.toFixed(4)} · ${el.i.toFixed(2)}°`;
        out['Perihelion · aphelion'] = el.e < 1 ? `${el.q.toFixed(3)} · ${el.Q.toFixed(3)} AU` : `${el.q.toFixed(3)} AU · unbound (e > 1)`;
        out['Period'] = el.per_y != null ? (el.per_y < 2 ? `${(el.per_y * 365.25).toFixed(0)} days` : `${el.per_y.toFixed(2)} yr`) : 'unbound — leaving the Solar System';
        const nd = nodeDistancesAU(el);
        out['Node crossings'] = `☊ ${nd.asc != null ? nd.asc.toFixed(3) + ' AU' : '—'} · ☋ ${nd.desc != null ? nd.desc.toFixed(3) + ' AU' : '—'} — ${earthCrossingNote(nd)}`;
        const tj = tisserandJ(el.a, el.e, el.i);
        if (tj != null) out['Tisserand T_J'] = `${tj.toFixed(2)} · ${tj > 3 ? 'asteroidal' : tj > 2 ? 'Jupiter-family (comet-like) dynamics' : 'Halley-type / long-period dynamics'}`;
        const tpj = nextPerihelionJD(el, jd);
        out['Next perihelion'] = tpj != null ? `${jdToIsoDate(tpj)} · in ${(tpj - jd).toFixed(0)} d` : 'passed — outbound';
        if (el.moid != null) out['Earth MOID'] = `${formatLD(el.moid)} · ${el.moid.toFixed(4)} AU`;
        const dr = this._selectedDraw && this._selectedDraw.index === index ? this._selectedDraw : null;
        if (dr) out['Drawn size'] = dr.exaggeration == null ? 'size unknown — a marker, not a shape'
            : dr.atFloor ? `×${dr.exaggeration >= 100 ? Math.round(dr.exaggeration).toLocaleString() : dr.exaggeration.toFixed(1)} true size (screen-space floor — shape and spin are real, the size is not)`
            : 'true scale';
        if (next) out['Next close approach'] = `${new Date(next.t_ms).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${formatLD(next.dist_au)} · ${next.v_rel_kms != null ? next.v_rel_kms.toFixed(1) + ' km/s' : ''}`;
        if (sentry) out['Impact monitor'] = `Sentry-listed · Torino ${sentry.ts_max} · Palermo ${sentry.ps_cum} · P(impact) ${sentry.ip != null ? sentry.ip.toExponential(1) : '—'} (${sentry.range ?? '—'})`;
        out['Propagation'] = `${elementsAgeNote(el.epoch, jd)} · JPL SBDB osculating elements`;
        return out;
    }

    // ── Toggles ─────────────────────────────────────────────────────────────

    setVisible(patch) {
        Object.assign(this.visible, patch);
        if (this.orbitLine) this.orbitLine.visible = this.visible.orbit;
        for (const o of this._orbitMarks) o.visible = this.visible.orbit;
        this.localGroup.visible = this.visible.local;
        for (const [, line] of this._trails) line.visible = this.visible.local;
        for (const r of this._radiants) { const v = this.visible.radiants; r.line.visible = v; r.cone.visible = v; r.label.visible = v; r.stream.visible = v; r.rocks.mesh.visible = v; }
        for (const slot of this._rockSlots) if (slot.index >= 0) slot.mesh.material.uniforms.u_base.value.copy(colorFor(this.els[slot.index], this.visible.colorMode, _cB)).multiplyScalar(slot.isComet ? 0.55 : 0.9);
        if (this.rGeo) this._refreshCometTails();
        this._applyStyles();
        if (this.rGeo) this._refreshLocalInstances();
    }

    // ── Picking ─────────────────────────────────────────────────────────────

    /**
     * @param {THREE.Raycaster} raycaster  already set from the camera
     * @param {number} camDist            camera → controls.target distance (scales the pick radius)
     */
    pick(raycaster, camDist = 20) {
        if (!this.points) return null;
        const prevParams = raycaster.params.Points;
        raycaster.params.Points = { ...(prevParams || {}), threshold: Math.max(0.01, 0.012 * camDist) };
        const hits = raycaster.intersectObjects([this.localPoints, this.points], false);
        raycaster.params.Points = prevParams;
        // Points intersections sort by distance ALONG the ray; a click means "the
        // one nearest the cursor", which is distanceToRay.
        hits.sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0));
        for (const h of hits) {
            if (h.object === this.localPoints) {
                const k = this._localIndices[h.index];
                if (k != null && this._lalpha[h.index] > 0.05) return this.bodyFor(k);
            } else if (h.object === this.points) {
                if (this._alpha[h.index] > 0.05) return this.bodyFor(h.index);
            }
        }
        return null;
    }

    // ── Meteor showers ──────────────────────────────────────────────────────

    /** Active showers at the current sim λ☉ (cached per frame). */
    showers() { return this._showers ?? { active: [], next: null, solarLon: null }; }

    _refreshRadiants(jd, earthLonRad) {
        const lon = solarLongitudeDeg(earthLonRad);
        const active = activeShowers(lon);
        this._showers = { active, next: nextShower(lon), solarLon: lon };
        const want = active.filter(x => x.activity >= 0.2).slice(0, 3);
        const wantCodes = new Set(want.map(x => x.shower.code));
        for (const r of this._radiants.slice()) {
            if (!wantCodes.has(r.code)) {
                this.localGroup.remove(r.line, r.cone, r.label, r.stream, r.rocks.mesh);
                r.line.geometry.dispose(); r.cone.geometry.dispose(); r.label.material.map.dispose();
                r.stream.geometry.dispose(); r.stream.material.dispose(); r.rocks.dispose();
                this._radiants.splice(this._radiants.indexOf(r), 1);
            }
        }
        const prec = precessionLongitudeRad(jd);
        for (const x of want) {
            const s = x.shower;
            let r = this._radiants.find(q => q.code === s.code);
            const u0 = radiantEclipticUnit(s.ra, s.dec);
            const u = rotateAboutPole(u0.x, u0.y, u0.z, prec);
            // Scene axis swap; arrow points INBOUND (meteoroids come from the radiant).
            const dir = new THREE.Vector3(u.x, u.z, u.y);
            const tail = dir.clone().multiplyScalar(1.05), head = dir.clone().multiplyScalar(0.34);
            // The shaft is a thin cylinder, not a GL line: WebGL lines are 1 px
            // wide whatever the zoom and vanish against the point cloud.
            const len = tail.length() - head.length();
            const mid = head.clone().add(tail).multiplyScalar(0.5);
            if (!r) {
                // A hairline guide with a small head; the STREAM carries the visual weight.
                const shaftMat = new THREE.MeshBasicMaterial({ color: NEO_COLORS.radiant, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
                const line = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, len, 6), shaftMat);
                const cone = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.07, 10), shaftMat);
                const label = makeLabel(`☄ ${s.name} · ZHR ~${Math.round(s.zhr * x.activity)} · ${s.vKms} km/s`, { color: '#ffd27a', size: 19 });
                const stream = makeStream(Math.round(70 + 170 * x.activity), 0xfff1c8);
                // The meteoroids themselves: instanced tumbling rocks on the same cone.
                const rocks = new MeteoroidStream({ count: Math.round(90 + 130 * x.activity), seed: hash32(s.code) });
                line.name = `neo-radiant-${s.code}`;
                stream.name = `neo-stream-${s.code}`;
                rocks.mesh.name = `neo-meteoroids-${s.code}`;
                this.localGroup.add(line, cone, label, stream, rocks.mesh);
                r = { code: s.code, line, cone, label, stream, rocks };
                this._radiants.push(r);
            }
            r.line.position.copy(mid);
            r.line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            r.cone.position.copy(head);
            r.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
            r.label.position.copy(tail).addScalar(0.02);
            r.stream.material.uniforms.u_dir.value.copy(dir);
            r.stream.material.uniforms.u_speed.value = s.vKms / 40;   // faster streams pour in faster
            r.rocks.setDirection(dir); r.rocks.setSpeed(s.vKms / 40);
            const vis = this.visible.radiants;
            r.line.visible = vis; r.cone.visible = vis; r.label.visible = vis; r.stream.visible = vis; r.rocks.mesh.visible = vis;
        }
    }

    // ── Per-frame update (called from the page's animate loop) ──────────────

    /**
     * @param {{ jd:number, earthOfDate:{x_AU,y_AU,z_AU,lon_rad}, earthFn?:(jd)=>object,
     *           earthDrawn:THREE.Vector3, t:number, simMs?:number, camera?:THREE.Camera, camDist?:number, viewH?:number }} f
     */
    update(f) {
        this._t = f.t ?? this._t + 0.016;
        this._pointsMat.uniforms.u_time.value = this._t;
        for (const r of this._radiants) { r.stream.material.uniforms.u_time.value = this._t; r.rocks.update(this._t); }
        this._earthDrawn.copy(f.earthDrawn);
        this._earthOfDate = [f.earthOfDate.x_AU, f.earthOfDate.y_AU, f.earthOfDate.z_AU];
        this._earthFn = f.earthFn ?? this._earthFn;
        this._simMs = f.simMs ?? this._simMs;
        const jdChanged = this._lastJd == null || Math.abs(f.jd - this._lastJd) > 1e-4;
        this._lastJd = f.jd;
        this.localGroup.position.copy(this._earthDrawn);
        this._camDist = f.camDist ?? this._camDist;
        if (f.viewH > 0) this._viewH = f.viewH;
        if (f.camera?.fov) this._fov = f.camera.fov;
        if (f.camera) {
            const dEarth = Math.max(0.05, f.camera.position.distanceTo(this._earthDrawn));
            const r1 = this.rings[0].r, r20 = this.rings[this.rings.length - 1].r;
            // fov 50°: a radius r at distance d spans ≈ 1.07·r/d of the view height.
            const rings = this.visible.local && r1 / dEarth > 0.02;
            const frac = r20 / dEarth;
            // Label LADDER: 0 none · 1 the three closest · 2 six · 3 twelve (see
            // _labelCap). Six labels at frac 0.27 still overlapped in the capture
            // (constant-screen-size text on a 300 px disc), hence 0.45 / 0.9.
            const level = !(this.visible.local && this.visible.labels) ? 0 : frac >= 0.9 ? 3 : frac >= 0.45 ? 2 : frac > 0.08 ? 1 : 0;
            const objects = level > 0;
            if (rings !== this._labelVis.rings || objects !== this._labelVis.objects || level !== (this._labelVis.level ?? 0)) {
                this._labelVis = { rings, objects, level };
                for (const r of this.rings) r.label.visible = rings;
                const cap = this._labelCap();
                for (const [key, sp] of this._labels) if (key.startsWith('local:')) sp.visible = objects && (sp.userData.rank ?? 0) < cap;
            }
        }
        if (jdChanged) this._requestFrame(false);
        // Radiants ride the sim date (λ☉ moves ~1°/day, cheap to re-evaluate every ~0.1 d).
        if (this._radiantJd == null || Math.abs(f.jd - this._radiantJd) > 0.1) { this._radiantJd = f.jd; this._refreshRadiants(f.jd, f.earthOfDate.lon_rad); }
        // Flyby highlight set depends on the sim date (±7 d) — refresh every sim-day.
        if (this._styleMs == null || Math.abs((this._simMs ?? 0) - this._styleMs) > 86400e3) { this._styleMs = this._simMs ?? 0; if (this.points) this._applyStyles(); }
        this._updateRocks(f);
        // Selected object: anchor, marker, label, orbit (re-oriented if the date moved a lot).
        if (this.selectedIndex != null) {
            const p = this.drawnPosition(this.selectedIndex, this.anchor.position);
            if (p) {
                this.selectedMarker.position.copy(p);
                // The reticle rides the rock's drawn radius (a 34 px floor when
                // selected), so it is ~58 px at any zoom instead of a 0.35-unit disc.
                const dCam = f.camera ? f.camera.position.distanceTo(p) : this._camDist;
                const rr = this._rockRadius(this.els[this.selectedIndex], dCam, this.selectedIndex).r;
                this.selectedMarker.scale.setScalar(rr * 1.7 / 0.021);
                this.selectedMarker.lookAt(f.camera ? f.camera.position : new THREE.Vector3(0, 50, 0));
                const s = this._labels.get('selected');
                // Offset along the CAMERA's up, not world +y: from the top view a
                // world-up offset points at the camera and the label sat on the rock.
                if (s) {
                    _camUp.set(0, 1, 0); if (f.camera) _camUp.applyQuaternion(f.camera.quaternion);
                    s.position.copy(p).addScaledVector(_camUp, rr * 2.4 + dCam * 0.04);
                }
                const gsel = this.geocentricAt(this.selectedIndex, f.jd);
                const inHelio = !gsel || !this.visible.local || localFrameWeight(toLD(Math.hypot(gsel.x, gsel.y, gsel.z))) >= 0.5;
                this._updateDropLine(p, inHelio);
            } else this._updateDropLine(null, false);
            if (this._orbitBuiltJd != null && Math.abs(f.jd - this._orbitBuiltJd) > 30) this._buildOrbit(this.selectedIndex);
        }
    }
}
