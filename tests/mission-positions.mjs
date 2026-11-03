/**
 * Gate for js/mission-positions.js — the analytic placement + the ONE
 * disclosed compression of host-local distance on the missions map.
 *
 *   node tests/mission-positions.mjs
 *
 * What is pinned:
 *   1. The compression anchors: surface → 1 drawn radius, Sun–Earth L1/L2 →
 *      5 drawn radii, ISS just above the surface, the Moon at 4 — and that it
 *      is monotonic and invertible (so a legend can print real km).
 *   2. NEGATIVE CONTROL of the old bug: the real L1 displacement (0.01 AU)
 *      lies INSIDE the drawn Earth (0.018 AU) — every L1 sentinel used to be
 *      depth-killed. The compressed L1 must be OUTSIDE.
 *   3. Every roster mission with a placement resolves to a finite position
 *      (or is deliberately 'lost'), and local/lagrange draws sit at the
 *      compressed distance from their host.
 *   4. Kepler: perihelion distance a(1−e) at peri_jd, aphelion half a period
 *      later; the solver converges for e = 0.853 (Parker).
 *   5. liveToDrawn keeps DIRECTION exact for a local mission and anchors on
 *      the DRAWN host; a non-local mission passes through untouched.
 *   6. Time-dependent placements switch branch on their date (BepiColombo
 *      cruise → Mercury orbit at MOI; ESCAPADE L2 loiter → cruise after TMI).
 */
import assert from 'node:assert/strict';
import {
    DRAW_RADIUS_AU, HOST_RADIUS_KM, LAGRANGE_KM, MOON_DIST_KM, KM_PER_AU,
    localSceneDistance, localRealDistanceKm, localSceneOffset, equatorialToEcliptic,
    MISSION_LOCS, computeMissionPos, resolveLoc, keplerPos, solveKepler, jdFromISO,
    liveToDrawn, temeToDrawn, locationLabel,
} from '../js/mission-positions.js';
import { ALL_MISSIONS } from '../js/space-missions.js';
import {
    mercuryHeliocentric, venusHeliocentric, earthHeliocentric, marsHeliocentric,
    jupiterHeliocentric, saturnHeliocentric,
} from '../js/horizons.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
console.log('mission-positions.mjs');

const RE = DRAW_RADIUS_AU.earth;

ok('compression anchors: surface 1 R, L1 5 R, ISS 1.05 R, Moon 4 R (drawn radii)', () => {
    assert.ok(Math.abs(localSceneDistance(HOST_RADIUS_KM.earth, 'earth') / RE - 1) < 1e-12);
    assert.ok(Math.abs(localSceneDistance(LAGRANGE_KM, 'earth') / RE - 5) < 1e-9);
    const iss = localSceneDistance(6371 + 415, 'earth') / RE;
    assert.ok(iss > 1.03 && iss < 1.07, `ISS at ${iss}`);
    const moon = localSceneDistance(MOON_DIST_KM, 'earth') / RE;
    assert.ok(moon > 3.9 && moon < 4.1, `Moon at ${moon}`);
});

ok('compression is monotonic and invertible to < 1e-6 relative', () => {
    let prev = 0;
    for (const r of [1000, 6371, 7000, 20000, 42164, 1e5, 384400, 1e6, 1.5e6, 5e6]) {
        const d = localSceneDistance(r, 'earth');
        assert.ok(d > prev, `monotonic at ${r}`);
        prev = d;
        const back = localRealDistanceKm(d, 'earth');
        assert.ok(Math.abs(back - r) / r < 1e-6, `invert ${r} → ${back}`);
    }
});

ok('NEGATIVE CONTROL: real L1 displacement is inside the drawn Earth; the compressed one is outside', () => {
    const realL1 = LAGRANGE_KM / KM_PER_AU;
    assert.ok(realL1 < RE, 'the old placement sat inside the drawn sphere (the bug)');
    assert.ok(localSceneDistance(LAGRANGE_KM, 'earth') > RE * 2, 'the compressed placement clears it');
});

ok('localSceneOffset keeps direction exactly', () => {
    const o = localSceneOffset(3000, -4000, 12000, 'earth');
    const r = Math.hypot(3000, -4000, 12000);
    const want = localSceneDistance(r, 'earth');
    assert.ok(Math.abs(Math.hypot(o.x, o.y, o.z) - want) < 1e-12);
    assert.ok(Math.abs(o.x / o.y - 3000 / -4000) < 1e-12);
    assert.ok(Math.abs(o.z / o.x - 12000 / 3000) < 1e-12);
});

ok('equatorial→ecliptic is a rotation about +x by the obliquity (north pole maps to lat 66.56°)', () => {
    const pole = equatorialToEcliptic({ x: 0, y: 0, z: 1 });
    const lat = Math.asin(pole.z) * 180 / Math.PI;
    assert.ok(Math.abs(lat - 66.5607) < 1e-3, `pole lat ${lat}`);
    assert.ok(Math.abs(Math.hypot(pole.x, pole.y, pole.z) - 1) < 1e-12);
    const x = equatorialToEcliptic({ x: 1, y: 0, z: 0 });
    assert.deepEqual([x.x, x.y, x.z], [1, 0, 0]);
});

const jd = jdFromISO('2026-11-03T12:00:00Z');
const planets = {
    mercury: mercuryHeliocentric(jd), venus: venusHeliocentric(jd), earth: earthHeliocentric(jd),
    mars: marsHeliocentric(jd), jupiter: jupiterHeliocentric(jd), saturn: saturnHeliocentric(jd),
};
// the renderer derives the Moon the same way
{
    const e = planets.earth;
    const d = localSceneDistance(MOON_DIST_KM, 'earth');
    planets.moon = { x_AU: e.x_AU + d, y_AU: e.y_AU, z_AU: e.z_AU };
}

ok('every roster mission with a placement resolves to a finite position (or is lost on purpose)', () => {
    let placed = 0, lost = 0;
    for (const m of ALL_MISSIONS) {
        const loc = MISSION_LOCS[m.id];
        if (!loc) continue;
        if (resolveLoc(loc, jd).type === 'lost') { lost++; continue; }
        const p = computeMissionPos(m, loc, jd, planets);
        assert.ok(p && [p.x_AU, p.y_AU, p.z_AU].every(Number.isFinite), `${m.id} finite`);
        assert.ok(locationLabel(loc, jd).length > 0, `${m.id} has a label`);
        placed++;
    }
    assert.ok(placed >= 50, `placed ${placed}`);
    assert.ok(lost >= 4, `lost ${lost}`);
});

ok('every planned/retired/completed mission without a placement is card-only (no silent marker)', () => {
    for (const m of ALL_MISSIONS) {
        if (MISSION_LOCS[m.id]) continue;
        assert.ok(['planned', 'retired', 'completed'].includes(m.status), `${m.id} (${m.status}) has no placement`);
    }
});

ok('local + lagrange draws sit at the compressed distance from their host', () => {
    const sdo = ALL_MISSIONS.find(m => m.id === 'sdo');
    const p = computeMissionPos(sdo, MISSION_LOCS.sdo, jd, planets);
    const d = Math.hypot(p.x_AU - planets.earth.x_AU, p.y_AU - planets.earth.y_AU, p.z_AU - planets.earth.z_AU);
    assert.ok(Math.abs(d - localSceneDistance(42164, 'earth')) < 1e-12, 'SDO at compressed GEO');
    const soho = ALL_MISSIONS.find(m => m.id === 'soho');
    const q = computeMissionPos(soho, MISSION_LOCS.soho, jd, planets);
    const dq = Math.hypot(q.x_AU - planets.earth.x_AU, q.y_AU - planets.earth.y_AU, q.z_AU - planets.earth.z_AU);
    assert.ok(Math.abs(dq - 5 * RE) < 1e-9, 'SOHO at 5 drawn radii');
    const rq = Math.hypot(q.x_AU, q.y_AU, q.z_AU), re = Math.hypot(planets.earth.x_AU, planets.earth.y_AU, planets.earth.z_AU);
    assert.ok(rq < re, 'L1 is sunward');
    const jwst = computeMissionPos(ALL_MISSIONS.find(m => m.id === 'jwst'), MISSION_LOCS.jwst, jd, planets);
    assert.ok(Math.hypot(jwst.x_AU, jwst.y_AU, jwst.z_AU) > re, 'L2 is anti-sunward');
});

ok('Kepler: perihelion a(1−e) at peri_jd, aphelion a(1+e) half a period later; e=0.853 converges', () => {
    const loc = MISSION_LOCS['parker-solar-probe'];
    const rp = keplerPos(loc, loc.peri_jd);
    const r0 = Math.hypot(rp.x_AU, rp.y_AU, rp.z_AU);
    assert.ok(Math.abs(r0 - loc.a * (1 - loc.e)) < 1e-9, `perihelion ${r0}`);
    const ra = keplerPos(loc, loc.peri_jd + loc.period_d / 2);
    const r1 = Math.hypot(ra.x_AU, ra.y_AU, ra.z_AU);
    assert.ok(Math.abs(r1 - loc.a * (1 + loc.e)) < 1e-9, `aphelion ${r1}`);
    for (const M of [0.1, 1, 3, 5, 6.2]) {
        const E = solveKepler(M, 0.853);
        assert.ok(Math.abs(E - 0.853 * Math.sin(E) - M) < 1e-10, `Kepler residual at M=${M}`);
    }
});

ok('liveToDrawn: local mission keeps direction from host and anchors on the DRAWN host', () => {
    const liveHost = { x_AU: 0.5, y_AU: 0.8, z_AU: 0.001 };
    const liveSc   = { x_AU: 0.5 + 0.006, y_AU: 0.8 + 0.008, z_AU: 0.001 };   // 0.01 AU, direction (3,4,0)/5
    const drawn    = { x_AU: 0.49, y_AU: 0.81, z_AU: 0.0 };                     // Meeus host differs slightly
    const out = liveToDrawn(MISSION_LOCS.soho, jd, liveSc, liveHost, drawn);
    const dx = out.x_AU - drawn.x_AU, dy = out.y_AU - drawn.y_AU, dz = out.z_AU - drawn.z_AU;
    assert.ok(Math.abs(dx / dy - 0.75) < 1e-9, 'direction preserved');
    assert.ok(Math.abs(dz) < 1e-15);
    assert.ok(Math.abs(Math.hypot(dx, dy, dz) - localSceneDistance(0.01 * KM_PER_AU, 'earth')) < 1e-12);
    assert.ok(Math.abs(out.r_host_km - 0.01 * KM_PER_AU) < 1e-3);
    const helio = liveToDrawn(MISSION_LOCS['parker-solar-probe'], jd, liveSc, liveHost, drawn);
    assert.deepEqual([helio.x_AU, helio.y_AU, helio.z_AU, helio.r_host_km], [liveSc.x_AU, liveSc.y_AU, liveSc.z_AU, null]);
});

ok('temeToDrawn: ISS at 6786 km TEME lands 1.05 drawn radii from the drawn Earth', () => {
    const e = planets.earth;
    const out = temeToDrawn({ x: 6786, y: 0, z: 0 }, e);
    const d = Math.hypot(out.x_AU - e.x_AU, out.y_AU - e.y_AU, out.z_AU - e.z_AU);
    assert.ok(Math.abs(d / RE - localSceneDistance(6786, 'earth') / RE) < 1e-12);
    assert.ok(Math.abs(out.r_host_km - 6786) < 1e-9);
});

ok('time-dependent placements switch branch on their date', () => {
    const bepi = MISSION_LOCS.bepicolombo;
    assert.equal(resolveLoc(bepi, jdFromISO('2026-11-03')).type, 'cruise');
    assert.equal(resolveLoc(bepi, jdFromISO('2026-11-22')).type, 'local');
    assert.equal(resolveLoc(bepi, jdFromISO('2026-11-22')).host, 'mercury');
    const esc = MISSION_LOCS.escapade;
    assert.equal(resolveLoc(esc, jdFromISO('2026-11-03')).type, 'lagrange');
    assert.equal(resolveLoc(esc, jdFromISO('2026-11-10')).type, 'cruise');
    const psy = MISSION_LOCS.psyche;
    assert.equal(resolveLoc(psy, jdFromISO('2026-01-01')).to, 'mars');
    assert.equal(resolveLoc(psy, jdFromISO('2026-11-03')).to, 'jupiter');
    // and the cruise is bounded: before launch at `from`, after arrival at `to` (bowed outward)
    const mmx = ALL_MISSIONS.find(m => m.id === 'mmx');
    const p0 = computeMissionPos(mmx, MISSION_LOCS.mmx, jdFromISO('2026-10-01'), planets);
    const dE = Math.hypot(p0.x_AU - planets.earth.x_AU, p0.y_AU - planets.earth.y_AU, p0.z_AU - planets.earth.z_AU);
    assert.ok(dE < 0.01, `MMX before launch sits on Earth (${dE})`);
});

console.log(`mission-positions.mjs: ${n} checks passed`);
