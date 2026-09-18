/**
 * neo-watch/stage.js — the Earth-centred three.js stage for neo-watch.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws the numbers js/neo-space.js computes, and computes NONE of its own.
 * Every position on this stage arrives as a geocentric ecliptic J2000 vector
 * and goes through the kernel's `geoToScene`; every ruler mark is a
 * `SHELLS` entry; the globe's orientation is `gmstRad` and `earthSceneMatrix`.
 * If you find yourself writing trigonometry in this file, it belongs in the
 * kernel where the gate can see it.
 *
 * ── Frame ──────────────────────────────────────────────────────────────────
 * Equatorial J2000, Y-UP: scene +Y is the north celestial pole, +X is the
 * vernal equinox. Two consequences worth stating because both are scars from
 * other pages in this repo:
 *
 *   1. `camera.up` stays (0, 1, 0) forever, so OrbitControls is constructed
 *      ONCE and never rebuilt. The Stage, Mars, the Moon and TIGA all had to
 *      learn that vendored r160 caches its orbit axis from `camera.up` at
 *      construction (OrbitControls.js:177) — this page avoids the whole class
 *      of bug by never moving up.
 *   2. The globe hangs off `earthFrame`, whose matrix is the kernel's
 *      `earthSceneMatrix(jd)`. Sidereal time is measured from the equinox OF
 *      DATE and the stage is J2000, so spinning the globe by GMST inside a
 *      J2000 scene without that correction leaves it 0.37° from the sky drawn
 *      around it — about a pixel, and therefore invisible, and therefore
 *      exactly the kind of thing that stays wrong for a year.
 *
 * ── What is drawn ──────────────────────────────────────────────────────────
 *   globe        1 scene unit = 1 R⊕, spun by GMST, day/night terminator from
 *                the kernel's own Sun direction. The day and night textures
 *                are CDN-loaded and OPTIONAL: `uHasTex` is never 1 with a null
 *                sampler (the sun.html `u_obsOn` rule), and the graticule +
 *                land tint are procedural so the globe still reads with no
 *                network at all — which is also how CI sees it.
 *   shells       the ruler. LEO, GEO, 1/5/10/20 LD, 0.05 and 0.2 AU, each a
 *                ring at its own real radius on the active radial map, with a
 *                label that stops being drawn when the ring is too small to
 *                point at (the orrery's "labels pile up at the top view" scar).
 *   moon         at its real geocentric position, with its real path over one
 *                sidereal month sampled from the same ephemeris.
 *   population   every catalogued object inside the view horizon, as an
 *                additive round dot brightened by proximity — the one depth
 *                cue a logarithmic map flattens away. Round, not square: an
 *                untextured PointsMaterial draws squares and the orrery
 *                already paid for learning that.
 *   rocks        a small pool of real meshes (js/neo-rocks.js) that stand in
 *                for the selected object and the nearest few, lit from the
 *                Sun's actual direction rather than the scene origin.
 *   fireballs    US Government sensor bolides pinned at their real lat/lon on
 *                the rotating globe. The orrery could not do this — its Earth
 *                mesh accumulates rotation instead of tracking UT, so a pin
 *                would land on the wrong meridian (NEO_LAYER_PLAN.md §4). Here
 *                the globe IS tied to GMST, so the pins are honest.
 *   observer     your own position, with the local horizon plane, so the
 *                alt/az the panel prints has something to mean on screen.
 *
 * ── Picking ────────────────────────────────────────────────────────────────
 * Points raycasting sorts hits along the RAY, not across it, so a click would
 * otherwise select whatever is nearest the camera rather than nearest the
 * cursor. `pick()` re-sorts by `distanceToRay`, the same fix the orrery
 * carries.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    SHELLS, AU_KM,
    geoToScene, geoSceneRadius, trueSceneRadius,
    gmstRad, earthSceneMatrix,
    sunGeoDirectionJ2000, moonGeoJ2000,
    equatorialToScene, eclipticToEquatorial,
} from '../neo-space.js';
import { FLAG } from '../neo-orbits.js';
import { rockGeometry, rockMaterial, shapeFor, spinFor, hash32, drawnRockRadius } from '../neo-rocks.js';

const MOON_RADIUS_KM = 1737.4;
/**
 * Where the rocks are lit from. Far enough that the direction is effectively
 * parallel across the whole stage (the residual is ~0.001° at 0.5 AU drawn in
 * true scale), which is what a body 1 AU away actually does.
 */
const SUN_LIGHT_R = 1e7;
/** Pool size for real meshes. Small on purpose — each is 1280 faces. */
const ROCK_POOL = 8;
/** Sprite colours by class family. */
const COLOR = {
    pha:        0xff6a5c,
    neo:        0x9fc6ff,
    comet:      0x8ef0d8,
    interstellar: 0xffd479,
};

// ── The globe's shader ──────────────────────────────────────────────────────
//
// A ShaderMaterial writes gl_FragColor directly, which means three's
// <colorspace_fragment> is not applied for it the way it is for the built-in
// materials this scene also uses. The chunk is therefore appended by hand —
// the solar-system.html rule, for the same reason: a raw shader that forgets
// it is silently on a different colour pipeline from everything beside it.
const GLOBE_VS = /* glsl */`
    varying vec3 vObj;
    void main() {
        vObj = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const GLOBE_FS = /* glsl */`
    uniform vec3      uSunObj;      // Sun direction in OBJECT space
    uniform sampler2D uDay;
    uniform sampler2D uNight;
    uniform float     uHasTex;      // 0 until both textures have actually arrived
    uniform float     uGrid;
    varying vec3      vObj;

    const float PI = 3.141592653589793;

    void main() {
        // Object space uses the repo's canonical Earth frame: +X at lon 0,
        // +Y north, -Z at 90 E (js/geo/coords.js). Deriving lat/lon here rather
        // than trusting three's sphere UVs means the mesh's own rotation.y IS
        // the sidereal angle and nothing depends on the tessellator's seam.
        float lat = asin(clamp(vObj.y, -1.0, 1.0));
        float lon = atan(-vObj.z, vObj.x);
        vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

        float ndl  = dot(vObj, uSunObj);
        float day  = smoothstep(-0.12, 0.12, ndl);      // a soft, ~14 deg terminator

        // Procedural fallback: a plausible ocean/ice tint that never pretends
        // to be geography. It is what CI and a blocked CDN see.
        float ice  = smoothstep(0.62, 0.78, abs(sin(lat)));
        vec3 base  = mix(vec3(0.06, 0.13, 0.26), vec3(0.72, 0.78, 0.86), ice);
        vec3 dayC  = base;
        vec3 nightC = base * 0.06;

        vec3 texDay   = texture2D(uDay,   uv).rgb;
        vec3 texNight = texture2D(uNight, uv).rgb;
        dayC   = mix(dayC,   texDay,   uHasTex);
        nightC = mix(nightC, texNight * 1.35, uHasTex);

        vec3 col = mix(nightC, dayC, day);

        // Graticule every 30 deg, and a brighter equator. Drawn in screen-space
        // derivative width so it stays one line wide at any zoom.
        float latLines = abs(fract(degrees(lat) / 30.0 + 0.5) - 0.5);
        float lonLines = abs(fract(degrees(lon) / 30.0 + 0.5) - 0.5);
        float lw = fwidth(degrees(lat)) / 30.0 * 0.9 + 1e-4;
        float grid = max(1.0 - smoothstep(0.0, lw, latLines), 1.0 - smoothstep(0.0, lw, lonLines));
        float eq   = 1.0 - smoothstep(0.0, lw * 1.6, abs(degrees(lat)) / 30.0);
        col = mix(col, vec3(0.45, 0.72, 0.95), grid * uGrid * 0.30 + eq * uGrid * 0.25);

        // A thin limb glow so the night side still has an edge against black.
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
    }
`;

/** A soft round additive dot — the texture that stops points being squares. */
function dotTexture() {
    const S = 64;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/**
 * A canvas label sprite, pixel-sized (no attenuation) so it stays readable at
 * any zoom — which is exactly why the scale has to be SMALL. With
 * `sizeAttenuation:false` a sprite's scale is a fraction of the viewport, not a
 * world size: 0.055 drew the ruler's labels a third of the screen wide and
 * stacked them on top of each other. 0.018 is about 18 px of cap height at
 * 720 p, which is what the canvas font is drawn at anyway.
 */
function labelSprite(text, color = '#9fc6ff', scale = 1) {
    const pad = 10, font = '600 30px ui-monospace, SFMono-Regular, Menlo, monospace';
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const w = Math.ceil(meas.measureText(text).width) + pad * 2;
    const h = 44;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.font = font;
    g.fillStyle = 'rgba(4,6,16,0.62)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    g.textBaseline = 'middle';
    g.fillText(text, pad, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.material.sizeAttenuation = false;
    spr.scale.set((w / h) * 0.018 * scale, 0.018 * scale, 1);
    spr.renderOrder = 20;
    return spr;
}

/**
 * A unit ring in the scene's equatorial plane (XZ), scaled per shell. The
 * shells are RANGE rings — a set of distances, not a set of orbits — and the
 * page's legend says so.
 */
function ringGeometry(r, segments = 256) {
    const pts = [];
    for (let k = 0; k <= segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        pts.push(new THREE.Vector3(r * Math.cos(a), 0, r * Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
}

export class NeoStage {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     * @param {(index:number|null)=>void} [opts.onPick]
     * @param {string[]} [opts.textures]  [dayUrl, nightUrl]; omitted ⇒ procedural only
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.onPick = opts.onPick || (() => {});
        this.trueScale = false;
        this.horizonKm = 0.2 * AU_KM;
        this.jd = 2451545.0;
        this.selected = null;
        this.count = 0;
        this.geo = null;          // Float32Array(3N), geocentric ecliptic J2000 AU
        this.rGeo = null;
        this.meta = new Map();    // index → element metadata (for the rock pool)
        this._disposed = false;

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        // No tone mapping: this stage has no HDR content, and NoToneMapping is
        // what lets built-in materials and the one hand-written shader agree
        // with each other without a tone-decode dance (see the header).
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setClearColor(0x03040c, 1);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 4000);
        this.camera.position.set(14, 9, 18);
        // Never reassigned. See the header: this is what makes the single
        // OrbitControls construction below safe forever.
        this.camera.up.set(0, 1, 0);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.07;
        this.controls.minDistance = 1.35;
        this.controls.maxDistance = 900;
        this.controls.enablePan = false;

        this._buildStarfield();
        this._buildEarth(opts.textures);
        this._buildShells();
        this._buildMoon();
        this._buildPopulation();
        this._buildRockPool();
        this._buildOverlays();

        this._ray = new THREE.Raycaster();
        this._ray.params.Points.threshold = 0.22;
        this._pointer = new THREE.Vector2();
        this._onClick = (ev) => this._handleClick(ev);
        canvas.addEventListener('click', this._onClick);

        this._applyRange();
        this.resize();
    }

    // ── Construction ────────────────────────────────────────────────────────

    _buildStarfield() {
        // A cheap fixed backdrop so rotation reads as rotation. Deliberately
        // NOT a star catalogue: this page's sky positions are the objects', and
        // a wrong star field would imply a pointing accuracy we are not
        // claiming here.
        const N = 1400, pos = new Float32Array(N * 3);
        let seed = 0x9e3779b9;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
        for (let i = 0; i < N; i++) {
            const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
            pos[i * 3] = 1800 * s * Math.cos(th);
            pos[i * 3 + 1] = 1800 * u;
            pos[i * 3 + 2] = 1800 * s * Math.sin(th);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this.stars = new THREE.Points(g, new THREE.PointsMaterial({
            size: 1.6, sizeAttenuation: false, color: 0x8899bb, map: dotTexture(),
            transparent: true, depthWrite: false,
        }));
        this.scene.add(this.stars);
    }

    _buildEarth(textures) {
        this.earthFrame = new THREE.Group();          // of-date → J2000 correction
        this.scene.add(this.earthFrame);

        this.globeUniforms = {
            uSunObj: { value: new THREE.Vector3(1, 0, 0) },
            uDay:    { value: null },
            uNight:  { value: null },
            uHasTex: { value: 0 },
            uGrid:   { value: 1 },
        };
        // A null sampler is a GPU hazard, so both start as a 1×1 texture and
        // uHasTex stays 0 until the real pair has ARRIVED. The chip on the page
        // reads from the same flag, so it can never claim imagery it lacks.
        const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
        blank.needsUpdate = true;
        this.globeUniforms.uDay.value = blank;
        this.globeUniforms.uNight.value = blank;

        this.globe = new THREE.Mesh(
            new THREE.SphereGeometry(1, 96, 64),
            new THREE.ShaderMaterial({
                vertexShader: GLOBE_VS, fragmentShader: GLOBE_FS, uniforms: this.globeUniforms,
            }),
        );
        this.earthFrame.add(this.globe);

        // A faint atmosphere shell, purely to give the limb an edge.
        this.airglow = new THREE.Mesh(
            new THREE.SphereGeometry(1.025, 64, 48),
            new THREE.MeshBasicMaterial({
                color: 0x3f7fd0, transparent: true, opacity: 0.12,
                side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
            }),
        );
        this.earthFrame.add(this.airglow);

        this.texturesReady = false;
        if (textures && textures.length === 2) this._loadTextures(textures);
    }

    _loadTextures([dayUrl, nightUrl]) {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        let day = null, night = null;
        const settle = () => {
            if (!day || !night || this._disposed) return;
            day.colorSpace = THREE.SRGBColorSpace;
            night.colorSpace = THREE.SRGBColorSpace;
            this.globeUniforms.uDay.value = day;
            this.globeUniforms.uNight.value = night;
            this.globeUniforms.uHasTex.value = 1;
            this.texturesReady = true;
        };
        // A failed load is not an error here — it is the documented degraded
        // path, and the globe keeps its procedural skin. Never a console error
        // and never uHasTex = 1 with nothing behind it.
        loader.load(dayUrl, (t) => { day = t; settle(); }, undefined, () => {});
        loader.load(nightUrl, (t) => { night = t; settle(); }, undefined, () => {});
    }

    _buildShells() {
        this.shellGroup = new THREE.Group();
        this.scene.add(this.shellGroup);
        this.shells = SHELLS.map((s) => {
            const mat = new THREE.LineBasicMaterial({
                color: s.kind === 'orbit' ? 0x54e0b8 : s.kind === 'ld' ? 0x5a7fd6 : 0x8a6fd0,
                transparent: true, opacity: s.kind === 'orbit' ? 0.5 : 0.34,
            });
            const line = new THREE.LineLoop(ringGeometry(1), mat);
            const label = labelSprite(s.label, s.kind === 'orbit' ? '#54e0b8' : s.kind === 'ld' ? '#8fb0ff' : '#b79bff', 0.9);
            this.shellGroup.add(line, label);
            return { spec: s, line, label };
        });
    }

    _buildMoon() {
        this.moon = new THREE.Mesh(
            new THREE.SphereGeometry(1, 32, 24),
            new THREE.MeshBasicMaterial({ color: 0xb9b6ae }),
        );
        this.moonLabel = labelSprite('Moon', '#d8d5cc', 0.9);
        this.moonOrbit = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
            color: 0x6f6a80, transparent: true, opacity: 0.3,
        }));
        this._moonOrbitJd = null;
        this.scene.add(this.moon, this.moonLabel, this.moonOrbit);
    }

    _buildPopulation() {
        this.popGeom = new THREE.BufferGeometry();
        this.popGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
        this.popGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3));
        this.popMat = new THREE.PointsMaterial({
            size: 11, sizeAttenuation: false, vertexColors: true,
            map: dotTexture(), transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this.population = new THREE.Points(this.popGeom, this.popMat);
        this.population.frustumCulled = false;
        this.scene.add(this.population);
        this._visible = [];        // catalogue indices currently drawn, in buffer order
    }

    _buildRockPool() {
        this.sunPos = new THREE.Vector3(SUN_LIGHT_R, 0, 0);
        this.rocks = [];
        for (let i = 0; i < ROCK_POOL; i++) {
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), rockMaterial(0x9a8f80, 0, this.sunPos));
            mesh.visible = false;
            mesh.frustumCulled = false;
            this.scene.add(mesh);
            this.rocks.push({ mesh, index: null, des: null, spin: null });
        }
    }

    _buildOverlays() {
        // Sun direction: a marker plus a line from Earth, so "which way is the
        // Sun" is answerable without reading a number.
        this.sunMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xffdf8a }),
        );
        this.sunLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
            new THREE.LineBasicMaterial({ color: 0xffdf8a, transparent: true, opacity: 0.28 }),
        );
        this.sunLabel = labelSprite('to Sun', '#ffdf8a', 0.85);
        this.scene.add(this.sunMarker, this.sunLine, this.sunLabel);

        // Fireballs and the observer ride the GLOBE, so they turn with it.
        this.fireballGroup = new THREE.Group();
        this.globe.add(this.fireballGroup);
        this.observerGroup = new THREE.Group();
        this.observerGroup.visible = false;
        this.globe.add(this.observerGroup);

        const pin = new THREE.Mesh(
            new THREE.SphereGeometry(0.022, 12, 10),
            new THREE.MeshBasicMaterial({ color: 0x6ef0c0 }),
        );
        this.observerGroup.add(pin);
        // The local horizon: a disc tangent to the surface at the observer,
        // which is the plane the altitude in the panel is measured from.
        const horizon = new THREE.Mesh(
            new THREE.RingGeometry(0.02, 0.42, 48),
            new THREE.MeshBasicMaterial({
                color: 0x6ef0c0, transparent: true, opacity: 0.16,
                side: THREE.DoubleSide, depthWrite: false,
            }),
        );
        horizon.rotation.x = -Math.PI / 2;      // ring is in XY; lay it in the tangent plane
        this.observerGroup.add(horizon);

        // Selection: a ring around whatever is selected, in screen-fixed size.
        this.selRing = new THREE.Mesh(
            new THREE.RingGeometry(0.16, 0.185, 40),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }),
        );
        this.selRing.visible = false;
        this.selRing.renderOrder = 15;
        this.scene.add(this.selRing);
        this.selLabel = labelSprite('', '#ffffff', 1);
        this.selLabel.visible = false;
        this.scene.add(this.selLabel);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /** Set the simulation instant. Everything Earth-fixed re-derives from this. */
    setEpoch(jd) {
        this.jd = jd;

        // The of-date → J2000 correction, then the globe's own spin inside it.
        const M = earthSceneMatrix(jd);
        this.earthFrame.matrixAutoUpdate = false;
        this.earthFrame.matrix.set(
            M[0], M[1], M[2], 0,
            M[3], M[4], M[5], 0,
            M[6], M[7], M[8], 0,
            0, 0, 0, 1,
        );
        this.earthFrame.matrixWorldNeedsUpdate = true;
        this.globe.rotation.y = gmstRad(jd);

        // Sun direction, in scene space and then in the globe's object space
        // for the terminator. Taking the object-space vector from three's own
        // world matrix rather than re-deriving it is what keeps the drawn
        // terminator and the drawn globe from ever disagreeing.
        const s = sunGeoDirectionJ2000(jd);
        const eq = eclipticToEquatorial(s.x, s.y, s.z);
        const sc = equatorialToScene(eq.x, eq.y, eq.z);
        this._sunDir = new THREE.Vector3(sc.x, sc.y, sc.z).normalize();
        this.sunPos.copy(this._sunDir).multiplyScalar(SUN_LIGHT_R);
        for (const r of this.rocks) r.mesh.material.uniforms.u_sunPos.value.copy(this.sunPos);

        this.globe.updateMatrixWorld(true);
        const objSun = this._sunDir.clone().applyQuaternion(this.globe.getWorldQuaternion(new THREE.Quaternion()).invert());
        this.globeUniforms.uSunObj.value.copy(objSun.normalize());

        // The Sun marker sits just outside the drawn horizon, not at 1 AU:
        // the radial map would put the real Sun at 30 units and the camera
        // would never contain it. It is a DIRECTION indicator and is labelled
        // as one.
        const markR = this._outerRadius() * 1.12;
        this.sunMarker.position.copy(this._sunDir).multiplyScalar(markR);
        this.sunLabel.position.copy(this._sunDir).multiplyScalar(markR * 1.06);
        const lp = this.sunLine.geometry.attributes.position;
        lp.setXYZ(0, 0, 0, 0);
        lp.setXYZ(1, this.sunMarker.position.x, this.sunMarker.position.y, this.sunMarker.position.z);
        lp.needsUpdate = true;

        this._placeMoon(jd);
        this._placeShells();
    }

    _placeMoon(jd) {
        const m = moonGeoJ2000(jd);
        const p = geoToScene(m.x, m.y, m.z, { trueScale: this.trueScale });
        this.moon.position.set(p.x, p.y, p.z);
        // Drawn on the SAME radial map as everything else, so its disc is a
        // size on that map, not a real angular size. Small and honest.
        const r = this.trueScale
            ? trueSceneRadius(MOON_RADIUS_KM)
            : Math.max(0.12, geoSceneRadius(m.distKm) - geoSceneRadius(m.distKm - MOON_RADIUS_KM));
        this.moon.scale.setScalar(r);
        this.moonLabel.position.copy(this.moon.position).multiplyScalar(1.05);
        this._placeMoonOrbit(jd);
    }

    /**
     * The Moon's real path over one sidereal month, sampled from the same
     * ephemeris as its position and drawn on the same radial map. An equatorial
     * circle at the Moon's current radius would have been cheaper and would
     * have been a lie twice over: the orbit is inclined ~5° to the ecliptic
     * (which is itself 23.4° to this stage's equator) and it is eccentric
     * enough that apogee and perigee differ by 13 % — visible as a ring that
     * does not pass through the Moon at either end.
     */
    _placeMoonOrbit(jd) {
        if (this._moonOrbitJd != null && Math.abs(jd - this._moonOrbitJd) < 0.05) {
            return;
        }
        this._moonOrbitJd = jd;
        const N = 96, pts = [];
        for (let k = 0; k < N; k++) {
            const m = moonGeoJ2000(jd + (k / N) * 27.321661);
            const q = geoToScene(m.x, m.y, m.z, { trueScale: this.trueScale });
            pts.push(new THREE.Vector3(q.x, q.y, q.z));
        }
        this.moonOrbit.geometry.dispose();
        this.moonOrbit.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    }

    _placeShells() {
        for (let i = 0; i < this.shells.length; i++) {
            const sh = this.shells[i];
            const r = this.trueScale ? trueSceneRadius(sh.spec.km) : geoSceneRadius(sh.spec.km);
            const inView = sh.spec.km <= this.horizonKm * 1.35;
            sh.line.scale.setScalar(r);
            sh.line.visible = inView;
            // Each label sits at its own azimuth on its own ring. Rings only a
            // few percent apart in radius — 0.05 AU and 20 LD are 3 % apart —
            // would otherwise print their names on top of each other.
            const a = -0.55 + i * 0.42;
            sh.label.position.set(r * Math.cos(a), 0, r * Math.sin(a));
            sh.label.visible = inView;
        }
    }

    /** Which drawn radius the outermost visible shell reaches. */
    _outerRadius() {
        return this.trueScale ? trueSceneRadius(this.horizonKm) : geoSceneRadius(this.horizonKm);
    }

    /**
     * Re-range the camera and the backdrop for the active map. True scale puts
     * 0.5 AU at 11 700 units where the log map puts it at 26, so a fixed `far`
     * would clip the entire population the moment the toggle is flipped — and
     * a fixed star sphere would end up INSIDE it.
     */
    _applyRange() {
        const outer = this._outerRadius();
        this.controls.maxDistance = Math.max(50, outer * 3.2);
        this.controls.minDistance = 1.35;
        this.camera.far = Math.max(4000, outer * 30);
        // Near/far ratio: the globe is 1 unit across and must stay solid, so
        // `near` rides the far plane rather than sitting at a constant.
        this.camera.near = Math.max(0.01, this.camera.far / 400000);
        this.camera.updateProjectionMatrix();
        this.stars.scale.setScalar(Math.max(1, outer * 8 / 1800));
    }

    /** Swap the radial map. The camera is re-ranged because the numbers change by 100×. */
    setTrueScale(on) {
        if (this.trueScale === on) return;
        this.trueScale = !!on;
        this._applyRange();
        const outer = this._outerRadius();
        this.camera.position.normalize().multiplyScalar(Math.min(outer * 1.6, this.controls.maxDistance));
        this.setEpoch(this.jd);
        this._refreshPopulation();
    }

    setHorizon(km) {
        this.horizonKm = km;
        this._applyRange();
        this._placeShells();
        this._refreshPopulation();
        this.setEpoch(this.jd);
    }

    /**
     * Frame the whole drawn horizon. The camera distance is set from the
     * horizon radius directly rather than from a per-axis triple — written as
     * three components it came out at 1.9x the radius, which put Earth at a
     * dozen pixels inside a scene whose whole point is that Earth is in it.
     */
    frameAll() {
        const outer = this._outerRadius();
        this.controls.target.set(0, 0, 0);
        this.camera.position.set(0.62, 0.42, 0.66).normalize().multiplyScalar(outer * 1.15);
        this.controls.update();
    }

    /** Frame the globe itself — the LEO/GEO neighbourhood. */
    frameEarth() {
        this.controls.target.set(0, 0, 0);
        this.camera.position.set(3.2, 1.7, 4.0);
        this.controls.update();
    }

    /**
     * Hand the stage a propagated population. `geo` is the worker's geocentric
     * ecliptic J2000 output (3N, AU); `rGeo` its distances (N, AU). Both are
     * retained by reference — the caller must not reuse the buffers.
     */
    setPopulation({ geo, rGeo, count }) {
        this.geo = geo; this.rGeo = rGeo; this.count = count;
        this._refreshPopulation();
    }

    /** Element metadata for the objects the page cares about, keyed by index. */
    setMeta(objects) {
        for (const o of objects) this.meta.set(o.index, o);
        this._refreshRocks();
    }

    _refreshPopulation() {
        if (!this.geo || !this.count) {
            this.popGeom.setDrawRange(0, 0);
            this._visible = [];
            return;
        }
        const horizonAU = this.horizonKm / AU_KM;
        const idx = [];
        for (let k = 0; k < this.count; k++) if (this.rGeo[k] <= horizonAU) idx.push(k);

        const N = idx.length;
        // Grown, never reallocated per frame: at warp this runs every frame over
        // up to ~38 000 objects, and two fresh Float32Arrays a frame is ~900 kB
        // of garbage per frame for a page that is otherwise allocation-free.
        if (!this._posBuf || this._posBuf.length < N * 3) {
            this._posBuf = new Float32Array(Math.max(N, 1) * 3);
            this._colBuf = new Float32Array(Math.max(N, 1) * 3);
            this.popGeom.setAttribute('position', new THREE.BufferAttribute(this._posBuf, 3));
            this.popGeom.setAttribute('color', new THREE.BufferAttribute(this._colBuf, 3));
        }
        const pos = this._posBuf, col = this._colBuf;
        const c = new THREE.Color();
        for (let j = 0; j < N; j++) {
            const k = idx[j], o = k * 3;
            const p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
            pos[j * 3] = p.x; pos[j * 3 + 1] = p.y; pos[j * 3 + 2] = p.z;
            const meta = this.meta.get(k);
            const flags = meta ? meta.flags : 0;
            c.setHex(
                (flags & FLAG.INTERSTELLAR) ? COLOR.interstellar
                : (flags & FLAG.COMET) ? COLOR.comet
                : (flags & FLAG.PHA) ? COLOR.pha
                : COLOR.neo,
            );
            // Nearer objects read brighter — the one cue the log map flattens.
            const near = 1 - Math.min(1, this.rGeo[k] / horizonAU);
            const gain = 0.62 + 0.38 * near * near;
            col[j * 3] = c.r * gain; col[j * 3 + 1] = c.g * gain; col[j * 3 + 2] = c.b * gain;
        }
        this.popGeom.attributes.position.needsUpdate = true;
        this.popGeom.attributes.color.needsUpdate = true;
        this.popGeom.setDrawRange(0, N);
        // Bounding sphere is never used for culling here (frustumCulled is off,
        // because objects can sit anywhere on a four-decade map) and computing
        // it over the oversized buffer would include a stale tail.
        this.popGeom.boundingSphere = null;
        this._visible = idx;
        this._refreshRocks();
        this._placeSelection();
    }

    /**
     * Assign the mesh pool: the selected object first, then the nearest few.
     * Their sprites keep drawing underneath — at these sizes a mesh and a dot
     * are the same handful of pixels and suppressing one makes the population
     * count visibly wrong.
     */
    _refreshRocks() {
        if (!this.geo) return;
        const want = [];
        if (this.selected != null && this.rGeo && this.selected < this.count) want.push(this.selected);
        const sorted = [...this._visible].sort((a, b) => this.rGeo[a] - this.rGeo[b]);
        for (const k of sorted) {
            if (want.length >= ROCK_POOL) break;
            if (!want.includes(k)) want.push(k);
        }
        for (let i = 0; i < this.rocks.length; i++) {
            const slot = this.rocks[i];
            const k = want[i];
            if (k == null) { slot.mesh.visible = false; slot.index = null; continue; }
            const meta = this.meta.get(k);
            const des = meta?.des || `#${k}`;
            if (slot.des !== des) {
                const seed = hash32(des);
                slot.mesh.geometry.dispose();
                slot.mesh.geometry = rockGeometry({ seed, shape: shapeFor(des, seed), detail: 4 });
                slot.spin = spinFor(des, seed);
                slot.des = des;
                slot.mesh.material.uniforms.u_base.value.setHex(
                    (meta?.flags & FLAG.COMET) ? 0x9fd8cf : (meta?.flags & FLAG.PHA) ? 0xb08878 : 0x9a8f80,
                );
            }
            const o = k * 3;
            const p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
            slot.mesh.position.set(p.x, p.y, p.z);
            // Sizes are the orrery's disclosed log map; never used for physics.
            const drawn = drawnRockRadius(meta?.diam ?? null);
            slot.mesh.scale.setScalar(Math.max(0.03, drawn * 1.6));
            slot.mesh.visible = true;
            slot.index = k;
        }
    }

    /** Selection ring + label follow the selected object. */
    _placeSelection() {
        const k = this.selected;
        if (k == null || !this.geo || k >= this.count) {
            this.selRing.visible = false;
            this.selLabel.visible = false;
            return;
        }
        const o = k * 3;
        const p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
        this.selRing.position.set(p.x, p.y, p.z);
        this.selRing.visible = true;
        const meta = this.meta.get(k);
        const name = meta?.name || meta?.des || 'selected';
        if (this._selName !== name) {
            this.scene.remove(this.selLabel);
            this.selLabel = labelSprite(name, '#ffffff', 1);
            this.scene.add(this.selLabel);
            this._selName = name;
        }
        this.selLabel.position.set(p.x, p.y, p.z);
        this.selLabel.visible = true;
    }

    select(index) {
        this.selected = index;
        this._refreshRocks();
        this._placeSelection();
    }

    /** Fly the camera so the selected object and Earth are both in frame. */
    focusSelected() {
        if (this.selected == null || !this.geo) return;
        const o = this.selected * 3;
        const p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
        const r = Math.hypot(p.x, p.y, p.z);
        this.controls.target.set(0, 0, 0);
        this.camera.position.set(p.x, p.y, p.z).normalize().multiplyScalar(Math.max(2.4, r * 1.9));
        this.camera.position.y += r * 0.35;
        this.controls.update();
    }

    /**
     * Pin recent bolides at their real lat/lon on the rotating globe. Only
     * possible because this globe tracks GMST — see the header.
     */
    setFireballs(events) {
        while (this.fireballGroup.children.length) {
            const c = this.fireballGroup.children.pop();
            c.geometry?.dispose?.(); c.material?.dispose?.();
        }
        const now = Date.now();
        for (const ev of events || []) {
            if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lon)) continue;
            const ageDays = (now - ev.t_ms) / 86400e3;
            const kt = Math.max(0.01, ev.impact_kt ?? 0.01);
            const size = 0.012 + 0.035 * Math.min(1, Math.log10(1 + kt * 10) / 2);
            const m = new THREE.Mesh(
                new THREE.SphereGeometry(size, 10, 8),
                new THREE.MeshBasicMaterial({
                    color: 0xff9a3c, transparent: true,
                    opacity: Math.max(0.28, 1 - ageDays / 400),
                }),
            );
            // Canonical Earth frame: +X at lon 0, +Y north, −Z at 90 E.
            const la = ev.lat * Math.PI / 180, lo = ev.lon * Math.PI / 180;
            const R = 1.012;
            m.position.set(R * Math.cos(la) * Math.cos(lo), R * Math.sin(la), -R * Math.cos(la) * Math.sin(lo));
            m.userData.fireball = ev;
            this.fireballGroup.add(m);
        }
    }

    setFireballsVisible(on) { this.fireballGroup.visible = !!on; }

    /** Place the observer pin and their local horizon plane. */
    setObserver(obs) {
        if (!obs || !Number.isFinite(obs.latDeg) || !Number.isFinite(obs.lonDeg)) {
            this.observerGroup.visible = false;
            return;
        }
        const la = obs.latDeg * Math.PI / 180, lo = obs.lonDeg * Math.PI / 180;
        const n = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
        this.observerGroup.position.copy(n).multiplyScalar(1.005);
        // The horizon disc is tangent: its +Y (after the ring's own −90° x
        // rotation) must be the local vertical.
        this.observerGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        this.observerGroup.visible = true;
    }

    setGrid(on) { this.globeUniforms.uGrid.value = on ? 1 : 0; }

    // ── Interaction ─────────────────────────────────────────────────────────

    _handleClick(ev) {
        const rect = this.canvas.getBoundingClientRect();
        this._pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        this._ray.setFromCamera(this._pointer, this.camera);

        // Meshes first — a rock that is standing in for a point is what the
        // cursor is actually over.
        const meshHits = this._ray.intersectObjects(this.rocks.map(r => r.mesh).filter(m => m.visible), false);
        if (meshHits.length) {
            const slot = this.rocks.find(r => r.mesh === meshHits[0].object);
            if (slot && slot.index != null) { this.onPick(slot.index); return; }
        }
        const hits = this._ray.intersectObject(this.population, false);
        if (hits.length) {
            // Points raycasting sorts along the RAY. Re-sort across it, or a
            // click means "nearest the camera" rather than "nearest the cursor".
            hits.sort((a, b) => a.distanceToRay - b.distanceToRay);
            const k = this._visible[hits[0].index];
            if (k != null) { this.onPick(k); return; }
        }
        this.onPick(null);
    }

    // ── Frame ───────────────────────────────────────────────────────────────

    resize() {
        const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(1, h);
        this.camera.updateProjectionMatrix();
    }

    render() {
        if (this._disposed) return;
        this.controls.update();
        // Labels are pixel-sized; hide the shell labels once their ring is too
        // small on screen to point at. The orrery's scar: a dozen labels
        // stacked on the Earth disc at the wide view.
        const camDist = this.camera.position.length();
        for (const sh of this.shells) {
            if (!sh.line.visible) { sh.label.visible = false; continue; }
            const f = sh.line.scale.x / camDist;
            // Too small to point at, or so much larger than the view that its
            // ring is off screen entirely — a label for either is noise.
            sh.label.visible = f > 0.08 && f < 2.6 && (sh.spec.alwaysOn || f > 0.22);
        }
        this.moonLabel.visible = this.moon.position.length() / camDist > 0.05;
        // The selection ring is a screen-space annotation, so it faces the
        // camera and keeps a constant pixel size.
        if (this.selRing.visible) {
            this.selRing.quaternion.copy(this.camera.quaternion);
            this.selRing.scale.setScalar(Math.max(0.35, camDist * 0.055));
        }
        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        this._disposed = true;
        this.canvas.removeEventListener('click', this._onClick);
        this.controls.dispose();
        this.renderer.dispose();
    }
}

export default NeoStage;
