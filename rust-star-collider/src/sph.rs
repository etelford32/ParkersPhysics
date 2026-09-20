//! The merger engine: 3D SPH with self-gravity, black-hole sinks and bulk
//! post-Newtonian corrections.
//!
//! UNITS. G = 1. Everything else is whatever the caller makes it: the page
//! feeds masses in M☉ and lengths in G M☉/c² so that c = 1 and the PN terms
//! are O(1) for neutron stars, and it feeds a white dwarf in the same units
//! (c still 1, but v/c ~ 10⁻² so the PN terms vanish on their own). `c` is a
//! parameter; c ≤ 0 switches every relativistic term off and the engine is
//! plain Newtonian SPH.
//!
//! WHAT IS MODELLED
//!   * Stars are Lane–Emden polytropes of index n = 1/(Γ − 1), placed as a
//!     stretched cubic lattice (equal-mass particles, radii mapped through
//!     the enclosed-mass fraction) and relaxed in isolation with velocity
//!     damping until the pressure and the softened self-gravity agree.
//!   * SPH: cubic-spline (M4) kernel, gather density with an adaptive
//!     smoothing length h = η (m/ρ)^{1/3} relaxed toward its target each
//!     step, symmetric pressure force with pair-averaged h (exact momentum
//!     conservation), Monaghan 1992 artificial viscosity (α, β) with the
//!     standard 0.01h² regulariser.
//!   * Hybrid EOS (Janka+ 1993; Bauswein+ 2010): p = K ρ^Γ + (Γ_th − 1) ρ u.
//!     The cold part is adiabatic by construction; only the thermal part
//!     does pdV work on u, and only shocks (the viscosity) heat it. u is the
//!     shock-heating record — the remnant's temperature proxy.
//!   * Gravity: direct summation, Plummer-softened with ε = pair-mean h.
//!     O(N²), which caps this at a few thousand particles per star in a
//!     browser; there is no tree. A black hole is a point mass in a
//!     Paczyński–Wiita potential Φ = −M/(r − r_s), r_s = 2M/c², whose ISCO
//!     falls at 6M by itself, with a sink at 1.5 r_s that absorbs mass and
//!     momentum.
//!   * Bulk PN: the 1PN and 2.5PN two-body relative accelerations (Lincoln &
//!     Will 1990, harmonic gauge) evaluated on the two bodies' centres of
//!     mass and applied to every particle of each body as a uniform kick —
//!     momentum-conserving by construction. The 2.5PN term is what drives
//!     the inspiral; its work is integrated as E_gw. It fades to zero as
//!     the bodies overlap (a merged blob has no meaningful "two centres").
//!   * GW extraction: Q̈_ij from Σ m (2 v_i v_j + x_i a_j + x_j a_i), exact
//!     given the accelerations — no finite differencing, no noise.
//!   * Unbound mass: Bernoulli ½v² + Φ + u > 0 over the star particles.
//!
//! WHAT IS NOT. No GR hydrodynamics, no neutrinos, no magnetic fields, no
//! nuclear EOS in the hydro (the TOV builder in JS supplies the radius the
//! polytrope is fitted to). This is the Rasio & Shapiro / Rosswog class of
//! merger simulation, with the PN inspiral driver of Faber & Rasio; the
//! page says exactly that.

use crate::lane_emden::Polytrope;
use core::f64::consts::PI;

pub const MAX_N: usize = 8192;
pub const DIAG_SLOTS: usize = 40;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Star,
    BlackHole,
}

#[derive(Clone, Copy)]
pub struct Body {
    pub kind: Kind,
    pub mass: f64,
    pub radius: f64,
    pub gamma: f64,
    pub k_poly: f64,
    pub n_particles: usize,
    pub first: usize,
    // Black-hole state
    pub pos: [f64; 3],
    pub vel: [f64; 3],
    pub acc: [f64; 3],
    pub accreted: f64,
    pub sink: f64,
    pub rs: f64,
    // Star CM (recomputed each step)
    pub cm: [f64; 3],
    pub cmv: [f64; 3],
    pub alive_mass: f64,
}

impl Body {
    pub const fn empty() -> Body {
        Body {
            kind: Kind::Star,
            mass: 1.0,
            radius: 1.0,
            gamma: 2.0,
            k_poly: 0.0,
            n_particles: 0,
            first: 0,
            pos: [0.0; 3],
            vel: [0.0; 3],
            acc: [0.0; 3],
            accreted: 0.0,
            sink: 0.0,
            rs: 0.0,
            cm: [0.0; 3],
            cmv: [0.0; 3],
            alive_mass: 0.0,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Params {
    pub c: f64,
    pub alpha: f64,
    pub beta: f64,
    pub gamma_th: f64,
    pub eta_h: f64,
    pub cfl: f64,
    pub pn1: bool,
    pub pn25: bool,
    pub sink_factor: f64,
}

impl Params {
    pub const fn default() -> Params {
        // pn1 is OFF by default: at contact (γ = M/rc² ≈ 0.17 for two neutron
        // stars) the 1PN bracket is 1 − 0.74 — the expansion is not converging
        // there (the exact Schwarzschild factor would be 0.62, the 2PN term
        // would add back +0.18) and the truncated force stalls the merger at
        // the contact radius. It stays available as an experimental toggle for
        // the periastron advance on wide orbits, where γ ≲ 0.05 and it is fine.
        Params { c: 1.0, alpha: 1.0, beta: 2.0, gamma_th: 1.75, eta_h: 1.3, cfl: 0.3, pn1: false, pn25: true, sink_factor: 1.5 }
    }
}

pub struct Sim {
    pub n: usize,
    pub pos: Vec<f64>,
    pub vel: Vec<f64>,
    pub acc: Vec<f64>,
    pub mass: Vec<f64>,
    pub rho: Vec<f64>,
    pub u: Vec<f64>,
    pub du: Vec<f64>,
    pub h: Vec<f64>,
    pub p: Vec<f64>,
    pub cs: Vec<f64>,
    pub phi: Vec<f64>,
    pub star: Vec<u8>,
    pub alive: Vec<u8>,
    pub frame: Vec<f32>, // [x, y, z, log10 rho, u] × MAX_N
    pub bodies: [Body; 2],
    pub params: Params,
    pub time: f64,
    pub dt_last: f64,
    pub steps: u64,
    pub e_gw: f64,
    pub mutual: bool,
    pub pn_weight: f64,
    pub diag: Vec<f64>,
    pub relaxing: bool,
    /// Per-body bulk-PN acceleration from the last evaluation (A, B).
    pub pn_kick: [[f64; 3]; 2],
}

// ── Kernel ──────────────────────────────────────────────────────────────────
/// Cubic spline W(r, h) in 3D, support 2h.
#[inline]
pub fn kernel_w(r: f64, h: f64) -> f64 {
    let q = r / h;
    let sigma = 1.0 / (PI * h * h * h);
    if q < 1.0 {
        sigma * (1.0 - 1.5 * q * q + 0.75 * q * q * q)
    } else if q < 2.0 {
        let t = 2.0 - q;
        sigma * 0.25 * t * t * t
    } else {
        0.0
    }
}

/// dW/dr for the cubic spline.
#[inline]
pub fn kernel_dw(r: f64, h: f64) -> f64 {
    let q = r / h;
    let sigma = 1.0 / (PI * h * h * h * h);
    if q < 1.0 {
        sigma * (-3.0 * q + 2.25 * q * q)
    } else if q < 2.0 {
        let t = 2.0 - q;
        sigma * (-0.75 * t * t)
    } else {
        0.0
    }
}

/// Deterministic LCG for symmetry-breaking jitter.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

impl Sim {
    pub fn new() -> Sim {
        Sim {
            n: 0,
            pos: vec![0.0; MAX_N * 3],
            vel: vec![0.0; MAX_N * 3],
            acc: vec![0.0; MAX_N * 3],
            mass: vec![0.0; MAX_N],
            rho: vec![0.0; MAX_N],
            u: vec![0.0; MAX_N],
            du: vec![0.0; MAX_N],
            h: vec![0.0; MAX_N],
            p: vec![0.0; MAX_N],
            cs: vec![0.0; MAX_N],
            phi: vec![0.0; MAX_N],
            star: vec![0; MAX_N],
            alive: vec![0; MAX_N],
            frame: vec![0.0; MAX_N * 5],
            bodies: [Body::empty(), Body::empty()],
            params: Params::default(),
            time: 0.0,
            dt_last: 0.0,
            steps: 0,
            e_gw: 0.0,
            mutual: true,
            pn_weight: 0.0,
            diag: vec![0.0; DIAG_SLOTS],
            relaxing: false,
            pn_kick: [[0.0; 3]; 2],
        }
    }

    pub fn set_body(&mut self, idx: usize, kind: Kind, mass: f64, radius: f64, gamma: f64) {
        let b = &mut self.bodies[idx];
        b.kind = kind;
        b.mass = mass.max(1e-6);
        b.radius = radius.max(1e-3);
        b.gamma = gamma.max(1.05);
    }

    // ── Initial conditions ──────────────────────────────────────────────────
    /// Place both bodies at rest at the origin (they are separated later by
    /// `set_orbit`). Returns the total particle count.
    pub fn build(&mut self, n_a: usize, n_b: usize, seed: u64) -> usize {
        let mut rng = Lcg(seed.wrapping_mul(2654435761).wrapping_add(12345));
        self.n = 0;
        self.time = 0.0;
        self.steps = 0;
        self.e_gw = 0.0;
        self.mutual = true;
        self.pn_weight = 0.0;
        let targets = [n_a, n_b];
        for idx in 0..2 {
            let mut b = self.bodies[idx];
            b.first = self.n;
            b.n_particles = 0;
            b.accreted = 0.0;
            b.pos = [0.0; 3];
            b.vel = [0.0; 3];
            b.acc = [0.0; 3];
            b.cm = [0.0; 3];
            b.cmv = [0.0; 3];
            if b.kind == Kind::BlackHole {
                let c = self.params.c;
                b.rs = if c > 0.0 { 2.0 * b.mass / (c * c) } else { 0.0 };
                b.sink = if c > 0.0 { self.params.sink_factor * b.rs } else { 0.05 * b.radius.max(1e-3) };
                // radius for display/contact = r_s (or a token size when Newtonian)
                b.radius = if c > 0.0 { b.rs } else { b.radius };
                b.pos = [if idx == 0 { -40.0 * b.radius.max(1.0) } else { 40.0 * b.radius.max(1.0) }, 0.0, 0.0];
                b.alive_mass = b.mass;
                self.bodies[idx] = b;
                continue;
            }
            let want = targets[idx].min(MAX_N - self.n).max(8);
            let poly = Polytrope::new(1.0 / (b.gamma - 1.0));
            let (_rho_c, k) = poly.scalings(b.mass, b.radius);
            b.k_poly = k;
            // Cubic lattice inside a unit sphere with ~want points.
            let n_side = ((6.0 * want as f64 / PI).cbrt()).ceil() as i64;
            let half = n_side as f64 / 2.0;
            let mut pts: Vec<[f64; 3]> = Vec::with_capacity(want * 2);
            for ix in 0..n_side {
                for iy in 0..n_side {
                    for iz in 0..n_side {
                        let x = (ix as f64 + 0.5 - half) / half;
                        let y = (iy as f64 + 0.5 - half) / half;
                        let z = (iz as f64 + 0.5 - half) / half;
                        let jx = x + (rng.next() - 0.5) * 0.2 / half;
                        let jy = y + (rng.next() - 0.5) * 0.2 / half;
                        let jz = z + (rng.next() - 0.5) * 0.2 / half;
                        let r2 = jx * jx + jy * jy + jz * jz;
                        if r2 < 1.0 {
                            pts.push([jx, jy, jz]);
                        }
                    }
                }
            }
            // Keep the `want` innermost points so the count is exact.
            pts.sort_by(|a, b2| {
                let ra = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
                let rb = b2[0] * b2[0] + b2[1] * b2[1] + b2[2] * b2[2];
                ra.partial_cmp(&rb).unwrap()
            });
            pts.truncate(want);
            // Re-rank by radius so the mapping through the enclosed-mass CDF is
            // rank-based (exact equal-mass shells, whatever the lattice did).
            let count = pts.len();
            let mp = b.mass / count as f64;
            let mean_spacing = b.radius * (4.0 / 3.0 * PI / count as f64).cbrt();
            // Park the two bodies apart along x until set_orbit places them.
            let park = if idx == 0 { -4.0 * b.radius } else { 4.0 * b.radius };
            for (rank, pt) in pts.iter().enumerate() {
                let r_lat = (pt[0] * pt[0] + pt[1] * pt[1] + pt[2] * pt[2]).sqrt().max(1e-9);
                let frac = (rank as f64 + 0.5) / count as f64;
                let r_new = b.radius * poly.radius_at_mass_fraction(frac);
                let s = r_new / r_lat;
                let i = self.n;
                self.pos[3 * i] = pt[0] * s + park;
                self.pos[3 * i + 1] = pt[1] * s;
                self.pos[3 * i + 2] = pt[2] * s;
                self.vel[3 * i] = 0.0;
                self.vel[3 * i + 1] = 0.0;
                self.vel[3 * i + 2] = 0.0;
                self.mass[i] = mp;
                self.u[i] = 0.0;
                self.star[i] = idx as u8;
                self.alive[i] = 1;
                // initial h from the local polytrope density
                let theta = poly.theta_at(r_new / b.radius).max(0.02);
                let rho_loc = _rho_c * theta.powf(1.0 / (b.gamma - 1.0));
                self.h[i] = (self.params.eta_h * (mp / rho_loc.max(1e-12)).cbrt()).max(0.3 * mean_spacing).min(b.radius);
                self.rho[i] = rho_loc;
                self.n += 1;
                b.n_particles += 1;
            }
            b.alive_mass = b.mass;
            self.bodies[idx] = b;
        }
        self.compute_density();
        self.compute_density();
        self.n
    }

    /// Relax both stars in isolation (mutual gravity off, no PN) with velocity damping.
    pub fn relax(&mut self, steps: u32, dt_max: f64, damping: f64) {
        self.mutual = false;
        self.relaxing = true;
        for _ in 0..steps {
            self.step(dt_max);
            let d = (1.0 - damping).max(0.0);
            for i in 0..self.n {
                self.vel[3 * i] *= d;
                self.vel[3 * i + 1] *= d;
                self.vel[3 * i + 2] *= d;
                self.u[i] = 0.0; // relaxation is not a shock
            }
        }
        self.relaxing = false;
        self.mutual = true;
        self.time = 0.0;
        self.steps = 0;
        self.e_gw = 0.0;
    }

    /// Put the bodies on an orbit: `sep` is the initial separation (apoapsis
    /// if e > 0), spins are solid-body angular velocities about +z applied to
    /// each star's particles. With PN on and `pn_circ` true, the circular
    /// velocity carries the 1PN correction ω² = M/r³ [1 − (3 − η) M/(rc²)].
    pub fn set_orbit(&mut self, sep: f64, ecc: f64, spin_a: f64, spin_b: f64, pn_circ: bool) {
        let ma = self.bodies[0].mass;
        let mb = self.bodies[1].mass;
        let mt = ma + mb;
        let eta = ma * mb / (mt * mt);
        let e = ecc.max(0.0).min(0.95);
        let mut v_rel = (mt * (1.0 - e) / sep).sqrt();
        if pn_circ && self.params.c > 0.0 && self.params.pn1 && e < 1e-6 {
            // The circular orbit OF THE IMPLEMENTED 1PN FORCE, solved self-
            // consistently: v²/r = (M/r²)[1 + (1+3η)v²/c² − 2(2+η)γ] with
            // γ = M/(rc²) ⇒ v² = (M/r)[1 − 2(2+η)γ]/[1 − (1+3η)γ]. Using the
            // textbook ω² = (M/r³)[1 − (3−η)γ] instead (v² = M/r inside the
            // bracket) starts 3.4 % fast at r = 40 M and gives e ≈ 0.07.
            let gam = mt / (sep * self.params.c * self.params.c);
            let corr = (1.0 - 2.0 * (2.0 + eta) * gam) / (1.0 - (1.0 + 3.0 * eta) * gam);
            v_rel *= corr.max(0.25).sqrt();
        }
        let offs = [[-mb / mt * sep, 0.0, 0.0], [ma / mt * sep, 0.0, 0.0]];
        let vels = [[0.0, -mb / mt * v_rel, 0.0], [0.0, ma / mt * v_rel, 0.0]];
        let spins = [spin_a, spin_b];
        for idx in 0..2 {
            let b = self.bodies[idx];
            if b.kind == Kind::BlackHole {
                self.bodies[idx].pos = offs[idx];
                self.bodies[idx].vel = vels[idx];
                continue;
            }
            // recentre the star on its own CM first
            let (cm, cmv) = self.star_cm(idx);
            for i in b.first..b.first + b.n_particles {
                let x = self.pos[3 * i] - cm[0];
                let y = self.pos[3 * i + 1] - cm[1];
                let z = self.pos[3 * i + 2] - cm[2];
                self.pos[3 * i] = x + offs[idx][0];
                self.pos[3 * i + 1] = y + offs[idx][1];
                self.pos[3 * i + 2] = z + offs[idx][2];
                self.vel[3 * i] = self.vel[3 * i] - cmv[0] + vels[idx][0] - spins[idx] * y;
                self.vel[3 * i + 1] = self.vel[3 * i + 1] - cmv[1] + vels[idx][1] + spins[idx] * x;
                self.vel[3 * i + 2] -= cmv[2];
            }
        }
        self.mutual = true;
        self.time = 0.0;
        self.steps = 0;
        self.e_gw = 0.0;
        self.compute_density();
        self.compute_forces();
        self.update_diagnostics();
    }

    /// Density-weighted centroid (weights m ρ) — the CORE of a body. Before
    /// contact it coincides with the centre of mass; after contact a 5 %
    /// tidal tail flung to hundreds of radii drags the mass-weighted CM out
    /// with it (measured: a merged pair read as "separation 134" and rising),
    /// while the core stays put. Used for the reported separation, the
    /// orbital frequency, and the bulk-PN evaluation and fade.
    pub fn star_core(&self, idx: usize) -> ([f64; 3], [f64; 3]) {
        let b = self.bodies[idx];
        if b.kind == Kind::BlackHole {
            return (b.pos, b.vel);
        }
        let mut wsum = 0.0;
        let mut cm = [0.0; 3];
        let mut cmv = [0.0; 3];
        for i in b.first..b.first + b.n_particles {
            if self.alive[i] == 0 {
                continue;
            }
            let w = self.mass[i] * self.rho[i];
            wsum += w;
            for k in 0..3 {
                cm[k] += w * self.pos[3 * i + k];
                cmv[k] += w * self.vel[3 * i + k];
            }
        }
        if wsum > 0.0 {
            for k in 0..3 {
                cm[k] /= wsum;
                cmv[k] /= wsum;
            }
        }
        (cm, cmv)
    }

    pub fn star_cm(&self, idx: usize) -> ([f64; 3], [f64; 3]) {
        let b = self.bodies[idx];
        if b.kind == Kind::BlackHole {
            return (b.pos, b.vel);
        }
        let mut m = 0.0;
        let mut cm = [0.0; 3];
        let mut cmv = [0.0; 3];
        for i in b.first..b.first + b.n_particles {
            if self.alive[i] == 0 {
                continue;
            }
            let mi = self.mass[i];
            m += mi;
            for k in 0..3 {
                cm[k] += mi * self.pos[3 * i + k];
                cmv[k] += mi * self.vel[3 * i + k];
            }
        }
        if m > 0.0 {
            for k in 0..3 {
                cm[k] /= m;
                cmv[k] /= m;
            }
        }
        (cm, cmv)
    }

    // ── Density ─────────────────────────────────────────────────────────────
    pub fn compute_density(&mut self) {
        let n = self.n;
        for i in 0..n {
            self.rho[i] = 0.0;
        }
        // Gather form with the receiving particle's own h. While the stars are
        // being relaxed in isolation (mutual = false) a particle sees only its
        // own star — otherwise two overlapping bodies feed each other's density
        // with no matching force, and a light body's h collapses onto the
        // heavy one's particles (measured: ρ_max ran away 36×).
        let mutual = self.mutual;
        for i in 0..n {
            if self.alive[i] == 0 {
                continue;
            }
            let hi = self.h[i];
            let xi = self.pos[3 * i];
            let yi = self.pos[3 * i + 1];
            let zi = self.pos[3 * i + 2];
            let r2max = 4.0 * hi * hi;
            let si = self.star[i];
            let mut rho = 0.0;
            for j in 0..n {
                if self.alive[j] == 0 || (!mutual && self.star[j] != si) {
                    continue;
                }
                let dx = xi - self.pos[3 * j];
                let dy = yi - self.pos[3 * j + 1];
                let dz = zi - self.pos[3 * j + 2];
                let r2 = dx * dx + dy * dy + dz * dz;
                if r2 < r2max {
                    rho += self.mass[j] * kernel_w(r2.sqrt(), hi);
                }
            }
            self.rho[i] = rho.max(1e-12);
        }
        // Relax h toward η (m/ρ)^{1/3}, and set the EOS.
        let gth = self.params.gamma_th;
        for i in 0..n {
            if self.alive[i] == 0 {
                continue;
            }
            let target = self.params.eta_h * (self.mass[i] / self.rho[i]).cbrt();
            self.h[i] = 0.5 * self.h[i] + 0.5 * target;
            let b = self.bodies[self.star[i] as usize];
            let rho = self.rho[i];
            let p_cold = b.k_poly * rho.powf(b.gamma);
            let p_th = (gth - 1.0) * rho * self.u[i].max(0.0);
            self.p[i] = p_cold + p_th;
            let cs2 = b.gamma * p_cold / rho + gth * (gth - 1.0) * self.u[i].max(0.0);
            self.cs[i] = cs2.max(0.0).sqrt();
        }
    }

    // ── Forces ──────────────────────────────────────────────────────────────
    pub fn compute_forces(&mut self) {
        let n = self.n;
        for i in 0..n {
            self.acc[3 * i] = 0.0;
            self.acc[3 * i + 1] = 0.0;
            self.acc[3 * i + 2] = 0.0;
            self.du[i] = 0.0;
            self.phi[i] = 0.0;
        }
        let alpha = self.params.alpha;
        let beta = self.params.beta;
        let gth = self.params.gamma_th;
        let mutual = self.mutual;
        for i in 0..n {
            if self.alive[i] == 0 {
                continue;
            }
            let xi = self.pos[3 * i];
            let yi = self.pos[3 * i + 1];
            let zi = self.pos[3 * i + 2];
            let vxi = self.vel[3 * i];
            let vyi = self.vel[3 * i + 1];
            let vzi = self.vel[3 * i + 2];
            let hi = self.h[i];
            let mi = self.mass[i];
            let rhoi = self.rho[i];
            let pi_ = self.p[i];
            let csi = self.cs[i];
            let ui = self.u[i].max(0.0);
            let pth_i = (gth - 1.0) * rhoi * ui;
            let si = self.star[i];
            let (mut axi, mut ayi, mut azi, mut dui, mut phii) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for j in (i + 1)..n {
                if self.alive[j] == 0 {
                    continue;
                }
                let dx = xi - self.pos[3 * j];
                let dy = yi - self.pos[3 * j + 1];
                let dz = zi - self.pos[3 * j + 2];
                let r2 = dx * dx + dy * dy + dz * dz;
                let hj = self.h[j];
                let hij = 0.5 * (hi + hj);
                let mj = self.mass[j];
                let same = si == self.star[j];
                let interact_grav = mutual || same;
                // Gravity (Plummer, ε = pair-mean h)
                if interact_grav {
                    let eps2 = hij * hij;
                    let inv = 1.0 / (r2 + eps2).sqrt();
                    let inv3 = inv * inv * inv;
                    axi -= mj * dx * inv3;
                    ayi -= mj * dy * inv3;
                    azi -= mj * dz * inv3;
                    self.acc[3 * j] += mi * dx * inv3;
                    self.acc[3 * j + 1] += mi * dy * inv3;
                    self.acc[3 * j + 2] += mi * dz * inv3;
                    phii -= mj * inv;
                    self.phi[j] -= mi * inv;
                }
                // SPH (only when the pair is within the support)
                if (interact_grav || same) && r2 < 4.0 * hij * hij {
                    let r = r2.sqrt().max(1e-12);
                    let dw = kernel_dw(r, hij) / r; // ∇W = dw · (dx,dy,dz)
                    let rhoj = self.rho[j];
                    let pj = self.p[j];
                    let dvx = vxi - self.vel[3 * j];
                    let dvy = vyi - self.vel[3 * j + 1];
                    let dvz = vzi - self.vel[3 * j + 2];
                    let vdotr = dvx * dx + dvy * dy + dvz * dz;
                    let mut visc = 0.0;
                    if vdotr < 0.0 {
                        let mu = hij * vdotr / (r2 + 0.01 * hij * hij);
                        let cij = 0.5 * (csi + self.cs[j]);
                        let rhoij = 0.5 * (rhoi + rhoj);
                        visc = (-alpha * cij * mu + beta * mu * mu) / rhoij;
                    }
                    let fac = pi_ / (rhoi * rhoi) + pj / (rhoj * rhoj) + visc;
                    axi -= mj * fac * dw * dx;
                    ayi -= mj * fac * dw * dy;
                    azi -= mj * fac * dw * dz;
                    self.acc[3 * j] += mi * fac * dw * dx;
                    self.acc[3 * j + 1] += mi * fac * dw * dy;
                    self.acc[3 * j + 2] += mi * fac * dw * dz;
                    // Thermal energy: thermal pressure work + viscous heating
                    let uj = self.u[j].max(0.0);
                    let pth_j = (gth - 1.0) * rhoj * uj;
                    dui += mj * (pth_i / (rhoi * rhoi) + 0.5 * visc) * dw * vdotr;
                    self.du[j] += mi * (pth_j / (rhoj * rhoj) + 0.5 * visc) * dw * vdotr;
                }
            }
            self.acc[3 * i] += axi;
            self.acc[3 * i + 1] += ayi;
            self.acc[3 * i + 2] += azi;
            self.du[i] += dui;
            self.phi[i] += phii;
        }
        // Black holes: point masses in Paczyński–Wiita potentials.
        let c = self.params.c;
        for idx in 0..2 {
            let b = self.bodies[idx];
            self.bodies[idx].acc = [0.0; 3];
            if b.kind != Kind::BlackHole {
                continue;
            }
            let rs = b.rs;
            let mut abh = [0.0; 3];
            for i in 0..n {
                if self.alive[i] == 0 {
                    continue;
                }
                if !mutual && self.star[i] as usize != idx {
                    continue;
                }
                let dx = self.pos[3 * i] - b.pos[0];
                let dy = self.pos[3 * i + 1] - b.pos[1];
                let dz = self.pos[3 * i + 2] - b.pos[2];
                let r = (dx * dx + dy * dy + dz * dz).sqrt();
                let reff = if c > 0.0 { (r - rs).max(0.25 * rs) } else { (r * r + 0.01 * b.radius * b.radius).sqrt() };
                let a = -b.mass / (reff * reff) / r.max(1e-12);
                self.acc[3 * i] += a * dx;
                self.acc[3 * i + 1] += a * dy;
                self.acc[3 * i + 2] += a * dz;
                self.phi[i] -= b.mass / reff;
                let mi = self.mass[i];
                abh[0] -= mi * a * dx / b.mass;
                abh[1] -= mi * a * dy / b.mass;
                abh[2] -= mi * a * dz / b.mass;
            }
            // BH–BH Newtonian
            let other = self.bodies[1 - idx];
            if other.kind == Kind::BlackHole && mutual {
                let dx = b.pos[0] - other.pos[0];
                let dy = b.pos[1] - other.pos[1];
                let dz = b.pos[2] - other.pos[2];
                let r = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-9);
                let a = -other.mass / (r * r * r);
                abh[0] += a * dx;
                abh[1] += a * dy;
                abh[2] += a * dz;
            }
            self.bodies[idx].acc = abh;
        }
        // Bulk post-Newtonian corrections on the two cores.
        self.pn_weight = 0.0;
        self.pn_kick = [[0.0; 3]; 2];
        self.diag[31] = 0.0;
        if c > 0.0 && mutual && (self.params.pn1 || self.params.pn25) {
            let kicks = self.bulk_pn_kicks();
            self.add_pn_kicks(kicks, 1.0, true);
            self.pn_kick = kicks;
        }
    }

    /// Add `scale × kicks` to the accelerations (to_acc) — or to the
    /// velocities when to_acc is false (the integrator's correction pass).
    fn add_pn_kicks(&mut self, kicks: [[f64; 3]; 2], scale: f64, to_acc: bool) {
        for idx in 0..2 {
            let k = kicks[idx];
            if k[0] == 0.0 && k[1] == 0.0 && k[2] == 0.0 {
                continue;
            }
            let b = self.bodies[idx];
            if b.kind == Kind::BlackHole {
                for d in 0..3 {
                    if to_acc {
                        self.bodies[idx].acc[d] += scale * k[d];
                    } else {
                        self.bodies[idx].vel[d] += scale * k[d];
                    }
                }
            } else {
                for i in b.first..b.first + b.n_particles {
                    if self.alive[i] == 0 {
                        continue;
                    }
                    for d in 0..3 {
                        if to_acc {
                            self.acc[3 * i + d] += scale * k[d];
                        } else {
                            self.vel[3 * i + d] += scale * k[d];
                        }
                    }
                }
            }
        }
    }

    /// The per-body bulk-PN accelerations for the CURRENT positions and
    /// velocities. Also sets pn_weight and the RR power (diag[31]).
    fn bulk_pn_kicks(&mut self) -> [[f64; 3]; 2] {
        let zero = [[0.0; 3]; 2];
        let c = self.params.c;
        let (cma, va) = self.star_core(0);
        let (cmb, vb) = self.star_core(1);
        let ma = if self.bodies[0].kind == Kind::BlackHole { self.bodies[0].mass } else { self.bodies[0].alive_mass };
        let mb = if self.bodies[1].kind == Kind::BlackHole { self.bodies[1].mass } else { self.bodies[1].alive_mass };
        if ma <= 0.0 || mb <= 0.0 {
            return zero;
        }
        let mt = ma + mb;
        let eta = ma * mb / (mt * mt);
        let dx = [cma[0] - cmb[0], cma[1] - cmb[1], cma[2] - cmb[2]];
        let dv = [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
        let r = (dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]).sqrt();
        if r < 1e-9 {
            return zero;
        }
        let nvec = [dx[0] / r, dx[1] / r, dx[2] / r];
        let v2 = dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2];
        let rdot = nvec[0] * dv[0] + nvec[1] * dv[1] + nvec[2] * dv[2];
        // Fade as the bodies overlap: full weight down to contact (R_A + R_B),
        // zero at half that — two overlapping stars have no meaningful pair of
        // centres for a two-body formula to act on. Two point black holes
        // keep full weight (their "contact" is the horizons touching, which
        // the page treats as the merger).
        let rsum = self.bodies[0].radius + self.bodies[1].radius;
        let both_bh = self.bodies[0].kind == Kind::BlackHole && self.bodies[1].kind == Kind::BlackHole;
        let w = if both_bh { 1.0 } else { ((r - 0.5 * rsum) / (0.5 * rsum)).max(0.0).min(1.0) };
        self.pn_weight = w;
        if w <= 0.0 {
            return zero;
        }
        let m_over_r = mt / r;
        let pref = mt / (r * r);
        let mut a_rel = [0.0; 3];
        if self.params.pn1 {
            let a1 = -3.0 * rdot * rdot * eta / 2.0 + v2 * (1.0 + 3.0 * eta) - 2.0 * (2.0 + eta) * m_over_r;
            let b1 = -2.0 * rdot * (2.0 - eta);
            let inv_c2 = 1.0 / (c * c);
            for k in 0..3 {
                a_rel[k] += -pref * inv_c2 * (a1 * nvec[k] + b1 * dv[k]);
            }
        }
        let mut a_rr = [0.0; 3];
        if self.params.pn25 {
            let inv_c5 = 1.0 / (c * c * c * c * c);
            let f = 8.0 / 5.0 * eta * pref * m_over_r * inv_c5;
            for k in 0..3 {
                a_rr[k] = f * (rdot * nvec[k] * (3.0 * v2 + 17.0 / 3.0 * m_over_r) - dv[k] * (v2 + 3.0 * m_over_r));
                a_rel[k] += a_rr[k];
            }
        }
        // Work done by the reaction force on the relative motion → E_gw (positive = radiated).
        let mu = ma * mb / mt;
        let power = -(a_rr[0] * dv[0] + a_rr[1] * dv[1] + a_rr[2] * dv[2]) * mu * w;
        self.diag[31] = power;
        // Distribute: a_A = (m_B/M) a_rel, a_B = −(m_A/M) a_rel.
        let fa = mb / mt * w;
        let fb = -ma / mt * w;
        [[fa * a_rel[0], fa * a_rel[1], fa * a_rel[2]], [fb * a_rel[0], fb * a_rel[1], fb * a_rel[2]]]
    }

    // ── Time step ───────────────────────────────────────────────────────────
    pub fn timestep(&self, dt_max: f64) -> f64 {
        let mut dt = dt_max;
        for i in 0..self.n {
            if self.alive[i] == 0 {
                continue;
            }
            let v = (self.vel[3 * i].powi(2) + self.vel[3 * i + 1].powi(2) + self.vel[3 * i + 2].powi(2)).sqrt();
            let a = (self.acc[3 * i].powi(2) + self.acc[3 * i + 1].powi(2) + self.acc[3 * i + 2].powi(2)).sqrt();
            let h = self.h[i];
            let dt_c = self.params.cfl * h / (self.cs[i] + v + 1e-12);
            let dt_a = self.params.cfl * (h / (a + 1e-12)).sqrt();
            dt = dt.min(dt_c).min(dt_a);
        }
        for b in self.bodies.iter() {
            if b.kind == Kind::BlackHole {
                let a = (b.acc[0].powi(2) + b.acc[1].powi(2) + b.acc[2].powi(2)).sqrt();
                let scale = b.sink.max(1e-3);
                dt = dt.min(self.params.cfl * (scale / (a + 1e-12)).sqrt());
            }
        }
        dt.max(1e-7)
    }

    /// One KDK leapfrog step of length ≤ dt_max. Returns the dt used.
    pub fn step(&mut self, dt_max: f64) -> f64 {
        if self.steps == 0 && self.time == 0.0 {
            self.compute_density();
            self.compute_forces();
        }
        let dt = self.timestep(dt_max);
        let n = self.n;
        let half = 0.5 * dt;
        // kick + drift
        for i in 0..n {
            if self.alive[i] == 0 {
                continue;
            }
            for k in 0..3 {
                self.vel[3 * i + k] += half * self.acc[3 * i + k];
                self.pos[3 * i + k] += dt * self.vel[3 * i + k];
            }
            self.u[i] = (self.u[i] + half * self.du[i]).max(0.0);
        }
        for b in self.bodies.iter_mut() {
            if b.kind == Kind::BlackHole {
                for k in 0..3 {
                    b.vel[k] += half * b.acc[k];
                    b.pos[k] += dt * b.vel[k];
                }
            }
        }
        self.accrete();
        self.compute_density();
        self.compute_forces();
        for i in 0..n {
            if self.alive[i] == 0 {
                continue;
            }
            for k in 0..3 {
                self.vel[3 * i + k] += half * self.acc[3 * i + k];
            }
            self.u[i] = (self.u[i] + half * self.du[i]).max(0.0);
        }
        for b in self.bodies.iter_mut() {
            if b.kind == Kind::BlackHole {
                for k in 0..3 {
                    b.vel[k] += half * b.acc[k];
                }
            }
        }
        // The bulk-PN acceleration depends on VELOCITY (v², ṙ, and the whole
        // 2.5PN term), and a kick-drift-kick leapfrog evaluates it at the
        // half-step velocity — first-order in that part, which measured as a
        // 7.6 % energy loss over four circular 1PN orbits at 500 steps each.
        // Two fixed-point iterations re-evaluate the PN kick at the full-step
        // velocity and correct the second half-kick, making it effectively
        // implicit. The hydro and gravity accelerations are untouched.
        if self.pn_weight > 0.0 || (self.params.c > 0.0 && self.mutual && (self.params.pn1 || self.params.pn25)) {
            for _ in 0..2 {
                let old = self.pn_kick;
                let new = self.bulk_pn_kicks();
                let mut delta = [[0.0; 3]; 2];
                let mut any = false;
                for idx in 0..2 {
                    for d in 0..3 {
                        delta[idx][d] = new[idx][d] - old[idx][d];
                        if delta[idx][d] != 0.0 {
                            any = true;
                        }
                    }
                }
                if !any {
                    break;
                }
                self.add_pn_kicks(delta, half, false); // correct v₁
                self.add_pn_kicks(delta, 1.0, true); // and the acceleration the next step starts from
                self.pn_kick = new;
            }
        }
        self.time += dt;
        self.steps += 1;
        self.dt_last = dt;
        self.e_gw += self.diag[31] * dt;
        dt
    }

    /// Particles inside a black hole's sink are absorbed (mass + momentum conserved).
    fn accrete(&mut self) {
        for idx in 0..2 {
            let mut b = self.bodies[idx];
            if b.kind != Kind::BlackHole || !self.mutual {
                continue;
            }
            let sink2 = b.sink * b.sink;
            let mut dm = 0.0;
            let mut dp = [0.0; 3];
            for i in 0..self.n {
                if self.alive[i] == 0 {
                    continue;
                }
                let dx = self.pos[3 * i] - b.pos[0];
                let dy = self.pos[3 * i + 1] - b.pos[1];
                let dz = self.pos[3 * i + 2] - b.pos[2];
                if dx * dx + dy * dy + dz * dz < sink2 {
                    let mi = self.mass[i];
                    dm += mi;
                    for k in 0..3 {
                        dp[k] += mi * self.vel[3 * i + k];
                    }
                    self.alive[i] = 0;
                    let s = self.star[i] as usize;
                    self.bodies[s].alive_mass -= mi;
                }
            }
            if dm > 0.0 {
                let mnew = b.mass + dm;
                for k in 0..3 {
                    b.vel[k] = (b.mass * b.vel[k] + dp[k]) / mnew;
                }
                b.mass = mnew;
                b.accreted += dm;
                let c = self.params.c;
                if c > 0.0 {
                    b.rs = 2.0 * b.mass / (c * c);
                    b.sink = self.params.sink_factor * b.rs;
                    b.radius = b.rs;
                }
                b.alive_mass = b.mass;
                // The other body's alive_mass was decremented above; the BH's own
                // bookkeeping is its mass.
                let other = 1 - idx;
                self.bodies[idx] = b;
                let _ = other;
            } else {
                self.bodies[idx] = b;
            }
        }
    }

    /// Advance by up to `dt_total` in at most `max_steps` substeps. Returns steps taken.
    pub fn advance(&mut self, dt_total: f64, max_steps: u32, dt_max: f64) -> u32 {
        let target = self.time + dt_total;
        let mut steps = 0;
        while self.time < target && steps < max_steps {
            let remaining = target - self.time;
            self.step(dt_max.min(remaining.max(1e-9)));
            steps += 1;
        }
        self.update_diagnostics();
        steps
    }

    // ── Diagnostics ─────────────────────────────────────────────────────────
    pub fn update_diagnostics(&mut self) {
        let n = self.n;
        let mut ekin = 0.0;
        let mut eth = 0.0;
        let mut epot = 0.0;
        let mut lz = 0.0;
        let mut rho_max = 0.0;
        let mut p_max = 0.0;
        let mut u_max = 0.0;
        let mut m_unbound = 0.0;
        let mut n_alive = 0usize;
        // Quadrupole second derivative: Σ m (2 v_i v_j + x_i a_j + x_j a_i), trace removed.
        let mut q = [0.0f64; 6]; // xx yy zz xy xz yz
        let mut trace = 0.0;
        let add_q = |q: &mut [f64; 6], trace: &mut f64, m: f64, x: &[f64], v: &[f64], a: &[f64]| {
            let t = 2.0 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) + 2.0 * (x[0] * a[0] + x[1] * a[1] + x[2] * a[2]);
            *trace += m * t;
            q[0] += m * (2.0 * v[0] * v[0] + 2.0 * x[0] * a[0]);
            q[1] += m * (2.0 * v[1] * v[1] + 2.0 * x[1] * a[1]);
            q[2] += m * (2.0 * v[2] * v[2] + 2.0 * x[2] * a[2]);
            q[3] += m * (2.0 * v[0] * v[1] + x[0] * a[1] + x[1] * a[0]);
            q[4] += m * (2.0 * v[0] * v[2] + x[0] * a[2] + x[2] * a[0]);
            q[5] += m * (2.0 * v[1] * v[2] + x[1] * a[2] + x[2] * a[1]);
        };
        for i in 0..n {
            if self.alive[i] == 0 {
                continue;
            }
            n_alive += 1;
            let m = self.mass[i];
            let x = &self.pos[3 * i..3 * i + 3];
            let v = &self.vel[3 * i..3 * i + 3];
            let a = &self.acc[3 * i..3 * i + 3];
            let v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
            ekin += 0.5 * m * v2;
            eth += m * self.u[i];
            epot += 0.5 * m * self.phi[i];
            lz += m * (x[0] * v[1] - x[1] * v[0]);
            if self.rho[i] > rho_max {
                rho_max = self.rho[i];
            }
            if self.p[i] > p_max {
                p_max = self.p[i];
            }
            if self.u[i] > u_max {
                u_max = self.u[i];
            }
            if 0.5 * v2 + self.phi[i] + self.u[i] > 0.0 {
                m_unbound += m;
            }
            add_q(&mut q, &mut trace, m, x, v, a);
        }
        for b in self.bodies.iter() {
            if b.kind == Kind::BlackHole {
                let v2 = b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1] + b.vel[2] * b.vel[2];
                ekin += 0.5 * b.mass * v2;
                lz += b.mass * (b.pos[0] * b.vel[1] - b.pos[1] * b.vel[0]);
                add_q(&mut q, &mut trace, b.mass, &b.pos, &b.vel, &b.acc);
            }
        }
        // BH–BH potential + BH–particle potential is folded into phi for particles
        // (particle side) — add the BH-side halves.
        for idx in 0..2 {
            let b = self.bodies[idx];
            if b.kind != Kind::BlackHole {
                continue;
            }
            for i in 0..n {
                if self.alive[i] == 0 {
                    continue;
                }
                let dx = self.pos[3 * i] - b.pos[0];
                let dy = self.pos[3 * i + 1] - b.pos[1];
                let dz = self.pos[3 * i + 2] - b.pos[2];
                let r = (dx * dx + dy * dy + dz * dz).sqrt();
                let reff = if self.params.c > 0.0 { (r - b.rs).max(0.25 * b.rs) } else { (r * r + 0.01 * b.radius * b.radius).sqrt() };
                epot -= 0.5 * self.mass[i] * b.mass / reff;
            }
            let other = self.bodies[1 - idx];
            if other.kind == Kind::BlackHole && idx == 0 {
                let dx = b.pos[0] - other.pos[0];
                let dy = b.pos[1] - other.pos[1];
                let dz = b.pos[2] - other.pos[2];
                epot -= b.mass * other.mass / (dx * dx + dy * dy + dz * dz).sqrt().max(1e-9);
            }
        }
        for k in 0..3 {
            q[k] -= trace / 3.0;
        }
        let (cma, va) = self.star_core(0);
        let (cmb, vb) = self.star_core(1);
        self.bodies[0].cm = cma;
        self.bodies[0].cmv = va;
        self.bodies[1].cm = cmb;
        self.bodies[1].cmv = vb;
        let dx = [cma[0] - cmb[0], cma[1] - cmb[1], cma[2] - cmb[2]];
        let dv = [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
        let sep = (dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]).sqrt();
        let vrel = (dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]).sqrt();
        let lrel = dx[0] * dv[1] - dx[1] * dv[0];
        let omega = if sep > 1e-9 { lrel / (sep * sep) } else { 0.0 };
        let d = &mut self.diag;
        d[0] = self.time;
        d[1] = self.dt_last;
        d[2] = n_alive as f64;
        d[3] = sep;
        d[4] = ekin;
        d[5] = eth;
        d[6] = epot;
        d[7] = ekin + eth + epot;
        d[8] = lz;
        d[9] = rho_max;
        d[10] = m_unbound;
        d[11] = self.bodies[0].accreted;
        d[12] = self.bodies[1].accreted;
        d[13] = q[0];
        d[14] = q[1];
        d[15] = q[2];
        d[16] = q[3];
        d[17] = q[4];
        d[18] = q[5];
        d[19] = vrel;
        d[20] = cma[0];
        d[21] = cma[1];
        d[22] = cma[2];
        d[23] = cmb[0];
        d[24] = cmb[1];
        d[25] = cmb[2];
        d[26] = self.steps as f64;
        d[27] = p_max;
        d[28] = u_max;
        d[29] = omega;
        d[30] = self.pn_weight;
        // d[31] = instantaneous RR power (set in apply_bulk_pn)
        d[32] = self.e_gw;
        d[33] = self.bodies[0].alive_mass;
        d[34] = self.bodies[1].alive_mass;
        d[35] = self.bodies[0].mass;
        d[36] = self.bodies[1].mass;
        d[37] = self.bodies[0].rs;
        d[38] = self.bodies[1].rs;
        d[39] = n as f64;
    }

    /// Pack a render frame: [x, y, z, log10 ρ, u] per particle (dead particles get NaN x).
    pub fn pack_frame(&mut self) {
        for i in 0..self.n {
            let o = 5 * i;
            if self.alive[i] == 0 {
                self.frame[o] = f32::NAN;
                self.frame[o + 1] = 0.0;
                self.frame[o + 2] = 0.0;
                self.frame[o + 3] = 0.0;
                self.frame[o + 4] = 0.0;
                continue;
            }
            self.frame[o] = self.pos[3 * i] as f32;
            self.frame[o + 1] = self.pos[3 * i + 1] as f32;
            self.frame[o + 2] = self.pos[3 * i + 2] as f32;
            self.frame[o + 3] = self.rho[i].max(1e-30).log10() as f32;
            self.frame[o + 4] = self.u[i] as f32;
        }
    }
}
