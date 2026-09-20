#!/usr/bin/env node
/**
 * star-collider-catalog.mjs — the real-object catalog and its interaction layer.
 *
 *   node tests/star-collider-catalog.mjs
 *
 * Every object must be well-formed with provenance; every pair must reference
 * objects that exist; and resolving an object through an EOS must produce the
 * numbers the literature does (J0740 does not fit on SLy; the fastest pulsar's
 * χ from I–Love is ~0.3; Cygnus X-1's ISCO is ~2 gravitational radii).
 */

import assert from 'node:assert/strict';
import { OBJECTS, OBJECT_IDS, PAIRS, objectById, pairById, resolveProfile, resolveAll } from '../js/star-collider/catalog.js';
import { EOS_IDS } from '../js/star-collider/eos.js';

let passed = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); passed++; };
const within = (v, target, rel, what) =>
    assert.ok(Math.abs(v - target) <= rel * Math.abs(target), `${what}: ${v} vs ${target}`);

ok('catalog has 10–25 objects, unique ids, provenance on every one', () => {
    assert.ok(OBJECTS.length >= 10 && OBJECTS.length <= 25, `${OBJECTS.length} objects`);
    assert.equal(new Set(OBJECT_IDS).size, OBJECTS.length, 'duplicate ids');
    for (const o of OBJECTS) {
        assert.ok(['ns', 'bh', 'wd'].includes(o.kind), `${o.id} kind`);
        assert.ok(o.mass && o.mass.value > 0 && ['measured', 'assumed'].includes(o.mass.source), `${o.id} mass`);
        assert.ok(o.mass.how, `${o.id} mass.how`);
        assert.ok(Array.isArray(o.sources) && o.sources.length > 0, `${o.id} sources`);
        assert.ok(o.blurb && o.blurb.length > 40, `${o.id} blurb`);
        if (o.kind === 'bh') assert.ok(o.chi && typeof o.chi.value === 'number', `${o.id} chi`);
        if (o.radiusKm) assert.ok(o.radiusKm.value > 0 && o.radiusKm.plus >= 0 && o.radiusKm.minus >= 0, `${o.id} radius`);
    }
    const kinds = new Set(OBJECTS.map(o => o.kind));
    assert.ok(kinds.has('ns') && kinds.has('bh') && kinds.has('wd'), 'all three kinds present');
    assert.ok(OBJECTS.filter(o => o.mass.source === 'assumed').length >= 2, 'assumed masses are declared, not hidden');
});

ok('every pair references two existing objects and carries a blurb', () => {
    assert.ok(PAIRS.length >= 6, `${PAIRS.length} pairs`);
    for (const p of PAIRS) {
        assert.ok(objectById(p.a) && objectById(p.b), `${p.id} objects`);
        assert.ok(p.blurb, `${p.id} blurb`);
        if (p.orbit) assert.ok(p.orbit.periodS > 0 && p.orbit.e >= 0 && p.orbit.e < 1, `${p.id} orbit`);
    }
    assert.ok(pairById('gw170817') && pairById('hulse-taylor'));
});

ok('a NICER pulsar resolves with measured R displayed and the EOS radius compared', () => {
    const p = resolveProfile(objectById('j0030'), 'SLy');
    assert.equal(p.kind, 'ns');
    assert.equal(p.radiusSource, 'measured');
    within(p.radiusKm, 12.71, 1e-9, 'measured R kept');
    assert.ok(p.eosRadiusKm > 11 && p.eosRadiusKm < 12.5, `SLy R(1.34) = ${p.eosRadiusKm}`);
    assert.ok(p.notes.some(n => /consistent within 1σ/.test(n)), p.notes.join(' | '));
    assert.ok(p.Lambda > 200 && p.Lambda < 600, `Λ = ${p.Lambda}`);
    assert.ok(p.chi > 0.05 && p.chi < 0.3, `χ from 4.87 ms = ${p.chi}`);
    assert.ok(p.I_cgs > 8e44 && p.I_cgs < 2e45, `I = ${p.I_cgs}`);
    assert.equal(p.eosSupported, true);
});

ok('PSR J0740+6620 cannot be built on SLy (flagged), can on MPA1', () => {
    const a = resolveProfile(objectById('j0740'), 'SLy');
    assert.equal(a.eosSupported, false);
    assert.ok(a.notes.some(n => /cannot build/.test(n)));
    const b = resolveProfile(objectById('j0740'), 'MPA1');
    assert.equal(b.eosSupported, true);
    within(b.star.M, 2.08, 1e-3, 'M');
    assert.ok(b.Lambda < 80, `Λ(2.08, MPA1) = ${b.Lambda}`);
});

ok('the fastest pulsar has χ ≈ 0.3 from I–Love; the magnetar is slow', () => {
    const f = resolveProfile(objectById('j1748'), 'SLy');
    assert.ok(f.chi > 0.2 && f.chi < 0.5, `χ(716 Hz) = ${f.chi}`);
    assert.equal(f.massSource, 'assumed');
    const m = resolveProfile(objectById('sgr1806'), 'SLy');
    assert.ok(m.chi < 1e-3, `χ(7.55 s) = ${m.chi}`);
    assert.equal(m.bFieldG, 2e15);
});

ok('black holes carry horizon and ISCO; Cygnus X-1 at χ = 0.95 has ISCO ≈ 1.94 M', () => {
    const c = resolveProfile(objectById('cygx1'), 'SLy');
    assert.equal(c.kind, 'bh');
    assert.equal(c.Lambda, 0);
    within(c.iscoKm / (c.M * 1.4766), 1.94, 0.02, 'r_isco/M');
    within(c.horizonKm / (c.M * 1.4766), 1 + Math.sqrt(1 - 0.95 ** 2), 1e-3, 'r_+/M');
});

ok('the white dwarf resolves Newtonian: C ~ 3×10⁻⁴, Λ astronomically large', () => {
    const w = resolveProfile(objectById('siriusb'), 'SLy');
    assert.equal(w.kind, 'wd');
    assert.ok(w.compactness > 2e-4 && w.compactness < 4e-4, `C = ${w.compactness}`);
    assert.ok(w.Lambda > 1e15, `Λ = ${w.Lambda}`);
});

ok('a custom object resolves, and the kind override turns the GW190814 secondary into a black hole', () => {
    const c = resolveProfile({ kind: 'ns', mass: 1.5, spinPeriodS: 0.01 }, 'APR4');
    assert.equal(c.id, 'custom');
    assert.ok(c.radiusKm > 10 && c.radiusKm < 13);
    const g = resolveProfile({ ...objectById('gw190814b'), kindOverride: 'bh' }, 'SLy');
    assert.equal(g.kind, 'bh');
    assert.ok(g.horizonKm > 7 && g.horizonKm < 8, `r_+ = ${g.horizonKm} km`);
});

ok('every object resolves on every EOS without throwing', () => {
    for (const eos of EOS_IDS) {
        const all = resolveAll(eos);
        assert.equal(all.length, OBJECTS.length);
        for (const p of all) {
            assert.ok(Number.isFinite(p.radiusKm) && p.radiusKm > 0, `${p.id} on ${eos} radius`);
            assert.ok(Number.isFinite(p.Lambda), `${p.id} on ${eos} Λ`);
            assert.ok(Number.isFinite(p.chi), `${p.id} on ${eos} χ`);
        }
    }
});

console.log(`✅ star-collider-catalog: ${passed} checks passed`);
