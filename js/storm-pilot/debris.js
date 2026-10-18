/**
 * storm-pilot/debris.js — PURE. Debris clouds from REAL breakups.
 *
 * Every cloud sits at the real breakup altitude. Each fragment is a two-body
 * orbit launched from the breakup point with a breakup Δv kick, so a cloud is
 * a clumped, slightly eccentric ring, which is what real clouds look like a few
 * weeks after the event. Fragments feel the same drag the player does (with a
 * higher area-to-mass ratio), so a storm visibly drags a low cloud down, as the
 * 2022–24 solar maximum did to the Kosmos 1408 cloud.
 *
 * Each drawn shard stands in for roughly 40 tracked fragments. Real debris
 * from a different orbital plane crosses your path at 10–15 km/s; a flat game
 * cannot show a plane, so cross-plane clouds are drawn orbiting the other way
 * (`dir: −1`), which gives the same closing speed. Debris only exists around
 * Earth — the game never invents clouds at other worlds.
 */
import { GM_GAME, toGame } from './planets.js';

export const DEBRIS = Object.freeze({
    iridium: {
        name: 'Iridium 33 / Kosmos 2251', what: 'collision', year: 2009, altKm: 789, tracked: 2300,
        dir: 1, n: 34, spread: 0.035,
        real: 'On 10 Feb 2009 the dead Russian satellite Kosmos 2251 hit the working Iridium 33 at 789 km and 11.7 km/s. It was the first accidental collision between two intact satellites and left about 2,300 trackable fragments.',
    },
    kosmos1408: {
        name: 'Kosmos 1408', what: 'anti-satellite test', year: 2021, altKm: 480, tracked: 1500,
        dir: -1, n: 40, spread: 0.04,
        real: 'On 15 Nov 2021 a Russian missile destroyed Kosmos 1408 at 480 km, making about 1,500 trackable fragments. The ISS crew sheltered in their capsules. The strong solar activity of 2022–24 heated the thermosphere and pulled most of the cloud down years early.',
    },
    fengyun: {
        name: 'Fengyun-1C', what: 'anti-satellite test', year: 2007, altKm: 865, tracked: 3500,
        dir: -1, n: 40, spread: 0.03,
        real: 'China\'s January 2007 test against the Fengyun-1C weather satellite at 865 km made the largest debris cloud on record, over 3,500 tracked pieces. Drag is weak that high, so most of it will stay up for decades.',
    },
    intelsat33e: {
        name: 'Intelsat 33e', what: 'breakup', year: 2024, altKm: 35786, tracked: 500,
        dir: 1, n: 26, spread: 0.02,
        real: 'In October 2024 the Intelsat 33e communications satellite broke apart in geostationary orbit, 35,786 km up, leaving around 500 fragments. Nothing drags debris down at that height.',
    },
});

/** Fragments per drawn shard, for the disclosure line. */
export const SHARD_REPRESENTS = 40;
/** Head-on strikes above this closing speed (km/s) can snap a wing off. */
export const WING_SNAP_KMS = 10;

/**
 * Build one cloud. `rng` is the game's seeded generator. The player orbits
 * clockwise, so `dir: +1` means moving with the player.
 */
export function makeCloud(planet, key, rng) {
    const D = DEBRIS[key];
    const rd = toGame(planet, D.altKm), vc = Math.sqrt(GM_GAME / rd), a0 = rng() * Math.PI * 2;
    const g = () => (rng() + rng() + rng() - 1.5) / 1.5;              // ≈ unit gaussian
    const out = [];
    for (let i = 0; i < D.n; i++) {
        const a = a0 + g() * 2.4 + (i % 3 ? 0 : g() * 3);
        const r = rd * (1 + g() * 0.008);
        const vt = D.dir * vc * (1 + g() * D.spread * 0.5), vr = vc * g() * D.spread * 0.15;
        out.push({
            x: Math.cos(a) * r, y: Math.sin(a) * r,
            vx: Math.sin(a) * vt + Math.cos(a) * vr, vy: -Math.cos(a) * vt + Math.sin(a) * vr,
            spin: rng() * 6, ws: (rng() - 0.5) * 8, sz: 2.4 + rng() * 2.2, cloud: key, seed: rng(),
        });
    }
    return out;
}
