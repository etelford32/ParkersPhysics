/**
 * storm-pilot/ships.js — PURE. The four flyable satellites.
 *
 * Stats are game numbers (thrust in game units/s², fuel as a percentage burn
 * rate) shaped after their real classes: a 6U CubeSat is nimble with a tiny
 * tank, a GEO bus is armoured and sluggish, an ion explorer has a huge Δv but
 * only thrusts when its arrays are lit. `hitR` is the bus plus the inner wing
 * in game units — what debris can actually strike, not the drawn glow.
 */
export const SHIPS = Object.freeze({
    wren: {
        id: 'wren', name: 'Wren', cls: '6U CubeSat',
        bars: { agility: 95, armor: 30, fuel: 40, battery: 40 },
        thrust: 0.010, turn: 4.2, hull: 60, fuelBurn: 9, battery: 70, hitR: 0.035,
        special: { key: 'dash', name: 'DASH', cd: 8,
            desc: 'Cold-gas dash: an instant kick along the nose. Recharges in 8 s.' },
    },
    kestrel: {
        id: 'kestrel', name: 'Kestrel', cls: 'SmallSat bus',
        bars: { agility: 65, armor: 60, fuel: 65, battery: 65 },
        thrust: 0.008, turn: 3.0, hull: 100, fuelBurn: 6.4, battery: 100, hitR: 0.05,
        special: { key: 'faraday', name: 'FARADAY', cd: 20,
            desc: 'Faraday cage: 4 s of total radiation immunity. Recharges in 20 s.' },
    },
    atlas: {
        id: 'atlas', name: 'Atlas', cls: 'Rad-hard GEO bus',
        bars: { agility: 30, armor: 95, fuel: 90, battery: 80 },
        thrust: 0.006, turn: 1.8, hull: 160, fuelBurn: 4.5, battery: 120, hitR: 0.075,
        special: { key: 'repair', name: 'REPAIR', cd: 30,
            desc: 'Field repair: restores 25 hull for 40% power. Recharges in 30 s.' },
    },
    dawn: {
        id: 'dawn', name: 'Dawn', cls: 'Ion-drive explorer',
        bars: { agility: 40, armor: 45, fuel: 100, battery: 90 },
        thrust: 0.0035, turn: 2.4, hull: 80, fuelBurn: 0.6, battery: 130, hitR: 0.07, ion: true,
        unlockStars: 12,
        special: { key: 'ion', name: 'ION', cd: 0, passive: true,
            desc: 'Ion drive: a gentle thrust that almost never runs dry, but only while the arrays are lit.' },
    },
});
export const SHIP_ORDER = ['wren', 'kestrel', 'atlas', 'dawn'];
