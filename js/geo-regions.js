/**
 * geo-regions.js — coarse named regions for labelling grid cells ("Gran Chaco
 * heat"), and the greedy clusterer that folds neighbouring flagged cells into
 * one event. PURE.
 *
 * MOVED here verbatim from api/weather/extremes.js (2026-10-06) because `api/`
 * is the serverless directory and is not served statically: a browser import of
 * it 404s, and on a one-module page that takes the whole page down (the
 * hek-filaments scar in CLAUDE.md). The Storm Watch extremes route and the
 * Planetary Temperature Lab (PLANETARY_TEMPERATURE_LAB_PLAN.md §3.4) now share
 * ONE table. tests/geo-regions.mjs pins the move as behaviour-identical: every
 * one of the 2592 grid-cell labels and the cluster output hash-match what the
 * inline copy produced.
 *
 * This is event LABELLING on 5° cells, not geocoding.
 */

// ── Region labelling ─────────────────────────────────────────────────────────
// Coarse named boxes, FIRST MATCH WINS — specific seas/regions before the
// broad ocean/continent fallbacks. [latMin, latMax, lonMin, lonMax, name];
// a box with lonMin > lonMax wraps the antimeridian. 5° grid cells only —
// this is event labelling ("Gran Chaco heat"), not geocoding.
export const REGIONS = [
    // Specific seas / basins first
    [15,  30, -100, -80, 'Gulf of Mexico'],
    [10,  25,  -90, -60, 'Caribbean'],
    [30,  46,  -10,  40, 'Mediterranean'],
    [5,   25,   80, 100, 'Bay of Bengal'],
    [0,   25,  100, 122, 'South China Sea'],
    [-50, -30, 150, 175, 'Tasman Sea'],
    // Land regions
    [15,  35, -120, -95, 'Mexico & US Southwest'],
    [30,  50, -105, -85, 'US Great Plains & Midwest'],
    [25,  47,  -85, -65, 'Eastern North America'],
    [35,  60, -130, -105, 'Western North America'],
    [50,  72, -170, -130, 'Alaska & Yukon'],
    [45,  70, -105, -55, 'Central & Eastern Canada'],
    [59,  84,  -75, -10, 'Greenland'],
    [-5,  12,  -80, -50, 'Amazon Basin (N)'],
    [-20,  -5, -75, -45, 'Amazon & Gran Chaco'],
    [-35, -20, -70, -50, 'Gran Chaco & Pampas'],
    [-56, -35, -76, -60, 'Patagonia'],
    [-20,   5, -82, -68, 'Andes'],
    [35,  60,  -12,  20, 'Western Europe'],
    [42,  60,   20,  45, 'Eastern Europe'],
    [55,  72,    4,  42, 'Scandinavia & Baltics'],
    [18,  35,  -18,  35, 'Sahara & North Africa'],
    [8,   18,  -18,  40, 'Sahel'],
    [-5,  12,  -18,  32, 'West & Central Africa'],
    [-12,  8,   28,  52, 'East Africa'],
    [-35, -12,  10,  42, 'Southern Africa'],
    [12,  40,   35,  62, 'Middle East & Arabia'],
    [35,  55,   45,  90, 'Central Asia'],
    [48,  75,   60, 180, 'Siberia'],
    [20,  48,  100, 132, 'East Asia'],
    [30,  46,  128, 146, 'Japan & Korea'],
    [5,   32,   62, 92, 'South Asia'],
    [-11,  22,   92, 130, 'Southeast Asia'],
    [-25, -10,  112, 155, 'Northern Australia'],
    [-40, -25,  112, 155, 'Southern Australia'],
    [-48, -33,  165, 180, 'New Zealand'],
    [-90, -60, -180, 180, 'Antarctica'],
    // Broad ocean fallbacks
    [66,  90, -180, 180, 'Arctic'],
    [-60, -40, -180, 180, 'Southern Ocean'],
    [30,  66,  -75,  -5, 'North Atlantic'],
    [0,   30,  -75, -15, 'Tropical Atlantic'],
    [-40,   0, -50,  15, 'South Atlantic'],
    [30,  62,  140, -120, 'North Pacific'],          // wraps antimeridian
    [-5,  30, -180, -95, 'Eastern Tropical Pacific'],
    [-5,  30,  130, 180, 'Western Tropical Pacific'],
    [-40,  -5,  150, -80, 'South Pacific'],          // wraps antimeridian
    [-40,  25,   42, 110, 'Indian Ocean'],
];

function lonInBox(lon, lonMin, lonMax) {
    if (lonMin <= lonMax) return lon >= lonMin && lon <= lonMax;
    return lon >= lonMin || lon <= lonMax;            // antimeridian wrap
}

/** Every name a cell can be labelled with (first-seen order, unique). The
 *  lab's region filter accepts exactly these — anything else is ignored. */
export const REGION_NAMES = Object.freeze([...new Set(REGIONS.map(r => r[4]))]);

export function labelRegion(lat, lon) {
    for (const [a, b, c, d, name] of REGIONS) {
        if (lat >= a && lat <= b && lonInBox(lon, c, d)) return name;
    }
    return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ` +
           `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}

// ── Clustering ───────────────────────────────────────────────────────────────

export function lonDelta(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * Greedy merge of flagged cells into events. Items arrive sorted by
 * exceedance (the SQL orders them), so the first cell of each cluster is
 * its peak; neighbours within `radiusDeg` fold in as extent.
 */
export function clusterCells(items, radiusDeg = 8, maxClusters = 6) {
    const clusters = [];
    for (const it of items ?? []) {
        const home = clusters.find(cl =>
            Math.abs(cl.lat - it.lat) <= radiusDeg &&
            lonDelta(cl.lon, it.lon) <= radiusDeg);
        if (home) {
            home.cells += 1;
            home.sev = Math.max(home.sev, it.sev);
        } else {
            clusters.push({ ...it, cells: 1, region: labelRegion(it.lat, it.lon) });
        }
    }
    return clusters.slice(0, maxClusters);
}
