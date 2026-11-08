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
