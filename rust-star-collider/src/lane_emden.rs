//! Lane–Emden polytropes — the initial stellar profiles.
//!
//!   θ'' + (2/ξ) θ' + θⁿ = 0,   θ(0) = 1, θ'(0) = 0
//!
//! integrated by RK4 from the series start θ ≈ 1 − ξ²/6 until θ crosses
//! zero at ξ₁. The density is ρ = ρ_c θⁿ and the enclosed mass fraction
//! m(ξ)/M = ξ²θ'(ξ) / ξ₁²θ'(ξ₁), which is what the particle placer needs.
//! n = 1 (Γ = 2) has the closed form θ = sin ξ / ξ, ξ₁ = π — the test.
//!
//! Physical scalings (G = 1) for a star of mass M and radius R:
//!   α = R/ξ₁,   ω_n = −ξ₁² θ'(ξ₁),   ρ_c = M / (4π α³ ω_n),
//!   K = 4π α² ρ_c^{1 − 1/n} / (n + 1).

pub struct Polytrope {
    pub n: f64,
    pub xi: Vec<f64>,
    pub theta: Vec<f64>,
    pub mfrac: Vec<f64>, // enclosed mass fraction at each xi
    pub xi1: f64,
    pub omega_n: f64,
}

impl Polytrope {
    pub fn new(n: f64) -> Polytrope {
        let n = n.max(0.0);
        let mut xi = 1e-3_f64;
        let mut th = 1.0 - xi * xi / 6.0;
        let mut dth = -xi / 3.0;
        let h = 2e-3_f64;
        let mut xs = vec![0.0];
        let mut ts = vec![1.0];
        let mut ms = vec![0.0];
        let f = |x: f64, t: f64, dt: f64| -> (f64, f64) {
            let tn = if t > 0.0 { t.powf(n) } else { 0.0 };
            (dt, -2.0 * dt / x - tn)
        };
        let mut xi1 = 0.0;
        let mut dth1 = dth;
        for _ in 0..200_000 {
            let (k1t, k1d) = f(xi, th, dth);
            let (k2t, k2d) = f(xi + 0.5 * h, th + 0.5 * h * k1t, dth + 0.5 * h * k1d);
            let (k3t, k3d) = f(xi + 0.5 * h, th + 0.5 * h * k2t, dth + 0.5 * h * k2d);
            let (k4t, k4d) = f(xi + h, th + h * k3t, dth + h * k3d);
            let th_n = th + h / 6.0 * (k1t + 2.0 * k2t + 2.0 * k3t + k4t);
            let dth_n = dth + h / 6.0 * (k1d + 2.0 * k2d + 2.0 * k3d + k4d);
            if th_n <= 0.0 {
                // linear interpolation to the zero
                let frac = th / (th - th_n);
                xi1 = xi + frac * h;
                dth1 = dth + frac * (dth_n - dth);
                xs.push(xi1);
                ts.push(0.0);
                ms.push(-xi1 * xi1 * dth1);
                break;
            }
            xi += h;
            th = th_n;
            dth = dth_n;
            xs.push(xi);
            ts.push(th);
            ms.push(-xi * xi * dth);
        }
        let omega_n = -xi1 * xi1 * dth1;
        for m in ms.iter_mut() {
            *m /= omega_n;
        }
        Polytrope { n, xi: xs, theta: ts, mfrac: ms, xi1, omega_n }
    }

    /// Radius fraction r/R at which the enclosed mass fraction equals `f` (0..1).
    pub fn radius_at_mass_fraction(&self, f: f64) -> f64 {
        if f <= 0.0 {
            return 0.0;
        }
        if f >= 1.0 {
            return 1.0;
        }
        // mfrac is monotonic; binary search.
        let (mut lo, mut hi) = (0usize, self.mfrac.len() - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.mfrac[mid] < f {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let (m0, m1) = (self.mfrac[lo], self.mfrac[hi]);
        let t = if m1 > m0 { (f - m0) / (m1 - m0) } else { 0.0 };
        (self.xi[lo] + t * (self.xi[hi] - self.xi[lo])) / self.xi1
    }

    /// θ at r/R (linear interpolation).
    pub fn theta_at(&self, rfrac: f64) -> f64 {
        let x = rfrac * self.xi1;
        if x <= 0.0 {
            return 1.0;
        }
        if x >= self.xi1 {
            return 0.0;
        }
        let (mut lo, mut hi) = (0usize, self.xi.len() - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.xi[mid] < x {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let t = (x - self.xi[lo]) / (self.xi[hi] - self.xi[lo]);
        self.theta[lo] + t * (self.theta[hi] - self.theta[lo])
    }

    /// Central density and polytropic constant for mass M, radius R (G = 1).
    pub fn scalings(&self, mass: f64, radius: f64) -> (f64, f64) {
        let alpha = radius / self.xi1;
        let rho_c = mass / (4.0 * core::f64::consts::PI * alpha.powi(3) * self.omega_n);
        let k = 4.0 * core::f64::consts::PI * alpha * alpha * rho_c.powf(1.0 - 1.0 / self.n) / (self.n + 1.0);
        (rho_c, k)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n1_is_sin_over_xi() {
        let p = Polytrope::new(1.0);
        assert!((p.xi1 - core::f64::consts::PI).abs() < 1e-4, "xi1 = {}", p.xi1);
        assert!((p.omega_n - core::f64::consts::PI).abs() < 1e-3, "omega = {}", p.omega_n);
        for &rf in &[0.2, 0.5, 0.8] {
            let x = rf * core::f64::consts::PI;
            let exact = x.sin() / x;
            assert!((p.theta_at(rf) - exact).abs() < 1e-4);
        }
        // Half the mass is inside r/R ≈ 0.6 for n = 1: m(ξ)/M = (sin ξ − ξ cos ξ)/π
        let r_half = p.radius_at_mass_fraction(0.5);
        let x = r_half * core::f64::consts::PI;
        let m = (x.sin() - x * x.cos()) / core::f64::consts::PI;
        assert!((m - 0.5).abs() < 2e-3, "m at half = {}", m);
    }

    #[test]
    fn n15_matches_tables() {
        let p = Polytrope::new(1.5);
        assert!((p.xi1 - 3.65375).abs() < 2e-3, "xi1 = {}", p.xi1);
        assert!((p.omega_n - 2.71406).abs() < 5e-3, "omega = {}", p.omega_n);
        let (rho_c, k) = p.scalings(1.0, 1.0);
        // ρ_c/ρ_mean = 5.99 for n = 1.5
        let rho_mean = 1.0 / (4.0 / 3.0 * core::f64::consts::PI);
        assert!((rho_c / rho_mean - 5.99).abs() < 0.05, "rho_c/rho_mean = {}", rho_c / rho_mean);
        assert!(k > 0.0);
    }
}
