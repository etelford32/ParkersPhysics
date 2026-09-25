//! SGP4/SDP4 Orbital Propagator — WebAssembly Module
//!
//! Propagates Two-Line Element sets / CCSDS OMM mean elements to arbitrary
//! times, plus the site's batch, registry, trajectory, drag-decay and
//! NRLMSISE-00 helpers, exported to JavaScript via wasm-bindgen.
//!
//! The propagator is the `sgp4` crate, a pure-Rust transcription of
//!   Vallado et al. (2006) "Revisiting Spacetrack Report #3", AIAA 2006-6753
//! (itself built on Hoots & Roehrich 1980, Spacetrack Report No. 3):
//!   - SGP4 for near-Earth orbits and SDP4 deep-space (period ≥ 225 min),
//!     lunisolar terms and 12 h / 24 h resonances included
//!   - WGS-72, the AFSPC epoch and sidereal-time expressions, Lyddane fix
//!   - TEME (True Equator Mean Equinox) position (km) and velocity (km/s)
//! `cargo test` pins it to every published row of the Vallado verification
//! set (tests/fixtures/sgp4/). See the "SGP4 internal state" note for why the
//! hand-rolled kernel this replaced is gone.

use wasm_bindgen::prelude::*;
use std::f64::consts::PI;

// ── NRLMSISE-00 atmosphere model (vendored C port) ──────────────────────
// Lives in src/nrlmsise00.rs; pulls in the C source via build.rs.
// Exposes nrlmsise00_density_point + nrlmsise00_density_profile to JS.
mod nrlmsise00;

// ── WGS-72 constants (SGP4 standard, NOT WGS-84) ──────────────────────────
// Used by the trajectory / osculating-element helpers below; the propagator
// carries its own copy (sgp4::WGS72).

const MU: f64 = 398600.8;            // km³/s² — gravitational parameter
const RE: f64 = 6378.135;            // km — Earth equatorial radius
const TWOPI: f64 = 2.0 * PI;
const DEG2RAD: f64 = PI / 180.0;
const MIN_PER_DAY: f64 = 1440.0;

// ── TLE parsed elements ────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct TleElements {
    // Line 1
    norad_id: u32,
    epoch_yr: f64,       // fractional year (e.g. 2026.254)
    epoch_jd: f64,       // Julian Day of epoch
    bstar: f64,          // B* drag term (1/er)
    // Line 2
    incl: f64,           // inclination (rad)
    raan: f64,           // right ascension of ascending node (rad)
    ecc: f64,            // eccentricity
    argp: f64,           // argument of perigee (rad)
    mean_anom: f64,      // mean anomaly (rad)
    mean_motion: f64,    // revs/day → rad/min
    rev_num: u32,        // revolution number at epoch
}

// ── SGP4 internal state ────────────────────────────────────────────────────
//
// The propagator itself is the `sgp4` crate — a pure-Rust transcription of
// Vallado et al. 2006's reference SGP4/SDP4, deep-space lunisolar and
// resonance terms included. It REPLACED a hand-rolled kernel on 2026-09-24
// that claimed "full SGP4 + SDP4" but had no deep-space code at all, dropped
// the a/r factor from the short-period position (so every position was
// distorted), carried incomplete secular rates and mangled drag
// coefficients, and refused e < 1e-6 as "decayed": 5 260 km off at epoch on
// Vallado case 00005, 1.2e8 km at worst across the verification set, and
// 47-49 minute ISS "passes" on the dashboard. `cargo test` now pins every
// published row of that set (tests/fixtures/sgp4/). Do not hand-roll SGP4
// here again; if the crate ever needs replacing, the gate says whether the
// replacement is right.
//
// WGS-72 + the AFSPC sidereal-time and epoch expressions: the model
// CelesTrak / Space-Track element sets are FITTED with. Propagation uses the
// crate's standard `propagate`, which carries Vallado's LYDDANE FIX, not
// `propagate_afspc_compatibility_mode`. The two differ only for deep-space
// orbits below 0.2 rad inclination, where AFSPC's AcTan() drifts past
// 280.5 min. Verification case 23599 is that orbit: the AFSPC mode missed
// tcppver.out by 0.96 km there (measured) and this mode matches it.

struct Sgp4State {
    tle: TleElements,
    constants: sgp4::Constants,
}

// ── TLE Parser ─────────────────────────────────────────────────────────────

fn parse_tle(line1: &str, line2: &str) -> Result<TleElements, String> {
    if line1.len() < 69 || line2.len() < 69 {
        return Err("TLE lines must be at least 69 characters".into());
    }

    let norad_id: u32 = line1[2..7].trim().parse().map_err(|_| "Bad NORAD ID")?;

    // Epoch: YY + fractional day
    let epoch_yr_2d: f64 = line1[18..20].trim().parse().map_err(|_| "Bad epoch year")?;
    let epoch_day: f64 = line1[20..32].trim().parse().map_err(|_| "Bad epoch day")?;
    let epoch_yr = if epoch_yr_2d >= 57.0 { 1900.0 + epoch_yr_2d } else { 2000.0 + epoch_yr_2d };

    // Convert to Julian Day
    let yr = epoch_yr as i32;
    let jd_jan1 = 367.0 * yr as f64
        - ((7 * (yr + ((10) / 12))) / 4) as f64
        + (275 * 1 / 9) as f64
        + 1721013.5;
    let epoch_jd = jd_jan1 + epoch_day;

    // B* drag
    let bstar = parse_tle_float(&line1[53..61])?;

    // Line 2
    let incl: f64 = line2[8..16].trim().parse().map_err(|_| "Bad inclination")? ;
    let raan: f64 = line2[17..25].trim().parse().map_err(|_| "Bad RAAN")?;
    let ecc_str = format!("0.{}", line2[26..33].trim());
    let ecc: f64 = ecc_str.parse().map_err(|_| "Bad eccentricity")?;
    let argp: f64 = line2[34..42].trim().parse().map_err(|_| "Bad arg perigee")?;
    let mean_anom: f64 = line2[43..51].trim().parse().map_err(|_| "Bad mean anomaly")?;
    let mean_motion: f64 = line2[52..63].trim().parse().map_err(|_| "Bad mean motion")?;
    let rev_num: u32 = line2[63..68].trim().parse().unwrap_or(0);

    Ok(TleElements {
        norad_id,
        epoch_yr,
        epoch_jd,
        bstar,
        incl: incl * DEG2RAD,
        raan: raan * DEG2RAD,
        ecc,
        argp: argp * DEG2RAD,
        mean_anom: mean_anom * DEG2RAD,
        mean_motion: mean_motion * TWOPI / MIN_PER_DAY,  // rev/day → rad/min
        rev_num,
    })
}

/// Build the same internal mean-element record directly from a CCSDS OMM
/// payload. OMM is the catalogue-safe path for six- and nine-digit object
/// identifiers, which no longer fit the legacy fixed-width TLE identifier
/// field. Angular inputs are degrees and mean motion is rev/day, matching
/// CelesTrak's OMM JSON representation.
fn elements_from_omm(
    norad_id: u32,
    epoch_jd: f64,
    bstar: f64,
    inclination_deg: f64,
    raan_deg: f64,
    eccentricity: f64,
    arg_perigee_deg: f64,
    mean_anomaly_deg: f64,
    mean_motion_rev_day: f64,
    rev_num: u32,
) -> Result<TleElements, String> {
    let finite = epoch_jd.is_finite()
        && bstar.is_finite()
        && inclination_deg.is_finite()
        && raan_deg.is_finite()
        && eccentricity.is_finite()
        && arg_perigee_deg.is_finite()
        && mean_anomaly_deg.is_finite()
        && mean_motion_rev_day.is_finite();
    if !finite { return Err("OMM elements must be finite".into()); }
    if norad_id == 0 { return Err("Bad NORAD ID".into()); }
    if !(2_000_000.0..3_000_000.0).contains(&epoch_jd) {
        return Err("Bad OMM epoch JD".into());
    }
    if !(0.0..=180.0).contains(&inclination_deg) {
        return Err("Bad OMM inclination".into());
    }
    if !(0.0..1.0).contains(&eccentricity) {
        return Err("Bad OMM eccentricity".into());
    }
    if mean_motion_rev_day <= 0.0 {
        return Err("Bad OMM mean motion".into());
    }

    Ok(TleElements {
        norad_id,
        // The propagator uses epoch_jd for elapsed time. epoch_yr is retained
        // only for parse-info compatibility and is not needed on this path.
        epoch_yr: 0.0,
        epoch_jd,
        bstar,
        incl: inclination_deg * DEG2RAD,
        raan: raan_deg * DEG2RAD,
        ecc: eccentricity,
        argp: arg_perigee_deg * DEG2RAD,
        mean_anom: mean_anomaly_deg * DEG2RAD,
        mean_motion: mean_motion_rev_day * TWOPI / MIN_PER_DAY,
        rev_num,
    })
}

/// Parse TLE-format implied-decimal float (e.g. " 50475-4" → 0.50475e-4)
fn parse_tle_float(s: &str) -> Result<f64, String> {
    let s = s.trim();
    if s.is_empty() || s == "00000-0" || s == " 00000-0" { return Ok(0.0); }

    // Format: [+-]NNNNN[+-]E  where mantissa has implied leading decimal
    let bytes = s.as_bytes();
    let sign = if bytes[0] == b'-' { -1.0 } else { 1.0 };
    let start = if bytes[0] == b'-' || bytes[0] == b'+' || bytes[0] == b' ' { 1 } else { 0 };

    // Find the exponent sign (last + or -)
    let mut exp_pos = s.len();
    for i in (start + 1..s.len()).rev() {
        if bytes[i] == b'+' || bytes[i] == b'-' {
            exp_pos = i;
            break;
        }
    }

    if exp_pos >= s.len() {
        // No exponent — just a number with implied decimal
        let mantissa: f64 = format!("0.{}", &s[start..]).parse().unwrap_or(0.0);
        return Ok(sign * mantissa);
    }

    let mantissa: f64 = format!("0.{}", &s[start..exp_pos]).parse().unwrap_or(0.0);
    let exp: f64 = s[exp_pos..].parse().unwrap_or(0.0);
    Ok(sign * mantissa * 10.0_f64.powf(exp))
}

// ── SGP4 Initialization / Propagation ─────────────────────────────────────

fn sgp4_init(tle: &TleElements) -> Result<Sgp4State, String> {
    if !(0.0..1.0).contains(&tle.ecc) { return Err("Invalid eccentricity".into()); }
    if !(tle.mean_motion > 0.0) { return Err("Invalid mean motion".into()); }
    // tle.mean_motion is already rad/min — the Kozai mean motion SGP4 wants.
    let orbit = sgp4::Orbit::from_kozai_elements(
        &sgp4::WGS72, tle.incl, tle.raan, tle.ecc, tle.argp, tle.mean_anom, tle.mean_motion,
    ).map_err(|e| format!("SGP4 init: {e:?}"))?;
    // Years since J2000 by the AFSPC expression (JD − 2451545) / 365.25;
    // tle.epoch_jd is exact for both the TLE and the OMM entry points.
    let epoch = (tle.epoch_jd - 2_451_545.0) / 365.25;
    let constants = sgp4::Constants::new(
        sgp4::WGS72, sgp4::afspc_epoch_to_sidereal_time, epoch, tle.bstar, orbit,
    ).map_err(|e| format!("SGP4 init: {e:?}"))?;
    Ok(Sgp4State { tle: tle.clone(), constants })
}

/// TEME position (km) and velocity (km/s) `tsince_min` minutes from epoch.
fn sgp4_propagate(state: &Sgp4State, tsince_min: f64) -> Result<([f64; 3], [f64; 3]), String> {
    let p = state.constants
        .propagate(sgp4::MinutesSinceEpoch(tsince_min))
        .map_err(|e| e.to_string())?;
    Ok((p.position, p.velocity))
}

// ── WASM Exports ──────────────────────────────────────────────────────────

/// Parse a TLE and propagate to tsince minutes from epoch.
/// Returns [x, y, z, vx, vy, vz] in km and km/s (TEME frame).
#[wasm_bindgen]
pub fn propagate_tle(line1: &str, line2: &str, tsince_min: f64) -> Result<Vec<f64>, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle)
        .map_err(|e| JsValue::from_str(&e))?;
    let (pos, vel) = sgp4_propagate(&state, tsince_min)
        .map_err(|e| JsValue::from_str(&e))?;

    Ok(vec![pos[0], pos[1], pos[2], vel[0], vel[1], vel[2]])
}

/// Propagate a TLE to multiple time points (batch mode for performance).
/// times_min: flat array of tsince values in minutes
/// Returns flat array [x0,y0,z0,vx0,vy0,vz0, x1,y1,z1,...]
#[wasm_bindgen]
pub fn propagate_batch(line1: &str, line2: &str, times_min: &[f64]) -> Result<Vec<f64>, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle)
        .map_err(|e| JsValue::from_str(&e))?;

    let mut results = Vec::with_capacity(times_min.len() * 6);
    for &t in times_min {
        match sgp4_propagate(&state, t) {
            Ok((pos, vel)) => {
                results.extend_from_slice(&pos);
                results.extend_from_slice(&vel);
            }
            Err(_) => {
                // Satellite decayed/re-entered — fill with NaN
                results.extend_from_slice(&[f64::NAN; 6]);
            }
        }
    }
    Ok(results)
}

/// Propagate one CCSDS OMM mean-element record. This is numerically the same
/// SGP4 initialization and propagation path used by `propagate_tle`; only the
/// source parser differs.
#[wasm_bindgen]
pub fn propagate_omm(
    norad_id: u32,
    epoch_jd: f64,
    bstar: f64,
    inclination_deg: f64,
    raan_deg: f64,
    eccentricity: f64,
    arg_perigee_deg: f64,
    mean_anomaly_deg: f64,
    mean_motion_rev_day: f64,
    rev_num: u32,
    tsince_min: f64,
) -> Result<Vec<f64>, JsValue> {
    let tle = elements_from_omm(
        norad_id, epoch_jd, bstar, inclination_deg, raan_deg,
        eccentricity, arg_perigee_deg, mean_anomaly_deg,
        mean_motion_rev_day, rev_num,
    ).map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle).map_err(|e| JsValue::from_str(&e))?;
    let (pos, vel) = sgp4_propagate(&state, tsince_min)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(vec![pos[0], pos[1], pos[2], vel[0], vel[1], vel[2]])
}

/// Batch companion to `propagate_omm` for orbit trails and conjunction scans.
#[wasm_bindgen]
pub fn propagate_batch_omm(
    norad_id: u32,
    epoch_jd: f64,
    bstar: f64,
    inclination_deg: f64,
    raan_deg: f64,
    eccentricity: f64,
    arg_perigee_deg: f64,
    mean_anomaly_deg: f64,
    mean_motion_rev_day: f64,
    rev_num: u32,
    times_min: &[f64],
) -> Result<Vec<f64>, JsValue> {
    let tle = elements_from_omm(
        norad_id, epoch_jd, bstar, inclination_deg, raan_deg,
        eccentricity, arg_perigee_deg, mean_anomaly_deg,
        mean_motion_rev_day, rev_num,
    ).map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle).map_err(|e| JsValue::from_str(&e))?;

    let mut results = Vec::with_capacity(times_min.len() * 6);
    for &t in times_min {
        match sgp4_propagate(&state, t) {
            Ok((pos, vel)) => {
                results.extend_from_slice(&pos);
                results.extend_from_slice(&vel);
            }
            Err(_) => results.extend_from_slice(&[f64::NAN; 6]),
        }
    }
    Ok(results)
}

/// Parse a TLE and return orbital elements as JSON-friendly object.
#[wasm_bindgen]
pub fn parse_tle_info(line1: &str, line2: &str) -> Result<JsValue, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;

    let obj = serde_wasm_bindgen::to_value(&TleInfo {
        norad_id: tle.norad_id,
        epoch_yr: tle.epoch_yr,
        epoch_jd: tle.epoch_jd,
        inclination_deg: tle.incl / DEG2RAD,
        raan_deg: tle.raan / DEG2RAD,
        eccentricity: tle.ecc,
        arg_perigee_deg: tle.argp / DEG2RAD,
        mean_anomaly_deg: tle.mean_anom / DEG2RAD,
        mean_motion_rev_day: tle.mean_motion * MIN_PER_DAY / TWOPI,
        bstar: tle.bstar,
        period_min: TWOPI / tle.mean_motion,
        rev_num: tle.rev_num,
    }).map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;

    Ok(obj)
}

// ── Persistent registry — batch propagation hot path ─────────────────────
//
// `propagate_tle` re-parses + re-inits per call, so the live tracker
// (which propagates ~20 k sats × 60 Hz) was paying the parse cost on
// every frame for every sat. The registry caches the parsed Sgp4State
// in WASM linear memory and exposes a single batch entrypoint that
// propagates every registered sat to one wall-clock JD, applies the
// TEME → scene-frame transform inline (so JS doesn't loop in cold
// JS code at all), and writes [x, y, z] f32 triplets into a caller-
// provided Float32Array. JS just allocates the buffer once and uploads
// to GPU.
//
// Slots are stable: removing leaves a None placeholder so subsequent
// indices don't shift, which keeps JS's parallel `_satellites[]` array
// in lockstep without index remapping.

use std::cell::RefCell;

thread_local! {
    static REGISTRY: RefCell<Vec<Option<Sgp4State>>> = RefCell::new(Vec::new());
    // Persistent scratch buffer for `registry_propagate_into`. Sized
    // up once on the first call and reused every frame, so the hot
    // path allocates zero (vs. the older `registry_propagate` which
    // returned a fresh `Vec<f32>` and triggered a per-frame
    // wasm-bindgen → JS Float32Array conversion + alloc).
    static OUT_BUFFER: RefCell<Vec<f32>> = RefCell::new(Vec::new());
}

#[wasm_bindgen]
pub fn registry_clear() {
    REGISTRY.with(|r| r.borrow_mut().clear());
}

#[wasm_bindgen]
pub fn registry_len() -> usize {
    REGISTRY.with(|r| r.borrow().len())
}

/// Append a sat to the registry. Returns the slot index (0-based).
/// Parse / init failures bubble up as JsValue strings — JS marks the
/// slot as un-batched and falls back to its own propagator for that
/// entry.
#[wasm_bindgen]
pub fn registry_add(line1: &str, line2: &str) -> Result<u32, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle)
        .map_err(|e| JsValue::from_str(&e))?;
    let idx = REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = reg.len();
        reg.push(Some(state));
        i as u32
    });
    Ok(idx)
}

/// Append a CCSDS OMM record to the persistent hot-path registry.
#[wasm_bindgen]
pub fn registry_add_omm(
    norad_id: u32,
    epoch_jd: f64,
    bstar: f64,
    inclination_deg: f64,
    raan_deg: f64,
    eccentricity: f64,
    arg_perigee_deg: f64,
    mean_anomaly_deg: f64,
    mean_motion_rev_day: f64,
    rev_num: u32,
) -> Result<u32, JsValue> {
    let tle = elements_from_omm(
        norad_id, epoch_jd, bstar, inclination_deg, raan_deg,
        eccentricity, arg_perigee_deg, mean_anomaly_deg,
        mean_motion_rev_day, rev_num,
    ).map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle).map_err(|e| JsValue::from_str(&e))?;
    let idx = REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = reg.len();
        reg.push(Some(state));
        i as u32
    });
    Ok(idx)
}

/// Reserve a slot without an associated state (e.g. JS-fallback sat).
/// The slot propagates as (0, 0, 0); JS overwrites that triplet with
/// its own values after the batch returns. Keeps the WASM registry
/// in lockstep with JS `_satellites[]` so indices line up.
#[wasm_bindgen]
pub fn registry_reserve_blank() -> u32 {
    REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = reg.len();
        reg.push(None);
        i as u32
    })
}

/// Mark a slot as removed. The slot is kept (so subsequent indices
/// don't shift) but propagation skips it.
#[wasm_bindgen]
pub fn registry_remove(idx: u32) {
    REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = idx as usize;
        if i < reg.len() { reg[i] = None; }
    });
}

/// Zero-allocation companion to `registry_propagate`. Writes the
/// same [x, y, z] triplets directly into the supplied JS
/// `Float32Array`, which is typically backed by a SharedArrayBuffer
/// the main thread is already using as the THREE position
/// attribute. One memcpy from a thread-local Rust scratch buffer
/// (`OUT_BUFFER`) to the JS-side typed array; no per-frame
/// `Vec<f32>` allocation, no per-frame wasm-bindgen → Float32Array
/// conversion.
///
/// Returns the slot count actually written (= registered sats).
/// `out` MUST be at least 3 × registry_len() floats long; if it's
/// shorter we write what fits and return that count, leaving the
/// remainder of the registry untouched. Caller can detect this by
/// comparing the return to its expected slot count.
#[wasm_bindgen]
pub fn registry_propagate_into(now_jd: f64, gmst_rad: f64, scale: f64, out: &js_sys::Float32Array) -> usize {
    let cos_g = gmst_rad.cos();
    let sin_g = gmst_rad.sin();
    let scl   = scale as f32;

    REGISTRY.with(|r| {
        let reg  = r.borrow();
        let n    = reg.len();
        let want = n * 3;
        let cap  = (out.length() as usize).min(want);

        OUT_BUFFER.with(|b| {
            let mut buf = b.borrow_mut();
            if buf.len() < cap { buf.resize(cap, f32::NAN); }
            // Pre-fill NaN so blank slots / decayed sats land on a
            // sentinel JS-side without an explicit branch per slot.
            for v in buf[..cap].iter_mut() { *v = f32::NAN; }

            for (i, slot) in reg.iter().enumerate() {
                let off = i * 3;
                if off + 3 > cap { break; }
                let Some(state) = slot else { continue; };
                let tsince = (now_jd - state.tle.epoch_jd) * MIN_PER_DAY;
                let Ok((p, _v)) = sgp4_propagate(state, tsince) else { continue; };

                let x_ecef =  cos_g * p[0] + sin_g * p[1];
                let y_ecef = -sin_g * p[0] + cos_g * p[1];
                let z_ecef =  p[2];

                buf[off]     = (x_ecef as f32) * scl;
                buf[off + 1] = (z_ecef as f32) * scl;
                buf[off + 2] = (-y_ecef as f32) * scl;
            }

            // Single bulk copy from wasm linear memory into the JS
            // Float32Array. wasm-bindgen lowers this to one memcpy.
            out.subarray(0, cap as u32).copy_from(&buf[..cap]);
        });

        cap / 3
    })
}

/// Propagate every registered sat to JD = `now_jd`, rotate TEME →
/// scene-frame using `gmst_rad` (matching js/geo/coords.js
/// eciToEcef + the Y=north flip), scale by `scale` (= km_to_scene),
/// and return a flat Float32Array of [x, y, z] triplets — one per
/// registered slot, in slot order.
///
/// Returning the buffer (rather than taking a JS-owned `&mut` slice)
/// is the wasm-bindgen pattern that actually writes back to JS:
/// `&mut [f32]` is treated as a pure input by wasm-bindgen
/// (passArrayF32ToWasm0 copies INTO WASM and never copies out), so
/// using that signature would silently drop every position update.
///
/// On per-sat propagate failure (decay / numerical blowup) and on
/// blank slots the triplet is NaN so JS can detect it and fall back
/// without confusing it with a valid origin sample.
#[wasm_bindgen]
pub fn registry_propagate(now_jd: f64, gmst_rad: f64, scale: f64) -> Vec<f32> {
    let cos_g = gmst_rad.cos();
    let sin_g = gmst_rad.sin();
    let scl   = scale as f32;

    REGISTRY.with(|r| {
        let reg = r.borrow();
        let n = reg.len();
        let mut out = vec![f32::NAN; n * 3];

        for (i, slot) in reg.iter().enumerate() {
            let Some(state) = slot else { continue; };
            let tsince = (now_jd - state.tle.epoch_jd) * MIN_PER_DAY;
            let Ok((p, _v)) = sgp4_propagate(state, tsince) else { continue; };

            // ECI/TEME → astronomical ECEF: rotate −GMST about Z.
            let x_ecef =  cos_g * p[0] + sin_g * p[1];
            let y_ecef = -sin_g * p[0] + cos_g * p[1];
            let z_ecef =  p[2];
            // Astronomical ECEF (Z = north) → Three.js scene frame
            // (Y = north): xS = xE, yS = zE, zS = -yE.
            let off = i * 3;
            out[off]     = (x_ecef as f32) * scl;
            out[off + 1] = (z_ecef as f32) * scl;
            out[off + 2] = (-y_ecef as f32) * scl;
        }
        out
    })
}

#[derive(serde::Serialize)]
struct TleInfo {
    norad_id: u32,
    epoch_yr: f64,
    epoch_jd: f64,
    inclination_deg: f64,
    raan_deg: f64,
    eccentricity: f64,
    arg_perigee_deg: f64,
    mean_anomaly_deg: f64,
    mean_motion_rev_day: f64,
    bstar: f64,
    period_min: f64,
    rev_num: u32,
}

// ── Deterministic trajectory analysis ─────────────────────────────────────
//
// `propagate_trajectory_full` is a one-call sweep that lays the SGP4 truth
// across a user-defined time grid and pre-derives the quantities the
// upper-atmosphere analysis panel needs to plot. Returning a flat f64
// stride keeps the wasm-bindgen boundary crossing to a single
// passArrayF64ToWasm + a single Vec→TypedArray copy on return.
//
// Stride: 13 doubles per sample
//   0  t_min          minutes since TLE epoch
//   1  x_km           TEME x
//   2  y_km           TEME y
//   3  z_km           TEME z
//   4  vx_kmS         TEME ẋ
//   5  vy_kmS         TEME ẏ
//   6  vz_kmS         TEME ż
//   7  r_km           |r|
//   8  alt_km         |r| − R⊕   (geocentric, not geodetic — fine for vis)
//   9  speed_kmS      |v|
//   10 sma_km         osculating semi-major axis derived from (r, v)
//   11 ecc            osculating eccentricity
//   12 inc_deg        osculating inclination (deg)
//
// On per-step propagate failure we write NaN across that step's stride.

const TRAJ_STRIDE: usize = 13;

#[wasm_bindgen]
pub fn propagate_trajectory_full(
    line1: &str,
    line2: &str,
    times_min: &[f64],
) -> Result<Vec<f64>, JsValue> {
    let tle = parse_tle(line1, line2).map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle).map_err(|e| JsValue::from_str(&e))?;

    let n = times_min.len();
    let mut out = vec![f64::NAN; n * TRAJ_STRIDE];

    for (i, &t) in times_min.iter().enumerate() {
        let off = i * TRAJ_STRIDE;
        out[off] = t;
        match sgp4_propagate(&state, t) {
            Ok((p, v)) => {
                let r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
                let r = r2.sqrt();
                let s2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
                let s = s2.sqrt();

                // Osculating elements from (r, v) — vis-viva + angular momentum.
                // sma:  1/a = 2/r − v²/μ
                let inv_a = 2.0 / r - s2 / MU;
                let sma_km = if inv_a.abs() > 1e-12 { 1.0 / inv_a } else { f64::NAN };

                // h = r × v
                let hx = p[1] * v[2] - p[2] * v[1];
                let hy = p[2] * v[0] - p[0] * v[2];
                let hz = p[0] * v[1] - p[1] * v[0];
                let h2 = hx * hx + hy * hy + hz * hz;
                let h = h2.sqrt();

                // e_vec = (v × h)/μ − r̂
                let ev_x = (v[1] * hz - v[2] * hy) / MU - p[0] / r;
                let ev_y = (v[2] * hx - v[0] * hz) / MU - p[1] / r;
                let ev_z = (v[0] * hy - v[1] * hx) / MU - p[2] / r;
                let ecc = (ev_x * ev_x + ev_y * ev_y + ev_z * ev_z).sqrt();

                // inclination: cos i = h_z / |h|
                let inc_rad = if h > 0.0 {
                    (hz / h).clamp(-1.0, 1.0).acos()
                } else {
                    f64::NAN
                };

                out[off + 1] = p[0];
                out[off + 2] = p[1];
                out[off + 3] = p[2];
                out[off + 4] = v[0];
                out[off + 5] = v[1];
                out[off + 6] = v[2];
                out[off + 7] = r;
                out[off + 8] = r - RE;
                out[off + 9] = s;
                out[off + 10] = sma_km;
                out[off + 11] = ecc;
                out[off + 12] = inc_rad / DEG2RAD;
            }
            Err(_) => {
                // leave NaN for [1..13]
                for k in 1..TRAJ_STRIDE {
                    out[off + k] = f64::NAN;
                }
            }
        }
    }
    Ok(out)
}

/// Stride for the trajectory array — exposed so JS callers don't hardcode 13.
#[wasm_bindgen]
pub fn trajectory_stride() -> usize { TRAJ_STRIDE }

// ── RK4 drag-decay overlay ────────────────────────────────────────────────
//
// Independent of the SGP4 truth, this integrates a circular-orbit
// surrogate forward in time using an explicit Runge–Kutta-4 step. The
// only state is the semi-major axis a(t); for circular orbits
//
//   v² = μ/a            (vis-viva at e=0)
//   ḋa/dt = −(CdA/m) · ρ(h) · v · a²    /   √(μ·a)        (Kozai 1959)
//        = −BC · ρ · √(μ·a)              for the simplified form below
//
// where BC = CdA/m has units m²/kg. We sample ρ from a piecewise-linear
// table indexed by altitude (km) supplied from JS (so the same NRLMSIS-
// style profile the rest of the page renders feeds the drag overlay).
//
// The "fun integration math" lives here: an explicit 4-stage RK4 in Rust
// with branchless table lookup, returning altitude / sma / speed every
// `out_stride_min` minutes. RK4 over 30-day horizons with 60-second
// substeps is ~43k steps — sub-millisecond in WASM, and gives a clean
// analytic baseline to compare against the SGP4 (B*-driven) decay.
//
// Inputs:
//   a0_km             initial semi-major axis
//   bc_m2_per_kg      ballistic coefficient CdA/m (typical LEO sat ≈ 0.02)
//   horizon_min       integration horizon (minutes)
//   dt_sub_sec        RK4 substep (seconds)
//   out_stride_min    sample stride for output (minutes)
//   alt_grid_km       monotonically increasing altitude grid (km)
//   rho_grid_kg_m3    parallel ρ values (kg/m³)
//   rho_scale         multiplier on ρ (e.g. 1.0; 1.5 to model storm)
//
// Output stride: 5 doubles per sample
//   0  t_min, 1 sma_km, 2 alt_km, 3 speed_kmS, 4 da_dt_km_per_day

const DRAG_STRIDE: usize = 5;

fn lerp_rho(alt_km: f64, alt_grid: &[f64], rho_grid: &[f64]) -> f64 {
    if alt_grid.is_empty() { return 0.0; }
    if alt_km <= alt_grid[0] { return rho_grid[0]; }
    let n = alt_grid.len();
    if alt_km >= alt_grid[n - 1] { return rho_grid[n - 1]; }
    // Linear scan is fine — typical grids are 30–60 entries and the
    // density gradient drops by 10× per 50 km, so a smarter index gains
    // little once the surrounding cache is hot.
    let mut i = 0usize;
    while i + 1 < n && alt_grid[i + 1] < alt_km { i += 1; }
    let t = (alt_km - alt_grid[i]) / (alt_grid[i + 1] - alt_grid[i]);
    // ρ falls roughly exponentially with altitude; log-linear interpolation
    // tracks the curve much better than plain linear between coarse grid
    // points and avoids the staircase artefact in the decay plot.
    let r0 = rho_grid[i].max(1e-30);
    let r1 = rho_grid[i + 1].max(1e-30);
    (r0.ln() * (1.0 - t) + r1.ln() * t).exp()
}

#[wasm_bindgen]
pub fn drag_decay_rk4(
    a0_km: f64,
    bc_m2_per_kg: f64,
    horizon_min: f64,
    dt_sub_sec: f64,
    out_stride_min: f64,
    alt_grid_km: &[f64],
    rho_grid_kg_m3: &[f64],
    rho_scale: f64,
) -> Result<Vec<f64>, JsValue> {
    if alt_grid_km.len() != rho_grid_kg_m3.len() || alt_grid_km.is_empty() {
        return Err(JsValue::from_str("alt_grid_km and rho_grid_kg_m3 must be parallel and non-empty"));
    }
    if !(a0_km.is_finite() && a0_km > RE) {
        return Err(JsValue::from_str("a0_km must be > RE"));
    }
    if !(dt_sub_sec > 0.0 && horizon_min > 0.0 && out_stride_min > 0.0) {
        return Err(JsValue::from_str("dt_sub_sec, horizon_min, out_stride_min must be > 0"));
    }

    // Convert μ to km³/s² (already km³/s² — see top of file).
    let mu_km3_s2 = MU;
    // BC needs a unit-consistent form. ρ is kg/m³; v in km/s; a in km.
    // Convert BC m²/kg → km²/kg, ρ kg/m³ → kg/km³ as one multiplier:
    //   m² / kg × kg/m³ = 1/m → 1/km via factor 1000.
    // We just inline: after multiplication, BC*ρ has units 1/m. Multiply
    // by v[m/s] then we have 1/s; multiply by dt[s] to get a dimensionless
    // velocity-loss fraction, and finally by 2·a (Kozai) to get da[m].
    // Track ρ in m-system, drop to km only when reporting.

    let dt = dt_sub_sec;                 // seconds
    let horizon_s = horizon_min * 60.0;
    let out_stride_s = out_stride_min * 60.0;
    let n_out = (horizon_s / out_stride_s).floor() as usize + 1;

    // Δa per dt for circular Kozai with constant ρ over the substep:
    //   da/dt = − BC · ρ · v · a    ·  (factor of 1 here: Kozai's
    //                                    equation for circular drag is
    //                                    da/dt = −2·BC·ρ·a²·n where n=v/a,
    //                                    which simplifies to the line above.)
    //
    // We use the exact form via RK4 on s = a(t):
    //   f(a) = − (CdA/m) · ρ(h) · v(a) · a
    // with v(a) = √(μ/a), h = a − R_E (circular surrogate; SGP4 takes
    // ecc into account separately).
    //
    // BC unit conversion folded inline: BC[m²/kg] × ρ[kg/m³] × v[m/s] ×
    // a[m] → da/dt[m/s]. We carry a in km, so divide by 1000 once at the
    // end of f().
    let f_da_dt = |a_km: f64| -> f64 {
        if !a_km.is_finite() || a_km <= RE { return 0.0; }
        let h_km = a_km - RE;
        let rho = lerp_rho(h_km, alt_grid_km, rho_grid_kg_m3) * rho_scale; // kg/m³
        // v in m/s
        let v_ms = (mu_km3_s2 * 1.0e9 / (a_km * 1000.0)).sqrt();
        let a_m  = a_km * 1000.0;
        let da_dt_ms = -bc_m2_per_kg * rho * v_ms * a_m;   // m/s
        da_dt_ms / 1000.0                                  // km/s
    };

    let mut out = Vec::with_capacity(n_out * DRAG_STRIDE);
    let mut a = a0_km;
    let mut t_s = 0.0_f64;
    let mut next_emit_s = 0.0_f64;

    // Emit initial state
    {
        let h = a - RE;
        let v_kms = (mu_km3_s2 / a).sqrt();
        let dadt = f_da_dt(a);
        out.extend_from_slice(&[0.0, a, h, v_kms, dadt * 86400.0]);
        next_emit_s += out_stride_s;
    }

    let max_steps = (horizon_s / dt).ceil() as usize + 1;
    for _ in 0..max_steps {
        if t_s >= horizon_s { break; }
        let h = if t_s + dt > horizon_s { horizon_s - t_s } else { dt };

        // Classic RK4 on a (single-state ODE).
        let k1 = f_da_dt(a);
        let k2 = f_da_dt(a + 0.5 * h * k1);
        let k3 = f_da_dt(a + 0.5 * h * k2);
        let k4 = f_da_dt(a + h * k3);
        a += (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
        t_s += h;

        if a <= RE + 80.0 {
            // Re-entered; emit a final NaN burst so JS can highlight it.
            out.extend_from_slice(&[t_s / 60.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN]);
            return Ok(out);
        }

        while t_s + 1e-9 >= next_emit_s && next_emit_s <= horizon_s {
            let h_alt = a - RE;
            let v_kms = (mu_km3_s2 / a).sqrt();
            let dadt = f_da_dt(a);
            out.extend_from_slice(&[next_emit_s / 60.0, a, h_alt, v_kms, dadt * 86400.0]);
            next_emit_s += out_stride_s;
        }
    }

    Ok(out)
}

#[wasm_bindgen]
pub fn drag_stride() -> usize { DRAG_STRIDE }

/// Compute osculating Keplerian elements from a TLE at one specific time.
/// Returns a JSON-friendly object usable directly by JS.
#[wasm_bindgen]
pub fn osculating_elements_at(
    line1: &str,
    line2: &str,
    tsince_min: f64,
) -> Result<JsValue, JsValue> {
    let tle = parse_tle(line1, line2).map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle).map_err(|e| JsValue::from_str(&e))?;
    let (p, v) = sgp4_propagate(&state, tsince_min).map_err(|e| JsValue::from_str(&e))?;

    let r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    let r = r2.sqrt();
    let s2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    let s = s2.sqrt();

    let inv_a = 2.0 / r - s2 / MU;
    let sma_km = if inv_a.abs() > 1e-12 { 1.0 / inv_a } else { f64::NAN };

    let hx = p[1] * v[2] - p[2] * v[1];
    let hy = p[2] * v[0] - p[0] * v[2];
    let hz = p[0] * v[1] - p[1] * v[0];
    let h2 = hx * hx + hy * hy + hz * hz;
    let h = h2.sqrt();

    let ev_x = (v[1] * hz - v[2] * hy) / MU - p[0] / r;
    let ev_y = (v[2] * hx - v[0] * hz) / MU - p[1] / r;
    let ev_z = (v[0] * hy - v[1] * hx) / MU - p[2] / r;
    let ecc = (ev_x * ev_x + ev_y * ev_y + ev_z * ev_z).sqrt();

    let inc_rad = if h > 0.0 { (hz / h).clamp(-1.0, 1.0).acos() } else { f64::NAN };

    // RAAN: angle from x-axis to ascending node line n = ẑ × ĥ
    let nx = -hy;
    let ny = hx;
    let n_mag = (nx * nx + ny * ny).sqrt();
    let raan_rad = if n_mag > 1e-12 {
        let ang = (nx / n_mag).clamp(-1.0, 1.0).acos();
        if ny < 0.0 { TWOPI - ang } else { ang }
    } else { 0.0 };

    // arg perigee: angle from n to e_vec
    let argp_rad = if n_mag > 1e-12 && ecc > 1e-9 {
        let dot = (nx * ev_x + ny * ev_y) / (n_mag * ecc);
        let ang = dot.clamp(-1.0, 1.0).acos();
        if ev_z < 0.0 { TWOPI - ang } else { ang }
    } else { 0.0 };

    // true anomaly: angle from e_vec to r
    let true_anom_rad = if ecc > 1e-9 {
        let dot = (ev_x * p[0] + ev_y * p[1] + ev_z * p[2]) / (ecc * r);
        let ang = dot.clamp(-1.0, 1.0).acos();
        let rdotv = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
        if rdotv < 0.0 { TWOPI - ang } else { ang }
    } else { 0.0 };

    let perigee_alt_km = sma_km * (1.0 - ecc) - RE;
    let apogee_alt_km  = sma_km * (1.0 + ecc) - RE;
    let period_min = if sma_km.is_finite() && sma_km > 0.0 {
        TWOPI * (sma_km.powi(3) / MU).sqrt() / 60.0
    } else { f64::NAN };

    let obj = serde_wasm_bindgen::to_value(&OscElements {
        sma_km,
        ecc,
        inc_deg: inc_rad / DEG2RAD,
        raan_deg: raan_rad / DEG2RAD,
        arg_perigee_deg: argp_rad / DEG2RAD,
        true_anomaly_deg: true_anom_rad / DEG2RAD,
        perigee_alt_km,
        apogee_alt_km,
        period_min,
        speed_km_s: s,
        radius_km: r,
        altitude_km: r - RE,
    }).map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
    Ok(obj)
}

#[derive(serde::Serialize)]
struct OscElements {
    sma_km: f64,
    ecc: f64,
    inc_deg: f64,
    raan_deg: f64,
    arg_perigee_deg: f64,
    true_anomaly_deg: f64,
    perigee_alt_km: f64,
    apogee_alt_km: f64,
    period_min: f64,
    speed_km_s: f64,
    radius_km: f64,
    altitude_km: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omm_and_tle_inputs_share_the_same_sgp4_path() {
        let line1 = "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927";
        let line2 = "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537";
        let from_tle = parse_tle(line1, line2).expect("valid reference TLE");
        let from_omm = elements_from_omm(
            100_147,
            from_tle.epoch_jd,
            from_tle.bstar,
            from_tle.incl / DEG2RAD,
            from_tle.raan / DEG2RAD,
            from_tle.ecc,
            from_tle.argp / DEG2RAD,
            from_tle.mean_anom / DEG2RAD,
            from_tle.mean_motion * MIN_PER_DAY / TWOPI,
            from_tle.rev_num,
        ).expect("valid OMM elements");

        assert_eq!(from_omm.norad_id, 100_147);
        let tle_state = sgp4_init(&from_tle).expect("TLE SGP4 init");
        let omm_state = sgp4_init(&from_omm).expect("OMM SGP4 init");
        let (tle_pos, tle_vel) = sgp4_propagate(&tle_state, 60.0).expect("TLE propagate");
        let (omm_pos, omm_vel) = sgp4_propagate(&omm_state, 60.0).expect("OMM propagate");
        for i in 0..3 {
            assert!((tle_pos[i] - omm_pos[i]).abs() < 1e-9);
            assert!((tle_vel[i] - omm_vel[i]).abs() < 1e-12);
        }
    }

    // ── Vallado et al. 2006 verification (tests/fixtures/sgp4/SOURCES.md) ──
    // Every published row of every case, in TEME km and km/s. This is the
    // gate the old hand-rolled kernel never had: its only test compared the
    // TLE and OMM entry points with EACH OTHER, so a kernel 5 260 km wrong at
    // epoch passed it.
    const VER_TLE: &str = include_str!("../../tests/fixtures/sgp4/SGP4-VER.TLE");
    const VER_OUT: &str = include_str!("../../tests/fixtures/sgp4/tcppver.out");

    /// (norad, [t, x, y, z, vx, vy, vz] per row), in file order.
    fn reference_cases() -> Vec<(u32, Vec<[f64; 7]>)> {
        let mut cases: Vec<(u32, Vec<[f64; 7]>)> = Vec::new();
        for line in VER_OUT.lines() {
            let tok: Vec<&str> = line.split_whitespace().collect();
            if tok.len() == 2 && tok[1] == "xx" {
                cases.push((tok[0].parse().expect("case id"), Vec::new()));
            } else if tok.len() >= 7 {
                let mut row = [0.0; 7];
                for (i, v) in tok[..7].iter().enumerate() { row[i] = v.parse().expect("number"); }
                cases.last_mut().expect("row before first case").1.push(row);
            }
        }
        cases
    }

    /// (line1, line2 truncated to 69 columns) in file order.
    fn verification_tles() -> Vec<(String, String)> {
        let lines: Vec<&str> = VER_TLE.lines().filter(|l| !l.starts_with('#')).collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i + 1 < lines.len() {
            if lines[i].starts_with("1 ") && lines[i + 1].starts_with("2 ") {
                out.push((lines[i][..69].to_string(), lines[i + 1][..69].to_string()));
                i += 2;
            } else { i += 1; }
        }
        out
    }

    /// Rows the reference prints that we REFUSE instead, each asserted to be
    /// an error (never a silently different number). 33334 is Vallado's
    /// "try and check error code 2" case, a 0.00001 rev/day orbit whose
    /// perturbed eccentricity is −122 at epoch. The C code prints one t = 0
    /// state before failing at t = 1; the sgp4 crate (and so this kernel)
    /// refuses at t = 0, which its own reference records as "diverging
    /// perturbed eccentricity". Refusing a non-physical element set lets JS
    /// fall back instead of drawing a fictitious orbit.
    const KNOWN_REFUSALS: &[(u32, f64)] = &[(33334, 0.0)];

    #[test]
    fn matches_vallado_2006_verification_vectors() {
        let cases = reference_cases();
        let tles = verification_tles();
        assert_eq!(cases.len(), tles.len(), "one reference case per TLE");
        assert!(cases.len() >= 30, "the full verification set, not a subset");

        let (mut rows, mut worst_r, mut worst_v) = (0usize, 0.0f64, 0.0f64);
        let mut failures = Vec::new();
        for ((norad, ref_rows), (l1, l2)) in cases.iter().zip(tles.iter()) {
            assert_eq!(l1[2..7].trim().parse::<u32>().ok(), Some(*norad), "cases stay aligned");
            let state = match parse_tle(l1, l2).and_then(|e| sgp4_init(&e)) {
                Ok(s) => s,
                Err(e) => {
                    if !ref_rows.is_empty() { failures.push(format!("{norad}: init failed ({e}) but reference has {} rows", ref_rows.len())); }
                    continue;
                }
            };
            for r in ref_rows {
                if KNOWN_REFUSALS.contains(&(*norad, r[0])) {
                    if sgp4_propagate(&state, r[0]).is_ok() {
                        failures.push(format!("{norad} t={}: expected a refusal, got a state", r[0]));
                    }
                    continue;
                }
                match sgp4_propagate(&state, r[0]) {
                    Ok((p, v)) => {
                        let dr = ((p[0] - r[1]).powi(2) + (p[1] - r[2]).powi(2) + (p[2] - r[3]).powi(2)).sqrt();
                        let dv = ((v[0] - r[4]).powi(2) + (v[1] - r[5]).powi(2) + (v[2] - r[6]).powi(2)).sqrt();
                        worst_r = worst_r.max(dr);
                        worst_v = worst_v.max(dv);
                        rows += 1;
                        // 1 m and 1 mm/s. The reference prints 8 decimals of km
                        // and 9 of km/s; this leaves room only for float
                        // ordering differences between two correct codes.
                        if dr > 1e-3 || dv > 1e-6 {
                            failures.push(format!("{norad} t={}: |dr| {:.6} km, |dv| {:.9} km/s", r[0], dr, dv));
                        }
                    }
                    Err(e) => failures.push(format!("{norad} t={}: propagate failed ({e}) but the reference has a row", r[0])),
                }
            }
        }
        eprintln!("Vallado verification: {} cases, {} rows, worst |dr| {:.3e} km, worst |dv| {:.3e} km/s", cases.len(), rows, worst_r, worst_v);
        assert!(failures.is_empty(), "{} mismatches, first 10:\n{}", failures.len(), failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
        assert!(rows > 500, "compared {rows} rows");
    }

    #[test]
    fn omm_validation_rejects_non_physical_elements() {
        let result = elements_from_omm(
            100_147, 2_461_000.5, 0.0, 51.6, 0.0,
            1.2, 0.0, 0.0, 15.5, 1,
        );
        assert!(result.is_err());
    }
}
