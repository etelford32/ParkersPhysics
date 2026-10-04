/**
 * upper-atmosphere-sat-suites.mjs — the satellite-suite kernel
 * ═══════════════════════════════════════════════════════════════════════════
 * js/upper-atmosphere-sat-suites.js against the COMMITTED SGP4 WASM (the
 * propagator the page's catalogue dots are drawn with), so a ring that does
 * not pass through its own satellite fails here and not in a screenshot.
 *
 *   · element parsing: TLE lines and normalised OMM fields give one answer
 *   · the recovered semi-major axis matches SGP4's mean radius (not μ/n²)
 *   · J2 node regression is the textbook ISS rate (≈ −5.0°/day)
 *   · the ring passes within RING_TOL_KM of the SGP4 position over a day of
 *     sim time, for LEO (ISS), MEO (GPS) and HEO (Molniya) — MEASURED, and a
 *     NEGATIVE CONTROL with the J2 node drift removed must fail it
 *   · temeToScene is coords.js eciToEcef (transcribed both ways) and the
 *     GMST=0 build + rotation.y = −GMST equals a direct build
 *   · ladder: counts conserve, layers come from the engine, gaps are skipped
 *   · framing fits the BINDING half-angle (portrait is the hard case)
 *   · catalogue drift: every suite id is a route group AND a tracker colour
 *
 * Run: node tests/upper-atmosphere-sat-suites.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    SAT_SUITES, SUITE_CATEGORIES, meanElements, elementsAt, orbitRingTeme, meanPositionTeme,
    temeToScene, gmstRad, orbitRingInertialScene, ringRotationY, ringToSegments, distanceToRing,
    ringSample, orbitRegime, altitudeLadder, outerShellKm, framingDistance, FRAME_PRESETS,
    LADDER_LAYERS, layerIdAt, RE_KM, SCENE_RE_KM, perifocalTable, inertialSceneAt,
} from '../js/upper-atmosphere-sat-suites.js';
import { PAGE_RE_KM, CATALOG_RE_KM } from '../js/upper-atmosphere-datum.js';

const here = (p) => new URL(p, import.meta.url);
const wasm = await import('../js/sgp4-wasm/sgp4_wasm.js');
await wasm.default({ module_or_path: await readFile(here('../js/sgp4-wasm/sgp4_wasm_bg.wasm')) });

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// The ISS element set every SGP4 tutorial uses (checksums valid).
const ISS = ['1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
             '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537'];
const VER = (await readFile(here('./fixtures/sgp4/SGP4-VER.TLE'), 'utf8')).split('\n');
const fromVer = (norad) => {
    const i = VER.findIndex((l) => l.startsWith(`1 ${String(norad).padStart(5, '0')}`));
    return [VER[i].slice(0, 69), VER[i + 1].slice(0, 69)];
};
const GPS = fromVer(28129);      // a 12 h GPS orbit
const MOLNIYA = fromVer(8195);   // e ≈ 0.68, 12 h

const sgp4 = ([l1, l2], el, ms) => {
    const s = wasm.propagate_tle(l1, l2, (ms - el.epochMs) / 60000);
    return [s[0], s[1], s[2]];
};

console.log('upper-atmosphere-sat-suites');

ok('TLE and OMM give the same elements', () => {
    const a = meanElements({ line1: ISS[0], line2: ISS[1] });
    const jd = a.epochMs / 86400000 + 2440587.5;
    const b = meanElements({ norad_id: 25544, epoch_jd: jd, inclination: 51.6416, raan: 247.4627,
        eccentricity: 0.0006703, arg_perigee: 130.536, mean_anomaly: 325.0288, mean_motion: 15.72125391 });
    assert.equal(a.norad, 25544);
    for (const k of ['inc', 'raan0', 'ecc', 'argp0', 'm0', 'n', 'aKm']) {
        assert.ok(Math.abs(a[k] - b[k]) < 1e-9 * Math.max(1, Math.abs(a[k])), `${k}: ${a[k]} vs ${b[k]}`);
    }
    assert.equal(meanElements({ line1: 'junk', line2: 'junk' }), null);
    assert.equal(meanElements(null), null);
    assert.equal(meanElements({ inclination: 50, raan: 1, eccentricity: 1.2, arg_perigee: 0,
        mean_anomaly: 0, mean_motion: 15, epoch_jd: 2460000 }), null, 'hyperbolic is not an orbit');
});

const iss = meanElements({ line1: ISS[0], line2: ISS[1] });
const gps = meanElements({ line1: GPS[0], line2: GPS[1] });
const mol = meanElements({ line1: MOLNIYA[0], line2: MOLNIYA[1] });

ok('semi-major axis is SGP4\'s, ISS node regresses at the textbook rate', () => {
    // Mean |r| over one SGP4 orbit vs the kernel's a (circular orbit ⇒ ≈ a).
    let sum = 0; const N = 360;
    for (let i = 0; i < N; i++) {
        const r = sgp4(ISS, iss, iss.epochMs + (i / N) * iss.periodMin * 60000);
        sum += Math.hypot(...r);
    }
    const dA = sum / N - iss.aKm;
    console.log(`      ISS a = ${iss.aKm.toFixed(2)} km, SGP4 mean |r| − a = ${dA.toFixed(2)} km`);
    assert.ok(Math.abs(dA) < 3, `mean radius off by ${dA} km`);
    // −1.5·n·J2·(Re/p)²·cos i at this element set's ~353 km (2008) is
    // −5.12°/day; the oft-quoted −5.0 is the 400 km figure.
    const degPerDay = iss.raanDot * 1440 / (Math.PI / 180);
    assert.ok(degPerDay < -5.05 && degPerDay > -5.2, `ISS node rate ${degPerDay}°/day`);
    assert.equal(orbitRegime(iss), 'LEO');
    assert.equal(orbitRegime(gps), 'MEO');
    assert.equal(orbitRegime(mol), 'HEO');
});

const RING_TOL_KM = { LEO: 20, MEO: 40, HEO: 60 };
const worstRingKm = (tle, el, { noDrift = false } = {}) => {
    let worst = 0;
    for (let h = 0; h <= 24; h += 1.5) {
        const ms = el.epochMs + h * 3600e3;
        const e2 = noDrift ? { ...el, raanDot: 0, argpDot: 0 } : el;
        const ring = orbitRingTeme(e2, ms, 256);
        worst = Math.max(worst, distanceToRing(sgp4(tle, el, ms), ring));
    }
    return worst;
};
ok('the ring passes through its own SGP4 satellite (LEO / MEO / HEO, 24 h)', () => {
    for (const [name, tle, el] of [['LEO', ISS, iss], ['MEO', GPS, gps], ['HEO', MOLNIYA, mol]]) {
        const w = worstRingKm(tle, el);
        console.log(`      ${name}: worst SGP4-to-ring ${w.toFixed(2)} km (gate ${RING_TOL_KM[name]})`);
        assert.ok(w < RING_TOL_KM[name], `${name} ring misses SGP4 by ${w} km`);
    }
});

ok('NEGATIVE CONTROL: without the J2 drift the LEO ring misses by far more', () => {
    const w = worstRingKm(ISS, iss, { noDrift: true });
    console.log(`      LEO, no J2 drift: worst ${w.toFixed(1)} km`);
    assert.ok(w > 5 * RING_TOL_KM.LEO, `control should fail, got ${w} km`);
});

ok('mean position is on its ring and near SGP4 at epoch', () => {
    const p = meanPositionTeme(iss, iss.epochMs);
    assert.ok(distanceToRing(p, orbitRingTeme(iss, iss.epochMs, 512)) < 0.5);
    const d = Math.hypot(...p.map((v, i) => v - sgp4(ISS, iss, iss.epochMs)[i]));
    assert.ok(d < 30, `epoch position differs from SGP4 by ${d} km`);
});

ok('temeToScene is coords.js eciToEcef; GMST=0 build + rotation.y equals a direct build', () => {
    // coords.js: ecef = Rz(−g)·teme, scene = (xE, zE, −yE). Transcribed independently:
    const eciToEcef = (v, g) => {
        const c = Math.cos(g), s = Math.sin(g);
        return [c * v[0] + s * v[1], v[2], -(-s * v[0] + c * v[1])];
    };
    const v = [4000, -5200, 2100], g = 1.234;
    const a = temeToScene(...v, g), b = eciToEcef(v, g).map((x) => x / SCENE_RE_KM);
    a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-12));
    // North (TEME +z) is scene +Y; 90°E at gmst 0 (TEME +y) is scene −Z.
    assert.deepEqual(temeToScene(0, 0, SCENE_RE_KM, 0).map((x) => +x.toFixed(12)), [0, 1, 0]);
    assert.deepEqual(temeToScene(0, SCENE_RE_KM, 0, 0).map((x) => +x.toFixed(12)), [0, 0, -1]);
    // rotation about +Y by θ: x' = cosθ x + sinθ z, z' = −sinθ x + cosθ z.
    const ms = iss.epochMs + 5 * 3600e3, gm = gmstRad(ms), th = ringRotationY(gm);
    const inertial = orbitRingInertialScene(iss, ms, 64), teme = orbitRingTeme(iss, ms, 64);
    for (let i = 0; i < 64; i++) {
        const X = inertial[i * 3], Y = inertial[i * 3 + 1], Z = inertial[i * 3 + 2];
        const rot = [Math.cos(th) * X + Math.sin(th) * Z, Y, -Math.sin(th) * X + Math.cos(th) * Z];
        const direct = temeToScene(teme[i * 3], teme[i * 3 + 1], teme[i * 3 + 2], gm);
        rot.forEach((x, k) => assert.ok(Math.abs(x - direct[k]) < 1e-5, `vertex ${i}`));
    }
    const seg = ringToSegments(inertial);
    assert.equal(seg.length, 64 * 6);
    assert.deepEqual([...seg.slice(-3)], [...inertial.slice(0, 3)], 'closed');
});

ok('altitudes are above the PAGE datum; scene unit is the page radius', () => {
    assert.equal(SCENE_RE_KM, PAGE_RE_KM);
    assert.ok(Math.abs(iss.meanAltKm - (iss.aKm - PAGE_RE_KM)) < 1e-9);
    assert.ok(Math.abs(iss.meanAltKm - (iss.aKm - CATALOG_RE_KM) - (CATALOG_RE_KM - PAGE_RE_KM)) < 1e-9);
    // A ring vertex's scene radius IS its geocentric radius / 6371.
    const ring = orbitRingInertialScene(iss, iss.epochMs, 8);
    const teme = orbitRingTeme(iss, iss.epochMs, 8);
    for (let i = 0; i < 8; i++) {
        const rS = Math.hypot(ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]);
        const rK = Math.hypot(teme[i * 3], teme[i * 3 + 1], teme[i * 3 + 2]);
        assert.ok(Math.abs(rS * PAGE_RE_KM - rK) < 1e-3, `vertex ${i}`);
    }
});

ok('table-based inertialSceneAt matches the exact solve (screener path)', () => {
    let worst = 0;
    for (const el of [iss, gps, mol]) {
        const tbl = perifocalTable(el, 256);
        for (let h = 0; h < 48; h += 0.37) {
            const ms = el.epochMs + h * 3600e3;
            const a = inertialSceneAt(el, ms, tbl), b = inertialSceneAt(el, ms);
            const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * PAGE_RE_KM;
            if (el === iss) worst = Math.max(worst, d);
            // And the exact path IS meanPositionTeme mapped through temeToScene at GMST 0.
            const t = meanPositionTeme(el, ms), s = temeToScene(t[0], t[1], t[2], 0);
            assert.ok(Math.hypot(b[0] - s[0], b[1] - s[1], b[2] - s[2]) * PAGE_RE_KM < 1e-6);
        }
    }
    console.log(`      LEO table vs exact: worst ${worst.toFixed(3)} km`);
    assert.ok(worst < 0.6, `LEO table error ${worst} km`);
});

ok('GMST matches the IAU-1982 value at J2000', () => {
    // At JD 2451545.0 (2000-01-01 12:00 UT) GMST = 280.46061837°.
    const g = gmstRad(Date.UTC(2000, 0, 1, 12)) * 180 / Math.PI;
    assert.ok(Math.abs(g - 280.46061837) < 1e-4, `GMST ${g}`);
});

ok('ring sample spreads across planes and is deterministic', () => {
    // 6 planes × 10 sats, GPS-like: a 6-ring sample must hit 6 distinct planes.
    const els = [];
    for (let p = 0; p < 6; p++) for (let k = 0; k < 10; k++) {
        els.push(meanElements({ norad_id: p * 100 + k, epoch_jd: 2460000.5, inclination: 55, raan: p * 60,
            eccentricity: 0.001, arg_perigee: 0, mean_anomaly: k * 36, mean_motion: 2.0056 }));
    }
    const ms = (2460000.5 - 2440587.5) * 86400000;
    const pick = ringSample(els, 6, ms);
    const planes = new Set(pick.map((e) => Math.round(e.raan0 * 180 / Math.PI)));
    assert.equal(planes.size, 6, `planes ${[...planes]}`);
    assert.deepEqual(pick.map((e) => e.norad), ringSample(els, 6, ms).map((e) => e.norad));
    assert.equal(ringSample(els.slice(0, 3), 6, ms).length, 3);
});

ok('ladder conserves counts, uses the engine layers, skips gaps', () => {
    const els = [iss, gps, mol, { meanAltKm: NaN }, null, { meanAltKm: 100, apogeeKm: 110, ecc: 0 },
        { meanAltKm: 700, apogeeKm: 705, ecc: 0.001 }];
    const L = altitudeLadder(els, { minKm: 150, maxKm: 2000, binKm: 50 });
    const inBins = L.bins.reduce((s, b) => s + b.count, 0);
    assert.equal(L.total, 5, 'NaN and null skipped, never zero');
    assert.equal(inBins + L.below + L.above, L.total);
    assert.equal(L.below, 1); assert.equal(L.above, 2);
    assert.equal(L.layers.thermosphere, 2);             // ISS + the 100 km object
    assert.equal(L.layers.exosphere, 1);                // the 700 km object
    assert.equal(L.layers.beyond, 2);                   // GPS + Molniya: past the engine's exosphere top
    assert.equal(L.regimes.LEO, 3); assert.equal(L.regimes.MEO, 1); assert.equal(L.regimes.HEO, 1);
    assert.equal(L.bins[0].loKm, 150); assert.equal(L.bins.at(-1).hiKm, 2000);
    assert.equal(L.peak, 1);
    // Layer boundaries are the engine's, not typed here.
    const thermo = LADDER_LAYERS.find((l) => l.id === 'thermosphere');
    assert.equal(layerIdAt(thermo.maxKm - 1), 'thermosphere');
    assert.equal(layerIdAt(thermo.maxKm + 1), 'exosphere');
    assert.equal(L.bins.find((b) => b.loKm === 400).layer, 'thermosphere');
    assert.ok(Math.abs(outerShellKm([iss, gps], 1) - gps.apogeeKm) < 1e-9);
    assert.equal(outerShellKm([]), null);
});

ok('framing fits the binding half-angle, portrait included', () => {
    for (const aspect of [16 / 9, 9 / 16, 1]) {
        for (const p of FRAME_PRESETS) {
            const f = framingDistance({ outerKm: p.outerKm, fovDeg: 40, aspect, maxR: 200 });
            const ang = Math.asin(f.shellR / f.distance);
            const hv = 20 * Math.PI / 180, hh = Math.atan(Math.tan(hv) * aspect);
            assert.ok(ang <= Math.min(hv, hh) + 1e-12, `${p.id} @${aspect.toFixed(2)} overflows`);
            assert.ok(ang >= 0.8 * Math.min(hv, hh), `${p.id} @${aspect.toFixed(2)} needlessly far`);
        }
    }
    // GEO from the page's default lens and range: in range, and behind the home view.
    const geo = framingDistance({ outerKm: 36500, fovDeg: 40, aspect: 16 / 9 });
    assert.ok(!geo.clamped && geo.distance > 3.4 && geo.distance < 28, `GEO frame ${geo.distance}`);
    assert.ok(framingDistance({ outerKm: 36500, maxR: 10 }).clamped);
});

{
    const route = await readFile(here('../api/celestrak/tle.js'), 'utf8');
    const tracker = await readFile(here('../js/satellite-tracker.js'), 'utf8');
    const ids = new Set(SAT_SUITES.map((s) => s.id));
    assert.equal(ids.size, SAT_SUITES.length, 'unique ids');
    const cats = new Set(SUITE_CATEGORIES.map((c) => c.id));
    for (const s of SAT_SUITES) {
        assert.ok(cats.has(s.category), `${s.id}: unknown category ${s.category}`);
        assert.ok(new RegExp(`'${s.id}'\\s*:`).test(route), `${s.id} is not a /api/celestrak/tle group`);
        assert.ok(new RegExp(`'${s.id}'\\s*:\\s*new THREE\\.Color`).test(tracker), `${s.id} has no tracker colour`);
    }
    for (const c of cats) assert.ok(SAT_SUITES.some((s) => s.category === c), `empty category ${c}`);
    passed++; console.log('  ✓ catalogue: every suite is a route group and a tracker colour');
}

assert.ok(RE_KM > 6378 && RE_KM < 6379);
console.log(`\n${passed} passed`);
