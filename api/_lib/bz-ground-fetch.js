/**
 * api/_lib/bz-ground-fetch.js — the USGS fan-out for the Bz engine's ground
 * rung: per station one 1-second request (the last hour) and one 1-minute
 * request (24 h, for the baseline). Shared by /api/bz/ground and
 * /api/bz/column. Station codes come from the fixed roster in
 * js/geomag/observatories.js; a station that fails is a DROPOUT, not an error.
 */
import { fetchJson } from './bz-fetch.js';
import { groundSeriesUrl, normalizeGroundSeries } from '../../js/bz/feeds.js';
import { USGS_STATION_IDS } from '../../js/geomag/observatories.js';

const FAST_WINDOW_S = 3600, SLOW_WINDOW_S = 24 * 3600;

/** Fetch + normalise every station at both cadences. */
export async function fetchGround(nowMs) {
    const one = async (id, sp, win) => {
        const r = await fetchJson(groundSeriesUrl(id, sp, win, nowMs));
        return r.ok ? normalizeGroundSeries(r.body, { nowMs, station: id }) : null;
    };
    const fast = {}, slow = {}, failed = [];
    await Promise.all(USGS_STATION_IDS.map(async (id) => {
        const [f, s] = await Promise.all([one(id, 1, FAST_WINDOW_S).catch(() => null), one(id, 60, SLOW_WINDOW_S).catch(() => null)]);
        if (f) fast[id] = f;
        if (s) slow[id] = s;
        if (!f && !s) failed.push(id);
    }));
    return { fast, slow, failed };
}

