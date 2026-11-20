/**
 * js/bz/page-model.js — what bz.html says, as data (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B6. The page (js/bz-page.js) only draws what this
 * module returns, so every sentence and every plotted point is node-gated
 * (tests/bz-page.mjs). It computes NO physics: it formats the column
 * (js/bz/column.js) and the three analyses' traces.
 *
 * THREE RULES IT ENFORCES
 *   1. A kind is never dropped: every row and every plotted series carries
 *      MEASURED / ESTIMATED / FORECAST (or says why there is no value), with a
 *      glyph AND a word — never colour alone.
 *   2. A missing number is "—", never 0 (`num`).
 *   3. The scorecard prints a score BESIDE ITS CONTROL and calls it `behind`
 *      when it is behind. The engine's first real day put most of its
 *      predictions behind their controls, and the page says so in the same
 *      type size as the ones that are ahead.
 */

export const KINDS = Object.freeze({
    MEASURED:      { glyph: '●', label: 'Measured',      note: 'an instrument at this altitude reported it' },
    ESTIMATED:     { glyph: '◐', label: 'Estimated',     note: 'no instrument here — carried by physics from one that is' },
    FORECAST:      { glyph: '○', label: 'Forecast',      note: 'has not happened yet' },
    NOT_AVAILABLE: { glyph: '–', label: 'No data',       note: 'the feed this rung needs is down' },
    NOT_BUILT:     { glyph: '·', label: 'Not built',     note: 'the engine does not cover this yet' },
    DELEGATED:     { glyph: '↗', label: 'Elsewhere',     note: 'another page of this site owns it' },
});

/** Plain names for the column's `unverified` flags. */
export const UNVERIFIED_NAMES = Object.freeze({
    siscoe_hill_coefficients: 'the polar-cap potential (Siscoe–Hill saturation)',
    mead_coefficients: 'the magnetopause-current term at geosynchronous orbit (Mead 1964)',
});

/** Categorical slots (validated all-pairs on the page surface #0a0f1c). Identity only — never magnitude. */
export const SERIES_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70']);
export const INK = Object.freeze({ primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#232a3a', axis: '#3a4358' });

const MINUS = '−';
/** A number for display: sign with a true minus, fixed digits; null/NaN → "—". */
export function num(v, digits = 1, { sign = false } = {}) {
    if (v == null || v !== v || !Number.isFinite(v)) return '—';
    const a = Math.abs(v).toFixed(digits);
    if (Number(a) === 0) return a;
    return (v < 0 ? MINUS : (sign ? '+' : '')) + a;
}
const pm = (v, digits = 1) => (v == null || v !== v ? '' : ` ± ${Number(v).toFixed(digits)}`);

/** "in 54 min" / "3 min ago" from a time and now. */
export function relTime(iso, nowMs) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const m = Math.round((t - nowMs) / 60000);
    if (Math.abs(m) < 1) return 'now';
    const a = Math.abs(m);
    const txt = a >= 90 ? `${(a / 60).toFixed(1)} h` : `${a} min`;
    return m > 0 ? `in ${txt}` : `${txt} ago`;
}

/** The headline + secondary line for one rung of the column. */
function describe(r, nowMs) {
    const v = r.values ?? {};
    switch (r.id) {
        case 'l1': return { headline: `Bz ${num(v.bz_nt, 2, { sign: true })} nT${pm(r.sigma?.bz_nt, 2)}`, sub: `By ${num(v.by_nt, 2, { sign: true })} · Bx ${num(v.bx_nt, 2, { sign: true })} nT` };
        case 'bow_shock': return { headline: `Bz ${num(v.bz_nt, 2, { sign: true })} nT${pm(r.sigma?.bz_nt, 2)}`,
            sub: `${num(v.speed_kms, 0)} km/s · ${num(v.density_cc, 1)} cm⁻³ · ${num(v.pdyn_npa, 2)} nPa`,
            forecast: r.forecast ? `Bz ${num(r.forecast.bz_nt, 2, { sign: true })} nT arriving ${relTime(r.forecast.time, nowMs)}` : null };
        case 'sheath': return { headline: `Bz ${num(v.bz_nt, 2, { sign: true })} nT${pm(r.sigma?.bz_nt, 2)}`, sub: `field compressed ×${num(v.compression_ratio, 1)} · fast Mach ${num(v.mach_fast, 1)}` };
        case 'magnetopause': return { headline: `${num(v.reconnection_rate_kv, 1)} kV of flux opening${pm(r.sigma?.reconnection_rate_kv, 1)}`,
            sub: `standoff ${num(v.standoff_re, 1)} R_E · ${num(v.opened_last_hour_gwb, 3)} GWb opened in the last hour` };
        case 'geosynchronous': {
            const s = r.satellites ?? [];
            return { headline: s.map((q) => `${q.slot ?? q.name} ${num(q.measured?.hp_residual_nt, 1, { sign: true })} nT`).join(' · ') || '—',
                sub: 'north component, measured minus the core field',
                forecast: s.filter((q) => q.forecast).map((q) => `${q.slot ?? q.name} ${num(q.forecast.hp_residual_nt, 1, { sign: true })}${pm(q.forecast.sigma_nt, 1)} nT ${relTime(q.forecast.time, nowMs)}`).join(' · ') || null };
        }
        case 'ring_current': return { headline: `Dst ${num(v.dst_nt, 0, { sign: true })} nT`, sub: 'hourly index',
            forecast: r.model ? `model ${num(r.model.dst_nt, 1, { sign: true })} nT ${relTime(r.model.time, nowMs)}` : null };
        case 'e_region': return { headline: v.strongest_a_per_km == null ? '—' : `${num(v.strongest_a_per_km, 0)} A/km over ${v.at_station}`,
            sub: `electrojet proxy ${num(v.electrojet_westward_nt, 0, { sign: true })} / ${num(v.electrojet_eastward_nt, 0, { sign: true })} nT from ${v.auroral_stations ?? 0} auroral stations` };
        case 'ground': return { headline: v.dbdt_peak_nt_s == null ? '—' : `dB/dt ${num(v.dbdt_peak_nt_s, 3)} nT/s at ${v.at_station}`,
            sub: v.minute_product_would_read_nt_s == null ? '' : `a one-minute product would read ${num(v.minute_product_would_read_nt_s, 3)} nT/s · ${v.sudden_impulses ?? 0} sudden impulse(s) in the hour` };
        default: return { headline: '—', sub: '' };
    }
}

/**
 * The ladder, top (L1) to bottom, ready to draw.
 * @returns {Array<{id,label,where,kind,kindLabel,glyph,headline,sub,forecast,time,basis,caveats}>}
 */
export function ladderRows(column, nowMs) {
    return (column?.rungs ?? []).map((r) => {
        const k = KINDS[r.kind] ?? KINDS.NOT_AVAILABLE;
        const has = r.kind === 'MEASURED' || r.kind === 'ESTIMATED' || r.kind === 'FORECAST';
        const d = has ? describe(r, nowMs) : { headline: '—', sub: '' };
        return { id: r.id, label: r.label, where: r.where ?? '', kind: r.kind, kindLabel: k.label, glyph: k.glyph,
            headline: d.headline, sub: d.sub ?? '', forecast: d.forecast ?? null,
            time: has && r.time ? relTime(r.time, nowMs) : '', basis: r.basis ?? '', caveats: r.caveats ?? [], href: r.href ?? null };
    });
}

const verdictOf = (skill) => (skill == null || skill !== skill ? 'unscored' : (skill > 0.05 ? 'ahead' : (skill < -0.05 ? 'behind' : 'level')));
export const VERDICTS = Object.freeze({
    ahead:    { glyph: '▲', label: 'ahead of its control' },
    level:    { glyph: '■', label: 'level with its control' },
    behind:   { glyph: '▼', label: 'behind its control' },
    unscored: { glyph: '–', label: 'not scored yet' },
});

/**
 * Every prediction the engine makes that has a truth to be scored against,
 * each beside the control it must beat.
 */
export function scorecard({ l1 = null, geo = null, ground = null, ring = null, rope = null } = {}) {
    const rows = [];
    for (const [sc, s] of Object.entries(l1?.withheld_score ?? {})) {
        rows.push({ id: `l1-${sc}`, claim: `Predict ${sc}'s Bz from the other spacecraft`,
            ours: s.rmse_nt, control: s.rmse_unshifted_nt, controlName: 'their plain average, no time alignment', unit: 'nT rms', n: s.n,
            skill: s.skill_vs_unshifted, coverage: s.coverage68, verdict: verdictOf(s.skill_vs_unshifted) });
    }
    for (const [name, s] of Object.entries(geo?.satellites ?? {})) {
        const f = s.filter?.score;
        if (f) rows.push({ id: `geo-${name}`, claim: `Field at ${s.slot ?? name}, 30 minutes ahead`,
            ours: f.rmse_nt, control: f.rmse_persistence_nt, controlName: 'it will be what it was 30 minutes ago', unit: 'nT rms', n: f.n,
            skill: f.skill_vs_persistence, coverage: f.coverage68, verdict: verdictOf(f.skill_vs_persistence) });
    }
    const rm = ring?.model?.score ?? null;
    if (ring) rows.push({ id: 'ring', claim: 'Dst over the following hours, from the arrived wind',
        ours: rm?.rmse_nt ?? null, control: rm?.rmse_persistence_nt ?? null, controlName: 'Dst stays where it was', unit: 'nT rms', n: rm?.hours ?? 0, note: 'one window, one anchor — this number moves from run to run; the archive table below is the real test',
        skill: rm?.skill_vs_persistence ?? null, coverage: null, verdict: verdictOf(rm?.skill_vs_persistence) });
    const t = ground?.timing_score ?? null;
    if (t) rows.push({ id: 'timing', claim: 'Arrival time of a solar-wind pressure jump at the ground',
        ours: t.median_error_s ?? null, control: null, controlName: 'the flat distance ÷ speed delay', unit: 's median error', n: t.matched?.length ?? 0,
        skill: null, coverage: null, verdict: 'unscored',
        note: t.status === 'scored' ? null : ({ no_events_in_window: 'no pressure jump has arrived in the last hour — nothing to time',
            events_unmatched: 'a jump or an impulse was seen without its partner', no_wind: 'no arrived wind to predict from' }[t.status] ?? t.status) });
    if (rope && rope.status !== 'pending') {
        const scored = rope.status === 'scored';
        rows.push({ id: 'rope', claim: 'Bz at L1 through an incoming CME, forecast from the eruption alone',
            ours: scored ? rope.rmse_nt : null, control: scored ? rope.rmse_zero_nt : null, controlName: 'no CME: Bz stays at zero', unit: 'nT rms', n: rope.n ?? 0,
            skill: scored ? rope.skill_vs_zero : null, coverage: null, verdict: scored ? verdictOf(rope.skill_vs_zero) : 'unscored',
            note: scored ? `${Math.round(rope.coverage50 * 100)} % of outcomes inside its 50 % band, ${Math.round(rope.coverage90 * 100)} % inside its 90 % band · ${rope.n} forecast steps`
                : ({ no_rope: 'no Earth-directed CME is in flight — nothing to score', rope_down: 'the CME forecast is unavailable',
                    too_few_points: 'the CME has not been at L1 long enough to score', no_truth: 'no L1 record to score against' }[rope.status] ?? rope.status) });
    }
    const tally = { ahead: 0, level: 0, behind: 0, unscored: 0 };
    for (const r of rows) tally[r.verdict]++;
    return { rows, tally };
}

/** The shared time window of every chart on the page. */
export function chartDomain(nowMs, hoursBack = 3, hoursAhead = 1.25) {
    return { t0: nowMs - hoursBack * 3600e3, t1: nowMs + hoursAhead * 3600e3, now: nowMs };
}

/** A regular trace ({t0, step_s} + values, nulls = gaps) → points inside the domain. */
export function traceSeries(trace, values, dom) {
    if (!trace || !Array.isArray(values)) return [];
    const t0 = Date.parse(trace.t0), step = (trace.step_s ?? 60) * 1000, out = [];
    for (let i = 0; i < values.length; i++) {
        const t = t0 + i * step;
        if (t < dom.t0 || t > dom.t1) continue;
        out.push({ t, v: values[i] == null || values[i] !== values[i] ? null : values[i] });
    }
    return out;
}

/** The flux trace (rows by arrival time) → an ESTIMATED run and a FORECAST run that share their joining point. */
export function fluxSeries(trace, dom, col = 'milan_kv') {
    const ci = trace?.columns?.indexOf(col) ?? -1, ti = trace?.columns?.indexOf('arrives') ?? -1, ki = trace?.columns?.indexOf('kind') ?? -1;
    const est = [], fc = [];
    if (ci < 0 || ti < 0) return { estimated: est, forecast: fc };
    for (const r of trace.rows ?? []) {
        const t = Date.parse(r[ti]);
        if (!(t >= dom.t0 && t <= dom.t1)) continue;
        const p = { t, v: r[ci] == null ? null : r[ci] };
        if (ki >= 0 && r[ki] === 'F') { if (!fc.length && est.length) fc.push(est[est.length - 1]); fc.push(p); } else est.push(p);
    }
    return { estimated: est, forecast: fc };
}

/** A padded [lo, hi] for a set of series, always including 0 when `zero`. */
export function yExtent(seriesList, { zero = true, pad = 0.12, minSpan = 1 } = {}) {
    let lo = Infinity, hi = -Infinity;
    for (const s of seriesList) for (const p of s) if (p.v != null) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = minSpan; }
    if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < minSpan) { const m = 0.5 * (lo + hi); lo = m - minSpan / 2; hi = m + minSpan / 2; }
    const d = (hi - lo) * pad;
    return [lo - d, hi + d];
}

/** Round tick values covering [lo, hi] (about `n` of them). */
export function ticks(lo, hi, n = 4) {
    const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
    return out;
}

/** SVG path for a series, broken at gaps (a null never draws a line through). */
export function linePath(points, x, y) {
    let d = '', pen = false;
    for (const p of points) {
        if (p.v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        pen = true;
    }
    return d;
}

/** The value of a series nearest to time t (within maxMs), for the hover readout. */
export function nearest(points, t, maxMs = 3 * 60e3) {
    let best = null, bd = Infinity;
    for (const p of points) { const d = Math.abs(p.t - t); if (p.v != null && d < bd) { bd = d; best = p; } }
    return bd <= maxMs ? best : null;
}

/**
 * The archive hindcast (data/bz/hindcast-dst.json, written by scripts/bz-hindcast.mjs) → table rows.
 * Three columns per lead, each a different claim: given the wind as later measured (all windows, and
 * disturbed ones), and as a real forecast (wind frozen at what L1 had seen). No number is computed here.
 */
export function hindcastTable(h) {
    const m = h?.drivers?.['measured/stamp'], f = h?.drivers?.['frozen/stamp'], c = h?.drivers?.['measured/centre'];
    if (!m || !f) return { rows: [], windows: 0, days: 0 };
    const cell = (s) => ({ skill: s?.skill ?? null, lo: s?.skill_ci95?.[0] ?? null, hi: s?.skill_ci95?.[1] ?? null, n: s?.n ?? 0, verdict: s?.verdict ?? 'unscored', rmse: s?.rmse_nt ?? null, control: s?.rmse_persistence_nt ?? null, bias: s?.bias_nt ?? null });
    const rows = Object.keys(m.all).map(Number).sort((a, b) => a - b).map((L) => ({ lead_h: L, given: cell(m.all[L]), storm: cell(m.disturbed[L]), forecast: cell(f.all[L]), given_centre: cell(c?.all?.[L]) }));
    return { rows, windows: m.windows, disturbed: m.disturbed_windows, days: h.archive?.days ?? 0, from: h.archive?.from ?? null, to: h.archive?.to ?? null,
        disturbedBelow: h.settings?.disturbed_dst_nt ?? null, deepest: h.dst?.min_nt ?? null, notHindcast: h.not_hindcast ?? [] };
}

