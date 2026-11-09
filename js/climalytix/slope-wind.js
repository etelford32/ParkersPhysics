/**
 * climalytix/slope-wind.js — anabatic / katabatic slope winds (plan §19 T3), PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * A heated slope warms the air touching it; that air is lighter than the air
 * at the same height away from the slope and slides UP the slope (anabatic,
 * by day). A cooling slope makes heavy air that drains DOWN it (katabatic,
 * by night). The steady laminar solution is Prandtl (1942), with n the
 * distance normal to the slope, α its angle, N the background buoyancy
 * frequency, K / K_h the momentum / heat diffusivities (Pr = K/K_h):
 *
 *     θ'(n) = Δθ · e^(−n/λ) · cos(n/λ)          (temperature excess)
 *     u(n)  = Δθ · μ · e^(−n/λ) · sin(n/λ)       (along-slope, + = UPSLOPE)
 *     λ     = (4·K·K_h / (N²·sin²α))^(1/4)
 *     μ     = g / (θ₀ · N · √Pr)                (m/s per K)
 *
 * It solves  K·d²u/dn² = −(g/θ₀)·sin α·θ′  and  K_h·d²θ′/dn² = (N²θ₀/g)·sin α·u  with
 * u(0) = 0, θ′(0) = Δθ (the gate checks both ODEs by finite differences). The
 * jet peaks at n = πλ/4 with u_max = e^(−π/4)·sin(π/4)·μ·Δθ = 0.3224·μ·Δθ —
 * Prandtl's own result that the SPEED does not depend on the slope angle; the
 * angle only sets the jet's THICKNESS (λ ∝ sin^(−½)α).
 *
 * NB plan §19 first wrote the amplitude as Δθ·√(g·K/(θ₀·N²·Pr)); that is not
 * a speed (its units are m^(3/2) s^(−1/2) K^(1/2)) and the gate keeps it as a
 * NEGATIVE CONTROL that fails the momentum equation.
 *
 * THE FORCING — Δθ — is where the data comes in, and it is a MODEL:
 *   Q   = absorbed direct sunlight on THIS slope − net longwave loss   (W/m²)
 *       sunlight: Meinel & Meinel (1976) clear-sky beam, 1361·0.7^(AM^0.678),
 *       air mass Kasten–Young (1989), × the slope's own incidence (T1's
 *       `incidence`), × (1 − ALBEDO), × Kasten–Czeplak (1980) cloud damping
 *       1 − 0.75·c^3.4 with c the GFS total cloud fraction;
 *       longwave: a clear-sky net loss LW_CLEAR, × (1 − LW_CLOUD·c)
 *   Δθ  = Q / h, with a DAY and a NIGHT surface heat-transfer coefficient
 *       (a stable night decouples the surface from the air, which is why a
 *       small loss builds a strong inversion; a convective day mixes heat
 *       away). h, N and K are FIXED, disclosed constants — not computed from a
 *       sounding — chosen so typical cases land in the observed ranges
 *       (Whiteman 2000: upslope ~1–5 m/s, downslope ~1–3 m/s on moderate
 *       slopes); the gate pins that calibration as ranges, not as truth.
 * So DIRECTION (upslope/downslope along the fall line), TIMING (the sign
 * changes where sunlight balances the longwave loss, earlier on a slope
 * that faces the morning Sun) and RELATIVE strength (sun-facing slopes, clear
 * vs cloudy) are the layer's claims; absolute speed is an order of magnitude.
 *
 * Three things the page discloses because the model does not do them: no
 * cast shadows (a slope only shades itself, as in T1), no valley/mountain
 * wind or synoptic wind on top, and a daytime convective boundary layer is
 * not a laminar jet (the stable-N Prandtl solution is the standard
 * idealisation, not a description of afternoon turbulence).
 *
 * GENTLE SLOPES ARE LEFT BLANK, not drawn at full speed: the flow spins up
 * with Prandtl's oscillation period 2π/(N·sin α), and where that exceeds
 * PERIOD_MAX_S the heating changes before the steady state the model draws
 * can exist (1.7° at night, 3.3° by day with the constants below).
 */

const D2R = Math.PI / 180;
export const G = 9.80665;
/** u_max / (μ·Δθ) = e^(−π/4)·sin(π/4). */
export const PRANDTL_PEAK = Math.exp(-Math.PI / 4) * Math.sin(Math.PI / 4);

export const SOLAR_CONSTANT = 1361;          // W/m²
export const ALBEDO = 0.2;                   // a vegetated/rocky slope; snow would be ~0.7 (disclosed)
export const LW_CLEAR = 80;                  // clear-sky net longwave loss, W/m²
export const LW_CLOUD = 0.9;                 // overcast removes ~90 % of it
export const H_DAY = 150;                    // W m⁻² K⁻¹, convective day
export const H_NIGHT = 20;                   // W m⁻² K⁻¹, stable night
export const N_DAY = 0.010;                  // s⁻¹, free troposphere
export const N_NIGHT = 0.020;                // s⁻¹, nocturnal inversion
export const K_DAY = 5;                      // m²/s
export const K_NIGHT = 0.5;                  // m²/s
export const PR = 1;
export const PERIOD_MAX_S = 3 * 3600;
export const THETA0_DEFAULT_K = 288.15;
/** Below this slope the ground is flat: no fall line, no slope wind. */
export const FLAT_DEG = 0.5;

/** Prandtl scales for one slope. `dTheta` only enters u_max. */
export function prandtlScales({ dTheta = 0, slopeDeg, N, K, Pr = PR, theta0K = THETA0_DEFAULT_K }) {
    const s = Math.sin(slopeDeg * D2R);
    const Kh = K / Pr;
    const lambda = s > 0 ? Math.pow(4 * K * Kh / (N * N * s * s), 0.25) : Infinity;
    const mu = G / (theta0K * N * Math.sqrt(Pr));
    return {
        lambda, mu, Kh,
        uMax: PRANDTL_PEAK * mu * dTheta,
        zJet: Math.PI * lambda / 4,
        periodS: s > 0 ? 2 * Math.PI / (N * s) : Infinity,
    };
}

/** u and θ′ at distance n (m) normal to the slope. */
export function prandtlProfile(n, { lambda, mu }, dTheta) {
    const x = n / lambda, e = Math.exp(-x);
    return { u: dTheta * mu * e * Math.sin(x), theta: dTheta * e * Math.cos(x) };
}

/** Kasten & Young (1989) relative air mass; Infinity with the Sun down. */
export function airMass(altDeg) {
    if (!(altDeg > 0)) return Infinity;
    return 1 / (Math.sin(altDeg * D2R) + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
}

/** Meinel & Meinel (1976) clear-sky DIRECT beam at normal incidence, W/m². */
export function beamIrradiance(altDeg) {
    const m = airMass(altDeg);
    return Number.isFinite(m) ? SOLAR_CONSTANT * Math.pow(0.7, Math.pow(m, 0.678)) : 0;
}

/** Kasten & Czeplak (1980): fraction of clear-sky sunlight left under cloud fraction c. */
export function cloudTransmission(c) {
    const f = Math.min(1, Math.max(0, c));
    return 1 - 0.75 * Math.pow(f, 3.4);
}

/**
 * The slope's energy budget (W/m²): `incidence` is the slope's direct-beam
 * cosine (T1 `incidence`, 0 with the Sun down or behind the slope).
 */
export function surfaceBudget({ incidence, sunAltDeg, cloudFrac = 0 }) {
    const c = Number.isFinite(cloudFrac) ? Math.min(1, Math.max(0, cloudFrac)) : 0;
    const sw = (1 - ALBEDO) * beamIrradiance(sunAltDeg) * Math.max(0, incidence) * cloudTransmission(c);
    const lw = -LW_CLEAR * (1 - LW_CLOUD * c);
    return { sw, lw, q: sw + lw };
}

function slopeIncidence(slopeDeg, aspectDeg, altDeg, azDeg) {
    if (!(altDeg > 0)) return 0;
    const s = slopeDeg * D2R, a = altDeg * D2R;
    const asp = Number.isFinite(aspectDeg) ? aspectDeg : 0;
    return Math.max(0, Math.cos(s) * Math.sin(a) + Math.sin(s) * Math.cos(a) * Math.cos((azDeg - asp) * D2R));
}

/**
 * The slope wind at one point. `sun` = { altitudeDeg, azimuthDeg }. Returns
 * { regime, u (m/s, + upslope, the jet's peak), toward (bearing the wind
 * blows TOWARD, °), dTheta, q, zJet, periodS } — u/toward null on flat ground
 * and on slopes too gentle to spin up.
 */
export function slopeWind({ slopeDeg, aspectDeg, sun, cloudFrac = 0, theta0K = THETA0_DEFAULT_K }) {
    if (!Number.isFinite(slopeDeg)) return null;
    const inc = slopeIncidence(slopeDeg, aspectDeg, sun.altitudeDeg, sun.azimuthDeg);
    const { q, sw, lw } = surfaceBudget({ incidence: inc, sunAltDeg: sun.altitudeDeg, cloudFrac });
    const day = q > 0;
    const dTheta = q / (day ? H_DAY : H_NIGHT);
    const inputs = { theta0K, cloudFrac: Number.isFinite(cloudFrac) ? Math.min(1, Math.max(0, cloudFrac)) : 0 };
    if (slopeDeg < FLAT_DEG || !Number.isFinite(aspectDeg)) {
        return { regime: 'flat', u: null, toward: null, dTheta, q, sw, lw, zJet: null, periodS: Infinity, ...inputs };
    }
    const sc = prandtlScales({ dTheta, slopeDeg, N: day ? N_DAY : N_NIGHT, K: day ? K_DAY : K_NIGHT, theta0K });
    if (sc.periodS > PERIOD_MAX_S) {
        return { regime: 'gentle', u: null, toward: null, dTheta, q, sw, lw, zJet: null, periodS: sc.periodS, ...inputs };
    }
    const u = sc.uMax;
    return {
        regime: u > 0 ? 'anabatic' : u < 0 ? 'katabatic' : 'neutral',
        u, toward: ((u >= 0 ? aspectDeg + 180 : aspectDeg) % 360 + 360) % 360,
        dTheta, q, sw, lw, zJet: sc.zJet, periodS: sc.periodS, ...inputs,
    };
}

/**
 * The slope wind on every node of a T1 grid. `sunAt(lat, lon)`,
 * `cloudAt(lat, lon)` (0–1 or null ⇒ clear sky, disclosed by the caller) and
 * `theta0At(lat, lon)` (K or null ⇒ THETA0_DEFAULT_K). Returns Float32Arrays
 * { u, toward, zJet } (NaN where no flow is drawn) and the regime counts.
 */
export function slopeWindGrid(g, sa, { sunAt, cloudAt = () => null, theta0At = () => null }) {
    const n = g.nRows * g.nCols;
    const u = new Float32Array(n).fill(NaN), toward = new Float32Array(n).fill(NaN), zJet = new Float32Array(n).fill(NaN);
    const counts = { anabatic: 0, katabatic: 0, neutral: 0, flat: 0, gentle: 0 };
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        for (let j = 0; j < g.nCols; j++) {
            const k = i * g.nCols + j;
            if (!Number.isFinite(sa.slope[k])) continue;
            const lon = g.lonW + j * g.dlon;
            const c = cloudAt(lat, lon), t = theta0At(lat, lon);
            const r = slopeWind({ slopeDeg: sa.slope[k], aspectDeg: sa.aspect[k], sun: sunAt(lat, lon),
                cloudFrac: c ?? 0, theta0K: t ?? THETA0_DEFAULT_K });
            counts[r.regime]++;
            if (r.u == null) continue;
            u[k] = r.u; toward[k] = r.toward; zJet[k] = r.zJet;
        }
    }
    return { u, toward, zJet, counts };
}

/** Strongest upslope and downslope flow (optionally inside a lat/lon box). */
export function slopeWindExtremes(g, u, box = null) {
    let up = null, down = null;
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        if (box && (lat > box.north || lat < box.south)) continue;
        for (let j = 0; j < g.nCols; j++) {
            const lon = g.lonW + j * g.dlon;
            if (box && (lon < box.west || lon > box.east)) continue;
            const v = u[i * g.nCols + j];
            if (!Number.isFinite(v)) continue;
            if (v > 0 && (!up || v > up.u)) up = { u: v, lat, lon };
            if (v < 0 && (!down || v < down.u)) down = { u: v, lat, lon };
        }
    }
    return { up, down };
}

export const ANABATIC_RGB = Object.freeze([1.0, 0.72, 0.30]);    // upslope (warm)
export const KATABATIC_RGB = Object.freeze([0.48, 0.84, 1.0]);   // downslope (cold)
/** Arrows are not drawn below this speed (m/s). */
export const ARROW_MIN_MS = 0.2;
