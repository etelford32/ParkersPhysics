/**
 * beachball-view.js — draws an event's focal mechanism (DOM canvas only;
 * every number is radiation.js). Lower-hemisphere equal-area, north up,
 * compressional quadrants shaded; each arrival is marked where ITS ray leaves
 * the focus (an up-going ray plots at its antipode, which carries the same
 * R_P — the standard convention, stated in the caption).
 */
import { beachballGrid, projectLowerHemisphere } from './radiation.js';

const WAVE = { P: '#3987e5', S: '#d95926' };

export function drawBeachball(canvas, mHat, marks = [], { px = 132 } = {}) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(px * dpr); canvas.height = Math.round(px * dpr);
    canvas.style.width = `${px}px`; canvas.style.height = `${px}px`;
    const g = canvas.getContext('2d');
    const pad = 16 * dpr, R = canvas.width / 2 - pad, cx = canvas.width / 2, cy = canvas.height / 2;
    const n = Math.round(2 * R);
    const grid = beachballGrid(mHat, n);
    const img = g.createImageData(n, n);
    const comp = [196, 206, 222], dil = [16, 24, 40];
    for (let k = 0; k < grid.length; k++) {
        if (!grid[k]) continue;
        const c = grid[k] > 0 ? comp : dil;
        img.data.set([c[0], c[1], c[2], 255], 4 * k);
    }
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.putImageData(img, Math.round(cx - n / 2), Math.round(cy - n / 2));
    g.strokeStyle = '#8aa0bf'; g.lineWidth = 1.2 * dpr;
    g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.stroke();
    g.fillStyle = '#8aa0bf'; g.font = `${10 * dpr}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText('N', cx, cy - R - 2 * dpr);
    // Take-off marks: P-recorded filled, S-recorded ringed; labels skip when crowded.
    const placed = [];
    for (const m of marks) {
        const q = projectLowerHemisphere(m.takeoffRad, m.azimuthRad);
        const x = cx + q.x * R, y = cy - q.y * R;
        g.beginPath(); g.arc(x, y, 3.2 * dpr, 0, 2 * Math.PI);
        g.lineWidth = 1.6 * dpr;
        if (m.recorded === 'S') { g.strokeStyle = WAVE.S; g.fillStyle = '#0b1322'; g.fill(); g.stroke(); }
        else { g.fillStyle = WAVE.P; g.strokeStyle = '#0b1322'; g.fill(); g.stroke(); }
        if (placed.every(([a, b]) => Math.hypot(a - x, b - y) > 14 * dpr)) {
            placed.push([x, y]);
            g.font = `600 ${9.5 * dpr}px system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
            g.lineWidth = 3 * dpr; g.strokeStyle = '#0b1322'; g.strokeText(m.phase, x + 5 * dpr, y);
            g.fillStyle = '#e8eef8'; g.fillText(m.phase, x + 5 * dpr, y);
        }
    }
}
