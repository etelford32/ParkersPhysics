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
 *                Two of them are not ruler marks at all: the SOI and the Hill
 *                sphere are GRAVITY boundaries, drawn amber, and their radii
 *                are recomputed per frame from Earth's live heliocentric
 *                distance rather than read from the table (both scale with it,
 *                by 3.3 % over a year). The Hill sphere is the edge of Earth's
 *                gravitational domain; the SOI is the edge of this page's own
 *                competence, since inside it our heliocentric two-body
 *                positions are the wrong model and the panel says so.
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
 * ── Picking, hover and framing ─────────────────────────────────────────────
 * PICKING IS SCREEN-SPACE. three's `Raycaster` against a `Points` cloud takes
 * a `threshold` in WORLD units, but these dots are drawn at a fixed 11 px with
 * `sizeAttenuation: false` — so a world radius and a pixel radius agree at
 * exactly one camera distance and nowhere else. The 0.22-unit threshold this
 * replaced worked out to ~7 px at the default framing, ~64 px zoomed in to
 * Earth, and 0.016 px in TRUE SCALE, where nothing on the stage could be
 * selected at all. `pickAt` projects the Moon and every drawn point to the
 * screen and takes the nearest within a pixel radius: exact, matched to what
 * the viewer can actually see, and one projection per visible object.
 *
 *   - 14 px for a cursor, 44 px for a fingertip (the repo's standing
 *     touch-target floor, shared with js/nav.js).
 *   - A TAP is a `pointerup` within 6 px (14 on touch) and 700 ms of its
 *     `pointerdown`, measured on `event.timeStamp` — NOT `performance.now()`,
 *     which is when the handler ran rather than when the browser generated the
 *     event, and on a frame rebuilding thousands of positions those differ by
 *     hundreds of ms (mars.html measured 914). Without the press/release test
 *     every camera drag ends in a click, and on a page whose entire surface is
 *     a drag target that reads as the selection resetting at random.
 *   - Hover is resolved from `render()`, at most `HOVER_HZ`, not from the
 *     `pointermove` handler: moves fire far faster than the scene changes, and
 *     running it per frame is also what keeps the ring on an object that is
 *     MOVING under a still cursor — which at warp is most of what happens.
 *   - Hover is a MOUSE affordance: a touch pointer dragging the camera must
 *     not leave a highlight behind it.
 *   - Names are not hover-only. `NEAR_LABELS` of the nearest objects carry
 *     labels on the stage, because sweeping a cursor over a field of identical
 *     dots is the findability failure mars.html's feature index exists to fix.
 *
 * FRAMING IS DERIVED, never a hand-tuned multiple of the radius. `frameAll`
 * used to sit at 1.15 × the outer radius, which with a 45° VERTICAL field
 * shows the inner 48 % of it — the ring the button is named after was off the
 * top of the canvas, and so was anything near it. It presented as a picking
 * bug: the pick was exact to 1.4e-5 px and the object projected to y = −58.
 * `_distanceToFit` reads the camera's own fov and aspect, and the binding
 * half-angle is the SMALLER one (vertical on a wide canvas, horizontal on a
 * narrow one), so the phone case cannot be read off the desktop one.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    SHELLS, AU_KM, MOON_RADIUS_KM, HORIZONS, DEFAULT_HORIZON,
    geoToScene, geoSceneRadius, trueSceneRadius, bodySceneRadius,
    gmstRad, earthSceneMatrix,
    sunGeoDirectionJ2000, moonGeoJ2000, moonPhase, moonPath, moonApsides,
    equatorialToScene, eclipticToEquatorial,
    earthHelioJ2000, hillRadiusKm, soiRadiusKm,
} from '../neo-space.js';
import { FLAG } from '../neo-orbits.js';
import { rockGeometry, rockMaterial, shapeFor, spinFor, hash32, drawnRockRadius } from '../neo-rocks.js';

/**
 * The drawn atmosphere's outer radius, in Earth radii — 160 km. Not where the
 * atmosphere ends (it does not end); where the scattering a camera records
 * dies out. Disclosed in the page's legend.
 */
const ATMO_OUTER = 1 + 160 / 6371.0088;
/**
 * Where the rocks are lit from. Far enough that the direction is effectively
 * parallel across the whole stage (the residual is ~0.001° at 0.5 AU drawn in
 * true scale), which is what a body 1 AU away actually does.
 */
const SUN_LIGHT_R = 1e7;
/** Pool size for real meshes. Small on purpose — each is 1280 faces. */
const ROCK_POOL = 8;
/** Longest a press may last and still count as a tap rather than a drag, ms. */
const TAP_MAX_MS = 700;
/** How often a hover is resolved. Every resolution projects the population. */
const HOVER_HZ = 30;
/** How many of the nearest objects get a name on the stage. */
const NEAR_LABELS = 5;
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
    varying vec3 vWorld;
    void main() {
        vObj = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const GLOBE_FS = /* glsl */`
    uniform vec3      uSunObj;      // Sun direction in OBJECT space
    uniform vec3      uSunWorld;    // Sun direction in WORLD space (specular)
    uniform sampler2D uDay;
    uniform sampler2D uNight;
    uniform float     uHasTex;      // 0 until both textures have actually arrived
    uniform float     uGrid;
    varying vec3      vObj;
    varying vec3      vWorld;

    const float PI = 3.141592653589793;

    void main() {
        // Object space uses the repo's canonical Earth frame: +X at lon 0,
        // +Y north, -Z at 90 E (js/geo/coords.js). Deriving lat/lon here rather
        // than trusting three's sphere UVs means the mesh's own rotation.y IS
        // the sidereal angle and nothing depends on the tessellator's seam.
        float lat = asin(clamp(vObj.y, -1.0, 1.0));
        float lon = atan(-vObj.z, vObj.x);
        vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

        float ndl = dot(vObj, uSunObj);

        // Procedural fallback: a plain ocean sphere. Deliberately NOT a
        // guess at geography — an earlier version put white caps on everything
        // above 51 deg, which is the latitude of London, and the result read
        // as a map while being nothing of the sort (and blew out the sunward
        // limb into a white blob). A featureless globe with a graticule is
        // unambiguous about being schematic, and the page's imagery chip says
        // "procedural globe" while it is showing.
        vec3 base  = vec3(0.055, 0.115, 0.235);
        vec3 dayC  = base;
        vec3 nightC = base * 0.05;
        float oceanMask = 1.0;

        vec3 texDay   = texture2D(uDay,   uv).rgb;
        vec3 texNight = texture2D(uNight, uv).rgb;
        // Ocean from the day texture: water is the only thing on Earth whose
        // blue channel dominates BOTH others by a clear margin, so this needs
        // no second map. Only consulted when a texture actually arrived.
        float texOcean = smoothstep(0.02, 0.14, texDay.b - max(texDay.r, texDay.g));
        oceanMask = mix(oceanMask, texOcean, uHasTex);
        dayC   = mix(dayC,   texDay,   uHasTex);
        // City lights are the night texture's own signal; lift them rather than
        // the whole night side so the unlit ocean stays dark.
        nightC = mix(nightC, texNight * 1.6, uHasTex);

        // ── Terminator ──────────────────────────────────────────────────────
        // A soft ~14 deg band, and a warm one: the light reaching the ground
        // there has come the long way through the atmosphere. This is the
        // sunset, drawn on the surface rather than only in the shell above it.
        float day = smoothstep(-0.12, 0.12, ndl);
        float belt = exp(-pow(ndl / 0.20, 2.0));
        // Lambert across the lit hemisphere. Without it the day side is a flat
        // disc of one colour and the globe reads as a circle rather than a
        // ball; with a texture it is also the correct thing to do, since an
        // albedo map is a reflectance and wants the cosine applied to it.
        dayC *= 0.16 + 0.84 * max(ndl, 0.0);
        vec3 col = mix(nightC, dayC, day);
        col = mix(col, col * vec3(1.45, 0.86, 0.60), belt * day * 0.55);

        // ── Ocean glint ─────────────────────────────────────────────────────
        // The specular highlight the Sun leaves on water. Real, geography-free
        // (it only needs the ocean mask), and the single strongest cue that
        // this is a lit sphere rather than a flat disc.
        vec3 N = normalize(vWorld);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 H = normalize(uSunWorld + V);
        // Tight and weak: the glint is a highlight a few hundred km across, not
        // a sheen over the sunward hemisphere.
        float spec = pow(max(dot(N, H), 0.0), 110.0) * oceanMask * day;
        col += vec3(1.0, 0.94, 0.80) * spec * 0.28;

        // ── Graticule ───────────────────────────────────────────────────────
        // Every 30 deg, brighter on the equator, drawn at a screen-space
        // derivative width so it stays one line wide at any zoom.
        float latLines = abs(fract(degrees(lat) / 30.0 + 0.5) - 0.5);
        float lonLines = abs(fract(degrees(lon) / 30.0 + 0.5) - 0.5);
        float lw = fwidth(degrees(lat)) / 30.0 * 0.9 + 1e-4;
        float grid = max(1.0 - smoothstep(0.0, lw, latLines), 1.0 - smoothstep(0.0, lw, lonLines));
        float eq   = 1.0 - smoothstep(0.0, lw * 1.6, abs(degrees(lat)) / 30.0);
        col = mix(col, vec3(0.45, 0.72, 0.95), grid * uGrid * 0.26 + eq * uGrid * 0.22);

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
    }
`;

// ── The atmosphere ──────────────────────────────────────────────────────────
//
// A MARCHED shell, not a rim term. On a sphere drawn with BackSide the drawn
// faces are the far hemisphere, their outward normals point away from the
// camera, and `max(dot(n, viewDir), 0.0)` is identically zero — so
// `pow(rim, n)` DOES NOT VARY, which is exactly how solar-system.html's two
// glow shells came out as flat plates with hard rims (SOLAR_SYSTEM_VISUAL_
// REVIEW.md S3). The fix there was a closed-form column; here the shell is
// thin enough that eight samples along the actual view chord are cheaper than
// deriving one, and they buy something a closed form would not: each sample
// can ask whether it is in Earth's own shadow, which is what puts the red ring
// on the night side of the terminator instead of a uniform halo.
//
// This is a MODEL of Rayleigh scattering, not a radiative transfer solution:
// the sun-ward optical depth is a Chapman-style secant approximation, and the
// shell is drawn to 160 km because that is where the scattering a camera
// records dies out, not because the atmosphere ends there.
const ATMO_VS = /* glsl */`
    varying vec3 vWorld;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const ATMO_FS = /* glsl */`
    uniform vec3  uSunWorld;
    uniform float uOuter;        // shell radius, in Earth radii
    varying vec3  vWorld;

    // Rayleigh weights, 1/lambda^4 at 680/550/440 nm, normalised to the red.
    const vec3 BETA = vec3(1.0, 2.33, 5.71);
    const float H_SCALE = 0.0013;    // 8.5 km in Earth radii

    // Both roots of a ray against a sphere of radius r centred at the origin.
    // Returns vec2(-1.0) when the ray misses.
    vec2 sphereHit(vec3 ro, vec3 rd, float r) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - r * r;
        float d = b * b - c;
        if (d < 0.0) return vec2(-1.0);
        float sq = sqrt(d);
        return vec2(-b - sq, -b + sq);
    }

    void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vWorld - cameraPosition);

        vec2 atm = sphereHit(ro, rd, uOuter);
        if (atm.y < 0.0) discard;
        float t0 = max(atm.x, 0.0);
        float t1 = atm.y;

        // Stop at the ground: the column in front of the surface is all we may
        // draw, or the glow would show through the planet.
        vec2 ground = sphereHit(ro, rd, 1.0);
        if (ground.x > 0.0) t1 = min(t1, ground.x);
        if (t1 <= t0) discard;

        const int STEPS = 8;
        float dt = (t1 - t0) / float(STEPS);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < STEPS; i++) {
            vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
            float r = length(p);
            float h = max(r - 1.0, 0.0);
            float dens = exp(-h / H_SCALE);

            // Is this parcel in sunlight, or behind the Earth?
            float mu = dot(p / r, uSunWorld);                 // local sun elevation
            vec2 toSun = sphereHit(p, uSunWorld, 1.0);
            float lit = (toSun.x > 0.0) ? 0.0 : 1.0;          // the planet's shadow

            // Chapman-style secant for the slant path to the Sun. Clamped at a
            // grazing floor so the terminator reddens instead of going black.
            float odSun = dens * H_SCALE / max(mu, 0.06);
            vec3 transmit = exp(-BETA * odSun * 320.0);

            acc += dens * lit * transmit * dt;
        }

        // Forward scattering: the limb you are looking THROUGH is brighter.
        float cosSun = dot(rd, uSunWorld);
        float phase = 0.75 * (1.0 + cosSun * cosSun);
        // GAIN. The shell's front face covers the whole disc, not just the
        // limb, so this multiplies the haze over the GROUND as much as the ring
        // around it. Sized from the limb: a grazing chord integrates to about
        // sqrt(2*pi*H) ~ 0.09 against 0.0013 straight down, so the ring is ~70x
        // the haze over the ground and one gain sets both. Measured on the lit
        // limb rather than guessed — see NEO_WATCH_PLAN.md.
        vec3 col = acc * BETA * phase * 9.0;

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
    }
`;

// ── The Moon ────────────────────────────────────────────────────────────────
//
// Lit by LOMMEL-SEELIGER, not Lambert. The Moon is the textbook case of a
// surface that is not Lambertian: a Lambert full moon is bright in the middle
// and dark at the limb, and the real one is famously almost flat across the
// disc — which is why it reads as a disc rather than a ball at full phase.
// I ~ mu0 / (mu0 + mu) reproduces that for free and costs one divide, and it
// is the same single-scattering law the lunar photometry literature starts
// from. The phase itself is not drawn or faked: it falls out of the Sun
// direction the rest of the stage already uses.
const MOON_VS = /* glsl */`
    varying vec3 vN;
    varying vec3 vWorld;
    varying vec3 vObj;
    void main() {
        vObj = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const MOON_FS = /* glsl */`
    uniform vec3      uSunWorld;
    uniform vec3      uEarthDir;   // unit, Moon toward Earth: the earthshine source
    uniform sampler2D uSurface;
    uniform float     uHasTex;
    varying vec3      vN;
    varying vec3      vWorld;
    varying vec3      vObj;

    const float PI = 3.141592653589793;

    void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        float mu0 = dot(N, uSunWorld);           // cos of the incidence angle
        float mu  = max(dot(N, V), 0.0);         // cos of the emission angle

        // Lommel-Seeliger. Zero on the unlit side, with a short smoothstep so
        // the terminator is a terminator and not a jagged tessellation edge.
        float lit = smoothstep(-0.03, 0.06, mu0);
        float ls = (mu0 > 0.0 && (mu0 + mu) > 0.0) ? mu0 / (mu0 + mu) : 0.0;

        // Albedo: the real surface when it arrived, otherwise the Moon's own
        // mean geometric albedo as a flat grey. No invented maria.
        float albedo = 0.136;
        vec3 surf = vec3(albedo);
        vec3 tex = texture2D(uSurface, vec2(atan(-vObj.z, vObj.x) / (2.0 * PI) + 0.5,
                                            0.5 - asin(clamp(vObj.y, -1.0, 1.0)) / PI)).rgb;
        surf = mix(surf, tex * 0.42, uHasTex);

        // Earthshine: the night side of the Moon is lit by a full Earth, which
        // is ~50x brighter in the lunar sky than a full Moon is in ours. Faint,
        // blue, and the reason the dark limb of a crescent is visible at all.
        float earthLit = max(dot(N, uEarthDir), 0.0) * (1.0 - lit);

        vec3 col = surf * (ls * lit * 2.6) + surf * earthLit * 0.055 * vec3(0.55, 0.72, 1.0);

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
        this.onHover = opts.onHover || (() => {});
        this.trueScale = false;
        // Derived, never typed: a second copy of the default horizon here
        // would silently disagree with the <select> the moment one moved.
        this.horizonKm = (HORIZONS.find(h => h.id === DEFAULT_HORIZON) || HORIZONS[0]).km;
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
        this._buildMoon(opts.moonTexture);
        this._buildPopulation();
        this._buildRockPool();
        this._buildOverlays();

        // Pointer events, not click: one path for mouse, pen and touch, and a
        // press/release pair we can measure to tell a tap from a camera drag.
        this.hovered = null;
        this._down = null;
        this._hoverClient = null;
        this._listeners = [
            ['pointerdown', (ev) => this._onPointerDown(ev)],
            ['pointerup', (ev) => this._onPointerUp(ev)],
            ['pointermove', (ev) => this._onPointerMove(ev)],
            ['pointerleave', () => this._onPointerLeave()],
            ['pointercancel', () => { this._down = null; this._onPointerLeave(); }],
        ];
        for (const [type, fn] of this._listeners) canvas.addEventListener(type, fn, { passive: true });

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
            uSunObj:   { value: new THREE.Vector3(1, 0, 0) },
            uSunWorld: { value: new THREE.Vector3(1, 0, 0) },
            uDay:      { value: null },
            uNight:    { value: null },
            uHasTex:   { value: 0 },
            uGrid:     { value: 1 },
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

        // The atmosphere. FrontSide, not BackSide: the shader marches the view
        // chord from the fragment inward, so it needs the shell's NEAR surface
        // as its entry point, and the march clamps at the ground so the glow
        // cannot show through the planet. Additive with depthWrite off, because
        // scattered light adds to whatever is behind it.
        this.atmoUniforms = {
            uSunWorld: { value: new THREE.Vector3(1, 0, 0) },
            uOuter:    { value: ATMO_OUTER },
        };
        this.atmosphere = new THREE.Mesh(
            new THREE.SphereGeometry(ATMO_OUTER, 96, 64),
            new THREE.ShaderMaterial({
                vertexShader: ATMO_VS, fragmentShader: ATMO_FS, uniforms: this.atmoUniforms,
                transparent: true, depthWrite: false, side: THREE.FrontSide,
                blending: THREE.AdditiveBlending,
            }),
        );
        // NOT a child of earthFrame: the shell is a sphere about the same
        // centre, and parenting it to a rotating frame would only make its
        // uniforms need the inverse rotation for nothing.
        this.scene.add(this.atmosphere);

        // A pole marker, so "which way is north" is answerable at a glance on a
        // stage whose +Y is the celestial pole rather than anything drawn.
        this.poleAxis = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, -1.45, 0), new THREE.Vector3(0, 1.45, 0),
            ]),
            new THREE.LineBasicMaterial({ color: 0x5a7fd6, transparent: true, opacity: 0.35 }),
        );
        this.scene.add(this.poleAxis);

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
            const color = s.kind === 'orbit' ? 0x54e0b8
                : s.kind === 'ld' ? 0x5a7fd6
                : s.kind === 'gravity' ? 0xffb05c
                : 0x8a6fd0;
            const mat = new THREE.LineBasicMaterial({
                color, transparent: true,
                opacity: s.kind === 'orbit' ? 0.5 : s.kind === 'gravity' ? 0.62 : 0.34,
            });
            const line = new THREE.LineLoop(ringGeometry(1), mat);
            const label = labelSprite(s.label,
                s.kind === 'orbit' ? '#54e0b8' : s.kind === 'ld' ? '#8fb0ff'
                : s.kind === 'gravity' ? '#ffb05c' : '#b79bff', 0.9);
            this.shellGroup.add(line, label);
            return { spec: s, line, label };
        });
    }

    _buildMoon(surfaceUrl) {
        const blank = new THREE.DataTexture(new Uint8Array([160, 160, 160, 255]), 1, 1, THREE.RGBAFormat);
        blank.needsUpdate = true;
        this.moonUniforms = {
            uSunWorld: { value: new THREE.Vector3(1, 0, 0) },
            uEarthDir: { value: new THREE.Vector3(-1, 0, 0) },
            uSurface:  { value: blank },
            uHasTex:   { value: 0 },
        };
        // TRUE RELATIVE SIZE, in both scale modes and at every distance. The
        // kernel owns that rule (`bodySceneRadius`): the map compresses
        // DISTANCE, and a body scaled up to be easier to see would make the one
        // ratio on this stage a viewer can check into a lie.
        this.moon = new THREE.Mesh(
            new THREE.SphereGeometry(bodySceneRadius(MOON_RADIUS_KM), 48, 32),
            new THREE.ShaderMaterial({
                vertexShader: MOON_VS, fragmentShader: MOON_FS, uniforms: this.moonUniforms,
            }),
        );
        this.moonLabel = labelSprite('Moon', '#d8d5cc', 0.9);
        this.moonOrbit = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
            color: 0x8e8aa6, transparent: true, opacity: 0.5,
        }));
        this._moonOrbitJd = null;

        // Perigee and apogee of the orbit the Moon is on now. Drawn because a
        // circle would hide the one thing the lunar orbit's shape actually
        // does: the two differ by about 13 %.
        this.apsisMarks = {};
        for (const id of ['perigee', 'apogee']) {
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(0.09, 10, 8),
                new THREE.MeshBasicMaterial({ color: id === 'perigee' ? 0xffb05c : 0x7f8aa8 }),
            );
            const label = labelSprite(id, id === 'perigee' ? '#ffb05c' : '#9fb0cc', 0.8);
            dot.visible = label.visible = false;
            this.scene.add(dot, label);
            this.apsisMarks[id] = { dot, label };
        }
        this.scene.add(this.moon, this.moonLabel, this.moonOrbit);
        if (surfaceUrl) this._loadMoonTexture(surfaceUrl);
    }

    /** Optional, and never allowed to claim more than it has — as for Earth. */
    _loadMoonTexture(url) {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(url, (t) => {
            if (this._disposed) return;
            t.colorSpace = THREE.SRGBColorSpace;
            this.moonUniforms.uSurface.value = t;
            this.moonUniforms.uHasTex.value = 1;
            this.moonTextureReady = true;
        }, undefined, () => {});
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

        // Hover: the same ring, dimmer and in the population's own blue. A
        // hover affordance is what makes an 11 px dot on a black field look
        // like a control at all — the cursor alone cannot say it, because on
        // this page the whole canvas is also a camera drag target.
        this.hoverRing = new THREE.Mesh(
            new THREE.RingGeometry(0.16, 0.185, 40),
            new THREE.MeshBasicMaterial({
                color: 0x9fc6ff, transparent: true, opacity: 0.5,
                side: THREE.DoubleSide, depthTest: false,
            }),
        );
        this.hoverRing.visible = false;
        this.hoverRing.renderOrder = 14;
        this.scene.add(this.hoverRing);

        // Names on the nearest few. Without them the stage is a field of
        // identical dots and the only way to learn what anything IS is to
        // sweep the cursor over it and hope — the findability failure
        // mars.html's feature index was built to fix, in 3D.
        this.nearLabels = [];
        for (let i = 0; i < NEAR_LABELS; i++) this.nearLabels.push({ sprite: null, name: null });
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
        this.globeUniforms.uSunWorld.value.copy(this._sunDir);
        this.atmoUniforms.uSunWorld.value.copy(this._sunDir);
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
        // No scale term: the geometry is already `bodySceneRadius(MOON_RADIUS_KM)`
        // and it stays that in both display modes. See _buildMoon.

        // The phase is not drawn — it is the Sun direction, which the whole
        // stage already shares. Earthshine points back at the drawn Earth.
        this.moonUniforms.uSunWorld.value.copy(this._sunDir);
        this.moonUniforms.uEarthDir.value.copy(this.moon.position).negate().normalize();

        this.phase = moonPhase(jd);
        const label = `Moon · ${Math.round(this.phase.distKm).toLocaleString('en-US')} km · ${Math.round(this.phase.illuminated * 100)}% ${this.phase.waxing ? 'waxing' : 'waning'}`;
        if (this._moonLabelText !== label) {
            this._moonLabelText = label;
            this.scene.remove(this.moonLabel);
            this.moonLabel = labelSprite(label, '#d8d5cc', 0.85);
            this.scene.add(this.moonLabel);
        }
        this.moonLabel.position.copy(this.moon.position)
            .add(new THREE.Vector3(0, bodySceneRadius(MOON_RADIUS_KM) * 1.9, 0));

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
        const pts = moonPath(jd, 128).map((m) => {
            const q = geoToScene(m.x, m.y, m.z, { trueScale: this.trueScale });
            return new THREE.Vector3(q.x, q.y, q.z);
        });
        this.moonOrbit.geometry.dispose();
        this.moonOrbit.geometry = new THREE.BufferGeometry().setFromPoints(pts);

        // Apsides of the orbit the Moon is on NOW — refined by the kernel from
        // the same distance curve this path was sampled from.
        this.apsides = moonApsides(jd);
        for (const id of ['perigee', 'apogee']) {
            const a = this.apsides[id];
            const mark = this.apsisMarks[id];
            if (!a) { mark.dot.visible = mark.label.visible = false; continue; }
            const g = moonGeoJ2000(a.jd);
            const q = geoToScene(g.x, g.y, g.z, { trueScale: this.trueScale });
            mark.dot.position.set(q.x, q.y, q.z);
            mark.dot.visible = true;
            const text = `${id} ${Math.round(a.km).toLocaleString('en-US')} km`;
            if (mark.text !== text) {
                mark.text = text;
                this.scene.remove(mark.label);
                mark.label = labelSprite(text, id === 'perigee' ? '#ffb05c' : '#9fb0cc', 0.75);
                this.scene.add(mark.label);
            }
            mark.label.position.set(q.x, q.y, q.z);
            mark.label.visible = true;
        }
    }

    /**
     * The live radius of one shell. The gravity boundaries move with Earth's
     * own heliocentric distance — 3.3 % over a year — so their table entry is a
     * nominal value and the real one is computed per frame. Everything else is
     * a fixed distance and returns its own number.
     */
    _shellKm(spec, earthRAU) {
        if (spec.dynamic === 'hill') return hillRadiusKm(earthRAU);
        if (spec.dynamic === 'soi') return soiRadiusKm(earthRAU);
        return spec.km;
    }

    _placeShells() {
        const earthRAU = earthHelioJ2000(this.jd).rAU;
        for (let i = 0; i < this.shells.length; i++) {
            const sh = this.shells[i];
            sh.km = this._shellKm(sh.spec, earthRAU);
            const r = this.trueScale ? trueSceneRadius(sh.km) : geoSceneRadius(sh.km);
            const inView = sh.km <= this.horizonKm * 1.35;
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
        // Room for `frameAll` to actually fit the outer ring: on a PORTRAIT
        // viewport the binding half-angle is the horizontal one, and the
        // distance that fits a given radius grows as 1/aspect. 3.2× was enough
        // for the camera the page booted with and not for the one that fits.
        this.controls.maxDistance = Math.max(50, outer * 6);
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
        // The Moon's path and its apsis marks are cached against a radial map;
        // changing the map invalidates them, and the 0.05 d throttle in
        // _placeMoonOrbit would otherwise hold the old geometry indefinitely.
        this._moonOrbitJd = null;
        this._applyRange();
        const outer = this._outerRadius();
        this.camera.position.normalize()
            .multiplyScalar(Math.min(this._distanceToFit(outer), this.controls.maxDistance));
        this.setEpoch(this.jd);
        this._refreshPopulation();
    }

    setHorizon(km) {
        this.horizonKm = km;
        this._moonOrbitJd = null;
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
    /**
     * Camera distance that puts a sphere of radius `r` about the origin inside
     * the frame, with a little margin.
     *
     * DERIVED, never a hand-tuned multiple of the radius. `frameAll` used to
     * sit at 1.15 × outer, which with a 45° vertical field shows the inner
     * 48 % of the radius and CUTS OFF the outer ring the button is named
     * after — measured: at the 0.5 AU horizon an object 3 LD out projected to
     * y = −58 on an 806 × 446 canvas, i.e. above the top edge, while the stage
     * reported it as drawn. It looked like a picking failure and was not.
     *
     * The binding constraint is the SMALLER half-angle: vertical on a wide
     * canvas, horizontal on a narrow one (tan(h/2) = aspect · tan(v/2)), which
     * is why the phone case cannot be read off the desktop one.
     */
    _distanceToFit(r, margin = 1.08) {
        const halfV = Math.tan((this.camera.fov * Math.PI / 180) / 2);
        const half = halfV * Math.min(1, this.camera.aspect || 1);
        return (r * margin) / Math.max(1e-6, half);
    }

    frameAll() {
        const outer = this._outerRadius();
        this.controls.target.set(0, 0, 0);
        this.camera.position.set(0.62, 0.42, 0.66).normalize()
            .multiplyScalar(Math.min(this._distanceToFit(outer), this.controls.maxDistance));
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
        if (Number.isInteger(this.selected) && this.rGeo && this.selected < this.count) want.push(this.selected);
        const sorted = [...this._visible].sort((a, b) => this.rGeo[a] - this.rGeo[b]);
        this._refreshNearLabels(sorted);
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

    /**
     * Name the nearest few objects on the stage itself.
     *
     * Only objects we HAVE metadata for get a label — the tier ladder fetches
     * names for the objects the page cares about, and an unnamed one would be
     * labelled with its buffer index, which tells the viewer nothing and costs
     * a canvas texture to say it. A sprite is rebuilt only when its text
     * changes (the selLabel pattern): at 3 Hz, rebuilding five canvases a
     * refresh is five textures a second for text that almost never moves.
     */
    _refreshNearLabels(sorted) {
        let slot = 0;
        for (const k of sorted) {
            if (slot >= this.nearLabels.length) break;
            const meta = this.meta.get(k);
            const name = meta?.name || meta?.des;
            if (!name) continue;
            // The selection carries its own label; two on one dot is the word
            // twice, offset by a pixel.
            if (k === this.selected) continue;
            const entry = this.nearLabels[slot];
            if (entry.name !== name) {
                if (entry.sprite) {
                    this.scene.remove(entry.sprite);
                    entry.sprite.material.map.dispose();
                    entry.sprite.material.dispose();
                }
                entry.sprite = labelSprite(name, '#c8d8f2', 0.82);
                entry.name = name;
                this.scene.add(entry.sprite);
            }
            const o = k * 3;
            const p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
            // Above the dot, not on it: a label centred on an 11 px sprite
            // hides the thing it names.
            entry.sprite.position.set(p.x, p.y, p.z);
            entry.sprite.center.set(0.5, -0.35);
            entry.sprite.visible = true;
            slot++;
        }
        for (let i = slot; i < this.nearLabels.length; i++) {
            if (this.nearLabels[i].sprite) this.nearLabels[i].sprite.visible = false;
        }
    }

    /**
     * Selection ring + label follow the selection, which is either a catalogue
     * INDEX or the string 'moon'. The Moon is not in the catalogue — it is not
     * a small body — so it gets its own branch rather than a sentinel index
     * that would index into the population arrays as NaN.
     */
    _placeSelection() {
        const k = this.selected;
        if (k === 'moon') {
            this.selRing.position.copy(this.moon.position);
            this.selRing.visible = true;
            if (this._selName !== 'Moon') {
                this.scene.remove(this.selLabel);
                this.selLabel = labelSprite('Moon', '#ffffff', 1);
                this.scene.add(this.selLabel);
                this._selName = 'Moon';
            }
            // The Moon carries its own live label already; a second one on top
            // of it would just be the word twice.
            this.selLabel.visible = false;
            return;
        }
        if (k == null || !this.geo || !Number.isInteger(k) || k >= this.count) {
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
        let p;
        if (this.selected === 'moon') {
            p = this.moon.position;
        } else if (Number.isInteger(this.selected) && this.geo) {
            const o = this.selected * 3;
            p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
        } else {
            return;
        }
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
    //
    // PICKING IS DONE IN SCREEN SPACE, and that is the whole fix.
    //
    // three's Points raycaster takes ONE threshold in WORLD units, but these
    // dots are drawn with `sizeAttenuation: false` — a constant 11 px whatever
    // their distance. The two have no relationship, so a fixed world threshold
    // is a different hit radius at every zoom: measured at ~7 px on the default
    // camera, ~64 px zoomed to Earth, and 0.016 px in TRUE SCALE, where nothing
    // could be selected at all. Projecting the candidates to the screen and
    // taking the nearest within a pixel radius is exact, matches what the user
    // can actually see, and costs one projection per visible object — a few
    // hundred, once per click or hover frame.
    //
    // The radius is bigger for touch than for a mouse because a fingertip is
    // bigger than a cursor; 44 px is the repo's standing touch-target floor
    // (js/nav.js and tests/nav-responsive.spec.js use the same number).

    /** Screen-space pick radius, CSS pixels. */
    _pickRadius(pointerType) {
        return pointerType === 'touch' ? 44 : 14;
    }

    /**
     * Nearest selectable thing to a client point, or null.
     * Returns { sel, distPx } where `sel` is a catalogue index or 'moon'.
     */
    pickAt(clientX, clientY, pointerType = 'mouse') {
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const px = clientX - rect.left, py = clientY - rect.top;
        const maxPx = this._pickRadius(pointerType);

        const v = new THREE.Vector3();
        const toScreen = (x, y, z) => {
            v.set(x, y, z).project(this.camera);
            // Behind the camera: project() flips the sign, so a point behind
            // would otherwise land on screen as a mirrored ghost.
            if (v.z > 1) return null;
            return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
        };

        let best = null;
        const consider = (sel, sx, sy) => {
            const d = Math.hypot(sx - px, sy - py);
            if (d <= maxPx && (!best || d < best.distPx)) best = { sel, distPx: d };
        };

        // The Moon is a real sphere, so its own silhouette is the hit area when
        // the cursor is inside it — but it also stays pickable as a point when
        // it is only a few pixels across.
        const m = this.moon.position;
        const ms = toScreen(m.x, m.y, m.z);
        if (ms) consider('moon', ms.x, ms.y);

        // Population.
        if (this.geo && this._visible.length) {
            const pos = this.popGeom.attributes.position.array;
            for (let j = 0; j < this._visible.length; j++) {
                const o = j * 3;
                const sp = toScreen(pos[o], pos[o + 1], pos[o + 2]);
                if (sp) consider(this._visible[j], sp.x, sp.y);
            }
        }
        return best;
    }

    _clientToCanvas(ev) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    /**
     * A TAP is a pointerup near where the pointerdown landed, soon after it.
     * Without this test every camera drag ends in a `click` and clears or
     * changes the selection — which on a page whose whole surface is a drag
     * target reads as the selection randomly resetting itself.
     *
     * The clock is `event.timeStamp`, not `performance.now()`: same origin, but
     * timeStamp is when the browser GENERATED the event while performance.now()
     * in the handler is when it finally ran, and on a frame where this page is
     * rebuilding thousands of positions that lag is hundreds of milliseconds.
     * mars.html measured a genuine quick double-tap at 914 ms by handler clock;
     * the same trap applies to a single tap's time budget.
     */
    _onPointerDown(ev) {
        this._down = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp, id: ev.pointerId, type: ev.pointerType };
    }

    _onPointerUp(ev) {
        const d = this._down;
        this._down = null;
        if (!d || d.id !== ev.pointerId) return;
        const moved = Math.hypot(ev.clientX - d.x, ev.clientY - d.y);
        const elapsed = ev.timeStamp - d.t;
        // Touch slop is larger: a finger always moves a little.
        const slop = d.type === 'touch' ? 14 : 6;
        if (moved > slop || elapsed > TAP_MAX_MS) return;         // a drag, not a tap
        const hit = this.pickAt(ev.clientX, ev.clientY, d.type);
        this.onPick(hit ? hit.sel : null);
    }

    _onPointerMove(ev) {
        // Hover is a mouse affordance. A touch pointer dragging the camera must
        // not leave a hover highlight behind it.
        if (ev.pointerType === 'touch') return;
        this._hoverClient = { x: ev.clientX, y: ev.clientY };
        this._hoverDirty = true;
    }

    _onPointerLeave() {
        this._hoverClient = null;
        this._hoverDirty = true;
    }

    /**
     * Resolve the hover at most `HOVER_HZ` times a second, from the render
     * loop rather than the event. pointermove fires far faster than the scene
     * changes, and each resolution projects every visible object.
     */
    _updateHover(now) {
        if (!this._hoverDirty && now - (this._hoverAt || 0) < 1000 / HOVER_HZ) return;
        this._hoverAt = now;
        this._hoverDirty = false;
        const c = this._hoverClient;
        const hit = c ? this.pickAt(c.x, c.y, 'mouse') : null;
        const sel = hit ? hit.sel : null;
        if (sel !== this.hovered) {
            this.hovered = sel;
            this.canvas.style.cursor = sel != null ? 'pointer' : '';
            this.onHover(sel, c);
        }
        this._placeHoverRing();
    }

    /** The hover ring follows whatever is under the cursor. */
    _placeHoverRing() {
        const k = this.hovered;
        const p = this._selectionPoint(k);
        if (!p) { this.hoverRing.visible = false; return; }
        this.hoverRing.position.copy(p);
        this.hoverRing.visible = true;
    }

    /** Scene position of a selection token ('moon' or a catalogue index). */
    _selectionPoint(sel, out = new THREE.Vector3()) {
        if (sel === 'moon') return out.copy(this.moon.position);
        if (!Number.isInteger(sel) || !this.geo || sel >= this.count) return null;
        const o = sel * 3;
        const p = geoToScene(this.geo[o], this.geo[o + 1], this.geo[o + 2], { trueScale: this.trueScale });
        return out.set(p.x, p.y, p.z);
    }

    /** Where a selection token sits on screen, for a DOM tooltip. null if off-screen. */
    screenPositionOf(sel) {
        const p = this._selectionPoint(sel);
        if (!p) return null;
        const rect = this.canvas.getBoundingClientRect();
        const v = p.clone().project(this.camera);
        if (v.z > 1) return null;
        return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
    }

    // ── Frame ───────────────────────────────────────────────────────────────

    resize() {
        const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(1, h);
        this.camera.updateProjectionMatrix();
        // Deliberately does NOT re-frame: `_distanceToFit` depends on the
        // aspect, but moving the camera on every resize would fight the user's
        // own framing. Frame All is a button for that reason.
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
        // Hover is resolved HERE, not in the pointermove handler: pointermove
        // fires far faster than the scene changes, and each resolution
        // projects every visible object. Running it from the frame also means
        // the ring keeps following an object that is MOVING under a still
        // cursor, which is most of what happens on this page at warp.
        this._updateHover(performance.now());
        if (this.hoverRing.visible) {
            this.hoverRing.quaternion.copy(this.camera.quaternion);
            this.hoverRing.scale.setScalar(Math.max(0.3, camDist * 0.046));
        }
        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        this._disposed = true;
        for (const [type, fn] of this._listeners) this.canvas.removeEventListener(type, fn);
        this.controls.dispose();
        this.renderer.dispose();
    }
}

export default NeoStage;
