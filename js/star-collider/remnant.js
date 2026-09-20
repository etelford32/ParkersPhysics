/**
 * star-collider/remnant.js — what a merger leaves behind (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything after contact: the remnant, what it throws out, and what that
 * ejecta would look like from Earth. None of this is simulated here — the
 * SPH stage does the hydrodynamics — these are the CALIBRATED FITS the
 * field uses to read a merger off its masses, spins and compactness, each
 * cited, each with its domain of validity, and the page reports which
 * branch it took and why.
 *
 *   BINARY BLACK HOLE
 *     final spin   Barausse & Rezzolla 2009 (aligned-spin fit to NR)
 *     final mass   Barausse, Morozova & Rezzolla 2012's structure with the
 *                  spin bracket calibrated to SXS equal-mass runs (see ERAD)
 *     both use ã = (m₁²χ₁ + m₂²χ₂)/(m₁² + m₂²) and the Kerr ISCO energy.
 *
 *   BINARY NEUTRON STAR
 *     prompt collapse   M_tot > M_th = (2.38 − 3.606 C_max) M_max
 *                       (Bauswein, Baumgarte & Janka 2013; scatter ±0.1 M☉,
 *                       and a result inside that band is reported "marginal")
 *     otherwise         hypermassive (M_tot > 1.2 M_max: survives ~10–100 ms
 *                       on differential rotation), supramassive (rigid
 *                       rotation can hold it; collapses on spin-down), or
 *                       stable (M_tot < M_max). The 1.2 is the rigid-rotation
 *                       limit; the remnant's actual mass is a few % below
 *                       M_tot (GW + ejecta), which is ignored and said so.
 *     dynamical ejecta  Krüger & Foucart 2020 eq. 9
 *     disk mass         Krüger & Foucart 2020 eq. 4 (lighter star's C)
 *     disk wind         a stated fraction of the disk (0.2; Fernández &
 *                       Metzger 2013 find 0.1–0.4)
 *
 *   NEUTRON STAR – BLACK HOLE
 *     remnant baryon mass outside the BH   Foucart, Hinderer & Nissanke 2018
 *     dynamical ejecta                     Kawaguchi+ 2016
 *     → 'disrupted' if anything is left outside the horizon, else
 *       'swallowed' (no electromagnetic counterpart at all — GW200105).
 *
 *   WHITE DWARF + compact companion
 *     Roche-lobe overflow radius (Eggleton 1983) against the companion's
 *     ISCO (BH) or surface (NS): disruption vs. plunge, and whether a
 *     WD+WD pair is over the Chandrasekhar mass.
 *
 *   KILONOVA
 *     one-zone homologous ejecta with r-process heating
 *     q̇ = 2×10¹⁰ erg g⁻¹ s⁻¹ (t/1 d)^{−1.3} × ε_th (Metzger 2017 Living
 *     Reviews, eq. 22–26): dE/dt = Q̇ − E/t − L, L = E/(t_diff + t_lc),
 *     t_diff = 3κM/(4π β c v t) with β = 3 the density-profile geometry
 *     factor of his eq. 3 (without it the peak lands √3 late). Two
 *     components (lanthanide-poor "blue",
 *     lanthanide-rich "red") differ only in κ, v and mass. Pinned against
 *     AT2017gfo's ~10⁴² erg/s at one day.
 *
 *   MAGNETISED NEUTRON STAR
 *     dipole spin-down L = B²R⁶Ω⁴/(6c³); magnetic energy B²R³/6; the
 *     dipole–dipole energy at contact against the orbital binding energy
 *     (which is how you learn that even 10¹⁵ G is a 10⁻⁶ correction).
 *
 * Geometric units inside where masses and radii are involved; cgs for the
 * light curves. Every output object carries `fate`, `branch` and `notes`.
 */

import { GEOM_KM, GEOM_S, G_CGS, C_CGS, MSUN_G } from './eos.js';

const KM_CM = 1e5;
const DAY_S = 86400;
const LSUN = 3.828e33;

// ── Kerr geometry ───────────────────────────────────────────────────────────
/** Prograde ISCO radius in units of M for spin χ ∈ [−1, 1] (negative = retrograde). */
export function kerrIsco(chi) {
    const a = Math.max(-0.9999, Math.min(0.9999, chi));
    const s = a >= 0 ? 1 : -1;
    const aa = Math.abs(a);
    const z1 = 1 + Math.cbrt(1 - aa * aa) * (Math.cbrt(1 + aa) + Math.cbrt(1 - aa));
    const z2 = Math.sqrt(3 * aa * aa + z1 * z1);
    return 3 + z2 - s * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}
/** Specific energy at the ISCO. */
export function iscoEnergy(chi) { return Math.sqrt(1 - 2 / (3 * kerrIsco(chi))); }
/** Outer horizon radius in units of M. */
export function horizonRadius(chi) { return 1 + Math.sqrt(Math.max(0, 1 - chi * chi)); }

// ── Binary black hole ───────────────────────────────────────────────────────
const BR09 = { s4: -0.1229, s5: 0.4537, t0: -2.8904, t2: -3.5171, t3: 2.5763 };
// Radiated energy: the Barausse–Morozova–Rezzolla 2012 STRUCTURE,
//   E_rad/M = [1 − E_ISCO(ã)] η + 4η² [c₀ + c₁ã + c₂ã²],
// with the bracket calibrated here to the SXS equal-mass aligned-spin
// radiated fractions (4.8 % at χ = 0, 6.7 % at 0.5, 9.4 % at 0.8; Hemberger+
// 2013, Healy & Lousto 2017). It over-predicts by ~15 % at χ → 1 and is not
// a substitute for the published multi-parameter fits — it is the spin trend
// the ISCO energy alone under-states, pinned at the three points above.
const ERAD = { c0: 0.1359, c1: 0.0212, c2: 0.158 };

export function bbhRemnant(m1, m2, chi1 = 0, chi2 = 0) {
    const M = m1 + m2, eta = m1 * m2 / (M * M);
    const aT = (m1 * m1 * chi1 + m2 * m2 * chi2) / (m1 * m1 + m2 * m2);
    const { s4, s5, t0, t2, t3 } = BR09;
    const chiF = aT + s4 * aT * aT * eta + s5 * aT * eta * eta + t0 * aT * eta
        + 2 * Math.sqrt(3) * eta + t2 * eta * eta + t3 * eta ** 3;
    const eIsco = iscoEnergy(aT);
    const eRad = (1 - eIsco) * eta + 4 * eta * eta * (ERAD.c0 + ERAD.c1 * aT + ERAD.c2 * aT * aT);
    const finalMass = M * (1 - eRad);
    const finalSpin = Math.max(-0.999, Math.min(0.999, chiF));
    return {
        branch: 'bbh', fate: 'black hole',
        finalMass, finalSpin, radiatedMass: M * eRad, radiatedFraction: eRad,
        radiatedErg: M * eRad * MSUN_G * C_CGS * C_CGS,
        horizonKm: finalMass * horizonRadius(finalSpin) * GEOM_KM,
        iscoKm: finalMass * kerrIsco(finalSpin) * GEOM_KM,
        aTilde: aT,
        notes: ['Final spin: Barausse & Rezzolla 2009 aligned-spin fit; radiated energy: BMR12 structure calibrated to SXS equal-mass aligned-spin runs (4.8/6.7/9.4 % at χ = 0/0.5/0.8).',
            'Aligned spins only — precessing systems get kicks and a different fit.'],
    };
}

// ── Binary neutron star ─────────────────────────────────────────────────────
const KF20_DYN = { a: -9.3335, b: 114.17, c: -337.56, n: 1.5465 };
const KF20_DISK = { a: -8.1324, c: 1.4820, d: 1.7784 };
export const DISK_WIND_FRACTION = 0.2;
export const THRESHOLD_SCATTER = 0.1;   // M☉, Bauswein+2013 fit residual

/** Krüger & Foucart 2020 eq. 9 — dynamical ejecta, M☉. Each star: {M, C}. */
export function bnsDynamicalEjecta(s1, s2) {
    const { a, b, c, n } = KF20_DYN;
    const term = (A, B) => (a / A.C + b * (B.M / A.M) ** n + c * A.C) * A.M;
    return Math.max(0, (term(s1, s2) + term(s2, s1)) * 1e-3);
}
/** Krüger & Foucart 2020 eq. 4 — remnant disk, M☉, from the lighter star's compactness. */
export function bnsDiskMass(s1, s2) {
    const light = s1.M <= s2.M ? s1 : s2;
    const { a, c, d } = KF20_DISK;
    return light.M * Math.max(5e-4, Math.max(0, a * light.C + c) ** d);
}

/**
 * The fate of a BNS merger. `s1`, `s2` are TOV stars ({M, C, R, Lambda, Mb});
 * `mmax` the EOS's maximum-mass star; `mth` the threshold mass.
 */
export function bnsOutcome(s1, s2, mmax, mth) {
    const M = s1.M + s2.M;
    const margin = M - mth;
    let fate, lifetime, detail;
    if (M > mth) {
        fate = 'prompt collapse'; lifetime = '< 1 ms';
        detail = `M_tot = ${M.toFixed(2)} M☉ exceeds the threshold ${mth.toFixed(2)} M☉ — the remnant never bounces.`;
    } else if (M > 1.2 * mmax.M) {
        fate = 'hypermassive neutron star'; lifetime = '~10–100 ms (differential rotation, then collapse)';
        detail = `Above the rigid-rotation limit (1.2 M_max = ${(1.2 * mmax.M).toFixed(2)} M☉): only differential rotation holds it, briefly.`;
    } else if (M > mmax.M) {
        fate = 'supramassive neutron star'; lifetime = '~seconds to hours (collapses on spin-down)';
        detail = `Between M_max = ${mmax.M.toFixed(2)} and 1.2 M_max: uniform rotation can carry it until magnetic braking cannot.`;
    } else {
        fate = 'stable neutron star'; lifetime = 'indefinite';
        detail = `M_tot = ${M.toFixed(2)} M☉ is below this EOS's M_max = ${mmax.M.toFixed(2)} M☉.`;
    }
    const marginal = Math.abs(margin) < THRESHOLD_SCATTER;
    const mDyn = bnsDynamicalEjecta(s1, s2);
    const mDisk = fate === 'prompt collapse' ? Math.min(bnsDiskMass(s1, s2), 0.01) : bnsDiskMass(s1, s2);
    const mWind = DISK_WIND_FRACTION * mDisk;
    return {
        branch: 'bns', fate, lifetime, detail, marginal,
        thresholdMass: mth, maxMass: mmax.M, totalMass: M, margin,
        ejecta: {
            dynamical: mDyn, disk: mDisk, wind: mWind, total: mDyn + mWind,
            // Velocities: dynamical ~0.2–0.3c (tidal tail + shock), wind ~0.1c.
            vDynamical: 0.25, vWind: 0.1,
        },
        notes: [
            'Threshold: Bauswein, Baumgarte & Janka 2013, M_th = (2.38 − 3.606 C_max) M_max; the fit scatters by ±0.1 M☉ and a verdict inside that band is marked marginal.',
            'Ejecta: Krüger & Foucart 2020 fits (dynamical eq. 9, disk eq. 4); disk wind = 20 % of the disk.',
            'The remnant mass is taken as M_tot; the few percent lost to GWs and ejecta before the fate is decided is neglected.',
        ].concat(marginal ? [`Marginal: M_tot is within ${THRESHOLD_SCATTER} M☉ of the threshold — GW170817 sits exactly here on soft EOSs, which is how it constrained M_th.`] : []),
    };
}

// ── Neutron star – black hole ───────────────────────────────────────────────
const FHN18 = { alpha: 0.406, beta: 0.139, gamma: 0.255, delta: 1.761 };
const KAW16 = { a1: 4.464e-2, a2: 2.269e-3, a3: 2.431, a4: -0.4159, n1: 0.2497, n2: 1.352 };

/**
 * NSBH: {mBh, chiBh} against a TOV star ns = {M, C, Mb, R}.
 */
export function nsbhOutcome(mBh, chiBh, ns) {
    const q = mBh / ns.M;
    const eta = q / (1 + q) ** 2;
    const rIsco = kerrIsco(chiBh);
    const { alpha, beta, gamma, delta } = FHN18;
    const base = alpha * (1 - 2 * ns.C) / eta ** (1 / 3) - beta * rIsco * ns.C / eta + gamma;
    const mRem = ns.Mb * Math.max(0, base) ** delta;
    const { a1, a2, a3, a4, n1, n2 } = KAW16;
    const dyn = ns.Mb * Math.max(0,
        a1 * q ** n1 * (1 - 2 * ns.C) / ns.C - a2 * q ** n2 * rIsco + a3 * (1 - ns.M / ns.Mb) + a4);
    const mDyn = Math.min(dyn, mRem);
    const mDisk = Math.max(0, mRem - mDyn);
    const disrupted = mRem > 1e-3;
    // Newtonian tidal radius vs ISCO, for the picture.
    const rTidalKm = ns.R * GEOM_KM * Math.cbrt(mBh / ns.M);
    const rIscoKm = rIsco * mBh * GEOM_KM;
    const fate = disrupted ? 'tidal disruption → black hole + disk' : 'swallowed whole';
    return {
        branch: 'nsbh', fate, disrupted, massRatio: q, rIsco, rIscoKm, rTidalKm,
        remnantBaryonMass: mRem,
        ejecta: { dynamical: mDyn, disk: mDisk, wind: DISK_WIND_FRACTION * mDisk, total: mDyn + DISK_WIND_FRACTION * mDisk,
            vDynamical: 0.25, vWind: 0.1 },
        finalMass: mBh + ns.M - mRem,
        detail: disrupted
            ? `Tidal radius ${rTidalKm.toFixed(0)} km lies outside the ISCO ${rIscoKm.toFixed(0)} km (χ = ${chiBh.toFixed(2)}): ${(mRem).toFixed(3)} M☉ of baryons survive outside the horizon.`
            : `The ISCO (${rIscoKm.toFixed(0)} km) is outside the tidal radius (${rTidalKm.toFixed(0)} km): the star plunges intact. No ejecta, no disk, no light.`,
        notes: ['Remnant mass: Foucart, Hinderer & Nissanke 2018; dynamical ejecta: Kawaguchi+ 2016. Both fitted to aligned-spin NR.'],
    };
}

// ── White dwarf branches ────────────────────────────────────────────────────
/** Eggleton 1983 Roche-lobe radius over separation for mass ratio q = M_donor/M_accretor. */
export function rocheLobeFraction(q) {
    const q23 = q ** (2 / 3);
    return 0.49 * q23 / (0.6 * q23 + Math.log(1 + Math.cbrt(q)));
}
export const CHANDRASEKHAR = 1.4;

/**
 * A white dwarf {M, R km} against a companion {M, kind, chi?, R km?}.
 */
export function wdOutcome(wd, comp) {
    const q = wd.M / comp.M;
    const aRlof = wd.R / rocheLobeFraction(q);        // km — mass transfer begins here
    let innerKm, innerLabel;
    if (comp.kind === 'bh') { innerKm = kerrIsco(comp.chi || 0) * comp.M * GEOM_KM; innerLabel = 'ISCO'; }
    else if (comp.kind === 'ns') { innerKm = comp.R; innerLabel = 'neutron-star surface'; }
    else { innerKm = comp.R; innerLabel = 'companion surface'; }
    const disrupted = aRlof > innerKm;
    const totalMass = wd.M + comp.M;
    const fGwRlof = Math.sqrt(totalMass / (aRlof / GEOM_KM) ** 3) / Math.PI / GEOM_S;
    let fate, detail;
    if (comp.kind === 'wd') {
        fate = totalMass > CHANDRASEKHAR ? 'double-degenerate merger over the Chandrasekhar mass' : 'double-degenerate merger below the Chandrasekhar mass';
        detail = totalMass > CHANDRASEKHAR
            ? `Combined ${totalMass.toFixed(2)} M☉ exceeds ${CHANDRASEKHAR} M☉ — a Type Ia supernova or an accretion-induced collapse to a neutron star, depending on ignition.`
            : `Combined ${totalMass.toFixed(2)} M☉ stays below ${CHANDRASEKHAR} M☉ — a massive, rapidly rotating white dwarf (or an R CrB-type merger remnant).`;
    } else {
        fate = disrupted ? 'tidal disruption of the white dwarf' : 'white dwarf swallowed whole';
        detail = disrupted
            ? `Roche-lobe overflow at a = ${aRlof.toFixed(0)} km, far outside the ${innerLabel} at ${innerKm.toFixed(0)} km — the dwarf is shredded into an accretion disk over ~seconds. GW frequency there: ${fGwRlof.toFixed(3)} Hz (LISA band, not LIGO).`
            : `The ${innerLabel} (${innerKm.toFixed(0)} km) lies outside the overflow radius (${aRlof.toFixed(0)} km) — no disruption.`;
    }
    return {
        branch: 'wd', fate, detail, disrupted, aRlofKm: aRlof, innerKm, innerLabel, fGwRlofHz: fGwRlof,
        ejecta: { dynamical: 0, disk: disrupted ? wd.M : 0, wind: 0, total: 0 },
        notes: ['Roche lobe: Eggleton 1983. A white dwarf is Newtonian; its tidal deformability here is the n = 1.5 polytrope estimate.'],
    };
}

// ── Kilonova ────────────────────────────────────────────────────────────────
export const THERMALISATION = 0.5;   // Barnes+2016: 0.3–0.7 over the first week
export const DIFFUSION_BETA = 3;     // Metzger 2017 eq. 3 geometry factor

/** r-process heating rate, erg g⁻¹ s⁻¹ at time t (s). */
export function rProcessHeating(tS) {
    const tDay = Math.max(tS / DAY_S, 1e-4);
    return 2e10 * tDay ** -1.3;
}

/**
 * One-zone light curve for a component {mass (M☉), v (c), kappa (cm²/g)}.
 * Returns {tDays[], L[], T[], peakL, tPeakDays, tempAtPeak}.
 */
export function kilonovaComponent({ mass, v, kappa }, opts = {}) {
    const M = mass * MSUN_G, V = v * C_CGS;
    const t0 = 100, t1 = (opts.tMaxDays || 30) * DAY_S;
    const n = opts.samples || 400;
    const tDays = [], L = [], T = [];
    let E = 0; // thermal energy, erg
    let t = t0;
    let peakL = 0, tPeak = 0, tempAtPeak = 0;
    const lnStep = Math.log(t1 / t0) / n;
    const deriv = (tt, EE) => {
        const R = V * tt;
        const tDiff = 3 * kappa * M / (4 * Math.PI * DIFFUSION_BETA * C_CGS * R);
        const tLc = R / C_CGS;
        const Lr = EE / (tDiff + tLc);
        return { dE: M * THERMALISATION * rProcessHeating(tt) - EE / tt - Lr, Lr };
    };
    if (!(M > 0)) return { tDays: [], L: [], T: [], peakL: 0, tPeakDays: 0, tempAtPeak: 0 };
    for (let i = 0; i <= n; i++) {
        const tNext = t0 * Math.exp(lnStep * (i + 1));
        // RK4 in t with sub-steps so the early stiff phase is stable.
        const sub = 8;
        const h = (tNext - t) / sub;
        for (let k = 0; k < sub; k++) {
            const k1 = deriv(t, E).dE;
            const k2 = deriv(t + h / 2, E + h / 2 * k1).dE;
            const k3 = deriv(t + h / 2, E + h / 2 * k2).dE;
            const k4 = deriv(t + h, E + h * k3).dE;
            E = Math.max(0, E + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4));
            t += h;
        }
        const { Lr } = deriv(t, E);
        const R = V * t;
        const temp = (Lr / (4 * Math.PI * 5.670374e-5 * R * R)) ** 0.25;
        tDays.push(t / DAY_S); L.push(Lr); T.push(temp);
        if (Lr > peakL) { peakL = Lr; tPeak = t / DAY_S; tempAtPeak = temp; }
    }
    return { tDays, L, T, peakL, tPeakDays: tPeak, tempAtPeak };
}

/** Bolometric absolute and apparent magnitude for luminosity L (erg/s) at D (Mpc). */
export function bolometricMagnitudes(L, distanceMpc) {
    if (!(L > 0)) return { absolute: NaN, apparent: NaN };
    const absolute = 4.74 - 2.5 * Math.log10(L / LSUN);
    const apparent = absolute + 5 * Math.log10(distanceMpc * 1e6 / 10);
    return { absolute, apparent };
}

/**
 * Full two-component kilonova from an ejecta budget.
 * blue = disk wind (lanthanide-poor, κ = 0.5), red = dynamical (κ = 10).
 */
export function kilonova(ejecta, distanceMpc = 40) {
    const blue = kilonovaComponent({ mass: ejecta.wind, v: ejecta.vWind ?? 0.1, kappa: 0.5 });
    const red = kilonovaComponent({ mass: ejecta.dynamical, v: ejecta.vDynamical ?? 0.25, kappa: 10 });
    const n = Math.max(blue.L.length, red.L.length);
    const tDays = blue.tDays.length ? blue.tDays : red.tDays;
    const total = [];
    let peakL = 0, tPeak = 0;
    for (let i = 0; i < n; i++) {
        const l = (blue.L[i] || 0) + (red.L[i] || 0);
        total.push(l);
        if (l > peakL) { peakL = l; tPeak = tDays[i]; }
    }
    const mags = bolometricMagnitudes(peakL, distanceMpc);
    return {
        blue, red, tDays, total, peakL, tPeakDays: tPeak,
        peakAbsoluteMag: mags.absolute, peakApparentMag: mags.apparent,
        visible: peakL > 0,
        notes: ['One-zone homologous model (Metzger 2017 Living Reviews §4), r-process heating 2×10¹⁰ t_d^{-1.3} erg/g/s, ε_th = 0.5.',
            'Blue = disk wind κ = 0.5 cm²/g; red = dynamical κ = 10 cm²/g. Peak times scale as √(Mκ/v).'],
    };
}

// ── Magnetised neutron stars ────────────────────────────────────────────────
/**
 * Dipole spin-down luminosity (erg/s), magnetic energy (erg), and the
 * dipole–dipole interaction energy at separation aKm against the orbital
 * binding energy for a companion of mass mComp with field B2 (G, may be 0).
 */
export function magneticInteraction({ B, rKm, periodS, M, mComp, B2 = 0, r2Km = 0, aKm }) {
    const R = rKm * KM_CM;
    const omega = periodS > 0 ? 2 * Math.PI / periodS : 0;
    const spinDown = B * B * R ** 6 * omega ** 4 / (6 * C_CGS ** 3);
    const magneticEnergy = B * B * R ** 3 / 6;
    const mu1 = B * R ** 3 / 2, mu2 = B2 * (r2Km * KM_CM) ** 3 / 2;
    const a = aKm * KM_CM;
    const dipoleDipole = mu1 * mu2 / a ** 3;
    const binding = G_CGS * M * MSUN_G * mComp * MSUN_G / (2 * a);
    // The companion's induced response: field at the companion's position.
    const fieldAtCompanion = B * (R / a) ** 3;
    return {
        spinDownErgS: spinDown, magneticEnergyErg: magneticEnergy,
        dipoleDipoleErg: dipoleDipole, orbitalBindingErg: binding,
        magneticToGravity: binding > 0 ? dipoleDipole / binding : 0,
        fieldAtCompanionG: fieldAtCompanion,
        notes: ['Spin-down: orthogonal vacuum dipole B²R⁶Ω⁴/6c³. Dipole–dipole energy μ₁μ₂/a³ with μ = BR³/2; even at 10¹⁵ G it is ~10⁻⁶ of the orbital binding energy at contact.'],
    };
}

// ── Pair classification ─────────────────────────────────────────────────────
export function classifyPair(kindA, kindB) {
    const k = [kindA, kindB].sort().join('+');
    return ({ 'bh+bh': 'bbh', 'ns+ns': 'bns', 'bh+ns': 'nsbh', 'bh+wd': 'wdbh', 'ns+wd': 'wdns', 'wd+wd': 'wdwd' })[k] || 'unknown';
}
