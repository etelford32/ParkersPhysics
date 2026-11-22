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
console.log(`\n✅ seafloor-kernels: ${n} checks passed`);
