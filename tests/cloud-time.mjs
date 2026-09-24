/**
 * cloud-time.mjs — contract tests for js/cloud-time.js.
 *
 * Pins the five mosaic modes, the weight schedule, the flow-map phase
 * identities, the sphere advection (tangency + magnitude against a hand
 * calculation), and that the shader constants really are interpolated
 * from FLOW (the GLSL cannot be run here; drift between the JS mirror and
 * the shader is the failure this guards).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    MOSAIC, FLOW, R_EARTH_M,
    resolveMosaicTime, mosaicWeight, latestFrameMs, floorToCadence,
    flowPhase, windGainAt, tangentFrame, advectDirection, clampedLeadSec,
    describeMosaicMode,
} from '../js/cloud-time.js';

// cloud-volume.js imports three (browser importmap only), so the shader is
// read as TEXT here: the assertion is that its constants are INTERPOLATED
// from FLOW / R_EARTH_M, never re-typed. The GLSL itself is compiled by the
// browser gate (tests/cloud-timeline.spec.js).
const VOLUME_SRC = readFileSync(new URL('../js/cloud-volume.js', import.meta.url), 'utf8');

const H = 3_600_000, M = 60_000;
const now = Date.UTC(2026, 8, 23, 16, 17, 43);   // 2026-09-23T16:17:43Z

// ── Cadence helpers ──────────────────────────────────────────────────────────
assert.equal(floorToCadence(now), Date.UTC(2026, 8, 23, 16, 10));
// latest = floor(now − 20 min) to 10 min = 15:50
assert.equal(latestFrameMs(now), Date.UTC(2026, 8, 23, 15, 50));

// ── The five modes ───────────────────────────────────────────────────────────
const live = resolveMosaicTime({ simTimeMs: now, nowMs: now });
assert.equal(live.mode, 'live');
assert.equal(live.frameMs, Date.UTC(2026, 8, 23, 15, 50));
assert.equal(live.weight, 1);
assert.equal(live.key, '2026-09-23T15:50Z');

// Slightly in the past but within one cadence of the newest frame is still live.
assert.equal(resolveMosaicTime({ simTimeMs: now - 25 * M, nowMs: now }).mode, 'live');

const replay = resolveMosaicTime({ simTimeMs: now - 3 * H, nowMs: now });
assert.equal(replay.mode, 'replay');
// 13:17:43 floors to 13:10
assert.equal(replay.frameMs, Date.UTC(2026, 8, 23, 13, 10));
assert.equal(replay.weight, 1);
assert.ok(replay.leadMs > 0 && replay.leadMs < 10 * M, 'replay lead is within one cadence');

const nowcast = resolveMosaicTime({ simTimeMs: now + 1 * H, nowMs: now });
assert.equal(nowcast.mode, 'nowcast');
assert.equal(nowcast.frameMs, live.frameMs, 'nowcast advects the NEWEST observed frame');
assert.ok(nowcast.leadMs > H, 'lead is measured from the frame, not from wall clock');
assert.ok(nowcast.weight < 1 && nowcast.weight > 0.35);

const edge = resolveMosaicTime({ simTimeMs: live.frameMs + MOSAIC.nowcastMaxMs, nowMs: now });
assert.equal(edge.mode, 'nowcast');
assert.ok(Math.abs(edge.weight - 0.35) < 1e-9, 'weight floors at 0.35 at the horizon');

const model = resolveMosaicTime({ simTimeMs: now + 6 * H, nowMs: now });
assert.equal(model.mode, 'model');
assert.equal(model.frameMs, null);
assert.equal(model.weight, 0);

const gone = resolveMosaicTime({ simTimeMs: now - MOSAIC.retentionMs - H, nowMs: now });
assert.equal(gone.mode, 'unavailable');
assert.equal(gone.weight, 0);

// The time bus's whole −7 d window must resolve to real replay frames.
assert.equal(resolveMosaicTime({ simTimeMs: now - 7 * 24 * H, nowMs: now }).mode, 'replay');

// ── Weight schedule ──────────────────────────────────────────────────────────
assert.equal(mosaicWeight('live'), 1);
assert.equal(mosaicWeight('replay', 5 * M), 1);
assert.equal(mosaicWeight('model'), 0);
assert.equal(mosaicWeight('unavailable'), 0);
{
    let prev = 1;
    for (let lead = 0; lead <= MOSAIC.nowcastMaxMs; lead += 10 * M) {
        const w = mosaicWeight('nowcast', lead);
        assert.ok(w <= prev + 1e-12, 'nowcast weight is monotone non-increasing in lead');
        prev = w;
    }
}

// ── Flow-map phase identities ────────────────────────────────────────────────
{
    const T = FLOW.periodSec;
    const a = flowPhase(0, T);
    assert.ok(Math.abs(a.p0) < 1e-12 && Math.abs(a.w - 1) < 1e-12, 'A resets under full B weight');
    const b = flowPhase(T / 2, T);
    assert.ok(Math.abs(b.p1) < 1e-12 && Math.abs(b.w) < 1e-12, 'B resets under full A weight');
    // Periodicity and the half-period offset.
    const c = flowPhase(1234.5, T), d = flowPhase(1234.5 + 3 * T, T);
    assert.ok(Math.abs(c.p0 - d.p0) < 1e-9 && Math.abs(c.w - d.w) < 1e-9);
    assert.ok(Math.abs(((c.p0 + 0.5) % 1) - c.p1) < 1e-9);
    // Negative sim time (scrubbed before the epoch) stays in [0,1).
    const e = flowPhase(-0.25 * T, T);
    assert.ok(e.p0 >= 0 && e.p0 < 1 && Math.abs(e.p0 - 0.75) < 1e-9);
}

// ── Wind gain ────────────────────────────────────────────────────────────────
assert.equal(windGainAt(0), 1);
assert.ok(Math.abs(windGainAt(FLOW.windGainTopKm) - (1 + FLOW.windGainAloft)) < 1e-12);
assert.ok(Math.abs(windGainAt(99) - (1 + FLOW.windGainAloft)) < 1e-12, 'clamped above the top');
assert.ok(windGainAt(3) > 1 && windGainAt(3) < windGainAt(6));

// ── Tangent frame + advection ────────────────────────────────────────────────
{
    // Lon 0, lat 0 → n = (1,0,0). East is −Z (lon increases toward −Z per
    // latLonToNormal), north is +Y.
    const n = [1, 0, 0];
    const { east, north } = tangentFrame(n);
    const r9 = (v) => Math.round(v * 1e9) / 1e9 + 0;   // + 0 folds −0 into 0
    assert.deepEqual(east.map(r9), [0, 0, -1]);
    assert.deepEqual(north.map(r9), [0, 1, 0]);

    // 20 m/s eastward for an hour = 72 km = 0.011301 rad. Upstream sampling
    // means the returned direction lies WEST (toward +Z) of n.
    const up = advectDirection(n, 20, 0, 3600);
    const ang = Math.acos(Math.min(1, up[0] * n[0] + up[1] * n[1] + up[2] * n[2]));
    assert.ok(Math.abs(ang - 72_000 / R_EARTH_M) < 1e-6, `advection angle ${ang}`);
    assert.ok(up[2] > 0, 'upstream of an eastward wind is west');
    assert.ok(Math.abs(Math.hypot(...up) - 1) < 1e-12, 'stays a unit vector');

    // Northward wind at the equator moves the upstream point south.
    const upN = advectDirection(n, 0, 20, 3600);
    assert.ok(upN[1] < 0);

    // Negative lead advects downstream; gain scales the angle linearly.
    const dn = advectDirection(n, 20, 0, -3600);
    assert.ok(dn[2] < 0);
    // (first-order: the displacement is a tangent, so the angle is
    // atan(|d|) — compare in tangent space, where doubling is exact)
    const g2 = advectDirection(n, 20, 0, 3600, 2);
    const ang2 = Math.acos(Math.min(1, g2[0]));
    assert.ok(Math.abs(Math.tan(ang2) - 2 * Math.tan(ang)) < 1e-9);

    // Pole: no NaNs.
    const pole = advectDirection([0, 1, 0], 10, 10, 3600);
    assert.ok(pole.every(Number.isFinite));
}

// ── Lead clamp ───────────────────────────────────────────────────────────────
assert.equal(clampedLeadSec(now, now - 30 * M), 1800);
assert.equal(clampedLeadSec(now, now - 2 * 24 * H), MOSAIC.leadClampMs / 1000);
assert.equal(clampedLeadSec(now, now + 2 * 24 * H), -MOSAIC.leadClampMs / 1000);
assert.equal(clampedLeadSec(now, null), 0);

// ── Disclosure strings say which mode ────────────────────────────────────────
assert.match(describeMosaicMode(live),    /live/);
assert.match(describeMosaicMode(replay),  /replay/);
assert.match(describeMosaicMode(nowcast), /Nowcast.*advected/);
assert.match(describeMosaicMode(model),   /Model cloud only/);
assert.match(describeMosaicMode(gone),    /no observed frame/);

// ── The shader carries THESE constants, not a re-typed copy ──────────────────
for (const expr of [
    'FLOW.periodSec.toFixed(1)',
    'FLOW.morphRatePerSec.toExponential(6)',
    'FLOW.windGainAloft.toFixed(3)',
    'FLOW.windGainTopKm.toFixed(2)',
    'R_EARTH_M.toFixed(1)',
]) {
    assert.ok(VOLUME_SRC.includes('${' + expr + '}'), `VOLUME_FRAG interpolates ${expr}`);
}
assert.ok(VOLUME_SRC.includes("from './cloud-time.js'"), 'cloud-volume imports the ONE time kernel');

console.log('cloud-time: all assertions passed');
