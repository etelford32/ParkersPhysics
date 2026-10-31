#!/usr/bin/env node
/**
 * bake-isobar-reference.mjs — provenance of tests/fixtures/isobar-contour-reference.json.
 *
 * The isobar contouring moved out of js/isobar-engine.js into the PURE
 * js/isobar-contour.js on 2026-10-31 so it could run in a Worker. This script
 * baked the reference from the PRE-MOVE layer (commit e063f2f), running
 * IsobarLayer.update on real three.js r160, so tests/isobar-contour.mjs can
 * assert the moved code is BIT-IDENTICAL without three in CI.
 *
 * Re-running it against today's engine would only test the module against
 * itself. To reproduce the original bake, in an empty scratch directory:
 *
 *   echo '{"type":"module"}' > package.json && npm i --no-save three@0.160.0
 *   mkdir -p js/geo
 *   git -C <repo> show e063f2f:js/isobar-engine.js > js/isobar-engine.js
 *   git -C <repo> show e063f2f:js/geo/coords.js    > js/geo/coords.js
 *   node <repo>/scripts/bake-isobar-reference.mjs > reference.json
 *
 * (run from that directory, so './js/isobar-engine.js' is the old file).
 */
import { createHash } from 'node:crypto';
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) }) }) };
const THREE = await import('three');
const { IsobarLayer } = await import(new URL('./js/isobar-engine.js', `file://${process.cwd()}/`).href);
const h = (a) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const fields = { waves: 'waves', lows: 'lows' };
const out = { generatedFrom: 'git HEAD e063f2f js/isobar-engine.js IsobarLayer.update on three r160 (scratch: npm i three@0.160.0)', fields: {} };
const F = {
  waves: (x, y) => 1012 + 18 * Math.sin(x / 30) * Math.cos(y / 25),
  lows:  (x, y) => 1013 - 30 * Math.exp(-((x - 200) ** 2 + (y - 130) ** 2) / 300) + 22 * Math.exp(-((x - 60) ** 2 + (y - 50) ** 2) / 500) + 4 * Math.sin(x / 7 + y / 11),
};
for (const name of Object.keys(F)) {
  const b = new Float32Array(360 * 180 * 4);
  for (let y = 0; y < 180; y++) for (let x = 0; x < 360; x++) b[(y * 360 + x) * 4 + 1] = (F[name](x, y) - 850) / 210;
  const layer = new IsobarLayer(new THREE.Group()); console.info = () => {}; layer.update(b);
  out.fields[name] = {
    segments: layer._lines.geometry.getAttribute('position').count / 2,
    positionsSha256: h(layer._lines.geometry.getAttribute('position').array),
    colorsSha256: h(layer._lines.geometry.getAttribute('color').array),
    extrema: layer.extrema.map((e, i) => ({ ...e, pos: { x: layer._sprites[i].position.x, y: layer._sprites[i].position.y, z: layer._sprites[i].position.z } })),
    stats: layer.stats,
  };
}
process.stdout.write(JSON.stringify(out, null, 1));
