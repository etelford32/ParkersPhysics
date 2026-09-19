/**
 * Gate for js/eclipse-geometry.js — occultation, shadow and reflected light.
 *
 * Every assertion is an IDENTITY, a closed form, or a PUBLISHED event, never a
 * remembered render value:
 *   - the four regimes of circle-circle overlap, including the annular case
 *     where the covered fraction is exactly the area ratio
 *   - the lens area against an independent Monte-Carlo integration
 *   - Earth's umbra length (1.38 million km) and the fact that the Moon sits
 *     well inside it while Earth's disc at the Moon is 3.6× the Sun's, which
 *     is WHY lunar totality exists at all
 *   - THE REAL EVENTS: driving the page's own VSOP87D Earth and Meeus Moon
 *     through this kernel must reproduce the published lunar eclipses of
 *     2025-2026, to within an hour of greatest eclipse. That is an end-to-end
 *     check of three independent pieces of code against the sky.
 *   - earthshine at the Moon is ~10⁻⁴ of sunlight and PEAKS AT NEW MOON
 */
import assert from 'node:assert/strict';
import {
    SUN_RADIUS_KM, EARTH_RADIUS_KM, BODY_ALBEDO, UMBRAL_TRANSMISSION,
    angularRadiusRad, occultedFraction, shadowIllumination,
    lambertPhase, reflectedIrradianceFraction, umbraLengthKm,
} from '../js/eclipse-geometry.js';
import { earthHeliocentric, moonGeocentric } from '../js/horizons.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const AU_KM = 149_597_870.7;
const D2R = Math.PI / 180;

// ── Circle-circle overlap: the four regimes ────────────────────────────────
{
    assert.equal(occultedFraction(1, 1, 2.001), 0, 'disjoint');
    assert.equal(occultedFraction(1, 1, 5), 0, 'far apart');
    assert.equal(occultedFraction(1, 3, 1.5), 1, 'B swallows A → total');
    assert.equal(occultedFraction(1, 3, 0), 1, 'concentric, B larger → total');
    // ANNULAR: B entirely inside A covers exactly the area ratio — which is why
    // an annular solar eclipse never goes dark.
    near(occultedFraction(1, 0.5, 0), 0.25, 1e-12, 'annular is the area ratio');
    near(occultedFraction(1, 0.5, 0.4), 0.25, 1e-12, 'still annular while contained');
    // Equal discs at sep = r: the classic lens, 2r²(π/3 − √3/4) over πr².
    const lens = 2 * (Math.PI / 3 - Math.sqrt(3) / 4) / Math.PI;
    near(occultedFraction(1, 1, 1), lens, 1e-12, 'equal discs at sep = r');
    near(occultedFraction(1, 1, 0), 1, 1e-12, 'coincident equal discs');
    // Monotonic: more separation, less cover.
    let prev = 1.0001;
    for (let d = 0; d <= 2.2; d += 0.05) {
        const f = occultedFraction(1, 1, d);
        assert.ok(f <= prev + 1e-12, `monotonic at ${d}`);
        prev = f;
    }
    // Independent check of the partial branch by Monte-Carlo area sampling.
    for (const [rA, rB, sep] of [[1, 0.8, 1.1], [1, 1.4, 1.2], [0.5, 0.9, 0.7]]) {
        let hit = 0, n = 400000;
        for (let i = 0; i < n; i++) {
            // Uniform point in disc A, centred at the origin; B is at (sep, 0).
            const r = rA * Math.sqrt((i + 0.5) / n), th = i * 2.399963229728653;
            const x = r * Math.cos(th), y = r * Math.sin(th);
            if ((x - sep) * (x - sep) + y * y <= rB * rB) hit++;
        }
        near(occultedFraction(rA, rB, sep), hit / n, 3e-3, `lens vs sampling (${rA},${rB},${sep})`);
    }
}

// ── The geometry that makes lunar totality possible ────────────────────────
{
    const umbra = umbraLengthKm(EARTH_RADIUS_KM, AU_KM);
    near(umbra, 1.383e6, 5e3, 'Earth’s umbra is ~1.38 million km long');
    assert.ok(umbra > 384_400, 'the Moon orbits INSIDE it — total lunar eclipses exist');
    assert.ok(umbra < 4 * 384_400, 'but only out to ~3.6 lunar distances');
    const earthAtMoon = angularRadiusRad(EARTH_RADIUS_KM, 384_400);
    const sunAtMoon = angularRadiusRad(SUN_RADIUS_KM, AU_KM);
    near(earthAtMoon / D2R, 0.950, 0.005, 'Earth’s angular radius at the Moon');
    near(sunAtMoon / D2R, 0.2664, 0.002, 'the Sun’s angular radius');
    assert.ok(earthAtMoon > 3 * sunAtMoon, 'Earth’s disc is 3.6× the Sun’s at the Moon');
    // The Moon's own disc at Earth is very nearly the Sun's — which is why a
    // total solar eclipse is barely total, and can be annular instead.
    near(angularRadiusRad(1737.4, 384_400) / sunAtMoon, 1.0, 0.06, 'Moon ≈ Sun on the sky');
    assert.equal(shadowIllumination({}).lit, 1, 'no geometry ⇒ nothing is blocked');
    // An occulter beyond the Sun cannot shadow anything.
    const behind = shadowIllumination({
        sunFromBody: { x: 1e8, y: 0, z: 0 }, occulterFromBody: { x: 2e8, y: 0, z: 0 },
        occulterRadiusKm: 7e4,
    });
    assert.equal(behind.lit, 1, 'an occulter further than the Sun blocks nothing');
    assert.ok(UMBRAL_TRANSMISSION > 0 && UMBRAL_TRANSMISSION < 0.05, 'totality is faint, not black');
}

// ── The real sky: the lunar eclipses of 2025-2026 ──────────────────────────
// Driving this kernel with the page's own ephemerides must land on the
// published events. Greatest-eclipse times (NASA five-millennium catalogue):
const KNOWN = [
    { utc: '2025-03-14 06:58', kind: 'total' },
    { utc: '2025-09-07 18:11', kind: 'total' },
    { utc: '2026-03-03 11:33', kind: 'total' },
    { utc: '2026-08-28 04:12', kind: 'partial' },
];
{
    const moonKm = (jd) => {
        const m = moonGeocentric(jd);
        const cl = Math.cos(m.lat_rad);
        return { x: m.dist_km * cl * Math.cos(m.lon_rad), y: m.dist_km * cl * Math.sin(m.lon_rad), z: m.dist_km * Math.sin(m.lat_rad) };
    };
    const probe = (jd) => {
        const e = earthHeliocentric(jd);
        const m = moonKm(jd);
        const sunFromEarth = { x: -e.x_AU * AU_KM, y: -e.y_AU * AU_KM, z: -e.z_AU * AU_KM };
        return shadowIllumination({
            sunFromBody: { x: sunFromEarth.x - m.x, y: sunFromEarth.y - m.y, z: sunFromEarth.z - m.z },
            occulterFromBody: { x: -m.x, y: -m.y, z: -m.z },
            occulterRadiusKm: EARTH_RADIUS_KM,
        });
    };
    // Scan two years at 30-minute steps and keep each contiguous event's peak.
    const jd0 = 2460676.5, step = 1 / 48;
    const events = [];
    let run = null;
    for (let jd = jd0; jd < jd0 + 730; jd += step) {
        const s = probe(jd);
        // The PEAK is the minimum angular separation, NOT the maximum covered
        // fraction: `covered` saturates at exactly 1.0 through the whole of
        // totality, so a max-covered scan latches onto the FIRST totality
        // sample and reports greatest eclipse up to an hour early.
        if (s.covered > 0) { if (!run || s.sepRad < run.sepRad) run = { jd, ...s }; }
        else if (run) { events.push(run); run = null; }
    }
    if (run) events.push(run);
    assert.equal(events.length, KNOWN.length, `found ${events.length} umbral events in 2025-2026, expected ${KNOWN.length}`);
    for (let i = 0; i < KNOWN.length; i++) {
        const gotMs = (events[i].jd - 2440587.5) * 86400e3;
        const wantMs = Date.parse(KNOWN[i].utc.replace(' ', 'T') + ':00Z');
        const dtMin = Math.abs(gotMs - wantMs) / 60000;
        assert.ok(dtMin < 60, `${KNOWN[i].utc}: predicted peak is ${dtMin.toFixed(0)} min away`);
        // Every one of these has the Moon's CENTRE inside the umbra (the 2026
        // partial has umbral magnitude 0.93, so its centre is in too).
        assert.equal(events[i].phase, 'umbral', `${KNOWN[i].utc} reaches the umbra`);
    }
    // And nothing is eclipsed at a random non-eclipse date.
    assert.equal(probe(2460700.3).lit, 1, 'an ordinary day has no eclipse');
}

// ── Reflected light ────────────────────────────────────────────────────────
{
    near(lambertPhase(0), 1, 1e-12, 'Φ(0) = 1, full');
    near(lambertPhase(Math.PI / 2), 1 / Math.PI, 1e-12, 'Φ(90°) = 1/π, quarter');
    near(lambertPhase(Math.PI), 0, 1e-12, 'Φ(180°) = 0, new');
    let prev = 1.0001;
    for (let d = 0; d <= 180; d += 5) { const v = lambertPhase(d * D2R); assert.ok(v <= prev + 1e-12); prev = v; }

    // EARTHSHINE IS BRIGHTEST AT NEW MOON, and getting that round the right
    // way is the whole content of this block. A FULL Earth as seen FROM the
    // Moon means the Moon is on the SUNWARD side of Earth — the two vectors
    // out of Earth, to the Sun and to the Moon, point the SAME way, phase
    // angle 0 — and from Earth that is a new moon with the ashen light on its
    // dark limb. The opposite arrangement (Sun and Moon on opposite sides of
    // Earth) is a FULL moon and a NEW Earth, and no earthshine at all. The
    // kernel evaluated the angle at the wrong vertex once and had all of this
    // exactly backwards; see reflectedIrradianceFraction.
    const d = 384_400;
    const full = reflectedIrradianceFraction({
        bodyFromPlanetKm: { x: d, y: 0, z: 0 },
        sunFromPlanetKm: { x: AU_KM, y: 0, z: 0 },      // Sun and Moon the same side ⇒ FULL Earth from the Moon
        planetRadiusKm: EARTH_RADIUS_KM, albedo: BODY_ALBEDO.earth,
    });
    assert.ok(full > 3e-5 && full < 2e-4, `earthshine ~1e-4 of sunlight, got ${full.toExponential(2)}`);
    // ...and it is DARKEST when Earth is new from the Moon, i.e. at full Moon.
    const newEarth = reflectedIrradianceFraction({
        bodyFromPlanetKm: { x: d, y: 0, z: 0 },
        sunFromPlanetKm: { x: -AU_KM, y: 0, z: 0 },     // Sun opposite the Moon ⇒ NEW Earth from the Moon
        planetRadiusKm: EARTH_RADIUS_KM, albedo: BODY_ALBEDO.earth,
    });
    assert.ok(newEarth < full * 1e-3, 'earthshine vanishes when Earth is new from the body');
    // Inverse square in distance.
    const half = reflectedIrradianceFraction({
        bodyFromPlanetKm: { x: d / 2, y: 0, z: 0 },
        sunFromPlanetKm: { x: AU_KM, y: 0, z: 0 },
        planetRadiusKm: EARTH_RADIUS_KM, albedo: BODY_ALBEDO.earth,
    });
    near(half / full, 4, 0.02, 'reflected light is inverse-square');
    // AND THE SAME THING AGAINST THE REAL SKY, which is what actually pins the
    // convention: drive one synodic month of the page's own ephemerides
    // through the kernel and ask WHERE IN THE LUNAR MONTH earthshine peaks.
    // The answer has to be new moon, and it has to be emergent — nothing here
    // tells the kernel what a new moon is. The elongation is measured from
    // EARTH (Sun-Earth-Moon); the phase angle the kernel uses is measured at
    // EARTH too, so the two agree by construction, which is the point.
    {
        const moonKmAt = (jd) => {
            const m = moonGeocentric(jd);
            const cl = Math.cos(m.lat_rad);
            return { x: m.dist_km * cl * Math.cos(m.lon_rad), y: m.dist_km * cl * Math.sin(m.lon_rad), z: m.dist_km * Math.sin(m.lat_rad) };
        };
        let best = null, worst = null;
        for (let k = 0; k < 60; k++) {
            const jd = 2461000.5 + k * (29.53059 / 60);
            const e = earthHeliocentric(jd);
            const sunFromEarth = { x: -e.x_AU * AU_KM, y: -e.y_AU * AU_KM, z: -e.z_AU * AU_KM };
            const mk = moonKmAt(jd);
            const shine = reflectedIrradianceFraction({
                bodyFromPlanetKm: mk, sunFromPlanetKm: sunFromEarth,
                planetRadiusKm: EARTH_RADIUS_KM, albedo: BODY_ALBEDO.earth,
            });
            const ls = Math.hypot(sunFromEarth.x, sunFromEarth.y, sunFromEarth.z), lm = Math.hypot(mk.x, mk.y, mk.z);
            const elongDeg = Math.acos((sunFromEarth.x * mk.x + sunFromEarth.y * mk.y + sunFromEarth.z * mk.z) / (ls * lm)) / D2R;
            if (!best || shine > best.shine) best = { jd, shine, elongDeg };
            if (!worst || shine < worst.shine) worst = { jd, shine, elongDeg };
        }
        assert.ok(best.elongDeg < 15, `earthshine peaks at NEW moon, got elongation ${best.elongDeg.toFixed(1)} deg`);
        assert.ok(worst.elongDeg > 165, `earthshine bottoms at FULL moon, got elongation ${worst.elongDeg.toFixed(1)} deg`);
        assert.ok(best.shine / Math.max(worst.shine, 1e-15) > 100, 'the month spans a large earthshine swing');
    }

    // Jupiter lights Io far harder than Earth lights the Moon.
    const io = reflectedIrradianceFraction({
        bodyFromPlanetKm: { x: 421_700, y: 0, z: 0 },
        sunFromPlanetKm: { x: 5.2 * AU_KM, y: 0, z: 0 },
        planetRadiusKm: 71_492, albedo: BODY_ALBEDO.jupiter,
    });
    assert.ok(io > 10 * full, 'Jupiter-shine at Io dwarfs earthshine at the Moon');

    // Albedo table sanity: every entry is a real reflectance, and the two
    // famous extremes are on the right ends.
    for (const [k, v] of Object.entries(BODY_ALBEDO)) {
        assert.ok(v > 0 && v < 1.5, `${k} albedo in range`);
    }
    assert.ok(BODY_ALBEDO.enceladus > 1, 'Enceladus backscatters above unity — not a typo');
    assert.ok(BODY_ALBEDO.moon < 0.15, 'the Moon is as dark as worn asphalt');
    assert.ok(BODY_ALBEDO.moon > BODY_ALBEDO.phobos, 'Phobos is darker still');
}

console.log(`eclipse-geometry: lens regimes + Monte-Carlo, umbra geometry, ${KNOWN.length} published lunar eclipses reproduced, earthshine — passed`);
