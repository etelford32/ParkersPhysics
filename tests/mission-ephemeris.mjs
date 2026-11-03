/**
 * Gate for js/mission-ephemeris.js — the Horizons query/parse/interpolate
 * kernel shared by /api/missions/ephemeris and the missions map.
 *
 *   node tests/mission-ephemeris.mjs
 *
 * Pinned:
 *   1. The query asks for what the parser reads (CSV, vectors, AU-D,
 *      ECLIPJ2000, Sun centre, 26 h window at 1 h) and the window starts an
 *      hour before the request so a 1 h CDN cache always brackets now.
 *   2. The CSV parser reads a real-shaped Horizons result by COLUMN INDEX
 *      (the calendar field carries spaces and 'A.D.'), skips the header and
 *      footer, and names the three ways a candidate can miss (ambiguous name
 *      list, no match, no table).
 *   3. Hermite interpolation reproduces a circular orbit to < 1e-7 AU on 1 h
 *      samples where linear interpolation chords by ~1e-3 at Parker's
 *      perihelion rate — the measured reason the samples carry velocity.
 *   4. Outside the window the state extrapolates linearly up to 24 h and is
 *      null beyond (a stale tab must fall back, never fly off).
 *   5. planBatches keeps roster order, caps size and carries every host.
 */
import assert from 'node:assert/strict';
import {
    STEP_HOURS, WINDOW_HOURS, EXTRAPOLATE_MAX_HOURS, HOST_COMMANDS,
    windowStartJd, horizonsTime, horizonsQuery, parseHorizonsVectors, classifyMiss,
    interpolateState, planBatches, missionsWithHorizons, distanceAU, lightTimeMinutes, speedKms,
    provenanceSummary,
} from '../js/mission-ephemeris.js';
import { ALL_MISSIONS } from '../js/space-missions.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
console.log('mission-ephemeris.mjs');

const JD0 = 2461347.5;   // 2026-11-03 00:00 UTC

ok('window starts an hour before the request, on the hour', () => {
    const s = windowStartJd(JD0 + 0.3);               // 07:12
    assert.ok(Math.abs(s - (JD0 + 6 / 24)) < 1e-9);  // 06:00
    assert.equal(horizonsTime(s), '2026-11-03 06:00');
});

ok('query carries the parser\'s contract', () => {
    const q = horizonsQuery('-96', JD0);
    assert.equal(q.get('COMMAND'), "'-96'");
    assert.equal(q.get('EPHEM_TYPE'), 'VECTORS');
    assert.equal(q.get('CENTER'), "'500@10'");
    assert.equal(q.get('REF_FRAME'), 'ECLIPJ2000');
    assert.equal(q.get('OUT_UNITS'), 'AU-D');
    assert.equal(q.get('CSV_FORMAT'), 'YES');
    assert.equal(q.get('VEC_TABLE'), '2');
    assert.equal(q.get('STEP_SIZE'), `'${STEP_HOURS}h'`);
    assert.equal(q.get('START_TIME'), "'2026-11-03 00:00'");
    assert.equal(q.get('STOP_TIME'), `'2026-11-04 02:00'`);
    assert.equal(WINDOW_HOURS, 26);
});

/** A Horizons CSV result in its real shape (header, SOE block, footer). */
function fakeResult(rows) {
    const head = `*******************************************************************************\nEphemeris / API_USER Tue Nov  3 12:00:00 2026 Pasadena, USA      / Horizons\n*******************************************************************************\nTarget body name: Parker Solar Probe (spacecraft) (-96) {source: psp_merged}\nCenter body name: Sun (10)                        {source: DE441}\n*******************************************************************************\nJDTDB, Calendar Date (TDB), X, Y, Z, VX, VY, VZ, LT, RG, RR,\n**************************************************************************************************************************************************************************************************************\n$$SOE\n`;
    const body = rows.map(r => `${r[0].toFixed(9)}, A.D. 2026-Nov-03 00:00:00.0000, ${r[1].toExponential(15)}, ${r[2].toExponential(15)}, ${r[3].toExponential(15)}, ${r[4].toExponential(15)}, ${r[5].toExponential(15)}, ${r[6].toExponential(15)}, 1.0E-03, 1.0E-01, 1.0E-02,`).join('\n');
    return head + body + '\n$$EOE\n*******************************************************************************\n\nTIME\n';
}

ok('CSV parser reads rows by column index, skips header/footer', () => {
    const rows = [[JD0, 0.1, -0.2, 0.001, 0.01, 0.02, -0.0003], [JD0 + 1 / 24, 0.1004, -0.1992, 0.00099, 0.01, 0.02, -0.0003]];
    const s = parseHorizonsVectors(fakeResult(rows));
    assert.equal(s.length, 2);
    assert.deepEqual(s[0], rows[0]);
    assert.ok(Math.abs(s[1][1] - 0.1004) < 1e-15);
});

ok('a candidate misses in three named ways', () => {
    assert.throws(() => parseHorizonsVectors('Multiple major-bodies match string "hera"\n  ID#  Name\n  103 Hera\n -1176 Hera (spacecraft)'), /ambiguous-name/);
    assert.throws(() => parseHorizonsVectors('No matches found.'), /no-match/);
    assert.throws(() => parseHorizonsVectors('something else entirely'), /no-table/);
    assert.throws(() => parseHorizonsVectors(undefined), /no-result/);
    assert.equal(classifyMiss('No ephemeris for target "ESCAPADE" prior to A.D. 2025-NOV-14'), 'no-ephemeris-in-window');
    assert.throws(() => parseHorizonsVectors(fakeResult([[JD0, 1, 2, 3, 4, 5, 6]])), /too-few-rows/);
});

ok('Hermite on 1 h samples beats linear by > 100× at Parker\'s perihelion angular rate', () => {
    // circular orbit, r = 0.046 AU, period such that 1 h = 34° (PSP perihelion rate)
    const r = 0.046, degPerHour = 34, w = degPerHour * Math.PI / 180 * 24;   // rad/day
    const samples = [];
    for (let h = 0; h <= 4; h++) {
        const t = JD0 + h / 24, th = w * (t - JD0);
        samples.push([t, r * Math.cos(th), r * Math.sin(th), 0, -r * w * Math.sin(th), r * w * Math.cos(th), 0]);
    }
    let worstH = 0, worstL = 0;
    for (let k = 1; k < 40; k++) {
        const t = JD0 + (k / 40) * (4 / 24), th = w * (t - JD0);
        const truth = [r * Math.cos(th), r * Math.sin(th)];
        const s = interpolateState(samples, t);
        worstH = Math.max(worstH, Math.hypot(s.x_AU - truth[0], s.y_AU - truth[1]));
        // linear control
        const i = Math.min(3, Math.floor((t - JD0) * 24)), a = samples[i], b = samples[i + 1];
        const f = (t - a[0]) / (b[0] - a[0]);
        worstL = Math.max(worstL, Math.hypot(a[1] + (b[1] - a[1]) * f - truth[0], a[2] + (b[2] - a[2]) * f - truth[1]));
        assert.equal(s.mode, 'interpolated');
    }
    assert.ok(worstH < 3e-5, `Hermite worst ${worstH}`);
    assert.ok(worstL > 1e-3, `linear control worst ${worstL} (must be visibly wrong)`);
    assert.ok(worstL / worstH > 100, `ratio ${worstL / worstH}`);
});

ok('outside the window: linear extrapolation up to 24 h, null beyond', () => {
    const samples = [[JD0, 1, 0, 0, 0.01, 0, 0], [JD0 + 1 / 24, 1 + 0.01 / 24, 0, 0, 0.01, 0, 0]];
    const after = interpolateState(samples, JD0 + 1 / 24 + 0.5);
    assert.equal(after.mode, 'extrapolated');
    assert.ok(Math.abs(after.x_AU - (1 + 0.01 / 24 + 0.005)) < 1e-12);
    assert.equal(interpolateState(samples, JD0 + 1 / 24 + EXTRAPOLATE_MAX_HOURS / 24 + 0.01), null);
    assert.equal(interpolateState(samples, JD0 - EXTRAPOLATE_MAX_HOURS / 24 - 0.01), null);
    assert.equal(interpolateState([], JD0), null);
});

ok('planBatches keeps roster order, caps size, carries hosts', () => {
    const withH = missionsWithHorizons(ALL_MISSIONS);
    assert.ok(withH.length >= 30, `roster carries ${withH.length} Horizons candidates`);
    const batches = planBatches(ALL_MISSIONS, 12);
    assert.equal(batches.flatMap(b => b.ids).join(','), withH.map(m => m.id).join(','));
    for (const b of batches) {
        assert.ok(b.ids.length <= 12);
        assert.ok(b.hosts.includes('earth'));
        for (const id of b.ids) {
            const m = withH.find(x => x.id === id);
            if (m.host && HOST_COMMANDS[m.host]) assert.ok(b.hosts.includes(m.host), `${id} host ${m.host} in batch`);
        }
    }
    // every host named in the roster has a Horizons command
    for (const m of withH) if (m.host) assert.ok(HOST_COMMANDS[m.host], `${m.id}: host ${m.host} has a command`);
});

ok('distances, light time, speed', () => {
    assert.ok(Math.abs(distanceAU({ x_AU: 0, y_AU: 0, z_AU: 0 }, { x_AU: 3, y_AU: 4, z_AU: 0 }) - 5) < 1e-12);
    assert.ok(Math.abs(lightTimeMinutes(1) - 8.3167) < 1e-3);
    // 1 AU/day = 1731.46 km/s
    assert.ok(Math.abs(speedKms({ vx: 1, vy: 0, vz: 0 }) - 1731.456) < 0.01);
    assert.deepEqual(provenanceSummary([{ source: 'horizons' }, { source: 'sgp4' }, { source: 'model' }, { source: 'model' }, {}]),
        { horizons: 1, sgp4: 1, model: 2, none: 1 });
});

console.log(`mission-ephemeris.mjs: ${n} checks passed`);
