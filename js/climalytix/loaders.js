/**
 * climalytix/loaders.js — the browser fetch layer: one loader per dataset.
 * ═══════════════════════════════════════════════════════════════════════════
 * Each loader fetches its route and hands the JSON to its PURE adapter in
 * catalog.js; nothing here parses. Every loader resolves (never rejects) to
 *
 *   { id, state: 'live'|'stale'|'down', series: SiteSeries[], note, utcOffsetS?, site? }
 *
 * so one dead feed is one red chip, never a dead page. A degraded 200
 * (`freshness: 'stale'|'expired'`) is 'stale' or 'down' accordingly — a 200
 * is not automatically healthy (the status.html lesson, CLAUDE.md §8).
 *
 * The station loader goes through the Climate Lab's OWN fetch
 * (lab-feed.js fetchLabStation): same route, same cache key, same normaliser
 * as the dashboard's Home Station (plan §15).
 */

import {
    adaptArchive, adaptStation, adaptTeleconnections, adaptApHistory, adaptNwp,
} from './catalog.js';
import { archivePath } from './archive-request.js';
import { nwpPath, fieldPath } from './point-tile.js';
import { aqPath } from './aq-field.js';
import { fetchLabStation } from '../climate-lab/lab-feed.js';

const TIMEOUT_MS = 25_000;

async function getJson(url, signal) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        throw new Error(e?.name === 'AbortError' ? 'timed out' : (e?.message || 'unreachable'));
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
    }
}

const stateOf = (fresh, n) => {
    if (!n) return 'down';
    return fresh === 'live' || fresh == null ? 'live' : 'stale';
};

async function loadEra5(site, ws, signal) {
    const j = await getJson(archivePath({ lat: site.lat, lon: site.lon, fromYear: ws.historyFrom }), signal);
    const out = adaptArchive(j, Date.now());
    const state = j?.freshness === 'expired' ? 'down' : stateOf(j?.freshness, out.series.length);
    const note = state === 'down'
        ? `Archive unavailable${j?.reasons?.length ? ` (${j.reasons.join(', ')})` : ''}`
        : `${j.days?.toLocaleString?.() ?? j.days} days since ${j.from_year} · grid point ${j.site?.distance_km ?? '—'} km away · coverage ${Math.round((j.coverage ?? 0) * 100)} %`;
    return { ...out, state, note };
}

/** Plain-language reasons for our archive's degraded answers. */
const NWP_REASONS = {
    r2_not_configured: 'our archive is not published yet',
    no_run_published: 'no GFS run has been ingested yet',
};
const reasonText = (r) => NWP_REASONS[r] || String(r).replace(/:.*$/, '').replace(/_/g, ' ');

function ageText(s) {
    if (!Number.isFinite(s)) return '';
    const h = s / 3600;
    return h < 48 ? `${Math.round(h)} h old` : `${(h / 24).toFixed(1)} days old`;
}

async function loadGfs(site, _ws, signal) {
    const j = await getJson(nwpPath(site), signal);
    const out = adaptNwp(j, Date.now());
    if (j?.freshness === 'expired' && !out.series.length) {
        const why = (j.reasons || []).map(reasonText).join(', ') || 'unavailable';
        return { ...out, state: 'down', note: `Our archive: ${why}. Nothing is substituted for it.` };
    }
    const state = !out.series.length ? 'down' : j.freshness === 'fresh' ? 'live' : 'stale';
    // The raw u/v hours feed the map's wind rose (airflow.js windRose).
    out.wind = Array.isArray(j?.series?.uMs) && Array.isArray(j?.series?.vMs)
        ? { times: j.times, u: j.series.uMs, v: j.series.vMs } : null;
    const leads = j.leadsH?.length ? `0–${j.leadsH[j.leadsH.length - 1]} h` : '';
    const gaps = j.missing ? ` · ${j.missing} missing field-leads` : '';
    const note = `Run ${j.run} (${ageText(j.age_seconds)}) · ${leads} 3-hourly · bilinear from 4 grid nodes${gaps}`
        + (state === 'stale' ? ' · older than the daily cadence' : '')
        + (j.freshness === 'expired' ? ' · run is past its useful age' : '');
    return { ...out, state, note };
}

async function loadStation(site, _ws, signal) {
    const { obs, fetchedAt } = await fetchLabStation(site.lat, site.lon, { signal });
    const out = adaptStation(obs, fetchedAt);
    return { ...out, state: stateOf('live', out.series.length), note: '1 past day + 3 forecast days, hourly' };
}

async function loadDrivers(_site, _ws, signal) {
    const j = await getJson('/api/weather/teleconnections', signal);
    const out = adaptTeleconnections(j, Date.now());
    return { ...out, state: stateOf(j?.freshness, out.series.length), note: 'Last 60 days · global indices' };
}

async function loadGeomag(_site, _ws, signal) {
    const j = await getJson('/api/noaa/ap-history', signal);
    const out = adaptApHistory(j, Date.now());
    return {
        ...out,
        state: stateOf(j?.stale ? 'stale' : j?.freshness, out.series.length),
        note: 'Observed ~30 days + SWPC 45-day forecast · planetary',
    };
}

export const LOADERS = Object.freeze({
    gfs: loadGfs,
    era5: loadEra5,
    station: loadStation,
    drivers: loadDrivers,
    geomag: loadGeomag,
});

/**
 * The heat-map field around the site, from our archive ONLY. Resolves to
 * { state: 'live'|'stale'|'down', body, note } and never rejects.
 */
export async function loadField(site, { signal } = {}) {
    try {
        const j = await getJson(fieldPath(site), signal);
        if (!j?.values) {
            const why = (j?.reasons || []).map(reasonText).join(', ') || 'unavailable';
            return { state: 'down', body: null, note: `No heat map: ${why}. Nothing is substituted for our archive.` };
        }
        const state = j.freshness === 'fresh' ? 'live' : 'stale';
        return { state, body: j, note: `GFS run ${j.run} (${ageText(j.age_seconds)})${state === 'stale' ? ' · older than the daily cadence' : ''}` };
    } catch (e) {
        return { state: 'down', body: null, note: `No heat map: ${e?.message || 'unreachable'}.` };
    }
}

/**
 * The 10 m wind FIELD around the site from our archive (the airflow layer).
 * Same window and route as the heat field, `vars=uMs,vMs`; nothing stands in
 * for it. Resolves { state, body: { …grid, u, v } | null, note }.
 */
export async function loadWindField(site, { signal } = {}) {
    try {
        // The widest window the route serves: the flow needs room to move.
        const j = await getJson(fieldPath({ ...site, halfDeg: 4, vars: ['uMs', 'vMs'] }), signal);
        if (!j?.fields?.uMs || !j?.fields?.vMs) {
            const why = (j?.reasons || []).map(reasonText).join(', ') || 'unavailable';
            return { state: 'down', body: null, note: `No airflow: ${why}. Nothing is substituted for our archive.` };
        }
        const state = j.freshness === 'fresh' ? 'live' : 'stale';
        return {
            state, body: { ...j, u: j.fields.uMs, v: j.fields.vMs },
            note: `GFS 10 m wind, run ${j.run} (${ageText(j.age_seconds)})${state === 'stale' ? ' · older than the daily cadence' : ''}`,
        };
    } catch (e) {
        return { state: 'down', body: null, note: `No airflow: ${e?.message || 'unreachable'}.` };
    }
}

/**
 * The slope-wind FORCING (plan §19 T3): GFS total cloud and 2 m temperature
 * on the airflow window, fetched on FIRST enable of the layer only. Missing
 * cloud is not substituted with a guess — the kernel assumes CLEAR SKY, which
 * is the UPPER bound on both upslope and downslope flow, and the note says so.
 * Resolves { state, body | null, cloud: bool, note }.
 */
export async function loadSlopeForcing(site, { signal } = {}) {
    try {
        const j = await getJson(fieldPath({ ...site, halfDeg: 4, vars: ['cloudPct', 'tempC'] }), signal);
        if (!j?.fields?.cloudPct) {
            const why = (j?.reasons || []).map(reasonText).join(', ') || 'unavailable';
            return { state: 'partial', body: null, cloud: false,
                note: `No GFS cloud field (${why}): clear sky assumed, so these are UPPER bounds; base temperature 15 °C.` };
        }
        return {
            state: j.freshness === 'fresh' ? 'live' : 'stale', cloud: true,
            body: { ...j, cloud: j.fields.cloudPct, temp: j.fields.tempC ?? null },
            note: `GFS total cloud + 2 m temperature, run ${j.run} (${ageText(j.age_seconds)})`,
        };
    } catch (e) {
        return { state: 'partial', body: null, cloud: false,
            note: `No GFS cloud field (${e?.message || 'unreachable'}): clear sky assumed, so these are UPPER bounds.` };
    }
}

/**
 * The THERMAL inputs (plan §19 T4) from OUR GFS archive on the airflow
 * window: surface sensible heat flux (3 h mean), boundary-layer height,
 * station pressure, 2 m temperature and dew point — fetched on FIRST enable
 * only. A run ingested before these fields existed answers "no variable …";
 * the note says so and nothing is drawn (there is no stand-in for a flux).
 */
export async function loadThermalField(site, { signal } = {}) {
    const vars = ['shflxWm2', 'hpblM', 'psfcHpa', 'tempC', 'dewC'];
    try {
        const j = await getJson(fieldPath({ ...site, halfDeg: 4, vars }), signal);
        if (!vars.every((v) => j?.fields?.[v])) {
            const why = (j?.reasons || []).map(reasonText).join(', ') || 'unavailable';
            const old = (j?.reasons || []).some((r) => /no variable/.test(String(r)));
            return { state: 'down', body: null,
                note: old ? 'Our GFS archive was ingested before the thermal fields existed; they arrive with the next run. Nothing stands in for them.'
                          : `No thermal fields: ${why}. Nothing stands in for them.` };
        }
        const state = j.freshness === 'fresh' ? 'live' : 'stale';
        return { state, body: j, note: `GFS heat flux, boundary layer, pressure, temperature + dew point, run ${j.run} (${ageText(j.age_seconds)})` };
    } catch (e) {
        return { state: 'down', body: null, note: `No thermal fields: ${e?.message || 'unreachable'}. Nothing stands in for them.` };
    }
}

/**
 * The GFS vertical-motion field (plan §19 T5): DZDT at 850 / 700 / 500 hPa
 * plus the station pressure (the below-ground mask) and 2 m temperature (each
 * level's height above the ground) — fetched on FIRST enable only.
 */
export async function loadUpdraftField(site, { signal } = {}) {
    const vars = ['wMs850', 'wMs700', 'wMs500', 'psfcHpa', 'tempC'];
    try {
        const j = await getJson(fieldPath({ ...site, halfDeg: 4, vars }), signal);
        if (!vars.every((v) => j?.fields?.[v])) {
            const why = (j?.reasons || []).map(reasonText).join(', ') || 'unavailable';
            const old = (j?.reasons || []).some((r) => /no variable/.test(String(r)));
            return { state: 'down', body: null,
                note: old ? 'Our GFS archive was ingested before the vertical-motion fields existed; they arrive with the next run. Nothing stands in for them.'
                          : `No vertical-motion field: ${why}. Nothing stands in for it.` };
        }
        return { state: j.freshness === 'fresh' ? 'live' : 'stale', body: j,
                 note: `GFS vertical velocity (DZDT) at 850/700/500 hPa, run ${j.run} (${ageText(j.age_seconds)})` };
    } catch (e) {
        return { state: 'down', body: null, note: `No vertical-motion field: ${e?.message || 'unreachable'}. Nothing stands in for it.` };
    }
}

/**
 * The CAMS air-quality field around the site (BOOTSTRAP source — Open-Meteo's
 * free tier; the page badges it). Resolves { state, body | null, note }.
 */
export async function loadAqField(site, { signal } = {}) {
    try {
        const j = await getJson(aqPath(site), signal);
        if (!j?.fields?.pm25) {
            const why = (j?.reasons || []).join(', ') || 'unavailable';
            return { state: 'down', body: null, note: `No air-quality field: ${why}.` };
        }
        return { state: 'live', body: j, note: 'CAMS global model via Open-Meteo (bootstrap source), 3-hourly, 0.5° window' };
    } catch (e) {
        return { state: 'down', body: null, note: `No air-quality field: ${e?.message || 'unreachable'}.` };
    }
}

/**
 * EPA AirNow monitors for one hour around the site (the site's existing
 * /api/air-quality/stations route). Observations exist only for past hours.
 * Resolves { state, monitors: [{ id, name, lat, lon, pm25, validMs }], note }.
 */
export async function loadMonitors(site, atMs, { signal } = {}) {
    try {
        const url = `/api/air-quality/stations?at=${new Date(atMs).toISOString()}&lat=${site.lat.toFixed(2)}&lon=${site.lon.toFixed(2)}&span=10`;
        const r = await fetch(url, { signal });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) return { state: 'down', monitors: [], note: `Monitors unavailable (${j?.message || `HTTP ${r.status}`}).` };
        if (j.available === false) {
            return { state: 'none', monitors: [], note: j.reason === 'observations_not_forecasts'
                ? 'Monitors report the past only — none for a forecast hour.' : 'No monitor hour this far back.' };
        }
        const validMs = Date.parse(j.frame?.validAt);
        const monitors = (j.frame?.points || [])
            .filter((p) => Number.isFinite(p.pm25) && /UG\/M3/i.test(p.units?.pm25 || 'UG/M3'))
            .map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, pm25: p.pm25, validMs }));
        return { state: monitors.length ? 'live' : 'none', monitors,
                 note: monitors.length ? `EPA AirNow, ${new Date(validMs).toISOString().slice(11, 16)} UTC (preliminary)`
                                       : 'No AirNow PM2.5 monitors in this window (AirNow covers North America).' };
    } catch (e) {
        return { state: 'down', monitors: [], note: `Monitors unavailable (${e?.message || 'unreachable'}).` };
    }
}

/** Run one loader; never rejects. */
export async function loadDataset(id, site, ws, { signal } = {}) {
    const fn = LOADERS[id];
    if (!fn) return { id, state: 'down', series: [], note: 'Unknown dataset' };
    try {
        const r = await fn(site, ws, signal);
        return { id, ...r };
    } catch (e) {
        return { id, state: 'down', series: [], note: `Feed unavailable (${e?.message || 'error'})` };
    }
}
