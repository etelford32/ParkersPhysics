/**
 * chicxulub/observations.js — what is KNOWN about the Chicxulub impact (PURE data).
 * ═══════════════════════════════════════════════════════════════════════════
 * The ONE table of evidence the reconstruction reads. Every entry carries:
 *
 *   value / lo / hi / sigma   the number and its stated range
 *   kind      'measured'  — read off the rock (seismic images, cores, layers)
 *             'inferred'  — a published MODEL result (hydrocode, GCM); it is a
 *                           target to compare with, never a measurement
 *   source    the publication
 *   verified  'search'    — the number was confirmed against a search result
 *                           quoting the source during the build (2026-11-22)
 *             false       — RECALLED from the literature, not checked. The
 *                           paper hosts (nature.com, PMC, arXiv, Wiley, NSF
 *                           PAR) were egress-blocked at build time, so nothing
 *                           here was read from a paper's own page. Checking a
 *                           `false` row against its paper and flipping the flag
 *                           is real work (the flare-realism rule).
 *
 * data/chicxulub/SOURCES.md is the prose version, with what is still missing.
 * tests/chicxulub.mjs pins the internal consistency of this table (ranges
 * ordered, every row flagged, the Ir bookkeeping).
 */

const row = (o) => Object.freeze(o);

// ── 1. The structure ────────────────────────────────────────────────────────
export const CRATER = Object.freeze({
    centre: row({
        latDeg: 21 + 20 / 60, lonDeg: -(89 + 30 / 60), kind: 'measured',
        source: 'Impact Earth / crater listings (N 21°20′, W 89°30′)', verified: 'search',
    }),
    rimDiameterKm: row({
        value: 190, lo: 180, hi: 200, kind: 'measured',
        source: 'Morgan et al. 1997; Gulick et al. 2008 (seismic reflection, 1996 + 2005 surveys)',
        verified: 'search',
        note: 'Outer rim. Which ring is "the" rim is a real ambiguity: 150 km is also quoted.',
    }),
    innerRimDiameterKm: row({
        value: 155, lo: 140, hi: 170, kind: 'measured',
        source: 'Gulick et al. 2013 (topographic inner rim)', verified: 'search',
    }),
    peakRingDiameterKm: row({
        value: 85, lo: 80, hi: 90, kind: 'measured',
        source: 'Morgan et al. 1997 (~80 km); Rae et al. 2019 (80–90 km, up to 400 m relief)',
        verified: 'search',
    }),
    transientCavityDiameterKm: row({
        value: 100, lo: 90, hi: 110, kind: 'inferred',
        source: 'Morgan et al. 1997 and later reconstructions', verified: false,
        note: 'Reconstructed from the seismic images, not observed. NOT used as a constraint.',
    }),
    mohoUpliftKm: row({
        value: 1.75, lo: 1.5, hi: 2, kind: 'measured',
        source: 'Christeson et al. 2009 (seismic refraction)', verified: false,
    }),
    burialDepthKm: row({
        value: 1, lo: 0.5, hi: 1.5, kind: 'measured',
        source: 'Cenozoic carbonate cover; M0077A reached the peak ring at 618 mbsf', verified: false,
    }),
    drillSite: row({
        name: 'IODP–ICDP Expedition 364, Hole M0077A',
        latDeg: 21 + 26.996 / 60, lonDeg: -(89 + 56.968 / 60),
        coreTopMbsf: 505.70, coreBottomMbsf: 1334.69,
        suevite: [617.33, 747.02], granitoid: [747.02, 1334.69],
        firstDayDepositM: 130, kind: 'measured',
        source: 'Morgan, Gulick et al., Exp. 364 Proceedings; Gulick et al. 2019 PNAS',
        verified: 'search',
        note: '~130 m of melt rock and breccia laid down on the first day; the lowest 40–50 m within minutes.',
    }),
});

// ── 2. When ─────────────────────────────────────────────────────────────────
export const AGE = Object.freeze({
    ma: row({
        value: 66.043, sigma: 0.011, kind: 'measured',
        source: 'Renne et al. 2013 Science (⁴⁰Ar/³⁹Ar, tektites vs the boundary)', verified: 'search',
    }),
    season: row({
        value: 'boreal spring', kind: 'measured',
        source: 'During et al. 2022 Nature (fish bone growth at Tanis)', verified: false,
    }),
});

// ── 3. The target ───────────────────────────────────────────────────────────
export const TARGET = Object.freeze({
    sedimentThicknessKm: row({
        value: 3, lo: 2.5, hi: 3.5, kind: 'measured',
        source: 'Yucatán platform carbonates + evaporites over granitoid basement', verified: false,
    }),
    lithology: row({
        value: 'marine carbonates and evaporites (anhydrite) over granitoid crust', kind: 'measured',
        source: 'Gulick et al. 2019 PNAS', verified: 'search',
    }),
    crustDensity: row({ value: 2700, kind: 'inferred', source: 'granitoid upper crust', verified: false }),
    waterDepthKm: row({
        value: 1, lo: 0.1, hi: 2, kind: 'inferred',
        source: 'Range et al. 2022 fiducial run (1 km seafloor depth); shallow on the platform, deeper to the NE',
        verified: 'search',
    }),
});

// ── 4. What the impactor left behind ────────────────────────────────────────
export const EARTH_AREA_CM2 = 4 * Math.PI * (6371e5) ** 2;      // 5.10e18 cm²

export const IRIDIUM = Object.freeze({
    fluenceNgCm2: row({
        value: 55, sigma: 3, kind: 'measured',
        source: 'Goderis et al. 2021 Science Advances (mean of 52 marine + non-marine sections)',
        verified: 'search',
    }),
    fluenceLowNgCm2: row({
        value: 28, kind: 'measured',
        source: 'Moore & Sharma 2013 LPSC abstract 2431 (revised global Ir fluence)', verified: 'search',
        note: 'A lower published value; the reconstruction reports both.',
    }),
    nearCraterNgCm2: row({
        lo: 10, hi: 45, kind: 'measured', source: 'Goderis et al. 2021 (sites near the crater)', verified: 'search',
    }),
    // Bulk Ir of the candidate impactor classes, ng/g. Compilations differ by ~10 %.
    abundanceNgG: row({
        CM: 595, CI: 470, CV: 760, CO: 735, H: 760, L: 490,
        kind: 'measured', source: 'Wasson & Kallemeyn 1988 (chondrite group means)', verified: false,
    }),
});

export const IMPACTOR_TYPE = Object.freeze([
    row({ evidence: '⁵⁴Cr in boundary sediments', result: 'CM2-type carbonaceous chondrite (~80 % of boundary Cr from the projectile)',
          source: 'Trinquier et al. 2006; Quitté et al. 2007', verified: 'search' }),
    row({ evidence: 'Ru isotopes at three boundary sites', result: 'carbonaceous-type asteroid formed beyond Jupiter; a comet is disfavoured',
          source: 'Fischer-Gödde et al. 2024 Science 385, 752', verified: 'search' }),
    row({ evidence: 'a 2 cm fossil meteorite in a North Pacific boundary core', result: 'carbonaceous chondrite',
          source: 'Kyte 1998 Nature', verified: 'search' }),
    row({ evidence: 'dynamics of the main belt', result: 'main-belt asteroid, ~60 % from beyond 2.5 au; a ≥10 km impact about every 250 Myr',
          source: 'Nesvorný, Bottke & Marchi 2021 Icarus', verified: 'search' }),
]);

// Bulk density of the candidate body, kg/m³. A CM meteorite is ~2200–2300; a
// CM-like ASTEROID with macroporosity is lower. The hydrocodes use 2630.
export const IMPACTOR_DENSITY = Object.freeze({
    lo: 1400, value: 2200, hi: 2700, hydrocode: 2630, kind: 'inferred',
    source: 'CM grain/bulk densities (Britt & Consolmagno); Collins et al. 2020 used 2630', verified: false,
});

// ── 5. Published trajectory and impactor reconstructions (MODEL results) ────
export const TRAJECTORY = Object.freeze({
    angleDeg: row({
        lo: 45, hi: 60, kind: 'inferred',
        source: 'Collins et al. 2020 Nature Communications 11, 1480 (iSALE-3D vs crater asymmetry)',
        verified: 'search',
        note: 'Angle to the horizontal. Below 30° is ruled out by several lines of evidence.',
    }),
    fromAzimuthDeg: row({
        value: 45, lo: 15, hi: 75, kind: 'inferred',
        source: 'Collins et al. 2020: "from the northeast"', verified: 'search',
        note: 'The compass direction is published; the ±30° width is OUR reading of "northeast".',
    }),
    evidence: row({
        value: 'peak-ring centre offset downrange (~5 % of the crater diameter), mantle-uplift centre offset uprange; no gap in the peak ring',
        source: 'Collins et al. 2020', verified: 'search',
    }),
});

export const PUBLISHED_IMPACTORS = Object.freeze([
    row({ label: 'Collins 2020 (3-D)', diameterKm: 17, speedKms: 12, angleDeg: 60, density: 2630,
          source: 'Collins et al. 2020', verified: false }),
    row({ label: 'Range 2022 (tsunami)', diameterKm: 14, speedKms: 12, angleDeg: 90, density: 2650,
          source: 'Range et al. 2022 AGU Advances', verified: 'search',
          note: '14 km and 12 km/s confirmed; angle and density recalled.' }),
    row({ label: 'Artemieva & Morgan 2017', diameterKm: 12, speedKms: 18, angleDeg: 60, density: 2630,
          source: 'Artemieva & Morgan 2017 GRL', verified: false }),
]);

export const ENERGY = Object.freeze({
    joules: row({ lo: 1e23, hi: 4e23, kind: 'inferred',
        source: 'Morgan et al. 2022 Nat. Rev. Earth Environ. (~10²³ J); 4×10²³ J also widely quoted', verified: 'search' }),
    seismicMw: row({ lo: 10, hi: 11, kind: 'inferred',
        source: 'DePalma et al. 2019 PNAS and references therein', verified: 'search' }),
});

// ── 6. Ejecta ───────────────────────────────────────────────────────────────
// Coordinates are present-day and approximate; `distanceKm` is computed from
// them by the kernel (present separation — Haiti has since moved with the
// Caribbean plate, so its K–Pg distance was somewhat different).
export const EJECTA_SITES = Object.freeze([
    row({ name: 'Beloc, Haiti', latDeg: 18.4, lonDeg: -72.6, thicknessM: 0.46, hiM: 1.25,
          source: 'Kring (LPI): primary deposit ~46 cm; reworked up to 125 cm', verified: 'search', coordsVerified: false }),
    row({ name: 'El Mimbral, NE Mexico', latDeg: 23.2, lonDeg: -98.7, thicknessM: 0.5, loM: 0, hiM: 1.0,
          source: 'NE Mexico spherule beds 0–1.0 m', verified: 'search', coordsVerified: false,
          note: 'The search confirmed 0–1 m for NE Mexico, not this named section.' }),
    row({ name: 'Raton Basin, USA', latDeg: 37.0, lonDeg: -104.5, thicknessM: 0.015,
          source: 'Western Interior dual layer, ~1–2 cm', verified: false, coordsVerified: false }),
    row({ name: 'Tanis, North Dakota', latDeg: 46.0, lonDeg: -103.4, thicknessM: null,
          source: 'DePalma et al. 2019 PNAS — surge deposit with ejecta spherules arriving during the surge',
          verified: 'search', coordsVerified: false }),
]);
export const DISTAL_LAYER = row({
    thicknessMm: 3, beyondKm: 5000, kind: 'measured',
    source: 'Hildebrand; Morgan et al. 2022 — a ~3 mm global clay with spherules, shocked minerals and the Ir peak',
    verified: 'search',
});

// ── 7. Ocean ────────────────────────────────────────────────────────────────
export const TSUNAMI = Object.freeze({
    earlyWave: row({ heightKm: 4.5, atMin: 2.5, kind: 'inferred', source: 'Range et al. 2022 (ejecta-curtain wave)', verified: 'search' }),
    ringWave: row({ heightKm: 1.5, atMin: 10, radiusKm: 220, kind: 'inferred', source: 'Range et al. 2022', verified: 'search' }),
    gulfOpenOceanM: row({ lo: 100, kind: 'inferred', source: 'Range et al. 2022 (>100 m in the Gulf of Mexico)', verified: 'search' }),
    farCoastsM: row({ lo: 10, kind: 'inferred', source: 'Range et al. 2022 (>10 m on most N. Atlantic and S. Pacific coasts)', verified: 'search' }),
    energyVs2004: row({ value: 30000, kind: 'inferred', source: 'Range et al. 2022', verified: 'search' }),
});

// ── 8. Atmosphere and climate (GCM results — targets, never measurements) ───
export const VOLATILES = Object.freeze({
    sulfurGt: row({ value: 325, sigma: 130, kind: 'inferred', source: 'Artemieva & Morgan 2017 GRL', verified: 'search',
        note: '325 Gt confirmed; the ±130 is recalled.' }),
    co2Gt: row({ value: 425, sigma: 160, kind: 'inferred', source: 'Artemieva & Morgan 2017 GRL', verified: 'search',
        note: '425 Gt confirmed; the ±160 is recalled.' }),
    sootTg: row({ value: 15000, kind: 'inferred', source: 'Bardeen et al. 2017 PNAS (from Wolbach\'s boundary soot)', verified: 'search' }),
    fineDustTg: row({ value: null, kind: 'inferred', source: 'Senel et al. 2023 Nature Geoscience (0.8–8 µm silicate dust)', verified: false,
        note: 'The injected mass was not confirmed and is not recalled reliably (a 1000× ambiguity) — left empty rather than guessed.' }),
});

export const CLIMATE_TARGETS = Object.freeze([
    row({ id: 'soot', agent: 'soot', massTg: 15000, peakCoolingK: 16, darkYears: 2,
          source: 'Bardeen et al. 2017 PNAS: −16 °C global mean; sunlight below 1 % for almost 2 yr',
          verified: 'search' }),
    row({ id: 'dust', agent: 'fine silicate dust', massTg: null, peakCoolingK: 15, darkYears: 2,
          source: 'Senel et al. 2023: up to −15 °C; photosynthesis shut down for almost 2 yr; dust lingers ~15 yr',
          verified: 'search', note: 'Cooling and duration confirmed; the injected mass is not, so the box is not run for it.' }),
    row({ id: 'sulfate', agent: 'sulfate aerosol', massTg: 325000 * 3.06, peakCoolingK: 26, darkYears: null,
          source: 'Brugger, Feulner & Petri 2017 GRL: −26 °C global annual mean', verified: false,
          note: 'Mass is 325 Gt S as H₂SO₄ (×98/32).' }),
]);

export const EXTINCTION = row({
    speciesLostPct: 75, kind: 'measured', source: 'standard K–Pg estimate (~75 % of species)', verified: false,
});

// ── 9. Still missing ────────────────────────────────────────────────────────
export const OPEN_DATA = Object.freeze([
    'Yucatán palaeolatitude and rotation at 66 Ma (the trajectory uses present coordinates)',
    'Collins et al. 2020 model inputs and the measured centre offsets in km (read the paper)',
    'Nesvorný et al. 2021 impact-speed distribution for ≥10 km carbonaceous impactors',
    'a fitted ejecta thickness–distance table (Belize, Brazos, Raton, Tanis with K–Pg distances)',
    'Brugger 2017 and Bardeen 2017 land/ocean splits and durations',
    'the gravity and magnetic anomaly grids (the asymmetry itself, not its published reading)',
]);

/** Every row in this module, flattened — for the gate and the page's evidence table. */
export function allRows() {
    const out = [];
    const walk = (group, obj) => {
        for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object' && 'source' in v) out.push({ group, key: v.label ?? v.name ?? v.id ?? v.evidence ?? k, ...v });
        }
    };
    walk('crater', CRATER); walk('age', AGE); walk('target', TARGET); walk('iridium', IRIDIUM);
    walk('type', IMPACTOR_TYPE); walk('trajectory', TRAJECTORY); walk('published', PUBLISHED_IMPACTORS);
    walk('energy', ENERGY); walk('ejecta', EJECTA_SITES); walk('ejecta', { distal: DISTAL_LAYER });
    walk('tsunami', TSUNAMI); walk('volatiles', VOLATILES); walk('climate', CLIMATE_TARGETS);
    walk('extinction', { extinction: EXTINCTION }); walk('density', { density: IMPACTOR_DENSITY });
    return out;
}
