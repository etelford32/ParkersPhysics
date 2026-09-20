/**
 * star-collider/kernel.js — loader/wrapper for star_collider_kernel.wasm
 * ═══════════════════════════════════════════════════════════════════════════
 * The kernel is a dependency-free `extern "C"` module (rust-star-collider/):
 * 3D SPH merger engine with Lane–Emden polytrope stars, a hybrid cold +
 * thermal EOS, softened direct gravity, Paczyński–Wiita black-hole sinks,
 * bulk 2.5PN radiation reaction (1PN opt-in) and quadrupole-formula GW
 * extraction. Physics is gated by `cargo test` in rust-star-collider/; the
 * committed binary is gated by tests/star-collider-kernel-smoke.mjs.
 *
 * Loads from a URL (worker/browser; instantiateStreaming with an
 * ArrayBuffer fallback for hosts that mislabel the MIME type) or from bytes
 * (the Node smoke test). The Sim is boxed once at sc_init and its buffers
 * are never reallocated, but the WASM memory GROWS at that first allocation
 * (~1.5 MB), which detaches any earlier view — so every accessor re-creates
 * its TypedArray view rather than caching one.
 *
 * Units are the kernel's: G = 1. The page feeds geometric units (M☉,
 * G M☉/c²) so that c = 1; see page.js `toCode()`.
 */

export const DIAG = Object.freeze({
    time: 0, dtLast: 1, nAlive: 2, separation: 3, eKin: 4, eThermal: 5, ePot: 6, eTotal: 7,
    lz: 8, rhoMax: 9, mUnbound: 10, accretedA: 11, accretedB: 12,
    qxx: 13, qyy: 14, qzz: 15, qxy: 16, qxz: 17, qyz: 18, vRel: 19,
    cmAx: 20, cmAy: 21, cmAz: 22, cmBx: 23, cmBy: 24, cmBz: 25,
    steps: 26, pMax: 27, uMax: 28, omega: 29, pnWeight: 30, rrPower: 31, eGw: 32,
    aliveMassA: 33, aliveMassB: 34, massA: 35, massB: 36, rsA: 37, rsB: 38, nTotal: 39,
});

export async function loadKernel(source) {
    let instance;
    if (typeof source === 'string' || source instanceof URL) {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`star-collider kernel fetch: HTTP ${resp.status}`);
        try {
            instance = (await WebAssembly.instantiateStreaming(resp.clone(), {})).instance;
        } catch {
            instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), {})).instance;
        }
    } else {
        instance = (await WebAssembly.instantiate(source, {})).instance;
    }
    const x = instance.exports;
    x.sc_init();
    const maxParticles = x.sc_max_particles();
    const diagSlots = x.sc_diag_slots();

    const f64 = (ptr, len) => new Float64Array(x.memory.buffer, ptr, len);
    const f32 = (ptr, len) => new Float32Array(x.memory.buffer, ptr, len);
    const u8 = (ptr, len) => new Uint8Array(x.memory.buffer, ptr, len);

    const kernel = {
        maxParticles, diagSlots,
        init() { x.sc_init(); },
        setParams({ c = 1, alpha = 1, beta = 2, gammaTh = 1.75, etaH = 1.3, cfl = 0.3, pn1 = false, pn25 = true, sinkFactor = 1.5 } = {}) {
            x.sc_set_params(c, alpha, beta, gammaTh, etaH, cfl, (pn1 ? 1 : 0) | (pn25 ? 2 : 0), sinkFactor);
        },
        setBody(idx, { kind = 'star', mass, radius, gamma = 2 }) {
            x.sc_set_body(idx, kind === 'bh' ? 1 : 0, mass, radius, gamma);
        },
        build(nA, nB, seed = 1) { return x.sc_build(nA, nB, seed >>> 0); },
        relax(steps, dtMax, damping) { x.sc_relax(steps, dtMax, damping); },
        setOrbit(sep, ecc = 0, spinA = 0, spinB = 0, pnCirc = true) { x.sc_set_orbit(sep, ecc, spinA, spinB, pnCirc ? 1 : 0); },
        advance(dtTotal, maxSteps, dtMax) { return x.sc_advance(dtTotal, maxSteps, dtMax); },
        n() { return x.sc_n(); },
        time() { return x.sc_time(); },
        bodyFirst(idx) { return x.sc_body_first(idx); },
        bodyCount(idx) { return x.sc_body_count(idx); },
        bodyKind(idx) { return x.sc_body_kind(idx) === 1 ? 'bh' : 'star'; },
        bodyK(idx) { return x.sc_body_k(idx); },
        bodyState(idx) {
            const ptr = x.sc_scratch_ptr();
            x.sc_body_state(idx, ptr);
            const v = f64(ptr, 10);
            return { mass: v[0], pos: [v[1], v[2], v[3]], vel: [v[4], v[5], v[6]], rs: v[7], sink: v[8], accreted: v[9] };
        },
        /** Named diagnostics (fresh object). Call after advance(). */
        diagnostics() {
            x.sc_update_diagnostics();
            const d = f64(x.sc_diag_ptr(), diagSlots);
            const out = {};
            for (const [k, i] of Object.entries(DIAG)) out[k] = d[i];
            return out;
        },
        /** Packed render frame [x,y,z,log10ρ,u] × n as a COPY (safe to transfer). */
        frame() {
            x.sc_pack_frame();
            const n = x.sc_n();
            return new Float32Array(f32(x.sc_frame_ptr(), n * 5));
        },
        // Raw views (re-created per call; do not hold across an allocation).
        pos() { return f64(x.sc_pos_ptr(), x.sc_n() * 3); },
        vel() { return f64(x.sc_vel_ptr(), x.sc_n() * 3); },
        rho() { return f64(x.sc_rho_ptr(), x.sc_n()); },
        u() { return f64(x.sc_u_ptr(), x.sc_n()); },
        h() { return f64(x.sc_h_ptr(), x.sc_n()); },
        mass() { return f64(x.sc_mass_ptr(), x.sc_n()); },
        star() { return u8(x.sc_star_ptr(), x.sc_n()); },
        alive() { return u8(x.sc_alive_ptr(), x.sc_n()); },
    };
    return kernel;
}
