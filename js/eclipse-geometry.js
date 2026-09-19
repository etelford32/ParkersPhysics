/**
 * eclipse-geometry.js — PURE occultation, shadow and reflected-light kernel
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no three.js, no ambient time. Consumed by
 * solar-system.html (the Moon and every other drawn satellite) and by
 * js/neo-layer.js (near-Earth objects inside the Earth-local frame).
 *
 * Gate: `node tests/eclipse-geometry.mjs` after ANY edit.
 *
 * ── What is modelled ──────────────────────────────────────────────────────
 * One question, asked from the surface of a body: HOW MUCH OF THE SUN CAN IT
 * SEE? Everything else here follows from the answer.
 *
 *   · A body inside a planet's shadow is dimmer by exactly the fraction of the
 *     solar disc that planet covers — two overlapping circles on the sky, which
 *     is a closed form and not an approximation. That is a lunar eclipse when
 *     the body is the Moon, an eclipse of Io when the occulter is Jupiter, and
 *     a rare, real thing for a near-Earth object making a close pass.
 *   · A body near a lit planet also receives light REFLECTED from it —
 *     earthshine, the "old Moon in the new Moon's arms". It falls off as 1/d²
 *     and it is brightest when the planet is FULL as seen from the body, which
 *     is exactly when the body is a thin crescent as seen from the planet. That
 *     relationship is not scripted here; it falls out of the phase angle.
 *
 * ── The one thing this kernel refuses to do ───────────────────────────────
 * It never reads a DRAWN position. The orrery compresses distance onto a log
 * scale and draws the Moon at ~2 Earth radii instead of 60, so a shadow cone
 * built in scene units would be pure fiction. Every function here takes REAL
 * kilometres, and the caller applies the resulting dimming to whatever it
 * draws. Numbers are honest; the geometry they are applied to is a disclosed
 * display convention.
 *
 * ── Sources ───────────────────────────────────────────────────────────────
 * Circle-circle lens area: standard closed form (Weisstein, "Circular Segment").
 * Lambert-sphere phase law Φ(α) = [sin α + (π − α) cos α] / π — the classic
 * result for a diffusely reflecting sphere, used for the reflecting PLANET
 * (an airless body's own scattering is the caller's business; see
 * js/airless-body.js and the H–G law in js/neo-orbits.js).
 * Geometric albedos: NASA/JPL planetary and satellite fact sheets.
 */

export const SUN_RADIUS_KM = 695_700;
export const EARTH_RADIUS_KM = 6_371.0;

/**
 * Geometric albedo (V) for the bodies this page draws. A geometric albedo CAN
 * exceed 1 — a strongly backscattering surface returns more light at zero
 * phase than a Lambert disc of the same cross-section would, which is why
 * Enceladus is listed above unity and is not a typo. Sources are the JPL
 * satellite fact sheets; Iapetus is the mean of its two faces (0.05 leading,
 * 0.27 trailing) because this kernel has no hemisphere term.
 */
export const BODY_ALBEDO = Object.freeze({
    // Planets, for the reflected-light term (earthshine and its cousins).
    mercury: 0.142, venus: 0.689, earth: 0.306, mars: 0.170,
    jupiter: 0.538, saturn: 0.499, uranus: 0.488, neptune: 0.442, pluto: 0.52,
    // Satellites.
    moon: 0.120,
    phobos: 0.071, deimos: 0.068,
    metis: 0.061, adrastea: 0.10, amalthea: 0.090, thebe: 0.047,
    io: 0.63, europa: 0.67, ganymede: 0.43, callisto: 0.22,
    pan: 0.50, mimas: 0.962, enceladus: 1.375, tethys: 0.800, dione: 0.998,
    rhea: 0.949, titan: 0.22, hyperion: 0.30, iapetus: 0.16, phoebe: 0.060,
    miranda: 0.32, ariel: 0.39, umbriel: 0.21, titania: 0.27, oberon: 0.23,
    naiad: 0.072, despina: 0.090, galatea: 0.080, larissa: 0.090,
    proteus: 0.096, triton: 0.76, nereid: 0.155,
    charon: 0.38,
});
/** IAU default phase slope; airless satellites sit near it. */
export const DEFAULT_G = 0.15;

/**
 * Brightness of a totally eclipsed body as a fraction of its uneclipsed self,
 * and the colour of that light.
 *
 * THE UMBRA IS NOT BLACK. Sunlight refracted through Earth's atmosphere — the
 * ring of every sunrise and sunset on the planet at once — reaches the Moon
 * and turns it copper. The Danjon scale puts a typical totality four to six
 * magnitudes below full, i.e. 1/40 to 1/250, and this constant sits inside
 * that band. It is a DISCLOSED CONSTANT, not a computed atmospheric
 * transmission: modelling that properly needs an ozone and aerosol profile and
 * would still be a forecast. Anything drawing it must say so.
 */
export const UMBRAL_TRANSMISSION = 0.012;
export const UMBRAL_TINT = Object.freeze({ r: 1.0, g: 0.34, b: 0.14 });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Angular radius (rad) of a sphere of `radiusKm` seen from `distanceKm`. */
export function angularRadiusRad(radiusKm, distanceKm) {
    if (!(radiusKm > 0) || !(distanceKm > 0)) return 0;
    if (distanceKm <= radiusKm) return Math.PI / 2;      // inside the body
    return Math.asin(radiusKm / distanceKm);
}

/**
 * Fraction of disc A (angular radius `rA`) hidden behind disc B (`rB`) when
 * their centres are `sep` apart. All three in radians; the small-angle error
 * of treating them as flat discs is far below anything drawn.
 *
 * Four regimes, and the two degenerate ones are the interesting cases:
 *   sep ≥ rA + rB     → 0, disjoint
 *   sep ≤ rB − rA     → 1, B swallows A (TOTAL — Earth's disc at the Moon is
 *                       2.7× the Sun's, which is why lunar totality exists)
 *   sep ≤ rA − rB     → (rB/rA)², B sits inside A (ANNULAR — exactly the area
 *                       ratio, which is why an annular solar eclipse never goes
 *                       dark)
 *   otherwise         → the circle-circle lens area, in closed form
 */
export function occultedFraction(rA, rB, sep) {
    if (!(rA > 0)) return 0;
    if (!(rB > 0)) return 0;
    const d = Math.max(0, sep);
    if (d >= rA + rB) return 0;
    if (d <= rB - rA) return 1;
    if (d <= rA - rB) return clamp((rB * rB) / (rA * rA), 0, 1);
    const d2 = d * d, a2 = rA * rA, b2 = rB * rB;
    const lens =
        a2 * Math.acos(clamp((d2 + a2 - b2) / (2 * d * rA), -1, 1)) +
        b2 * Math.acos(clamp((d2 + b2 - a2) / (2 * d * rB), -1, 1)) -
        0.5 * Math.sqrt(Math.max(0, (-d + rA + rB) * (d + rA - rB) * (d - rA + rB) * (d + rA + rB)));
    return clamp(lens / (Math.PI * a2), 0, 1);
}

function norm(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function angleBetween(a, b) {
    const na = norm(a), nb = norm(b);
    if (!(na > 0) || !(nb > 0)) return 0;
    return Math.acos(clamp((a.x * b.x + a.y * b.y + a.z * b.z) / (na * nb), -1, 1));
}

/**
 * How much sunlight reaches a body, and what an observer would call it.
 *
 * @param {{ sunFromBody:{x,y,z}, occulterFromBody:{x,y,z},
 *           occulterRadiusKm:number, sunRadiusKm?:number }} o
 *        Both vectors point FROM the body, in the same frame and in km.
 * @returns {{ lit:number, covered:number, phase:'none'|'penumbral'|'umbral',
 *             sepRad:number, sunRad:number, occRad:number }}
 *        `lit` is the fraction of the solar disc still visible — multiply the
 *        body's illumination by it. `phase` names what is happening:
 *        'umbral' means the Sun is COMPLETELY hidden (totality), and a caller
 *        that draws the body must then use UMBRAL_TRANSMISSION rather than
 *        zero, because the umbra is lit by refracted sunlight.
 */
export function shadowIllumination(o) {
    const { sunFromBody, occulterFromBody, occulterRadiusKm, sunRadiusKm = SUN_RADIUS_KM } = o ?? {};
    const out = { lit: 1, covered: 0, phase: 'none', sepRad: Math.PI, sunRad: 0, occRad: 0 };
    if (!sunFromBody || !occulterFromBody || !(occulterRadiusKm > 0)) return out;
    const dSun = norm(sunFromBody), dOcc = norm(occulterFromBody);
    if (!(dSun > 0) || !(dOcc > 0)) return out;
    // An occulter further away than the Sun cannot shadow anything.
    if (dOcc >= dSun) return out;
    out.sunRad = angularRadiusRad(sunRadiusKm, dSun);
    out.occRad = angularRadiusRad(occulterRadiusKm, dOcc);
    out.sepRad = angleBetween(sunFromBody, occulterFromBody);
    out.covered = occultedFraction(out.sunRad, out.occRad, out.sepRad);
    out.lit = 1 - out.covered;
    out.phase = out.covered <= 0 ? 'none' : (out.covered >= 1 ? 'umbral' : 'penumbral');
    return out;
}

/**
 * Lambert-sphere phase law: the fraction of a diffusely reflecting sphere's
 * full-phase brightness at phase angle α. Φ(0) = 1 (full), Φ(π/2) = 1/π
 * (quarter), Φ(π) = 0 (new). Used for the REFLECTING planet in the
 * earthshine term — not for the airless body receiving it.
 */
export function lambertPhase(alphaRad) {
    if (!Number.isFinite(alphaRad)) return 0;
    const a = clamp(alphaRad, 0, Math.PI);
    return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
}

/**
 * Light a body receives from a nearby lit planet, as a FRACTION of the direct
 * sunlight it receives — so a caller can add it to the same illumination term.
 *
 *   E_reflected / E_direct = p · (R/d)² · Φ(α)
 *
 * with p the planet's geometric albedo, R its radius, d the body's distance
 * from it, and α the phase angle of the PLANET as seen from the body. At the
 * Moon that is ~8×10⁻⁵ at full Earth, which matches the measured ~10⁻⁴ of
 * sunlight, and it peaks when Earth is full from the Moon — i.e. when the Moon
 * is NEW from Earth, which is when earthshine is actually seen. Nothing keys
 * that behaviour; it falls out of α.
 *
 * @param {{ bodyFromPlanetKm:{x,y,z}, sunFromPlanetKm:{x,y,z},
 *           planetRadiusKm:number, albedo:number }} o
 */
export function reflectedIrradianceFraction(o) {
    const { bodyFromPlanetKm, sunFromPlanetKm, planetRadiusKm, albedo } = o ?? {};
    if (!bodyFromPlanetKm || !sunFromPlanetKm || !(planetRadiusKm > 0) || !(albedo > 0)) return 0;
    const d = norm(bodyFromPlanetKm);
    if (!(d > planetRadiusKm)) return 0;
    // THE PHASE ANGLE IS MEASURED AT THE ILLUMINATED BODY, which here is the
    // PLANET: alpha is the Sun-planet-body angle. The tempting reading - the
    // angle AT the receiving body, between its direction to the Sun and its
    // direction to the planet - is a different quantity (that body's own
    // elongation) and, because the body is very close to the planet compared
    // with the Sun, is almost exactly pi MINUS this one. Using it inverts the
    // term end to end: earthshine came out brightest at FULL moon, which is
    // precisely when no one has ever seen it, and vanished at new moon, which
    // is the only time anyone has. Measured, 2026-09-19.
    const alpha = angleBetween(sunFromPlanetKm, bodyFromPlanetKm);
    const r = planetRadiusKm / d;
    return albedo * r * r * lambertPhase(alpha);
}

/**
 * The length of a body's umbra — the distance behind it at which its shadow
 * cone closes to a point. Nothing beyond this can be totally eclipsed by it.
 * Earth's is ~1.38 million km, which is why the Moon (0.384 million) can go
 * fully dark and why only a near-Earth object inside ~3.6 lunar distances can.
 */
export function umbraLengthKm(bodyRadiusKm, sunDistanceKm, sunRadiusKm = SUN_RADIUS_KM) {
    if (!(bodyRadiusKm > 0) || !(sunDistanceKm > 0) || !(sunRadiusKm > bodyRadiusKm)) return 0;
    return (bodyRadiusKm * sunDistanceKm) / (sunRadiusKm - bodyRadiusKm);
}
