/**
 * geospace.js — the Sun, the Moon, and the boundaries the solar wind draws
 * around the field TIGA is estimating.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no ambient time: every clock-dependent entry point
 * takes an explicit Date, and every wind-dependent one takes the wind as an
 * argument. The page feeds it the live L1 measurement; the tests feed it
 * nominal values and published dates.
 *
 * ── WHAT IS MEASURED, WHAT IS EPHEMERIS, WHAT IS EMPIRICAL MODEL ─────────
 *
 *   EPHEMERIS (exact to the precision quoted, no model choices):
 *     • Sun direction + distance — the Astronomical Almanac low-precision
 *       series dipole.js already uses for the dipole tilt (~0.01°). One Sun
 *       on this page: the tilt and the terminator cannot disagree.
 *     • Moon — `moonGeocentric` (Meeus ch.47, js/horizons.js), the site's ONE
 *       lunar position. Never a second copy.
 *     • Earth's orbital velocity — the time derivative of the Sun's geocentric
 *       vector, differenced, so it carries the real eccentricity.
 *
 *   MEASURED (the page supplies it; this file never fetches):
 *     • Solar wind speed, density and IMF Bz at L1 (DSCOVR/ACE real-time).
 *
 *   EMPIRICAL MODEL (published fits, and the page says so):
 *     • Magnetopause — Shue et al. (1998). r₀ and α come from
 *       ring-current-model.js `shueStandoffRe`/`shueAlpha`, the site's ONE
 *       copy; this file only evaluates the surface WITHOUT the θ ≤ 2 rad clamp
 *       that copy applies, because the tail at lunar distance is the question.
 *     • Bow shock — Farris et al. (1991, "F91"): an ELLIPSE with e = 0.81 and
 *       semi-latus rectum L₀ = 24.8 R_E at 1.8 nPa, focus at Earth, scaled as
 *       Pdyn^(−1/6). Nose = L/(1+e) = 13.7 R_E at reference pressure.
 *
 * ── THE TWO EXTRAPOLATIONS, NAMED ────────────────────────────────────────
 * Both fits were made to boundary crossings within a few tens of R_E of
 * Earth. The Moon sits at ~60 R_E. Evaluating them there is EXTRAPOLATION,
 * and every result that does so carries `extrapolated: true`. It is a
 * well-behaved one — Shue's α ≈ 0.58 flares the tail to ~25 R_E radius at
 * lunar distance, which is what ARTEMIS and Apollo-era magnetometers saw —
 * but it is not a fit to data out there, and the page must not say it is.
 *
 * ── ABERRATION IS NOT DECORATION ─────────────────────────────────────────
 * Earth moves at ~30 km/s through a ~400 km/s wind, so in Earth's frame the
 * wind arrives ~4° off the Sun line, from AHEAD of Earth's orbital motion —
 * rain on a running man. The magnetosphere's axis follows the flow, not the
 * Sun, so the tail trails BEHIND the orbital motion (toward +Y_GSE, dusk).
 * The Moon orbits prograde, so at full moon it is moving toward −Y_GSE: it
 * crosses the aberrated tail axis BEFORE full moon, by ~4.3° / 12.2° per day
 * ≈ 0.35 d. `tests/geomag-geospace.mjs` pins that sign, with aberration off
 * as the negative control (the offset collapses to ~0).
 *
 * Not modelled, and named so nobody thinks they are: tail flapping and
 * IMF-By twisting of the tail axis, dipole-tilt hinging of the plasma sheet,
 * the lunar wake, and the ~1 km/s of the Moon's own orbital speed in the
 * aberration. Each moves the boundary by a few R_E at lunar distance — the
 * same order as the extrapolation itself.
 */

import { sunGei, gmstRad, julianDate, dipoleTilt, decimalYear, dipoleBasisForYear } from './dipole.js';
import { moonGeocentric } from '../horizons.js';
import { shueStandoffRe, shueAlpha } from '../ring-current-model.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const J2000 = 2451545.0;

export const AU_KM = 149597870.7;
export const EARTH_RADIUS_KM = 6371.2;      // IGRF reference radius — the scene's unit
export const MOON_RADIUS_KM = 1737.4;
export const L1_DISTANCE_KM = 1.5e6;

/**
 * The wind used when the L1 feed is down. Typical slow-wind values. The page
 * must label any number computed from this as NOMINAL, never as live.
 */
export const NOMINAL_WIND = Object.freeze({ speedKms: 400, densityCc: 5, bzNt: 0 });

/** Farris et al. (1991) bow-shock ellipse. */
export const F91 = Object.freeze({ e: 0.81, L0Re: 24.8, p0NPa: 1.8 });

/**
 * Downstream distance past which BOTH boundary fits are extrapolated. The
 * fits were made to near-Earth crossings; this is a deliberately round,
 * deliberately generous edge, and it only controls a disclosure flag.
 */
export const FIT_LIMIT_RE = 40;

/** How far downstream the scene draws the boundaries: just past lunar apogee (63.8 R_E). */
export const SCENE_TAIL_RE = 70;

// ── Small vector helpers ─────────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

/**
 * Solar-wind dynamic pressure, nPa: Pdyn = m_p · n · v².
 * With n in cm⁻³ and v in km/s the constant is 1.6726×10⁻⁶. Protons only —
 * the ~4 % alpha-particle number fraction would add ~15 % (×4 mass), and
 * Shue's own fit used the same proton-only convention as most L1 products.
 */
export function dynamicPressureNPa(densityCc, speedKms) {
    if (!(densityCc > 0) || !(speedKms > 0)) return null;
    return 1.6726e-6 * densityCc * speedKms * speedKms;
}

/** Minutes for the wind measured at L1 to reach Earth, at its own speed. */
export function l1LagMinutes(speedKms) {
    if (!(speedKms > 0)) return null;
    return L1_DISTANCE_KM / speedKms / 60;
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** Days since J2000 (TT ≈ UT here; the ~69 s difference is 0.0008° of Sun). */
const daysJ2000 = (date) => julianDate(date) - J2000;

/** Mean obliquity, the same expression `sunGei` uses. */
const obliquity = (n) => (23.439 - 4e-7 * n) * DEG;

/** Sun: unit vector in GEI and distance in AU (Almanac series, ~0.01°). */
export function sunGeiWithDistance(date) {
    const n = daysJ2000(date);
    const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG;
    const distAU = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return { u: sunGei(n), distAU };
}

/** Ecliptic longitude of the Sun, degrees [0, 360). */
export function sunEclipticLonDeg(date) {
    const n = daysJ2000(date);
    const L = 280.460 + 0.9856474 * n;
    const g = (357.528 + 0.9856003 * n) * DEG;
    const lam = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    return ((lam % 360) + 360) % 360;
}

/**
 * Earth's heliocentric velocity in GEI, km/s. It is −d(r☉)/dt, where r☉ is
 * the Sun's geocentric vector — differenced over ±1 h, so the ~3 % annual
 * swing in orbital speed (perihelion in January) is carried, not assumed.
 */
export function earthOrbitalVelocityGei(date) {
    const h = 3600e3;
    const at = (t) => {
        const s = sunGeiWithDistance(new Date(t));
        return scale(s.u, s.distAU * AU_KM);
    };
    const a = at(date.getTime() - h);
    const b = at(date.getTime() + h);
    return scale(sub(b, a), -1 / 7200);
}

/** Moon: unit vector in GEI and geocentric distance in km (Meeus ch.47). */
export function moonGei(date) {
    const m = moonGeocentric(julianDate(date));
    const eps = obliquity(daysJ2000(date));
    const cb = Math.cos(m.lat_rad), sb = Math.sin(m.lat_rad);
    const cl = Math.cos(m.lon_rad), sl = Math.sin(m.lon_rad);
    const u = [
        cb * cl,
        cb * sl * Math.cos(eps) - sb * Math.sin(eps),
        cb * sl * Math.sin(eps) + sb * Math.cos(eps),
    ];
    return { u, distKm: m.dist_km, eclLonDeg: m.lon, eclLatDeg: m.lat };
}

/**
 * GEI → Earth-fixed geographic (x toward lon 0, z toward the north pole).
 * A rotation by −GMST, the same one `subsolarPointGeo` applies.
 */
export function geiToGeo(v, date) {
    const th = gmstRad(daysJ2000(date));
    const c = Math.cos(th), s = Math.sin(th);
    return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}

/**
 * Earth-fixed geographic → the TIGA 3D scene's Y-up frame. ONE copy of the
 * convention `core-3d.js` uses for the field lines and observatories:
 * three.js Y is the spin axis, three.js Z is −y_geo. Getting it wrong
 * mirrors longitude, which still looks like a planet.
 */
export function geoToScene(v) {
    return [v[0], v[2], -v[1]];
}

/** Latitude/longitude of a unit Earth-fixed vector, degrees. */
export function geoLatLon(v) {
    const u = unit(v);
    return {
        latDeg: Math.asin(Math.max(-1, Math.min(1, u[2]))) * RAD,
        lonDeg: Math.atan2(u[1], u[0]) * RAD,
    };
}

// ── The magnetosphere's axis ─────────────────────────────────────────────────

/**
 * Unit vector (GEI) the solar wind ARRIVES FROM, in Earth's frame.
 *
 * The wind's velocity is −V·ŝ (away from the Sun). In Earth's frame it is
 * −V·ŝ − v_E, so it arrives from V·ŝ + v_E. Pass `{ aberration: false }` to
 * get the bare Sun line — the tests' negative control.
 */
export function flowSourceGei(date, speedKms, { aberration = true } = {}) {
    const s = sunGeiWithDistance(date).u;
    if (!aberration || !(speedKms > 0)) return s;
    const vE = earthOrbitalVelocityGei(date);
    return unit([s[0] * speedKms + vE[0], s[1] * speedKms + vE[1], s[2] * speedKms + vE[2]]);
}

/** Angle between the Sun line and the flow axis, degrees. */
export function aberrationDeg(date, speedKms) {
    const s = sunGeiWithDistance(date).u;
    const f = flowSourceGei(date, speedKms);
    return Math.acos(Math.max(-1, Math.min(1, dot(s, f)))) * RAD;
}

// ── The boundaries ───────────────────────────────────────────────────────────

/** Shue (1998) radius at angle θ from the nose, NO clamp — the full surface. */
export function magnetopauseRadiusRe(thetaRad, r0, alpha) {
    const c = Math.cos(thetaRad);
    if (1 + c <= 1e-12) return Infinity;
    return r0 * Math.pow(2 / (1 + c), alpha);
}

/** F91 bow-shock radius at angle θ from the nose (ellipse, focus at Earth). */
export function bowShockRadiusRe(thetaRad, Lre, e = F91.e) {
    return Lre / (1 + e * Math.cos(thetaRad));
}

/** F91 semi-latus rectum at a dynamic pressure: L₀·(P/P₀)^(−1/6). */
export function bowShockL(pdynNPa) {
    const p = pdynNPa > 0 ? pdynNPa : F91.p0NPa;
    return F91.L0Re * Math.pow(p / F91.p0NPa, -1 / 6);
}

/**
 * Cylindrical radius of the magnetopause at a downstream distance X (R_E,
 * negative = nightside), found by bisection on θ along Shue's surface.
 * `r cos θ` is monotone in θ on (θ_nose, π) for α < 1, so bisection is safe.
 */
export function tailRadiusRe(xRe, r0, alpha) {
    if (!(alpha < 1)) return null;          // α ≥ 1 never reaches the far tail
    const xAt = (th) => magnetopauseRadiusRe(th, r0, alpha) * Math.cos(th);
    let lo = Math.PI / 2, hi = Math.PI - 1e-9;
    if (xRe >= xAt(lo)) return null;        // sunward of the terminator plane
    for (let i = 0; i < 100; i++) {
        const mid = 0.5 * (lo + hi);
        if (xAt(mid) > xRe) lo = mid; else hi = mid;
    }
    const th = 0.5 * (lo + hi);
    return magnetopauseRadiusRe(th, r0, alpha) * Math.sin(th);
}

/** Cylindrical radius of the F91 bow shock at X, or null past its closure. */
export function bowShockRhoRe(xRe, Lre, e = F91.e) {
    // r(1 + e cosθ) = L with r cosθ = X ⇒ r = L − eX.
    const r = Lre - e * xRe;
    if (!(r > Math.abs(xRe))) return null;
    return Math.sqrt(r * r - xRe * xRe);
}

/**
 * Everything the boundaries depend on, from one wind. `wind` is
 * `{ speedKms, densityCc, bzNt }`; missing pieces fall back to NOMINAL_WIND
 * and the result says which ones did.
 */
export function boundaryModel(wind = NOMINAL_WIND) {
    const fellBack = [];
    const pick = (k) => {
        const v = wind?.[k];
        if (Number.isFinite(v) && (k === 'bzNt' || v > 0)) return v;
        fellBack.push(k);
        return NOMINAL_WIND[k];
    };
    const speedKms = pick('speedKms');
    const densityCc = pick('densityCc');
    const bzNt = pick('bzNt');
    const pdyn = dynamicPressureNPa(densityCc, speedKms);
    const r0 = shueStandoffRe(pdyn, bzNt);
    const alpha = shueAlpha(pdyn, bzNt);
    const L = bowShockL(pdyn);
    return {
        speedKms, densityCc, bzNt, pdynNPa: pdyn,
        r0Re: r0, alpha, bowL: L, bowNoseRe: L / (1 + F91.e),
        fitsCrossAtXRe: fitsCrossAtXRe(r0, alpha, L),
        fellBack,
    };
}

/**
 * Where the two independent fits stop being mutually consistent.
 *
 * Shue and F91 were fitted separately, and Shue's tail flares harder as Bz
 * goes south (α grows) while F91's ellipse has a fixed shape. Under an
 * extreme wind the magnetopause therefore pokes OUT through the bow shock
 * downstream — a magnetosheath of negative thickness, which is not physics,
 * it is two fits disagreeing outside where either was fitted. Measured: none
 * sunward of 70 R_E for quiet, nominal or active wind; ~X = −45 R_E at
 * 900 km/s, 30 cm⁻³, Bz −30 nT. Returns that X (R_E, negative) or null, so
 * the page can say it and the renderer can stop the bow shock there instead
 * of drawing it inside the magnetopause.
 */
export function fitsCrossAtXRe(r0, alpha, L, e = F91.e, xLimitRe = SCENE_TAIL_RE) {
    for (let th = 0; th < Math.PI - 0.005; th += 0.005) {
        const rMp = magnetopauseRadiusRe(th, r0, alpha);
        const x = rMp * Math.cos(th);
        // F91 is an ELLIPSE and closes ~130 R_E downstream, so any flaring
        // tail exits it eventually. The question is only whether that happens
        // where this page looks — out to just past lunar apogee.
        if (x < -xLimitRe) return null;
        if (bowShockRadiusRe(th, L, e) <= rMp) return x;
    }
    return null;
}

/**
 * Which plasma regime a geocentric point sits in. `pGei` in R_E, `axis` the
 * unit flow-source vector, `b` from boundaryModel().
 */
export function classifyPoint(pGei, axis, b) {
    const r = norm(pGei);
    const x = dot(pGei, axis);
    const cosT = Math.max(-1, Math.min(1, x / (r || 1)));
    const th = Math.acos(cosT);
    const rho = Math.sqrt(Math.max(0, r * r - x * x));
    const rMp = magnetopauseRadiusRe(th, b.r0Re, b.alpha);
    const rBs = bowShockRadiusRe(th, b.bowL);
    const region = r < rMp ? (x < 0 ? 'magnetotail' : 'magnetosphere')
        : r < rBs ? 'magnetosheath' : 'solar-wind';
    return {
        region, xRe: x, rhoRe: rho, rRe: r,
        tailRadiusRe: x < 0 ? tailRadiusRe(x, b.r0Re, b.alpha) : null,
        bowRhoRe: bowShockRhoRe(x, b.bowL),
        extrapolated: x < -FIT_LIMIT_RE,
    };
}

// ── The Moon in that geometry ────────────────────────────────────────────────

/**
 * Lunar phase from geometry. Elongation is the geocentric Sun–Moon angle;
 * the illuminated fraction uses the phase angle i ≈ 180° − elongation (the
 * Moon's parallax on the Sun is 0.15°, below anything printed).
 */
export function moonPhase(date) {
    const s = sunGeiWithDistance(date).u;
    const m = moonGei(date);
    const elong = Math.acos(Math.max(-1, Math.min(1, dot(s, m.u)))) * RAD;
    const iRad = (180 - elong) * DEG;
    const k = (1 + Math.cos(iRad)) / 2;
    const dLon = ((m.eclLonDeg - sunEclipticLonDeg(date)) % 360 + 360) % 360;
    const waxing = dLon < 180;
    let name;
    if (dLon < 6 || dLon > 354) name = 'New moon';
    else if (Math.abs(dLon - 180) < 6) name = 'Full moon';
    else if (Math.abs(dLon - 90) < 6) name = 'First quarter';
    else if (Math.abs(dLon - 270) < 6) name = 'Last quarter';
    else name = `${waxing ? 'Waxing' : 'Waning'} ${k < 0.5 ? 'crescent' : 'gibbous'}`;
    return { elongationDeg: elong, illuminatedFraction: k, waxing, phaseLonDeg: dLon, name };
}

/** Where the Moon is in the magnetosphere's frame, and which regime. */
export function moonRegion(date, wind = NOMINAL_WIND, opts = {}) {
    const b = boundaryModel(wind);
    const axis = flowSourceGei(date, b.speedKms, opts);
    const m = moonGei(date);
    const p = scale(m.u, m.distKm / EARTH_RADIUS_KM);
    return { ...classifyPoint(p, axis, b), distRe: m.distKm / EARTH_RADIUS_KM, boundary: b };
}

/**
 * Windows in which the Moon is inside the magnetotail, scanned from `start`
 * for `days` at `stepMin`. The wind is HELD at the value passed — a
 * forecast of the wind is not something this page has, and the result says
 * "under today's wind". Each boundary is refined to ~1 minute by bisection.
 *
 * @returns {{entryMs:number|null, exitMs:number|null, midMs:number|null}[]}
 *          null entry/exit = the window was already open at the scan edge.
 */
export function tailTransits(start, days = 30, wind = NOMINAL_WIND, { stepMin = 30, ...opts } = {}) {
    const t0 = start.getTime();
    const t1 = t0 + days * 86400e3;
    const step = stepMin * 60e3;
    const inside = (t) => moonRegion(new Date(t), wind, opts).region === 'magnetotail';
    const refine = (a, b, va) => {
        for (let i = 0; i < 20 && b - a > 60e3; i++) {
            const mid = 0.5 * (a + b);
            if (inside(mid) === va) a = mid; else b = mid;
        }
        return 0.5 * (a + b);
    };
    const out = [];
    let prev = inside(t0);
    let open = prev ? { entryMs: null } : null;
    for (let t = t0 + step; t <= t1; t += step) {
        const cur = inside(t);
        if (cur !== prev) {
            const edge = refine(t - step, t, prev);
            if (cur) open = { entryMs: edge };
            else if (open) { out.push({ ...open, exitMs: edge }); open = null; }
        }
        prev = cur;
    }
    if (open) out.push({ ...open, exitMs: null });
    return out.map((w) => ({
        ...w,
        midMs: w.entryMs != null && w.exitMs != null ? 0.5 * (w.entryMs + w.exitMs) : null,
    }));
}

/**
 * Times of full moon in [start, start+days]: where the Moon's ecliptic
 * longitude minus the Sun's crosses 180° (the almanac definition — NOT the
 * elongation maximum, which the Moon's ±5° latitude shifts by hours).
 * Refined by bisection to ~1 minute. Used by the aberration gate.
 */
export function fullMoons(start, days = 30) {
    const t0 = start.getTime();
    const f = (t) => moonPhase(new Date(t)).phaseLonDeg - 180;
    const out = [];
    const step = 6 * 3600e3;
    for (let t = t0; t + step <= t0 + days * 86400e3; t += step) {
        let a = t, b = t + step;
        const fa = f(a), fb = f(b);
        // A real crossing climbs through zero; the 360→0 wrap at NEW moon
        // jumps from +180 to −180 and must not be mistaken for one.
        if (!(fa < 0 && fb >= 0 && fb - fa < 90)) continue;
        while (b - a > 60e3) {
            const m = 0.5 * (a + b);
            if (f(m) < 0) a = m; else b = m;
        }
        out.push(0.5 * (a + b));
    }
    return out;
}

// ── One snapshot for the page and the scene ─────────────────────────────────

/**
 * The whole Sun–Earth–Moon state at an instant, in the frames each consumer
 * needs: geographic for the readout, scene axes for core-3d.js. The scene is
 * EARTH-FIXED, so the Sun and the Moon move through it once a day; the
 * Moon's orbit ring is the INERTIAL orbit rotated by the CURRENT sidereal
 * angle, i.e. a snapshot of the ellipse as the scene sees it right now — not
 * the Earth-fixed spiral the Moon actually traces through this frame.
 */
export function geospaceState(date, wind = NOMINAL_WIND, { orbitSamples = 180 } = {}) {
    const b = boundaryModel(wind);
    const sun = sunGeiWithDistance(date);
    const axisGei = flowSourceGei(date, b.speedKms);
    const sunGeo = geiToGeo(sun.u, date);
    const axisGeo = geiToGeo(axisGei, date);
    const moon = moonGei(date);
    const moonGeo = geiToGeo(moon.u, date);
    const moonRe = moon.distKm / EARTH_RADIUS_KM;
    const region = classifyPoint(scale(moon.u, moonRe), axisGei, b);
    const dip = dipoleBasisForYear(decimalYear(date)).z;

    // Orbit snapshot: one sidereal month of inertial positions, all turned by
    // TODAY's GMST into the Earth-fixed scene.
    const orbit = new Float32Array(orbitSamples * 3);
    const SIDEREAL_MONTH_D = 27.321661;
    for (let i = 0; i < orbitSamples; i++) {
        const t = new Date(date.getTime() + (i / orbitSamples) * SIDEREAL_MONTH_D * 86400e3);
        const mm = moonGei(t);
        const g = geoToScene(geiToGeo(scale(mm.u, mm.distKm / EARTH_RADIUS_KM), date));
        orbit[i * 3] = g[0]; orbit[i * 3 + 1] = g[1]; orbit[i * 3 + 2] = g[2];
    }

    return {
        date: new Date(date.getTime()),
        boundary: b,
        aberrationDeg: Math.acos(Math.max(-1, Math.min(1, dot(sun.u, axisGei)))) * RAD,
        l1LagMin: l1LagMinutes(b.speedKms),
        dipoleTiltDeg: dipoleTilt(date),
        sun: {
            distAU: sun.distAU,
            subsolar: geoLatLon(sunGeo),
            scene: geoToScene(sunGeo),
        },
        flowAxisScene: geoToScene(axisGeo),
        dipoleAxisScene: geoToScene(dip),
        moon: {
            distKm: moon.distKm,
            distRe: moonRe,
            sublunar: geoLatLon(moonGeo),
            scene: geoToScene(scale(moonGeo, moonRe)),
            sunFromMoonKm: geoToScene(sub(scale(sunGeo, sun.distAU * AU_KM), scale(moonGeo, moon.distKm))),
            earthFromMoonKm: geoToScene(scale(moonGeo, -moon.distKm)),
            phase: moonPhase(date),
            ...region,
            orbitScene: orbit,
        },
    };
}
