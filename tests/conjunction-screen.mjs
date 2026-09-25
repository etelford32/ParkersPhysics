/**
 * conjunction-screen.mjs — SatelliteTracker's conjunction screen, in Node.
 * ═══════════════════════════════════════════════════════════════════════════
 * Pins two bugs found together on 2026-09-24 (browser gate:
 * tests/conjunction-monitor.spec.js):
 *   1. a HEADLESS tracker (`new SatelliteTracker(null, …)`, how
 *      js/conjunction-alert.js builds one) threw in its constructor, so the
 *      alert engine's conjunction monitor never screened anything;
 *   2. the JS-fallback screen built the target track with Float64Array#map,
 *      which coerces every {x,y,z} to NaN — it returned [] for every query
 *      whenever the SGP4 WASM was not loaded (always, in Node).
 * Checked against CLOSED FORM: two objects on the same orbit separated by Δθ
 * of mean anomaly stay a chord 2a·sin(Δθ/2) apart (identical J2 rates, and
 * the orbit is near-circular).
 *
 * Run: node tests/conjunction-screen.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

const THREE_URL = new URL('../js/vendor/three-0.160.0/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
        if (spec === 'three') return { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true };
        return next(spec, ctx);
    }`));
// The tracker dispatches window events on load; give Node a window.
const bus = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = bus.addEventListener.bind(bus);
globalThis.dispatchEvent = bus.dispatchEvent.bind(bus);

const { issRecord } = await import('./fixtures/climate-lab-fixtures.mjs');
const { SatelliteTracker } = await import('../js/satellite-tracker.js');

const now = Date.now();
const target = issRecord(now);
const DTH_NEAR = 0.04, DTH_FAR = 90;
const recs = [
    target,
    issRecord(now, { norad: 90001, name: 'NEAR', meanAnomaly: 270 - DTH_NEAR }),
    issRecord(now, { norad: 90002, name: 'FAR', meanAnomaly: 270 - DTH_FAR }),
];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ satellites: recs, count: recs.length }) });

let tracker;
assert.doesNotThrow(() => { tracker = new SatelliteTracker(null, 1.0); }, 'headless construction');
assert.equal(tracker._headless, true);
assert.equal(tracker._worker, null, 'no render-propagation worker when headless');
assert.equal(await tracker.loadGroup('active'), 3);

const a = target.sma_km;
assert.ok(a > 6700 && a < 6900, `ISS semi-major axis ${a}`);
const chord = (deg) => 2 * a * Math.sin((deg * Math.PI / 180) / 2);

const all = await tracker.screenConjunctions(25544, 24, 10, 1e6);
const byId = Object.fromEntries(all.map((c) => [c.norad_id, c]));
assert.ok(byId[90001] && byId[90002], `both objects screened: ${JSON.stringify(all.map((c) => c.norad_id))}`);
assert.ok(Math.abs(byId[90001].dist_km - chord(DTH_NEAR)) < 0.1, `near miss ${byId[90001].dist_km} km vs chord ${chord(DTH_NEAR).toFixed(2)}`);
assert.ok(Math.abs(byId[90002].dist_km - chord(DTH_FAR)) / chord(DTH_FAR) < 0.01, `far miss ${byId[90002].dist_km} km vs chord ${chord(DTH_FAR).toFixed(0)}`);
assert.ok(byId[90001].dv_kms < 0.01, `co-orbital relative speed ${byId[90001].dv_kms} km/s`);

const within = await tracker.screenConjunctions(25544, 24, 10, 25);
assert.deepEqual(within.map((c) => c.norad_id), [90001], 'the 25 km threshold keeps only the near object');

console.log(`conjunction-screen: ALL PASS (near ${byId[90001].dist_km} km, far ${byId[90002].dist_km} km)`);
process.exit(0);   // the tracker holds timers open
