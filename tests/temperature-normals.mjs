/**
 * tests/temperature-normals.mjs — the Planetary Temperature Lab's normals reader
 *
 *   node tests/temperature-normals.mjs
 *
 * js/temperature-normals.js is gated against tests/fixtures/temperature/
 * normals-check.json, which scripts/build-temperature-normals.py computes in
 * PYTHON from the SAME quantised integers that ship in assets/temperature/.
 * A reader that agreed only with itself would pass a uniformly wrong format
 * (the SGP4 lesson in CLAUDE.md); this one must agree with the builder.
 *
 * Also gated:
 *   • R1, the harness: the area-weighted global mean of the Tmean normal
 *     reproduces Copernicus C3S's 1991–2020 figure (14.38 °C)
 *   • a file with the wrong magic, kind, grid or harmonic order is REFUSED
 *   • the local-solar-day offset is floor(lon/15 + 0.5), the builder's rule —
 *     NOT numpy's half-to-even round, which disagrees at the cell centres
 *     7.5° and −22.5°
 *   • quantile curves are non-decreasing after enforcement, the percentile is
 *     monotone in x and lands on the stored levels, the record envelope sits
 *     outside p01–p99
 *   • fitHarmonics recovers known coefficients and skips gaps
 *   • the phase is continuous across New Year (no seam in the normal)
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    CELLS, GRID, Q_LEVELS, VARS,
    cellCentre, cellIndex, cellSurface, climateClass, dailyNormal, fitHarmonics, globalMeanTmean,
    harmonicRow, hourlyNormal, localSolarDay, normalCdf, parseNormalsAsset, pentadOfDoy, percentileOf,
    position, quantileCurve, recordEnvelope, solarDayOffsetHours, yearPhase,
} from '../js/temperature-normals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = (name) => join(ROOT, 'assets', 'temperature', name);
const read = (name) => new Uint8Array(readFileSync(ASSET(name)));

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('temperature-normals.mjs');

const daily = parseNormalsAsset(read('normals-1991-2020.bin'));
const quantiles = parseNormalsAsset(read('quantiles-1991-2020.bin'));
const records = parseNormalsAsset(read('records-1991-2020.bin'));
const hourly = parseNormalsAsset(read('hourly-1991-2020.bin'));
const assets = { daily, quantiles, records };
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'temperature', 'normals-check.json'), 'utf8'));
const TOL = fixture.tolerance_K;

ok('all four files parse, and every header carries its provenance and its caveat', () => {
    for (const a of [daily, quantiles, records, hourly]) {
        assert.deepEqual(a.header.period, [1991, 2020]);
        assert.match(a.header.licence, /Copernicus Climate Change Service/);
        assert.match(a.header.representativeness, /BOX means/, 'the Phase-1b caveat must ride every file');
        assert.ok(a.tScale > 0);
    }
    assert.equal(daily.kind, 'daily');
    assert.equal(quantiles.kind, 'quantiles');
    assert.equal(records.kind, 'records');
    assert.equal(hourly.kind, 'hourly');
    assert.deepEqual(fixture.q_levels, [...Q_LEVELS]);
});

ok('a wrong magic, kind, grid or harmonic order is refused, never misread', () => {
    const good = read('normals-1991-2020.bin');
    const bad = good.slice(); bad[0] = 'X'.charCodeAt(0);
    assert.throws(() => parseNormalsAsset(bad), /bad magic/);
    const hlen = new DataView(good.buffer, good.byteOffset).getUint32(4, true);
    const mutate = (edit) => {
        const text = new TextDecoder().decode(good.subarray(8, 8 + hlen));
        const next = edit(text);
        assert.equal(next.length, text.length, 'mutation must keep the header length');
        const out = good.slice();
        out.set(new TextEncoder().encode(next), 8);
        return out;
    };
    assert.throws(() => parseNormalsAsset(mutate(t => t.replace('"w":72', '"w":71'))), /grid/);
    assert.throws(() => parseNormalsAsset(mutate(t => t.replace('"mean":4', '"mean":3'))), /layout/);
    assert.throws(() => parseNormalsAsset(mutate(t => t.replace('"kind":"daily"', '"kind":"dailx"'))), /layout/);
});

ok('the R1 harness: global mean Tmean normal reproduces C3S 1991–2020 (14.38 °C) within 0.05 K', () => {
    const g = globalMeanTmean(daily);
    assert.ok(Math.abs(g - 14.38) < 0.05, `global mean ${g.toFixed(3)} °C`);
});

ok('local solar day uses floor(lon/15 + 0.5), the builder\'s rule, at the half-hour cells', () => {
    assert.equal(solarDayOffsetHours(7.5), 1);          // numpy np.round(0.5) would say 0
    assert.equal(solarDayOffsetHours(-22.5), -1);       // np.round(-1.5) would say -2
    assert.equal(solarDayOffsetHours(-177.5), -12);
    assert.equal(solarDayOffsetHours(177.5), 12);
    assert.equal(solarDayOffsetHours(0), 0);
    const d = localSolarDay(Date.UTC(2026, 0, 1, 23, 30), 172.5);   // +12 h → already Jan 2 locally
    assert.equal(d.doy, 2);
    assert.equal(d.midpointMs, Date.UTC(2026, 0, 2));   // (day·24 − 12 + 12) h
    assert.equal(pentadOfDoy(1), 1);
    assert.equal(pentadOfDoy(365), 73);
    assert.equal(pentadOfDoy(366), 73);
});

ok(`fixture: ${fixture.cases.length} Python evaluations reproduced to ${TOL} K (daily, quantiles, records, hourly)`, () => {
    let worst = 0;
    const near = (a, b, what) => {
        const e = Math.abs(a - b);
        worst = Math.max(worst, e);
        assert.ok(e < TOL, `${what}: js ${a} vs py ${b}`);
    };
    for (const c of fixture.cases) {
        const where = `cell ${c.cell} @ ${new Date(c.t_ms).toISOString()}`;
        near(yearPhase(c.t_ms), c.phase, `${where} phase`);
        const lon = cellCentre(c.cell).lon;
        assert.equal(localSolarDay(c.t_ms, lon).doy, c.doy, `${where} doy`);
        const dn = dailyNormal(daily, c.cell, c.t_ms);
        for (const v of VARS) {
            near(dn[v].mean, c.daily[v].mean, `${where} ${v} mean`);
            near(dn[v].sd, c.daily[v].sd, `${where} ${v} sd`);
            const curve = quantileCurve(quantiles, c.cell, v, c.t_ms);
            c.vars[v].quantiles.forEach((q, k) => near(curve[k], q, `${where} ${v} q${k}`));
            const rec = recordEnvelope(records, c.cell, v, c.t_ms, curve);
            assert.equal(rec.pentad, c.pentad, `${where} pentad`);
            near(rec.max, c.vars[v].record.max, `${where} ${v} record max`);
            near(rec.min, c.vars[v].record.min, `${where} ${v} record min`);
            for (const pr of c.vars[v].probes) {
                const pos = position(assets, c.cell, v, c.t_ms, pr.x);
                assert.ok(Math.abs(pos.percentile - pr.percentile) < 1e-4, `${where} ${v} percentile(${pr.x}) js ${pos.percentile} vs py ${pr.percentile}`);
                assert.equal(pos.cls, pr.cls, `${where} ${v} class`);
                assert.equal(pos.beyondRecord, pr.beyondRecord, `${where} ${v} beyondRecord`);
            }
        }
        near(hourlyNormal(hourly, c.cell, c.t_ms), c.hourly_C, `${where} hourly`);
    }
    assert.ok(worst < 1e-6, `worst disagreement ${worst} K — float64 on both sides should agree far below the tolerance`);
});

ok('quantile curves are non-decreasing; percentile is monotone and lands on the stored levels', () => {
    const t = Date.UTC(2026, 6, 15, 12);
    for (const cell of [0, 777, 1300, 1800, CELLS - 1]) {
        for (const v of VARS) {
            const curve = quantileCurve(quantiles, cell, v, t);
            for (let k = 1; k < curve.length; k++) assert.ok(curve[k] >= curve[k - 1]);
            let last = -Infinity;
            for (let x = curve[0] - 15; x <= curve[8] + 15; x += 0.25) {
                const p = percentileOf(curve, x);
                assert.ok(p >= last && p >= 0 && p <= 100, `cell ${cell} ${v}: percentile not monotone at ${x}`);
                last = p;
            }
            // exactly on a level ⇒ that level, unless neighbouring levels tie
            if (curve[4] - curve[3] > 1e-6 && curve[5] - curve[4] > 1e-6) {
                assert.ok(Math.abs(percentileOf(curve, curve[4]) - 50) < 1e-9);
            }
            const rec = recordEnvelope(records, cell, v, t, curve);
            assert.ok(rec.max >= curve[8] && rec.min <= curve[0], 'a record cannot sit inside p01–p99');
        }
    }
});

ok('the lower tail is built on erfc: Φ(−9) is 1.13e-19, where 0.5·(1 + erf) cancels to exactly 0', () => {
    const p = normalCdf(-9);
    assert.ok(Math.abs(p / 1.1285884059538e-19 - 1) < 1e-6, `Φ(−9) = ${p}`);
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7 && Math.abs(normalCdf(1.6448536269514729) - 0.95) < 1e-7);
});

ok('climateClass uses climatePosition\'s thresholds exactly', () => {
    assert.equal(climateClass(9.999), 'much-below');
    assert.equal(climateClass(10), 'below');
    assert.equal(climateClass(33.33), 'below');
    assert.equal(climateClass(33.34), 'near');
    assert.equal(climateClass(66.66), 'near');
    assert.equal(climateClass(66.67), 'above');
    assert.equal(climateClass(90), 'above');
    assert.equal(climateClass(90.001), 'much-above');
});

ok('no seam at New Year: the normal is continuous from Dec 31 23:59 to Jan 1 00:01', () => {
    const a = Date.UTC(2026, 11, 31, 23, 59), b = Date.UTC(2027, 0, 1, 0, 1);
    for (const cell of [100, 1296, 2500]) {
        const x = dailyNormal(daily, cell, a), y = dailyNormal(daily, cell, b);
        for (const v of VARS) assert.ok(Math.abs(x[v].mean - y[v].mean) < 0.01, `cell ${cell} ${v}`);
        assert.ok(Math.abs(hourlyNormal(hourly, cell, a) - hourlyNormal(hourly, cell, b)) < 0.05);
    }
});

ok('the normals are physically sane: Tmin < Tmean < Tmax, Antarctic winter far below −60 °C', () => {
    let violations = 0;
    for (let cell = 0; cell < CELLS; cell += 7) {
        for (const m of [0, 3, 6, 9]) {
            const dn = dailyNormal(daily, cell, Date.UTC(2026, m, 15, 12));
            if (!(dn.tmin.mean < dn.tmean.mean && dn.tmean.mean < dn.tmax.mean)) violations++;
        }
    }
    assert.equal(violations, 0);
    // East Antarctic plateau, July: colder than the −60 °C texture clamp (plan §3.6)
    const plateau = cellIndex(-77.5, 102.5);
    assert.ok(dailyNormal(daily, plateau, Date.UTC(2026, 6, 15, 12)).tmin.mean < -60);
    const s = cellSurface(daily, plateau);
    assert.ok(s.landPct >= 50 && s.elevM > 2500, `plateau surface ${JSON.stringify(s)}`);
    const atlantic = cellSurface(daily, cellIndex(27.5, -42.5));
    assert.equal(atlantic.landPct, 0);
});

ok('fitHarmonics recovers known coefficients and skips gaps (a gap is not a zero)', () => {
    const truth = [12, 8, -3, 1.5, 0.5];
    const phases = [], values = [];
    for (let k = 0; k < 400; k++) {
        const ph = 2 * Math.PI * k / 400;
        const r = harmonicRow(ph, 2);
        phases.push(ph);
        values.push(k % 37 === 0 ? null : truth.reduce((s, c, i) => s + c * r[i], 0));
    }
    const got = fitHarmonics(phases, values, 2);
    truth.forEach((c, i) => assert.ok(Math.abs(got[i] - c) < 1e-9, `coef ${i}: ${got[i]}`));
    assert.throws(() => fitHarmonics([0, 1], [1, 2], 2), /finite samples/);
});

ok('cellIndex ↔ cellCentre round-trip; longitude wraps', () => {
    for (const cell of [0, 71, 72, 1295, CELLS - 1]) {
        const { lat, lon } = cellCentre(cell);
        assert.equal(cellIndex(lat, lon), cell);
        assert.equal(cellIndex(lat, lon + 360), cell);
    }
    assert.equal(GRID.w * GRID.h, CELLS);
});

ok('position() refuses a non-finite value rather than ranking it', () => {
    assert.equal(position(assets, 500, 'tmax', Date.UTC(2026, 3, 1), NaN), null);
    assert.equal(position(assets, 500, 'tmax', Date.UTC(2026, 3, 1), null), null);
    assert.throws(() => position(assets, 500, 'tdew', Date.UTC(2026, 3, 1), 3), /unknown variable/);
});

ok('the shipped bytes stay inside the plan\'s budget', () => {
    const size = (n) => statSync(ASSET(n)).size;
    assert.ok(size('normals-1991-2020.bin') < 260_000);
    assert.ok(size('hourly-1991-2020.bin') < 200_000);
    assert.ok(size('quantiles-1991-2020.bin') < 1_050_000);
    assert.ok(size('records-1991-2020.bin') < 2_400_000);
});

console.log(`\n${passed} passed`);
