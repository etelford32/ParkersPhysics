// node tests/launch-smoke-sim.mjs — pins the PURE smoke kernel behind the
// launch planner's exhaust / ground-cloud / steam sprites.
import assert from 'node:assert/strict';
import {
    createSmokeSim, emitSmoke, stepSmoke, smokeAlpha, smokeRadius, clearSmoke,
    mulberry32, SMOKE_KIND, SMOKE_PROFILES, planEmissions, createEmissionCarry,
} from '../js/launch-smoke-sim.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

test('PRNG is deterministic per seed and in [0,1)', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const sa = [a(), a(), a()], sb = [b(), b(), b()];
    assert.deepEqual(sa, sb);
    assert.notDeepEqual(sa, [c(), c(), c()]);
    const r = mulberry32(7);
    for (let i = 0; i < 1e4; i++) { const v = r(); assert.ok(v >= 0 && v < 1); }
});

test('same seed + same calls ⇒ bit-identical state', () => {
    const run = () => {
        const s = createSmokeSim({ capacity: 64, seed: 9 });
        emitSmoke(s, 40, { origin: [0, 10, 0], dir: [0, -1, 0], speed: 20, life: 5 });
        for (let i = 0; i < 30; i++) stepSmoke(s, 1 / 60);
        return Array.from(s.pos);
    };
    const a = run(), b = run();
    for (let i = 0; i < a.length; i++) assert.ok(Object.is(a[i], b[i]));
});

test('ring buffer: capacity is never exceeded, oldest slot is reused', () => {
    const s = createSmokeSim({ capacity: 10, seed: 1 });
    emitSmoke(s, 25, { origin: [0, 5, 0], life: 100 });
    assert.equal(s.alive, 10);
    assert.equal(s.head, 5);
    stepSmoke(s, 0.01);
    assert.equal(s.alive, 10);
});

test('particles die at end of life and alpha is 0 for dead slots', () => {
    const s = createSmokeSim({ capacity: 8, seed: 3 });
    emitSmoke(s, 8, { origin: [0, 5, 0], life: 1 });
    stepSmoke(s, 2);
    assert.equal(s.alive, 0);
    for (let i = 0; i < 8; i++) assert.equal(smokeAlpha(s, i), 0);
});

test('radius grows monotonically from size0 toward size1', () => {
    const s = createSmokeSim({ capacity: 1, seed: 5 });
    emitSmoke(s, 1, { origin: [0, 50, 0], size0: 1, size1: 6, grow: 2, life: 50 });
    let prev = smokeRadius(s, 0);
    assert.ok(Math.abs(prev - s.size0[0]) < 1e-6);
    for (let k = 0; k < 200; k++) {
        stepSmoke(s, 0.1);
        const r = smokeRadius(s, 0);
        assert.ok(r >= prev - 1e-9);
        assert.ok(r <= s.size1[0] + 1e-6);
        prev = r;
    }
    assert.ok(prev > s.size1[0] * 0.99);
});

test('alpha fades in, plateaus, then fades to 0 at end of life', () => {
    const s = createSmokeSim({ capacity: 1, seed: 11 });
    emitSmoke(s, 1, { origin: [0, 50, 0], size0: 1, size1: 1, life: 10, opacity: 0.8 });
    s.life[0] = 10;                       // remove the ±25 % jitter for the shape check
    assert.equal(smokeAlpha(s, 0), 0);
    stepSmoke(s, 0.3); const early = smokeAlpha(s, 0);
    stepSmoke(s, 2.7); const mid = smokeAlpha(s, 0);
    stepSmoke(s, 6.8); const late = smokeAlpha(s, 0);
    assert.ok(early > 0 && mid >= early && late < mid * 0.2);
});

test('ground: no puff centre sinks below 40 % of its radius above groundY', () => {
    const s = createSmokeSim({ capacity: 200, seed: 13 });
    emitSmoke(s, 200, { origin: [0, 4, 0], dir: [0, -1, 0], speed: 60, spread: 0.4,
                        size0: 2, size1: 8, life: 30 });
    for (let k = 0; k < 300; k++) {
        stepSmoke(s, 1 / 30, { groundY: 0 });
        for (let i = 0; i < 200; i++) {
            if (s.life[i] <= 0) continue;
            assert.ok(s.pos[i * 3 + 1] >= smokeRadius(s, i) * 0.4 - 1e-4);
        }
    }
});

function boilOut(groundY) {
    const s = createSmokeSim({ capacity: 400, seed: 17 });
    emitSmoke(s, 400, { origin: [0, 2, 0], dir: [0, -1, 0], speed: 40, spread: 0.05,
                        size0: 1, size1: 1, life: 20 });
    for (let k = 0; k < 60; k++) stepSmoke(s, 1 / 30, { groundY, drag: 0.4 });
    let mean = 0, cx = 0, cz = 0;
    for (let i = 0; i < 400; i++) {
        mean += Math.hypot(s.pos[i * 3], s.pos[i * 3 + 2]);
        cx += s.pos[i * 3]; cz += s.pos[i * 3 + 2];
    }
    return { mean: mean / 400, centroid: Math.hypot(cx / 400, cz / 400) };
}

test('ground impact turns downward momentum RADIALLY OUTWARD (the boil-out)', () => {
    const hit = boilOut(0);
    // NEGATIVE CONTROL: the same puffs with the ground removed keep their
    // narrow ±0.05 rad cone, so their sideways travel is several times smaller.
    const free = boilOut(-1e9);
    assert.ok(hit.mean > 8, `mean outward travel ${hit.mean.toFixed(2)} m`);
    assert.ok(hit.mean > free.mean * 3, `${hit.mean.toFixed(2)} vs control ${free.mean.toFixed(2)}`);
    // …and it spreads evenly: the centroid stays near the axis.
    assert.ok(hit.centroid < hit.mean * 0.25);
});

test('hot puffs rise, cold puffs do not; buoyancy decays with heat', () => {
    const mk = (heat) => {
        const s = createSmokeSim({ capacity: 1, seed: 19 });
        emitSmoke(s, 1, { origin: [0, 100, 0], speed: 0, heat, buoyancy: 3, life: 60 });
        for (let k = 0; k < 120; k++) stepSmoke(s, 1 / 20);
        return { y: s.pos[1], heat: s.heat[0] };
    };
    const hot = mk(1), cold = mk(0);
    assert.ok(hot.y > 105, `hot rose to ${hot.y}`);
    assert.ok(Math.abs(cold.y - 100) < 1e-3);
    assert.ok(hot.heat < 0.2);
});

test('drag relaxes velocity to the wind, stably even for a huge dt', () => {
    const s = createSmokeSim({ capacity: 1, seed: 23 });
    emitSmoke(s, 1, { origin: [0, 100, 0], dir: [1, 0, 0], speed: 50, speedJit: 0, spread: 0, life: 1e3 });
    stepSmoke(s, 30, { wind: [3, -2], drag: 0.6 });
    assert.ok(Math.abs(s.vel[0] - 3) < 0.05 && Math.abs(s.vel[2] + 2) < 0.05);
    assert.ok(Number.isFinite(s.pos[0]));
});

test('clearSmoke empties the sim', () => {
    const s = createSmokeSim({ capacity: 5, seed: 1 });
    emitSmoke(s, 5, { origin: [0, 1, 0] });
    clearSmoke(s);
    assert.equal(s.alive, 0);
    stepSmoke(s, 0.1);
    assert.equal(s.alive, 0);
});

// ── Emission planner ────────────────────────────────────────────────────────

function flight(profile, { seconds = 20, dt = 1 / 30, budget = 1, exits } = {}) {
    const s = createSmokeSim({ capacity: 6000, seed: 29 });
    const carry = createEmissionCarry();
    const counts = { [SMOKE_KIND.EXHAUST]: 0, [SMOKE_KIND.GROUND]: 0, [SMOKE_KIND.STEAM]: 0 };
    let total = 0;
    for (let T = -3; T < seconds; T += dt) {
        const alt = T > 0 ? 0.6 * T * T : 0;
        const before = s.head;
        const n = planEmissions(s, profile, {
            T, dt, throttle: T < -0.2 ? (T + 3) / 2.8 : 1, altitude: alt, D: 4,
            nozzle: [0, 4 + alt, 0], down: [0, -1, 0], deckY: 4, groundY: 0, exits, budget,
        }, carry);
        for (let k = 0; k < n; k++) counts[s.kind[(before + k) % s.capacity]]++;
        total += n;
        stepSmoke(s, dt, { groundY: 0 });
    }
    return { s, counts, total };
}

test('every vehicle profile emits all three kinds over a launch', () => {
    for (const id of Object.keys(SMOKE_PROFILES)) {
        const { counts } = flight(id);
        assert.ok(counts[SMOKE_KIND.STEAM] > 20, `${id} steam ${counts[SMOKE_KIND.STEAM]}`);
        assert.ok(counts[SMOKE_KIND.GROUND] > 100, `${id} ground ${counts[SMOKE_KIND.GROUND]}`);
        assert.ok(counts[SMOKE_KIND.EXHAUST] > 50, `${id} exhaust ${counts[SMOKE_KIND.EXHAUST]}`);
    }
});

test('the exhaust trail is continuous: consecutive puffs overlap along the column', () => {
    const { s } = flight('falcon9', { seconds: 30 });
    const ys = [];
    for (let i = 0; i < s.capacity; i++)
        if (s.life[i] > 0 && s.kind[i] === SMOKE_KIND.EXHAUST)
            ys.push([s.pos[i * 3 + 1], smokeRadius(s, i)]);
    ys.sort((a, b) => a[0] - b[0]);
    assert.ok(ys.length > 100);
    let worst = 0;
    for (let i = 1; i < ys.length; i++) {
        if (ys[i][0] < 30) continue;
        const gap = ys[i][0] - ys[i - 1][0];
        worst = Math.max(worst, gap / (ys[i][1] + ys[i - 1][1]));
    }
    // Two puffs whose centres are closer than the sum of their radii overlap:
    // no daylight between them anywhere up the column. (Measured worst 0.74.)
    assert.ok(worst < 0.9, `largest gap ${worst.toFixed(2)} × (r₁ + r₂)`);
});

test('emission is frame-rate independent (30 vs 120 fps within 10 %)', () => {
    const a = flight('shuttle', { dt: 1 / 30 }).total;
    const b = flight('shuttle', { dt: 1 / 120 }).total;
    assert.ok(Math.abs(a - b) / a < 0.10, `${a} vs ${b}`);
});

test('the quality budget scales emission down', () => {
    const full = flight('starship', { budget: 1 }).total;
    const low  = flight('starship', { budget: 0.35 }).total;
    assert.ok(low < full * 0.6 && low > full * 0.2, `${low} / ${full}`);
});

test('the ground cloud stops once the vehicle is out of reach', () => {
    const { s } = flight('falcon9', { seconds: 30 });
    // reach 90 m ⇒ 0.6 T² = 90 at T ≈ 12.2 s; the youngest GROUND puff is older than that.
    let youngest = Infinity;
    for (let i = 0; i < s.capacity; i++)
        if (s.life[i] > 0 && s.kind[i] === SMOKE_KIND.GROUND) youngest = Math.min(youngest, s.age[i]);
    assert.ok(youngest > 30 - 12.3 - 0.1, `youngest ground puff ${youngest.toFixed(2)} s`);
});

test('trench exits route the ground cloud out along them', () => {
    const { s } = flight('shuttle', { seconds: 8, exits: [[0, 30, 0, 1], [0, -30, 0, -1]] });
    let pz = 0, nz = 0, other = 0;
    for (let i = 0; i < s.capacity; i++) {
        if (s.life[i] <= 0 || s.kind[i] !== SMOKE_KIND.GROUND) continue;
        const z = s.pos[i * 3 + 2], x = s.pos[i * 3];
        if (z > 30) pz++; else if (z < -30) nz++; else other++;
        assert.ok(Math.abs(x) < Math.abs(z) + 15);
    }
    assert.ok(pz > 20 && nz > 20 && Math.abs(pz - nz) < (pz + nz) * 0.3, `${pz}/${nz}/${other}`);
});

test('methalox (Starship) leaves a much fainter trail than solids (Shuttle)', () => {
    assert.ok(SMOKE_PROFILES.starship.exhaust.opacity < SMOKE_PROFILES.shuttle.exhaust.opacity * 0.3);
});

console.log(`\n${passed} passed`);
