/**
 * js/bz/flux-analysis.js — rung 1 of the Bz engine, assembled (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B2. Takes three NORMALISED feeds (l1-mag, l1-ephem,
 * l1-plasma) and returns: the fused L1 field (js/bz/l1-analysis.js, unchanged),
 * the phase-front delay from the reference spacecraft to the bow-shock nose
 * with the method that produced it, and the dayside reconnection rate that
 * field implies — as a series ordered by ARRIVAL time, which runs past "now"
 * by the delay. No DOM, no fetch; `nowMs` is an input.
 *
 * KINDS (plan §2): nothing here is MEASURED except the L1 field itself.
 * A value whose arrival time is ≤ now is ESTIMATED (there is no instrument at
 * the bow shock); one arriving after now is a FORECAST. The split is by
 * arrival time and is carried on every row.
 *
 * WHAT IS NOT IN IT: the bow shock and the magnetosheath. The rate is
 * computed from the UPSTREAM field, as both coupling functions are defined,
 * and the delay stops at the shock nose — the sheath transit (a few more
 * minutes) and the draped, amplified field are B4.
 *
 * It owns no physics: boundaries are js/geomag/geospace.js, fusion is
 * fuse-l1.js, delays are propagate.js, rates are flux.js.
 */
import { analyzeL1 } from './l1-analysis.js';
import { positionAt, RE_KM } from './frames.js';
import { toGrid, lagTrack, fuse, STEP_MS, FUSE_DEFAULTS } from './fuse-l1.js';
import { chooseSlowness, flatSlowness, mvab, delayS, arrivalOrder, slownessFromNormal, describeSlowness, PROP_DEFAULTS } from './propagate.js';
import { milanRateKv, milanSigmaKv, newellNative, newellMilanEquivalentKv, siscoeHillKv, openedFluxGWb, REFERENCE_WIND, SISCOE_HILL } from './flux.js';
import { boundaryModel, dynamicPressureNPa } from '../geomag/geospace.js';

const r1 = (v) => (v == null || v !== v ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || v !== v ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || v !== v ? null : Math.round(v * 1000) / 1000);

/** Plasma on the magnetometer grid: per-minute speed / density / velocity (GSE), NaN gaps. */
function plasmaGrid(samples, t0, n) {
    const g = { speed: new Float64Array(n).fill(NaN), density: new Float64Array(n).fill(NaN),
        vx: new Float64Array(n).fill(NaN), vy: new Float64Array(n).fill(NaN), vz: new Float64Array(n).fill(NaN) };
    for (const s of samples ?? []) {
        const i = Math.round((s.t - t0) / STEP_MS);
        if (i < 0 || i >= n) continue;
        if (s.speed != null) g.speed[i] = s.speed;
        if (s.density != null) g.density[i] = s.density;
        if (s.vx_gse != null && s.vy_gse != null && s.vz_gse != null) { g.vx[i] = s.vx_gse; g.vy[i] = s.vy_gse; g.vz[i] = s.vz_gse; }
    }
    return g;
}

function med(a) { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); }

/** Median of the valid values in [i − window, i]; NaN if fewer than `min`. */
function trailingMedian(a, i, window, min = 3) {
    const buf = [];
    for (let k = Math.max(0, i - window); k <= i; k++) if (a[k] === a[k]) buf.push(a[k]);
    if (buf.length < min) return NaN;
    buf.sort((x, y) => x - y);
    const m = buf.length >> 1;
    return buf.length % 2 ? buf[m] : 0.5 * (buf[m - 1] + buf[m]);
}

/**
 * @param {{ mag:object, ephem?:object|null, plasma?:object|null, nowMs:number, minutes?:number }} input
 * @returns {object|null}
 */
export function analyzeFlux({ mag, ephem = null, plasma = null, nowMs, minutes = 180 }) {
    const l1 = analyzeL1({ mag, ephem, nowMs, minutes });
    if (!l1) return null;
    const ref = l1.reference_spacecraft;

    // Rebuild the grid/track/fused arrays (analyzeL1 returns rounded reports).
    const bySc = {};
    for (const s of l1.spacecraft) bySc[s] = mag.spacecraft[s].samples;
    const grid = toGrid(bySc);
    const N = grid.n;
    const tEnd = grid.t0 + (N - 1) * STEP_MS;
    const positions = {};
    for (const s of l1.spacecraft) {
        const e = ephem?.spacecraft?.[s];
        const p = e && e.unit_inferred !== 'unknown' ? positionAt(e.samples, tEnd, { unit: e.unit_inferred === 'Re' ? 'Re' : 'km' }) : null;
        if (p) positions[s] = p;
    }

    // Plasma: the reference spacecraft's if it has any, else the best-covered one — and say which.
    const pl = plasma?.spacecraft ?? {};
    const plasmaSc = pl[ref]?.speed_valid >= 10 ? ref
        : Object.keys(pl).sort((a, b) => pl[b].speed_valid - pl[a].speed_valid)[0] ?? null;
    const pg = plasmaSc && pl[plasmaSc].speed_valid >= 10 ? plasmaGrid(pl[plasmaSc].samples, grid.t0, N) : null;
    if (!pg) {
        return { ...l1, flux: null, propagation: null, reasons: ['no_plasma'] };
    }

    const lastSpeed = trailingMedian(pg.speed, N - 1, 60);
    const track = lagTrack(grid, { positions, speedKms: lastSpeed === lastSpeed ? lastSpeed : FUSE_DEFAULTS.advectSpeedKms });
    const fused = fuse(grid, track, ref);
    const refPos = positions[ref] ?? null;

    // ── per-step slowness, per-minute delay ──────────────────────────────
    const steps = Math.ceil(N / track.step);
    const stepInfo = [];
    const delays = new Float64Array(N).fill(NaN), flatDelays = new Float64Array(N).fill(NaN);
    const speedUsed = new Float64Array(N).fill(NaN), densUsed = new Float64Array(N).fill(NaN);
    const noseRe = new Float64Array(N).fill(NaN);
    let heldSpeed = 0;
    const chk = { mvab: [], flat: [] };   // |predicted − measured| pair lag, minutes
    for (let k = 0; k < steps; k++) {
        const i0 = k * track.step, i1 = Math.min(N, i0 + track.step);
        const vMed = trailingMedian(pg.speed, Math.max(0, i0 - 1), 30);
        const vxM = trailingMedian(pg.vx, Math.max(0, i0 - 1), 30), vyM = trailingMedian(pg.vy, Math.max(0, i0 - 1), 30), vzM = trailingMedian(pg.vz, Math.max(0, i0 - 1), 30);
        const haveVec = vxM === vxM && vyM === vyM && vzM === vzM;
        const V = haveVec ? [vxM, vyM, vzM] : (vMed === vMed ? [-vMed, 0, 0] : null);
        let info = null;
        if (V && refPos) {
            const lags = [];
            const seen = new Set();
            for (const [key, list] of Object.entries(track.pairs)) {
                const [a, b] = key.split('>');
                if (seen.has(`${b}>${a}`)) continue;
                seen.add(key);
                const e = list[k];
                if (e) lags.push({ pair: [a, b], lagMin: e.lagMin, r: e.r, source: e.source });
            }
            // MVAB on the reference spacecraft's own trailing 30 minutes (causal).
            const mv = mvab(grid.sc[ref], Math.max(0, i0 - 30), i0);
            info = chooseSlowness({ positions, lags, V, mvabResult: mv });
            // THE ONLY TRUTH AVAILABLE FOR A SINGLE-SPACECRAFT NORMAL: wherever a
            // pair lag was MEASURED this step, ask what the MVAB normal and the
            // flat delay would each have predicted for that same pair.
            if (mv?.ok) {
                const mm = slownessFromNormal(mv.normal, V), fm = flatSlowness(V);
                const dm = mm ? describeSlowness(mm, V) : null;
                if (dm && dm.tiltDeg <= PROP_DEFAULTS.maxTiltDeg) {
                    for (const l of lags) {
                        if (l.source !== 'measured' || !positions[l.pair[0]] || !positions[l.pair[1]]) continue;
                        chk.mvab.push(Math.abs(delayS(mm, positions[l.pair[0]], positions[l.pair[1]]) / 60 - l.lagMin));
                        chk.flat.push(Math.abs(delayS(fm, positions[l.pair[0]], positions[l.pair[1]]) / 60 - l.lagMin));
                    }
                }
            }
            if (info) info.vectorVelocity = haveVec;
        }
        stepInfo.push(info);
        for (let i = i0; i < i1; i++) {
            // The parcel's own speed sets its own delay; hold the trailing median across a plasma gap, and count it.
            let v = pg.speed[i];
            if (!(v === v)) { v = trailingMedian(pg.speed, i, 30); if (v === v) heldSpeed++; }
            let d = pg.density[i];
            if (!(d === d)) d = trailingMedian(pg.density, i, 30);
            speedUsed[i] = v; densUsed[i] = d;
            if (!(v === v) || !refPos) continue;
            const bm = boundaryModel({ speedKms: v, densityCc: d === d ? d : undefined, bzNt: fused.bz[i] === fused.bz[i] ? fused.bz[i] : undefined });
            noseRe[i] = bm.bowNoseRe;
            const target = { x: bm.bowNoseRe, y: 0, z: 0 };
            const flat = flatSlowness([-v, 0, 0]);
            flatDelays[i] = delayS(flat, refPos, target);
            if (info && info.method !== 'flat') {
                // Rescale the step's slowness to this minute's speed: the DIRECTION is the step's, V·m = 1 is the minute's.
                const scale = (vMed === vMed && vMed > 0) ? vMed / v : 1;
                delays[i] = delayS(info.m.map((x) => x * scale), refPos, target);
            } else delays[i] = flatDelays[i];
            // A delay that puts the arrival BEFORE the observation, or absurdly late, is not a propagation.
            if (!(delays[i] > 0 && delays[i] < 4 * flatDelays[i])) delays[i] = flatDelays[i];
        }
    }

    // ── rates at each fused minute ───────────────────────────────────────
    const tMs = new Float64Array(N), milan = new Float64Array(N).fill(NaN), sig = new Float64Array(N).fill(NaN), newell = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
        tMs[i] = grid.t0 + i * STEP_MS;
        const v = speedUsed[i], by = fused.by[i], bz = fused.bz[i];
        if (!(v === v && by === by && bz === bz)) continue;
        milan[i] = milanRateKv(v, by, bz);
        const s = milanSigmaKv(v, by, bz, fused.sigma[i]);
        sig[i] = s == null ? NaN : s;
        newell[i] = newellMilanEquivalentKv(v, by, bz);
    }
    const order = arrivalOrder(tMs, delays);

    // ── the series by arrival time ───────────────────────────────────────
    const rows = order.keep.filter((i) => milan[i] === milan[i]);
    let nowIdx = -1;
    for (const i of rows) if (order.arrivalMs[i] <= nowMs) nowIdx = i;
    const newest = rows.length ? rows[rows.length - 1] : -1;
    const kindOf = (i) => (order.arrivalMs[i] <= nowMs ? 'ESTIMATED' : 'FORECAST');
    const describe = (i) => {
        if (i < 0) return null;
        const v = speedUsed[i], d = densUsed[i];
        const pd = d === d ? dynamicPressureNPa(d, v) : null;
        const sh = pd ? siscoeHillKv(v, fused.by[i], fused.bz[i], pd) : null;
        const k = Math.floor(i / track.step);
        return {
            kind: kindOf(i),
            arrives: new Date(order.arrivalMs[i]).toISOString(),
            observed_at_l1: new Date(tMs[i]).toISOString(),
            delay_min: r1(delays[i] / 60), flat_delay_min: r1(flatDelays[i] / 60),
            method: stepInfo[k]?.method ?? 'flat',
            bz_nt: r2(fused.bz[i]), by_nt: r2(fused.by[i]), sigma_bz_nt: r2(fused.sigma[i]),
            speed_kms: r1(v), density_cc: r2(d === d ? d : null), pdyn_npa: r2(pd), bow_shock_nose_re: r2(noseRe[i]),
            reconnection_rate_kv: { milan2012: r1(milan[i]), sigma: r1(sig[i]), newell2007_scaled: r1(newell[i]),
                newell2007_native: r1(newellNative(v, fused.by[i], fused.bz[i])) },
            transpolar_potential_kv: sh ? { siscoe_hill: r1(sh.potentialKv), unsaturated: r1(sh.unsaturatedKv),
                saturated_fraction: r3(sh.saturatedFraction), sigma_p_s: sh.sigmaP, coefficients_verified: false } : null,
        };
    };

    // Flux opened over the last hour of ARRIVALS up to now.
    const hourRows = rows.filter((i) => order.arrivalMs[i] <= nowMs && order.arrivalMs[i] > nowMs - 3600e3);
    const opened = openedFluxGWb(hourRows.map((i) => order.arrivalMs[i]), hourRows.map((i) => milan[i]));

    // Method census + how far the phase-front delay departs from the flat one.
    const methods = {};
    let dn = 0, dsum = 0, dmax = 0;
    for (const i of rows) {
        const m = stepInfo[Math.floor(i / track.step)]?.method ?? 'flat';
        methods[m] = (methods[m] ?? 0) + 1;
        const d = Math.abs(delays[i] - flatDelays[i]) / 60;
        dn++; dsum += d; if (d > dmax) dmax = d;
    }
    const lastInfo = stepInfo[stepInfo.length - 1];

    // Trace by arrival time, the last `minutes` of rows.
    const tr = rows.slice(-Math.max(1, minutes));
    const trace = { columns: ['arrives', 'kind', 'milan_kv', 'sigma_kv', 'newell_scaled_kv', 'bz_nt', 'delay_min'],
        rows: tr.map((i) => [new Date(order.arrivalMs[i]).toISOString(), kindOf(i) === 'FORECAST' ? 'F' : 'E',
            r1(milan[i]), r1(sig[i]), r1(newell[i]), r2(fused.bz[i]), r1(delays[i] / 60)]) };

    // The arrived wind, unrounded, for the rungs below (geo-analysis.js). Routes strip it.
    const _series = { arrivalMs: rows.map((i) => order.arrivalMs[i]), speed: rows.map((i) => speedUsed[i]),
        density: rows.map((i) => densUsed[i]), bz: rows.map((i) => fused.bz[i]), by: rows.map((i) => fused.by[i]),
        milanKv: rows.map((i) => milan[i]) };

    return {
        ...l1,
        _series,
        plasma: { spacecraft: plasmaSc, is_reference: plasmaSc === ref, speed_held_minutes: heldSpeed,
            vector_velocity: !!lastInfo?.vectorVelocity },
        propagation: {
            target: 'bow-shock nose (js/geomag/geospace.js, Farris & Russell 1991 at the parcel\'s own dynamic pressure)',
            from: ref,
            latest: lastInfo ? {
                method: lastInfo.method, tilt_deg: r1(lastInfo.tiltDeg),
                normal_gse: lastInfo.normal?.map(r3), pairs: lastInfo.pairs ?? null,
                closure_min: r2(lastInfo.closure_min), condition: r2(lastInfo.condition),
                mvab_ratio: r2(lastInfo.mvab_ratio), notes: lastInfo.notes,
            } : null,
            method_minutes: methods,
            departure_from_flat_min: dn ? { mean: r2(dsum / dn), max: r2(dmax) } : null,
            overtaken_minutes: order.overtaken,
            // How well a single-spacecraft MVAB normal predicts the lags that
            // were actually measured between spacecraft, beside the flat
            // delay's error on the same pairs. If `mvab` is not clearly the
            // smaller, MVAB has not earned its place above the flat delay.
            mvab_check: chk.mvab.length ? { n: chk.mvab.length,
                mvab_median_err_min: r2(med(chk.mvab)), flat_median_err_min: r2(med(chk.flat)),
                mvab_better_fraction: r3(chk.mvab.filter((e, i) => e < chk.flat[i]).length / chk.mvab.length) } : null,
            max_tilt_deg: PROP_DEFAULTS.maxTiltDeg,
        },
        flux: {
            definition: 'dayside reconnection rate from the upstream (unshocked) field; the sheath is not modelled yet',
            at_bow_shock_now: describe(nowIdx),
            newest_arrival: describe(newest),
            forecast_horizon_min: newest >= 0 ? r1((order.arrivalMs[newest] - nowMs) / 60000) : null,
            opened_last_hour: { gwb: r3(opened.gwb), covered_min: r1(opened.covered_s / 60), gaps: opened.gaps },
            newell_normalised_at: REFERENCE_WIND,
            siscoe_hill_verified: SISCOE_HILL.verified,
            trace,
        },
    };
}
