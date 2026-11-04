/**
 * Gate for js/horizons.js's JPL Horizons VECTORS query (`horizonsVectorParams`,
 * the `_horizonsParams` builder behind EphemerisService.load()).
 *
 *   node tests/horizons-params.mjs
 *
 * Pinned:
 *   1. THE FRAME PARAMETER IS `REF_PLANE=ECLIPTIC` AND THERE IS NO `REF_FRAME`.
 *      `REF_FRAME` is not a Horizons API parameter — the API answers HTTP 400
 *      "one or more query parameter was not recognized" to any unknown name,
 *      so with it every EphemerisService call failed and the service ran
 *      silently on its Meeus fallback (measured 2026-11-03 against the
 *      production /api/horizons proxy; REF_PLANE=ECLIPTIC with the default
 *      REF_SYSTEM=ICRF returns "Reference frame: Ecliptic of J2000.0").
 *      api/health.js sends no frame parameter, which is why status.html never
 *      saw it. js/mission-ephemeris.js spells it the same way.
 *   2. The parser's contract survives: VECTORS, VEC_TABLE 2 (position +
 *      velocity), VEC_LABELS YES (`_parseVec` reads the labelled `X = …`
 *      form), CAL_FORMAT BOTH, OBJ_DATA NO, format json; COMMAND and CENTER
 *      pass through untouched.
 *   3. A JD becomes a one-day [START_TIME, STOP_TIME) window at 1 d, and the
 *      no-JD call uses today.
 *   4. The module SOURCE never spells `REF_FRAME:` as a key again (the note
 *      beside the builder may name it in prose; a key is the regression).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { horizonsVectorParams, jdFromDate } from '../js/horizons.js';
import { horizonsQuery } from '../js/mission-ephemeris.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
console.log('horizons-params.mjs');

const JD0 = 2461347.5;   // 2026-11-03 00:00 UTC
const P = horizonsVectorParams('399', '500@10', JD0);
const keys = [...P.keys()];

ok('frame is REF_PLANE=ECLIPTIC and REF_FRAME is absent', () => {
    assert.equal(P.get('REF_PLANE'), 'ECLIPTIC');
    assert.equal(P.has('REF_FRAME'), false);
    assert.equal(P.has('REF_SYSTEM'), false);   // ICRF default ⇒ J2000 ecliptic
});

ok('no key outside the documented Horizons VECTORS parameter set', () => {
    const KNOWN = new Set(['format', 'COMMAND', 'EPHEM_TYPE', 'CENTER', 'START_TIME', 'STOP_TIME',
        'STEP_SIZE', 'VEC_TABLE', 'VEC_LABELS', 'OBJ_DATA', 'REF_PLANE', 'CAL_FORMAT']);
    for (const k of keys) assert.ok(KNOWN.has(k), `unknown Horizons parameter ${k} (the API 400s on it)`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
});

ok('the parser contract: labelled VEC_TABLE 2 vectors, json, no object data', () => {
    assert.equal(P.get('format'), 'json');
    assert.equal(P.get('EPHEM_TYPE'), 'VECTORS');
    assert.equal(P.get('VEC_TABLE'), '2');
    assert.equal(P.get('VEC_LABELS'), 'YES');
    assert.equal(P.get('CAL_FORMAT'), 'BOTH');
    assert.equal(P.get('OBJ_DATA'), 'NO');
    assert.equal(P.get('STEP_SIZE'), '1d');
});

ok('COMMAND and CENTER pass through as given', () => {
    assert.equal(P.get('COMMAND'), '399');
    assert.equal(P.get('CENTER'), '500@10');
    const moon = horizonsVectorParams('301', '500@399', JD0);
    assert.equal(moon.get('COMMAND'), '301');
    assert.equal(moon.get('CENTER'), '500@399');
});

ok('a JD becomes a one-day calendar window; no JD means today', () => {
    assert.equal(P.get('START_TIME'), '2026-11-03');
    assert.equal(P.get('STOP_TIME'), '2026-11-04');
    const today = new Date();
    const live = horizonsVectorParams('399', '500@10');
    assert.equal(live.get('START_TIME'), today.toISOString().slice(0, 10));
    const back = horizonsVectorParams('599', '500@10', jdFromDate(new Date('2024-05-10T12:00:00Z')));
    assert.equal(back.get('START_TIME'), '2024-05-10');
    assert.equal(back.get('STOP_TIME'), '2024-05-11');
});

ok('spelled the same way as js/mission-ephemeris.js (the two kernels stay in step)', () => {
    const m = horizonsQuery('-96', JD0);
    assert.equal(m.get('REF_PLANE'), P.get('REF_PLANE'));
    assert.equal(m.has('REF_FRAME'), false);
});

ok('the module source carries no REF_FRAME key', () => {
    const src = fs.readFileSync(new URL('../js/horizons.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /REF_FRAME\s*:/, 'REF_FRAME is back as a query key');
    assert.match(src, /REF_PLANE\s*:\s*'ECLIPTIC'/);
});

console.log(`horizons-params.mjs: ${n} checks passed`);
