/**
 * Canonical Mars 2020 mission state shared by the edge adapter and clients.
 *
 * This module deliberately separates three clocks:
 *   - operational status: newest human-reviewed NASA mission source;
 *   - drive progress: newest public NASA location-map snapshot;
 *   - plotted coordinate: newest reproducible released PDS position product.
 *
 * Keeping them separate prevents a visually "live" globe from representing
 * an archived PDS coordinate as real-time rover telemetry.
 */

export const MARS_RADIUS_M = 3_396_190;
export const MARS_SOL_MS = 88_775_244;
export const MARS_OBLIQUITY_DEG = 25.19;

// ── Mars solar clock: Allison & McEwen (2000), the NASA GISS "Mars24" algorithm ──
// Planet. Space Sci. 48, 215–235. Accurate to ~0.01° in Ls against JPL DE ephemerides
// over 1874–2126, and it is the algorithm behind every published Mars local time.
//
// This REPLACED a linear mean-motion model anchored at "2024-09-12 = Ls 0°". That
// anchor was 61 days early — Mars Year 38 began on 2024-11-12 — so the fallback
// season sat ~32° ahead of the truth (it read Ls 30° on 2026-09-26, when Mars was at
// Ls 358°, four days before the MY39 equinox), on top of the ~±11° a constant-rate
// Ls is structurally wrong by. That mattered more than it should have, because the
// live Horizons path never produced an Ls either (see js/mars-ephemeris.js,
// `App_Lon_Sun`), so the page ran on this model in production.
//
// Measured against JPL Horizons on 2026-09-26T12:14:41Z: sub-solar latitude −0.8182°
// here vs −0.8207° Horizons; sub-solar longitude 64.2134°E here (evaluated at the
// light-time-retarded instant Horizons reports for an Earth observer) vs 64.2102°E.
// `tests/mars-mission-state.mjs` pins the paper's own worked example.
const J2000_JD = 2_451_545.0;
const MSD_EPOCH_JD_TT = 2_405_522.0028779;
const MARS_SOL_PER_DAY = 1.0274912517;
// Planetary perturbation terms (A_i [deg], τ_i [Julian years], φ_i [deg]), Table 5.
const MARS24_PBS = Object.freeze([
    [0.0071, 2.2353, 49.409],
    [0.0057, 2.7543, 168.173],
    [0.0039, 1.1177, 191.837],
    [0.0037, 15.7866, 21.736],
    [0.0021, 2.1354, 15.704],
    [0.0020, 2.4694, 95.528],
    [0.0018, 32.8493, 49.095],
]);
// TT − UTC, seconds (32.184 s + leap seconds). No leap second has been scheduled
// since 2017; a missing future one costs ~1 s of clock, ~0.004° of longitude.
const TT_MINUS_UTC = Object.freeze([
    [Date.UTC(2017, 0, 1), 69.184],
    [Date.UTC(2015, 6, 1), 68.184],
    [Date.UTC(2012, 6, 1), 67.184],
    [Date.UTC(2009, 0, 1), 66.184],
    [Date.UTC(2006, 0, 1), 65.184],
    [Date.UTC(1999, 0, 1), 64.184],
]);

export const PERSEVERANCE_MISSION = Object.freeze({
    status: 'operational',
    status_checked_at: '2026-07-14',
    status_source: 'https://www.jpl.nasa.gov/images/pia26754-perseverances-trip-to-broom-point/',
    landed_at: '2021-02-18T20:55:00Z',
    latest_drive: Object.freeze({
        sol: 1940,
        distance_km: 44.14,
        checked_at: '2026-08-05',
        source: 'https://mars.nasa.gov/maps/location/?mission=M20&site=NOW',
        position: Object.freeze({
            lat_deg: 18.42638931,
            lon_deg: 77.22455732,
            elevation_m: -1963.64,
            source: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json',
        }),
    }),
    landing_site: Object.freeze({
        lat_deg: 18.444677,
        lon_deg: 77.450812,
        label: 'Octavia E. Butler Landing',
        source: 'https://science.nasa.gov/mission/mars-2020-perseverance/location-map/',
    }),
    position: Object.freeze({
        kind: 'archived-pds-fix',
        sol: 1726,
        observed_at: '2025-12-28T06:48:41.313Z',
        lat_deg: 18.427755,
        lon_deg: 77.235291,
        local_offset_m: Object.freeze({ north: -1003.07, west: 12118.66, up: 575.32 }),
        method: 'M2020_TOPO local tangent-plane offset converted on a 3396190 m Mars sphere',
        source: 'https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_derived_env/sol_1620_1739/sol_1726/WE__1726___________DER_ANCILLARY___________P01.xml',
    }),
    meda_archive: Object.freeze({
        latest_verified_sol: 1726,
        release_checked_at: '2026-08-05',
        source: 'https://pds-atmospheres.nmsu.edu/data_and_services/atmospheres_data/PERSEVERANCE/meda.html',
    }),
});

// Last reproducible public MEDA daily summary retained for an immediate,
// offline-capable first paint. The client always labels this as historical and
// replaces it when the shared adapter returns a newer usable observation.
export const PERSEVERANCE_MEDA_SNAPSHOT = Object.freeze({
    active: true,
    sol: 1133,
    terrestrial_date: '2024-04-27',
    min_temp_C: -79.3,
    max_temp_C: -24.7,
    pressure_pa: 778.9,
    wind_speed_mps: null,
    ls_deg: 249,
    season: 'late autumn',
    source: 'Bundled NASA Mars 2020 MEDA daily summary',
});

export function derivePositionFromLocalOffset({
    landingLatDeg,
    landingLonDeg,
    northM,
    westM,
    radiusM = MARS_RADIUS_M,
}) {
    const radians = Math.PI / 180;
    const latDeg = landingLatDeg + northM / radiusM / radians;
    const lonDeg = landingLonDeg - westM / (radiusM * Math.cos(landingLatDeg * radians)) / radians;
    return { lat_deg: latDeg, lon_deg: lonDeg };
}

export function estimatedMissionSol(date = new Date()) {
    const elapsed = date.getTime() - Date.parse(PERSEVERANCE_MISSION.landed_at);
    return Math.max(0, Math.floor(elapsed / MARS_SOL_MS));
}

export function terrestrialTimeOffsetSeconds(utcMs) {
    for (const [since, seconds] of TT_MINUS_UTC) if (utcMs >= since) return seconds;
    return 63.184;
}

function julianDateTT(utcMs) {
    return utcMs / 86_400_000 + 2_440_587.5 + terrestrialTimeOffsetSeconds(utcMs) / 86_400;
}

const wrap360 = degrees => ((degrees % 360) + 360) % 360;

/**
 * Mars' orbital clock at one instant (Allison & McEwen 2000, steps B–C).
 * @param {number} julianDateUtc  JD on the UTC scale (what every caller here has).
 * @returns {{ ls_deg:number, equation_of_center_deg:number, eot_deg:number,
 *             msd:number, mtc_hours:number }}
 *   `eot_deg` is true minus mean solar time, in degrees of hour angle (÷15 → hours).
 */
export function marsOrbitalClock(julianDateUtc) {
    const utcMs = (julianDateUtc - 2_440_587.5) * 86_400_000;
    const jdTT = julianDateTT(utcMs);
    const dt = jdTT - J2000_JD;
    const meanAnomalyRad = (19.3871 + 0.52402073 * dt) * Math.PI / 180;
    const fictitiousMeanSun = 270.3871 + 0.524038496 * dt;
    let perturbations = 0;
    for (const [amplitude, periodYears, phase] of MARS24_PBS) {
        perturbations += amplitude * Math.cos((0.985626 * dt / periodYears + phase) * Math.PI / 180);
    }
    const equationOfCenter = (10.691 + 3.0e-7 * dt) * Math.sin(meanAnomalyRad)
        + 0.623 * Math.sin(2 * meanAnomalyRad)
        + 0.050 * Math.sin(3 * meanAnomalyRad)
        + 0.005 * Math.sin(4 * meanAnomalyRad)
        + 0.0005 * Math.sin(5 * meanAnomalyRad)
        + perturbations;
    const lsDeg = wrap360(fictitiousMeanSun + equationOfCenter);
    const ls = lsDeg * Math.PI / 180;
    const eotDeg = 2.861 * Math.sin(2 * ls) - 0.071 * Math.sin(4 * ls) + 0.002 * Math.sin(6 * ls)
        - equationOfCenter;
    const msd = (jdTT - MSD_EPOCH_JD_TT) / MARS_SOL_PER_DAY;
    return {
        ls_deg: lsDeg,
        equation_of_center_deg: equationOfCenter,
        eot_deg: eotDeg,
        msd,
        mtc_hours: ((msd % 1) + 1) % 1 * 24,
    };
}

/** Coordinated Mars Time (mean solar time at the prime meridian), hours. */
export function marsCoordinatedTimeHours(date = new Date()) {
    return marsOrbitalClock(date.getTime() / 86_400_000 + 2_440_587.5).mtc_hours;
}

/** Areocentric solar longitude Ls, degrees, from a UTC Julian date. */
export function marsSolarLongitudeFromJulianDate(julianDate) {
    return marsOrbitalClock(julianDate).ls_deg;
}

export function marsSolarLongitude(date = new Date()) {
    const julianDate = date.getTime() / 86_400_000 + 2_440_587.5;
    return marsSolarLongitudeFromJulianDate(julianDate);
}

/**
 * Areocentric (planetocentric, east-positive) sub-solar point AT MARS, at the
 * given instant — the same instant the page's LMST clock reads. JPL Horizons
 * observed from Earth reports the point one light-time earlier (3–10° further
 * east); see `sub_solar_now` in api/mars/ephemeris.js for the reconciliation.
 *
 * Longitude includes the equation of time: the Sun is overhead where LOCAL TRUE
 * solar time is noon, which is up to ~12° away from where local MEAN time is.
 */
export function marsSubsolarPoint(date = new Date()) {
    const clock = marsOrbitalClock(date.getTime() / 86_400_000 + 2_440_587.5);
    const declinationRad = Math.asin(
        Math.sin(MARS_OBLIQUITY_DEG * Math.PI / 180) * Math.sin(clock.ls_deg * Math.PI / 180),
    );
    const rawLongitude = 15 * (12 - clock.mtc_hours) - clock.eot_deg;
    const lonDeg = ((rawLongitude + 180) % 360 + 360) % 360 - 180;
    return {
        lat_deg: declinationRad * 180 / Math.PI,
        lon_deg: lonDeg,
        ls_deg: clock.ls_deg,
        eot_deg: clock.eot_deg,
    };
}

export function localMeanSolarTimeHours(lonDeg, date = new Date()) {
    return (marsCoordinatedTimeHours(date) + lonDeg / 15 + 24) % 24;
}

export function formatMarsClock(hours) {
    const totalSeconds = Math.floor((((hours % 24) + 24) % 24) * 3600);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    return [hh, mm, ss].map(value => String(value).padStart(2, '0')).join(':');
}

export function observationFreshness(record, now = new Date()) {
    if (!record?.terrestrial_date) return { status: 'unavailable', age_days: null };
    const observed = Date.parse(`${record.terrestrial_date}T12:00:00Z`);
    if (!Number.isFinite(observed)) return { status: 'unknown', age_days: null };
    const ageDays = Math.max(0, Math.floor((now.getTime() - observed) / 86_400_000));
    return { status: ageDays <= 3 ? 'recent' : 'historical', age_days: ageDays };
}
