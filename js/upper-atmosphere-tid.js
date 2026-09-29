/**
 * upper-atmosphere-tid.js — travelling ionospheric disturbances
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no three.js). One kernel for the two TID families, used by
 * BOTH the plasma field (js/upper-atmosphere-plasma-field.js — electron
 * density, so TEC) and the 630 nm red line (js/upper-atmosphere-airglow-
 * field.js), because a TID is one thing seen two ways: the red line is
 * dissociative recombination at the F-layer bottomside, so it follows the
 * same density wave, with more contrast (`redGain`) because it also sees the
 * wave's vertical lift of the layer.
 *
 *   LSTID  large-scale, storm-time. Launched by Joule heating and particle
 *          precipitation in the auroral oval and carried EQUATORWARD as
 *          atmospheric gravity waves: phase speed ~400–700 m/s, wavelength
 *          ~1000–3000 km, periods 30–180 min (Hunsucker 1982; Borries et al.
 *          2009). Fronts lie along magnetic latitude; they are launched from
 *          the oval centre the page's WFC cell engine uses
 *          (`ovalCenterMaglat` in js/ionosphere-cells.js — imported, it moves
 *          equatorward with Kp) and decay with distance. Amplitude rises with
 *          Kp above 3 (δN/N up to ~15 %).
 *   MSTID  medium-scale, night-time, mid-latitude. Wavelength ~100–400 km,
 *          ~50–150 m/s, fronts aligned NW–SE and travelling SOUTH-WEST in the
 *          northern hemisphere (mirror image, NW-ward, in the south) —
 *          the Perkins-instability morphology 630 nm imagers record as dark
 *          bands (Shiokawa et al. 2003; Kotake et al. 2006).
 *
 * WHAT IS MODEL AND WHAT IS NOT. Speeds, wavelengths, directions, latitude
 * bands and the Kp dependence are observed statistics. The wave field itself
 * — where a given crest is at a given instant — is ILLUSTRATIVE, not a TID
 * forecast (no model on this page resolves individual TIDs). The legend says
 * so, as it does for the gravity-wave ripples and the aurora folds.
 *
 * Phases are computed here in DOUBLE precision from the scene time and
 * handed to the shader as uniforms: ω·t on absolute time is ~10⁶ rad, far
 * beyond float32 (the airglow ripples' lesson). The MSTID zonal wavenumber
 * is an INTEGER so the pattern closes on itself at the date line.
 */

import { ovalCenterMaglat } from './ionosphere-cells.js';

const DEG = Math.PI / 180;
const R_E_KM = 6371;
const KM_PER_DEG = 111.195;

export const TID = Object.freeze({
    lstid: Object.freeze({
        lambdaKm: 1500, speedMs: 500,
        ampMax: 0.15, kpOnset: 3, kpFull: 8,
        decayKm: 3000,          // e-folding of amplitude with distance from the oval
        launchSoftKm: 300,      // amplitude ramps up over this much distance
        dayFloor: 0.6,          // day-side amplitude relative to night
    }),
    mstid: Object.freeze({
        lambdaKm: 250, speedMs: 100, amp: 0.12,
        latLoDeg: 20, latHiDeg: 50, edgeDeg: 6,   // |magnetic latitude| band
        azNorthDeg: 225,        // propagation azimuth in the NORTH (SW); SH is 315 (NW)
        refLatDeg: 35,          // latitude at which the zonal wavelength is exact
    }),
    redGain: 1.8,               // 630 nm contrast per unit δN/N
});

const smoothstep = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/** LSTID amplitude (δN/N) for a Kp. */
export function lstidAmp(kp) {
    const L = TID.lstid;
    return L.ampMax * smoothstep(L.kpOnset, L.kpFull, Number.isFinite(kp) ? kp : 0);
}

/** MSTID wave-vector: integer zonal wavenumber and meridional km⁻¹ (northern sign). */
export function mstidWave() {
    const M = TID.mstid;
    const k = 2 * Math.PI / M.lambdaKm;
    const az = M.azNorthDeg * DEG;
    const kE = k * Math.sin(az);                 // rad/km, + = eastward
    const kN = k * Math.cos(az);                 // rad/km, + = northward (north hemisphere)
    const m = Math.round(kE * R_E_KM * Math.cos(M.refLatDeg * DEG));
    return { m, kN, kE, k };
}

/** Phases (rad, in [0, 2π)) of both families at scene time tSec — double precision. */
export function tidPhases(tSec) {
    const wrap = (p) => { const q = p % (2 * Math.PI); return q < 0 ? q + 2 * Math.PI : q; };
    const L = TID.lstid, M = TID.mstid;
    return {
        lstid: wrap(2 * Math.PI * (L.speedMs / 1000) * tSec / L.lambdaKm),
        mstid: wrap(2 * Math.PI * (M.speedMs / 1000) * tSec / M.lambdaKm),
    };
}

/**
 * δN/N at a point. `night` is 0..1 (1 = dark), `mltHr` magnetic local time
 * (the mean-sun local time the fountain and cell engine use), `kp` the live
 * Kp. `pixelKm` is the drawn pixel footprint: the MSTID bands fade out once
 * a wavelength spans fewer than ~4 pixels (the airglow ripples' rule — a
 * wave drawn below the pixel scale is moiré, not a wave). Returns both
 * families and their sum.
 */
export function tidField({ magLatDeg, latDeg, lonDeg, mltHr, night = 1, kp = 2, phases = tidPhases(0), pixelKm = 0 }) {
    const L = TID.lstid, M = TID.mstid;
    // LSTID: distance equatorward of the oval centre, fronts along magnetic latitude.
    const oval = ovalCenterMaglat(mltHr, kp);
    const distKm = (oval - Math.abs(magLatDeg)) * KM_PER_DEG;
    let dL = 0;
    const aL = lstidAmp(kp);
    if (aL > 0 && distKm > 0) {
        const env = smoothstep(0, L.launchSoftKm, distKm) * Math.exp(-distKm / L.decayKm)
            * (L.dayFloor + (1 - L.dayFloor) * night);
        dL = aL * env * Math.cos(2 * Math.PI * distKm / L.lambdaKm - phases.lstid);
    }
    // MSTID: night, mid-latitude band, fronts NW–SE, travelling SW (NH) / NW (SH).
    const aml = Math.abs(magLatDeg);
    const band = smoothstep(M.latLoDeg - M.edgeDeg, M.latLoDeg, aml)
        * (1 - smoothstep(M.latHiDeg, M.latHiDeg + M.edgeDeg, aml));
    let dM = 0;
    if (band > 0 && night > 0) {
        const { m, kN } = mstidWave();
        const hemi = latDeg >= 0 ? 1 : -1;
        const phase = m * lonDeg * DEG + hemi * kN * R_E_KM * latDeg * DEG - phases.mstid;
        dM = M.amp * band * night * (1 - smoothstep(0.25, 0.5, pixelKm / M.lambdaKm)) * Math.cos(phase);
    }
    return { lstid: dL, mstid: dM, total: dL + dM, ovalDeg: oval };
}

// ─────────────────────────────────────────────────────────────────────────
// GLSL mirror — generated from TID and the imported oval law. Uniforms the
// host declares: uTidPhaseL, uTidPhaseM, uTidAmpL, uKp. NO BACKTICKS may
// appear in the text (it is spliced into a template literal).
// ─────────────────────────────────────────────────────────────────────────

const f = (x) => {
    const s = Number(x).toPrecision(9);
    return /[.eE]/.test(s) ? s : `${s}.0`;
};

export function tidGlsl() {
    const L = TID.lstid, M = TID.mstid;
    const { m, kN } = mstidWave();
    return [
        'uniform float uTidPhaseL;',
        'uniform float uTidPhaseM;',
        'uniform float uTidAmpL;',
        'uniform float uKp;',
        '// MIRROR OF js/ionosphere-cells.js ovalCenterMaglat',
        'float tidOval(float mltHr) {',
        '    return 70.0 - 1.8 * clamp(uKp, 0.0, 9.0) - 3.0 * cos(mltHr * 0.261799388);',
        '}',
        '// MIRROR OF upper-atmosphere-tid.js tidField: returns the total dN/N.',
        'float tidDelta(float magLat, float latDeg, float lonDeg, float mltHr, float night, float pixKm) {',
        `    float distKm = (tidOval(mltHr) - abs(magLat)) * ${f(KM_PER_DEG)};`,
        '    float dL = 0.0;',
        '    if (uTidAmpL > 0.0 && distKm > 0.0) {',
        `        float env = smoothstep(0.0, ${f(L.launchSoftKm)}, distKm) * exp(-distKm / ${f(L.decayKm)})`,
        `                  * (${f(L.dayFloor)} + ${f(1 - L.dayFloor)} * night);`,
        `        dL = uTidAmpL * env * cos(6.28318531 * distKm / ${f(L.lambdaKm)} - uTidPhaseL);`,
        '    }',
        '    float aml = abs(magLat);',
        `    float band = smoothstep(${f(M.latLoDeg - M.edgeDeg)}, ${f(M.latLoDeg)}, aml)`,
        `               * (1.0 - smoothstep(${f(M.latHiDeg)}, ${f(M.latHiDeg + M.edgeDeg)}, aml));`,
        '    float dM = 0.0;',
        '    if (band > 0.0 && night > 0.0) {',
        '        float hemi = latDeg >= 0.0 ? 1.0 : -1.0;',
        `        float ph = ${f(m)} * radians(lonDeg) + hemi * ${f(kN * R_E_KM)} * radians(latDeg) - uTidPhaseM;`,
        `        dM = ${f(M.amp)} * band * night * (1.0 - smoothstep(0.25, 0.5, pixKm * ${f(1 / M.lambdaKm)})) * cos(ph);`,
        '    }',
        '    return dL + dM;',
        '}',
    ].join('\n');
}

export const TID_GLSL = tidGlsl();
