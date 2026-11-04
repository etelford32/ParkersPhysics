/**
 * Gate for js/frequency-analysis.js (NAFF). Every assertion is against a
 * signal whose decomposition is known exactly.
 */
import assert from 'node:assert/strict';
import { fft, hannWindow, project, naff, binWidth } from '../js/frequency-analysis.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

// FFT against a direct DFT.
{
    const n = 16, re = Float64Array.from({ length: n }, (_, k) => Math.sin(k * 0.7) + 0.3 * k), im = Float64Array.from({ length: n }, (_, k) => Math.cos(k * 1.3));
    const r = re.slice(), i = im.slice(); fft(r, i);
    for (let f = 0; f < n; f++) {
        let sr = 0, si = 0;
        for (let k = 0; k < n; k++) { const a = -2 * Math.PI * f * k / n; sr += re[k] * Math.cos(a) - im[k] * Math.sin(a); si += re[k] * Math.sin(a) + im[k] * Math.cos(a); }
        near(r[f], sr, 1e-9, `fft re[${f}]`); near(i[f], si, 1e-9, `fft im[${f}]`);
    }
    const w = hannWindow(101); near(w.reduce((s, x) => s + x, 0) / 101, 1, 0.011, 'Hann mean ≈ 1');
}

// Three known lines (incl. a constant) over only ~4 cycles of the strongest.
const series = (n, dt, lines) => {
    const re = new Float64Array(n), im = new Float64Array(n), c = (n - 1) / 2;
    for (let k = 0; k < n; k++) {
        const t = (k - c) * dt;
        for (const [A, nu, ph] of lines) { re[k] += A * Math.cos(nu * t + ph); im[k] += A * Math.sin(nu * t + ph); }
    }
    return { re, im };
};
{
    const lines = [[12.5, 2 * Math.PI / 150.3, 0.4], [3, -2 * Math.PI / 37.7, -1], [0.7, 0, 0]];
    const { re, im } = series(601, 1, lines);
    const out = naff(re, im, 1, { terms: 3 });
    near(2 * Math.PI / out[0].nu, 150.3, 1e-5, 'strongest line period (4 cycles in the record)');
    near(out[0].amp, 12.5, 1e-5, 'strongest amplitude'); near(out[0].phase, 0.4, 1e-5, 'phase referred to the record centre');
    near(2 * Math.PI / out[1].nu, -37.7, 1e-5, 'retrograde line'); near(out[1].amp, 3, 1e-5, '2nd amplitude');
    near(out[2].nu, 0, 1e-8, 'constant term'); near(out[2].amp, 0.7, 1e-5, 'constant amplitude');
    // NEGATIVE CONTROL: without the refinement pass the leakage of the other
    // lines biases the frequency by ~1e-4 relative (the reason `refine` exists).
    const raw = naff(re, im, 1, { terms: 3, refine: 0 });
    assert.ok(Math.abs(2 * Math.PI / raw[0].nu - 150.3) > 1e-3, `unrefined NAFF is visibly biased (${2 * Math.PI / raw[0].nu})`);
}
// A REAL cosine appears as a ± pair of half-amplitude lines.
{
    const n = 400, re = Float64Array.from({ length: n }, (_, k) => 8 * Math.cos(2 * Math.PI * (k - 199.5) / 50 + 0.2));
    const out = naff(re, null, 1, { terms: 2 });
    // A maximum's location is only resolvable to ~√(rounding noise) of the
    // objective: ~1e-8 relative with the phasor recurrence — 10⁴× finer than
    // any physical use (libration f is compared at 1e-4).
    near(Math.abs(out[0].nu), 2 * Math.PI / 50, 1e-8, '|ν|'); near(out[0].amp, 4, 1e-6, 'half amplitude'); near(out[1].amp, 4, 1e-6, 'its mirror');
    assert.ok(Math.sign(out[0].nu) === -Math.sign(out[1].nu));
    const w = hannWindow(n); const p = project(re, new Float64Array(n), w, 2 * Math.PI / 50, 1);
    // A single projection still carries the mirror line's Hann leakage (~1e-5 here); NAFF's subtraction removes it.
    near(2 * Math.hypot(p.re, p.im), 8, 2e-4, 'projection recovers the cosine amplitude');
    near(binWidth(401, 2), 2 * Math.PI / 800, 1e-15, 'bin width = 2π / span');
}
console.log('frequency-analysis: FFT, Hann window, NAFF lines/amplitudes/phases, refinement (with negative control), real-signal pairs passed');
