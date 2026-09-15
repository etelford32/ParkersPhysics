/**
 * tests/hek-filaments.mjs — pins js/hek-filaments.js
 *
 *   node tests/hek-filaments.mjs
 *
 * WHY THIS FEED EXISTS AT ALL is in the module header: the cool-material
 * channel was supposed to be filled from magnetic dips in the PFSS atlas, and
 * that field has zero dips because it is a POTENTIAL field. Observations
 * replace them. So the gates here are about not lying with somebody else's
 * catalogue:
 *   • a detection with no position is DROPPED, never placed at disk centre
 *   • several detectors seeing the same filament is ONE filament, not five
 *     stacked copies (otherwise the render encodes attention, not material)
 *   • a length in the wrong unit lands on a clamp bound and is COUNTED
 *   • the spine is a GREAT CIRCLE, not a tangent-plane offset — a 60°
 *     filament drawn flat leaves the sphere entirely
 *   • field_map / unmapped_keys actually report what a live payload contained
 */
import assert from 'node:assert/strict';
import {
    R_SUN_ARCSEC, LENGTH_CLAMP_DEG, EVENT_TYPES, FIELD_CANDIDATES,
    HEIGHT_RSUN, SPINE_RADIUS_RSUN, DEFAULT_HALF_LENGTH_DEG,
    normalizeHekFilaments, dedupeFilaments, filamentSpine, coolMaterialLines,
    appendObservedFilaments, ATLAS_META_STRIDE,
} from '../js/hek-filaments.js';
import { readFileSync } from 'node:fs';

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('hek-filaments.mjs');

const DEG = Math.PI / 180;
const len = (v) => Math.hypot(v[0], v[1], v[2]);

/** A payload shaped the way HEK answers /hek/her?cosec=2. */
function payload(rows) { return { result: rows }; }

const ROW = {
    event_type: 'FI',
    hgs_x: '-32.4', hgs_y: '18.7',
    hgc_x: '221.0', hgc_y: '18.7',
    fi_length: '480.0', fi_tilt: '15.0', fi_chirality: '-1',
    frm_name: 'AAFDCC',
    event_starttime: '2026-09-15T04:12:00',
};

// ── Normalization ──────────────────────────────────────────────────────────

await ok('a well-formed row normalizes, with the proven position keys leading', () => {
    const r = normalizeHekFilaments(payload([ROW]));
    assert.equal(r.filaments.length, 1);
    const f = r.filaments[0];
    assert.equal(f.event_type, 'FI');
    assert.ok(Math.abs(f.lat_deg - 18.7) < 1e-9);
    assert.ok(Math.abs(f.lon_deg + 32.4) < 1e-9);
    assert.equal(f.frm_name, 'AAFDCC');
    // hgs_x/hgs_y are the names /api/hek/coronal-holes already uses in
    // production — they must stay at the head of their candidate lists.
    assert.equal(FIELD_CANDIDATES.lon_deg[0], 'hgs_x');
    assert.equal(FIELD_CANDIDATES.lat_deg[0], 'hgs_y');
    assert.equal(r.field_map.lat_deg, 'hgs_y');
    assert.equal(r.field_map.lon_deg, 'hgs_x');
    // arcsec → degrees of arc: 480" over a 959.63" radius.
    assert.ok(Math.abs(f.length_deg - (480 / R_SUN_ARCSEC) * (180 / Math.PI)) < 1e-9);
    assert.equal(r.length_clamped, 0);
});

await ok('field_map resolves from a LATER spelling when the first is absent', () => {
    // The whole point of candidate lists: a feed using a different name is
    // reported, not silently nulled.
    const alt = { event_type: 'PG', hgs_lat: 40, hgs_lon: 70, frm_name: 'X' };
    const r = normalizeHekFilaments(payload([alt]));
    assert.equal(r.field_map.lat_deg, 'hgs_lat');
    assert.equal(r.field_map.lon_deg, 'hgs_lon');
    assert.equal(r.filaments[0].lat_deg, 40);
    // Nothing claimed `fi_length`, so it is honestly null rather than 0.
    assert.equal(r.field_map.length_arcsec, null);
    assert.equal(r.filaments[0].length_deg, null);
});

await ok('unmapped_keys reports what nothing claimed — one request settles the schema', () => {
    const r = normalizeHekFilaments(payload([{ ...ROW, some_new_key: 1, another: 'x' }]));
    assert.ok(r.unmapped_keys.includes('some_new_key'));
    assert.ok(r.unmapped_keys.includes('another'));
    // And keys that WERE claimed must not appear.
    assert.ok(!r.unmapped_keys.includes('hgs_x'));
    assert.ok(!r.unmapped_keys.includes('fi_length'));
});

await ok('a detection with no usable position is DROPPED, never placed at disk centre', () => {
    const rows = [
        ROW,
        { event_type: 'FI', frm_name: 'no-position' },                 // nothing to place
        { event_type: 'FI', hgs_x: '500', hgs_y: '10' },               // impossible longitude
        { event_type: 'FI', hgs_x: '10', hgs_y: '400' },               // impossible latitude
        { event_type: 'CH', hgs_x: '10', hgs_y: '10' },                // not our event type
        null,
    ];
    const r = normalizeHekFilaments(payload(rows));
    assert.equal(r.filaments.length, 1, 'only the good row survives');
    assert.equal(r.dropped, 5);
    // A (0,0) placement would put a filament at disk centre every time HEK
    // published a row we could not read — the failure this guards.
    assert.ok(!r.filaments.some(f => f.lat_deg === 0 && f.lon_deg === 0));
});

await ok('a length in the wrong unit lands on a clamp bound and is COUNTED', () => {
    // A detector publishing Mm instead of arcsec: 300 Mm reads as 300" here,
    // and 300 000 would read as a filament wrapped several times round the Sun.
    const tiny = { ...ROW, fi_length: '1' };
    const huge = { ...ROW, fi_length: '300000' };
    const r = normalizeHekFilaments(payload([tiny, huge]));
    assert.equal(r.length_clamped, 2);
    assert.equal(r.filaments[0].length_deg, LENGTH_CLAMP_DEG.min);
    assert.equal(r.filaments[1].length_deg, LENGTH_CLAMP_DEG.max);
    // A real filament is NOT clamped — the guard must not fire on good data.
    // 50 000–800 000 km is 4°–66° of arc.
    for (const km of [50_000, 200_000, 800_000]) {
        const arcsec = (km / 695700) * R_SUN_ARCSEC;
        const one = normalizeHekFilaments(payload([{ ...ROW, fi_length: String(arcsec) }]));
        assert.equal(one.length_clamped, 0, `${km} km must not clamp`);
    }
});

await ok('a payload with no result array throws rather than serving an empty Sun', () => {
    assert.throws(() => normalizeHekFilaments(null), TypeError);
    assert.throws(() => normalizeHekFilaments({}), TypeError);
    assert.throws(() => normalizeHekFilaments({ result: 'nope' }), TypeError);
    // An EMPTY array is legitimate (a quiet day) and must not throw.
    const r = normalizeHekFilaments(payload([]));
    assert.equal(r.filaments.length, 0);
});

// ── De-duplication ─────────────────────────────────────────────────────────

await ok('several detectors seeing one filament is ONE filament', () => {
    // Otherwise the volume gets 5 stacked copies and the render encodes how
    // much ATTENTION a structure got rather than how much material it has.
    const base = { event_type: 'FI', lat_deg: 20, lon_deg: -30, length_deg: 12, tilt_deg: 10, frm_name: 'A' };
    const rows = [
        base,
        { ...base, lat_deg: 21.5, lon_deg: -31, frm_name: 'B' },       // same structure
        { ...base, lat_deg: 19.0, lon_deg: -28.5, frm_name: 'C' },     // same structure
        { ...base, lat_deg: -40, lon_deg: 80, frm_name: 'D' },         // a different one
    ];
    const d = dedupeFilaments(rows);
    assert.equal(d.length, 2);
    assert.equal(d[0].detections, 3, 'and it remembers how many saw it');
    assert.equal(d[1].detections, 1);
    assert.ok(!('_v' in d[0]), 'the working vector does not leak into the output');
});

await ok('de-dup keeps the most completely described row', () => {
    const sparse = { event_type: 'FI', lat_deg: 0, lon_deg: 0, length_deg: null, tilt_deg: null, frm_name: 'sparse' };
    const full   = { event_type: 'FI', lat_deg: 1, lon_deg: 1, length_deg: 15, tilt_deg: 20, frm_name: 'full' };
    const a = dedupeFilaments([sparse, full]);
    assert.equal(a.length, 1);
    assert.equal(a[0].frm_name, 'full', 'the row with geometry wins whichever order it arrives in');
    const b = dedupeFilaments([full, sparse]);
    assert.equal(b[0].frm_name, 'full');
    assert.equal(b[0].detections, 2);
});

await ok('de-dup uses the SPHERE, not raw degrees', () => {
    // Near the pole two rows 60° apart in longitude are a few degrees apart on
    // the sphere; a naive |Δlon| test would call them different filaments.
    const near = dedupeFilaments([
        { event_type: 'FI', lat_deg: 86, lon_deg: 0 },
        { event_type: 'FI', lat_deg: 86, lon_deg: 60 },
    ]);
    assert.equal(near.length, 1, 'polar rows merge');
    // And at the equator the same 60° really is far apart.
    const far = dedupeFilaments([
        { event_type: 'FI', lat_deg: 0, lon_deg: 0 },
        { event_type: 'FI', lat_deg: 0, lon_deg: 60 },
    ]);
    assert.equal(far.length, 2, 'equatorial rows do not');
});

// ── Spine geometry ─────────────────────────────────────────────────────────

await ok('the spine sits at prominence height, above the photosphere and below the corona', () => {
    const fil = { event_type: 'FI', lat_deg: 25, lon_deg: -40, length_deg: 20, tilt_deg: 12 };
    const pts = filamentSpine(fil);
    assert.equal(pts.length, 12);
    for (const p of pts) {
        const r = len(p);
        assert.ok(r > 1.0, 'above the photosphere — a filament is not inside the Sun');
        assert.ok(r < 1.1, `and in the observed band, got ${r.toFixed(4)}`);
        assert.ok(Math.abs(r - (1 + HEIGHT_RSUN.filament)) < 1e-9, 'at a constant height');
    }
    // A limb PROMINENCE is placed higher than an on-disk filament, because a
    // PG detection is one that was seen ABOVE the limb.
    const prom = filamentSpine({ ...fil, event_type: 'PG' });
    assert.ok(len(prom[0]) > len(pts[0]));
    assert.ok(Math.abs(len(prom[0]) - (1 + HEIGHT_RSUN.prominence)) < 1e-9);
});

await ok('THE SPINE IS A GREAT CIRCLE, not a tangent-plane offset', () => {
    // A 60° filament laid out on the tangent plane leaves the sphere entirely:
    // the endpoint would sit at r = 1/cos(30°) = 1.155 instead of 1.
    const long = { event_type: 'FI', lat_deg: 0, lon_deg: 0, length_deg: 60, tilt_deg: 0 };
    const pts = filamentSpine(long, { samples: 21 });
    const rs = pts.map(len);
    const spread = Math.max(...rs) - Math.min(...rs);
    assert.ok(spread < 1e-9, `constant radius along the spine, spread ${spread.toExponential(2)}`);
    // The arc really is 60° end to end.
    const a = pts[0].map(v => v / rs[0]);
    const b = pts[pts.length - 1].map(v => v / rs[rs.length - 1]);
    const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(Math.acos(cos) / DEG - 60) < 1e-6, `arc is ${(Math.acos(cos) / DEG).toFixed(3)}°`);
});

await ok('the spine is centred on the detection and points where the tilt says', () => {
    const fil = { event_type: 'FI', lat_deg: 0, lon_deg: 0, length_deg: 20, tilt_deg: 0 };
    const pts = filamentSpine(fil, { samples: 3 });
    const mid = pts[1].map(v => v / len(pts[1]));
    // Centre of a zero-lat/lon filament is +z in the page's convention.
    assert.ok(Math.abs(mid[0]) < 1e-9 && Math.abs(mid[1]) < 1e-9 && Math.abs(mid[2] - 1) < 1e-9);
    // tilt 0 ⇒ along EAST, which at lon 0 is +x: the ends differ in x, not y.
    assert.ok(Math.abs(pts[2][0] - pts[0][0]) > 0.1);
    assert.ok(Math.abs(pts[2][1] - pts[0][1]) < 1e-9, 'no north component at tilt 0');
    // tilt 90 ⇒ along NORTH: the ends differ in y, not x.
    const n = filamentSpine({ ...fil, tilt_deg: 90 }, { samples: 3 });
    assert.ok(Math.abs(n[2][1] - n[0][1]) > 0.1);
    assert.ok(Math.abs(n[2][0] - n[0][0]) < 1e-9, 'no east component at tilt 90');
});

await ok('a filament with no length still draws, at the stated default', () => {
    // HEK rows without fi_length are common. Skipping them would drop real
    // structures; inventing a huge one would be worse.
    const pts = filamentSpine({ event_type: 'FI', lat_deg: 10, lon_deg: 10 }, { samples: 3 });
    const a = pts[0].map(v => v / len(pts[0]));
    const b = pts[2].map(v => v / len(pts[2]));
    const arcDeg = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / DEG;
    assert.ok(Math.abs(arcDeg - DEFAULT_HALF_LENGTH_DEG * 2) < 1e-6, `default arc ${arcDeg.toFixed(2)}°`);
});

await ok('coolMaterialLines hands the rasteriser one weighted line per STRUCTURE', () => {
    const fils = dedupeFilaments([
        { event_type: 'FI', lat_deg: 20, lon_deg: -30, length_deg: 12, tilt_deg: 0 },
        { event_type: 'FI', lat_deg: 21, lon_deg: -31, length_deg: 12, tilt_deg: 0 },
        { event_type: 'PG', lat_deg: -50, lon_deg: 120, length_deg: 20, tilt_deg: 30 },
    ]);
    const lines = coolMaterialLines(fils);
    assert.equal(lines.length, 2);
    for (const l of lines) {
        assert.ok(l.points.length >= 2);
        assert.equal(l.radius, SPINE_RADIUS_RSUN);
        // WEIGHT IS PER STRUCTURE. A filament three detectors happened to see
        // must not be three times as dense as one nobody looked at twice.
        assert.equal(l.weight, 1);
    }
    assert.equal(lines[0].eventType, 'FI');
    assert.equal(lines[1].eventType, 'PG');
    assert.equal(coolMaterialLines(null).length, 0, 'no filaments is not a crash');
});

await ok('the accepted event types are the cool-plasma ones, and only those', () => {
    assert.deepEqual([...EVENT_TYPES], ['FI', 'FA', 'PG']);
    // FI and PG describe the SAME plasma seen in two places, which is why the
    // renderer carries one channel for both.
    assert.ok(EVENT_TYPES.includes('FI') && EVENT_TYPES.includes('PG'));
});

// ── Joining the atlas the prominence bundles draw ──────────────────────────

await ok('observed filaments append to a traced atlas as PIL-seeded closed lines', async () => {
    // The bundle renderer draws seedKind === 2 (PIL) closed lines, and the
    // Rust tracer only makes those near an ACTIVE REGION — so without this the
    // page could only ever show active-region filaments and never a quiescent
    // polar-crown one. The appended lines must be indistinguishable in SHAPE
    // and distinguishable in PROVENANCE.
    const N = 16;
    const traced = {
        lineCount: 2, samplesPerLine: N,
        positions: new Float32Array(2 * N * 3).fill(1),
        tangents: new Float32Array(2 * N * 3),
        meta: new Float32Array(2 * 8),
    };
    traced.meta[2] = 7;                                  // a traced line with an AR index
    const fils = dedupeFilaments([
        { event_type: 'FI', lat_deg: 62, lon_deg: 15, length_deg: 30, tilt_deg: 5 },
        { event_type: 'PG', lat_deg: -70, lon_deg: 200, length_deg: 18, tilt_deg: 0 },
    ]);
    const out = appendObservedFilaments(traced, coolMaterialLines(fils, { samples: N }));

    assert.equal(out.lineCount, 4, 'two traced + two observed');
    assert.equal(out.samplesPerLine, N, 'every line shares the stride the textures need');
    assert.equal(out.observedFilaments, 2);
    assert.equal(out.positions.length, 4 * N * 3);
    // The traced lines are carried through untouched.
    assert.equal(out.meta[2], 7);
    assert.equal(out.positions[0], 1);
    for (let k = 2; k < 4; k++) {
        const m = k * 8;
        assert.equal(out.meta[m], 0, 'closed');
        assert.equal(out.meta[m + 1], 2, 'PIL seed kind — the classifier draws these');
        assert.equal(out.meta[m + 2], -1, 'arIndex -1 marks it OBSERVED, not traced');
        assert.ok(out.meta[m + 3] > 0 && out.meta[m + 3] < 0.2, 'apex is a prominence height');
        assert.ok(out.meta[m + 4] > 0, 'length is measured from the resampled curve');
        assert.equal(out.meta[m + 7], 0, 'a detection carries no twist');
        // Every sample sits above the photosphere and carries a unit tangent.
        for (let i = 0; i < N; i++) {
            const o = (k * N + i) * 3;
            const r = Math.hypot(out.positions[o], out.positions[o + 1], out.positions[o + 2]);
            assert.ok(r > 1 && r < 1.1, `sample ${i} at r=${r.toFixed(4)}`);
            const t = Math.hypot(out.tangents[o], out.tangents[o + 1], out.tangents[o + 2]);
            assert.ok(Math.abs(t - 1) < 1e-5, `unit tangent, got ${t}`);
        }
    }
});

await ok('observed filaments can stand alone — a spotless Sun still shows them', async () => {
    // The tracer produces NOTHING without active regions, which is exactly the
    // Sun that is covered in quiescent filaments. An early return on a missing
    // atlas would have thrown every one of them away.
    const fils = [{ event_type: 'FI', lat_deg: 55, lon_deg: 0, length_deg: 40, tilt_deg: 0 }];
    const out = appendObservedFilaments(null, coolMaterialLines(fils, { samples: 24 }), { samplesPerLine: 24 });
    assert.equal(out.lineCount, 1);
    assert.equal(out.samplesPerLine, 24);
    assert.equal(out.meta[2], -1);
    // And nothing to append is a no-op, not a crash or an empty atlas.
    const passthrough = { lineCount: 3, samplesPerLine: 8, positions: new Float32Array(72), tangents: new Float32Array(72), meta: new Float32Array(24) };
    assert.equal(appendObservedFilaments(passthrough, []), passthrough);
    assert.equal(appendObservedFilaments(passthrough, null), passthrough);
});

await ok('the atlas meta stride mirrors js/field-atlas.js', () => {
    // Two copies, because field-atlas.js imports three.js and is therefore
    // unreachable from node. Read the other file's source rather than trusting
    // a comment — a silent drift here writes every observed filament's meta
    // into the wrong slots.
    const src = readFileSync(new URL('../js/field-atlas.js', import.meta.url), 'utf8');
    const m = /const META_STRIDE = (\d+)/.exec(src);
    assert.ok(m, 'field-atlas.js still declares META_STRIDE');
    assert.equal(Number(m[1]), ATLAS_META_STRIDE, 'the two copies agree');
});

console.log(`\n${passed} checks passed`);
