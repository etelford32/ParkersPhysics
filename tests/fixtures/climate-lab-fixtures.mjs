/**
 * climate-lab-fixtures.mjs — deterministic synthetic feeds for the Climate
 * Lab's node gate (tests/climate-lab.mjs) and browser gate
 * (tests/dashboard-climate-lab.spec.js). CI has no outbound network, and the
 * lab's numbers are only testable if the inputs are known exactly.
 *
 * Every payload mirrors its real upstream's SHAPE (Open-Meteo `lab` type with
 * timeformat=unixtime, Open-Meteo air quality, the ERA5 archive the homepage
 * fetches, a CelesTrak OMM record normalised by api/_lib/omm.js) while its
 * VALUES are physically consistent by construction: dew point is the Magnus
 * inversion of the temperature and RH it ships with, pressure falls at a
 * known rate, the wind veers at a known rate, rain falls in a known band.
 */

import { normalizeOmmRecord } from '../../api/_lib/omm.js';

const HOUR = 3_600_000;
const isNum = Number.isFinite;

/** Magnus (Sonntag 1990) dew point — the same coefficients as composite-indices.js. */
function dewPoint(tC, rh) {
    const a = 17.62, b = 243.12;
    const g = Math.log(rh / 100) + (a * tC) / (b + tC);
    return (b * g) / (a - g);
}

export const STATION = Object.freeze({ lat: 40.015, lon: -105.271, city: 'Boulder, CO', utcOffsetS: -6 * 3600, elevationM: 1624 });

/**
 * Open-Meteo `?type=lab` response around `nowMs`: past 24 h + 72 h ahead,
 * hourly on the hour, station at UTC−6.
 * Design (all exact):
 *   temperature  18 + 8·sin(2π(h_local − 9)/24) °C
 *   RH           55 − 20·sin(…) %  → dew point via Magnus
 *   pressure     1015 − 0.8·(t − now)/h hPa  (falls 2.4 hPa per 3 h)
 *   wind         5 m/s, gust 9 m/s; direction 180 + 5·(t − now)/h ° (veering)
 *   rain         2 mm/h at +6…+8 h (3 hours), pop 80 % there, else 10 %
 */
export function labFixture(nowMs, { station = STATION } = {}) {
    const hourNow = Math.floor(nowMs / HOUR) * HOUR;
    const t0 = hourNow - 24 * HOUR;
    const n = 24 + 72 + 1;
    const H = {
        time: [], temperature_2m: [], relative_humidity_2m: [], dew_point_2m: [], apparent_temperature: [],
        precipitation_probability: [], precipitation: [], weather_code: [], pressure_msl: [], surface_pressure: [],
        cloud_cover: [], cloud_cover_low: [], cloud_cover_mid: [], cloud_cover_high: [], visibility: [],
        wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [], uv_index: [], shortwave_radiation: [],
        is_day: [], soil_temperature_0cm: [], soil_moisture_0_to_1cm: [],
    };
    for (let i = 0; i < n; i++) {
        const t = t0 + i * HOUR;
        const hLocal = ((t + station.utcOffsetS * 1000) / HOUR) % 24;
        const phase = Math.sin(2 * Math.PI * (hLocal - 9) / 24);
        const temp = 18 + 8 * phase;
        const rh = 55 - 20 * phase;
        const dh = (t - hourNow) / HOUR;
        const rain = dh >= 6 && dh <= 8;
        const day = hLocal >= 6.5 && hLocal < 18.5 ? 1 : 0;
        H.time.push(t / 1000);
        H.temperature_2m.push(+temp.toFixed(2));
        H.relative_humidity_2m.push(+rh.toFixed(1));
        H.dew_point_2m.push(+dewPoint(temp, rh).toFixed(2));
        H.apparent_temperature.push(+temp.toFixed(2));
        H.precipitation_probability.push(rain ? 80 : 10);
        H.precipitation.push(rain ? 2 : 0);
        H.weather_code.push(rain ? 63 : 2);
        H.pressure_msl.push(+(1015 - 0.8 * dh).toFixed(2));
        H.surface_pressure.push(+(835 - 0.66 * dh).toFixed(2));
        H.cloud_cover.push(rain ? 95 : 40);
        H.cloud_cover_low.push(rain ? 80 : 10);
        H.cloud_cover_mid.push(30);
        H.cloud_cover_high.push(20);
        H.visibility.push(rain ? 4000 : 24000);
        H.wind_speed_10m.push(5);
        H.wind_direction_10m.push(((180 + 5 * dh) % 360 + 360) % 360);
        H.wind_gusts_10m.push(9);
        H.uv_index.push(day ? +(Math.max(0, 7 * Math.sin(Math.PI * (hLocal - 6.5) / 12))).toFixed(1) : 0);
        H.shortwave_radiation.push(day ? Math.round(Math.max(0, 800 * Math.sin(Math.PI * (hLocal - 6.5) / 12))) : 0);
        H.is_day.push(day);
        H.soil_temperature_0cm.push(+(temp + 2).toFixed(2));
        H.soil_moisture_0_to_1cm.push(0.21);
    }
    // One missing hour (a gap is not a zero): pressure 2 h ago.
    H.pressure_msl[22] = null;

    const iNow = 24;
    const current = { time: nowMs / 1000, interval: 900 };
    for (const k of Object.keys(H)) if (k !== 'time' && k !== 'precipitation_probability') current[k] = H[k][iNow];
    current.pressure_msl = H.pressure_msl[iNow];

    // Daily rows: station-local midnights as instants (unixtime convention).
    const offMs = station.utcOffsetS * 1000;
    const localMidnight = (ms) => Math.floor((ms + offMs) / 86_400_000) * 86_400_000 - offMs;
    const D = {
        time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [],
        sunrise: [], sunset: [], daylight_duration: [], sunshine_duration: [], uv_index_max: [], shortwave_radiation_sum: [],
        et0_fao_evapotranspiration: [], wind_speed_10m_max: [], wind_gusts_10m_max: [], wind_direction_10m_dominant: [],
    };
    for (let d = -1; d <= 3; d++) {
        const m0 = localMidnight(nowMs) + d * 86_400_000;
        D.time.push(m0 / 1000);
        D.temperature_2m_max.push(26); D.temperature_2m_min.push(10);
        D.precipitation_sum.push(d === 0 ? 6 : 0); D.precipitation_probability_max.push(d === 0 ? 80 : 10);
        D.sunrise.push((m0 + 6.5 * HOUR) / 1000); D.sunset.push((m0 + 18.5 * HOUR) / 1000);
        D.daylight_duration.push(12 * 3600); D.sunshine_duration.push(9 * 3600);
        D.uv_index_max.push(7); D.shortwave_radiation_sum.push(18.4); D.et0_fao_evapotranspiration.push(4.1);
        D.wind_speed_10m_max.push(6); D.wind_gusts_10m_max.push(11); D.wind_direction_10m_dominant.push(190);
    }
    return {
        latitude: station.lat, longitude: station.lon, generationtime_ms: 0.4,
        utc_offset_seconds: station.utcOffsetS, timezone: 'America/Denver', timezone_abbreviation: 'MDT',
        elevation: station.elevationM,
        current, hourly: H, daily: D,
    };
}

/** Open-Meteo air-quality payload (unixtime): 24 h past + 48 h ahead, AQI ramps 40 → 130. */
export function airFixture(nowMs) {
    const hourNow = Math.floor(nowMs / HOUR) * HOUR;
    const H = { time: [], us_aqi: [], pm2_5: [], pm10: [], ozone: [], nitrogen_dioxide: [], sulphur_dioxide: [], carbon_monoxide: [], aerosol_optical_depth: [], dust: [] };
    for (let i = -24; i <= 48; i++) {
        const t = hourNow + i * HOUR;
        H.time.push(t / 1000);
        const aqi = i <= 0 ? 40 : Math.min(130, 40 + i * 4);
        H.us_aqi.push(aqi); H.pm2_5.push(8 + Math.max(0, i) * 0.8); H.pm10.push(15); H.ozone.push(60);
        H.nitrogen_dioxide.push(12); H.sulphur_dioxide.push(2); H.carbon_monoxide.push(200);
        H.aerosol_optical_depth.push(0.1); H.dust.push(1);
    }
    return { latitude: STATION.lat, longitude: STATION.lon, utc_offset_seconds: STATION.utcOffsetS, timezone: 'America/Denver', hourly: H,
        hourly_units: { pm2_5: 'μg/m³', pm10: 'μg/m³', ozone: 'μg/m³', nitrogen_dioxide: 'μg/m³', sulphur_dioxide: 'μg/m³', carbon_monoxide: 'μg/m³' } };
}

/**
 * ERA5 archive (the homepage's fetchClimate shape, °F): three years of daily
 * max/min/mean + radiation with a seasonal cycle, ISO dates. The day-of-year
 * high for late September comes out near 76 °F with ±6 °F of noise.
 */
export function archiveFixture(nowMs) {
    const end = new Date(nowMs - 2 * 86_400_000);
    const start = new Date(end.getTime() - 3 * 365 * 86_400_000);
    const D = { time: [], temperature_2m_mean: [], temperature_2m_max: [], temperature_2m_min: [], shortwave_radiation_sum: [] };
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
        const d = new Date(t);
        const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
        const season = Math.cos(2 * Math.PI * (doy - 200) / 365);
        const mean = 52 + 22 * season + rnd() * 12;
        D.time.push(d.toISOString().slice(0, 10));
        D.temperature_2m_mean.push(+mean.toFixed(1));
        D.temperature_2m_max.push(+(mean + 13).toFixed(1));
        D.temperature_2m_min.push(+(mean - 13).toFixed(1));
        D.shortwave_radiation_sum.push(+(16 + 11 * Math.cos(2 * Math.PI * (doy - 172) / 365)).toFixed(2));
    }
    return { latitude: STATION.lat, longitude: STATION.lon, daily: D };
}

/** A normalised ISS-like OMM record (epoch 6 h before `nowMs`), via the real normaliser. */
export function issRecord(nowMs, { norad = 25544, name = 'ISS (ZARYA)' } = {}) {
    return normalizeOmmRecord({
        OBJECT_NAME: name, OBJECT_ID: '1998-067A', NORAD_CAT_ID: norad,
        EPOCH: new Date(nowMs - 6 * HOUR).toISOString().replace('Z', ''),
        MEAN_MOTION: 15.50, ECCENTRICITY: 0.0003, INCLINATION: 51.64,
        RA_OF_ASC_NODE: 120.5, ARG_OF_PERICENTER: 90.0, MEAN_ANOMALY: 270.0,
        EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 999, REV_AT_EPOCH: 50000,
        BSTAR: 0.0003, MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0,
    });
}

export { isNum };
