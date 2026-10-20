/**
 * orrery-planets.js — where solar-system.html draws each planet (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * Until 2026-10-20 the orrery read the ephemeris ONCE, at boot, and from then
 * on moved every planet uniformly round a circle: `angle = simTime/period·2π
 * + angle0`. That is right at the instant of boot and wrong at every other
 * date, because real orbits are ellipses swept at a varying rate (Kepler II)
 * and `simTime` runs in 365.25-day "years" that only Earth's period matches.
 * Measured against Astronomy Engine (independent VSOP87, ecliptic of date):
 * Mercury 41° off thirty days after boot, Mars 13° off at six months and 19°
 * at one year, Earth itself 3.7° off at six months — while the page's own
 * "Planet Positions" table, which DID read the ephemeris, printed the true
 * numbers beside the wrong picture.
 *
 * This module is the ONE answer to "where is planet P at JD": the page's own
 * ephemeris series (js/horizons.js), brought into ONE frame, the ecliptic and
 * equinox OF DATE that Earth's VSOP87D and the outer-planet series already
 * use. Mercury, Venus and Mars come from J2000 mean elements
 * (`PLANET_FRAMES` in js/skyview/sky-engine.js is the one record of which
 * series is in which frame) and are rotated forward by the general precession
 * in longitude (`toOfDate`, IAU 1976 — js/neo-orbits.js). Mixing them unrotated
 * put the three of them 0.37° behind Earth in 2026, growing 1.4° per century.
 *
 * DRAWING CONVENTIONS (disclosed, deliberate):
 *   - Radius goes through the page's `simDist` (log compression) applied to the
 *     TRUE heliocentric distance, so Mars visibly breathes 1.38 ↔ 1.67 AU.
 *     Orbit rings are therefore the planets' real ellipses (`orbitRadiusAtLon`,
 *     mean elements of date, focus at the Sun) drawn through the same map.
 *   - The scene is flat: ecliptic latitude is dropped (y = 0), as it always
 *     was. Mercury's 7° inclination moves its in-plane longitude by < 0.25°.
 *   - Scene axes are (x, z) = (cos λ, sin λ) — the page's long-standing
 *     mirror of the ecliptic (helioToScene's y↔z swap, CLAUDE.md orrery rows).
 */
import { PLANET_FRAMES } from './skyview/sky-engine.js';
import { earthHeliocentric, planetElementsAt } from './horizons.js';
import { toOfDate, precessionLongitudeRad, D2R } from './neo-orbits.js';

/** Every body this module can place, keyed lowercase like PLANET_FRAMES. */
export const ORRERY_BODIES = Object.freeze(['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

/**
 * Heliocentric ecliptic position OF DATE (AU) for `key` at `jd`, or null for
 * a body this module does not know (Ceres keeps the page's legacy path).
 * @returns {{ x:number, y:number, z:number, r:number, lonRad:number, latRad:number } | null}
 */
export function planetHelioOfDate(key, jd) {
    let p;
    if (key === 'earth') {
        const e = earthHeliocentric(jd);
        p = { x: e.x_AU, y: e.y_AU, z: e.z_AU };
    } else {
        const spec = PLANET_FRAMES[key];
        if (!spec) return null;
        const raw = spec.fn(jd);
        p = { x: raw.x_AU, y: raw.y_AU, z: raw.z_AU };
        if (spec.frame === 'j2000') p = toOfDate(p, jd);
    }
    const r = Math.hypot(p.x, p.y, p.z);
    return { x: p.x, y: p.y, z: p.z, r, lonRad: Math.atan2(p.y, p.x), latRad: Math.asin(p.z / r) };
}

/**
 * The orbit's heliocentric distance (AU) as a function of ecliptic longitude
 * of date — the focus-centred ellipse r = a(1−e²)/(1+e·cos(λ−ϖ)) from the
 * mean elements at `jd`, ϖ precessed to the equinox of date. Mean elements, so
 * it differs from the series' own r by the perturbations (~0.01 AU at Saturn,
 * a few thousandths of a scene unit after compression).
 * @returns {(lonRad:number) => number}
 */
export function orbitRadiusAtLon(key, jd) {
    const el = planetElementsAt(key, jd);
    const varpi = el.omegaBar * D2R + precessionLongitudeRad(jd);
    const p = el.a * (1 - el.e * el.e);
    return (lon) => p / (1 + el.e * Math.cos(lon - varpi));
}

/**
 * Scene position for a planet: true longitude of date, `simDist` of the true
 * distance, flat in the ecliptic. Null for an unknown body.
 */
export function planetScenePosition(key, jd, simDist) {
    const h = planetHelioOfDate(key, jd);
    if (!h) return null;
    const d = simDist(h.r);
    return { x: d * Math.cos(h.lonRad), y: 0, z: d * Math.sin(h.lonRad), helio: h };
}
