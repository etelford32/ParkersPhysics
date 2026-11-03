#!/usr/bin/env node
/**
 * mission-pads.mjs — gate for js/mission-pads.js.
 *
 * Run: node tests/mission-pads.mjs
 *
 * The load-bearing pins:
 *   • The pad table is the planner's (8 pads, KSC first, every lat/lon in
 *     range) and the planner re-exports it as LAUNCH_SITES — one list.
 *   • The brief's transfer numbers ARE planLunarTransfer's for the same JD
 *     (never a second model): Δv_TLI ≈ 3.1 km/s, Δv_LOI ≈ 0.8, TOF ≈ 5 d.
 *   • Plane rule: the Moon's declination over a nodal cycle stays inside
 *     ±28.6° and exceeds ±18.3° (the standstill limits); a pad at |φ| ≥
 *     28.6° (Vandenberg, Baikonur, Tanegashima) is ALWAYS coplanar-
 *     reachable; Kourou (5.2°) is never reachable when |δ| > 5.2° and the
 *     deficit is exactly |δ| − 5.2°; plane-change Δv is 2 v sin(Δi/2).
 *   • Arrival lighting comes from the same ephemeris the Moon page draws:
 *     elevation = 90° − zenith at the site at the arrival JD; a polar site
 *     is flagged and carries the survey's topographic illumination.
 *   • The colony shortlist is colony-engine's ranking, in order, with the
 *     survey attached.
 */

import assert from 'node:assert/strict';
import {
    EARTH_LAUNCH_SITES, padById, minParkingInclinationDeg, planeChangeDvKms, moonDeclinationDeg,
    MOON_DECLINATION_RANGE_DEG, APOLLO_LIGHTING_BAND_DEG, colonyShortlist, lunarDepartureBrief,
} from '../js/mission-pads.js';
import { planLunarTransfer } from '../js/mission-planner-trajectory.js';
import { lunarGeometry, solarZenithDeg, toJd } from '../js/moon-ephemeris.js';
import { siteProfiles } from '../js/colony-engine.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Pad table ────────────────────────────────────────────────────────────
{
    assert.equal(EARTH_LAUNCH_SITES.length, 8);
    assert.equal(EARTH_LAUNCH_SITES[0].id, 'ksc', 'KSC first (the default)');
    for (const p of EARTH_LAUNCH_SITES) {
        assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180, `${p.id} coordinates in range`);
        assert.equal(minParkingInclinationDeg(p.lat), Math.abs(p.lat));
    }
    assert.equal(padById('nope').id, 'ksc', 'unknown pad → the default');
    assert.equal(padById('kourou').lat, 5.236);
    ok('eight pads, KSC default, inclination floor = |latitude|');
}

// ── 2. The brief IS the planner's transfer ──────────────────────────────────
{
    const jd = toJd(new Date(Date.UTC(2026, 10, 3)));
    const site = { latDeg: -89.5, lonDeg: 222.7, name: 'Connecting Ridge', illum: 0.89 };
    const b = lunarDepartureBrief({ when: jd, padId: 'ksc', site });
    const p = planLunarTransfer({ jd_depart: jd });
    near(b.dvTliKms, p.dv_tli_kms, 1e-12, 'Δv_TLI is the planner\'s');
    near(b.dvLoiKms, p.dv_loi_kms, 1e-12, 'Δv_LOI is the planner\'s');
    near(b.tofDays, p.tof_d, 1e-12, 'TOF is the planner\'s');
    near(b.arriveJd, p.jd_arrive, 1e-12, 'arrival JD');
    assert.ok(b.dvTliKms > 3.0 && b.dvTliKms < 3.2, `Δv_TLI ≈ 3.1 km/s (${b.dvTliKms.toFixed(3)})`);
    assert.ok(b.dvLoiKms > 0.7 && b.dvLoiKms < 0.95, `Δv_LOI ≈ 0.8 km/s (${b.dvLoiKms.toFixed(3)})`);
    assert.ok(b.tofDays > 4.5 && b.tofDays < 5.5, `TOF ≈ 5 d (${b.tofDays.toFixed(2)})`);
    near(b.parkingSpeedKms, 7.726, 0.005, 'circular speed at 300 km');
    assert.equal(b.pad.id, 'ksc');
    assert.throws(() => lunarDepartureBrief({ when: jd, site: null }), /site/);
    ok('the brief\'s transfer numbers are planLunarTransfer\'s, bit for bit');
}

// ── 3. Plane rule over a nodal cycle ────────────────────────────────────────
{
    const jd0 = toJd(new Date(Date.UTC(2020, 0, 1)));
    let maxAbs = 0, minMonthlyMax = Infinity;
    for (let m = 0; m < 19 * 12; m++) {
        let monthMax = 0;
        for (let d = 0; d < 30; d += 0.5) {
            const dec = Math.abs(moonDeclinationDeg(jd0 + m * 30.4 + d));
            monthMax = Math.max(monthMax, dec);
        }
        maxAbs = Math.max(maxAbs, monthMax);
        minMonthlyMax = Math.min(minMonthlyMax, monthMax);
    }
    assert.ok(maxAbs < MOON_DECLINATION_RANGE_DEG[1] + 0.4, `never past the major standstill (${maxAbs.toFixed(2)}°)`);
    assert.ok(maxAbs > 27.5, 'reaches the major standstill within the cycle');
    assert.ok(minMonthlyMax > MOON_DECLINATION_RANGE_DEG[0] - 0.5, `every month swings at least to the minor standstill (${minMonthlyMax.toFixed(2)}°)`);
    // Pads at or above 28.6° are always coplanar-reachable; Kourou's deficit is exact
    const site = { latDeg: 0.67, lonDeg: 23.47 };
    for (let d = 0; d < 60; d += 1) {
        const jd = jd0 + d;
        for (const padId of ['vandy', 'baikonur', 'tanegashima']) {
            const b = lunarDepartureBrief({ when: jd, padId, site });
            assert.ok(b.coplanarReachable, `${padId} reaches the Moon coplanar on day ${d}`);
            assert.equal(b.planeChangeDvKms, 0);
        }
        const k = lunarDepartureBrief({ when: jd, padId: 'kourou', site });
        const dec = Math.abs(k.moonDeclinationAtArrivalDeg);
        if (dec > 5.236) {
            assert.ok(!k.coplanarReachable);
            near(k.planeDeficitDeg, dec - 5.236, 1e-9, 'deficit = |δ| − φ');
            near(k.planeChangeDvKms, planeChangeDvKms(k.parkingSpeedKms, k.planeDeficitDeg), 1e-12, 'Δv formula');
            assert.ok(k.planeChangeDvKms > 0 && k.planeChangeDvKms < 4, 'bounded');
        } else {
            assert.ok(k.coplanarReachable);
        }
    }
    near(planeChangeDvKms(7.7, 60), 7.7, 1e-9, '60° plane change costs a full orbital speed');
    near(planeChangeDvKms(7.7, 0), 0, 1e-12, 'no change, no cost');
    ok('Moon declination inside the standstill envelope; high-latitude pads always coplanar; Kourou\'s deficit exact');
}

// ── 4. Arrival lighting from the Moon page\'s own ephemeris ─────────────────
{
    const jd = toJd(new Date(Date.UTC(2026, 10, 3)));
    for (const site of [
        { latDeg: -89.5, lonDeg: 222.7, name: 'Connecting Ridge', illum: 0.89 },
        { latDeg: 0.67, lonDeg: 23.47, name: 'Tranquility Base' },
        { latDeg: -43.31, lonDeg: -11.36, name: 'Tycho' },
    ]) {
        const b = lunarDepartureBrief({ when: jd, site });
        const g = lunarGeometry(b.arriveJd);
        near(b.arrival.sunElevationDeg, 90 - solarZenithDeg(site.latDeg, site.lonDeg, g.subSolar), 1e-9, 'elevation from the ephemeris');
        assert.equal(b.arrival.phase, g.phase);
        assert.equal(b.arrival.daylight, b.arrival.sunElevationDeg > 0);
        assert.equal(b.arrival.polarSite, Math.abs(site.latDeg) >= 80);
        assert.equal(b.arrival.inApolloLightingBand,
            b.arrival.sunElevationDeg >= APOLLO_LIGHTING_BAND_DEG[0] && b.arrival.sunElevationDeg <= APOLLO_LIGHTING_BAND_DEG[1]);
        if (b.arrival.polarSite) {
            assert.ok(Math.abs(b.arrival.sunElevationDeg) < 3, 'a polar site\'s Sun hugs the horizon');
            assert.equal(b.arrival.topographicIllumination, 0.89, 'carries the survey\'s illumination');
        } else {
            assert.equal(b.arrival.topographicIllumination, null);
        }
    }
    // Somewhere in a lunation Tranquility Base passes through the Apollo band
    let inBand = 0;
    for (let d = 0; d < 30; d += 0.25) {
        const b = lunarDepartureBrief({ when: jd + d, site: { latDeg: 0.67, lonDeg: 23.47 } });
        if (b.arrival.inApolloLightingBand) inBand++;
    }
    assert.ok(inBand > 0, 'the 7–20° landing-lighting band is reachable by choosing the departure day');
    ok('arrival lighting = the Moon page\'s ephemeris at the arrival JD; polar sites flagged');
}

// ── 5. Colony shortlist ─────────────────────────────────────────────────────
{
    const top = colonyShortlist(3);
    const survey = siteProfiles();
    assert.equal(top.length, 3);
    for (let i = 0; i < 3; i++) {
        assert.equal(top[i].colony.siteId, survey[i].id, 'same order as the survey');
        assert.equal(top[i].lat, survey[i].lat);
        assert.equal(top[i].lon, survey[i].lon);
        assert.equal(top[i].colony.score, survey[i].score);
        assert.ok(top[i].id.startsWith('colony-'));
        assert.ok(top[i].name.startsWith('Colony · '));
    }
    assert.ok(top[0].colony.score >= top[1].colony.score && top[1].colony.score >= top[2].colony.score);
    assert.equal(colonyShortlist(1).length, 1);
    ok('colony shortlist = colony-engine\'s ranking, planner-shaped');
}

console.log(`\nmission-pads: ${passed} groups passed`);
