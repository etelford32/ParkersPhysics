import assert from 'node:assert/strict';
import {
    PERSEVERANCE_MISSION,
    derivePositionFromLocalOffset,
    estimatedMissionSol,
    formatMarsClock,
    localMeanSolarTimeHours,
    marsOrbitalClock,
    marsSolarLongitude,
    marsSolarLongitudeFromJulianDate,
    marsSubsolarPoint,
    terrestrialTimeOffsetSeconds,
    observationFreshness,
} from '../js/mars-mission-state.js';

const { landing_site: landing, position } = PERSEVERANCE_MISSION;
const derived = derivePositionFromLocalOffset({
    landingLatDeg: landing.lat_deg,
    landingLonDeg: landing.lon_deg,
    northM: position.local_offset_m.north,
    westM: position.local_offset_m.west,
});

assert.ok(Math.abs(derived.lat_deg - 18.4277546024) < 1e-9, 'PDS north offset converts to the plotted latitude');
assert.ok(Math.abs(derived.lon_deg - 77.2352914998) < 1e-9, 'PDS west offset converts to the plotted longitude');
assert.equal(estimatedMissionSol(new Date('2026-08-05T20:00:00Z')), 1940, 'mission clock agrees with NASA map sol on verification date');
// 06:43:33 until 2026-09: the Mars Sol Date epoch is on the TT scale and the
// clock used to feed it UTC, running every Mars clock on the page ~67 s early.
assert.equal(formatMarsClock(localMeanSolarTimeHours(position.lon_deg, new Date('2026-08-05T20:00:00Z'))), '06:44:40');

// ── Mars24 (Allison & McEwen 2000) — the paper's own worked example ─────────
// 2000-01-06 00:00:00 UTC. Pinning published intermediate values, not our own
// output: a regression in any term (perturbations, EOT sign, TT) moves one.
const near = (actual, expected, tolerance, label) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
assert.equal(terrestrialTimeOffsetSeconds(Date.UTC(2000, 0, 6)), 64.184, 'TT − UTC in 2000');
assert.equal(terrestrialTimeOffsetSeconds(Date.UTC(2026, 8, 26)), 69.184, 'TT − UTC since 2017');
const worked = marsOrbitalClock(2_451_549.5);
near(worked.equation_of_center_deg, 4.44193, 1e-4, 'worked example ν − M');
near(worked.ls_deg, 277.18758, 1e-4, 'worked example Ls');
near(worked.eot_deg, -5.18775, 1e-4, 'worked example EOT');
near(worked.msd, 44795.99976, 1e-5, 'worked example Mars Sol Date');
near(worked.mtc_hours, 23.99425, 1e-4, 'worked example MTC');

// Mars Year 38 began 2024-11-12. The previous linear model was anchored at
// 2024-09-12 and read Ls ≈ 30° on 2026-09-26, four days before MY39's equinox.
near(marsSolarLongitude(new Date('2024-11-12T12:00:00Z')), 0.05, 0.1, 'MY38 northern spring equinox');
assert.ok(marsSolarLongitude(new Date('2024-09-12T00:00:00Z')) > 320, 'the old anchor date is late northern winter, not Ls 0°');
near(marsSolarLongitude(new Date('2021-02-18T20:55:00Z')), 5.65, 0.05, 'Perseverance landed just after the MY36 equinox');
assert.equal(marsSolarLongitudeFromJulianDate(2_451_549.5), worked.ls_deg, 'JD and Date entry points agree');

// Against production JPL Horizons, 2026-09-26T12:14:41Z (/api/mars/ephemeris):
// Ls — (the column was unparsed), sub-solar −0.82074°N (planetocentric),
// 64.2102°E as seen from Earth with a 846.17 s light time.
const measuredAt = Date.parse('2026-09-26T12:14:41.686Z');
const nowAtMars = marsSubsolarPoint(new Date(measuredAt));
near(nowAtMars.ls_deg, 358.08, 0.01, 'Ls at the Horizons check');
near(nowAtMars.lat_deg, -0.82074, 0.01, 'sub-solar latitude vs Horizons');
const retarded = marsSubsolarPoint(new Date(measuredAt - 846.1667 * 1000));
near(retarded.lon_deg, 64.2102, 0.01, 'sub-solar longitude vs Horizons at the light-time-retarded instant');
assert.ok(nowAtMars.lon_deg < retarded.lon_deg - 3, 'the Sun has moved ~3.4° west in one light time');

const equinoxSun = marsSubsolarPoint(new Date('2024-11-12T12:00:00Z'));
assert.ok(Math.abs(equinoxSun.lat_deg) < 0.05, 'subsolar latitude crosses the equator at Ls 0°');
assert.ok(equinoxSun.lon_deg >= -180 && equinoxSun.lon_deg < 180, 'subsolar longitude is normalized');
// The equation of time is applied: the sub-solar meridian is where TRUE solar
// time is noon, which differs from mean-noon by eot_deg.
const meanNoonLon = 15 * (12 - marsOrbitalClock(measuredAt / 86_400_000 + 2_440_587.5).mtc_hours);
near(((meanNoonLon - nowAtMars.lon_deg) % 360 + 540) % 360 - 180, nowAtMars.eot_deg, 1e-9, 'EOT offsets the sub-solar meridian');
assert.deepEqual(
    PERSEVERANCE_MISSION.latest_drive.position,
    {
        lat_deg: 18.42638931,
        lon_deg: 77.22455732,
        elevation_m: -1963.64,
        source: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json',
    },
    'latest drive position is pinned to NASA MMGIS sol 1940',
);
assert.deepEqual(
    observationFreshness({ terrestrial_date: '2024-04-27' }, new Date('2026-08-05T20:00:00Z')),
    { status: 'historical', age_days: 830 },
    'the last public daily MEDA summary cannot be mislabeled recent',
);
assert.deepEqual(
    observationFreshness({ terrestrial_date: '2026-08-04' }, new Date('2026-08-05T20:00:00Z')),
    { status: 'recent', age_days: 1 },
);

console.log('mars-mission-state: positions, mission clock, solar geometry, LMST, and freshness assertions passed');
