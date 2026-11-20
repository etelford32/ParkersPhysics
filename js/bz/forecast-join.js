/**
 * js/bz/forecast-join.js — the forecast past the L1 horizon (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B7. Everything the engine says about the next hour
 * comes from wind an L1 spacecraft has ALREADY measured and that is still in
 * transit. Past that horizon no instrument has seen anything. The only thing
 * this site can say there is what the flux-rope engine says about a CME that
 * is on its way — so this module JOINS the two, and does nothing else:
 *
 *   arrived (ESTIMATED) │ in transit (FORECAST, from L1) │ CME prior (FORECAST)
 *   ───────────────── now ─────────────────── L1 horizon ───────────────────▶
 *
 * It computes NO flux-rope physics and NO propagation. The rope numbers are
 * the ONE shared provider's (js/flux-rope-forecast.js, published by
 * js/sun-flux-rope.js `startFluxRopeProvider`); the delay is the engine's own
 * (js/bz/flux-analysis.js). No DOM, no fetch, `nowMs` is an input.
 *
 * RULES (each is a gate in tests/bz-forecast-join.mjs):
 *   • MEASUREMENT WINS. Inside the L1 horizon the rope is never drawn, never
 *     blended in. The rope's first point is strictly after the last L1-based
 *     arrival.
 *   • The rope's Bz(t) is AT L1. It reaches the bow shock one propagation
 *     delay later, so every rope time is shifted by the engine's CURRENT
 *     delay before it is put on the arrival-time axis. (A CME is faster than
 *     the wind ahead of it; the delay inside it will be shorter than today's.
 *     That error is tens of minutes on a forecast whose own arrival spread is
 *     hours, and the result carries it as a caveat.)
 *   • NO ROPE, NO FORECAST. With no Earth-directed CME in flight the prior is
 *     EMPTY and the status says why. A quiet "Bz ≈ 0" line past the horizon
 *     would be an invention. A provider that failed is a third, different
 *     status — feeds down must look down.
 *   • THE ROPE IS SILENT ABOUT ORDINARY WIND. Before any ensemble member has
 *     the CME at L1 its fan is a zero-width line at 0 nT; those steps are
 *     neither drawn (a gap, counted in `silentSteps`) nor scored.
 *   • THE SEAM IS REPORTED, not smoothed. Where the L1-based forecast ends
 *     and the rope prior begins the two generally disagree; the step and
 *     whether L1 sits inside the rope's own 5–95 % band are returned.
 *   • THE SCORE USES THE UNCONDITIONED PRIOR. The provider's `fan` has been
 *     conditioned on the L1 record by a particle filter — scoring it against
 *     that same record would be marking its own homework. `scoreRope` scores
 *     `prior` (the eruption alone) against the fused L1 field, beside the
 *     simplest control: "no CME, Bz = 0". The conditioned fan's error is
 *     returned too, labelled in-sample, and never produces a verdict.
 */

export const JOIN_DEFAULTS = Object.freeze({
    horizonH: 24,          // how far past now the joined forecast runs
    minScorePoints: 8,     // fewer scored grid points than this → not scored
    minMinutesPerPoint: 8, // fused L1 minutes needed inside one rope grid step
});

export const JOIN_STATUS = Object.freeze({
    joined: 'a CME forecast continues past the L1 horizon',
    no_rope: 'no Earth-directed CME is in flight — nothing is forecast past what L1 has seen',
    train_passed: 'the last Earth-directed CME has already passed — nothing is forecast past what L1 has seen',
    rope_beyond: 'a CME is in flight but its forecast does not reach this window',
    rope_down: 'the CME forecast is unavailable — nothing is shown past what L1 has seen',
    pending: 'waiting for the CME forecast',
});

const PCTS = ['p5', 'p25', 'p50', 'p75', 'p95'];
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Does the ensemble say anything here? (some member has the CME at L1 ⇒ the 5–95 % band has width) */
const speaks = (p) => p.p5 != null && p.p95 != null && p.p95 - p.p5 > 1e-6;

/**
 * The provider's result → plain arrays this module (and a test) can hold.
 * Returns { state:'ok', … } or { state:'idle'|'failed'|'pending', reason }.
 */
export function ropeSeries(fc) {
    if (!fc) return { state: 'pending', reason: null };
    if (fc.failed) return { state: 'failed', reason: String(fc.reason ?? 'provider failed').slice(0, 120) };
    if (fc.idle) return { state: 'idle', reason: fc.reason ?? 'no-earth-directed-cme' };
    const n = fc.grid?.n ?? 0, dtMs = (fc.grid?.dtS ?? 0) * 1000;
    if (!(n > 0) || !(dtMs > 0) || !fc.fan?.bzPct || !fc.prior?.bzPct) return { state: 'failed', reason: 'unexpected forecast shape' };
    const copy = (pct) => Object.fromEntries(PCTS.map((k) => [k, Array.from(pct[k] ?? [], fin)]));
    return {
        state: 'ok', launchMs: fc.launchMs, dtMs, n,
        fan: copy(fc.fan.bzPct), prior: copy(fc.prior.bzPct),
        conditioned: fc.fan !== fc.prior, nObs: fc.nObs ?? 0,
        cmes: (fc.cmes ?? []).length, pHit: fin(fc.summary?.pHit),
        arrivalP50Ms: fin(fc.summary?.arrivalP50Ms), arrivalP10Ms: fin(fc.summary?.arrivalP10Ms), arrivalP90Ms: fin(fc.summary?.arrivalP90Ms),
    };
}

/** Linear interpolation of one percentile row at an L1 time; null outside the grid or across a gap. */
function at(rope, row, tMs) {
    const x = (tMs - rope.launchMs) / rope.dtMs;
    if (!(x >= 0) || x > rope.n - 1) return null;
    const i = Math.min(rope.n - 2, Math.floor(x)), f = x - i;
    const a = row[i], b = row[i + 1];
    if (a == null || b == null) return null;
    return a + (b - a) * f;
}

/** The flux trace's rows (by arrival time) → { arrived, transit } points of Bz. */
export function arrivalSeries(trace, nowMs) {
    const c = trace?.columns ?? [];
    const ti = c.indexOf('arrives'), bi = c.indexOf('bz_nt'), ki = c.indexOf('kind'), di = c.indexOf('delay_min');
    const arrived = [], transit = [];
    if (ti < 0 || bi < 0) return { arrived, transit, delayMin: null };
    let delay = null;
    for (const r of trace.rows ?? []) {
        const t = Date.parse(r[ti]);
        if (!Number.isFinite(t)) continue;
        const p = { t, bz: fin(r[bi]), delayMin: di >= 0 ? fin(r[di]) : null };
        // The split is by arrival time against THIS clock, not the server's flag: a row the
        // server called a forecast a minute ago may have arrived since.
        (t > nowMs ? transit : arrived).push(p);
        if (p.delayMin != null) delay = p.delayMin;
    }
    void ki;
    return { arrived, transit, delayMin: delay };
}

/**
 * Join the L1-based arrival series with the rope forecast.
 * @param {{ trace:object, rope:object, nowMs:number, horizonH?:number }} input
 *        `trace` = /api/bz/flux `flux.trace`; `rope` = ropeSeries(fc).
 */
export function joinForecast({ trace, rope, nowMs, horizonH = JOIN_DEFAULTS.horizonH }) {
    const { arrived, transit, delayMin } = arrivalSeries(trace, nowMs);
    const lastL1 = transit.length ? transit[transit.length - 1] : (arrived.length ? arrived[arrived.length - 1] : null);
    const l1HorizonMs = lastL1 ? Math.max(lastL1.t, nowMs) : nowMs;
    const endMs = nowMs + horizonH * 3600e3;
    const out = { status: 'pending', statusText: JOIN_STATUS.pending, nowMs, l1HorizonMs, endMs, delayMin,
        arrived, transit, prior: [], silentSteps: 0, seam: null, rope: null, caveats: [] };
    const set = (s) => { out.status = s; out.statusText = JOIN_STATUS[s]; return out; };
    if (!rope || rope.state === 'pending') return set('pending');
    if (rope.state === 'failed') { out.reason = rope.reason; return set('rope_down'); }
    if (rope.state === 'idle') return set(rope.reason === 'cme-train-passed' ? 'train_passed' : 'no_rope');
    if (delayMin == null) { out.reason = 'no propagation delay from the engine'; return set('rope_down'); }

    const delayMs = delayMin * 60e3;
    // Walk the rope's own grid (never resample it finer than it was computed), shifted to arrival time.
    const i0 = Math.max(0, Math.ceil((l1HorizonMs - delayMs - rope.launchMs) / rope.dtMs));
    for (let i = i0; i < rope.n; i++) {
        const t = rope.launchMs + i * rope.dtMs + delayMs;
        if (t <= l1HorizonMs) continue;
        if (t > endMs) break;
        const p = { t, l1Time: t - delayMs };
        for (const k of PCTS) p[k] = rope.fan[k][i] ?? null;
        if (p.p50 == null) continue;
        // Where NO ensemble member has the CME yet, the fan is a zero-width line at 0 nT. That is the rope
        // model saying nothing about the ordinary wind, not a forecast of calm — it is not drawn.
        if (!speaks(p)) { out.silentSteps++; continue; }
        out.prior.push(p);
    }
    out.rope = { cmes: rope.cmes, conditioned: rope.conditioned, nObs: rope.nObs, pHit: rope.pHit,
        arrivalP10Ms: rope.arrivalP10Ms == null ? null : rope.arrivalP10Ms + delayMs,
        arrivalP50Ms: rope.arrivalP50Ms == null ? null : rope.arrivalP50Ms + delayMs,
        arrivalP90Ms: rope.arrivalP90Ms == null ? null : rope.arrivalP90Ms + delayMs,
        stepMin: rope.dtMs / 60e3 };
    if (!out.prior.length) return set('rope_beyond');

    // The seam: the rope's value AT the L1 horizon against the last thing L1 measured.
    if (lastL1 && lastL1.bz != null) {
        const tL1 = l1HorizonMs - delayMs;
        const m = at(rope, rope.fan.p50, tL1), lo = at(rope, rope.fan.p5, tL1), hi = at(rope, rope.fan.p95, tL1);
        if (m != null && lo != null && hi != null && hi - lo > 1e-6) out.seam = { t: l1HorizonMs, l1_bz_nt: lastL1.bz, rope_p50_nt: m, step_nt: m - lastL1.bz,
            l1_inside_rope_band: lo != null && hi != null ? (lastL1.bz >= lo && lastL1.bz <= hi) : null };
    }
    let min = null;
    for (const p of out.prior) if (min == null || p.p50 < min.p50) min = p;
    out.deepest = min ? { t: min.t, p50_nt: min.p50, p5_nt: min.p5 } : null;
    out.caveats.push(`the CME forecast is computed at L1 and moved to the bow shock by today's delay (${Math.round(delayMin)} min); inside a fast CME the real delay is shorter`);
    out.caveats.push('the CME\'s magnetic orientation is not observed before it reaches L1 — the band is wide because that is true');
    if (!rope.conditioned) out.caveats.push('the forecast has not yet been conditioned on L1 data');
    return set('joined');
}

/**
 * Score the rope's UNCONDITIONED prior against the fused L1 field over the
 * part of its grid that has already happened.
 * @param {{ rope:object, l1:{t0:string|number, step_s?:number, bz:Array<number|null>}, nowMs:number }} input
 */
export function scoreRope({ rope, l1, nowMs, minPoints = JOIN_DEFAULTS.minScorePoints, minMinutes = JOIN_DEFAULTS.minMinutesPerPoint }) {
    const none = (status) => ({ status, n: 0, rmse_nt: null, rmse_zero_nt: null, skill_vs_zero: null, coverage50: null, coverage90: null, conditioned_rmse_nt: null });
    if (!rope || rope.state !== 'ok') return none(rope?.state === 'failed' ? 'rope_down' : 'no_rope');
    if (!l1 || !Array.isArray(l1.bz)) return none('no_truth');
    const t0 = typeof l1.t0 === 'number' ? l1.t0 : Date.parse(l1.t0), step = (l1.step_s ?? 60) * 1000;
    let n = 0, se = 0, s0 = 0, sc = 0, nc = 0, in50 = 0, in90 = 0;
    for (let i = 0; i < rope.n; i++) {
        const tc = rope.launchMs + i * rope.dtMs;
        if (tc + rope.dtMs / 2 > nowMs) break;
        // Truth = the MEAN of the fused field over this grid step. A step with too few minutes is a gap.
        const a = Math.ceil((tc - rope.dtMs / 2 - t0) / step), b = Math.floor((tc + rope.dtMs / 2 - t0) / step);
        let sum = 0, m = 0;
        for (let k = Math.max(0, a); k <= b && k < l1.bz.length; k++) { const v = l1.bz[k]; if (v != null && v === v) { sum += v; m++; } }
        const p = rope.prior.p50[i];
        if (m < minMinutes || p == null) continue;
        // Scored only where the forecast SPEAKS (see joinForecast): before any member has the CME at L1 the
        // prior is identically the control, and counting those steps would dilute the score toward "level".
        if (!speaks({ p5: rope.prior.p5[i], p95: rope.prior.p95[i] })) continue;
        const truth = sum / m;
        n++; se += (p - truth) ** 2; s0 += truth ** 2;
        const q = (k) => rope.prior[k][i];
        if (q('p25') != null && q('p75') != null && truth >= q('p25') && truth <= q('p75')) in50++;
        if (q('p5') != null && q('p95') != null && truth >= q('p5') && truth <= q('p95')) in90++;
        const c = rope.fan.p50[i];
        if (c != null) { sc += (c - truth) ** 2; nc++; }
    }
    if (n < minPoints) return { ...none('too_few_points'), n };
    const mse = se / n, mse0 = s0 / n;
    return { status: 'scored', n, rmse_nt: Math.sqrt(mse), rmse_zero_nt: Math.sqrt(mse0),
        skill_vs_zero: mse0 > 0 ? 1 - mse / mse0 : null,
        coverage50: in50 / n, coverage90: in90 / n,
        conditioned_rmse_nt: rope.conditioned && nc ? Math.sqrt(sc / nc) : null,
        note: 'the eruption-only forecast (no L1 data used) against the fused L1 field, on the forecast\'s own grid' };
}
