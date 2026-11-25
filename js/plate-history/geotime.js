/**
 * geotime.js — the geologic time scale, and literature supercontinent windows (PURE data + lookup).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. Used ONLY to NAME times on plate-tectonics.html (the scrubber band,
 * the readout, chart annotations). No measurement reads it: the supercontinent index in
 * diagnostics.js knows no names and no dates, and tests/plate-history-diagnostics.mjs compares
 * its peaks with LITERATURE_SUPERCONTINENTS as a plausibility check, never as a fit.
 *
 * Boundaries are the International Chronostratigraphic Chart (ICS) v2023/09, WRITTEN FROM
 * MEMORY at build time (stratigraphy.org was not checked) — `VERIFIED` is false until someone
 * compares this table with the chart. Precambrian period boundaries are chronometric (round
 * numbers by definition); a leading "~" on the chart is kept as `approx`.
 */
export const VERIFIED = false;
export const SOURCE = 'International Commission on Stratigraphy, International Chronostratigraphic Chart v2023/09 (from memory — unverified)';

/** [name, base Ma, top Ma, approx?] — youngest first. */
export const EONS = [
    ['Phanerozoic', 538.8, 0], ['Proterozoic', 2500, 538.8], ['Archean', 4031, 2500], ['Hadean', 4567, 4031, true],
];
export const ERAS = [
    ['Cenozoic', 66.0, 0], ['Mesozoic', 251.902, 66.0], ['Paleozoic', 538.8, 251.902],
    ['Neoproterozoic', 1000, 538.8], ['Mesoproterozoic', 1600, 1000], ['Paleoproterozoic', 2500, 1600],
];
export const PERIODS = [
    ['Quaternary', 2.58, 0], ['Neogene', 23.03, 2.58], ['Paleogene', 66.0, 23.03],
    ['Cretaceous', 143.1, 66.0, true], ['Jurassic', 201.4, 143.1], ['Triassic', 251.902, 201.4],
    ['Permian', 298.9, 251.902], ['Carboniferous', 358.9, 298.9], ['Devonian', 419.62, 358.9],
    ['Silurian', 443.8, 419.62], ['Ordovician', 486.85, 443.8], ['Cambrian', 538.8, 486.85],
    ['Ediacaran', 635, 538.8, true], ['Cryogenian', 720, 635, true], ['Tonian', 1000, 720, true],
    ['Stenian', 1200, 1000], ['Ectasian', 1400, 1200], ['Calymmian', 1600, 1400],
    ['Statherian', 1800, 1600], ['Orosirian', 2050, 1800], ['Rhyacian', 2300, 2050], ['Siderian', 2500, 2300],
];

/**
 * Literature windows for the three supercontinents this model spans — the AGES OTHERS ASSIGN,
 * for comparison with what the index measures. Ranges are deliberately wide (authors disagree
 * by tens of Myr on assembly and break-up), recalled from the cited reviews, unverified.
 */
export const LITERATURE_SUPERCONTINENTS = [
    { name: 'Pangaea', assembled: 320, brokeUp: 180, cite: 'e.g. Torsvik & Cocks (2017), Earth History and Palaeogeography' },
    { name: 'Rodinia', assembled: 900, brokeUp: 750, cite: 'Li et al. (2008) Precambrian Research 160; Merdith et al. (2017)' },
    { name: 'Nuna (Columbia)', assembled: 1600, brokeUp: 1400, cite: 'Zhang et al. (2012) EPSL 353; Pehrsson et al. (2016)' },
];

function find(table, t) {
    for (const row of table) if (t <= row[1] && t >= row[2]) return { name: row[0], base: row[1], top: row[2], approx: !!row[3] };
    return null;
}

/** { eon, era, period } names for time t (Ma); null where the table has none. */
export function unitsAt(t) {
    return { eon: find(EONS, t), era: find(ERAS, t), period: find(PERIODS, t) };
}

/** "252 Ma" / "1.25 Ga" / "today" — a human label for a time in Ma. */
export function formatAge(t) {
    if (t < 0.05) return 'today';
    if (t < 10) return `${t.toFixed(1)} Ma`;
    if (t < 1000) return `${Math.round(t)} Ma`;
    return `${(t / 1000).toFixed(t % 100 === 0 ? 1 : 2)} Ga`;
}
