//! star-collider-kernel — the Star Collider Lab's WASM merger engine.
//!
//! See sph.rs for the physics. This file is the extern-C surface, in the
//! rust-shielding / rust-ring-current mould: one static `Sim` allocated on
//! `sc_init`, plain pointers into its buffers (never reallocated after init,
//! so JS views stay valid), scalar diagnostics through one f64 slot array.
//!
//! Lifecycle from JS (js/star-collider/kernel.js):
//!   sc_init()
//!   sc_set_params(c, alpha, beta, gamma_th, eta_h, cfl, pn_flags, sink_factor)
//!   sc_set_body(0, kind, mass, radius, gamma); sc_set_body(1, …)
//!   sc_build(nA, nB, seed)            → particle count
//!   sc_relax(steps, dt_max, damping)  (each star alone, damped)
//!   sc_set_orbit(sep, ecc, spinA, spinB, pn_circ)
//!   loop: sc_advance(dt_total, max_steps, dt_max); sc_pack_frame(); read views
//!   (frame stride = sc_frame_stride(): x, y, z, log10 ρ, u, flags = star + 2·unbound)
//!
//! Diagnostic slots (sc_diag_ptr, DIAG_SLOTS f64):
//!    0 time            1 dt_last        2 n_alive        3 separation (CM–CM)
//!    4 E_kin           5 E_thermal      6 E_pot          7 E_total
//!    8 L_z             9 ρ_max         10 M_unbound     11 accreted by A
//!   12 accreted by B  13–18 Q̈ xx yy zz xy xz yz         19 |v_rel|
//!   20–22 CM of A     23–25 CM of B    26 steps         27 p_max
//!   28 u_max          29 orbital ω     30 PN weight     31 RR power
//!   32 E_gw (integrated RR work)       33/34 alive mass A/B
//!   35/36 body mass A/B (BH grows)     37/38 r_s A/B    39 n_total
//!
//! Snapshot / restore (the page's rewind clock): sc_snapshot() serialises the
//! COMPLETE integrator state into the buffer at sc_snap_ptr() (flat f64, see
//! sph.rs SNAP_*) and returns its length; JS copies it out. To rewind, JS
//! copies a snapshot back into the same buffer and calls sc_restore(len),
//! which refuses (returns 0) a snapshot from another build. Advancing from a
//! restored state reproduces the live run bit for bit — that is what makes
//! the transport bar honest, and `cargo test` pins it.

pub mod lane_emden;
pub mod sph;

use sph::{Kind, Sim, DIAG_SLOTS, FRAME_STRIDE, MAX_N, SNAP_CAPACITY, SNAP_HEADER, SNAP_STRIDE};

static mut SIM: Option<Box<Sim>> = None;

#[allow(static_mut_refs)]
fn sim() -> &'static mut Sim {
    unsafe {
        if SIM.is_none() {
            SIM = Some(Box::new(Sim::new()));
        }
        SIM.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn sc_init() {
    #[allow(static_mut_refs)]
    unsafe {
        SIM = Some(Box::new(Sim::new()));
    }
}

#[no_mangle]
pub extern "C" fn sc_max_particles() -> u32 {
    MAX_N as u32
}

#[no_mangle]
pub extern "C" fn sc_diag_slots() -> u32 {
    DIAG_SLOTS as u32
}

/// Fields per particle in the packed render frame (x, y, z, log10 ρ, u, flags).
#[no_mangle]
pub extern "C" fn sc_frame_stride() -> u32 {
    FRAME_STRIDE as u32
}

/// pn_flags bit 0 = 1PN conservative, bit 1 = 2.5PN radiation reaction.
#[no_mangle]
pub extern "C" fn sc_set_params(c: f64, alpha: f64, beta: f64, gamma_th: f64, eta_h: f64, cfl: f64, pn_flags: u32, sink_factor: f64) {
    let s = sim();
    s.params.c = c;
    s.params.alpha = alpha.max(0.0);
    s.params.beta = beta.max(0.0);
    s.params.gamma_th = gamma_th.max(1.01);
    s.params.eta_h = eta_h.max(0.8).min(2.0);
    s.params.cfl = cfl.max(0.05).min(0.6);
    s.params.pn1 = pn_flags & 1 != 0;
    s.params.pn25 = pn_flags & 2 != 0;
    s.params.sink_factor = sink_factor.max(1.05);
}

/// kind: 0 = star (SPH), 1 = black hole (point mass).
#[no_mangle]
pub extern "C" fn sc_set_body(idx: u32, kind: u32, mass: f64, radius: f64, gamma: f64) {
    let k = if kind == 1 { Kind::BlackHole } else { Kind::Star };
    sim().set_body((idx as usize).min(1), k, mass, radius, gamma);
}

#[no_mangle]
pub extern "C" fn sc_build(n_a: u32, n_b: u32, seed: u32) -> u32 {
    sim().build(n_a as usize, n_b as usize, seed as u64) as u32
}

#[no_mangle]
pub extern "C" fn sc_relax(steps: u32, dt_max: f64, damping: f64) {
    sim().relax(steps, dt_max, damping);
}

#[no_mangle]
pub extern "C" fn sc_set_orbit(sep: f64, ecc: f64, spin_a: f64, spin_b: f64, pn_circ: u32) {
    sim().set_orbit(sep, ecc, spin_a, spin_b, pn_circ != 0);
}

#[no_mangle]
pub extern "C" fn sc_advance(dt_total: f64, max_steps: u32, dt_max: f64) -> u32 {
    sim().advance(dt_total, max_steps, dt_max)
}

/// Serialise the integrator state into the snapshot buffer; returns the f64 length.
#[no_mangle]
pub extern "C" fn sc_snapshot() -> u32 {
    sim().snapshot() as u32
}

/// Restore the state from the first `len` slots of the snapshot buffer. 1 on success, 0 if refused.
#[no_mangle]
pub extern "C" fn sc_restore(len: u32) -> u32 {
    if sim().restore(len as usize) {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn sc_snap_ptr() -> *mut f64 {
    sim().snap.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn sc_snap_capacity() -> u32 {
    SNAP_CAPACITY as u32
}

/// Layout helpers so kernel.js never hard-codes the snapshot geometry.
#[no_mangle]
pub extern "C" fn sc_snap_header() -> u32 {
    SNAP_HEADER as u32
}

#[no_mangle]
pub extern "C" fn sc_snap_stride() -> u32 {
    SNAP_STRIDE as u32
}

#[no_mangle]
pub extern "C" fn sc_update_diagnostics() {
    sim().update_diagnostics();
}

#[no_mangle]
pub extern "C" fn sc_pack_frame() {
    sim().pack_frame();
}

#[no_mangle]
pub extern "C" fn sc_n() -> u32 {
    sim().n as u32
}

#[no_mangle]
pub extern "C" fn sc_time() -> f64 {
    sim().time
}

#[no_mangle]
pub extern "C" fn sc_body_first(idx: u32) -> u32 {
    sim().bodies[(idx as usize).min(1)].first as u32
}

#[no_mangle]
pub extern "C" fn sc_body_count(idx: u32) -> u32 {
    sim().bodies[(idx as usize).min(1)].n_particles as u32
}

#[no_mangle]
pub extern "C" fn sc_body_kind(idx: u32) -> u32 {
    if sim().bodies[(idx as usize).min(1)].kind == Kind::BlackHole { 1 } else { 0 }
}

/// Black-hole state for body idx: writes [mass, x, y, z, vx, vy, vz, r_s, sink, accreted] into out (10 f64).
#[no_mangle]
pub extern "C" fn sc_body_state(idx: u32, out: *mut f64) {
    let b = sim().bodies[(idx as usize).min(1)];
    let vals = [b.mass, b.pos[0], b.pos[1], b.pos[2], b.vel[0], b.vel[1], b.vel[2], b.rs, b.sink, b.accreted];
    unsafe {
        for (i, v) in vals.iter().enumerate() {
            *out.add(i) = *v;
        }
    }
}

#[no_mangle]
pub extern "C" fn sc_body_k(idx: u32) -> f64 {
    sim().bodies[(idx as usize).min(1)].k_poly
}

// ── Buffers ─────────────────────────────────────────────────────────────────
#[no_mangle]
pub extern "C" fn sc_pos_ptr() -> *mut f64 {
    sim().pos.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_vel_ptr() -> *mut f64 {
    sim().vel.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_rho_ptr() -> *mut f64 {
    sim().rho.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_u_ptr() -> *mut f64 {
    sim().u.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_h_ptr() -> *mut f64 {
    sim().h.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_mass_ptr() -> *mut f64 {
    sim().mass.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_phi_ptr() -> *mut f64 {
    sim().phi.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_star_ptr() -> *mut u8 {
    sim().star.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_alive_ptr() -> *mut u8 {
    sim().alive.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_frame_ptr() -> *mut f32 {
    sim().frame.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sc_diag_ptr() -> *mut f64 {
    sim().diag.as_mut_ptr()
}
/// A scratch area of 16 f64 for sc_body_state.
static mut SCRATCH: [f64; 16] = [0.0; 16];
#[no_mangle]
pub extern "C" fn sc_scratch_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(SCRATCH) as *mut f64
}
