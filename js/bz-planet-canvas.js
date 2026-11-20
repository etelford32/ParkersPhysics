/**
 * js/bz-planet-canvas.js — bz.html's hero canvas: Bz at the planet, right now.
 *
 * A RENDERER. Every position, boundary, tilt and value it draws comes from
 * js/bz/planet-view.js `sceneModel`; this file turns that into pixels and
 * nothing else (tests/bz-planet.mjs reads this source and fails on a boundary
 * formula or a trig call here).
 *
 *   const view = mountPlanet(canvas, tipEl, () => sceneModel({...}));
 *   view.refresh();        // data changed
 *
 * What moves: the arrows are re-placed from the clock every few seconds, so
 * they really do creep toward Earth at the wind's speed (about one arrow
 * spacing every two minutes). The thin flow streaks are ILLUSTRATIVE motion —
 * they say "this way", at no physical speed — and are off under
 * prefers-reduced-motion. The page's caption says both.
 *
 * Colour is never the only carrier: north points up and is blue, south points
 * down and is orange; measured arrows are filled, forecast arrows are hollow.
 */
import { VIEW } from './bz/planet-view.js';
import { INK, num } from './bz/page-model.js';

export const PLANET_COLORS = Object.freeze({ north: '#3987e5', south: '#d95926', shock: '#c3c2b7', pause: '#f0efec', bg: '#060912' });
const SCENE_MS = 5000, FRAME_MS = 50;

export function mountPlanet(canvas, tip, sceneFn) {
    const ctx = canvas.getContext('2d');
    const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scene = null, W = 0, H = 0, ppr = 1, hits = [], raf = 0, lastScene = 0, lastFrame = 0, visible = true, t0 = performance.now();

    const X = (u) => u * W;
    const xRe = (x) => X(scene.layout.uOfRe(x));
    const Z = (z) => H / 2 - z * ppr;
    const colorOf = (bz) => (bz < 0 ? PLANET_COLORS.south : PLANET_COLORS.north);
    const utc = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UT`;

    function size() {
        const w = Math.max(280, Math.round(canvas.parentElement.clientWidth));
        if (!scene) return;
        W = w; ppr = W / scene.layout.rePerUnitNear;
        H = Math.round(Math.max(230, Math.min(420, 38 * ppr)));
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
            canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
            canvas.style.height = `${H}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function text(s, x, y, { color = INK.muted, align = 'left', size: px = 11, weight = 400 } = {}) {
        ctx.font = `${weight} ${px}px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = align; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = PLANET_COLORS.bg; ctx.strokeText(s, x, y);
        ctx.fillStyle = color; ctx.fillText(s, x, y);
    }

    /** A vertical arrow from the axis: up = north. `hollow` = forecast. */
    function arrow(x, bz, { hollow = false, width = 2, alpha = 1 } = {}) {
        const full = 0.36 * H, len = Math.max(3, Math.min(1, Math.abs(bz) / scene.arrowFullNt) * full), dir = bz < 0 ? 1 : -1;
        const y0 = H / 2, y1 = y0 + dir * len, head = Math.min(6, len * 0.6);
        ctx.globalAlpha = alpha; ctx.strokeStyle = colorOf(bz); ctx.fillStyle = colorOf(bz); ctx.lineWidth = width;
        if (hollow) ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1 - dir * head); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x - head * 0.62, y1 - dir * head); ctx.lineTo(x + head * 0.62, y1 - dir * head); ctx.closePath();
        if (hollow) { ctx.lineWidth = 1.25; ctx.stroke(); } else ctx.fill();
        ctx.globalAlpha = 1;
        return y1;
    }

    function poly(points, { mirror = false, close = false } = {}) {
        ctx.beginPath();
        points.forEach(([x, z], i) => (i ? ctx.lineTo(xRe(x), Z(z)) : ctx.moveTo(xRe(x), Z(z))));
        if (mirror) for (let i = points.length - 1; i >= 0; i--) ctx.lineTo(xRe(points[i][0]), Z(-points[i][1]));
        if (close) ctx.closePath();
    }

    /** The bow shock's x (px) at a height z (R_E), read off the scene's own curve. */
    function shockX(z) {
        const c = scene.boundaries?.bowShock;
        if (!c) return xRe(VIEW.NEAR_RE);
        for (let i = 1; i < c.length; i++) if (c[i][1] >= Math.abs(z)) return xRe(c[i][0]);
        return W;
    }

    function draw(now) {
        if (!scene) return;
        const L = scene.layout, narrow = W < 620, cy = H / 2;
        hits = [];
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = PLANET_COLORS.bg; ctx.fillRect(0, 0, W, H);

        // ── zones ────────────────────────────────────────────────────────
        if (L.hasForecast) {
            ctx.fillStyle = 'rgba(240,239,236,0.035)'; ctx.fillRect(0, 0, X(L.f0), H);
            text('CME FORECAST — not measured', 10, 14, { size: 10 });
            for (const h of [6, 12, 18, 24]) if (h <= L.forecastHours) {
                const x = X(L.uOfHoursAhead(h));
                ctx.strokeStyle = INK.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, H - 18); ctx.lineTo(x, H - 12); ctx.stroke();
                text(`+${h} h`, Math.max(14, x), H - 7, { align: 'center', size: 10 });
            }
        }
        ctx.strokeStyle = INK.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
        // distance ticks (R_E from Earth)
        for (const r of [200, 150, 100, 50, 20, 10, -10, -20]) {
            if (r > L.l1XRe || (narrow && (r === 150 || r === 50 || r === 10 || r === -10))) continue;
            const x = xRe(r);
            ctx.beginPath(); ctx.moveTo(x, H - 18); ctx.lineTo(x, H - 12); ctx.stroke();
            text(`${Math.abs(r)}`, x, H - 7, { align: 'center', size: 10 });
        }
        text('R_E', xRe(0), H - 7, { align: 'center', size: 10 });
        // the scale break
        const xb = xRe(VIEW.NEAR_RE);
        ctx.strokeStyle = INK.axis; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(xb, 8); ctx.lineTo(xb, H - 22); ctx.stroke(); ctx.setLineDash([]);
        if (!narrow) text(`← compressed ×${L.compression.toFixed(1)}   true scale →`, xb, 14, { align: 'center', size: 10 });

        // ── illustrative flow streaks (upstream of the shock only) ─────────
        if (motion) {
            const phase = ((now - t0) / 1000) * 26;
            ctx.strokeStyle = 'rgba(195,194,183,0.16)'; ctx.lineWidth = 1;
            for (let row = -4; row <= 4; row++) {
                if (!row) continue;
                const y = cy + row * (H / 10.5), x1 = Math.min(shockX((cy - y) / ppr), W) - 4, xStart = X(L.f0);
                for (let k = 0; k < 9; k++) {
                    const x = xStart + ((phase + k * 140 + row * 37) % Math.max(60, x1 - xStart));
                    if (x + 16 < x1) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 16, y); ctx.stroke(); }
                }
            }
        }

        // ── boundaries ───────────────────────────────────────────────────
        if (scene.boundaries) {
            const b = scene.boundaries;
            poly(b.magnetopause, { mirror: true });
            ctx.fillStyle = 'rgba(57,135,229,0.06)'; ctx.fill();
            poly(b.bowShock); ctx.strokeStyle = PLANET_COLORS.shock; ctx.lineWidth = 1.25; ctx.setLineDash([6, 4]); ctx.stroke();
            poly(b.bowShock.map(([x, z]) => [x, -z])); ctx.stroke(); ctx.setLineDash([]);
            poly(b.magnetopause); ctx.strokeStyle = PLANET_COLORS.pause; ctx.lineWidth = 1.5; ctx.stroke();
            poly(b.magnetopause.map(([x, z]) => [x, -z])); ctx.stroke();
            const at = (curve, zWant) => curve.find(([, z]) => z >= zWant) ?? curve[curve.length - 1];
            const zLab = Math.min(15, (cy - 30) / ppr);
            const sp = at(b.bowShock, zLab), mp = at(b.magnetopause, zLab * 0.72);
            text(narrow ? 'bow shock' : `bow shock · nose ${num(b.bowNoseRe, 1)} R_E`, xRe(sp[0]) - 6, Z(sp[1]), { align: 'right', color: INK.secondary });
            text(narrow ? 'magnetopause' : `magnetopause · ${num(b.r0Re, 1)} R_E`, xRe(mp[0]) + 8, Z(mp[1]) - 2, { color: INK.primary });
        }

        // ── the planet: dipole (orientation only), disc, terminator ────────
        ctx.strokeStyle = 'rgba(137,135,129,0.5)'; ctx.lineWidth = 1;
        for (const ln of scene.dipole.lines) for (const seg of ln.segments) { poly(seg); ctx.stroke(); }
        const ex = xRe(0), er = Math.max(3, ppr);
        ctx.beginPath(); ctx.arc(ex, cy, er, 0, Math.PI * 2); ctx.fillStyle = '#18233a'; ctx.fill();
        ctx.beginPath(); ctx.arc(ex, cy, er, Math.PI / 2, Math.PI * 1.5); ctx.fillStyle = '#9db8e0'; ctx.fill(); // sunlit half faces the Sun (left)
        const [ax, az] = scene.dipole.axis;
        ctx.strokeStyle = INK.primary; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(xRe(-1.9 * ax), Z(-1.9 * az)); ctx.lineTo(xRe(1.9 * ax), Z(1.9 * az)); ctx.stroke();

        // ── GOES ─────────────────────────────────────────────────────────
        scene.goes.forEach((g, i) => {
            const x = xRe(g.xRe), up = i % 2 === 0, ly = cy + (up ? -1 : 1) * Math.max(26, 4.2 * ppr);
            if (!narrow) { ctx.strokeStyle = INK.muted; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x, ly + (up ? 7 : -7)); ctx.stroke(); }
            ctx.fillStyle = INK.primary; ctx.beginPath(); ctx.moveTo(x, cy - 4); ctx.lineTo(x + 4, cy); ctx.lineTo(x, cy + 4); ctx.lineTo(x - 4, cy); ctx.closePath(); ctx.fill();
            if (!narrow) text(`${g.name} ${num(g.hp, 1, { sign: true })} nT`, x + 6, ly, { color: INK.primary });
            hits.push({ x, y: cy, r: 10, html: `<b>${g.name} · measured</b>north component minus the core field: ${num(g.hp, 1, { sign: true })} nT<br>local time ${num(g.localTimeH, 1)} h — out of this plane` });
        });

        // ── measured wind in transit ───────────────────────────────────────
        const w = narrow ? 1.5 : 2;
        scene.parcels.forEach((p, i) => {
            const x = xRe(p.xRe);
            if (narrow && i % 2) return; // a phone shows every other minute; the list is unchanged
            arrow(x, p.bz, { width: w });
            hits.push({ x, y: cy, r: 7, band: true, html: `<b>Measured at L1 ${utc(p.seenAt)}</b>Bz ${num(p.bz, 2, { sign: true })} nT<br>reaches the bow shock ${utc(p.arrives)} — in ${num(p.minutesAway, 0)} min` });
        });
        ctx.fillStyle = INK.muted;
        for (const p of scene.parcels) { ctx.beginPath(); ctx.arc(xRe(p.xRe), cy, 1.2, 0, Math.PI * 2); ctx.fill(); }

        // ── inside the shock: the compressed field, and the rate at the nose ─
        if (scene.sheath && scene.sheath.bz != null) {
            const x = xRe(scene.sheath.xRe), y1 = arrow(x, scene.sheath.bz, { width: 3 });
            void y1; // the label sits on the arrow's BASE side so it never lands on the rate label below the axis
            text(`sheath ${num(scene.sheath.bz, 1, { sign: true })} nT`, x, cy + (scene.sheath.bz < 0 ? -12 : 12), { align: 'center', color: INK.primary });
            hits.push({ x, y: cy, r: 9, band: true, html: `<b>Magnetosheath · estimated</b>Bz ${num(scene.sheath.bz, 1, { sign: true })} nT just inside the shock<br>the arriving field compressed ×${num(scene.sheath.ratio, 1)} — a lower bound` });
        }
        if (scene.magnetopause && scene.magnetopause.kv != null && !narrow) {
            const x = xRe(scene.magnetopause.xRe);
            text(`${num(scene.magnetopause.kv, 1)} kV opening`, x + 8, cy + Math.max(34, 5.6 * ppr), { color: INK.secondary });
        }

        // ── L1 ───────────────────────────────────────────────────────────
        if (scene.l1) {
            const x = xRe(scene.l1.xRe);
            ctx.strokeStyle = INK.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, H - 22); ctx.stroke();
            ctx.fillStyle = INK.primary; ctx.fillRect(x - 3.5, cy - 3.5, 7, 7);
            const right = true;
            text(`L1 · ${scene.l1.label}`, x + (right ? 8 : -8), 32, { color: INK.primary, align: right ? 'left' : 'right', weight: 600 });
            if (!narrow) text(`Bz ${num(scene.l1.bz, 2, { sign: true })} ± ${num(scene.l1.sigma, 2)} nT, measured`, x + (right ? 8 : -8), 47, { align: right ? 'left' : 'right', color: INK.secondary });
        } else text('No L1 measurement — nothing is drawn upstream', X(L.f0) + 12, 32, { color: INK.secondary });

        // ── CME forecast, left of L1: hollow, with its 5–95 % whisker ──────
        if (scene.forecast.length) {
            const full = 0.36 * H, y = (v) => cy - (v / scene.arrowFullNt) * full, fx = (f) => X(L.uOfHoursAhead(f.hoursAhead));
            const band = scene.forecast.filter((f) => f.p5 != null && f.p95 != null);
            if (band.length > 1) {
                ctx.beginPath();
                band.forEach((f, i) => (i ? ctx.lineTo(fx(f), y(f.p95)) : ctx.moveTo(fx(f), y(f.p95))));
                for (let i = band.length - 1; i >= 0; i--) ctx.lineTo(fx(band[i]), y(band[i].p5));
                ctx.closePath(); ctx.fillStyle = 'rgba(195,194,183,0.10)'; ctx.fill();
            }
            // One hollow arrow about every 16 px (the forecast's own grid is finer than the picture); every point stays hoverable.
            const stride = Math.max(1, Math.ceil((scene.forecast.length * 16) / Math.max(1, X(L.f0))));
            scene.forecast.forEach((f, i) => {
                const x = fx(f);
                if (i % stride === 0) arrow(x, f.p50, { hollow: true, width: 1.25 });
                hits.push({ x, y: cy, r: 4, band: true, html: `<b>CME forecast · not measured</b>median Bz ${num(f.p50, 1, { sign: true })} nT<br>5–95 %: ${num(f.p5, 1, { sign: true })} to ${num(f.p95, 1, { sign: true })} nT<br>arrives ${utc(f.arrives)} — in ${num((f.arrives - scene.nowMs) / 3600e3, 1)} h` });
            });
            if (!narrow) text('shaded: 5–95 % of the forecast', 10, 28, { size: 10 });
        }
        text('☉ Sun', 8, H - 30, { size: 10 });
    }

    function frame(now) {
        raf = requestAnimationFrame(frame);
        if (!visible || document.visibilityState === 'hidden') return;
        if (now - lastScene > SCENE_MS) { lastScene = now; rebuild(); }
        if (!motion && lastFrame) return;        // still picture: redrawn only when the scene changes
        if (now - lastFrame < FRAME_MS) return;
        lastFrame = now; draw(now);
    }
    function rebuild() {
        try { scene = sceneFn(Date.now()); } catch (e) { console.info('[bz] scene failed:', e?.message ?? e); return; }
        size(); lastFrame = performance.now(); draw(lastFrame);
        canvas.dataset.parcels = String(scene.parcels.length);
        canvas.dataset.forecast = String(scene.forecast.length);
        canvas.dataset.boundaries = scene.boundaries ? '1' : '0';
    }

    canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
    canvas.addEventListener('pointermove', (ev) => {
        const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
        let best = null, bd = Infinity;
        for (const h of hits) {
            const dx = Math.abs(mx - h.x), d = h.band ? dx : Math.hypot(dx, my - h.y);
            if (d <= h.r && d < bd) { bd = d; best = h; }
        }
        if (!best) { tip.hidden = true; return; }
        tip.innerHTML = best.html; tip.hidden = false;
        tip.style.left = `${Math.max(4, Math.min(mx + 14, W - tip.offsetWidth - 4))}px`;
        tip.style.top = `${Math.max(4, my - tip.offsetHeight - 10)}px`;
    });
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(rebuild, 120); });
    rebuild();
    raf = requestAnimationFrame(frame);
    return { refresh: rebuild, scene: () => scene, destroy: () => cancelAnimationFrame(raf) };
}
