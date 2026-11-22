/**
 * js/bz/spectrum.js — band powers and structure measures of a field series (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B1 (§4.1). No DOM, no fetch, no ambient time.
 *
 * WHAT A 1-MINUTE SERIES CAN AND CANNOT SAY: its Nyquist frequency is 8.33 mHz,
 * so the Pc5 band (1.7–6.7 mHz) is resolved and nothing faster is. The same
 * functions take the 1-second ground series (B5) unchanged — `dtS` is an
 * input, never assumed — and BANDS are filtered to what the cadence resolves:
 * a band above Nyquist is REPORTED as unresolved, never as zero power.
 *
 * GAPS: a Welch segment containing a single NaN is DROPPED, not patched.
 * Interpolating across a gap manufactures low-frequency power (the engine's
 * standing rule, plan §8.4). `segments` in the result says how much data the
 * estimate actually rests on.
 *
 * Normalisation is the one that makes Parseval exact: the one-sided PSD in
 * nT²/Hz integrates to the series' variance, and tests/bz-l1.mjs holds it to
 * that on white noise and on a pure tone.
 */

/** Frequency bands, Hz. Names are the conventional ULF classes. */
export const BANDS = Object.freeze([
    { id: 'slow',  label: '0.1–0.5 mHz (33–170 min)', lo: 1e-4,   hi: 5e-4 },
    { id: 'meso',  label: '0.5–1.7 mHz (10–33 min)',  lo: 5e-4,   hi: 1.7e-3 },
    { id: 'pc5',   label: 'Pc5 1.7–6.7 mHz (2.5–10 min)', lo: 1.7e-3, hi: 6.7e-3 },
    { id: 'pc4',   label: 'Pc4 6.7–22 mHz (45–150 s)',  lo: 6.7e-3, hi: 2.2e-2 },
    { id: 'pc3',   label: 'Pc3 22–100 mHz (10–45 s)',   lo: 2.2e-2, hi: 1e-1 },
]);

/** In-place radix-2 FFT (re, im of power-of-two length). */
export function fft(re, im) {
    const n = re.length;
    if (n & (n - 1)) throw new Error('fft length must be a power of two');
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
}

/**
 * Welch PSD with a Hann window and 50 % overlap over GAP-FREE segments.
 * @param {ArrayLike<number>} x   series, NaN = gap
 * @param {number} dtS            sample spacing, seconds
 * @param {{ nfft?: number }} [opts] segment length (power of two; default 128)
 * @returns {{ freq:Float64Array, psd:Float64Array, segments:number, df:number, nyquist:number } | null}
 */
export function welchPsd(x, dtS, { nfft = 128 } = {}) {
    const hop = nfft >> 1;
    const win = new Float64Array(nfft);
    let wss = 0;
    for (let i = 0; i < nfft; i++) { win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / nfft)); wss += win[i] * win[i]; }
    const half = nfft / 2;
    const acc = new Float64Array(half + 1);
    let segments = 0;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let s = 0; s + nfft <= x.length; s += hop) {
        let mean = 0, ok = true;
        for (let i = 0; i < nfft; i++) { const v = x[s + i]; if (v !== v) { ok = false; break; } mean += v; }
        if (!ok) continue;
        mean /= nfft;
        for (let i = 0; i < nfft; i++) { re[i] = (x[s + i] - mean) * win[i]; im[i] = 0; }
        fft(re, im);
        for (let k = 0; k <= half; k++) {
            const p = (re[k] * re[k] + im[k] * im[k]) * dtS / wss;      // two-sided, nT²/Hz
            acc[k] += (k === 0 || k === half) ? p : 2 * p;              // fold to one-sided
        }
        segments++;
    }
    if (!segments) return null;
    const df = 1 / (nfft * dtS);
    const freq = new Float64Array(half + 1), psd = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) { freq[k] = k * df; psd[k] = acc[k] / segments; }
    return { freq, psd, segments, df, nyquist: 0.5 / dtS };
}

/**
 * Power (nT²) in each band, and its square root as an RMS amplitude (nT).
 * A band is `resolved` only if it lies wholly between the first non-zero
 * frequency bin and Nyquist; an unresolved band carries null, never 0.
 */
export function bandPowers(x, dtS, opts = {}) {
    const p = welchPsd(x, dtS, opts);
    const bands = opts.bands ?? BANDS;
    if (!p) return { segments: 0, nyquist_hz: 0.5 / dtS, df_hz: null, bands: bands.map((b) => ({ id: b.id, label: b.label, resolved: false, power: null, rms: null })) };
    const out = [];
    for (const b of bands) {
        const resolved = b.lo >= p.df && b.hi <= p.nyquist * 1.0001;
        if (!resolved) { out.push({ id: b.id, label: b.label, resolved: false, power: null, rms: null }); continue; }
        let pow = 0;
        for (let k = 1; k < p.freq.length; k++) {
            // each bin owns [f − df/2, f + df/2]; take its overlap with the band
            const lo = Math.max(b.lo, p.freq[k] - p.df / 2), hi = Math.min(b.hi, p.freq[k] + p.df / 2);
            if (hi > lo) pow += p.psd[k] * (hi - lo);
        }
        out.push({ id: b.id, label: b.label, resolved: true, power: pow, rms: Math.sqrt(pow) });
    }
    return { segments: p.segments, nyquist_hz: p.nyquist, df_hz: p.df, bands: out };
}

function variance(x, i0, i1) {
    let n = 0, s = 0, s2 = 0;
    for (let i = i0; i < i1; i++) { const v = x[i]; if (v === v) { n++; s += v; s2 += v * v; } }
    return n >= 8 ? { n, v: Math.max(0, s2 / n - (s / n) ** 2) } : null;
}

/**
 * Magnetic compressibility C = var(|B|) / (var Bx + var By + var Bz) over a
 * window. Alfvénic fluctuations turn the field without changing its strength
 * (C → 0); compressive structures and discontinuities change |B| (C → 1).
 * It is a FIELD-ONLY proxy: true Alfvénicity needs the plasma velocity
 * (δv ∥ δB), which is B2's input — this never calls itself Alfvénicity.
 * Only minutes where all four series are present are used.
 */
export function compressibility(g, i0 = 0, i1 = g.bz.length) {
    const m = { bx: [], by: [], bz: [], bt: [] };
    for (let i = Math.max(0, i0); i < Math.min(i1, g.bz.length); i++) {
        if (g.bx[i] === g.bx[i] && g.by[i] === g.by[i] && g.bz[i] === g.bz[i] && g.bt[i] === g.bt[i]) {
            m.bx.push(g.bx[i]); m.by.push(g.by[i]); m.bz.push(g.bz[i]); m.bt.push(g.bt[i]);
        }
    }
    const vt = variance(m.bt, 0, m.bt.length);
    const vx = variance(m.bx, 0, m.bx.length), vy = variance(m.by, 0, m.by.length), vz = variance(m.bz, 0, m.bz.length);
    if (!vt || !vx || !vy || !vz) return null;
    const tot = vx.v + vy.v + vz.v;
    return tot > 0 ? { n: vt.n, c: vt.v / tot, var_total: tot, var_mag: vt.v } : null;
}
