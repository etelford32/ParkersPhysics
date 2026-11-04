/**
 * hero-sun-flow.js — PURE kernel: what a flare RELEASES, drawn as a FLOW.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time; seeded, so the same inputs
 * produce the same bytes. `node tests/hero-sun-flow.mjs` gates it.
 *
 * Frame: the hero Sun's ROOT frame (hero-sun-model.js — flux-rope frame,
 * unit = one drawn solar radius; a point on the photosphere has |p| = 1).
 *
 * ── What a flare does, in three populations ────────────────────────────────
 * A flare is magnetic reconnection above a polarity-inversion line. In the
 * standard (CSHKP) picture it drives three things the eye can follow:
 *
 *   · EVAPORATION — the ribbons at the loop footpoints heat the chromosphere,
 *     which boils UP along the field into the post-flare arcade. Particles
 *     are born at the two ribbons and climb their loop (`kind` LOOP, s: 0→½
 *     from ribbon A, 1→½ from ribbon B).
 *   · RAIN — the filled loops cool by radiation and conduction and the plasma
 *     drains back down the same field lines (coronal rain). A LOOP particle
 *     past its cooling time reverses toward its nearer footpoint and falls,
 *     accelerating. It dies when it reaches the photosphere.
 *   · EJECTA — the reconnection also lets go of a plasmoid, which becomes the
 *     CME. A class-scaled fraction of particles (`EJECTA_FRACTION`) is released
 *     at the loop tops and ESCAPES along the radial, swept by eddies. They
 *     leave the drawn frame at `R_LEAVE`; the CME itself is the flux-rope
 *     kernel's job (hero-rope-layer.js), never this layer's.
 *
 * ── The velocity field, and what is honest about it ────────────────────────
 *     v(p, t) = U_∥(p)  +  κ · curl ψ(p, t)  +  E(p)
 *
 *   U_∥   field-ALIGNED: a LOOP particle moves along its own loop, by
 *         construction (its state is the arc fraction s; `loopPoint` places it).
 *   curl ψ  DIVERGENCE-FREE by construction — ψ is a 3-vector of smooth value
 *         noise and the curl of any smooth vector field has zero divergence
 *         (Bridson, Hourihan & Nordenstam 2007, "Curl-noise for procedural
 *         fluid flow"). This is the term that makes the ejecta eddy and
 *         filament like an incompressible fluid instead of streaming like
 *         sparks. The gate MEASURES ∇·(curl ψ) ≈ 0 by finite differences and
 *         checks that a GRADIENT field (the obvious wrong choice) fails the
 *         same test.
 *   E     radial ESCAPE, growing with height above the arcade — the drawn
 *         stand-in for the outward Lorentz force on a departing plasmoid.
 *
 * It is a SCHEMATIC of the eruption's phases at display speeds (R☉ per
 * display-second, scaled by GOES class), not a kinetic or MHD simulation, and
 * the page's legend says so. What IS physical here: the phase ordering
 * (impulsive evaporation → filled arcade → rain, with the plasmoid leaving
 * early), the field-alignment of everything inside the arcade, the
 * incompressibility of the eddy term, and the class ordering of rates and
 * speeds (X > M > C).
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Per-class release rates and fractions. Rates are particles per display
 *  second at full flash; `vEscape` in R☉/s (display), `vLoop` arc fraction/s. */
export const FLOW_CLASS = Object.freeze({
    C: Object.freeze({ rate: 110, escape: 0.08, vEscape: 0.10, vLoop: 0.34, life: 5.5 }),
    M: Object.freeze({ rate: 240, escape: 0.18, vEscape: 0.17, vLoop: 0.42, life: 6.5 }),
    X: Object.freeze({ rate: 420, escape: 0.30, vEscape: 0.26, vLoop: 0.50, life: 7.5 }),
});
/** Curl-noise eddy strength (R☉/s at unit noise gradient) and spatial scale. */
export const CURL = Object.freeze({ gain: 0.012, freq: 9.0, drift: 0.35, eps: 0.004 });
/** Ejecta leave the drawn frame here (R☉); beyond it the CME is the rope. */
export const R_LEAVE = 2.3;
/** Height above the arcade apex where the escape term reaches full strength. */
export const ESCAPE_RAMP = 0.35;
/** Fraction of a LOOP particle's life spent climbing before it cools and rains. */
export const COOL_FRACTION = 0.55;
/** Loops per flare site the evaporation fills (nested over the PIL). */
export const LOOPS_PER_SITE = 6;
export const KIND = Object.freeze({ LOOP: 0, EJECTA: 1 });
/** Floats per particle in `state.data`. */
export const STRIDE = 10;
// data layout: [x, y, z, age, life, s, dir(±1), loop k, kind, site]

// ── Noise (value noise, the same lattice hash family the shaders use) ───────

function hash3(x, y, z) {
    let p = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return p - Math.floor(p);
}
function smooth(t) { return t * t * (3 - 2 * t); }
/** Trilinear value noise in [0, 1). */
export function vnoise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
        l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
        l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
        fz);
}

/** The potential: three independent noise channels, drifting in time. */
export function potential(x, y, z, t, out = [0, 0, 0]) {
    const f = CURL.freq, d = CURL.drift * t;
    out[0] = vnoise(x * f + 11.3, y * f + d, z * f + 5.1);
    out[1] = vnoise(x * f + 71.7 + d, y * f + 23.9, z * f + 47.3);
    out[2] = vnoise(x * f + 37.1, y * f + 91.3, z * f + 13.7 + d);
    return out;
}

const _pa = [0, 0, 0], _pb = [0, 0, 0];
/**
 * v = curl ψ by central differences — divergence-free to the order of the
 * stencil (the gate measures it). Returns R☉/s at unit gain.
 */
export function curlNoise(x, y, z, t, out = [0, 0, 0], eps = CURL.eps) {
    const h = 1 / (2 * eps);
    // ∂ψ/∂x
    potential(x + eps, y, z, t, _pa); potential(x - eps, y, z, t, _pb);
    const dzdx = (_pa[2] - _pb[2]) * h, dydx = (_pa[1] - _pb[1]) * h;
    // ∂ψ/∂y
    potential(x, y + eps, z, t, _pa); potential(x, y - eps, z, t, _pb);
    const dxdy = (_pa[0] - _pb[0]) * h, dzdy = (_pa[2] - _pb[2]) * h;
    // ∂ψ/∂z
    potential(x, y, z + eps, t, _pa); potential(x, y, z - eps, t, _pb);
    const xdz = (_pa[0] - _pb[0]) * h, ydz = (_pa[1] - _pb[1]) * h;
    out[0] = dzdy - ydz;
    out[1] = xdz - dzdx;
    out[2] = dydx - dxdy;
    return out;
}

/** The WRONG choice, kept for the gate's negative control: ∇ψ₀ is not divergence-free. */
export function gradientNoise(x, y, z, t, out = [0, 0, 0], eps = CURL.eps) {
    const h = 1 / (2 * eps);
    potential(x + eps, y, z, t, _pa); potential(x - eps, y, z, t, _pb); out[0] = (_pa[0] - _pb[0]) * h;
    potential(x, y + eps, z, t, _pa); potential(x, y - eps, z, t, _pb); out[1] = (_pa[0] - _pb[0]) * h;
    potential(x, y, z + eps, t, _pa); potential(x, y, z - eps, t, _pb); out[2] = (_pa[0] - _pb[0]) * h;
    return out;
}

/**
 * Numerical divergence of a sampled field, for the gate. With the SAME
 * stencil as `curlNoise` the identity div(curl) = 0 holds exactly (central
 * differences commute); with a coarser one it measures how smooth ψ is.
 */
export function divergence(field, x, y, z, t, eps = CURL.eps) {
    const a = [0, 0, 0], b = [0, 0, 0];
    let d = 0;
    field(x + eps, y, z, t, a); field(x - eps, y, z, t, b); d += (a[0] - b[0]) / (2 * eps);
    field(x, y + eps, z, t, a); field(x, y - eps, z, t, b); d += (a[1] - b[1]) / (2 * eps);
    field(x, y, z + eps, t, a); field(x, y, z - eps, t, b); d += (a[2] - b[2]) / (2 * eps);
    return d;
}

// ── Sites and loops ─────────────────────────────────────────────────────────

const unit = (v) => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };

/**
 * A flare site's arcade: `LOOPS_PER_SITE` nested loops over the PIL.
 * @param {{c:number[], ax:number[], side:number[], hs:number}} site
 *   c unit centre, ax unit across-PIL axis, side unit along the PIL, hs
 *   half-separation (rad) — the hero-sun-model bipole.
 * @returns {Array<{a:number[], b:number[], apexH:number}>}
 */
export function siteLoops(site, n = LOOPS_PER_SITE) {
    const out = [];
    for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0.5 : k / (n - 1);
        const span = site.hs * (0.5 + 0.9 * f);
        const along = site.hs * 0.7 * (f - 0.5);
        const foot = (sgn) => unit([0, 1, 2].map((i) => site.c[i] + site.ax[i] * sgn * span + site.side[i] * along));
        out.push({ a: foot(1), b: foot(-1), apexH: span * 1.05 });
    }
    return out;
}

/** Point at arc fraction s (0 = foot a, 1 = foot b) of a loop; sine lift. */
export function loopPoint(loop, s, out = [0, 0, 0]) {
    const { a, b, apexH } = loop;
    const cw = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const w = Math.acos(cw), sw = Math.sin(w);
    let px, py, pz;
    if (sw < 1e-9) { px = a[0]; py = a[1]; pz = a[2]; } else {
        const ka = Math.sin((1 - s) * w) / sw, kb = Math.sin(s * w) / sw;
        px = a[0] * ka + b[0] * kb; py = a[1] * ka + b[1] * kb; pz = a[2] * ka + b[2] * kb;
    }
    const m = Math.hypot(px, py, pz) || 1;
    const r = 1 + apexH * Math.sin(Math.PI * s);
    out[0] = px / m * r; out[1] = py / m * r; out[2] = pz / m * r;
    return out;
}

// ── Particle state ──────────────────────────────────────────────────────────

/** Small, fast, seeded PRNG (mulberry32). */
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {number} n  pool size
 * @param {number} seed
 */
export function createFlowState(n, seed = 1) {
    return {
        n,
        data: new Float32Array(n * STRIDE),
        alive: new Uint8Array(n),
        count: 0,
        rng: makeRng(seed),
        spawnCredit: 0,
        sites: [],            // the live sites, set by setSites
        loops: [],            // per site: siteLoops(site)
        t: 0,
    };
}

/**
 * Replace the live flare sites. Each: { id, c, ax, side, hs, letter, flash }
 * (`flash` is hero-sun-model `flareFlash` at τ — the emission envelope).
 * Particles already in flight keep their site index; a site that vanishes
 * leaves its particles to finish on the loops they were on.
 */
export function setSites(state, sites) {
    // Emission credit survives a re-set of the same site (keyed by `id`), so a
    // caller refreshing the list every frame does not starve the emitter.
    const credit = new Map(state.sites.map((s) => [s.id, s._credit || 0]));
    state.sites = sites.map((s) => ({
        ...s, letter: FLOW_CLASS[s.letter] ? s.letter : 'C', _credit: credit.get(s.id) || 0,
    }));
    state.loops = state.sites.map((s) => siteLoops(s));
}

function spawn(state, siteIdx, kind) {
    const { data, alive, n, rng } = state;
    let i = -1;
    for (let k = 0; k < n; k++) if (!alive[k]) { i = k; break; }
    if (i < 0) return false;
    const site = state.sites[siteIdx];
    const loops = state.loops[siteIdx];
    const cls = FLOW_CLASS[site.letter];
    const o = i * STRIDE;
    const k = Math.min(loops.length - 1, Math.floor(rng() * loops.length));
    const loop = loops[k];
    if (kind === KIND.LOOP) {
        const fromA = rng() < 0.5;
        const s = fromA ? 0.01 + 0.03 * rng() : 0.99 - 0.03 * rng();
        loopPoint(loop, s, _tmp);
        data[o] = _tmp[0]; data[o + 1] = _tmp[1]; data[o + 2] = _tmp[2];
        data[o + 3] = 0;
        data[o + 4] = cls.life * (0.75 + 0.5 * rng());
        data[o + 5] = s;
        data[o + 6] = fromA ? 1 : -1;
        data[o + 7] = k;
        data[o + 8] = KIND.LOOP;
        data[o + 9] = siteIdx;
    } else {
        // Released at the top of one of the bigger loops.
        const kk = Math.max(0, loops.length - 1 - Math.floor(rng() * 2));
        loopPoint(loops[kk], 0.5 + (rng() - 0.5) * 0.3, _tmp);
        data[o] = _tmp[0]; data[o + 1] = _tmp[1]; data[o + 2] = _tmp[2];
        data[o + 3] = 0;
        data[o + 4] = cls.life * (1.4 + 0.8 * rng());
        data[o + 5] = 0.5;
        data[o + 6] = 1;
        data[o + 7] = kk;
        data[o + 8] = KIND.EJECTA;
        data[o + 9] = siteIdx;
    }
    alive[i] = 1;
    state.count++;
    return true;
}

const _tmp = [0, 0, 0], _cv = [0, 0, 0];

/**
 * Advance the flow by `dt` display seconds. Emission follows each site's
 * `flash` (0..1) × its class rate; motion is the three-term field above.
 * @returns {{spawned:number, alive:number}}
 */
export function stepFlow(state, dt) {
    if (!(dt > 0)) return { spawned: 0, alive: state.count };
    dt = Math.min(dt, 0.1);
    state.t += dt;
    const { data, alive, n, rng } = state;
    let spawned = 0;

    // ── Emission ──
    state.sites.forEach((site, si) => {
        const flash = Math.max(0, Math.min(1, site.flash || 0));
        if (flash <= 0.001) return;
        const cls = FLOW_CLASS[site.letter];
        site._credit = (site._credit || 0) + cls.rate * flash * dt;
        while (site._credit >= 1) {
            site._credit -= 1;
            const kind = rng() < cls.escape ? KIND.EJECTA : KIND.LOOP;
            if (!spawn(state, si, kind)) { site._credit = 0; break; }
            spawned++;
        }
    });

    // ── Motion ──
    for (let i = 0; i < n; i++) {
        if (!alive[i]) continue;
        const o = i * STRIDE;
        const age = data[o + 3] + dt;
        const life = data[o + 4];
        const si = data[o + 9] | 0;
        const site = state.sites[si];
        const loops = state.loops[si];
        if (!site || !loops) { alive[i] = 0; state.count--; continue; }
        const cls = FLOW_CLASS[site.letter];
        data[o + 3] = age;
        if (data[o + 8] === KIND.LOOP) {
            const loop = loops[Math.min(loops.length - 1, data[o + 7] | 0)];
            let s = data[o + 5], dir = data[o + 6];
            const cooling = age > life * COOL_FRACTION;
            if (cooling && Math.abs(dir) < 1.5) {
                // Rain: toward the nearer footpoint, flagged by |dir| = 2.
                dir = s < 0.5 ? -2 : 2;
                data[o + 6] = dir;
            }
            // Evaporation slows toward the apex (siphon against pressure);
            // rain accelerates toward the foot (free fall along the loop).
            const apexSlow = 1 - 0.55 * Math.sin(Math.PI * s);
            const speed = cls.vLoop * (Math.abs(dir) > 1.5 ? 1.0 + 1.4 * (1 - Math.sin(Math.PI * s)) : apexSlow);
            s += Math.sign(dir) * speed * dt;
            if (!cooling) s = dir > 0 ? Math.min(s, 0.5 + 0.02) : Math.max(s, 0.5 - 0.02); // the climb ends at the apex
            if (s <= 0 || s >= 1 || age > life) { alive[i] = 0; state.count--; continue; }
            data[o + 5] = s;
            loopPoint(loop, s, _tmp);
            // A whisper of the eddy field so a filled loop shimmers, never leaves.
            curlNoise(_tmp[0], _tmp[1], _tmp[2], state.t, _cv);
            const k = CURL.gain * 0.05;
            data[o] = _tmp[0] + _cv[0] * k; data[o + 1] = _tmp[1] + _cv[1] * k; data[o + 2] = _tmp[2] + _cv[2] * k;
        } else {
            let x = data[o], y = data[o + 1], z = data[o + 2];
            const r = Math.hypot(x, y, z) || 1;
            const loop = loops[Math.min(loops.length - 1, data[o + 7] | 0)];
            // Escape grows with height above the arcade top.
            const above = Math.max(0, r - (1 + loop.apexH));
            const esc = cls.vEscape * Math.min(1, above / ESCAPE_RAMP + 0.25);
            curlNoise(x, y, z, state.t, _cv);
            const g = CURL.gain * (1 + 2.0 * Math.min(1, above));
            const vx = esc * x / r + _cv[0] * g;
            const vy = esc * y / r + _cv[1] * g;
            const vz = esc * z / r + _cv[2] * g;
            x += vx * dt; y += vy * dt; z += vz * dt;
            const r2 = Math.hypot(x, y, z);
            if (r2 < 1.0) { const f = 1.001 / r2; x *= f; y *= f; z *= f; }   // never through the photosphere
            if (r2 > R_LEAVE || age > life) { alive[i] = 0; state.count--; continue; }
            data[o] = x; data[o + 1] = y; data[o + 2] = z;
        }
    }
    return { spawned, alive: state.count };
}

/**
 * Pack the live particles for a renderer: positions (3 per), kind, and
 * normalised age (0 born … 1 dying). Dead slots are parked at the origin
 * with age 1 (invisible). Buffers are reused when supplied.
 */
export function packFlow(state, out = null) {
    const n = state.n;
    const o = out ?? { pos: new Float32Array(n * 3), kind: new Float32Array(n), age: new Float32Array(n) };
    const { data, alive } = state;
    for (let i = 0; i < n; i++) {
        const b = i * STRIDE;
        if (!alive[i]) { o.pos[i * 3] = 0; o.pos[i * 3 + 1] = 0; o.pos[i * 3 + 2] = 0; o.kind[i] = 0; o.age[i] = 1; continue; }
        o.pos[i * 3] = data[b]; o.pos[i * 3 + 1] = data[b + 1]; o.pos[i * 3 + 2] = data[b + 2];
        o.kind[i] = data[b + 8];
        o.age[i] = Math.min(1, data[b + 3] / Math.max(1e-6, data[b + 4]));
    }
    return o;
}

/** Live counts by kind (for readouts and the gate). */
export function flowCounts(state) {
    let loop = 0, ejecta = 0;
    for (let i = 0; i < state.n; i++) {
        if (!state.alive[i]) continue;
        if (state.data[i * STRIDE + 8] === KIND.EJECTA) ejecta++; else loop++;
    }
    return { loop, ejecta, total: loop + ejecta };
}
