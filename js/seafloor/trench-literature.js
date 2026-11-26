/**
 * trench-literature.js — PUBLISHED measurements of the bending plate at ocean trenches. PURE data.
 *
 * Transcribed 2026-11-23 from the papers' own tables (PDFs read directly; `verified: true` means the
 * numbers below were copied from the printed table, not recalled). They are what `trench-model.js`
 * is checked against — never an input to it.
 *
 *   GARCIA_2019  Garcia, Sandwell & Bassett (2019), "Outer trench slope flexure and faulting at Pacific
 *                basin subduction zones", Geophys. J. Int. 218, 708–728, doi:10.1093/gji/ggz155 — Table 2
 *                ("W" model). A nonlinear (yield-strength-envelope) plate fitted to shipboard bathymetry AND
 *                satellite gravity over 26 sub-regions. `teKm` is the effective elastic thickness AT THE
 *                POINT OF GREATEST CURVATURE ON THE OUTER TRENCH SLOPE — the weakest part of the plate.
 *                `ageMa` is the sub-region's mean sea-floor age (Müller et al. 2008, 2016).
 *                Their summary: the plate on the outer trench slope is "at least three times" thinner,
 *                elastically, than the same plate before it bends.
 *   ZHANG_2018   Zhang, Lin, Zhou, Yang & Zhan (2018), "Variation in bending of the subducting plates…",
 *                Geophys. J. Int. 212, 1429–1449 — Table 3. A thin elastic plate with TWO thicknesses,
 *                `teM` seaward of the outer rise and `tem` trenchward of a break at `xr`, loaded at the
 *                trench axis; 400 km profiles, sediment and thermal subsidence removed first.
 *                `x0` is where the deflection crosses zero and `wb` the bulge height — the same two
 *                observables `fitFlexure` returns. Their constants (Table 1) are E = 7×10¹⁰ Pa, ν = 0.25,
 *                ρ_w = 1030, ρ_m = 3300 kg m⁻³, g = 9.81 — exactly `trench-model.js` `ELASTIC`.
 *                Their summary: Te falls 20–70 % (mean 47 %) toward the trench; trench depth and width are
 *                set mainly by the REDUCED thickness `tem`.
 *   Levitt & Sandwell (1995, JGR 100, 379–400) fitted a uniform elastic plate to 117 profiles and report
 *                that their individual thickness estimates "have considerable scatter and do not constrain
 *                a particular isotherm" — the scan's table is not machine-readable and is NOT transcribed.
 *
 * WHAT THIS SETTLES ABOUT OUR OWN NUMBER. A single-thickness fit to the trench slope (ours) measures the
 * BENT, WEAKENED plate, so it is to be compared with Garcia's outer-slope `teKm` and Zhang's `tem` —
 * never with `teM`, the unbent plate, which is two to four times thicker.
 */
export const GARCIA_2019 = Object.freeze({
    cite: 'Garcia, Sandwell & Bassett 2019, Geophys. J. Int. 218, 708–728 (Table 2, W model)', doi: '10.1093/gji/ggz155', verified: true,
    rows: Object.freeze([
        ['MD01', -94.02, 14.20, 22.73, 4.50], ['MD02', -90.66, 12.54, 23.63, 3.27], ['MD03', -87.09, 10.63, 23.97, 3.50],
        ['PE01', -81.44, -7.38, 29.90, 9.36], ['CL03', -72.55, -31.06, 39.70, 8.42], ['PE02', -78.76, -12.33, 40.65, 11.54],
        ['CL02', -72.18, -28.76, 44.47, 9.50], ['CL01', -71.33, -23.45, 51.49, 6.97], ['AL05', -161.02, 53.45, 52.12, 13.06],
        ['AL01', -179.73, 50.36, 53.71, 12.53], ['AL02', -175.12, 50.58, 54.91, 13.28], ['AL04', -165.46, 52.44, 55.15, 12.97],
        ['PE03', -72.44, -18.44, 55.36, 7.02], ['AL03', -170.70, 51.17, 60.62, 12.57], ['TO01', -174.21, -22.34, 90.63, 16.94],
        ['TO02', -173.08, -19.80, 96.71, 16.64], ['TO03', -172.33, -16.33, 104.41, 11.99], ['KE01', -178.05, -33.91, 116.56, 17.27],
        ['KU03', 154.07, 46.18, 117.70, 16.35], ['KU02', 151.18, 44.47, 118.90, 12.91], ['KU01', 145.92, 41.65, 127.24, 19.35],
        ['JP02', 144.31, 39.64, 129.06, 18.27], ['IB02', 142.12, 32.06, 130.71, 13.09], ['JP01', 143.41, 37.01, 132.30, 21.78],
        ['IB01', 142.86, 29.19, 137.22, 14.29], ['MA01', 147.77, 17.82, 147.77, 21.85],
    ].map(([id, lon, lat, ageMa, teKm]) => Object.freeze({ id, lon, lat, ageMa, teKm }))),
});

export const ZHANG_2018 = Object.freeze({
    cite: 'Zhang, Lin, Zhou, Yang & Zhan 2018, Geophys. J. Int. 212, 1429–1449 (Table 3)', verified: true,
    constants: Object.freeze({ E: 7e10, nu: 0.25, rhoWater: 1030, rhoMantle: 3300, g: 9.81 }),
    teReductionPct: Object.freeze({ min: 20, max: 70, mean: 47 }),
    // [section, trench, age Ma, W0 km, Wb km, X0 km, Xr km, TeM km, Tem km, printed Te reduction %]  (−V0 and M0 are not transcribed)
    rows: Object.freeze([
        [1, 'Philippine', 68, -0.9, 0.40, 35, 45, 57, 22.8, 60], [2, 'Philippine', 95, -2.6, 0.43, 51, 45, 54, 24.3, 55], [3, 'Philippine', 99, -2.6, 0.22, 31, 40, 48, 16.8, 65],
        [4, 'Kuril', 112, -3.3, 0.50, 57, 80, 56, 25.2, 55], [5, 'Kuril', 118, -4.2, 0.17, 79, 100, 35, 24.5, 30],
        [6, 'Japan', 126, -2.6, 0.10, 65, 80, 56, 30.8, 45], [7, 'Japan', 132, -2.7, 0.23, 93, 115, 40, 22.0, 45],
        [8, 'Izu-Bonin', 135, -4.3, 0.25, 80, 95, 57, 31.3, 45],
        [9, 'Aleutian', 137, -3.2, 0.15, 53, 90, 45, 20.2, 55], [10, 'Aleutian', 65, -1.8, 0.20, 39, 65, 39, 25.3, 35], [11, 'Aleutian', 56, -1.5, 0.30, 44, 80, 60, 18.0, 70],
        [12, 'Aleutian', 62, -1.5, 0.37, 30, 45, 39, 21.5, 45], [13, 'Aleutian', 54, -2.0, 0.18, 58, 70, 26, 18.2, 30],
        [14, 'Tonga', 104, -3.3, 0.20, 49, 60, 64, 22.4, 65], [15, 'Kermadec', 96, -3.5, 0.33, 61, 70, 37, 18.5, 50],
        [16, 'M. America', 19, -2.0, 0.12, 39, 35, 23, 11.5, 50], [17, 'Peru', 27, -1.3, 0.29, 53, 50, 23, 16.1, 30],
        [18, 'Chile', 49, -2.7, 0.30, 48, 70, 58, 26.1, 55], [19, 'Chile', 39, -2.4, 0.14, 58, 60, 48, 24.0, 50],
        [20, 'Sumatra', 125, -1.5, 0.19, 52, 70, 55, 33.0, 40], [21, 'Java', 72, -1.1, 0.23, 61, 90, 59, 35.4, 40],
        [22, 'S. Manila', 24, -1.4, 0.06, 30, 30, 16, 5.9, 62], [23, 'C. Manila', 25, -1.3, 0.05, 41, 34, 15, 6.5, 56], [24, 'N1. Manila', 32, -0.5, 0.05, 47, 50, 15, 10.7, 29], [25, 'N2. Manila', 36, -0.6, 0.05, 39, 46, 15, 9.1, 39],
        [26, 'S. Mariana', 150, -4.2, 0.36, 77, 88, 48, 27.1, 43], [27, 'C. Mariana', 149, -2.3, 0.29, 71, 94, 49, 30.6, 38], [28, 'N. Mariana', 142, -1.8, 0.29, 67, 86, 49, 35.4, 28],
    ].map(([section, trench, ageMa, w0Km, wbKm, x0Km, xrKm, teMKm, temKm, reductionPct]) => Object.freeze({ section, trench, ageMa, w0Km, wbKm, x0Km, xrKm, teMKm, temKm, reductionPct }))),
});

/** Which of Zhang's trench names belong to each of this page's sites (the table gives no coordinates). The Aleutian site is at 180°, on 54 Ma sea floor: section 9 (137 Ma, the far west) is not it. */
export const ZHANG_SITES = Object.freeze({
    philippine: ['Philippine'], kuril: ['Kuril'], japan: ['Japan'], 'izu-bonin': ['Izu-Bonin'], tonga: ['Tonga'], kermadec: ['Kermadec'],
    'middle-america': ['M. America'], atacama: ['Chile'], java: ['Java'], mariana: ['S. Mariana'],
});
const ALEUTIAN_SECTIONS = [10, 11, 12, 13];
/** A published sub-region is "this trench" within this distance of the point (their sub-regions are 300–600 km long). */
export const GARCIA_NEAR_KM = 350;

const D2R = Math.PI / 180;
function km(lat1, lon1, lat2, lon2) { const a = Math.sin((lat2 - lat1) * D2R / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin((lon2 - lon1) * D2R / 2) ** 2; return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a))); }
const span = (v) => (v.length ? { min: Math.min(...v), max: Math.max(...v), n: v.length } : null);

/**
 * What has been published for the trench at a point. Returns
 * { garcia: { id, km, ageMa, teKm } | null, zhang: { rows, x0Km, wbKm, temKm, teMKm (each { min, max, n }), ageMa } | null }.
 * `siteId` selects Zhang's rows (named trenches); Garcia's are found by distance.
 */
export function publishedFor(lat, lon, siteId = null) {
    let g = null;
    for (const r of GARCIA_2019.rows) { const d = km(lat, lon, r.lat, r.lon); if (d <= GARCIA_NEAR_KM && (!g || d < g.km)) g = { id: r.id, km: d, ageMa: r.ageMa, teKm: r.teKm }; }
    let rows = [];
    if (siteId === 'aleutian') rows = ZHANG_2018.rows.filter((r) => ALEUTIAN_SECTIONS.includes(r.section));
    else if (siteId && ZHANG_SITES[siteId]) rows = ZHANG_2018.rows.filter((r) => ZHANG_SITES[siteId].includes(r.trench));
    const zhang = rows.length ? { rows, x0Km: span(rows.map((r) => r.x0Km)), wbKm: span(rows.map((r) => r.wbKm)), temKm: span(rows.map((r) => r.temKm)), teMKm: span(rows.map((r) => r.teMKm)), ageMa: span(rows.map((r) => r.ageMa)) } : null;
    return { garcia: g, zhang };
}

/**
 * Our fit beside the published ones. `tm` is a trenchModel result, `quoted` its quotedThickness.
 * The BRACKET is the span of the two published NEAR-TRENCH thicknesses (Garcia's outer-slope value and
 * Zhang's trenchward `tem`) — two methods that themselves differ by up to a factor of two, which is the
 * honest width of "what is known". `inside` allows `BRACKET_TOLERANCE` beyond each end.
 * Returns null when nothing is published here.
 */
export const BRACKET_TOLERANCE = 0.1;
export function compareWithPublished(tm, quoted, published) {
    if (!published || (!published.garcia && !published.zhang)) return null;
    const g = published.garcia, z = published.zhang;
    const near = [g ? g.teKm : null, z ? z.temKm.min : null, z ? z.temKm.max : null].filter((v) => v != null);
    const bracket = near.length ? { lo: Math.min(...near), hi: Math.max(...near) } : null;
    const stations = tm && tm.along ? tm.along.stations.filter((s) => s.flexure && s.flexure.quality === 'good').map((s) => s.flexure) : (tm && tm.flexure && tm.flexure.quality === 'good' ? [tm.flexure] : []);
    const ours = quoted ? { teKm: quoted.teKm, teMin: quoted.teMin, teMax: quoted.teMax } : null;
    return {
        garcia: g, zhang: z, bracket, ours,
        inside: ours && bracket ? ours.teKm >= bracket.lo * (1 - BRACKET_TOLERANCE) && ours.teKm <= bracket.hi * (1 + BRACKET_TOLERANCE) : null,
        x0Km: span(stations.map((f) => f.x0)), wbKm: span(stations.map((f) => f.wb / 1000)),
        unbentKm: z ? z.teMKm : null, ageMa: g ? g.ageMa : (z ? z.ageMa.min : null), ageSource: g ? 'garcia' : (z ? 'zhang' : null),
    };
}

/**
 * A two-thickness fit (broken-plate.js `brokenStation`) against Zhang et al. 2018's two-thickness rows for the
 * same trench: is each published value INSIDE our interval for it? T_eM is compared with our interval as far as
 * it reaches (an open upper end accepts any larger value). Null when there is no published row or no accepted fit.
 */
export function compareTwoThickness(fit, published) {
    const z = published && published.zhang;
    if (!fit || !fit.accepted || !z) return null;
    const I = fit.intervals, inside = (iv, r, open) => !!iv && r.max >= iv[0] * (1 - BRACKET_TOLERANCE) && (open && iv[3] ? true : r.min <= iv[1] * (1 + BRACKET_TOLERANCE));
    const span = (k) => ({ min: Math.min(...z.rows.map((r) => r[k])), max: Math.max(...z.rows.map((r) => r[k])) });
    const tem = span('temKm'), teM = span('teMKm'), xr = span('xrKm');
    return { tem, teM, xr, temInside: inside(I.tem, tem, false), teMInside: inside(I.teM, teM, true), xrInside: inside(I.xr, xr, false) };
}
