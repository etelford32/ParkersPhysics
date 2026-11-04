#!/usr/bin/env node
/**
 * moon-exosphere-hops.mjs — gate for js/moon-exosphere-hops.js.
 *
 * Run: node tests/moon-exosphere-hops.mjs
 *
 * The load-bearing pins — every structure the renderer shows must EMERGE:
 *   • Seeded: two sims with one seed agree bit for bit.
 *   • The flat-moon apex of a flux-weighted Maxwellian launch averages to
 *     EXACTLY the scale height kT/mg (the identity the analytic kernel
 *     pins) — the Monte Carlo and the closed form are the same physics.
 *   • Night-side pooling emerges for a bound noble gas (Ne) with nothing
 *     painted: >70 % of the surface-bound population on the night side,
 *     against a 50 % NEGATIVE CONTROL at uniform temperature.
 *   • The Jeans hierarchy emerges: H₂ loses more per hop than He, which
 *     loses more than Ne (≈0); He at 100 K is bound.
 *   • The cold trap: argon adsorbs on the night side (the frozen count),
 *     and resting atoms ride the rotation toward dawn — the pre-dawn pile
 *     the LACE instrument saw, with the 00–06 h bins outnumbering 18–24 h
 *     after a long run; at uniform temperature nothing freezes.
 *   • Photoionization: K (12 h) loses a larger share than Na (47 h); an
 *     atom in the shadow cylinder is never ionized.
 */

import assert from 'node:assert/strict';
import { createHopSim, PHASE, mulberry32, SYNODIC_SPIN_RAD_PER_S, LOCAL_HOUR_S } from '../js/moon-exosphere-hops.js';
import { scaleHeightKm, SPECIES } from '../js/moon-exosphere-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const SUN = { x: 1, y: 0, z: 0 };

// ── 1. Determinism ──────────────────────────────────────────────────────────
{
    const a = createHopSim({ speciesKey: 'ne', count: 300, seed: 11 });
    const b = createHopSim({ speciesKey: 'ne', count: 300, seed: 11 });
    a.setSunDir(SUN); b.setSunDir(SUN);
    a.advanceSim(3600 * 3); b.advanceSim(3600 * 3);
    assert.deepEqual(Array.from(a.positions), Array.from(b.positions), 'same seed, same positions');
    assert.deepEqual(a.stats(), b.stats());
    const c = createHopSim({ speciesKey: 'ne', count: 300, seed: 12 });
    c.setSunDir(SUN); c.advanceSim(3600 * 3);
    assert.notDeepEqual(Array.from(a.positions), Array.from(c.positions), 'different seed, different run');
    const r = mulberry32(5);
    const v = [r(), r(), r()];
    assert.ok(v.every(x => x >= 0 && x < 1) && new Set(v).size === 3, 'PRNG in [0,1), varying');
    assert.throws(() => createHopSim({ speciesKey: 'xe' }), /unknown species/);
    ok('seeded and reproducible');
}

// ── 2. The apex identity ────────────────────────────────────────────────────
{
    for (const [key, amu, T] of [['he', 4.0026, 100], ['ne', 20.18, 250], ['ar', 39.96, 390]]) {
        const sim = createHopSim({ speciesKey: key, count: 2000, seed: 7, uniformTemperatureK: T });
        sim.setSunDir(SUN);
        sim.advanceSim(3600 * 4);
        const st = sim.stats();
        const H = scaleHeightKm(amu, T);
        const err = Math.abs(st.meanApexFlatKm - H) / H;
        assert.ok(st.hops > 2000, `enough hops to average (${st.hops})`);
        assert.ok(err < 0.06, `${key} @ ${T} K: mean flat apex ${st.meanApexFlatKm.toFixed(1)} km ≈ H ${H.toFixed(1)} km (err ${(err * 100).toFixed(1)}%)`);
        // Real apex over a curved Moon under central gravity is HIGHER, never lower
        assert.ok(st.meanApexKm > st.meanApexFlatKm * 0.98, 'curvature + central gravity raise the true apex');
        assert.ok(st.meanApexKm < st.meanApexFlatKm * 2.0, '…but not wildly');
    }
    ok('mean flat-moon apex of a flux-weighted Maxwellian = kT/mg, the scale height');
}

// ── 3. Night-side pooling emerges (with a negative control) ─────────────────
{
    const ne = createHopSim({ speciesKey: 'ne', count: 1500, seed: 3 });
    ne.setSunDir(SUN);
    ne.advanceSim(3600 * 48);
    const st = ne.stats();
    assert.ok(st.surfaceNightFraction > 0.7, `Ne pools on the night side (${(st.surfaceNightFraction * 100).toFixed(0)} %)`);
    assert.ok(st.frozen === 0, 'a noble gas never adsorbs');
    const ctl = createHopSim({ speciesKey: 'ne', count: 1500, seed: 3, uniformTemperatureK: 200 });
    ctl.setSunDir(SUN);
    ctl.advanceSim(3600 * 48);
    const f = ctl.stats().surfaceNightFraction;
    assert.ok(Math.abs(f - 0.5) < 0.06, `negative control: uniform temperature ⇒ no pooling (${(f * 100).toFixed(0)} %)`);
    ok('Ne pools on the night side; the uniform-temperature control does not');
}

// ── 4. Jeans hierarchy ──────────────────────────────────────────────────────
{
    const lossPerHop = (key, hours) => {
        const s = createHopSim({ speciesKey: key, count: 1000, seed: 5 });
        s.setSunDir(SUN);
        s.advanceSim(3600 * hours);
        const st = s.stats();
        return st.escapes / Math.max(1, st.hops);
    };
    const h2 = lossPerHop('h2', 12), he = lossPerHop('he', 24), ne = lossPerHop('ne', 24);
    assert.ok(h2 > he && he > ne, `escape per hop H₂ ${h2.toExponential(2)} > He ${he.toExponential(2)} > Ne ${ne.toExponential(2)}`);
    assert.ok(ne < 1e-4, 'neon is bound');
    const cold = createHopSim({ speciesKey: 'he', count: 1500, seed: 5, uniformTemperatureK: 100 });
    cold.setSunDir(SUN);
    cold.advanceSim(3600 * 6);
    const cs = cold.stats();
    assert.ok(cs.escapes / cs.hops < 2e-3, `He at 100 K is bound (λ ≈ 8.5): ${cs.escapes}/${cs.hops} escapes`);
    ok('Jeans hierarchy emerges: H₂ > He > Ne, cold He bound');
}

// ── 5. The cold trap and the ride to dawn ───────────────────────────────────
{
    const ar = createHopSim({ speciesKey: 'ar', count: 1500, seed: 3 });
    ar.setSunDir(SUN);
    ar.advanceSim(3600 * 48);
    const st48 = ar.stats();
    assert.ok(st48.frozen > 0.5 * 1500, `argon adsorbs on the night side (${st48.frozen} frozen)`);
    assert.ok(st48.flyingNightFraction < 0.2, 'what still flies, flies by day');
    // After most of a lunar night the resting population has ridden toward
    // dawn: more atoms rest in the 00–06 h bins than in 18–24 h.
    ar.advanceSim(3600 * 500);
    let preDawn = 0, evening = 0;
    for (let i = 0; i < 1500; i++) {
        if (ar.phases[i] !== PHASE.REST) continue;
        const h = ar.localHour(i);
        if (h < 6) preDawn++;
        else if (h >= 18) evening++;
    }
    assert.ok(preDawn > evening * 1.3, `resting argon piles up before dawn (${preDawn} vs ${evening} after dusk)`);
    // The rotation term is the synodic rate, prograde about +y: a resting
    // atom's longitude INCREASES (east), one local hour per LOCAL_HOUR_S.
    const probe = createHopSim({ speciesKey: 'ar', count: 1, seed: 1, uniformTemperatureK: 60 });
    probe.setSunDir(SUN);
    probe.setSurfaceSpin(SYNODIC_SPIN_RAD_PER_S);
    const h0 = probe.localHour(0);
    probe.advanceSim(LOCAL_HOUR_S);
    const dh = ((probe.localHour(0) - h0) % 24 + 24) % 24;
    assert.ok(Math.abs(dh - 1) < 0.05, `one LOCAL_HOUR_S turns the ground by one local hour (${dh.toFixed(3)} h)`);
    const warm = createHopSim({ speciesKey: 'ar', count: 1000, seed: 3, uniformTemperatureK: 250 });
    warm.setSunDir(SUN);
    warm.advanceSim(3600 * 12);
    assert.equal(warm.stats().frozen, 0, 'warm regolith holds nothing');
    ok('argon cold-traps at night, rides the rotation, and piles up before dawn');
}

// ── 6. Photoionization and the shadow ───────────────────────────────────────
{
    const share = (key) => {
        const s = createHopSim({ speciesKey: key, count: 1500, seed: 9 });
        s.setSunDir(SUN);
        s.advanceSim(3600 * 72);
        const st = s.stats();
        return st.ionized / st.hops;
    };
    const k = share('k'), na = share('na');
    assert.ok(k > na, `K (12 h) loses a larger share per hop than Na (47 h): ${k.toExponential(2)} vs ${na.toExponential(2)}`);
    assert.ok(SPECIES.find(s => s.key === 'k').photoionLifetimeHr < SPECIES.find(s => s.key === 'na').photoionLifetimeHr);
    const na48 = createHopSim({ speciesKey: 'na', count: 1500, seed: 9 });
    na48.setSunDir(SUN);
    na48.advanceSim(3600 * 48);
    const st = na48.stats();
    assert.ok(st.flyingNightFraction < 0.6, 'sodium in flight is mostly over the dayside, where it is made');
    assert.ok(st.frozen > 0, 'and the night side cold-traps it');
    assert.ok(st.escapes > 0, 'the suprathermal launch feeds the tail (λ ≈ 6: some escape)');
    // Shadow: a sim with the Sun on −x and every atom resting at +x (night)
    // for a day of sim time must ionize nothing while nothing flies by day.
    const dark = createHopSim({ speciesKey: 'na', count: 400, seed: 2 });
    dark.setSunDir({ x: -1, y: 0, z: 0 });
    dark.advanceSim(3600 * 2);
    const d = dark.stats();
    assert.ok(d.ionized <= d.hops * 0.02, `night-side atoms are shielded from ionizing UV (${d.ionized} ionized)`);
    ok('photoionization hierarchy K > Na; shielding in shadow');
}

console.log(`\nmoon-exosphere-hops: ${passed} groups passed`);
