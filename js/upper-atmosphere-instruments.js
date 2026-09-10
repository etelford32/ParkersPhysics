/**
 * upper-atmosphere-instruments.js — analysis instruments ON the canvas
 * ═══════════════════════════════════════════════════════════════════════════
 * A 2-D overlay drawn above the WebGL canvas. Three instruments:
 *
 *   1. ALTITUDE RULER   ticks hung on the actual limb at 100 / 200 / 400 /
 *                       800 / 1200 / 2000 km. The whole render is about
 *                       vertical structure, and before this there was no
 *                       way to read an altitude off it — you could see a
 *                       gradient and not say where 400 km was.
 *
 *   2. LIMB PROBE       point anywhere; it reports what that pixel is
 *                       looking through. Tangent altitude, local ρ and T,
 *                       the COLUMN along that ray, the limb path
 *                       equivalent, and the local drag multiplier
 *                       ρ/ρ_global at that point's latitude and local
 *                       solar time. With a vertical ρ profile beside it,
 *                       tangent altitude marked.
 *
 *   3. DIURNAL COMPASS  where the sub-solar point is, where the density
 *                       bulge actually is (~2 h later), and the day/night
 *                       density ratio at the selected altitude.
 *
 * WHY ON THE CANVAS AND NOT IN THE SIDE PANEL
 * ───────────────────────────────────────────
 * The side panel already reports the global model: one ρ, one T, one Kn,
 * for one altitude. That is the spherically symmetric answer. The whole
 * point of the volumetric render is that the atmosphere is NOT
 * spherically symmetric, and the question an operator has — "what is the
 * density where MY spacecraft is, right now" — is a question about a
 * place. A place is something you point at. So these read out of the same
 * pixel you are looking at, and they move when you orbit.
 *
 * THIS MODULE DOES NOT IMPORT three.js — ON PURPOSE
 * ─────────────────────────────────────────────────
 * It takes two geometry callbacks from the globe (`projectToScreen`,
 * `probeScreenRay`, `limbTicks`) and gets everything else from the pure
 * kernel. So every number it prints traces to `upper-atmosphere-column.js`
 * and is covered by `tests/upper-atmosphere-column.mjs` — no GPU needed to
 * know the physics is right, and the same discipline that keeps
 * `mars-climate-layer.js` node-testable. Keep it that way: if you find
 * yourself needing a Vector3 in here, add a hook to the globe instead.
 *
 * EVERY NUMBER SAYS WHERE IT CAME FROM
 * ────────────────────────────────────
 * The probe prints `ρ local` and `ρ model` side by side, not one blended
 * figure, because they are different claims: one is the engine's global
 * surrogate and the other is that surrogate evaluated at the local T∞
 * field. The ratio between them is the whole product. A single number
 * would hide which one it is.
 */

import {
    probeProfile, densityFieldAt, rayColumn, limbPathEquivalentKm,
    airglowAt, airglowColumn, diurnalContrast, bulgeLocalSolarTime,
    magneticLatitude, AIRGLOW_LAYERS,
    R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM,
} from './upper-atmosphere-column.js';
import { pointPhysics } from './upper-atmosphere-physics.js';
import { layerForAltitude } from './upper-atmosphere-layers.js';

const RULER_ALTS = [100, 200, 400, 800, 1200, 2000];

const CSS = {
    ink:      '#dbe7f5',
    dim:      'rgba(190,210,235,.62)',
    faint:    'rgba(150,180,215,.30)',
    accent:   '#4fd8ff',
    warn:     '#ffb057',
    good:     '#5ff2b8',
    panelBg:  'rgba(7,11,26,.88)',
    panelEdge:'rgba(90,190,235,.30)',
};

function fmtRho(v) {
    if (!Number.isFinite(v) || v <= 0) return '—';
    return v.toExponential(2).replace('e', 'e');
}
function fmtKm(v) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1000 ? `${(v / 1000).toFixed(2)}×10³ km` : `${Math.round(v)} km`;
}

export class AtmosphereInstruments {
    /**
     * @param {HTMLElement} host   positioned container holding the canvas
     * @param {object} deps
     * @param {object} deps.globe  AtmosphereGlobe (geometry hooks only)
     * @param {Function} deps.getState  () => ({ f107, ap, altitudeKm, sunDeclDeg })
     */
    constructor(host, { globe, getState }) {
        this._host = host;
        this._globe = globe;
        this._getState = getState;
        this._disposed = false;
        this._enabled = true;
        this._probeOn = true;
        this._pointer = null;      // {x, y} in CSS px, or null
        this._probe = null;        // cached probe result
        this._lastProbeKey = '';
        // Screen bearing for the altitude ruler, measured from the disc
        // centre in canvas coordinates (+x right, +y DOWN). 200° is
        // left-and-slightly-up: the camera HUD owns the top-right of this
        // canvas, the legend the bottom-left and the time strip the bottom,
        // which leaves the left flank.
        this._rulerBearingRad = 200 * Math.PI / 180;
        // Region the probe card must not cover: the camera HUD.
        this._avoid = { x: 0, y: 0, w: 0, h: 0 };

        const c = document.createElement('canvas');
        c.className = 'ua-instruments';
        // pointer-events NONE is load-bearing: the globe's own OrbitControls
        // and its raycaster both listen on the WebGL canvas underneath, and
        // an overlay that swallowed pointer events would kill orbiting.
        c.style.cssText = `
            position:absolute; inset:0; width:100%; height:100%;
            pointer-events:none; z-index:6;
        `;
        host.appendChild(c);
        this._canvas = c;
        this._ctx = c.getContext('2d');

        this._onMove = (e) => {
            const r = c.getBoundingClientRect();
            this._pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
        };
        this._onLeave = () => { this._pointer = null; this._probe = null; };
        // Listen on the HOST, not on the overlay (which is inert) and not
        // on the WebGL canvas (whose listeners we must not perturb).
        host.addEventListener('pointermove', this._onMove);
        host.addEventListener('pointerleave', this._onLeave);

        this._resize();
        this._resizeObs = new ResizeObserver(() => this._resize());
        this._resizeObs.observe(host);
    }

    setEnabled(on) {
        this._enabled = !!on;
        this._canvas.style.display = on ? '' : 'none';
    }
    getEnabled() { return this._enabled; }
    setProbeEnabled(on) { this._probeOn = !!on; if (!on) this._probe = null; }
    getProbeEnabled() { return this._probeOn; }

    /** Last probe result — exposed so tests and the UI can read it. */
    getProbe() { return this._probe; }

    _resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = this._host.clientWidth, h = this._host.clientHeight;
        if (!w || !h) return;
        this._canvas.width  = Math.round(w * dpr);
        this._canvas.height = Math.round(h * dpr);
        this._dpr = dpr;
        this._w = w; this._h = h;
    }

    /**
     * Redraw. Called from the globe's animation loop; the expensive part
     * (the probe's profile + column integrals) is recomputed only when the
     * pointer or the state actually moves, not every frame.
     */
    draw() {
        if (this._disposed || !this._enabled) return;
        const ctx = this._ctx;
        if (!ctx || !this._w) return;
        ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        ctx.clearRect(0, 0, this._w, this._h);

        const state = this._getState?.() ?? {};
        this._drawRuler(ctx);
        this._drawCompass(ctx, state);
        if (this._probeOn && this._pointer) this._drawProbe(ctx, state);
    }

    // ── 1. altitude ruler ────────────────────────────────────────────────
    // Hung along one screen bearing rather than scattered around the limb,
    // so it reads as a single ruler. Screen-left by default: the camera HUD
    // owns the top-right of this canvas and the time strip owns the bottom.
    _drawRuler(ctx) {
        const geo = this._globe.limbTicks?.(RULER_ALTS);
        if (!geo?.centre || !geo.ticks?.length) return;
        const { centre, ticks, surfaceRadius } = geo;

        const brg = this._rulerBearingRad;
        const ux = Math.cos(brg), uy = Math.sin(brg);
        const at = (r) => ({ x: centre.x + ux * r, y: centre.y + uy * r });

        ctx.save();
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = ux < -0.2 ? 'right' : 'left';

        // Spine from the surface out to the top of the modelled band.
        const outer = ticks[ticks.length - 1];
        if (Number.isFinite(surfaceRadius) && outer) {
            const a = at(surfaceRadius), b = at(outer.screenRadius);
            const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
            grad.addColorStop(0, 'rgba(120,200,255,.55)');
            grad.addColorStop(1, 'rgba(120,200,255,.06)');
            ctx.strokeStyle = grad;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }

        // The bottom of the band is compressed: 100, 200 and 400 km all sit
        // within 400 km of a 6371 km sphere, so at whole-globe framing
        // their ticks land a few pixels apart and the labels overprint.
        // The TICKS stay where the physics puts them — moving those would
        // make the ruler lie — and only the LABELS are pushed outward to a
        // minimum separation, each joined to its own tick by a leader.
        // Gap is MEASURED, not assumed: a fixed 13 px was narrower than the
        // four-digit labels it was separating, so "1200" and "2000" still
        // overprinted at whole-globe framing.
        let labelAt = -Infinity;
        for (const t of ticks) {
            const p = at(t.screenRadius);
            if (p.x < -60 || p.x > this._w + 60 || p.y < -20 || p.y > this._h + 20) continue;
            const layer = layerForAltitude(t.altKm);
            const col = layer
                ? `#${layer.colorHigh.toString(16).padStart(6, '0')}`
                : CSS.accent;
            // Tick perpendicular to the spine, at the true radius.
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.75;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x + uy * 4, p.y - ux * 4);
            ctx.lineTo(p.x - uy * 4, p.y + ux * 4);
            ctx.stroke();

            const label = t.altKm === ticks[ticks.length - 1].altKm
                ? `${t.altKm} km` : String(t.altKm);
            const gap = ctx.measureText(label).width + 7;
            const lr = Math.max(t.screenRadius, labelAt + gap);
            labelAt = lr;
            const lp = at(lr);
            if (lr - t.screenRadius > 1.5) {
                ctx.globalAlpha = 0.35;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y); ctx.lineTo(lp.x, lp.y); ctx.stroke();
            }
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = col;
            ctx.fillText(label, lp.x + ux * 8, lp.y + uy * 8);
        }
        ctx.restore();
    }

    // ── 2. limb probe ────────────────────────────────────────────────────
    _computeProbe(state) {
        const { f107 = 150, ap = 15, sunDeclDeg = 0 } = state;
        const p = this._pointer;
        const nx = (p.x / this._w) * 2 - 1;
        const ny = -((p.y / this._h) * 2 - 1);
        const ray = this._globe.probeScreenRay?.(nx, ny);
        if (!ray) return null;

        // Quantise the cache key so a 1-px jitter does not re-integrate the
        // whole column 60 times a second. 2 km of tangent altitude is far
        // finer than the readout's own precision.
        const key = [
            Math.round(ray.tangentAltKm / 2), Math.round(ray.latDeg),
            Math.round(ray.lstHr * 4), Math.round(f107), Math.round(ap),
            ray.hitsPlanet ? 1 : 0,
        ].join('|');
        if (key === this._lastProbeKey && this._probe) return this._probe;
        this._lastProbeKey = key;

        // A view ray can pass clean over the top of the modelled band. The
        // engine has nothing to say up there and does not extrapolate, so
        // the sample is clamped to the ceiling — and the card MUST then say
        // that the numbers are ceiling values rather than printing them
        // beside a tangent altitude of, say, 3472 km as though they
        // described it. Caught by the browser gate.
        const aboveModel = ray.tangentAltKm > MODEL_CEIL_KM;
        const sampleAlt = Math.min(MODEL_CEIL_KM,
            Math.max(MODEL_FLOOR_KM, ray.tangentAltKm));
        const field = densityFieldAt({
            altKm: sampleAlt, latDeg: ray.latDeg, lonDeg: 0,
            localSolarTimeHr: ray.lstHr, sunDeclDeg, f107Sfu: f107, ap,
        });
        const phys = pointPhysics({
            altitudeKm: sampleAlt, f107Sfu: f107, ap,
        });
        const col = rayColumn({
            tangentAltKm: sampleAlt, f107Sfu: f107, ap, TinfK: field.Tinf,
        });
        const glow = airglowColumn({ tangentAltKm: sampleAlt, f107Sfu: f107, ap });

        this._probe = {
            ...ray,
            sampleAlt, aboveModel,
            rho: field.rho, rhoGlobal: field.rhoGlobal, rhoRatio: field.rhoRatio,
            T: field.T, Tinf: field.Tinf, TinfGlobal: field.TinfGlobal,
            diurnal: field.diurnal, auroralK: field.auroralK,
            magLatDeg: field.magLatDeg,
            knudsen: phys.knudsen, regime: phys.regime, mfp_km: phys.mfp_km,
            dominant: phys.dominant, H_km: field.H_km,
            columnKgM2: col.columnKgM2,
            pathEquivKm: limbPathEquivalentKm(sampleAlt, {
                f107Sfu: f107, ap, TinfK: field.Tinf,
            }),
            airglow: glow.brightness,
            layer: layerForAltitude(sampleAlt),
            profile: probeProfile({ f107Sfu: f107, ap, n: 64, TinfK: field.Tinf }),
        };
        return this._probe;
    }

    _drawProbe(ctx, state) {
        const pr = this._computeProbe(state);
        if (!pr) return;
        const p = this._pointer;

        // Reticle at the cursor, on the ray's closest-approach point.
        const scr = this._globe.projectToScreen?.(pr.point.x, pr.point.y, pr.point.z);
        ctx.save();
        ctx.strokeStyle = pr.hitsPlanet ? CSS.warn : CSS.accent;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1;
        if (scr && !scr.behind) {
            ctx.beginPath();
            ctx.arc(scr.x, scr.y, 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(scr.x, scr.y);
            ctx.stroke();
        }
        ctx.restore();

        // Card placement. Two constraints: stay on the canvas, and stay off
        // the camera HUD. The overlay is pointer-events:none so a card over
        // the HUD does not BLOCK anything — it just hides live controls
        // behind an opaque panel, which reads as a bug. Candidates are
        // tried in preference order and the first clean one wins; if the
        // pointer is somewhere that leaves nowhere clean, the least-
        // overlapping candidate is used rather than none.
        // Taller when a disclosure note is showing.
        const W = 232;
        const H = 202 + ((pr.aboveModel || pr.sampleAlt <= 120) ? 12 : 0);
        const avoid = this._avoidRects();
        // Park below whichever chrome sits highest on the canvas.
        const hud = avoid[0] ?? { x: 0, y: 0, w: 0, h: 0 };
        const cands = [
            [p.x + 18, p.y - H / 2],
            [p.x - 18 - W, p.y - H / 2],
            [p.x + 18, p.y + 18],
            [p.x - 18 - W, p.y + 18],
            [p.x + 18, p.y - H - 18],
            [p.x - 18 - W, p.y - H - 18],
            // Parking spots. The camera HUD's time-warp row spans nearly
            // the full width of this canvas, so when the pointer is up
            // there NO near-cursor placement is clean and the card would
            // otherwise sit on top of live controls. Park it clear and let
            // the leader line carry the association instead.
            [16, hud.y + hud.h + 14],
            [this._w - W - 16, hud.y + hud.h + 14],
            [16, this._h - H - 16],
        ];
        let best = null, bestCost = Infinity;
        for (const [rx0, ry0] of cands) {
            const rx = Math.max(8, Math.min(this._w - W - 8, rx0));
            const ry = Math.max(8, Math.min(this._h - H - 8, ry0));
            let cost = 0;
            for (const a of avoid) cost += _overlapArea(rx, ry, W, H, a);
            if (cost < bestCost) { bestCost = cost; best = [rx, ry]; }
            if (cost === 0) break;
        }
        const [cx, cy] = best;

        ctx.save();
        // When the card had to park far from the cursor, join the two so
        // it still reads as "this card describes that point".
        const far = Math.hypot(cx + W / 2 - p.x, cy + H / 2 - p.y) > W;
        if (far) {
            ctx.strokeStyle = CSS.panelEdge;
            ctx.globalAlpha = 0.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(Math.max(cx, Math.min(cx + W, p.x)),
                       Math.max(cy, Math.min(cy + H, p.y)));
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }
        ctx.fillStyle = CSS.panelBg;
        ctx.strokeStyle = CSS.panelEdge;
        ctx.lineWidth = 1;
        _roundRect(ctx, cx, cy, W, H, 7);
        ctx.fill(); ctx.stroke();

        const pad = 10;
        let y = cy + pad + 4;
        ctx.textBaseline = 'top';

        // Header
        ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = pr.aboveModel ? CSS.dim
                      : pr.hitsPlanet ? CSS.warn : CSS.accent;
        ctx.textAlign = 'left';
        ctx.fillText(pr.aboveModel ? 'ABOVE THE MODEL'
                   : pr.hitsPlanet ? 'THROUGH THE DISC' : 'LIMB RAY',
                     cx + pad, y);
        ctx.textAlign = 'right';
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = CSS.dim;
        ctx.fillText(pr.aboveModel ? 'ceiling values' : (pr.layer?.name ?? '—'),
                     cx + W - pad, y + 1);
        y += 16;

        ctx.textAlign = 'left';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

        const row = (k, v, colour = CSS.ink, note = null) => {
            ctx.fillStyle = CSS.dim;
            ctx.textAlign = 'left';
            ctx.fillText(k, cx + pad, y);
            ctx.fillStyle = colour;
            ctx.textAlign = 'right';
            ctx.fillText(v, cx + W - pad, y);
            y += 13;
            if (note) {
                ctx.save();
                ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.fillStyle = CSS.warn;
                ctx.textAlign = 'left';
                ctx.fillText(note, cx + pad, y);
                ctx.restore();
                y += 11;
            }
        };

        if (pr.hitsPlanet) {
            row('surface point', `${pr.latDeg.toFixed(1)}° · ${pr.lstHr.toFixed(1)} h LST`);
        } else {
            row('tangent alt', fmtKm(pr.tangentAltKm),
                pr.aboveModel ? CSS.dim : CSS.ink,
                pr.aboveModel
                    ? `above the modelled band — rows below are at ${MODEL_CEIL_KM} km`
                    : null);
            row('at', `${pr.latDeg.toFixed(1)}° · ${pr.lstHr.toFixed(1)} h LST`);
        }
        // ρ local vs ρ model kept as TWO rows on purpose — see the header.
        row('ρ local', `${fmtRho(pr.rho)} kg/m³`);
        row('ρ model', `${fmtRho(pr.rhoGlobal)} kg/m³`, CSS.dim);
        const rr = pr.rhoRatio;
        // Below the homopause the engine's density does not depend on T∞ at
        // all (turbulent mixing clamps it), so this ratio is exactly 1.00
        // down there — which reads as a dead instrument unless it says why.
        row('local / model',
            `${rr.toFixed(2)}×`,
            rr > 1.08 ? CSS.warn : rr < 0.92 ? CSS.accent : CSS.good,
            pr.sampleAlt <= 120 ? 'below 120 km the model is T∞-independent' : null);
        row('T · T∞', `${Math.round(pr.T)} · ${Math.round(pr.Tinf)} K`);
        // A ray grazing the ceiling has no modelled atmosphere left to
        // integrate, so these are structurally zero — printing "0.00e+0
        // kg/m²" would read as a broken instrument rather than as the
        // edge of the model. The header already says ABOVE THE MODEL.
        if (!pr.hitsPlanet && !pr.aboveModel) {
            row('column ∫ρ dl', `${fmtRho(pr.columnKgM2)} kg/m²`);
            row('limb path', `≈ ${Math.round(pr.pathEquivKm)} km of local air`);
        }
        row('Kn · regime', `${pr.knudsen < 0.01 ? pr.knudsen.toExponential(1)
                              : pr.knudsen.toFixed(2)} · ${pr.regime}`);

        // Mini profile: log ρ against log altitude, tangent altitude marked.
        const gx = cx + pad, gw = W - pad * 2;
        const gy = cy + H - 46, gh = 34;
        this._drawMiniProfile(ctx, pr, gx, gy, gw, gh);
        ctx.restore();
    }

    _drawMiniProfile(ctx, pr, gx, gy, gw, gh) {
        const prof = pr.profile;
        if (!prof?.length) return;
        const logs = prof.map(s => Math.log10(Math.max(s.rho, 1e-30)));
        const lo = Math.min(...logs), hi = Math.max(...logs);
        const span = Math.max(hi - lo, 1e-6);
        const l0 = Math.log(MODEL_FLOOR_KM), l1 = Math.log(MODEL_CEIL_KM);

        ctx.save();
        ctx.strokeStyle = CSS.faint;
        ctx.lineWidth = 1;
        ctx.strokeRect(gx + 0.5, gy + 0.5, gw, gh);

        // ρ(z) trace — x is log altitude, y is log density.
        ctx.beginPath();
        prof.forEach((s, i) => {
            const x = gx + gw * ((Math.log(s.altKm) - l0) / (l1 - l0));
            const yy = gy + gh * (1 - (logs[i] - lo) / span);
            i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
        });
        ctx.strokeStyle = CSS.accent;
        ctx.globalAlpha = 0.95;
        ctx.stroke();

        // Airglow band, so the emitting layer is visible in the profile too.
        const gmax = Math.max(...prof.map(s => s.airglow), 1e-9);
        ctx.beginPath();
        prof.forEach((s, i) => {
            const x = gx + gw * ((Math.log(s.altKm) - l0) / (l1 - l0));
            const yy = gy + gh * (1 - s.airglow / gmax);
            i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
        });
        ctx.strokeStyle = 'rgba(110,240,150,.75)';
        ctx.globalAlpha = 0.8;
        ctx.stroke();

        // Where this ray is looking.
        const mx = gx + gw * ((Math.log(Math.max(pr.sampleAlt, MODEL_FLOOR_KM)) - l0) / (l1 - l0));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(mx, gy); ctx.lineTo(mx, gy + gh);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = CSS.faint;
        ctx.textAlign = 'left';  ctx.fillText('80', gx, gy + gh + 2);
        ctx.textAlign = 'right'; ctx.fillText('2000 km', gx + gw, gy + gh + 2);
        ctx.restore();
    }

    /**
     * Bounding boxes of the page chrome sitting over this canvas, in canvas
     * coordinates. Measured from the live elements rather than hard-coded:
     * the camera HUD grows and shrinks as its follow / warp rows appear,
     * and the legend is collapsible, so any constant here would be wrong
     * half the time. Missing elements are skipped, so this module still
     * works on a page that does not have them.
     */
    _avoidRects() {
        const sel = ['#ua-camera-hud', '#ua-globe-legend', '#ua-atmo-controls',
                     '#ua-time-scrubber-host'];
        const hb = this._host.getBoundingClientRect();
        const out = [];
        for (const q of sel) {
            const el = this._host.querySelector(q);
            if (!el || !el.offsetParent) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            out.push({ x: r.left - hb.left, y: r.top - hb.top, w: r.width, h: r.height });
        }
        return out;
    }

    // ── 3. diurnal compass ───────────────────────────────────────────────
    _drawCompass(ctx, state) {
        const { f107 = 150, ap = 15, altitudeKm = 400, sunDeclDeg = 0 } = state;
        const key = `${Math.round(f107)}|${Math.round(ap)}|${Math.round(altitudeKm)}|${Math.round(sunDeclDeg)}`;
        if (key !== this._compassKey) {
            this._compassKey = key;
            this._compass = diurnalContrast({
                altKm: Math.min(MODEL_CEIL_KM, Math.max(MODEL_FLOOR_KM, altitudeKm)),
                latDeg: 0, sunDeclDeg, f107Sfu: f107, ap,
            });
        }
        const c = this._compass;
        if (!c) return;

        const R = 27;
        const cx = this._w - R - 22, cy = this._h - R - 26;

        ctx.save();
        ctx.translate(cx, cy);

        // Dial: local solar time, midnight at the bottom, noon at the top.
        ctx.strokeStyle = CSS.faint;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

        const ang = (lst) => (lst / 24) * Math.PI * 2 + Math.PI;  // 0 h at bottom
        const mark = (lst, colour, len, width) => {
            const a = ang(lst);
            ctx.strokeStyle = colour;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(Math.sin(a) * (R - len), -Math.cos(a) * (R - len));
            ctx.lineTo(Math.sin(a) * R, -Math.cos(a) * R);
            ctx.stroke();
        };
        // Sub-solar meridian (local noon) and the density bulge, which lags.
        mark(12, 'rgba(255,220,120,.95)', R, 2);
        mark(c.lstMax, CSS.warn, R, 3);
        mark(c.lstMin, CSS.accent, R * 0.7, 2);

        ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = CSS.ink;
        ctx.fillText(`${c.ratio.toFixed(1)}×`, 0, -2);
        ctx.fillStyle = CSS.faint;
        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText('day/night', 0, 8);

        ctx.textBaseline = 'top';
        ctx.fillStyle = CSS.dim;
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`bulge ${c.lstMax.toFixed(1)} h LST`, 0, R + 5);
        ctx.restore();
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._resizeObs?.disconnect();
        this._host.removeEventListener('pointermove', this._onMove);
        this._host.removeEventListener('pointerleave', this._onLeave);
        this._canvas.remove();
    }
}

function _overlapArea(x, y, w, h, r) {
    if (!r || r.w <= 0 || r.h <= 0) return 0;
    const ox = Math.max(0, Math.min(x + w, r.x + r.w) - Math.max(x, r.x));
    const oy = Math.max(0, Math.min(y + h, r.y + r.h) - Math.max(y, r.y));
    return ox * oy;
}

function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/**
 * Legend copy for the volume render. Kept here so the page's legend and
 * the renderer cannot drift apart, and so the DISPLAY TRANSFORM is stated
 * wherever the render is shown. `scale` is AtmosphereVolume.getScaleInfo().
 */
export function volumeLegend(scale) {
    const d = scale?.decades ?? 10, g = scale?.gamma ?? 1.15;
    return {
        title: 'atmosphere · continuous column',
        lines: [
            ['density', 'brightness ∝ ∫ρ dl along the view ray · colour = composition '
                      + 'at the ray\'s lowest point'],
            ['scale', `log₁₀ over ${d} decades, γ=${g.toFixed(2)} — a display `
                    + `transform, not the physics`],
            ['airglow', 'real emission layers at observed altitudes: '
                      + 'OH 87 · Na 92 · O₂ 94 · O(¹S) green 97 · O(¹D) red 250 km'],
            ['not visible', 'the density render is DATA — above 80 km the neutral '
                          + 'atmosphere emits no visible light. The airglow is what '
                          + 'an eye would see.'],
            ['field', 'Jacchia-71 diurnal bulge (peaks ~14 h LST) + auroral Joule '
                    + 'heating, both area-mean-preserving'],
        ],
    };
}

export { RULER_ALTS, AIRGLOW_LAYERS };
