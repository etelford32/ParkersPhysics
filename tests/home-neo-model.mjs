// tests/home-neo-model.mjs — the pure model behind the homepage's nearest-NEO
// widget (js/home-neo-model.js). Run: node tests/home-neo-model.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    TOP_N, HORIZON_AU, TIER_LADDER, CLASS_TINTS, tintFor, nearestIndices, planPoint, PLAN_RINGS,
    planExtent, approachTrend, rowSummary, tierLabel, AU_KM, LD_KM, MOON_SCENE, EARTH_RADIUS_KM,
} from '../js/home-neo-model.js';
import { geoSceneRadius, buildObjectRow, earthHelioJ2000 } from '../js/neo-space.js';
import { normalizeElements, propagate } from '../js/neo-orbits.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// ── Colours are the orrery's own (js/neo-layer.js NEO_COLORS), pinned by source text ──
{
    const src = readFileSync(new URL('../js/neo-layer.js', import.meta.url), 'utf8');
    const block = /export const NEO_COLORS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(src)[1];
    for (const [k, v] of Object.entries(CLASS_TINTS)) {
        const m = new RegExp(`\\b${k}:\\s*0x([0-9a-f]{6})`).exec(block);
        assert.ok(m, `NEO_COLORS has ${k}`);
        assert.equal(v, '#' + m[1], `${k} tint matches the orrery`);
    }
    assert.equal(tintFor({ isPHA: true, cls: 'APO' }), CLASS_TINTS.pha, 'hazard beats class');
    assert.equal(tintFor({ isComet: true, cls: 'JFC' }), CLASS_TINTS.comet);
    assert.equal(tintFor({ cls: 'ATE' }), CLASS_TINTS.ATE);
    assert.equal(tintFor({ cls: 'ZZZ' }), CLASS_TINTS.other);
}

// ── Ranking: nearest first, inside the horizon, capped, stable ───────────
{
    const rGeo = new Float32Array([0.3, 0.01, 0.6, 0.02, 0.02, 0.0005, 0.49]);
    const idx = nearestIndices({ count: rGeo.length, rGeo }, 4);
    assert.deepEqual(idx, [5, 1, 3, 4], 'ascending distance, tie by index, capped at 4');
    assert.deepEqual(nearestIndices({ count: rGeo.length, rGeo }, 10), [5, 1, 3, 4, 0, 6], '0.6 AU is outside the 0.5 AU horizon');
    assert.deepEqual(nearestIndices(null), []);
    assert.equal(TOP_N, 10); assert.equal(HORIZON_AU, 0.5); assert.deepEqual([...TIER_LADDER], ['pha', 'bright']);
}

// ── Plan view: the Near-Earth Watch's map, anchors intact ────────────────
{
    const moon = planPoint(LD_KM / AU_KM, 0, 0);
    near(moon.r, MOON_SCENE, 1e-9, 'the Moon sits at MOON_SCENE');
    near(moon.x, MOON_SCENE, 1e-9, 'along +x'); near(moon.y, 0, 1e-12, 'no y');
    const surf = planPoint(0, EARTH_RADIUS_KM / AU_KM, 0);
    near(surf.r, 1, 1e-9, "Earth's surface is 1 unit");
    near(surf.y, 1, 1e-9, 'along +y');
    // Monotonic in distance, and identical to the kernel's own map.
    let prev = 0;
    for (let d = 1e4; d < 0.5 * AU_KM; d *= 1.7) {
        const p = planPoint(d / AU_KM * 0.6, d / AU_KM * 0.8, 0);
        assert.ok(p.r > prev, 'monotone'); prev = p.r;
        near(p.r, geoSceneRadius(d), 1e-9, 'plan radius IS geoSceneRadius');
        near(Math.hypot(p.x, p.y), p.r, 1e-9, 'direction preserved');
    }
    const up = planPoint(0.001, 0, 0.001);
    assert.ok(up.above && Math.abs(up.elevDeg - 45) < 1e-9, 'elevation +45°');
    const down = planPoint(0.001, 0.001, -0.0014142);
    assert.ok(!down.above && down.elevDeg < -44 && down.elevDeg > -46, 'elevation −45°');
    const pole = planPoint(0, 0, 0.01);
    near(pole.x, 0, 1e-12); near(pole.y, 0, 1e-12); assert.ok(pole.r > 1, 'a polar object sits at the centre at its radius');
    // Rings: derived, not typed; outer > inner.
    for (let i = 1; i < PLAN_RINGS.length; i++) assert.ok(PLAN_RINGS[i].scene > PLAN_RINGS[i - 1].scene);
    for (const r of PLAN_RINGS) near(r.scene, geoSceneRadius(r.km), 1e-12, `${r.label} drawn at the kernel map`);
    assert.ok(PLAN_RINGS[0].scene === MOON_SCENE, '1 LD is the Moon anchor');
    near(planExtent([]), MOON_SCENE * 1.15, 1e-12, 'empty extent still shows the Moon');
    near(planExtent([{ r: 30 }, { r: 12 }]), 30 * 1.08, 1e-12, 'extent fits the farthest point');
}

// ── Trend ────────────────────────────────────────────────────────────────
{
    const t = approachTrend(1_000_000, 1_000_000 - 86_400 * 12.5, 1);
    near(t.kms, -12.5, 1e-9, 'closing at 12.5 km/s'); assert.equal(t.closing, true);
    assert.equal(approachTrend(1, 2, 0), null); assert.equal(approachTrend(NaN, 2, 1), null);
    assert.equal(approachTrend(5, 9, 1).closing, false);
}

// ── Row summary on a real kernel row ─────────────────────────────────────
{
    const jd = 2461000.5;
    const norm = normalizeElements({ des: 'TEST', name: '(TEST)', H: 22, cls: 'APO', flags: 3, e: 0.2, a: 1.1, i: 5, om: 10, w: 20, ma: 30, epoch: jd, moid: 0.01 });
    assert.ok(norm.ok, norm.reason);
    const el = norm.el;
    const p = propagate(el, jd);
    const e = earthHelioJ2000(jd);
    const row = buildObjectRow(el, { index: 0, geo: [p.x - e.x, p.y - e.y, p.z - e.z], rHelioAU: Math.hypot(p.x, p.y, p.z), earthRAU: e.rAU, jd,
        observer: { latDeg: 40, lonDeg: -105 } });
    const s = rowSummary(row, approachTrend(row.distKm + 86_400, row.distKm, 1));
    assert.equal(s.hazard, 'PHA');
    assert.equal(s.cls, row.classLabel);
    assert.ok(/km\/s$/.test(s.trend) && s.trend.startsWith('closing'));
    assert.equal(s.dist, row.distLabel);
    assert.ok(/up|below your horizon/.test(s.sky), 'sky line from the observer');
    assert.ok(s.sizeNote && /albedo/.test(s.sizeNote), 'an H-derived size carries its assumption');
    const s2 = rowSummary({ distKm: 3 * LD_KM, distLD: 3, isComet: true, cls: 'JFC' });
    assert.equal(s2.cls, 'comet'); assert.equal(s2.ld, '3.00'); assert.equal(s2.trend, '—'); assert.equal(s2.sky, null);
    assert.equal(tierLabel('pha'), 'potentially hazardous asteroids');
}

console.log('home-neo-model: ok');
