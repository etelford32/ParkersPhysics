#!/usr/bin/env node
/**
 * fleet-assessment.mjs — gates js/fleet-assessment.js (the Storm-Season Fleet
 * Assessment kernel) and the committed sample bake.
 *
 *   1. A "storm" whose Ap equals the baseline costs exactly nothing — the
 *      replay and the quiet run are the same integration.
 *   2. A real storm costs altitude and lifetime; more Ap costs more.
 *   3. Extra loss scales ~linearly with B (the analytic ±σ_B band's premise).
 *   4. Hourly marching matches the msis-drag integrator's own rate.
 *   5. TLE → perigee/apogee/B and the Ap CSV parser.
 *   6. The committed data/marketing/sample-fleet-assessment.json is what
 *      the baker produces today (re-run it if this fails).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    assessSpacecraft, marchHourly, elementsFromTle, parseApCsv, apAt,
    ballisticFromSpacecraft, RE_KM,
} from '../js/fleet-assessment.js';
import { orbitAverageRates } from '../js/operations/msis-drag.js';

let passed = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); passed++; };

// Analytic exponential atmosphere whose base density scales with Ap.
const profileFor = (f107, ap) => {
    const n = 151, alt0 = 90, step = 10;
    const scale = 1 + ap / 50;
    const rho = Float64Array.from({ length: n }, (_, i) =>
        scale * 3e-12 * Math.exp(-((alt0 + i * step) - 400) / 60));
    return { alt0, step, rho };
};
const baseline = { f107: 150, ap: 7 };
const t0 = Date.UTC(2024, 4, 8);
const flat = (ap) => Array.from({ length: 16 }, (_, i) => ({ tMs: t0 + i * 3 * 3600e3, ap }));
const sc = { id: 'T', perigeeKm: 420, apogeeKm: 420, bc: 0.011, bcSigmaFrac: 0.25 };

{
    const r = assessSpacecraft(sc, { profileFor, baseline, events: [{ key: 'q', label: 'q', series: flat(7) }] });
    const e = r.events[0];
    assert.equal(e.extraLossKm, 0, 'baseline-Ap storm adds no loss');
    assert.ok(Math.abs(e.lifetimeLostDays) < 0.05, `baseline-Ap storm costs no life (${e.lifetimeLostDays})`);
    ok('a storm at the baseline Ap costs nothing');
}
{
    const r = assessSpacecraft(sc, { profileFor, baseline, events: [
        { key: 'm', label: 'm', series: flat(50) }, { key: 'x', label: 'x', series: flat(300) }] });
    const [m, x] = r.events;
    assert.ok(m.extraLossKm > 0 && x.extraLossKm > m.extraLossKm, 'more Ap, more loss');
    assert.ok(m.lifetimeLostDays > 0 && x.lifetimeLostDays > m.lifetimeLostDays, 'more Ap, more life lost');
    assert.ok(x.dragRatioPeak > m.dragRatioPeak && m.dragRatioPeak > 1, 'drag ratio ordered');
    assert.ok(r.quiet.lifetimeBandDays[0] < r.quiet.lifetimeDays && r.quiet.lifetimeBandDays[1] > r.quiet.lifetimeDays);
    ok('storms cost altitude and lifetime, monotone in Ap');
}
{
    const ev = [{ key: 'x', label: 'x', series: flat(150) }];
    const a = assessSpacecraft(sc, { profileFor, baseline, events: ev }).events[0].extraLossKm;
    const b = assessSpacecraft({ ...sc, bc: 2 * sc.bc }, { profileFor, baseline, events: ev }).events[0].extraLossKm;
    assert.ok(Math.abs(b / a - 2) < 0.03, `extra loss ∝ B (ratio ${b / a})`);
    ok('extra loss scales linearly with B');
}
{
    const p = profileFor(150, 7);
    const rhoAt = (alt) => {
        const x = (alt - p.alt0) / p.step, i = Math.floor(x), f = x - i;
        return Math.exp(Math.log(p.rho[i]) * (1 - f) + Math.log(p.rho[i + 1]) * f);
    };
    const m = marchHourly({ perigeeKm: 420, apogeeKm: 420, bc: 0.011, hours: 24, rhoAtFor: () => rhoAt });
    const rate = orbitAverageRates(RE_KM + 420, 0, 0.011, rhoAt).adotKmDay;
    const lost = m.meanAlt[0] - m.meanAlt[24];
    assert.ok(Math.abs(lost + rate) / Math.abs(rate) < 0.01, `24 h march ≈ one day at ȧ (${lost} vs ${-rate})`);
    ok('hourly march agrees with the msis-drag rate');
}
{
    const l1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0  30777-3 0  2927';
    const l2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
    const el = elementsFromTle(l1, l2, { name: 'ISS' });
    assert.equal(el.id, '25544');
    assert.ok(el.perigeeKm > 330 && el.perigeeKm < 360 && el.apogeeKm > el.perigeeKm, `ISS 2008 perigee ${el.perigeeKm}`);
    assert.ok(Math.abs(el.bc - 0.30777e-3 * 12.741621) < 1e-9);
    assert.equal(elementsFromTle('junk', null), null);
    assert.ok(Math.abs(ballisticFromSpacecraft({ massKg: 4, areaM2: 0.02 }) - 0.011) < 1e-12);
    const s = parseApCsv('t,ap,f107_sfu\n2024-05-08T03:00:00Z,6,200\n2024-05-08T00:00:00Z,4,200\n');
    assert.equal(s[0].ap, 4);
    assert.equal(apAt(s, Date.parse('2024-05-08T04:00:00Z')), 6);
    ok('TLE elements, B from mass/area, Ap CSV + step-hold');
}
{
    const dir = mkdtempSync(join(tmpdir(), 'fa-'));
    const out = join(dir, 'a.json');
    execFileSync(process.execPath, ['scripts/build-sample-fleet-assessment.mjs', '--out', out], { stdio: 'pipe' });
    const fresh = await readFile(out, 'utf8');
    const committed = await readFile('data/marketing/sample-fleet-assessment.json', 'utf8');
    assert.equal(fresh, committed, 'committed sample bake is stale — re-run scripts/build-sample-fleet-assessment.mjs');
    const doc = JSON.parse(committed);
    assert.equal(doc.kind, 'illustrative');
    assert.deepEqual(doc.events.map(e => e.peakAp), [56, 400], 'real GFZ peaks: Feb-2022 56, Gannon 400');
    assert.ok(doc.starlink.maxDragRatioFirst48h > 1 && doc.starlink.maxDragRatioFirst48h < 1.5,
        'MSIS + real Ap stays below SpaceX\'s reported ×1.5 (the page\'s story)');
    ok('committed sample bake is current and carries the real storm peaks');
}

console.log(`\nfleet-assessment: ${passed} checks passed`);
