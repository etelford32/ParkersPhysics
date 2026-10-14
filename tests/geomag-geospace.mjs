/**
 * geomag-geospace.mjs — gates for js/geomag/geospace.js (the Sun/Moon layer
 * of the TIGA 3D view).
 *
 * Each block pins either an IDENTITY (one quantity derived two independent
 * ways), a PUBLISHED anchor (an almanac date, a paper's coefficient), or a
 * physical CLAIM the page prints — and the claims carry a negative control
 * that puts the effect back to zero, so a gate that passes for the wrong
 * reason is visible.
 *
 *   node tests/geomag-geospace.mjs
 */

import assert from 'node:assert/strict';
import * as G from '../js/geomag/geospace.js';
import { subsolarPointGeo, dipoleTilt } from '../js/geomag/dipole.js';
import { shueStandoffRe } from '../js/ring-current-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const DAY = 86400e3;

console.log('geospace — frames');
{
    // ONE Sun: the scene's sub-solar point must be dipole.js's, exactly, or
    // the terminator and the dipole tilt describe different Suns.
    for (const iso of ['2026-03-20T12:00:00Z', '2026-06-21T03:00:00Z', '2026-12-21T18:30:00Z']) {
        const d = new Date(iso);
        const s = G.geospaceState(d).sun.subsolar;
        const ref = subsolarPointGeo(d);
        near(s.latDeg, ref.latDeg, 1e-9, `subsolar lat ${iso}`);
        near(s.lonDeg, ref.lonDeg, 1e-9, `subsolar lon ${iso}`);
    }
    ok('sub-solar point is dipole.js subsolarPointGeo to 1e-9°');

    // Solstice anchor: the Sun stands at +ε over the Tropic of Cancer.
    near(G.geospaceState(new Date('2026-06-21T08:24:00Z')).sun.subsolar.latDeg, 23.44, 0.02, 'June solstice');
    ok('June solstice sub-solar latitude = obliquity');

    // The scene convention core-3d.js uses: (x, z, −y). A ROTATION (det +1),
    // not a reflection — a reflection mirrors longitude and still looks fine.
    const ex = G.geoToScene([1, 0, 0]), ey = G.geoToScene([0, 1, 0]), ez = G.geoToScene([0, 0, 1]);
    const det = ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) - ex[1] * (ey[0] * ez[2] - ey[2] * ez[0])
        + ex[2] * (ey[0] * ez[1] - ey[1] * ez[0]);
    assert.equal(det, 1, 'geoToScene determinant');
    assert.deepEqual(G.geoToScene([0, 1, 0]), [0, 0, -1], '90°E lands on −Z, as core-3d places it');
    ok('geo → scene is the core-3d convention and a proper rotation');

    // The dipole tilt the page prints is dipole.js's, unchanged.
    const d = new Date('2026-10-12T17:00:00Z');
    assert.equal(G.geospaceState(d).dipoleTiltDeg, dipoleTilt(d));
    ok('dipole tilt is dipole.js dipoleTilt, not a second copy');
}

console.log('geospace — ephemeris anchors');
{
    // Earth's orbital speed: 30.29 km/s at perihelion (early Jan), 29.29 at
    // aphelion (early Jul). Differenced, not assumed — so it must swing.
    const vJan = Math.hypot(...G.earthOrbitalVelocityGei(new Date('2026-01-03T00:00:00Z')));
    const vJul = Math.hypot(...G.earthOrbitalVelocityGei(new Date('2026-07-06T00:00:00Z')));
    near(vJan, 30.29, 0.05, 'perihelion speed');
    near(vJul, 29.29, 0.05, 'aphelion speed');
    ok(`orbital speed ${vJan.toFixed(2)} (Jan) / ${vJul.toFixed(2)} (Jul) km/s — eccentricity carried`);

    // Full moon 2024-05-23 13:53 UTC; total solar eclipse new moon
    // 2024-04-08 18:21 UTC (USNO). Meeus ch.47 truncated is ~0.2° — ~25 min.
    const fm = G.fullMoons(new Date('2024-05-15T00:00:00Z'), 15);
    assert.equal(fm.length, 1, 'one full moon in the window');
    near(fm[0], Date.parse('2024-05-23T13:53:00Z'), 45 * 60e3, 'full moon time');
    const nm = G.moonPhase(new Date('2024-04-08T18:21:00Z'));
    assert.ok(nm.elongationDeg < 1.5, `eclipse new moon elongation ${nm.elongationDeg}`);
    assert.equal(nm.name, 'New moon');
    ok(`full moon within ${Math.abs(fm[0] - Date.parse('2024-05-23T13:53:00Z')) / 60e3 | 0} min of USNO; eclipse new moon at ${nm.elongationDeg.toFixed(2)}°`);

    // The Moon stays between perigee and apogee extremes.
    let lo = Infinity, hi = 0;
    for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += DAY / 4) {
        const r = G.moonGei(new Date(t)).distKm;
        lo = Math.min(lo, r); hi = Math.max(hi, r);
    }
    assert.ok(lo > 355000 && lo < 362000, `perigee ${lo}`);
    assert.ok(hi > 404000 && hi < 407500, `apogee ${hi}`);
    ok(`lunar distance spans ${Math.round(lo)}–${Math.round(hi)} km over 2026`);
}

console.log('geospace — boundaries');
{
    // Pdyn identity: 5 cm⁻³ at 400 km/s is 1.338 nPa.
    near(G.dynamicPressureNPa(5, 400), 1.33808, 1e-9, 'Pdyn');
    assert.equal(G.dynamicPressureNPa(0, 400), null);
    ok('dynamic pressure = m_p n v²');

    // The standoff is the site's ONE Shue copy, not a re-derivation.
    const b = G.boundaryModel({ speedKms: 450, densityCc: 7, bzNt: -6 });
    assert.equal(b.r0Re, shueStandoffRe(b.pdynNPa, -6));
    ok('magnetopause r₀ comes from ring-current-model.js shueStandoffRe');

    // F91 anchors: at the reference pressure the nose is L₀/(1+e) = 13.70 R_E
    // and the ellipse closes L₀/(1−e) = 130.5 R_E downstream.
    const L = G.bowShockL(G.F91.p0NPa);
    near(L, 24.8, 1e-12, 'F91 L at P₀');
    near(G.bowShockRadiusRe(0, L), 13.702, 1e-3, 'F91 nose');
    assert.equal(G.bowShockRhoRe(-131, L), null, 'past closure');
    ok('F91 ellipse: nose 13.70 R_E, closes at 130.5 R_E');

    // Pressure scaling, both boundaries: ×8 pressure ⇒ F91 ×1/√2, Shue ×8^(−1/6.6).
    const b1 = G.boundaryModel({ speedKms: 400, densityCc: 5, bzNt: 0 });
    const b8 = G.boundaryModel({ speedKms: 400, densityCc: 40, bzNt: 0 });
    near(b8.bowL / b1.bowL, Math.pow(8, -1 / 6), 1e-12, 'F91 ∝ P^-1/6');
    near(b8.r0Re / b1.r0Re, Math.pow(8, -1 / 6.6), 1e-12, 'Shue ∝ P^-1/6.6');
    ok('both boundaries scale with the published pressure exponents');

    // The bow shock must enclose the magnetopause on every ray out past the
    // Moon for quiet and nominal wind, or the magnetosheath has negative
    // thickness where the Moon spends a week a month.
    for (const w of [{ speedKms: 300, densityCc: 2, bzNt: 10 }, b1, { speedKms: 550, densityCc: 10, bzNt: -8 }]) {
        const bm = G.boundaryModel(w);
        assert.equal(bm.fitsCrossAtXRe, null, `fits cross for ${JSON.stringify(w)}`);
    }
    // ...and under an extreme wind the two INDEPENDENT fits do cross, and the
    // kernel must SAY so rather than draw a sheath of negative thickness.
    const g5 = G.boundaryModel({ speedKms: 900, densityCc: 30, bzNt: -30 });
    assert.ok(g5.fitsCrossAtXRe < -G.FIT_LIMIT_RE && g5.fitsCrossAtXRe > -80,
        `G5 crossing ${g5.fitsCrossAtXRe}`);
    const th = Math.PI - 0.3;
    assert.ok(G.bowShockRadiusRe(th, g5.bowL) < G.magnetopauseRadiusRe(th, g5.r0Re, g5.alpha),
        'control: the crossing is real, not a scan artefact');
    ok(`sheath consistent to past the Moon for quiet/nominal/active wind; `
        + `extreme wind: fits cross at X = ${g5.fitsCrossAtXRe.toFixed(1)} R_E and the kernel reports it`);

    // Tail radius at lunar distance. ARTEMIS and Apollo-era crossings put the
    // distant-tail radius at ~25–30 R_E; Shue extrapolated must land there,
    // and the result must carry the extrapolation flag.
    const rt = G.tailRadiusRe(-60, b1.r0Re, b1.alpha);
    assert.ok(rt > 22 && rt < 32, `tail radius ${rt}`);
    ok(`magnetotail radius at X = −60 R_E: ${rt.toFixed(1)} R_E (nominal wind)`);

    // Missing pieces fall back to nominal AND say so.
    const fb = G.boundaryModel({ speedKms: 500 });
    assert.deepEqual(fb.fellBack, ['densityCc', 'bzNt']);
    ok('a partial feed reports exactly which values were nominal');
}

console.log('geospace — the Moon in the magnetosphere');
{
    const full = new Date('2024-05-23T13:53:00Z');
    const r = G.moonRegion(full);
    assert.equal(r.region, 'magnetotail');
    assert.equal(r.extrapolated, true, 'lunar distance is past both fits');
    assert.equal(G.moonRegion(new Date('2024-04-08T18:21:00Z')).region, 'solar-wind');
    ok('full moon → magnetotail (flagged extrapolated); new moon → solar wind');

    // Physical direction: higher dynamic pressure narrows the tail at the Moon.
    const quiet = G.moonRegion(full, { speedKms: 350, densityCc: 3, bzNt: 2 });
    const storm = G.moonRegion(full, { speedKms: 800, densityCc: 25, bzNt: -20 });
    assert.ok(storm.tailRadiusRe < quiet.tailRadiusRe, 'pressure narrows the tail');
    ok(`tail radius at the Moon: ${quiet.tailRadiusRe.toFixed(1)} (quiet) → ${storm.tailRadiusRe.toFixed(1)} R_E (storm)`);

    // THE ABERRATION CLAIM, with its negative control. Several lunations, so a
    // single lucky month cannot carry it.
    const start = new Date('2026-01-01T00:00:00Z');
    const days = 120;
    const fms = G.fullMoons(start, days);
    const withAb = G.tailTransits(start, days);
    const without = G.tailTransits(start, days, G.NOMINAL_WIND, { aberration: false });
    const offsets = (wins) => fms.map((f) => {
        const w = wins.find((x) => x.midMs != null && Math.abs(x.midMs - f) < 3 * DAY);
        assert.ok(w, `a tail transit around full moon ${new Date(f).toISOString()}`);
        return (w.midMs - f) / DAY;
    });
    const oAb = offsets(withAb);
    const oNo = offsets(without);
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    // Expected: atan(29.8/400) = 4.26° ÷ ~12.2°/day of lunar motion relative
    // to the Sun line ⇒ ~0.35 d, BEFORE full moon.
    assert.ok(mean(oAb) < -0.2 && mean(oAb) > -0.5, `aberrated offset ${mean(oAb)}`);
    assert.ok(Math.abs(mean(oNo)) < 0.1, `control offset ${mean(oNo)}`);
    ok(`tail crossing centred ${(-mean(oAb) * 24).toFixed(1)} h BEFORE full moon; `
        + `${(mean(oNo) * 24).toFixed(1)} h with aberration off (control)`);

    // Duration: published lunar tail residence is ~4–6 days per month.
    for (const w of withAb.filter((x) => x.entryMs && x.exitMs)) {
        const dd = (w.exitMs - w.entryMs) / DAY;
        assert.ok(dd > 3 && dd < 7, `tail residence ${dd} d`);
    }
    ok(`tail residence ${withAb.filter((x) => x.midMs).map((w) => ((w.exitMs - w.entryMs) / DAY).toFixed(1)).join(', ')} d per lunation`);

    near(G.aberrationDeg(full, 400), Math.atan(29.4 / 400) * 180 / Math.PI, 0.05, 'aberration angle');
    ok('aberration angle = atan(v_E / v_sw)');

    // L1 lag: 1.5e6 km at 400 km/s is 62.5 min.
    near(G.l1LagMinutes(400), 62.5, 1e-9, 'L1 lag');
    ok('L1 → Earth lag 62.5 min at 400 km/s');
}

console.log('geospace — the snapshot the scene draws');
{
    const s = G.geospaceState(new Date('2026-10-12T12:00:00Z'));
    const len = (v) => Math.hypot(v[0], v[1], v[2]);
    near(len(s.sun.scene), 1, 1e-12, 'sun unit');
    near(len(s.flowAxisScene), 1, 1e-12, 'axis unit');
    near(len(s.moon.scene), s.moon.distRe, 1e-9, 'moon at true distance');
    // The orbit snapshot starts AT the Moon (sample 0 is now).
    near(s.moon.orbitScene[0], s.moon.scene[0], 1e-3, 'orbit starts at the Moon x');
    near(s.moon.orbitScene[2], s.moon.scene[2], 1e-3, 'orbit starts at the Moon z');
    // Sun-from-Moon minus Earth-from-Moon = Sun from Earth.
    const sf = s.moon.sunFromMoonKm, ef = s.moon.earthFromMoonKm;
    const sunKm = [sf[0] - ef[0], sf[1] - ef[1], sf[2] - ef[2]];
    near(len(sunKm) / G.AU_KM, s.sun.distAU, 1e-9, 'vector closure');
    ok('scene vectors are unit / true-distance and close on themselves');
}

console.log(`\n${passed} geospace checks passed`);
