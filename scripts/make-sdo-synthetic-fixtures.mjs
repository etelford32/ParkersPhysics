#!/usr/bin/env node
/**
 * scripts/make-sdo-synthetic-fixtures.mjs — regenerate tests/fixtures/sdo/*
 *
 * Writes one SYNTHETIC frame per channel sun.html can wrap (white, mag, 171,
 * 193, 211, 131, 304) plus the two GOES/SUVI bands the off-limb layer's second
 * source draws (suvi304, suvi131), plus a manifest.json carrying the planted-feature ground
 * truth. See tests/fixtures/sdo/README.md — these are stand-ins with the
 * real browse-frame geometry, not observations. Replace with real frames via
 * scripts/fetch-sdo-fixtures.mjs on a machine that can reach nasa.gov.
 *
 * Also writes the two SOHO/LASCO coronagraph frames (c2, c3) that
 * js/sun-coronagraph.js draws beyond the EUV annulus — one synthetic corona
 * seen through both instruments' geometry, with the browse product's occulter
 * disc, limb circle, pylon and timestamp block.
 *
 *   node scripts/make-sdo-synthetic-fixtures.mjs [--size=512] [--only=c2,c3]
 *
 * `--only` regenerates just the named frames and MERGES them into the existing
 * manifest, leaving every other PNG and manifest entry byte-for-byte alone.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSyntheticDisk, renderSyntheticCoronagraph, encodePng, FIXTURE_EPOCH_ISO, PLANTED, PLANTED_OFFLIMB, PLANTED_CORONA } from './lib/sdo-synth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'tests', 'fixtures', 'sdo');
const size = Number((process.argv.find(a => a.startsWith('--size=')) || '--size=512').split('=')[1]);
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)) : null;
const want = (ch) => !only || only.has(ch);
mkdirSync(OUT, { recursive: true });

const MANIFEST = join(OUT, 'manifest.json');
const manifest = only && existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
    : { synthetic: true, generated: new Date().toISOString(), epoch: FIXTURE_EPOCH_ISO, size, planted: PLANTED, plantedOffLimb: PLANTED_OFFLIMB, frames: {} };
manifest.plantedCorona = PLANTED_CORONA;
// The two SUVI bands the off-limb layer draws are rendered too: same lines,
// SUVI's own plate scale, so the fixture set can exercise BOTH sources of
// js/sun-offlimb.js without reaching NOAA. See js/suvi-geometry.js.
for (const ch of ['white', 'mag', '171', '193', '211', '131', '304', 'suvi304', 'suvi131']) {
    if (!want(ch)) continue;
    const frame = renderSyntheticDisk(ch, { size });
    const name  = `synthetic_${ch}.png`;
    writeFileSync(join(OUT, name), encodePng(frame));
    manifest.frames[ch] = { file: name, ...frame.meta };
    console.log(`wrote ${name} (${frame.width}²)`);
}
// The coronagraph frames: a different product with a different geometry (the
// Sun is off-centre and tiny, the occulter is painted over), so they have
// their own renderer — but ONE synthetic corona feeds both.
for (const id of ['c2', 'c3']) {
    if (!want(id)) continue;
    const frame = renderSyntheticCoronagraph(id, { size });
    const name  = `synthetic_${id}.png`;
    writeFileSync(join(OUT, name), encodePng(frame));
    manifest.frames[id] = { file: name, size: frame.width, ...frame.meta };
    console.log(`wrote ${name} (${frame.width}²)`);
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote manifest.json');
