#!/usr/bin/env node
/**
 * build-sample-fleet-assessment.mjs — bake the numbers behind
 * sample-fleet-assessment.html (the "what you'd receive" marketing page for
 * the Storm-Season Fleet Assessment) and, with --tle, run the SAME analysis
 * on a real fleet for a paid engagement.
 *
 * Physics: js/fleet-assessment.js → js/operations/msis-drag.js on the
 * committed NRLMSISE-00 WASM (js/sgp4-wasm). Storm indices: the REAL 3-hourly
 * Ap in dsmc/fixtures/hindcast/<event>/historical_ap.csv (GFZ). Nothing here
 * needs the network.
 *
 * Usage:
 *   node scripts/build-sample-fleet-assessment.mjs
 *       → data/marketing/sample-fleet-assessment.json (the illustrative fleet)
 *   node scripts/build-sample-fleet-assessment.mjs --tle fleet.tle --out report.json
 *       → a real fleet. fleet.tle is 3-line (name / line1 / line2) TLEs, e.g.
 *         curl 'https://celestrak.org/NORAD/elements/gp.php?CATNR=<id>&FORMAT=TLE'
 *         per NORAD ID (CelesTrak is egress-blocked in the build sandbox, so
 *         run this on a networked machine). B comes from each TLE's B*, with
 *         the ±35 % σ msis-drag assigns to a B*-derived ballistic coefficient;
 *         replace it with the customer's mass/area as soon as they send them.
 *   --f107 <sfu>  baseline solar flux (default 150)   --ap <n> baseline Ap (default 7)
 *
 * Idempotent: the same inputs produce byte-identical JSON (no timestamps
 * except the explicit --epoch, default the reference date below).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { makeRhoInterp, orbitAverageRates } from '../js/operations/msis-drag.js';
import {
    assessSpacecraft, ballisticFromSpacecraft, parseTleBlock, parseApCsv, RE_KM,
    SPACECRAFT_CLASSES, STORM_EVENTS,
} from '../js/fleet-assessment.js';
import { makeMsisProfileProvider } from '../js/fleet-assessment-msis.js';

const args = process.argv.slice(2);
const opt  = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// The reference date sets MSIS's season/UT only (density varies a few % with
// day-of-year). Fixed so the bake is reproducible; disclosed on the page.
const REF_ISO  = opt('--epoch', '2026-10-15T00:00:00Z');
const REF_MS   = Date.parse(REF_ISO);
const BASELINE = { f107: Number(opt('--f107', 150)), ap: Number(opt('--ap', 7)) };
const OUT      = resolve(opt('--out', 'data/marketing/sample-fleet-assessment.json'));
const TLE_PATH = opt('--tle', null);

/* ── NRLMSISE-00 provider (shared with the browser simulator) ──────────── */
const wasm = await import('../js/sgp4-wasm/sgp4_wasm.js');
await wasm.default({ module_or_path: await readFile(new URL('../js/sgp4-wasm/sgp4_wasm_bg.wasm', import.meta.url)) });
const profileAt = makeMsisProfileProvider(wasm, REF_MS);
const profileFor = (f107, ap) => profileAt(f107, ap);

/* ── Storm events: real GFZ Ap ─────────────────────────────────────────── */
async function loadEvent(dir) {
    return parseApCsv(await readFile(resolve('dsmc/fixtures/hindcast', dir, 'historical_ap.csv'), 'utf8'));
}
// The sample page's two storms (labels kept as published); the full
// catalogue below feeds the interactive simulator.
const PAGE_LABELS = { feb2022: 'Feb 2022 (Starlink storm, G1–G2)', gannon: 'May 2024 Gannon (G5)' };
const EVENTS = STORM_EVENTS.filter(e => PAGE_LABELS[e.key]).map(e => ({ key: e.key, label: PAGE_LABELS[e.key], dir: e.dir }));
for (const ev of EVENTS) ev.series = await loadEvent(ev.dir);

/* ── The fleet ─────────────────────────────────────────────────────────── */
// ILLUSTRATIVE fleet — not a customer, not real NORAD IDs. Spacecraft
// classes use typical published masses; area is the attitude-averaged mean
// cross-section (deployed panels included), C_D = 2.2. Every assumption is
// written into the output so the page can print it.
const C = SPACECRAFT_CLASSES;
const SAMPLE_FLEET = [
    ['SAMPLE-01', '3u', 380], ['SAMPLE-02', '3u', 420], ['SAMPLE-03', '6u', 450], ['SAMPLE-04', '6u', 475],
    ['SAMPLE-05', '12u', 500], ['SAMPLE-06', '12u', 525], ['SAMPLE-07', 'micro', 550], ['SAMPLE-08', 'micro', 575],
].map(([id, k, alt]) => ({ id, cls: C[k].label, massKg: C[k].massKg, areaM2: C[k].areaM2, alt }));

let fleet, fleetKind;
if (TLE_PATH) {
    const parsed = parseTleBlock(await readFile(TLE_PATH, 'utf8'));
    if (parsed.rejected) console.warn(`skipped ${parsed.rejected} unparseable TLE line(s)`);
    fleet = parsed.sats;
    fleetKind = 'tle';
} else {
    fleet = SAMPLE_FLEET.map(s => ({
        id: s.id, name: `${s.cls} @ ${s.alt} km`, cls: s.cls,
        perigeeKm: s.alt, apogeeKm: s.alt,
        massKg: s.massKg, areaM2: s.areaM2, cd: 2.2,
        bc: ballisticFromSpacecraft(s), bcSigmaFrac: 0.25, bcSource: 'mass-area-assumed',
    }));
    fleetKind = 'illustrative';
}

const results = fleet.map(sc => {
    const r = assessSpacecraft(sc, { profileFor, baseline: BASELINE, events: EVENTS });
    return { ...r, massKg: sc.massKg ?? null, areaM2: sc.areaM2 ?? null, bcSource: sc.bcSource };
});

/* ── Item 2: Feb 2022 Starlink replay at the 210 km deployment orbit ───── */
// A HISTORICAL replay, so here F10.7 is the event's own (from the CSV), not
// the fleet baseline. Group 4-7 launched 2022-02-03 18:13 UTC into a ~210 km
// perigee; SpaceX's 2022-02-08 statement: drag "up to 50 percent higher than
// during previous launches". We report what NRLMSISE-00 with the real Ap
// says the drag rise was — the gap to SpaceX's number is the point.
const febCsv = (await readFile(resolve('dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv'), 'utf8'))
    .split(/\r?\n/).slice(1).filter(Boolean).map(l => { const [t, ap, f] = l.split(','); return { tMs: Date.parse(t), ap: +ap, f107: +f }; });
const day = (iso) => febCsv.filter(r => r.tMs >= Date.parse(iso) && r.tMs < Date.parse(iso) + 86400e3);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const quietDays = ['2022-02-01T00:00:00Z', '2022-02-07T00:00:00Z'];
const quietAp   = mean(quietDays.flatMap(d => day(d).map(r => r.ap)));
const STARLINK_ALT = 210;
const starlinkRows = febCsv.map(r => {
    const dMs = Date.parse('2022-02-03T00:00:00Z');
    const rho  = makeRhoInterp(profileAt(r.f107, Math.round(r.ap), dMs))(STARLINK_ALT);
    const rhoQ = makeRhoInterp(profileAt(r.f107, Math.round(quietAp), dMs))(STARLINK_ALT);
    return { t: new Date(r.tMs).toISOString(), ap: r.ap, dragRatio: rho / rhoQ };
});
const launchMs = Date.parse('2022-02-03T18:13:00Z');
const postLaunch = starlinkRows.filter(r => Date.parse(r.t) >= launchMs - 3 * 3600e3 && Date.parse(r.t) < launchMs + 48 * 3600e3);
// Daily altitude loss at 210 km for a range of ballistic coefficients —
// Starlink's own B in safe mode is not public, so we show the span.
const febF107 = mean(febCsv.map(r => r.f107));
const peakAp  = Math.max(...postLaunch.map(r => r.ap));
const lossRows = [0.01, 0.03, 0.06].map(bc => {
    const aKm = RE_KM + STARLINK_ALT;
    const q = orbitAverageRates(aKm, 0, bc, makeRhoInterp(profileAt(febF107, Math.round(quietAp))));
    const s = orbitAverageRates(aKm, 0, bc, makeRhoInterp(profileAt(febF107, Math.round(peakAp))));
    return { bc, quietKmDay: -q.adotKmDay, stormKmDay: -s.adotKmDay };
});
const starlink = {
    altitudeKm: STARLINK_ALT,
    launchIso: '2022-02-03T18:13:00Z',
    quietAp: Math.round(quietAp * 10) / 10,
    f107: Math.round(febF107 * 10) / 10,
    maxDragRatioFirst48h: Math.max(...postLaunch.map(r => r.dragRatio)),
    meanDragRatioFirst48h: mean(postLaunch.map(r => r.dragRatio)),
    peakApFirst48h: peakAp,
    spacexReportedRise: 0.5,
    spacexSource: 'SpaceX update, 8 Feb 2022: drag "up to 50 percent higher than during previous launches"; up to 40 of 49 satellites lost',
    series: starlinkRows,
    lossVsBallistic: lossRows,
};

const doc = {
    _note: 'Generated by scripts/build-sample-fleet-assessment.mjs — do not hand-edit.',
    kind: fleetKind,
    model: {
        density: 'NRLMSISE-00 (committed WASM), equatorial day/night average',
        integrator: 'js/operations/msis-drag.js orbit-averaged Gauss equations, 1 h steps through storms',
        referenceDate: REF_ISO,
        baseline: BASELINE,
        stormReplay: 'Real 3-hourly GFZ Ap replayed at today\'s baseline F10.7; only the geomagnetic storm differs from quiet',
        empiricalCaveat: 'NRLMSISE-00 is an empirical model and under-responds at storm onset, so storm penalties are lower bounds.',
        lifetimeCaveat: 'Lifetimes hold F10.7 at the baseline for the whole remaining life; a declining solar cycle lengthens them.',
    },
    events: EVENTS.map(e => ({ key: e.key, label: e.label, source: `dsmc/fixtures/hindcast/${e.dir}/historical_ap.csv`,
        startIso: new Date(e.series[0].tMs).toISOString(), peakAp: Math.max(...e.series.map(s => s.ap)),
        ap: e.series.map(s => s.ap) })),
    fleet: results,
    starlink,
};

const round = (k, v) => (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v))
    ? Number(v.toPrecision(5)) : (v === Infinity ? null : v);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(doc, round, 1) + '\n');

console.log(`wrote ${OUT}`);

/* ── Storm catalogue for the browser simulator ─────────────────────────── */
if (!TLE_PATH && !args.includes('--out')) {
    const catalog = [];
    for (const e of STORM_EVENTS) {
        const series = await loadEvent(e.dir);
        catalog.push({ key: e.key, label: e.label, scale: e.scale,
            source: `dsmc/fixtures/hindcast/${e.dir}/historical_ap.csv`,
            startIso: new Date(series[0].tMs).toISOString(), stepHours: 3,
            ap: series.map(x => x.ap) });
    }
    const evOut = resolve('data/marketing/storm-replay-events.json');
    await writeFile(evOut, JSON.stringify({
        _note: 'Generated by scripts/build-sample-fleet-assessment.mjs — do not hand-edit.',
        referenceDate: REF_ISO, baseline: BASELINE, events: catalog }, null, 1) + '\n');
    console.log(`wrote ${evOut}`);
}
for (const r of results) {
    const ev = Object.fromEntries(r.events.map(e => [e.key, e]));
    console.log(`${r.id.padEnd(10)} ${String(Math.round(r.perigeeKm)).padStart(4)} km  B=${r.bc.toFixed(4)}  `
        + `quiet ${r.quiet.decayKmPerDay.toFixed(3)} km/d  life ${Number.isFinite(r.quiet.lifetimeDays) ? (r.quiet.lifetimeDays / 365.25).toFixed(1) + ' y' : '>100 y'}  `
        + `Feb22 +${ev.feb2022.extraLossKm.toFixed(2)} km / -${(ev.feb2022.lifetimeLostDays ?? 0).toFixed(1)} d  `
        + `Gannon +${ev.gannon.extraLossKm.toFixed(2)} km / -${(ev.gannon.lifetimeLostDays ?? 0).toFixed(1)} d  x${ev.gannon.dragRatioPeak.toFixed(1)}`);
}
console.log(`Starlink @210 km: MSIS drag rise max ×${starlink.maxDragRatioFirst48h.toFixed(2)}, mean ×${starlink.meanDragRatioFirst48h.toFixed(2)} (SpaceX reported up to ×1.5)`);
