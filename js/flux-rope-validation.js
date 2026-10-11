/**
 * flux-rope-validation.js — PURE decision/scoring logic for the daily
 * flux-rope validation + trajectory-analysis loop ("for each flare": one
 * ledger entry per flare-associated CME, locked before arrival, resolved
 * against L1 truth, scored probabilistically).
 *
 * The cron (api/cron/validation-rerun.js) stays thin: it fetches (DONKI
 * CMEAnalysis + FLR, NOAA RTSW, sw_geomag_dataset rows), runs the SHARED
 * provider (js/flux-rope-forecast.js) on the committed WASM, and calls the
 * functions here — which are node-gated by tests/flux-rope-validation.mjs
 * with zero network. Storage contract: cme_events / cme_arrival_forecasts
 * (INSERT-only, model_id 'flux-rope-v1') / cme_l1_observations (enriched
 * with Bz-structure truth) — CME_FORECAST_VALIDATION_PLAN.md.
 *
 * Scoring: arrival error + CRPS (quantile form, comparable with the point
 * models' MAE on the same ledger), Brier for the locked storm
 * probabilities, and the §5 DBM inversion — the retrieved (Γ, w) per event
 * is the trajectory-analysis product that becomes population priors.
 *
 * COMPOUNDING SCORING (2026-08-30): multi-rope trains additionally lock
 * the §16 COUNTERFACTUAL (js/flux-rope-compounding.js measureCompounding —
 * identical ropes/priors/seed, interaction OFF) so the interaction physics
 * itself gets scored against outcomes, not just believed:
 *   · lock — per-rope `inputs.wake` (leader, wake Δv, drag ratio,
 *     interaction arrival shift, and the INDEPENDENT-run arrival time) +
 *     the train-level `inputs.compounding` block on the first-arriving row
 *     (ON/OFF scalars, deltas, predicted min-Bz amplification, and the
 *     OFF-side arrival quantiles so CRPS scores BOTH sides identically).
 *   · score — per event: arrival |error| ON vs OFF (gain > 0 = §16
 *     helped), CRPS gain, min-Bz gain, Brier(−20 nT) both sides, and
 *     predicted vs OBSERVED amplification (amplificationFactor).
 *   · aggregate — the §19–§21 FITTING SIGNALS: `followerBiasOnH` is the
 *     signed arrival bias of wake-riding followers under the interacting
 *     model (negative = §16 wake brings them in too early ⇒ the Gannon
 *     momentum-overshoot direction: fit §19 restitution / §20 wake
 *     refresh DOWN; positive with OFF unbiased = wake too weak);
 *     `ampObs` vs `ampPred` says whether §16 under- or over-amplifies
 *     min Bz on real trains. The v1.6 knobs stay default-off until this
 *     evidence accumulates — that is the whole point of the ledger.
 */

import { crpsFromQuantiles, brierScore, amplificationFactor }
    from './forecast-verification.js';
import { dbmApexKm, dbmSpeedKms, invertGammaW, invertGamma, AU_KM, RSUN_KM }
    from './flux-rope-inversion.js';

export const FLUX_ROPE_MODEL_ID = 'flux-rope-v1';
/** Arrival-quantile levels locked in `inputs.arrivalQ` (CRPS-scorable). */
export const ARRIVAL_Q_LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9];

// ── Flare association ("for each flare") ─────────────────────────────────────

/** Normalize raw NASA DONKI FLR rows (direct API shape). Pure. */
export function parseDonkiFlares(raw) {
    return (Array.isArray(raw) ? raw : [])
        .filter((f) => f?.flrID && (f.peakTime || f.beginTime))
        .map((f) => ({
            flrID: f.flrID,
            classType: f.classType ?? null,
            peakMs: Date.parse(f.peakTime ?? f.beginTime),
            beginMs: f.beginTime ? Date.parse(f.beginTime) : null,
            sourceLocation: f.sourceLocation ?? null,
            activeRegionNum: f.activeRegionNum ?? null,
        }))
        .filter((f) => Number.isFinite(f.peakMs));
}

/**
 * Associate a CME launch (time21_5, ms) with its source flare: the flare
 * whose PEAK sits in [launch − maxBeforeH, launch + maxAfterH] (a flare
 * peaks before or around the 21.5 R☉ crossing), nearest in time. Null =
 * no plausible association — recorded honestly, never forced.
 */
export function associateFlare(flares, launchMs, { maxBeforeH = 2.5, maxAfterH = 0.5 } = {}) {
    let best = null;
    for (const f of flares ?? []) {
        const dtH = (launchMs - f.peakMs) / 3.6e6;   // + = flare before launch
        if (dtH < -maxAfterH || dtH > maxBeforeH) continue;
        if (!best || Math.abs(dtH) < Math.abs(best.dtH)) best = { ...f, dtH };
    }
    return best;
}

// ── Per-flare forecast rows (issue-time lock) ────────────────────────────────

/**
 * Per-rope deterministic arrival [s after epoch] + a parametric ±σ_v0
 * window, from the EFFECTIVE (wake-modified) kinematics via the §5 mirror
 * (exact vs the kernel while §20/§19 are off — the provider default).
 * Null when the rope never reaches the observer inside 15 days.
 */
export function ropeArrivalWindow({
    launchOffsetS = 0, v0Kms, wEffKms, gammaEffPerKm,
    sigV0Kms = 100, d0Km = 21.5 * RSUN_KM, rObsKm = 0.99 * AU_KM,
}) {
    const cross = (v0) => {
        if (dbmApexKm(d0Km, v0, wEffKms, gammaEffPerKm, 15 * 86400) < rObsKm) return NaN;
        let lo = 0, hi = 15 * 86400;
        for (let i = 0; i < 100; i++) {
            const mid = 0.5 * (lo + hi);
            if (dbmApexKm(d0Km, v0, wEffKms, gammaEffPerKm, mid) < rObsKm) lo = mid;
            else hi = mid;
        }
        return launchOffsetS + 0.5 * (lo + hi);
    };
    const point = cross(v0Kms);
    if (!Number.isFinite(point)) return null;
    const early = cross(v0Kms + sigV0Kms);
    const late = cross(Math.max(150, v0Kms - sigV0Kms));
    return {
        arrivalS: point,
        earlyS: Number.isFinite(early) ? early : point,
        lateS: Number.isFinite(late) ? late : point + 24 * 3600,
        vArrKms: dbmSpeedKms(v0Kms, wEffKms, gammaEffPerKm, point - launchOffsetS),
    };
}

/**
 * Freeze a measureCompounding result into the ledger's snake_case
 * `inputs.compounding` shape (pure; null passes through). Only scalars —
 * the frozen block must replay-score without a kernel.
 */
export function freezeCompounding(cp) {
    if (!cp) return null;
    const side = (s) => ({
        p_hit: s.pHit ?? null,
        p10: s.p10 ?? null,
        p20: s.p20 ?? null,
        min_bz_p50: s.minBzP50 ?? null,
        arrival_p50_h: s.arrivalP50H ?? null,
    });
    return {
        method: cp.disclosure,
        members: cp.members,
        on: side(cp.on),
        off: side(cp.off),
        delta: {
            min_bz_p50: cp.delta.minBzP50,
            p10: cp.delta.p10,
            p20: cp.delta.p20,
            p_hit: cp.delta.pHit,
            arrival_p50_h: cp.delta.arrivalP50H,
        },
        // Predicted min-Bz amplification of the interacting train over the
        // independent superposition — the number ampObs is scored against.
        amp_pred: amplificationFactor(
            Math.abs(cp.on.minBzP50 ?? NaN), Math.abs(cp.off.minBzP50 ?? NaN)),
        ...(cp.off?.arrivalQH && cp.levels
            ? { arrival_q_off: { levels: [...cp.levels], hours: [...cp.off.arrivalQH] } }
            : {}),
    };
}

/**
 * Build the issue-time-locked flux-rope-v1 rows — ONE PER FLARE/CME of the
 * modeled train (trajectory ledger), each carrying the frozen inputs that
 * replay it bit-exactly (train ids + seed) plus the train-level
 * probabilistic quantities. The earliest-arriving row carries the
 * CRPS-scorable train-onset arrival quantiles (`inputs.arrivalQ`) — the
 * train's first shock is what the onset distribution predicts.
 *
 * `compounding` (a measureCompounding result, multi-rope trains only)
 * additionally freezes the §16 counterfactual: per-row `inputs.wake` and
 * the train-level `inputs.compounding` on the first-arriving row.
 *
 * All inputs are plain data (the cron extracts kernel/effective params);
 * pure and node-gated.
 */
export function fluxRopeForecastRows({
    eventIdFor,           // (cmeId) → cme_events event_id
    cmes,                 // the train members, launch-ascending (provider fc.cmes)
    ropes,                // preset ropes, index-aligned with cmes
    eff,                  // [{ wEffKms, gammaEffPerKm }] per rope (kernel getters)
    sigV0Kms = 100,       // the prior's speed spread (parametric window)
    launchMs,             // train epoch (rope 0 launch)
    seed,
    summary,              // provider summary (pHit, p10, p20, minBzP50/P5, nRopes)
    arrivalQH = null,     // train-onset arrival quantiles [h], ARRIVAL_Q_LEVELS
    sigmaNt, sheathDeltaNt, noiseSigmaNt = null,
    flares = [],          // parsed flares for association
    compounding = null,   // measureCompounding result (trains ≥ 2) or null
}) {
    const rows = [];
    let firstArrival = Infinity, firstIdx = -1;
    const windows = cmes.map((c, i) => {
        const w = ropeArrivalWindow({
            launchOffsetS: ropes[i].launchOffsetS ?? 0,
            v0Kms: ropes[i].v0Kms,
            wEffKms: eff[i].wEffKms,
            gammaEffPerKm: eff[i].gammaEffPerKm,
            sigV0Kms,
        });
        if (w && w.arrivalS < firstArrival) { firstArrival = w.arrivalS; firstIdx = i; }
        return w;
    });
    for (let i = 0; i < cmes.length; i++) {
        const w = windows[i];
        if (!w) continue;   // a never-arriving member gets no arrival row
        const c = cmes[i];
        const cmeLaunchMs = launchMs + (ropes[i].launchOffsetS ?? 0) * 1000;
        const flare = associateFlare(flares, cmeLaunchMs);
        const iso = (ms) => new Date(ms).toISOString();
        rows.push({
            event_id: eventIdFor(c.id),
            model_id: FLUX_ROPE_MODEL_ID,
            predicted_arrival_utc: iso(launchMs + w.arrivalS * 1000),
            arrival_window_early: iso(launchMs + w.earlyS * 1000),
            arrival_window_late: iso(launchMs + w.lateS * 1000),
            predicted_hit: summary.pHit >= 0.5,
            predicted_speed_at_l1: Math.round(w.vArrKms),
            inputs: {
                method: 'flux-rope v1.6 compounding train (spec §12.1/§16)',
                train: cmes.map((m) => m.id),
                ropeIndex: i,
                seed,
                launch: iso(cmeLaunchMs),
                epoch: iso(launchMs),
                v0_kms: ropes[i].v0Kms,
                lon_deg: ropes[i].lonDeg,
                lat_deg: ropes[i].latDeg,
                half_deg: c.halfAngleDeg ?? null,
                w_eff_kms: Math.round(eff[i].wEffKms),
                gamma_eff_per_km: eff[i].gammaEffPerKm,
                sig_v0_kms: sigV0Kms,
                p_hit: summary.pHit,
                p10: summary.p10,
                p20: summary.p20,
                min_bz_p50: summary.minBzP50,
                min_bz_p5: summary.minBzP5,
                sigma_nt: sigmaNt,
                sheath_delta_nt: sheathDeltaNt,
                noise_sigma_nt: noiseSigmaNt,
                flare: flare ? {
                    id: flare.flrID, class: flare.classType,
                    peak: iso(flare.peakMs), region: flare.activeRegionNum,
                    location: flare.sourceLocation, dt_h: Math.round(flare.dtH * 10) / 10,
                } : null,
                ...(i === firstIdx && Array.isArray(arrivalQH)
                    ? { arrivalQ: { levels: ARRIVAL_Q_LEVELS, hours: arrivalQH } }
                    : {}),
                // §16 counterfactual freeze: THIS rope's interaction
                // diagnostics + independent-run arrival (scored vs the same
                // shock the ON prediction is), train-level block once.
                ...(compounding?.ropes?.[i] ? { wake: (() => {
                    const cr = compounding.ropes[i];
                    return {
                        leader: cr.leader,
                        dv_kms: Number.isFinite(cr.wakeDvKms)
                            ? Math.round(cr.wakeDvKms) : null,
                        gamma_ratio: Number.isFinite(cr.gammaRatio)
                            ? Math.round(cr.gammaRatio * 1000) / 1000 : null,
                        delta_arrival_h: Number.isFinite(cr.deltaH)
                            ? Math.round(cr.deltaH * 100) / 100 : null,
                        arrival_indep_utc: Number.isFinite(cr.arrivalOffH)
                            ? iso(launchMs + cr.arrivalOffH * 3.6e6) : null,
                    };
                })() } : {}),
                ...(i === firstIdx && compounding
                    ? { compounding: freezeCompounding(compounding) }
                    : {}),
            },
        });
    }
    return rows;
}

// ── Forecast honesty: what may be LOCKED, and which lock may be SCORED ───────
//
// Measured on the production ledger 2026-10-11 (tests/flux-rope-ledger-real.mjs
// pins it on the real rows): the lock step had no issue-before-arrival guard,
// so the daily re-run kept appending rows after a CME had already hit — 4 of
// the 8 arrived events were scored on a lock ISSUED AFTER the observed shock
// (the provider had already assimilated the shock from live L1), and several
// rows predicted an arrival that was already in the past at issue time. Both
// are postdictions; scoring them reported a 26.4 h MAE that was neither the
// model's skill nor honest about it. The CME ledger (enlil/dbm/ballistic)
// always had this guard (`predMs > nowMs` in validation-rerun) — these two
// functions are the flux-rope equivalent, pure and node-gated.

/**
 * Filter freshly built lock rows down to the ones that are still genuine
 * FORECASTS at `nowMs`: the predicted arrival must lie in the future, and the
 * event must not already have L1 truth (`resolvedEventIds`) — once a shock
 * is on the record, any new row has seen it through the particle filter.
 */
export function filterLockableRows(rows, { nowMs, resolvedEventIds = new Set() } = {}) {
    const kept = [], dropped = { postdiction: 0, resolved: 0 };
    for (const r of rows ?? []) {
        if (resolvedEventIds.has(r.event_id)) { dropped.resolved++; continue; }
        if (!(Date.parse(r.predicted_arrival_utc) > nowMs)) { dropped.postdiction++; continue; }
        kept.push(r);
    }
    return { rows: kept, dropped };
}

/**
 * Pick the ONE lock of an event that may be scored against `truth`: the
 * latest lock that was (a) a forecast when issued (predicted arrival after
 * issue time) and (b) issued strictly before the observed shock. For a
 * false alarm (`truth.arrived === false`) only (a) applies. Returns
 * `{ lock, rejected: { postdiction, afterShock } }`; `lock` is null when no
 * lock qualifies — the event is then NOT scored (an honest gap, never a
 * fallback to a leaked row).
 */
export function selectScorableLock(locks, truth) {
    const rejected = { postdiction: 0, afterShock: 0 };
    const shockMs = truth?.arrived ? truth.shockMs : NaN;
    let best = null, bestIssued = -Infinity;
    for (const l of locks ?? []) {
        const issued = Date.parse(l.issued_at);
        const pred = Date.parse(l.predicted_arrival_utc);
        if (!(Number.isFinite(issued) && Number.isFinite(pred))) continue;
        if (Number.isFinite(shockMs) && !(issued < shockMs)) { rejected.afterShock++; continue; }
        if (!(pred > issued)) { rejected.postdiction++; continue; }
        if (issued > bestIssued) { best = l; bestIssued = issued; }
    }
    return { lock: best, rejected };
}

/**
 * Paired arrival skill: every model scored on the SAME events with the SAME
 * lock-selection rule (selectScorableLock), so the flux-rope numbers are
 * directly comparable with enlil / dbm-v1 / ballistic-v1 on the ledger.
 * `locks`: rows {event_id, model_id, issued_at, predicted_arrival_utc};
 * `truthByEvent`: Map event_id → {arrived, shockMs}. Only ARRIVED events
 * count. Returns { [model_id]: { n, maeH, biasH, medianAbsH, hit12, events } }
 * plus `paired`: the stats restricted to events EVERY model scored.
 */
export function pairedArrivalSkill(locks, truthByEvent) {
    const byModel = new Map();
    for (const l of locks ?? []) {
        const key = `${l.model_id}|${l.event_id}`;
        if (!byModel.has(key)) byModel.set(key, []);
        byModel.get(key).push(l);
    }
    const errs = {};   // model → Map(event → errH)
    for (const [key, ls] of byModel) {
        const [model, eid] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
        const t = truthByEvent.get(eid);
        if (!t?.arrived || !Number.isFinite(t.shockMs)) continue;
        const { lock } = selectScorableLock(ls, t);
        if (!lock) continue;
        (errs[model] ??= new Map()).set(eid,
            (Date.parse(lock.predicted_arrival_utc) - t.shockMs) / 3.6e6);
    }
    const stats = (vals) => {
        const a = vals.filter(Number.isFinite);
        if (!a.length) return { n: 0, maeH: null, biasH: null, medianAbsH: null, hit12: 0 };
        const abs = a.map(Math.abs).sort((x, y) => x - y);
        const mid = abs.length >> 1;
        return {
            n: a.length,
            maeH: abs.reduce((s, x) => s + x, 0) / a.length,
            biasH: a.reduce((s, x) => s + x, 0) / a.length,
            medianAbsH: abs.length % 2 ? abs[mid] : 0.5 * (abs[mid - 1] + abs[mid]),
            hit12: abs.filter((x) => x <= 12).length,
        };
    };
    const out = { models: {}, paired: { events: [], models: {} } };
    for (const [m, mp] of Object.entries(errs)) {
        out.models[m] = { ...stats([...mp.values()]), events: [...mp.keys()].sort() };
    }
    const models = Object.keys(errs);
    if (models.length) {
        const common = [...errs[models[0]].keys()]
            .filter((e) => models.every((m) => errs[m].has(e))).sort();
        out.paired.events = common;
        for (const m of models) out.paired.models[m] = stats(common.map((e) => errs[m].get(e)));
    }
    return out;
}

/** Train-onset arrival quantiles [h] from the prior's per-member arrivals. */
export function arrivalQuantilesH(arrivalH, levels = ARRIVAL_Q_LEVELS) {
    const a = Array.from(arrivalH ?? []).filter(Number.isFinite).sort((x, y) => x - y);
    if (a.length < 10) return null;
    return levels.map((p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]);
}

// ── Bz-structure truth (sw_geomag_dataset) ───────────────────────────────────

/**
 * Resolve the storm's Bz-structure truth over [shock, shock + windowH]
 * from minute rows {tMs, bz, v, flag}. Coverage honesty: below
 * `minCoverage` of usable minutes the answer is 'pending', never a fake
 * minimum. Also returns the arrival speed (median v over the first hour
 * after shock) — the §5 inversion's second observable.
 */
export function resolveBzTruth({ rows, shockMs, windowH = 48, minCoverage = 0.6 }) {
    if (!Number.isFinite(shockMs)) return { status: 'pending', reason: 'no-shock' };
    const endMs = shockMs + windowH * 3.6e6;
    let n = 0, usable = 0;
    let minBz = Infinity, minAt = NaN;
    const vFirstHour = [];
    for (const r of rows ?? []) {
        if (!(r.tMs >= shockMs && r.tMs <= endMs)) continue;
        n++;
        if (!Number.isFinite(r.bz)) continue;
        usable++;
        if (r.bz < minBz) { minBz = r.bz; minAt = r.tMs; }
        if (r.tMs <= shockMs + 3.6e6 && Number.isFinite(r.v)) vFirstHour.push(r.v);
    }
    const expected = (windowH * 60);
    const coverage = Math.min(1, usable / expected);
    if (coverage < minCoverage) {
        return { status: 'pending', reason: 'insufficient-coverage', coverage };
    }
    vFirstHour.sort((a, b) => a - b);
    return {
        status: 'resolved',
        minBzNt: minBz,
        minBzAtMs: minAt,
        vAtShockKms: vFirstHour.length
            ? vFirstHour[vFirstHour.length >> 1]
            : NaN,
        coverage,
    };
}

// ── Per-event scoring (arrival + probabilistic + inversion) ──────────────────

/**
 * Score one resolved flare/CME event against its locked flux-rope-v1 row.
 * `forecast`: the locked row (with `inputs`); `truth`: { arrived,
 * shockMs, minBzNt?, vAtShockKms? }; `launchIso`: the EVENT's launch.
 * Every score that cannot be computed honestly is null, with the pieces
 * that exist still reported.
 */
export function scoreFluxRopeEvent({ forecast, truth, launchIso }) {
    const inp = forecast?.inputs ?? {};
    const launchMs = Date.parse(inp.launch ?? launchIso);
    const out = {
        event_id: forecast?.event_id ?? null,
        // Which lock was scored and how far ahead it was issued — the
        // telemetry that makes a leaked or last-minute lock visible.
        issued_at: forecast?.issued_at ?? null,
        leadH: (truth?.arrived && Number.isFinite(truth.shockMs)
                && Number.isFinite(Date.parse(forecast?.issued_at)))
            ? (truth.shockMs - Date.parse(forecast.issued_at)) / 3.6e6 : null,
        flare: inp.flare ?? null,
        arrived: truth?.arrived === true,
        predicted_hit: forecast?.predicted_hit ?? null,
        brierHit: Number.isFinite(inp.p_hit)
            ? brierScore(inp.p_hit, truth?.arrived === true) : null,
        arrivalErrH: null, hit12: null, crpsArrivalH: null,
        brier10: null, brier20: null,
        minBzErrNt: null,
        inversion: null,
        compounding: null,
    };
    if (truth?.arrived && Number.isFinite(truth.shockMs)) {
        const predMs = Date.parse(forecast.predicted_arrival_utc);
        out.arrivalErrH = (predMs - truth.shockMs) / 3.6e6;
        out.hit12 = Math.abs(out.arrivalErrH) <= 12;
        const epochMs = Date.parse(inp.epoch ?? inp.launch ?? launchIso);
        if (inp.arrivalQ?.hours?.length && Number.isFinite(epochMs)) {
            out.crpsArrivalH = crpsFromQuantiles(
                inp.arrivalQ.hours, inp.arrivalQ.levels ?? ARRIVAL_Q_LEVELS,
                (truth.shockMs - epochMs) / 3.6e6);
        }
        if (Number.isFinite(truth.minBzNt)) {
            if (Number.isFinite(inp.p10)) out.brier10 = brierScore(inp.p10, truth.minBzNt < -10);
            if (Number.isFinite(inp.p20)) out.brier20 = brierScore(inp.p20, truth.minBzNt < -20);
            if (Number.isFinite(inp.min_bz_p50)) out.minBzErrNt = inp.min_bz_p50 - truth.minBzNt;
        }
        // §16 counterfactual vs OUTCOME: the same truth scores the frozen
        // interacting and independent predictions — every "gain" is
        // OFF-error minus ON-error, so positive = interaction helped.
        const wk = inp.wake, cpz = inp.compounding;
        if (wk || cpz) {
            const c = { follower: Number.isFinite(wk?.leader) };
            if (wk?.arrival_indep_utc) {
                const offMs = Date.parse(wk.arrival_indep_utc);
                if (Number.isFinite(offMs)) {
                    c.arrivalErrOnH = out.arrivalErrH;
                    c.arrivalErrOffH = (offMs - truth.shockMs) / 3.6e6;
                    c.arrivalGainH = Math.abs(c.arrivalErrOffH) - Math.abs(c.arrivalErrOnH);
                    c.deltaArrivalH = wk.delta_arrival_h ?? null;
                }
            }
            if (cpz) {
                if (cpz.arrival_q_off?.hours?.length && Number.isFinite(epochMs)) {
                    c.crpsArrivalOffH = crpsFromQuantiles(
                        cpz.arrival_q_off.hours,
                        cpz.arrival_q_off.levels ?? ARRIVAL_Q_LEVELS,
                        (truth.shockMs - epochMs) / 3.6e6);
                    if (Number.isFinite(out.crpsArrivalH) && Number.isFinite(c.crpsArrivalOffH)) {
                        c.crpsGainH = c.crpsArrivalOffH - out.crpsArrivalH;
                    }
                }
                if (Number.isFinite(truth.minBzNt)) {
                    if (Number.isFinite(cpz.on?.min_bz_p50)) {
                        c.minBzErrOnNt = cpz.on.min_bz_p50 - truth.minBzNt;
                    }
                    if (Number.isFinite(cpz.off?.min_bz_p50)) {
                        c.minBzErrOffNt = cpz.off.min_bz_p50 - truth.minBzNt;
                        // Observed amplification over the SAME independent
                        // baseline the prediction used — directly comparable
                        // with the locked amp_pred.
                        c.ampObs = amplificationFactor(
                            Math.abs(truth.minBzNt), Math.abs(cpz.off.min_bz_p50));
                        c.ampPred = Number.isFinite(cpz.amp_pred) ? cpz.amp_pred : null;
                    }
                    if (Number.isFinite(c.minBzErrOnNt) && Number.isFinite(c.minBzErrOffNt)) {
                        c.minBzGainNt = Math.abs(c.minBzErrOffNt) - Math.abs(c.minBzErrOnNt);
                    }
                    if (Number.isFinite(cpz.on?.p20)) {
                        c.brier20On = brierScore(cpz.on.p20, truth.minBzNt < -20);
                    }
                    if (Number.isFinite(cpz.off?.p20)) {
                        c.brier20Off = brierScore(cpz.off.p20, truth.minBzNt < -20);
                    }
                }
            }
            out.compounding = c;
        }
        // Trajectory inversion: what drag environment did this CME feel?
        if (Number.isFinite(launchMs) && Number.isFinite(inp.v0_kms)) {
            const transitS = (truth.shockMs - launchMs) / 1000;
            if (transitS > 3600) {
                // Two observables first (transit + arrival speed → Γ AND w).
                // On REAL events it refuses almost always (8/8 on the
                // 2026-09 ledger, tests/flux-rope-ledger-real.mjs): the
                // "arrival speed" is the DOWNSTREAM plasma speed in the
                // first post-shock hour, which Rankine–Hugoniot puts below
                // the shock's own propagation speed — a DBM profile that
                // ends that slow cannot also cover 1 AU that fast. So fall
                // back to transit-only Γ against the MEASURED upstream wind
                // (truth.upstreamVKms, the ambient the CME was decelerating
                // into). Never against the lock's w_eff: for a §16 follower
                // that is the leader's WAKE speed (775–1229 km/s on the
                // ledger), which retrieves nothing physical. No measured
                // upstream ⇒ honest refusal.
                let r = Number.isFinite(truth.vAtShockKms)
                    ? invertGammaW({ v0Kms: inp.v0_kms, transitS, vArrKms: truth.vAtShockKms })
                    : { ok: false, reason: 'no-arrival-speed' };
                let method = 'transit+speed';
                if (!r.ok && Number.isFinite(truth.upstreamVKms)) {
                    const twoObsReason = r.reason;
                    r = invertGamma({ v0Kms: inp.v0_kms, wKms: truth.upstreamVKms, transitS });
                    method = 'transit+upstream-w';
                    if (r.ok) r.wKms = truth.upstreamVKms;
                    else r.reason = `${twoObsReason}; ${r.reason}`;
                }
                out.inversion = r.ok
                    ? { ok: true, method, gammaPerKm: r.gammaPerKm, wKms: r.wKms ?? null,
                        // The drag the LOCK flew with — the retrieval is only
                        // useful as a comparison against it.
                        lockedGammaPerKm: Number.isFinite(inp.gamma_eff_per_km)
                            ? inp.gamma_eff_per_km : null }
                    : { ok: false, reason: r.reason };
            }
        }
    } else if (truth && truth.arrived === false) {
        // False alarm (or correct negative): Brier on the hit call stands.
        out.hit12 = false;
    }
    return out;
}

/** Aggregate a day's scored events into the validation_runs row shape.
 *  The `compounding` sub-aggregate is the §19–§21 fitting evidence — see
 *  the header's COMPOUNDING SCORING note for how to read the biases. */
export function aggregateFluxRopeScores(events) {
    const scored = (events ?? []).filter((e) => e && e.arrived && Number.isFinite(e.arrivalErrH));
    const n = scored.length;
    const mean = (vals) => {
        const v = vals.filter(Number.isFinite);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const cps = scored.map((e) => e.compounding).filter(Boolean);
    const followers = cps.filter((c) => c.follower);
    const gains = cps.map((c) => c.arrivalGainH).filter(Number.isFinite);
    return {
        n_forecasts: (events ?? []).length,
        hits: scored.filter((e) => e.hit12).length,
        maeHours: mean(scored.map((e) => Math.abs(e.arrivalErrH))),
        biasHours: mean(scored.map((e) => e.arrivalErrH)),
        meanLeadH: mean(scored.map((e) => e.leadH)),
        crpsArrivalH: mean(scored.map((e) => e.crpsArrivalH)),
        brierHit: mean((events ?? []).map((e) => e?.brierHit)),
        brier10: mean(scored.map((e) => e.brier10)),
        brier20: mean(scored.map((e) => e.brier20)),
        minBzMaeNt: mean(scored.map((e) => Math.abs(e.minBzErrNt))),
        inversions: scored.map((e) => e.inversion).filter((r) => r?.ok),
        // Median of Γ_retrieved / Γ_locked over the ok-retrievals: > 1 = the
        // real CMEs felt MORE drag than the ensemble flew with (the early-
        // arrival direction). Geometric (log) median — Γ is log-normal.
        dragRatioMedian: (() => {
            const lr = scored.map((e) => e.inversion)
                .filter((r) => r?.ok && r.lockedGammaPerKm > 0 && r.gammaPerKm > 0)
                .map((r) => Math.log(r.gammaPerKm / r.lockedGammaPerKm))
                .sort((a, b) => a - b);
            if (!lr.length) return null;
            const m = lr.length >> 1;
            return Math.exp(lr.length % 2 ? lr[m] : 0.5 * (lr[m - 1] + lr[m]));
        })(),
        compounding: cps.length ? {
            n: cps.length,
            nFollowers: followers.length,
            arrivalMaeOnH: mean(cps.map((c) => Math.abs(c.arrivalErrOnH))),
            arrivalMaeOffH: mean(cps.map((c) => Math.abs(c.arrivalErrOffH))),
            arrivalGainH: mean(gains),
            preferOnFrac: gains.length
                ? gains.filter((g) => g > 0).length / gains.length : null,
            crpsGainH: mean(cps.map((c) => c.crpsGainH)),
            minBzGainNt: mean(cps.map((c) => c.minBzGainNt)),
            brier20On: mean(cps.map((c) => c.brier20On)),
            brier20Off: mean(cps.map((c) => c.brier20Off)),
            ampPred: mean(cps.map((c) => c.ampPred)),
            ampObs: mean(cps.map((c) => c.ampObs)),
            // Signed follower arrival bias, ON vs OFF — the §19/§20 knob
            // error signal (negative ON bias with a smaller OFF bias =
            // the wake brings followers in too early: momentum-overshoot
            // direction; the reverse = wake too weak).
            followerBiasOnH: mean(followers.map((c) => c.arrivalErrOnH)),
            followerBiasOffH: mean(followers.map((c) => c.arrivalErrOffH)),
        } : null,
    };
}
