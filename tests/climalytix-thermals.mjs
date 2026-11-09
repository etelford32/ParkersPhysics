#!/usr/bin/env node
/**
 * climalytix-thermals.mjs — node gate for js/climalytix/thermals.js (plan §19 T4).
 *
 *   · Lambert W₋₁: w·e^w = x across its domain, w ≤ −1, the published value
 *     W₋₁(−0.1) = −3.577152…, the branch point, NaN outside
 *   · the Romps (2017) LCL satisfies the identity that DEFINES it: a parcel
 *     lifted dry-adiabatically (c_pm·ln T − R_m·ln p conserved, vapour
 *     pressure ∝ p) is EXACTLY saturated at T_LCL — NEGATIVE CONTROL: the
 *     exponent a without its (c_vl − c_pv)/R_v term is not
 *   · saturated air has its cloud base at the ground; Espy's 125 m/K rule
 *     agrees within 10 % over ordinary conditions; z rises with the spread
 *   · Deardorff w*: the closed form, cube-root scaling in H and z_i, 0 when
 *     the surface is not heating the air
 *   · regimes: none below the flux floor (night), cu when the cloud base is
 *     below the boundary-layer top, blue otherwise; top = min(z_i, LCL)
 *   · the time window: the flux mean covering an instant is the stamp AFTER
 *     it (GFS means end at the stamp); outside the run is null
 *   · the paint: nothing at or under the floor, full at WSTAR_FULL, alpha
 *     rising with w*
 *
 *   node tests/climalytix-thermals.mjs
 */

import assert from 'node:assert/strict';
import {
    lambertWm1, lclRomps, pvStarLiquid, airDensity, deardorff, thermalAt, windowAt, thermalPaint, strengthLabel,
    G, CP, H_MIN_WM2, WSTAR_FULL, WSTAR_FLOOR, ROMPS,
} from '../js/climalytix/thermals.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix thermals');

ok('Lambert W₋₁: w·e^w = x, w ≤ −1, a published value, the branch point, NaN outside', () => {
    for (const x of [-1 / Math.E + 1e-12, -0.367, -0.3, -0.2, -0.1, -1e-3, -1e-8, -1e-30]) {
        const w = lambertWm1(x);
        assert.ok(w <= -1, `${x} → ${w}`);
        assert.ok(Math.abs(w * Math.exp(w) - x) <= 1e-12 * Math.max(1e-30, Math.abs(x)) + 1e-15, `${x}: ${w * Math.exp(w)}`);
    }
    assert.ok(Math.abs(lambertWm1(-0.1) - -3.577152063957297) < 1e-12);
    assert.equal(lambertWm1(-1 / Math.E), -1);
    assert.ok(Number.isNaN(lambertWm1(0)) && Number.isNaN(lambertWm1(-0.5)) && Number.isNaN(lambertWm1(0.1)));
});

/** |pv at the LCL after a dry-adiabatic lift − saturation there| / saturation. */
function saturationMiss(p, T, Td, opts) {
    const l = lclRomps(p, T, Td, opts);
    const pv = (l.rh) * pvStarLiquid(T);
    const pL = p * Math.pow(l.TK / T, l.cpm / l.rgasm);
    return Math.abs(pv * pL / p - pvStarLiquid(l.TK)) / pvStarLiquid(l.TK);
}

ok('the Romps LCL satisfies its defining identity — NEGATIVE CONTROL: the truncated exponent does not', () => {
    for (const [p, T, Td] of [[1e5, 300, 290], [1e5, 300, 270], [85000, 288, 275], [70000, 275, 260], [101325, 310, 305]]) {
        assert.ok(saturationMiss(p, T, Td) < 1e-9, `${p} ${T} ${Td}: ${saturationMiss(p, T, Td)}`);
        const l = lclRomps(p, T, Td);
        const bad = l.cpm / l.rgasm;                     // a without (c_vl − c_pv)/R_v
        assert.ok(saturationMiss(p, T, Td, { aOverride: bad }) > 1e-3, 'the wrong exponent is visibly wrong');
    }
});

ok('saturated air: cloud base at the ground; Espy\'s 125 m/K within 10 %; z rises with the spread', () => {
    const s = lclRomps(1e5, 290, 290);
    assert.equal(s.zM, 0);
    let prev = -1;
    for (const spread of [2, 5, 10, 15, 20, 25]) {
        for (const tc of [0, 15, 30]) {
            const l = lclRomps(95000, 273.15 + tc, 273.15 + tc - spread);
            const espy = 125 * spread;
            assert.ok(Math.abs(l.zM - espy) / espy < 0.10, `T ${tc} spread ${spread}: ${l.zM} vs ${espy}`);
        }
        const z = lclRomps(95000, 293.15, 293.15 - spread).zM;
        assert.ok(z > prev); prev = z;
    }
    assert.equal(ROMPS.rgasv, 461);
});

ok('Deardorff w*: the closed form, cube-root scaling, 0 without surface heating', () => {
    const rho = airDensity(1e5, 300);
    assert.ok(Math.abs(rho - 1e5 / (287.04 * 300)) < 1e-12);
    const w = deardorff({ fluxWm2: 300, ziM: 1500, rho, thetaVK: 300 });
    assert.ok(Math.abs(w - Math.cbrt(G / 300 * (300 / (rho * CP)) * 1500)) < 1e-12);
    assert.ok(w > 2.2 && w < 2.45, `${w}`);
    assert.ok(Math.abs(deardorff({ fluxWm2: 600, ziM: 1500, rho, thetaVK: 300 }) / w - Math.cbrt(2)) < 1e-12);
    assert.ok(Math.abs(deardorff({ fluxWm2: 300, ziM: 12000, rho, thetaVK: 300 }) / w - 2) < 1e-12);
    assert.equal(deardorff({ fluxWm2: -40, ziM: 300, rho, thetaVK: 280 }), 0);
    assert.equal(strengthLabel(0.7), 'weak'); assert.equal(strengthLabel(1.5), 'moderate'); assert.equal(strengthLabel(2.6), 'strong');
});

ok('regimes: none below the flux floor, cu when cloud base < BL top, blue otherwise; top = min', () => {
    const night = thermalAt({ fluxWm2: -30, ziM: 150, psfcHpa: 850, tempC: 5, dewC: 0 });
    assert.equal(night.regime, 'none'); assert.equal(night.wstar, 0);
    assert.equal(thermalAt({ fluxWm2: H_MIN_WM2 - 1, ziM: 800, psfcHpa: 850, tempC: 15, dewC: 5 }).regime, 'none');
    const moist = thermalAt({ fluxWm2: 250, ziM: 2000, psfcHpa: 900, tempC: 24, dewC: 16 });   // LCL ~1 km
    assert.equal(moist.regime, 'cu');
    assert.equal(moist.topM, moist.lclM); assert.equal(moist.baseM, moist.lclM);
    const dry = thermalAt({ fluxWm2: 350, ziM: 2200, psfcHpa: 840, tempC: 30, dewC: -5 });     // LCL ~4.4 km
    assert.equal(dry.regime, 'blue');
    assert.equal(dry.topM, 2200); assert.equal(dry.baseM, null);
    assert.ok(dry.wstar > moist.wstar);
    assert.equal(thermalAt({ fluxWm2: NaN, ziM: 1, psfcHpa: 1, tempC: 1, dewC: 1 }), null, 'gaps stay gaps');
});

ok('the time window: the flux mean covering an instant ends at the stamp after it', () => {
    const H = 3_600_000, t = [0, 3 * H, 6 * H];
    assert.deepEqual(windowAt(t, 1 * H), { i: 1, f: 1 / 3 });
    assert.deepEqual(windowAt(t, 3 * H), { i: 1, f: 1 });
    assert.deepEqual(windowAt(t, 3 * H + 1), { i: 2, f: 1 / (3 * H) });
    assert.equal(windowAt(t, 0), null, 'the analysis has no flux window');
    assert.equal(windowAt(t, 7 * H), null);
});

ok('the paint: nothing at or under the floor, full at WSTAR_FULL, alpha rising', () => {
    const at = (w) => { const d = new Uint8ClampedArray(4); thermalPaint(w, d, 0); return [...d]; };
    assert.deepEqual(at(WSTAR_FLOOR), [0, 0, 0, 0]);
    assert.deepEqual(at(0), [0, 0, 0, 0]);
    assert.deepEqual(at(NaN), [0, 0, 0, 0]);
    assert.deepEqual(at(WSTAR_FULL), at(9));
    let prev = 0;
    for (let w = WSTAR_FLOOR + 0.1; w <= WSTAR_FULL; w += 0.3) { const a = at(w)[3]; assert.ok(a > prev); prev = a; }
});

console.log(`\n${passed} passed`);
