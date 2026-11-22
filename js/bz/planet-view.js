/**
 * js/bz/planet-view.js — the scene model of bz.html's hero canvas (PURE).
 *
 * BZ_ENGINE_PLAN.md B7 (the page's "Bz at the planet" stage). A cut through
 * the noon–midnight meridian (GSM x–z, Sun on the LEFT) showing where the
 * north–south field IS right now: each minute of wind L1 has measured and
 * that has not arrived yet, at its true position between L1 and the bow
 * shock; the boundaries it will meet; the instruments inside them.
 *
 * It computes NO physics. Boundaries are js/geomag/geospace.js on the wind the
 * column says is at the shock; the tilt is js/geomag/dipole.js; parcel
 * positions are the engine's own arrival times read back as distance. The
 * renderer (js/bz-planet-canvas.js) draws ONLY what `sceneModel` returns.
 *
 * WHAT IS NOT TO SCALE — one function owns it (`layout`) and `disclosures`
 * says it on the page:
 *   • Inside NEAR_RE of Earth the picture is TRUE scale and true aspect.
 *   • From there to L1 the Sun–Earth axis is compressed (the factor is
 *     DERIVED and printed; L1 is ~225 R_E out and the magnetosphere is ~15).
 *   • Left of L1 the axis is TIME (hours until arrival), not distance, and
 *     holds only a CME forecast. Nothing measured is ever drawn there.
 *   • The dipole field lines are an undistorted dipole, drawn for
 *     ORIENTATION (tilt) only and clipped at the magnetopause. They are not
 *     the real, compressed field — the GOES numbers are.
 *   • GOES sit at their own local time, out of this plane; they are drawn at
 *     their distance along the Sun–Earth line.
 *   • A parcel moves in a straight line at its own measured delay. The
 *     engine's delay stops at the shock nose; nothing is drawn moving through
 *     the sheath.
 */
import { boundaryModel, magnetopauseRadiusRe, bowShockRadiusRe, F91 } from '../geomag/geospace.js';
import { dipoleTilt } from '../geomag/dipole.js';

export const VIEW = Object.freeze({
    NEAR_RE: 30,        // true scale inside this distance sunward
    TAIL_RE: -24,       // the cut's anti-sunward edge
    FRAC_FORECAST: 0.2, // share of the width given to the CME forecast, when there is one
    FRAC_MARGIN: 0.035, // left margin when there is not
    FRAC_TRANSIT: 0.4,  // share of the width between L1 and NEAR_RE
    L_SHELLS: [2, 4, 6.62],
    GEO_RE: 6.62,
    PARCEL_EVERY_MIN: 1,
    ARROW_MIN_NT: 5,    // the arrow scale never zooms in past this (quiet days stay visibly quiet)
});

const D2R = Math.PI / 180;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The ONE map from physical position to the canvas's horizontal unit u ∈ [0, 1] (Sun at 0).
 * @returns {{ uOfRe, uOfHoursAhead, rePerUnitNear, compression, f0, f1, l1XRe, forecastHours, hasForecast }}
 */
export function layout({ l1XRe, hasForecast = false, forecastHours = 24 }) {
    const f0 = hasForecast ? VIEW.FRAC_FORECAST : VIEW.FRAC_MARGIN;
    const f1 = f0 + VIEW.FRAC_TRANSIT;
    const nearSpan = VIEW.NEAR_RE - VIEW.TAIL_RE;
    const rePerUnitNear = nearSpan / (1 - f1);
    const rePerUnitTransit = (l1XRe - VIEW.NEAR_RE) / (f1 - f0);
    const uOfRe = (x) => (x <= VIEW.NEAR_RE
        ? f1 + (VIEW.NEAR_RE - x) / rePerUnitNear
        : f1 - (x - VIEW.NEAR_RE) / rePerUnitTransit);
    // Forecast segment: hours past the L1 horizon, linear, the horizon at L1's own u.
    const uOfHoursAhead = (h) => f0 * (1 - Math.min(1, Math.max(0, h / forecastHours)));
    return { uOfRe, uOfHoursAhead, rePerUnitNear, compression: rePerUnitTransit / rePerUnitNear, f0, f1, l1XRe, forecastHours, hasForecast };
}

/** Upper halves (z ≥ 0) of the two boundaries as [x, z] polylines, sunward nose first, down to x = tailRe. */
export function boundaryCurves(b, { tailRe = VIEW.TAIL_RE, zMaxRe = 60, steps = 180 } = {}) {
    const mp = [], bs = [];
    const xStop = b.fitsCrossAtXRe != null ? Math.max(tailRe, b.fitsCrossAtXRe) : tailRe;
    for (let i = 0; i <= steps; i++) {
        const th = (i / steps) * (Math.PI - 0.02);
        const rm = magnetopauseRadiusRe(th, b.r0Re, b.alpha), xm = rm * Math.cos(th), zm = rm * Math.sin(th);
        if (xm >= tailRe && zm <= zMaxRe && fin(rm)) mp.push([xm, zm]);
        const rb = bowShockRadiusRe(th, b.bowL, F91.e), xb = rb * Math.cos(th), zb = rb * Math.sin(th);
        // Under an extreme wind the two independent fits cross; the shock is cut there, never drawn inside the magnetopause.
        if (xb >= xStop && zb <= zMaxRe && fin(rb)) bs.push([xb, zb]);
    }
    return { magnetopause: mp, bowShock: bs };
}

/**
 * Dipole field lines in the meridian plane for a tilt ψ (degrees; + = north magnetic pole toward the Sun).
 * Each line is a list of [x, z] segments (clipped at the magnetopause and the planet).
 */
export function dipoleLines(tiltDeg, b, shells = VIEW.L_SHELLS) {
    const s = Math.sin(tiltDeg * D2R), c = Math.cos(tiltDeg * D2R);
    const axis = [s, c], eq = [c, -s]; // north axis; magnetic-equator direction on the day side
    const inside = (x, z) => {
        const r = Math.hypot(x, z);
        if (r < 1) return false;
        return r <= magnetopauseRadiusRe(Math.atan2(Math.abs(z), x), b.r0Re, b.alpha);
    };
    const lines = [];
    for (const L of shells) for (const side of [1, -1]) {
        let seg = [];
        const segs = [];
        for (let i = 0; i <= 120; i++) {
            const lam = (-89 + (178 * i) / 120) * D2R, r = L * Math.cos(lam) ** 2;
            const x = side * r * Math.cos(lam) * eq[0] + r * Math.sin(lam) * axis[0];
            const z = side * r * Math.cos(lam) * eq[1] + r * Math.sin(lam) * axis[1];
            if (inside(x, z)) seg.push([x, z]); else if (seg.length) { if (seg.length > 1) segs.push(seg); seg = []; }
        }
        if (seg.length > 1) segs.push(seg);
        lines.push({ L, side: side > 0 ? 'day' : 'night', segments: segs });
    }
    return { axis, lines };
}

/**
 * Wind L1 has measured that has not arrived: where each minute is NOW.
 * A parcel arriving at `arrives` after a delay `d` left L1 at arrives − d, so the fraction of the
 * way still to go is (arrives − now) / d; arrived parcels are not returned.
 */
export function parcels({ trace, nowMs, l1XRe, noseRe, everyMin = VIEW.PARCEL_EVERY_MIN }) {
    const c = trace?.columns ?? [];
    const ti = c.indexOf('arrives'), bi = c.indexOf('bz_nt'), di = c.indexOf('delay_min');
    const out = [];
    if (ti < 0 || bi < 0 || di < 0 || !fin(l1XRe) || !fin(noseRe)) return out;
    let lastKept = -Infinity;
    for (const r of trace.rows ?? []) {
        const arrives = Date.parse(r[ti]), bz = r[bi], d = r[di];
        if (!fin(arrives) || !fin(bz) || !fin(d) || d <= 0 || arrives <= nowMs) continue;
        const frac = (arrives - nowMs) / (d * 60e3);
        if (frac > 1) continue; // a row claiming to be upstream of L1 has not been measured — never drawn
        const seenAt = arrives - d * 60e3;
        if (seenAt - lastKept < everyMin * 60e3 - 1) continue;
        lastKept = seenAt;
        out.push({ xRe: noseRe + frac * (l1XRe - noseRe), bz, arrives, seenAt, minutesAway: (arrives - nowMs) / 60e3 });
    }
    return out;
}

/** Where a geosynchronous satellite at local time `h` sits along the Sun–Earth line (noon = sunward). */
export function geoXRe(localTimeH) { return VIEW.GEO_RE * Math.cos((localTimeH - 12) * 15 * D2R); }

/**
 * Everything the canvas draws.
 * @param {{ column:object, fluxTrace:object, join?:object, nowMs:number }} input
 */
export function sceneModel({ column, fluxTrace, join = null, nowMs }) {
    const rung = (id) => (column?.rungs ?? []).find((r) => r.id === id) ?? null;
    const l1 = rung('l1'), shock = rung('bow_shock'), sheath = rung('sheath'), mpause = rung('magnetopause'),
        geo = rung('geosynchronous'), ring = rung('ring_current'), ground = rung('ground');
    const l1XRe = Number(/~?([\d.]+)\s*R_E/.exec(l1?.where ?? '')?.[1]) || null;
    const wind = shock?.values ? { speedKms: shock.values.speed_kms, densityCc: shock.values.density_cc, bzNt: shock.values.bz_nt } : null;
    const hasMeasured = !!(l1?.kind === 'MEASURED' && fin(l1XRe));
    const hasForecast = join?.status === 'joined' && join.prior.length > 0;
    const lay = layout({ l1XRe: l1XRe ?? 225, hasForecast, forecastHours: hasForecast ? (join.endMs - join.l1HorizonMs) / 3600e3 : 24 });
    // No wind at the shock ⇒ no boundary is drawn. A nominal magnetopause would look measured.
    const b = wind && fin(wind.speedKms) && fin(wind.densityCc) ? boundaryModel(wind) : null;
    const tiltDeg = dipoleTilt(new Date(nowMs));
    const pk = hasMeasured && b ? parcels({ trace: fluxTrace, nowMs, l1XRe, noseRe: b.bowNoseRe }) : [];
    let peak = VIEW.ARROW_MIN_NT;
    for (const p of pk) peak = Math.max(peak, Math.abs(p.bz));
    const fc = hasForecast ? join.prior.map((p) => ({ hoursAhead: (p.t - join.l1HorizonMs) / 3600e3, arrives: p.t, p50: p.p50, p5: p.p5, p95: p.p95 })) : [];
    // ONE arrow scale for the whole picture, and it must hold the forecast's 5–95 % band: a band clipped at the
    // frame would read as a solid block. A forecast storm therefore shrinks today's measured arrows — truthfully.
    for (const p of fc) peak = Math.max(peak, Math.abs(p.p50), Math.abs(p.p5 ?? 0), Math.abs(p.p95 ?? 0));
    const disclosures = [
        `True scale within ${VIEW.NEAR_RE} R_E of Earth; from there to L1 the Sun–Earth line is compressed ×${lay.compression.toFixed(1)}.`,
        'Each arrow is one L1 measurement, drawn where that wind is now. Field lines are an undistorted dipole, for tilt only. GOES are shown at their distance along the Sun–Earth line.',
    ];
    if (hasForecast) disclosures.push('Left of L1 the axis is hours until arrival, and the hollow arrows are a CME forecast — not a measurement.');
    return {
        nowMs, layout: lay, tiltDeg, arrowFullNt: peak,
        l1: hasMeasured ? { xRe: l1XRe, bz: l1.values?.bz_nt ?? null, sigma: l1.sigma?.bz_nt ?? null, label: (l1.where ?? '').split(',')[0], time: l1.time } : null,
        boundaries: b ? { r0Re: b.r0Re, bowNoseRe: b.bowNoseRe, crossAtXRe: b.fitsCrossAtXRe, ...boundaryCurves(b), nominal: b.fellBack } : null,
        dipole: b ? dipoleLines(tiltDeg, b) : dipoleLines(tiltDeg, { r0Re: 10, alpha: 0.58 }),
        parcels: pk,
        sheath: sheath?.values && b ? { xRe: 0.5 * (b.r0Re + b.bowNoseRe), bz: sheath.values.bz_nt ?? null, ratio: sheath.values.compression_ratio ?? null } : null,
        magnetopause: mpause?.values && b ? { xRe: b.r0Re, kv: mpause.values.reconnection_rate_kv ?? null, sigmaKv: mpause.sigma?.reconnection_rate_kv ?? null } : null,
        goes: (geo?.satellites ?? []).filter((s) => fin(s.local_time_h)).map((s) => ({ name: s.slot ?? s.name, localTimeH: s.local_time_h, xRe: geoXRe(s.local_time_h), hp: s.measured?.hp_residual_nt ?? null })),
        ring: ring?.values ? { dst: ring.values.dst_nt ?? null } : null,
        ground: ground?.values ? { dbdt: ground.values.dbdt_peak_nt_s ?? null, station: ground.values.at_station ?? null } : null,
        forecast: fc,
        forecastStatus: join?.status ?? 'pending', forecastText: join?.statusText ?? '',
        disclosures,
    };
}
