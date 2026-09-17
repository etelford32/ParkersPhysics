/**
 * tests/corona-volumetric.mjs — pins js/corona-loop-density.js (Phase 3)
 *
 *   node tests/corona-volumetric.mjs
 *
 *   • a synthetic semicircular closed loop lights the voxels along its path
 *     (R channel) and nothing far from it; an open line lights G, not R
 *   • the JS trilinear read mirrors the slice-atlas layout the shader uses
 *   • normalisation is per channel at the 99th percentile (bright arcades do
 *     not zero the rest), stray lines are skipped, empty atlases are flagged
 *   • K-corona LOS integral: exact Γ constants, kCoronaLos(1) = 1, monotone,
 *     ~0.05 at 2 R☉ (Baumbach–Allen), F is 10 % of K at the limb and b⁻²·³
 *   • prints the GLSL mirror constants so a diff against coronaFS is one look
 */
import assert from 'node:assert/strict';
import {
    LOOP_DIMS, LOOP_RMAX, TOPOLOGY, META_STRIDE,
    atlasLayout, atlasPixel, shellCoords, rasterizeLoopDensity, sampleLoopDensity, atlasFromPolylines,
    losConst, kCoronaLos, fCoronaLos, kCoronaGlslConstants, F_LIMB_FRACTION,
} from '../js/corona-loop-density.js';
import {
    EUV_CHANNELS, channelResponseAt, N_SPARK_SLOTS, SPARK_R_RSUN, CORONA_VOL_FRAG,
} from '../js/corona-volumetric.js';
import { filamentSpine } from '../js/hek-filaments.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('corona-volumetric.mjs');

function semicircle(radius, lat0 = 0.2, n = 48, topology = TOPOLOGY.CLOSED) {
    // Footpoints at ±radius along x on the surface at latitude lat0, apex height = radius.
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = Math.PI * i / (n - 1);
        const x = radius * Math.cos(a), up = radius * Math.sin(a);
        const base = [x, Math.sin(lat0), Math.cos(lat0)];
        const r = 1 + up;
        pts.push([base[0], base[1] * r, base[2] * r]);
    }
    return { points: pts, topology };
}

ok('layout: 256×128×32 shell → 4×8 tiles = 1024², voxel→pixel is injective', () => {
    const L = atlasLayout(LOOP_DIMS);
    assert.deepEqual([L.tilesX, L.tilesY, L.width, L.height], [4, 8, 1024, 1024]);
    const seen = new Set();
    for (let h = 0; h < 32; h += 3) for (let a = 0; a < 128; a += 13) for (let l = 0; l < 256; l += 29) {
        const [px, py] = atlasPixel(l, a, h, L);
        assert.ok(px >= 0 && px < 1024 && py >= 0 && py < 1024);
        const k = py * 1024 + px; assert.ok(!seen.has(k)); seen.add(k);
    }
});

ok('shell coordinates: √-stretched height resolves 1.5 Mm at slice 1; lon = atan(x, z); outside → null', () => {
    const c = shellCoords([0, 0, 1 + 1.5 / 696], LOOP_DIMS, LOOP_RMAX);     // 1.5 Mm up at disk centre
    assert.ok(c[2] > 0.9 && c[2] < 1.4, `1.5 Mm lands near slice 1 (${c[2].toFixed(2)})`);
    assert.ok(Math.abs(c[0] - (LOOP_DIMS.nlon / 2 - 0.5)) < 1e-9 && Math.abs(c[1] - (LOOP_DIMS.nlat / 2 - 0.5)) < 1e-9, 'disk centre is mid-grid');
    const w = shellCoords([1.2, 0, 0], LOOP_DIMS, LOOP_RMAX);                 // W90
    assert.ok(Math.abs(w[0] - (0.75 * LOOP_DIMS.nlon - 0.5)) < 1e-9, 'W90 → three-quarter longitude');
    assert.equal(shellCoords([0, 0, 0.9], LOOP_DIMS, LOOP_RMAX), null);
    assert.equal(shellCoords([0, 0, 2.6], LOOP_DIMS, LOOP_RMAX), null);
    assert.ok(Math.abs(shellCoords([0, 0, LOOP_RMAX], LOOP_DIMS, LOOP_RMAX)[2] - (LOOP_DIMS.nh - 1)) < 1e-9, 'r_max → last slice');
});

ok('a LOW arcade (apex 0.007 R☉ — the tracer\'s measured AR loops) is resolved, not lost below a voxel', () => {
    const low = semicircle(0.007, 0.26, 48);
    const rast = rasterizeLoopDensity(atlasFromPolylines([low]));
    const [c] = sampleLoopDensity(rast, low.points[24]);
    assert.ok(c > 0.3, `low loop apex density ${c.toFixed(3)}`);
    const [above] = sampleLoopDensity(rast, [low.points[24][0], low.points[24][1] * 1.05, low.points[24][2] * 1.05]);
    assert.ok(above < 0.05, `0.05 R☉ above the loop is dark (${above.toFixed(3)})`);
});

ok('a closed loop lights R along its path and stays dark 0.5 R☉ away; an open line lights G only', () => {
    const loop = semicircle(0.35);
    const open = { points: Array.from({ length: 48 }, (_, i) => [0, -1 - i * 0.03, 0]), topology: TOPOLOGY.OPEN_NEG };
    const rast = rasterizeLoopDensity(atlasFromPolylines([loop, open]));
    assert.equal(rast.empty, false);
    assert.equal(rast.stats.closed, 1); assert.equal(rast.stats.open, 1);
    // Apex of the loop: strong closed density, zero open.
    const apex = loop.points[24];
    const [c, o] = sampleLoopDensity(rast, apex);
    assert.ok(c > 0.3, `apex closed density ${c.toFixed(3)}`);
    assert.equal(o, 0);
    // Half a solar radius off the loop, same height: dark.
    const far = [-apex[0], apex[1], apex[2]].map((v, i) => i === 0 ? v - 0.6 : v);
    assert.ok(sampleLoopDensity(rast, far)[0] < 0.02);
    // Along the open line: G lit, R dark.
    const [c2, o2] = sampleLoopDensity(rast, [0, -1.6, 0]);
    assert.ok(o2 > 0.3 && c2 === 0, `open line: closed ${c2}, open ${o2.toFixed(3)}`);
});

ok('per-channel 99th-percentile normalisation: a dense arcade does not zero a faint loop', () => {
    const dense = Array.from({ length: 20 }, (_, i) => semicircle(0.30 + i * 0.001));   // 20 nearly coincident loops
    const faint = semicircle(0.9, 1.0);                                                   // one polar loop
    const rast = rasterizeLoopDensity(atlasFromPolylines([...dense, faint]));
    const [f] = sampleLoopDensity(rast, faint.points[24]);
    assert.ok(f > 0.05, `faint loop survives normalisation (${f.toFixed(3)})`);
    const [d] = sampleLoopDensity(rast, dense[0].points[24]);
    assert.ok(d >= f, 'dense arcade is at least as bright');
});

ok('stray lines are skipped; an empty or missing atlas yields an empty, all-zero volume', () => {
    const stray = semicircle(0.3, 0, 48, TOPOLOGY.STRAY);
    const r1 = rasterizeLoopDensity(atlasFromPolylines([stray]));
    assert.equal(r1.stats.stray, 1); assert.equal(r1.empty, true);
    assert.ok(r1.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0)));
    const r2 = rasterizeLoopDensity(null);
    assert.equal(r2.empty, true); assert.deepEqual(r2.dims, LOOP_DIMS); assert.equal(r2.rMax, LOOP_RMAX);
});

ok('points outside the volume are ignored (no wrap, no throw)', () => {
    const outside = { points: Array.from({ length: 8 }, (_, i) => [3.0 + i, 0, 0]), topology: TOPOLOGY.CLOSED };
    const rast = rasterizeLoopDensity(atlasFromPolylines([outside]));
    assert.equal(rast.stats.splats, 0);
    assert.deepEqual(sampleLoopDensity(rast, [4, 0, 0]), [0, 0]);
});

ok('LOS constants √π Γ((k−1)/2)/Γ(k/2): 5.2441 (k=1.5), 1.1781 (6), 0.6581 (16)', () => {
    assert.ok(Math.abs(losConst(1.5) - 5.2441) < 1e-3);
    assert.ok(Math.abs(losConst(6) - 1.1781) < 1e-3);
    assert.ok(Math.abs(losConst(16) - 0.6581) < 1e-3);
    assert.ok(Math.abs(losConst(2) - Math.PI) < 1e-9, 'k=2 → π exactly');
});

ok('K-corona: 1 at the limb, monotone decreasing, ≈0.048 at 2 R☉, ≈0.035 at 2.5 R☉', () => {
    assert.equal(kCoronaLos(1), 1);
    let prev = 1;
    for (let b = 1.05; b <= 3; b += 0.05) { const k = kCoronaLos(b); assert.ok(k < prev, `monotone at ${b}`); prev = k; }
    assert.ok(Math.abs(kCoronaLos(2) - 0.048) < 0.003);
    assert.ok(Math.abs(kCoronaLos(2.5) - 0.035) < 0.003);
    assert.equal(kCoronaLos(0.5), 1, 'inside the disk clamps to the limb value');
    assert.equal(kCoronaLos(0), 0);
});

ok('F-corona: 10 % of K at the limb, b⁻²·³', () => {
    assert.equal(fCoronaLos(1), F_LIMB_FRACTION);
    assert.ok(Math.abs(fCoronaLos(2) - 0.1 * Math.pow(2, -2.3)) < 1e-12);
    assert.ok(fCoronaLos(2) < kCoronaLos(2), 'K still dominates at 2 R☉');
});

// ── The channel response table, and the spark DEM term that reads it ──────

ok('channelResponseAt mirrors the GLSL channelResponse, including white light', () => {
    // The shader's version, transcribed:
    //   if (sigT < 1e-3) return 0; d = (logT - peak)/sigT; return exp(-0.5 d²)
    for (const [key, ch] of Object.entries(EUV_CHANNELS)) {
        for (const logT of [4.5, 5.0, 5.85, 6.2, 6.5, 7.0, 7.5]) {
            const glsl = ch.sigma < 1e-3 ? 0 : Math.exp(-0.5 * (((logT - ch.logT) / ch.sigma) ** 2));
            assert.ok(Math.abs(channelResponseAt(logT, key) - glsl) < 1e-12, `${key} @ ${logT}`);
        }
        // Peak response is at the channel's own temperature, and is 1 there.
        if (ch.sigma >= 1e-3) assert.ok(Math.abs(channelResponseAt(ch.logT, key) - 1) < 1e-12);
    }
    // 'white' is the one that matters for the nanoflare layer: a continuum
    // image is not a passband, so there is no response and no campfires.
    assert.equal(channelResponseAt(6.0, 'white'), 0);
    assert.equal(channelResponseAt(6.0, 'nope'), 0, 'an unknown channel is silent, not NaN');
});

ok('the spark DEM term is in the march, gated on closed density, and channel-weighted', () => {
    // These are the three properties that make the sparks better off in the
    // volume than they were as sprites. Asserted against the shader source
    // because there is no GL here — a structural gate, but it is what catches
    // the term being dropped or moved out of demSample.
    assert.match(CORONA_VOL_FRAG, /uniform\s+vec4\s+u_sparks\[12\]/, 'spark slots declared');
    assert.match(CORONA_VOL_FRAG, /uniform\s+vec2\s+u_sparkTP\[12\]/, 'per-spark (logT, radius)');
    assert.match(CORONA_VOL_FRAG, /channelResponse\(u_sparkTP\[k\]\.x\)/, 'weighted by the channel response');
    assert.match(CORONA_VOL_FRAG, /loopGate\s*=\s*\(u_loopOn > 0\.5\)/, 'rides the closed-loop density');
    // The term must live inside demSample, which is what the front-to-back
    // march calls — outside it there is no transmission and no occlusion, and
    // we are back to sprites with extra steps.
    const dem = CORONA_VOL_FRAG.slice(
        CORONA_VOL_FRAG.indexOf('void demSample'), CORONA_VOL_FRAG.indexOf('vec2 raySphere'));
    assert.ok(dem.includes('u_sparks[k]'), 'the spark loop is inside demSample');
    // No atlas ⇒ the gate opens, so offline/CI still draws sparks.
    assert.match(CORONA_VOL_FRAG, /clamp\(ld\.x \* 4\.0, 0\.12, 1\.0\) : 1\.0/, 'analytic fallback keeps them visible');
});

ok('the spark render radius is the march resolution, not the physical size', () => {
    // A 10²⁴ erg event is ~1000 km = 0.0014 R☉; the fine march steps at
    // ~0.03 R☉, so a true-size spark integrates to nothing. The constant must
    // stay of order the step — and it must stay documented as a resolution,
    // because it is not a claim about how big a nanoflare is.
    assert.ok(SPARK_R_RSUN > 0.005 && SPARK_R_RSUN < 0.05,
        `${SPARK_R_RSUN} R☉ is of order the march step`);
    assert.ok(SPARK_R_RSUN > 1000 / 695700, 'larger than the physical size it stands in for');
    assert.ok(N_SPARK_SLOTS >= 8 && N_SPARK_SLOTS <= 32, 'a uniform budget, not a population');
});

// ── The cool-material channel (HEK filaments / prominences) ───────────────

ok('a filament spine lights the COOL channel and nothing else', () => {
    // B is cool material; R and G are field topology. A filament must not
    // light the arcades, and an arcade must not light the filaments.
    const spine = filamentSpine(
        { event_type: 'FI', lat_deg: 0, lon_deg: 0, length_deg: 20, tilt_deg: 0 }, { samples: 16 });
    const rast = rasterizeLoopDensity(null, { coolLines: [{ points: spine, radius: 0.012, weight: 1 }] });
    assert.equal(rast.stats.coolLines, 1);
    assert.equal(rast.empty, false, 'a page with filaments and no field atlas is not empty');
    // ON the spine: cool density present, field channels silent.
    const mid = spine[spine.length >> 1];
    const on = sampleLoopDensity(rast, mid);
    assert.ok(on[2] > 0.5, `cool channel lit on the spine, got ${on[2].toFixed(3)}`);
    assert.equal(on[0], 0, 'closed-field channel untouched');
    assert.equal(on[1], 0, 'open-field channel untouched');
    // A quadrant away: nothing.
    const off = sampleLoopDensity(rast, [0.0, 1.018, 0.0]);
    assert.ok(off[2] < 0.05, `cool channel dark far from the spine, got ${off[2].toFixed(3)}`);
});

ok('the material has THICKNESS — a filament is a tube, not a dotted trail', () => {
    // A zero-width splat aliases into a row of blobs at this grid. Sample
    // ACROSS the spine and require the profile to fall off smoothly rather
    // than being present only at the sample points.
    const spine = filamentSpine(
        { event_type: 'FI', lat_deg: 0, lon_deg: 0, length_deg: 30, tilt_deg: 0 }, { samples: 24 });
    const rast = rasterizeLoopDensity(null, { coolLines: [{ points: spine, radius: 0.012, weight: 1 }] });
    // Walk ALONG the spine between two samples — density must not collapse.
    const a = spine[8], b = spine[9];
    const mids = [];
    for (let t = 0; t <= 1; t += 0.25) {
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        mids.push(sampleLoopDensity(rast, p)[2]);
    }
    const lo = Math.min(...mids), hi = Math.max(...mids);
    assert.ok(lo > 0.4 * hi, `continuous along the spine (min ${lo.toFixed(3)} of max ${hi.toFixed(3)})`);
    // Across the spine the density falls, and is gone by a few tube radii.
    const onAxis = sampleLoopDensity(rast, spine[8])[2];
    const near = sampleLoopDensity(rast, [spine[8][0], spine[8][1] + 0.010, spine[8][2]])[2];
    const far  = sampleLoopDensity(rast, [spine[8][0], spine[8][1] + 0.060, spine[8][2]])[2];
    assert.ok(near < onAxis && near > 0, 'falls off across the spine');
    assert.ok(far < 0.05 * onAxis, 'and is gone a few radii out');
});

ok('cool material and field lines coexist in one texture', () => {
    // The two sources are independent and must not overwrite each other —
    // this is the whole reason they are three channels of one volume.
    const loop = semicircle(0.08, 0.2);
    const spine = filamentSpine(
        { event_type: 'PG', lat_deg: -60, lon_deg: 150, length_deg: 20, tilt_deg: 0 }, { samples: 16 });
    const rast = rasterizeLoopDensity(atlasFromPolylines([loop]), {
        coolLines: [{ points: spine, radius: 0.012, weight: 1 }],
    });
    assert.ok(rast.stats.lines >= 1 && rast.stats.coolLines === 1);
    const atFil = sampleLoopDensity(rast, spine[8]);
    assert.ok(atFil[2] > 0.5 && atFil[0] === 0, 'filament site: cool only');
    const atLoop = sampleLoopDensity(rast, loop.points[Math.floor(loop.points.length / 2)]);
    assert.ok(atLoop[0] > 0.3 && atLoop[2] === 0, 'loop apex: closed field only');
});

ok('a prominence sits higher than an on-disk filament, in the volume too', () => {
    // The kernel places PG higher than FI; the splat has to preserve that or
    // the 304 limb emission and the disk absorption come from the same shell.
    const at = (type) => {
        const spine = filamentSpine({ event_type: type, lat_deg: 0, lon_deg: 0, length_deg: 10 }, { samples: 8 });
        const rast = rasterizeLoopDensity(null, { coolLines: [{ points: spine, radius: 0.012, weight: 1 }] });
        // Probe a column above disk centre and find the brightest height.
        let bestR = 0, best = 0;
        for (let r = 1.001; r < 1.12; r += 0.002) {
            const v = sampleLoopDensity(rast, [0, 0, r])[2];
            if (v > best) { best = v; bestR = r; }
        }
        return bestR;
    };
    const fi = at('FI'), pg = at('PG');
    assert.ok(pg > fi + 0.01, `prominence ${pg.toFixed(3)} sits above filament ${fi.toFixed(3)}`);
});

ok('the shader reads the cool channel and uses it BOTH ways', () => {
    // The one claim the channel makes: the same density absorbs in the coronal
    // channels and emits in 304. If it only did one, it would be a filament
    // OR a prominence, never both, which is the analytic term it replaced.
    assert.match(CORONA_VOL_FRAG, /ld\.z/, 'the third channel is read');
    const dem = CORONA_VOL_FRAG.slice(
        CORONA_VOL_FRAG.indexOf('void demSample'), CORONA_VOL_FRAG.indexOf('vec2 raySphere'));
    assert.match(dem, /fil_density\s*\+=/, 'it feeds the extinction channel');
    assert.match(dem, /channelResponse\(4\.7/, 'and emits at chromospheric temperatures');
});

const g = kCoronaGlslConstants();
console.log('  GLSL mirror (coronaFS): K = ' + g.terms.map(([c, e]) => `${c.toFixed(5)}·b^${e}`).join(' + ') + `; F = ${g.fLimb}·b^${g.fExp}`);
console.log(`\n${passed} checks passed`);
