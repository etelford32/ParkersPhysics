/**
 * js/bz/ground-analysis.js — the lower rungs of the Bz engine, assembled (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B5. Two joins, neither with physics of its own:
 *
 *   analyzeGround  the USGS network at 1 second (ground.js): per-station
 *                  dB/dt with its minute-product under-read, pulsation bands,
 *                  the per-station equivalent current, the regional electrojet
 *                  proxy, and sudden impulses matched against the pressure
 *                  jumps the engine PREDICTED would arrive (the timing score
 *                  of plan §6 — it scores only when the Sun supplies a jump).
 *
 *   analyzeRing    the ring-current rung: measured hourly Dst beside the
 *                  site's ONE Dst model (js/ring-current-model.js
 *                  `integrateDst`, O'Brien–McPherron) driven by the engine's
 *                  ARRIVED wind, anchored once and free-run, scored against
 *                  the hours that follow with persistence as the control.
 */
import { stationSummary, electrojetProxy, detectSuddenImpulses, detectPressureJumps, matchImpulses, dipoleLatitude, GROUND_DEFAULTS } from './ground.js';
import { integrateDst } from '../ring-current-model.js';
import { dynamicPressureNPa } from '../geomag/geospace.js';

const r1 = (v) => (v == null || v !== v ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || v !== v ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || v !== v ? null : Math.round(v * 1000) / 1000);
const iso = (ms) => (ms === ms && ms != null ? new Date(ms).toISOString() : null);

/**
 * @param {{ fast: Record<string,object|null>, slow: Record<string,object|null>, wind?: object|null, nowMs: number }} input
 *        fast / slow = normalizeGroundSeries results keyed by IAGA code (1 s / 60 s)
 */
export function analyzeGround({ fast = {}, slow = {}, wind = null, nowMs }) {
    const ids = [...new Set([...Object.keys(fast), ...Object.keys(slow)])].sort();
    const stations = [];
    for (const id of ids) {
        const s = stationSummary(fast[id] ?? null, slow[id] ?? null, nowMs);
        if (s) stations.push(s);
    }
    if (!stations.length) return null;

    const proxy = electrojetProxy(stations);
    const fastList = stations.filter((s) => s.has_1s).map((s) => ({ iaga: s.iaga, dipLat: s.dipLat, t: fast[s.iaga].t, x: fast[s.iaga].x }));
    const impulses = detectSuddenImpulses(fastList);

    // The timing score: predicted pressure-jump arrivals vs sudden impulses at the ground.
    let timing = { status: 'no_wind', predicted_jumps: 0, impulses: impulses.length, matched: [] };
    if (wind?.arrivalMs?.length) {
        const sp = wind.arrivalMs.map((_, i) => {
            const p = wind.speed[i] > 0 && wind.density[i] > 0 ? dynamicPressureNPa(wind.density[i], wind.speed[i]) : null;
            return p == null ? NaN : Math.sqrt(p);
        });
        const t0 = fastList.length ? Math.min(...fastList.map((s) => s.t[0])) : Infinity;
        const t1 = fastList.length ? Math.max(...fastList.map((s) => s.t[s.t.length - 1])) : -Infinity;
        const jumps = detectPressureJumps(wind.arrivalMs, sp).filter((j) => j.time >= t0 - 20 * 60e3 && j.time <= t1 + 20 * 60e3);
        const matched = matchImpulses(impulses, jumps);
        const errs = matched.filter((m) => m.match).map((m) => m.match.error_s);
        timing = {
            status: errs.length ? 'scored' : (jumps.length || impulses.length ? 'events_unmatched' : 'no_events_in_window'),
            predicted_jumps: jumps.length, impulses: impulses.length,
            matched: matched.filter((m) => m.match).map((m) => ({ ground: iso(m.time), predicted_at_bow_shock: iso(m.match.predicted), error_s: Math.round(m.match.error_s), step_nt: r1(m.step_nt), stations: m.stations })),
            median_error_s: errs.length ? Math.round(errs.slice().sort((a, b) => a - b)[errs.length >> 1]) : null,
            note: 'error = ground impulse minus predicted arrival at the bow-shock nose; it INCLUDES the sheath + magnetosphere transit the engine does not model',
        };
    }

    const withRate = stations.filter((s) => s.dbdt);
    const worst = withRate.slice().sort((a, b) => b.dbdt.peak_nt_s - a.dbdt.peak_nt_s)[0] ?? null;
    const ratios = withRate.map((s) => s.dbdt.underread).filter((v) => v != null).sort((a, b) => a - b);
    const band = (s, id) => s.spectrum?.bands.find((b) => b.id === id);

    return {
        network: 'USGS Geomagnetism Program', stations_total: stations.length,
        stations_1s: stations.filter((s) => s.has_1s).length,
        latency_s: r1(Math.max(...stations.map((s) => s.latency_s ?? 0))),
        dbdt: worst ? {
            kind: 'MEASURED', peak_nt_s: r3(worst.dbdt.peak_nt_s), at_station: worst.iaga, at_time: iso(worst.dbdt.peak_time),
            minute_product_would_read_nt_s: r3(worst.dbdt.peak_1min_nt_s),
            underread_median: ratios.length ? r1(ratios[ratios.length >> 1]) : null,
            underread_max: ratios.length ? r1(ratios[ratios.length - 1]) : null,
            window: 'the 1-second record fetched (about an hour)',
        } : null,
        electrojet_proxy: {
            kind: 'MEASURED', label: 'regional proxy from this network\'s auroral-zone stations — NOT the AL/AU index',
            stations: proxy.stations, westward_nt: r1(proxy.westward_nt), westward_at: proxy.westward_at ?? null,
            eastward_nt: r1(proxy.eastward_nt), eastward_at: proxy.eastward_at ?? null,
            auroral_cut_dipole_lat: GROUND_DEFAULTS.auroralMinDipoleLat, baseline: 'trailing median, provisional',
        },
        sudden_impulses: impulses.map((s) => ({ time: iso(s.time), step_nt: r1(s.step_nt), stations: s.stations, spread_s: Math.round(s.spread_s) })),
        timing_score: timing,
        stations: stations.map((s) => ({
            iaga: s.iaga, lat: r2(s.lat), lon: r2(s.lon), dipole_lat: r1(s.dipLat), zone: s.zone,
            latest: iso(s.latest), latency_s: s.latency_s, has_1s: s.has_1s,
            delta_nt: { north: r1(s.dx), east: r1(s.dy), baseline: s.baseline?.kind ?? null },
            equivalent_current: s.current ? { kind: 'ESTIMATED', a_per_km: r1(s.current.magnitudeAkm), toward_deg: r1(s.current.directionDeg) } : null,
            dbdt_peak_nt_s: r3(s.dbdt?.peak_nt_s), dbdt_underread: r1(s.dbdt?.underread),
            pulsation_rms_nt: s.spectrum ? { pc5: r3(band(s, 'pc5')?.rms), pc4: r3(band(s, 'pc4')?.rms), pc3: r3(band(s, 'pc3')?.rms), segments: s.spectrum.segments } : null,
        })),
        equivalent_current_note: `infinite-sheet equivalent, external fraction ${GROUND_DEFAULTS.externalFraction.toFixed(2)}; per station only — no map is drawn from ${stations.length} stations`,
    };
}

/**
 * The ring-current rung.
 * @param {{ dst: Array<{t,dst}>, wind?: object|null, nowMs: number }} input
 *        wind = flux-analysis `_series` (arrival-ordered)
 */
export function analyzeRing({ dst = [], wind = null, nowMs }) {
    if (!dst.length) return null;
    const last = dst[dst.length - 1];
    const out = {
        measured: { kind: 'MEASURED', time: iso(last.t), dst_nt: last.dst, age_s: Math.round((nowMs - last.t) / 1000), cadence: 'hourly (Kyoto quicklook)' },
        model: null,
    };
    if (!wind?.arrivalMs?.length) return out;
    // Anchor at the first Dst hour inside the arrived-wind record, then free-run.
    const w0 = wind.arrivalMs[0], w1 = wind.arrivalMs[wind.arrivalMs.length - 1];
    const anchor = dst.find((d) => d.t >= w0);
    if (!anchor) return out;
    const samples = [];
    for (let i = 0; i < wind.arrivalMs.length; i++) {
        if (wind.arrivalMs[i] < anchor.t) continue;
        samples.push({ t: wind.arrivalMs[i], v: wind.speed[i], n: wind.density[i], bz: wind.bz[i] });
    }
    if (samples.length < 30) return out;
    const run = integrateDst(samples, anchor.dst, { model: 'obm' });
    if (!run.length) return out;
    // Score at every later Dst hour the run reaches.
    let n = 0, se = 0, sp = 0, k = 0;
    for (const d of dst) {
        if (d.t <= anchor.t || d.t > w1) continue;
        while (k + 1 < run.length && run[k + 1].t <= d.t) k++;
        if (Math.abs(run[k].t - d.t) > 15 * 60e3) continue;
        n++; se += (run[k].dst - d.dst) ** 2; sp += (anchor.dst - d.dst) ** 2;
    }
    const end = run[run.length - 1];
    out.model = {
        kind: end.t > nowMs ? 'FORECAST' : 'ESTIMATED',
        name: 'O\'Brien–McPherron via js/ring-current-model.js integrateDst, driven by the engine\'s arrived wind',
        anchored_at: iso(anchor.t), anchor_dst_nt: anchor.dst,
        latest: { time: iso(end.t), dst_nt: r1(end.dst), dst_star_nt: r1(end.dstStar) },
        score: n >= 3 ? { hours: n, rmse_nt: r2(Math.sqrt(se / n)), rmse_persistence_nt: r2(Math.sqrt(sp / n)), skill_vs_persistence: sp > 0 ? r3(1 - se / sp) : null }
            : { hours: n, rmse_nt: null, rmse_persistence_nt: null, skill_vs_persistence: null },
        note: 'anchored ONCE at the window start and free-run; persistence = the anchor value held',
    };
    return out;
}
