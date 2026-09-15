//! Do the traced field lines have MAGNETIC DIPS?
//!
//! Prominence material is supported against gravity by magnetic tension in a
//! DIP - a local minimum of height along the field line (Kippenhahn-Schluter
//! 1957; Kuperus-Raadu 1974). Plasma drains along the field to the lowest
//! point, so dips are where cool material collects. A prominence channel in
//! the loop-density volume is only honest if the field actually HAS dips;
//! a single buried dipole's arcade rises monotonically to one apex and has
//! none. This measures how many the real seeded field produces, and where.
use sunfield_wasm::field::{build_field, Ar, Hole};
use sunfield_wasm::seed::{build_seeds, SeedBudget};
use sunfield_wasm::trace::{trace_line, TraceParams, Topology};

const DEG: f32 = std::f32::consts::PI / 180.0;

fn scan(label: &str, ars: &[Ar], holes: &[Hole]) {
    let p = TraceParams { source_surface: 2.5, step: 0.01, max_steps: 1200, samples_per_line: 64 };
    let field = build_field(ars, holes);
    let seeds = build_seeds(ars, &field, SeedBudget { per_ar: 28, global: 192, max_total: 1200 });
    let mut lines = 0usize;
    let mut with_dip = 0usize;
    let mut dips: Vec<(f32, f32)> = vec![];   // (height above photosphere, depth of the dip)
    for s in &seeds {
        let l = match trace_line(&field, s.pos, &p) { Some(l) => l, None => continue };
        if l.topology != Topology::Closed { continue; }
        lines += 1;
        let r: Vec<f32> = l.samples.iter().map(|v| v.len()).collect();
        let mut found = false;
        for i in 1..r.len() - 1 {
            if r[i] <= r[i - 1] && r[i] < r[i + 1] {
                // depth = how far the line rises on the SHALLOWER side
                let mut lo = r[i]; let mut hi_l = r[i]; let mut hi_r = r[i];
                for j in (0..i).rev() { if r[j] > hi_l { hi_l = r[j]; } else { break; } }
                for j in i + 1..r.len() { if r[j] > hi_r { hi_r = r[j]; } else { break; } }
                let depth = (hi_l - lo).min(hi_r - lo);
                if depth > 1e-5 { dips.push((r[i] - 1.0, depth)); found = true; }
                let _ = lo;
            }
        }
        if found { with_dip += 1; }
    }
    dips.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let deep: Vec<&(f32, f32)> = dips.iter().filter(|d| d.1 > 0.002).collect();
    println!("{label}: {lines} closed lines, {with_dip} carry a dip, {} dips total, {} deeper than 0.002 R☉",
             dips.len(), deep.len());
    for (h, d) in dips.iter().take(6) {
        println!("    dip at h = {:.4} R☉, depth {:.4} R☉", h, d);
    }
}

fn main() {
    let simple = vec![Ar { lat_rad: 0.2, lon_rad: 0.0, area: 0.6, polarity: 1.0, tilt_rad: -0.1, complexity: 0 }];
    scan("one simple AR (alpha)", &simple, &[]);

    let delta = vec![Ar { lat_rad: 0.2, lon_rad: 0.0, area: 0.6, polarity: 1.0, tilt_rad: -0.1, complexity: 3 }];
    scan("one delta-spot AR", &delta, &[]);

    let three = vec![
        Ar { lat_rad: 15.0 * DEG, lon_rad: -40.0 * DEG, area: 0.30, polarity: 1.0, tilt_rad: -8.0 * DEG, complexity: 0 },
        Ar { lat_rad: -12.0 * DEG, lon_rad: 25.0 * DEG, area: 0.65, polarity: -1.0, tilt_rad: 6.0 * DEG, complexity: 2 },
        Ar { lat_rad: 8.0 * DEG, lon_rad: 120.0 * DEG, area: 1.00, polarity: 1.0, tilt_rad: -5.0 * DEG, complexity: 3 },
    ];
    scan("three planted ARs", &three, &[]);

    // Two ARs close together: the classic filament-channel geometry, where the
    // superposition of two bipoles makes a dipped separatrix between them.
    let pair = vec![
        Ar { lat_rad: 0.1, lon_rad: -0.10, area: 0.7, polarity: 1.0, tilt_rad: 0.0, complexity: 0 },
        Ar { lat_rad: 0.1, lon_rad:  0.10, area: 0.7, polarity: -1.0, tilt_rad: 0.0, complexity: 0 },
    ];
    scan("two adjacent opposite-polarity ARs", &pair, &[]);
}
