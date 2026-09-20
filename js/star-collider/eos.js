/**
 * star-collider/eos.js — nuclear-matter equations of state (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * The piecewise-polytrope parametrisation of Read, Lackey, Owen & Friedman
 * (2009, PRD 79, 124032): every tabulated EOS in the literature is fitted by
 * a fixed low-density crust (the SLy fit, four pieces) joined to a THREE-piece
 * core described by four numbers — log10 p1 (the pressure at ρ1 = 10^14.7
 * g/cm³) and the three adiabatic indices Γ1, Γ2, Γ3 on the density intervals
 * split at ρ1 and ρ2 = 10^15 g/cm³. That is the whole EOS. The star builder
 * (tov.js) and the SPH kernel both consume this module and nothing else.
 *
 * UNITS. The crust constants are the published ones, which are cgs with the
 * PRESSURE EXPRESSED AS p/c² IN g/cm³ — not dyn/cm². (Check: SLy at
 * ρ = 10¹⁴ g/cm³ gives K3·ρ^Γ3 ≈ 4×10¹¹ g/cm³, i.e. 3.6×10³² dyn/cm², which
 * is the right order; reading the constants as dyn/cm² is 10²¹ low.) So
 * inside this module p, ε and ρ share the unit g/cm³ and the whole EOS is a
 * pure number relation, which is exactly what geometric units (G = c = 1)
 * need — divide all three by RHO_GEOM to get M☉-based geometric values.
 *
 * The public surface is in GEOMETRIC units unless the name says `Cgs`:
 * rho, p, eps in M☉ / (G M☉/c²)³ — see UNITS below.
 *
 * ENERGY DENSITY. Each piece carries ε = (1 + a_i)ρ + K_i ρ^Γi / (Γi − 1),
 * with a_i fixed by continuity of ε across the piece boundaries (Read+2009
 * eq. 5–6). a_0 = 0. This is what the first law demands for a polytrope, and
 * it is where a "simple" ε = ρ + p/(Γ−1) goes wrong at the joins.
 *
 * SOUND SPEED. dp/dε = (dp/dρ)/(dε/dρ), piecewise. The tidal-perturbation ODE
 * in tov.js needs it; it is discontinuous at piece boundaries by construction
 * (that is the price of a piecewise fit and is fine for RK4 across them).
 *
 * The table's M_max / R(1.4) / Λ(1.4) targets in tests/star-collider-tov.mjs
 * are published values (Read+2009 Table III; Hinderer+2010; the GW170817
 * papers). An EOS whose TOV sequence misses them is a transcription error.
 */

// ── Units ───────────────────────────────────────────────────────────────────
export const G_CGS = 6.67430e-8;          // cm³ g⁻¹ s⁻²
export const C_CGS = 2.99792458e10;       // cm/s
export const MSUN_G = 1.98847e33;         // g
/** G M☉ / c², km — the geometric length unit. */
export const GEOM_KM = G_CGS * MSUN_G / (C_CGS * C_CGS) / 1e5;   // 1.47662 km
/** G M☉ / c³, seconds — the geometric time unit. */
export const GEOM_S = G_CGS * MSUN_G / (C_CGS ** 3);              // 4.9255e-6 s
/** M☉ / (G M☉/c²)³ in g/cm³ — divide a cgs density by this to get geometric. */
export const RHO_GEOM = MSUN_G / ((GEOM_KM * 1e5) ** 3);          // 6.176e17 g/cm³
/** Nuclear saturation density, g/cm³ (2.7×10¹⁴ ≈ 0.16 fm⁻³ × m_n). */
export const RHO_NUC_CGS = 2.7e14;

// ── The SLy crust (Read+2009 Table II; p/c² in g/cm³) ──────────────────────
const CRUST = [
    { K: 6.80110e-9, G: 1.58425, rhoMax: 2.44034e7 },
    { K: 1.06186e-6, G: 1.28733, rhoMax: 3.78358e11 },
    { K: 5.32697e1,  G: 0.62223, rhoMax: 2.62780e12 },
    { K: 3.99874e-8, G: 1.35692, rhoMax: Infinity },   // up to the core junction
];

const RHO1_CGS = 10 ** 14.7;
const RHO2_CGS = 10 ** 15.0;

// ── Core parameters (Read+2009 Table III): log10 p1 [dyn/cm²], Γ1, Γ2, Γ3 ──
//
// `mmax`, `r14`, `lambda14` are the PUBLISHED sequence properties this module
// is tested against (M_max in M☉; R(1.4 M☉) in km; Λ(1.4 M☉)). Λ values are
// from the piecewise-polytrope fits themselves (Hinderer+2010, Read+2013),
// which is the right comparison — the fit, not the underlying table.
// `stiffness` is only a display ordering.
export const EOS_TABLE = Object.freeze({
    SLy:  { name: 'SLy',  logP1: 34.384, G1: 3.005, G2: 2.988, G3: 2.851, mmax: 2.05, r14: 11.74, lambda14: 306,
            blurb: 'Douchin & Haensel 2001 · Skyrme effective interaction. Soft; the GW170817-compatible workhorse.' },
    APR4: { name: 'APR4', logP1: 34.269, G1: 2.830, G2: 3.445, G3: 3.348, mmax: 2.21, r14: 11.09, lambda14: 260,
            blurb: 'Akmal, Pandharipande & Ravenhall 1998 · variational, AV18 + boost + UIX. The softest here at 1.4 M☉.' },
    ENG:  { name: 'ENG',  logP1: 34.437, G1: 3.514, G2: 3.130, G3: 3.168, mmax: 2.25, r14: 12.06, lambda14: 385,
            blurb: 'Engvik+ 1996 · Dirac–Brueckner–Hartree–Fock. Intermediate.' },
    MPA1: { name: 'MPA1', logP1: 34.495, G1: 3.446, G2: 3.572, G3: 2.887, mmax: 2.46, r14: 12.47, lambda14: 480,
            blurb: 'Müther, Prakash & Ainsworth 1987 · relativistic Brueckner. Stiff at high density — the 2.5 M☉ EOS.' },
    H4:   { name: 'H4',   logP1: 34.669, G1: 2.909, G2: 2.246, G3: 2.144, mmax: 2.03, r14: 13.76, lambda14: 900,
            blurb: 'Lackey, Nayyar & Owen 2006 · relativistic mean field with hyperons. Large radius, low M_max.' },
    MS1:  { name: 'MS1',  logP1: 34.858, G1: 3.224, G2: 3.033, G3: 1.325, mmax: 2.77, r14: 14.92, lambda14: 1400,
            blurb: 'Müller & Serot 1996 · relativistic mean field. The stiffest in the set; ruled out by GW170817.' },
    WFF1: { name: 'WFF1', logP1: 34.031, G1: 2.519, G2: 3.791, G3: 3.660, mmax: 2.13, r14: 10.42, lambda14: 190,
            blurb: 'Wiringa, Fiks & Fabrocini 1988 · variational, AV14 + UVII. Very soft — a 10.4 km 1.4 M☉ star.' },
    ALF2: { name: 'ALF2', logP1: 34.616, G1: 4.070, G2: 2.411, G3: 1.890, mmax: 1.99, r14: 13.19, lambda14: 590,
            blurb: 'Alford+ 2005 · hybrid nuclear + colour-flavour-locked quark matter core.' },
});
export const EOS_IDS = Object.freeze(Object.keys(EOS_TABLE));
export const DEFAULT_EOS = 'SLy';

/**
 * Build a piecewise-polytrope EOS. Returns an object of pure functions in
 * GEOMETRIC units plus the raw piece table (cgs) for inspection.
 */
export function createEos(id = DEFAULT_EOS) {
    const row = EOS_TABLE[id];
    if (!row) throw new Error(`eos: unknown EOS "${id}" (have ${EOS_IDS.join(', ')})`);

    // Core pieces: K1 from p1 at ρ1; K2, K3 by continuity of p at ρ1, ρ2.
    const p1 = (10 ** row.logP1) / (C_CGS * C_CGS);        // p/c² in g/cm³
    const K1 = p1 / RHO1_CGS ** row.G1;
    const K2 = K1 * RHO1_CGS ** (row.G1 - row.G2);
    const K3 = K2 * RHO2_CGS ** (row.G2 - row.G3);

    // Crust/core junction: where the last crust piece meets the first core
    // piece. Solve K3c ρ0^Γ3c = K1 ρ0^Γ1.
    const c3 = CRUST[3];
    const rho0 = (c3.K / K1) ** (1 / (row.G1 - c3.G));
    if (!(rho0 > CRUST[2].rhoMax && rho0 < RHO1_CGS)) {
        throw new Error(`eos ${id}: crust/core junction ${rho0.toExponential(3)} g/cm³ is outside the expected band`);
    }

    // Assemble the piece list (cgs), lowest density first.
    const pieces = [
        { K: CRUST[0].K, G: CRUST[0].G, rhoMin: 0,               rhoMax: CRUST[0].rhoMax },
        { K: CRUST[1].K, G: CRUST[1].G, rhoMin: CRUST[0].rhoMax, rhoMax: CRUST[1].rhoMax },
        { K: CRUST[2].K, G: CRUST[2].G, rhoMin: CRUST[1].rhoMax, rhoMax: CRUST[2].rhoMax },
        { K: CRUST[3].K, G: CRUST[3].G, rhoMin: CRUST[2].rhoMax, rhoMax: rho0 },
        { K: K1,         G: row.G1,     rhoMin: rho0,            rhoMax: RHO1_CGS },
        { K: K2,         G: row.G2,     rhoMin: RHO1_CGS,        rhoMax: RHO2_CGS },
        { K: K3,         G: row.G3,     rhoMin: RHO2_CGS,        rhoMax: Infinity },
    ];
    // a_i for ε continuity: ε(ρ)/ρ continuous across each rhoMin.
    pieces[0].a = 0;
    for (let i = 1; i < pieces.length; i++) {
        const prev = pieces[i - 1], cur = pieces[i], rb = cur.rhoMin;
        const epsPrev = (1 + prev.a) * rb + prev.K * rb ** prev.G / (prev.G - 1);
        cur.a = epsPrev / rb - 1 - cur.K * rb ** (cur.G - 1) / (cur.G - 1);
    }
    // Pressure at each piece's lower edge (cgs), for the inverse lookup.
    for (const pc of pieces) {
        pc.pMin = pc.K * pc.rhoMin ** pc.G;
        pc.pMax = Number.isFinite(pc.rhoMax) ? pc.K * pc.rhoMax ** pc.G : Infinity;
    }

    const pieceForRho = (rhoCgs) => {
        for (let i = 0; i < pieces.length; i++) if (rhoCgs < pieces[i].rhoMax) return pieces[i];
        return pieces[pieces.length - 1];
    };
    const pieceForP = (pCgs) => {
        for (let i = 0; i < pieces.length; i++) if (pCgs < pieces[i].pMax) return pieces[i];
        return pieces[pieces.length - 1];
    };

    // ── cgs core ────────────────────────────────────────────────────────────
    const pressureCgs = (rhoCgs) => {
        if (!(rhoCgs > 0)) return 0;
        const pc = pieceForRho(rhoCgs);
        return pc.K * rhoCgs ** pc.G;
    };
    const energyDensityCgs = (rhoCgs) => {
        if (!(rhoCgs > 0)) return 0;
        const pc = pieceForRho(rhoCgs);
        return (1 + pc.a) * rhoCgs + pc.K * rhoCgs ** pc.G / (pc.G - 1);
    };
    const rhoOfPressureCgs = (pCgs) => {
        if (!(pCgs > 0)) return 0;
        const pc = pieceForP(pCgs);
        return (pCgs / pc.K) ** (1 / pc.G);
    };
    /** dp/dε (dimensionless sound speed squared, c = 1) at rest-mass density ρ. */
    const soundSpeed2Cgs = (rhoCgs) => {
        if (!(rhoCgs > 0)) return 0;
        const pc = pieceForRho(rhoCgs);
        const dpdrho = pc.G * pc.K * rhoCgs ** (pc.G - 1);
        const dedrho = (1 + pc.a) + pc.G * pc.K * rhoCgs ** (pc.G - 1) / (pc.G - 1);
        return dpdrho / dedrho;
    };

    // ── geometric surface ───────────────────────────────────────────────────
    return Object.freeze({
        id, name: row.name, blurb: row.blurb, params: row,
        pieces: pieces.map(p => ({ ...p })),
        junctionRhoCgs: rho0,
        /** p(ρ), geometric. */
        pressure: (rho) => pressureCgs(rho * RHO_GEOM) / RHO_GEOM,
        /** ε(ρ), geometric (total energy density incl. rest mass). */
        energyDensity: (rho) => energyDensityCgs(rho * RHO_GEOM) / RHO_GEOM,
        /** ρ(p), geometric. */
        rhoOfPressure: (p) => rhoOfPressureCgs(p * RHO_GEOM) / RHO_GEOM,
        /** ε(p), geometric. */
        energyDensityOfPressure: (p) => energyDensityCgs(rhoOfPressureCgs(p * RHO_GEOM)) / RHO_GEOM,
        /** dp/dε at ρ (dimensionless). */
        soundSpeed2: (rho) => soundSpeed2Cgs(rho * RHO_GEOM),
        /** dp/dε at pressure p. */
        soundSpeed2OfPressure: (p) => soundSpeed2Cgs(rhoOfPressureCgs(p * RHO_GEOM)),
        pressureCgs, energyDensityCgs, rhoOfPressureCgs, soundSpeed2Cgs,
    });
}

/** Adiabatic index Γ = d ln p / d ln ρ at a cgs density (for display). */
export function localGamma(eos, rhoCgs) {
    for (const pc of eos.pieces) if (rhoCgs < pc.rhoMax) return pc.G;
    return eos.pieces[eos.pieces.length - 1].G;
}
