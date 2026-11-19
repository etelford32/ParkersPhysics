// tests/earth-interior-slabs.mjs — USGS Slab2 subducting slabs, gated against Slab2's OWN contours
// and against the volcanoes above them.
// Run: node tests/earth-interior-slabs.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeSlabs, slabValueAt, slabsBeneath, quakeSlabContext, slabMesh, latLonToXYZ, downDip, slabSection, R_EARTH_KM, NEAR_KM } from '../js/earth-interior/slabs.js';
import { decodeCatalog, groupOf } from '../js/volcano-engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const baked = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'data/earth-interior/slab2.json.gz'))));
const model = decodeSlabs(baked);
const F = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/earth-interior/slab2-contours.json'), 'utf8'));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const quantile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };

console.log('Inner Earth — subducting slabs (Slab2)');

{
    assert.equal(model.slabs.length, 27);
    let nodes = 0, deepest = 0;
    for (const s of model.slabs) for (const d of s.depth) if (Number.isFinite(d)) { nodes++; assert.ok(d >= 0, `${s.code}: depth is positive DOWN`); deepest = Math.max(deepest, d); }
    assert.ok(deepest <= 700.05 && deepest > 650, `deepest node ${deepest} km (Slab2 stops at the 660 km transition zone)`);
    // Familiar depths: Tonga reaches the bottom of the transition zone; the Himalaya "slab" is the shallow underthrust Indian plate.
    assert.ok(model.byCode.get('ker').maxDepthKm >= 690 && model.byCode.get('him').maxDepthKm < 60);
    ok(`27 slabs, ${nodes.toLocaleString()} nodes at 0.2°, depths positive down, deepest ${deepest.toFixed(0)} km (Kermadec–Tonga); Himalaya ≤ ${model.byCode.get('him').maxDepthKm} km`);
}

{
    // ORACLE: Slab2's own depth contours, drawn by GMT from the FULL 0.05° grids. Our 0.2° subsample,
    // interpolated at each contour point, must read the contour's depth.
    const read = (m) => {
        const e = []; let miss = 0;
        for (const [c, lon, lat, z] of F.points) { const d = slabValueAt(m.byCode.get(c), lat, lon); if (d == null) miss++; else e.push(Math.abs(d - z)); }
        return { e, miss };
    };
    const { e, miss } = read(model);
    assert.ok(e.length > 8000 && miss / F.points.length < 0.12, `${e.length} read, ${miss} at the mask edge`);
    const p50 = quantile(e, 0.5), p99 = quantile(e, 0.99);
    assert.ok(p50 < 0.5 && p99 < 3, `contour agreement p50 ${p50} p99 ${p99} km`);
    // NEGATIVE CONTROL: the same grid with its ROW ORDER reversed (rows read south-first) — the decode's orientation must matter.
    const flipped = decodeSlabs({ ...baked, slabs: baked.slabs.map((s) => ({ ...s,
        depth: Array.from({ length: s.nLat }, (_, i) => s.depth.slice((s.nLat - 1 - i) * s.nLon, (s.nLat - i) * s.nLon)).flat(),
        unc: Array.from({ length: s.nLat }, (_, i) => s.unc.slice((s.nLat - 1 - i) * s.nLon, (s.nLat - i) * s.nLon)).flat() })) });
    const c = read(flipped);
    assert.ok(quantile(c.e, 0.5) > 20 * p50, `flipped control must fail (p50 ${quantile(c.e, 0.5)})`);
    ok(`${e.length.toLocaleString()} points on Slab2's own contours: |Δdepth| p50 ${p50.toFixed(2)} km, p99 ${p99.toFixed(2)} km; north↔south flipped control p50 ${quantile(c.e, 0.5).toFixed(0)} km`);
}

{
    // PHYSICS, from an independent catalogue: arc volcanoes stand where the slab is ~100 km down
    // (the classic result — England et al. 2004; Syracuse & Abers 2006). The GVP catalogue knows nothing of Slab2.
    const cat = decodeCatalog(JSON.parse(readFileSync(join(ROOT, 'data/volcanoes/volcanoes-catalog.json'), 'utf8')));
    const hol = cat.volcanoes.filter((v) => groupOf(v.status) !== 'inactive');
    const ds = [];
    for (const v of hol) { const u = slabsBeneath(model, v.lat, v.lon); if (u.length) ds.push(u[0].depthKm); }
    const med = quantile(ds, 0.5), iqr = quantile(ds, 0.75) - quantile(ds, 0.25);
    // Control: the same slabs sampled uniformly over their mapped area.
    const rs = [];
    for (const s of model.slabs) s.depth.forEach((d, k) => { if (Number.isFinite(d) && k % 7 === 0) rs.push(d); });
    const rMed = quantile(rs, 0.5), rIqr = quantile(rs, 0.75) - quantile(rs, 0.25);
    assert.ok(ds.length > 600, `${ds.length} Holocene volcanoes over a slab`);
    assert.ok(med > 90 && med < 120, `slab depth under arc volcanoes, median ${med}`);
    assert.ok(iqr < 0.3 * rIqr, `volcanoes pick a narrow depth band (IQR ${iqr} vs ${rIqr} over all slab nodes)`);
    ok(`slab surface under ${ds.length} Holocene volcanoes: median ${med.toFixed(0)} km, IQR ${iqr.toFixed(0)} km — vs anywhere on the slabs median ${rMed.toFixed(0)}, IQR ${rIqr.toFixed(0)}`);
}

{
    // Quake context: a hypocentre ON the surface, above it and below it, at a node of the Japan Trench.
    const s = model.byCode.get('kur');
    let lat = null, lon = null, d = null;
    for (let i = 0; i < s.nLat && d == null; i++) for (let j = 0; j < s.nLon; j++) {
        const v = s.depth[i * s.nLon + j];
        if (v > 95 && v < 105) { lat = s.lat0 - i * s.step; lon = s.lon0 + j * s.step; d = v; break; }
    }
    const at = (dz) => quakeSlabContext(model, { lat, lon: lon > 180 ? lon - 360 : lon, depthKm: d + dz });
    assert.equal(at(0).relation, 'near'); assert.equal(at(-80).relation, 'above'); assert.equal(at(80).relation, 'below');
    assert.ok(Math.abs(at(0).slabDepthKm - d) < 1e-3 && at(0).tolKm >= NEAR_KM);
    assert.equal(quakeSlabContext(model, { lat: 0, lon: -140, depthKm: 10 }), null, 'mid-Pacific: no slab, no claim');
    ok(`quake context at a ${d.toFixed(0)} km Kuril node: near / above / below by depth, longitude wrap handled, null off-slab`);
}

{
    // Mesh: every vertex at radius (R − depth)/R in the stage frame; no triangle off the mask.
    const s = model.byCode.get('sam'), mesh = slabMesh(s);
    let w = 0;
    for (let k = 0; k < mesh.depths.length; k++) {
        const r = Math.hypot(mesh.positions[3 * k], mesh.positions[3 * k + 1], mesh.positions[3 * k + 2]);
        w = Math.max(w, Math.abs(r - (R_EARTH_KM - mesh.depths[k]) / R_EARTH_KM));
    }
    assert.ok(w < 1e-6 && mesh.index.length > 0 && Math.max(...mesh.index) < mesh.depths.length);
    // Frame: the stage's canonical frame (x 0°E, y north, −z 90°E) — mirrored from stage.js latLonToVec.
    assert.deepEqual(latLonToXYZ(0, 90).map((v) => Math.round(v * 1e9) / 1e9 + 0), [0, 0, -1]);
    assert.deepEqual(latLonToXYZ(90, 0).map((v) => Math.round(v * 1e9) / 1e9 + 0), [0, 1, 0]);
    const src = readFileSync(join(ROOT, 'js/earth-interior/stage.js'), 'utf8');
    assert.match(src, /return new THREE\.Vector3\(c \* Math\.cos\(lo\), Math\.sin\(la\), -c \* Math\.sin\(lo\)\)/, 'stage.js latLonToVec is the frame slabs.js mirrors');
    ok(`South America mesh: ${mesh.depths.length} vertices at radius (R − depth)/R, ${mesh.index.length / 3} triangles inside the mask; frame pinned to stage.js`);
}

{
    // ORACLE 2: Slab2's own DIP grid. Our down-dip geometry comes from the baked DEPTH grid alone.
    const D = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/earth-interior/slab2-dips.json'), 'utf8'));
    const errs = (fn) => { const e = []; for (const [c, lon, lat, d, dip] of D.points) { if (d < 20 || d > 400) continue; const r = fn(model.byCode.get(c), lat, lon); if (r) e.push(Math.abs(r.dipDeg - dip)); } return e; };
    const e = errs(downDip);
    assert.ok(e.length > 1000 && quantile(e, 0.5) < 0.5 && quantile(e, 0.9) < 2, `dip p50 ${quantile(e, 0.5)} p90 ${quantile(e, 0.9)}`);
    // NEGATIVE CONTROL: forget that a degree of longitude shrinks by cos φ.
    const noCos = (sl, lat, lon) => { const r = downDip(sl, lat, lon); if (!r) return null; const h = sl.step, k = 111.19;
        const gE = (slabValueAt(sl, lat, lon + h) - slabValueAt(sl, lat, lon - h)) / (2 * h * k), gN = (slabValueAt(sl, lat + h, lon) - slabValueAt(sl, lat - h, lon)) / (2 * h * k);
        return { dipDeg: Math.atan(Math.hypot(gE, gN)) * 180 / Math.PI }; };
    const c = errs(noCos);
    assert.ok(quantile(c, 0.9) > 3 * quantile(e, 0.9), `no-cos φ control must fail (p90 ${quantile(c, 0.9)})`);
    ok(`dip from the baked depths vs Slab2's own dip grid at ${e.length} nodes: p50 ${quantile(e, 0.5).toFixed(2)}°, p90 ${quantile(e, 0.9).toFixed(2)}°; without cos φ p90 ${quantile(c, 0.9).toFixed(1)}°`);
}

{
    // Sections: an orthonormal plane in the stage's wedge convention, the profile IN it, the slab deepening down-dip,
    // and the known dip directions (Tonga west, the Andes east, Kuril north-west) coming out of the data.
    const sec = (c) => slabSection(model, c);
    const spearman = (xs, ys) => { const rk = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = []; o.forEach(([, i], k) => { r[i] = k; }); return r; };
        const a = rk(xs), b = rk(ys), m = (a.length - 1) / 2; let num = 0, da = 0, db = 0; a.forEach((v, i) => { num += (v - m) * (b[i] - m); da += (v - m) ** 2; db += (b[i] - m) ** 2; }); return num / Math.sqrt(da * db); };
    for (const [code, lo, hi] of [['ker', 250, 300], ['sam', 40, 110], ['kur', 290, 345], ['sum', 20, 70], ['cas', 60, 120]]) {
        const x = sec(code), { e1, e2, n: nn } = x.plane, d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert.ok(Math.abs(d(e1, e2)) < 1e-12 && Math.abs(d(e1, nn)) < 1e-12 && Math.abs(d(nn, nn) - 1) < 1e-12, `${code}: orthonormal`);
        for (const p of x.profile) assert.ok(Math.abs(d(latLonToXYZ(p.lat, p.lon), nn)) < 1e-9, `${code}: profile in the plane`);
        const v = x.profile.filter((p) => p.depthKm != null);
        assert.ok(v[0].sDeg > 0.5, `${code}: the cut starts seaward of the slab`);
        assert.ok(spearman(v.map((p) => p.sDeg), v.map((p) => p.depthKm)) > 0.95, `${code}: the slab deepens down-dip`);
        assert.ok(x.azimuthDeg >= lo && x.azimuthDeg <= hi, `${code}: dips toward ${x.azimuthDeg}`);
    }
    assert.equal(sec('him'), null, 'the Himalaya never reaches 80 km: no section');
    ok('sections: orthonormal wedge plane, profile in it, slab deepening down-dip; Tonga dips W, Andes E, Kuril NW, Sumatra NE, Cascadia E — from the data; none for the Himalaya');
}

console.log(`earth-interior-slabs: ${n} checks passed`);
