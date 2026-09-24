/**
 * cloud-source.mjs — node gate for tests/helpers/cloud-source.mjs: the PNG
 * round trip the live gate's pixel measures depend on, the disc statistics,
 * and the fixture picker's "same layer, nearest time, never another day"
 * rule. (The mode switch itself is exercised by the browser gates.)
 */
import assert from 'node:assert/strict';
import {
    encodePng, decodePng, rectStats, rectDiff, discRect, pickFixture, resolveCloudSource,
} from './helpers/cloud-source.mjs';

// ── PNG encode → decode is lossless ──────────────────────────────────────────
{
    const W = 37, H = 19;   // odd sizes: no accidental alignment
    const src = encodePng(W, H, (i, j) => [(i * 7) & 255, (j * 13) & 255, (i ^ j) & 255, 255 - ((i + j) & 63)]);
    const img = decodePng(src);
    assert.equal(img.width, W); assert.equal(img.height, H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const o = (j * W + i) * 4;
        assert.deepEqual([...img.data.subarray(o, o + 4)], [(i * 7) & 255, (j * 13) & 255, (i ^ j) & 255, 255 - ((i + j) & 63)]);
    }
}

// ── Disc statistics ──────────────────────────────────────────────────────────
{
    const W = 40, H = 30;
    const white = decodePng(encodePng(W, H, () => [240, 240, 240, 255]));
    const blue  = decodePng(encodePng(W, H, () => [20, 40, 160, 255]));
    const half  = decodePng(encodePng(W, H, (i) => i < W / 2 ? [240, 240, 240, 255] : [20, 40, 160, 255]));
    const rect  = { x0: 0, y0: 0, x1: W, y1: H };
    assert.equal(rectStats(white, rect).cloudFrac, 1, 'white is cloud');
    assert.equal(rectStats(blue, rect).cloudFrac, 0, 'saturated blue is not cloud');
    assert.ok(Math.abs(rectStats(half, rect).cloudFrac - 0.5) < 1e-9);
    assert.ok(rectStats(white, rect).meanLum > rectStats(blue, rect).meanLum);
    assert.equal(rectDiff(white, white, rect), 0);
    assert.ok(rectDiff(white, blue, rect) > 100);
    const d = discRect(1280, 720, 0.5);
    assert.deepEqual(d, { x0: 320, y0: 180, x1: 960, y1: 540 });
}

// ── Fixture picker ───────────────────────────────────────────────────────────
{
    const L = 'GOES-East_ABI_Band13_Clean_Infrared_Brightness_Temperature';
    const t = (h) => Date.UTC(2026, 8, 23, h, 0);
    const manifest = { frames: [
        { layerId: L, time: '2026-09-23T12:00:00Z', timestampMs: t(12), file: 'a.png' },
        { layerId: L, time: '2026-09-23T15:00:00Z', timestampMs: t(15), file: 'b.png' },
        { layerId: 'Other', time: '2026-09-23T13:00:00Z', timestampMs: t(13), file: 'c.png' },
    ] };
    assert.equal(pickFixture(manifest, L, '2026-09-23T13:20:00Z').file, 'a.png', 'nearest in time');
    assert.equal(pickFixture(manifest, L, '2026-09-23T14:50:00Z').file, 'b.png');
    assert.equal(pickFixture(manifest, 'Missing', '2026-09-23T13:20:00Z'), null, 'other layers never stand in');
    assert.equal(pickFixture(manifest, L, '2026-09-25T12:00:00Z'), null, 'a frame from another day is not that time');
    assert.equal(pickFixture(manifest, L, '2026-09-23').file, 'a.png', 'date-only resolves against noon');
}

// ── Mode switch (this sandbox: synthetic unless a manifest was fetched) ───────
{
    const s = resolveCloudSource();
    assert.ok(['live', 'fixture', 'synthetic'].includes(s.mode));
    if (process.env.CLOUD_LIVE === '1') assert.equal(s.mode, 'live');
}

console.log('cloud-source: all assertions passed');
