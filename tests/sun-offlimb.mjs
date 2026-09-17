/**
 * tests/sun-offlimb.mjs — pins the observed off-limb layer (js/sun-offlimb.js)
 *
 *   node tests/sun-offlimb.mjs
 *
 * Gates:
 *   • the plane-of-sky basis is the SAME arithmetic sunFS's disk projection
 *     uses — derived here independently and compared, so the annulus and the
 *     disk can never end up in two different frames
 *   • a plane point maps to the frame pixel the disk path would map the
 *     corresponding limb point to (continuity across ρ = 1)
 *   • the annulus profile is 0 at and outside both edges, 1 in the middle,
 *     and monotone on each ramp
 *   • the off-axis weight is the plane analogue of fusion's `stretch`: 1 on
 *     the Sun–Earth line, 0 past OFF_AXIS_ZERO_DEG, monotone between
 *   • the reference-shell photometry measures the LOW CORONA and not the
 *     disk, survives a bright prominence (median, not mean), and REFUSES a
 *     frame with no off-limb signal instead of amplifying its noise
 *   • normalising by the reference shell makes the layer invariant to the
 *     browse product's byte-scaling — which is what stops a re-scaled frame
 *     reading as a full-disk eruption in the running difference
 *   • the chip label names the channels actually drawn and never implies a
 *     difference is ready before two distinct observations exist
 *   • the SECOND SOURCE (GOES/SUVI) draws the same two lines on the same
 *     plane, is never silently substituted in the chip, and reports a field of
 *     view computed from its own plate scale
 */
import assert from 'node:assert/strict';
import {
    R_INNER, R_OUTER, FEATHER_IN, FEATHER_OUT, REF_SHELL, REF_FLOOR,
    OFFLIMB_CHANNELS, OFF_AXIS_FULL_DEG, OFF_AXIS_ZERO_DEG,
    annulusWeight, observerBasis, planeOfSkyUV, offAxisWeight, offAxisWeightDeg,
    calibrateOffLimb, offLimbLabel, OFFLIMB_FRAG, OFFLIMB_VERT,
    displayStretch, STRETCH_GAMMA, DEFAULT_GAIN,
    OFFLIMB_SOURCES, DEFAULT_SOURCE, offLimbSource, sourceCoverage,
} from '../js/sun-offlimb.js';
import { linearToSrgb, solarEphemeris } from '../js/sun-observed.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-offlimb.mjs');

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── Geometry ───────────────────────────────────────────────────────────────

ok('the observer basis is orthonormal and right-handed', () => {
    for (const b0 of [-7.25, -3, 0, 4.1, 7.25]) {
        const b = observerBasis(b0 * Math.PI / 180);
        for (const v of [b.right, b.up, b.normal]) assert.ok(near(Math.hypot(...v), 1, 1e-12), 'unit');
        assert.ok(near(dot(b.right, b.up), 0, 1e-12));
        assert.ok(near(dot(b.right, b.normal), 0, 1e-12));
        assert.ok(near(dot(b.up, b.normal), 0, 1e-12));
        // right × up = normal
        const [rx, ry, rz] = b.right, [ux, uy, uz] = b.up;
        const cross = [ry * uz - rz * uy, rz * ux - rx * uz, rx * uy - ry * ux];
        for (let i = 0; i < 3; i++) assert.ok(near(cross[i], b.normal[i], 1e-12), 'right-handed');
    }
});

ok('the basis IS sunFS\'s disk rotation — same arithmetic, written twice', () => {
    // sunFS: q = (p.x, p.y·cb − p.z·sb, p.y·sb + p.z·cb), and the image uses
    // (q.x, q.y) with q.z = μ_Earth. So the image axes in the sphere's object
    // frame are exactly the rows of that rotation.
    for (const b0deg of [-7.25, 0, 5.5, 7.25]) {
        const b0 = b0deg * Math.PI / 180;
        const cb = Math.cos(b0), sb = Math.sin(b0);
        const b = observerBasis(b0);
        // A random object-frame point, pushed through both paths.
        const p = [0.31, -0.62, 0.72];
        const q = [p[0], p[1] * cb - p[2] * sb, p[1] * sb + p[2] * cb];
        assert.ok(near(dot(p, b.right),  q[0], 1e-12), 'image x');
        assert.ok(near(dot(p, b.up),     q[1], 1e-12), 'image y');
        assert.ok(near(dot(p, b.normal), q[2], 1e-12), 'μ_Earth');
    }
});

ok('a plane point maps to the same pixel the disk path maps the limb to', () => {
    // At ρ = 1 the sphere's limb point (seen from Earth) has image coordinates
    // (q.x, q.y) with |q| = 1 and q.z = 0 — identical to the plane point at
    // radius 1. The two layers must therefore agree pixel-for-pixel at ρ = 1.
    const geom = { cx: 0.5, cy: 0.5, r: 0.39 };
    for (const th of [0, 0.7, 1.9, 3.3, 5.5]) {
        const x = Math.cos(th), y = Math.sin(th);
        const plane = planeOfSkyUV(x, y, geom);
        // The disk path's own formula, written out (sun.html sunFS):
        //   tuv = (u_obsGeom.x + q.x·r, u_obsGeom.y + q.y·r), u_obsGeom.y = 1 − cy
        const diskU = geom.cx + x * geom.r;
        const diskV = (1 - geom.cy) + y * geom.r;
        assert.ok(near(plane.u, diskU, 1e-12) && near(plane.v, diskV, 1e-12));
        assert.ok(near(plane.rho, 1, 1e-12));
    }
});

ok('the annulus profile closes at both edges and is monotone on each ramp', () => {
    assert.equal(annulusWeight(0.5), 0, 'nothing inside the limb — the disk owns that');
    assert.equal(annulusWeight(R_INNER), 0);
    assert.equal(annulusWeight(R_OUTER), 0);
    assert.equal(annulusWeight(R_OUTER + 0.2), 0);
    const mid = (R_INNER + FEATHER_IN + R_OUTER - FEATHER_OUT) / 2;
    assert.ok(annulusWeight(mid) > 0.999, `full weight mid-annulus, got ${annulusWeight(mid)}`);
    let prev = -1;
    for (let r = R_INNER; r <= R_INNER + FEATHER_IN; r += FEATHER_IN / 20) {
        const w = annulusWeight(r);
        assert.ok(w >= prev - 1e-12, 'inner ramp rises');
        prev = w;
    }
    prev = 2;
    for (let r = R_OUTER - FEATHER_OUT; r <= R_OUTER; r += FEATHER_OUT / 20) {
        const w = annulusWeight(r);
        assert.ok(w <= prev + 1e-12, 'outer ramp falls');
        prev = w;
    }
});

// ── Off-axis gate ──────────────────────────────────────────────────────────

ok('off-axis weight: 1 on the Sun–Earth line, 0 past the zero angle, monotone', () => {
    assert.ok(near(offAxisWeightDeg(0), 1, 1e-12), 'the viewer IS the observer');
    assert.ok(offAxisWeightDeg(OFF_AXIS_FULL_DEG) > 0.999, 'full inside the full angle');
    assert.equal(offAxisWeightDeg(OFF_AXIS_ZERO_DEG), 0);
    assert.equal(offAxisWeightDeg(90), 0, 'edge-on plane draws nothing');
    assert.equal(offAxisWeightDeg(180), 0, 'and neither does the far side');
    let prev = 2;
    for (let d = 0; d <= 90; d += 1) {
        const w = offAxisWeightDeg(d);
        assert.ok(w <= prev + 1e-12, `monotone at ${d}°`);
        prev = w;
    }
    // The gate must actually bite in the range a user orbits through.
    assert.ok(offAxisWeightDeg(35) < 0.85 && offAxisWeightDeg(35) > 0.05,
        `a 35° orbit is partially faded, got ${offAxisWeightDeg(35).toFixed(3)}`);
    // Half weight lands where the plane is genuinely being stretched, not at
    // a framing the page uses by default (the load camera sits ON the line).
    assert.ok(offAxisWeightDeg(40) < 0.5 && offAxisWeightDeg(20) > 0.9,
        `20°: ${offAxisWeightDeg(20).toFixed(3)}, 40°: ${offAxisWeightDeg(40).toFixed(3)}`);
});

ok('offAxisWeight takes the cosine the renderer actually computes', () => {
    for (const d of [0, 10, 25, 40, 60]) {
        assert.ok(near(offAxisWeight(Math.cos(d * Math.PI / 180)), offAxisWeightDeg(d), 1e-12));
    }
});

// ── Reference-shell photometry ─────────────────────────────────────────────

/**
 * A synthetic AIA-like frame: bright disk, an off-limb corona decaying with
 * radius, optional planted prominence. Written in LINEAR and encoded to sRGB
 * bytes the way a browse product would be, so calibrateOffLimb's EOTF undo is
 * exercised rather than bypassed.
 */
function synthFrame(size, geom, { diskI = 0.75, coronaI = 0.06, scale = 1, prominence = null } = {}) {
    const rgba = new Uint8ClampedArray(size * size * 4);
    const R = geom.r * size, cx = geom.cx * size, cy = geom.cy * size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - cx) / R, dy = (y - cy) / R;
            const rho = Math.hypot(dx, dy);
            let I = rho < 1 ? diskI : coronaI * Math.exp(-(rho - 1) * 4);
            if (prominence && rho >= 1) {
                const d = Math.hypot(dx - prominence.x, dy - prominence.y);
                I += prominence.amp * Math.exp(-(d * d) / (2 * prominence.sigma * prominence.sigma));
            }
            I *= scale;
            const o = (y * size + x) * 4;
            rgba[o] = linearToSrgb(I); rgba[o + 1] = linearToSrgb(I * 0.45); rgba[o + 2] = linearToSrgb(I * 0.22);
            rgba[o + 3] = 255;
        }
    }
    return rgba;
}

const GEOM = { cx: 0.5, cy: 0.5, r: 0.39 };

ok('the reference shell measures the low corona, not the disk', () => {
    const size = 256;
    const rgba = synthFrame(size, GEOM, { diskI: 0.75, coronaI: 0.06 });
    const cal = calibrateOffLimb(rgba, size, size, GEOM);
    assert.equal(cal.ok, true, 'a frame with off-limb signal calibrates');
    assert.ok(cal.samples > 200, `enough shell pixels, got ${cal.samples}`);
    // Expected: the luminance of the synthetic corona at the shell midpoint.
    const rhoMid = (REF_SHELL.lo + REF_SHELL.hi) / 2;
    const Imid = 0.06 * Math.exp(-(rhoMid - 1) * 4);
    const lumMid = 0.2126 * Imid + 0.7152 * Imid * 0.45 + 0.0722 * Imid * 0.22;
    assert.ok(Math.abs(cal.ref - lumMid) / lumMid < 0.20,
        `ref ${cal.ref.toExponential(3)} ≈ shell luminance ${lumMid.toExponential(3)}`);
    // And it is nowhere near the disk's level — that is the whole point.
    const lumDisk = 0.2126 * 0.75 + 0.7152 * 0.75 * 0.45 + 0.0722 * 0.75 * 0.22;
    assert.ok(cal.ref < lumDisk * 0.2, 'the disk did not leak into the shell');
});

ok('a bright prominence does not move the reference (median, not mean)', () => {
    const size = 256;
    const clean = calibrateOffLimb(synthFrame(size, GEOM), size, size, GEOM);
    const withProm = calibrateOffLimb(
        synthFrame(size, GEOM, { prominence: { x: 1.08, y: 0.0, amp: 0.55, sigma: 0.05 } }),
        size, size, GEOM);
    assert.equal(withProm.ok, true);
    const drift = Math.abs(withProm.ref - clean.ref) / clean.ref;
    assert.ok(drift < 0.05, `reference drifted ${(drift * 100).toFixed(1)}% under a bright prominence`);
});

ok('a frame with no off-limb signal is REFUSED, not amplified', () => {
    const size = 256;
    // coronaI = 0: the shell is black. 1/ref would turn JPEG ringing into a
    // convincing corona — the exact failure the honesty rules forbid.
    const rgba = synthFrame(size, GEOM, { coronaI: 0 });
    const cal = calibrateOffLimb(rgba, size, size, GEOM);
    assert.equal(cal.ok, false, 'a black shell is not a quiet corona');
    assert.ok(cal.ref < REF_FLOOR);
    // And a frame we cannot read at all degrades rather than throwing.
    assert.equal(calibrateOffLimb(null, size, size, GEOM).ok, false);
    assert.equal(calibrateOffLimb(rgba, size, size, { cx: 0.5, cy: 0.5, r: 0 }).ok, false);
});

ok('normalising by the reference shell is invariant to the browse byte-scaling', () => {
    // THE RUNNING-DIFFERENCE TRAP. If the browse product's scaling changes
    // between two refreshes and we do not divide it out, the whole annulus
    // lights up as one enormous eruption. Two frames of the SAME corona at
    // different display scales must normalise to the same field.
    const size = 256;
    const a = synthFrame(size, GEOM, { scale: 1.0 });
    const b = synthFrame(size, GEOM, { scale: 0.6 });
    const ca = calibrateOffLimb(a, size, size, GEOM);
    const cb = calibrateOffLimb(b, size, size, GEOM);
    assert.ok(ca.ok && cb.ok);
    // Sample the same off-limb pixel from both, normalised by their own refs.
    const R = GEOM.r * size, cx = GEOM.cx * size, cy = GEOM.cy * size;
    const px = Math.round(cx + 1.25 * R), py = Math.round(cy);
    const lin = (buf) => {
        const o = (py * size + px) * 4;
        const s = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
        return 0.2126 * s(buf[o]) + 0.7152 * s(buf[o + 1]) + 0.0722 * s(buf[o + 2]);
    };
    const na = lin(a) / ca.ref, nb = lin(b) / cb.ref;
    assert.ok(Math.abs(na - nb) / na < 0.06,
        `normalised levels must agree across a re-scale: ${na.toFixed(4)} vs ${nb.toFixed(4)}`);
    // Sanity: without the normalisation they would NOT agree — the guard is
    // doing work, not passing vacuously.
    assert.ok(Math.abs(lin(a) - lin(b)) / lin(a) > 0.2, 'the raw levels really do differ');
});

// ── Display stretch ────────────────────────────────────────────────────────

ok('the display stretch is monotone — it cannot reorder two brightnesses', () => {
    // A stretch is legitimate only because it preserves ORDER: whichever of
    // two off-limb points is brighter in the frame is brighter on screen. If
    // it ever stopped being monotone the layer would be lying about structure.
    let prev = -1;
    for (let v = 0; v <= 100; v += 0.25) {
        const d = displayStretch(v);
        assert.ok(d >= prev, `monotone at ${v}`);
        prev = d;
    }
    assert.equal(displayStretch(0), 0);
    assert.equal(displayStretch(1), 1, 'the quiet corona (=1 by construction) is the fixed point');
    assert.ok(Math.abs(displayStretch(4) - 2) < 1e-12, 'square root');
    assert.equal(displayStretch(-3), 0, 'a negative never comes back as NaN');
});

ok('the stretch actually fits the 70:1 field into a drawable range', () => {
    // The problem it exists to solve, stated as a test: the normalised field
    // spans ~70:1 (quiet shell = 1 by construction, a bright prominence ~70).
    // Linear, no single gain holds both. Stretched, one does.
    const quiet = displayStretch(1) * DEFAULT_GAIN;
    const prom  = displayStretch(72) * DEFAULT_GAIN;
    assert.ok(quiet > 0.05, `the quiet corona is visible (${quiet.toFixed(3)})`);
    assert.ok(prom < 2.0, `a prominence does not run away (${prom.toFixed(3)})`);
    assert.ok(prom / quiet > 5, 'and a prominence is still obviously brighter');
    // The linear alternative, for the record: one gain cannot do both.
    const linQuiet = 1 * DEFAULT_GAIN, linProm = 72 * DEFAULT_GAIN;
    assert.ok(linProm > 5, `linear would clip hard (${linProm.toFixed(1)})`);
    assert.ok(linQuiet < prom / 4, 'and turning the gain down to fix that buries the corona');
});

ok('the shader stretches LUMINANCE, not the channels separately', () => {
    // Stretching R, G and B independently pulls every bright feature toward
    // white — it would desaturate exactly the prominences the layer exists to
    // show, and recolouring an observed pixel is forbidden (plan §5.2).
    assert.match(OFFLIMB_FRAG, /pow\(L, u_stretch\) \/ L/, 'scalar stretch on luminance');
    assert.ok(!/pow\(cur,/.test(OFFLIMB_FRAG), 'never a per-channel pow');
    assert.match(OFFLIMB_FRAG, /pow\(abs\(d\), u_stretch\)/, 'the difference view is stretched too');
});

// ── Chip ───────────────────────────────────────────────────────────────────

ok('the chip names the channels actually drawn and never over-claims', () => {
    const chOk = (c) => ({ channel: c, ok: true });
    assert.equal(offLimbLabel({ enabled: false }), '', 'silent when off');
    assert.equal(offLimbLabel({ enabled: true, channels: [], feedDown: true }), ' · off-limb feed down');
    assert.equal(offLimbLabel({ enabled: true, channels: [], feedDown: false }), ' · off-limb loading');
    assert.equal(
        offLimbLabel({ enabled: true, axisWeight: 1, channels: [chOk('304'), chOk('131')] }),
        ' · off-limb 304+131');
    // One channel down names only the one that is up.
    assert.equal(
        offLimbLabel({ enabled: true, axisWeight: 1, channels: [chOk('304'), { channel: '131', ok: false }] }),
        ' · off-limb 304');
    // A difference that has only one observation must say so.
    assert.equal(
        offLimbLabel({ enabled: true, axisWeight: 1, diff: true, diffReady: false, channels: [chOk('304')] }),
        ' · off-limb Δ304 (awaiting next frame)');
    assert.equal(
        offLimbLabel({ enabled: true, axisWeight: 1, diff: true, diffReady: true, channels: [chOk('304')] }),
        ' · off-limb Δ304');
    // Faded out by the camera is NOT the same as absent.
    assert.equal(
        offLimbLabel({ enabled: true, axisWeight: 0, channels: [chOk('304')] }),
        ' · off-limb 304 (off-axis)');
});

ok('the two channels are the cool/hot pair the layer claims', () => {
    assert.deepEqual(OFFLIMB_CHANNELS, ['304', '131']);
});

// ── GLSL mirrors ───────────────────────────────────────────────────────────

ok('the shader carries the JS conventions it mirrors', () => {
    // The fragment shader must use the disk path's geom convention and must
    // refuse to sample outside the frame (clamp-extending a border texel
    // across the sky is how an annulus grows a fake corona).
    assert.match(OFFLIMB_FRAG, /geom\.x \+ p\.x \* geom\.z/, 'disk-path UV formula');
    assert.match(OFFLIMB_FRAG, /uv\.x < 0\.0 \|\| uv\.x > 1\.0/, 'outside-frame guard');
    assert.match(OFFLIMB_FRAG, /max\(ref, 1e-4\)/, 'reference-shell normalisation');
    assert.match(OFFLIMB_VERT, /vPlane = position\.xy/, 'object xy IS plane-of-sky');
    // No de-rotation term: the plane is pinned to the observer, not the sphere.
    assert.ok(!/rotAngle|u_rot\b/.test(OFFLIMB_FRAG), 'the plane must not co-rotate');
});

ok('B0 really does move the plane (the basis is not a constant)', () => {
    const now = observerBasis(solarEphemeris(new Date('2026-03-06T00:00:00Z')).b0Deg * Math.PI / 180);
    const sep = observerBasis(solarEphemeris(new Date('2026-09-08T00:00:00Z')).b0Deg * Math.PI / 180);
    // Early March and early September are near the B0 extremes (∓7.25°).
    const cos = dot(now.normal, sep.normal);
    assert.ok(cos < Math.cos(10 * Math.PI / 180),
        `the two extremes are >10° apart, got ${(Math.acos(cos) * 180 / Math.PI).toFixed(2)}°`);
});



// ── The second source (Phase 3e) ───────────────────────────────────────────

ok('the default source is SDO and both sources draw the same two lines', () => {
    assert.equal(DEFAULT_SOURCE, 'sdo');
    assert.deepEqual([...OFFLIMB_SOURCES.sdo.channels], [...OFFLIMB_CHANNELS]);
    // Same BANDS (304 cool + 131 hot), different proxy channels: the pairing
    // the layer is built around carries over, only the instrument moves.
    assert.deepEqual([...OFFLIMB_SOURCES.suvi.bands], [...OFFLIMB_SOURCES.sdo.bands]);
    assert.notDeepEqual([...OFFLIMB_SOURCES.suvi.channels], [...OFFLIMB_SOURCES.sdo.channels]);
    for (const src of Object.values(OFFLIMB_SOURCES)) {
        assert.equal(src.channels.length, 2, 'two slots, A and B');
        assert.equal(src.bands.length, 2);
    }
});

ok('an unknown source id falls back rather than throwing', () => {
    assert.equal(offLimbSource('nope').id, 'sdo');
    assert.equal(offLimbSource(undefined).id, 'sdo');
    assert.equal(offLimbSource('suvi').id, 'suvi');
});

ok('SUVI is the wider field and that is the whole reason it is here', () => {
    const sdo = sourceCoverage('sdo'), suvi = sourceCoverage('suvi');
    // The SDO frame does NOT cover the annulus this module draws...
    assert.ok(sdo.fraction < 0.7, `SDO coverage ${sdo.fraction}`);
    assert.ok(sdo.reach.axis < R_OUTER, 'and it falls short on the axes');
    // ...while SUVI does, everywhere.
    assert.ok(1 - suvi.fraction < 1e-12, `SUVI coverage ${suvi.fraction}`);
    assert.ok(suvi.reach.axis > R_OUTER);
    // The trade is resolution: SUVI's plate scale is coarser, which is why the
    // DISK path is not moved to it.
    assert.ok(OFFLIMB_SOURCES.suvi.plateScale > OFFLIMB_SOURCES.sdo.plateScale);
});

ok('the chip never substitutes one instrument for the other silently', () => {
    const chans = (bands) => bands.map(b => ({ channel: b, band: b, ok: true }));
    const base = { enabled: true, axisWeight: 1, channels: chans(['304', '131']) };
    // The default source stays unadorned — no regression in the existing label.
    assert.equal(offLimbLabel({ ...base, sourceId: 'sdo' }), ' · off-limb 304+131');
    // SUVI is NAMED. 304 from SUVI and 304 from AIA are the same line but not
    // the same measurement, so a source switch must be visible.
    const suvi = offLimbLabel({ ...base, sourceId: 'suvi' });
    assert.match(suvi, /GOES\/SUVI/);
    assert.match(suvi, /304\+131/);
    // …in every state the label has.
    assert.match(offLimbLabel({ ...base, sourceId: 'suvi', feedDown: true, channels: [] }), /GOES\/SUVI feed down/);
    assert.match(offLimbLabel({ ...base, sourceId: 'suvi', axisWeight: 0 }), /GOES\/SUVI 304\+131 \(off-axis\)/);
    assert.match(offLimbLabel({ ...base, sourceId: 'suvi', diff: true, diffReady: true }), /ΔGOES\/SUVI/);
    assert.match(offLimbLabel({ ...base, sourceId: 'suvi', diff: true, diffReady: false }), /awaiting next frame/);
});

ok('the chip prints the BAND, not the proxy channel name', () => {
    const label = offLimbLabel({
        enabled: true, axisWeight: 1, sourceId: 'suvi',
        channels: [{ channel: 'suvi304', band: '304', ok: true }, { channel: 'suvi131', band: '131', ok: true }],
    });
    assert.ok(!label.includes('suvi304'), `leaked the proxy name: ${label}`);
    assert.match(label, /304\+131/);
});

console.log(`\n${passed} checks passed (off-limb)`);
