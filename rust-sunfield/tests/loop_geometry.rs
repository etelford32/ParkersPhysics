//! Measurement gate for the PFSS-lite tracer's LOOP GEOMETRY.
//!
//! The corona raymarcher (js/corona-volumetric.js) splats these lines into a
//! shell-grid loop-density volume, and the prominence channel fills the
//! magnetic DIPS in them. Both need the loops to reach the heights real AR
//! arcades reach. Phase 3 measured the traced apexes at 0.005–0.008 R☉ — so
//! low that a 32-slice shell grid put an entire arcade in its first slice and
//! the fine march sampled it about once. Observed AR loops are 0.03–0.2 R☉.
//!
//! This file MEASURES that rather than asserting a remembered number, and
//! prints the distribution so a future session can see what a change did.
use sunfield_wasm::field::{build_field, Ar, Hole};
use sunfield_wasm::seed::{build_seeds, SeedBudget, SeedKind};
use sunfield_wasm::trace::{trace_line, TraceParams, Topology};

const DEG: f32 = std::f32::consts::PI / 180.0;

fn params() -> TraceParams {
    TraceParams { source_surface: 2.5, step: 0.01, max_steps: 1200, samples_per_line: 64 }
}

/// Three planted ARs spanning the area/complexity range the page feeds in.
fn planted_ars() -> Vec<Ar> {
    vec![
        Ar { lat_rad: 15.0 * DEG, lon_rad: -40.0 * DEG, area: 0.30, polarity: 1.0, tilt_rad: -8.0 * DEG, complexity: 0 },
        Ar { lat_rad: -12.0 * DEG, lon_rad: 25.0 * DEG, area: 0.65, polarity: -1.0, tilt_rad: 6.0 * DEG, complexity: 2 },
        Ar { lat_rad: 8.0 * DEG, lon_rad: 120.0 * DEG, area: 1.00, polarity: 1.0, tilt_rad: -5.0 * DEG, complexity: 3 },
    ]
}

struct Apexes { closed: Vec<f32>, n_closed: usize, n_open: usize, n_stray: usize }

fn measure(ars: &[Ar], holes: &[Hole]) -> Apexes {
    let field = build_field(ars, holes);
    let seeds = build_seeds(ars, &field, SeedBudget { per_ar: 28, global: 192, max_total: 1200 });
    let p = params();
    let mut out = Apexes { closed: vec![], n_closed: 0, n_open: 0, n_stray: 0 };
    for s in &seeds {
        let line = match trace_line(&field, s.pos, &p) { Some(l) => l, None => continue };
        match line.topology {
            Topology::Stray => { out.n_stray += 1; }
            Topology::Closed => {
                out.n_closed += 1;
                // AR arcades only — the global quiet grid traces long
                // high-latitude loops that are a different population.
                if s.kind == SeedKind::ArArcade { out.closed.push(line.apex_height); }
            }
            _ => { out.n_open += 1; }
        }
    }
    out.closed.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

fn pct(v: &[f32], p: f32) -> f32 {
    if v.is_empty() { return 0.0; }
    v[((p * (v.len() - 1) as f32) as usize).min(v.len() - 1)]
}

#[test]
fn ar_arcades_reach_observed_heights() {
    let ars = planted_ars();
    let a = measure(&ars, &[]);
    assert!(a.closed.len() > 30, "not enough closed AR arcades to measure: {}", a.closed.len());
    let (p10, p50, p90, max) = (pct(&a.closed, 0.10), pct(&a.closed, 0.50), pct(&a.closed, 0.90), *a.closed.last().unwrap());
    println!(
        "AR arcade apex heights (R☉): p10 {:.4}  p50 {:.4}  p90 {:.4}  max {:.4}   \
         [closed {} · open {} · stray {}]",
        p10, p50, p90, max, a.n_closed, a.n_open, a.n_stray);

    // THE GATE. Observed active-region loops reach 0.03–0.2 R☉ (20 000–
    // 140 000 km); the corona volume's shell grid and the prominence dip
    // channel are both built for that range. The median arcade must live in
    // it, and the population must actually SPAN it — a stack of loops all at
    // one height is a torus, not an arcade.
    assert!(p50 >= 0.03, "median apex {:.4} R☉ is below the observed AR range (0.03–0.2)", p50);
    assert!(p50 <= 0.20, "median apex {:.4} R☉ is above the observed AR range", p50);
    assert!(p90 >= 0.05, "the tall end {:.4} R☉ never reaches a real arcade top", p90);
    assert!(p10 < p90 * 0.6, "apex heights are too uniform ({:.4} … {:.4}) — that is a torus, not an arcade", p10, p90);
    // And nothing absurd: a closed AR loop that reaches the source surface is
    // not a closed loop, it is a mis-classified open one.
    assert!(max < 1.0, "a closed AR arcade reached {:.3} R☉", max);
}

#[test]
fn most_seeds_still_trace_to_a_topology() {
    // Raising the seed ring must not turn the atlas into strays — a stray is
    // dropped, so a regression here silently empties the loop volume.
    let ars = planted_ars();
    let a = measure(&ars, &[]);
    let total = a.n_closed + a.n_open + a.n_stray;
    println!("topology split: closed {} open {} stray {} (of {})", a.n_closed, a.n_open, a.n_stray, total);
    assert!(total > 150, "too few traced lines: {}", total);
    assert!((a.n_stray as f32) / (total as f32) < 0.15,
        "{:.0}% strays — the tracer is losing lines", 100.0 * a.n_stray as f32 / total as f32);
    assert!(a.n_closed > 40, "no closed field left to light the arcades: {}", a.n_closed);
}

#[test]
fn bigger_regions_make_taller_arcades() {
    // The apex height must respond to AR area, or the volume draws every
    // region the same size whatever the feed says.
    let small = measure(&[Ar { lat_rad: 0.0, lon_rad: 0.0, area: 0.15, polarity: 1.0, tilt_rad: 0.0, complexity: 0 }], &[]);
    let big   = measure(&[Ar { lat_rad: 0.0, lon_rad: 0.0, area: 1.00, polarity: 1.0, tilt_rad: 0.0, complexity: 0 }], &[]);
    let (sm, bg) = (pct(&small.closed, 0.5), pct(&big.closed, 0.5));
    println!("median apex: small AR {:.4} R☉, big AR {:.4} R☉", sm, bg);
    assert!(sm > 0.0 && bg > 0.0, "both regions must produce closed arcades");
    assert!(bg > sm * 1.15, "a big region's arcade ({:.4}) is not meaningfully taller than a small one's ({:.4})", bg, sm);
}

#[test]
fn coronal_holes_still_open() {
    // The seed/burial change must not close the polar field — the open-line
    // channel is what the raymarcher's coronal-hole suppression reads.
    let holes = vec![
        Hole { lat_rad: 75.0 * DEG, lon_rad: 0.0, area: 0.5, sign: 1.0 },
        Hole { lat_rad: -75.0 * DEG, lon_rad: 0.0, area: 0.5, sign: -1.0 },
    ];
    let a = measure(&planted_ars(), &holes);
    println!("with polar holes: closed {} open {} stray {}", a.n_closed, a.n_open, a.n_stray);
    assert!(a.n_open > 20, "polar holes produced only {} open lines", a.n_open);
}
