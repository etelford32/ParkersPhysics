/**
 * upper-atmosphere-datum.js — ONE Earth radius for the page, and the seam
 * ═══════════════════════════════════════════════════════════════════════════
 * upper-atmosphere.html has two Earth radii in play, and until 2026-10-04
 * they were mixed without a conversion:
 *
 *   PAGE_RE_KM    6371 km   the drawn sphere (1 scene unit), the density
 *                           engine's altitude, the column / volume / camera
 *                           readouts, the flight kernel's datum.
 *   CATALOG_RE_KM 6378.135  WGS-72: what SGP4 works in, what CelesTrak's
 *                           perigee/apogee and the "550 km" a shell is
 *                           quoted at mean, and what the SGP4 WASM's drag
 *                           integrator subtracts to get `alt_km`.
 *
 * A satellite has ONE geocentric radius r. On this page it is DRAWN at
 * r / PAGE_RE_KM and its altitude is r − PAGE_RE_KM — the height above the
 * sphere you can see, the height the engine's density is read at. A
 * catalogue altitude (r − CATALOG_RE_KM) is converted at the boundary,
 * never drawn as if it were a page altitude: that is what put the live
 * catalogue 7 km low (the shared tracker scaled by 6378.135 into a 6371
 * scene) and every TLE-derived probe 7 km low the other way round.
 *
 * The 7.135 km offset is not small here: at 400 km the thermosphere's scale
 * height is ~55 km, so a 7 km datum slip is a ~12 % density error.
 *
 * Analysis modules that work ENTIRELY in the catalogue convention (the SGP4
 * WASM drag integrator, the backtest, the conjunction σ) are internally
 * consistent and are left in it; only what they hand to a VIEW crosses this
 * seam (e.g. the fleet ribbons draw `live.altKm` through `catalogAltToScene`).
 *
 * PURE: no DOM, no three.js. Node-gated by tests/upper-atmosphere-datum.mjs.
 */

import { R_EARTH_KM } from './upper-atmosphere-column.js';

/** The page's datum — the column kernel's, so there is one copy. */
export const PAGE_RE_KM = R_EARTH_KM;
/** WGS-72 equatorial radius, as SGP4 and the CelesTrak relay use it. */
export const CATALOG_RE_KM = 6378.135;
/** Catalogue altitude + this = page altitude (same geocentric radius). */
export const DATUM_OFFSET_KM = CATALOG_RE_KM - PAGE_RE_KM;

/** Geocentric radius (km) → scene units. */
export const radiusKmToScene = (rKm) => rKm / PAGE_RE_KM;
/** Scene radius → page altitude (km). */
export const sceneToPageAltKm = (rScene) => (rScene - 1) * PAGE_RE_KM;
/** Page altitude (km) → scene radius. */
export const pageAltToScene = (hKm) => 1 + hKm / PAGE_RE_KM;
/** Catalogue (WGS-72) altitude → page altitude. */
export const catalogToPageAltKm = (hKm) => hKm + DATUM_OFFSET_KM;
/** Page altitude → catalogue (WGS-72) altitude. */
export const pageToCatalogAltKm = (hKm) => hKm - DATUM_OFFSET_KM;
/** Catalogue altitude → scene radius (the geocentric truth, drawn). */
export const catalogAltToScene = (hKm) => (CATALOG_RE_KM + hKm) / PAGE_RE_KM;
/**
 * The `earthRadius` to hand js/satellite-tracker.js on this page: the
 * tracker scales km by earthRadius / 6378.135, so this makes it km / 6371.
 */
export const TRACKER_EARTH_RADIUS = CATALOG_RE_KM / PAGE_RE_KM;
