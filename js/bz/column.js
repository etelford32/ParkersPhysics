/**
 * js/bz/column.js — the altitude ladder: the ONE object pages read (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B4 (§3, §5). No DOM, no fetch, no ambient time.
 * Gate: tests/bz-column.mjs.
 *
 * `buildColumn` turns the engine's analyses into one list of RUNGS, top
 * (L1) to bottom (the ground), each carrying:
 *
 *   kind     MEASURED · ESTIMATED · FORECAST · NOT_BUILT · NOT_AVAILABLE ·
 *            DELEGATED (another part of the site owns it)   (plan §2 — never
 *            omitted, never merged: an estimate must not wear a
 *            measurement's clothes)
 *   values   the numbers, each with its own unit in the key
 *   sigma    1σ where one exists, and `sigma_status` saying how far to trust it
 *   basis    one line on where the number came from
 *   caveats  what this rung does NOT include
 *
 * IT COMPUTES NO PHYSICS. Every number is read from flux-analysis.js /
 * geo-analysis.js / sheath.js. The rungs that are not built are LISTED, as
 * NOT_BUILT with the phase that will build them: a ladder that silently
 * skipped its empty rungs would read as a complete column.
 *
 * `verified:false` coefficients (Siscoe–Hill, Mead) are surfaced at the
 * rung that uses them and summarised in `unverified`, so a page cannot print
 * one without the flag being in the same object.
 */
import { noseJump } from './sheath.js';
import { boundaryModel } from '../geomag/geospace.js';
import { GEO_RADIUS_RE } from './geo-residual.js';

const r1 = (v) => (v == null || v !== v ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || v !== v ? null : Math.round(v * 100) / 100);

export const RUNG_ORDER = Object.freeze(['l1', 'bow_shock', 'sheath', 'magnetopause', 'geosynchronous', 'ring_current', 'leo', 'e_region', 'ground', 'subsurface']);

/** Index of the newest arrival at or before `tMs` in an ascending arrival list; −1 if none. */
function arrivedIndex(arrivalMs, tMs) {
    let lo = 0, hi = arrivalMs.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arrivalMs[m] <= tMs) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
}

/**
 * @param {{ flux: object|null, geo: object|null, ground?: object|null, ring?: object|null, nowMs: number }} input
 *        ground = analyzeGround(...), ring = analyzeRing(...) (js/bz/ground-analysis.js)
 *        flux = analyzeFlux(...) (with `_series`), geo = analyzeGeo(...)
 * @returns {{ time:string, rungs:Array, unverified:string[], summary:object }}
 */
export function buildColumn({ flux, geo, ground = null, ring = null, nowMs }) {
    const rungs = [];
    const unverified = new Set();
    const w = flux?._series ?? null;
    const iNow = w ? arrivedIndex(w.arrivalMs, nowMs) : -1;

    // ── 0. L1 ────────────────────────────────────────────────────────────
    if (flux?.latest) {
        const flags = flux.latest.flags ?? [];
        rungs.push({ id: 'l1', label: 'L1', where: `${flux.reference_spacecraft}, ~${r1(flux.positions_gse_re?.[flux.reference_spacecraft]?.x) ?? 225} R_E upstream`,
            kind: 'MEASURED', time: flux.latest.time,
            values: { bz_nt: flux.latest.bz_nt, by_nt: flux.latest.by_nt, bx_nt: flux.latest.bx_nt },
            sigma: { bz_nt: flux.latest.sigma_nt }, sigma_status: 'provisional — calibrated only by the withheld-spacecraft score',
            basis: `fused from ${flux.latest.spacecraft_used} of ${flux.spacecraft.length} spacecraft (${flux.spacecraft.join(', ')})`,
            flags, caveats: flags.includes('lag_is_flat_delay') ? ['no arrival-time lag was measurable; spacecraft aligned by the flat delay'] : [] });
    } else {
        rungs.push({ id: 'l1', label: 'L1', kind: 'NOT_AVAILABLE', values: null, basis: 'no L1 magnetometer data', caveats: [] });
    }

    // ── 1. bow-shock nose ────────────────────────────────────────────────
    const fNow = flux?.flux?.at_bow_shock_now ?? null, fNew = flux?.flux?.newest_arrival ?? null;
    if (fNow) {
        rungs.push({ id: 'bow_shock', label: 'Bow-shock nose', where: `${fNow.bow_shock_nose_re} R_E (upstream side)`,
            kind: fNow.kind, time: fNow.arrives,
            values: { bz_nt: fNow.bz_nt, by_nt: fNow.by_nt, speed_kms: fNow.speed_kms, density_cc: fNow.density_cc, pdyn_npa: fNow.pdyn_npa },
            sigma: { bz_nt: fNow.sigma_bz_nt }, sigma_status: 'the L1 σ carried unchanged; propagation error is not in it',
            basis: `seen at L1 ${fNow.observed_at_l1}, delay ${fNow.delay_min} min by ${fNow.method}`,
            forecast: fNew && fNew.kind === 'FORECAST' ? { kind: 'FORECAST', time: fNew.arrives, bz_nt: fNew.bz_nt, sigma_bz_nt: fNew.sigma_bz_nt,
                horizon_min: flux.flux.forecast_horizon_min } : null,
            caveats: fNow.method === 'flat' ? ['flat delay: a tilted front arrives minutes earlier or later than this'] : [] });
    } else {
        rungs.push({ id: 'bow_shock', label: 'Bow-shock nose', kind: 'NOT_AVAILABLE', values: null,
            basis: flux ? 'nothing has arrived: no plasma or no spacecraft position' : 'no L1 chain', caveats: [] });
    }

    // ── 2. just inside the shock (sheath.js: exact Rankine–Hugoniot) ─────
    let jump = null;
    if (w && iNow >= 0 && fNow) {
        const bt = Math.hypot(w.bx[iNow], w.by[iNow], w.bz[iNow]);
        jump = noseJump({ bxNt: w.bx[iNow], byNt: w.by[iNow], bzNt: w.bz[iNow] },
            { speedKms: w.speed[iNow], densityCc: w.density[iNow], protonTempK: w.temp[iNow], btNt: bt });
    }
    if (jump) {
        rungs.push({ id: 'sheath', label: 'Magnetosheath, at the shock', where: 'just downstream of the bow-shock nose',
            kind: 'ESTIMATED', time: fNow.arrives,
            values: { bz_nt: r2(jump.bzNt), by_nt: r2(jump.byNt), bx_nt: r2(jump.bxNt), compression_ratio: r2(jump.ratio),
                mach_sonic: r1(jump.mach.sonic), mach_alfven: r1(jump.mach.alfven), mach_fast: r1(jump.mach.fast), beta: r2(jump.mach.beta) },
            sigma: { bz_nt: r2(w.sigmaBz[iNow] * jump.ratio) }, sigma_status: 'the L1 σ scaled by the ratio',
            basis: 'perpendicular-shock Rankine–Hugoniot jump at the nose (exact; no fitted coefficient)',
            caveats: ['a LOWER bound on the field at the magnetopause: pile-up in the sheath is not modelled',
                `electron temperature assumed ${jump.mach.electronTempK} K (the feed publishes protons only)`] });
    } else {
        rungs.push({ id: 'sheath', label: 'Magnetosheath, at the shock', kind: 'NOT_AVAILABLE', values: null,
            basis: 'needs an arrived wind with temperature and field', caveats: [] });
    }

    // ── 2b. the magnetopause: where it is, and the flux opening there ────
    if (fNow) {
        const bm = boundaryModel({ speedKms: fNow.speed_kms, densityCc: fNow.density_cc ?? undefined, bzNt: fNow.bz_nt ?? undefined });
        const tp = fNow.transpolar_potential_kv;
        if (tp) unverified.add('siscoe_hill_coefficients');
        rungs.push({ id: 'magnetopause', label: 'Subsolar magnetopause', where: `${r2(bm.r0Re)} R_E`,
            kind: 'ESTIMATED', time: fNow.arrives,
            values: { standoff_re: r2(bm.r0Re), reconnection_rate_kv: fNow.reconnection_rate_kv.milan2012,
                reconnection_rate_newell_scaled_kv: fNow.reconnection_rate_kv.newell2007_scaled,
                opened_last_hour_gwb: flux.flux.opened_last_hour?.gwb ?? null,
                transpolar_potential_kv: tp ? tp.siscoe_hill : null },
            sigma: { reconnection_rate_kv: fNow.reconnection_rate_kv.sigma }, sigma_status: 'from the Bz σ only',
            basis: 'Shue 1998 standoff; Milan 2012 rate from the UPSTREAM field, Newell 2007 beside it',
            caveats: ['the two rates differ in functional form — their spread is coupling-physics uncertainty',
                ...(tp ? ['transpolar potential uses UNVERIFIED Siscoe–Hill coefficients'] : []),
                ...(bm.fellBack.length ? [`nominal value used for: ${bm.fellBack.join(', ')}`] : [])],
            geosynchronous_inside: bm.r0Re > GEO_RADIUS_RE });
    } else {
        rungs.push({ id: 'magnetopause', label: 'Subsolar magnetopause', kind: 'NOT_AVAILABLE', values: null, basis: 'no arrived wind', caveats: [] });
    }

    // ── 3. geosynchronous: one entry per satellite ───────────────────────
    const sats = Object.entries(geo?.satellites ?? {});
    if (sats.length) {
        unverified.add('mead_coefficients');
        rungs.push({ id: 'geosynchronous', label: 'Geosynchronous orbit', where: `${r2(GEO_RADIUS_RE)} R_E`,
            kind: 'MEASURED', time: sats.map(([, s]) => s.latest?.time).filter(Boolean).sort().pop() ?? null,
            satellites: sats.map(([name, s]) => ({
                name, slot: s.slot, local_time_h: s.latest?.local_time_h ?? null,
                measured: s.latest ? { kind: 'MEASURED', hp_residual_nt: s.latest.residual_nt.hp, he_residual_nt: s.latest.residual_nt.he, hn_residual_nt: s.latest.residual_nt.hn } : null,
                forecast: s.filter?.next ? { kind: 'FORECAST', time: s.filter.next.time, hp_residual_nt: s.filter.next.hp_residual_nt,
                    sigma_nt: s.filter.next.sigma_nt, lead_min: s.filter.lead_min, driver_known: s.filter.next.driver_known } : null,
                skill: s.filter ? { vs_persistence: s.filter.score.skill_vs_persistence, vs_harmonics_only: s.filter.score.skill_vs_harmonics_only,
                    coverage68: s.filter.score.coverage68, n: s.filter.score.n } : null,
                arcjet_minutes_excluded: s.minutes.arcjet_flagged + s.minutes.arcjet_guard,
            })),
            basis: 'GOES magnetometers minus IGRF, in the satellites\' own frame; forecast from a filter that learns the local-time shape and one wind gain',
            caveats: ['residual = everything that is not the core field: magnetopause, ring and tail currents together',
                'the fixed-formula prediction (B3) scored below its control on real data; the forecast here is the learning filter\'s'] });
    } else {
        rungs.push({ id: 'geosynchronous', label: 'Geosynchronous orbit', kind: 'NOT_AVAILABLE', values: null, basis: 'no GOES magnetometer data', caveats: [] });
    }

    // ── 4. ring current: measured Dst beside the site's own Dst model ────
    if (ring?.measured) {
        const m = ring.model;
        rungs.push({ id: 'ring_current', label: 'Ring current', where: '2–6 R_E (seen from the ground as Dst)',
            kind: 'MEASURED', time: ring.measured.time,
            values: { dst_nt: ring.measured.dst_nt },
            model: m ? { kind: m.kind, time: m.latest.time, dst_nt: m.latest.dst_nt, anchored_at: m.anchored_at,
                skill_vs_persistence: m.score.skill_vs_persistence, rmse_nt: m.score.rmse_nt, hours_scored: m.score.hours } : null,
            basis: 'hourly Kyoto quicklook Dst; model = O\'Brien–McPherron (js/ring-current-model.js) driven by the arrived wind, anchored once and free-run',
            caveats: ['Dst is one number for a current that is not symmetric; it is hourly and about an hour old',
                ...(m ? [] : ['no arrived wind: the model was not run'])] });
    } else {
        rungs.push({ id: 'ring_current', label: 'Ring current', where: '2–6 R_E', kind: 'NOT_AVAILABLE', values: null, basis: 'no Dst data', caveats: [] });
    }

    // ── 5. LEO: nothing to measure with and no model chosen ──────────────
    rungs.push({ id: 'leo', label: 'LEO / topside', where: '400–850 km', kind: 'NOT_BUILT', values: null,
        basis: 'no public real-time instrument; a field-aligned-current / Poynting-flux model has not been chosen',
        caveats: ['the candidate empirical models carry licence terms that have not been checked — an owner decision (plan §16)'] });

    // ── 6–7. E-region and the ground, both from the USGS network ─────────
    if (ground) {
        const strongest = ground.stations.filter((s) => s.equivalent_current).sort((a, b) => b.equivalent_current.a_per_km - a.equivalent_current.a_per_km)[0] ?? null;
        rungs.push({ id: 'e_region', label: 'E-region currents', where: '~110 km, over the stations only',
            kind: 'ESTIMATED', time: strongest?.latest ?? null,
            values: { strongest_a_per_km: strongest?.equivalent_current.a_per_km ?? null, at_station: strongest?.iaga ?? null,
                toward_deg: strongest?.equivalent_current.toward_deg ?? null,
                electrojet_westward_nt: ground.electrojet_proxy.westward_nt, electrojet_eastward_nt: ground.electrojet_proxy.eastward_nt,
                auroral_stations: ground.electrojet_proxy.stations.length },
            basis: 'infinite-sheet equivalent current of each station\'s horizontal perturbation; electrojet proxy = extreme ΔX over the auroral-zone stations',
            caveats: [ground.equivalent_current_note, 'the proxy is NOT the AL/AU index', 'baseline is a trailing median (provisional)'] });
        rungs.push({ id: 'ground', label: 'Ground', where: `0 km — ${ground.stations_total} USGS observatories, ${ground.stations_1s} at 1 s`,
            kind: 'MEASURED', time: ground.dbdt?.at_time ?? null,
            values: { dbdt_peak_nt_s: ground.dbdt?.peak_nt_s ?? null, at_station: ground.dbdt?.at_station ?? null,
                minute_product_would_read_nt_s: ground.dbdt?.minute_product_would_read_nt_s ?? null,
                dbdt_underread_median: ground.dbdt?.underread_median ?? null,
                sudden_impulses: ground.sudden_impulses.length, latency_s: ground.latency_s },
            timing_score: ground.timing_score,
            basis: 'USGS variation data at one second; dB/dt differenced only across consecutive seconds',
            caveats: ['one continent\'s network', ...(ground.stations_1s < ground.stations_total ? [`${ground.stations_total - ground.stations_1s} station(s) without 1-second data`] : [])] });
    } else {
        rungs.push({ id: 'e_region', label: 'E-region currents', where: '~110 km', kind: 'NOT_AVAILABLE', values: null, basis: 'no ground magnetometer data', caveats: [] });
        rungs.push({ id: 'ground', label: 'Ground', where: '0 km', kind: 'NOT_AVAILABLE', values: null, basis: 'no ground magnetometer data', caveats: [] });
    }

    // ── 8. below ground: the site already has this, so it is not rebuilt ─
    rungs.push({ id: 'subsurface', label: 'Below ground', where: 'conducting Earth', kind: 'DELEGATED', values: null,
        basis: 'the geoelectric field is the existing nowcast (js/earth-interior/geoelectric-nowcast.js, earth-interior.html) on the same USGS stations',
        href: 'earth-interior.html',
        caveats: ['that kernel is validated at one-minute cadence with a 4-hour warm-up; it has NOT been run on the 1-second series here'] });

    const kinds = {};
    for (const r of rungs) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    return {
        time: new Date(nowMs).toISOString(),
        rungs,
        unverified: [...unverified],
        summary: {
            kinds,
            bz_l1_nt: flux?.latest?.bz_nt ?? null,
            bz_at_shock_nt: fNow?.bz_nt ?? null,
            bz_inside_shock_nt: jump ? r2(jump.bzNt) : null,
            reconnection_rate_kv: fNow?.reconnection_rate_kv?.milan2012 ?? null,
            forecast_horizon_min: flux?.flux?.forecast_horizon_min ?? null,
        },
    };
}
