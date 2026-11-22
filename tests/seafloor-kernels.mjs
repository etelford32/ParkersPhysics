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
    const w = index.world, wz = BA.int16FromBytes(new Uint8Array(zlib.gunzipSync(rd('data/seafloor/' + w.file)))); ok(wz.length === w.nx * w.ny, 'world grid size');
    const frac = wz.reduce((a, v, k) => { const lat = 90 - (Math.floor(k / w.nx) + 0.5) * w.step_deg, c = Math.cos(lat * Math.PI / 180); a[0] += v < 0 ? c : 0; a[1] += c; return a; }, [0, 0]);
    ok(frac[0] / frac[1] > 0.68 && frac[0] / frac[1] < 0.74, `the world grid is ${(100 * frac[0] / frac[1]).toFixed(1)} % ocean (Earth: 71 %)`);
    function dmOf(id) { return index.sites.find((m) => m.id === id).deepest; }
}

// ── 5. the baked casts (REAL) and the claim the page makes with them ─────────
console.log('5. casts.json.gz (NOAA World Ocean Database)');
const casts = JSON.parse(zlib.gunzipSync(rd('data/seafloor/casts.json.gz')).toString());
{
    ok(casts.format === 'seafloor-casts-v1' && Object.keys(casts.sites).length === SEAFLOOR_SITES.length, 'one entry per site');
    let total = 0, hadal = 0, warmer = 0, tested = 0, adiabatWins = 0, gradWins = 0; const rmsA = [], rmsI = [];
    for (const s of SEAFLOOR_SITES) {
        const e = casts.sites[s.id];
        ok(e.casts.length <= casts.keep, `${s.id}: at most ${casts.keep} casts`);
        for (const c of e.casts) {
            total++;
            ok(c.z.length === c.t.length && (c.s === null || c.s.length === c.z.length), `${s.id}/${c.wod_cast}: arrays align`);
            assert.ok(c.z.every((v, i) => i === 0 || v > c.z[i - 1]), `${s.id}/${c.wod_cast}: depth strictly increases`);
            assert.ok(c.t.every((v) => v > -2.5 && v < 35) && c.max_depth_m >= casts.min_depth_m && c.km <= casts.radius_km + 1, `${s.id}/${c.wod_cast}: plausible`);
            assert.ok(/^\d{4}-\d\d-\d\d$/.test(c.date)); n += 3;
            if (s.kind === 'trench' && c.max_depth_m >= 7000 && !['hellenic'].includes(s.id)) {
                hadal++;
                const k = c.t.indexOf(Math.min(...c.t.filter((_, i) => c.z[i] >= 500)));
                if (c.t[c.t.length - 1] > c.t[k] + 0.05 && c.z[k] < c.max_depth_m - 1000) warmer++;
                const w = PR.withheldTest(c, Math.max(4500, c.max_depth_m - 2500));
                if (w) { tested++; rmsA.push(w.rms.adiabat); rmsI.push(w.rms.isothermal); if (w.rms.adiabat < w.rms.isothermal) adiabatWins++; if (w.rms.adiabat < w.rms.gradient) gradWins++; }
            }
        }
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    log(`${total} casts; ${hadal} trench casts reach 7 km; warmer at the bottom than at their minimum in ${warmer}`);
    log(`withheld-bottom test on ${tested}: adiabat median rms ${med(rmsA).toFixed(3)} °C vs isothermal ${med(rmsI).toFixed(3)} °C; adiabat beats isothermal in ${adiabatWins}, beats gradient-extrapolation in ${gradWins}`);
    ok(total >= 120, 'the archive has casts'); ok(hadal >= 20, 'and real hadal ones');
    ok(warmer / hadal >= 0.9, 'MEASURED: trench water is warmer at the bottom than at its temperature minimum');
    ok(tested >= 15 && adiabatWins / tested >= 0.9, 'the adiabat beats "temperature held" on real withheld data');
    ok(med(rmsA) < 0.05 && med(rmsI) > 3 * med(rmsA), 'and by a wide margin');
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
    ok(d.point.depth === meta.deepest.depth_m && d.section.length === 241 && d.axis.defined, 'detail: point, section, axis');
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
console.log(`\n✅ seafloor-kernels: ${n} checks passed`);
