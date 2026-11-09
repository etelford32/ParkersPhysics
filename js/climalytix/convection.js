/**
 * climalytix/convection.js — deep convection ingredients (plan §19 T6), PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * A thunderstorm needs three ingredients (Doswell, Brooks & Maddox 1996):
 * INSTABILITY (energy to release), MOISTURE (already inside CAPE — a dry
 * parcel has none) and LIFT to get a parcel through whatever lid sits on the
 * boundary layer. This module reads them from GFS's OWN parcel diagnostics —
 * surface-based CAPE, CIN and the lifted index, ingested, never recomputed
 * (we hold three pressure levels, not a sounding) — plus the lift the other
 * layers already compute (thermal w* from T4, orographic w from T2).
 *
 *   CAPE   ∫ g (T_v,parcel − T_v,env)/T_v,env dz above the LFC   (J/kg, ≥ 0)
 *   CIN    the same integral where it is NEGATIVE, below the LFC  (J/kg; GFS
 *          publishes it ≤ 0 — both sign conventions are read as the same lid)
 *   LI     T_env(500 hPa) − T_parcel(500 hPa)  (K; NEGATIVE = unstable)
 *
 * TWO CLOSED FORMS, both kinetic energy per unit mass (J/kg ≡ m²/s²):
 *   parcel ceiling  w_max = √(2·CAPE)     every joule turned into vertical
 *                   speed — no entrainment, no water loading, no pressure
 *                   drag: an UPPER BOUND (observed cores reach about half)
 *   lid speed       w_lid = √(2·|CIN|)    the vertical speed whose kinetic
 *                   energy alone would carry a parcel through the lid
 *
 * THE OUTLOOK IS AN INGREDIENTS CHECK, NOT A PROBABILITY (said everywhere it
 * is shown):
 *   none      CAPE < CAPE_MIN_JKG — nothing to release
 *   capped    a lid stronger than CIN_WEAK_JKG that no available lift
 *             can push through (½w² < |CIN|)
 *   possible  the lid is weak (or is broken by the lift) but no trigger
 *             reaches TRIGGER_MIN_MS — convection can start wherever air
 *             is pushed up, nothing here is pushing hard enough
 *   likely    a weak lid AND a trigger ≥ TRIGGER_MIN_MS
 * A CAPE-only reading (rank by the energy, ignore the lid) is the gate's
 * negative control: a capped 3000 J/kg column is not a storm. GFS's CIN is a
 * FORECAST — it already falls through the afternoon as the ground heats the
 * boundary layer — so the lid "breaking" in this outlook is the model's own
 * erosion of it, not a guess about heating.
 */

export const CAPE_MIN_JKG = 100;
/** |CIN| (J/kg) at or below which the lid is weak enough that any lift starts convection. */
export const CIN_WEAK_JKG = 25;
/** Vertical speed (m/s) counted as a trigger: the RASP 'moderate thermal' threshold (thermals.js). */
export const TRIGGER_MIN_MS = 1;
export const CAPE_BANDS = Object.freeze([
    { max: 1000, label: 'weak' }, { max: 2500, label: 'moderate' },
    { max: 4000, label: 'strong' }, { max: Infinity, label: 'extreme' },
]);
export const CIN_BANDS = Object.freeze([
    { max: CIN_WEAK_JKG, label: 'weak lid' }, { max: 100, label: 'moderate lid' },
    { max: 250, label: 'strong lid' }, { max: Infinity, label: 'very strong lid' },
]);
export const LI_BANDS = Object.freeze([
    { min: 0, label: 'stable' }, { min: -3, label: 'marginally unstable' },
    { min: -6, label: 'unstable' }, { min: -Infinity, label: 'very unstable' },
]);
export const CATEGORIES = Object.freeze(['none', 'capped', 'possible', 'likely']);

/** Parcel-theory updraft ceiling (m/s) from CAPE (J/kg): √(2·CAPE). An upper bound. */
export function parcelCeiling(capeJkg) {
    return capeJkg > 0 ? Math.sqrt(2 * capeJkg) : 0;
}
/** The vertical speed (m/s) whose kinetic energy equals the lid: √(2·|CIN|). Either sign convention. */
export function lidSpeed(cinJkg) {
    return Number.isFinite(cinJkg) ? Math.sqrt(2 * Math.abs(cinJkg)) : NaN;
}
export function capeBand(cape) {
    return Number.isFinite(cape) && cape >= CAPE_MIN_JKG ? CAPE_BANDS.find((b) => cape < b.max).label : 'none';
}
export function cinBand(cin) {
    return Number.isFinite(cin) ? CIN_BANDS.find((b) => Math.abs(cin) <= b.max).label : null;
}
/** Lifted index → words. NEGATIVE is unstable (the parcel is warmer than its surroundings at 500 hPa). */
export function liBand(li) {
    return Number.isFinite(li) ? LI_BANDS.find((b) => li >= b.min).label : null;
}

/**
 * The ingredients check at one point. `triggers` are the lifts the other
 * layers computed: [{ key, label, w }] (m/s; non-finite or ≤ 0 are ignored).
 * Returns { category, capeJkg, cinJkg, liK, wmax, lid, best, capeBand,
 * cinBand, liBand } or null when CAPE or CIN is missing.
 */
export function convectionOutlook({ capeJkg, cinJkg, liK = NaN, triggers = [] } = {}) {
    if (!Number.isFinite(capeJkg) || !Number.isFinite(cinJkg)) return null;
    const lid = lidSpeed(cinJkg);
    const best = triggers.filter((t) => Number.isFinite(t?.w) && t.w > 0)
        .reduce((a, t) => (!a || t.w > a.w ? t : a), null);
    let category;
    if (capeJkg < CAPE_MIN_JKG) category = 'none';
    else if (Math.abs(cinJkg) <= CIN_WEAK_JKG) category = best && best.w >= TRIGGER_MIN_MS ? 'likely' : 'possible';
    else category = best && best.w >= lid ? 'possible' : 'capped';
    return {
        category, capeJkg, cinJkg, liK, wmax: parcelCeiling(capeJkg), lid, best,
        capeBand: capeBand(capeJkg), cinBand: cinBand(cinJkg), liBand: liBand(liK),
    };
}

// ── Paint ─────────────────────────────────────────────────────────────────
/** CAPE (J/kg) at which the fill is full strength. */
export const CAPE_FULL_JKG = 3000;
const CAPE_STOPS = [[0.55, 0.62, 0.98], [0.78, 0.38, 0.92], [0.96, 0.24, 0.52]];
/** Heat-image painter for CAPE: transparent below CAPE_MIN_JKG, blue-violet → magenta, √ ramp. */
export function capePaint(cape, data, o) {
    if (!Number.isFinite(cape) || cape < CAPE_MIN_JKG) return;
    const f = Math.sqrt(Math.min(1, (cape - CAPE_MIN_JKG) / (CAPE_FULL_JKG - CAPE_MIN_JKG)));
    const x = f * (CAPE_STOPS.length - 1), i = Math.min(CAPE_STOPS.length - 2, Math.floor(x)), t = x - i;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * (CAPE_STOPS[i][c] + (CAPE_STOPS[i + 1][c] - CAPE_STOPS[i][c]) * t));
    data[o + 3] = Math.round(255 * (0.2 + 0.45 * f));
}
/** Outlook colours (category index → rgb 0‥1, alpha 0‥1). 'none' is transparent. */
// Validated with the dataviz skill's palette checker on the dimmed map ground
// (#1e242c, dark band, ALL pairs — on a map any two categories can touch):
// steel blue #7088c8 · amber #c4860a · magenta #d63a8a, worst CVD ΔE 10.0
// (deutan, blue↔magenta), normal-vision 22.3. The first version (slate grey,
// light amber, red) FAILED: grey read as no colour, the amber was too light
// for a dark ground, and amber↔red collapsed under deuteranopia once darkened.
export const OUTLOOK_COLORS = Object.freeze({
    none: null,
    capped: [[0.4392, 0.5333, 0.7843], 0.5],
    possible: [[0.7686, 0.5255, 0.0392], 0.6],
    likely: [[0.8392, 0.2275, 0.5412], 0.66],
});
/** Categorical painter: `v` is the CATEGORIES index (a flat band — never interpolated). */
export function outlookPaint(v, data, o) {
    const spec = Number.isFinite(v) ? OUTLOOK_COLORS[CATEGORIES[Math.round(v)]] : null;
    if (!spec) return;
    data[o] = Math.round(spec[0][0] * 255); data[o + 1] = Math.round(spec[0][1] * 255); data[o + 2] = Math.round(spec[0][2] * 255);
    data[o + 3] = Math.round(255 * spec[1]);
}
