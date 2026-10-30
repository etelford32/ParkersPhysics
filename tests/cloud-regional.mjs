/**
 * cloud-regional.mjs — Tier B of the cloud LOD ladder (the regional window)
 * ═══════════════════════════════════════════════════════════════════════════
 * Pins the PURE half in js/cloud-mosaic-core.js (planRegionalDetail, the
 * span ladder, disc coverage, the bounded MosaicAccumulator, the GLSL) and
 * the sequencing in js/cloud-regional.js (one instant, camera-settled). The
 * browser half — the window drawn the right way up, finer than the global
 * frame, and the antimeridian seam gone — is tests/earth-regional-lod.spec.js.
 *
 * Run: node tests/cloud-regional.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    planRegionalDetail, ladderSpanDeg, discCoversBounds, boundsNeedPolarFill,
    MosaicAccumulator, GLOBAL_BOUNDS, REGIONAL_DETAIL, SAT_DETAIL_GLSL, discWeight,
} from '../js/cloud-mosaic-core.js';
import { GEO_GLSL } from '../js/geo/coords.glsl.js';
import { RegionalCloudDetail } from '../js/cloud-regional.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const fp = (centerLat, centerLon, spanLatDeg, spanLonDeg = spanLatDeg) =>
    ({ centerLat, centerLon, spanLatDeg, spanLonDeg });

// ── 1. Activation and the span ladder ──────────────────────────────────────
ok(planRegionalDetail(fp(38, -98, 46)) === null, 'no window above the 45° activation span');
ok(planRegionalDetail(fp(38, -98, 45)) !== null, 'a window at the activation span');
ok(planRegionalDetail(null) === null && planRegionalDetail({}) === null, 'no footprint, no window');
for (const x of [0.5, 3, 4, 7.3, 13, 29, 44]) {
    const s = ladderSpanDeg(x);
    ok(s >= Math.max(x, REGIONAL_DETAIL.minSpanDeg) - 1e-9, `ladder never shrinks a span (${x} → ${s.toFixed(3)})`);
    ok(s < Math.max(x, REGIONAL_DETAIL.minSpanDeg) * Math.SQRT2 + 1e-9, `ladder rounds up by < √2 (${x})`);
}
{
    // Slow zoom: spans within one √2 rung share the same window size.
    // 12.5° and 13.2° × the 1.26 margin both round up to the 16.97° rung.
    const a = planRegionalDetail(fp(38, -98, 12.5, 28)), b = planRegionalDetail(fp(38, -98, 13.2, 29.5));
    ok(a.bounds.latSpan === b.bounds.latSpan && a.bounds.lonSpan === b.bounds.lonSpan, 'a slow zoom inside one rung reuses the window span');
    // Small pan: the centre snaps to a quarter-window grid, so a pan of less
    // than half a grid cell from a grid point is the same window. (Any snap
    // has cell edges somewhere; this pins the cell, not a lucky pan.)
    const sLat = a.bounds.latSpan * REGIONAL_DETAIL.snapFrac, sLon = a.bounds.lonSpan * REGIONAL_DETAIL.snapFrac;
    const c0 = planRegionalDetail(fp(9 * sLat, -12 * sLon, 13, 29));
    const c1 = planRegionalDetail(fp(9 * sLat + 0.45 * sLat, -12 * sLon - 0.45 * sLon, 13, 29));
    ok(c0.key === c1.key, 'a pan under half a snap cell reuses the window');
    const c2 = planRegionalDetail(fp(9 * sLat + 0.55 * sLat, -12 * sLon, 13, 29));
    ok(c2.key !== c0.key, 'a pan past half a snap cell re-plans');
}

// ── 2. What the camera SHOWS lies in the window's full-weight interior ─────
// The footprint is focus-footprint's overscanned box; the viewport is that ÷
// its SPAN_MARGIN. The window fades over the outer insetWeight band, and the
// snap moves its centre — the viewport must clear both, at every snap phase.
{
    const ffSrc = readFileSync(new URL('../js/focus-footprint.js', import.meta.url), 'utf8');
    const insetSrc = readFileSync(new URL('../js/geo/inset.glsl.js', import.meta.url), 'utf8');
    ok(Number(ffSrc.match(/const SPAN_MARGIN = ([\d.]+)/)?.[1]) === REGIONAL_DETAIL.footprintOverscan,
        'footprintOverscan mirrors focus-footprint SPAN_MARGIN');
    ok(insetSrc.includes(`smoothstep(0.0, ${REGIONAL_DETAIL.featherFrac.toFixed(2)},`),
        'featherFrac mirrors insetWeight\'s feather');
}
const F = REGIONAL_DETAIL.featherFrac;
for (const [lat0, lon0, sLat, sLon] of [[38, -98, 13, 29], [-33, 151, 8, 11], [62, 10, 30, 64], [0, 0, 4, 7], [-50, -60, 20, 31], [20, 178, 10, 12]]) {
    for (let k = 0; k < 7; k++) {            // sweep the centre through snap phases
        const lat = lat0 + k * 0.37, lon = lon0 + k * 0.53;
        const p = planRegionalDetail(fp(lat, lon, sLat, sLon));
        const b = p.bounds;
        const vLat = sLat / REGIONAL_DETAIL.footprintOverscan, vLon = sLon / REGIONAL_DETAIL.footprintOverscan;
        const inner = (x, lo, span) => x >= lo + F * span - 1e-6 && x <= lo + (1 - F) * span + 1e-6;
        const lonOff = (x) => ((x - b.lonMin) % 360 + 360) % 360;
        const latOk = (lat - vLat / 2 <= -90 || inner(lat - vLat / 2, b.latMin, b.latSpan) || b.latMin <= -90 + 1e-9)
                   && (lat + vLat / 2 >= 90 || inner(lat + vLat / 2, b.latMin, b.latSpan) || b.latMin + b.latSpan >= 90 - 1e-9);
        const lonOk = inner(lonOff(lon - vLon / 2), 0, b.lonSpan) && inner(lonOff(lon + vLon / 2), 0, b.lonSpan);
        ok(latOk && lonOk, `(${lat.toFixed(2)},${lon.toFixed(2)}) the viewport sits in the full-weight interior`);
    }
}
for (const [lat, lon, sLat, sLon] of [[38, -98, 13, 29], [-33, 151, 8, 11], [62, 10, 30, 64], [0, 0, 4, 7], [-70, -60, 20, 60]]) {
    const p = planRegionalDetail(fp(lat, lon, sLat, sLon));
    const b = p.bounds;
    ok(p.degPerPx >= REGIONAL_DETAIL.nativeDegPerPx - 1e-12, 'never finer than the 2 km IR band');
    ok(p.width <= REGIONAL_DETAIL.maxPx && p.height <= REGIONAL_DETAIL.maxPx, 'within the per-axis pixel budget');
    ok(Math.abs(p.width * p.degPerPx - b.lonSpan) <= p.degPerPx && Math.abs(p.height * p.degPerPx - b.latSpan) <= p.degPerPx,
        'square texels: one degree-per-pixel on both axes');
    ok(b.latMin >= -90 && b.latMin + b.latSpan <= 90 + 1e-9 && b.lonMin >= -180 && b.lonMin < 180, 'bounds in range');
}
{
    const p = planRegionalDetail(fp(38, -98, 13, 29));
    ok(p.degPerPx * 111.195 <= 2.7, `a Kansas-sized view is near the instrument's 2 km (${(p.degPerPx * 111.195).toFixed(2)} km/px vs 20 km global)`);
}

// ── 3. The antimeridian: two segments, one image ───────────────────────────
{
    const p = planRegionalDetail(fp(20, 178, 10, 12));
    ok(p.segments.length === 2, 'a window over the dateline is fetched as two BBOXes');
    const [a, b] = p.segments;
    ok(a.lonMax === 180 && b.lonMin === -180, 'split exactly at ±180°');
    ok(a.x0 === 0 && b.x0 === a.w && a.w + b.w === p.width, 'segments tile the image side by side');
    ok(Math.abs((a.lonMax - a.lonMin) / a.w - (b.lonMax - b.lonMin) / b.w) < 0.002, 'both segments at the same degree-per-pixel');
    ok(Math.abs((180 - p.bounds.lonMin) + (b.lonMax + 180) - p.bounds.lonSpan) < 1e-6, 'segments add up to the window');
    const q = planRegionalDetail(fp(20, 100, 10, 12));
    ok(q.segments.length === 1 && q.segments[0].lonMax === q.bounds.lonMin + q.bounds.lonSpan, 'an ordinary window is one BBOX');
}

// ── 4. Which sources a window fetches ──────────────────────────────────────
{
    const kansas = planRegionalDetail(fp(38, -98, 13, 29)).bounds;
    ok(discCoversBounds(kansas, -75.2) && discCoversBounds(kansas, -137.2), 'GOES-East and -West both see Kansas');
    ok(!discCoversBounds(kansas, 140.7), 'Himawari cannot see Kansas — not fetched');
    ok(!boundsNeedPolarFill(kansas), 'no polar fill for mid-latitudes');
    const norway = planRegionalDetail(fp(66, 10, 20, 50)).bounds;
    ok(boundsNeedPolarFill(norway), 'the polar fill joins poleward of 55°');
    ok(discCoversBounds(kansas, null), 'a source with no disc (fill) always qualifies');
}

// ── 5. The bounded accumulator: global is bit-identical, regional is in place
{
    const W = 64, H = 32;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { const v = (i * 37) % 256; rgba.set([v, v, v, 255], i * 4); }
    const a = new MosaicAccumulator(W, H);
    const b = new MosaicAccumulator(W, H, GLOBAL_BOUNDS);
    a.addRegion(rgba, 'ir', -75.2, 'primary', 3);
    b.addRegion(rgba, 'ir', -75.2, 'primary', 3);
    const da = a.finalize().data, db = b.finalize().data;
    ok(da.every((v, i) => v === db[i]), 'explicit GLOBAL_BOUNDS is bit-identical to the old global grid');

    // A regional box: a pixel's weight is the disc weight at ITS lat/lon.
    const bounds = { lonMin: 170, latMin: 10, lonSpan: 20, latSpan: 10 };   // straddles 180°
    const r = new MosaicAccumulator(W, H, bounds);
    const lat0 = bounds.latMin + bounds.latSpan - (0.5 * bounds.latSpan) / H;
    const lonLast = bounds.lonMin + ((W - 0.5) * bounds.lonSpan) / W;
    ok(Math.abs(Math.acos(r._cosLat[0]) * 180 / Math.PI - lat0) < 1e-4, 'row 0 is the box NORTH edge');
    ok(Math.abs(r._lon[W - 1] - lonLast) < 1e-4 && lonLast > 180, 'columns run past +180° across the dateline');
    const dLon = ((lonLast - 140.7 + 540) % 360) - 180;
    ok(discWeight(r._cosLat[0], dLon) > 0, 'Himawari weights a pixel just past the dateline (dLon wrap)');
}

// ── 6. The GLSL ─────────────────────────────────────────────────────────────
ok(/vec4 sampleSat\(vec3 n\)/.test(SAT_DETAIL_GLSL), 'SAT_DETAIL_GLSL defines sampleSat');
ok(SAT_DETAIL_GLSL.includes('normalToUVMip(n)'), 'the global frame is read through the seam-safe UV');
ok(SAT_DETAIL_GLSL.includes('insetUV(normalToUV(n), u_sat_detail_bounds)') && SAT_DETAIL_GLSL.includes('insetWeight(uvP)'),
    'the window rides the shared inset UV + feather (v = 0 at latMin)');
ok(!SAT_DETAIL_GLSL.includes('`'), 'no backtick inside the GLSL literal');
{
    const m = GEO_GLSL.match(/vec2 normalToUVMip\(vec3 n\) \{([\s\S]*?)\n    \}/);
    ok(!!m, 'GEO_GLSL defines normalToUVMip');
    const body = m[1];
    ok(/#ifdef GEO_SEAMLESS[\s\S]*fwidth[\s\S]*#endif/.test(body), 'fwidth only under GEO_SEAMLESS (WebGL1 pages compile unchanged)');
    ok(body.includes('fract(uv.x + 0.5) - 0.5'), "Tarini's continuous-at-the-antimeridian branch");
}

// ── 7. The controller: one instant, camera-settled ─────────────────────────
{
    const uniforms = {
        u_sat_detail: { value: null },
        u_sat_detail_bounds: { value: { set(...a) { this.v = a; } } },
        u_sat_detail_on: { value: 0 },
    };
    const calls = [];
    const fakeTex = (tag) => ({ tag, isDataTexture: true, image: { width: 8 }, disposed: false, dispose() { this.disposed = true; } });
    const pending = [];          // resolvers, oldest first
    const release = () => pending.shift()?.();
    const made = [];
    const ctl = new RegionalCloudDetail({
        THREE: {}, uniforms, settleMs: 0,
        fetch: async (_T, { plan, discs }) => {
            calls.push({ key: plan.key, times: discs.map(d => d.time) });
            await new Promise(r => pending.push(r));
            const tex = fakeTex(plan.key + discs[0].time);
            made.push(tex);
            return { texture: tex, used: discs.map(d => d.name) };
        },
    });
    const tick = () => new Promise(r => setTimeout(r, 5));
    const src = (t) => ({ discs: [{ name: 'GOES-East', layerId: 'GOES-East_ABI_Band13', subLon: -75.2, time: t, ageMin: 0 }], fill: null });

    ctl.setFootprint(fp(38, -98, 13, 29));
    await tick();
    ok(calls.length === 0, 'no sources yet → nothing fetched');
    ctl.setSources(src('T1'));
    await tick();
    ok(calls.length === 1 && calls[0].times[0] === 'T1', 'fetches the GLOBAL frame\'s own source time');
    release(); await tick();
    ok(uniforms.u_sat_detail_on.value === 1 && ctl.state().status === 'live', 'window shown once it lands');
    const first = uniforms.u_sat_detail.value;

    // The global frame moves on: the old window must vanish at once.
    ctl.setSources(src('T2'));
    ok(uniforms.u_sat_detail_on.value === 0, 'a new global frame hides the old window IMMEDIATELY (never two instants)');
    await tick();
    ok(calls.length === 2 && calls[1].times[0] === 'T2', 're-fetched for the new frame');
    // …and a response that lands after a newer request was made is dropped.
    ctl.setSources(src('T3'));
    await tick();
    ok(calls.length === 3 && calls[2].times[0] === 'T3', 'the newer frame is requested while T2 is in flight');
    release(); await tick();                        // T2 lands late
    ok(uniforms.u_sat_detail_on.value === 0, 'a superseded (T2) window is never shown');
    ok(made.at(-1).tag.endsWith('T2') && made.at(-1).disposed, '…and its texture is disposed');
    release(); await tick();                        // T3 lands
    ok(uniforms.u_sat_detail_on.value === 1 && uniforms.u_sat_detail.value.tag.endsWith('T3'), 'the newest frame\'s window is the one shown');
    ok(first.disposed, 'replaced windows are disposed');

    // Zoom out past the activation span: window off.
    ctl.setFootprint(fp(38, -98, 60, 100));
    ok(uniforms.u_sat_detail_on.value === 0 && ctl.state().status === 'off', 'zoomed out → no window');
}

console.log(`cloud-regional: ${n} assertions passed`);
