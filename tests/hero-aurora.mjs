// tests/hero-aurora.mjs — the homepage hero's aurora kernel (js/hero-aurora.js)
//
//   node tests/hero-aurora.mjs
//
// Pins: the IGRF dipole frame in canonical scene axes (and the ECEF→canonical
// rotation against dipole.js's own toDipole); that curtainDirection puts a
// curtain footpoint at exactly the magnetic colatitude it was asked for (the
// frame the ring is computed in IS the frame it is drawn in); that the oval
// recovered from synthetic OVATION grids — a uniform ring, a ring displaced
// toward one side, a ring with a day-side gap — sits where the grid put it;
// the footprint map's orientation; the feed's failure modes; and N_SEG in
// lockstep with the engine's curtain geometry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    dipoleFrame, ecefToCanon, canonToLatLon, curtainDirection, ovationGrid, sampleGrid,
    ovalFromGrid, footprintTexture, auroraProduct, N_SEG, P_FULL, STALE_S,
} from '../js/hero-aurora.js';
import { latLonToNormal } from '../js/hero-earth.js';
import { toDipole, dipoleBasisForYear, decimalYear } from '../js/geomag/dipole.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrap180 = (x) => ((x + 540) % 360) - 180;
const NOW = new Date('2026-09-23T16:00:00Z');
const frame = dipoleFrame(NOW);
const basis = dipoleBasisForYear(decimalYear(NOW));

// ── 1. The frame ───────────────────────────────────────────────────────────
{
    const m = frame.matrix;
    const c = [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) near(dot(c[i], c[j]), i === j ? 1 : 0, 1e-12, `frame c${i}·c${j}`);
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    near(det, 1, 1e-12, 'frame det');
    // The Y column is the IGRF north geomagnetic pole in the canonical frame.
    const pole = latLonToNormal(frame.poleLatDeg, frame.poleLonDeg);
    for (let i = 0; i < 3; i++) near(c[1][i], pole[i], 1e-12, `Y = pole[${i}]`);
    // IGRF-14 at 2026.7: ~80.8°N, ~72.7°W (dipole.js / igrf.js own numbers).
    near(frame.poleLatDeg, 80.8, 0.3, 'pole latitude'); near(frame.poleLonDeg, -72.7, 0.6, 'pole longitude');
    // ecefToCanon is the rotation that ties dipole.js's frame to the scene's:
    // magnetic latitude computed both ways must agree everywhere.
    for (let i = 0; i < 200; i++) {
        const lat = -89 + (i * 37.7) % 178, lon = -180 + (i * 91.3) % 360;
        const viaDipole = toDipole(lat, lon, basis).latDeg;
        const viaFrame = Math.asin(dot(latLonToNormal(lat, lon), c[1])) * 180 / Math.PI;
        near(viaFrame, viaDipole, 1e-9, `mag lat (${lat}, ${lon})`);
    }
    near(dot(ecefToCanon([0, 0, 1]), [0, 1, 0]), 1, 0, 'ECEF north → +Y');
    near(dot(ecefToCanon([0, 1, 0]), [0, 0, -1]), 1, 0, 'ECEF 90°E → −Z');
}

// ── 2. curtainDirection lands at the colatitude it was asked for ──────────
for (const north of [true, false]) {
    for (let k = 0; k < 36; k++) {
        const phi = (k / 36) * 2 * Math.PI;
        for (const th of [8, 19.5, 25, 33]) {
            const ll = canonToLatLon(curtainDirection(frame, phi, th, north));
            const md = toDipole(ll.lat, ll.lon, basis);
            near(md.latDeg, north ? 90 - th : -(90 - th), 1e-9, `curtain colat ${th} (${north ? 'N' : 'S'})`);
            // Azimuth φ is dipole longitude −φ (Z = X × Y = −ŷ_dip) — pinned
            // so a sign flip in either copy fails here, not on screen.
            near(wrap180(md.lonDeg + phi * 180 / Math.PI), 0, 1e-9, `curtain azimuth ↔ dipole lon (${north ? 'N' : 'S'})`);
        }
    }
}

// ── 3. The oval recovered from synthetic OVATION grids ─────────────────────
// Cells are built the way the route builds them: integer [lonEast, lat, prob],
// every 2nd longitude, |lat| ≥ 40, prob ≥ 4 dropped below.
function synthCells(ringLatFn, ampFn) {
    const cells = [];
    for (let lon = 0; lon < 360; lon += 2) {
        for (let lat = -90; lat <= 90; lat++) {
            if (Math.abs(lat) < 40) continue;
            const md = toDipole(lat, lon, basis);
            const hemi = md.latDeg >= 0 ? 1 : -1;
            const ring = hemi * ringLatFn(md.lonDeg, hemi);
            const p = ampFn(md.lonDeg, hemi) * Math.exp(-(((md.latDeg - ring) / 3) ** 2));
            if (p >= 4) cells.push([lon, lat, Math.round(p)]);
        }
    }
    return cells;
}
const colatAt = (oval, k) => oval.colatDeg[k];
{
    // (a) uniform ring: 65° north, 67° south.
    const g = ovationGrid(synthCells((_l, h) => (h > 0 ? 65 : 67), () => 40));
    const n = ovalFromGrid(g, frame, true), s = ovalFromGrid(g, frame, false);
    assert.equal(n.colatDeg.length, N_SEG + 1, 'ring closes: N_SEG + 1 entries');
    assert.equal(n.colatDeg[N_SEG], n.colatDeg[0], 'ring closes on itself');
    near(n.coverage, 1, 0, 'uniform ring: every azimuth has an oval');
    for (let k = 0; k < N_SEG; k += 5) {
        near(colatAt(n, k), 25, 0.6, `N uniform colat @${k}`);
        near(colatAt(s, k), 23, 0.6, `S uniform colat @${k}`);
        near(n.intensity[k], 1, 1e-6, 'p = 40 % > P_FULL saturates');
    }
    near(n.meanColatDeg, 25, 0.5, 'mean colat');
}
{
    // (b) ring displaced toward dipole longitude 0 (the kind of shift the
    // night side makes): ringLat = 65 − 4·cos(dlon). Curtain azimuth φ is
    // dipole longitude −φ, so the recovered colatitude is 25 + 4·cos(φ).
    const g = ovationGrid(synthCells((dl) => 65 - 4 * Math.cos(dl * Math.PI / 180), () => 40));
    const n = ovalFromGrid(g, frame, true);
    for (let k = 0; k < N_SEG; k += 10) {
        const phi = (k / N_SEG) * 2 * Math.PI;
        near(colatAt(n, k), 25 + 4 * Math.cos(phi), 1.0, `displaced ring colat @φ=${(phi * 180 / Math.PI).toFixed(0)}°`);
    }
}
{
    // (c) intensity follows the grid, and a day-side gap goes dark but keeps
    // a continuous ring (filled colatitude).
    const amp = (dl) => {
        const a = Math.abs(wrap180(dl));
        return a > 120 ? 0 : 5 + 20 * Math.cos(a * Math.PI / 240);   // 25 % at dlon 0 → 5 % at ±120°
    };
    const g = ovationGrid(synthCells(() => 65, amp));
    const n = ovalFromGrid(g, frame, true);
    const kAt = (dlon) => Math.round((((-dlon % 360) + 360) % 360) / 360 * N_SEG) % N_SEG;   // φ = −dlon
    assert.ok(n.intensity[kAt(0)] > 0.8, `bright where p ≈ 25 %: ${n.intensity[kAt(0)]}`);
    assert.ok(n.intensity[kAt(90)] < n.intensity[kAt(0)], 'dimmer toward the flanks');
    assert.ok(n.intensity[kAt(180)] < 0.05, `dark in the gap: ${n.intensity[kAt(180)]}`);
    assert.ok(Number.isFinite(colatAt(n, kAt(180))), 'gap keeps a finite colatitude');
    near(colatAt(n, kAt(180)), 25, 1.5, 'gap colatitude interpolated from the oval');
    assert.ok(n.coverage > 0.5 && n.coverage < 0.8, `coverage ${n.coverage}`);
    near(n.intensity[kAt(0)], Math.sqrt(Math.min(1, n.peakProb / P_FULL)), 0.08, 'display stretch √(p/P_FULL)');
}

// ── 4. Grid details: stride fill, sampling ────────────────────────────────
{
    const g = ovationGrid([[10, 70, 20], [12, 70, 30], [358, 70, 10], [0, 70, 30]]);
    near(sampleGrid(g, 70, 11), 25, 1e-6, 'odd column filled from both neighbours');
    near(sampleGrid(g, 70, 359), 20, 1e-6, 'fill wraps the antimeridian');
    near(sampleGrid(g, 70, 13), 0, 1e-6, 'no extrapolation past an edge');
    near(sampleGrid(g, 70, 10.5), 22.5, 1e-6, 'bilinear in longitude');
}

// ── 5. Footprint map orientation (canonical UV) ────────────────────────────
{
    const g = ovationGrid(synthCells(() => 65, () => 40));
    const tex = footprintTexture(g, 360, 180);
    assert.equal(tex.length, 360 * 180);
    const texel = (lat, lon) => tex[Math.floor((90 - lat) / 180 * 180) * 360 + Math.floor((lon + 180) / 360 * 360)];
    // A point ON the ring, found through the frame: must be bright.
    const on = canonToLatLon(curtainDirection(frame, 0.3, 25, true));
    assert.ok(texel(on.lat, on.lon) > 200, `on-ring texel ${texel(on.lat, on.lon)}`);
    assert.equal(texel(0, 0), 0, 'equator dark');
    // A north–south FLIP of the map would put the northern ring point on its
    // mirror latitude, which (the dipole being tilted toward 72.7°W, the
    // south pole toward 107.3°E) is not on the southern ring there.
    assert.ok(texel(-on.lat, on.lon) < 60, `mirror of the ring point is dark: ${texel(-on.lat, on.lon)}`);
    // Row 0 is NORTH: the northern ring's texels sit in the top half.
    let top = 0, bottom = 0;
    for (let r = 0; r < 180; r++) for (let c = 0; c < 360; c++) {
        const v = tex[r * 360 + c];
        if (r < 30) top += v; else if (r >= 150) bottom += v;
    }
    assert.ok(top > 0 && bottom > 0, 'both ovals present in the map');
}

// ── 6. The feed's failure modes ────────────────────────────────────────────
{
    assert.deepEqual(auroraProduct(null, NOW), { ok: false, reason: 'malformed' });
    assert.deepEqual(auroraProduct({ data: {} }, NOW), { ok: false, reason: 'malformed' });
    assert.deepEqual(auroraProduct({ data: { cells: [] } }, NOW), { ok: false, reason: 'empty' });
    const cells = synthCells(() => 65, () => 40);
    const old = new Date(NOW.getTime() - (STALE_S + 60) * 1000).toISOString();
    assert.deepEqual(auroraProduct({ data: { cells, updated: old } }, NOW), { ok: false, reason: 'stale' });
    assert.deepEqual(auroraProduct({ data: { cells: [[0, 45, 4]], updated: NOW.toISOString() } }, NOW),
        { ok: false, reason: 'no-oval' }, 'a lone sub-threshold cell is not an oval');
    const ok = auroraProduct({ data: { cells, updated: NOW.toISOString(), north_gw: 12.5, south_gw: 9 } }, NOW);
    assert.equal(ok.ok, true);
    assert.equal(ok.northGw, 12.5);
    near(ok.north.meanColatDeg, 25, 0.5, 'product carries the oval');
    assert.ok(ok.footprint instanceof Uint8Array && ok.footprint.length === 360 * 180);
    // A forecast time in the FUTURE (OVATION forecasts ~30 min ahead) is fresh.
    const fut = new Date(NOW.getTime() + 40 * 60e3).toISOString();
    assert.equal(auroraProduct({ data: { cells, updated: fut } }, NOW).ok, true, 'future forecast time is fresh');
}

// ── 7. Lockstep with the engine's curtain geometry ─────────────────────────
{
    const src = readFileSync(join(ROOT, 'js/magnetosphere-engine.js'), 'utf8');
    const m = src.match(/const N_SEG\s*=\s*(\d+);/);
    assert.ok(m, 'engine declares N_SEG');
    assert.equal(+m[1], N_SEG, 'hero-aurora N_SEG must equal the engine curtain N_SEG');
    assert.ok(/rBase \* sinT \* cosP,\s*rBase \* cosT \* sign,\s*rBase \* sinT \* sinP/.test(src.replace(/\s+/g, ' ')),
        'engine curtain vertex is (sinθ cosφ, ±cosθ, sinθ sinφ) — the expression curtainDirection mirrors');
}

console.log('hero-aurora: all assertions passed');
