/**
 * Gate for js/orrery-planets.js — where solar-system.html draws each planet.
 *
 * The reference is INDEPENDENT of the page's code: Astronomy Engine (Don Cross,
 * full VSOP87 + its own precession/nutation), baked into
 * tests/fixtures/orrery-planets-astronomy-engine.json because it is not a repo
 * dependency. 61 epochs 1950–2100, heliocentric, true ecliptic and equinox of
 * date. Re-bake on a machine with `pip install astronomy-engine`:
 *   HelioVector(body, t) → RotateVector(Rotation_EQJ_ECT(t), ·) → SphereFromVector
 * The JD in the fixture is UT, as the page passes it (ΔT ≈ 70 s is 0.003° at
 * Mercury — below every bound here).
 *
 * What is gated:
 *   1. Longitude and distance of every planet against the reference. The
 *      INNER bounds are tight enough that each has a negative control below:
 *      the old J2000-unrotated Mercury–Mars sit 0.37° off in 2026, and the
 *      old mean-motion circles miss by tens of degrees within a month.
 *   2. Each planet lies ON its drawn ring (`orbitRadiusAtLon`) to < 0.5 %.
 *   3. Negative controls: (a) the boot-anchored mean-motion model the page
 *      used until 2026-10-20 must FAIL the inner bounds; (b) the unrotated
 *      J2000 inner series must FAIL them too.
 *
 * Jupiter's bound is loose ON PURPOSE and is a measured value, not a goal:
 * js/outer-planets.js's truncated VSOP87D Jupiter reaches 0.84° against the
 * reference over 1950–2100. Tighten it when that series is fixed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORRERY_BODIES, planetHelioOfDate, orbitRadiusAtLon, planetScenePosition } from '../js/orrery-planets.js';
import { PLANET_FRAMES } from '../js/skyview/sky-engine.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/orrery-planets-astronomy-engine.json', import.meta.url)));
const wrap = (d) => ((d % 360) + 540) % 360 - 180;
const R2D = 180 / Math.PI;

// [max |Δλ| deg, max |Δr|/r]
const BOUNDS = {
    mercury: [0.20, 0.002],
    venus:   [0.03, 0.0005],
    earth:   [0.02, 0.0002],
    mars:    [0.06, 0.0005],
    jupiter: [0.90, 0.002],   // measured 0.84° — see header
    saturn:  [0.05, 0.002],
    uranus:  [0.20, 0.002],
    neptune: [0.10, 0.001],
};
const INNER = ['mercury', 'venus', 'earth', 'mars'];

// ── 1 + 2: against the reference, and on the ring ───────────────────────────
const worst = {};
for (const row of FIX.rows) {
    for (const key of ORRERY_BODIES) {
        const h = planetHelioOfDate(key, row.jd_ut);
        const [lonRef, rRef] = row[key];
        const dLon = Math.abs(wrap(h.lonRad * R2D - lonRef));
        const dR = Math.abs(h.r - rRef) / rRef;
        const ring = orbitRadiusAtLon(key, row.jd_ut)(h.lonRad);
        const dRing = Math.abs(ring - h.r) / h.r;
        const w = (worst[key] ??= { lon: 0, r: 0, ring: 0 });
        w.lon = Math.max(w.lon, dLon); w.r = Math.max(w.r, dR); w.ring = Math.max(w.ring, dRing);
        assert.ok(dLon <= BOUNDS[key][0], `${key} @ ${row.iso}: Δλ ${dLon.toFixed(3)}° > ${BOUNDS[key][0]}°`);
        assert.ok(dR <= BOUNDS[key][1], `${key} @ ${row.iso}: Δr/r ${dR.toExponential(2)} > ${BOUNDS[key][1]}`);
        assert.ok(dRing < 0.005, `${key} @ ${row.iso}: off its drawn ring by ${(dRing * 100).toFixed(2)} %`);
    }
}
for (const key of ORRERY_BODIES) {
    const w = worst[key];
    console.log(`  ${key.padEnd(8)} max |Δλ| ${w.lon.toFixed(3)}°  max |Δr|/r ${w.r.toExponential(1)}  ring ${(w.ring * 100).toFixed(2)} %`);
}

// Scene placement is the same longitude through the page's simDist (mirrored
// from solar-system.html; tests/neo-orbits.mjs pins the same constants).
const simDist = (dAU) => 2.5 + 4.2 * Math.log(1 + dAU * 1.8);
{
    const jd = FIX.rows[30].jd_ut;
    const sp = planetScenePosition('mars', jd, simDist);
    assert.equal(sp.y, 0);
    assert.ok(Math.abs(Math.hypot(sp.x, sp.z) - simDist(sp.helio.r)) < 1e-12, 'scene radius is simDist(true r)');
    assert.ok(Math.abs(Math.atan2(sp.z, sp.x) - sp.helio.lonRad) < 1e-12, 'scene azimuth is the longitude');
    assert.equal(planetHelioOfDate('ceres', jd), null, 'unknown bodies return null, never a made-up place');
}

// ── 3a. Negative control: the old boot-anchored mean-motion circles ─────────
{
    const PERIOD_YR = { mercury: 0.241, venus: 0.615, earth: 1.0, mars: 1.881 };   // the page's PLANETS table
    const boot = FIX.rows[30];                                  // any epoch will do as "boot"
    const later = FIX.rows.find(r => r.jd_ut - boot.jd_ut > 300);
    const dtYr = (later.jd_ut - boot.jd_ut) / 365.25;
    let maxMiss = 0;
    for (const key of INNER) {
        const lon0 = planetHelioOfDate(key, boot.jd_ut).lonRad * R2D;
        const old = lon0 + 360 * dtYr / PERIOD_YR[key];
        maxMiss = Math.max(maxMiss, Math.abs(wrap(old - later[key][0])));
    }
    assert.ok(maxMiss > 5 * BOUNDS.mercury[0], `negative control: mean-motion model should miss badly, missed only ${maxMiss.toFixed(2)}°`);
    console.log(`  negative control (mean-motion circles, ${dtYr.toFixed(2)} yr after boot): worst inner miss ${maxMiss.toFixed(1)}°`);
}

// ── 3b. Negative control: inner series left in J2000 ────────────────────────
{
    const row = FIX.rows.at(-1);          // 2100 — precession has had a century to build
    let failed = 0;
    for (const key of ['mercury', 'venus', 'mars']) {
        assert.equal(PLANET_FRAMES[key].frame, 'j2000', `${key} is a J2000 series (the premise of the rotation)`);
        const raw = PLANET_FRAMES[key].fn(row.jd_ut);
        const d = Math.abs(wrap(raw.lon_rad * R2D - row[key][0]));
        if (d > BOUNDS[key][0]) failed++;
    }
    assert.equal(failed, 3, 'negative control: unrotated J2000 inner planets must fail their bounds');
    console.log('  negative control (J2000 unrotated): all three inner series fail, as they must');
}

console.log('orrery-planets: ok');
