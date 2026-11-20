/**
 * js/bz/l1-analysis.js — the L1 rung of the Bz engine, assembled (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B1. Takes two NORMALISED feeds (js/bz/feeds.js
 * `l1-mag` and `l1-ephem`) and returns everything B1 claims: the fused field
 * in the active spacecraft's frame with its σ and flags, the measured
 * arrival-time lags, the withheld-spacecraft score, band powers, and the
 * frame check. The edge route and the browser run THIS function — there is no
 * second assembly. No DOM, no fetch; `nowMs` is an input.
 *
 * It computes nothing of its own: geometry is frames.js, fusion and the score
 * are fuse-l1.js, spectra are spectrum.js, and the background-noise estimate
 * is js/flux-rope-noise.js (the site's ONE Bz noise model — reused, not
 * re-derived).
 */
import { gseToGsmAngleRad, fitRotationAngle, positionAt } from './frames.js';
import { toGrid, lagTrack, fuse, withheldScore, latestLags, advectiveLagMin, FLAG, FUSE_DEFAULTS, STEP_MS } from './fuse-l1.js';
import { bandPowers, compressibility } from './spectrum.js';
import { measureBzNoise } from '../flux-rope-noise.js';

const r2 = (v) => (v == null || v !== v ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || v !== v ? null : Math.round(v * 1000) / 1000);
const DEG = 180 / Math.PI;

/** Flag bitmask → names. */
export function flagNames(mask) {
    const out = [];
    if (mask & FLAG.SINGLE) out.push('single_spacecraft');
    if (mask & FLAG.DISAGREE) out.push('spacecraft_disagree');
    if (mask & FLAG.CONTRADICTED) out.push('one_contradicted');
    if (mask & FLAG.LAG_FALLBACK) out.push('lag_is_flat_delay');
    if (mask & FLAG.SIGMA_UNSET) out.push('sigma_not_yet_measured');
    return out;
}

/**
 * @param {{ mag: object, ephem?: object|null, nowMs: number, minutes?: number, speedKms?: number }} input
 *        mag / ephem are normalizeL1Mag / normalizeEphem results (with samples)
 * @returns {object|null} null when the magnetometer feed has no usable spacecraft
 */
export function analyzeL1({ mag, ephem = null, nowMs, minutes = 180, speedKms = FUSE_DEFAULTS.advectSpeedKms }) {
    const bySc = {};
    for (const [name, v] of Object.entries(mag?.spacecraft ?? {})) {
        if ((v.bz_gsm_valid ?? 0) >= 30) bySc[name] = v.samples;
    }
    const names = Object.keys(bySc);
    if (!names.length) return null;

    const grid = toGrid(bySc);
    const tEnd = grid.t0 + (grid.n - 1) * STEP_MS;

    // Geometry (GSE, R_E) at the newest instant.
    const positions = {};
    for (const s of names) {
        const e = ephem?.spacecraft?.[s];
        const p = e ? positionAt(e.samples, tEnd, { unit: e.unit_inferred === 'Re' ? 'Re' : 'km' }) : null;
        if (p && e.unit_inferred !== 'unknown') positions[s] = p;
    }

    const track = lagTrack(grid, { positions, speedKms });
    const ref = names.includes(mag.active_spacecraft) ? mag.active_spacecraft
        : names.slice().sort((a, b) => mag.spacecraft[b].bz_gsm_valid - mag.spacecraft[a].bz_gsm_valid)[0];
    const fused = fuse(grid, track, ref);
    const score = names.length >= 2 ? withheldScore(grid, track) : {};

    // ── frame check: the angle the feed used vs the angle we compute ──────
    const recent = [];
    for (const s of names) for (const p of bySc[s]) if (p.t > tEnd - 20 * 60e3) recent.push(p);
    const fit = fitRotationAngle(recent);
    const ours = gseToGsmAngleRad(new Date(tEnd - 10 * 60e3));
    const frame_check = fit ? {
        feed_mu_deg: r2(fit.muRad * DEG), computed_mu_deg: r2(ours * DEG),
        difference_deg: r2(((fit.muRad - ours) * DEG + 540) % 360 - 180),
        samples: fit.n, fit_rms_nt: r3(fit.rmsNt),
    } : null;

    // ── lags, with the flat-delay baseline beside each measured one ───────
    const lags = latestLags(track).map((l) => ({
        ...l,
        flat_delay_min: positions[l.pair[0]] && positions[l.pair[1]]
            ? Math.round(advectiveLagMin(positions[l.pair[0]], positions[l.pair[1]], speedKms) * 10) / 10 : null,
        separation_re: positions[l.pair[0]] && positions[l.pair[1]] ? {
            dx: r2(positions[l.pair[0]].x - positions[l.pair[1]].x),
            dy: r2(positions[l.pair[0]].y - positions[l.pair[1]].y),
            dz: r2(positions[l.pair[0]].z - positions[l.pair[1]].z),
        } : null,
    }));

    // ── spectra + structure ──────────────────────────────────────────────
    const spectrum = { fused: bandPowers(fused.bz, 60) };
    const structure = {};
    for (const s of names) {
        spectrum[s] = bandPowers(grid.sc[s].bz, 60);
        const c = compressibility(grid.sc[s], grid.n - 180, grid.n);
        structure[s] = c ? { compressibility: r3(c.c), n: c.n } : null;
    }
    for (const sp of Object.values(spectrum)) {
        for (const b of sp.bands) { b.power = r3(b.power); b.rms = r3(b.rms); }
    }

    // ── flag census over the whole record ────────────────────────────────
    const census = { minutes: 0, single_spacecraft: 0, spacecraft_disagree: 0, one_contradicted: 0, lag_is_flat_delay: 0, n_hist: {} };
    for (let i = 0; i < grid.n; i++) {
        if (fused.bz[i] !== fused.bz[i]) continue;
        census.minutes++;
        census.n_hist[fused.n[i]] = (census.n_hist[fused.n[i]] ?? 0) + 1;
        if (fused.flags[i] & FLAG.SINGLE) census.single_spacecraft++;
        if (fused.flags[i] & FLAG.DISAGREE) census.spacecraft_disagree++;
        if (fused.flags[i] & FLAG.CONTRADICTED) census.one_contradicted++;
        if (fused.flags[i] & FLAG.LAG_FALLBACK) census.lag_is_flat_delay++;
    }

    // ── the site's ONE background-noise estimate, on the fused series ────
    const fusedSamples = [];
    for (let i = 0; i < grid.n; i++) if (fused.bz[i] === fused.bz[i]) fusedSamples.push({ t: grid.t0 + i * STEP_MS, bz: fused.bz[i] });
    const nz = measureBzNoise(fusedSamples, { nowMs: tEnd });
    const noise = nz.ok ? { sigma_bg_nt: r2(nz.sigmaNt), sigma_hf_nt: r2(nz.sigmaHfNt), median_nt: r2(nz.medianNt), coverage: r3(nz.coverage) } : null;

    // ── newest fused minute + the trace ──────────────────────────────────
    let last = -1;
    for (let i = grid.n - 1; i >= 0; i--) if (fused.bz[i] === fused.bz[i]) { last = i; break; }
    const i0 = Math.max(0, grid.n - Math.max(1, minutes));
    const trace = { t0: new Date(grid.t0 + i0 * STEP_MS).toISOString(), step_s: 60,
        bz: [], sigma: [], n: [], flags: [], spacecraft: Object.fromEntries(names.map((s) => [s, []])) };
    for (let i = i0; i < grid.n; i++) {
        trace.bz.push(r2(fused.bz[i])); trace.sigma.push(r2(fused.sigma[i]));
        trace.n.push(fused.n[i]); trace.flags.push(fused.flags[i]);
        for (const s of names) trace.spacecraft[s].push(r2(grid.sc[s].bz[i]));
    }

    const scoreOut = {};
    for (const [s, v] of Object.entries(score)) {
        scoreOut[s] = { n: v.n, rmse_nt: r3(v.rmse), mae_nt: r3(v.mae), rmse_unshifted_nt: r3(v.rmse_unshifted),
            skill_vs_unshifted: r3(v.skill), coverage68: r3(v.coverage68) };
    }

    return {
        frame: 'GSM',
        reference_spacecraft: ref,
        claim: 'field at the reference spacecraft, fused from every spacecraft in the file after measured arrival-time alignment',
        spacecraft: names,
        window: { start: new Date(grid.t0).toISOString(), end: new Date(tEnd).toISOString(), minutes: grid.n },
        age_s: Number.isFinite(nowMs) && last >= 0 ? Math.round((nowMs - (grid.t0 + last * STEP_MS)) / 1000) : null,
        latest: last >= 0 ? {
            time: new Date(grid.t0 + last * STEP_MS).toISOString(),
            bz_nt: r2(fused.bz[last]), by_nt: r2(fused.by[last]), bx_nt: r2(fused.bx[last]),
            sigma_nt: r2(fused.sigma[last]), sigma_status: 'provisional',
            spacecraft_used: fused.n[last], flags: flagNames(fused.flags[last]),
            kind: 'MEASURED',
        } : null,
        lags,
        positions_gse_re: Object.fromEntries(Object.entries(positions).map(([s, p]) => [s, { x: r2(p.x), y: r2(p.y), z: r2(p.z), held: p.held }])),
        withheld_score: scoreOut,
        flag_census: census,
        contradicted_minutes: fused.contradicted,
        frame_check,
        noise,
        spectrum,
        structure,
        flag_bits: FLAG,
        trace,
    };
}
