/**
 * js/bz/hindcast.js — the archive hindcast of the ring-current rung (PURE).
 *
 * BZ_ENGINE_PLAN.md §20. The live page scores its Dst prediction on ONE
 * 24-hour window with ONE anchor, and the answer moved from +0.29 to −0.67
 * across five runs the same afternoon. This module asks the same question
 * over the whole archive: hundreds of anchors, every lead time, quiet and
 * disturbed separately, with an interval on each answer.
 *
 * WHAT CAN AND CANNOT BE HINDCAST FROM OUR ARCHIVE. `sw_geomag_dataset` holds
 * ONE L1 stream (speed, density, Bz) and hourly Dst. So:
 *   • the Dst model — YES, this module;
 *   • the multi-spacecraft fusion and the tilted-front delay — NO (one stream);
 *   • the geosynchronous filter — NO (no GOES magnetometer history is kept).
 * Those stay scored only on the live day until their inputs are archived.
 *
 * It owns no physics: the model is js/ring-current-model.js `integrateDst`
 * (O'Brien–McPherron), called exactly as the live rung calls it
 * (js/bz/ground-analysis.js `analyzeRing`), and the L1→Earth delay is
 * js/geomag/geospace.js `l1LagMinutes`. No DOM, no fetch, no clock.
 *
 * TWO DRIVERS, AND ONLY ONE IS A FORECAST:
 *   'measured' — the model is driven for the whole window by wind as it was
 *       later measured. This is a NOWCAST chain: "given the wind, does the
 *       model track Dst?" It is what the live rung does, and it is not
 *       something anyone could have known in advance past the L1 delay.
 *   'frozen'   — at the anchor, only wind L1 had ALREADY measured is used;
 *       after it runs out (about an hour) the last value is HELD. This is
 *       what a forecast issued at the anchor could actually have used.
 * Every result carries which driver produced it. Quoting a 'measured' skill
 * at a 12-hour lead as a forecast skill would be false.
 *
 * THE CONTROL is persistence: Dst stays at its anchor value. Skill is
 * 1 − Σerr²/Σerr²_persistence POOLED over anchors (not a mean of per-window
 * skills — a quiet window with persistence error ≈ 0 has unbounded skill).
 *
 * THE INTERVAL is a block bootstrap over whole UTC DAYS (windows overlap and
 * storms last days; resampling single anchors would be far too narrow), with
 * a seeded generator so the committed result is reproducible bit for bit.
 *
 * THE TIME STAMP OF AN HOURLY INDEX IS A CONVENTION, and it matters at a
 * one-hour lead: Kyoto's value stamped HH:00 is the mean over HH:00–HH:59.
 * `convention: 'stamp'` compares at HH:00 (what the live rung does);
 * `'centre'` compares the model's mean over that hour. Both are reported; the
 * difference between them is a property of the scoring, not of the model.
 */
import { integrateDst } from '../ring-current-model.js';
import { l1LagMinutes } from '../geomag/geospace.js';

export const HINDCAST_DEFAULTS = Object.freeze({
    windowH: 24,            // free-run length, as on the live page
    strideH: 6,             // a new anchor every this many hours
    leadsH: [1, 2, 3, 6, 12, 24],
    minWindCoverage: 0.8,   // of the window's minutes must have Bz AND speed
    disturbedDstNt: -30,    // a window is "disturbed" if observed Dst goes below this
    bootstrapN: 1000,
    seed: 20261120,
    model: 'obm',
});

const HOUR = 3600e3, MIN = 60e3;
export const DELAY_MEDIAN_MIN = 15;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Mulberry32 — a small seeded generator, so the bootstrap is reproducible. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The archive's minute columns → wind ordered by ARRIVAL at Earth.
 * Each minute is delayed by the flat L1 distance ÷ its own speed (last valid speed held —
 * a `mag_only` minute has Bz but no plasma). A minute overtaken by a later, faster one is
 * dropped, so arrival time is strictly increasing (the live engine's `arrivalOrder` rule).
 * @returns {{ arrival:Float64Array, seen:Float64Array, v:Float64Array, n:Float64Array, bz:Float64Array, length:number }}
 */
export function arrivedWind({ t0Ms, stepMs = MIN, speed, density, bz }) {
    const N = bz.length, raw = [], buf = [];
    let lastV = NaN, lastN = NaN, delayV = NaN;
    for (let i = 0; i < N; i++) {
        if (fin(speed[i]) && speed[i] > 0) {
            lastV = speed[i];
            // The DELAY uses a causal trailing median of the speed (the live engine's rule): minute-to-minute
            // speed noise of a few km/s is tens of seconds of delay, and with the raw speed a third of all
            // minutes 'overtook' their neighbours and were dropped (measured: 59 863 of 185 914).
            buf.push(speed[i]); if (buf.length > DELAY_MEDIAN_MIN) buf.shift();
            const srt = buf.slice().sort((a, b) => a - b); delayV = srt[srt.length >> 1];
        }
        if (fin(density[i]) && density[i] > 0) lastN = density[i];
        if (!fin(bz[i]) || !fin(lastV)) continue; // a gap is a gap: no sample, the integrator holds
        const seen = t0Ms + i * stepMs;
        raw.push([seen + l1LagMinutes(delayV) * MIN, seen, lastV, lastN, bz[i]]);
    }
    // Later-measured wind that arrives EARLIER overtakes: walk backwards keeping a running minimum.
    const keep = new Uint8Array(raw.length);
    let minArr = Infinity;
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i][0] < minArr) { keep[i] = 1; minArr = raw[i][0]; }
    const rows = raw.filter((_, i) => keep[i]);
    const col = (k) => Float64Array.from(rows, (r) => r[k]);
    return { arrival: col(0), seen: col(1), v: col(2), n: col(3), bz: col(4), length: rows.length, overtaken: raw.length - rows.length };
}

function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

/**
 * One window: anchor on an observed Dst hour, free-run, return the model's error and
 * persistence's error at each requested lead.
 */
export function runWindow({ wind, dstAt, anchorMs, opts = {} }) {
    const o = { ...HINDCAST_DEFAULTS, ...opts };
    const dst0 = dstAt(anchorMs);
    if (!fin(dst0)) return { ok: false, why: 'no_anchor_dst' };
    const endMs = anchorMs + o.windowH * HOUR;
    const i0 = lowerBound(wind.arrival, anchorMs), i1 = lowerBound(wind.arrival, endMs + HOUR);
    if ((i1 - i0) / (o.windowH * 60) < o.minWindCoverage) return { ok: false, why: 'thin_wind' };
    const samples = [];
    if (o.driver === 'frozen') {
        // Only wind L1 had measured by the anchor instant; then nothing new is known.
        let last = null;
        for (let i = i0; i < i1 && wind.seen[i] <= anchorMs; i++) { last = { t: wind.arrival[i], v: wind.v[i], n: wind.n[i], bz: wind.bz[i] }; samples.push(last); }
        if (samples.length < 10) return { ok: false, why: 'no_wind_in_transit' };
        // Hold the last known wind to the end of the window (one sample per 10 min is the integrator's own step).
        for (let t = last.t + 10 * MIN; t <= endMs + 30 * MIN; t += 10 * MIN) samples.push({ t, v: last.v, n: last.n, bz: last.bz });
    } else {
        for (let i = i0; i < i1; i++) samples.push({ t: wind.arrival[i], v: wind.v[i], n: wind.n[i], bz: wind.bz[i] });
    }
    if (samples.length < 30) return { ok: false, why: 'thin_wind' };
    // 'centre': the anchor value is the mean over [anchor, anchor+1h), so the run starts mid-hour.
    const startMs = o.convention === 'centre' ? anchorMs + 30 * MIN : anchorMs;
    const from = samples.findIndex((s) => s.t >= startMs);
    const run = integrateDst(from > 0 ? samples.slice(from) : samples, dst0, { model: o.model });
    if (!run.length) return { ok: false, why: 'no_run' };
    const leads = {};
    let minObs = dst0, k = 0;
    for (const L of o.leadsH) {
        const tStamp = anchorMs + L * HOUR, truth = dstAt(tStamp);
        if (!fin(truth)) continue;
        let model;
        if (o.convention === 'centre') {
            let s = 0, m = 0;
            for (const p of run) { if (p.t >= tStamp && p.t < tStamp + HOUR) { s += p.dst; m++; } }
            if (m < 3) continue;
            model = s / m;
        } else {
            while (k + 1 < run.length && run[k + 1].t <= tStamp) k++;
            if (Math.abs(run[k].t - tStamp) > 15 * MIN) continue;
            model = run[k].dst;
        }
        leads[L] = { err: model - truth, perr: dst0 - truth };
    }
    for (let h = 1; h <= o.windowH; h++) { const d = dstAt(anchorMs + h * HOUR); if (fin(d) && d < minObs) minObs = d; }
    return { ok: true, anchorMs, dst0, minObs, disturbed: minObs <= o.disturbedDstNt, leads };
}

function pooled(windows, L) {
    let n = 0, se = 0, sp = 0, bias = 0;
    for (const w of windows) { const e = w.leads[L]; if (!e) continue; n++; se += e.err ** 2; sp += e.perr ** 2; bias += e.err; }
    if (!n) return { n: 0, rmse_nt: null, rmse_persistence_nt: null, skill: null, bias_nt: null };
    return { n, rmse_nt: Math.sqrt(se / n), rmse_persistence_nt: Math.sqrt(sp / n), skill: sp > 0 ? 1 - se / sp : null, bias_nt: bias / n };
}

/** 95 % interval on the pooled skill by resampling whole UTC days of anchors. */
export function bootstrapSkill(windows, L, { n = HINDCAST_DEFAULTS.bootstrapN, seed = HINDCAST_DEFAULTS.seed } = {}) {
    const byDay = new Map();
    for (const w of windows) { if (!w.leads[L]) continue; const d = Math.floor(w.anchorMs / 86400e3); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(w.leads[L]); }
    const days = [...byDay.values()];
    if (days.length < 8) return null;
    const r = rng(seed + L * 7919), out = [];
    for (let b = 0; b < n; b++) {
        let se = 0, sp = 0;
        for (let i = 0; i < days.length; i++) for (const e of days[Math.floor(r() * days.length)]) { se += e.err ** 2; sp += e.perr ** 2; }
        if (sp > 0) out.push(1 - se / sp);
    }
    out.sort((a, b) => a - b);
    return { lo: out[Math.floor(0.025 * out.length)], hi: out[Math.min(out.length - 1, Math.floor(0.975 * out.length))], days: days.length };
}

/** ahead / level / behind from the INTERVAL, not the point: "ahead" only if the whole interval is above 0. */
export function verdictFromInterval(skill, ci) {
    if (!fin(skill) || !ci) return 'unscored';
    if (ci.lo > 0) return 'ahead';
    if (ci.hi < 0) return 'behind';
    return 'level';
}

/**
 * The whole hindcast.
 * @param {{ t0Ms:number, stepMs?:number, speed:number[], density:number[], bz:number[], dst:Array<[number, number]> }} archive
 *        dst = [hourStartMs, nT] pairs.
 */
export function hindcastDst(archive, opts = {}) {
    const o = { ...HINDCAST_DEFAULTS, ...opts };
    const wind = arrivedWind(archive);
    const dstMap = new Map(archive.dst);
    const dstAt = (ms) => dstMap.get(ms);
    const hours = archive.dst.map((d) => d[0]).sort((a, b) => a - b);
    const first = Math.ceil(hours[0] / (o.strideH * HOUR)) * o.strideH * HOUR, last = hours[hours.length - 1] - o.windowH * HOUR;
    const skipped = {};
    const out = { drivers: {}, anchors_tried: 0, skipped };
    for (const driver of ['measured', 'frozen']) for (const convention of ['stamp', 'centre']) {
        const windows = [];
        let tried = 0;
        for (let a = first; a <= last; a += o.strideH * HOUR) {
            tried++;
            const w = runWindow({ wind, dstAt, anchorMs: a, opts: { ...o, driver, convention } });
            if (w.ok) windows.push(w); else if (driver === 'measured' && convention === 'stamp') skipped[w.why] = (skipped[w.why] ?? 0) + 1;
        }
        out.anchors_tried = tried;
        const table = (set) => Object.fromEntries(o.leadsH.map((L) => {
            const p = pooled(set, L), ci = bootstrapSkill(set, L, { n: o.bootstrapN, seed: o.seed });
            return [L, { ...p, skill_ci95: ci ? [ci.lo, ci.hi] : null, days: ci?.days ?? null, verdict: verdictFromInterval(p.skill, ci) }];
        }));
        out.drivers[`${driver}/${convention}`] = {
            driver, convention, windows: windows.length,
            disturbed_windows: windows.filter((w) => w.disturbed).length,
            all: table(windows),
            disturbed: table(windows.filter((w) => w.disturbed)),
            quiet: table(windows.filter((w) => !w.disturbed)),
        };
    }
    out.wind = { samples: wind.length, overtaken: wind.overtaken };
    out.dst = { hours: hours.length, min_nt: Math.min(...archive.dst.map((d) => d[1])), below_disturbed: archive.dst.filter((d) => d[1] <= o.disturbedDstNt).length };
    return out;
}
