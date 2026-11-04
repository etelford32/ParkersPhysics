/**
 * home-neo-model.js — PURE model for the homepage's "10 nearest near-Earth
 * objects right now" widget (js/home-neo-watch.js draws it).
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no three.js, no ambient time. `node tests/home-neo-model.mjs`.
 *
 * ── Nothing here is a second kernel ────────────────────────────────────────
 * Positions come from js/neo-worker.js's `geoframe` answer — the SAME
 * catalogue (/api/neo/catalog), the SAME Kepler propagation (js/neo-orbits.js)
 * and the SAME J2000 Earth (js/neo-space.js `earthHelioJ2000`) the solar
 * system orrery and the Near-Earth Watch run on. Every number on a row is
 * js/neo-space.js `buildObjectRow` (distance, RA/Dec, magnitude, size, the
 * encounter screen, the observer's alt/az). This file only RANKS, PROJECTS
 * and FORMATS:
 *
 *   · `nearestIndices` — the ten smallest geocentric distances inside the
 *     horizon (neo-watch.js has the same rule as a method; this is the
 *     copy a widget without the page's class can call).
 *   · `planPoint` — the PLAN VIEW: a geocentric vector projected onto the
 *     ecliptic (J2000) plane, radius through the Near-Earth Watch's own
 *     logarithmic map `geoSceneRadius` (Earth's surface = 1, the Moon =
 *     MOON_SCENE — anchors that module derives its gain from). The map is
 *     the ONE piece of spatial dishonesty on the page, DISCLOSED in the
 *     caption and ruled by `PLAN_RINGS`. Out-of-plane distance is reported
 *     as an elevation and drawn as a glyph, never hidden.
 *   · `approachTrend` — closing/receding from two frames' distances.
 *   · `CLASS_TINTS` — the orrery's own per-class colours (js/neo-layer.js
 *     NEO_COLORS, which imports three and so cannot run under node — the
 *     gate pins these against that file's source text).
 *
 * The LIST is "nearest by our two-body propagation at this instant". It is
 * not JPL's close-approach table, which is the authority on WHEN and HOW
 * CLOSE a flyby is (integrated orbits) — the widget links to it rather than
 * re-deriving it, the Near-Earth Watch rule.
 */

import { AU_KM, LD_KM } from './neo-orbits.js';
import { geoSceneRadius, MOON_SCENE, EARTH_RADIUS_KM, formatGeoDistance } from './neo-space.js';

export { AU_KM, LD_KM, MOON_SCENE, EARTH_RADIUS_KM };

/** How many rows the widget shows. */
export const TOP_N = 10;
/** The horizon: objects farther than this are not "near" in any useful sense (neo-space GEO_MAP.maxKm). */
export const HORIZON_AU = 0.5;
/** Catalogue tiers, loaded in this order (the Near-Earth Watch ladder: pha first, the ≥140 m class replaces it). */
export const TIER_LADDER = Object.freeze(['pha', 'bright']);

/** The orrery's class colours (js/neo-layer.js NEO_COLORS), as CSS hex. */
export const CLASS_TINTS = Object.freeze({
    pha: '#ff5a3c', APO: '#ffb347', ATE: '#5be0c8', AMO: '#c39bff', IEO: '#ff8ad8',
    comet: '#7fd7ff', interstellar: '#ffffff', other: '#a09a8c',
});

/** Which tint a row wears: hazard first, then dynamical class. */
export function tintFor(row) {
    if (!row) return CLASS_TINTS.other;
    if (row.isInterstellar) return CLASS_TINTS.interstellar;
    if (row.isComet) return CLASS_TINTS.comet;
    if (row.isPHA) return CLASS_TINTS.pha;
    return CLASS_TINTS[row.cls] ?? CLASS_TINTS.other;
}

/**
 * Indices of the `limit` nearest objects in a geoframe (`rGeo` in AU),
 * inside `horizonAU`, nearest first. Stable for ties (index order).
 */
export function nearestIndices(frame, limit = TOP_N, horizonAU = HORIZON_AU) {
    if (!frame || !frame.rGeo) return [];
    const idx = [];
    for (let k = 0; k < frame.count; k++) if (frame.rGeo[k] <= horizonAU) idx.push(k);
    idx.sort((a, b) => (frame.rGeo[a] - frame.rGeo[b]) || (a - b));
    return idx.slice(0, limit);
}

/**
 * Plan-view position of a geocentric J2000 ecliptic vector (AU): the
 * direction in the ecliptic plane, the radius through the Near-Earth
 * Watch's log map. `elevDeg` is the angle out of the plane (+ north).
 */
export function planPoint(gx, gy, gz) {
    const dAU = Math.hypot(gx, gy, gz);
    const r = geoSceneRadius(dAU * AU_KM);
    const h = Math.hypot(gx, gy);
    const ux = h > 1e-15 ? gx / h : 0, uy = h > 1e-15 ? gy / h : 0;
    return {
        x: ux * r, y: uy * r, r, distKm: dAU * AU_KM,
        above: gz >= 0,
        elevDeg: dAU > 0 ? Math.asin(Math.max(-1, Math.min(1, gz / dAU))) * 180 / Math.PI : 0,
    };
}

/** The ruler: real radii and their drawn radii, inner to outer. */
export const PLAN_RINGS = Object.freeze([
    { id: 'ld1',   label: '1 LD',   km: LD_KM },
    { id: 'ld5',   label: '5 LD',   km: 5 * LD_KM },
    { id: 'ld10',  label: '10 LD',  km: 10 * LD_KM },
    { id: 'au005', label: '0.05 AU · JPL watch', km: 0.05 * AU_KM },
    { id: 'au02',  label: '0.2 AU', km: 0.2 * AU_KM },
].map((r) => Object.freeze({ ...r, scene: geoSceneRadius(r.km) })));

/** Drawn radius that fits every plotted point (and always the Moon's orbit). */
export function planExtent(points) {
    let m = MOON_SCENE * 1.15;
    for (const p of points || []) if (Number.isFinite(p?.r)) m = Math.max(m, p.r * 1.08);
    return m;
}

/**
 * Closing or receding, from two frames of geocentric distance (km) `dtDays`
 * apart. Returns { kms, closing } or null without a usable pair.
 */
export function approachTrend(prevKm, km, dtDays) {
    if (!Number.isFinite(prevKm) || !Number.isFinite(km) || !(dtDays > 0)) return null;
    const kms = (km - prevKm) / (dtDays * 86_400);
    return { kms, closing: kms < 0 };
}

/** Compact table strings for one `buildObjectRow` row. */
export function rowSummary(row, trend = null) {
    const dist = row.distLabel ?? formatGeoDistance(row.distKm);
    const ld = Number.isFinite(row.distLD) ? row.distLD : null;
    const sky = row.sky
        ? (row.sky.up ? `${row.sky.altDeg.toFixed(0)}° up · ${row.sky.compass}` : 'below your horizon')
        : null;
    return {
        dist,
        ld: ld != null ? (ld < 10 ? ld.toFixed(2) : ld.toFixed(1)) : '—',
        trend: trend ? `${trend.closing ? 'closing' : 'receding'} ${Math.abs(trend.kms).toFixed(1)} km/s` : '—',
        size: row.sizeLabel ?? '—',
        sizeNote: row.sizeSource ?? null,
        cls: row.isInterstellar ? 'interstellar' : row.isComet ? 'comet' : row.classLabel ?? row.cls ?? '—',
        hazard: row.isPHA ? 'PHA' : '',
        radec: row.raDecLabel ?? '—',
        sky,
        mag: Number.isFinite(row.mag) ? row.mag.toFixed(1) : null,
        regime: row.encounter?.regime ?? null,
    };
}

/** Tier → human label for the caption. */
export function tierLabel(tier) {
    return { pha: 'potentially hazardous asteroids', bright: 'NEOs ≥ 140 m + PHAs + comets', all: 'the whole catalogue' }[tier] ?? tier;
}
