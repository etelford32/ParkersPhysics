//! The physics gate for the merger engine. `cargo test` in rust-star-collider/
//! before shipping anything to the page.
//!
//! Units: G = 1, M☉, G M☉/c² (so c = 1 for the neutron-star cases).

use star_collider_kernel::sph::{kernel_dw, kernel_w, Kind, Sim};
use std::f64::consts::PI;

const PI_: f64 = PI;

/// ∫ W d³x = 1 and the gradient is the derivative of W.
#[test]
fn kernel_normalised() {
    let h = 1.3;
    let n = 4000;
    let rmax = 2.0 * h;
    let dr = rmax / n as f64;
    let mut integral = 0.0;
    for i in 0..n {
        let r = (i as f64 + 0.5) * dr;
        integral += 4.0 * PI_ * r * r * kernel_w(r, h) * dr;
    }
    assert!((integral - 1.0).abs() < 1e-3, "∫W = {}", integral);
    for &r in &[0.3, 0.9, 1.2, 1.9] {
        let eps = 1e-6;
        let fd = (kernel_w(r + eps, h) - kernel_w(r - eps, h)) / (2.0 * eps);
        assert!((fd - kernel_dw(r, h)).abs() < 1e-5 * kernel_dw(r, h).abs().max(1e-3), "dW at {}", r);
    }
    assert_eq!(kernel_w(2.5 * h, h), 0.0);
}

fn two_stars(n: usize, c: f64) -> Sim {
    let mut s = Sim::new();
    s.params.c = c;
    s.set_body(0, Kind::Star, 1.4, 8.0, 2.0);
    s.set_body(1, Kind::Star, 1.4, 8.0, 2.0);
    s.build(n, n, 7);
    s
}

/// A relaxed n = 1 polytrope keeps its radius and central density to SPH accuracy.
#[test]
fn relaxed_polytrope_is_in_equilibrium() {
    let mut s = Sim::new();
    s.params.c = 0.0;
    s.set_body(0, Kind::Star, 1.4, 8.0, 2.0);
    s.set_body(1, Kind::Star, 1.4, 8.0, 2.0);
    let n = s.build(600, 100, 3);
    assert!(n >= 700);
    s.relax(150, 0.5, 0.05);
    s.update_diagnostics();
    // The half-mass radius of an n=1 polytrope is 0.60 R.
    let b = s.bodies[0];
    let mut radii: Vec<f64> = (b.first..b.first + b.n_particles)
        .map(|i| {
            let x = s.pos[3 * i] - b.cm[0];
            let y = s.pos[3 * i + 1] - b.cm[1];
            let z = s.pos[3 * i + 2] - b.cm[2];
            (x * x + y * y + z * z).sqrt()
        })
        .collect();
    radii.sort_by(|a, b2| a.partial_cmp(b2).unwrap());
    let r_half = radii[radii.len() / 2];
    assert!((r_half / 8.0 - 0.60).abs() < 0.12, "r_half/R = {}", r_half / 8.0);
    // Central density: ρ_c = πM/(4R³) for n = 1 → 1.4π/(4·512) = 0.00215.
    let rho_c_exact = PI_ * 1.4 / (4.0 * 512.0);
    let rho_max = s.diag[9];
    assert!((rho_max / rho_c_exact - 1.0).abs() < 0.35, "ρ_max/ρ_c = {}", rho_max / rho_c_exact);
    // Virial: 2K + W ≈ 0 with K the thermal (cold) energy — check that the
    // kinetic energy after relaxation is tiny relative to |W|.
    let ekin = s.diag[4];
    let epot = s.diag[6];
    assert!(ekin < 0.02 * epot.abs(), "E_kin/|W| = {}", ekin / epot.abs());
}

/// Momentum is conserved exactly by construction; energy to leapfrog accuracy.
#[test]
fn conservation_in_a_newtonian_orbit() {
    let mut s = two_stars(300, 0.0);
    s.relax(80, 0.5, 0.05);
    s.set_orbit(40.0, 0.0, 0.0, 0.0, false);
    s.update_diagnostics();
    let e0 = s.diag[7];
    let lz0 = s.diag[8];
    let mut px = 0.0;
    let mut steps = 0;
    while s.time < 300.0 {
        s.step(0.5);
        steps += 1;
    }
    s.update_diagnostics();
    for i in 0..s.n {
        px += s.mass[i] * s.vel[3 * i];
    }
    assert!(px.abs() < 1e-10, "Σ m v_x = {}", px);
    let e1 = s.diag[7];
    let lz1 = s.diag[8];
    assert!(((e1 - e0) / e0).abs() < 0.02, "ΔE/E = {} over {} steps", (e1 - e0) / e0, steps);
    assert!(((lz1 - lz0) / lz0).abs() < 1e-3, "ΔL/L = {}", (lz1 - lz0) / lz0);
    // Separation stays near 40 (circular orbit) without PN.
    assert!((s.diag[3] - 40.0).abs() < 4.0, "separation = {}", s.diag[3]);
}

/// Two point-mass black holes with 2.5PN: the orbit decays at Peters' rate.
#[test]
fn radiation_reaction_matches_peters() {
    let mut s = Sim::new();
    s.params.c = 1.0;
    s.params.pn1 = false;
    s.params.pn25 = true;
    s.set_body(0, Kind::BlackHole, 1.4, 1.0, 2.0);
    s.set_body(1, Kind::BlackHole, 1.4, 1.0, 2.0);
    s.build(0, 0, 1);
    let a0 = 60.0;
    s.set_orbit(a0, 0.0, 0.0, 0.0, false);
    let mt: f64 = 2.8;
    let eta: f64 = 0.25;
    let peters = -(64.0 / 5.0) * eta * mt.powi(3) / a0.powi(3); // da/dt
    let period = 2.0 * PI_ * (a0.powi(3) / mt).sqrt();
    let t_end = 3.0 * period;
    let mut sum_sep = 0.0;
    let mut count = 0;
    // orbit-average the separation over the first and last orbit
    let mut first = 0.0;
    let mut nfirst = 0;
    while s.time < t_end {
        s.step(period / 400.0);
        s.update_diagnostics();
        if s.time < period {
            first += s.diag[3];
            nfirst += 1;
        }
        if s.time > t_end - period {
            sum_sep += s.diag[3];
            count += 1;
        }
    }
    let a_first = first / nfirst as f64;
    let a_last = sum_sep / count as f64;
    let measured = (a_last - a_first) / (2.0 * period);
    assert!(
        ((measured - peters) / peters).abs() < 0.25,
        "da/dt measured {} vs Peters {}",
        measured,
        peters
    );
    // Energy radiated is positive and matches the binding-energy change. E_gw
    // accumulates over the whole 3T run; the orbit-averaged separations are
    // centred on the first and last orbit, i.e. 2T apart — hence the 2/3.
    let e_gw = s.diag[32];
    assert!(e_gw > 0.0, "E_gw = {}", e_gw);
    let de_binding = 0.5 * 1.4 * 1.4 * (1.0 / a_last - 1.0 / a_first); // μM/2 (1/a₁ − 1/a₀) with μM = 1.96
    assert!(((2.0 / 3.0 * e_gw - de_binding) / de_binding).abs() < 0.3, "⅔E_gw {} vs ΔE_bind {}", 2.0 / 3.0 * e_gw, de_binding);
    // And the Peters luminosity itself: (32/5) η² M⁵/a⁵ × 3T.
    let lum = 32.0 / 5.0 * eta * eta * mt.powi(5) / a0.powi(5);
    assert!(((e_gw - lum * t_end) / (lum * t_end)).abs() < 0.2, "E_gw {} vs Peters {}", e_gw, lum * t_end);
}

/// The 1PN term makes a circular orbit precess but not decay.
#[test]
fn one_pn_conserves_energy() {
    let mut s = Sim::new();
    s.params.c = 1.0;
    s.params.pn1 = true;
    s.params.pn25 = false;
    s.set_body(0, Kind::BlackHole, 1.4, 1.0, 2.0);
    s.set_body(1, Kind::BlackHole, 1.4, 1.0, 2.0);
    s.build(0, 0, 1);
    s.set_orbit(40.0, 0.0, 0.0, 0.0, true);
    s.update_diagnostics();
    let sep0 = s.diag[3];
    let period = 2.0 * PI_ * (40.0f64.powi(3) / 2.8).sqrt();
    let mut smin = f64::MAX;
    let mut smax = 0.0f64;
    while s.time < 4.0 * period {
        s.step(period / 500.0);
        s.update_diagnostics();
        smin = smin.min(s.diag[3]);
        smax = smax.max(s.diag[3]);
    }
    assert!((smax - smin) / sep0 < 0.05, "1PN circular orbit wobbles {} → {}", smin, smax);
}

/// A black hole eats a star that is dropped onto it.
#[test]
fn black_hole_accretes() {
    let mut s = Sim::new();
    s.params.c = 1.0;
    s.params.pn1 = false;
    s.params.pn25 = false;
    s.set_body(0, Kind::BlackHole, 5.0, 1.0, 2.0);
    s.set_body(1, Kind::Star, 1.4, 8.0, 2.0);
    s.build(0, 300, 5);
    s.relax(60, 0.5, 0.05);
    // Head-on: zero angular momentum at 60 units.
    s.set_orbit(60.0, 0.0, 0.0, 0.0, false);
    // kill the orbital velocity → radial plunge
    for i in 0..s.n {
        s.vel[3 * i] = 0.0;
        s.vel[3 * i + 1] = 0.0;
        s.vel[3 * i + 2] = 0.0;
    }
    s.bodies[0].vel = [0.0; 3];
    let mut steps = 0;
    while s.time < 900.0 && steps < 20000 {
        s.step(1.0);
        steps += 1;
    }
    s.update_diagnostics();
    assert!(s.bodies[0].accreted > 0.7, "accreted {} of 1.4", s.bodies[0].accreted);
    assert!(s.bodies[0].mass > 5.7, "BH mass {}", s.bodies[0].mass);
    assert!(s.diag[2] < 0.5 * 300.0, "alive {}", s.diag[2]);
}

/// A close NS–NS pair with PN on actually merges: separation collapses,
/// shock heating appears, the quadrupole signal chirps.
#[test]
fn neutron_stars_merge() {
    let mut s = two_stars(250, 1.0);
    s.params.pn1 = false;
    s.params.pn25 = true;
    s.relax(80, 0.5, 0.05);
    s.set_orbit(28.0, 0.0, 0.0, 0.0, true);
    s.update_diagnostics();
    let period = 2.0 * PI_ * (28.0f64.powi(3) / 2.8).sqrt();
    let mut q_amp_early: f64 = 0.0;
    let mut q_amp_late: f64 = 0.0;
    let mut steps = 0;
    let t_end = 6.0 * period;
    while s.time < t_end && steps < 60000 {
        s.step(1.0);
        steps += 1;
        if steps % 20 == 0 {
            s.update_diagnostics();
            let amp = (s.diag[13] - s.diag[14]).abs();
            if s.time < 0.5 * period {
                q_amp_early = q_amp_early.max(amp);
            }
            // The quadrupole peaks around contact (r ≈ R_A + R_B = 16), not
            // after the cores have merged into a slowly turning bar.
            if s.diag[3] < 20.0 {
                q_amp_late = q_amp_late.max(amp);
            }
        }
    }
    s.update_diagnostics();
    assert!(s.diag[3] < 14.0, "stars did not merge: separation {} after {} steps", s.diag[3], steps);
    assert!(s.diag[28] > 0.0, "no shock heating");
    assert!(q_amp_late > q_amp_early, "quadrupole did not grow: {} → {}", q_amp_early, q_amp_late);
    assert!(s.diag[32] > 0.0, "no GW energy accounted");
    // Frame packing works and has no NaNs for live particles.
    s.pack_frame();
    let alive = s.diag[2] as usize;
    assert!(alive > 400);
    assert!(s.frame[0].is_finite());
}
