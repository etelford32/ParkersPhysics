/**
 * tests/suvi-geometry.mjs — pins GOES/SUVI as its own instrument
 *
 *   node tests/suvi-geometry.mjs
 *
 * Gates:
 *   • the plate scale is DERIVED and reproduces the two SDO fractions that
 *     already shipped, so the SUVI number is checkable rather than asserted
 *   • the field-of-view coverage is exact (closed form == quadrature) and
 *     carries the measured claim the module exists for: an AIA frame supplies
 *     only ~66 % of the off-limb layer's annulus, a SUVI frame all of it
 *   • the GOES vantage is inside the layer's full-weight band by three orders
 *     of magnitude — which is WHY observerBasis/solarEphemeris are reused
 *   • a SUVI frame resolves against SUVI's own disk fraction, and the AIA
 *     fallback would have REJECTED it (the silent 30 %-too-small bug)
 *   • 195 and 284 are never labelled as AIA's 193 and 211
 *   • every candidate URL is a well-formed https SWPC path with the band's
 *     own zero-padded code, and primaries are tried before secondaries
 */
import assert from 'node:assert/strict';
import {
    R_SUN_ARCSEC, SUVI_PLATE_SCALE_ARCSEC, SUVI_FRAME_PX,
    SUVI_DISK_FRACTION, AIA_DISK_FRACTION, HMI_DISK_FRACTION,
    diskFractionFromPlateScale, SUVI_CHANNELS, SUVI_BANDS, SUVI_PROXY_CHANNELS,
    AIA_CORRESPONDENCE, suviProxyChannel, parseSuviChannel,
    frameReach, annulusCoverage, candidateUrls, SOURCE_CANDIDATES,
    suviLabel, coverageNote, GEO_ORBIT_RADIUS_KM, AU_KM,
} from '../js/suvi-geometry.js';
import { DISK_FRACTION, CHANNELS, diskFractionFor, resolveDiskGeometry } from '../js/sun-observed.js';
import { OFFLIMB_SOURCES, sourceCoverage, R_INNER, R_OUTER, OFF_AXIS_FULL_DEG } from '../js/sun-offlimb.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('suvi-geometry.mjs');

// ── Plate scale ────────────────────────────────────────────────────────────

ok('the plate-scale derivation reproduces the two SDO fractions already in use', () => {
    // If this drifts, the SUVI number derived the same way is not trustworthy.
    assert.ok(Math.abs(HMI_DISK_FRACTION - 0.465) < 0.001, `HMI ${HMI_DISK_FRACTION}`);
    assert.ok(Math.abs(AIA_DISK_FRACTION - 0.390) < 0.001, `AIA ${AIA_DISK_FRACTION}`);
    // …and the rounded table values are what sun-observed actually ships.
    assert.equal(DISK_FRACTION.hmi, 0.465);
    assert.equal(DISK_FRACTION.aia, 0.390);
});

ok('SUVI is 0.2999 of the frame, derived from 2.5″/px over 1280 px', () => {
    assert.equal(SUVI_DISK_FRACTION, R_SUN_ARCSEC / SUVI_PLATE_SCALE_ARCSEC / SUVI_FRAME_PX);
    assert.ok(Math.abs(SUVI_DISK_FRACTION - 0.2999) < 0.0002, String(SUVI_DISK_FRACTION));
    assert.equal(DISK_FRACTION.suvi, SUVI_DISK_FRACTION, 'ONE copy of the number');
});

ok('the fraction is resolution-independent — a resize cannot change it', () => {
    // Same instrument, three browse sizes: the fraction is the same.
    for (const px of [512, 1280, 4096]) {
        const f = diskFractionFromPlateScale(SUVI_PLATE_SCALE_ARCSEC * (SUVI_FRAME_PX / px), px);
        assert.ok(Math.abs(f - SUVI_DISK_FRACTION) < 1e-12, `${px}px → ${f}`);
    }
});

// ── Field of view: the reason this module exists ───────────────────────────

ok('the closed-form coverage IS the quadrature — exact, not sampled', () => {
    for (const frac of [AIA_DISK_FRACTION, SUVI_DISK_FRACTION, 0.465]) {
        const h = frameReach(frac).axis;
        let inside = 0, total = 0;
        const N = 1200, span = 2 * R_OUTER;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
            const x = (i + 0.5) / N * span - R_OUTER;
            const y = (j + 0.5) / N * span - R_OUTER;
            const r = Math.hypot(x, y);
            if (r < R_INNER || r >= R_OUTER) continue;
            total++;
            if (Math.abs(x) <= h && Math.abs(y) <= h) inside++;
        }
        const mc = inside / total;
        const cf = annulusCoverage(R_INNER, R_OUTER, frac);
        assert.ok(Math.abs(mc - cf) < 3e-3, `frac ${frac}: closed ${cf} vs grid ${mc}`);
    }
});

ok('AN AIA FRAME SUPPLIES ONLY ~66 % OF THE ANNULUS THE LAYER DRAWS', () => {
    const aia = annulusCoverage(R_INNER, R_OUTER, AIA_DISK_FRACTION);
    assert.ok(aia > 0.64 && aia < 0.68, `AIA coverage ${aia}`);
    // And the shortfall is a REACH shortfall on the axes, not a rounding one:
    // the frame stops at 1.28 R☉ on axis while the layer asks for 1.6.
    const reach = frameReach(AIA_DISK_FRACTION);
    assert.ok(reach.axis < R_OUTER, `axis reach ${reach.axis} should fall short of ${R_OUTER}`);
    assert.ok(reach.corner > R_OUTER, 'the corners DO reach — which is what makes it a clover, not a smaller ring');
});

ok('a SUVI frame supplies ALL of it, on every azimuth', () => {
    const suvi = annulusCoverage(R_INNER, R_OUTER, SUVI_DISK_FRACTION);
    // 1 to within float ordering (πb² − πa² vs π(b² − a²) differ in the last bit).
    assert.ok(1 - suvi < 1e-12, `SUVI coverage ${suvi}`);
    // 100 % because the ON-AXIS reach clears the outer edge — the weakest
    // direction, so no azimuth is short.
    assert.ok(frameReach(SUVI_DISK_FRACTION).axis > R_OUTER);
});

ok('the layer reports its own coverage, computed not typed', () => {
    const sdo = sourceCoverage('sdo'), suvi = sourceCoverage('suvi');
    assert.ok(Math.abs(sdo.fraction - annulusCoverage(R_INNER, R_OUTER, OFFLIMB_SOURCES.sdo.diskFraction)) < 1e-12);
    assert.ok(1 - suvi.fraction < 1e-12, String(suvi.fraction));
    assert.match(sdo.note, /SDO\/AIA reaches 1\.28 R☉ on axis/);
    assert.match(suvi.note, /GOES\/SUVI reaches 1\.67 R☉ on axis/);
    // An unknown id must fall back, never throw, never report a coverage it
    // does not have.
    assert.equal(sourceCoverage('nope').id, 'sdo');
});

// ── Vantage: why the plane-of-sky construction is reused unchanged ─────────

ok('the GOES vantage is ~750x inside the 12° full-weight band', () => {
    const parallaxDeg = Math.atan2(GEO_ORBIT_RADIUS_KM, AU_KM) * 180 / Math.PI;
    assert.ok(parallaxDeg < 0.02, `${parallaxDeg}°`);
    // The claim the module headers make, checked rather than remembered.
    const factor = OFF_AXIS_FULL_DEG / parallaxDeg;
    assert.ok(factor > 700 && factor < 800, `full-weight band is ${factor}x the parallax`);
    // East-to-West chord, the worst case between the two SUVI spacecraft.
    const chordKm = 2 * GEO_ORBIT_RADIUS_KM * Math.sin(37.5 * Math.PI / 180);
    const sepDeg = Math.atan2(chordKm, AU_KM) * 180 / Math.PI;
    assert.ok(sepDeg < 0.03, `${sepDeg}°`);
    assert.ok(OFF_AXIS_FULL_DEG / sepDeg > 600, 'the worst case is still far inside the band');
});

// ── The silent bug this prevents ───────────────────────────────────────────

ok('a SUVI frame resolves MEASURED against suvi, and would be REJECTED against aia', () => {
    const measured = { cx: 0.5, cy: 0.5, r: SUVI_DISK_FRACTION, ok: true };
    const good = resolveDiskGeometry(measured, 'suvi304');
    assert.equal(good.source, 'measured');
    assert.ok(Math.abs(good.r - SUVI_DISK_FRACTION) < 1e-12);

    // The bug: judged against AIA's fallback the honest measurement is 23 %
    // away, outside the ±12 % acceptance band, so it is thrown out and the
    // annulus draws 30 % too small with no error anywhere.
    const bad = resolveDiskGeometry(measured, '304');
    assert.equal(bad.source, 'fallback');
    assert.ok(Math.abs(bad.r - DISK_FRACTION.aia) < 1e-12);
    assert.ok((bad.r - SUVI_DISK_FRACTION) / SUVI_DISK_FRACTION > 0.29, 'the drawn limb would be ~30 % out');
});

ok('every SUVI proxy channel is registered and maps to the suvi instrument', () => {
    for (const band of SUVI_BANDS) {
        const name = suviProxyChannel(band);
        assert.ok(CHANNELS[name], `${name} missing from CHANNELS`);
        assert.equal(CHANNELS[name].instrument, 'suvi');
        assert.equal(diskFractionFor(name), SUVI_DISK_FRACTION);
        assert.equal(parseSuviChannel(name), band, 'round-trips');
    }
    assert.deepEqual([...SUVI_PROXY_CHANNELS].sort(), SUVI_BANDS.map(suviProxyChannel).sort());
});

ok('the SDO channels are untouched — this is a layer, not a swap', () => {
    for (const c of ['white', 'mag', '94', '131', '171', '193', '211', '304']) {
        assert.ok(CHANNELS[c], `${c} lost`);
        assert.notEqual(CHANNELS[c].instrument, 'suvi');
        assert.equal(parseSuviChannel(c), null, `${c} must not parse as SUVI`);
    }
    assert.equal(diskFractionFor('white'), DISK_FRACTION.hmi);
    assert.equal(diskFractionFor('304'), DISK_FRACTION.aia);
});

// ── Passbands ──────────────────────────────────────────────────────────────

ok('195 and 284 are NOT labelled as AIA 193 and 211', () => {
    assert.equal(AIA_CORRESPONDENCE[195].aia, '193');
    assert.equal(AIA_CORRESPONDENCE[195].same, false);
    assert.equal(AIA_CORRESPONDENCE[284].aia, '211');
    assert.equal(AIA_CORRESPONDENCE[284].same, false);
    for (const band of [94, 131, 171, 304]) assert.equal(AIA_CORRESPONDENCE[band].same, true);
    // The label prints SUVI's own wavelength, never the neighbour's.
    assert.match(suviLabel(195), /195/);
    assert.doesNotMatch(suviLabel(195), /193/);
    assert.match(suviLabel(284), /284/);
    assert.doesNotMatch(suviLabel(284), /211/);
    for (const band of SUVI_BANDS) assert.match(suviLabel(band), /^GOES\/SUVI /);
});

ok('the off-limb pair is the two bands that ARE the same lines', () => {
    for (const band of OFFLIMB_SOURCES.suvi.bands) {
        assert.equal(AIA_CORRESPONDENCE[band].same, true,
            `${band} must be a shared line for the two sources to be comparable`);
    }
    assert.deepEqual([...OFFLIMB_SOURCES.suvi.bands], [...OFFLIMB_SOURCES.sdo.bands]);
    assert.deepEqual([...OFFLIMB_SOURCES.suvi.channels], ['suvi304', 'suvi131']);
});

// ── Candidates ─────────────────────────────────────────────────────────────

ok('candidates are well-formed SWPC https URLs carrying the band\'s own code', () => {
    for (const band of SUVI_BANDS) {
        const cands = candidateUrls(band);
        assert.equal(cands.length, SOURCE_CANDIDATES.length);
        for (const c of cands) {
            const u = new URL(c.url);                       // throws on malformed
            assert.equal(u.protocol, 'https:');
            assert.equal(u.hostname, 'services.swpc.noaa.gov');
            assert.ok(c.url.includes(SUVI_CHANNELS[band].code), `${c.url} missing code`);
            assert.ok(!c.url.includes('{code}'), 'template not substituted');
            assert.ok(c.note && c.id && c.satellite, 'each candidate says what it is');
        }
        assert.equal(new Set(cands.map(c => c.url)).size, cands.length, 'no duplicates');
    }
    assert.deepEqual(candidateUrls('nope'), []);
});

ok('every primary candidate is tried before any secondary one', () => {
    const sats = SOURCE_CANDIDATES.map(c => c.satellite);
    assert.equal(sats.indexOf('secondary') > 0, true, 'there is a secondary');
    assert.equal(sats.lastIndexOf('primary') < sats.indexOf('secondary'), true,
        'a healthy primary must always win');
});

ok('coverageNote reports the reach it was given, not a remembered number', () => {
    // A hypothetical wider instrument must move the sentence.
    const wide = coverageNote(R_INNER, R_OUTER, 0.15, 'TEST');
    assert.match(wide, /TEST reaches 3\.33 R☉ on axis/);
    assert.match(wide, /supplies 100\.0%/);
    const narrow = coverageNote(R_INNER, R_OUTER, 0.8, 'TEST');
    assert.match(narrow, /supplies 0\.0%/);
});

console.log(`\n${passed} checks passed`);
