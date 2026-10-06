/**
 * Gate for js/skyview/sky-predict.js — SkyView's forecasting kernel.
 *
 * Identities and closed forms only:
 *   - Nights are anchored on LOCAL MEAN SOLAR time: night k's midnight is where
 *     jd + 0.5 + lon/360 is an integer, and 06:00 is the switch to tonight.
 *   - The grid's interpolated dusk/dawn agree with the refined rise/set solver
 *     (sky-engine `horizonEvents` on `sunAltitudeDeg`) to 2 minutes.
 *   - The fast matrix path reproduces `horizontalOf` + refraction exactly.
 *   - SIDEREAL DRIFT: at the same clock time on consecutive nights a fixed
 *     star's local sidereal angle grows by 0.9856° — the reason the sky "moves"
 *     from night to night — and it rises 3.93 minutes earlier.
 *   - Windows: a circumpolar star high above the floor is usable for the whole
 *     dark interval; a star that never rises is usable for none; windows never
 *     leave the darkness.
 *   - Season: Sirius sits opposite the Sun around New Year and Vega around
 *     1 July (they cross the meridian at local midnight then), and on that date
 *     the forecast's culmination falls within half an hour of local midnight.
 *   - Moving bodies are re-evaluated per sample: the Moon's same-time positions
 *     move ~12–13° a night against the stars; a fixed star's do not.
 */
import assert from 'node:assert/strict';
import {
    nightNoonJd, buildNightGrid, fixedTarget, bodyTarget, forecastVisibility,
    pathSamples, sameTimeSamples, seasonPeakJd, NIGHTLY_DRIFT_DEG, NIGHTLY_EARLIER_MIN,
    DARK_SUN_DEG,
} from '../js/skyview/sky-predict.js';
import {
    jdFromMs, skyFrame, horizontalOf, refractionDeg, sunAltitudeDeg, horizonEvents,
    angularSeparationDeg, raDecToVec,
} from '../js/skyview/sky-engine.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} ± ${tol}`);
const jdUTC = (iso) => jdFromMs(Date.parse(iso));
const DENVER = { latDeg: 39.74, lonDeg: -104.99 };

// ── Night anchoring ────────────────────────────────────────────────────────
{
    // Denver local mean midnight ≈ 07:00 UT. At 20:00 LMT the night is tonight's;
    // at 03:00 LMT it is still the night in progress; at 09:00 it is the coming one.
    const lmtMidnight = (jd) => { const x = jd + 0.5 + DENVER.lonDeg / 360; return x - Math.floor(x); };
    for (const [iso, label] of [['2026-10-06T03:00:00Z', 'evening'], ['2026-10-06T10:00:00Z', 'pre-dawn'], ['2026-10-05T16:00:00Z', 'morning']]) {
        const jd = jdUTC(iso);
        const noon = nightNoonJd(jd, DENVER.lonDeg);
        near(lmtMidnight(noon + 0.5), 0, 1e-9, `${label}: night midnight is local mean midnight`);
        assert.ok(noon <= jd + 0.75 && noon + 1 > jd - 0.25, `${label}: the night is the right one`);
    }
    // Evening and pre-dawn of the same night share a noon; the morning before is the same night too.
    assert.equal(nightNoonJd(jdUTC('2026-10-06T03:00:00Z'), DENVER.lonDeg), nightNoonJd(jdUTC('2026-10-06T10:00:00Z'), DENVER.lonDeg));
    assert.equal(nightNoonJd(jdUTC('2026-10-05T16:00:00Z'), DENVER.lonDeg), nightNoonJd(jdUTC('2026-10-06T03:00:00Z'), DENVER.lonDeg));
}

const jd0 = jdUTC('2026-10-05T22:00:00Z');
const grid = buildNightGrid(DENVER, jd0, 30);

// ── Dusk / dawn vs the refined solver ──────────────────────────────────────
{
    assert.equal(grid.nights.length, 30);
    for (const nt of [grid.nights[0], grid.nights[14], grid.nights[29]]) {
        const ev = horizonEvents((jd) => sunAltitudeDeg(jd, DENVER.latDeg, DENVER.lonDeg), nt.noonJd, { spanDays: 1, h0: DARK_SUN_DEG, stepMin: 5 });
        near(nt.dusk, ev.set, 2 / 1440, `night ${nt.index} dusk`);
        near(nt.dawn, ev.rise, 2 / 1440, `night ${nt.index} dawn`);
        assert.ok(nt.twilightStart < nt.dusk && nt.twilightEnd > nt.dawn, 'civil twilight brackets darkness');
        assert.ok(nt.darkHours > 8 && nt.darkHours < 12, `October at 40°N has 8–12 dark hours (${nt.darkHours.toFixed(1)})`);
    }
    // Nights get longer through October.
    assert.ok(grid.nights[29].darkHours > grid.nights[0].darkHours, 'nights lengthen toward winter');
    // No darkness at 70°N in June: the grid says so rather than inventing a window.
    const polar = buildNightGrid({ latDeg: 70, lonDeg: 20 }, jdUTC('2026-06-21T12:00:00Z'), 2);
    assert.equal(polar.nights[0].dusk, null);
    assert.equal(polar.nights[0].darkHours, 0);
}

// ── Fast path = slow path ──────────────────────────────────────────────────
{
    const ra = 279.2347, dec = 38.7837;                      // Vega
    const nt = grid.nights[3];
    const vis = forecastVisibility({ ...grid, nights: [nt] }, fixedTarget(ra, dec), { minAltDeg: -90 });
    for (const i of [0, 17, 40, 77, 96]) {
        const geo = horizontalOf(skyFrame(nt.jd[i], DENVER.latDeg, DENVER.lonDeg), ra, dec).altDeg;
        const path = pathSamples(DENVER, fixedTarget(ra, dec), nt.jd[i], nt.jd[i])[0];
        near(path.altDeg, geo + refractionDeg(geo), 1e-9, 'matrix path = horizontalOf + refraction');
    }
    assert.ok(vis.nights[0].hours > 0);
}

// ── Sidereal drift ─────────────────────────────────────────────────────────
{
    near(NIGHTLY_DRIFT_DEG, 0.9856, 1e-4, 'nightly drift constant');
    near(NIGHTLY_EARLIER_MIN, 3.93, 0.01, 'stars rise ~3m56s earlier each night');
    const a = skyFrame(jd0, DENVER.latDeg, DENVER.lonDeg).lstDeg;
    const b = skyFrame(jd0 + 1, DENVER.latDeg, DENVER.lonDeg).lstDeg;
    near(((b - a) + 360) % 360, NIGHTLY_DRIFT_DEG, 1e-5, 'same clock time ⇒ LST +0.9856°');
    // A star's rise moves earlier by that much: compare two consecutive rises.
    const vega = fixedTarget(279.2347, 38.7837);
    const alt = (jd) => pathSamples(DENVER, vega, jd, jd)[0].altDeg;
    const r1 = horizonEvents(alt, jd0, { spanDays: 1, h0: 10, stepMin: 5 }).rise;
    const r2 = horizonEvents(alt, r1 + 0.5, { spanDays: 1, h0: 10, stepMin: 5 }).rise;
    near((1 - (r2 - r1)) * 1440, NIGHTLY_EARLIER_MIN, 0.05, 'Vega crosses 10° 3.93 min earlier the next night');
    // Same-time samples of a fixed star trace one diurnal circle: constant
    // declination, so the angle from the celestial pole never changes.
    const st = sameTimeSamples(DENVER, vega, jd0, 30);
    assert.equal(st.length, 30);
    const drift = angularSeparationDeg(0, st[0].altDeg, (st[29].azDeg - st[0].azDeg), st[29].altDeg);
    assert.ok(drift > 15, `a month of same-time positions moves Vega well across the sky (${drift.toFixed(1)}°)`);
}

// ── Windows ────────────────────────────────────────────────────────────────
{
    // Kochab (β UMi, dec +74°) never drops below 40 − (90 − 74) = 24° at 40°N.
    const koc = forecastVisibility(grid, fixedTarget(222.6764, 74.1555), { minAltDeg: 20 });
    for (const n of koc.nights) near(n.hours, n.darkHours, 0.02, `night ${n.index}: circumpolar star usable all darkness`);
    // Canopus never rises at 40°N.
    const can = forecastVisibility(grid, fixedTarget(95.9880, -52.6957));
    assert.equal(can.totalHours, 0);
    assert.equal(can.best, -1, 'no best night for something that never rises');
    // Windows never leave the dark interval and never overlap.
    const sir = forecastVisibility(grid, fixedTarget(101.2872, -16.7161), { minAltDeg: 15 });
    for (const n of sir.nights) {
        for (const w of n.windows) {
            assert.ok(w.start >= n.dusk - 1e-9 && w.end <= n.dawn + 1e-9, 'window inside darkness');
            assert.ok(w.end > w.start, 'window has positive length');
        }
    }
    // Sirius is a morning object in October: it gets MORE usable hours through the month.
    assert.ok(sir.nights[29].hours > sir.nights[0].hours, 'Sirius gains hours as the season turns');
    assert.ok(sir.best >= 20, `Sirius's best October night is late in the month (night ${sir.best})`);
    for (const n of sir.nights) assert.ok(n.moonIllum >= 0 && n.moonIllum <= 1 && n.moonSepDeg >= 0 && n.moonSepDeg <= 180);
}

// ── Season peak: the meridian at midnight ──────────────────────────────────
{
    const y = jdUTC('2026-06-01T00:00:00Z');
    const sirius = seasonPeakJd(101.2872, y);
    const vega = seasonPeakJd(279.2347, jdUTC('2026-01-01T00:00:00Z'));
    const iso = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString().slice(0, 10);
    near(sirius, jdUTC('2027-01-01T00:00:00Z'), 3, `Sirius opposite the Sun ≈ 1 Jan (${iso(sirius)})`);
    near(vega, jdUTC('2026-07-01T00:00:00Z'), 3, `Vega opposite the Sun ≈ 1 Jul (${iso(vega)})`);
    // On that night Sirius culminates near local mean midnight.
    const g = buildNightGrid(DENVER, sirius, 1);
    const f = forecastVisibility(g, fixedTarget(101.2872, -16.7161), { minAltDeg: 0 });
    near(f.nights[0].culminationJd, g.nights[0].midnightJd, 30 / 1440, 'culmination at local midnight on its season date');
}

// ── Moving targets ─────────────────────────────────────────────────────────
{
    const moon = bodyTarget('moon', DENVER);
    const st = sameTimeSamples(DENVER, moon, jd0, 3);
    const v0 = moon.vecAt(st[0].jd), v1 = moon.vecAt(st[1].jd);
    const sep = Math.acos(v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]) * 180 / Math.PI;
    assert.ok(sep > 11 && sep < 15.5, `the Moon moves ~13° a day against the stars (${sep.toFixed(1)}°)`);
    const fixed = fixedTarget(120, 20);
    assert.deepEqual(fixed.vec, raDecToVec(120, 20), 'a fixed target is a fixed direction');
    const sat = forecastVisibility(buildNightGrid(DENVER, jd0, 3), bodyTarget('saturn', DENVER));
    assert.ok(sat.nights[0].hours > 6, `Saturn at opposition is up most of the night (${sat.nights[0].hours.toFixed(1)} h)`);
}

console.log('skyview-predict.mjs — all assertions passed');
