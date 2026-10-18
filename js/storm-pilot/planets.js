/**
 * storm-pilot/planets.js — PURE. The five worlds of Storm Pilot and the ONE
 * distance map the whole game draws in.
 *
 * GAME SCALE (disclosed in the pause menu, never silent):
 *   · Distance: the planet's radius is 1. Altitude h (in planet radii) maps to
 *     r = 1 + ALT_G·asinh(h / ALT_K). That is ~linear through low orbit (400 km
 *     and 900 km above Earth are visibly different shells) and ~logarithmic
 *     beyond, so GEO and the magnetopause still fit on one screen.
 *   · Time: every world uses the same game GM, so a circular orbit at r = 1.25
 *     takes ~36 s everywhere. `timeScale(planet)` reports how much faster than
 *     real that is at that altitude (Earth ≈ ×190).
 *   · Speeds shown in the HUD are REAL km/s: `kmsPer(planet, r)` converts a game
 *     velocity using the real circular speed at the same altitude.
 *
 * WHAT IS REAL: Newtonian two-body orbits, the rocket-style thrust/fuel model,
 * the magnetopause standing off at a pressure balance that scales as P^(−1/6)
 * (Chapman–Ferraro), each planet's real field type (dipole / induced / crustal
 * patches / none), radiation belts where they really are, the eclipse shadow,
 * and drag that grows when a storm heats the upper atmosphere.
 */

export const GM_GAME = 0.06;            // game units: R³/s² — circular period at r = 1.25 ≈ 36 s
export const ALT_G = 0.55;
export const ALT_K = 0.188;             // planet radii (= 1200 km at Earth)

/** Altitude in planet radii → game radius. */
export const toGameH = (h) => 1 + ALT_G * Math.asinh(Math.max(h, 0) / ALT_K);
/** Game radius → altitude in planet radii. */
export const toAltH = (r) => ALT_K * Math.sinh(Math.max(r - 1, 0) / ALT_G);
/** Altitude in km → game radius, for a given planet. */
export const toGame = (planet, altKm) => toGameH(altKm / planet.Rkm);
/** Game radius → altitude in km, for a given planet. */
export const toAltKm = (planet, r) => toAltH(r) * planet.Rkm;
/** Distance from planet centre in planet radii → game radius. */
export const radiiToGame = (rRadii) => toGameH(rRadii - 1);

/** Real circular speed (km/s) at the altitude game-radius r stands for. */
export function realCircularKms(planet, r) {
    return Math.sqrt(planet.GMkm / (planet.Rkm * (1 + toAltH(r))));
}
/** Multiply a game speed at radius r by this to get real km/s. */
export function kmsPer(planet, r) {
    return realCircularKms(planet, r) / Math.sqrt(GM_GAME / r);
}
/** How many times faster than real the game clock runs (circular orbit at r). */
export function timeScale(planet, r = 1.25) {
    const rKm = planet.Rkm * (1 + toAltH(r));
    const real = 2 * Math.PI * Math.sqrt(rKm ** 3 / planet.GMkm);
    const game = 2 * Math.PI * Math.sqrt(r ** 3 / GM_GAME);
    return real / game;
}
/** Planet spin in game radians per game second (prograde = clockwise on screen). */
export function spinRate(planet) {
    return (2 * Math.PI) / (planet.rotH * 3600 / timeScale(planet));
}

export const PLANETS = Object.freeze({
    mercury: {
        id: 'mercury', name: 'Mercury', Rkm: 2440, GMkm: 22032, au: 0.387, rotH: 1407.6,
        field: { type: 'dipole', standoff: 1.45 },      // planet radii, typical
        belts: [],
        atmo: null,
        thermal: { below: 1.35, k: 2.4 },               // dayside infrared at low altitude
        moons: [],
        look: { day: '#d9c3a5', mid: '#8a7560', night: '#17120e', glow: '201,162,122', map: '#c9a27a', size: 30 },
        fact: '<b>Mercury</b> has a magnetic field about 1% as strong as Earth\'s. A strong CME can press its magnetopause right down to the surface. Low over the day side, the ground itself is hot enough to cook you.',
    },
    venus: {
        id: 'venus', name: 'Venus', Rkm: 6052, GMkm: 324859, au: 0.723, rotH: -5832.5,
        // Induced magnetosphere: the boundary where the wind piles up (~1.15 R at noon),
        // above the ionopause (~300 km). It stops most solar-wind plasma, never protons.
        field: { type: 'induced', standoff: 1.15, ionopauseKm: 300 },
        belts: [],
        atmo: { rho0: 2.4, H: 0.04 },
        thermal: null,
        moons: [],
        look: { day: '#ffe4a8', mid: '#c9954a', night: '#1c1408', glow: '255,210,122', map: '#ffd27a', size: 44 },
        fact: '<b>Venus</b> has no magnetic field. The solar wind hits its ionosphere directly and drapes into an induced tail behind the planet. The air is so thick that low orbits decay fast.',
    },
    earth: {
        id: 'earth', name: 'Earth', Rkm: 6371, GMkm: 398600, au: 1, rotH: 23.934,
        field: { type: 'dipole', standoff: 10 },
        belts: [
            { lo: 1.2, hi: 2.5, k: 0.5, hue: '255,63,180' },             // inner (protons)
            { lo: 3.0, hi: 7.0, k: 0.35, hue: '255,197,61', storm: true }, // outer (electrons) — storms pump it
        ],
        atmo: { rho0: 0.9, H: 0.028 },
        thermal: null,
        moons: [],
        look: { day: '#5fd0ff', mid: '#1a4fa8', night: '#050a18', glow: '62,168,255', map: '#3ea8ff', size: 50 },
        fact: '<b>Earth\'s</b> magnetic bubble normally reaches 10 Earth radii toward the Sun. A G5 storm can crush it to 5, and the heated upper air drags satellites down. In Feb 2022 that drag doomed 38 Starlinks.',
    },
    mars: {
        id: 'mars', name: 'Mars', Rkm: 3390, GMkm: 42828, au: 1.524, rotH: 24.62,
        // Crustal magnetic patches, fixed to the ground. The strongest real ones
        // are in the southern highlands (Terra Cimmeria / Sirenum, ~150–210°E);
        // the game puts them on its one great circle and says so.
        field: { type: 'crustal', patches: [
            { lonDeg: 180, halfDeg: 32, altKm: 520, str: 0.85 },
            { lonDeg: 115, halfDeg: 14, altKm: 300, str: 0.6 },
            { lonDeg: 330, halfDeg: 11, altKm: 220, str: 0.45 },
        ] },
        belts: [],
        atmo: { rho0: 0.4, H: 0.032 },
        thermal: null,
        moons: [
            { name: 'Phobos', aKm: 9376, rKm: 11, drawPx: 7 },
            { name: 'Deimos', aKm: 23463, rKm: 6, drawPx: 5 },
        ],
        look: { day: '#ff8a5c', mid: '#a8402a', night: '#160806', glow: '255,140,100', map: '#ff6a3d', size: 36 },
        fact: '<b>Mars</b> lost its global magnetic field about 4 billion years ago. Only patches of magnetized crust still make small umbrellas, and they turn with the planet.',
    },
    jupiter: {
        id: 'jupiter', name: 'Jupiter', Rkm: 71492, GMkm: 1.26687e8, au: 5.2, rotH: 9.925,
        field: { type: 'dipole', standoff: 63 },
        belts: [
            { lo: 1.05, hi: 1.7, k: 2.2, hue: '255,63,180' },
            { lo: 2.0, hi: 4.0, k: 1.2, hue: '255,197,61', storm: true },
            { lo: 5.4, hi: 6.4, k: 0.9, hue: '255,120,60', torus: true },   // Io plasma torus
        ],
        atmo: { rho0: 0.9, H: 0.02 },
        thermal: null,
        moons: [{ name: 'Io', aKm: 421700, rKm: 1821, drawPx: 9, volcanic: true }],
        look: { day: '#f2d2b0', mid: '#b07a52', night: '#140c08', glow: '232,180,138', map: '#e8b48a', size: 70, bands: true },
        fact: '<b>Jupiter\'s</b> magnetosphere is the largest structure in the solar system after the Sun\'s own. Its radiation belts are the harshest anywhere, and the volcanic moon Io feeds a ring of plasma around it.',
    },
});

export const PLANET_ORDER = ['mercury', 'venus', 'earth', 'mars', 'jupiter'];

/** Solar-wind dynamic pressure relative to Earth's (falls as 1/d²). */
export const windPressure = (planet) => 1 / (planet.au * planet.au);
