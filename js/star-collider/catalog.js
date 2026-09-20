/**
 * star-collider/catalog.js — real compact objects, and how they are wired in
 * ═══════════════════════════════════════════════════════════════════════════
 * Every object here is a published measurement with its provenance. What
 * the lab ADDS is the layer that lets any two of them interact: a NEUTRON
 * STAR is resolved through the chosen EOS into a TOV star (radius,
 * compactness, tidal deformability Λ, Love number, baryonic mass, moment
 * of inertia via I–Love) and, with its spin period, a dimensionless spin
 * χ = IΩ/M²; a BLACK HOLE carries χ, horizon and ISCO; a WHITE DWARF is a
 * Newtonian n = 1.5 polytrope with its measured radius. `resolveProfile`
 * is that layer, and `PAIRS` are the real binaries and GW events built
 * from the same objects.
 *
 * MEASURED vs ASSUMED. `mass.source` says which. Some famous objects have no
 * mass measurement (the fastest pulsar, the giant-flare magnetar); they
 * carry the canonical 1.4 M☉ with `source: 'assumed'` and the card says so.
 * A measured radius (NICER) is displayed as measured AND compared with the
 * EOS's own radius for that mass — that disagreement is a physics result
 * (it is how NICER constrains the EOS), not something to hide.
 *
 * An object whose mass exceeds the chosen EOS's M_max cannot be built on it
 * (PSR J0740+6620 at 2.08 M☉ does not exist on SLy). The profile then says
 * `eosSupported: false` and falls back to a rigid star at the M_max radius
 * so the pair engine can still run, flagged.
 */

import { createEos, GEOM_KM, GEOM_S, MSUN_G } from './eos.js';
import { massRadiusSequence, starAtMass, iLoveBar } from './tov.js';
import { kerrIsco, horizonRadius } from './remnant.js';

export const KIND_LABEL = Object.freeze({ ns: 'Neutron star', bh: 'Black hole', wd: 'White dwarf' });

/** Newtonian n = 1.5 polytrope apsidal constant (k2) for a white dwarf. */
const WD_K2 = 0.143;

export const OBJECTS = Object.freeze([
    {
        id: 'j0740', name: 'PSR J0740+6620', kind: 'ns',
        short: 'The heaviest well-measured neutron star',
        mass: { value: 2.08, sigma: 0.07, source: 'measured', how: 'Shapiro delay (Fonseca+ 2021)' },
        radiusKm: { value: 12.39, plus: 1.30, minus: 0.98, source: 'measured', how: 'NICER + XMM pulse-profile modelling (Riley+ 2021)' },
        spinPeriodS: 0.002886, bFieldG: 2.4e8, distanceKpc: 1.14,
        blurb: 'A 2.9 ms pulsar with a white-dwarf companion. Its 2.08 M☉ is the hardest single constraint on the equation of state: any EOS that cannot hold it is out.',
        sources: ['Fonseca+ 2021 ApJL 915 L12', 'Riley+ 2021 ApJL 918 L27', 'Miller+ 2021 ApJL 918 L28'],
    },
    {
        id: 'j0030', name: 'PSR J0030+0451', kind: 'ns',
        short: 'NICER\'s first radius',
        mass: { value: 1.34, sigma: 0.15, source: 'measured', how: 'NICER pulse-profile modelling (Riley+ 2019)' },
        radiusKm: { value: 12.71, plus: 1.14, minus: 1.19, source: 'measured', how: 'NICER (Riley+ 2019)' },
        spinPeriodS: 0.004865, bFieldG: 2.3e8, distanceKpc: 0.325,
        blurb: 'An isolated millisecond pulsar 325 pc away and the first neutron star whose radius was read directly from the shape of its X-ray pulse.',
        sources: ['Riley+ 2019 ApJL 887 L21', 'Miller+ 2019 ApJL 887 L24'],
    },
    {
        id: 'j0348', name: 'PSR J0348+0432', kind: 'ns',
        short: 'Two solar masses, optically weighed',
        mass: { value: 2.01, sigma: 0.04, source: 'measured', how: 'White-dwarf companion spectroscopy + orbit (Antoniadis+ 2013)' },
        radiusKm: null,
        spinPeriodS: 0.0391, bFieldG: 3e9, distanceKpc: 2.1,
        blurb: 'A 39 ms pulsar in a 2.46-hour orbit with a 0.17 M☉ white dwarf. The pair loses orbital energy to gravitational waves at exactly the rate general relativity predicts.',
        sources: ['Antoniadis+ 2013 Science 340 448'],
    },
    {
        id: 'b1913a', name: 'PSR B1913+16', kind: 'ns',
        short: 'The Hulse–Taylor pulsar',
        mass: { value: 1.4398, sigma: 0.0002, source: 'measured', how: 'Post-Keplerian orbit (Weisberg & Huang 2016)' },
        radiusKm: null,
        spinPeriodS: 0.05903, bFieldG: 2.3e10, distanceKpc: 5.25,
        blurb: 'The first binary pulsar. Its 7.75-hour orbit has been shrinking since 1974 at the gravitational-wave rate to 0.2 % — the first evidence gravitational waves exist.',
        sources: ['Weisberg & Huang 2016 ApJ 829 55'],
    },
    {
        id: 'b1913b', name: 'B1913+16 companion', kind: 'ns',
        short: 'The unseen half of Hulse–Taylor',
        mass: { value: 1.3886, sigma: 0.0002, source: 'measured', how: 'Post-Keplerian orbit (Weisberg & Huang 2016)' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 5.25,
        blurb: 'Not a pulsar, or not one beamed at us. Known only through its gravity.',
        sources: ['Weisberg & Huang 2016 ApJ 829 55'],
    },
    {
        id: 'j0737a', name: 'PSR J0737−3039A', kind: 'ns',
        short: 'The double pulsar, star A',
        mass: { value: 1.3381, sigma: 0.0007, source: 'measured', how: 'Post-Keplerian orbit (Kramer+ 2021)' },
        radiusKm: null,
        spinPeriodS: 0.02270, bFieldG: 6.4e9, distanceKpc: 1.15,
        blurb: 'The only known double pulsar: both stars beam at Earth, the orbit is edge-on, and it is the most stringent test of general relativity in the strong field.',
        sources: ['Kramer+ 2021 PRX 11 041050'],
    },
    {
        id: 'j0737b', name: 'PSR J0737−3039B', kind: 'ns',
        short: 'The double pulsar, star B',
        mass: { value: 1.2489, sigma: 0.0007, source: 'measured', how: 'Post-Keplerian orbit (Kramer+ 2021)' },
        radiusKm: null,
        spinPeriodS: 2.773, bFieldG: 1.6e12, distanceKpc: 1.15,
        blurb: 'The slow, young one. Its beam precessed out of our line of sight in 2008 and should return around 2035.',
        sources: ['Kramer+ 2021 PRX 11 041050'],
    },
    {
        id: 'gw170817a', name: 'GW170817 primary', kind: 'ns',
        short: 'The first neutron-star merger heard',
        mass: { value: 1.46, sigma: 0.10, source: 'measured', how: 'GW parameter estimation, low-spin prior (Abbott+ 2019)' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 40000,
        blurb: 'Chirp mass 1.186 M☉, Λ̃ ≲ 720, and a kilonova 11 hours later in NGC 4993. Everything this lab models was measured once, here.',
        sources: ['Abbott+ 2019 PRX 9 011001', 'Abbott+ 2017 PRL 119 161101'],
    },
    {
        id: 'gw170817b', name: 'GW170817 secondary', kind: 'ns',
        short: 'The lighter star of GW170817',
        mass: { value: 1.27, sigma: 0.09, source: 'measured', how: 'GW parameter estimation, low-spin prior (Abbott+ 2019)' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 40000,
        blurb: 'Component masses are only constrained jointly; this is the low-spin posterior median.',
        sources: ['Abbott+ 2019 PRX 9 011001'],
    },
    {
        id: 'gw150914a', name: 'GW150914 primary', kind: 'bh',
        short: 'The first black hole heard',
        mass: { value: 36, sigma: 4, source: 'measured', how: 'GW parameter estimation (Abbott+ 2016)' },
        chi: { value: 0.32, sigma: 0.3, source: 'measured', how: 'poorly constrained; χ_eff ≈ −0.06' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 410000,
        blurb: 'September 14, 2015. Two black holes, 0.2 seconds of signal, three solar masses of energy radiated.',
        sources: ['Abbott+ 2016 PRL 116 061102'],
    },
    {
        id: 'gw150914b', name: 'GW150914 secondary', kind: 'bh',
        short: 'The lighter black hole of GW150914',
        mass: { value: 29, sigma: 4, source: 'measured', how: 'GW parameter estimation (Abbott+ 2016)' },
        chi: { value: 0.44, sigma: 0.3, source: 'measured', how: 'poorly constrained' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 410000,
        blurb: 'The lighter of the pair. Together they left a 62 M☉ black hole spinning at 0.67 and radiated three suns of mass–energy.',
        sources: ['Abbott+ 2016 PRL 116 061102'],
    },
    {
        id: 'gw190814a', name: 'GW190814 primary', kind: 'bh',
        short: 'The black hole that ate the mass gap',
        mass: { value: 23.2, sigma: 1.1, source: 'measured', how: 'GW parameter estimation (Abbott+ 2020)' },
        chi: { value: 0.0, sigma: 0.07, source: 'measured', how: '|χ₁| < 0.07' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 241000,
        blurb: 'A 23 M☉ black hole with a 2.6 M☉ companion — mass ratio 1:9, the most asymmetric merger of its era.',
        sources: ['Abbott+ 2020 ApJL 896 L44'],
    },
    {
        id: 'gw190814b', name: 'GW190814 secondary', kind: 'ns',
        short: 'Heaviest neutron star or lightest black hole',
        mass: { value: 2.59, sigma: 0.08, source: 'measured', how: 'GW parameter estimation (Abbott+ 2020)' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 241000,
        blurb: 'Filed here as a neutron star so you can try to build it: on most EOSs you cannot, and that is the argument that it was a black hole. Flip it to a BH in the console to compare.',
        sources: ['Abbott+ 2020 ApJL 896 L44'],
        alternateKind: 'bh',
    },
    {
        id: 'gw190521a', name: 'GW190521 primary', kind: 'bh',
        short: 'Inside the pair-instability gap',
        mass: { value: 85, sigma: 20, source: 'measured', how: 'GW parameter estimation (Abbott+ 2020)' },
        chi: { value: 0.69, sigma: 0.3, source: 'measured', how: 'poorly constrained, likely precessing' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 5300000,
        blurb: 'An 85 M☉ black hole should not form from a star. Its merger made the first intermediate-mass black hole, 142 M☉.',
        sources: ['Abbott+ 2020 PRL 125 101102'],
    },
    {
        id: 'gw190521b', name: 'GW190521 secondary', kind: 'bh',
        short: 'The 66 M☉ partner',
        mass: { value: 66, sigma: 18, source: 'measured', how: 'GW parameter estimation (Abbott+ 2020)' },
        chi: { value: 0.73, sigma: 0.3, source: 'measured', how: 'poorly constrained' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 5300000,
        blurb: 'Eight solar masses radiated in a tenth of a second.',
        sources: ['Abbott+ 2020 PRL 125 101102'],
    },
    {
        id: 'cygx1', name: 'Cygnus X-1', kind: 'bh',
        short: 'The first black hole found',
        mass: { value: 21.2, sigma: 2.2, source: 'measured', how: 'VLBI parallax + orbit (Miller-Jones+ 2021)' },
        chi: { value: 0.95, sigma: 0.03, source: 'measured', how: 'X-ray continuum fitting, χ > 0.95 (Zhao+ 2021)' },
        radiusKm: null, spinPeriodS: null, bFieldG: null, distanceKpc: 2.22,
        blurb: 'Accreting from a blue supergiant 2.2 kpc away. Near-maximal spin, so its ISCO sits at 2 gravitational radii instead of 6.',
        sources: ['Miller-Jones+ 2021 Science 371 1046', 'Zhao+ 2021 ApJ 908 117'],
    },
    {
        id: 'sgr1806', name: 'SGR 1806−20', kind: 'ns',
        short: 'The giant-flare magnetar',
        mass: { value: 1.4, sigma: null, source: 'assumed', how: 'no mass measurement; canonical 1.4 M☉' },
        radiusKm: null,
        spinPeriodS: 7.55, bFieldG: 2e15, distanceKpc: 8.7,
        blurb: 'On 27 December 2004 it released 2×10⁴⁶ erg in a fifth of a second — brighter than the full Moon in gamma rays, from 8.7 kpc. Field 2×10¹⁵ G.',
        sources: ['Palmer+ 2005 Nature 434 1107', 'Hurley+ 2005 Nature 434 1098'],
    },
    {
        id: 'j1748', name: 'PSR J1748−2446ad', kind: 'ns',
        short: 'The fastest-spinning pulsar',
        mass: { value: 1.4, sigma: null, source: 'assumed', how: 'no mass measurement; canonical 1.4 M☉' },
        radiusKm: null,
        spinPeriodS: 0.0013966, bFieldG: 1e8, distanceKpc: 5.9,
        blurb: '716 rotations per second in the globular cluster Terzan 5. Its equator moves at a quarter of the speed of light; a stiffer EOS would fly apart.',
        sources: ['Hessels+ 2006 Science 311 1901'],
    },
    {
        id: 'siriusb', name: 'Sirius B', kind: 'wd',
        short: 'The nearest white dwarf',
        mass: { value: 1.018, sigma: 0.011, source: 'measured', how: 'Astrometric orbit + gravitational redshift (Bond+ 2017)' },
        radiusKm: { value: 5840, plus: 40, minus: 40, source: 'measured', how: '0.0084 R☉ (Bond+ 2017; HST)' },
        spinPeriodS: null, bFieldG: null, distanceKpc: 0.00264,
        blurb: 'A solar mass packed into an Earth-sized sphere, 2.64 pc away. Colliding it with anything here is a thought experiment about tidal disruption — and about what a Roche lobe does.',
        sources: ['Bond+ 2017 ApJ 840 70'],
    },
]);

export const OBJECT_IDS = Object.freeze(OBJECTS.map(o => o.id));
export function objectById(id) { return OBJECTS.find(o => o.id === id) || null; }

/**
 * Real pairs. `orbit` is what is measured today (period, eccentricity) and
 * `event` is what happened (for the GW detections). `startSeparationKm` is a
 * lab suggestion for the SPH stage — not a measurement.
 */
export const PAIRS = Object.freeze([
    {
        id: 'hulse-taylor', name: 'Hulse–Taylor binary', a: 'b1913a', b: 'b1913b',
        orbit: { periodS: 27906.98, e: 0.6171, mergerMyr: 300 },
        blurb: 'Merges in ~300 Myr. The lab fast-forwards to the last orbits.',
    },
    {
        id: 'double-pulsar', name: 'The double pulsar', a: 'j0737a', b: 'j0737b',
        orbit: { periodS: 8834.5, e: 0.0878, mergerMyr: 85 },
        blurb: 'Merges in ~85 Myr; a 2.59 M☉ total, lighter than GW170817.',
    },
    {
        id: 'gw170817', name: 'GW170817', a: 'gw170817a', b: 'gw170817b',
        event: { distanceMpc: 40, chirpMass: 1.186, lambdaTildeUpper: 720, totalMass: 2.74,
                 remnant: 'short-lived hypermassive NS → BH (inferred)', kilonovaPeakErgS: 1e42 },
        blurb: 'The hindcast: the lab should give a marginal/hypermassive remnant on soft EOSs, ~0.03–0.05 M☉ of ejecta and a 10⁴² erg/s kilonova at 40 Mpc.',
    },
    {
        id: 'gw150914', name: 'GW150914', a: 'gw150914a', b: 'gw150914b',
        event: { distanceMpc: 410, finalMass: 62, finalSpin: 0.67, radiatedMsun: 3.0 },
        blurb: 'Pinned: 62 M☉ final mass, spin 0.67, 3 M☉ radiated.',
    },
    {
        id: 'gw190814', name: 'GW190814', a: 'gw190814a', b: 'gw190814b',
        event: { distanceMpc: 241, totalMass: 25.8 },
        blurb: 'If the 2.6 M☉ object is a neutron star, no EOS here holds it; if a black hole, the 1:9 mass ratio swallows it whole either way.',
    },
    {
        id: 'gw190521', name: 'GW190521', a: 'gw190521a', b: 'gw190521b',
        event: { distanceMpc: 5300, finalMass: 142, finalSpin: 0.72, radiatedMsun: 8 },
        blurb: 'Pinned: 142 M☉ final mass, ~8 M☉ radiated.',
    },
    {
        id: 'j0740-cygx1', name: 'J0740+6620 into Cygnus X-1', a: 'j0740', b: 'cygx1',
        blurb: 'A thought experiment: the heaviest neutron star against a near-maximally spinning 21 M☉ black hole. Does it disrupt?',
    },
    {
        id: 'siriusb-cygx1', name: 'Sirius B into Cygnus X-1', a: 'siriusb', b: 'cygx1',
        blurb: 'A white dwarf tidal disruption event, at LISA frequencies.',
    },
]);
export function pairById(id) { return PAIRS.find(p => p.id === id) || null; }

// ── Resolution ──────────────────────────────────────────────────────────────
const seqCache = new Map();
export function eosSequence(eosId) {
    if (!seqCache.has(eosId)) seqCache.set(eosId, massRadiusSequence(createEos(eosId), 40));
    return seqCache.get(eosId);
}

/**
 * Turn a catalog object (or a custom {kind, mass, radiusKm?, chi?, spinPeriodS?,
 * bFieldG?}) into the interaction profile the pair engine consumes.
 */
export function resolveProfile(obj, eosId = 'SLy') {
    const kind = obj.kindOverride || obj.kind;
    const M = typeof obj.mass === 'number' ? obj.mass : obj.mass.value;
    const base = {
        id: obj.id || 'custom', name: obj.name || 'Custom', kind, M,
        massSource: typeof obj.mass === 'number' ? 'custom' : obj.mass.source,
        spinPeriodS: obj.spinPeriodS ?? null, bFieldG: obj.bFieldG ?? null,
        distanceKpc: obj.distanceKpc ?? null,
        eosId, notes: [],
    };
    if (kind === 'bh') {
        const chi = typeof obj.chi === 'number' ? obj.chi : (obj.chi?.value ?? 0);
        const rh = M * horizonRadius(chi) * GEOM_KM;
        return { ...base, chi, chiSource: typeof obj.chi === 'number' ? 'custom' : (obj.chi?.source || 'assumed'),
            radiusKm: rh, radiusSource: 'horizon', compactness: 0.5, Lambda: 0, k2: 0,
            iscoKm: M * kerrIsco(chi) * GEOM_KM, horizonKm: rh, Mb: M, Ibar: null,
            eosSupported: true, star: null };
    }
    if (kind === 'wd') {
        const R = obj.radiusKm ? (typeof obj.radiusKm === 'number' ? obj.radiusKm : obj.radiusKm.value)
            : 5840 * Math.cbrt(1.018 / M);   // R ∝ M^{-1/3}, Newtonian mass–radius scaling
        const C = M * GEOM_KM / R;
        const Lambda = (2 / 3) * WD_K2 / C ** 5;
        return { ...base, chi: 0, radiusKm: R, radiusSource: obj.radiusKm ? 'measured' : 'scaled',
            compactness: C, Lambda, k2: WD_K2, Mb: M, Ibar: null, eosSupported: true, star: null,
            notes: ['White dwarf: Newtonian n = 1.5 polytrope; Λ = (2/3) k2 C⁻⁵ with k2 = 0.143.'] };
    }
    // Neutron star
    const seq = eosSequence(eosId);
    let star = starAtMass(createEos(eosId), M, seq);
    let eosSupported = true;
    const notes = [];
    if (!star) {
        eosSupported = false;
        star = seq.mmax;
        notes.push(`${M.toFixed(2)} M☉ exceeds ${eosId}'s M_max = ${seq.mmax.M.toFixed(2)} M☉ — this EOS cannot build it. Using the M_max star's structure, which is wrong by construction; pick a stiffer EOS.`);
    }
    const measuredR = obj.radiusKm && typeof obj.radiusKm !== 'number' ? obj.radiusKm : null;
    const radiusKm = measuredR ? measuredR.value : (typeof obj.radiusKm === 'number' ? obj.radiusKm : star.rKm);
    const radiusSource = measuredR ? 'measured' : (typeof obj.radiusKm === 'number' ? 'custom' : 'eos');
    if (measuredR) {
        const dev = star.rKm - measuredR.value;
        const sig = dev > 0 ? measuredR.plus : measuredR.minus;
        notes.push(`${eosId} predicts R = ${star.rKm.toFixed(2)} km at this mass; measured ${measuredR.value} (+${measuredR.plus}/−${measuredR.minus}) — ${Math.abs(dev) <= sig ? 'consistent within 1σ' : `${(Math.abs(dev) / sig).toFixed(1)}σ off`}.`);
    }
    const Ibar = iLoveBar(star.Lambda);
    const I_geom = Ibar * star.M ** 3;                      // M☉ (GM☉/c²)²
    const omegaGeom = base.spinPeriodS ? 2 * Math.PI / base.spinPeriodS * GEOM_S : 0;
    const chi = I_geom * omegaGeom / (star.M * star.M);
    const I_cgs = I_geom * MSUN_G * (GEOM_KM * 1e5) ** 2;
    if (chi > 0.7) notes.push(`χ = ${chi.toFixed(2)} from the spin period — beyond the mass-shedding limit for this structure; the I–Love estimate is being pushed past its slow-rotation domain.`);
    return {
        ...base, chi, chiSource: base.spinPeriodS ? 'from P and I–Love' : 'assumed 0',
        radiusKm, radiusSource, eosRadiusKm: star.rKm, measuredRadius: measuredR,
        compactness: star.M * GEOM_KM / radiusKm, eosCompactness: star.C,
        Lambda: star.Lambda, k2: star.k2, Mb: star.Mb, Ibar, I_cgs, eosSupported, star,
        rhoCcgs: star.rhoCcgs, notes,
    };
}

/** All catalog objects resolved on one EOS. */
export function resolveAll(eosId = 'SLy') { return OBJECTS.map(o => resolveProfile(o, eosId)); }
