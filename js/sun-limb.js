/**
 * sun-limb.js — the solar limb, analytically (PURE; no three, no DOM)
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md, 2026-11 cinematic pass. ONE copy of how
 * sun.html's chromosphere and transition-region shells draw their off-limb
 * fringe; chromoFS and trFS interpolate LIMB_GLSL and the constants below.
 *
 * ── What it replaced, and why that was wrong ─────────────────────────────
 * Both shells drew their limb as `pow(rim, n)` with rim = 1 − max(n·v, 0) on a
 * DoubleSide sphere at r = 1.06 (chromosphere) / 1.04 (transition region).
 * Two faults, each visible in every frame the page ever rendered:
 *
 *   1. `pow(rim, n)` DOES NOT VARY ON A BACK FACE. The back hemisphere's
 *      outward normals point away from the camera, max(n·v, 0) is 0, rim is
 *      identically 1 — so the visible annulus between the photosphere's
 *      silhouette and the shell's was a FLAT plate at the clamped alpha with a
 *      hard outer rim. (The orrery's corona had the same fault:
 *      SOLAR_SYSTEM_VISUAL_REVIEW.md S3. Measured there as five consecutive
 *      annuli at exactly one level, then a cliff.)
 *   2. The plate's width was the MESH radius: 0.06 R☉ = 42 Mm of
 *      "chromosphere". The real one is ~1.5–2 Mm deep with spicules to
 *      ~10 Mm — the band was drawn about TWENTY TIMES too thick, over an
 *      observed disc, on a page whose honesty rule 5 is "scale is honest".
 *
 * ── What it is now ───────────────────────────────────────────────────────
 * The mesh is only a canvas. Each fragment reconstructs its own SIGHTLINE
 * from the camera and reads the emission off the ray's impact parameter b
 * (R☉): h = b − 1 is the plane-of-sky height above the limb, and an
 * optically thin exponential atmosphere of scale height H seen at height h
 * has column ∝ exp(−h/H) (the √(2π(1+h)H) Chapman prefactor is constant to
 * 1 % across the fringe and is folded into the shell's gain). The geometry's
 * silhouette is never the visual edge: at the mesh radius the emission is
 * already < 10⁻⁴ of its base value (gated).
 *
 * THE SHELL IS PRE-FILTERED. At the page's default framing the whole
 * chromosphere is a fraction of a pixel. Point-sampling exp(−h/H) there is a
 * sparkle that changes with every sub-pixel camera move; `shellAA` is the
 * exact box-filtered integral over the pixel's footprint in h, so a sub-pixel
 * shell dims to a hairline carrying the right ENERGY instead of aliasing.
 * `pix` is fwidth(b). The node gate checks it against quadrature.
 *
 * ON THE DISC the same shell is seen through a column H/μ, which only rivals
 * the off-limb column inside the outer 0.1 % of the radius — i.e. the
 * chromosphere is invisible against the disc in white light, which is true.
 * `shellOnDisk` returns that (capped at the half-chord, the limb's own value).
 *
 * WHAT THE SIGHTLINE IS "ABOUT". Heliographic lookups (network, plage, the
 * flare site) must be made at a point ON THE SUN, not on the canvas mesh:
 * the photosphere hit for b < 1, the closest-approach point for b ≥ 1. The
 * shells used to take latitude/longitude from the VIEW-SPACE normal, so every
 * plage halo and flare ribbon on them was pinned to the screen and slid off
 * its active region as the camera orbited. `sightline()` returns the right
 * direction in the scene frame (the meshes carry an identity model matrix).
 *
 * OBSERVATION BEATS MODEL. While the observed off-limb layer
 * (js/sun-offlimb.js) is drawing the real He II 304 limb, the model fringe is
 * faded by that layer's own weight (`u_limbObs`), and the shells' on-disc
 * procedural terms are faded on the observed hemisphere. Orbit off the
 * Sun–Earth line and the model takes over as the observation fades.
 */

/** Solar radius, Mm — IAU 2015 nominal (Resolution B3). */
export const RSUN_MM = 695.7;

/**
 * Scale heights, R☉. Each is a stated physical number, not a look:
 *   chromosphere  — bulk Hα-emitting layer, e-folding ~1.5 Mm
 *                   (VAL-C: the chromosphere spans ~0.5–2.1 Mm);
 *   spicules      — the limb forest thins with an e-folding of ~4 Mm and is
 *                   gone by ~10 Mm (Beckers 1972; Pereira et al. 2012);
 *   transition    — a thin sheath riding the spicule tops, e-folding ~2.5 Mm
 *                   above the chromosphere's top.
 */
export const H_CHROMO_MM = 1.5;
export const H_SPICULE_MM = 4.0;
export const H_TR_MM = 2.5;
export const H_CHROMO = H_CHROMO_MM / RSUN_MM;
export const H_SPICULE = H_SPICULE_MM / RSUN_MM;
export const H_TR = H_TR_MM / RSUN_MM;

/** A spicule is ~0.5–1 Mm wide; the fringe's hair fades out below ~1 px of this. */
export const SPICULE_WIDTH_MM = 0.8;
export const SPICULE_WIDTH = SPICULE_WIDTH_MM / RSUN_MM;
/** Noise frequency that puts one hair per spicule width along the limb. */
export const SPICULE_FREQ = Math.round(1 / SPICULE_WIDTH);

/** The canvas meshes. Kept where they always were; only what is drawn on them changed. */
export const CHROMO_MESH_R = 1.06;
export const TR_MESH_R = 1.04;

/**
 * Box-filtered off-limb column of an exponential shell.
 * Mean of exp(−max(x,0)/H) over x ∈ [h − w/2, h + w/2], restricted to x ≥ 0
 * (below the limb the ray is a DISC ray and is `shellOnDisk`'s business), so
 * the result is the energy this pixel actually receives from above the limb.
 */
export function shellAA(h, H, pix) {
    const w = Math.max(pix, 1e-6);
    const h0 = Math.max(h - 0.5 * w, 0), h1 = Math.max(h + 0.5 * w, 0);
    return (H / w) * (Math.exp(-h0 / H) - Math.exp(-h1 / H));
}

/** Point-sampled column — the thing shellAA is the filtered version of. */
export function shellPoint(h, H) { return h < 0 ? 0 : Math.exp(-h / H); }

/**
 * On-disc column of the same shell relative to its off-limb base column:
 * (H/μ) / √(2πH), capped at ½ (the limb sees half the chord a grazing
 * off-limb ray does).
 */
export function shellOnDisk(mu, H) {
    return Math.min(0.5, Math.sqrt(H / (2 * Math.PI)) / Math.max(mu, 1e-4));
}

/**
 * The sightline through a scene-space point `p` from a camera at `c`
 * (both [x, y, z], R☉, Sun at the origin). Returns the impact parameter, μ at
 * the photosphere, and the unit direction of the point the ray is about.
 */
export function sightline(c, p) {
    let rx = p[0] - c[0], ry = p[1] - c[1], rz = p[2] - c[2];
    const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
    const tca = -(c[0] * rx + c[1] * ry + c[2] * rz);
    const px = c[0] + rx * tca, py = c[1] + ry * tca, pz = c[2] + rz * tca;
    const b = Math.hypot(px, py, pz);
    const mu = Math.sqrt(Math.max(1 - b * b, 0));
    let nx = px, ny = py, nz = pz;
    if (b < 1) { nx -= rx * mu; ny -= ry * mu; nz -= rz * mu; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    return { b, mu, n: [nx / nl, ny / nl, nz / nl], onDisk: b < 1 };
}

const f = (x) => { const s = String(x); return /[.e]/.test(s) ? s : s + '.0'; };

/**
 * GLSL for both shells. Needs the vertex shader's `vWorldPos` (glowVS) and
 * three's built-in `cameraPosition`. No backticks in here — a backtick inside
 * a template literal ends it (the orrery scar).
 */
export const LIMB_GLSL = /* glsl */`
    varying vec3 vWorldPos;
    uniform float u_limbObs;      // 0..1 — the observed off-limb layer's drawn weight
    const float LIMB_H_CHROMO  = ${f(H_CHROMO)};
    const float LIMB_H_SPICULE = ${f(H_SPICULE)};
    const float LIMB_H_TR      = ${f(H_TR)};
    const float LIMB_SPIC_W    = ${f(SPICULE_WIDTH)};
    const float LIMB_SPIC_FREQ = ${f(SPICULE_FREQ)};

    // Impact parameter b (R_sun), mu at the photosphere, and the unit direction
    // of the point this ray is about: the photosphere hit on the disc, the
    // closest-approach point off the limb. sightN is in the scene frame.
    float sightB; float sightMu; vec3 sightN; float sightPix; float sightDisk;
    void sightline() {
        vec3  ray = normalize(vWorldPos - cameraPosition);
        float tca = -dot(cameraPosition, ray);
        vec3  pca = cameraPosition + ray * tca;
        sightB    = length(pca);
        sightMu   = sqrt(max(1.0 - sightB * sightB, 0.0));
        vec3  hit = pca - ray * sightMu;
        sightN    = normalize(sightB < 1.0 ? hit : pca);
        sightPix  = max(fwidth(sightB), 1e-6);
        // 1 on the disc, 0 off it, anti-aliased over one pixel of b.
        sightDisk = 1.0 - smoothstep(-0.5 * sightPix, 0.5 * sightPix, sightB - 1.0);
    }
    // Box-filtered exponential shell above the limb (see js/sun-limb.js shellAA).
    float shellAA(float h, float H) {
        float w  = sightPix;
        float h0 = max(h - 0.5 * w, 0.0), h1 = max(h + 0.5 * w, 0.0);
        return (H / w) * (exp(-h0 / H) - exp(-h1 / H));
    }
    float shellOnDisk(float H) {
        return min(0.5, sqrt(H * 0.15915494) / max(sightMu, 1e-4));
    }
    // Whole-limb profile of one shell: its on-disc column where the ray hits
    // the photosphere, its filtered off-limb column where it does not.
    float limbShell(float H) {
        return sightDisk * shellOnDisk(H) + shellAA(sightB - 1.0, H);
    }
`;
