/**
 * ocean-reference-stations.js — the ONE copy of the ocean layers' reference
 * markers, and the shape of a degraded /api/ocean/* answer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE: no fetch, no DOM. Imported by the three ocean routes (api/ocean/
 * tides.js, buoys.js, dart.js — api/ already imports js/ modules, see
 * api/weather/grid.js) AND by the browser layer (js/ocean-stations-layer.js),
 * so the server and the client cannot disagree about what a reference marker
 * is. `node tests/ocean-feeds.mjs` + `tests/pipeline-registry.mjs` gate it.
 *
 * WHAT A REFERENCE MARKER IS
 * ──────────────────────────
 * Geometry only. When NOAA cannot be reached the routes used to 503, which
 * (1) scored red on status.html with no way to tell "NOAA is down" from "our
 * route is broken", and (2) left the Layers-panel toggle doing nothing until
 * the client's own catch drew these same points from a private copy. The
 * routes now answer 200 + `freshness: 'stale'` with these markers, every one
 * flagged `reference: true` (and `fallback: true`, the field the detail card
 * already reads), so:
 *
 *   • status.html scores the row AMBER (freshness=stale), not red or green;
 *   • the layer draws honest reference locations and its pip goes amber;
 *   • the detail card says "DEFAULT VIEW · LIVE FEED UNAVAILABLE" and never
 *     prints an observation for a point that has none.
 *
 * A reference marker is NOT a station: ids are REF-*, names say "reference",
 * and no observation, prediction or reading is ever attached to one. The
 * coordinates are coastal / basin locations where the real networks have
 * instruments — illustrative placement, not a catalogue.
 *
 * CLAUDE.md §8: a route that degrades to a fallback says freshness:'stale'.
 */

const mark = (prefix, nameSuffix) => ([name, lat, lon], index) => ({
    id:   `${prefix}-${index + 1}`,
    name: `${name} ${nameSuffix}`,
    lat, lon,
    reference: true,
    fallback:  true,
});

export const REFERENCE_STATIONS = Object.freeze({
    tides: [
        ['Puget Sound', 47.60, -122.34],
        ['San Francisco Bay', 37.81, -122.47],
        ['Southern California', 33.72, -118.27],
        ['Honolulu', 21.31, -157.87],
        ['Southcentral Alaska', 61.13, -149.90],
        ['Gulf Coast', 29.31, -94.79],
        ['Key West', 24.56, -81.81],
        ['South Florida', 25.77, -80.13],
        ['Charleston', 32.78, -79.93],
        ['Chesapeake Bay', 36.97, -76.33],
        ['New York Harbor', 40.70, -74.01],
        ['Boston Harbor', 42.36, -71.05],
        ['San Juan', 18.46, -66.12],
        ['Guam', 13.44, 144.65],
    ].map(mark('REF-TIDE', 'reference')),
    buoys: [
        ['Northeast Pacific', 45, -130],
        ['California offshore', 35, -123],
        ['Gulf of Alaska', 56, -148],
        ['North Pacific', 30, -155],
        ['Hawaiian waters', 20, -158],
        ['Western tropical Pacific', 12, 150],
        ['Eastern tropical Pacific', 5, -110],
        ['Gulf of Mexico', 26, -90],
        ['Florida Atlantic', 28, -78],
        ['Caribbean Sea', 17, -67],
        ['Western North Atlantic', 34, -72],
        ['New England offshore', 41, -68],
        ['Central North Atlantic', 40, -45],
        ['South Atlantic', -20, -25],
        ['North Sea', 56, 3],
        ['Mediterranean', 36, 18],
        ['Arabian Sea', 15, 65],
        ['Bay of Bengal', 15, 88],
        ['Coral Sea', -20, 155],
        ['Southern Ocean', -50, 90],
    ].map(mark('REF-BUOY', 'reference')),
    dart: [
        ['Alaska/Aleutians', 52.6, -156.4],
        ['Northeast Pacific', 46.9, -155.1],
        ['Pacific Northwest', 44.6, -125.8],
        ['California offshore', 34.8, -120.8],
        ['Hawaii north', 23.4, -162.3],
        ['Hawaii south', 17.1, -156.5],
        ['Caribbean', 19.3, -66.6],
        ['Western Atlantic', 31.8, -74.8],
    ].map(mark('REF-DART', 'DART reference')),
});

export const OCEAN_KINDS = Object.freeze(Object.keys(REFERENCE_STATIONS));

/**
 * The 200 body a `?mode=stations` request gets when the upstream failed:
 * reference markers, `freshness: 'stale'`, the reason, and the same
 * `source` / `disclaimer` fields a live answer carries, so a consumer that
 * only reads `stations` keeps working and one that reads `freshness` can
 * say what it is drawing.
 *
 * @param {'tides'|'buoys'|'dart'} kind
 * @param {{ source:string, source_url:string, detail?:string, disclaimer?:string }} o
 */
export function referenceStationsPayload(kind, { source, source_url, detail = '', disclaimer = 'Not for navigation.' } = {}) {
    const stations = REFERENCE_STATIONS[kind];
    if (!stations) throw new RangeError(`referenceStationsPayload: unknown kind '${kind}'`);
    return {
        source,
        source_url,
        freshness: 'stale',
        reason:    'upstream_unavailable',
        detail:    String(detail || '').slice(0, 300),
        note:      `${source} unreachable — ${stations.length} reference locations, not observations`,
        count:     stations.length,
        stations:  stations.map(s => ({ ...s })),
        disclaimer,
    };
}

/**
 * The 200 body a point / station request gets when the upstream failed:
 * `available: false`, `freshness: 'stale'`, the reason — the shape the
 * routes already use for "no nearby station" / "no samples", so the detail
 * card's existing `!available` branch handles it.
 *
 * @param {{ source:string, detail?:string, disclaimer?:string, extra?:object }} o
 */
export function unavailablePayload({ source, detail = '', disclaimer = 'Not for navigation.', extra = {} } = {}) {
    return {
        source,
        available: false,
        freshness: 'stale',
        reason:    'upstream_unavailable',
        detail:    String(detail || '').slice(0, 300),
        ...extra,
        disclaimer,
    };
}
