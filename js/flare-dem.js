/**
 * flare-dem.js — the flare's hot DEM component, and how it COOLS
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel (no DOM, no three, no fetch, no ambient time). Node-gated by
 * `tests/flare-dem.mjs`. SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3c.
 *
 * ── What this replaced, and why it mattered ───────────────────────────────
 *
 * The volumetric corona's flare term (js/corona-volumetric.js, `DEM_flare`)
 * was one Gaussian cell at a FIXED log T of 7.05, amplitude scaled by the live
 * GOES flux. Every channel therefore saw the flare at the same moment and in
 * the same proportion for its whole life — 131 and 171 lit together and died
 * together, which is the one thing a flare visibly does NOT do.
 *
 * What an AIA movie actually shows is a COOLING CASCADE. The plasma is heated
 * impulsively to 10–25 MK, so 131 Å (Fe XXI, log T 7.0) and 94 Å (Fe XVIII,
 * log T 6.85) light first; the loops then cool by conduction and then by
 * radiation, and the SAME arcade brightens successively in 211, 193, and
 * finally 171 (log T 5.85) and 304 tens of minutes later. The post-flare
 * arcade you see in 171 is the plasma you saw in 131 half an hour earlier.
 *
 * So this kernel gives the flare component a TEMPERATURE THAT FALLS, and the
 * per-channel sequencing falls out of the raymarcher's own response table
 * (`channelResponseAt`) instead of being scripted. `tests/flare-dem.mjs`
 * MEASURES the channel order back out rather than asserting it.
 *
 * ── Peak temperature from the GOES class ──────────────────────────────────
 * GOES two-channel temperature diagnostics put flare peak temperatures at
 * roughly 10–25 MK across the C–X range (Ryan et al. 2012, ApJS 202, 11).
 * Anchored at 8 MK for C1 with a 0.16 power on the flux, that gives
 *   C1 → 8 MK   M1 → 11.6 MK   X1 → 16.7 MK   X10 → 24 MK
 * which spans the measured range. It is an ANCHOR, not a fit.
 *
 * ── Cooling ───────────────────────────────────────────────────────────────
 * Two mechanisms, each with a standard timescale (Culhane et al. 1994;
 * Cargill, Mariska & Antiochos 1995):
 *
 *   conduction   τ_c = 4×10⁻¹⁰ · n L² / T^(5/2)      [s]
 *   radiation    τ_r = 3 k_B T / (n Λ(T))            [s],  Λ ≈ 10⁻¹⁹ T^(−1/2)
 *
 * with n in cm⁻³, L (loop half-length) in cm, T in K. Conduction is fast and
 * strongly temperature-dependent (T^(−5/2)), so it dominates at the start and
 * switches off as the plasma cools; radiation then takes over and is what
 * makes the cool channels light LATE rather than never. The kernel integrates
 *
 *   dT/dt = −T/τ_eff,     1/τ_eff = 1/τ_c + 1/τ_r
 *
 * which is the usual way the two are combined. The initial density comes from
 * the RTV scaling law (Rosner, Tucker & Vaiana 1978) at the peak temperature,
 * T_max = 1400 (p L)^(1/3), so a hotter flare on a given loop is a denser one
 * — the density is derived from the same two numbers, not typed in.
 *
 * ── The loop DRAINS as it cools, and that is load-bearing ────────────────
 * A post-flare loop does not cool at fixed density: chromospheric condensation
 * and the enthalpy flux carry mass back down. EBTEL-class 0-D models
 * (Klimchuk, Patsourakos & Cargill 2008; Cargill, Bradshaw & Klimchuk 2012)
 * produce radiative-phase tracks in the n ∝ T^(1/2) … T² family, depending on
 * how that flux is treated. We take n ∝ T^DRAIN_EXP with DRAIN_EXP = 1, the
 * middle of the family, as an ORDER-OF-MAGNITUDE treatment — this is not a
 * loop hydrodynamics code and does not pretend to be one.
 *
 * WHY IT MATTERS, MEASURED (X1, L = 2×10⁹ cm, channel peak times in seconds):
 *
 *     n ∝ T⁰     131 158   94 296   211 532   193 546   171 568
 *     n ∝ T^0.5  131 152   94 303   211 717   193 759   171 842
 *     n ∝ T¹     131 144   94 292   211 961   193 1080  171 1387
 *     n ∝ T^1.5  131 134   94 266   211 1072  193 1304  171 2184
 *
 * At FIXED density the three cool channels bunch inside 36 s of each other —
 * which renders as 211, 193 and 171 lighting simultaneously, i.e. the exact
 * failure this whole kernel exists to fix, just moved down the track. With
 * n ∝ T they separate, and the 171 post-flare arcade peaks ~23 min after the
 * flare, which is the window AIA movies show. So DRAIN_EXP is CALIBRATED
 * against that observable as well as being the middle of the model family;
 * the scan above is recorded so the next session does not re-run it blind.
 * The hot end (131, 94) barely moves — it is conduction-dominated, where
 * density enters τ_c linearly and the T^(5/2) term dominates.
 *
 * ── Two further simplifications, stated ──────────────────────────────────
 *  1. The cooling track STOPS at T_FLOOR = 3×10⁵ K, because Λ ∝ T^(−1/2) is a
 *     coronal approximation and the real radiative loss function turns over
 *     near 10⁵ K. Consequence worth naming: 304 Å (log T 4.70) is BELOW the
 *     floor, so the cooling arcade never lights it. That is honest rather than
 *     a gap — 304's flare signal on this page is the RIBBONS (js/flare-ribbons.js,
 *     drawn separately as `flareAdd`), which are chromospheric and are not
 *     this cooling coronal plasma. Observed 304 post-flare loops are coronal
 *     RAIN, i.e. condensation below 10⁵ K, which is past where this model is
 *     valid; the kernel reports 304 as unreachable instead of extrapolating.
 *  2. ONE temperature, not a distribution. A real flare arcade is a spread of
 *     loops at a spread of temperatures, which is why channels OVERLAP in
 *     time rather than switching. The renderer recovers some of that for free
 *     because the raymarcher's response is a Gaussian in log T, but this is a
 *     single-fluid track and it says so.
 *  3. ISOBARIC RTV at the peak. Flare loops are not in equilibrium at their
 *     peak; RTV is being used as a density ANCHOR of the right order, not as
 *     a claim that the loop is static.
 *
 * None of the three changes which channel lights first, which is the claim
 * the page actually makes.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Boltzmann constant, erg K⁻¹. */
export const K_B = 1.380649e-16;
/** GOES 1–8 Å flux of a C1 flare, W m⁻². */
export const FLUX_C1 = 1e-6;
/** Peak temperature of a C1 flare, K (Ryan et al. 2012 range anchor). */
export const T_PEAK_C1 = 8e6;
/** Power on the GOES flux in the peak-temperature anchor. */
export const T_PEAK_EXP = 0.16;
/** Default flare loop half-length, cm (2×10⁹ cm = 20 Mm — a typical AR arcade). */
export const L_DEFAULT = 2e9;
/** Radiative loss coefficient in Λ(T) = LAMBDA_0 · T^(−1/2), erg cm³ s⁻¹. */
export const LAMBDA_0 = 1e-19;
/**
 * Below this the Λ ∝ T^(−1/2) coronal approximation stops being valid (the real
 * radiative loss function turns over near 10⁵ K), so the track ENDS rather
 * than extrapolating. See simplification 1 in the header for what that means
 * for 304 Å.
 */
export const T_FLOOR = 3e5;

/** Loop drainage during cooling: n(T) = n₀·(T/T₀)^DRAIN_EXP. See the header. */
export const DRAIN_EXP = 1.0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── GOES class ↔ flux ──────────────────────────────────────────────────────

const CLASS_BASE = Object.freeze({ A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 });

/** 'M5.2' → 5.2e-5 W m⁻². Returns null for anything unparseable. */
export function goesFluxOf(cls) {
    const m = /^\s*([ABCMX])\s*([\d.]+)?\s*$/i.exec(String(cls || ''));
    if (!m) return null;
    const base = CLASS_BASE[m[1].toUpperCase()];
    const mult = m[2] === undefined ? 1 : parseFloat(m[2]);
    return Number.isFinite(mult) && mult > 0 ? base * mult : base;
}

/** 5.2e-5 → 'M5.2'. The inverse, for labels. */
export function goesClassOf(flux) {
    if (!(flux > 0)) return null;
    const letters = ['X', 'M', 'C', 'B', 'A'];
    for (const L of letters) {
        const base = CLASS_BASE[L];
        if (flux >= base || L === 'A') {
            const mult = flux / base;
            return `${L}${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}`;
        }
    }
    return null;
}

// ── The thermal track ──────────────────────────────────────────────────────

/** Peak temperature (K) for a GOES 1–8 Å flux (W m⁻²). See the header. */
export function peakTemperatureK(flux) {
    if (!(flux > 0)) return T_PEAK_C1;
    return T_PEAK_C1 * Math.pow(flux / FLUX_C1, T_PEAK_EXP);
}

/**
 * Electron density (cm⁻³) from the RTV scaling law at temperature T on a loop
 * of half-length L (cm): T = 1400 (p L)^(1/3) ⇒ p = T³/(1400³ L), n = p/(2 k_B T).
 */
export function rtvDensity(T, L = L_DEFAULT) {
    const p = (T * T * T) / (1400 ** 3 * L);
    return p / (2 * K_B * T);
}

/** Conductive cooling time, s (Culhane et al. 1994). */
export function tauCond(n, L, T) {
    return 4e-10 * n * L * L / Math.pow(T, 2.5);
}

/** Radiative cooling time, s, with Λ(T) = LAMBDA_0 · T^(−1/2). */
export function tauRad(n, T) {
    return 3 * K_B * T / (n * LAMBDA_0 * Math.pow(T, -0.5));
}

/** Combined e-folding time: 1/τ = 1/τ_c + 1/τ_r. */
export function tauEff(n, L, T) {
    const c = tauCond(n, L, T), r = tauRad(n, T);
    return 1 / (1 / c + 1 / r);
}

/** Density at temperature T on a track that started at (n₀, T₀). See DRAIN_EXP. */
export function drainedDensity(n0, T0, T, exp = DRAIN_EXP) {
    return n0 * Math.pow(Math.max(T, 1) / T0, exp);
}

/**
 * Integrate dT/dt = −T/τ_eff(T) from the peak, and return the whole track.
 * Explicit steps on a log-time grid — the first seconds are conduction-fast
 * and the tail is radiative-slow, so a linear grid would either miss the knee
 * or take thousands of steps to reach the tail.
 *
 * @param {number} flux GOES 1–8 Å, W m⁻²
 * @param {{L?:number, tMax?:number, steps?:number}} [opts]
 * @returns {{t:number[], T:number[], logT:number[], n:number, T0:number, L:number}}
 */
export function coolingTrack(flux, opts = {}) {
    const L = opts.L ?? L_DEFAULT;
    const tMax = opts.tMax ?? 10800;         // 3 h — well past 171's peak (~23 min) and its tail
    const steps = opts.steps ?? 2000;
    const T0 = peakTemperatureK(flux);
    const n = rtvDensity(T0, L);
    const t = [0], T = [T0];
    let cur = T0, now = 0;
    const dtOf = (i) => {
        // Geometric time steps: fine at the knee, coarse in the tail.
        const a = Math.log(0.05), b = Math.log(tMax / steps * 8);
        return Math.exp(a + (b - a) * (i / (steps - 1)));
    };
    const drain = opts.drainExp ?? DRAIN_EXP;
    for (let i = 0; i < steps && now < tMax; i++) {
        const dt = dtOf(i);
        // The loop drains as it cools — see the header's measured scan. Holding
        // n fixed bunches 211/193/171 inside 36 s of each other.
        const tau = tauEff(drainedDensity(n, T0, cur, drain), L, cur);
        // Exact solution of dT/dt = −T/τ over the step at frozen τ — stable at
        // any dt, unlike forward Euler, whose first conduction-dominated step
        // would drive T negative.
        cur = Math.max(T_FLOOR, cur * Math.exp(-dt / tau));
        now += dt;
        t.push(now); T.push(cur);
        if (cur <= T_FLOOR * 1.001) break;
    }
    return { t, T, logT: T.map((v) => Math.log10(v)), n, T0, L };
}

/**
 * Temperature (K) at `tSec` after the flare's impulsive peak. Interpolated in
 * log T on a track computed once — the renderer calls this every frame, and a
 * fresh integration per frame is the kind of thing that turns up later as an
 * unexplained frame-time spike.
 *
 * Pass a track from `coolingTrack` as `opts.track` to reuse it.
 */
export function temperatureAt(flux, tSec, opts = {}) {
    const track = opts.track ?? coolingTrack(flux, opts);
    const { t, logT } = track;
    if (!(tSec > 0)) return track.T0;
    if (tSec >= t[t.length - 1]) return Math.pow(10, logT[logT.length - 1]);
    // Binary search — the grid is geometric, so a linear scan is O(steps).
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= tSec) lo = mid; else hi = mid;
    }
    const f = (tSec - t[lo]) / Math.max(t[hi] - t[lo], 1e-12);
    return Math.pow(10, logT[lo] + f * (logT[hi] - logT[lo]));
}

/**
 * Everything the shader needs for the flare DEM cell this frame.
 *
 * `amp` is the EMISSION MEASURE envelope, not the temperature: it rises with
 * the impulsive phase and decays with the GOES soft-X-ray light curve, which
 * the page already tracks. It is kept SEPARATE from the temperature on
 * purpose — conflating them is what made every channel light at once.
 *
 * @returns {{logT:number, amp:number, T:number, tSec:number}}
 */
export function flareDemState(flux, tSec, opts = {}) {
    const T = temperatureAt(flux, tSec, opts);
    const rise = opts.riseSec ?? 60;
    const decay = opts.decaySec ?? 900;
    // Impulsive rise then soft-X-ray decay, normalised to 1 at the peak.
    const env = tSec <= 0 ? 0
        : tSec < rise ? tSec / rise
        : Math.exp(-(tSec - rise) / decay);
    return { logT: Math.log10(T), amp: clamp(env, 0, 1), T, tSec };
}

/**
 * When does each channel PEAK along the cooling track?
 *
 * This is the function the page's claim rests on, so it is computed rather
 * than asserted: for each channel, the time at which
 * `response(logT(t)) × amp(t)` is largest. `tests/flare-dem.mjs` measures the
 * AIA order out of this — 131/94 first, 171/304 last.
 *
 * @param {number} flux
 * @param {Record<string, {logT:number, sigma:number}>} channels  EUV_CHANNELS
 * @param {(logT:number, ch:any)=>number} response  channelResponseAt
 */
export function channelPeakTimes(flux, channels, response, opts = {}) {
    const track = coolingTrack(flux, opts);
    const out = {};
    for (const [key, ch] of Object.entries(channels)) {
        if (!(ch.sigma > 1e-3)) continue;               // white light is not a passband
        let best = -1, bestV = 0;
        for (let i = 0; i < track.t.length; i++) {
            const st = flareDemState(flux, track.t[i], { ...opts, track });
            const v = response(track.logT[i], ch) * st.amp;
            if (v > bestV) { bestV = v; best = track.t[i]; }
        }
        out[key] = { tPeak: best, value: bestV };
    }
    return out;
}
