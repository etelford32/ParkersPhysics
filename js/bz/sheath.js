/**
 * js/bz/sheath.js — across the bow shock at the nose (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B4 (§4.4). No DOM, no fetch, no ambient time.
 * Gate: tests/bz-column.mjs.
 *
 * WHAT IS HERE IS EXACT, AND WHAT IS NOT HERE IS NAMED.
 *
 * At the subsolar point the bow shock's normal is the Sun–Earth line, so the
 * IMF components that matter for reconnection (By, Bz) are TANGENTIAL to the
 * shock and the flow is normal to it: a perpendicular MHD shock. Its
 * compression ratio X = ρ₂/ρ₁ = B_t2/B_t1 is the positive root of
 *
 *   2(2−γ) X² + γ[2(1+β) + (γ−1) β M²] X − γ(γ+1) β M² = 0
 *
 * (M the upstream SONIC Mach number, β the upstream plasma beta) — the
 * Rankine–Hugoniot conditions, no fitted number in them. Two limits pin it:
 * X → (γ+1)M²/((γ−1)M²+2) as β → ∞ (the gas-dynamic shock), and X = 1 exactly
 * at a fast-magnetosonic Mach number of 1. The tests hold both.
 *
 * So `noseJump` answers: just downstream of the shock, By and Bz are X times
 * their upstream values (2–4 for ordinary solar wind) and Bx is unchanged.
 *
 * NOT HERE — the plan's §4.4 called for a transfer function fitted to our
 * BATS-R-US runs, and it is NOT BUILT, because the repository holds no MHD
 * magnetosheath output to fit it to (swmf/fixtures carries polar-cap
 * potential and hemispheric power only). Specifically missing:
 *   • the further PILE-UP of field against the magnetopause (the plasma
 *     depletion layer), which raises the field beyond X on the way in;
 *   • the sheath TRANSIT TIME from shock to magnetopause;
 *   • anything away from the nose, where the shock is oblique.
 * `noseJump` therefore gives the field AT THE SHOCK'S DOWNSTREAM FACE and is
 * a LOWER bound on the field at the magnetopause. Nothing here claims more.
 *
 * ELECTRONS: the feed publishes the PROTON temperature only. The sound speed
 * and β need the electron pressure too; `electronTempK` is a stated constant
 * (1.4×10⁵ K, the long-term 1 AU average) and the result carries it.
 */

export const SHEATH_DEFAULTS = Object.freeze({ gamma: 5 / 3, electronTempK: 1.4e5 });

/** Compression ratio of a perpendicular MHD shock. null if not a shock (X ≤ 1) or bad input. */
export function perpShockRatio(sonicMach, beta, gamma = SHEATH_DEFAULTS.gamma) {
    if (!(sonicMach > 0) || !(beta > 0) || !(gamma > 1)) return null;
    const M2 = sonicMach * sonicMach;
    const a = 2 * (2 - gamma);
    const b = gamma * (2 * (1 + beta) + (gamma - 1) * beta * M2);
    const c = -gamma * (gamma + 1) * beta * M2;
    // The positive root in its CANCELLATION-FREE form: (−b + √…)/2a subtracts two
    // nearly equal numbers at high β and lost five digits (caught by the β → ∞ gate).
    const X = (-2 * c) / (b + Math.sqrt(b * b - 4 * a * c));
    return X > 1 ? X : null;
}

/**
 * Upstream Mach numbers and β from L1 moments.
 * @param {{ speedKms:number, densityCc:number, protonTempK:number, btNt:number, electronTempK?:number }} w
 * @returns {{ sonic, alfven, fast, beta, soundKms, alfvenKms, electronTempK } | null}
 */
export function upstreamMach(w, gamma = SHEATH_DEFAULTS.gamma) {
    const te = w.electronTempK ?? SHEATH_DEFAULTS.electronTempK;
    if (!(w.speedKms > 0) || !(w.densityCc > 0) || !(w.protonTempK > 0) || !(w.btNt > 0)) return null;
    const T = w.protonTempK + te;
    const soundKms = Math.sqrt(gamma * 8254.4 * T) / 1000;          // k_B/m_p = 8254.4 J kg⁻¹ K⁻¹
    const alfvenKms = 21.812 * w.btNt / Math.sqrt(w.densityCc);     // B/√(μ₀ n m_p)
    const beta = 3.4699e-5 * w.densityCc * T / (w.btNt * w.btNt);   // 2 μ₀ n k_B T / B²
    return { sonic: w.speedKms / soundKms, alfven: w.speedKms / alfvenKms,
        fast: w.speedKms / Math.hypot(soundKms, alfvenKms), beta, soundKms, alfvenKms, electronTempK: te };
}

/**
 * The field just downstream of the bow-shock nose.
 * @param {{ bxNt:number, byNt:number, bzNt:number }} b upstream field (GSM)
 * @param {object} wind  see upstreamMach
 * @returns {{ ratio, bxNt, byNt, bzNt, mach, is_lower_bound_at_magnetopause:true } | null}
 */
export function noseJump(b, wind) {
    const mach = upstreamMach(wind);
    if (!mach) return null;
    const X = perpShockRatio(mach.sonic, mach.beta);
    if (X == null) return null;
    const f = (v) => (v === v && v != null ? v * X : null);
    return { ratio: X, bxNt: b.bxNt === b.bxNt ? b.bxNt : null, byNt: f(b.byNt), bzNt: f(b.bzNt), mach,
        is_lower_bound_at_magnetopause: true };
}
