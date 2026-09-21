/**
 * temp-outlook.js — the landing page's temperature outlook kernel (PURE).
 *
 * Consumed by js/home-conditions.js (buildTempModel) and drawn by
 * js/home-sky-console.js. No DOM, no fetch, no ambient time — `now` is
 * always a parameter — and node-gated by tests/temp-outlook.mjs.
 *
 * What it owns
 * ────────────
 *   buildWeekCandles(wx, now)      the 7-day "linear chart with candlesticks":
 *                                  the hourly temperature series across the
 *                                  week plus ONE candle per local day —
 *                                  open = the day's first hour (midnight),
 *                                  close = its last (23:00), wick = the day's
 *                                  high/low. A candle whose close sits above
 *                                  its open is a day that WARMED end to end.
 *   climatologyByDoy(pts)          per-day-of-year normals (hi / lo / mean)
 *                                  from the archive, circularly smoothed over
 *                                  ±7 days so 3 years ≈ 45 samples per date.
 *   anomalyPersistence(pts, clim)  the per-location numbers the v0 engine
 *                                  fits FROM HISTORY: the daily-mean anomaly's
 *                                  lag-1 autocorrelation → e-folding time τ,
 *                                  and its standard deviation σ.
 *   projectDays({...})             the v0 30-day engine. NWP where Open-Meteo
 *                                  has it (16-day horizon), then normal +
 *                                  the NWP tail anomaly relaxing as e^(−Δ/τ):
 *                                      T(lead) = clim(doy) + A_tail · ρ,
 *                                      ρ = exp(−(lead − lastNwpLead) / τ),
 *                                  with the expected miss σ·√(1 − ρ²).
 *   buildMonthCalendar({...})      the calendar grid: the 1st of the current
 *                                  month through today + 30, Sunday-first
 *                                  weeks, past days filled from the archive.
 *
 * THIS IS THE SEAM FOR THE 30-DAY ENGINE. `projectDays` returns one row per
 * day with `{ hiF, loF, meanF, source, tier, anomF, sigmaF }`; the calendar
 * and the tooltips read ONLY that shape. TEMP_OUTLOOK_ENGINE_PLAN.md scopes
 * what replaces the v0 formula (per-location fitted models on decades of
 * archive, GEFS 35-day ensemble spread, S2S driver tilts, verification) —
 * it plugs in here by producing the same rows, and nothing downstream
 * changes. Do not grow physics in the renderer.
 *
 * TIME CONVENTION (inherited from home-conditions.js): Open-Meteo answers
 * in the LOCATION's local time with no offset, and `Date.parse` reads that
 * as BROWSER-local. "Local day" throughout this file therefore means the
 * browser's calendar day — exact for the common same-zone case, and a
 * documented approximation when a visitor watches a distant place. Day keys
 * and day-of-year are computed from local NOON so a 23/25-hour DST day
 * cannot shift a date.
 */

const isNum = (v) => Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DAY_MS = 86400e3;

/** Default anomaly e-folding time (days) before history has been fitted. */
export const DEFAULT_TAU_DAYS = 5;
/** Open-Meteo's forecast horizon: leads 0–15 (16 days incl. today). */
export const MAX_NWP_LEAD = 15;
/** Leads at which the deterministic forecast still carries day-to-day skill. */
export const NEAR_LEAD_MAX = 6;

// ── Local-calendar helpers ──────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of the browser-local calendar day containing t. */
export function localDayKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Midnight (local) starting the day that contains t. */
export function localDayStart(t) {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local noon of the day that contains t (DST-safe day anchor). */
export function localNoon(t) {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
}

/** Local noon `n` calendar days after the day containing t. */
export function addDaysNoon(t, n) {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12).getTime();
}

/** 0-based day of year of the local day containing t (0 … 365). */
export function dayOfYearLocal(t) {
    const d = new Date(t);
    const jan1 = new Date(d.getFullYear(), 0, 1, 12).getTime();
    return Math.round((localNoon(t) - jan1) / DAY_MS);
}

// ── Week candles ────────────────────────────────────────────────────────────

/**
 * Hourly line + one candle per local day for `days` days starting today.
 *
 * @param {{hourly?:Array<{t:number,tempF:number}>, daily?:Array<{t:number,hiF:number,loF:number}>}} wx
 * @param {number} now
 * @param {number} [days=7]
 * @returns {{candles:Array, hours:Array, start:number, end:number, tMin:number, tMax:number}}
 */
export function buildWeekCandles(wx, now, days = 7) {
    const start = localDayStart(now);
    const end = localDayStart(addDaysNoon(now, days));
    const hours = (wx?.hourly ?? [])
        .filter((h) => h && isNum(h.t) && isNum(h.tempF) && h.t >= start && h.t < end)
        .sort((a, b) => a.t - b.t);
    const byDay = new Map();
    for (const h of hours) {
        const k = localDayKey(h.t);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(h);
    }
    const dailyByKey = new Map();
    for (const d of wx?.daily ?? []) if (d && isNum(d.t)) dailyByKey.set(localDayKey(d.t), d);

    const candles = [];
    for (let i = 0; i < days; i++) {
        const t = addDaysNoon(now, i);
        const key = localDayKey(t);
        const hs = byDay.get(key) ?? [];
        if (hs.length < 2) continue;
        const d = dailyByKey.get(key);
        const temps = hs.map((h) => h.tempF);
        const hMax = Math.max(...temps), hMin = Math.min(...temps);
        // The wick is the day's true extreme: the daily field where Open-Meteo
        // supplies it (sub-hourly maxima exceed the hourly samples), and never
        // narrower than the drawn line.
        const high = isNum(d?.hiF) ? Math.max(d.hiF, hMax) : hMax;
        const low = isNum(d?.loF) ? Math.min(d.loF, hMin) : hMin;
        const open = hs[0].tempF, close = hs[hs.length - 1].tempF;
        candles.push({
            key, t, lead: i, open, close, high, low,
            deltaF: close - open,
            dir: close >= open ? 'warming' : 'cooling',
            hours: hs.length,
            observedHours: hs.filter((h) => h.t <= now).length,
            partial: hs.length < 20,
        });
    }
    if (!candles.length) return { candles, hours, start, end, tMin: NaN, tMax: NaN };
    const tMin = Math.min(...candles.map((c) => c.low));
    const tMax = Math.max(...candles.map((c) => c.high));
    return { candles, hours, start, end, tMin, tMax };
}

// ── Climatology ─────────────────────────────────────────────────────────────

/**
 * Per-day-of-year normals from archive dailies. Each doy averages every
 * sample within ±halfWindow days (circular over the year), so a 3-year
 * archive gives ~45 samples per date instead of 3.
 *
 * @param {Array<{t:number,tempF?:number,hiF?:number,loF?:number}>} pts
 * @returns {{byDoy:Array<{hi:number|null,lo:number|null,mean:number|null,n:number}>, years:[number,number], nDays:number}|null}
 */
export function climatologyByDoy(pts, { halfWindow = 7 } = {}) {
    if (!Array.isArray(pts) || pts.length < 60) return null;
    const N = 366;
    const sum = { hi: new Float64Array(N), lo: new Float64Array(N), mean: new Float64Array(N) };
    const cnt = { hi: new Uint32Array(N), lo: new Uint32Array(N), mean: new Uint32Array(N) };
    let y0 = Infinity, y1 = -Infinity, nDays = 0;
    for (const p of pts) {
        if (!p || !isNum(p.t)) continue;
        const doy = clamp(dayOfYearLocal(p.t), 0, N - 1);
        const y = new Date(p.t).getFullYear();
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        nDays++;
        if (isNum(p.hiF)) { sum.hi[doy] += p.hiF; cnt.hi[doy]++; }
        if (isNum(p.loF)) { sum.lo[doy] += p.loF; cnt.lo[doy]++; }
        if (isNum(p.tempF)) { sum.mean[doy] += p.tempF; cnt.mean[doy]++; }
    }
    const byDoy = new Array(N);
    for (let d = 0; d < N; d++) {
        const acc = { hi: 0, lo: 0, mean: 0 }, n = { hi: 0, lo: 0, mean: 0 };
        for (let k = -halfWindow; k <= halfWindow; k++) {
            const j = (d + k + N) % N;
            for (const f of ['hi', 'lo', 'mean']) { acc[f] += sum[f][j]; n[f] += cnt[f][j]; }
        }
        byDoy[d] = {
            hi: n.hi ? acc.hi / n.hi : null,
            lo: n.lo ? acc.lo / n.lo : null,
            mean: n.mean ? acc.mean / n.mean : (n.hi && n.lo ? (acc.hi / n.hi + acc.lo / n.lo) / 2 : null),
            n: n.mean || Math.min(n.hi, n.lo),
        };
    }
    return { byDoy, years: [y0, y1], nDays };
}

/** The normal for the local day containing t (null without climatology). */
export function climAt(clim, t) {
    if (!clim?.byDoy) return null;
    return clim.byDoy[clamp(dayOfYearLocal(t), 0, 365)] ?? null;
}

/**
 * How long a temperature anomaly lasts HERE, measured from history: the
 * lag-1 autocorrelation r₁ of the daily-mean anomaly over consecutive days,
 * τ = −1 / ln r₁ (an AR(1) e-folding time), plus the anomaly σ. These are
 * the two per-location parameters the v0 projection needs.
 *
 * @returns {{tau:number, r1:number, sigmaF:number, n:number}|null}
 */
export function anomalyPersistence(pts, clim) {
    if (!clim?.byDoy || !Array.isArray(pts)) return null;
    const a = [];
    for (const p of pts) {
        if (!p || !isNum(p.t)) continue;
        const v = isNum(p.tempF) ? p.tempF : (isNum(p.hiF) && isNum(p.loF) ? (p.hiF + p.loF) / 2 : NaN);
        const c = climAt(clim, p.t);
        if (!isNum(v) || !isNum(c?.mean)) continue;
        a.push({ t: localNoon(p.t), v: v - c.mean });
    }
    if (a.length < 60) return null;
    a.sort((x, y) => x.t - y.t);
    const mean = a.reduce((s, p) => s + p.v, 0) / a.length;
    let vsum = 0;
    for (const p of a) vsum += (p.v - mean) ** 2;
    const variance = vsum / a.length;
    if (!(variance > 0)) return null;
    let csum = 0, nPairs = 0;
    for (let i = 1; i < a.length; i++) {
        if (Math.abs(a[i].t - a[i - 1].t - DAY_MS) > 2 * 3600e3) continue;   // consecutive days only
        csum += (a[i].v - mean) * (a[i - 1].v - mean);
        nPairs++;
    }
    if (nPairs < 30) return null;
    const r1 = clamp(csum / nPairs / variance, -0.999, 0.999);
    const tau = r1 > 0 ? clamp(-1 / Math.log(r1), 1, 15) : 1;
    return { tau, r1, sigmaF: Math.sqrt(variance), n: a.length };
}

// ── The v0 projection (the engine seam) ─────────────────────────────────────

/**
 * One row per day, today (lead 0) through lead `days`.
 *
 *   source 'nwp'   — Open-Meteo's deterministic daily hi/lo (leads ≤ 15).
 *                    tier 'nwp-near' (≤ NEAR_LEAD_MAX) or 'nwp-ext'.
 *   source 'blend' — climatology + the NWP tail anomaly × ρ, ρ = e^(−Δ/τ);
 *                    carries `sigmaF`, the expected miss σ·√(1−ρ²). With no
 *                    NWP at all ρ = 0 and the row is the bare normal.
 *   source 'none'  — nothing to say yet (no NWP for the lead and no
 *                    climatology). The calendar prints '—'.
 *
 * @param {object} o
 * @param {Array<{t:number,hiF:number,loF:number}>} [o.daily]  NWP dailies (may include past days)
 * @param {object|null} [o.clim]           climatologyByDoy()
 * @param {object|null} [o.persistence]    anomalyPersistence()
 * @param {number} o.now
 * @param {number} [o.days=30]
 */
export function projectDays({ daily = [], clim = null, persistence = null, now, days = 30 }) {
    const nwp = new Map();
    for (const d of daily ?? []) {
        if (!d || !isNum(d.t) || !isNum(d.hiF) || !isNum(d.loF)) continue;
        const lead = Math.round((localNoon(d.t) - localNoon(now)) / DAY_MS);
        if (lead >= 0 && lead <= MAX_NWP_LEAD) nwp.set(lead, d);
    }
    let lastLead = -1;
    for (const lead of nwp.keys()) if (lead > lastLead) lastLead = lead;

    // Tail anomaly: the mean over the last (up to) three NWP days, so one
    // noisy day-16 value does not set the whole outlook.
    let aHi = 0, aLo = 0, nA = 0;
    if (clim && lastLead >= 0) {
        for (let lead = Math.max(0, lastLead - 2); lead <= lastLead; lead++) {
            const d = nwp.get(lead);
            const c = d ? climAt(clim, d.t) : null;
            if (!d || !isNum(c?.hi) || !isNum(c?.lo)) continue;
            aHi += d.hiF - c.hi; aLo += d.loF - c.lo; nA++;
        }
        if (nA) { aHi /= nA; aLo /= nA; }
    }
    const tau = isNum(persistence?.tau) ? persistence.tau : DEFAULT_TAU_DAYS;
    const sigma = isNum(persistence?.sigmaF) ? persistence.sigmaF : null;

    const out = [];
    for (let lead = 0; lead <= days; lead++) {
        const t = addDaysNoon(now, lead);
        const key = localDayKey(t);
        const d = nwp.get(lead);
        const c = climAt(clim, t);
        const normalMean = isNum(c?.mean) ? c.mean : (isNum(c?.hi) && isNum(c?.lo) ? (c.hi + c.lo) / 2 : null);
        if (d) {
            const meanF = (d.hiF + d.loF) / 2;
            out.push({
                key, t, lead, hiF: d.hiF, loF: d.loF, meanF,
                source: 'nwp', tier: lead <= NEAR_LEAD_MAX ? 'nwp-near' : 'nwp-ext',
                anomF: normalMean != null ? meanF - normalMean : null,
                sigmaF: null, rho: 1,
            });
        } else if (isNum(c?.hi) && isNum(c?.lo)) {
            const rho = lastLead >= 0 && nA ? Math.exp(-(lead - lastLead) / tau) : 0;
            const hiF = c.hi + aHi * rho, loF = c.lo + aLo * rho;
            const meanF = (hiF + loF) / 2;
            out.push({
                key, t, lead, hiF, loF, meanF,
                source: 'blend', tier: 'blend',
                anomF: normalMean != null ? meanF - normalMean : null,
                sigmaF: sigma != null ? sigma * Math.sqrt(Math.max(0, 1 - rho * rho)) : null,
                rho,
            });
        } else {
            out.push({ key, t, lead, hiF: null, loF: null, meanF: null, source: 'none', tier: 'none', anomF: null, sigmaF: null, rho: 0 });
        }
    }
    return {
        days: out,
        nwpLeads: lastLead + 1,
        tau, sigmaF: sigma,
        tailAnomalyF: nA ? (aHi + aLo) / 2 : null,
        method: 'v0',
    };
}

// ── Month calendar ──────────────────────────────────────────────────────────

/**
 * Calendar cells from the 1st of the current month through the last
 * projected day, padded to whole Sunday-first weeks.
 *
 * @param {object} o
 * @param {{days:Array}} o.projection      projectDays()
 * @param {Array<{t:number,hiF?:number,loF?:number}>} [o.archive]  archive dailies (past)
 * @param {Array<{t:number,hiF?:number,loF?:number}>} [o.daily]    NWP dailies incl. past_days
 * @param {object|null} [o.clim]  climatologyByDoy() — gives past days their anomaly
 * @param {number} o.now
 */
export function buildMonthCalendar({ projection, archive = [], daily = [], clim = null, now }) {
    const rows = projection?.days ?? [];
    const byLead = new Map(rows.map((r) => [r.lead, r]));
    const todayKey = localDayKey(now);
    const nowD = new Date(now);
    const first = new Date(nowD.getFullYear(), nowD.getMonth(), 1, 12).getTime();
    const last = rows.length ? rows[rows.length - 1].t : addDaysNoon(now, 30);

    // Past days: the archive (reanalysis, lags ~2 days) wins; the forecast
    // API's past_days (model analysis) covers the gap up to yesterday.
    const past = new Map();
    for (const d of daily ?? []) if (d && isNum(d.t) && isNum(d.hiF) && isNum(d.loF) && d.t < localDayStart(now)) {
        past.set(localDayKey(d.t), { hiF: d.hiF, loF: d.loF, source: 'analysis' });
    }
    for (const p of archive ?? []) if (p && isNum(p.t) && isNum(p.hiF) && isNum(p.loF) && p.t < localDayStart(now)) {
        past.set(localDayKey(p.t), { hiF: p.hiF, loF: p.loF, source: 'archive' });
    }

    const firstDow = new Date(first).getDay();
    const gridStart = addDaysNoon(first, -firstDow);
    const lastDow = new Date(last).getDay();
    const gridEnd = addDaysNoon(last, 6 - lastDow);
    const nCells = Math.round((gridEnd - gridStart) / DAY_MS) + 1;

    const cells = [];
    for (let i = 0; i < nCells; i++) {
        const t = addDaysNoon(gridStart, i);
        const key = localDayKey(t);
        const d = new Date(t);
        const lead = Math.round((t - localNoon(now)) / DAY_MS);
        const base = { key, t, day: d.getDate(), month: d.getMonth(), year: d.getFullYear(), monthStart: d.getDate() === 1, lead, isToday: key === todayKey };
        if (t < first || t > last) { cells.push({ ...base, pad: true }); continue; }
        if (lead < 0) {
            const o = past.get(key);
            if (!o) { cells.push({ ...base, past: true, hiF: null, loF: null, source: 'none', tier: 'none', anomF: null }); continue; }
            const c = climAt(clim, t);
            const normal = isNum(c?.mean) ? c.mean : (isNum(c?.hi) && isNum(c?.lo) ? (c.hi + c.lo) / 2 : null);
            cells.push({ ...base, past: true, hiF: o.hiF, loF: o.loF, source: o.source, tier: 'past', anomF: normal != null ? (o.hiF + o.loF) / 2 - normal : null });
            continue;
        }
        const r = byLead.get(lead);
        cells.push(r ? { ...base, hiF: r.hiF, loF: r.loF, meanF: r.meanF, source: r.source, tier: r.tier, anomF: r.anomF, sigmaF: r.sigmaF, rho: r.rho }
            : { ...base, hiF: null, loF: null, source: 'none', tier: 'none' });
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    const months = [...new Set(cells.filter((c) => !c.pad).map((c) => `${c.year}-${pad2(c.month + 1)}`))];
    return { weeks, first, last, months, todayKey };
}
