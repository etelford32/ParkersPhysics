/**
 * isobar-contour.js — the PURE half of the isobar pipeline.
 *
 * Moved VERBATIM out of js/isobar-engine.js (2026-10-31,
 * EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md T3) so the contouring can run in a
 * Worker (js/weather-scrub-worker.js): no three.js, no DOM, relative imports
 * only. It was measured as the single largest cost of a time-scrub repaint —
 * marching squares + chain assembly + blur over 360×180 ≈ 58 ms per
 * repaint on the main thread, every repaint, even inside one hour bracket.
 *
 * `computeIsobars(weatherBuf)` returns exactly what IsobarLayer.update used
 * to build inline: flat line-segment positions + premultiplied colours,
 * the NMS'd H/L extrema with their sphere positions, and the gradient stats.
 * The algorithm, constants and arithmetic order are unchanged, so the output
 * is bit-identical whether it ran here, in the Worker, or (before this move)
 * inside the layer — tests/isobar-contour.mjs pins determinism and the frame,
 * and tests/earth-scrub-perf.spec.js compares the Worker path to the inline
 * path in the page.
 *
 * Input:  weatherBuffer  Float32Array (360 × 180 × 4); channel G = pressure
 *         normalised [0,1] ↔ (hPa − 850) / 210. Row 0 = 90°S.
 */

export const W   = 360;   // TEX_W
export const H   = 180;   // TEX_H
const R   = 1.0;   // earthMesh radius in Three.js units
const DEG = Math.PI / 180;

// 4 hPa isobar spacing — standard synoptic meteorology
export const ISOBAR_LEVELS = [];
for (let p = 960; p <= 1056; p += 4) ISOBAR_LEVELS.push(p);
// → 960 964 968 … 1056  (25 levels)

// Geophysical constants for geostrophic wind
const OMEGA = 7.2921e-5;   // rad/s  Earth angular velocity
const RHO   = 1.225;       // kg/m³  ISA sea-level air density


// ─────────────────────────────────────────────────────────────────────────────
//  Meteorological pressure colour ramp
//  Low (purple/blue) → standard (white, 1013 hPa) → High (orange/red)
// ─────────────────────────────────────────────────────────────────────────────
const COLOR_STOPS = [
    //  hPa    r      g      b
    [  940, 0.50,  0.00,  0.75 ],   // deep purple
    [  960, 0.15,  0.10,  0.90 ],   // indigo
    [  976, 0.05,  0.38,  0.92 ],   // royal blue
    [  992, 0.00,  0.68,  0.88 ],   // cyan-blue
    [ 1004, 0.30,  0.84,  0.92 ],   // light cyan
    [ 1013, 0.95,  0.95,  0.95 ],   // near-white (ISA standard)
    [ 1020, 1.00,  0.92,  0.10 ],   // yellow
    [ 1030, 1.00,  0.52,  0.05 ],   // orange
    [ 1044, 0.85,  0.08,  0.08 ],   // red
    [ 1060, 0.55,  0.00,  0.00 ],   // dark red
];

export function pressureToRGB(hPa) {
    const first = COLOR_STOPS[0];
    const last  = COLOR_STOPS[COLOR_STOPS.length - 1];
    if (hPa <= first[0]) return [first[1], first[2], first[3]];
    if (hPa >= last[0])  return [last[1],  last[2],  last[3]];
    for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
        const [p0, r0, g0, b0] = COLOR_STOPS[i];
        const [p1, r1, g1, b1] = COLOR_STOPS[i + 1];
        if (hPa >= p0 && hPa <= p1) {
            const t = (hPa - p0) / (p1 - p0);
            return [r0 + (r1-r0)*t, g0 + (g1-g0)*t, b0 + (b1-b0)*t];
        }
    }
    return [1, 1, 1];
}

// Opacity by level tier (visual weight for minor vs major isobars)
export function levelOpacity(hPa) {
    if (hPa % 20 === 0) return 1.00;   // e.g. 960, 980, 1000, 1020, 1040 hPa
    if (hPa %  8 === 0) return 0.72;   // e.g. 968, 976, 984, 992 …
    return 0.40;                        // 4-hPa minor isobars
}

// ─────────────────────────────────────────────────────────────────────────────

//  Marching-squares lookup table
//
//  Corners (bit field):  0=BL  1=BR  2=TR  3=TL
//  Edges:                0=bottom(S)  1=right(E)  2=top(N)  3=left(W)
//
//  BL = (cx,   cy)   BR = (cx+1, cy)   TR = (cx+1, cy+1)   TL = (cx, cy+1)
//  (grid row cy is SOUTH of row cy+1 — row 0 = 90°S)
// ─────────────────────────────────────────────────────────────────────────────
const MS_TABLE = [
    [],              // 0000  —
    [[3, 0]],        // 0001  BL
    [[0, 1]],        // 0010  BR
    [[3, 1]],        // 0011  BL + BR
    [[1, 2]],        // 0100  TR
    [[3, 2],[0, 1]], // 0101  BL + TR  (saddle — two segments)
    [[0, 2]],        // 0110  BR + TR
    [[3, 2]],        // 0111  BL + BR + TR
    [[2, 3]],        // 1000  TL
    [[2, 0]],        // 1001  TL + BL
    [[2, 1],[3, 0]], // 1010  TL + BR  (saddle — two segments)
    [[2, 1]],        // 1011  TL + BL + BR
    [[1, 3]],        // 1100  TL + TR
    [[0, 1]],        // 1101  TL + TR + BL  (complement of 0010)
    [[3, 0]],        // 1110  TL + TR + BR  (complement of 0001)
    [],              // 1111  —
];

// ─────────────────────────────────────────────────────────────────────────────

//  Grid utilities
// ─────────────────────────────────────────────────────────────────────────────

// Decode pressure G-channel from weatherBuffer → hPa (row 0 = south)
function decodePressure(buf) {
    const grid = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) grid[k] = buf[k * 4 + 1] * 210 + 850;
    return grid;
}

// 3×3 box blur with longitudinal wrap; returns a new Float32Array
function boxBlur(grid, passes = 3) {
    let src = grid.slice();
    const tmp = new Float32Array(W * H);
    for (let p = 0; p < passes; p++) {
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let s = 0, n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= H) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = ((x + dx) % W + W) % W;
                        s += src[ny * W + nx]; n++;
                    }
                }
                tmp[y * W + x] = s / n;
            }
        }
        src = tmp.slice();
    }
    return src;
}

// Grid-space coords → geographic (lat°, lon°)
// lx ∈ [0, W]  →  lon ∈ [−180°, +180°]
// ly ∈ [0, H]  →  lat ∈ [−90°S, +90°N]
function toLatLon(lx, ly) {
    return {
        lat: (ly / H) * 180 - 90,
        lon: (lx / W) * 360 - 180,
    };
}

// Grid-space coords → a point on the sphere surface, in the canonical
// js/geo/coords.js frame (+X = lon 0, +Y = north, −Z = +90°E) the Earth
// shader and every other overlay use. This is geo.deg.latLonToPosition's
// arithmetic, in the SAME operation order (normal first, then × radius), so
// the geometry is bit-identical to what the three-backed path produced —
// tests/isobar-contour.mjs pins the frame. (The older hand-rolled
// (cos·sin, sin, cos·cos) formula put lines 90° west of their longitude.)
function toXYZ(lx, ly, rUnits, out) {
    const { lat, lon } = toLatLon(lx, ly);
    const la = lat * DEG, lo = lon * DEG;
    const cl = Math.cos(la);
    out.x =  cl * Math.cos(lo) * rUnits;
    out.y =  Math.sin(la) * rUnits;
    out.z = -cl * Math.sin(lo) * rUnits;
    return out;
}
function toVec3(lx, ly) { return toXYZ(lx, ly, R * 1.0025, { x: 0, y: 0, z: 0 }); }

// ─────────────────────────────────────────────────────────────────────────────
//  Marching squares
// ─────────────────────────────────────────────────────────────────────────────

// Linearly interpolate t ∈ [0,1] for the edge crossing v0→v1 at `level`
function lerp01(level, v0, v1) {
    const dv = v1 - v0;
    if (Math.abs(dv) < 1e-4) return 0.5;
    return Math.max(0, Math.min(1, (level - v0) / dv));
}

// Return the fractional grid-space point where edge `e` crosses `level`
// in cell (cx, cy) with corner values vBL, vBR, vTR, vTL.
//   e0 = S edge  (BL→BR, ly=cy,   lx varies)
//   e1 = E edge  (BR→TR, lx=cx+1, ly varies south→north)
//   e2 = N edge  (TR→TL, ly=cy+1, lx varies east→west)
//   e3 = W edge  (TL→BL, lx=cx,   ly varies north→south)
function edgePt(e, cx, cy, vBL, vBR, vTR, vTL, level) {
    switch (e) {
        case 0: { const t = lerp01(level, vBL, vBR); return { lx: cx + t,     ly: cy };     }
        case 1: { const t = lerp01(level, vBR, vTR); return { lx: cx + 1,     ly: cy + t }; }
        case 2: { const t = lerp01(level, vTR, vTL); return { lx: cx + 1 - t, ly: cy + 1 }; }
        case 3: { const t = lerp01(level, vTL, vBL); return { lx: cx,         ly: cy + 1 - t }; }
    }
}

// Run marching squares over the full 359 × 179 cell grid and return
// an array of segments: each segment = [pointA, pointB].
function marchingSquares(grid, level) {
    const segs = [];
    for (let cy = 0; cy < H - 1; cy++) {
        for (let cx = 0; cx < W - 1; cx++) {
            // Corner values (row cy = south, cy+1 = north)
            const vBL = grid[ cy      * W + cx     ];
            const vBR = grid[ cy      * W + cx + 1 ];
            const vTR = grid[(cy + 1) * W + cx + 1 ];
            const vTL = grid[(cy + 1) * W + cx     ];

            const cas = ((vBL > level) ? 1 : 0)
                      | ((vBR > level) ? 2 : 0)
                      | ((vTR > level) ? 4 : 0)
                      | ((vTL > level) ? 8 : 0);

            for (const [eA, eB] of MS_TABLE[cas]) {
                segs.push([
                    edgePt(eA, cx, cy, vBL, vBR, vTR, vTL, level),
                    edgePt(eB, cx, cy, vBL, vBR, vTR, vTL, level),
                ]);
            }
        }
    }
    return segs;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chain assembly — connect isolated segments into continuous polylines
// ─────────────────────────────────────────────────────────────────────────────
const KEY_PREC = 3;   // decimal places for endpoint key (sub-cell accuracy)
function ptKey(p) { return `${p.lx.toFixed(KEY_PREC)},${p.ly.toFixed(KEY_PREC)}`; }

function assembleChains(segs) {
    if (segs.length === 0) return [];

    // Build adjacency: endpoint key → list of segment indices
    const adj = new Map();
    for (let i = 0; i < segs.length; i++) {
        for (const pt of segs[i]) {
            const k = ptKey(pt);
            if (!adj.has(k)) adj.set(k, []);
            adj.get(k).push(i);
        }
    }

    const used   = new Uint8Array(segs.length);
    const chains = [];

    for (let start = 0; start < segs.length; start++) {
        if (used[start]) continue;
        used[start] = 1;

        const chain = [segs[start][0], segs[start][1]];

        // Walk forward from tail
        let limitFwd = segs.length + 2;
        while (limitFwd-- > 0) {
            const tail = chain[chain.length - 1];
            const k    = ptKey(tail);
            let moved  = false;
            for (const si of (adj.get(k) ?? [])) {
                if (used[si]) continue;
                used[si] = 1;
                const [a, b] = segs[si];
                chain.push(ptKey(a) === k ? b : a);
                moved = true;
                break;
            }
            if (!moved) break;
        }

        // Walk backward from head
        let limitBck = segs.length + 2;
        while (limitBck-- > 0) {
            const head = chain[0];
            const k    = ptKey(head);
            let moved  = false;
            for (const si of (adj.get(k) ?? [])) {
                if (used[si]) continue;
                used[si] = 1;
                const [a, b] = segs[si];
                chain.unshift(ptKey(b) === k ? a : b);
                moved = true;
                break;
            }
            if (!moved) break;
        }

        if (chain.length >= 3) chains.push(chain);
    }
    return chains;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Catmull-Rom smoothing
//  Inserts `steps` sub-points between every pair of original chain nodes.
//  With steps=3, a 20-point chain becomes 77 points — very smooth on the globe.
// ─────────────────────────────────────────────────────────────────────────────
function catmullRom(pts, steps) {
    if (steps <= 0 || pts.length < 2) return pts;
    const N   = pts.length;
    const out = [pts[0]];

    for (let i = 0; i < N - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(N - 1, i + 2)];

        for (let s = 1; s <= steps; s++) {
            const t  = s / steps;
            const t2 = t * t, t3 = t2 * t;
            // Uniform Catmull-Rom (α = 0.5 centripetal not needed here; standard)
            out.push({
                lx: 0.5 * (2*p1.lx + (-p0.lx + p2.lx)*t
                    + (2*p0.lx - 5*p1.lx + 4*p2.lx - p3.lx)*t2
                    + (-p0.lx + 3*p1.lx - 3*p2.lx + p3.lx)*t3),
                ly: 0.5 * (2*p1.ly + (-p0.ly + p2.ly)*t
                    + (2*p0.ly - 5*p1.ly + 4*p2.ly - p3.ly)*t2
                    + (-p0.ly + 3*p1.ly - 3*p2.ly + p3.ly)*t3),
            });
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pressure-centre detection (H / L)
// ─────────────────────────────────────────────────────────────────────────────

// Find local maxima (H) and minima (L) on the box-blurred grid.
// WIN controls the search neighbourhood — acts as a spatial filter.
const EXTREMUM_WIN  = 5;    // neighbourhood radius (grid cells)
const LOW_THRESH    = 1006; // only flag as L if below this (hPa)
const HIGH_THRESH   = 1018; // only flag as H if above this (hPa)

function findExtrema(smooth) {
    const extrema = [];
    for (let y = EXTREMUM_WIN; y < H - EXTREMUM_WIN; y++) {
        for (let x = EXTREMUM_WIN; x < W - EXTREMUM_WIN; x++) {
            const v = smooth[y * W + x];
            if (v > LOW_THRESH && v < HIGH_THRESH) continue;  // fast reject

            let isMax = v >= HIGH_THRESH;
            let isMin = v <= LOW_THRESH;

            outer:
            for (let dy = -EXTREMUM_WIN; dy <= EXTREMUM_WIN; dy++) {
                for (let dx = -EXTREMUM_WIN; dx <= EXTREMUM_WIN; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const n = smooth[(y + dy) * W + ((x + dx + W) % W)];
                    if (n >= v) isMax = false;
                    if (n <= v) isMin = false;
                    if (!isMax && !isMin) break outer;
                }
            }

            if (isMax) extrema.push({ x, y, type: 'H', hPa: v });
            if (isMin) extrema.push({ x, y, type: 'L', hPa: v });
        }
    }
    return extrema;
}

// Non-maximum suppression: keep only the most extreme centre within
// `minDist` grid cells, up to `maxKeep` per type.
function nmsExtrema(extrema, minDist = 22, maxKeep = 10) {
    const highs = extrema.filter(e => e.type === 'H').sort((a, b) => b.hPa - a.hPa);
    const lows  = extrema.filter(e => e.type === 'L').sort((a, b) => a.hPa - b.hPa);

    function suppress(list) {
        const kept = [];
        for (const e of list) {
            if (kept.every(k => Math.hypot(k.x - e.x, k.y - e.y) >= minDist)) {
                kept.push(e);
                if (kept.length >= maxKeep) break;
            }
        }
        return kept;
    }
    return [...suppress(highs), ...suppress(lows)];
}



// ─────────────────────────────────────────────────────────────────────────────
//  Pressure gradient statistics
// ─────────────────────────────────────────────────────────────────────────────
const KM_PER_DEG_LAT = 111.0;   // ~constant (meridional)

/**
 * Compute ∂P/∂x and ∂P/∂y using central differences with latitude-correct
 * km scaling.  Returns { maxGrad, maxLat, maxLon } in hPa / 100 km.
 */
function computeGradientStats(grid) {
    let maxGrad = 0, maxLat = 0, maxLon = 0;

    for (let y = 1; y < H - 1; y++) {
        const lat     = (y / H) * 180 - 90;
        const cosLat  = Math.max(Math.cos(lat * DEG), 0.01);  // avoid ÷0 at poles
        const dxKm    = cosLat * 111.32;   // km per 1° longitude at this latitude
        const dyKm    = KM_PER_DEG_LAT;

        for (let x = 1; x < W - 1; x++) {
            const xm = (x - 1 + W) % W, xp = (x + 1) % W;
            // Central finite difference in hPa, divided by 2 × cell-size in 100 km
            const dPdx = (grid[y*W + xp] - grid[y*W + xm]) / (2 * dxKm / 100);
            const dPdy = (grid[(y+1)*W + x] - grid[(y-1)*W + x]) / (2 * dyKm / 100);
            const grad = Math.sqrt(dPdx*dPdx + dPdy*dPdy);
            if (grad > maxGrad) {
                maxGrad = grad;
                maxLat  = lat;
                maxLon  = (x / W) * 360 - 180;
            }
        }
    }
    return { maxGrad, maxLat, maxLon };
}

/**
 * Estimate geostrophic wind speed (m/s) from pressure gradient.
 * V_g = |∇P| / (f × ρ)  where f = 2Ω sin|φ| (Coriolis parameter).
 * Returns null within ±5° of the equator where f → 0.
 *
 * Capped at V_G_MAX_MS to stop procedural / noisy pressure fields from
 * producing wildly non-physical readouts. The real-atmosphere extreme
 * (Mount Washington, top 1 % of jet-stream cores) tops out near 125 m/s;
 * 150 leaves headroom for a genuinely exceptional synoptic event but
 * clamps away e.g. 1800 m/s artefacts that appear when a 75 hPa/100 km
 * gradient shows up in noisy synthetic data.
 *
 * @param {number} gradHPa100km  Max pressure gradient in hPa / 100 km
 * @param {number} latDeg        Geographic latitude in degrees
 */
const V_G_MAX_MS = 150;
export function geoWindMs(gradHPa100km, latDeg) {
    const f = 2 * OMEGA * Math.abs(Math.sin(latDeg * DEG));
    if (f < 1.4e-5) return null;                    // |lat| < ~5.8° — geostrophy breaks down
    const gradPaM = gradHPa100km * 1e-3;           // Pa / m  (1 hPa/100km = 1e-3 Pa/m)
    const raw     = gradPaM / (f * RHO);           // m / s
    return Math.min(raw, V_G_MAX_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
//  IsobarLayer  — Three.js scene management

// ─────────────────────────────────────────────────────────────────────────────
//  The whole pipeline, as IsobarLayer.update ran it (minus three.js objects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Float32Array} weatherBuf  360 × 180 × 4 RGBA buffer
 * @returns {{
 *   positions: Float32Array, colors: Float32Array, segments: number,
 *   extrema: {x:number,y:number,type:'H'|'L',hPa:number,lat:number,lon:number,pos:{x:number,y:number,z:number}}[],
 *   stats: {maxGrad:number,maxLat:number,maxLon:number},
 *   ms: number }}
 */
export function computeIsobars(weatherBuf) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // ── 1. Decode ───────────────────────────────────────────────────────
    const grid = decodePressure(weatherBuf);

    // ── 2. Gradient statistics (on raw grid, before blur) ───────────────
    const stats = computeGradientStats(grid);

    // ── 3. Marching squares + chain assembly for all levels ─────────────
    const positions = [];
    const colors    = [];

    for (const level of ISOBAR_LEVELS) {
        const [r, g, b] = pressureToRGB(level);
        const alpha     = levelOpacity(level);
        // Premultiply opacity into vertex colour (material opacity = 1)
        const cr = r * alpha, cg = g * alpha, cb = b * alpha;

        // Smoothing steps by tier: more for major levels (20 hPa multiples)
        const steps = (level % 20 === 0) ? 3
                    : (level %  8 === 0) ? 2
                    :                      1;

        const segs   = marchingSquares(grid, level);
        const chains = assembleChains(segs);

        for (const chain of chains) {
            if (chain.length < 3) continue;
            const smooth = catmullRom(chain, steps);

            for (let i = 0; i < smooth.length - 1; i++) {
                const v0 = toVec3(smooth[i  ].lx, smooth[i  ].ly);
                const v1 = toVec3(smooth[i+1].lx, smooth[i+1].ly);

                // Skip segments that span a large arc — antimeridian artefacts
                // (THREE.Vector3.distanceTo's arithmetic: sqrt of Σ d²).
                const dx = v0.x - v1.x, dy = v0.y - v1.y, dz = v0.z - v1.z;
                if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 0.30) continue;

                positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
                colors.push(cr, cg, cb, cr, cg, cb);
            }
        }
    }

    // ── 4. H / L pressure centres ───────────────────────────────────────
    const blurred = boxBlur(grid, 3);
    const extrema = nmsExtrema(findExtrema(blurred)).map((e) => {
        const { lat, lon } = toLatLon(e.x, e.y);
        return { ...e, lat, lon, pos: toXYZ(e.x, e.y, R * 1.016, { x: 0, y: 0, z: 0 }) };
    });

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return {
        positions: new Float32Array(positions),
        colors:    new Float32Array(colors),
        segments:  positions.length / 6,
        extrema,
        stats,
        ms: t1 - t0,
    };
}

// Exposed for the node gate (internal pieces, unchanged behaviour).
export const _internals = { decodePressure, boxBlur, marchingSquares, assembleChains, catmullRom, findExtrema, nmsExtrema, computeGradientStats, toLatLon, toXYZ };
