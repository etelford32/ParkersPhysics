/**
 * hero-space-weather.js  —  cinematic live-data hero scene for index.html
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders Earth + the live magnetosphere into the landing hero canvas, driven
 * by real NOAA SWPC data. This is the first thing a visitor sees — it IS the
 * product demo, so it leans on the same tricks the paid sims use:
 *
 *   • Shader Earth — procedural continents, day/night terminator, night-side
 *     city lights, drifting cloud shell, atmospheric Fresnel rim
 *   • MagnetosphereEngine — Shue magnetopause, bow shock, belts, plasmasphere,
 *     GLSL aurora curtains, dayside reconnection. The engine gets the FULL
 *     live state every frame via tick(t, sunDir, state, dt) — do not drop the
 *     state argument again: without it the curtains/reconnection/sheath run
 *     at quiet-time defaults and the hero stops reacting to storms.
 *   • Solar-wind particles that DEFLECT around the bow shock (Shue boundary
 *     from engine.analysis) and heat up in the magnetosheath — the "shield
 *     doing its job" money shot. Particle colour follows IMF Bz.
 *   • Deep field — fbm nebula on a BackSide shell inside the stars (the
 *     'intergalactic' backdrop). Second rung of the perf ladder.
 *   • Bloom — UnrealBloomPass composited as an additive overlay on top of the
 *     untouched base frame. Same pattern (and same reason) as
 *     ring-current-globe.js: the composer's own to-screen path clears the
 *     canvas through an opaque blit. Opt out with ?bloom=0.
 *   • CME-inbound cue — pulsing sunward glow whenever the feed carries an
 *     earth-directed CME with an ETA.
 *   • Perf guards — real frame clock, RAF fully parked when the tab is hidden
 *     or the hero is scrolled away (IntersectionObserver), and a one-way
 *     degradation ladder (drop bloom, then the deep field, then halve particles) on slow devices.
 *   • THE STAGE (2026-09-20) — Earth is FRAMED INTO A DOM BOX. index.html
 *     passes `stage: #hero-stage` (an empty element: the right column of
 *     the split hero on wide screens, a short band between the copy and
 *     the console on phones). `_updateFraming()` measures that box against
 *     the canvas on every resize and solves the camera for it: the field of
 *     view so Earth's disc is STAGE_DISC_FRAC of the box's short side (a
 *     telephoto zoom, NOT a closer camera — the camera stays at ~12 R_E,
 *     outside the shells it would otherwise clip through), and a look-at
 *     offset so the disc lands at the box's centre in NDC. Before this the
 *     camera panned Earth 3.2 units right on any widescreen and hoped the
 *     console missed it; it did not — Earth sat at ~85 px radius half under
 *     the Air Quality card. Without a stage the scene centres at 50°, the
 *     old behaviour.
 *   • CORRIDOR FRAMING (2026-09-21) — `js/hero-rope-layer.js` draws the
 *     shared provider's CME flux-rope train between a drawn Sun at
 *     CORRIDOR_SUN_RE and Earth, and owns the τ scrubber under the stage.
 *     While the visitor scrubs or plays the transit, `setFraming('corridor')`
 *     eases the camera OUT (fov, distance, elevation and the aim point all
 *     ride one `_mix` on an e-folding TIME, never a per-frame fraction) so
 *     the Sun→Earth segment fills the stage box; it eases back to the Earth
 *     shot when they let go. Both solves live in `_updateFraming()`.
 *   • STORM-DRIVEN REVEAL (2026-09-21) — on a quiet day the belts, the
 *     plasmasphere, the sheath glow and the reconnection line are OFF: the
 *     resting shot is Earth, its aurora and its shield. They come on when
 *     the storm norm crosses REVEAL_ON (hysteresis to REVEAL_OFF) — from the
 *     live feed, or from the rope layer's modeled conditions at the
 *     scrubbed τ (`conditionsAt`: the model's own L1 driver through the
 *     ring-current page's Dst integrator). While the corridor is up the
 *     engine runs on THAT state, so the magnetosphere compresses, the ring
 *     current fills and the oval expands as the rope arrives; when the
 *     visitor lets go the live state is restored. The engine's response is
 *     its own — this file only decides which state it sees.
 *   • The camera SWAYS, it does not orbit. The old 1.2°/s orbit carried the
 *     Sun from screen-left to screen-right every 2.5 min, so "the sunlit
 *     limb faces the copy" could not be a property of the layout. The
 *     azimuth is now CAM_AZIMUTH ± CAM_SWAY_DEG: with the Sun at +x and the
 *     camera at negative z, screen-right is (sin θ, 0, −cos θ) and the Sun
 *     projects LEFT — toward the copy — with the tail receding right.
 *   • THE ENTRANCE (2026-09-23) — the load used to be: empty stage for a
 *     beat, a main-thread freeze while every program compiled on frame one,
 *     then the finished scene CUT in over the CSS backdrop (and, because the
 *     buffer was never resized when the hero grew, as an oval — see
 *     _onResize). Now: index.html shows a boot reticle in the stage (CSS,
 *     compositor-only), `_boot()` warms every program (`_compileAsync`)
 *     while the canvas is at opacity 0, and the second frame (the first is
 *     presented by then) sets `hero-live` on #hero so the canvas CROSSFADES
 *     in and the reticle locks and dissolves. The camera then settles over INTRO_S of WALL clock
 *     from a sunrise pose — over the night side, higher, zoomed out — so
 *     the lit limb grows from a crescent into the resting gibbous while
 *     Earth grows into the reticle; the stars ignite, the solar wind
 *     ARRIVES from the Sun as a front (the same stream laid out upstream,
 *     not a separate effect), breaks on the bow shock, and the aurora
 *     curtains RISE to their Kp-driven level (engine `setAuroraRise`) as it
 *     reaches Earth. Every term ends on the live state; nothing is faked
 *     (no substorm flash the feed did not report). `hero-intro-done` fires
 *     when it has settled — index.html holds the two demo iframes until
 *     then. `?intro=0` (or `intro: false`) starts settled.
 *
 * Graceful fallback: any WebGL failure hides the canvas; the CSS gradient
 * backdrop in index.html remains and the live ticker/HUD stay functional.
 *
 * Usage (unchanged public API):
 *   import { HeroSpaceWeather } from './js/hero-space-weather.js';
 *   new HeroSpaceWeather(canvas).start();
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { MagnetosphereEngine } from './magnetosphere-engine.js';

const DEG = Math.PI / 180;

// Sun direction in world space — slightly tilted off the equatorial plane.
// The engine's _solarGroup +Y axis tracks this each tick.
const SUN_DIR = new THREE.Vector3(1, 0.12, -0.08).normalize();

// Camera azimuth about +y (radians, measured from +x toward +z). Negative z
// puts the Sun screen-LEFT (see the header). The elevation is the old
// vantage's (asin(3.0/12.3)); the sway keeps the framing stable enough that
// the stage's look-at solve is exact at the mean and ~1% off at the extremes.
const CAM_AZIMUTH   = -Math.atan2(10.4, 5.2);   // −63.4°
const CAM_SWAY_DEG  = 7;
const CAM_SWAY_RATE = 0.07;                     // rad/s of the sway phase
// Earth's projected radius as a fraction of the stage box's SHORT side:
// 0.30 leaves the 1.85 R_E aurora curtains and the 1.2 R_E limb glow inside
// the box. At the 1440×900 split layout (640 px box) this is ~190 px, 2.2×
// the old ~85 px; the 250 px phone band lands ~75 px inside the fov clamp.
const STAGE_DISC_FRAC = 0.30;
const FOV_MIN = 16, FOV_MAX = 72, FOV_DEFAULT = 50;
// Corridor framing: the Sun→Earth segment (hero-rope-layer CORRIDOR_SUN_RE
// long) fills CORRIDOR_SPAN_FRAC of the stage's width at CORRIDOR_FOV, from
// a higher vantage so the rope's arc reads. The aim point sits between the
// two bodies, biased toward Earth so the magnetotail has room.
const CORRIDOR_FOV = 34, CORRIDOR_SPAN_FRAC = 0.62, CORRIDOR_ELEV = 26 * DEG;
const CORRIDOR_AIM_FRAC = 0.50;      // of the Sun→Earth segment, from Earth
const FRAMING_TAU_S = 0.55;          // e-folding time of the framing ease
// Storm reveal thresholds on the storm norm (storm_level/5 + 0.3·kp_norm):
// G1 with Kp 5 lands at ~0.37, a quiet Kp 2 day at ~0.07.
const REVEAL_ON = 0.24, REVEAL_OFF = 0.12;
const REVEAL_LAYERS = ['belts', 'plasmasphere', 'magnetosheath', 'reconnection'];
const COND_HZ = 4;                   // how often the scrubbed state is pushed to the engine

// ── The entrance (2026-09-23) — see the header's ENTRANCE bullet ────────────
// Everything here is PRESENTATION and ends on the live state exactly: the
// camera settles onto the resting framing, the stars and aurora come up to
// the level the feed drives, the wind stream becomes the steady stream. No
// data is faked on the way (the aurora RISES to its Kp-driven level; it is
// never flashed as a substorm the feed did not report).
const INTRO_S        = 4.6;   // camera settle (s of wall clock, not frames)
const INTRO_ARC_DEG  = -72;   // azimuth offset at t=0: from over the night side,
                              // so the lit limb grows crescent → gibbous (a sunrise)
const INTRO_ELEV_DEG = 16;    // extra elevation at t=0 — descends onto the rest vantage
const INTRO_ZOOM     = 1.55;  // fov multiplier at t=0 (Earth ~0.64× its resting disc)
const INTRO_FOV_MAX  = 80;    // the zoom never widens past this (phone bands sit near FOV_MAX)
const INTRO_STARS_S  = 1.8;   // stars ignite, staggered, over this long
const INTRO_AURORA   = [1.4, 3.4];   // s: curtains rise from the ground as the wind front arrives
const SPAWN_R        = 27;    // solar-wind spawn plane, R_E sunward of Earth
const WIND_PATH      = 57;    // spawn plane → tail respawn (27 + 30): the stream's length
const BOOT_WARM_CAP_MS = 2500;

// ── Shared GLSL noise (value noise + fbm), prepended to shaders that need it ──
const GLSL_NOISE = /* glsl */`
    float hash13(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float vnoise3(vec3 p){
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash13(i);
        float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
        return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    }
    float fbm3(vec3 p){
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 5; i++){ s += a * vnoise3(p); p *= 2.03; a *= 0.5; }
        return s;
    }
`;

// ── Earth surface shader ──────────────────────────────────────────────────────
const EARTH_VERT = /* glsl */`
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    void main(){
        vObj = position;
        vWN  = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

const EARTH_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_sun;
    uniform float u_time;
    uniform float u_storm;   // 0 quiet → 1 extreme; warms the rim + terminator
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    ${GLSL_NOISE}
    void main(){
        // Continents from object-space fbm — rotate with the mesh.
        float c    = fbm3(vObj * 2.3 + 17.0);
        float land = smoothstep(0.50, 0.56, c);
        float terr = fbm3(vObj * 5.1 + 4.0);

        vec3 ocean   = mix(vec3(0.016, 0.075, 0.195), vec3(0.03, 0.13, 0.30), terr);
        vec3 lowland = vec3(0.075, 0.16, 0.09);
        vec3 highland= vec3(0.24, 0.20, 0.13);
        vec3 albedo  = mix(ocean, mix(lowland, highland, smoothstep(0.4, 0.75, terr)), land);

        float day  = dot(vWN, u_sun);
        float dayW = clamp(day, 0.0, 1.0);
        vec3 col = albedo * (0.14 + 1.45 * dayW)
                 + albedo * vec3(0.05, 0.09, 0.18) * (1.0 - dayW);   // moonlit night blue

        // Ocean sun glint
        vec3 V = normalize(cameraPosition - vWP);
        vec3 H = normalize(u_sun + V);
        // 0.40, was 0.75: at the stage's telephoto framing the old level plus
        // bloom read as a white ball, not a glint.
        col += vec3(1.0, 0.92, 0.75) * pow(max(dot(vWN, H), 0.0), 90.0) * (1.0 - land) * dayW * 0.40;

        // Night-side city lights, clustered on land
        float clusters = smoothstep(0.35, 0.75, fbm3(vObj * 6.0 + 3.0));
        float cities   = smoothstep(0.70, 0.88, vnoise3(vObj * 26.0)) * land * clusters;
        float flick    = 0.85 + 0.30 * vnoise3(vObj * 40.0 + u_time * 0.55);
        col += vec3(1.0, 0.62, 0.30) * cities * pow(1.0 - dayW, 2.0) * flick * 1.35;

        // Terminator warmth — a little stronger during storms
        float term = smoothstep(0.16, 0.02, abs(day));
        col += vec3(1.0, 0.42, 0.24) * term * (0.08 + 0.06 * u_storm);

        // Atmospheric Fresnel rim
        float fr = pow(1.0 - max(dot(vWN, V), 0.0), 2.6);
        col += mix(vec3(0.22, 0.48, 1.0), vec3(0.55, 0.35, 1.0), u_storm * 0.6) * fr * 0.55;

        gl_FragColor = vec4(col, 1.0);
    }
`;

// ── Cloud shell shader ────────────────────────────────────────────────────────
const CLOUD_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_sun;
    uniform float u_time;
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    ${GLSL_NOISE}
    void main(){
        float d = fbm3(vObj * 3.4 + vec3(u_time * 0.006, 0.0, u_time * 0.003));
        float a = smoothstep(0.52, 0.74, d) * 0.34;
        float dayW = clamp(dot(vWN, u_sun), 0.0, 1.0);
        a *= 0.22 + 0.85 * dayW;
        gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), a);
    }
`;

// ── Atmosphere scattering shell ───────────────────────────────────────────────
// The glow is a function of the view ray's IMPACT PARAMETER b (its closest
// approach to Earth's centre), not of the shell's own Fresnel rim. The rim
// version (2026-09-21) peaked twice — at Earth's limb (the surface shader's
// own Fresnel term) and again at the shell's silhouette 7.5% further out —
// so the night limb read as TWO rings with a dark gap (visible at the
// stage's telephoto framing). Here the column is an exponential atmosphere
// seen edge-on: off the disc it falls as exp(−(b−1)/H), on the disc it is
// the slant path H/μ down to the surface, the two meeting at the limb. At the
// shell's radius the column is e^−3.75 of the limb value, so the mesh edge is
// never the visual edge (the SOLAR_SYSTEM_VISUAL_REVIEW S3 lesson). H is a
// DISPLAY scale height (~15× the real 8 km) — a true-scale atmosphere is a
// hairline at this framing.
const ATMO_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_sun;
    uniform float u_storm;
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    const float H_LIMB = 0.020;   // off-disc falloff (R_E)
    const float H_DISC = 0.085;   // on-disc haze: column H/μ, capped at the limb value
    void main(){
        vec3 V = normalize(vWP - cameraPosition);            // along the ray
        vec3 Q = cameraPosition - dot(cameraPosition, V) * V; // closest approach (Earth at origin)
        float b = length(Q);
        float col;
        vec3  N;                                             // where the light scatters
        if (b >= 1.0) {
            col = exp(-(b - 1.0) / H_LIMB);
            N = Q / b;
        } else {
            float mu = sqrt(1.0 - b * b);                    // cos zenith at the surface hit
            col = min(1.0, H_DISC / max(mu, 1e-3));
            N = normalize(cameraPosition + (dot(-cameraPosition, V) - mu) * V);
        }
        float day  = dot(N, u_sun);
        float lit  = smoothstep(-0.25, 0.35, day);
        // Path-length colour: blue where the Sun is high, orange along the
        // terminator, a dim teal airglow on the night side.
        vec3 blue   = vec3(0.30, 0.58, 1.00);
        vec3 orange = vec3(1.00, 0.46, 0.18);
        vec3 night  = vec3(0.05, 0.16, 0.24);
        float term  = smoothstep(0.30, 0.0, abs(day)) * (1.0 - smoothstep(0.0, 0.5, day) * 0.6);
        vec3 c = mix(night, blue, lit);
        c = mix(c, orange, term * 0.85);
        c = mix(c, vec3(0.62, 0.40, 1.0), u_storm * 0.35 * col);
        float a = col * (0.30 + 1.05 * lit);
        gl_FragColor = vec4(c * a, a);
    }
`;

// ── Twinkling star shader ─────────────────────────────────────────────────────
const STAR_VERT = /* glsl */`
    attribute float aSize;
    attribute float aPhase;
    attribute vec3  aTint;
    uniform float u_time;
    uniform float u_ignite;   // entrance: 0 → 1, each star switches on at its own phase
    varying float vTw;
    varying vec3  vC;
    void main(){
        vC  = aTint;
        vTw = 0.62 + 0.38 * sin(u_time * (0.4 + aPhase * 1.8) + aPhase * 21.0);
        vTw *= smoothstep(aPhase * 0.75, aPhase * 0.75 + 0.25, u_ignite);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (170.0 / -mv.z);
        gl_Position  = projectionMatrix * mv;
    }
`;
const STAR_FRAG = /* glsl */`
    precision highp float;
    varying float vTw;
    varying vec3  vC;
    void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.15, d) * vTw;
        gl_FragColor = vec4(vC, a * 0.9);
    }
`;

// ── Solar-wind particle shader ────────────────────────────────────────────────
const WIND_VERT = /* glsl */`
    attribute float aSeed;
    attribute float aHeat;
    uniform float u_size;
    varying float vHeat;
    void main(){
        vHeat = aHeat;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = u_size * (0.75 + 0.7 * aSeed) * (1.0 + 0.9 * aHeat);
        gl_PointSize = s * (150.0 / -mv.z);
        gl_Position  = projectionMatrix * mv;
    }
`;
const WIND_FRAG = /* glsl */`
    precision highp float;
    uniform vec3 u_cold;
    uniform vec3 u_hot;
    varying float vHeat;
    void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = smoothstep(1.0, 0.0, d);
        vec3  col  = mix(u_cold, u_hot, vHeat);
        float a    = core * core * (0.30 + 0.45 * vHeat);
        gl_FragColor = vec4(col, a);
    }
`;


// ── Deep field — the "intergalactic" backdrop (2026-09) ─────────────────────
// A BackSide sphere just inside the star shell carrying an fbm nebula: two
// cool bands (UV violet / teal) with a faint magenta rim, drifting on a
// ~minute-scale clock. Additive and dim on purpose — it has to sit UNDER the
// H1 and the email capture without competing with them; the #hero::after
// scrim in index.html still paints above the whole canvas. It is the second
// rung of the perf ladder (after bloom) because it is a full-screen fbm.
const NEBULA_VERT = /* glsl */`
    varying vec3 vDir;
    void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const NEBULA_FRAG = /* glsl */`
    ${GLSL_NOISE}
    uniform float u_time;
    uniform float u_gain;
    varying vec3 vDir;
    void main(){
        vec3 d = vDir;
        float t = u_time * 0.006;
        // Domain warp so the bands curl instead of reading as static blobs.
        vec3 q = d * 2.2 + vec3(t, -t * 0.7, t * 0.4);
        float w = fbm3(q * 1.7 + 3.1);
        float n1 = fbm3(q + w * 0.9);
        float n2 = fbm3(q * 2.3 - w * 0.6 + vec3(7.0, 1.0, 3.0));
        // Two broad bands hugging a tilted "galactic" plane.
        float plane = abs(dot(d, normalize(vec3(0.25, 1.0, 0.35))));
        float band  = smoothstep(0.55, 0.0, plane);
        float violet = smoothstep(0.42, 0.78, n1) * band;
        float teal   = smoothstep(0.50, 0.85, n2) * (0.6 + 0.4 * band);
        float rim    = smoothstep(0.62, 0.9, n1 * n2 * 2.0) * band;
        vec3 col = vec3(0.30, 0.10, 0.55) * violet
                 + vec3(0.05, 0.32, 0.42) * teal
                 + vec3(0.55, 0.12, 0.40) * rim;
        // Keep the sunward side (particles + sun sprites) quieter.
        float sunside = smoothstep(-0.2, 0.9, d.x);
        col *= (1.0 - 0.45 * sunside);
        gl_FragColor = vec4(col * u_gain, 1.0);
    }
`;

export class HeroSpaceWeather {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object}            opts
     */
    constructor(canvas, opts = {}) {
        this._canvas = canvas;
        this._opts = {
            particleCount: window.innerWidth < 700 ? 1100 : 2400,
            stage: null,            // DOM box Earth is framed into (see header)
            ...opts,
        };
        // Framing solved from the stage box: Earth's NDC centre + vertical fov,
        // plus the corridor solve (fov/distance) the rope layer eases to.
        this._frame = { nx: 0, ny: 0, fov: FOV_DEFAULT, corrFov: CORRIDOR_FOV, corrDist: 0 };
        this._framingMode = 'earth';
        this._mix = 0;               // 0 = Earth shot, 1 = corridor
        this._corridorRe = 0;        // Sun→Earth segment length the rope layer draws
        this._state  = { solar_wind: { speed: 420, density: 5, bz: 0 }, kp: 2 };
        this._t      = 0;
        this._animId = null;
        this._stopped = false;
        this._visible = true;
        this._pageVisible = typeof document !== 'undefined' ? !document.hidden : true;
        this._lastStormLevel = 0;
        // Pointer parallax targets/current (world units)
        this._parTX = 0; this._parTY = 0; this._parX = 0; this._parY = 0;
        // One-way perf degradation ladder
        this._frameEma = 16; this._frameN = 0;
        // The entrance: wall-clock seconds since the first shown frame.
        // ?intro=0 starts settled (tests / debugging / a quick look).
        this._intro = this._opts.intro !== false
            && !/[?&]intro=0(?:&|$)/.test(typeof location !== 'undefined' ? location.search : '');
        this._introT = this._intro ? 0 : Math.max(INTRO_S, INTRO_AURORA[1]);
        this._framesDrawn = 0;
        this._introSettled = new Promise((r) => { this._resolveIntro = r; });
        // Offsets start at the entrance's t = 0 pose (or settled).
        const k0 = this._intro ? 1 : 0;
        this._introArc  = INTRO_ARC_DEG * DEG * k0;
        this._introElev = INTRO_ELEV_DEG * DEG * k0;
        this._introZoom = 1 + (INTRO_ZOOM - 1) * k0;
    }

    start() {
        try {
            this._initRenderer();
            this._initScene();
            this._initCamera();
            this._initLighting();
            this._initEarth();
            this._initDeepField();
            this._initStars();
            this._initSun();
            this._initCmeCue();
            this._initParticles();
            // Shorter aurora curtains than the earth.html default — this
            // camera is much closer and full-height funnels swallow the frame.
            // 1.85 → 1.32 (2026-09-23): 1.85 was chosen at the pre-stage
            // framing; the stage's 2.2× telephoto made the curtains two
            // hourglass beams taller than the planet. At 1.32 they read as a
            // crown on the oval (still ~6× the real ~300 km, on purpose).
            this._engine = new MagnetosphereEngine(this._scene, { auroraTop: 1.32 });
            this._engine.update(this._state);
            // The wireframe cusp cones read as clutter at this close camera.
            this._engine.setLayerVisible('cusps', false);
            // Storm-driven reveal: these start OFF and come on with activity
            // (live or scrubbed) — see the header.
            this._revealed = false;
            for (const l of REVEAL_LAYERS) this._engine.setLayerVisible(l, false);
            // The entrance raises the curtains from the ground (_stepIntro).
            if (this._intro) this._engine.setAuroraRise(0);
            this._initBloom(this._w(), this._h());
            this._initRopes();

            this._clock = new THREE.Clock();

            window.addEventListener('resize', this._onResize.bind(this), { passive: true });
            // The canvas and the stage box both change size without a window
            // resize (the console grows as feeds land, fonts swap, the grid
            // re-rows) — resize the buffer and re-solve the framing then too.
            // Observing the CANVAS is what keeps Earth round (see _onResize);
            // observing the stage catches a box that moves inside a canvas
            // that did not change.
            if ('ResizeObserver' in window) {
                const ro = new ResizeObserver(() => this._onResize());
                ro.observe(this._canvas);
                if (this._opts.stage) ro.observe(this._opts.stage);
            }
            window.addEventListener('swpc-update', (e) => {
                this._state = e.detail;
                this._engine.update(e.detail);
                this._updateFromState(e.detail);
            }, { passive: true });

            // Subtle parallax on fine pointers only — canvas keeps
            // pointer-events:none so page interactions are untouched.
            if (matchMedia('(pointer: fine)').matches) {
                window.addEventListener('pointermove', (e) => {
                    this._parTX = (e.clientX / window.innerWidth  - 0.5) *  2.4;
                    this._parTY = (e.clientY / window.innerHeight - 0.5) * -1.5;
                }, { passive: true });
            }

            // Park the render loop entirely when the hero can't be seen —
            // the attract iframe further down the page needs the GPU more.
            document.addEventListener('visibilitychange', () => {
                this._pageVisible = !document.hidden;
                this._maybeRun();
            });
            if ('IntersectionObserver' in window) {
                new IntersectionObserver(([entry]) => {
                    this._visible = entry.isIntersecting;
                    this._maybeRun();
                }, { threshold: 0.02 }).observe(this._canvas);
            }

            // Debug handle (same ?debug=1 convention as swpc-feed's fetch log)
            if (/[?&]debug=1(?:&|$)/.test(location.search)) window.__ppHero = this;

            // Nothing renders until the programs are warm (see _boot).
            this._boot();
        } catch (err) {
            // WebGL unavailable — canvas stays hidden, CSS backdrop shows instead
            console.warn('[HeroSpaceWeather] WebGL error:', err.message);
            if (this._canvas) this._canvas.style.display = 'none';
            this._setHostState('failed');
        }
    }

    // ── Boot: warm the GPU programs, THEN show the first frame ───────────────
    // The first render used to compile every program in the scene — ~20
    // materials, each twice (the screen frame and the bloom's render-target
    // frame are different program variants) plus the bloom chain's own —
    // synchronously, on the frame that also made the canvas visible: the
    // page froze, then the finished scene cut in over the CSS backdrop.
    // Now `_compileAsync` builds them all while the canvas is still at
    // opacity 0 and index.html's boot reticle spins on the COMPOSITOR thread
    // (transform/opacity only, so it keeps turning through any main-thread
    // stall); with KHR_parallel_shader_compile the compile does not block
    // at all. Capped: a driver that never reports ready must not strand the
    // hero, it only costs the old synchronous compile on frame one.
    async _boot() {
        try {
            await Promise.race([this._warmPrograms(), new Promise(r => setTimeout(r, BOOT_WARM_CAP_MS))]);
        } catch (e) {
            console.info('[HeroSpaceWeather] program warm-up skipped:', e?.message ?? e);
        }
        if (this._stopped) return;
        this._booted = true;
        this._maybeRun();
    }

    _warmPrograms() {
        const r = this._renderer, cam = this._camera;
        if (typeof r.compile !== 'function') return Promise.resolve();
        const jobs = [this._compileAsync(this._scene, cam)];
        if (this._bloomOn && this._bloom && this._rtScene) {
            // The program cache key depends on the CURRENT render target
            // (output colour space), so the scene is compiled again with the
            // bloom's source target bound, and the bloom chain's materials —
            // which never sit in the scene — on stand-in quads. _compileAsync
            // calls compile() synchronously before returning, so the target
            // can be restored straight after.
            const quad = new THREE.PlaneGeometry(2, 2);
            const post = new THREE.Scene();
            const b = this._bloom;
            for (const m of [b.materialHighPassFilter, ...(b.separableBlurMaterials ?? []), b.compositeMaterial, b.blendMaterial]) {
                if (m) post.add(new THREE.Mesh(quad, m));
            }
            const blit = new THREE.Scene();
            blit.add(new THREE.Mesh(quad, this._bloomBlit.material));
            const prev = r.getRenderTarget();
            r.setRenderTarget(this._rtScene);
            jobs.push(this._compileAsync(this._scene, cam), this._compileAsync(post, cam));
            r.setRenderTarget(prev);
            jobs.push(this._compileAsync(blit, cam));
        }
        return Promise.all(jobs);
    }

    /**
     * three r160's `compileAsync`, minus its failure mode here: it polls
     * `properties.get(m).currentProgram.isReady()` on a timer, and the
     * magnetosphere engine DISPOSES and rebuilds its shells on a Kp change
     * (or the first eased Shue step) — a disposed material has no program
     * and three's poll throws inside its own setTimeout, so the promise
     * never settles (measured: an uncaught "reading 'isReady'" TypeError
     * when a feed update landed mid-warm-up). `compile()` kicks the compile off
     * synchronously (non-blocking with KHR_parallel_shader_compile) and
     * returns the material set; a material with no program is treated as
     * done — it is gone, and its replacement compiles on first use.
     */
    _compileAsync(scene, cam) {
        const r = this._renderer;
        const mats = r.compile(scene, cam);
        if (!mats || typeof mats.forEach !== 'function' || !r.properties) return Promise.resolve();
        return new Promise((resolve) => {
            const poll = () => {
                mats.forEach((m) => {
                    const prog = r.properties.get(m)?.currentProgram;
                    if (!prog || typeof prog.isReady !== 'function' || prog.isReady()) mats.delete(m);
                });
                if (mats.size === 0 || this._stopped) resolve();
                else setTimeout(poll, 16);
            };
            poll();
        });
    }

    /**
     * Boot state on the host element (#hero) — index.html's CSS keys the
     * canvas crossfade and the boot reticle off these classes:
     *   'live'   frames are on the canvas → `hero-live` (canvas fades in,
     *            reticle locks and dissolves)
     *   'failed' WebGL/boot failure → the reticle goes; the CSS backdrop stays
     */
    _setHostState(state) {
        const host = this._opts.host ?? this._canvas?.parentElement;
        if (!host) return;
        host.classList.remove('hero-booting');
        if (state === 'live') host.classList.add('hero-live');
    }

    stop() {
        this._stopped = true;
        if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
    }

    _maybeRun() {
        const active = this._booted && !this._stopped && this._visible && this._pageVisible && !this._covered;
        if (active && !this._animId && this._renderer) {
            this._clock.getDelta();               // flush the paused interval
            this._animId = requestAnimationFrame(this._animate.bind(this));
        } else if (!active && this._animId) {
            cancelAnimationFrame(this._animId);
            this._animId = null;
        }
    }

    // ── Renderer ──────────────────────────────────────────────────────────────
    _initRenderer() {
        const r = new THREE.WebGLRenderer({
            canvas:    this._canvas,
            antialias: window.devicePixelRatio < 2,
            alpha:     false,   // opaque — scene provides its own background
            powerPreference: 'high-performance',
        });
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._sizeW = this._w(); this._sizeH = this._h();
        r.setSize(this._sizeW, this._sizeH, false);
        r.setClearColor(0x02010c, 1);
        r.sortObjects = true;
        this._renderer = r;
    }

    // ── Bloom overlay ─────────────────────────────────────────────────────────
    // Additive-composite pattern mirrored from ring-current-globe.js: base
    // frame renders untouched, then the blurred bright cores are ADDED on top.
    // EffectComposer is avoided deliberately — UnrealBloomPass's to-screen
    // path blits through an opaque material. Opt out with ?bloom=0.
    _initBloom(w, h) {
        const params = new URLSearchParams(location.search);
        this._bloomOn = params.get('bloom') !== '0' && w > 0 && h > 0;
        if (!this._bloomOn) return;
        try {
            this._bloom  = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.8, 0.5);
            this._rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
            const blit = new THREE.ShaderMaterial({
                uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
                vertexShader:   CopyShader.vertexShader,
                fragmentShader: CopyShader.fragmentShader,
                blending: THREE.AdditiveBlending,
                transparent: true, depthTest: false, depthWrite: false,
            });
            blit.uniforms.opacity.value = 1.0;
            this._bloomBlit = new FullScreenQuad(blit);
        } catch (e) {
            console.warn('[HeroSpaceWeather] bloom unavailable — rendering without glow:', e);
            this._bloomOn = false;
            this._bloom = null;
        }
    }

    // ── Scene ─────────────────────────────────────────────────────────────────
    _initScene() {
        this._scene = new THREE.Scene();
        // Subtle exponential fog fades the far magnetotail
        this._scene.fog = new THREE.FogExp2(0x02010c, 0.004);
    }

    // ── Camera ────────────────────────────────────────────────────────────────
    _initCamera() {
        const cam = new THREE.PerspectiveCamera(FOV_DEFAULT, this._w() / this._h(), 0.1, 700);
        // Day-side flank vantage at ~12.3 R_E — outside every shell the
        // engine draws — with the Sun screen-left so the lit hemisphere and
        // the compressed dayside magnetopause face the copy and the tail
        // recedes right. Size on screen is the stage's business (fov), not
        // the camera distance's.
        this._camR   = Math.hypot(5.2, 3.0, 10.4);
        this._camPhi = Math.asin(3.0 / this._camR);
        this._camTh  = CAM_AZIMUTH;
        cam.position.set(
            this._camR * Math.cos(this._camPhi) * Math.cos(this._camTh),
            this._camR * Math.sin(this._camPhi),
            this._camR * Math.cos(this._camPhi) * Math.sin(this._camTh));
        cam.lookAt(0, 0, 0);
        this._camera = cam;
        this._updateFraming();
    }

    /**
     * Solve fov + Earth's NDC centre from the stage box (see header). Cheap
     * (two getBoundingClientRect calls); runs on resize, not per frame.
     */
    _updateFraming() {
        const f = this._frame;
        const stage = this._opts.stage;
        const W = this._w(), H = this._h();
        if (!stage || !this._camera) { f.nx = 0; f.ny = 0; f.fov = FOV_DEFAULT; return; }
        const sr = stage.getBoundingClientRect();
        const cr = this._canvas.getBoundingClientRect();
        if (!(sr.width > 0 && sr.height > 0 && cr.width > 0 && cr.height > 0)) {
            f.nx = 0; f.ny = 0; f.fov = FOV_DEFAULT; return;
        }
        const cx = (sr.left + sr.width  / 2 - cr.left) / cr.width;
        const cy = (sr.top  + sr.height / 2 - cr.top)  / cr.height;
        f.nx = cx * 2 - 1;
        f.ny = 1 - cy * 2;
        // Radius on screen the box wants, then the vertical fov that gives it
        // for a unit sphere at the camera distance (small-angle-free).
        const rpx  = STAGE_DISC_FRAC * Math.min(sr.width, sr.height) * (H / cr.height);
        const tanA = Math.tan(Math.asin(Math.min(0.999, 1 / this._camR)));
        const tanV = (H / 2) * tanA / Math.max(1, rpx);
        f.fov = Math.min(FOV_MAX, Math.max(FOV_MIN, 2 * Math.atan(tanV) / DEG));
        // Publish the disc radius Earth will REST at, in CSS px, for the boot
        // reticle (index.html sizes it 2 × 1.14 × this). It is 0.30 of the
        // short side unless the fov clamp binds — on phones the hero canvas
        // is the whole tall stacked hero and FOV_MAX does bind, so the planet
        // lands ~1.4× bigger than the CSS-only guess; the reticle ranges out
        // to it instead of locking onto a ring Earth overshoots.
        const restR = (cr.height / 2) * tanA / Math.tan(f.fov * DEG / 2);
        if (Number.isFinite(restR) && restR > 0) stage.style.setProperty('--hero-disc-r', restR.toFixed(1) + 'px');
        // Corridor: distance at which the projected Sun→Earth segment spans
        // CORRIDOR_SPAN_FRAC of the box. The segment is foreshortened by the
        // sine of the angle between it and the view direction.
        const seg = this._corridorRe || 0;
        if (seg > 0) {
            const th = CAM_AZIMUTH, ph = CORRIDOR_ELEV;
            const vx = Math.cos(ph) * Math.cos(th), vy = Math.sin(ph), vz = Math.cos(ph) * Math.sin(th);
            const cosA = vx * SUN_DIR.x + vy * SUN_DIR.y + vz * SUN_DIR.z;
            const proj = seg * Math.sqrt(Math.max(0.05, 1 - cosA * cosA));
            const tanVc = Math.tan(CORRIDOR_FOV * DEG / 2);
            const tanHc = tanVc * (W / Math.max(1, H));
            const boxFrac = Math.max(0.15, sr.width / cr.width);
            f.corrDist = proj / (CORRIDOR_SPAN_FRAC * boxFrac * 2 * tanHc);
            f.corrFov = CORRIDOR_FOV;
        }
        this._applyFov();
        this._camera.aspect = W / Math.max(1, H);
        this._camera.updateProjectionMatrix();
    }

    /** The camera's fov for the current framing mix. */
    _applyFov() {
        const f = this._frame;
        const fov = f.fov + (f.corrFov - f.fov) * this._mix;
        const z = this._introZoom;
        this._camera.fov = z > 1 ? Math.min(INTRO_FOV_MAX, fov * z) : fov;
    }

    // ── Lighting ─────────────────────────────────────────────────────────────
    _initLighting() {
        // The Earth shader lights itself, but the engine's few Phong-free
        // additive materials don't need light; keep a dim ambient for safety.
        this._scene.add(new THREE.AmbientLight(0x0c1630, 1.2));
    }

    // ── Earth ─────────────────────────────────────────────────────────────────
    _initEarth() {
        this._earthU = {
            u_sun:   { value: SUN_DIR.clone() },
            u_time:  { value: 0 },
            u_storm: { value: 0 },
        };
        const earthMat = new THREE.ShaderMaterial({
            uniforms: this._earthU,
            vertexShader:   EARTH_VERT,
            fragmentShader: EARTH_FRAG,
        });
        this._earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMat);
        this._scene.add(this._earth);

        // Drifting cloud shell — shares the Earth vertex shader varyings
        this._cloudU = {
            u_sun:  { value: SUN_DIR.clone() },
            u_time: { value: 0 },
        };
        const cloudMat = new THREE.ShaderMaterial({
            uniforms: this._cloudU,
            vertexShader:   EARTH_VERT,
            fragmentShader: CLOUD_FRAG,
            transparent: true,
            depthWrite:  false,
        });
        this._clouds = new THREE.Mesh(new THREE.SphereGeometry(1.016, 64, 64), cloudMat);
        this._clouds.renderOrder = 1;
        this._scene.add(this._clouds);

        // Atmosphere: ONE Fresnel scattering shell (2026-09-21) in place of
        // the two flat additive spheres. Day-side limb is Rayleigh blue, the
        // terminator goes through orange (long path, red-shifted), the night
        // limb keeps a faint airglow; a storm warms the whole rim. Drawn
        // FrontSide so the rim term varies (a BackSide pow(rim) is identically
        // 1 — the SOLAR_SYSTEM_VISUAL_REVIEW S3 scar).
        this._atmoU = {
            u_sun:   { value: SUN_DIR.clone() },
            u_storm: { value: 0 },
        };
        const atmoMat = new THREE.ShaderMaterial({
            uniforms: this._atmoU,
            vertexShader: EARTH_VERT,
            fragmentShader: ATMO_FRAG,
            transparent: true, depthWrite: false, side: THREE.FrontSide,
            blending: THREE.AdditiveBlending,
        });
        const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.075, 96, 96), atmoMat);
        atmo.renderOrder = 2;
        this._scene.add(atmo);
    }

    // ── Background stars ──────────────────────────────────────────────────────
    _initStars() {
        // 1400 (was 2400), sizes weighted hard toward tiny and tints kept
        // cold — the old field's warm tan stars were indistinguishable from
        // the heated wind particles and the two read as confetti.
        const N     = 1400;
        const pos   = new Float32Array(N * 3);
        const size  = new Float32Array(N);
        const phase = new Float32Array(N);
        const tint  = new Float32Array(N * 3);
        const c     = new THREE.Color();
        for (let i = 0; i < N; i++) {
            const phi   = Math.acos(2 * Math.random() - 1);
            const theta = Math.random() * Math.PI * 2;
            const r     = 300 + Math.random() * 80;
            pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
            pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
            pos[i*3+2] = r * Math.cos(phi);
            size[i]  = 0.55 + Math.pow(Math.random(), 4.5) * 2.8;
            phase[i] = Math.random();
            // Cold-to-neutral stellar tints (no warm end — see above)
            const w = Math.random();
            c.setRGB(0.72 + w * 0.22, 0.80 + w * 0.15, 0.95 + (1 - w) * 0.05);
            tint[i*3] = c.r; tint[i*3+1] = c.g; tint[i*3+2] = c.b;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aSize',    new THREE.BufferAttribute(size, 1));
        geo.setAttribute('aPhase',   new THREE.BufferAttribute(phase, 1));
        geo.setAttribute('aTint',    new THREE.BufferAttribute(tint, 3));
        this._starU = { u_time: { value: 0 }, u_ignite: { value: this._intro ? 0 : 1 } };
        const mat = new THREE.ShaderMaterial({
            uniforms: this._starU,
            vertexShader:   STAR_VERT,
            fragmentShader: STAR_FRAG,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._scene.add(new THREE.Points(geo, mat));
    }

    // ── Deep field (see NEBULA_FRAG) ──────────────────────────────────────────
    _initDeepField() {
        this._nebU = { u_time: { value: 0 }, u_gain: { value: 0.50 } };   // 0.85 → 0.50: one band, not three clouds
        const mat = new THREE.ShaderMaterial({
            uniforms: this._nebU,
            vertexShader:   NEBULA_VERT,
            fragmentShader: NEBULA_FRAG,
            side:        THREE.BackSide,
            depthWrite:  false,
            depthTest:   false,
            blending:    THREE.AdditiveBlending,
            fog:         false,
        });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(260, 24, 16), mat);
        mesh.renderOrder = -10;   // first, so everything composites over it
        mesh.frustumCulled = false;
        this._nebula = mesh;
        this._scene.add(mesh);
    }

    /**
     * Something opaque is covering the canvas (the background carousel on a
     * captured slide). Parks the RAF like off-screen does — the GPU goes to
     * whatever is actually visible. Re-enabled BEFORE the cover fades out.
     */
    setCovered(covered) {
        this._covered = !!covered;
        this._maybeRun();
    }

    // ── CME flux-rope train + τ scrubber (js/hero-rope-layer.js) ─────────────
    // Optional: `opts.ropes` is { host, replay } — absent, the scene draws no
    // train and the framing stays on Earth. The layer is dynamically
    // imported so a page without it pays nothing.
    _initRopes() {
        const cfg = this._opts.ropes;
        if (!cfg) return;
        import('./hero-rope-layer.js').then((m) => {
            if (this._stopped) return;
            this._corridorRe = m.CORRIDOR_SUN_RE;
            this._ropes = m.createHeroRopeLayer({
                THREE, scene: this._scene,
                sunDir: [SUN_DIR.x, SUN_DIR.y, SUN_DIR.z],
                host: cfg.host,
                replay: cfg.replay ?? null,
                onFraming: (mode) => this.setFraming(mode),
                // The Gannon replay's self-start waits for the entrance.
                autoplayGate: this._introSettled,
            });
            this._updateFraming();
            // The corridor's own materials (drawn Sun, halo, ruler) sit in
            // the scene hidden until the first scrub/replay; warm them now so
            // that first corridor frame does not compile synchronously.
            try { this._compileAsync(this._scene, this._camera); } catch { /* compiles on first use instead */ }
        }).catch((e) => console.warn('[HeroSpaceWeather] rope layer failed:', e?.message ?? e));
    }

    /** 'earth' (resting shot) or 'corridor' (Sun→Earth, for the transit). */
    setFraming(mode) {
        this._framingMode = mode === 'corridor' ? 'corridor' : 'earth';
    }

    // ── Sun — radial-gradient sprites that feed the bloom pass ────────────────
    _initSun() {
        const tex = _radialTexture([
            [0.00, 'rgba(255,247,232,1)'],
            [0.16, 'rgba(255,233,176,0.95)'],
            [0.38, 'rgba(255,179,71,0.38)'],
            [0.70, 'rgba(255,122,26,0.10)'],
            [1.00, 'rgba(255,122,26,0)'],
        ]);
        const sunPos = SUN_DIR.clone().multiplyScalar(70);
        const core = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        core.position.copy(sunPos);
        core.scale.setScalar(12);
        this._scene.add(core);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, depthWrite: false, opacity: 0.32,
            blending: THREE.AdditiveBlending,
        }));
        halo.position.copy(sunPos);
        halo.scale.setScalar(30);
        this._scene.add(halo);
        this._sunCore = core;
        this._sunHalo = halo;
    }

    // ── CME-inbound cue — pulsing front on the sunward axis ───────────────────
    _initCmeCue() {
        const cue = _additiveSphere(2.6, 0xffa050, 0.0);
        cue.material.side = THREE.FrontSide;
        cue.position.copy(SUN_DIR.clone().multiplyScalar(22));
        cue.visible = false;
        this._scene.add(cue);
        this._cmeCue = cue;
    }

    // ── Solar-wind particles ──────────────────────────────────────────────────
    _initParticles() {
        const N = this._opts.particleCount;
        const pos  = new Float32Array(N * 3);
        const seed = new Float32Array(N);
        const heat = new Float32Array(N);
        const vel  = new Float32Array(N);

        // Steady state: scattered so the stream starts full. Entrance: the
        // SAME stream laid out UPSTREAM of the spawn plane (a uniform block
        // one path-length long), so it arrives from the Sun with a front,
        // breaks on the bow shock, and settles into exactly the steady
        // stream — every particle keeps a uniform phase, so no pulse echoes
        // down the tail afterwards.
        for (let i = 0; i < N; i++) {
            if (this._intro) this._spawnParticle(pos, vel, i, false, Math.random() * WIND_PATH);
            else this._spawnParticle(pos, vel, i, /*scatter=*/true);
            seed[i] = Math.random();
            heat[i] = 0;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aSeed',    new THREE.BufferAttribute(seed, 1));
        geo.setAttribute('aHeat',    new THREE.BufferAttribute(heat, 1));
        this._pPos  = pos;
        this._pVel  = vel;
        this._pHeat = heat;

        this._windU = {
            u_size: { value: 1.05 },
            u_cold: { value: new THREE.Color(0x9fc8ff) },
            u_hot:  { value: new THREE.Color(0xffc27a) },
        };
        this._windColdTarget = new THREE.Color(0x9fc8ff);
        this._pMat = new THREE.ShaderMaterial({
            uniforms: this._windU,
            vertexShader:   WIND_VERT,
            fragmentShader: WIND_FRAG,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._particles = new THREE.Points(geo, this._pMat);
        this._particles.renderOrder = 6;
        this._scene.add(this._particles);
    }

    // Spawn one particle on the sun-side spawn plane, optionally scattered
    // along the flow axis so the stream starts full instead of as a wave,
    // or `upstream` R_E further sunward (the entrance's arriving stream).
    _spawnParticle(pos, vel, i, scatter = false, upstream = 0) {
        const right = new THREE.Vector3(0, 1, 0).cross(SUN_DIR).normalize();
        const up    = SUN_DIR.clone().cross(right).normalize();
        const spread = 24;
        const y = (Math.random() - 0.5) * spread;
        const z = (Math.random() - 0.5) * spread;
        const pt = SUN_DIR.clone().multiplyScalar(SPAWN_R + upstream)
            .addScaledVector(right, y)
            .addScaledVector(up,    z);
        pos[i*3]   = pt.x + (scatter ? (Math.random() - 0.5) * 55 : 0);
        pos[i*3+1] = pt.y;
        pos[i*3+2] = pt.z + (scatter ? (Math.random() - 0.5) * 55 : 0);
        vel[i] = 0.6 + Math.random() * 0.8;
    }

    // ── React to live SWPC data ───────────────────────────────────────────────
    _updateFromState(state) {
        const bz = state.solar_wind?.bz ?? 0;
        // Stream colour: southward Bz → hot pink/red (geoeffective);
        // northward → steel blue; quiet → ice. Lerped per-frame for smoothness.
        if      (bz < -8) this._windColdTarget.setHex(0xff5a4d);
        else if (bz < -3) this._windColdTarget.setHex(0xff8fb8);
        else if (bz >  5) this._windColdTarget.setHex(0x66aaff);
        else              this._windColdTarget.setHex(0x9fc8ff);

        const level = state.derived?.storm_level ?? 0;
        this._stormNorm = Math.min(1, level / 5 + (state.derived?.kp_norm ?? 0) * 0.3);
        this._earthU.u_storm.value = this._stormNorm;
        if (this._atmoU) this._atmoU.u_storm.value = this._stormNorm;

        // Storm-driven reveal (hysteresis so a feed wobble cannot strobe it)
        const want = this._revealed ? this._stormNorm > REVEAL_OFF : this._stormNorm > REVEAL_ON;
        if (want !== this._revealed) {
            this._revealed = want;
            for (const l of REVEAL_LAYERS) this._engine.setLayerVisible(l, want);
        }

        // Storm escalation / major flare → aurora substorm surge
        if (level > this._lastStormLevel) this._engine.setSubstorm(0.45 + 0.12 * level);
        if (state.new_major_flare)        this._engine.setSubstorm(0.85);
        this._lastStormLevel = level;

        // Bloom breathes with activity
        if (this._bloom) this._bloom.strength = 0.85 + this._stormNorm * 0.55;

        // CME-inbound cue
        const eta = state.cme_eta_hours;
        this._cmeInbound = !!state.earth_directed_cme && Number.isFinite(eta) && eta < 120;
        if (this._cmeCue) this._cmeCue.visible = this._cmeInbound;

        // Sun pulse follows X-ray intensity
        this._xrayNorm = state.derived?.xray_intensity ?? 0;
    }

    /**
     * A swpc-feed-shaped state from the rope layer's modeled conditions at τ
     * (bz / v / n / Dst / Kp proxy), so the engine and the storm terms read
     * it exactly as they read the live feed. Shape mirrors js/swpc-feed.js.
     */
    _stateFromConditions(c) {
        const kp = c.kp;
        const level = c.gLevel;
        return {
            solar_wind: { speed: c.v, density: c.n, bz: c.bz },
            kp,
            dst: c.dst,
            derived: {
                storm_level: level,
                kp_norm: Math.min(1, kp / 9),
                xray_intensity: this._state?.derived?.xray_intensity ?? 0,
            },
            modeled: true,
        };
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    _animate() {
        this._animId = requestAnimationFrame(this._animate.bind(this));
        const frameStart = performance.now();
        const rawDt = this._clock.getDelta() || 1 / 60;
        const dt = Math.min(0.05, rawDt);            // physics step (clamped)
        const easeDt = Math.min(0.5, rawDt);         // wall-clock for camera eases
        this._t += dt;
        const t = this._t;

        // ── Camera: bounded sway (Sun stays screen-left) + stage framing +
        //    eased pointer parallax ───────────────────────────────────────
        // Framing mix eases on an e-folding TIME (the TIGA/Star Collider
        // rule: never a per-frame fraction, which took 8 s on software GL).
        const want = (this._framingMode === 'corridor' && this._frame.corrDist > 0) ? 1 : 0;
        const prevMix = this._mix;
        // easeDt, not dt: the clamped physics step would stretch a 0.55 s
        // ease to ~6 s on a software rasteriser (measured: mix 0.09 after 3.5 s).
        this._mix += (want - this._mix) * (1 - Math.exp(-easeDt / FRAMING_TAU_S));
        if (Math.abs(this._mix - want) < 0.002) this._mix = want;
        const mix = this._mix;
        // The entrance offsets (zero once settled) ride on top of the
        // framing; _applyFov folds in its zoom.
        const introOn = this._stepIntro(easeDt, mix);
        if (this._mix !== prevMix || introOn) { this._applyFov(); this._camera.updateProjectionMatrix(); }
        const camR   = this._camR + (this._frame.corrDist - this._camR) * mix;
        const camPhi = this._camPhi + (CORRIDOR_ELEV - this._camPhi) * mix + this._introElev;

        this._camTh = CAM_AZIMUTH + CAM_SWAY_DEG * DEG * Math.sin(t * CAM_SWAY_RATE) + this._introArc;
        // The aim point slides from Earth toward the corridor's midpoint;
        // the camera orbits THAT point so the segment stays framed.
        const sv = this._tmpSubject ?? (this._tmpSubject = new THREE.Vector3());
        sv.copy(SUN_DIR).multiplyScalar(this._corridorRe * CORRIDOR_AIM_FRAC * mix);
        const cx = sv.x + camR * Math.cos(camPhi) * Math.cos(this._camTh);
        const cy = sv.y + camR * Math.sin(camPhi) + 0.35 * Math.sin(t * 0.11) * (1 - mix);
        const cz = sv.z + camR * Math.cos(camPhi) * Math.sin(this._camTh);
        const k = Math.min(1, 2.5 * dt);
        this._parX += (this._parTX - this._parX) * k;
        this._parY += (this._parTY - this._parY) * k;
        this._camera.position.set(cx, cy, cz);
        this._aimAtStage(sv);

        // ── Earth + clouds rotation, shader clocks ─────────────────────────
        this._earth.rotation.y  += 0.0085 * dt;
        this._clouds.rotation.y += 0.0125 * dt;
        this._earthU.u_time.value = t;
        this._cloudU.u_time.value = t;
        this._starU.u_time.value  = t;
        if (this._nebU) this._nebU.u_time.value = t;

        // ── Magnetosphere: live state + real dt every frame ────────────────
        // ── Scrubbed conditions → the engine (storm-driven reveal) ─────────
        // While the corridor is up, the engine sees the model's state at τ;
        // on the way back it sees the live feed again. Pushed at COND_HZ.
        let engineState = this._state;
        if (this._ropes) {
            this._ropes.setMix(this._mix);
            if (this._mix > 0.02 && this._ropes.hasConditions) {
                const now = performance.now();
                if (!this._condAt || now - this._condAt > 1000 / COND_HZ) {
                    this._condAt = now;
                    const c = this._ropes.conditionsAt(this._ropes.tauMs);
                    this._condState = c ? this._stateFromConditions(c) : null;
                    if (this._condState) {
                        this._engine.update(this._condState);
                        this._updateFromState(this._condState);
                        this._scrubDriven = true;
                    }
                }
                if (this._condState) engineState = this._condState;
            } else if (this._scrubDriven) {
                this._scrubDriven = false;
                this._condState = null;
                this._engine.update(this._state);
                this._updateFromState(this._state);
            }
        }
        this._engine.tick(t, SUN_DIR, engineState, dt);
        this._ropes?.tick(dt);

        // ── Solar wind ─────────────────────────────────────────────────────
        this._windU.u_cold.value.lerp(this._windColdTarget, Math.min(1, 3 * dt));
        this._advanceParticles(dt);

        // ── Sun pulse ──────────────────────────────────────────────────────
        if (this._sunCore) {
            const pulse = 1 + 0.05 * Math.sin(t * 1.7) + (this._xrayNorm ?? 0) * 0.3;
            this._sunCore.scale.setScalar(12 * pulse);
            this._sunHalo.material.opacity = 0.28 + 0.08 * Math.sin(t * 0.9) + (this._xrayNorm ?? 0) * 0.2;
        }

        // ── CME cue pulse ──────────────────────────────────────────────────
        if (this._cmeInbound && this._cmeCue) {
            const p = 0.5 + 0.5 * Math.sin(t * 1.15);
            this._cmeCue.material.opacity = 0.05 + 0.11 * p;
            this._cmeCue.scale.setScalar(1 + 0.25 * p);
        }

        this._renderFrame();
        if (!this._shown) {
            // First frame is on the canvas: index.html's CSS fades the canvas
            // in over the backdrop and dissolves the boot reticle. Flagged on
            // the SECOND frame — by then the first has been presented, so on
            // a slow GPU the reticle cannot dissolve over a canvas that is
            // still empty.
            if (++this._framesDrawn >= 2) {
                this._shown = true;
                this._setHostState('live');
                if (!this._intro) this._finishIntro();
            }
        }
        this._degrade(performance.now() - frameStart);
    }

    /**
     * Advance the entrance by `easeDt` of WALL clock (so a software
     * rasteriser at 2 fps still settles on time) and publish its offsets:
     * azimuth arc + extra elevation (radians) and a fov zoom factor, each
     * weighted (1 − e)(1 − mix) so it eases out cubically and yields to the
     * corridor framing if the visitor scrubs mid-entrance. Stars ignite and
     * the aurora rises on the same clock. Returns true while it is running.
     */
    _stepIntro(easeDt, mix) {
        const end = Math.max(INTRO_S, INTRO_AURORA[1]);
        if (this._introT >= end) return false;
        // Scrubbing into the corridor mid-entrance fast-forwards it: coming
        // back from the corridor must land on the resting shot, not resume.
        if (mix > 0.5) this._introT = end;
        else this._introT += easeDt;
        const ti = this._introT;
        const p = Math.min(1, ti / INTRO_S);
        const k = Math.pow(1 - p, 3) * (1 - mix);        // 1 − easeOutCubic
        this._introArc  = INTRO_ARC_DEG * DEG * k;
        this._introElev = INTRO_ELEV_DEG * DEG * k;
        this._introZoom = 1 + (INTRO_ZOOM - 1) * k;
        this._starU.u_ignite.value = Math.min(1, ti / INTRO_STARS_S);
        const a = Math.min(1, Math.max(0, (ti - INTRO_AURORA[0]) / (INTRO_AURORA[1] - INTRO_AURORA[0])));
        this._engine.setAuroraRise(a * a * (3 - 2 * a));
        if (ti >= end) this._finishIntro();
        return true;
    }

    /** Settle every entrance term on its live value and announce it. */
    _finishIntro() {
        this._introT = Math.max(INTRO_S, INTRO_AURORA[1]);
        this._introArc = 0; this._introElev = 0; this._introZoom = 1;
        this._starU.u_ignite.value = 1;
        this._engine.setAuroraRise(1);
        this._applyFov();
        this._camera.updateProjectionMatrix();
        // index.html holds the below-the-fold demo iframes (two full WebGL
        // apps) until this fires, so they cannot stutter the entrance.
        this._resolveIntro?.();
        try { window.dispatchEvent(new CustomEvent('hero-intro-done')); } catch { /* old engines */ }
    }

    /**
     * Point the camera so Earth (the origin) projects at the stage's NDC
     * centre. Earth must sit at camera-space (nx·tanH·z, ny·tanV·z, −z) with
     * |E − cam| = d, which fixes z; the look-at target is Earth minus that
     * offset along the camera's right/up. Those axes rotate with the
     * re-aim, so it is solved twice (the second pass is exact to <0.1%).
     * Pointer parallax rides on top, scaled by the fov so a 16° telephoto
     * frame does not swing four times further than the 50° one did.
     */
    _aimAtStage(subject) {
        const cam = this._camera, f = this._frame;
        const tv = this._tmpTarget ?? (this._tmpTarget = new THREE.Vector3());
        const rv = this._tmpRight  ?? (this._tmpRight  = new THREE.Vector3());
        const uv = this._tmpUp     ?? (this._tmpUp     = new THREE.Vector3());
        const fv = this._tmpFwd    ?? (this._tmpFwd    = new THREE.Vector3());
        const tanV = Math.tan(cam.fov * DEG / 2);
        const tanH = tanV * cam.aspect;
        const d = cam.position.distanceTo(subject);
        const z = d / Math.sqrt(1 + (f.nx * tanH) ** 2 + (f.ny * tanV) ** 2);
        const ox = f.nx * tanH * z, oy = f.ny * tanV * z;
        const par = tanV / Math.tan(FOV_DEFAULT * DEG / 2);
        tv.copy(subject);
        cam.lookAt(tv);
        for (let pass = 0; pass < 2; pass++) {
            fv.set(0, 0, -1).applyQuaternion(cam.quaternion);
            rv.crossVectors(fv, cam.up).normalize();
            uv.crossVectors(rv, fv).normalize();
            tv.copy(subject).addScaledVector(rv, -ox).addScaledVector(uv, -oy);
            tv.x -= this._parX * 0.8 * par;
            tv.y -= this._parY * 0.6 * par;
            cam.lookAt(tv);
        }
    }

    // Base frame first, then the additive bloom overlay (never clears/blits
    // over the base — see _initBloom).
    _renderFrame() {
        const r = this._renderer;
        r.render(this._scene, this._camera);
        if (this._bloomOn && this._bloom) {
            const prevTarget    = r.getRenderTarget();
            const prevAutoClear = r.autoClear;
            r.setRenderTarget(this._rtScene);
            r.setClearColor(0x000000, 0);
            r.clear();
            r.render(this._scene, this._camera);
            r.autoClear = false;
            this._bloom.renderToScreen = false;
            this._bloom.render(r, this._rtScene, this._rtScene, 0, false);
            r.setRenderTarget(null);
            this._bloomBlit.material.uniforms.tDiffuse.value =
                this._bloom.renderTargetsHorizontal[0].texture;
            this._bloomBlit.render(r);
            r.autoClear = prevAutoClear;
            r.setRenderTarget(prevTarget);
            r.setClearColor(0x02010c, 1);
        }
    }

    // One-way degradation ladder: never re-upgrades (avoids quality thrash).
    _degrade(frameMs) {
        this._frameEma = this._frameEma * 0.95 + frameMs * 0.05;
        if (++this._frameN < 240) return;   // warm-up
        if (this._bloomOn && this._frameEma > 45) {
            this._bloomOn = false;
            console.info('[HeroSpaceWeather] slow device — bloom disabled');
        } else if (!this._bloomOn && this._nebula?.visible && this._frameEma > 55) {
            this._nebula.visible = false;
            console.info('[HeroSpaceWeather] slow device — deep field disabled');
        } else if (!this._bloomOn && this._frameEma > 60 && !this._halved) {
            this._halved = true;
            this._particles.geometry.setDrawRange(0, Math.floor(this._opts.particleCount / 2));
            console.info('[HeroSpaceWeather] slow device — particle count halved');
        }
    }

    _advanceParticles(dt) {
        const sw    = this._state?.solar_wind ?? {};
        const spd   = Math.max(200, sw.speed ?? 400);
        // 1 unit = 1 Re. Real 400 km/s ≈ 0.063 Re/s; visual ×3.6 reads clearly.
        const vps   = (spd / 6371) * 3.6 * 60;   // units/s at vel[i]=1
        const anti  = this._antiSun ?? (this._antiSun = SUN_DIR.clone().negate());
        const pos   = this._pPos;
        const vel   = this._pVel;
        const heat  = this._pHeat;
        const N     = this._opts.particleCount;
        // Bow-shock crossings this frame → a rate (per second) for the
        // sound layer; EMA so a frame hitch does not read as a burst.
        this._shockHits = 0;
        this._shockDt = dt;

        // Live Shue bow shock from the engine — the deflection boundary.
        const an     = this._engine?.analysis;
        const bsR0   = an?.bowShockR0 ?? 13.0;
        const bsAlp  = (an?.alpha ?? 0.58) - 0.08;
        const sx = SUN_DIR.x, sy = SUN_DIR.y, sz = SUN_DIR.z;
        const ease = Math.min(1, 6 * dt);

        for (let i = 0; i < N; i++) {
            let px = pos[i*3], py = pos[i*3+1], pz = pos[i*3+2];
            const step = vps * vel[i] * dt;
            px += anti.x * step;  py += anti.y * step;  pz += anti.z * step;

            // Distance + angle from the sunward axis
            const r = Math.sqrt(px*px + py*py + pz*pz);
            if (r > 0.001) {
                const cosT = (px*sx + py*sy + pz*sz) / r;
                if (cosT > -0.92) {   // skip the deep tail — flow is free there
                    const rB = bsR0 * Math.pow(2 / (1 + cosT), bsAlp);
                    if (r < rB) {
                        // Inside the bow shock: slide the particle out toward
                        // the boundary, transverse to the Sun-Earth line, and
                        // heat it (magnetosheath shock heating).
                        const along = px*sx + py*sy + pz*sz;
                        let qx = px - sx*along, qy = py - sy*along, qz = pz - sz*along;
                        let ql = Math.sqrt(qx*qx + qy*qy + qz*qz);
                        if (ql < 0.15) {   // near-axis: kick off using a fixed perp
                            qx = -sy; qy = sx; qz = 0; ql = Math.sqrt(qx*qx + qy*qy);
                        }
                        const push = (rB - r) * ease / ql;
                        px += qx * push;  py += qy * push;  pz += qz * push;
                        if (heat[i] === 0) this._shockHits++;   // first contact — the sound layer's tick
                        heat[i] = Math.min(1, heat[i] + 3.5 * dt);
                    } else {
                        heat[i] = Math.max(0, heat[i] - 0.7 * dt);
                    }
                } else {
                    heat[i] = Math.max(0, heat[i] - 0.7 * dt);
                }
            }

            // Respawn beyond the tail or far off the flanks. A particle still
            // UPSTREAM of the spawn plane is the entrance stream arriving,
            // not a stray: the flank rule would teleport it onto the plane
            // and the stream would arrive as one flat sheet. Inert in the
            // steady state — particles spawn ON the plane and only ever
            // move anti-sunward (the bow-shock push is transverse).
            const downTail = px*anti.x + py*anti.y + pz*anti.z;
            const arriving = -downTail > SPAWN_R + 0.5;
            if (downTail > 30 || (r > 34 && downTail < 0 && !arriving)) {
                this._spawnParticle(pos, vel, i);
                heat[i] = 0;
            } else {
                pos[i*3] = px;  pos[i*3+1] = py;  pos[i*3+2] = pz;
            }
        }
        this._particles.geometry.attributes.position.needsUpdate = true;
        this._particles.geometry.attributes.aHeat.needsUpdate = true;
        const inst = this._shockHits / Math.max(1e-3, this._shockDt);
        this._shockRate = (this._shockRate ?? inst) * 0.85 + inst * 0.15;
    }

    /**
     * What the sound layer (js/hero-sonify.js) sonifies: the state the
     * engine is running on right now (live, or the model's at τ while the
     * transit is scrubbed) plus the bow-shock crossing rate.
     */
    audioState() {
        const st = this._condState ?? this._state ?? {};
        const sw = st.solar_wind ?? {};
        return {
            speed: sw.speed ?? 400, density: sw.density ?? 5, bz: sw.bz ?? 0,
            kp: st.kp ?? 2, stormNorm: this._stormNorm ?? 0,
            shockRate: this._shockRate ?? 0, modeled: !!st.modeled,
        };
    }

    // ── Resize ────────────────────────────────────────────────────────────────
    // Runs on window resize AND whenever the canvas's own CSS box changes
    // (ResizeObserver in start()). The second case is the common one: the
    // hero grows as the console, the fonts and the upsell land, none of
    // which fires a window resize — and a drawing buffer left at its boot
    // size is stretched by CSS, which drew Earth as an OVAL on every load
    // (measured: buffer 1440×1009 shown at 1440×1208, a 1.20 vertical
    // stretch with the camera still at the boot aspect). setSize only when
    // the size actually changed: re-assigning canvas.width resets the
    // drawing buffer even to the same value.
    _onResize() {
        const w = this._w(), h = this._h();
        const resized = w !== this._sizeW || h !== this._sizeH;
        if (resized) {
            this._sizeW = w; this._sizeH = h;
            this._renderer.setSize(w, h, false);
            this._bloom?.setSize(w, h);
            this._rtScene?.setSize(w, h);
        }
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._updateFraming();
        // A resized buffer is EMPTY until the next render, and ResizeObserver
        // callbacks run after this frame's rAF — so the cleared canvas was
        // painted for a frame (a blank stage mid-entrance, measured). Redraw
        // now, before paint, whenever the loop is live.
        if (resized && this._animId && this._shown) this._renderFrame();
    }

    _w() { return this._canvas.clientWidth  || 900; }
    _h() { return this._canvas.clientHeight || 520; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _additiveSphere(r, color, opacity) {
    return new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshBasicMaterial({
            color, transparent: true, opacity,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        })
    );
}

function _radialTexture(stops, size = 256) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    for (const [off, col] of stops) g.addColorStop(off, col);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
