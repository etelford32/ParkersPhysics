/**
 * tests/sun-coronagraph.mjs — pins the observed outer-corona layer (js/sun-coronagraph.js)
 *
 *   node tests/sun-coronagraph.mjs
 *
 * NASA is egress-blocked at build time, so the frames here are the SYNTHETIC
 * coronagraph fixtures (scripts/lib/sdo-synth.mjs) — one synthetic corona seen
 * through both instruments, with the browse product's occulter disc, limb
 * circle, pylon and timestamp block, and every planted position written down.
 * Gates:
 *   • SCALE is derived (plate scale × the Sun's apparent radius from L1), and
 *     the ring's measured radius agrees with it — at both browse sizes
 *   • the Sun's CENTRE is measured from the limb circle and recovers the
 *     planted off-centre position
 *   • NEGATIVE CONTROL: a frame resolved against the OTHER instrument's
 *     expectations is rejected and falls back to nominal geometry, said so
 *   • the occulter's painted edge is measured, and the drawn field starts
 *     outside it
 *   • the mask draws nothing inside the occulter, over the timestamp corner,
 *     or outside the frame
 *   • calibration levels against the frame's OWN reference shell, is invariant
 *     to the product's byte-scaling, and REFUSES a frame with no corona in it
 *   • C3 is level-matched to C2 on their overlap, and C2 wins where both have
 *     data (the weights sum to a continuous hand-over)
 *   • a planted streamer and each planted CME land at their position angle and
 *     radius through the same projection the shader uses
 *   • the pylon probe finds the pylon where the generator put it, and flags an
 *     inverted frame
 *   • the stretch is monotone; the GLSL takes its constants from the JS
 *   • the committed PNGs are what the generator renders today
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CORONAGRAPHS, CORONAGRAPH_IDS, coronagraph,
    L1_FRACTION, sunDistanceAu, apparentSolarRadiusArcsec, expectedRsunFrac,
    planeToFrame, frameToPlane, positionAngleDeg, fromPositionAngle,
    RING_ACCEPT, FIELD_FRAC, OCCULTER_MARGIN,
    measureLimbRing, resolveCoronagraphGeometry, measureOcculter,
    fieldFor, fieldWeight, maskWeightAt, c2Cover, compositeWeights,
    calibrateCoronagraph, overlapShell, joinFields, crossCalibrate, displayValue,
    pylonPositionAngle, pylonSaysInverted,
    coronagraphLabel, coronagraphNote,
    STRETCH_GAMMA, DEFAULT_GAIN, DISCARD_EPS, VALUE_EPS, pixelValue,
    CORONAGRAPH_FRAG, CORONAGRAPH_VERT, MESH_R_INNER, MESH_R_OUTER, INSTRUMENT_HEADER,
} from '../js/sun-coronagraph.js';
import * as CORO from '../js/sun-coronagraph.js';
import { observerBasis, offAxisWeight, displayStretch, REF_FLOOR } from '../js/sun-offlimb.js';
import { srgbToLinear, luminance } from '../js/sun-observed.js';

import { lascoFreshness, LASCO_WARN_S, LASCO_CRIT_S } from '../js/lasco-sources.js';
import {
    renderSyntheticCoronagraph, toRgba, encodePng, decodePng, FIXTURE_EPOCH_ISO,
    PLANTED_CORONA, PLANTED_CORONAGRAPH, CORONAGRAPH_TIMESTAMP_BOX,
} from '../scripts/lib/sdo-synth.mjs';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-coronagraph.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EPOCH = new Date(FIXTURE_EPOCH_ISO);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Render a fixture frame in memory and hand back what the kernels read. */
const FRAMES = {};
function frame(id, size = 512) {
    const key = `${id}@${size}`;
    if (!FRAMES[key]) {
        const f = renderSyntheticCoronagraph(id, { size });
        FRAMES[key] = { ...f, rgba: toRgba(f.rgb, f.width, f.height), w: f.width, h: f.height };
    }
    return FRAMES[key];
}
/** The kernel's scalar (linear max channel) of the frame pixel nearest a plane-of-sky point. */
function lumAt(f, geom, x, y) {
    const p = planeToFrame(x, y, geom);
    const px = Math.min(f.w - 1, Math.max(0, Math.round(p.u * f.w - 0.5)));
    const py = Math.min(f.h - 1, Math.max(0, Math.round(p.v * f.h - 0.5)));
    const o = (py * f.w + px) * 4;
    return pixelValue(f.rgba[o], f.rgba[o + 1], f.rgba[o + 2]);
}

// ── Scale ──────────────────────────────────────────────────────────────────

ok('L1 sits 1 % sunward, derived from the mass ratio and not typed', () => {
    assert.ok(near(L1_FRACTION, 0.01004, 5e-5), `L1 fraction ${L1_FRACTION}`);
});

ok('the Sun–Earth distance and apparent radius follow the year (Meeus)', () => {
    const peri = sunDistanceAu(new Date('2026-01-03T12:00:00Z'));
    const aph  = sunDistanceAu(new Date('2026-07-05T12:00:00Z'));
    assert.ok(near(peri, 0.9833, 4e-4), `perihelion ${peri}`);
    assert.ok(near(aph, 1.0167, 4e-4), `aphelion ${aph}`);
    // Geocentric semi-diameter: 16′16″ at perihelion, 15′44″ at aphelion.
    assert.ok(near(apparentSolarRadiusArcsec(new Date('2026-01-03T12:00:00Z'), { fromL1: false }), 975.9, 0.6));
    assert.ok(near(apparentSolarRadiusArcsec(new Date('2026-07-05T12:00:00Z'), { fromL1: false }), 943.9, 0.6));
    // From L1 the Sun is 1 % larger — the correction a geocentric number would miss.
    const g = apparentSolarRadiusArcsec(EPOCH, { fromL1: false }), l = apparentSolarRadiusArcsec(EPOCH);
    assert.ok(near(l / g, 1 / (1 - L1_FRACTION), 1e-12));
});

ok('R☉ in the frame is plate scale × apparent radius: C2 ≈ 0.079, C3 ≈ 0.017 of the width', () => {
    const c2 = expectedRsunFrac('c2', EPOCH), c3 = expectedRsunFrac('c3', EPOCH);
    assert.ok(c2 > 0.077 && c2 < 0.082, `c2 ${c2}`);
    assert.ok(c3 > 0.0164 && c3 < 0.0174, `c3 ${c3}`);
    // The ratio is the plate-scale ratio and nothing else.
    assert.ok(near(c2 / c3, CORONAGRAPHS.c3.plateScaleArcsec / CORONAGRAPHS.c2.plateScaleArcsec, 1e-12));
    // …so an on-axis half-frame reaches ~6.3 R☉ in C2 and ~30 R☉ in C3.
    assert.ok(near(0.5 / c2, 6.3, 0.25)); assert.ok(near(0.5 / c3, 29.9, 1.0));
});

// ── Projection ─────────────────────────────────────────────────────────────

ok('plane ↔ frame round-trips, north is up and WEST is image right', () => {
    const geom = { cx: 0.507, cy: 0.519, r: 0.017 };
    for (const roll of [0, 37, 180]) {
        for (const [x, y] of [[3, 4], [-11, 2.5], [0.1, -20]]) {
            const p = planeToFrame(x, y, geom, roll);
            const q = frameToPlane(p.u, p.v, geom, roll);
            assert.ok(near(q.x, x, 1e-9) && near(q.y, y, 1e-9), `roll ${roll}`);
        }
    }
    const n = planeToFrame(0, 5, geom), w = planeToFrame(5, 0, geom);
    assert.ok(n.v < geom.cy, 'north is toward the top of the image (v decreases)');
    assert.ok(w.u > geom.cx, 'west is image right');
    // A 180° roll puts north at the bottom — what an uncorrected inverted frame needs.
    assert.ok(planeToFrame(0, 5, geom, 180).v > geom.cy);
});

ok('position angle is the solar convention: N 0°, E 90° (image LEFT), S 180°, W 270°', () => {
    assert.ok(near(positionAngleDeg(0, 1), 0, 1e-9));
    assert.ok(near(positionAngleDeg(-1, 0), 90, 1e-9));
    assert.ok(near(positionAngleDeg(0, -1), 180, 1e-9));
    assert.ok(near(positionAngleDeg(1, 0), 270, 1e-9));
    for (const pa of [0, 48, 135, 263, 318]) {
        const p = fromPositionAngle(pa, 7);
        assert.ok(near(positionAngleDeg(p.x, p.y), pa, 1e-9) && near(Math.hypot(p.x, p.y), 7, 1e-12));
    }
});

ok('the plane is the off-limb layer\'s plane: the basis and off-axis weight are IMPORTED, not copied', () => {
    const src = readFileSync(join(ROOT, 'js', 'sun-coronagraph.js'), 'utf8');
    assert.match(src, /import \{[^}]*\bobserverBasis\b[^}]*\boffAxisWeight\b[^}]*\} from '\.\/sun-offlimb\.js'/);
    assert.doesNotMatch(src, /export function observerBasis|export function offAxisWeight/);
    // and they are what they were: sanity that the import resolves to the kernel
    assert.equal(offAxisWeight(1), 1);
    assert.deepEqual(observerBasis(0).normal, [0, 0, 1]);
});

// ── Measuring the frame ────────────────────────────────────────────────────

for (const size of [512, 1024]) {
    ok(`the limb circle is found and the planted off-centre Sun recovered (${size}²)`, () => {
        for (const id of CORONAGRAPH_IDS) {
            const f = frame(id, size), P = PLANTED_CORONAGRAPH[id];
            const g = resolveCoronagraphGeometry(f.rgba, f.w, f.h, id, EPOCH);
            assert.equal(g.source, 'measured', `${id}: ${g.reason}`);
            // Half a pixel of this frame, expressed as a fraction of the width.
            const tol = 0.6 / size;
            assert.ok(near(g.cx, P.cx, tol), `${id} cx ${g.cx} vs ${P.cx}`);
            assert.ok(near(g.cy, P.cy, tol), `${id} cy ${g.cy} vs ${P.cy}`);
            // The planted centre is NOT the frame centre — a detector that
            // just returned (0.5, 0.5) would fail this.
            assert.ok(Math.hypot(P.cx - 0.5, P.cy - 0.5) * size > 3, 'the fixture is genuinely off-centre');
            // Scale is the DERIVED one; the ring's own radius is a check on it.
            assert.equal(g.r, expectedRsunFrac(id, EPOCH));
            assert.ok(Math.abs(g.ringRatio - 1) < 0.08, `${id} ring/derived ${g.ringRatio}`);
        }
    });
}

ok('NEGATIVE CONTROL: a frame resolved as the OTHER instrument is rejected, and says nominal', () => {
    for (const [frameId, asId] of [['c3', 'c2'], ['c2', 'c3']]) {
        const f = frame(frameId, 512);
        const exp = expectedRsunFrac(asId, EPOCH) * f.w;
        const ring = measureLimbRing(f.rgba, f.w, f.h, exp);
        assert.equal(ring.ok, false, `${frameId} frame accepted as ${asId}`);
        assert.ok(ring.reason, 'a rejection carries its reason');
        const g = resolveCoronagraphGeometry(f.rgba, f.w, f.h, asId, EPOCH);
        assert.equal(g.source, 'nominal');
        assert.equal(g.cx, 0.5); assert.equal(g.cy, 0.5);
    }
    // The radii really are far outside the acceptance window of each other.
    const ratio = expectedRsunFrac('c2', EPOCH) / expectedRsunFrac('c3', EPOCH);
    assert.ok(ratio > 1 + RING_ACCEPT * 4);
});

ok('a frame with no limb circle (a blank card, a photosphere) falls back to nominal', () => {
    const w = 256, h = 256, blank = new Uint8ClampedArray(w * h * 4).fill(0);
    for (let i = 3; i < blank.length; i += 4) blank[i] = 255;
    assert.equal(resolveCoronagraphGeometry(blank, w, h, 'c2', EPOCH).source, 'nominal');
    // A uniformly bright disc (what the proxy's old unknown-channel default,
    // the HMI continuum, would look like) has no thin ring either.
    const disc = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4, inside = Math.hypot(x - 128, y - 128) < 119;
        disc[o] = disc[o + 1] = disc[o + 2] = inside ? 230 : 0; disc[o + 3] = 255;
    }
    assert.equal(resolveCoronagraphGeometry(disc, w, h, 'c2', EPOCH).source, 'nominal');
    assert.equal(resolveCoronagraphGeometry(null, 0, 0, 'c3', EPOCH).source, 'nominal');
});

ok('the occulter\'s painted edge is MEASURED — the planted radii are not the nominal ones', () => {
    for (const id of CORONAGRAPH_IDS) {
        const f = frame(id, 512), P = PLANTED_CORONAGRAPH[id], inst = coronagraph(id);
        assert.notEqual(P.occulterRsun, inst.occulterRsun, 'fixture must differ from the typed radius');
        const g = resolveCoronagraphGeometry(f.rgba, f.w, f.h, id, EPOCH);
        const occ = measureOcculter(f.rgba, f.w, f.h, g, id);
        assert.ok(occ != null, `${id}: no edge found`);
        // One pixel of this frame in R☉.
        const pxRsun = 1 / (g.r * f.w);
        assert.ok(near(occ, P.occulterRsun, 1.5 * pxRsun + 0.02), `${id} occulter ${occ} vs ${P.occulterRsun}`);
        const field = fieldFor(id, g, occ);
        assert.equal(field.occulterSource, 'measured');
        assert.ok(field.rIn >= occ * OCCULTER_MARGIN - 1e-12, 'the drawn field starts outside the measured mask');
        assert.ok(field.rIn >= inst.rInner);
    }
    // No frame → the typed radius, labelled as such.
    const f0 = fieldFor('c2', { cx: 0.5, cy: 0.5, r: expectedRsunFrac('c2', EPOCH) }, null);
    assert.equal(f0.occulterSource, 'nominal');
    assert.equal(f0.rIn, Math.max(CORONAGRAPHS.c2.rInner, CORONAGRAPHS.c2.occulterRsun * OCCULTER_MARGIN));
});

// ── The mask ───────────────────────────────────────────────────────────────

function resolved(id, size = 512) {
    const f = frame(id, size);
    const geom = resolveCoronagraphGeometry(f.rgba, f.w, f.h, id, EPOCH);
    const field = fieldFor(id, geom, measureOcculter(f.rgba, f.w, f.h, geom, id));
    return { f, geom, field };
}

ok('the drawn field is a Sun-centred circle inside the frame, limited by the nearest edge', () => {
    for (const id of CORONAGRAPH_IDS) {
        const { geom, field } = resolved(id);
        const edge = Math.min(geom.cx, 1 - geom.cx, geom.cy, 1 - geom.cy) / geom.r;
        assert.ok(near(field.frameEdgeRsun, edge, 1e-12));
        assert.ok(field.rOut <= FIELD_FRAC * edge + 1e-12, `${id}: field ${field.rOut} leaves the frame circle ${edge}`);
        assert.ok(field.rOut <= coronagraph(id).rOuter);
        assert.ok(field.rOut > field.rIn + 1);
    }
    // C2's 6 R☉ and C3's 30 R☉ are what the INSTRUMENT sees; an off-centre
    // Sun in a square frame supplies a little less, and the field says which.
    assert.equal(resolved('c3').field.limitedBy, 'frame');
    assert.ok(resolved('c3').field.rOut > 24 && resolved('c3').field.rOut < 29);
    assert.ok(resolved('c2').field.rOut > 5.4 && resolved('c2').field.rOut <= 6.0);
});

ok('nothing is drawn inside the occulter, over the timestamp corner, or outside the frame', () => {
    for (const id of CORONAGRAPH_IDS) {
        const { f, geom, field } = resolved(id);
        // Inside the occulter — including the limb circle itself.
        for (const rho of [0, 0.5, 1.0, 1.5, PLANTED_CORONAGRAPH[id].occulterRsun]) {
            for (const pa of [0, 77, 135, 200, 311]) {
                const p = fromPositionAngle(pa, rho), q = planeToFrame(p.x, p.y, geom);
                assert.equal(maskWeightAt(q.u, q.v, geom, field), 0, `${id} ρ=${rho}`);
            }
        }
        // Every pixel of the timestamp block.
        const tb = CORONAGRAPH_TIMESTAMP_BOX;
        for (let u = tb.x0; u <= tb.x1; u += 0.004) {
            for (let v = tb.y0; v <= tb.y1; v += 0.004) {
                assert.equal(maskWeightAt(u, v, geom, field), 0, `${id}: timestamp pixel (${u}, ${v}) is drawn`);
            }
        }
        // All four corners and the frame border.
        for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]]) {
            assert.equal(maskWeightAt(u, v, geom, field), 0, `${id}: border (${u}, ${v}) is drawn`);
        }
        // Outside the frame is nothing, never a clamp-extended border texel.
        for (const [u, v] of [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.2], [0.5, 1.2]]) {
            assert.equal(maskWeightAt(u, v, geom, field), 0);
        }
        // …and the field is genuinely ON in between (the mask is not all-zero).
        const mid = fromPositionAngle(20, (field.rIn + field.featherIn + field.rOut - field.featherOut) / 2);
        const qm = planeToFrame(mid.x, mid.y, geom);
        assert.equal(maskWeightAt(qm.u, qm.v, geom, field), 1);
        void f;
    }
});

ok('the field weight is 0 at and outside both edges and monotone on each ramp', () => {
    const { field } = resolved('c2');
    assert.equal(fieldWeight(field.rIn, field), 0);
    assert.equal(fieldWeight(field.rOut, field), 0);
    assert.equal(fieldWeight(field.rIn - 0.01, field), 0);
    assert.equal(fieldWeight(field.rOut + 0.01, field), 0);
    let prev = -1;
    for (let r = field.rIn; r <= field.rIn + field.featherIn; r += field.featherIn / 20) {
        const v = fieldWeight(r, field); assert.ok(v >= prev - 1e-12); prev = v;
    }
    prev = 2;
    for (let r = field.rOut - field.featherOut; r < field.rOut; r += field.featherOut / 20) {
        const v = fieldWeight(r, field); assert.ok(v <= prev + 1e-12); prev = v;
    }
    assert.equal(fieldWeight(NaN, field), 0);
});

// ── Photometry ─────────────────────────────────────────────────────────────

ok('calibration measures the frame\'s own pedestal and reference shell', () => {
    for (const id of CORONAGRAPH_IDS) {
        const { f, geom, field } = resolved(id);
        const cal = calibrateCoronagraph(f.rgba, f.w, f.h, geom, field, id);
        assert.equal(cal.ok, true, `${id}: ${cal.reason}`);
        // The browse product's sky is NOT black: the pedestal is the colour
        // table's dark end, and it is what an additive layer must not paint.
        assert.ok(cal.floor > srgbToLinear(4), `${id}: pedestal ${cal.floor} should be well above black`);
        assert.ok(cal.ref > cal.floor && near(cal.level, cal.ref - cal.floor, 1e-12));
        // By construction the reference shell draws at 1 (a fixed point of any exponent).
        assert.ok(near(displayValue(cal.ref, cal.floor, cal.level), 1, 1e-9));
        // …and the frame's dark sky draws at exactly nothing.
        assert.equal(displayValue(cal.floor, cal.floor, cal.level), 0);
        assert.equal(displayValue(cal.floor * 0.5, cal.floor, cal.level), 0);
    }
});

ok('the pedestal is the product\'s darkest sky, NOT the drawn field\'s own rim', () => {
    // C2's field is full of corona right to its edge. Reading the pedestal off
    // the field's rim (the first version) subtracts that corona, drives C2 to
    // zero exactly where it hands over to C3, and the level match then dims C3
    // to agree with the zero.
    const { f, geom, field } = resolved('c2');
    const cal = calibrateCoronagraph(f.rgba, f.w, f.h, geom, field, 'c2');
    const rim = [];
    for (let pa = 0; pa < 360; pa += 3) { const p = fromPositionAngle(pa, field.rOut - 0.05); rim.push(lumAt(f, geom, p.x, p.y)); }
    rim.sort((a, b) => a - b);
    const rimMedian = rim[rim.length >> 1], rimLow = rim[Math.floor(rim.length * 0.1)];
    assert.ok(cal.floor < rimLow, `pedestal ${cal.floor} is not below the rim's own low end ${rimLow}`);
    // So the rim still DRAWS — there is corona there, and C3 continues it.
    // (0.25 under the fixture-era √; drawn as published it is 0.18 — still plainly there.)
    assert.ok(displayValue(rimMedian, cal.floor, cal.level) > 0.10, `the rim displays ${displayValue(rimMedian, cal.floor, cal.level)}`);
    // Negative control: the rim's own low percentile as the pedestal zeroes it.
    assert.ok(displayValue(rimLow, rimLow, cal.ref - rimLow) === 0);
    // The pedestal is found in the CORNERS (outside the drawn circle), where
    // the product is darkest: no pixel of the drawn field is below it by much.
    const corner = frameToPlane(0.02, 0.02, geom);
    assert.ok(corner.rho > field.rOut, 'the corner is outside the drawn field');
    assert.ok(Math.abs(lumAt(f, geom, corner.x, corner.y) - cal.floor) < 0.35 * cal.level);
    // C3: the pylon shadow and the far sky are the dark end; the far field sits near it.
    const c3 = resolved('c3');
    const cal3 = calibrateCoronagraph(c3.f.rgba, c3.f.w, c3.f.h, c3.geom, c3.field, 'c3');
    const far = fromPositionAngle(20, c3.field.rOut - 0.5);
    assert.ok(displayValue(lumAt(c3.f, c3.geom, far.x, far.y), cal3.floor, cal3.level) < 0.35, 'the far C3 sky is faint');
});

ok('a frame with no corona in it is REFUSED (black, flat, or a reference shell under the mask)', () => {
    const { geom, field } = resolved('c2');
    const w = 512, h = 512;
    const black = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    const b = calibrateCoronagraph(black, w, h, geom, field, 'c2');
    assert.equal(b.ok, false); assert.equal(b.reason, 'reference_shell_dark');
    // A flat mid-grey card: bright, but the shell does not rise above the
    // frame's own dark level — dividing by that would amplify noise.
    const flat = new Uint8ClampedArray(w * h * 4).fill(128);
    const fl = calibrateCoronagraph(flat, w, h, geom, field, 'c2');
    assert.equal(fl.ok, false); assert.equal(fl.reason, 'reference_shell_dark');
    // A mask wider than the reference shell: measuring it would measure paint.
    const wide = { ...field, rIn: CORONAGRAPHS.c2.refShell.lo + 0.3 };
    assert.equal(calibrateCoronagraph(frame('c2').rgba, w, h, geom, wide, 'c2').reason, 'reference_shell_occulted');
    assert.equal(calibrateCoronagraph(null, w, h, geom, field, 'c2').ok, false);
});

ok('the displayed level is invariant to the browse product\'s byte-scaling', () => {
    // Re-scale the frame in LINEAR light (a different display gain upstream).
    const { f, geom, field } = resolved('c3');
    const k = 0.6;
    const dim = new Uint8ClampedArray(f.rgba.length);
    const toS = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
    for (let i = 0; i < f.rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) dim[i + c] = toS(srgbToLinear(f.rgba[i + c]) * k);
        dim[i + 3] = 255;
    }
    const a = calibrateCoronagraph(f.rgba, f.w, f.h, geom, field, 'c3');
    const b = calibrateCoronagraph(dim, f.w, f.h, geom, field, 'c3');
    assert.ok(a.ok && b.ok);
    assert.ok(near(b.level / a.level, k, 0.03), `level scaled by ${b.level / a.level}`);
    // Sample the CME front: its DISPLAYED value must not move with the gain.
    const cme = PLANTED_CORONA.cmes.find(c => c.id === 'CME-NE');
    const p = fromPositionAngle(cme.paDeg, cme.rho);
    const fd = { rgba: dim, w: f.w, h: f.h };
    const va = displayValue(lumAt(f, geom, p.x, p.y), a.floor, a.level);
    const vb = displayValue(lumAt(fd, geom, p.x, p.y), b.floor, b.level);
    assert.ok(near(va, vb, 0.04 * va), `displayed ${va} vs ${vb}`);
});

ok('C3 is level-matched to C2 on the shell both see; C2 down ⇒ own shell, said so', () => {
    const c2 = resolved('c2'), c3 = resolved('c3');
    const ovl = overlapShell(c2.field, c3.field);
    assert.ok(ovl && ovl.hi - ovl.lo >= 0.3, 'the two fields overlap');
    assert.ok(ovl.lo >= c3.field.rIn && ovl.hi <= c2.field.rOut);
    const cal2 = calibrateCoronagraph(c2.f.rgba, c2.f.w, c2.f.h, c2.geom, c2.field, 'c2', ovl);
    const cal3 = calibrateCoronagraph(c3.f.rgba, c3.f.w, c3.f.h, c3.geom, c3.field, 'c3', ovl);
    assert.ok(cal2.overlap > 0 && cal3.overlap > 0);
    const x = crossCalibrate(cal2, cal3);
    assert.equal(x.basis, 'c2-overlap');
    // The definition: the two instruments' NORMALISED overlap medians agree.
    assert.ok(near(cal3.overlap / x.level, cal2.overlap / cal2.level, 1e-12));
    // The fixtures are byte-scaled differently on purpose, so the match is
    // doing real work: C3's own-shell level is a different number.
    assert.ok(Math.abs(x.level / cal3.level - 1) > 0.1, `cross-cal moved the level by only ${x.level / cal3.level}`);
    // With the match, a point in the hand-over displays the same from both
    // frames to within the fixtures' own (different) display curves.
    const p = fromPositionAngle(150, (ovl.lo + ovl.hi) / 2);
    const d2 = displayValue(lumAt(c2.f, c2.geom, p.x, p.y), cal2.floor, cal2.level);
    const d3 = displayValue(lumAt(c3.f, c3.geom, p.x, p.y), cal3.floor, x.level);
    assert.ok(Math.abs(d3 / d2 - 1) < 0.25, `seam ${d2} vs ${d3}`);
    const d3own = displayValue(lumAt(c3.f, c3.geom, p.x, p.y), cal3.floor, cal3.level);
    assert.ok(Math.abs(d3 / d2 - 1) < Math.abs(d3own / d2 - 1), 'cross-calibration narrows the seam');
    // Fallbacks.
    assert.equal(crossCalibrate(null, cal3).basis, 'own-shell');
    assert.equal(crossCalibrate(null, cal3).level, cal3.level);
    assert.equal(crossCalibrate({ ...cal2, ok: false }, cal3).basis, 'own-shell');
    assert.equal(crossCalibrate({ ...cal2, overlap: null }, cal3).basis, 'own-shell');
    assert.equal(crossCalibrate(cal2, { ok: false }).basis, 'none');
    assert.equal(overlapShell(c2.field, null), null);
});

ok('the two fields are fitted together: a narrow overlap squeezes both ramps, never leaves a dark seam', () => {
    const a = resolved('c2').field, b = resolved('c3').field;
    // Wide enough: untouched (same objects back).
    const wide = joinFields({ ...a, rOut: b.rIn + 5 }, b);
    assert.equal(wide.squeezed, 1);
    // A C3 mask measured wider than expected leaves less room than the ramps need.
    const tight3 = { ...b, rIn: a.rOut - 0.7 };
    const j = joinFields(a, tight3);
    assert.ok(j.squeezed < 1);
    assert.ok(near(j.f3.rIn + j.f3.featherIn, j.f2.rOut - j.f2.featherOut, 1e-12), 'C3 reaches full weight exactly where C2 starts to fade');
    for (let r = j.f2.rIn + j.f2.featherIn; r < j.f3.rOut - j.f3.featherOut; r += 0.05) {
        const { w2, w3 } = compositeWeights(r, j.f2, j.f3);
        assert.ok(near(w2 + w3, 1, 1e-9), `dark seam at ρ=${r}: ${w2}+${w3}`);
    }
    // Negative control: WITHOUT the join the same fields dip well below 1.
    let worst = 1;
    for (let r = tight3.rIn; r < a.rOut; r += 0.02) { const { w2, w3 } = compositeWeights(r, a, tight3); worst = Math.min(worst, w2 + w3); }
    assert.ok(worst < 0.8, `un-joined seam only dips to ${worst}`);
    // The inputs are not mutated, and no overlap at all is left alone.
    assert.equal(tight3.featherIn, b.featherIn);
    const apart = joinFields({ ...a, rOut: 3 }, b);
    assert.equal(apart.squeezed, 1); assert.equal(apart.f2.featherOut, a.featherOut);
    assert.deepEqual(joinFields(a, null), { f2: a, f3: null, squeezed: 1 });
});

ok('C2 wins wherever it has data, and the hand-over to C3 is continuous', () => {
    const j0 = joinFields(resolved('c2').field, resolved('c3').field);
    const f2 = j0.f2, f3 = j0.f3;
    // Inside C2's full-weight zone C3 contributes NOTHING, even past its occulter.
    const mid = (f3.rIn + f3.featherIn + f2.rOut - f2.featherOut) / 2;
    assert.ok(mid > f3.rIn && mid < f2.rOut - f2.featherOut);
    assert.deepEqual(compositeWeights(mid, f2, f3), { w2: 1, w3: 0 });
    // Across C2's outer feather the two weights sum to 1: a hand-over, not a dip.
    for (let r = f2.rOut - f2.featherOut; r <= f2.rOut; r += f2.featherOut / 16) {
        const { w2, w3 } = compositeWeights(r, f2, f3);
        assert.ok(near(w2 + w3, 1, 1e-9), `ρ=${r}: ${w2}+${w3}`);
    }
    assert.deepEqual(compositeWeights(f2.rOut + 1, f2, f3), { w2: 0, w3: 1 });
    // No radius is drawn by neither between C2's inner ramp and C3's outer one.
    for (let r = f2.rIn + f2.featherIn; r < f3.rOut - f3.featherOut; r += 0.37) {
        const { w2, w3 } = compositeWeights(r, f2, f3);
        assert.ok(near(w2 + w3, 1, 1e-9), `gap at ρ=${r}`);
    }
    // C2 down: C3 takes over from its own inner edge.
    assert.equal(compositeWeights(mid, null, f3).w3, fieldWeight(mid, f3));
    assert.ok(compositeWeights(mid, null, f3).w3 > 0.5);
    assert.equal(c2Cover(f2.rIn - 0.1, f2), 0);
    // Nothing at all inside C2's occulter: the disc and the EUV annulus are untouched.
    for (const r of [0, 1, 1.6, 2.0]) assert.deepEqual(compositeWeights(r, f2, f3), { w2: 0, w3: 0 });
    assert.ok(MESH_R_INNER > 1.6, 'the mesh itself starts outside the 1.0–1.6 R☉ off-limb ring');
});

// ── Planted structure ──────────────────────────────────────────────────────

ok('planted streamers and CME fronts land at their position angle and radius', () => {
    // Through the layer's own geometry (MEASURED centre, DERIVED scale), the
    // brightest position angle on a ring is the planted one.
    const brightestPa = (f, geom, rho, lo, hi) => {
        let best = -1, bp = 0;
        for (let pa = lo; pa <= hi; pa += 0.5) {
            const p = fromPositionAngle(pa, rho), L = lumAt(f, geom, p.x, p.y);
            if (L > best) { best = L; bp = pa; }
        }
        return bp;
    };
    const c2 = resolved('c2'), c3 = resolved('c3');
    for (const st of PLANTED_CORONA.streamers) {
        assert.ok(near(brightestPa(c2.f, c2.geom, 4.6, st.paDeg - 25, st.paDeg + 25), st.paDeg, 3), `${st.id} in C2`);
        assert.ok(near(brightestPa(c3.f, c3.geom, 9.0, st.paDeg - 25, st.paDeg + 25), st.paDeg, 3), `${st.id} in C3`);
    }
    // CME fronts: brightest RADIUS along the planted PA, relative to the
    // corona either side of it (the front is a bump on a falling profile).
    const frontRho = (f, geom, cme) => {
        const base = fromPositionAngle((cme.paDeg + 180) % 360, 1);   // a quiet PA for the background profile
        let best = -Infinity, br = 0;
        for (let rho = cme.rho - 4 * cme.sigmaRho; rho <= cme.rho + 4 * cme.sigmaRho; rho += cme.sigmaRho / 8) {
            const p = fromPositionAngle(cme.paDeg, rho);
            const q = fromPositionAngle(positionAngleDeg(base.x, base.y), rho);
            const d = lumAt(f, geom, p.x, p.y) / Math.max(lumAt(f, geom, q.x, q.y), 1e-6);
            if (d > best) { best = d; br = rho; }
        }
        return { rho: br, contrast: best };
    };
    const nw = PLANTED_CORONA.cmes.find(c => c.id === 'CME-NW');
    const ne = PLANTED_CORONA.cmes.find(c => c.id === 'CME-NE');
    const a = frontRho(c2.f, c2.geom, nw);
    assert.ok(near(a.rho, nw.rho, 0.2) && a.contrast > 1.3, `CME-NW in C2 at ρ=${a.rho} (×${a.contrast})`);
    const b = frontRho(c3.f, c3.geom, ne);
    assert.ok(near(b.rho, ne.rho, 0.8) && b.contrast > 1.3, `CME-NE in C3 at ρ=${b.rho} (×${b.contrast})`);
    // The probe: CME-NE is at 13.5 R☉, more than twice C2's reach, so it is in
    // the C3 frame ONLY — and the layer's mask agrees (C2 weight 0, C3 weight 1).
    assert.ok(ne.rho > 0.5 / c2.geom.r, 'CME-NE is outside the C2 frame altogether');
    assert.deepEqual(compositeWeights(ne.rho, c2.field, c3.field), { w2: 0, w3: 1 });
    // …and it is on the correct SIDE: north-east is upper LEFT in the image.
    const q = planeToFrame(...Object.values(fromPositionAngle(ne.paDeg, ne.rho)), c3.geom);
    assert.ok(q.u < c3.geom.cx && q.v < c3.geom.cy, 'NE = image upper-left');
    // Negative control: mirror east–west and the front is not there.
    const mirrored = fromPositionAngle(360 - ne.paDeg, ne.rho);
    const here = fromPositionAngle(ne.paDeg, ne.rho);
    assert.ok(lumAt(c3.f, c3.geom, here.x, here.y) > 1.3 * lumAt(c3.f, c3.geom, mirrored.x, mirrored.y));
});

ok('the pylon probe finds the C3 pylon where it was planted, and flags an inverted frame', () => {
    const c3 = resolved('c3');
    const pa = pylonPositionAngle(c3.f.rgba, c3.f.w, c3.f.h, c3.geom, c3.field);
    assert.ok(pa != null && near(pa, PLANTED_CORONAGRAPH.c3.pylonPaDeg, 6), `pylon at ${pa}`);
    assert.equal(pylonSaysInverted(pa), false);
    // Flip the frame 180° (what an uncorrected inverted-SOHO product would be).
    const { rgba, w, h } = c3.f;
    const flipped = new Uint8ClampedArray(rgba.length);
    for (let i = 0, n = w * h; i < n; i++) flipped.set(rgba.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4);
    const g = resolveCoronagraphGeometry(flipped, w, h, 'c3', EPOCH);
    assert.equal(g.source, 'measured');
    const paF = pylonPositionAngle(flipped, w, h, g, fieldFor('c3', g, measureOcculter(flipped, w, h, g, 'c3')));
    assert.ok(paF != null && near(paF, 315, 6), `flipped pylon at ${paF}`);
    assert.equal(pylonSaysInverted(paF), true);
    // C2 has no visible pylon in the fixture: the probe says nothing rather than guessing.
    const c2 = resolved('c2');
    assert.equal(pylonPositionAngle(c2.f.rgba, c2.f.w, c2.f.h, c2.geom, c2.field), null);
    assert.equal(pylonSaysInverted(null), false);
});

// ── Stretch, label, GLSL ───────────────────────────────────────────────────

ok('the display stretch is monotone, pedestal-anchored and the off-limb layer\'s own function', () => {
    // 1 = as published above the pedestal (it was 0.5 until the first real C2
    // frame showed the √ merging the streamers — see STRETCH_GAMMA's comment).
    assert.equal(STRETCH_GAMMA, 1);
    let prev = -1;
    for (let L = 0; L <= 1; L += 0.01) {
        const v = displayValue(L, 0.05, 0.2);
        assert.ok(v >= prev, `not monotone at ${L}`); prev = v;
        assert.equal(v, displayStretch(Math.max(L - 0.05, 0) / 0.2, STRETCH_GAMMA));
    }
    assert.ok(DEFAULT_GAIN > 0 && DEFAULT_GAIN < 1);
});

ok('freshness uses LASCO\'s own thresholds, not AIA\'s', () => {
    assert.equal(lascoFreshness(60), 'live');
    assert.equal(lascoFreshness(LASCO_WARN_S - 1), 'live');
    assert.equal(lascoFreshness(LASCO_WARN_S + 1), 'stale');
    assert.equal(lascoFreshness(LASCO_CRIT_S + 1), 'expired');
    assert.equal(lascoFreshness(NaN), 'expired');
    assert.ok(LASCO_WARN_S > 90 * 60, 'a frame that would be CRITICAL on the AIA row is still live here');
});

ok('the chip names what is actually drawn, and a dead feed says so', () => {
    const inst = (id, over = {}) => ({ id, label: CORONAGRAPHS[id].label, short: CORONAGRAPHS[id].short, ok: true, drawn: true,
        freshness: 'live', ageS: 900, geometry: 'measured', occulterSource: 'measured', rIn: 2.2, rOut: 5.8, featherOut: 0.8, levelBasis: 'own-shell', ...over });
    const st = (insts, over = {}) => ({ enabled: true, feedDown: false, axisWeight: 1, rollDeg: 0, instruments: insts, ...over });
    assert.equal(coronagraphLabel(null), '');
    assert.equal(coronagraphLabel({ enabled: false }), '');
    assert.equal(coronagraphLabel(st([inst('c2'), inst('c3')])), ' · LASCO C2+C3');
    assert.equal(coronagraphLabel(st([inst('c2', { drawn: false, ok: false }), inst('c3')])), ' · LASCO C3 (C2 down)');
    assert.equal(coronagraphLabel(st([inst('c2', { drawn: false, ok: false }), inst('c3', { drawn: false, ok: false })], { feedDown: true })), ' · LASCO feed down');
    assert.equal(coronagraphLabel(st([inst('c2', { drawn: false, ok: false }), inst('c3', { drawn: false, ok: false })])), ' · LASCO loading');
    assert.match(coronagraphLabel(st([inst('c2', { freshness: 'stale', ageS: 5 * 3600 }), inst('c3')])), /5\.0 h old/);
    assert.match(coronagraphLabel(st([inst('c2', { geometry: 'nominal' }), inst('c3')])), /nominal geometry/);
    assert.match(coronagraphLabel(st([inst('c2'), inst('c3')], { axisWeight: 0 })), /\(off-axis\)$/);
    assert.equal(coronagraphLabel(st([inst('c2', { drawn: false, freshness: 'expired' }), inst('c3', { drawn: false, freshness: 'expired' })])), ' · LASCO frames expired');
    const note = coronagraphNote(st([inst('c2'), inst('c3', { rIn: 4.2, rOut: 26.9, levelBasis: 'c2-overlap' })]));
    for (const must of ['plane of sky', 'occulter', 'as published', 'level matched to C2', 'hands over to C3', 'north-up', 'L1']) {
        assert.ok(note.includes(must), `note is missing "${must}"`);
    }
    assert.match(coronagraphNote(st([inst('c2', { drawn: false }), inst('c3', { drawn: false })])), /nothing is drawn/);
});

ok('the GLSL takes its constants from the JS and carries no retyped geometry', () => {
    const src = readFileSync(join(ROOT, 'js', 'sun-coronagraph.js'), 'utf8');
    const lit = src.slice(src.indexOf('export const CORONAGRAPH_FRAG'), src.indexOf('// ── Browser half'));
    // Source: the guards and the discard epsilon are INTERPOLATED.
    assert.match(lit, /\$\{glf\(DISCARD_EPS \* DISCARD_EPS\)\}/);
    assert.equal((lit.match(/\$\{glf\(VALUE_EPS\)\}/g) || []).length, 2, 'both value guards come from VALUE_EPS');
    // Compiled: they arrived.
    assert.ok(CORONAGRAPH_FRAG.includes(String(DISCARD_EPS * DISCARD_EPS)));
    assert.ok(CORONAGRAPH_FRAG.includes(String(VALUE_EPS)));
    // The scalar is the MAX CHANNEL in both languages — not luminance, which
    // would draw the blue C3 product 14× hotter per channel than a neutral one.
    assert.match(CORONAGRAPH_FRAG, /float L = max\(cur\.r, max\(cur\.g, cur\.b\)\);/);
    assert.doesNotMatch(CORONAGRAPH_FRAG, /0\.2126|0\.7152|0\.0722/, 'no luma weights in the shader');
    assert.equal(pixelValue(0, 0, 255), 1);
    assert.equal(pixelValue(255, 128, 0), 1);
    assert.ok(near(pixelValue(10, 99, 20), srgbToLinear(99), 1e-15));
    assert.ok(luminance(0, 0, 1) < 0.08, 'the reason: luminance barely sees blue');
    // No instrument radius, feather, field fraction or gain is typed into the shader.
    const typed = [];
    for (const inst of Object.values(CORONAGRAPHS)) typed.push(inst.occulterRsun, inst.rInner, inst.rOuter, inst.featherIn, inst.featherOut, inst.plateScaleArcsec);
    typed.push(FIELD_FRAC, OCCULTER_MARGIN, DEFAULT_GAIN, STRETCH_GAMMA);
    const numbers = (CORONAGRAPH_FRAG.match(/\d+\.\d+(e-?\d+)?/g) || []).map(Number);
    for (const t of typed) {
        if (t === 0.5 || Number.isInteger(t)) continue;      // 0.5 / integers are not identifying
        assert.ok(!numbers.includes(t), `the shader retypes ${t}`);
    }
    // The fields, level, pedestal, roll and stretch arrive as uniforms.
    for (const u of ['u_fieldC2', 'u_fieldC3', 'u_levelC2', 'u_levelC3', 'u_floorC2', 'u_floorC3', 'u_roll', 'u_stretch', 'u_gain', 'u_axis']) {
        assert.ok(CORONAGRAPH_FRAG.includes(u), `missing uniform ${u}`);
    }
    // Repo scars: no backtick inside a glsl literal (it would have ended it —
    // so the literal must reach its own closing main), no reserved words.
    assert.ok(CORONAGRAPH_FRAG.includes('gl_FragColor') && CORONAGRAPH_VERT.includes('gl_Position'));
    for (const word of ['flat', 'patch', 'sample', 'smooth', 'centroid', 'input', 'output', 'filter', 'common']) {
        assert.doesNotMatch(CORONAGRAPH_FRAG + CORONAGRAPH_VERT, new RegExp(`\\b(float|vec[234]|int)\\s+${word}\\b`), `reserved word ${word}`);
    }
    // Never clamp-extends: the out-of-frame test precedes the texture read.
    assert.ok(CORONAGRAPH_FRAG.indexOf('uv.x < 0.0') < CORONAGRAPH_FRAG.indexOf('texture2D(tex, uv)'));
    // The pow() base is guarded (non-positive base is undefined in GLSL).
    assert.ok(CORONAGRAPH_FRAG.indexOf('if (n <= 0.0') < CORONAGRAPH_FRAG.indexOf('pow(n, u_stretch)'));
    assert.equal(INSTRUMENT_HEADER, 'X-SOHO-Instrument');
    assert.ok(MESH_R_OUTER >= CORONAGRAPHS.c3.rOuter);
});

ok('the GLSL field function agrees with the JS one (transliterated and run)', () => {
    // Pull fieldW's body out of the shader and evaluate it as JS.
    const m = CORONAGRAPH_FRAG.match(/float fieldW\(float rho, vec4 f\) \{([\s\S]*?)\n    \}/);
    assert.ok(m, 'fieldW not found');
    const body = m[1].replace(/\bf\.x\b/g, 'f[0]').replace(/\bf\.y\b/g, 'f[1]').replace(/\bf\.z\b/g, 'f[2]').replace(/\bf\.w\b/g, 'f[3]');
    const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const fieldW = new Function('rho', 'f', 'smoothstep', body);
    const { field } = resolved('c3');
    const vec = [field.rIn, field.featherIn, field.rOut, field.featherOut];
    for (let rho = 0; rho < 32; rho += 0.173) {
        assert.ok(near(fieldW(rho, vec, smoothstep), fieldWeight(rho, field), 1e-12), `ρ=${rho}`);
    }
});

ok('REAL FRAMES: a complete frame passes the integrity check, a telemetry dropout is refused', () => {
    // 256² lossless copies of real SOHO/LASCO browse frames (scripts/fetch-sdo-fixtures.mjs
    // + bake-sdo-real-thumbs.py). real_c3_dropout is the frame served on 2026-11-20 with
    // the right half of the field missing — KEPT for exactly this check. Never hand-edit.
    const M = CORO;
    const real = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'sdo', 'real-manifest.json'), 'utf8'));
    const load = (k) => decodePng(readFileSync(join(ROOT, 'tests', 'fixtures', 'sdo', real.frames[k].thumb)));
    const check = (k, id) => {
        const { width: w, height: h, rgba } = load(k);
        const geom = M.resolveCoronagraphGeometry(rgba, w, h, id, new Date(real.fetched));
        const field = M.fieldFor(id, geom, M.measureOcculter(rgba, w, h, geom, id));
        return { ...M.frameIntegrity(rgba, w, h, geom, field), field };
    };
    const c2 = check('c2', 'c2'), bad = check('c3_dropout', 'c3');
    console.log(`    C2 void ${(c2.voidFraction * 100).toFixed(2)}% of ${c2.samples} px · C3 dropout void ${(bad.voidFraction * 100).toFixed(1)}% of ${bad.samples} px`);
    assert.equal(c2.ok, true, 'a complete C2 frame is accepted');
    assert.ok(c2.voidFraction < 0.002, `a real field is never black (${c2.voidFraction})`);
    assert.equal(bad.ok, false, 'the dropout frame is refused');
    assert.ok(bad.voidFraction > 4 * M.VOID_FRACTION_MAX, `well clear of the threshold (${bad.voidFraction})`);
    // The synthetic frames are complete too — the check must not fire on them.
    for (const id of ['c2', 'c3']) {
        const size = 512, rgbaS = toRgba(renderSyntheticCoronagraph(id, { size }).rgb, size, size);
        const g = M.resolveCoronagraphGeometry(rgbaS, size, size, id, new Date(FIXTURE_EPOCH_ISO));
        const f = M.fieldFor(id, g, M.measureOcculter(rgbaS, size, size, g, id));
        assert.equal(M.frameIntegrity(rgbaS, size, size, g, f).ok, true, `synthetic ${id} is complete`);
    }
    // …and the chip says what happened rather than "down".
    const label = M.coronagraphLabel({ enabled: true, axisWeight: 1, instruments: [
        { id: 'c2', short: 'C2', drawn: true, freshness: 'live', geometry: 'measured' },
        { id: 'c3', short: 'C3', drawn: false, incomplete: true, freshness: 'expired' } ] });
    assert.match(label, /LASCO C2 \(C3 frame incomplete\)/);
    assert.equal(M.coronagraphLabel({ enabled: true, feedDown: false, instruments: [{ id: 'c3', short: 'C3', drawn: false, incomplete: true }] }), ' · LASCO frame incomplete');
});

ok('the committed fixtures are what the generator renders today', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'sdo', 'manifest.json'), 'utf8'));
    for (const id of CORONAGRAPH_IDS) {
        const entry = manifest.frames[id];
        assert.ok(entry, `manifest has no ${id} frame`);
        const f = renderSyntheticCoronagraph(id, { size: entry.size });
        const onDisk = readFileSync(join(ROOT, 'tests', 'fixtures', 'sdo', entry.file));
        assert.ok(Buffer.compare(onDisk, encodePng(f)) === 0, `${entry.file} is stale — run node scripts/make-sdo-synthetic-fixtures.mjs --only=c2,c3`);
        assert.equal(entry.synthetic, true);
        assert.deepEqual(entry.geom, f.meta.geom);
        assert.equal(entry.occulterRsun, PLANTED_CORONAGRAPH[id].occulterRsun);
    }
    assert.deepEqual(manifest.plantedCorona, JSON.parse(JSON.stringify(PLANTED_CORONA)));
});

console.log(`\n${passed} checks passed (coronagraph)`);
