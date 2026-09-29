/**
 * tests/helpers/image-metrics.mjs — numbers from rendered frames
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no deps). Each function turns one class of visual bug into a
 * number, so a bug that was found by eye in a screenshot becomes a gate that
 * runs on a software renderer. Unit-tested on synthetic images by
 * `node tests/image-metrics.mjs`, which also shows each metric SEES the bug
 * it is for (a gate that cannot fail is not a gate).
 *
 * Images are { w, h, data } with data an RGBA Uint8Array, row 0 at the TOP.
 *
 *   luminance            RGB → 0..255 luma (Rec. 709 weights)
 *   horizonDeviation     how far a drawn limb strays from where the sphere is
 *                        (catches a faceted planet: the 720-face icosphere's
 *                        horizon was a polygon)
 *   brightRunStats       widest horizontal run of bright pixels per row
 *   runWidths            the distribution of horizontal run widths, lines
 *                        that cross a whole row excluded
 *   lineWidths           the same, but each line's width at HALF ITS OWN
 *                        PEAK above the row's background — independent of
 *                        how bright the layer is and of a dim fill behind it
 *                        (catches a grid line blooming into a wedge while
 *                        the lines that cross the view legitimately span it)
 *   coverage             fraction of bright pixels (catches a flood)
 *   seamStep             largest brightness step between the column-means on
 *                        either side of a column (catches a hard edge)
 *   blobStats            size and squareness of the one bright blob in an
 *                        image (catches an uncapped, untextured point sprite)
 */

/** RGBA → Float32Array of luma, 0..255. */
export function luminance(img) {
    const { w, h, data } = img;
    const out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        out[i] = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    }
    return out;
}

/**
 * The drawn limb against the predicted one. `predicted[x]` is the row of the
 * true horizon in column x (NaN where it is off-screen). In each column the
 * DRAWN edge is the first row, scanning down from `predicted − band`, whose
 * luma reaches `threshold` (the planet is bright, the sky black). Columns
 * whose predicted edge is within `margin` of the top or bottom are skipped.
 *
 * @returns {{ maxDev:number, meanDev:number, columns:number, missing:number }}
 */
export function horizonDeviation(img, predicted, { threshold = 12, band = 60, margin = 4, step = 1 } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    let maxDev = 0, sum = 0, n = 0, missing = 0;
    for (let x = 0; x < w; x += step) {
        const py = predicted[x];
        if (!Number.isFinite(py) || py < margin || py > h - margin) continue;
        const y0 = Math.max(0, Math.floor(py - band));
        const y1 = Math.min(h - 1, Math.ceil(py + band));
        let edge = -1;
        for (let y = y0; y <= y1; y++) {
            if (lum[y * w + x] >= threshold) { edge = y; break; }
        }
        if (edge < 0) { missing++; continue; }
        const d = Math.abs(edge - py);
        if (d > maxDev) maxDev = d;
        sum += d; n++;
    }
    return { maxDev, meanDev: n ? sum / n : NaN, columns: n, missing };
}

/**
 * Widest horizontal run of pixels at or above `threshold`, per row, over rows
 * [row0, row1). Returns the maximum and the 99th-percentile row maximum (the
 * latter ignores a stray row where lines genuinely cross).
 */
export function brightRunStats(img, { threshold = 40, row0 = 0, row1 = null } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    const r1 = row1 == null ? h : Math.min(h, row1);
    const perRow = [];
    for (let y = Math.max(0, row0); y < r1; y++) {
        let best = 0, run = 0;
        for (let x = 0; x < w; x++) {
            if (lum[y * w + x] >= threshold) { run++; if (run > best) best = run; }
            else run = 0;
        }
        perRow.push(best);
    }
    const sorted = [...perRow].sort((a, b) => a - b);
    return {
        max: sorted.length ? sorted[sorted.length - 1] : 0,
        p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0,
        rows: perRow.length,
    };
}

/**
 * Every horizontal run of pixels at or above `threshold` over rows
 * [row0, row1), runs longer than `maxRun` dropped (a line that crosses the
 * view is one long run per row, and it is not the defect). Returns the
 * percentiles of what is left.
 */
export function runWidths(img, { threshold = 20, row0 = 0, row1 = null, maxRun = Infinity } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    const r1 = row1 == null ? h : Math.min(h, row1);
    const runs = [];
    for (let y = Math.max(0, row0); y < r1; y++) {
        let run = 0;
        for (let x = 0; x <= w; x++) {
            if (x < w && lum[y * w + x] >= threshold) run++;
            else { if (run > 0 && run <= maxRun) runs.push(run); run = 0; }
        }
    }
    runs.sort((a, b) => a - b);
    const q = (f) => runs.length ? runs[Math.min(runs.length - 1, Math.floor(runs.length * f))] : 0;
    return { count: runs.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: runs.length ? runs[runs.length - 1] : 0 };
}

/**
 * Line widths at half maximum. Per row over [row0, row1), within columns
 * [col0, col1): the background is the window's median luma; every maximal run more than `minContrast` above it
 * is one line crossing, and its width is the number of its pixels at or
 * above background + ½(peak − background). Runs longer than `maxRun` (a line
 * lying along the row) are dropped.
 */
export function lineWidths(img, { row0 = 0, row1 = null, col0 = 0, col1 = null, minContrast = 6, maxRun = Infinity } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    const r1 = row1 == null ? h : Math.min(h, row1);
    const c0 = Math.max(0, col0), c1 = col1 == null ? w : Math.min(w, col1);
    const n = Math.max(0, c1 - c0);
    const widths = [];
    const row = new Float32Array(n);
    for (let y = Math.max(0, row0); y < r1; y++) {
        for (let x = 0; x < n; x++) row[x] = lum[y * w + c0 + x];
        const bg = Float32Array.from(row).sort()[n >> 1];
        let x = 0;
        while (x < n) {
            if (row[x] <= bg + minContrast) { x++; continue; }
            let e = x, peak = 0;
            while (e < n && row[e] > bg + minContrast) { if (row[e] > peak) peak = row[e]; e++; }
            // A run cut by the window edge is not a whole line.
            if (e - x <= maxRun && x > 0 && e < n) {
                const half = bg + 0.5 * (peak - bg);
                let m = 0;
                for (let k = x; k < e; k++) if (row[k] >= half) m++;
                widths.push(m);
            }
            x = e;
        }
    }
    widths.sort((a, b) => a - b);
    const q = (f) => widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * f))] : 0;
    return { count: widths.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: widths.length ? widths[widths.length - 1] : 0 };
}

/** The first row holding any pixel at or above `threshold` (−1 if none). */
export function firstLitRow(img, { threshold = 20 } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lum[y * w + x] >= threshold) return y;
    return -1;
}

/** Fraction of pixels at or above `threshold`. */
export function coverage(img, { threshold = 40 } = {}) {
    const lum = luminance(img);
    let n = 0;
    for (let i = 0; i < lum.length; i++) if (lum[i] >= threshold) n++;
    return n / lum.length;
}

/**
 * Hard vertical edges. The mean luma of each column over rows [row0, row1)
 * gives a profile; at every column in [col0, col1) the step is
 * |mean(profile[x−win, x)) − mean(profile[x, x+win))|, divided by the mean
 * of the whole profile. A smooth pattern with fine structure (rays) averages
 * out over `win`; a seam between two different plateaus does not.
 */
export function seamStep(img, { row0 = 0, row1 = null, col0 = 0, col1 = null, win = 16 } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    const r0 = Math.max(0, row0), r1 = row1 == null ? h : Math.min(h, row1);
    const prof = new Float64Array(w);
    for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = r0; y < r1; y++) s += lum[y * w + x];
        prof[x] = s / Math.max(1, r1 - r0);
    }
    let mean = 0;
    for (let x = 0; x < w; x++) mean += prof[x];
    mean /= w;
    const c0 = Math.max(win, col0), c1 = Math.min(w - win, col1 == null ? w : col1);
    let best = 0, at = -1;
    for (let x = c0; x < c1; x++) {
        let l = 0, r = 0;
        for (let k = 1; k <= win; k++) { l += prof[x - k]; r += prof[x + k - 1]; }
        const step = Math.abs(l - r) / win;
        if (step > best) { best = step; at = x; }
    }
    return { step: mean > 0 ? best / mean : 0, at, mean };
}

/**
 * The bright blob in an image that holds one: its bounding box, the widest
 * run, and how much of its box it fills (a hard square fills ~1; a soft disc
 * well under π/4 once its faint rim falls below the threshold).
 */
export function blobStats(img, { threshold = 30 } = {}) {
    const lum = luminance(img);
    const { w, h } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (lum[y * w + x] >= threshold) {
                n++;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    if (!n) return { found: false, width: 0, height: 0, fill: 0, count: 0 };
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    return { found: true, width: bw, height: bh, fill: n / (bw * bh), count: n, x0, y0 };
}

/** Decode the capture format the browser specs use: base64 RGBA, row 0 at the top. */
export function imageFromCapture({ w, h, b64 }) {
    return { w, h, data: new Uint8Array(Buffer.from(b64, 'base64')) };
}
