/**
 * js/bz/geo-analysis.js — rung 3 of the Bz engine, assembled (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B3. Takes the normalised `geo-mag` feed and
 * (optionally) the propagated wind series from js/bz/flux-analysis.js and
 * returns, per GOES satellite: the MEASURED residual field, the checks that
 * the frame and the slot are right, and the first LEDGER — a prediction of the
 * residual's variation from the wind that has arrived, scored against the
 * magnetometer, beside the same prediction made with a NOMINAL wind (the
 * negative control: does knowing the upstream wind help at all?).
 *
 * It owns no physics: fields are geo-residual.js, the standoff is
 * js/geomag/geospace.js, the wind is flux-analysis.js.
 */
import { GOES_SLOTS, GEO_DEFAULTS, MEAD, igrfEpn, meadEpn, residualSeries, scoreVariation, arrivedValue, localTimeH, diurnalPeakUtH } from './geo-residual.js';
import { boundaryModel, NOMINAL_WIND, dynamicPressureNPa } from '../geomag/geospace.js';
import { runFilter, scoreFilter, regressors, COEFF_NAMES, FILTER_DEFAULTS } from './geo-filter.js';

const r1 = (v) => (v == null || v !== v ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || v !== v ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || v !== v ? null : Math.round(v * 1000) / 1000);

/** Correlation of a[i] with b[i + lag] over finite pairs. */
function corrLag(a, b, lag) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = Math.max(0, -lag); i < Math.min(a.length, b.length - lag); i++) {
        const x = a[i], y = b[i + lag];
        if (x === x && y === y) { n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
    }
    if (n < 120) return null;
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : null;
}

/**
 * @param {{ geo:object, wind?:{arrivalMs:number[], speed:number[], density:number[], bz:number[]}|null, nowMs:number, minutes?:number }} input
 *        `wind` is flux-analysis.js `_series` (arrival-ordered, at the bow-shock nose)
 */
export function analyzeGeo({ geo, wind = null, nowMs, minutes = 180 }) {
    const out = { satellites: {}, unknown_satellites: [], mead_verified: MEAD.verified,
        ledger_note: 'scores VARIATION about each series\' own median; the level the model omits (ring + tail currents) is unmodelled_offset_nt' };
    const nominalR0 = boundaryModel(NOMINAL_WIND).r0Re;

    // The standoff the arrived wind implies, once, on the wind's own arrival axis.
    const sqrtPNominal = Math.sqrt(dynamicPressureNPa(NOMINAL_WIND.densityCc, NOMINAL_WIND.speedKms));
    // The filter's driver: √P_dyn of the arrived wind minus the nominal wind's.
    const driverSeries = wind?.arrivalMs?.length ? wind.arrivalMs.map((_, i) => {
        const p = wind.speed[i] > 0 && wind.density[i] > 0 ? dynamicPressureNPa(wind.density[i], wind.speed[i]) : null;
        return p == null ? NaN : Math.sqrt(p) - sqrtPNominal;
    }) : null;
    let r0Series = null;
    if (wind?.arrivalMs?.length) {
        r0Series = wind.arrivalMs.map((_, i) => {
            const v = wind.speed[i], d = wind.density[i];
            if (!(v > 0) || !(d > 0)) return NaN;                         // no density ⇒ no standoff, never a nominal one
            return boundaryModel({ speedKms: v, densityCc: d, bzNt: wind.bz[i] === wind.bz[i] ? wind.bz[i] : undefined }).r0Re;
        });
    }

    for (const [name, sat] of Object.entries(geo?.satellites ?? {})) {
        const slot = GOES_SLOTS[name];
        if (!slot) { out.unknown_satellites.push(name); continue; }
        const res = residualSeries(sat.samples, slot.lonEastDeg);
        if (!res) continue;
        const n = res.t.length;

        // ── predictions on the satellite's own time axis ─────────────────
        const live = new Float64Array(n).fill(NaN), nominal = new Float64Array(n).fill(NaN), persist = new Float64Array(n).fill(NaN);
        const lagMs = GEO_DEFAULTS.responseLagMin * 60e3, holdMs = GEO_DEFAULTS.windHoldMin * 60e3;
        const cur = { i: 0 };
        for (let i = 0; i < n; i++) {
            const date = new Date(res.t[i]);
            nominal[i] = meadEpn(nominalR0, slot.lonEastDeg, date).hp;
            if (r0Series) {
                const r0 = arrivedValue(wind.arrivalMs, r0Series, res.t[i], lagMs, holdMs, cur);
                if (r0 === r0) live[i] = meadEpn(r0, slot.lonEastDeg, date).hp;
            }
        }
        // Persistence: the residual one hour earlier (by time tag).
        for (let i = 0, j = 0; i < n; i++) {
            while (j < n && res.t[j] < res.t[i] - 3600e3) j++;
            if (j < n && Math.abs(res.t[j] - (res.t[i] - 3600e3)) < 90e3) persist[i] = res.hp[j];
        }

        const vsNominal = scoreVariation(res.hp, live, nominal);
        const vsPersist = scoreVariation(res.hp, live, persist);

        // ── the response lag, MEASURED where the data allow ──────────────
        // Driven part only: what the live wind adds over the nominal wind, against what the
        // observation shows beyond the nominal prediction.
        let response = { lag_min: null, r: null, status: 'no_wind' };
        if (r0Series) {
            const drive = new Float64Array(n), seen = new Float64Array(n);
            for (let i = 0; i < n; i++) { drive[i] = live[i] - nominal[i]; seen[i] = res.hp[i] - nominal[i]; }
            let best = null;
            for (let lag = -10; lag <= 30; lag++) {
                const r = corrLag(drive, seen, lag);
                if (r != null && (!best || r > best.r)) best = { lag, r };
            }
            response = best && best.r >= 0.5
                ? { lag_min: best.lag + GEO_DEFAULTS.responseLagMin, r: r3(best.r), status: 'measured' }
                : { lag_min: GEO_DEFAULTS.responseLagMin, r: best ? r3(best.r) : null, status: 'not_measurable_assumed' };
        }

        // ── the learning filter (geo-filter.js) ─────────────────────────
        const lt = new Float64Array(n), drv = new Float64Array(n).fill(NaN);
        const cur2 = { i: 0 };
        for (let i = 0; i < n; i++) {
            lt[i] = localTimeH(slot.lonEastDeg, new Date(res.t[i]));
            if (driverSeries) drv[i] = arrivedValue(wind.arrivalMs, driverSeries, res.t[i], lagMs, holdMs, cur2);
        }
        const series = { t: res.t, y: res.hp, localTimeH: lt, driver: drv };
        const full = runFilter(series), ctrl = runFilter(series, { pinGain: true });
        const fs = scoreFilter(series, full, ctrl);
        let driven = 0; for (let i = 0; i < n; i++) if (drv[i] === drv[i] && res.hp[i] === res.hp[i]) driven++;
        // The next value, leadMin ahead of the newest sample: FORECAST.
        const tNext = res.t[n - 1] + FILTER_DEFAULTS.leadMin * 60e3;
        const dNext = driverSeries ? arrivedValue(wind.arrivalMs, driverSeries, tNext, lagMs, holdMs, { i: 0 }) : NaN;
        const hNext = regressors(localTimeH(slot.lonEastDeg, new Date(tNext)), dNext);
        const filter = {
            model: 'Hp residual = local-time harmonics (2) + gain × (√P_dyn arrived − nominal); coefficients are a Kalman state',
            lead_min: FILTER_DEFAULTS.leadMin, record_minutes: n, driven_minutes: driven,
            coefficients: Object.fromEntries(COEFF_NAMES.map((k, i) => [k, { value: r2(full.x[i]), sigma: r2(full.sigmaX[i]) }])),
            gain_unit: 'nT per √nPa',
            score: { n: fs.n, rmse_nt: r2(fs.rmse), rmse_harmonics_only_nt: r2(fs.rmse_harmonics_only), rmse_persistence_nt: r2(fs.rmse_persistence),
                skill_vs_harmonics_only: r3(fs.skill_vs_harmonics_only), skill_vs_persistence: r3(fs.skill_vs_persistence), coverage68: r3(fs.coverage68) },
            next: { kind: 'FORECAST', time: new Date(tNext).toISOString(),
                hp_residual_nt: r2(hNext.reduce((a, h, i) => a + h * full.x[i], 0)),
                sigma_nt: r2(Math.sqrt(hNext.reduce((a, h, i) => a + (h * full.sigmaX[i]) ** 2, 0) + full.obsVar)),
                sigma_note: 'diagonal approximation of the state covariance + observation variance; see coverage68 for how honest it is',
                driver_known: dNext === dNext },
        };

        // ── checks ──────────────────────────────────────────────────────
        const absMed = (a) => { const v = Array.from(a).filter((x) => x === x).map(Math.abs).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
        const peak = diurnalPeakUtH(res.t, res.hp);
        const noonUt = ((12 - slot.lonEastDeg / 15) % 24 + 24) % 24;
        const peakOff = peak == null ? null : ((peak - noonUt + 36) % 24) - 12;

        let last = -1;
        for (let i = n - 1; i >= 0; i--) if (res.hp[i] === res.hp[i]) { last = i; break; }
        const s = last >= 0 ? sat.samples[last] : null;
        const i0 = Math.max(0, n - minutes);
        out.satellites[name] = {
            slot: slot.slot, lon_east_deg: slot.lonEastDeg, longitude_source: 'nominal operational slot',
            latest: s ? {
                kind: 'MEASURED', time: new Date(s.t).toISOString(), age_s: Math.round((nowMs - s.t) / 1000),
                local_time_h: r1(localTimeH(slot.lonEastDeg, new Date(s.t))),
                measured_nt: { he: r2(s.he), hp: r2(s.hp), hn: r2(s.hn) },
                igrf_nt: { he: r2(res.igrf.he), hp: r2(res.igrf.hp), hn: r2(res.igrf.hn) },
                residual_nt: { he: r2(res.he[last]), hp: r2(res.hp[last]), hn: r2(res.hn[last]) },
                predicted_hp_variation: live[last] === live[last] ? { kind: 'ESTIMATED', magnetopause_currents_nt: r2(live[last]), coefficients_verified: false } : null,
            } : null,
            minutes: { total: n, valid: res.valid, arcjet_flagged: res.arcjet, arcjet_guard: res.guarded, gaps: res.gaps },
            checks: {
                // He and Hn are dominated by the internal field: their residual medians say whether
                // the frame convention and the slot are right (a swapped slot is ~18 nT in He).
                he_residual_median_abs_nt: r2(absMed(res.he)), hn_residual_median_abs_nt: r2(absMed(res.hn)),
                hp_diurnal_peak_ut_h: peak, expected_local_noon_ut_h: r1(noonUt), peak_offset_h: r1(peakOff),
            },
            ledger: {
                quantity: 'Hp residual variation (measured − IGRF, about its median)',
                prediction: 'magnetopause-current field at the Shue standoff of the wind that has arrived',
                vs_nominal_wind: { n: vsNominal.n, rmse_nt: r2(vsNominal.rmse), rmse_baseline_nt: r2(vsNominal.rmse_baseline), skill: r3(vsNominal.skill), r: r3(vsNominal.r) },
                vs_persistence_1h: { n: vsPersist.n, rmse_nt: r2(vsPersist.rmse), rmse_baseline_nt: r2(vsPersist.rmse_baseline), skill: r3(vsPersist.skill) },
                unmodelled_offset_nt: r2(vsNominal.offset),
                response,
                coefficients_verified: MEAD.verified,
            },
            filter,
            trace: { t0: new Date(res.t[i0]).toISOString(), step_s: sat.cadence_s ?? 60,
                hp_residual: Array.from(res.hp.subarray(i0), r2), predicted: Array.from(live.subarray(i0), r2),
                filter_pred: Array.from(full.pred.subarray(i0), r2), filter_sigma: Array.from(full.predSigma.subarray(i0), r2) },
        };
    }
    return out;
}
