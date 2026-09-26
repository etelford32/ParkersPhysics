import assert from 'node:assert/strict';
import {
    LS_COLUMN_CANDIDATES,
    MARS_MEAN_SOL_S,
    formatLightTime,
    marsDustSeason,
    marsEphemerisParams,
    marsGeodeticToPlanetocentric,
    marsSeasonLabel,
    parseHorizonsCsvHeader,
    parseHorizonsCsvRow,
    parseMarsEphemeris,
    solarConjunctionState,
    subSolarAtMars,
    wrapLongitude,
} from '../js/mars-ephemeris.js';
import { marsPlanetocentricToGeodetic } from '../js/horizons.js';

// ── The pinned round-trip ───────────────────────────────────────────────────
// mars-ephemeris.js re-derives the ellipsoid conversion instead of importing it
// from horizons.js (that import would pull VSOP87 into the edge bundle). This
// gate is the only thing stopping the two copies from drifting.
for (const latDeg of [-89.5, -63.1, -25, -0.4, 0, 0.4, 18.42638931, 45, 71.9, 89.5]) {
    const roundTrip = marsGeodeticToPlanetocentric(marsPlanetocentricToGeodetic(latDeg));
    assert.ok(Math.abs(roundTrip - latDeg) < 1e-12, `geodetic round-trip at ${latDeg}: got ${roundTrip}`);
}
assert.equal(marsGeodeticToPlanetocentric(90), 90);
assert.equal(marsGeodeticToPlanetocentric(-90), -90);
// The conversion has to actually do something, or a bug that returns its input
// would pass the round-trip above.
assert.ok(Math.abs(marsGeodeticToPlanetocentric(45) - 45) > 0.3, 'planetodetic 45° differs from planetocentric');
assert.ok(Math.abs(marsGeodeticToPlanetocentric(45)) < 45, 'planetocentric latitude is the smaller of the pair');
assert.throws(() => marsGeodeticToPlanetocentric(91), RangeError);
assert.throws(() => marsGeodeticToPlanetocentric(Number.NaN), RangeError);

// ── Longitude wrapping ──────────────────────────────────────────────────────
assert.equal(wrapLongitude(0), 0);
assert.equal(wrapLongitude(77.2), 77.2);
assert.ok(Math.abs(wrapLongitude(-282.8) - 77.2) < 1e-9);
assert.equal(wrapLongitude(360), 0);
assert.equal(wrapLongitude(180), 180);
assert.equal(wrapLongitude(-180), 180);
assert.ok(Math.abs(wrapLongitude(200) + 160) < 1e-9);

// ── Query shape ─────────────────────────────────────────────────────────────
const params = marsEphemerisParams(2461262.5);
assert.equal(params.get('COMMAND'), "'499'");
assert.equal(params.get('CENTER'), "'500@399'");
assert.equal(params.get('EPHEM_TYPE'), "'OBSERVER'");
assert.equal(params.get('CSV_FORMAT'), "'YES'");
assert.equal(params.get('ANG_FORMAT'), "'DEG'");
assert.equal(params.get('TLIST'), "'2461262.50000000'");
// Every quantity the parser reads must actually be requested.
for (const quantity of ['13', '14', '15', '20', '21', '23', '24', '44']) {
    assert.ok(params.get('QUANTITIES').includes(quantity), `quantity ${quantity} requested`);
}
assert.throws(() => marsEphemerisParams('soon'), TypeError);

// ── Table parsing ───────────────────────────────────────────────────────────
// Representative JPL Horizons CSV observer output. The two unnamed columns after
// the date (solar-presence and interfering-body flags) and the single-character
// `/r` indicator are exactly why the parser keys off the header instead of
// counting fields from either end.
//
// Quantity 44's header is `App_Lon_Sun`. This fixture used to say `L_s` — a
// header Horizons never prints — so the parser read a column that only existed
// here, and production served `ls_deg: null` for its whole life.
const HORIZONS_CSV = `*******************************************************************************
 Revised: June 21, 2016                  Mars                              499
*******************************************************************************
Ephemeris / API_USER Sat Aug  9 04:11:02 2026 Pasadena, USA / Horizons
*******************************************************************************
Center body name: Earth (399)
*******************************************************************************
 Date__(UT)__HR:MN:SC.fff, , , Ang-diam, ObsSub-LON, ObsSub-LAT, SunSub-LON, SunSub-LAT, delta, deldot, 1-way_down_LT, S-O-T, /r, S-T-O, App_Lon_Sun,
*******************************************************************************
$$SOE
 2026-Aug-09 00:00:00.000, , ,  5.91234, 213.4567890,  12.3456789, 198.7654321,  14.5678901,  1.58234567890123, 12.3456789,  13.15832660,  78.90123, /L,  33.45678, 168.43210,
$$EOE
*******************************************************************************
`;

const header = parseHorizonsCsvHeader(HORIZONS_CSV);
assert.equal(header[0], 'Date__(UT)__HR:MN:SC.fff');
assert.equal(header[1], '', 'solar-presence flag column stays unnamed to keep index alignment');
assert.equal(header[2], '');
assert.equal(header[3], 'Ang-diam');
assert.equal(header.at(-1), 'App_Lon_Sun');
assert.equal(LS_COLUMN_CANDIDATES[0], 'App_Lon_Sun', 'the verified header is tried first');

const row = parseHorizonsCsvRow(HORIZONS_CSV);
assert.equal(row.__date, '2026-Aug-09 00:00:00.000');
assert.equal(row['SunSub-LON'], '198.7654321');
assert.equal(row['/r'], '/L', 'the one-character indicator lands in its own column, not in S-T-O');
assert.equal(row['S-T-O'], '33.45678');

const ephemeris = parseMarsEphemeris(HORIZONS_CSV);
assert.equal(ephemeris.horizons_utc, '2026-Aug-09 00:00:00.000');
assert.equal(ephemeris.ls_deg, 168.4321);
assert.equal(ephemeris.ls_column, 'App_Lon_Sun', 'the payload says which header answered');
// A legacy/alternate spelling still resolves, and says so.
const legacy = parseMarsEphemeris(HORIZONS_CSV.replace('App_Lon_Sun,', 'L_s,'));
assert.equal(legacy.ls_deg, 168.4321);
assert.equal(legacy.ls_column, 'L_s');
assert.equal(ephemeris.season, 'northern summer · southern winter');
assert.equal(ephemeris.earth_range_au, 1.58234567890123);
assert.ok(Math.abs(ephemeris.earth_range_km - 236_713_000) < 1_000_000, 'AU converted to km');
assert.ok(Math.abs(ephemeris.light_time_s - 789.4996) < 0.01, 'down-leg light time read in minutes, reported in seconds');
assert.equal(ephemeris.light_time_text, '13 m 09 s');
assert.equal(ephemeris.solar_elongation_deg, 78.90123);
assert.equal(ephemeris.solar_conjunction.state, 'clear');
assert.equal(ephemeris.phase_angle_deg, 33.45678);
assert.equal(ephemeris.angular_diameter_arcsec, 5.91234);
assert.equal(ephemeris.range_rate_km_s, 12.3456789);

// West-positive → east-positive, planetodetic → planetocentric.
assert.ok(Math.abs(ephemeris.sub_solar.lon_deg - wrapLongitude(-198.7654321)) < 1e-12);
assert.ok(ephemeris.sub_solar.lon_deg > 0 && ephemeris.sub_solar.lon_deg < 180, 'west 198.77° becomes east 161.23°');
assert.ok(Math.abs(ephemeris.sub_solar.lon_deg - 161.2345679) < 1e-6);
assert.ok(ephemeris.sub_solar.lat_deg < 14.5678901, 'sub-solar latitude converted off the geodetic value');
assert.ok(Math.abs(ephemeris.sub_solar.lat_deg - marsGeodeticToPlanetocentric(14.5678901)) < 1e-12);
assert.ok(Math.abs(ephemeris.sub_earth.lon_deg - 146.543211) < 1e-6);
assert.equal(ephemeris.sub_solar.frame, 'planetocentric · east-positive');

// ── Mars-simultaneous sub-solar point ───────────────────────────────────────
// Light time removed: 789.5 s is 3.20° of hour angle at 360°/sol, westward.
assert.equal(MARS_MEAN_SOL_S, 88_775.244);
assert.ok(Math.abs(ephemeris.sub_solar_now.lon_deg - (ephemeris.sub_solar.lon_deg - 360 * ephemeris.light_time_s / MARS_MEAN_SOL_S)) < 1e-9);
assert.equal(ephemeris.sub_solar_now.lat_deg, ephemeris.sub_solar.lat_deg);
// The production measurement the correction was verified against (2026-09-26):
// Horizons 64.2102°E, LT 846.1667 s; Mars24 at the same instant says 60.7820°E.
assert.ok(Math.abs(subSolarAtMars({ lat_deg: -0.82, lon_deg: 64.2102 }, 846.1667).lon_deg - 60.782) < 0.01);
assert.equal(subSolarAtMars({ lat_deg: 0, lon_deg: 10 }, null), null, 'no light time → no correction invented');
assert.ok(Math.abs(subSolarAtMars({ lat_deg: 0, lon_deg: -179 }, 1000).lon_deg - wrapLongitude(-179 - 360 * 1000 / MARS_MEAN_SOL_S)) < 1e-9, 'wraps across the antimeridian');

// ── Degradation: a renamed or missing column costs one field, not the payload ─
const RENAMED = HORIZONS_CSV.replace('App_Lon_Sun,', 'Ls_apparent,').replace('S-O-T, /r', 'SOT, /r');
const degraded = parseMarsEphemeris(RENAMED);
assert.equal(degraded.ls_deg, null);
assert.equal(degraded.ls_column, null);
assert.equal(degraded.season, null);
assert.equal(degraded.solar_elongation_deg, null);
assert.equal(degraded.solar_conjunction, null);
assert.equal(degraded.earth_range_au, 1.58234567890123, 'unrelated columns survive a rename elsewhere');
assert.ok(!degraded.fields_present.includes('ls_deg'));
assert.ok(degraded.fields_present.includes('earth_range_au'));
assert.deepEqual(ephemeris.fields_present, [
    'ls_deg', 'sub_solar_lat', 'sub_solar_lon', 'sub_earth_lat', 'sub_earth_lon',
    'earth_range_au', 'light_time_s', 'solar_elongation_deg',
], 'a complete table reports every tracked field');

// `n.a.` is Horizons' own "not available" token and must not become NaN.
const UNAVAILABLE = HORIZONS_CSV.replace('  1.58234567890123,', ' n.a.,');
assert.equal(parseMarsEphemeris(UNAVAILABLE).earth_range_au, null);
assert.ok(Math.abs(parseMarsEphemeris(UNAVAILABLE).light_time_s - 789.4996) < 0.01,
    'light time still comes from its own column when range is missing');

// Structural failures throw so the route can fall back rather than serve blanks.
assert.throws(() => parseMarsEphemeris('no markers here'), /\$\$SOE/);
assert.throws(() => parseMarsEphemeris('$$SOE\n$$EOE'), /column header/);
assert.throws(() => parseMarsEphemeris(HORIZONS_CSV.replace(/\$\$EOE/, '')), /\$\$EOE/);

// ── Season / dust climatology ───────────────────────────────────────────────
assert.equal(marsSeasonLabel(0), 'northern spring · southern autumn');
assert.equal(marsSeasonLabel(95), 'northern summer · southern winter');
assert.equal(marsSeasonLabel(251), 'northern autumn · southern spring');
assert.equal(marsSeasonLabel(300), 'northern winter · southern summer');
assert.equal(marsSeasonLabel(365), 'northern spring · southern autumn', 'wraps past a full Mars year');
assert.equal(marsSeasonLabel(null), null);
assert.equal(marsDustSeason(120).phase, 'clear');
assert.equal(marsDustSeason(190).phase, 'onset');
assert.equal(marsDustSeason(251).phase, 'peak', 'perihelion sits inside the dust-season peak');
assert.equal(marsDustSeason(330).phase, 'declining');

// ── Light time + conjunction ────────────────────────────────────────────────
assert.equal(formatLightTime(0), '0 m 00 s');
assert.equal(formatLightTime(65), '1 m 05 s');
assert.equal(formatLightTime(1_337), '22 m 17 s');
assert.equal(formatLightTime(-1), null);
assert.equal(formatLightTime(null), null);
assert.equal(solarConjunctionState(1.4).state, 'conjunction');
assert.equal(solarConjunctionState(6).state, 'near-conjunction');
assert.equal(solarConjunctionState(140).state, 'clear');
assert.equal(solarConjunctionState(null), null);

console.log('mars-ephemeris: Horizons CSV parsing, frame conversions, degradation, and season climatology passed');
