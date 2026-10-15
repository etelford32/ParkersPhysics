/**
 * driver-schedule.js — the solar/geomagnetic drivers a decay integration
 * runs through, as a function of TIME (DECAY_BRIEF_PLAN.md §3, gap A).
 * ═══════════════════════════════════════════════════════════════════════════
 * js/operations/msis-drag.js holds today's F10.7 / Ap fixed for the whole
 * lifetime. For a 400 km CubeSat that lives 3–12 months on the declining
 * side of a solar cycle, that constant is the dominant error. This module
 * builds the schedule the integrator walks instead:
 *
 *   sources, in PRIORITY order (first that covers a slot wins), e.g.
 *     1. observed indices (GFZ definitive / SWPC observed)
 *     2. SWPC 45-day F10.7 + Ap forecast        (api/_lib/ap45.js)
 *     3. NOAA predicted solar cycle, monthly     (expandMonthlyToDaily)
 *   + an optional STORM splice that overrides Ap (and optionally F10.7)
 *     inside its own window — the "what one storm costs" scenario.
 *
 * Slots nobody covers are HELD from the nearest earlier value (or the
 * first later one) and counted under source 'held' — never silently
 * invented, always reported in `provenance`.
 *
 * THE NRLMSISE-00 CONVENTIONS ARE THE POINT OF THIS FILE (each is what
 * MSIS expects, not a style choice):
 *   • F10.7 is the PREVIOUS UT day's daily value.
 *   • F10.7A is the 81-day average CENTRED on the slot's day (it needs
 *     40 days of FUTURE flux, which is why the schedule reaches past
 *     endMs; near the ends of the available data it averages what exists
 *     and `f107aClipped` counts those days).
 *   • ap is the 7-element history array (switch 9 = −1):
 *       [daily Ap, ap(now), ap(−3h), ap(−6h), ap(−9h),
 *        mean ap(−12…−33h), mean ap(−36…−57h)]
 *     A storm's density response LAGS its ap; filling all seven with the
 *     current ap (as the console's scalar provider does) drops that lag.
 *
 * Output: consecutive 3-hour slots merged into SEGMENTS of identical
 * quantised state, so the profile cache sees one key per distinct state.
 * PURE: no fetch, no DOM, no WASM, no ambient time.
 * Gate: node tests/decay-driver-schedule.mjs
 */

export const SLOT_MS = 3 * 3600e3;
export const DAY_MS  = 86400e3;
const SLOTS_PER_DAY  = 8;
const F107A_HALF_DAYS = 40;          // 81-day centred window
const AP_LOOKBACK_SLOTS = 19;        // ap history reaches back 57 h

/**
 * Linearly interpolate a monthly outlook (e.g. NOAA's predicted solar
 * cycle) to daily points. `points`: [{ tMs, value }] sorted by tMs, each
 * the value AT tMs (month centre). Returns [{ tMs, value }] at UT
 * midnights from the first to the last point; nothing is extrapolated.
 */
export function expandMonthlyToDaily(points) {
    const pts = (points ?? []).filter(p => Number.isFinite(p?.tMs) && Number.isFinite(p?.value))
        .sort((a, b) => a.tMs - b.tMs);
    if (pts.length < 2) return pts.map(p => ({ tMs: Math.floor(p.tMs / DAY_MS) * DAY_MS, value: p.value }));
    const out = [];
    let j = 0;
    const d0 = Math.ceil(pts[0].tMs / DAY_MS);
    const d1 = Math.floor(pts[pts.length - 1].tMs / DAY_MS);
    for (let d = d0; d <= d1; d++) {
        const t = d * DAY_MS;
        while (j < pts.length - 2 && pts[j + 1].tMs <= t) j++;
        const a = pts[j], b = pts[j + 1];
        const f = (t - a.tMs) / (b.tMs - a.tMs);
        out.push({ tMs: t, value: a.value + (b.value - a.value) * Math.min(1, Math.max(0, f)) });
    }
    return out;
}

// Fill `grid` (array of {value, src}) from a point series whose points each
// cover [tMs, tMs + spanMs). Only empty slots are written — callers apply
// sources highest-priority first.
function paint(grid, slot0, slotMs, points, spanMs, name) {
    if (!Array.isArray(points)) return;
    const n = grid.length;
    for (const p of points) {
        const v = Number(p?.value);
        if (!Number.isFinite(p?.tMs) || !Number.isFinite(v)) continue;
        const i0 = Math.max(0, Math.floor(p.tMs / slotMs) - slot0);
        const i1 = Math.min(n - 1, Math.floor((p.tMs + spanMs - 1) / slotMs) - slot0);
        for (let i = i0; i <= i1; i++) if (grid[i] === null) grid[i] = { value: v, src: name };
    }
}

function overwrite(grid, slot0, slotMs, startMs, values, name) {
    if (!Array.isArray(values)) return;
    const first = Math.floor(startMs / slotMs) - slot0;
    values.forEach((v, k) => {
        const i = first + k;
        if (i >= 0 && i < grid.length && Number.isFinite(v)) grid[i] = { value: v, src: name };
    });
}

// Forward-fill gaps, then back-fill a leading gap. Returns false when the
// grid has no data at all.
function hold(grid) {
    let last = null;
    for (let i = 0; i < grid.length; i++) {
        if (grid[i]) last = grid[i];
        else if (last) grid[i] = { value: last.value, src: 'held' };
    }
    const first = grid.find(Boolean);
    if (!first) return false;
    for (let i = 0; i < grid.length && !grid[i]; i++) grid[i] = { value: first.value, src: 'held' };
    return true;
}

const quant = (v, step) => step > 0 ? Math.round(v / step) * step : v;

/**
 * Build the driver schedule over [startMs, endMs).
 *
 * @param {object}   o
 * @param {number}   o.startMs, o.endMs
 * @param {Array}    o.sources   priority-ordered: { name, f107?: [{tMs,value}],
 *                               f107SpanMs? (default 1 day), ap?: [{tMs,value}],
 *                               apSpanMs? (default 3 h) }
 * @param {object}   [o.storm]   { name?, startMs, ap: number[] (3-hourly),
 *                               f107?: number[] (daily, from startMs's day) }
 * @param {number}   [o.f107Step=1]  quantisation, sfu (also F10.7A)
 * @param {number}   [o.apStep=1]    quantisation of every ap entry
 * @returns {{ startMs, endMs, segments, provenance } | null}  null when no
 *          source supplies any F10.7 or any ap.
 */
export function buildDriverSchedule({
    startMs, endMs, sources = [], storm = null, f107Step = 1, apStep = 1,
}) {
    if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) return null;

    // F10.7: daily grid from (first day − 41) for the previous-day lag and
    // the centred window, to (last day + 40).
    const dayFirst = Math.floor(startMs / DAY_MS);
    const dayLast  = Math.floor((endMs - 1) / DAY_MS);
    const fDay0 = dayFirst - F107A_HALF_DAYS - 1;
    const fDays = (dayLast + F107A_HALF_DAYS) - fDay0 + 1;
    const fGrid = new Array(fDays).fill(null);

    // ap: 3-hourly grid from the start of the first day minus the 57 h
    // lookback, to the end of the last day (daily Ap needs whole days).
    const sFirst = dayFirst * SLOTS_PER_DAY;
    const aSlot0 = sFirst - AP_LOOKBACK_SLOTS - SLOTS_PER_DAY;
    const aSlots = (dayLast + 1) * SLOTS_PER_DAY - aSlot0;
    const aGrid = new Array(aSlots).fill(null);

    if (storm && Number.isFinite(storm.startMs)) {
        const nm = storm.name ?? 'storm-scenario';
        overwrite(aGrid, aSlot0, SLOT_MS, storm.startMs, storm.ap, nm);
        overwrite(fGrid, fDay0, DAY_MS, storm.startMs, storm.f107, nm);
    }
    for (const src of sources) {
        const nm = src?.name ?? 'source';
        paint(fGrid, fDay0, DAY_MS, src?.f107, src?.f107SpanMs ?? DAY_MS, nm);
        paint(aGrid, aSlot0, SLOT_MS, src?.ap, src?.apSpanMs ?? SLOT_MS, nm);
    }
    if (!hold(fGrid) || !hold(aGrid)) return null;

    // F10.7A per day: centred 81-day mean over the days that hold real
    // (non-held) data; fall back to everything when none do.
    const realF = fGrid.map(c => c.src !== 'held');
    const f107aOfDay = (d) => {
        const i = d - fDay0;
        let sum = 0, n = 0;
        for (let k = i - F107A_HALF_DAYS; k <= i + F107A_HALF_DAYS; k++) {
            if (k < 0 || k >= fDays || !realF[k]) continue;
            sum += fGrid[k].value; n++;
        }
        if (n === 0) return { v: fGrid[i].value, clipped: true };
        return { v: sum / n, clipped: n < 2 * F107A_HALF_DAYS + 1 };
    };
    const apAt = (slot) => aGrid[slot - aSlot0].value;
    const mean = (s0, s1) => { let s = 0; for (let k = s0; k <= s1; k++) s += apAt(k); return s / (s1 - s0 + 1); };

    const segments = [];
    const provenance = { f107: {}, ap: {}, f107aClipped: 0 };
    const tally = (bucket, name) => { bucket[name] = (bucket[name] ?? 0) + 3; };   // hours
    let lastClippedDay = null;

    const s0 = Math.floor(startMs / SLOT_MS);
    const s1 = Math.floor((endMs - 1) / SLOT_MS);
    for (let s = s0; s <= s1; s++) {
        const day = Math.floor(s / SLOTS_PER_DAY);
        const fPrev = fGrid[day - 1 - fDay0];
        const fa = f107aOfDay(day);
        if (fa.clipped && lastClippedDay !== day) { provenance.f107aClipped++; lastClippedDay = day; }
        const dayStartSlot = day * SLOTS_PER_DAY;
        const apArray = [
            mean(dayStartSlot, dayStartSlot + SLOTS_PER_DAY - 1),
            apAt(s), apAt(s - 1), apAt(s - 2), apAt(s - 3),
            mean(s - 11, s - 4),
            mean(s - 19, s - 12),
        ].map(v => quant(v, apStep));
        const state = {
            f107:  quant(fPrev.value, f107Step),
            f107a: quant(fa.v, f107Step),
            ap:    apArray[1],
            apArray,
        };
        const key = `${state.f107}|${state.f107a}|${apArray.join(',')}`;
        const src = { f107: fPrev.src, ap: aGrid[s - aSlot0].src };
        tally(provenance.f107, src.f107);
        tally(provenance.ap, src.ap);

        const t0 = Math.max(startMs, s * SLOT_MS);
        const t1 = Math.min(endMs, (s + 1) * SLOT_MS);
        const prev = segments[segments.length - 1];
        if (prev && prev.key === key && prev.src.f107 === src.f107 && prev.src.ap === src.ap) {
            prev.t1Ms = t1;
        } else {
            segments.push({ t0Ms: t0, t1Ms: t1, key, ...state, src });
        }
    }
    return { startMs, endMs, segments, provenance };
}

/**
 * Index of the segment containing tMs (half-open [t0, t1)). Before the
 * schedule → 0; at or after its end → the last segment (held).
 */
export function segmentIndexAt(schedule, tMs) {
    const segs = schedule.segments;
    let lo = 0, hi = segs.length - 1;
    if (tMs <= segs[0].t0Ms) return 0;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].t0Ms <= tMs) lo = mid; else hi = mid - 1;
    }
    return lo;
}
