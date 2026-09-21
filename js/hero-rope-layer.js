/**
 * hero-rope-layer.js — the modeled CME train, drawn as FLUX-ROPE SURFACES in
 * the homepage hero, with the τ scrubber that replays its transit.
 * ═══════════════════════════════════════════════════════════════════════════
 * The hero's stage (index.html #hero-stage, js/hero-space-weather.js) frames
 * Earth at ~2.2× for the resting shot. A CME in transit cannot be seen at
 * that framing — the stage shows ±4 R_E and 1 AU is 23 481 R_E — so this
 * layer owns TWO things the resting shot does not have:
 *
 *   1. A CORRIDOR: the Sun drawn on the copy-side of the stage, Earth on the
 *      far side, and the flux-rope surfaces of the shared provider's train
 *      between them on a DISCLOSED compressed radial map (`corridorRadius`
 *      — `stage/scale.js` `stageRadius`, the Stage's own map, rescaled so
 *      1 AU lands on the drawn Earth and 0 AU on the drawn Sun).
 *   2. A τ SCRUBBER under the stage. Dragging it sets the instant the train
 *      is drawn at; the hero camera pulls back to the corridor framing while
 *      the transit plays and returns to Earth when the visitor lets go.
 *
 * ── This module computes NO physics ────────────────────────────────────────
 * Rope geometry is `corridor/corridor-model.js` `trainAt()` — the live
 * kernel's own apex / σ probes (`apexKmAt` / `sigmaApexKmAt`, oracle-direct,
 * so the §16 wake and interaction are the kernel's answer) with
 * `stage/model.js` `ropeSpecAt` as the pinned-mirror fallback — and the
 * surface is `stage/model.js` `ropeSurfaceGrid`. The forecast is the ONE
 * shared provider's published result (`window.__fluxRopeForecast` / the
 * 'flux-rope-forecast' event, started here with `startFluxRopeProvider`
 * from js/sun-flux-rope.js). This is the orrery-rope-layer pattern; there is
 * no third copy of the math and there must never be one.
 *
 * ── The frame join ─────────────────────────────────────────────────────────
 * `ropeFrame` works in a heliocentric frame with +x = Sun→Earth and +z =
 * ecliptic north (Stonyhurst longitude, Earth at 0). The hero scene is
 * y-up with Earth at the origin and the Sun along `SUN_DIR`. So the rope
 * basis in hero world is e1 = −SUN_DIR, e3 = +y, e2 = e3 × e1 — RIGHT-handed,
 * because this scene is not a mirror of anything (unlike the orrery, whose
 * `drawTilt` pays for its y↔z swap). A rope fitted at +γ draws at +γ here.
 *
 * ── Honesty ────────────────────────────────────────────────────────────────
 * • A live train draws LIVE, chip "LIVE · CME train". When nothing
 *   Earth-relevant is in flight (the provider's `idle`) — most days — the
 *   layer replays the validated Gannon May 2024 hindcast train, chip
 *   "REPLAY · MAY 2024 G5", on the kernel with interaction ON
 *   (`GANNON_FIT.standoffRopes`, the flux-rope-live.html DEMO posture).
 *   Feeds down must look down, never quiet — and the replay is the storm
 *   the badge under the H1 says the forecasts were validated on.
 * • A FAILED provider run (not idle: an error) still replays, but the chip
 *   says the live feed is down.
 * • The corridor's radial compression and the drawn body sizes are printed
 *   in the legend. AU readouts are true.
 * • A rope past 1 AU fades, never implying a still-inbound cloud.
 *
 * ── Conditions at Earth, for the storm-driven reveal ───────────────────────
 * `conditionsSeries(fc)` turns the forecast's L1 driver (live: the
 * provider's `driver.samples`; replay: the kernel's own deterministic
 * `series()` at the L1 observer, V from the arrived rope's apex speed) into
 * a Dst track with `ring-current-model.js` `integrateDst` (O'Brien &
 * McPherron — the same integrator the ring-current page runs), and
 * `conditionsAt(fc, τ)` samples it. The hero feeds that state to the
 * magnetosphere engine while the transit is scrubbed, so the belts, the
 * ring current, the sheath and the aurora react to the rope ARRIVING —
 * the engine's own response, on the model's own driver. Kp is needed by
 * the engine for the plasmapause/oval and there is no Kp in a flux-rope
 * forecast: `kpProxyFromDst` is a DISCLOSED piecewise display proxy
 * pinned to the NOAA G-scale's usual Dst bands, never a forecast of Kp.
 *
 * Node gate: `node tests/hero-rope-layer.mjs` (the pure half — the frame
 * basis, the radial anchors, the scrub-window derivation, the replay
 * forecast shape). Browser gate: `tests/home-hero-stage.spec.js`.
 * Test hook: `window.__heroRopes` under ?debug=1.
 */

import { trainAt } from './corridor/corridor-model.js';
import { ropeSurfaceGrid } from './stage/model.js';
import { stageRadius, EARTH_S, RSUN_KM, AU_KM } from './stage/scale.js';
import { integrateDst } from './ring-current-model.js';

const HOUR = 3600e3;

// ── Corridor geometry (hero scene units: 1 = 1 R_E, Earth at the origin) ──

/** Distance from Earth to the corridor's drawn Sun, along SUN_DIR. */
export const CORRIDOR_SUN_RE = 30;
/** Drawn Sun radius (real: 109 R_E — a Sun 30 R_E away would swallow the
 *  scene). Exaggeration factor is disclosed in the legend. */
export const CORRIDOR_SUN_DRAWN_R = 2.4;
/** Beyond this the front has left the scene's region of interest. */
export const PASSED_HIDE_AU = 1.35;
/** Surface mesh resolution (the orrery's; the seam shows below it). */
export const N_PSI = 56;
export const N_THETA = 22;
/** Per-rope colours — the corridor's, so a rope reads the same on every page. */
export const ROPE_COLORS = [0xffb454, 0x4fc3f7, 0xc792ea, 0x7fe6c3, 0xff8866, 0xffd75e];

/**
 * Heliocentric r [AU] → distance from the drawn Sun in hero units.
 * `stageRadius` puts 1 AU at EARTH_S stage units; scaling by
 * CORRIDOR_SUN_RE/EARTH_S puts 1 AU exactly on the drawn Earth.
 */
export function corridorRadius(rAu) {
    if (!(rAu > 0)) return 0;
    return stageRadius(rAu) * (CORRIDOR_SUN_RE / EARTH_S);
}

/** The Sun's real radius on this map, for the disclosed exaggeration. */
export const SUN_TRUE_DRAWN_R = corridorRadius(RSUN_KM / AU_KM);
export const SUN_EXAGGERATION = CORRIDOR_SUN_DRAWN_R / SUN_TRUE_DRAWN_R;

/**
 * Rope-frame basis in hero world coordinates for a Sun along `sunDir`
 * (unit vector, Earth at the origin). Right-handed — see the header.
 * @param {number[]} sunDir
 */
export function heroBasis(sunDir) {
    const n = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
    const e1 = [-sunDir[0] / n, -sunDir[1] / n, -sunDir[2] / n];   // Sun→Earth
    // e3: ecliptic north = scene +y, orthogonalised against e1.
    let e3 = [0 - e1[0] * e1[1], 1 - e1[1] * e1[1], 0 - e1[2] * e1[1]];
    const m = Math.hypot(e3[0], e3[1], e3[2]) || 1;
    e3 = [e3[0] / m, e3[1] / m, e3[2] / m];
    const e2 = [
        e3[1] * e1[2] - e3[2] * e1[1],
        e3[2] * e1[0] - e3[0] * e1[2],
        e3[0] * e1[1] - e3[1] * e1[0],
    ];
    return { e1, e2, e3, handedness: 1 };
}

/**
 * One rope-frame point (AU, from the Sun) → hero scene coordinates.
 * The rotation is orthonormal, so the physical radius is just |p|.
 */
export function ropePointToHero(p, basis, sunPos, out = [0, 0, 0]) {
    const { e1, e2, e3 } = basis;
    const rAu = Math.hypot(p[0], p[1], p[2]);
    if (!(rAu > 1e-12)) { out[0] = sunPos[0]; out[1] = sunPos[1]; out[2] = sunPos[2]; return out; }
    const k = corridorRadius(rAu) / rAu;
    const x = p[0] * e1[0] + p[1] * e2[0] + p[2] * e3[0];
    const y = p[0] * e1[1] + p[1] * e2[1] + p[2] * e3[1];
    const z = p[0] * e1[2] + p[1] * e2[2] + p[2] * e3[2];
    out[0] = sunPos[0] + x * k; out[1] = sunPos[1] + y * k; out[2] = sunPos[2] + z * k;
    return out;
}

/** Map a whole `ropeSurfaceGrid` positions array; writes into `dst` when it fits. */
export function mapSurface(positions, basis, sunPos, dst = null) {
    const out = dst && dst.length === positions.length ? dst : new Float32Array(positions.length);
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
        p[0] = positions[i]; p[1] = positions[i + 1]; p[2] = positions[i + 2];
        ropePointToHero(p, basis, sunPos, q);
        out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
    }
    return out;
}

/** Opacity ramp past 1 AU. */
export function passedFade(apexAu) {
    if (!(apexAu > 1)) return 1;
    return Math.max(0, 1 - (apexAu - 1) / (PASSED_HIDE_AU - 1));
}

/** Heliocentric distances the corridor's ecliptic ruler rings mark (AU) —
 *  fixed multiples, never adaptive (a ruler whose ticks move is not a ruler). */
export const RULER_AU = Object.freeze([0.25, 0.5, 0.75, 1.0]);

/**
 * Display proxy Kp from Dst — piecewise-linear through the Dst levels the
 * NOAA G-scale storms are usually quoted at (G1 ≈ −50 nT … G5 ≈ −400 nT).
 * Disclosed as a proxy wherever it is used; it exists only because the
 * magnetosphere engine keys its plasmapause and oval on Kp.
 */
export function kpProxyFromDst(dst) {
    if (!Number.isFinite(dst)) return 2;
    const pts = [[-20, 2], [-50, 5], [-100, 6], [-150, 7], [-250, 8], [-400, 9]];
    if (dst >= pts[0][0]) return pts[0][1];
    if (dst <= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) {
        const [d0, k0] = pts[i - 1], [d1, k1] = pts[i];
        if (dst <= d0 && dst >= d1) return k0 + (k1 - k0) * (dst - d0) / (d1 - d0);
    }
    return 2;
}

/**
 * L1 driver samples for a forecast: the provider's driver when it has one,
 * else the kernel's deterministic series (replay). Pure given the kernel.
 * @returns {null|Array<{t:number,v:number,n:number,bz:number}>}
 */
export function driverSamples(fc, { dtS = 900, hours = 120, ambientN = 5 } = {}) {
    if (fc?.driver?.samples?.length) return fc.driver.samples;
    const k = fc?.kernel;
    const ropes = fc?.preset?.ropes;
    if (!k || typeof k.series !== 'function' || !ropes?.length || !Number.isFinite(fc.launchMs)) return null;
    const lastOff = Math.max(...ropes.map((r) => r.launchOffsetS ?? 0));
    const n = Math.min(k.maxSteps ?? 1e9, Math.round((hours * 3600 + lastOff) / dtS));
    const det = k.series(0, dtS, n);
    const w = ropes[0].wKms ?? 400;
    const reachKm = 0.9 * 0.99 * AU_KM;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const tS = i * dtS;
        let v = w;
        for (let r = 0; r < ropes.length; r++) {
            if (tS <= (ropes[r].launchOffsetS ?? 0)) continue;
            if (typeof k.apexKmAt === 'function' && k.apexKmAt(r, tS) >= reachKm && typeof k.apexVKmsAt === 'function') {
                v = Math.max(v, k.apexVKmsAt(r, tS));
            }
        }
        out[i] = { t: fc.launchMs + tS * 1000, v, n: ambientN, bz: det.bz[i] };
    }
    return out;
}

/**
 * Dst track for a forecast (O'Brien–McPherron on the L1 driver), sampled
 * on the driver's own grid. null when there is no driver.
 */
export function conditionsSeries(fc) {
    const samples = driverSamples(fc);
    if (!samples?.length) return null;
    const dst = integrateDst(samples, -10);
    return { samples, dst };
}

/** State at τ: bz / v / n from the driver, Dst from the track, Kp proxy. */
export function conditionsAt(series, tauMs) {
    if (!series?.samples?.length || !Number.isFinite(tauMs)) return null;
    const { samples, dst } = series;
    if (tauMs < samples[0].t || tauMs > samples[samples.length - 1].t) return null;
    // Binary search the driver grid.
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].t <= tauMs) lo = mid; else hi = mid; }
    const s = samples[lo];
    const d = dst[Math.min(lo, dst.length - 1)]?.dst ?? 0;
    const kp = kpProxyFromDst(d);
    return {
        bz: Number.isFinite(s.bz) ? s.bz : 0,
        v: Number.isFinite(s.v) && s.v > 0 ? s.v : 400,
        n: Number.isFinite(s.n) && s.n > 0 ? s.n : 5,
        dst: d,
        kp,
        gLevel: kp >= 9 ? 5 : kp >= 8 ? 4 : kp >= 7 ? 3 : kp >= 6 ? 2 : kp >= 5 ? 1 : 0,
    };
}

// ── Scrub window ───────────────────────────────────────────────────────────

/**
 * The instants the scrubber spans for a forecast: 6 h before the train's
 * epoch to 18 h after the latest arrival the summary knows (P90), or, with
 * no summary, after a nominal transit of the last rope. Pure.
 * @returns {{t0:number,t1:number,launches:number[],arrivalMs:number|null}}
 */
export function scrubWindow(fc, { nominalTransitH = 60 } = {}) {
    const epoch = fc?.launchMs;
    if (!Number.isFinite(epoch)) return null;
    const ropes = fc.preset?.ropes?.length ? fc.preset.ropes : (fc.preset?.rope ? [fc.preset.rope] : []);
    const launches = ropes.map((r) => epoch + (r.launchOffsetS ?? 0) * 1000);
    const lastLaunch = launches.length ? Math.max(...launches) : epoch;
    const s = fc.summary;
    const arrivalMs = Number.isFinite(s?.arrivalP50Ms) ? s.arrivalP50Ms : null;
    const lateMs = Number.isFinite(s?.arrivalP90Ms) ? s.arrivalP90Ms : lastLaunch + nominalTransitH * HOUR;
    return {
        t0: epoch - 6 * HOUR,
        t1: Math.max(lateMs, arrivalMs ?? 0) + 18 * HOUR,
        launches,
        arrivalMs,
    };
}

/**
 * Build a forecast-shaped object for the Gannon replay from the kernel and
 * the pinned preset — geometry only, no ensemble (the page never claims a
 * fan it did not compute). `summary` carries the OBSERVED SSC as the
 * arrival, which is what a replay may honestly print.
 * Pure given a kernel; node-tested with a stub kernel.
 */
export function buildReplayForecast(kernel, fit, ropeDefaults = {}) {
    const ropes = fit.standoffRopes.map((r) => ({ ...ropeDefaults, launchOffsetS: 0, ...r }));
    const launchMs = Date.parse(fit.launchIso);
    const preset = {
        id: 'replay-' + fit.id,
        label: fit.label,
        launchIso: fit.launchIso,
        ropes,
        rope: ropes[0],
        interaction: { enabled: true, ...(fit.interaction ?? {}) },
        replay: true,
    };
    if (kernel) {
        kernel.setRopes(ropes);
        if (typeof kernel.setInteraction === 'function') kernel.setInteraction(preset.interaction);
    }
    // Observed SSC +43.6 h after the epoch (flux-rope-presets.js GANNON_FIT
    // notes) — an observation, printed as such.
    const sscMs = launchMs + 43.6 * HOUR;
    return {
        idle: false,
        replay: true,
        preset,
        launchMs,
        kernel,
        cmes: null,
        train: ropes.length > 1,
        summary: { arrivalP10Ms: sscMs - 3 * HOUR, arrivalP50Ms: sscMs, arrivalP90Ms: sscMs + 3 * HOUR, observed: true },
    };
}

/**
 * The replay factory index.html hands the layer: the pinned Gannon train on
 * a fresh kernel instance. Imports lazily so the resting hero pays nothing
 * for it until the provider reports idle.
 */
export async function gannonReplay(wasmUrl = './js/flux-rope-wasm/flux_rope_core.wasm') {
    const [{ loadFluxRopeKernel, ROPE_DEFAULTS }, { GANNON_FIT }] = await Promise.all([
        import('./flux-rope-kernel.js'),
        import('./flux-rope-presets.js'),
    ]);
    const kernel = await loadFluxRopeKernel(wasmUrl);
    return buildReplayForecast(kernel, GANNON_FIT, ROPE_DEFAULTS);
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDERER + SCRUBBER
// ═══════════════════════════════════════════════════════════════════════════

const CSS = `
#hero-scrub{position:relative;z-index:2;display:grid;grid-template-columns:auto 1fr auto;gap:10px 14px;align-items:center;
  margin:0;padding:10px 14px;border-radius:14px;background:rgba(6,2,20,.72);border:1px solid rgba(154,133,255,.22);
  backdrop-filter:blur(8px);color:var(--fg-2,#cdd8f0);font-size:.74rem}
#hero-scrub[hidden]{display:none}
.hrs-mode{grid-column:1;display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono,monospace);font-size:.6rem;
  letter-spacing:.12em;text-transform:uppercase;color:#ffd75e;white-space:nowrap}
.hrs-mode::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
.hrs-mode.live{color:#2eff9e}
.hrs-mode.down{color:#ff8c5a}
.hrs-tau{grid-column:3;font-family:var(--font-mono,monospace);font-size:.68rem;color:#fff;white-space:nowrap;text-align:right;min-width:9.5em}
.hrs-tau small{display:block;font-size:.58rem;color:var(--fg-4,#6b7390);letter-spacing:.06em}
.hrs-track{grid-column:1/-1;position:relative;height:26px}
.hrs-track input{-webkit-appearance:none;appearance:none;position:absolute;inset:0;width:100%;height:100%;margin:0;background:transparent;cursor:pointer}
.hrs-track input::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(255,255,255,.14)}
.hrs-track input::-moz-range-track{height:4px;border-radius:2px;background:rgba(255,255,255,.14)}
.hrs-track input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;
  border:2px solid #8ff0ff;box-shadow:0 0 12px rgba(143,240,255,.7);margin-top:-6px}
.hrs-track input::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #8ff0ff;box-shadow:0 0 12px rgba(143,240,255,.7)}
.hrs-track input:focus-visible{outline:2px solid #8ff0ff;outline-offset:4px;border-radius:4px}
.hrs-mark{position:absolute;top:7px;width:2px;height:12px;margin-left:-1px;border-radius:1px;pointer-events:none}
.hrs-mark.launch{background:#ffb454;box-shadow:0 0 6px #ffb454}
.hrs-mark.arrive{background:#8ff0ff;box-shadow:0 0 6px #8ff0ff}
.hrs-mark.now{background:#fff;opacity:.55}
.hrs-band{position:absolute;top:11px;height:4px;border-radius:2px;background:rgba(143,240,255,.28);pointer-events:none}
.hrs-legend{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;font-size:.68rem;color:var(--fg-3,#8b94ad);line-height:1.4}
.hrs-legend b{color:var(--fg-1,#f5f0ff);font-weight:600}
.hrs-legend .hrs-chip{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;transform:translateY(1px)}
.hrs-legend a{color:#8ff0ff;text-decoration:none;font-weight:600;margin-left:auto;white-space:nowrap}
.hrs-legend a:hover{text-decoration:underline}
.hrs-play{grid-column:2;justify-self:start;display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;border:0;
  color:#fff;font:inherit;font-size:.7rem;font-weight:700;letter-spacing:.04em;cursor:pointer;
  background:linear-gradient(180deg,#b765ff 0%,#9d3aff 45%,#7b00ee 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 -2px 0 rgba(60,0,140,.9) inset,0 4px 0 #4a0a9a,0 8px 18px rgba(157,58,255,.4);
  transition:transform .08s,box-shadow .12s,filter .2s}
.hrs-play:hover{filter:brightness(1.1);transform:translateY(-1px)}
.hrs-play:active{transform:translateY(3px);box-shadow:0 1px 0 rgba(255,255,255,.2) inset,0 -1px 0 rgba(60,0,140,.9) inset,0 1px 0 #4a0a9a,0 3px 8px rgba(157,58,255,.35)}
.hrs-play[aria-pressed="true"]{background:linear-gradient(180deg,#3a2a70 0%,#241650 55%,#150b36 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.16) inset,0 -2px 0 rgba(0,0,0,.5) inset,0 4px 0 #06031a,0 8px 18px rgba(2,0,10,.6)}
@media (max-width:640px){
  #hero-scrub{padding:8px 10px;grid-template-columns:1fr auto;gap:8px 10px}
  .hrs-mode{grid-column:1;font-size:.56rem;white-space:normal}
  .hrs-play{grid-column:2;justify-self:end}
  .hrs-tau{grid-column:1/-1;text-align:left;min-width:0}
  .hrs-legend .hrs-note{display:none}
  .hrs-legend a{margin-left:0}}
`;

function fmtUtc(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '—';
}
function fmtRel(ms, refMs) {
    const h = (ms - refMs) / HOUR;
    const sign = h < 0 ? '−' : '+';
    const a = Math.abs(h);
    return a >= 48 ? `T${sign}${(a / 24).toFixed(1)} d` : `T${sign}${a.toFixed(1)} h`;
}

/**
 * @param {object} opts
 * @param {object} opts.THREE      three.js namespace (injected — the hero owns the import)
 * @param {object} opts.scene      the hero scene
 * @param {number[]} opts.sunDir   unit Sun direction from Earth (hero-space-weather SUN_DIR)
 * @param {HTMLElement} opts.host  where the scrubber mounts (a sibling of #hero-stage)
 * @param {function(string):void} [opts.onFraming]  'corridor' while scrubbing/playing, 'earth' at rest
 * @param {function():Promise<object>} [opts.replay] async → forecast-shaped replay (Gannon); null disables
 */
export function createHeroRopeLayer({ THREE, scene, sunDir, host, onFraming = null, replay = null } = {}) {
    if (!THREE || !scene) throw new Error('createHeroRopeLayer: THREE and scene are required');

    const style = document.createElement('style');
    style.id = 'hero-rope-styles';
    style.textContent = CSS;
    document.head.appendChild(style);

    const basis = heroBasis(sunDir);
    const sunPos = [sunDir[0] * CORRIDOR_SUN_RE, sunDir[1] * CORRIDOR_SUN_RE, sunDir[2] * CORRIDOR_SUN_RE];

    const group = new THREE.Group();
    group.name = 'hero-cme-flux-rope-train';
    group.visible = false;
    scene.add(group);

    // The corridor's Sun: a bright disc + halo at the drawn Sun position.
    // Shown only in corridor framing (the resting shot has the sun sprite
    // at 70 R_E, off-frame, lighting Earth — this one is a MAP marker).
    const sunGroup = new THREE.Group();
    sunGroup.position.set(sunPos[0], sunPos[1], sunPos[2]);
    sunGroup.visible = false;
    // Limb-darkened photosphere (a flat MeshBasicMaterial read as a grey
    // ball beside the orange rope — measured) plus an additive halo that
    // skips the depth test: the sprite's plane sits at the Sun's CENTRE, so
    // with the test on the disc occluded its own halo.
    const sunDisc = new THREE.Mesh(
        new THREE.SphereGeometry(CORRIDOR_SUN_DRAWN_R, 40, 28),
        new THREE.ShaderMaterial({
            uniforms: { u_time: { value: 0 } },
            vertexShader: /* glsl */`
                varying vec3 vN; varying vec3 vV;
                void main(){
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vN = normalize(mat3(modelMatrix) * normal);
                    vV = normalize(cameraPosition - wp.xyz);
                    gl_Position = projectionMatrix * viewMatrix * wp;
                }`,
            fragmentShader: /* glsl */`
                precision highp float;
                varying vec3 vN; varying vec3 vV;
                void main(){
                    float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
                    float limb = 0.55 + 0.45 * pow(mu, 0.6);          // Eddington-ish limb darkening
                    vec3 col = mix(vec3(1.0, 0.62, 0.22), vec3(1.0, 0.96, 0.82), limb);
                    gl_FragColor = vec4(col * (0.42 + 0.30 * limb), 1.0);  // ≤0.72: under the bloom threshold, so the disc keeps its limb colour and the halo carries the glow
                }`,
            fog: false,
        }));
    sunGroup.add(sunDisc);
    const haloTex = radialTexture([
        [0.0, 'rgba(255,240,200,0.45)'], [0.18, 'rgba(255,200,110,0.50)'],
        [0.45, 'rgba(255,150,50,0.16)'], [1.0, 'rgba(255,120,30,0)'],
    ]);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: haloTex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0.6, fog: false,
    }));
    halo.scale.setScalar(CORRIDOR_SUN_DRAWN_R * 8);
    halo.renderOrder = 9;
    sunGroup.add(halo);
    scene.add(sunGroup);

    // Ecliptic ruler: rings at RULER_AU about the drawn Sun, in the rope
    // frame's e1–e2 plane. A depth cue that is also a scale bar; fades in
    // with the corridor mix.
    const rings = new THREE.Group();
    rings.visible = false;
    for (const rAu of RULER_AU) {
        const N = 128, pts = new Float32Array((N + 1) * 3);
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            const p = ropePointToHero([rAu * Math.cos(a), rAu * Math.sin(a), 0], basis, sunPos);
            pts[i * 3] = p[0]; pts[i * 3 + 1] = p[1]; pts[i * 3 + 2] = p[2];
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({
            color: rAu === 1 ? 0x8ff0ff : 0x9a85ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
        }));
        line.userData.baseOpacity = rAu === 1 ? 0.30 : 0.14;
        rings.add(line);
    }
    scene.add(rings);

    // Rope surface shader: a translucent plasma skin — Fresnel rim glow so
    // the tube reads as a volume, plus helical flow stripes (aPsi from the
    // grid's ψ index, aTheta from θ) drifting along the axis so the field's
    // twist is legible. Additive, no depth write, fog off.
    const ROPE_VERT = /* glsl */`
        attribute float aPsi;
        attribute float aTheta;
        varying vec3 vN; varying vec3 vV; varying float vPsi; varying float vTheta;
        void main(){
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - wp.xyz);
            vPsi = aPsi; vTheta = aTheta;
            gl_Position = projectionMatrix * viewMatrix * wp;
        }`;
    const ROPE_FRAG = /* glsl */`
        precision highp float;
        uniform vec3 u_color; uniform float u_opacity; uniform float u_time; uniform float u_twist;
        varying vec3 vN; varying vec3 vV; varying float vPsi; varying float vTheta;
        void main(){
            float mu = abs(dot(normalize(vN), normalize(vV)));
            float rim = pow(1.0 - mu, 1.6);
            // Helical stripes: phase advances with θ (twist) and drifts along ψ.
            float helix = 0.5 + 0.5 * sin(6.2831 * (vTheta * u_twist + vPsi * 3.0) - u_time * 0.9);
            float body = 0.10 + 0.55 * rim;
            float stripes = 0.35 * helix * (0.4 + 0.6 * rim);
            vec3 col = u_color * (body + stripes) + vec3(1.0) * rim * rim * 0.25;
            gl_FragColor = vec4(col, u_opacity * (0.35 + 1.4 * rim + 0.4 * stripes));
        }`;

    /** @type {null|object} the forecast being drawn (live or replay) */
    let fc = null;
    let cond = null;         // conditionsSeries(fc)
    let mixNow = 0;
    let mode = 'boot';        // 'live' | 'replay' | 'down' | 'boot'
    let ropes = [];
    let win = null;
    let tauMs = Date.now();
    let playing = false;
    let dragging = false;
    let framing = 'earth';
    let restTimer = 0;
    let autoTimer = 0;
    let held = false;         // hook-driven hold: corridor stays until release()
    let oneShot = false;      // the replay's first, self-started pass
    let lastKey = '';
    let lastLegendAt = 0;
    const LEGEND_MS = 400;
    /** Replay speed: one hour of transit per 0.35 s of wall clock. */
    const PLAY_H_PER_S = 1 / 0.35;
    /** After the pointer lets go, hold the corridor this long, then return. */
    const REST_MS = 6000;
    /** A replay plays itself ONCE this long after adoption — the entrance —
     *  then returns to the Earth shot. Live trains never move the camera
     *  uninvited. */
    const AUTOPLAY_DELAY_MS = 5000;

    // ── Scrubber DOM ──────────────────────────────────────────────────────
    const ui = document.createElement('div');
    ui.id = 'hero-scrub';
    ui.hidden = true;
    ui.setAttribute('aria-label', 'CME transit time scrubber');
    ui.innerHTML = `
        <span class="hrs-mode" data-mode="boot">CME train · connecting…</span>
        <button type="button" class="hrs-play" aria-label="Play the transit">▶ Play transit</button>
        <div class="hrs-tau"><span class="hrs-tau-rel">—</span><small class="hrs-tau-abs">—</small></div>
        <div class="hrs-track"><div class="hrs-band" hidden></div><input type="range" min="0" max="1000" step="1" value="0" aria-label="Transit time"></div>
        <div class="hrs-legend"></div>`;
    (host ?? document.body).appendChild(ui);
    const modeEl = ui.querySelector('.hrs-mode');
    const playBtn = ui.querySelector('.hrs-play');
    const relEl = ui.querySelector('.hrs-tau-rel');
    const absEl = ui.querySelector('.hrs-tau-abs');
    const track = ui.querySelector('.hrs-track');
    const band = ui.querySelector('.hrs-band');
    const slider = ui.querySelector('input');
    const legend = ui.querySelector('.hrs-legend');

    const sliderToTau = (v) => win ? win.t0 + (win.t1 - win.t0) * (v / 1000) : Date.now();
    const tauToSlider = (t) => win ? 1000 * (t - win.t0) / (win.t1 - win.t0) : 0;

    function setFraming(next) {
        if (framing === next) return;
        framing = next;
        onFraming?.(next);
    }

    function armRest() {
        clearTimeout(restTimer);
        restTimer = setTimeout(() => { if (!dragging && !playing && !held) setFraming('earth'); }, REST_MS);
    }

    function setTau(t, fromSlider = false, hold = false) {
        if (!win) return;
        if (hold) { held = true; clearTimeout(restTimer); }
        tauMs = Math.min(win.t1, Math.max(win.t0, t));
        if (!fromSlider) slider.value = String(Math.round(tauToSlider(tauMs)));
        const ref = win.arrivalMs ?? fc.launchMs;
        relEl.textContent = (win.arrivalMs ? 'arrival ' : 'launch ') + fmtRel(tauMs, ref);
        absEl.textContent = fmtUtc(tauMs);
        setFraming('corridor');
    }

    slider.addEventListener('input', () => { setTau(sliderToTau(+slider.value), true); });
    slider.addEventListener('pointerdown', () => { dragging = true; oneShot = false; clearTimeout(autoTimer); setPlaying(false); clearTimeout(restTimer); });
    const endDrag = () => { if (dragging) { dragging = false; armRest(); } };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('keydown', () => { setPlaying(false); armRest(); });
    playBtn.addEventListener('click', () => { oneShot = false; clearTimeout(autoTimer); setPlaying(!playing); });

    function setPlaying(on) {
        // Any explicit play/pause cancels the replay's pending self-start.
        clearTimeout(autoTimer);
        if (!on) oneShot = false;
        playing = !!on && !!win;
        playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play transit';
        playBtn.setAttribute('aria-pressed', String(playing));
        if (playing) { clearTimeout(restTimer); setFraming('corridor'); }
        else armRest();
    }

    function renderMarks() {
        for (const m of track.querySelectorAll('.hrs-mark')) m.remove();
        if (!win) return;
        const pct = (t) => `${(100 * (t - win.t0) / (win.t1 - win.t0)).toFixed(2)}%`;
        for (const l of win.launches) {
            const m = document.createElement('div'); m.className = 'hrs-mark launch';
            m.style.left = pct(l); m.title = 'launch ' + fmtUtc(l); track.appendChild(m);
        }
        if (win.arrivalMs) {
            const m = document.createElement('div'); m.className = 'hrs-mark arrive';
            m.style.left = pct(win.arrivalMs); m.title = 'arrival ' + fmtUtc(win.arrivalMs); track.appendChild(m);
        }
        const s = fc.summary;
        if (Number.isFinite(s?.arrivalP10Ms) && Number.isFinite(s?.arrivalP90Ms)) {
            band.hidden = false;
            band.style.left = pct(s.arrivalP10Ms);
            band.style.width = `calc(${pct(s.arrivalP90Ms)} - ${pct(s.arrivalP10Ms)})`;
        } else band.hidden = true;
        const now = Date.now();
        if (now > win.t0 && now < win.t1) {
            const m = document.createElement('div'); m.className = 'hrs-mark now';
            m.style.left = pct(now); m.title = 'now'; track.appendChild(m);
        }
    }

    // ── Rope draw slots ───────────────────────────────────────────────────
    function disposeRopes() {
        for (const r of ropes) {
            group.remove(r.root);
            r.mesh.geometry.dispose(); r.mesh.material.dispose();
            r.wire.geometry.dispose(); r.wire.material.dispose();
            r.nose.geometry.dispose(); r.nose.material.dispose();
        }
        ropes = [];
    }

    function adoptForecast(next, nextMode) {
        disposeRopes();
        fc = next;
        mode = nextMode;
        win = scrubWindow(fc);
        try { cond = fc ? conditionsSeries(fc) : null; }
        catch (e) { cond = null; console.info('[hero-rope] conditions unavailable:', e?.message ?? e); }
        lastKey = '';
        group.visible = !!(fc && win);
        ui.hidden = !group.visible;
        if (!group.visible) { modeEl.textContent = 'CME train · unavailable'; modeEl.dataset.mode = 'down'; return; }

        const list = fc.preset.ropes;
        list.forEach((rope, i) => {
            const color = ROPE_COLORS[i % ROPE_COLORS.length];
            const seed = ropeSurfaceGrid(
                { frame: { eDir: [1, 0, 0], eP: [0, 1, 0], nHat: [0, 0, 1] }, dAu: 1, sigApexAu: 0.1 },
                N_PSI, N_THETA);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seed.positions.length), 3));
            geo.setIndex(new THREE.BufferAttribute(seed.indices, 1));
            // ψ / θ lattice coordinates for the shader, fixed by (N_PSI, N_THETA).
            const nV = (N_PSI + 1) * (N_THETA + 1);
            const aPsi = new Float32Array(nV), aTheta = new Float32Array(nV);
            for (let ii = 0; ii <= N_PSI; ii++) for (let jj = 0; jj <= N_THETA; jj++) {
                const o = ii * (N_THETA + 1) + jj;
                aPsi[o] = ii / N_PSI; aTheta[o] = jj / N_THETA;
            }
            geo.setAttribute('aPsi', new THREE.BufferAttribute(aPsi, 1));
            geo.setAttribute('aTheta', new THREE.BufferAttribute(aTheta, 1));
            const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
                uniforms: {
                    u_color: { value: new THREE.Color(color) },
                    u_opacity: { value: 0.22 },
                    u_time: { value: 0 },
                    u_twist: { value: Math.max(1, Math.min(6, Math.abs(rope.twistTurns ?? 3))) * Math.sign(rope.handedness ?? 1) },
                },
                vertexShader: ROPE_VERT, fragmentShader: ROPE_FRAG,
                transparent: true, side: THREE.DoubleSide,
                depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
            }));
            mesh.renderOrder = 6;
            const wire = new THREE.LineSegments(new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, fog: false }));
            wire.renderOrder = 7;
            const nose = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10),
                new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, fog: false }));
            nose.renderOrder = 8;
            const root = new THREE.Group();
            root.visible = false;
            root.add(mesh, wire, nose);
            group.add(root);
            ropes.push({
                root, mesh, wire, nose, color, rope, index: i,
                launchMs: fc.launchMs + (rope.launchOffsetS ?? 0) * 1000,
                cme: fc.cmes?.[i] ?? null,
                scratch: new Float32Array(seed.positions.length),
                apexAu: NaN, oracle: null,
            });
        });

        modeEl.className = 'hrs-mode ' + (mode === 'live' ? 'live' : mode === 'down' ? 'down' : '');
        modeEl.dataset.mode = mode;
        modeEl.textContent = mode === 'live'
            ? `LIVE · CME train · ${list.length} rope${list.length > 1 ? 's' : ''}`
            : mode === 'down'
                ? 'LIVE FEED DOWN · replay · May 2024 G5'
                : 'REPLAY · May 2024 G5 · validated hindcast';
        renderMarks();
        // Live: rest at NOW so the drawn train is the current state. Replay:
        // start at the epoch so pressing Play shows the whole transit.
        const start = mode === 'live' ? Date.now() : win.t0 + 6 * HOUR;
        setTau(start);
        setFraming('earth');
        clearTimeout(restTimer);
        clearTimeout(autoTimer);
        if (mode !== 'live') {
            autoTimer = setTimeout(() => {
                if (dragging || playing || mode === 'live') return;
                oneShot = true;
                setPlaying(true);
            }, AUTOPLAY_DELAY_MS);
        }
        update(true);
    }

    // ── Provider wiring ───────────────────────────────────────────────────
    let replayPromise = null;
    async function adoptPublished(pub) {
        if (pub && !pub.idle && !pub.failed && pub.preset && Number.isFinite(pub.launchMs)) {
            adoptForecast(pub, 'live');
            return;
        }
        const down = !!pub?.failed;
        if (!replay) { adoptForecast(null, 'down'); return; }
        try {
            replayPromise ??= replay();
            const rf = await replayPromise;
            // A live train that landed while the replay was loading wins.
            if (fc && mode === 'live') return;
            adoptForecast(rf, down ? 'down' : 'replay');
        } catch (e) {
            console.info('[hero-rope] replay unavailable:', e?.message ?? e);
            adoptForecast(null, 'down');
        }
    }
    window.addEventListener('flux-rope-forecast', (ev) => { adoptPublished(ev.detail); }, { passive: true });
    if (window.__fluxRopeForecast) adoptPublished(window.__fluxRopeForecast);

    // ── Per-frame ─────────────────────────────────────────────────────────
    /**
     * Advance the replay clock (when playing) and place the train at τ.
     * Called by the hero's animate loop with the real frame dt.
     */
    function tick(dt) {
        if (!group.visible || !fc) return;
        const tNow = performance.now() / 1000;
        for (const r of ropes) r.mesh.material.uniforms.u_time.value = tNow;
        if (playing) {
            let t = tauMs + dt * PLAY_H_PER_S * HOUR;
            if (t >= win.t1) {
                if (oneShot) { oneShot = false; setPlaying(false); setTau(win.t0 + 6 * HOUR); return; }
                t = win.t0;   // loop
            }
            setTau(t);
        }
        update(false);
    }

    function update(force) {
        if (!group.visible || !fc || !Number.isFinite(tauMs)) return;
        const key = Math.round(tauMs / 60e3) + ':' + ropes.length + ':' + framing;
        const wantLegend = performance.now() - lastLegendAt >= LEGEND_MS;
        if (!force && key === lastKey && !wantLegend) return;
        lastKey = key;

        const train = trainAt(fc.preset, fc.launchMs, tauMs, fc.kernel);
        const byIndex = new Map(train.map((m) => [m.index, m]));
        const rows = [];
        for (const r of ropes) {
            const m = byIndex.get(r.index);
            if (!m) { r.root.visible = false; r.apexAu = NaN; r.oracle = null; rows.push({ r, txt: `launches ${fmtUtc(r.launchMs)}` }); continue; }
            const apexAu = m.geometry.dAu;
            r.apexAu = apexAu; r.oracle = m.geometry.oracle;
            if (apexAu >= PASSED_HIDE_AU) { r.root.visible = false; rows.push({ r, txt: 'passed Earth' }); continue; }
            r.root.visible = true;
            const { positions } = ropeSurfaceGrid(m.geometry, N_PSI, N_THETA);
            mapSurface(positions, basis, sunPos, r.scratch);
            const attr = r.mesh.geometry.attributes.position;
            attr.array.set(r.scratch);
            attr.needsUpdate = true;
            r.mesh.geometry.computeVertexNormals();
            r.mesh.geometry.computeBoundingSphere();
            r.wire.geometry.dispose();
            r.wire.geometry = new THREE.WireframeGeometry(r.mesh.geometry);
            const eDir = m.geometry.frame.eDir;
            const tip = ropePointToHero([eDir[0] * apexAu, eDir[1] * apexAu, eDir[2] * apexAu], basis, sunPos);
            r.nose.position.set(tip[0], tip[1], tip[2]);
            const fade = passedFade(apexAu);
            r.mesh.material.uniforms.u_opacity.value = 0.22 * fade;
            r.wire.material.opacity = 0.12 * fade;
            r.nose.material.opacity = 0.95 * fade;
            const v = fc.kernel?.apexVKmsAt ? Math.round(fc.kernel.apexVKmsAt(r.index, m.geometry.tS)) : null;
            rows.push({ r, txt: apexAu >= 1 ? 'at Earth' : `apex ${apexAu.toFixed(2)} AU${v ? ` · ${v} km/s` : ''}` });
        }
        if (wantLegend || force) { lastLegendAt = performance.now(); renderLegend(rows); }
    }

    function renderLegend(rows) {
        const chips = rows.map(({ r, txt }) => {
            const hex = '#' + r.color.toString(16).padStart(6, '0');
            const kms = Math.round(r.cme?.speedKms ?? r.rope.v0Kms ?? 0);
            return `<span><i class="hrs-chip" style="background:${hex}"></i><b>Rope ${r.index + 1}</b> · ${kms} km/s → ${txt}</span>`;
        }).join('');
        const mirrored = rows.some(({ r }) => r.oracle === 'mirror');
        const story = mode === 'live'
            ? 'Modeled from live NASA DONKI CMEs on the flux-rope kernel; arrival band = ensemble P10–P90.'
            : 'The May 2024 G5 superstorm as a 2-rope compounding train — the storm these forecasts were validated on (min Bz −44.3 vs −44.2 nT observed).';
        const c = conditionsAt(cond, tauMs);
        const condTxt = c ? `<span><b>At Earth</b> · Bz ${c.bz >= 0 ? '+' : ''}${c.bz.toFixed(0)} nT · ${Math.round(c.v)} km/s · Dst ${Math.round(c.dst)} nT · G${c.gLevel} (Kp proxy ${c.kp.toFixed(0)})</span>` : '';
        legend.innerHTML = `${chips}${condTxt}
            <span class="hrs-note">${story}${mirrored ? ' Some ropes on the mirror fallback.' : ''}
            Corridor radial scale compressed (Sun drawn ×${SUN_EXAGGERATION.toFixed(0)}); AU readouts are true. Dst is O'Brien–McPherron on the modeled L1 driver; Kp is a display proxy from Dst.</span>
            <a href="flux-rope-live.html" data-funnel-cta="hero_flux_rope">Open the Compounding Watch →</a>`;
    }

    const handle = {
        group, sunGroup, rings, tick, update,
        setTau, setPlaying,
        /** Release a hook-held corridor (setTau(t, false, true)); rests back to Earth. */
        release() { held = false; armRest(); },
        /** The hero's corridor mix (0 Earth … 1 corridor): fades the ruler + Sun marker. */
        setMix(m) {
            mixNow = Math.max(0, Math.min(1, m));
            rings.visible = mixNow > 0.02;
            for (const l of rings.children) l.material.opacity = l.userData.baseOpacity * mixNow;
            halo.material.opacity = 0.6 * mixNow;
            sunGroup.visible = mixNow > 0.02;
        },
        /** Modeled L1 conditions at the scrubbed instant, or null (no driver / outside the window). */
        conditionsAt(t = tauMs) { return conditionsAt(cond, t); },
        get tauMs() { return tauMs; },
        get hasConditions() { return !!cond; },
        get framing() { return framing; },
        get state() {
            return {
                mode, playing, framing, tauMs,
                ropeCount: ropes.length,
                drawn: ropes.filter((r) => r.root.visible).length,
                apexAu: ropes.map((r) => r.apexAu),
                oracle: ropes.map((r) => r.oracle),
                window: win,
                sunExaggeration: SUN_EXAGGERATION,
            };
        },
        dispose() {
            clearTimeout(restTimer); clearTimeout(autoTimer);
            disposeRopes(); scene.remove(group); scene.remove(sunGroup); scene.remove(rings); ui.remove(); style.remove();
        },
    };
    if (/[?&]debug=1(?:&|$)/.test(location.search)) window.__heroRopes = handle;
    return handle;

    function radialTexture(stops, size = 128) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const ctx = cv.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        for (const [off, col] of stops) g.addColorStop(off, col);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }
}
