/**
 * flare-realism.js — how close is the drawn flare to an observed one? (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * js/flare-geometry.js builds a flare-shape MODEL from a parameter set. This
 * module MEASURES a model — in megametres, km/s and degrees — and scores each
 * measurement against a range taken from the observational literature. The
 * result is a scorecard: one row per measurement, a 0–1 score per row, and a
 * weighted total.
 *
 * WHAT IT IS FOR. The flare's look is meant to be improved over time, and
 * "better" needs a definition that does not live in someone's eye:
 *
 *   • tests/flare-realism.mjs holds a committed BASELINE
 *     (tests/fixtures/flare/realism-baseline.json). The shipped model may not
 *     score below it — the baseline only ratchets up.
 *   • `node scripts/flare-realism.mjs` prints the scorecard;
 *     `--try '{"shear":{"onsetDeg":70}}'` scores a candidate against the
 *     shipped model row by row; `--sweep shear.onsetDeg=40:80:9` walks one
 *     parameter; `--update` moves the baseline (it refuses to lower it).
 *   • A NEW IDEA STARTS AS A TARGET. Add a row to TARGETS with its range and
 *     source, watch the score fall, then change the model until it recovers.
 *     OPEN_TARGETS lists the morphology that is known to be missing and is not
 *     scored yet, so the backlog is in the code and not in a chat log.
 *
 * WHAT IT IS NOT. A score of 1.0 means every row sits inside its range — the
 * shape is PLAUSIBLE on these axes. It does not mean the model is a flare:
 * the ranges are broad, the rows are few, and OPEN_TARGETS is not empty.
 *
 * THE RANGES ARE DATA, AND THEY ARE NOT YET VERIFIED. Every row carries its
 * source and `verified: false`: the numbers were written from memory of the
 * cited papers in a sandbox with no access to them (the repo has been bitten
 * by recalled constants before — CLAUDE.md, the Inner Earth and Star Collider
 * rows). They are deliberately wide for that reason. Checking a row against
 * its paper and flipping `verified` is real work that improves the scorecard
 * as much as any parameter change; a row's range is as open to correction as
 * the model is.
 *
 * Time: the kernel's `t` is sim units; sun.html runs 0.35 sim units per
 * second (js/sun-flare-director.js SIM_UNITS_PER_S — the ONE copy), so every
 * rate here is converted through it. A model driven by another clock must
 * pass its own `simUnitsPerS`.
 */

import { FLARE_MODEL, DEG, vec } from './flare-geometry.js';
import { SIM_UNITS_PER_S } from './sun-flare-director.js';

/** Solar radius, Mm — IAU 2015 nominal (Resolution B3). */
export const RSUN_MM = 695.7;

/** When each measurement is taken, seconds after onset. */
export const EPOCH = Object.freeze({
    onset: 0,
    impulsiveEnd: 120,      // the first two minutes: the impulsive phase
    early: 300,
    mid: 600,
    lateFrom: 1500,         // 25–30 min: the gradual phase
    late: 1800,
});

/** The site every shape measurement is taken at (N15, central meridian; the Joy's-law PIL prior). */
export const MEASURE_SITE = Object.freeze({ latRad: 15 * DEG, lonRad: 0 });

/**
 * The interior angle at a loop's top, degrees — measured on the DRAWN
 * polyline, in the loop's own plane: from the apex to the two points where
 * the loop is at `frac` of its apex height. A round (sine-lifted or
 * semicircular) loop reads ~135–150°; a pointed one reads less.
 */
export function apexAngleDeg(pts, frac = 0.85) {
    const fa = pts[0], fb = pts[pts.length - 1];
    const e = vec.unit(vec.add(fb, vec.scale(fa, -1)));
    const mid = vec.unit(vec.add(fa, fb));
    const xz = pts.map((p) => [vec.dot(vec.add(p, vec.scale(mid, -1)), e), vec.norm(p) - 1]);
    let k = 0;
    for (let i = 1; i < xz.length; i++) if (xz[i][1] > xz[k][1]) k = i;
    const zt = frac * xz[k][1];
    const cross = (from, step) => {
        for (let i = from; i + step >= 0 && i + step < xz.length; i += step) {
            const [x0, z0] = xz[i], [x1, z1] = xz[i + step];
            if ((z0 - zt) * (z1 - zt) <= 0 && z0 !== z1) return x0 + (x1 - x0) * (z0 - zt) / (z0 - z1);
        }
        return NaN;
    };
    const xl = cross(k, -1), xr = cross(k, 1);
    const [xa, za] = xz[k];
    const u = [xl - xa, zt - za], v = [xr - xa, zt - za];
    const c = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/**
 * CUSP INDEX: how wide a loop is near its top, relative to a ROUND arc on the
 * same feet with the same apex height — its width at `frac` of the apex
 * height ÷ the sine-lifted arc's width there. 1 is round; below 1 the top is
 * narrower, i.e. pointed. Unlike the top angle this does not depend on how
 * tall the loop is: the v1 loops, 2.7× taller than their half-span, read as
 * "pointed" (85°) by angle while being perfectly round arcs — the first
 * version of this row scored them as cusps (measured; kept in the gate).
 */
export function cuspIndex(pts, frac = 0.85) {
    const fa = pts[0], fb = pts[pts.length - 1];
    const e = vec.unit(vec.add(fb, vec.scale(fa, -1)));
    const mid = vec.unit(vec.add(fa, fb));
    const xz = pts.map((p) => [vec.dot(vec.add(p, vec.scale(mid, -1)), e), vec.norm(p) - 1]);
    let k = 0;
    for (let i = 1; i < xz.length; i++) if (xz[i][1] > xz[k][1]) k = i;
    const zt = frac * xz[k][1];
    const cross = (step) => {
        for (let i = k; i + step >= 0 && i + step < xz.length; i += step) {
            const [x0, z0] = xz[i], [x1, z1] = xz[i + step];
            if ((z0 - zt) * (z1 - zt) <= 0 && z0 !== z1) return x0 + (x1 - x0) * (z0 - zt) / (z0 - z1);
        }
        return NaN;
    };
    const half = (cross(1) - cross(-1)) / 2;
    const d = (xz[xz.length - 1][0] - xz[0][0]) / 2;                  // half the footpoint chord
    const roundHalf = (1 - 2 * Math.asin(frac) / Math.PI) * d;        // sin(πu) = frac
    return half / roundHalf;
}

/** Total turning of a tangent-plane polyline [{a, c}…], degrees (0 for a straight ribbon). */
export function turningDeg(curve) {
    let total = 0, prev = null;
    for (let i = 1; i < curve.length; i++) {
        const h = Math.atan2(curve[i].c - curve[i - 1].c, curve[i].a - curve[i - 1].a);
        if (prev != null) { let d = h - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; }
        prev = h;
    }
    return Math.abs(total) / DEG;
}

/**
 * Measure a model. Returns plain numbers in physical units; nothing here is a
 * score. X-class and non-complex unless the name says otherwise.
 */
export function measure(model = FLARE_MODEL, { simUnitsPerS = SIM_UNITS_PER_S } = {}) {
    const sim = (s) => s * simUnitsPerS;
    const Mm = (rad) => rad * RSUN_MM;
    const A = model.params.arcade;
    const sepMm = (s, cls) => Mm(model.ribbonSeparation(sim(s), cls));
    const speed = (s0, s1, cls) => (sepMm(s1, cls) - sepMm(s0, cls)) * 1000 / (s1 - s0);     // km/s, ONE ribbon from the PIL
    const shearDeg = (s, complex = false) => Math.atan(model.arcadeShear(sim(s), complex)) / DEG;
    const apexMm = (s, cls) => Mm(model.arcadeHeight(sim(s), cls));
    const halfChordMm = (s, cls) => sepMm(s, cls) * Math.hypot(1, model.arcadeShear(sim(s)));
    const lenMm = (cls) => 2 * Mm(model.ribbonLength0(cls));

    const vImp = speed(EPOCH.onset, EPOCH.impulsiveEnd, 'X');
    const vLate = speed(EPOCH.lateFrom, EPOCH.late, 'X');
    // The zip covers the arcade's half-span outside its lit core in zipT sim units.
    const zipMm = Mm((1 - A.zipCore) * A.spanSigma * model.ribbonAlongSigma(0, 'X'));
    const zipS = A.zipT / simUnitsPerS;
    const ordered = (f) => f('C') < f('M') && f('M') < f('X');

    // ── Ribbon ends: measured on the ribbons' own centrelines ─────────────
    const rc = model.ribbonCurves({ ...MEASURE_SITE, t: sim(EPOCH.mid), cls: 'X', chirality: 1, samples: 192 });
    const hookTurn = turningDeg(rc.plus);
    // A hook is where a ribbon leaves the line c = ±sep. The DOUBLE-J: each ribbon has one, both curl
    // AWAY from the inversion line, and they are at opposite ends.
    const off = (curve, sign) => curve.filter((q) => sign * q.c > rc.sep * 1.02 + 1e-9);
    const hp = off(rc.plus, +1), hm = off(rc.minus, -1);
    const meanA = (qs) => qs.reduce((x, q) => x + q.a, 0) / qs.length;
    const doubleJ = (hp.length && hm.length && meanA(hp) * meanA(hm) < 0
        && !rc.plus.some((q) => q.c < rc.sep - 1e-9) && !rc.minus.some((q) => -q.c < rc.sep - 1e-9)) ? 1 : 0;
    const hookWidthMm = hp.length ? Mm(Math.max(...hp.map((q) => q.c)) - rc.sep) : 0;

    // ── Loop shape by age: measured on drawn loops ────────────────────────
    const shells = (s) => model.arcadeShells({ ...MEASURE_SITE, t: sim(s), cls: 'X', n: 11, samples: 96 });
    const youngest = (ls) => ls.reduce((b, L) => (b == null || L.age < b.age ? L : b), null);
    const oldest = (ls) => ls.reduce((b, L) => (b == null || L.age > b.age ? L : b), null);
    // A loop a few sim units old, with a formed (faded-in) companion set: scan the first 10 minutes for the freshest one.
    let fresh = null;
    for (let s = 30; s <= 600; s += 6) { const L = youngest(shells(s).filter((x) => x.generation >= 2)); if (L && (fresh == null || L.age < fresh.age)) fresh = L; }
    const lateLoops = shells(EPOCH.late);
    const relaxed = oldest(lateLoops);
    // Shrinkage: the SAME loop (station, generation) just after it forms and half an hour on.
    const twin = fresh ? lateLoops.find((L) => L.station === fresh.station && L.generation === fresh.generation) : null;

    // ── The erupting rope ─────────────────────────────────────────────────
    const KMS = RSUN_MM * 1000 * simUnitsPerS;                      // R☉ per sim unit → km/s
    const RP = model.params.rope;
    const hasRope = RP.speed > 0;
    const vFinal = hasRope ? RP.speed * model.classFactor('X') * KMS : 0;
    const vOnset = hasRope ? model.ropeSpeed(0, 'X') * KMS : 0;
    // Peak acceleration, km/s²: the largest speed gain per second over the first 40 minutes.
    let aPeak = 0, tPeak = NaN;
    if (hasRope) for (let s = 0; s < 2400; s += 5) {
        const a = (model.ropeSpeed(sim(s + 5), 'X') - model.ropeSpeed(sim(s), 'X')) * KMS / 5;
        if (a > aPeak) { aPeak = a; tPeak = s + 2.5; }
    }
    // Feet in the hooks: each foot within its hook arc's radius of the arc's centre (on the sphere).
    let feetInHooks = 0, ropeAbove = 0;
    if (hasRope) {
        const tq = sim(EPOCH.early);
        const ax = model.ropeAxis({ ...MEASURE_SITE, t: tq, cls: 'X', chirality: 1 });
        const rcq = model.ribbonCurves({ ...MEASURE_SITE, t: tq, cls: 'X', chirality: 1 });
        const inHook = (foot, sign) => {
            const [a, c] = foot;
            const d = Math.hypot(a - sign * rcq.hook.s0, c - sign * (rcq.sep + rcq.hook.rho));
            return rcq.hook.rho > 0 && rcq.hook.sweep > 0 && d <= rcq.hook.rho * 0.999 && sign * c > rcq.sep;
        };
        feetInHooks = (inHook(ax.footAC[1], +1) && inHook(ax.footAC[0], -1)) ? 1 : 0;
        // Above the arcade: the rope's underside over the site clears the tallest loop, at every checked age.
        ropeAbove = 1;
        for (const s of [0, 60, 180, 420, 900]) {
            const st = model.ropeState(sim(s), 'X');
            const top = Math.max(0, ...model.arcadeShells({ ...MEASURE_SITE, t: sim(s), cls: 'X', n: 11, samples: 24 }).map((L) => L.apexR - 1));
            if (!(st.apexH - st.minorR > top)) ropeAbove = 0;
        }
    }

    // THE ROPE'S WIDTH. An erupting rope does not stay the width of its feet: it expands sideways as it
    // rises, into the broad loop a coronagraph sees. Measured with the apex 1 R☉ above the surface: the full
    // angle the rope's AXIS subtends at Sun centre (the graduated-cylindrical-shell model's 2α). And at three
    // heights: the clear gap between the two legs' tubes, as a fraction of the apex height (the smallest of
    // the three). Negative = the tube has grown fatter than the gap between its own legs.
    let ropeFanDeg = 0, ropeLegGap = 0;
    if (hasRope) {
        const tAtHeight = (h) => { let lo = 0, hi = sim(7200); for (let k = 0; k < 60; k++) { const mid = 0.5 * (lo + hi); if (model.ropeApexHeight(mid, 'X') < h) lo = mid; else hi = mid; } return 0.5 * (lo + hi); };
        const N = 96, dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len3 = (a) => Math.hypot(a[0], a[1], a[2]);
        const axisAt = (h) => model.ropeAxis({ ...MEASURE_SITE, t: tAtHeight(h), cls: 'X', chirality: 1, samples: N });
        const ax1 = axisAt(1.0), apex = ax1.pts[N / 2];
        let widest = 0;
        for (const p of ax1.pts) widest = Math.max(widest, Math.acos(Math.max(-1, Math.min(1, dot3(p, apex) / (len3(p) * len3(apex))))));
        ropeFanDeg = 2 * widest * 180 / Math.PI;
        ropeLegGap = Infinity;
        for (const h of [0.25, 0.5, 1.0]) {
            const ax = axisAt(h), a = ax.pts[N / 4], b = ax.pts[3 * N / 4];
            ropeLegGap = Math.min(ropeLegGap, (len3([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) - ax.radius[N / 4] - ax.radius[3 * N / 4]) / ax.state.apexH);
        }
    }

    return {
        ropeFanDeg, ropeLegGap,
        ropeFeetInHooks: feetInHooks,
        ropeAboveArcade: ropeAbove,
        ropeSpeedFinalKms: vFinal,
        ropeSpeedOnsetKms: vOnset,
        ropeAccelPeakKms2: aPeak,
        ropeAccelPeakMin: tPeak / 60,
        ropeTwistTurns: hasRope ? RP.twist : 0,
        ropeAspect: hasRope ? RP.radius : 0,
        sepOnsetFullMm: 2 * sepMm(EPOCH.onset, 'X'),
        sepLateFullMm: 2 * sepMm(EPOCH.late, 'X'),
        sepSpeedImpulsiveKms: vImp,
        sepSpeedLateKms: vLate,
        sepDeceleration: vLate > 0 ? vImp / vLate : Infinity,
        shearOnsetDeg: shearDeg(EPOCH.onset),
        shearLateDeg: shearDeg(EPOCH.late),
        shearOnsetComplexDeg: shearDeg(EPOCH.onset, true),
        loopAspect: apexMm(EPOCH.mid, 'X') / halfChordMm(EPOCH.mid, 'X'),
        apexOnsetMm: apexMm(EPOCH.onset, 'X'),
        apexLateMm: apexMm(EPOCH.late, 'X'),
        apexRiseLateKms: (apexMm(EPOCH.late, 'X') - apexMm(EPOCH.lateFrom, 'X')) * 1000 / (EPOCH.late - EPOCH.lateFrom),
        nestedSpread: apexMm(EPOCH.late, 'X') / apexMm(EPOCH.onset, 'X'),
        ribbonLengthXMm: lenMm('X'),
        ribbonLengthCMm: lenMm('C'),
        arcadeAspect: lenMm('X') / (2 * sepMm(EPOCH.late, 'X')),
        ribbonFwhmMm: Mm(model.ribbonWidth(sim(EPOCH.early))) * 2 * Math.sqrt(Math.LN2),
        ribbonDecayS: model.params.ribbon.decayT / simUnitsPerS,
        zipSpeedKms: zipS > 0 ? zipMm * 1000 / zipS : Infinity,
        classOrdered: (ordered((c) => lenMm(c)) && ordered((c) => sepMm(EPOCH.late, c)) && ordered((c) => apexMm(EPOCH.late, c))) ? 1 : 0,
        hookTurnDeg: hookTurn,
        hookDoubleJ: doubleJ,
        hookWidthOverLength: hookWidthMm / lenMm('X'),
        cuspIndexNew: fresh ? cuspIndex(fresh.pts) : NaN,
        cuspIndexRelaxed: relaxed ? cuspIndex(relaxed.pts) : NaN,
        apexAngleNewDeg: fresh ? apexAngleDeg(fresh.pts) : NaN,
        apexAngleRelaxedDeg: relaxed ? apexAngleDeg(relaxed.pts) : NaN,
        loopShrinkage: (fresh && twin) ? 1 - (twin.apexR - 1) / (fresh.apexR - 1) : NaN,
        freshLoopAgeS: fresh ? fresh.age / simUnitsPerS : NaN,
    };
}

const UNVERIFIED = false;
/**
 * The scored rows. `lo`–`hi` is the accepted range; `scale` says how a miss is
 * measured ('log' for quantities that span decades). `weight` is the row's
 * share of the total. Sources are as recalled and NOT yet checked against the
 * papers — see the header.
 */
export const TARGETS = Object.freeze([
    { id: 'sep_onset', key: 'sepOnsetFullMm', label: 'Ribbon separation at onset', unit: 'Mm', lo: 4, hi: 20, scale: 'log', weight: 1,
      source: 'Ribbons first brighten close to the inversion line and then part (Fletcher et al. 2011, Space Sci. Rev. 159, review).', verified: UNVERIFIED },
    { id: 'sep_late', key: 'sepLateFullMm', label: 'Ribbon separation at 30 min (X)', unit: 'Mm', lo: 30, hi: 100, scale: 'log', weight: 1,
      source: 'Ribbon distance of ≥M5 two-ribbon flares, tens of Mm (Toriumi et al. 2017, ApJ 834, 56).', verified: UNVERIFIED },
    { id: 'sep_speed', key: 'sepSpeedImpulsiveKms', label: 'Ribbon speed from the PIL, first 2 min', unit: 'km/s', lo: 5, hi: 60, scale: 'log', weight: 1,
      source: 'Tens of km/s in the impulsive phase (Asai et al. 2004, ApJ 611, 557; Fletcher et al. 2011).', verified: UNVERIFIED },
    { id: 'sep_decel', key: 'sepDeceleration', label: 'Ribbon speed, impulsive ÷ 25–30 min', unit: '×', lo: 3, hi: 100, scale: 'log', weight: 1.5,
      source: 'Separation slows from tens of km/s to a few km/s or less in the gradual phase (Fletcher et al. 2011).', verified: UNVERIFIED },
    { id: 'shear_onset', key: 'shearOnsetDeg', label: 'Shear angle at onset', unit: '°', lo: 50, hi: 80, scale: 'lin', weight: 1.5,
      source: 'Initial shear angle of 50 X/M two-ribbon flares (Su, Golub & Van Ballegooijen 2007, ApJ 655, 606).', verified: UNVERIFIED },
    { id: 'shear_late', key: 'shearLateDeg', label: 'Shear angle at 30 min', unit: '°', lo: 15, hi: 55, scale: 'lin', weight: 1.5,
      source: 'Final shear angle, same survey: strong-to-weak in 86 % of events (Su et al. 2007).', verified: UNVERIFIED },
    { id: 'loop_aspect', key: 'loopAspect', label: 'Loop height ÷ half footpoint span, 10 min', unit: '', lo: 0.6, hi: 1.5, scale: 'log', weight: 1.5,
      source: 'Flare loops are close to semicircular — the standard loop-length estimate L = π·d/2 (e.g. Reale 2014, Living Rev. Sol. Phys. 11, 4).', verified: UNVERIFIED },
    { id: 'apex_onset', key: 'apexOnsetMm', label: 'First loops: apex height', unit: 'Mm', lo: 5, hi: 25, scale: 'log', weight: 1,
      source: 'Post-flare loops first appear low, ~10⁴ km, and the system grows (Švestka 1976, Solar Flares).', verified: UNVERIFIED },
    { id: 'apex_late', key: 'apexLateMm', label: 'Arcade apex at 30 min (X)', unit: 'Mm', lo: 20, hi: 80, scale: 'log', weight: 1,
      source: 'Loop systems of large flares reach several ×10⁴ km within the first hour (Švestka 1976).', verified: UNVERIFIED },
    { id: 'apex_rise_late', key: 'apexRiseLateKms', label: 'Arcade growth at 25–30 min', unit: 'km/s', lo: 0.5, hi: 10, scale: 'log', weight: 0.5,
      source: 'Apparent rise of the loop system slows to a few km/s (Švestka 1976).', verified: UNVERIFIED },
    { id: 'nested', key: 'nestedSpread', label: 'Outer ÷ inner loop height at 30 min', unit: '×', lo: 1.5, hi: 8, scale: 'log', weight: 0.5,
      source: 'The arcade is nested: older, lower loops under newer, taller ones (the CSHKP picture).', verified: UNVERIFIED },
    { id: 'length_x', key: 'ribbonLengthXMm', label: 'Ribbon length, X class', unit: 'Mm', lo: 80, hi: 250, scale: 'log', weight: 1,
      source: 'Order of magnitude from ribbon areas of X-class flares (Kazachenko et al. 2017, ApJ 845, 49).', verified: UNVERIFIED },
    { id: 'length_c', key: 'ribbonLengthCMm', label: 'Ribbon length, C class', unit: 'Mm', lo: 20, hi: 120, scale: 'log', weight: 0.5,
      source: 'Same survey: ribbon area falls with GOES class (Kazachenko et al. 2017).', verified: UNVERIFIED },
    { id: 'arcade_aspect', key: 'arcadeAspect', label: 'Arcade length ÷ width at 30 min', unit: '', lo: 1.2, hi: 6, scale: 'log', weight: 1,
      source: 'A two-ribbon arcade is a few times longer than it is wide (Toriumi et al. 2017; Kazachenko et al. 2017).', verified: UNVERIFIED },
    { id: 'ribbon_width', key: 'ribbonFwhmMm', label: 'Ribbon width (FWHM), 5 min', unit: 'Mm', lo: 1, hi: 10, scale: 'log', weight: 0.5,
      source: 'UV ribbons are a few Mm wide at AIA 1600 Å resolution (Fletcher et al. 2011).', verified: UNVERIFIED },
    { id: 'zip', key: 'zipSpeedKms', label: 'Brightening along the PIL (zipper)', unit: 'km/s', lo: 10, hi: 200, scale: 'log', weight: 1,
      source: 'Ribbon elongation at tens to ~100 km/s (Qiu et al. 2017, ApJ 838, 17).', verified: UNVERIFIED },
    { id: 'j_hook', key: 'hookTurnDeg', label: 'Ribbon end: how far the hook turns', unit: '°', lo: 90, hi: 270, scale: 'lin', tol: 90, weight: 1.5,
      source: 'Ribbons of eruptive flares are J-shaped, each hook wrapping a leg of the erupting rope (Aulanier, Janvier & Schmieder 2012, A&A 543, A110; Janvier et al. 2014, ApJ 788, 60). The range is OUR encoding of "a hook" — a quarter turn to three quarters — not a published measurement.', verified: UNVERIFIED },
    { id: 'j_double', key: 'hookDoubleJ', label: 'Double-J: hooks at opposite ends, curling outward', unit: '', lo: 1, hi: 1, scale: 'lin', weight: 1,
      source: 'The two J\'s are a 180° rotation of each other; the hooks open away from the inversion line (Aulanier et al. 2012).', verified: UNVERIFIED },
    { id: 'j_size', key: 'hookWidthOverLength', label: 'Hook width ÷ ribbon length', unit: '', lo: 0.08, hi: 0.5, scale: 'log', weight: 0.5,
      source: 'A hook is a minor part of its ribbon (Janvier et al. 2014). The range is our encoding of that, not a published measurement.', verified: UNVERIFIED },
    { id: 'cusp_new', key: 'cuspIndexNew', label: 'Just-formed loop: top width ÷ a round arc\'s', unit: '', lo: 0.30, hi: 0.75, scale: 'lin', tol: 0.25, weight: 1.5,
      source: 'Newly reconnected loops are cusp-shaped at the top (Tsuneta et al. 1992, PASJ 44, L63; Tsuneta 1996, ApJ 456, 840). The range is OUR encoding of "pointed" — clearly narrower near the top than a round arc on the same feet (which reads 1) — not a published measurement.', verified: UNVERIFIED },
    { id: 'round_old', key: 'cuspIndexRelaxed', label: 'Relaxed loop (30 min): top width ÷ a round arc\'s', unit: '', lo: 0.90, hi: 1.10, scale: 'lin', tol: 0.25, weight: 1,
      source: 'Cooled post-flare loops are round (Forbes & Acton 1996, ApJ 459, 330: cusp-to-round relaxation). Range: our encoding of "round".', verified: UNVERIFIED },
    { id: 'shrinkage', key: 'loopShrinkage', label: 'Loop shrinkage, formation → 30 min', unit: '', lo: 0.15, hi: 0.40, scale: 'lin', tol: 0.15, weight: 1,
      source: 'Loops shrink by 20 % and 32 % in the two flares measured (Forbes & Acton 1996).', verified: UNVERIFIED },
    { id: 'rope_feet', key: 'ropeFeetInHooks', label: 'Rope: both feet inside the ribbons\' hooks', unit: '', lo: 1, hi: 1, scale: 'lin', weight: 1.5,
      source: 'The hooks of the J-shaped ribbons outline the footprints of the erupting flux rope (Aulanier, Janvier & Schmieder 2012; Janvier et al. 2014).', verified: UNVERIFIED },
    { id: 'rope_above', key: 'ropeAboveArcade', label: 'Rope: always above the flare loops', unit: '', lo: 1, hi: 1, scale: 'lin', weight: 1,
      source: 'The flare loops form by reconnection BELOW the rising rope (the CSHKP picture).', verified: UNVERIFIED },
    { id: 'rope_slow', key: 'ropeSpeedOnsetKms', label: 'Rope: rise speed at flare onset', unit: 'km/s', lo: 5, hi: 150, scale: 'log', tol: 2.3, weight: 1,
      source: 'A slow-rise phase of tens of km/s precedes the main acceleration (Zhang et al. 2001, ApJ 559, 452).', verified: UNVERIFIED },
    { id: 'rope_accel', key: 'ropeAccelPeakKms2', label: 'Rope: peak acceleration (X)', unit: 'km/s²', lo: 0.1, hi: 5, scale: 'log', tol: 2.3, weight: 1,
      source: 'Main-phase accelerations from ~0.01 to several km/s², a few tenths typical, the largest in impulsive events (Zhang & Dere 2006, ApJ 649, 1100; Bein et al. 2011, ApJ 738, 191).', verified: UNVERIFIED },
    { id: 'rope_accel_t', key: 'ropeAccelPeakMin', label: 'Rope: peak acceleration, minutes after onset', unit: 'min', lo: 1, hi: 15, scale: 'log', tol: 1.6, weight: 1,
      source: 'The acceleration phase coincides with the flare\'s rise phase (Zhang et al. 2001; Temmer et al. 2008, ApJ 673, L95).', verified: UNVERIFIED },
    { id: 'rope_speed', key: 'ropeSpeedFinalKms', label: 'Rope: speed after the acceleration (X)', unit: 'km/s', lo: 800, hi: 2500, scale: 'log', tol: 1.4, weight: 1,
      source: 'CMEs of X-class flares are fast, of order 1000–2000 km/s (Yashiro et al. 2005, JGR 110, A12S05).', verified: UNVERIFIED },
    { id: 'rope_twist', key: 'ropeTwistTurns', label: 'Rope: field twist, turns foot to foot', unit: '', lo: 1, hi: 3, scale: 'lin', tol: 1, weight: 0.5,
      source: 'Erupting ropes carry of order one to a few turns; ~1.25 turns is the kink threshold of a line-tied rope (Hood & Priest 1981; Török & Kliem 2005, ApJ 630, L97). Range: our encoding of "a few turns".', verified: UNVERIFIED },
    { id: 'rope_aspect', key: 'ropeAspect', label: 'Rope: minor radius ÷ apex height', unit: '', lo: 0.15, hi: 0.5, scale: 'log', tol: 0.7, weight: 0.5,
      source: 'Self-similar expansion with a fixed aspect, as in graduated-cylindrical-shell fits (Thernisien et al. 2006, ApJ 652, 763). Range: our encoding.', verified: UNVERIFIED },
    { id: 'rope_fan', key: 'ropeFanDeg', label: 'Rope: angular width of its axis from Sun centre, apex at 2 R☉', unit: '°', lo: 25, hi: 80, scale: 'lin', tol: 15, weight: 1,
      source: 'An erupting rope over-expands sideways into a broad loop; graduated-cylindrical-shell fits to CMEs give half-angles α of roughly 10–40°, and the axis spans 2α (Thernisien, Vourlidas & Howard 2009, Sol. Phys. 256, 111). Range: our encoding, from memory.', verified: UNVERIFIED },
    { id: 'rope_legs', key: 'ropeLegGap', label: 'Rope: clear gap between its legs ÷ apex height', unit: '', lo: 0.05, hi: 1.5, scale: 'lin', tol: 0.1, weight: 1,
      source: 'A flux rope is one tube anchored at two feet, with the cavity between its legs (the three-part CME: Illing & Hundhausen 1985, JGR 90, 275). A tube fatter than the gap between its own legs is not a shape a field can take.', verified: UNVERIFIED },
    { id: 'class_order', key: 'classOrdered', label: 'C < M < X in length, separation and height', unit: '', lo: 1, hi: 1, scale: 'lin', weight: 1,
      source: 'Ribbon area, reconnected flux and flare size rise with GOES class (Kazachenko et al. 2017).', verified: UNVERIFIED },
]);

/**
 * Morphology known to be missing from the model. NOT scored — there is nothing
 * to measure yet. Each becomes a TARGETS row when the kernel can produce it.
 */
export const OPEN_TARGETS = Object.freeze([
    { id: 'dimmings', what: 'Twin coronal dimmings open at the rope\'s feet as it leaves; the page does not darken observed pixels, so they are not drawn on the observed hemisphere at all.',
      source: 'Sterling & Hudson 1997, ApJ 491, L55; Webb et al. 2000, JGR 105, 7491.' },
    { id: 'cme_speed', what: 'The rope\'s speed is a law of the flare class; a reported CME\'s measured speed (DONKI) is not used yet.',
      source: 'DONKI CME analyses (the page already loads them for Sun Watch).' },
    { id: 'asymmetry', what: 'The two ribbons move at different speeds — the one in the stronger field moves less; ours are mirror images.',
      source: 'Reconnected flux balance: v·B is what matches, not v (Fletcher et al. 2011).' },
    { id: 'kernels', what: 'Hard X-ray footpoint kernels run along the ribbons during the impulsive phase; the page has two fixed kernels.',
      source: 'Krucker, Hurford & Lin 2003, ApJ 595, L103; Qiu et al. 2017.' },
    { id: 'downflows', what: 'Supra-arcade downflows above the loop tops in the hot channels are not drawn.',
      source: 'McKenzie & Hudson 1999, ApJ 519, L93.' },
    { id: 'looptop_ridge', what: 'The tops of a real arcade\'s hot loops merge into one continuous bright ridge (thousands of unresolved loops); ours are a few dozen drawn loops whose tops are separate. A spine through the newest loops\' tops is the candidate.',
      source: 'Bright looptop sources and the ridge they form along a flare arcade in soft X-rays and the hot EUV channels (e.g. Masuda et al. 1994; Warren et al. 2011, on the 131 Å arcade). From memory.' },
    { id: 'rope_front', what: 'An erupting rope drives a bright leading edge and sheath ahead of it (the three-part CME: front, cavity, core); only the cavity\'s field lines and the core filament are drawn.',
      source: 'Illing & Hundhausen 1985, JGR 90, 275 (three-part structure). From memory.' },
]);

/**
 * 0–1: 1 inside [lo, hi], falling linearly to 0 one range-width outside it
 * (in log space for scale 'log'). A row may set `tol` — the distance outside
 * the range at which the score reaches 0 (a ratio's log for scale 'log') — and
 * the rows that ask "is this feature there at all" do, so that a model
 * WITHOUT the feature scores 0 on it, not half marks for being a range-width
 * away (a straight ribbon scored 0.50 on the hook row before this).
 */
export function scoreValue(v, { lo, hi, scale = 'lin', tol = null }) {
    if (!Number.isFinite(v)) return 0;
    if (v >= lo && v <= hi) return 1;
    if (scale === 'log') {
        if (!(v > 0) || !(lo > 0)) return 0;
        const w = tol ?? Math.max(Math.log(hi / lo), Math.LN2);       // at least a factor of two of grace
        const d = v < lo ? Math.log(lo / v) : Math.log(v / hi);
        return Math.max(0, 1 - d / w);
    }
    const w = tol ?? Math.max(hi - lo, 1e-9 + 0.25 * Math.abs(hi));    // a point range still has a slope
    const d = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - d / w);
}

/** Score a model. `score` is the weighted mean of the rows' scores. */
export function scorecard(model = FLARE_MODEL, { targets = TARGETS, simUnitsPerS = SIM_UNITS_PER_S } = {}) {
    const m = measure(model, { simUnitsPerS });
    let sw = 0, s = 0;
    const metrics = targets.map((t) => {
        const value = m[t.key];
        const sc = scoreValue(value, t);
        sw += t.weight; s += t.weight * sc;
        return { id: t.id, label: t.label, unit: t.unit, value, lo: t.lo, hi: t.hi, score: sc, pass: sc === 1, weight: t.weight, verified: t.verified, source: t.source };
    });
    return {
        modelId: model.id, score: sw ? s / sw : 0,
        passed: metrics.filter((x) => x.pass).length, rows: metrics.length,
        verifiedRows: metrics.filter((x) => x.verified).length,
        metrics, measurements: m,
    };
}

/** Row-by-row difference between two scorecards (b − a). */
export function compareScorecards(a, b) {
    const A = new Map(a.metrics.map((x) => [x.id, x]));
    return {
        delta: b.score - a.score,
        rows: b.metrics.map((y) => { const x = A.get(y.id); return { id: y.id, label: y.label, unit: y.unit, from: x?.value, to: y.value, scoreFrom: x?.score ?? null, scoreTo: y.score, delta: y.score - (x?.score ?? 0) }; }),
    };
}

/** The baseline record tests/flare-realism.mjs compares against. */
export function baselineOf(card) {
    return { modelId: card.modelId, score: +card.score.toFixed(6), metrics: Object.fromEntries(card.metrics.map((x) => [x.id, +x.score.toFixed(6)])) };
}

const num = (v) => !Number.isFinite(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
/** A plain-text table of a scorecard (the script and the gate both print it). */
export function formatScorecard(card) {
    const lines = [`flare realism — ${card.modelId}: ${(card.score * 100).toFixed(1)} / 100  (${card.passed} of ${card.rows} rows in range; ${card.verifiedRows} of ${card.rows} ranges verified against their source)`];
    for (const x of card.metrics) {
        const mark = x.pass ? ' ok ' : x.score > 0 ? 'near' : 'MISS';
        lines.push(`  ${mark}  ${x.label.padEnd(44)} ${num(x.value).padStart(8)} ${x.unit.padEnd(5)} [${num(x.lo)} – ${num(x.hi)}]  ${x.score.toFixed(2)}`);
    }
    return lines.join('\n');
}
