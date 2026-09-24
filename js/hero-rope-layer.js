/**
 * hero-rope-layer.js — the Sun and its CMEs as FLUX-ROPE SURFACES in the
 * homepage hero, with the τ scrubber that plays them: "☉ Next 24 h" (the
 * default tab) and "CME transit".
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO TABS, ONE DRAWING (2026-09-24):
 *   · ☉ NEXT 24 H — the camera closes on the drawn Sun (`'sun'` framing in
 *     js/hero-space-weather.js) and τ runs NOW → NOW + 24 h. The Sun is
 *     js/hero-sun.js: today's NOAA regions (the existing /api/noaa/regions
 *     relay — nothing new fetched) as sunspot bipoles, plage and loop
 *     arcades carried by differential rotation, an active corona that
 *     brightens with the live GOES level, flashes at located flares. Every
 *     CME of the last 72 h in the DONKI catalogue the page's feed already
 *     carries — EVERY direction, not just Earth's — is handed to its own
 *     instance of the flux-rope KERNEL (WASM) through the provider's own
 *     converter (`donkiToTrainPreset`, §16 interaction on), and the kernel
 *     propagates them through the day (js/hero-sun-model.js chooses which;
 *     it computes no kinematics). A quiet catalogue draws NO rope. Marks on
 *     the track: Earth-directed ropes crossing 1 AU (the kernel's own apex
 *     probe) and regions setting behind the W limb. This preview plays
 *     itself ONCE after the hero's entrance, then returns to Earth.
 *   · CME TRANSIT — the shared provider's live Earth-relevant train or the
 *     Gannon replay, exactly as before (below), drawn on the corridor.
 * In both, a rope's SKIN is the kernel's own field: `kernel.fieldAt` Bz at
 * every surface vertex (red south, blue north — the Stage's convention),
 * normalised by the rope's axial field at its current apex; the identity
 * colour shows only where the kernel has nothing to say.
 *
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
 * Node gates: `node tests/hero-rope-layer.mjs` (the pure half — the frame
 * basis, the radial anchors, the scrub-window derivation, the replay
 * forecast shape) and `node tests/hero-sun-model.mjs` (the 24 h preview's
 * model, on the real WASM). Browser gate: `tests/home-hero-stage.spec.js`.
 * Test hook: `window.__heroRopes` under ?debug=1.
 */

import { trainAt } from './corridor/corridor-model.js';
import { ropeSurfaceGrid } from './stage/model.js';
import { stageRadius, EARTH_S, RSUN_KM, AU_KM } from './stage/scale.js';
import { integrateDst } from './ring-current-model.js';
import { createHeroSun, SPOT_SCALE } from './hero-sun.js';
import {
    OUTLOOK_HOURS, CME_LOOKBACK_H, outlookWindow, outlookMarks, latestRegions, activityCmes,
    buildOutlookForecast, regionAt, limbCrossingMs, activityHeat,
} from './hero-sun-model.js';
// The hero's colour rules: both raw shaders end in heroEmit (js/hero-color.js).
import { HERO_COLOR_GLSL } from './hero-color.js';

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

/** Rope skin colours by the KERNEL's Bz (js/stage/stage.js convention). */
const BZ_SOUTH = [0.95, 0.30, 0.18];
const BZ_NORTH = [0.15, 0.65, 0.95];
/** Field sampling cadence (kernel.fieldAt over every surface vertex). */
const FIELD_MS = 220;
/** Rope sheets closer than this to the camera fade out (hero units). */
const NEAR_FADE_RE = [7, 20];

const CSS = `
#hero-scrub{position:relative;z-index:2;display:grid;grid-template-columns:auto 1fr auto;gap:10px 14px;align-items:center;
  margin:0;padding:10px 14px;border-radius:14px;background:rgba(6,2,20,.72);border:1px solid rgba(154,133,255,.22);
  backdrop-filter:blur(8px);color:var(--fg-2,#cdd8f0);font-size:.74rem}
#hero-scrub[hidden]{display:none}
.hrs-tabs{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}
.hrs-tab{appearance:none;border:1px solid rgba(154,133,255,.28);background:rgba(20,12,48,.55);color:var(--fg-3,#8b94ad);
  font:inherit;font-size:.66rem;font-weight:700;letter-spacing:.05em;padding:5px 12px;border-radius:999px;cursor:pointer;
  transition:color .15s,border-color .15s,background .15s}
.hrs-tab:hover{color:#fff}
.hrs-tab[aria-selected="true"]{color:#fff;border-color:rgba(255,196,107,.75);
  background:linear-gradient(180deg,rgba(255,170,70,.30),rgba(255,120,40,.10));box-shadow:0 0 14px rgba(255,160,70,.22)}
.hrs-tab[data-tab="transit"][aria-selected="true"]{border-color:rgba(143,240,255,.7);
  background:linear-gradient(180deg,rgba(143,240,255,.22),rgba(80,160,255,.08));box-shadow:0 0 14px rgba(143,240,255,.2)}
.hrs-tab:disabled{opacity:.45;cursor:default}
.hrs-tab:focus-visible{outline:2px solid #8ff0ff;outline-offset:2px}
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
#hero-scrub[data-tab="outlook"] .hrs-track input::-webkit-slider-thumb{border-color:#ffc46b;box-shadow:0 0 12px rgba(255,196,107,.75)}
#hero-scrub[data-tab="outlook"] .hrs-track input::-moz-range-thumb{border-color:#ffc46b;box-shadow:0 0 12px rgba(255,196,107,.75)}
.hrs-mark{position:absolute;top:7px;width:2px;height:12px;margin-left:-1px;border-radius:1px;pointer-events:none}
.hrs-mark.launch{background:#ffb454;box-shadow:0 0 6px #ffb454}
.hrs-mark.arrive{background:#8ff0ff;box-shadow:0 0 6px #8ff0ff}
.hrs-mark.set{background:#ffd75e;box-shadow:0 0 6px #ffd75e;height:8px;top:9px}
.hrs-mark.now{background:#fff;opacity:.55}
.hrs-band{position:absolute;top:11px;height:4px;border-radius:2px;background:rgba(143,240,255,.28);pointer-events:none}
.hrs-legend{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;font-size:.68rem;color:var(--fg-3,#8b94ad);line-height:1.4}
.hrs-legend b{color:var(--fg-1,#f5f0ff);font-weight:600}
.hrs-legend .hrs-chip{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;transform:translateY(1px)}
.hrs-legend .hrs-bz{display:inline-block;width:18px;height:6px;border-radius:3px;margin:0 4px;transform:translateY(-1px);
  background:linear-gradient(90deg,rgb(242,77,46),rgb(89,107,158),rgb(38,166,242))}
.hrs-legend details.hrs-note{flex-basis:100%;order:9}
.hrs-legend details.hrs-note summary{cursor:pointer;color:var(--fg-3,#8b94ad);font-size:.64rem;letter-spacing:.04em;list-style:none}
.hrs-legend details.hrs-note summary::-webkit-details-marker{display:none}
.hrs-legend details.hrs-note summary::before{content:'ⓘ ';color:#ffc46b}
.hrs-legend details.hrs-note[open] summary{margin-bottom:3px}
.hrs-legend a{color:#8ff0ff;text-decoration:none;font-weight:600;white-space:nowrap}
.hrs-legend a:hover{text-decoration:underline}
.hrs-legend .hrs-links{margin-left:auto;display:inline-flex;gap:14px}
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
  .hrs-legend [data-rank="1"],.hrs-legend [data-rank="2"],.hrs-legend [data-crank="2"],.hrs-legend [data-crank="3"],
  .hrs-legend [data-crank="4"],.hrs-legend [data-crank="5"]{display:none}
  .hrs-legend .hrs-links{margin-left:0}}
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
function fmtDur(ms) {
    const h = ms / HOUR;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(h < 10 ? 1 : 0)} h`;
}
function fmtLoc(latDeg, lonDeg) {
    const la = Math.round(Math.abs(latDeg)), lo = Math.round(Math.abs(lonDeg));
    return `${latDeg < 0 ? 'S' : 'N'}${String(la).padStart(2, '0')}${lonDeg < 0 ? 'E' : 'W'}${String(lo).padStart(2, '0')}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} opts
 * @param {object} opts.THREE      three.js namespace (injected — the hero owns the import)
 * @param {object} opts.scene      the hero scene
 * @param {number[]} opts.sunDir   unit Sun direction from Earth (hero-space-weather SUN_DIR)
 * @param {HTMLElement} opts.host  where the scrubber mounts (a sibling of #hero-stage)
 * @param {function(string):void} [opts.onFraming]  'sun' (Next 24 h) / 'corridor' (transit) while
 *     scrubbing or playing, 'earth' at rest
 * @param {function():Promise<object>} [opts.replay] async → forecast-shaped replay (Gannon); null disables
 * @param {Promise<any>} [opts.autoplayGate] the 24 h preview's self-start waits for this (the hero
 *     passes its entrance: the camera must not be pulled away while it is still settling onto Earth)
 * @param {object} [opts.busState]  the latest swpc-update state (later ones arrive on the event)
 * @param {string} [opts.regionsUrl] NOAA region list (the existing relay; null disables)
 * @param {string} [opts.wasmUrl]   the flux-rope kernel for the 24 h preview
 */
export function createHeroRopeLayer({
    THREE, scene, sunDir, host, onFraming = null, replay = null, autoplayGate = null,
    busState = null, regionsUrl = '/api/noaa/regions', wasmUrl = './js/flux-rope-wasm/flux_rope_core.wasm',
} = {}) {
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

    // The drawn Sun: js/hero-sun.js — photosphere with today's regions,
    // their loop arcades, an impact-parameter corona, flare + liftoff glows.
    // Shown only in the corridor / Sun framings (the resting shot has the
    // sun sprite at 70 R_E, off-frame, lighting Earth — this one is the star
    // the ropes leave).
    const sunGroup = new THREE.Group();
    sunGroup.position.set(sunPos[0], sunPos[1], sunPos[2]);
    sunGroup.visible = false;
    const sun = createHeroSun({ THREE, parent: sunGroup, basis, radius: CORRIDOR_SUN_DRAWN_R });
    // Far glow: an additive halo that skips the depth test (its plane sits
    // at the Sun's CENTRE, so with the test on the disc occluded it).
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

    // Rope surface shader: a translucent plasma skin. Its COLOUR is the
    // flux-rope KERNEL's own field — `kernel.fieldAt` Bz sampled at every
    // surface vertex (red south, blue north; the Stage's convention),
    // normalised by the rope's axial field at its current apex so the
    // pattern reads the same at 0.1 AU and at 1 AU — with the per-rope
    // identity colour where the kernel has nothing to say (mirror fallback,
    // outside the boundary). Fresnel rim so the tube reads as a volume;
    // helical stripes (twist from the rope's own turns + handedness)
    // drifting along the axis. Additive, no depth write, fog off.
    const ROPE_VERT = /* glsl */`
        attribute float aPsi;
        attribute float aTheta;
        attribute vec4 aField;
        varying vec3 vN; varying vec3 vV; varying float vPsi; varying float vTheta; varying vec4 vField;
        varying float vCam;
        void main(){
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - wp.xyz);
            vCam = distance(cameraPosition, wp.xyz);
            vPsi = aPsi; vTheta = aTheta; vField = aField;
            gl_Position = projectionMatrix * viewMatrix * wp;
        }`;
    const ROPE_FRAG = /* glsl */`
        precision highp float;
        ${HERO_COLOR_GLSL}
        uniform vec3 u_color; uniform float u_opacity; uniform float u_time; uniform float u_twist;
        uniform vec2 u_near; uniform float u_mix;
        varying vec3 vN; varying vec3 vV; varying float vPsi; varying float vTheta; varying vec4 vField;
        varying float vCam;
        void main(){
            // A sheet passing right by the lens is not information: fade it
            // (only the Sun close-up is near enough for this to engage).
            float nearFade = smoothstep(u_near.x, u_near.y, vCam);
            float mu = abs(dot(normalize(vN), normalize(vV)));
            float rim = pow(1.0 - mu, 1.6);
            // Helical stripes: phase advances with theta (twist) and drifts along psi.
            float helix = 0.5 + 0.5 * sin(6.2831 * (vTheta * u_twist + vPsi * 3.0) - u_time * 0.9);
            float body = 0.12 + 0.55 * rim;
            float stripes = 0.35 * helix * (0.4 + 0.6 * rim);
            // Kernel field colour where sampled (vField.a = 1), identity colour otherwise.
            vec3 skin = mix(u_color, vField.rgb, vField.a * 0.85);
            vec3 col = skin * (body + stripes) + vec3(1.0) * rim * rim * 0.22;
            gl_FragColor = heroEmit(col, u_opacity * u_mix * nearFade * (0.38 + 1.4 * rim + 0.4 * stripes));
        }`;

    /** @type {'outlook'|'transit'} */
    let tab = 'outlook';
    // The CME TRANSIT tab: the shared provider's live train, or the Gannon replay.
    const transit = { fc: null, mode: 'boot', cond: null };
    // The NEXT 24 H tab: today's Sun + the engine propagating the recent CMEs.
    const outlook = {
        fc: null, regions: [], regionsState: regionsUrl ? 'loading' : 'off',
        cmeKey: null, bus: null, kernel: null, kernelPromise: null, marks: [], pending: 0,
    };

    /** @type {null|object} the forecast being drawn in the active tab */
    let fc = null;
    let cond = null;
    let mixNow = 0, sunMixNow = 0;
    // Ropes belong to the corridor / Sun framings: at the resting Earth shot
    // a rope near 1 AU would ENGULF the camera (measured: an Earth-directed
    // CME at 0.8 AU hid the planet entirely), so they fade in with the pull-out.
    let ropeMix = 0, ropesOn = false;
    const applyRopeMix = (r) => {
        r.mesh.material.uniforms.u_mix.value = ropeMix;
        r.wire.material.opacity = r.wireBase * ropeMix;
        r.nose.material.opacity = r.noseBase * ropeMix;
        // The apex marker is sized for the far corridor view; in the Sun
        // close-up (≈4.5× nearer) it would read as a ball beside the star.
        r.nose.scale.setScalar(1 - 0.78 * sunMixNow);
    };
    let ropes = [];
    let win = null;
    let tauMs = Date.now();
    let playing = false;
    let dragging = false;
    let framing = 'earth';
    let restTimer = 0;
    let autoTimer = 0;
    let autoToken = 0;        // bumps on every cancel, so a gated self-start that resolves late is void
    const gate = autoplayGate ?? Promise.resolve();
    let held = false;         // hook-driven hold: the framing stays until release()
    let oneShot = false;      // the preview's first, self-started pass
    let lastKey = '';
    let lastLegendAt = 0;
    let lastFieldAt = 0;
    let interacted = false;   // the visitor touched the scrubber: no self-start after that
    const LEGEND_MS = 400;
    /** Transit replay speed: one hour of transit per 0.35 s of wall clock. */
    const PLAY_H_PER_S = 1 / 0.35;
    /** 24 h preview speed: the whole day in 12 s. */
    const OUTLOOK_H_PER_S = OUTLOOK_HOURS / 12;
    /** After the pointer lets go, hold the framing this long, then return. */
    const REST_MS = 6000;
    /** The 24 h preview plays itself ONCE this long after the hero's
     *  entrance settles (`autoplayGate`), then returns to the Earth shot. */
    const AUTOPLAY_DELAY_MS = 5000;
    const cancelAuto = () => { clearTimeout(autoTimer); autoToken++; };

    // ── Scrubber DOM ──────────────────────────────────────────────────────
    const ui = document.createElement('div');
    ui.id = 'hero-scrub';
    ui.dataset.tab = tab;
    ui.setAttribute('aria-label', 'Solar activity and CME transit time scrubber');
    ui.innerHTML = `
        <div class="hrs-tabs" role="tablist" aria-label="Scrubber view">
          <button type="button" class="hrs-tab" role="tab" data-tab="outlook" aria-selected="true">☉ Next 24 h</button>
          <button type="button" class="hrs-tab" role="tab" data-tab="transit" aria-selected="false">CME transit</button>
        </div>
        <span class="hrs-mode" data-mode="boot">Sun · connecting…</span>
        <button type="button" class="hrs-play" aria-label="Play the next 24 hours">▶ Play next 24 h</button>
        <div class="hrs-tau"><span class="hrs-tau-rel">—</span><small class="hrs-tau-abs">—</small></div>
        <div class="hrs-track"><div class="hrs-band" hidden></div><input type="range" min="0" max="1000" step="1" value="0" aria-label="Time"></div>
        <div class="hrs-legend"></div>`;
    (host ?? document.body).appendChild(ui);
    const tabBtns = [...ui.querySelectorAll('.hrs-tab')];
    const modeEl = ui.querySelector('.hrs-mode');
    const playBtn = ui.querySelector('.hrs-play');
    const relEl = ui.querySelector('.hrs-tau-rel');
    const absEl = ui.querySelector('.hrs-tau-abs');
    const track = ui.querySelector('.hrs-track');
    const band = ui.querySelector('.hrs-band');
    const slider = ui.querySelector('input');
    const legend = ui.querySelector('.hrs-legend');
    // The legend body is re-rendered at LEGEND_MS; the disclosure's open
    // state must survive that or it snaps shut under the reader's cursor.
    let noteOpen = false;
    legend.addEventListener('toggle', (e) => { if (e.target?.matches?.('details.hrs-note')) noteOpen = e.target.open; }, true);
    const noteTag = (body) => `<details class="hrs-note"${noteOpen ? ' open' : ''}><summary>How this is drawn</summary>${body}</details>`;

    const sliderToTau = (v) => win ? win.t0 + (win.t1 - win.t0) * (v / 1000) : Date.now();
    const tauToSlider = (t) => win ? 1000 * (t - win.t0) / (win.t1 - win.t0) : 0;
    const activeFraming = () => (tab === 'outlook' ? 'sun' : 'corridor');

    function setFraming(next) {
        if (framing === next) return;
        framing = next;
        onFraming?.(next);
    }

    function armRest() {
        clearTimeout(restTimer);
        restTimer = setTimeout(() => { if (!dragging && !playing && !held) setFraming('earth'); }, REST_MS);
    }

    /** Move τ (and the readout) without touching the camera. */
    function placeTau(t, fromSlider = false) {
        if (!win) return;
        tauMs = Math.min(win.t1, Math.max(win.t0, t));
        if (!fromSlider) slider.value = String(Math.round(tauToSlider(tauMs)));
        if (tab === 'outlook') {
            relEl.textContent = `now ${fmtRel(tauMs, win.t0).replace(/^T/, '')}`;
        } else {
            const ref = win.arrivalMs ?? fc?.launchMs ?? win.t0;
            relEl.textContent = (win.arrivalMs ? 'arrival ' : 'launch ') + fmtRel(tauMs, ref);
        }
        absEl.textContent = fmtUtc(tauMs);
    }

    /** Scrub to τ: the camera goes to this tab's framing (Sun / corridor). */
    function setTau(t, fromSlider = false, hold = false) {
        if (!win) return;
        if (hold) { held = true; clearTimeout(restTimer); }
        placeTau(t, fromSlider);
        setFraming(activeFraming());
    }

    const touched = () => { interacted = true; oneShot = false; cancelAuto(); };
    slider.addEventListener('input', () => { setTau(sliderToTau(+slider.value), true); });
    slider.addEventListener('pointerdown', () => { dragging = true; touched(); setPlaying(false); clearTimeout(restTimer); });
    const endDrag = () => { if (dragging) { dragging = false; armRest(); } };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('keydown', () => { touched(); setPlaying(false); armRest(); });
    playBtn.addEventListener('click', () => { touched(); setPlaying(!playing); });
    for (const b of tabBtns) b.addEventListener('click', () => { touched(); setTab(b.dataset.tab, true); });

    function playLabel() {
        return playing ? '❚❚ Pause' : (tab === 'outlook' ? '▶ Play next 24 h' : '▶ Play transit');
    }

    function setPlaying(on) {
        // Any explicit play/pause cancels the pending self-start.
        cancelAuto();
        if (!on) oneShot = false;
        playing = !!on && !!win;
        if (playing && tab === 'outlook' && tauMs >= win.t1 - 60e3) setTau(win.t0);
        playBtn.textContent = playLabel();
        playBtn.setAttribute('aria-pressed', String(playing));
        playBtn.setAttribute('aria-label', tab === 'outlook' ? 'Play the next 24 hours' : 'Play the transit');
        if (playing) { clearTimeout(restTimer); setFraming(activeFraming()); }
        else armRest();
    }

    function renderMarks() {
        for (const m of track.querySelectorAll('.hrs-mark')) m.remove();
        band.hidden = true;
        if (!win) return;
        const pct = (t) => `${(100 * (t - win.t0) / (win.t1 - win.t0)).toFixed(2)}%`;
        const add = (cls, t, title) => {
            const m = document.createElement('div'); m.className = 'hrs-mark ' + cls;
            m.style.left = pct(t); m.title = title; track.appendChild(m);
        };
        if (tab === 'outlook') {
            for (const mk of outlook.marks) add(mk.kind === 'arrive' ? 'arrive' : 'set', mk.t, `${mk.label} · ${fmtUtc(mk.t)}`);
            return;
        }
        for (const l of win.launches) add('launch', l, 'launch ' + fmtUtc(l));
        if (win.arrivalMs) add('arrive', win.arrivalMs, 'arrival ' + fmtUtc(win.arrivalMs));
        const s = fc?.summary;
        if (Number.isFinite(s?.arrivalP10Ms) && Number.isFinite(s?.arrivalP90Ms)) {
            band.hidden = false;
            band.style.left = pct(s.arrivalP10Ms);
            band.style.width = `calc(${pct(s.arrivalP90Ms)} - ${pct(s.arrivalP10Ms)})`;
        }
        const now = Date.now();
        if (now > win.t0 && now < win.t1) add('now', now, 'now');
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

    function buildRopes(next) {
        disposeRopes();
        const list = next?.preset?.ropes ?? [];
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
            geo.setAttribute('aField', new THREE.BufferAttribute(new Float32Array(nV * 4), 4));
            const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
                uniforms: {
                    u_color: { value: new THREE.Color(color) },
                    u_opacity: { value: 0.22 },
                    u_time: { value: 0 },
                    u_twist: { value: Math.max(1, Math.min(6, Math.abs(rope.twistTurns ?? 3))) * Math.sign(rope.handedness ?? 1) },
                    u_near: { value: new THREE.Vector2(NEAR_FADE_RE[0], NEAR_FADE_RE[1]) },
                    u_mix: { value: 0 },
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
                launchMs: next.launchMs + (rope.launchOffsetS ?? 0) * 1000,
                cme: next.cmes?.[i] ?? null,
                scratch: new Float32Array(seed.positions.length),
                apexAu: NaN, oracle: null, fielded: false, wireBase: 0, noseBase: 0,
            });
        });
    }

    /**
     * Paint a rope's skin with the KERNEL's Bz at every surface vertex
     * (sampled just inside the boundary, σ×0.8, so the inside test never
     * flickers — the Stage's rule). Returns false when there is no kernel.
     */
    function colorRope(r, geometry) {
        const k = fc?.kernel;
        const attr = r.mesh.geometry.attributes.aField;
        if (!k || typeof k.fieldAt !== 'function' || geometry.oracle !== 'kernel') {
            if (r.fielded) { attr.array.fill(0); attr.needsUpdate = true; r.fielded = false; }
            return false;
        }
        const inner = { ...geometry, sigApexAu: geometry.sigApexAu * 0.8 };
        const { positions } = ropeSurfaceGrid(inner, N_PSI, N_THETA);
        const tTrain = geometry.tTrainS ?? geometry.tS;
        const bAxis = Math.max(1, Math.abs(r.rope.b1AuNt ?? 20) * Math.pow(Math.max(geometry.dAu, 0.05), -(r.rope.nB ?? 1.64)));
        const a = attr.array;
        const n = positions.length / 3;
        for (let i = 0; i < n; i++) {
            const f = k.fieldAt(tTrain, positions[i * 3] * AU_KM, positions[i * 3 + 1] * AU_KM, positions[i * 3 + 2] * AU_KM);
            const o = i * 4;
            if (f.inside && Number.isFinite(f.bz)) {
                const mag = Math.min(1, Math.abs(f.bz) / bAxis);
                const c = f.bz < 0 ? BZ_SOUTH : BZ_NORTH;
                const w = 0.35 + 0.65 * mag;
                a[o] = c[0] * w; a[o + 1] = c[1] * w; a[o + 2] = c[2] * w; a[o + 3] = 1;
            } else {
                a[o] = 0; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0;
            }
        }
        attr.needsUpdate = true;
        r.fielded = true;
        return true;
    }

    // ── Tabs ──────────────────────────────────────────────────────────────
    function renderChip() {
        let cls = '', text = '';
        if (tab === 'outlook') {
            const down = outlook.regionsState === 'down';
            cls = down ? 'down' : 'live';
            text = down ? 'Sun · next 24 h · regions feed down' : 'LIVE · Sun · next 24 h';
            modeEl.dataset.mode = down ? 'down' : 'live';
        } else {
            const n = fc?.preset?.ropes?.length ?? 0;
            modeEl.dataset.mode = transit.mode;
            cls = transit.mode === 'live' ? 'live' : transit.mode === 'down' ? 'down' : '';
            text = !fc ? (transit.mode === 'boot' ? 'CME train · connecting…' : 'CME train · unavailable')
                : transit.mode === 'live' ? `LIVE · CME train · ${n} rope${n > 1 ? 's' : ''}`
                    : transit.mode === 'down' ? 'LIVE FEED DOWN · replay · May 2024 G5'
                        : 'REPLAY · May 2024 G5 · validated hindcast';
        }
        modeEl.className = 'hrs-mode ' + cls;
        modeEl.textContent = text;
    }

    /**
     * Make `next` the active tab and draw its forecast. `keepTau` keeps the
     * scrubbed instant when the same tab's data refreshes under it.
     */
    function activate(next, { keepTau = false } = {}) {
        const changed = next !== tab;
        tab = next;
        ui.dataset.tab = tab;
        for (const b of tabBtns) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
        tabBtns.find((b) => b.dataset.tab === 'transit').disabled = !transit.fc && transit.mode === 'boot';
        const prevTau = tauMs;
        if (tab === 'outlook') {
            fc = outlook.fc;
            cond = null;
            win = outlookWindow(keepTau && win?.outlook ? win.t0 : Date.now());
            outlook.marks = outlookMarks(fc, win, outlook.regions);
            sun.setLive(true);
            sun.setLiftoffs(liftoffsOf(fc));
        } else {
            fc = transit.fc;
            cond = transit.cond;
            win = fc ? scrubWindow(fc) : null;
            sun.setLive(false);
            sun.setLiftoffs(liftoffsOf(fc));
        }
        buildRopes(fc);
        lastKey = '';
        ropesOn = !!(fc && win && ropes.length);
        group.visible = ropesOn && ropeMix > 0.02;
        renderChip();
        renderMarks();
        playBtn.textContent = playLabel();
        playBtn.setAttribute('aria-label', tab === 'outlook' ? 'Play the next 24 hours' : 'Play the transit');
        if (!win) { update(true); return; }
        // Outlook rests at NOW; a live train rests at now; a replay starts at
        // its epoch so pressing Play shows the whole transit.
        const start = keepTau && !changed ? prevTau
            : tab === 'outlook' ? win.t0
                : transit.mode === 'live' ? Date.now() : win.t0 + 6 * HOUR;
        placeTau(start);          // a data refresh never moves the camera
        update(true);
    }

    /** At rest, the preview's NOW follows the wall clock (no rebuild, no camera). */
    function rewindowOutlook() {
        win = outlookWindow(Date.now());
        outlook.marks = outlookMarks(fc, win, outlook.regions);
        renderMarks();
        placeTau(win.t0);
        lastKey = '';
    }

    /** Public: switch tabs. A visitor's click also flies the camera there. */
    function setTab(next, fly = false) {
        if (next !== 'outlook' && next !== 'transit') return;
        if (next === 'transit' && !transit.fc && transit.mode === 'boot') return;
        setPlaying(false);
        activate(next);
        if (fly) { setFraming(activeFraming()); armRest(); }
        else setFraming('earth');
    }

    function liftoffsOf(f) {
        const list = f?.preset?.ropes ?? [];
        return list.map((r) => ({
            launchMs: f.launchMs + (r.launchOffsetS ?? 0) * 1000,
            latDeg: r.latDeg ?? 0, lonDeg: r.lonDeg ?? 0,
        }));
    }

    // ── Transit tab wiring (the shared provider) ──────────────────────────
    function adoptTransit(next, nextMode) {
        transit.fc = next;
        transit.mode = nextMode;
        try { transit.cond = next ? conditionsSeries(next) : null; }
        catch (e) { transit.cond = null; console.info('[hero-rope] conditions unavailable:', e?.message ?? e); }
        tabBtns.find((b) => b.dataset.tab === 'transit').disabled = false;
        if (tab === 'transit') activate('transit');
    }

    let replayPromise = null;
    async function adoptPublished(pub) {
        if (pub && !pub.idle && !pub.failed && pub.preset && Number.isFinite(pub.launchMs)) {
            adoptTransit(pub, 'live');
            return;
        }
        const down = !!pub?.failed;
        if (!replay) { adoptTransit(null, 'down'); return; }
        try {
            replayPromise ??= replay();
            const rf = await replayPromise;
            // A live train that landed while the replay was loading wins.
            if (transit.fc && transit.mode === 'live') return;
            adoptTransit(rf, down ? 'down' : 'replay');
        } catch (e) {
            console.info('[hero-rope] replay unavailable:', e?.message ?? e);
            adoptTransit(null, 'down');
        }
    }
    window.addEventListener('flux-rope-forecast', (ev) => { adoptPublished(ev.detail); }, { passive: true });
    if (window.__fluxRopeForecast) adoptPublished(window.__fluxRopeForecast);

    // ── Next 24 h wiring: today's regions + the engine on the recent CMEs ──
    async function loadRegions() {
        if (!regionsUrl) return;
        try {
            const res = await fetch(regionsUrl, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const payload = await res.json();
            outlook.regions = latestRegions(payload?.data?.regions ?? payload?.regions ?? []);
            outlook.regionsState = 'ok';
        } catch (e) {
            // Down must LOOK down: no invented spots, and the chip says so.
            outlook.regions = [];
            outlook.regionsState = 'down';
            console.info('[hero-sun] regions unavailable:', e?.message ?? e);
        }
        sun.setRegions(outlook.regions);
        if (tab === 'outlook') activate('outlook', { keepTau: true });
    }

    async function ensureKernel() {
        if (outlook.kernel) return outlook.kernel;
        outlook.kernelPromise ??= import('./flux-rope-kernel.js').then((m) => m.loadFluxRopeKernel(wasmUrl));
        outlook.kernel = await outlook.kernelPromise;
        return outlook.kernel;
    }

    /** The live bus (js/swpc-feed.js state): X-ray, flares, and the CME catalogue. */
    async function setBusState(state) {
        if (!state) return;
        outlook.bus = state;
        sun.setBus(state);
        const now = Date.now();
        const cmes = activityCmes(state.recent_cmes, now);
        const key = cmes.map((c) => c.timeIso + ':' + Math.round(c.speedKms)).join('|');
        if (key === outlook.cmeKey && outlook.fc) { lastKey = ''; return; }
        outlook.cmeKey = key;
        let next;
        try {
            outlook.pending = cmes.length && !outlook.kernel ? cmes.length : 0;
            if (outlook.pending) lastKey = '';
            const kernel = cmes.length ? await ensureKernel() : null;
            outlook.pending = 0;
            if (key !== outlook.cmeKey) return;          // a newer catalogue won the race
            const w = Number(state.solar_wind?.speed);
            next = buildOutlookForecast(kernel, cmes, now, { ambientWKms: w > 200 && w < 1500 ? w : 400 });
        } catch (e) {
            outlook.pending = 0;
            console.info('[hero-sun] flux-rope kernel unavailable:', e?.message ?? e);
            next = buildOutlookForecast(null, [], now);
            next.kernelDown = true;
        }
        outlook.fc = next;
        if (tab === 'outlook') activate('outlook', { keepTau: true });
    }
    window.addEventListener('swpc-update', (ev) => { setBusState(ev.detail); }, { passive: true });
    if (busState) setBusState(busState);
    else if (!outlook.fc) outlook.fc = buildOutlookForecast(null, [], Date.now());
    loadRegions();
    const regionsTimer = regionsUrl ? setInterval(loadRegions, 15 * 60e3) : 0;

    // The 24 h preview plays itself ONCE after the entrance — unless the
    // visitor got to the scrubber first.
    {
        const token = autoToken;
        gate.then(() => {
            if (token !== autoToken || interacted) return;
            autoTimer = setTimeout(() => {
                if (interacted || dragging || playing || held) return;
                if (tab !== 'outlook') return;
                activate('outlook');
                setPlaying(true);
                oneShot = true;
            }, AUTOPLAY_DELAY_MS);
        });
    }

    // ── Per-frame ─────────────────────────────────────────────────────────
    /**
     * Advance the clock (when playing) and place the train + the Sun at τ.
     * Called by the hero's animate loop with the real frame dt.
     */
    function tick(dt) {
        const tNow = performance.now() / 1000;
        if (sunGroup.visible) sun.tick(tNow);
        if (!win) return;
        for (const r of ropes) r.mesh.material.uniforms.u_time.value = tNow;
        if (playing) {
            const rate = tab === 'outlook' ? OUTLOOK_H_PER_S : PLAY_H_PER_S;
            let t = tauMs + dt * rate * HOUR;
            if (t >= win.t1) {
                if (oneShot) {
                    oneShot = false; setPlaying(false); placeTau(tab === 'outlook' ? win.t0 : win.t0 + 6 * HOUR);
                    setFraming('earth');
                    return;
                }
                t = win.t0;   // loop
            }
            setTau(t);
        } else if (tab === 'outlook' && framing === 'earth' && !dragging && !held && Date.now() - win.t0 > 60e3) {
            rewindowOutlook();
        }
        update(false);
    }

    function update(force) {
        if (!Number.isFinite(tauMs)) return;
        sun.update(tauMs, force);
        if (!fc || !win) { if (force) renderLegend([]); return; }
        const key = Math.round(tauMs / 60e3) + ':' + ropes.length + ':' + framing;
        const now = performance.now();
        const wantLegend = now - lastLegendAt >= LEGEND_MS;
        if (!force && key === lastKey && !wantLegend) return;
        lastKey = key;
        const wantField = force || now - lastFieldAt >= FIELD_MS;
        if (wantField) lastFieldAt = now;

        const train = ropes.length ? trainAt(fc.preset, fc.launchMs, tauMs, fc.kernel) : [];
        const byIndex = new Map(train.map((m) => [m.index, m]));
        const rows = [];
        for (const r of ropes) {
            const m = byIndex.get(r.index);
            if (!m) { r.root.visible = false; r.apexAu = NaN; r.oracle = null; rows.push({ r, txt: `launches ${fmtUtc(r.launchMs)}` }); continue; }
            const apexAu = m.geometry.dAu;
            r.apexAu = apexAu; r.oracle = m.geometry.oracle;
            if (apexAu >= PASSED_HIDE_AU) { r.root.visible = false; rows.push({ r, txt: 'passed 1 AU' }); continue; }
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
            if (wantField) colorRope(r, m.geometry);
            // Fade in over the first 40 min of flight (the kernel starts a
            // rope at the 21.5 R☉ launch surface), out past 1 AU.
            const flightMin = (tauMs - r.launchMs) / 60e3;
            const fade = passedFade(apexAu) * Math.min(1, Math.max(0.15, flightMin / 40));
            r.mesh.material.uniforms.u_opacity.value = 0.22 * fade;
            r.wireBase = (r.fielded ? 0.07 : 0.12) * fade;
            r.noseBase = 0.95 * fade;
            applyRopeMix(r);
            const tTrain = m.geometry.tTrainS ?? m.geometry.tS;
            const v = fc.kernel?.apexVKmsAt ? Math.round(fc.kernel.apexVKmsAt(r.index, tTrain)) : null;
            rows.push({ r, txt: apexAu >= 1 ? 'at 1 AU' : tab === 'outlook' ? `${apexAu.toFixed(2)} AU` : `apex ${apexAu.toFixed(2)} AU${v ? ` · ${v} km/s` : ''}` });
        }
        if (wantLegend || force) { lastLegendAt = now; renderLegend(rows); }
    }

    function ropeDirection(r) {
        if (r.cme?.earthDirected) return '→ Earth';
        const lon = r.rope.lonDeg ?? 0, lat = r.rope.latDeg ?? 0;
        return `→ ${fmtLoc(lat, lon)}`;
    }

    function renderLegend(rows) {
        const links = `<span class="hrs-links">${tab === 'outlook' ? '<a href="sun.html" data-funnel-cta="hero_sun_outlook">Open the live Sun →</a>' : ''}<a href="flux-rope-live.html" data-funnel-cta="hero_flux_rope">Open the Compounding Watch →</a></span>`;
        if (tab === 'outlook') {
            legend.innerHTML = outlookLegend(rows) + links;
            return;
        }
        const chips = rows.map(({ r, txt }) => {
            const hex = '#' + r.color.toString(16).padStart(6, '0');
            const kms = Math.round(r.cme?.speedKms ?? r.rope.v0Kms ?? 0);
            return `<span><i class="hrs-chip" style="background:${hex}"></i><b>Rope ${r.index + 1}</b> · ${kms} km/s → ${txt}</span>`;
        }).join('');
        const mirrored = rows.some(({ r }) => r.oracle === 'mirror');
        const story = transit.mode === 'live'
            ? 'Modeled from live NASA DONKI CMEs on the flux-rope kernel; arrival band = ensemble P10–P90.'
            : 'The May 2024 G5 superstorm as a 2-rope compounding train — the storm these forecasts were validated on (min Bz −44.3 vs −44.2 nT observed).';
        const c = conditionsAt(cond, tauMs);
        const condTxt = c ? `<span><b>At Earth</b> · Bz ${c.bz >= 0 ? '+' : ''}${c.bz.toFixed(0)} nT · ${Math.round(c.v)} km/s · Dst ${Math.round(c.dst)} nT · G${c.gLevel} (Kp proxy ${c.kp.toFixed(0)})</span>` : '';
        legend.innerHTML = `${chips}${condTxt}
            ${noteTag(`${story}${mirrored ? ' Some ropes on the mirror fallback.' : ''}
            Skin <i class="hrs-bz"></i> = the kernel's own Bz (red south, blue north). Corridor radial scale compressed (Sun drawn ×${SUN_EXAGGERATION.toFixed(0)}); AU readouts are true. Dst is O'Brien–McPherron on the modeled L1 driver; Kp is a display proxy from Dst.`)}
            ${links}`;
    }

    function outlookLegend(rows) {
        const bus = outlook.bus;
        const cls = bus?.xray_class ? esc(bus.xray_class) : null;
        const parts = [];
        if (cls) parts.push(`<span><b>GOES X-ray</b> · ${cls} now</span>`);
        // The regions that matter most for the next day, by their glow.
        const regs = outlook.regions.slice().sort((a, b) => activityHeat(b) - activityHeat(a)).slice(0, 3);
        for (const [k, reg] of regs.entries()) {
            const at = regionAt(reg, tauMs);
            const pm = Number.isFinite(reg.pM) ? `M ${Math.round(reg.pM * 100)}%` : null;
            const px = Number.isFinite(reg.pX) ? `X ${Math.round(reg.pX * 100)}%` : null;
            const odds = [pm, px].filter(Boolean).join(' · ');
            const set = limbCrossingMs(reg, tauMs, win.t1 - tauMs);
            const where = !at.earthFacing ? 'behind the W limb' : set ? `sets in ${fmtDur(set - tauMs)}` : fmtLoc(at.latDeg, at.lonDeg);
            parts.push(`<span data-rank="${k}"><b>AR ${esc(reg.region)}</b>${reg.complex ? ' δγ' : ''} · ${where}${odds ? ` · ${odds} / 24 h` : ''}</span>`);
        }
        if (outlook.regionsState === 'ok' && !outlook.regions.length) parts.push('<span><b>No numbered regions</b> on the disc today</span>');
        // Newest CMEs first in the list (the fresh eruptions are the story).
        rows.slice().reverse().forEach(({ r, txt }, k) => {
            const hex = '#' + r.color.toString(16).padStart(6, '0');
            const kms = Math.round(r.cme?.speedKms ?? r.rope.v0Kms ?? 0);
            parts.push(`<span data-crank="${k}"><i class="hrs-chip" style="background:${hex}"></i><b>CME ${r.index + 1}</b> · ${kms} km/s ${ropeDirection(r)} · ${txt}</span>`);
        });
        const nCme = fc?.preset?.ropes?.length ?? 0;
        if (!nCme) {
            // Four different reasons for an empty sky — never let them read alike.
            parts.push(!bus ? '<span><b>CME catalogue</b> · waiting for the live feed…</span>'
                : !bus.donki_cme_at ? '<span><b>CME catalogue (DONKI) not received</b> — no ropes drawn</span>'
                    : outlook.pending ? `<span><b>Loading the flux-rope kernel</b> for ${outlook.pending} CME${outlook.pending > 1 ? 's' : ''}…</span>`
                        : outlook.fc?.kernelDown ? '<span><b>Flux-rope kernel unavailable</b> — no CMEs propagated</span>'
                            : `<span><b>No CMEs</b> in DONKI's catalogue in the last ${CME_LOOKBACK_H} h — nothing in flight to propagate</span>`);
        }
        const probs = outlook.regions.some((r) => Number.isFinite(r.pM));
        parts.push(noteTag(`Regions sit at NOAA's reported positions, carried forward by differential rotation; spots, loops and corona are a schematic of each region (Joy's-law bipole, size ~ √area, glow ~ ${probs ? "SWPC's 24 h M/X odds" : 'complexity + area'}). CMEs: the last ${CME_LOOKBACK_H} h of DONKI cone fits, every direction, propagated by the flux-rope kernel (DBM, §16 interaction on); skin <i class="hrs-bz"></i> = the kernel's Bz. Sun drawn ×${SUN_EXAGGERATION.toFixed(0)}, spots ×${SPOT_SCALE}, axis along ecliptic north.`));
        return parts.join('');
    }

    const handle = {
        group, sunGroup, rings, sun, tick, update,
        setTau, setPlaying, setTab, setBusState,
        /** Release a hook-held framing (setTau(t, false, true)); rests back to Earth. */
        release() { held = false; armRest(); },
        /**
         * The hero's framing mixes (0 Earth … 1 corridor / Sun close-up):
         * fade the ruler with the corridor, the Sun's dressing with either.
         */
        setMix(corr, sunM = 0) {
            mixNow = Math.max(0, Math.min(1, corr));
            sunMixNow = Math.max(0, Math.min(1, sunM));
            const any = Math.max(mixNow, sunMixNow);
            ropeMix = any;
            group.visible = ropesOn && any > 0.02;
            for (const r of ropes) applyRopeMix(r);
            rings.visible = mixNow > 0.02;
            for (const l of rings.children) l.material.opacity = l.userData.baseOpacity * mixNow;
            // The far halo is for the corridor's small Sun; the close-up has its own corona.
            halo.material.opacity = 0.6 * mixNow * (1 - 0.8 * sunMixNow);
            sunGroup.visible = any > 0.02;
            sun.setVisibility(any);
        },
        /** Modeled L1 conditions at the scrubbed instant, or null (no driver / outside the window / outlook tab). */
        conditionsAt(t = tauMs) { return conditionsAt(cond, t); },
        get tauMs() { return tauMs; },
        get hasConditions() { return !!cond; },
        get framing() { return framing; },
        get tab() { return tab; },
        get state() {
            return {
                tab,
                mode: transit.mode, playing, framing, tauMs,
                ropeCount: ropes.length,
                drawn: ropes.filter((r) => r.root.visible).length,
                fielded: ropes.filter((r) => r.root.visible && r.fielded).length,
                apexAu: ropes.map((r) => r.apexAu),
                oracle: ropes.map((r) => r.oracle),
                window: win,
                transitRopes: transit.fc?.preset?.ropes?.length ?? 0,
                outlook: {
                    regions: outlook.regions.length,
                    regionsState: outlook.regionsState,
                    cmes: outlook.fc?.preset?.ropes?.length ?? 0,
                    marks: outlook.marks.length,
                },
                sun: sun.state,
                sunExaggeration: SUN_EXAGGERATION,
            };
        },
        dispose() {
            clearTimeout(restTimer); cancelAuto(); clearInterval(regionsTimer);
            disposeRopes(); sun.dispose();
            scene.remove(group); scene.remove(sunGroup); scene.remove(rings); ui.remove(); style.remove();
        },
    };
    activate('outlook');
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
