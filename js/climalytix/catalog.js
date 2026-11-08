/**
 * climalytix/catalog.js — the dataset catalogue and its PURE adapters.
 * ═══════════════════════════════════════════════════════════════════════════
 * CLIMALYTIX_PLAN.md §5. Each DATASET names its route, what kind of data it
 * is, and the variables it yields; each adapter turns that route's JSON into
 * SiteSeries (series.js) and nothing else. Fetching lives in loaders.js; this
 * file stays node-testable (tests/climalytix-catalog.mjs).
 *
 * P0 SCOPE (2026-11-08): four datasets, all public, all already served by a
 * route on this site except the long-span archive:
 *   era5      /api/climalytix/archive   daily reanalysis since 1940 (bootstrap
 *                                       source until the §17 data engine)
 *   station   /api/weather/forecast?type=lab   the Home Station's own feed:
 *                                       hourly, 1 past day + 3 forecast days
 *   drivers   /api/weather/teleconnections     AO + NAO, 60 daily values
 *   geomag    /api/noaa/ap-history     Ap, observed 3-hourly + SWPC 45-day
 *
 * PANELS. Variables that measure the same quantity share a panel (and so one
 * y axis), so the 85-year record and the 3-day forecast of the same thing sit
 * on one ruler. Within a panel a series' colour is its SLOT, bound to the
 * series id in this table — never to its position on screen (the dataviz
 * identity rule; the meteogram's colour order is the precedent).
 */

import { makeSeries, num, HOUR_MS, DAY_MS } from './series.js';

/** Panels in display order: id, title, the lab-units quantity they plot. */
export const PANELS = Object.freeze([
    { id: 'temp',     title: 'Temperature',          quantity: 'temp' },
    { id: 'precip',   title: 'Precipitation',        quantity: 'precip' },
    { id: 'wind',     title: 'Wind',                 quantity: 'wind' },
    { id: 'pressure', title: 'Sea-level pressure',   quantity: 'pressure' },
    { id: 'humidity', title: 'Humidity & cloud',     quantity: 'pct' },
    { id: 'et0',      title: 'Reference evapotranspiration', quantity: 'precip' },
    { id: 'drivers',  title: 'Climate drivers (AO · NAO)',   quantity: 'index' },
    { id: 'geomag',   title: 'Geomagnetic activity (Ap)',    quantity: 'index' },
]);

/**
 * Datasets. `variables[].slot` is the series' colour slot inside its panel
 * (0–3). `defaultOn` series are drawn on first visit.
 */
export const DATASETS = Object.freeze([
    {
        id: 'era5', label: 'ERA5 reanalysis (daily)', kind: 'reanalysis',
        route: '/api/climalytix/archive',
        source: 'Open-Meteo historical API (ERA5 / ERA5-Land) — bootstrap source',
        resKm: 25,
        variables: [
            { key: 'tmax',    label: 'Daily high (ERA5)',  panel: 'temp',   quantity: 'temp',   agg: 'max',  slot: 0, defaultOn: true },
            { key: 'tmin',    label: 'Daily low (ERA5)',   panel: 'temp',   quantity: 'temp',   agg: 'min',  slot: 1, defaultOn: true },
            { key: 'tmean',   label: 'Daily mean (ERA5)',  panel: 'temp',   quantity: 'temp',   agg: 'mean', slot: 2, defaultOn: false },
            { key: 'precip',  label: 'Daily total (ERA5)', panel: 'precip', quantity: 'precip', agg: 'sum',  slot: 0, defaultOn: true },
            { key: 'windmax', label: 'Max wind (ERA5)',    panel: 'wind',   quantity: 'wind',   agg: 'max',  slot: 0, defaultOn: false },
            { key: 'gustmax', label: 'Max gust (ERA5)',    panel: 'wind',   quantity: 'wind',   agg: 'max',  slot: 1, defaultOn: false },
            { key: 'et0',     label: 'ET₀ FAO-56 (ERA5)',  panel: 'et0',    quantity: 'precip', agg: 'sum',  slot: 0, defaultOn: false },
        ],
    },
    {
        id: 'station', label: 'Home Station feed (hourly)', kind: 'forecast',
        route: '/api/weather/forecast?type=lab',
        source: 'Open-Meteo forecast API (best-match NWP) via the Climate Lab feed',
        resKm: 11,
        variables: [
            { key: 'tempC',    label: 'Temperature (NWP)', panel: 'temp',     quantity: 'temp',     agg: 'mean', slot: 3, defaultOn: true },
            { key: 'precipMm', label: 'Hourly (NWP)',      panel: 'precip',   quantity: 'precip',   agg: 'sum',  slot: 1, defaultOn: true },
            { key: 'windMs',   label: 'Wind (NWP)',        panel: 'wind',     quantity: 'wind',     agg: 'mean', slot: 2, defaultOn: true },
            { key: 'gustMs',   label: 'Gusts (NWP)',       panel: 'wind',     quantity: 'wind',     agg: 'max',  slot: 3, defaultOn: true },
            { key: 'mslHpa',   label: 'MSL pressure (NWP)', panel: 'pressure', quantity: 'pressure', agg: 'mean', slot: 0, defaultOn: true },
            { key: 'rhPct',    label: 'Relative humidity (NWP)', panel: 'humidity', quantity: 'pct', agg: 'mean', slot: 0, defaultOn: false },
            { key: 'cloudPct', label: 'Cloud cover (NWP)', panel: 'humidity', quantity: 'pct',     agg: 'mean', slot: 1, defaultOn: false },
        ],
    },
    {
        id: 'drivers', label: 'Climate drivers', kind: 'index',
        route: '/api/weather/teleconnections',
        source: 'NOAA CPC daily AO + NAO (normalised)',
        resKm: null,
        variables: [
            { key: 'ao',  label: 'Arctic Oscillation',       panel: 'drivers', quantity: 'index', agg: 'mean', slot: 0, defaultOn: true },
            { key: 'nao', label: 'North Atlantic Oscillation', panel: 'drivers', quantity: 'index', agg: 'mean', slot: 1, defaultOn: true },
        ],
    },
    {
        id: 'geomag', label: 'Space weather', kind: 'observed',
        route: '/api/noaa/ap-history',
        source: 'NOAA SWPC planetary K → Ap; SWPC 45-day Ap forecast',
        resKm: null,
        variables: [
            { key: 'apObs',  label: 'Ap observed',          panel: 'geomag', quantity: 'index', agg: 'mean', slot: 0, defaultOn: true },
            { key: 'apPred', label: 'Ap 45-day (SWPC)',     panel: 'geomag', quantity: 'index', agg: 'mean', slot: 1, defaultOn: true },
        ],
    },
]);

const DATASET_BY_ID = new Map(DATASETS.map((d) => [d.id, d]));

/** All variable ids, `dataset.key`. */
export const SERIES_IDS = Object.freeze(
    DATASETS.flatMap((d) => d.variables.map((v) => `${d.id}.${v.key}`)));

/** Variable spec by series id. */
export function variableSpec(seriesId) {
    const [ds, key] = String(seriesId).split('.');
    const d = DATASET_BY_ID.get(ds);
    const v = d?.variables.find((x) => x.key === key);
    return v ? { dataset: d, ...v, id: `${d.id}.${v.key}` } : null;
}

function seriesFor(datasetId, key, { t, v, cadenceMs, kind, issuedAt, provenance, spatial }) {
    const spec = variableSpec(`${datasetId}.${key}`);
    if (!spec) throw new Error(`catalog: unknown series ${datasetId}.${key}`);
    return makeSeries({
        id: spec.id, variable: key, label: spec.label, quantity: spec.quantity,
        kind: kind ?? spec.dataset.kind, agg: spec.agg, cadenceMs,
        t, v, issuedAt, provenance, spatial,
    });
}

const freshnessOf = (j) => (['live', 'stale', 'expired'].includes(j?.freshness) ? j.freshness : 'live');

// ── Adapters (PURE) ─────────────────────────────────────────────────────────

/**
 * /api/climalytix/archive → ERA5 daily series. Daily instants are the site's
 * LOCAL midnight (the route asks for timezone=auto + unixtime).
 */
export function adaptArchive(j, fetchedAt) {
    const D = j?.daily;
    if (!D || !Array.isArray(D.t) || !D.t.length) return { series: [], utcOffsetS: num(j?.site?.utc_offset_seconds) ?? 0 };
    const provenance = {
        source: j.source || DATASET_BY_ID.get('era5').source,
        fetchedAt, freshness: freshnessOf(j), note: j.note ?? null,
    };
    const spatial = { kind: 'cell', resKm: DATASET_BY_ID.get('era5').resKm, distanceKm: num(j?.site?.distance_km) };
    const series = DATASET_BY_ID.get('era5').variables
        .filter((v) => Array.isArray(D[v.key]))
        .map((v) => seriesFor('era5', v.key, { t: D.t, v: D[v.key], cadenceMs: DAY_MS, provenance, spatial }));
    return { series, utcOffsetS: num(j?.site?.utc_offset_seconds) ?? 0, site: j.site ?? null };
}

/**
 * The lab feed, already normalised by js/climate-lab/lab-feed.js
 * normalizeLabResponse (the ONE reader of that response). The forecast has
 * no model run time in this route, so issuedAt is the fetch time — the
 * provenance note says so.
 */
export function adaptStation(obs, fetchedAt) {
    const H = obs?.hourly;
    if (!H || !Array.isArray(H.t) || !H.t.length) return { series: [], utcOffsetS: num(obs?.station?.utcOffsetS) ?? 0 };
    const provenance = {
        source: DATASET_BY_ID.get('station').source, fetchedAt, freshness: 'live',
        note: 'Hours before now are the model’s own recent analysis, not station observations; issue time = fetch time.',
    };
    const spatial = { kind: 'cell', resKm: DATASET_BY_ID.get('station').resKm, distanceKm: null };
    const series = DATASET_BY_ID.get('station').variables
        .filter((v) => Array.isArray(H[v.key]))
        .map((v) => seriesFor('station', v.key, {
            t: H.t, v: H[v.key], cadenceMs: HOUR_MS, issuedAt: fetchedAt, provenance, spatial,
        }));
    return { series, utcOffsetS: num(obs?.station?.utcOffsetS) ?? 0, station: obs.station };
}

/** 'YYYY-MM-DD' → UTC midnight ms (driver indices are global, UTC-dated). */
export function utcDateMs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/** /api/weather/teleconnections → AO + NAO daily index series. */
export function adaptTeleconnections(j, fetchedAt) {
    const provenance = {
        source: j?.source || DATASET_BY_ID.get('drivers').source,
        fetchedAt, freshness: freshnessOf(j), note: 'Global indices — the same value for every site.',
    };
    const spatial = { kind: 'cell', resKm: null, distanceKm: null };
    const series = [];
    for (const key of ['ao', 'nao']) {
        const hist = Array.isArray(j?.[key]?.history) ? j[key].history : [];
        if (!hist.length) continue;
        series.push(seriesFor('drivers', key, {
            t: hist.map((r) => utcDateMs(r?.date)), v: hist.map((r) => num(r?.value)),
            cadenceMs: DAY_MS, provenance, spatial,
        }));
    }
    return { series };
}

/**
 * /api/noaa/ap-history → Ap observed (kind observed) and SWPC 45-day
 * predicted (kind forecast) as two series, so the predicted half can never
 * be read as an observation.
 */
export function adaptApHistory(j, fetchedAt) {
    const rows = Array.isArray(j?.data?.rows) ? j.data.rows : [];
    const provenance = {
        source: j?.source || DATASET_BY_ID.get('geomag').source,
        fetchedAt, freshness: j?.stale ? 'stale' : freshnessOf(j),
        note: 'Ap is planetary: the same value for every site.',
    };
    const spatial = { kind: 'cell', resKm: null, distanceKm: null };
    const split = { observed: { t: [], v: [] }, predicted: { t: [], v: [] } };
    for (const r of rows) {
        const bucket = split[r?.kind];
        const t = Date.parse(r?.t);
        if (!bucket || !Number.isFinite(t)) continue;
        bucket.t.push(t); bucket.v.push(num(r.ap));
    }
    const series = [];
    if (split.observed.t.length) {
        series.push(seriesFor('geomag', 'apObs', { ...split.observed, cadenceMs: 3 * HOUR_MS, kind: 'observed', provenance, spatial }));
    }
    if (split.predicted.t.length) {
        series.push(seriesFor('geomag', 'apPred', {
            ...split.predicted, cadenceMs: 3 * HOUR_MS, kind: 'forecast',
            issuedAt: fetchedAt, provenance, spatial,
        }));
    }
    return { series };
}

// ── Workspace document (local-first; synced through public.dashboards) ────

export const WORKSPACE_VERSION = 1;
export const RANGE_IDS = Object.freeze(['7d', '30d', '1y', '10y', 'all']);

export const DEFAULT_WORKSPACE = Object.freeze({
    v: WORKSPACE_VERSION,
    range: '30d',
    on: Object.freeze(SERIES_IDS.filter((id) => variableSpec(id).defaultOn)),
    units: Object.freeze({ preset: 'auto' }),
    historyFrom: 1991,
});

/**
 * The ONLY reader of a workspace doc (the lab-prefs normalizePrefs rule): a
 * corrupt or future-versioned doc degrades field by field to defaults.
 */
export function normalizeWorkspace(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const on = Array.isArray(r.on) ? [...new Set(r.on.filter((id) => SERIES_IDS.includes(id)))] : [...DEFAULT_WORKSPACE.on];
    const presets = ['auto', 'metric', 'imperial', 'si', 'aviation'];
    const yr = Number.parseInt(r.historyFrom, 10);
    return {
        v: WORKSPACE_VERSION,
        range: RANGE_IDS.includes(r.range) ? r.range : DEFAULT_WORKSPACE.range,
        on,
        units: { preset: presets.includes(r.units?.preset) ? r.units.preset : 'auto' },
        historyFrom: Number.isInteger(yr) ? Math.min(2020, Math.max(1940, yr)) : DEFAULT_WORKSPACE.historyFrom,
    };
}
