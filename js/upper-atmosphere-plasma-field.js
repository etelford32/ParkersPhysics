/**
 * upper-atmosphere-plasma-field.js — how thick the plasma is, and why
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no three.js). The ionosphere's electron density, as a field,
 * built almost entirely from models that already live in this repo — this
 * module is the JOIN, not a new ionosphere model:
 *
 *   the vertical stack   js/ionosphere-descent.js columnProfile — the SAME
 *                        E / F1 / F2 stack (heights, day/night behaviour,
 *                        the negative-storm loss at high Kp) that
 *                        ring-current.html's descent inspector draws.
 *                        Its F2 day term is driven by mean local time only;
 *                        `zenithCorrection` swaps that for √cos χ so the
 *                        poles and the winter hemisphere come out thinner.
 *   the crests & bubbles js/ionosphere-fountain.js via FountainSampler — the
 *                        same model that draws the 630 nm arcs, so the TEC
 *                        crests and the red arcs are ONE feature.
 *   the electric field   js/ring-current-efield.js ConvectionEField, driven
 *                        here by Kp and the page's solar-wind VBs:
 *                        · its prompt-PENETRATION amplitude ΔA now drives the
 *                          fountain (a southward turning lifts the equatorial
 *                          crests — the super-fountain — and seeds bubbles);
 *                        · its TEARDROP plasmapause places the mid-latitude
 *                          ionospheric TROUGH on the night side (and the SAR
 *                          arcs, in the airglow field).
 *   the waves            js/upper-atmosphere-tid.js — the TIDs the red line
 *                        shares.
 *
 * Profiles are α-Chapman layers with separate bottom/top scale heights.
 * Everything is integrated only over the page's 80–2000 km band: GNSS TEC
 * also includes the plasmasphere up to ~20 000 km (typically +10–30 %,
 * more at night) — stated wherever TEC is printed.
 *
 * Units: densities in electrons m⁻³, TEC in TECU (10¹⁶ electrons m⁻²).
 */

import { columnProfile, dayFactor } from './ionosphere-descent.js';
import { ConvectionEField, boundaryL, mltToPhi } from './ring-current-efield.js';
import { magneticLatitude, R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM } from './upper-atmosphere-column.js';
import { FountainSampler, NO_ARCS, sunlitFraction, AIRGLOW_FIELD } from './upper-atmosphere-airglow-field.js';
import { tidField, tidPhases } from './upper-atmosphere-tid.js';

const DEG = Math.PI / 180;

export const PLASMA = Object.freeze({
    // Absolute scales for the shared stack's relative densities.
    nmF2RefM3: 1.0e12,      // columnProfile F2 density 1 at F10.7 150 (foF2 ≈ 9 MHz)
    nmF1RefM3: 2.5e11,
    nmERefM3: 1.5e11,       // columnProfile E density 1 (a midday NmE)
    f107Exp: 0.9,
    // Day:night contrast of the F2 peak. columnProfile's F2 term is
    // 0.65 + 0.35·day — a readability choice for the descent inspector's
    // per-layer bars, which puts midnight at 65 % of noon. Observed
    // mid-latitude NmF2 falls to ~25–40 % of its daytime value overnight
    // (Rishbeth & Garriott 1969; the IRI climatology), and a TEC map with a
    // 0.65 contrast has no night side. The column therefore uses
    // f2NightFloor + (1 − f2NightFloor)·√cos χ in its place — the same
    // stack's heights, storm loss and E/F1 terms, a stated departure in
    // this one term (`zenithCorrection`).
    f2NightFloor: 0.3,
    hmEKm: 108,             // columnProfile's own layer heights, repeated only
    hmF1Km: 180,            // for the α-Chapman shapes (tested against it)
    hE: 10, hF1: 30,        // scale heights (km)
    hF2Bottom: 45, hF2Top: 75,
    // Equatorial anomaly in TEC (from the fountain's crest intensity).
    eiaGain: 1.2, eiaWidthDeg: 5, eqDepletion: 0.3, eqWidthDeg: 5,
    // The main (mid-latitude) trough, just poleward of the plasmapause footprint.
    troughDepth: 0.6, troughOffsetDeg: 2, troughWidthDeg: 3,
    // Plasma bubbles in TEC.
    bubbleDepth: 0.5,
    // Where the shader evaluates the horizontal field along each half-ray.
    shellKm: 300,
    tecu: 1e16,
    // The display: slant TEC on a log scale over [1, 316] TECU. Vertical
    // TEC runs ~3 (night) to ~60 (the daytime crests); limb rays reach a few
    // hundred and saturate, which keeps the night side off the ramp's floor.
    tecLogMin: 0, tecLogMax: 2.5,
});

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const gauss = (x, w) => Math.exp(-(x / w) * (x / w));

/** Invariant latitude (deg) of an L-shell footprint. */
export function invariantLatDeg(L) {
    return Math.acos(Math.sqrt(1 / Math.max(1, L))) / DEG;
}

/** Mean-sun magnetic local time (h) at a longitude — the same one the fountain and the cell engine use. */
export function mltAt(lonDeg, utHours) {
    return (((utHours + lonDeg / 15) % 24) + 24) % 24;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. The vertical stack (shared) and its peaks
// ─────────────────────────────────────────────────────────────────────────

/** The F2 day term: f2NightFloor + (1 − floor)·√cos χ in place of the stack's 0.65 + 0.35·day (see PLASMA). */
export function zenithCorrection(cosChi, lstHr) {
    const fl = PLASMA.f2NightFloor;
    const want = fl + (1 - fl) * Math.sqrt(Math.max(0, cosChi));
    const had = 0.65 + 0.35 * dayFactor(lstHr);
    return want / had;
}

/** Layer peaks at a location, before the horizontal structure. */
export function stackPeaks({ lstHr, kp = 2, f107Sfu = 150, cosChi = null }) {
    const prof = columnProfile(lstHr, kp);
    const by = Object.fromEntries(prof.map((l) => [l.key, l]));
    const solar = Math.pow(Math.max(60, f107Sfu) / 150, PLASMA.f107Exp);
    const zc = Number.isFinite(cosChi) ? zenithCorrection(cosChi, lstHr) : 1;
    return {
        NmF2: PLASMA.nmF2RefM3 * by.F2.density * solar * zc,
        hmF2: by.F2.altKm,
        NmF1: PLASMA.nmF1RefM3 * by.F1.density * solar,
        NmE: PLASMA.nmERefM3 * by.E.density * solar,
        stormLoss: by.F2.note.includes('negative storm'),
    };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Horizontal structure
// ─────────────────────────────────────────────────────────────────────────

/** Equatorial anomaly in F2 density: crests at ±crestLat, a trough at the dip equator. */
export function eiaFactor(magLatDeg, crest, crestLatDeg) {
    const P = PLASMA, c = Math.max(0, crest);
    return (1 + P.eiaGain * c * (gauss(magLatDeg - crestLatDeg, P.eiaWidthDeg) + gauss(magLatDeg + crestLatDeg, P.eiaWidthDeg)))
        * (1 - P.eqDepletion * c * gauss(magLatDeg, P.eqWidthDeg));
}

/** Night-side main trough just poleward of the plasmapause footprint. */
export function troughFactor(magLatDeg, ppInvLatDeg, night) {
    const P = PLASMA;
    if (!Number.isFinite(ppInvLatDeg)) return 1;
    return 1 - P.troughDepth * night * gauss(Math.abs(magLatDeg) - (ppInvLatDeg + P.troughOffsetDeg), P.troughWidthDeg);
}

/** Plasma-bubble depletion (field-aligned wedge out to ±extent). */
export function bubbleTecFactor(magLatDeg, mask, extentDeg) {
    const inside = 1 - smoothstep(extentDeg - AIRGLOW_FIELD.bubbleEdgeDeg, extentDeg, Math.abs(magLatDeg));
    return 1 - PLASMA.bubbleDepth * clamp(mask, 0, 1) * inside;
}

/**
 * The plasma field at a location: layer peaks with every horizontal factor
 * applied, the factors themselves, and what dominates (for the probe).
 *   arcs          a FountainSampler.sampleAt result (NO_ARCS if none)
 *   ppInvLatDeg   plasmapause invariant latitude at this MLT (IonosphereDriver)
 */
export function plasmaFieldAt({
    latDeg, lonDeg, cosChi = 0, lstHr, mltHr = lstHr, kp = 2, f107Sfu = 150,
    arcs = NO_ARCS, ppInvLatDeg = null, phases = tidPhases(0),
}) {
    const peaks = stackPeaks({ lstHr, kp, f107Sfu, cosChi });
    const ml = magneticLatitude(latDeg, lonDeg);
    const night = 1 - sunlitFraction(PLASMA.shellKm, cosChi);
    const eia = eiaFactor(ml, arcs.crest, arcs.crestLatDeg);
    const trough = troughFactor(ml, ppInvLatDeg, night);
    const bubble = bubbleTecFactor(ml, arcs.bubble, arcs.bubbleExtentDeg);
    const tid = tidField({ magLatDeg: ml, latDeg, lonDeg, mltHr, night, kp, phases });
    const f2 = eia * trough * bubble * Math.max(0, 1 + tid.total);
    return {
        ...peaks, NmF2: peaks.NmF2 * f2, NmF2Base: peaks.NmF2,
        magLatDeg: ml, night, factors: { eia, trough, bubble, tid: tid.total, lstid: tid.lstid, mstid: tid.mstid },
        regime: plasmaRegime({ eia, trough, bubble, tid, ml, arcs }),
    };
}

function plasmaRegime({ eia, trough, bubble, tid, ml, arcs }) {
    if (bubble < 0.8) return 'plasma bubble';
    if (trough < 0.75) return 'mid-latitude trough';
    if (eia > 1.35 && Math.abs(ml) > 5) return 'equatorial crest';
    if (Math.abs(tid.lstid) > 0.03) return 'storm TID (large-scale)';
    if (Math.abs(tid.mstid) > 0.03) return 'night TID (medium-scale)';
    if (arcs.crest > 0.2 && Math.abs(ml) < 5) return 'equatorial trough';
    return 'quiet F region';
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Density, and its columns
// ─────────────────────────────────────────────────────────────────────────

/** α-Chapman layer: Nm at hm, scale height H (km). */
export function chapman(h, Nm, hm, H) {
    const z = (h - hm) / H;
    return Nm * Math.exp(0.5 * (1 - z - Math.exp(-z)));
}

/** Electron density (m⁻³) at altitude h for a plasmaFieldAt / stackPeaks result. */
export function neAt(h, p) {
    const P = PLASMA;
    const hF2 = h < p.hmF2 ? P.hF2Bottom : P.hF2Top;
    return chapman(h, p.NmF2, p.hmF2, hF2) + chapman(h, p.NmF1, P.hmF1Km, P.hF1) + chapman(h, p.NmE, P.hmEKm, P.hE);
}

/** Vertical TEC (TECU) over the page's 80–2000 km band (uniform trapezoid; see header). */
export function vtec(p, { steps = 1920 } = {}) {
    const h0 = MODEL_FLOOR_KM, h1 = MODEL_CEIL_KM, dh = (h1 - h0) / steps;
    let s = 0.5 * (neAt(h0, p) + neAt(h1, p));
    for (let i = 1; i < steps; i++) s += neAt(h0 + i * dh, p);
    return s * dh * 1000 / PLASMA.tecu;
}

/**
 * Slant TEC (TECU) along a scene ray (unit = R_E), with the field HELD per
 * half-ray at the point where it crosses the `shellKm` shell — the same
 * approximation the shader makes, so the page can be gated against this.
 * `fieldAtUnit(u)` returns a plasmaFieldAt result for a unit vector.
 */
export function slantTec({ ro, rd, fieldAtUnit, steps = 4000 }) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const rOut = 1 + MODEL_CEIL_KM / R_EARTH_KM;
    const b = dot(ro, rd), c = dot(ro, ro);
    const hit = (r) => { const disc = b * b - (c - r * r); return disc < 0 ? null : [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]; };
    const out = hit(rOut);
    if (!out || out[1] < 0) return 0;
    const t0 = Math.max(0, out[0]);
    let t1 = out[1];
    const pl = hit(1);
    if (pl && pl[0] > 0) t1 = Math.min(t1, pl[0]);
    if (t1 <= t0) return 0;
    const tMid = clamp(-b, t0, t1);
    const b2 = Math.max(0, c - b * b);
    const rs = 1 + PLASMA.shellKm / R_EARTH_KM;
    const sideField = (sgn) => {
        const disc = rs * rs - b2;
        let t = disc > 0 ? -b + sgn * Math.sqrt(disc) : -b;
        t = clamp(t, t0, t1);
        const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
        const n = Math.hypot(...p);
        return fieldAtUnit(p.map((v) => v / n));
    };
    const fNear = tMid > t0 ? sideField(-1) : null;
    const fFar = t1 > tMid ? sideField(1) : null;
    const dt = (t1 - t0) / steps;
    let s = 0;
    for (let i = 0; i < steps; i++) {
        const t = t0 + (i + 0.5) * dt;
        const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
        const h = (Math.hypot(...p) - 1) * R_EARTH_KM;
        if (h < MODEL_FLOOR_KM || h > MODEL_CEIL_KM) continue;
        s += neAt(h, t < tMid ? fNear : fFar);
    }
    return s * dt * R_EARTH_KM * 1000 / PLASMA.tecu;
}

/** The display transform: slant TEC (TECU) → 0..1 on the log scale. */
export function tecDisplay(tecu) {
    const P = PLASMA;
    return clamp((Math.log10(Math.max(tecu, 1e-6)) - P.tecLogMin) / (P.tecLogMax - P.tecLogMin), 0, 1);
}

// ─────────────────────────────────────────────────────────────────────────
// 4. The driver: the ring-current field and the fountain on the scene clock
// ─────────────────────────────────────────────────────────────────────────

/**
 * Advances ring-current-efield's ConvectionEField and the fountain together
 * on the page's scene clock, and samples the plasmapause into a longitude
 * table for the GPU:
 *   `sampler.data`  the fountain table (crest, crest lat, bubble mask, extent)
 *   `ppData`        R = plasmapause invariant latitude (deg) at each
 *                   longitude's CURRENT magnetic local time, G = that MLT
 * The penetration amplitude ΔA the field computes is handed to the fountain
 * over each step. A jump (backwards, or > the sampler's re-spin limit)
 * rebuilds both at equilibrium — shielded, ΔA = 0.
 */
export class IonosphereDriver {
    constructor({ width = AIRGLOW_FIELD.texWidth } = {}) {
        this.sampler = new FountainSampler({ width });
        this.ppData = new Float32Array(width * 4);
        this.width = width;
        this._ef = null;
        this._t = null;
        this._kp = 2;
        this._vbs = null;
    }

    /**
     * Advance to `simMs` with the live Kp and (optionally) VBs in mV/m.
     * Returns true when the tables changed. A driver change at the SAME
     * instant (a preset, a what-if — no time has passed for the currents to
     * respond) re-equilibrates: the shield is set to the new driver and ΔA
     * is 0. Penetration needs time to pass while the driver differs from
     * the shield, which is what it is.
     */
    advanceTo(simMs, { kp = this._kp, vbs = this._vbs } = {}) {
        if (!Number.isFinite(simMs)) return false;
        const kp1 = Number.isFinite(kp) ? kp : this._kp;
        const vbs1 = Number.isFinite(vbs) ? Math.max(0, vbs) : this._vbs;
        const changed = kp1 !== this._kp || vbs1 !== this._vbs;
        this._kp = kp1;
        this._vbs = vbs1;
        const maxStep = AIRGLOW_FIELD.maxStepHours * 3.6e6;
        const fresh = !this._ef || simMs < this._t - 1 || simMs - this._t > maxStep
            || (simMs === this._t && changed);
        if (fresh && this._ef && simMs === this._t) {
            // Same instant: re-equilibrate the field only; the fountain keeps
            // its history and takes the new Kp.
            this._ef = new ConvectionEField({ kp: this._kp, ...(Number.isFinite(this._vbs) ? { vbs: this._vbs } : {}) });
            this.sampler._kp = this._kp;
            this.sampler.fountain?.setDriver({ kp: this._kp });
            this._fillPlasmapause(simMs);
            return true;
        }
        if (fresh) {
            this._ef = new ConvectionEField({ kp: this._kp, ...(Number.isFinite(this._vbs) ? { vbs: this._vbs } : {}) });
        } else if (simMs > this._t) {
            this._ef.setDriver({ kp: this._kp, vbs: this._vbs ?? undefined });
            this._ef.step((simMs - this._t) / 1000);
        } else if (simMs === this._t) {
            return false;
        }
        this._t = simMs;
        const dA = fresh ? 0 : this._ef.state().dA;
        this.sampler.advanceTo(simMs, { kp: this._kp, dA });
        this._fillPlasmapause(simMs);
        return true;
    }

    /** ConvectionEField state: { A_drv, A_sh, dA, stagnationL }. */
    efield() { return this._ef ? this._ef.state() : null; }
    get timeMs() { return this._t; }

    _fillPlasmapause(simMs) {
        const A = this._ef.state().A_sh;
        const ut = ((simMs / 3.6e6) % 24 + 24) % 24;
        // The boundary depends on MLT only: solve it on a 96-point MLT grid
        // and interpolate (a bisection per texel would be 1440 of them).
        const N = 96, grid = new Float64Array(N + 1);
        for (let i = 0; i <= N; i++) grid[i] = invariantLatDeg(boundaryL(mltToPhi(24 * i / N), A));
        for (let x = 0; x < this.width; x++) {
            const lon = -180 + (x + 0.5) * (360 / this.width);
            const mlt = mltAt(lon, ut);
            const fi = mlt / 24 * N, i0 = Math.floor(fi), w = fi - i0;
            this.ppData[x * 4] = (1 - w) * grid[i0] + w * grid[Math.min(N, i0 + 1)];
            this.ppData[x * 4 + 1] = mlt;
        }
    }

    /** Plasmapause invariant latitude at a longitude (linear, wrapped — what the GPU reads). */
    plasmapauseAt(lonDeg) {
        const W = this.width, d = this.ppData;
        const fx = ((lonDeg + 180) / 360) * W - 0.5;
        const i0 = Math.floor(fx), w = fx - i0;
        const a = ((i0 % W) + W) % W, b = (((i0 + 1) % W) + W) % W;
        return (1 - w) * d[a * 4] + w * d[b * 4];
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. GLSL mirror — generated from PLASMA. Uniforms the host declares:
//    uPlasmapauseTex (IonosphereDriver.ppData), uArcsTex, uF107Solar (the
//    (F10.7/150)^0.9 factor), uKp, and the TID uniforms. The stack mirror
//    reproduces columnProfile's F2 / F1 / E terms; the browser gate compares
//    rendered slant TEC with `slantTec` above, which is what catches a drift.
//    NO BACKTICKS in the text (it is spliced into a template literal).
// ─────────────────────────────────────────────────────────────────────────

const g = (x) => {
    const s = Number(x).toPrecision(9);
    return /[.eE]/.test(s) ? s : `${s}.0`;
};

export function plasmaGlsl() {
    const P = PLASMA;
    return [
        'uniform float uF107Solar;',
        '// MIRROR OF ionosphere-descent.js columnProfile (F2, F1, E) + zenithCorrection.',
        '// Returns (NmF2, hmF2, NmF1, NmE) in units of 1e12 m^-3 and km.',
        'vec4 plStack(float lstHr, float cosChi) {',
        '    float day = max(0.0, cos((mod(lstHr, 24.0) - 12.0) * 0.261799388));',
        '    float k = clamp(uKp, 0.0, 9.0);',
        '    float stormLoss = 0.3 * max(0.0, (k - 5.0) / 4.0);',
        '    float f2 = max(0.05, (0.65 + 0.35 * day) * (1.0 - stormLoss));',
        `    float zc = (${g(P.f2NightFloor)} + ${g(1 - P.f2NightFloor)} * sqrt(max(0.0, cosChi))) / (0.65 + 0.35 * day);`,
        '    float hm = floor(255.0 + 55.0 * (1.0 - day) + 6.0 * k + 0.5);',
        `    return vec4(${g(P.nmF2RefM3 / 1e12)} * f2 * zc * uF107Solar, hm,`,
        `                ${g(P.nmF1RefM3 / 1e12)} * 0.5 * day * uF107Solar,`,
        `                ${g(P.nmERefM3 / 1e12)} * (0.12 + 0.68 * day) * uF107Solar);`,
        '}',
        '// MIRROR OF eiaFactor * troughFactor * bubbleTecFactor (the TID factor is applied by the caller).',
        'float plHorizontal(float lonDeg, float magLat, float night) {',
        '    vec2 tc = vec2((lonDeg + 180.0) / 360.0, 0.5);',
        '    vec4 arcs = texture2D(uArcsTex, tc);',
        '    vec4 pp = texture2D(uPlasmapauseTex, tc);',
        '    float c = max(arcs.r, 0.0);',
        `    float dN = (magLat - arcs.g) / ${g(P.eiaWidthDeg)};`,
        `    float dS = (magLat + arcs.g) / ${g(P.eiaWidthDeg)};`,
        `    float dE = magLat / ${g(P.eqWidthDeg)};`,
        `    float eia = (1.0 + ${g(P.eiaGain)} * c * (exp(-dN * dN) + exp(-dS * dS)))`,
        `              * (1.0 - ${g(P.eqDepletion)} * c * exp(-dE * dE));`,
        `    float dT = (abs(magLat) - (pp.r + ${g(P.troughOffsetDeg)})) / ${g(P.troughWidthDeg)};`,
        `    float trough = 1.0 - ${g(P.troughDepth)} * night * exp(-dT * dT);`,
        `    float inside = 1.0 - smoothstep(arcs.a - ${g(AIRGLOW_FIELD.bubbleEdgeDeg)}, arcs.a, abs(magLat));`,
        `    float bub = 1.0 - ${g(P.bubbleDepth)} * clamp(arcs.b, 0.0, 1.0) * inside;`,
        '    return eia * trough * bub;',
        '}',
        '// MIRROR OF chapman / neAt, in 1e12 m^-3; p = plStack() with p.x already horizontal.',
        'float plNe(float h, vec4 p) {',
        `    float H2 = h < p.y ? ${g(P.hF2Bottom)} : ${g(P.hF2Top)};`,
        '    float z2 = (h - p.y) / H2;',
        `    float z1 = (h - ${g(P.hmF1Km)}) / ${g(P.hF1)};`,
        `    float z0 = (h - ${g(P.hmEKm)}) / ${g(P.hE)};`,
        '    return p.x * exp(0.5 * (1.0 - z2 - exp(-z2)))',
        '         + p.z * exp(0.5 * (1.0 - z1 - exp(-z1)))',
        '         + p.w * exp(0.5 * (1.0 - z0 - exp(-z0)));',
        '}',
        '// Slant TEC -> display 0..1 (log10 over the kernel\'s TECU range) and the colour.',
        'float plDisplay(float tecu) {',
        `    return clamp((log2(max(tecu, 1e-6)) * 0.301029996 - ${g(P.tecLogMin)}) / ${g(P.tecLogMax - P.tecLogMin)}, 0.0, 1.0);`,
        '}',
        '// A sequential ramp (inferno-like, its floor lifted to a deep violet',
        '// so the thin night-side plasma still reads), dark to bright.',
        'vec3 plColour(float t) {',
        '    vec3 c0 = vec3(0.06, 0.03, 0.22);',
        '    vec3 c1 = vec3(0.34, 0.06, 0.43);',
        '    vec3 c2 = vec3(0.73, 0.21, 0.33);',
        '    vec3 c3 = vec3(0.98, 0.55, 0.04);',
        '    vec3 c4 = vec3(0.99, 1.00, 0.64);',
        '    if (t < 0.25) return mix(c0, c1, t * 4.0);',
        '    if (t < 0.5) return mix(c1, c2, (t - 0.25) * 4.0);',
        '    if (t < 0.75) return mix(c2, c3, (t - 0.5) * 4.0);',
        '    return mix(c3, c4, (t - 0.75) * 4.0);',
        '}',
    ].join('\n');
}

export const PLASMA_GLSL = plasmaGlsl();

/** The same ramp in JS (legend swatches, and the gate's inverse). */
export const PLASMA_RAMP = Object.freeze([
    [0.06, 0.03, 0.22], [0.34, 0.06, 0.43], [0.73, 0.21, 0.33], [0.98, 0.55, 0.04], [0.99, 1.00, 0.64],
]);
export function plasmaColour(t) {
    const x = clamp(t, 0, 1) * 4, i = Math.min(3, Math.floor(x)), w = x - i;
    return PLASMA_RAMP[i].map((c, k) => c + (PLASMA_RAMP[i + 1][k] - c) * w);
}
