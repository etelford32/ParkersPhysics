/**
 * orbital-analytics-passes.mjs — satellites.html's pass list, in Node.
 * ═══════════════════════════════════════════════════════════════════════════
 * satellites.html feeds predictPasses (js/orbital-analytics.js) the Kepler +
 * J2 propagator exported from js/satellite-tracker.js. It used to pass an
 * inline copy that referenced TWOPI / MIN_PER_DAY / DEG2RAD — constants that
 * are private to satellite-tracker.js — so the list threw a ReferenceError
 * for every visitor with a saved location (browser gate:
 * tests/satellites-passes.spec.js). This pins the pair's OUTPUT: an ISS over
 * Boulder gets several passes a day, each physically LEO-shaped.
 *
 * Run: node tests/orbital-analytics-passes.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

// satellite-tracker.js imports the bare specifier 'three' (the browser's
// import map). Resolve it to the vendored build, as the page does.
const THREE_URL = new URL('../js/vendor/three-0.160.0/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
        if (spec === 'three') return { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true };
        return next(spec, ctx);
    }`));
const { predictPasses } = await import('../js/orbital-analytics.js');
const { jsFallbackPropagate } = await import('../js/satellite-tracker.js');
const { issRecord } = await import('./fixtures/climate-lab-fixtures.mjs');

const BOULDER = { lat: 40.015, lon: -105.271 };
const iss = issRecord(Date.now());

assert.deepEqual(predictPasses(iss, BOULDER.lat, BOULDER.lon, 0, 24, 10), [], 'no propagator → no passes, not a throw');

const t0 = Date.now();
const passes = predictPasses(iss, BOULDER.lat, BOULDER.lon, 0, 24, 10, jsFallbackPropagate);
// ISS (51.6°) over 40°N: typically 4–6 passes above 10° in 24 h.
assert.ok(passes.length >= 2 && passes.length <= 10, `ISS passes in 24 h: ${passes.length}`);
let prevSet = 0;
for (const p of passes) {
    const rise = Date.parse(p.rise_utc), set = Date.parse(p.set_utc);
    assert.ok(rise < set, 'rise before set');
    assert.ok(rise >= t0 - 60_000 && set <= t0 + 24.1 * 3_600_000, 'inside the 24 h window');
    assert.ok(rise >= prevSet, 'chronological, non-overlapping');
    prevSet = set;
    // Above 10° an ISS pass lasts minutes, never tens of minutes.
    assert.ok(p.duration_min >= 1 && p.duration_min <= 10, `duration ${p.duration_min} min`);
    assert.equal(Math.round((set - rise) / 60_000), p.duration_min, 'duration matches rise/set');
    assert.ok(p.max_elev_deg >= 10 && p.max_elev_deg <= 90, `max elevation ${p.max_elev_deg}°`);
}
// Consecutive visible passes are about one orbit (~92 min) apart or more.
for (let i = 1; i < passes.length; i++) {
    const gap = (Date.parse(passes[i].rise_utc) - Date.parse(passes[i - 1].rise_utc)) / 60_000;
    assert.ok(gap >= 80, `passes ${gap.toFixed(0)} min apart`);
}
console.log(`orbital-analytics-passes: ALL PASS (${passes.length} ISS passes, ${passes.map((p) => p.duration_min + 'm').join(' ')})`);
