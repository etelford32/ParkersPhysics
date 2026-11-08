/**
 * tests/theme-schedule.mjs — node gate for the time-of-day theme kernel.
 *
 *   node tests/theme-schedule.mjs
 *
 * Pins js/theme-schedule.js:
 *   1. With a location, 'auto' is light exactly while the Sun is up: the
 *      bisected transition lands on sunrise/sunset as js/sun-altitude.js
 *      `sunTimes` computes it (a DIFFERENT path through the same ephemeris —
 *      hour-angle closed form vs. our altitude scan), within 2 min.
 *   2. NEGATIVE CONTROL: the same instant at the antipode resolves the
 *      opposite theme (a sign error in longitude would pass a single-site
 *      check by luck at some hours, never at both sites).
 *   3. Without a location the local-clock window applies, timezone-correct.
 *   4. Polar day/night never returns a null re-check time.
 *   5. Pinned modes ignore the Sun; unknown modes mean 'auto'.
 *   6. js/theme-boot.js (classic script, cannot import this module) mirrors
 *      the clock window and the storage keys BY HAND — read its source and
 *      fail on drift.
 *   7. The page list (scripts/build-theme-support.mjs) and the pages agree —
 *      `--check` mode, so a page that lost its boot script fails here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveTheme, isDaylight, nextTransitionMs, normalizeMode, localHour,
    CLOCK_DAY, STORAGE_KEY, CACHE_KEY, RECHECK_MS, SUN_LIGHT_ALT_DEG, describeTheme,
} from '../js/theme-schedule.js';
import { sunTimes, solarPosition } from '../js/sun-altitude.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${name}`); };
const MIN = 60_000, H = 3_600_000;

// ── 1. Sunrise/sunset at a real site ─────────────────────────────────────
const BOULDER = { lat: 40.015, lon: -105.27, city: 'Boulder' };
{
    // 2026-06-21 18:00 UTC = 12:00 MDT — midday.
    const noon = Date.UTC(2026, 5, 21, 18, 0);
    const r = resolveTheme({ mode: 'auto', nowMs: noon, location: BOULDER });
    assert.equal(r.theme, 'light');
    assert.equal(r.reason, 'sun');
    const st = sunTimes(new Date(noon), BOULDER.lat, BOULDER.lon);
    // sunTimes is per UTC day; Boulder's sunset falls after 00 UTC, i.e. on
    // the NEXT UTC date's table.
    const set = st.sunset.getTime() < noon
        ? sunTimes(new Date(noon + 24 * H), BOULDER.lat, BOULDER.lon).sunset.getTime()
        : st.sunset.getTime();
    assert.ok(Math.abs(r.untilMs - set) < 2 * MIN,
        `sunset ${new Date(r.untilMs).toISOString()} vs sunTimes ${new Date(set).toISOString()}`);
    // The altitude really crosses the threshold at untilMs.
    const a0 = solarPosition(new Date(r.untilMs - 5 * MIN), BOULDER.lat, BOULDER.lon).altitudeDeg;
    const a1 = solarPosition(new Date(r.untilMs + 5 * MIN), BOULDER.lat, BOULDER.lon).altitudeDeg;
    assert.ok(a0 > SUN_LIGHT_ALT_DEG && a1 < SUN_LIGHT_ALT_DEG, `${a0} → ${a1}`);
    ok('auto is light at midday and flips at sunset (matches sunTimes < 2 min)');

    // Night: 2026-06-22 08:00 UTC = 02:00 MDT → dark, flips at sunrise.
    const night = Date.UTC(2026, 5, 22, 8, 0);
    const d = resolveTheme({ mode: 'auto', nowMs: night, location: BOULDER });
    assert.equal(d.theme, 'dark');
    const rise = sunTimes(new Date(night), BOULDER.lat, BOULDER.lon).sunrise.getTime();
    assert.ok(Math.abs(d.untilMs - rise) < 2 * MIN);
    ok('auto is dark at night and flips at sunrise');
}

// ── 2. Negative control: the antipode is the opposite theme ──────────────
{
    const anti = { lat: -BOULDER.lat, lon: BOULDER.lon + 180 };
    for (const hUtc of [0, 6, 12, 18]) {
        const t = Date.UTC(2026, 2, 20, hUtc, 0);   // equinox: day ≈ night everywhere
        const a = isDaylight(t, BOULDER).light, b = isDaylight(t, anti).light;
        // Within ~10 min of a terminator both can read the same; these hours avoid it.
        assert.notEqual(a, b, `UTC ${hUtc}h: site and antipode agree (${a})`);
    }
    ok('negative control — the antipode always resolves the opposite theme');
}

// ── 3. Clock fallback, timezone-explicit ─────────────────────────────────
{
    const t = Date.UTC(2026, 10, 8, 14, 0);           // 14:00 UTC
    // UTC−5 (offset +300): 09:00 local → light. UTC+9 (−540): 23:00 → dark.
    assert.equal(localHour(t, 300), 9);
    assert.equal(isDaylight(t, null, { tzOffsetMin: 300 }).light, true);
    assert.equal(isDaylight(t, null, { tzOffsetMin: -540 }).light, false);
    const r = resolveTheme({ mode: 'auto', nowMs: t, location: null, tzOffsetMin: 300 });
    assert.equal(r.reason, 'clock');
    // next flip at 19:00 local = 00:00 UTC next day
    assert.ok(Math.abs(r.untilMs - Date.UTC(2026, 10, 9, 0, 0)) <= 1000);
    // window edges: 07:00 light, 06:59 dark, 19:00 dark
    assert.equal(isDaylight(Date.UTC(2026, 0, 1, CLOCK_DAY.startH), null, { tzOffsetMin: 0 }).light, true);
    assert.equal(isDaylight(Date.UTC(2026, 0, 1, CLOCK_DAY.startH) - MIN, null, { tzOffsetMin: 0 }).light, false);
    assert.equal(isDaylight(Date.UTC(2026, 0, 1, CLOCK_DAY.endH), null, { tzOffsetMin: 0 }).light, false);
    // An invalid location is NOT silently treated as (0, 0).
    assert.equal(isDaylight(t, { lat: 'x', lon: 3 }, { tzOffsetMin: 300 }).reason, 'clock');
    ok('no location ⇒ local-clock 07:00–19:00, timezone-correct; bad coords fall back');
}

// ── 4. Polar day / night ────────────────────────────────────────────────
{
    const TROMSO = { lat: 69.65, lon: 18.96 };
    const june = Date.UTC(2026, 5, 21, 0, 0), dec = Date.UTC(2026, 11, 21, 12, 0);
    const a = resolveTheme({ mode: 'auto', nowMs: june, location: TROMSO });
    assert.equal(a.theme, 'light');
    assert.equal(nextTransitionMs(june, TROMSO), null);
    assert.equal(a.untilMs, june + RECHECK_MS);
    const b = resolveTheme({ mode: 'auto', nowMs: dec, location: TROMSO });
    assert.equal(b.theme, 'dark');
    assert.equal(b.untilMs, dec + RECHECK_MS);
    ok('polar day is light, polar night dark, both re-check in 6 h (never null)');
}

// ── 5. Modes ─────────────────────────────────────────────────────────────
{
    const night = Date.UTC(2026, 5, 22, 8, 0);
    assert.deepEqual(resolveTheme({ mode: 'light', nowMs: night, location: BOULDER }),
        { mode: 'light', theme: 'light', reason: 'pinned', untilMs: null });
    assert.equal(resolveTheme({ mode: 'dark', nowMs: Date.UTC(2026, 5, 21, 18), location: BOULDER }).theme, 'dark');
    for (const v of [null, undefined, '', 'system', 'LIGHT', 42]) assert.equal(normalizeMode(v), 'auto');
    assert.match(describeTheme(resolveTheme({ mode: 'auto', nowMs: night, location: BOULDER }),
        { placeName: 'Boulder', formatTime: () => '5:31 AM' }), /sunrise to sunset at Boulder.*light around 5:31 AM/);
    ok('pinned modes ignore the Sun; unknown values mean auto; tooltip text');
}

// ── 6. Boot-script mirror ────────────────────────────────────────────────
{
    const boot = readFileSync(join(ROOT, 'js/theme-boot.js'), 'utf8');
    assert.match(boot, new RegExp(`CLOCK_START_H\\s*=\\s*${CLOCK_DAY.startH}\\b`), 'boot clock start drifted');
    assert.match(boot, new RegExp(`CLOCK_END_H\\s*=\\s*${CLOCK_DAY.endH}\\b`), 'boot clock end drifted');
    assert.ok(boot.includes(`'${STORAGE_KEY}'`), 'boot does not read STORAGE_KEY');
    assert.ok(boot.includes(`'${CACHE_KEY}'`), 'boot does not read CACHE_KEY');
    assert.ok(!/\bimport\b|\bexport\b/.test(boot.replace(/\/\*[\s\S]*?\*\//g, '')),
        'theme-boot.js must stay a CLASSIC script (it runs in <head> before modules)');
    ok('theme-boot.js mirrors the clock window and storage keys');
}

// ── 7. Page wiring ───────────────────────────────────────────────────────
{
    execFileSync(process.execPath, [join(ROOT, 'scripts/build-theme-support.mjs'), '--check'],
        { stdio: 'inherit' });
    ok('every light-capable page carries the boot script + stylesheet (build-theme-support --check)');
}

console.log(`\ntheme-schedule: ${n} checks passed`);
