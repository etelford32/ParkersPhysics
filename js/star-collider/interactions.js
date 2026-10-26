/**
 * star-collider/interactions.js — what the particles are DOING to each other
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. Reads the kernel's raw state (positions, velocities, smoothing
 * lengths, masses, densities, internal energies, body membership — the
 * `kernel.pos()/vel()/h()/…` views) and evaluates, per particle, three
 * quantities with EXACTLY the pair rules of rust-star-collider/src/sph.rs:
 *
 *   • ∇·v — the SPH velocity divergence,
 *       (∇·v)_i = −(1/ρ_i) Σ_j m_j (v_i − v_j)·∇_i W(r_ij, h_ij)
 *     negative = the gas is being COMPRESSED (converging flow, a shock
 *     forming), positive = it is expanding (tidal tails, ejecta).
 *   • the VISCOUS HEATING RATE — the artificial-viscosity half of the
 *     kernel's du/dt, Σ_j m_j ½ Π_ij (dW/dr / r) (v_ij·r_ij), with the same
 *     Monaghan Π (α, β, the 0.01 h² regulator, pair-mean c_s and ρ). It is
 *     non-zero only for APPROACHING pairs, so it is the live answer to
 *     "where are shocks heating the gas right now" — the time derivative of
 *     the 'heat' colour mode, not a second definition of it.
 *   • MIXING — the kernel-weighted mass fraction of a particle's neighbours
 *     that belong to the OTHER star, Σ_{j∈other} m_j W / Σ_j m_j W (self
 *     included in the denominator). 0 inside an untouched star, → ½ where
 *     the two stars' gas has interpenetrated: the diffusion layer.
 *
 * and the list of A–B INTERACTION PAIRS: cross-body pairs whose kernels
 * overlap (r < 2 h_ij), each with its kernel weight and its viscous heating —
 * the contact surface the two stars actually push on.
 *
 * PAIR CONVENTIONS (sph.rs, `forces`): h_ij = ½(h_i + h_j), support 2 h_ij,
 * ∇W = kernel_dw(r, h_ij)/r · (x_i − x_j), viscosity only for v_ij·r_ij < 0
 * with μ = h_ij v·r / (r² + 0.01 h_ij²), Π = (−α c̄ μ + β μ²)/ρ̄. The sound
 * speed is the kernel's EOS: c_s² = Γ K ρ^{Γ−1} + Γ_th(Γ_th − 1) u.
 * MIXING uses W(r, h_i) — the GATHER kernel of the density sum, so its
 * denominator is the particle's own density estimate.
 *
 * NEIGHBOUR SEARCH is exact, not approximate: particles with h ≤ h_cut (the
 * 90th percentile) live in a cell grid of edge 2 h_cut, and every pair
 * involving a particle above the cut (the few, fat ejecta kernels) is found
 * by a direct loop over all particles. tests/star-collider-interactions.mjs
 * pins the pair set against an O(N²) brute force.
 *
 * Diagnostic only: nothing here feeds back into the integration.
 */

const PI = Math.PI;

export function kernelW(r, h) {
    const q = r / h, s = 1 / (PI * h * h * h);
    if (q < 1) return s * (1 - 1.5 * q * q + 0.75 * q * q * q);
    if (q < 2) { const t = 2 - q; return s * 0.25 * t * t * t; }
    return 0;
}
export function kernelDw(r, h) {
    const q = r / h, s = 1 / (PI * h * h * h * h);
    if (q < 1) return s * (-3 * q + 2.25 * q * q);
    if (q < 2) { const t = 2 - q; return s * (-0.75 * t * t); }
    return 0;
}

/**
 * Visit every unordered pair (i < j) of live particles with r < reach(i, j),
 * where reach = (h_i + h_j) — i.e. 2 h_ij — or, for the gather kernel, the
 * larger of 2 h_i and 2 h_j. `visit(i, j, dx, dy, dz, r2)` with d = x_i − x_j.
 */
export function forEachPair(state, visit) {
    const { n, pos, h, alive } = state;
    const live = [];
    for (let i = 0; i < n; i++) if (!alive || alive[i]) live.push(i);
    if (live.length < 2) return;
    const hs = live.map(i => h[i]).sort((a, b) => a - b);
    const hCut = hs[Math.min(hs.length - 1, Math.floor(0.9 * hs.length))];
    const small = [], big = [];
    for (const i of live) (h[i] <= hCut ? small : big).push(i);
    const isBig = new Uint8Array(n);
    for (const i of big) isBig[i] = 1;
    // A pair must be tested if r < 2·max(h_i, h_j) (covers both the
    // symmetric h_ij support and either gather kernel).
    const test = (i, j) => {
        const dx = pos[3 * i] - pos[3 * j], dy = pos[3 * i + 1] - pos[3 * j + 1], dz = pos[3 * i + 2] - pos[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        const reach = 2 * Math.max(h[i], h[j]);
        if (r2 < reach * reach) visit(i, j, dx, dy, dz, r2);
    };
    // Small–small through a grid of edge 2·hCut: every in-reach pair lies in adjacent cells.
    const cell = 2 * hCut;
    if (cell > 0 && small.length) {
        const map = new Map();
        const key = (a, b, c) => `${a},${b},${c}`;
        const cix = new Int32Array(n * 3);
        for (const i of small) {
            const a = Math.floor(pos[3 * i] / cell), b = Math.floor(pos[3 * i + 1] / cell), c = Math.floor(pos[3 * i + 2] / cell);
            cix[3 * i] = a; cix[3 * i + 1] = b; cix[3 * i + 2] = c;
            const k = key(a, b, c);
            let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); }
            arr.push(i);
        }
        for (const i of small) {
            const a = cix[3 * i], b = cix[3 * i + 1], c = cix[3 * i + 2];
            for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
                const arr = map.get(key(a + da, b + db, c + dc));
                if (!arr) continue;
                for (const j of arr) if (j > i) test(i, j);
            }
        }
    }
    // Every pair with at least one big kernel: direct.
    for (const i of big) {
        for (const j of live) {
            if (j === i || (isBig[j] && j < i)) continue;
            test(Math.min(i, j), Math.max(i, j));
        }
    }
}

/**
 * state: { n, pos, vel, h, mass, rho, u, star, alive, bodies:[{k, gamma}×2] }
 * params: { alpha, beta, gammaTh }
 * opts: { maxLinks }
 * → { div, heatRate, mix (Float64Array n), links: [{i, j, w, heat}] (A–B,
 *     strongest first, capped), summary }
 */
export function computeInteractions(state, params = {}, { maxLinks = 4000 } = {}) {
    const { n, pos, vel, h, mass, rho, u, star, alive, bodies } = state;
    const alpha = params.alpha ?? 1, beta = params.beta ?? 2, gth = params.gammaTh ?? 1.75;
    const cs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (alive && !alive[i]) continue;
        const b = bodies[star[i]] || bodies[0];
        const r = Math.max(rho[i], 1e-30), ui = Math.max(u[i], 0);
        const cs2 = b.gamma * b.k * Math.pow(r, b.gamma - 1) + gth * (gth - 1) * ui;
        cs[i] = Math.sqrt(Math.max(cs2, 0));
    }
    const divSum = new Float64Array(n), heat = new Float64Array(n);
    const wOther = new Float64Array(n), wAll = new Float64Array(n);
    for (let i = 0; i < n; i++) if (!alive || alive[i]) wAll[i] = mass[i] * kernelW(0, h[i]);
    const links = [];
    let abPairs = 0;
    forEachPair(state, (i, j, dx, dy, dz, r2) => {
        const r = Math.sqrt(r2);
        const other = star[i] !== star[j];
        // Gather kernel (mixing / density weights): each side with its own h.
        if (r < 2 * h[i]) { const w = mass[j] * kernelW(r, h[i]); wAll[i] += w; if (other) wOther[i] += w; }
        if (r < 2 * h[j]) { const w = mass[i] * kernelW(r, h[j]); wAll[j] += w; if (other) wOther[j] += w; }
        // Symmetric pair (the kernel's force loop).
        const hij = 0.5 * (h[i] + h[j]);
        if (r2 >= 4 * hij * hij) return;
        const rr = Math.max(r, 1e-12);
        const dw = kernelDw(rr, hij) / rr;
        const dvx = vel[3 * i] - vel[3 * j], dvy = vel[3 * i + 1] - vel[3 * j + 1], dvz = vel[3 * i + 2] - vel[3 * j + 2];
        const vdotr = dvx * dx + dvy * dy + dvz * dz;
        // div: (v_i − v_j)·∇_i W = dw · vdotr; ∇_j W = −∇_i W and v_ji·r_ji = vdotr.
        divSum[i] += mass[j] * dw * vdotr;
        divSum[j] += mass[i] * dw * vdotr;
        let pairHeat = 0;
        if (vdotr < 0) {
            const mu = hij * vdotr / (r2 + 0.01 * hij * hij);
            const cij = 0.5 * (cs[i] + cs[j]);
            const rhoij = 0.5 * (rho[i] + rho[j]);
            const visc = (-alpha * cij * mu + beta * mu * mu) / rhoij;
            const e = 0.5 * visc * dw * vdotr;              // ≥ 0: dw < 0, vdotr < 0
            heat[i] += mass[j] * e;
            heat[j] += mass[i] * e;
            pairHeat = e;
        }
        if (other) {
            abPairs++;
            links.push({ i, j, w: kernelW(r, hij) * Math.sqrt(mass[i] * mass[j]), heat: pairHeat * (mass[i] + mass[j]) });
        }
    });
    const div = new Float64Array(n), mix = new Float64Array(n);
    let mTot = 0, mMixed = 0, mShock = 0, heatTot = 0, cmV = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        if (alive && !alive[i]) continue;
        div[i] = -divSum[i] / Math.max(rho[i], 1e-30);
        mix[i] = wAll[i] > 0 ? wOther[i] / wAll[i] : 0;
        mTot += mass[i];
        if (mix[i] > 0.1) mMixed += mass[i];
        if (heat[i] > 0) heatTot += mass[i] * heat[i];
        for (let c = 0; c < 3; c++) cmV[c] += mass[i] * vel[3 * i + c];
    }
    // "Shocking" = the particles that carry 90 % of the viscous heating now.
    const order = [];
    for (let i = 0; i < n; i++) if ((!alive || alive[i]) && heat[i] > 0) order.push(i);
    order.sort((a, b) => mass[b] * heat[b] - mass[a] * heat[a]);
    let acc = 0;
    for (const i of order) { if (acc >= 0.9 * heatTot) break; acc += mass[i] * heat[i]; mShock += mass[i]; }
    links.sort((a, b) => (b.heat - a.heat) || (b.w - a.w));
    if (links.length > maxLinks) links.length = maxLinks;
    return {
        div, heatRate: heat, mix, links,
        summary: {
            abPairs, mixedFraction: mTot > 0 ? mMixed / mTot : 0, shockFraction: mTot > 0 ? mShock / mTot : 0,
            heatingPower: heatTot, cmVel: mTot > 0 ? cmV.map(v => v / mTot) : [0, 0, 0],
        },
    };
}

/**
 * Pack for the wire: aux Float32Array stride AUX_STRIDE per particle
 * (vx, vy, vz, h, ∇·v, mixing, heating rate) and links Float32Array
 * stride 4 (i, j, w, heat).
 */
export const AUX_STRIDE = 7;
export function packInteractions(state, result) {
    const { n, vel, h } = state;
    const aux = new Float32Array(n * AUX_STRIDE);
    for (let i = 0; i < n; i++) {
        const o = AUX_STRIDE * i;
        aux[o] = vel[3 * i]; aux[o + 1] = vel[3 * i + 1]; aux[o + 2] = vel[3 * i + 2];
        aux[o + 3] = h[i]; aux[o + 4] = result.div[i]; aux[o + 5] = result.mix[i]; aux[o + 6] = result.heatRate[i];
    }
    const links = new Float32Array(result.links.length * 4);
    result.links.forEach((l, k) => { links[4 * k] = l.i; links[4 * k + 1] = l.j; links[4 * k + 2] = l.w; links[4 * k + 3] = l.heat; });
    return { aux, links };
}
