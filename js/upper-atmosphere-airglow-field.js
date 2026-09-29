/**
 * upper-atmosphere-airglow-field.js — where on the planet the airglow is
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no three.js). `AIRGLOW_LAYERS` in upper-atmosphere-column.js
 * says WHAT emits and at what HEIGHT; until this module every band was the
 * same everywhere on the planet, day and night — an even ring. The real
 * airglow is the most structured thing in the band. This module owns the
 * horizontal structure, in two groups, and the volume shader mirrors it
 * (`AIRGLOW_FIELD_GLSL`, generated HERE from the same constants — the kernel
 * is the oracle, and there is no second copy of a number to drift).
 *
 *   MESOSPHERIC group (OH Meinel, Na D, O₂, the O(¹S) green line; 85–100 km)
 *     Chemiluminescent from recombination that runs day and night, so it is
 *     held at its nightglow level on both sides — no day/night factor.
 *     Its horizontal structure is GRAVITY-WAVE ripples (tens to hundreds of
 *     km). THE RIPPLES ARE SYMBOLIC: a fixed deterministic set of waves, not
 *     a wave forecast; amplitude is the observed ~5–20 % intensity
 *     perturbation. Disclosed wherever they are drawn, like the aurora folds.
 *
 *   RED LINE (O(¹D) 630 nm, F region ~250 km)
 *     DAY: photoelectron impact and photodissociation make the 630 nm
 *       DAYGLOW ~20× the nightglow (Solomon & Abreu 1989 give ~1–3×10³ vs
 *       ~50–100 photons cm⁻³ s⁻¹ at the peak; the low end is used). "Day" is
 *       SUNLIT AT ALTITUDE, not the ground terminator: a point is dark when
 *       the sunward ray to it grazes below the EUV screening height
 *       (`screenKm`), so at 250 km the dayglow runs ~12° past the ground
 *       terminator, as it does.
 *     NIGHT: the equatorial ionization anomaly. After sunset the red line
 *       sits in two arcs either side of the magnetic dip equator (the
 *       Appleton crests), cut by dark north–south PLASMA BUBBLES. Both come
 *       from `js/ionosphere-fountain.js` — the SAME model ring-current.html
 *       draws (E×B drift with the pre-reversal enhancement feeds the crests;
 *       Rayleigh–Taylor growth after sunset spawns the bubbles on
 *       gravity-wave crests) — imported, never re-derived. The fountain's
 *       prompt-penetration input ΔA comes from ring-current-efield's
 *       shielding model when the page drives it (`IonosphereDriver` in
 *       js/upper-atmosphere-plasma-field.js); without it, ΔA = 0.
 *     TIDs: the red line is dissociative recombination at the F-layer
 *       bottomside, so the travelling ionospheric disturbances in the plasma
 *       (js/upper-atmosphere-tid.js — the ONE copy, shared with the TEC
 *       view) modulate it at `TID.redGain` × δN/N: storm-time LSTIDs running
 *       equatorward from the oval, night-time MSTID bands travelling
 *       south-west. ILLUSTRATIVE, disclosed like the ripples.
 *     STORMS: SAR arcs — stable, pure 630 nm arcs at ~400 km where the ring
 *       current overlaps the plasmasphere, i.e. on the PLASMAPAUSE footprint,
 *       a few degrees equatorward of the auroral oval. Onset above Kp 4,
 *       kR-class at Kp 8–9. The footprint is the TEARDROP plasmapause of
 *       ring-current-efield (per MLT: the dusk bulge sits further poleward)
 *       when the page supplies it (`ppInvLatDeg`, the GPU's
 *       uPlasmapauseTex); `plasmapauseL` (Carpenter & Anderson 1992) is the
 *       fallback. The existing `apGain` on the red and green lines (global
 *       brightening with Ap) is unchanged.
 *
 * ONE EXPOSURE FOR DAY AND NIGHT. The render shows dayglow and nightglow in
 * one log stretch. No camera could; the legend says so.
 *
 * Everything here that the shader mirrors is a pure function of (position,
 * sun, Kp, the fountain sample, wave phases) — `airglowFieldAt` is the
 * oracle, and the probe prints its numbers.
 */

import {
    AIRGLOW_LAYERS, R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM, magneticLatitude,
} from './upper-atmosphere-column.js';
import { plasmapauseL } from './upper-atmosphere-aurora-physics.js';
import { IonosphereFountain, N_CELLS, CELL_DEG, hash1 } from './ionosphere-fountain.js';
import { TID, tidField, TID_GLSL } from './upper-atmosphere-tid.js';

const DEG = Math.PI / 180;

export const AIRGLOW_FIELD = Object.freeze({
    // ── day / night (red line) ────────────────────────────────────────────
    screenKm: 100,          // EUV screening height: a sun ray grazing below it is spent
    screenSoftKm: 25,       // half-width of the shadow edge at altitude
    redDayGain: 20,         // 630 nm dayglow / nightglow at the sub-solar point
    redDayFloor: 0.25,      // dayglow shape at a sunlit χ ≥ 90° (grazing production)
    // ── equatorial arcs (red line, night) ─────────────────────────────────
    eiaGain: 4.0,           // crest brightness above background at crest intensity 1:
                            // observed arcs run ~3–5× the mid-latitude nightglow
    eiaWidthDeg: 4.0,       // e-folding half-width of each crest in magnetic latitude
    // ── plasma bubbles ────────────────────────────────────────────────────
    bubbleDepth: 0.85,      // fraction of the red line removed inside a bubble
    bubbleHalfWidthDeg: 0.9,// e-folding half-width in longitude: ~170 km FWHM (EPBs are ~100–200 km)
    bubbleEdgeDeg: 2.0,     // softness of the field-aligned wedge's latitude edge
    // ── SAR arcs (red line, storms) ───────────────────────────────────────
    sarPeakKm: 400,
    sarFwhmKm: 200,
    sarWidthDeg: 2.5,
    sarGainMax: 12,         // peak VER over the red nightglow peak, at Kp 9
    sarKpOnset: 4,
    sarKpFull: 9,
    // ── gravity-wave ripples (SYMBOLIC; mesospheric group only) ───────────
    gwAmpMeso: 0.18,        // peak intensity perturbation inside a packet (observed 5–20 %)
    gwCount: 8,
    gwPacketDeg: 18,        // angular radius of a packet (a cap, and its antipode)
    gwPacketCoreDeg: 7,     // full amplitude inside this radius
    // ── where the shader evaluates the field along each half-ray ─────────
    mesoShellKm: 92,        // centroid of the visible mesospheric band
    redShellKm: 250,        // the red line's peak
    // ── the fountain sample handed to the GPU ─────────────────────────────
    texWidth: 1440,         // 0.25° of longitude per texel
    spinupHours: 36,        // the crests integrate over a day; start well before
    maxStepHours: 6,        // a jump longer than this re-spins rather than integrates
});

/** Band groups. Anything not listed (the geocorona) is invisible and unmodulated. */
export const MESO_IDS = Object.freeze(['oh-meinel', 'na-d', 'o2-atm', 'o-green']);
export const RED_IDS = Object.freeze(['o-red']);
const RED_LAYER = AIRGLOW_LAYERS.find((L) => L.id === 'o-red');
export const RED_RGB = Object.freeze([...RED_LAYER.rgb]);

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const gauss = (x, w) => Math.exp(-(x / w) * (x / w));

// ─────────────────────────────────────────────────────────────────────────
// 1. Altitude profiles, split by group
// ─────────────────────────────────────────────────────────────────────────

function layerVer(L, altKm, f107Sfu, ap) {
    const sigma = L.fwhmKm / 2.3548;
    const d = (altKm - L.peakKm) / sigma;
    const gain = 1 + L.apGain * Math.max(0, ap) + L.f107Gain * (f107Sfu - 150);
    return L.ver * Math.exp(-0.5 * d * d) * Math.max(0, gain);
}

/**
 * Visible volume emission at one altitude, SPLIT into the groups the field
 * modulates separately. With every factor at 1, meso + red is exactly
 * `airglowAt(altKm).visibleTotal` (gated). `sarUnit` is the SAR-arc profile
 * at unit gain (its peak VER equals the red line's nightglow peak).
 */
export function airglowGroupsAt(altKm, { f107Sfu = 150, ap = 15 } = {}) {
    let meso = 0;
    const mesoRgb = [0, 0, 0];
    for (const L of AIRGLOW_LAYERS) {
        if (!MESO_IDS.includes(L.id)) continue;
        const vv = layerVer(L, altKm, f107Sfu, ap) * L.visibleFraction;
        meso += vv;
        for (let k = 0; k < 3; k++) mesoRgb[k] += vv * L.rgb[k];
    }
    if (meso > 0) for (let k = 0; k < 3; k++) mesoRgb[k] /= meso;
    const red = layerVer(RED_LAYER, altKm, f107Sfu, ap) * RED_LAYER.visibleFraction;
    const s = AIRGLOW_FIELD.sarFwhmKm / 2.3548;
    const ds = (altKm - AIRGLOW_FIELD.sarPeakKm) / s;
    const sarUnit = RED_LAYER.ver * RED_LAYER.visibleFraction * Math.exp(-0.5 * ds * ds);
    return { meso, mesoRgb, red, sarUnit };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Day and night
// ─────────────────────────────────────────────────────────────────────────

/** Solar zenith angle (deg) at a point, from the sub-solar point. */
export function solarZenithDeg(latDeg, lonDeg, subSolarLatDeg, subSolarLonDeg) {
    const c = Math.sin(latDeg * DEG) * Math.sin(subSolarLatDeg * DEG)
        + Math.cos(latDeg * DEG) * Math.cos(subSolarLatDeg * DEG) * Math.cos((lonDeg - subSolarLonDeg) * DEG);
    return Math.acos(clamp(c, -1, 1)) / DEG;
}

/**
 * Fraction of a point at `altKm` that is SUNLIT, given cos χ there. On the
 * night side the sunward ray passes the Earth's axis at radius (R+h)·sin χ;
 * below R + screenKm it has crossed the EUV-absorbing layer and is spent.
 * The max() with a ramp on cos χ keeps it continuous across χ = 90° for
 * points below the screen (they fade with grazing incidence rather than
 * switching off at the terminator).
 */
export function sunlitFraction(altKm, cosChi) {
    const F = AIRGLOW_FIELD;
    const sinChi = Math.sqrt(Math.max(0, 1 - cosChi * cosChi));
    const hGraze = cosChi < 0 ? (R_EARTH_KM + altKm) * sinChi - R_EARTH_KM : altKm;
    const lit = smoothstep(F.screenKm - F.screenSoftKm, F.screenKm + F.screenSoftKm, hGraze);
    return Math.max(lit, smoothstep(0, 0.1, cosChi));
}

/** 630 nm dayglow shape: √cos χ over the sunlit disc, a floor past it. */
export function redDayShape(cosChi) {
    const F = AIRGLOW_FIELD;
    return F.redDayFloor + (1 - F.redDayFloor) * Math.sqrt(Math.max(0, cosChi));
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Night structure of the red line
// ─────────────────────────────────────────────────────────────────────────

/** Equatorial-arc factor: two crests at ±crestLat of magnetic latitude. */
export function eiaFactor(magLatDeg, crest, crestLatDeg) {
    const F = AIRGLOW_FIELD;
    const c = Math.max(0, crest);
    return 1 + F.eiaGain * c * (gauss(magLatDeg - crestLatDeg, F.eiaWidthDeg)
        + gauss(magLatDeg + crestLatDeg, F.eiaWidthDeg));
}

/**
 * Plasma-bubble factor: a bubble is a field-aligned depleted flux tube, so
 * at the airglow shell it is a north–south wedge across BOTH crests, out to
 * ±extentDeg of magnetic latitude (where the tube's apex maps down).
 */
export function bubbleFactor(magLatDeg, mask, extentDeg) {
    const F = AIRGLOW_FIELD;
    const inside = 1 - smoothstep(extentDeg - F.bubbleEdgeDeg, extentDeg, Math.abs(magLatDeg));
    return 1 - F.bubbleDepth * clamp(mask, 0, 1) * inside;
}

/** Invariant latitude (deg) of an L-shell's footprint on the ground. */
export function invariantLatDeg(L) {
    return Math.acos(Math.sqrt(1 / Math.max(1, L))) / DEG;
}

/** SAR-arc latitude (deg) and gain for a Kp: on the plasmapause footprint. */
export function sarArc(kp) {
    const F = AIRGLOW_FIELD;
    const k = clamp((kp - F.sarKpOnset) / (F.sarKpFull - F.sarKpOnset), 0, 1);
    return { latDeg: invariantLatDeg(plasmapauseL(kp)), gain: F.sarGainMax * Math.pow(k, 1.5) };
}

/** SAR weight at a magnetic latitude (either hemisphere). */
export function sarWeight(magLatDeg, sar) {
    return sar.gain * gauss(Math.abs(magLatDeg) - sar.latDeg, AIRGLOW_FIELD.sarWidthDeg);
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Gravity-wave ripples — SYMBOLIC
// ─────────────────────────────────────────────────────────────────────────
//
// Plane waves in 3-D restricted to the sphere: cos(2π·R·(u·d)/λ − φ(t)).
// Locally that is a plane wave of wavelength ≥ λ, and around the direction
// d itself it forms concentric rings — which is what convective (thunder-
// storm) gravity waves look like in airglow imagers, so the degeneracy is
// kept rather than hidden. EACH wave lives in its OWN PACKET — a spherical
// cap (and its antipode) ~18° across — so the field is separate patches,
// each with one direction. Two earlier versions gated the waves with broad
// COSINE envelopes (one shared, then one each); a cos(k·u) envelope is a
// set of bands that wrap the planet, the bands crossed everywhere, and from
// orbit the waves read as a waffle lattice no airglow imager has recorded.
// The red line carries no ripples here (MSTIDs are real, but they are a
// different phenomenon and this is a marker, not a model). Phases advance
// with a horizontal phase speed of 40–80 m/s, computed in double precision
// on the CPU (`gwPhases`) and handed to the shader as uniforms — ω·t on
// absolute time is ~10³ rad and float32 cannot hold it.

function _gwTable() {
    const waves = [];
    const unit = (a, b) => {
        const z = 2 * a - 1, ph = 2 * Math.PI * b, r = Math.sqrt(1 - z * z);
        return [r * Math.cos(ph), z, r * Math.sin(ph)];
    };
    const cosOuter = Math.cos(AIRGLOW_FIELD.gwPacketDeg * DEG);
    const cosCore = Math.cos(AIRGLOW_FIELD.gwPacketCoreDeg * DEG);
    for (let i = 0; i < AIRGLOW_FIELD.gwCount; i++) {
        const lambdaKm = 30 * Math.pow(10, hash1(i * 17.13 + 5.31));      // 30–300 km, log-uniform
        const speedMs = 40 + 40 * hash1(i * 7.77 + 1.9);
        const centre = unit(hash1(i * 13.1 + 9.2), hash1(i * 2.7 + 6.6));
        // The wave's direction must lie ALONG the surface inside its packet
        // or it degenerates into a bullseye there: take it tangent at the
        // packet centre.
        let d = unit(hash1(i * 3.91 + 0.7), hash1(i * 5.23 + 2.1));
        const dc = d[0] * centre[0] + d[1] * centre[1] + d[2] * centre[2];
        d = [d[0] - dc * centre[0], d[1] - dc * centre[1], d[2] - dc * centre[2]];
        const dn = Math.hypot(...d) || 1;
        waves.push({
            dir: d.map((v) => v / dn), lambdaKm, speedMs, centre,
            amp: Math.pow(lambdaKm / 300, 0.35),          // mildly red; the longest ≈ 1
            phase0: 2 * Math.PI * hash1(i * 11.3 + 4.4),
        });
    }
    const top = Math.max(...waves.map((w) => w.amp));
    for (const w of waves) w.amp /= top;                  // peak of the strongest wave = 1
    /** Packet weight of wave w at u: a soft cap about ±centre. */
    const envAt = (w, u) => smoothstep(cosOuter, cosCore,
        Math.abs(u[0] * w.centre[0] + u[1] * w.centre[1] + u[2] * w.centre[2]));
    return Object.freeze({ waves: Object.freeze(waves), envAt, cosOuter, cosCore });
}
export const GW = _gwTable();

/** Per-wave phases at scene time `tSec` (seconds, any epoch; double precision). */
export function gwPhases(tSec) {
    return GW.waves.map((w) => {
        const omega = 2 * Math.PI * (w.speedMs / 1000) / w.lambdaKm;     // rad/s
        const p = (w.phase0 - omega * tSec) % (2 * Math.PI);
        return p < 0 ? p + 2 * Math.PI : p;
    });
}

/**
 * Ripple field at unit vector u: zero-mean, peak ≈ 1 inside a packet, 0
 * outside every packet. `pixelKm` fades every wave shorter than ~4 pixels (it would only
 * alias); 0 = draw them all.
 */
export function gwField(u, phases, pixelKm = 0) {
    let s = 0;
    GW.waves.forEach((w, i) => {
        const att = 1 - smoothstep(0.25, 0.5, pixelKm / w.lambdaKm);
        if (att <= 0) return;
        const x = R_EARTH_KM * (u[0] * w.dir[0] + u[1] * w.dir[1] + u[2] * w.dir[2]) / w.lambdaKm;
        s += w.amp * att * GW.envAt(w, u) * Math.cos(2 * Math.PI * x - phases[i]);
    });
    return s;
}

// ─────────────────────────────────────────────────────────────────────────
// 5. The fountain, sampled for the GPU
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drives `IonosphereFountain` on the page's scene clock and samples it into
 * a longitude table the shader reads as a texture:
 *   R = crest intensity, G = crest magnetic latitude (deg),
 *   B = bubble mask (0..1), A = bubble latitude extent (deg).
 * The crests integrate over a day (τ ≈ 2.5 h), so a fresh sampler, or one
 * whose clock jumped backwards or by more than `maxStepHours`, re-spins the
 * model from `spinupHours` earlier. The fountain is deterministic per
 * sim-date, so a re-spin to the same instant gives the same state.
 */
export class FountainSampler {
    constructor({ width = AIRGLOW_FIELD.texWidth } = {}) {
        this.width = width;
        this.data = new Float32Array(width * 4);
        this._f = null;
        this._t = null;
        this._kp = 2;
    }

    /**
     * Advance to `simMs`. Returns true when the table changed. `dA` is the
     * prompt-penetration amplitude (kV/R_E², js/ring-current-efield.js; > 0
     * undershielding lifts the fountain, < 0 suppresses it), held over the
     * step; 0 — the default — is the fountain's quiet climatology. A
     * re-spin integrates its whole spin-up at dA = 0: the penetration
     * history before the page opened is not known.
     */
    advanceTo(simMs, { kp = this._kp, dA = 0 } = {}) {
        if (!Number.isFinite(simMs)) return false;
        this._kp = Number.isFinite(kp) ? kp : this._kp;
        const pen = Number.isFinite(dA) ? dA : 0;
        const F = AIRGLOW_FIELD;
        const fresh = !this._f || simMs < this._t - 1 || simMs - this._t > F.maxStepHours * 3.6e6;
        if (fresh) {
            this._f = new IonosphereFountain({ kp: this._kp });
            const t0 = simMs - F.spinupHours * 3.6e6;
            this._t = t0;
            // The fountain substeps at ≤ 60 s internally; hand it hour chunks.
            while (this._t < simMs) {
                const next = Math.min(simMs, this._t + 3.6e6);
                this._f.tick(next, (next - this._t) / 1000);
                this._t = next;
            }
        } else if (simMs > this._t) {
            this._f.setDriver({ kp: this._kp });
            this._f.tick(simMs, (simMs - this._t) / 1000, { dA: pen });
            this._t = simMs;
        } else {
            return false;
        }
        this._fill();
        return true;
    }

    get fountain() { return this._f; }
    get timeMs() { return this._t; }

    _fill() {
        const f = this._f, W = this.width, d = this.data;
        const F = AIRGLOW_FIELD;
        const bubbles = f.allBubbles();
        for (let x = 0; x < W; x++) {
            const lon = -180 + (x + 0.5) * (360 / W);
            // Cell centres sit at −180 + (i + ½)·CELL_DEG; interpolate with wrap.
            const fc = (lon + 180) / CELL_DEG - 0.5;
            const i0 = Math.floor(fc), w = fc - i0;
            const a = f.cells[(i0 % N_CELLS + N_CELLS) % N_CELLS];
            const b = f.cells[((i0 + 1) % N_CELLS + N_CELLS) % N_CELLS];
            d[x * 4] = (1 - w) * a.crest + w * b.crest;
            d[x * 4 + 1] = (1 - w) * f.crestLatDeg(a) + w * f.crestLatDeg(b);
            let mask = 0, ext = 0;
            for (const bub of bubbles) {
                let dl = lon - bub.lonDeg;
                dl -= 360 * Math.round(dl / 360);
                const m = bub.strength * bub.fade * gauss(dl, F.bubbleHalfWidthDeg);
                if (m > mask) { mask = m; ext = bub.latExtentDeg; }
            }
            d[x * 4 + 2] = mask;
            d[x * 4 + 3] = ext;
        }
    }

    /** The table at a longitude, linearly interpolated with wrap — what the GPU's linear filter reads. */
    sampleAt(lonDeg) {
        const W = this.width, d = this.data;
        let fx = ((lonDeg + 180) / 360) * W - 0.5;
        const i0 = Math.floor(fx), w = fx - i0;
        const a = ((i0 % W) + W) % W, b = (((i0 + 1) % W) + W) % W;
        const at = (k) => (1 - w) * d[a * 4 + k] + w * d[b * 4 + k];
        return { crest: at(0), crestLatDeg: at(1), bubble: at(2), bubbleExtentDeg: at(3) };
    }
}

/** Geographic latitude on meridian `lonDeg` where magnetic latitude is `magLatDeg`. */
export function latForMagLat(magLatDeg, lonDeg) {
    let lo = -89.9, hi = 89.9;
    for (let k = 0; k < 60; k++) {
        const m = 0.5 * (lo + hi);
        if (magneticLatitude(m, lonDeg) < magLatDeg) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
}

/**
 * Where to go and look at the arcs: the evening meridian (local solar time
 * 19.5–23 h) with the strongest crest in a sampler's table, and the
 * geographic latitude of its NORTHERN crest. Null when no crest is worth
 * the trip (< 0.15) — e.g. the fountain has not run, or the evening is quiet.
 */
export function brightestEveningArc(sampler, subSolarLonDeg) {
    if (!sampler?.data) return null;
    let best = null;
    for (let lon = -180; lon < 180; lon += 1) {
        const lst = ((12 + (lon - subSolarLonDeg) / 15) % 24 + 24) % 24;
        if (lst < 19.5 || lst > 23) continue;
        const a = sampler.sampleAt(lon);
        if (!best || a.crest > best.crest) best = { lonDeg: lon, lstHr: lst, ...a };
    }
    if (!best || best.crest < 0.15) return null;
    return { ...best, latDeg: latForMagLat(best.crestLatDeg, best.lonDeg) };
}

/** A neutral fountain sample: no crests, no bubbles (daytime, or no model). */
export const NO_ARCS = Object.freeze({ crest: 0, crestLatDeg: 12, bubble: 0, bubbleExtentDeg: 0 });

// ─────────────────────────────────────────────────────────────────────────
// 6. The field — the oracle the shader mirrors
// ─────────────────────────────────────────────────────────────────────────

/**
 * Horizontal factors at one location. `cosChi` is the cosine of the solar
 * zenith angle there; `arcs` a `FountainSampler.sampleAt` result.
 *   meso    multiplier on the mesospheric group
 *   redNight  multiplier on the red line where it is dark
 *   sar     SAR-arc weight (× the SAR profile, dark side only)
 * The per-ALTITUDE part (sunlit or not, day shape) is `redFactorAt`.
 */
export function airglowFieldAt({
    latDeg, lonDeg, u = null, cosChi = 0, kp = 2, arcs = NO_ARCS,
    phases = gwPhases(0), pixelKm = 0,
    ppInvLatDeg = null, tidPhases = null, utHours = null,
}) {
    const F = AIRGLOW_FIELD;
    const ml = magneticLatitude(latDeg, lonDeg);
    const uu = u ?? [Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG), Math.sin(latDeg * DEG),
        -Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG)];
    const gw = gwField(uu, phases, pixelKm);
    const meso = Math.max(0, 1 + F.gwAmpMeso * gw);
    // TIDs (optional: need the TID phases and the UT for magnetic local time).
    let tid = 0;
    if (tidPhases && Number.isFinite(utHours)) {
        const mltHr = (((utHours + lonDeg / 15) % 24) + 24) % 24;
        const night = 1 - sunlitFraction(F.redShellKm, cosChi);
        tid = tidField({ magLatDeg: ml, latDeg, lonDeg, mltHr, night, kp, phases: tidPhases }).total;
    }
    const redNight = eiaFactor(ml, arcs.crest, arcs.crestLatDeg)
        * bubbleFactor(ml, arcs.bubble, arcs.bubbleExtentDeg)
        * Math.max(0, 1 + TID.redGain * tid);
    const sa = sarArc(kp);
    const sarLatDeg = Number.isFinite(ppInvLatDeg) ? ppInvLatDeg : sa.latDeg;
    const sar = sarWeight(ml, { gain: sa.gain, latDeg: sarLatDeg });
    return { magLatDeg: ml, cosChi, gw, meso, redNight, sar, sarLatDeg, tid };
}

/** Red-line multiplier at one altitude, from the location's factors. */
export function redFactorAt(altKm, field) {
    const lit = sunlitFraction(altKm, field.cosChi);
    return {
        lit,
        red: lit * AIRGLOW_FIELD.redDayGain * redDayShape(field.cosChi) + (1 - lit) * field.redNight,
        sar: (1 - lit) * field.sar,
    };
}

/** Visible emission at one altitude at one location (the field applied). */
export function airglowAtLocation(altKm, field, { f107Sfu = 150, ap = 15 } = {}) {
    const g = airglowGroupsAt(altKm, { f107Sfu, ap });
    const r = redFactorAt(altKm, field);
    const meso = g.meso * field.meso;
    const red = g.red * r.red + g.sarUnit * r.sar;
    const visibleTotal = meso + red;
    const rgb = [0, 0, 0];
    if (visibleTotal > 0) {
        for (let k = 0; k < 3; k++) rgb[k] = (meso * g.mesoRgb[k] + red * RED_RGB[k]) / visibleTotal;
    }
    return { visibleTotal, rgb, meso, red, lit: r.lit };
}

/**
 * Limb column through a location, with the field HELD at the tangent point
 * (sunlit-ness still evaluated per altitude) — the same approximation the
 * shader makes per half-ray, and what the probe prints.
 */
export function airglowColumnAt({
    tangentAltKm, field, f107Sfu = 150, ap = 15, steps = 64, ceilKm = MODEL_CEIL_KM,
}) {
    const hT = Math.max(MODEL_FLOOR_KM, tangentAltKm);
    if (hT >= ceilKm) return { brightness: 0, rgb: [0, 0, 0], red: 0, meso: 0 };
    const rT = R_EARTH_KM + hT, rC = R_EARTH_KM + ceilKm;
    const sMax = Math.sqrt(Math.max(0, rC * rC - rT * rT));
    const ds = sMax / steps;
    let total = 0, red = 0, meso = 0;
    const rgb = [0, 0, 0];
    let prev = airglowAtLocation(hT, field, { f107Sfu, ap });
    for (let i = 1; i <= steps; i++) {
        const h = Math.sqrt(rT * rT + (ds * i) ** 2) - R_EARTH_KM;
        const cur = airglowAtLocation(h, field, { f107Sfu, ap });
        total += 0.5 * (cur.visibleTotal + prev.visibleTotal) * ds;
        red += 0.5 * (cur.red + prev.red) * ds;
        meso += 0.5 * (cur.meso + prev.meso) * ds;
        for (let k = 0; k < 3; k++) {
            rgb[k] += 0.5 * (cur.visibleTotal * cur.rgb[k] + prev.visibleTotal * prev.rgb[k]) * ds;
        }
        prev = cur;
    }
    if (total > 0) for (let k = 0; k < 3; k++) rgb[k] /= total;
    return { brightness: 2 * total, rgb, red: 2 * red, meso: 2 * meso };
}

/** Name what is shaping the red line at a location (for the probe card). */
export function redLineRegime(field, altKm = 250) {
    const r = redFactorAt(altKm, field);
    if (r.lit > 0.5) return 'dayglow';
    if (field.sar > 0.5) return 'SAR arc';
    if (field.redNight < 0.6) return 'plasma bubble';
    if (field.redNight > 1.6) return 'equatorial arc';
    return 'nightglow';
}

/**
 * The renderer's altitude tables. The march fetches TWO texels per sample
 * and must keep doing so — a third fetch measured +70 % frame time on a
 * software rasteriser (228 → 385 ms at the floor rung) — so the groups ride
 * in textures that are fetched anyway:
 *   `buildAirglowLUT`      1 row × bins: mesospheric rgb, visible rate / max
 *   `packRedIntoFieldLUT`  the (altitude × T∞) density table's spare G and B
 *                          channels: red-line rate / max, SAR unit / max
 *                          (they depend on altitude only; every T∞ row gets
 *                          the same value). The red line is 90 km wide and
 *                          SAR 200 km, so that table's ~20 km bins hold them;
 *                          the 10 km green band stays on its own finer table.
 * Both use the SAME maximum as the column LUT's airglow row
 * (`buildAtmosphereLUT(...).airglowMax`), so at every factor = 1 meso + red
 * is that row and the display stretch is unchanged.
 */
function _airglowMax(f107Sfu, ap, bins, minKm, maxKm) {
    let max = 1e-9;
    for (let i = 0; i < bins; i++) {
        const g = airglowGroupsAt(minKm + (maxKm - minKm) * (i / (bins - 1)), { f107Sfu, ap });
        max = Math.max(max, g.meso + g.red);
    }
    return max;
}

export function buildAirglowLUT({
    f107Sfu = 150, ap = 15, bins = 128,
    minKm = MODEL_FLOOR_KM, maxKm = MODEL_CEIL_KM,
} = {}) {
    const max = _airglowMax(f107Sfu, ap, bins, minKm, maxKm);
    const data = new Float32Array(bins * 4);
    for (let i = 0; i < bins; i++) {
        const g = airglowGroupsAt(minKm + (maxKm - minKm) * (i / (bins - 1)), { f107Sfu, ap });
        data.set([g.mesoRgb[0], g.mesoRgb[1], g.mesoRgb[2], g.meso / max], i * 4);
    }
    return { data, bins, rows: 1, minKm, maxKm, airglowMax: max };
}

/**
 * Write the red-line and SAR rates into a `buildFieldLUT` table's G and B
 * channels (in place; R — the density — is untouched). `airglowMax` must be
 * `buildAirglowLUT`'s so the two tables share one normalisation.
 */
export function packRedIntoFieldLUT(field, { f107Sfu = 150, ap = 15, airglowMax }) {
    const { data, altBins, tinfBins, minKm, maxKm } = field;
    for (let i = 0; i < altBins; i++) {
        const g = airglowGroupsAt(minKm + (maxKm - minKm) * (i / (altBins - 1)), { f107Sfu, ap });
        const red = g.red / airglowMax, sar = g.sarUnit / airglowMax;
        for (let j = 0; j < tinfBins; j++) {
            const k = (j * altBins + i) * 4;
            data[k + 1] = red;
            data[k + 2] = sar;
        }
    }
    return field;
}

// ─────────────────────────────────────────────────────────────────────────
// 7. The GLSL mirror — generated from the constants above
// ─────────────────────────────────────────────────────────────────────────
//
// Straight-line code, no arrays (GLSL ES 1.00 has no array constructors),
// every number interpolated from AIRGLOW_FIELD / GW. Uniforms the host
// declares: uArcsTex (the FountainSampler table, linear filter, repeat in
// s), uPlasmapauseTex (IonosphereDriver.ppData: R = the plasmapause footprint
// in invariant latitude at each longitude's current MLT), uGwPhase0..7,
// uSarGain, uUtHours, uMagPole, and TID_GLSL's uniforms (TID_GLSL is emitted
// FIRST, here). NO BACKTICKS may appear in the text below — it is spliced
// into a template literal.

const f = (x) => {
    const s = Number(x).toPrecision(9);
    return /[.eE]/.test(s) ? s : `${s}.0`;
};

export function airglowFieldGlsl() {
    const F = AIRGLOW_FIELD;
    const waves = GW.waves.map((w, i) => [
        `    e = smoothstep(${f(GW.cosOuter)}, ${f(GW.cosCore)}, abs(dot(u, vec3(${w.centre.map(f).join(', ')}))));`,
        `    if (e > 0.0) {`,
        `        x = ${f(R_EARTH_KM / w.lambdaKm)} * dot(u, vec3(${w.dir.map(f).join(', ')}));`,
        `        s += ${f(w.amp)} * e * (1.0 - smoothstep(0.25, 0.5, pixKm * ${f(1 / w.lambdaKm)}))`
        + ` * cos(6.28318531 * x - uGwPhase${i});`,
        '    }',
    ].join('\n')).join('\n');
    return [
        TID_GLSL,
        'uniform sampler2D uArcsTex;',
        'uniform sampler2D uPlasmapauseTex;',
        GW.waves.map((_, i) => `uniform float uGwPhase${i};`).join(' '),
        'uniform float uSarGain;',
        'uniform float uUtHours;',
        '',
        '// MIRROR OF upper-atmosphere-airglow-field.js sunlitFraction',
        'float agLit(float altKm, float cosChi) {',
        '    float sinChi = sqrt(max(0.0, 1.0 - cosChi * cosChi));',
        `    float hGraze = cosChi < 0.0 ? (${f(R_EARTH_KM)} + altKm) * sinChi - ${f(R_EARTH_KM)} : altKm;`,
        `    float lit = smoothstep(${f(F.screenKm - F.screenSoftKm)}, ${f(F.screenKm + F.screenSoftKm)}, hGraze);`,
        '    return max(lit, smoothstep(0.0, 0.1, cosChi));',
        '}',
        '// MIRROR OF redDayShape, times redDayGain',
        'float agRedDay(float cosChi) {',
        `    return ${f(F.redDayGain)} * (${f(F.redDayFloor)} + ${f(1 - F.redDayFloor)} * sqrt(max(0.0, cosChi)));`,
        '}',
        '// The same test with the per-half-ray terms hoisted out of the march:',
        '// pre = (sin chi, night side ? 1 : 0, the cos-chi floor, the dayglow factor).',
        'vec4 agShadowPre(float cosChi) {',
        '    return vec4(sqrt(max(0.0, 1.0 - cosChi * cosChi)), cosChi < 0.0 ? 1.0 : 0.0,',
        '                smoothstep(0.0, 0.1, cosChi), agRedDay(cosChi));',
        '}',
        'float agLitPre(float altKm, vec4 pre) {',
        `    float hGraze = pre.y > 0.5 ? (${f(R_EARTH_KM)} + altKm) * pre.x - ${f(R_EARTH_KM)} : altKm;`,
        `    return max(smoothstep(${f(F.screenKm - F.screenSoftKm)}, ${f(F.screenKm + F.screenSoftKm)}, hGraze), pre.z);`,
        '}',
        '// Mean-sun magnetic local time at a longitude (the fountain\'s and the cell engine\'s).',
        'float agMlt(float lonDeg) {',
        '    return mod(uUtHours + lonDeg / 15.0 + 48.0, 24.0);',
        '}',
        '// MIRROR OF gwField (SYMBOLIC ripples)',
        'float agGw(vec3 u, float pixKm) {',
        '    float s = 0.0;',
        '    float x;',
        '    float e;',
        waves,
        '    return s;',
        '}',
        '// MIRROR OF airglowFieldAt: meso factor, red-night factor, SAR weight.',
        '// lonDeg is geographic longitude, magLat magnetic latitude, both degrees;',
        '// tid the TID dN/N there (tidDelta; 0 on the mesospheric shell).',
        'vec3 agField(float lonDeg, float magLat, float gw, float tid) {',
        '    vec2 tcL = vec2((lonDeg + 180.0) / 360.0, 0.5);',
        '    vec4 arcs = texture2D(uArcsTex, tcL);',
        // pow() of a negative base is undefined in GLSL: square by hand.
        `    float dN = (magLat - arcs.g) / ${f(F.eiaWidthDeg)};`,
        `    float dS = (magLat + arcs.g) / ${f(F.eiaWidthDeg)};`,
        `    float eia = 1.0 + ${f(F.eiaGain)} * max(arcs.r, 0.0) * (exp(-dN * dN) + exp(-dS * dS));`,
        `    float inside = 1.0 - smoothstep(arcs.a - ${f(F.bubbleEdgeDeg)}, arcs.a, abs(magLat));`,
        `    float bub = 1.0 - ${f(F.bubbleDepth)} * clamp(arcs.b, 0.0, 1.0) * inside;`,
        `    float redNight = eia * bub * max(0.0, 1.0 + ${f(TID.redGain)} * tid);`,
        '    float sarLat = texture2D(uPlasmapauseTex, tcL).r;',
        `    float dA = (abs(magLat) - sarLat) / ${f(F.sarWidthDeg)};`,
        '    float sar = uSarGain * exp(-dA * dA);',
        `    return vec3(max(0.0, 1.0 + ${f(F.gwAmpMeso)} * gw), redNight, sar);`,
        '}',
    ].join('\n');
}

export const AIRGLOW_FIELD_GLSL = airglowFieldGlsl();

/** The red line's display colour, as a GLSL vec3 literal. */
export const RED_RGB_GLSL = `vec3(${RED_RGB.map(f).join(', ')})`;
