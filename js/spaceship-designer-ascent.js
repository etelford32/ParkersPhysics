/**
 * spaceship-designer-ascent.js — PURE guided ascent for the Space Ship Designer.
 * No DOM, no three.js; node-tested by tests/spaceship-designer.mjs.
 *
 * WHY THIS IS NOT launch-physics.simulateAscent: that integrator's single-stage
 * path is what the Launch / Mission Planners are calibrated against, so it must
 * stay bit-identical. Its staged path (the designer's, until 2026-10) had no
 * engine cut-off: it burned until altitude ≥ target AND speed ≥ circular at the
 * same instant. Measured on the default rocket that meant 1.9 km/s of "steering
 * loss" on Earth (climb to 213 km, burn horizontally, fall back to 119 km) and,
 * on every airless world, flying straight past orbit — the Moon run ended at
 * 2.87 km/s where circular is 1.59 and lunar ESCAPE is 2.25, and was graded
 * "Orbit with margin to spare".
 *
 * This one flies what real launchers fly — a two-burn insertion:
 *
 *   ascent      programmed gravity turn — vertical, then pitch(h) =
 *               90°·cos(90°·h/h_turn), horizontal above h_turn — until the
 *               osculating APOAPSIS reaches the target: main-engine cut-off
 *               (MECO-1). A solid motor cannot shut down, so a solid stage
 *               keeps burning past MECO-1 and overshoots — honestly.
 *
 * THE TURN ALTITUDE IS OPTIMISED PER VEHICLE (`optimizedAscent`): a 1-D search
 * over h_turn keeps the trajectory that reaches orbit with the most Δv left.
 * A fixed h_turn is wrong for almost every vehicle — 95 km lofted the default
 * rocket so steeply that MECO-1 came at 83 km and 1.3 km/s horizontal, and the
 * low-thrust upper stage then owed 6.5 km/s at apoapsis while falling. Two
 * closed-loop alternatives were tried and REJECTED, measured on the eight
 * launch bodies: altitude-rate guidance cut at semi-major axis = target
 * (coasted to 470–540 km on four worlds) and a proportional apoapsis hold
 * (escaped every airless world, and re-entered on Earth at Mach 20). The
 * search is deterministic and costs ~15 runs of a few ms each.
 *
 * WITH AIR THERE IS A SECOND FAMILY, and it usually wins (2026-10): a pitch
 * KICK at V_KICK_MS and then a ZERO-α GRAVITY TURN — the attitude follows the
 * velocity, so the stack meets the air nose-first through max-Q. The cosine
 * program kept the default rocket within 2° of vertical up to 12 km (real
 * launchers are well into the turn by max-Q): 1.33 km/s of steering loss and
 * 9.93 km/s to LEO, against 0.84 and 9.04 for the turn. The optimiser flies
 * BOTH families and keeps the better; the cosine one still wins in a strong
 * headwind (a steeper climb meets less q) and on airless worlds.
 *   An open-loop gravity turn is SENSITIVE to its kick (orbit for ~2.5–3.2°
 * on the default rocket; flatter breaks up at max-Q, steeper runs dry), so the
 * kick scan is dense (KICK_SCAN_N) — read the note at KICK_BOUNDS.
 *
 * THE WIND (spaceship-designer-wind.js) adds the loads that decide real
 * launch days: q·α, the bending load. The steering wind-biases into the air it
 * has MEASURED (a 2.5 s loop), switched in with dynamic pressure (at low q a
 * headwind would "need" 19° of pitch-over and the turn ran away flat), with
 * only PARTIAL in-plane relief (LOAD_RELIEF: full relief in a headwind is a
 * flattening runaway — measured), a bounded yaw into the crosswind (a cosine
 * thrust loss), and LOAD-LIMITED commands (never more than 80 % of the q·α
 * limit, never more than ALPHA_MAX in real air — the don't-sink guard once
 * stood a slow upper stage on its tail at q = 28 kPa). What the loop cannot
 * fly out — shear and gusts — is the α it reports; q·α past
 * Q_BREAKUP_FACTOR × the limit is a bending breakup, past the limit itself an
 * orbit a range would have scrubbed (`loads.exceeded`).
 *
 *   coast       unpowered, prograde attitude, up to apoapsis. If the burn
 *               reached the target apoapsis while at PERIAPSIS (a flat
 *               gravity turn often does — it is a Hohmann-like insertion) and
 *               that periapsis is clear of the air, it coasts the half orbit
 *               up to the real apoapsis; vr ≤ 0 used to fire the burn on the
 *               wrong side of the orbit. Vacuum coast steps grow to
 *               COAST_DT_MAX and use RK4 (first-order Euler walked a periapsis
 *               12 km at that step).
 *   circularize ignites so the burn straddles apoapsis (t_to_apo ≤ t_burn/2)
 *               and steers to null the radial rate until the speed reaches
 *               circular — the orbit's periapsis rises to meet the apoapsis.
 *
 * and it reports what actually happened, from the ORBIT, not the last speed:
 *   orbit       periapsis above the atmosphere (above_atm) → status 'orbit'
 *   escape      specific orbital energy ≥ 0 → 'escape' (no orbit at all)
 *   fuel-out    propellant gone before periapsis clears the atmosphere
 *   breakup     dynamic pressure past Q_BREAKUP_FACTOR × the airframe limit —
 *               the max-Q governor can only throttle to `throttle_min`, so an
 *               over-powered booster in a dense atmosphere (Titan) tears itself
 *               apart instead of flying through 4× its rated load unnoticed
 *   no-liftoff  still on the pad after HOLD_S: thrust at the SURFACE pressure
 *               below weight (on Venus a Merlin's nozzle cannot push against
 *               92 bar at all — F = F_vac − pₐ·Aₑ is negative)
 *   crashed     came back down after leaving the pad
 *
 * The force model (thrust F = F_vac − pₐAₑ, governors, Mach-dependent drag
 * against co-rotating air, launch-site rotation, staging with a brief coast)
 * is the staged path's, transcribed — only the guidance and the reporting are
 * new — plus the WIND (air-relative speed now includes it). Integration is
 * semi-implicit Euler at dt = 0.1 s through powered flight and the air, and
 * RK4 at up to COAST_DT_MAX on vacuum coasts.
 *
 * Loss accounting (textbook): Δv_used = (v_final − v_rot) + ∫g·sinγ dt
 * + ∫D/m dt + steering, with the gravity integral over the WHOLE flight (on a
 * coast gravity trades speed for height, which is part of the bill).
 */

import { atmosphericDensity, atmosphericPressure, speedOfSound, surfaceRotationSpeed } from './launch-physics.js';
import { windAt, makeGustField, steeringLag, seedFrom, QALPHA_LIMIT_KPA_DEG, DEFAULT_WIND } from './spaceship-designer-wind.js';

const G0 = 9.80665;
export const Q_BREAKUP_FACTOR = 1.5;      // ultimate / limit load — the usual 1.4–1.5 structural factor
const HOLD_S = 6;                         // seconds on the pad before "no liftoff" is declared
// An orbit counts as reaching the TARGET only if its periapsis is within 10 %
// of it. Without this the turn optimiser found the cheapest "orbit" was a 4 km
// skim over Mercury, and a periapsis grazing the 100 km line over Earth.
export const TARGET_FRACTION = 0.9;
// Gravity turn (worlds with air): the pitch-over starts once the vehicle is
// moving through the air at V_KICK_MS, takes KICK_S, and from then on the
// attitude FOLLOWS the air-relative velocity (zero angle of attack) — the
// loads come only from what the steering loop cannot follow (wind module).
export const V_KICK_MS = 50;
const KICK_S = 8;
const ALPHA_MAX = (15 * Math.PI) / 180;   // controllable angle of attack in air
const COAST_DT_MAX = 2;                   // s — RK4 there: metres per half orbit
const Q_BIAS_PA = 4000;
const LOAD_RELIEF = 0.5;                  // share of the in-plane wind α the steering gives back                   // q at which wind steering is fully in
const YAW_MAX = (15 * Math.PI) / 180;    // wind-bias yaw authority

/** Osculating 2D orbit from polar state (SI). apo_r is Infinity when unbound. */
export function orbitElements(mu, r, vr, vt) {
    const v2 = vr * vr + vt * vt;
    const energy = v2 / 2 - mu / r;
    const h = r * vt;
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
    if (energy >= 0) return { energy, h, e, a: Infinity, peri_r: (h * h / mu) / (1 + e), apo_r: Infinity };
    const a = -mu / (2 * energy);
    return { energy, h, e, a, peri_r: a * (1 - e), apo_r: a * (1 + e) };
}

/**
 * Lowest periapsis (km) that counts as an orbit: where the body's own
 * exponential atmosphere thins to RHO_ORBIT_FLOOR. One rule for every world
 * instead of per-class constants — it gives Earth ≈ 100 km (the Kármán line),
 * Mars ≈ 84 km, Venus ≈ 250 km and Titan ≈ 263 km (whose cold, low-gravity
 * air has a 20 km scale height; the old flat 90 km called a Titan orbit at
 * 200 km "orbit" while it sat in air at 0.03 kg/m³). Airless worlds: 0.
 */
export const RHO_ORBIT_FLOOR = 1e-5;   // kg/m³
export function atmosphereTopKm(body) {
    if (!(body.rho0_kg_m3 > RHO_ORBIT_FLOOR)) return 0;
    return (body.H_km || 8.5) * Math.log(body.rho0_kg_m3 / RHO_ORBIT_FLOOR);
}

/** Default turn altitude per atmosphere class (the optimiser's starting point). */
export function defaultTurnAlt(body) {
    return body.rho0_kg_m3 > 1 ? 95_000 : body.rho0_kg_m3 > 0.01 ? 35_000 : 8_000;
}

/** Search bounds for the turn altitude (m): thin air lets the turn come early. */
function turnBounds(body, target_m) {
    const lo = body.rho0_kg_m3 > 1 ? 25_000 : body.rho0_kg_m3 > 1e-6 ? 5_000 : 1_000;
    const hi = Math.max(lo * 4, Math.min(target_m * 1.2, body.rho0_kg_m3 > 1 ? 250_000 : 150_000));
    return [lo, hi];
}

/** Rank a run: an orbit beats everything (by Δv left), then how close it came. */
function score(res) {
    const loadsOut = res.loads?.exceeded ? 3e5 : 0;       // a range would scrub it: prefer any in-envelope flight
    if (res.status === 'orbit') return 1e6 - loadsOut + res.remaining_dv_kms * 1000;
    if (res.status === 'low-orbit') return 5e5 + res.orbit.peri_km;
    if (res.status === 'breakup' || res.status === 'no-liftoff') return -1e6 + (res.max_alt_km || 0);
    const vf = res.final_vt_kms / Math.max(1e-6, res.v_orb_circ_kms);
    return vf * 1000 + Math.min(res.final_alt_km, res.target_alt_km);
}

/**
 * The flight this vehicle would actually fly: guidedAscent with the turn
 * altitude that scores best — a coarse log-spaced scan, then a golden-section
 * refine around the winner. Deterministic. The result carries `turn_alt_km`
 * and `turn_search` (how many runs it took) for the page to disclose.
 */
export function optimizedAscent({ body, vehicle, target_alt_km = 200 }) {
    const target_m = target_alt_km * 1000;
    const runs = new Map();
    const fly = (profile, x0) => {
        const x = profile === 'cosine' ? Math.round(x0) : +x0.toFixed(4);   // canonical: the cache key IS the run
        const key = profile + ':' + (profile === 'cosine' ? Math.round(x) : x.toFixed(4));
        if (!runs.has(key)) {
            runs.set(key, guidedAscent({ body, vehicle: cloneVehicle(vehicle), target_alt_km, profile, record: false,
                turn_alt_m: profile === 'cosine' ? Math.round(x) : null, kick_deg: profile === 'cosine' ? null : x }));
        }
        return runs.get(key);
    };
    // Every profile is a 1-D search: a coarse log-spaced scan, then a
    // golden-section refine (in log x) between the winner's neighbours.
    const search = (profile, lo, hi, N = 9) => {
        const xs = [];
        let best = null, bestX = lo, bestI = 0;
        for (let i = 0; i < N; i++) {
            const x = lo * Math.pow(hi / lo, i / (N - 1));
            xs.push(x);
            const res = fly(profile, x);
            if (!best || score(res) > score(best)) { best = res; bestX = x; bestI = i; }
        }
        let a = Math.log(xs[Math.max(0, bestI - 1)]), b = Math.log(xs[Math.min(N - 1, bestI + 1)]);
        const gr = (Math.sqrt(5) - 1) / 2;
        let c = b - gr * (b - a), d = a + gr * (b - a);
        for (let k = 0; k < 8; k++) {
            const fc = score(fly(profile, Math.exp(c))), fd = score(fly(profile, Math.exp(d)));
            if (fc >= fd) { b = d; d = c; c = b - gr * (b - a); } else { a = c; c = d; d = a + gr * (b - a); }
        }
        for (const x of [Math.exp(c), Math.exp(d)]) {
            const res = fly(profile, x);
            if (score(res) > score(best)) { best = res; bestX = x; }
        }
        return { best, x: bestX };
    };
    const [lo, hi] = turnBounds(body, target_m);
    let pick = search('cosine', lo, hi);
    // With air there is a second family: a pitch kick and a zero-α gravity turn.
    if (body.rho0_kg_m3 > 1e-6) {
        const gt = search('gravity-turn', KICK_BOUNDS[0], KICK_BOUNDS[1], KICK_SCAN_N);
        if (score(gt.best) > score(pick.best)) pick = gt;
    }
    // Re-fly the winner WITH its trajectory (deterministic: same numbers).
    const best = guidedAscent({ body, vehicle: cloneVehicle(vehicle), target_alt_km, profile: pick.best.profile,
        turn_alt_m: pick.best.profile === 'cosine' ? Math.round(pick.x) : null,
        kick_deg: pick.best.profile === 'cosine' ? null : pick.x });
    return { ...best,
             turn_alt_km: best.profile === 'cosine' ? pick.x / 1000 : null,
             kick_deg: best.profile === 'gravity-turn' ? pick.x : null,
             turn_search: runs.size };
}
// Degrees. An open-loop gravity turn is SENSITIVE: the default rocket reaches
// orbit only for kicks in ~2.5–3.2° (a ratio of 1.28) — below, it lofts and
// runs dry; above, it flattens into thick air and exceeds max-Q. The scan's
// step ratio (12/0.3)^(1/14) = 1.30 is set so it cannot step over a window
// like that; widen the bounds and you must add points.
const KICK_BOUNDS = [0.3, 12];
const KICK_SCAN_N = 15;

function cloneVehicle(v) {
    return { ...v, stages: v.stages.map((s) => ({ ...s })) };
}

/**
 * @param {object} p
 *   body, vehicle: { stages:[{propMass_kg, dryMass_kg, F_sl_N, F_vac_N, mdot_kgs,
 *   Isp_vac_s, throttle, throttleable}], payload_kg, Cd (number|fn(M,v,alt,ρ)), A_m2,
 *   launch_lat_deg, accel_limit_g, q_limit_kPa, throttle_min, stage_coast_s },
 *   target_alt_km
 */
export function guidedAscent({ body, vehicle, target_alt_km = 200, profile = 'cosine', turn_alt_m = null, kick_deg = 3,
                              dt_s = 0.1, max_t_s = 8000, record = true }) {
    const R = body.R_km * 1000, mu = body.mu_km3s2 * 1e9;
    const target_m = target_alt_km * 1000;
    const atmTop_km = atmosphereTopKm(body);
    const stages = vehicle.stages.map((s) => ({
        prop: s.propMass_kg, dry: s.dryMass_kg, F_sl: s.F_sl_N, F_vac: s.F_vac_N,
        mdot: s.mdot_kgs, ispVac: s.Isp_vac_s, throttle: s.throttle ?? 1, throttleable: s.throttleable !== false,
        Ae: Math.max(0, (s.F_vac_N - s.F_sl_N) / 101325),
    }));
    const payload = vehicle.payload_kg || 0;
    const coastAfterStaging = vehicle.stage_coast_s ?? 2.5;
    const accelLimit = (vehicle.accel_limit_g || 0) > 0 ? vehicle.accel_limit_g * G0 : Infinity;
    const qLimit = (vehicle.q_limit_kPa || 0) * 1000;
    const throttleMin = vehicle.throttle_min ?? 0.4;
    const cdIsFn = typeof vehicle.Cd === 'function';
    const aSound = speedOfSound(body);
    const vRot = vehicle.launch_lat_deg != null ? surfaceRotationSpeed(body, vehicle.launch_lat_deg) : 0;

    // Gravity-turn horizon: the optimiser's choice, or a per-atmosphere default.
    const hFull = turn_alt_m ?? defaultTurnAlt(body);
    const gravityTurn = profile === 'gravity-turn';
    const kickRad = ((kick_deg ?? 3) * Math.PI) / 180;
    let kickT0 = null, kickLocked = false;

    // The air: mean wind + a frozen gust field + the steering loop's lag.
    const windSetting = vehicle.wind?.setting ?? DEFAULT_WIND;
    const air = { bodyId: body.id, setting: windSetting,
                  field: makeGustField(vehicle.wind?.seed ?? seedFrom(`${body.id}:${windSetting}`)) };
    const lag = steeringLag(vehicle.wind?.tau_s);
    const qaLimit = vehicle.qalpha_limit_kPa_deg ?? QALPHA_LIMIT_KPA_DEG;
    let maxQA = 0, maxQAAlt = 0, maxQAT = 0, maxQAAlpha = 0, maxWind = 0;

    let r = R, theta = 0, vr = 0, vt = vRot;
    let m = payload + stages.reduce((a, s) => a + s.prop + s.dry, 0);
    const m0 = m;
    let t = 0, si = 0, coastLeft = 0, phase = 'ascent', step = 0;
    let maxAlt = 0, leftPad = false;
    let dvUsed = 0, gravLoss = 0, dragLoss = 0;
    let maxQ = 0, maxQAlt = 0, maxQT = 0, maxMach = 0, maxDrag = 0, maxDragAlt = 0, maxAccel = 0;
    let meco1 = null, circStart = null, circDv = 0, burns = 1, solidOvershoot = false;
    let status = null, reason = '';
    const staging = [];
    const traj = [];
    let lastPitch = Math.PI / 2;
    let lastSampledPhase = null;

    const activeStage = () => (si < stages.length ? stages[si] : null);
    const thrustAt = (st, p_a) => Math.max(0, st.F_vac - p_a * st.Ae);

    while (t < max_t_s) {
        // Step: dt_s, except on a vacuum coast far from the circularisation
        // burn, where it grows to COAST_DT_MAX (a half-orbit coast to a real
        // apoapsis is ~45 min — 27 000 steps at 0.1 s per optimiser trial).
        let h = dt_s;
        const alt = r - R;
        const v = Math.hypot(vr, vt);
        const fpa = v > 1e-9 ? Math.atan2(vr, vt) : Math.PI / 2;
        const g = mu / (r * r);
        const el = orbitElements(mu, r, vr, vt);

        // ── Air ─────────────────────────────────────────────────────────────
        const rho = atmosphericDensity(body, alt);
        const p_a = atmosphericPressure(body, alt);
        const vAir = vRot * (r / R);
        const inAir = rho > 1e-7;
        const w = inAir ? windAt(air, alt) : { along: 0, cross: 0, speed: 0, gustAlong: 0, gustCross: 0 };
        const wf = lag.step(w, h);                            // what the steering flies into
        if (w.speed > maxWind && rho > 1e-4) maxWind = w.speed;
        const vtRel = vt - vAir - w.along;
        const vRelPlane = Math.hypot(vr, vtRel);
        const vRel = Math.hypot(vRelPlane, w.cross);
        const q = 0.5 * rho * vRel * vRel;
        if (q > maxQ) { maxQ = q; maxQAlt = alt / 1000; maxQT = t; }
        const mach = aSound > 0 ? vRel / aSound : 0;
        if (mach > maxMach && rho > 1e-4) maxMach = mach;
        const Cd = cdIsFn ? vehicle.Cd(mach, vRel, alt, rho) : vehicle.Cd;
        const D = q * Cd * vehicle.A_m2;
        if (D > maxDrag) { maxDrag = D; maxDragAlt = alt / 1000; }
        const dr = vRel > 1e-9 ? -D * vr / vRel : 0;
        const dtn = vRel > 1e-9 ? -D * vtRel / vRel : 0;

        if (qLimit > 0 && q > Q_BREAKUP_FACTOR * qLimit) {
            status = 'breakup';
            reason = `Dynamic pressure reached ${(q / 1000).toFixed(0)} kPa — ${Q_BREAKUP_FACTOR}× the ${(qLimit / 1000).toFixed(0)} kPa airframe limit. `
                + 'The max-Q governor can only throttle to ' + Math.round(throttleMin * 100) + ' %.';
            pushSample(true);
            break;
        }

        // ── Guidance: phase transitions ─────────────────────────────────────
        const st = activeStage();
        const apoAlt = el.apo_r - R;
        if (phase === 'ascent' && leftPad && apoAlt >= target_m) {
            if (st && !st.throttleable && st.prop > 0) solidOvershoot = true;   // a solid cannot shut down
            else { phase = 'coast'; meco1 = t; }
        }
        if (phase === 'coast') {
            // Drag can sag the apoapsis while still in the air: relight and top up.
            if (rho > 1e-7 && apoAlt < target_m - 2000 && vr > 0) phase = 'ascent';
            else {
                const sNext = st || null;
                if (!sNext) { phase = 'done'; }
                else {
                    const aThr = Math.max(1e-6, (sNext.F_vac * sNext.throttle) / m);
                    const vAtApo = el.h / el.apo_r;
                    const need = Math.sqrt(mu / el.apo_r) - vAtApo;
                    const tBurn = need / aThr;
                    const gEff = g - (vt * vt) / r;
                    const tToApo = gEff > 1e-6 ? vr / gEff : Infinity;
                    // vr ≤ 0 means "at or past apoapsis" — unless the burn ended
                    // at PERIAPSIS (a flat ascent reaching the target apoapsis
                    // while still low): then, if that periapsis is already clear
                    // of the air, coast the half orbit up to the real apoapsis.
                    const atPeri = vr <= 0 && el.apo_r - r > 0.25 * (el.apo_r - el.peri_r) && el.peri_r - R > atmTop_km * 1000;
                    if (!atPeri && (vr <= 0 || tToApo <= tBurn / 2)) { phase = 'circularize'; circStart = t; burns++; }
                    else if (rho < 1e-9) {
                        const slack = atPeri ? 0.25 * period(mu, el.a) : tToApo - tBurn / 2;
                        h = Math.min(COAST_DT_MAX, Math.max(dt_s, slack / 20));
                    }
                }
            }
        }
        if (phase === 'circularize' && vt >= Math.sqrt(mu / r)) phase = 'done';
        if (phase === 'done' || el.energy >= 0 && leftPad && phase !== 'ascent') {
            pushSample(false);
            break;
        }

        // ── Attitude ────────────────────────────────────────────────────────
        let pitch;
        const aThrNominal = st ? (thrustAt(st, p_a) * st.throttle) / m : 0;
        // Air-relative flight-path angle against the wind the loop has caught up
        // with — the wind term switching in WITH DYNAMIC PRESSURE (load relief).
        // At low q the vehicle flies the ordinary ground-relative turn: a 17 m/s
        // headwind at 50 m/s would otherwise "need" 19° of pitch-over and the
        // turn runs away flat (measured: q 53 kPa at 5 km).
        // In plane only PARTIAL relief (LOAD_RELIEF of the wind's α): the full
        // zero-α turn in a headwind points the nose lower, which flattens the
        // path, which raises q — a runaway (measured: every kick broke up at
        // 7 km in a 72 m/s headwind). The ground-relative turn is the shape;
        // the wind only leans on it.
        const bias = smooth01(q / Q_BIAS_PA);
        const vtRelF = vt - vAir - bias * wf.along;
        const fpaGround = Math.atan2(vr, vt - vAir);
        const airFpaF = fpaGround + LOAD_RELIEF * (Math.atan2(vr, vtRelF) - fpaGround);
        if (phase === 'ascent' && gravityTurn) {
            if (kickT0 === null && alt >= 100 && Math.hypot(vr, vtRelF) >= V_KICK_MS) kickT0 = t;
            if (kickT0 === null) pitch = Math.PI / 2;
            else {
                const kickPitch = Math.PI / 2 - kickRad;
                const f = Math.min(1, (t - kickT0) / KICK_S);
                if (f < 1 || (!kickLocked && airFpaF > kickPitch)) pitch = Math.PI / 2 - kickRad * f;
                else {
                    kickLocked = true;
                    // Zero α in the air; prograde in vacuum; blended across the upper atmosphere.
                    const wAir = 1 - smooth01((alt / 1000 - 0.5 * atmTop_km) / Math.max(1, 0.5 * atmTop_km));
                    pitch = wAir * airFpaF + (1 - wAir) * fpa;
                }
            }
            if (vr < 0 && aThrNominal > 0) {
                const hold = Math.asin(Math.min(1, Math.max(0, (g - vt * vt / r) / aThrNominal)));
                pitch = Math.max(pitch, hold);
            }
        } else if (phase === 'ascent') {
            if (alt < 100) pitch = Math.PI / 2;
            else if (alt < hFull) pitch = (Math.PI / 2) * Math.cos((Math.PI / 2) * (alt / hFull));
            else pitch = 0;
            // Never thrust the vehicle into the ground: while it is sinking,
            // pitch up enough to hold altitude (net gravity / thrust accel).
            if (vr < 0 && aThrNominal > 0) {
                const hold = Math.asin(Math.min(1, Math.max(0, (g - vt * vt / r) / aThrNominal)));
                pitch = Math.max(pitch, hold);
            }
        } else if (phase === 'circularize') {
            const net = g - vt * vt / r;                         // what the burn must hold up
            const k = aThrNominal > 0 ? (net - vr / 20) / aThrNominal : 0;   // and null vr over ~20 s
            pitch = Math.max(-0.6, Math.min(0.6, Math.asin(Math.max(-1, Math.min(1, k)))));
        } else {
            pitch = fpa;                                         // coasting: hold prograde
        }
        // Load-limited guidance: never COMMAND an angle of attack the airframe
        // cannot carry (q·α ≤ 80 % of the limit), nor more than ALPHA_MAX in
        // any real air (a finned stack is not controllable past that; the
        // cosine program otherwise flew Mars's thin air at 62°). Without this
        // the don't-sink guard stood a flat, slow upper stage on its tail at
        // q = 28 kPa.
        // Gated on the vehicle's OWN airspeed: on the pad a strong gust alone
        // makes 200+ Pa, and clamping the attitude to it there tipped the
        // stack over (measured).
        if (phase !== 'coast' && q > 50 && Math.hypot(vr, vt - vAir) > 100) {
            const aMax = Math.min(ALPHA_MAX, ((0.8 * qaLimit) / (q / 1000)) * Math.PI / 180);
            const ref = Math.atan2(vr, vtRel);
            pitch = Math.max(ref - aMax, Math.min(ref + aMax, pitch));
        }
        lastPitch = pitch;
        // Wind bias: yaw into the cross wind the loop has measured, while in air.
        // Only once q has built (on the pad a 4 m/s breeze would "need" 76° of
        // yaw), and bounded.
        const vPlaneF = Math.hypot(vr, vtRelF);
        const yaw = inAir && steersIntoWind(phase)
            ? clampAbs(Math.atan2(-wf.cross, Math.max(1, vPlaneF)), YAW_MAX) * bias
            : 0;

        // Angle of attack: vehicle axis vs the REAL air-relative velocity (3D).
        let alpha = 0;
        if (vRel > 1) {
            const ax = Math.sin(pitch) * Math.cos(yaw), at_ = Math.cos(pitch) * Math.cos(yaw), ay = Math.sin(yaw);
            const c = (ax * vr + at_ * vtRel + ay * (-w.cross)) / vRel;
            alpha = Math.acos(Math.max(-1, Math.min(1, c)));
        }
        const qAlpha = (q / 1000) * (alpha * 180 / Math.PI);       // kPa·deg
        if (qAlpha > maxQA) { maxQA = qAlpha; maxQAAlt = alt / 1000; maxQAT = t; maxQAAlpha = alpha * 180 / Math.PI; }
        if (leftPad && qAlpha > Q_BREAKUP_FACTOR * qaLimit) {
            status = 'breakup';
            reason = `Aerodynamic bending: q·α reached ${qAlpha.toFixed(0)} kPa·° at ${(alt / 1000).toFixed(1)} km `
                + `(α ${(alpha * 180 / Math.PI).toFixed(1)}° at q ${(q / 1000).toFixed(1)} kPa) — ${Q_BREAKUP_FACTOR}× the ${qaLimit.toFixed(0)} kPa·° limit. `
                + 'The steering could not turn into the wind fast enough.';
            pushSample(true, { q, mach, D, Cd, rho, pitch, alpha, qAlpha, w, yaw });
            break;
        }

        // ── Thrust ──────────────────────────────────────────────────────────
        let T = 0, mdot = 0, isp = 0, throttleCmd = 0;
        const powered = (phase === 'ascent' || phase === 'circularize') && coastLeft <= 0 && st;
        if (powered) {
            let F = thrustAt(st, p_a);
            let gov = 1;
            if (st.throttleable && F > 0) {
                if (F / m > accelLimit) gov = Math.min(gov, accelLimit * m / F);
                if (qLimit > 0 && q > qLimit * 0.7) gov = Math.min(gov, 1 - 0.35 * (q - qLimit * 0.7) / (qLimit * 0.3));
                gov = Math.max(throttleMin, Math.min(1, gov));
            }
            F *= gov;
            T = F; mdot = st.mdot * gov;
            isp = mdot > 0 ? F / (mdot * G0) : 0;
            throttleCmd = gov * st.throttle;
        }
        const accelG = m > 0 ? (T / m) / G0 : 0;
        if (T > 0 && accelG > maxAccel) maxAccel = accelG;
        const twr = T > 0 ? T / (m * g) : 0;

        // ── Integrate (semi-implicit Euler, polar, inertial) ───────────────
        const tr = T * Math.sin(pitch) * Math.cos(yaw), tt = T * Math.cos(pitch) * Math.cos(yaw);
        const ar = (tr + dr) / m - g + (vt * vt) / r;
        const at = (tt + dtn) / m - (vr * vt) / r;
        gravLoss += g * Math.sin(fpa) * h;
        dragLoss += (D / m) * h;
        if (h > dt_s && T === 0) {
            // Long vacuum-coast step: RK4 on the pure two-body polar equations.
            // Semi-implicit Euler is first order in ω·h — at h = 2 s it walked a
            // 130 km periapsis up to 142 km over a half-orbit coast (measured).
            [r, theta, vr, vt] = rk4Coast(mu, r, theta, vr, vt, h);
        } else {
            vr += ar * h; vt += at * h;
            // Held down on the pad until thrust beats weight (no sinking through it).
            if (!leftPad && r + vr * h <= R) { vr = 0; } else leftPad = leftPad || (r + vr * h > R + 0.5);
            r += vr * h;
            theta += (vt / r) * h;
        }
        maxAlt = Math.max(maxAlt, r - R);

        // ── Mass + staging ──────────────────────────────────────────────────
        if (T > 0 || (powered && mdot > 0)) {
            dvUsed += (T / m) * h;
            const burn = mdot * h;
            st.prop -= burn; m -= burn;
            if (phase === 'circularize') circDv += (T / m) * h;
            if (st.prop <= 0) {
                m -= st.prop; st.prop = 0;                       // no negative propellant
                staging.push({ stage: si + 1, t, alt_km: (r - R) / 1000, v_kms: Math.hypot(vr, vt) / 1000 });
                si++;
                if (si < stages.length) { m -= st.dry; coastLeft = coastAfterStaging; }
            }
        } else if (coastLeft > 0) coastLeft -= h;

        // Sampled after the state update but before the clock ticks, so the
        // ground track subtracts the site's rotation over t + dt.
        // Every 10th step — and at every phase change, so a 0.6 s
        // circularisation trim still appears in the record (and the playback).
        const phaseNow = coastLeft > 0 ? 'staging' : phase;
        if (step % 10 === 0 || phaseNow !== lastSampledPhase) pushSample(false, { T, isp, twr, accelG, throttleCmd, q, mach, D, Cd, rho, pitch, alpha, qAlpha, w, yaw, tAhead: h });
        t += h; step++;

        // ── Terminal conditions ────────────────────────────────────────────
        if (!leftPad && t >= HOLD_S) {
            status = 'no-liftoff';
            const F0 = st ? thrustAt(st, body.p0_pa || 0) : 0;
            reason = F0 <= 0
                ? `The engines produce no thrust against ${body.name}'s ${((body.p0_pa || 0) / 1e5).toFixed(1)} bar surface pressure — the exhaust cannot get out of the nozzle.`
                : `Thrust at the surface is ${(F0 / (m * g)).toFixed(2)}× the vehicle's weight — it never leaves the pad.`;
            break;
        }
        if (leftPad && r - R < -50) { status = 'crashed'; reason = 'Came back down before reaching orbit.'; break; }
        if (si >= stages.length && phase !== 'done') { pushSample(false); break; }   // all propellant spent
    }

    // ── Outcome ─────────────────────────────────────────────────────────────
    const elF = orbitElements(mu, r, vr, vt);
    const periAlt = (elF.peri_r - R) / 1000, apoAlt = (elF.apo_r - R) / 1000;
    if (!status) {
        if (elF.energy >= 0) {
            status = 'escape';
            reason = solidOvershoot
                ? 'A solid stage cannot shut down: it kept burning past orbital speed and carried the vehicle out of orbit entirely.'
                : 'Specific orbital energy ≥ 0 — the vehicle is leaving, not orbiting.';
        } else if (periAlt > atmTop_km && periAlt >= TARGET_FRACTION * target_alt_km) status = 'orbit';
        else if (periAlt > atmTop_km) {
            status = 'low-orbit';
            reason = `In orbit, but its periapsis (${periAlt.toFixed(0)} km) is short of the ${target_alt_km.toFixed(0)} km target.`;
        }
        else if (si >= stages.length) {
            status = 'fuel-out';
            reason = periAlt < 0 ? 'Out of propellant on a suborbital arc.' : 'Out of propellant with periapsis still inside the atmosphere.';
        } else status = 'time-out';
    }

    // Δv still aboard: what is left in the active stage + every later stage,
    // stage by stage with vacuum Isp (the rocket equation — the number that
    // decides where this vehicle can go next).
    let mm = m, dvRem = 0;
    const remStages = [];
    for (let i = si; i < stages.length; i++) {
        const s = stages[i];
        const dv = s.prop > 0 ? s.ispVac * G0 * Math.log(mm / (mm - s.prop)) : 0;
        remStages.push({ stage: i + 1, prop_kg: s.prop, dv_kms: dv / 1000 });
        dvRem += dv; mm -= s.prop;
        if (i < stages.length - 1) mm -= s.dry;
    }

    const vF = Math.hypot(vr, vt);
    const vCircF = Math.sqrt(mu / r);
    return {
        body: body.name, body_id: body.id, status, reason, time_s: t,
        guidance: 'insertion', profile, target_alt_km, max_alt_km: maxAlt / 1000,
        // Back-compatible headline fields (the page's result card reads these).
        final_alt_km: (r - R) / 1000,
        final_vt_kms: vt / 1000,
        v_orb_circ_kms: vCircF / 1000,
        dv_used_kms: dvUsed / 1000,
        dv_grav_loss_kms: gravLoss / 1000,
        dv_drag_loss_kms: dragLoss / 1000,
        dv_steer_loss_kms: Math.max(0, dvUsed - (vF - vRot) - gravLoss - dragLoss) / 1000,
        dv_rotation_kms: vRot / 1000, v_rotation_kms: vRot / 1000,
        launch_lat_deg: vehicle.launch_lat_deg || 0,
        accel_limit_g: vehicle.accel_limit_g || 0, max_accel_g: maxAccel,
        q_limit_kPa: vehicle.q_limit_kPa || 0,
        max_q_kPa: maxQ / 1000, max_q_alt_km: maxQAlt, max_q_t_s: maxQT, max_mach: maxMach,
        max_drag_kN: maxDrag / 1000, max_drag_alt_km: maxDragAlt,
        fuel_burned_kg: m0 - m,
        staging_events: staging,
        // New: the orbit actually achieved, and how it was reached.
        orbit: { peri_km: periAlt, apo_km: Number.isFinite(apoAlt) ? apoAlt : Infinity, e: elF.e,
                 energy: elF.energy, a_km: Number.isFinite(elF.a) ? elF.a / 1000 : Infinity },
        insertion: { meco1_t: meco1, circ_start_t: circStart, circ_dv_kms: circDv / 1000, burns: meco1 != null ? burns : 1,
                     solid_overshoot: solidOvershoot },
        atmosphere_top_km: atmTop_km,
        loads: { max_qalpha_kPa_deg: maxQA, alt_km: maxQAAlt, t_s: maxQAT, alpha_deg: maxQAAlpha,
                 limit_kPa_deg: qaLimit, exceeded: maxQA > qaLimit, wind: windSetting, max_wind_ms: maxWind },
        remaining_dv_kms: dvRem / 1000, remaining_stages: remStages, final_mass_kg: m,
        trajectory: traj,
    };

    function pushSample(final, f = {}) {
        if (!record) return;                    // optimiser trials: the score needs no trajectory
        lastSampledPhase = coastLeft > 0 ? 'staging' : phase;
        const alt = r - R, v = Math.hypot(vr, vt);
        const el = orbitElements(mu, r, vr, vt);
        const st2 = activeStage();
        traj.push({
            t, alt_km: alt / 1000, v_kms: v / 1000, vr_kms: vr / 1000, vt_kms: vt / 1000,
            q_kPa: (f.q ?? 0) / 1000, mach: f.mach ?? 0, cd: f.Cd ?? 0, drag_kN: (f.D ?? 0) / 1000, rho: f.rho ?? 0,
            mass_frac: m / m0,
            thrust_kN: (f.T ?? 0) / 1000, isp_s: f.isp ?? 0, twr: f.twr ?? 0, accel_g: f.accelG ?? 0,
            stage: Math.min(si + 1, stages.length),
            coasting: !((f.T ?? 0) > 0),
            phase: coastLeft > 0 ? 'staging' : phase,
            throttle: f.throttleCmd ?? 0,
            dv_used_kms: dvUsed / 1000,
            pitch_deg: ((f.pitch ?? lastPitch) * 180) / Math.PI,
            fpa_deg: (Math.atan2(vr, vt) * 180) / Math.PI,
            alpha_deg: ((f.alpha ?? 0) * 180) / Math.PI, qalpha: f.qAlpha ?? 0, yaw_deg: ((f.yaw ?? 0) * 180) / Math.PI,
            wind_along_ms: f.w?.along ?? 0, wind_cross_ms: f.w?.cross ?? 0,
            gust_ms: Math.hypot(f.w?.gustAlong ?? 0, f.w?.gustCross ?? 0),
            downrange_km: (theta - (vRot / R) * (t + (f.tAhead ?? 0))) * R / 1000,
            apo_km: Number.isFinite(el.apo_r) ? (el.apo_r - R) / 1000 : Infinity,
            peri_km: (el.peri_r - R) / 1000,
            stage_prop_kg: st2 ? st2.prop : 0,
            final,
        });
    }
}

function smooth01(x) {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
}
// Attitude phases that steer into the wind (the coast holds prograde too —
// an unpowered vehicle in air still weathervanes into it).
function steersIntoWind(phase) { return phase === 'ascent' || phase === 'circularize' || phase === 'coast'; }
function clampAbs(x, m) { return Math.max(-m, Math.min(m, x)); }
function period(mu, a) { return 2 * Math.PI * Math.sqrt(Math.max(0, a) ** 3 / mu); }

/** One RK4 step of unpowered, drag-free motion in polar coordinates. */
function rk4Coast(mu, r, th, vr, vt, h) {
    const f = (r1, vr1, vt1) => [vr1, vt1 / r1, -mu / (r1 * r1) + (vt1 * vt1) / r1, -(vr1 * vt1) / r1];
    const k1 = f(r, vr, vt);
    const k2 = f(r + h / 2 * k1[0], vr + h / 2 * k1[2], vt + h / 2 * k1[3]);
    const k3 = f(r + h / 2 * k2[0], vr + h / 2 * k2[2], vt + h / 2 * k2[3]);
    const k4 = f(r + h * k3[0], vr + h * k3[2], vt + h * k3[3]);
    const c = (i) => (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    return [r + c(0), th + c(1), vr + c(2), vt + c(3)];
}
