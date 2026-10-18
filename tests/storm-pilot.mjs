/**
 * storm-pilot.mjs — node gate for the Storm Pilot kernel (js/storm-pilot/*).
 *
 * Pins the physics claims the game makes on screen and in its debriefs:
 * the distance map is invertible, an unpowered orbit is a real Kepler orbit,
 * the magnetopause scales as P^(−1/6) and Mercury's is crushed by a CME, debris
 * clouds sit at their real breakup altitudes and only exist at Earth, a fast
 * head-on strike snaps a wing (which becomes debris), the arrays follow the
 * Sun, and the progression rules never lose stars.
 *
 *   node tests/storm-pilot.mjs
 */
import assert from 'node:assert/strict';
import { PLANETS, PLANET_ORDER, GM_GAME, toGame, toAltKm, toGameH, toAltH, kmsPer, timeScale, radiiToGame } from '../js/storm-pilot/planets.js';
import { DEBRIS, WING_SNAP_KMS } from '../js/storm-pilot/debris.js';
import { SHIPS, SHIP_ORDER } from '../js/storm-pilot/ships.js';
import { LEVELS, ENDLESS, emptyProgress, mergeProgress, normalizeProgress, levelUnlocked, endlessUnlocked, shipUnlocked, starsFor, totalStars } from '../js/storm-pilot/levels.js';
import * as SIM from '../js/storm-pilot/sim.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

console.log('storm-pilot kernel');

ok('distance map round-trips and is monotonic', () => {
    for (const h of [0, 0.01, 0.1, 0.5, 2, 9, 60]) near(toAltH(toGameH(h)), h, 1e-9 * Math.max(1, h), `h=${h}`);
    let last = 1;
    for (let km = 0; km <= 40000; km += 500) { const r = toGame(PLANETS.earth, km); assert.ok(r >= last); last = r; }
    near(toAltKm(PLANETS.earth, toGame(PLANETS.earth, 480)), 480, 1e-6, 'Kosmos 1408 altitude');
});

ok('HUD speeds are real: a circular orbit reads the real circular speed', () => {
    const P = PLANETS.earth, r = toGame(P, 400);
    near(Math.sqrt(GM_GAME / r) * kmsPer(P, r), 7.67, 0.01, 'circular speed at 400 km');
    assert.ok(timeScale(P) > 100 && timeScale(P) < 300, `Earth time scale ${timeScale(P)}`);
});

ok('an unpowered, airless orbit conserves energy and angular momentum (it is Kepler)', () => {
    const G = SIM.createGame({ levelId: 6, shipId: 'kestrel', seed: 4 });   // Jupiter, start in the belt gap
    G.vx *= 1.05;                                                         // make it eccentric
    G.frags = []; G.moons = []; G.events = [];
    const E = () => 0.5 * (G.vx ** 2 + G.vy ** 2) - GM_GAME / Math.hypot(G.x, G.y);
    const L = () => G.x * G.vy - G.y * G.vx;
    const e0 = E(), l0 = L();
    for (let i = 0; i < 120 * 40; i++) SIM.stepGame(G, {}, 1 / 120);
    near(E() / e0, 1, 2e-3, 'energy'); near(L() / l0, 1, 1e-9, 'angular momentum');
});

ok('magnetopause standoff scales as P^(−1/6) (Chapman–Ferraro)', () => {
    const P = PLANETS.earth;
    near(SIM.standoffRadii(P, 1), 10, 1e-12, 'quiet');
    near(SIM.standoffRadii(P, 64) / SIM.standoffRadii(P, 1), 0.5, 1e-12, '×64 pressure halves it');
    assert.equal(SIM.standoffRadii(PLANETS.mars, 10), null, 'Mars has no global boundary');
});

ok('a CME crushes Mercury\'s magnetopause onto the surface; Earth\'s survives', () => {
    assert.ok(SIM.standoffRadii(PLANETS.mercury, 10) <= 1, 'Mercury at P×10');
    assert.ok(SIM.standoffRadii(PLANETS.earth, 400) > 3, 'Earth at P×400 (Carrington)');
});

ok('cover is real: inside the magnetopause no wind dose; the night shadow blocks most protons', () => {
    const G = SIM.createGame({ levelId: 1, shipId: 'kestrel', seed: 1 });
    const S = { ...SIM.stormAt(G, 0), sep: 1 };
    const inside = SIM.exposure(G, 0, 1.3, S), outside = SIM.exposure(G, -4.5, 0, S);
    assert.ok(inside.inside && !outside.inside);
    const M = SIM.createGame({ levelId: 3, shipId: 'kestrel', seed: 1 });
    // points clear of the crustal domes, so only the shadow differs
    const day = SIM.exposure(M, -1.0, -1.0, S), night = SIM.exposure(M, 1.4, -0.5, S);
    assert.ok(!day.cover && !night.cover);
    assert.ok(night.shadow && night.rate < day.rate * 0.3, `night ${night.rate} vs day ${day.rate}`);
});

ok('only Earth\'s CMEs heat the upper air (Joule heating needs a planet\'s own field)', () => {
    const E = SIM.createGame({ levelId: 2, shipId: 'kestrel', seed: 1 });
    const V = SIM.createGame({ levelId: 4, shipId: 'kestrel', seed: 1 });
    assert.ok(SIM.stormAt(E, 40).heat > 1.5);
    assert.equal(SIM.stormAt(V, 40).heat, 1);
});

ok('debris clouds sit at their real breakup altitudes and only orbit Earth', () => {
    for (const L of LEVELS) if (L.debris.length) assert.equal(L.planet, 'earth', `level ${L.id}`);
    for (const k of Object.keys(ENDLESS)) if (ENDLESS[k].debris) assert.equal(k, 'earth');
    const G = SIM.createGame({ levelId: 8, shipId: 'kestrel', seed: 9 });
    for (const key of G.clouds) {
        const rs = G.frags.filter((f) => f.cloud === key).map((f) => toAltKm(G.planet, Math.hypot(f.x, f.y)));
        const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
        near(mean, DEBRIS[key].altKm, DEBRIS[key].altKm * 0.05, `${key} mean altitude`);
    }
    // cross-plane clouds come head-on; Iridium–Kosmos moves with you
    const dirOf = (f) => Math.sign(f.x * f.vy - f.y * f.vx);              // −1 = clockwise = with the player
    const ir = SIM.createGame({ levelId: 1, shipId: 'kestrel', seed: 2 }).frags;
    assert.ok(ir.every((f) => dirOf(f) === -1), 'Iridium cloud co-moving');
    assert.ok(G.frags.filter((f) => f.cloud === 'kosmos1408').every((f) => dirOf(f) === 1), 'Kosmos cloud head-on');
});

ok('conjunction screening warns before a strike, and a fast head-on strike snaps a wing', () => {
    const G = SIM.createGame({ levelId: 2, shipId: 'atlas', seed: 5 });
    G.frags = []; G.t = 3;
    // one fragment ahead on the same circle, orbiting the other way
    const a = Math.PI / 2 - 0.12, r = Math.hypot(G.x, G.y), v = Math.sqrt(GM_GAME / r);
    G.frags.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, vx: -Math.sin(a) * v, vy: Math.cos(a) * v, spin: 0, ws: 0, sz: 3, cloud: 'kosmos1408', seed: 0.5 });
    let warned = false;
    G.rng = () => 0.1;                                                    // force the snap roll
    for (let i = 0; i < 240 && !G.hits; i++) { SIM.stepGame(G, {}, 1 / 120); warned ||= !!G.conj; }
    assert.ok(warned, 'conjunction raised before impact');
    assert.equal(G.hits, 1);
    assert.equal(G.wingsLost, 1, `closing speed should exceed ${WING_SNAP_KMS} km/s`);
    assert.ok(!G.wings.neg || !G.wings.pos);
    assert.ok(G.frags.some((f) => f.wing), 'the lost wing became debris');
    assert.ok(G.fx.some((e) => e.type === 'wing'));
});

ok('the arrays follow the Sun: full power nose-on, none broadside, none in shadow, half with one wing', () => {
    const G = SIM.createGame({ levelId: 1, shipId: 'kestrel', seed: 1 });
    G.frags = [];
    const settle = (ang) => { for (let i = 0; i < 240; i++) { G.ang = ang; SIM.stepGame(G, {}, 1 / 120); } return G.sunEff; };
    G.x = -1.5; G.y = 0; G.vx = 0; G.vy = -Math.sqrt(GM_GAME / 1.5);
    assert.ok(settle(Math.PI) > 0.9, 'nose at the Sun');
    G.x = -1.5; G.y = 0; G.vx = 0; G.vy = -Math.sqrt(GM_GAME / 1.5);
    assert.ok(settle(Math.PI / 2) < 0.1, 'broadside');
    G.wings.pos = false;
    G.x = -1.5; G.y = 0; G.vx = 0; G.vy = -Math.sqrt(GM_GAME / 1.5);
    near(settle(Math.PI), 0.5, 0.06, 'one wing');
    G.x = 1.5; G.y = 0; G.vx = 0; G.vy = Math.sqrt(GM_GAME / 1.5);
    SIM.stepGame(G, {}, 1 / 120);
    assert.equal(G.sunEff, 0, 'eclipse');
});

ok('an ion drive only thrusts in sunlight', () => {
    const G = SIM.createGame({ levelId: 1, shipId: 'dawn', seed: 1 });
    G.frags = [];
    G.x = 1.5; G.y = 0; G.vx = 0; G.vy = Math.sqrt(GM_GAME / 1.5);       // in the shadow
    SIM.stepGame(G, { thrust: true }, 1 / 120);
    assert.equal(G.thrusting, false);
    G.x = -1.5; G.vy = -Math.sqrt(GM_GAME / 1.5); G.ang = Math.PI;
    for (let i = 0; i < 120; i++) { G.ang = Math.PI; SIM.stepGame(G, { thrust: true }, 1 / 120); }
    assert.equal(G.thrusting, true);
});

ok('runs are deterministic for a seed', () => {
    const run = () => { const G = SIM.createGame({ levelId: 2, shipId: 'wren', seed: 77 });
        for (let i = 0; i < 120 * 30; i++) SIM.stepGame(G, { thrust: i % 300 < 40 }, 1 / 120);
        return [G.x, G.y, G.hull, G.frags.length, G.decayed]; };
    assert.deepEqual(run(), run());
});

ok('every level is winnable in principle and well formed', () => {
    assert.equal(LEVELS.length, 8);
    assert.deepEqual(LEVELS.map((l) => l.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const L of LEVELS) {
        assert.ok(PLANETS[L.planet] && L.goal > 0 && L.orbs.length && L.real && L.tip && L.brief, `level ${L.id}`);
        for (const [lo, hi] of L.orbs) assert.ok(lo > 1 && hi > lo && hi < L.view * 1.9, `level ${L.id} orb band`);
        for (const k of L.debris) assert.ok(DEBRIS[k], k);
        const G = SIM.createGame({ levelId: L.id, shipId: 'kestrel', seed: 3 });
        assert.equal(G.orbs.length, L.goal);
        for (let i = 0; i < 120 * 3; i++) SIM.stepGame(G, {}, 1 / 120);
        assert.ok(!G.done, `level ${L.id}: an idle pilot survives the first 3 s (${G.why})`);
    }
    for (const id of PLANET_ORDER) {
        const G = SIM.createGame({ planetId: id, shipId: 'kestrel', endless: true, seed: 3 });
        for (let i = 0; i < 120 * 12; i++) SIM.stepGame(G, {}, 1 / 120);
        assert.ok(G.events.length > 0, `endless ${id} schedules storms`);
    }
});

ok('progression: unlocks, stars, merges never lose a result', () => {
    const p = emptyProgress();
    assert.ok(levelUnlocked(p, 1) && !levelUnlocked(p, 2));
    assert.ok(!endlessUnlocked(p, 'earth'));
    p.stars[1] = 2;
    assert.ok(levelUnlocked(p, 2) && endlessUnlocked(p, 'earth'));
    assert.equal(starsFor({ win: false, hullFrac: 1, fuelFrac: 1 }), 0);
    assert.equal(starsFor({ win: true, hullFrac: 0.4, fuelFrac: 1 }), 1);
    assert.equal(starsFor({ win: true, hullFrac: 0.6, fuelFrac: 0 }), 2);
    assert.equal(starsFor({ win: true, hullFrac: 0.8, fuelFrac: 0.3 }), 3);
    const m = mergeProgress({ stars: { 1: 3, 2: 1 }, best: { earth: 40 } }, { stars: { 1: 1, 3: 2 }, best: { earth: 90, mars: 10 } });
    assert.deepEqual(m.stars, { 1: 3, 2: 1, 3: 2 });
    assert.deepEqual(m.best, { earth: 90, mars: 10 });
    assert.equal(totalStars(m), 6);
    assert.deepEqual(normalizeProgress({ stars: { 1: 9, 99: 3, 2: 'x' } }).stars, { 1: 3 });
    assert.ok(!shipUnlocked(m, 'dawn') && shipUnlocked({ stars: { 1: 3, 2: 3, 3: 3, 4: 3 } }, 'dawn'));
    for (const id of SHIP_ORDER) assert.ok(SHIPS[id].hull > 0 && SHIPS[id].special);
});

ok('the belts are where they really are', () => {
    // Earth's slot (2.5–3.0 R⊕) is between the two belts; level 7 puts orbs in it
    const slot = [radiiToGame(2.5), radiiToGame(3.0)];
    const L7 = LEVELS.find((l) => l.id === 7);
    assert.ok(L7.orbs.some(([lo, hi]) => lo >= slot[0] && hi <= slot[1]), 'slot orbs');
    const G = SIM.createGame({ levelId: 7, shipId: 'kestrel', seed: 1 });
    const S = SIM.stormAt(G, 0);
    const mid = (slot[0] + slot[1]) / 2;
    assert.equal(SIM.exposure(G, 0, mid, S).belts, 0, 'nothing in the slot when quiet');
    assert.ok(SIM.exposure(G, 0, radiiToGame(1.8), S).belts > 0.3, 'inner belt');
});

console.log(`\n${n} checks passed`);
