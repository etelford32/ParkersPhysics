/**
 * tests/temp-outlook.mjs — node gate for the temperature outlook kernel.
 *
 *   node tests/temp-outlook.mjs
 *
 * Pins js/temp-outlook.js: the week candles (open = first hour, close = last,
 * wick = true extreme, direction from the end-to-end change), the circular
 * day-of-year climatology, the anomaly persistence FIT (a synthetic AR(1)
 * with a known τ must be recovered — that fit is the one thing the v0 engine
 * learns from history), the v0 projection tiers and its relaxation toward
 * the normal, and the calendar grid geometry. Everything is built with local
 * Date constructors so the gate is timezone-independent.
 */
import assert from 'node:assert/strict';
import {
    localDayKey, localNoon, addDaysNoon, dayOfYearLocal,
    buildWeekCandles, climatologyByDoy, climAt, anomalyPersistence,
    projectDays, buildMonthCalendar, DEFAULT_TAU_DAYS, MAX_NWP_LEAD, NEAR_LEAD_MAX,
} from '../js/temp-outlook.js';

// 2026-09-21 14:30 local — a Monday, three weeks into a month, so the
// 30-day window crosses a month boundary.
const NOW = new Date(2026, 8, 21, 14, 30).getTime();
const H = 3600e3, D = 86400e3;

function mulberry32(a) {
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Calendar helpers ─────────────────────────────────────────────────────────
{
    assert.equal(localDayKey(NOW), '2026-09-21');
    assert.equal(localDayKey(addDaysNoon(NOW, 10)), '2026-10-01', 'addDaysNoon crosses the month end');
    assert.equal(new Date(localNoon(NOW)).getHours(), 12);
    assert.equal(dayOfYearLocal(new Date(2026, 0, 1).getTime()), 0);
    assert.equal(dayOfYearLocal(new Date(2026, 11, 31).getTime()), 364);
    assert.equal(dayOfYearLocal(new Date(2024, 11, 31).getTime()), 365, 'leap year reaches doy 365');
}

// ── Week candles ─────────────────────────────────────────────────────────────
// Hourly series shaped like Open-Meteo with past_days=2: starts two days ago
// at 00:00 local, 16 forecast days. Temperature: a diurnal wave on a slow
// warming ramp so every candle's direction is predictable.
const hourly = [];
{
    const start = new Date(2026, 8, 19, 0).getTime();
    for (let i = 0; i < 18 * 24; i++) {
        const t = start + i * H;
        const h = new Date(t).getHours();
        const dayIdx = Math.floor(i / 24);
        // Even days warm across midnight, odd days cool: a ramp that flips sign per day.
        const ramp = (dayIdx % 2 === 0 ? 1 : -1) * (h / 23) * 4;
        hourly.push({ t, tempF: 60 + 10 * Math.sin(2 * Math.PI * (h - 9) / 24) + ramp + dayIdx * 0.5 });
    }
}
const daily = [];
for (let i = -2; i < 16; i++) {
    const t = addDaysNoon(NOW, i);
    daily.push({ t, hiF: 72 + i * 0.5, loF: 49 + i * 0.5 });
}
{
    const wk = buildWeekCandles({ hourly, daily }, NOW);
    assert.equal(wk.candles.length, 7, 'one candle per day of the week');
    assert.equal(wk.candles[0].key, '2026-09-21', 'the week starts today, not at the past_days head');
    assert.equal(wk.candles[6].key, '2026-09-27');
    assert.ok(wk.hours.every((h) => h.t >= wk.start && h.t < wk.end), 'the line is clipped to the week');
    // 7 × 24 ± 1: a DST transition inside the week makes it 167 or 169 wall-clock
    // hours (NZ springs forward on 2026-09-27), and the window is honest about it.
    assert.ok(Math.abs(wk.hours.length - 7 * 24) <= 1, `${wk.hours.length} hours in the week`);
    const c0 = wk.candles[0];
    const midnight = hourly.find((h) => localDayKey(h.t) === '2026-09-21' && new Date(h.t).getHours() === 0);
    const eleven = hourly.find((h) => localDayKey(h.t) === '2026-09-21' && new Date(h.t).getHours() === 23);
    assert.equal(c0.open, midnight.tempF, 'open is the first hour of the day');
    assert.equal(c0.close, eleven.tempF, 'close is the last hour of the day');
    assert.ok(c0.observedHours >= 14 && c0.observedHours <= 15, `today has ${c0.observedHours} observed hours at 14:30`);
    // Wick never narrower than the line, and takes the daily extreme when wider.
    for (const c of wk.candles) {
        const hs = hourly.filter((h) => localDayKey(h.t) === c.key).map((h) => h.tempF);
        assert.ok(c.high >= Math.max(...hs) - 1e-9 && c.low <= Math.min(...hs) + 1e-9, `wick contains the line on ${c.key}`);
        const d = daily.find((x) => localDayKey(x.t) === c.key);
        assert.ok(c.high >= d.hiF && c.low <= d.loF, `wick reaches the daily extreme on ${c.key}`);
    }
    // Direction alternates with the ramp sign: day index 2 (today) is even → warming.
    assert.equal(c0.dir, 'warming');
    assert.equal(wk.candles[1].dir, 'cooling');
    assert.ok(wk.candles[0].deltaF > 0 && wk.candles[1].deltaF < 0);
    assert.ok(wk.tMax > wk.tMin);

    // Daily-only payload → no candles, no throw.
    const none = buildWeekCandles({ hourly: [], daily }, NOW);
    assert.equal(none.candles.length, 0);
    assert.equal(buildWeekCandles(null, NOW).candles.length, 0);
}

// ── Climatology + persistence fit ────────────────────────────────────────────
// Three years of dailies: annual sinusoid (mean 55, amplitude 25, peak late
// July) with hi/lo ±10 around it, plus an AR(1) anomaly of known τ.
const TAU_TRUE = 4.5;
const R1_TRUE = Math.exp(-1 / TAU_TRUE);
const SIGMA_TRUE = 6;
const archive = [];
{
    const rnd = mulberry32(7);
    const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    let a = 0;
    const innov = SIGMA_TRUE * Math.sqrt(1 - R1_TRUE * R1_TRUE);
    // 3 years + 2 days: the last archive day is Sept 19 (production lags ~2 days).
    for (let i = 0; i < 3 * 365 + 2; i++) {
        const t = addDaysNoon(new Date(2023, 8, 19, 12).getTime(), i);
        const doy = dayOfYearLocal(t);
        a = R1_TRUE * a + innov * gauss();
        const mean = 55 + 25 * Math.cos(2 * Math.PI * (doy - 205) / 365) + a;
        archive.push({ t, tempF: mean, hiF: mean + 10, loF: mean - 10, radMJ: 14 });
    }
}
let clim, pers;
{
    clim = climatologyByDoy(archive);
    assert.ok(clim, 'climatology builds from 3 years');
    assert.equal(clim.byDoy.length, 366);
    assert.deepEqual(clim.years, [2023, 2026]);
    const c = climAt(clim, NOW);
    const doy = dayOfYearLocal(NOW);
    const expect = 55 + 25 * Math.cos(2 * Math.PI * (doy - 205) / 365);
    assert.ok(Math.abs(c.mean - expect) < 2.5, `normal mean ${c.mean.toFixed(1)} ≈ ${expect.toFixed(1)}`);
    assert.ok(Math.abs(c.hi - (expect + 10)) < 2.5 && Math.abs(c.lo - (expect - 10)) < 2.5);
    assert.ok(c.n >= 40, `±7-day window pools ${c.n} samples per date`);
    // Circular smoothing: Dec 31 and Jan 1 are neighbours, not a cliff.
    const dec31 = clim.byDoy[364].mean, jan1 = clim.byDoy[0].mean;
    assert.ok(Math.abs(dec31 - jan1) < 1.5, `year wrap is continuous (${dec31.toFixed(1)} vs ${jan1.toFixed(1)})`);
    assert.equal(climatologyByDoy(archive.slice(0, 30)), null, 'too little history → null');
    assert.equal(climAt(null, NOW), null);

    pers = anomalyPersistence(archive, clim);
    assert.ok(pers, 'persistence fits');
    assert.ok(Math.abs(pers.tau - TAU_TRUE) < 1.2, `recovered τ ${pers.tau.toFixed(2)} ≈ ${TAU_TRUE}`);
    assert.ok(Math.abs(pers.sigmaF - SIGMA_TRUE) < 1.5, `recovered σ ${pers.sigmaF.toFixed(2)} ≈ ${SIGMA_TRUE}`);
    assert.ok(pers.r1 > 0.7 && pers.r1 < 0.9);
    assert.equal(anomalyPersistence(archive, null), null);
}

// ── v0 projection ────────────────────────────────────────────────────────────
{
    // NWP runs +8° warm against the normal in its last days, so the tail
    // anomaly is large and the relaxation is visible.
    const warm = daily.map((d) => {
        const c = climAt(clim, d.t);
        return { t: d.t, hiF: c.hi + 8, loF: c.lo + 8 };
    });
    const p = projectDays({ daily: warm, clim, persistence: pers, now: NOW, days: 30 });
    assert.equal(p.days.length, 31, 'today through +30');
    assert.equal(p.nwpLeads, MAX_NWP_LEAD + 1);
    assert.equal(p.days[0].key, '2026-09-21');
    assert.equal(p.days[30].key, '2026-10-21');
    for (let i = 0; i <= MAX_NWP_LEAD; i++) {
        assert.equal(p.days[i].source, 'nwp');
        assert.equal(p.days[i].tier, i <= NEAR_LEAD_MAX ? 'nwp-near' : 'nwp-ext');
        assert.ok(Math.abs(p.days[i].anomF - 8) < 1e-9, 'NWP anomaly is measured against the normal');
    }
    for (let i = MAX_NWP_LEAD + 1; i <= 30; i++) assert.equal(p.days[i].source, 'blend');
    assert.ok(Math.abs(p.tailAnomalyF - 8) < 1e-9);
    assert.ok(Math.abs(p.tau - pers.tau) < 1e-12, 'the fitted τ drives the relaxation');
    // Relaxation: anomaly falls monotonically toward 0 and σ grows toward the climatological σ.
    const blend = p.days.slice(MAX_NWP_LEAD + 1);
    for (let i = 1; i < blend.length; i++) {
        assert.ok(blend[i].anomF < blend[i - 1].anomF, 'anomaly decays');
        assert.ok(blend[i].sigmaF >= blend[i - 1].sigmaF, 'expected miss grows with lead');
    }
    assert.ok(blend[0].anomF > 5, `day 17 still carries most of the tail anomaly (${blend[0].anomF.toFixed(1)})`);
    assert.ok(blend[blend.length - 1].anomF < 0.5, `day 30 is nearly the normal (${blend[blend.length - 1].anomF.toFixed(2)})`);
    assert.ok(Math.abs(blend[blend.length - 1].sigmaF - pers.sigmaF) < 0.05, 'σ saturates at the anomaly σ');
    assert.ok(blend[0].hiF > blend[0].loF);

    // No climatology yet: NWP days present, the rest 'none'.
    const noClim = projectDays({ daily: warm, clim: null, persistence: null, now: NOW });
    assert.equal(noClim.days[3].source, 'nwp');
    assert.equal(noClim.days[3].anomF, null);
    assert.equal(noClim.days[20].source, 'none');
    assert.equal(noClim.tau, DEFAULT_TAU_DAYS);

    // No NWP (weather feed down) but a climatology: the bare normal, ρ = 0.
    const climOnly = projectDays({ daily: [], clim, persistence: pers, now: NOW });
    assert.equal(climOnly.nwpLeads, 0);
    assert.ok(climOnly.days.every((d) => d.source === 'blend' && d.rho === 0));
    assert.ok(Math.abs(climOnly.days[5].anomF) < 1e-9, 'without NWP the outlook is the normal itself');
    assert.equal(climOnly.tailAnomalyF, null);

    // Past days in `daily` (past_days=2) are ignored, never mapped to a lead.
    assert.equal(p.days[0].hiF, warm.find((d) => localDayKey(d.t) === '2026-09-21').hiF);
}

// ── Month calendar ───────────────────────────────────────────────────────────
{
    const p = projectDays({ daily, clim, persistence: pers, now: NOW, days: 30 });
    const cal = buildMonthCalendar({ projection: p, archive, daily, clim, now: NOW });
    assert.ok(cal.weeks.length >= 5 && cal.weeks.length <= 9, `${cal.weeks.length} week rows`);
    assert.ok(cal.weeks.every((w) => w.length === 7), 'whole weeks');
    const cells = cal.weeks.flat();
    assert.equal(new Date(cells[0].t).getDay(), 0, 'grid starts on a Sunday');
    const firstReal = cells.find((c) => !c.pad);
    assert.equal(firstReal.day, 1, 'the first real cell is the 1st of the month');
    assert.equal(firstReal.month, 8);
    assert.ok(firstReal.monthStart);
    const today = cells.find((c) => c.isToday);
    assert.equal(today.key, '2026-09-21');
    assert.equal(today.lead, 0);
    assert.equal(today.source, 'nwp');
    const forward = cells.filter((c) => !c.pad && c.lead >= 0);
    assert.equal(forward.length, 31, 'today + 30 forward cells');
    assert.equal(forward[forward.length - 1].key, '2026-10-21');
    assert.equal(forward[forward.length - 1].tier, 'blend');
    const oct1 = cells.find((c) => c.key === '2026-10-01');
    assert.ok(oct1.monthStart && !oct1.pad);
    assert.deepEqual(cal.months, ['2026-09', '2026-10']);
    // Past days of the month: archive fills them, analysis covers the gap.
    const past = cells.filter((c) => !c.pad && c.past);
    assert.equal(past.length, 20, 'Sept 1–20 are past');
    assert.ok(past.every((c) => c.hiF != null && c.loF != null), 'every past day has a value');
    assert.equal(cells.find((c) => c.key === '2026-09-10').source, 'archive');
    // A past day carries its own departure from the normal (colour on the calendar).
    const sep10 = cells.find((c) => c.key === '2026-09-10');
    const a10 = archive.find((a) => localDayKey(a.t) === '2026-09-10');
    assert.ok(Number.isFinite(sep10.anomF));
    assert.ok(Math.abs(sep10.anomF - ((a10.hiF + a10.loF) / 2 - climAt(clim, a10.t).mean)) < 1e-9);
    const noClimCal = buildMonthCalendar({ projection: p, archive, daily, now: NOW });
    assert.equal(noClimCal.weeks.flat().find((c) => c.key === '2026-09-10').anomF, null, 'no climatology → no past anomaly');
    // The archive ends 2 days ago in production; here it runs to the 18th, so
    // the 19th/20th come from the forecast API's past_days analysis.
    const trimmed = archive.filter((a) => a.t < new Date(2026, 8, 19).getTime());
    const cal2 = buildMonthCalendar({ projection: p, archive: trimmed, daily, now: NOW });
    const c20 = cal2.weeks.flat().find((c) => c.key === '2026-09-20');
    assert.equal(c20.source, 'analysis');
    // Trailing pad closes the last week; nothing is drawn past the last projected day.
    const lastReal = [...cells].reverse().find((c) => !c.pad);
    assert.equal(lastReal.key, '2026-10-21');
    assert.equal(new Date(cells[cells.length - 1].t).getDay(), 6, 'grid ends on a Saturday');
}

console.log('temp-outlook: all assertions passed');
