/**
 * stage.js — the earth-interior.html 3D cutaway. Renderer only: every colour
 * on a cut face is a texel of page-model.js `radialTable` (sampled from the
 * PREM / Grayver kernels), every marker position is the observatory feed's
 * own coordinate. Nothing here computes physics.
 *
 * GEOMETRY. Radii are TRUE: Earth 1.0, CMB 0.546, inner core 0.192. The
 * northern octant over lon [CUT_LON0, CUT_LON0 + 90°] is removed: the surface
 * shader DISCARDS it and three quarter-disks (two meridional, one equatorial)
 * close the solid. That sector (North Atlantic / Europe) holds none of the
 * USGS observatories, so no live marker ever falls into the hole.
 *
 * FRAME. The canonical js/geo/coords.js frame (+X Greenwich, +Y north,
 * −Z = 90°E). The surface samples the map through GEO_GLSL `normalToUVMip`
 * from the fragment's own direction — never a mesh UV (three's sphere UVs
 * name the antipode in this frame: the EarthView scar).
 *
 * WEDGE (live earthquakes, 2026-11-18). A half-cut left one flat disc filling
 * the view, which reads as 2-D however it is lit. The live view removes a 90°
 * WEDGE instead — the quarter {x·n̂ > 0, x·ê₂ > 0} — and two lit half-disc
 * walls close the solid (`setSlice`): wall A is the great-circle plane through
 * the epicentre, the viewer and the centre (every ray to the viewer lies in it,
 * on its ê₂ side), wall B the perpendicular plane through the EPICENTRE AXIS.
 * The crease where they meet IS that axis. PREM is spherically symmetric, so
 * a wavefront meets any plane containing the axis in the same curve: the
 * fronts on wall B are the fronts on wall A, and the 3-D front surfaces fill
 * the notch between them. The planet never spins: the frame is Earth-fixed and only the
 * user moves the camera.
 *
 * CAMERA. The TIGA rule: the page may START a flight (presets), never HOLD
 * the camera — a preset is a one-shot tween any drag/wheel cancels. camera.up
 * stays +Y, so OrbitControls is built once and never rebuilt.
 *
 * COLOUR. Raw ShaderMaterials write sRGB bytes straight through (no tone
 * mapping, textures read as NoColorSpace), so a face pixel IS the legend's
 * colour and the map is the file's colour. The post chain (stage-fx.js) is
 * the identity below 0.85 and only rolls off the glows; sprites get
 * NoColorSpace colours so they pass through the half-float target raw too.
 *
 * LIGHT (2026-11-18). The globe is lit by the REAL Sun at the instant shown
 * (`setSunDate` → js/sun-altitude.js subSolarPoint — the site's existing
 * sub-solar function, not a new one): day map by day, a dimmed map plus NASA
 * city lights by night, a twilight band at the terminator. The atmosphere rim
 * and the ghost outline of the removed half are DRAWN (not to scale) so the
 * cut reads as a cut through a whole planet; the page footnote says so.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GEO_GLSL } from '../geo/coords.glsl.js';
import { R_EARTH_KM } from './prem.js';
import { BOUNDARY_RADII_KM } from './page-model.js';
import { subSolarPoint } from '../sun-altitude.js';
import { createStagePost, detectStageQuality } from './stage-fx.js';

export const CUT_LON0_DEG = -40;
export const CUT_SPAN_DEG = 90;

/** latLon (deg) → canonical unit vector. Mirrors GEO_GLSL latLonToNormal. */
export function latLonToVec(latDeg, lonDeg) {
    const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, c = Math.cos(la);
    return new THREE.Vector3(c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo));
}
/** Is (lat, lon) inside the removed octant? Mirrors the shader's test. */
export function inCut(latDeg, lonDeg) {
    if (latDeg < 0) return false;
    const d = ((lonDeg - CUT_LON0_DEG) % 360 + 360) % 360;
    return d <= CUT_SPAN_DEG;
}

const SURFACE_VS = /* glsl */`
varying vec3 vDir;
void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SURFACE_FS = /* glsl */`
#define GEO_SEAMLESS
${GEO_GLSL}
uniform sampler2D uMap;
uniform float uHasMap;
uniform sampler2D uLights;
uniform float uHasLights;
uniform vec3 uLight;          // the Sun, canonical frame
uniform float uCutLon0;
uniform float uCutSpan;
uniform float uCutMode;     // 0: the octant; 1: the live WEDGE (x·uCutN > 0 AND x·uCutM > 0 removed); 2: no cut
uniform sampler2D uOverlay;  // a layer's DATA map (equirect, row 0 = north), alpha = its weight
uniform float uHasOverlay;
uniform float uAlpha;        // < 1: the crust drawn as glass so a layer underneath (slabs) shows through
uniform vec3 uCutN;
uniform vec3 uCutM;
varying vec3 vDir;
void main() {
    vec3 n = normalize(vDir);
    vec2 ll = normalToLatLon(n);
    if (uCutMode > 1.5) {
        // whole globe
    } else if (uCutMode > 0.5) {
        if (dot(n, uCutN) > 0.0 && dot(n, uCutM) > 0.0) discard;
    } else {
        float d = mod(ll.y - uCutLon0 + 4.0 * GEO_TAU, GEO_TAU);
        if (ll.x >= 0.0 && d <= uCutSpan) discard;
    }
    vec2 uv = normalToUVMip(n);
    vec3 base = uHasMap > 0.5 ? texture2D(uMap, uv).rgb : vec3(0.09, 0.16, 0.26);
    float mu = dot(n, uLight);
    float day = smoothstep(-0.10, 0.20, mu);
    vec3 dayC = base * (0.55 + 0.55 * max(mu, 0.0));
    vec3 nightC = base * 0.24 + vec3(0.012, 0.020, 0.036);      // night: the map dimmed (still readable), plus city lights
    if (uHasLights > 0.5) nightC += texture2D(uLights, uv).rgb * vec3(1.0, 0.78, 0.48) * 0.85;
    vec3 c = mix(nightC, dayC, day);
    c += vec3(0.30, 0.12, 0.04) * exp(-mu * mu * 90.0) * 0.35;      // twilight band at the terminator
    if (uHasOverlay > 0.5) {
        // A data layer is read, not lit: its colour IS its legend's, with only a gentle day/night
        // cue (±12 %) so the terminator still tells you where the Sun is.
        vec4 o = texture2D(uOverlay, normalToUV(n));
        c = mix(c, o.rgb * (0.88 + 0.12 * day), o.a);
    }
    gl_FragColor = vec4(c, uAlpha);
}`;

const FACE_VS = /* glsl */`
varying vec3 vPos;
void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FACE_FS = /* glsl */`
uniform sampler2D uRadial;
uniform float uBounds[${BOUNDARY_RADII_KM.length}];
uniform float uProbeR;
uniform float uShade;
uniform float uLine;
uniform float uHole;        // > 0: the faces stop at this radius (a layer draws its own ball inside)
varying vec3 vPos;
void main() {
    float r = length(vPos);
    if (r < uHole) discard;
    vec3 c = texture2D(uRadial, vec2(clamp(r, 0.0, 1.0), 0.5)).rgb * uShade;
    float w = fwidth(r);
    float line = 0.0;
    for (int i = 0; i < ${BOUNDARY_RADII_KM.length}; i++) {
        line = max(line, 1.0 - smoothstep(0.5 * w, 1.6 * w, abs(r - uBounds[i])));
    }
    c = mix(c, vec3(0.94, 0.94, 0.92), uLine * line);
    if (uProbeR >= 0.0) {
        float pr = 1.0 - smoothstep(0.6 * w, 2.0 * w, abs(r - uProbeR));
        c = mix(c, vec3(0.851, 0.349, 0.149), pr);
    }
    gl_FragColor = vec4(c, 1.0);
}`;

// The great-circle SLICE (live earthquakes). The layer colour is still the
// radial table's texel (page-model.js seismicSliceTable — the legend); on top
// of it, DISPLAY shading only, so the cut reads as a solid face and not a
// flat plate: each layer is lit a little more at its top than its base (a
// bevel, ±9 %) and a thin rim light sits on the crust. The table itself is
// PREM DENSITY (page-model.js seismicSliceTable), so the layers' material
// difference is the colour — nothing here tints a layer by hand.
const SLICE_FS = /* glsl */`
uniform sampler2D uRadial;
uniform float uBounds[${BOUNDARY_RADII_KM.length}];
uniform float uLine;
uniform float uCmb;
uniform float uIcb;
uniform float u670;
uniform float uProbeR;
uniform vec3 uWallN;        // this wall's normal, pointing OUT of the solid (into the removed wedge)
uniform vec3 uKey;          // a camera-relative key light
uniform vec3 uAxis;         // the crease: the epicentre axis
varying vec3 vPos;
void main() {
    float r = length(vPos);
    vec3 c = texture2D(uRadial, vec2(clamp(r, 0.0, 1.0), 0.5)).rgb;
    // Two walls at 90° take different light from the same key — that difference is most of
    // what makes the notch read as a solid. The crease (the axis) sits in shadow.
    float lit = 0.30 + 1.0 * max(dot(uWallN, uKey), 0.0);
    float crease = smoothstep(0.0, 0.16, length(vPos - dot(vPos, uAxis) * uAxis));
    c *= lit * mix(0.55, 1.0, crease);
    float lo = r < uIcb ? 0.0 : r < uCmb ? uIcb : r < u670 ? uCmb : u670;
    float hi = r < uIcb ? uIcb : r < uCmb ? uCmb : r < u670 ? u670 : 1.0;
    float t = clamp((r - lo) / max(hi - lo, 1e-4), 0.0, 1.0);
    c *= 0.91 + 0.18 * t;
    float w = fwidth(r);
    float line = 0.0;
    for (int i = 0; i < ${BOUNDARY_RADII_KM.length}; i++) {
        if (uBounds[i] < 0.0) continue;
        line = max(line, 1.0 - smoothstep(0.5 * w, 1.8 * w, abs(r - uBounds[i])));
    }
    c = mix(c, vec3(0.80, 0.86, 0.95), uLine * line);
    c += vec3(0.16, 0.22, 0.32) * (1.0 - smoothstep(0.0, 6.0 * w, 1.0 - r));     // rim light on the crust
    if (uProbeR >= 0.0) {
        float pr = 1.0 - smoothstep(0.6 * w, 2.0 * w, abs(r - uProbeR));
        c = mix(c, vec3(0.851, 0.349, 0.149), pr);
    }
    gl_FragColor = vec4(c, 1.0);
}`;

// The atmosphere: brightness from the view ray's IMPACT PARAMETER b about
// the centre, computed analytically per fragment (never pow(rim, n) on a back
// face — identically 1 there, the orrery's S3 scar). The geometry is only a
// camera-facing ANNULUS through the centre that covers b ∈ [0.95, 1.08]
// (`_fitAtmo`), because the shader needs nothing but the view ray: a full
// shell shaded the whole disc for a glow that lives at the limb (measured
// ~8 ms a frame on SwiftShader). b slightly above 1 is the limb glow, b just below 1 a
// thin haze over the disc's edge; lit by the same Sun, faded on the half the
// slice removes. Drawn, not to scale (a ~190 km glow).
const ATMO_VS = /* glsl */`
varying vec3 vW;
// WORLD position: the annulus is rotated to face the camera (local position is not world — measured as a streak).
void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`;
const ATMO_FS = /* glsl */`
uniform vec3 uCam;
uniform vec3 uLight;
uniform float uCutMode;
uniform vec3 uCutN;
uniform vec3 uCutM;
varying vec3 vW;
void main() {
    vec3 d = vW - uCam;
    float dl = length(d);
    if (dl < 1e-6) discard;
    d /= dl;
    vec3 foot = uCam - dot(uCam, d) * d;       // closest approach of the view ray to the centre
    float b = length(foot);
    vec3 q = b > 1e-5 ? foot / b : vec3(0.0, 1.0, 0.0);
    float glow = b >= 1.0 ? exp(-(b - 1.0) / 0.010) : exp(-(1.0 - b) / 0.006) * 0.45;
    float sun = 0.18 + 0.82 * smoothstep(-0.25, 0.35, dot(q, uLight));
    float keep = uCutMode > 0.5 ? 1.0 - smoothstep(-0.05, 0.10, min(dot(q, uCutN), dot(q, uCutM))) : 1.0;
    vec3 col = vec3(0.32, 0.56, 1.0) * glow * sun * keep * 0.5;
    gl_FragColor = vec4(col, 1.0);
}`;

// The removed half, as glass: a Fresnel rim on its FRONT faces (the normal
// varies there, unlike a back face) plus a faint 30° graticule, so the slice
// reads as a cut through a whole planet. It carries no data.
const GHOST_VS = /* glsl */`
varying vec3 vDir;
varying vec3 vView;
void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
}`;
const GHOST_FS = /* glsl */`
#define GEO_SEAMLESS
${GEO_GLSL}
uniform vec3 uCutN;
uniform vec3 uCutM;
uniform vec3 uTint;
uniform float uRim;
uniform float uGrid;
varying vec3 vDir;
varying vec3 vView;
void main() {
    vec3 n = normalize(vDir);
    if (dot(n, uCutN) <= 0.0 || dot(n, uCutM) <= 0.0) discard;     // glass only where the wedge was
    vec3 nv = normalize((viewMatrix * vec4(n, 0.0)).xyz);
    float f = 1.0 - clamp(abs(dot(nv, normalize(vView))), 0.0, 1.0);
    float rim = f * f * f;
    vec2 ll = normalToLatLon(n) * 57.29578;
    vec2 g = abs(fract(ll / 30.0 + 0.5) - 0.5) * 30.0;
    vec2 px = fwidth(ll);
    float grid = 1.0 - smoothstep(0.0, 1.2, min(g.x / max(px.x, 1e-4), g.y / max(px.y, 1e-4)));
    vec3 col = uTint * (uRim * rim + uGrid * grid * (0.4 + rim) + 0.005);
    gl_FragColor = vec4(col, 1.0);
}`;

const STAR_VS = /* glsl */`
attribute float aMag;
uniform float uDpr;
varying float vB;
void main() {
    vB = aMag;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (0.9 + 1.6 * aMag) * uDpr;
}`;
const STAR_FS = /* glsl */`
varying float vB;
void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float k = max(0.0, 1.0 - dot(q, q));
    gl_FragColor = vec4(vec3(0.62, 0.68, 0.80) * (0.18 + 0.5 * vB) * k, 1.0);
}`;

/** A seeded star field on a far sphere (decoration; no catalogue). */
function starField(count = 1800, radius = 30) {
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pos = new Float32Array(3 * count), mag = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
        pos.set([radius * r * Math.cos(a), radius * z, radius * r * Math.sin(a)], 3 * i);
        mag[i] = Math.pow(rnd(), 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    return g;
}

/** A quarter-disk spanned by unit vectors u (θ = 0) and v (θ = 90°). */
function quarterDisk(u, v, seg = 128) {
    const pos = [0, 0, 0], idx = [];
    for (let i = 0; i <= seg; i++) {
        const t = (i / seg) * Math.PI / 2;
        const p = u.clone().multiplyScalar(Math.cos(t)).add(v.clone().multiplyScalar(Math.sin(t)));
        pos.push(p.x, p.y, p.z);
        if (i > 0) idx.push(0, i, i + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
}

function markerTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.beginPath(); x.arc(32, 32, 26, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill();
    x.lineWidth = 6; x.strokeStyle = '#0b1322'; x.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
    return t;
}

export class InteriorStage {
    constructor(canvas, { onHover = () => {}, onPick = () => {}, labelLayer = null } = {}) {
        this.canvas = canvas;
        this.onHover = onHover; this.onPick = onPick; this.labelLayer = labelLayer;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setClearColor(0x03060c, 1);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
        this.camera.up.set(0, 1, 0);

        // The Sun: today's sub-solar point until a layer sets the instant it shows.
        const light = new THREE.Vector3(1, 0, 0);

        this.surfaceMat = new THREE.ShaderMaterial({
            vertexShader: SURFACE_VS, fragmentShader: SURFACE_FS,
            uniforms: {
                uMap: { value: null }, uHasMap: { value: 0 }, uLights: { value: null }, uHasLights: { value: 0 }, uLight: { value: light },
                uCutLon0: { value: CUT_LON0_DEG * Math.PI / 180 }, uCutSpan: { value: CUT_SPAN_DEG * Math.PI / 180 },
                uCutMode: { value: 0 }, uCutN: { value: new THREE.Vector3(0, 0, 1) }, uCutM: { value: new THREE.Vector3(1, 0, 0) },
                uOverlay: { value: null }, uHasOverlay: { value: 0 }, uAlpha: { value: 1 },
            },
        });
        this._cutNone = false;
        this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 128), this.surfaceMat);
        this.scene.add(this.earth);

        this.stars = new THREE.Points(starField(), new THREE.ShaderMaterial({
            vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: { uDpr: { value: 1 } },
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.stars.renderOrder = -1;
        this.scene.add(this.stars);

        this.atmoMat = new THREE.ShaderMaterial({
            vertexShader: ATMO_VS, fragmentShader: ATMO_FS,
            uniforms: { uCam: { value: new THREE.Vector3() }, uLight: { value: light }, uCutMode: this.surfaceMat.uniforms.uCutMode, uCutN: this.surfaceMat.uniforms.uCutN, uCutM: this.surfaceMat.uniforms.uCutM },
            transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        });
        this.atmoMat.depthTest = false;
        this.atmo = new THREE.Mesh(new THREE.BufferGeometry(), this.atmoMat);
        this.atmo.renderOrder = 3; this.atmo.frustumCulled = false; this._atmoD = -1;
        this.scene.add(this.atmo);

        // Glass in the removed half: the planet's outline, and the CORE and INNER CORE as nested
        // domes standing on the cut (the same spheres are there — PREM is spherically
        // symmetric), tinted by the slice's density ramp at their own radius so a dome and
        // the face it rises from are one colour. depthTest off: they are glass, drawn over the face.
        const glass = (radius, tint, rim, grid) => {
            const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 96), new THREE.ShaderMaterial({
                vertexShader: GHOST_VS, fragmentShader: GHOST_FS,
                uniforms: { uCutN: this.surfaceMat.uniforms.uCutN, uCutM: this.surfaceMat.uniforms.uCutM, uTint: { value: new THREE.Vector3(...tint) }, uRim: { value: rim }, uGrid: { value: grid } },
                transparent: true, depthWrite: false,
                blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
                extensions: { derivatives: true },
            }));
            m.renderOrder = 4; m.visible = false; this.scene.add(m);
            return m;
        };
        this.ghost = glass(1.0005, [0.30, 0.50, 0.85], 0.16, 0.04);
        this.domes = [];
        this.setDomeTints = (list) => {          // [{ rKm, rgb: [0..255]×3 }] — the page supplies the ramp colours
            for (const d of this.domes) { this.scene.remove(d); d.geometry.dispose(); d.material.dispose(); }
            this.domes = list.map(({ rKm, rgb }) => glass(rKm / R_EARTH_KM, rgb.map((v) => Math.min(1, v / 255 * 1.7)), 0.13, 0.0));
            for (const d of this.domes) d.visible = !!this.slice;
        };
        this._resizeHooks = [];

        this.radialTex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
        const bounds = BOUNDARY_RADII_KM.map((r) => r / R_EARTH_KM);
        const SLICE_KEEP = [R_EARTH_KM - 400, R_EARTH_KM - 670, 3480, 1221.5];
        const sliceBounds = BOUNDARY_RADII_KM.map((r) => (SLICE_KEEP.some((k) => Math.abs(k - r) < 2) ? r / R_EARTH_KM : -1));
        const e0 = latLonToVec(0, CUT_LON0_DEG), e1 = latLonToVec(0, CUT_LON0_DEG + CUT_SPAN_DEG), up = new THREE.Vector3(0, 1, 0);
        this.faces = [
            { g: quarterDisk(e0, up), shade: 0.90 },
            { g: quarterDisk(e1, up), shade: 1.0 },
            { g: quarterDisk(e0, e1), shade: 0.80 },
        ].map(({ g, shade }) => {
            const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
                vertexShader: FACE_VS, fragmentShader: FACE_FS, side: THREE.DoubleSide,
                uniforms: { uRadial: { value: this.radialTex }, uBounds: { value: bounds }, uProbeR: { value: -1 }, uShade: { value: shade }, uLine: { value: 0.55 }, uHole: { value: -1 } },
                extensions: { derivatives: true },
            }));
            this.scene.add(m);
            return m;
        });

        // The great-circle slice (live earthquakes): one full disk in the plane, the
        // same face shader, its OWN radial table (the seismic view draws neutral layers
        // so blue/orange wavefronts read against them).
        this.slice = null;
        this.sliceTex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
        const wallMat = () => new THREE.ShaderMaterial({
            vertexShader: FACE_VS, fragmentShader: SLICE_FS, side: THREE.DoubleSide,
            // Only the boundaries a seismologist reads a ray fan against (400, 670, CMB, ICB), and
            // fainter: all eleven of PREM's crowd the rim into a white band at this scale (measured).
            uniforms: {
                uRadial: { value: this.sliceTex }, uBounds: { value: sliceBounds }, uProbeR: { value: -1 }, uLine: { value: 0.30 },
                uCmb: { value: 3480 / R_EARTH_KM }, uIcb: { value: 1221.5 / R_EARTH_KM }, u670: { value: (R_EARTH_KM - 670) / R_EARTH_KM },
                uWallN: { value: new THREE.Vector3() }, uKey: { value: new THREE.Vector3(0, 1, 0) }, uAxis: { value: new THREE.Vector3(1, 0, 0) },
            },
            extensions: { derivatives: true },
        });
        this.walls = [0, 1].map(() => {
            const m = new THREE.Mesh(new THREE.BufferGeometry(), wallMat());
            m.visible = false; this.scene.add(m);
            return m;
        });
        this._frameHooks = [];

        this.markerTex = markerTexture();
        this.markers = new Map();           // code → { sprite, label, lat, lon }

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false; this.controls.minDistance = 1.35; this.controls.maxDistance = 7;
        this.controls.rotateSpeed = 0.6;
        this.controls.addEventListener('start', () => { this._flight = null; });
        this.setView('cutaway', { instant: true });

        this.raycaster = new THREE.Raycaster();
        this._pointer = null; this._down = null;
        canvas.addEventListener('pointermove', (e) => { this._pointer = this._ndc(e); this._hoverDirty = true; });
        canvas.addEventListener('pointerleave', () => { this._pointer = null; this._hoverDirty = true; });
        canvas.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
        canvas.addEventListener('pointerup', (e) => {
            const d = this._down; this._down = null;
            if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || e.timeStamp - d.t > 700) return;
            const hit = this.pick(this._ndc(e), e);
            if (hit) this.onPick(hit);
        });

        this.quality = detectStageQuality(this.renderer, location.search);
        try { this.post = createStagePost(this.renderer, this.scene, this.camera, { quality: this.quality }); }
        catch (err) { console.warn('[earth-interior] post chain unavailable, drawing direct:', err); this.post = createStagePost(this.renderer, this.scene, this.camera, { quality: 'off' }); }
        this.setSunDate(new Date());

        this._visible = true;
        new IntersectionObserver((es) => { this._visible = es[0].isIntersecting; }).observe(canvas);
        // Observe the CANVAS: its box changes when the page re-docks the clock bar under it.
        new ResizeObserver(() => this.resize()).observe(canvas);
        this.resize();
        this.setView('cutaway', { instant: true });   // again, now the aspect is real
        this._raf = requestAnimationFrame((t) => this._frame(t));
    }

    /** A layer that can claim a pick: fn(raycaster, pointer) → hit | null, consulted before markers and faces. */
    addPicker(fn) { (this._pickers ??= []).push(fn); }

    /** Run fn({ w, h, dpr }) on every resize (glow lines need the drawing-buffer size). */
    onResize(fn) { this._resizeHooks.push(fn); fn(this._size ?? { w: 1, h: 1, dpr: 1 }); return () => { this._resizeHooks = this._resizeHooks.filter((f) => f !== fn); }; }

    /**
     * Pixels of the canvas covered by chrome at the top / bottom (MEASURED by the page). The
     * projection's principal point moves into the clear band (setViewOffset) and every fit uses
     * the clear band's height, so the globe is never framed under a panel.
     */
    setSafeInsets({ top = 0, bottom = 0 } = {}) {
        const t = Math.max(0, Math.round(top)), b = Math.max(0, Math.round(bottom));
        if (this._insets && this._insets.top === t && this._insets.bottom === b) return;
        this._insets = { top: t, bottom: b };
        this._applyView();
    }
    _applyView() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight, ins = this._insets ?? { top: 0, bottom: 0 };
        if (!w || !h) return;
        this.camera.aspect = w / h;
        if (ins.top || ins.bottom) this.camera.setViewOffset(w, h, 0, -(ins.top - ins.bottom) / 2, w, h);
        else this.camera.clearViewOffset();
        this.camera.updateProjectionMatrix();
    }

    /** Light the globe by the real Sun at `date` (sun-altitude.js subSolarPoint). */
    setSunDate(date) {
        const ss = subSolarPoint(date);
        this.surfaceMat.uniforms.uLight.value.copy(latLonToVec(ss.lat, ss.lon).normalize());
        this.sunDate = date;
    }

    /** Run fn(nowMs) every rendered frame (the live layer's clock). Returns an unsubscribe. */
    onFrame(fn) { this._frameHooks.push(fn); return () => { this._frameHooks = this._frameHooks.filter((f) => f !== fn); }; }

    /**
     * Cut along a great-circle plane { e1, e2, n } (unit vectors, canonical frame):
     * the half on the +n side is removed and a disk closes the solid. null restores the octant.
     */
    setSlice(plane, radialTable = null) {
        this.slice = plane;
        const on = !!plane;
        this.surfaceMat.uniforms.uCutMode.value = on ? 1 : this._cutNone ? 2 : 0;
        for (const f of this.faces) f.visible = !on && !this._cutNone;
        for (const w of this.walls) w.visible = on;
        this.ghost.visible = on;
        for (const d of this.domes) d.visible = on;
        if (!on) return;
        const e1 = new THREE.Vector3(...plane.e1), e2 = new THREE.Vector3(...plane.e2), n = new THREE.Vector3(...plane.n);
        this.surfaceMat.uniforms.uCutN.value.copy(n);
        this.surfaceMat.uniforms.uCutM.value.copy(e2);
        // Wall A: the slice plane's ê₂ half (outward normal +n̂). Wall B: the (ê₁, n̂) plane's n̂ half (outward +ê₂).
        const halfDisk = (u, v, seg = 240) => {
            const pos = [0, 0, 0], idx = [];
            for (let i = 0; i <= seg; i++) {
                const t = i / seg * Math.PI, q = u.clone().multiplyScalar(Math.cos(t)).add(v.clone().multiplyScalar(Math.sin(t)));
                pos.push(q.x, q.y, q.z);
                if (i > 0) idx.push(0, i, i + 1);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
            return g;
        };
        [[e2, n], [n, e2]].forEach(([v, out], i) => {
            const w = this.walls[i];
            w.geometry.dispose(); w.geometry = halfDisk(e1, v);
            w.material.uniforms.uWallN.value.copy(out);
            w.material.uniforms.uAxis.value.copy(e1);
        });
        if (radialTable) {
            const rgba = new Uint8Array(4 * radialTable.n);
            for (let i = 0; i < radialTable.n; i++) rgba.set([radialTable.rgb[3 * i], radialTable.rgb[3 * i + 1], radialTable.rgb[3 * i + 2], 255], 4 * i);
            const t = new THREE.DataTexture(rgba, radialTable.n, 1, THREE.RGBAFormat);
            t.magFilter = t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
            this.sliceTex.dispose(); this.sliceTex = t;
            for (const w of this.walls) w.material.uniforms.uRadial.value = t;
        }
    }

    /** Is a unit surface point removed by the current cut? */
    isCut(q) {
        if (this.slice) {
            const d = (v) => q.x * v[0] + q.y * v[1] + q.z * v[2];
            return d(this.slice.n) > 0 && d(this.slice.e2) > 0;     // the wedge (mirrors SURFACE_FS)
        }
        if (this._cutNone) return false;
        const lat = Math.asin(Math.max(-1, Math.min(1, q.y))) * 180 / Math.PI, lon = Math.atan2(-q.z, q.x) * 180 / Math.PI;
        return inCut(lat, lon);
    }

    /** Unsliced: 'octant' (the structure cut) or 'none' (the whole globe — the plates view). */
    setCut(mode) {
        this._cutNone = mode === 'none';
        if (this.slice) return;
        this.surfaceMat.uniforms.uCutMode.value = this._cutNone ? 2 : 0;
        for (const f of this.faces) f.visible = !this._cutNone;
    }

    /**
     * The crust as glass (alpha < 1) so what lies beneath it — the plates view's slabs and
     * hypocentres — can be seen; 1 restores the opaque globe. A transparent surface writes no
     * depth and draws after every opaque object (renderOrder −0.5: before the other glass).
     */
    setSurfaceAlpha(a) {
        const m = this.surfaceMat, glass = a < 1;
        m.uniforms.uAlpha.value = a;
        if (m.transparent !== glass) { m.transparent = glass; m.depthWrite = !glass; m.needsUpdate = true; }
        this.earth.renderOrder = glass ? -0.5 : 0;
    }

    /** Dim the octant's faces (1 = as the legend; a layer that draws inside the cut lowers it). */
    setFaceDim(k) {
        for (const f of this.faces) f.material.uniforms.uShade.value = (f.userData.shade ??= f.material.uniforms.uShade.value) * k;
    }

    /** The octant's faces stop at radius rKm (null: they run to the centre) — a layer's own ball fills the rest. */
    setFaceHole(rKm) {
        const v = Number.isFinite(rKm) ? rKm / R_EARTH_KM : -1;
        for (const f of this.faces) f.material.uniforms.uHole.value = v;
    }

    /**
     * A DATA map on the globe: RGBA bytes, width × height equirect, row 0 = north
     * (the GEO orientation; flipY false), alpha = how much it covers the map. null removes it.
     */
    setSurfaceOverlay(rgba, width, height) {
        const u = this.surfaceMat.uniforms;
        u.uOverlay.value?.dispose?.();
        if (!rgba) { u.uOverlay.value = null; u.uHasOverlay.value = 0; return; }
        const t = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
        t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.wrapS = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
        u.uOverlay.value = t; u.uHasOverlay.value = 1;
    }

    /** One-shot flight to look along a direction at a given fill (the TIGA rule: started, never held). */
    flyToDirection(dir, { fill = 0.9, instant = false } = {}) {
        const to = (Array.isArray(dir) ? new THREE.Vector3(...dir) : dir.clone()).normalize().multiplyScalar(this._fitDistance(fill));
        this.controls.minDistance = 1.35;
        if (instant) { this.camera.position.copy(to); this.controls.target.set(0, 0, 0); this.controls.update(); return; }
        this._flight = { from: this.camera.position.clone(), to, fromT: this.controls.target.clone(), toT: new THREE.Vector3(), t0: performance.now(), dur: 1300 };
    }

    /**
     * One-shot flight to a camera POSITION looking at a TARGET that need not be the centre (a
     * cross-section's notch). `minDistance` loosens the zoom floor for close work; every
     * whole-globe flight restores it. Started, never held — any drag cancels it.
     */
    flyToPose(position, target, { minDistance = 0.12, dur = 1500 } = {}) {
        const to = Array.isArray(position) ? new THREE.Vector3(...position) : position.clone();
        const toT = Array.isArray(target) ? new THREE.Vector3(...target) : target.clone();
        this.controls.minDistance = minDistance;
        this._flight = { from: this.camera.position.clone(), to, fromT: this.controls.target.clone(), toT, t0: performance.now(), dur };
    }

    async loadMap(url) {
        const tex = await new THREE.TextureLoader().loadAsync(url);
        tex.colorSpace = THREE.NoColorSpace;
        // GEO's normalToUV puts v = 0 at the NORTH pole (image row 0). TextureLoader's
        // default flipY would put image row 0 at v = 1 and draw the map upside down
        // under correctly placed markers — measured on the first render.
        tex.flipY = false;
        tex.wrapS = THREE.RepeatWrapping;
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.surfaceMat.uniforms.uMap.value = tex;
        this.surfaceMat.uniforms.uHasMap.value = 1;
    }

    /** NASA Black Marble city lights for the night side (optional; same orientation rules as the map). */
    async loadLights(url) {
        const tex = await new THREE.TextureLoader().loadAsync(url);
        tex.colorSpace = THREE.NoColorSpace;
        tex.flipY = false;
        tex.wrapS = THREE.RepeatWrapping;
        this.surfaceMat.uniforms.uLights.value = tex;
        this.surfaceMat.uniforms.uHasLights.value = 1;
    }

    /** Draw a radialTable on the faces. */
    setRadialTable(table) {
        const rgba = new Uint8Array(4 * table.n);
        for (let i = 0; i < table.n; i++) rgba.set([table.rgb[3 * i], table.rgb[3 * i + 1], table.rgb[3 * i + 2], 255], 4 * i);
        const t = new THREE.DataTexture(rgba, table.n, 1, THREE.RGBAFormat);
        t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
        t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
        this.radialTex.dispose(); this.radialTex = t;
        for (const f of this.faces) f.material.uniforms.uRadial.value = t;
    }

    /** Highlight one radius on the faces (km), or null. */
    setProbeRadius(rKm) {
        const v = Number.isFinite(rKm) ? rKm / R_EARTH_KM : -1;
        for (const f of this.faces) f.material.uniforms.uProbeR.value = v;
    }

    /** Observatory markers: [{ code, lat, lon, emphasis }] — positions from the FEED. */
    setStations(list, selected = null) {
        const keep = new Set(list.map((s) => s.code));
        for (const [code, m] of this.markers) if (!keep.has(code)) { this.scene.remove(m.sprite); m.label?.remove(); this.markers.delete(code); }
        for (const s of list) {
            let m = this.markers.get(s.code);
            if (!m) {
                const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.markerTex, sizeAttenuation: false, depthTest: false, transparent: true }));
                this.scene.add(sprite);
                let label = null;
                if (this.labelLayer) { label = document.createElement('span'); label.className = 'ei-mlabel'; label.textContent = s.code; this.labelLayer.appendChild(label); }
                m = { sprite, label }; this.markers.set(s.code, m);
            }
            Object.assign(m, { lat: s.lat, lon: s.lon, code: s.code });
            m.sprite.position.copy(latLonToVec(s.lat, s.lon).multiplyScalar(1.004));
            const px = 9 + 9 * Math.min(1, s.emphasis ?? 0);
            m.px = px;
            m.sprite.material.color.setHex(s.code === selected ? 0xd95926 : 0xffffff, THREE.NoColorSpace);
            m.label?.classList.toggle('is-sel', s.code === selected);
        }
        this._sizeMarkers();
    }

    _sizeMarkers() {
        const h = this.canvas.clientHeight || 1;
        const k = 2 * Math.tan(this.camera.fov * Math.PI / 360) / h;
        for (const m of this.markers.values()) m.sprite.scale.setScalar(m.px * k);
    }

    /** One-shot flights. 'cutaway' faces the cut; 'observatories' faces the station centroid. */
    setView(name, { instant = false } = {}) {
        let dir, fill = 0.86;               // the disc's share of the binding half-angle
        if (name === 'observatories' && this.markers.size) {
            const c = new THREE.Vector3();
            for (const m of this.markers.values()) c.add(latLonToVec(m.lat, m.lon));
            dir = c.normalize(); fill = 0.96;
        } else dir = latLonToVec(30, CUT_LON0_DEG + CUT_SPAN_DEG / 2 - 8);
        const dist = this._fitDistance(fill);
        const to = dir.multiplyScalar(dist);
        this.controls.minDistance = 1.35;
        if (instant) { this.camera.position.copy(to); this.controls.target.set(0, 0, 0); this.controls.update(); return; }
        this._flight = { from: this.camera.position.clone(), to, fromT: this.controls.target.clone(), toT: new THREE.Vector3(), t0: performance.now(), dur: 1100 };
    }

    /** Camera distance at which the unit sphere fills `fill` of the BINDING half-angle (the smaller of vertical/horizontal). */
    _fitDistance(fill) {
        const ins = this._insets ?? { top: 0, bottom: 0 }, h0 = this.canvas.clientHeight || 1;
        const clear = Math.max(0.3, (h0 - ins.top - ins.bottom) / h0);
        const v0 = this.camera.fov * Math.PI / 360;
        const v = Math.atan(Math.tan(v0) * clear);                       // the clear band's vertical half-angle
        const h = Math.atan(Math.tan(v0) * (this.camera.aspect || 1));   // horizontal: the full width
        return 1 / Math.sin(Math.min(v, h) * fill);
    }

    resize() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (!w || !h) return;
        const dpr = this.renderer.getPixelRatio();
        this.renderer.setSize(w, h, false);
        this.post?.setSize(w, h, dpr);
        this._applyView();
        this.stars.material.uniforms.uDpr.value = dpr;
        this._size = { w: w * dpr, h: h * dpr, dpr };
        for (const fn of this._resizeHooks) fn(this._size);
        this._sizeMarkers();
    }

    _ndc(e) {
        const r = this.canvas.getBoundingClientRect();
        return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1, px: e.clientX - r.left, py: e.clientY - r.top };
    }

    /** What is under a pointer: a marker (pixel test), a cut face (radius) or the surface (lat/lon). */
    pick(p) {
        if (!p) return null;
        this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
        for (const fn of this._pickers ?? []) { const hit = fn(this.raycaster, p); if (hit) return hit; }
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        let best = null, bestD = 14;
        const camDir = this.camera.position.clone().normalize();
        for (const m of this.markers.values()) {
            if (m.sprite.position.clone().normalize().dot(camDir) < 0.05) continue;
            const s = m.sprite.position.clone().project(this.camera);
            const d = Math.hypot((s.x + 1) / 2 * w - p.px, (1 - s.y) / 2 * h - p.py);
            if (d < bestD) { bestD = d; best = { kind: 'station', code: m.code }; }
        }
        if (best) return best;
        this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
        const ray = this.raycaster.ray;
        const faceHit = this.raycaster.intersectObjects(this.slice ? this.walls : this.faces, false)[0] ?? null;
        // Analytic sphere: nearest intersection that is NOT inside the cut.
        let sphere = null;
        const b = ray.origin.dot(ray.direction), c = ray.origin.lengthSq() - 1, disc = b * b - c;
        if (disc >= 0) {
            for (const t of [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]) {
                if (t <= 0) continue;
                const q = ray.at(t, new THREE.Vector3());
                const lat = Math.asin(Math.max(-1, Math.min(1, q.y))) * 180 / Math.PI;
                const lon = Math.atan2(-q.z, q.x) * 180 / Math.PI;
                if (!this.isCut(q)) { sphere = { t, lat, lon }; break; }
            }
        }
        if (faceHit && (!sphere || faceHit.distance < sphere.t)) return { kind: 'interior', rKm: faceHit.point.length() * R_EARTH_KM };
        if (sphere) return { kind: 'surface', lat: sphere.lat, lon: sphere.lon };
        return null;
    }

    _frame(now) {
        this._raf = requestAnimationFrame((t) => this._frame(t));
        if (this._flight) {
            const f = this._flight, u = Math.min(1, (now - f.t0) / f.dur), e = u * u * (3 - 2 * u);
            // The target moves linearly; the camera's OFFSET from it interpolates DIRECTION and
            // log-distance (a straight chord dives through the planet).
            const fromT = f.fromT ?? new THREE.Vector3(), toT = f.toT ?? new THREE.Vector3();
            const tgt = fromT.clone().lerp(toT, e);
            const oa = f.from.clone().sub(fromT), oz = f.to.clone().sub(toT);
            const dir = oa.clone().normalize().lerp(oz.clone().normalize(), e).normalize();
            const dist = Math.exp(Math.log(oa.length()) * (1 - e) + Math.log(oz.length()) * e);
            this.controls.target.copy(tgt);
            this.camera.position.copy(tgt).add(dir.multiplyScalar(dist));
            if (u >= 1) this._flight = null;
        }
        this.controls.update();
        if (!this._visible) return;
        for (const fn of this._frameHooks) fn(Date.now());
        if (this._hoverDirty) { this._hoverDirty = false; this.onHover(this.pick(this._pointer)); }
        this.atmoMat.uniforms.uCam.value.copy(this.camera.position);
        this._fitAtmo();
        if (this.slice) {       // a key light from the camera's upper left, so the two walls take different light
            const dir = this.camera.position.clone().normalize(), up = this.camera.up.clone();
            const right = new THREE.Vector3().crossVectors(up, dir).normalize();
            const key = dir.clone().multiplyScalar(0.6).addScaledVector(up, 0.6).addScaledVector(right, -1.0).normalize();
            for (const w of this.walls) w.material.uniforms.uKey.value.copy(key);
        }
        this.post.render();
        this._placeLabels();
    }

    /** The atmosphere annulus: in the plane through the centre facing the camera, spanning b ∈ [0.95, 1.08]. */
    _fitAtmo() {
        const D = this.camera.position.length();
        this.atmo.lookAt(this.camera.position);
        if (Math.abs(D - this._atmoD) < 1e-3) return;
        this._atmoD = D;
        // A ray at impact parameter b crosses this plane at ρ = D·b / √(D² − b²).
        const rho = (b) => { const bb = Math.min(b, 0.999 * D); return D * bb / Math.sqrt(D * D - bb * bb); };
        this.atmo.geometry.dispose();
        this.atmo.geometry = new THREE.RingGeometry(rho(0.95), rho(1.08), 256, 1);
    }

    _placeLabels() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight, camDir = this.camera.position.clone().normalize();
        for (const m of this.markers.values()) {
            const front = m.sprite.position.clone().normalize().dot(camDir) > 0.12;
            const s = m.sprite.position.clone().project(this.camera);
            m.sprite.visible = front;
            if (!m.label) continue;
            m.label.style.display = front ? '' : 'none';
            if (front) m.label.style.transform = `translate(${((s.x + 1) / 2 * w + 9).toFixed(1)}px, ${((1 - s.y) / 2 * h - 8).toFixed(1)}px)`;
        }
    }
}
