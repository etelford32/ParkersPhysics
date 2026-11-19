#!/usr/bin/env node
/**
 * build-slab2-fixtures.mjs — the ORACLES for tests/earth-interior-slabs.mjs.
 *
 *   node scripts/build-slab2-fixtures.mjs <Slab2_CONTOURS dir> <Slab2_TXT dir>
 *
 * (2) slab2-dips.json: Slab2's own DIP grid (and full-resolution depth) at every
 * 1° lattice node inside each mask — the oracle for the kernel's down-dip
 * geometry, which is computed from the baked DEPTH grid alone.
 *
 * Slab2's own depth contours (GMT-drawn from the FULL 0.05° grids, in the same
 * release, ndb38/arc-metals @ 543bf32 Slab2_CONTOURS/) — every 24th point of
 * every contour of every slab, with each file's sha256. The baked 0.2° grid,
 * interpolated at a contour point, must read the contour's depth. Never
 * hand-edit the fixture; re-run this.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const dir = process.argv[2];
const out = { source: 'Slab2_CONTOURS @ ndb38/arc-metals 543bf32 (every 24th point)', files: {}, points: [] };
for (const f of readdirSync(dir).filter((n) => /_dep_.*_contours\.in$/.test(n)).sort()) {
    const buf = readFileSync(join(dir, f));
    out.files[f] = createHash('sha256').update(buf).digest('hex');
    let k = 0;
    for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim() || line.startsWith('>')) continue;
        const [lon, lat, z] = line.trim().split(/\s+/).map(Number);
        if (k++ % 24 === 0) out.points.push([f.slice(0, 3), lon, lat, -z]);
    }
}
writeFileSync('tests/fixtures/earth-interior/slab2-contours.json', JSON.stringify(out));
console.log(`${out.points.length} contour points from ${Object.keys(out.files).length} slabs`);

const txt = process.argv[3];
const dips = { source: 'Slab2_TXT dip + dep @ ndb38/arc-metals 543bf32, every 1° node', files: {}, points: [] };
const grid = (name) => {
    const buf = readFileSync(join(txt, name));
    dips.files[name] = createHash('sha256').update(buf).digest('hex');
    const m = new Map();
    for (const l of buf.toString('utf8').trim().split('\n')) { const [lo, la, v] = l.split(',').map(Number); if (Number.isFinite(v)) m.set(`${Math.round(lo * 100)}:${Math.round(la * 100)}`, [lo, la, v]); }
    return m;
};
for (const f of readdirSync(txt).filter((n) => /_dip_.*\.xyz$/.test(n)).sort()) {
    const dip = grid(f), dep = grid(f.replace('_dip_', '_dep_'));
    for (const [k, [lo, la, v]] of dip) {
        if (Math.abs(lo - Math.round(lo)) > 1e-6 || Math.abs(la - Math.round(la)) > 1e-6) continue;
        const d = dep.get(k);
        if (d) dips.points.push([f.slice(0, 3), lo, la, +(-d[2]).toFixed(2), +v.toFixed(2)]);
    }
}
writeFileSync('tests/fixtures/earth-interior/slab2-dips.json', JSON.stringify(dips));
console.log(`${dips.points.length} dip nodes from ${Object.keys(dips.files).length / 2} slabs`);
