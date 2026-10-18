/**
 * storm-pilot/sim.js — PURE, deterministic game kernel. No DOM, no canvas, no
 * ambient time or Math.random: everything random comes from the run's seeded
 * generator, so a seed + an input stream replays exactly (the node gate relies
 * on that).
 *
 *   createGame({ levelId | planetId+endless, shipId, seed }) → G
 *   stepGame(G, input, dt)      input = { left, right, thrust, boost }
 *   setShield(G, on) · useSpecial(G) · setSas(G, mode)
 *   result(G)                   the debrief numbers
 *
 * The sim emits presentation events into G.fx ({ type, … }) for the renderer
 * and HUD to consume; it never draws.
 *
 * Coordinates: planet centre at the origin, planet radius 1, y up, the Sun far
 * away along −x. The player starts at the top moving +x, i.e. CLOCKWISE, and
 * "with the player" means clockwise everywhere (orbs, debris dir +1, moons).
 */
import { GM_GAME, PLANETS, toGame, radiiToGame, toAltKm, kmsPer, spinRate, windPressure } from './planets.js';
import { SHIPS } from './ships.js';
import { DEBRIS, makeCloud, WING_SNAP_KMS } from './debris.js';
import { levelById, ENDLESS, starsFor } from './levels.js';

export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ── construction ──────────────────────────────────────────────────────── */

export function createGame({ levelId = null, planetId = null, shipId = 'kestrel', endless = false, seed = 1 } = {}) {
    const level = endless ? null : levelById(levelId);
    if (!endless && !level) throw new Error(`storm-pilot: unknown level ${levelId}`);
    const pid = endless ? planetId : level.planet;
    const planet = PLANETS[pid];
    const cfg = endless ? ENDLESS[pid] : level;
    const ship = SHIPS[shipId];
    if (!planet || !ship) throw new Error('storm-pilot: unknown planet or ship');
    const rng = mulberry32(seed);
    const r0 = cfg.startR, v0 = Math.sqrt(GM_GAME / r0);
    const G = {
        planet, ship, level, endless, rng, seed,
        view: cfg.view, orbBands: cfg.orbs, nightBias: cfg.nightBias || 0,
        t: 0, x: 0, y: r0, vx: v0, vy: 0, ang: 0, spin: 0,
        hull: ship.hull, pwr: 100, fuel: 100,
        sas: 'free', shield: false, fold: 0, track: 1, sunEff: 1,
        spCd: 0, faraday: 0, thrusting: false, boosting: false,
        wings: { neg: true, pos: true }, panelHits: 0,
        data: 0, goal: endless ? Infinity : level.goal,
        orbs: [], frags: [], clouds: [...(cfg.debris || [])], moons: [],
        events: endless ? [] : level.events.map((e) => ({ ...e })), nextEvt: 8, evtCount: 0,
        hits: 0, nearMiss: 0, decayed: 0, wingsLost: 0, dose: 0, minR: r0,
        conj: null, lastHit: -9, cause: null, done: false, win: false,
        S: null, ex: null, rate: 0, fx: [],
    };
    for (const key of G.clouds) G.frags.push(...makeCloud(planet, key, rng));
    for (const m of planet.moons) {
        const r = radiiToGame(m.aKm / planet.Rkm);
        G.moons.push({ ...m, r, a: rng() * Math.PI * 2, w: Math.sqrt(GM_GAME / r ** 3), hitR: m.rKm > 500 ? 0.07 : 0.045 });
    }
    const nOrbs = endless ? 4 : G.goal;
    for (let i = 0; i < nOrbs; i++) addOrb(G, i);
    G.S = stormAt(G, 0); G.ex = exposure(G, G.x, G.y, G.S);
    return G;
}

function addOrb(G, i = null) {
    const band = G.orbBands[(i ?? Math.floor(G.rng() * 9)) % G.orbBands.length];
    const r = band[0] + G.rng() * (band[1] - band[0]);
    let a = (i ?? G.rng() * 9) * 2.39996 + G.rng();
    if (G.nightBias && G.rng() < G.nightBias) a = (G.rng() - 0.5) * 1.6;      // cluster behind the planet (+x)
    G.orbs.push({ r, a, w: Math.sqrt(GM_GAME / r ** 3) * (0.6 + 0.4 * G.rng()) });
}

/* ── space weather ─────────────────────────────────────────────────────── */

/** Storm state at time t: pressure ×P, proton flux, upper-air heating, flare flash, CME front/ETA, belt pumping. */
export function stormAt(G, t) {
    let P = 1, sep = 0, heat = 1, flare = 0, front = null, eta = null, beltBoost = 0, flareCls = null, dust = false;
    for (const e of G.events) {
        const dt = t - e.t;
        if (e.type === 'flare') {
            if (dt > -2 && dt < 1.2) { const f = 1 - Math.abs(dt) / 1.2; if (f > flare) { flare = f; flareCls = e.cls; } }
            const big = /^X/.test(e.cls) ? Math.min(3, parseFloat(e.cls.slice(1)) / 8 + 0.6) : 0.4;
            if (dt > 2) sep = Math.max(sep, big * Math.min(1, (dt - 2) / 2) * Math.exp(-(dt - 4) / 20));
        } else if (e.type === 'cme' || e.type === 'hss') {
            const rise = e.type === 'cme' ? 2 : 6;
            if (e.type === 'cme' && dt < 0 && dt > -16) eta = eta == null ? -dt : Math.min(eta, -dt);
            if (e.type === 'cme' && dt > -4 && dt < 1) front = dt;
            if (dt >= 0 && dt < e.dur) {
                const ramp = Math.min(1, dt / rise) * (dt > e.dur - 5 ? (e.dur - dt) / 5 : 1);
                P = Math.max(P, 1 + (e.P - 1) * ramp);
                beltBoost = Math.max(beltBoost, e.type === 'hss' ? ramp * 1.5 : ramp);
            }
            // CME heating is Joule heating by currents the storm drives through a planet's OWN
            // field, so only dipole worlds get it (Venus and Mars do not; Mars has dust storms).
            if (e.type === 'cme' && dt > 2 && G.planet.field.type === 'dipole') {
                const peak = Math.min(3.2, 1 + Math.log10(e.P) * 0.8);
                heat = Math.max(heat, 1 + (peak - 1) * Math.min(1, (dt - 2) / 4) * Math.exp(-Math.max(0, dt - e.dur) / 15));
            }
        } else if (e.type === 'dust') {
            if (dt > 0 && dt < e.dur) { dust = true; heat = Math.max(heat, 1 + (e.heat - 1) * Math.min(1, dt / 8)); }
        }
    }
    return { P, sep, heat, flare, flareCls, front, eta, beltBoost, dust };
}

/** Standoff of the planet's protective boundary toward the Sun, in planet radii (null if it has none). */
export function standoffRadii(planet, P) {
    const f = planet.field;
    if (f.type !== 'dipole' && f.type !== 'induced') return null;
    return f.standoff * Math.pow(P, -1 / 6);          // Chapman–Ferraro pressure balance
}

/** Boundary radius in game units at angle θ from the sub-solar direction (Shue-style flaring). */
export function boundaryRadius(planet, theta, P) {
    const rr = standoffRadii(planet, P);
    if (rr == null) return null;
    const alpha = planet.field.type === 'induced' ? 0.8 : 0.55;
    return Math.max(1, radiiToGame(rr)) * Math.pow(2 / (1 + Math.cos(theta)), alpha);
}

/** Crustal-field dome centres (screen angle) at time t — they turn with the planet. */
export function patchAngles(G, t) {
    const f = G.planet.field;
    if (f.type !== 'crustal') return [];
    const w = spinRate(G.planet);
    return f.patches.map((p) => ({ ...p, ang: p.lonDeg * Math.PI / 180 - w * t, rTop: toGame(G.planet, p.altKm) }));
}

/** Radiation and heat at (x, y): what shields you, what doesn't, and the total dose rate. */
export function exposure(G, x, y, S) {
    const P = G.planet, f = P.field, r = Math.hypot(x, y);
    const theta = Math.atan2(y, -x);                        // 0 = toward the Sun
    const shadow = x > 0 && Math.abs(y) < 1;
    let shieldWind = 0, shieldSep = 0, inside = false, cover = null;
    if (f.type === 'dipole' || f.type === 'induced') {
        const rb = boundaryRadius(P, theta, S.P);
        inside = r < rb;
        if (inside) {
            shieldWind = f.type === 'dipole' ? 1 : 0.8;
            // Geomagnetic cutoff: deeper inside a dipole is safer from protons; an induced field stops none.
            shieldSep = f.type === 'dipole' ? 1 - Math.min(1, ((r - 1) / Math.max(1e-6, rb - 1)) ** 2) : 0;
        }
    } else if (f.type === 'crustal') {
        for (const p of patchAngles(G, G.t)) {
            const d = Math.abs(wrapPi(Math.atan2(y, x) - p.ang));
            if (d < p.halfDeg * Math.PI / 180 && r < p.rTop) { cover = p; shieldWind = p.str; shieldSep = p.str * 0.8; break; }
        }
    }
    const wp = windPressure(P);
    const wind = (1 - shieldWind) * (shadow ? 0.1 : 1) * 0.15 * (1 + Math.log(S.P)) * Math.sqrt(wp);
    const sep = S.sep * 2.2 * (shadow ? 0.15 : 1) * (1 - shieldSep) * Math.pow(wp, 0.6);
    let belts = 0;
    for (const b of P.belts) {
        const lo = radiiToGame(b.lo), hi = radiiToGame(b.hi), mid = (lo + hi) / 2, half = (hi - lo) / 2;
        const tri = Math.max(0, 1 - Math.abs(r - mid) / half);
        belts += tri * b.k * (b.storm ? 1 + 2 * S.sep + S.beltBoost : 1);
    }
    let heat = 0;
    if (P.thermal && !shadow) heat = P.thermal.k * clamp01((P.thermal.below - r) / (P.thermal.below - 1)) * Math.max(0, -x / Math.max(r, 1e-6));
    return { inside, cover, shadow, belts, heat, rate: wind + belts * 1.4 + sep };
}

/** Upper-atmosphere density (game units). Storm heating raises both density and scale height. */
export function rho(G, r, heat = 1) {
    const a = G.planet.atmo;
    if (!a || r > 1.8) return 0;
    return a.rho0 * heat * Math.exp(-(r - 1) / (a.H * (1 + 0.5 * (heat - 1))));
}

/* ── controls ──────────────────────────────────────────────────────────── */

export const SAS_MODES = ['free', 'pro', 'retro', 'out', 'in'];
export function setSas(G, mode) { if (SAS_MODES.includes(mode)) G.sas = mode; }
export function setShield(G, on) {
    G.shield = !!on && G.pwr > 5;
    G.fx.push({ type: 'shield', on: G.shield });
}
export function useSpecial(G) {
    const sp = G.ship.special;
    if (G.done || sp.passive || G.spCd > 0) return false;
    if (sp.key === 'dash') { G.vx += Math.cos(G.ang) * 0.05; G.vy += Math.sin(G.ang) * 0.05; }
    else if (sp.key === 'faraday') G.faraday = 4;
    else if (sp.key === 'repair') {
        if (G.pwr < 40) { G.fx.push({ type: 'toast', text: 'Repair needs 40% power' }); return false; }
        G.pwr -= 40; G.hull = Math.min(G.ship.hull, G.hull + 25);
    }
    G.spCd = sp.cd;
    G.fx.push({ type: 'special', key: sp.key, x: G.x, y: G.y });
    return true;
}

/** Fraction of solar cells that are dead (debris chips + general damage). */
export function deadFraction(G) {
    return Math.min(0.9, G.panelHits * 0.09 + Math.max(0, 1 - G.hull / G.ship.hull - 0.25) * 0.5);
}
const wingFactor = (G) => ((G.wings.neg ? 1 : 0) + (G.wings.pos ? 1 : 0)) / 2;

/* ── the step ──────────────────────────────────────────────────────────── */

export function stepGame(G, input = {}, dt = 1 / 120) {
    if (G.done) return;
    G.t += dt;
    if (G.endless) scheduleEndless(G);
    const S = stormAt(G, G.t), ship = G.ship, P = G.planet;
    const r = Math.hypot(G.x, G.y);

    // attitude: manual turn, autopilot, and any tumble from a lost wing
    let turn = (input.left ? 1 : 0) - (input.right ? 1 : 0);       // left = counter-clockwise
    if (turn) G.sas = 'free';
    if (G.sas !== 'free' && G.pwr > 0) {
        const vAng = Math.atan2(G.vy, G.vx), rAng = Math.atan2(G.y, G.x);
        const tgt = { pro: vAng, retro: vAng + Math.PI, out: rAng, in: rAng + Math.PI }[G.sas];
        turn = Math.max(-1, Math.min(1, wrapPi(tgt - G.ang) * 4));
        G.spin *= Math.exp(-dt * 4);                                 // reaction wheels kill the tumble
    }
    G.spin *= Math.exp(-dt * 0.6);
    G.ang += (turn * ship.turn + G.spin) * dt;

    // power: wings turn on their booms (one axis), so output ∝ |cos| of the Sun's angle to the nose
    const ex = exposure(G, G.x, G.y, S);
    G.track += (Math.abs(Math.cos(G.ang)) - G.track) * Math.min(1, dt * 3);
    G.fold += ((G.shield ? 1 : 0) - G.fold) * Math.min(1, dt * 4);
    G.sunEff = ex.shadow ? 0 : G.track * (1 - G.fold) * (1 - deadFraction(G)) * wingFactor(G);

    // thrust (an ion drive only pushes while its arrays are lit)
    const canThrust = G.fuel > 0 && (!ship.ion || G.sunEff > 0.05);
    G.thrusting = !!input.thrust && canThrust;
    G.boosting = G.thrusting && !!input.boost && !ship.ion;
    const thr = !G.thrusting ? 0 : ship.thrust * (G.boosting ? 2.2 : 1) * (ship.ion ? 0.3 + 0.7 * G.sunEff : 1);
    if (G.thrusting) G.fuel = Math.max(0, G.fuel - dt * ship.fuelBurn * (G.boosting ? 3 : 1));

    // gravity + drag + thrust (semi-implicit Euler at 120 Hz)
    const g = GM_GAME / (r * r * r), v = Math.hypot(G.vx, G.vy), d = rho(G, r, S.heat) * 0.9 * (1 - 0.5 * G.fold);
    G.vx += (-g * G.x - d * v * G.vx + Math.cos(G.ang) * thr) * dt;
    G.vy += (-g * G.y - d * v * G.vy + Math.sin(G.ang) * thr) * dt;
    G.x += G.vx * dt; G.y += G.vy * dt;

    const drain = 1.2 + (G.shield ? 11 : 0) + (G.boosting ? 2 : 0) + (ship.ion && G.thrusting ? 3 : 0);
    G.pwr = Math.min(100, G.pwr + dt * (7.5 * G.sunEff - drain) * (100 / ship.battery));
    if (G.pwr <= 0) { G.pwr = 0; if (G.shield) { G.shield = false; G.fx.push({ type: 'toast', text: 'Battery flat. Shield down.' }); } }
    G.spCd = Math.max(0, G.spCd - dt); G.faraday = Math.max(0, G.faraday - dt);

    // damage: radiation (shield ×0.22, Faraday ×0), dayside heat, re-entry heating
    let rate = ex.rate * (G.shield ? 0.22 : 1) * (G.faraday > 0 ? 0 : 1);
    const reentry = d * v * v * v * 60;
    G.hull -= (rate + ex.heat + reentry) * dt * 2.2;
    G.dose += rate * dt;
    if (ex.heat > 0.3 || reentry > 0.3) G.cause = ex.heat > reentry ? 'heat' : 'reentry';
    else if (rate > 0.3) G.cause = 'radiation';
    G.rate = rate + ex.heat + reentry; G.S = S; G.ex = ex;
    G.minR = Math.min(G.minR, r);

    stepOrbs(G, dt);
    stepMoons(G, dt);
    stepDebris(G, dt, S);

    if (S.flare > 0.6 && !G._flared) { G._flared = true; G.fx.push({ type: 'flare', cls: S.flareCls }); }
    if (S.flare < 0.1) G._flared = false;

    // outcome
    const rNow = Math.hypot(G.x, G.y);
    if (rNow < 1) return finish(G, false, P.atmo ? 'Burned up in the atmosphere' : 'Crashed into the surface');
    if (G.hull <= 0) {
        const why = G.lastHit > G.t - 1 ? 'Destroyed by a debris strike'
            : { heat: 'Cooked by the dayside heat', reentry: 'Burned up in the atmosphere' }[G.cause] || 'Electronics fried by radiation';
        return finish(G, false, why);
    }
    if (rNow > G.view * 1.9) return finish(G, false, 'Drifted out of range');
    if (!G.endless && G.data >= G.goal) {
        const end = G.level.survive ? G.events.reduce((m, e) => Math.max(m, e.t + (e.dur || 8)), 0) + 2 : 0;
        if (G.t > end) return finish(G, true);
        if (!G._toldSurvive) { G._toldSurvive = true; G.fx.push({ type: 'tip', text: 'Data in the bag. Now <b>ride out the storm</b>.' }); }
    }
}

function stepOrbs(G, dt) {
    for (const o of G.orbs) {
        o.a -= o.w * dt;                                            // clockwise, with the player
        const ox = Math.cos(o.a) * o.r, oy = Math.sin(o.a) * o.r;
        if (!o.got && Math.hypot(ox - G.x, oy - G.y) < 0.09) {
            if (G.shield) { if (!o.warned) { o.warned = true; G.fx.push({ type: 'toast', text: 'Instruments are off in shield mode' }); } continue; }
            o.got = true; G.data++; G.fx.push({ type: 'orb', x: ox, y: oy });
            if (G.endless) addOrb(G);
        }
    }
    G.orbs = G.orbs.filter((o) => !o.got);
}

function stepMoons(G, dt) {
    for (const m of G.moons) {
        m.a -= m.w * dt;
        const mx = Math.cos(m.a) * m.r, my = Math.sin(m.a) * m.r;
        if (Math.hypot(mx - G.x, my - G.y) < m.hitR + G.ship.hitR * 0.5) {
            G.hull = 0; G.lastHit = G.t; G.fx.push({ type: 'strike', x: G.x, y: G.y, big: true });
            finish(G, false, `Hit ${m.name}`);
            return;
        }
    }
}

const hitRadius = (G) => G.ship.hitR * (G.wings.neg && G.wings.pos ? 1 : 0.85);

function stepDebris(G, dt, S) {
    const hr = hitRadius(G), conv = kmsPer(G.planet, Math.hypot(G.x, G.y));
    let best = null;
    for (const f of G.frags) {
        const r = Math.hypot(f.x, f.y), g = GM_GAME / r ** 3, v = Math.hypot(f.vx, f.vy);
        const d = rho(G, r, S.heat) * 0.3;                           // fragments: dense chunks, lower area-to-mass
        f.vx += (-g * f.x - d * v * f.vx) * dt; f.vy += (-g * f.y - d * v * f.vy) * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.spin += f.ws * dt;
        if (r < 1.03) { f.gone = true; G.decayed++; G.fx.push({ type: 'decay', x: f.x, y: f.y }); continue; }
        if (f.safeUntil && G.t < f.safeUntil) continue;
        const rx = f.x - G.x, ry = f.y - G.y, ux = f.vx - G.vx, uy = f.vy - G.vy, u2 = ux * ux + uy * uy;
        const dist = Math.hypot(rx, ry);
        if (dist < hr + 0.01 && G.t > 2.5) { strike(G, f, rx, ry, Math.sqrt(u2) * conv); continue; }
        // conjunction screening: straight-line time and distance of closest approach
        const tca = u2 > 0 ? -(rx * ux + ry * uy) / u2 : 0;
        if (tca > 0 && tca < 3) {
            const miss = Math.hypot(rx + ux * tca, ry + uy * tca);
            if (miss < hr * 3 && (!best || tca < best.tca)) best = { f, tca, miss, relKms: Math.sqrt(u2) * conv };
        }
        if (f.watched && (!best || best.f !== f) && dist > hr * 3) { f.watched = false; G.nearMiss++; }
    }
    if (best) best.f.watched = true;
    G.conj = best;
    G.frags = G.frags.filter((f) => !f.gone);
}

function strike(G, f, rx, ry, relKms) {
    const dmg = 5 + relKms * 2.4;
    G.hull -= dmg; G.hits++; G.lastHit = G.t; f.gone = true; f.watched = false;
    if (G.rng() < 0.7) G.panelHits++;
    G.fx.push({ type: 'strike', x: f.x, y: f.y, dmg, relKms, cloud: f.cloud });
    // A fast head-on hit snaps the wing on the side it struck; the wing becomes debris.
    if (relKms > WING_SNAP_KMS && G.rng() < 0.75) {
        const lateral = -Math.sin(G.ang) * rx + Math.cos(G.ang) * ry;    // + = left of the nose
        let side = lateral > 0 ? 'neg' : 'pos';
        if (!G.wings[side]) side = side === 'neg' ? 'pos' : 'neg';
        if (G.wings[side]) loseWing(G, side, lateral > 0 ? 1 : -1);
    }
}

export function loseWing(G, side, sign = 1) {
    G.wings[side] = false; G.wingsLost++;
    G.spin += (side === 'neg' ? 1 : -1) * 2.5;
    const nx = -Math.sin(G.ang) * sign, ny = Math.cos(G.ang) * sign;   // outward along the lost wing
    G.frags.push({ x: G.x + nx * 0.05, y: G.y + ny * 0.05, vx: G.vx + nx * 0.03, vy: G.vy + ny * 0.03,
        spin: 0, ws: 5 * sign, sz: 7, cloud: 'own', seed: 0.5, wing: true, ship: G.ship.id, safeUntil: G.t + 3 });
    G.fx.push({ type: 'wing', side });
}

function scheduleEndless(G) {
    if (G.t < G.nextEvt) return;
    const E = ENDLESS[G.planet.id], k = ++G.evtCount, kind = E.kinds[Math.floor(G.rng() * E.kinds.length)];
    const t = G.t + 4;
    if (kind === 'cme') { G.events.push({ type: 'flare', t, cls: `X${(1 + k * 0.8).toFixed(1)}` }); G.events.push({ type: 'cme', t: t + 12, dur: 18 + k * 2, P: Math.min(600, 15 + k * 25) }); }
    else if (kind === 'flare') G.events.push({ type: 'flare', t, cls: `X${(1 + k * 1.1).toFixed(1)}` });
    else if (kind === 'hss') G.events.push({ type: 'hss', t, dur: 30, P: Math.min(8, 2 + k * 0.5) });
    else if (kind === 'dust') G.events.push({ type: 'dust', t, dur: 50, heat: Math.min(3.5, 1.6 + k * 0.2) });
    G.nextEvt = G.t + 30 + G.rng() * 12 - Math.min(12, k);
}

function finish(G, win, why = null) {
    if (G.done) return;
    G.done = true; G.win = win; G.why = why;
    G.fx.push({ type: 'end', win });
}

/* ── read-outs ─────────────────────────────────────────────────────────── */

/** Future path under gravity + current drag, for the dotted predictor. */
export function predictPath(G, n = 240, h = 0.05, sub = 3) {
    const S = G.S || stormAt(G, G.t), pts = [];
    let x = G.x, y = G.y, vx = G.vx, vy = G.vy, crash = false;
    for (let i = 0; i < n && !crash; i++) {
        for (let k = 0; k < sub; k++) {
            const r = Math.hypot(x, y), g = GM_GAME / r ** 3, v = Math.hypot(vx, vy), d = rho(G, r, S.heat) * 0.9;
            vx += (-g * x - d * v * vx) * h; vy += (-g * y - d * v * vy) * h; x += vx * h; y += vy * h;
            if (r < 1) { crash = true; break; }
        }
        pts.push(x, y);
        if (Math.hypot(x, y) > G.view * 1.9) break;
    }
    return { pts, crash };
}

export function telemetry(G) {
    const r = Math.hypot(G.x, G.y), S = G.S;
    const so = standoffRadii(G.planet, S.P);
    return {
        altKm: toAltKm(G.planet, r),
        kms: Math.hypot(G.vx, G.vy) * kmsPer(G.planet, r),
        standoff: so, crushed: so != null && so <= 1,
        inside: G.ex.inside, cover: G.ex.cover, shadow: G.ex.shadow,
        dose: G.rate, frags: G.frags.filter((f) => f.cloud !== 'own').length,
    };
}

export function result(G) {
    const hullFrac = Math.max(0, G.hull / G.ship.hull), fuelFrac = G.fuel / 100;
    return {
        win: G.win, why: G.why, endless: G.endless, t: G.t, data: G.data,
        hullFrac, fuelFrac, stars: G.endless ? 0 : starsFor({ win: G.win, hullFrac, fuelFrac }),
        hits: G.hits, nearMiss: G.nearMiss, decayed: G.decayed, wingsLost: G.wingsLost,
        dose: G.dose, minAltKm: toAltKm(G.planet, G.minR),
        clouds: G.clouds.map((k) => DEBRIS[k]),
    };
}
