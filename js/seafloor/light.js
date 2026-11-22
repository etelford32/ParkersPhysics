/**
 * light.js — how much sunlight reaches a depth, and what the dive view does with it. PURE.
 *
 * PHYSICS: downwelling irradiance falls off as E(z) = E₀·e^(−K_d·z) (Beer–Lambert). In the
 * clearest open-ocean water the most penetrating light is blue (~475 nm) with K_d of a few
 * hundredths per metre. `KD_CLEAR_OCEAN` = 0.04 m⁻¹ puts the 1 % light level at 115 m — inside the
 * 100–150 m usually quoted for the clear open ocean. The number is written FROM MEMORY of the
 * Jerlov water-type tables and is `verified: false`; it is an order of magnitude, the page says
 * "about", and coastal water is 3–10× murkier.
 *
 * THE ZONES are the standard pelagic depth zones; their boundaries are conventions, not physics.
 *
 * WHAT THE DIVE VIEW DOES — and it is NOT what a camera would see. Real sea water lets you see
 * tens of metres; a view that honest would be a black frame everywhere below the twilight zone.
 * So the WATER IS DRAWN CLEAR and the terrain is lit by an artificial lamp (disclosed on the
 * stage). Only the SURROUNDINGS' colour carries the physics: `ambientColor(depth)` goes from
 * surface blue to black along a display stretch of the real light fraction (`AMBIENT_STRETCH` —
 * the fraction itself reaches 10⁻⁹ by 500 m, which no display can show).
 */
export const KD_CLEAR_OCEAN = Object.freeze({ perM: 0.04, verified: false, basis: 'clear open-ocean blue light, Jerlov type I–II, from memory' });

export const ZONES = Object.freeze([
    { id: 'epipelagic',   name: 'Sunlight zone',  from: 0,    to: 200,   note: 'enough light for photosynthesis near the top' },
    { id: 'mesopelagic',  name: 'Twilight zone',  from: 200,  to: 1000,  note: 'faint blue light, too little for plants' },
    { id: 'bathypelagic', name: 'Midnight zone',  from: 1000, to: 4000,  note: 'no sunlight at all' },
    { id: 'abyssopelagic', name: 'Abyssal zone',  from: 4000, to: 6000,  note: 'the level of the abyssal plains' },
    { id: 'hadal',        name: 'Hadal zone',     from: 6000, to: Infinity, note: 'the trenches' },
]);

export function zoneAt(depthM) {
    if (!(depthM >= 0)) return null;
    return ZONES.find((z) => depthM >= z.from && depthM < z.to) || ZONES[ZONES.length - 1];
}

/** Fraction of surface sunlight (0–1) reaching depthM. 1 at and above the surface. */
export function sunlightFraction(depthM, kd = KD_CLEAR_OCEAN.perM) {
    return depthM <= 0 ? 1 : Math.exp(-kd * depthM);
}
/** Depth at which the fraction falls to f (the 1 % level is the usual "euphotic depth"). */
export const depthOfFraction = (f, kd = KD_CLEAR_OCEAN.perM) => -Math.log(f) / kd;

/** Display stretch of the light fraction: brightness = fraction^AMBIENT_STRETCH (disclosed, not physics). */
export const AMBIENT_STRETCH = 0.16;
export const SURFACE_WATER_RGB = Object.freeze([28, 96, 168]);
export const SKY_RGB = Object.freeze([5, 9, 18]);            // the stage's own backdrop above the water

/** Backdrop colour (sRGB bytes) for a camera at depthM: surface blue fading to black. Above water: the stage backdrop. */
export function ambientColor(depthM) {
    if (!(depthM > 0)) return SKY_RGB.slice();
    const b = Math.pow(sunlightFraction(depthM), AMBIENT_STRETCH);
    return SURFACE_WATER_RGB.map((v) => Math.round(v * b));
}
