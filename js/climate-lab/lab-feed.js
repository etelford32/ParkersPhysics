/**
 * climate-lab/lab-feed.js — the home station's weather feed.
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE request per station: `/api/weather/forecast?type=lab` (the typed edge
 * proxy — see the `lab` spec in api/weather/forecast.js). Every lab visitor
 * at a place shares its 15-minute edge-cache key, and the response is
 * already in the kernel's units (°C, m/s, mm, hPa) so nothing here converts.
 *
 * `normalizeLabResponse` is PURE and node-tested. Its two rules:
 *   · A GAP IS NOT A ZERO. Open-Meteo sends `null` for a missing hour;
 *     `Number(null)` is 0 and finite, which is how the pollution lab once
 *     plotted a missing night as a clean-air night. Every value goes through
 *     `num()`, which keeps null as null.
 *   · TIME IS EPOCH MS. The proxy asks for `timeformat=unixtime`, so hourly
 *     stamps are unambiguous instants and a station in another time zone
 *     needs no local-string parsing. The station's CALENDAR day — which the
 *     daily rows are — comes from `utc_offset_seconds`, never from the
 *     browser's zone (a Tokyo station viewed from Denver is on Tokyo's date).
 */

const WEATHER_API = '/api/weather/forecast';
const FETCH_TIMEOUT_MS = 12_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const HOUR_MS = 3_600_000;

/** Station calendar date "YYYY-MM-DD" for an instant, given its UTC offset. */
export function stationDateKey(ms, utcOffsetS) {
    return new Date(ms + (utcOffsetS || 0) * 1000).toISOString().slice(0, 10);
}

/** Station-local hour of day (0–23.99) for an instant. */
export function stationHour(ms, utcOffsetS) {
    const d = new Date(ms + (utcOffsetS || 0) * 1000);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
}

const HOURLY_MAP = Object.freeze({
    tempC: 'temperature_2m', rhPct: 'relative_humidity_2m', dewC: 'dew_point_2m',
    appC: 'apparent_temperature', pop: 'precipitation_probability',
    precipMm: 'precipitation', code: 'weather_code',
    mslHpa: 'pressure_msl', stationHpa: 'surface_pressure',
    cloudPct: 'cloud_cover', cloudLow: 'cloud_cover_low', cloudMid: 'cloud_cover_mid',
    cloudHigh: 'cloud_cover_high', visM: 'visibility',
    windMs: 'wind_speed_10m', windDir: 'wind_direction_10m', gustMs: 'wind_gusts_10m',
    uvi: 'uv_index', swWm2: 'shortwave_radiation', isDay: 'is_day',
    soilTempC: 'soil_temperature_0cm', soilMoist: 'soil_moisture_0_to_1cm',
});

const DAILY_MAP = Object.freeze({
    highC: 'temperature_2m_max', lowC: 'temperature_2m_min',
    precipMm: 'precipitation_sum', popMax: 'precipitation_probability_max',
    sunrise: 'sunrise', sunset: 'sunset',
    daylightS: 'daylight_duration', sunshineS: 'sunshine_duration',
    uviMax: 'uv_index_max', swSumMJ: 'shortwave_radiation_sum',
    et0Mm: 'et0_fao_evapotranspiration',
    windMaxMs: 'wind_speed_10m_max', gustMaxMs: 'wind_gusts_10m_max',
    windDomDir: 'wind_direction_10m_dominant',
});

/**
 * Open-Meteo `lab` JSON → the lab's observation model. Returns null when the
 * payload carries no hourly time axis (nothing an instrument could read).
 */
export function normalizeLabResponse(j) {
    const H = j?.hourly;
    if (!H || !Array.isArray(H.time) || !H.time.length) return null;
    const utcOffsetS = num(j.utc_offset_seconds) ?? 0;

    const hourly = { t: H.time.map((s) => (num(s) != null ? s * 1000 : null)) };
    for (const [k, src] of Object.entries(HOURLY_MAP)) {
        const arr = Array.isArray(H[src]) ? H[src] : [];
        hourly[k] = hourly.t.map((_, i) => num(arr[i]));
    }

    const C = j.current || {};
    const current = { t: num(C.time) != null ? C.time * 1000 : null };
    for (const [k, src] of Object.entries(HOURLY_MAP)) current[k] = num(C[src]);

    const D = j.daily || {};
    const daily = (Array.isArray(D.time) ? D.time : []).map((s, i) => {
        const row = { t0: num(s) != null ? s * 1000 : null };
        for (const [k, src] of Object.entries(DAILY_MAP)) {
            const v = num(D[src]?.[i]);
            row[k] = (k === 'sunrise' || k === 'sunset') && v != null ? v * 1000 : v;
        }
        // Daily stamps are the station's local midnight as an instant; its
        // date is read in the STATION's offset (see the header).
        row.date = row.t0 != null ? stationDateKey(row.t0 + 12 * HOUR_MS, utcOffsetS) : null;
        return row;
    });

    return {
        station: {
            lat: num(j.latitude), lon: num(j.longitude),
            elevationM: num(j.elevation),
            tz: typeof j.timezone === 'string' ? j.timezone : null,
            tzAbbr: typeof j.timezone_abbreviation === 'string' ? j.timezone_abbreviation : null,
            utcOffsetS,
        },
        current, hourly, daily,
    };
}

/** Index of the last hourly sample at or before `ms` (−1 if none). */
export function hourIndexAt(obs, ms) {
    const t = obs?.hourly?.t || [];
    let idx = -1;
    for (let i = 0; i < t.length; i++) {
        if (t[i] != null && t[i] <= ms) idx = i;
        else if (t[i] != null && t[i] > ms) break;
    }
    return idx;
}

/** The daily row for the station's calendar day containing `ms`. */
export function dayRowAt(obs, ms) {
    const key = stationDateKey(ms, obs?.station?.utcOffsetS);
    return (obs?.daily || []).find((d) => d.date === key) || null;
}

/**
 * Slice every hourly channel to [fromMs, toMs]. Returns the same shape with
 * shorter arrays — the meteogram and the sparklines both read windows.
 */
export function hourlyWindow(obs, fromMs, toMs) {
    const H = obs?.hourly;
    if (!H) return null;
    const keep = [];
    H.t.forEach((t, i) => { if (t != null && t >= fromMs && t <= toMs) keep.push(i); });
    const out = {};
    for (const k of Object.keys(H)) out[k] = keep.map((i) => H[k][i]);
    return out;
}

// ── Browser fetch ───────────────────────────────────────────────────────────

/**
 * Fetch + normalize the station. Resolves to `{ obs, fetchedAt }` or throws
 * an Error whose message is safe to show ("Weather service unavailable
 * (HTTP 503)"). Coordinates are rounded to the proxy's own 3 dp so the
 * browser cache and the edge cache agree on one key.
 */
export async function fetchLabStation(lat, lon, { signal } = {}) {
    const url = `${WEATHER_API}?type=lab&lat=${Number(lat).toFixed(3)}&lon=${Number(lon).toFixed(3)}`;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Weather service unavailable (HTTP ${res.status})`);
        const obs = normalizeLabResponse(await res.json());
        if (!obs) throw new Error('Weather service returned no hourly data');
        return { obs, fetchedAt: Date.now() };
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error('Weather request timed out');
        throw e;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
    }
}
