//! Scan AR apex heights against the AREA the live NOAA feed actually produces.
//! sun.html maps a NOAA region's area (millionths) to area = clamp(a/800, 0.05, 1),
//! so a typical 50-500 uhem region arrives here as 0.06-0.6.
use sunfield_wasm::field::{build_field, Ar};
use sunfield_wasm::seed::{build_seeds, SeedBudget, SeedKind};
use sunfield_wasm::trace::{trace_line, TraceParams, Topology};

fn main() {
    let p = TraceParams { source_surface: 2.5, step: 0.01, max_steps: 1200, samples_per_line: 64 };
    println!("{:>6} {:>8} {:>8} {:>8} {:>8} {:>6}", "area", "p10", "p50", "p90", "max", "n");
    for area in [0.05f32, 0.0625, 0.125, 0.25, 0.375, 0.5, 0.65, 1.0] {
        let ars = vec![Ar { lat_rad: 0.2, lon_rad: 0.0, area, polarity: 1.0, tilt_rad: -0.1, complexity: 0 }];
        let field = build_field(&ars, &[]);
        let seeds = build_seeds(&ars, &field, SeedBudget { per_ar: 28, global: 0, max_total: 1200 });
        let mut h: Vec<f32> = seeds.iter()
            .filter(|s| s.kind == SeedKind::ArArcade)
            .filter_map(|s| trace_line(&field, s.pos, &p))
            .filter(|l| l.topology == Topology::Closed)
            .map(|l| l.apex_height).collect();
        h.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let q = |f: f32| if h.is_empty() { 0.0 } else { h[((f * (h.len() - 1) as f32) as usize).min(h.len() - 1)] };
        println!("{:>6.3} {:>8.4} {:>8.4} {:>8.4} {:>8.4} {:>6}", area, q(0.1), q(0.5), q(0.9), h.last().copied().unwrap_or(0.0), h.len());
    }
}
