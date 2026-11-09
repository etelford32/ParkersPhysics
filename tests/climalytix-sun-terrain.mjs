/**
 * Node gate for js/climalytix/sun-terrain.js — cast shadows, the terrain
 * horizon, and a day's Sun judged against it.
 *
 * Closed forms, not remembered numbers:
 *   · a wall of height H on flat ground shades a strip H / tan α long, on the
 *     side AWAY from the Sun, for every azimuth tried
 *   · night shades nothing (night is not a shadow)
 *   · a ridge of height H at distance D stands atan(H / D) above the horizon,
 *     in its own direction only; flat ground has a 0° horizon
 *   · the Earth's curvature lowers a distant ridge by d²/2R (NEGATIVE CONTROL:
 *     with curvature off it stands too high)
 *   · the horizon is a LOWER bound: reachKm is the distance to the grid edge
 *   · a day against that horizon: terrain sunrise is later, terrain sunset
 *     earlier, direct ≤ astronomical, and an open horizon loses nothing
 */
import assert from 'node:assert/strict';
import { shadowGrid, horizonProfile, horizonAt, sunPath, sunDay } from '../js/climalytix/sun-terrain.js';
import { solarPosition } from '../js/sun-altitude.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const D2R = Math.PI / 180;

/** A grid on the EQUATOR (so a node is the same length both ways), `cell` metres per node. */
function grid(n, cell, zOf) {
    const d = cell / 111_195;
    const values = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) values[i * n + j] = zOf(i, j);
    return { latN: (n - 1) / 2 * d, lonW: -(n - 1) / 2 * d, dlat: d, dlon: d, nRows: n, nCols: n, values };
}

// ── a wall's shadow is H / tan α long, on the far side from the Sun ─────────
{
    const N = 121, CELL = 100, H = 500, C = 60;
    const wallNS = grid(N, CELL, (i, j) => (j === C ? H : 0));          // a north–south wall
    for (const alt of [10, 20, 35, 60]) {
        const expect = H / Math.tan(alt * D2R);
        for (const [az, side] of [[90, -1], [270, +1]]) {                 // Sun in the east ⇒ shadow to the WEST
            const { mask, night } = shadowGrid(wallNS, { altitudeDeg: alt, azimuthDeg: az }, { curvature: false });
            assert.equal(night, false);
            let len = 0;
            for (let s = 1; s < C; s++) { if (mask[C * N + C + side * s]) len = s * CELL; else break; }
            near(len, expect, CELL * 1.5, `alt ${alt}°, Sun at ${az}°: shadow length`);
            assert.equal(mask[C * N + C - side * 5], 0, 'the sunward side of the wall is lit');
        }
    }
    // A Sun along the wall casts no shadow across it.
    const along = shadowGrid(wallNS, { altitudeDeg: 20, azimuthDeg: 180 }, { curvature: false });
    assert.equal(along.mask[C * N + C + 5], 0);
    assert.equal(along.mask[C * N + C - 5], 0);
    // An east–west wall, Sun in the south ⇒ shadow to the NORTH (smaller i).
    const wallEW = grid(N, CELL, (i) => (i === C ? H : 0));
    const s = shadowGrid(wallEW, { altitudeDeg: 20, azimuthDeg: 180 }, { curvature: false });
    assert.equal(s.mask[(C - 5) * N + C], 1, 'north of the wall is shaded');
    assert.equal(s.mask[(C + 5) * N + C], 0, 'south of it is lit');
    assert.equal(s.lit + s.shaded, N * N);
}
// ── night, flat ground, gaps ────────────────────────────────────────────────
{
    const flat = grid(41, 200, () => 300);
    for (const altitudeDeg of [0, -3]) {
        const n = shadowGrid(flat, { altitudeDeg, azimuthDeg: 100 });
        assert.equal(n.night, true);
        assert.equal(n.shaded, 0, 'night is not a shadow');
    }
    assert.equal(shadowGrid(flat, { altitudeDeg: 1, azimuthDeg: 100 }).shaded, 0, 'flat ground shades nothing, even at 1°');
    const holed = grid(41, 200, (i, j) => (i === 20 && j === 20 ? NaN : 300));
    const h = shadowGrid(holed, { altitudeDeg: 30, azimuthDeg: 100 });
    assert.equal(h.mask[20 * 41 + 20], 255, 'no terrain ⇒ neither lit nor shaded');
}

// ── the horizon of a ridge: atan(H / D), in its own direction only ──────────
{
    const N = 201, CELL = 100, C = 100, H = 800, D = 40;                 // a ridge 4 km east of the site
    const ridge = grid(N, CELL, (i, j) => (j >= C + D && j <= C + D + 1 ? H : 0));
    const p = horizonProfile(ridge, 0, 0, { eyeM: 0, curvature: false });
    near(horizonAt(p, 90), Math.atan2(H, D * CELL) / D2R, 0.3, 'due east');
    near(horizonAt(p, 60), Math.atan2(H, D * CELL / Math.cos(30 * D2R)) / D2R, 0.4, '30° off: the ridge is further along that bearing');
    assert.equal(horizonAt(p, 270), 0, 'open to the west');
    assert.equal(horizonAt(p, 180), 0);
    assert.equal(p.groundM, 0);
    near(p.reachKm[Math.round(270 / p.azStepDeg)], C * CELL / 1000, 0.2, 'reach = distance to the grid edge');
    near(horizonAt(p, 361), horizonAt(p, 1), 1e-9, 'wraps at north');
    assert.equal(horizonAt(null, 123), 0, 'no profile = an open horizon');
    assert.equal(horizonProfile(ridge, 50, 0), null, 'a point off the grid has no horizon');
    assert.ok(horizonProfile(grid(41, 200, () => 1200), 0, 0).angles.every((a) => a === 0), 'a plateau has a 0° horizon');
    // Standing ON the ridge: nothing is above you.
    const top = horizonProfile(ridge, 0, (D + 0.5) * CELL / 111_195, { eyeM: 2 });
    assert.ok(top.angles.every((a) => a === 0));
}
// ── curvature: a ridge 50 km away sits d²/2R = 196 m lower ──────────────────
{
    const N = 301, CELL = 400, C = 150, H = 1500, D = 125;               // 50 km east
    const far = grid(N, CELL, (i, j) => (j === C + D ? H : 0));
    const curved = horizonAt(horizonProfile(far, 0, 0, { eyeM: 0 }), 90);
    const flatEarth = horizonAt(horizonProfile(far, 0, 0, { eyeM: 0, curvature: false }), 90);
    near(curved, Math.atan2(H - 50_000 ** 2 / (2 * 6_371_000), 50_000) / D2R, 0.05, 'with curvature');
    near(flatEarth, Math.atan2(H, 50_000) / D2R, 0.05, 'NEGATIVE CONTROL: flat Earth');
    assert.ok(flatEarth - curved > 0.2, 'the flat-Earth ridge stands visibly too high');
}

// ── a day against a horizon ─────────────────────────────────────────────────
{
    const lat = 40.015, lon = -105.271;
    const dayStart = Date.UTC(2026, 10, 9, 7, 0, 0);                     // local midnight, MST
    const path = sunPath(lat, lon, dayStart, solarPosition, { stepMin: 5 });
    assert.equal(path.length, 289);
    const open = sunDay(path, null);
    assert.equal(open.lostMin, 0, 'an open horizon takes nothing');
    assert.equal(open.clearRise, open.rise);
    assert.equal(open.polar, null);
    near(open.sunMin / 60, 10.15, 0.25, 'day length at 40° N on 9 Nov');
    near(open.noon.alt, 90 - lat - 16.9, 0.6, 'noon altitude = 90° − φ + δ');
    near(open.noon.az, 180, 3, 'the Sun culminates due south');
    assert.ok(path.find((p) => p.t === open.rise).az > 90 && path.find((p) => p.t === open.rise).az < 125, 'a November sunrise is south of east');
    // A 12° wall to the west (the Front Range from Boulder): the afternoon ends early.
    const west = { azStepDeg: 2, angles: Float32Array.from({ length: 180 }, (_, a) => (a * 2 >= 200 && a * 2 <= 320 ? 12 : 0)) };
    const d = sunDay(path, west);
    assert.equal(d.clearRise, d.rise, 'the east is open: sunrise unchanged');
    assert.ok(d.clearSet < d.set, 'the Sun goes behind the range before it sets');
    near((d.set - d.clearSet) / 60_000, d.lostMin, 5.01, 'all of the loss is in the evening');
    assert.ok(d.lostMin > 45 && d.lostMin < 110, `about an hour of direct sun lost (${d.lostMin} min)`);
    assert.ok(d.directMin <= d.sunMin);
    // A wall all round higher than the noon Sun: no direct sun at all, and no terrain sunrise.
    const pit = { azStepDeg: 2, angles: new Float32Array(180).fill(60) };
    const none = sunDay(path, pit);
    assert.deepEqual([none.directMin, none.clearRise, none.clearSet], [0, null, null]);
    assert.equal(none.sunMin, open.sunMin);
    // Polar night and polar day.
    assert.equal(sunDay(sunPath(80, 0, Date.UTC(2026, 11, 21), solarPosition), null).polar, 'night');
    assert.equal(sunDay(sunPath(80, 0, Date.UTC(2026, 5, 21), solarPosition), null).polar, 'day');
}

console.log('climalytix-sun-terrain: wall shadows, night, ridge horizon, curvature control, a day against the horizon passed');
