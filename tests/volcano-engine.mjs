/**
 * volcano-engine.mjs — node gate for the Earth Volcanoes engine + catalogue
 * ═══════════════════════════════════════════════════════════════════════════
 *   node tests/volcano-engine.mjs
 *
 * Pins, in order:
 *   1. the BAKED catalogue (data/volcanoes/volcanoes-catalog.json): counts,
 *      finite coordinates, known summits where GVP puts them, and that the
 *      Pleistocene sheet's Rock/Tectonic columns (in the OPPOSITE order to the
 *      Holocene sheet) were not swapped by position;
 *   2. the baker's SpreadsheetML reader on GVP's malformed XML (bare '<'),
 *      ss:Index gaps and entities, and its year parser;
 *   3. the six-class status rule;
 *   4. the hazard statistics — lgamma, the negative-binomial MLE recovering a
 *      planted Gamma prior, the closed-form predictive against Monte Carlo,
 *      and the empirical-Bayes NEGATIVE CONTROL (a flat Jeffreys prior hands
 *      every quiet volcano the same 1/(2T)-ish chance; the fitted prior does not);
 *   5. the column + sulfur chain against Newhall & Self and the SO₂ anchors;
 *   6. Pinatubo 1991 through the forcing chain, and the EBM's exact step;
 *   7. the simulation's determinism and its rates against the record;
 *   8. the 1900–2020 replay finds Pinatubo as the deepest 1985–2000 forcing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../js/volcano-engine.js';
import { readSpreadsheetML, parseGvpYear } from '../scripts/build-volcano-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(HERE, '../data/volcanoes/volcanoes-catalog.json'), 'utf8'));

let checks = 0, failed = 0;
function ok(cond, msg) {
    checks++;
    if (!cond) { failed++; console.error(`  ✗ ${msg}`); }
    return cond;
}
function section(t) { console.log(`\n${t}`); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. catalogue ───────────────────────────────────────────────────────────
section('1. baked catalogue');
const cat = E.decodeCatalog(raw);
ok(raw.counts.holocene === 1222 && raw.counts.pleistocene === 1439, `GVP 5.3.4 lists: ${raw.counts.holocene} H + ${raw.counts.pleistocene} P`);
ok(cat.volcanoes.length === 2661, 'decoded 2661 records');
ok(cat.volcanoes.every(v => Number.isFinite(v.lat) && Math.abs(v.lat) <= 90 && Number.isFinite(v.lon) && Math.abs(v.lon) <= 180),
    'every volcano has a finite, in-range position');
ok(new Set(cat.volcanoes.map(v => v.num)).size === 2661, 'volcano numbers unique');
ok(cat.tableThrough === 2020 && near(cat.epoch, 2026.22, 0.01), `eruption table through ${cat.tableThrough}, lists at ${cat.epoch.toFixed(3)}`);
const byName = n => cat.volcanoes.find(v => v.name === n);
for (const [n, lat, lon] of [['Etna', 37.748, 14.999], ['Kilauea', 19.421, -155.287], ['Fujisan', 35.361, 138.728], ['Pinatubo', 15.13, 120.35]]) {
    const v = byName(n);
    ok(v && near(v.lat, lat, 0.02) && near(v.lon, lon, 0.02), `${n} at ${lat}, ${lon} (got ${v?.lat}, ${v?.lon})`);
}
const ple = cat.volcanoes.filter(v => v.epoch === 'P');
ok(ple.every(v => v.tectonic == null || /zone|Intraplate|Unknown/.test(v.tectonic)), 'Pleistocene tectonic column holds tectonic settings (not rock types)');
ok(ple.every(v => v.rock == null || !/crust/.test(v.rock)), 'Pleistocene rock column holds rock types (not crust)');
ok(ple.every(v => v.eruptions.length === 0 && v.lastEruption == null), 'no Pleistocene volcano carries a Holocene eruption');
ok(cat.volcanoes.filter(v => v.pop).length === raw.counts.withPopulation && raw.counts.withPopulation > 900, `GVP populations on ${raw.counts.withPopulation} volcanoes`);
ok(raw.counts.confirmedEruptions > 9000, `${raw.counts.confirmedEruptions} confirmed eruptions decoded`);
const pin = byName('Pinatubo');
ok(pin.eruptions.some(e => e.year === 1991 && e.vei === 6), 'Pinatubo 1991 is a VEI 6 in the table');

// ── 2. reader ──────────────────────────────────────────────────────────────
section('2. SpreadsheetML reader + year parser');
const xml = '<Row><Cell><Data ss:Type="String">A &amp; B</Data></Cell><Cell ss:Index="3"><Data ss:Type="String">Oceanic crust (< 15 km)</Data></Cell></Row>'
    + '<Row><Cell/><Cell><Data ss:Type="Number">42</Data></Cell></Row>';
const rows = readSpreadsheetML(xml);
ok(rows[0][0] === 'A & B' && rows[0][1] === '' && rows[0][2] === 'Oceanic crust (< 15 km)', 'bare "<", entity and ss:Index gap');
ok(rows[1][0] === '' && rows[1][1] === '42', 'self-closing empty cell keeps column alignment');
ok(parseGvpYear('2025 CE') === 2025 && parseGvpYear('8300 BCE') === -8300 && parseGvpYear('Unknown') === null && parseGvpYear('') === null, 'GVP year strings');

// ── 3. status ──────────────────────────────────────────────────────────────
section('3. status classes');
const st = (o) => E.classifyVolcano({ epoch: 'H', evidence: 'Eruption Observed', lastEruption: null, ...o }, 2026.2);
ok(st({ lastEruption: 2025 }) === 'erupting' && st({ lastEruption: 2026 }) === 'erupting', '2025/2026 → erupting');
ok(st({ lastEruption: 2024 }) === 'recent' && st({ lastEruption: 1900 }) === 'recent', '1900–2024 → recent');
ok(st({ lastEruption: 1899 }) === 'historical' && st({ lastEruption: 79 }) === 'historical', 'CE before 1900 → historical');
ok(st({ lastEruption: -4000 }) === 'dormant' && st({ evidence: 'Evidence Credible' }) === 'dormant', 'BCE or undated credible → dormant');
ok(st({ evidence: 'Evidence Uncertain' }) === 'uncertain' && st({ evidence: 'Unrest / Holocene' }) === 'uncertain', 'uncertain evidence → uncertain');
ok(E.classifyVolcano({ epoch: 'P' }, 2026) === 'inactive', 'Pleistocene → inactive');
const counts = E.countByStatus(cat.volcanoes);
ok(Object.values(counts).reduce((a, b) => a + b, 0) === 2661 && counts.inactive === 1439, `status counts ${JSON.stringify(counts)}`);
ok(byName('Etna').status === 'erupting' && byName('Vesuvius').status === 'recent' && byName('Campi Flegrei').status === 'historical', 'Etna erupting · Vesuvius recent · Campi Flegrei historical');
ok(Object.values(E.GROUPS).flatMap(g => g.statuses).sort().join() === E.STATUS_ORDER.slice().sort().join(), 'the three groups partition the six classes');

// ── 4. hazard statistics ───────────────────────────────────────────────────
section('4. hazard statistics');
ok(near(E.lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12) && near(E.lgamma(10), Math.log(362880), 1e-10) && near(E.lgamma(0.1), 2.252712651734206, 1e-10), 'lgamma');
{
    const rng = E.makeRng(42); const a = 0.3, b = 20, T = 120;
    const xs = Array.from({ length: 6000 }, () => E.samplePoisson(E.sampleGamma(a, rng) / b * T, rng));
    const fit = E.fitGammaPrior(xs, T);
    ok(near(fit.a, a, 0.05) && near(fit.b, b, 5), `NB MLE recovers planted Gamma(0.3, 20): a=${fit.a.toFixed(3)} b=${fit.b.toFixed(1)}`);
    // sampler sanity
    const g = Array.from({ length: 20000 }, () => E.sampleGamma(2.5, rng));
    ok(near(g.reduce((s, x) => s + x, 0) / g.length, 2.5, 0.05), 'Gamma sampler mean');
}
const hz = E.buildHazardModel(cat);
ok(hz.prior.overdispersed && hz.prior.a < 1, `population is strongly overdispersed (a = ${hz.prior.a.toFixed(3)}) — a few volcanoes do most of the erupting`);
ok(near(hz.prior.a / hz.prior.b * hz.T, hz.prior.mean, 1e-9), 'prior mean reproduces the population mean count');
{
    // closed-form predictive vs Monte Carlo of Gamma → Poisson
    const v = byName('Vesuvius');
    const post = E.ratePosterior(hz, v);
    const rng = E.makeRng(9); let hit = 0; const M = 40000;
    for (let k = 0; k < M; k++) if (E.samplePoisson(E.sampleGamma(post.shape, rng) / post.rate * 10, rng) > 0) hit++;
    const p = E.onsetProbability(hz, v, 10);
    ok(near(hit / M, p, 0.006), `predictive P(10 yr) closed form ${p.toFixed(4)} vs MC ${(hit / M).toFixed(4)}`);
}
{
    // empirical Bayes vs the flat-prior negative control
    const quiet = cat.volcanoes.filter(v => v.epoch === 'H' && E.ratePosterior(hz, v).onsets === 0);
    const pEB = E.onsetProbability(hz, quiet[0], 10);
    const pJeffreys = 1 - Math.pow(hz.T / (hz.T + 10), 0.5);
    ok(pEB < pJeffreys, `a quiet Holocene volcano: EB ${(pEB * 100).toFixed(2)}% < flat-prior ${(pJeffreys * 100).toFixed(2)}% (control)`);
    const etna = E.onsetProbability(hz, byName('Etna'), 1), kil = E.onsetProbability(hz, byName('Kilauea'), 1);
    ok(etna > 0.4 && kil > 0.25, `persistently active volcanoes: Etna ${(etna * 100).toFixed(0)}%/yr, Kilauea ${(kil * 100).toFixed(0)}%/yr`);
    const maxPle = Math.max(...ple.map(v => E.onsetProbability(hz, v, 10)));
    const minHol = Math.min(...cat.volcanoes.filter(v => v.epoch === 'H').map(v => E.onsetProbability(hz, v, 10)));
    ok(maxPle < minHol, 'every Pleistocene volcano is below every Holocene volcano');
    ok(near(hz.globalOnsetsPerYear, 30, 8), `global onset rate ${hz.globalOnsetsPerYear.toFixed(1)}/yr (GVP: ~30–40 new eruptions a year)`);
}

// ── 5. column + sulfur ─────────────────────────────────────────────────────
section('5. eruption column + sulfur');
for (let k = 0; k <= 7; k++) {
    const c = E.eruptionColumn(k), r = E.VEI_TABLE[k];
    ok(c.heightKm >= r.colLo - 1e-9 && c.heightKm <= r.colHi + 1e-9, `VEI ${k}: ${c.heightKm.toFixed(1)} km inside Newhall & Self ${r.colLo}–${r.colHi} (${c.method})`);
}
ok(E.eruptionColumn(8).capped && E.eruptionColumn(8).heightKm === E.COLUMN_CAP_KM, 'VEI 8 is capped and says so');
{
    const res = E.SO2_ANCHORS.map(a => Math.log10(E.so2MassTg(a.vei)) - Math.log10(a.so2Tg));
    const rms = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length);
    ok(rms < 0.45, `SO₂(VEI) fit vs ${E.SO2_ANCHORS.length} named eruptions: ${rms.toFixed(2)} dex RMS`);
    ok(near(E.so2MassTg(6), 17, 6), `VEI 6 → ${E.so2MassTg(6).toFixed(1)} Tg (Pinatubo ~17)`);
}
ok(near(E.tropopauseKm(0), 17, 1e-9) && near(E.tropopauseKm(90), 9, 1e-9), 'tropopause 17 km equator, 9 km pole');
ok(E.stratosphericFraction(30, 0) > 0.99 && E.stratosphericFraction(8, 0) < 1e-3, 'stratospheric fraction: 30 km in, 8 km out');

// ── 6. Pinatubo + EBM ──────────────────────────────────────────────────────
section('6. Pinatubo through the forcing chain');
{
    const c = E.eruptionConsequences({ vei: 6, lat: pin.lat, elevM: pin.elev });
    ok(near(c.peakAod, 0.15, 0.04), `peak global AOD ${c.peakAod.toFixed(3)} (Sato/GloSSAC ~0.15)`);
    const s = E.forcingSeries([{ t: 1991.45, peakAod: c.peakAod, residenceYr: c.residenceYr }], { t0: 1990, t1: 2000 });
    let kf = 0, kt = 0;
    for (let k = 0; k < s.t.length; k++) { if (s.forcing[k] < s.forcing[kf]) kf = k; if (s.temperature[k] < s.temperature[kt]) kt = k; }
    ok(s.forcing[kf] < -2.5 && s.forcing[kf] > -4, `peak forcing ${s.forcing[kf].toFixed(2)} W m⁻² (−3 ± 0.5 published)`);
    ok(s.t[kf] - 1991.45 > 0.1 && s.t[kf] - 1991.45 < 0.8, `forcing peaks ${((s.t[kf] - 1991.45) * 12).toFixed(0)} months after the eruption`);
    ok(s.temperature[kt] < -0.25 && s.temperature[kt] > -0.6, `peak cooling ${s.temperature[kt].toFixed(2)} K (observed ~0.4)`);
    ok(s.temperature[kt] > s.forcing[kf] / E.EBM_FEEDBACK, 'transient cooling stays short of the equilibrium F/λ (thermal inertia)');
}
{
    let mx = 0; for (let t = 0.001; t < 5; t += 0.001) mx = Math.max(mx, E.aodProfile(t, 1));
    ok(near(mx, 1, 1e-4), 'aodProfile has unit peak');
    // constant forcing → exact relaxation to F/λ
    const inj = [];
    const s = E.forcingSeries(inj, { t0: 0, t1: 1 });
    ok(s.temperature.every(x => x === 0), 'no injections → no response');
}

// ── 7. simulation ─────────────────────────────────────────────────────────
section('7. Monte-Carlo simulation');
const prep = E.prepareSimulation(cat, { hazard: hz });
const simA = E.simulateFuture(prep, { years: 20, members: 60, seed: 3 });
const simB = E.simulateFuture(prep, { years: 20, members: 60, seed: 3 });
const simC = E.simulateFuture(prep, { years: 20, members: 60, seed: 4 });
ok(JSON.stringify(simA.bands.temperature[1]) === JSON.stringify(simB.bands.temperature[1]), 'same seed → identical ensemble');
ok(JSON.stringify(simA.bands.temperature[1]) !== JSON.stringify(simC.bands.temperature[1]), 'different seed → different ensemble');
ok(near(simA.onsetsPerYear.median, hz.globalOnsetsPerYear, 3), `simulated onsets ${simA.onsetsPerYear.median.toFixed(1)}/yr ≈ fitted ${hz.globalOnsetsPerYear.toFixed(1)}`);
{
    // record rate of VEI ≥ 5 since 1900 vs the simulation's
    let n5 = 0; for (const v of cat.volcanoes) for (const e of v.eruptions) if (e.year >= 1900 && e.vei >= 5) n5++;
    const pRec = 1 - Math.exp(-n5 / (cat.tableThrough + 1 - 1900) * 20);
    ok(near(simA.pAtLeastVei[5], pRec, 0.2), `P(≥ VEI 5 in 20 yr): sim ${simA.pAtLeastVei[5].toFixed(2)} vs record ${pRec.toFixed(2)} (${n5} since 1900)`);
}
ok(simA.bands.temperature[0].every((x, k) => x <= simA.bands.temperature[2][k] + 1e-12), '5th ≤ 95th percentile everywhere');
{
    // spin-up: the median future must START at the background level, not at 0
    // K and drift down to it. NEGATIVE CONTROL: spinUpYears 0 reproduces the
    // artefact (a cold-start trend over the first decade).
    const med = simA.bands.temperature[1];
    const early = med.slice(0, 24).reduce((a, b) => a + b, 0) / 24;
    const late = med.slice(-60).reduce((a, b) => a + b, 0) / 60;
    ok(Math.abs(early - late) < 0.05 && simA.background.temperature < -0.05,
        `spun-up median is flat: first 2 yr ${early.toFixed(3)} K vs last 5 yr ${late.toFixed(3)} K (background ${simA.background.temperature.toFixed(3)} K)`);
    const cold = E.simulateFuture(prep, { years: 20, members: 60, seed: 3, spinUpYears: 0 });
    const m0 = cold.bands.temperature[1];
    const e0 = m0.slice(0, 24).reduce((a, b) => a + b, 0) / 24, l0 = m0.slice(-60).reduce((a, b) => a + b, 0) / 60;
    ok(e0 - l0 > 0.08, `control: a cold start drifts ${(e0 - l0).toFixed(3)} K — the artefact the spin-up removes`);
    ok(near(simA.background.forcing, -0.25, 0.2), `background volcanic forcing ${simA.background.forcing.toFixed(2)} W m⁻² (long-run estimates ≈ −0.2 to −0.3)`);
}

// ── 8. replay ─────────────────────────────────────────────────────────────
section('8. 1900–2020 replay');
{
    const rep = E.replayRecord(cat);
    const s = rep.series; let k0 = -1;
    for (let k = 0; k < s.t.length; k++) if (s.t[k] >= 1985 && s.t[k] < 2000 && (k0 < 0 || s.forcing[k] < s.forcing[k0])) k0 = k;
    ok(s.t[k0] > 1991.4 && s.t[k0] < 1992.6, `deepest 1985–2000 forcing at ${s.t[k0].toFixed(2)} (Pinatubo)`);
    ok(rep.injections.some(i => i.name === 'Agung' && i.vei === 5) && rep.injections.some(i => i.name === 'Chichon, El'), 'Agung 1963 and El Chichón 1982 are in the replay');
}

{
    const near1 = E.nearestVolcano(cat.volcanoes, 37.75, 15.0, { maxKm: 30 });
    ok(near1?.volcano.name === 'Etna' && near1.km < 2, 'nearestVolcano finds Etna');
    ok(E.normaliseName('Volcán de Fuego') === 'de fuego' && E.normaliseName('Mount St. Helens') === 'st helens', 'name normaliser');
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
