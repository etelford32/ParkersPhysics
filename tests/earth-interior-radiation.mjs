// tests/earth-interior-radiation.mjs — the moment-tensor radiation kernel against independent oracles.
// Run: node tests/earth-interior-radiation.mjs
import assert from 'node:assert/strict';
import {
    RMS_RADIATION, scalarMoment, momentMagnitude, doubleCoupleTensor, faultVectors, tensorFromVectors, planeFromVectors,
    eigenSymmetric, decompose, radiationCoefficients, doubleCoupleRadiation, takeoffAngle, projectLowerHemisphere,
    unprojectLowerHemisphere, beachballGrid, useToNed, parseMechanism, rayRadiation,
} from '../js/earth-interior/radiation.js';

const DEG = Math.PI / 180;
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const maxDiff = (A, B) => Math.max(...A.flatMap((r, i) => r.map((v, j) => Math.abs(v - B[i][j]))));
const MECHS = [[0, 90, 0], [30, 45, 90], [127, 33, -71], [250, 72, 155], [300, 10, 40], [77, 88, -3]];

console.log('Inner Earth — radiation pattern');

check('Box 4.4 tensor ≡ M0(n dᵀ + d nᵀ) from the fault vectors; traceless; M0 recovered', () => {
    for (const [s, d, r] of MECHS) {
        const A = doubleCoupleTensor(s, d, r, 3.7e19);
        const { n: nv, d: dv } = faultVectors(s, d, r);
        close(Math.hypot(...nv), 1, 1e-14, 'unit normal'); close(nv[0] * dv[0] + nv[1] * dv[1] + nv[2] * dv[2], 0, 1e-14, 'slip ⟂ normal');
        const B = tensorFromVectors(nv, dv, 3.7e19);
        assert.ok(maxDiff(A, B) < 1e-14 * 3.7e19, `tensor forms differ for ${s}/${d}/${r}`);
        close(A[0][0] + A[1][1] + A[2][2], 0, 1e5, 'trace');
        close(scalarMoment(A) / 3.7e19, 1, 1e-14, 'M0');
    }
    close(momentMagnitude(10 ** (1.5 * 7 + 9.1)), 7, 1e-12, 'Mw 7');
});

check('tensor contraction ≡ A&R (4.89) closed double-couple formulas at every direction', () => {
    let worst = 0;
    for (const [s, d, r] of MECHS) {
        const M = doubleCoupleTensor(s, d, r);
        for (let i = 0; i <= 180; i += 7.5) for (let f = 0; f < 360; f += 11) {
            const a = radiationCoefficients(M, i * DEG, f * DEG), b = doubleCoupleRadiation(s, d, r, i * DEG, f * DEG);
            worst = Math.max(worst, Math.abs(a.P - b.P), Math.abs(a.SV - b.SV), Math.abs(a.SH - b.SH));
        }
    }
    assert.ok(worst < 1e-13, `max difference ${worst}`);
    // NEGATIVE CONTROL: the same formulas with the strike measured the wrong way round must disagree.
    const M = doubleCoupleTensor(127, 33, -71);
    const a = radiationCoefficients(M, 0.7, 1.1), b = doubleCoupleRadiation(-127, 33, -71, 0.7, 1.1);
    assert.ok(Math.abs(a.P - b.P) > 0.05, 'mirrored strike went undetected');
});

check('focal-sphere means: ⟨R_P²⟩ = 4/15, ⟨R_SV² + R_SH²⟩ = 2/5 (numerical quadrature)', () => {
    const splits = [];
    for (const [s, d, r] of MECHS) {
        const M = doubleCoupleTensor(s, d, r);
        const N = 180, K = 360;
        let P = 0, SV = 0, SH = 0, W = 0;
        for (let a = 0; a < N; a++) {
            const i = ((a + 0.5) / N) * Math.PI, w = Math.sin(i);
            for (let b = 0; b < K; b++) {
                const R = radiationCoefficients(M, i, ((b + 0.5) / K) * 2 * Math.PI);
                P += w * R.P ** 2; SV += w * R.SV ** 2; SH += w * R.SH ** 2; W += w;
            }
        }
        close(P / W, 4 / 15, 2e-4, `P mean ${s}/${d}/${r}`);
        // Only the S TOTAL is mechanism-independent; the SV/SH split is not (a vertical
        // strike-slip puts 5/6 of it in SH) — which is why the fallback splits it evenly.
        close((SV + SH) / W, 2 / 5, 2e-4, `S mean ${s}/${d}/${r}`);
        splits.push(SV / (SV + SH));
    }
    close(splits[0], 1 / 6, 1e-3, 'vertical strike-slip SV share (1/15 of 2/5)');
    assert.ok(Math.max(...splits) - Math.min(...splits) > 0.1, 'the split varies by mechanism');
    close(RMS_RADIATION.P, 0.5164, 1e-4, 'the fallback is the same mean');
    close(RMS_RADIATION.SV ** 2 + RMS_RADIATION.SH ** 2, 2 / 5, 1e-12, 'fallback S total');
});

check('eigen-decomposition: T = +1, P = −1, N = 0; R_P(T) = +1, R_P(P) = −1, zero on both nodal planes', () => {
    for (const [s, d, r] of MECHS) {
        const M = doubleCoupleTensor(s, d, r);
        const e = eigenSymmetric(M);
        close(e[0].value, 1, 1e-12, 'T'); close(e[1].value, 0, 1e-12, 'N'); close(e[2].value, -1, 1e-12, 'P');
        const dir = (v) => { let u = v; if (u[2] < 0) u = u.map((x) => -x); return { i: Math.acos(u[2]), f: Math.atan2(u[1], u[0]) }; };
        const T = dir(e[0].vector), P = dir(e[2].vector);
        close(radiationCoefficients(M, T.i, T.f).P, 1, 1e-12, 'R_P on T');
        close(radiationCoefficients(M, P.i, P.f).P, -1, 1e-12, 'R_P on P');
        // Points in each nodal plane: the plane contains strike direction and dip direction.
        const dec = decompose(M);
        for (const pl of dec.planes) {
            const { n: nv } = faultVectors(pl.strike, pl.dip, pl.rake);
            for (let t = 0; t < 12; t++) {
                const a = (t / 12) * Math.PI;
                const ref = Math.abs(nv[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
                const u1 = [nv[1] * ref[2] - nv[2] * ref[1], nv[2] * ref[0] - nv[0] * ref[2], nv[0] * ref[1] - nv[1] * ref[0]];
                const l1 = Math.hypot(...u1), e1 = u1.map((x) => x / l1);
                const e2 = [nv[1] * e1[2] - nv[2] * e1[1], nv[2] * e1[0] - nv[0] * e1[2], nv[0] * e1[1] - nv[1] * e1[0]];
                const v = e1.map((x, k) => Math.cos(a) * x + Math.sin(a) * e2[k]);
                const dd = dir(v);
                close(radiationCoefficients(M, dd.i, dd.f).P, 0, 1e-12, `nodal ${pl.strike.toFixed(1)}`);
            }
        }
    }
});

check('strike/dip/rake → tensor → both planes round-trips; the auxiliary plane is the same tensor', () => {
    const norm = (a) => ((a % 360) + 360) % 360;
    for (const [s, d, r] of MECHS.filter(([, d]) => d > 5 && d < 89)) {
        const dec = decompose(doubleCoupleTensor(s, d, r));
        const hit = dec.planes.find((p) => Math.abs(norm(p.strike - s + 180) - 180) < 1e-6 && Math.abs(p.dip - d) < 1e-6);
        assert.ok(hit, `plane ${s}/${d}/${r} not recovered: ${JSON.stringify(dec.planes)}`);
        close(Math.abs(norm(hit.rake - r + 180) - 180), 0, 1e-6, 'rake');
        const aux = dec.planes.find((p) => p !== hit);
        assert.ok(maxDiff(doubleCoupleTensor(aux.strike, aux.dip, aux.rake), doubleCoupleTensor(s, d, r)) < 1e-12, 'aux plane tensor');
        close(dec.percentDC, 100, 1e-9, '%DC');
    }
    // A horizontal-ish plane still yields a finite rake (the sin λ blend).
    const pl = planeFromVectors([0, 0, -1], [1, 0, 0]);
    assert.ok(Number.isFinite(pl.rake) && Math.abs(pl.dip) < 1e-9);
    // A CLVD is not a double couple.
    const clvd = [[2, 0, 0], [0, -1, 0], [0, 0, -1]];
    close(decompose(clvd).percentDC, 0, 1e-9, 'CLVD %DC');
});

check('take-off angles and the lower-hemisphere projection', () => {
    close(takeoffAngle(0, 8, 6000, true), 0, 1e-15, 'vertical down');
    close(takeoffAngle(6000 / 8, 8, 6000, true), Math.PI / 2, 1e-7, 'horizontal');
    close(takeoffAngle(300, 8, 6000, false), Math.PI - Math.asin(0.4), 1e-14, 'up-going');
    assert.equal(takeoffAngle(800, 8, 6000, true), null, 'evanescent');
    const c = projectLowerHemisphere(0, 1.3); close(c.x, 0, 1e-15, 'centre'); close(c.y, 0, 1e-15, 'centre');
    const e = projectLowerHemisphere(Math.PI / 2, Math.PI / 2); close(e.x, 1, 1e-14, 'east rim'); close(e.y, 0, 1e-14, 'rim');
    for (const [i, f] of [[0.3, 0.2], [1.2, 4.0], [0.9, -2]]) {
        const p = projectLowerHemisphere(i, f), u = unprojectLowerHemisphere(p.x, p.y);
        close(u.takeoffRad, i, 1e-12, 'unproject i');
        close(Math.cos(u.azimuthRad - f), 1, 1e-12, 'unproject φ');
    }
    // An up-going ray plots at its antipode, which carries the SAME R_P (R_P is even in γ).
    const M = doubleCoupleTensor(127, 33, -71);
    close(radiationCoefficients(M, Math.PI - 0.4, 0.5).P, radiationCoefficients(M, 0.4, 0.5 + Math.PI).P, 1e-13, 'antipodal R_P');
    // Equal-area: a strike-slip ball is four equal quadrants.
    const g = beachballGrid(doubleCoupleTensor(0, 90, 0), 200);
    let pos = 0, neg = 0; for (const v of g) { if (v > 0) pos++; else if (v < 0) neg++; }
    close(pos / (pos + neg), 0.5, 0.01, 'strike-slip compressional share');
    // A pure thrust's ball centre is compressional (T axis vertical).
    const t = beachballGrid(doubleCoupleTensor(0, 45, 90), 41);
    assert.equal(t[20 * 41 + 20], 1, 'thrust centre');
    const nf = beachballGrid(doubleCoupleTensor(0, 45, -90), 41);
    assert.equal(nf[20 * 41 + 20], -1, 'normal-fault centre');
});

check('USE → NED mapping: a thrust published in USE gives the Box 4.4 thrust', () => {
    // Thrust striking north, dipping 45° east (A&R): NED Mzz = +1, Myy = −1.
    const ned = doubleCoupleTensor(0, 45, 90);
    const use = { rr: ned[2][2], tt: ned[0][0], pp: ned[1][1], rt: ned[0][2], rp: -ned[1][2], tp: -ned[0][1] };
    assert.ok(maxDiff(useToNed(use), ned) < 1e-15);
    close(use.rr, 1, 1e-15, 'Mrr of a thrust is positive (vertical T axis)');
    // An oblique case exercises every off-diagonal sign.
    const ob = doubleCoupleTensor(127, 33, -71);
    const u2 = { rr: ob[2][2], tt: ob[0][0], pp: ob[1][1], rt: ob[0][2], rp: -ob[1][2], tp: -ob[0][1] };
    assert.ok(maxDiff(useToNed(u2), ob) < 1e-15);
    // NEGATIVE CONTROL: dropping the sign flips changes the mechanism.
    const naive = [[u2.tt, u2.tp, u2.rt], [u2.tp, u2.pp, u2.rp], [u2.rt, u2.rp, u2.rr]];
    assert.ok(maxDiff(naive, ob) > 0.1, 'naive mapping undetected');
});

check('parseMechanism: moment-tensor product first, focal-mechanism fallback, self-reported misses', () => {
    const ob = doubleCoupleTensor(127, 33, -71, 2.5e19);
    const use = { 'tensor-mrr': ob[2][2], 'tensor-mtt': ob[0][0], 'tensor-mpp': ob[1][1], 'tensor-mrt': ob[0][2], 'tensor-mrp': -ob[1][2], 'tensor-mtp': -ob[0][1] };
    const asStr = Object.fromEntries(Object.entries(use).map(([k, v]) => [k, v.toExponential(6)]));
    const detail = { properties: { products: {
        'moment-tensor': [{ source: 'us', properties: { ...asStr, 'derived-magnitude-type': 'Mww', 'scalar-moment': '2.5e19' } }],
        'focal-mechanism': [{ source: 'x', properties: { 'nodal-plane-1-strike': '0', 'nodal-plane-1-dip': '90', 'nodal-plane-1-rake': '0' } }],
    } } };
    const m = parseMechanism(detail);
    assert.equal(m.kind, 'tensor'); assert.equal(m.method, 'Mww');
    close(m.m0 / 2.5e19, 1, 1e-6, 'M0'); close(m.mw, momentMagnitude(2.5e19), 1e-6, 'Mw');
    assert.ok(m.planes.some((p) => Math.abs(p.strike - 127) < 1e-3 && Math.abs(p.dip - 33) < 1e-3), 'planes');
    // Missing a component → falls through to the focal mechanism, which is a double couple.
    const broken = structuredClone(detail); delete broken.properties.products['moment-tensor'][0].properties['tensor-mrp'];
    const f = parseMechanism(broken);
    assert.equal(f.kind, 'double-couple'); assert.equal(f.product, 'focal-mechanism');
    assert.deepEqual(f.tried, ['moment-tensor:us', 'focal-mechanism:x']);
    const none = parseMechanism({ properties: { products: { origin: [{}] } } });
    assert.equal(none.kind, null); assert.match(none.reason, /no moment tensor/);
});

check('rayRadiation: the recorded component, its sign, and the near-nodal flag', () => {
    const M = doubleCoupleTensor(0, 90, 0);        // vertical strike-slip on a N–S plane
    const onNodal = rayRadiation(M, { takeoffRad: Math.PI / 2, azimuthRad: 0, wave: 'P' });
    assert.ok(onNodal.nearNodal && Math.abs(onNodal.signed) < 1e-12, 'along strike is nodal for P');
    const lobe = rayRadiation(M, { takeoffRad: Math.PI / 2, azimuthRad: 45 * DEG, wave: 'P' });
    close(lobe.signed, 1, 1e-12, 'P lobe'); assert.equal(lobe.nearNodal, false);
    const sh = rayRadiation(M, { takeoffRad: Math.PI / 2, azimuthRad: 0, wave: 'S', polarization: 'SH' });
    close(Math.abs(sh.signed), 1, 1e-12, 'SH maximum along strike');
    assert.equal(sh.component, 'SH');
});

const { travelTimeTable } = await import('../js/earth-interior/phases.js');
const { arrivalsAt } = await import('../js/earth-interior/quake-model.js');
{
    // A vertical strike-slip on a N–S plane at 20 km; a station due north sits on the strike (P nodal).
    const quake = { lat: 0, lon: 0, depthKm: 20, timeMs: 0 };
    const table = travelTimeTable(20);
    const dec = decompose(doubleCoupleTensor(0, 90, 0));
    const withM = { ...quake, mechanism: dec };
    for (const site of [{ lat: 50, lon: 0 }, { lat: 35, lon: 40 }, { lat: -20, lon: -60 }]) {
        const base = arrivalsAt(quake, site, table), mech = arrivalsAt(withM, site, table);
        assert.equal(base.radiationSource, 'rms'); assert.equal(mech.radiationSource, 'mechanism');
        for (const r of mech.rows) {
            const b = base.rows.find((x) => x.phase === r.phase);
            if (!(b?.amp > 0) || !(r.amp > 0) || !r.radiation) continue;
            const ratio = r.amp / b.amp, expect = r.radiation.magnitude / RMS_RADIATION[r.radiation.component];
            close(ratio, expect, 1e-9 * expect + 1e-15, `${r.phase} at ${site.lat},${site.lon}`);
            // Independent: |R| equals the A&R closed form at the row's own take-off and azimuth.
            const cf = doubleCoupleRadiation(0, 90, 0, r.radiation.takeoffRad, r.radiation.azimuthRad);
            close(r.radiation.magnitude, Math.abs(cf[r.radiation.component]), 1e-12, `${r.phase} closed form`);
        }
        const P = mech.rows.find((x) => x.phase === 'P');
        if (P?.radiation) assert.equal(P.polarity, P.radiation.signed >= 0 ? 'up' : 'down');
        if (site.lat === 50) assert.ok(P.nearNodal, 'due north lies on the strike: P must be near-nodal');
    }
    // NEGATIVE CONTROL: without a mechanism no row claims a polarity.
    assert.ok(arrivalsAt(quake, { lat: 35, lon: 40 }, table).rows.every((r) => r.polarity === null));
    n++; console.log('  ✓ end to end: each arrival scales by exactly |R| / RMS, nodal station flagged, P polarity from R_P');
}

console.log(`${n} checks passed`);
