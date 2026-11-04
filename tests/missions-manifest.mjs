/**
 * Gate for js/missions-manifest.js — the launch manifest + just-launched rails.
 *   node tests/missions-manifest.mjs
 */
import assert from 'node:assert/strict';
import {
    fmtCountdown, launchStatusClass, manifestRows, classifyObject, orbitClass,
    launchDateFromObjectId, recentObjects, subPoint, gmstDeg,
} from '../js/missions-manifest.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
console.log('missions-manifest.mjs');
const H = 3600000, D = 24 * H;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

ok('countdown strings', () => {
    assert.equal(fmtCountdown(3 * D + 4 * H + 5 * 60000), 'T−3d 04h');
    assert.equal(fmtCountdown(5 * H + 7 * 60000), 'T−5h 07m');
    assert.equal(fmtCountdown(41 * 60000 + 12000), 'T−00:41:12');
    assert.equal(fmtCountdown(-(H + 5 * 60000)), 'T+1h 05m');
    assert.equal(fmtCountdown(0), 'T−00:00:00');
});

ok('status classes', () => {
    assert.equal(launchStatusClass('Go'), 'go');
    assert.equal(launchStatusClass('TBC'), 'tbc');
    assert.equal(launchStatusClass('Success'), 'success');
    assert.equal(launchStatusClass(undefined), 'other');
});

ok('manifest: window, grace, sort, cap, fields', () => {
    const L = (name, offMs, extra = {}) => ({ id: name, name, net_iso: new Date(NOW + offMs).toISOString(), vehicle: 'Falcon 9', provider: 'SpaceX', status: 'Go', pad: { name: 'SLC-40', location: 'Cape Canaveral', lat: 28.56, lon: -80.58 }, ...extra });
    const launches = [
        L('late', 40 * D), L('b', 2 * D), L('a', 3 * H), L('old', -7 * H), L('justflown', -2 * H, { status: 'Success' }),
        { id: 'nonet', name: 'no net', net_iso: null },
    ];
    const { rows, total } = manifestRows(launches, NOW, { limit: 3 });
    assert.equal(total, 3, 'old (−7 h) and late (+40 d) dropped; just-flown kept');
    assert.deepEqual(rows.map(r => r.name), ['justflown', 'a', 'b']);
    assert.equal(rows[0].countdown, 'T+2h 00m');
    assert.equal(rows[0].status_class, 'success');
    assert.equal(rows[1].pad, 'SLC-40 · Cape Canaveral');
    assert.equal(rows[1].pad_lat, 28.56);
    const capped = manifestRows(launches, NOW, { limit: 1 });
    assert.equal(capped.rows.length, 1);
    assert.equal(capped.total, 3);
    assert.deepEqual(manifestRows(null, NOW), { rows: [], total: 0 });
});

ok('object classification from the catalogue name', () => {
    assert.equal(classifyObject('FALCON 9 R/B'), 'rocket-body');
    assert.equal(classifyObject('CZ-3B R/B'), 'rocket-body');
    assert.equal(classifyObject('STARLINK-35001'), 'payload');
    assert.equal(classifyObject('FENGYUN 1C DEB'), 'debris');
    assert.equal(classifyObject('ORBITAL DEBRIS SHIELD'), 'payload');
});

ok('orbit classes from OMM shape', () => {
    assert.equal(orbitClass({ perigee_km: 400, apogee_km: 420, eccentricity: 0.001 }), 'LEO');
    assert.equal(orbitClass({ perigee_km: 250, apogee_km: 35800, eccentricity: 0.73 }), 'GTO');
    assert.equal(orbitClass({ perigee_km: 35780, apogee_km: 35800, eccentricity: 0.0003 }), 'GEO');
    assert.equal(orbitClass({ perigee_km: 20100, apogee_km: 20300, eccentricity: 0.005 }), 'MEO');
    assert.equal(orbitClass({ perigee_km: 1000, apogee_km: 400000, eccentricity: 0.96 }), 'beyond GEO');
    assert.equal(orbitClass({}), '—');
});

ok('international designator → launch date', () => {
    assert.equal(launchDateFromObjectId('2026-120A'), Date.UTC(2026, 0, 1) + 119 * D);
    assert.equal(launchDateFromObjectId('garbage'), null);
});

ok('recent objects: newest launch first, age cut, counts, siblings grouped', () => {
    const rec = (norad, name, oid, extra = {}) => ({ norad_id: norad, name, object_id: oid, perigee_km: 300, apogee_km: 320, eccentricity: 0.001, inclination: 53, period_min: 90.5, epoch_ms: NOW, ...extra });
    const id = (dayOfYear, piece) => `2026-${String(dayOfYear).padStart(3, '0')}${piece}`;
    const doy = Math.floor((NOW - Date.UTC(2026, 0, 1)) / D) + 1;     // today ≈ 307
    const records = [
        rec(70001, 'OLD SAT', id(doy - 45, 'A')),
        rec(70010, 'STARLINK-99', id(doy - 2, 'A')),
        rec(70011, 'FALCON 9 R/B', id(doy - 2, 'B')),
        rec(70020, 'MMX', id(doy - 14, 'A'), { perigee_km: 200, apogee_km: 900000, eccentricity: 0.98 }),
        rec(70021, 'H3 R/B', id(doy - 14, 'B'), { perigee_km: 200, apogee_km: 900000, eccentricity: 0.98 }),
        { norad_id: 'x' },
    ];
    const { rows, total, counts } = recentObjects(records, NOW);
    assert.equal(total, 4, 'the 45-day-old object is dropped');
    assert.deepEqual(rows.map(r => r.name), ['STARLINK-99', 'FALCON 9 R/B', 'MMX', 'H3 R/B']);
    assert.equal(rows[1].kind, 'rocket-body');
    assert.equal(rows[2].orbit_class, 'beyond GEO');
    assert.equal(rows[0].launch_key, rows[1].launch_key);
    assert.deepEqual(counts, { payload: 2, 'rocket-body': 2, debris: 0, launches: 2 });
    assert.ok(rows[0].tle === records[1], 'row carries the record for propagation');
});

ok('sub-point + GMST', () => {
    // J2000.0 epoch: GMST = 280.46°
    assert.ok(Math.abs(gmstDeg(2451545.0) - 280.46) < 0.01);
    const p = subPoint({ x: 7000, y: 0, z: 0 }, 0);
    assert.ok(Math.abs(p.lat) < 1e-12 && Math.abs(p.lon) < 1e-12 && Math.abs(p.alt_km - 629) < 1e-9);
    const q = subPoint({ x: 0, y: 7000, z: 0 }, 100);
    assert.ok(Math.abs(q.lon - (-10)) < 1e-9, `lon ${q.lon}`);
});

console.log(`missions-manifest.mjs: ${n} checks passed`);
