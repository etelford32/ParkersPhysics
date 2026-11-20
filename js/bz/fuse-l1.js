/**
 * js/bz/fuse-l1.js — multi-spacecraft fusion of the L1 magnetic field (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B1 (§4.2, and §11 "what this changes"). No DOM, no
 * fetch, no ambient time. Gate: tests/bz-l1.mjs.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 * SWPC's file carries several L1 spacecraft (three, measured 2026-11-20) and
 * public products show one. The others are not spares: they sit 17–98 R_E
 * apart ACROSS the flow, so the same solar-wind structure reaches them at
 * DIFFERENT TIMES — a front tilted 45° crosses a 98 R_E baseline ~26 minutes
 * apart at 400 km/s. Averaging the raw streams minute by minute therefore
 * smears every real structure; the naive mean is this module's NEGATIVE
 * CONTROL, not its method.
 *
 * ── THE METHOD ───────────────────────────────────────────────────────────
 *   1. `toGrid` puts every spacecraft on ONE minute axis BY INSTANT (IMAP's
 *      tags are seconds off the minute). A sample lands in its nearest
 *      minute; nothing is interpolated; a missing minute is NaN.
 *   2. `pairLag` measures the arrival-time lag between two spacecraft by
 *      cross-correlating all three field components over a trailing window.
 *      A lag is accepted only above a correlation floor; otherwise the pair
 *      falls back to the ADVECTIVE lag (Δx / v, the flat delay) and SAYS so.
 *   3. `lagTrack` repeats that every `stepMin`, each estimate using ONLY
 *      data before it — so every later number is out of sample.
 *   4. `predictFrom` reconstructs one spacecraft from the others, each
 *      shifted by its own lag. Its residual against the real spacecraft is
 *      the engine's first SCORE (`withheldScore`, plan §6) and its trailing
 *      robust spread is each spacecraft's σ.
 *   5. `fuse` combines the lag-aligned spacecraft in the reference
 *      spacecraft's frame with 1/σ² weights, flags and EXCLUDES a spacecraft
 *      that the others contradict, and flags (without excluding) a two-way
 *      disagreement it cannot attribute.
 *
 * ── WHAT IS AND IS NOT CLAIMED ───────────────────────────────────────────
 *   • The fused value is the field AT THE REFERENCE SPACECRAFT, not on the
 *     Sun–Earth line and not at Earth. Carrying it anywhere is B2.
 *   • A spacecraft whose lag is positive (it sees the structure LATER than
 *     the reference) has not yet seen the newest minutes, so the count of
 *     contributing spacecraft falls toward "now". That is real and is
 *     reported per minute as `n`; it is never filled.
 *   • σ is CALIBRATED ONLY where there is truth: `withheldScore` reports the
 *     share of residuals inside the stated 1σ (68 % if honest). The fused σ
 *     is built from the same per-spacecraft spreads but has no truth to be
 *     scored against, and is labelled provisional by every consumer.
 *   • Nothing here names a spacecraft or assumes how many there are.
 */

export const STEP_MS = 60_000;

/** Defaults — each is a stated choice, not a fitted constant. */
export const FUSE_DEFAULTS = Object.freeze({
    windowMin: 180,      // trailing window for a lag estimate
    stepMin: 30,         // how often the lag is re-estimated
    maxLagMin: 45,       // search range; 98 R_E at 45° and 300 km/s is ~35 min
    minPairs: 60,        // valid sample pairs needed at a lag
    // Correlation floor to accept a measured lag. MEASURED, not guessed: two
    // UNRELATED red-noise series (25–40 min correlation times) searched over
    // ±45 min in a 180-min window peak at r = 0.27 median, 0.43 at p90 and
    // 0.58 at worst of 60 trials — the maximum over 91 lags of a few
    // effective degrees of freedom. 0.5 accepted noise as a lag; 0.65 does
    // not. Shorten the window or widen the search and this must be re-measured.
    rMin: 0.65,
    sigmaWindowMin: 360, // trailing window for a spacecraft's residual spread
    sigmaFloorNt: 0.3,   // never claim better than the instrument + rounding
    kOutlier: 4,         // |residual| > k·σ ⇒ contradicted
    advectSpeedKms: 400, // used for the flat-delay fallback when v is unknown
});

const COMPS = ['bx', 'by', 'bz'];

// ── 1. the common minute axis ─────────────────────────────────────────────

/**
 * @param {Record<string, Array<{t:number,bx_gsm,by_gsm,bz_gsm,bt?}>>} bySc
 * @param {{ t0?: number, t1?: number }} [range] epoch ms; defaults to the data's span
 * @returns {{ t0:number, n:number, sc: Record<string,{bx:Float64Array,by:Float64Array,bz:Float64Array,bt:Float64Array}> }}
 */
export function toGrid(bySc, range = {}) {
    let lo = Infinity, hi = -Infinity;
    for (const list of Object.values(bySc)) for (const s of list) { if (s.t < lo) lo = s.t; if (s.t > hi) hi = s.t; }
    if (!Number.isFinite(lo)) return { t0: 0, n: 0, sc: {} };
    const t0 = Math.round((range.t0 ?? lo) / STEP_MS) * STEP_MS;
    const t1 = Math.round((range.t1 ?? hi) / STEP_MS) * STEP_MS;
    const n = Math.max(0, Math.round((t1 - t0) / STEP_MS) + 1);
    const sc = {};
    for (const [name, list] of Object.entries(bySc)) {
        const g = { bx: new Float64Array(n).fill(NaN), by: new Float64Array(n).fill(NaN),
            bz: new Float64Array(n).fill(NaN), bt: new Float64Array(n).fill(NaN) };
        for (const s of list) {
            const i = Math.round((s.t - t0) / STEP_MS);
            if (i < 0 || i >= n) continue;
            // null → NaN explicitly: Number(null) is 0, and a gap is not a zero.
            g.bx[i] = s.bx_gsm == null ? NaN : s.bx_gsm;
            g.by[i] = s.by_gsm == null ? NaN : s.by_gsm;
            g.bz[i] = s.bz_gsm == null ? NaN : s.bz_gsm;
            g.bt[i] = s.bt == null ? NaN : s.bt;
        }
        sc[name] = g;
    }
    return { t0, n, sc };
}

// ── robust statistics ─────────────────────────────────────────────────────

function median(a) {
    if (!a.length) return NaN;
    const s = Float64Array.from(a).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** 1.4826·MAD about the median — resists a storm inside the window. */
export function robustSigma(values) {
    const v = values.filter(Number.isFinite);
    if (v.length < 8) return NaN;
    const m = median(v);
    return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}

// ── 2. the lag between two spacecraft ─────────────────────────────────────

/** Correlation of a[i] with b[i+lag], pooled over the three components. */
function corrAtLag(a, b, i0, i1, lag, minPairs) {
    let n = 0, sab = 0, saa = 0, sbb = 0;
    for (const c of COMPS) {
        const A = a[c], B = b[c];
        let m = 0, sa = 0, sb = 0;
        // BOTH indices stay inside [i0, i1]. Bounding only `i` let b[i + lag]
        // read up to maxLag minutes PAST the window — a look into the future
        // that the causality gate caught (tests/bz-l1.mjs).
        const lo = Math.max(i0, i0 - lag, 0), hi = Math.min(i1, i1 - lag, B.length - 1 - lag, A.length - 1);
        for (let i = lo; i <= hi; i++) {
            const x = A[i], y = B[i + lag];
            if (x === x && y === y) { m++; sa += x; sb += y; }
        }
        if (m < 2) continue;
        const ma = sa / m, mb = sb / m;      // per-component mean removed
        for (let i = lo; i <= hi; i++) {
            const x = A[i], y = B[i + lag];
            if (x === x && y === y) { sab += (x - ma) * (y - mb); saa += (x - ma) ** 2; sbb += (y - mb) ** 2; }
        }
        n += m;
    }
    if (n < 3 * minPairs || saa <= 0 || sbb <= 0) return null;
    return { r: sab / Math.sqrt(saa * sbb), n: n / 3 };
}

/**
 * The lag L (minutes) such that b(t + L) ≈ a(t): POSITIVE means b sees the
 * structure LATER than a. Searched over ±maxLagMin on [i0, i1] of the grid,
 * refined to a fraction of a minute by a parabola through the peak.
 * @returns {{ lagMin:number, r:number, n:number } | null} null = no usable overlap
 */
export function pairLag(a, b, i0, i1, opts = {}) {
    const { maxLagMin, minPairs } = { ...FUSE_DEFAULTS, ...opts };
    let best = null;
    const rs = new Map();
    for (let lag = -maxLagMin; lag <= maxLagMin; lag++) {
        const c = corrAtLag(a, b, i0, i1, lag, minPairs);
        if (!c) continue;
        rs.set(lag, c.r);
        if (!best || c.r > best.r) best = { lagMin: lag, r: c.r, n: c.n };
    }
    if (!best) return null;
    const l = rs.get(best.lagMin - 1), p = best.r, h = rs.get(best.lagMin + 1);
    if (l !== undefined && h !== undefined) {
        const den = l - 2 * p + h;
        if (den < 0) best.lagMin += Math.max(-0.5, Math.min(0.5, 0.5 * (l - h) / den));
    }
    // A peak pinned on the edge of the search range is not a measured lag.
    best.atEdge = Math.abs(Math.round(best.lagMin)) >= maxLagMin;
    return best;
}

/**
 * The flat-delay lag between two spacecraft from their upstream separation
 * alone: b sees a front normal to the flow (Δx / v) later if it is closer to
 * Earth. The fallback, and the baseline B2's phase-front delay must beat.
 */
export function advectiveLagMin(posA, posB, speedKms = FUSE_DEFAULTS.advectSpeedKms) {
    if (!posA || !posB || !(speedKms > 0)) return 0;
    return ((posA.x - posB.x) * 6371.2) / speedKms / 60;
}

// ── 3. the causal lag track ───────────────────────────────────────────────

/**
 * Lag of every ordered pair, re-estimated every stepMin from the trailing
 * windowMin ONLY. track[k] applies to grid indices [k·step, (k+1)·step).
 * @param {object} grid from toGrid
 * @param {{ positions?: Record<string,{x,y,z}>, speedKms?: number }} [ctx]
 * @returns {{ step:number, names:string[], pairs: Record<string, Array<{lagMin:number,r:number|null,source:'measured'|'advective'}>> }}
 */
export function lagTrack(grid, ctx = {}, opts = {}) {
    const o = { ...FUSE_DEFAULTS, ...opts };
    const names = Object.keys(grid.sc);
    const steps = Math.ceil(grid.n / o.stepMin);
    const pairs = {};
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const A = names[i], B = names[j];
            const adv = advectiveLagMin(ctx.positions?.[A], ctx.positions?.[B], ctx.speedKms ?? o.advectSpeedKms);
            const fwd = [], rev = [];
            for (let k = 0; k < steps; k++) {
                const end = k * o.stepMin - 1;                 // strictly before this step
                const est = end >= o.minPairs ? pairLag(grid.sc[A], grid.sc[B], Math.max(0, end - o.windowMin + 1), end, o) : null;
                const ok = est && est.r >= o.rMin && !est.atEdge;
                const e = ok ? { lagMin: est.lagMin, r: est.r, source: 'measured' }
                    : { lagMin: adv, r: est ? est.r : null, source: 'advective' };
                fwd.push(e);
                rev.push({ ...e, lagMin: -e.lagMin });
            }
            pairs[`${A}>${B}`] = fwd;      // b(t + L) ≈ a(t)
            pairs[`${B}>${A}`] = rev;
        }
    }
    return { step: o.stepMin, names, pairs };
}

// ── 4. one spacecraft from the others ─────────────────────────────────────

/**
 * Predict `target`'s component from every other spacecraft, each read at its
 * own lag (nearest minute — no interpolation), weighted by the pair's r².
 * @returns {{ pred:Float64Array, n:Uint8Array }} pred is NaN where no other spacecraft reaches
 */
export function predictFrom(grid, track, target, comp = 'bz', { exclude = null, useLags = true } = {}) {
    const pred = new Float64Array(grid.n).fill(NaN);
    const count = new Uint8Array(grid.n);
    const others = track.names.filter((s) => s !== target && s !== exclude);
    for (let i = 0; i < grid.n; i++) {
        const k = Math.min(Math.floor(i / track.step), Infinity);
        let sw = 0, sv = 0, m = 0;
        for (const o of others) {
            const e = track.pairs[`${target}>${o}`]?.[k];
            if (!e) continue;
            const j = i + (useLags ? Math.round(e.lagMin) : 0);
            if (j < 0 || j >= grid.n) continue;
            const v = grid.sc[o][comp][j];
            if (v !== v) continue;
            const w = Math.max(e.r ?? 0, 0.1) ** 2;
            sw += w; sv += w * v; m++;
        }
        if (m) { pred[i] = sv / sw; count[i] = m; }
    }
    return { pred, n: count };
}

/**
 * Trailing robust σ of a residual series, CAUSAL: sigma[i] uses residuals in
 * [i − window, i − 1] only. NaN until enough residuals exist.
 */
export function causalSigma(resid, windowMin, floor, stepMin = 30) {
    const out = new Float64Array(resid.length).fill(NaN);
    for (let k = 0; k * stepMin < resid.length; k++) {
        const end = k * stepMin;
        const buf = [];
        for (let i = Math.max(0, end - windowMin); i < end; i++) if (resid[i] === resid[i]) buf.push(resid[i]);
        const s = robustSigma(buf);
        const v = s === s ? Math.max(s, floor) : NaN;
        for (let i = end; i < Math.min(resid.length, end + stepMin); i++) out[i] = v;
    }
    return out;
}

// ── 5. the score: withhold one, predict it from the rest ──────────────────

/**
 * For each spacecraft: reconstruct its Bz from the others and score it
 * against the spacecraft itself (plan §6, row 4).
 *
 *   rmse           the lag-aligned reconstruction
 *   rmse_unshifted the SAME reconstruction with every lag forced to 0 — the
 *                  naive mean of the other spacecraft, i.e. what "use the
 *                  other one as a spare" amounts to. The negative control.
 *   skill          1 − MSE / MSE_unshifted  (> 0 means the lags helped)
 *   coverage68     share of residuals inside the CAUSAL 1σ. 0.68 if honest.
 *
 * Only minutes where both reconstructions exist AND σ is defined are scored,
 * so the three numbers are over one population.
 */
export function withheldScore(grid, track, opts = {}) {
    const o = { ...FUSE_DEFAULTS, ...opts };
    const out = {};
    for (const target of track.names) {
        const truth = grid.sc[target].bz;
        const a = predictFrom(grid, track, target, 'bz').pred;
        const b = predictFrom(grid, track, target, 'bz', { useLags: false }).pred;
        const resid = new Float64Array(grid.n).fill(NaN);
        for (let i = 0; i < grid.n; i++) resid[i] = truth[i] - a[i];
        const sigma = causalSigma(resid, o.sigmaWindowMin, o.sigmaFloorNt, o.stepMin);
        let n = 0, se = 0, sb = 0, inside = 0, sae = 0;
        for (let i = 0; i < grid.n; i++) {
            const e = resid[i], eb = truth[i] - b[i], s = sigma[i];
            if (!(e === e && eb === eb && s === s)) continue;
            n++; se += e * e; sb += eb * eb; sae += Math.abs(e);
            if (Math.abs(e) <= s) inside++;
        }
        out[target] = n >= 30 ? {
            n,
            rmse: Math.sqrt(se / n),
            mae: sae / n,
            rmse_unshifted: Math.sqrt(sb / n),
            skill: sb > 0 ? 1 - se / sb : null,
            coverage68: inside / n,
        } : { n, rmse: null, mae: null, rmse_unshifted: null, skill: null, coverage68: null };
    }
    return out;
}

// ── 6. the fused field ────────────────────────────────────────────────────

/**
 * Fuse every spacecraft into the reference spacecraft's frame.
 *
 * Per minute i:
 *   • each spacecraft contributes its value at i + lag(ref → it);
 *   • its σ is the causal robust spread of ITS OWN withheld residual
 *     (how far the others say it usually is from consensus);
 *   • with ≥ 3 present, a spacecraft more than kOutlier·σ from the mean of
 *     the OTHERS, while those others agree among themselves (leave-one-out),
 *     is CONTRADICTED: flagged and excluded;
 *   • with exactly 2 present and a gap of more than kOutlier·σ, the minute is
 *     flagged `disagree` and both are kept — nothing says which is wrong;
 *   • fused = Σ w v / Σ w, w = 1/σ²;
 *     sigma = max( (Σ w)^(−1/2), weighted spread / √n ).
 *
 * @returns {{ ref:string, bz:Float64Array, by:Float64Array, bx:Float64Array,
 *   sigma:Float64Array, n:Uint8Array, flags:Uint8Array, flagNames:object,
 *   contradicted: Record<string, number>, sigmaBySc: Record<string, Float64Array> }}
 */
export const FLAG = Object.freeze({ SINGLE: 1, DISAGREE: 2, CONTRADICTED: 4, LAG_FALLBACK: 8, SIGMA_UNSET: 16 });

export function fuse(grid, track, ref, opts = {}) {
    const o = { ...FUSE_DEFAULTS, ...opts };
    const names = track.names;
    const N = grid.n;
    // Each spacecraft's residual against the others, and its causal σ.
    const sigmaBySc = {};
    for (const s of names) {
        const p = predictFrom(grid, track, s, 'bz').pred;
        const r = new Float64Array(N).fill(NaN);
        for (let i = 0; i < N; i++) r[i] = grid.sc[s].bz[i] - p[i];
        sigmaBySc[s] = causalSigma(r, o.sigmaWindowMin, o.sigmaFloorNt, o.stepMin);
    }
    const res = { ref, bz: new Float64Array(N).fill(NaN), by: new Float64Array(N).fill(NaN),
        bx: new Float64Array(N).fill(NaN), sigma: new Float64Array(N).fill(NaN),
        n: new Uint8Array(N), flags: new Uint8Array(N), flagNames: FLAG,
        contradicted: Object.fromEntries(names.map((s) => [s, 0])), sigmaBySc };

    for (let i = 0; i < N; i++) {
        const k = Math.floor(i / track.step);
        const present = [];
        let flag = 0;
        for (const s of names) {
            let j = i, src = 'measured';
            if (s !== ref) {
                const e = track.pairs[`${ref}>${s}`]?.[k];
                if (!e) continue;
                j = i + Math.round(e.lagMin);
                src = e.source;
            }
            if (j < 0 || j >= N) continue;
            const bz = grid.sc[s].bz[j];
            if (bz !== bz) continue;
            let sg = sigmaBySc[s][j];
            if (sg !== sg) { sg = NaN; }
            present.push({ s, j, bz, by: grid.sc[s].by[j], bx: grid.sc[s].bx[j], sg, src });
        }
        if (!present.length) continue;
        if (present.some((p) => p.src === 'advective')) flag |= FLAG.LAG_FALLBACK;

        // σ not yet established (start of the record): fall back to the
        // median σ of the others, else the floor — and say so.
        const known = present.map((p) => p.sg).filter((x) => x === x);
        const fallback = known.length ? median(known) : NaN;
        for (const p of present) if (p.sg !== p.sg) { p.sg = fallback === fallback ? fallback : NaN; flag |= FLAG.SIGMA_UNSET; }

        let used = present;
        if (present.length >= 3) {
            // Contradicted: leave each spacecraft out in turn. It is the odd
            // one out only if it is far from the mean of the OTHERS *and* the
            // others agree among themselves. (Comparing each spacecraft with a
            // prediction that includes the bad one does not work: the bad one
            // drags every other residual to half its own size — measured.)
            let bad = null, worst = 0;
            for (const c of present) {
                if (c.sg !== c.sg) continue;
                const rest = present.filter((p) => p !== c);
                let m = 0, lo = Infinity, hi = -Infinity, sr = 0;
                for (const p of rest) { m += p.bz; lo = Math.min(lo, p.bz); hi = Math.max(hi, p.bz); sr += (p.sg === p.sg ? p.sg : c.sg) ** 2; }
                m /= rest.length;
                const zc = Math.abs(c.bz - m) / c.sg;
                const zRest = (hi - lo) / Math.sqrt(sr);
                if (zc > o.kOutlier && zRest < o.kOutlier / 2 && zc > worst) { worst = zc; bad = c; }
            }
            if (bad) {
                used = present.filter((p) => p !== bad);
                flag |= FLAG.CONTRADICTED;
                res.contradicted[bad.s]++;
            }
        } else if (present.length === 2) {
            const [a, b] = present;
            const s2 = Math.hypot(a.sg, b.sg);
            if (s2 === s2 && Math.abs(a.bz - b.bz) > o.kOutlier * s2) flag |= FLAG.DISAGREE;
        }
        if (used.length === 1) flag |= FLAG.SINGLE;

        let sw = 0, sz = 0, sy = 0, sx = 0, wy = 0, wx = 0;
        for (const p of used) {
            const w = p.sg === p.sg ? 1 / (p.sg * p.sg) : 1;
            sw += w; sz += w * p.bz;
            if (p.by === p.by) { sy += w * p.by; wy += w; }
            if (p.bx === p.bx) { sx += w * p.bx; wx += w; }
        }
        const bz = sz / sw;
        let spread = 0;
        for (const p of used) spread += (p.sg === p.sg ? 1 / (p.sg * p.sg) : 1) * (p.bz - bz) ** 2;
        spread = Math.sqrt(spread / sw);
        const allSigma = used.every((p) => p.sg === p.sg);
        const formal = allSigma ? 1 / Math.sqrt(sw) : NaN;
        res.bz[i] = bz;
        res.by[i] = wy ? sy / wy : NaN;
        res.bx[i] = wx ? sx / wx : NaN;
        res.sigma[i] = formal === formal ? Math.max(formal, spread / Math.sqrt(used.length)) : NaN;
        res.n[i] = used.length;
        res.flags[i] = flag;
    }
    return res;
}

/** The most recent track entry of every pair, with its baseline — for reports. */
export function latestLags(track) {
    const out = [];
    const seen = new Set();
    for (const [key, list] of Object.entries(track.pairs)) {
        const [a, b] = key.split('>');
        if (seen.has(`${b}>${a}`) || !list.length) continue;
        seen.add(key);
        const e = list[list.length - 1];
        const measured = list.filter((x) => x.source === 'measured').length;
        out.push({ pair: [a, b], lag_min: Math.round(e.lagMin * 10) / 10,
            r: e.r == null ? null : Math.round(e.r * 1000) / 1000, source: e.source,
            measured_fraction: Math.round((measured / list.length) * 1000) / 1000 });
    }
    return out;
}
