/**
 * launch-render-health.js — PURE verdicts on what the launch planner's 3D
 * canvas actually drew. No DOM, no THREE: numbers in, numbers out,
 * node-gated by tests/launch-render-health.mjs.
 *
 * WHY THIS EXISTS. Every browser gate for this canvas runs Chromium on a
 * software rasteriser, which takes the 'low' quality path; visitors on real
 * GPUs take 'high' (MSAA half-float targets, bloom, 4096² shadows) on
 * engines CI never ran (Safari/WebKit, Firefox). A bug that only exists
 * there is invisible to the tests AND to us, because the page reported
 * nothing about what it rendered. js/launch-vehicle-3d.js now reads its
 * own frame back once per page view, runs `frameHealth` on it and sends the
 * result (GPU string, quality, post path, verdict) through telemetry — so a
 * black, flat or blown-out canvas on someone's device becomes a row we can
 * query instead of a report we cannot reproduce. The browser gates read the
 * SAME verdict through `api.health`, so a test and a visitor are judged by
 * one definition.
 *
 * 1. FRAME HEALTH (`frameHealth`). RGBA bytes (any row order) → luminance
 *    statistics and one verdict, checked in this order:
 *      'black'       ≥ 98 % of samples below L 3 — nothing drew (the
 *                    incomplete-framebuffer failure, 2026-11-02)
 *      'blank'       luminance spread < 2.5 — one flat colour: the clear
 *                    colour or the sky alone, no pad and no vehicle
 *      'washed-out'  > 30 % of samples with a channel ≥ 250 — a tone-map or
 *                    bloom failure that whites out the frame
 *      'dark'        mean L < 4 with SOME structure — drew, but unlit
 *      'ok'          otherwise
 *    Thresholds sit well clear of a healthy night-pad frame, measured from
 *    the page on 2026-11-02 (1042×651, software GL): mean L 41.8, spread
 *    36.5, 0 % clipped, 0.1 % black. tests/launch-render-health.mjs pins
 *    each verdict on synthetic frames shaped like that one and its failures.
 *
 * 2. OCCLUSION (`occlusionVerdict`). The page raycasts a grid of rays from
 *    the live camera through the vehicle's on-screen box and counts, per
 *    ray that reaches the vehicle, whether something ELSE was hit first.
 *    This kernel turns those counts into a fraction and a pass/fail. The
 *    It catches a structure IN FRONT OF THE VEHICLE — and, measured
 *    2026-11-02, it does NOT catch the Falcon lightning-tower bug, which is
 *    why (3) exists: that tower stood ~24 m off the camera→rocket line.
 *
 * 3. FOREGROUND CLUTTER (`foregroundVerdict`). The fraction of the frame
 *    covered by the screen boxes of tall pad structures standing closer to
 *    the camera than 0.8 × the vehicle's distance. The old tower spot is
 *    what this measures (tests/launch-planner-framing.spec.js plants it back
 *    as the negative control).
 */

export const HEALTH_LIMITS = Object.freeze({
    blackL: 3,
    blackFrac: 0.98,
    minStd: 2.5,
    clipChannel: 250,
    maxClipFrac: 0.30,
    minMean: 4,
});

// Fraction of the vehicle's rays that may be blocked before a framing is
// called occluded. The strongback, umbilicals and towers a vehicle really
// stands beside legitimately cover a little of it.
export const OCCLUSION_LIMIT = 0.12;

// Fraction of the frame tall foreground structures may cover (calibrated in
// the framing gate: every shipped vehicle × preset vs the planted old tower).
export const FOREGROUND_LIMIT = 0.03;

export function foregroundVerdict(frac, limit = FOREGROUND_LIMIT) {
    const f = Number.isFinite(frac) ? frac : 0;
    return { frac: f, ok: f <= limit, reason: f <= limit ? null : 'foreground-clutter' };
}

export function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * @param {{ data: ArrayLike<number>, width: number, height: number, step?: number }} frame
 *   `step` samples every Nth pixel in both axes (default: ≈ 160 columns).
 */
export function frameHealth({ data, width, height, step } = {}) {
    const W = Math.floor(width) || 0, H = Math.floor(height) || 0;
    if (!data || W <= 0 || H <= 0 || data.length < W * H * 4) {
        return { verdict: 'no-frame', samples: 0, mean: 0, std: 0, clipFrac: 0, blackFrac: 0 };
    }
    const s = Math.max(1, Math.floor(step || Math.max(1, Math.round(W / 160))));
    const L = HEALTH_LIMITS;
    let n = 0, sum = 0, sum2 = 0, clip = 0, black = 0;
    for (let y = 0; y < H; y += s) {
        const row = y * W * 4;
        for (let x = 0; x < W; x += s) {
            const i = row + x * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const l = luminance(r, g, b);
            sum += l; sum2 += l * l; n++;
            if (r >= L.clipChannel || g >= L.clipChannel || b >= L.clipChannel) clip++;
            if (l < L.blackL) black++;
        }
    }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const clipFrac = clip / n, blackFrac = black / n;
    let verdict = 'ok';
    if (blackFrac >= L.blackFrac) verdict = 'black';
    else if (std < L.minStd) verdict = 'blank';
    else if (clipFrac > L.maxClipFrac) verdict = 'washed-out';
    else if (mean < L.minMean) verdict = 'dark';
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { verdict, samples: n, mean: r3(mean), std: r3(std), clipFrac: r3(clipFrac), blackFrac: r3(blackFrac) };
}

/**
 * @param {{ visible: number, occluded: number }} counts  rays whose FIRST hit
 *   was the vehicle vs rays that reached the vehicle only after another hit.
 */
export function occlusionVerdict({ visible = 0, occluded = 0 } = {}, limit = OCCLUSION_LIMIT) {
    const reached = visible + occluded;
    if (reached === 0) return { reached: 0, frac: null, ok: false, reason: 'vehicle-not-in-view' };
    const frac = occluded / reached;
    return { reached, frac: Math.round(frac * 1000) / 1000, ok: frac <= limit, reason: frac <= limit ? null : 'occluded' };
}
