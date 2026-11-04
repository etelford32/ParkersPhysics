/**
 * mission-pads.js — the ONE list of Earth launch pads + the Earth→Moon
 * departure brief that moon.html and the mission planner share.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no three.js, no fetch, no ambient time (every entry point
 * takes a Date or a Julian Day). Gated by tests/mission-pads.mjs.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * The Earth pad table lived inside js/mission-planner-3d.js, a three.js
 * renderer module no other page could import without pulling the whole
 * scene in. moon.html wants to show "how do I get here from Earth" for a
 * proposed colony site, and the colony game wants to be a mission
 * planner destination. Both need the SAME pads and the SAME transfer
 * numbers the planner flies, so the pads move here and the planner
 * re-exports them (`LAUNCH_SITES` keeps its name there).
 *
 * ── WHAT THE BRIEF COMPUTES, AND FROM WHAT ───────────────────────────────
 *   • The transfer itself is the planner's own `planLunarTransfer`
 *     (mission-planner-trajectory.js: Hohmann from a circular parking
 *     orbit to the Moon's LIVE distance, Δv_TLI + Δv_LOI, TOF ≈ 5 d) —
 *     never a second transfer model.
 *   • The PLANE question is the real Earth-side launch constraint and the
 *     reason Apollo flew from 28.5° N: a parking orbit of inclination i can
 *     only inject toward a target whose declination |δ| ≤ i without a
 *     plane change, and the Moon's declination swings ±18.3°…±28.6° over
 *     the 18.6-year nodal cycle (ecliptic 5.14° ± obliquity 23.44°). The
 *     pad's latitude is the minimum inclination a due-east launch gives.
 *     The brief reports the Moon's declination at arrival (from the site's
 *     own `moonGeocentric`, rotated ecliptic → equatorial with the J2000
 *     obliquity — the ~0.01° of nutation is noise here), whether the pad
 *     can reach it coplanar, and if not the Δv of the single-impulse plane
 *     change 2 v sin(Δi/2) at parking speed — an UPPER bound the planner's
 *     Lambert path can beat by splitting the dogleg (disclosed).
 *   • ARRIVAL LIGHTING at the landing site is js/moon-ephemeris.js at the
 *     arrival JD: Sun elevation at the site, the lunar phase, and whether
 *     the elevation sits in the Apollo landing band (7–20°, low Sun for
 *     shadow relief without glare). South-pole colony sites never do — the
 *     Sun there is always within ~1.5° of the horizon and what matters is
 *     the site's TOPOGRAPHIC illumination fraction from the colony survey,
 *     which the brief carries through so the page can say so.
 */

import { planLunarTransfer, R_EARTH, MU_EARTH } from './mission-planner-trajectory.js';
import { moonGeocentric } from './horizons.js';
import { lunarGeometry, solarZenithDeg, toJd } from './moon-ephemeris.js';
import { siteProfiles } from './colony-engine.js';

// ── Earth launch pads (the planner's table, unchanged) ───────────────────────
export const EARTH_LAUNCH_SITES = Object.freeze([
    Object.freeze({ id: 'ksc',         name: 'Kennedy SC (USA)',       lat: 28.573, lon: -80.649 }),
    Object.freeze({ id: 'baikonur',    name: 'Baikonur (KAZ)',         lat: 45.965, lon:  63.305 }),
    Object.freeze({ id: 'kourou',      name: 'Kourou (FRA)',           lat:  5.236, lon: -52.768 }),
    Object.freeze({ id: 'starbase',    name: 'Starbase (USA)',         lat: 25.997, lon: -97.155 }),
    Object.freeze({ id: 'wenchang',    name: 'Wenchang (CHN)',         lat: 19.614, lon: 110.951 }),
    Object.freeze({ id: 'vandy',       name: 'Vandenberg (USA)',       lat: 34.742, lon: -120.572 }),
    Object.freeze({ id: 'tanegashima', name: 'Tanegashima (JPN)',      lat: 30.400, lon: 130.969 }),
    Object.freeze({ id: 'sriharikota', name: 'Sriharikota (IND)',      lat: 13.720, lon:  80.230 }),
]);

/** The pad by id, or the first pad. */
export function padById(id) {
    return EARTH_LAUNCH_SITES.find(p => p.id === id) || EARTH_LAUNCH_SITES[0];
}

// ── Plane geometry ───────────────────────────────────────────────────────────
export const OBLIQUITY_DEG = 23.4393;
export const MOON_DECLINATION_RANGE_DEG = Object.freeze([18.3, 28.6]);   // minor / major standstill
export const APOLLO_LIGHTING_BAND_DEG = Object.freeze([7, 20]);

/** Minimum parking-orbit inclination from a due-east launch at latitude φ: |φ|. */
export function minParkingInclinationDeg(latDeg) { return Math.abs(latDeg); }

/** Single-impulse plane change Δv (km/s) at speed v for a Δi (deg). */
export function planeChangeDvKms(vKms, dIncDeg) {
    return 2 * vKms * Math.sin(Math.abs(dIncDeg) * Math.PI / 360);
}

/** Moon's geocentric declination (deg) from its ecliptic lon/lat at a JD. */
export function moonDeclinationDeg(jd) {
    const m = moonGeocentric(jd);
    const eps = OBLIQUITY_DEG * Math.PI / 180;
    const sinDec = Math.sin(m.lat_rad) * Math.cos(eps) + Math.cos(m.lat_rad) * Math.sin(eps) * Math.sin(m.lon_rad);
    return Math.asin(Math.max(-1, Math.min(1, sinDec))) * 180 / Math.PI;
}

// ── Colony shortlist → mission-planner bases ─────────────────────────────────
/**
 * The top-N colony sites by the colony survey's own strategy score, shaped
 * like a planner base ({ id, name, lat, lon }) with the survey carried
 * along. ONE ranking (colony-engine's) feeds the moon page, the colony
 * game and the planner's base list.
 */
export function colonyShortlist(n = 3) {
    return siteProfiles().slice(0, n).map(s => ({
        id: `colony-${s.id}`, name: `Colony · ${s.name}`, lat: s.lat, lon: s.lon,
        colony: { siteId: s.id, score: s.score, illum: s.illum, iceDistM: s.iceDistM, iceRich: s.iceRich, quakeRisk: s.quakeRisk },
    }));
}

// ── The departure brief ──────────────────────────────────────────────────────
/**
 * Earth→Moon brief for a pad and a landing site at an instant.
 * @param {object} o
 * @param {Date|number} o.when           departure instant (Date or JD)
 * @param {string} [o.padId='ksc']
 * @param {{ latDeg, lonDeg, name?, illum? }} o.site   selenographic landing site
 * @param {number} [o.parkingAltKm=300]
 * @param {number} [o.targetAltMoonKm=100]
 */
export function lunarDepartureBrief({ when, padId = 'ksc', site, parkingAltKm = 300, targetAltMoonKm = 100 }) {
    if (!site || !Number.isFinite(site.latDeg) || !Number.isFinite(site.lonDeg)) {
        throw new TypeError('lunarDepartureBrief: site {latDeg, lonDeg} required');
    }
    const jd = toJd(when);
    const pad = padById(padId);
    const plan = planLunarTransfer({ jd_depart: jd, parking_alt_km: parkingAltKm, target_alt_moon_km: targetAltMoonKm });

    // Plane: the parking orbit must contain the Moon's arrival direction
    const padIncDeg = minParkingInclinationDeg(pad.lat);
    const moonDecDeg = moonDeclinationDeg(plan.jd_arrive);
    const deficitDeg = Math.max(0, Math.abs(moonDecDeg) - padIncDeg);
    const vPark = Math.sqrt(MU_EARTH / (R_EARTH + parkingAltKm));
    const planeChangeKms = planeChangeDvKms(vPark, deficitDeg);

    // Arrival lighting at the site, from the live selenographic Sun
    const geoArrive = lunarGeometry(plan.jd_arrive);
    const sunElevDeg = 90 - solarZenithDeg(site.latDeg, site.lonDeg, geoArrive.subSolar);
    const polar = Math.abs(site.latDeg) >= 80;
    const inApolloBand = sunElevDeg >= APOLLO_LIGHTING_BAND_DEG[0] && sunElevDeg <= APOLLO_LIGHTING_BAND_DEG[1];

    return {
        pad: { id: pad.id, name: pad.name, latDeg: pad.lat, lonDeg: pad.lon, minInclinationDeg: padIncDeg },
        site: { name: site.name ?? null, latDeg: site.latDeg, lonDeg: site.lonDeg, illum: site.illum ?? null },
        departJd: plan.jd_depart,
        arriveJd: plan.jd_arrive,
        tofDays: plan.tof_d,
        moonDistanceKm: plan.r_moon_km,
        dvTliKms: plan.dv_tli_kms,
        dvLoiKms: plan.dv_loi_kms,
        dvTotalKms: plan.dv_total_kms,
        vInfMoonKms: plan.v_inf_moon_kms,
        parkingSpeedKms: vPark,
        moonDeclinationAtArrivalDeg: moonDecDeg,
        coplanarReachable: deficitDeg === 0,
        planeDeficitDeg: deficitDeg,
        planeChangeDvKms: planeChangeKms,            // single-impulse UPPER bound
        arrival: {
            sunElevationDeg: sunElevDeg,
            daylight: sunElevDeg > 0,
            phase: geoArrive.phase,
            illumination: geoArrive.illumination,
            polarSite: polar,
            inApolloLightingBand: inApolloBand,
            // What actually decides a polar site's light is its topographic
            // illumination fraction from the colony survey, when known.
            topographicIllumination: polar ? (site.illum ?? null) : null,
        },
    };
}
