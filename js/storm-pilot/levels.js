/**
 * storm-pilot/levels.js — PURE. The eight-level campaign, the Endless rules,
 * and the progression rules (unlocks, stars, merges of saved progress).
 *
 * Storm events (game seconds from launch):
 *   flare { t, cls }        X-ray flash, then a proton (SEP) storm a few s later
 *   cme   { t, dur, P }     magnetosphere compressed by dynamic pressure ×P,
 *                           upper atmosphere heated after it lands
 *   hss   { t, dur, P }     high-speed stream: mild compression, belts pumped up
 *   dust  { t, dur, heat }  Mars global dust storm: heats the upper air
 * Orb bands are in game radii (see planets.js), so they sit in real regions:
 * Earth's slot, the gap between Jupiter's belts, under the Martian crustal fields.
 */
import { PLANETS, PLANET_ORDER } from './planets.js';
import { SHIPS } from './ships.js';

export const LEVELS = Object.freeze([
    {
        id: 1, planet: 'earth', name: 'Shakedown', goal: 5, startR: 1.42, view: 3.3,
        orbs: [[1.48, 2.2]], debris: ['iridium'], events: [],
        brief: 'Learn to fly an orbit. Collect 5 data orbs.',
        tip: 'Hold <b>W</b> to burn. Burning <b>prograde</b> (key 2) raises the far side of your orbit; <b>retrograde</b> (key 3) lowers it. Keep clear of the Iridium–Kosmos debris drifting below you.',
        real: 'Real satellites change orbit the way you just did. A short prograde burn on one side of the orbit lifts the opposite side. Two burns half an orbit apart (a Hohmann transfer) are the cheapest way to climb.',
    },
    {
        id: 2, planet: 'earth', name: 'G4 Inbound', goal: 5, survive: true, startR: 1.42, view: 3.4,
        orbs: [[1.25, 2.6]], debris: ['kosmos1408'],
        events: [{ type: 'flare', t: 10, cls: 'X2.4' }, { type: 'cme', t: 24, dur: 24, P: 60 }],
        brief: 'A severe storm is coming. Collect 5 orbs, then ride it out.',
        tip: 'A flare will hit soon. When the <b>CME</b> lands, stay inside the cyan magnetopause and above the swelling air. The Kosmos 1408 debris below you comes <b>head-on</b>.',
        real: 'On 3 Feb 2022 SpaceX launched 49 Starlinks into a 210 km parking orbit during a minor storm. The heated thermosphere raised drag by about 50% and 38 satellites never climbed out. Parkers Physics forecasts exactly this kind of drag surge.',
    },
    {
        id: 3, planet: 'mars', name: 'Naked Planet', goal: 6, startR: 1.42, view: 3.0,
        orbs: [[1.12, 1.9]], debris: [],
        events: [{ type: 'flare', t: 8, cls: 'X8.2' }, { type: 'dust', t: 30, dur: 60, heat: 2.2 }, { type: 'flare', t: 46, cls: 'X1.3' }],
        brief: 'No global field. Use the planet\'s shadow and its magnetized crust as cover.',
        tip: 'Mars has no magnetic bubble. When the protons arrive, duck into the <b>night-side shadow</b> or under a <b>crustal field dome</b>. The domes turn with the planet. Watch out for Phobos.',
        real: 'In September 2017 a solar storm lit up a global aurora on Mars, seen by NASA\'s MAVEN orbiter, and the Curiosity rover measured surface radiation more than doubling. Future crews will need storm shelters, because Mars has no magnetosphere to hide in.',
    },
    {
        id: 4, planet: 'venus', name: 'Ionopause', goal: 5, startR: 1.45, view: 3.0,
        orbs: [[1.25, 2.2]], nightBias: 0.6, debris: [],
        events: [{ type: 'cme', t: 18, dur: 26, P: 20 }, { type: 'flare', t: 40, cls: 'M7.5' }],
        brief: 'Collect data in Venus\'s induced magnetotail without sinking into the thick air.',
        tip: 'Venus has no field of its own, but the solar wind piles up against its ionosphere and drapes into a <b>tail</b> behind the planet. That tail is your best cover. Below it, the air is thick.',
        real: 'ESA\'s Venus Express (2006–2014) watched Venus lose oxygen and hydrogen ions down its induced magnetotail, and the loss rate jumped whenever a CME hit. Without a magnetic shield, the solar wind is still stripping Venus\'s atmosphere today.',
    },
    {
        id: 5, planet: 'mercury', name: 'Crushed', goal: 5, startR: 1.6, view: 2.8,
        orbs: [[1.08, 1.8]], debris: [],
        events: [{ type: 'cme', t: 12, dur: 20, P: 10 }, { type: 'flare', t: 34, cls: 'X3.1' }, { type: 'cme', t: 52, dur: 22, P: 15 }],
        brief: 'Mercury\'s magnetopause gets pushed down to the ground. Hide on the night side.',
        tip: 'Every CME here presses the <b>magnetopause onto the surface</b>. There is no air, so you can skim low, but over the <b>day side</b> the ground radiates enough heat to cook you.',
        real: 'NASA\'s MESSENGER orbiter (2011–2015) caught CMEs pushing Mercury\'s dayside magnetopause all the way down to the surface, leaving the ground directly exposed to the solar wind. It carried a ceramic-cloth sunshade to survive the heat, and so does ESA/JAXA\'s BepiColombo.',
    },
    {
        id: 6, planet: 'jupiter', name: 'Belt Runner', goal: 6, startR: 2.2, view: 3.4,
        orbs: [[1.09, 1.13], [2.14, 2.28]], debris: [],
        events: [{ type: 'hss', t: 20, dur: 30, P: 3 }],
        brief: 'Thread the gaps between the harshest radiation belts in the solar system.',
        tip: 'Data waits in the narrow gap between the belts and just above the cloud tops. <b>Crossing a belt</b> is where the damage happens, so cross fast and with the <b>shield</b> up. Io sits in its own plasma torus.',
        real: 'NASA\'s Juno dives through the gap between Jupiter\'s cloud tops and its radiation belts on every orbit to dodge the worst of them. Its flight computer sits inside a titanium vault about 1 cm thick.',
    },
    {
        id: 7, planet: 'earth', name: 'Slot Region', goal: 6, startR: 1.56, view: 3.4,
        orbs: [[2.53, 2.66], [1.6, 2.4]], debris: ['fengyun'],
        events: [{ type: 'hss', t: 14, dur: 40, P: 3 }, { type: 'flare', t: 40, cls: 'M5.0' }],
        brief: 'Collect orbs in the gap between Earth\'s two radiation belts before a stream fills it.',
        tip: 'The <b>slot</b> between the belts is usually quiet. A high-speed solar wind stream pumps up the outer belt, which spills toward it. The Fengyun-1C cloud at 865 km comes <b>head-on</b>.',
        real: 'Plasma waves called hiss normally keep the slot between Earth\'s belts clear. During the October 2003 Halloween storms, NASA\'s SAMPEX saw the outer belt move right into the slot, where it stayed for weeks.',
    },
    {
        id: 8, planet: 'earth', name: 'Carrington', goal: 6, survive: true, startR: 1.56, view: 3.6,
        orbs: [[1.3, 3.1]], debris: ['kosmos1408', 'fengyun', 'intelsat33e'],
        events: [{ type: 'flare', t: 8, cls: 'X45' }, { type: 'cme', t: 20, dur: 40, P: 400 }, { type: 'flare', t: 50, cls: 'X12' }],
        brief: 'The big one. Survive a Carrington-class storm with today\'s debris in orbit.',
        tip: 'An <b>X45</b> flare. The magnetopause will collapse below GEO. Protons, swelling air and three debris clouds at once. Use everything you have.',
        real: 'On 1 Sep 1859 Richard Carrington watched a white-light flare. Its CME reached Earth in 17.6 hours: aurora were seen in the tropics and telegraph lines sparked. In July 2012 a CME of similar size crossed Earth\'s orbit and missed us by about nine days.',
    },
]);

/** Endless-mode defaults per planet: start, orb bands, which storms it rolls. */
export const ENDLESS = Object.freeze({
    mercury: { startR: 1.6, orbs: [[1.08, 1.9]], view: 2.8, kinds: ['cme', 'flare'] },
    venus:   { startR: 1.45, orbs: [[1.25, 2.3]], view: 3.0, kinds: ['cme', 'flare'] },
    earth:   { startR: 1.56, orbs: [[1.25, 2.9]], view: 3.4, kinds: ['cme', 'flare', 'hss'], debris: ['kosmos1408', 'fengyun'] },
    mars:    { startR: 1.42, orbs: [[1.12, 2.0]], view: 3.0, kinds: ['flare', 'dust'] },
    jupiter: { startR: 2.2, orbs: [[1.09, 1.13], [2.14, 2.28]], view: 3.4, kinds: ['hss', 'flare'] },
});

export const levelById = (id) => LEVELS.find((l) => l.id === id) || null;

/* ── progression ───────────────────────────────────────────────────────── */

/** A fresh progress record. `stars` maps level id → 0–3, `best` maps planet → Endless seconds. */
export const emptyProgress = () => ({ v: 1, stars: {}, best: {} });

export function normalizeProgress(p) {
    const out = emptyProgress();
    if (!p || typeof p !== 'object') return out;
    for (const l of LEVELS) {
        const s = Number(p.stars?.[l.id]);
        if (Number.isFinite(s) && s > 0) out.stars[l.id] = Math.min(3, Math.max(0, Math.round(s)));
    }
    for (const k of PLANET_ORDER) {
        const b = Number(p.best?.[k]);
        if (Number.isFinite(b) && b > 0) out.best[k] = b;
    }
    return out;
}
/** Merge two records, keeping the better result everywhere (sign-in carries a guest run in). */
export function mergeProgress(a, b) {
    const A = normalizeProgress(a), B = normalizeProgress(b), out = emptyProgress();
    for (const l of LEVELS) { const s = Math.max(A.stars[l.id] || 0, B.stars[l.id] || 0); if (s) out.stars[l.id] = s; }
    for (const k of PLANET_ORDER) { const s = Math.max(A.best[k] || 0, B.best[k] || 0); if (s) out.best[k] = s; }
    return out;
}
export const totalStars = (p) => Object.values(normalizeProgress(p).stars).reduce((a, b) => a + b, 0);
/** Level 1 is always open; every other level opens when the one before has a star. */
export const levelUnlocked = (p, id) => id === 1 || (normalizeProgress(p).stars[id - 1] || 0) > 0;
export const planetUnlocked = (p, planet) => LEVELS.some((l) => l.planet === planet && levelUnlocked(p, l.id));
/** Endless on a world opens once you have cleared any level there. */
export const endlessUnlocked = (p, planet) =>
    LEVELS.some((l) => l.planet === planet && (normalizeProgress(p).stars[l.id] || 0) > 0);
export const shipUnlocked = (p, shipId) => totalStars(p) >= (SHIPS[shipId]?.unlockStars || 0);

/** Stars for a finished run: 1 for completing, 2 at ≥ 50% hull, 3 at ≥ 75% hull with ≥ 25% fuel. */
export function starsFor({ win, hullFrac, fuelFrac }) {
    if (!win) return 0;
    return 1 + (hullFrac >= 0.5 ? 1 : 0) + (hullFrac >= 0.75 && fuelFrac >= 0.25 ? 1 : 0);
}

export function planetOfLevel(id) { return PLANETS[levelById(id)?.planet] || null; }
