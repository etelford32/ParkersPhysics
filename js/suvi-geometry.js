/**
 * suvi-geometry.js — GOES/SUVI as its OWN instrument, not an AIA alias
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3e. PURE — no fetch, no DOM, no
 * ambient time — so `/api/solar/aia` and `node tests/suvi-geometry.mjs` run
 * the same code. Read js/sun-offlimb.js's header first: this module exists to
 * feed that layer, and every honesty rule there applies here unchanged.
 *
 * ── Why SUVI at all: a measured hole in what we already draw ──────────────
 *
 * js/sun-offlimb.js draws the observed corona on the 1.0–1.6 R☉ annulus. Its
 * shader is careful never to clamp-extend a border texel across the sky —
 * outside the frame it returns vec3(0.0). That is correct, and it means the
 * layer silently draws NOTHING wherever the frame does not reach.
 *
 * An SDO/AIA browse frame does not reach. AIA is 0.6″/px over 4096 px, so the
 * half-frame is 1229″ = 1.280 R☉ ON AXIS and 1.811 R☉ into the corners. The
 * annulus we ask for is a circle of radius 1.6; a square of half-width 1.280
 * does not contain it. MEASURED (tests/suvi-geometry.mjs computes it in closed
 * form): an AIA frame supplies 65.9 % of the 1.0–1.6 R☉ annulus. The missing
 * third is not noise — it is four lobes on the axes, cut off at 1.280 while
 * the diagonals run out to 1.811, so the layer renders a clover and the
 * viewer reads the shape of the DETECTOR as the shape of the corona.
 *
 * SUVI is 2.5″/px over 1280 px: the half-frame is 1600″ = 1.667 R☉ on axis,
 * 2.358 R☉ into the corners. 1.667 > 1.6, so SUVI supplies 100.0 % of the
 * same annulus — every azimuth, to the outer edge. That is the whole argument
 * for this module, and it is why SUVI is the right feed for off-limb
 * prominences and flare loops specifically: they are the structures that live
 * exactly where AIA's frame stops.
 *
 * ── This is a LAYER, not a swap ──────────────────────────────────────────
 *
 * The near-side disk stays SDO. AIA is 0.6″/px against SUVI's 2.5″/px — four
 * times the plate scale — so swapping the disk's frame would trade a sharp
 * observation for a soft one to gain field of view the disk does not use.
 * SUVI is added as a SOURCE for the off-limb annulus, where field of view is
 * the whole point and 2.5″/px still resolves a prominence. Both sources stay
 * live; the layer names which one it drew.
 *
 * ── The vantage is the same, and that is what makes this drop in ─────────
 *
 * The plane-of-sky construction in js/sun-offlimb.js is pinned to the
 * Sun–Earth line and assumes the frame's observer is at Earth. GOES is in
 * geostationary orbit: 42 164 km from Earth's centre, which at 1 AU subtends
 * 58.1″ = 0.0161°. GOES-East to GOES-West is a ~75° separation in longitude,
 * a 51 350 km chord — 70.8″ = 0.0197°. The layer's OFF_AXIS_FULL_DEG = 12°
 * full-weight band is ~750x the larger of those, so the plane of sky SUVI
 * encodes and the plane of sky AIA encodes are the same plane.
 * B0 likewise: it is the heliographic latitude of disk centre for an observer
 * at Earth, and GOES is at Earth. So `observerBasis` and `solarEphemeris` are
 * reused UNCHANGED, and the node test pins that separation rather than
 * asserting it.
 *
 * What is NOT the same is the plate scale and the passband set. Those are the
 * two things this module carries.
 *
 * ── Plate scale: derived, and the fallback for a measurement ─────────────
 *
 * DISK_FRACTION in js/sun-observed.js is R☉ as a fraction of the frame WIDTH,
 * which is why it is resolution-independent: resizing a browse product moves
 * pixels and the radius together. SUVI at 2.5″/px over 1280 px puts R☉ =
 * 959.63/2.5 = 383.9 px, i.e. 0.2999 of the frame, against AIA's 0.390 and
 * HMI's 0.465.
 *
 * THAT 23 % GAP IS LOAD-BEARING AND WOULD HAVE FAILED SILENTLY.
 * `resolveDiskGeometry` accepts a measured disk only within 12 % of the
 * instrument's expected fraction. Hand a SUVI frame to the AIA fallback and
 * the honest measurement (0.300) is 23 % from 0.390, so it is REJECTED and
 * the layer falls back to 0.390 — drawing the annulus 30 % too small, with
 * the observed limb sitting a third of a solar radius inside the model's.
 * The frame would load, the shader would run, and every prominence would be
 * in the wrong place. Hence `suvi` is a real instrument in DISK_FRACTION and
 * every SUVI channel resolves to it.
 *
 * A resize cannot break this; a CROP or a letterbox can, because both change
 * the fraction. That is what the measure-first path is for — this number is
 * the fallback, not the answer.
 *
 * ── Passbands: SUVI is NOT six AIA channels ──────────────────────────────
 *
 * SUVI's six bands are 94, 131, 171, 195, 284, 304 Å. Four of those are the
 * same lines AIA uses. TWO ARE NOT, and aliasing them would be a quiet lie:
 *   • SUVI 195 Å (Fe XII) is not AIA 193 Å (Fe XII + Fe XXIV) — neighbouring
 *     passbands over the same ion, with different hot-line contamination.
 *   • SUVI 284 Å (Fe XV, ~2.0 MK) is not AIA 211 Å (Fe XIV, ~2.0 MK) — a
 *     different ION at a similar temperature, so the response curves differ
 *     even where the images look alike.
 * `AIA_CORRESPONDENCE` carries the mapping WITH its `same` flag, and the chip
 * label prints the SUVI wavelength, never the AIA one it is near.
 *
 * The off-limb layer uses 304 and 131, and those are the two that ARE the
 * same lines — He II 304 and Fe XXI/Fe VIII 131. So the cool+hot pairing the
 * layer already draws carries over exactly, and only the field of view moves.
 *
 * ── The URL is UNVERIFIED, so it resolves from a candidate list ──────────
 *
 * services.swpc.noaa.gov is unreachable from this repo's build environment
 * (the egress proxy blocks it — verified, same as nasa.gov). Guessing one
 * path and shipping it fails SILENTLY in the worst way: the layer would draw
 * nothing and look exactly like a dead upstream rather than a typo on our
 * side, which is the `noaa-regions` / `mars-tiles` scar this repo has already
 * paid for twice.
 *
 * So every SUVI channel resolves from an ORDERED CANDIDATE LIST and the route
 * reports which one answered. ONE production request settles it:
 *
 *     curl -s 'https://parkersphysics.com/api/solar/aia?channel=suvi304&meta=1' \
 *       | jq '.source_id, .upstream, .candidates'
 *
 * Then record the winner in this file's SOURCES table, move it to the head of
 * the list, and delete the ones that never hit. Until then the layer degrades
 * honestly: no candidate answers ⇒ no SUVI frame ⇒ the annulus stays on SDO
 * and says so. It never invents a corona.
 */

// ── Instrument constants ───────────────────────────────────────────────────

/**
 * Solar radius in arcseconds at 1 AU. The same value js/sun-observed.js's
 * DISK_FRACTION comments are derived from (HMI 959.63/0.504/4096 = 0.465,
 * AIA 959.63/0.600/4096 = 0.390) — kept here so the SUVI derivation is
 * checkable against the two that already shipped.
 */
export const R_SUN_ARCSEC = 959.63;

/** SUVI: 1280² CCD at 2.5″/px — a 53′ × 53′ field of view. */
export const SUVI_PLATE_SCALE_ARCSEC = 2.5;
export const SUVI_FRAME_PX = 1280;

/**
 * R☉ as a fraction of the frame WIDTH, from an instrument's plate scale and
 * frame size. This is the DISK_FRACTION convention in js/sun-observed.js, and
 * it is resolution-independent: resizing a browse product moves the pixels and
 * the radius together. Only a CROP or a letterbox changes it — which is what
 * the measure-first path in `resolveDiskGeometry` is for.
 */
export function diskFractionFromPlateScale(arcsecPerPx, framePx) {
    if (!(arcsecPerPx > 0) || !(framePx > 0)) return 0;
    return R_SUN_ARCSEC / arcsecPerPx / framePx;
}

/** DERIVED, not typed: 959.63 / 2.5 / 1280 = 0.29988… */
export const SUVI_DISK_FRACTION = diskFractionFromPlateScale(SUVI_PLATE_SCALE_ARCSEC, SUVI_FRAME_PX);

/**
 * The two SDO instruments, derived the same way so a coverage comparison is
 * apples to apples. js/sun-observed.js's DISK_FRACTION carries the ROUNDED
 * values it has always used (0.465 / 0.390) — those feed a ±12 % acceptance
 * band where the fourth decimal cannot matter. These exact ones feed the
 * coverage DISCLOSURE, where quoting 66.2 % for a number that is 65.9 % would
 * be the layer misreporting its own field of view.
 */
export const AIA_DISK_FRACTION = diskFractionFromPlateScale(0.6, 4096);
export const HMI_DISK_FRACTION = diskFractionFromPlateScale(0.504, 4096);

/**
 * GOES orbit radius (km) and the Earth–Sun distance (km), for the vantage
 * argument in the header. Kept as constants so the node test computes the
 * parallax rather than trusting the number written in prose.
 */
export const GEO_ORBIT_RADIUS_KM = 42164;
export const AU_KM = 1.495978707e8;

// ── Passbands ──────────────────────────────────────────────────────────────

/**
 * The six SUVI bands. `code` is the zero-padded wavelength SWPC's paths use.
 * `peakLogT` is log10(T/K) of the dominant ion — the same quantity
 * js/corona-volumetric.js's EUV_CHANNELS table carries, so a future consumer
 * can weight a SUVI band without a second temperature table.
 */
export const SUVI_CHANNELS = Object.freeze({
    94:  Object.freeze({ code: '094', ion: 'Fe XVIII',          peakLogT: 6.8, label: 'GOES/SUVI 94 Å'  }),
    131: Object.freeze({ code: '131', ion: 'Fe XXI / Fe VIII',  peakLogT: 7.0, label: 'GOES/SUVI 131 Å' }),
    171: Object.freeze({ code: '171', ion: 'Fe IX',             peakLogT: 5.8, label: 'GOES/SUVI 171 Å' }),
    195: Object.freeze({ code: '195', ion: 'Fe XII',            peakLogT: 6.2, label: 'GOES/SUVI 195 Å' }),
    284: Object.freeze({ code: '284', ion: 'Fe XV',             peakLogT: 6.3, label: 'GOES/SUVI 284 Å' }),
    304: Object.freeze({ code: '304', ion: 'He II',             peakLogT: 4.7, label: 'GOES/SUVI 304 Å' }),
});

export const SUVI_BANDS = Object.freeze(Object.keys(SUVI_CHANNELS));

/**
 * SUVI band → the AIA channel it is nearest, and whether it is the SAME line.
 * `same: false` means the two are NOT interchangeable and nothing may label a
 * SUVI frame with the AIA wavelength (header, "Passbands").
 */
export const AIA_CORRESPONDENCE = Object.freeze({
    94:  Object.freeze({ aia: '94',  same: true,  note: 'Fe XVIII — same line' }),
    131: Object.freeze({ aia: '131', same: true,  note: 'Fe XXI / Fe VIII — same line' }),
    171: Object.freeze({ aia: '171', same: true,  note: 'Fe IX — same line' }),
    195: Object.freeze({ aia: '193', same: false, note: 'Fe XII 195 Å vs AIA 193 Å — neighbouring passbands over the same ion, different Fe XXIV contamination' }),
    284: Object.freeze({ aia: '211', same: false, note: 'Fe XV 284 Å vs AIA Fe XIV 211 Å — a different ion at a similar temperature' }),
    304: Object.freeze({ aia: '304', same: true,  note: 'He II — same line' }),
});

/** Proxy channel name for a SUVI band: `suvi304`. Namespaced so the AIA disk path is untouched. */
export function suviProxyChannel(band) {
    const b = String(band);
    return SUVI_CHANNELS[b] ? `suvi${b}` : null;
}

/** `suvi304` → `304`; anything else → null. The route's parser and the client's share this. */
export function parseSuviChannel(channel) {
    const m = /^suvi[-_]?(\d{2,3})$/i.exec(String(channel ?? ''));
    if (!m) return null;
    const band = String(parseInt(m[1], 10));
    return SUVI_CHANNELS[band] ? band : null;
}

/** Every proxy channel name this module claims, for the route's dispatch table. */
export const SUVI_PROXY_CHANNELS = Object.freeze(SUVI_BANDS.map(suviProxyChannel));

// ── Field of view ──────────────────────────────────────────────────────────

/**
 * How far out a square frame reaches, in R☉, for a given disk fraction.
 * `axis` is the half-frame (the smallest reach, on the ±x / ±y axes);
 * `corner` is the diagonal. A layer that draws past `axis` is drawing a
 * detector edge — see the header's clover.
 */
export function frameReach(diskFraction) {
    const f = Number(diskFraction);
    if (!(f > 0)) return { axis: 0, corner: 0 };
    return { axis: 0.5 / f, corner: (0.5 * Math.SQRT2) / f };
}

/**
 * Area of a disk of radius `r` intersected with a square of half-width `h`,
 * both centred on the origin. Closed form (the circle–square lens), so the
 * coverage below is exact rather than sampled.
 */
function diskSquareArea(r, h) {
    if (!(r > 0) || !(h > 0)) return 0;
    if (r <= h) return Math.PI * r * r;
    if (r >= h * Math.SQRT2) return 4 * h * h;
    // Four identical circular segments beyond |x| = h are outside the square.
    const seg = r * r * Math.acos(h / r) - h * Math.sqrt(r * r - h * h);
    return Math.PI * r * r - 4 * seg;
}

/**
 * Fraction of the annulus [rIn, rOut] that a square frame actually supplies.
 * EXACT. This is the number the header quotes: AIA 0.659, SUVI 1.000 over the
 * off-limb layer's own 1.0–1.6 R☉, each from that instrument's DERIVED disk
 * fraction rather than the rounded table value.
 */
export function annulusCoverage(rIn, rOut, diskFraction) {
    if (!(rOut > rIn) || !(diskFraction > 0)) return 0;
    const h = frameReach(diskFraction).axis;
    const annulus = Math.PI * (rOut * rOut - rIn * rIn);
    const inside = diskSquareArea(rOut, h) - diskSquareArea(rIn, h);
    return Math.max(0, Math.min(1, inside / annulus));
}

// ── Upstream candidates ────────────────────────────────────────────────────

/**
 * Ordered candidate URL templates, most-expected first. `{code}` is the
 * zero-padded band (SUVI_CHANNELS[band].code).
 *
 * UNVERIFIED — see the header. Each carries why it is plausible so a future
 * session can tell a considered guess from a typo, and `satellite` records
 * which spacecraft the path selects so the chip can name it.
 *
 * NOTE on `secondary`: SWPC publishes a primary and a secondary SUVI
 * spacecraft (GOES-East / GOES-West assignments move over time). The
 * secondary paths are listed AFTER every primary one so a healthy primary is
 * always preferred, and the resolved `satellite` field is 'primary' /
 * 'secondary' rather than a hard-coded GOES number: which physical satellite
 * is primary is an operational decision we do not get to assume.
 */
export const SOURCE_CANDIDATES = Object.freeze([
    Object.freeze({
        id: 'swpc-animation-primary-png',
        satellite: 'primary',
        template: 'https://services.swpc.noaa.gov/images/animations/suvi/primary/{code}/latest.png',
        note: 'SWPC animation frame directory — the path the public SUVI loops are served from.',
    }),
    Object.freeze({
        id: 'swpc-animation-primary-jpg',
        satellite: 'primary',
        template: 'https://services.swpc.noaa.gov/images/animations/suvi/primary/{code}/latest.jpg',
        note: 'Same directory, JPEG rather than PNG.',
    }),
    Object.freeze({
        id: 'swpc-flat-primary-png',
        satellite: 'primary',
        template: 'https://services.swpc.noaa.gov/images/suvi-primary-{code}.png',
        note: 'Flat /images naming, the shape several other SWPC single-frame products use.',
    }),
    Object.freeze({
        id: 'swpc-animation-secondary-png',
        satellite: 'secondary',
        template: 'https://services.swpc.noaa.gov/images/animations/suvi/secondary/{code}/latest.png',
        note: 'Secondary spacecraft — tried only after every primary candidate.',
    }),
    Object.freeze({
        id: 'swpc-flat-secondary-png',
        satellite: 'secondary',
        template: 'https://services.swpc.noaa.gov/images/suvi-secondary-{code}.png',
        note: 'Flat naming for the secondary spacecraft.',
    }),
]);

/**
 * The candidate URLs to try, in order, for one SUVI band.
 * @param {string|number} band one of SUVI_BANDS
 * @returns {Array<{id:string, url:string, satellite:string, note:string}>}
 */
export function candidateUrls(band) {
    const ch = SUVI_CHANNELS[String(band)];
    if (!ch) return [];
    return SOURCE_CANDIDATES.map(c => ({
        id: c.id,
        satellite: c.satellite,
        note: c.note,
        url: c.template.replace('{code}', ch.code),
    }));
}

// ── Labels ─────────────────────────────────────────────────────────────────

/**
 * Chip label for a resolved SUVI frame. Names the instrument and the BAND'S
 * OWN wavelength — never the AIA channel it is near (header, "Passbands") —
 * and the spacecraft slot when one resolved.
 */
export function suviLabel(band, source) {
    const ch = SUVI_CHANNELS[String(band)];
    if (!ch) return 'SUVI';
    const sat = source && source.satellite ? ` (${source.satellite})` : '';
    return `${ch.label}${sat}`;
}

/**
 * One line for the layer's tooltip: what this source buys over the other one.
 * Derived from the coverage math so it cannot drift from the geometry.
 */
export function coverageNote(rIn, rOut, diskFraction, instrument) {
    const pct = annulusCoverage(rIn, rOut, diskFraction) * 100;
    const reach = frameReach(diskFraction);
    return `${instrument} reaches ${reach.axis.toFixed(2)} R☉ on axis `
         + `(${reach.corner.toFixed(2)} in the corners) and supplies `
         + `${pct.toFixed(1)}% of the ${rIn.toFixed(1)}–${rOut.toFixed(1)} R☉ annulus`;
}
