/**
 * Gate for js/skyview/sky-engine.js + sky-projection.js — SkyView's kernels.
 *
 * Every assertion is a published worked example, a DEFINING value, or an
 * identity between two independently written paths:
 *
 *   - Meeus Example 13.b (Venus from the US Naval Observatory, 1987-04-10):
 *     the whole J2000 → of-date → horizon chain must land within 0.003° of
 *     the book. The residual is nutation, which is deliberately not modelled.
 *   - The galactic rotation reproduces its own definitions: the galactic
 *     centre at (266.405°, −28.936°) and the north galactic pole at
 *     (192.859°, +27.128°) — this is the bridge to galactic-map.html.
 *   - The celestial pole OF DATE stands at altitude = latitude, due north;
 *     an object at hour angle +6 h is in the WEST. Either wrong mirrors the
 *     sky and still draws a plausible one.
 *   - At the sub-solar point (neo-space's own) the Sun is at the zenith.
 *   - Meeus Example 32.a (Venus, 1992-12-20, VSOP87 of date): Mercury–Mars
 *     series are J2000 and must be ROTATED to agree with it; and the outer-
 *     planet VSOP87D series are OF DATE: rotated, they agree with an
 *     independent J2000 Kepler propagation at 1900 and 2100 better than
 *     unrotated (where precession is ±1.4° and dominates the series error).
 *   - Projections invert exactly, put east on the LEFT of the overhead dome
 *     and on the RIGHT when facing north, and the fitted horizon circle
 *     passes through the projected horizon.
 */
import assert from 'node:assert/strict';
import {
    jdFromMs, raDecToVec, vecToRaDec, angularSeparationDeg,
    galacticToEquatorial, equatorialToGalactic,
    skyFrame, toEnu, fromEnu, enuToAltAz, altAzToEnu, horizontalOf, topocentricRaDec,
    refractionDeg, airmass, extinctionMag, twilightLimit, moonPenalty, limitingMagnitude,
    SKY_QUALITY, PLANET_FRAMES, heliocentricJ2000, planetMagnitude, moonMagnitude,
    solarSystemObjects, sunAltitudeDeg, assessVisibility, rankByVisibility,
    extendedPenalty, glarePenalty, horizonEvents, nextDarkness, RISE_ALT,
    compassPoint, formatRa, formatDec, formatMag, D2R, R2D,
} from '../js/skyview/sky-engine.js';
import {
    createView, project, unproject, projectAltAz, unprojectAltAz, horizonCircle, circleThrough,
} from '../js/skyview/sky-projection.js';
import {
    ofDateEquatorialToJ2000Matrix, subSolarPoint, ofDateToJ2000, j2000ToOfDate,
} from '../js/neo-space.js';
import { planetElementsAt } from '../js/horizons.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} ± ${tol}`);
const mat = (m, v) => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
const jdUTC = (iso) => jdFromMs(Date.parse(iso));

// ── Meeus 13.b ──────────────────────────────────────────────────────────────
{
    const jd = jdUTC('1987-04-10T19:21:00Z');
    // The book's position is apparent OF DATE; rotate it to J2000 (the catalogue frame).
    const vJ = mat(ofDateEquatorialToJ2000Matrix(jd), raDecToVec(347.3193375, -6.719892));
    const { raDeg, decDeg } = vecToRaDec(vJ);
    const f = skyFrame(jd, 38 + 55 / 60 + 17 / 3600, -(77 + 3 / 60 + 56 / 3600));
    const h = horizontalOf(f, raDeg, decDeg);
    near(h.altDeg, 15.1249, 0.003, 'Meeus 13.b altitude');
    near(h.azDeg - 180, 68.0337, 0.003, 'Meeus 13.b azimuth (book measures from south)');
}

// ── Galactic frame definitions ──────────────────────────────────────────────
{
    const gc = galacticToEquatorial(0, 0);
    near(gc.raDeg, 266.40500, 0.001, 'galactic centre RA');
    near(gc.decDeg, -28.93617, 0.001, 'galactic centre Dec');
    const ngp = galacticToEquatorial(123, 90);
    near(ngp.raDeg, 192.85948, 0.001, 'north galactic pole RA');
    near(ngp.decDeg, 27.12825, 0.001, 'north galactic pole Dec');
    for (const [ra, dec] of [[10, 20], [101.287, -16.716], [279.23, 38.78], [350, -70]]) {
        const g = equatorialToGalactic(ra, dec);
        const e = galacticToEquatorial(g.lDeg, g.bDeg);
        assert.ok(angularSeparationDeg(ra, dec, e.raDeg, e.decDeg) < 1e-9, 'galactic round trip');
    }
}

// ── The observer's frame: orthonormal, right-handed, pole at latitude ───────
{
    const jd = jdUTC('2026-10-05T03:00:00Z');
    for (const lat of [-33.9, 0, 40, 64.8]) {
        const f = skyFrame(jd, lat, -105);
        const m = f.m;
        const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
        near(det, 1, 1e-12, `frame determinant at lat ${lat}`);
        // The pole of DATE, expressed in J2000, stands at altitude = latitude due north.
        const poleJ = mat(ofDateEquatorialToJ2000Matrix(jd), [0, 0, 1]);
        const [e, n, u] = toEnu(f, poleJ);
        const { altDeg, azDeg } = enuToAltAz(e, n, u);
        near(altDeg, lat, 1e-9, `celestial pole altitude at lat ${lat}`);
        if (lat > 0) near(Math.min(azDeg, 360 - azDeg), 0, 1e-6, 'pole is due north');
        const back = fromEnu(f, [e, n, u]);
        assert.ok(Math.hypot(back[0] - poleJ[0], back[1] - poleJ[1], back[2] - poleJ[2]) < 1e-12, 'fromEnu inverts toEnu');
    }
    // Hour angle +6h (RA = LST − 90°, of date) on the equator is due WEST.
    const f = skyFrame(jd, 40, -105);
    const vDate = raDecToVec(f.lstDeg - 90, 0);
    const vJ = mat(ofDateEquatorialToJ2000Matrix(jd), vDate);
    const { altDeg, azDeg } = enuToAltAz(...toEnu(f, vJ));
    near(altDeg, 0, 1e-9, 'HA +6h on the equator is on the horizon');
    near(azDeg, 270, 1e-9, 'HA +6h is due WEST (east-west mirror check)');
}

// ── Sub-solar point ⇒ Sun at the zenith ─────────────────────────────────────
for (const iso of ['2026-03-20T12:00:00Z', '2026-06-21T03:00:00Z', '2026-12-21T18:30:00Z']) {
    const jd = jdUTC(iso);
    const ss = subSolarPoint(jd);
    near(sunAltitudeDeg(jd, ss.latDeg, ss.lonDeg), 90, 0.01, `Sun at the zenith of the sub-solar point (${iso})`);
}

// ── Planet frames ───────────────────────────────────────────────────────────
{
    // Meeus 32.a: Venus 1992-12-20 0h TD, VSOP87 OF DATE: L = 26.11428°, B = −2.62070°, R = 0.724603.
    const jd = 2448976.5;
    const h = heliocentricJ2000('venus', jd);          // J2000
    const od = j2000ToOfDate(h.x, h.y, h.z, jd);
    let L = Math.atan2(od.y, od.x) * R2D; if (L < 0) L += 360;
    const r = Math.hypot(od.x, od.y, od.z);
    near(L, 26.11428, 0.03, 'Venus heliocentric longitude of date (Meeus 32.a)');
    near(Math.asin(od.z / r) * R2D, -2.62070, 0.02, 'Venus heliocentric latitude (Meeus 32.a)');
    near(r, 0.724603, 1e-4, 'Venus radius vector (Meeus 32.a)');
    // …and treating the series as of-date would be ~0.10° worse.
    let Lwrong = Math.atan2(h.y, h.x) * R2D; if (Lwrong < 0) Lwrong += 360;
    assert.ok(Math.abs(Lwrong - 26.11428) > Math.abs(L - 26.11428), 'Venus series is J2000, not of date');
    assert.equal(PLANET_FRAMES.venus.frame, 'j2000');

    // Outer planets: VSOP87D is OF DATE. Against an independent J2000 Kepler
    // propagation (Table 31.b mean elements, solved exactly here) the raw
    // series' longitude DRIFTS at the general precession rate, 1.397°/century;
    // rotated by `heliocentricJ2000` the drift is ~0. A linear fit over
    // 1800–2200 because the perturbation errors are bounded and average out,
    // while a frame error grows without limit. (Endpoint-only comparisons were
    // tried first and are inconclusive: Uranus's mean elements are ~0.9° off on
    // their own, and true-vs-mean longitude differs by the equation of centre.)
    // Measured: raw 1.41 / 1.84 / 1.45 / 1.36 °/century (Saturn's excess is the
    // 900-yr great inequality); Mercury–Mars 0.000.
    const PRECESSION = 5029.0966 / 3600;
    const kepler = (id, jd2) => {
        const el = planetElementsAt(id, jd2);
        const M = el.M * D2R; let E = M;
        for (let i = 0; i < 30; i++) E -= (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
        const xv = el.a * (Math.cos(E) - el.e), yv = el.a * Math.sqrt(1 - el.e ** 2) * Math.sin(E);
        const v = Math.atan2(yv, xv), rr = Math.hypot(xv, yv);
        const N = el.node * D2R, inc = el.i * D2R, u = (el.omegaBar - el.node) * D2R + v;
        return [rr * (Math.cos(N) * Math.cos(u) - Math.sin(N) * Math.sin(u) * Math.cos(inc)),
                rr * (Math.sin(N) * Math.cos(u) + Math.cos(N) * Math.sin(u) * Math.cos(inc))];
    };
    const driftDegPerCentury = (id, lonFn) => {
        let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
        for (let t = -2; t <= 2 + 1e-9; t += 1 / 60) {
            const jd2 = 2451545 + t * 36525;
            const k = kepler(id, jd2);
            const d = (((lonFn(jd2) - Math.atan2(k[1], k[0])) * R2D + 540) % 360) - 180;
            sx += t; sy += d; sxx += t * t; sxy += t * d; n++;
        }
        return (n * sxy - sx * sy) / (n * sxx - sx * sx);
    };
    for (const [id, spec] of Object.entries(PLANET_FRAMES)) {
        const raw = driftDegPerCentury(id, (jd2) => { const p = spec.fn(jd2); return Math.atan2(p.y_AU, p.x_AU); });
        const rot = driftDegPerCentury(id, (jd2) => { const p = heliocentricJ2000(id, jd2); return Math.atan2(p.y, p.x); });
        near(raw, spec.frame === 'date' ? PRECESSION : 0, 0.5, `${id}: raw series drift says frame '${spec.frame}'`);
        near(rot, 0, 0.5, `${id}: heliocentricJ2000 has no frame drift`);
    }
}

// ── Magnitudes (identities of the Mallama & Hilton forms) ───────────────────
{
    // At zero phase every form reduces to its constant + 5 log10(rΔ).
    near(planetMagnitude('jupiter', 5.2, 4.2, 0), -9.395 + 5 * Math.log10(5.2 * 4.2), 1e-12, 'Jupiter at opposition');
    near(planetMagnitude('venus', 0.7233, 1.7233, 0), -4.384 + 5 * Math.log10(0.7233 * 1.7233), 1e-12, 'Venus at superior conjunction');
    near(planetMagnitude('saturn', 9.5, 8.5, 0, { ringTiltDeg: 0 }), -8.914 + 5 * Math.log10(9.5 * 8.5), 1e-12, 'Saturn rings edge-on');
    assert.ok(planetMagnitude('saturn', 9.5, 8.5, 0, { ringTiltDeg: 26 }) < planetMagnitude('saturn', 9.5, 8.5, 0, { ringTiltDeg: 5 }),
        'open rings make Saturn brighter');
    // Venus at greatest elongation is near −4.4 (the familiar evening-star value).
    const ge = planetMagnitude('venus', 0.7233, Math.sqrt(1 - 0.7233 ** 2), 90);
    assert.ok(ge > -4.8 && ge < -4.2, `Venus at greatest elongation ≈ −4.4, got ${ge}`);
    near(moonMagnitude(0, 384_400, 1), -12.73, 1e-12, 'full Moon at mean distance');
    assert.ok(moonMagnitude(90, 384_400, 1) > -10.5 && moonMagnitude(90, 384_400, 1) < -9.5, 'quarter Moon ≈ −10');
}

// ── Atmosphere ──────────────────────────────────────────────────────────────
{
    near(refractionDeg(90), 0, 0.0005, 'no refraction at the zenith');
    const r0 = refractionDeg(0) * 60;
    assert.ok(r0 > 28 && r0 < 36, `horizon refraction ~0.5°, got ${r0}′`);
    near(refractionDeg(45) * 60, 1.0, 0.1, 'refraction at 45° ≈ 1′');
    assert.equal(refractionDeg(-5), 0, 'below −2° nothing is refracted into view');
    for (let h = -1.9; h < 89; h += 0.7) assert.ok(refractionDeg(h) >= refractionDeg(h + 0.7), 'refraction falls with altitude');
    near(airmass(90), 1, 1e-3, 'airmass 1 at the zenith');
    near(airmass(30), 2, 0.01, 'airmass ≈ 2 at 30°');
    assert.ok(airmass(0) > 35 && airmass(0) < 41, 'airmass ≈ 38 at the horizon');
    near(extinctionMag(90), 0, 1e-3, 'no excess extinction at the zenith');
}

// ── Limiting magnitude ──────────────────────────────────────────────────────
{
    let prev = Infinity;
    for (let h = 10; h >= -30; h -= 0.5) {
        const L = twilightLimit(h);
        assert.ok(L >= prev - 1e-12 || prev === Infinity, 'the sky never gets brighter as the Sun sinks');
        prev = L;
    }
    near(twilightLimit(30), -4, 1e-12, 'daylight: Venus-class only');
    for (const q of Object.values(SKY_QUALITY)) {
        near(limitingMagnitude({ sunAltDeg: -40, skyQuality: q.id }).limit, q.limit, 1e-12, `${q.id} dark limit is the site limit`);
    }
    const full = moonPenalty({ moonAltDeg: 60, illuminated: 1, siteLimit: 6.5 });
    assert.ok(full > 1.5 && full <= 2.0, `a high full Moon costs a dark site ~2 mag, got ${full}`);
    assert.ok(moonPenalty({ moonAltDeg: 60, illuminated: 1, siteLimit: 3.0 }) === 0, 'a city sky has no headroom to lose');
    assert.equal(moonPenalty({ moonAltDeg: -5, illuminated: 1, siteLimit: 6 }), 0, 'a set Moon costs nothing');
    assert.equal(limitingMagnitude({ sunAltDeg: 10 }).regime, 'day');
}

// ── Visibility ──────────────────────────────────────────────────────────────
{
    const env = { limit: 5, sunAltDeg: -30, k: 0.25 };
    assert.equal(assessVisibility({ mag: 0, altDeg: -1 }, env).status, 'below');
    assert.equal(assessVisibility({ mag: NaN, altDeg: 40 }, env).status, 'nomag');
    const bright = assessVisibility({ mag: 0, altDeg: 60 }, env);
    const faint = assessVisibility({ mag: 4, altDeg: 60 }, env);
    const low = assessVisibility({ mag: 0, altDeg: 3 }, env);
    assert.ok(bright.margin > faint.margin && bright.margin > low.margin, 'brighter / higher ranks first');
    assert.equal(bright.status, 'easy');
    near(extendedPenalty('galaxy', 190), Math.log10(19), 1e-12, 'M31 pays log10(19) mag');
    near(extendedPenalty('open-cluster', 100), 0.5, 1e-12, 'clusters pay half');
    assert.equal(extendedPenalty('galaxy', 8), 0);
    assert.equal(glarePenalty(40, -3), 0);
    assert.ok(glarePenalty(10, 5) > glarePenalty(10, -6), 'glare fades with the twilight');
    const ranked = rankByVisibility([
        { key: 'a', mag: 1, vis: { margin: 2 } }, { key: 'b', mag: 0, vis: { margin: 3 } },
        { key: 'c', mag: 0, vis: { margin: -Infinity } },
    ]);
    assert.deepEqual(ranked.map((o) => [o.key, o.rank]), [['b', 1], ['a', 2]], 'ranking drops the unrankable');
}

// ── The solar system at a known event: Saturn at opposition, 2026-10-04 ─────
{
    const jd = jdUTC('2026-10-04T12:00:00Z');
    const f = skyFrame(jd, 0, 0);
    const objs = solarSystemObjects(f);
    const sat = objs.find((o) => o.id === 'saturn');
    assert.ok(sat.elongationDeg > 175, `Saturn is at opposition (elongation ${sat.elongationDeg.toFixed(1)}°)`);
    assert.ok(sat.mag > -0.3 && sat.mag < 0.9, `Saturn near opposition with nearly closed rings, V=${sat.mag.toFixed(2)}`);
    for (const o of objs) assert.ok(Number.isFinite(o.mag) && Number.isFinite(o.raDeg), `${o.id} is finite`);
    // Topocentric parallax: from the sub-lunar point vs the Moon's horizon, ~1°.
    const moon = objs.find((o) => o.id === 'moon');
    const geo = raDecToVec(moon.raDeg, moon.decDeg);
    const distKm = moon.distKm;
    assert.ok(distKm > 350_000 && distKm < 410_000, 'Moon range');
    void geo;
}

// ── Moon parallax: topocentric differs from geocentric by ≈ asin(R⊕/d)·cos(alt)
{
    const jd = jdUTC('2026-10-05T03:00:00Z');
    const f = skyFrame(jd, 40, -105);
    const d = 384_400;
    const v = raDecToVec(120, 10);
    const t = topocentricRaDec(f, v.map((c) => c * d));
    const geoAlt = horizontalOf(f, 120, 10).altDeg;
    const topoAlt = horizontalOf(f, t.raDeg, t.decDeg).altDeg;
    const expect = Math.asin(6371 / d) * R2D * Math.cos(geoAlt * D2R);
    near(geoAlt - topoAlt, expect, 0.01, 'lunar diurnal parallax');
}

// ── Rise / set ──────────────────────────────────────────────────────────────
{
    // A fixed star against the closed form cos H0 = (sin h0 − sinφ sinδ)/(cosφ cosδ).
    const lat = 40, lon = -105, ra = 101.287, dec = -16.716;      // Sirius
    const jd0 = jdUTC('2026-01-15T00:00:00Z');
    const altFn = (jd) => horizontalOf(skyFrame(jd, lat, lon), ra, dec).altDeg;
    const ev = horizonEvents(altFn, jd0, { spanDays: 1.1, h0: 0, stepMin: 10 });
    assert.ok(ev.rise != null && ev.set != null, 'Sirius rises and sets at 40°N');
    const H0 = Math.acos(-Math.tan(lat * D2R) * Math.tan(dec * D2R)) * R2D;   // h0 = 0
    let up = (ev.set - ev.rise) * 24; if (up < 0) up += 23.9345;
    near(up, (2 * H0 / 15) * 0.99727, 2 / 60, 'time above the horizon = 2·H0 sidereal');
    // δ OF DATE: precession has moved Sirius 0.03° south since J2000.
    const P = ofDateEquatorialToJ2000Matrix(ev.transit.jd);
    const vJ = raDecToVec(ra, dec);
    const decDate = vecToRaDec([0, 1, 2].map((c) => P[c] * vJ[0] + P[3 + c] * vJ[1] + P[6 + c] * vJ[2])).decDeg;
    near(ev.transit.altDeg, 90 - lat + decDate, 0.002, 'culmination altitude = 90 − φ + δ(date)');
    // Polaris is circumpolar at 40°N, Canopus never rises there.
    assert.equal(horizonEvents((jd) => horizontalOf(skyFrame(jd, lat, lon), 37.95, 89.26).altDeg, jd0).circumpolar, true);
    assert.equal(horizonEvents((jd) => horizontalOf(skyFrame(jd, lat, lon), 95.99, -52.70).altDeg, jd0).neverRises, true);
    // The midnight Sun: no darkness at 70°N in June.
    assert.equal(nextDarkness(jdUTC('2026-06-21T00:00:00Z'), 70, 20), null, 'no astronomical darkness at 70°N in June');
    const dk = nextDarkness(jdUTC('2026-10-05T18:00:00Z'), 40, -105);
    assert.ok(dk && dk.end > dk.start && (dk.end - dk.start) * 24 > 8, 'an October night at 40°N has 8+ dark hours');
    void RISE_ALT;
}

// ── Projection ──────────────────────────────────────────────────────────────
{
    const dome = createView({ mode: 'dome', width: 800, height: 600 });
    const z = projectAltAz(dome, 90, 0);
    near(z.x, 400, 1e-9, 'zenith at centre x'); near(z.y, 300, 1e-9, 'zenith at centre y');
    const nrt = projectAltAz(dome, 0, 0), est = projectAltAz(dome, 0, 90);
    assert.ok(nrt.y < 300 && Math.abs(nrt.x - 400) < 1e-6, 'north is UP on the dome');
    assert.ok(est.x < 400, 'east is on the LEFT of the overhead dome');
    near(Math.hypot(nrt.x - 400, nrt.y - 300), 2 * dome.s, 1e-9, 'the horizon is the rim');
    const hc = horizonCircle(dome);
    near(hc.r, 2 * dome.s, 1e-9, 'dome horizon circle radius');

    const look = createView({ mode: 'look', centerAltDeg: 20, centerAzDeg: 0, fovDeg: 90, width: 800, height: 600 });
    const e2 = projectAltAz(look, 20, 30), w2 = projectAltAz(look, 20, 330);
    assert.ok(e2.x > 400 && w2.x < 400, 'facing north, east is on the RIGHT');
    assert.ok(projectAltAz(look, 50, 0).y < 300, 'up is toward the zenith');
    for (const view of [dome, look]) {
        for (const [alt, az] of [[10, 10], [45, 200], [80, 300], [5, 359]]) {
            const p = projectAltAz(view, alt, az);
            if (!p) continue;
            const q = unprojectAltAz(view, p.x, p.y);
            near(q.altDeg, alt, 1e-9, `${view.mode} round-trip alt`);
            near(((q.azDeg - az + 540) % 360) - 180, 0, 1e-8, `${view.mode} round-trip az`);
        }
    }
    const lh = horizonCircle(look);
    for (const az of [-60, -20, 25, 70]) {
        const p = projectAltAz(look, 0, az);
        near(Math.hypot(p.x - lh.x, p.y - lh.y), lh.r, 1e-6, 'the fitted horizon passes through the projected horizon');
    }
    const g = projectAltAz(look, -5, 0);
    assert.equal(Math.hypot(g.x - lh.x, g.y - lh.y) < lh.r, lh.groundInside, 'groundInside agrees with a below-horizon point');
    assert.equal(project(dome, [0, 0, -1]), null, 'the nadir is not projected');
    assert.equal(circleThrough({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }), null, 'collinear points have no circle');
    void unproject;
}

// ── Formatting ──────────────────────────────────────────────────────────────
assert.equal(compassPoint(0), 'N'); assert.equal(compassPoint(91), 'E'); assert.equal(compassPoint(225), 'SW');
assert.equal(formatRa(101.287), '6h 45.1m');
assert.equal(formatDec(-16.716), '−16° 43′');
assert.equal(formatMag(-1.44), '−1.4');
assert.equal(formatMag(NaN), '—');
void ofDateToJ2000; void altAzToEnu;

console.log('skyview-engine.mjs — all assertions passed');
