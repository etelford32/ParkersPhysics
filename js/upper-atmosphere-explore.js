/**
 * upper-atmosphere-explore.js — what the explorer sees besides the air
 * ═══════════════════════════════════════════════════════════════════════════
 * three.js half of explore mode (kernel: -explore-model.js). Three things:
 *
 *   • BOUNDARY MEMBRANES. Every layer boundary (from the canonical schema),
 *     the Kármán line and the model ceiling, drawn as a faint lat/lon grid
 *     on its own sphere while the camera is near it — the strongest depth
 *     cue there is for "you are about to pass through a surface", and the
 *     one exploration games use for a planetary approach. They are MARKERS,
 *     not physical surfaces, and the legend says so.
 *
 *     They are ANALYTIC: one pass on a bounding sphere whose fragment
 *     shader intersects each view ray with every boundary sphere exactly.
 *     A tessellated sphere at 85 km seen from 100 km has its horizon ~10°
 *     away, which is precisely where mesh facets show (the planet's own
 *     720-face icosphere did, plan §9.5); an analytic hit has no facets at
 *     any range, needs no geometry per boundary, and is occluded by the
 *     planet analytically. Line width is the pixel's footprint in lat/lon
 *     computed ANALYTICALLY from the ray-sphere hit (how far the hit point
 *     slides when the ray moves one pixel along screen x and y), NOT from
 *     fwidth: derivatives inside the per-boundary loop are in non-uniform
 *     control flow and undefined. It must be PER LINE FAMILY and
 *     anisotropic — the first version divided an isotropic width by the
 *     grazing cosine, and a latitude line receding to the horizon under the
 *     camera bloomed into a 30 px orange wedge (measured; only the
 *     along-view direction is foreshortened, not the across-line one).
 *     Visibility is `membraneWeight` (a Gaussian in log altitude), so the
 *     pass is skipped entirely from the default orbit view.
 *
 *   • POINT-OF-INTEREST BEACONS. A beam from the ground to each POI's
 *     altitude and a ring marker at the top, visible from orbit so there is
 *     somewhere to go. The positions are the kernel's (placed by the model);
 *     this file only draws them.
 *
 *   • AURORAL CURTAINS on the page's own oval (`auroraCurtain`, the same
 *     parameterisation the magnetic cascade's oval lines use) for the live
 *     Kp: vertical ribbons from 100 to 300 km, green (557.7 nm) low and red
 *     (630 nm) high, a sharp lower border as real curtains have, drifting
 *     rays and folds. Placement is the model's; brightness and folds are
 *     SYMBOLIC and the panel says so. They fade in only as the camera comes
 *     down toward the band, so the default orbit view is unchanged, and
 *     they are double-sided so the camera can fly through them.
 *
 *   • EVENTS. Boundary crossings, altitude milestones and POI discoveries
 *     are detected here, once per frame, and handed to the page as events.
 *     Discoveries persist per viewer in localStorage (a convenience: every
 *     access is wrapped, and the page works without it).
 */

import * as THREE from 'three';
import {
    BOUNDARIES, membraneWeight, boundaryCrossings, milestonesReached,
    isAtPoi, pointsOfInterest, MILESTONES, R_EARTH_KM, EXPLORE, gridLevel,
    auroraCurtain, AURORA_CURTAIN, apToKp,
} from './upper-atmosphere-explore-model.js';
import { latLonToScene, sceneToLatLon } from './upper-atmosphere-column.js';
import { capPointSize } from './upper-atmosphere-point-cap.js';
import { frameClock } from './upper-atmosphere-frame-clock.js';

const NB = BOUNDARIES.length;
const STORE_KEY = 'ua_explore_found_v1';

const MEMBRANE_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// NB is interpolated from the kernel's boundary table, never typed.
const MEMBRANE_FRAG = /* glsl */`
#define NB ${NB}
uniform vec3 uCam;
uniform float uR[NB];
uniform float uW[NB];
uniform vec3 uCol[NB];
uniform float uFade[NB];
uniform float uLevel[NB];
uniform float uNear[NB];
uniform float uPixAng;
uniform float uGain;
uniform vec3 uRight;
uniform vec3 uUpV;
varying vec3 vWorld;

vec2 sphereHits(vec3 o, vec3 d, float R) {
    float b = dot(o, d);
    float c = dot(o, o) - R * R;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}

// A grid line at every HALF-integer of x, about w cells wide, faded out
// where the cells shrink below a few pixels (they would only alias). Half,
// not whole: dives land on round coordinates (the default view's sub-point
// is exactly 90 W, the equator, the solar declination), and a camera flying
// exactly along a grid line drew a stripe straight down the middle of the
// view. The grid is a marker, not a graticule, so nothing reads off it.
float gridLine(float x, float w) {
    float f = abs(fract(x) - 0.5);
    return (1.0 - smoothstep(0.5 * w, 1.5 * w, f)) * (1.0 - smoothstep(0.25, 0.6, w));
}

vec3 membrane(vec3 p, vec3 d, float t, float R, vec3 col, float fadeL, float level, float nearA) {
    vec3 n = p / R;
    float latD = degrees(asin(clamp(n.y, -1.0, 1.0)));
    float lonD = degrees(atan(-n.z, n.x));
    float nd = dot(n, d);
    float cosInc = abs(nd);
    float ndSafe = nd < 0.0 ? min(nd, -0.02) : max(nd, 0.02);
    // One pixel of ray motion along screen x and y, and how far the hit
    // point slides on the sphere for each (dp = t (dd - d (n.dd)/(n.d))).
    vec3 ddx = uPixAng * (uRight - d * dot(d, uRight));
    vec3 ddy = uPixAng * (uUpV - d * dot(d, uUpV));
    vec3 px = t * (ddx - d * dot(n, ddx) / ndSafe);
    vec3 py = t * (ddy - d * dot(n, ddy) / ndSafe);
    float cl = max(length(n.xz), 1.0e-3);
    vec3 east = vec3(-n.z, 0.0, n.x) * (-1.0 / cl);
    vec3 north = cross(n, east);
    float k = 57.29578 / R;
    float wLat = k * (abs(dot(px, north)) + abs(dot(py, north)));
    float wLon = k * (abs(dot(px, east)) + abs(dot(py, east))) / cl;
    // Spacing ladder in powers of two degrees, blended continuously so a
    // descent never pops lines: level L sits between 2^floor(L) and twice it.
    float fl = floor(level);
    float f = level - fl;
    float s0 = exp2(fl);
    float s1 = 2.0 * s0;
    float g1 = max(gridLine(latD / s1, wLat / s1), gridLine(lonD / s1, wLon / s1));
    float g0 = max(gridLine(latD / s0, wLat / s0), gridLine(lonD / s0, wLon / s0));
    float gf = max(gridLine(latD / (0.25 * s0), wLat / (0.25 * s0)), gridLine(lonD / (0.25 * s0), wLon / (0.25 * s0)));
    float coarse = max(g1, (1.0 - f) * g0);
    float rim = pow(1.0 - cosInc, 5.0);
    // Far fade, and a NEAR fade that starts at the camera's own height above
    // this surface: without it a camera sitting exactly on a boundary gets a
    // rounding-level hit at t = 0, on a grid meridian (dives land on round
    // coordinates), and the line floods a wedge of the view (measured).
    float fade = exp(-t / fadeL) * smoothstep(nearA, 4.0 * nearA, t);
    return col * fade * (0.5 * coarse + 0.18 * gf + 0.2 * rim);
}

void main() {
    vec3 o = uCam;
    vec3 d = normalize(vWorld - uCam);
    vec2 e = sphereHits(o, d, 1.0);
    float tEarth = e.x > 0.0 ? e.x : 1.0e9;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < NB; i++) {
        if (uW[i] < 0.002) continue;
        vec2 h = sphereHits(o, d, uR[i]);
        if (h.x > 0.0 && h.x < tEarth) acc += uW[i] * membrane(o + h.x * d, d, h.x, uR[i], uCol[i], uFade[i], uLevel[i], uNear[i]);
        if (h.y > 0.0 && h.y < tEarth) acc += uW[i] * membrane(o + h.y * d, d, h.y, uR[i], uCol[i], uFade[i], uLevel[i], uNear[i]);
    }
    gl_FragColor = vec4(acc * uGain, 1.0);
}
`;

const AURORA_VERT = /* glsl */`
attribute float aV;
attribute float aS;
attribute float aI;
varying float vV;
varying float vS;
varying float vI;
void main() {
    vV = aV; vS = aS; vI = aI;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURORA_FRAG = /* glsl */`
uniform float uTime;
uniform float uFade;
varying float vV;
varying float vS;
varying float vI;
float hash1(float n) { return fract(sin(n) * 43758.5453); }
// Value noise that repeats every P cells, so a pattern laid along the ring's
// 0-24 h coordinate closes on itself at the seam (magnetic midnight, which
// is exactly where the aurora stop looks).
float noiseP(float x, float P) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash1(mod(i, P)), hash1(mod(i + 1.0, P)), u);
}
void main() {
    // Fine vertical rays along the curtain and slow large folds (symbolic),
    // every term periodic in 24 h of MLT. Seen edge-on the rays crowd below
    // a pixel and alias into a barcode, so they relax to their mean as the
    // screen-space density climbs (fwidth is safe here: no loop, uniform
    // control flow).
    float s = vS * 22.0;
    float raysRaw = 0.45 + 0.55 * noiseP(s + uTime * 0.5, 528.0) * noiseP(s * 2.0 - uTime * 0.8, 1056.0);
    float rays = mix(raysRaw, 0.6, smoothstep(0.25, 0.9, fwidth(s)));
    // Six folds around the oval, wobbled by an 11-cycle term (2 pi / 24 h = 0.2618).
    float folds = 0.55 + 0.45 * sin(vS * 1.5708 + uTime * 0.12 + 1.6 * sin(vS * 2.8798 + 0.7));
    // A sharp lower border and a long fade upward, as real curtains have.
    float lower = smoothstep(0.0, 0.05, vV);
    float upper = 1.0 - smoothstep(0.3, 1.0, vV);
    vec3 green = vec3(0.30, 1.00, 0.52);
    vec3 red = vec3(1.00, 0.24, 0.34);
    vec3 col = mix(green, red, smoothstep(0.22, 0.75, vV));
    float a = vI * rays * folds * lower * (0.2 + 0.8 * upper) * uFade;
    gl_FragColor = vec4(col * a, 1.0);
}
`;

function _ringTexture(size = 64) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const m = size / 2;
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = size * 0.09;
    g.beginPath(); g.arc(m, m, size * 0.36, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath(); g.arc(m, m, size * 0.11, 0, Math.PI * 2); g.fill();
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
}

function _loadFound() {
    try {
        const raw = window.localStorage?.getItem(STORE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : []);
    } catch (_) { return new Set(); }
}
function _saveFound(set) {
    try { window.localStorage?.setItem(STORE_KEY, JSON.stringify([...set])); } catch (_) { /* private mode */ }
}

export class ExploreLayer {
    /**
     * @param {THREE.Scene} scene
     * @param {object} deps
     * @param {() => {subSolarLatDeg,subSolarLonDeg,f107Sfu,ap,iss}} deps.getPoiInputs
     * @param {(ev:object) => void} [deps.onEvent]
     */
    constructor(scene, { getPoiInputs, onEvent = null }) {
        this._scene = scene;
        this._getPoiInputs = getPoiInputs;
        this._onEvent = onEvent;
        this._membranesOn = true;
        this._beaconsOn = true;
        this._found = _loadFound();
        this._pois = [];
        this._poiAt = -Infinity;
        this._prevAlt = null;
        this._lastDiscoveryCheck = 0;
        this._weights = new Array(NB).fill(0);

        // ── Membranes ────────────────────────────────────────────────
        const uniforms = {
            uCam:    { value: new THREE.Vector3() },
            uR:      { value: BOUNDARIES.map(b => 1 + b.km / R_EARTH_KM) },
            uW:      { value: new Array(NB).fill(0) },
            uCol:    { value: BOUNDARIES.map(b => new THREE.Color(b.colorHex)) },
            uFade:   { value: new Array(NB).fill(0.05) },
            uLevel:  { value: new Array(NB).fill(3) },
            uNear:   { value: new Array(NB).fill(0.001) },
            uPixAng: { value: 0.001 },
            uGain:   { value: 0.75 },
            uRight:  { value: new THREE.Vector3(1, 0, 0) },
            uUpV:    { value: new THREE.Vector3(0, 1, 0) },
        };
        this._memMat = new THREE.ShaderMaterial({
            vertexShader: MEMBRANE_VERT, fragmentShader: MEMBRANE_FRAG, uniforms,
            side: THREE.BackSide, transparent: true,
            depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const rBound = 1 + (Math.max(...BOUNDARIES.map(b => b.km)) + 150) / R_EARTH_KM;
        this._memMesh = new THREE.Mesh(new THREE.SphereGeometry(rBound, 48, 24), this._memMat);
        this._memMesh.frustumCulled = false;
        this._memMesh.renderOrder = 2;
        this._memMesh.visible = false;
        this._memMesh.name = 'explore-membranes';
        this._memMesh.userData = { kind: 'explore-membranes' };
        scene.add(this._memMesh);

        // ── POI beacons ──────────────────────────────────────────────
        this._beaconGroup = new THREE.Group();
        this._beaconGroup.name = 'explore-beacons';
        this._beamGeo = new THREE.BufferGeometry();
        this._beams = new THREE.LineSegments(this._beamGeo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.8,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._beams.frustumCulled = false;
        this._markGeo = new THREE.BufferGeometry();
        this._marks = new THREE.Points(this._markGeo, capPointSize(new THREE.PointsMaterial({
            size: 18, sizeAttenuation: false, vertexColors: true, map: _ringTexture(),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }), { maxPx: 18, fadeNear: false }));
        this._marks.frustumCulled = false;
        this._beaconGroup.add(this._beams, this._marks);
        scene.add(this._beaconGroup);

        // ── Auroral curtains ─────────────────────────────────────────
        this._auroraOn = true;
        this._auroraKey = '';
        this._auroraMat = new THREE.ShaderMaterial({
            vertexShader: AURORA_VERT, fragmentShader: AURORA_FRAG,
            uniforms: { uTime: { value: 0 }, uFade: { value: 0 } },
            extensions: { derivatives: true },
            side: THREE.DoubleSide, transparent: true,
            depthWrite: false, blending: THREE.AdditiveBlending,
        });
        this._auroraGroup = new THREE.Group();
        this._auroraGroup.name = 'explore-aurora';
        this._auroraGroup.visible = false;
        this._auroraMeshes = [1, -1].map((hemi) => {
            // n + 1 columns: the seam vertex is DUPLICATED so the along-curtain
            // coordinate runs 0 → 24 h continuously. Closed by index, the last
            // quad swept 23.9 → 0 h and squeezed a whole day of the ray
            // pattern into one quad — dark stripes dead ahead at magnetic
            // midnight, which is exactly where the aurora stop looks (measured).
            const n = AURORA_CURTAIN.samples;
            const cols = n + 1;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cols * 2 * 3), 3));
            geo.setAttribute('aV', new THREE.BufferAttribute(new Float32Array(cols * 2), 1));
            geo.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(cols * 2), 1));
            geo.setAttribute('aI', new THREE.BufferAttribute(new Float32Array(cols * 2), 1));
            const idx = [];
            for (let i = 0; i < n; i++) {
                const j = i + 1;
                idx.push(2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1);
            }
            geo.setIndex(idx);
            const mesh = new THREE.Mesh(geo, this._auroraMat);
            mesh.frustumCulled = false;
            mesh.renderOrder = 3;
            mesh.userData = { kind: 'explore-aurora', hemisphere: hemi > 0 ? 'north' : 'south' };
            this._auroraGroup.add(mesh);
            return { mesh, hemi };
        });
        scene.add(this._auroraGroup);
    }

    setAuroraVisible(on) { this._auroraOn = !!on; if (!on) this._auroraGroup.visible = false; }
    getAuroraVisible() { return this._auroraOn; }
    getAuroraInfo() {
        return {
            drawn: this._auroraGroup.visible,
            fade: this._auroraMat.uniforms.uFade.value,
            samples: AURORA_CURTAIN.samples,
            kp: this._auroraKp ?? null,
        };
    }

    /** Re-place the curtains when Kp or the sun has moved (called with the POI refresh). */
    _rebuildAurora(inputs) {
        const kp = apToKp(inputs.ap ?? 15);
        const key = `${kp.toFixed(2)}|${(inputs.subSolarLatDeg ?? 0).toFixed(1)}|${(inputs.subSolarLonDeg ?? 0).toFixed(1)}`;
        if (key === this._auroraKey) return;
        this._auroraKey = key;
        this._auroraKp = kp;
        const rb = 1 + AURORA_CURTAIN.bottomKm / R_EARTH_KM;
        const rt = 1 + AURORA_CURTAIN.topKm / R_EARTH_KM;
        for (const { mesh, hemi } of this._auroraMeshes) {
            const ring = auroraCurtain({
                kp, hemisphere: hemi,
                subSolarLatDeg: inputs.subSolarLatDeg ?? 0, subSolarLonDeg: inputs.subSolarLonDeg ?? 0,
            });
            const g = mesh.geometry;
            const P = g.attributes.position.array, V = g.attributes.aV.array;
            const S = g.attributes.aS.array, I = g.attributes.aI.array;
            const n = ring.length;
            for (let i = 0; i <= n; i++) {
                const p = ring[i % n];
                const [x, y, z] = p.u;
                P.set([x * rb, y * rb, z * rb, x * rt, y * rt, z * rt], i * 6);
                V[2 * i] = 0; V[2 * i + 1] = 1;
                S[2 * i] = S[2 * i + 1] = (i / n) * 24;
                I[2 * i] = I[2 * i + 1] = p.intensity;
            }
            for (const k of ['position', 'aV', 'aS', 'aI']) g.attributes[k].needsUpdate = true;
        }
    }

    // ── Public surface ───────────────────────────────────────────────────
    setMembranesVisible(on) { this._membranesOn = !!on; if (!on) this._memMesh.visible = false; }
    getMembranesVisible() { return this._membranesOn; }
    getMembraneWeights() {
        return BOUNDARIES.map((b, i) => ({ id: b.id, km: b.km, weight: this._weights[i] }));
    }
    isMembranePassDrawn() { return this._memMesh.visible; }
    setBeaconsVisible(on) { this._beaconsOn = !!on; this._beaconGroup.visible = this._beaconsOn; }
    getBeaconsVisible() { return this._beaconsOn; }

    /** Live POIs with their discovered flags and scene positions. */
    getPois() {
        return this._pois.map(p => ({ ...p, discovered: this._found.has(p.id) }));
    }
    getPoi(id) { return this.getPois().find(p => p.id === id) || null; }
    getDiscoveries() {
        const ids = [...this._pois.map(p => p.id), ...MILESTONES.map(m => m.id)];
        const uniq = [...new Set(ids)];
        return { found: uniq.filter(id => this._found.has(id)), total: uniq.length };
    }
    resetDiscoveries() { this._found.clear(); _saveFound(this._found); this._rebuildBeacons(); }
    markDiscovered(id, meta = {}) {
        if (!id || this._found.has(id)) return false;
        this._found.add(id);
        _saveFound(this._found);
        this._rebuildBeacons();
        this._emit({ kind: 'discover', id, ...meta, ...this.getDiscoveries() });
        return true;
    }

    /** Re-place the POIs from the live state (the sun moves, Ap changes). */
    refreshPois(force = false) {
        const now = frameClock.now();
        if (!force && now - this._poiAt < 2000) return;
        this._poiAt = now;
        let inputs = {};
        try { inputs = this._getPoiInputs?.() || {}; } catch (_) { inputs = {}; }
        this._pois = pointsOfInterest(inputs);
        this._rebuildBeacons();
        this._rebuildAurora(inputs);
    }

    _rebuildBeacons() {
        const n = this._pois.length;
        const key = this._pois.map(p => `${p.id}:${p.latDeg.toFixed(2)}:${p.lonDeg.toFixed(2)}:${Math.round(p.altKm)}:${this._found.has(p.id) ? 1 : 0}`).join('|');
        const col = new THREE.Color();
        if (key === this._beaconKey) {
            // Nothing moved: the scene positions are still right.
            this._pois.forEach((p) => {
                const u = latLonToScene(p.latDeg, p.lonDeg), r = 1 + p.altKm / R_EARTH_KM;
                p.scenePos = [u[0] * r, u[1] * r, u[2] * r];
            });
            return;
        }
        this._beaconKey = key;
        // Reuse the GPU buffers when the count is unchanged: three keeps a
        // replaced attribute's buffer alive, so a new attribute every 2 s
        // leaks a little GPU memory for the life of the page.
        const same = this._markGeo.attributes.position?.count === n;
        const bp = same ? this._beamGeo.attributes.position.array : new Float32Array(n * 6);
        const bc = same ? this._beamGeo.attributes.color.array : new Float32Array(n * 6);
        const mp = same ? this._markGeo.attributes.position.array : new Float32Array(n * 3);
        const mc = same ? this._markGeo.attributes.color.array : new Float32Array(n * 3);
        this._pois.forEach((p, i) => {
            const u = latLonToScene(p.latDeg, p.lonDeg);
            const r = 1 + p.altKm / R_EARTH_KM;
            const dim = this._found.has(p.id) ? 0.45 : 1;
            col.set(p.colorHex);
            // Beam: faint at the ground, bright at the POI's altitude.
            bp.set([u[0], u[1], u[2], u[0] * r, u[1] * r, u[2] * r], i * 6);
            bc.set([col.r * 0.12 * dim, col.g * 0.12 * dim, col.b * 0.12 * dim,
                    col.r * 0.9 * dim, col.g * 0.9 * dim, col.b * 0.9 * dim], i * 6);
            mp.set([u[0] * r, u[1] * r, u[2] * r], i * 3);
            mc.set([col.r * dim, col.g * dim, col.b * dim], i * 3);
            p.scenePos = [u[0] * r, u[1] * r, u[2] * r];
        });
        if (same) {
            for (const g of [this._beamGeo, this._markGeo]) {
                g.attributes.position.needsUpdate = true;
                g.attributes.color.needsUpdate = true;
            }
        } else {
            // A new count (the ISS appears once its probe does): fresh buffers,
            // and the old ones released.
            this._beamGeo.dispose();
            this._markGeo.dispose();
            this._beamGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
            this._beamGeo.setAttribute('color', new THREE.BufferAttribute(bc, 3));
            this._markGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3));
            this._markGeo.setAttribute('color', new THREE.BufferAttribute(mc, 3));
        }
        this._beamGeo.computeBoundingSphere();
        this._markGeo.computeBoundingSphere();
    }

    /**
     * Per frame, after the camera has moved.
     * @param {THREE.PerspectiveCamera} camera
     * @param {object} o
     * @param {number} o.viewportHeight   CSS pixels
     * @param {boolean} o.travelling      the camera is under explore/fly/transit/dive control
     */
    update(camera, { viewportHeight = 500, travelling = false } = {}) {
        this.refreshPois(false);
        const r = camera.position.length();
        const alt = (r - 1) * R_EARTH_KM;

        // Membranes.
        let wMax = 0;
        const U = this._memMat.uniforms;
        for (let i = 0; i < NB; i++) {
            const b = BOUNDARIES[i];
            const w = this._membranesOn ? membraneWeight(alt, b.km) : 0;
            this._weights[i] = w;
            // A surface ABOVE the camera is seen edge-on across the whole
            // sky; draw it at about half the weight of a floor.
            U.uW.value[i] = b.km > alt ? 0.55 * w : w;
            // Grid lines reach about as far as the camera is from the surface
            // they sit on, plus a floor so a boundary you are ON still shows.
            U.uFade.value[i] = (300 + 6 * Math.abs(alt - b.km)) / R_EARTH_KM;
            U.uLevel.value[i] = gridLevel(alt, b.km);
            U.uNear.value[i] = (Math.abs(alt - b.km) + 3) / R_EARTH_KM;
            if (w > wMax) wMax = w;
        }
        const drawn = this._membranesOn && wMax > 0.002;
        this._memMesh.visible = drawn;
        if (drawn) {
            U.uCam.value.copy(camera.position);
            U.uPixAng.value = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) / Math.max(1, viewportHeight);
            // Screen axes from the quaternion (set by lookAt this frame);
            // matrixWorld is only refreshed by the render that follows.
            U.uRight.value.set(1, 0, 0).applyQuaternion(camera.quaternion);
            U.uUpV.value.set(0, 1, 0).applyQuaternion(camera.quaternion);
        }

        // Aurora: fade in as the camera comes down toward the band.
        const af = this._auroraOn ? Math.max(0, Math.min(1, (4000 - alt) / 2500)) : 0;
        this._auroraMat.uniforms.uFade.value = af;
        this._auroraMat.uniforms.uTime.value = frameClock.now() / 1000;
        this._auroraGroup.visible = af > 0.01;

        // Crossings + milestones, only while the camera is being travelled
        // (a Reset flying out to the orbit view is not a discovery).
        const prev = this._prevAlt;
        this._prevAlt = alt;
        if (travelling && Number.isFinite(prev) && prev !== alt) {
            const hits = boundaryCrossings(prev, alt);
            // A slow renderer can cross several in one frame during a dive;
            // announce the one that names where the camera now is.
            if (hits.length) this._emit({ kind: 'cross', ...hits[hits.length - 1], count: hits.length, altKm: alt });
            for (const m of milestonesReached(prev, alt)) {
                this.markDiscovered(m.id, { name: m.name, milestone: true });
            }
        }

        // Discoveries, a few times a second.
        const now = frameClock.now();
        if (travelling && now - this._lastDiscoveryCheck > 250 && alt <= EXPLORE.ceilKm + 1) {
            this._lastDiscoveryCheck = now;
            const ll = sceneToLatLon([camera.position.x, camera.position.y, camera.position.z]);
            const cam = { latDeg: ll.latDeg, lonDeg: ll.lonDeg, altKm: alt };
            for (const p of this._pois) {
                if (!this._found.has(p.id) && isAtPoi(cam, p)) {
                    this.markDiscovered(p.id, { name: p.name, poi: true });
                }
            }
        }
    }

    _emit(ev) {
        try { this._onEvent?.(ev); } catch (_) { /* isolate */ }
        try { window.dispatchEvent(new CustomEvent('ua-explore', { detail: ev })); } catch (_) { /* SSR */ }
    }

    dispose() {
        this._scene.remove(this._memMesh);
        this._scene.remove(this._beaconGroup);
        this._scene.remove(this._auroraGroup);
        for (const { mesh } of this._auroraMeshes) mesh.geometry.dispose();
        this._auroraMat.dispose();
        this._memMesh.geometry.dispose();
        this._memMat.dispose();
        this._beamGeo.dispose();
        this._markGeo.dispose();
        this._beams.material.dispose();
        this._marks.material.map?.dispose();
        this._marks.material.dispose();
    }
}
