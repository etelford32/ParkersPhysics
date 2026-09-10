/**
 * tests/sun-observed.mjs — pins the observed-disk math in js/sun-observed.js
 *
 *   node tests/sun-observed.mjs
 *
 * Gates (SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 1):
 *   • solarEphemeris reproduces the B0 / P extremes of the year (Meeus)
 *   • projectDiskUV puts a planted feature on the pixel the synthetic
 *     fixture painted it at, and that pixel IS dark (white light) / bright
 *     (EUV) — the projection and the generator agree, and the AR-alignment
 *     tolerance (1.5°) is enforced on the fixture geometry
 *   • measureDisk recovers the disk radius + centre of centred AND shifted
 *     frames for HMI, AIA and magnetogram styles
 *   • resolveDiskGeometry falls back per instrument on an implausible measure
 *   • rotationDeRotate inverts the AR-slot rotation exactly
 *   • chipLabel never says OBSERVED in model mode, and reports age / stale
 *   • REAL_TIME_ROT_MUL makes one synodic rotation take 27.2753 d
 *   • the committed fixtures + manifest match the generator's plants
 *   • calibrateDisk recovers a planted limb law, is BLIND to the browse
 *     product's colour LUT, and fits limb BRIGHTENING negative (Phase 2b —
 *     this is the gate on the observed/model seam)
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CHANNELS, DISK_FRACTION, VIEW_MODE_CHANNEL, REAL_TIME_ROT_MUL,
    FRESH_WARN_S, FRESH_CRIT_S,
    solarEphemeris, heliographicToVec, projectDiskUV, projectToPixel,
    measureDisk, resolveDiskGeometry, rotationDeRotate, slotRotAngle, diffRotFactor,
    freshnessFor, chipLabel, diskFractionFor,
    calibrateDisk, limbLaw, srgbToLinear, linearToSrgb, luminance,
} from '../js/sun-observed.js';
import { renderSyntheticDisk, toGray, PLANTED, FIXTURE_EPOCH_ISO } from '../scripts/lib/sdo-synth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEG = Math.PI / 180;
let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('sun-observed.mjs');

// ── Ephemeris ──────────────────────────────────────────────────────────────
ok('B0 hits ±7.25° at the early-Sept / early-March extremes and ~0 in June / Dec', () => {
    const at = (d) => solarEphemeris(new Date(d + 'T12:00:00Z'));
    assert.ok(at('2026-09-08').b0Deg > 7.2, 'Sept 8 B0 max');
    assert.ok(at('2026-03-06').b0Deg < -7.2, 'Mar 6 B0 min');
    assert.ok(Math.abs(at('2026-06-06').b0Deg) < 0.3, 'Jun 6 B0 ≈ 0');
    assert.ok(Math.abs(at('2026-12-07').b0Deg) < 0.3, 'Dec 7 B0 ≈ 0');
});
ok('P angle hits ±26.25° in early April / October and ~0 in early Jan / July', () => {
    const at = (d) => solarEphemeris(new Date(d + 'T12:00:00Z'));
    assert.ok(at('2026-10-10').pDeg > 26.0, 'Oct 10 P max');
    assert.ok(at('2026-04-06').pDeg < -26.0, 'Apr 6 P min');
    assert.ok(Math.abs(at('2026-01-05').pDeg) < 0.5, 'Jan 5 P ≈ 0');
    assert.ok(Math.abs(at('2026-07-07').pDeg) < 0.5, 'Jul 7 P ≈ 0');
});

// ── Frames + projection ────────────────────────────────────────────────────
ok('heliographicToVec matches the AR-slot basis (cos lat sin lon, sin lat, cos lat cos lon)', () => {
    const v = heliographicToVec(0, 0);
    assert.deepEqual(v.map(x => +x.toFixed(9)), [0, 0, 1]);
    const w = heliographicToVec(0, 90);
    assert.ok(Math.abs(w[0] - 1) < 1e-9 && Math.abs(w[2]) < 1e-9, 'W90 → +x');
    const n = heliographicToVec(90, 0);
    assert.ok(Math.abs(n[1] - 1) < 1e-9, 'N90 → +y');
});
ok('projectDiskUV: disk centre → (cx, 1−cy); B0 tilts the centre off the equator; far side invisible', () => {
    const g0 = { cx: 0.5, cy: 0.5, r: 0.4, b0Rad: 0 };
    const c = projectDiskUV([0, 0, 1], g0);
    assert.ok(Math.abs(c.u - 0.5) < 1e-12 && Math.abs(c.v - 0.5) < 1e-12 && c.visible);
    assert.equal(projectDiskUV([0, 0, -1], g0).visible, false, 'antipode hidden');
    const g7 = { ...g0, b0Rad: 7 * DEG };
    // With B0 = +7°, the sub-Earth point is at heliographic lat +7°: that point maps to the image centre.
    const sub = heliographicToVec(7, 0);
    const q = projectDiskUV(sub, g7);
    assert.ok(Math.abs(q.u - 0.5) < 1e-9 && Math.abs(q.v - 0.5) < 1e-9, 'sub-Earth point at B0 lands on disk centre');
    // Solar west (W lon) → +u (image right); north → +v (texture up).
    assert.ok(projectDiskUV(heliographicToVec(0, 30), g0).u > 0.5, 'west is image-right');
    assert.ok(projectDiskUV(heliographicToVec(30, 0), g0).v > 0.5, 'north is texture-up');
});
ok('the limb maps to exactly r from the centre', () => {
    const g = { cx: 0.5, cy: 0.5, r: 0.39, b0Rad: 0 };
    const q = projectDiskUV(heliographicToVec(0, 90), g);
    assert.ok(Math.abs((q.u - 0.5) - 0.39) < 1e-12);
});

// ── Synthetic fixtures ─────────────────────────────────────────────────────
const SIZE = 512;
const white = renderSyntheticDisk('white', { size: SIZE });
const aia171 = renderSyntheticDisk('171', { size: SIZE });
const mag = renderSyntheticDisk('mag', { size: SIZE });
const geomOf = (f) => ({ ...f.meta.geom, b0Rad: f.meta.b0Deg * DEG });

ok('planted ARs land on the pixel the generator painted (projection ↔ generator agree)', () => {
    for (const p of white.meta.planted) {
        const px = projectToPixel(p.latDeg, p.lonDeg, geomOf(white), SIZE, SIZE);
        assert.ok(Math.abs(px.x - p.px) < 1e-6 && Math.abs(px.y - p.py) < 1e-6, `${p.id} pixel`);
        assert.equal(px.visible, p.visible);
    }
});
ok('white light: the projected AR pixel is a dark sunspot; 1.5° away in longitude it is still inside the umbra+penumbra', () => {
    const g = toGray(white.rgb, SIZE, SIZE);
    const at = (x, y) => g[Math.round(y) * SIZE + Math.round(x)];
    let diskMean = 0, n = 0;
    for (let y = 200; y < 312; y += 4) for (let x = 200; x < 312; x += 4) { diskMean += at(x, y); n++; }
    diskMean /= n;
    for (const p of PLANTED) {
        const px = projectToPixel(p.latDeg, p.lonDeg, geomOf(white), SIZE, SIZE);
        assert.ok(at(px.x, px.y) < 0.35 * diskMean, `${p.id} centre is dark (${at(px.x, px.y).toFixed(0)} vs disk ${diskMean.toFixed(0)})`);
        // AR alignment tolerance from the plan (1.5°): offset by 1.5° and we must still be inside the spot.
        const off = projectToPixel(p.latDeg, p.lonDeg + 1.5, geomOf(white), SIZE, SIZE);
        assert.ok(at(off.x, off.y) < 0.75 * diskMean, `${p.id} +1.5° is still spot`);
        // 8° away is quiet photosphere.
        const far = projectToPixel(p.latDeg, p.lonDeg + 8, geomOf(white), SIZE, SIZE);
        assert.ok(at(far.x, far.y) > 0.6 * diskMean, `${p.id} +8° is quiet Sun`);
    }
});
ok('EUV 171: the projected AR pixel is bright against the quiet disk', () => {
    const g = toGray(aia171.rgb, SIZE, SIZE);
    const at = (x, y) => g[Math.round(y) * SIZE + Math.round(x)];
    const quiet = at(256, 256);
    for (const p of PLANTED) {
        const px = projectToPixel(p.latDeg, p.lonDeg, geomOf(aia171), SIZE, SIZE);
        assert.ok(at(px.x, px.y) > 1.8 * quiet, `${p.id} bright loops`);
    }
});
ok('measureDisk recovers r and centre on HMI, AIA and magnetogram frames', () => {
    for (const [name, f, expect] of [['white', white, DISK_FRACTION.hmi], ['171', aia171, DISK_FRACTION.aia], ['mag', mag, DISK_FRACTION.hmi]]) {
        const m = measureDisk(toGray(f.rgb, SIZE, SIZE), SIZE, SIZE);
        assert.ok(m.ok, `${name}: rays agree (spread ${m.spread.toFixed(3)})`);
        assert.ok(Math.abs(m.r - expect) / expect < 0.012, `${name}: r ${m.r.toFixed(4)} vs ${expect}`);
        assert.ok(Math.abs(m.cx - 0.5) * SIZE < 1.5 && Math.abs(m.cy - 0.5) * SIZE < 1.5, `${name}: centre within 1.5 px (${(m.cx * SIZE).toFixed(2)}, ${(m.cy * SIZE).toFixed(2)})`);
    }
});
ok('measureDisk follows a shifted disk (+9 px, −6 px)', () => {
    const g = toGray(white.rgb, SIZE, SIZE);
    const shifted = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const sx = x - 9, sy = y + 6;
        shifted[y * SIZE + x] = (sx >= 0 && sx < SIZE && sy >= 0 && sy < SIZE) ? g[sy * SIZE + sx] : 0;
    }
    const m = measureDisk(shifted, SIZE, SIZE);
    assert.ok(m.ok);
    assert.ok(Math.abs(m.cx * SIZE - (256 + 9)) < 1.2, `cx ${(m.cx * SIZE).toFixed(2)}`);
    assert.ok(Math.abs(m.cy * SIZE - (256 - 6)) < 1.2, `cy ${(m.cy * SIZE).toFixed(2)}`);
});
ok('resolveDiskGeometry: measured when plausible, per-instrument fallback otherwise', () => {
    const good = resolveDiskGeometry({ ok: true, cx: 0.501, cy: 0.499, r: 0.392 }, '171');
    assert.equal(good.source, 'measured');
    const bad = resolveDiskGeometry({ ok: true, cx: 0.5, cy: 0.5, r: 0.30 }, '171');
    assert.equal(bad.source, 'fallback'); assert.equal(bad.r, DISK_FRACTION.aia);
    const noisy = resolveDiskGeometry({ ok: false, cx: 0.5, cy: 0.5, r: 0.465 }, 'white');
    assert.equal(noisy.source, 'fallback'); assert.equal(noisy.r, DISK_FRACTION.hmi);
    assert.equal(resolveDiskGeometry(null, 'mag').r, DISK_FRACTION.hmi);
    assert.equal(diskFractionFor('304'), DISK_FRACTION.aia);
});

// ── Rotation ───────────────────────────────────────────────────────────────
ok('rotationDeRotate inverts the AR-slot rotation (x = c·x0 − s·z0, z = s·x0 + c·z0)', () => {
    const p0 = heliographicToVec(15, 20);
    const lat = 15 * DEG;
    const ra = slotRotAngle(123.4, 1.0, lat);
    assert.ok(Math.abs(ra - 123.4 * 0.014 * diffRotFactor(lat)) < 1e-12);
    const c = Math.cos(ra), s = Math.sin(ra);
    const rotated = [c * p0[0] - s * p0[2], p0[1], s * p0[0] + c * p0[2]];
    const back = rotationDeRotate(rotated, ra);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - p0[i]) < 1e-12, `component ${i}`);
});
ok('REAL_TIME_ROT_MUL: one synodic rotation takes 27.2753 d at the sim clock rate', () => {
    const radPerSec = 0.014 * REAL_TIME_ROT_MUL * 0.6;    // 0.010 units/frame × 60 fps
    assert.ok(Math.abs(radPerSec * 27.2753 * 86400 - 2 * Math.PI) < 1e-9);
});

// ── Chip ───────────────────────────────────────────────────────────────────
ok('freshnessFor thresholds match the registry row (30 min warn, 90 min crit)', () => {
    assert.equal(freshnessFor(60), 'live');
    assert.equal(freshnessFor(FRESH_WARN_S + 1), 'stale');
    assert.equal(freshnessFor(FRESH_CRIT_S + 1), 'expired');
    assert.equal(freshnessFor(NaN), 'unknown');
});
ok('chipLabel: OBSERVED carries instrument, UTC and age; stale is named; model never says OBSERVED', () => {
    const now = Date.parse('2026-09-06T14:19:00Z');
    const obs = chipLabel({ mode: 'observed', channel: 'white', observedAt: Date.parse('2026-09-06T14:12:00Z'), nowMs: now });
    assert.match(obs, /^OBSERVED · SDO\/HMI continuum · 2026-09-06 14:12 UTC · 7 min old$/);
    const euv = chipLabel({ mode: 'observed', channel: '171', observedAt: now - 41 * 60 * 1000, nowMs: now });
    assert.match(euv, /^OBSERVED \(stale\) · SDO\/AIA 171 Å · .* · 41 min old$/);
    const down = chipLabel({ mode: 'observed', channel: '304', observedAt: now - 10 * 60 * 1000, nowMs: now, feedDown: true });
    assert.match(down, /refresh failed$/);
    for (const reason of [null, 'feed-down', 'cutaway', 'doppler', 'user']) {
        const m = chipLabel({ mode: 'model', reason, nowMs: now });
        assert.match(m, /^MODEL · procedural photosphere/);
        assert.doesNotMatch(m, /OBSERVED/);
    }
    assert.match(chipLabel({ mode: 'model', reason: 'feed-down' }), /feed down$/);
});
ok('VIEW_MODE_CHANNEL covers sun.html modes 0–6 with known proxy channels', () => {
    for (let m = 0; m <= 6; m++) assert.ok(CHANNELS[VIEW_MODE_CHANNEL[m]], `mode ${m}`);
    assert.equal(VIEW_MODE_CHANNEL[0], 'white'); assert.equal(VIEW_MODE_CHANNEL[6], 'mag');
});

// ── Committed fixtures ─────────────────────────────────────────────────────
ok('tests/fixtures/sdo carries every channel the page wraps + a manifest with the plants', () => {
    const dir = join(ROOT, 'tests', 'fixtures', 'sdo');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.synthetic, true);
    assert.equal(manifest.epoch, FIXTURE_EPOCH_ISO);
    for (const ch of ['white', 'mag', '171', '193', '211', '131', '304']) {
        assert.ok(manifest.frames[ch], `manifest has ${ch}`);
        assert.ok(existsSync(join(dir, manifest.frames[ch].file)), `${ch} file exists`);
        assert.equal(manifest.frames[ch].synthetic, true);
    }
    assert.deepEqual(manifest.planted.map(p => p.id), PLANTED.map(p => p.id));
    // Regenerating must be a no-op on the ground truth (deterministic renderer).
    const again = renderSyntheticDisk('white', { size: manifest.size });
    assert.deepEqual(again.meta.planted, manifest.frames.white.planted);
});

// ── Frame photometry (Phase 2b: observed ↔ model fusion) ───────────────────
// These pin the fix for the terminator seam. calibrateDisk works in the space
// the SHADER sees — the texture is tagged SRGBColorSpace, so texture2D returns
// srgbToLinear(byte) — hence every synthetic frame below is ENCODED with
// linearToSrgb. A frame authored with bytes linear in intensity (which is what
// scripts/lib/sdo-synth.mjs does) is a different, and for this purpose wrong,
// thing to fit.

/** RGBA frame carrying a known limb law I0·(1 − u1(1−μ) − u2(1−μ)²), optionally colorized. */
function makeCalFrame({ size = 256, r = 0.465, I0 = 0.82, u1 = 0.88, u2 = -0.23,
                        chroma = [1, 1, 1], spots = [], speckle = 0 } = {}) {
    const rgba = new Uint8ClampedArray(size * size * 4);
    const R = r * size, cx = size / 2, cy = size / 2;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const rho = Math.hypot(dx, dy) / R;
            const o = (y * size + x) * 4;
            rgba[o + 3] = 255;
            if (rho >= 1) continue;
            const mu = Math.sqrt(Math.max(0, 1 - rho * rho));
            let I = I0 * limbLaw(mu, u1, u2);
            if (speckle) I *= 1 + (rnd() - 0.5) * speckle;
            for (const s of spots) {
                const d = Math.hypot(x - s.x, y - s.y) / s.r;
                if (d < 1) I *= 0.10;                    // a hard umbra: the fit must ignore it
            }
            rgba[o]     = linearToSrgb(I * chroma[0]);
            rgba[o + 1] = linearToSrgb(I * chroma[1]);
            rgba[o + 2] = linearToSrgb(I * chroma[2]);
        }
    }
    return { rgba, size, geom: { cx: 0.5, cy: 0.5, r } };
}

ok('calibrateDisk recovers a planted 2-term limb law and the disk-centre level', () => {
    const f = makeCalFrame({ u1: 0.88, u2: -0.23, I0: 0.82 });
    const c = calibrateDisk(f.rgba, f.size, f.size, f.geom);
    assert.ok(c.ok, 'fit converged');
    assert.ok(Math.abs(c.u1 - 0.88) < 0.05, `u1 ${c.u1}`);
    assert.ok(Math.abs(c.u2 + 0.23) < 0.06, `u2 ${c.u2}`);
    assert.ok(Math.abs(c.I0 - 0.82) / 0.82 < 0.04, `I0 ${c.I0}`);
    // The fitted law reproduces the frame's own profile across the resolved disk.
    for (const mu of [0.35, 0.5, 0.7, 0.9]) {
        const want = limbLaw(mu, 0.88, -0.23), got = limbLaw(mu, c.u1, c.u2);
        assert.ok(Math.abs(got - want) < 0.03, `law at mu=${mu}: ${got} vs ${want}`);
    }
});

ok('sunspots do not bend the fit — the per-shell statistic is a median, not a mean', () => {
    const spots = [{ x: 100, y: 128, r: 13 }, { x: 150, y: 100, r: 10 }];
    const clean = calibrateDisk(...Object.values(makeCalFrame()).slice(0, 1),
        256, 256, { cx: 0.5, cy: 0.5, r: 0.465 });
    const f = makeCalFrame({ spots });
    const c = calibrateDisk(f.rgba, f.size, f.size, f.geom);
    assert.ok(Math.abs(c.u1 - clean.u1) < 0.04, `u1 moved ${clean.u1} → ${c.u1}`);
    assert.ok(Math.abs(c.I0 - clean.I0) / clean.I0 < 0.02, `I0 moved ${clean.I0} → ${c.I0}`);
});

ok('THE DOUBLE-APPLY GATE: a gold-colorized browse frame yields the same law + the same relative structure as its greyscale twin', () => {
    // sdo.gsfc.nasa.gov ships latest_*_HMIIC.jpg gold-colorized; our fixtures
    // are greyscale. Before the calibration, the page applied a fixed warm
    // u_obsTint to BOTH, gilding the gold one twice. The physics the shader
    // consumes — I/(I0·limbLaw(μ)) after dividing chroma out — must be
    // identical for the two.
    const grey = makeCalFrame({ speckle: 0.18 });
    const gold = makeCalFrame({ speckle: 0.18, chroma: [1.19, 0.97, 0.55] });
    const cg = calibrateDisk(grey.rgba, grey.size, grey.size, grey.geom);
    const cc = calibrateDisk(gold.rgba, gold.size, gold.size, gold.geom);

    assert.ok(Math.abs(cg.chroma[0] - 1) < 0.02 && Math.abs(cg.chroma[2] - 1) < 0.02,
        `greyscale chroma ≈ (1,1,1), got ${cg.chroma}`);
    assert.ok(cc.chroma[0] / cc.chroma[2] > 1.7,
        `gold chroma is warm, got ${cc.chroma}`);
    assert.ok(Math.abs(cg.u1 - cc.u1) < 0.05 && Math.abs(cg.u2 - cc.u2) < 0.05,
        `same law: (${cg.u1},${cg.u2}) vs (${cc.u1},${cc.u2})`);

    // The dimensionless field the shader actually draws, sampled on the disk.
    const rel = (f, c, x, y) => {
        const o = (y * f.size + x) * 4;
        const lin = [srgbToLinear(f.rgba[o]), srgbToLinear(f.rgba[o + 1]), srgbToLinear(f.rgba[o + 2])];
        const L = luminance(lin[0] / c.chroma[0], lin[1] / c.chroma[1], lin[2] / c.chroma[2]);
        const dx = x + 0.5 - f.size / 2, dy = y + 0.5 - f.size / 2;
        const mu = Math.sqrt(Math.max(0, 1 - Math.pow(Math.hypot(dx, dy) / (f.geom.r * f.size), 2)));
        return L / (c.I0 * limbLaw(mu, c.u1, c.u2));
    };
    let worst = 0;
    for (const [x, y] of [[128, 128], [100, 140], [160, 110], [128, 90], [95, 128]]) {
        const a = rel(grey, cg, x, y), b = rel(gold, cc, x, y);
        worst = Math.max(worst, Math.abs(a - b) / a);
        assert.ok(Math.abs(a - 1) < 0.35, `quiet-disk contrast near 1, got ${a}`);
    }
    assert.ok(worst < 0.03, `colorization must not change the physics, worst ${worst}`);
});

ok('limb BRIGHTENING (AIA) fits negative — one machinery covers both instruments', () => {
    const f = makeCalFrame({ u1: -0.55, u2: -0.40, r: 0.390 });
    const c = calibrateDisk(f.rgba, f.size, f.size, { cx: 0.5, cy: 0.5, r: 0.390 });
    assert.ok(c.u1 < -0.3, `u1 negative, got ${c.u1}`);
    assert.ok(limbLaw(0.25, c.u1, c.u2) > limbLaw(0.95, c.u1, c.u2), 'brighter toward the limb');
});

ok('calibrateDisk degrades instead of dividing by zero: black frame, tiny disk, missing pixels', () => {
    const black = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    const c1 = calibrateDisk(black, 64, 64, { cx: 0.5, cy: 0.5, r: 0.465 });
    assert.equal(c1.ok, false);
    assert.equal(c1.I0, 1);                       // the no-op fallback, never 0
    assert.deepEqual(c1.chroma, [1, 1, 1]);
    const c2 = calibrateDisk(black, 64, 64, { cx: 0.5, cy: 0.5, r: 0.001 });
    assert.equal(c2.ok, false);
    assert.ok(Number.isFinite(c2.I0) && c2.I0 > 0);
});

ok('sigma reports the frame’s own resolved contrast (a speckled frame reads higher than a smooth one)', () => {
    const smooth = makeCalFrame({ speckle: 0 });
    const rough  = makeCalFrame({ speckle: 0.30 });
    const cs = calibrateDisk(smooth.rgba, smooth.size, smooth.size, smooth.geom);
    const cr = calibrateDisk(rough.rgba,  rough.size,  rough.size,  rough.geom);
    assert.ok(cs.sigma < 0.03, `smooth sigma ${cs.sigma}`);
    assert.ok(cr.sigma > cs.sigma * 2, `rough sigma ${cr.sigma} vs ${cs.sigma}`);
});

ok('srgbToLinear / linearToSrgb round-trip within a byte', () => {
    for (const b of [0, 1, 12, 55, 128, 200, 254, 255]) {
        assert.ok(Math.abs(linearToSrgb(srgbToLinear(b)) - b) <= 1, `byte ${b}`);
    }
});

console.log(`\n${passed} checks passed`);
