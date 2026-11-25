#!/usr/bin/env node
/**
 * scripts/build-plate-history-series.mjs — the planet's tectonic vital signs, 1800 Ma → today.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DERIVES data/plate-history/series.json from the baked frames with OUR kernel
 * (js/plate-history/{rotations,frames,diagnostics}.js) — the page charts this file instead of
 * recomputing 361 frames of statistics on every visit. It contains NOTHING the kernel did not
 * compute, so `--check` (and tests/plate-history-diagnostics.mjs) fail if it is stale.
 *
 * Usage: node scripts/build-plate-history-series.mjs [--check]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRotationModel } from '../js/plate-history/rotations.js';
import { decodeFrames, decodeShapes, boundariesAt, shapesAt } from '../js/plate-history/frames.js';
import { boundaryStats, speedStats, supercontinentIndex, ringArea, OBLIQUITY_MAX_DEG } from '../js/plate-history/diagnostics.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/plate-history');
const OUT = path.join(DIR, 'series.json');
const gzJson = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString('utf8'));

export function buildSeries({ rotDoc, framesDoc, shapesDoc }) {
    const model = createRotationModel(rotDoc);
    const fr = decodeFrames(framesDoc);
    const { continents } = decodeShapes(shapesDoc);
    const r1 = (x) => Math.round(x * 10) / 10, r4 = (x) => Math.round(x * 1e4) / 1e4;
    const rows = fr.frames.map((frame) => {
        const t = frame.t;
        const { segs } = boundariesAt(model, fr, t);
        const b = boundaryStats(model, segs, t);
        const sp = speedStats(model, fr, frame, t);
        const placed = shapesAt(model, continents, t);
        const sc = supercontinentIndex(placed);
        // Continental speed: area-weighted RMS of each continent's centroid speed on its own plate.
        let s2 = 0, aw = 0;
        for (const p of placed) {
            const n = p.xyz.length / 3; let c = [0, 0, 0];
            for (let i = 0; i < n; i++) { c[0] += p.xyz[3 * i]; c[1] += p.xyz[3 * i + 1]; c[2] += p.xyz[3 * i + 2]; }
            const L = Math.hypot(...c); if (!L) continue;
            const lat = Math.asin(c[2] / L) * 180 / Math.PI, lon = Math.atan2(c[1], c[0]) * 180 / Math.PI;
            const a = Math.abs(ringArea(p.xyz).area);
            if (!(a > 0) || a > 2 * Math.PI) continue;
            const v = model.velocity(p.shape.plate, t, lat, lon).speed;
            s2 += a * v * v; aw += a;
        }
        return {
            t, plates: frame.plates.length,
            ridgeKm: Math.round(b.ridgeKm), ridgeTransformKm: Math.round(b.ridgeTransformKm),
            trenchKm: Math.round(b.trenchKm), transformKm: Math.round(b.transformKm),
            productionKm2PerMa: Math.round(b.productionKm2), consumptionKm2PerMa: Math.round(b.consumptionKm2),
            rmsSpeedMmYr: r1(sp.rms), maxSpeedMmYr: r1(sp.max), continentalRmsMmYr: r1(aw ? Math.sqrt(s2 / aw) : NaN),
            supercontinentIndex: r4(sc.index), continentalAreaFrac: r4(sc.areaSr / (4 * Math.PI)), continents: sc.n,
            trenchOpeningKm: Math.round(b.openingKm), unknownPolarityKm: Math.round(b.unknownPolarityKm),
            // Share of the 1° raster in NO plate: the model's own topology failing to close (855 Ma).
            noPlateFrac: r4(frame.raster.reduce((n, v) => n + (v === 255), 0) / frame.raster.length),
        };
    });
    return {
        note: 'DERIVED by scripts/build-plate-history-series.mjs from data/plate-history/*.json.gz with js/plate-history/* — never hand-edit',
        obliquityMaxDeg: OBLIQUITY_MAX_DEG, stepMa: fr.stepMa,
        units: { length: 'km', area: 'km² per Myr', speed: 'mm/yr (= km/Myr)', supercontinentIndex: 'area-weighted mean resultant length of continental centroids, 0–1' },
        rows,
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const doc = buildSeries({
        rotDoc: gzJson('rotations.json.gz'), framesDoc: gzJson('frames.json.gz'), shapesDoc: gzJson('continents.json.gz'),
    });
    const text = JSON.stringify(doc, null, 0).replace(/\},\{/g, '},\n{') + '\n';
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (cur !== text) { console.error('data/plate-history/series.json is STALE — run node scripts/build-plate-history-series.mjs'); process.exit(1); }
        console.log('plate-history series: up to date');
    } else {
        fs.writeFileSync(OUT, text);
        console.log(`wrote ${path.relative(ROOT, OUT)} (${doc.rows.length} frames, ${text.length.toLocaleString()} bytes)`);
    }
}
