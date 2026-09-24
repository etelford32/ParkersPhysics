// tests/hero-sun-model.mjs — the pure model behind the hero's live Sun and
// its "Next 24 h" preview (js/hero-sun-model.js). Runs the REAL committed
// flux-rope WASM for the engine half — no network.
// Run: node tests/hero-sun-model.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    stonyhurstDriftDegPerDay, wrap180, helioUnit, tangentAt, bipoleAxisAt,
    latestRegions, regionAt, regionTurnRad, limbCrossingMs, bipoleSize, activityHeat,
    regionLoops, flareSites, flareFlash, outlookWindow, activityCmes, buildOutlookForecast,
    outlookMarks, MAX_REGIONS, OUTLOOK_HOURS,
} from '../js/hero-sun-model.js';
import { ropeFrame } from '../js/flux-rope/view.js';
import { SUN_SYNODIC_DAYS } from '../js/flare-geometry.js';
import { loadFluxRopeKernel } from '../js/flux-rope-kernel.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const HOUR = 3600e3, DAY = 86400e3;
const NOW = Date.parse('2026-09-24T12:00:00Z');

// ── Frame identity: a region and a rope launched from it share ONE frame ──
for (const [lat, lon] of [[0, 0], [12, -34], [-20, 61], [35, 89], [-5, 150]]) {
    const u = helioUnit(lat, lon);
    const e = ropeFrame(lon, lat, 0).eDir;
    for (let i = 0; i < 3; i++) near(u[i], e[i], 1e-12, `helioUnit == ropeFrame.eDir at ${lat},${lon}`);
}
near(helioUnit(0, 90)[1], 1, 1e-12, 'W90 is +y (the direction of rotation)');
{
    const { west, north } = tangentAt(20, 30);
    const u = helioUnit(20, 30);
    near(dot(west, u), 0, 1e-12, 'west is tangent'); near(dot(north, u), 0, 1e-12, 'north is tangent');
    // ∂/∂lon by finite difference agrees with `west`
    const u2 = helioUnit(20, 30.001);
    const d = [0, 1, 2].map((i) => (u2[i] - u[i]));
    const m = Math.hypot(...d);
    near(dot(d.map((x) => x / m), west), 1, 1e-6, 'west = ∂/∂lon direction');
}

// ── Rotation: synodic, westward, differential ────────────────────────────
const eq = stonyhurstDriftDegPerDay(0);
near(eq, 360 / SUN_SYNODIC_DAYS, 0.05, 'equatorial drift is the synodic rate (~13.2°/d)');
assert.ok(stonyhurstDriftDegPerDay(30) < eq && stonyhurstDriftDegPerDay(-30) < eq, 'high latitudes lag');
near(stonyhurstDriftDegPerDay(25), stonyhurstDriftDegPerDay(-25), 1e-12, 'symmetric in latitude');
near(wrap180(190), -170, 1e-12, 'wrap'); near(wrap180(-180), 180, 1e-12, 'wrap −180 → 180');

// ── Joy's law: leading spot WEST and EQUATORWARD, in both hemispheres ────
for (const lat of [18, -18]) {
    const ax = bipoleAxisAt(lat, 10);
    const { west, north } = tangentAt(lat, 10);
    assert.ok(dot(ax, west) > 0.9, `leading spot is west (lat ${lat})`);
    assert.ok(Math.sign(dot(ax, north)) === -Math.sign(lat), `leading spot equatorward (lat ${lat})`);
    near(dot(ax, helioUnit(lat, 10)), 0, 1e-12, 'axis is tangent');
}

// ── Regions: history → one row each, only the newest report day ─────────
const rows = [
    { region: 4120, observed_date: '2026-09-22', location: 'N10W40', latitude_deg: 10, stonyhurst_lon_deg: 40, area: 300, mag_class: 'Beta', m_flare_probability: 20, x_flare_probability: 5 },
    { region: 4120, observed_date: '2026-09-24', location: 'N10W78', latitude_deg: 10, stonyhurst_lon_deg: 78, area: 280, mag_class: 'BGD', m_flare_probability: 35, x_flare_probability: 10 },
    { region: 4125, observed_date: '2026-09-24', location: 'S15E20', area: 90, mag_class: 'A', m_flare_probability: 1, x_flare_probability: 1 },
    { region: 4101, observed_date: '2026-09-20', location: 'S05W85', area: 500, mag_class: 'BG', m_flare_probability: 30, x_flare_probability: 5 },   // rotated off
    { region: 4126, observed_date: '2026-09-24', location: 'junk', area: 40 },                                                                   // unplaceable
];
const regs = latestRegions(rows);
assert.deepEqual(regs.map((r) => r.region), ['4120', '4125'], 'latest report per region, newest day only, unplaceable dropped');
const r4120 = regs[0];
assert.equal(r4120.lonDeg, 78, 'the LATEST report wins');
assert.equal(r4120.anchorMs, Date.parse('2026-09-24T00:00:00Z'), 'anchored at 00 UTC of the report');
assert.equal(r4120.complex, true, 'BGD is complex');
assert.equal(regs[1].complex, false, 'A is not');
near(r4120.pM, 0.35, 1e-12, 'probabilities read as fractions (feed-wide percent decision)');
assert.deepEqual([regs[1].latDeg, regs[1].lonDeg], [-15, -20], 'location string fallback (W positive)');
assert.equal(latestRegions(null).length, 0); assert.equal(latestRegions([]).length, 0);
assert.ok(latestRegions(Array.from({ length: 30 }, (_, i) => ({ region: 5000 + i, observed_date: '2026-09-24', location: 'N05W00', area: i }))).length === MAX_REGIONS, 'capped');

// Carried forward: 12 h after the anchor is half a day of drift; sets within the day.
const at = regionAt(r4120, r4120.anchorMs + 12 * HOUR);
near(at.lonDeg, 78 + stonyhurstDriftDegPerDay(10) / 2, 1e-9, 'regionAt drifts at the synodic rate');
near(regionTurnRad(r4120, r4120.anchorMs + DAY), stonyhurstDriftDegPerDay(10) * Math.PI / 180, 1e-12, 'turn angle');
const set = limbCrossingMs(r4120, NOW);
assert.ok(set && set > NOW && set < NOW + OUTLOOK_HOURS * HOUR, 'a W78 region (at 00Z) sets inside the 24 h preview');
near(regionAt(r4120, set).lonDeg, 90, 1e-6, 'crossing is AT the limb');
assert.equal(limbCrossingMs(regs[1], NOW), null, 'an E20 region does not set within a day');

// ── Drawn size + heat are monotone display mappings ─────────────────────
assert.ok(bipoleSize(1000).halfSepRad > bipoleSize(100).halfSepRad && bipoleSize(0).umbraRad > 0, 'size ~ √area, floored');
assert.ok(activityHeat({ pM: 0.5, pX: 0.1 }) > activityHeat({ pM: 0.05, pX: 0.01 }), 'heat follows the probabilities');
assert.ok(activityHeat({ pM: null, pX: null, complex: true, area: 600 }) > activityHeat({ pM: null, pX: null, complex: false, area: 50 }), 'fallback: complexity + area');
for (const h of [activityHeat({ pM: 1, pX: 1 }), activityHeat({})]) assert.ok(h >= 0 && h <= 1, 'bounded');

// ── Loops: footpoints on the photosphere, apex above, straddling the PIL ─
{
    const loops = regionLoops(r4120);
    assert.equal(loops.length, 9);
    const c = helioUnit(r4120.latDeg, r4120.lonDeg);
    const ax = bipoleAxisAt(r4120.latDeg, r4120.lonDeg);
    for (const l of loops) {
        const a = l.pts[0], b = l.pts[l.pts.length - 1];
        near(Math.hypot(...a), 1, 1e-9, 'foot A on the surface'); near(Math.hypot(...b), 1, 1e-9, 'foot B on the surface');
        const top = l.pts[Math.floor(l.pts.length / 2)];
        assert.ok(Math.hypot(...top) > 1.01, 'apex above the surface');
        assert.ok(dot(a, ax) * dot(b, ax) < 0 || Math.sign(dot(a, ax) - dot(c, ax)) !== Math.sign(dot(b, ax) - dot(c, ax)), 'feet on opposite sides of the PIL');
        assert.ok(dot(top, c) / Math.hypot(...top) > 0.97, 'loop stays over its region');
    }
    assert.deepEqual(regionLoops(r4120), loops, 'deterministic per region');
}

// ── Flares on the bus ───────────────────────────────────────────────────
{
    const sites = flareSites([
        { time: new Date(NOW - 20 * 60e3), parsed: { letter: 'M' }, location: 'N12W19' },
        { time: new Date(NOW - 2 * HOUR), cls: 'C3.1', location: null },
        { time: new Date(NOW - 3 * HOUR), cls: 'B5', location: 'S02E10' },
    ]);
    assert.equal(sites.length, 1, 'no location → no site; B-class → no flash');
    assert.deepEqual([sites[0].latDeg, sites[0].lonDeg], [12, 19]);
    assert.ok(flareFlash(sites[0], NOW) > 0.2, 'recent M flare still glowing');
    assert.equal(flareFlash(sites[0], NOW + 2 * HOUR), 0, 'gone within the hour');
}

// ── Window + CME selection ───────────────────────────────────────────────
const win = outlookWindow(NOW);
assert.equal(win.t1 - win.t0, OUTLOOK_HOURS * HOUR); assert.equal(win.t0, NOW);
const bus = [
    { time: new Date(NOW - 24 * HOUR).toISOString(), speed: 1800, latitude: 10, longitude: 5, halfAngle: 40, earthDirected: true },
    { time: new Date(NOW - 24 * HOUR).toISOString(), speed: 1750, latitude: 11, longitude: 6, halfAngle: 38, earthDirected: true },    // duplicate analysis
    { time: new Date(NOW - 30 * HOUR).toISOString(), speed: 500, latitude: -20, longitude: -80, halfAngle: 25, earthDirected: false },
    { time: new Date(NOW - 90 * HOUR).toISOString(), speed: 700, latitude: 0, longitude: 70, halfAngle: 30 },                        // too old
    { time: new Date(NOW + 1 * HOUR).toISOString(), speed: 700, latitude: 0, longitude: 0, halfAngle: 30 },                          // future
];
const cmes = activityCmes(bus, NOW);
assert.equal(cmes.length, 2, 'lookback, future and duplicate-analysis screens');
assert.ok(Date.parse(cmes[0].timeIso) < Date.parse(cmes[1].timeIso), 'launch-ascending (rope 0 = epoch)');
assert.equal(cmes[0].lonDeg, -80, 'every direction, not just Earth-directed');
assert.equal(activityCmes(Array.from({ length: 10 }, (_, i) => ({ time: new Date(NOW - (i + 1) * HOUR).toISOString(), speed: 600 })), NOW).length, 6, 'kernel rope cap');

// ── The engine half: the REAL kernel propagates the preview ─────────────
const kernel = await loadFluxRopeKernel(readFileSync(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)));
const fc = buildOutlookForecast(kernel, cmes, NOW, { ambientWKms: 420 });
assert.equal(fc.idle, false); assert.equal(fc.outlook, true);
assert.equal(kernel.ropeCount(), 2, 'kernel carries the preview train');
assert.equal(fc.launchMs, Date.parse(cmes[0].timeIso), 'epoch = earliest launch');
const tS = (NOW - fc.launchMs) / 1000;
const a0 = kernel.apexKmAt(1, tS), a1 = kernel.apexKmAt(1, tS + 12 * 3600);
assert.ok(a0 > 0 && a1 > a0, 'the engine moves the rope outward over the preview');
const quiet = buildOutlookForecast(kernel, [], NOW);
assert.equal(quiet.idle, true); assert.equal(quiet.preset.ropes.length, 0, 'a quiet catalogue is drawn quiet — no rope invented');

const fc2 = buildOutlookForecast(kernel, cmes, NOW, { ambientWKms: 420 });
const marks = outlookMarks(fc2, win, regs);
const arrive = marks.find((m) => m.kind === 'arrive');
assert.ok(arrive, 'the 1800 km/s Earth-directed rope (kernel transit ~37 h) reaches 1 AU inside the day');
assert.ok(kernel.apexKmAt(1, (arrive.t - fc2.launchMs) / 1000) / 1.495978707e8 >= 0.99, 'mark is where the kernel says 1 AU');
assert.ok(marks.some((m) => m.kind === 'set' && m.label.includes('4120')), 'limb setting marked');
assert.ok(marks.every((m) => m.t >= win.t0 && m.t <= win.t1), 'marks inside the window');
assert.ok(!marks.some((m) => m.label.startsWith('CME 1')), 'the W80 rope is not Earth-directed — no arrival mark');

console.log('hero-sun-model: all assertions passed');
