/**
 * temperature-snapshot.js — the PURE half of /api/temperature/snapshot
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §4.5). No fetch, no env, no ambient time:
 * the route passes `nowMs` in, and `node tests/temperature-snapshot-route.mjs`
 * exercises every branch with fixtures.
 *
 * Three jobs:
 *   normalizeLabRow   one temperature_lab_cache row → the snapshot shape
 *                     js/temperature-lab-model.js reads. A payload whose arrays
 *                     are not 2592 long is REFUSED (null), never padded — a
 *                     short array would silently shift every cell after the gap
 *   freshnessOf       'live' | 'stale' | 'expired' + the reasons. A 200 is
 *                     otherwise scored healthy on status.html no matter what it
 *                     serves (CLAUDE.md §8), so a fallback source, thin
 *                     coverage, an old window or missing normals each say so
 *   encodeResponse    the model → a compact body: per-cell arrays rounded to
 *                     0.1 (K / percentile points), cards cut to `top`
 */

import { CELLS } from '../../js/temperature-normals.js';

export const MAX_AGE_LIVE_MS = 3 * 3_600_000;     // the aggregate runs hourly at :25
export const MIN_COVERAGE = 0.9;                  // area-weighted share of cells with data
const ARRAYS = ['t24max', 't24min', 't24mean', 'tnow', 'prev24mean'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** @returns {object|null} the snapshot, or null when the row cannot be trusted */
export function normalizeLabRow(row) {
    const p = row?.payload;
    if (!p || typeof p !== 'object' || !row.frame_to) return null;
    for (const k of ARRAYS) {
        if (!Array.isArray(p[k]) || p[k].length !== CELLS) return null;
    }
    // Postgres numeric → JSON number; anything else (string, NaN) is a gap
    const clean = (arr) => arr.map(v => (isNum(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null)));
    const snap = {
        computed_at: row.computed_at ?? null,
        frame_from: row.frame_from ?? null,
        frame_to: row.frame_to,
        n_frames: isNum(row.n_frames) ? row.n_frames : null,
        sources: row.sources && typeof row.sources === 'object' ? row.sources : {},
    };
    for (const k of ARRAYS) snap[k] = clean(p[k]);
    return snap;
}

/**
 * @param {{snapshot?: object|null, model?: object|null, normalsOk: boolean, nowMs: number}} a
 * @returns {{freshness: 'live'|'stale'|'expired', reasons: string[]}}
 */
export function freshnessOf({ snapshot, model, normalsOk, nowMs }) {
    if (!snapshot) return { freshness: 'expired', reasons: ['no-aggregate'] };
    if (!normalsOk || !model) return { freshness: 'expired', reasons: ['normals-unavailable'] };
    const reasons = [];
    const age = nowMs - Date.parse(snapshot.frame_to);
    if (!(age <= MAX_AGE_LIVE_MS)) reasons.push('window-old');
    if (model.disclosure?.fallbackSource) reasons.push('fallback-source');
    if (!(model.planet?.coverage >= MIN_COVERAGE)) reasons.push('low-coverage');
    return { freshness: reasons.length ? 'stale' : 'live', reasons };
}

const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

function encodeRow(row) {
    return {
        cell: row.cell, lat: row.lat, lon: row.lon, region: row.region,
        place: row.place, landPct: row.landPct,
        valueC: r2(row.valueC), normalC: r2(row.normalC), anomalyK: r2(row.anomalyK),
        percentile: r2(row.percentile), cls: row.cls, beyondRecord: row.beyondRecord,
        ...(isNum(row.changeK) ? { changeK: r2(row.changeK) } : {}),
    };
}

/** The response body. `fresh` comes from freshnessOf. */
export function encodeResponse({ snapshot, model, fresh, top = 25 }) {
    const body = {
        freshness: fresh.freshness,
        reasons: fresh.reasons,
        updated: snapshot?.computed_at ?? null,
        window: snapshot ? { from: snapshot.frame_from, to: snapshot.frame_to, frames: snapshot.n_frames } : null,
        sources: snapshot?.sources ?? {},
    };
    if (!model) return { ...body, planet: null, cards: null, grid: null, disclosure: null };
    const cards = {};
    for (const [k, rows] of Object.entries(model.cards)) cards[k] = rows.slice(0, top).map(encodeRow);
    const p = model.planet;
    return {
        ...body,
        windowMidpoint: model.windowMidpoint,
        surface: model.surface,
        planet: {
            anomalyK: r2(p.anomalyK), landAnomalyK: r2(p.landAnomalyK), oceanAnomalyK: r2(p.oceanAnomalyK),
            coverage: r2(p.coverage),
            landTopDecile: r2(p.landTopDecile), landBottomDecile: r2(p.landBottomDecile),
            decileExpected: p.decileExpected,
            recordHighCells: p.recordHighCells, recordLowCells: p.recordLowCells,
            hottest: p.hottest ? encodeRow(p.hottest) : null,
            coldest: p.coldest ? encodeRow(p.coldest) : null,
        },
        cards,
        grid: { w: 72, h: 36, anomalyK: model.grid.anomalyK.map(r1), percentile: model.grid.percentile.map(r1) },
        disclosure: model.disclosure,
    };
}
