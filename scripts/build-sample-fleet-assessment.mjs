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

import {
    PROFILE_MIN_KM, PROFILE_MAX_KM, PROFILE_NPOINTS, makeRhoInterp, orbitAverageRates,
} from '../js/operations/msis-drag.js';
import {
    assessSpacecraft, ballisticFromSpacecraft, elementsFromTle, parseApCsv, RE_KM,
} from '../js/fleet-assessment.js';

const args = process.argv.slice(2);
const opt  = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// The reference date sets MSIS's season/UT only (density varies a few % with
// day-of-year). Fixed so the bake is reproducible; disclosed on the page.
const REF_ISO  = opt('--epoch', '2026-10-15T00:00:00Z');
const REF_MS   = Date.parse(REF_ISO);
const BASELINE = { f107: Number(opt('--f107', 150)), ap: Number(opt('--ap', 7)) };
const OUT      = resolve(opt('--out', 'data/marketing/sample-fleet-assessment.json'));
const TLE_PATH = opt('--tle', null);

/* ── NRLMSISE-00 provider (same shape as tests/operations-msis-drag.mjs) ── */
const { default: initWasm, nrlmsise00_density_profile, nrlmsise00_profile_stride } =
    await import('../js/sgp4-wasm/sgp4_wasm.js');
await initWasm({ module_or_path: await readFile(new URL('../js/sgp4-wasm/sgp4_wasm_bg.wasm', import.meta.url)) });

const STEP = (PROFILE_MAX_KM - PROFILE_MIN_KM) / (PROFILE_NPOINTS - 1);
const ALTS = Float64Array.from({ length: PROFILE_NPOINTS }, (_, i) => PROFILE_MIN_KM + i * STEP);
const _prof = new Map();
function profileAt(f107, ap, dateMs = REF_MS) {
    const key = `${f107}|${ap}|${dateMs}`;
    if (_prof.has(key)) return _prof.get(key);
    const d   = new Date(dateMs);
    const doy = Math.floor((dateMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
    const sec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60;
    const stride = nrlmsise00_profile_stride();
    const rho = new Float64Array(PROFILE_NPOINTS);
    // Day/night average, equatorial — the operations console's provider.
    for (const lst of [0, 12]) {
        const lon  = ((lst - sec / 3600) * 15 + 540) % 360 - 180;
        const flat = nrlmsise00_density_profile(d.getUTCFullYear(), doy, sec, 0, lon, lst,
            f107, f107, new Float64Array(7).fill(ap), ALTS);
        for (let i = 0; i < PROFILE_NPOINTS; i++) rho[i] += 0.5 * flat[i * stride + 6];
    }
    const p = { alt0: PROFILE_MIN_KM, step: STEP, rho };
    _prof.set(key, p);
    return p;
}
const profileFor = (f107, ap) => profileAt(f107, ap);

/* ── Storm events: real GFZ Ap ─────────────────────────────────────────── */
async function loadEvent(dir) {
    return parseApCsv(await readFile(resolve('dsmc/fixtures/hindcast', dir, 'historical_ap.csv'), 'utf8'));
}
const EVENTS = [
    { key: 'feb2022', label: 'Feb 2022 (Starlink storm, G1–G2)', dir: 'feb_2022_starlink' },
    { key: 'gannon',  label: 'May 2024 Gannon (G5)',            dir: 'gannon_may_2024' },
];
for (const ev of EVENTS) ev.series = await loadEvent(ev.dir);

/* ── The fleet ─────────────────────────────────────────────────────────── */
// ILLUSTRATIVE fleet — not a customer, not real NORAD IDs. Spacecraft
// classes use typical published masses; area is the attitude-averaged mean
// cross-section (deployed panels included), C_D = 2.2. Every assumption is
// written into the output so the page can print it.
const SAMPLE_FLEET = [
    { id: 'SAMPLE-01', cls: '3U CubeSat',      massKg: 4.0,   areaM2: 0.020, alt: 380 },
    { id: 'SAMPLE-02', cls: '3U CubeSat',      massKg: 4.0,   areaM2: 0.020, alt: 420 },
    { id: 'SAMPLE-03', cls: '6U CubeSat',      massKg: 10.0,  areaM2: 0.060, alt: 450 },
    { id: 'SAMPLE-04', cls: '6U CubeSat',      massKg: 10.0,  areaM2: 0.060, alt: 475 },
    { id: 'SAMPLE-05', cls: '12U CubeSat',     massKg: 20.0,  areaM2: 0.080, alt: 500 },
    { id: 'SAMPLE-06', cls: '12U CubeSat',     massKg: 20.0,  areaM2: 0.080, alt: 525 },
    { id: 'SAMPLE-07', cls: '100 kg microsat', massKg: 100.0, areaM2: 0.600, alt: 550 },
    { id: 'SAMPLE-08', cls: '100 kg microsat', massKg: 100.0, areaM2: 0.600, alt: 575 },
];

let fleet, fleetKind;
if (TLE_PATH) {
    const lines = (await readFile(TLE_PATH, 'utf8')).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
    fleet = [];
    for (let i = 0; i + 2 < lines.length + 1; ) {
        let name = null;
        if (!lines[i].startsWith('1 ')) name = lines[i++].trim();
        const el = elementsFromTle(lines[i], lines[i + 1], { name });
        i += 2;
        if (!el) continue;
        fleet.push({ ...el, cls: null, bc: el.bc ?? 0.015, bcSigmaFrac: el.bc ? 0.35 : 0.6,
            bcSource: el.bc ? 'tle-bstar' : 'default' });
    }
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
for (const r of results) {
    const ev = Object.fromEntries(r.events.map(e => [e.key, e]));
    console.log(`${r.id.padEnd(10)} ${String(Math.round(r.perigeeKm)).padStart(4)} km  B=${r.bc.toFixed(4)}  `
        + `quiet ${r.quiet.decayKmPerDay.toFixed(3)} km/d  life ${Number.isFinite(r.quiet.lifetimeDays) ? (r.quiet.lifetimeDays / 365.25).toFixed(1) + ' y' : '>100 y'}  `
        + `Feb22 +${ev.feb2022.extraLossKm.toFixed(2)} km / -${(ev.feb2022.lifetimeLostDays ?? 0).toFixed(1)} d  `
        + `Gannon +${ev.gannon.extraLossKm.toFixed(2)} km / -${(ev.gannon.lifetimeLostDays ?? 0).toFixed(1)} d  x${ev.gannon.dragRatioPeak.toFixed(1)}`);
}
console.log(`Starlink @210 km: MSIS drag rise max ×${starlink.maxDragRatioFirst48h.toFixed(2)}, mean ×${starlink.meanDragRatioFirst48h.toFixed(2)} (SpaceX reported up to ×1.5)`);
