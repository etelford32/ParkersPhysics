/**
 * terrain-temp.js — GFS 2 m temperature brought down to the REAL ground. PURE.
 *
 * GFS is a 0.25° (~25 km) model: its "surface" is a smoothed terrain in which
 * a 4 000 m range and the valley beside it are one gentle slope, and its 2 m
 * temperature belongs to THAT surface. Interpolating it between nodes gives a
 * map with no mountains in it. This module adds them back with one physical
 * correction, the oldest downscaling there is:
 *
 *     T(real ground) = T_gfs(interpolated) + Γ · (z_dem − z_gfs)
 *
 *   z_gfs   the model's own surface height. The archive does not carry GFS's
 *           orography, but it carries both pressures the model gives its
 *           surface: p_sfc (at the model ground) and MSLP (reduced to sea
 *           level). The hypsometric equation between them IS the model height
 *           (modelElevationM). It is as good as GFS's own sea-level reduction —
 *           tens of metres over high ground — which is small against the
 *           hundreds-to-thousands of metres being corrected, and is disclosed.
 *   Γ       the near-surface lapse rate, FITTED from the run at the instant on
 *           show: a least-squares plane T = a + b·x + c·y + Γ·z over the
 *           window's own nodes (fitLapse). A fixed −6.5 K/km is wrong at
 *           exactly the times terrain matters most — a clear night's cold pool
 *           has Γ near 0 or POSITIVE (an inversion: valleys colder than the
 *           slopes above them). The horizontal terms are in the fit because
 *           high ground is not randomly placed: without them a west–east
 *           temperature gradient across a range is read as a lapse rate (the
 *           gate's negative control). Where the window has too little relief
 *           to say (span < MIN_SPAN_M, or too few nodes) the standard
 *           atmosphere's −6.5 is used and the result says so.
 *
 * WHAT IT IS NOT: a model run at DEM resolution. One Γ per instant for the
 * whole window; no cold-air drainage, no sun-facing-slope warming (the slope
 * layers estimate those separately), no lake or urban effects. It is GFS's
 * forecast with the height error removed, and every surface says "terrain
 * detail" when it is on.
 *
 * Node gate: tests/climalytix-terrain-temp.mjs.
 */
const RD = 287.05, G0 = 9.80665;
export const STANDARD_LAPSE_K_PER_KM = -6.5;
export const LAPSE_BOUNDS = Object.freeze({ min: -9.8, max: 5 });   // dry adiabat … a strong surface inversion
export const MIN_SPAN_M = 400;
export const MIN_NODES = 16;

/**
 * Height of the model surface (m) from its two pressures and its 2 m
 * temperature. The layer-mean temperature assumes the standard lapse between
 * the surface and sea level (what a sea-level reduction does); two fixed-point
 * passes settle it to < 1 m.
 */
export function modelElevationM(mslHpa, psfcHpa, tempC) {
    if (!(mslHpa > 0) || !(psfcHpa > 0) || !Number.isFinite(tempC)) return NaN;
    const tK = tempC + 273.15, ln = Math.log(mslHpa / psfcHpa);
    let z = (RD * tK / G0) * ln;
    for (let k = 0; k < 3; k++) z = (RD * (tK + 0.5 * 0.0065 * z) / G0) * ln;
    return z;
}

/** Solve a small dense symmetric system by Gaussian elimination with pivoting; null if singular. */
function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = c + 1; r < n; r++) {
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
        x[r] = s / M[r][r];
    }
    return x;
}

/**
 * The lapse rate of one instant from the window's own nodes.
 * @param {{x:number,y:number,z:number,t:number}[]} nodes  x/y any linear horizontal coordinate (deg), z metres, t °C
 * @param {object} [o]  o.horizontal=false drops the b·x + c·y terms (the NEGATIVE CONTROL)
 * @returns {{ gamma:number, source:'fitted'|'standard', reason?:string, n:number, spanM:number, r2:number|null, raw:number|null }}
 *          gamma in K/km (negative = colder with height)
 */
export function fitLapse(nodes, { horizontal = true } = {}) {
    const ok = (nodes || []).filter((p) => [p.x, p.y, p.z, p.t].every(Number.isFinite));
    const n = ok.length;
    let zLo = Infinity, zHi = -Infinity;
    for (const p of ok) { if (p.z < zLo) zLo = p.z; if (p.z > zHi) zHi = p.z; }
    const spanM = n ? zHi - zLo : 0;
    const std = (reason) => ({ gamma: STANDARD_LAPSE_K_PER_KM, source: 'standard', reason, n, spanM, r2: null, raw: null });
    if (n < MIN_NODES) return std('too few grid nodes in view');
    if (spanM < MIN_SPAN_M) return std('too little relief in view');
    // Centre every column: the normal equations stay well conditioned.
    const mean = (k) => ok.reduce((a, p) => a + p[k], 0) / n;
    const mx = mean('x'), my = mean('y'), mz = mean('z'), mt = mean('t');
    const cols = horizontal ? ['x', 'y', 'z'] : ['z'];
    const c0 = { x: mx, y: my, z: mz };
    const A = cols.map(() => cols.map(() => 0)), b = cols.map(() => 0);
    for (const p of ok) {
        const v = cols.map((k) => p[k] - c0[k]);
        for (let i = 0; i < cols.length; i++) {
            b[i] += v[i] * (p.t - mt);
            for (let j = 0; j < cols.length; j++) A[i][j] += v[i] * v[j];
        }
    }
    const sol = solve(A, b);
    if (!sol) return std('the fit is singular');
    let ssRes = 0, ssTot = 0;
    for (const p of ok) {
        const pred = cols.reduce((a, k, i) => a + sol[i] * (p[k] - c0[k]), 0);
        ssRes += (p.t - mt - pred) ** 2; ssTot += (p.t - mt) ** 2;
    }
    const raw = sol[cols.length - 1] * 1000;        // K per km
    if (!Number.isFinite(raw)) return std('the fit did not converge');
    const gamma = Math.max(LAPSE_BOUNDS.min, Math.min(LAPSE_BOUNDS.max, raw));
    return { gamma, source: 'fitted', n, spanM, r2: ssTot > 0 ? 1 - ssRes / ssTot : null, raw };
}

/** The correction itself. */
export function downscaleT(tModelC, zModelM, zDemM, gammaKPerKm) {
    if (![tModelC, zModelM, zDemM, gammaKPerKm].every(Number.isFinite)) return NaN;
    return tModelC + gammaKPerKm * (zDemM - zModelM) / 1000;
}

/**
 * Downscale onto a DEM grid: values[k] = T at the DEM node's real height.
 * `tAt(lat, lon)` / `zModelAt(lat, lon)` sample the model (null/NaN = gap → NaN out; a gap is never 0).
 * Returns a field in the DEM's own grid shape (one time plane) + the largest corrections.
 */
export function downscaleGrid(dem, { tAt, zModelAt, gamma }) {
    const values = new Float32Array(dem.nRows * dem.nCols).fill(NaN);
    let dLo = Infinity, dHi = -Infinity;
    for (let i = 0; i < dem.nRows; i++) {
        const lat = dem.latN - i * dem.dlat;
        for (let j = 0; j < dem.nCols; j++) {
            const k = i * dem.nCols + j, zd = dem.values[k];
            if (!Number.isFinite(zd)) continue;
            const lon = dem.lonW + j * dem.dlon;
            const t = tAt(lat, lon), zm = zModelAt(lat, lon);
            if (t == null || zm == null) continue;
            const v = downscaleT(t, zm, zd, gamma);
            if (!Number.isFinite(v)) continue;
            values[k] = v;
            const d = v - t;
            if (d < dLo) dLo = d;
            if (d > dHi) dHi = d;
        }
    }
    return { latN: dem.latN, lonW: dem.lonW, dlat: dem.dlat, dlon: dem.dlon, nRows: dem.nRows, nCols: dem.nCols,
             values, correction: dLo <= dHi ? { min: dLo, max: dHi } : null };
}

/** "−6.1 K/km, fitted from 1 089 nodes" / "standard −6.5 K/km (too little relief in view)". */
export function lapseText(fit) {
    const g = `${fit.gamma > 0 ? '+' : fit.gamma < 0 ? '−' : ''}${Math.abs(fit.gamma).toFixed(1)} K/km`;
    if (fit.source !== 'fitted') return `standard ${g} (${fit.reason})`;
    const kind = fit.gamma > 0 ? ' — an inversion: colder below' : fit.gamma > -2 ? ' — nearly isothermal' : '';
    return `${g} fitted from this run’s ${fit.n.toLocaleString('en-US')} nodes in view${kind}`;
}
