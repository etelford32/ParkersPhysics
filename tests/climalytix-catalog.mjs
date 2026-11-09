#!/usr/bin/env node
/**
 * climalytix-catalog.mjs — node gate for js/climalytix/catalog.js: the dataset
 * table, the four PURE adapters, and the workspace normaliser.
 *
 * The station adapter is fed the Climate Lab's OWN closed-form fixture through
 * the lab's OWN normaliser (lab-feed.js normalizeLabResponse) — Climalytix
 * reads the Home Station, it does not re-parse its route (plan §15).
 *
 *   node tests/climalytix-catalog.mjs
 */

import assert from 'node:assert/strict';
import {
    PANELS, DATASETS, SERIES_IDS, variableSpec, adaptArchive, adaptStation,
    adaptTeleconnections, adaptApHistory, utcDateMs, normalizeWorkspace,
    DEFAULT_WORKSPACE, RANGE_IDS, adaptNwp, SLOT_COUNT, ROLES,
} from '../js/climalytix/catalog.js';
import { QUANTITIES } from '../js/climate-lab/lab-units.js';
import { normalizeLabResponse } from '../js/climate-lab/lab-feed.js';
import { labFixture, STATION } from './fixtures/climate-lab-fixtures.mjs';
import { HOUR_MS, DAY_MS, valueAt } from '../js/climalytix/series.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const NOW = Date.UTC(2026, 10, 8, 18, 0, 0);

console.log('climalytix catalog');

ok('every variable names a real panel, a lab-units quantity and a free colour slot', () => {
    const panelIds = new Set(PANELS.map((p) => p.id));
    const slots = new Map();
    for (const d of DATASETS) {
        assert.match(d.route, /^\/api\//, `${d.id}: same-origin route`);
        for (const v of d.variables) {
            assert.ok(panelIds.has(v.panel), `${d.id}.${v.key}: panel ${v.panel}`);
            assert.ok(QUANTITIES[v.quantity], `${d.id}.${v.key}: quantity ${v.quantity} is a lab-units quantity`);
            const panel = PANELS.find((p) => p.id === v.panel);
            assert.equal(v.quantity, panel.quantity, `${d.id}.${v.key}: one panel = one quantity = one y axis`);
            assert.ok(Number.isInteger(v.slot) && v.slot >= 0 && v.slot < SLOT_COUNT, `${d.id}.${v.key}: slot 0–${SLOT_COUNT - 1}`);
            const key = `${v.panel}:${v.slot}`;
            assert.ok(!slots.has(key), `${d.id}.${v.key}: slot ${key} already used by ${slots.get(key)}`);
            slots.set(key, `${d.id}.${v.key}`);
        }
    }
    assert.equal(new Set(SERIES_IDS).size, SERIES_IDS.length, 'series ids unique');
    assert.equal(variableSpec('era5.tmax').agg, 'max');
    assert.equal(variableSpec('nope.x'), null);
});

ok('adaptArchive: daily ERA5 series with gaps kept and provenance carried', () => {
    const t0 = Date.UTC(2026, 0, 1) + 7 * HOUR_MS;   // local midnight at UTC−7
    const j = {
        source: 'test archive', freshness: 'live',
        site: { lat: 40, lon: -105.25, utc_offset_seconds: -7 * 3600, distance_km: 2.1 },
        daily: { t: [t0, t0 + DAY_MS, t0 + 2 * DAY_MS], tmax: [10, null, 12], tmin: [0, 1, 2], precip: [0, 5.5, null] },
    };
    const { series, utcOffsetS } = adaptArchive(j, NOW);
    assert.equal(utcOffsetS, -7 * 3600);
    const byId = Object.fromEntries(series.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), ['era5.precip', 'era5.tmax', 'era5.tmin'], 'only the variables present');
    assert.equal(byId['era5.tmax'].kind, 'reanalysis');
    assert.equal(byId['era5.tmax'].cadenceMs, DAY_MS);
    assert.equal(valueAt(byId['era5.tmax'], t0 + DAY_MS), null, 'gap survives');
    assert.equal(valueAt(byId['era5.precip'], t0 + 2 * DAY_MS), null, 'a missing precip day is a gap, not dry');
    assert.equal(byId['era5.precip'].agg, 'sum');
    assert.equal(byId['era5.tmax'].provenance.fetchedAt, NOW);
    assert.equal(byId['era5.tmax'].spatial.distanceKm, 2.1);
    assert.deepEqual(adaptArchive({ freshness: 'stale' }, NOW).series, [], 'empty when the route is degraded');
});

ok('adaptStation reads the Home Station through the lab’s own normaliser', () => {
    const obs = normalizeLabResponse(labFixture(NOW));
    assert.ok(obs, 'fixture normalises');
    const { series, utcOffsetS } = adaptStation(obs, NOW);
    assert.equal(utcOffsetS, STATION.utcOffsetS);
    const temp = series.find((s) => s.id === 'station.tempC');
    assert.ok(temp && temp.kind === 'forecast' && temp.cadenceMs === HOUR_MS);
    assert.equal(temp.t.length, obs.hourly.t.filter((x) => x != null).length);
    assert.equal(temp.issuedAt, NOW, 'issue time = fetch time, and the note says so');
    assert.match(temp.provenance.note, /not station observations/);
    const iNow = obs.hourly.t.findIndex((t) => t != null && t >= Math.floor(NOW / HOUR_MS) * HOUR_MS);
    assert.equal(valueAt(temp, obs.hourly.t[iNow]), obs.hourly.tempC[iNow] == null ? null : Math.fround(obs.hourly.tempC[iNow]));
    assert.equal(series.find((s) => s.id === 'station.precipMm').agg, 'sum');
    assert.equal(series.find((s) => s.id === 'station.gustMs').agg, 'max');
    assert.deepEqual(adaptStation(null, NOW).series, []);
});

ok('adaptTeleconnections: UTC-dated daily indices, junk rows dropped', () => {
    assert.equal(utcDateMs('2026-11-01'), Date.UTC(2026, 10, 1));
    assert.equal(utcDateMs('11/01/2026'), null);
    const j = {
        freshness: 'live',
        ao: { history: [{ date: '2026-11-01', value: -1.2 }, { date: 'bad', value: 3 }, { date: '2026-11-02', value: null }] },
        nao: { history: [{ date: '2026-11-01', value: 0.4 }] },
    };
    const { series } = adaptTeleconnections(j, NOW);
    const ao = series.find((s) => s.id === 'drivers.ao');
    assert.deepEqual(Array.from(ao.t), [Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2)]);
    assert.equal(valueAt(ao, Date.UTC(2026, 10, 1)), Math.fround(-1.2));
    assert.equal(valueAt(ao, Date.UTC(2026, 10, 2)), null);
    assert.equal(ao.kind, 'index');
    assert.equal(adaptTeleconnections({}, NOW).series.length, 0);
});

ok('adaptApHistory: observed and predicted are SEPARATE series of different kinds', () => {
    const j = {
        freshness: 'live', stale: false,
        data: { rows: [
            { t: '2026-11-08T00:00:00Z', ap: 7, kind: 'observed' },
            { t: '2026-11-08T03:00:00Z', ap: 15, kind: 'observed' },
            { t: '2026-11-09T00:00:00Z', ap: 12, kind: 'predicted' },
            { t: 'garbage', ap: 99, kind: 'observed' },
            { t: '2026-11-09T03:00:00Z', ap: 5, kind: 'unknown' },
        ] },
    };
    const { series } = adaptApHistory(j, NOW);
    const obs = series.find((s) => s.id === 'geomag.apObs');
    const pred = series.find((s) => s.id === 'geomag.apPred');
    assert.equal(obs.kind, 'observed');
    assert.equal(pred.kind, 'forecast', 'a forecast is never labelled an observation');
    assert.equal(obs.t.length, 2);
    assert.equal(pred.t.length, 1);
    assert.equal(pred.issuedAt, NOW);
    assert.equal(adaptApHistory({ stale: true, data: { rows: j.data.rows } }, NOW).series[0].provenance.freshness, 'stale');
});

ok('normalizeWorkspace degrades field by field and never throws', () => {
    assert.deepEqual(normalizeWorkspace(null), { ...DEFAULT_WORKSPACE, on: [...DEFAULT_WORKSPACE.on], known: [...DEFAULT_WORKSPACE.known], units: { preset: 'auto' } });
    const w = normalizeWorkspace({ v: 99, range: 'forever', on: ['era5.tmax', 'era5.tmax', 'evil.x'], known: SERIES_IDS, units: { preset: 'klingon' }, historyFrom: 1800 });
    assert.equal(w.range, '30d');
    assert.deepEqual(w.on, ['era5.tmax'], 'unknown ids dropped, duplicates collapsed');
    assert.equal(w.units.preset, 'auto');
    assert.equal(w.historyFrom, 1940, 'clamped to the ERA5 start');
    assert.equal(normalizeWorkspace({ historyFrom: 2050 }).historyFrom, 2020);
    assert.equal(normalizeWorkspace({ range: '10y' }).range, '10y');
    assert.ok(RANGE_IDS.includes(DEFAULT_WORKSPACE.range));
    for (const id of DEFAULT_WORKSPACE.on) assert.ok(variableSpec(id).defaultOn);
});

ok('a workspace saved before a dataset existed gets its defaults ONCE; an uncheck sticks', () => {
    // A P0 (v1) doc: no `known`, an explicit `on` without any gfs series.
    const v1 = { v: 1, range: '30d', on: ['era5.tmax', 'station.tempC'], units: { preset: 'auto' }, historyFrom: 1991 };
    const w = normalizeWorkspace(v1);
    assert.equal(w.v, 2);
    for (const id of ['gfs.tempC', 'gfs.precipMm', 'gfs.windMs', 'gfs.mslHpa']) assert.ok(w.on.includes(id), `${id} switched on`);
    assert.ok(!w.on.includes('gfs.rhPct'), 'a default-OFF new series stays off');
    assert.ok(!w.on.includes('era5.tmin'), 'a v1 series the user had off stays off');
    // The user then unchecks gfs.tempC: it is KNOWN now and must not come back.
    const after = normalizeWorkspace({ ...w, on: w.on.filter((id) => id !== 'gfs.tempC') });
    assert.ok(!after.on.includes('gfs.tempC'), 'an uncheck is respected');
    assert.deepEqual(normalizeWorkspace(after), after, 'normalising is idempotent');
});

ok('every dataset has a role the page can badge; ours is listed first', () => {
    for (const d of DATASETS) assert.ok(ROLES[d.role], `${d.id}: role`);
    assert.equal(DATASETS[0].id, 'gfs');
    assert.equal(DATASETS[0].role, 'archive');
    assert.ok(DATASETS.filter((d) => d.role === 'archive').every((d) => d.route.startsWith('/api/climalytix/')));
});

ok('adaptNwp: our archive’s wire body → SiteSeries, issued at the run, precip at interval start', () => {
    const run = Date.UTC(2026, 10, 8, 0);
    const H = 3_600_000;
    const body = {
        source: 'climalytix-gfs', run: '2026-11-08T00:00Z', runMs: run, grid: '0p25', freshness: 'fresh', age_seconds: 7 * 3600,
        times: [run, run + 3 * H, run + 6 * H], intervalH: { precipMm: 3 },
        series: { tempC: [1, 2, null], precipMm: [null, 0.4, 1.2], windMs: [3, 4, 5], mslHpa: [1010, 1011, 1012] },
    };
    const { series, run: r } = adaptNwp(body, run + 8 * H);
    assert.equal(r, '2026-11-08T00:00Z');
    const by = Object.fromEntries(series.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(by).sort(), ['gfs.mslHpa', 'gfs.precipMm', 'gfs.tempC', 'gfs.windMs']);
    assert.equal(by['gfs.tempC'].issuedAt, run);
    assert.equal(by['gfs.tempC'].provenance.fetchedAt, run + 8 * H, 'fetched ≠ issued');
    assert.equal(by['gfs.tempC'].provenance.freshness, 'live', "the route's 'fresh' is the page's 'live'");
    assert.ok(Number.isNaN(by['gfs.tempC'].v[2]), 'a gap is NaN, never 0');
    assert.deepEqual([...by['gfs.precipMm'].t], [run - 3 * H, run, run + 3 * H], 'amounts stamped at interval start');
    assert.equal(by['gfs.precipMm'].agg, 'sum');
    assert.equal(adaptNwp({ freshness: 'expired', series: null }, run).series.length, 0, 'a degraded body yields no series');
    assert.equal(adaptNwp({ ...body, freshness: 'stale' }, run).series[0].provenance.freshness, 'stale');
});

console.log(`\n${passed} passed`);
