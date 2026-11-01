/**
 * launch-smoke-sim.js — PURE particle kernel for the launch planner's
 * exhaust, ground-cloud and deluge-steam sprites.
 *
 * No THREE, no DOM, no ambient time or randomness: every particle comes
 * from a seeded PRNG and every step takes an explicit dt, so the node test
 * (tests/launch-smoke-sim.mjs) can pin its behaviour exactly. The renderer
 * (js/launch-smoke.js) only READS the typed arrays this module writes.
 *
 * What it models (illustratively — this is a visual, not a CFD solver):
 *   · Each particle is a puff with position, velocity, age, life, a start
 *     and end radius, an opacity scale, a heat value (how hot it was born;
 *     drives the flame-lit glow in the shader) and a kind.
 *   · Motion: linear drag toward the ambient wind, buoyancy that DECAYS
 *     as the puff cools (hot exhaust rises, a cooled cloud just drifts),
 *     and a ground plane. A puff driven into the ground has its downward
 *     momentum turned RADIALLY OUTWARD — that is what makes the classic
 *     ground cloud boil out sideways from under the pad instead of the
 *     particles stopping dead or tunnelling through the deck.
 *   · Growth: radius relaxes from size0 toward size1 on an e-folding time
 *     (fast at first, then slowly), so a puff "blooms" right after it is
 *     born and keeps expanding as it ages — volume entrainment.
 *   · Opacity: fast fade-in, long plateau, smooth fade-out at end of life,
 *     multiplied by a dilution term (a puff that has grown 3× is ~3× thinner).
 *
 * Storage is a fixed-capacity RING: when full, the oldest slot is reused.
 * `alive` counts live slots so the renderer can skip dead ones cheaply.
 *
 * Public API:
 *   createSmokeSim({ capacity, seed }) → sim
 *   emitSmoke(sim, n, spec)            → number emitted
 *   stepSmoke(sim, dt, env)            → advances every live particle
 *   smokeAlpha(sim, i)                 → opacity of slot i at its current age
 *   smokeRadius(sim, i)                → radius of slot i at its current age
 *   clearSmoke(sim)
 *   mulberry32(seed)                   → the PRNG (exported for the test)
 */

export const SMOKE_KIND = Object.freeze({
    EXHAUST: 0,    // trail puffs born at the nozzle exit
    GROUND:  1,    // ground cloud pushed out of the flame trench / under the mount
    STEAM:   2,    // deluge-water steam boiling off the deck
});

// Small, fast, well-distributed 32-bit PRNG. Deterministic per seed.
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createSmokeSim({ capacity = 1200, seed = 1 } = {}) {
    const N = Math.max(1, capacity | 0);
    return {
        capacity: N,
        rand: mulberry32(seed),
        head: 0,                         // next slot to write (ring)
        alive: 0,                        // live slot count
        pos:   new Float32Array(N * 3),
        vel:   new Float32Array(N * 3),
        age:   new Float32Array(N),
        life:  new Float32Array(N),      // 0 ⇒ slot dead
        size0: new Float32Array(N),
        size1: new Float32Array(N),
        grow:  new Float32Array(N),      // growth e-folding time, s
        opac:  new Float32Array(N),      // peak opacity
        heat:  new Float32Array(N),      // 0 cold … 1 born in the flame
        buoy:  new Float32Array(N),      // initial buoyant accel, m/s²
        rot:   new Float32Array(N),      // sprite rotation, rad
        spin:  new Float32Array(N),      // rad/s
        seed:  new Float32Array(N),      // 0..1, picks the sprite variant / tint
        kind:  new Uint8Array(N),
    };
}

export function clearSmoke(sim) {
    sim.life.fill(0);
    sim.age.fill(0);
    sim.alive = 0;
    sim.head = 0;
}

// spec fields (all optional except origin):
//   origin   [x,y,z]   emission point (world metres)
//   radius   m         uniform disc jitter around origin in XZ
//   dir      [x,y,z]   mean velocity direction (normalised internally)
//   speed    m/s       mean speed along dir
//   speedJit 0..1      ± fractional speed jitter
//   spread   rad       cone half-angle around dir
//   radial   m/s       extra speed pushed outward from the origin in XZ
//   inherit  [x,y,z]   velocity added as-is (e.g. part of the vehicle's)
//   life     s         mean lifetime (±25 % jitter)
//   size0    m         radius at birth
//   size1    m         radius it relaxes toward
//   grow     s         e-folding time of the growth
//   opacity  0..1      peak opacity
//   heat     0..1      birth temperature (glow)
//   buoyancy m/s²      initial upward accel (decays with heat)
//   kind     SMOKE_KIND
export function emitSmoke(sim, n, spec) {
    const r = sim.rand;
    const o = spec.origin || [0, 0, 0];
    let dx = 0, dy = -1, dz = 0;
    if (spec.dir) {
        const L = Math.hypot(spec.dir[0], spec.dir[1], spec.dir[2]) || 1;
        dx = spec.dir[0] / L; dy = spec.dir[1] / L; dz = spec.dir[2] / L;
    }
    // Orthonormal basis around dir for the cone spread.
    let ax = Math.abs(dy) < 0.9 ? 0 : 1, ay = Math.abs(dy) < 0.9 ? 1 : 0, az = 0;
    let ux = ay * dz - az * dy, uy = az * dx - ax * dz, uz = ax * dy - ay * dx;
    const uL = Math.hypot(ux, uy, uz) || 1;
    ux /= uL; uy /= uL; uz /= uL;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;

    const speed   = spec.speed ?? 0;
    const sJit    = spec.speedJit ?? 0.3;
    const spread  = spec.spread ?? 0.3;
    const radius  = spec.radius ?? 0;
    const radialV = spec.radial ?? 0;
    const inh     = spec.inherit || null;
    const life    = spec.life ?? 6;
    const count   = Math.max(0, n | 0);

    for (let k = 0; k < count; k++) {
        const i = sim.head;
        sim.head = (sim.head + 1) % sim.capacity;
        if (sim.life[i] <= 0) sim.alive++;

        // Disc jitter in XZ.
        const ja = r() * Math.PI * 2;
        const jr = Math.sqrt(r()) * radius;
        const px = o[0] + Math.cos(ja) * jr;
        const py = o[1];
        const pz = o[2] + Math.sin(ja) * jr;

        // Direction inside a cone of half-angle `spread` around dir
        // (uniform in solid angle).
        const cosT = 1 - r() * (1 - Math.cos(spread));
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const ph = r() * Math.PI * 2;
        const cx = Math.cos(ph) * sinT, cy = Math.sin(ph) * sinT;
        let wx = dx * cosT + ux * cx + vx * cy;
        let wy = dy * cosT + uy * cx + vy * cy;
        let wz = dz * cosT + uz * cx + vz * cy;
        const s = speed * (1 + (r() * 2 - 1) * sJit);
        wx *= s; wy *= s; wz *= s;

        // Radial outward push (ground cloud).
        if (radialV) {
            const hx = px - o[0], hz = pz - o[2];
            const hL = Math.hypot(hx, hz);
            const ex = hL > 1e-6 ? hx / hL : Math.cos(ja);
            const ez = hL > 1e-6 ? hz / hL : Math.sin(ja);
            const rv = radialV * (0.6 + 0.8 * r());
            wx += ex * rv; wz += ez * rv;
        }
        if (inh) { wx += inh[0]; wy += inh[1]; wz += inh[2]; }

        sim.pos[i * 3] = px; sim.pos[i * 3 + 1] = py; sim.pos[i * 3 + 2] = pz;
        sim.vel[i * 3] = wx; sim.vel[i * 3 + 1] = wy; sim.vel[i * 3 + 2] = wz;
        sim.age[i]   = 0;
        sim.life[i]  = Math.max(0.05, life * (0.75 + 0.5 * r()));
        const s0 = spec.size0 ?? 1;
        sim.size0[i] = s0 * (0.8 + 0.4 * r());
        sim.size1[i] = Math.max(sim.size0[i], (spec.size1 ?? s0 * 3) * (0.8 + 0.4 * r()));
        sim.grow[i]  = Math.max(0.05, (spec.grow ?? 2) * (0.8 + 0.4 * r()));
        sim.opac[i]  = Math.min(1, Math.max(0, (spec.opacity ?? 0.6) * (0.8 + 0.4 * r())));
        sim.heat[i]  = Math.min(1, Math.max(0, spec.heat ?? 0));
        sim.buoy[i]  = spec.buoyancy ?? 0;
        sim.rot[i]   = r() * Math.PI * 2;
        sim.spin[i]  = (r() * 2 - 1) * 0.25;
        sim.seed[i]  = r();
        sim.kind[i]  = spec.kind ?? SMOKE_KIND.EXHAUST;
    }
    return count;
}

export function smokeRadius(sim, i) {
    const a = sim.age[i];
    const s0 = sim.size0[i], s1 = sim.size1[i];
    return s1 - (s1 - s0) * Math.exp(-a / sim.grow[i]);
}

export function smokeAlpha(sim, i) {
    const L = sim.life[i];
    if (L <= 0) return 0;
    const x = sim.age[i] / L;                         // 0..1 through life
    if (x >= 1) return 0;
    const fadeIn  = Math.min(1, x / 0.06);
    const t = Math.max(0, (x - 0.55) / 0.45);
    const fadeOut = 1 - t * t * (3 - 2 * t);           // smoothstep down
    // Dilution: a puff that has grown spreads the same smoke over more area.
    const r = smokeRadius(sim, i);
    const dil = Math.min(1, Math.pow(sim.size0[i] / Math.max(r, 1e-6), 0.55) * 1.6);
    return sim.opac[i] * fadeIn * fadeOut * dil;
}

// env fields:
//   groundY    world Y of the ground the cloud rolls along (default 0)
//   drag       1/s linear drag toward the wind (default 0.6)
//   wind       [x, z] m/s ambient wind (default [0, 0])
//   cooling    1/s heat decay rate (default 0.35)
//   floorFriction 0..1 fraction of tangential speed lost per ground hit
//   maxDt      s, sub-step ceiling (default 1/30) — a slow frame does not
//              explode the integrator
export function stepSmoke(sim, dt, env = {}) {
    if (!(dt > 0)) return;
    const groundY = env.groundY ?? 0;
    const drag    = env.drag ?? 0.6;
    const wx      = env.wind ? env.wind[0] : 0;
    const wz      = env.wind ? env.wind[1] : 0;
    const cooling = env.cooling ?? 0.35;
    const fric    = env.floorFriction ?? 0.15;
    const maxDt   = env.maxDt ?? (1 / 30);
    const nSub    = Math.min(12, Math.max(1, Math.ceil(dt / maxDt)));
    const h       = dt / nSub;
    const N = sim.capacity;
    const P = sim.pos, V = sim.vel;

    for (let sub = 0; sub < nSub; sub++) {
        let alive = 0;
        const damp = Math.exp(-drag * h);
        const cool = Math.exp(-cooling * h);
        for (let i = 0; i < N; i++) {
            if (sim.life[i] <= 0) continue;
            sim.age[i] += h;
            if (sim.age[i] >= sim.life[i]) { sim.life[i] = 0; continue; }
            alive++;
            const j = i * 3;
            // Buoyancy decays with heat: hot gas rises, a cooled cloud drifts.
            const ay = sim.buoy[i] * sim.heat[i];
            sim.heat[i] *= cool;
            // Exact exponential relaxation toward the wind (unconditionally
            // stable for any h), with buoyancy added on top.
            V[j]     = wx + (V[j]     - wx) * damp;
            V[j + 1] =      V[j + 1]        * damp + ay * h;
            V[j + 2] = wz + (V[j + 2] - wz) * damp;
            P[j]     += V[j] * h;
            P[j + 1] += V[j + 1] * h;
            P[j + 2] += V[j + 2] * h;

            // Ground: a puff's CENTRE may not sink below ~40 % of its radius
            // above the deck. Downward momentum turns radially outward.
            const r = smokeRadius(sim, i);
            const floor = groundY + r * 0.4;
            if (P[j + 1] < floor) {
                P[j + 1] = floor;
                const vy = V[j + 1];
                if (vy < 0) {
                    let ex = V[j], ez = V[j + 2];
                    let eL = Math.hypot(ex, ez);
                    if (eL < 1e-4) {
                        // Straight down onto the deck: pick an outward
                        // direction from the particle's own seed so the
                        // cloud spreads evenly instead of stacking.
                        const a = sim.seed[i] * Math.PI * 2;
                        ex = Math.cos(a); ez = Math.sin(a); eL = 1;
                    }
                    const push = -vy * 0.85;
                    V[j]     = (V[j]     + ex / eL * push) * (1 - fric);
                    V[j + 2] = (V[j + 2] + ez / eL * push) * (1 - fric);
                    V[j + 1] = -vy * 0.05;     // tiny bounce, mostly absorbed
                }
            }
            sim.rot[i] += sim.spin[i] * h;
        }
        sim.alive = alive;
    }
}

// ── Launch emission planner ─────────────────────────────────────────────────
// Turns the mission clock's state into emitSmoke() calls. PURE as well: the
// caller hands in the live state and a `carry` object (owned by the caller,
// created by createEmissionCarry) that remembers fractional emission and
// the last nozzle position between frames.
//
// Per-vehicle profiles are DESCRIPTIVE, not measured: solid boosters make a
// dense white aluminium-oxide column; kerolox a thinner grey-tan trail;
// methalox burns almost clean, so Starship's trail is nearly transparent
// while its ground cloud (deluge steam + pad dust) is the biggest of the three.
//
// Sizes are in units of the vehicle's own core diameter `D` so one profile
// scales from Falcon 9 (3.7 m) to a 9 m Starship.

export const SMOKE_PROFILES = Object.freeze({
    shuttle: {
        exhaust: { opacity: 0.80, size0: 0.45, size1: 3.24, life: 32, grow: 5.0,
                   spacing: 0.32, speed: 22, heat: 0.9, buoyancy: 2.2 },
        ground:  { rate: 105, opacity: 0.85, size0: 0.9, size1: 4.86, life: 26,
                   grow: 4.5, radial: 26, reach: 140, heat: 0.7, buoyancy: 1.6 },
        steam:   { rate: 24, opacity: 0.55, size0: 0.6, size1: 2.97, life: 11,
                   grow: 3.0, radial: 6 },
    },
    falcon9: {
        exhaust: { opacity: 0.42, size0: 0.55, size1: 3.51, life: 22, grow: 4.0,
                   spacing: 0.42, speed: 18, heat: 0.8, buoyancy: 1.8 },
        ground:  { rate: 69, opacity: 0.70, size0: 1.1, size1: 6.21, life: 22,
                   grow: 4.0, radial: 20, reach: 90, heat: 0.6, buoyancy: 1.4 },
        steam:   { rate: 26, opacity: 0.55, size0: 0.8, size1: 4.05, life: 11,
                   grow: 3.0, radial: 6 },
    },
    starship: {
        exhaust: { opacity: 0.14, size0: 0.40, size1: 2.56, life: 16, grow: 3.0,
                   spacing: 0.40, speed: 28, heat: 0.9, buoyancy: 2.4 },
        ground:  { rate: 135, opacity: 0.80, size0: 0.85, size1: 4.59, life: 28,
                   grow: 5.0, radial: 30, reach: 160, heat: 0.65, buoyancy: 1.5 },
        steam:   { rate: 36, opacity: 0.60, size0: 0.55, size1: 3.24, life: 12,
                   grow: 3.0, radial: 9 },
    },
});

export function createEmissionCarry() {
    return { last: null, dist: 0, ground: 0, steam: 0 };
}

// state fields:
//   T          mission time, s
//   dt         frame dt, s
//   throttle   0..1
//   altitude   m above pad deck
//   D          vehicle core diameter, m
//   nozzle     [x,y,z] world position of the cluster exit centre
//   down       [x,y,z] world exhaust direction (unit; −vehicle axis)
//   deckY      world Y the exhaust hits on the pad (flame trench / deck)
//   groundY    world Y of the surrounding terrain
//   exits      optional [[x,z,dx,dz], …] flame-trench outlets — when given,
//              the ground cloud leaves through them instead of radially
//   steamR     m, radius of the deluge ring around the vehicle base
//   budget     0..1 quality scale on every rate (1 = full)
// Returns the number of particles emitted this call.
export function planEmissions(sim, profileId, state, carry) {
    const P = SMOKE_PROFILES[profileId] || SMOKE_PROFILES.falcon9;
    const dt = state.dt;
    if (!(dt > 0)) return 0;
    const D = Math.max(1, state.D || 4);
    const thr = Math.max(0, Math.min(1, state.throttle || 0));
    const T = state.T;
    const budget = Math.max(0.05, Math.min(1, state.budget ?? 1));
    const alt = Math.max(0, state.altitude || 0);
    let emitted = 0;

    // Deluge steam: ignition → the stack clears the tower.
    if (T > -3.2 && T < 7 && thr > 0.02) {
        const S = P.steam;
        const env = T < -0.5 ? (T + 3.2) / 2.7 : T < 4 ? 1 : Math.max(0, 1 - (T - 4) / 3);
        carry.steam += S.rate * env * budget * dt;
        const n = Math.floor(carry.steam);
        if (n > 0) {
            carry.steam -= n;
            emitted += emitSmoke(sim, n, {
                origin: [state.nozzle[0], state.deckY + 0.5, state.nozzle[2]],
                radius: state.steamR ?? D * 2.5,
                dir: [0, 1, 0], speed: 2.5, speedJit: 0.6, spread: 0.7,
                radial: S.radial, life: S.life,
                size0: S.size0 * D, size1: S.size1 * D, grow: S.grow,
                opacity: S.opacity, heat: 0.0, buoyancy: 0,
                kind: SMOKE_KIND.STEAM,
            });
        }
    }

    // Ground cloud: the plume hitting the deck, while it can still reach it.
    if (T > -0.6 && thr > 0.3 && alt < P.ground.reach) {
        const G = P.ground;
        const reachFall = 1 - alt / G.reach;
        carry.ground += G.rate * thr * reachFall * budget * dt;
        const n = Math.floor(carry.ground);
        if (n > 0) {
            carry.ground -= n;
            const exits = state.exits && state.exits.length ? state.exits : null;
            if (exits) {
                // Split across the trench outlets, jetting out along each.
                for (let k = 0; k < n; k++) {
                    const e = exits[k % exits.length];
                    emitted += emitSmoke(sim, 1, {
                        origin: [e[0], state.groundY + 0.4, e[1]],
                        radius: D * 0.8,
                        dir: [e[2], 0.18, e[3]], speed: G.radial * 1.3, speedJit: 0.35,
                        spread: 0.45, life: G.life,
                        size0: G.size0 * D, size1: G.size1 * D, grow: G.grow,
                        opacity: G.opacity, heat: G.heat, buoyancy: G.buoyancy,
                        kind: SMOKE_KIND.GROUND,
                    });
                }
            } else {
                emitted += emitSmoke(sim, n, {
                    origin: [state.nozzle[0], state.deckY + 0.4, state.nozzle[2]],
                    radius: D * 0.9,
                    dir: [0, 0.12, 0], speed: 1, spread: 0.3,
                    radial: G.radial, life: G.life,
                    size0: G.size0 * D, size1: G.size1 * D, grow: G.grow,
                    opacity: G.opacity, heat: G.heat, buoyancy: G.buoyancy,
                    kind: SMOKE_KIND.GROUND,
                });
            }
        }
    }

    // Exhaust trail: emitted along the PATH the nozzle swept this frame, at a
    // spacing proportional to the puff size, so the column stays continuous
    // however fast the vehicle climbs or however slow the frame was.
    const E = P.exhaust;
    const nz = state.nozzle;
    if (T > 0 && thr > 0.05 && alt > D * 0.8) {
        const last = carry.last || nz;
        const seg = Math.hypot(nz[0] - last[0], nz[1] - last[1], nz[2] - last[2]);
        const spacing = Math.max(0.2, E.spacing * D / Math.sqrt(budget));
        carry.dist += seg;
        // A hovering / slow vehicle still exhausts: a time floor of ~8 puffs/s.
        carry.dist += spacing * 8 * dt * budget;
        const n = Math.min(64, Math.floor(carry.dist / spacing));
        const down = state.down || [0, -1, 0];
        for (let k = 0; k < n; k++) {
            // Distribute along the swept segment, newest last.
            const f = n === 1 ? 1 : (k + 1) / n;
            emitted += emitSmoke(sim, 1, {
                origin: [last[0] + (nz[0] - last[0]) * f,
                         last[1] + (nz[1] - last[1]) * f - D * 0.6,
                         last[2] + (nz[2] - last[2]) * f],
                radius: D * 0.25,
                dir: down, speed: E.speed * thr, speedJit: 0.4, spread: 0.22,
                life: E.life, size0: E.size0 * D, size1: E.size1 * D, grow: E.grow,
                opacity: E.opacity, heat: E.heat, buoyancy: E.buoyancy,
                kind: SMOKE_KIND.EXHAUST,
            });
        }
        carry.dist -= n * spacing;
        if (carry.dist > spacing * 4) carry.dist = 0;   // never bank a burst
    }
    carry.last = [nz[0], nz[1], nz[2]];
    return emitted;
}
