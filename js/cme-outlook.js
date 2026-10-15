/**
 * js/cme-outlook.js — the CME OUTLOOK: P(an Earth-impacting CME arrives on
 * day D) from eruptions that have NOT HAPPENED YET. Phase A of
 * CME_OUTLOOK_PLAN.md — read §2 there before changing what this claims.
 *
 * PURE. No DOM, no fetch, no ambient time (`nowMs` is an argument).
 * Node gate: tests/cme-outlook.mjs (also pins the baked response table
 * against the committed flux-rope WASM).
 *
 * ── What this is ───────────────────────────────────────────────────────
 *
 * A probability per UTC day, built from four links, every one disclosed:
 *
 *   1. FLARE RATE — SWPC's own per-region 24 h M/X probabilities, as
 *      published (read through flare-climatology's ONE scale decision),
 *      turned into Poisson rates and HELD CONSTANT over the horizon
 *      (persistence; real regions emerge, peak and decay). The M band is
 *      rate(p_M) − rate(p_X): SWPC's M figure is treated as "M or greater",
 *      the conservative reading.
 *   2. CME ASSOCIATION — P(CME | flare band), Yashiro et al. (2006),
 *      approximate: `CME_ASSOCIATION`.
 *   3. CME SPEED — log-normal about a class median, representative of the
 *      LASCO catalogue relation (`CME_SPEED`), integrated with 5-point
 *      Gauss–Hermite. NOT a fit; Phase B fits it from the DONKI FLR↔CME
 *      pairs the validation cron already associates.
 *   4. RESPONSE — where the region will be at launch (synodic differential
 *      rotation, `hero-sun-model.regionAt` — the site's one copy), the CME
 *      launched radially from there, and the flux-rope kernel's ensemble
 *      response for that launch read from the BAKED table
 *      (js/cme-outlook-response.js, built through `donkiToPreset`, i.e. the
 *      exact seeding a real DONKI CME gets). No propagation physics here.
 *
 * Launches superpose as a Poisson process: the expected number of
 * Earth-arriving CMEs on day D is μ_D and P(≥1) = 1 − exp(−μ_D).
 *
 * ── What this is NOT ───────────────────────────────────────────────────
 *
 *   · Not an arrival forecast. The calendar's chips are the issue-locked
 *     ledger of CMEs that have launched; this never writes there, never
 *     draws a chip, and has its own model id and table.
 *   · Not complete. Only regions on the disc NOW are seen; new regions and
 *     far-side regions rotating on are missing, so later days are LOWER
 *     BOUNDS (`coverage.note`). Phase B adds the far side.
 *   · Not the source-region Bz prior. The table uses the cone-fit defaults
 *     (flux-rope-v1). If the shadow model flux-rope-v1-src wins its ledger
 *     comparison, the table is re-baked with it.
 *
 * It REFUSES rather than reporting 0 %: no regions → `no-regions`; regions
 * but no usable probabilities → `no-probabilities`.
 */

import { latestRegions, regionAt } from './hero-sun-model.js';
import { rateFromDailyProbability } from './farside/flare-climatology.js';
import { donkiToPreset } from './flux-rope-live.js';

export const OUTLOOK_MODEL_ID = 'cme-outlook-v0';

const HOUR = 3600e3;
const DAY = 86400e3;
const RSUN_KM = 695_700;

/** P(CME | flare in band) — Yashiro et al. 2006, approximate. */
export const CME_ASSOCIATION = Object.freeze({ M: 0.49, X: 0.90 });

/** CME launch speed (km/s at 21.5 R☉) per flare band: log-normal. */
export const CME_SPEED = Object.freeze({
    M: { medianKms: 650, sigLn: 0.45 },
    X: { medianKms: 1200, sigLn: 0.45 },
});

/** Geoeffective threshold the table's `g` column is computed at. */
export const GEO_BZ_NT = -10;

/** Default horizon: today (from now) + 6 more UTC days. */
export const OUTLOOK_DAYS = 7;

/** Launch-time integration step. */
export const LAUNCH_STEP_H = 3;

/**
 * Response grid — the table's axes. Changing ANY of this means re-running
 * scripts/build-cme-outlook-table.mjs (the node gate catches a stale table
 * by length and by recomputed cells).
 */
export const RESPONSE_GRID = Object.freeze({
    lonDeg: Object.freeze(Array.from({ length: 19 }, (_, i) => -90 + 10 * i)),
    latDeg: Object.freeze([-40, -30, -20, -10, 0, 10, 20, 30, 40]),
    v0Kms: Object.freeze([400, 600, 850, 1200, 1700, 2400]),
    qLevels: Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9]),
    members: 256,
    dtS: 1800,
    nSteps: 480,           // 10 days: slow CMEs still resolve
    halfAngleDeg: 40,      // typical flare-associated width; disclosed
    ambientWKms: 400,
    seed: 20261014,
    minHits: 8,            // fewer hitting members ⇒ no quantiles (q = null)
});

// 5-point Gauss–Hermite, weights normalised to sum 1 (∫ e^{−x²}/√π).
const GH_X = [-2.0201828705, -0.9585724646, 0, 0.9585724646, 2.0201828705];
const GH_W = [0.0112574113, 0.2220759220, 0.5333333333, 0.2220759220, 0.0112574113];

// ── Baking (used by scripts/build-cme-outlook-table.mjs and the gate) ───────

function cellSeed(lonDeg, latDeg, v0Kms) {
    let h = RESPONSE_GRID.seed >>> 0;
    for (const n of [lonDeg + 1000, latDeg + 1000, v0Kms]) {
        h ^= n; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h || 1;
}

function quantileSorted(sorted, p) {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Fly one synthetic CME through a loaded kernel. Seeded through
 * `donkiToPreset` so it is EXACTLY what a DONKI analysis of the same
 * launch would get. → { h, g, q }.
 */
export function buildResponseCell(kernel, { lonDeg, latDeg, v0Kms }) {
    const G = RESPONSE_GRID;
    const p = donkiToPreset({
        id: `outlook-${lonDeg}-${latDeg}-${v0Kms}`, timeIso: '2026-01-01T00:00:00Z',
        speedKms: v0Kms, latDeg, lonDeg, halfAngleDeg: G.halfAngleDeg, earthDirected: false,
    }, { ambientWKms: G.ambientWKms });
    kernel.setInteraction({ enabled: false });
    kernel.setRopes([{ ...p.rope, launchOffsetS: 0 }]);
    kernel.setSpreads(p.spreads);
    const run = kernel.ensembleRun(cellSeed(lonDeg, latDeg, v0Kms), G.members, 0, G.dtS, G.nSteps);
    const hits = [...run.arrivalH].filter(Number.isFinite).sort((a, b) => a - b);
    const r3 = (x) => Math.round(x * 1000) / 1000;
    return {
        h: r3(hits.length / run.members),
        g: r3(run.pMinBzBelow(GEO_BZ_NT)),
        q: hits.length >= G.minHits
            ? G.qLevels.map((l) => Math.round(quantileSorted(hits, l) * 10) / 10)
            : null,
    };
}

// ── Table lookup ─────────────────────────────────────────────────────────────

function axisPos(axis, x) {
    if (x <= axis[0]) return [0, 0, 0];
    const n = axis.length - 1;
    if (x >= axis[n]) return [n, n, 0];
    let i = 0;
    while (axis[i + 1] < x) i++;
    return [i, i + 1, (x - axis[i]) / (axis[i + 1] - axis[i])];
}

/**
 * Interpolated kernel response at (lon, lat, v0). h, g trilinear (v in log
 * space); quantiles HIT-WEIGHTED over corners that have them. Outside the
 * Earth-facing hemisphere (|lon| > 90) the response is zero by definition:
 * a back-sided launch is a miss at this fidelity.
 */
export function responseAt(cells, lonDeg, latDeg, v0Kms) {
    const G = RESPONSE_GRID;
    if (!(Math.abs(lonDeg) <= 90)) return { h: 0, g: 0, q: null };
    const [a0, a1, fa] = axisPos(G.latDeg, latDeg);
    const [o0, o1, fo] = axisPos(G.lonDeg, lonDeg);
    const lv = G.v0Kms.map(Math.log);
    const [v0, v1, fv] = axisPos(lv, Math.log(Math.max(1, v0Kms)));
    const nO = G.lonDeg.length, nV = G.v0Kms.length;
    let h = 0, g = 0, qw = 0;
    const q = G.qLevels.map(() => 0);
    for (const [ai, wa] of [[a0, 1 - fa], [a1, fa]]) {
        for (const [oi, wo] of [[o0, 1 - fo], [o1, fo]]) {
            for (const [vi, wv] of [[v0, 1 - fv], [v1, fv]]) {
                const w = wa * wo * wv;
                if (!w) continue;
                const c = cells[(ai * nO + oi) * nV + vi];
                h += w * c[0];
                g += w * c[1];
                if (c[2] && c[0] > 0) {
                    const ww = w * c[0];
                    qw += ww;
                    for (let k = 0; k < q.length; k++) q[k] += ww * c[2][k];
                }
            }
        }
    }
    return { h, g, q: qw > 0 ? q.map((x) => x / qw) : null };
}

/**
 * Piecewise-linear arrival CDF from the quantiles, with the outer segments
 * extended at their own slope to 0 and 1 (no invented tail shape).
 */
export function arrivalCdf(q, tH) {
    const L = RESPONSE_GRID.qLevels;
    const xs = [q[0] - (q[1] - q[0]) * (L[0] / (L[1] - L[0])), ...q,
        q[4] + (q[4] - q[3]) * ((1 - L[4]) / (L[4] - L[3]))];
    const ys = [0, ...L, 1];
    if (tH <= xs[0]) return 0;
    if (tH >= xs[xs.length - 1]) return 1;
    let i = 0;
    while (xs[i + 1] < tH) i++;
    const span = xs[i + 1] - xs[i];
    return span > 0 ? ys[i] + (ys[i + 1] - ys[i]) * (tH - xs[i]) / span : ys[i + 1];
}

// ── The outlook ──────────────────────────────────────────────────────────────

function utcMidnight(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Flare-band Poisson rates per day from a region's SWPC probabilities. */
export function bandRates(reg) {
    const rM = rateFromDailyProbability(reg.pM);
    if (rM == null) return null;
    const rX = rateFromDailyProbability(reg.pX ?? 0) ?? 0;
    if (!Number.isFinite(rM) || !Number.isFinite(rX)) return null;   // p = 1: refuse, don't explode
    return { M: Math.max(0, rM - rX), X: rX };
}

/**
 * Issue an outlook.
 *
 * @param {object} o
 * @param {Array}  o.regionRows   /api/noaa/regions `data.regions` rows (history ok)
 * @param {Array}  o.cells        RESPONSE_CELLS (js/cme-outlook-response.js)
 * @param {number} o.nowMs
 * @param {number} [o.days]
 * @returns {{ ok: false, reason } | { ok: true, model, issuedMs, days, regions, coverage, assumptions }}
 */
export function issueOutlook({ regionRows, cells, nowMs, days = OUTLOOK_DAYS } = {}) {
    const G = RESPONSE_GRID;
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'no-time' };
    if (!Array.isArray(cells)
        || cells.length !== G.latDeg.length * G.lonDeg.length * G.v0Kms.length) {
        return { ok: false, reason: 'response-table-mismatch' };
    }
    const regions = latestRegions(regionRows ?? [], { fallbackAnchorMs: nowMs });
    if (!regions.length) return { ok: false, reason: 'no-regions' };
    const usable = regions.map((r) => ({ r, rates: bandRates(r) })).filter((x) => x.rates);
    if (!usable.length) return { ok: false, reason: 'no-probabilities' };

    const day0 = utcMidnight(nowMs);
    const windows = Array.from({ length: days }, (_, d) => ({
        dayMs: day0 + d * DAY,
        startMs: d === 0 ? nowMs : day0 + d * DAY,
        endMs: day0 + (d + 1) * DAY,
        mu: 0, muGeo: 0, byRegion: new Map(),
    }));
    const horizonEnd = windows[windows.length - 1].endMs;
    const stepMs = LAUNCH_STEP_H * HOUR;

    for (let t0 = nowMs; t0 < horizonEnd; t0 += stepMs) {
        const dt = Math.min(stepMs, horizonEnd - t0);
        const tMid = t0 + dt / 2;
        for (const { r, rates } of usable) {
            const pos = regionAt(r, tMid);
            if (!(Math.abs(pos.lonDeg) <= 90)) continue;
            for (const band of ['M', 'X']) {
                const expected = rates[band] * CME_ASSOCIATION[band] * (dt / DAY);
                if (!(expected > 0)) continue;
                const sp = CME_SPEED[band];
                for (let n = 0; n < GH_X.length; n++) {
                    const v = sp.medianKms * Math.exp(Math.SQRT2 * sp.sigLn * GH_X[n]);
                    const resp = responseAt(cells, pos.lonDeg, pos.latDeg, v);
                    if (!(resp.h > 0) || !resp.q) continue;
                    // Flare → 21.5 R☉ crossing (the table's t = 0).
                    const launchMs = tMid + (20.5 * RSUN_KM / v) * 1000;
                    const m = expected * GH_W[n];
                    for (const w of windows) {
                        if (w.endMs <= launchMs) continue;
                        const a = arrivalCdf(resp.q, (Math.max(w.startMs, launchMs) - launchMs) / HOUR);
                        const b = arrivalCdf(resp.q, (w.endMs - launchMs) / HOUR);
                        const pm = m * resp.h * (b - a);
                        if (!(pm > 0)) continue;
                        w.mu += pm;
                        // g is NOT a subset of h: the sheath reaches L1 on
                        // flank passes the rope misses (measured in the
                        // table: g > h at |lat| 30°). Timed on the rope's
                        // arrival distribution — the sheath leads it by hours.
                        w.muGeo += m * resp.g * (b - a);
                        w.byRegion.set(r.region, (w.byRegion.get(r.region) ?? 0) + pm);
                    }
                }
            }
        }
    }

    const r4 = (x) => Math.round(x * 1e4) / 1e4;
    return {
        ok: true,
        model: OUTLOOK_MODEL_ID,
        issuedMs: nowMs,
        days: windows.map((w, d) => ({
            dayMs: w.dayMs,
            startMs: w.startMs,
            endMs: w.endMs,
            leadDays: d,
            expected: r4(w.mu),
            pArrival: r4(1 - Math.exp(-w.mu)),
            pGeo: r4(1 - Math.exp(-w.muGeo)),
            topRegions: [...w.byRegion.entries()]
                .sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([region, mu]) => ({ region, share: w.mu > 0 ? r4(mu / w.mu) : 0 })),
            lowerBound: d >= 3,
        })),
        regions: usable.map(({ r, rates }) => ({
            region: r.region, latDeg: r.latDeg, lonDeg: r.lonDeg, anchorMs: r.anchorMs,
            pM: r.pM, pX: r.pX, rateM: r4(rates.M), rateX: r4(rates.X),
        })),
        coverage: {
            regionsSeen: regions.length,
            regionsUsable: usable.length,
            note: 'Visible regions only — regions that emerge or rotate onto the disc '
                + 'are not included, so later days are lower bounds.',
        },
        assumptions: {
            flareRate: 'SWPC 24 h probabilities, held constant (persistence)',
            cmeAssociation: CME_ASSOCIATION,
            cmeSpeed: CME_SPEED,
            response: `flux-rope kernel ensemble via donkiToPreset, half-angle ${G.halfAngleDeg}°, baked`,
            geoThresholdNt: GEO_BZ_NT,
            independence: 'Poisson superposition of launches',
        },
    };
}

// ── Scoring (pure; the cron resolves truth, this scores it) ─────────────────

/**
 * Brier score per lead day + the climatology reference on the same rows.
 * rows: [{ lead_days, p, obs (boolean) }]; `baseRate` = the climatological
 * daily probability (e.g. observed arrivals / observed days in the ledger).
 * BSS = 1 − BS/BS_clim (> 0 beats climatology). Null where n = 0.
 */
export function brierByLead(rows, baseRate) {
    const by = new Map();
    for (const r of rows ?? []) {
        if (typeof r?.obs !== 'boolean' || !Number.isFinite(r?.p)) continue;
        const k = r.lead_days;
        if (!by.has(k)) by.set(k, { n: 0, bs: 0, bsClim: 0, events: 0 });
        const s = by.get(k);
        const o = r.obs ? 1 : 0;
        s.n++; s.events += o;
        s.bs += (r.p - o) ** 2;
        if (Number.isFinite(baseRate)) s.bsClim += (baseRate - o) ** 2;
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([lead, s]) => {
        const bs = s.bs / s.n;
        const bsClim = Number.isFinite(baseRate) ? s.bsClim / s.n : null;
        return {
            lead, n: s.n, events: s.events, brier: bs, brierClim: bsClim,
            bss: bsClim > 0 ? 1 - bs / bsClim : null,
        };
    });
}

// ── Ledger rows (pure; api/cron/validation-rerun.js writes them) ────────────

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * cme_outlook_issues rows for one issued outlook. The regions and the
 * assumptions ride on the lead-0 row only (one copy per issue).
 */
export function outlookIssueRows(outlook) {
    if (!outlook?.ok) return [];
    const issuedAt = new Date(outlook.issuedMs).toISOString();
    return outlook.days.map((d) => ({
        model_id: outlook.model,
        issued_at: issuedAt,
        issue_day: isoDay(outlook.issuedMs),
        valid_day: isoDay(d.dayMs),
        lead_days: d.leadDays,
        p_arrival: d.pArrival,
        p_geo: d.pGeo,
        expected: d.expected,
        lower_bound: d.lowerBound,
        inputs: d.leadDays === 0
            ? { regions: outlook.regions, coverage: outlook.coverage, assumptions: outlook.assumptions }
            : null,
    }));
}

/** Resolution waits this long after valid_day ends (shock resolver + Bz enrichment lag). */
export const RESOLVE_AFTER_DAYS = 2;
/** Past this, an arrival whose Bz never resolved is closed with obs_geo = null. */
export const GEO_GIVE_UP_DAYS = 10;
/** Fraction of the day's 1-min L1 samples needed to call "no arrival" a NO. */
export const MIN_L1_COVERAGE = 0.6;

/**
 * Truth for one outlook row. Pure.
 *
 * Counts only arrivals of CMEs launched AFTER the issue (the outlook's
 * claim is about eruptions that had not happened). A day with no qualifying
 * arrival is a NO only if L1 coverage that day was adequate — a data gap
 * stays pending (the ledger's own rule, validation-scoring
 * resolveEventTruth). An arrival whose Bz is not yet known waits up to
 * GEO_GIVE_UP_DAYS, then closes with obs_geo = null.
 *
 * @param {object} o
 * @param {string} o.validDay       'YYYY-MM-DD'
 * @param {string} o.issuedAt       ISO
 * @param {Array}  o.arrivals       [{ shockMs, launchMs, minBzNt|null }]
 * @param {number|null} o.coverage  fraction of the valid day with good L1 data (null = unknown)
 * @param {number} o.nowMs
 */
export function resolveOutlookRow({ validDay, issuedAt, arrivals = [], coverage = null, nowMs }) {
    const dayStart = Date.parse(`${validDay}T00:00:00Z`);
    const dayEnd = dayStart + DAY;
    if (!(nowMs >= dayEnd + RESOLVE_AFTER_DAYS * DAY)) return { status: 'pending', note: 'too-early' };
    const issuedMs = Date.parse(issuedAt);
    const hits = arrivals.filter((a) => a.shockMs >= dayStart && a.shockMs < dayEnd
        && Number.isFinite(a.launchMs) && a.launchMs > issuedMs);
    if (!hits.length) {
        if (!(Number.isFinite(coverage) && coverage >= MIN_L1_COVERAGE)) {
            return { status: 'pending', note: 'l1-coverage-gap' };
        }
        return { status: 'resolved', obsArrival: false, obsGeo: false };
    }
    if (hits.some((a) => Number.isFinite(a.minBzNt) && a.minBzNt < GEO_BZ_NT)) {
        return { status: 'resolved', obsArrival: true, obsGeo: true };
    }
    if (hits.every((a) => Number.isFinite(a.minBzNt))) {
        return { status: 'resolved', obsArrival: true, obsGeo: false };
    }
    if (nowMs >= dayEnd + GEO_GIVE_UP_DAYS * DAY) {
        return { status: 'resolved', obsArrival: true, obsGeo: null, note: 'bz-unresolved' };
    }
    return { status: 'pending', note: 'bz-pending' };
}
