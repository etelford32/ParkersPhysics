/**
 * seafloor-kernels.mjs — gates for sea-floor.html's PURE kernels (js/seafloor/*).
 *
 *   node tests/seafloor-kernels.mjs
 *
 * Oracles are independent of the code under test: the equation of state against python-seawater's
 * output (and, loosely, TEOS-10); the sounder against closed forms; the beam against the geometry
 * of a V-shaped trench; the adiabat model against REAL casts with their lower part withheld, with
 * two controls that must lose. The baked data (data/seafloor/*) is real — never hand-edit it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SW from '../js/seafloor/seawater.js';
import * as PR from '../js/seafloor/profile.js';
import * as SO from '../js/seafloor/sounder.js';
import * as BA from '../js/seafloor/bathy.js';
import * as PM from '../js/seafloor/page-model.js';
import { SEAFLOOR_SITES, WINDOW_HALF_DEG, GRID_ARCMIN } from '../js/seafloor/sites.js';
import * as LI from '../js/seafloor/light.js';
import * as FD from '../js/seafloor/free-dive.js';
import { terrariumEncode, tileLatLon, TILE_PX } from '../js/climalytix/terrain.js';
import * as TM from '../js/seafloor/trench-model.js';
import * as LIT from '../js/seafloor/trench-literature.js';
import * as BP from '../js/seafloor/broken-plate.js';
import * as AG from '../js/seafloor/age.js';
import * as SD from '../js/seafloor/sediment.js';
import { decodePlates } from '../js/earth-interior/plates.js';
import { decodeSlabs } from '../js/earth-interior/slabs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p));
let n = 0;
const ok = (c, msg) => { assert.ok(c, msg); n++; };
const near = (a, b, tol, msg) => { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`); n++; };
const log = (...a) => console.log('  ', ...a);

// ── 1. equation of state vs the oracle ───────────────────────────────────────
console.log('1. seawater.js vs python-seawater (EOS-80) and gsw (TEOS-10)');
{
    const o = JSON.parse(rd('tests/fixtures/seafloor/seawater-oracle.json'));
    let eC = 0, eG = 0, eT = 0, dTeos = 0, dTheta = 0;
    for (const r of o.points) {
        eC = Math.max(eC, Math.abs(SW.soundSpeed(r.S, r.T, r.p) - r.c));
        eG = Math.max(eG, Math.abs(SW.adiabaticGradient(r.S, r.T, r.p) - r.adtg) / Math.abs(r.adtg || 1));
        eT = Math.max(eT, Math.abs(SW.potentialTemperature(r.S, r.T, r.p, 0) - r.theta0));
        if (r.T <= 4 && r.S < 36) { dTeos = Math.max(dTeos, Math.abs(SW.soundSpeed(r.S, r.T, r.p) - r.c_teos10)); dTheta = Math.max(dTheta, Math.abs(SW.potentialTemperature(r.S, r.T, r.p, 0) - r.theta0_teos10)); }
    }
    ok(o.points.length >= 200, 'oracle has its points');
    ok(eC < 1e-9, `sound speed ≡ oracle (${eC})`); ok(eG < 1e-12, `adiabatic gradient ≡ oracle (${eG})`); ok(eT < 1e-10, `potential temperature ≡ oracle (${eT})`);
    // the EOS-80 ↔ TEOS-10 spread is REAL and is what SOUND_SPEED_UNCERTAINTY discloses: pinned as a band, not "fixed"
    ok(dTeos > 1.0 && dTeos < 2.6, `EOS-80 vs TEOS-10 sound speed, cold deep water: ${dTeos.toFixed(2)} m/s`);
    ok(dTeos / 1550 <= SW.SOUND_SPEED_UNCERTAINTY * 1.2, 'the stated uncertainty covers that spread');
    ok(dTheta < 0.01, `θ vs TEOS-10 ${dTheta.toFixed(4)} °C`);
    let eZ = 0, eZ2 = 0, rt = 0, saunders = 0;
    for (const d of o.depth) {
        eZ = Math.max(eZ, Math.abs(SW.depthFromPressure(d.p, d.lat) - d.z)); eZ2 = Math.max(eZ2, Math.abs(SW.depthFromPressure(d.p, d.lat) - d.z_teos10));
        const p = SW.pressureFromDepth(d.z, d.lat); rt = Math.max(rt, Math.abs(p - d.p));
        const X = Math.sin(Math.abs(d.lat) * Math.PI / 180), C1 = 5.92e-3 + X * X * 5.25e-3;
        saunders = Math.max(saunders, Math.abs(((1 - C1) - Math.sqrt((1 - C1) ** 2 - 8.84e-6 * d.z)) / 4.42e-6 - d.p));
    }
    ok(eZ < 1e-9, 'depth(p) ≡ oracle'); ok(eZ2 < 2, `depth(p) vs TEOS-10 ${eZ2.toFixed(2)} m`);
    ok(rt < 1e-6, `pressure(depth) is the exact inverse (${rt})`);
    ok(saunders > 1, `NEGATIVE CONTROL: Saunders' closed form misses by ${saunders.toFixed(1)} dbar`);
    // adiabat identities
    near(SW.potentialTemperature(34.7, 1.5, 6000, 6000), 1.5, 1e-12, 'no move, no change');
    const down = SW.potentialTemperature(34.7, 1.5, 6000, 11000), up = SW.potentialTemperature(34.7, down, 11000, 6000);
    ok(down > 1.5 + 0.5, `a parcel pushed 6→11 km dbar warms (${(down - 1.5).toFixed(3)} °C)`); near(up, 1.5, 1e-4, 'and cools back');
    log(`EOS-80 exact; TEOS-10 spread ${dTeos.toFixed(2)} m/s; Saunders control ${saunders.toFixed(1)} dbar`);
}

// ── 2. profile model on closed forms ─────────────────────────────────────────
console.log('2. profile.js');
{
    // a column of ONE water mass (θ = 1.0, S = 34.7) sampled 0–9 km: the adiabat must reproduce the withheld part
    const lat = 11, z = [], t = [], s = [];
    for (let d = 0; d <= 9000; d += 100) { z.push(d); t.push(SW.potentialTemperature(34.7, 1.0, 0, SW.pressureFromDepth(d, lat))); s.push(34.7); }
    const w = PR.withheldTest({ z, t, s, lat }, 5000);
    ok(w.rms.adiabat < 2e-3, `adiabat recovers a single water mass (${w.rms.adiabat.toExponential(1)} °C)`);
    ok(w.rms.isothermal > 50 * w.rms.adiabat, `control "temperature held" loses (${w.rms.isothermal.toFixed(3)} °C)`);
    const col = PR.buildColumn({ z: z.filter((d) => d <= 6000), t: t.slice(0, 61), s: s.slice(0, 61), lat, floorDepthM: 9000 });
    ok(col.modelled && col.gapM === 3000 && col.flags.includes('long-model-gap'), 'a 3 km model gap is flagged');
    const last = col.levels[col.levels.length - 1];
    ok(last.kind === 'model' && last.z === 9000, 'the column ends ON the floor, modelled');
    near(last.t, t[90], 2e-3, 'modelled floor temperature = the truth for one water mass');
    near(last.theta, 1.0, 2e-3, 'θ stays constant down the model');
    ok(col.levels.every((l, i) => i === 0 || l.z > col.levels[i - 1].z), 'levels strictly deepen');
    ok(PR.columnAt(col, 9000.5) === null && PR.columnAt(col, -1) === null, 'never extrapolated outside the column');
    const tm = PR.temperatureMinimum(col); ok(!tm.atFloor && tm.z < 5000, `the coldest water is NOT at the floor (${tm.z} m)`);
    // salinity gaps: bridged between neighbours, held at ends, assumed when absent — never 0
    const f = PR.fillSalinity([0, 10, 20, 30, 40], [null, 34, null, 36, null]);
    assert.deepEqual(f.s, [34, 34, 35, 36, 36]); assert.deepEqual(f.kind, ['held', 'measured', 'bridged', 'measured', 'held']); n += 2;
    ok(PR.fillSalinity([0, 10], null).kind.every((k) => k === 'assumed'), 'no salinity ⇒ assumed, and said');
    ok(PR.buildColumn({ z: [0], t: [1], lat: 0, floorDepthM: 100 }) === null, 'a one-level cast is no column');
    ok(PR.referenceCast([{ max_depth_m: 5, date: '2001-01-01' }, { max_depth_m: 9, date: '1990-01-01' }]).max_depth_m === 9, 'reference = deepest');
}

// ── 3. sounder on closed forms ───────────────────────────────────────────────
console.log('3. sounder.js');
{
    const mk = (cOf, D, step = 50) => ({ levels: Array.from({ length: D / step + 1 }, (_, i) => ({ z: i * step, c: cOf(i * step) })) });
    const flat = mk(() => 1500, 10000);
    near(SO.travelTime(flat, 10000), 2 * 10000 / 1500, 1e-12, 'constant c: t = 2D/c');
    near(SO.sounding(flat, 7300).errorM, 0, 1e-9, 'a 1500 m/s ocean needs no correction');
    const g = 0.017, c0 = 1480, lin = mk((z) => c0 + g * z, 11000);
    const exact = 2 / g * Math.log((c0 + g * 11000) / c0);
    near(SO.travelTime(lin, 11000), exact, exact * 2e-6, 'linear c(z): t = (2/g) ln(c₁/c₀)');
    const s = SO.sounding(lin, 11000);
    ok(s.errorM < -300 && s.errorM > -600, `uncorrected 1500 m/s reads ${Math.round(-s.errorM)} m SHALLOW over 11 km`);
    near(s.naiveDepth + s.correctionM, 11000, 1e-9, 'naive + correction = depth');
    near(SO.depthFromTravelTime(lin, SO.travelTime(lin, 8765)), 8765, 1e-6, 'time → depth is the exact inverse');
    ok(SO.travelTime(lin, 11001) === null && SO.depthFromTravelTime(lin, 99) === null, 'never timed through water the column does not describe');
    ok(SO.sounding(lin, 11000, { nominal: SO.NOMINAL_SPEEDS.fathoms800 }).errorM < s.errorM, '800 fm/s reads shallower still');
    // beam: a V-shaped trench, walls at α from horizontal, axis N–S, ship over the axis
    const D = 10000, alpha = 20 * Math.PI / 180, step = 1 / 120, nx = 241, ny = 241, lat0 = 0;
    const z = new Int16Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const xm = Math.abs(i - 120) * step * Math.PI / 180 * 6371008.8; z[j * nx + i] = -Math.max(100, D - xm * Math.tan(alpha)); }
    const grid = BA.makeGrid({ id: 'v', nx, ny, north: lat0 + 1, west: 100, step_deg: step }, z);
    const wide = SO.firstReturn(grid, lat0, 101, 60), mid = SO.firstReturn(grid, lat0, 101, 12), mb = SO.firstReturn(grid, lat0, 101, 1);
    near(wide.apparentDepth, D * Math.cos(alpha), D * 0.004, 'wide beam: first echo is the wall\'s perpendicular foot, D·cos α');
    const hEdge = D / (1 + Math.tan(6 * Math.PI / 180) * Math.tan(alpha));
    near(mid.apparentDepth, hEdge / Math.cos(6 * Math.PI / 180), D * 0.004, '12° beam: the cone edge on the wall');
    near(mb.apparentDepth, D, 1, '1° multibeam beam: straight down');
    ok(wide.biasM < mid.biasM && mid.biasM < 0 && wide.hit.offKm > 2, `a wider beam reads shoaler, from further away (${wide.biasM} ${mid.biasM} ${wide.hit.offKm})`);
    near(SO.beamFootprintM(10000, 60), 2 * 10000 * Math.tan(Math.PI / 6), 1e-9, 'footprint');
    const ps = SO.pressureSounding(10900, 11.3); near(ps.depthM, 10900, 1e-5, 'pressure gauge round trip'); ok(ps.atm > 1095 && ps.atm < 1120, `~1100 atm at Challenger Deep (${ps.atm.toFixed(0)})`);
    log(`linear-ocean sounding error ${Math.round(s.errorM)} m; V-trench wide-beam bias ${Math.round(wide.biasM)} m`);
}

// ── 4. the baked bathymetry (REAL) ───────────────────────────────────────────
console.log('4. bathy.js on data/seafloor/*.bin.gz');
const index = JSON.parse(rd('data/seafloor/index.json'));
const grids = new Map();
{
    ok(index.sites.length === SEAFLOOR_SITES.length && SEAFLOOR_SITES.every((s) => index.sites.some((m) => m.id === s.id)), 'every site in sites.js is baked, and nothing else');
    ok(new Set(SEAFLOOR_SITES.map((s) => s.id)).size === SEAFLOOR_SITES.length, 'site ids are unique');
    ok(SEAFLOOR_SITES.every((s) => s.verified === false), 'published depths are all marked unverified (written from memory)');
    for (const m of index.sites) {
        const g = BA.makeGrid(m, BA.int16FromBytes(new Uint8Array(zlib.gunzipSync(rd(`data/seafloor/${m.id}.bin.gz`)))));
        grids.set(m.id, g);
        const d = BA.deepest(g);
        assert.equal(d.depth, m.deepest.depth_m, `${m.id}: deepest cell = index`); near(d.lat, m.deepest.lat, 1e-4, `${m.id} lat`); n++;
        near(BA.sampleDepth(g, d.lat, d.lon), d.depth, 1e-6, `${m.id}: bilinear at a node = the node`);
        ok(m.step_deg === +(GRID_ARCMIN / 60).toFixed(8) && m.ny === 2 * WINDOW_HALF_DEG * 60 / GRID_ARCMIN + 1, `${m.id}: grid geometry follows sites.js`);
        ok(BA.sampleDepth(g, m.north + 0.1, m.west) === null, 'null outside the window');
    }
    const mar = grids.get('mariana'), dm = BA.deepest(mar);
    ok(dm.depth > 10600 && dm.depth < 11050, `Challenger Deep on the grid: ${dm.depth} m`);
    ok(Math.min(BA.distanceKm(dm.lat, dm.lon, 11.33, 142.2), BA.distanceKm(dm.lat, dm.lon, 11.37, 142.59)) < 30, 'and it is one of Challenger Deep\'s pools');
    for (const s of SEAFLOOR_SITES.filter((x) => x.published && x.kind !== 'plain')) { const m = index.sites.find((q) => q.id === s.id); ok(Math.abs(m.deepest.depth_m - s.published) / s.published < 0.12, `${s.id}: grid ${m.deepest.depth_m} within 12 % of the quoted ${s.published}`); }
    // hypsometry: shares close; cos φ weighting matters at 79° N (unweighted is the control)
    const h = BA.hypsometry(mar); near(h.bins.reduce((a, b) => a + b.share, 0), 1, 1e-9, 'hypsometry shares sum to 1'); ok(h.hadalAreaKm2 > 5000, 'Mariana window has hadal floor');
    const mol = grids.get('molloy'), hm = BA.hypsometry(mol), cells = mol.z.reduce((a, v) => a + (v < 0 ? 1 : 0), 0);
    const flatArea = cells * (mol.step * Math.PI / 180 * BA.R_EARTH_KM) ** 2;
    ok(flatArea / hm.oceanAreaKm2 > 4, `NEGATIVE CONTROL: unweighted cells overstate the Fram Strait window ${(flatArea / hm.oceanAreaKm2).toFixed(1)}×`);
    // trench axis: recovered on a synthetic trench of known strike, defined on real trenches, not on a flat plain
    const nx = 241, ny = 241, step = 1 / 60, strike = 30 * Math.PI / 180, zs = new Int16Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const e = (i - 120) * 1.853, no = (120 - j) * 1.853, across = e * Math.cos(strike) - no * Math.sin(strike); zs[j * nx + i] = -(5000 + 4000 * Math.exp(-(across * across) / (2 * 15 * 15))); }
    const syn = BA.makeGrid({ id: 's', nx, ny, north: 2, west: -2, step_deg: step }, zs), ax = BA.trenchAxis(syn, 0, 0);
    ok(ax.defined && Math.abs(ax.azimuthDeg - 30) <= 5 && ax.acrossDeg === (ax.azimuthDeg + 90) % 180, `synthetic trench striking 30°: found ${ax.azimuthDeg}°`);
    const flat = BA.makeGrid({ id: 'f', nx, ny, north: 2, west: -2, step_deg: step }, new Int16Array(nx * ny).fill(-5400));
    ok(!BA.trenchAxis(flat, 0, 0).defined, 'a flat plain has no axis');
    for (const id of ['mariana', 'tonga', 'kermadec', 'puerto-rico', 'atacama']) ok(BA.trenchAxis(grids.get(id), index.sites.find((m) => m.id === id).deepest.lat, index.sites.find((m) => m.id === id).deepest.lon).defined, `${id}: axis defined`);
    const ta = BA.trenchAxis(grids.get('tonga'), dmOf('tonga').lat, dmOf('tonga').lon); ok(ta.azimuthDeg <= 40 || ta.azimuthDeg >= 170, `Tonga runs NNE (${ta.azimuthDeg}°)`);
    const sec = BA.section(mar, dm.lat, dm.lon, 0, 100, 201); near(sec[100].depth, dm.depth, 1e-6, 'section passes through its centre'); ok(Math.abs(BA.distanceKm(sec[0].lat, sec[0].lon, sec[200].lat, sec[200].lon) - 200) < 0.01, 'and is as long as asked');
    function dmOf(id) { return index.sites.find((m) => m.id === id).deepest; }
}

// ── 5. the baked casts (REAL) and the claim the page makes with them ─────────
console.log('5. casts.json.gz (NOAA World Ocean Database)');
const casts = JSON.parse(zlib.gunzipSync(rd('data/seafloor/casts.json.gz')).toString());
{
    ok(casts.format === 'seafloor-casts-v1' && Object.keys(casts.sites).length === SEAFLOOR_SITES.length, 'one entry per site');
    let total = 0, hadal = 0, warmer = 0;
    const deep = { n: 0, wins: 0, a: [], i: [], g: 0 }, shallow = { n: 0, wins: 0, a: [], i: [] };
    const AABW = new Set(['puerto-rico', 'romanche', 'south-sandwich', 'wharton']);     // bottom water underneath
    for (const s of SEAFLOOR_SITES) {
        const e = casts.sites[s.id];
        ok(e.casts.length <= casts.keep, `${s.id}: at most ${casts.keep} casts`);
        for (const c of e.casts) {
            total++;
            ok(c.z.length === c.t.length && (c.s === null || c.s.length === c.z.length), `${s.id}/${c.wod_cast}: arrays align`);
            assert.ok(c.z.every((v, i) => i === 0 || v > c.z[i - 1]), `${s.id}/${c.wod_cast}: depth strictly increases`);
            assert.ok(c.t.every((v) => v > -2.5 && v < 35) && c.max_depth_m >= casts.min_depth_m && c.km <= casts.radius_km + 1, `${s.id}/${c.wod_cast}: plausible`);
            assert.ok(/^\d{4}-\d\d-\d\d$/.test(c.date)); n += 3;
            if (s.kind === 'trench' && c.max_depth_m >= 7000) {
                hadal++;
                const k = c.t.indexOf(Math.min(...c.t.filter((_, i) => c.z[i] >= 500)));
                if (c.t[c.t.length - 1] > c.t[k] + 0.05 && c.z[k] < c.max_depth_m - 1000) warmer++;
            }
            // (a) the model where the page uses it with confidence: started at or below 6 km
            if (c.max_depth_m >= 7500) { const w = PR.withheldTest(c, Math.max(6000, c.max_depth_m - 2000)); if (w && w.cutDepth >= 5500) { deep.n++; deep.a.push(w.rms.adiabat); deep.i.push(w.rms.isothermal); if (w.rms.adiabat < w.rms.isothermal) deep.wins++; if (w.rms.adiabat < w.rms.gradient) deep.g++; } }
            // (b) the model started TOO SHALLOW over Antarctic Bottom Water: the recorded failure
            if (AABW.has(s.id) && c.max_depth_m >= 6000) { const w = PR.withheldTest(c, 4500); if (w && w.cutDepth >= 4000 && w.cutDepth < PR.ADIABAT_SAFE_FROM_M) { shallow.n++; shallow.a.push(w.rms.adiabat); shallow.i.push(w.rms.isothermal); if (w.rms.adiabat < w.rms.isothermal) shallow.wins++; } }
        }
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    log(`${total} casts; ${hadal} trench casts reach 7 km; warmer at the bottom than at their minimum in ${warmer}`);
    log(`adiabat from ≥ 6 km, bottom withheld (${deep.n} casts): median rms ${med(deep.a).toFixed(3)} °C vs "held" ${med(deep.i).toFixed(3)} °C; wins ${deep.wins}/${deep.n}; beats gradient-extrapolation ${deep.g}/${deep.n}`);
    log(`adiabat from ~4.5 km over bottom water (${shallow.n} casts): median rms ${med(shallow.a).toFixed(3)} °C vs "held" ${med(shallow.i).toFixed(3)} °C; wins ${shallow.wins}/${shallow.n}`);
    ok(total >= 120, 'the archive has casts'); ok(hadal >= 20, 'and real hadal ones');
    ok(warmer / hadal >= 0.9, 'MEASURED: trench water is warmer at the bottom than at its temperature minimum');
    ok(deep.n >= 15 && deep.wins / deep.n >= 0.9, 'started below ~6 km, the adiabat beats "temperature held" on real withheld data');
    ok(med(deep.a) < 0.03 && med(deep.i) > 5 * med(deep.a), 'and by a wide margin');
    // PINNED, not fixed: started at ~4.5 km where bottom water lies below, the model LOSES more often than not.
    // Do not tune this away — it is why ADIABAT_SAFE_FROM_M exists and why the page flags such columns.
    ok(shallow.n >= 8 && shallow.wins / shallow.n < 0.5, 'RECORDED FAILURE: over Antarctic Bottom Water the adiabat started at 4.5 km loses to "held"');
    const refs = SEAFLOOR_SITES.map((s) => PR.referenceCast(casts.sites[s.id].casts)).filter(Boolean);
    ok(refs.every((r) => r.levels >= 5), 'every reference cast has levels');
}

// ── 6. the page model ────────────────────────────────────────────────────────
console.log('6. page-model.js');
{
    const rows = PM.siteSummaries(index, casts);
    ok(rows.length === SEAFLOOR_SITES.length, 'a row per site');
    for (const r of rows) {
        ok(['measured', 'model', null].includes(r.floorKind), `${r.id}: kind`);
        ok((r.floorKind === null) === (r.floorT == null), `${r.id}: no cast ⇒ no temperature (never invented)`);
        if (r.kind === 'plain') ok(r.gridDepth < r.gridDeepest, `${r.id}: a plain is read at its typical floor, not its deepest hole`);
        if (r.floorKind === 'measured') ok(r.gapM < 1e-6, `${r.id}: measured ⇒ no gap`);
    }
    const noCasts = PM.siteSummaries(index, null); ok(noCasts.every((r) => r.floorKind === null && r.gridDepth > 0), 'archive down ⇒ depths stay, temperatures absent');
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    log(rows.filter((r) => r.floorKind).map((r) => `${r.id} ${r.floorT.toFixed(2)}${r.floorKind === 'model' ? '*' : ''}`).join('  '));
    if (by.mariana.floorKind) ok(by.mariana.floorT > 1.8 && by.mariana.floorT < 2.9, `Challenger Deep bottom water ${by.mariana.floorT.toFixed(2)} °C`);
    if (by.hellenic.floorKind) ok(by.hellenic.floorT > 12, `the Mediterranean deep is warm (${by.hellenic.floorT.toFixed(1)} °C)`);
    if (by.weddell.floorKind && by.mariana.floorKind) ok(by.weddell.floorT < by.mariana.floorT - 1.5, 'the Weddell plain is far colder than the far deeper Mariana floor');
    const site = SEAFLOOR_SITES.find((s) => s.id === 'mariana'), meta = index.sites.find((m) => m.id === 'mariana');
    const d = PM.siteDetail({ site, meta, grid: grids.get('mariana'), casts: casts.sites.mariana.casts, beamDeg: 60 });
    ok(Math.abs(d.point.depth - meta.deepest.depth_m) < 1 && d.section.length === 241 && d.axis.defined, 'detail: point, section, axis');
    ok(d.ping && d.ping.errorM < -250 && d.ping.meanSpeed > 1530 && d.ping.meanSpeed < 1570, `Challenger Deep: 1500 m/s reads ${Math.round(-d.ping.errorM)} m shallow, real mean ${d.ping.meanSpeed.toFixed(0)} m/s`);
    ok(d.echo.biasM <= 0 && d.echo.apparentDepth <= d.point.depth, 'a beam never reads deeper than the truth');
    ok(SO.firstReturn(grids.get('mariana'), d.point.lat, d.point.lon, 1).biasM === 0, 'a 1° beam on a 1.8 km grid sees only the cell below');
    const d2 = PM.siteDetail({ site, meta, grid: grids.get('mariana'), casts: casts.sites.mariana.casts, at: { lat: meta.deepest.lat + 0.5, lon: meta.deepest.lon } });
    ok(d2.point.custom && d2.reach <= d2.point.depth + 1e-6 && d2.ping.depthM <= d2.point.depth + 1e-6, 'a custom point is sounded to ITS floor');
    const c0 = PM.depthColor(100), c1 = PM.depthColor(10000); ok(c0[0] + c0[1] + c0[2] > c1[0] + c1[1] + c1[2], 'depth ramp: deeper is darker'); assert.deepEqual(PM.depthColor(-5), PM.LAND_COLOR); n++;
    let mono = true; for (let z = 0, prev = 1e9; z <= 11000; z += 250) { const c = PM.depthColor(Math.max(1, z)), L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; if (L > prev + 1e-9) mono = false; prev = L; } ok(mono, 'and monotonic in lightness');
    // the renderer and the controller compute no physics
    const page = rd('js/seafloor/page.js').toString(), stage = rd('js/seafloor/stage.js').toString();
    for (const f of ['soundSpeed(', 'potentialTemperature(', 'adiabaticGradient(', 'pressureFromDepth(', 'travelTime(']) ok(!page.includes(f) && !stage.includes(f), `page.js / stage.js never call ${f}`);
    ok(!/from '\.\/seawater\.js'/.test(page) && !/from '\.\/seawater\.js'/.test(stage), 'nor import the equation of state');
    const html = rd('sea-floor.html').toString(); ok(html.indexOf('type="importmap"') < html.indexOf('modulepreload'), 'import map precedes the first module load');
    ok(!stage.match(/\/\* glsl \*\//), 'stage has no raw shader');
}
// ── 7. the globe: the planet grid, light, and a dive anywhere ────────────────
console.log('7. globe, light, free dive');
{
    const wm = index.world, w = BA.decodeWorld(wm, new Uint8Array(zlib.gunzipSync(rd('data/seafloor/' + wm.file))));
    ok(w.z.length === wm.nx * wm.ny && wm.step_deg === 0.25, 'the planet grid decodes to its declared size');
    let mn = 1e9, mx = -1e9, area = [0, 0];
    for (let k = 0; k < w.z.length; k++) { const v = w.z[k]; if (v < mn) mn = v; if (v > mx) mx = v; const c = Math.cos((90 - (Math.floor(k / w.nx) + 0.5) * w.step) * Math.PI / 180); area[0] += v < 0 ? c : 0; area[1] += c; }
    ok(mn < -9500 && mn > -11100 && mx > 5500 && mx < 8900, `planet grid spans ${mn} … ${mx} m (0.25° cells average the extremes)`);
    ok(area[0] / area[1] > 0.69 && area[0] / area[1] < 0.73, `and is ${(100 * area[0] / area[1]).toFixed(1)} % ocean (Earth: 71 %)`);
    // the coarse planet grid and the fine baked windows are the SAME sea floor: median depth of each window agrees
    let worst = 0;
    for (const m of index.sites) {
        const g = grids.get(m.id); let sw = 0, sf = 0, c = 0;
        for (let j = 20; j < g.ny - 20; j += 20) for (let i = 20; i < g.nx - 20; i += 20) { const la = BA.cellLat(g, j), lo = BA.cellLon(g, i), f = BA.depthAtCell(g, i, j); if (f <= 0) continue; sw += -BA.worldElevationAt(w, la, lo); sf += f; c++; }
        if (c) worst = Math.max(worst, Math.abs(sw / c - sf / c) / (sf / c));
    }
    ok(worst < 0.06, `planet grid vs the 28 fine windows: mean depth within ${(100 * worst).toFixed(1)} %`);
    // NEGATIVE CONTROL: read without un-shuffling the bytes and the planet is noise
    const bad = new Uint8Array(zlib.gunzipSync(rd('data/seafloor/' + wm.file))); const sw2 = bad.slice(); for (let k = 0; k < sw2.length / 2; k++) { sw2[2 * k] = bad[k]; sw2[2 * k + 1] = bad[bad.length / 2 + k]; }
    const wrong = BA.decodeWorld(wm, sw2); let far = 0; for (let k = 0; k < w.z.length; k += 997) if (Math.abs(wrong.z[k] - w.z[k]) > 500) far++;
    ok(far > 200, 'NEGATIVE CONTROL: the un-shuffled byte order is not the planet');
    near(BA.worldElevationAt(w, 10, 180), BA.worldElevationAt(w, 10, -180), 1e-9, 'longitude wraps at the date line');
    // frame: exact inverses, +X Greenwich, +Y north, −Z = 90° E (js/geo/coords.js)
    for (const [la, lo] of [[0, 0], [45, 90], [-30, -120], [80, 179], [-80, -179]]) { const d = BA.dirOf(la, lo), b = BA.latLonOf(...d); near(b.lat, la, 1e-9, 'lat round trip'); near(b.lon, lo, 1e-9, 'lon round trip'); }
    assert.deepEqual(BA.dirOf(0, 0).map((v) => +v.toFixed(12)), [1, 0, 0]); ok(BA.dirOf(0, 90)[2] < -0.999999 && BA.dirOf(90, 0)[1] > 0.999999, '−Z is 90° E, +Y is north');
    ok(/x = cos|\-Z|−Z/.test(rd('js/geo/coords.js').toString()), 'the canonical frame file is still there to agree with');
    const tex = PM.worldTexture({ nx: 8, ny: 4, step: 45, z: new Int16Array(32).fill(-4000) });
    const flat = PM.depthColor(4000); ok(tex.length === 128 && Math.abs(tex[0] - flat[0]) <= 1 && Math.abs(tex[2] - flat[2]) <= 1 && tex[3] === 255, 'a flat sea floor is drawn in the depth ramp\'s own colour (hillshade exactly 1)');
    // light
    near(LI.sunlightFraction(0), 1, 0, 'full light at the surface'); near(LI.sunlightFraction(LI.depthOfFraction(0.01)), 0.01, 1e-12, '1 % level round trip');
    const eu = LI.depthOfFraction(0.01); ok(eu > 100 && eu < 150, `1 % light level at ${eu.toFixed(0)} m (clear ocean: 100–150 m)`); ok(LI.KD_CLEAR_OCEAN.verified === false, 'and its coefficient is marked unverified');
    ok(LI.zoneAt(50).id === 'epipelagic' && LI.zoneAt(200).id === 'mesopelagic' && LI.zoneAt(3999).id === 'bathypelagic' && LI.zoneAt(5000).id === 'abyssopelagic' && LI.zoneAt(10900).id === 'hadal' && LI.zoneAt(-1) === null, 'depth zones');
    let dark = true, prev = 1e9; for (let z = 1; z <= 4000; z += 50) { const c = LI.ambientColor(z), L = c[0] + c[1] + c[2]; if (L > prev) dark = false; prev = L; } ok(dark && LI.ambientColor(3000).every((v) => v === 0), 'the backdrop only darkens with depth, to black in the midnight zone');
    assert.deepEqual(LI.ambientColor(-5), LI.SKY_RGB.slice()); n++;
    // a dive window anywhere: SYNTHETIC tiles of a known sea floor, sampled back through the tile pyramid
    const h = (lat, lon) => -4000 - 500 * Math.sin(lat * 0.5) * Math.cos(lon * 0.4) - 4000 * Math.exp(-((lat - 20.3) ** 2 + (lon + 40.2) ** 2) / 0.5);
    const tiles = new Map(), getTile = (z, x, y) => {
        const key = `${z}/${x}/${y}`; if (tiles.has(key)) return tiles.get(key);
        const d = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
        for (let j = 0; j < TILE_PX; j++) { const lat = tileLatLon(x, y + (j + 0.5) / TILE_PX, z).lat; for (let i = 0; i < TILE_PX; i++) { const rgb = terrariumEncode(h(lat, tileLatLon(x + (i + 0.5) / TILE_PX, y, z).lon)); d.set([rgb[0], rgb[1], rgb[2], 255], (j * TILE_PX + i) * 4); } }
        tiles.set(key, d); return d;
    };
    const win = FD.diveWindow(20.31, -40.19), need = FD.diveTiles(win);
    ok(win.ny === 2 * WINDOW_HALF_DEG * 60 / GRID_ARCMIN + 1 && win.step_deg === index.sites[0].step_deg, 'a dive window has the baked windows\' own shape');
    const sampled = FD.gridFromTiles(win, (z, x, y) => (need.some((t) => t.z === z && t.x === x && t.y === y) ? getTile(z, x, y) : null));
    ok(sampled.holes === 0, `the listed tiles (${need.length}) cover every node`);
    const meta = FD.diveMeta(win, sampled), dg = BA.makeGrid(meta, sampled.z);
    let err = 0; for (let j = 0; j < dg.ny; j += 7) for (let i = 0; i < dg.nx; i += 7) err = Math.max(err, Math.abs(BA.depthAtCell(dg, i, j) + h(BA.cellLat(dg, j), BA.cellLon(dg, i))));
    ok(err < 3, `tiles → grid reproduces the sea floor to ${err.toFixed(2)} m`);
    ok(Math.abs(meta.deepest.lat - 20.3) < 0.05 && Math.abs(meta.deepest.lon + 40.2) < 0.05 && meta.deepest.depth_m > 6000, 'and finds the planted deep');
    ok(FD.gridFromTiles(win, () => null).holes === win.nx * win.ny, 'NEGATIVE CONTROL: no tiles ⇒ every node is a hole, none is sea level');
    ok(FD.diveWindow(85, 0) === null && FD.diveWindow(-79.9, 10) !== null, 'no window past the tile pyramid');
    // the dive HUD
    const site = PM.customSite(20.31, -40.19), det = PM.siteDetail({ site, meta, grid: dg, casts: [] });
    ok(det.point.custom && det.column === null && det.ping === null && det.pressure.dbar > 4000, 'open ocean with no cast: depth and pressure, no column, no echo time');
    const hud = PM.cameraReport(det, dg, { lat: 20.31, lon: -40.19, depthM: 1500 });
    ok(hud.underwater && hud.t === null && hud.zone.id === 'bathypelagic' && Math.abs(hud.aboveFloorM - (det.point.depth - 1500)) < 1 && hud.atm > 145 && hud.atm < 155, 'HUD: zone, pressure, height above the floor — and NO temperature where no cast is');
    ok(!PM.cameraReport(det, dg, { lat: 20.31, lon: -40.19, depthM: -200 }).underwater, 'above the surface is not under water');
    const mar = PM.siteDetail({ site: SEAFLOOR_SITES.find((s) => s.id === 'mariana'), meta: index.sites.find((m) => m.id === 'mariana'), grid: grids.get('mariana'), casts: casts.sites.mariana.casts });
    const w1 = PM.waterAt(mar, 4600), w2 = PM.waterAt(mar, 10800);
    ok(w1.tKind === 'measured' && w2.t > w1.t + 0.8, `diving Challenger Deep: ${w1.t.toFixed(2)} °C at 4.6 km, ${w2.t.toFixed(2)} °C at 10.8 km`);
    const nearM = PM.castsNear(casts, 11.35, 142.2), none = PM.castsNear(casts, 20.31, -40.19);
    ok(nearM.length >= 8 && nearM.every((c, i) => c.km <= 150 && (i === 0 || c.km >= nearM[i - 1].km)) && none.length === 0 && PM.castsNear(null, 0, 0).length === 0, 'casts near a point: within 150 km, nearest first, none in mid-Atlantic');
    const globe = rd('js/seafloor/globe.js').toString();
    ok(!/intersectObject/.test(globe) && /pointAt/.test(globe), 'the globe picks analytically, never by mesh raycast');
    for (const f of ['soundSpeed(', 'potentialTemperature(', 'pressureFromDepth(', 'sunlightFraction(']) ok(!globe.includes(f) && !rd('js/seafloor/stage.js').toString().includes(f), `globe.js / stage.js never call ${f}`);
}
// ── 8. plates, slabs and the bending plate ──────────────────────────────────
console.log('8. trench-model.js (Bird PB2002 + USGS Slab2 + the elastic-plate fit)');
{
    // the universal profile's identities
    near(TM.flexureShape(0), 0, 1e-15, 'w(x0) = 0'); near(TM.flexureShape(1), 1, 1e-12, 'w(x_b) = w_b');
    let top = 0, at = 0; for (let xi = 0; xi < 6; xi += 1e-3) { const w = TM.flexureShape(xi); if (w > top) { top = w; at = xi; } }
    ok(Math.abs(at - 1) < 2e-3 && top <= 1 + 1e-9, 'and x_b is where the rise is highest');
    ok(TM.flexureShape(-0.5) < -0.9 && Math.abs(TM.flexureShape(4)) < 1e-12 && TM.flexureShape(5) < 0 && TM.flexureShape(5) > -0.06, 'trench side goes down; a faint trough follows the rise');
    // elastic thickness: closed form, and its scaling
    const el = TM.elasticFromRise(0, 55), K = TM.ELASTIC, aM = 4 * 55e3 / Math.PI;
    near(el.alphaKm, 220 / Math.PI, 1e-9, 'α = 4(x_b − x0)/π'); near(el.D, aM ** 4 * (K.rhoMantle - K.rhoWater) * K.g / 4, el.D * 1e-12, 'D = α⁴Δρg/4');
    near(el.teKm, Math.cbrt(12 * (1 - K.nu ** 2) * el.D / K.E) / 1000, 1e-9, 'T_e closed form'); ok(el.teKm > 20 && el.teKm < 35, `a 55 km rise distance is a ${el.teKm.toFixed(1)} km plate`);
    near(TM.elasticFromRise(0, 110).teKm / el.teKm, 2 ** (4 / 3), 1e-9, 'T_e ∝ (rise distance)^(4/3)');
    // the fit recovers a PLANTED plate through noise
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
    const truth = { x0: 24, xb: 78, wb: 420 }, synth = [];
    for (let x = 0; x <= 520; x += 2) synth.push({ x, depth: 5800 - TM.flexureHeight(x, truth) + 60 * rnd() });
    const f = TM.fitFlexure(synth);
    ok(f.quality === 'good' && Math.abs(f.x0 - 24) <= 2 && Math.abs(f.xb - 78) <= 4 && Math.abs(f.wb - 420) < 30 && Math.abs(f.dRef - 5800) < 20, `planted plate recovered: x0 ${f.x0}, x_b ${f.xb}, w_b ${f.wb.toFixed(0)} m, level ${f.dRef.toFixed(0)} m`);
    ok(f.rms < 25 && f.lineRms > 5 * f.rms && f.flatRms > 5 * f.rms, `CONTROLS on the same points: a straight slope (${f.lineRms.toFixed(0)} m) and a flat floor (${f.flatRms.toFixed(0)} m) against ${f.rms.toFixed(0)} m`);
    near(f.elastic.teKm, TM.elasticFromRise(f.x0, f.xb).teKm, 1e-12, 'its thickness is the fitted lengths\' own');
    // NEGATIVE CONTROLS: sea floors with no bending plate must not get a thickness
    const slope = synth.map((p) => ({ x: p.x, depth: 5000 + 6 * p.x + 60 * rnd() })), flat = synth.map((p) => ({ x: p.x, depth: 5800 + 60 * rnd() }));
    const fs1 = TM.fitFlexure(slope), ff = TM.fitFlexure(flat);
    ok((!fs1 || fs1.quality === 'poor') && (!ff || ff.quality === 'poor'), `NEGATIVE CONTROL: a plain slope and a flat floor are rejected (${fs1 ? fs1.reasons[0] : 'no fit'}; ${ff ? ff.reasons[0] : 'no fit'})`);
    const seamount = synth.map((p) => ({ x: p.x, depth: p.depth - (p.x > 150 ? 900 : 0) }));
    { const fm = TM.fitFlexure(seamount); ok(fm.quality === 'poor', `NEGATIVE CONTROL: the same plate with a 900 m shoal beyond the rise is rejected (${fm.reasons.join(', ')})`); }
    // WHY THE SLOPE TERM NEEDS THE LONG WINDOW (measured): on 250 km a slope trades off against the rise, on 520 km it cannot
    { const teTrue = TM.elasticFromRise(24, 78).teKm; let worstShort = 0, worstLong = 0, worstLevel = 0;
      for (const sd of [7, 11, 23, 99, 1234]) { let q = sd; const r2 = () => { q = (q * 1664525 + 1013904223) >>> 0; return q / 2 ** 32 - 0.5; };
        const long = []; for (let x = 0; x <= 520; x += 2) long.push({ x, depth: 5800 - TM.flexureHeight(x, truth) + 60 * r2() });
        const short = long.filter((p) => p.x <= 250), e = (prof, o) => Math.abs(TM.fitFlexure(prof, { stability: 0, ...o }).elastic.teKm - teTrue) / teTrue;
        worstShort = Math.max(worstShort, e(short, {})); worstLong = Math.max(worstLong, e(long, {})); worstLevel = Math.max(worstLevel, e(short, { slope: false })); }
      ok(worstLong < 0.02 && worstLevel < 0.02 && worstShort > 0.04 && worstShort < 0.25, `five noise draws of one level plate: T_e off by up to ${(100 * worstShort).toFixed(0)} % with a slope fitted on 250 km, ${(100 * worstLong).toFixed(1)} % on 520 km (level-floor fit on 250 km: ${(100 * worstLevel).toFixed(1)} %)`); }
    ok(TM.fitFlexure(synth.filter((p) => p.x <= 90)) === null, 'a profile that stops 90 km out is not fitted at all');
    ok(f.stability.ok && Math.abs(f.slope) < 0.15 && f.teRange[1] <= f.teRange[0] * 1.25, `a level plate: fitted slope ${f.slope.toFixed(2)} m/km, and the thickness holds on three quarters of the profile`);
    // THE REGIONAL SLOPE: a TILTED plate on a long profile. The slope is recovered with the rise…
    const tilt = { x0: 30, xb: 84, wb: 300 }, tilted = [];
    for (let x = 0; x <= 520; x += 2) tilted.push({ x, depth: 5600 + 1.1 * x - TM.flexureHeight(x, tilt) + 60 * rnd() });
    const ft = TM.fitFlexure(tilted), te0 = TM.elasticFromRise(tilt.x0, tilt.xb).teKm;
    ok(ft.quality === 'good' && Math.abs(ft.slope - 1.1) < 0.1 && Math.abs(ft.wb - 300) < 40 && Math.abs(ft.elastic.teKm - te0) < 0.15 * te0, `tilted plate recovered: slope ${ft.slope.toFixed(2)} m/km (planted 1.10), rise ${ft.wb.toFixed(0)} m, T_e ${ft.elastic.teKm.toFixed(1)} km (planted ${te0.toFixed(1)})`);
    near(TM.flexureReference(100, ft), ft.dRef + 100 * ft.slope, 1e-9, 'the reference is the level plus the slope');
    // …and WITHOUT it the level-floor law (shipped first) pays for the tilt with a wrong rise
    const fl = TM.fitFlexure(tilted, { slope: false });
    ok(fl.slope === 0 && (fl.quality === 'poor' || Math.abs(fl.elastic.teKm - te0) > 0.3 * te0) && fl.rms > 2 * ft.rms, `NEGATIVE CONTROL: the level-floor fit of the same plate is ${fl.quality} — T_e ${fl.elastic.teKm.toFixed(1)} km, misfit ${fl.rms.toFixed(0)} m against ${ft.rms.toFixed(0)} m`);
    { const steep = tilted.map((p) => ({ x: p.x, depth: p.depth + 4 * p.x })); ok(TM.fitFlexure(steep).reasons.includes('slope-implausible'), 'a slope steeper than a cooling plate\'s is refused'); }
    { const kink = tilted.map((p) => ({ x: p.x, depth: p.depth + (p.x > 400 ? 6 * (p.x - 400) : 0) })), fk = TM.fitFlexure(kink); ok(fk.quality === 'poor', `a profile whose far quarter bends away is rejected (${fk.reasons.join(', ')})`); }
    ok(TM.fitFlexure(tilted, { stability: 0 }).stability === null, 'the reach test can be switched off (A/B)');
    // SEAMOUNTS: masked one-sidedly, by rule, and never on the trench wall
    { const mount = (x, c, h, w) => h * Math.exp(-(((x - c) / w) ** 2)), te1 = TM.elasticFromRise(30, 84).teKm;
      const mk = (fn) => tilted.map((p) => ({ x: p.x, depth: p.depth - fn(p.x) }));
      ok(ft.maskedKm === 0 && ft.masked.length === 0, 'a clean plate: nothing is masked, so the mask cannot bias it');
      const two = mk((x) => mount(x, 140, 900, 12) + mount(x, 330, 600, 10)), fm = TM.fitFlexure(two), fu = TM.fitFlexure(two, { mask: false });
      ok(fm.quality === 'good' && Math.abs(fm.elastic.teKm - te1) < 0.05 * te1 && Math.abs(fm.wb - 300) < 30 && fm.masked.length === 2 && fm.masked[0].x0 < 140 && fm.masked[0].x1 > 140 && fm.masked[1].x0 < 330 && fm.masked[1].x1 > 330, `two planted seamounts are found (${fm.masked.map((r) => `${r.x0}–${r.x1} km`).join(', ')}) and the plate recovered: T_e ${fm.elastic.teKm.toFixed(1)} km, rise ${fm.wb.toFixed(0)} m`);
      ok(fu.quality === 'poor' && fu.rms > 5 * fm.rms && fu.maskedKm === 0, `NEGATIVE CONTROL: unmasked, the same profile is rejected (${fu.reasons.join(', ')}; T_e ${fu.elastic.teKm.toFixed(1)} km, misfit ${fu.rms.toFixed(0)} m against ${fm.rms.toFixed(0)} m)`);
      const three = TM.fitFlexure(mk((x) => mount(x, 140, 900, 12) + mount(x, 260, 600, 10) + mount(x, 410, 1200, 14)));
      ok(three.reasons.includes('too-much-masked') && three.quality === 'poor', 'a profile that is a fifth seamounts is refused, not cleaned until it fits');
      const bare = tilted.map((p) => ({ x: p.x, depth: 5600 + 1.1 * p.x + 60 * rnd() - mount(p.x, 140, 900, 12) - mount(p.x, 330, 600, 10) })), fb = TM.fitFlexure(bare);
      ok(fb.quality === 'poor', `NEGATIVE CONTROL: seamounts on a plate with NO bend do not become a rise (${fb.reasons.slice(0, 2).join(', ')})`);
      const wall = TM.fitFlexure(mk((x) => mount(x, 14, 500, 5) + mount(x, 330, 600, 10)));
      ok(wall.masked.length >= 1 && wall.masked.every((r) => r.x0 >= wall.x0), `a block on the trench wall (14 km) is NOT masked; the seamount at 330 km is (${wall.masked.map((r) => `${r.x0}–${r.x1}`).join(', ')})`);
      const plateau = TM.fitFlexure(mk((x) => (x > 200 && x < 330 ? 800 : 0)));
      ok(plateau.maskedKm === 0 && plateau.quality === 'poor', 'a 130 km plateau is too wide to be a seamount: not masked, and the fit is rejected'); }
    // ALONG THE TRENCH: a synthetic north–south trench of ONE plate — every station must find the same plate
    { const lon0 = 0.6, step = 2 / 60, nx = 331, ny = 301, north = 5, west = -5.5, z = new Int16Array(nx * ny), pl = { x0: 30, xb: 84, wb: 300 };
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const lat = north - j * step, lon = west + i * step, xk = (lon - lon0) * 111.19 * Math.cos(lat * Math.PI / 180);
          z[j * nx + i] = -Math.round(xk >= 0 ? 5600 + 0.6 * xk - TM.flexureHeight(xk, pl) : 5600 - TM.flexureHeight(0, pl) + 30 * xk) ; }
      const g = BA.makeGrid({ id: 'synthetic', nx, ny, north, west, step_deg: step }, z);
      const al = TM.alongTrench({ wide: g, lat: 0, lon: lon0, axisDeg: 0, acrossDeg: 90, seaward: +1 }), te1 = TM.elasticFromRise(30, 84).teKm;
      ok(al.stations.length === 5 && al.stations.map((q) => q.offsetKm).join() === '-160,-80,0,80,160' && al.spanKm === 320, 'five stations, 80 km apart');
      ok(al.stations.every((q) => Math.abs(q.lon - lon0) < 0.06 && Math.abs(q.lat - q.offsetKm / 111.19) < 0.08), 'each station sits back on the trench, 80 km further along it');
      ok(al.good === 5 && al.quotable && al.stations.every((q) => Math.abs(q.flexure.elastic.teKm - te1) < 0.1 * te1) && al.teMax / al.teMin < 1.15, `one plate, five answers: ${al.stations.map((q) => q.flexure.elastic.teKm.toFixed(1)).join(', ')} km (planted ${te1.toFixed(1)})`);
      ok(TM.quotedThickness({ along: al, flexure: al.stations[2].flexure }).good === 5 && TM.quotedThickness({ along: { ...al, quotable: false }, flexure: al.stations[2].flexure }) === null && TM.quotedThickness(null) === null, 'the quoting rule: stations when there are stations, and nothing when too few pass'); }

    // real data: Bird's plates and Slab2 at the baked sites
    const gz = (p) => JSON.parse(zlib.gunzipSync(rd(p)).toString());
    const plates = decodePlates(gz('data/earth-interior/plates-pb2002.json.gz')), slabs = decodeSlabs(gz('data/earth-interior/slab2.json.gz'));
    const wides = new Map();
    for (const m of index.sites) { const site = SEAFLOOR_SITES.find((s) => s.id === m.id);
        ok(!!m.wide === (site.kind === 'trench'), `${m.id}: a wide window exactly for a trench`);
        if (!m.wide) continue;
        const raw = rd('data/seafloor/' + m.wide.file), g = BA.makeGrid(m.wide, BA.int16FromBytes(zlib.gunzipSync(raw))); wides.set(m.id, g);
        ok(raw.length === m.wide.bytes && g.nx === m.wide.nx && m.wide.step_deg > m.step_deg && m.wide.north - (m.wide.ny - 1) * m.wide.step_deg < m.north - (m.ny - 1) * m.step_deg - 2.5, `${m.id}: wide window is coarser and reaches > 2.5° further`);
        const d = m.deepest, dw = BA.sampleDepth(g, d.lat, d.lon); ok(dw != null && Math.abs(dw - d.depth_m) < 0.12 * d.depth_m, `${m.id}: the wide grid is the same sea floor (${Math.round(dw)} m vs ${d.depth_m} m at the deepest cell)`);
    }
    const model = (id, extra = {}) => { const site = SEAFLOOR_SITES.find((s) => s.id === id), meta = index.sites.find((m) => m.id === id), g = grids.get(id);
        const detail = PM.siteDetail({ site, meta, grid: g, casts: casts.sites[id] ? casts.sites[id].casts : [] }); return TM.trenchModel({ plates, slabs, grid: g, detail, wide: wides.get(id) || null, ...extra }); };
    const tonga = model('tonga'), ts = tonga.setting;
    ok(ts.family === 'subduction' && ts.down.name === 'Pacific' && ts.over.name === 'Tonga' && ts.closing > 90 && ts.closing < 125 && ts.obliquityDeg < 15, `Tonga: Pacific under Tonga at ${ts.closing.toFixed(0)} mm/yr, nearly head-on`);
    near(Math.hypot(ts.closing, ts.along), ts.speed, 1e-9, 'closing² + sliding² = speed²');
    const jp = model('japan');
    ok(jp.setting.down.name === 'Pacific' && jp.setting.closing > 75 && jp.setting.closing < 105 && jp.slab.code === 'kur' && jp.slab.dipDeg > 15 && jp.slab.dipDeg < 40, `Japan: ${jp.setting.closing.toFixed(0)} mm/yr, slab dips ${jp.slab.dipDeg.toFixed(0)}° at 100 km`);
    const mar = model('mariana');
    ok(mar.slab.code === 'izu' && mar.slab.dipDeg > jp.slab.dipDeg + 15, `the Mariana slab is far steeper (${mar.slab.dipDeg.toFixed(0)}°) than Japan's`);
    ok(mar.slab.profile.every((p, i, a) => p.depthKm == null || i === 0 || a[i - 1].depthKm == null || p.x < a[i - 1].x || p.x > a[i - 1].x), 'slab profile is ordered');
    const deepening = jp.slab.profile.filter((p) => p.depthKm != null); ok(deepening.length > 20 && deepening.every((p) => p.x <= 0), 'the slab lies LANDWARD of the trench (x ≤ 0), never under the incoming plate');
    // the seaward side comes from the plate raster
    for (const t of [tonga, jp, mar]) { const p = t.profile.filter((q) => q.depth != null && q.x > 60); ok(p.length > 20 && t.seawardSign !== 0, 'a seaward profile exists'); }
    const izu = model('izu-bonin'), kur = model('kuril'), alu = model('aleutian'), java = model('java'), hel = model('hellenic');
    for (const [nm, t, lo, hi] of [['Izu–Bonin', izu, 9, 17], ['Kuril', kur, 9, 17], ['Aleutian', alu, 20, 36]]) { const f = t.flexure;
        ok(f.quality === 'good' && f.elastic.teKm > lo && f.elastic.teKm < hi && f.wb > 100 && f.wb < 900 && Math.abs(f.slope) < 1.5 && f.stability.ok && f.reachKm > 450, `${nm}: rise ${f.wb.toFixed(0)} m at ${f.xb} km on a ${f.slope.toFixed(2)} m/km slope, T_e ${f.elastic.teKm.toFixed(1)} km (${f.teRange.map((v) => v.toFixed(1)).join('–')} with the reach), over ${f.reachKm.toFixed(0)} km`); }
    ok(izu.profile.some((q) => q.src === 'wide' && q.x > 300 && q.depth != null) && izu.profile.some((q) => q.src === 'fine' && q.x > 0 && q.x < 150), 'the profile is the fine grid near the trench and the wide grid beyond it');
    // WHAT THE SLOPE TERM BUYS, on real sea floor: the level-floor thickness grows with the length of profile used, the sloped one does not
    for (const [nm, t] of [['Izu–Bonin', izu], ['Kuril', kur]]) {
        const cut = t.profile.filter((q) => q.x <= 220), o = { stability: 0 }, te = (prof, slope) => TM.fitFlexure(prof, { ...o, slope }).elastic.teKm;
        const s1 = te(cut, true), s2 = te(t.profile, true), l1 = te(cut, false), l2 = te(t.profile, false);
        ok(Math.max(s1, s2) / Math.min(s1, s2) < 1.25 && l2 / l1 > 1.5, `${nm}: 220 km → 520 km of profile moves T_e ${s1.toFixed(1)} → ${s2.toFixed(1)} km with the slope fitted, ${l1.toFixed(1)} → ${l2.toFixed(1)} km on a level floor (NEGATIVE CONTROL)`); }
    ok(model('kuril', { wide: null }).why === 'profile-too-short' && model('izu-bonin', { wide: null }).flexure.reachKm < 260, 'without the wide window the Kuril profile is too short to fit at all');
    ok(java.flexure.quality === 'poor' && hel.flexure.quality === 'poor', `RECORDED: Java (${java.flexure.reasons.join(', ')}) and Hellenic (${hel.flexure.reasons.join(', ')}) passed only on a level floor and the short window; they no longer do`);
    ok(mar.flexure.quality === 'poor' && tonga.flexure.quality === 'poor' && jp.flexure.quality === 'poor', `RECORDED, not tuned: Mariana (${mar.flexure.reasons.join(', ')}), Tonga (${tonga.flexure.reasons.join(', ')}) and Japan (${jp.flexure.reasons.join(', ')}) are rejected`);
    let good = 0, sub = 0, stGood = 0, stAll = 0, stGoodU = 0; const quoted = [], quotedU = [];
    for (const s of SEAFLOOR_SITES) { const t = model(s.id); if (!(t.setting.near && t.setting.family === 'subduction')) { ok(!t.flexure || t.flexure.quality !== 'good' || false, `${s.id}: no thickness away from a subduction zone`); continue; }
        sub++; if (t.flexure && t.flexure.quality === 'good') good++;
        if (!t.along) continue;
        const u = model(s.id, { fit: { mask: false } }), q = TM.quotedThickness(t);
        stAll += t.along.stations.length; stGood += t.along.good; stGoodU += u.along.good;
        if (q) quoted.push(`${s.id} ${q.teKm.toFixed(0)} (${q.teMin.toFixed(0)}–${q.teMax.toFixed(0)}, ${q.good}/${q.of})`); if (TM.quotedThickness(u)) quotedU.push(s.id);
        for (const st of t.along.stations) if (st.flexure) ok(st.flexure.masked.every((r) => r.x0 >= st.flexure.x0) && st.flexure.maskedShare <= TM.MASK.maxShare + 1e-9, `${s.id} ${st.offsetKm}: nothing masked on the trench wall, and no more than a fifth`);
        const st = t.along.stations; for (let k = 1; k < st.length; k++) { const d = BA.distanceKm(st[k - 1].lat, st[k - 1].lon, st[k].lat, st[k].lon); ok(d > 50 && d < 115, `${s.id}: stations ${st[k - 1].offsetKm} and ${st[k].offsetKm} are ${d.toFixed(0)} km apart along the trench`); } }
    ok(sub === 15 && good === 3, `${good} of ${sub} centre sections pass`);
    ok(stAll === 75 && stGood === 25 && stGoodU === 22, `along the trenches ${stGood} of ${stAll} sections pass (${stGoodU} with the mask off)`);
    ok(quoted.length === 4 && ['kuril', 'japan', 'aleutian', 'middle-america'].every((id) => quoted.some((q) => q.startsWith(id + ' '))), `QUOTED: ${quoted.join('; ')}`);
    ok(quotedU.join() === 'kuril,aleutian,middle-america', `mask off (A/B): ${quotedU.join(', ')} — Japan is the one site the mask adds`);
    { const qi = TM.quotedThickness(izu), qt = TM.quotedThickness(tonga); ok(qi === null && qt === null && izu.along.good === 2 && tonga.along.good === 2 && izu.flexure.quality === 'good', 'RECORDED: Izu–Bonin gives a clean centre section but passes at only 2 of 5 stations — not quoted; nor is Tonga'); }
    { const lone = model('izu-bonin', { wide: null }), q1 = TM.quotedThickness(lone); ok(lone.along === null && q1 && q1.single && q1.of === 1, 'without the wide window there are no stations: one section, flagged `single`'); }
    { const jq = TM.quotedThickness(jp), mq = TM.quotedThickness(model('middle-america')); ok(mq.teKm < 9 && jq.teKm > 14 && jq.teMax / jq.teMin > 1.8 && jp.setting.ageMa > 100, `a young plate reads thin (Middle America ${mq.teKm.toFixed(0)} km) and an old one thicker and far less certain (Japan ${jq.teKm.toFixed(0)} km, ${jq.teMin.toFixed(0)}–${jq.teMax.toFixed(0)})`); }
    // ── AGAINST THE LITERATURE (trench-literature.js: Garcia et al. 2019 Table 2, Zhang et al. 2018 Table 3) ──
    { const Z = LIT.ZHANG_2018, Gc = LIT.GARCIA_2019;
      ok(Z.rows.length === 28 && Gc.rows.length === 26 && Z.verified && Gc.verified, 'both published tables are transcribed in full');
      // transcription checks that need no second copy of the paper: Zhang PRINTS the Te reduction, which is 1 − Tem/TeM of the same row…
      let worst = 0; for (const r of Z.rows) worst = Math.max(worst, Math.abs(100 * (1 - r.temKm / r.teMKm) - r.reductionPct));
      ok(worst < 1.6, `Zhang's printed "Te reduction" is reproduced from the transcribed TeM and Tem in all 28 rows (worst ${worst.toFixed(1)} points)`);
      const red = Z.rows.map((r) => r.reductionPct); ok(Math.min(...red) >= 20 && Math.max(...red) <= 70 && Math.abs(red.reduce((a, b) => a + b, 0) / red.length - Z.teReductionPct.mean) < 1.5, 'and matches the paper\'s own summary: 20–70 %, mean 47 %');
      // …and Garcia's table is printed in order of sea-floor age
      ok(Gc.rows.every((r, i) => i === 0 || r.ageMa >= Gc.rows[i - 1].ageMa) && Gc.rows[0].id === 'MD01' && Gc.rows[25].id === 'MA01' && Gc.rows.every((r) => r.teKm > 3 && r.teKm < 23), 'Garcia\'s rows are in the printed age order, 3.3–21.9 km');
      for (const k of ['E', 'nu', 'rhoWater', 'rhoMantle', 'g']) ok(Z.constants[k] === TM.ELASTIC[k], `our ${k} is the published study's`);
      ok(LIT.publishedFor(29.8, -151.6, 'ne-pacific').garcia === null && LIT.compareWithPublished(null, null, LIT.publishedFor(29.8, -151.6, 'ne-pacific')) === null, 'nothing is published for an abyssal plain, and nothing is shown');
      // the comparison at the four quoted trenches
      const rowsOut = [];
      for (const id of ['middle-america', 'kuril', 'japan', 'aleutian']) { const t = model(id), q = TM.quotedThickness(t), d = PM.siteDetail({ site: SEAFLOOR_SITES.find((x) => x.id === id), meta: index.sites.find((m) => m.id === id), grid: grids.get(id), casts: [] });
          const c = LIT.compareWithPublished(t, q, LIT.publishedFor(d.point.lat, d.point.lon, id));
          ok(c.garcia && c.zhang && c.inside === true, `${id}: ${q.teKm.toFixed(1)} km against Garcia ${c.garcia.teKm} (${c.garcia.id}, ${c.garcia.km.toFixed(0)} km away) and Zhang ${c.zhang.temKm.min}–${c.zhang.temKm.max} — inside the published range`);
          ok(c.unbentKm.min > q.teKm * 0.95 && c.unbentKm.max > 1.5 * q.teKm, `${id}: the published UNBENT plate (${c.unbentKm.min}–${c.unbentKm.max} km) is thicker than our bent-plate value — a single-thickness fit measures the weakened plate`);
          ok(c.x0Km.min <= c.zhang.x0Km.max + 25 && c.x0Km.max >= c.zhang.x0Km.min - 25, `${id}: zero crossing ${c.x0Km.min}–${c.x0Km.max} km against the published ${c.zhang.x0Km.min}–${c.zhang.x0Km.max}`);
          rowsOut.push([id, c]); }
      const C = Object.fromEntries(rowsOut);
      for (const id of ['middle-america', 'kuril', 'japan']) ok(C[id].wbKm.min <= C[id].zhang.wbKm.max * 1.25 && C[id].wbKm.max >= C[id].zhang.wbKm.min * 0.8, `${id}: outer rise ${(1000 * C[id].wbKm.min).toFixed(0)}–${(1000 * C[id].wbKm.max).toFixed(0)} m against the published ${1000 * C[id].zhang.wbKm.min}–${1000 * C[id].zhang.wbKm.max} m`);
      ok(C.aleutian.wbKm.min > 1.1 * C.aleutian.zhang.wbKm.max, `RECORDED, unexplained: the Aleutian outer rise reads ${(1000 * C.aleutian.wbKm.min).toFixed(0)}–${(1000 * C.aleutian.wbKm.max).toFixed(0)} m here against the published ${1000 * C.aleutian.zhang.wbKm.min}–${1000 * C.aleutian.zhang.wbKm.max} m`);
      // the two published studies disagree with each other by more than our fit disagrees with either
      const spread = rowsOut.map(([, c]) => c.bracket.hi / c.bracket.lo); ok(Math.max(...spread) > 1.9 && Math.min(...spread) > 1.2, `the published near-trench values themselves span a factor of ${Math.min(...spread).toFixed(1)}–${Math.max(...spread).toFixed(1)} at these trenches`);
      // sea-floor age, which Bird's table lacks at most sites, now comes with the comparison
      ok(Math.abs(C['middle-america'].ageMa - 22.73) < 1e-9 && C.kuril.ageMa > 110 && C.aleutian.ageMa > 50 && C.aleutian.ageMa < 60, 'sea-floor age from the published table: Middle America 23 Ma, Aleutian 54 Ma, Kuril 119 Ma');
      ok(TM.quotedThickness(model('middle-america')).teKm < TM.quotedThickness(model('aleutian')).teKm && C['middle-america'].ageMa < C.aleutian.ageMa, 'and the youngest quoted plate is the thinnest');
      const lit = rd('js/seafloor/trench-literature.js').toString(), tmSrc = rd('js/seafloor/trench-model.js').toString();
      ok(!/^import[^\n]*trench-literature/m.test(tmSrc) && !/from '\.\/trench-model/.test(lit), 'the model never reads the published numbers (they check it; they are not an input)'); }
    // what is NOT a trench
    const rom = model('romanche'), nep = model('ne-pacific');
    ok(rom.why === 'not-subduction' && rom.flexure === null && rom.slab === null && rom.setting.family === 'sliding', 'Romanche: a transform fault — no bending plate, no slab');
    ok(nep.why === 'mid-plate' && !nep.setting.near && nep.flexure === null && TM.motionLabel(nep.setting).text === 'mid-plate', 'an abyssal plain is mid-plate');
    ok(/closing$/.test(TM.motionLabel(ts).text) && /sliding$/.test(TM.motionLabel(rom.setting).text), 'motion labels');
    ok(model('tonga', { slabs: null }).slab === null && model('tonga', { slabs: null }).flexure !== null, 'no slab model ⇒ no slab, and the bending fit still stands');
    const segs = TM.boundarySegments(plates); ok(segs.length === plates.steps.length && segs.every((g) => TM.FAMILY_STYLE[g.family]), `${segs.length} boundary steps, each in a drawn family`);
    // ── the two-thickness plate (broken-plate.js): exact solution, planted recovery, real stations ──
    { const K = TM.ELASTIC, drho = (K.rhoMantle - K.rhoWater) * K.g;
      // the uniform case IS the closed form e^(−u)(c₁ cos u + c₂ sin u): moment w_uu(0)=1 ⇒ c₂ = −½, c₁ = ½; shear w_uuu(0)=1 ⇒ c₂ = 0, c₁ = ½
      for (const te of [5, 20, 60]) { const sol = BP.brokenSolution(te, te, 70), a = BP.plateOf(te).alphaKm; let e = 0;
          for (let x = 0; x <= 600; x += 3) { const u = x / a, [g1, g2] = BP.brokenResponse(sol, x); e = Math.max(e, Math.abs(g1 - Math.exp(-u) * 0.5 * (Math.cos(u) - Math.sin(u))), Math.abs(g2 - Math.exp(-u) * 0.5 * Math.cos(u))); }
          ok(e < 1e-12, `uniform ${te} km plate: the broken solution IS the closed form (${e.toExponential(1)})`); }
      near(BP.plateOf(20).alphaKm, TM.elasticFromRise(0, Math.PI / 4 * BP.plateOf(20).alphaKm).alphaKm, 1e-9, 'one rigidity law: plateOf ≡ elasticFromRise inverted');
      near(TM.elasticFromRise(0, Math.PI / 4 * BP.plateOf(20).alphaKm).teKm, 20, 1e-9, 'and it returns the same thickness');
      // the six conditions and the plate equation, checked from the analytic derivatives (not from the solve)
      for (const [m1, M1, r] of [[8, 40, 50], [15, 60, 120], [5, 9, 20]]) { const sol = BP.brokenSolution(m1, M1, r), D1 = BP.plateOf(m1).D, D2 = BP.plateOf(M1).D;
          for (let j = 0; j < 2; j++) { const d = (x, k) => BP.brokenDerivative(sol, x, k)[j];
              near(d(0, 2) * sol.a1 ** 2, j === 0 ? 1 : 0, 1e-10, 'axis moment condition'); near(d(0, 3) * sol.a1 ** 3, j === 1 ? 1 : 0, 1e-10, 'axis shear condition');
              const L = r - 1e-9, R = r + 1e-9, sc = [1, 1 / sol.a1, 1 / sol.a1 ** 2, 1 / sol.a1 ** 3];
              near(d(L, 0), d(R, 0), 1e-9 * sc[0], 'w continuous at the break'); near(d(L, 1), d(R, 1), 1e-9 * sc[1], 'slope continuous at the break');
              near(D1 * d(L, 2), D2 * d(R, 2), 1e-8 * D1 * sc[2], 'moment continuous'); near(D1 * d(L, 3), D2 * d(R, 3), 1e-8 * D1 * sc[3], 'shear continuous');
              for (const x of [0.4 * r, 0.9 * r, r + 30, r + 200]) { const D = x <= r ? D1 : D2, lhs = D * d(x, 4) * 1e-12 + drho * d(x, 0);   // 4th derivative per km⁴ → per m⁴
                  ok(Math.abs(lhs) <= 1e-9 * drho * Math.max(Math.abs(d(x, 0)), 1e-6 * Math.abs(d(0, 0))), `the plate equation D·w⁗ + Δρ·g·w = 0 holds at ${x} km`); } } }
      // planted plates on a 2 km lattice with seeded, correlated 'bathymetric' noise
      const noise = (seed, nn, amp) => { let q = seed >>> 0; const r = () => ((q = (1664525 * q + 1013904223) >>> 0) / 2 ** 32) - 0.5, w = Array.from({ length: nn + 5 }, r); return Array.from({ length: nn }, (_, i) => amp * (w[i] + w[i + 1] + w[i + 2] + w[i + 3] + w[i + 4]) / 1.29); };
      const planted = (tem, teM, xr) => { const sol = BP.brokenSolution(tem, teM, xr), [m0, v0] = BP.brokenResponse(sol, 0), b2 = 4000 / (1.5 * v0), b1 = 0.5 * b2 * v0 / m0, nz = noise(7, 261, 30);
          return Array.from({ length: 261 }, (_, i) => ({ x: 2 * i, depth: 5500 + 0.3 * 2 * i - BP.brokenHeight({ sol, b1, b2 }, 2 * i) + nz[i] })); };
      const has = (iv, v) => iv && v >= iv[0] / BP.GRID.teRatio && v <= iv[1] * BP.GRID.teRatio;   // to within one step of the thickness ladder
      for (const [m1, M1, r] of [[12, 40, 60], [8, 30, 40]]) { const f = BP.fitBrokenPlate(planted(m1, M1, r)), one = TM.fitFlexure(planted(m1, M1, r), { mask: false });
          ok(f.needed && f.reasons.length === 0 && has(f.intervals.tem, m1) && has(f.intervals.teM, M1) && f.xrKm === r, `planted ${m1}/${M1} km, break ${r} km: recovered ${f.temKm.toFixed(1)} [${f.intervals.tem.slice(0, 2).map((v) => v.toFixed(0))}] / ${f.teMKm.toFixed(1)} [${f.intervals.teM.slice(0, 2).map((v) => v.toFixed(0))}], break ${f.xrKm}, Δχ² ${f.dChi2.toFixed(0)}`);
          ok(one.elastic.teKm < M1 / 2, `and one thickness reads that plate as ${one.elastic.teKm.toFixed(1)} km — nearer the weak plate than the strong one`); }
      { const f = BP.fitBrokenPlate(planted(20, 20, 60)); ok(!f.needed && f.reasons.includes('one-thickness-is-enough') && has(f.intervals.teM, 20) && Math.abs(f.uniform.teKm - 20) < 0.1 * 20, `NEGATIVE CONTROL: a planted uniform 20 km plate needs no second thickness (Δχ² ${f.dChi2.toFixed(1)})`); }
      { const p = planted(12, 40, 60), lat = BP.fitBrokenPlate(p), off = BP.fitBrokenPlate(p.map((q) => ({ ...q, x: q.x + 1e-4 })));
        near(lat.ss, off.ss, 1e-3 * lat.ss, 'the lattice tables give the same fit as direct evaluation'); }
      // REAL stations (MEASURED 2026-11-23): on the same grid the uniform plate reproduces the one-thickness fit,
      // a second thickness is significantly better at 28 of 72 sections, both thicknesses are pinned at 8.
      // 'Same' is to within the coarser of the two grids (T_e ∝ (x_b − x₀)^(4/3) on the one-thickness fit's 2 km step).
      let fitted = 0, needed = 0, accepted = 0, same = 0, oneGood = 0; const quoted = [], acc = [];
      for (const id of SEAFLOOR_SITES.filter((q) => q.kind === 'trench').map((q) => q.id)) { const t = model(id); if (!t.profile) continue; const two = BP.twoThickness(t);
          fitted += two.fitted; needed += two.needed; accepted += two.accepted; if (two.quotable) quoted.push(id);
          for (const sec of t.along.stations) { const st = two.stations.find((o) => o.offsetKm === sec.offsetKm);
              if (st.fit && sec.flexure && sec.flexure.quality === 'good') { oneGood++; if (Math.abs(st.fit.uniform.rms - sec.flexure.rms) <= 0.02 * sec.flexure.rms && Math.abs(st.fit.uniform.teKm / sec.flexure.elastic.teKm - 1) <= Math.max(BP.GRID.teRatio - 1, (4 / 3) * 2 / (sec.flexure.xb - sec.flexure.x0)) + 0.01) same++; }
              if (st.fit && st.fit.accepted) acc.push({ id, off: sec.offsetKm, fit: st.fit, c: LIT.compareTwoThickness(st.fit, LIT.publishedFor(sec.lat, sec.lon, id)) }); } }
      ok(same === oneGood && oneGood >= 20, `the uniform plate on the two-thickness grid IS the one-thickness fit at all ${oneGood} passing sections (misfit within 2 %, thickness within the coarser grid step)`);
      ok(fitted === 72 && needed === 28 && accepted === 8, `two thicknesses: needed at ${needed} of ${fitted} sections, both pinned at ${accepted} (measured 28 / 72 / 8)`);
      ok(quoted.join() === 'middle-america', `only Middle America has three accepted sections (${quoted.join(', ')})`);
      const agree = acc.filter((a) => a.c && a.c.temInside && a.c.teMInside && a.c.xrInside).map((a) => `${a.id}${a.off}`);
      ok(acc.every((a) => a.c) && agree.join() === 'tonga-80,tonga0,izu-bonin160,middle-america80', `against Zhang et al. 2018 the published T_em, T_eM and break all fall inside ours at ${agree.length} of ${acc.length} accepted sections (${agree.join(', ')}); Kuril, Java and two Middle America sections disagree — recorded`);
      const bp = rd('js/seafloor/broken-plate.js').toString();
      ok(!/^import[^\n]*trench-literature/m.test(bp), 'the two-thickness model never reads the literature either');
      for (const fnc of ['brokenSolution(', 'plateOf(', 'fitBrokenPlate(']) ok(!rd('js/seafloor/page.js').toString().includes(fnc), `page.js never calls ${fnc}`); }
    // ── the sea-floor AGE (Seton et al. 2020) and the two-thickness plate on an age-corrected reference ──
    { // GDH1: the two branches meet at 20 Myr in value AND slope — the internal evidence the remembered coefficients are the published ones
      const M = AG.SUBSIDENCE, t = M.tJoin;
      near(M.d0 + M.a * Math.sqrt(t), M.dInf - M.b * Math.exp(-M.k * t), 2, 'GDH1 branches meet at 20 Myr (value)');
      near(M.a / (2 * Math.sqrt(t)), M.b * M.k * Math.exp(-M.k * t), 2, 'GDH1 branches meet at 20 Myr (slope, m/Myr)');
      ok(AG.subsidenceDepth(0) === 2600 && AG.subsidenceDepth(-1) === null && AG.subsidenceDepth(1000) < M.dInf && AG.subsidenceDepth(150) > AG.subsidenceDepth(100), 'subsidence: ridge depth, refuses a negative age, deepens and flattens toward 5651 m');
      // erf / erf⁻¹ / the isotherm
      near(AG.erf(1), 0.8427007929497149, 1e-15, 'erf(1)'); near(AG.erf(0.5), 0.5204998778130465, 1e-15, 'erf(0.5)'); near(AG.erf(3), 0.9999779095030014, 2e-7, 'erf(3) on the A&S branch');
      for (const y of [-0.9, -0.3, 0.01, 0.444, 0.8, 0.98]) near(AG.erf(AG.erfinv(y)), y, 1e-13, `erf(erfinv(${y}))`);
      near(AG.isothermDepthKm(100, 600) / AG.isothermDepthKm(25, 600), 2, 1e-12, 'a half-space isotherm deepens as √t');
      ok(AG.isothermDepthKm(100, 300) < AG.isothermDepthKm(100, 600) && AG.isothermDepthKm(0, 600) === null && AG.isothermDepthKm(50, 1400) === null, 'isotherms: colder is shallower; no age, or hotter than the mantle, has no depth');
      // a synthetic age window: age = 10 + 0.1·(lat + 90) Myr... bilinear is exact on a planted plane, any no-data corner is no age
      const meta = { id: 'syn', nx: 41, ny: 41, north: 10, west: 170, step_deg: 0.5 }, q = new Int16Array(41 * 41);
      for (let j = 0; j < 41; j++) for (let i = 0; i < 41; i++) q[j * 41 + i] = Math.round(10 * (20 + 2 * (10 - j * 0.5) + 1 * (i * 0.5)));
      const ag = AG.makeAgeGrid(meta, q);
      near(AG.sampleAge(ag, 3.3, 181.7), 20 + 2 * 3.3 + (181.7 - 170), 1e-9, 'bilinear age is exact on a planted plane');
      near(AG.sampleAge(ag, 3.3, -178.3), AG.sampleAge(ag, 3.3, 181.7), 1e-9, 'across the date line the same point has the same age');
      ok(AG.sampleAge(ag, 11, 175) === null && AG.sampleAge(ag, 0, 169) === null, 'outside the window: no age');
      const q2 = q.slice(); q2[20 * 41 + 20] = AG.AGE_NO_DATA; const ag2 = AG.makeAgeGrid(meta, q2);
      ok(AG.sampleAge(ag2, 0.2, 180.2) === null && AG.sampleAge(ag2, 1.2, 181.2) !== null, 'a no-data node voids the four cells around it and nothing else (a continent is never averaged into an age)');
      // profileAges reads under the profile's OWN geometry: a profile running due east from (0, 175) sees the age rise 1 Myr per degree
      const prof = Object.assign(Array.from({ length: 101 }, (_, k) => ({ x: 4 * k, depth: 5000 })), { origin: { lat: 0, lon: 175 }, seaBearingDeg: 90, axisOffsetKm: 0 });
      const pa = AG.profileAges(ag, prof);
      ok(pa.every((a, k) => a != null && Math.abs(a - (20 + 2 * 0 + 5 + 4 * k / 111.195)) < 0.02), 'profile ages follow the profile east (1 Myr per degree)');
      const pw = AG.profileAges(ag, Object.assign(prof.map((p) => ({ ...p })), { origin: { lat: 0, lon: 175 }, seaBearingDeg: 270, axisOffsetKm: 0 }));
      ok(pw[50] < pa[0] && pa[50] > pa[0], 'NEGATIVE CONTROL: the same profile pointed west reads ages falling, not rising');
      // removeSubsidence: a planted plate on a YOUNG, steep age ramp — removed, the level fit recovers it; fitted with a straight line instead it does not
      const young = { id: 'y', nx: 81, ny: 41, north: 5, west: 0, step_deg: 0.1 }, qy = new Int16Array(81 * 41);
      for (let j = 0; j < 41; j++) for (let i = 0; i < 81; i++) qy[j * 81 + i] = Math.round(10 * (0.5 + i * 0.1 * 2.5));    // young and getting older seaward: a curved (√t) subsidence
      const gy = AG.makeAgeGrid(young, qy), plant = { x0: 40, xb: 90, wb: 300 };
      const base = Object.assign(Array.from({ length: 221 }, (_, k) => ({ x: 2 * k, depth: 0 })), { origin: { lat: 3, lon: 0.5 }, seaBearingDeg: 90, axisOffsetKm: 0 });
      const ay = AG.profileAges(gy, base);
      base.forEach((p, k) => { p.depth = AG.subsidenceDepth(ay[k]) + 1500 - TM.flexureHeight(p.x, plant) + 8 * Math.sin(p.x * 1.7); });
      const cy = AG.removeSubsidence(base, ay), fa = TM.fitFlexure(cy, { slope: false, mask: false, stability: 0 }), fl = TM.fitFlexure(base, { mask: false, stability: 0 });
      const te0 = TM.elasticFromRise(40, 90).teKm;
      ok(Math.abs(fa.elastic.teKm - te0) < 0.02 * te0 && cy.subsidenceSlope > 1, `subsidence removed: a planted ${te0.toFixed(1)} km plate on a ${cy.ageRange.map((v) => v.toFixed(0)).join('→')} Myr ramp comes back as ${fa.elastic.teKm.toFixed(1)} km`);
      ok(Math.abs(fl.elastic.teKm - te0) > 0.08 * te0 && fl.rms < 1.3 * fa.rms, `NEGATIVE CONTROL, and the trade-off in miniature: a straight slope fits that curved subsidence nearly as well (${fl.rms.toFixed(1)} vs ${fa.rms.toFixed(1)} m) and reads the plate as ${fl.elastic.teKm.toFixed(1)} km`);
      // the axis hold: ages missing in the first 20 km are held from the first dated point; past AGE_HOLD_KM nothing is held
      const hole = ay.map((a, k) => (base[k].x < 20 ? null : a)), ch = AG.removeSubsidence(base, hole);
      ok(ch.length === base.length && ch.filter((p) => p.ageHeld).length === 10 && ch.every((p) => !p.ageHeld || p.age === ay[10]) && ch.ageHeldKm === 20, 'ages held across a 20 km gap at the axis, flagged, from the first dated point');
      const far = ay.map((a, k) => (base[k].x < 60 ? null : a)), cf = AG.removeSubsidence(base, far);
      ok(cf.length === base.length - 30 && cf.every((p) => !p.ageHeld), `NEGATIVE CONTROL: a ${60} km gap is past AGE_HOLD_KM (${AG.AGE_HOLD_KM}) and nothing is held`); }
    { // the BAKED windows: exactly the trench sites, intact, the pinned source; and an INDEPENDENT check against Garcia et al.'s own site ages
      const AI = JSON.parse(rd('data/seafloor/age-index.json')), baker = rd('scripts/build-seafloor-age.py').toString();
      ok(AI.sites.map((m) => m.id).join() === SEAFLOOR_SITES.filter((s) => s.kind === 'trench').map((s) => s.id).join(), 'an age window for every trench site and nothing else');
      ok(baker.includes(`SHA256 = '${AI.source.sha256}'`) && AI.source.licence === 'CC BY 4.0' && /Seton/.test(AI.source.citation), 'the index names the pinned file (sha256 in the baker), its licence and its citation');
      const AGRID = new Map();
      for (const m of AI.sites) { const raw = rd('data/seafloor/' + m.file), g = AG.makeAgeGrid(m, BA.int16FromBytes(new Uint8Array(zlib.gunzipSync(raw)))); AGRID.set(m.id, g);
          ok(raw.length === m.bytes && [...g.q].every((v) => v === AG.AGE_NO_DATA || (v >= 0 && v <= 3400)), `${m.id}: age window intact, ages 0–340 Myr or no data`); }
      const check = (grids) => { const d = [];
          for (const r of LIT.GARCIA_2019.rows) { let best = null;
              for (const g of grids) for (let k = 0; k <= 12; k++) for (let b = 0; b < 360; b += 30) { const p = k ? BA.destination(r.lat, r.lon, b, 5 * k) : r, a = AG.sampleAge(g, p.lat, p.lon); if (a != null && (!best || 5 * k < best.k)) best = { k: 5 * k, a }; if (!k) break; }
              if (best) d.push(Math.abs(best.a - r.ageMa)); }
          d.sort((a, b) => a - b); return { n: d.length, med: d[d.length >> 1], max: d[d.length - 1] }; };
      const real = check([...AGRID.values()]);
      ok(real.n === 20 && real.med < 3 && real.max < 6, `Seton 2020 under our windows vs Garcia et al.'s site ages (Müller grids): ${real.n} sites, median ${real.med.toFixed(1)} Myr, worst ${real.max.toFixed(1)}`);
      const flipped = check([...AGRID.values()].map((g) => { const f = new Int16Array(g.q.length); for (let j = 0; j < g.ny; j++) f.set(g.q.subarray((g.ny - 1 - j) * g.nx, (g.ny - j) * g.nx), j * g.nx); return { ...g, q: f }; }));
      ok(!(flipped.med < 3 && flipped.max < 6), `NEGATIVE CONTROL: the same windows read upside down miss Garcia's ages (median ${flipped.med.toFixed(1)}, worst ${flipped.max.toFixed(1)} Myr)`);
      // REAL stations (MEASURED 2026-11-25). (1) On the old plates cooling predicts almost no tilt, while the free line chose one —
      // the slope was not subsidence. (2) The axis hold is never more than 32 km. (3) The two-thickness plate on the age reference.
      let oldPlates = 0, notCooling = 0, maxHeld = 0; const per = { n: 0, tem: 0, teM: 0, xr: 0, all: 0 }; let fitted2 = 0, needed2 = 0, acc2 = 0, closed2 = 0, above2 = 0; const quoted2 = [];
      for (const id of SEAFLOOR_SITES.filter((q) => q.kind === 'trench').map((q) => q.id)) { const t = model(id); if (!t.along) continue; const g = AGRID.get(id);
          for (const sec of t.along.stations) { if (!sec.profile || !sec.flexure) continue; const c = AG.removeSubsidence(sec.profile, AG.profileAges(g, sec.profile));
              if (c && c.ageCoverage >= 0.9) { maxHeld = Math.max(maxHeld, c.ageHeldKm); if (c.ageRange[0] >= 90) { oldPlates++; if (Math.abs(c.subsidenceSlope) < 0.1) notCooling += Math.abs(sec.flexure.slope) >= 0.5; } } }
          const two = BP.twoThickness(t, { ageGrid: g }); fitted2 += two.fitted; needed2 += two.needed; acc2 += two.accepted; if (two.quotable) quoted2.push(id);
          for (const s of two.stations) if (s.fit && s.fit.accepted) { closed2 += s.fit.teMStatus === 'measured'; above2 += !!(s.fit.thermal && s.fit.thermal.aboveHot);
              const st = t.along.stations.find((o) => o.offsetKm === s.offsetKm), cc = LIT.compareTwoThickness(s.fit, LIT.publishedFor(st.lat, st.lon, id));
              if (cc) { per.n++; per.tem += cc.temInside; per.teM += cc.teMInside; per.xr += cc.xrInside; per.all += cc.temInside && cc.teMInside && cc.xrInside; } } }
      ok(oldPlates >= 25 && notCooling >= 15, `old plates (≥ 90 Myr, ${oldPlates} sections): cooling predicts < 0.1 m/km, yet the free line chose ≥ 0.5 m/km at ${notCooling} — that slope was not subsidence`);
      ok(maxHeld <= 32, `ages held at the axis over at most ${maxHeld} km`);
      ok(fitted2 === 72 && needed2 === 29 && acc2 === 19 && closed2 === 7, `two thicknesses on the age reference: needed at ${needed2} of ${fitted2}, both pinned at ${acc2}, the unbent plate's interval closed at ${closed2} (measured 29 / 72 / 19 / 7; on the line reference 28 / 72 / 8 / 3)`);
      ok(quoted2.join() === 'philippine,izu-bonin,japan,middle-america', `quoted on the age reference: ${quoted2.join(', ')} (on the line reference only Middle America)`);
      ok(per.n === 19 && per.tem === 10 && per.teM === 13 && per.xr === 10 && per.all === 5, `against Zhang et al. 2018 at the ${per.n} accepted sections: near-trench inside ours at ${per.tem}, unbent at ${per.teM}, break at ${per.xr}, all three at ${per.all} — recorded, not tuned`);
      ok(above2 === 8, `at ${above2} of 19 the unbent plate's LOWER bound is deeper than a half-space 600 °C isotherm of that age — printed as a comparison (Zhang's own Philippine values are deeper too)`);
      const tmSrc = rd('js/seafloor/trench-model.js').toString(), agSrc = rd('js/seafloor/age.js').toString();
      ok(!/^import[^\n]*trench-literature/m.test(tmSrc) && !/^import[^\n]*trench-literature/m.test(agSrc), 'the age model never reads the literature'); }
    // ── the SEDIMENT (GlobSed) and its weight taken off before the two-thickness fit (Zhang et al. 2018 eq. 1) ──
    { const K = SD.SEDIMENT;
      ok(K.rhoMantle === TM.ELASTIC.rhoMantle && K.rhoWater === TM.ELASTIC.rhoWater && K.rhoSediment === 2000 && K.verified, 'sediment densities: Zhang Table 1 — mantle and water the SAME numbers as ELASTIC, sediment 2000 kg/m³');
      near(SD.sedimentLift(1000), 1000 * 1300 / 2270, 1e-9, 'Airy: 1 km of sediment stands the floor 573 m higher');
      ok(SD.sedimentLift(0) === 0, 'no sediment, no correction');
      // removeSediment: deepens each point by the lift; a missing value is DROPPED, never read as zero sediment
      const prof = Object.assign([0, 10, 20, 30, 40].map((x) => ({ x, depth: 5000 + x })), { origin: { lat: 0, lon: 0 }, seaBearingDeg: 90, axisOffsetKm: 0, axisS: 2 });
      const r = SD.removeSediment(prof, [200, 400, null, 800, 1000]);
      ok(r.length === 4 && r.every((p) => p.x !== 20) && r.every((p) => Math.abs(p.depth - (5000 + p.x + SD.sedimentLift(p.sediment))) < 1e-9), 'every point deepened by its own lift; the point with no value is dropped');
      ok(r.sedCoverage === 0.8 && r.sedRange[0] === 200 && r.sedRange[1] === 1000 && r.axisS === 2 && r.seaBearingDeg === 90, 'coverage 4 / 5, range and geometry carried for the age correction');
      // the shared sampler: profileStack under profileAges is unchanged (planted plane), and a sediment window reads in whole metres
      const meta = { id: 't', nx: 41, ny: 41, north: 10, west: 170, step_deg: 0.5 }, q = new Int16Array(41 * 41);
      for (let j = 0; j < 41; j++) for (let i = 0; i < 41; i++) q[j * 41 + i] = 100 + 10 * j + i;
      const sg = SD.makeSedimentGrid(meta, q); near(SD.sampleSediment(sg, 10 - 2.25, 172.75), 100 + 45 + 5.5, 1e-9, 'bilinear sediment is exact on a planted plane, in metres (age.js sampleGrid at scale 1)');
      near(AG.sampleAge(AG.makeAgeGrid(meta, q), 10 - 2.25, 172.75), (100 + 45 + 5.5) / 10, 1e-9, 'the same sampler reads the age at 0.1 Myr per unit');
      const q3 = q.slice(); q3[4 * 41 + 5] = SD.SED_NO_DATA; ok(SD.sampleSediment(SD.makeSedimentGrid(meta, q3), 10 - 2.25, 172.75) === null, 'a no-data node (land) voids the cell — land is never zero sediment');
      // the BAKED windows: exactly the trench sites, intact, the pinned copy
      const SI = JSON.parse(rd('data/seafloor/sediment-index.json')), baker = rd('scripts/build-seafloor-sediment.py').toString();
      ok(SI.sites.map((m) => m.id).join() === SEAFLOOR_SITES.filter((x) => x.kind === 'trench').map((x) => x.id).join(), 'a sediment window for every trench site and nothing else');
      ok(baker.includes(`SHA256 = '${SI.source.sha256}'`) && /Straume/.test(SI.source.citation) && /unofficial/.test(SI.source.copy) && /GlobSed/.test(SI.source.history_attr), 'the index names the pinned copy (sha256 in the baker), says it is unofficial, and carries the file\'s own history attribute');
      const SGRID = new Map(), AI = JSON.parse(rd('data/seafloor/age-index.json')), AGR = new Map();
      for (const m of SI.sites) { const raw = rd('data/seafloor/' + m.file), g = SD.makeSedimentGrid(m, BA.int16FromBytes(new Uint8Array(zlib.gunzipSync(raw)))); SGRID.set(m.id, g);
          ok(raw.length === m.bytes && [...g.q].every((v) => v === SD.SED_NO_DATA || (v >= 0 && v <= 20000)), `${m.id}: sediment window intact, 0–20 km or no data`); }
      for (const m of AI.sites) AGR.set(m.id, AG.makeAgeGrid(m, BA.int16FromBytes(new Uint8Array(zlib.gunzipSync(rd('data/seafloor/' + m.file))))));
      // an INDEPENDENT check of the copy: under the same windows, sediment must thin toward young crust in Seton's age grid
      const youngOld = (flip) => { const y = [], o = [];
          for (const [id, a] of AGR) { let sg2 = SGRID.get(id);
              if (flip) { const f = new Int16Array(sg2.q.length); for (let j = 0; j < sg2.ny; j++) f.set(sg2.q.subarray((sg2.ny - 1 - j) * sg2.nx, (sg2.ny - j) * sg2.nx), j * sg2.nx); sg2 = { ...sg2, q: f }; }
              for (let j = 0; j < a.ny; j += 2) for (let i = 0; i < a.nx; i += 2) { const lat = a.north - j * a.step, lon = a.west + i * a.step, t = AG.sampleAge(a, lat, lon), h = SD.sampleSediment(sg2, lat, lon);
                  if (t == null || h == null) continue; if (t < 5) y.push(h); else if (t >= 100 && t < 200) o.push(h); } }
          const med = (v) => v.sort((p, w) => p - w)[v.length >> 1]; return { y: med(y), o: med(o), ny: y.length }; };
      const yo = youngOld(false), yf = youngOld(true);
      ok(yo.ny > 1000 && yo.y < 0.5 * yo.o, `GlobSed thins toward young crust in Seton's ages: median ${yo.y} m on 0–5 Myr crust vs ${yo.o} m on 100–200 Myr (measured 119 vs 305)`);
      ok(!(yf.y < 0.5 * yf.o), `NEGATIVE CONTROL: read upside down the sediment no longer follows the ages (${yf.y} vs ${yf.o} m)`);
      // REAL stations (MEASURED 2026-11-25): the two-thickness plate with the sediment unloaded, then the cooling subsidence removed
      let fitted = 0, needed = 0, acc = 0, closed = 0, above = 0, used = 0; const per = { n: 0, tem: 0, teM: 0, xr: 0, all: 0 }, quoted = [];
      for (const id of SEAFLOOR_SITES.filter((x) => x.kind === 'trench').map((x) => x.id)) { const t = model(id); if (!t.along) continue;
          const two = BP.twoThickness(t, { ageGrid: AGR.get(id), sedGrid: SGRID.get(id) }); fitted += two.fitted; needed += two.needed; acc += two.accepted; if (two.quotable) quoted.push(id);
          for (const s of two.stations) { if (s.fit && s.fit.sediment) used++;
              if (s.fit && s.fit.accepted) { closed += s.fit.teMStatus === 'measured'; above += !!(s.fit.thermal && s.fit.thermal.aboveHot);
                  const st = t.along.stations.find((o) => o.offsetKm === s.offsetKm), cc = LIT.compareTwoThickness(s.fit, LIT.publishedFor(st.lat, st.lon, id));
                  if (cc) { per.n++; per.tem += cc.temInside; per.teM += cc.teMInside; per.xr += cc.xrInside; per.all += cc.temInside && cc.teMInside && cc.xrInside; } } } }
      ok(used === 65, `sediment unloaded at ${used} sections (the other 7 have no age reference)`);
      ok(fitted === 72 && needed === 28 && acc === 16 && closed === 3, `two thicknesses with sediment unloaded: needed at ${needed} of ${fitted}, both pinned at ${acc}, unbent interval closed at ${closed} (measured 28 / 72 / 16 / 3; age only 29 / 72 / 19 / 7)`);
      ok(quoted.join() === 'philippine,izu-bonin', `quoted with sediment unloaded: ${quoted.join(', ')} (age only adds Japan and Middle America)`);
      ok(per.n === 15 && per.tem === 9 && per.teM === 13 && per.xr === 10 && per.all === 7, `against Zhang et al. 2018 at the ${per.n} accepted sections: near-trench ${per.tem}, unbent ${per.teM}, break ${per.xr}, all three ${per.all} — every share up on age only (10/13/10/5 of 19), recorded, not tuned`);
      ok(above === 7, `at ${above} of 15 the unbent plate's lower bound lies deeper than the 600 °C isotherm`);
      // NEGATIVE CONTROL: `sediment: false` is EXACTLY the age-only fit
      const t0 = model('philippine'), off = BP.twoThickness(t0, { ageGrid: AGR.get('philippine'), sedGrid: SGRID.get('philippine'), sediment: false }), age = BP.twoThickness(t0, { ageGrid: AGR.get('philippine') });
      ok(JSON.stringify(off.stations.map((s) => s.fit && s.fit.tem)) === JSON.stringify(age.stations.map((s) => s.fit && s.fit.tem)) && off.stations.every((s) => !s.fit || !s.fit.sediment), 'sediment: false reproduces the age-only fit exactly');
      ok(!/^import[^\n]*trench-literature/m.test(rd('js/seafloor/sediment.js').toString()), 'the sediment model never reads the literature'); }
    // the renderers compute none of it
    for (const file of ['js/seafloor/page.js', 'js/seafloor/stage.js', 'js/seafloor/globe.js']) { const src = rd(file).toString();
        for (const fnc of ['flexureShape(', 'elasticFromRise(', 'fitFlexure(', 'velocityIn(', 'slabValueAt(', 'nearestStep(']) ok(!src.includes(fnc), `${file} never calls ${fnc}`); }
    const tm = rd('js/seafloor/trench-model.js').toString();
    ok(/from '\.\.\/earth-interior\/plates\.js'/.test(tm) && /from '\.\.\/earth-interior\/slabs\.js'/.test(tm) && !/eulerVector\s*=|function plateAt/.test(tm), 'plates and slabs are imported from the Inner Earth kernels, never copied');
}
console.log(`\n✅ seafloor-kernels: ${n} checks passed`);
