/**
 * climalytix/contours.js — isotherms on a field window, PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Marching squares on the GRID NODES of one time's plane of a field body
 * (js/climalytix/point-tile.js fieldBody: row 0 = north, layout time,row,col),
 * returning polylines in lat/lon so the map draws them through the SAME
 * projection as everything else. Gated by tests/climalytix-contours.mjs.
 *
 * Why not js/isobar-contour.js: that module is EarthView's isobar pipeline,
 * hard-wired to the 360×180 global texture and pinned BIT-IDENTICAL by
 * SHA-256 (tests/isobar-contour.mjs). A window of 25×25 nodes is a different
 * grid; touching the pinned module to generalise it would put the globe's
 * gate at risk for no gain. The algorithm is the textbook one either way.
 *
 * Rules kept:
 *   · a cell with any GAP corner draws nothing (no line through missing data)
 *   · saddles are resolved by the cell-centre mean, so lines never cross
 *   · shared edge points are computed ONCE per edge key, so chains join exactly
 *   · levels are chosen in the READER'S unit (round numbers in °F for a °F
 *     reader) and contoured in °C; the freezing line (0 °C) is always its own
 *     level when the window spans it, flagged so the map can emphasise it —
 *     EarthView paints the same line as a seam on the globe.
 */

/** Edge-pair table for marching squares; corners TL=8, TR=4, BR=2, BL=1. */
const CASES = {
    1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']],
    6: [['T', 'B']], 7: [['L', 'T']], 8: [['L', 'T']], 9: [['T', 'B']],
    11: [['T', 'R']], 12: [['L', 'R']], 13: [['B', 'R']], 14: [['L', 'B']],
};

/**
 * Isolines of one level. Returns [{ pts: [{lat, lon}], closed }].
 */
export function contourLines(f, t, levelC) {
    const nR = f.nRows, nC = f.nCols, base = t * nR * nC;
    const val = (i, j) => {
        const v = f.values[base + i * nC + j];
        return v == null || !Number.isFinite(v) ? NaN : v;
    };
    const points = new Map();     // edge key → {lat, lon}
    const edgePoint = (kind, i, j) => {
        const key = `${kind}${i},${j}`;
        if (!points.has(key)) {
            let lat, lon;
            if (kind === 'h') {        // between (i,j) and (i,j+1)
                const v0 = val(i, j), v1 = val(i, j + 1);
                const fr = (levelC - v0) / (v1 - v0);
                lat = f.latN - i * f.dlat; lon = f.lonW + (j + fr) * f.dlon;
            } else {                   // between (i,j) and (i+1,j)
                const v0 = val(i, j), v1 = val(i + 1, j);
                const fr = (levelC - v0) / (v1 - v0);
                lat = f.latN - (i + fr) * f.dlat; lon = f.lonW + j * f.dlon;
            }
            points.set(key, { lat, lon, key });
        }
        return points.get(key);
    };
    const segs = [];
    for (let i = 0; i < nR - 1; i++) {
        for (let j = 0; j < nC - 1; j++) {
            const a = val(i, j), b = val(i, j + 1), c = val(i + 1, j + 1), d = val(i + 1, j);
            if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
            const idx = (a >= levelC ? 8 : 0) | (b >= levelC ? 4 : 0) | (c >= levelC ? 2 : 0) | (d >= levelC ? 1 : 0);
            if (idx === 0 || idx === 15) continue;
            const E = {
                T: () => edgePoint('h', i, j), B: () => edgePoint('h', i + 1, j),
                L: () => edgePoint('v', i, j), R: () => edgePoint('v', i, j + 1),
            };
            let pairs = CASES[idx];
            if (idx === 5 || idx === 10) {
                const above = (a + b + c + d) / 4 >= levelC;
                // 5 = TR+BL above, 10 = TL+BR above. When the centre is with the
                // above-pair they join through the middle and the lines cut off
                // the two below-corners.
                pairs = (idx === 5) === above ? [['L', 'T'], ['B', 'R']] : [['T', 'R'], ['L', 'B']];
            }
            for (const [p, q] of pairs) segs.push([E[p](), E[q]()]);
        }
    }
    return assemble(segs);
}

/** Join segments that share an edge point into polylines. */
function assemble(segs) {
    const byKey = new Map();
    segs.forEach((s, k) => s.forEach((p) => {
        if (!byKey.has(p.key)) byKey.set(p.key, []);
        byKey.get(p.key).push(k);
    }));
    const used = new Uint8Array(segs.length);
    const walk = (startSeg, startPt) => {
        const pts = [startPt];
        let seg = startSeg, at = startPt;
        while (seg != null) {
            used[seg] = 1;
            const next = segs[seg][0].key === at.key ? segs[seg][1] : segs[seg][0];
            pts.push(next);
            at = next;
            seg = (byKey.get(at.key) || []).find((k) => !used[k]) ?? null;
        }
        return pts;
    };
    const out = [];
    // Open chains first (from an endpoint used by one segment), then loops.
    for (const [key, list] of byKey) {
        if (list.length !== 1 || used[list[0]]) continue;
        const s = list[0];
        const start = segs[s][0].key === key ? segs[s][0] : segs[s][1];
        out.push({ pts: walk(s, start).map(strip), closed: false });
    }
    for (let k = 0; k < segs.length; k++) {
        if (used[k]) continue;
        const pts = walk(k, segs[k][0]);
        out.push({ pts: pts.map(strip), closed: pts.length > 2 && pts[0].key === pts[pts.length - 1].key });
    }
    return out;
}
const strip = ({ lat, lon }) => ({ lat, lon });

/**
 * Round levels in the READER'S unit across [minC, maxC], 4–12 lines, plus
 * the freezing line when the range spans it. `units` is { toDisplay(c),
 * fromDisplay(d), sym }. Returns [{ c, label, freezing, major }].
 */
export function isothermLevels(minC, maxC, units) {
    if (!(Number.isFinite(minC) && Number.isFinite(maxC)) || maxC <= minC) return [];
    const lo = units.toDisplay(minC), hi = units.toDisplay(maxC);
    const span = hi - lo;
    const steps = units.sym.includes('F') ? [1, 2, 5, 10, 20] : [0.5, 1, 2, 5, 10];
    const step = steps.find((s) => span / s <= 12) ?? steps[steps.length - 1];
    const out = [];
    for (let d = Math.ceil(lo / step) * step; d <= hi + 1e-9; d += step) {
        const c = units.fromDisplay(d);
        if (c <= minC || c >= maxC) continue;
        const major = Math.abs(Math.round(d / (step * 2)) * step * 2 - d) < 1e-6;
        out.push({ c, label: `${+d.toFixed(1)}°`, freezing: Math.abs(c) < 1e-6, major });
    }
    if (minC < 0 && maxC > 0 && !out.some((l) => l.freezing)) {
        out.push({ c: 0, label: `${+units.toDisplay(0).toFixed(1)}°`, freezing: true, major: true });
        out.sort((a, b) => a.c - b.c);
    }
    return out;
}

/** Where to put a level's label: the middle of its longest chain (≥ minPts). */
export function labelAnchor(chains, minPts = 6) {
    let best = null;
    for (const ch of chains) if (ch.pts.length >= minPts && (!best || ch.pts.length > best.pts.length)) best = ch;
    return best ? best.pts[Math.floor(best.pts.length / 2)] : null;
}
