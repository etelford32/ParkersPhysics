// tests/geomag-chaos.mjs — CHAOS-8.1 through igrf.js, gated against ChaosMagPy.
// Run: node tests/geomag-chaos.mjs
// Oracle fixture: tests/fixtures/geomag/chaos-oracle.json, written by scripts/chaos_oracle.py
// (ChaosMagPy 0.16 on the SAME pinned SHC files). Never hand-edit it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeChaos, chaosCoeffsAt, svSet, coverage, decimalYear, msFromDecimalYear } from '../js/geomag/chaos.js';
import { fieldGeocentric, fieldGeodetic, fieldGridGeocentric, coeffsAt, dipole, findSAA, lowesSpectrum, R_CMB_KM, strideOf } from '../js/geomag/igrf.js';
import { fieldMap, crustMap, sampleMap, rampColor, FIELD_QUANTITIES, CMB_NMAX } from '../js/earth-interior/field-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const baked = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'data/earth-interior/chaos-8.1.json.gz'))));
const model = decodeChaos(baked);
const O = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/geomag/chaos-oracle.json'), 'utf8'));
const DEG = Math.PI / 180;
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// ChaosMagPy's flat order: for n = 1..: g_n0, g_n1, h_n1, g_n2, h_n2, …
function flat(set, nmax) {
    const out = [];
    for (let d = 1; d <= nmax; d++) { out.push(set.g[d][0]); for (let m = 1; m <= d; m++) out.push(set.g[d][m], set.h[d][m]); }
    return out;
}
const maxAbs = (a, b) => a.reduce((s, v, i) => Math.max(s, Math.abs(v - b[i])), 0);

console.log('CHAOS-8.1 — kernel vs ChaosMagPy');

{
    assert.equal(model.nmax, 20); assert.equal(model.order, 6); assert.equal(model.step, 5);
    assert.equal(model.times.length, 281);
    assert.ok(Math.abs(model.start - 1997.102) < 1e-3 && Math.abs(model.end - 2025.102) < 1e-3);
    const c = chaosCoeffsAt(model, 2010);
    assert.equal(strideOf(c), 21, 'a degree-20 set evaluates at stride 21');
    assert.equal(chaosCoeffsAt(model, 1990), null, 'before the data: refused, never invented');
    ok('decoded 281 samples × 440 coefficients, order 6, break every 5; refuses before 1997.10');
}

{
    let worst = 0, worstSv = 0;
    for (const e of O.coefficients) {
        const c = chaosCoeffsAt(model, e.year);
        worst = Math.max(worst, maxAbs(flat(c, 20), e.gh));
        worstSv = Math.max(worstSv, maxAbs(flat(svSet(c), 20), e.sv));
    }
    assert.ok(worst < 2e-4, `coefficients within 2e-4 nT of ChaosMagPy (worst ${worst})`);
    assert.ok(worstSv < 2e-3, `SV within 2e-3 nT/yr (worst ${worstSv})`);
    // NEGATIVE CONTROL: straight lines between the 0.1-yr samples miss the SV badly.
    let lin = 0;
    for (const e of O.coefficients.filter((x) => x.year < model.end)) {
        lin = Math.max(lin, maxAbs(flat(svSet(chaosCoeffsAt(model, e.year, { method: 'linear' })), 20), e.sv));
    }
    assert.ok(lin > 50 * worstSv && lin > 0.05, `linear-interpolation control must fail (${lin} nT/yr)`);
    ok(`13 epochs 1997–2026: g/h within ${worst.toExponential(1)} nT, SV within ${worstSv.toExponential(1)} nT/yr; linear control misses SV by ${lin.toFixed(2)} nT/yr`);
}

{
    // Past 2025.10: linear along the end-point SV — ChaosMagPy (above) AND DTU's own extrapolated file.
    const ex = baked.extrapolated;
    const yLast = ex.times[ex.times.length - 1];
    const c = chaosCoeffsAt(model, yLast);
    assert.ok(c.extrapolated && Math.abs(c.yearsPast - (yLast - model.end)) < 1e-12);
    let worst = 0;
    ex.rows.forEach(([d, m], k) => {
        const ours = m >= 0 ? c.g[d][m] : c.h[d][-m];
        worst = Math.max(worst, Math.abs(ours - ex.series[k][ex.series[k].length - 1]));
    });
    assert.ok(worst < 0.01, `matches DTU's CHAOS-8.1_core_extrapolated.shc to 0.01 nT (worst ${worst})`);
    assert.equal(coverage(model, 2026.9).state, 'extrapolated');
    assert.equal(coverage(model, 2010).state, 'data');
    ok(`past the data: linear forecast flagged, equal to DTU's own extrapolated file to ${worst.toExponential(1)} nT`);
}

{
    // Field values through igrf.js: surface, 500 km, CMB; B and dB/dt.
    let wB = 0, wD = 0, wCmb = 0, wCmbX = 0, wSvC = 0;
    for (const f of O.field) {
        const past = f.year > model.end;
        const c = chaosCoeffsAt(model, f.year);
        O.points.forEach((p, i) => {
            const b = fieldGeocentric(c, 20, f.r, p.theta * DEG, p.phi * DEG);
            const d = fieldGeocentric(svSet(c), 20, f.r, p.theta * DEG, p.phi * DEG);
            const e = Math.max(Math.abs(b.br - f.B[i][0]), Math.abs(b.btheta - f.B[i][1]), Math.abs(b.bphi - f.B[i][2]));
            const rel = e / Math.hypot(...f.B[i]);
            if (f.r < 4000) { if (past) wCmbX = Math.max(wCmbX, rel); else wCmb = Math.max(wCmb, rel); } else wB = Math.max(wB, e);
            if (f.r > 4000) wD = Math.max(wD, Math.abs(d.br - f.dB[i][0]));
            else wSvC = Math.max(wSvC, Math.abs(d.br - f.dB[i][0]) / Math.sqrt(f.dB.reduce((a, v) => a + v[0] * v[0], 0) / f.dB.length));
        });
    }
    assert.ok(wB < 0.01, `surface/orbit B within 0.01 nT (worst ${wB})`);
    assert.ok(wCmb < 2e-5, `CMB B within 2e-5 relative inside the data (worst ${wCmb})`);
    // Past the data the two linear forecasts differ by ~6e-5 nT/yr in the end-point SV (a spline
    // end derivative vs ours); (a/c)^22 ≈ 6e5 amplifies that at the CMB. Bounded, and disclosed.
    assert.ok(wCmbX < 3e-3, `CMB B in the forecast within 3e-3 relative (worst ${wCmbX})`);
    assert.ok(wD < 5e-3, `dB_r/dt at the surface and orbit within 5e-3 nT/yr (worst ${wD})`);
    // At the CMB the n = 17–20 SV coefficients (~1e-5 nT/yr apart between the two spline fits) are
    // amplified ~6e5 × (n+1): a few percent (measured 4.3 %). CHAOS's SV is not resolved there anyway — the page draws
    // CMB SV at n ≤ 13 (CMB_SV_NMAX) for that reason.
    assert.ok(wSvC < 0.05, `CMB dB_r/dt (n ≤ 20) within 5 % of the rms CMB SV (worst ${wSvC})`);
    ok(`B at 16 points × 3 epochs × {surface, 500 km, CMB} via igrf.js: ${wB.toExponential(1)} nT; CMB ${wCmb.toExponential(1)} rel (forecast ${wCmbX.toExponential(1)}); SV ${wD.toExponential(1)} nT/yr (CMB n≤20 ${(wSvC * 100).toFixed(1)} %)`);
}

{
    // Lithosphere: the BAKED grid (our evaluator at stride 186) vs ChaosMagPy at its nodes.
    const L = baked.lithosphere;
    let worst = 0, big = 0;
    for (const p of O.lithosphere) {
        const i = (L.lat0 - p.lat) / L.stepDeg, j = (p.lon - L.lon0) / L.stepDeg;
        const z = L.z[i * L.nLon + j] * L.scale;
        worst = Math.max(worst, Math.abs(z - p.Z)); big = Math.max(big, Math.abs(p.Z));
    }
    assert.ok(worst <= L.scale / 2 + 1e-6, `baked Z within half a quantum (${worst} nT)`);
    assert.ok(big > 500, 'the sample includes a strong anomaly (Kursk / Bangui)');
    ok(`lithospheric Z grid (n 21–185, our evaluator at stride 186) matches ChaosMagPy at ${O.lithosphere.length} nodes to ${worst.toFixed(3)} nT (|Z| up to ${big.toFixed(0)} nT)`);
}

{
    // Physics through the same coefficients: CHAOS vs IGRF-14 (whose 2020 DGRF used CHAOS among its candidates).
    const ch = chaosCoeffsAt(model, 2020.0), ig = coeffsAt(2020.0);
    let rms = 0, k = 0;
    for (let lat = -80; lat <= 80; lat += 20) for (let lon = -180; lon < 180; lon += 30) {
        const a = fieldGeodetic(ch, 13, lat, lon, 0).f, b = fieldGeodetic(ig, 13, lat, lon, 0).f;
        rms += (a - b) ** 2; k++;
    }
    rms = Math.sqrt(rms / k);
    assert.ok(rms < 15, `CHAOS n≤13 vs DGRF-2020 |B| rms ${rms} nT`);
    // The dipole is decaying and the SAA is drifting west — measured, not asserted from memory.
    const d0 = dipole(chaosCoeffsAt(model, 1998)), d1 = dipole(chaosCoeffsAt(model, 2025));
    assert.ok(d1.momentAm2 < d0.momentAm2, 'dipole moment decreases 1998 → 2025');
    const s0 = findSAA(chaosCoeffsAt(model, 1998), 20), s1 = findSAA(chaosCoeffsAt(model, 2025), 20);
    assert.ok(s1.lonDeg < s0.lonDeg && s1.fNt < s0.fNt, 'SAA minimum moves west and deepens');
    // At the CMB the spectrum is near-white (a source there); at the surface it falls by decades.
    const sp = lowesSpectrum(chaosCoeffsAt(model, 2020), 13, R_CMB_KM), ss = lowesSpectrum(chaosCoeffsAt(model, 2020), 13);
    const spread = (a) => Math.log10(Math.max(...a.slice(2))) - Math.log10(Math.min(...a.slice(2)));
    assert.ok(spread(sp) < 1.5 && spread(ss) > 4);
    ok(`vs IGRF-14 2020: |B| rms ${rms.toFixed(1)} nT; dipole −${((1 - d1.momentAm2 / d0.momentAm2) * 100).toFixed(1)} % 1998→2025; SAA ${s0.lonDeg.toFixed(1)}° → ${s1.lonDeg.toFixed(1)}°E, ${s0.fNt.toFixed(0)} → ${s1.fNt.toFixed(0)} nT`);
}

{
    const y = 2026.5;
    assert.ok(Math.abs(decimalYear(msFromDecimalYear(y)) - y) < 1e-12);
    assert.ok(Math.abs(decimalYear(Date.UTC(2000, 0, 1)) - 2000) < 1e-12, '2000.0 is MJD 51544 00:00 UT');
    ok('decimal-year convention: 365.25-day years from 2000-01-01 00:00 UT (round trip)');
}

{
    // The page's grids: fieldGridGeocentric ≡ fieldGeocentric at every cell centre (it only reuses the Legendre rows).
    const c = chaosCoeffsAt(model, 2012.4);
    const g = fieldGridGeocentric(c, 20, { rKm: 4100, nLat: 9, nLon: 18 });
    let w = 0;
    for (let i = 0; i < 9; i++) for (let j = 0; j < 18; j++) {
        const th = (i + 0.5) * 20 * DEG, ph = (-180 + (j + 0.5) * 20) * DEG;
        const b = fieldGeocentric(c, 20, 4100, th, ph), k = i * 18 + j;
        w = Math.max(w, Math.abs(b.br - g.br[k]) / Math.abs(b.br || 1), Math.abs(b.btheta - g.btheta[k]) / (Math.abs(b.btheta) + 1));
    }
    assert.ok(w < 1e-6, `grid ≡ pointwise (float32 storage) ${w}`);
    // field-model: the CMB map IS the evaluator's B_r at 3480 km, n ≤ 13; the probe reads it back.
    const m = fieldMap(model, 2012.4, 'cmb-br');
    const ref = fieldGeocentric(c, CMB_NMAX, R_CMB_KM, (90 - 31) * DEG, 45 * DEG).br;
    assert.ok(Math.abs(m.values[29 * 180 + 112] - ref) / Math.abs(ref) < 1e-6, 'map cell = evaluator');
    assert.ok(Math.abs(sampleMap(m, 31, 45) - ref) / Math.abs(ref) < 1e-6, 'probe at a cell centre = the cell');
    // Colour: the diverging ramp's midpoint is neutral, its ends are the ramp's ends, it clamps.
    const mid = rampColor('cmb-br', 0), lo = rampColor('cmb-br', -1e9), hi = rampColor('cmb-br', 1e9);
    assert.deepEqual(mid, [247, 247, 247]); assert.deepEqual(lo, [33, 102, 172]); assert.deepEqual(hi, [178, 24, 43]);
    assert.equal(rampColor('cmb-br', NaN), null, 'a gap is no colour, never neutral');
    // Crust cells average their four corner nodes of the baked grid.
    const cm = crustMap(baked.lithosphere), L = baked.lithosphere;
    const node = (i, j) => L.z[i * L.nLon + j] * L.scale;
    assert.ok(Math.abs(cm.values[40 * 360 + 217] - (node(40, 217) + node(41, 217) + node(40, 218) + node(41, 218)) / 4) < 1e-4);
    assert.ok(FIELD_QUANTITIES['surf-f'].range[0] < 22000, 'the |B| ramp reaches below the SAA minimum');
    ok(`page grids ≡ the pointwise evaluator (${w.toExponential(1)}); CMB map, probe, ramp (neutral 0, clamped ends, NaN → none) and crust cells pinned`);
}

console.log(`${n} checks passed`);
