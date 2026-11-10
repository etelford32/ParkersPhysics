/**
 * sun-temp.js — what a slope's own sunlight and shade do to its air temperature. PURE.
 *
 * terrain-temp.js moves GFS's temperature to the real HEIGHT. Two points at
 * the same height are still not the same temperature: one faces the morning
 * Sun, the other sits in a ridge's shadow until ten o'clock. This module adds
 * that term, and only that term:
 *
 *     ΔT(t) = M(U) / h · ∫ ΔQ(t′) · e^(−(t−t′)/τ) dt′/τ
 *
 *   ΔQ   the ANOMALY in absorbed direct sunlight, W/m²: this slope's beam
 *        (zero while a ridge shades it — sun-terrain.js) MINUS what flat,
 *        unshaded ground receives at the same instant. It is the SAME
 *        radiation model the slope-wind layer uses (slope-wind.js:
 *        Meinel beam, Kasten–Young air mass, Kasten–Czeplak cloud, ALBEDO) —
 *        imported, never retyped. The difference from flat ground is the
 *        point: GFS already heats its own (flat, 25 km) surface, so adding a
 *        slope's WHOLE budget would count the Sun twice. Flat unshaded ground
 *        gets exactly 0 from this module (gated as an identity).
 *   h    slope-wind.js H_DAY, the daytime surface-to-air transfer coefficient.
 *        With it a steep sun-facing slope under a low Sun is ~1–2 K warmer
 *        and a shaded one ~1–1.5 K cooler than flat ground — the size of the
 *        2 m AIR differences measured between opposing slopes (the ground's
 *        own skin differs by far more; this is not a skin temperature).
 *   τ    a thermal MEMORY (MEMORY.tauS, 1.5 h): air near a slope warms and
 *        cools over an hour or two, not instantly. It is why a valley stays
 *        cold for a while after the shadow leaves it and why west slopes peak
 *        after the Sun has moved on. The integral is evaluated EXACTLY for
 *        ΔQ held constant across each interval (memorySamples: the weights
 *        are differences of the exponential, so they sum to 1 − e^(−T/τ) and
 *        a constant ΔQ is reproduced to that factor — gated).
 *   M    wind mixing, 1/(1 + U/WIND_MIX_MS): a breeze stirs slope air into
 *        its surroundings and local differences shrink. U is GFS's 10 m wind.
 *
 * WHAT IT IS — a MODELLED adjustment, and every surface says so. The sign,
 * the timing (east faces first, the lag behind the Sun) and the pattern
 * (which slopes, which valleys) come from real geometry and the real Sun.
 * The SIZE rides three fixed, disclosed constants (h, τ, the mixing speed)
 * and is an order of magnitude, like the slope winds'. It is capped at
 * ±AMP_CAP_K so a pathological cell cannot paint a number nobody would
 * believe.
 *
 * WHAT IT DOES NOT DO: night. With the Sun down ΔQ is 0 and the term decays
 * away; nocturnal cold-air pooling — the larger night-time effect in real
 * valleys — is cold-pool.js, a separate term the map adds beside this one.
 * No snow albedo, no vegetation, no diffuse-sky or reflected light; one cloud
 * fraction (the instant on show) for the whole memory window; one Sun
 * position per sample for the whole grid.
 *
 * Node gate: tests/climalytix-sun-temp.mjs.
 */
import { beamIrradiance, cloudTransmission, ALBEDO, H_DAY } from './slope-wind.js';
import { incidence, EXPOSURE_SHADE, EXPOSURE_SUN } from './terrain.js';

const D2R = Math.PI / 180;
export const MEMORY = Object.freeze({ tauS: 5400, stepS: 3600, intervals: 5 });
export const WIND_MIX_MS = 5;
export const AMP_CAP_K = 6;
export const H_AIR = H_DAY;

/**
 * ΔQ, W/m²: absorbed direct beam on this slope minus on flat unshaded ground.
 * `shaded` = a ridge blocks the Sun here. Sun down ⇒ 0 (night is not an anomaly).
 */
export function beamAnomaly({ slopeDeg = 0, aspectDeg = NaN, sun, shaded = false, cloudFrac = 0 }) {
    const alt = sun?.altitudeDeg;
    if (!(alt > 0)) return 0;
    const c = Number.isFinite(cloudFrac) ? cloudFrac : 0;
    const flat = Math.sin(alt * D2R);
    const mine = shaded ? 0 : incidence(Number.isFinite(slopeDeg) ? slopeDeg : 0, aspectDeg, alt, sun.azimuthDeg);
    return (1 - ALBEDO) * beamIrradiance(alt) * cloudTransmission(c) * (mine - flat);
}

/** Wind mixing factor in (0, 1]; an unknown wind mixes nothing (the result is then an upper bound). */
export function windMixing(speedMs) {
    return Number.isFinite(speedMs) && speedMs > 0 ? 1 / (1 + speedMs / WIND_MIX_MS) : 1;
}

/**
 * The memory integral's sample plan for instant tMs: intervals [a, b] going
 * back from t, each with the instant `at` its ΔQ is evaluated (its midpoint)
 * and its EXACT weight e^(−(t−b)/τ) − e^(−(t−a)/τ).
 * The newest interval runs from the last whole step mark to t; the older ones
 * are whole steps on ABSOLUTE marks, so two nearby instants share them (the
 * caller caches a shadow grid per `at`). Returns newest first.
 */
export function memorySamples(tMs, { tauS = MEMORY.tauS, stepS = MEMORY.stepS, intervals = MEMORY.intervals } = {}) {
    const step = stepS * 1000, tau = tauS * 1000;
    const m0 = Math.floor(tMs / step) * step;
    const w = (a, b) => Math.exp(-(tMs - b) / tau) - Math.exp(-(tMs - a) / tau);
    const out = [];
    if (tMs > m0) out.push({ a: m0, b: tMs, at: Math.round((m0 + tMs) / 2 / 600_000) * 600_000, w: w(m0, tMs) });
    for (let k = 0; k < intervals; k++) {
        const b = m0 - k * step, a = b - step;
        out.push({ a, b, at: a + step / 2, w: w(a, b) });
    }
    return out;
}

/** ΔT (K) at one point from its ΔQ history: Σ wₖ·ΔQₖ / h × mixing, capped. `dq[k]` pairs with `samples[k]`. */
export function sunTempAt(samples, dq, { windMs = null } = {}) {
    let s = 0;
    for (let k = 0; k < samples.length; k++) s += samples[k].w * (dq[k] || 0);
    const v = (s / H_AIR) * windMixing(windMs);
    return Math.max(-AMP_CAP_K, Math.min(AMP_CAP_K, v));
}

/**
 * ΔT over a DEM grid.
 * @param g   the DEM grid (terrain.js sampleGrid)
 * @param sa  its slopeAspect
 * @param o.samples  memorySamples(t) each extended with { sun:{altitudeDeg,azimuthDeg}, mask } — mask from
 *                   sun-terrain.js shadowGrid for that sample's Sun (1 shaded, 0 lit, 255 no terrain), or null
 * @param o.cloudAt  (lat, lon) → cloud fraction 0..1 | null   (null everywhere ⇒ clear sky: an UPPER bound)
 * @param o.windAt   (lat, lon) → 10 m wind speed m/s | null   (null ⇒ no mixing: an upper bound)
 * @returns {{ values:Float32Array, range:{min,max}|null, daylight:boolean }}
 *          values NaN where there is no terrain; `daylight` false when every sample has the Sun down
 */
export function sunTempGrid(g, sa, { samples, cloudAt = null, windAt = null }) {
    const n = g.nRows * g.nCols, values = new Float32Array(n).fill(NaN);
    const live = samples.filter((s) => s.sun?.altitudeDeg > 0 && s.w > 0);
    // Per-sample constants (one Sun for the grid): the beam and the flat-ground cosine.
    const pre = live.map((s) => ({ s, k: (1 - ALBEDO) * beamIrradiance(s.sun.altitudeDeg), flat: Math.sin(s.sun.altitudeDeg * D2R) }));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        for (let j = 0; j < g.nCols; j++) {
            const k = i * g.nCols + j;
            if (!Number.isFinite(g.values[k])) continue;
            let acc = 0;
            if (pre.length) {
                const slope = Number.isFinite(sa.slope[k]) ? sa.slope[k] : 0, asp = sa.aspect[k];
                for (const p of pre) {
                    const shaded = p.s.mask ? p.s.mask[k] === 1 : false;
                    const mine = shaded ? 0 : incidence(slope, asp, p.s.sun.altitudeDeg, p.s.sun.azimuthDeg);
                    acc += p.s.w * p.k * (mine - p.flat);
                }
                if (acc !== 0) {
                    const lon = g.lonW + j * g.dlon;
                    const c = cloudAt ? cloudAt(lat, lon) : null;
                    acc *= cloudTransmission(Number.isFinite(c) ? c : 0) / H_AIR * windMixing(windAt ? windAt(lat, lon) : null);
                    acc = Math.max(-AMP_CAP_K, Math.min(AMP_CAP_K, acc));
                }
            }
            values[k] = acc;
            if (acc < lo) lo = acc;
            if (acc > hi) hi = acc;
        }
    }
    return { values, range: lo <= hi ? { min: lo, max: hi } : null, daylight: pre.length > 0 };
}

// ── The effect on its own (the map's "Sun & shade effect" view) ─────────────
// On a temperature map spanning tens of degrees a ±1 K term cannot be seen, so
// the map can draw ΔT alone: gold where the ground is WARMER than flat open
// ground would be, indigo where it is cooler — the Sun-exposure layer's own
// pair (terrain.js), because it is the same idea in kelvin — transparent at 0
// and full strength at ±EFFECT_FULL_K.
export const EFFECT_FULL_K = 1.5;
export const EFFECT_FLOOR_K = 0.05;
export const EFFECT_ALPHA = 0.9;
/** Paint ΔT (K) into data[o..o+3]; below the floor nothing is painted. */
export function effectPaint(k, data, o) {
    if (!Number.isFinite(k) || Math.abs(k) < EFFECT_FLOOR_K) return;
    const c = k > 0 ? EXPOSURE_SUN : EXPOSURE_SHADE;
    const e = Math.min(1, (Math.abs(k) - EFFECT_FLOOR_K) / (EFFECT_FULL_K - EFFECT_FLOOR_K));
    data[o] = c[0] * 255; data[o + 1] = c[1] * 255; data[o + 2] = c[2] * 255;
    data[o + 3] = 255 * EFFECT_ALPHA * (0.25 + 0.75 * e);
}
