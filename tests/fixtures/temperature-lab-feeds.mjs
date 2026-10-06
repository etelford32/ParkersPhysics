/**
 * tests/fixtures/temperature-lab-feeds.mjs — hermetic feeds for the
 * Planetary Temperature Lab's browser gates.
 *
 * The snapshot is NOT hand-typed: it is the REAL js/temperature-lab-model.js
 * run on the shipped normals (a planet sitting exactly on its 1991–2020
 * normal, then a few cells nudged by known amounts) and encoded by the REAL
 * api/_lib/temperature-snapshot.js. So the page is tested against the shape
 * the route actually serves, and every expected row is known in closed form.
 *
 * Open-Meteo (forecast + air quality + archive) is mocked with the same
 * shapes tests/home-temp-outlook.spec.js uses, because the lab reads the
 * place through the homepage's own js/home-conditions.js.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CELLS, cellIndex, dailyNormal, parseNormalsAsset } from '../../js/temperature-normals.js';
import { buildLabModel } from '../../js/temperature-lab-model.js';
import { encodeResponse, freshnessOf } from '../../api/_lib/temperature-snapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (n) => parseNormalsAsset(new Uint8Array(readFileSync(join(ROOT, 'assets', 'temperature', n))));
let assets = null;
const getAssets = () => (assets ??= {
    daily: load('normals-1991-2020.bin'), quantiles: load('quantiles-1991-2020.bin'), records: load('records-1991-2020.bin'),
});

/** The nudged cells, so a spec can assert on them by name. */
export const NUDGES = Object.freeze({
    sahara: { lat: 22.5, lon: 12.5, t24max: +9 },          // hottest + beyond record
    yakutia: { lat: 62.5, lon: 127.5, t24min: -14 },        // a cold anomaly
    congo: { lat: 2.5, lon: 22.5, t24meanSd: 2.6 },         // a RARE small departure
    plains: { lat: 42.5, lon: -97.5, prevDelta: 14 },       // a 14 K day-over-day drop
});

/**
 * A snapshot body for `frameTo`. `sources` controls the fallback disclosure.
 * @param {{frameTo?: string, sources?: object, query?: {surface?: string, region?: string|null}}} [o]
 */
export function snapshotBody({ frameTo = new Date(Date.now() - 40 * 60e3).toISOString(),
                               sources = { 'open-meteo:72x36': 24 }, query = {} } = {}) {
    const a = getAssets();
    const mid = Date.parse(frameTo) - 11.5 * 3600e3;
    const snap = { computed_at: frameTo, frame_from: new Date(Date.parse(frameTo) - 23 * 3600e3).toISOString(),
                   frame_to: frameTo, n_frames: 24, sources,
                   t24max: [], t24min: [], t24mean: [], tnow: [], prev24mean: [] };
    for (let c = 0; c < CELLS; c++) {
        const dn = dailyNormal(a.daily, c, mid);
        snap.t24max.push(dn.tmax.mean); snap.t24min.push(dn.tmin.mean);
        snap.t24mean.push(dn.tmean.mean); snap.tnow.push(dn.tmean.mean); snap.prev24mean.push(dn.tmean.mean);
    }
    // Spread departures across the planet so every card has 25 rows to rank
    // (a planet exactly on its normal ties every percentile at ~50).
    for (let c = 0; c < CELLS; c++) {
        const w = Math.sin(c * 0.37) * 1.6 + Math.cos(c * 0.011) * 0.8;
        snap.t24mean[c] += w; snap.t24max[c] += w; snap.t24min[c] += w;
        snap.prev24mean[c] += Math.sin(c * 1.3) * 2;
    }
    const at = (n) => cellIndex(n.lat, n.lon);
    snap.t24max[at(NUDGES.sahara)] += NUDGES.sahara.t24max;
    snap.t24min[at(NUDGES.yakutia)] += NUDGES.yakutia.t24min;
    snap.t24mean[at(NUDGES.yakutia)] += NUDGES.yakutia.t24min / 2;
    const sd = dailyNormal(a.daily, at(NUDGES.congo), mid).tmean.sd;
    snap.t24mean[at(NUDGES.congo)] += NUDGES.congo.t24meanSd * sd + 0.2;
    snap.prev24mean[at(NUDGES.plains)] = snap.t24mean[at(NUDGES.plains)] + NUDGES.plains.prevDelta;

    const model = buildLabModel(snap, a, { surface: query.surface || 'land', region: query.region || null });
    const fresh = freshnessOf({ snapshot: snap, model, normalsOk: true, nowMs: Date.now() });
    return encodeResponse({ snapshot: snap, model, fresh });
}

/** The route's answer before the migration is applied. */
export function expiredBody() {
    return {
        freshness: 'expired', reasons: ['no-aggregate'], updated: null, window: null, sources: {},
        planet: null, cards: null, grid: null, disclosure: null,
        note: 'temperature_lab_cache unreadable (Supabase 404) — is supabase-temperature-lab-migration.sql applied?',
    };
}

// ── Open-Meteo, the homepage spec's shapes ──────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcMidnight = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export function wxFixture(now) {
    const day0 = utcMidnight(new Date(now)) - 2 * 86400e3;
    const hourly = { time: [], temperature_2m: [], precipitation_probability: [], cape: [] };
    for (let i = 0; i < 18 * 24; i++) {
        const t = new Date(day0 + i * 3600e3);
        const h = t.getUTCHours();
        hourly.time.push(`${isoDay(t)}T${pad(h)}:00`);
        hourly.temperature_2m.push(Math.round((62 + 9 * Math.sin(2 * Math.PI * (h - 9) / 24)) * 10) / 10);
        hourly.precipitation_probability.push(5);
        hourly.cape.push(200);
    }
    const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], wind_gusts_10m_max: [], weather_code: [], sunrise: [], sunset: [], uv_index_max: [] };
    for (let i = 0; i < 18; i++) {
        const d = new Date(day0 + i * 86400e3);
        daily.time.push(isoDay(d));
        daily.temperature_2m_max.push(74 + (i % 3));
        daily.temperature_2m_min.push(51 - (i % 3));
        daily.precipitation_sum.push(0);
        daily.wind_gusts_10m_max.push(14);
        daily.weather_code.push(1);
        daily.sunrise.push(`${isoDay(d)}T06:40`);
        daily.sunset.push(`${isoDay(d)}T19:00`);
        daily.uv_index_max.push(6);
    }
    return {
        timezone: 'UTC',
        current: { temperature_2m: 66, apparent_temperature: 65, relative_humidity_2m: 48, wind_speed_10m: 7, wind_gusts_10m: 12, weather_code: 1, pressure_msl: 1016, cloud_cover: 20, precipitation: 0, uv_index: 4, is_day: 1 },
        hourly, daily,
    };
}

export function aqFixture(now) {
    const day0 = utcMidnight(new Date(now));
    const time = [], us_aqi = [];
    for (let i = 0; i < 7 * 24; i++) {
        const t = new Date(day0 + i * 3600e3);
        time.push(`${isoDay(t)}T${pad(t.getUTCHours())}:00`);
        us_aqi.push(35);
    }
    return { current: { us_aqi: 38, pm2_5: 6, pm10: 11, ozone: 60, nitrogen_dioxide: 8 }, hourly: { time, us_aqi } };
}

export function archiveFixture(now) {
    const end = utcMidnight(new Date(now)) - 2 * 86400e3;
    const out = { time: [], temperature_2m_mean: [], temperature_2m_max: [], temperature_2m_min: [], shortwave_radiation_sum: [] };
    for (let i = 3 * 365 - 1; i >= 0; i--) {
        const d = new Date(end - i * 86400e3);
        const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3);
        const mean = 55 + 25 * Math.cos(2 * Math.PI * (doy - 205) / 365) + 3 * Math.sin(i / 2.3);
        out.time.push(isoDay(d));
        out.temperature_2m_mean.push(Math.round(mean * 10) / 10);
        out.temperature_2m_max.push(Math.round((mean + 10) * 10) / 10);
        out.temperature_2m_min.push(Math.round((mean - 10) * 10) / 10);
        out.shortwave_radiation_sum.push(Math.round((14 + 11 * Math.cos(2 * Math.PI * (doy - 172) / 365)) * 10) / 10);
    }
    return { daily: out };
}
