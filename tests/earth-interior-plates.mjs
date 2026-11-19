// tests/earth-interior-plates.mjs — PB2002 plate kinematics, gated against Bird's own numbers.
// Run: node tests/earth-interior-plates.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    decodePlates, stepMotions, relativeMotion, plateVelocity, eulerVector, poleOf, plateAt, polygonArea,
    windingAngle, unit, nnrRotation, plateMoments, subductingPlate, boundarySummary, R_EARTH_KM,
} from '../js/earth-interior/plates.js';
import { travel, velocityArrows, nearestStep, coolingDepthM, depthAge, fibonacciPoints, plateCentroids, plateRGBA, ARROW_DEG_PER_MM_YR } from '../js/earth-interior/plates-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const baked = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'data/earth-interior/plates-pb2002.json.gz'))));
const model = decodePlates(baked);
const B = baked.steps.bird;
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const DEG = Math.PI / 180;

console.log('Inner Earth — tectonic plates (PB2002)');

{
    assert.equal(model.plates.length, 52); assert.equal(model.steps.length, 5819);
    assert.deepEqual(model.byId.get('PA').w, [0, 0, 0], 'Bird\'s poles are relative to the Pacific');
    assert.equal(baked.source.raster.overlaps, 0); assert.equal(baked.source.raster.orphans, 0);
    const frac = model.plates.reduce((a, p) => a + p.areaKm2, 0) / (4 * Math.PI * R_EARTH_KM ** 2);
    assert.ok(Math.abs(frac - 1) < 1e-12, 'the raster covers the sphere exactly once');
    ok('52 plates, 5,819 steps; the 0.5° raster has no overlap and no orphan cell and sums to 4πR²');
}

{
    // The two geometric primitives the bake relies on, checked on a shape with a closed-form answer.
    const cap = []; const r = 20;                     // a small circle of angular radius 20° about the pole, CCW
    for (let k = 0; k <= 720; k++) cap.push(unit(90 - r, (k / 720) * 360));
    const exact = 2 * Math.PI * (1 - Math.cos(r * DEG));
    // A polygon with great-circle edges inscribed in the circle has slightly less area than the cap.
    const a = polygonArea(cap);
    assert.ok(a < exact && exact - a < 1e-4, `polygonArea of a 720-gon cap ${a} vs ${exact}`);
    assert.ok(windingAngle(cap, unit(85, 10)) > 6 && Math.abs(windingAngle(cap, unit(40, 10))) < 1e-9, 'winding: inside 2π, outside 0');
    // Largest plates by raster area: Pacific first, as Bird's Table 1.
    const big = [...model.plates].sort((x, y) => y.areaKm2 - x.areaKm2).slice(0, 3).map((p) => p.id);
    assert.equal(big[0], 'PA');
    ok(`winding membership and exact polygon area verified on a closed-form cap; largest plates ${big.join(', ')} (PA ${(model.byId.get('PA').areaKm2 / 1e6).toFixed(1)} Mkm²)`);
}

{
    // Kernel vs Bird's 5,819 per-step relative velocities, computed by Bird from the same poles.
    const mo = stepMotions(model);
    let wSpeed = 0, wAz = 0, over = 0, wWorst = 0;
    mo.forEach((m, k) => {
        wSpeed = Math.max(wSpeed, Math.abs(m.speed - B.vel[k]));
        if (B.vel[k] > 2) wAz = Math.max(wAz, Math.abs(((m.velAzimuth - B.az[k] + 540) % 360) - 180));
        // Budget: Bird prints 0.1 mm/a and endpoints to 0.001°; a step's azimuth then carries ~2·0.056 km / length rad.
        const budget = 0.1 + m.speed * (2 * 0.0556 / m.lengthKm + 0.5 * DEG);
        const e = Math.max(Math.abs(m.divergent - B.div[k]), Math.abs(m.rightLateral - B.dex[k]));
        if (e > budget) over++;
        wWorst = Math.max(wWorst, e / budget);
    });
    assert.ok(wSpeed < 0.1, `relative speed within Bird's 0.1 mm/a print (worst ${wSpeed})`);
    assert.ok(wAz <= 0.51, `velocity azimuth within Bird's 1° print (worst ${wAz}°)`);
    assert.equal(over, 0, `divergent / right-lateral within the coordinate-rounding budget (${over} over, worst ×${wWorst.toFixed(2)})`);
    // NEGATIVE CONTROLS: the opposite right-lateral sign, and right-wrt-left, both fail.
    const flipped = mo.filter((m, k) => Math.abs(-m.rightLateral - B.dex[k]) > 1).length;
    const swapped = model.steps.filter((s, k) => Math.abs(relativeMotion(s.right.w, s.left.w, s.lat1, s.lon1, s.lat2, s.lon2).divergent - B.div[k]) > 1).length;
    assert.ok(flipped > 3000 && swapped > 3000, `controls must fail (${flipped}, ${swapped} steps off)`);
    ok(`all 5,819 steps reproduce Bird: speed ≤ ${wSpeed.toFixed(2)} mm/a, azimuth ≤ ${wAz.toFixed(2)}°, components within budget (×${wWorst.toFixed(2)}); flipped-sign and swapped-plate controls fail`);
}

{
    // No-net-rotation frame: published NNR-NUVEL-1A Pacific pole (Argus & Gordon 1991): −63.04°N 107.33°E 0.6411°/Ma.
    // PB2002 has 52 plates (NUVEL-1A had 14), so agreement is to a tolerance, not exact.
    const pa = model.byId.get('PA').nnrPole;
    assert.ok(Math.abs(pa.lat + 63.04) < 1 && Math.abs(pa.lon - 107.33) < 2 && Math.abs(pa.rateDegMa - 0.6411) < 0.02,
        `NNR Pacific pole ${pa.lat.toFixed(2)} ${pa.lon.toFixed(2)} ${pa.rateDegMa.toFixed(4)}`);
    // Identity: the NNR velocity field carries zero net rotation (re-integrated on the raster).
    const residual = nnrRotation(model.plates.map((p) => p.wNnr), plateMoments(model.raster, 52));
    assert.ok(Math.hypot(...residual) < 1e-15 * Math.hypot(...model.nnrOmega) + 1e-18, `residual net rotation is zero (${Math.hypot(...residual)})`);
    // NEGATIVE CONTROL: an UNWEIGHTED mean of the 52 Euler vectors is not the NNR frame.
    const mean = [0, 1, 2].map((a) => model.plates.reduce((s, p) => s + p.w[a], 0) / 52);
    const bad = poleOf(model.byId.get('PA').w.map((v, a) => v - mean[a]));
    assert.ok(Math.abs(bad.rateDegMa - 0.6411) > 0.3 || Math.abs(bad.lat + 63.04) > 10, 'unweighted control must fail');
    ok(`NNR frame (area-weighted, from the raster): Pacific ${pa.lat.toFixed(2)}°N ${pa.lon.toFixed(2)}°E ${pa.rateDegMa.toFixed(4)}°/Ma vs NNR-NUVEL-1A −63.04 107.33 0.6411; unweighted control ${bad.rateDegMa.toFixed(3)}°/Ma fails`);
}

{
    // Rigid rotation sanity: speed = ω R sin(angle from pole); zero at the pole, max 90° away.
    const w = eulerVector({ lat: 0, lon: 0, rateDegMa: 1 });
    assert.ok(plateVelocity(w, 0, 0).speed < 1e-9);
    assert.ok(Math.abs(plateVelocity(w, 0, 90).speed - R_EARTH_KM * DEG) < 1e-9);
    assert.ok(plateVelocity(w, 0, 90).north > 0, 'CCW about +x carries the 90°E point north');
    // Familiar numbers out of the poles: the fastest spreading is on the Pacific–Nazca East Pacific Rise.
    const mo = stepMotions(model).filter((m) => m.step.cls === 'OSR');
    const pairOf = (m) => [m.step.left.id, m.step.right.id].sort().join('–');
    const fastest = mo.reduce((a, m) => (m.divergent > a.divergent ? m : a));
    // The single fastest step is a MICROPLATE rim (Juan Fernández spins at 22.5°/Ma); between major
    // plates the record is Pacific–Nazca on the East Pacific Rise, ~150 mm/yr full rate.
    const epr = Math.max(...mo.filter((m) => pairOf(m) === 'NZ–PA').map((m) => m.divergent));
    assert.ok(epr > 140 && epr < 170, `PA–NZ ${epr}`);
    assert.equal(pairOf(fastest), 'JZ–PA');
    const pair = ['NZ', 'PA'];
    // NNR speeds: India and Australia among the fastest continental plates; Eurasia slow.
    const v = (id, la, lo) => plateVelocity(model.byId.get(id).wNnr, la, lo).speed;
    assert.ok(v('AU', -25, 135) > 60 && v('EU', 50, 10) < 30, `AU ${v('AU', -25, 135)} EU ${v('EU', 50, 10)}`);
    ok(`fastest spreading between major plates ${epr.toFixed(0)} mm/yr full rate (${pair.join('–')}, East Pacific Rise; the JZ microplate rim reaches ${fastest.divergent.toFixed(0)}); NNR: Australia ${v('AU', -25, 135).toFixed(0)} mm/yr, Eurasia ${v('EU', 50, 10).toFixed(0)} mm/yr`);
}

{
    // Ocean floor along the boundaries: Bird's ETOPO5 elevation and Müller seafloor age, read as observations.
    const st = model.steps;
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const ridge = median(st.filter((s) => s.cls === 'OSR').map((s) => s.elevationM));
    const ridgeAge = median(st.filter((s) => s.cls === 'OSR' && s.ageMa != null).map((s) => s.ageMa));
    const subAge = median(st.filter((s) => s.cls === 'SUB' && s.ageMa != null).map((s) => s.ageMa));
    assert.ok(ridge < -2000 && ridge > -3500, `ridge crest median ${ridge} m`);
    assert.ok(ridgeAge <= 2, `ridge seafloor is young (${ridgeAge} Ma)`);
    assert.ok(subAge > ridgeAge + 20, `seafloor at trenches is old (${subAge} Ma)`);
    // Subduction polarity: every SUB step names a downgoing plate.
    const sub = st.filter((s) => s.cls === 'SUB');
    assert.ok(sub.every((s) => subductingPlate(s)), 'every subduction step has a polarity');
    const sum = boundarySummary(stepMotions(model));
    ok(`ridge crests median ${ridge} m, ${ridgeAge} Ma; trench-side seafloor median ${subAge} Ma; ${(sum.OSR.lengthKm / 1e3).toFixed(0)}k km of ridge, ${(sum.SUB.lengthKm / 1e3).toFixed(0)}k km of subduction`);
}

{
    // Plate lookup: a few unambiguous places.
    const at = (la, lo) => model.plates[plateAt(model.raster, la, lo)].id;
    assert.equal(at(40, -100), 'NA'); assert.equal(at(0, -140), 'PA'); assert.equal(at(-25, 135), 'AU');
    assert.equal(at(50, 10), 'EU'); assert.equal(at(-85, 0), 'AN'); assert.equal(at(10, 20), 'AF');
    ok('plateAt: Kansas NA, central Pacific PA, Australia AU, Germany EU, South Pole AN, Chad AF');
}

{
    // plates-model: the page's geometry helpers.
    const t = travel(0, 0, 90, 90);
    assert.ok(Math.abs(t.lat) < 1e-9 && Math.abs(t.lon - 90) < 1e-9, 'travel east 90° along the equator');
    const u = travel(10, 20, 0, 30);
    assert.ok(Math.abs(u.lat - 40) < 1e-9 && Math.abs(u.lon - 20) < 1e-9, 'travel north along a meridian');
    const pts = fibonacciPoints(2000), north = pts.filter((p) => p.lat > 0).length;
    assert.ok(Math.abs(north - 1000) <= 1 && pts.every((p) => p.lon >= -180 && p.lon < 180), 'Fibonacci lattice: equal hemispheres, longitudes in range');
    // Arrows: each shaft's length is the speed × the display scale, along the velocity azimuth.
    const arr = velocityArrows(model, 'nnr', { n: 300, plateAt });
    for (const a of arr.slice(0, 40)) {
        const s0 = unit(a.shaft[0].lat, a.shaft[0].lon), s1 = unit(a.shaft.at(-1).lat, a.shaft.at(-1).lon);
        const ang = Math.acos(Math.min(1, s0[0] * s1[0] + s0[1] * s1[1] + s0[2] * s1[2])) / DEG;
        assert.ok(Math.abs(ang - a.speed * ARROW_DEG_PER_MM_YR) < 1e-6);
    }
    // Pacific-fixed: the Pacific plate draws no arrows.
    assert.ok(!velocityArrows(model, 'pacific', { n: 300, plateAt }).some((a) => a.plate.id === 'PA'));
    // nearestStep: a point on the East Pacific Rise finds an NZ–PA spreading step close by.
    const n0 = nearestStep(model, -30.9, -111.9);
    assert.ok(n0.km < 60 && n0.family === 'spreading' && new Set([n0.step.left.id, n0.step.right.id]).has('NZ'));
    // Cooling curve: Parsons & Sclater's published branches at their anchor points.
    assert.equal(coolingDepthM(0), 2500); assert.equal(coolingDepthM(64), 2500 + 350 * 8);
    // The two published branches do not meet exactly: a 78 m step at 70 Ma (5428 → 5350 m). Kept as published.
    assert.ok(Math.abs(coolingDepthM(70) - 5428.3) < 0.1 && Math.abs(coolingDepthM(70.0001) - 5350.3) < 0.1);
    const da = depthAge(model);
    assert.ok(da.points.length > 800 && da.bins.length >= 8 && da.bins[0].depth < da.bins.at(-1).depth, 'transform steps deepen with age');
    const cen = plateCentroids(model)[model.byId.get('AU').index];
    assert.equal(model.plates[plateAt(model.raster, cen.lat, cen.lon)].id, 'AU', 'a convex-ish plate\'s centroid lies on it');
    assert.equal(plateRGBA(model).length, 4 * model.raster.nLat * model.raster.nLon);
    ok(`page helpers: travel, Fibonacci lattice, arrow lengths (${ARROW_DEG_PER_MM_YR}°/(mm/yr)), Pacific-fixed has no PA arrows, EPR nearest step ${n0.km.toFixed(0)} km, cooling curve anchors`);
}

console.log(`${n} checks passed`);
