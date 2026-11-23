/**
 * chicxulub/impact-model.js — the FORWARD model: impactor → crater → effects.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no fetch, no ambient time, no Math.random). Node-gated by
 * tests/chicxulub.mjs. SI units inside; the names say when a value is in km.
 *
 * WHAT THIS IS. Scaling laws — the Collins, Melosh & Marcus (2005) "Earth
 * Impact Effects Program" set — plus three things derived here from first
 * principles (ballistic ejecta flight, the iridium budget, an energy-balance
 * climate box). It is NOT a hydrocode: no shock physics, no target layering,
 * no water column, no crater collapse dynamics. It answers "what size of
 * event is this" to tens of per cent, which is what the inversion needs.
 *
 * THE SCALING COEFFICIENTS ARE RECALLED, NOT CHECKED (`SCALING.verified` is
 * false): the paper hosts were egress-blocked at build time. The gate checks
 * what can be checked without the paper — exponent identities, limits, and
 * that published Chicxulub impactors land on the observed crater.
 *
 * WHAT IS LEFT OUT, ON PURPOSE:
 *   · atmospheric entry — a ≥5 km body loses < 0.1 % of its speed (its mass per
 *     unit area is ~1000× the atmosphere's column);
 *   · the 0.1–2 km of sea water — thin beside a ≥10 km impactor;
 *   · the 3 km sediment layer's lower strength and density (one crustal ρ).
 */

import { EBM_HEAT_CAPACITY, EBM_FEEDBACK } from '../volcano-engine.js';

export const G0 = 9.81;                       // m s⁻²
export const R_EARTH = 6_371_000;             // m
export const MU_EARTH = 3.986004418e14;       // m³ s⁻²
export const A_EARTH = 4 * Math.PI * R_EARTH * R_EARTH;
export const V_ESC = Math.sqrt(2 * MU_EARTH / R_EARTH);     // 11 186 m/s
export const J_PER_MT = 4.184e15;
export const SIGMA_SB = 5.670374e-8;
export const SEISMIC_SPEED = 5000;             // m/s — first strong ground motion, the timeline's one value
export const SOUND_SPEED = 330;                // m/s — the air blast
const RAD = Math.PI / 180;

export const SCALING = Object.freeze({
    verified: false,
    source: 'Collins, Melosh & Marcus 2005, Meteoritics & Planet. Sci. 40, 817 (recalled)',
    transientCoeff: 1.161,        // D_tc = c (ρi/ρt)^⅓ L^0.78 v^0.44 g^−0.22 sin^⅓θ   (SI)
    expL: 0.78, expV: 0.44, expG: -0.22,
    simpleToComplexKm: 3.2,       // D_c on Earth
    finalCoeff: 1.17,             // D_fr = 1.17 D_tc^1.13 / D_c^0.13
    finalExp: 1.13,
    depthRatio: 1 / (2 * Math.SQRT2),   // transient depth / diameter
    excavationRatio: 0.1,         // maximum excavation depth / transient diameter
    meltCoeff: 8.9e-12,           // V_melt = c E sinθ   (m³, J)
    ejectaCoeff: 112,             // t = D_tc⁴ / (112 r³)
    seismicA: 0.67, seismicB: -5.87,   // M = 0.67 log10 E − 5.87  (seismic efficiency 10⁻⁴)
    fireballCoeff: 0.002,         // R_f = 0.002 E^⅓   (m, J)
    luminousEfficiency: 3e-3,     // fraction of E radiated as heat
    fireballTempK: 3000,
});

// ── 1. The body ─────────────────────────────────────────────────────────────
export function impactorMass(diameterM, density) { return Math.PI / 6 * density * diameterM ** 3; }
export function kineticEnergy(massKg, speed) { return 0.5 * massKg * speed * speed; }
export function diameterFromMass(massKg, density) { return Math.cbrt(6 * massKg / (Math.PI * density)); }
/** Speed far from Earth for a given speed at the ground (energy conservation). */
export function vInfinity(vImpact) { return vImpact > V_ESC ? Math.sqrt(vImpact * vImpact - V_ESC * V_ESC) : 0; }

// ── 2. The crater ───────────────────────────────────────────────────────────
/** Transient crater diameter (m). θ is the angle to the HORIZONTAL in degrees. */
export function transientDiameter({ diameterM, speed, angleDeg = 90, density, targetDensity = 2700, g = G0 }) {
    const S = SCALING;
    return S.transientCoeff * Math.cbrt(density / targetDensity) * diameterM ** S.expL
        * speed ** S.expV * g ** S.expG * Math.cbrt(Math.sin(angleDeg * RAD));
}
/** Final rim-to-rim diameter (m) of a complex crater from its transient diameter. */
export function finalDiameter(transientM) {
    const S = SCALING, Dc = S.simpleToComplexKm * 1000;
    if (transientM * 1.25 < Dc) return 1.25 * transientM;        // simple crater
    return S.finalCoeff * transientM ** S.finalExp / Dc ** (S.finalExp - 1);
}
export function transientFromFinal(finalM) {
    const S = SCALING, Dc = S.simpleToComplexKm * 1000;
    return (finalM * Dc ** (S.finalExp - 1) / S.finalCoeff) ** (1 / S.finalExp);
}
export function meltVolume(energyJ, angleDeg) { return SCALING.meltCoeff * energyJ * Math.sin(angleDeg * RAD); }

// ── 3. Ejecta ───────────────────────────────────────────────────────────────
/** Continuous ejecta blanket thickness (m) at distance r (m) from the centre. */
export function ejectaThickness(transientM, rM) {
    if (!(rM > transientM / 2)) return null;                      // inside the transient cavity
    return transientM ** 4 / (SCALING.ejectaCoeff * rM ** 3);
}

/**
 * Ballistic flight over a spherical Earth, launched at 45°, landing at great-
 * circle distance rM. Derived here from the Kepler ellipse (no fitted law):
 * launch and landing are symmetric about apogee, so the launch true anomaly is
 * ν₀ = π − Δ/2 with Δ = r/R; the speed that gives it is found by bisection and
 * the flight time is twice the Kepler time from ν₀ to apogee.
 * Returns { speed, timeS, apogeeM } or null beyond the antipode / at escape.
 */
export function ballisticFlight(rM, { elevDeg = 45 } = {}) {
    const delta = rM / R_EARTH;
    if (!(delta > 0) || delta >= 2 * Math.PI) return null;
    const half = Math.min(delta, 2 * Math.PI - delta) / 2;
    const ce = Math.cos(elevDeg * RAD);
    const orbit = (v) => {
        const eps = v * v / 2 - MU_EARTH / R_EARTH;
        const h = R_EARTH * v * ce;
        const a = -MU_EARTH / (2 * eps);
        const e = Math.sqrt(Math.max(0, 1 + 2 * eps * h * h / (MU_EARTH * MU_EARTH)));
        const cosNu = (a * (1 - e * e) / R_EARTH - 1) / e;       // at the surface
        return { a, e, cosNu };
    };
    // range half-angle grows monotonically with v below escape
    let lo = 1, hi = V_ESC * 0.99999;
    const halfOf = (v) => { const o = orbit(v); return Math.PI - Math.acos(Math.max(-1, Math.min(1, o.cosNu))); };
    if (halfOf(hi) < half) return null;
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (halfOf(mid) < half) lo = mid; else hi = mid; }
    const v = (lo + hi) / 2, { a, e, cosNu } = orbit(v);
    const nu0 = Math.acos(Math.max(-1, Math.min(1, cosNu)));
    const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
    const M0 = E0 - e * Math.sin(E0);
    const n = Math.sqrt(MU_EARTH / (a * a * a));
    return { speed: v, timeS: 2 * (Math.PI - M0) / n, apogeeM: a * (1 + e) - R_EARTH };
}

// ── 4. Iridium ──────────────────────────────────────────────────────────────
/** Global iridium fluence (ng/cm²) if a fraction fDep of the body's Ir is spread evenly. */
export function iridiumFluence({ massKg, abundanceNgG, fDep = 1 }) {
    return massKg * 1000 * abundanceNgG * fDep / (A_EARTH * 1e4);
}
/** Impactor mass (kg) a measured global fluence implies. */
export function massFromIridium({ fluenceNgCm2, abundanceNgG, fDep = 1 }) {
    return fluenceNgCm2 * A_EARTH * 1e4 / (abundanceNgG * fDep) / 1000;
}

// ── 5. Ground, air, sea ─────────────────────────────────────────────────────
export function seismicMagnitude(energyJ) { return SCALING.seismicA * Math.log10(energyJ) + SCALING.seismicB; }
export function fireballRadius(energyJ) { return SCALING.fireballCoeff * Math.cbrt(energyJ); }
/**
 * Direct thermal exposure (J/m²) from the fireball at distance r, zero beyond
 * the fireball's horizon. NOTE: for an event this size most of the planet's
 * heating is NOT this — it is re-entering ejecta (reentryHeating below).
 */
export function thermalExposure(energyJ, rM) {
    const Rf = fireballRadius(energyJ);
    const horizon = R_EARTH * Math.acos(R_EARTH / (R_EARTH + Rf));
    if (rM > horizon) return 0;
    return SCALING.luminousEfficiency * energyJ / (2 * Math.PI * rM * rM);
}
/**
 * Air blast by cube-root yield scaling from a 1 kt surface burst. Yield
 * scaling assumes a uniform atmosphere; a 10⁸ Mt fireball is far taller than
 * the atmosphere's scale height, so beyond a few thousand km this is an
 * ORDER-OF-MAGNITUDE figure and the caller must say so.
 */
export function airBlast(energyJ, rM) {
    const kt = energyJ / (J_PER_MT / 1000);
    const r1 = rM / Math.cbrt(kt);
    const px = 75_000, rx = 290, P0 = 101_325, c0 = SOUND_SPEED;
    const p = px * rx / (4 * r1) * (1 + 3 * (rx / r1) ** 1.3);
    const wind = 5 * p / (7 * P0) * c0 / Math.sqrt(1 + 6 * p / (7 * P0));
    return { overpressurePa: p, windMs: wind, arrivalS: rM / c0 };
}
/**
 * Re-entering ejecta: the global spherule layer falls back through the upper
 * atmosphere over ~an hour and radiates its kinetic energy. Returns the
 * time-mean flux at the TOP of the atmosphere; the ground receives less (half
 * is radiated upward, and the first spherules shade the later ones — Goldin &
 * Melosh 2009), so this is an UPPER bound, labelled as one.
 */
export function reentryHeating({ layerMm = 3, layerDensity = 2500, porosity = 0.5, speed = 7000, durationS = 3600 } = {}) {
    const kgM2 = layerMm / 1000 * layerDensity * (1 - porosity);
    const jM2 = 0.5 * kgM2 * speed * speed;
    return { kgM2, jM2, fluxWm2: jM2 / durationS, solarConstants: jM2 / durationS / 1361 };
}
/** Long-wave tsunami: shallow-water speed and 1/r spreading from a published anchor. */
export function tsunamiAt(rM, { depthM = 4000, anchorHeightM = 1500, anchorRadiusM = 220e3, anchorTimeS = 600 } = {}) {
    if (rM <= anchorRadiusM) return { heightM: anchorHeightM, arrivalS: anchorTimeS * rM / anchorRadiusM };
    const c = Math.sqrt(G0 * depthM);
    return { heightM: anchorHeightM * anchorRadiusM / rM, arrivalS: anchorTimeS + (rM - anchorRadiusM) / c, speedMs: c };
}

// ── 6. The forward bundle ───────────────────────────────────────────────────
/** Great-circle distance (m) between two lat/lon points. */
export function greatCircle(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function forward({ diameterKm, speedKms, angleDeg = 60, density = 2200, targetDensity = 2700, abundanceNgG = 595, fDep = 1 }) {
    const L = diameterKm * 1000, v = speedKms * 1000;
    const mass = impactorMass(L, density), energy = kineticEnergy(mass, v);
    const Dtc = transientDiameter({ diameterM: L, speed: v, angleDeg, density, targetDensity });
    const Dfr = finalDiameter(Dtc);
    return {
        input: { diameterKm, speedKms, angleDeg, density, targetDensity, abundanceNgG, fDep },
        massKg: mass, energyJ: energy, megatons: energy / J_PER_MT, vInfKms: vInfinity(v) / 1000,
        transientKm: Dtc / 1000, transientDepthKm: Dtc * SCALING.depthRatio / 1000,
        excavationDepthKm: Dtc * SCALING.excavationRatio / 1000,
        finalKm: Dfr / 1000, meltKm3: meltVolume(energy, angleDeg) / 1e9,
        seismicM: seismicMagnitude(energy), fireballKm: fireballRadius(energy) / 1000,
        iridiumNgCm2: iridiumFluence({ massKg: mass, abundanceNgG, fDep }),
    };
}

/** What a place at great-circle distance rKm experiences, in order of arrival. */
export function effectsAt(fwd, rKm) {
    const r = rKm * 1000, E = fwd.energyJ, Dtc = fwd.transientKm * 1000;
    const flight = ballisticFlight(r);
    const blast = airBlast(E, r);
    const thick = ejectaThickness(Dtc, r);
    return {
        rKm,
        insideCrater: r < fwd.finalKm * 500,
        thermalJm2: thermalExposure(E, r),
        seismic: { arrivalS: r / SEISMIC_SPEED, magnitude: fwd.seismicM },
        ejecta: { thicknessM: thick, arrivalS: flight?.timeS ?? null, launchKms: flight ? flight.speed / 1000 : null,
                  apogeeKm: flight ? flight.apogeeM / 1000 : null },
        blast,
        tsunami: tsunamiAt(r),
    };
}

// ── 7. Climate ──────────────────────────────────────────────────────────────
// Shortwave mass extinction, m² per g of aerosol. Typical values, recalled.
export const EXTINCTION_M2_G = Object.freeze({ soot: 10, 'fine silicate dust': 0.7, 'sulfate aerosol': 3.5, verified: false });
export const ABSORBED_SOLAR = 240;            // W m⁻², global mean
export const DARK_THRESHOLD = 0.01;           // light fraction below which photosynthesis stops
export const MEAN_COS_ZENITH = 0.5;
// Heat capacity of 1 m of sea water, W yr m⁻² K⁻¹. NOT area-weighted by the
// ocean's 71 %: this is the convention under which the volcano engine's
// C = 8 is "a ~60 m mixed layer", so the two boxes speak the same depth.
export const OCEAN_W_YR_PER_M = 1025 * 3990 / 3.156e7;

/** Initial global-mean optical depth of an aerosol load spread evenly. */
export function opticalDepth(massTg, agent) {
    const k = EXTINCTION_M2_G[agent];
    if (!(k > 0)) return null;
    return massTg * 1e12 / A_EARTH * k;        // Tg → g, ÷ m², × m²/g
}
/**
 * Light reaching the ground, τ(t) = τ₀ e^(−t/ℓ). The e-folding time ℓ is NOT
 * modelled: it is DERIVED from the published duration of darkness (the GCMs
 * carry the coagulation and fallout physics a box cannot), so the box
 * reproduces that duration by construction and predicts only the temperature.
 */
export function lifetimeFromDarkness(tau0, darkYears, threshold = DARK_THRESHOLD) {
    const tauDark = -Math.log(threshold) * MEAN_COS_ZENITH;
    if (!(tau0 > tauDark) || !(darkYears > 0)) return null;
    return darkYears / Math.log(tau0 / tauDark);
}
export function lightFraction(tau0, lifetimeYr, tYr) {
    return Math.exp(-tau0 * Math.exp(-tYr / lifetimeYr) / MEAN_COS_ZENITH);
}
/**
 * One-box energy balance, C dT/dt = −S (1 − light) − λT, integrated exactly
 * per step for a piecewise-constant forcing (the volcano engine's rule; C and
 * λ default to ITS constants so the two pages share one climate box).
 */
export function impactWinter({ tau0, lifetimeYr, years = 30, dt = 1 / 48, heatCapacity = EBM_HEAT_CAPACITY, feedback = EBM_FEEDBACK, co2ForcingWm2 = 0 }) {
    const n = Math.round(years / dt), decay = Math.exp(-feedback * dt / heatCapacity);
    const t = new Float64Array(n + 1), T = new Float64Array(n + 1), light = new Float64Array(n + 1);
    light[0] = lightFraction(tau0, lifetimeYr, 0);
    let peak = 0, peakAt = 0, darkEnd = null, back1K = null;
    for (let i = 0; i < n; i++) {
        const tm = (i + 0.5) * dt;
        const F = -ABSORBED_SOLAR * (1 - lightFraction(tau0, lifetimeYr, tm)) + co2ForcingWm2;
        const Teq = F / feedback;
        T[i + 1] = Teq + (T[i] - Teq) * decay;
        t[i + 1] = (i + 1) * dt;
        light[i + 1] = lightFraction(tau0, lifetimeYr, t[i + 1]);
        if (T[i + 1] < peak) { peak = T[i + 1]; peakAt = t[i + 1]; }
        if (darkEnd == null && light[i] < DARK_THRESHOLD && light[i + 1] >= DARK_THRESHOLD) darkEnd = t[i + 1];
        if (back1K == null && t[i + 1] > peakAt && peak < -1 && T[i + 1] > -1) back1K = t[i + 1];
    }
    return { t, T, light, peakCoolingK: -peak, peakAtYr: peakAt, darkYears: darkEnd, recoveredYr: back1K };
}
/**
 * The heat capacity the box needs to land on a published peak cooling, and
 * the depth of ocean that corresponds to. The default box (a ~60 m mixed
 * layer) over-cools several-fold; the GCMs' answer implies a much deeper
 * layer of ocean gave up its heat — that depth is the result here.
 */
export function impliedOceanDepth({ tau0, lifetimeYr, targetCoolingK, feedback = EBM_FEEDBACK }) {
    let lo = 1, hi = 4000;
    const at = (C) => impactWinter({ tau0, lifetimeYr, heatCapacity: C, feedback, years: 40 }).peakCoolingK;
    if (at(lo) < targetCoolingK || at(hi) > targetCoolingK) return null;
    for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (at(mid) > targetCoolingK) lo = mid; else hi = mid; }
    const C = Math.sqrt(lo * hi);
    return { heatCapacity: C, oceanDepthM: C / OCEAN_W_YR_PER_M };
}
/**
 * TWO LAYERS, so the surface can recover. The one box above gets the DEPTH of
 * the cold right only by handing the whole ~300 m its heat capacity, and then
 * warms that whole layer back at once — decades. A real ocean is not
 * symmetric: a surface colder than the water under it SINKS (the column mixes,
 * which is why so deep a layer gave up its heat), while a surface warmer than
 * the water under it FLOATS and is only weakly tied to it.
 *
 *   surface layer  C_s (the volcano engine's ~60 m)   takes the forcing
 *   lower layer    C_d = C_total − C_s
 *   surface colder  → mixed to one temperature at once (convective adjustment)
 *   surface warmer  → exchange γ (T_s − T_d), `LAYERED.stableExchange`
 *
 * While the planet cools the two layers are one box of C_total, so the peak
 * cooling is the one box's EXACTLY (gated) and `impliedOceanDepth` still
 * applies. What is new is the way back, and it rests on γ, which is RECALLED
 * (the deep-ocean exchange of two-layer fits to climate models, ~0.7) and not
 * checked. γ → ∞ is the one box again.
 *
 * MEASURED 2026-11-23, AND IT DOES NOT GIVE A RECOVERY — so the page does not
 * use this and still claims none. At 30 yr the surface is −3.0 … −6.0 K across
 * γ = 0.3 … 1.5 (one box: −7.3 K); even with the layers cut apart (γ = 0) the
 * surface alone e-folds on C_s/λ = 6.7 yr and needs ~14 yr to come within 2 K.
 * The limit is the ocean surface's own heat capacity over the feedback, not
 * the deep water. A fast recovery needs LAND (almost no heat capacity) as its
 * own box, and that needs the published land/ocean split to anchor it — do
 * not add a land box on a recalled split. Kept as the gate's record.
 */
export const LAYERED = Object.freeze({ stableExchange: 0.7, exchangeRange: Object.freeze([0.3, 1.5]), recoveredWithinK: 2, verified: false });
export function impactWinterLayered({ tau0, lifetimeYr, totalHeatCapacity, years = 30, dt = 1 / 192, surfaceHeatCapacity = EBM_HEAT_CAPACITY,
    feedback = EBM_FEEDBACK, stableExchange = LAYERED.stableExchange, co2ForcingWm2 = 0, withinK = LAYERED.recoveredWithinK }) {
    const Cs = Math.min(surfaceHeatCapacity, totalHeatCapacity), Cd = totalHeatCapacity - Cs, Ct = totalHeatCapacity;
    const n = Math.round(years / dt);
    const t = new Float64Array(n + 1), T = new Float64Array(n + 1), Tdeep = new Float64Array(n + 1), light = new Float64Array(n + 1);
    light[0] = lightFraction(tau0, lifetimeYr, 0);
    let Ts = 0, Td = 0, peak = 0, peakAt = 0, recovered = null, restratified = null, heatIn = 0;
    for (let i = 0; i < n; i++) {
        const F = -ABSORBED_SOLAR * (1 - lightFraction(tau0, lifetimeYr, (i + 0.5) * dt)) + co2ForcingWm2;
        const net = F - feedback * Ts;                       // W m⁻² into the column
        const ex = Cd > 0 && Ts > Td ? stableExchange * (Ts - Td) : 0;
        heatIn += net * dt;
        if (Cd > 0) { Ts += (net - ex) * dt / Cs; Td += ex * dt / Cd; } else Ts += net * dt / Cs;
        if (Cd > 0 && Ts < Td) Ts = Td = (Cs * Ts + Cd * Td) / Ct;      // unstable: mix
        else if (Cd > 0 && restratified == null && Ts > Td + 1e-9) restratified = (i + 1) * dt;
        t[i + 1] = (i + 1) * dt; T[i + 1] = Ts; Tdeep[i + 1] = Td;
        light[i + 1] = lightFraction(tau0, lifetimeYr, t[i + 1]);
        if (Ts < peak) { peak = Ts; peakAt = t[i + 1]; }
        if (recovered == null && t[i + 1] > peakAt && peak < -withinK && Ts > -withinK) recovered = t[i + 1];
        if (recovered != null && Ts < -withinK) recovered = null;
    }
    return { t, T, Tdeep, light, peakCoolingK: -peak, peakAtYr: peakAt, restratifiedYr: restratified, recoveredYr: recovered,
             heatBalanceError: Math.abs(Cs * Ts + Cd * Td - heatIn) / Math.max(1e-9, Math.abs(Ct * peak)), stableExchange };
}
/** CO₂ added to the air → forcing (Myhre 1998) on a stated background. */
export function co2Forcing(co2Gt, backgroundPpm = 600) {
    const ppm = co2Gt / 7.81;
    return { addedPpm: ppm, forcingWm2: 5.35 * Math.log((backgroundPpm + ppm) / backgroundPpm), backgroundPpm };
}
