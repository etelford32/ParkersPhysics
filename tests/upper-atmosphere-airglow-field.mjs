/**
 * tests/upper-atmosphere-airglow-field.mjs — where on the planet the airglow is
 *   node tests/upper-atmosphere-airglow-field.mjs
 *
 * Gates the PURE kernel js/upper-atmosphere-airglow-field.js: the group split
 * reproduces the old spherically uniform airglow exactly, day/night is
 * "sunlit at altitude" and not the ground terminator, the equatorial arcs and
 * the bubbles come from the SHARED fountain model at the right magnetic
 * latitudes, SAR arcs sit on the page's own plasmapause, the symbolic ripples
 * are zero-mean and fade below a pixel, and the GLSL mirror is generated from
 * the same numbers.
 */
import assert from 'node:assert/strict';
import {
    AIRGLOW_FIELD, MESO_IDS, RED_IDS, RED_RGB, airglowGroupsAt, solarZenithDeg,
    sunlitFraction, redDayShape, eiaFactor, bubbleFactor, invariantLatDeg, sarArc,
    sarWeight, GW, gwPhases, gwField, FountainSampler, NO_ARCS, airglowFieldAt,
    redFactorAt, airglowAtLocation, airglowColumnAt, redLineRegime,
    AIRGLOW_FIELD_GLSL, RED_RGB_GLSL, buildAirglowLUT, packRedIntoFieldLUT,
    brightestEveningArc, latForMagLat,
} from '../js/upper-atmosphere-airglow-field.js';
import {
    AIRGLOW_LAYERS, airglowAt, airglowColumn, R_EARTH_KM, magneticLatitude, latLonToScene,
    buildAtmosphereLUT, buildFieldLUT,
} from '../js/upper-atmosphere-column.js';
import { plasmapauseL } from '../js/upper-atmosphere-aurora-physics.js';
import { IonosphereFountain, dipEquatorLat } from '../js/ionosphere-fountain.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

// A neutral location: night, mid-latitude, no arcs, no ripples, quiet.
const NEUTRAL = { meso: 1, redNight: 1, sar: 0, cosChi: -1 };

console.log('\n── the split reproduces the old airglow ──');
t('every visible layer is in exactly one group, and the geocorona is invisible', () => {
    for (const L of AIRGLOW_LAYERS) {
        const inMeso = MESO_IDS.includes(L.id), inRed = RED_IDS.includes(L.id);
        assert.ok(!(inMeso && inRed), L.id);
        if (L.visibleFraction > 0) assert.ok(inMeso || inRed, `${L.id} is visible but in no group`);
    }
    assert.deepEqual(RED_RGB, AIRGLOW_LAYERS.find((L) => L.id === 'o-red').rgb);
});
t('meso + red at factor 1 IS airglowAt().visibleTotal, at every altitude and activity', () => {
    for (const ap of [5, 15, 80, 300]) for (const f107Sfu of [70, 150, 250]) {
        for (let h = 80; h <= 2000; h += 7) {
            const g = airglowGroupsAt(h, { f107Sfu, ap });
            const old = airglowAt(h, { f107Sfu, ap }).visibleTotal;
            close(g.meso + g.red, old, 1e-9 * Math.max(1, old), `h=${h}`);
        }
    }
});
t('at a neutral location the column is the old column (the render is unchanged where nothing is happening)', () => {
    for (const hT of [85, 97, 150, 250, 600]) {
        const a = airglowColumnAt({ tangentAltKm: hT, field: NEUTRAL });
        const b = airglowColumn({ tangentAltKm: hT });
        close(a.brightness, b.brightness, 1e-9 * b.brightness, `tangent ${hT}`);
    }
});

t('the renderer\'s tables add up to the old airglow row, on the same normalisation', () => {
    for (const ap of [15, 200]) {
        const old = buildAtmosphereLUT({ ap, bins: 128 });
        const meso = buildAirglowLUT({ ap, bins: 128 });
        close(meso.airglowMax, old.airglowMax, 1e-9 * old.airglowMax, 'same maximum');
        assert.equal(meso.rows, 1);
        // The red line and SAR ride in the density table's spare channels;
        // sample it on the SAME altitude grid as the old row for the sum.
        const field = packRedIntoFieldLUT(
            { data: new Float32Array(128 * 3 * 4), altBins: 128, tinfBins: 3, minKm: 80, maxKm: 2000 },
            { ap, airglowMax: meso.airglowMax });
        for (let i = 0; i < 128; i++) {
            for (let j = 0; j < 3; j++) {
                const k = (j * 128 + i) * 4;
                close(meso.data[i * 4 + 3] + field.data[k + 1], old.data[(128 + i) * 4 + 3], 1e-6, `bin ${i} row ${j}`);
                assert.equal(field.data[k], 0, 'density channel untouched');
            }
        }
    }
});
t('packing leaves the real density table\'s R channel alone', () => {
    const f = buildFieldLUT({ ap: 30 });
    const r = Array.from(f.data.filter((_, i) => i % 4 === 0));
    packRedIntoFieldLUT(f, { ap: 30, airglowMax: buildAirglowLUT({ ap: 30 }).airglowMax });
    assert.deepEqual(Array.from(f.data.filter((_, i) => i % 4 === 0)), r);
    assert.ok(Math.max(...f.data.filter((_, i) => i % 4 === 1)) > 0.02, 'red channel written (its peak is ~5 % of the green band\'s)');
});

console.log('\n── day and night ──');
t('solar zenith angle: 0 under the sun, 90 at the terminator, 180 opposite', () => {
    close(solarZenithDeg(10, 20, 10, 20), 0, 1e-6);
    close(solarZenithDeg(0, 110, 0, 20), 90, 1e-9);
    close(solarZenithDeg(-10, -160, 10, 20), 180, 1e-6);
});
t('sunlit AT ALTITUDE: 250 km stays lit ~12° past the ground terminator, 90 km does not', () => {
    const cos = (deg) => Math.cos(deg * Math.PI / 180);
    assert.equal(sunlitFraction(250, cos(60)), 1);
    assert.ok(sunlitFraction(250, cos(100)) > 0.99, 'red layer lit at χ=100°');
    assert.ok(sunlitFraction(90, cos(100)) < 0.01, 'mesosphere dark at χ=100°');
    assert.ok(sunlitFraction(250, cos(115)) < 0.01, 'red layer dark by χ=115°');
    // The edge at 250 km: (R+250)·sin χ = R + screenKm.
    const chiEdge = 180 - Math.asin((R_EARTH_KM + AIRGLOW_FIELD.screenKm) / (R_EARTH_KM + 250)) * 180 / Math.PI;
    close(sunlitFraction(250, cos(chiEdge)), 0.5, 0.01, 'half-lit at the shadow edge');
    assert.ok(chiEdge > 101 && chiEdge < 104, `edge at ${chiEdge}`);
});
t('sunlit fraction is continuous across χ = 90° at every altitude', () => {
    for (const h of [80, 95, 110, 150, 250, 400]) {
        let prev = sunlitFraction(h, Math.cos(80 * Math.PI / 180));
        for (let chi = 80; chi <= 120; chi += 0.01) {
            const v = sunlitFraction(h, Math.cos(chi * Math.PI / 180));
            assert.ok(Math.abs(v - prev) < 0.03, `jump at h=${h} χ=${chi}`);
            prev = v;
        }
    }
});
t('the red line is ~20× brighter by day; the mesospheric group does not change', () => {
    const noon = { ...NEUTRAL, cosChi: 1 }, night = { ...NEUTRAL, cosChi: -1 };
    close(redFactorAt(250, noon).red, AIRGLOW_FIELD.redDayGain, 1e-12);
    close(redFactorAt(250, night).red, 1, 1e-12);
    const cn = airglowColumnAt({ tangentAltKm: 200, field: noon });
    const cd = airglowColumnAt({ tangentAltKm: 200, field: night });
    assert.ok(cn.red / cd.red > 15, `day/night red column ${cn.red / cd.red}`);
    close(cn.meso, cd.meso, 1e-9 * cd.meso, 'meso identical day and night');
    assert.equal(redDayShape(-0.3), AIRGLOW_FIELD.redDayFloor);
    assert.equal(redDayShape(1), 1);
});

console.log('\n── the equatorial arcs and the bubbles ──');
t('arcs peak at ±crestLat, are 1 far from them, and scale with crest intensity', () => {
    const cl = 14;
    close(eiaFactor(0, 0, cl), 1, 1e-12, 'no crest ⇒ nothing');
    const peak = eiaFactor(cl, 1, cl);
    assert.ok(peak > 1 + 0.99 * AIRGLOW_FIELD.eiaGain, `peak ${peak}`);
    close(eiaFactor(-cl, 1, cl), peak, 1e-12, 'symmetric');
    assert.ok(eiaFactor(0, 1, cl) < 1.1, `trough at the dip equator ${eiaFactor(0, 1, cl)}`);
    assert.ok(eiaFactor(40, 1, cl) < 1.001);
    let best = -1, bestAt = 0;
    for (let ml = 0; ml <= 30; ml += 0.1) if (eiaFactor(ml, 0.8, cl) > best) { best = eiaFactor(ml, 0.8, cl); bestAt = ml; }
    close(bestAt, cl, 0.2, 'maximum at the crest');
});
t('a bubble darkens the arcs across both crests out to its extent, and nothing beyond', () => {
    assert.ok(bubbleFactor(12, 1, 20) < 0.2);
    assert.ok(bubbleFactor(-12, 1, 20) < 0.2);
    close(bubbleFactor(30, 1, 20), 1, 1e-12);
    close(bubbleFactor(12, 0, 20), 1, 1e-12);
});
t('the fountain sampler is the SHARED model: its table is the fountain\'s own cells', () => {
    const t0 = Date.UTC(2026, 2, 20, 0, 0);
    const s = new FountainSampler();
    s.advanceTo(t0, { kp: 2 });
    const f = s.fountain;
    assert.ok(f instanceof IonosphereFountain);
    for (const c of f.cells.filter((_, i) => i % 9 === 0)) {
        const smp = s.sampleAt(c.lonDeg);
        close(smp.crest, c.crest, 1e-3, `crest at ${c.lonDeg}`);
        close(smp.crestLatDeg, f.crestLatDeg(c), 1e-2);
    }
});
t('after spin-up the evening sector has bright crests and the morning sector dim ones', () => {
    const t0 = Date.UTC(2026, 2, 20, 0, 0);      // 00 UT: 21 LT at 45°W, 09 LT at 135°E
    const s = new FountainSampler();
    s.advanceTo(t0, { kp: 2 });
    const evening = s.sampleAt(-45).crest, morning = s.sampleAt(135).crest;
    assert.ok(evening > 0.4, `21 LT crest ${evening}`);
    assert.ok(morning < evening * 0.5, `09 LT ${morning} vs 21 LT ${evening}`);
    const cl = s.sampleAt(-45).crestLatDeg;
    assert.ok(cl >= 10 && cl <= 18, `crest latitude ${cl}`);
});
t('deterministic: a fresh spin-up and an integrated run agree; a backwards jump re-spins to the same state', () => {
    const t0 = Date.UTC(2026, 2, 20, 0, 0);
    const a = new FountainSampler(), b = new FountainSampler();
    a.advanceTo(t0 - 2 * 3.6e6); a.advanceTo(t0);
    b.advanceTo(t0);
    for (let x = 0; x < a.width * 4; x += 37) close(a.data[x], b.data[x], 1e-5, `texel ${x}`);
    const snap = Float32Array.from(a.data);
    a.advanceTo(t0 + 5 * 3.6e6);
    a.advanceTo(t0);                                 // backwards ⇒ re-spin
    for (let x = 0; x < a.width * 4; x += 37) close(a.data[x], snap[x], 1e-5);
    assert.equal(a.advanceTo(t0), false, 'same instant ⇒ no change');
});
t('bubbles in the fountain show up as masked longitudes with their field-aligned extent', () => {
    // Late evening after a storm-time loft: find a sampler instant with bubbles.
    const s = new FountainSampler();
    let found = null;
    for (let h = 0; h < 48 && !found; h++) {
        s.advanceTo(Date.UTC(2026, 2, 20, 0, 0) + h * 3.6e6, { kp: 3 });
        const bs = s.fountain.allBubbles().filter((b) => b.fade > 0.5);
        if (bs.length) found = bs[0];
    }
    assert.ok(found, 'a quiet two days produces at least one bubble');
    const smp = s.sampleAt(found.lonDeg);
    assert.ok(smp.bubble > 0.3, `mask at the bubble ${smp.bubble}`);
    close(smp.bubbleExtentDeg, found.latExtentDeg, 0.5);
    // Well away in longitude: no mask.
    assert.ok(s.sampleAt(found.lonDeg + 20).bubble < 0.05 || s.fountain.allBubbles().some(
        (b) => Math.abs(((b.lonDeg - found.lonDeg - 20 + 540) % 360) - 180) < 3));
});
t('the page\'s dipole and the fountain\'s dip equator are the same dipole', () => {
    for (let lon = -180; lon < 180; lon += 15) {
        const lat = dipEquatorLat(lon * Math.PI / 180) * 180 / Math.PI;
        close(magneticLatitude(lat, lon), 0, 1e-6, `lon ${lon}`);
    }
});

t('the explore stop for the arcs is the strongest evening crest, on its northern crest', () => {
    const t0 = Date.UTC(2026, 2, 20, 0, 0);          // sub-solar point near 180°
    const s = new FountainSampler();
    s.advanceTo(t0, { kp: 2 });
    const a = brightestEveningArc(s, 180);
    assert.ok(a, 'an evening crest exists after spin-up');
    assert.ok(a.lstHr >= 19.5 && a.lstHr <= 23, `local time ${a.lstHr}`);
    close(magneticLatitude(a.latDeg, a.lonDeg), a.crestLatDeg, 1e-6);
    for (let lon = -180; lon < 180; lon += 7) {
        const lst = ((12 + (lon - 180) / 15) % 24 + 24) % 24;
        if (lst >= 19.5 && lst <= 23) assert.ok(s.sampleAt(lon).crest <= a.crest + 1e-9);
    }
    assert.equal(brightestEveningArc(null, 0), null);
    close(magneticLatitude(latForMagLat(-12, 40), 40), -12, 1e-6);
});

console.log('\n── storms ──');
t('SAR arcs sit on the page\'s own plasmapause footprint and switch on above Kp 4', () => {
    for (const kp of [5, 6, 7, 8, 9]) {
        const s = sarArc(kp);
        close(s.latDeg, Math.acos(Math.sqrt(1 / plasmapauseL(kp))) * 180 / Math.PI, 1e-9);
    }
    assert.equal(sarArc(3).gain, 0);
    assert.equal(sarArc(4).gain, 0);
    assert.ok(sarArc(6).gain > 0 && sarArc(6).gain < sarArc(9).gain);
    close(sarArc(9).gain, AIRGLOW_FIELD.sarGainMax, 1e-12);
    // Kp 9 ⇒ L 2 ⇒ 45° — equatorward of the auroral oval, where Gannon's were seen.
    close(sarArc(9).latDeg, 45, 1e-9);
    close(invariantLatDeg(4), 60, 1e-9);
    const s = sarArc(8);
    assert.ok(sarWeight(s.latDeg, s) > 0.99 * s.gain);
    assert.ok(sarWeight(-s.latDeg, s) > 0.99 * s.gain, 'both hemispheres');
    assert.ok(sarWeight(s.latDeg + 10, s) < 0.01 * s.gain);
});
t('a SAR arc is dark-side only and adds to the red column there', () => {
    const f8 = { ...NEUTRAL, sar: sarArc(8).gain };
    const col8 = airglowColumnAt({ tangentAltKm: 300, field: f8 });
    const col0 = airglowColumnAt({ tangentAltKm: 300, field: NEUTRAL });
    assert.ok(col8.red > 3 * col0.red, `${col8.red} vs ${col0.red}`);
    close(redFactorAt(400, { ...f8, cosChi: 1 }).sar, 0, 1e-12, 'swamped by day');
});

console.log('\n── gravity-wave ripples (symbolic) ──');
t('the ripple table is deterministic, 30–300 km, one packet per wave, directions along the surface', () => {
    assert.equal(GW.waves.length, AIRGLOW_FIELD.gwCount);
    for (const w of GW.waves) {
        assert.ok(w.lambdaKm >= 30 && w.lambdaKm <= 300, `${w.lambdaKm}`);
        close(Math.hypot(...w.dir), 1, 1e-12);
        close(Math.hypot(...w.centre), 1, 1e-12);
        close(w.dir[0] * w.centre[0] + w.dir[1] * w.centre[1] + w.dir[2] * w.centre[2], 0, 1e-12,
            'tangent at the packet centre (no bullseye inside the packet)');
        assert.ok(w.amp > 0 && w.amp <= 1);
    }
    assert.equal(Math.max(...GW.waves.map((w) => w.amp)), 1);
});
t('ripples live in packets: zero outside every packet, bounded near 1 inside one', () => {
    const ph = gwPhases(0);
    let outside = 0, maxIn = 0, cover = 0, n = 0;
    for (let la = -89.5; la <= 89.5; la += 1) for (let lo = -180; lo < 180; lo += 1) {
        const u = latLonToScene(la, lo);
        const w = Math.cos(la * Math.PI / 180);
        const inAny = GW.waves.some((wv) => GW.envAt(wv, u) > 0);
        const v = gwField(u, ph);
        if (!inAny) outside = Math.max(outside, Math.abs(v));
        else { maxIn = Math.max(maxIn, Math.abs(v)); cover += w; }
        n += w;
    }
    assert.equal(outside, 0);
    assert.ok(maxIn > 0.5 && maxIn < 2.2, `max inside ${maxIn}`);
    const frac = cover / n;
    assert.ok(frac > 0.2 && frac < 0.6, `packets cover ${frac} of the sphere`);
});
t('ripples are zero-mean over the sphere and bounded', () => {
    const ph = gwPhases(0);
    let sum = 0, n = 0, max = 0;
    for (let la = -89; la <= 89; la += 1.3) for (let lo = -180; lo < 180; lo += 1.3) {
        const w = Math.cos(la * Math.PI / 180);
        const v = gwField(latLonToScene(la, lo), ph);
        sum += v * w; n += w; max = Math.max(max, Math.abs(v));
    }
    assert.ok(Math.abs(sum / n) < 0.02, `mean ${sum / n}`);
    assert.ok(max < 2.2, `max ${max}`);
    assert.ok(max > 0.5, 'and present');
});
t('ripples fade once a pixel covers a quarter of the wave, and are gone at half', () => {
    const ph = gwPhases(123);
    const pts = [];
    for (let i = 0; i < 400; i++) pts.push(latLonToScene(-60 + (i * 0.37) % 120, -180 + (i * 7.3) % 360));
    const rms = (px) => Math.sqrt(pts.reduce((s, u) => s + gwField(u, ph, px) ** 2, 0) / pts.length);
    assert.ok(rms(0) > 0.2);
    const minL = Math.min(...GW.waves.map((w) => w.lambdaKm));
    const maxL = Math.max(...GW.waves.map((w) => w.lambdaKm));
    assert.ok(rms(0.24 * minL) > 0.999 * rms(0), 'no fade below a quarter wavelength');
    assert.equal(rms(0.51 * maxL), 0, 'all gone above half the longest');
});
t('phases advance at the waves\' own speed and stay in [0, 2π)', () => {
    const w = GW.waves[0];
    const p0 = gwPhases(0)[0], p1 = gwPhases(100)[0];
    const omega = 2 * Math.PI * (w.speedMs / 1000) / w.lambdaKm;
    let dp = p0 - p1; if (dp < 0) dp += 2 * Math.PI;
    close(dp, omega * 100, 1e-9);
    for (const p of gwPhases(1.9e9)) assert.ok(p >= 0 && p < 2 * Math.PI);
});

console.log('\n── the field at a location ──');
t('airglowFieldAt composes the pieces; the regime names what shapes the red line', () => {
    const arcs = { crest: 0.9, crestLatDeg: 14, bubble: 0, bubbleExtentDeg: 0 };
    // A point 14° magnetic north of the dip equator at 45°W.
    let lat = 0; for (; lat < 40; lat += 0.05) if (magneticLatitude(lat, -45) >= 14) break;
    const fld = airglowFieldAt({ latDeg: lat, lonDeg: -45, cosChi: -0.8, kp: 2, arcs, phases: gwPhases(0) });
    close(fld.magLatDeg, 14, 0.1);
    assert.ok(fld.redNight > 2.5, `arc ${fld.redNight}`);
    assert.equal(redLineRegime(fld), 'equatorial arc');
    assert.equal(redLineRegime({ ...fld, cosChi: 0.9 }), 'dayglow');
    const bub = airglowFieldAt({ latDeg: lat, lonDeg: -45, cosChi: -0.8, kp: 2,
        arcs: { ...arcs, bubble: 1, bubbleExtentDeg: 20 }, phases: gwPhases(0) });
    assert.ok(bub.redNight < fld.redNight * 0.2);
    const storm = airglowFieldAt({ latDeg: 55, lonDeg: -100, cosChi: -0.9, kp: 8, arcs: NO_ARCS });
    // Put the point on the arc exactly.
    const s8 = sarArc(8);
    let la2 = 30; for (; la2 < 80; la2 += 0.05) if (magneticLatitude(la2, -100) >= s8.latDeg) break;
    const onArc = airglowFieldAt({ latDeg: la2, lonDeg: -100, cosChi: -0.9, kp: 8, arcs: NO_ARCS });
    assert.equal(redLineRegime(onArc), 'SAR arc');
    void storm;
});
t('airglowAtLocation colours: dayglow reddens the band, the mesosphere stays green-dominant', () => {
    const day = airglowAtLocation(250, { ...NEUTRAL, cosChi: 1 });
    const night = airglowAtLocation(97, NEUTRAL);
    assert.ok(day.rgb[0] > day.rgb[1], 'red above');
    assert.ok(night.rgb[1] > night.rgb[0], 'green band');
});

console.log('\n── the GLSL mirror ──');
t('the shader text is generated from the kernel\'s numbers', () => {
    const G = AIRGLOW_FIELD_GLSL;
    const num = (x) => Number(x).toPrecision(9);
    for (const k of ['redDayGain', 'eiaGain', 'eiaWidthDeg', 'bubbleDepth', 'gwAmpMeso', 'sarWidthDeg']) {
        assert.ok(G.includes(num(AIRGLOW_FIELD[k]).replace(/\.?0+$/, '')), `${k} not in the GLSL`);
    }
    for (const w of GW.waves) assert.ok(G.includes(num(R_EARTH_KM / w.lambdaKm)), 'wave number');
    for (let i = 0; i < GW.waves.length; i++) assert.ok(G.includes(`uGwPhase${i}`), `phase ${i}`);
    assert.ok(!G.includes('`'), 'no backticks (it is spliced into a template literal)');
    assert.ok(!/pow\(\s*\(/.test(G), 'no pow() of a possibly negative base');
    for (const fn of ['agLit', 'agRedDay', 'agGw', 'agField', 'agShadowPre', 'agLitPre']) assert.ok(G.includes(fn));
    assert.ok(RED_RGB_GLSL.startsWith('vec3('));
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-airglow-field: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
