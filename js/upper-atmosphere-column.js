/**
 * upper-atmosphere-column.js — the atmosphere as a FIELD and as a COLUMN
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel. No THREE, no DOM, no fetch, no ambient time — every input is
 * an argument. Node-tested by `tests/upper-atmosphere-column.mjs`; run it
 * after ANY edit here.
 *
 * WHY THIS MODULE EXISTS
 * ──────────────────────
 * The page had a density model (`upper-atmosphere-engine.js`: Bates T(z) +
 * per-species diffusive equilibrium) but drew it as five discrete shells
 * with flat per-layer colours and hard boundaries. That is not what an
 * atmosphere looks like, and it is not what the model actually says. Two
 * things were missing, and they are the two things this module supplies:
 *
 *   1. THE ATMOSPHERE IS NOT SPHERICALLY SYMMETRIC. The thermosphere has a
 *      diurnal bulge that lags the sub-solar point by ~2.5 h, and during
 *      storms the auroral ovals are heated hard enough to inflate locally.
 *      Both are the whole reason satellite operators care about this page:
 *      the drag a spacecraft sees depends on WHERE in that field it is,
 *      not just on the global F10.7/Ap.
 *
 *   2. YOU DO NOT SEE ρ, YOU SEE ∫ρ dl. A limb ray at 400 km traverses
 *      ~1600 km of equivalent local atmosphere (see `limbPathEquivalentKm`)
 *      because the geometry stretches a 60 km scale height into a
 *      √(2π R H) chord. That factor of ~27 IS the bright band you see on
 *      every photograph of Earth's limb. A renderer that shades by local ρ
 *      cannot produce it; one that integrates the column gets it for free.
 *
 * THE ONE-MODEL RULE
 * ──────────────────
 * There is exactly ONE density model on this page and it lives in
 * `upper-atmosphere-engine.js`. This module never re-implements it. What
 * it adds is a T∞ FIELD — a scalar exospheric temperature that varies with
 * local solar time, latitude and magnetic activity — which is then fed
 * back into `density({ ..., TinfK })`. Composition, scale heights, the
 * heavy/light differential expansion: all still the engine's. If you find
 * yourself writing a barometric exponential in here, stop.
 *
 * NORMALISATION — READ BEFORE "FIXING" THE NUMBERS
 * ────────────────────────────────────────────────
 * Both spatial terms are AREA-MEAN-PRESERVING by construction:
 *
 *   • The Jacchia-71 diurnal ratio is divided by its own global area
 *     average (`diurnalMeanRatio`, exact quadrature, cached per solar
 *     declination), so the area-weighted mean of the T∞ field equals
 *     the engine's `exosphereTempK(F10.7, Ap)` exactly.
 *   • The auroral term is a REDISTRIBUTION with zero area mean — the
 *     global Ap response already lives in the engine's `3·Ap` term, and
 *     adding a second positive Ap term here would double-count it.
 *
 * This is deliberate and it is gated by two tests. It means turning the
 * field ON does not silently move any number the page already reports;
 * it only says where in the world that number is high and where it is low.
 * If a future session wants the global mean to move, that belongs in the
 * engine's `exosphereTempK`, not here.
 *
 * WHAT IS MODEL AND WHAT IS MEASURED
 * ──────────────────────────────────
 *   • Jacchia-71 diurnal ratio           published formula, used verbatim
 *   • Bates T(z), diffusive equilibrium  engine, published formulation
 *   • Column integrals                   exact geometry, no fit
 *   • Auroral latitude shape             PARAMETERISED. A Gaussian in
 *     magnetic latitude. The 67°/13° centre+width track the statistical
 *     auroral oval; the amplitude is anchored so that the isolated
 *     auroral density enhancement at 400 km reaches ~1.6–1.7× at strong-
 *     storm Ap, the conservative end of what was inferred during the
 *     May-2024 Gannon storm. It is NOT MSIS and the page must never
 *     claim it is.
 *
 *     NOTE the enhancement is NOT monotonic in Ap — it peaks near ap≈200
 *     and eases at ap≈400. That is not a bug and not a fit artefact: the
 *     engine's global T∞ already grows linearly in Ap, the scale height
 *     grows with it, and dρ/ρ ≈ (z−z₀)/H · dT/T therefore loses leverage
 *     as the thermosphere inflates. The ABSOLUTE density keeps climbing
 *     throughout; only the auroral-to-global CONTRAST relaxes. Measured
 *     values are in the test.
 *   • Airglow volume emission rates      OBSERVED peak altitudes and
 *     widths from ground/limb photometry; the emission rates are
 *     order-of-magnitude typical values, used for RELATIVE brightness
 *     only. Nightglow is not a radiance calculation.
 */

import {
    density, exosphereTempK, batesTemperature, SPECIES,
} from './upper-atmosphere-engine.js';

const DEG = Math.PI / 180;

/** Mean Earth radius (km) — matches the engine's R_EARTH_M. */
export const R_EARTH_KM = 6371;

/** Modelled band. Below 80 km the engine's surrogate does not apply. */
export const MODEL_FLOOR_KM = 80;
export const MODEL_CEIL_KM  = 2000;

// ─────────────────────────────────────────────────────────────────────────
// 1. THE T∞ FIELD
// ─────────────────────────────────────────────────────────────────────────

/**
 * Jacchia-1971 diurnal variation of exospheric temperature.
 *
 *     η = |φ − δ| / 2
 *     θ = |φ + δ| / 2
 *     τ = H − 37° + 6° · sin(H + 43°)
 *     T_l / T_c = 1 + 0.3 · [ sin^2.2 θ
 *                             + (cos^2.2 η − sin^2.2 θ) · cos³(τ/2) ]
 *
 * with φ = geographic latitude, δ = solar declination, H = hour angle
 * (= 15° × (LST − 12 h)). The −37° in τ is what puts the bulge maximum
 * at ~14:00 local solar time rather than at local noon: the thermosphere
 * has thermal inertia and lags the heating. That lag is not decoration —
 * it is why a dawn-side and a dusk-side spacecraft at the same altitude
 * and latitude see different drag.
 *
 * Returns the RAW Jacchia ratio (nominally 1.0 … 1.3). Callers should use
 * `diurnalFactor` instead, which normalises by the global mean.
 *
 * @param {number} latDeg            geographic latitude, −90…+90
 * @param {number} localSolarTimeHr  0…24
 * @param {number} sunDeclDeg        solar declination, −23.44…+23.44
 */
export function jacchiaDiurnalRatio(latDeg, localSolarTimeHr, sunDeclDeg) {
    const phi   = latDeg * DEG;
    const delta = sunDeclDeg * DEG;

    const eta   = Math.abs(phi - delta) / 2;
    const theta = Math.abs(phi + delta) / 2;

    // Hour angle in degrees, wrapped to (−180, +180].
    let H = 15 * (localSolarTimeHr - 12);
    H = ((H + 180) % 360 + 360) % 360 - 180;

    // τ MUST be wrapped back into (−180°, +180°] as well (Jacchia 1971;
    // the wrap is explicit in Vallado's reference implementation). The
    // −37° shift pushes τ past −180° for hour angles near local midnight,
    // and there cos³(τ/2) goes NEGATIVE — which drives the ratio below 1
    // and makes the night side colder than T_c, the quantity T_c is
    // defined to be the minimum of. Wrapped, cos(τ/2) ≥ 0 everywhere, the
    // ratio is bounded in [1, 1.3], the maximum lands at ~14.1 h LST and
    // the minimum at ~2.9 h. Dropping the wrap looks harmless and silently
    // inverts the pre-dawn minimum; `tests/upper-atmosphere-column.mjs`
    // pins both extrema.
    let tauDeg = H - 37 + 6 * Math.sin((H + 43) * DEG);
    tauDeg = ((tauDeg + 180) % 360 + 360) % 360 - 180;
    const tau = tauDeg * DEG;

    // sin^2.2 / cos^2.2 — the fractional exponent needs a non-negative
    // base, which is guaranteed here since η, θ ∈ [0, π/2].
    const s = Math.pow(Math.abs(Math.sin(theta)), 2.2);
    const c = Math.pow(Math.abs(Math.cos(eta)),   2.2);
    const cos3 = Math.pow(Math.cos(tau / 2), 3);

    return 1 + 0.3 * (s + (c - s) * cos3);
}

// The global area-weighted mean of the raw Jacchia ratio depends ONLY on
// the solar declination, so it is worth computing exactly once per δ and
// caching. Gauss-free: a straightforward area-weighted (cos φ) double sum
// converges to ~1e-6 at these step counts, which is far below the
// precision anything downstream needs.
const _meanRatioCache = new Map();

/**
 * Area-weighted global mean of `jacchiaDiurnalRatio` at one declination.
 * This is the divisor that makes the T∞ field mean-preserving.
 */
export function diurnalMeanRatio(sunDeclDeg) {
    const key = Math.round(sunDeclDeg * 100) / 100;
    const hit = _meanRatioCache.get(key);
    if (hit !== undefined) return hit;

    const nLat = 90, nLst = 96;
    let num = 0, den = 0;
    for (let i = 0; i < nLat; i++) {
        // Cell centres in latitude, cos-weighted for spherical area.
        const lat = -90 + (i + 0.5) * (180 / nLat);
        const w = Math.cos(lat * DEG);
        for (let j = 0; j < nLst; j++) {
            const lst = (j + 0.5) * (24 / nLst);
            num += w * jacchiaDiurnalRatio(lat, lst, sunDeclDeg);
            den += w;
        }
    }
    const mean = num / den;
    _meanRatioCache.set(key, mean);
    return mean;
}

/**
 * Mean-preserving diurnal multiplier on T∞. Area-weighted global mean is
 * 1.0 by construction, so `Tinf(field)` averages to `exosphereTempK`.
 * Typical range ≈ 0.93 (pre-dawn minimum) … 1.13 (afternoon bulge).
 */
export function diurnalFactor(latDeg, localSolarTimeHr, sunDeclDeg) {
    return jacchiaDiurnalRatio(latDeg, localSolarTimeHr, sunDeclDeg)
         / diurnalMeanRatio(sunDeclDeg);
}

/** Statistical auroral-oval centre and width, in magnetic latitude. */
export const AURORAL_OVAL = Object.freeze({
    centreDeg: 67,
    widthDeg:  13,
    /**
     * Peak ΔT∞ saturates rather than growing without bound in Ap, but the
     * e-folding scale is deliberately NOT small: the engine's global T∞
     * grows linearly in Ap (3·Ap), so an auroral term that saturates early
     * would make the auroral-vs-equator CONTRAST shrink through the
     * strongest storms — backwards. At apScaleK = 260 the isolated auroral
     * density enhancement at 400 km rises monotonically across the whole
     * Ap range and reaches ~1.6× at G5, which is the conservative end of
     * what was observed during Gannon. Measured, not guessed; the test
     * pins the monotonicity.
     */
    peakDeltaK: 650,
    apScaleK:   260,
});

/**
 * Raw auroral Joule-heating ΔT∞ (K) before the zero-mean subtraction.
 * Gaussian in |magnetic latitude| about the statistical oval, saturating
 * in Ap. PARAMETERISED — see the header. Both ovals are heated.
 */
export function auroralHeatingRawK(magLatDeg, ap) {
    const { centreDeg, widthDeg, peakDeltaK, apScaleK } = AURORAL_OVAL;
    const apSafe = Math.max(0, Number.isFinite(ap) ? ap : 0);
    const amp = peakDeltaK * (1 - Math.exp(-apSafe / apScaleK));
    const d = (Math.abs(magLatDeg) - centreDeg) / widthDeg;
    return amp * Math.exp(-d * d);
}

const _auroralMeanCache = new Map();

/**
 * Area-weighted global mean of `auroralHeatingRawK` at one Ap. Subtracted
 * so the auroral term REDISTRIBUTES heat rather than adding a second
 * global Ap response on top of the engine's `3·Ap`.
 */
export function auroralMeanK(ap) {
    const key = Math.round(ap * 10) / 10;
    const hit = _auroralMeanCache.get(key);
    if (hit !== undefined) return hit;
    const nLat = 720;
    let num = 0, den = 0;
    for (let i = 0; i < nLat; i++) {
        const lat = -90 + (i + 0.5) * (180 / nLat);
        const w = Math.cos(lat * DEG);
        num += w * auroralHeatingRawK(lat, ap);
        den += w;
    }
    const mean = num / den;
    _auroralMeanCache.set(key, mean);
    return mean;
}

/** Zero-area-mean auroral ΔT∞ (K). Positive in the ovals, mildly negative elsewhere. */
export function auroralHeatingK(magLatDeg, ap) {
    return auroralHeatingRawK(magLatDeg, ap) - auroralMeanK(ap);
}

/**
 * Centred-dipole magnetic latitude from geographic (lat, lon).
 *
 * Uses the IGRF-epoch geomagnetic north pole. This page does NOT need the
 * full field evaluation — the auroral term is a Gaussian shape function
 * whose width (13°) is far broader than the error a centred dipole makes
 * against IGRF (a few degrees). `js/geomag/igrf.js` is the site's single
 * source of truth for actual FIELD EVALUATION and this is deliberately
 * not that: it is a coordinate, not a field value.
 */
export const DIPOLE_POLE = Object.freeze({ latDeg: 80.65, lonDeg: -72.68 });

export function magneticLatitude(latDeg, lonDeg) {
    const p  = DIPOLE_POLE;
    const la = latDeg * DEG, lo = lonDeg * DEG;
    const pa = p.latDeg * DEG, po = p.lonDeg * DEG;
    // Angular distance from the dipole pole; magnetic latitude is 90° minus it.
    const cosc = Math.sin(pa) * Math.sin(la)
               + Math.cos(pa) * Math.cos(la) * Math.cos(lo - po);
    const colat = Math.acos(Math.max(-1, Math.min(1, cosc)));
    return 90 - colat / DEG;
}

/**
 * The full exospheric-temperature field at one point.
 *
 * @returns {{ Tinf:number, TinfGlobal:number, diurnal:number,
 *             auroralK:number, magLatDeg:number }}
 */
export function exosphereTempField({
    latDeg, lonDeg = 0, localSolarTimeHr, sunDeclDeg = 0,
    f107Sfu = 150, ap = 15, magLatDeg = null,
}) {
    const TinfGlobal = exosphereTempK(f107Sfu, ap);
    const diurnal = diurnalFactor(latDeg, localSolarTimeHr, sunDeclDeg);
    const mLat = Number.isFinite(magLatDeg)
        ? magLatDeg
        : magneticLatitude(latDeg, lonDeg);
    const auroralK = auroralHeatingK(mLat, ap);
    // Floor at 300 K: the engine's own clamp. A deeply negative auroral
    // residual at a very low TinfGlobal must not produce a non-physical
    // exosphere temperature.
    const Tinf = Math.max(300, TinfGlobal * diurnal + auroralK);
    return { Tinf, TinfGlobal, diurnal, auroralK, magLatDeg: mLat };
}

/**
 * Density at a point in the 3-D field: the engine's density model
 * evaluated at the LOCAL T∞ rather than the global one.
 *
 * Returns the engine record plus `rhoGlobal` (what the spherically
 * symmetric model would have said) and `rhoRatio = rho / rhoGlobal` —
 * the number an operator actually wants, because it is the local drag
 * multiplier relative to the page's headline figure.
 */
export function densityFieldAt({
    altKm, latDeg, lonDeg = 0, localSolarTimeHr, sunDeclDeg = 0,
    f107Sfu = 150, ap = 15,
}) {
    const field = exosphereTempField({
        latDeg, lonDeg, localSolarTimeHr, sunDeclDeg, f107Sfu, ap,
    });
    const local  = density({ altitudeKm: altKm, f107Sfu, ap, TinfK: field.Tinf });
    const global = density({ altitudeKm: altKm, f107Sfu, ap });
    return {
        ...local,
        ...field,
        rhoGlobal: global.rho,
        rhoRatio:  global.rho > 0 ? local.rho / global.rho : 1,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. AIRGLOW — the part of the atmosphere you can actually see
// ─────────────────────────────────────────────────────────────────────────

/**
 * Observed nightglow / dayglow emission layers.
 *
 * These are the structures that make the atmosphere VISIBLE in every
 * astronaut photograph of the limb: a thin green-white band at ~90–100 km
 * and, above it, a much fainter and much broader red F-region glow. They
 * are chemiluminescent — the emission rate does NOT simply track ρ, which
 * is why they are carried separately from the density field and not folded
 * into it.
 *
 *   peakKm     altitude of peak volume emission rate
 *   fwhmKm     full width at half maximum of the emitting layer
 *   nm         emission wavelength
 *   ver        typical peak volume emission rate, photons cm⁻³ s⁻¹.
 *              ORDER OF MAGNITUDE, for RELATIVE brightness only — this
 *              module does not compute radiance and must not claim to.
 *   rgb        display colour. For the visible lines this is the real
 *              colour of the wavelength. Lyman-α is UV: its colour is a
 *              FALSE-COLOUR mapping and every consumer must say so.
 *   visible    is this emission visible to the human eye?
 *   visibleFraction
 *              fraction of this layer's emission that lands in the visible
 *              band. THIS IS WHAT MAKES THE RENDER LOOK RIGHT. Weighting
 *              the display colour by raw `ver` makes the airglow band
 *              ORANGE, because OH Meinel outshines every other layer by
 *              an order of magnitude in total photons — but ~98 % of that
 *              is at 1.5–2.0 µm and invisible. Weighted by visible photons
 *              the band comes out green-dominant at 92–105 km over a dim
 *              red-brown base at 87 km, which is what the band looks like
 *              in every astronaut photograph of the limb.
 *   apGain     fractional brightening per unit Ap (auroral coupling)
 *   f107Gain   fractional brightening per SFU above 150 (EUV coupling)
 */
export const AIRGLOW_LAYERS = Object.freeze([
    {
        id: 'oh-meinel', label: 'OH Meinel', nm: 730,
        peakKm: 87, fwhmKm: 8, ver: 8000,
        rgb: [1.00, 0.42, 0.26], visible: true,
        apGain: 0.0000, f107Gain: 0.0000,
        visibleFraction: 0.02,   // Only the high-Δv bands at 600-800 nm reach the eye.
        note: 'Hydroxyl vibrational bands from H + O₃. Peak emission is '
            + 'near-IR; the visible tail is the dim red-brown floor of the '
            + 'airglow band.',
    },
    {
        id: 'na-d', label: 'Na D', nm: 589,
        peakKm: 92, fwhmKm: 10, ver: 120,
        rgb: [1.00, 0.78, 0.36], visible: true,
        apGain: 0.0000, f107Gain: 0.0000,
        visibleFraction: 1.00,   // A visible-light resonance line.
        note: 'Sodium layer fed by meteoric ablation — the same atoms '
            + 'sodium laser guide stars excite.',
    },
    {
        id: 'o2-atm', label: 'O₂ atmospheric', nm: 762,
        peakKm: 94, fwhmKm: 12, ver: 1500,
        rgb: [1.00, 0.55, 0.42], visible: false,
        apGain: 0.0000, f107Gain: 0.0000,
        visibleFraction: 0.05,   // 762 nm sits at the far red edge of vision.
        note: 'O₂(b¹Σ) band from three-body recombination. Just past the '
            + 'red limit of vision.',
    },
    {
        id: 'o-green', label: 'O(¹S) green line', nm: 557.7,
        peakKm: 97, fwhmKm: 10, ver: 900,
        rgb: [0.42, 1.00, 0.62], visible: true,
        apGain: 0.0022, f107Gain: 0.0010,
        visibleFraction: 1.00,   // The green line, squarely in the eye's peak response.
        note: 'The green line. Barth-mechanism recombination of atomic '
            + 'oxygen. This is the sharp green band on the limb in ISS '
            + 'photographs, and the same transition the aurora emits.',
    },
    {
        id: 'o-red', label: 'O(¹D) red line', nm: 630.0,
        peakKm: 250, fwhmKm: 90, ver: 60,
        rgb: [1.00, 0.30, 0.34], visible: true,
        apGain: 0.0040, f107Gain: 0.0016,
        visibleFraction: 1.00,   // 630 nm, deep red but visible.
        note: 'F-region red line from dissociative recombination of O₂⁺. '
            + 'Broad, faint, and the first thing to brighten when the '
            + 'thermosphere is disturbed.',
    },
    {
        id: 'geocorona', label: 'H Lyman-α geocorona', nm: 121.6,
        peakKm: 1400, fwhmKm: 2200, ver: 25,
        rgb: [0.55, 0.62, 1.00], visible: false,
        apGain: 0.0000, f107Gain: 0.0026,
        visibleFraction: 0.00,   // Far ultraviolet. Nothing reaches the eye at all.
        note: 'Resonantly scattered solar Lyman-α from the hydrogen '
            + 'exosphere. FALSE COLOUR — this is far ultraviolet and is '
            + 'invisible to the eye. It extends well past this page\'s '
            + '2000 km ceiling, out beyond lunar distance.',
    },
]);

/**
 * Airglow volume emission rate at one altitude, summed over layers.
 *
 * Each layer is a Gaussian in altitude about its observed peak, scaled by
 * its activity gains.
 *
 * TWO totals come back and they answer different questions:
 *   total         physical volume emission rate over ALL wavelengths
 *   visibleTotal  the part of it in the visible band
 * and correspondingly `rgbPhysical` (all-photon weighted, a false colour)
 * and `rgb` (visible-photon weighted, what an eye would see). A renderer
 * claiming to show what the limb looks like must use the visible pair;
 * see `visibleFraction` in the layer table for why this is not a detail.
 */
export function airglowAt(altKm, { f107Sfu = 150, ap = 15 } = {}) {
    let total = 0;             // physical VER sum, all layers
    let visibleTotal = 0;      // the part in the visible band
    const rgb = [0, 0, 0];     // visible-weighted — "what you would see"
    const rgbPhysical = [0, 0, 0];
    const byLayer = {};
    for (const L of AIRGLOW_LAYERS) {
        const sigma = L.fwhmKm / 2.3548;          // FWHM → Gaussian σ
        const d = (altKm - L.peakKm) / sigma;
        const shape = Math.exp(-0.5 * d * d);
        const gain = 1
            + L.apGain   * Math.max(0, ap)
            + L.f107Gain * (f107Sfu - 150);
        const v = L.ver * shape * Math.max(0, gain);
        const vv = v * L.visibleFraction;
        byLayer[L.id] = v;
        total += v;
        visibleTotal += vv;
        for (let k = 0; k < 3; k++) {
            rgb[k] += vv * L.rgb[k];
            rgbPhysical[k] += v * L.rgb[k];
        }
    }
    if (visibleTotal > 0) for (let k = 0; k < 3; k++) rgb[k] /= visibleTotal;
    if (total > 0) for (let k = 0; k < 3; k++) rgbPhysical[k] /= total;
    return { total, visibleTotal, rgb, rgbPhysical, byLayer };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. COLUMNS — what a view ray actually integrates
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tangent altitude (km) of a ray, i.e. the altitude of its closest
 * approach to the Earth's centre. Negative return means the ray strikes
 * the solid Earth and there is no tangent point above the surface.
 *
 * @param {number} camAltKm    observer altitude above the surface
 * @param {number} offAxisRad  angle between the view ray and the
 *                             direction from the observer to Earth centre
 */
export function tangentAltitudeKm(camAltKm, offAxisRad) {
    const r = R_EARTH_KM + camAltKm;
    // Perpendicular distance from the centre to the ray line.
    const b = r * Math.sin(Math.abs(offAxisRad));
    // Behind-the-observer half-space: the closest approach is not on the
    // forward ray at all, so the ray only recedes.
    if (Math.abs(offAxisRad) > Math.PI / 2) return camAltKm;
    return b - R_EARTH_KM;
}

/**
 * Integrate ρ along a ray through the spherically symmetric profile.
 *
 * SAMPLING IS UNIFORM IN ARC LENGTH, AND THAT IS THE MEASURED CHOICE.
 * The obvious "optimisation" here is to space nodes quadratically about
 * the tangent point: altitude grows as h ≈ h_t + s²/(2 r_t), so quadratic
 * spacing in s is nearly linear spacing in altitude, which sounds like
 * exactly the importance sampling an exponential integrand wants. It was
 * built that way first. It is WORSE, by one to two orders of magnitude:
 *
 *     tangent alt   uniform-64      quadratic-64
 *         85 km      0.003 %          0.163 %
 *        100 km      0.011 %          0.159 %
 *        400 km      0.000 %          0.050 %
 *
 * (errors against a 6000-step reference). The reason is Euler–Maclaurin:
 * along the ray the integrand is smooth and decays to zero at both ends
 * with all its derivatives, so the trapezoidal rule on EQUALLY spaced
 * nodes has no boundary terms left and converges superalgebraically —
 * the same reason trapezoid is exact-to-machine-precision on a Gaussian.
 * Unequal spacing destroys that cancellation and drops you back to plain
 * O(h²). Do not "improve" this back to importance sampling without
 * re-running the comparison in `tests/upper-atmosphere-column.mjs`, which
 * pins it.
 *
 * @param {object} opts
 * @param {number} opts.tangentAltKm  tangent altitude of the ray (km)
 * @param {number} [opts.steps=64]    samples per half-ray
 * @param {number} [opts.ceilKm]      integrate out to this altitude
 * @returns {{ columnKgM2:number, pathEquivKm:number, peakAltKm:number,
 *             rhoTangent:number }}
 */
export function rayColumn({
    tangentAltKm, f107Sfu = 150, ap = 15,
    steps = 64, ceilKm = MODEL_CEIL_KM, TinfK = null,
}) {
    const hT = Math.max(MODEL_FLOOR_KM, tangentAltKm);
    if (hT >= ceilKm) {
        return { columnKgM2: 0, pathEquivKm: 0, peakAltKm: hT, rhoTangent: 0 };
    }
    const rT = R_EARTH_KM + hT;
    const rC = R_EARTH_KM + ceilKm;
    // Half-chord length from the tangent point out to the model ceiling.
    const sMax = Math.sqrt(Math.max(0, rC * rC - rT * rT));

    const rhoAt = (h) => density({
        altitudeKm: Math.min(Math.max(h, MODEL_FLOOR_KM), MODEL_CEIL_KM),
        f107Sfu, ap, TinfK,
    }).rho;

    // Uniform trapezoid over one half-ray, doubled by symmetry.
    const ds = sMax / steps;
    let acc = 0;
    let rhoPrev = rhoAt(hT);
    const rhoTangent = rhoPrev;
    for (let i = 1; i <= steps; i++) {
        const s = ds * i;
        const r = Math.sqrt(rT * rT + s * s);
        const rho = rhoAt(r - R_EARTH_KM);
        acc += 0.5 * (rho + rhoPrev) * ds;
        rhoPrev = rho;
    }
    // ×2 for both halves; ×1000 converts the km path into metres so the
    // column comes out in kg/m².
    const columnKgM2 = 2 * acc * 1000;
    return {
        columnKgM2,
        pathEquivKm: rhoTangent > 0 ? columnKgM2 / (rhoTangent * 1000) : 0,
        peakAltKm: hT,
        rhoTangent,
    };
}

/**
 * Analytic Chapman limb path length: for an exponential atmosphere of
 * local scale height H, a tangent ray's column equals ρ(h_t) × √(2π r H).
 *
 * This is the closed form the numerical `rayColumn` is checked against —
 * they agree to a few percent, which is as close as they should agree
 * given that H actually varies along the ray. Exported because it is also
 * the honest one-line answer to "why is the limb bright?": at 400 km it
 * says a limb ray carries ~1600 km worth of local atmosphere, roughly 27
 * scale heights, and that is the limb-brightening factor.
 */
export function limbPathEquivalentKm(altKm, { f107Sfu = 150, ap = 15, TinfK = null } = {}) {
    const rec = density({ altitudeKm: altKm, f107Sfu, ap, TinfK });
    const H = rec.H_km;
    if (!Number.isFinite(H) || H <= 0) return 0;
    return Math.sqrt(2 * Math.PI * (R_EARTH_KM + altKm) * H);
}

/**
 * Integrate airglow volume emission along a tangent ray. Same uniform
 * sampling as `rayColumn`. Returns a relative brightness (the VER unit is
 * photons cm⁻³ s⁻¹ and the path is in km, so the product is a Rayleigh-
 * like quantity up to a constant) plus the integrated colour.
 */
export function airglowColumn({
    tangentAltKm, f107Sfu = 150, ap = 15, steps = 64,
    ceilKm = MODEL_CEIL_KM,
}) {
    const hT = Math.max(MODEL_FLOOR_KM, tangentAltKm);
    if (hT >= ceilKm) return { brightness: 0, rgb: [0, 0, 0] };
    const rT = R_EARTH_KM + hT;
    const rC = R_EARTH_KM + ceilKm;
    const sMax = Math.sqrt(Math.max(0, rC * rC - rT * rT));

    let total = 0;
    const rgb = [0, 0, 0];
    const ds = sMax / steps;
    let prev = airglowAt(hT, { f107Sfu, ap });
    for (let i = 1; i <= steps; i++) {
        const h = Math.sqrt(rT * rT + (ds * i) * (ds * i)) - R_EARTH_KM;
        const cur = airglowAt(h, { f107Sfu, ap });
        total += 0.5 * (cur.visibleTotal + prev.visibleTotal) * ds;
        for (let k = 0; k < 3; k++) {
            rgb[k] += 0.5 * (cur.visibleTotal * cur.rgb[k]
                           + prev.visibleTotal * prev.rgb[k]) * ds;
        }
        prev = cur;
    }
    const brightness = 2 * total;
    if (total > 0) for (let k = 0; k < 3; k++) rgb[k] /= total;
    return { brightness, rgb };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. LOOKUP TABLES for the renderer
// ─────────────────────────────────────────────────────────────────────────

/**
 * Species display colours. Shared with upper-atmosphere-physics.js's
 * SPECIES_COLOR_HEX — kept as floats here because the shader wants them
 * that way and a second hex→float conversion per frame is waste.
 */
export const SPECIES_RGB = Object.freeze({
    N2: [0.23, 0.50, 1.00],
    O2: [0.30, 0.78, 1.00],
    NO: [0.50, 0.88, 0.63],
    O:  [1.00, 0.70, 0.28],
    N:  [0.75, 0.47, 1.00],
    He: [1.00, 0.43, 0.53],
    H:  [1.00, 0.88, 0.42],
});

/**
 * Build the altitude lookup table the volumetric renderer samples.
 *
 * Row 0 — the neutral atmosphere:
 *   rgb  species-number-weighted colour at that altitude (so the render's
 *        colour gradient IS the composition profile, not a decorator's
 *        palette: N₂ blue at the bottom, atomic-O amber through the
 *        thermosphere, He pink and H yellow in the exosphere)
 *   a    log-density emission weight, normalised over the band
 *
 * Row 1 — airglow:
 *   rgb  VISIBLE-photon-weighted emission colour (see `visibleFraction`)
 *   a    visible-band emission rate, normalised over the band
 *
 * `logRhoMin`/`logRhoMax` are returned so the shader can undo the
 * normalisation, and so instruments can label a colour bar honestly.
 *
 * @returns {{ data:Float32Array, bins:number, rows:number,
 *             minKm:number, maxKm:number,
 *             logRhoMin:number, logRhoMax:number, airglowMax:number }}
 */
export function buildAtmosphereLUT({
    f107Sfu = 150, ap = 15, bins = 128,
    minKm = MODEL_FLOOR_KM, maxKm = MODEL_CEIL_KM,
} = {}) {
    const rows = 2;
    const data = new Float32Array(bins * rows * 4);

    const rho = new Array(bins);
    const cols = new Array(bins);
    const glow = new Array(bins);

    for (let i = 0; i < bins; i++) {
        const altKm = minKm + (maxKm - minKm) * (i / (bins - 1));
        const rec = density({ altitudeKm: altKm, f107Sfu, ap });
        rho[i] = rec.rho;

        // Composition colour: number-fraction weighted, then boosted
        // toward the dominant species so the transitions stay legible
        // instead of averaging to grey.
        let r = 0, g = 0, b = 0, wsum = 0;
        for (const s of SPECIES) {
            const f = rec.fractions[s] ?? 0;
            const w = Math.pow(f, 0.7);      // <1 exponent keeps minor
            const c = SPECIES_RGB[s];        // species from vanishing
            if (!c) continue;
            r += w * c[0]; g += w * c[1]; b += w * c[2]; wsum += w;
        }
        cols[i] = wsum > 0 ? [r / wsum, g / wsum, b / wsum] : [1, 1, 1];
        glow[i] = airglowAt(altKm, { f107Sfu, ap });
    }

    const logs = rho.map(v => Math.log10(Math.max(v, 1e-30)));
    const logRhoMax = Math.max(...logs);
    const logRhoMin = Math.min(...logs);
    const span = Math.max(logRhoMax - logRhoMin, 1e-6);
    const airglowMax = Math.max(...glow.map(g => g.visibleTotal), 1e-9);

    for (let i = 0; i < bins; i++) {
        const o0 = i * 4;
        data[o0 + 0] = cols[i][0];
        data[o0 + 1] = cols[i][1];
        data[o0 + 2] = cols[i][2];
        data[o0 + 3] = (logs[i] - logRhoMin) / span;

        const o1 = (bins + i) * 4;
        data[o1 + 0] = glow[i].rgb[0];
        data[o1 + 1] = glow[i].rgb[1];
        data[o1 + 2] = glow[i].rgb[2];
        data[o1 + 3] = glow[i].visibleTotal / airglowMax;
    }

    return {
        data, bins, rows, minKm, maxKm,
        logRhoMin, logRhoMax, airglowMax,
    };
}

/**
 * Vertical profile for the on-canvas limb probe: ρ, T and airglow on a
 * log-altitude grid, with the tangent altitude marked. Log spacing
 * because the interesting structure (airglow band, drag shell) is all in
 * the bottom decade and a linear grid spends 90 % of its points above it.
 */
export function probeProfile({
    f107Sfu = 150, ap = 15, n = 72,
    minKm = MODEL_FLOOR_KM, maxKm = MODEL_CEIL_KM,
    TinfK = null,
}) {
    const out = [];
    const l0 = Math.log(minKm), l1 = Math.log(maxKm);
    for (let i = 0; i < n; i++) {
        // exp(log(minKm)) can land a half-ULP BELOW minKm, and the engine
        // throws below its 80 km floor rather than extrapolating. Clamp.
        const altKm = Math.min(maxKm,
            Math.max(minKm, Math.exp(l0 + (l1 - l0) * (i / (n - 1)))));
        const rec = density({ altitudeKm: altKm, f107Sfu, ap, TinfK });
        const g = airglowAt(altKm, { f107Sfu, ap });
        out.push({
            altKm, rho: rec.rho, T: rec.T, H_km: rec.H_km,
            airglow: g.visibleTotal,
            airglowAll: g.total,
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 5. SOLAR GEOMETRY helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Local solar time (hours) at a longitude, given the sub-solar longitude.
 * LST = 12 h at the sub-solar meridian by definition.
 */
export function localSolarTime(lonDeg, subSolarLonDeg) {
    let d = lonDeg - subSolarLonDeg;
    d = ((d + 180) % 360 + 360) % 360 - 180;
    return (12 + d / 15 + 24) % 24;
}

/**
 * Where the diurnal bulge actually sits: the peak of the Jacchia ratio in
 * local solar time at a given latitude. Reported by the canvas compass so
 * the lag behind the sub-solar point is legible rather than implied.
 */
export function bulgeLocalSolarTime(latDeg = 0, sunDeclDeg = 0) {
    let best = 0, bestV = -Infinity;
    for (let i = 0; i < 288; i++) {
        const lst = i * (24 / 288);
        const v = jacchiaDiurnalRatio(latDeg, lst, sunDeclDeg);
        if (v > bestV) { bestV = v; best = lst; }
    }
    return best;
}

/**
 * Day/night density contrast at one altitude — the single number that
 * says how much the diurnal bulge matters at the altitude you are
 * looking at. Grows with altitude because the bulge is a temperature
 * effect and temperature sets the scale height.
 */
export function diurnalContrast({
    altKm, latDeg = 0, sunDeclDeg = 0, f107Sfu = 150, ap = 15,
}) {
    const lstMax = bulgeLocalSolarTime(latDeg, sunDeclDeg);
    const lstMin = (lstMax + 12) % 24;
    const hot = densityFieldAt({
        altKm, latDeg, localSolarTimeHr: lstMax, sunDeclDeg, f107Sfu, ap,
    });
    const cold = densityFieldAt({
        altKm, latDeg, localSolarTimeHr: lstMin, sunDeclDeg, f107Sfu, ap,
    });
    return {
        ratio: cold.rho > 0 ? hot.rho / cold.rho : 1,
        hotRho: hot.rho, coldRho: cold.rho,
        lstMax, lstMin,
        TinfHot: hot.Tinf, TinfCold: cold.Tinf,
    };
}

/**
 * (latitude, local solar time) at a scene-space point.
 *
 * ═══ THE GLSL IN `upper-atmosphere-volume.js` MIRRORS THIS FUNCTION. ═══
 * They must change together. This one is the oracle — it is the one with
 * a test — and `tests/upper-atmosphere-column.mjs` checks it against
 * `localSolarTime` on the same geometry so a sign error cannot ship.
 *
 * The scene convention (set by `_subSolarToVec3` in the globe module) is
 *     x = cos(lat)·cos(lon),  y = sin(lat),  z = cos(lat)·sin(lon)
 * so +Y is the north pole and longitude increases from +X toward +Z —
 * i.e. CLOCKWISE seen from +Y, which is why the hour angle is measured
 * about −north and not +north. Getting that sign wrong puts the diurnal
 * bulge on the morning side, where it is not, and nothing else in the
 * render looks any different.
 *
 * @param {number[]} p    position (need not be normalised)
 * @param {number[]} sun  sub-solar direction (unit)
 * @param {number[]} north north-pole axis (unit; +Y in this scene)
 * @returns {{ latDeg:number, lstHr:number }}
 */
export function geoFromVectors(p, sun, north = [0, 1, 0]) {
    const [px, py, pz] = p, [sx, sy, sz] = sun, [nx, ny, nz] = north;
    const pl = Math.hypot(px, py, pz) || 1;
    const ux = px / pl, uy = py / pl, uz = pz / pl;

    const latDeg = Math.asin(Math.max(-1, Math.min(1, ux * nx + uy * ny + uz * nz))) / DEG;

    // Project both directions onto the equatorial plane.
    const pn = ux * nx + uy * ny + uz * nz;
    let ex = ux - pn * nx, ey = uy - pn * ny, ez = uz - pn * nz;
    const sn = sx * nx + sy * ny + sz * nz;
    let fx = sx - sn * nx, fy = sy - sn * ny, fz = sz - sn * nz;
    const el = Math.hypot(ex, ey, ez), fl = Math.hypot(fx, fy, fz);
    // At a pole the meridian is undefined; local time is meaningless there
    // and the caller should not be reading it. Noon is the least surprising
    // answer and keeps the shader branch-free.
    if (el < 1e-9 || fl < 1e-9) return { latDeg, lstHr: 12 };
    ex /= el; ey /= el; ez /= el;
    fx /= fl; fy /= fl; fz /= fl;

    // Signed angle from the sub-solar meridian to this one, about −north.
    const cx = fy * ez - fz * ey;
    const cy = fz * ex - fx * ez;
    const cz = fx * ey - fy * ex;
    const sinA = -(cx * nx + cy * ny + cz * nz);
    const cosA = fx * ex + fy * ey + fz * ez;
    const hourDeg = Math.atan2(sinA, cosA) / DEG;
    return { latDeg, lstHr: (12 + hourDeg / 15 + 24) % 24 };
}

/**
 * 2-D lookup table over (altitude, T∞) for the volumetric renderer.
 *
 * This is what lets the shader show the diurnal bulge and the auroral
 * inflation WITHOUT a second density model and WITHOUT an invented
 * "bulge multiplier". The shader computes the local T∞ from the same
 * Jacchia formula this module exports, looks the density up in this
 * table, and gets the engine's own answer back — heavy/light differential
 * expansion included. A multiplier could not do that: the response to a
 * given ΔT∞ is strongly altitude-dependent (≈1.0× at 120 km, ≈1.7× at
 * 400 km for the same 500 K), which is precisely the structure that makes
 * the bulge visible at orbital altitudes and invisible at the mesopause.
 *
 * Values are normalised log₁₀ ρ over the WHOLE table so the shader can
 * recover ρ/ρ_max as 10^((v − 1)·span).
 *
 * @returns {{ data:Float32Array, altBins:number, tinfBins:number,
 *             minKm:number, maxKm:number, tinfMin:number, tinfMax:number,
 *             logRhoMin:number, logRhoMax:number, spanDecades:number }}
 */
export function buildFieldLUT({
    f107Sfu = 150, ap = 15,
    altBins = 96, tinfBins = 24,
    minKm = MODEL_FLOOR_KM, maxKm = MODEL_CEIL_KM,
    tinfMin = 400, tinfMax = 3000,
} = {}) {
    const logs = new Float32Array(altBins * tinfBins);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < tinfBins; j++) {
        const Tinf = tinfMin + (tinfMax - tinfMin) * (j / (tinfBins - 1));
        for (let i = 0; i < altBins; i++) {
            const altKm = minKm + (maxKm - minKm) * (i / (altBins - 1));
            const rho = density({ altitudeKm: altKm, f107Sfu, ap, TinfK: Tinf }).rho;
            const l = Math.log10(Math.max(rho, 1e-30));
            logs[j * altBins + i] = l;
            if (l < lo) lo = l;
            if (l > hi) hi = l;
        }
    }
    const span = Math.max(hi - lo, 1e-6);
    // RGBA so it can go straight into a THREE.DataTexture without a
    // format branch; only R is read by the shader.
    const data = new Float32Array(altBins * tinfBins * 4);
    for (let k = 0; k < altBins * tinfBins; k++) {
        const v = (logs[k] - lo) / span;
        data[k * 4] = v;
        data[k * 4 + 1] = v;
        data[k * 4 + 2] = v;
        data[k * 4 + 3] = 1;
    }
    return {
        data, altBins, tinfBins, minKm, maxKm, tinfMin, tinfMax,
        logRhoMin: lo, logRhoMax: hi, spanDecades: span,
    };
}
