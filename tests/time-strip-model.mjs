#!/usr/bin/env node
/**
 * time-strip-model.mjs — gates js/time-strip-model.js (the time-bar strip's
 * PURE geometry, EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §6).
 *
 *   1. The strip's time axis IS the slider's: x ↔ t round-trips over the
 *      measured thumb travel, and clamps at the ends.
 *   2. Gaps break the temperature line — no segment is ever drawn across a
 *      null hour (NEGATIVE CONTROL: the same series with the gap filled
 *      produces exactly the bridging segments the gap removed).
 *   3. Precip bars: none when dry, √-scaled, never taller than the plot.
 *   4. Provenance bands follow coverage, clipped to the domain.
 *   5. Night shading follows the supplied sun test; day ticks land on the
 *      supplied local midnights and labels drop when days get too narrow.
 *   6. Temperature colours come from the shared ramp bytes.
 *   7. describeSample prints units and never invents a value.
 */

import assert from 'node:assert/strict';
import {
    stripModel, timeToX, xToTime, nearestIndex, describeSample, tempColor,
    PRECIP_FULL_SCALE_MM_H, MIN_TEMP_SPAN_C,
} from '../js/time-strip-model.js';
import { buildTempLUTPixels, tempToRampFrac } from '../js/temp-ramp.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name); console.error('    ', e.stack || e.message); }
}

function makeSeries(hours, f) {
    const t = new Float64Array(hours);
    const t2m = new Float32Array(hours), precip = new Float32Array(hours), cloudTotal = new Float32Array(hours);
    for (let i = 0; i < hours; i++) {
        t[i] = T0 + i * HOUR;
        const v = f(i);
        t2m[i] = v.t ?? NaN; precip[i] = v.p ?? NaN; cloudTotal[i] = v.c ?? NaN;
    }
    return { t, values: { t2m, precip, cloudTotal } };
}

const domain = { t0: T0, t1: T0 + 47 * HOUR };
const base = { domain, width: 500, height: 30, trackX0: 7, trackX1: 493 };

console.log('time-strip-model');

check('x ↔ t round-trips over the thumb travel and clamps', () => {
    for (const t of [domain.t0, domain.t0 + 5.5 * HOUR, domain.t1]) {
        const x = timeToX(t, domain, 7, 493);
        assert.ok(Math.abs(xToTime(x, domain, 7, 493) - t) < 1);
    }
    assert.equal(timeToX(domain.t0, domain, 7, 493), 7);
    assert.equal(timeToX(domain.t1, domain, 7, 493), 493);
    assert.equal(xToTime(-50, domain, 7, 493), domain.t0);
    assert.equal(xToTime(9999, domain, 7, 493), domain.t1);
});

check('a null hour breaks the temperature line (negative control fills it)', () => {
    const withGap = makeSeries(48, (i) => ({ t: i >= 10 && i < 13 ? NaN : 10 + Math.sin(i / 4) * 5 }));
    const filled  = makeSeries(48, (i) => ({ t: 10 + Math.sin(i / 4) * 5 }));
    const a = stripModel({ ...base, series: withGap });
    const b = stripModel({ ...base, series: filled });
    assert.equal(b.tempSegs.length, 47);
    assert.equal(a.tempSegs.length, 47 - 4, 'the 3-hour hole removes the 4 segments that touched it');
    const gx0 = timeToX(T0 + 9 * HOUR, domain, 7, 493), gx1 = timeToX(T0 + 13 * HOUR, domain, 7, 493);
    for (const s of a.tempSegs) assert.ok(s.x1 <= gx0 + 1e-6 || s.x0 >= gx1 - 1e-6, 'no segment may lie inside the gap');
    assert.ok(!a.tempSegs.some((s) => s.x0 < gx0 + 1e-6 && s.x1 > gx1 - 1e-6), 'no segment bridges the gap');
    assert.ok(b.tempSegs.some((s) => s.x0 < timeToX(T0 + 11 * HOUR, domain, 7, 493) && s.x1 > timeToX(T0 + 10 * HOUR, domain, 7, 493)),
        'control: the filled series draws through the same hours');
});

check('flat temperatures get a minimum span, the line stays inside the plot', () => {
    const m = stripModel({ ...base, series: makeSeries(48, () => ({ t: 15 })) });
    assert.ok(m.range.max - m.range.min >= MIN_TEMP_SPAN_C - 1e-9);
    for (const s of m.tempSegs) for (const y of [s.y0, s.y1]) assert.ok(y >= m.plotTop && y <= m.plotBot);
});

check('precip bars: none when dry, √-scaled, capped at the plot height', () => {
    const m = stripModel({ ...base, series: makeSeries(48, (i) => ({ t: 10, p: i === 5 ? 2.5 : i === 6 ? 40 : 0 })) });
    assert.equal(m.precip.length, 2);
    const plotH = m.plotBot - m.plotTop;
    const [light, heavy] = m.precip;
    assert.ok(Math.abs(light.h - Math.sqrt(2.5 / PRECIP_FULL_SCALE_MM_H) * plotH) < 1e-6);
    assert.ok(Math.abs(heavy.h - plotH) < 1e-6, 'past full scale the bar is the plot, not taller');
    assert.ok(heavy.y >= m.plotTop - 1e-9);
});

check('provenance bands follow coverage, clipped to the domain', () => {
    const cov = [
        { t0: T0 - 10 * HOUR, t1: T0 + 10 * HOUR, provenance: 'observed', stale: false },
        { t0: T0 + 10 * HOUR, t1: T0 + 34 * HOUR, provenance: 'nowcast', stale: false },
        { t0: T0 + 34 * HOUR, t1: T0 + 99 * HOUR, provenance: 'nwp', stale: true },
    ];
    const m = stripModel({ ...base, series: makeSeries(48, () => ({ t: 10 })), coverage: cov });
    assert.deepEqual(m.bands.map((b) => b.provenance), ['observed', 'nowcast', 'nwp']);
    assert.equal(m.bands[0].x0, 7, 'clipped at the domain start');
    assert.equal(m.bands[2].x1, 493, 'clipped at the domain end');
    assert.equal(m.bands[1].x0, m.bands[0].x1, 'adjacent runs meet edge to edge');
    assert.equal(m.bands[2].stale, true);
    assert.equal(m.bands[0].y + m.bands[0].h, 30, 'the band sits on the strip\'s foot');
});

check('night shading and day ticks follow the supplied functions', () => {
    const isNight = (t) => ((t - T0) / HOUR) % 24 >= 18;                     // 18:00–24:00 dark
    const dayStart = (t) => T0 + Math.floor((t - T0) / (24 * HOUR)) * 24 * HOUR;
    const m = stripModel({ ...base, series: makeSeries(48, () => ({ t: 10 })), isNight, dayStart });
    assert.equal(m.night.length, 2);
    const x18 = timeToX(T0 + 18 * HOUR, domain, 7, 493);
    assert.ok(Math.abs(m.night[0].x0 - x18) < 1e-6);
    assert.deepEqual(m.days.map((d) => d.t), [T0, T0 + 24 * HOUR]);
    assert.equal(m.labelDays, true);
    const wide = stripModel({ ...base, domain: { t0: T0, t1: T0 + 60 * 24 * HOUR }, series: makeSeries(2, () => ({ t: 1 })), dayStart });
    assert.equal(wide.labelDays, false, '60 days in 486 px is too narrow to label');
});

check('temperature colours come from the shared ramp bytes', () => {
    const lut = buildTempLUTPixels();
    for (const tC of [-40, 0, 22, 45]) {
        const i = Math.round(tempToRampFrac(tC) * 255) * 4;
        assert.equal(tempColor(tC), `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`);
    }
});

check('nearestIndex + describeSample', () => {
    const s = makeSeries(10, () => ({ t: 1 }));
    assert.equal(nearestIndex(s, T0 + 3.4 * HOUR), 3);
    assert.equal(nearestIndex(s, T0 - 99 * HOUR), 0);
    const d = describeSample({ values: { t2m: 20, precip: 0, cloudTotal: 40.4, wind: 3.21, windDirDeg: 270 } }, 'Observed');
    assert.equal(d.line, '20.0 °C (68 °F) · dry · cloud 40 % · wind 3.2 m/s W');
    assert.equal(describeSample({ values: { t2m: null } }, 'x').line, 'no data at this hour');
    assert.equal(describeSample(null), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
