/**
 * tests/home-conditions.mjs — node gate for the landing page's Earth-side
 * models: air quality, major-event predictions, temperature dynamics.
 *
 *   node tests/home-conditions.mjs
 *
 * Covers tzGuessLocation, the Open-Meteo normalizers, and the three pure
 * builders in js/home-conditions.js. The year-arc test feeds synthetic
 * sinusoids with a known 35-day solar→temperature offset and requires the
 * builder to recover it — that lag is the feature, not a nuisance.
 */
import assert from 'node:assert/strict';
import {
    tzGuessLocation, aqiCat, normalizeWeather, normalizeAir, normalizeClimate,
    buildAirModel, buildEventsModel, buildTempModel,
} from '../js/home-conditions.js';
import { localDayKey, addDaysNoon } from '../js/temp-outlook.js';

const NOW = Date.UTC(2026, 6, 15, 18, 0, 0); // mid-July, midday US

// ── tz default location ──────────────────────────────────────────────────────
{
    const chi = tzGuessLocation('America/Chicago');
    assert.equal(chi.city, 'Chicago');
    assert.equal(chi.approx, true);
    assert.ok(Math.abs(chi.lat - 41.88) < 0.1);
    assert.equal(tzGuessLocation('Etc/UTC'), null);
    assert.equal(tzGuessLocation(undefined), null);
}

// ── AQI categories ───────────────────────────────────────────────────────────
{
    assert.equal(aqiCat(30).label, 'Good');
    assert.equal(aqiCat(30).level, 0);
    assert.equal(aqiCat(75).level, 1);
    assert.equal(aqiCat(125).level, 2);
    assert.equal(aqiCat(180).level, 3);
    assert.equal(aqiCat(null).label, '—');
}

// ── Normalizers ──────────────────────────────────────────────────────────────
const wxPayload = {
    timezone: 'America/Chicago',
    current: {
        temperature_2m: 88, apparent_temperature: 94, relative_humidity_2m: 60,
        wind_speed_10m: 4, wind_gusts_10m: 9, weather_code: 1, pressure_msl: 1020,
        cloud_cover: 10, precipitation: 0, uv_index: 8, is_day: 1,
    },
    hourly: {
        time: [...Array(48)].map((_, i) => new Date(NOW + i * 3600e3).toISOString()),
        temperature_2m: [...Array(48)].map((_, i) => 80 + 10 * Math.sin(i / 6)),
        precipitation_probability: [...Array(48)].map((_, i) => (i === 20 ? 60 : 5)),
        cape: [...Array(48)].map((_, i) => (i === 20 ? 2800 : 300)),
    },
    // The live call is forecast_days=16&past_days=2: two PAST days lead the
    // arrays (a gust of 80 on day −1 that must never reach the board), then
    // the 7-day board's extremes, then 9 more days carrying a 108° spike on
    // day +12 that is beyond the hero's "7 days out" claim and must be clipped.
    daily: {
        time: [...Array(18)].map((_, i) => new Date(NOW + (i - 2) * 86400e3).toISOString().slice(0, 10)),
        temperature_2m_max: [90, 92, 96, 101, 91, 88, 86, 84, 82, 80, 80, 80, 80, 80, 108, 80, 80, 80],
        temperature_2m_min: [66, 67, 70, 74, 68, 64, 62, 60, 58, 56, 56, 56, 56, 56, 70, 56, 56, 56],
        precipitation_sum: [0, 0, 0, 0.2, 2.4, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        wind_gusts_10m_max: [12, 80, 18, 25, 61, 30, 22, 20, 15, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        weather_code: [0, 0, 1, 2, 95, 61, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        sunrise: [...Array(18)].map((_, i) => new Date(NOW - 7 * 3600e3 + (i - 2) * 86400e3).toISOString()),
        sunset: [...Array(18)].map((_, i) => new Date(NOW + 8 * 3600e3 + (i - 2) * 86400e3).toISOString()),
        uv_index_max: [8, 8, 9, 9, 6, 5, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8],
    },
};
const aqPayload = {
    current: { us_aqi: 132, pm2_5: 48, pm10: 60, ozone: 120, nitrogen_dioxide: 20 },
    hourly: {
        time: [...Array(96)].map((_, i) => new Date(NOW + i * 3600e3).toISOString()),
        us_aqi: [...Array(96)].map((_, i) => 60 + 50 * Math.sin(i / 10) + (i > 60 ? 40 : 0)),
    },
};
const wx = normalizeWeather(wxPayload);
const aq = normalizeAir(aqPayload);
{
    assert.equal(wx.current.tempF, 88);
    assert.equal(wx.hourly.length, 48);
    assert.equal(wx.daily.length, 18);
    assert.equal(wx.daily[4].precipIn, 2.4);
    assert.equal(aq.current.aqi, 132);
    assert.ok(aq.hourly.length === 96);
    assert.equal(normalizeWeather(null), null);
    assert.equal(normalizeAir({}), null);
}

// ── Air model ────────────────────────────────────────────────────────────────
{
    const m = buildAirModel(aq, wx, NOW);
    assert.equal(m.aqi, 132);
    assert.equal(m.cat.level, 2, 'AQI 132 is unhealthy-for-sensitive');
    assert.equal(m.verdict.tone, 'bad');
    assert.ok(m.pollutants.length === 4);
    assert.ok(m.week.length >= 4 && m.week.length <= 7, `week has ${m.week.length} days`);
    assert.ok(m.peak.v >= Math.max(...m.week.map((p) => p.v)) - 1);
    // factor signs: calm wind (4 mph) → dispersal weak-negative; high pressure + calm → stagnation positive
    const disp = m.factors.find((f) => f.name === 'Wind dispersal');
    const stag = m.factors.find((f) => f.name === 'Stagnation');
    assert.ok(disp.v <= 0, 'dispersal always pushes down');
    assert.ok(stag.v > 0, 'calm + high pressure must read as stagnation');

    // clean-air path: strong wind, good AQI
    const clean = buildAirModel(
        { current: { aqi: 28, pm25: 4, pm10: 9, o3: 60, no2: 6 }, hourly: [] },
        { current: { ...wx.current, windMph: 15, uv: 3 }, hourly: [], daily: [] }, NOW);
    assert.equal(clean.cat.label, 'Good');
    assert.equal(clean.verdict.tone, 'good');

    // missing feeds never crash
    const empty = buildAirModel(null, null, NOW);
    assert.equal(empty.aqi, null);
    assert.equal(empty.verdict.tone, 'na');
}

// ── Events model ─────────────────────────────────────────────────────────────
{
    // Quiet: no wx, quiet space
    const quiet = buildEventsModel({}, null, NOW);
    assert.equal(quiet.quiet, true);
    assert.match(quiet.topLine, /quiet/i);

    // Loaded board: CME + G-storm forecast + terrestrial extremes
    const sw = {
        earth_directed_cme: { time: '2026-07-14T02:00Z' }, cme_eta_hours: 18,
        kp_forecast: [
            { time: new Date(NOW + 30 * 3600e3), kp: 6.7, kind: 'predicted' },
            { time: new Date(NOW + 6 * 3600e3), kp: 4.0, kind: 'predicted' },
        ],
        sep_storm_level: 1,
    };
    const m = buildEventsModel(sw, wx, NOW);
    assert.equal(m.quiet, false);
    const ids = m.events.map((e) => e.id);
    for (const want of ['cme', 'gstorm', 'sep', 'tstorm', 'rain', 'wind', 'heat']) {
        assert.ok(ids.includes(want), `missing event ${want} in ${ids}`);
    }
    const g = m.events.find((e) => e.id === 'gstorm');
    assert.equal(g.name, 'G2 geomagnetic storm');
    assert.equal(g.when, NOW + 30 * 3600e3, 'G-storm event carries the forecast peak time');
    const t = m.events.find((e) => e.id === 'tstorm');
    assert.equal(t.level, 3, 'CAPE 2800 is high');
    const w = m.events.find((e) => e.id === 'wind');
    assert.equal(w.level, 3, '61 mph gusts are damaging-wind — not the 80 mph on the PAST day');
    assert.ok(w.when > NOW, 'the wind event is in the future');
    const heat = m.events.find((e) => e.id === 'heat');
    assert.equal(heat.magnitude, '101°F high', 'the 108° spike on day +12 is beyond the 7-day board');
    // severity ordering: no lower level before a higher one
    for (let i = 1; i < m.events.length; i++) {
        assert.ok(m.events[i].level <= m.events[i - 1].level, 'events sorted by severity');
    }
    // every event is readable
    assert.ok(m.events.every((e) => e.note.length > 25 && e.magnitude.length > 2));

    // no heat event in a mild week
    const mild = buildEventsModel({}, {
        ...wx,
        hourly: wx.hourly.map((h) => ({ ...h, cape: 100 })),
        daily: wx.daily.map((d) => ({ ...d, hiF: 75, loF: 55, precipIn: 0, gustMph: 12 })),
    }, NOW);
    assert.equal(mild.quiet, true);
}

// ── Temperature model + year arc lag recovery ────────────────────────────────
{
    const m = buildTempModel(wx, null, NOW);
    assert.equal(m.available, true);
    assert.equal(m.tempF, 88);
    assert.equal(m.hiF, 96, "today's high is found by date, not by array index (past_days lead the array)");
    assert.ok(m.spark.length >= 20, '24 h sparkline data present');
    assert.equal(m.week.length, 7, 'the week is 7 forward days out of the 18-day payload');
    assert.ok(m.week.every((d) => d.t > NOW - 12 * 3600e3));
    assert.equal(m.arc, null, 'no arc without climate data');
    // Candles: the hourly fixture starts at NOW (not midnight) and runs 48 h,
    // so today, tomorrow and the day after have hours — three candles.
    assert.ok(m.candles.candles.length >= 2 && m.candles.candles.length <= 3, `${m.candles.candles.length} candles from a 48 h series`);
    assert.equal(m.candles.candles[0].key, localDayKey(NOW));
    // Outlook: 16 NWP days, then nothing to say without normals.
    assert.equal(m.outlook.days.length, 31);
    assert.equal(m.outlook.nwpLeads, 16);
    assert.equal(m.outlook.days[15].source, 'nwp');
    assert.equal(m.outlook.days[16].source, 'none');
    assert.ok(m.calendar.weeks.length >= 5);
    assert.equal(m.calendar.weeks.flat().filter((c) => !c.pad && c.lead >= 0).length, 31);
    assert.equal(m.clim, null);
    assert.equal(m.persistence, null);

    // Synthetic 3-year climate: solar peaks doy 172, temperature doy 207 → 35-day lag.
    const pts = [];
    for (let d = 0; d < 3 * 365; d++) {
        const t = Date.UTC(2023, 0, 1) + d * 86400e3;
        const doy = Math.floor((t - Date.UTC(new Date(t).getUTCFullYear(), 0, 0)) / 86400e3);
        const tempF = 55 + 28 * Math.cos(2 * Math.PI * (doy - 207) / 365);
        pts.push({
            t, tempF, hiF: tempF + 9, loF: tempF - 9,
            radMJ: 14 + 11 * Math.cos(2 * Math.PI * (doy - 172) / 365),
        });
    }
    const withArc = buildTempModel(wx, { pts }, NOW);
    assert.ok(withArc.arc, 'arc builds from 3 years of dailies');
    assert.ok(Math.abs(withArc.arc.lagDays - 35) <= 4,
        `thermal lag ${withArc.arc.lagDays} should recover ≈35 days`);
    assert.ok(withArc.arc.mean.length > 300);
    // With the archive loaded the outlook runs the full 30 days: NWP, then
    // normal + relaxing anomaly, every cell numeric.
    assert.ok(withArc.clim && withArc.clim.years[0] === 2023);
    assert.ok(withArc.persistence && withArc.persistence.tau >= 1);
    assert.equal(withArc.outlook.days[16].source, 'blend');
    assert.ok(withArc.outlook.days.every((d) => Number.isFinite(d.hiF) && Number.isFinite(d.loF)));
    assert.ok(withArc.outlook.days[30].hiF > withArc.outlook.days[30].loF);
    const forward = withArc.calendar.weeks.flat().filter((c) => !c.pad && c.lead >= 0);
    assert.ok(forward.every((c) => Number.isFinite(c.hiF)), 'every forward calendar cell has a value');
    assert.equal(forward[forward.length - 1].key, localDayKey(addDaysNoon(NOW, 30)));

    assert.equal(buildTempModel(null, null, NOW).available, false);
}

// ── Climate normalizer ───────────────────────────────────────────────────────
{
    const n = 400;
    const j = {
        daily: {
            time: [...Array(n)].map((_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400e3).toISOString().slice(0, 10)),
            temperature_2m_mean: [...Array(n)].map((_, i) => 50 + i % 10),
            temperature_2m_max: [...Array(n)].map((_, i) => (i === 5 ? null : 60 + i % 10)),
            temperature_2m_min: [...Array(n)].map((_, i) => 40 + i % 10),
            shortwave_radiation_sum: [...Array(n)].map(() => 12),
        },
    };
    const c = normalizeClimate(j);
    assert.equal(c.pts.length, n);
    assert.equal(c.pts[0].hiF, 60);
    assert.equal(c.pts[5].hiF, null, 'a missing max is null, never 0 — gaps are not zeros');
    assert.equal(c.pts[5].tempF, 55, 'the mean survives a missing max');
    assert.equal(normalizeClimate({ daily: { time: j.daily.time.slice(0, 100), temperature_2m_mean: j.daily.temperature_2m_mean.slice(0, 100), shortwave_radiation_sum: j.daily.shortwave_radiation_sum.slice(0, 100) } }), null, '< 300 days is not a climate');
    assert.equal(normalizeClimate(null), null);
}

console.log('home-conditions: all assertions passed');
