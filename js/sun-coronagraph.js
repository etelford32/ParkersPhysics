/**
 * sun-coronagraph.js — the OBSERVED outer corona: SOHO/LASCO C2 + C3 on the plane of sky
 * ═══════════════════════════════════════════════════════════════════════════
 * The third observed layer on sun.html. js/sun-observed.js wraps the SDO disk
 * on the near hemisphere; js/sun-offlimb.js draws the 1.0–1.6 R☉ EUV annulus
 * of the same frames; this draws what a white-light coronagraph sees beyond
 * that — streamers, the heliospheric plasma sheet edge-on, and every CME on
 * its way out — from 2.2 R☉ (C2) to as far as a Sun-centred circle fits in a
 * C3 frame (≈ 27 R☉). Read js/sun-offlimb.js's header first: the geometry
 * argument is that module's, reused here, not re-derived.
 *
 * ── Why it is drawn on a plane, and why that is honest ─────────────────────
 * A coronagraph pixel is photospheric light Thomson-scattered by coronal
 * electrons, integrated along the whole line of sight and weighted toward the
 * point of closest approach (the Thomson sphere is, this close to the Sun,
 * the plane of sky to well within a browse product's accuracy). It is optically
 * thin and it belongs to no surface — so, exactly as for the EUV annulus, the
 * honest place to draw it is the plane through Sun centre normal to the
 * Sun–observer line. `observerBasis` and `offAxisWeight` are IMPORTED from
 * js/sun-offlimb.js and not copied: SOHO sits at L1, 0.2° off the Sun–Earth
 * line as seen from the Sun, sixty times inside the 12° full-weight band.
 * The same three consequences hold: the sphere occludes the far half, the
 * plane does not co-rotate (a frame is a snapshot in the OBSERVER's frame),
 * and it fades as the camera leaves the Sun–Earth line.
 *
 * ── What is MEASURED, what is DERIVED, what is typed ───────────────────────
 *   • SCALE is derived: the instrument's plate scale (C2 11.9″/px, C3 56.0″/px
 *     at the native 1024²) and the Sun's apparent radius ON THAT DATE AS SEEN
 *     FROM L1 (`apparentSolarRadiusArcsec`: the Meeus distance, then 1 % closer
 *     — L1's distance is derived from the Earth+Moon/Sun mass ratio, not
 *     typed). No R☉-in-pixels number appears in this file.
 *   • CENTRE is measured: the realtime browse JPEGs draw a white circle at the
 *     solar limb inside the occulter, and the Sun is NOT at the frame centre
 *     (the occulter is, roughly; the pointing is not). `measureLimbRing` finds
 *     that circle by a Hough vote at the derived radius and refines it to a
 *     sub-pixel centroid. The ring's own radius is then a CHECK on the derived
 *     scale, not a replacement for it: at C3's plate scale the ring is 17 px
 *     across a 1024² frame, so reading the scale off it would be worth ±3 %,
 *     an order worse than the plate scale it would be overriding.
 *   • A measurement is ACCEPTED only inside a window (ring radius within
 *     RING_ACCEPT of the derived one, centre within CENTRE_TOL of the frame
 *     centre, most of the circle present). Otherwise the instrument's nominal
 *     geometry is used and the state SAYS SO (`geometry: 'nominal'`) — a C3
 *     frame resolved against C2's expectations must fail the window, not draw
 *     four times too small with nothing erroring (the SUVI disk-fraction scar).
 *   • THE OCCULTER EDGE is measured too (`measureOcculter`): the browse
 *     product paints a flat-colour disc over the occulted region, whose radius
 *     is a property of NASA's pipeline that this build could not look up. The
 *     drawn inner radius is the larger of the instrument's usable inner radius
 *     and the measured mask edge plus a margin, so a mask wider than expected
 *     is never drawn as a ring of "corona".
 *
 * ── Level, pedestal, stretch — and nothing about colour ────────────────────
 * The browse products are display images: colourised (C2 orange, C3 blue),
 * byte-scaled by SOHO's pipeline, with a NON-BLACK sky (the colour table's
 * dark end). Three corrections, all to LEVEL, none to hue:
 *   0. THE SCALAR. A colour-table product encodes ONE number per pixel; the
 *      number this module reads back is the linear MAX CHANNEL ("value"), not
 *      luminance. Both are monotone in the underlying signal, but luminance
 *      weights blue at 7 %: normalising the blue C3 product to a target
 *      luminance drives its blue channel 14× past a neutral pixel of the same
 *      level, and the first render of this layer was a saturated blue ball
 *      around an orange one (measured on the fixtures: C3's level came out
 *      2.9 in "linear luminance", i.e. above white). On the max channel an
 *      orange pixel and a blue pixel of the same displayed level peak at the
 *      same number, so the two instruments carry equal visual weight at their
 *      seam and neither hue is touched.
 *   1. PEDESTAL. The frame's own dark level is subtracted — without it an
 *      additive layer paints the colour table's dark end across the sky as a
 *      faint disc with a visible rim where the field stops. It is the
 *      PEDESTAL_PERCENTILE of the value over EVERYTHING outside the occulter,
 *      corners included, i.e. the darkest the product gets anywhere: C3's
 *      pylon shadow and the sky beyond its field stop, C2's vignetted
 *      corners. NOT the drawn field's own outer rim, which was the first
 *      version: C2's field is full of corona right to its edge, so "the
 *      outer rim's level" subtracted real corona, drove C2 to zero exactly
 *      where it meets C3, and the level match then dimmed C3 fivefold to
 *      agree with that zero (measured on the fixtures).
 *   2. REFERENCE SHELL. Everything is drawn relative to the frame's own median
 *      (pedestal-subtracted) level in REF_SHELL, never to an absolute byte
 *      value — a browse JPEG's absolute level is a display choice, not
 *      radiometry (the disk-fusion lesson, js/sun-observed.js). A frame whose
 *      reference shell is not at least REF_FLOOR above its pedestal does not
 *      calibrate and THE INSTRUMENT DOES NOT DRAW.
 *   3. DISPLAY STRETCH. √ by default (STRETCH_GAMMA), applied to that one
 *      scalar and the pixel's RGB scaled uniformly to match, so its own
 *      chromaticity survives — per-channel pow would desaturate and so
 *      recolour an observed pixel. Monotone; disclosed in `note`.
 * The pixel's hue is the published product's. The layer is ADDITIVE: the
 * corona is optically thin, and an additive layer cannot occlude the stars,
 * the model, the disc or the EUV annulus — and with nothing drawn inside the
 * occulter (≥ 2.2 R☉) it cannot wash out the disc or the 1.0–1.6 R☉ ring.
 *
 * ── C2 inside C3 ───────────────────────────────────────────────────────────
 * Their fields overlap from C3's occulter (≈ 4 R☉) to C2's edge (≈ 5.8 R☉).
 * C2 wins wherever it has data — five times finer plate scale — and hands over
 * to C3 across its own outer feather; the hand-over width is C2's `featherOut`
 * and the note prints it. The two products are byte-scaled independently, so
 * C3 is LEVEL-MATCHED to C2 on their shared overlap shell (`crossCalibrate`:
 * both see the same corona there, so their normalised medians must agree) —
 * otherwise the seam is a brightness step that reads as coronal structure.
 * With C2 down, C3 falls back to its own reference shell and says so
 * (`levelBasis: 'own-shell'`).
 *
 * ── UNVERIFIED (nasa.gov is egress-blocked at build time) ──────────────────
 * Everything below was written from the instruments' documentation, not from
 * a frame, and the fixtures (tests/fixtures/sdo/synthetic_c2|c3.png) are
 * SYNTHETIC stand-ins built to that description:
 *   • that the realtime JPEGs carry the white limb circle and a flat occulter
 *     disc (both are MEASURED, so their absence degrades to `nominal`/typed
 *     rather than breaking — but then the centre is the frame centre);
 *   • ROLL. The products are assumed solar-north-up. SOHO flies inverted for
 *     about half of each year; if the realtime product is not counter-rotated
 *     the corona is drawn upside down. `pylonPositionAngle` reports where the
 *     C3 occulter pylon is (SE, PA ≈ 135°, in a north-up frame) so ONE look at
 *     production state settles it: `__sun.coronagraph.instruments[1].pylonPaDeg`
 *     near 135 ⇒ fine; near 315 ⇒ pass `rollDeg: 180` (or set `autoRoll`).
 *   • the timestamp block's position (bottom-left). The drawn field is a
 *     Sun-centred circle FIELD_FRAC of the way to the nearest frame edge, which
 *     excludes all four corners, so this is robust to where the text sits.
 *   • `X-SDO-Observed-At` is the upstream Last-Modified — when NASA wrote the
 *     file. The exposure time is burned into the pixels and is not parsed.
 *
 * ── Split ──────────────────────────────────────────────────────────────────
 *   PURE (node-gated by tests/sun-coronagraph.mjs): instrument table, scale,
 *     ring + occulter measurement, field mask, calibration, cross-calibration,
 *     the compositing weights, the pylon probe, the label.
 *   BROWSER (`SunCoronagraph`): same lifecycle contract as `SunOffLimb`.
 */

import { julianDayOf, solarEphemeris, srgbToLinear } from './sun-observed.js';
import { observerBasis, offAxisWeight, displayStretch, REF_FLOOR, REF_MIN_SAMPLES } from './sun-offlimb.js';
import { parseLascoChannel, lascoFreshness, LASCO_WARN_S, LASCO_CRIT_S } from './lasco-sources.js';

export { parseLascoChannel };

const DEG = Math.PI / 180;

// ── Instruments ────────────────────────────────────────────────────────────

/**
 * The two coronagraphs. `plateScaleArcsec` is per pixel of the NATIVE 1024²
 * frame; a 512 browse frame is that frame binned, so every geometric quantity
 * here is carried as a FRACTION of the frame and is size-independent.
 *
 *   occulterRsun — nominal radius of the browse product's occulter disc
 *                  (measured per frame; this is the fallback)
 *   rInner       — smallest radius worth drawing (inside it: stray light)
 *   rOuter       — the instrument's stated field; the drawn outer radius is
 *                  the smaller of this and what a Sun-centred circle allows
 *   featherIn/Out — R☉; C2's featherOut is the C2 → C3 hand-over width
 *   refShell     — where the frame's own level is measured
 */
export const CORONAGRAPHS = Object.freeze({
    c2: Object.freeze({
        id: 'c2', label: 'SOHO/LASCO C2', short: 'C2',
        nativePx: 1024, plateScaleArcsec: 11.9,
        occulterRsun: 2.0, rInner: 2.2, rOuter: 6.0,
        featherIn: 0.25, featherOut: 0.8,
        refShell: Object.freeze({ lo: 2.8, hi: 3.4 }),
        occulterSearchMax: 3.4,
        cadenceS: 720,
    }),
    c3: Object.freeze({
        id: 'c3', label: 'SOHO/LASCO C3', short: 'C3',
        nativePx: 1024, plateScaleArcsec: 56.0,
        occulterRsun: 3.7, rInner: 4.0, rOuter: 30.0,
        featherIn: 0.6, featherOut: 5.0,
        refShell: Object.freeze({ lo: 5.0, hi: 6.5 }),
        occulterSearchMax: 6.5,
        cadenceS: 720,
    }),
});

export const CORONAGRAPH_IDS = Object.freeze(['c2', 'c3']);

export function coronagraph(id) {
    const k = parseLascoChannel(id);
    if (!k) throw new Error(`unknown coronagraph ${id}`);
    return CORONAGRAPHS[k];
}

// ── Scale: derived, never typed ────────────────────────────────────────────

/** Sun's semi-diameter at 1 AU, arcsec (IAU nominal R☉ / AU). */
export const SOLAR_SEMIDIAMETER_1AU_ARCSEC = 959.63;

/**
 * Sun–L1 distance as a fraction of the Sun–Earth distance.
 * (μ/3)^(1/3) with μ = (M_Earth + M_Moon)/M_Sun — the first-order collinear
 * Lagrange-point distance. Derived so nobody "corrects" a typed 0.01.
 */
export const EARTH_MOON_SUN_MASS_RATIO = 1 / 328900.56;
export const L1_FRACTION = Math.cbrt(EARTH_MOON_SUN_MASS_RATIO / 3);

/** Sun–Earth distance in AU (Meeus ch. 25, the series solarEphemeris uses). */
export function sunDistanceAu(date = new Date()) {
    const T = (julianDayOf(date) - 2451545.0) / 36525;
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const C = ((1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
             + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
             + 0.000289 * Math.sin(3 * M)) * DEG;
    return 1.000001018 * (1 - e * e) / (1 + e * Math.cos(M + C));
}

/**
 * The Sun's apparent radius in arcsec, by default as seen from L1 (SOHO).
 * `fromL1: false` gives the geocentric value (used only by the test's control).
 */
export function apparentSolarRadiusArcsec(date = new Date(), { fromL1 = true } = {}) {
    const d = sunDistanceAu(date) * (fromL1 ? 1 - L1_FRACTION : 1);
    return SOLAR_SEMIDIAMETER_1AU_ARCSEC / d;
}

/** One solar radius as a fraction of the frame width, for this instrument and date. */
export function expectedRsunFrac(id, date = new Date()) {
    const inst = coronagraph(id);
    return apparentSolarRadiusArcsec(date) / (inst.plateScaleArcsec * inst.nativePx);
}

// ── Plane of sky ↔ frame ───────────────────────────────────────────────────

/**
 * Plane-of-sky point (x, y) in R☉ (+x image right = solar west, +y up = solar
 * north) → frame fractions with y DOWN (the image's own convention).
 * `rollDeg` rotates the SKY into the frame: a frame whose solar north points
 * `rollDeg` counter-clockwise from image-up needs that roll here. 0 for a
 * north-up product.
 */
export function planeToFrame(x, y, geom, rollDeg = 0) {
    const c = Math.cos(rollDeg * DEG), s = Math.sin(rollDeg * DEG);
    const fx = c * x - s * y, fy = s * x + c * y;
    return { u: geom.cx + fx * geom.r, v: geom.cy - fy * geom.r, rho: Math.hypot(x, y) };
}

/** Frame fractions (y down) → plane of sky, R☉. Inverse of planeToFrame. */
export function frameToPlane(u, v, geom, rollDeg = 0) {
    const fx = (u - geom.cx) / geom.r, fy = (geom.cy - v) / geom.r;
    const c = Math.cos(rollDeg * DEG), s = Math.sin(rollDeg * DEG);
    return { x: c * fx + s * fy, y: -s * fx + c * fy, rho: Math.hypot(fx, fy) };
}

/**
 * Position angle in degrees, the solar convention: 0 = north, increasing
 * COUNTER-CLOCKWISE through EAST — and east is image LEFT (−x) in a north-up
 * view of the sky. So PA 90 is the east limb, 270 the west.
 */
export function positionAngleDeg(x, y) {
    return ((Math.atan2(-x, y) / DEG) % 360 + 360) % 360;
}

/** Plane-of-sky point at position angle `paDeg` and radius `rho` (R☉). */
export function fromPositionAngle(paDeg, rho) {
    return { x: -rho * Math.sin(paDeg * DEG), y: rho * Math.cos(paDeg * DEG) };
}

// ── Measuring the frame ────────────────────────────────────────────────────

/** A measured ring radius within this fraction of the derived one is believed. */
export const RING_ACCEPT = 0.15;
/** The Sun's centre must be within this fraction of the frame width of the frame centre. */
export const CENTRE_TOL = 0.06;
/** Fraction of the ring's 16 sectors that must contain ring pixels. */
export const RING_MIN_COVERAGE = 0.75;
/** Colour departure (8-bit, max channel) that ends the occulter's flat disc. */
export const OCCULTER_DELTA = 28;
/** Drawn inner radius ≥ measured mask edge × this. */
export const OCCULTER_MARGIN = 1.06;
/** The measured mask edge is believed only within this factor of the nominal one. */
export const OCCULTER_ACCEPT = Object.freeze({ lo: 0.7, hi: 1.45 });
/**
 * The drawn field is a Sun-centred circle this fraction of the way to the
 * NEAREST frame edge. It is what keeps the corners — the timestamp, the logo —
 * and the frame's own border out of the sky without knowing where they are.
 */
export const FIELD_FRAC = 0.93;

function median(a) {
    if (!a.length) return NaN;
    const s = Array.from(a).sort((p, q) => p - q);
    return s[s.length >> 1];
}
function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}
function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/**
 * Find the white limb circle. PURE.
 *
 * "White" is measured as min(R, G, B): the occulter disc and the corona are
 * strongly coloured (one channel low) while the circle is neutral, so the
 * minimum channel separates them where luminance would not. The threshold is
 * relative to the window's own median — the flat occulter disc — so it adapts
 * to the product's colour table and to JPEG softening of a 1-px line.
 *
 * Hough vote at the EXPECTED radius (so a ring of another radius — the wrong
 * instrument — produces no coherent peak), then a weighted-centroid refinement
 * and the acceptance tests listed in the module header.
 *
 * @param {ArrayLike<number>} rgba row-major RGBA bytes
 * @param {number} expectedRpx  derived solar radius in pixels of THIS frame
 * @returns {{ok:boolean, cx:number, cy:number, rPx:number, ratio:number, coverage:number, reason:string|null}}
 *          cx, cy as frame fractions (y down)
 */
export function measureLimbRing(rgba, w, h, expectedRpx) {
    const fail = (reason, extra = {}) => ({ ok: false, cx: 0.5, cy: 0.5, rPx: expectedRpx, ratio: NaN, coverage: 0, reason, ...extra });
    if (!rgba || !(expectedRpx > 1.5)) return fail('no_frame');
    const tol = CENTRE_TOL * w;
    const reach = Math.ceil(tol + expectedRpx * (1 + RING_ACCEPT) + 2);
    const x0 = Math.max(0, Math.floor(w / 2 - reach)), x1 = Math.min(w - 1, Math.ceil(w / 2 + reach));
    const y0 = Math.max(0, Math.floor(h / 2 - reach)), y1 = Math.min(h - 1, Math.ceil(h / 2 + reach));
    const ww = x1 - x0 + 1, wh = y1 - y0 + 1;
    const white = new Float32Array(ww * wh);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const o = (y * w + x) * 4;
            white[(y - y0) * ww + (x - x0)] = Math.min(rgba[o], rgba[o + 1], rgba[o + 2]);
        }
    }
    // The window's dark quartile is the flat occulter disc (or the sky): the
    // level a "white" line has to stand out from.
    const base = percentile(Array.from(white).sort((p, q) => p - q), 0.25);
    const thr = 0.2 * (255 - base);
    // Candidate ring pixels: a neutral LINE, i.e. brighter than BOTH pixels
    // three away on opposite sides, in at least one of four directions. The
    // weight is the smaller of the two drops, so:
    //   • a one- or two-pixel line scores its full contrast (across itself);
    //   • a SOLID bright region scores ~0 (no direction has two dark sides);
    //   • an EDGE scores ~0 too (one side of every pair is still bright).
    // The edge case is not hypothetical: the bright inner corona meets C3's
    // flat occulter disc on a circle 34 px across a 512² frame — inside the
    // acceptance window of C2's 41-px solar radius. A plain high-pass let a
    // C3 frame pass as C2 (caught by the node gate's negative control).
    const PAIRS = [[3, 0], [0, 3], [2, 2], [2, -2]];
    const px = [], py = [], pw = [];
    for (let j = 3; j < wh - 3; j++) {
        for (let i = 3; i < ww - 3; i++) {
            const v = white[j * ww + i];
            if (v - base <= thr) continue;
            let hp = 0;
            for (const [dx, dy] of PAIRS) {
                const d = Math.min(v - white[(j + dy) * ww + (i + dx)], v - white[(j - dy) * ww + (i - dx)]);
                if (d > hp) hp = d;
            }
            if (hp > thr) { px.push(i); py.push(j); pw.push(hp); }
        }
    }
    if (px.length < 12) return fail('no_ring');
    // Hough accumulator over candidate centres, at the expected radius.
    const acc = new Float32Array(ww * wh);
    const nAng = Math.max(32, Math.ceil(2 * Math.PI * expectedRpx * 1.5));
    const cosT = new Float32Array(nAng), sinT = new Float32Array(nAng);
    for (let k = 0; k < nAng; k++) { cosT[k] = Math.cos(2 * Math.PI * k / nAng); sinT[k] = Math.sin(2 * Math.PI * k / nAng); }
    for (let n = 0; n < px.length; n++) {
        for (let k = 0; k < nAng; k++) {
            const ax = Math.round(px[n] - expectedRpx * cosT[k]);
            const ay = Math.round(py[n] - expectedRpx * sinT[k]);
            if (ax < 0 || ay < 0 || ax >= ww || ay >= wh) continue;
            acc[ay * ww + ax] += pw[n];
        }
    }
    let best = 0, bi = 0;
    for (let i = 0; i < acc.length; i++) if (acc[i] > best) { best = acc[i]; bi = i; }
    let cx = bi % ww, cy = Math.floor(bi / ww), r = expectedRpx;
    // Refine: weighted centroid + mean radius of the candidates in the annulus.
    let n = 0, spread = 0, coverage = 0;
    for (let pass = 0; pass < 3; pass++) {
        let sx = 0, sy = 0, sw = 0, sr = 0; n = 0;
        const lo = r * (1 - RING_ACCEPT - 0.1), hi = r * (1 + RING_ACCEPT + 0.1);
        const sect = new Uint8Array(16);
        for (let k = 0; k < px.length; k++) {
            const dx = px[k] - cx, dy = py[k] - cy, d = Math.hypot(dx, dy);
            if (d < lo || d > hi) continue;
            sx += px[k] * pw[k]; sy += py[k] * pw[k]; sr += d * pw[k]; sw += pw[k]; n++;
            sect[Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 16) & 15] = 1;
        }
        if (!(sw > 0)) return fail('no_ring');
        cx = sx / sw; cy = sy / sw;
        // Radius about the NEW centre.
        let sr2 = 0, sw2 = 0, sv = 0;
        for (let k = 0; k < px.length; k++) {
            const d = Math.hypot(px[k] - cx, py[k] - cy);
            if (d < lo || d > hi) continue;
            sr2 += d * pw[k]; sw2 += pw[k];
        }
        r = sw2 > 0 ? sr2 / sw2 : sr / sw;
        for (let k = 0; k < px.length; k++) {
            const d = Math.hypot(px[k] - cx, py[k] - cy);
            if (d < lo || d > hi) continue;
            sv += (d - r) * (d - r) * pw[k];
        }
        spread = Math.sqrt(sv / Math.max(sw2, 1e-9));
        coverage = sect.reduce((a, b) => a + b, 0) / 16;
    }
    const out = {
        cx: (x0 + cx + 0.5) / w, cy: (y0 + cy + 0.5) / h,
        rPx: r, ratio: r / expectedRpx, coverage,
    };
    if (coverage < RING_MIN_COVERAGE) return fail('ring_incomplete', out);
    if (n < 0.5 * 2 * Math.PI * expectedRpx * 0.5) return fail('ring_too_sparse', out);
    if (spread > Math.max(1.0, 0.12 * expectedRpx)) return fail('not_a_ring', out);
    if (Math.abs(out.ratio - 1) > RING_ACCEPT) return fail('ring_radius_outside_window', out);
    if (Math.hypot(out.cx - 0.5, out.cy - 0.5) > CENTRE_TOL) return fail('centre_outside_window', out);
    return { ok: true, ...out, reason: null };
}

/**
 * Resolve the frame's geometry: measured centre if the ring passes its window,
 * else the instrument's nominal (frame-centred) geometry — and say which.
 * The SCALE is always the derived one (module header).
 *
 * @returns {{cx:number, cy:number, r:number, source:'measured'|'nominal', reason:string|null, ringRatio:number|null}}
 */
export function resolveCoronagraphGeometry(rgba, w, h, id, date = new Date()) {
    const rFrac = expectedRsunFrac(id, date);
    const ring = rgba ? measureLimbRing(rgba, w, h, rFrac * w) : { ok: false, reason: 'no_frame' };
    if (ring.ok) {
        return { cx: ring.cx, cy: ring.cy, r: rFrac, source: 'measured', reason: null, ringRatio: ring.ratio };
    }
    return { cx: 0.5, cy: 0.5, r: rFrac, source: 'nominal', reason: ring.reason,
             ringRatio: Number.isFinite(ring.ratio) ? ring.ratio : null };
}

/**
 * Where the browse product's flat occulter disc ends, in R☉. PURE.
 * The disc's colour is the median of the ring of pixels between the limb
 * circle and the disc's edge; each of 72 rays walks outward until the colour
 * departs from it for two consecutive samples. Median over rays; null when
 * fewer than half the rays find an edge or the answer is outside
 * OCCULTER_ACCEPT of the nominal radius (then the typed radius is used).
 */
export function measureOcculter(rgba, w, h, geom, id) {
    const inst = coronagraph(id);
    const R = geom.r * w, cx = geom.cx * w, cy = geom.cy * h;
    if (!rgba || !(R > 1.5)) return null;
    const at = (x, y) => {
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
        const o = (yi * w + xi) * 4;
        return [rgba[o], rgba[o + 1], rgba[o + 2]];
    };
    const rs = [], gs = [], bs = [];
    for (let k = 0; k < 96; k++) {
        const a = 2 * Math.PI * k / 96;
        for (const rho of [1.3, 1.4, 1.5]) {
            const p = at(cx + rho * R * Math.cos(a), cy + rho * R * Math.sin(a));
            if (p) { rs.push(p[0]); gs.push(p[1]); bs.push(p[2]); }
        }
    }
    if (rs.length < 48) return null;
    const mask = [median(rs), median(gs), median(bs)];
    const step = Math.max(0.5 / R, 0.01);       // half a pixel, in R☉
    const edges = [];
    for (let k = 0; k < 72; k++) {
        const a = 2 * Math.PI * (k + 0.5) / 72;
        let run = 0;
        for (let rho = 1.6; rho <= inst.occulterSearchMax; rho += step) {
            const p = at(cx + rho * R * Math.cos(a), cy + rho * R * Math.sin(a));
            if (!p) break;
            const d = Math.max(Math.abs(p[0] - mask[0]), Math.abs(p[1] - mask[1]), Math.abs(p[2] - mask[2]));
            if (d > OCCULTER_DELTA) { if (++run >= 2) { edges.push(rho - step); break; } } else run = 0;
        }
    }
    if (edges.length < 36) return null;
    const edge = median(edges);
    if (edge < inst.occulterRsun * OCCULTER_ACCEPT.lo || edge > inst.occulterRsun * OCCULTER_ACCEPT.hi) return null;
    return edge;
}

/**
 * The drawn field of one instrument for one frame: (rIn, featherIn, rOut,
 * featherOut) in R☉, with where each end came from.
 */
export function fieldFor(id, geom, occulterMeasured = null) {
    const inst = coronagraph(id);
    const occ = occulterMeasured ?? inst.occulterRsun;
    const rIn = Math.max(inst.rInner, occ * OCCULTER_MARGIN);
    // Largest Sun-centred circle inside the frame, in R☉.
    const edge = Math.min(geom.cx, 1 - geom.cx, geom.cy, 1 - geom.cy) / geom.r;
    const rOut = Math.min(inst.rOuter, FIELD_FRAC * edge);
    return {
        id: inst.id, rIn, featherIn: inst.featherIn, rOut, featherOut: Math.min(inst.featherOut, Math.max(0.05, (rOut - rIn) * 0.5)),
        occulterRsun: occ, occulterSource: occulterMeasured != null ? 'measured' : 'nominal',
        frameEdgeRsun: edge, limitedBy: rOut < inst.rOuter ? 'frame' : 'instrument',
    };
}

/** Radial weight of a field, 0 outside [rIn, rOut]. Mirrored in the GLSL. */
export function fieldWeight(rho, f) {
    if (!f || !(rho >= f.rIn) || rho >= f.rOut) return 0;
    return smoothstep(f.rIn, f.rIn + f.featherIn, rho) * (1 - smoothstep(f.rOut - f.featherOut, f.rOut, rho));
}

/**
 * The weight a FRAME PIXEL (fractions, y down) is drawn with — 0 inside the
 * occulter, 0 in the corners, 0 outside the frame. What the mask tests probe.
 */
export function maskWeightAt(u, v, geom, f, rollDeg = 0) {
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return 0;
    return fieldWeight(frameToPlane(u, v, geom, rollDeg).rho, f);
}

/**
 * How much of radius `rho` C2 COVERS — 1 from its inner radius to the start
 * of its outer feather, then its feather. C3 is drawn with (1 − this), so C2
 * wins wherever it has data and the hand-over is C2's own outer feather.
 */
export function c2Cover(rho, f2) {
    if (!f2 || !(rho >= f2.rIn)) return 0;
    return 1 - smoothstep(f2.rOut - f2.featherOut, f2.rOut, rho);
}

/** The two instruments' weights at one radius. `f2`/`f3` null = that instrument is off. */
export function compositeWeights(rho, f2, f3) {
    const w2 = f2 ? fieldWeight(rho, f2) : 0;
    const w3 = f3 ? fieldWeight(rho, f3) * (1 - (f2 ? c2Cover(rho, f2) : 0)) : 0;
    return { w2, w3 };
}

// ── Photometry ─────────────────────────────────────────────────────────────

/**
 * The scalar a frame pixel is read as: the linear MAX CHANNEL. See step 0 of
 * the level section in the module header for why it is not luminance.
 */
export function pixelValue(r8, g8, b8) {
    return Math.max(srgbToLinear(r8), srgbToLinear(g8), srgbToLinear(b8));
}

/**
 * The pedestal is this percentile of the pixel value over every frame pixel
 * outside the occulter (module header, step 1). Low but not the minimum: a
 * handful of dead-black pixels (a JPEG block, a border line) must not set it.
 */
export const PEDESTAL_PERCENTILE = 0.02;
/** Display stretch exponent (√). A rendering choice, disclosed in `note`. */
export const STRETCH_GAMMA = 0.5;
/** Display gain: the additive level of the reference shell after the stretch. */
export const DEFAULT_GAIN = 0.4;

/**
 * Measure a frame's own pedestal and reference level. PURE.
 *
 * @param {object} geom   {cx, cy, r} frame fractions (y down)
 * @param {object} field  fieldFor(...)
 * @param {{lo:number,hi:number}|null} overlap  shell shared with the other instrument
 * @returns {{ok:boolean, floor:number, ref:number, level:number, overlap:number|null, samples:number, reason:string|null}}
 *          floor / ref are linear pixel values; level = ref − floor; overlap is
 *          the pedestal-subtracted median in the overlap shell (or null).
 */
export function calibrateCoronagraph(rgba, w, h, geom, field, id, overlap = null) {
    const inst = coronagraph(id);
    const fail = (reason, extra = {}) => ({ ok: false, floor: 0, ref: 0, level: 1, overlap: null, samples: 0, reason, ...extra });
    if (!rgba || !geom || !(geom.r > 0) || !field) return fail('no_frame');
    const shell = inst.refShell;
    // The reference shell must be OUTSIDE the mask: a shell that overlaps the
    // occulter disc would measure NASA's paint, not the corona.
    if (shell.lo < field.rIn) return fail('reference_shell_occulted');
    const R = geom.r * w, cx = geom.cx * w, cy = geom.cy * h;
    const stride = Math.max(1, Math.ceil(w / 512));
    const ped = [], ref = [], ovl = [];
    // The whole frame: the pedestal is read from everything outside the
    // occulter, corners included.
    for (let y = 0; y < h; y += stride) {
        const dy = (y - cy) / R;
        for (let x = 0; x < w; x += stride) {
            const dx = (x - cx) / R;
            const rho = Math.hypot(dx, dy);
            const inPed = rho >= field.rIn;
            const inRef = rho >= shell.lo && rho <= shell.hi;
            const inOvl = overlap && rho >= overlap.lo && rho <= overlap.hi;
            if (!inPed) continue;      // inside the occulter: NASA's paint, not sky
            const o = (y * w + x) * 4;
            const L = pixelValue(rgba[o], rgba[o + 1], rgba[o + 2]);
            if (inPed) ped.push(L);
            if (inRef) ref.push(L);
            if (inOvl) ovl.push(L);
        }
    }
    if (ped.length < REF_MIN_SAMPLES || ref.length < REF_MIN_SAMPLES) return fail('too_few_samples');
    ped.sort((a, b) => a - b);
    const floor = percentile(ped, PEDESTAL_PERCENTILE);
    const refMed = median(ref);
    const level = refMed - floor;
    const samples = ref.length;
    // A reference shell that does not rise above the frame's own dark level
    // is not a quiet corona, it is a frame with no corona in it — a blank
    // decode, a "no data" card. Dividing by it would turn JPEG ringing into
    // streamers (js/sun-offlimb.js REF_FLOOR, same argument, same number).
    if (!(level >= REF_FLOOR)) return fail('reference_shell_dark', { floor, ref: refMed, level, samples });
    const ovMed = ovl.length >= REF_MIN_SAMPLES ? Math.max(0, median(ovl) - floor) : null;
    return { ok: true, floor, ref: refMed, level, overlap: ovMed, samples, reason: null };
}

/**
 * Fit the two fields together. C2 hands over to C3 across C2's outer feather,
 * which only works if C3 is at full weight by the time that feather starts —
 * otherwise the two ramps cross below 1 and the seam is a dark ring. The real
 * overlap is narrow (C3's mask edge to C2's frame circle, ~1.5 R☉) and both
 * ends are MEASURED per frame, so the feathers cannot be fixed numbers: when
 * the overlap is narrower than the two ramps laid end to end, both are scaled
 * by the same factor to fit it exactly. Returns adjusted COPIES; null passes
 * through. With no overlap at all the fields are returned unchanged — the gap
 * between them is then real and is drawn as one.
 */
export function joinFields(f2, f3) {
    if (!f2 || !f3) return { f2: f2 || null, f3: f3 || null, squeezed: 1 };
    const room = f2.rOut - f3.rIn;
    const need = f3.featherIn + f2.featherOut;
    if (!(room > 0) || need <= room) return { f2, f3, squeezed: 1 };
    const k = room / need;
    return {
        f2: { ...f2, featherOut: f2.featherOut * k },
        f3: { ...f3, featherIn: f3.featherIn * k },
        squeezed: k,
    };
}

/**
 * The shell on which the two instruments are level-matched: where BOTH frames
 * carry sky — past the first half of C3's inner ramp (clear of the stray
 * light at its occulter edge) and inside all but the last quarter of C2's
 * outer one. It is a measurement region, not a drawing weight, so it need not
 * be confined to where either is at full weight. Null when narrower than
 * MIN_OVERLAP_RSUN.
 */
export const MIN_OVERLAP_RSUN = 0.3;
export function overlapShell(f2, f3) {
    if (!f2 || !f3) return null;
    const lo = f3.rIn + 0.5 * f3.featherIn, hi = f2.rOut - 0.25 * f2.featherOut;
    return hi - lo >= MIN_OVERLAP_RSUN ? { lo, hi } : null;
}

/**
 * Level-match C3 to C2 on their overlap. Both instruments see the same corona
 * there, so C3's normalised median must equal C2's:
 *     m3 / level3' = m2 / level2   ⇒   level3' = m3 · level2 / m2
 * Falls back to C3's own reference shell — and says so — when either overlap
 * median is missing or below the floor.
 */
export function crossCalibrate(cal2, cal3) {
    if (!cal3 || !cal3.ok) return { level: 1, basis: 'none' };
    if (cal2 && cal2.ok && cal2.overlap != null && cal3.overlap != null
        && cal2.overlap >= REF_FLOOR && cal3.overlap >= REF_FLOOR) {
        return { level: cal3.overlap * cal2.level / cal2.overlap, basis: 'c2-overlap' };
    }
    return { level: cal3.level, basis: 'own-shell' };
}

/** What the shader draws for a pixel of linear value L (pixelValue). PURE mirror of the GLSL. */
export function displayValue(L, floor, level, gamma = STRETCH_GAMMA) {
    return displayStretch(Math.max(L - floor, 0) / Math.max(level, VALUE_EPS), gamma);
}

/**
 * Where the occulter PYLON is, as a position angle (see positionAngleDeg), or
 * null when no sector is markedly darker than the rest. A DIAGNOSTIC for the
 * roll question in the module header: in a north-up C3 frame the pylon runs
 * to the south-east (PA ≈ 135°); an uncorrected inverted frame shows it at
 * ≈ 315°. Measured over an annulus just outside the occulter.
 */
export function pylonPositionAngle(rgba, w, h, geom, field) {
    if (!rgba || !field) return null;
    const R = geom.r * w, cx = geom.cx * w, cy = geom.cy * h;
    const lo = field.rIn + field.featherIn, hi = Math.min(field.rOut, lo * 2.2);
    const N = 72, sum = new Float64Array(N), cnt = new Uint32Array(N);
    for (let k = 0; k < N; k++) {
        const pa = (k + 0.5) * 360 / N;
        for (let i = 0; i < 24; i++) {
            const rho = lo + (hi - lo) * (i + 0.5) / 24;
            const p = fromPositionAngle(pa, rho);
            const x = Math.round(cx + p.x * R), y = Math.round(cy - p.y * R);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const o = (y * w + x) * 4;
            sum[k] += pixelValue(rgba[o], rgba[o + 1], rgba[o + 2]);
            cnt[k]++;
        }
    }
    const mean = Array.from(sum, (s, k) => (cnt[k] ? s / cnt[k] : NaN)).filter(Number.isFinite);
    if (mean.length < N) return null;
    const med = median(mean);
    let kMin = 0;
    for (let k = 1; k < N; k++) if (mean[k] < mean[kMin]) kMin = k;
    return mean[kMin] < 0.6 * med ? (kMin + 0.5) * 360 / N : null;
}

/** True when a measured pylon PA says the frame is upside down (≈ 315° instead of ≈ 135°). */
export function pylonSaysInverted(paDeg) {
    if (paDeg == null) return false;
    const d = Math.abs(((paDeg - 315 + 540) % 360) - 180);
    return d < 30;
}

// ── Label ──────────────────────────────────────────────────────────────────

function ageText(ageS) {
    if (!Number.isFinite(ageS)) return 'age unknown';
    if (ageS < 5400) return `${Math.round(ageS / 60)} min old`;
    return `${(ageS / 3600).toFixed(ageS < 36000 ? 1 : 0)} h old`;
}

/**
 * The suffix the #sun-provenance chip carries while this layer is on.
 * Never wrong (plan §5.1): names the instruments ACTUALLY drawn, says when one
 * is down, stale, or drawn on nominal geometry, and says when the layer is
 * present but faded by the camera rather than letting an empty sky imply a
 * quiet corona.
 */
export function coronagraphLabel(state) {
    if (!state || !state.enabled) return '';
    const insts = state.instruments || [];
    const drawn = insts.filter(i => i.drawn);
    if (!drawn.length) {
        if (insts.some(i => i.freshness === 'expired' && i.ok)) return ' · LASCO frames expired';
        return state.feedDown ? ' · LASCO feed down' : ' · LASCO loading';
    }
    let tag = `LASCO ${drawn.map(i => i.short).join('+')}`;
    const missing = insts.filter(i => !i.drawn).map(i => i.short);
    if (missing.length) tag += ` (${missing.join('+')} down)`;
    const stale = drawn.filter(i => i.freshness === 'stale');
    if (stale.length) tag += ` · ${ageText(Math.max(...stale.map(i => i.ageS)))}`;
    if (drawn.some(i => i.geometry === 'nominal')) tag += ' · nominal geometry';
    if (state.axisWeight <= 0.01) tag += ' (off-axis)';
    return ` · ${tag}`;
}

/** The one-paragraph disclosure for the chip tooltip. Numbers come from state. */
export function coronagraphNote(state) {
    if (!state || !state.enabled) return '';
    const drawn = (state.instruments || []).filter(i => i.drawn);
    if (!drawn.length) return ' Outer corona: no SOHO/LASCO frame is available, so nothing is drawn beyond the EUV annulus.';
    const parts = drawn.map(i =>
        `${i.label} ${i.rIn.toFixed(1)}–${i.rOut.toFixed(1)} R☉ (${ageText(i.ageS)}; centre ${i.geometry}, `
        + `occulter edge ${i.occulterSource}${i.levelBasis === 'c2-overlap' ? ', level matched to C2 on their overlap' : ''})`);
    const c2 = drawn.find(i => i.id === 'c2'), c3 = drawn.find(i => i.id === 'c3');
    const seam = c2 && c3 ? ` C2 is used wherever it has data and hands over to C3 across ${c2.featherOut.toFixed(1)} R☉.` : '';
    return ` Outer corona: ${parts.join(' and ')}, white-light coronagraph frames drawn on the plane of sky `
        + `(optically thin scattered light is a line-of-sight integral; it fades as you orbit away from the Sun–Earth line).${seam} `
        + 'Each frame is levelled against its own reference shell after subtracting its own dark level, then √-stretched for display; '
        + 'colours are the published product\'s. Nothing is drawn inside the occulter, over the pylon, or beyond the frame. '
        + `Scale is derived from the plate scale and the Sun's apparent radius from L1; roll is assumed north-up${state.rollDeg ? ` + ${state.rollDeg}°` : ''}.`;
}

// ── GLSL ───────────────────────────────────────────────────────────────────

/** Below this additive magnitude a fragment is discarded (nothing to add). */
export const DISCARD_EPS = 1e-4;
/** Guard on the level divisor and on the value a chromaticity is divided by. */
export const VALUE_EPS = 1e-5;

function glf(x) { const s = String(x); return /[.e]/.test(s) ? s : `${s}.0`; }

export const CORONAGRAPH_VERT = /* glsl */`
    varying vec2 vPlane;          // plane-of-sky position in R_sun
    void main() {
        // The ring is built in its own XY plane and oriented by
        // observerBasis(), so object-space xy IS plane-of-sky.
        vPlane = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const CORONAGRAPH_FRAG = /* glsl */`
    precision highp float;

    uniform sampler2D u_texC2;
    uniform vec3      u_geomC2;    // (cx, 1-cy, r) frame fractions, v up
    uniform float     u_onC2;
    uniform float     u_levelC2;   // reference level above the pedestal, linear
    uniform float     u_floorC2;   // the frame's own dark level, linear max-channel value
    uniform vec4      u_fieldC2;   // (rIn, featherIn, rOut, featherOut) in R_sun

    uniform sampler2D u_texC3;
    uniform vec3      u_geomC3;
    uniform float     u_onC3;
    uniform float     u_levelC3;
    uniform float     u_floorC3;
    uniform vec4      u_fieldC3;

    uniform float u_gain;
    uniform float u_stretch;       // display stretch exponent, see the module header
    uniform float u_axis;          // offAxisWeight()
    uniform vec2  u_roll;          // (cos, sin) of the sky-to-frame roll

    varying vec2 vPlane;

    float fieldW(float rho, vec4 f) {
        if (rho < f.x || rho >= f.z) return 0.0;
        return smoothstep(f.x, f.x + f.y, rho) * (1.0 - smoothstep(f.z - f.w, f.z, rho));
    }

    // One instrument's pixel: its OWN chromaticity (the browse product is
    // already colourised; level is corrected, hue is not), at a magnitude set
    // by the pedestal-subtracted, reference-normalised, stretched VALUE (the
    // max channel - see the module header for why it is not luminance).
    vec3 frameAt(sampler2D tex, vec3 geom, float lvl, float flr, vec2 p) {
        vec2 q  = vec2(u_roll.x * p.x - u_roll.y * p.y, u_roll.y * p.x + u_roll.x * p.y);
        vec2 uv = vec2(geom.x + q.x * geom.z, geom.y + q.y * geom.z);
        // Outside the frame there is no measurement. Never clamp-extend.
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
        vec3 cur = texture2D(tex, uv).rgb;
        float L = max(cur.r, max(cur.g, cur.b));
        float n = (L - flr) / max(lvl, ${glf(VALUE_EPS)});
        // At or below the frame's own dark level there is nothing to draw
        // (and pow of a non-positive base is undefined).
        if (n <= 0.0 || L <= ${glf(VALUE_EPS)}) return vec3(0.0);
        return cur * (pow(n, u_stretch) / L);
    }

    void main() {
        float rho = length(vPlane);
        float w2 = u_onC2 * fieldW(rho, u_fieldC2);
        // C2 wins wherever it has data: C3 is weighted by what C2 does not cover.
        float cover2 = (rho < u_fieldC2.x) ? 0.0
                     : u_onC2 * (1.0 - smoothstep(u_fieldC2.z - u_fieldC2.w, u_fieldC2.z, rho));
        float w3 = u_onC3 * fieldW(rho, u_fieldC3) * (1.0 - cover2);
        if ((w2 + w3) * u_axis <= 0.001) discard;
        vec3 col = vec3(0.0);
        if (w2 > 0.0) col += w2 * frameAt(u_texC2, u_geomC2, u_levelC2, u_floorC2, vPlane);
        if (w3 > 0.0) col += w3 * frameAt(u_texC3, u_geomC3, u_levelC3, u_floorC3, vPlane);
        col *= u_axis * u_gain;
        if (dot(col, col) < ${glf(DISCARD_EPS * DISCARD_EPS)}) discard;
        gl_FragColor = vec4(col, 1.0);   // additive blending: alpha is unused
    }
`;

// ── Browser half ───────────────────────────────────────────────────────────

/** Ring mesh extent, R☉. The shader's field uniforms do the real masking. */
export const MESH_R_INNER = 1.9;
export const MESH_R_OUTER = 30.5;

/**
 * The response header that says the proxy KNEW this channel. Required: the
 * solar image proxy answers an unknown channel with the HMI disc (its
 * historical default), so a deploy that predates `c2`/`c3` would hand this
 * layer a photosphere labelled `X-AIA-Channel: c2`. A frame without this
 * header is not a coronagraph frame.
 */
export const INSTRUMENT_HEADER = 'X-SOHO-Instrument';

/**
 * The observed outer corona as a scene object. Same lifecycle as SunOffLimb.
 *
 * @param {object} opts
 * @param {object} opts.THREE
 * @param {object} opts.scene
 * @param {string} [opts.base]        proxy base, default '/api/solar/aia'
 * @param {number} [opts.res]         512 | 1024 (default 1024)
 * @param {number} [opts.refreshMs]   re-fetch cadence (default 10 min)
 * @param {(state:object)=>void} [opts.onState]
 * @param {()=>number} [opts.now]     clock injection for tests
 * @param {number} [opts.rollDeg]     sky-to-frame roll (default 0: north-up)
 * @param {boolean} [opts.autoRoll]   apply 180° when the C3 pylon says the frame is inverted (default false)
 * @param {number} [opts.renderOrder] default 2 (just under the off-limb ring's 3)
 * @param {number} [opts.gain]
 * @param {string[]} [opts.instruments] subset of ['c2','c3']
 */
export class SunCoronagraph {
    constructor(opts) {
        this.THREE     = opts.THREE;
        this.scene     = opts.scene;
        this.base      = opts.base || '/api/solar/aia';
        this.res       = opts.res === 512 ? 512 : 1024;
        this.refreshMs = opts.refreshMs || 10 * 60 * 1000;
        this.onState   = opts.onState || (() => {});
        this.now       = opts.now || (() => Date.now());
        this.doc       = opts.doc || (typeof document !== 'undefined' ? document : null);
        this.renderOrder = opts.renderOrder ?? 2;
        this.rollDeg   = Number.isFinite(opts.rollDeg) ? opts.rollDeg : 0;
        this.autoRoll  = !!opts.autoRoll;
        this.gain      = Number.isFinite(opts.gain) ? opts.gain : DEFAULT_GAIN;
        this.ids       = (opts.instruments || CORONAGRAPH_IDS).filter(i => CORONAGRAPHS[i]);
        this.enabled   = false;
        this.frames    = new Map();       // id → frame record
        this.mesh      = null;
        this.uniforms  = null;
        this.b0Rad     = 0;
        this.axisWeight = 0;
        this.state = { enabled: false, feedDown: false, instruments: [], axisWeight: 0, b0Deg: 0, rollDeg: this.rollDeg, label: '', note: '' };
        this._timer = null;
        this._gen = 0;
        this._lastFresh = 0;
    }

    /** Build the ring mesh. Idempotent. */
    mount() {
        if (this.mesh) return this.mesh;
        const T = this.THREE;
        const geo = new T.RingGeometry(MESH_R_INNER, MESH_R_OUTER, 192, 12);
        const slot = () => ({ tex: { value: null }, geom: { value: new T.Vector3(0.5, 0.5, 0.05) }, on: { value: 0 },
                              level: { value: 1 }, floor: { value: 0 }, field: { value: new T.Vector4(2, 0.2, 3, 0.2) } });
        const a = slot(), b = slot();
        this.uniforms = {
            u_texC2: a.tex, u_geomC2: a.geom, u_onC2: a.on, u_levelC2: a.level, u_floorC2: a.floor, u_fieldC2: a.field,
            u_texC3: b.tex, u_geomC3: b.geom, u_onC3: b.on, u_levelC3: b.level, u_floorC3: b.floor, u_fieldC3: b.field,
            u_gain:    { value: this.gain },
            u_stretch: { value: STRETCH_GAMMA },
            u_axis:    { value: 0 },
            u_roll:    { value: new T.Vector2(1, 0) },
        };
        const mat = new T.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: CORONAGRAPH_VERT,
            fragmentShader: CORONAGRAPH_FRAG,
            transparent: true,
            blending: T.AdditiveBlending,
            // depthTest ON: the photosphere occludes the far half of the plane.
            // depthWrite OFF: an additive layer never shadows what follows it.
            depthTest: true,
            depthWrite: false,
            side: T.DoubleSide,
        });
        this.mesh = new T.Mesh(geo, mat);
        this.mesh.renderOrder = this.renderOrder;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.name = 'sun-coronagraph';
        this._orient();
        this.scene?.add(this.mesh);
        return this.mesh;
    }

    _orient() {
        if (!this.mesh) return;
        const T = this.THREE;
        const b = observerBasis(this.b0Rad);
        const m = new T.Matrix4().makeBasis(
            new T.Vector3(...b.right), new T.Vector3(...b.up), new T.Vector3(...b.normal));
        this.mesh.quaternion.setFromRotationMatrix(m);
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.mesh) this.mesh.visible = this.enabled && this._anyDrawn() && this.axisWeight > 0.001;
        this._emit();
        if (this.enabled) this.refresh();
    }

    setGain(g) { this.gain = Math.max(0, +g || 0); if (this.uniforms) this.uniforms.u_gain.value = this.gain; }

    /** Override the sky-to-frame roll (see the UNVERIFIED list in the header). */
    setRoll(deg) { this.rollDeg = Number.isFinite(+deg) ? +deg : 0; this._applyAll(); }

    start() {
        if (this._timer) return this;
        this._timer = setInterval(() => this.refresh(), this.refreshMs);
        return this;
    }

    stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

    _drawable(f) { return !!(f && f.ok && f.tex && f.freshness !== 'expired'); }
    _anyDrawn() { return this.ids.some(id => this._drawable(this.frames.get(id))); }

    /**
     * Per-frame. Only the off-axis weight changes with the camera; the plane
     * is pinned to the observer. Also re-ages the frames (cheaply, ≤ 0.1 Hz)
     * so a frame that goes stale or expires while the tab is open says so.
     */
    update(cameraPosition) {
        if (!this.uniforms || !this.mesh) return;
        const p = cameraPosition;
        const len = Math.hypot(p.x, p.y, p.z) || 1;
        const e = observerBasis(this.b0Rad).normal;
        const w = offAxisWeight((p.x * e[0] + p.y * e[1] + p.z * e[2]) / len);
        const t = this.now();
        if (t - this._lastFresh > 10_000) { this._lastFresh = t; if (this._ageFrames()) this._applyAll(); }
        if (Math.abs(w - this.axisWeight) > 1e-3) {
            this.axisWeight = w;
            this.state.axisWeight = w;
            this._emit();
        }
        this.uniforms.u_axis.value = w;
        this.mesh.visible = this.enabled && this._anyDrawn() && w > 0.001;
    }

    /** Recompute each frame's age + freshness. Returns true if any freshness class changed. */
    _ageFrames() {
        let changed = false;
        const t = this.now();
        for (const f of this.frames.values()) {
            if (!f.tex) continue;
            f.ageS = f.observedAt != null ? Math.max(0, (t - f.observedAt) / 1000) : NaN;
            // Unknown age is not "expired": the frame just arrived from the
            // proxy; it is drawn and the note says the age is unknown.
            const fr = f.observedAt != null ? lascoFreshness(f.ageS) : 'live';
            if (fr !== f.freshness) { f.freshness = fr; changed = true; }
        }
        return changed;
    }

    /** Fetch both instruments. Each fails independently. */
    async refresh(force = false) {
        if (!this.enabled) return null;
        if (!force && this.doc && this.doc.visibilityState === 'hidden') return null;
        const gen = ++this._gen;
        const bucket = Math.floor(this.now() / this.refreshMs);
        const results = await Promise.all(this.ids.map(id => this._fetch(id, bucket, force)));
        if (gen !== this._gen) return null;
        this.state.feedDown = results.every(r => !r);
        this._applyAll();
        return results;
    }

    async _fetch(id, bucket, force) {
        const prev = this.frames.get(id);
        if (!force && prev && prev.bucket === bucket) return prev.tex ? prev : null;
        const url = `${this.base}?channel=${encodeURIComponent(id)}&res=${this.res}&b=${bucket}`;
        try {
            const res = await fetch(url, { cache: 'default' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (parseLascoChannel(res.headers.get(INSTRUMENT_HEADER)) !== id) {
                throw new Error('not_a_coronagraph_frame (the proxy does not know this channel)');
            }
            if (!/^image\//i.test(res.headers.get('Content-Type') || '')) throw new Error('not_an_image');
            const observedAt = parseDate(res.headers.get('X-SDO-Observed-At'))
                            ?? parseDate(res.headers.get('Last-Modified'));
            const blob = await res.blob();
            const img  = await decodeImage(blob);
            const read = readCoronagraphFrame(img, this.doc);
            const when = new Date(observedAt ?? this.now());
            const geom = resolveCoronagraphGeometry(read.rgba, read.w, read.h, id, when);
            const occ  = read.rgba ? measureOcculter(read.rgba, read.w, read.h, geom, id) : null;
            const tex  = new this.THREE.Texture(img);
            tex.colorSpace = this.THREE.SRGBColorSpace;
            tex.minFilter = this.THREE.LinearFilter;   // no mips: a mipped frame bleeds the occulter disc outward
            tex.magFilter = this.THREE.LinearFilter;
            tex.wrapS = tex.wrapT = this.THREE.ClampToEdgeWrapping;
            tex.needsUpdate = true;
            if (prev?.tex) { try { prev.tex.dispose(); } catch (_) {} }
            const frame = {
                id, tex, observedAt, bucket, read, geom, occulter: occ,
                field: fieldFor(id, geom, occ),
                cal: null, ok: false, error: null, freshness: 'live', ageS: NaN,
                pylonPaDeg: null,
            };
            this.frames.set(id, frame);
            return frame;
        } catch (e) {
            // Keep the last good frame; an instrument that never loaded stays off.
            if (prev && prev.tex) { prev.error = String(e?.message || e); prev.bucket = bucket; return prev; }
            this.frames.set(id, { id, tex: null, ok: false, error: String(e?.message || e), bucket, freshness: 'expired', ageS: NaN });
            return null;
        }
    }

    /** Calibrate (jointly — the overlap shell needs both fields) and push uniforms. */
    _applyAll() {
        if (!this.uniforms) return;
        const u = this.uniforms;
        this._ageFrames();
        const f2 = this.frames.get('c2'), f3 = this.frames.get('c3');
        const has = f => !!(f && f.tex && f.read?.rgba);
        // Fit the two fields together first (the hand-over needs both), from
        // each frame's own un-joined field so a re-join never compounds.
        for (const f of [f2, f3]) if (f?.tex && f.geom) f.field = fieldFor(f.id, f.geom, f.occulter);
        if (has(f2) && has(f3) && f2.freshness !== 'expired' && f3.freshness !== 'expired') {
            const j = joinFields(f2.field, f3.field);
            f2.field = j.f2; f3.field = j.f3;
        }
        const ovl = has(f2) && has(f3) ? overlapShell(f2.field, f3.field) : null;
        for (const f of [f2, f3]) {
            if (!f || !f.tex) continue;
            if (!f.read?.rgba) { f.cal = null; f.ok = false; f.error = f.error || 'frame_unreadable'; continue; }
            f.cal = calibrateCoronagraph(f.read.rgba, f.read.w, f.read.h, f.geom, f.field, f.id, ovl);
            f.ok = f.cal.ok;
            if (!f.ok) f.error = f.cal.reason;
            f.pylonPaDeg = pylonPositionAngle(f.read.rgba, f.read.w, f.read.h, f.geom, f.field);
        }
        let roll = this.rollDeg;
        if (this.autoRoll && f3?.ok && pylonSaysInverted(f3.pylonPaDeg)) roll += 180;
        this.state.rollDeg = roll;
        u.u_roll.value.set(Math.cos(roll * DEG), Math.sin(roll * DEG));
        const x = f3?.ok ? crossCalibrate(this._drawable(f2) ? f2.cal : null, f3.cal) : null;
        let b0Src = null;
        for (const [suffix, f] of [['C2', f2], ['C3', f3]]) {
            const on = this._drawable(f) && this.ids.includes(f.id);
            u[`u_on${suffix}`].value = on ? 1 : 0;
            if (!on) continue;
            f.levelBasis = f.id === 'c3' ? x.basis : 'own-shell';
            f.levelUsed  = f.id === 'c3' ? x.level : f.cal.level;
            u[`u_tex${suffix}`].value = f.tex;
            u[`u_geom${suffix}`].value.set(f.geom.cx, 1 - f.geom.cy, f.geom.r);
            u[`u_level${suffix}`].value = f.levelUsed;
            u[`u_floor${suffix}`].value = f.cal.floor;
            u[`u_field${suffix}`].value.set(f.field.rIn, f.field.featherIn, f.field.rOut, f.field.featherOut);
            if (b0Src == null) b0Src = f.observedAt;
        }
        // B0 from the frame's own epoch, exactly as the disk and off-limb paths do.
        const eph = solarEphemeris(new Date(b0Src ?? this.now()));
        this.b0Rad = eph.b0Deg * DEG;
        this.state.b0Deg = eph.b0Deg;
        this._orient();
        if (this.mesh) this.mesh.visible = this.enabled && this._anyDrawn() && this.axisWeight > 0.001;
        this._emit();
    }

    _emit() {
        const instruments = this.ids.map(id => {
            const inst = CORONAGRAPHS[id], f = this.frames.get(id);
            return {
                id, label: inst.label, short: inst.short,
                ok: !!(f && f.ok),
                drawn: this._drawable(f),
                observedAt: f?.observedAt ?? null,
                ageS: f?.ageS ?? NaN,
                freshness: f?.tex ? f.freshness : 'expired',
                geometry: f?.geom?.source ?? null,
                geometryReason: f?.geom?.reason ?? null,
                ringRatio: f?.geom?.ringRatio ?? null,
                centre: f?.geom ? { cx: f.geom.cx, cy: f.geom.cy } : null,
                rSunFrac: f?.geom?.r ?? null,
                occulterRsun: f?.field?.occulterRsun ?? null,
                occulterSource: f?.field?.occulterSource ?? null,
                rIn: f?.field?.rIn ?? null, rOut: f?.field?.rOut ?? null,
                featherOut: f?.field?.featherOut ?? null,
                limitedBy: f?.field?.limitedBy ?? null,
                level: f?.levelUsed ?? f?.cal?.level ?? null,
                floor: f?.cal?.floor ?? null,
                levelBasis: f?.levelBasis ?? null,
                pylonPaDeg: f?.pylonPaDeg ?? null,
                error: f?.error ?? null,
            };
        });
        Object.assign(this.state, { enabled: this.enabled, instruments, axisWeight: this.axisWeight });
        this.state.label = coronagraphLabel(this.state);
        this.state.note  = coronagraphNote(this.state);
        try { this.onState(this.state); } catch (_) {}
    }

    getState() { return { ...this.state, instruments: this.state.instruments.map(i => ({ ...i })) }; }

    dispose() {
        this.stop();
        if (this.mesh) {
            this.scene?.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = null;
        }
        for (const f of this.frames.values()) { try { f.tex?.dispose(); } catch (_) {} }
        this.frames.clear();
    }
}

export { LASCO_WARN_S, LASCO_CRIT_S };

function parseDate(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

/**
 * Read the decoded frame's pixels at its NATIVE size (capped at 1024): the
 * limb circle is a one- or two-pixel line and C3's is 17 px across — neither
 * survives the 512² downsample the disk path's readFrame uses.
 */
export function readCoronagraphFrame(img, doc = (typeof document !== 'undefined' ? document : null), maxSize = 1024) {
    try {
        const size = Math.max(64, Math.min(maxSize, img.naturalWidth || img.width || maxSize));
        const c = doc.createElement('canvas');
        c.width = c.height = size;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, size, size);
        return { rgba: x.getImageData(0, 0, size, size).data, w: size, h: size };
    } catch (_) {
        return { rgba: null, w: 0, h: 0 };
    }
}

async function decodeImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('decode failed')); img.src = url; });
        return img;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
