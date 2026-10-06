/**
 * temperature-lab-model.js — the Planetary Temperature Lab's one definition of
 * "hottest", "coldest" and "most unusual" (PLANETARY_TEMPERATURE_LAB_PLAN.md §3)
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no fetch, no ambient time. /api/temperature/snapshot runs it
 * server-side once per cache window; the lab page, the EarthView panel and
 * `node tests/temperature-lab-model.mjs` read the same function, so a
 * scorecard means the same thing everywhere.
 *
 * INPUT — the live aggregate (one row of temperature_lab_cache, built in
 * Postgres from the newest 24 hourly weather_grid_cache frames):
 *   { frame_to, frame_from, n_frames, sources: {tag: frames},
 *     t24max[2592], t24min[2592], t24mean[2592], tnow[2592], prev24mean[2592] }
 * in °C, cell index j*72+i (js/temperature-normals.js GRID), null = no data.
 *
 * THE RULES, each set by a measurement (plan §2.9):
 *   • "Most above / below normal" ranks by RARITY — the empirical percentile
 *     of the trailing-24-h mean against the cell's own 1991–2020 quantile
 *     curves — never by raw degrees (R5: a raw-ΔT top ten is 66–75 % poleward
 *     of 50°). ΔT rides beside it on every row
 *   • rows are de-duplicated at 1500 km, the spike's own separation
 *   • land is the default universe (≥ 50 % land at the cell centre);
 *     'ocean' and 'all' are explicit options
 *   • a missing value is null all the way out and never counts toward
 *     coverage or a share (the pollution-lab scar: Number(null) is 0)
 *   • values come from the aggregate, NEVER from a decoded texture — the
 *     weather texture clamps at −60 °C and the Antarctic plateau sits at −70
 *     to −79 °C in winter (plan §3.6)
 *   • every planet number is area-weighted (cos lat), with coverage reported,
 *     and every share carries the value it would have in the normal climate
 *     (10 % for a decile), so "14 % of land is in its top decile" reads
 *     against "normal: 10 %" rather than on its own (R7)
 *   • if any frame in the window came from a FALLBACK source
 *     (pipeline-registry isFallbackSource), `disclosure.fallbackSource` is
 *     set — that field understates extremes by 6–8 K (plan §2.7) and the UI
 *     must say so on the cards
 *
 * WHAT IT DOES NOT CLAIM: the live field is model analysis at sampled points
 * and the normal is ERA5 box means; "beyondRecord" means beyond 1991–2020 in
 * ERA5 for the date at this grid point — never "hottest place on Earth"
 * (plan §3.7). `disclosure` carries those words so no consumer re-types them.
 */

import { CELLS, cellCentre, cellSurface, position } from './temperature-normals.js';
import { labelRegion } from './geo-regions.js';
import { isFallbackSource } from './pipeline-registry.js';
import { MAJOR_CITIES } from './data/major-cities.js';

export const CARD_KEYS = Object.freeze(['hottest', 'coldest', 'above', 'below', 'swings']);
export const SEPARATION_KM = 1500;
export const LAND_MIN_PCT = 50;
export const PLACE_RADIUS_KM = 300;
export const DEFAULT_TOP = 25;
/** Inside one named region the planet-wide 1500 km would leave 2–4 rows;
 *  600 km still keeps two neighbouring 5° cells from both being listed at
 *  low latitudes. */
export const REGION_SEPARATION_KM = 600;
const WINDOW_HALF_MS = 11.5 * 3_600_000;     // 24 hourly frames ending at frame_to

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function greatCircleKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const p1 = lat1 * r, p2 = lat2 * r, dl = (lon2 - lon1) * r;
    const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
    return 6371 * Math.acos(Math.min(1, Math.max(-1, c)));
}

/** Nearest MAJOR_CITIES entry within `maxKm`, as "Name, Country" — or null. */
export function nearestPlace(lat, lon, maxKm = PLACE_RADIUS_KM) {
    let best = null, bestKm = maxKm;
    for (const city of MAJOR_CITIES) {
        const d = greatCircleKm(lat, lon, city.lat, city.lon);
        if (d <= bestKm) { bestKm = d; best = city; }
    }
    return best ? { name: `${best.n}, ${best.c}`, km: Math.round(bestKm) } : null;
}

function inUniverse(surface, landPct) {
    if (surface === 'all') return true;
    return surface === 'ocean' ? landPct < LAND_MIN_PCT : landPct >= LAND_MIN_PCT;
}

/**
 * Greedy top-N with a minimum great-circle separation. `rows` must already be
 * sorted best-first.
 */
export function separatedTop(rows, n, sepKm = SEPARATION_KM) {
    const out = [];
    for (const row of rows) {
        if (out.every(o => greatCircleKm(o.lat, o.lon, row.lat, row.lon) >= sepKm)) {
            out.push(row);
            if (out.length === n) break;
        }
    }
    return out;
}

/**
 * The whole lab model for one aggregate snapshot.
 * @param {object} snap     the aggregate (see header)
 * @param {{daily, quantiles, records}} assets   parsed js/temperature-normals.js files
 * @param {{surface?: 'land'|'ocean'|'all', top?: number, region?: string|null}} [opts]
 *        `region` (one of geo-regions REGION_NAMES) narrows the CARDS to that
 *        region and ranks them at REGION_SEPARATION_KM; the planet strip and
 *        the grid never change with it
 */
export function buildLabModel(snap, assets, { surface = 'land', top = DEFAULT_TOP, region = null } = {}) {
    const frameTo = Date.parse(snap?.frame_to);
    if (!Number.isFinite(frameTo)) throw new Error('temperature-lab-model: snapshot has no frame_to');
    const mid = frameTo - WINDOW_HALF_MS;
    const at = (arr, c) => (Array.isArray(arr) && isNum(arr[c]) ? arr[c] : null);

    const cells = new Array(CELLS);
    const anomalyK = new Array(CELLS).fill(null);
    const percentile = new Array(CELLS).fill(null);
    let wAll = 0, wData = 0;
    const acc = { all: [0, 0], land: [0, 0], ocean: [0, 0] };
    const share = { landWeight: 0, top: 0, bottom: 0 };
    let recordHigh = 0, recordLow = 0;

    for (let c = 0; c < CELLS; c++) {
        const { lat, lon } = cellCentre(c);
        const w = Math.cos(lat * Math.PI / 180);
        wAll += w;
        const { landPct, elevM } = cellSurface(assets.daily, c);
        const tmax = at(snap.t24max, c), tmin = at(snap.t24min, c), tmean = at(snap.t24mean, c);
        const posMean = position(assets, c, 'tmean', mid, tmean);
        const posMax = position(assets, c, 'tmax', mid, tmax);
        const posMin = position(assets, c, 'tmin', mid, tmin);
        const land = landPct >= LAND_MIN_PCT;
        cells[c] = { c, lat, lon, landPct, elevM, tmax, tmin, tmean, tnow: at(snap.tnow, c),
                     prev24mean: at(snap.prev24mean, c), posMean, posMax, posMin };
        if (posMean) {
            anomalyK[c] = posMean.anomaly;
            percentile[c] = posMean.percentile;
            wData += w;
            for (const k of ['all', land ? 'land' : 'ocean']) { acc[k][0] += w * posMean.anomaly; acc[k][1] += w; }
            if (land) {
                share.landWeight += w;
                if (posMean.percentile > 90) share.top += w;
                if (posMean.percentile < 10) share.bottom += w;
            }
        }
        if (land && posMax?.beyondRecord === 'high') recordHigh++;
        if (land && posMin?.beyondRecord === 'low') recordLow++;
    }

    const label = (cell) => ({
        cell: cell.c, lat: cell.lat, lon: cell.lon,
        region: labelRegion(cell.lat, cell.lon),
        place: nearestPlace(cell.lat, cell.lon),
        landPct: cell.landPct, elevM: cell.elevM,
    });
    const row = (cell, valueC, pos) => ({
        ...label(cell), valueC,
        normalC: pos?.normal ?? null, anomalyK: pos?.anomaly ?? null,
        percentile: pos?.percentile ?? null, cls: pos?.cls ?? null,
        beyondRecord: pos?.beyondRecord ?? null,
    });
    const pool = cells.filter(x => inUniverse(surface, x.landPct)
        && (!region || labelRegion(x.lat, x.lon) === region));
    const sep = region ? REGION_SEPARATION_KM : SEPARATION_KM;

    const hottest = separatedTop(pool.filter(x => isNum(x.tmax))
        .sort((a, b) => b.tmax - a.tmax).map(x => row(x, x.tmax, x.posMax)), top, sep);
    const coldest = separatedTop(pool.filter(x => isNum(x.tmin))
        .sort((a, b) => a.tmin - b.tmin).map(x => row(x, x.tmin, x.posMin)), top, sep);
    const rare = pool.filter(x => x.posMean);
    const above = separatedTop([...rare]
        .sort((a, b) => (b.posMean.percentile - a.posMean.percentile) || (b.posMean.z - a.posMean.z))
        .map(x => row(x, x.tmean, x.posMean)), top, sep);
    const below = separatedTop([...rare]
        .sort((a, b) => (a.posMean.percentile - b.posMean.percentile) || (a.posMean.z - b.posMean.z))
        .map(x => row(x, x.tmean, x.posMean)), top, sep);
    const swings = separatedTop(pool.filter(x => isNum(x.tmean) && isNum(x.prev24mean))
        .sort((a, b) => Math.abs(b.tmean - b.prev24mean) - Math.abs(a.tmean - a.prev24mean))
        .map(x => ({ ...row(x, x.tmean, x.posMean), changeK: x.tmean - x.prev24mean })), top, sep);

    // The planet strip's extreme points are the planet's: always ALL land,
    // whatever universe or region the cards were asked for.
    let hotCell = null, coldCell = null;
    for (const x of cells) {
        if (x.landPct < LAND_MIN_PCT) continue;
        if (isNum(x.tmax) && (!hotCell || x.tmax > hotCell.tmax)) hotCell = x;
        if (isNum(x.tmin) && (!coldCell || x.tmin < coldCell.tmin)) coldCell = x;
    }
    const mean = ([s, w]) => (w > 0 ? s / w : null);
    const sources = snap.sources && typeof snap.sources === 'object' ? snap.sources : {};
    const fallbackTags = Object.keys(sources).filter(t => isFallbackSource('weather_grid', t));
    return {
        frameTo: new Date(frameTo).toISOString(),
        windowMidpoint: new Date(mid).toISOString(),
        surface,
        region: region || null,
        planet: {
            anomalyK: mean(acc.all), landAnomalyK: mean(acc.land), oceanAnomalyK: mean(acc.ocean),
            coverage: wAll > 0 ? wData / wAll : 0,
            landTopDecile: share.landWeight > 0 ? share.top / share.landWeight : null,
            landBottomDecile: share.landWeight > 0 ? share.bottom / share.landWeight : null,
            decileExpected: 0.10,
            recordHighCells: recordHigh, recordLowCells: recordLow,
            hottest: hotCell ? row(hotCell, hotCell.tmax, hotCell.posMax) : null,
            coldest: coldCell ? row(coldCell, coldCell.tmin, coldCell.posMin) : null,
        },
        cards: { hottest, coldest, above, below, swings },
        grid: { anomalyK, percentile, tmeanC: cells.map(x => x.tmean) },
        disclosure: {
            baseline: 'ERA5 1991–2020 (WMO standard normal)',
            liveField: 'model analysis at sampled grid points, not station observations',
            record: 'beyond 1991–2020 in ERA5 for the date at this grid point',
            window: 'trailing 24 hours of hourly frames',
            fallbackSource: fallbackTags.length > 0,
            fallbackTags,
            note: fallbackTags.length
                ? 'This window includes a coarse fallback field; it understates extremes by several degrees.'
                : null,
        },
    };
}
