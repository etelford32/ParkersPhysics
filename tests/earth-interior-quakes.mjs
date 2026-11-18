#!/usr/bin/env node
/**
 * earth-interior-quakes.mjs — gate for js/earth-interior/quake-model.js (the
 * live earthquake view's numbers). Run: node tests/earth-interior-quakes.mjs
 *
 * Feed parsing never invents a value; the default pick prefers waves that are
 * still in the Earth; the slice contains both endpoints; arrivals are the
 * phase kernel's own (first per phase, the ellipticity correction applied,
 * wall-clock instants); the drawn rays end AT the viewer; the wavefronts sit
 * where the waves are (an early P front is a ~v·t sphere, S lags P); and the
 * list's binned "≈" first arrival is honest to the stated 2 s.
 */

import assert from 'node:assert/strict';
import {
    parseUsgsFeed, mergeQuakes, pickDefaultQuake, siteFromLocation, FALLBACK_SITE, slicePlane, planePoint, arrivalsAt,
    rayToSite, buildFan, wavefronts, positionAt, packPath, liveState, fmtDuration, quickFirstArrival, WAVE_WINDOW_S, geoVec,
    siteWithElevation,
} from '../js/earth-interior/quake-model.js';
import { travelTimeTable, arrivals } from '../js/earth-interior/phases.js';
import { pathGeometry } from '../js/earth-interior/ellipticity.js';
import { seismicSliceTable, SLICE_LAYER_COLORS } from '../js/earth-interior/page-model.js';
import { R_EARTH_KM } from '../js/earth-interior/prem.js';

let passed = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); passed++; };
const DEG = Math.PI / 180;
const T0 = Date.parse('2026-11-18T12:00:00Z');
const feat = (id, lat, lon, d, mag, t, extra = {}) => ({ id, geometry: { coordinates: [lon, lat, d] }, properties: { mag, time: t, updated: t, place: `${id} place`, ...extra } });

// ── feed ────────────────────────────────────────────────────────────────────
{
    const rows = parseUsgsFeed({ features: [
        feat('a', 38.3, 142.4, 30, 7.4, T0),
        feat('noMag', 10, 10, 10, null, T0),
        { id: 'noGeom', properties: { mag: 5, time: T0 } },
        feat('noTime', 10, 10, 10, 5, undefined),
        feat('badLat', 95, 10, 10, 5, T0),
        feat('shallow', 19.4, -155.3, -1.2, 3.1, T0, { status: 'automatic' }),
    ] });
    assert.deepEqual(rows.map((r) => r.id), ['a', 'shallow']);
    const sh = rows[1];
    assert.equal(sh.depthKm, 0); assert.equal(sh.depthReportedKm, -1.2); assert.equal(sh.status, 'automatic');
    assert.equal(parseUsgsFeed(null).length, 0);
    const m = mergeQuakes(
        [{ id: 'x', timeMs: 1, updatedMs: 1, mag: 5 }, { id: 'y', timeMs: 3, updatedMs: 1, mag: 4 }],
        [{ id: 'x', timeMs: 2, updatedMs: 5, mag: 5.2 }]);
    assert.deepEqual(m.map((q) => `${q.id}:${q.mag}`), ['y:4', 'x:5.2']);
    ok('feed: a missing magnitude / geometry / time / an impossible latitude DROPS the row (never 0, the equator or now); above-sea depth floors at 0 and keeps the reported value; merge keeps the newest revision, newest first');
}
{
    const old6 = { id: 'big', mag: 6.8, timeMs: T0 - 3 * 3600e3 };
    const live = { id: 'live', mag: 5.1, timeMs: T0 - 600e3 };
    const small = { id: 'small', mag: 3.0, timeMs: T0 - 60e3 };
    assert.equal(pickDefaultQuake([small, live, old6], T0).quake.id, 'live');
    assert.equal(pickDefaultQuake([small, live, old6], T0).reason, 'live');
    assert.equal(pickDefaultQuake([small, old6], T0).quake.id, 'big');
    assert.equal(pickDefaultQuake([{ ...live, timeMs: T0 - (WAVE_WINDOW_S + 5) * 1e3 }, old6], T0).quake.id, 'big');
    assert.equal(pickDefaultQuake([small], T0).quake.id, 'small');
    assert.equal(pickDefaultQuake([], T0).quake, null);
    ok('default pick: waves still in the Earth win over a larger older event; then the newest M6+, then M4.5+; an empty feed picks nothing');
}
{
    assert.equal(siteFromLocation(null).fallback, true);
    assert.equal(siteFromLocation({ lat: 'x' }).name, FALLBACK_SITE.name);
    const s = siteFromLocation({ lat: 40, lon: 255, city: 'Boulder' });
    assert.equal(s.fallback, false); assert.equal(s.lon, -105); assert.equal(s.name, 'Boulder');
    ok('site: the stored location, longitude wrapped; nothing stored ⇒ the FLAGGED NEIC fallback');
}

// ── geometry ────────────────────────────────────────────────────────────────
const quake = { id: 't', lat: 38.3, lon: 142.4, depthKm: 29, mag: 9.1, timeMs: T0 };
const site = siteFromLocation({ lat: 40.015, lon: -105.27, city: 'Boulder' });
{
    const p = slicePlane(quake, site), geo = pathGeometry(quake.lat, quake.lon, site.lat, site.lon);
    const d = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    assert.ok(Math.abs(d(p.e1, p.e2)) < 1e-12 && Math.abs(Math.hypot(...p.n) - 1) < 1e-12);
    assert.ok(Math.abs(p.siteAngleRad - geo.deltaRad) < 1e-12, 'the site lies in the slice at the geocentric Δ');
    const u = geoVec(site.lat, site.lon), at = planePoint(p, R_EARTH_KM, p.siteAngleRad);
    assert.ok(Math.hypot(...u.map((x, i) => x - at[i])) < 1e-12, 'planePoint(R, Δ) IS the site');
    const same = slicePlane(quake, { lat: quake.lat, lon: quake.lon });
    assert.equal(same.degenerate, true); assert.ok(Math.abs(Math.hypot(...same.n) - 1) < 1e-12);
    ok(`slice: orthonormal, the site sits in it at exactly the geocentric Δ (${geo.deltaDeg.toFixed(2)}°); a site at the epicentre falls back to the meridian`);
}

const table = travelTimeTable(quake.depthKm);
const A = arrivalsAt(quake, site, table);
{
    const names = A.rows.map((r) => r.phase);
    assert.equal(new Set(names).size, names.length, 'one row per phase');
    for (let i = 1; i < A.rows.length; i++) assert.ok(A.rows[i].totalS >= A.rows[i - 1].totalS);
    const raw = arrivals(A.geometry.deltaDeg, table);
    for (const r of A.rows) {
        assert.equal(r.timeS, raw.find((a) => a.phase === r.phase).timeS, 'the FIRST arrival of the phase');
        assert.ok(Math.abs(r.totalS - (r.timeS + r.corrS)) < 1e-9 && Math.abs(r.arriveMs - (T0 + r.totalS * 1000)) < 1e-6);
        assert.ok(Math.abs(r.corrS) < 3, `${r.phase} ellipticity ${r.corrS}`);
    }
    const P = A.rows.find((r) => r.phase === 'P');
    assert.ok(P && P.totalS > 715 && P.totalS < 740, `P ${P?.totalS}`);
    assert.ok(A.rows.some((r) => r.phase === 'SKS') && A.rows.some((r) => r.phase === 'ScS'));
    ok(`arrivals: one first arrival per phase, earliest first, = the phase kernel's + its ellipticity correction; Tohoku → Boulder P ${P.totalS.toFixed(1)} s (${(P.corrS).toFixed(2)} s ellipticity), ${A.rows.length} phases`);
}
{
    let worst = 0;
    for (const r of A.rows) {
        const path = rayToSite(r, quake);
        const end = path.at(-1);
        const wrapped = ((end.phi - A.geometry.deltaRad) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
        worst = Math.max(worst, Math.abs(wrapped), Math.abs(end.rKm - R_EARTH_KM));
        assert.ok(Math.abs(path[0].rKm - (R_EARTH_KM - quake.depthKm)) < 1e-6, 'starts at the source');
    }
    assert.ok(worst < 2e-3, `ray ends ${worst}`);   // interpolated p ⇒ the traced ray lands within ~0.1° of the site
    ok(`every drawn ray starts at the hypocentre and ends at the viewer (worst ${(worst / DEG).toFixed(3)}°, the interpolation in p), the long-way phases from the other side`);
}
{
    const fan = buildFan(table, quake.depthKm);
    // An early P front is a sphere of radius ≈ v·t around the hypocentre (crust/upper-mantle speeds).
    const src = [R_EARTH_KM - quake.depthKm, 0];
    const xy = (r, phi) => [r * Math.cos(phi), r * Math.sin(phi)];
    const distFromSrc = (q) => { const a = xy(q.rKm, q.phi), b = xy(...src); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
    const at = (t, wave) => wavefronts(fan, t).filter((f) => f.phase === wave).flatMap((f) => f.points);
    const p20 = at(20, 'P').map(distFromSrc), s20 = at(20, 'S').map(distFromSrc);
    assert.ok(p20.length > 10 && Math.min(...p20) > 6.0 * 20 * 0.85 && Math.max(...p20) < 8.2 * 20 * 1.05, `P @20 s ${Math.min(...p20)}–${Math.max(...p20)}`);
    assert.ok(Math.max(...s20) < Math.min(...p20), 'S lags P');
    // positionAt interpolates and refuses outside the path.
    const path = packPath([{ rKm: 100, deltaRad: 0, tS: 0, wave: 'P' }, { rKm: 200, deltaRad: 1, tS: 10, wave: 'S' }]);
    assert.deepEqual(positionAt(path, 5), { rKm: 150, deltaRad: 0.5, wave: 'S' });
    assert.equal(positionAt(path, -1), null); assert.equal(positionAt(path, 11), null);
    ok(`wavefronts: at 20 s the P front is a ${Math.min(...p20).toFixed(0)}–${Math.max(...p20).toFixed(0)} km sphere about the hypocentre (6–8 km/s × t) and S trails it; positionAt interpolates and refuses outside a path`);
}
{
    const s1 = liveState(quake, A.rows, T0 + 100e3), s2 = liveState(quake, A.rows, T0 + 5 * 3600e3);
    assert.equal(s1.inFlight, true); assert.equal(s1.arrived, 0); assert.equal(s1.next.phase, A.rows[0].phase);
    assert.equal(s2.inFlight, false); assert.equal(s2.arrived, A.rows.length); assert.equal(s2.next, null);
    assert.equal(fmtDuration(65), '1 min 05 s'); assert.equal(fmtDuration(59.6), '1 min 00 s'); assert.equal(fmtDuration(7200), '2.0 h'); assert.equal(fmtDuration(NaN), '—');
    ok('live state: in flight until the last phase arrives, the next arrival named; durations formatted');
}
{
    // The list's ≈ first arrival (interpolated between depth bins) must be within the stated 2 s of the exact depth.
    let worst = 0;
    for (const d of [27, 88, 233, 555]) {
        const q = { ...quake, depthKm: d };
        const exact = arrivals(pathGeometry(q.lat, q.lon, site.lat, site.lon).deltaDeg, travelTimeTable(d, { names: ['P', 'p', 'PKP', 'PKIKP', 'Pdiff'] }))[0];
        const quick = quickFirstArrival(q, site);
        worst = Math.max(worst, Math.abs(quick.timeS - exact.timeS));
    }
    assert.ok(worst < 0.5, `binned ${worst}`);
    const t = seismicSliceTable(64);
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    assert.deepEqual([...t.rgb.slice(0, 3)], hex(SLICE_LAYER_COLORS.inner));
    assert.deepEqual([...t.rgb.slice(3 * 63)], hex(SLICE_LAYER_COLORS.mantle));
    ok(`the list's depth-interpolated first arrival is within ${worst.toFixed(2)} s of the exact depth (stated: ≈, ~0.5 s); the slice table is the three neutral layers`);
}

{
    // Station elevation + strengths: a 1.65 km site adds each phase's own vertical-slowness delay.
    const high = arrivalsAt(quake, { ...site, elevationM: 1650 }, table);
    for (const r of high.rows) {
        assert.ok(Math.abs(r.totalS - (r.timeS + r.corrS + r.elevS)) < 1e-9);
        assert.ok(r.elevS > 0 && r.elevS < 1650 / 1000 / (r.recorded === 'S' ? 3.2 : 5.8) + 1e-9, `${r.phase} elevation ${r.elevS}`);
    }
    assert.ok(A.rows.every((r) => r.elevS === null), 'unknown elevation ⇒ no correction, said per row');
    for (const band of ['P', 'S']) {
        const dbs = high.rows.filter((r) => r.recorded === band && r.db !== null).map((r) => r.db);
        assert.ok(dbs.length && Math.abs(Math.max(...dbs)) < 1e-9, `${band} band peaks at 0 dB`);
    }
    const sks = high.rows.find((r) => r.phase === 'SKS'), scp = high.rows.find((r) => r.phase === 'ScP');
    assert.equal(sks.recorded, 'S'); if (scp) assert.equal(scp.recorded, 'P');
    const pP = high.rows.find((r) => r.phase === 'P');
    assert.equal(siteWithElevation(site, null).elevationM, null, 'unknown stays unknown, never 0');
    assert.equal(siteWithElevation(site, -40).elevationM, 0);
    assert.equal(siteWithElevation(site, 1655.4).elevationM, 1655.4);
    ok(`station elevation: +${(pP.elevS * 1000).toFixed(0)} ms on P at 1.65 km (each phase at its own slowness, S slower); strengths ranked within each recorded band (SKS is read as S)`);
}

console.log(`\nearth-interior-quakes: ${passed} checks passed`);
