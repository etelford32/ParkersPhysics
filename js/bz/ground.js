/**
 * js/bz/ground.js — the ground rung of the Bz engine (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B5 (§4.1, §4.7). No DOM, no fetch, no ambient time.
 * Gate: tests/bz-ground.mjs.
 *
 * WHAT ONE-SECOND GROUND DATA BUYS, MEASURED RATHER THAN ASSERTED
 *
 *   dB/dt.  The quantity that drives geomagnetically induced currents is the
 *   RATE of change of the horizontal field. `dbdt` reports its peak from the
 *   1-second series and, beside it, the peak the SAME series gives after
 *   being averaged to one minute — `underread` is their ratio, i.e. how much
 *   of the real rate a minute product hides. It is a measurement on today's
 *   data, not a quoted factor.
 *
 *   Pulsations.  A 1-minute series resolves nothing faster than Pc5; at 1 s
 *   the SAME spectrum.js functions resolve Pc4 and Pc3.
 *
 *   Timing.  `detectSuddenImpulses` finds a simultaneous step in H at the
 *   low- and mid-latitude stations to the second — the arrival of a
 *   solar-wind pressure jump at the ground, and the only truth available for
 *   the engine's propagation delay (plan §6, row 1).
 *
 * WHAT IT DOES NOT CLAIM
 *
 *   • `equivalentCurrent` is the textbook INFINITE-SHEET equivalent: the
 *     horizontal perturbation rotated 90°, scaled by 2/μ₀ and by a stated
 *     external fraction. It is a per-station vector, not a current system: 14
 *     stations on one continent cannot support a map, and nothing here draws
 *     one. The direction's sign is checked against a Biot–Savart integration
 *     in the gate, not remembered.
 *   • `electrojetProxy` is the extreme of ΔX over the auroral-zone stations
 *     this network happens to have. It is NOT the AE/AL index (12 stations
 *     around the oval; this is a handful in one longitude sector) and is
 *     labelled a regional proxy everywhere.
 *   • Baselines are a trailing MEDIAN — provisional, exactly as TIGA's is
 *     (TIGA_PLAN.md). dB/dt and spectra do not depend on it; ΔX and the
 *     equivalent current do.
 *   • Station coordinates come from the payload; dipole latitude is COMPUTED
 *     (js/geomag/dipole.js), never annotated.
 */
import { toDipole, dipoleBasisForYear, decimalYear } from '../geomag/dipole.js';
import { bandPowers } from './spectrum.js';

export const GROUND_DEFAULTS = Object.freeze({
    auroralMinDipoleLat: 60,     // |dipole latitude| at or above this is "auroral zone" for the proxy
    lowMidMaxDipoleLat: 50,      // sudden impulses are read at or below this (TIGA's ring-current cut)
    externalFraction: 2 / 3,     // share of a ground perturbation due to the external (ionospheric) current — a stated convention
    siMinStepNt: 4,              // a sudden impulse: this much step in H…
    siWindowS: 180,              // …within this long…
    siMinStations: 3,            // …at this many stations at once
    spectrumNfft: 2048,          // 34 min at 1 s: resolves Pc5 down to 0.5 mHz
    // A perturbation larger than this is not geophysics at these latitudes, it is a baseline step or a
    // bad record (measured 2026-11-20: FRN read −2766 nT against its 24 h median on a quiet day, and
    // owned the network's peak dB/dt). Such a station is reported, flagged, and kept OUT of every
    // network-level number.
    suspectDeltaNt: 1500,
});

const MU0 = 4e-7 * Math.PI;

function median(a) {
    const s = Float64Array.from(a).sort(), m = s.length >> 1;
    return s.length ? (s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])) : NaN;
}
const finite = (a) => Array.from(a).filter((v) => v === v);

/** Centred-dipole latitude of a station at an instant (degrees). */
export function dipoleLatitude(lat, lon, date) {
    return toDipole(lat, lon, dipoleBasisForYear(decimalYear(date))).latDeg;
}

/**
 * Peak horizontal dB/dt from a 1-second series, and what a 1-minute average
 * of the same series would have reported.
 * Differences are taken ONLY between consecutive samples exactly one cadence
 * apart — never across a gap.
 * @returns {{ peak_nt_s, peak_time, peak_1min_nt_s, underread, n } | null}
 */
export function dbdt(s) {
    const n = s.t.length;
    let peak = -1, at = NaN, m = 0;
    const dt0 = (s.cadence_s ?? 1) * 1000;
    for (let i = 1; i < n; i++) {
        if (Math.abs(s.t[i] - s.t[i - 1] - dt0) > 1) continue;
        const dx = s.x[i] - s.x[i - 1], dy = s.y[i] - s.y[i - 1];
        if (!(dx === dx && dy === dy)) continue;
        m++;
        const r = Math.hypot(dx, dy) / (dt0 / 1000);
        if (r > peak) { peak = r; at = s.t[i]; }
    }
    if (m < 60) return null;
    // The same series as a minute product: means over whole UTC minutes with ≥ 80 % of their samples.
    const need = Math.round(0.8 * 60000 / dt0);
    const mins = new Map();
    for (let i = 0; i < n; i++) {
        if (!(s.x[i] === s.x[i] && s.y[i] === s.y[i])) continue;
        const k = Math.floor(s.t[i] / 60000);
        const e = mins.get(k) ?? [0, 0, 0];
        e[0] += s.x[i]; e[1] += s.y[i]; e[2]++; mins.set(k, e);
    }
    const keys = [...mins.keys()].sort((a, b) => a - b);
    let peak60 = -1;
    for (let j = 1; j < keys.length; j++) {
        if (keys[j] - keys[j - 1] !== 1) continue;
        const a = mins.get(keys[j - 1]), b = mins.get(keys[j]);
        if (a[2] < need || b[2] < need) continue;
        const r = Math.hypot(b[0] / b[2] - a[0] / a[2], b[1] / b[2] - a[1] / a[2]) / 60;
        if (r > peak60) peak60 = r;
    }
    return { peak_nt_s: peak, peak_time: at, peak_1min_nt_s: peak60 >= 0 ? peak60 : null,
        underread: peak60 > 0 ? peak / peak60 : null, n: m };
}

/**
 * The overhead sheet current equivalent to a horizontal ground perturbation
 * (ΔX north, ΔY east, nT). An EASTWARD current overhead makes a NORTHWARD
 * perturbation below it, so J_east ∝ +ΔX and J_north ∝ −ΔY.
 * @returns {{ jNorthAkm, jEastAkm, magnitudeAkm, directionDeg }} A/km; direction is degrees east of north
 */
export function equivalentCurrent(dxNt, dyNt, externalFraction = GROUND_DEFAULTS.externalFraction) {
    if (!(dxNt === dxNt && dyNt === dyNt)) return null;
    const k = (2 / MU0) * externalFraction * 1e-9 * 1e3;      // nT → A/km
    const je = k * dxNt, jn = -k * dyNt;
    return { jNorthAkm: jn, jEastAkm: je, magnitudeAkm: Math.hypot(jn, je),
        directionDeg: (Math.atan2(je, jn) * 180 / Math.PI + 360) % 360 };
}

/**
 * Regional electrojet proxy from stations at or above the auroral cut:
 * the most negative and most positive ΔX among them. NOT the AL/AU index.
 * @param {Array<{iaga, dipLat, dx}>} stations dx = X minus its baseline, nT
 */
export function electrojetProxy(stations, opts = {}) {
    const o = { ...GROUND_DEFAULTS, ...opts };
    const au = stations.filter((s) => Math.abs(s.dipLat) >= o.auroralMinDipoleLat && s.dx === s.dx);
    if (!au.length) return { stations: [], westward_nt: null, eastward_nt: null };
    let lo = au[0], hi = au[0];
    for (const s of au) { if (s.dx < lo.dx) lo = s; if (s.dx > hi.dx) hi = s; }
    return { stations: au.map((s) => s.iaga), westward_nt: lo.dx, westward_at: lo.iaga, eastward_nt: hi.dx, eastward_at: hi.iaga };
}

/**
 * Sudden impulses: instants where at least `siMinStations` low/mid-latitude
 * stations each show a step of ≥ siMinStepNt in X between the 60 s before
 * and the 60 s after, all within siWindowS of one another.
 * @param {Array<{iaga, dipLat, t, x}>} stations 1-second series on their own time tags
 * @returns {Array<{ time:number, step_nt:number, stations:string[], spread_s:number }>}
 */
export function detectSuddenImpulses(stations, opts = {}) {
    const o = { ...GROUND_DEFAULTS, ...opts };
    const hits = [];
    for (const s of stations) {
        if (!(Math.abs(s.dipLat) <= o.lowMidMaxDipoleLat)) continue;
        const n = s.t.length;
        if (n < 240) continue;
        // prefix sums of X over valid samples
        const cs = new Float64Array(n + 1), cn = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) { const v = s.x[i]; cs[i + 1] = cs[i] + (v === v ? v : 0); cn[i + 1] = cn[i] + (v === v ? 1 : 0); }
        const mean = (a, b) => (cn[b] - cn[a] >= 40 ? (cs[b] - cs[a]) / (cn[b] - cn[a]) : NaN);
        let best = null;
        for (let i = 90; i + 90 < n; i++) {
            if (s.t[i + 90] - s.t[i - 90] > 200e3) continue;                 // a gap inside the window
            const step = mean(i + 30, i + 90) - mean(i - 90, i - 30);        // skip the ±30 s of the rise itself
            if (!(step === step) || Math.abs(step) < o.siMinStepNt) { if (best) { hits.push(best); best = null; } continue; }
            if (!best || Math.abs(step) > Math.abs(best.step)) best = { iaga: s.iaga, time: s.t[i], step };
        }
        if (best) hits.push(best);
    }
    hits.sort((a, b) => a.time - b.time);
    const out = [];
    for (let i = 0; i < hits.length;) {
        let j = i;
        while (j + 1 < hits.length && hits[j + 1].time - hits[i].time <= o.siWindowS * 1000 && Math.sign(hits[j + 1].step) === Math.sign(hits[i].step)) j++;
        const group = hits.slice(i, j + 1);
        const names = [...new Set(group.map((h) => h.iaga))];
        if (names.length >= o.siMinStations) {
            out.push({ time: median(group.map((h) => h.time)), step_nt: median(group.map((h) => h.step)),
                stations: names, spread_s: (group[group.length - 1].time - group[0].time) / 1000 });
        }
        i = j + 1;
    }
    return out;
}

/**
 * Steps in the arrived solar-wind dynamic pressure: instants where √P_dyn
 * changes by ≥ minStep (√nPa) between the 5 minutes before and after.
 * @param {number[]} arrivalMs ascending   @param {number[]} sqrtP
 */
export function detectPressureJumps(arrivalMs, sqrtP, { minStep = 0.3, halfWindowMs = 5 * 60e3 } = {}) {
    const n = arrivalMs.length;
    const steps = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        const t = arrivalMs[i];
        const b = [], a = [];
        for (let k = i - 1; k >= 0 && t - arrivalMs[k] <= halfWindowMs; k--) if (sqrtP[k] === sqrtP[k]) b.push(sqrtP[k]);
        for (let k = i; k < n && arrivalMs[k] - t <= halfWindowMs; k++) if (sqrtP[k] === sqrtP[k]) a.push(sqrtP[k]);
        // MEANS, not medians: a difference of medians is a flat plateau ~half a window wide
        // around the jump (it flips as soon as either window has a majority), and cannot time it.
        // A difference of means is a triangle whose apex IS the jump.
        const avg = (q) => q.reduce((x, y) => x + y, 0) / q.length;
        if (b.length >= 3 && a.length >= 3) steps[i] = avg(a) - avg(b);
    }
    // The statistic crosses the threshold minutes BEFORE the jump; the jump itself is where
    // |step| PEAKS. Taking the first crossing timed every jump ~3 min early, and a median
    // version 2 min early — both caught by the gate.
    const out = [];
    for (let i = 0; i < n; i++) {
        const v = Math.abs(steps[i]);
        if (!(v >= minStep)) continue;
        let isPeak = true;
        for (let k = i - 1; k >= 0 && arrivalMs[i] - arrivalMs[k] <= 2 * halfWindowMs; k--) if (Math.abs(steps[k]) >= v) { isPeak = false; break; }
        for (let k = i + 1; isPeak && k < n && arrivalMs[k] - arrivalMs[i] <= 2 * halfWindowMs; k++) if (Math.abs(steps[k]) > v) { isPeak = false; break; }
        if (isPeak) out.push({ time: arrivalMs[i], step_sqrt_npa: steps[i] });
    }
    return out;
}

/** Pair each ground impulse with the nearest predicted pressure-jump arrival within maxMs. */
export function matchImpulses(impulses, jumps, maxMs = 20 * 60e3) {
    return impulses.map((si) => {
        let best = null;
        for (const j of jumps) {
            const d = si.time - j.time;
            if (Math.abs(d) <= maxMs && Math.sign(j.step_sqrt_npa) === Math.sign(si.step_nt) && (!best || Math.abs(d) < Math.abs(best.error_s * 1000))) best = { predicted: j.time, error_s: d / 1000 };
        }
        return { ...si, match: best };
    });
}

/**
 * One station's ground-rung summary.
 * @param {object} fast  1-second series (normalizeGroundSeries) or null
 * @param {object} slow  1-minute series over ~24 h, for the baseline; or null
 */
export function stationSummary(fast, slow, nowMs, opts = {}) {
    const o = { ...GROUND_DEFAULTS, ...opts };
    const any = fast ?? slow;
    if (!any) return null;
    const date = new Date(nowMs);
    const dipLat = dipoleLatitude(any.lat, any.lon, date);
    const baseX = slow ? median(finite(slow.x)) : NaN, baseY = slow ? median(finite(slow.y)) : NaN;
    let dx = NaN, dy = NaN, tLatest = NaN;
    const src = fast ?? slow;
    for (let i = src.t.length - 1; i >= 0; i--) if (src.x[i] === src.x[i] && src.y[i] === src.y[i]) { dx = src.x[i] - baseX; dy = src.y[i] - baseY; tLatest = src.t[i]; break; }
    const rate = fast ? dbdt(fast) : null;
    const spec = fast && fast.t.length >= o.spectrumNfft ? bandPowers(fast.x, fast.cadence_s ?? 1, { nfft: o.spectrumNfft }) : null;
    const suspect = Math.abs(dx) > o.suspectDeltaNt || Math.abs(dy) > o.suspectDeltaNt;
    return {
        iaga: any.iaga, lat: any.lat, lon: any.lon, dipLat, suspect,
        zone: Math.abs(dipLat) >= o.auroralMinDipoleLat ? 'auroral' : (Math.abs(dipLat) <= o.lowMidMaxDipoleLat ? 'low-mid' : 'sub-auroral'),
        latest: tLatest, latency_s: fast?.latency_s ?? slow?.latency_s ?? null,
        dx, dy, baseline: slow ? { kind: 'trailing median, provisional', minutes: slow.valid } : null,
        current: equivalentCurrent(dx, dy, o.externalFraction),
        dbdt: rate, spectrum: spec, has_1s: !!fast,
    };
}
