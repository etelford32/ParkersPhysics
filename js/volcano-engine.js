/**
 * volcano-engine.js — the Earth Volcanoes engine (PURE: no DOM, no fetch, no
 * ambient time, no Math.random). node-gated by tests/volcano-engine.mjs.
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE CATALOGUE, ONE ENGINE. data/volcanoes/volcanoes-catalog.json (baked by
 * scripts/build-volcano-catalog.mjs from the Smithsonian GVP's own tables) is
 * read ONLY through `decodeCatalog`; earth.html's volcano layer
 * (js/earth-volcano-layer.js) and volcanoes.html both draw what this module
 * returns and compute nothing of their own.
 *
 * WHAT IS OBSERVED AND WHAT IS MODEL — the split every consumer must keep:
 *
 *   OBSERVED (GVP)  identity, position, type, tectonic setting, evidence, last
 *                   known eruption (lists of 22 Mar 2026), every catalogued
 *                   eruption's start year + VEI (eruption table through early
 *                   2020), population within 5/10/30/100 km (GVP, 2020).
 *   CLASSIFIED      `status` — six recency classes with stated thresholds
 *                   (STATUS below). A rule applied to observations, not data.
 *   MODEL           everything from §3 on: eruption-onset rates, VEI
 *                   probabilities, eruption columns, stratospheric sulfur,
 *                   aerosol optical depth, radiative forcing and the global
 *                   temperature response. Each step is a published scaling
 *                   with its constants in one place and its source named.
 *
 * §1 STATUS. "Active" has no single definition (USGS: any Holocene eruption;
 * popular usage: erupted in recorded history). We keep six classes and the
 * three groups the page talks about: ACTIVE = erupting + recent + historical,
 * DORMANT = dormant Holocene + unconfirmed Holocene, INACTIVE = Pleistocene
 * (no known eruption in ~11,700 yr — inactive, NOT extinct; GVP keeps them
 * because some will erupt again).
 *
 * §2 HAZARD — eruption ONSET rate, empirical-Bayes Gamma–Poisson. Counting
 * window 1900 → catalogue epoch (the record is reasonably complete for
 * VEI ≥ 2 since ~1900; smaller eruptions in remote places are missed). The
 * population prior Gamma(a, b) is the negative-binomial MLE over EVERY
 * Holocene volcano's count, zeros included — so a volcano with no eruption
 * since 1900 inherits the population's base rate instead of the 1/(2T) a
 * flat prior would hand to everything. Per volcano: λ | N ~ Gamma(a+N, b+T),
 * and the predictive chance of ≥ 1 onset in Δt is 1 − ((b+T)/(b+T+Δt))^(a+N)
 * (closed form). Two honest caveats are disclosed by the page: (i) a decades-
 * long eruption (Stromboli since 1934) counts ONCE — this is the chance a NEW
 * eruption begins; (ii) the eruption table ends in 2020, so a volcano whose
 * list-reported last eruption is newer gets ONE extra onset, never more.
 * Pleistocene volcanoes are outside the prior's population: they get the
 * Jeffreys posterior for zero events in the Holocene, Gamma(½, T_H).
 *
 * §3 SIZE — VEI probabilities: the volcano's own VEIs since VEI_RECORD_FROM
 * (older small eruptions are not preserved, so the full Holocene record is
 * biased large) plus VEI_PRIOR_WEIGHT pseudo-eruptions of the global modern
 * distribution (Dirichlet–multinomial).
 *
 * §4 COLUMN — VEI → bulk tephra volume (geometric bin centre, Newhall & Self
 * 1982) → dense-rock volume (deposit 1000 / magma 2500 kg m⁻³) → climactic-
 * phase duration (a DISCLOSED table) → volume flux → Mastin et al. (2009)
 * H = 2.00 V̇^0.241 km above the vent. The durations are chosen so every VEI ≥ 2
 * column lands inside Newhall & Self's observed range (the gate checks it);
 * VEI 0–1 are not sustained columns and take the range's geometric centre.
 *
 * §5 SULFUR → CLIMATE. SO₂ mass from VEI on a log-linear fit to named
 * eruptions (SO2_ANCHORS — big scatter: sulfur content is not VEI), the part
 * above a latitude-dependent tropopause, global-mean peak AOD (Pinatubo-
 * anchored, ∝ M^(2/3) above Pinatubo because aerosol grows and falls faster
 * when there is more of it), a rise–decay profile with a latitude-dependent
 * residence, forcing −21 W m⁻² per unit AOD, and a one-box energy balance.
 * This is a CONSEQUENCE CALCULATOR for "what would a VEI-n at this volcano do
 * to global climate", not a climate model; the gate pins it to Pinatubo.
 *
 * §6 SIMULATION — a seeded Monte-Carlo of the next decades of global
 * volcanism: each Holocene volcano draws its rate from its own posterior
 * (parameter uncertainty), onsets are Poisson, sizes from §3, consequences
 * from §4–5. Ensemble percentiles of forcing and temperature. Plus a REPLAY
 * of the catalogued 1900–2020 eruptions through the same chain.
 */

// ═══ §0 constants ═══════════════════════════════════════════════════════════

export const HOLOCENE_START_CE = -9700;          // 11.7 ka b2k
export const HAZARD_WINDOW_FROM = 1900;
export const VEI_RECORD_FROM = 1500;
export const VEI_PRIOR_WEIGHT = 3;
export const VEI_MAX = 8;

export const STATUS = Object.freeze({
    erupting:   { label: 'Erupting (2025–26)',      group: 'active',   rank: 0,
                  rule: 'last known eruption in the catalogue year or the one before it' },
    recent:     { label: 'Recently active (since 1900)', group: 'active', rank: 1,
                  rule: 'last known eruption 1900 CE or later' },
    historical: { label: 'Historical (before 1900)', group: 'active',  rank: 2,
                  rule: 'last known eruption dated CE, before 1900' },
    dormant:    { label: 'Dormant (Holocene)',      group: 'dormant',  rank: 3,
                  rule: 'Holocene eruption dated BCE, or confirmed Holocene activity of unknown date' },
    uncertain:  { label: 'Holocene, unconfirmed',   group: 'dormant',  rank: 4,
                  rule: 'GVP evidence "Evidence Uncertain" or "Unrest / Holocene", no dated eruption' },
    inactive:   { label: 'Inactive (Pleistocene)',  group: 'inactive', rank: 5,
                  rule: 'no known eruption in the Holocene (GVP Pleistocene list)' },
});
export const STATUS_ORDER = Object.keys(STATUS);
export const GROUPS = Object.freeze({
    active:   { label: 'Active',   statuses: ['erupting', 'recent', 'historical'] },
    dormant:  { label: 'Dormant',  statuses: ['dormant', 'uncertain'] },
    inactive: { label: 'Inactive', statuses: ['inactive'] },
});

/** Status colours — ONE copy, shared by the EarthView layer, the map and
 *  every legend. Ordinal by recency: three warm steps for ACTIVE, teal and
 *  violet for DORMANT, grey for INACTIVE (de-emphasis on purpose — 1439
 *  Pleistocene cones must not out-shout the 63 erupting ones). Validated with
 *  the dataviz validator on the dark map surface #070b16: adjacent CVD worst
 *  ΔE 11.6 (deutan), normal-vision worst 16.3 — PASS; the lightness/chroma
 *  flags it raises are the grey class, by design. Identity is never colour
 *  alone: every legend names the class and the table prints it. */
export const STATUS_COLORS = Object.freeze({
    erupting:   '#ff3b1f',
    recent:     '#ff9a2e',
    historical: '#ffe066',
    dormant:    '#36c9b4',
    uncertain:  '#8e7dff',
    inactive:   '#6b7280',
});

// Newhall & Self (1982) — bulk volume bins (m³) and observed column heights (km)
export const VEI_TABLE = Object.freeze([
    { vei: 0, volLo: 0,    volHi: 1e4,  colLo: 0,   colHi: 0.1,  name: 'non-explosive' },
    { vei: 1, volLo: 1e4,  volHi: 1e6,  colLo: 0.1, colHi: 1,    name: 'gentle' },
    { vei: 2, volLo: 1e6,  volHi: 1e7,  colLo: 1,   colHi: 5,    name: 'explosive' },
    { vei: 3, volLo: 1e7,  volHi: 1e8,  colLo: 3,   colHi: 15,   name: 'severe' },
    { vei: 4, volLo: 1e8,  volHi: 1e9,  colLo: 10,  colHi: 25,   name: 'cataclysmic' },
    { vei: 5, volLo: 1e9,  volHi: 1e10, colLo: 25,  colHi: 55,   name: 'paroxysmal' },
    { vei: 6, volLo: 1e10, volHi: 1e11, colLo: 25,  colHi: 55,   name: 'colossal' },
    { vei: 7, volLo: 1e11, volHi: 1e12, colLo: 25,  colHi: 55,   name: 'super-colossal' },
    { vei: 8, volLo: 1e12, volHi: 1e13, colLo: 25,  colHi: 55,   name: 'mega-colossal' },
]);

/** Climactic-phase duration (hours) per VEI — a DISCLOSED assumption, chosen
 *  so the Mastin column sits inside Newhall & Self's range for VEI ≥ 2. */
export const CLIMACTIC_HOURS = Object.freeze([null, null, 12, 6, 6, 9, 12, 48, 96]);
export const RHO_DEPOSIT = 1000;   // kg m⁻³ bulk tephra
export const RHO_MAGMA = 2500;     // kg m⁻³ dense rock
export const MASTIN_A = 2.00;      // km
export const MASTIN_B = 0.241;
export const COLUMN_CAP_KM = 55;   // a column does not climb past the stratopause region

/** SO₂ injections of named eruptions (Tg) — the fit's anchors. Mid-range
 *  values from satellite (TOMS/OMI) or ice-core estimates; scatter is real. */
export const SO2_ANCHORS = Object.freeze([
    { name: 'Tambora 1815',      vei: 7, so2Tg: 60 },
    { name: 'Krakatau 1883',     vei: 6, so2Tg: 30 },
    { name: 'Pinatubo 1991',     vei: 6, so2Tg: 17 },
    { name: 'El Chichón 1982',   vei: 5, so2Tg: 7 },
    { name: 'St. Helens 1980',   vei: 5, so2Tg: 1 },
    { name: 'Kasatochi 2008',    vei: 4, so2Tg: 1.7 },
    { name: 'Nabro 2011',        vei: 4, so2Tg: 1.5 },
    { name: 'Raikoke 2019',      vei: 4, so2Tg: 1.5 },
    { name: 'Calbuco 2015',      vei: 4, so2Tg: 0.4 },
]);
export const SO2_REF_VEI = 4;
export const SO2_REF_TG = 1.0;
export const SO2_SLOPE = 0.6;     // dex per VEI

export const AOD_PER_TG = 0.0095;         // global-mean peak AOD per Tg stratospheric SO₂
export const AOD_LINEAR_TG = 17;          // Pinatubo — above it, ∝ M^(2/3)
export const FORCING_PER_AOD = -21;       // W m⁻² per unit AOD
export const EBM_HEAT_CAPACITY = 8;       // W yr m⁻² K⁻¹ (~60 m ocean mixed layer)
export const EBM_FEEDBACK = 1.2;          // W m⁻² K⁻¹
export const AEROSOL_RISE_YR = 1 / 12;    // SO₂ → sulfate e-folding

// ═══ §1 catalogue + status ══════════════════════════════════════════════════

/** Decode the baked columnar catalogue into plain records + status. */
export function decodeCatalog(json) {
    if (json?.schema !== 'volcano-catalog-v1') throw new Error(`unknown volcano catalogue schema: ${json?.schema}`);
    const { columns: c, dicts: d, n } = json;
    const dict = (f, i) => (c[f][i] == null ? null : d[f][c[f][i]]);
    const epoch = json.catalogueEpoch;
    const tableThrough = json.eruptionTableThrough;
    const volcanoes = new Array(n);
    for (let i = 0; i < n; i++) {
        const v = {
            i,
            num: c.num[i], name: c.name[i],
            country: dict('country', i), regionGroup: dict('regionGroup', i), region: dict('region', i),
            landform: dict('landform', i), type: dict('type', i), evidence: dict('evidence', i),
            lastEruption: c.lastEruption[i],
            lat: c.lat[i], lon: c.lon[i], elev: c.elev[i],
            tectonic: dict('tectonic', i), rock: dict('rock', i),
            epoch: c.epoch[i],
            uncertainEruptions: c.uncertainEruptions[i] ?? 0,
            pop: c.pop[i] ? { km5: c.pop[i][0], km10: c.pop[i][1], km30: c.pop[i][2], km100: c.pop[i][3] } : null,
            eruptions: (c.eruptions[i] ?? []).map(([year, vei, dur]) => ({
                year, vei: vei < 0 ? null : vei, durationYears: dur < 0 ? null : dur,
            })),
        };
        v.status = classifyVolcano(v, epoch);
        volcanoes[i] = v;
    }
    return { source: json.source, counts: json.counts, epoch, tableThrough, volcanoes };
}

/** The six-class recency rule (STATUS). Pure function of the record. */
export function classifyVolcano(v, epoch) {
    if (v.epoch === 'P') return 'inactive';
    const y = v.lastEruption;
    const nowYear = Math.floor(epoch);
    if (y != null && y >= nowYear - 1) return 'erupting';
    if (y != null && y >= 1900) return 'recent';
    if (y != null && y > 0) return 'historical';
    if (y != null) return 'dormant';
    if (v.evidence === 'Evidence Uncertain' || v.evidence === 'Unrest / Holocene') return 'uncertain';
    return 'dormant';
}

export function groupOf(status) { return STATUS[status]?.group ?? null; }

export function countByStatus(volcanoes) {
    const out = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
    for (const v of volcanoes) out[v.status]++;
    return out;
}

/** Most recent eruption the engine knows of — table or list, whichever is
 *  newer — with its VEI when the table has one. */
export function lastKnownEruption(v) {
    const last = v.eruptions.length ? v.eruptions[v.eruptions.length - 1] : null;
    if (v.lastEruption != null && (!last || v.lastEruption > last.year)) return { year: v.lastEruption, vei: null, source: 'list' };
    return last ? { year: last.year, vei: last.vei, source: 'table' } : null;
}

export function largestEruption(v) {
    let best = null;
    for (const e of v.eruptions) if (e.vei != null && (!best || e.vei > best.vei)) best = e;
    return best;
}

// ═══ §2 hazard (empirical-Bayes Gamma–Poisson) ═════════════════════════════

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
/** ln Γ(x), Lanczos g = 7 (|err| < 1e-13 for x > 0). */
export function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Onsets inside the hazard window, reconciling the 2020 table with the 2026
 *  list (ONE extra onset when the list's last eruption is newer). */
export function modernOnsets(v, { from = HAZARD_WINDOW_FROM, tableThrough } = {}) {
    let n = 0;
    for (const e of v.eruptions) if (e.year >= from && e.year <= tableThrough) n++;
    if (v.lastEruption != null && v.lastEruption > tableThrough) n++;
    return n;
}

/** Negative-binomial MLE of the Gamma(a, b) rate prior, all counts sharing
 *  exposure T. The mean equation is exact (a/b·T = mean), leaving a 1-D
 *  golden-section search on log a. */
export function fitGammaPrior(counts, T) {
    const n = counts.length;
    const S = counts.reduce((s, x) => s + x, 0);
    const m = S / n;
    if (!(m > 0)) return { a: 0.5, b: T, mean: 0, logLik: 0, overdispersed: false };
    let sumLg0 = 0; // constant wrt a
    const ll = a => {
        let s = -n * lgamma(a);
        for (const x of counts) s += lgamma(x + a);
        return s + n * a * Math.log(a / (a + m)) + S * Math.log(m / (a + m)) - sumLg0;
    };
    let lo = Math.log(1e-3), hi = Math.log(1e3);
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
    let f1 = ll(Math.exp(x1)), f2 = ll(Math.exp(x2));
    for (let k = 0; k < 80; k++) {
        if (f1 > f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = ll(Math.exp(x1)); }
        else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = ll(Math.exp(x2)); }
    }
    const a = Math.exp((lo + hi) / 2);
    const variance = counts.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1);
    return { a, b: a * T / m, mean: m, variance, logLik: ll(a), overdispersed: variance > m };
}

/** Build the hazard model once per catalogue. */
export function buildHazardModel(cat, { from = HAZARD_WINDOW_FROM } = {}) {
    const T = cat.epoch - from;
    const holo = cat.volcanoes.filter(v => v.epoch === 'H');
    const counts = holo.map(v => modernOnsets(v, { from, tableThrough: cat.tableThrough }));
    const prior = fitGammaPrior(counts, T);
    const TH = cat.epoch - HOLOCENE_START_CE;
    const perVolcano = new Map();
    holo.forEach((v, k) => perVolcano.set(v.i, { shape: prior.a + counts[k], rate: prior.b + T, onsets: counts[k] }));
    for (const v of cat.volcanoes) if (v.epoch === 'P') perVolcano.set(v.i, { shape: 0.5, rate: TH, onsets: 0, pleistocene: true });
    return { from, T, prior, perVolcano, globalOnsetsPerYear: counts.reduce((s, x) => s + x, 0) / T };
}

/** Posterior of one volcano's onset rate (per year). */
export function ratePosterior(model, v) { return model.perVolcano.get(v.i) ?? null; }

/** Predictive P(≥ 1 new eruption onset within `years`). Closed form. */
export function onsetProbability(model, v, years) {
    const p = model.perVolcano.get(v.i);
    if (!p) return null;
    return 1 - Math.pow(p.rate / (p.rate + years), p.shape);
}

/** Posterior mean onset rate (/yr) and its mean repose (yr). */
export function meanRate(model, v) {
    const p = model.perVolcano.get(v.i);
    return p ? p.shape / p.rate : null;
}

// ═══ §3 VEI probabilities ══════════════════════════════════════════════════

/** Global VEI distribution of the modern window (known VEIs only), plus the
 *  magnitude–frequency slope: log10 N(≥VEI) fitted over VEI 2–6. */
export function globalVeiDistribution(cat, { from = HAZARD_WINDOW_FROM } = {}) {
    const counts = new Array(VEI_MAX + 1).fill(0);
    let unknown = 0;
    for (const v of cat.volcanoes) for (const e of v.eruptions) {
        if (e.year < from) continue;
        if (e.vei == null) { unknown++; continue; }
        counts[Math.min(VEI_MAX, e.vei)]++;
    }
    const total = counts.reduce((s, x) => s + x, 0);
    const p = counts.map(x => x / total);
    // cumulative ≥ k and the slope over 2..6 (least squares on log10)
    const cum = counts.map((_, k) => counts.slice(k).reduce((s, x) => s + x, 0));
    const ks = [2, 3, 4, 5, 6].filter(k => cum[k] > 0);
    const xs = ks, ys = ks.map(k => Math.log10(cum[k]));
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let j = 0; j < xs.length; j++) { sxy += (xs[j] - mx) * (ys[j] - my); sxx += (xs[j] - mx) ** 2; }
    return { counts, p, cumulative: cum, unknown, total, bSlope: sxy / sxx };
}

/** Per-volcano VEI probabilities (Dirichlet–multinomial on the volcano's own
 *  VEIs since VEI_RECORD_FROM, prior = VEI_PRIOR_WEIGHT × global). */
export function veiDistribution(v, globalP, { from = VEI_RECORD_FROM, weight = VEI_PRIOR_WEIGHT } = {}) {
    const c = globalP.map(p => p * weight);
    let own = 0;
    for (const e of v.eruptions) if (e.year >= from && e.vei != null) { c[Math.min(VEI_MAX, e.vei)] += 1; own++; }
    const s = c.reduce((a, b) => a + b, 0);
    return { p: c.map(x => x / s), own };
}

// ═══ §4 eruption column ═══════════════════════════════════════════════════

export function bulkVolumeM3(vei) {
    const row = VEI_TABLE[vei];
    if (!row) return null;
    return vei === 0 ? Math.sqrt(1e3 * row.volHi) : Math.sqrt(row.volLo * row.volHi);
}

/** Eruption column for a VEI: plume height above the vent (km), the DRE
 *  volume flux and mass eruption rate it implies, and how it was derived. */
export function eruptionColumn(vei) {
    const row = VEI_TABLE[vei];
    if (!row) return null;
    const bulk = bulkVolumeM3(vei);
    const dre = bulk * RHO_DEPOSIT / RHO_MAGMA;
    const hours = CLIMACTIC_HOURS[vei];
    if (hours == null) {
        // not a sustained column — Newhall & Self range, geometric centre
        const lo = Math.max(row.colLo, 0.01);
        return { vei, heightKm: Math.sqrt(lo * row.colHi), method: 'newhall-self-range',
                 bulkM3: bulk, dreM3: dre, durationH: null, volumeFlux: null, merKgS: null, capped: false };
    }
    const flux = dre / (hours * 3600);
    let h = MASTIN_A * Math.pow(flux, MASTIN_B);
    const capped = h > COLUMN_CAP_KM;
    if (capped) h = COLUMN_CAP_KM;
    return { vei, heightKm: h, method: 'mastin-2009', bulkM3: bulk, dreM3: dre, durationH: hours,
             volumeFlux: flux, merKgS: flux * RHO_MAGMA, capped };
}

/** Tropopause height (km) — a cos² fit through ~17 km (equator) and ~9 km
 *  (poles); disclosed as a fit, not a sounding. */
export function tropopauseKm(latDeg) {
    const c = Math.cos(latDeg * Math.PI / 180);
    return 9 + 8 * c * c;
}

/** Fraction of the injection that ends above the tropopause (logistic,
 *  1 km scale, centred 1 km above it — a plume that just touches the
 *  tropopause leaves most of its sulfur below). */
export function stratosphericFraction(plumeTopKm, latDeg) {
    const zt = tropopauseKm(latDeg);
    return 1 / (1 + Math.exp(-(plumeTopKm - zt - 1)));
}

// ═══ §5 sulfur → aerosol → forcing → temperature ═══════════════════════════

export function so2MassTg(vei) { return SO2_REF_TG * Math.pow(10, SO2_SLOPE * (vei - SO2_REF_VEI)); }

/** Aerosol residence e-folding (yr): ~1 yr tropical, shorter poleward. */
export function aerosolResidenceYr(latDeg) {
    const c = Math.cos(latDeg * Math.PI / 180);
    return 0.6 + 0.4 * c * c;
}
/** Global-coverage efficiency: a high-latitude cloud stays in one hemisphere. */
export function globalEfficiency(latDeg) {
    const c = Math.cos(latDeg * Math.PI / 180);
    return 0.5 + 0.5 * c * c;
}
export function peakAod(stratSo2Tg, latDeg) {
    const m = stratSo2Tg;
    const lin = m <= AOD_LINEAR_TG ? m : AOD_LINEAR_TG * Math.pow(m / AOD_LINEAR_TG, 2 / 3);
    return AOD_PER_TG * lin * globalEfficiency(latDeg);
}

/** Unit-peak rise–decay profile g(t) (t in years since the eruption). */
export function aodProfile(t, residenceYr) {
    if (t <= 0) return 0;
    const td = residenceYr, tc = AEROSOL_RISE_YR;
    const tpk = Math.log(td / tc) * td * tc / (td - tc);
    const norm = Math.exp(-tpk / td) - Math.exp(-tpk / tc);
    return (Math.exp(-t / td) - Math.exp(-t / tc)) / norm;
}

/** Everything one eruption does, from VEI + site. */
export function eruptionConsequences({ vei, lat, elevM = 0 }) {
    const col = eruptionColumn(vei);
    if (!col) return null;
    const topKm = col.heightKm + Math.max(0, elevM ?? 0) / 1000;
    const so2 = so2MassTg(vei);
    const fStrat = stratosphericFraction(topKm, lat);
    const stratSo2 = so2 * fStrat;
    const aod = peakAod(stratSo2, lat);
    return {
        vei, column: col, plumeTopKm: topKm, tropopauseKm: tropopauseKm(lat),
        so2Tg: so2, stratosphericFraction: fStrat, stratSo2Tg: stratSo2,
        peakAod: aod, residenceYr: aerosolResidenceYr(lat), peakForcingWm2: FORCING_PER_AOD * aod,
    };
}

/** AOD / forcing / temperature series for a list of injections
 *  [{ t (decimal yr), peakAod, residenceYr }] on [t0, t1) at step dt. The
 *  one-box EBM C dT/dt = F − λT is integrated exactly per step (F held). */
export function forcingSeries(injections, { t0, t1, dt = 1 / 12 } = {}) {
    const n = Math.max(1, Math.round((t1 - t0) / dt));
    const t = new Float64Array(n), aod = new Float64Array(n), F = new Float64Array(n), T = new Float64Array(n);
    const decay = Math.exp(-EBM_FEEDBACK * dt / EBM_HEAT_CAPACITY);
    let temp = 0;
    for (let k = 0; k < n; k++) {
        const tk = t0 + k * dt;
        let a = 0;
        for (const inj of injections) if (inj.t < tk && tk - inj.t < 12) a += inj.peakAod * aodProfile(tk - inj.t, inj.residenceYr);
        const f = FORCING_PER_AOD * a;
        temp = f / EBM_FEEDBACK + (temp - f / EBM_FEEDBACK) * decay;
        t[k] = tk; aod[k] = a; F[k] = f; T[k] = temp;
    }
    return { t, aod, forcing: F, temperature: T, dt };
}

// ═══ §6 simulation ═════════════════════════════════════════════════════════

/** mulberry32 — the seeded generator every stochastic path uses. */
export function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let r = Math.imul(s ^ (s >>> 15), 1 | s);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
function gaussian(rng) {
    let u = 0; while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
/** Gamma(shape, 1) — Marsaglia & Tsang (2000), with the shape < 1 boost. */
export function sampleGamma(shape, rng) {
    if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(rng() || 1e-300, 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
        let x, v;
        do { x = gaussian(rng); v = 1 + c * x; } while (v <= 0);
        v = v * v * v;
        const u = rng();
        if (u < 1 - 0.0331 * x ** 4) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}
export function samplePoisson(mean, rng) {
    if (mean < 30) {
        const L = Math.exp(-mean); let k = 0, p = 1;
        do { k++; p *= rng(); } while (p > L);
        return k - 1;
    }
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * gaussian(rng)));
}
function sampleCategorical(p, rng) {
    let u = rng(), k = 0;
    for (; k < p.length - 1; k++) { u -= p[k]; if (u <= 0) break; }
    return k;
}

/** Prepare everything the simulation reuses (per-volcano VEI tables, site
 *  consequences per VEI). Call once per catalogue. */
export function prepareSimulation(cat, { hazard = buildHazardModel(cat) } = {}) {
    const global = globalVeiDistribution(cat);
    const sites = [];
    for (const v of cat.volcanoes) {
        if (v.epoch !== 'H') continue;
        const post = hazard.perVolcano.get(v.i);
        const vd = veiDistribution(v, global.p);
        const cons = VEI_TABLE.map(r => eruptionConsequences({ vei: r.vei, lat: v.lat, elevM: v.elev }));
        sites.push({ v, post, veiP: vd.p, cons });
    }
    return { cat, hazard, global, sites };
}

/** Seeded Monte-Carlo of global volcanism over `years` from the catalogue
 *  epoch. Returns the ensemble's onset counts, the largest eruptions of the
 *  median-ranked member, and percentile bands of AOD / forcing / temperature. */
export const SPIN_UP_YEARS = 20;   // ≈ 3 e-folds of the EBM's C/λ = 6.7 yr

/* The ensemble is SPUN UP: each member also draws eruptions over the
 * SPIN_UP_YEARS before the catalogue epoch and the series is integrated
 * through them, then cut at the epoch. Without it every future started from
 * a volcano-free climate (0 K) and relaxed onto the ~−0.2 K background that
 * frequent VEI 3–4 eruptions sustain — a spin-up artefact that read as a
 * thirty-year COOLING TREND (measured, 2026-11). The spin-up is statistical
 * (drawn, not the real 2006–2026 record) and the page says so; every number
 * stays an anomaly against a volcano-free climate. */
export function simulateFuture(prep, { years = 30, members = 200, seed = 1, dt = 1 / 12, keepEvents = 1, spinUpYears = SPIN_UP_YEARS } = {}) {
    const rng = makeRng(seed);
    const t0 = prep.cat.epoch, t1 = t0 + years, ts = t0 - spinUpYears;
    const nStep = Math.max(1, Math.round(years / dt));
    const nSpin = Math.round(spinUpYears / dt);
    const span = years + spinUpYears;
    const runs = [];
    for (let m = 0; m < members; m++) {
        const all = [];
        for (const s of prep.sites) {
            const lam = sampleGamma(s.post.shape, rng) / s.post.rate;
            const k = samplePoisson(lam * span, rng);
            for (let j = 0; j < k; j++) {
                const vei = sampleCategorical(s.veiP, rng);
                const c = s.cons[vei];
                all.push({ t: ts + rng() * span, i: s.v.i, vei, peakAod: c.peakAod,
                           residenceYr: c.residenceYr, stratSo2Tg: c.stratSo2Tg });
            }
        }
        all.sort((a, b) => a.t - b.t);
        // only stratospherically relevant events need the series pass
        const inj = all.filter(e => e.peakAod > 1e-4);
        const full = forcingSeries(inj, { t0: ts, t1, dt });
        const cut = a => a.subarray(nSpin, nSpin + nStep);
        const ser = { t: cut(full.t), aod: cut(full.aod), forcing: cut(full.forcing), temperature: cut(full.temperature), dt };
        const events = all.filter(e => e.t >= t0);
        let minT = 0, minF = 0, bigVei = -1, sumF = 0, sumT = 0;
        for (let k = 0; k < ser.t.length; k++) {
            if (ser.temperature[k] < minT) minT = ser.temperature[k];
            if (ser.forcing[k] < minF) minF = ser.forcing[k];
            sumF += ser.forcing[k]; sumT += ser.temperature[k];
        }
        for (const e of events) if (e.vei > bigVei) bigVei = e.vei;
        runs.push({ events, series: ser, minT, minF, bigVei, onsets: events.length,
                    meanF: sumF / ser.t.length, meanT: sumT / ser.t.length });
    }
    // percentile bands per time step
    const pct = [0.05, 0.5, 0.95];
    const bands = { t: runs[0].series.t, aod: pct.map(() => new Float64Array(nStep)),
                    forcing: pct.map(() => new Float64Array(nStep)), temperature: pct.map(() => new Float64Array(nStep)) };
    const col = new Float64Array(members);
    for (const key of ['aod', 'forcing', 'temperature']) {
        for (let k = 0; k < nStep; k++) {
            for (let m = 0; m < members; m++) col[m] = runs[m].series[key][k];
            const sorted = Array.from(col).sort((a, b) => a - b);
            pct.forEach((q, j) => { bands[key][j][k] = sorted[Math.min(members - 1, Math.floor(q * (members - 1) + 0.5))]; });
        }
    }
    const onsets = runs.map(r => r.onsets).sort((a, b) => a - b);
    const veiAtLeast = k => runs.filter(r => r.bigVei >= k).length / members;
    const byMinT = runs.slice().sort((a, b) => a.minT - b.minT);
    const median = byMinT[Math.floor(members / 2)];
    const worst = byMinT[0];
    return {
        years, members, seed, t0, t1, pct,
        onsetsPerYear: { median: onsets[Math.floor(members / 2)] / years, p05: onsets[Math.floor(0.05 * (members - 1))] / years, p95: onsets[Math.ceil(0.95 * (members - 1))] / years },
        pAtLeastVei: Object.fromEntries([4, 5, 6, 7].map(k => [k, veiAtLeast(k)])),
        minTemperature: { median: median.minT, worst: worst.minT },
        spinUpYears,
        // the ensemble-mean level the series sit on: the forcing and
        // temperature anomaly that background volcanism alone sustains
        background: { forcing: runs.reduce((a, r) => a + r.meanF, 0) / members,
                      temperature: runs.reduce((a, r) => a + r.meanT, 0) / members },
        bands,
        exampleRuns: keepEvents > 0 ? { median: summariseRun(median, prep.cat), worst: summariseRun(worst, prep.cat) } : null,
    };
}
function summariseRun(run, cat) {
    const big = run.events.filter(e => e.vei >= 4).slice(0, 40)
        .map(e => ({ t: e.t, vei: e.vei, num: cat.volcanoes[e.i].num, name: cat.volcanoes[e.i].name, stratSo2Tg: e.stratSo2Tg }));
    return { onsets: run.onsets, minT: run.minT, minF: run.minF, bigVei: run.bigVei, big, series: run.series };
}

/** Replay the catalogued eruptions (known VEI) through §4–5. */
export function replayRecord(cat, { from = 1900, to = cat.tableThrough + 1, dt = 1 / 12, minVei = 3 } = {}) {
    const inj = [];
    let skipped = 0;
    for (const v of cat.volcanoes) for (const e of v.eruptions) {
        if (e.year < from - 12 || e.year >= to) continue;
        if (e.vei == null) { skipped++; continue; }
        if (e.vei < minVei) continue;
        const c = eruptionConsequences({ vei: e.vei, lat: v.lat, elevM: v.elev });
        // mid-year onset: the eruption table here carries the YEAR (months
        // exist upstream but not in this export for every row)
        inj.push({ t: e.year + 0.5, peakAod: c.peakAod, residenceYr: c.residenceYr, vei: e.vei, num: v.num, name: v.name, stratSo2Tg: c.stratSo2Tg });
    }
    inj.sort((a, b) => a.t - b.t);
    return { injections: inj, skippedUnknownVei: skipped, series: forcingSeries(inj, { t0: from, t1: to, dt }) };
}

// ═══ geometry + queries ═════════════════════════════════════════════════════

export const EARTH_RADIUS_KM = 6371;
export function haversineKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest catalogued volcano to a point (optionally within maxKm). */
export function nearestVolcano(volcanoes, lat, lon, { maxKm = Infinity, filter = null } = {}) {
    let best = null, bestD = Infinity;
    for (const v of volcanoes) {
        if (filter && !filter(v)) continue;
        const d = haversineKm(lat, lon, v.lat, v.lon);
        if (d < bestD) { bestD = d; best = v; }
    }
    return best && bestD <= maxKm ? { volcano: best, km: bestD } : null;
}

export function normaliseName(s) {
    return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/\b(volcano|volcan|volcanic|mount|mt|mont|monte|cerro|gunung|nevado|island|isla)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

export const ACTIVITY_MATCH_KM = 30;       // EONET point → nearest summit
export const ACTIVITY_NAME_MATCH_KM = 100; // …or a same-name summit this close

/** Join /api/volcanoes/activity items onto the catalogue. HANS rows join by
 *  GVP number (exact); EONET rows by a same-name summit within
 *  ACTIVITY_NAME_MATCH_KM, else the nearest summit within ACTIVITY_MATCH_KM.
 *  Anything that does not join is RETURNED, never dropped. */
export function matchActivity(cat, items) {
    const byNum = new Map(cat.volcanoes.map(v => [v.num, v]));
    const live = new Map();
    const unmatched = [];
    const add = (v, it) => {
        const cur = live.get(v.i) ?? { volcano: v, items: [], colorCode: null, alertLevel: null };
        cur.items.push(it);
        const cr = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 };
        if (it.colorCode && (cur.colorCode == null || cr[it.colorCode] > cr[cur.colorCode])) cur.colorCode = it.colorCode;
        if (it.alertLevel && !cur.alertLevel) cur.alertLevel = it.alertLevel;
        live.set(v.i, cur);
    };
    for (const it of items ?? []) {
        let v = it.num != null ? byNum.get(Number(it.num)) : null;
        if (!v && it.name && Number.isFinite(it.lat)) {
            const nm = normaliseName(it.name);
            const hit = nearestVolcano(cat.volcanoes, it.lat, it.lon,
                { maxKm: ACTIVITY_NAME_MATCH_KM, filter: x => normaliseName(x.name) === nm });
            v = hit?.volcano ?? null;
        }
        if (!v && Number.isFinite(it.lat)) v = nearestVolcano(cat.volcanoes, it.lat, it.lon, { maxKm: ACTIVITY_MATCH_KM })?.volcano ?? null;
        if (!v && it.name && !Number.isFinite(it.lat)) {
            const nm = normaliseName(it.name);
            v = cat.volcanoes.find(x => normaliseName(x.name) === nm) ?? null;
        }
        if (v) add(v, it); else unmatched.push(it);
    }
    return { live, unmatched };
}

/** Simple filter + sort over decoded volcanoes (the page's table). */
export function queryVolcanoes(volcanoes, { statuses = null, text = '', country = null } = {}) {
    const q = normaliseName(text);
    return volcanoes.filter(v =>
        (!statuses || statuses.includes(v.status)) &&
        (!country || v.country === country) &&
        (!q || normaliseName(v.name).includes(q) || normaliseName(v.country).includes(q) || String(v.num) === text.trim()));
}

/** Exposure-weighted ranking: P(onset in `years`) × people within 100 km.
 *  An ordering of where eruptions and people coincide — NOT a risk
 *  assessment (no hazard footprint, no vulnerability). */
export function exposureRanking(cat, model, { years = 10, limit = 20 } = {}) {
    return cat.volcanoes
        .filter(v => v.epoch === 'H' && v.pop?.km100 != null)
        .map(v => { const p = onsetProbability(model, v, years); return { v, p, people: v.pop.km100, score: p * v.pop.km100 }; })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
