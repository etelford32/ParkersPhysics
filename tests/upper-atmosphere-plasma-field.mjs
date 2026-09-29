/**
 * tests/upper-atmosphere-plasma-field.mjs — how thick the plasma is, and why
 *   node tests/upper-atmosphere-plasma-field.mjs
 *
 * Gates the PURE kernels js/upper-atmosphere-plasma-field.js and
 * js/upper-atmosphere-tid.js: the vertical stack IS ring-current.html's
 * (columnProfile), the TEC integral agrees with the α-Chapman closed form,
 * the equatorial crests / plasma bubbles come from the shared fountain, the
 * night-side trough sits on ring-current-efield's TEARDROP plasmapause, a
 * southward turning's prompt penetration lifts the crests, the TIDs travel
 * the way the observations say (LSTIDs equatorward, MSTIDs south-west in the
 * north and north-west in the south) and close on themselves at the date
 * line — and the GLSL mirrors, transliterated back into JS here, give the
 * kernel's numbers.
 */
import assert from 'node:assert/strict';
import {
    PLASMA, PLASMA_GLSL, PLASMA_RAMP, plasmaColour, invariantLatDeg, mltAt,
    zenithCorrection, stackPeaks, eiaFactor, troughFactor, bubbleTecFactor,
    plasmaFieldAt, chapman, neAt, vtec, slantTec, tecDisplay, IonosphereDriver,
} from '../js/upper-atmosphere-plasma-field.js';
import { TID, TID_GLSL, lstidAmp, mstidWave, tidPhases, tidField } from '../js/upper-atmosphere-tid.js';
import { columnProfile, dayFactor } from '../js/ionosphere-descent.js';
import { boundaryL, mltToPhi, driverAmplitude } from '../js/ring-current-efield.js';
import { ovalCenterMaglat } from '../js/ionosphere-cells.js';
import { magneticLatitude, R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM, latLonToScene } from '../js/upper-atmosphere-column.js';
import { NO_ARCS, FountainSampler, latForMagLat, AIRGLOW_FIELD } from '../js/upper-atmosphere-airglow-field.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const rel = (a, b, tol, msg) => close(a, b, tol * Math.max(Math.abs(a), Math.abs(b), 1e-30), msg);

// ── A tiny GLSL → JS transliteration, enough for the mirrors' straight-line
// code: typed declarations become lets, functions become functions, vecN()
// becomes an object with xyzw / rgba swizzles, and the built-ins are JS.
function vec(...a) {
    const v = a.length === 1 ? [a[0], a[0], a[0], a[0]] : a;
    return { x: v[0], y: v[1], z: v[2], w: v[3], r: v[0], g: v[1], b: v[2], a: v[3] };
}
const BUILTINS = {
    abs: Math.abs, exp: Math.exp, cos: Math.cos, sin: Math.sin, sqrt: Math.sqrt,
    floor: Math.floor, log2: Math.log2, max: Math.max, min: Math.min,
    clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
    smoothstep: (e0, e1, x) => { const q = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return q * q * (3 - 2 * q); },
    mod: (x, y) => x - y * Math.floor(x / y),
    radians: (d) => d * Math.PI / 180, degrees: (r) => r * 180 / Math.PI,
    vec2: vec, vec3: vec, vec4: vec,
};
function glslModule(src, names, env) {
    let js = src
        .split('\n')
        .filter((l) => !/^\s*uniform\b/.test(l))
        .join('\n')
        .replace(/^(?:float|vec[234]|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm,
            (_, n, args) => `function ${n}(${args.split(',').map((a) => a.trim().split(/\s+/).pop()).filter(Boolean).join(', ')}) {`)
        .replace(/\b(?:float|vec[234]|int)\s+(\w+)\s*=/g, 'let $1 =')
        .replace(/\b(\d+)\.(?!\d)/g, '$1.0');
    // Uniforms are read through U at CALL time, so a test can change them.
    for (const k of Object.keys(env)) js = js.replace(new RegExp(`\\b${k}\\b`, 'g'), `U.${k}`);
    const keys = Object.keys(BUILTINS);
    // eslint-disable-next-line no-new-func
    return new Function(...keys, 'U', `${js}\nreturn { ${names.join(', ')} };`)(
        ...Object.values(BUILTINS), env);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── the vertical stack is the ring-current page\'s ──');
t('stackPeaks is columnProfile scaled: same F2 height, same relative densities, same storm loss', () => {
    for (const kp of [0, 3, 5, 7, 9]) for (let lt = 0; lt < 24; lt += 1.5) {
        const prof = Object.fromEntries(columnProfile(lt, kp).map((l) => [l.key, l]));
        const p = stackPeaks({ lstHr: lt, kp, f107Sfu: 150 });
        assert.equal(p.hmF2, prof.F2.altKm);
        rel(p.NmF2 / PLASMA.nmF2RefM3, prof.F2.density, 1e-12, `F2 lt=${lt} kp=${kp}`);
        rel(p.NmE / PLASMA.nmERefM3, prof.E.density, 1e-12, 'E');
        close(p.NmF1 / PLASMA.nmF1RefM3, prof.F1.density, 1e-12, 'F1');
        assert.equal(p.stormLoss, prof.F2.note.includes('negative storm'));
    }
    // The layer heights the Chapman shapes use are the stack's own.
    const prof = Object.fromEntries(columnProfile(12, 2).map((l) => [l.key, l]));
    assert.equal(PLASMA.hmEKm, prof.E.altKm);
    assert.equal(PLASMA.hmF1Km, prof.F1.altKm);
});
t('the zenith correction swaps the stack\'s day term for floor + (1 − floor)·√cos χ: noon unchanged, night at the floor', () => {
    const fl = PLASMA.f2NightFloor;
    for (let lt = 0; lt < 24; lt += 2) {
        const d = dayFactor(lt);
        // The corrected F2 term at cos χ = day² is floor + (1 − floor)·day.
        rel(zenithCorrection(d * d, lt) * (0.65 + 0.35 * d), fl + (1 - fl) * d, 1e-12, `lt=${lt}`);
    }
    close(zenithCorrection(1, 12), 1, 1e-12, 'overhead noon is the stack\'s own value');
    // Winter pole at noon (sun below the horizon) is at the night floor.
    close(zenithCorrection(-0.2, 12), fl, 1e-12);
    assert.ok(fl > 0.2 && fl < 0.45, 'observed mid-latitude day:night NmF2 contrast');
});
t('F10.7 scales every layer as (F/150)^0.9, floored at 60 sfu', () => {
    const a = stackPeaks({ lstHr: 12, f107Sfu: 150 }), b = stackPeaks({ lstHr: 12, f107Sfu: 250 });
    rel(b.NmF2 / a.NmF2, Math.pow(250 / 150, 0.9), 1e-12);
    rel(b.NmE / a.NmE, Math.pow(250 / 150, 0.9), 1e-12);
    const c = stackPeaks({ lstHr: 12, f107Sfu: 20 }), d = stackPeaks({ lstHr: 12, f107Sfu: 60 });
    assert.equal(c.NmF2, d.NmF2);
});

console.log('\n── the column ──');
t('an α-Chapman layer integrates to √(2πe)·Nm·H', () => {
    let s = 0;
    const dz = 1e-3;
    for (let z = -30; z < 60; z += dz) s += chapman(z, 1, 0, 1) * dz;
    rel(s, Math.sqrt(2 * Math.PI * Math.E), 1e-6);
});
t('vTEC over 80–2000 km matches the two-sided closed form for a pure F2 layer', () => {
    // Independent: ∫ chapman(z) over each side of the peak, in z, times each side's H.
    const sideInt = (lo, hi) => { let s = 0; const dz = 1e-4; for (let z = lo; z < hi; z += dz) s += chapman(z + dz / 2, 1, 0, 1) * dz; return s; };
    const p = { NmF2: 1e12, hmF2: 300, NmF1: 0, NmE: 0 };
    const H1 = PLASMA.hF2Bottom, H2 = PLASMA.hF2Top;
    const want = 1e12 * (H1 * sideInt((MODEL_FLOOR_KM - 300) / H1, 0) + H2 * sideInt(0, (MODEL_CEIL_KM - 300) / H2)) * 1000 / 1e16;
    rel(vtec(p), want, 2e-5);
});
t('typical values: midday mid-latitude vTEC 20–60 TECU at F10.7 150, midnight 3–15, higher in the crests', () => {
    const day = plasmaFieldAt({ latDeg: 40, lonDeg: 0, cosChi: 0.7, lstHr: 12, kp: 2 });
    const night = plasmaFieldAt({ latDeg: 40, lonDeg: 0, cosChi: -0.8, lstHr: 0, kp: 2 });
    const vd = vtec(day), vn = vtec(night);
    assert.ok(vd > 20 && vd < 60, `day ${vd}`);
    assert.ok(vn > 3 && vn < 15, `night ${vn}`);
    const lat = latForMagLat(15, -60);
    const crest = plasmaFieldAt({ latDeg: lat, lonDeg: -60, cosChi: 0.8, lstHr: 14, kp: 2,
        arcs: { crest: 1, crestLatDeg: 15, bubble: 0, bubbleExtentDeg: 0 } });
    const vc = vtec(crest);
    assert.ok(vc > 1.8 * vtec({ ...crest, NmF2: crest.NmF2Base }), `crest ${vc}`);
    console.log(`      day ${vd.toFixed(1)} · night ${vn.toFixed(1)} · crest ${vc.toFixed(1)} TECU`);
});
t('slant TEC: a vertical ray is vTEC, a limb ray is many times it, and the display is log over the stated TECU range', () => {
    const p = plasmaFieldAt({ latDeg: 0, lonDeg: 0, cosChi: 1, lstHr: 12, kp: 2 });
    const fieldAtUnit = () => p;
    const ro = [1 + 30000 / R_EARTH_KM, 0, 0];
    const vert = slantTec({ ro, rd: [-1, 0, 0], fieldAtUnit });
    rel(vert, vtec(p), 2e-3);
    // Tangent at 250 km.
    const rT = 1 + 250 / R_EARTH_KM, d = 3;
    const limb = slantTec({ ro: [rT, -d, 0], rd: [0, 1, 0], fieldAtUnit });
    assert.ok(limb > 8 * vert, `limb ${limb} vs vertical ${vert}`);
    const lo = 10 ** PLASMA.tecLogMin, hi = 10 ** PLASMA.tecLogMax;
    close(tecDisplay(lo), 0, 1e-12); close(tecDisplay(hi), 1, 1e-12); close(tecDisplay(Math.sqrt(lo * hi)), 0.5, 1e-9);
    close(tecDisplay(0.1 * lo), 0, 1e-12); close(tecDisplay(10 * hi), 1, 1e-12);
    // Night vTEC (~3–10) sits well off the floor, daytime crests below saturation.
    assert.ok(tecDisplay(5) > 0.25 && tecDisplay(60) < 0.8);
});

console.log('\n── horizontal structure ──');
t('the equatorial anomaly: crests at ±crest latitude, a trough at the dip equator, nothing without a crest', () => {
    const at = (ml) => eiaFactor(ml, 1, 14);
    assert.ok(at(14) > 2 && at(-14) > 2);
    assert.ok(at(0) < at(14) && at(0) < 1);
    for (const ml of [-40, 0, 14, 40]) close(eiaFactor(ml, 0, 14), 1, 1e-12);
});
t('plasma bubbles deplete TEC inside the wedge only', () => {
    close(bubbleTecFactor(5, 1, 15), 1 - PLASMA.bubbleDepth, 1e-12);
    close(bubbleTecFactor(25, 1, 15), 1, 1e-12);
    close(bubbleTecFactor(5, 0, 15), 1, 1e-12);
});
t('the trough sits just poleward of the plasmapause, at night only', () => {
    const pp = 55;
    let best = 0, bestV = 2;
    for (let ml = 40; ml < 75; ml += 0.05) { const v = troughFactor(ml, pp, 1); if (v < bestV) { bestV = v; best = ml; } }
    close(best, pp + PLASMA.troughOffsetDeg, 0.05);
    close(bestV, 1 - PLASMA.troughDepth, 1e-6);
    close(troughFactor(-best, pp, 1), bestV, 1e-9, 'both hemispheres');
    close(troughFactor(best, pp, 0), 1, 1e-12, 'day');
    close(troughFactor(best, null, 1), 1, 1e-12, 'no plasmapause known');
});

console.log('\n── the ring-current electric field drives it ──');
const HOUR = 3.6e6;
const T0 = Date.UTC(2026, 2, 20, 0, 0, 0);
function driven({ kp, vbs, hours = 0, stepMin = 10, from = T0, driver = new IonosphereDriver({ width: 360 }) }) {
    driver.advanceTo(from, { kp, vbs });
    for (let m = stepMin; m <= hours * 60; m += stepMin) driver.advanceTo(from + m * 60e3, { kp, vbs });
    return driver;
}
t('the plasmapause table is the TEARDROP: invariant latitude of boundaryL at each longitude\'s MLT', () => {
    const d = driven({ kp: 4, vbs: 1 });
    const A = d.efield().A_sh;
    close(A, driverAmplitude(4, 1), 1e-12, 'starts shielded, at equilibrium');
    const ut = 0;
    for (const lon of [-150, -60, 0, 45, 90, 179]) {
        const mlt = mltAt(lon, ut);
        const want = invariantLatDeg(boundaryL(mltToPhi(mlt), A));
        close(d.plasmapauseAt(lon), want, 0.15, `lon ${lon} mlt ${mlt}`);
    }
});
t('dusk bulge: the plasmapause footprint is further poleward at 18 MLT than at 06 MLT', () => {
    const d = driven({ kp: 4, vbs: 2 });
    const lonDusk = 18 * 15, lonDawn = 6 * 15;   // UT 0
    const at = (lon) => d.plasmapauseAt(((lon + 180) % 360) - 180);
    assert.ok(at(lonDusk) > at(lonDawn) + 1, `dusk ${at(lonDusk)} dawn ${at(lonDawn)}`);
});
t('a storm pulls the plasmapause (and the trough) equatorward', () => {
    const quiet = driven({ kp: 1, vbs: 0.3 }), storm = driven({ kp: 7, vbs: 6 });
    const q = quiet.plasmapauseAt(0), s = storm.plasmapauseAt(0);   // local midnight at UT 0
    assert.ok(s < q - 5, `storm ${s} vs quiet ${q}`);
    const at = (d) => plasmaFieldAt({ latDeg: latForMagLat(s + 2, 0), lonDeg: 0, cosChi: -0.9, lstHr: 0, kp: 7,
        ppInvLatDeg: d.plasmapauseAt(0) });
    assert.ok(at(storm).factors.trough < 0.5 && at(quiet).factors.trough > 0.95);
    assert.equal(at(storm).regime, 'mid-latitude trough');
});
t('a southward turning penetrates: ΔA > 0 lifts the dusk crests above the same Kp without it', () => {
    // Both runs sit at the same Kp; one sees VBs jump 0.5 → 8 mV/m at 18 UT.
    const turnAt = T0 + 18 * HOUR;
    const base = driven({ kp: 3, vbs: 0.5, hours: 18 });
    const ctrl = driven({ kp: 3, vbs: 0.5, hours: 18 });
    let maxDA = 0;
    for (let m = 5; m <= 90; m += 5) {
        base.advanceTo(turnAt + m * 60e3, { kp: 3, vbs: 8 });
        ctrl.advanceTo(turnAt + m * 60e3, { kp: 3, vbs: 0.5 });
        maxDA = Math.max(maxDA, base.efield().dA);
    }
    assert.ok(maxDA > 0.3, `penetration ΔA ${maxDA}`);
    assert.ok(Math.abs(ctrl.efield().dA) < 1e-9, 'control stays shielded');
    // Evening sector at 19:30 UT: 19–22 LT is lon ≈ 0…40°E.
    const crestMax = (d) => { let m = 0; for (let lon = -10; lon <= 45; lon += 1) m = Math.max(m, d.sampler.sampleAt(lon).crest); return m; };
    const cb = crestMax(base), cc = crestMax(ctrl);
    assert.ok(cb > cc * 1.05, `penetrated crest ${cb} vs control ${cc}`);
    console.log(`      ΔA peak ${maxDA.toFixed(2)} kV/R_E² · evening crest ${cc.toFixed(3)} → ${cb.toFixed(3)}`);
});
t('a driver change at the SAME instant (a preset) re-equilibrates: the plasmapause moves, ΔA stays 0', () => {
    const d = driven({ kp: 2, vbs: 0.5, hours: 3 });
    const before = d.plasmapauseAt(0);
    assert.equal(d.advanceTo(d.timeMs, { kp: 8, vbs: 0.5 }), true);
    close(d.efield().dA, 0, 1e-12);
    close(d.efield().A_sh, driverAmplitude(8, 0.5), 1e-12);
    assert.ok(d.plasmapauseAt(0) < before - 5, `${d.plasmapauseAt(0)} vs ${before}`);
    assert.equal(d.sampler.fountain._kp, 8, 'the fountain takes the new Kp (disturbance dynamo)');
});
t('a clock jump re-spins shielded (ΔA = 0) and a repeated instant changes nothing', () => {
    const d = driven({ kp: 3, vbs: 0.5, hours: 2 });
    d.advanceTo(T0 + 2 * HOUR + 60e3, { kp: 3, vbs: 8 });
    assert.ok(d.efield().dA > 0);
    assert.equal(d.advanceTo(d.timeMs), false);
    d.advanceTo(T0 + 40 * HOUR, { kp: 3, vbs: 8 });
    close(d.efield().dA, 0, 1e-12);
});

console.log('\n── travelling ionospheric disturbances ──');
t('LSTID amplitude is zero in quiet time and rises with Kp to ampMax', () => {
    assert.equal(lstidAmp(2), 0); assert.equal(lstidAmp(3), 0);
    assert.ok(lstidAmp(5) > 0 && lstidAmp(5) < lstidAmp(7));
    close(lstidAmp(9), TID.lstid.ampMax, 1e-12);
    const q = tidField({ magLatDeg: 50, latDeg: 50, lonDeg: 0, mltHr: 0, night: 0, kp: 2 });
    assert.equal(q.lstid, 0);
});
t('LSTID fronts lie along magnetic latitude and travel EQUATORWARD at the stated speed', () => {
    const kp = 7, mlt = 0;
    const oval = ovalCenterMaglat(mlt, kp);
    // Crest (max of δ/envelope) nearest 1500 km equatorward of the oval.
    const crestAt = (tSec) => {
        const ph = tidPhases(tSec);
        let best = null, bestV = -Infinity;
        for (let dKm = 1000; dKm < 2500; dKm += 0.5) {
            const ml = oval - dKm / 111.195;
            const a = tidField({ magLatDeg: ml, latDeg: ml, lonDeg: 0, mltHr: mlt, night: 1, kp, phases: ph });
            const env = Math.cos(2 * Math.PI * dKm / TID.lstid.lambdaKm - ph.lstid);
            // Where the cosine factor peaks is where the wave's crest is.
            if (env > bestV) { bestV = env; best = dKm; }
            if (Math.abs(a.lstid) > lstidAmp(kp)) throw new Error('amplitude above ampMax');
        }
        return best;
    };
    const dt = 600;
    const moved = crestAt(dt) - crestAt(0);
    close(moved, TID.lstid.speedMs * dt / 1000, 1.5, 'km equatorward in 10 min');
    // Fronts follow MAGNETIC latitude: the same magnetic latitude at MLTs
    // where the oval sits at the same place is the same point on the wave,
    // whatever the geographic latitude and longitude.
    const ph = tidPhases(777);
    const a = tidField({ magLatDeg: 45, latDeg: 40, lonDeg: 10, mltHr: 6, night: 1, kp, phases: ph });
    const b = tidField({ magLatDeg: 45, latDeg: 52, lonDeg: 100, mltHr: 18, night: 1, kp, phases: ph });
    assert.ok(Math.abs(a.lstid) > 1e-3);
    close(a.lstid, b.lstid, 1e-12);
});
t('LSTIDs decay away from the oval and are weaker on the day side', () => {
    const kp = 8, oval = ovalCenterMaglat(0, kp);
    const envAt = (dKm, night) => {
        let m = 0;
        for (let s = 0; s < 20; s++) {
            const ph = tidPhases(s * 300);
            const ml = oval - dKm / 111.195;
            m = Math.max(m, Math.abs(tidField({ magLatDeg: ml, latDeg: ml, lonDeg: 0, mltHr: 0, night, kp, phases: ph }).lstid));
        }
        return m;
    };
    assert.ok(envAt(800, 1) > envAt(4000, 1) * 1.8);
    rel(envAt(800, 0) / envAt(800, 1), TID.lstid.dayFloor, 0.02);
});
t('MSTIDs: night-only, mid-latitude band, integer zonal wavenumber closes at the date line', () => {
    const { m } = mstidWave();
    assert.ok(Number.isInteger(m) && m !== 0);
    const ph = tidPhases(1234);
    for (const lat of [30, 40, -35]) {
        const ml = lat;
        const a = tidField({ magLatDeg: ml, latDeg: lat, lonDeg: -180, mltHr: 0, night: 1, kp: 2, phases: ph });
        const b = tidField({ magLatDeg: ml, latDeg: lat, lonDeg: 180, mltHr: 0, night: 1, kp: 2, phases: ph });
        close(a.mstid, b.mstid, 1e-9, `lat ${lat}`);
    }
    assert.equal(tidField({ magLatDeg: 35, latDeg: 35, lonDeg: 3, mltHr: 12, night: 0, kp: 2, phases: ph }).mstid, 0);
    assert.equal(tidField({ magLatDeg: 5, latDeg: 5, lonDeg: 3, mltHr: 0, night: 1, kp: 2, phases: ph }).mstid, 0);
    assert.equal(tidField({ magLatDeg: 70, latDeg: 70, lonDeg: 3, mltHr: 0, night: 1, kp: 2, phases: ph }).mstid, 0);
    // Wavelength within 3 % of the stated one at the reference latitude.
    const k = Math.hypot(m / (R_EARTH_KM * Math.cos(TID.mstid.refLatDeg * Math.PI / 180)), mstidWave().kN);
    rel(2 * Math.PI / k, TID.mstid.lambdaKm, 0.03);
});
t('MSTIDs travel SOUTH-WEST in the north and NORTH-WEST in the south', () => {
    // Follow a crest: the phase argument k·x − ωt is constant along it, so
    // a small time step moves the crest along +k by v·dt.
    const { m, kN } = mstidWave();
    const dt = 300, dPhase = tidPhases(dt).mstid - tidPhases(0).mstid;
    // Solve for the displacement along +k: with k_E = m/(R cos φ) per radian…
    for (const hemi of [1, -1]) {
        const lat0 = 35 * hemi;
        const kE = m / (R_EARTH_KM * Math.cos(lat0 * Math.PI / 180));   // rad per km east
        const kNh = hemi * kN;                                          // rad per km north
        const kk = kE * kE + kNh * kNh;
        const dEast = dPhase * kE / kk, dNorth = dPhase * kNh / kk;      // km
        const f0 = tidField({ magLatDeg: lat0, latDeg: lat0, lonDeg: 20, mltHr: 0, night: 1, kp: 2, phases: tidPhases(0) });
        const lat1 = lat0 + dNorth / 111.195;
        const lon1 = 20 + dEast / (111.195 * Math.cos(lat0 * Math.PI / 180));
        const f1 = tidField({ magLatDeg: lat1, latDeg: lat1, lonDeg: lon1, mltHr: 0, night: 1, kp: 2, phases: tidPhases(dt) });
        // The two samples are the same crest point (band factor differs by < 0.1 %).
        rel(f1.mstid, f0.mstid, 0.02, `hemi ${hemi}`);
        assert.ok(dEast < 0, 'westward');
        assert.ok(hemi > 0 ? dNorth < 0 : dNorth > 0, hemi > 0 ? 'southward in the north' : 'northward in the south');
        close(Math.hypot(dEast, dNorth), TID.mstid.speedMs * dt / 1000, 0.5, 'phase speed');
    }
});
t('MSTID bands fade out below ~4 pixels per wavelength; LSTIDs (1500 km) do not', () => {
    const at = (pixelKm, kp = 2) => tidField({ magLatDeg: 35, latDeg: 35, lonDeg: 3, mltHr: 0, night: 1, kp, phases: tidPhases(99), pixelKm });
    const full = at(0).mstid;
    assert.ok(Math.abs(full) > 1e-3);
    close(at(0.2 * TID.mstid.lambdaKm).mstid, full, 1e-12, 'resolved');
    assert.equal(at(0.6 * TID.mstid.lambdaKm).mstid, 0, 'sub-pixel');
    const L = at(0, 8).lstid;
    close(at(0.6 * TID.mstid.lambdaKm, 8).lstid, L, 1e-12);
});
t('phases are held in double precision and wrapped into [0, 2π)', () => {
    const p = tidPhases(1.8e9);
    assert.ok(p.lstid >= 0 && p.lstid < 2 * Math.PI && p.mstid >= 0 && p.mstid < 2 * Math.PI);
});

console.log('\n── the field at a location ──');
t('plasmaFieldAt multiplies the factors onto the shared stack and names what dominates', () => {
    const arcs = { crest: 1, crestLatDeg: 15, bubble: 1, bubbleExtentDeg: 18 };
    const lat = latForMagLat(8, -40);
    const p = plasmaFieldAt({ latDeg: lat, lonDeg: -40, cosChi: -0.6, lstHr: 22, kp: 2, arcs });
    const f = p.factors;
    rel(p.NmF2, p.NmF2Base * f.eia * f.trough * f.bubble * (1 + f.tid), 1e-12);
    assert.equal(p.regime, 'plasma bubble');
    const q = plasmaFieldAt({ latDeg: 0, lonDeg: 0, cosChi: 1, lstHr: 12, kp: 2 });
    assert.equal(q.regime, 'quiet F region');
});

console.log('\n── the GLSL mirrors, run back through JS ──');
t('no backticks, no pow(), every PLASMA / TID constant interpolated', () => {
    for (const [name, src] of [['PLASMA_GLSL', PLASMA_GLSL], ['TID_GLSL', TID_GLSL]]) {
        assert.ok(!src.includes('`'), `${name} has a backtick`);
        assert.ok(!/\bpow\s*\(/.test(src), `${name} uses pow`);
    }
    for (const k of ['hF2Bottom', 'hF2Top', 'hmF1Km', 'hmEKm', 'eiaGain', 'troughDepth', 'bubbleDepth']) {
        assert.ok(PLASMA_GLSL.includes(Number(PLASMA[k]).toPrecision(9)), k);
    }
    assert.ok(TID_GLSL.includes(Number(TID.lstid.lambdaKm).toPrecision(9)));
    assert.ok(TID_GLSL.includes(Number(mstidWave().m).toPrecision(9)));
});
const G_ENV = { kp: 6, ph: tidPhases(5432.1), f107: 180, sampler: null, driver: null };
const G = glslModule(TID_GLSL + '\n' + PLASMA_GLSL, ['tidDelta', 'plStack', 'plNe', 'plHorizontal', 'plDisplay'], {
    get uKp() { return G_ENV.kp; }, get uTidPhaseL() { return G_ENV.ph.lstid; }, get uTidPhaseM() { return G_ENV.ph.mstid; },
    get uTidAmpL() { return lstidAmp(G_ENV.kp); }, get uF107Solar() { return Math.pow(G_ENV.f107 / 150, PLASMA.f107Exp); },
    texture2D: (tex, tc) => tex(tc),
    uArcsTex: (tc) => { const s = G_ENV.sampler.sampleAt(tc.x * 360 - 180); return vec(s.crest, s.crestLatDeg, s.bubble, s.bubbleExtentDeg); },
    uPlasmapauseTex: (tc) => vec(G_ENV.driver.plasmapauseAt(tc.x * 360 - 180), 0, 0, 0),
});
t('tidDelta (GLSL) = tidField().total', () => {
    for (const kp of [2, 6, 8.5]) {
        G_ENV.kp = kp;
        for (let ml = -70; ml <= 70; ml += 3.7) for (const [lon, mlt, night] of [[-170, 1, 1], [20, 13, 0], [95, 20, 0.6]]) {
            const lat = ml + 3;
            const want = tidField({ magLatDeg: ml, latDeg: lat, lonDeg: lon, mltHr: mlt, night, kp, phases: G_ENV.ph }).total;
            close(G.tidDelta(ml, lat, lon, mlt, night, 0), want, 2e-6, `kp ${kp} ml ${ml} lon ${lon}`);
            const w2 = tidField({ magLatDeg: ml, latDeg: lat, lonDeg: lon, mltHr: mlt, night, kp, phases: G_ENV.ph, pixelKm: 90 }).total;
            close(G.tidDelta(ml, lat, lon, mlt, night, 90), w2, 2e-6, 'with a pixel footprint');
        }
    }
});
t('plStack (GLSL) = stackPeaks, and plNe = neAt, in units of 1e12 m⁻³', () => {
    for (const kp of [1, 6, 9]) for (let lt = 0; lt < 24; lt += 2.5) for (const cosChi of [-0.5, 0.2, 0.9]) {
        G_ENV.kp = kp;
        const s = stackPeaks({ lstHr: lt, kp, f107Sfu: G_ENV.f107, cosChi });
        const g = G.plStack(lt, cosChi);
        rel(g.x * 1e12, s.NmF2, 1e-7, `NmF2 lt ${lt} kp ${kp}`);
        assert.equal(g.y, s.hmF2);
        rel(g.z * 1e12, s.NmF1, 1e-7, 'NmF1');
        rel(g.w * 1e12, s.NmE, 1e-7);
        for (const h of [90, 108, 150, 180, 240, 300, 450, 900, 1800]) rel(G.plNe(h, g) * 1e12, neAt(h, s), 1e-7, `h ${h}`);
    }
});
t('plHorizontal (GLSL) = eia × trough × bubble with the shared tables', () => {
    const d = driven({ kp: 5, vbs: 3, hours: 3, driver: new IonosphereDriver({ width: 1440 }) });
    G_ENV.driver = d; G_ENV.sampler = d.sampler;
    // Plant a bubble so the wedge term is exercised.
    for (let x = 700; x < 740; x++) { d.sampler.data[x * 4 + 2] = 0.9; d.sampler.data[x * 4 + 3] = 16; }
    for (const lon of [-120, -3, 0.1, 2.4, 77]) for (let ml = -65; ml <= 65; ml += 2.5) for (const night of [0, 0.4, 1]) {
        const a = d.sampler.sampleAt(lon);
        const want = eiaFactor(ml, a.crest, a.crestLatDeg) * troughFactor(ml, d.plasmapauseAt(lon), night)
            * bubbleTecFactor(ml, a.bubble, a.bubbleExtentDeg);
        rel(G.plHorizontal(lon, ml, night), want, 1e-9, `lon ${lon} ml ${ml}`);
    }
});
t('plDisplay (GLSL) = tecDisplay; the ramp is dark-to-bright and matches the JS copy', () => {
    for (const tec of [0.5, 1, 3, 10, 55, 400, 1000, 5000]) close(G.plDisplay(tec), tecDisplay(tec), 1e-7);
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (let i = 1; i < PLASMA_RAMP.length; i++) assert.ok(lum(PLASMA_RAMP[i]) > lum(PLASMA_RAMP[i - 1]));
    for (const k of PLASMA_RAMP.flat()) assert.ok(PLASMA_GLSL.includes(k.toFixed(2)), `ramp ${k}`);
    assert.deepEqual(plasmaColour(0), PLASMA_RAMP[0]);
    assert.deepEqual(plasmaColour(1), PLASMA_RAMP[4]);
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-plasma-field: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
