/**
 * cold-pool.js — night: where the cold air goes. PURE.
 *
 * sun-temp.js is the daytime half of "two points at the same height are not
 * the same temperature". This is the night half, and at night it is the
 * larger one. After sunset the ground loses heat to the sky, the air touching
 * it cools, and cold air is DENSE: on any slope it slides downhill and
 * collects in the low ground. By dawn on a clear, calm night a valley floor
 * is several degrees colder than the slopes a couple of hundred metres above
 * it (the "thermal belt" orchards are planted in) — the opposite of what the
 * height correction in terrain-temp.js alone would draw, which makes the
 * lower point WARMER.
 *
 *     ΔT(x, t) = POOL.gain · I(t) · clamp( h_rel(x) / POOL.depthM, −1, +1 )
 *
 *   h_rel  the point's height RELATIVE to its surroundings: z minus the mean
 *          terrain height within POOL.radiusKm (a box mean, summed-area
 *          table, the box's east–west half-width widened by 1/cos φ so it is
 *          the same distance in both directions). Negative in a valley or at
 *          the foot of a range, positive on a ridge, EXACTLY 0 on flat ground
 *          and on a uniform slope — a plateau at 3000 m pools nothing, which
 *          is why this is not a function of elevation (the gate's negative
 *          control). GFS's own 2 m temperature already carries the night
 *          cooling of its flat cell, so, as in sun-temp.js, only the
 *          departure from flat ground is added.
 *   I(t)   the strength of the surface inversion, K — how much colder the
 *          air at the ground is than the air a pool's depth above it:
 *
 *              I = LW_CLEAR · (1 − LW_CLOUD · c) / H_NIGHT        (slope-wind.js's
 *                  · f_night(t)                                    own night budget:
 *                  · 1 / (1 + (U / POOL.windMs)²)                  4 K clear and calm)
 *
 *          f_night is how much of a full night's pool exists now, 0…1. It
 *          RELAXES toward 1 while the Sun is down (τ = POOL.tauS, 3 h: a
 *          quarter an hour after sunset, ~90 % by the small hours) and toward
 *          0 while it is up, FASTER (POOL.erodeS, 1 h): sunlight and the
 *          convection it starts destroy a pool in a couple of hours, it does
 *          not merely fade. A single passive memory — the first version —
 *          left 7 % of the pool standing at solar noon (measured), which is
 *          not a thing valleys do. Integrated exactly, interval by interval,
 *          over sun-temp.js's own sample marks, from 0 at the far end. Cloud closes the longwave window (overcast: one tenth);
 *          wind stirs the pool out, and faster than it stirs a sunny slope
 *          (quadratic: at 3 m/s half is left, at 9 m/s a tenth).
 *   gain   how much of that inversion a fully sheltered floor (or a fully
 *          exposed crest) actually sees, 0.75: ±3 K between a deep valley
 *          floor and flat ground on a clear calm night, ~6 K floor-to-belt —
 *          the middle of what valley transects measure (3–10 K).
 *
 * WHAT IT IS — a MODELLED adjustment and every surface says so. WHERE the
 * cold collects (which floors, which benches) is real terrain; WHEN it builds
 * and how cloud and wind shut it down follow the real Sun and GFS's own cloud
 * and 10 m wind. The SIZE rides fixed, disclosed constants and is an order of
 * magnitude. It is capped at ±AMP_CAP_K (sun-temp.js's cap).
 *
 * WHAT IT DOES NOT DO: it does not route the flow. Relative height is a
 * proxy for "air drains to here"; it does not know whether a valley is
 * closed (a real pool) or open at its lower end (a draining one), and a
 * basin WIDER than ~2·radiusKm reads as flat — its pooling is the part GFS
 * itself resolves and the fitted lapse rate already carries. One Sun
 * position for the grid; the cloud and wind of the instant on show stand for
 * the whole night; no snow cover (which doubles a real pool), no fog (which
 * caps it). At the grid's edge the box mean is one-sided.
 *
 * Node gate: tests/climalytix-cold-pool.mjs.
 */
import { LW_CLEAR, LW_CLOUD, H_NIGHT } from './slope-wind.js';
import { memorySamples, AMP_CAP_K } from './sun-temp.js';

const KM_PER_DEG = 111.195;
const D2R = Math.PI / 180;
export const POOL = Object.freeze({ radiusKm: 4, depthM: 150, gain: 0.75, tauS: 3 * 3600, erodeS: 3600, stepS: 3600, intervals: 9, windMs: 3, minFrac: 0.01 });
/** The clear-sky, calm, whole-night inversion: slope-wind.js's night surface deficit. */
export const INVERSION_CLEAR_K = LW_CLEAR / H_NIGHT;

/** The night memory's sample plan (sun-temp.js memorySamples on the night's own τ and reach). */
export function nightSamples(tMs) {
    return memorySamples(tMs, { tauS: POOL.tauS, stepS: POOL.stepS, intervals: POOL.intervals });
}

/**
 * f_night ∈ [0, 1): the pool's build-up now. `samples` = nightSamples(t), each with the Sun at its
 * midpoint (`sun.altitudeDeg`); walked oldest → newest, each interval an exact exponential step
 * toward 1 (Sun down, τ) or 0 (Sun up, the faster erosion time).
 */
export function nightFraction(samples) {
    let f = 0;
    for (let k = samples.length - 1; k >= 0; k--) {
        const s = samples[k];
        if (!s.sun) continue;
        const down = !(s.sun.altitudeDeg > 0), dt = (s.b - s.a) / 1000;
        const target = down ? 1 : 0;
        f = target + (f - target) * Math.exp(-dt / (down ? POOL.tauS : POOL.erodeS));
    }
    return f;
}

/** Wind's hold on a pool, in (0, 1]; an unknown wind stirs nothing (an upper bound). */
export function poolMixing(speedMs) {
    return Number.isFinite(speedMs) && speedMs > 0 ? 1 / (1 + (speedMs / POOL.windMs) ** 2) : 1;
}

/** I, K: the surface inversion's strength. An unknown cloud is a clear sky (an upper bound). */
export function inversionK({ nightFrac = 0, cloudFrac = 0, windMs = null } = {}) {
    const c = Number.isFinite(cloudFrac) ? Math.max(0, Math.min(1, cloudFrac)) : 0;
    return INVERSION_CLEAR_K * (1 - LW_CLOUD * c) * Math.max(0, nightFrac) * poolMixing(windMs);
}

/** ΔT at one point from its relative height (m) and the inversion (K). */
export function poolDeltaK(hRelM, invK) {
    if (!Number.isFinite(hRelM) || !Number.isFinite(invK)) return NaN;
    const v = POOL.gain * invK * Math.max(-1, Math.min(1, hRelM / POOL.depthM));
    return Math.max(-AMP_CAP_K, Math.min(AMP_CAP_K, v));
}

/**
 * h_rel over a DEM grid (terrain.js sampleGrid): z − mean z within radiusKm.
 * NaN where there is no terrain; missing neighbours are left out of the mean.
 */
export function relativeHeight(g, { radiusKm = POOL.radiusKm } = {}) {
    const { nRows, nCols } = g, W = nCols + 1;
    const sum = new Float64Array((nRows + 1) * W), cnt = new Float64Array((nRows + 1) * W);
    for (let i = 0; i < nRows; i++) {
        let rs = 0, rc = 0;
        for (let j = 0; j < nCols; j++) {
            const v = g.values[i * nCols + j];
            if (Number.isFinite(v)) { rs += v; rc += 1; }
            sum[(i + 1) * W + j + 1] = sum[i * W + j + 1] + rs;
            cnt[(i + 1) * W + j + 1] = cnt[i * W + j + 1] + rc;
        }
    }
    const box = (t, i0, j0, i1, j1) => t[(i1 + 1) * W + j1 + 1] - t[i0 * W + j1 + 1] - t[(i1 + 1) * W + j0] + t[i0 * W + j0];
    const out = new Float32Array(nRows * nCols).fill(NaN);
    const ri = Math.max(1, Math.round(radiusKm / (g.dlat * KM_PER_DEG)));
    for (let i = 0; i < nRows; i++) {
        const cos = Math.max(0.05, Math.cos((g.latN - i * g.dlat) * D2R));
        const rj = Math.max(1, Math.round(radiusKm / (g.dlon * KM_PER_DEG * cos)));
        const i0 = Math.max(0, i - ri), i1 = Math.min(nRows - 1, i + ri);
        for (let j = 0; j < nCols; j++) {
            const v = g.values[i * nCols + j];
            if (!Number.isFinite(v)) continue;
            const j0 = Math.max(0, j - rj), j1 = Math.min(nCols - 1, j + rj);
            out[i * nCols + j] = v - box(sum, i0, j0, i1, j1) / box(cnt, i0, j0, i1, j1);
        }
    }
    return out;
}

/**
 * ΔT over a DEM grid.
 * @param g      the DEM grid
 * @param hRel   relativeHeight(g)
 * @param o.nightFrac  nightFraction(nightSamples(t) with a Sun each)
 * @param o.cloudAt    (lat, lon) → cloud fraction 0..1 | null   (null ⇒ clear: an UPPER bound)
 * @param o.windAt     (lat, lon) → 10 m wind speed m/s | null   (null ⇒ calm: an upper bound)
 * @returns {{ values:Float32Array, range:{min,max}|null, active:boolean, nightFrac:number }}
 */
export function coldPoolGrid(g, hRel, { nightFrac = 0, cloudAt = null, windAt = null } = {}) {
    const n = g.nRows * g.nCols, values = new Float32Array(n).fill(NaN);
    // Under 1 % of a night's build-up there is no pool to speak of: nothing is drawn or claimed.
    const active = nightFrac >= POOL.minFrac;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        for (let j = 0; j < g.nCols; j++) {
            const k = i * g.nCols + j;
            if (!Number.isFinite(hRel[k])) continue;
            let v = 0;
            if (active && hRel[k] !== 0) {
                const lon = g.lonW + j * g.dlon;
                v = poolDeltaK(hRel[k], inversionK({ nightFrac, cloudFrac: cloudAt ? cloudAt(lat, lon) : null, windMs: windAt ? windAt(lat, lon) : null }));
            }
            values[k] = v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
    }
    return { values, range: lo <= hi ? { min: lo, max: hi } : null, active, nightFrac };
}
